/**
 * Ordence — ⭐ Reconciling Our Books Against Theirs
 * Version: v0.37.0-alpha
 *
 * Pure and isomorphic.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS PRODUCES A REPORT. IT NEVER WRITES TO OUR LEDGER.
 * ══════════════════════════════════════════════════════════════════════
 * The feature everybody asks for next is "sync back", and it is the wrong
 * feature for three separate reasons:
 *
 *   • Our ledger is APPEND-ONLY and balance-enforced at the database
 *     (Phase 4). Their file is a snapshot of a book anyone with the Tally
 *     password can edit, retrospectively, including inside a period we
 *     have closed.
 *   • ⭐ THE TWO ARE NOT SUPPOSED TO AGREE. The accountant posts
 *     depreciation, provisions, prepayment reversals and audit
 *     adjustments directly in Tally, deliberately, because that is where
 *     the statutory accounts are prepared. Pulling those in would put
 *     entries in our books that no user made and no document supports.
 *   • And "overwrite" against an append-only ledger is not implementable
 *     without posting reversals, which is a decision a person makes with
 *     a reason.
 *
 * So the output is a list of differences, each with both sides on it and
 * a sentence a person can act on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE MATCH IS ON REMOTEID FIRST, AND ONLY THEN ON ANYTHING ELSE
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ MATCHING ON VOUCHER NUMBER IS THE TRAP. Tally renumbers on import
 * when the company has automatic numbering switched on — which is the
 * default — so the voucher we sent as AH/2026/0041 is 1247 in their
 * books. A number-first match reports every voucher as missing on both
 * sides, produces a report of four hundred findings, and is ignored
 * within a week.
 *
 * The REMOTEID survives the renumbering because Tally stores it verbatim.
 * That is the whole reason for `lib/tally/keys.ts`.
 */

import { formatTallyAmount } from "./amounts";
import { isOurRemoteId } from "./keys";
import type { ParsedTallyVoucher } from "./parse";
import type { TallyDiffKind } from "@/db/schema/tally";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

/** Our side, flattened out of `tally_vouchers`. */
export type OurVoucherFacts = {
  id: string;
  remoteId: string;
  voucherType: string;
  voucherNumber: string | null;
  voucherDate: string;
  partyLedgerName: string | null;
  /** Paise. Debits and credits are equal by construction. */
  amountMinor: bigint;
  isCancelled: boolean;
};

export type ReconciliationDifference = {
  kind: TallyDiffKind;
  remoteId: string | null;

  ourVoucherId: string | null;
  ourVoucherNumber: string | null;
  ourVoucherDate: string | null;
  ourVoucherType: string | null;
  ourAmountMinor: bigint | null;
  ourPartyLedgerName: string | null;

  theirVoucherNumber: string | null;
  theirVoucherDate: string | null;
  theirVoucherType: string | null;
  theirAmountMinor: bigint | null;
  theirPartyLedgerName: string | null;

  /** ⭐ The sentence. Stored on the row; see the schema. */
  explanation: string;
};

export type ReconciliationResult = {
  matchedCount: number;
  differences: ReconciliationDifference[];
  /** Roll-ups for the batch row, so a list page needs no aggregate. */
  theirTotalDebitMinor: bigint;
  theirTotalCreditMinor: bigint;
};

/* ------------------------------------------------------------------ */
/* ⭐ THE DIFF                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ TOLERANCE IS ZERO AND STAYS ZERO.
 *
 * Phase 34's GSTR-2B matching has a tolerance because two parties compute
 * a tax from a rounded taxable value and legitimately land a rupee apart.
 * That does not apply here: this is OUR voucher, exported by US, imported
 * verbatim. A one-paisa difference means somebody edited it in Tally or
 * our export rounded — and both of those are things to be told about, not
 * things to absorb.
 */
