/**
 * Ordence — ⭐⭐ Voucher Construction and the Balance Assertion
 * Version: v0.37.0-alpha
 *
 * Pure and isomorphic. `bigint` paise, integer basis points, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ EVERY VOUCHER BALANCES BEFORE IT IS WRITTEN. NO EXCEPTIONS.
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TALLY REJECTS AN UNBALANCED VOUCHER — AFTER THE IMPORT HAS STARTED.
 *
 * The rejection is not a validation error against a form. It arrives an
 * hour in, in a dialogue that names a voucher number in a file of two
 * thousand, and on several builds it aborts the remaining vouchers rather
 * than skipping the one. So the accountant's afternoon produces a company
 * containing an unknown prefix of March and no way to tell where it
 * stopped short of counting.
 *
 * ⭐ SO THE ASSERTION IS AT THE BUILDER, AND AGAIN AT THE DATABASE (SQL
 * 0026's `tally_vouchers_balances` CHECK), AND AGAIN IN THE TEST SUITE.
 * Three layers for one rule is not belt-and-braces — the builder is not
 * the only write path, and the path that will get it wrong is the
 * back-fill of a year of historical vouchers written at 6pm on a Friday.
 *
 * ⚠️ AND THE ASSERTION IS ON PAISE, NOT ON RUPEES. Balancing a voucher in
 * rupees and rounding each leg to two places is how a three-way GST split
 * of an odd amount comes out one paisa short — which Tally rejects with
 * exactly the same dialogue as a ₹10,000 error, and which is far harder
 * to find.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TALLY'S SIGN CONVENTION IS NOT WHAT ANYONE EXPECTS
 * ══════════════════════════════════════════════════════════════════════
 * In `<ALLLEDGERENTRIES.LIST>`:
 *
 *     DEBIT  → <AMOUNT>-1000.00</AMOUNT>
 *              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
 *     CREDIT → <AMOUNT>1000.00</AMOUNT>
 *              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
 *
 * ⭐ A DEBIT IS NEGATIVE AND "DEEMED POSITIVE". Getting it backwards
 * produces a voucher that imports perfectly and posts every entry the
 * wrong way round — sales as purchases, receipts as payments — and the
 * trial balance still balances, because a uniformly inverted set of
 * entries is still a balanced set of entries.
 *
 * The conversion happens exactly once, in `voucherNode` below. Nothing
 * else in this codebase knows about it, and the direction is carried
 * everywhere else by the boolean `isDebit`.
 */

import {
  compact,
  leaf,
  type TallyXmlNode,
} from "./xml";
import { formatTallyAmount, toTallyDate } from "./amounts";
import { voucherContentHash, deterministicRemoteId } from "./keys";
import type { TallyVoucherType } from "@/db/schema/tally";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

/** A cost-centre allocation on one leg. See `TallyVoucher` for the rule. */
export type CostCentreAllocation = {
  category: string;
  name: string;
  /** Paise. Unsigned; it inherits the leg's direction. */
  amountMinor: bigint;
};

/**
 * ⚠️ TALLY'S BILL-WISE TYPES ARE FOUR AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   `New Ref`    — this bill is being raised now.
 *   `Agst Ref`   — this payment settles a bill raised earlier. ⭐ The one
 *                  that makes the ageing work; without it a receipt shows
 *                  as an unadjusted advance forever and the party's
 *                  outstanding is right while their ageing is nonsense.
 *   `Advance`    — money received before any bill exists.
 *   `On Account` — ⚠️ money we cannot attribute. Legitimate, and it is
 *                  also where everything ends up when nobody sets the
 *                  other three.
 */
export type BillAllocation = {
  name: string;
  billType: "New Ref" | "Agst Ref" | "Advance" | "On Account";
  amountMinor: bigint;
};

