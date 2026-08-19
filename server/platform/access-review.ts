import "server-only";

/**
 * Ordence — ⭐⭐ THE MONTHLY ACCESS REVIEW, SERVER HALF
 * Version: v1.52.0-alpha (Batch 130)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE OWES THE AUDITOR
 * ══════════════════════════════════════════════════════════════════════
 * Three things, and only the third is new work:
 *
 *   ① READ every standing grant and every impersonation in a period.
 *   ② REVOKE a selection of them, all or nothing.
 *   ③ RECORD that a named human looked at a row on a given date.
 *
 * ① and ② both already exist for one row at a time — `staff.ts` and
 * `action-log.ts` — and this module deliberately reuses their predicates
 * (`usableOwnersExcluding`) rather than restating them. A second copy of
 * the owner floor is a second copy that drifts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RULE THAT GOVERNS THE WHOLE FILE
 * ══════════════════════════════════════════════════════════════════════
 * Item ids arrive from the BROWSER'S QUERY STRING (`?ar_sel=…`, written
 * by `<DataTable>`'s URL state). They are a convenience for the operator
 * and NOTHING ELSE: not a permission, not a proof the rows exist, not a
 * proof they are in a state this action may touch. Every id is re-parsed,
 * re-fetched by id from its own table, and re-authorised inside the
 * transaction before anything is written. See `bulkRevokeAccess()`.
 */

import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import {
  platformActionLog,
  platformImpersonationSessions,
  platformStaff,
} from "@/db/schema/platform";
import { getServerEnv } from "@/lib/env";
import {
  GRADE_LABELS,
  isAllowlisted,
  parseAdminAllowlist,
} from "@/lib/platform/roles";
import type { PlatformResult } from "@/lib/platform/schemas";
import { cappedExpiry, isSessionLive } from "@/lib/platform/impersonation-policy";
import {
  ACCESS_REVIEW_KIND_LABELS,
  ACCESS_REVIEW_RESOURCE,
  EVERY_WORKSPACE,
  accessReviewItemId,
  countFindings,
  countUnreviewed,
  latestReviewByItem,
  parseAccessReviewItemId,
  resolveReviewPeriod,
  sortForReview,
  type AccessReviewRow,
  type ReviewMark,
} from "@/lib/platform/access-review";
import { requireCapability, recordPlatformAudit } from "./guard";
import { LAST_OWNER_REFUSAL, usableOwnersExcluding } from "./staff";

/**
 * ⚠️ A CEILING, NOT A PAGE SIZE. A calendar month of a healthy platform
 * is tens of rows; this exists so a pathological month cannot try to
 * render ten thousand. When it bites, the page says so in words rather
 * than quietly showing a prefix of the truth — a truncated access review
 * that looks complete is worse than no access review.
 */
const MAX_ITEMS_PER_KIND = 500;

/** The most ids one bulk revoke will consider. See `bulkRevokeAccess()`. */
const MAX_BULK_IDS = 200;

/* ------------------------------------------------------------------ */
/* ① READ                                                              */
/* ------------------------------------------------------------------ */

export type AccessReviewPage = {
  periodKey: string;
  periodLabel: string;
  rows: AccessReviewRow[];
  findingCount: number;
  unreviewedCount: number;
  activeCount: number;
  /** True when either half hit `MAX_ITEMS_PER_KIND`. Said out loud in the UI. */
  truncated: boolean;
};

const listSchema = z.object({
  /** `YYYY-MM`. Anything else falls back to the previous calendar month. */
  month: z.string().trim().max(10).optional(),
});

/**
 * Everything that held access in one calendar month.
 *
 * ⚠️ `staff:read` AND NOT `staff:manage`. Reading who had access is the
 * whole point of a review, and gating the read to the one grade that can
 * revoke would mean the monthly pass can only be done by an owner — which
 * is how a monthly pass becomes a quarterly one. The REVOKE below is
 * gated far harder.
 */
