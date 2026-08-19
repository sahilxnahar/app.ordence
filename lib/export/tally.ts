/**
 * Ordence — ⭐⭐ TALLY XML FROM A DATASET, AND THE DATASETS IT REFUSES
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 "EXPORT IN EVERY FORMAT" DOES NOT MEAN EVERY DATASET IN EVERY FORMAT
 * ══════════════════════════════════════════════════════════════════════
 * CSV, XLSX, JSON, PDF and DOCX are UNIVERSAL: any table can be rendered
 * in any of them and nothing is claimed about the meaning of the columns.
 * Tally XML is not that kind of format. It is an INSTRUCTION to another
 * accounting system, and a file that imports cleanly and posts to the
 * wrong ledger is worse than one that does not import at all — the second
 * is noticed the same day and the first is noticed at the audit.
 *
 * ⭐ SO THIS WRITER SUPPORTS EXACTLY WHAT IT CAN GET RIGHT:
 *
 *   ledger-master       a name and a parent group. A dataset genuinely
 *                       has both, and `lib/tally/ledgers.ts` already
 *                       knows the exact group strings Tally ships with.
 *
 *   vouchers-elsewhere  the dataset names the screen that produces the
 *                       real, balanced voucher export, and this writer
 *                       refuses with that sentence rather than inventing
 *                       a contra ledger.
 *
 *   (no mapping)        refused, naming the five formats that do work.
 *
 * ⚠️ AND `formatTallyAmount` IS RUPEES-ONLY BY DESIGN — Tally's `<AMOUNT>`
 * is the company's base currency at two decimals. A ledger denominated in
 * anything else is refused here rather than silently sent as if it were
 * rupees, which is the factor-of-ten class of error this codebase spent
 * `lib/fx/currency.ts` eliminating.
 */

import { buildImportEnvelope } from "@/lib/tally/envelope";
import { TALLY_PRIMARY_GROUPS, type LedgerMapping } from "@/lib/tally/ledgers";
import { formatTallyAmount } from "@/lib/tally/amounts";
import type { TallyLedgerGroup } from "@/db/schema/tally";
import type { Dataset } from "./types";
import { assertDatasetIsRenderable } from "./values";

export class TallyExportUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TallyExportUnavailable";
  }
}

/**
 * ⭐ WHY A DATASET CAN OR CANNOT GO TO TALLY, AS A SENTENCE THE PICKER
 * SHOWS BEFORE THE DOWNLOAD. `null` means it can.
 */
export function tallyRefusal(dataset: Dataset): string | null {
  const mapping = dataset.tally;
  if (!mapping) {
    return (
      `"${dataset.title}" has no Tally mapping. Tally XML is an instruction to another ` +
      `accounting system — it needs to know which ledger each row is and which group it belongs ` +
      `to — and this data does not carry that. Excel, CSV, JSON, PDF and Word all export it in ` +
      `full.`
    );
  }
  if (mapping.kind === "vouchers-elsewhere") {
    return (
      `Vouchers are exported from ${mapping.where}, not from here. That path builds each voucher ` +
      `from its actual ledger entries, so both sides are real and the voucher balances by ` +
      `construction. A voucher built from this grid would need a contra ledger nobody chose.`
    );
  }
  const hasLiteral = typeof mapping.parentGroup === "string";
  const hasColumn = typeof mapping.parentGroupKey === "string";
  if (hasLiteral === hasColumn) {
    return (
      `"${dataset.title}" declares ${hasLiteral ? "both a fixed Tally group and a group column" : "no Tally group at all"}. ` +
      `A ledger master needs exactly one source for its parent group.`
    );
  }
  if (hasLiteral && !(mapping.parentGroup! in TALLY_PRIMARY_GROUPS)) {
    return (
      `"${mapping.parentGroup}" is not one of Tally's primary groups. Creating a ledger under a ` +
      `group Tally does not ship with means Tally creates it under Primary, where none of its ` +
      `reports look.`
    );
  }
  if (hasColumn && !dataset.columns.some((c) => c.key === mapping.parentGroupKey)) {
    return (
      `"${dataset.title}" says its Tally group is in column "${mapping.parentGroupKey}", and that ` +
      `column is not in this data.`
    );
  }
  return null;
}

