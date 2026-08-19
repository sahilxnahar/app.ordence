/**
 * Ordence — ⭐⭐⭐ ERASURE, AND THE LAWS THAT REFUSE IT
 * Version: v1.68.0-alpha
 *
 * Pure. Produces a PLAN and a REFUSAL NOTICE. Deletes nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A PERSON'S RIGHT TO ERASURE DOES NOT DELETE A TAX INVOICE
 * ══════════════════════════════════════════════════════════════════════
 * DPDPA s.8(7) requires erasure "unless retention is necessary for
 * compliance with any law for the time being in force". Almost every row
 * in an ERP is inside one of those laws. So the interesting output of an
 * erasure is not what was deleted — it is the LIST OF REFUSALS, each
 * naming the provision that required it, in language the person can take
 * to a lawyer.
 *
 * ⚠️ AND THE REFUSAL MUST BE TRUE. "Our policy requires it" is not the
 * exception s.8(7) grants. Neither is a section that does not say what
 * it is claimed to say — which is why `retention.ts` carries a list of
 * provisions that CANNOT support a refusal, and why two of them were in
 * the brief for this batch as though they were periods.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SHAPE OF THE ANSWER
 * ══════════════════════════════════════════════════════════════════════
 * Erase the CONTACTABLE IDENTITY. Retain the STATUTORY RECORD. Say which
 * rule held which table back. A person who asks to be forgotten by a
 * builder should stop receiving demand notices; they should not thereby
 * cause the builder to lose the books an inspector can demand for eight
 * more financial years.
 *
 * 🔴 AND THE PLAN NEVER EXECUTES ITSELF. `server/dpdp/erasure-service.ts`
 * runs it, after a person has read it. An erasure is the one operation
 * in this product with no undo — `lib/backup/recoverable.ts` covers a
 * soft delete and this is not one — so the plan is a document first and
 * an instruction second.
 */

import { CLASSIFICATION, classificationFor, type TableClassification } from "./classification";
import {
  RETENTION_RULES,
  decide,
  type ErasureAction,
  type RetentionRule,
  type RetentionVerdict,
} from "./retention";
import type { ExportPlan, TablePlan } from "./subject-graph";

/* ------------------------------------------------------------------ */

export type ErasureTablePlan = {
  table: string;
  action: ErasureAction;
  /** Which rows. Reuses the export's predicates: the same person, found the same way. */
  predicates: TablePlan["predicates"];
  /** ⭐ Populated on every `retain`, `redact` and `refer`. Never on a bare `delete`. */
  rule: RetentionRule | null;
  /** One sentence, shown to the operator and quotable to the principal. */
  because: string;
  /**
   * 🔴 TRUE WHERE THE PLAN COULD NOT EVEN LOOK. Separate from `action`
   * because "we erased nothing here because there was nothing" and "we
   * erased nothing here because we cannot search it" are not the same
   * statement and only one of them is an admission.
   */
  couldNotSearch: boolean;
};

export type ErasurePlan = {
  tables: readonly ErasureTablePlan[];
  /**
   * ⭐ THE DOCUMENT. Every distinct rule that refused something, once,
   * with the tables it held back. This is what goes in the letter.
   */
  refusals: readonly {
    rule: RetentionRule;
    tables: readonly string[];
    /** ⚠️ Present where a person, not a law, has to decide. */
    needsAHuman: boolean;
  }[];
  summary: {
    deleted: number;
    redacted: number;
    retained: number;
    referred: number;
    couldNotSearch: number;
  };
  /**
   * 🔴 TRUE WHERE ANYTHING AT ALL NEEDS A HUMAN. The service refuses to
   * run a plan with this set without an explicit per-table decision, so
   * an `unverified` rule can never be silently resolved in either
   * direction.
   */
  blocked: boolean;
};

/* ------------------------------------------------------------------ */

/**
 * ⚠️ `redactable` IS OPT-IN PER TABLE AND ALMOST NOTHING SETS IT.
 *
 * The tempting move is to redact everywhere: blank the name, keep the
 * row, satisfy both duties. It does not work. A tax invoice without the
 * recipient's name and address is not a tax invoice — CGST Rule 46 lists
 * both as required particulars — so redacting them destroys the very
 * record s.36 orders retained, and does it in a way that looks like
 * compliance from both directions.
 *
 * ⭐ Where it DOES work is a marketing or contact-preference row whose
 * statutory value is the fact of the transaction, not the identity.
 */
