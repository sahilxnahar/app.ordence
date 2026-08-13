/**
 * Ordence — ⭐ Turning a sales document into balanced journal legs
 * Version: v0.99.0-alpha
 *
 * Pure. No database, no clock, no ledger ids — it speaks in ROLES, and
 * `server/accounting/post-sales.ts` resolves those to the tenant's own
 * ledgers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS: THE BOOKS DID NOT KNOW ABOUT THE INVOICES
 * ══════════════════════════════════════════════════════════════════════
 * The sales invoice subsystem was built across Phases 49–57 and posts
 * nothing to `transactions` / `journal_entries`. Every invoice raised so
 * far is absent from the P&L, the balance sheet, the trial balance and
 * the Tally export — which reads the ledger and only the ledger.
 *
 * The documents were right the whole time. The books had never been told.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE RULE: DEBITS EQUAL CREDITS, BY CONSTRUCTION
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE ROUND-OFF LEG IS NOT A ROUNDING CONVENIENCE — IT IS THE
 * BALANCING LEG. An invoice total is `taxable + cgst + sgst + igst + cess
 * + roundOff`. If round-off were dropped as "only paise", the debit to
 * the customer would differ from the sum of the credits by up to 99
 * paise, and a deferred constraint trigger would refuse the whole
 * transaction at COMMIT — which surfaces as "issuing an invoice failed"
 * with no clue why.
 *
 * ⚠️ AND IT CAN GO EITHER WAY. A negative round-off is a debit, not a
 * credit with a minus sign. Journal legs carry their direction in
 * `entryType`; a signed amount is a second, contradictory way of saying
 * the same thing.
 */

export type PostingRole =
  /** Sundry Debtors — what the customer owes. */
  | "receivable"
  /** Sales / revenue, net of tax. */
  | "revenue"
  | "output_cgst"
  | "output_sgst"
  | "output_igst"
  | "output_cess"
  /** Rounding difference. Either direction. */
  | "round_off"
  /** Where receipts land — bank or cash. */
  | "bank"
  /** TDS the customer withheld: an asset until it is claimed. */
  | "tds_receivable";

export type PostingLeg = {
  role: PostingRole;
  entryType: "debit" | "credit";
  /** Minor units. Always POSITIVE — direction lives in `entryType`. */
  amountMinor: bigint;
  description: string;
};

export class PostingImbalance extends Error {}

/**
 * ⚠️ ZERO LEGS ARE DROPPED, NOT POSTED. An intra-State invoice has no
 * IGST; posting ₹0.00 to an output IGST ledger clutters every statement
 * and, worse, forces the tenant to map a ledger they will never use.
 */
function leg(
  role: PostingRole,
  entryType: "debit" | "credit",
  amountMinor: bigint,
  description: string,
): PostingLeg[] {
  return amountMinor === 0n ? [] : [{ role, entryType, amountMinor, description }];
}

export type SalesTaxBreakdown = {
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  roundOffMinor: bigint;
  totalMinor: bigint;
};

/** Throws if the legs do not balance. Called on every builder below. */
export function assertBalances(legs: readonly PostingLeg[]): void {
  let debit = 0n;
  let credit = 0n;
  for (const l of legs) {
    if (l.amountMinor < 0n) {
      throw new PostingImbalance(
        `A journal leg carries a negative amount (${l.role}). Direction belongs in entryType, never in the sign.`,
      );
    }
    if (l.entryType === "debit") debit += l.amountMinor;
    else credit += l.amountMinor;
  }
  if (debit !== credit) {
    throw new PostingImbalance(
      `Journal does not balance: debits ${debit}, credits ${credit}, difference ${debit - credit} paise.`,
    );
  }
}

/**
 * ⭐ AN ISSUED TAX INVOICE.
 *
 *     Dr  Sundry Debtors        total
 *         Cr  Sales                       taxable
 *         Cr  Output CGST / SGST / IGST   tax
 *         Cr  Output Cess                 cess
 *         Cr/Dr Round off                 the balancing paise
 *
 * ⚠️ THE TAX IS A LIABILITY, NOT REVENUE. Crediting the whole invoice to
 * sales overstates turnover by the GST and leaves nothing in "Duties &
 * Taxes" — so the P&L looks better than it is and the money owed to the
 * Government is nowhere on the balance sheet. This is the single most
 * common way a small ERP gets books wrong.
 *
 * ⚠️ REVERSE CHARGE IS DELIBERATELY NOT SPECIAL-CASED HERE. Under
 * Section 9(3)/9(4) no tax is collected, so `cgst/sgst/igst` on the
 * document are already zero and the zero legs drop out on their own. A
 * branch checking `isReverseCharge` would be a second place for the rule
 * to be stated, and the two would eventually disagree.
 */
