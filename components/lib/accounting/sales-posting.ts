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
  | "tds_receivable"
  /**
   * ⭐⭐ THE STOCK COUNT ROLES, ADDED IN v1.18.0.
   *
   * 🔴 THERE ARE TWO VARIANCE ROLES AND NOT ONE, ON PURPOSE. Posting
   * gains and losses to a single "stock adjustment" account nets them
   * off in the trial balance, and "how much stock did we lose this
   * year" then has no answer anywhere in the system. An auditor asks
   * that question, and "we net it off" is not an answer.
   */
  | "inventory_asset"
  /** Stock found that the books did not have. A credit, reducing cost. */
  | "inventory_variance_gain"
  /** Stock the books had and the shelf did not. Shrinkage. */
  | "inventory_variance_loss"
  /**
   * ⭐⭐ THE TWO BANK-RECONCILIATION ROLES, ADDED IN v1.63.0 (0102).
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THESE ARE THE ENTRIES THE BOOKS DO NOT HAVE AND THE BANK DOES
   * ══════════════════════════════════════════════════════════════════
   * A bank charge and a credit of interest appear on the statement and
   * nowhere else. Before 0102 the reconciliation screen was where they
   * were DISCOVERED and somewhere else entirely was where they had to be
   * WRITTEN UP, which meant in practice that they were written up at
   * year end from a printed statement, or not at all.
   *
   * ⚠️ TWO ROLES AND NOT ONE. Netting charges against interest in a
   * single "bank adjustments" account makes both invisible: "what did
   * this bank cost us this year" is a question with an answer, and
   * netting it against interest income is not that answer. It is the
   * same argument as the two stock-variance roles above.
   */
  | "bank_charges"
  | "bank_interest_income";

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
  inventory_asset: {
    label: "Stock in Hand",
    tallyGroup: "Stock-in-Hand",
    accountType: "asset",
    help: "The value of stock you hold. A posted stock count moves this by the NET difference it found, because that is what the stock is now actually worth.",
  },
  inventory_variance_gain: {
    label: "Stock Found",
    tallyGroup: "Indirect Incomes",
    accountType: "revenue",
    help: "Stock a count found that the books did not have. Usually a receipt nobody entered or an earlier miscount, so it is worth reading rather than welcoming.",
  },
  inventory_variance_loss: {
    label: "Stock Shrinkage",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "Stock the books had and the shelf did not. Kept separate from Stock Found on purpose: netting the two makes a bad month look like a quiet one, and 'how much stock did we lose this year' stops having an answer.",
  },
  bank_charges: {
    label: "Bank Charges",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "What the bank took: fees, NEFT and RTGS charges, cheque return charges. Found on the statement, so posted from the reconciliation screen. ⚠️ THE GST ON A BANK CHARGE IS NOT SPLIT OUT HERE — the statement line is one gross figure with no GSTIN, no invoice number and no rate on it. Claim the input credit from the bank's own tax invoice; deriving it from this line would put an unsupported claim in GSTR-3B.",
  },
  bank_interest_income: {
    label: "Bank Interest Received",
    tallyGroup: "Indirect Incomes",
    accountType: "revenue",
    help: "Interest the bank credited. Kept apart from Bank Charges on purpose: netting the two hides both, and interest received is taxable income that has to be reported whether or not charges happened to exceed it.",
  },
};

/* ================================================================== */
/* ⭐⭐ THE BANK RECONCILIATION ADJUSTMENT — v1.63.0 (0102)             */
/* ================================================================== */

/**
 * ⚠️ NARROW ON PURPOSE. Exactly two things found on a bank statement can
 * be written up from the statement alone with no further evidence:
 *
 *   bank_charge       the bank took money for its own services
 *   interest_credited the bank gave money for holding ours
 *
 * 🔴 EVERYTHING ELSE ON THAT LIST IS A DOCUMENT SOMEWHERE ELSE. A direct
 * debit is a vendor payment, an unexpected credit is a customer receipt,
 * and a transfer is a transfer. Offering a free-text "other adjustment"
 * here would turn the reconciliation screen into a general journal with
 * no counterparty, no tax treatment and no document behind it — and it
 * would be used, because it is the fastest way to make the screen go
 * green. The two kinds below are the ones where the statement genuinely
 * IS the evidence.
 */
export type BankAdjustmentKind = "bank_charge" | "interest_credited";

/**
 * ⭐ THE BANK LEG IS THE ACCOUNT'S OWN LEDGER, NOT THE GENERIC `bank`
 * ROLE — resolved by the caller and passed to `postBankAdjustment` as an
 * override, because a tenant with three bank accounts has one `bank`
 * role and posting an HDFC charge to the ICICI ledger would leave both
 * accounts permanently unreconcilable.
 */
export function buildBankAdjustmentPosting(args: {
  kind: BankAdjustmentKind;
  /** 🔴 POSITIVE MAGNITUDE. The direction comes from `kind`. */
  amountMinor: bigint;
  narration: string;
}): PostingLeg[] {
  if (args.amountMinor <= 0n) {
    throw new PostingImbalance(
      "A bank adjustment of zero or less is not an adjustment. The direction comes from the kind, never from the sign.",
    );
  }

  const description = args.narration.replace(/\s+/g, " ").trim().slice(0, 300);

  const legs: PostingLeg[] =
    args.kind === "bank_charge"
      ? [
          // The bank took it: the expense rises and the asset falls.
          { role: "bank_charges", entryType: "debit", amountMinor: args.amountMinor, description },
          { role: "bank", entryType: "credit", amountMinor: args.amountMinor, description },
        ]
      : [
          // The bank gave it: the asset rises and income is earned.
          { role: "bank", entryType: "debit", amountMinor: args.amountMinor, description },
          {
            role: "bank_interest_income",
            entryType: "credit",
            amountMinor: args.amountMinor,
            description,
          },
        ];

  assertBalances(legs);
  return legs;
}

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
  | "purchase_round_off"
  /**
   * ⭐⭐ ADDED IN v1.11.0 FOR THE PAYMENT, WHICH IS A DIFFERENT EVENT
   *     FROM THE BILL.
   *
   * 🔴 THE BILL CREATES THE LIABILITY. THE PAYMENT SETTLES IT AND
   *    WITHHOLDS THE TAX. Tax is deducted at source when the money
   *    MOVES, not when the bill is booked, which is why the TDS engine
   *    built in 0025 had nothing to hook onto until now.
   */
  /** The bank or cash account the money actually left. */
  | "bank"
  /** 🔴 Withheld from the vendor and owed to the Government. */
  | "tds_payable"
  /** ⚠️ s.16 MSMED interest. Mandatory, compounding, never deductible. */
  | "msme_interest"
  | "payment_round_off"
  /**
   * ⭐⭐ BANK CHARGES, AND IT IS THE SAME ROLE THE SALES SIDE DECLARES.
   *
   * 🔴 IT IS HERE BECAUSE THE INPUT CREDIT ON A BANK CHARGE IS A PURCHASE
   *    POSTING WITH AN EXPENSE ON THE CREDIT SIDE. The four input tax
   *    heads live in this role set; `bank_charges` lives in `PostingRole`.
   *    Brief F named exactly this and stopped: "the two role sets have to
   *    meet somewhere. That is a decision for whoever owns that file."
   *
   * ⭐ THIS IS THAT DECISION, AND IT COSTS NOTHING. `buildRegistry()`
   *    below keys on the role NAME and the first family to declare it owns
   *    the label and help — `POSTING_ROLE_META` already declares
   *    `bank_charges`, so this adds "purchase" to that entry's module list
   *    and nothing else. One role, one ledger, two modules that need it.
   *
   * ⚠️ THE ALTERNATIVE WAS TO CREDIT `expense`. It would have compiled and
   *    balanced and been wrong: `expense` is Purchases, and crediting it
   *    would take the tax back out of the wrong account and leave Bank
   *    Charges overstated by exactly the credit that was claimed.
   */
  | "bank_charges";

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
/* ================================================================== */
/* ⭐⭐⭐ THE INPUT CREDIT ON A BANK CHARGE — 0112                       */
/* ================================================================== */

/**
 * ⭐⭐⭐ MOVE THE TAX OUT OF BANK CHARGES AND INTO THE INPUT HEADS.
 *
 *     Dr  Input CGST      x
 *     Dr  Input SGST      x
 *         Cr  Bank Charges     2x
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS HAPPENING WITHOUT THIS, AND IT WAS SILENT
 * ══════════════════════════════════════════════════════════════════════
 * `0102` posts a bank charge GROSS, which is correct at that moment: the
 * statement line has no GSTIN, no invoice number and no rate on it, and
 * s.16(2)(a) CGST Act gives no credit without the invoice in hand. `0110`
 * then built the register that records the credit is owed, the refusals
 * that stop a rate being guessed, and the screen that transcribes the
 * bank's invoice when it arrives.
 *
 * And there it stopped. `0110`'s report says so plainly: *"Until it
 * exists, `invoice_recorded` is a worklist state, not a posted credit."*
 * A customer could enter the invoice, watch the arithmetic foot against
 * the money that left the account, and the tax stayed inside Bank
 * Charges in the trial balance. The register knew. The ledger did not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CREDIT SIDE IS AN EXPENSE, AND THAT IS NOT A MISTAKE
 * ══════════════════════════════════════════════════════════════════════
 * Every other purchase posting credits a liability or an asset. This one
 * credits `bank_charges` because the expense was OVERSTATED: the gross
 * went to expense when part of it was recoverable tax. Nothing new is
 * spent here and no money moves. A cost is reclassified as an asset —
 * a receivable from the Government — which is what an input credit is.
 *
 * ⭐ NO ROUND-OFF LEG, AND THERE CANNOT BE ONE. The credit is the exact
 *    sum of the four heads, so debits equal credits by construction.
 *    A round-off leg here would be a place for a transcription error to
 *    hide, and `bank_charge_itc_deferrals_invoice_foots` in 0110 already
 *    refuses a split that does not foot to the gross.
 *
 * 🔴 THE FIGURES ARE TRANSCRIBED, NEVER DERIVED. This function computes
 *    no rate and applies no percentage. It is given four numbers that
 *    were read off a tax invoice and it arranges them. The whole argument
 *    for why is in `lib/banking/bank-charge-itc.ts`; the short version is
 *    that a derived 18% has no supplier invoice number, so it can never
 *    be matched in GSTR-2B and would sit in GSTR-3B as an unsupported
 *    claim.
 */
