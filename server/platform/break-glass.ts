import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE BREAK-GLASS DEBT LEDGER
 * Version: v1.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE HOLDS NO POLICY
 * ══════════════════════════════════════════════════════════════════════
 * Every threshold, every refusal sentence and every decision about what
 * blocks what lives in `lib/platform/break-glass.ts`, which is pure and
 * testable without a database. This file reads rows and writes rows.
 *
 * 🔴 THAT SPLIT IS NOT TIDINESS. The block that refuses a second
 * break-glass session is the single most consequential refusal in the
 * console, and a refusal that can only be exercised by standing up
 * Postgres is a refusal that gets tested once and then trusted forever.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { platformImpersonationSessions } from "@/db/schema/platform";
import { tenants } from "@/db/schema/core";
import {
  breakGlassBlock,
  noteDebts,
  postIncidentNoteProblem,
  type BreakGlassSession,
  type NoteDebt,
} from "@/lib/platform/break-glass";
import { recordPlatformAudit, type PlatformOperator } from "./guard";

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

async function sessionsOwingNotes(staffId: string): Promise<BreakGlassSession[]> {
  return withPlatformScope(
    "Platform console: break-glass write-ups outstanding",
    async (db) => {
      const rows = await db
        .select({
          id: platformImpersonationSessions.id,
          tenantName: tenants.name,
          startedAt: platformImpersonationSessions.startedAt,
          endedAt: platformImpersonationSessions.endedAt,
          expiresAt: platformImpersonationSessions.expiresAt,
          postIncidentNote: platformImpersonationSessions.postIncidentNote,
        })
        .from(platformImpersonationSessions)
        .innerJoin(tenants, eq(tenants.id, platformImpersonationSessions.tenantId))
        .where(
          and(
            eq(platformImpersonationSessions.staffId, staffId),
            eq(platformImpersonationSessions.mode, "break_glass"),
            isNull(platformImpersonationSessions.postIncidentNote),
          ),
        )
        .orderBy(desc(platformImpersonationSessions.startedAt))
        .limit(50);

      return rows;
    },
  );
}

/**
 * ⭐ THE ONE FUNCTION `startImpersonation` CALLS. Returns the refusal
 * sentence, or null to allow.
 *
 * ⚠️ CALLED ONLY FOR BREAK-GLASS. Consented support access is never
 * blocked by this, and that is deliberate: making the debt block the
 * consented path would push an operator with a long queue towards the
 * unconsented one, which is precisely backwards.
 */
export async function breakGlassDebtBlock(
  staffId: string,
  now: Date,
): Promise<string | null> {
  const sessions = await sessionsOwingNotes(staffId);
  return breakGlassBlock(noteDebts(sessions, now), now);
}

export interface DebtRow extends NoteDebt {
  readonly justification: string;
  readonly reason: string | null;
}

/** ⭐ What the operator sees on their own screen, so the debt is visible
 *  before it is blocking rather than only at the moment of refusal. */
export async function myBreakGlassDebt(
  staffId: string,
  now: Date,
): Promise<readonly DebtRow[]> {
  const rows = await withPlatformScope(
    "Platform console: my break-glass write-ups",
    async (db) =>
      db
        .select({
          id: platformImpersonationSessions.id,
          tenantName: tenants.name,
          startedAt: platformImpersonationSessions.startedAt,
          endedAt: platformImpersonationSessions.endedAt,
          expiresAt: platformImpersonationSessions.expiresAt,
          postIncidentNote: platformImpersonationSessions.postIncidentNote,
          justification: platformImpersonationSessions.justification,
          reason: platformImpersonationSessions.breakGlassReason,
        })
        .from(platformImpersonationSessions)
        .innerJoin(tenants, eq(tenants.id, platformImpersonationSessions.tenantId))
        .where(
          and(
            eq(platformImpersonationSessions.staffId, staffId),
            eq(platformImpersonationSessions.mode, "break_glass"),
            isNull(platformImpersonationSessions.postIncidentNote),
          ),
        )
        .orderBy(desc(platformImpersonationSessions.startedAt))
        .limit(50),
  );

  const debts = noteDebts(rows, now);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return debts.map((d) => ({
    ...d,
    justification: byId.get(d.sessionId)?.justification ?? "",
    reason: byId.get(d.sessionId)?.reason ?? null,
  }));
}

/* ------------------------------------------------------------------ */
/* WRITE                                                               */
/* ------------------------------------------------------------------ */

export type NoteOutcome = { ok: true; note: string } | { ok: false; error: string };