export function buildInvoicePosting(args: {
  tax: SalesTaxBreakdown;
  invoiceNumber: string;
  customerName: string | null;
}): PostingLeg[] {
  const { tax } = args;
  const who = args.customerName ? ` — ${args.customerName}` : "";
  const ref = `Invoice ${args.invoiceNumber}${who}`;

  const legs: PostingLeg[] = [
    ...leg("receivable", "debit", tax.totalMinor, ref),
    ...leg("revenue", "credit", tax.taxableValueMinor, ref),
    ...leg("output_cgst", "credit", tax.cgstMinor, `CGST on ${args.invoiceNumber}`),
    ...leg("output_sgst", "credit", tax.sgstMinor, `SGST/UTGST on ${args.invoiceNumber}`),
    ...leg("output_igst", "credit", tax.igstMinor, `IGST on ${args.invoiceNumber}`),
    ...leg("output_cess", "credit", tax.cessMinor, `Cess on ${args.invoiceNumber}`),
    ...(tax.roundOffMinor >= 0n
      ? leg("round_off", "credit", tax.roundOffMinor, `Round off on ${args.invoiceNumber}`)
      : leg("round_off", "debit", -tax.roundOffMinor, `Round off on ${args.invoiceNumber}`)),
  ];

  assertBalances(legs);
  return legs;
}

/**
 * ⭐ AN ISSUED CREDIT NOTE — the invoice posting, mirrored.
 *
 * ⚠️ IT IS A MIRROR, NOT A NEGATIVE INVOICE. Every leg keeps a positive
 * amount and flips direction, so revenue is DEBITED and the receivable
 * CREDITED. Posting negative credits instead would balance, and would
 * make turnover for the month read as gross sales with a negative
 * bolted on — which is not what a P&L is supposed to show, and not what
 * Tally accepts.
 *
 * ⚠️ THE OUTPUT TAX IS DEBITED, reducing the liability. A credit note
 * that reverses revenue but leaves the GST behind leaves the tenant
 * owing the Government tax on a supply that came back.
 */
export function buildCreditNotePosting(args: {
  tax: SalesTaxBreakdown;
  creditNoteNumber: string;
  invoiceNumber: string;
  customerName: string | null;
}): PostingLeg[] {
  const { tax } = args;
  const who = args.customerName ? ` — ${args.customerName}` : "";
  const ref = `Credit note ${args.creditNoteNumber} against ${args.invoiceNumber}${who}`;

  const legs: PostingLeg[] = [
    ...leg("revenue", "debit", tax.taxableValueMinor, ref),
    ...leg("output_cgst", "debit", tax.cgstMinor, `CGST reversed — ${args.creditNoteNumber}`),
    ...leg("output_sgst", "debit", tax.sgstMinor, `SGST/UTGST reversed — ${args.creditNoteNumber}`),
    ...leg("output_igst", "debit", tax.igstMinor, `IGST reversed — ${args.creditNoteNumber}`),
    ...leg("output_cess", "debit", tax.cessMinor, `Cess reversed — ${args.creditNoteNumber}`),
    ...(tax.roundOffMinor >= 0n
      ? leg("round_off", "debit", tax.roundOffMinor, `Round off — ${args.creditNoteNumber}`)
      : leg("round_off", "credit", -tax.roundOffMinor, `Round off — ${args.creditNoteNumber}`)),
    ...leg("receivable", "credit", tax.totalMinor, ref),
  ];

  assertBalances(legs);
  return legs;
}

/**
 * ⭐ A CUSTOMER RECEIPT.
 *
 *     Dr  Bank              cash actually received
 *     Dr  TDS receivable    tax the customer withheld
 *         Cr  Sundry Debtors      the whole amount
 *
 * 🔴 TDS IS DEBITED TO AN ASSET, NOT WRITTEN OFF. The customer withheld
 *    it and paid it to the Government on our behalf — it is money we are
 *    owed by the Government and will claim against our own tax. Treating
 *    it as a discount or a bad debt understates assets and overstates
 *    expenses, and the credit is then never claimed.
 *
 * ⚠️ AND THE CUSTOMER IS CREDITED THE FULL AMOUNT, cash plus TDS. A
 * customer who withheld tax has settled that part of the invoice as
 * surely as if they had wired it. Crediting only the cash leaves a
 * permanent shortfall on their account and a dunning letter to somebody
 * who paid in full.
 */