export function buildBankChargeItcPosting(args: {
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  narration: string;
}): PurchaseLeg[] {
  const credit =
    args.cgstMinor + args.sgstMinor + args.igstMinor + args.cessMinor;

  if (credit <= 0n) {
    throw new PostingImbalance(
      "A bank charge input credit of zero is not a journal. A charge that carried no recoverable tax is marked not claimable with a reason, which is a different fact from a posting of nothing.",
    );
  }

  /**
   * 🔴 REFUSED, NOT NETTED. A negative head is a transcription error and
   * netting it against another would produce a balanced journal that
   * claims a credit nobody was invoiced for.
   */
  if (
    args.cgstMinor < 0n ||
    args.sgstMinor < 0n ||
    args.igstMinor < 0n ||
    args.cessMinor < 0n
  ) {
    throw new PostingImbalance(
      "A tax head on a bank charge invoice cannot be negative. A credit note from the bank is a separate document and reverses through its own entry.",
    );
  }

  const description = args.narration.replace(/\s+/g, " ").trim().slice(0, 300);

  const legs: PurchaseLeg[] = [
    ...pleg("input_cgst", "debit", args.cgstMinor, description),
    ...pleg("input_sgst", "debit", args.sgstMinor, description),
    ...pleg("input_igst", "debit", args.igstMinor, description),
    ...pleg("input_cess", "debit", args.cessMinor, description),
    ...pleg("bank_charges", "credit", credit, description),
  ];

  assertPurchaseBalances(legs);
  return legs;
}

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

/**
 * ⭐⭐⭐ THE VENDOR PAYMENT, AND WHY IT IS THREE NUMBERS AND NOT ONE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TAX IS DEDUCTED WHEN THE MONEY MOVES
 * ══════════════════════════════════════════════════════════════════════
 * Paying a ₹1,00,000 bill with 10% withheld under s.194J is not a
 * ₹90,000 payment against a ₹90,000 liability. The vendor is owed the
 * whole lakh; ten thousand of it goes to the Government instead of to
 * them:
 *
 *     Dr  Sundry Creditors     1,00,000    the liability, in full
 *         Cr  Bank                            90,000
 *         Cr  TDS payable                     10,000
 *
 * ⚠️ THE COMMON ERROR IS DEBITING ONLY THE NET. The vendor's ledger then
 * shows ten thousand still owed, forever, on every bill, and the balance
 * grows all year until somebody writes it off as a "reconciliation
 * difference" — which is the firm writing off its own tax deposits.
 *
 * ⭐ AND s.16 MSMED INTEREST IS A SEPARATE LEG, DEBITED AS AN EXPENSE.
 * It is not part of what the vendor was owed under the bill; it arose
 * because the bill was paid late. Netting it into the settlement would
 * hide a cost that is never deductible in an account that mostly is.
 */
