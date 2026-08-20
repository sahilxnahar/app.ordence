import "server-only";

/**
 * Ordence — ⭐⭐ THE TAX DECISION TRAIL: WHICH RATE, WHICH RULE, WHY
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DOCUMENT RECORDS THE ANSWER AND NOT THE REASONING
 * ══════════════════════════════════════════════════════════════════════
 * A `sales_invoice_lines` row says `tax_rate_bps = 1800`, `igst_minor =
 * 18000`, and its parent says `place_of_supply_code = '29'`. Between
 * them that is internally honest — SQL 0146 pins the rate to this
 * tenant's own period, SQL 0147 refuses a line whose money does not
 * recompute from the rate it names — and an accountant asked to defend
 * it still cannot, because none of it says:
 *
 *   · why 29 and not 27. The recipient's registered address? The place
 *     of performance? Immovable property? Each is a different sub-section
 *     of s.12, and "which one" is the officer's first question;
 *   · which notification put that HSN at 18% on that date;
 *   · whether reverse charge was considered and rejected, or never
 *     considered at all;
 *   · who or what decided, with which version of the engine.
 *
 * ⭐ SO THIS IS A DECISION LOG, NOT A CACHE. Nothing in the product reads
 * `tax_decisions` to compute anything, and nothing ever should. It exists
 * to be read by a HUMAN under assessment, months later, when the master
 * data has moved on and re-deriving the answer from today's rates proves
 * nothing about what was decided then.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ RAW SQL, AND WHY — READ BEFORE "TIDYING THIS UP"
 * ══════════════════════════════════════════════════════════════════════
 * `tax_decisions` is created by SQL 0150 and has NO Drizzle table object,
 * because `db/schema/**` belongs to another track and Track E may not
 * write there. Every statement below therefore goes through
 * `tx.execute(sql\`…\`)`.
 *
 * ⭐ A DRIZZLE TABLE OBJECT FOR `tax_decisions` IS REQUESTED IN
 * PATCH-REQUEST-E.md. Until it exists these queries are hand-written and
 * hand-typed, which means a column rename in 0150 breaks them at RUNTIME
 * rather than at `tsc`. That is a real cost and it is the reason the
 * patch request exists.
 *
 * ⚠️ EVERY VALUE IS A BOUND PARAMETER. `sql` interpolation in Drizzle
 * parameterises by default; the only `sql.raw` in this file would be a
 * defect. Tenant scope comes from `withTenant`, so row-level security is
 * applied by the database and not by a `WHERE tenant_id = …` somebody can
 * forget — and 0150 §2 FORCEs RLS on this table for exactly that reason.
 *
 * ⚠️ NOT `"use server"`. It takes `tenantId` as a parameter, which is
 * correct for a `server-only` module and is the v005 cross-tenant bug in
 * an action file.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { applyRateBps, toBigIntAmount } from "@/lib/billing/money";
import type { GstTaxKind, PlaceOfSupplyBasis } from "@/lib/gst/place-of-supply";
import { TAX_ENGINE_VERSION } from "./compute";

/* ------------------------------------------------------------------ */
/* WHAT A DECISION IS                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE FIVE TABLES, ENUMERATED, BECAUSE 0150 ENUMERATES THEM IN A
 * CHECK CONSTRAINT (`tax_decisions_document_table_known`). A sixth table
 * that carries a GST split belongs in BOTH lists; adding it here alone
 * produces a runtime constraint violation naming a table nobody expected
 * to be wrong.
 */
export const TAX_DECISION_DOCUMENT_TABLES = [
  "sales_invoice_lines",
  "sales_credit_note_lines",
  "sales_order_lines",
  "invoice_lines",
  "purchase_invoice_lines",
] as const;

export type TaxDecisionDocumentTable = (typeof TAX_DECISION_DOCUMENT_TABLES)[number];

