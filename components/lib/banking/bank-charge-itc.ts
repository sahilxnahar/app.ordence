/**
 * Ordence — ⭐⭐⭐ THE INPUT CREDIT ON A BANK CHARGE
 * Version: v1.67.0-alpha (Batch 0110)
 *
 * Pure. No clock, no network, no database. Every date is an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PROBLEM, STATED HONESTLY
 * ══════════════════════════════════════════════════════════════════════
 * 0102 posts the GROSS bank charge to `bank_charges` and the role help
 * says to claim the input tax credit from the bank's own tax invoice by
 * hand. Nothing records that it is owed, nothing totals it, and nothing
 * ever asks. So the credit on every bank charge is silently unclaimed —
 * and "silently" is the word that matters. A business paying ₹1,180 a
 * month in charges is giving up around ₹2,160 of credit a year and has
 * no line anywhere that says so.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WHY THE RATE IS NOT DERIVED, CONFIGURED, OR DEFAULTED
 * ══════════════════════════════════════════════════════════════════════
 * The obvious fix is to split 18% off every charge. It is wrong, and it
 * is wrong in the way that survives review and fails an audit:
 *
 * 🔴 s.16(2)(a) CGST ACT — A REGISTERED PERSON IS ENTITLED TO CREDIT ONLY
 *    IF HE IS IN POSSESSION OF A TAX INVOICE. At the moment a statement
 *    line is written up there is no invoice. The bank issues one
 *    separately, usually monthly and consolidated.
 *
 * 🔴 s.16(2)(aa) CGST ACT, READ WITH RULE 36(4) — the credit must have
 *    been furnished by the supplier and communicated to the recipient,
 *    which in practice means it appears in GSTR-2B. A figure derived
 *    from a statement line has no supplier invoice number, so it can
 *    never be matched to a 2B row. It would sit in GSTR-3B as an
 *    unsupported claim, which is the shape a notice is written about.
 *
 * ⚠️ AND 18% IS NOT EVEN RELIABLY THE ANSWER. Interest is exempt
 *    (Notification 12/2017-Central Tax (Rate), entry 27). The place of
 *    supply for banking services is the location of the recipient on the
 *    supplier's records — s.12(12) IGST Act — so a charge from a branch
 *    in another state is IGST and not CGST+SGST, and a rate split
 *    computed here would put it in the wrong box of the wrong return.
 *
 * ⭐ AND MAKING THE OPERATOR TYPE THE SPLIT AT WRITE-UP TIME IS THE SAME
 *    GUESS WITH A HUMAN ALIBI. They do not have the invoice either. They
 *    would type 18% because the screen asked for a number.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ SO: POSTED GROSS, DEFERRED EXPLICITLY, CLOSED ONLY AGAINST A REAL
 *    INVOICE
 * ══════════════════════════════════════════════════════════════════════
 * The charge is posted gross exactly as 0102 posts it — which is
 * CORRECT at that moment, because gross is what left the account and no
 * invoice exists. What 0110 adds is the record that was missing:
 *
 *   awaiting_invoice   the charge is posted, the credit is not claimed,
 *                      and nobody has said why. The default, and it is
 *                      COUNTED and shown per tax period.
 *   invoice_recorded   the bank's tax invoice has been entered — number,
 *                      date, GSTIN — and the split transcribed FROM IT.
 *   not_claimable      somebody decided, with a reason. Exempt supply,
 *                      or blocked under s.17(5).
 *
 * 🔴 THE STATE IS NOT DECORATION. It decides which total the row lands
 *    in on the register screen, and the three totals answer three
 *    different questions: what is unclaimed, what is ready to claim, and
 *    what was deliberately given up.
 *
 * ⚠️ THE ONE ARITHMETIC RULE, AND IT IS THE WHOLE GUARD AGAINST A GUESS
 *    COMING BACK IN THROUGH THE FORM:
 *
 *        taxable + cgst + sgst + igst + cess = the gross that left the bank
 *
 *    A transcribed invoice foots to the money that actually moved. A
 *    guessed 18% on a charge that was really 18% on a part and exempt on
 *    the rest does not. This is the check that refuses it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not build the journal that moves the tax out of Bank Charges
 * into input credit — `Dr Input CGST, Dr Input SGST, Cr Bank Charges`.
 * That is a posting builder and every posting builder in this product
 * lives in `lib/accounting/sales-posting.ts`, which this batch does not
 * own. The register records what the journal needs and says so on the
 * screen; the builder is named in this batch's report as a handoff. A
 * second posting path in the banking module is how the period lock came
 * to be forgotten once already.
 */