export async function listAccessReview(
  input: unknown,
): Promise<PlatformResult<AccessReviewPage>> {
  await requireCapability("staff:read");

  const parsed = listSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: "Invalid period." };

  const now = new Date();
  const period = resolveReviewPeriod(parsed.data.month ?? null, now);
  const allowlist = parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS);

  const data = await withPlatformScope(
    `Platform console: monthly access review — every standing grant and impersonation in ${period.label}`,
    async (db) => {
      /* ---- STANDING GRANTS ------------------------------------------
       *
       * ⭐ NOT "GRANTED DURING THE MONTH". A grant handed out three years
       * ago and never revoked is the single most important row on an
       * access review, and a `granted_at BETWEEN` window would hide
       * exactly that row while showing the harmless new ones. The
       * question is "what STOOD during this month", so a grant qualifies
       * if it existed before the window closed and had not been revoked
       * before the window opened.
       */
      const grants = await db
        .select()
        .from(platformStaff)
        .where(
          and(
            lt(platformStaff.grantedAt, period.to),
            or(
              isNull(platformStaff.revokedAt),
              gte(platformStaff.revokedAt, period.from),
            ),
          ),
        )
        .orderBy(desc(platformStaff.grantedAt))
        .limit(MAX_ITEMS_PER_KIND);

      /* ---- IMPERSONATIONS -------------------------------------------
       *
       * A session is capped at thirty minutes, so "started in the month"
       * and "happened in the month" are the same question here — unlike
       * the grants above.
       */
      const sessions = await db
        .select({
          session: platformImpersonationSessions,
          tenantName: tenants.name,
          staffGrade: platformStaff.grade,
        })
        .from(platformImpersonationSessions)
        .leftJoin(tenants, eq(tenants.id, platformImpersonationSessions.tenantId))
        .leftJoin(platformStaff, eq(platformStaff.id, platformImpersonationSessions.staffId))
        .where(
          and(
            gte(platformImpersonationSessions.startedAt, period.from),
            lt(platformImpersonationSessions.startedAt, period.to),
          ),
        )
        .orderBy(desc(platformImpersonationSessions.startedAt))
        .limit(MAX_ITEMS_PER_KIND);

      const itemIds = [
        ...grants.map((g) => accessReviewItemId("grant", g.id)),
        ...sessions.map((s) => accessReviewItemId("session", s.session.id)),
      ];

      /* ---- ⚠️ "REVIEWED" IS READ BACK OUT OF THE ACTION REGISTER ----
       *
       * There is no `access_review` table and this batch may not create
       * one, so the mark lives in `platform_action_log` under its own
       * `resource_type` and the state is DERIVED here. The costs are
       * listed in full on `ACCESS_REVIEW_RESOURCE`; the two that show up
       * in this query are that there is no unique constraint (so a
       * double-review is two rows) and no index to sort on (so the fold
       * picking the latest happens in `latestReviewByItem()`, in memory).
       *
       * ⚠️ NO TIME WINDOW ON THIS READ. A review of June's grants can be
       * recorded in August; filtering the marks by the period would drop
       * every late sign-off and quietly report reviewed rows as unreviewed.
       */
      const marks =
        itemIds.length === 0
          ? []
          : await db
              .select({
                resourceId: platformActionLog.resourceId,
                actorEmail: platformActionLog.actorEmail,
                createdAt: platformActionLog.createdAt,
              })
              .from(platformActionLog)
              .where(
                and(
                  eq(platformActionLog.resourceType, ACCESS_REVIEW_RESOURCE),
                  inArray(platformActionLog.resourceId, itemIds),
                ),
              )
              .orderBy(desc(platformActionLog.createdAt), desc(platformActionLog.id))
              .limit(5_000);

      return { grants, sessions, marks };
    },
  );

  const reviews = latestReviewByItem(
    data.marks.flatMap<ReviewMark>((m) =>
      m.resourceId
        ? [
            {
              itemId: m.resourceId,
              reviewedAt: m.createdAt.toISOString(),
              reviewedBy: m.actorEmail,
            },
          ]
        : [],
    ),
  );

  const rows: AccessReviewRow[] = [];

  for (const g of data.grants) {
    const itemId = accessReviewItemId("grant", g.id);
    const onAllowlist = isAllowlisted(g.email, allowlist);
    const expired = Boolean(g.expiresAt && g.expiresAt.getTime() <= now.getTime());
    const active =
      g.status === "active" && g.revokedAt === null && !expired && onAllowlist;
    /**
     * ⚠️ THE STATE IS A WORD, AND "STALE" IS ITS OWN WORD. A grant that
     * is `active` in the table but whose address has dropped off
     * `PLATFORM_ADMIN_EMAILS` cannot sign in — and is still a grant
     * nobody cleaned up, which is precisely what a review is for. Calling
     * it "Active" would overstate it; calling it "Revoked" would hide it.
     */
    const stateWord = g.revokedAt
      ? "Revoked"
      : expired
        ? "Expired"
        : !onAllowlist
          ? "Stale — grant held, not on the allowlist"
          : "Active";
    const endsAt = g.revokedAt ?? g.expiresAt ?? null;
    const review = reviews.get(itemId);
    rows.push({
      itemId,
      kind: "grant",
      kindLabel: ACCESS_REVIEW_KIND_LABELS.grant,
      who: g.email,
      whoGrade: GRADE_LABELS[g.grade] ?? g.grade,
      workspace: EVERY_WORKSPACE,
      workspaceId: null,
      startedAt: g.grantedAt.toISOString(),
      endsAt: endsAt ? endsAt.toISOString() : null,
      minutes: endsAt
        ? Math.max(0, (endsAt.getTime() - g.grantedAt.getTime()) / 60_000)
        : null,
      reason: g.grantReason,
      active,
      stateWord,
      reviewedAt: review?.reviewedAt ?? null,
      reviewedBy: review?.reviewedBy ?? null,
    });
  }

  for (const { session: s, tenantName, staffGrade } of data.sessions) {
    const itemId = accessReviewItemId("session", s.id);
    // ⚠️ THE CAPPED end, and liveness from the CLOCK — never from
    // `ended_at`, which only says whether the sweeper has been round.
    const ends = cappedExpiry({ startedAt: s.startedAt, expiresAt: s.expiresAt, endedAt: s.endedAt });
    const effectiveEnd = s.endedAt && s.endedAt < ends ? s.endedAt : ends;
    const live = isSessionLive(
      { startedAt: s.startedAt, expiresAt: s.expiresAt, endedAt: s.endedAt },
      now,
    );
    const review = reviews.get(itemId);
    rows.push({
      itemId,
      kind: "session",
      kindLabel: ACCESS_REVIEW_KIND_LABELS.session,
      who: s.actorEmail,
      whoGrade: staffGrade ? (GRADE_LABELS[staffGrade] ?? staffGrade) : "Grant since removed",
      workspace: tenantName ?? s.tenantSlug,
      workspaceId: s.tenantId,
      startedAt: s.startedAt.toISOString(),
      endsAt: effectiveEnd.toISOString(),
      minutes: Math.max(0, (effectiveEnd.getTime() - s.startedAt.getTime()) / 60_000),
      reason: s.justification,
      active: live,
      stateWord: live ? "Live now — inside this workspace" : "Ended",
      reviewedAt: review?.reviewedAt ?? null,
      reviewedBy: review?.reviewedBy ?? null,
    });
  }

  const sorted = sortForReview(rows);

  return {
    ok: true,
    data: {
      periodKey: period.key,
      periodLabel: period.label,
      rows: sorted,
      findingCount: countFindings(sorted),
      unreviewedCount: countUnreviewed(sorted),
      activeCount: sorted.filter((r) => r.active).length,
      truncated:
        data.grants.length >= MAX_ITEMS_PER_KIND ||
        data.sessions.length >= MAX_ITEMS_PER_KIND,
    },
  };
}