export function buildReceiptPosting(args: {
  cashMinor: bigint;
  tdsMinor: bigint;
  receiptNumber: string;
  customerName: string | null;
}): PostingLeg[] {
  const who = args.customerName ? ` — ${args.customerName}` : "";
  const ref = `Receipt ${args.receiptNumber}${who}`;

  const legs: PostingLeg[] = [
    ...leg("bank", "debit", args.cashMinor, ref),
    ...leg("tds_receivable", "debit", args.tdsMinor, `TDS withheld on ${args.receiptNumber}`),
    ...leg("receivable", "credit", args.cashMinor + args.tdsMinor, ref),
  ];

  assertBalances(legs);
  return legs;
}

/** Every role a set of legs needs a ledger for. */
export function rolesUsed(legs: readonly PostingLeg[]): PostingRole[] {
  return [...new Set(legs.map((l) => l.role))];
}

/**
 * ⚠️ EVERY ROLE, WITH WHAT IT IS FOR — this drives the mapping screen.
 * A picker listing bare snake_case roles gets mapped wrongly once and
 * then produces confidently balanced, confidently wrong books.
 */
export const POSTING_ROLE_META: Record<
  PostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  receivable: {
    label: "Sundry Debtors",
    tallyGroup: "Sundry Debtors",
    accountType: "asset",
    help: "What customers owe you. Debited when an invoice is issued, credited when they pay.",
  },
  revenue: {
    label: "Sales",
    tallyGroup: "Sales Accounts",
    accountType: "revenue",
    help: "Turnover, NET of GST. The tax is a liability, not income.",
  },
  output_cgst: {
    label: "Output CGST",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Central GST collected on intra-State supplies, owed to the Government.",
  },
  output_sgst: {
    label: "Output SGST / UTGST",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "State or Union Territory GST collected on intra-State supplies.",
  },
  output_igst: {
    label: "Output IGST",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Integrated GST collected on inter-State supplies.",
  },
  output_cess: {
    label: "Output Cess",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Compensation cess, where it applies. Map it even if you think it never will.",
  },
  round_off: {
    label: "Round Off",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "The balancing paise. Small, and the posting cannot complete without it.",
  },
  bank: {
    label: "Bank / Cash",
    tallyGroup: "Bank Accounts",
    accountType: "asset",
    help: "Where customer receipts land.",
  },
  tds_receivable: {
    label: "TDS Receivable",
    tallyGroup: "Current Assets",
    accountType: "asset",
    help: "Tax a customer withheld and paid on your behalf. An asset you claim, never a write-off.",
  },
};

/* ================================================================== */
/* ⭐ THE PURCHASE SIDE — Phase 59                                      */
/* ================================================================== */

/**
 * ⚠️ THE PURCHASE ROLES LIVE IN THIS FILE ON PURPOSE. Sales and purchase
 * are the same machine pointed in opposite directions, and the one thing
 * that must never happen is the two drifting into different conventions
 * for the round-off leg or the sign of a tax reversal. One file, one set
 * of rules, one `assertBalances`.
 */
export type PurchasePostingRole =
  /** Sundry Creditors — what we owe the vendor. */
  | "payable"
  /** Purchases / expense. ⚠️ Blocked ITC is added here, as cost. */
  | "expense"
  | "input_cgst"
  | "input_sgst"
  | "input_igst"
  | "input_cess"
  /** Reverse charge: the credit we take. */
  | "input_tax_rcm"
  /** Reverse charge: the cash we owe the Government. */
  | "rcm_payable"
  | "purchase_round_off";

export type PurchaseLeg = {
  role: PurchasePostingRole;
  entryType: "debit" | "credit";
  amountMinor: bigint;
  description: string;
};

function pleg(
  role: PurchasePostingRole,
  entryType: "debit" | "credit",
  amountMinor: bigint,
  description: string,
): PurchaseLeg[] {
  return amountMinor === 0n ? [] : [{ role, entryType, amountMinor, description }];
}

export function assertPurchaseBalances(legs: readonly PurchaseLeg[]): void {
  assertBalances(
    legs.map((l) => ({
      role: "revenue" as PostingRole,
      entryType: l.entryType,
      amountMinor: l.amountMinor,
      description: l.description,
    })),
  );
}

/** One purchase invoice line, as posting needs it. */
export type PurchaseLineFacts = {
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  /**
   * ⚠️ `blocked` MEANS SECTION 17(5), NOT "unsure". Rule 42 common credit
   * counts as ELIGIBLE here — the whole common credit enters the ledger
   * and the ineligible share is reversed separately, in its own period.
   * That is what `runRule42ForPeriod` exists to do, and pre-emptively
   * treating common credit as cost would double the reversal.
   */
  itcBlocked: boolean;
};