/** One line's reasoning, as it is written down. */
export type TaxDecisionLine = {
  /** The line row's own id. The unique key is (tenant, table, this). */
  documentLineId: string;
  lineNo: number | null;

  hsnSacCode: string | null;
  /** ⭐ The registry row resolved for the document's date. See compute.ts. */
  hsnSacRateId: string | null;
  rateBps: number;
  cessRateBps: number;
  /** e.g. "Notification 11/2017-Central Tax (Rate), Sl. No. 3(ii)". */
  notificationRef: string | null;
  /**
   * ⚠️ COPIED FROM THE RATE PERIOD, NOT JOINED TO IT. Closing that period
   * next year must not restate what this decision says was in force. Same
   * argument as every other captured-at-issue column in this schema.
   */
  rateEffectiveFrom: string | null;
  rateEffectiveTo: string | null;

  taxKind: GstTaxKind;
  isReverseCharge: boolean;
  /**
   * Which limb applied, e.g. `notified_service`, `unregistered_supplier`,
   * `import_of_service`. Null when reverse charge did not apply — and
   * NULL here means "not applicable", never "not considered".
   */
  reverseChargeBasis: string | null;

  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
};

export type RecordTaxDecisionsInput = {
  documentTable: TaxDecisionDocumentTable;
  /** The PARENT document's id — denormalised on purpose (0150 §1). */
  documentId: string;
  /** ⚠️ The DOCUMENT'S own date, not the decision's. `YYYY-MM-DD`. */
  documentDate: string;
  lines: readonly TaxDecisionLine[];
  placeOfSupply: {
    code: string | null;
    basis: PlaceOfSupplyBasis | null;
    statutoryRef: string | null;
    /** The facts that made the rule apply, in the tenant's own words. */
    explanation: string | null;
  };
  /** Defaults to `TAX_ENGINE_VERSION`. Pass it when replaying an import. */
  engineVersion?: string;
  /** A user id, a job name, `import:tally`, `manual-override:<user>`. */
  decidedBy: string | null;
};

export class TaxDecisionRefused extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(" "));
    this.name = "TaxDecisionRefused";
    this.reasons = reasons;
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ WRITING THE TRAIL                                                 */
/* ------------------------------------------------------------------ */

/**
 * Record why each line of a document was taxed the way it was.
 *
 * ⭐ UPSERT ON `(tenant_id, document_table, document_line_id)`, WHICH IS
 * 0150's `tax_decisions_one_per_line`. A second row for one line is not a
 * second opinion — it is an ambiguity, and an auditor reading two
 * decisions for one line cannot tell which one the document was raised
 * under. A revised decision REPLACES its predecessor, and the previous
 * version stays recoverable from `change_log`, which 0150 §4 attaches.
 *
 * ⚠️ IT DOES NOT OPEN ITS OWN TRANSACTION SEPARATELY FROM THE DOCUMENT
 * WHERE IT CAN AVOID IT. `tx` is optional precisely so a caller writing
 * the invoice can pass its own transaction and have the trail commit or
 * roll back WITH the document. A trail written in a second transaction
 * survives a rolled-back invoice and describes reasoning behind a
 * document that does not exist.
 *
 * ⚠️ THROWS on a refusal rather than returning a result envelope. The
 * caller is inside a document write; a trail that quietly failed would
 * leave the document with no reasoning and nothing on screen to say so,
 * which is the exact shape of the defect this table exists to remove.
 */