export type VoucherLeg = {
  ledgerName: string;
  /** ⭐ Direction. Never a sign on the amount. See the header. */
  isDebit: boolean;
  /** Paise. ALWAYS POSITIVE. */
  amountMinor: bigint;
  costCentres?: CostCentreAllocation[];
  billAllocations?: BillAllocation[];
  /** ⭐ HSN or SAC, so Tally's own GST reports have something to group on. */
  hsnSac?: string | null;
  gstRateBps?: number | null;
};

export type TallyVoucherDraft = {
  voucherType: TallyVoucherType;
  /** ⭐ The deterministic key. See `lib/tally/keys.ts`. */
  remoteId: string;
  voucherNumber?: string | null;
  /** ISO `YYYY-MM-DD`. Converted to Tally's `YYYYMMDD` at render. */
  voucherDate: string;

  sourceType: string;
  sourceId: string;

  partyLedgerName?: string | null;
  partyGstin?: string | null;
  /** ⭐ Two digits. Section 12(3) for immovable property. See the schema. */
  placeOfSupplyCode?: string | null;
  gstRegistrationType?: string | null;

  narration?: string | null;
  reference?: string | null;
  referenceDate?: string | null;

  legs: VoucherLeg[];
  isCancelled?: boolean;
};

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE BALANCE ASSERTION                                            */
/* ------------------------------------------------------------------ */

export class VoucherImbalanceError extends Error {
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;

  constructor(draft: { voucherType: string; voucherNumber?: string | null },
              debitMinor: bigint, creditMinor: bigint) {
    const label = draft.voucherNumber
      ? `${draft.voucherType} voucher ${draft.voucherNumber}`
      : `a ${draft.voucherType} voucher`;
    const difference = debitMinor > creditMinor
      ? debitMinor - creditMinor
      : creditMinor - debitMinor;
    super(
      `${label} does not balance: debits ${formatTallyAmount(debitMinor)}, ` +
        `credits ${formatTallyAmount(creditMinor)}, out by ` +
        `${formatTallyAmount(difference)}. ⚠️ It has NOT been written. Tally ` +
        `rejects an unbalanced voucher part-way through an import, naming a ` +
        `voucher number in a file of thousands — which is an afternoon lost and ` +
        `a company containing an unknown prefix of the period.`,
    );
    this.name = "VoucherImbalanceError";
    this.debitMinor = debitMinor;
    this.creditMinor = creditMinor;
  }
}

export class VoucherShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoucherShapeError";
  }
}

export type VoucherTotals = { debitMinor: bigint; creditMinor: bigint };

export function voucherTotals(legs: readonly VoucherLeg[]): VoucherTotals {
  let debitMinor = 0n;
  let creditMinor = 0n;
  for (const leg of legs) {
    if (leg.isDebit) debitMinor += leg.amountMinor;
    else creditMinor += leg.amountMinor;
  }
  return { debitMinor, creditMinor };
}

/**
 * ⭐⭐ THE GATE. Everything that writes a voucher goes through here.
 *
 * ⚠️ IT CHECKS FIVE THINGS AND EVERY ONE OF THEM IS A REAL TALLY
 * REJECTION, not a stylistic preference:
 *
 *   1. Debits equal credits. The one this file exists for.
 *   2. No negative leg. A negative debit is a credit written by somebody
 *      who did not know the direction was a separate field, and it makes
 *      the totals balance while the entries are wrong.
 *   3. No zero-amount leg. Tally accepts it and shows a ledger entry of
 *      nothing, which is how a dropped amount survives review.
 *   4. ⭐ Cost-centre allocations total their leg. Tally accepts a
 *      partial allocation and quietly parks the rest as unallocated, so
 *      every project P&L looks plausible and none of them add up.
 *   5. A contra touches nothing but cash and bank. Tally enforces this
 *      itself, and the enforcement arrives as a failed import.
 */