import type { Minor } from "./match";

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THESE STRINGS ARE STORED IN `bank_charge_itc_deferrals.status` and
 * are checked by a CHECK constraint in 0110. Renaming one here without
 * renaming it there produces rows the database refuses, which is the
 * right failure — but it is worth knowing that is what will happen.
 */
export const ITC_DEFERRAL_STATUSES = Object.freeze([
  "awaiting_invoice",
  "invoice_recorded",
  "not_claimable",
] as const);

export type ItcDeferralStatus = (typeof ITC_DEFERRAL_STATUSES)[number];

export const ITC_STATUS_META: Record<
  ItcDeferralStatus,
  { label: string; help: string }
> = {
  awaiting_invoice: {
    label: "No tax invoice yet",
    help: "The charge is posted gross and the input credit on it is not claimed. That is correct until the bank's tax invoice arrives — s.16(2)(a) needs the invoice in hand — but it is not correct to leave it here forever. Ask the bank for the invoice, or mark it not claimable with a reason.",
  },
  invoice_recorded: {
    label: "Invoice recorded, credit identifiable",
    help: "The bank's tax invoice has been entered and the split transcribed from it. The credit is now a known amount attached to a known invoice number and GSTIN, which is what a GSTR-2B match and a GSTR-3B claim both need.",
  },
  not_claimable: {
    label: "Not claimable, deliberately",
    help: "Somebody decided this credit will not be taken and said why. An exempt supply carries no credit to take; a blocked credit under s.17(5) carries one that may not be taken. Both are recorded rather than left looking like an oversight.",
  },
};

/**
 * The tax as it is PRINTED ON THE BANK'S INVOICE. Never computed here.
 *
 * ⚠️ ALL FIVE ARE MAGNITUDES IN PAISE. The gross a bank charge takes is
 * negative on the statement line, and `postBankLineAdjustment` already
 * turns it into a positive magnitude before posting. Keeping the same
 * convention here means the arithmetic check below is a plain sum.
 */
export interface TranscribedTaxInvoice {
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly supplierGstin: string;
  readonly taxableValueMinor: Minor;
  readonly cgstMinor: Minor;
  readonly sgstMinor: Minor;
  readonly igstMinor: Minor;
  readonly cessMinor: Minor;
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE ARITHMETIC RULE                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT THE INVOICE SAYS THE CHARGE WAS WORTH, IN TOTAL.
 * Exact bigint addition. There is no float and no rate anywhere here.
 */
export function transcribedTotalMinor(invoice: TranscribedTaxInvoice): Minor {
  return (
    invoice.taxableValueMinor +
    invoice.cgstMinor +
    invoice.sgstMinor +
    invoice.igstMinor +
    invoice.cessMinor
  );
}

/** ⭐ THE CREDIT. Every tax head, and nothing else. */
export function claimableCreditMinor(invoice: TranscribedTaxInvoice): Minor {
  return (
    invoice.cgstMinor + invoice.sgstMinor + invoice.igstMinor + invoice.cessMinor
  );
}

/**
 * ⭐⭐⭐ THE REFUSALS, IN THE ORDER A PERSON WOULD NOTICE THEM.
 *
 * ⚠️ RETURNS A SENTENCE OR NULL, NEVER THROWS. The server action turns
 * the sentence into a refusal the operator reads; a throw here would
 * make every one of these look like the same fault.
 *
 * 🔴 `grossMinor` IS THE POSITIVE MAGNITUDE THAT LEFT THE BANK, taken
 *    from the statement line and NOT from the form. A form that supplies
 *    both the gross and the split can be made to foot against itself,
 *    which is a check that always passes.
 */
export function transcriptionRefusal(args: {
  grossMinor: Minor;
  invoice: TranscribedTaxInvoice;
  /** From `describeGstinProblem` in lib/gst/gstin.ts. Null when the GSTIN is good. */
  gstinProblem: string | null;
  /** The bank's value date on the charge. The invoice cannot precede the charge by much. */
  chargeValueDate: string;
}): string | null {
  const { grossMinor, invoice } = args;

  if (invoice.invoiceNo.trim().length === 0) {
    return "The bank's invoice number is required. Without it the credit cannot be matched to a GSTR-2B row, and an input credit that cannot be matched is one a proper officer will ask about.";
  }

  if (args.gstinProblem !== null) {
    return `The bank's GSTIN is not usable: ${args.gstinProblem} A credit claimed against a GSTIN that does not exist is rejected when the return is filed, weeks later, and the month is closed by then.`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.invoiceDate)) {
    return "The invoice date must be a real date in YYYY-MM-DD form.";
  }