/**
 * ⚠️ ANY OPERATOR HOLDING THE CAPABILITY MAY CLOSE ANY SESSION OUT, not
 * only the one who went in. The alternative is a permanent block on
 * somebody who has left the company, and a control that can be
 * permanently jammed by an ordinary staffing event is a control that
 * gets disabled the first time it happens.
 *
 * ⭐ `post_incident_by` RECORDS WHO ACTUALLY WROTE IT, so "closed out by
 * a colleague from the log" is visibly different from "written by the
 * person who was there".
 */
export async function writePostIncidentNote(args: {
  readonly sessionId: string;
  readonly note: string;
  readonly operator: PlatformOperator;
  readonly now: Date;
}): Promise<NoteOutcome> {
  const problem = postIncidentNoteProblem(args.note);
  if (problem) return { ok: false, error: problem };

  const row = await withPlatformScope(
    "Platform console: read break-glass session for write-up",
    async (db) => {
      const [r] = await db
        .select({
          id: platformImpersonationSessions.id,
          tenantId: platformImpersonationSessions.tenantId,
          mode: platformImpersonationSessions.mode,
          staffId: platformImpersonationSessions.staffId,
          endedAt: platformImpersonationSessions.endedAt,
          expiresAt: platformImpersonationSessions.expiresAt,
          existing: platformImpersonationSessions.postIncidentNote,
        })
        .from(platformImpersonationSessions)
        .where(eq(platformImpersonationSessions.id, args.sessionId))
        .limit(1);
      return r ?? null;
    },
  );

  if (!row) return { ok: false, error: "No such session." };
  if (row.mode !== "break_glass") {
    return {
      ok: false,
      error: "That session was consented support access. Only break-glass needs a write-up.",
    };
  }
  if (row.existing && row.existing.trim().length > 0) {
    // 🔴 NOT AN EDIT. The write-up is evidence, and evidence that can be
    // rewritten after somebody asks a question about it is not evidence.
    return {
      ok: false,
      error:
        "This session already has a write-up. It cannot be edited — if something in it is wrong, say so in the incident record rather than changing the original.",
    };
  }

  const closedAt = row.endedAt ?? row.expiresAt;
  if (closedAt.getTime() > args.now.getTime()) {
    return {
      ok: false,
      error:
        "That session is still open. Finish it first, then write up what you found.",
    };
  }

  await withPlatformScope(
    "Platform console: record break-glass write-up",
    async (db) => {
      await db
        .update(platformImpersonationSessions)
        .set({
          postIncidentNote: args.note.trim(),
          postIncidentAt: args.now,
          postIncidentBy: args.operator.staff.id,
        })
        .where(eq(platformImpersonationSessions.id, args.sessionId));
    },
  );

  await recordPlatformAudit({
    operator: args.operator,
    // ⚠️ TENANT-ATTRIBUTED. The customer whose data was read gets to see
    // that somebody wrote up why, in the same log that showed them the
    // access itself.
    tenantId: row.tenantId,
    action: "security_event",
    resourceType: "impersonation_session",
    resourceId: row.id,
    reason: `Break-glass write-up: ${args.note.trim().slice(0, 300)}`,
    metadata: {
      onBehalfOfAnotherOperator: row.staffId !== args.operator.staff.id,
    },
    severity: "notice",
  });

  return {
    ok: true,
    note:
      row.staffId === args.operator.staff.id
        ? "Written up. You can break glass again if you need to."
        : "Written up on behalf of the operator who held the session. Their block is lifted.",
  };
}

/**
 * ⚠️ THE PLATFORM-WIDE VIEW, for the incidents screen. Every unwritten
 * note, not only mine, because a debt nobody else can see is a debt only
 * the person who owes it knows about.
 */
export async function allOutstandingWriteUps(now: Date) {
  const rows = await withPlatformScope(
    "Platform console: all outstanding break-glass write-ups",
    async (db) =>
      db
        .select({
          id: platformImpersonationSessions.id,
          tenantName: tenants.name,
          actorEmail: platformImpersonationSessions.actorEmail,
          startedAt: platformImpersonationSessions.startedAt,
          endedAt: platformImpersonationSessions.endedAt,
          expiresAt: platformImpersonationSessions.expiresAt,
          postIncidentNote: platformImpersonationSessions.postIncidentNote,
          justification: platformImpersonationSessions.justification,
        })
        .from(platformImpersonationSessions)
        .innerJoin(tenants, eq(tenants.id, platformImpersonationSessions.tenantId))
        .where(
          and(
            eq(platformImpersonationSessions.mode, "break_glass"),
            isNull(platformImpersonationSessions.postIncidentNote),
          ),
        )
        .orderBy(desc(platformImpersonationSessions.startedAt))
        .limit(100),
  );

  const debts = noteDebts(rows, now);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return debts.map((d) => ({
    ...d,
    actorEmail: byId.get(d.sessionId)?.actorEmail ?? "",
    justification: byId.get(d.sessionId)?.justification ?? "",
  }));
}

void sql;