export function assertVoucherBalances(draft: TallyVoucherDraft): VoucherTotals {
  if (draft.legs.length === 0 && !draft.isCancelled) {
    throw new VoucherShapeError(
      `A ${draft.voucherType} voucher with no ledger entries balances trivially ` +
        `and moves nothing. It would import successfully and do nothing at all — ` +
        `which is how a bug that drops every leg produces a file reporting two ` +
        `thousand vouchers created and no money moved.`,
    );
  }

  for (const leg of draft.legs) {
    if (leg.amountMinor < 0n) {
      throw new VoucherShapeError(
        `The entry against "${leg.ledgerName}" has a negative amount ` +
          `(${formatTallyAmount(leg.amountMinor)}). Direction is carried by ` +
          `isDebit and never by a sign — a negative debit is a credit written ` +
          `twice, and the totals balance while every entry is wrong.`,
      );
    }
    if (leg.amountMinor === 0n) {
      throw new VoucherShapeError(
        `The entry against "${leg.ledgerName}" is zero. Tally accepts it and ` +
          `shows a ledger line of nothing, which is exactly how a dropped ` +
          `amount survives being looked at.`,
      );
    }

    // ⭐ 4. The cost-centre allocation must total the leg.
    const centres = leg.costCentres ?? [];
    if (centres.length > 0) {
      const allocated = centres.reduce((sum, c) => sum + c.amountMinor, 0n);
      if (allocated !== leg.amountMinor) {
        throw new VoucherShapeError(
          `The cost-centre allocation on "${leg.ledgerName}" totals ` +
            `${formatTallyAmount(allocated)} against a line of ` +
            `${formatTallyAmount(leg.amountMinor)}. ⚠️ Tally ACCEPTS a partial ` +
            `allocation and parks the remainder as unallocated, so each project ` +
            `P&L looks plausible and none of them add up to the company.`,
        );
      }
      for (const centre of centres) {
        if (centre.amountMinor <= 0n) {
          throw new VoucherShapeError(
            `The allocation to cost centre "${centre.name}" is not positive. ` +
              `A cost centre carries a share of a line, and a share is positive.`,
          );
        }
      }
    }

    const bills = leg.billAllocations ?? [];
    if (bills.length > 0) {
      const allocated = bills.reduce((sum, b) => sum + b.amountMinor, 0n);
      if (allocated !== leg.amountMinor) {
        throw new VoucherShapeError(
          `The bill-wise allocation on "${leg.ledgerName}" totals ` +
            `${formatTallyAmount(allocated)} against a line of ` +
            `${formatTallyAmount(leg.amountMinor)}. Tally posts the difference ` +
            `"on account", where it never ages and nobody chases it.`,
        );
      }
    }
  }

  // ⚠️ 5. Contra is cash/bank to cash/bank. Tally refuses anything else.
  if (draft.voucherType === "contra" && draft.partyLedgerName) {
    throw new VoucherShapeError(
      `A contra voucher may not carry a party. Contra is cash and bank moving ` +
        `between themselves — Tally refuses anything else, and the refusal ` +
        `arrives as a failed import rather than as a field error.`,
    );
  }

  const totals = voucherTotals(draft.legs);
  if (totals.debitMinor !== totals.creditMinor) {
    throw new VoucherImbalanceError(draft, totals.debitMinor, totals.creditMinor);
  }
  return totals;
}

/* ------------------------------------------------------------------ */
/* ⭐ THE EIGHT BUILDERS                                                */
/* ------------------------------------------------------------------ */

/**
 * The facts every builder needs. Deliberately NOT our database rows: a
 * builder that took a `PurchaseInvoice` would have to import the schema,
 * and this file would stop being testable without a database.
 */
export type VoucherFacts = {
  tenantId: string;
  sourceType: string;
  sourceId: string;
  voucherNumber?: string | null;
  voucherDate: string;
  partyLedgerName?: string | null;
  partyGstin?: string | null;
  placeOfSupplyCode?: string | null;
  gstRegistrationType?: string | null;
  narration?: string | null;
  reference?: string | null;
  referenceDate?: string | null;
  legs: VoucherLeg[];
  isCancelled?: boolean;
};

