/**
 * Ordence — ⭐⭐ A TALLY XML EXPORT INTO THE SAME ROW STREAM
 * Version: v1.84.1-alpha · Phase 9 (was v1.74.0-alpha · Wave 6)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS IS A MIGRATION FRONT-END AND NOT PART OF THE INTEGRATION
 * ══════════════════════════════════════════════════════════════════════
 * `lib/tally/parse.ts` and `server/tally/*` are the LIVE INTEGRATION:
 * two systems both holding the books, reconciled against each other,
 * matched by remote id. That is an ongoing relationship.
 *
 * This is a MIGRATION: a workspace leaving Tally, once, whose accountant
 * has a `Daybook.xml` on their desktop. They do not want a reconciliation,
 * they want their masters and their opening figures in Ordence, and then
 * they want to never open Tally again.
 *
 * ⚠️ So this file reuses `parseTallyExport` — one XML reader, not two —
 * and turns the result into rows the ordinary import framework maps,
 * previews and commits, with the same natural keys, the same dry run and
 * the same partial-success report as a CSV.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IT DOES NOT DO, AND THIS IS THE IMPORTANT PART
 * ══════════════════════════════════════════════════════════════════════
 * It does NOT post the vouchers into the ledger. It flattens them to rows.
 *
 * A Tally day-book export is thousands of vouchers across years, and
 * replaying them as journal entries would mean reproducing another
 * system's posting decisions — its rounding, its tax heads, its
 * cancellations, its period locks — inside ours, and any disagreement
 * shows up as a trial balance that does not tie and no way to tell which
 * system is right.
 *
 * ⭐ THE CORRECT MIGRATION IS THE ONE `lib/import/opening.ts` ALREADY
 * IMPLEMENTS: bring the MASTERS across, then ONE opening trial balance
 * as at a stated date, which has to balance before it is allowed to
 * commit. History stays in Tally, where it is already audited.
 *
 * ⚠️ AND THE FILE SAYS SO. `readTally` returns that sentence as a note on
 * every voucher extraction, because a customer who believes their four
 * years of history came across and finds later that it did not is a
 * customer who cannot trust any figure in the product.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ PHASE 9 — WHAT CHANGED, AND THE BUG IT FOUND
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 **CANCELLED VOUCHERS WERE BEING SUMMED INTO EVERY LEDGER TOTAL.**
 * `ledgerMasters` walked every voucher and every leg. `isCancelled` was
 * parsed, carried into the voucher-summary view as a column, and never
 * consulted here. A cancelled voucher in Tally is one the accountant
 * voided: it is not in Tally's own totals, and it must not be in ours.
 *
 * The consequence was not cosmetic. `Total debit`, `Total credit` and
 * `Net` per ledger are what an accountant reads off this view to decide
 * what to type into their opening trial balance. Every voided invoice in
 * the export moved that figure, in the customer's favour or against it
 * depending on the ledger, and the resulting trial balance still BALANCED
 * — a cancelled voucher has equal debits and credits — so nothing
 * downstream could catch it. Proved in both directions by
 * `tests/ui/import-profiles.test.ts`.
 *
 * Three new views, and none of them posts anything either:
 *
 *   `voucher-types`   ⭐ the census. Every voucher type in the file, how
 *                     many, how many cancelled, what they foot to, and
 *                     what Ordence does with that type.
 *   `cost-centres`    the cost-centre allocations inside the legs.
 *   `bill-wise`       the bill references inside the legs — which is how
 *                     a Tally receivable knows which invoice it settles.
 *
 * ⚠️ THE LAST TWO READ THE XML TREE DIRECTLY through `parseXml` and the
 * navigation helpers, because `ParsedTallyLeg` carries a ledger name, a
 * direction and an amount and nothing else — allocations are below the
 * level it models. They report Tally's amounts WITH THE SIGN TALLY WROTE
 * and do not re-derive the debit/credit rule: that rule lives in
 * `readVoucher` and a second copy of it here is exactly the drifting
 * model this repository has been bitten by four times.
 */