/**
 * ⭐ A PURCHASE INVOICE.
 *
 *     Dr  Purchases / Expense     taxable + BLOCKED tax
 *     Dr  Input CGST / SGST / IGST / Cess    the ELIGIBLE tax only
 *         Cr  Sundry Creditors                        invoice total
 *     Dr/Cr  Round off
 *
 * 🔴 BLOCKED INPUT TAX IS COST, NOT AN ASSET. Section 17(5) credit can
 *    never be claimed — a motor car, a works contract for immovable
 *    property, staff welfare. Parking it in an input-tax ledger creates
 *    an asset that will never convert to anything, understates the
 *    expense it belongs to, and leaves a GST credit ledger that never
 *    reconciles to the portal. It is added to the cost of the thing that
 *    was bought, which is where it actually landed.
 *
 * ⚠️ THE ELIGIBLE SPLIT IS TAKEN LINE BY LINE, NEVER APPORTIONED FROM
 * THE HEADER. `itc_eligible_tax_minor` on the header is one number with
 * no head breakdown; splitting it pro rata across CGST/SGST/IGST would
 * invent paise the lines already know exactly. The header roll-up is
 * proved against the lines by a trigger, so the two cannot disagree.
 *
 * ⚠️ A POSITIVE ROUND-OFF IS A **DEBIT** HERE — the mirror of the sales
 * side. Copying the sales sign is the obvious mistake and it produces a
 * transaction that fails the Phase 4 balance trigger at COMMIT.
 */
export function buildPurchasePosting(args: {
  lines: readonly PurchaseLineFacts[];
  roundOffMinor: bigint;
  totalMinor: bigint;
  invoiceNumber: string;
  vendorName: string | null;
}): PurchaseLeg[] {
  const who = args.vendorName ? ` — ${args.vendorName}` : "";
  const ref = `Purchase ${args.invoiceNumber}${who}`;

  let expense = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;

  for (const l of args.lines) {
    expense += l.taxableValueMinor;
    if (l.itcBlocked) {
      expense += l.cgstMinor + l.sgstMinor + l.igstMinor + l.cessMinor;
    } else {
      cgst += l.cgstMinor;
      sgst += l.sgstMinor;
      igst += l.igstMinor;
      cess += l.cessMinor;
    }
  }

  const legs: PurchaseLeg[] = [
    ...pleg("expense", "debit", expense, ref),
    ...pleg("input_cgst", "debit", cgst, `Input CGST on ${args.invoiceNumber}`),
    ...pleg("input_sgst", "debit", sgst, `Input SGST/UTGST on ${args.invoiceNumber}`),
    ...pleg("input_igst", "debit", igst, `Input IGST on ${args.invoiceNumber}`),
    ...pleg("input_cess", "debit", cess, `Input cess on ${args.invoiceNumber}`),
    ...(args.roundOffMinor >= 0n
      ? pleg("purchase_round_off", "debit", args.roundOffMinor, `Round off on ${args.invoiceNumber}`)
      : pleg("purchase_round_off", "credit", -args.roundOffMinor, `Round off on ${args.invoiceNumber}`)),
    ...pleg("payable", "credit", args.totalMinor, ref),
  ];

  assertPurchaseBalances(legs);
  return legs;
}

/**
 * ⭐ REVERSE CHARGE — A SECOND, SEPARATE TRANSACTION.
 *
 * 🔴 IT IS NOT PART OF THE INVOICE POSTING, AND `rcm_tax_minor` IS NOT
 *    PART OF `total_minor`. The vendor did not charge this tax and is not
 *    owed it. Folding it into the invoice would credit the VENDOR money
 *    that is owed to the GOVERNMENT — a payable against the wrong party,
 *    which is only discovered when somebody pays the vendor too much.
 *
 *     Dr  Input tax (RCM)     the credit we may claim
 *         Cr  RCM payable             the cash we owe, Section 49(4)
 *
 * ⚠️ BOTH LEGS, ALWAYS. Booking only the credit is the common error, and
 * `db/schema/purchases.ts` already names it: the return then shows a
 * credit with no corresponding liability, which is exactly the pattern
 * GSTR-2B reconciliation surfaces.
 *
 * ⚠️ NO HEAD SPLIT IS INVENTED. `rcm_tax_minor` is stored as one figure
 * with no CGST/SGST/IGST breakdown. Halving it for an intra-State supply
 * would be right to the rupee and wrong by a paisa on an odd amount, and
 * would be a second source of truth for something the header never
 * claimed to know. One RCM input role, one RCM payable role.
 */
