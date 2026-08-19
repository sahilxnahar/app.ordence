import "server-only";

/**
 * Ordence — ⭐⭐ THE DATA-PRINCIPAL REQUEST REGISTER
 * Version: v1.68.0-alpha
 *
 * Database work only. The decisions are in `lib/dpdp/`; the guards are
 * in `server/actions/dpdp.ts`. Every function here takes a tenant id and
 * is called from inside a guarded action — the split
 * `lib/inventory/valuation.ts` / `server/inventory/valuation-service.ts`
 * models.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  dataPrincipalRequestAnchors,
  dataPrincipalRequestEvents,
  dataPrincipalRequests,
} from "@/db/schema/dpdp";
import type { ErasurePlan } from "@/lib/dpdp/erasure";
import type { PrincipalExport } from "./export-service";
import type { PrincipalKind } from "@/lib/dpdp/classification";
import type { Subject } from "@/lib/dpdp/subject-graph";

/* ------------------------------------------------------------------ */

export type RequestKind =
  | "access"
  | "erasure"
  | "correction"
  | "grievance"
  | "consent_withdrawal";

export type RequestRow = typeof dataPrincipalRequests.$inferSelect;
export type AnchorRow = typeof dataPrincipalRequestAnchors.$inferSelect;

/**
 * ⚠️ THE REFERENCE IS PER WORKSPACE AND PER YEAR, AND IT IS DERIVED FROM
 * A COUNT RATHER THAN A SEQUENCE.
 *
 * A sequence would be globally unique and would leak how many requests
 * every other workspace has had, in a number a customer puts in a letter
 * to a Data Principal. That is a small disclosure and it is free to
 * avoid.
 *
 * 🔴 A COUNT RACES. Two requests logged in the same second can collide,
 * and the unique index on (tenant_id, reference) then refuses the
 * second. That is the correct failure — a duplicate reference in a
 * statutory register is worse than a retry — and the caller retries.
 */
export async function nextReference(tenantId: string, year: number): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.execute(
      sql`SELECT count(*)::int AS n FROM data_principal_requests
           WHERE tenant_id = ${tenantId}
             AND date_part('year', received_at) = ${year}`,
    );
    const n = Number((result.rows?.[0] as { n?: number } | undefined)?.n ?? 0);
    return `DPR-${year}-${String(n + 1).padStart(4, "0")}`;
  });
}

/* ------------------------------------------------------------------ */

export async function createRequest(
  tenantId: string,
  input: {
    reference: string;
    kind: RequestKind;
    principalLabel: string;
    principalEmail: string | null;
    principalPhone: string | null;
    /** 🔴 NOT NULL, at least ten characters, enforced by a CHECK in 0113. */
    verifiedHow: string;
    userId: string;
    now: Date;
  },
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(dataPrincipalRequests)
      .values({
        tenantId,
        reference: input.reference,
        kind: input.kind,
        principalLabel: input.principalLabel,
        principalEmail: input.principalEmail,
        principalPhone: input.principalPhone,
        verifiedHow: input.verifiedHow,
        verifiedBy: input.userId,
        verifiedAt: input.now,
        status: "verifying",
        receivedAt: input.now,
        createdBy: input.userId,
      })
      .returning({ id: dataPrincipalRequests.id });
    if (!row) throw new Error("The request could not be recorded.");
    return { id: row.id };
  });
}

export async function addAnchor(
  tenantId: string,
  input: {
    requestId: string;
    principalKind: PrincipalKind;
    principalId: string;
    establishedBy: string;
    userId: string;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .insert(dataPrincipalRequestAnchors)
      .values({
        tenantId,
        requestId: input.requestId,
        principalKind: input.principalKind,
        principalId: input.principalId,
        establishedBy: input.establishedBy,
        createdBy: input.userId,
      })
      .onConflictDoNothing();
  });
}

/**
 * ⭐ THE SUBJECT, ASSEMBLED FROM WHAT A PERSON VERIFIED.
 *
 * 🔴 NOTHING HERE INFERS AN ANCHOR. The email and phone on the request
 * are used to match VALUE columns — `email_outbox.to_email` and the
 * like — and are never turned into "so there must be a contact with that
 * address". `info@` on a family business is why.
 */
export async function subjectFor(tenantId: string, requestId: string): Promise<Subject | null> {
  return withTenant(tenantId, async (tx) => {
    const [req] = await tx
      .select()
      .from(dataPrincipalRequests)
      .where(
        and(eq(dataPrincipalRequests.tenantId, tenantId), eq(dataPrincipalRequests.id, requestId)),
      )
      .limit(1);
    if (!req) return null;

    const anchors = await tx
      .select()
      .from(dataPrincipalRequestAnchors)
      .where(
        and(
          eq(dataPrincipalRequestAnchors.tenantId, tenantId),
          eq(dataPrincipalRequestAnchors.requestId, requestId),
        ),
      );

    return {
      anchors: anchors.map((a) => ({
        kind: a.principalKind as PrincipalKind,
        id: a.principalId,
        establishedBy: a.establishedBy,
      })),
      identifiers: {
        emails: req.principalEmail ? [req.principalEmail] : [],
        phones: req.principalPhone ? [req.principalPhone] : [],
      },
    };
  });
}