import {
  parseTallyExport,
  parseXml,
  findAll,
  childText,
  type ParsedNode,
} from "@/lib/tally/parse";
import { parseTallyAmount, fromTallyDate } from "@/lib/tally/amounts";
import { formatMinorPlain } from "@/lib/fx/currency";
import type { CsvRecord } from "../csv";

export class TallyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TallyReadError";
  }
}

/**
 * ⚠️ THE LIST AND THE TYPE ARE ONE DECLARATION. A union written by hand
 * beside an array is two lists that agree until somebody adds to one —
 * the shape `scripts/check-import-sources.mjs` exists to refuse for
 * formats, avoided here by construction.
 */
export const TALLY_VIEWS = [
  "ledger-masters",
  "voucher-summary",
  "voucher-types",
  "cost-centres",
  "bill-wise",
] as const;

export type TallyView = (typeof TALLY_VIEWS)[number];

export function isTallyView(value: unknown): value is TallyView {
  return (TALLY_VIEWS as readonly string[]).includes(value as string);
}

/** One line each, for a picker. Written for an accountant, not a developer. */
export const TALLY_VIEW_LABELS: Readonly<Record<TallyView, string>> = Object.freeze({
  "ledger-masters": "Ledgers — one row per ledger, with what it foots to",
  "voucher-summary": "Vouchers — one row per voucher, to check the period and the totals",
  "voucher-types": "Voucher types — what is in this file, and what Ordence does with each kind",
  "cost-centres": "Cost centres — the allocations inside the vouchers",
  "bill-wise": "Bill references — which invoice each outstanding amount belongs to",
});

export type TallyDocument = {
  readonly view: TallyView;
  readonly headers: string[];
  readonly records: CsvRecord[];
  readonly notes: readonly string[];
  readonly companyName: string | null;
};

const MASTER_HEADERS = [
  "Ledger name",
  "Appears as",
  "Vouchers",
  "Total debit",
  "Total credit",
  "Net",
  "Currency",
] as const;

const VOUCHER_HEADERS = [
  "Voucher date",
  "Voucher type",
  "Voucher number",
  "Party",
  "Narration",
  "Total debit",
  "Total credit",
  "Currency",
  "Cancelled",
] as const;

const VOUCHER_TYPE_HEADERS = [
  "Voucher type",
  "Vouchers",
  "Cancelled",
  "Total debit",
  "Total credit",
  "Currency",
  "What Ordence does with it",
] as const;

const COST_CENTRE_HEADERS = [
  "Voucher date",
  "Voucher type",
  "Voucher number",
  "Ledger",
  "Cost category",
  "Cost centre",
  "Amount",
  "Currency",
  "Cancelled",
] as const;

const BILL_WISE_HEADERS = [
  "Voucher date",
  "Voucher type",
  "Voucher number",
  "Party",
  "Ledger",
  "Bill reference",
  "Reference type",
  "Amount",
  "Credit days",
  "Currency",
  "Cancelled",
] as const;

/* ------------------------------------------------------------------ */
/* ⭐ WHAT EACH VOUCHER TYPE IS, AS DATA                               */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ANSWER TO "DOES MY SALES HISTORY COME ACROSS", PER TYPE
 * ══════════════════════════════════════════════════════════════════════
 * A day-book export from a company that has been running for six years
 * contains eighteen kinds of voucher, and the accountant reading the
 * preview cannot tell which of them Ordence is doing something with. The
 * honest answer for almost all of them is "nothing, deliberately" — see
 * the header — and saying that PER TYPE, with a count beside it, is a
 * different quality of answer from one paragraph at the top.
 *
 * ⚠️ DATA, NOT A SWITCH. The same argument as `lib/import/profiles`: a
 * `switch (voucherType)` here grows a branch per type, each with its own
 * slightly different sentence, and the eighteenth is a rewrite.
 *
 * 🔴 AND THE TWO THAT MATTER MOST ARE THE ONES THAT ARE NOT IN THE BOOKS.
 * A Memorandum voucher and a Reversing Journal do not affect Tally's own
 * trial balance. Their legs ARE summed into the ledger totals below,
 * because excluding them by NAME would be wrong the moment a company has
 * renamed a voucher type — which Tally allows and companies do. So they
 * are counted, named, and their totals are shown separately, and the
 * person deciding can subtract.
 */