export function buildRcmPosting(args: {
  rcmTaxMinor: bigint;
  invoiceNumber: string;
  rcmSection: string | null;
  vendorName: string | null;
}): PurchaseLeg[] {
  if (args.rcmTaxMinor <= 0n) return [];
  const section = args.rcmSection ? ` (Section ${args.rcmSection})` : "";
  const who = args.vendorName ? ` — ${args.vendorName}` : "";
  const ref = `Reverse charge on ${args.invoiceNumber}${section}${who}`;

  const legs: PurchaseLeg[] = [
    ...pleg("input_tax_rcm", "debit", args.rcmTaxMinor, ref),
    ...pleg("rcm_payable", "credit", args.rcmTaxMinor, ref),
  ];

  assertPurchaseBalances(legs);
  return legs;
}

export function purchaseRolesUsed(legs: readonly PurchaseLeg[]): PurchasePostingRole[] {
  return [...new Set(legs.map((l) => l.role))];
}

export const PURCHASE_ROLE_META: Record<
  PurchasePostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  payable: {
    label: "Sundry Creditors",
    tallyGroup: "Sundry Creditors",
    accountType: "liability",
    help: "What you owe vendors. Credited when a bill is booked.",
  },
  expense: {
    label: "Purchases / Expenses",
    tallyGroup: "Purchase Accounts",
    accountType: "expense",
    help: "The cost itself — plus any input tax blocked under Section 17(5), because that tax is cost and never an asset.",
  },
  input_cgst: {
    label: "Input CGST",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "Central GST you may claim back. Only the eligible part reaches here.",
  },
  input_sgst: {
    label: "Input SGST / UTGST",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "State GST you may claim back.",
  },
  input_igst: {
    label: "Input IGST",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "Integrated GST you may claim back.",
  },
  input_cess: {
    label: "Input Cess",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "Compensation cess credit, claimable only against cess.",
  },
  input_tax_rcm: {
    label: "Input Tax (Reverse Charge)",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "Credit for tax you self-assessed. Claimable only after it is actually paid in cash.",
  },
  rcm_payable: {
    label: "RCM Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Tax you owe the Government on a reverse-charge supply. Section 49(4) — it must be paid in cash, not from the credit ledger.",
  },
  purchase_round_off: {
    label: "Round Off (Purchases)",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "The balancing paise on a vendor bill. Can be mapped to the same ledger as the sales round-off.",
  },
};

/* ================================================================== */
/* ⭐ CONSTRUCTION — RA BILLS — Phase 60                                */
/* ================================================================== */

/**
 * ⚠️ THE CONTRACTOR IS A SUNDRY CREDITOR — the `payable` role is reused
 * rather than a `contractor_payable` twin. A vendor bill and an RA bill
 * both end in money owed to somebody who did work for us, and two
 * ledgers for one relationship means a vendor's true balance is the sum
 * of two screens.
 */
export type ConstructionPostingRole =
  /** Work certified, before deductions. */
  | "wip"
  /** Held back under the contract. Released at defect liability end. */
  | "retention_payable"
  /** ⚠️ TDS we DEDUCT from a contractor — a liability, not the sales-side asset. */
  | "tds_payable"
  /** BOCW cess, deducted and deposited. */
  | "labour_cess_payable"
  /** Advances recovered, penalties, price adjustments. */
  | "contractor_recovery";

export type ConstructionLeg = {
  role: ConstructionPostingRole | "payable";
  entryType: "debit" | "credit";
  amountMinor: bigint;
  description: string;
};

function cleg(
  role: ConstructionPostingRole | "payable",
  entryType: "debit" | "credit",
  amountMinor: bigint,
  description: string,
): ConstructionLeg[] {
  return amountMinor === 0n ? [] : [{ role, entryType, amountMinor, description }];
}

export function assertConstructionBalances(legs: readonly ConstructionLeg[]): void {
  assertBalances(
    legs.map((l) => ({
      role: "revenue" as PostingRole,
      entryType: l.entryType,
      amountMinor: l.amountMinor,
      description: l.description,
    })),
  );
}