/* ------------------------------------------------------------------ */

/**
 * ⚠️ APPEND-ONLY. 0113 §4 puts a trigger under this table and §7 grants
 * INSERT and SELECT only. Two independent refusals of the same thing,
 * which is the correction 0102 had to make to 0087 after that file cited
 * a trigger nobody had created.
 */
export async function recordEvents(
  tenantId: string,
  requestId: string,
  userId: string,
  events: readonly {
    action:
      | "planned"
      | "exported"
      | "erased"
      | "redacted"
      | "retained"
      | "referred"
      | "could_not_search"
      | "notice_sent";
    tableName?: string;
    rowCount?: number;
    retentionRule?: string;
    because?: string;
  }[],
): Promise<void> {
  if (events.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    await tx.insert(dataPrincipalRequestEvents).values(
      events.map((e) => ({
        tenantId,
        requestId,
        action: e.action,
        tableName: e.tableName ?? null,
        rowCount: e.rowCount ?? null,
        retentionRule: e.retentionRule ?? null,
        because: e.because ?? null,
        actorUserId: userId,
      })),
    );
  });
}

/**
 * ⭐ THE RECEIPT IS WRITTEN IN THE SAME CALL THAT MARKS THE REQUEST
 * ANSWERED, because a CHECK constraint in 0113 refuses `answered`
 * without an `outcome_manifest`. Two statements could leave the register
 * saying we replied without saying what we said.
 */
export async function recordAnswer(
  tenantId: string,
  input: {
    requestId: string;
    manifest: Record<string, unknown>;
    refusalNotice: string | null;
    needsHumanDecision: boolean;
    now: Date;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(dataPrincipalRequests)
      .set({
        /**
         * 🔴 A REQUEST WITH ANYTHING WAITING ON A HUMAN IS NOT ANSWERED.
         * The CHECK in 0113 would refuse `answered` here anyway; setting
         * `planned` rather than letting the database reject the write is
         * what turns a 500 into a screen that says what is outstanding.
         */
        status: input.needsHumanDecision ? "planned" : "answered",
        needsHumanDecision: input.needsHumanDecision,
        outcomeManifest: input.manifest,
        refusalNotice: input.refusalNotice,
        answeredAt: input.needsHumanDecision ? null : input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(dataPrincipalRequests.tenantId, tenantId),
          eq(dataPrincipalRequests.id, input.requestId),
        ),
      );
  });
}

export async function listRequests(tenantId: string, limit = 100): Promise<RequestRow[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(dataPrincipalRequests)
      .where(eq(dataPrincipalRequests.tenantId, tenantId))
      .orderBy(desc(dataPrincipalRequests.receivedAt))
      .limit(limit),
  );
}

export async function getRequest(tenantId: string, id: string): Promise<RequestRow | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(dataPrincipalRequests)
      .where(and(eq(dataPrincipalRequests.tenantId, tenantId), eq(dataPrincipalRequests.id, id)))
      .limit(1);
    return row ?? null;
  });
}

/* ------------------------------------------------------------------ */

/**
 * ⭐ TURN A PLAN AND AN EXPORT INTO THE ROWS THAT PROVE WHAT WAS DONE.
 *
 * 🔴 IT WRITES TABLE NAMES AND COUNTS, NEVER THE ROWS THEMSELVES.
 * Keeping a copy of what was erased in order to prove it was erased is
 * the same personal data under a different table name, and s.8(7) would
 * apply to it identically.
 */
type RecordedEvent = Parameters<typeof recordEvents>[3][number];

export function eventsFromErasure(plan: ErasurePlan): RecordedEvent[] {
  return plan.tables.map((t) => ({
    action:
      t.couldNotSearch
        ? ("could_not_search" as const)
        : t.action === "delete"
          ? ("erased" as const)
          : t.action === "redact"
            ? ("redacted" as const)
            : t.action === "retain"
              ? ("retained" as const)
              : ("referred" as const),
    tableName: t.table,
    retentionRule: t.rule?.id,
    because: t.because,
  }));
}

export function eventsFromExport(e: PrincipalExport): RecordedEvent[] {
  const rows: RecordedEvent[] = Object.entries(e.manifest.counts).map(
    ([table, count]) => ({
      action: "exported" as const,
      tableName: table,
      rowCount: count,
    }),
  );
  /**
   * ⚠️ THE TABLES WE DID NOT SEARCH GET ROWS TOO, and only the genuine
   * gaps — `no-reach` — not the ones this person simply has no record
   * in. Recording ninety "not applicable" rows per request would bury
   * the one that matters, which is how an admitted gap stops being read.
   */
  for (const n of e.manifest.notSearched) {
    if (n.kind !== "no-reach") continue;
    rows.push({ action: "could_not_search", tableName: n.table, because: n.reason });
  }
  return rows;
}