const VOUCHER_TYPE_DISPOSITIONS: readonly (readonly [RegExp, string])[] = [
  [
    /^sales/i,
    "Not replayed. Your sales history stays in Tally; bring the unsettled invoices across as " +
      "opening customer invoices instead.",
  ],
  [
    /^purchase/i,
    "Not replayed. Bring the unpaid bills across as opening vendor bills instead.",
  ],
  [
    /^(receipt|payment)/i,
    "Not replayed. A receipt or payment against an invoice that is not in Ordence has nothing " +
      "to settle; the opening figure already nets it off.",
  ],
  [
    /^contra/i,
    "Not replayed. A bank-to-cash transfer before your cut-over date is already inside the " +
      "opening balance of both accounts.",
  ],
  [
    /^(credit note|debit note)/i,
    "Not replayed. If the note is unsettled, its balance is part of the party's opening " +
      "outstanding.",
  ],
  [
    /^journal/i,
    "Not replayed. Opening positions come across as one opening trial balance, which has to " +
      "balance before Ordence will commit it.",
  ],
  [
    /^(delivery note|receipt note|rejection|material)/i,
    "Not replayed, and it carries no accounting entry in Tally either. Its stock effect is " +
      "already in your closing quantities.",
  ],
  [
    /^(stock journal|physical stock)/i,
    "Not replayed. Bring the closing quantities across as opening stock as at your cut-over " +
      "date.",
  ],
  [
    /^(sales order|purchase order|quotation)/i,
    "Not replayed, and it is not an accounting entry. Open orders have to be re-entered in " +
      "Ordence if you want them.",
  ],
  [
    /^memorandum/i,
    "🔴 Not in Tally's own books either — a Memorandum voucher is a note. Its amounts ARE " +
      "included in the ledger totals Ordence shows, so subtract this row before using them.",
  ],
  [
    /^reversing journal/i,
    "🔴 Not in Tally's own books either — a Reversing Journal is provisional and expires. Its " +
      "amounts ARE included in the ledger totals Ordence shows, so subtract this row before " +
      "using them.",
  ],
  [
    /^(payroll|attendance)/i,
    "Not replayed. Payroll history is not migrated; Ordence starts from your cut-over date.",
  ],
];

function dispositionFor(voucherType: string): string {
  for (const [pattern, sentence] of VOUCHER_TYPE_DISPOSITIONS) {
    if (pattern.test(voucherType.trim())) return sentence;
  }
  /**
   * ⚠️ AN UNKNOWN TYPE IS NAMED AS UNKNOWN RATHER THAN GIVEN THE GENERIC
   * REASSURANCE. Companies create their own voucher types, and "Ordence
   * does nothing with this" reads the same whether we recognised it or
   * not — which is how a customer's bespoke type gets waved through.
   */
  return (
    "Ordence does not recognise this voucher type — it may be one your company created. " +
    "Nothing is replayed from it. Check what it is before relying on the ledger totals."
  );
}

