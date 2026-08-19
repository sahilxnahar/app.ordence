import "server-only";

/**
 * Ordence — ⭐⭐ THE BREACH REGISTER
 * Version: v1.68.0-alpha
 *
 * Database work only. The two clocks, the Rule 7 content check and the
 * intimation itself are pure and live in `lib/dpdp/breach.ts`.
 *
 * ⚠️ THIS IS NOT AN INCIDENT TRACKER. `platform_incidents` already
 * exists for operational incidents and break-glass access, and it has no
 * notification concept at all — no `regulatorNotifiedAt`, no
 * `affectedPersonsNotifiedAt`, no artefact. Merging the two would put a
 * statutory notification duty behind a screen support staff use for
 * outages.
 */

import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { personalDataBreaches } from "@/db/schema/dpdp";
import {
  DPDP_RULE_7_COMMENCEMENT,
  blockersToClosing,
  deadlines,
  intimationToPrincipal,
  type BreachFacts,
  type Deadline,
} from "@/lib/dpdp/breach";

export type BreachRow = typeof personalDataBreaches.$inferSelect;

function factsOf(row: BreachRow): BreachFacts {
  return {
    reference: row.reference,
    noticedAt: row.noticedAt,
    occurredAt: row.occurredAt,
    nature: row.nature,
    extent: row.extent,
    timingAndLocation: row.timingAndLocation,
    likelyConsequences: row.likelyConsequences,
    mitigationImplemented: row.mitigationImplemented,
    safeguardsForPrincipals: row.safeguardsForPrincipals,
    contactPerson: row.contactPerson,
    affectedPrincipalCount: row.affectedPrincipalCount,
  };
}

export async function recordBreach(
  tenantId: string,
  input: BreachFacts & { userId: string; now: Date },
): Promise<{ id: string; breachClass: string }> {
  /**
   * ⭐ WHICH REGIME THIS ROW WAS RAISED UNDER, DECIDED HERE AND STORED.
   *
   * The DPDP Rules 2025 are notified and commence around May 2027.
   * A breach recorded before then is `anticipatory`: the workspace is
   * choosing to meet Rule 7 early. Storing which is what lets somebody
   * in 2028 tell the difference between "we complied" and "we were ahead
   * of the requirement", rather than inferring it from a date.
   */
  const breachClass = input.now >= DPDP_RULE_7_COMMENCEMENT ? "dpdp_rules_2025" : "anticipatory";

  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(personalDataBreaches)
      .values({
        tenantId,
        reference: input.reference,
        breachClass,
        noticedAt: input.noticedAt,
        occurredAt: input.occurredAt,
        nature: input.nature,
        extent: input.extent,
        timingAndLocation: input.timingAndLocation,
        likelyConsequences: input.likelyConsequences,
        mitigationImplemented: input.mitigationImplemented,
        safeguardsForPrincipals: input.safeguardsForPrincipals,
        contactPerson: input.contactPerson,
        affectedPrincipalCount: input.affectedPrincipalCount,
        createdBy: input.userId,
      })
      .returning({ id: personalDataBreaches.id });
    if (!row) throw new Error("The breach could not be recorded.");
    return { id: row.id, breachClass };
  });
}

/**
 * 🔴 THE READ THAT CHANGES BEHAVIOUR.
 *
 * Every stored column is loaded and passed through the pure engine, so
 * the four deadlines, their overdue states and the blockers to closing
 * are all DERIVED from what is on the row. A column that were never read
 * would show up here as an argument nobody passes.
 */
export async function breachBoard(
  tenantId: string,
  now: Date,
): Promise<
  {
    row: BreachRow;
    deadlines: Deadline[];
    blockers: string[];
    overdue: number;
    intimation: string;
    missing: string[];
  }[]
> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(personalDataBreaches)
      .where(eq(personalDataBreaches.tenantId, tenantId))
      .orderBy(desc(personalDataBreaches.noticedAt))
      .limit(100),
  );

  return rows.map((row) => {
    const facts = factsOf(row);
    const d = deadlines({
      facts,
      certinReportedAt: row.certinReportedAt,
      boardIntimatedAt: row.boardIntimatedAt,
      boardDetailedReportAt: row.boardDetailedReportAt,
      principalsIntimatedAt: row.principalsIntimatedAt,
      now,
    });
    const { text, missing } = intimationToPrincipal({
      facts,
      workspaceName: "this workspace",
      principalLabel: "[name]",
      onDate: now.toISOString().slice(0, 10),
    });
    return {
      row,
      deadlines: d,
      blockers: blockersToClosing({
        facts,
        boardIntimatedAt: row.boardIntimatedAt,
        principalsIntimatedAt: row.principalsIntimatedAt,
        intimationText: row.principalIntimationText,
      }),
      overdue: d.filter((x) => x.state === "overdue").length,
      intimation: text,
      missing,
    };
  });
}

/**
 * ⚠️ RECORDING THAT SOMEBODY WAS TOLD REQUIRES THE TEXT THEY WERE TOLD.
 *
 * 0113 puts a CHECK under this — `principals_intimated_at IS NULL OR
 * principal_intimation_text IS NOT NULL` — so a future caller that
 * forgets is refused by the database rather than by this function.
 */
export async function recordIntimation(
  tenantId: string,
  input: {
    id: string;
    audience: "certin" | "board" | "board_detailed" | "principals";
    text: string | null;
    at: Date;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const patch: Partial<typeof personalDataBreaches.$inferInsert> = { updatedAt: input.at };
    if (input.audience === "certin") patch.certinReportedAt = input.at;
    if (input.audience === "board") patch.boardIntimatedAt = input.at;
    if (input.audience === "board_detailed") patch.boardDetailedReportAt = input.at;
    if (input.audience === "principals") {
      patch.principalsIntimatedAt = input.at;
      patch.principalIntimationText = input.text;
      patch.status = "intimated";
    }
    await tx
      .update(personalDataBreaches)
      .set(patch)
      .where(
        and(eq(personalDataBreaches.tenantId, tenantId), eq(personalDataBreaches.id, input.id)),
      );
  });
}