/**
 * ⭐ A CERTIFIED RA BILL.
 *
 *     Dr  Work in Progress          gross value certified
 *         Cr  Retention payable            held back
 *         Cr  TDS payable                  deducted, owed to the Government
 *         Cr  Labour cess payable          BOCW cess, deducted and deposited
 *         Cr  Contractor recovery          advances recovered, penalties
 *         Cr  Sundry Creditors             what the contractor actually gets
 *
 * 🔴 A NEGATIVE NET PAYABLE IS NOT AN ERROR, AND IT IS THE CASE THIS
 *    FUNCTION EXISTS TO GET RIGHT. `db/schema/contracting.ts` says so
 *    outright: recovered advances can exceed the work certified in a lean
 *    month. When that happens the contractor **owes us**, so the payable
 *    leg becomes a **DEBIT** — never a credit carrying a minus sign,
 *    which `assertBalances` refuses anyway.
 *
 * ⚠️ POSTED ON CERTIFICATION, NOT ON APPROVAL OR PAYMENT. Certification
 * is the engineer saying the work exists. That is when the cost was
 * incurred, and accrual accounting recognises it then — waiting for
 * payment would understate cost at every month end and overstate it in
 * whichever month the cheque cleared.
 *
 * ⚠️ RETENTION IS A LIABILITY, NOT A REDUCTION OF COST. The work was
 * done and the money is owed; it is simply not payable yet. Netting it
 * against WIP understates the asset and makes the release, months later,
 * look like a fresh expense.
 *
 * ⚠️ `contractor_recovery` IS AN HONEST BUCKET, AND IT IS A KNOWN GAP.
 * `other_deductions_minor` mixes advance recovery (which should reduce
 * the advance asset in `contract_advances`) with penalties (which are
 * income) and price adjustments (which reduce cost). There is no column
 * saying which is which, so splitting them here would be invention. One
 * role, and a note in the docs, until the column exists.
 */
export function buildRaBillPosting(args: {
  grossValueMinor: bigint;
  retentionAmountMinor: bigint;
  tdsAmountMinor: bigint;
  cessAmountMinor: bigint;
  otherDeductionsMinor: bigint;
  netPayableMinor: bigint;
  billNumber: string;
  contractorName: string | null;
}): ConstructionLeg[] {
  const who = args.contractorName ? ` — ${args.contractorName}` : "";
  const ref = `RA bill ${args.billNumber}${who}`;

  const legs: ConstructionLeg[] = [
    ...cleg("wip", "debit", args.grossValueMinor, ref),
    ...cleg(
      "retention_payable",
      "credit",
      args.retentionAmountMinor,
      `Retention held — ${args.billNumber}`,
    ),
    ...cleg("tds_payable", "credit", args.tdsAmountMinor, `TDS deducted — ${args.billNumber}`),
    ...cleg(
      "labour_cess_payable",
      "credit",
      args.cessAmountMinor,
      `Labour cess — ${args.billNumber}`,
    ),
    ...cleg(
      "contractor_recovery",
      "credit",
      args.otherDeductionsMinor,
      `Recoveries and deductions — ${args.billNumber}`,
    ),
    ...(args.netPayableMinor >= 0n
      ? cleg("payable", "credit", args.netPayableMinor, ref)
      : cleg("payable", "debit", -args.netPayableMinor, `${ref} — recovered in excess`)),
  ];

  assertConstructionBalances(legs);
  return legs;
}

export function constructionRolesUsed(
  legs: readonly ConstructionLeg[],
): (ConstructionPostingRole | "payable")[] {
  return [...new Set(legs.map((l) => l.role))];
}

export const CONSTRUCTION_ROLE_META: Record<
  ConstructionPostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  wip: {
    label: "Work in Progress",
    tallyGroup: "Current Assets",
    accountType: "asset",
    help: "Value of work certified on RA bills, before any deduction. Becomes cost as the project completes.",
  },
  retention_payable: {
    label: "Retention Payable",
    tallyGroup: "Current Liabilities",
    accountType: "liability",
    help: "Held back under the contract and released at the end of the defect liability period. Owed, just not yet payable.",
  },
  tds_payable: {
    label: "TDS Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Income-tax you DEDUCTED from a contractor and owe the Government. ⚠️ Not the same as TDS Receivable, which is tax your customers deducted from you.",
  },
  labour_cess_payable: {
    label: "Labour Cess Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "BOCW cess deducted from the contractor and deposited with the welfare board.",
  },
  contractor_recovery: {
    label: "Recoveries & Deductions",
    tallyGroup: "Current Liabilities",
    accountType: "liability",
    help: "Advances recovered, penalties and price adjustments. A mixed bucket today — the RA bill does not record which is which.",
  },
};