/* ------------------------------------------------------------------ */
/* THE LEDGER MASTERS                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE LEDGER MASTERS, DERIVED FROM THE VOUCHERS THEMSELVES.
 *
 * ⚠️ NOT FROM A `<LEDGER>` MASTER LIST, WHICH A DAY-BOOK EXPORT DOES NOT
 * CONTAIN. Every ledger a voucher touches is a ledger the workspace uses,
 * and deriving them this way has a property a master list does not: it
 * cannot include four hundred ledgers created once in 2019 and never used
 * again, which is what makes a Tally chart of accounts unusable after a
 * decade.
 *
 * 🔴 AND `Appears as` IS NOT DECORATION. Tally matches ledger names
 * case-insensitively and does not merge, so "Acme Ltd" and "ACME LTD" are
 * one ledger there and would be two here. This column shows every
 * spelling seen so the person can see the collision before it becomes two
 * customers in Ordence.
 *
 * 🔴🔴 PHASE 9 — CANCELLED VOUCHERS ARE EXCLUDED. See the file header.
 * They are counted and reported rather than silently dropped, because a
 * customer whose export has 40 voided invoices in it and whose totals
 * changed needs to know which of those two facts explains the other.
 */
function ledgerMasters(vouchers: ReturnType<typeof parseTallyExport>["vouchers"]): {
  records: CsvRecord[];
  collisions: number;
  cancelledExcluded: number;
} {
  type Accumulated = {
    display: string;
    spellings: Set<string>;
    vouchers: number;
    debit: bigint;
    credit: bigint;
  };
  const byFold = new Map<string, Accumulated>();
  let cancelledExcluded = 0;

  for (const voucher of vouchers) {
    if (voucher.isCancelled) {
      cancelledExcluded += 1;
      continue;
    }
    for (const leg of voucher.legs) {
      const name = leg.ledgerName.trim();
      if (name === "") continue;
      const fold = name.toLowerCase();
      const found = byFold.get(fold) ?? {
        display: name,
        spellings: new Set<string>(),
        vouchers: 0,
        debit: 0n,
        credit: 0n,
      };
      found.spellings.add(name);
      found.vouchers += 1;
      if (leg.isDebit) found.debit += leg.amountMinor;
      else found.credit += leg.amountMinor;
      byFold.set(fold, found);
    }
  }

  const rows = [...byFold.values()].sort((a, b) => a.display.localeCompare(b.display));
  const collisions = rows.filter((r) => r.spellings.size > 1).length;

  const records: CsvRecord[] = [{ recordNumber: 1, cells: [...MASTER_HEADERS] }];
  rows.forEach((row, index) => {
    const net = row.debit - row.credit;
    records.push({
      recordNumber: index + 2,
      cells: [
        row.display,
        row.spellings.size > 1 ? [...row.spellings].join(" | ") : "",
        String(row.vouchers),
        formatMinorPlain(row.debit, "INR"),
        formatMinorPlain(row.credit, "INR"),
        formatMinorPlain(net, "INR"),
        "INR",
      ],
    });
  });

  return { records, collisions, cancelledExcluded };
}

/* ------------------------------------------------------------------ */
/* THE ALLOCATION VIEWS                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BOTH ELEMENT NAMES, AND THE SECOND ONE IS A FINDING.
 *
 * `readVoucher` in `lib/tally/parse.ts` reads `ALLLEDGERENTRIES.LIST` and
 * only that. Tally writes `LEDGERENTRIES.LIST` for some voucher classes,
 * and a voucher whose legs are under that element arrives with an empty
 * `legs` array, zero totals, and — because zero equals zero — reads as
 * perfectly balanced. These views read both, count the difference, and
 * report it; the fix belongs in `parse.ts`, which this phase does not
 * own. `PATCH-REQUEST-PHASE-9.md` §5.
 */
const LEDGER_ENTRY_ELEMENTS = ["ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"] as const;

type VoucherHead = {
  readonly date: string;
  readonly type: string;
  readonly number: string;
  readonly party: string;
  readonly cancelled: string;
};