export async function recordTaxDecisions(
  tenantId: string,
  input: RecordTaxDecisionsInput,
  tx?: TaxDecisionExecutor,
): Promise<number> {
  if (input.lines.length === 0) return 0;

  const problems = validateTaxDecisions(input.lines);
  if (problems.length > 0) throw new TaxDecisionRefused(problems);

  const engineVersion = input.engineVersion ?? TAX_ENGINE_VERSION;

  /**
   * ⚠️ ONE STATEMENT, NOT ONE PER LINE. A per-line loop against Neon is a
   * round trip per line, and on a 60-line construction invoice that is
   * sixty network hops inside a transaction holding a connection. It is
   * also not atomic in any useful sense if the caller did not pass a `tx`.
   */
  const rows = input.lines.map(
    (line) => sql`(
      ${tenantId}::uuid,
      ${input.documentTable},
      ${line.documentLineId}::uuid,
      ${input.documentId}::uuid,
      ${line.lineNo},
      ${input.documentDate}::date,
      ${input.placeOfSupply.code},
      ${input.placeOfSupply.basis},
      ${input.placeOfSupply.statutoryRef},
      ${input.placeOfSupply.explanation},
      ${line.hsnSacCode},
      ${line.hsnSacRateId}::uuid,
      ${line.rateBps},
      ${line.cessRateBps},
      ${line.notificationRef},
      ${line.rateEffectiveFrom}::date,
      ${line.rateEffectiveTo}::date,
      ${line.taxKind},
      ${line.isReverseCharge},
      ${line.reverseChargeBasis},
      ${line.taxableValueMinor.toString()}::bigint,
      ${line.cgstMinor.toString()}::bigint,
      ${line.sgstMinor.toString()}::bigint,
      ${line.igstMinor.toString()}::bigint,
      ${line.cessMinor.toString()}::bigint,
      ${engineVersion},
      ${input.decidedBy}
    )`,
  );

  /**
   * ⚠️ `bigint` IS SENT AS A STRING AND CAST, NOT INTERPOLATED AS A
   * JAVASCRIPT NUMBER. A paise figure above 2^53 silently loses precision
   * through `Number`, and `pg` will not serialise a native bigint
   * parameter. `.toString()` + `::bigint` is exact for every value the
   * column can hold.
   */
  const statement = sql`
    INSERT INTO tax_decisions (
      tenant_id, document_table, document_line_id, document_id, line_no,
      document_date,
      place_of_supply_code, place_of_supply_basis, statutory_ref,
      place_of_supply_explanation,
      hsn_sac_code, hsn_sac_rate_id, rate_bps, cess_rate_bps,
      notification_ref, rate_effective_from, rate_effective_to,
      tax_kind, is_reverse_charge, reverse_charge_basis,
      taxable_value_minor, cgst_minor, sgst_minor, igst_minor, cess_minor,
      engine_version, decided_by
    )
    VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (tenant_id, document_table, document_line_id)
    DO UPDATE SET
      document_id                 = EXCLUDED.document_id,
      line_no                     = EXCLUDED.line_no,
      document_date               = EXCLUDED.document_date,
      place_of_supply_code        = EXCLUDED.place_of_supply_code,
      place_of_supply_basis       = EXCLUDED.place_of_supply_basis,
      statutory_ref               = EXCLUDED.statutory_ref,
      place_of_supply_explanation = EXCLUDED.place_of_supply_explanation,
      hsn_sac_code                = EXCLUDED.hsn_sac_code,
      hsn_sac_rate_id             = EXCLUDED.hsn_sac_rate_id,
      rate_bps                    = EXCLUDED.rate_bps,
      cess_rate_bps               = EXCLUDED.cess_rate_bps,
      notification_ref            = EXCLUDED.notification_ref,
      rate_effective_from         = EXCLUDED.rate_effective_from,
      rate_effective_to           = EXCLUDED.rate_effective_to,
      tax_kind                    = EXCLUDED.tax_kind,
      is_reverse_charge           = EXCLUDED.is_reverse_charge,
      reverse_charge_basis        = EXCLUDED.reverse_charge_basis,
      taxable_value_minor         = EXCLUDED.taxable_value_minor,
      cgst_minor                  = EXCLUDED.cgst_minor,
      sgst_minor                  = EXCLUDED.sgst_minor,
      igst_minor                  = EXCLUDED.igst_minor,
      cess_minor                  = EXCLUDED.cess_minor,
      engine_version              = EXCLUDED.engine_version,
      decided_by                  = EXCLUDED.decided_by,
      updated_at                  = now()
  `;

  if (tx) {
    await tx.execute(statement);
    return input.lines.length;
  }

  await withTenant(tenantId, async (scoped) => scoped.execute(statement));
  return input.lines.length;
}

/**
 * ⭐ SAY IT IN A SENTENCE BEFORE THE TRIGGER SAYS IT IN AN EXCEPTION.
 *
 * 0150 §3 refuses any row whose money does not recompute from its own
 * taxable value, rate and `tax_kind`, using SQL 0147's primitives. That
 * guarantee is the only reason the table is safe to believe, and it is
 * kept — this function does not weaken it, it front-runs it, so a caller
 * gets a diagnosis rather than `ERRCODE 23514`.
 *
 * 🔴 AND IT CATCHES ONE CASE THE ENGINE CAN PRODUCE AND THE TABLE CANNOT
 * HOLD: A SPECIFIC (PER-UNIT) CESS.
 *
 * `hsn_sac_rates.cess_per_unit_minor` is real and `lib/gst/tax.ts` charges
 * it — coal is ₹400 a tonne whatever it costs. `tax_decisions` mirrors the
 * line tables' columns and has only `cess_rate_bps`, so a line carrying a
 * specific cess cannot be represented, and 0150 §3's recompute check will
 * refuse it. That gap is real, is recorded in 0147 §A and 0150 §6, and is
 * NOT papered over here by silently writing the ad-valorem part: a
 * decision log that quietly drops a component of the tax is a second copy
 * of the numbers with nobody checking it. It is refused, loudly, naming
 * the line.
 */