/* ================================================================== */
/* ⭐ REAL ESTATE — Phase 61                                            */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE THING THIS WHOLE SECTION TURNS ON
 * ══════════════════════════════════════════════════════════════════════
 * MONEY COLLECTED FROM A HOME BUYER BEFORE POSSESSION IS **NOT REVENUE**.
 *
 * Under Ind AS 115 (and IFRS 15, which it mirrors) a residential
 * developer in India transfers control of the flat at POSSESSION — a
 * point in time, not over time — because the buyer cannot direct the use
 * of a half-built apartment and the developer retains an enforceable
 * right to payment only for work done, not for the asset.
 *
 * ⚠️ THE PRE-2018 PERCENTAGE-OF-COMPLETION HABIT IS WHY THIS IS WORTH
 * SHOUTING ABOUT. A developer who books demand notices to revenue shows
 * their entire pre-sales as turnover: a P&L reporting ₹40 crore of
 * income on a project that has not handed over a single key, profit that
 * has never existed, and tax computed on it. It balances perfectly.
 *
 * So the model has THREE stages and they are deliberately separate:
 *
 *   1. DEMAND RAISED   Dr Booking receivable
 *                          Cr Advance from customers  ← a LIABILITY
 *                          Cr Output CGST/SGST/IGST
 *   2. MONEY RECEIVED  Dr Bank
 *                          Cr Booking receivable
 *   3. POSSESSION      Dr Advance from customers
 *                          Cr Revenue                 ← the ONLY revenue leg
 *
 * ⚠️ AND THE GST IS PAYABLE AT STAGE 1, NOT STAGE 3. Time of supply for
 * construction services is the earlier of the invoice or the payment
 * (Section 13), so the output liability arises when the demand is raised
 * even though the revenue does not. Those two dates being different is
 * the single most confusing thing about developer accounting, and
 * modelling them as one is how the GST liability ends up understated by
 * a whole project.
 */
export type PropertyPostingRole =
  /** What a buyer owes on demands raised. */
  | "booking_receivable"
  /** 🔴 Money collected before possession. A LIABILITY, never revenue. */
  | "customer_advance"
  /** Recognised at possession, and nowhere else. */
  | "property_revenue"
  /** Interest charged on a late instalment. Income when charged. */
  | "delay_interest_income"
  /** Booking money kept when a buyer walks away. */
  | "forfeiture_income";

export type PropertyLeg = {
  /**
   * ⚠️ SHARED ROLES ARE REUSED, NOT TWINNED. Output GST, the bank and
   * TDS receivable mean exactly the same thing whether the document was
   * a tax invoice or a demand notice — and one debt split across two
   * ledgers is a debt nobody can reconcile.
   */
  role:
    | PropertyPostingRole
    | "output_cgst"
    | "output_sgst"
    | "output_igst"
    | "output_cess"
    | "bank"
    | "tds_receivable";
  entryType: "debit" | "credit";
  amountMinor: bigint;
  description: string;
};

function rleg(
  role: PropertyLeg["role"],
  entryType: "debit" | "credit",
  amountMinor: bigint,
  description: string,
): PropertyLeg[] {
  return amountMinor === 0n ? [] : [{ role, entryType, amountMinor, description }];
}

export function assertPropertyBalances(legs: readonly PropertyLeg[]): void {
  assertBalances(
    legs.map((l) => ({
      role: "revenue" as PostingRole,
      entryType: l.entryType,
      amountMinor: l.amountMinor,
      description: l.description,
    })),
  );
}

/**
 * ⭐ STAGE 1 — a demand notice served on a buyer.
 *
 * ⚠️ THE OUTPUT TAX ROLES ARE THE **SAME** ONES THE SALES SIDE USES.
 * GST owed to the Government is one liability whatever produced it, and
 * splitting it into "output CGST" and "output CGST (property)" gives a
 * balance sheet with two numbers for one debt and a GSTR-3B that has to
 * be assembled by hand from both.
 */
export function buildDemandPosting(args: {
  principalMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  totalMinor: bigint;
  demandNumber: string;
  bookingReference: string;
  buyerName: string | null;
}): PropertyLeg[] {
  const who = args.buyerName ? ` — ${args.buyerName}` : "";
  const ref = `Demand ${args.demandNumber} · booking ${args.bookingReference}${who}`;

  const legs: PropertyLeg[] = [
    ...rleg("booking_receivable", "debit", args.totalMinor, ref),
    /**
     * 🔴 THE LEG THAT MAKES THIS RIGHT. Not revenue. Not "unearned
     * revenue" filed under income. A liability — the buyer's money, held
     * until a key changes hands.
     */
    ...rleg("customer_advance", "credit", args.principalMinor, ref),
    ...rleg("output_cgst", "credit", args.cgstMinor, `CGST on ${args.demandNumber}`),
    ...rleg("output_sgst", "credit", args.sgstMinor, `SGST/UTGST on ${args.demandNumber}`),
    ...rleg("output_igst", "credit", args.igstMinor, `IGST on ${args.demandNumber}`),
    ...rleg("output_cess", "credit", args.cessMinor, `Cess on ${args.demandNumber}`),
  ];

  assertPropertyBalances(legs);
  return legs;
}