function voucherHead(node: ParsedNode): VoucherHead {
  const raw = childText(node, "DATE");
  return {
    /**
     * ⚠️ THROUGH `fromTallyDate`, THE SAME CONVERSION `readVoucher` USES.
     * Tally writes `<DATE>20260401</DATE>`. A view that showed the raw
     * eight digits while the voucher view beside it showed `2026-04-01`
     * would be two spellings of one date in one product, and the customer
     * comparing the two screens would be right to distrust both. An
     * unreadable date falls back to what the file said rather than to a
     * blank, because the raw text is the only clue to why it failed.
     */
    date: raw ? (fromTallyDate(raw) ?? raw) : "",
    type: node.attrs.VCHTYPE ?? childText(node, "VOUCHERTYPENAME") ?? "Unknown",
    number: childText(node, "VOUCHERNUMBER") ?? "",
    party: childText(node, "PARTYLEDGERNAME") ?? childText(node, "PARTYNAME") ?? "",
    cancelled: (childText(node, "ISCANCELLED") ?? "No").toLowerCase() === "yes" ? "true" : "false",
  };
}

/**
 * ⚠️ THE AMOUNT IS REPORTED WITH THE SIGN TALLY WROTE AND IS NOT TURNED
 * INTO A DIRECTION HERE. `readVoucher` owns that rule — a negative amount
 * is a debit, with `ISDEEMEDPOSITIVE` as the fallback — and restating it
 * would be a second model of the same decision, which is the defect this
 * repository has found in its own checkers four times. The column heading
 * says what the sign means instead.
 */
function signedAmount(raw: string | null, onUnreadable: (raw: string) => void): string {
  if (raw === null) return "";
  try {
    return formatMinorPlain(parseTallyAmount(raw), "INR");
  } catch {
    onUnreadable(raw);
    return "";
  }
}

function ledgerEntriesOf(voucher: ParsedNode) {
  const out: { node: ParsedNode; element: string }[] = [];
  for (const element of LEDGER_ENTRY_ELEMENTS) {
    for (const node of findAll(voucher, element)) out.push({ node, element });
  }
  return out;
}

function costCentreRecords(source: string): {
  records: CsvRecord[];
  unreadable: number;
  onlyLegacyElement: number;
} {
  const { root } = parseXml(source);
  const records: CsvRecord[] = [{ recordNumber: 1, cells: [...COST_CENTRE_HEADERS] }];
  let unreadable = 0;
  let onlyLegacyElement = 0;

  for (const voucher of findAll(root, "VOUCHER")) {
    const head = voucherHead(voucher);
    const entries = ledgerEntriesOf(voucher);
    if (entries.length > 0 && entries.every((e) => e.element === "LEDGERENTRIES.LIST")) {
      onlyLegacyElement += 1;
    }

    for (const { node: entry } of entries) {
      const ledger = childText(entry, "LEDGERNAME") ?? "";
      const categories = findAll(entry, "CATEGORYALLOCATIONS.LIST");
      const groups =
        categories.length > 0
          ? categories.map((c) => ({
              category: childText(c, "CATEGORY") ?? "",
              allocations: findAll(c, "COSTCENTREALLOCATIONS.LIST"),
            }))
          : [{ category: "", allocations: findAll(entry, "COSTCENTREALLOCATIONS.LIST") }];

      for (const group of groups) {
        for (const allocation of group.allocations) {
          const name = childText(allocation, "NAME");
          if (name === null) continue;
          records.push({
            recordNumber: records.length + 1,
            cells: [
              head.date,
              head.type,
              head.number,
              ledger,
              group.category,
              name,
              signedAmount(childText(allocation, "AMOUNT"), () => {
                unreadable += 1;
              }),
              "INR",
              head.cancelled,
            ],
          });
        }
      }
    }
  }

  return { records, unreadable, onlyLegacyElement };
}