export function reconcileVouchers(
  ours: readonly OurVoucherFacts[],
  theirs: readonly ParsedTallyVoucher[],
): ReconciliationResult {
  const differences: ReconciliationDifference[] = [];
  let matchedCount = 0;
  let theirTotalDebitMinor = 0n;
  let theirTotalCreditMinor = 0n;

  /* --- Index their side by remote id. -------------------------- */

  const theirsByRemote = new Map<string, ParsedTallyVoucher[]>();
  const theirsWithoutRemote: ParsedTallyVoucher[] = [];

  for (const voucher of theirs) {
    theirTotalDebitMinor += voucher.totalDebitMinor;
    theirTotalCreditMinor += voucher.totalCreditMinor;

    const remote = voucher.remoteId?.trim();
    if (remote && isOurRemoteId(remote)) {
      theirsByRemote.set(remote, [...(theirsByRemote.get(remote) ?? []), voucher]);
    } else {
      theirsWithoutRemote.push(voucher);
    }
  }

  const claimed = new Set<ParsedTallyVoucher>();

  /* --- Our side, one at a time. -------------------------------- */

  for (const our of ours) {
    const candidates = theirsByRemote.get(our.remoteId) ?? [];

    if (candidates.length === 0) {
      differences.push({
        kind: "missing_in_tally",
        remoteId: our.remoteId,
        ourVoucherId: our.id,
        ourVoucherNumber: our.voucherNumber,
        ourVoucherDate: our.voucherDate,
        ourVoucherType: our.voucherType,
        ourAmountMinor: our.amountMinor,
        ourPartyLedgerName: our.partyLedgerName,
        theirVoucherNumber: null,
        theirVoucherDate: null,
        theirVoucherType: null,
        theirAmountMinor: null,
        theirPartyLedgerName: null,
        explanation:
          `We exported ${describeOurs(our)} and it is not in the Tally file. ` +
          `Either the export was never imported, or it was imported into a ` +
          `different company — the company name in the envelope decides that ` +
          `and does not fail when it is wrong.`,
      });
      continue;
    }

    /**
     * ⭐⭐ TWO OF THEIRS UNDER ONE OF OUR KEYS IS THE DOUBLE POST, CAUGHT.
     *
     * It should be impossible: Tally de-duplicates on REMOTEID. It happens
     * anyway when the same file is imported into a company that was later
     * restored from a backup, or when an old export made before this
     * phase's keys existed was imported alongside a new one. This is the
     * single most valuable finding the reconciliation produces, so it gets
     * its own kind rather than being reported as an amount difference.
     */
    if (candidates.length > 1) {
      const total = candidates.reduce((sum, c) => sum + c.totalDebitMinor, 0n);
      for (const candidate of candidates) claimed.add(candidate);
      differences.push({
        kind: "duplicate_in_tally",
        remoteId: our.remoteId,
        ourVoucherId: our.id,
        ourVoucherNumber: our.voucherNumber,
        ourVoucherDate: our.voucherDate,
        ourVoucherType: our.voucherType,
        ourAmountMinor: our.amountMinor,
        ourPartyLedgerName: our.partyLedgerName,
        theirVoucherNumber: candidates.map((c) => c.voucherNumber ?? "?").join(", "),
        theirVoucherDate: candidates[0]?.voucherDate ?? null,
        theirVoucherType: candidates[0]?.voucherType ?? null,
        theirAmountMinor: total,
        theirPartyLedgerName: candidates[0]?.partyLedgerName ?? null,
        explanation:
          `⚠️ ${candidates.length} vouchers in Tally carry the key of ` +
          `${describeOurs(our)}. This is the double post: ` +
          `${formatTallyAmount(our.amountMinor)} in our books against ` +
          `${formatTallyAmount(total)} in theirs. The extra copies must be ` +
          `cancelled in Tally — re-exporting will not remove them, because a ` +
          `re-export alters ONE voucher per key.`,
      });
      continue;
    }

    const their = candidates[0];
    if (!their) continue;
    claimed.add(their);

    const theirAmount =
      their.totalDebitMinor > 0n ? their.totalDebitMinor : their.totalCreditMinor;

    if (theirAmount !== our.amountMinor) {
      differences.push({
        kind: "amount_differs",
        remoteId: our.remoteId,
        ourVoucherId: our.id,
        ourVoucherNumber: our.voucherNumber,
        ourVoucherDate: our.voucherDate,
        ourVoucherType: our.voucherType,
        ourAmountMinor: our.amountMinor,
        ourPartyLedgerName: our.partyLedgerName,
        theirVoucherNumber: their.voucherNumber,
        theirVoucherDate: their.voucherDate,
        theirVoucherType: their.voucherType,
        theirAmountMinor: theirAmount,
        theirPartyLedgerName: their.partyLedgerName,
        explanation:
          `${describeOurs(our)} is ${formatTallyAmount(our.amountMinor)} here and ` +
          `${formatTallyAmount(theirAmount)} in Tally — a difference of ` +
          `${formatTallyAmount(absDiff(our.amountMinor, theirAmount))}. Somebody ` +
          `has edited it on one side. Our ledger is append-only, so the edit ` +
          `was made in Tally unless a correcting entry was posted here.`,
      });
      continue;
    }

    if (their.voucherDate && their.voucherDate !== our.voucherDate) {
      differences.push({
        kind: "date_differs",
        remoteId: our.remoteId,
        ourVoucherId: our.id,
        ourVoucherNumber: our.voucherNumber,
        ourVoucherDate: our.voucherDate,
        ourVoucherType: our.voucherType,
        ourAmountMinor: our.amountMinor,
        ourPartyLedgerName: our.partyLedgerName,
        theirVoucherNumber: their.voucherNumber,
        theirVoucherDate: their.voucherDate,
        theirVoucherType: their.voucherType,
        theirAmountMinor: theirAmount,
        theirPartyLedgerName: their.partyLedgerName,
        explanation:
          `${describeOurs(our)} is dated ${our.voucherDate} here and ` +
          `${their.voucherDate} in Tally. ⚠️ A voucher that has moved across a ` +
          `month end has moved between GST returns, and across 31 March it has ` +
          `moved between financial years.`,
      });
      continue;
    }

    if (
      our.partyLedgerName &&
      their.partyLedgerName &&
      our.partyLedgerName.trim().toLowerCase() !==
        their.partyLedgerName.trim().toLowerCase()
    ) {
      differences.push({
        kind: "party_differs",
        remoteId: our.remoteId,
        ourVoucherId: our.id,
        ourVoucherNumber: our.voucherNumber,
        ourVoucherDate: our.voucherDate,
        ourVoucherType: our.voucherType,
        ourAmountMinor: our.amountMinor,
        ourPartyLedgerName: our.partyLedgerName,
        theirVoucherNumber: their.voucherNumber,
        theirVoucherDate: their.voucherDate,
        theirVoucherType: their.voucherType,
        theirAmountMinor: theirAmount,
        theirPartyLedgerName: their.partyLedgerName,
        explanation:
          `${describeOurs(our)} is against "${our.partyLedgerName}" here and ` +
          `"${their.partyLedgerName}" in Tally. The mapping has been re-pointed ` +
          `since this was exported, or the ledger was renamed in Tally — either ` +
          `way the party's outstanding is now split across two ledgers.`,
      });
      continue;
    }

    matchedCount += 1;
  }

  /* --- ⭐ Their side, whatever we did not claim. ---------------- */

  for (const their of [...theirsWithoutRemote, ...unclaimed(theirsByRemote, claimed)]) {
    const theirAmount =
      their.totalDebitMinor > 0n ? their.totalDebitMinor : their.totalCreditMinor;
    differences.push({
      kind: "missing_in_ours",
      remoteId: their.remoteId && isOurRemoteId(their.remoteId) ? their.remoteId : null,
      ourVoucherId: null,
      ourVoucherNumber: null,
      ourVoucherDate: null,
      ourVoucherType: null,
      ourAmountMinor: null,
      ourPartyLedgerName: null,
      theirVoucherNumber: their.voucherNumber,
      theirVoucherDate: their.voucherDate,
      theirVoucherType: their.voucherType,
      theirAmountMinor: theirAmount,
      theirPartyLedgerName: their.partyLedgerName,
      explanation:
        `Tally has ${describeTheirs(their, theirAmount)} which did not come from ` +
        `here. ⚠️ THIS IS USUALLY CORRECT, not an error — depreciation, ` +
        `provisions, prepayments and audit adjustments are posted directly in ` +
        `Tally on purpose. Nothing is copied back; this is listed so it can be ` +
        `recognised rather than investigated twice.`,
    });
  }

  return {
    matchedCount,
    differences,
    theirTotalDebitMinor,
    theirTotalCreditMinor,
  };
}