/* ------------------------------------------------------------------ */
/* ② BULK REVOKE — ONE TRANSACTION, ALL OR NOTHING                     */
/* ------------------------------------------------------------------ */

const bulkSchema = z.object({
  itemIds: z.array(z.string().trim().max(80)).min(1).max(MAX_BULK_IDS),
  reason: z.string().trim().min(20).max(2000),
});

export type BulkRevokeOutcome = {
  revokedGrants: number;
  revokedSessions: number;
  reviewedPeriodLabel: string | null;
};

/**
 * A `throw` inside `withPlatformScope()` rolls the transaction back. This
 * error type carries the operator-facing sentence out through it.
 */
class BulkRefusal extends Error {}

/**
 * ⭐⭐ REVOKE A SELECTION. EITHER ALL OF IT, OR NONE OF IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY ID IS RE-FETCHED AND RE-AUTHORISED SERVER-SIDE
 * ══════════════════════════════════════════════════════════════════════
 * The ids reach this function from `?ar_sel=` in the operator's address
 * bar — `<DataTable>` keeps its selection in the URL so a filtered batch
 * survives a refresh and can be pasted into a ticket. That is a UX
 * feature and it is ALSO a forgery surface: anybody who can reach this
 * action can type any uuid they like into that parameter, including the
 * id of a grant they may not touch or a row they never saw on screen.
 *
 * So nothing about the submitted list is believed:
 *
 *   • the string is re-parsed (`parseAccessReviewItemId`) — a malformed
 *     or unknown-prefix id is a refusal, not a skip;
 *   • the row is re-fetched BY ID from its own table inside this
 *     transaction — the client's claim about which table it lives in is
 *     only a routing hint;
 *   • the row's state is re-checked (a revoked grant, an ended session);
 *   • the owner floor is re-evaluated ACROSS THE WHOLE BATCH.
 *
 * 🔴 AND A SINGLE FAILURE ABORTS EVERYTHING. Not "revoke the twelve that
 * passed and report the one that did not" — that is how an operator ends
 * up believing a batch completed. A partial revoke of an access review is
 * a review that is half-signed, and the reviewer has already moved on.
 */