export function datasetToTallyXml(
  dataset: Dataset,
  args: { readonly companyName: string; readonly indent?: boolean },
): string {
  const refusal = tallyRefusal(dataset);
  if (refusal) throw new TallyExportUnavailable(refusal);
  assertDatasetIsRenderable(dataset);

  const mapping = dataset.tally as Extract<
    NonNullable<Dataset["tally"]>,
    { kind: "ledger-master" }
  >;

  const seen = new Set<string>();
  const masters: LedgerMapping[] = [];

  dataset.rows.forEach((row, index) => {
    const rawName = row[mapping.nameKey];
    if (typeof rawName !== "string" || rawName.trim() === "") {
      throw new TallyExportUnavailable(
        `Row ${index + 1} of "${dataset.title}" has no value in "${mapping.nameKey}". A Tally ` +
          `ledger is identified by its name; a blank one would create a ledger called nothing.`,
      );
    }
    const name = rawName.trim();

    /**
     * 🔴 TALLY MATCHES LEDGERS BY NAME, CASE-INSENSITIVELY, AND IT DOES
     * NOT MERGE. Two rows differing only in case create one ledger and
     * silently drop the second row's opening balance into it.
     */
    const fold = name.toLowerCase();
    if (seen.has(fold)) {
      throw new TallyExportUnavailable(
        `"${name}" appears more than once in "${dataset.title}". Tally matches ledgers by name ` +
          `without regard to case, so importing this file would merge them into one ledger and ` +
          `the second row's figures would be lost without a message. Resolve the duplicate first.`,
      );
    }
    seen.add(fold);

    if (mapping.currencyKey) {
      const currency = String(row[mapping.currencyKey] ?? "").trim().toUpperCase();
      if (currency && currency !== "INR") {
        throw new TallyExportUnavailable(
          `"${name}" is denominated in ${currency}. Tally's <AMOUNT> is the company's base ` +
            `currency at two decimal places, and sending a ${currency} figure as if it were rupees ` +
            `is wrong by whatever the exchange rate is. Export this ledger from the multi-currency ` +
            `report instead.`,
        );
      }
    }

    const gstin = mapping.gstinKey ? row[mapping.gstinKey] : null;

    /**
     * 🔴 THE GROUP IS READ, NEVER DERIVED. See `TallyMapping` in
     * `lib/export/types.ts` — a group inferred from an account type puts
     * a workspace's sales under the wrong Tally heading while every total
     * still balances, which is the class of error nobody finds until an
     * assessment.
     */
    const group = mapping.parentGroupKey
      ? String(row[mapping.parentGroupKey] ?? "").trim()
      : mapping.parentGroup!;

    if (!(group in TALLY_PRIMARY_GROUPS)) {
      throw new TallyExportUnavailable(
        `"${name}" is mapped to the Tally group "${group || "(blank)"}", which is not one Tally ` +
          `ships with. Tally would create it under Primary, where none of its reports look. Fix ` +
          `the mapping before exporting.`,
      );
    }

    masters.push({
      sourceKind: "ledger",
      sourceId: null,
      tallyLedgerName: name,
      tallyParentGroup: group as TallyLedgerGroup,
      isParty: mapping.isParty ?? false,
      partyGstin: typeof gstin === "string" && gstin.trim() !== "" ? gstin.trim() : null,
      createMasterOnExport: true,
    });
  });

  /**
   * ⚠️ THE OPENING BALANCE IS NOT SENT AS PART OF THE MASTER. It is
   * checked here — so an unreadable figure is refused rather than dropped
   * — and then deliberately left out, because a ledger master carrying an
   * opening balance re-imported over an existing ledger RESETS it. The
   * opening balances belong in a journal voucher dated the first day of
   * the year, which is `server/tally/exporter.ts`'s job.
   */
  if (mapping.openingBalanceKey) {
    for (const row of dataset.rows) {
      const raw = row[mapping.openingBalanceKey];
      if (raw === null || raw === undefined || raw === "") continue;
      const minor = typeof raw === "bigint" ? raw : BigInt(String(raw));
      formatTallyAmount(minor);
    }
  }

  return buildImportEnvelope({
    companyName: args.companyName,
    masters,
    vouchers: [],
    action: "Create",
    indent: args.indent ?? true,
  });
}

export function tallyBytes(xml: string): Uint8Array {
  return new TextEncoder().encode(xml);
}