export function validateTaxDecisions(lines: readonly TaxDecisionLine[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (seen.has(line.documentLineId)) {
      problems.push(
        `Line ${line.documentLineId} appears twice in this batch. ` +
          `\`tax_decisions_one_per_line\` allows one current decision per line, ` +
          `so the second would overwrite the first inside a single statement and ` +
          `the surviving row would be decided by an ordering nobody chose.`,
      );
    }
    seen.add(line.documentLineId);

    const expectedTax = applyRateBps(line.taxableValueMinor, line.rateBps);
    const expectedCess = applyRateBps(line.taxableValueMinor, line.cessRateBps);

    const actualTax =
      line.taxKind === "igst"
        ? line.igstMinor
        : line.cgstMinor + line.sgstMinor;

    if (line.taxKind === "igst" && (line.cgstMinor !== 0n || line.sgstMinor !== 0n)) {
      problems.push(
        `Line ${line.lineNo ?? line.documentLineId} is recorded as an IGST supply ` +
          `but carries CGST/SGST. A supply has one place of supply, so it is ` +
          `inter-state or intra-state — never both.`,
      );
    }
    if (line.taxKind !== "igst" && line.igstMinor !== 0n) {
      problems.push(
        `Line ${line.lineNo ?? line.documentLineId} is recorded as a ${line.taxKind} ` +
          `supply but carries IGST. The recipient cannot claim it and the supplier ` +
          `will pay CGST and SGST again on the same supply.`,
      );
    }

    if (actualTax !== expectedTax) {
      problems.push(
        `Line ${line.lineNo ?? line.documentLineId} does not recompute: ` +
          `${line.taxableValueMinor} paise at ${line.rateBps} bps is ` +
          `${expectedTax} paise of tax, and the decision records ${actualTax}.`,
      );
    }

    if (line.cessMinor !== expectedCess) {
      problems.push(
        `Line ${line.lineNo ?? line.documentLineId} records ${line.cessMinor} paise ` +
          `of cess where ${line.cessRateBps} bps on ${line.taxableValueMinor} paise ` +
          `is ${expectedCess}. ⚠️ If this line carries a SPECIFIC (per-unit) cess, ` +
          `\`tax_decisions\` cannot represent it — the table mirrors the line ` +
          `tables and they have only an ad-valorem cess rate column. Recording the ` +
          `ad-valorem part alone would be a trail that disagrees with the document ` +
          `it is meant to explain, so it is refused. See SQL 0147 §A and 0150 §6.`,
      );
    }

    if (
      line.rateEffectiveFrom !== null &&
      line.rateEffectiveTo !== null &&
      line.rateEffectiveTo <= line.rateEffectiveFrom
    ) {
      problems.push(
        `Line ${line.lineNo ?? line.documentLineId} cites a rate period running ` +
          `${line.rateEffectiveFrom} → ${line.rateEffectiveTo}, which applies for no ` +
          `days at all. The end date is exclusive: a period ends on the day its ` +
          `successor begins.`,
      );
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* READING IT BACK, FOR A HUMAN                                        */
/* ------------------------------------------------------------------ */

/**
 * What the screen shows when somebody asks "why was this taxed like
 * that?" — the question the table exists to answer.
 *
 * ⭐ THE RATE'S EFFECTIVE PERIOD AND THE NOTIFICATION REFERENCE ARE PART
 * OF THE ANSWER, NOT METADATA. "18%" is a number; "18% under Notification
 * 11/2017-Central Tax (Rate) Sl. No. 3(ii), in force from 2019-04-01 and
 * still current" is a citation an officer can look up and disagree with,
 * which is the entire point of writing it down.
 */
export type TaxDecisionView = {
  id: string;
  documentTable: string;
  documentId: string;
  documentLineId: string;
  lineNo: number | null;
  documentDate: string;
  decidedAt: string;

  /** WHICH PLACE OF SUPPLY, AND UNDER WHICH SUB-SECTION. */
  placeOfSupply: {
    code: string | null;
    basis: string | null;
    statutoryRef: string | null;
    explanation: string | null;
  };

  /** WHICH RATE, FROM WHERE. */
  rate: {
    hsnSacCode: string | null;
    hsnSacRateId: string | null;
    rateBps: number;
    cessRateBps: number;
    notificationRef: string | null;
    /** ⚠️ `null` on `effectiveTo` means "still current", not "unknown". */
    effectiveFrom: string | null;
    effectiveTo: string | null;
  };

  /** HOW IT WAS TREATED. */
  treatment: {
    taxKind: string;
    isReverseCharge: boolean;
    reverseChargeBasis: string | null;
  };

  /** THE MONEY. */
  money: {
    taxableValueMinor: bigint;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    cessMinor: bigint;
    /** Convenience: the heads summed. Not a stored column. */
    totalTaxMinor: bigint;
  };

  /** WHO DECIDED. */
  decidedBy: string | null;
  engineVersion: string;
};

/**
 * Every decision behind one document, in line order.
 *
 * ⚠️ ORDERED BY `line_no` WITH NULLS LAST AND THEN BY `document_line_id`.
 * An unordered read renders the working papers in whatever order the heap
 * hands them back, which changes between two loads of the same page and
 * makes a printed copy impossible to compare with a screen.
 */
export async function getTaxDecisionsForDocument(
  tenantId: string,
  args: { documentTable: TaxDecisionDocumentTable; documentId: string },
): Promise<TaxDecisionView[]> {
  // A Drizzle table object for `tax_decisions` is requested in
  // PATCH-REQUEST-E.md; until it lands this read is hand-written SQL.
  const result = await withTenant(tenantId, async (tx) =>
    tx.execute(sql`
      SELECT
        id::text                      AS id,
        document_table                AS document_table,
        document_id::text             AS document_id,
        document_line_id::text        AS document_line_id,
        line_no                       AS line_no,
        document_date::text           AS document_date,
        decided_at::text              AS decided_at,
        place_of_supply_code          AS place_of_supply_code,
        place_of_supply_basis         AS place_of_supply_basis,
        statutory_ref                 AS statutory_ref,
        place_of_supply_explanation   AS place_of_supply_explanation,
        hsn_sac_code                  AS hsn_sac_code,
        hsn_sac_rate_id::text         AS hsn_sac_rate_id,
        rate_bps                      AS rate_bps,
        cess_rate_bps                 AS cess_rate_bps,
        notification_ref              AS notification_ref,
        rate_effective_from::text     AS rate_effective_from,
        rate_effective_to::text       AS rate_effective_to,
        tax_kind                      AS tax_kind,
        is_reverse_charge             AS is_reverse_charge,
        reverse_charge_basis          AS reverse_charge_basis,
        taxable_value_minor::text     AS taxable_value_minor,
        cgst_minor::text              AS cgst_minor,
        sgst_minor::text              AS sgst_minor,
        igst_minor::text              AS igst_minor,
        cess_minor::text              AS cess_minor,
        engine_version                AS engine_version,
        decided_by                    AS decided_by
      FROM tax_decisions
      WHERE document_table = ${args.documentTable}
        AND document_id = ${args.documentId}::uuid
      ORDER BY line_no ASC NULLS LAST, document_line_id ASC
    `),
  );

  return extractRows(result).map(toDecisionView);
}

/**
 * Every decision in a period, for the assessment that asks for one.
 *
 * ⚠️ HALF-OPEN, `[from, to)`, matching `lib/gst/rates.ts` and every other
 * dated window in this codebase. Both ends inclusive makes the last day
 * belong to two quarters, and every quarter boundary in India is a day
 * somebody raised invoices.
 */
export async function getTaxDecisionsInPeriod(
  tenantId: string,
  args: { from: string; to: string; limit?: number },
): Promise<TaxDecisionView[]> {
  // See PATCH-REQUEST-E.md: `tax_decisions` has no Drizzle table object.
  const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? 500)), 5000);

  const result = await withTenant(tenantId, async (tx) =>
    tx.execute(sql`
      SELECT
        id::text                      AS id,
        document_table                AS document_table,
        document_id::text             AS document_id,
        document_line_id::text        AS document_line_id,
        line_no                       AS line_no,
        document_date::text           AS document_date,
        decided_at::text              AS decided_at,
        place_of_supply_code          AS place_of_supply_code,
        place_of_supply_basis         AS place_of_supply_basis,
        statutory_ref                 AS statutory_ref,
        place_of_supply_explanation   AS place_of_supply_explanation,
        hsn_sac_code                  AS hsn_sac_code,
        hsn_sac_rate_id::text         AS hsn_sac_rate_id,
        rate_bps                      AS rate_bps,
        cess_rate_bps                 AS cess_rate_bps,
        notification_ref              AS notification_ref,
        rate_effective_from::text     AS rate_effective_from,
        rate_effective_to::text       AS rate_effective_to,
        tax_kind                      AS tax_kind,
        is_reverse_charge             AS is_reverse_charge,
        reverse_charge_basis          AS reverse_charge_basis,
        taxable_value_minor::text     AS taxable_value_minor,
        cgst_minor::text              AS cgst_minor,
        sgst_minor::text              AS sgst_minor,
        igst_minor::text              AS igst_minor,
        cess_minor::text              AS cess_minor,
        engine_version                AS engine_version,
        decided_by                    AS decided_by
      FROM tax_decisions
      WHERE document_date >= ${args.from}::date
        AND document_date <  ${args.to}::date
      ORDER BY document_date ASC, document_id ASC, line_no ASC NULLS LAST
      LIMIT ${limit}
    `),
  );

  return extractRows(result).map(toDecisionView);
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

/**
 * The narrow slice of a Drizzle transaction this module needs, so a
 * caller can pass its own `tx` without this file importing a transaction
 * type it would then have to keep in step. `server/sales/references.ts`
 * takes the same approach for the same reason.
 */
export type TaxDecisionExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

/**
 * ⚠️ TWO DRIVER SHAPES, AND INDEXING `[0]` DIRECTLY IS WRONG ON ONE OF
 * THEM. `neon-http` returns a bare array; the pooled serverless driver
 * returns `{ rows }`. `server/platform/rls-posture.ts` carries the same
 * note — there, getting it wrong turned an answer into "unknown"; here it
 * would turn a full audit trail into an empty one, which reads as "no
 * decision was recorded".
 */
function extractRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function asInt(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function toDecisionView(row: Record<string, unknown>): TaxDecisionView {
  const taxable = toBigIntAmount(asText(row.taxable_value_minor));
  const cgst = toBigIntAmount(asText(row.cgst_minor));
  const sgst = toBigIntAmount(asText(row.sgst_minor));
  const igst = toBigIntAmount(asText(row.igst_minor));
  const cess = toBigIntAmount(asText(row.cess_minor));

  return {
    id: asText(row.id) ?? "",
    documentTable: asText(row.document_table) ?? "",
    documentId: asText(row.document_id) ?? "",
    documentLineId: asText(row.document_line_id) ?? "",
    lineNo: row.line_no === null || row.line_no === undefined ? null : asInt(row.line_no),
    documentDate: (asText(row.document_date) ?? "").slice(0, 10),
    decidedAt: asText(row.decided_at) ?? "",
    placeOfSupply: {
      code: asText(row.place_of_supply_code),
      basis: asText(row.place_of_supply_basis),
      statutoryRef: asText(row.statutory_ref),
      explanation: asText(row.place_of_supply_explanation),
    },
    rate: {
      hsnSacCode: asText(row.hsn_sac_code),
      hsnSacRateId: asText(row.hsn_sac_rate_id),
      rateBps: asInt(row.rate_bps),
      cessRateBps: asInt(row.cess_rate_bps),
      notificationRef: asText(row.notification_ref),
      effectiveFrom: asText(row.rate_effective_from)?.slice(0, 10) ?? null,
      effectiveTo: asText(row.rate_effective_to)?.slice(0, 10) ?? null,
    },
    treatment: {
      taxKind: asText(row.tax_kind) ?? "",
      isReverseCharge: row.is_reverse_charge === true || row.is_reverse_charge === "t",
      reverseChargeBasis: asText(row.reverse_charge_basis),
    },
    money: {
      taxableValueMinor: taxable,
      cgstMinor: cgst,
      sgstMinor: sgst,
      igstMinor: igst,
      cessMinor: cess,
      totalTaxMinor: cgst + sgst + igst + cess,
    },
    decidedBy: asText(row.decided_by),
    engineVersion: asText(row.engine_version) ?? "",
  };
}