  /**
   * ⚠️ THE INVOICE MAY BE DATED AFTER THE CHARGE — banks consolidate a
   * month and invoice at the end of it. It may NOT be dated before the
   * charge: an invoice for a service cannot predate the money leaving
   * the account, and a date typed a year early puts the credit in a
   * return that has already been filed.
   */
  if (invoice.invoiceDate < args.chargeValueDate) {
    return `The invoice is dated ${invoice.invoiceDate} and the bank took the money on ${args.chargeValueDate}. An invoice cannot predate the charge it is for. A date typed into the wrong year puts this credit into a return that has already been filed.`;
  }

  for (const [name, value] of [
    ["taxable value", invoice.taxableValueMinor],
    ["CGST", invoice.cgstMinor],
    ["SGST", invoice.sgstMinor],
    ["IGST", invoice.igstMinor],
    ["cess", invoice.cessMinor],
  ] as const) {
    if (value < 0n) {
      return `The ${name} on the invoice cannot be negative. A credit note from the bank is a separate document and belongs recorded as one.`;
    }
  }

  /**
   * 🔴🔴 CGST+SGST AND IGST ARE MUTUALLY EXCLUSIVE ON ONE SUPPLY.
   *
   * ⚠️ THIS IS A TRANSCRIPTION CHECK, NOT A DETERMINATION. Which applies
   * is decided by the bank under s.12(12) IGST Act — location of the
   * recipient on the supplier's records — and it is printed on the
   * invoice. Nothing here decides it. What this refuses is an invoice
   * transcribed with both, which means a row was read off the wrong
   * line of the bank's statement of charges.
   */
  const hasIntra = invoice.cgstMinor > 0n || invoice.sgstMinor > 0n;
  if (hasIntra && invoice.igstMinor > 0n) {
    return "The invoice has been entered with both IGST and CGST/SGST on it. One supply carries one or the other, never both — check which the bank actually printed and enter only that.";
  }

  if (invoice.cgstMinor !== invoice.sgstMinor) {
    return "CGST and SGST on one line are always equal. They are two halves of the same rate, so a difference between them is a transcription error rather than something the bank charged.";
  }

  /**
   * 🔴🔴🔴 THE ONE THAT REFUSES A GUESS.
   *
   * ⚠️ The transcribed invoice must foot to the money that actually left
   * the account. 18% assumed on a charge that was partly exempt does not
   * foot; a rate read off the invoice does. This is why the split is
   * never derived, configured or defaulted anywhere in this module.
   */
  const total = transcribedTotalMinor(invoice);
  if (total !== grossMinor) {
    return (
      `The invoice as entered comes to ${total.toString()} paise and the bank took ${grossMinor.toString()} paise. ` +
      `They have to agree: this row is the credit on THIS charge, so its taxable value plus every tax head is the gross that left the account. ` +
      `If the bank's invoice covers several charges together, enter against each charge the part of the invoice that belongs to it. ` +
      `⚠️ Do not adjust a figure to make this balance — a split that does not foot is a split that was assumed rather than read, and it is the exact thing this refusal exists to stop.`
    );
  }