/**
 * ⭐ STAGE 2 — money arrives.
 *
 * ⚠️ IT TOUCHES NEITHER REVENUE NOR THE ADVANCE. Both were already
 * recorded when the demand was raised. A receipt only converts a
 * receivable into cash — and posting it to revenue as well is the
 * double-count that makes a developer's turnover exactly twice its
 * collections.
 *
 * ⚠️ TDS UNDER SECTION 194-IA IS RECEIVED MONEY. A buyer paying for a
 * property above ₹50 lakh deducts 1% and pays it to the Government on
 * the developer's behalf. Recording only the bank credit leaves every
 * such booking permanently 1% short and generates a dunning letter for
 * a buyer who paid in full.
 */
export function buildBookingReceiptPosting(args: {
  cashMinor: bigint;
  tdsMinor: bigint;
  receiptNumber: string;
  bookingReference: string;
  buyerName: string | null;
}): PropertyLeg[] {
  const who = args.buyerName ? ` — ${args.buyerName}` : "";
  const ref = `Receipt ${args.receiptNumber} · booking ${args.bookingReference}${who}`;

  const legs: PropertyLeg[] = [
    ...rleg("bank", "debit", args.cashMinor, ref),
    /**
     * ⚠️ THE SAME `tds_receivable` ROLE THE SALES SIDE USES. It is the
     * same asset — tax somebody withheld from us and paid to the
     * Government on our behalf. A property-specific twin would split one
     * claimable balance across two ledgers, and neither would agree with
     * Form 26AS.
     */
    ...rleg(
      "tds_receivable",
      "debit",
      args.tdsMinor,
      `TDS u/s 194-IA withheld on ${args.receiptNumber}`,
    ),
    ...rleg("booking_receivable", "credit", args.cashMinor + args.tdsMinor, ref),
  ];

  assertPropertyBalances(legs);
  return legs;
}

/**
 * ⭐ STAGE 3 — POSSESSION. The only place property revenue is recognised.
 *
 * ⚠️ IT MOVES THE WHOLE ADVANCE, NOT THE CASH COLLECTED. A buyer may
 * still owe the final instalment on the day they take the keys; control
 * has transferred and the revenue is earned in full. Recognising only
 * what was collected would defer revenue to a payment that has nothing
 * to do with when the flat was handed over.
 */
export function buildPossessionPosting(args: {
  advanceMinor: bigint;
  bookingReference: string;
  unitLabel: string | null;
  buyerName: string | null;
}): PropertyLeg[] {
  const what = args.unitLabel ? ` · ${args.unitLabel}` : "";
  const who = args.buyerName ? ` — ${args.buyerName}` : "";
  const ref = `Possession · booking ${args.bookingReference}${what}${who}`;

  const legs: PropertyLeg[] = [
    ...rleg("customer_advance", "debit", args.advanceMinor, ref),
    ...rleg("property_revenue", "credit", args.advanceMinor, ref),
  ];

  assertPropertyBalances(legs);
  return legs;
}

export function propertyRolesUsed(legs: readonly PropertyLeg[]): PropertyLeg["role"][] {
  return [...new Set(legs.map((l) => l.role))];
}

export const PROPERTY_ROLE_META: Record<
  PropertyPostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  booking_receivable: {
    label: "Booking Receivable",
    tallyGroup: "Sundry Debtors",
    accountType: "asset",
    help: "What home buyers owe on demands raised. Separate from trade debtors so project collections can be read on their own.",
  },
  customer_advance: {
    label: "Advance from Customers",
    tallyGroup: "Current Liabilities",
    accountType: "liability",
    help: "🔴 Money collected before possession. It is the buyer's until a key changes hands — a LIABILITY, never revenue.",
  },
  property_revenue: {
    label: "Property Sales Revenue",
    tallyGroup: "Sales Accounts",
    accountType: "revenue",
    help: "Recognised at POSSESSION only, under Ind AS 115. Nothing reaches here while a flat is under construction.",
  },
  delay_interest_income: {
    label: "Delay Interest Income",
    tallyGroup: "Indirect Income",
    accountType: "revenue",
    help: "Interest charged on a late instalment. Income when charged, and taxable separately from the flat.",
  },
  forfeiture_income: {
    label: "Forfeiture Income",
    tallyGroup: "Indirect Income",
    accountType: "revenue",
    help: "Booking money kept when a buyer cancels. ⚠️ RERA caps what may be forfeited — check the agreement before this figure is set.",
  },
};
