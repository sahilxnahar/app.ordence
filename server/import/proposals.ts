import "server-only";

/**
 * Ordence — ⭐⭐ RECORDING WHO DECIDED WHAT THE COLUMNS MEANT
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE QUESTION THIS ANSWERS IS ASKED SIX MONTHS LATER
 * ══════════════════════════════════════════════════════════════════════
 * "Who decided that column F was the GSTIN?"
 *
 * A proposal that is acted on and not recorded is indistinguishable
 * afterwards from a person's decision. With a model in the loop that is
 * not a philosophical point: `auto_above_threshold` means some mappings
 * genuinely were nobody's decision, and the workspace is entitled to know
 * which ones.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND `corrections` IS THE MOST USEFUL COLUMN IN THE PRODUCT'S HISTORY
 *    OF ITS OWN MISTAKES
 * ══════════════════════════════════════════════════════════════════════
 * Every entry is a case where the deterministic matcher, or the model,
 * proposed one thing and somebody who knew the answer changed it. That is
 * the only honest source of "where is the mapper wrong", and it comes
 * free with recording the decision at all.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { importMappingProposals } from "@/db/schema/import-runs";
import { AUTO_COMMIT_THRESHOLD, type MappingProposal } from "@/lib/import/proposal";

export type ProposalOutcome = "proposed" | "confirmed" | "corrected" | "auto" | "discarded";

export class ProposalRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalRecordError";
  }
}

/**
 * ⚠️ STORED AS SENT, NOT AS A SUMMARY. A later reader has to be able to
 * see what was actually put in front of the person — including the
 * `why` sentences, which are the whole basis on which they agreed.
 */
function serialise(proposal: MappingProposal) {
  return {
    entityKey: proposal.entityKey,
    confidence: proposal.confidence,
    usedModel: proposal.usedModel,
    columns: proposal.columns.map((c) => ({
      field: c.field,
      header: c.header,
      required: c.required,
      sourceHeader: c.sourceHeader,
      confidence: c.confidence,
      basis: c.basis,
      why: c.why,
      ...(c.conflict ? { conflict: c.conflict } : {}),
    })),
    unmapped: proposal.unmappedSourceHeaders,
    cautions: proposal.cautions,
  };
}

export async function recordProposal(args: {
  readonly tenantId: string;
  readonly proposedFor: string;
  readonly runId?: string | null;
  readonly proposal: MappingProposal;
  readonly outcome: ProposalOutcome;
  readonly modelSource?: "platform" | "tenant" | null;
  readonly corrections?: Readonly<Record<string, { from: string | null; to: string | null }>>;
}): Promise<string> {
  const confidenceMilli = Math.round(Math.max(0, Math.min(1, args.proposal.confidence)) * 1000);

  /**
   * 🔴 THE SAME REFUSAL THE DATABASE MAKES, MADE HERE FIRST SO THE
   * MESSAGE IS READABLE. `import_mapping_auto_cleared_threshold` would
   * catch this as a check violation; a check violation is the right
   * backstop and the wrong error message.
   */
  if (args.outcome === "auto" && args.proposal.confidence < AUTO_COMMIT_THRESHOLD) {
    throw new ProposalRecordError(
      `A mapping at ${Math.round(args.proposal.confidence * 100)}% confidence cannot be recorded ` +
        `as automatically committed. Ordence commits automatically at ` +
        `${Math.round(AUTO_COMMIT_THRESHOLD * 100)}% or above, and this record would say ` +
        `otherwise.`,
    );
  }

  const corrections = args.corrections ?? {};
  if (args.outcome === "corrected" && Object.keys(corrections).length === 0) {
    throw new ProposalRecordError(
      "A mapping was recorded as corrected with nothing recorded as changed.",
    );
  }

  return withTenant(args.tenantId, async (tx) => {
    const [row] = await tx
      .insert(importMappingProposals)
      .values({
        tenantId: args.tenantId,
        runId: args.runId ?? null,
        proposedFor: args.proposedFor,
        entityKey: args.proposal.entityKey,
        sourceHeaders: [...args.proposal.sourceHeaders],
        proposal: serialise(args.proposal),
        confidenceMilli,
        usedModel: Boolean(args.modelSource),
        modelSource: args.modelSource ?? null,
        outcome: args.outcome,
        corrections: corrections as Record<string, unknown>,
      })
      .returning({ id: importMappingProposals.id });

    if (!row) throw new ProposalRecordError("The mapping decision could not be recorded.");
    return row.id;
  });
}

/**
 * ⭐ THE CORRECTIONS, FOR THE PEOPLE WHO MAINTAIN THE MATCHER.
 *
 * ⚠️ SCOPED TO THE WORKSPACE, like everything else. This is not a
 * cross-tenant training set and must never become one without the
 * customer being asked — their column headings are their business
 * vocabulary.
 */
export async function correctionsSince(
  tenantId: string,
  since: Date,
): Promise<{ entityKey: string; corrections: unknown; confidence: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        entityKey: importMappingProposals.entityKey,
        corrections: importMappingProposals.corrections,
        confidenceMilli: importMappingProposals.confidenceMilli,
      })
      .from(importMappingProposals)
      .where(
        and(
          eq(importMappingProposals.tenantId, tenantId),
          eq(importMappingProposals.outcome, "corrected"),
          sql`${importMappingProposals.proposedAt} >= ${since.toISOString()}`,
        ),
      )
      .orderBy(sql`${importMappingProposals.proposedAt} DESC`)
      .limit(500);

    return rows.map((r) => ({
      entityKey: r.entityKey,
      corrections: r.corrections,
      confidence: r.confidenceMilli / 1000,
    }));
  });
}