/**
 * ⭐ THE ONE CONSTRUCTOR. Every named builder below is this with a
 * voucher type and a shape check bolted on.
 *
 * ⚠️ IT ASSERTS BEFORE IT RETURNS. There is no path in this module that
 * produces an unbalanced draft, which is why `server/tally/exporter.ts`
 * has no balance check of its own — a second one there would be a second
 * place to forget.
 */
export function buildVoucher(
  voucherType: TallyVoucherType,
  facts: VoucherFacts,
): TallyVoucherDraft {
  const draft: TallyVoucherDraft = {
    voucherType,
    remoteId: deterministicRemoteId({
      tenantId: facts.tenantId,
      voucherType,
      sourceType: facts.sourceType,
      sourceId: facts.sourceId,
    }),
    voucherNumber: facts.voucherNumber ?? null,
    voucherDate: facts.voucherDate,
    sourceType: facts.sourceType,
    sourceId: facts.sourceId,
    partyLedgerName: facts.partyLedgerName ?? null,
    partyGstin: facts.partyGstin ?? null,
    placeOfSupplyCode: facts.placeOfSupplyCode ?? null,
    gstRegistrationType: facts.gstRegistrationType ?? null,
    narration: facts.narration ?? null,
    reference: facts.reference ?? null,
    referenceDate: facts.referenceDate ?? null,
    legs: facts.legs,
    isCancelled: facts.isCancelled ?? false,
  };

  assertVoucherBalances(draft);
  requirePartyWhereTallyDoes(draft);
  return draft;
}

/**
 * ⚠️ FIVE OF THE EIGHT TYPES REQUIRE A PARTY AND TALLY WILL NOT SAY SO.
 *
 * A sales voucher with no `<PARTYLEDGERNAME>` imports, posts to the
 * ledgers named in its entries, and appears in NO GST report and NO
 * receivables ageing — because both of those are driven off the party
 * field, not off the entries. The books balance; the compliance reports
 * are empty. That is the worst possible combination and it is the default
 * behaviour.
 */
function requirePartyWhereTallyDoes(draft: TallyVoucherDraft): void {
  const needsParty: TallyVoucherType[] = [
    "sales",
    "purchase",
    "credit_note",
    "debit_note",
  ];
  if (draft.isCancelled) return;
  if (needsParty.includes(draft.voucherType) && !draft.partyLedgerName) {
    throw new VoucherShapeError(
      `A ${draft.voucherType} voucher must name a party. ⚠️ Without it Tally ` +
        `imports the voucher, posts the entries, and shows it in NO GST report ` +
        `and NO receivables or payables ageing — both of which read the party ` +
        `field and not the entries. The books balance and the compliance ` +
        `reports are empty.`,
    );
  }
}

export const buildSalesVoucher = (f: VoucherFacts) => buildVoucher("sales", f);
export const buildPurchaseVoucher = (f: VoucherFacts) => buildVoucher("purchase", f);
export const buildReceiptVoucher = (f: VoucherFacts) => buildVoucher("receipt", f);
export const buildPaymentVoucher = (f: VoucherFacts) => buildVoucher("payment", f);
export const buildJournalVoucher = (f: VoucherFacts) => buildVoucher("journal", f);
export const buildContraVoucher = (f: VoucherFacts) => buildVoucher("contra", f);
export const buildCreditNoteVoucher = (f: VoucherFacts) =>
  buildVoucher("credit_note", f);
export const buildDebitNoteVoucher = (f: VoucherFacts) => buildVoucher("debit_note", f);