function tableIsRedactable(entry: TableClassification): boolean {
  return entry.redactable === true;
}

export function buildErasurePlan(args: {
  exportPlan: ExportPlan;
  /**
   * ⭐ Tables whose statutory clock has demonstrably run out, decided by
   * the caller against real dates. Empty is the safe default: an unknown
   * clock is treated as still running, which over-retains rather than
   * over-deletes.
   */
  expiredFor?: ReadonlySet<string>;
  /** Tables under a human-placed legal hold. */
  heldFor?: ReadonlySet<string>;
}): ErasurePlan {
  const expired = args.expiredFor ?? new Set<string>();
  const held = args.heldFor ?? new Set<string>();

  const tables: ErasureTablePlan[] = [];

  for (const t of args.exportPlan.tables) {
    /** A table with no personal data is not part of an erasure at all. */
    if (t.verdict === "skip") continue;

    /**
     * 🔴 AND NEITHER IS ONE OF ORDENCE'S OWN. The export plan has
     * already marked these `out-of-scope`; skipping them here as well is
     * deliberate belt-and-braces on the operation that has no undo.
     */
    if (t.verdict === "out-of-scope") continue;

    /**
     * ⚠️ LOOKED UP THROUGH `classificationFor`, NOT A LOCAL MAP.
     * A second index over the same array is a second thing to keep in
     * step, and the erasure planner is the wrong place to discover it
     * has drifted.
     */
    const entry = classificationFor(t.table);
    if (!entry) continue;

    /**
     * 🔴 A TABLE WE CANNOT SEARCH IS NOT A TABLE WITH NOTHING IN IT.
     *
     * `automation_events` holds the changed row in `payload` and no
     * reach finds it. Reporting that as "erased: 0 rows" alongside every
     * genuinely empty table would bury the one entry that matters. It
     * gets its own flag, it is counted separately, and the refusal
     * notice names it.
     */
    if (t.verdict === "no-reach") {
      tables.push({
        table: t.table,
        action: "refer",
        predicates: [],
        rule: null,
        because:
          `${t.table} holds personal data and nothing in this product can find this person's rows in it, ` +
          `so nothing here was erased and we cannot say whether there was anything to erase. ` +
          `This is a gap in Ordence, not a legal refusal.`,
        couldNotSearch: true,
      });
      continue;
    }

    /**
     * ⚠️ `not-applicable` IS A LEGITIMATE ZERO. The person has no record
     * of that kind, so there is nothing to erase and nothing to admit.
     */
    if (t.verdict === "not-applicable") continue;

    const verdict: RetentionVerdict = decide({
      ruleId: entry.retention,
      periodExpired: expired.has(t.table),
      legalHold: held.has(t.table),
      redactable: tableIsRedactable(entry),
    });

    tables.push({
      table: t.table,
      action: verdict.action,
      predicates: t.predicates,
      rule: verdict.rule,
      because: verdict.because,
      couldNotSearch: false,
    });
  }

  /* --- the document -------------------------------------------------- */

  const grouped = new Map<string, { rule: RetentionRule; tables: string[]; needsAHuman: boolean }>();
  for (const t of tables) {
    if (!t.rule) continue;
    if (t.action === "delete") continue;
    const g = grouped.get(t.rule.id);
    if (g) {
      g.tables.push(t.table);
      g.needsAHuman ||= t.action === "refer";
    } else {
      grouped.set(t.rule.id, {
        rule: t.rule,
        tables: [t.table],
        needsAHuman: t.action === "refer",
      });
    }
  }

  const summary = {
    deleted: tables.filter((t) => t.action === "delete").length,
    redacted: tables.filter((t) => t.action === "redact").length,
    retained: tables.filter((t) => t.action === "retain").length,
    referred: tables.filter((t) => t.action === "refer").length,
    couldNotSearch: tables.filter((t) => t.couldNotSearch).length,
  };

  return {
    tables,
    refusals: [...grouped.values()],
    summary,
    blocked: summary.referred > 0,
  };
}