  if (claimableCreditMinor(invoice) === 0n) {
    return "This invoice carries no tax at all, so there is no credit to record. If the charge is genuinely exempt — interest is, under Notification 12/2017-Central Tax (Rate) entry 27 — mark it not claimable with that reason instead. The two look the same on a total and mean different things.";
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE REGISTER, TOTALLED                                          */
/* ------------------------------------------------------------------ */

/** One row of the register, as the screen and the totals need it. */
export interface DeferralRow {
  readonly id: string;
  readonly statementLineId: string;
  readonly valueDate: string;
  /** ⚠️ `YYYY-MM`. The month the bank took the money, never the month it was noticed. */
  readonly taxPeriod: string;
  readonly grossMinor: Minor;
  readonly status: ItcDeferralStatus;
  /** Zero unless `status` is `invoice_recorded`. */
  readonly creditMinor: Minor;
  readonly invoiceNo: string | null;
  /**
   * ⭐⭐ 0112. NULL MEANS "IDENTIFIED AND STILL SITTING IN BANK CHARGES",
   * which is a worklist and not an error.
   *
   * 🔴 THIS IS NOT A STATUS AND MUST NOT BECOME ONE. Six of 0110's CHECK
   * constraints are written `status <> 'invoice_recorded' OR <rule>`; a
   * fourth status would switch all six off for precisely the rows whose
   * figures are already in the ledger. The full argument is in the header
   * of `SQL-FILES/0112_bank_charge_itc_posting.sql`, and step ⑧ of its
   * drill demonstrates the constraint still firing on a posted row.
   */
  readonly creditPostedAt: string | null;
  readonly creditTransactionId: string | null;
}

export interface ItcPeriodTotals {
  readonly taxPeriod: string;
  readonly chargeCount: number;
  /** Gross charges posted in this period, all statuses. */
  readonly grossMinor: Minor;
  /**
   * 🔴 GROSS OF CHARGES WITH NO INVOICE. Deliberately NOT an estimate of
   * the credit: estimating it would need a rate, and needing a rate is
   * the whole reason this register exists. The screen says "the credit
   * on this is unknown until the invoice arrives" and means it.
   */
  readonly awaitingInvoiceGrossMinor: Minor;
  readonly awaitingInvoiceCount: number;
  /** ⭐ A KNOWN AMOUNT, transcribed from invoices. This is claimable. */
  readonly identifiedCreditMinor: Minor;
  readonly identifiedCount: number;
  /** Charges somebody deliberately wrote off, with a reason on each row. */
  readonly notClaimableGrossMinor: Minor;
  readonly notClaimableCount: number;
  /**
   * ⭐⭐⭐ 0112. THE SPLIT INSIDE `identified`, AND IT IS THE ONE THE
   * ACCOUNTANT ACTS ON.
   *
   * `identifiedCreditMinor` answers "how much credit do we know about".
   * These two answer the next question, which nobody could ask before:
   * how much of it is in the books, and how much is still sitting inside
   * Bank Charges waiting for somebody to press a button.
   *
   * ⚠️ `posted + unposted = identified`, ALWAYS, and the test asserts it
   * rather than trusting it. Two figures that are supposed to add up to a
   * third and are computed in three places is how a register starts
   * disagreeing with itself.
   */
  readonly postedCreditMinor: Minor;
  readonly postedCount: number;
  readonly unpostedCreditMinor: Minor;
  readonly unpostedCount: number;
}

/**
 * ⭐⭐⭐ THE READ THAT CHANGES WHAT THE SCREEN SAYS.
 *
 * 🔴 THE STATUS DECIDES WHICH BUCKET A ROW LANDS IN, AND THE THREE
 *    BUCKETS ARE THREE DIFFERENT SENTENCES TO AN OPERATOR:
 *
 *      awaiting  → chase the bank for an invoice
 *      identified → claim this in GSTR-3B, it is a number
 *      not claimable → nothing to do, and here is why
 *
 * ⚠️ THEY ARE NEVER NETTED INTO ONE FIGURE. A single "unclaimed credit"
 *    number would combine an amount that is known with one that is not
 *    knowable yet, and the combined figure would be wrong in a direction
 *    nobody could work out.
 */
export function totalByPeriod(
  rows: readonly DeferralRow[],
): readonly ItcPeriodTotals[] {
  const byPeriod = new Map<string, ItcPeriodTotals>();

  for (const row of rows) {
    const prior = byPeriod.get(row.taxPeriod) ?? {
      taxPeriod: row.taxPeriod,
      chargeCount: 0,
      grossMinor: 0n,
      awaitingInvoiceGrossMinor: 0n,
      awaitingInvoiceCount: 0,
      identifiedCreditMinor: 0n,
      identifiedCount: 0,
      notClaimableGrossMinor: 0n,
      notClaimableCount: 0,
      postedCreditMinor: 0n,
      postedCount: 0,
      unpostedCreditMinor: 0n,
      unpostedCount: 0,
    };

    /**
     * ⚠️ `posted` IS ONLY EVER READ ON AN `invoice_recorded` ROW. The
     * CHECK `_posted_needs_invoice` makes any other combination
     * unreachable in the database, and reading it unconditionally here
     * would make this function disagree with that constraint the day
     * somebody hand-writes a row.
     */
    const posted =
      row.status === "invoice_recorded" && row.creditPostedAt !== null;

    byPeriod.set(row.taxPeriod, {
      taxPeriod: row.taxPeriod,
      chargeCount: prior.chargeCount + 1,
      grossMinor: prior.grossMinor + row.grossMinor,
      awaitingInvoiceGrossMinor:
        prior.awaitingInvoiceGrossMinor +
        (row.status === "awaiting_invoice" ? row.grossMinor : 0n),
      awaitingInvoiceCount:
        prior.awaitingInvoiceCount + (row.status === "awaiting_invoice" ? 1 : 0),
      identifiedCreditMinor:
        prior.identifiedCreditMinor +
        (row.status === "invoice_recorded" ? row.creditMinor : 0n),
      identifiedCount:
        prior.identifiedCount + (row.status === "invoice_recorded" ? 1 : 0),
      notClaimableGrossMinor:
        prior.notClaimableGrossMinor +
        (row.status === "not_claimable" ? row.grossMinor : 0n),
      notClaimableCount:
        prior.notClaimableCount + (row.status === "not_claimable" ? 1 : 0),
      postedCreditMinor: prior.postedCreditMinor + (posted ? row.creditMinor : 0n),
      postedCount: prior.postedCount + (posted ? 1 : 0),
      unpostedCreditMinor:
        prior.unpostedCreditMinor +
        (row.status === "invoice_recorded" && !posted ? row.creditMinor : 0n),
      unpostedCount:
        prior.unpostedCount +
        (row.status === "invoice_recorded" && !posted ? 1 : 0),
    });
  }

  // ⚠️ Newest first. An accountant opens this for the month they are
  // filing, which is the most recent one.
  return [...byPeriod.values()].sort((a, b) =>
    a.taxPeriod < b.taxPeriod ? 1 : a.taxPeriod > b.taxPeriod ? -1 : 0,
  );
}

/**
 * ⭐ THE TAX PERIOD A CHARGE BELONGS TO: the month the BANK took the
 * money, from its value date.
 *
 * ⚠️ NEVER THE MONTH IT WAS NOTICED. A March charge found in June belongs
 * in March, which is both correct and the thing that makes the period
 * lock mean something. Same rule as `postBankAdjustment`'s posting date.
 */
export function taxPeriodOf(valueDate: string): string {
  return valueDate.slice(0, 7);
}

/**
 * ⚠️ THE SENTENCE ON THE RECONCILIATION SCREEN. Kept here, next to the
 * totals it describes, rather than in the component: a number and the
 * words explaining it drifting apart is how a screen comes to say the
 * opposite of what it shows.
 */
export function unclaimedCreditNote(totals: ItcPeriodTotals): string | null {
  if (totals.awaitingInvoiceCount === 0) return null;
  return (
    `${totals.awaitingInvoiceCount} bank charge${totals.awaitingInvoiceCount === 1 ? "" : "s"} in ${totals.taxPeriod}, ` +
    `${totals.awaitingInvoiceGrossMinor.toString()} paise gross, ${totals.awaitingInvoiceCount === 1 ? "has" : "have"} no tax invoice recorded. ` +
    `The input credit on ${totals.awaitingInvoiceCount === 1 ? "it" : "them"} is not claimed and cannot be worked out from the statement — the line is one gross figure with no rate, no invoice number and no GSTIN on it. ` +
    `Ask the bank for its tax invoice for the month and record it here. ` +
    `⚠️ Claiming a credit computed from the statement instead would put an unsupported figure in GSTR-3B: s.16(2)(a) requires the invoice, and s.16(2)(aa) requires it to have reached your GSTR-2B.`
  );
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ CAN THIS CREDIT BE POSTED? — 0112                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE REFUSALS FOR POSTING, IN THE ORDER A PERSON WOULD MEET THEM.
 *
 * ⚠️ RETURNS A SENTENCE OR NULL, NEVER THROWS — the same shape as
 * `transcriptionRefusal` above, and for the same reason: the server
 * action turns the sentence into a refusal the operator can read, and the
 * button uses it to explain why it is disabled BEFORE it is pressed. Two
 * codepaths reading one function is what stops the screen and the server
 * giving different answers.
 *
 * 🔴 THIS IS NOT THE AUTHORITY. The database is: `_posted_needs_invoice`,
 * `_posting_pair` and `ordence_guard_posted_itc_deferral` in 0112 refuse
 * the same things without asking this function's permission. This exists
 * so the operator is told in words instead of meeting a constraint
 * violation.
 */
export function postingRefusal(row: {
  status: ItcDeferralStatus;
  creditMinor: Minor;
  creditPostedAt: string | null;
  invoiceNo: string | null;
}): string | null {
  if (row.creditPostedAt !== null) {
    return `The credit on this charge was already posted to the ledger. Posting it again would double the input credit claimed on one invoice, which is the shape a Rule 36(4) mismatch is written about.`;
  }

  if (row.status === "awaiting_invoice") {
    return "There is no invoice recorded against this charge yet, so there is no figure to post. Section 16(2)(a) gives no credit without the invoice in hand, and a figure derived from the statement line would be a rate this product deliberately never guesses.";
  }

  if (row.status === "not_claimable") {
    return "This charge was marked not claimable, with a reason. Posting a credit for it now would contradict a decision somebody recorded. Reverse that decision first, so the register shows it was changed rather than that it never happened.";
  }

  if (row.creditMinor <= 0n) {
    return `Invoice ${row.invoiceNo ?? "(unnumbered)"} carries no tax, so there is no credit to move out of Bank Charges. A charge that is wholly exempt — bank interest is, under Notification 12/2017-Central Tax (Rate) entry 27 — is marked not claimable with that as the reason, which says the same thing and says it where somebody will read it.`;
  }

  return null;
}

/**
 * ⭐ THE SENTENCE THE REGISTER SHOWS AGAINST A ROW, once posting exists
 * as a thing that can have happened or not.
 *
 * ⚠️ IT DISTINGUISHES "identified, not yet in the books" FROM "in the
 * books", which the three statuses cannot. Before 0112 both looked
 * identical on this screen and one of them was a job nobody knew was
 * outstanding.
 */
export function postingStateLabel(row: {
  status: ItcDeferralStatus;
  creditPostedAt: string | null;
}): string {
  if (row.status !== "invoice_recorded") return ITC_STATUS_META[row.status].label;
  return row.creditPostedAt === null
    ? "Recorded, not yet posted"
    : "Posted to the ledger";
}

/**
 * ⭐ A PERIOD WITH NO CHARGES IN IT, AS A FUNCTION RATHER THAN A LITERAL.
 *
 * 🔴 THIS EXISTS BECAUSE THE LITERAL WAS WRITTEN OUT BY HAND IN
 * `server/actions/banking.ts` and 0112 broke it. Adding four fields to
 * `ItcPeriodTotals` turned a hand-written zero-totals object into a type
 * error — which is the GOOD outcome, and it is good only because
 * `ItcPeriodTotals` has no optional members. The next person adding a
 * bucket should not have to find every place somebody spelled out nine
 * zeroes.
 */
export function emptyTotalsFor(taxPeriod: string): ItcPeriodTotals {
  return {
    taxPeriod,
    chargeCount: 0,
    grossMinor: 0n,
    awaitingInvoiceGrossMinor: 0n,
    awaitingInvoiceCount: 0,
    identifiedCreditMinor: 0n,
    identifiedCount: 0,
    notClaimableGrossMinor: 0n,
    notClaimableCount: 0,
    postedCreditMinor: 0n,
    postedCount: 0,
    unpostedCreditMinor: 0n,
    unpostedCount: 0,
  };
}