function billWiseRecords(source: string): {
  records: CsvRecord[];
  unreadable: number;
  onlyLegacyElement: number;
} {
  const { root } = parseXml(source);
  const records: CsvRecord[] = [{ recordNumber: 1, cells: [...BILL_WISE_HEADERS] }];
  let unreadable = 0;
  let onlyLegacyElement = 0;

  for (const voucher of findAll(root, "VOUCHER")) {
    const head = voucherHead(voucher);
    const entries = ledgerEntriesOf(voucher);
    if (entries.length > 0 && entries.every((e) => e.element === "LEDGERENTRIES.LIST")) {
      onlyLegacyElement += 1;
    }

    for (const { node: entry } of entries) {
      const ledger = childText(entry, "LEDGERNAME") ?? "";
      for (const allocation of findAll(entry, "BILLALLOCATIONS.LIST")) {
        const name = childText(allocation, "NAME");
        if (name === null) continue;
        records.push({
          recordNumber: records.length + 1,
          cells: [
            head.date,
            head.type,
            head.number,
            head.party,
            ledger,
            name,
            /**
             * ⭐ `New Ref`, `Agst Ref`, `Advance`, `On Account`. This is
             * the column that says whether an amount OPENS an outstanding
             * or SETTLES one, and an opening-balance migration that
             * ignored it would carry every settled invoice across as
             * still owing.
             */
            childText(allocation, "BILLTYPE") ?? "",
            signedAmount(childText(allocation, "AMOUNT"), () => {
              unreadable += 1;
            }),
            childText(allocation, "BILLCREDITPERIOD") ?? "",
            "INR",
            head.cancelled,
          ],
        });
      }
    }
  }

  return { records, unreadable, onlyLegacyElement };
}

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT                                                     */
/* ------------------------------------------------------------------ */

