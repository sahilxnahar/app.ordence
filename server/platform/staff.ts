import "server-only";

/**
 * Ordence — Platform Staff Administration
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONLY OPERATION IN THE CONSOLE THAT CREATES ANOTHER OPERATOR
 * ══════════════════════════════════════════════════════════════════════
 * Which makes it the one an attacker who has already got in most wants,
 * because it is the difference between a session and a foothold.
 *
 * Three things constrain it, and the third is the one that matters:
 *
 *   1. `owner` grade only.
 *   2. A fresh step-up (see the honest caveat in `guard.ts`).
 *   3. ⭐ THE TARGET MUST ALREADY BE IN `PLATFORM_ADMIN_EMAILS`.
 *
 * (3) is what makes this form incapable of minting access on its own. It
 * turns KEY 2 for somebody who already holds KEY 1, and KEY 1 cannot be
 * granted from inside the application at all — it needs a reviewed commit
 * and production environment access. So an attacker holding a stolen
 * owner session can promote only people the organisation has already
 * decided to trust, which is a materially smaller prize.
 *
 * REVOCATION IS DELIBERATELY EASIER THAN GRANTING: any `owner`, no
 * allowlist requirement, one statement, effective on the next request.
 * The asymmetry is the design — the cheap operation should be the safe
 * one.
 *
 * ⚠️ NOTHING HERE DELETES. Revocation is a status change, so the record
 * of who held platform access, when, and who granted it survives the
 * revocation. A `DELETE` would let somebody remove the evidence that they
 * were ever staff.
 */