/* ------------------------------------------------------------------ */
/* ⭐ CHOOSING THE VOUCHER TYPE                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHICH OF THE EIGHT A LEDGER TRANSACTION IS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS DERIVED, AND IT IS DERIVED FROM RECORDED DECISIONS ONLY
 * ══════════════════════════════════════════════════════════════════════
 * Everything else in this phase refuses to guess. This function does
 * derive — and the distinction that makes it acceptable is that it
 * derives from two things somebody explicitly wrote down:
 *
 *   • `referenceType` on the transaction, which the code that posted it
 *     chose deliberately (Phase 4).
 *   • The Tally GROUP each leg's ledger is mapped to, which an
 *     administrator chose deliberately on the mappings screen.
 *
 * It never looks at an account NAME, which is the thing that varies
 * between firms and cannot be trusted.
 *
 * ⚠️ AND THE FALLBACK IS `journal`, WHICH IS ALWAYS CORRECT IF DULL.
 * A journal voucher with the right two sides posts exactly the right
 * amounts to exactly the right ledgers. What it loses is Tally's own
 * registers: a sale filed as a journal is absent from the Sales Register
 * and from Tally's GSTR-1. That is a reporting loss, not a wrong number,
 * and it is the right way round — the alternative failure is a JOURNAL
 * guessed into a SALES voucher, which puts a bank transfer into the GST
 * return.
 */
const MONEY_GROUPS: ReadonlySet<string> = new Set([
  "bank_accounts",
  "bank_od_account",
  "cash_in_hand",
]);

export type ClassificationLeg = {
  /** The Tally group the leg's ledger is mapped to. */
  group: string;
  isDebit: boolean;
};

export function classifyVoucherType(args: {
  /** `transactions.reference_type` from Phase 4. */
  referenceType: string;
  legs: readonly ClassificationLeg[];
}): TallyVoucherType {
  const groups = args.legs.map((leg) => leg.group);
  const hasCreditor = groups.includes("sundry_creditors");
  const hasDebtor = groups.includes("sundry_debtors");

  /**
   * ⭐ CONTRA FIRST, AND ONLY WHEN EVERY LEG IS CASH OR BANK.
   *
   * ⚠️ Tally REFUSES a contra containing anything else, and the refusal
   * arrives as a failed import rather than as a field error. So the test
   * is "all", never "any" — a bank charge on a transfer makes it a
   * payment, not a contra.
   */
  if (args.legs.length > 0 && groups.every((group) => MONEY_GROUPS.has(group))) {
    return "contra";
  }

  switch (args.referenceType) {
    case "receipt":
      return "receipt";
    case "payment":
      return "payment";
    case "invoice":
      if (hasCreditor) return "purchase";
      if (hasDebtor) return "sales";
      return "journal";
    case "adjustment":
      /**
       * ⚠️ THE NOTE'S DIRECTION IS THE PARTY'S DIRECTION, NOT OURS. A
       * credit note REDUCES what a customer owes, so the debtor is
       * CREDITED; a debit note reduces what we owe a vendor, so the
       * creditor is DEBITED. Reading it the other way round produces a
       * credit note that increases a receivable, which Tally imports
       * happily and which shows up as a customer disputing an amount they
       * were never charged.
       */
      if (hasDebtor && args.legs.some((l) => l.group === "sundry_debtors" && !l.isDebit)) {
        return "credit_note";
      }
      if (hasCreditor && args.legs.some((l) => l.group === "sundry_creditors" && l.isDebit)) {
        return "debit_note";
      }
      return "journal";
    default:
      return "journal";
  }
}

/* ------------------------------------------------------------------ */
/* TALLY'S NAMES FOR THE TYPES                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `<VOUCHERTYPENAME>` MUST BE A TYPE THE COMPANY HAS.
 *
 * These eight exist in every Tally company from creation. A name Tally
 * does not recognise is not rejected — the voucher is filed under a type
 * Tally invents, where it appears in no standard register.
 *
 * ⭐ AND "Credit Note" IS TWO WORDS WITH A SPACE. "CreditNote" creates a
 * new voucher type, and the GST returns in Tally read the built-in one.
 */