export function buildVendorPaymentPosting(args: {
  /** What the bills are being settled for, in full. */
  grossMinor: bigint;
  /** Withheld and owed to the Government. */
  tdsMinor: bigint;
  /** s.16 MSMED interest paid on top. */
  msmeInterestMinor: bigint;
  roundOffMinor: bigint;
  /** What actually left the bank. */
  netMinor: bigint;
  paymentNumber: string;
  vendorName: string | null;
  tdsSection: string | null;
}): PurchaseLeg[] {
  const who = args.vendorName ? ` — ${args.vendorName}` : "";
  const ref = `Payment ${args.paymentNumber}${who}`;

  if (args.grossMinor < 0n || args.tdsMinor < 0n) {
    throw new Error("A payment cannot have negative amounts.");
  }
  /**
   * ⚠️ CHECKED BEFORE THE NEGATIVE-NET CHECK, deliberately. Withholding
   * more than the payment produces a negative net as a symptom, and
   * reporting the symptom sends somebody looking at the wrong number.
   */
  if (args.tdsMinor > args.grossMinor) {
    throw new Error(
      "More was withheld than the payment itself. That is a sign error, and it would credit the Government money the vendor was never owed.",
    );
  }

  if (args.netMinor < 0n) {
    throw new Error("A payment cannot have negative amounts.");
  }

  const expected =
    args.grossMinor - args.tdsMinor + args.msmeInterestMinor + args.roundOffMinor;
  if (expected !== args.netMinor) {
    throw new Error(
      `The payment does not add up: gross minus TDS plus interest and rounding is ${expected}, and the net recorded is ${args.netMinor}.`,
    );
  }

  const section = args.tdsSection ? ` (Section ${args.tdsSection})` : "";

  const legs: PurchaseLeg[] = [
    /** 🔴 THE LIABILITY IS CLEARED IN FULL, not net of the withholding. */
    ...pleg("payable", "debit", args.grossMinor, ref),
    ...pleg(
      "msme_interest",
      "debit",
      args.msmeInterestMinor,
      `Interest under s.16 MSMED Act on ${args.paymentNumber}${who}`,
    ),
    ...pleg(
      "tds_payable",
      "credit",
      args.tdsMinor,
      `TDS withheld on ${args.paymentNumber}${section}${who}`,
    ),
    ...(args.roundOffMinor >= 0n
      ? pleg("payment_round_off", "debit", args.roundOffMinor, `Round off on ${args.paymentNumber}`)
      : pleg("payment_round_off", "credit", -args.roundOffMinor, `Round off on ${args.paymentNumber}`)),
    ...pleg("bank", "credit", args.netMinor, ref),
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
  bank: {
    label: "Bank / Cash",
    tallyGroup: "Bank Accounts",
    accountType: "asset",
    help: "The account the money actually left. Credited on a vendor payment.",
  },
  tds_payable: {
    label: "TDS Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Withheld from a vendor and owed to the Government. Credited at payment, not when the bill is booked, because tax is deducted when the money moves.",
  },
  msme_interest: {
    label: "Interest on delayed MSME payment",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "Section 16 MSMED Act interest. Mandatory, compounding at three times the RBI bank rate, and never deductible under the Income Tax Act — so it is kept in its own account rather than buried in general interest.",
  },
  payment_round_off: {
    label: "Round Off (Payments)",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "Rounding on a vendor payment.",
  },
  /**
   * ⚠️ THE LABEL AND HELP HERE ARE NEVER SHOWN. `buildRegistry()` gives the
   * entry to the first family that declares a role and `POSTING_ROLE_META`
   * declares `bank_charges` above. It is repeated because
   * `Record<PurchasePostingRole, ...>` requires every member — and that
   * requirement is the point: a purchase role with no meta cannot exist,
   * so no purchase builder can emit a role the posting-accounts screen
   * has never heard of.
   */
  bank_charges: {
    label: "Bank Charges",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "What the bank took. Credited — not debited — by the input-credit posting, which moves the tax out of this account and into the input tax heads once the bank's own invoice is in hand.",
  },
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
  | "forfeiture_income"
  /* --- ⭐⭐ v1.25.0-alpha — cancellation and brokerage ------------- */
  /**
   * 🔴 WHAT IS OWED BACK TO A BUYER WHO CANCELLED, UNTIL IT LEAVES.
   *
   * ⚠️ NOT THE BANK, AND NOT NETTED AGAINST THE ADVANCE. A cancellation
   * and the transfer that settles it are days or months apart, and the
   * developer is a debtor for the whole of that gap. Posting straight to
   * the bank on the day of cancellation shows cash leaving that has not
   * left, and hides a real liability from the balance sheet — which for
   * a developer with a bad quarter is exactly the liability a lender
   * wants to see.
   */
  | "buyer_refund_payable"
  /**
   * 🔴 OUTPUT TAX ON A CANCELLED BOOKING THAT CAN NO LONGER BE REVERSED.
   *
   * The section 34 credit-note window closes on 30 November after the
   * financial year of the supply. A cancellation after that cannot take
   * the tax back, so the developer has paid GST on a sale that never
   * happened. That is a cost, it is not creditable, and it gets its own
   * account so "what did cancellations cost us" has an answer.
   */
  | "irrecoverable_output_tax"
  /** Brokerage earned by a channel partner. An expense when incurred. */
  | "brokerage_expense"
  /** ⚠️ What is owed to the partner AFTER tax is withheld, not before. */
  | "partner_payable";

export type PropertyLeg = {
  /**
   * ⚠️ SHARED ROLES ARE REUSED, NOT TWINNED. Output GST, the bank and
   * TDS receivable mean exactly the same thing whether the document was
   * a tax invoice or a demand notice — and one debt split across two
   * ledgers is a debt nobody can reconcile.
   *
   * ⭐ v1.25.0-alpha ADDS THE INPUT-SIDE ONES FOR THE SAME REASON. A
   * broker's tax invoice carries credit that is claimed on the same
   * GSTR-3B as every other purchase, and `tds_payable` is one debt to
   * one Government whether it was withheld from a subcontractor or a
   * broker. A property-specific twin of either would produce a return
   * that has to be assembled by hand from two ledgers.
   */
  role:
    | PropertyPostingRole
    | "output_cgst"
    | "output_sgst"
    | "output_igst"
    | "output_cess"
    | "bank"
    | "tds_receivable"
    | "input_cgst"
    | "input_sgst"
    | "input_igst"
    | "tds_payable";
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

/* ================================================================== */
/* ⭐⭐⭐ CANCELLATION — v1.25.0-alpha                                  */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 A CANCELLATION CLOSES A BOOKING. IT DOES NOT ADJUST ONE.
 * ══════════════════════════════════════════════════════════════════════
 * Every balance this booking carries has to reach zero in one entry:
 *
 *     Dr  Advance from customers      the whole advance standing
 *     Dr  Output CGST/SGST/IGST       whatever the credit note reverses
 *     Dr  Irrecoverable output tax    whatever it could not
 *           Cr  Forfeiture income     kept
 *           Cr  Buyer refund payable  going back
 *           Cr  Booking receivable    demands raised and never paid
 *
 * ⭐ AND IT BALANCES BY ARITHMETIC RATHER THAN BY CONSTRUCTION, which is
 *   the interesting property. Demands debit the receivable with
 *   principal + tax and credit the advance with the principal; receipts
 *   clear the receivable. So `advance + tax − receivable` is exactly the
 *   cash collected, and the cash collected is exactly what is kept plus
 *   what is returned. The two sides come out equal because the ledger is
 *   consistent — NOT because a plug was inserted to make them.
 *
 * ⚠️ `cancellationProblem()` IS WHAT MAKES THAT SAFE, and it runs before
 * this. It refuses when forfeit plus refund is not the cash collected,
 * and it refuses when the booking's own balances do not imply that cash.
 * Without both checks the irrecoverable-tax leg becomes a plug that
 * silently absorbs a stray receipt and calls it an expense.
 *
 * ⚠️ ONE APPROXIMATION, STATED: the unreversed tax is debited as a
 * single figure rather than split back across CGST, SGST and IGST. It is
 * an expense, not a tax account, so the split would carry no information
 * — but it means the head-wise output balances are cleared only to the
 * extent the credit note reverses them, which is correct: the rest is
 * still owed to the Government and was already paid to it.
 */
export function buildCancellationPosting(args: {
  advanceMinor: bigint;
  receivableMinor: bigint;
  forfeitMinor: bigint;
  refundMinor: bigint;
  reversedCgstMinor: bigint;
  reversedSgstMinor: bigint;
  reversedIgstMinor: bigint;
  irrecoverableTaxMinor: bigint;
  bookingReference: string;
  unitLabel: string | null;
  buyerName: string | null;
  creditNoteNumber: string | null;
}): PropertyLeg[] {
  const what = args.unitLabel ? ` · ${args.unitLabel}` : "";
  const who = args.buyerName ? ` — ${args.buyerName}` : "";
  const ref = `Cancellation · booking ${args.bookingReference}${what}${who}`;
  const cn = args.creditNoteNumber ? `credit note ${args.creditNoteNumber}` : "credit note";

  const legs: PropertyLeg[] = [
    ...rleg("customer_advance", "debit", args.advanceMinor, ref),
    ...rleg("output_cgst", "debit", args.reversedCgstMinor, `CGST reversed by ${cn}`),
    ...rleg("output_sgst", "debit", args.reversedSgstMinor, `SGST/UTGST reversed by ${cn}`),
    ...rleg("output_igst", "debit", args.reversedIgstMinor, `IGST reversed by ${cn}`),
    /**
     * ⚠️ THE LEG NOBODY EXPECTS, AND THE ONE THAT MAKES THE ENTRY HONEST.
     * Tax the section 34 window put out of reach. Zero legs are dropped,
     * so a cancellation inside the window never sees this account at all.
     */
    ...rleg(
      "irrecoverable_output_tax",
      "debit",
      args.irrecoverableTaxMinor,
      `Output tax on ${args.bookingReference} outside the section 34 credit-note window`,
    ),
    ...rleg("forfeiture_income", "credit", args.forfeitMinor, `Forfeited — ${ref}`),
    ...rleg("buyer_refund_payable", "credit", args.refundMinor, `Refund due — ${ref}`),
    ...rleg(
      "booking_receivable",
      "credit",
      args.receivableMinor,
      `Demands cancelled — ${ref}`,
    ),
  ];

  assertPropertyBalances(legs);
  return legs;
}

/**
 * ⭐ THE REFUND ACTUALLY LEAVING. A separate event on a separate date.
 *
 * ⚠️ AND IT IS SEPARATE PRECISELY BECAUSE IT OFTEN DOES NOT HAPPEN FOR
 * MONTHS. A developer short of cash pays cancellation refunds last, and
 * `buyer_refund_payable` is the account that says how much of that is
 * outstanding. Folding the payment into the cancellation would make that
 * number permanently zero and the question unanswerable.
 */
export function buildRefundPaymentPosting(args: {
  amountMinor: bigint;
  bookingReference: string;
  buyerName: string | null;
  paymentReference: string;
}): PropertyLeg[] {
  const who = args.buyerName ? ` — ${args.buyerName}` : "";
  const ref = `Refund ${args.paymentReference} · booking ${args.bookingReference}${who}`;

  const legs: PropertyLeg[] = [
    ...rleg("buyer_refund_payable", "debit", args.amountMinor, ref),
    ...rleg("bank", "credit", args.amountMinor, ref),
  ];

  assertPropertyBalances(legs);
  return legs;
}

/* ================================================================== */
/* ⭐⭐⭐ CHANNEL-PARTNER BROKERAGE — v1.25.0-alpha                     */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BROKER IS PAID NET AND EARNS GROSS, AND THE LEDGER HAS TO SAY
 *    BOTH
 * ══════════════════════════════════════════════════════════════════════
 * The wrong version — and it is the common one — debits brokerage with
 * the amount actually transferred. It balances. It also understates the
 * selling cost by the tax withheld, and leaves the 194H liability
 * appearing from nowhere when the challan is paid.
 *
 *     Dr  Brokerage expense       what the partner EARNED
 *     Dr  Input CGST/SGST/IGST    their GST, IF it is claimable
 *           Cr  TDS payable       withheld under 194H
 *           Cr  Partner payable   what will actually be transferred
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE `itcEligible` FLAG IS NOT A CONVENIENCE. IT IS THE 1%/5%
 *     SCHEME.
 * ══════════════════════════════════════════════════════════════════════
 * A residential project taxed at 1% or 5% under Notification 3/2019 has
 * NO input tax credit at all — that is the trade the concessional rate
 * buys. So the broker's GST on such a project is not an asset; it is
 * part of what the brokerage cost.
 *
 * ⚠️ AND GETTING IT WRONG IS EXPENSIVE IN BOTH DIRECTIONS. Claiming
 * blocked credit is a demand with interest and penalty. Not claiming
 * credit that was available on a 12% commercial project quietly
 * overstates cost and understates profit, and nobody ever finds it.
 *
 * So the tax goes into the SAME expense account rather than a separate
 * "GST not claimed" one — because it genuinely is part of the cost of
 * the brokerage, which is how Section 17(5) treats blocked credit
 * everywhere else in this file.
 */
export function buildBrokeragePosting(args: {
  /** Brokerage earned, exclusive of GST. */
  grossMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  /** False for a 1%/5% residential project — the tax becomes cost. */
  itcEligible: boolean;
  /** Withheld under section 194H. */
  tdsMinor: bigint;
  reference: string;
  partnerName: string;
  bookingReference: string | null;
}): PropertyLeg[] {
  const on = args.bookingReference ? ` · booking ${args.bookingReference}` : "";
  const ref = `Brokerage ${args.reference} — ${args.partnerName}${on}`;

  const taxMinor = args.cgstMinor + args.sgstMinor + args.igstMinor;
  const expenseMinor = args.itcEligible ? args.grossMinor : args.grossMinor + taxMinor;
  const payableMinor = args.grossMinor + taxMinor - args.tdsMinor;

  const legs: PropertyLeg[] = [
    ...rleg(
      "brokerage_expense",
      "debit",
      expenseMinor,
      args.itcEligible
        ? ref
        : `${ref} (GST included — no input credit on a 1%/5% project)`,
    ),
    ...(args.itcEligible
      ? [
          ...rleg("input_cgst", "debit", args.cgstMinor, `CGST on ${args.reference}`),
          ...rleg("input_sgst", "debit", args.sgstMinor, `SGST/UTGST on ${args.reference}`),
          ...rleg("input_igst", "debit", args.igstMinor, `IGST on ${args.reference}`),
        ]
      : []),
    /**
     * ⚠️ TDS IS WITHHELD ON THE BROKERAGE, NOT ON THE GST. Section 194H
     * applies to the commission; the tax component is not income of the
     * broker. Deducting on the gross-of-GST figure over-deducts, and the
     * broker cannot recover it from anyone but the department.
     */
    ...rleg("tds_payable", "credit", args.tdsMinor, `TDS u/s 194H — ${args.reference}`),
    ...rleg("partner_payable", "credit", payableMinor, ref),
  ];

  assertPropertyBalances(legs);
  return legs;
}

/**
 * ⭐ PAYING THE PARTNER. Clears the payable, and nothing else.
 *
 * ⚠️ IT DOES NOT TOUCH THE TDS. That liability was created when the
 * brokerage was booked and is discharged by a challan to the Government,
 * not by the transfer to the broker — and netting the two is how a TDS
 * payable balance goes to zero without a challan ever being paid.
 */
export function buildPartnerPaymentPosting(args: {
  amountMinor: bigint;
  reference: string;
  partnerName: string;
}): PropertyLeg[] {
  const ref = `Partner payment ${args.reference} — ${args.partnerName}`;

  const legs: PropertyLeg[] = [
    ...rleg("partner_payable", "debit", args.amountMinor, ref),
    ...rleg("bank", "credit", args.amountMinor, ref),
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
  buyer_refund_payable: {
    label: "Refunds Due to Buyers",
    tallyGroup: "Current Liabilities",
    accountType: "liability",
    help: "🔴 Owed to buyers whose bookings were cancelled, until the transfer actually leaves. Kept separate from trade creditors because it is money the developer is holding that is not theirs, and because how long it has been outstanding is a question a lender and a forum both ask.",
  },
  irrecoverable_output_tax: {
    label: "Irrecoverable Output Tax",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "GST paid on a booking that was later cancelled, after the section 34 credit-note window closed on 30 November following the year of supply. It cannot be reversed and cannot be claimed — it is a cost of the cancellation, and it has its own account so that cost is visible rather than buried in forfeiture income.",
  },
  brokerage_expense: {
    label: "Brokerage & Commission",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "What channel partners earned, GROSS of the TDS withheld from them. ⚠️ On a 1%/5% residential project the partner's GST is added here too, because Notification 3/2019 allows no input credit on such projects and blocked tax is cost.",
  },
  partner_payable: {
    label: "Channel Partners Payable",
    tallyGroup: "Sundry Creditors",
    accountType: "liability",
    help: "What will actually be transferred to the partner — brokerage plus their GST, less the tax withheld. Separate from trade creditors so brokerage owed can be read on its own, which is the figure partners chase.",
  },
};

/* ================================================================== */
/* ⭐⭐⭐ METERING — Batch 20, v1.28.0-alpha                            */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 ELECTRICITY DUTY IS NOT YOUR INCOME, AND ALMOST EVERY
 *        SUB-METERING SPREADSHEET IN INDIA TREATS IT AS IF IT WERE
 * ══════════════════════════════════════════════════════════════════════
 * A society, a developer or a facility recovering electricity from
 * residents bills three things and collects one number:
 *
 *   • ENERGY CHARGE — units × tariff. Yours.
 *   • FIXED CHARGE  — the sanctioned-load standing charge. Yours.
 *   • ELECTRICITY DUTY — a STATE LEVY collected on the State's behalf.
 *
 * ⚠️ THE DUTY IS NOT REVENUE. It is money held for a government, exactly
 * like GST collected on a sale. Crediting it to income overstates
 * turnover by the duty on every unit ever billed, and — worse — hides a
 * statutory liability that nobody is tracking, because it never appears
 * as one.
 *
 * 🔴 AND IT IS OVERSTATED TURNOVER IN THE DIRECTION THAT COSTS MONEY.
 * Income tax is computed on it, and for a society it can be the
 * difference between mutuality and a taxable surplus.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ EXPORT CREDIT IS A REDUCTION, NOT AN EXPENSE
 * ══════════════════════════════════════════════════════════════════════
 * Under net metering a consumer with solar exports units back. That
 * credit reduces what they owe. It is contra-revenue — a debit against
 * the same income the charge credited — and NOT a cost of sales.
 *
 * ⚠️ AND IT CAN EXCEED THE CHARGES. A rooftop array in a light month
 * produces a bill that is NEGATIVE, which is not a negative receivable:
 * it is money the biller owes the consumer. Those are different
 * accounts and different sides of the balance sheet, and a single
 * signed "receivable" makes a debtors listing that contains creditors.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THERE IS DELIBERATELY NO GST LEG HERE
 * ══════════════════════════════════════════════════════════════════════
 * The supply of electrical energy is exempt. Whether a RECOVERY of it is
 * a supply at all is genuinely disputed: a pure reimbursement at actual
 * cost is generally not one, and the same recovery bundled with rent or
 * maintenance is part of a composite supply taxed at the principal
 * supply's rate.
 *
 * 🔴 THAT IS A DECISION FOR THE TENANT AND THEIR AUDITOR, NOT FOR US.
 * Inventing an output-tax leg would be Ordence taking a position on a
 * litigated question and putting the answer in somebody's return. If a
 * recovery is taxable in a given workspace, it belongs on a tax invoice
 * through the sales module, which already handles it properly.
 */
export type MeteringPostingRole =
  /** Energy and fixed charges recovered. Income. */
  | "metering_revenue"
  /** 🔴 Collected for the STATE. A liability, never income. */
  | "electricity_duty_payable"
  /** Net-metering export, reducing what the consumer owes. Contra-revenue. */
  | "metering_export_credit"
  /** ⚠️ When the export credit exceeds the charges, this is owed to them. */
  | "metering_consumer_credit";

export type MeteringLeg = {
  /**
   * ⚠️ `receivable` IS THE SHARED SALES ROLE. What a consumer owes for
   * electricity is a debtor balance like any other, and a
   * metering-specific twin would split one customer's balance across two
   * ledgers so that neither agreed with their statement.
   */
  role: MeteringPostingRole | "receivable";
  entryType: "debit" | "credit";
  amountMinor: bigint;
  description: string;
};

function mleg(
  role: MeteringLeg["role"],
  entryType: "debit" | "credit",
  amountMinor: bigint,
  description: string,
): MeteringLeg[] {
  return amountMinor === 0n ? [] : [{ role, entryType, amountMinor, description }];
}

export function assertMeteringBalances(legs: readonly MeteringLeg[]): void {
  assertBalances(
    legs.map((l) => ({
      role: "revenue" as PostingRole,
      entryType: l.entryType,
      amountMinor: l.amountMinor,
      description: l.description,
    })),
  );
}

export type MeteringFacts = {
  energyChargeMinor: bigint;
  fixedChargeMinor: bigint;
  dutyMinor: bigint;
  exportCreditMinor: bigint;
  /** What the period stored. Checked, never trusted. */
  totalMinor: bigint;
};

/**
 * ⚠️ THE STORED TOTAL IS VERIFIED AGAINST ITS OWN PARTS.
 *
 * `total = energy + fixed + duty − export`. The period row stores all
 * five, computed by a database function at close. If they disagree,
 * something recomputed one and not the others — and posting from the
 * stored total would put a figure in the ledger that the bill the
 * consumer received does not support.
 *
 * ⭐ Returns a sentence rather than throwing, for the same reason every
 * other check in this codebase does: it lands in front of somebody
 * posting a month of meters, and it has to say which meter.
 */
export function meteringProblem(f: MeteringFacts): string | null {
  const negatives: [string, bigint][] = [
    ["the energy charge", f.energyChargeMinor],
    ["the fixed charge", f.fixedChargeMinor],
    ["the electricity duty", f.dutyMinor],
    ["the export credit", f.exportCreditMinor],
  ];
  for (const [label, value] of negatives) {
    if (value < 0n) {
      return `${label.charAt(0).toUpperCase()}${label.slice(1)} is negative. A charge is never negative — an export is recorded as export credit.`;
    }
  }

  const derived =
    f.energyChargeMinor + f.fixedChargeMinor + f.dutyMinor - f.exportCreditMinor;
  if (derived !== f.totalMinor) {
    return (
      `This period's parts do not add up to its total. Energy, fixed charge and duty ` +
      `less the export credit come to ${paise(derived)}, and the period says ` +
      `${paise(f.totalMinor)}. Recalculate it before posting — the ledger has to agree ` +
      `with the bill the consumer was given.`
    );
  }

  return null;
}

/**
 * ⭐ THE POSTING. Balances by arithmetic, not by construction.
 *
 *   Dr  Receivable            total          (or Cr consumer credit if negative)
 *   Dr  Export credit         exported
 *         Cr  Metering revenue    energy + fixed
 *         Cr  Electricity duty    duty
 *
 * Because `total = energy + fixed + duty − export`, the two sides come
 * out equal for any consistent period — which is exactly what
 * `meteringProblem()` checks before this runs.
 */
export function buildMeteringPosting(args: {
  facts: MeteringFacts;
  meterLabel: string;
  periodLabel: string;
  consumerName: string | null;
}): MeteringLeg[] {
  const who = args.consumerName ? ` — ${args.consumerName}` : "";
  const ref = `Meter ${args.meterLabel} · ${args.periodLabel}${who}`;
  const f = args.facts;

  const legs: MeteringLeg[] = [
    ...(f.totalMinor >= 0n
      ? mleg("receivable", "debit", f.totalMinor, ref)
      : /**
         * 🔴 A NEGATIVE BILL IS A PAYABLE, NOT A NEGATIVE DEBTOR. A
         * rooftop array in a light month genuinely produces one, and
         * carrying it as a negative receivable puts a creditor in the
         * debtors listing where nobody looks for it.
         */
        mleg(
          "metering_consumer_credit",
          "credit",
          -f.totalMinor,
          `${ref} — export exceeded consumption`,
        )),
    ...mleg(
      "metering_export_credit",
      "debit",
      f.exportCreditMinor,
      `Net-metering export — ${ref}`,
    ),
    ...mleg(
      "metering_revenue",
      "credit",
      f.energyChargeMinor + f.fixedChargeMinor,
      ref,
    ),
    ...mleg(
      "electricity_duty_payable",
      "credit",
      f.dutyMinor,
      `Electricity duty collected for the State — ${ref}`,
    ),
  ];

  assertMeteringBalances(legs);
  return legs;
}

export function meteringRolesUsed(legs: readonly MeteringLeg[]): MeteringLeg["role"][] {
  return [...new Set(legs.map((l) => l.role))];
}

export const METERING_ROLE_META: Record<
  MeteringPostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  metering_revenue: {
    label: "Utility Recovery",
    tallyGroup: "Sales Accounts",
    accountType: "revenue",
    help: "Energy and fixed charges recovered from consumers. ⚠️ The electricity duty on the same bill does NOT belong here — it is collected for the State.",
  },
  electricity_duty_payable: {
    label: "Electricity Duty Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "🔴 A State levy collected on the State's behalf, exactly like GST on a sale. Crediting it to income overstates turnover by the duty on every unit ever billed and hides a statutory liability nobody is tracking.",
  },
  metering_export_credit: {
    label: "Net-Metering Export Credit",
    tallyGroup: "Sales Accounts",
    accountType: "revenue",
    help: "Units a consumer exported back, reducing what they owe. Contra-revenue against the recovery — not a cost of sales, and kept separate so 'how much did we credit back for solar' has an answer.",
  },
  metering_consumer_credit: {
    label: "Utility Credit Owed to Consumers",
    tallyGroup: "Current Liabilities",
    accountType: "liability",
    help: "⚠️ What is owed to a consumer whose export exceeded their consumption. A negative bill is a payable, not a negative debtor — carrying it as one would put a creditor in the debtors listing.",
  },
};

function paise(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? "-" : ""}\u20B9${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/* ================================================================== */
/* ⭐⭐⭐ PAYROLL — Batch 15, v1.23.0-alpha                             */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE PAYROLL JOURNAL IS THE ONE MOST OFTEN GOT WRONG, AND IT IS
 * ALWAYS WRONG IN THE SAME DIRECTION
 * ══════════════════════════════════════════════════════════════════════
 * The wrong version debits "Salaries" with the NET paid and credits the
 * bank. It balances. It is also understated by every rupee of PF, ESI,
 * professional tax and TDS withheld — money the business spent on
 * employing people and owes to somebody else.
 *
 * ⭐ THE RIGHT VERSION DEBITS THE GROSS. What was withheld is not a
 * reduction of cost; it is a set of liabilities the employer holds on
 * behalf of the employee and remits later. So:
 *
 *     Dr  Salaries & Wages            gross earnings
 *     Dr  Employer PF contribution    employer's own 12%, EDLI, admin
 *     Dr  Employer ESI contribution   employer's own 3.25%
 *         Cr  PF payable             employee's + employer's
 *         Cr  Pension payable        the EPS half, SEPARATELY
 *         Cr  ESI payable            both halves
 *         Cr  Professional tax payable
 *         Cr  TDS payable (salary)   section 192
 *         Cr  Salaries payable       what actually leaves the bank
 *
 * ⚠️ NOTE WHAT IS NOT HERE: THE BANK. Payroll ACCRUES; paying the
 * salaries is a separate event that debits Salaries payable and credits
 * the bank, and it happens on the day the transfer clears rather than
 * on the last day of the month. Collapsing the two means the ledger
 * claims money left the bank on a day it did not.
 *
 * 🔴 AND PENSION IS ITS OWN PAYABLE. It goes on the same challan as PF
 * but under a different account head, and a single netted "PF payable"
 * cannot be reconciled against an ECR. Same argument as the two stock
 * variance accounts above: netting destroys the only answer to a
 * question somebody will ask.
 */
export type PayrollPostingRole =
  /** Gross earnings. The whole cost of the people, before withholding. */
  | "salary_expense"
  /** The employer's own PF, EDLI and administration charges. */
  | "employer_pf_expense"
  /** The employer's own ESI. */
  | "employer_esi_expense"
  /** Employee 12% + employer 3.67%. Owed to EPFO. */
  | "pf_payable"
  /** The employer's 8.33% pension share. Same challan, different head. */
  | "pension_payable"
  /** Both halves of ESI. */
  | "esi_payable"
  /** State professional tax withheld. */
  | "professional_tax_payable"
  /** Section 192 TDS on salary. */
  | "tds_payable_salary"
  /** ⭐ Net pay owed to employees. Cleared when the transfer goes out. */
  | "salaries_payable";

export type PayrollLeg = {
  role: PayrollPostingRole;
  entryType: "debit" | "credit";
  amountMinor: bigint;
  description: string;
};

export function assertPayrollBalances(legs: readonly PayrollLeg[]): void {
  const debit = legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);
  const credit = legs
    .filter((l) => l.entryType === "credit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);
  if (debit !== credit) {
    throw new PostingImbalance(
      `Payroll journal does not balance: debits ${debit} vs credits ${credit}.`,
    );
  }
}

export type PayrollPostingFacts = {
  readonly grossMinor: bigint;
  readonly employeePfMinor: bigint;
  readonly employerPfMinor: bigint;
  readonly employerPensionMinor: bigint;
  readonly edliMinor: bigint;
  readonly pfAdminMinor: bigint;
  readonly employeeEsiMinor: bigint;
  readonly employerEsiMinor: bigint;
  readonly professionalTaxMinor: bigint;
  readonly tdsMinor: bigint;
  /** Loan recoveries, advances, anything withheld that is not statutory. */
  readonly otherDeductionsMinor: bigint;
  readonly netPayMinor: bigint;
};

/**
 * ⭐ BUILT FROM THE RUN TOTALS, NEVER FROM THE NET.
 *
 * ⚠️ `otherDeductionsMinor` IS CREDITED TO `salaries_payable` RATHER
 * THAN TO ITS OWN ACCOUNT, and that is a deliberate limitation stated
 * out loud rather than a bug. A loan recovery genuinely belongs against
 * the loan account, and Ordence has no employee loan ledger yet. Until
 * it does, netting it into what is owed to the employee is honest —
 * inventing a "sundry recoveries" account and posting to it would look
 * like a feature and reconcile to nothing.
 */
export function buildPayrollPosting(args: {
  readonly facts: PayrollPostingFacts;
  readonly periodLabel: string;
}): PayrollLeg[] {
  const f = args.facts;
  const legs: PayrollLeg[] = [];

  const push = (
    role: PayrollPostingRole,
    entryType: "debit" | "credit",
    amountMinor: bigint,
    description: string,
  ) => {
    // ⚠️ ZERO LEGS ARE DROPPED. A business with no ESI-covered employees
    // must not be forced to map an ESI ledger it will never use.
    if (amountMinor !== 0n) legs.push({ role, entryType, amountMinor, description });
  };

  /* ---- The debits: what employing these people cost ---------------- */
  push("salary_expense", "debit", f.grossMinor, `Salaries and wages — ${args.periodLabel}`);
  push(
    "employer_pf_expense",
    "debit",
    f.employerPfMinor + f.employerPensionMinor + f.edliMinor + f.pfAdminMinor,
    `Employer provident fund, pension, EDLI and administration — ${args.periodLabel}`,
  );
  push(
    "employer_esi_expense",
    "debit",
    f.employerEsiMinor,
    `Employer ESI contribution — ${args.periodLabel}`,
  );

  /* ---- The credits: who is owed what ------------------------------ */
  //
  // 🔴 PF PAYABLE CARRIES BOTH SIDES OF THE PF PORTION PLUS EDLI AND
  // ADMIN, because that is what one challan settles. Pension is
  // separate, on the same challan, under its own head.
  push(
    "pf_payable",
    "credit",
    f.employeePfMinor + f.employerPfMinor + f.edliMinor + f.pfAdminMinor,
    `Provident fund payable — ${args.periodLabel}`,
  );
  push(
    "pension_payable",
    "credit",
    f.employerPensionMinor,
    `Pension scheme payable — ${args.periodLabel}`,
  );
  push(
    "esi_payable",
    "credit",
    f.employeeEsiMinor + f.employerEsiMinor,
    `ESI payable — ${args.periodLabel}`,
  );
  push(
    "professional_tax_payable",
    "credit",
    f.professionalTaxMinor,
    `Professional tax payable — ${args.periodLabel}`,
  );
  push(
    "tds_payable_salary",
    "credit",
    f.tdsMinor,
    `TDS on salary payable — ${args.periodLabel}`,
  );
  push(
    "salaries_payable",
    "credit",
    f.netPayMinor + f.otherDeductionsMinor,
    `Net salaries payable — ${args.periodLabel}`,
  );

  assertPayrollBalances(legs);
  return legs;
}

export function payrollRolesUsed(legs: readonly PayrollLeg[]): PayrollPostingRole[] {
  return [...new Set(legs.map((l) => l.role))];
}

export const PAYROLL_ROLE_META: Record<
  PayrollPostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  salary_expense: {
    label: "Salaries & Wages",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "🔴 Debited with the GROSS, never the net. What was withheld from an employee is money the business spent — it is owed to somebody else, not saved.",
  },
  employer_pf_expense: {
    label: "Employer PF Contribution",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "The employer's own 12%, plus EDLI and administration charges. A real cost on top of salary, and roughly a seventh of the wage bill once ESI is added.",
  },
  employer_esi_expense: {
    label: "Employer ESI Contribution",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "The employer's own 3.25%. Only for employees below the wage limit.",
  },
  pf_payable: {
    label: "Provident Fund Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Employee and employer PF, EDLI and admin — what one ECR challan settles. Due by the 15th of the following month.",
  },
  pension_payable: {
    label: "Pension Fund Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "⚠️ SEPARATE FROM PF PAYABLE ON PURPOSE. Same challan, different account head. Netting the two into one balance makes an ECR impossible to reconcile.",
  },
  esi_payable: {
    label: "ESI Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Both halves. Due by the 15th of the following month.",
  },
  professional_tax_payable: {
    label: "Professional Tax Payable",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Withheld under State law and remitted to the State. Due dates vary by State.",
  },
  tds_payable_salary: {
    label: "TDS Payable — Salary",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Section 192. ⚠️ Keep it separate from vendor TDS: it is a different section, a different challan and a different quarterly return.",
  },
  salaries_payable: {
    label: "Salaries Payable",
    tallyGroup: "Current Liabilities",
    accountType: "liability",
    help: "⭐ What actually leaves the bank. Payroll ACCRUES here on the last day of the month; the transfer clears it on the day it goes out. Collapsing the two would claim money left the bank on a day it did not.",
  },
};

/* ================================================================== */
/* ⭐⭐⭐ THE MONTHLY RETURN SET-OFF — Batch 16, v1.24.0-alpha          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 EVERY MONTH THE OUTPUT AND INPUT TAX ACCOUNTS HAVE TO BE CLEARED
 * AGAINST EACH OTHER, AND ALMOST NOBODY DOES IT
 * ══════════════════════════════════════════════════════════════════════
 * Invoices credit Output CGST/SGST/IGST. Purchases debit Input
 * CGST/SGST/IGST. Left alone, both sides grow forever: a balance sheet
 * showing ₹40 lakh of output tax owed and ₹38 lakh of input tax
 * receivable, when the business actually owes ₹2 lakh.
 *
 * ⚠️ IT BALANCES, IT IS ARITHMETICALLY CORRECT, AND IT IS USELESS. A
 * lender reading that balance sheet sees a company with a large tax
 * liability. An auditor asks why the input tax has never been utilised.
 * Neither is a conversation anybody wants.
 *
 * ⭐ SO WHEN A 3B IS FILED, ONE JOURNAL CLEARS BOTH SIDES BY EXACTLY
 * WHAT THE SET-OFF UTILISED, and leaves the cash portion in its own
 * account:
 *
 *     Dr  Output IGST / CGST / SGST      what the set-off discharged
 *         Cr  Input IGST / CGST / SGST   the credit it was discharged with
 *         Cr  GST Payable (cash)         the balance, which leaves the bank
 *
 * 🔴 THE AMOUNTS COME FROM THE SET-OFF, NOT FROM THE BALANCES. Clearing
 * "whatever is in the account" would sweep up credit the return did not
 * claim and output tax from a period already filed, and the ledger would
 * then disagree with the return it is supposed to support.
 */
export type ReturnPostingRole =
  /** ⚠️ THE SAME ROLE STRINGS THE SALES AND PURCHASE SIDES ALREADY USE,
   *  so a tenant maps one ledger per head and not two. */
  | "output_cgst"
  | "output_sgst"
  | "output_igst"
  | "output_cess"
  | "input_cgst"
  | "input_sgst"
  | "input_igst"
  | "input_cess"
  /** ⭐ What must actually be paid. Its own account, so "how much cash
   *  does the GST return need" has an answer on the balance sheet. */
  | "gst_payable_cash"
  /** ⚠️ Interest and late fee are NOT tax and are never creditable. */
  | "gst_interest"
  | "gst_late_fee";

export type ReturnLeg = {
  role: ReturnPostingRole;
  entryType: "debit" | "credit";
  amountMinor: bigint;
  description: string;
};

export function assertReturnBalances(legs: readonly ReturnLeg[]): void {
  const debit = legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);
  const credit = legs
    .filter((l) => l.entryType === "credit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);
  if (debit !== credit) {
    throw new PostingImbalance(
      `Return set-off journal does not balance: debits ${debit} vs credits ${credit}.`,
    );
  }
}

export type ReturnPostingFacts = {
  /** Output tax discharged, by head — from the set-off, not the balance. */
  readonly liabilityCleared: { igst: bigint; cgst: bigint; sgst: bigint; cess: bigint };
  /** Credit utilised, by the pool it came from. */
  readonly creditUsed: { igst: bigint; cgst: bigint; sgst: bigint; cess: bigint };
  /** The shortfall that leaves the bank, including reverse charge. */
  readonly cashByHead: { igst: bigint; cgst: bigint; sgst: bigint; cess: bigint };
  readonly interestMinor: bigint;
  readonly lateFeeMinor: bigint;
};

/**
 * ⭐ ONE JOURNAL PER RETURN, DATED THE LAST DAY OF THE TAX PERIOD.
 *
 * ⚠️ NOT THE FILING DATE. A July return filed on 20 August belongs in
 * July, or the July balance sheet shows a liability that the July return
 * says was settled.
 */
export function buildReturnSetoffPosting(args: {
  readonly facts: ReturnPostingFacts;
  readonly periodLabel: string;
}): ReturnLeg[] {
  const f = args.facts;
  const legs: ReturnLeg[] = [];

  const push = (
    role: ReturnPostingRole,
    entryType: "debit" | "credit",
    amountMinor: bigint,
    description: string,
  ) => {
    if (amountMinor !== 0n) legs.push({ role, entryType, amountMinor, description });
  };

  /* ---- Clear the output tax that was discharged ------------------- */
  push("output_igst", "debit", f.liabilityCleared.igst, `IGST discharged — ${args.periodLabel}`);
  push("output_cgst", "debit", f.liabilityCleared.cgst, `CGST discharged — ${args.periodLabel}`);
  push("output_sgst", "debit", f.liabilityCleared.sgst, `SGST discharged — ${args.periodLabel}`);
  push("output_cess", "debit", f.liabilityCleared.cess, `Cess discharged — ${args.periodLabel}`);

  /* ---- Plus the cash heads, which are also output tax being paid --- */
  //
  // ⚠️ THE CASH PORTION CLEARS THE SAME OUTPUT ACCOUNTS. It is not a
  // separate expense: the liability is being settled, just with money
  // rather than with credit.
  push("output_igst", "debit", f.cashByHead.igst, `IGST payable in cash — ${args.periodLabel}`);
  push("output_cgst", "debit", f.cashByHead.cgst, `CGST payable in cash — ${args.periodLabel}`);
  push("output_sgst", "debit", f.cashByHead.sgst, `SGST payable in cash — ${args.periodLabel}`);
  push("output_cess", "debit", f.cashByHead.cess, `Cess payable in cash — ${args.periodLabel}`);

  /* ---- Interest and late fee are costs, not tax ------------------- */
  push("gst_interest", "debit", f.interestMinor, `Interest on late tax — ${args.periodLabel}`);
  push("gst_late_fee", "debit", f.lateFeeMinor, `Late fee — ${args.periodLabel}`);

  /* ---- Release the credit that was utilised ----------------------- */
  push("input_igst", "credit", f.creditUsed.igst, `IGST credit utilised — ${args.periodLabel}`);
  push("input_cgst", "credit", f.creditUsed.cgst, `CGST credit utilised — ${args.periodLabel}`);
  push("input_sgst", "credit", f.creditUsed.sgst, `SGST credit utilised — ${args.periodLabel}`);
  push("input_cess", "credit", f.creditUsed.cess, `Cess credit utilised — ${args.periodLabel}`);

  /* ---- And what has to be paid ------------------------------------ */
  const cashTotal =
    f.cashByHead.igst +
    f.cashByHead.cgst +
    f.cashByHead.sgst +
    f.cashByHead.cess +
    f.interestMinor +
    f.lateFeeMinor;

  push(
    "gst_payable_cash",
    "credit",
    cashTotal,
    `GST payable in cash — ${args.periodLabel}`,
  );

  assertReturnBalances(legs);
  return legs;
}

export function returnRolesUsed(legs: readonly ReturnLeg[]): ReturnPostingRole[] {
  return [...new Set(legs.map((l) => l.role))];
}

export const RETURN_ROLE_META: Record<
  ReturnPostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  output_igst: {
    label: "Output IGST",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Already mapped for sales. The return journal DEBITS it to clear what the month discharged.",
  },
  output_cgst: {
    label: "Output CGST",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Already mapped for sales. Cleared monthly rather than left to grow forever.",
  },
  output_sgst: {
    label: "Output SGST / UTGST",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Already mapped for sales. Cleared monthly.",
  },
  output_cess: {
    label: "Output Cess",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "Already mapped for sales.",
  },
  input_igst: {
    label: "Input IGST",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "Already mapped for purchases. CREDITED by the return journal, by exactly what the set-off utilised — never by whatever happens to be in the account.",
  },
  input_cgst: {
    label: "Input CGST",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "Already mapped for purchases. ⚠️ Its balance can never be used against SGST, in the ledger or on the return.",
  },
  input_sgst: {
    label: "Input SGST / UTGST",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "Already mapped for purchases. ⚠️ Never usable against CGST.",
  },
  input_cess: {
    label: "Input Cess",
    tallyGroup: "Duties & Taxes",
    accountType: "asset",
    help: "Already mapped for purchases. Cess credit may only go against cess.",
  },
  gst_payable_cash: {
    label: "GST Payable (cash)",
    tallyGroup: "Duties & Taxes",
    accountType: "liability",
    help: "⭐ What the return actually needs paying in money, after credit. Its own account, so the answer to 'how much cash does GST need this month' is a balance rather than a calculation.",
  },
  gst_interest: {
    label: "Interest on GST",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "🔴 An expense, never tax, and never creditable. Kept separate so 'what did paying late cost us this year' has an answer.",
  },
  gst_late_fee: {
    label: "GST Late Fee",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "An expense, and disallowed for income tax. Separate from interest because they are different lines on the challan.",
  },
};

/* ================================================================== */
/* ⭐⭐⭐ DEPRECIATION AND DISPOSAL — Batch 100, v1.53.0-alpha          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ONLY THE COMPANIES ACT CHARGE REACHES THE LEDGER
 * ══════════════════════════════════════════════════════════════════════
 * Section 32 depreciation is computed on the same assets and produces a
 * different, usually larger, number. It is an allowance in a tax
 * computation and it is NOT an accounting entry — posting it would put
 * the Income-tax Act's figure into a Companies Act balance sheet and
 * overstate accumulated depreciation by the whole timing difference.
 *
 * There is therefore no `postIncomeTaxDepreciation` anywhere in this
 * codebase, `depreciation_runs` carries a CHECK constraint refusing a
 * `transaction_id` on an income-tax run, and this comment exists so that
 * nobody adds one "for completeness".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ACCUMULATED DEPRECIATION IS ITS OWN ACCOUNT, NOT A CREDIT TO COST
 * ══════════════════════════════════════════════════════════════════════
 * Crediting the asset account directly would work arithmetically and
 * would destroy the disclosure: Schedule III to the Companies Act 2013
 * requires gross block, accumulated depreciation and net block to be
 * shown separately, and once cost has been netted off there is no way to
 * recover the gross figure. It is the same argument as the two stock
 * variance accounts and the separate pension payable — netting destroys
 * the only answer to a question somebody will ask.
 */
export type FixedAssetPostingRole =
  /** The period's charge. Hits the profit and loss account. */
  | "depreciation_expense"
  /** ⭐ CONTRA-ASSET. Credited by the charge, cleared on disposal. */
  | "accumulated_depreciation"
  /** Gross block. Credited with the asset's COST when it leaves. */
  | "fixed_asset_cost"
  /** What the buyer owes for the asset. Cleared when the money arrives. */
  | "asset_disposal_receivable"
  /** Consideration above carrying amount. */
  | "asset_disposal_gain"
  /** Carrying amount above consideration. */
  | "asset_disposal_loss";

export type FixedAssetLeg = {
  role: FixedAssetPostingRole;
  entryType: "debit" | "credit";
  amountMinor: bigint;
  description: string;
};

export function assertFixedAssetBalances(legs: readonly FixedAssetLeg[]): void {
  const debit = legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);
  const credit = legs
    .filter((l) => l.entryType === "credit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);
  if (debit !== credit) {
    throw new PostingImbalance(
      `Fixed asset journal does not balance: debits ${debit} vs credits ${credit}.`,
    );
  }
}

/**
 * ⭐ ONE JOURNAL FOR THE WHOLE RUN, NOT ONE PER ASSET.
 *
 * ⚠️ A COMPANY WITH FOUR HUNDRED ASSETS WOULD OTHERWISE PRODUCE FOUR
 * HUNDRED TRANSACTIONS A MONTH, every one of them balanced, every one of
 * them correct, and a trial balance nobody can read. The per-asset detail
 * lives in `depreciation_lines`, which is where somebody actually looks
 * for it — the same decision as one journal per payroll run rather than
 * one per payslip.
 */
export function buildDepreciationPosting(args: {
  readonly totalChargeMinor: bigint;
  readonly periodLabel: string;
  readonly assetCount: number;
}): FixedAssetLeg[] {
  if (args.totalChargeMinor <= 0n) {
    throw new PostingImbalance(
      "A depreciation run with no charge has no journal. Nothing has been posted.",
    );
  }
  const legs: FixedAssetLeg[] = [
    {
      role: "depreciation_expense",
      entryType: "debit",
      amountMinor: args.totalChargeMinor,
      description: `Depreciation for ${args.periodLabel} — ${args.assetCount} asset${args.assetCount === 1 ? "" : "s"}`,
    },
    {
      role: "accumulated_depreciation",
      entryType: "credit",
      amountMinor: args.totalChargeMinor,
      description: `Depreciation for ${args.periodLabel}`,
    },
  ];
  assertFixedAssetBalances(legs);
  return legs;
}

/**
 * ⭐⭐ DISPOSAL — THE COMPANIES ACT ENTRY, AND ONLY THAT.
 *
 * Four or five legs: the accumulated depreciation attaching to the asset
 * is cleared, the gross cost leaves the block, the consideration becomes
 * a receivable, and the difference is a gain or a loss.
 *
 * 🔴 THE INCOME-TAX SIDE POSTS NOTHING HERE AND MUST NOT. Under s.32 the
 * same sale reduces the WDV of the BLOCK by the moneys payable and
 * produces no gain or loss at all unless the block empties (s.50(2)) or
 * is exhausted (s.50(1)). A book profit of ₹2 lakh on this machine may
 * carry no tax at all this year. Ordence records both answers and
 * reconciles neither, because they do not reconcile.
 *
 * ⚠️ A RECEIVABLE RATHER THAN BANK. The asset leaving and the money
 * arriving are two events on two dates; collapsing them claims cash was
 * received on a day it was not, which is the same error the separate
 * `salaries_payable` account exists to prevent.
 */
export function buildDisposalPosting(args: {
  readonly assetNo: string;
  readonly costMinor: bigint;
  readonly accumulatedMinor: bigint;
  readonly considerationMinor: bigint;
  readonly disposedOn: string;
}): FixedAssetLeg[] {
  const carrying = args.costMinor - args.accumulatedMinor;
  const difference = args.considerationMinor - carrying;
  const legs: FixedAssetLeg[] = [];

  if (args.accumulatedMinor > 0n) {
    legs.push({
      role: "accumulated_depreciation",
      entryType: "debit",
      amountMinor: args.accumulatedMinor,
      description: `Accumulated depreciation on ${args.assetNo} cleared on disposal`,
    });
  }
  if (args.considerationMinor > 0n) {
    legs.push({
      role: "asset_disposal_receivable",
      entryType: "debit",
      amountMinor: args.considerationMinor,
      description: `Consideration receivable for ${args.assetNo} sold on ${args.disposedOn}`,
    });
  }
  if (difference < 0n) {
    legs.push({
      role: "asset_disposal_loss",
      entryType: "debit",
      amountMinor: -difference,
      description: `Loss on disposal of ${args.assetNo}`,
    });
  }
  legs.push({
    role: "fixed_asset_cost",
    entryType: "credit",
    amountMinor: args.costMinor,
    description: `Cost of ${args.assetNo} removed from the gross block`,
  });
  if (difference > 0n) {
    legs.push({
      role: "asset_disposal_gain",
      entryType: "credit",
      amountMinor: difference,
      description: `Profit on disposal of ${args.assetNo}`,
    });
  }

  assertFixedAssetBalances(legs);
  return legs;
}

export function fixedAssetRolesUsed(
  legs: readonly FixedAssetLeg[],
): FixedAssetPostingRole[] {
  return [...new Set(legs.map((l) => l.role))];
}

export const FIXED_ASSET_ROLE_META: Record<
  FixedAssetPostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  depreciation_expense: {
    label: "Depreciation",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "⭐ The Companies Act, Schedule II charge for the period. 🔴 NOT the section 32 allowance — that is a different, usually larger number, it belongs in the tax computation and it never comes near this ledger.",
  },
  accumulated_depreciation: {
    label: "Accumulated Depreciation",
    tallyGroup: "Fixed Assets",
    accountType: "asset",
    help: "🔴 A CONTRA-ASSET, credited by every charge. Schedule III requires gross block, accumulated depreciation and net block to be shown separately — crediting the asset account directly would balance and would destroy the disclosure permanently.",
  },
  fixed_asset_cost: {
    label: "Fixed Assets (gross block)",
    tallyGroup: "Fixed Assets",
    accountType: "asset",
    help: "Cost, at what was paid for it. Credited only when an asset leaves, and by its ORIGINAL COST — never by its written-down value.",
  },
  asset_disposal_receivable: {
    label: "Asset Disposal Receivable",
    tallyGroup: "Current Assets",
    accountType: "asset",
    help: "⚠️ What the buyer owes for the asset, cleared when the money arrives. Posting straight to bank would claim cash was received on the day the asset left, which is usually not the same day.",
  },
  asset_disposal_gain: {
    label: "Profit on Sale of Fixed Assets",
    tallyGroup: "Indirect Incomes",
    accountType: "revenue",
    help: "Consideration above carrying amount. ⚠️ It is NOT a taxable capital gain by itself: under s.50 the proceeds simply reduce the block, and a gain arises only if the block is exhausted or emptied.",
  },
  asset_disposal_loss: {
    label: "Loss on Sale of Fixed Assets",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "Carrying amount above consideration. ⚠️ Likewise not an allowable capital loss on its own — the block absorbs it and it comes back as depreciation in later years.",
  },
};

/* ================================================================== */
/* ⭐⭐⭐ EXCHANGE DIFFERENCES — Batch 0101, v1.64.0-alpha              */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AN EXCHANGE DIFFERENCE IS A PROFIT AND LOSS ITEM, IMMEDIATELY
 * ══════════════════════════════════════════════════════════════════════
 * AS 11 ¶13 and Ind AS 21 ¶28 both say the same thing: exchange
 * differences arising on the settlement of monetary items, and on
 * restating monetary items at rates different from those at which they
 * were initially recorded, are recognised as INCOME OR EXPENSE IN THE
 * PERIOD IN WHICH THEY ARISE.
 *
 * ⚠️ NOT PARKED ON THE BALANCE SHEET. Paragraph 46A of AS 11 once allowed
 * long-term monetary items to be capitalised or deferred, and that
 * transitional option has expired; there is no general "exchange
 * fluctuation reserve" for trade receivables and payables, and creating
 * one would keep a real loss out of the P&L indefinitely.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO ROLES AND NOT ONE, FOR THE THIRD TIME IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * The same argument as the two stock-variance accounts and the two bank
 * adjustment accounts. Netting the gain against the loss makes "what did
 * the currency cost us this year" a question with no answer anywhere in
 * the system — and unlike stock, this one is asked by the board every
 * quarter in an exporting business.
 *
 * ⭐ AND THE UNREALISED AND REALISED DIFFERENCES SHARE THE TWO ROLES ON
 * PURPOSE. They are the same line in the P&L; what distinguishes them is
 * the DOCUMENT that produced them (a revaluation run versus a receipt),
 * and that is already on the transaction. Four accounts would ask a
 * tenant to map two more ledgers to make a distinction their statutory
 * format does not draw.
 */
export type FxPostingRole =
  /**
   * ⭐ Gain. The rupee weakened against a receivable, or strengthened
   * against a payable. An indirect income.
   */
  | "fx_gain"
  /** ⭐ Loss. The mirror. An indirect expense. */
  | "fx_loss"
  /**
   * 🔴 THE OTHER SIDE, AND IT IS NOT ONE ACCOUNT.
   *
   * A restatement of a RECEIVABLE moves Sundry Debtors; a restatement of
   * a PAYABLE moves Sundry Creditors; a restatement of a foreign BANK
   * balance moves that bank account. Posting all three to a single
   * "FX revaluation" control account would balance and would leave the
   * debtors ledger disagreeing with the customer statements by exactly
   * the revaluation — which is discovered at the next reconciliation, six
   * months later.
   *
   * ⚠️ SO THE CONTRA IS RESOLVED PER ITEM by the caller and passed in as a
   * LEDGER OVERRIDE, the same shape `postBankAdjustment` uses for the
   * account's own bank ledger. These three roles are the FALLBACK for a
   * tenant who has not mapped a specific ledger, and they are named so
   * that the fallback is visible rather than silent.
   */
  | "fx_receivable_contra"
  | "fx_payable_contra"
  | "fx_bank_contra";

export type FxLeg = {
  role: FxPostingRole;
  entryType: "debit" | "credit";
  /** Minor units of the FUNCTIONAL currency. Always positive. */
  amountMinor: bigint;
  description: string;
  /**
   * ⭐ THE LEDGER THIS LEG MUST HIT, WHEN THE CALLER KNOWS IT. Overrides
   * the role map. Used for the contra legs, never for the gain or loss.
   */
  ledgerIdOverride?: string | null;
};

export function assertFxBalances(legs: readonly FxLeg[]): void {
  let debit = 0n;
  let credit = 0n;
  for (const l of legs) {
    if (l.amountMinor < 0n) {
      throw new PostingImbalance(
        `An exchange-difference leg carries a negative amount (${l.role}). Direction belongs in ` +
          `entryType, never in the sign — an unrealised loss is a DEBIT to fx_loss, not a ` +
          `negative credit to fx_gain.`,
      );
    }
    if (l.entryType === "debit") debit += l.amountMinor;
    else credit += l.amountMinor;
  }
  if (debit !== credit) {
    throw new PostingImbalance(
      `Exchange-difference journal does not balance: debits ${debit}, credits ${credit}, ` +
        `difference ${debit - credit} minor units.`,
    );
  }
}

/** Which contra role a restated item kind belongs to. */
export function fxContraRoleForKind(kind: string): FxPostingRole {
  switch (kind) {
    case "trade_receivable":
    case "loan_receivable":
    case "other_monetary_asset":
      return "fx_receivable_contra";
    case "trade_payable":
    case "loan_payable":
    case "other_monetary_liability":
      return "fx_payable_contra";
    case "foreign_bank_balance":
    case "foreign_cash":
      return "fx_bank_contra";
    default:
      throw new PostingImbalance(
        `"${kind}" has no exchange-difference contra account. Nothing has been posted. A ` +
          `restatement whose other leg is guessed lands in the wrong control account and is ` +
          `found at the next reconciliation, not before.`,
      );
  }
}

/**
 * ⭐⭐⭐ THE REVALUATION JOURNAL.
 *
 * One line per restated item — the contra — and ONE aggregate line each
 * for the gain and the loss.
 *
 *   Dr  Sundry Debtors            (receivable worth more)
 *       Cr  Exchange Gain
 *
 *   Dr  Exchange Loss
 *       Cr  Sundry Creditors      (payable worth more)
 *
 * 🔴 THE GAIN AND THE LOSS ARE NOT NETTED BEFORE POSTING. A run that
 * produced ₹80,000 of gains and ₹95,000 of losses posts both, not
 * ₹15,000 of loss. The P&L line then shows what actually happened, and
 * the trial balance still foots because the contra legs carry the same
 * two totals on the other side.
 *
 * ⚠️ ZERO-DIFFERENCE ITEMS PRODUCE NO LEG AT ALL. An invoice whose
 * closing rate happens to equal its carrying rate has no exchange
 * difference; a ₹0.00 leg would clutter the debtors ledger of every
 * exporter with one row per invoice per quarter for ever.
 */
export function buildFxRevaluationPosting(args: {
  /** One entry per item the run actually restated. */
  items: readonly {
    kind: string;
    /** Positive is a GAIN in the P&L. Already sign-corrected for the side. */
    plEffectMinor: bigint;
    /** The item's own control ledger, when the caller resolved one. */
    contraLedgerId?: string | null;
    description: string;
  }[];
  asOfDate: string;
}): FxLeg[] {
  const legs: FxLeg[] = [];
  let gainTotal = 0n;
  let lossTotal = 0n;

  for (const item of args.items) {
    if (item.plEffectMinor === 0n) continue;
    const contra = fxContraRoleForKind(item.kind);
    const magnitude = item.plEffectMinor > 0n ? item.plEffectMinor : -item.plEffectMinor;

    /**
     * ⚠️ THE CONTRA'S DIRECTION FOLLOWS THE P&L EFFECT AND THE SIDE OF
     * THE BALANCE SHEET TOGETHER, and both are already folded into
     * `plEffectMinor` by `exchangeDifferenceForPl()`. A gain on an ASSET
     * debits the asset; a gain on a LIABILITY (the rupee strengthened, we
     * owe less) DEBITS the liability too — reducing it. Both cases debit
     * the contra on a gain, which is why one rule covers all three
     * control accounts and there is no per-kind sign table to get wrong.
     */
    legs.push({
      role: contra,
      entryType: item.plEffectMinor > 0n ? "debit" : "credit",
      amountMinor: magnitude,
      description: item.description,
      ledgerIdOverride: item.contraLedgerId ?? null,
    });

    if (item.plEffectMinor > 0n) gainTotal += magnitude;
    else lossTotal += magnitude;
  }

  if (gainTotal > 0n) {
    legs.push({
      role: "fx_gain",
      entryType: "credit",
      amountMinor: gainTotal,
      description: `Exchange gain on restatement at ${args.asOfDate}`,
      ledgerIdOverride: null,
    });
  }
  if (lossTotal > 0n) {
    legs.push({
      role: "fx_loss",
      entryType: "debit",
      amountMinor: lossTotal,
      description: `Exchange loss on restatement at ${args.asOfDate}`,
      ledgerIdOverride: null,
    });
  }

  assertFxBalances(legs);
  return legs;
}

/**
 * ⭐ THE REALISED DIFFERENCE ON SETTLEMENT.
 *
 * 🔴 THE CONTRA IS THE ITEM'S OWN CONTROL ACCOUNT AND THE AMOUNT IS
 * MEASURED AGAINST THE CARRYING VALUE, NOT THE INVOICE. See
 * `lib/fx/restatement.ts#settlementDifference` for why: measuring against
 * the invoice re-books a difference that a previous year's P&L already
 * took, overstating this year by exactly last year's restatement.
 */
export function buildFxSettlementPosting(args: {
  kind: string;
  realisedDifferenceMinor: bigint;
  contraLedgerId?: string | null;
  documentReference: string;
  settlementDate: string;
}): FxLeg[] {
  if (args.realisedDifferenceMinor === 0n) return [];

  const isLiability =
    args.kind === "trade_payable" ||
    args.kind === "loan_payable" ||
    args.kind === "other_monetary_liability";
  // Same fold as the revaluation: a liability worth more is a loss.
  const plEffect = isLiability ? -args.realisedDifferenceMinor : args.realisedDifferenceMinor;
  const magnitude = plEffect > 0n ? plEffect : -plEffect;
  const contra = fxContraRoleForKind(args.kind);
  const ref = `${args.documentReference} settled ${args.settlementDate}`;

  const legs: FxLeg[] = [
    {
      role: contra,
      entryType: plEffect > 0n ? "debit" : "credit",
      amountMinor: magnitude,
      description: `Realised exchange difference — ${ref}`,
      ledgerIdOverride: args.contraLedgerId ?? null,
    },
    {
      role: plEffect > 0n ? "fx_gain" : "fx_loss",
      entryType: plEffect > 0n ? "credit" : "debit",
      amountMinor: magnitude,
      description: `Realised exchange ${plEffect > 0n ? "gain" : "loss"} — ${ref}`,
      ledgerIdOverride: null,
    },
  ];

  assertFxBalances(legs);
  return legs;
}

/** Every role a set of FX legs needs a ledger for, minus the overridden ones. */
export function fxRolesUsed(legs: readonly FxLeg[]): FxPostingRole[] {
  return [...new Set(legs.filter((l) => !l.ledgerIdOverride).map((l) => l.role))];
}

export const FX_ROLE_META: Record<
  FxPostingRole,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = {
  fx_gain: {
    label: "Exchange Gain",
    tallyGroup: "Indirect Incomes",
    accountType: "revenue",
    help: "⭐ Gains on restating and settling foreign-currency receivables, payables and bank balances. AS 11 ¶13 takes these to the P&L in the period they arise — there is no reserve to park them in. 🔴 Kept apart from Exchange Loss: netting them makes 'what did the currency cost us this year' unanswerable.",
  },
  fx_loss: {
    label: "Exchange Loss",
    tallyGroup: "Indirect Expenses",
    accountType: "expense",
    help: "⭐ Losses on the same items. ⚠️ Both realised and unrealised land here; what tells them apart is the document, which is on the transaction, not a fourth ledger to map.",
  },
  fx_receivable_contra: {
    label: "Sundry Debtors (FX restatement)",
    tallyGroup: "Sundry Debtors",
    accountType: "asset",
    help: "⚠️ THE FALLBACK ONLY. A restatement normally moves the SAME debtors ledger the invoice sits in, resolved per item. Map this if you want restatements collected separately — and expect your debtors control to differ from the sum of the customer statements by exactly this balance.",
  },
  fx_payable_contra: {
    label: "Sundry Creditors (FX restatement)",
    tallyGroup: "Sundry Creditors",
    accountType: "liability",
    help: "⚠️ The fallback for payables. Same caveat as the debtors contra.",
  },
  fx_bank_contra: {
    label: "Foreign Currency Bank (FX restatement)",
    tallyGroup: "Bank Accounts",
    accountType: "asset",
    help: "⚠️ The fallback for a foreign-currency bank or cash balance. Normally the account's own ledger is used, because a bank reconciliation compares this balance with a statement.",
  },
};

/* ================================================================== */
/* ⭐⭐⭐ THE POSTING-ROLE REGISTRY — Batch 0108                        */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 TWENTY-SEVEN ROLES WERE REFUSED BY A SCREEN THAT EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * The brief for this batch said the posting-accounts screen "does not
 * exist". Measured against the tree, that is not quite the defect. The
 * screen is at `/accounting/posting`, it is registered in
 * `lib/modules/registry.ts` under `money`, and it has worked since v0.99.
 *
 * What it could not do was reach five of the nine role families. Its list
 * came from an `ALL_ROLE_META` in `server/actions/sales-posting.ts` built
 * as `{...POSTING, ...PURCHASE, ...CONSTRUCTION, ...PROPERTY}` — four of
 * the nine. `METERING`, `PAYROLL`, `RETURN`, `FIXED_ASSET` and `FX` were
 * never in it.
 *
 * 🔴 AND THE WRITE PATH WAS BUILT FROM THE SAME OBJECT.
 * `setSalesPostingAccount` validates with
 * `z.enum(Object.keys(ALL_ROLE_META))`, so `fx_gain` was not merely absent
 * from the form — it was REFUSED BY THE SERVER ACTION. The loop had no
 * exit:
 *
 *   • `server/fx/revaluation-service.ts` refuses a revaluation with "no
 *     ledger is mapped for fx_gain. Map them on the posting-accounts
 *     screen and post the run."
 *   • the operator opens the posting-accounts screen
 *   • `fx_gain` is not on it, and could not have been saved if it were
 *
 * The same for `depreciation_expense` — `fixedAssetAccountsNeeded()` in
 * `server/actions/fixed-assets.ts` computes exactly which fixed-asset
 * roles are unmapped, renders the list, and had nowhere to send anybody.
 * 0100 shipped a depreciation engine that no navigation reached for four
 * batches; this is the same defect one level down. The engine is reachable
 * now and the accounts it needs were not mappable.
 *
 * ⭐ SO THE LIST OF ROLES BECOMES ONE DECLARED THING, HERE, BESIDE THE
 * BUILDERS THAT EMIT THEM, and both the form and the validator read it.
 * Adding a role family to this file without adding it to the registry is
 * still possible; `tests/ui/posting-accounts.test.ts` fails when it
 * happens, which is the cheapest place to catch it.
 *
 * ⚠️ `modules` IS A LIST AND NOT A SINGLE `side`. The old screen computed
 * `role in PROPERTY ? "property" : role in CONSTRUCTION ? ...`, a
 * precedence chain that gives one answer where the truth is several:
 * `bank` is needed by sales receipts AND vendor payments, `tds_payable` by
 * purchases, construction AND property, `output_cgst` by every sales
 * document AND the monthly return. Telling an operator that `bank` is "a
 * sales role" is why nobody maps it before running payroll.
 */
export type PostingModuleKey =
  | "sales"
  | "purchase"
  | "construction"
  | "property"
  | "metering"
  | "payroll"
  | "gst_return"
  | "fixed_assets"
  | "fx";

export const POSTING_MODULES: Record<
  PostingModuleKey,
  { readonly label: string; readonly needs: string }
> = {
  sales: {
    label: "Sales & receipts",
    needs: "Invoices, credit notes and customer receipts cannot reach the P&L until these are mapped.",
  },
  purchase: {
    label: "Purchases & vendor payments",
    needs: "Vendor bills, reverse charge and TDS on payment.",
  },
  construction: {
    label: "Contracting & RA bills",
    needs: "Work certified, retention held back, BOCW cess and contractor recoveries.",
  },
  property: {
    label: "Property & bookings",
    needs: "Demand notices, booking receipts, possession, cancellation and brokerage.",
  },
  metering: {
    label: "Utility metering",
    needs: "Energy recovered from consumers, and the electricity duty collected for the State.",
  },
  payroll: {
    label: "Payroll",
    needs: "The gross wage bill and every statutory deduction held on an employee's behalf.",
  },
  gst_return: {
    label: "Monthly GST return",
    needs: "The set-off of a month's output tax against its credit, and what is paid in cash.",
  },
  fixed_assets: {
    label: "Fixed assets & depreciation",
    needs: "🔴 The depreciation run refuses outright until these are mapped — see the fixed-assets screen.",
  },
  fx: {
    label: "Foreign exchange",
    needs: "🔴 The revaluation refuses outright until fx_gain and fx_loss are mapped, and says so.",
  },
};

export type PostingRoleEntry = {
  readonly role: string;
  /** Every module whose builder emits this role. Never just one. */
  readonly modules: readonly PostingModuleKey[];
  readonly label: string;
  readonly tallyGroup: string;
  readonly accountType: string;
  readonly help: string;
};

/**
 * ⚠️ BUILT FROM THE NINE META OBJECTS RATHER THAN RETYPED. A hand-written
 * list would be a tenth copy of the same fact, and the drift would be
 * silent: a role present in a builder and missing from the list is exactly
 * the state this registry exists to end.
 *
 * ⚠️ THE FIRST FAMILY TO DECLARE A ROLE OWNS ITS LABEL AND HELP TEXT.
 * `output_cgst` appears in both `POSTING_ROLE_META` and
 * `RETURN_ROLE_META`; the sales wording is the one an operator mapping a
 * chart of accounts wants, and both modules are listed against it either
 * way.
 */
const ROLE_FAMILIES: ReadonlyArray<
  readonly [PostingModuleKey, Record<string, { label: string; tallyGroup: string; accountType: string; help: string }>]
> = [
  ["sales", POSTING_ROLE_META],
  ["purchase", PURCHASE_ROLE_META],
  ["construction", CONSTRUCTION_ROLE_META],
  ["property", PROPERTY_ROLE_META],
  ["metering", METERING_ROLE_META],
  ["payroll", PAYROLL_ROLE_META],
  ["gst_return", RETURN_ROLE_META],
  ["fixed_assets", FIXED_ASSET_ROLE_META],
  ["fx", FX_ROLE_META],
];

function buildRegistry(): readonly PostingRoleEntry[] {
  const byRole = new Map<string, { entry: Omit<PostingRoleEntry, "modules">; modules: PostingModuleKey[] }>();

  for (const [moduleKey, meta] of ROLE_FAMILIES) {
    for (const [role, m] of Object.entries(meta)) {
      const existing = byRole.get(role);
      if (existing) {
        if (!existing.modules.includes(moduleKey)) existing.modules.push(moduleKey);
        continue;
      }
      byRole.set(role, {
        entry: { role, label: m.label, tallyGroup: m.tallyGroup, accountType: m.accountType, help: m.help },
        modules: [moduleKey],
      });
    }
  }

  return [...byRole.values()].map(({ entry, modules }) => ({ ...entry, modules }));
}

/** ⭐ Every role any posting builder in this file can emit. */
export const POSTING_ROLE_REGISTRY: readonly PostingRoleEntry[] = buildRegistry();

/** The same, keyed, for the validator and the resolver. */
export const POSTING_ROLE_KEYS: readonly string[] = POSTING_ROLE_REGISTRY.map((r) => r.role);

/**
 * ⭐ Which modules cannot post at all until this role is mapped, for the
 * refusal messages that used to point at nothing.
 */
export function modulesNeeding(role: string): readonly PostingModuleKey[] {
  return POSTING_ROLE_REGISTRY.find((r) => r.role === role)?.modules ?? [];
}

/**
 * ⭐⭐ WHERE A ROLE IS MAPPED. One string, in one place.
 *
 * 🔴 THREE REFUSAL MESSAGES IN THIS PRODUCT END WITH SOME VERSION OF "map
 * them on the posting-accounts screen" AND NONE OF THEM CARRIES THE
 * ADDRESS:
 *
 *   • `server/fx/revaluation-service.ts` — "Map them on the
 *     posting-accounts screen and post the run."
 *   • `server/actions/fx.ts` — "Map them on the posting-accounts screen,
 *     then post the run."
 *   • `server/actions/banking.ts` — "Map them on the posting accounts
 *     screen" (no hyphen, which is its own small evidence that three
 *     people wrote the same sentence from memory).
 *
 * A refusal that names a screen without naming its address is a refusal
 * the reader has to go and hunt from. This function is the address, and
 * it deep-links to the module's own section so the operator lands on the
 * four rows they need rather than the top of sixty-six.
 *
 * ⚠️ THE THREE MESSAGES ABOVE ARE NOT ALL EDITED BY THIS BATCH.
 * `server/fx/*` belongs to another stream in this wave and
 * `server/actions/banking.ts` to a third. The destination and this helper
 * are what Batch 0108 could deliver; the one-line change at each call site
 * is listed in the batch report rather than made across an ownership line.
 */
export function postingAccountsHref(module?: PostingModuleKey): string {
  return module ? `/accounting/posting#module-${module}` : "/accounting/posting";
}

/** The sentence, with the address in it. */
export function mapAccountsSentence(module: PostingModuleKey): string {
  return `Map them on the posting accounts screen at ${postingAccountsHref(module)}.`;
}