import { and, desc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { users } from "@/db/schema";
import { platformStaff } from "@/db/schema/platform";
import { getServerEnv } from "@/lib/env";
import {
  parseAdminAllowlist,
  isAllowlisted,
  GRADE_LABELS,
  type PlatformGrade,
} from "@/lib/platform/roles";
import {
  grantPlatformStaffSchema,
  revokePlatformStaffSchema,
  type PlatformResult,
} from "@/lib/platform/schemas";
import { requireCapability, recordPlatformAudit } from "./guard";
// 🔴 SIDE EFFECT: registers every approval executor. Without it this
// module could hold a write and then fail to queue it, because
// `queueForApproval` refuses a kind with no executor.
import "./approval-executors";
import {
  approvalGate,
  queueForApproval,
  recordApprovalRefusal,
  type ApprovalTicket,
} from "./approvals";
import { elevatesGrade } from "@/lib/platform/approvals";

export type StaffRow = {
  id: string;
  email: string;
  displayName: string | null;
  grade: string;
  gradeLabel: string;
  status: string;
  grantedByEmail: string | null;
  grantedAt: string;
  expiresAt: string | null;
  expired: boolean;
  /** False when the row exists but the env allowlist no longer names them. */
  allowlisted: boolean;
};

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

/**
 * Everyone who holds — or held — platform access.
 *
 * ⭐ `allowlisted` IS THE COLUMN TO READ. A row that is `active` but no
 * longer in `PLATFORM_ADMIN_EMAILS` cannot sign in (both keys are
 * required), and that is the correct behaviour, but it is also a stale
 * grant nobody cleaned up. Showing it makes the drift between the two
 * keys visible instead of leaving it to be discovered during an audit.
 */
export async function listPlatformStaff(): Promise<PlatformResult<StaffRow[]>> {
  await requireCapability("staff:read");
  const allowlist = parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS);
  const now = new Date();

  const rows = await withPlatformScope(
    "Platform console: list platform staff grants for access review",
    async (db) =>
      db.select().from(platformStaff).orderBy(desc(platformStaff.grantedAt)).limit(200),
  );

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      grade: r.grade,
      gradeLabel: GRADE_LABELS[r.grade],
      status: r.status,
      grantedByEmail: r.grantedByEmail,
      grantedAt: r.grantedAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      expired: Boolean(r.expiresAt && r.expiresAt.getTime() <= now.getTime()),
      allowlisted: isAllowlisted(r.email, allowlist),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* THE DIRECTORY — everything the console screen needs, in one read    */
/* ------------------------------------------------------------------ */

/**
 * One row of `platform_staff`, plus the three judgements the screen would
 * otherwise have to re-derive (and eventually derive differently).
 */
export type StaffDirectoryRow = StaffRow & {
  /** Active, not revoked, not expired. Only these people can sign in today. */
  usable: boolean;
  /** This is the operator reading the page. */
  isSelf: boolean;
  /**
   * ⭐ THE LAST OWNER ROW THAT IS ACTIVE, UNREVOKED AND UNEXPIRED.
   * Rendered as a disabled button and a sentence, so the operator learns
   * the rule from the screen rather than from a red toast.
   */
  lastUsableOwner: boolean;
  /**
   * 🔴 REVOKING THIS ROW WOULD LEAVE NO OWNER WHO CAN ACTUALLY SIGN IN,
   * and `revokePlatformStaff` refuses it — since v1.44.0 that refusal
   * counts the allowlist too, so this is the flag that matches the
   * engine. `lastUsableOwner` stays because it is the weaker fact and the
   * screen states both: a row can be the last usable owner without being
   * the last real one when a stale grant is keeping the count up.
   */
  lastRealOwner: boolean;
};

/**
 * Somebody the console is permitted to grant access to — i.e. somebody
 * who already holds KEY 1.
 *
 * ⚠️ THE FORM OFFERS A LIST RATHER THAN A FREE-TEXT EMAIL BOX ON PURPOSE.
 * `grantPlatformStaff` refuses any email that is not in
 * `PLATFORM_ADMIN_EMAILS`, so a free-text field is a field whose only
 * possible values are already known to the server — and every other value
 * is a round-trip that ends in a refusal the operator has to interpret.
 */
export type GrantCandidate = {
  email: string;
  /**
   * ⭐ THE CLERK ID IS THE REAL IDENTITY AND IT IS THE FIELD MOST LIKELY
   * TO BE WRONG. `platform_staff.clerk_user_id` is the join key; the
   * email beside it is only a label. A mistyped id produces a row that
   * grants KEY 2 to a stranger — harmless on its own, because that
   * stranger's own email is not on the allowlist so KEY 1 still refuses,
   * but it also means the person you meant to grant has nothing, and
   * nobody finds out until they try to sign in during an incident.
   *
   * So the id is looked up rather than typed wherever it is knowable:
   * from a previous grant for the same address, or from a workspace
   * membership under that address. Null means "we have never seen this
   * person" and the operator has to paste it from Clerk.
   */
  knownClerkUserId: string | null;
  clerkIdSource: "previous_grant" | "workspace_membership" | null;
  displayName: string | null;
  /** An active, unexpired grant already exists — this would be a RENEWAL. */
  hasUsableGrant: boolean;
  currentGrade: PlatformGrade | null;
  /** The operator's own address. The engine refuses self-grant and renewal. */
  isSelf: boolean;
};

export type StaffDirectory = {
  rows: StaffDirectoryRow[];
  candidates: GrantCandidate[];
  /**
   * How many owner ROWS are live: active, unrevoked, unexpired, and
   * nothing about the allowlist. Reported because the difference between
   * this and the next number IS the drift — but it is not the number the
   * refusal is made on.
   */
  usableOwners: number;
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE NUMBER THAT ACTUALLY ANSWERS "CAN ANYBODY GET BACK IN?"
   * ══════════════════════════════════════════════════════════════════
   * Platform access needs BOTH keys. An owner row that is `active` but
   * no longer in `PLATFORM_ADMIN_EMAILS` — precisely the stale grant
   * this console paints red in the `On allowlist` column — cannot sign
   * in, so it must not be what keeps a self-revocation permitted.
   *
   * ⚠️ THE ENGINE COUNTS THE SAME WAY SINCE v1.44.0, with the same
   * `isAllowlisted` predicate `guard.ts` admits people with, so a curl
   * request is refused exactly where this screen disables the button.
   * The screen keeps its own number anyway: it is what lets the refusal
   * be a stated sentence before the click rather than a red toast after
   * it, and a mistake guard is not made redundant by the boundary
   * arriving behind it.
   */
  usableAllowlistedOwners: number;
  operator: {
    clerkUserId: string;
    email: string;
    grade: PlatformGrade;
    /** `staff:manage` — owner grade only. Controls are disabled, not hidden. */
    canManage: boolean;
  };
  /** False when `PLATFORM_ADMIN_EMAILS` is empty, i.e. nobody can be granted. */
  allowlistConfigured: boolean;
};

/**
 * The whole staff screen in one read.
 *
 * ⚠️ ONE FUNCTION RATHER THAN FOUR because every part of it is derived
 * from the same two facts — the table and the env allowlist — and a page
 * that fetched them separately would render a list and a candidate set
 * that disagree with each other about who currently holds access.
 *
 * Guarded by `staff:read`, which every grade holds: seeing who can cross
 * a tenant boundary is not a privilege, it is the point of an access
 * review. GRANTING is `staff:manage` and is checked again, inside
 * `grantPlatformStaff`, where it belongs.
 */
export async function getStaffDirectory(): Promise<PlatformResult<StaffDirectory>> {
  const operator = await requireCapability("staff:read");
  const allowlist = parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS);
  const now = new Date();

  const emails = [...allowlist];

  const { staffRows, workspaceIdentities } = await withPlatformScope(
    "Platform console: staff access review — grants, allowlist drift and grant candidates",
    async (db) => {
      const staff = await db
        .select()
        .from(platformStaff)
        .orderBy(desc(platformStaff.grantedAt))
        .limit(200);

      /**
       * ⚠️ SCOPED TO THE ALLOWLIST, NEVER THE WHOLE `users` TABLE. This
       * is a cross-tenant read of customer workspace memberships, and
       * the only reason it is defensible is that the `IN` list is our
       * own staff addresses — a set fixed at deploy time. Widening it to
       * "search users by email" would turn an access-review screen into
       * a cross-tenant people-finder, which is what
       * `search:directory` and its mandatory justification exist for.
       */
      if (emails.length === 0) return { staffRows: staff, workspaceIdentities: [] };

      const identities = await db
        .selectDistinct({
          email: sql<string>`lower(${users.email})`,
          clerkUserId: users.clerkUserId,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(and(inArray(sql`lower(${users.email})`, emails), isNull(users.deletedAt)))
        .limit(200);

      return { staffRows: staff, workspaceIdentities: identities };
    },
  );

  const usable = (r: (typeof staffRows)[number]) =>
    r.status === "active" &&
    r.revokedAt === null &&
    (r.expiresAt === null || r.expiresAt.getTime() > now.getTime());

  const usableOwners = staffRows.filter((r) => r.grade === "owner" && usable(r)).length;
  const usableAllowlistedOwners = staffRows.filter(
    (r) => r.grade === "owner" && usable(r) && isAllowlisted(r.email, allowlist),
  ).length;

  const rows: StaffDirectoryRow[] = staffRows.map((r) => {
    const live = usable(r);
    const allowlisted = isAllowlisted(r.email, allowlist);
    return {
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      grade: r.grade,
      gradeLabel: GRADE_LABELS[r.grade],
      status: r.status,
      grantedByEmail: r.grantedByEmail,
      grantedAt: r.grantedAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      expired: Boolean(r.expiresAt && r.expiresAt.getTime() <= now.getTime()),
      allowlisted,
      usable: live,
      isSelf: r.clerkUserId === operator.clerkUserId,
      lastUsableOwner: r.grade === "owner" && live && usableOwners === 1,
      lastRealOwner:
        r.grade === "owner" && live && allowlisted && usableAllowlistedOwners === 1,
    };
  });

  /* ---- who this console is allowed to grant to ------------------- */
  const identityByEmail = new Map(
    workspaceIdentities.map((u) => [
      u.email,
      {
        clerkUserId: u.clerkUserId,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
      },
    ]),
  );

  const candidates: GrantCandidate[] = emails.map((email) => {
    // The most recent row for this address wins — `staffRows` is already
    // ordered by grant date descending, so `find` is the newest.
    const existing = staffRows.find((r) => r.email.trim().toLowerCase() === email);
    const identity = identityByEmail.get(email) ?? null;

    return {
      email,
      knownClerkUserId: existing?.clerkUserId ?? identity?.clerkUserId ?? null,
      clerkIdSource: existing
        ? "previous_grant"
        : identity
          ? "workspace_membership"
          : null,
      displayName: existing?.displayName ?? identity?.name ?? null,
      hasUsableGrant: Boolean(existing && usable(existing)),
      currentGrade: existing && usable(existing) ? existing.grade : null,
      isSelf:
        email === operator.email.trim().toLowerCase() ||
        existing?.clerkUserId === operator.clerkUserId,
    };
  });

  return {
    ok: true,
    data: {
      rows,
      candidates,
      usableOwners,
      usableAllowlistedOwners,
      operator: {
        clerkUserId: operator.clerkUserId,
        email: operator.email,
        grade: operator.grade,
        canManage: operator.capabilities.includes("staff:manage"),
      },
      allowlistConfigured: allowlist.size > 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* GRANT                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ SAME SHAPE AS THE OTHER TWO ENFORCEMENT POINTS: `queued` is on the
 * success type so a caller cannot mistake "waiting" for "done".
 */
export type StaffGrantOutcome =
  | { readonly queued: false }
  | { readonly queued: true; readonly requestId: string; readonly note: string };

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE ENFORCEMENT POINT FOR `staff.elevate`
 * ══════════════════════════════════════════════════════════════════════
 * The hold is inside this function rather than in front of
 * `grantPlatformStaffAction`, because `onConflictDoUpdate` on
 * `clerk_user_id` makes this the RENEWAL path as well as the grant path
 * and it has more than one caller. `BLOCKED_BECAUSE` in
 * `lib/platform/approvals.ts` named exactly this: "a control with an open
 * door next to it is decoration".
 *
 * ⚠️ ONLY AN ELEVATION IS HELD. A renewal at the same grade and a
 * downgrade are not — see `elevatesGrade` for why each of the three cases
 * is decided the way it is. The existing controls (owner grade, fresh
 * step-up, deploy-time allowlist, mandatory expiry, no self-grant) apply
 * to all of them regardless.
 */
export async function grantPlatformStaff(
  input: unknown,
  ticket?: ApprovalTicket,
): Promise<PlatformResult<StaffGrantOutcome>> {
  const operator = await requireCapability("staff:manage");

  const parsed = grantPlatformStaffSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { clerkUserId, email, displayName, grade, reason, expiresAt } = parsed.data;

  /**
   * 🔴 (0): NOT YOURSELF.
   *
   * `onConflictDoUpdate` targets `clerk_user_id`, so this function is
   * also the RENEWAL path. Without this check an owner could extend
   * their own grant indefinitely, clear their own `revoked_at` and
   * re-grade themselves, with no second party anywhere in the flow —
   * which makes the mandatory expiry, the whole point of which is that
   * a grant ends without somebody choosing to end it, self-serviceable.
   *
   * ⚠️ REVOCATION IS DELIBERATELY NOT SYMMETRIC. Revoking your own
   * compromised access must stay available at 3am; extending it must
   * not.
   */
  if (clerkUserId === operator.staff.clerkUserId) {
    return {
      ok: false,
      error:
        "You cannot grant or renew your own platform access. Ask another " +
        "owner. If you are the only owner, the grant has to be made in the " +
        "database, which is the same door the first one came through.",
      fieldErrors: { clerkUserId: ["This is your own account."] },
    };
  }

  /* ---- (3): KEY 1 must already be held --------------------------- */
  const allowlist = parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS);
  if (!isAllowlisted(email, allowlist)) {
    return {
      ok: false,
      error:
        `${email} is not in PLATFORM_ADMIN_EMAILS. Platform access needs both a ` +
        `config change (reviewed, deployed) and this grant — one of them on its own ` +
        `is not enough, deliberately.`,
      fieldErrors: { email: ["Not on the deploy-time allowlist."] },
    };
  }

  const expiry = new Date(expiresAt);
  if (expiry.getTime() <= Date.now()) {
    return { ok: false, error: "The end date is in the past." };
  }

  const outcome = await withPlatformScope(
    `Platform console: grant ${grade} platform access to ${email} — ${reason.slice(0, 80)}`,
    async (db) => {
      /*
       * ══════════════════════════════════════════════════════════════
       * 🔴🔴 THE GATE, ON THE GRADE THIS ACCOUNT HOLDS *NOW*
       * ══════════════════════════════════════════════════════════════
       * Read in this transaction, immediately before the upsert that
       * would change it. A grade read on the staff SCREEN a minute ago
       * is a different question: another owner can have granted,
       * revoked or re-graded this account since, and "is this an
       * elevation" has a different answer either way.
       *
       * ⚠️ USABLE, NOT MERELY PRESENT. A revoked or expired grant is
       * not a grade somebody holds, so promoting from it is a rise from
       * nothing — which is an elevation, and is held.
       */
      const [existing] = await db
        .select({ grade: platformStaff.grade })
        .from(platformStaff)
        .where(
          and(
            eq(platformStaff.clerkUserId, clerkUserId),
            eq(platformStaff.status, "active"),
            isNull(platformStaff.revokedAt),
            or(isNull(platformStaff.expiresAt), gt(platformStaff.expiresAt, new Date())),
          ),
        )
        .limit(1);

      const heldGrade = (existing?.grade ?? null) as PlatformGrade | null;

      const approval = await approvalGate(db, {
        kind: "staff.elevate",
        held: elevatesGrade(heldGrade, grade),
        ticket,
        /*
         * ⚠️ NULL, AND NOT AN OVERSIGHT. `target_id` is a uuid column
         * and the identity of this request is a Clerk user id, which is
         * not one. The identity that matters is in the stored payload,
         * which only the server ever wrote and which the executor
         * replays verbatim — a ticket cannot arrive from a browser at
         * all, because it is a second argument and every public door
         * forwards exactly one.
         */
        targetId: null,
      });

      if (!approval.proceed) {
        return { step: "held", approval, heldGrade } as const;
      }

      await db
        .insert(platformStaff)
        .values({
          clerkUserId,
          email,
          displayName: displayName ?? null,
          grade,
          status: "active",
          expiresAt: expiry,
          grantedByEmail: operator.email,
          grantReason: reason,
        })
        .onConflictDoUpdate({
          target: platformStaff.clerkUserId,
          set: {
            email,
            displayName: displayName ?? null,
            grade,
            status: "active",
            expiresAt: expiry,
            grantedByEmail: operator.email,
            grantReason: reason,
            revokedAt: null,
            revokedBy: null,
            revokeReason: null,
            // ⚠️ Cleared on every re-grant. A newly granted operator must
            // prove a factor before doing anything dangerous, rather than
            // inheriting a step-up from a previous grant.
            lastStepUpAt: null,
            updatedAt: new Date(),
          },
        });

      return { step: "written", heldGrade } as const;
    },
  );

  /* ---------------------------------------------------------------- */
  /* THE HELD PATH — NOTHING WAS WRITTEN                               */
  /* ---------------------------------------------------------------- */
  if (outcome.step === "held") {
    const { approval } = outcome;
    const label = `${email} → ${GRADE_LABELS[grade] ?? grade}`;

    if (!approval.queue) {
      await recordApprovalRefusal({
        operator,
        kind: "staff.elevate",
        targetType: "platform_staff",
        targetId: null,
        targetLabel: label,
        reason: approval.reason,
      });
      return { ok: false, error: approval.reason };
    }

    const queued = await queueForApproval({
      kind: "staff.elevate",
      operator,
      targetType: "platform_staff",
      targetId: null,
      targetLabel: label,
      justification: reason,
      proposedBefore: { grade: outcome.heldGrade },
      proposedAfter: {
        email,
        grade,
        expiresAt: expiry.toISOString(),
        effect:
          outcome.heldGrade === null
            ? `Creates a new ${grade}-grade operator. Everything on the approvals list becomes something ${email} can ask for, and — at owner grade — approve.`
            : `Raises ${email} from ${outcome.heldGrade} to ${grade}.`,
      },
      // ⭐ THE VALIDATED ARGUMENTS, REPLAYED VERBATIM. This is also the
      // only record of WHO the grant is for; see the note on `targetId`.
      payload: {
        clerkUserId,
        email,
        displayName: displayName ?? undefined,
        grade,
        reason,
        expiresAt: expiry.toISOString(),
      },
      heldWrite: true,
      now: new Date(),
    });

    if (!queued.queued) {
      await recordApprovalRefusal({
        operator,
        kind: "staff.elevate",
        targetType: "platform_staff",
        targetId: null,
        targetLabel: label,
        reason: queued.error,
      });
      return {
        ok: false,
        error: queued.error,
        fieldErrors: { reason: [queued.error] },
      };
    }

    return {
      ok: true,
      data: { queued: true, requestId: queued.requestId, note: queued.note },
    };
  }

  await recordPlatformAudit({
    operator,
    tenantId: null,
    action: "config_change",
    resourceType: "platform_staff_grant",
    resourceId: clerkUserId,
    newValue: { email, grade, expiresAt: expiry.toISOString() },
    severity: "critical",
    reason,
    metadata: {
      grantedTo: email,
      grade,
      /*
       * ⭐ THE GRADE IT CAME FROM, AND WHICH APPROVAL ALLOWED IT. A row
       * saying only "granted owner" cannot answer "was this an
       * elevation, and did a second person agree to it" — which is the
       * only question an auditor asks about this table.
       */
      previousGrade: outcome.heldGrade,
      wasElevation: elevatesGrade(outcome.heldGrade, grade),
      approvedRequestId: ticket?.approvedRequestId ?? null,
    },
  });

  return { ok: true, data: { queued: false } };
}

/* ------------------------------------------------------------------ */
/* REVOKE                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* ⭐ THE OWNER FLOOR — ONE PREDICATE, TWO CALLERS                      */
/* ------------------------------------------------------------------ */

/**
 * The transaction handle `withPlatformScope()` hands its callback.
 * Exported so a caller in another module can pass its own `db` in and
 * ask this question INSIDE its own transaction, rather than opening a
 * second one that could see a different world.
 */
export type PlatformScopeTx = Parameters<Parameters<typeof withPlatformScope<unknown>>[1]>[0];

/**
 * Owners who could still sign in if `excludeStaffIds` were all revoked.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS A FUNCTION AND NOT INLINE IN `revokePlatformStaff`
 * ══════════════════════════════════════════════════════════════════════
 * Batch 130 added a BULK revoke on the access-review screen, and a bulk
 * revoke breaks the single-row version of this check in a way that is
 * invisible: revoking two owners one at a time is refused on the second
 * call, but revoking both IN ONE BATCH passes if each is checked with
 * only itself excluded — each sees the other as the survivor, and the
 * console locks for everybody.
 *
 * ⚠️ SO THE EXCLUSION IS A LIST, ALWAYS. The caller passes the WHOLE
 * batch it is about to revoke, and the answer is "who is left when all
 * of that is gone".
 *
 * ⚠️ THE ALLOWLIST TERM IS APPLIED IN TYPESCRIPT, NOT IN SQL, and the
 * long note at the call site explains why: `guard.ts` decides key 1 with
 * `isAllowlisted` over `parseAdminAllowlist`, and a `lower(email) IN (…)`
 * here would be a second normalisation of an address. The day the two
 * disagree is the day this refusal disagrees with who can actually get
 * in. That is also why there is no `LIMIT 1` — the row the database would
 * have stopped at may be exactly the stale one.
 */
export async function usableOwnersExcluding(
  db: PlatformScopeTx,
  excludeStaffIds: readonly string[],
): Promise<{ id: string; email: string }[]> {
  const allowlist = parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS);
  const conditions = [
    eq(platformStaff.grade, "owner"),
    eq(platformStaff.status, "active"),
    isNull(platformStaff.revokedAt),
    or(isNull(platformStaff.expiresAt), gt(platformStaff.expiresAt, new Date())),
  ];
  if (excludeStaffIds.length > 0) {
    conditions.push(notInArray(platformStaff.id, [...excludeStaffIds]));
  }

  const rows = await db
    .select({ id: platformStaff.id, email: platformStaff.email })
    .from(platformStaff)
    .where(and(...conditions))
    .limit(200);

  return rows.filter((r) => isAllowlisted(r.email, allowlist));
}

/**
 * The sentence shown when the floor would be breached. One copy, because
 * two screens refusing the same thing in two different words is how an
 * operator concludes one of them is a bug.
 */
export const LAST_OWNER_REFUSAL =
  "This is the last usable owner. Revoking it would lock the " +
  "console for everybody, including you, and the only way back " +
  "in would be a hand-written row in the production database. " +
  "Grant somebody else owner grade first. An owner whose address " +
  "is no longer in PLATFORM_ADMIN_EMAILS does not count here: " +
  "that row holds the grant but not the config key, so it cannot " +
  "sign in either.";

/**
 * ⚠️ SAME SUCCESS TYPE AS THE GRANT, WITH `queued` PERMANENTLY FALSE, and
 * that is a statement rather than a formality: revocation is NEVER held
 * for approval. Reducing somebody's access must always be cheaper than
 * increasing it — the same asymmetry offboarding uses between cancel and
 * terminate — and being unable to kill a compromised grant at 3am while
 * an approver is asleep is worse than every problem this queue solves.
 */
export async function revokePlatformStaff(
  input: unknown,
): Promise<PlatformResult<StaffGrantOutcome>> {
  const operator = await requireCapability("staff:manage");

  const parsed = revokePlatformStaffSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { staffId, reason } = parsed.data;

  const outcome = await withPlatformScope(
    `Platform console: revoke platform access ${staffId} — ${reason.slice(0, 80)}`,
    async (db) => {
      const [target] = await db
        .select()
        .from(platformStaff)
        .where(eq(platformStaff.id, staffId))
        .limit(1);

      if (!target) return { error: "No such grant." } as const;

      /**
       * 🔴 THE LAST OWNER STAYS.
       *
       * Nothing stopped this before v1.31.0, and the console is the
       * only door back in: `grantPlatformStaff` requires
       * `staff:manage`, which only `owner` holds. So an owner revoking
       * themselves — or an attacker with a stolen owner session
       * revoking every owner in turn — locked the console permanently
       * for everybody, and recovery meant a hand-written INSERT against
       * the production database. That is a denial of service with a
       * one-line trigger.
       *
       * ⚠️ SELF-REVOCATION IS STILL PERMITTED while somebody else can
       * still get in. Being unable to kill your own compromised access
       * at 3am is the worse failure, and it is the reason this check
       * counts REMAINING owners rather than refusing self-revocation.
       */
      if (target.grade === "owner") {
        /**
         * 🔴 A REMAINING OWNER ONLY COUNTS IF THEY HOLD BOTH KEYS.
         *
         * Until v1.44.0 this counted by grade, status, revocation and
         * expiry and stopped there — it never asked whether the surviving
         * owner's address was still in `PLATFORM_ADMIN_EMAILS`. But
         * `guard.ts` admits nobody on the row alone, so an `active` owner
         * whose address has dropped off the allowlist — the stale grant
         * the console already paints red in `On allowlist` — SATISFIED
         * this check while being unable to sign in.
         *
         * The lockout that produced: two owner rows, one of them stale,
         * the real owner revokes themselves, the count sees a second
         * owner and permits it, and the console is now unreachable by
         * anybody. Recovery is a hand-written row in the production
         * database — reached THROUGH the guard written to prevent it.
         *
         * ⚠️ THE ALLOWLIST TERM IS APPLIED HERE AND NOT IN SQL, so the
         * refusal and the sign-in use one predicate. `guard.ts` decides
         * KEY 1 with `isAllowlisted` over `parseAdminAllowlist`, which
         * trim-and-lowercase both sides; a `lower(email) IN (…)` in this
         * query would be a second normalisation of an address, and the
         * day the two disagree is the day this refusal disagrees with who
         * can actually get in.
         *
         * ⚠️ AND SO THERE IS NO `LIMIT 1`. The row the database would
         * have stopped at may be exactly the stale one.
         */
        const remaining = await usableOwnersExcluding(db, [staffId]);

        if (remaining.length === 0) {
          return {
            error: LAST_OWNER_REFUSAL,
                    } as const;
        }
      }

      await db
        .update(platformStaff)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          revokeReason: reason,
          /**
           * 🔴 THE COLUMN EXISTED SINCE PHASE 17 AND NOTHING WROTE IT.
           * `platform_staff.revoked_by` was always NULL, so the table
           * alone could not say who revoked a grant — you had to join
           * `platform_action_log`, which is exactly the two-table
           * problem the guard argues against elsewhere.
           */
          revokedBy: operator.staff.id,
          lastStepUpAt: null,
          updatedAt: new Date(),
        })
        .where(eq(platformStaff.id, staffId));

      return { email: target.email, grade: target.grade } as const;
    },
  );

  if (outcome.error) return { ok: false, error: outcome.error };

  await recordPlatformAudit({
    operator,
    tenantId: null,
    action: "config_change",
    resourceType: "platform_staff_revoke",
    resourceId: staffId,
    oldValue: { email: outcome.email, grade: outcome.grade, status: "active" },
    newValue: { status: "revoked" },
    severity: "critical",
    reason,
    metadata: { revokedFrom: outcome.email, selfRevoke: outcome.email === operator.email },
  });

  return { ok: true, data: { queued: false } };
}