export const TALLY_VOUCHER_TYPE_NAMES: Readonly<Record<TallyVoucherType, string>> =
  Object.freeze({
    sales: "Sales",
    purchase: "Purchase",
    receipt: "Receipt",
    payment: "Payment",
    journal: "Journal",
    contra: "Contra",
    credit_note: "Credit Note",
    debit_note: "Debit Note",
  });

/* ------------------------------------------------------------------ */
/* ⭐ RENDERING                                                         */
/* ------------------------------------------------------------------ */

/**
 * One `<VOUCHER>` element.
 *
 * ⚠️ THE ATTRIBUTES ARE NOT OPTIONAL AND THEIR ORDER IS TALLY'S.
 *   `REMOTEID`   — ⭐⭐ the de-duplication key. Without it, re-import
 *                  doubles the books. See `lib/tally/keys.ts`.
 *   `VCHTYPE`    — must equal `<VOUCHERTYPENAME>`; Tally reads both.
 *   `ACTION`     — `Create` on a first send, `Alter` on a re-send.
 *   `OBJVIEW`    — "Accounting Voucher View". Omitting it makes Tally
 *                  guess from the entries, and it guesses "Invoice
 *                  Voucher View" for anything with a party — which then
 *                  demands inventory allocations we do not have.
 */
export function voucherNode(
  draft: TallyVoucherDraft,
  options: { action?: "Create" | "Alter" } = {},
): TallyXmlNode {
  const action = options.action ?? "Create";
  const typeName = TALLY_VOUCHER_TYPE_NAMES[draft.voucherType];

  return {
    tag: "VOUCHER",
    attrs: {
      REMOTEID: draft.remoteId,
      VCHTYPE: typeName,
      ACTION: action,
      OBJVIEW: "Accounting Voucher View",
    },
    children: compact([
      leaf("DATE", toTallyDate(draft.voucherDate)),
      leaf("VOUCHERTYPENAME", typeName),
      leaf("VOUCHERNUMBER", draft.voucherNumber),
      leaf("REFERENCE", draft.reference),
      draft.referenceDate ? leaf("REFERENCEDATE", toTallyDate(draft.referenceDate)) : null,
      leaf("PARTYLEDGERNAME", draft.partyLedgerName),
      // ⚠️ Tally reads the party name from BOTH of these on different
      // builds. Sending one and not the other is the commonest cause of a
      // voucher that imports with a blank party.
      leaf("PARTYNAME", draft.partyLedgerName),
      leaf("PARTYGSTIN", draft.partyGstin),
      leaf("PLACEOFSUPPLY", draft.placeOfSupplyCode),
      leaf("PARTYGSTREGISTRATIONTYPE", draft.gstRegistrationType),
      // ⚠️ keepEmpty: an ABSENT narration on an ALTER leaves Tally's
      // existing text in place; an EMPTY one clears it. See `TallyXmlNode`.
      leaf("NARRATION", draft.narration ?? "", { keepEmpty: true }),
      leaf("ISCANCELLED", draft.isCancelled ? "Yes" : "No"),
      leaf("PERSISTEDVIEW", "Accounting Voucher View"),
      ...draft.legs.map(ledgerEntryNode),
    ]),
  };
}

function ledgerEntryNode(leg: VoucherLeg): TallyXmlNode {
  /**
   * ⭐⭐ THE SIGN CONVERSION, IN THE ONLY PLACE IT HAPPENS.
   * Debit → negative amount, ISDEEMEDPOSITIVE Yes. See the file header.
   */
  const signed = leg.isDebit ? -leg.amountMinor : leg.amountMinor;

  return {
    tag: "ALLLEDGERENTRIES.LIST",
    children: compact([
      leaf("LEDGERNAME", leg.ledgerName),
      leaf("ISDEEMEDPOSITIVE", leg.isDebit ? "Yes" : "No"),
      leaf("AMOUNT", formatTallyAmount(signed)),
      leaf("HSNCODE", leg.hsnSac),
      // ⚠️ Tally wants the rate as a percentage, not basis points.
      leg.gstRateBps === null || leg.gstRateBps === undefined
        ? null
        : leaf("GSTRATE", formatRateFromBps(leg.gstRateBps)),
      ...(leg.billAllocations ?? []).map((bill) => billAllocationNode(bill, leg.isDebit)),
      ...(leg.costCentres ?? []).map((centre) => costCentreNode(centre, leg.isDebit)),
    ]),
  };
}