export async function bulkRevokeAccess(
  input: unknown,
): Promise<PlatformResult<BulkRevokeOutcome>> {
  /**
   * ⚠️ `staff:manage` — owner-only and on the step-up list. It is what
   * `revokePlatformStaff()` and `revokeImpersonationSession()` each
   * demand for ONE row; a screen that ends forty of them at once must not
   * ask for less.
   */
  const operator = await requireCapability("staff:manage");

  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "Select at least one row and write a reason of at least 20 characters. " +
        `A batch is capped at ${MAX_BULK_IDS} rows.`,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { itemIds, reason } = parsed.data;

  /* ---- PARSE, AND REFUSE ANYTHING THAT IS NOT OURS ---------------- */
  const grantIds: string[] = [];
  const sessionIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of itemIds) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const item = parseAccessReviewItemId(raw);
    // 🔴 A REFUSAL, NOT A SKIP. Dropping the ids we cannot understand and
    // proceeding with the rest would mean a forged parameter silently
    // changes which rows a confirmed action touches.
    if (!item) {
      return {
        ok: false,
        error:
          "One of the selected rows is not a row this screen can act on. " +
          "Nothing was revoked. Clear the selection and try again.",
      };
    }
    (item.kind === "grant" ? grantIds : sessionIds).push(item.id);
  }

  let written: {
    grants: { id: string; email: string; grade: string }[];
    sessions: { id: string; tenantId: string; actorEmail: string }[];
  };

  try {
    written = await withPlatformScope(
      `Platform console: access review bulk revoke of ${seen.size} access records — ${reason.slice(0, 80)}`,
      async (db) => {
        const now = new Date();

        /* ---- RE-FETCH THE GRANTS -------------------------------------
         *
         * 🔴 THE SUBMITTED IDS ARE THE `WHERE`, NEVER THE ANSWER. What
         * comes BACK is the authority: an id that does not return a row
         * either never existed or names something outside this screen's
         * reach, and both are a refusal.
         */
        const grants =
          grantIds.length === 0
            ? []
            : await db
                .select()
                .from(platformStaff)
                .where(inArray(platformStaff.id, grantIds));

        if (grants.length !== grantIds.length) {
          throw new BulkRefusal(
            "One of the selected grants no longer exists. Nothing was revoked. " +
              "Reload the review and select again.",
          );
        }
        for (const g of grants) {
          if (g.revokedAt !== null || g.status !== "active") {
            throw new BulkRefusal(
              `${g.email}'s grant has already been revoked. Nothing was revoked. ` +
                "Reload the review and select again.",
            );
          }
        }

        /* ---- 🔴 THE OWNER FLOOR, ACROSS THE WHOLE BATCH -------------
         *
         * Checking each grant with only itself excluded would let two
         * owners be revoked in one batch: each sees the other as the
         * survivor, and the console locks for everybody with recovery
         * only through a hand-written production row. So the exclusion
         * list is the ENTIRE batch. One predicate, shared with
         * `revokePlatformStaff()`.
         */
        if (grants.some((g) => g.grade === "owner")) {
          const remaining = await usableOwnersExcluding(db, grantIds);
          if (remaining.length === 0) throw new BulkRefusal(LAST_OWNER_REFUSAL);
        }

        /* ---- RE-FETCH THE SESSIONS ---------------------------------- */
        const sessions =
          sessionIds.length === 0
            ? []
            : await db
                .select()
                .from(platformImpersonationSessions)
                .where(inArray(platformImpersonationSessions.id, sessionIds));

        if (sessions.length !== sessionIds.length) {
          throw new BulkRefusal(
            "One of the selected sessions no longer exists. Nothing was revoked.",
          );
        }
        for (const s of sessions) {
          // ⚠️ Liveness from the CLOCK. A session whose time ran out is
          // already over; "ending" it would write a misleading
          // `revoked_by_platform` onto a row nobody terminated.
          if (!isSessionLive({ startedAt: s.startedAt, expiresAt: s.expiresAt, endedAt: s.endedAt }, now)) {
            throw new BulkRefusal(
              `${s.actorEmail}'s session in ${s.tenantSlug} has already ended. ` +
                "Nothing was revoked. Reload the review and select again.",
            );
          }
        }

        /* ---- WRITE ---------------------------------------------------
         *
         * Both writes are inside the one transaction `withPlatformScope`
         * opened, so a failure on the last session rolls back the first
         * grant. That is the all-or-nothing promise, and it is the
         * database's promise rather than this function's.
         */
        for (const g of grants) {
          await db
            .update(platformStaff)
            .set({
              status: "revoked",
              revokedAt: now,
              revokeReason: reason,
              revokedBy: operator.staff.id,
              lastStepUpAt: null,
              updatedAt: now,
            })
            .where(eq(platformStaff.id, g.id));
        }

        for (const s of sessions) {
          // The session row is EVIDENCE: the one-way close writes
          // `ended_at` and `ended_reason` and nothing else, and the
          // database trigger refuses anything more.
          await db
            .update(platformImpersonationSessions)
            .set({ endedAt: now, endedReason: "revoked_by_platform" })
            .where(
              and(
                eq(platformImpersonationSessions.id, s.id),
                isNull(platformImpersonationSessions.endedAt),
              ),
            );
        }

        return {
          grants: grants.map((g) => ({ id: g.id, email: g.email, grade: g.grade })),
          sessions: sessions.map((s) => ({
            id: s.id,
            tenantId: s.tenantId,
            actorEmail: s.actorEmail,
          })),
        };
      },
    );
  } catch (err) {
    if (err instanceof BulkRefusal) return { ok: false, error: err.message };
    throw err;
  }

  /**
   * ⚠️ THE AUDIT ROWS ARE WRITTEN AFTER THE COMMIT, ONE PER ITEM.
   * `recordPlatformAudit()` never throws and opens its own scope, so
   * calling it inside the transaction above would nest a connection
   * inside a transaction for no benefit — and a failed audit write must
   * never roll back a revocation that has already taken effect.
   *
   * ⭐ ONE ROW PER ITEM RATHER THAN ONE FOR THE BATCH, because "was
   * Priya's access revoked in July, and why" must be answerable without
   * finding her address inside a JSON array on somebody else's row.
   */
  for (const g of written.grants) {
    await recordPlatformAudit({
      operator,
      tenantId: null,
      action: "config_change",
      resourceType: "platform_staff_revoke",
      resourceId: g.id,
      oldValue: { email: g.email, grade: g.grade, status: "active" },
      newValue: { status: "revoked" },
      severity: "critical",
      reason,
      metadata: {
        revokedFrom: g.email,
        selfRevoke: g.email === operator.email,
        viaAccessReviewBatch: true,
        batchSize: seen.size,
      },
    });
  }
  for (const s of written.sessions) {
    await recordPlatformAudit({
      operator,
      // ⚠️ Tenant-attributed on purpose: everything we do TO a workspace
      // should be something that workspace can see us doing.
      tenantId: s.tenantId,
      action: "impersonate",
      resourceType: "impersonation_session",
      resourceId: s.id,
      impersonationId: s.id,
      severity: "critical",
      reason,
      newValue: { endedReason: "revoked_by_platform" },
      metadata: {
        endedOperator: s.actorEmail,
        endedBy: operator.email,
        viaAccessReviewBatch: true,
      },
    });
  }

  return {
    ok: true,
    data: {
      revokedGrants: written.grants.length,
      revokedSessions: written.sessions.length,
      reviewedPeriodLabel: null,
    },
  };

}