function unclaimed(
  index: Map<string, ParsedTallyVoucher[]>,
  claimed: Set<ParsedTallyVoucher>,
): ParsedTallyVoucher[] {
  const left: ParsedTallyVoucher[] = [];
  for (const group of index.values()) {
    for (const voucher of group) {
      if (!claimed.has(voucher)) left.push(voucher);
    }
  }
  return left;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function describeOurs(our: OurVoucherFacts): string {
  const number = our.voucherNumber ? ` ${our.voucherNumber}` : "";
  return `${our.voucherType}${number} of ${our.voucherDate}`;
}

function describeTheirs(their: ParsedTallyVoucher, amount: bigint): string {
  const number = their.voucherNumber ? ` ${their.voucherNumber}` : "";
  const date = their.voucherDate ? ` dated ${their.voucherDate}` : "";
  return `a ${their.voucherType}${number}${date} for ${formatTallyAmount(amount)}`;
}

/* ------------------------------------------------------------------ */
/* SUMMARY                                                             */
/* ------------------------------------------------------------------ */

export type ReconciliationSummary = {
  matched: number;
  total: number;
  byKind: Record<string, number>;
  /**
   * ⭐ The differences that mean something is WRONG, as opposed to the
   * ones that mean the accountant did their job. `missing_in_ours` is
   * excluded, deliberately — see its comment in the schema.
   */
  actionableCount: number;
};

const NOT_ACTIONABLE: ReadonlySet<TallyDiffKind> = new Set(["missing_in_ours"]);

export function summariseReconciliation(
  result: ReconciliationResult,
): ReconciliationSummary {
  const byKind: Record<string, number> = {};
  let actionableCount = 0;

  for (const difference of result.differences) {
    byKind[difference.kind] = (byKind[difference.kind] ?? 0) + 1;
    if (!NOT_ACTIONABLE.has(difference.kind)) actionableCount += 1;
  }

  return {
    matched: result.matchedCount,
    total: result.differences.length,
    byKind,
    actionableCount,
  };
}