function billAllocationNode(bill: BillAllocation, isDebit: boolean): TallyXmlNode {
  const signed = isDebit ? -bill.amountMinor : bill.amountMinor;
  return {
    tag: "BILLALLOCATIONS.LIST",
    children: compact([
      leaf("NAME", bill.name),
      leaf("BILLTYPE", bill.billType),
      leaf("AMOUNT", formatTallyAmount(signed)),
    ]),
  };
}

/**
 * ⭐ THE COST CENTRE — the per-project P&L, in the only place Tally will
 * take it.
 *
 * ⚠️ IT IS PER LEDGER ENTRY, NOT PER VOUCHER, and that is what makes it
 * useful: one cement invoice split across three towers is three
 * allocations on one purchase line. A per-voucher model would force the
 * accountant to raise three invoices for one bill.
 */
function costCentreNode(centre: CostCentreAllocation, isDebit: boolean): TallyXmlNode {
  const signed = isDebit ? -centre.amountMinor : centre.amountMinor;
  return {
    tag: "CATEGORYALLOCATIONS.LIST",
    children: compact([
      leaf("CATEGORY", centre.category),
      leaf("ISDEEMEDPOSITIVE", isDebit ? "Yes" : "No"),
      {
        tag: "COSTCENTREALLOCATIONS.LIST",
        children: compact([
          leaf("NAME", centre.name),
          leaf("AMOUNT", formatTallyAmount(signed)),
        ]),
      },
    ]),
  };
}

/** 1800 bps → "18". 250 bps → "2.5". Never a float. */
function formatRateFromBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  if (fraction === 0) return String(whole);
  const padded = String(fraction).padStart(2, "0").replace(/0$/, "");
  return `${whole}.${padded}`;
}

/* ------------------------------------------------------------------ */
/* HASHING A DRAFT                                                     */
/* ------------------------------------------------------------------ */

/** The content hash of a draft, in the canonical form `lib/tally/keys.ts` defines. */
export function draftContentHash(draft: TallyVoucherDraft): string {
  return voucherContentHash({
    voucherType: draft.voucherType,
    voucherDate: draft.voucherDate,
    voucherNumber: draft.voucherNumber,
    partyLedgerName: draft.partyLedgerName,
    partyGstin: draft.partyGstin,
    placeOfSupplyCode: draft.placeOfSupplyCode,
    narration: draft.narration,
    reference: draft.reference,
    isCancelled: draft.isCancelled,
    entries: draft.legs.map((leg) => ({
      ledgerName: leg.ledgerName,
      isDebit: leg.isDebit,
      amountMinor: leg.amountMinor,
      costCentres: leg.costCentres,
      hsnSac: leg.hsnSac,
      gstRateBps: leg.gstRateBps,
    })),
  });
}

/** The stored `entries` jsonb, with amounts as decimal strings of paise. */
export function draftEntriesForStorage(draft: TallyVoucherDraft) {
  return draft.legs.map((leg) => ({
    ledgerName: leg.ledgerName,
    isDebit: leg.isDebit,
    amountMinor: leg.amountMinor.toString(),
    costCentres: leg.costCentres?.map((c) => ({
      category: c.category,
      name: c.name,
      amountMinor: c.amountMinor.toString(),
    })),
    billAllocations: leg.billAllocations?.map((b) => ({
      name: b.name,
      billType: b.billType,
      amountMinor: b.amountMinor.toString(),
    })),
    hsnSac: leg.hsnSac ?? undefined,
    gstRateBps: leg.gstRateBps ?? undefined,
  }));
}