/* ------------------------------------------------------------------ */
/* ③ MARK REVIEWED                                                     */
/* ------------------------------------------------------------------ */

const markSchema = z.object({
  itemIds: z.array(z.string().trim().max(80)).min(1).max(MAX_BULK_IDS),
  periodKey: z.string().trim().max(10).optional(),
  /** Optional — a reviewer with nothing to add should not invent a sentence. */
  note: z.string().trim().max(2000).optional(),
});

/**
 * Record that a named human looked at these rows, on this date.
 *
 * ⚠️ `staff:read`, DELIBERATELY THE SAME AS THE READ. Marking a row
 * reviewed changes no access and grants nothing; it is an ASSERTION, and
 * the assertion is filed with the asserter's email and grade so a later
 * reader can weigh it. Gating it to `staff:manage` would mean only an
 * owner can record having done the monthly pass, which in practice means
 * the pass stops being recorded.
 *
 * ⚠️ THE ROWS ARE NOT RE-FETCHED HERE and that is a considered
 * difference from the revoke: this writes nothing to the grant or the
 * session, only a claim about an id. The ids are still re-parsed, so a
 * junk string cannot enter the register — but an id naming a row that no
 * longer exists produces a harmless orphan mark rather than a refusal.
 */
export async function markAccessReviewed(
  input: unknown,
): Promise<PlatformResult<{ marked: number }>> {
  const operator = await requireCapability("staff:read");

  const parsed = markSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Select at least one row." };
  const { itemIds, periodKey, note } = parsed.data;

  const valid = itemIds
    .map((raw) => ({ raw, item: parseAccessReviewItemId(raw) }))
    .filter((entry): entry is { raw: string; item: NonNullable<typeof entry.item> } =>
      entry.item !== null,
    );

  if (valid.length === 0) {
    return { ok: false, error: "None of the selected rows can be marked reviewed." };
  }

  for (const { raw, item } of valid) {
    /**
     * 🔴 ONE REGISTER ROW PER ITEM, `resource_id` = the item id, so the
     * read above can find it with `WHERE resource_type = … AND
     * resource_id IN (…)`. `tenantId` is NULL EVEN FOR A SESSION: a
     * tenant-attributed audit row is routed into that tenant's own
     * `audit_logs`, where this console cannot read it back, and the
     * derived "reviewed" state would silently lose every session review.
     */
    await recordPlatformAudit({
      operator,
      tenantId: null,
      action: "read",
      resourceType: ACCESS_REVIEW_RESOURCE,
      resourceId: raw,
      severity: "notice",
      reason:
        note && note.length > 0
          ? `Access review sign-off${periodKey ? ` for ${periodKey}` : ""}: ${note}`
          : `Access review sign-off${periodKey ? ` for ${periodKey}` : ""}: this ${item.kind === "grant" ? "standing grant" : "impersonation session"} was examined and accepted.`,
      metadata: {
        accessReview: true,
        itemKind: item.kind,
        itemId: item.id,
        periodKey: periodKey ?? null,
        reviewer: operator.email,
      },
    });
  }

  return { ok: true, data: { marked: valid.length } };
}