export function readTally(source: string, view: TallyView = "ledger-masters"): TallyDocument {
  const parsed = parseTallyExport(source);

  if (parsed.vouchers.length === 0) {
    throw new TallyReadError(
      "That file is XML and Ordence found no vouchers in it. A Tally export for migration is " +
        "taken from Gateway of Tally → Display → Day Book, with the period set, then Alt+E to " +
        "export as XML. An export of a report other than the day book has a different shape and " +
        "cannot be read.",
    );
  }

  const notes: string[] = [
    /**
     * 🔴 THE SENTENCE THAT MUST APPEAR EVERY TIME. See the header.
     */
    "Ordence reads this file to bring your ledgers and your opening position across. It does not " +
      "replay four years of vouchers into the ledger — reproducing another system's posting " +
      "decisions produces a trial balance that does not tie, with no way to tell which system is " +
      "right. Import the masters here, then enter one opening trial balance as at your cut-over " +
      "date. Your history stays in Tally, where it is already audited.",
  ];

  if (parsed.companyName) {
    notes.push(`This export is from the Tally company "${parsed.companyName}".`);
  }
  if (parsed.warnings.length > 0) {
    /**
     * ⚠️ THE WARNINGS ARE CARRIED THROUGH, NOT SWALLOWED.
     * `parseTallyExport` deliberately turns an unreadable voucher into a
     * warning rather than an exception so that 1,999 of 2,000 still read.
     * A front-end that then drops the warnings converts that careful
     * behaviour into silent data loss.
     */
    notes.push(
      `${parsed.warnings.length} entr${parsed.warnings.length === 1 ? "y" : "ies"} in that file ` +
        `could not be read and ${parsed.warnings.length === 1 ? "was" : "were"} left out: ` +
        `${parsed.warnings.slice(0, 3).map((w) => w.message).join(" · ")}` +
        `${parsed.warnings.length > 3 ? " …" : ""}`,
    );
  }

  /**
   * ⭐ WHAT ELSE IS IN THIS FILE, SAID CHEAPLY.
   *
   * ⚠️ A STRING SCAN AND NOT A SECOND PARSE. Naming the other views costs
   * one pass over the source rather than a second tree build on a file
   * that can be ten megabytes — and a view nobody knows exists is a view
   * nobody chooses, which is this codebase's most frequent defect wearing
   * a Tally hat.
   */
  if (view !== "cost-centres" && /<COSTCENTREALLOCATIONS\.LIST/i.test(source)) {
    notes.push(
      "This export carries cost-centre allocations inside its vouchers. Choose the cost-centres " +
        "view above to see them — they are not in any of the other views.",
    );
  }
  if (view !== "bill-wise" && /<BILLALLOCATIONS\.LIST/i.test(source)) {
    notes.push(
      "This export carries bill-wise references inside its vouchers — which invoice each amount " +
        "belongs to. Choose the bill references view above to see them; that is the list an " +
        "opening receivables figure is built from.",
    );
  }

  switch (view) {
    case "ledger-masters": {
      const { records, collisions, cancelledExcluded } = ledgerMasters(parsed.vouchers);
      if (collisions > 0) {
        notes.push(
          `${collisions} ledger${collisions === 1 ? "" : "s"} appear${collisions === 1 ? "s" : ""} ` +
            `under more than one spelling in that file — Tally treats them as one ledger and ` +
            `Ordence would create two. The "Appears as" column shows every spelling. Decide on one ` +
            `before you commit.`,
        );
      }
      if (cancelledExcluded > 0) {
        notes.push(
          `${cancelledExcluded} cancelled voucher${cancelledExcluded === 1 ? " was" : "s were"} ` +
            `left out of these totals. A cancelled voucher is one somebody voided; it is not in ` +
            `Tally's own figures either. It is named here because a total that moved and a ` +
            `voided invoice are two facts that explain each other.`,
        );
      }
      return { view, headers: [...MASTER_HEADERS], records, notes, companyName: parsed.companyName };
    }

    case "voucher-summary": {
      const records: CsvRecord[] = [{ recordNumber: 1, cells: [...VOUCHER_HEADERS] }];
      parsed.vouchers.forEach((voucher, index) => {
        records.push({
          recordNumber: index + 2,
          cells: [
            voucher.voucherDate ?? "",
            voucher.voucherType,
            voucher.voucherNumber ?? "",
            voucher.partyLedgerName ?? "",
            voucher.narration ?? "",
            formatMinorPlain(voucher.totalDebitMinor, "INR"),
            formatMinorPlain(voucher.totalCreditMinor, "INR"),
            "INR",
            voucher.isCancelled ? "true" : "false",
          ],
        });
      });
      notes.push(
        "This is a summary, one row per voucher, for checking that the period and the totals are " +
          "the ones you expect. The individual ledger legs are not in it. ⚠️ Cancelled vouchers " +
          "ARE listed here, with a column saying so — unlike the ledger view, which leaves them " +
          "out of its totals.",
      );
      return { view, headers: [...VOUCHER_HEADERS], records, notes, companyName: parsed.companyName };
    }

    case "voucher-types": {
      type Census = { vouchers: number; cancelled: number; debit: bigint; credit: bigint };
      const byType = new Map<string, Census>();
      for (const voucher of parsed.vouchers) {
        const type = voucher.voucherType.trim() || "Unknown";
        const found = byType.get(type) ?? { vouchers: 0, cancelled: 0, debit: 0n, credit: 0n };
        found.vouchers += 1;
        if (voucher.isCancelled) found.cancelled += 1;
        else {
          found.debit += voucher.totalDebitMinor;
          found.credit += voucher.totalCreditMinor;
        }
        byType.set(type, found);
      }

      const records: CsvRecord[] = [{ recordNumber: 1, cells: [...VOUCHER_TYPE_HEADERS] }];
      [...byType.entries()]
        .sort((a, b) => b[1].vouchers - a[1].vouchers || a[0].localeCompare(b[0]))
        .forEach(([type, census], index) => {
          records.push({
            recordNumber: index + 2,
            cells: [
              type,
              String(census.vouchers),
              String(census.cancelled),
              formatMinorPlain(census.debit, "INR"),
              formatMinorPlain(census.credit, "INR"),
              "INR",
              dispositionFor(type),
            ],
          });
        });

      notes.push(
        `This file holds ${parsed.vouchers.length} voucher${parsed.vouchers.length === 1 ? "" : "s"} ` +
          `across ${byType.size} type${byType.size === 1 ? "" : "s"}. The last column says what ` +
          `Ordence does with each kind, which for almost all of them is nothing — read it before ` +
          `deciding whether this migration has brought across what you expected.`,
      );
      return {
        view,
        headers: [...VOUCHER_TYPE_HEADERS],
        records,
        notes,
        companyName: parsed.companyName,
      };
    }

    case "cost-centres": {
      const { records, unreadable, onlyLegacyElement } = costCentreRecords(source);
      if (records.length === 1) {
        notes.push(
          "There are no cost-centre allocations in this export. Either the company does not use " +
            "cost centres, or the day book was exported without them.",
        );
      } else {
        notes.push(
          `${records.length - 1} cost-centre allocation${records.length === 2 ? "" : "s"}, one row ` +
            `each. ⚠️ These are Tally's amounts with Tally's own sign — a negative is a debit. ` +
            `Ordence does not post them; they are here so you can see how the company splits its ` +
            `costs before you set up cost centres in Ordence.`,
        );
      }
      pushAllocationCaveats(notes, unreadable, onlyLegacyElement);
      return {
        view,
        headers: [...COST_CENTRE_HEADERS],
        records,
        notes,
        companyName: parsed.companyName,
      };
    }

    case "bill-wise": {
      const { records, unreadable, onlyLegacyElement } = billWiseRecords(source);
      if (records.length === 1) {
        notes.push(
          "There are no bill-wise references in this export. Without them an outstanding amount " +
            "cannot be tied to the invoice it belongs to, so your opening receivables will have " +
            "to come from Tally's own outstandings report instead.",
        );
      } else {
        notes.push(
          `${records.length - 1} bill reference${records.length === 2 ? "" : "s"}, one row each. ` +
            `⚠️ "Reference type" is the column that matters: New Ref opens an outstanding, ` +
            `Agst Ref settles one, and a migration that ignored the difference would carry every ` +
            `paid invoice across as still owing. These are Tally's amounts with Tally's own sign ` +
            `— a negative is a debit.`,
        );
      }
      pushAllocationCaveats(notes, unreadable, onlyLegacyElement);
      return {
        view,
        headers: [...BILL_WISE_HEADERS],
        records,
        notes,
        companyName: parsed.companyName,
      };
    }
  }
}