/* ------------------------------------------------------------------ */
/* THE LETTER                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE ARTEFACT THE DATA FIDUCIARY SENDS.
 *
 * Plain text, because it will be pasted into an email by somebody who is
 * not a developer, and because a person disputing a refusal needs to be
 * able to quote it.
 *
 * 🔴 IT NAMES EVERY REFUSAL AND EVERY GAP. A letter that listed only
 * what was deleted would be a letter that reads as full compliance while
 * the majority of the person's data is still on file — which is, under
 * s.8(7), a materially misleading statement about a statutory right.
 */
export function refusalNotice(args: {
  plan: ErasurePlan;
  workspaceName: string;
  principalLabel: string;
  requestReference: string;
  /** ISO date. Passed in — this file has no clock. */
  onDate: string;
}): string {
  const { plan } = args;
  const out: string[] = [];

  out.push(`${args.workspaceName} — response to a request for erasure of personal data`);
  out.push(`Request ${args.requestReference}. ${args.onDate}.`);
  out.push("");
  out.push(`This concerns the personal data held by ${args.workspaceName} about ${args.principalLabel}.`);
  out.push("");
  out.push(
    "Section 8(7) of the Digital Personal Data Protection Act 2023 requires a Data Fiduciary to erase " +
      "personal data on withdrawal of consent or when the purpose is no longer served, unless retention " +
      "is necessary for compliance with a law in force. Where anything below has been kept, the provision " +
      "requiring it is named so that you can check it.",
  );
  out.push("");

  const deleted = plan.tables.filter((t) => t.action === "delete").map((t) => t.table);
  const redacted = plan.tables.filter((t) => t.action === "redact").map((t) => t.table);

  out.push("WHAT WAS ERASED");
  if (deleted.length === 0 && redacted.length === 0) {
    out.push("  Nothing. Every record found is held back by one of the provisions below.");
  } else {
    if (deleted.length > 0) out.push(`  ${deleted.length} record set(s) deleted outright: ${deleted.join(", ")}.`);
    if (redacted.length > 0)
      out.push(
        `  ${redacted.length} record set(s) had the contactable identity removed while the underlying ` +
          `record was retained: ${redacted.join(", ")}.`,
      );
  }
  out.push("");

  out.push("WHAT WAS RETAINED, AND UNDER WHICH PROVISION");
  if (plan.refusals.length === 0) {
    out.push("  Nothing was retained.");
  } else {
    for (const r of plan.refusals) {
      out.push("");
      out.push(`  ${r.rule.provision}`);
      out.push(`    Period:  ${r.rule.period}`);
      out.push(`    Runs from: ${r.rule.clock}`);
      out.push(`    Records: ${r.tables.join(", ")}`);
      out.push(`    ${r.rule.toThePrincipal}`);
      if (r.rule.caveat) out.push(`    Note: ${r.rule.caveat}`);
      if (r.needsAHuman)
        out.push(
          "    ⚠️ This provision has NOT been confirmed against its current text and no automatic " +
            "decision has been taken on the records above. They have not been erased and they have not " +
            "been treated as exempt.",
        );
    }
  }
  out.push("");

  /**
   * ⚠️ THE SECTION MOST DOCUMENTS LIKE THIS DO NOT HAVE.
   */
  const gaps = plan.tables.filter((t) => t.couldNotSearch);
  if (gaps.length > 0) {
    out.push("WHERE WE COULD NOT LOOK");
    out.push(
      "  The following records may hold personal data about you and our systems cannot identify which " +
        "rows are yours. Nothing was erased there and we are not able to tell you whether there was " +
        "anything to erase.",
    );
    for (const g of gaps) out.push(`    ${g.table} — ${g.because}`);
    out.push("");
  }

  out.push(
    "If you believe a provision cited above does not apply to your records, you may say so in reply and " +
      "we will re-examine it. You may also complain to the Data Protection Board of India.",
  );

  return out.join("\n");
}

/**
 * ⭐ Every rule the inventory can possibly cite, for the settings screen
 * that shows a workspace what will and will not be erased BEFORE anybody
 * asks. A retention policy nobody can read before they need it is a
 * retention policy that surprises somebody on the day it matters.
 */
export function citableRules(): RetentionRule[] {
  const used = new Set(
    CLASSIFICATION.map((c) => c.retention).filter(
      (r): r is NonNullable<TableClassification["retention"]> => r !== null,
    ),
  );
  return [...used].map((id) => RETENTION_RULES[id]);
}