/**
 * ⚠️ ONE PLACE, BECAUSE BOTH ALLOCATION VIEWS HAVE THE SAME TWO CAVEATS
 * AND TWO COPIES WOULD DRIFT INTO SAYING DIFFERENT THINGS ABOUT THE SAME
 * FILE.
 */
function pushAllocationCaveats(notes: string[], unreadable: number, onlyLegacyElement: number) {
  if (unreadable > 0) {
    notes.push(
      `${unreadable} allocation amount${unreadable === 1 ? "" : "s"} could not be read and ` +
        `${unreadable === 1 ? "is" : "are"} shown blank rather than as zero. A blank is a ` +
        `question; a zero would be an answer, and the wrong one.`,
    );
  }
  if (onlyLegacyElement > 0) {
    notes.push(
      `🔴 ${onlyLegacyElement} voucher${onlyLegacyElement === 1 ? "" : "s"} in this file ` +
        `${onlyLegacyElement === 1 ? "keeps its" : "keep their"} ledger entries under ` +
        `<LEDGERENTRIES.LIST> rather than <ALLLEDGERENTRIES.LIST>. Ordence's ledger and voucher ` +
        `views read only the second element, so ` +
        `${onlyLegacyElement === 1 ? "that voucher shows" : "those vouchers show"} zero debits ` +
        `and zero credits there — and zero equals zero, so ` +
        `${onlyLegacyElement === 1 ? "it reads" : "they read"} as balanced. Do not take those ` +
        `totals as complete.`,
    );
  }
}
