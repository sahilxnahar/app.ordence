import "server-only";

/**
 * Ordence — the call-site register: every path that creates a taxable line
 * Version: v1.81.0-alpha · Wave 17 · Track E
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS, AND WHY IT IS DATA RATHER THAN PROSE
 * ══════════════════════════════════════════════════════════════════════
 * The tax computation in `server/tax/compute.ts` has no callers. A
 * dedicated Wiring track is going to add them. The failure mode of that
 * hand-off is not that the wiring is done badly — it is that it is done
 * to FIVE of the SIX paths, and the sixth keeps computing GST its own
 * way. Two implementations of GST is a defect even when both are right,
 * because they will not stay right together.
 *
 * ⭐ SO THE LIST IS NOT A LIST SOMEBODY MAINTAINS FROM MEMORY. It is data,
 * and `tests/security/tax-call-sites.test.ts` re-derives the same set
 * from two independent sources and fails when they disagree:
 *
 *   1. From the DATABASE — every table in `information_schema` carrying a
 *      CGST/SGST/IGST column. A new tax-bearing table that nobody added
 *      here fails the suite.
 *   2. From the SOURCE TREE — every `.insert(sym)` / `.update(sym)` and
 *      raw SQL write against those tables' Drizzle symbols. A new writer
 *      that nobody added here fails the suite.
 *   3. Back against the tree — every entry's `anchor` must still be
 *      present in its file. A writer that MOVED, or was renamed, or was
 *      deleted, fails the suite.
 *
 * ⚠️ THAT IS THE POINT OF THE `anchor` FIELD AND IT IS NOT DECORATION. A
 * line number goes stale silently. A literal substring from the call site
 * goes stale loudly.
 *
 * ⚠️ THIS FILE DECIDES NO TAX. It is a map. Every rule lives in
 * `lib/gst/`; the one computation is `server/tax/compute.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * HOW TO USE IT IF YOU ARE THE WIRING TRACK
 * ══════════════════════════════════════════════════════════════════════
 * Work `status: "must-wire"` in the order given. For each one,
 * `CALL-SITES-E.md` states the exact function to call, its signature, the
 * preconditions, the postconditions, and — the part that matters — the
 * `assertion`, which is a SQL statement that returns a number you can
 * look at. Wire it, run the assertion, and you have proved it rather than
 * believed it.
 *
 * ⚠️ `status: "third-party-figures"` MUST NOT BE WIRED. Those record
 * somebody else's numbers — a supplier's bill, a government JSON. Running
 * our engine over them and storing the result would replace what we were
 * told with what we think, which is the opposite of what a purchase
 * record is for.
 */

/**
 * What is true of a write path today, and what should happen to it.
 *
 * ⚠️ THERE IS NO `"done"` AND NO `"ignore"`. Every value here is a claim
 * about the world that the test can check or that CALL-SITES-E.md has to
 * justify. A bucket meaning "we decided not to think about this" is where
 * the sixth path goes to hide.
 */
export type CallSiteStatus =
  /** Already reaches `lib/gst/tax.ts computeInvoiceTax`. Still needs the RATE resolved. */
  | "computes-but-unpinned"
  /** Must be changed to call `server/tax/compute.ts`. The Wiring track's queue. */
  | "must-wire"
  /** Records a third party's figures on purpose. Must NOT be wired. */
  | "third-party-figures"
  /** Sums its children. Computes nothing; correct as long as the children are. */
  | "aggregate-only"
  /** A rate master or price list, not a document. */
  | "master-data"
  /** Named in the brief or schema-adjacent, but carries no GST columns at all. */
  | "no-tax-columns"
  /** The writer exists and nothing reaches it. Wiring it would be wiring dead code. */
  | "unreachable"
  /**
   * Writes a tax-bearing table WITHOUT touching a tax column — a status
   * change, a settlement, an FX carrying amount.
   *
   * ⚠️ THESE ARE IN THE REGISTER ON PURPOSE AND THE REASON IS NOT
   * COMPLETENESS FOR ITS OWN SAKE. `server/actions/eway.ts` writes
   * `sales_invoices`. Somebody scanning for "where do sales invoices get
   * written" finds it, sees an untouched table, and either wires it —
   * putting a tax computation inside an e-way bill number write-back —
   * or concludes the register is wrong. Naming it, with the reason,
   * costs three lines and removes both outcomes.
   */
  | "non-tax-write";

export type CallSite = {
  /** Stable id. Used by CALL-SITES-E.md and by the test's failure messages. */
  readonly id: string;
  /** The physical table written. */
  readonly table: string;
  /** The Drizzle symbol, so the test can grep for `.insert(sym)`. */
  readonly drizzleSymbol: string;
  /** Repo-relative path of the writer. */
  readonly file: string;
  /** The function containing the write. */
  readonly fn: string;
  /**
   * A literal substring that must still exist in `file`. Not a line
   * number: a line number rots in silence.
   */
  readonly anchor: string;
  readonly status: CallSiteStatus;
  /** Where the tax numbers come from TODAY, in one clause. */
  readonly taxSource: string;
  /** What the Wiring track must call. Absent when the answer is "nothing". */
  readonly requiredCall?: string;
  /** What must hold before the call. */
  readonly preconditions?: readonly string[];
  /** What is true after it. */
  readonly postconditions?: readonly string[];
  /**
   * ⭐ THE PROOF. A SQL statement returning one number, and what that
   * number must be once the site is wired. This is what turns "I wired
   * it" into "here is the command and the output".
   */
  readonly assertion?: { readonly sql: string; readonly expect: string };
  /** Why this status, when the status is not the obvious one. */
  readonly note?: string;
};

/**
 * ⭐ THE STANDARD WIRING CALL, WRITTEN OUT ONCE.
 *
 * ⚠️ THE ORDER IS LOAD-BEARING AND IS NOT A STYLE CHOICE. The decision
 * trail is built AFTER the line insert, because it needs the line ids
 * `.returning()` gives back — a decision written against a guessed id is
 * evidence pointing at the wrong row, which SQL 0150's coverage view
 * would then count as covered.
 *
 * ⚠️ AND IT IS ALL ONE TRANSACTION. A committed invoice with an
 * uncommitted trail is an invoice nobody can defend; a committed trail
 * with no invoice is a citation for a document that does not exist.
 */

/**
 * ⚠️⚠️ WHY FIVE FUNCTION NAMES IN THIS FILE ARE SPELT IN TWO PIECES.
 *
 * `scripts/check-action-reachability.mjs` decides whether a server action
 * is reachable by looking for its IDENTIFIER anywhere under `app/`,
 * `components/`, `server/` or `lib/`. Its own header is candid about the
 * hazard — *"a census that counts mentions counts writing"* — and about
 * which direction of error is the dangerous one:
 *
 *     "Reporting a wired action as an orphan is a visible, arguable
 *      mistake; reporting an orphan as wired is the one that hides."
 *
 * 🔴 AND THIS REGISTER DID EXACTLY THAT. `server/tax/call-sites.ts` lives
 * under `server/`, so simply NAMING an orphaned action here made it read
 * as reached. The first run of `npm run check:action-reach` after this
 * file existed reported *"5 action(s) became reachable since the
 * baseline"* — `amendOrder`, `computeRebate`,
 * `issueInvoiceForCurrentPeriod`, `recordManualPayment` and `voidInvoice`.
 * Not one of them had gained a caller. A map had changed the territory,
 * and the next `--write-baseline` would have laundered five dead actions
 * permanently.
 *
 * ⭐ SO THE FIVE ORPHANS ARE STORED SPLIT AND JOINED AT RUNTIME. Only
 * those five: naming a LIVE action costs nothing, and splitting all
 * forty-two would make the register unreadable to buy nothing. The
 * generated `CALL-SITES-E.md` shows them whole, because a markdown file
 * is not walked by the gate.
 *
 * ⚠️ THE REAL FIX IS IN THE GATE, NOT HERE, and it is
 * PATCH-REQUEST-E.md P16. This is the workaround that keeps the orphan
 * count honest until that lands. If you add an entry for an action that
 * is currently an orphan, split it the same way — and if you do not, the
 * only symptom will be a number quietly getting better.
 */
const orphanName = (...parts: readonly string[]): string => parts.join("");

const WIRE_CALL = [
  "const tax = await computePersistableTax(tenantId, {",
  "  supplierRegistrationId, supplyType, recipientRegistration,",
  "  recipientStateCode, propertyStateCode, deliveryStateCode,",
  "  taxPointDate: <the document's own date>, lines,",
  "});",
  "if (!tax.ok) return fail(tax.error);",
  "",
  "const write = buildTaxWriteForSalesInvoice({ tax: tax.value, documentDate });",
  "",
  "const [header] = await tx.insert(<headerTable>)",
  "  .values({ ...write.header, /* the caller's own identity fields */ })",
  "  .returning({ id: <headerTable>.id });",
  "",
  "const rows = await tx.insert(<lineTable>)",
  "  .values(write.lines.map((l) => ({ ...l, invoiceId: header.id, /* identity */ })))",
  "  .returning({ id: <lineTable>.id, lineNo: <lineTable>.lineNo });",
  "",
  "await recordTaxDecisions(tenantId, buildTaxDecisionsForSalesInvoice({",
  "  tax: tax.value, documentId: header.id, documentDate,",
  "  lineIdByKey: <map the returned ids back by key>,",
  "}), tx);",
].join("\n");

/**
 * ⭐ THE REGISTER. Ordered by consequence, not alphabetically.
 *
 * Every table the schema sweep found is here, including the ones whose
 * honest entry is "this has no GST on it at all" — because the brief
 * named RA bills, and the useful answer to "wire RA bills" is that an RA
 * bill has no GST columns and the contractor's GST is a purchase invoice
 * that nothing links to it.
 */
export const TAX_CALL_SITES: readonly CallSite[] = [
  /* ================================================================
   * 1. OUTWARD SUPPLIES — the documents GSTR-1 is built from.
   *    This is the whole mission.
   * ============================================================== */
  {
    id: "sales-invoice-from-order",
    table: "sales_invoices",
    drizzleSymbol: "salesInvoices",
    file: "server/actions/sales-invoices.ts",
    fn: "raiseInvoiceFromOrder",
    anchor: "export async function raiseInvoiceFromOrder",
    status: "computes-but-unpinned",
    taxSource:
      "lib/gst/tax.ts computeInvoiceTax via lib/invoicing/build.ts buildInvoice; " +
      "but place_of_supply_code and is_inter_state are COPIED from the order row " +
      "rather than re-derived, and the rate comes from the order line, which got " +
      "it from the client",
    requiredCall: WIRE_CALL,
    preconditions: [
      "The tenant has a gst_registrations row to issue under; quoteTax refuses without one.",
      "Every line carries an HSN or SAC code. A line without one has no defensible rate and computePersistableTax refuses it by name.",
      "hsn_sac_rates holds a period covering the invoice date for each classification.",
    ],
    postconditions: [
      "sales_invoice_lines.hsn_sac_rate_id is the registry row the engine resolved, not a client value.",
      "sales_invoice_lines.hsn_sac_code_id likewise, from quoteTax's codeByLine.",
      "line_total_minor excludes reverse-charge tax (Rule 46(p)); the current inline form adds it.",
      "One tax_decisions row exists per line.",
    ],
    assertion: {
      sql:
        "SELECT count(*) FROM gst_rate_pin_status " +
        "WHERE document_table = 'sales_invoice_lines' " +
        "AND verdict IN ('unbackfillable_no_classification','unbackfillable_rate_disagrees') " +
        "AND document_date >= DATE '2026-09-01'  /* edit: the date wiring shipped */",
      expect:
        "0. Any row means an invoice raised AFTER the wiring still cannot trace its rate.",
    },
  },
  {
    id: "sales-invoice-lines-from-order",
    table: "sales_invoice_lines",
    drizzleSymbol: "salesInvoiceLines",
    file: "server/actions/sales-invoices.ts",
    fn: "raiseInvoiceFromOrder",
    anchor: "insert(salesInvoiceLines)",
    status: "computes-but-unpinned",
    taxSource:
      "amounts from computeInvoiceTax; tax_rate_bps, cess_rate_bps, hsn_sac_rate_id " +
      "and hsn_sac_code_id are copied verbatim from the order line " +
      "(lib/invoicing/build.ts: 'EVERY FIGURE IS COPIED FROM THE ORDER, NOT RECALCULATED')",
    requiredCall: "write.lines from buildTaxWriteForSalesInvoice",
    assertion: {
      sql:
        "SELECT count(*) FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id " +
        "WHERE l.hsn_sac_rate_id IS NULL AND (l.cgst_minor + l.sgst_minor + l.igst_minor) <> 0 " +
        "AND i.invoice_date >= DATE '2026-09-01'  -- edit: the date wiring shipped",
      expect: "0. A taxed line raised after wiring with no rate pin is an unwired path.",
    },
  },
  {
    id: "sales-invoice-from-time",
    table: "sales_invoices",
    drizzleSymbol: "salesInvoices",
    file: "server/actions/time-billing.ts",
    fn: "raiseInvoiceFromTime",
    anchor: "insert(salesInvoices)",
    status: "must-wire",
    taxSource:
      "computeInvoiceTax, and place of supply IS freshly derived here " +
      "(determinePlaceOfSupply, and a disagreeing caller value is refused) — but the " +
      "rate is the file's own effectiveRateBps and hsn_sac_code defaults to the " +
      "literal '9982'",
    requiredCall: WIRE_CALL,
    note:
      "⚠️ THIS IS THE SIXTH PATH. It is the one most likely to be missed: it is not " +
      "in the invoices folder, it is reached from components/billing/bill-time.tsx, " +
      "and it writes sales_invoice_lines WITHOUT hsn_sac_rate_id, hsn_sac_code_id or " +
      "cess_rate_bps at all. Its place-of-supply handling is the BEST in the product " +
      "and its rate handling is the worst, which is exactly the combination that " +
      "survives a review.",
    assertion: {
      sql:
        "SELECT count(*) FROM sales_invoice_lines WHERE hsn_sac_code = '9982' " +
        "AND hsn_sac_code_id IS NULL",
      expect:
        "0 for lines created after wiring. The literal '9982' with no resolved " +
        "classification id is this path's fingerprint.",
    },
  },
  {
    id: "sales-invoice-lines-from-time",
    table: "sales_invoice_lines",
    drizzleSymbol: "salesInvoiceLines",
    file: "server/actions/time-billing.ts",
    fn: "raiseInvoiceFromTime",
    anchor: "insert(salesInvoiceLines)",
    status: "must-wire",
    taxSource: "computeInvoiceTax; no rate pin, no classification id, no cess rate",
    requiredCall: "write.lines from buildTaxWriteForSalesInvoice",
  },
  {
    id: "credit-note",
    table: "sales_credit_notes",
    drizzleSymbol: "salesCreditNotes",
    file: "server/actions/sales-invoices.ts",
    fn: "raiseCreditNote",
    anchor: "export async function raiseCreditNote",
    status: "must-wire",
    /*
     * ⚠️ THE DEFECT IS DESCRIBED HERE, NOT QUOTED, AND THE REASON IS THE
     * SIXTH OCCURRENCE OF THIS CODEBASE'S PROSE TRAP.
     *
     * `scripts/check-tax-decisions.mjs` refuses a two-way ternary between
     * the IGST and CGST tax-kind literals, which is exactly right. Its
     * header says every check "reads only code", and its stripper is
     * called `stripCommentsAndStrings` — but the body strips comments
     * only and never touches a string literal. So writing the defect out
     * verbatim inside this string fires the gate on the map rather than
     * on the territory. Reported as PATCH-REQUEST-E.md P16; described
     * rather than quoted here, because the fix for MY file is my prose,
     * not an exemption in somebody else's gate.
     */
    taxSource:
      "computeInvoiceTax, but the tax kind is re-derived from the invoice's " +
      "is_inter_state boolean through a two-way ternary between the IGST and " +
      "intra-state literals, which cannot express the Union Territory answer at " +
      "all; and the place of supply falls back to the literal 27 (Maharashtra)",
    requiredCall: WIRE_CALL,
    note:
      "🔴 THREE SEPARATE DEFECTS ON ONE SCREEN, and one of them is money: " +
      "cessRateBps is hardcoded 0, so a credit note against a cess-bearing line " +
      "reverses the GST and not the cess, which s.34 requires. That one also needs " +
      "a cess_rate_bps column on sales_credit_note_lines — PATCH-REQUEST-E.md P5.",
    assertion: {
      sql:
        "SELECT count(*) FROM sales_credit_notes n JOIN sales_invoices i ON i.id = n.invoice_id " +
        "WHERE i.is_union_territory AND NOT n.is_inter_state " +
        "AND n.note_date >= DATE '2026-09-01'  -- edit: the date wiring shipped",
      expect:
        "0 is NOT the assertion here — a UT credit note is legitimate. The assertion " +
        "is that its tax_decisions rows carry tax_kind = 'cgst_utgst'; today they " +
        "cannot, because the value is never produced.",
    },
  },
  {
    id: "credit-note-lines",
    table: "sales_credit_note_lines",
    drizzleSymbol: "salesCreditNoteLines",
    file: "server/actions/sales-invoices.ts",
    fn: "raiseCreditNote",
    anchor: "insert(salesCreditNoteLines)",
    status: "must-wire",
    taxSource:
      "amounts from computeInvoiceTax; tax_rate_bps comes STRAIGHT FROM THE CLIENT " +
      "PAYLOAD (lib/validators/sales-invoices.ts taxRateBps) rather than from the " +
      "invoice line being credited",
    requiredCall: "write.lines, with the rate read from the invoice line, not the form",
    preconditions: [
      "The line being credited is identified, so its rate and pin can be inherited rather than re-posted.",
    ],
    assertion: {
      sql:
        "SELECT count(*) FROM sales_credit_note_lines c " +
        "JOIN sales_invoice_lines l ON l.id = c.invoice_line_id " +
        "WHERE c.tax_rate_bps IS DISTINCT FROM l.tax_rate_bps",
      expect:
        "0. A credit note at a different rate from the invoice it credits is either " +
        "a typo or a restatement, and both should be refused rather than stored.",
    },
  },
  {
    id: "sales-order",
    table: "sales_orders",
    drizzleSymbol: "salesOrders",
    file: "server/actions/orders.ts",
    fn: "createOrder",
    anchor: "export async function createOrder",
    status: "aggregate-only",
    taxSource:
      "header totals are summarise(priced); the header is ALSO rewritten by the " +
      "database trigger ordence_recompute_order_totals() on every line write",
    note:
      "⚠️ TWO WRITERS, ONE HEADER. The action writes the totals and the trigger " +
      "recomputes them from the lines immediately afterwards. Wiring the action " +
      "without the lines changes nothing, because the trigger has the last word.",
  },
  {
    id: "sales-order-lines",
    table: "sales_order_lines",
    drizzleSymbol: "salesOrderLines",
    file: "server/actions/orders.ts",
    fn: `createOrder / ${orphanName("amend", "Order")} (via lineValuesFor)`,
    anchor: "hsnSacRateId: line.hsnSacRateId ?? null",
    status: "must-wire",
    taxSource:
      "amounts from lib/orders/pricing.ts priceLine — a SECOND implementation of the " +
      "same arithmetic; rate, cess rate, rate pin and classification id all straight " +
      "from the client payload",
    requiredCall: WIRE_CALL,
    note:
      "⭐ THE HIGHEST-VALUE SINGLE LINE IN THE PRODUCT. `hsnSacRateId: " +
      "line.hsnSacRateId ?? null` is where the browser's opinion about which rate " +
      "period applies enters the database and is then copied onto every invoice " +
      "raised from the order. Place of supply, by contrast, IS derived here and a " +
      "disagreeing client value is refused — the machinery for doing this right " +
      "already exists three lines away.",
    assertion: {
      sql:
        "SELECT count(*) FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id " +
        "WHERE l.hsn_sac_rate_id IS NULL AND COALESCE(l.tax_rate_bps,0) <> 0 " +
        "AND o.order_date >= DATE '2026-09-01'  -- edit: the date wiring shipped",
      expect: "0.",
    },
  },

  /* ================================================================
   * 2. THE PLATFORM'S OWN SUBSCRIPTION INVOICES
   * ============================================================== */
  {
    id: "subscription-invoice",
    table: "invoices",
    drizzleSymbol: "invoices",
    file: "server/billing/invoice-generator.ts",
    fn: "generateInvoice",
    anchor: "computeGst(",
    status: "unreachable",
    taxSource:
      "lib/billing/money.ts computeGst — a THIRD implementation: IGST vs CGST/SGST " +
      "by bare state-code equality, no UTGST, no cess, no reverse charge, no rate " +
      "pin, and it defaults to IGST when the place of supply is null",
    requiredCall:
      "computeInvoiceTax from lib/gst/tax.ts, and resolvePlatformIdentity() from " +
      "server/tax/platform-identity.ts for the supplier side",
    note:
      "🔴 STATUS IS `unreachable`, NOT `must-wire`, AND THAT CHANGES THE PRIORITY. " +
      "The only caller chain is generateInvoice ← invoiceCurrentPeriod ← " +
      `${orphanName("issueInvoiceForCurrent", "Period")}, and that last one is an orphan in ` +
      "scripts/action-reachability-baseline.json — zero references in app/, " +
      "components/, app/api/, worker.ts or instrumentation.ts. Ordence has never " +
      "issued one of these. Wiring it before making it reachable would be wiring " +
      "dead code, and PATCH-REQUEST-E.md P3 was written before this was known.",
    assertion: {
      sql: "SELECT count(*) FILTER (WHERE gst_computed), count(*) FROM invoices",
      expect:
        "Today 0 of N. After P3, every row created afterwards must have " +
        "gst_computed = true AND per-line tax — in that order, or 0021's deferred " +
        "trigger refuses the next update of every one of them.",
    },
  },
  {
    id: "subscription-invoice-lines",
    table: "invoice_lines",
    drizzleSymbol: "invoiceLines",
    file: "server/billing/invoice-generator.ts",
    fn: "generateInvoice",
    anchor: "taxRateBps: SAAS_GST_RATE_BPS",
    status: "unreachable",
    taxSource:
      "the constant SAAS_GST_RATE_BPS = 1800 is written to tax_rate_bps and NOTHING " +
      "else — taxable_value_minor stays NULL and all four heads stay 0, while the " +
      "header carries the whole tax",
    note:
      "⚠️ 0147's trigger passes these rows only because COALESCE(taxable_value_minor,0) " +
      "is 0, so the expected tax is 0 and the stored 0 matches. The moment the " +
      "taxable value is populated without the heads, it will refuse — which is the " +
      "correct order to discover that.",
  },

  /* ================================================================
   * 3. INWARD SUPPLIES AND THIRD-PARTY FIGURES — DO NOT WIRE
   * ============================================================== */
  {
    id: "purchase-invoice",
    table: "purchase_invoices",
    drizzleSymbol: "purchaseInvoices",
    file: "server/actions/purchases.ts",
    fn: "recordPurchaseInvoice",
    anchor: "gstComputed: true",
    status: "third-party-figures",
    taxSource:
      "the supplier's figures, transcribed from the client payload by " +
      "server/purchases/engine.ts pricePurchase; the registry rate is resolved and " +
      "used only to raise a non-blocking rateMismatch warning",
    note:
      "⭐ DO NOT WIRE THIS, AND THE REASON IS NOT LAZINESS. A vendor who charged 12% " +
      "where the master says 18% is a dispute to record and pursue. Replacing their " +
      "figure with ours would make the bill we hold disagree with the bill they " +
      "sent, and GSTR-2B reconciliation compares OUR record against THEIR filing. " +
      "It is also the only path in the product that already resolves a rate pin " +
      "server-side, so it is the model for the ones that do not — " +
      "server/purchases/engine.ts:265.",
    assertion: {
      sql:
        "SELECT count(*) FROM purchase_invoice_lines l JOIN hsn_sac_rates r ON r.id = l.gst_rate_id " +
        "WHERE r.rate_bps IS DISTINCT FROM l.rate_bps",
      expect:
        "NOT 0 — a non-zero count is the list of supplier rate disputes to chase, " +
        "and it should be a screen, not an assertion.",
    },
  },
  {
    id: "purchase-invoice-lines",
    table: "purchase_invoice_lines",
    drizzleSymbol: "purchaseInvoiceLines",
    file: "server/actions/purchases.ts",
    fn: "recordPurchaseInvoice",
    anchor: "insert(purchaseInvoiceLines)",
    status: "third-party-figures",
    taxSource: "the supplier's figures; gst_rate_id IS resolved server-side",
  },
  {
    id: "gstr2b-rows",
    table: "gstr2b_rows",
    drizzleSymbol: "gstr2bRows",
    file: "server/actions/gstr2b.ts",
    fn: "importGstr2b",
    anchor: "insert(gstr2bRows)",
    status: "third-party-figures",
    taxSource: "the government's own JSON, parsed by lib/gstr2b/parse.ts",
    note:
      "Recomputing these would defeat the entire purpose of the document: it is the " +
      "counterparty's declaration, and the value of holding it is that it is theirs.",
  },
  {
    id: "bank-charge-itc",
    table: "bank_charge_itc_deferrals",
    drizzleSymbol: "bankChargeItcDeferrals",
    file: "server/banking/bank-charge-itc-service.ts",
    fn: "recordTaxInvoice",
    anchor: "recordTaxInvoice",
    status: "third-party-figures",
    taxSource:
      "the bank's tax invoice, transcribed from the form and footing-checked against " +
      "the gross already on the row (transcriptionRefusal)",
    note:
      "⭐ THE ONLY THIRD-PARTY TRANSCRIPTION IN THE PRODUCT THAT IS ARITHMETICALLY " +
      "CONSTRAINED ON WRITE. The gross comes from the stored row, never the form, so " +
      "a transcription that does not foot is refused. That is the pattern the other " +
      "four should copy.",
  },
  {
    id: "itc-register",
    table: "itc_register",
    drizzleSymbol: "itcRegister",
    file: "server/actions/purchases.ts",
    fn: "recordItcMovement / buildItcForPeriod / runRule42ForPeriod",
    anchor: "insert(itcRegister)",
    status: "third-party-figures",
    taxSource:
      "buildItcForPeriod copies from purchase_invoice_lines; runRule42ForPeriod " +
      "computes the reversal in lib/; recordItcMovement takes the four heads from " +
      "the client payload with no check",
    note:
      "⚠️ MIXED, AND THE MIXTURE IS THE PROBLEM. Two of the three writers are sound " +
      "and the manual one is not. recordItcMovement should at minimum refuse a " +
      "movement whose heads disagree with the invoice it names.",
  },

  /* ================================================================
   * 4. OTHER DOCUMENTS THAT SPLIT GST THEIR OWN WAY
   * ============================================================== */
  {
    id: "stock-transfer",
    table: "stock_transfers",
    drizzleSymbol: "stockTransfers",
    file: "server/actions/transfers.ts",
    fn: "createTransfer",
    anchor: "const half = tax / 2n",
    status: "must-wire",
    taxSource:
      "🔴 inline arithmetic in the action itself — a FOURTH implementation. " +
      "Arithmetically equivalent to applyRateBps/splitEvenly today, and nothing " +
      "keeps it that way.",
    requiredCall:
      "computeInvoiceTax from lib/gst/tax.ts, with the Rule 28 value as the line " +
      "gross and transferTaxTreatment supplying the tax kind",
    note:
      "A branch transfer between two registrations of the same PAN in different " +
      "states IS a supply and does appear in GSTR-1. cess_minor exists on this table " +
      "and is written by nothing.",
    assertion: {
      sql:
        "SELECT count(*) FROM stock_transfers t JOIN stock_transfer_lines l ON l.transfer_id = t.id " +
        "WHERE (t.cgst_minor + t.sgst_minor + t.igst_minor) <> " +
        "(SELECT COALESCE(sum(gst_apply_rate_bps(l2.taxable_value_minor, COALESCE(l2.tax_rate_bps,0))),0) " +
        " FROM stock_transfer_lines l2 WHERE l2.transfer_id = t.id)",
      expect:
        "0. Note this uses 0147's own SQL arithmetic, so it is checking the transfer " +
        "against the same rounding every other document uses.",
    },
  },
  {
    id: "demand-notice",
    table: "demand_notices",
    drizzleSymbol: "demandNotices",
    file: "server/receivables/demands.ts",
    fn: "raiseDemand",
    anchor: "insert(demandNotices)",
    status: "must-wire",
    taxSource:
      "computeInvoiceTax via lib/receivables/demand.ts, at the rate on " +
      "receivable_policies.gst_rate_bps — a per-policy rate, not a registry lookup — " +
      "and taxKind and placeOfSupplyCode come straight from the client payload",
    requiredCall:
      "determinePlaceOfSupply for the tax kind, and the registry for the rate; the " +
      "money arithmetic already goes through the right place",
    note:
      "⚠️ A DEMAND NOTICE ON A PROPERTY BOOKING IS AN IMMOVABLE-PROPERTY SUPPLY, so " +
      "s.12(3)(a) puts the place of supply where the property is — which the engine " +
      "implements and refuses to guess at. Accepting the caller's taxKind bypasses " +
      "the one rule this document type most needs.",
    assertion: {
      sql:
        "SELECT count(*) FROM demand_notices WHERE cgst_minor <> 0 AND igst_minor <> 0",
      expect:
        "0 — but that is the weak check. The real one is a tax_decisions row per " +
        "demand carrying statutory_ref = 'IGST Act s.12(3)(a)'.",
    },
  },
  {
    id: "brokerage-commission",
    table: "channel_partner_commissions",
    drizzleSymbol: "channelPartnerCommissions",
    file: "server/actions/sales-brokerage.ts",
    fn: "raiseBrokerage",
    anchor: "data.cgst ? toMinorUnits(data.cgst)",
    status: "must-wire",
    taxSource:
      "🔴 nothing. The three heads are taken from the client payload with no engine " +
      "call, no place-of-supply determination, no taxable value stored and no " +
      "consistency check of any kind",
    requiredCall: WIRE_CALL,
    note:
      "⚠️ THIS IS AN INWARD SUPPLY WE ARE THE RECIPIENT OF — a broker invoicing us — " +
      "and it is frequently on reverse charge under s.9(3) when the broker is " +
      "unregistered. It has no is_reverse_charge column, no place of supply and no " +
      "taxable value, so it can neither be computed nor checked. Of everything in " +
      "this register it is the least defensible and the smallest table.",
    assertion: {
      sql:
        "SELECT count(*) FROM channel_partner_commissions " +
        "WHERE (cgst_minor <> 0 OR sgst_minor <> 0 OR igst_minor <> 0)",
      expect:
        "Every one of these rows carries tax that no rule produced. The assertion " +
        "after wiring is a tax_decisions row for each.",
    },
  },
  {
    id: "booking-cancellation-reversal",
    table: "bookings",
    drizzleSymbol: "bookings",
    file: "server/actions/sales-bookings.ts",
    fn: "postBookingCancellation",
    anchor: "data.reversedCgst ? toMinorUnits(data.reversedCgst)",
    status: "must-wire",
    taxSource:
      "🔴 the client payload. reversed_cgst_minor / reversed_sgst_minor / " +
      "reversed_igst_minor are typed in and frozen by a trigger thereafter",
    requiredCall:
      "the reversal must be derived from the demand notices actually raised on the " +
      "booking, not posted as a figure",
    note:
      "⚠️ FROZEN-ON-WRITE MAKES THIS WORSE, NOT BETTER. ordence_guard_posted_cancellation " +
      "means a typed-in reversal is permanent. The number that gets frozen is the " +
      "one nobody computed.",
  },

  /* ================================================================
   * 5. CARRY A RATE, COMPUTE NO SPLIT
   * ============================================================== */
  {
    id: "eway-bill-items",
    table: "eway_bill_items",
    drizzleSymbol: "ewayBillItems",
    file: "server/actions/eway.ts",
    fn: "prepareEwayBill",
    anchor: "Math.floor((l.taxRateBps ?? 0) / 2)",
    status: "must-wire",
    taxSource:
      "🔴 it HALVES THE RATE with floor and ceil, putting the odd basis point on " +
      "SGST — the opposite of splitEvenly, which puts the odd minor unit on CGST",
    requiredCall:
      "the rates already stored on the sales_invoice_line the item was copied from",
    note:
      "⭐ THIS IS THE MOST SUBTLE ITEM IN THE REGISTER AND THE EASIEST TO DISMISS. " +
      "The e-way bill declares a rate, not an amount, so the divergence never shows " +
      "up as money on our side. It shows up when the portal's figure is compared " +
      "against the invoice — an odd-basis-point rate is unusual but legal, and when " +
      "one occurs the e-way bill and the invoice it was generated from will state " +
      "different CGST and SGST rates for the same supply.",
    assertion: {
      sql:
        "SELECT count(*) FROM eway_bill_items i " +
        "JOIN eway_bills b ON b.id = i.eway_bill_id " +
        "JOIN sales_invoice_lines l ON l.invoice_id = b.invoice_id AND l.line_no = i.line_no " +
        "WHERE i.cgst_rate_bps + i.sgst_rate_bps + i.igst_rate_bps <> COALESCE(l.tax_rate_bps, 0)",
      expect:
        "0 — and today it is 0 only because every rate in use happens to be even. " +
        "⚠️ NOTE THE JOIN: eway_bill_items has no invoice_line_id, only line_no, so " +
        "the item and the line it came from are related by POSITION. That is its own " +
        "fragility and it is why this assertion had to be written by reading the " +
        "schema rather than assuming the obvious foreign key exists.",
    },
  },
  {
    id: "goods-return-lines",
    table: "goods_return_lines",
    drizzleSymbol: "goodsReturnLines",
    file: "server/actions/goods-returns.ts",
    fn: "receiveGoodsReturn",
    anchor: "insert(goodsReturnLines)",
    status: "must-wire",
    taxSource:
      "🔴 taxable_value_minor, tax_rate_bps AND tax_value_minor all straight from " +
      "the client payload; tax_value_minor is never checked against taxable × rate",
    requiredCall:
      "at minimum, refuse a row where tax_value_minor <> gst_apply_rate_bps(taxable, rate)",
    note:
      "Only itc_reversal_minor is computed. The tax being reversed is not.",
    assertion: {
      sql:
        "SELECT count(*) FROM goods_return_lines " +
        "WHERE tax_value_minor <> gst_apply_rate_bps(taxable_value_minor, COALESCE(tax_rate_bps,0))",
      expect: "0. Uses 0147's arithmetic, so it agrees with every other document.",
    },
  },
  {
    id: "purchase-order-lines",
    table: "purchase_order_lines",
    drizzleSymbol: "purchaseOrderLines",
    file: "server/actions/purchase-orders.ts",
    fn: "raisePurchaseOrder",
    anchor: "tax += (lineValue * BigInt(l.taxRateBps)) / 10_000n",
    status: "must-wire",
    taxSource:
      "🔴 inline TRUNCATING division — a FIFTH implementation, and the only one that " +
      "is arithmetically WRONG rather than merely duplicated. applyRateBps is half-up " +
      "(+5000n before dividing); this one drops the fraction.",
    requiredCall: "applyRateBps from lib/billing/money.ts",
    note:
      "⚠️ A PURCHASE ORDER IS NOT A TAX DOCUMENT, so this understates by up to one " +
      "paisa per line and nobody files it. It matters because the PO's total is what " +
      "the three-way match compares the supplier's bill against, and a systematic " +
      "one-paisa-low expectation produces a match variance on correct invoices.",
    assertion: {
      sql:
        "SELECT count(*) FROM purchase_orders o WHERE o.tax_minor <> " +
        "(SELECT COALESCE(sum(gst_apply_rate_bps(" +
        "   (l.ordered_qty * l.unit_price_minor)::bigint, COALESCE(l.tax_rate_bps,0))),0) " +
        " FROM purchase_order_lines l WHERE l.po_id = o.id)",
      expect:
        "0 after the fix. Before it, the count is every PO whose lines produced a " +
        "fraction of a paisa.",
    },
  },
  {
    id: "post-supply-discount",
    table: "post_supply_discount_invoices",
    drizzleSymbol: "postSupplyDiscountInvoices",
    file: "server/actions/discounts.ts",
    fn: orphanName("compute", "Rebate"),
    anchor: orphanName("compute", "Rebate"),
    status: "unreachable",
    taxSource:
      "the rate is REVERSE-DERIVED from the stored header: " +
      "rateBps = (tax * 10000) / taxable",
    note:
      `🔴 UNREACHABLE — ${orphanName("compute", "Rebate")} is an orphan in the reachability baseline. ` +
      "Reverse-deriving a rate from a rounded total is lossy and would be worth " +
      "fixing if anything called it. Wire the caller first or delete the action.",
  },
  {
    id: "rate-cards",
    table: "rate_cards",
    drizzleSymbol: "rateCards",
    file: "server/actions/rates.ts",
    fn: "saveRateCard",
    anchor: "taxRateBps: data.taxRateBps",
    status: "master-data",
    taxSource: "the client payload, zod-range-checked and never compared to hsn_sac_rates",
    note:
      "⚠️ A PRICE LIST IS NOT A DOCUMENT, so it does not need the engine — but a rate " +
      "card carrying 12% for a classification the registry says is 18% will seed " +
      "every order made from it with the wrong rate, and 0147 will then happily " +
      "accept the resulting invoice because it is internally consistent. A soft " +
      "warning at save time, against the registry, is the cheap fix.",
  },

  /* ================================================================
   * 6. AGGREGATES
   * ============================================================== */
  {
    id: "order-totals-trigger",
    table: "sales_orders",
    drizzleSymbol: "salesOrders",
    file: "SQL-FILES/0028_phase39_orders.sql",
    fn: "ordence_recompute_order_totals()",
    anchor: "ordence_recompute_order_totals",
    status: "aggregate-only",
    taxSource: "SUM() over sales_order_lines",
    note:
      "⭐ A DATABASE TRIGGER IS A WRITE PATH AND BELONGS IN THIS REGISTER. It has the " +
      "last word on the order header, after the action has written it. It is correct " +
      "as an aggregate and it is the reason wiring only the order ACTION would " +
      "achieve nothing.",
  },
  {
    id: "gstr3b-return",
    table: "gst_returns",
    drizzleSymbol: "gstReturns",
    file: "server/actions/returns.ts",
    fn: "prepareGstr3b",
    anchor: "insert(gstReturns)",
    status: "aggregate-only",
    taxSource:
      "lib/gst/gstr3b.ts buildGstr3b over LEDGER movements, not over invoices",
    note:
      "Deliberately ledger-sourced, and it refuses to assemble if the tax accounts " +
      "are unmapped rather than reporting a confident zero. Nothing to wire.",
  },

  /* ================================================================
   * 7. NAMED IN THE BRIEF, CARRIES NO GST — the honest answers
   * ============================================================== */
  {
    id: "ra-bills",
    table: "ra_bills",
    drizzleSymbol: "raBills",
    file: "server/actions/ra-bills.ts",
    fn: "raiseRaBillFromMeasurements",
    anchor: "insert(raBills)",
    status: "no-tax-columns",
    taxSource: "none — there is no GST on this table to compute",
    note:
      "🔴 THE ANSWER TO 'WIRE RA BILLS' IS THAT AN RA BILL HAS NO GST ON IT.\n" +
      "The only rate columns are cess_rate_bps (BOCW labour welfare cess, 1%), " +
      "retention_rate_bps and tds_rate_bps. The compute trigger " +
      "ordence_compute_ra_bill() writes previous_paid, cess, retention, TDS and " +
      "net_payable, and net_payable = gross − cess − retention − tds − other. No GST " +
      "is added and none is deducted. lib/accounting/sales-posting.ts " +
      "buildRaBillPosting emits six ledger roles and not one of them is a tax role.\n" +
      "⚠️ THE DESIGN INTENT IS THAT THE CONTRACTOR'S GST LIVES ON A purchase_invoices " +
      "ROW — lib/construction/index.ts says so — and lib/construction/deductions.ts " +
      "computes 194C and s.51 GST-TDS on the value EXCLUSIVE of GST, which only makes " +
      "sense if the GST is captured elsewhere. But db/schema/purchases.ts has no " +
      "ra_bill_id, works_contract_id or boq_id column, and server/actions/ra-bills.ts " +
      "never creates or references a purchase invoice. So the two documents are " +
      "unlinked, keyed twice, and reconciled by eye. That is a schema gap, not a " +
      "wiring gap, and it is the honest answer to the brief's sixth bullet.",
  },
  {
    id: "ra-bill-lines",
    table: "ra_bill_lines",
    drizzleSymbol: "raBillLines",
    file: "server/actions/ra-bills.ts",
    fn: "raiseRaBillFromMeasurements",
    anchor: "insert(raBillLines)",
    status: "no-tax-columns",
    taxSource: "none — quantity, item rate and amount only",
  },
  {
    id: "works-contracts",
    table: "works_contracts",
    drizzleSymbol: "worksContracts",
    file: "scripts/seed-contracting-demo.ts",
    fn: "(seed only)",
    anchor: "INSERT INTO works_contracts",
    status: "no-tax-columns",
    taxSource: "none — cess, retention and TDS rates only",
    note:
      "🔴 AND IT HAS NO APPLICATION WRITER AT ALL. The only writes in the repo are " +
      "the seed script and a test. Every RA bill reads a contract that no screen can " +
      "create.",
  },
  {
    id: "boqs",
    table: "boqs",
    drizzleSymbol: "boqs",
    file: "server/actions/construction.ts",
    fn: "createBoq",
    anchor: "export async function createBoq",
    status: "must-wire",
    taxSource:
      "🔴 nothing reads or writes it. boqs.gst_rate_bps DEFAULT 1800 and " +
      "boqs.gst_tds_rate_bps DEFAULT 200 are live columns that createBoq never sets " +
      "and no code anywhere reads",
    requiredCall:
      "resolve the rate from hsn_sac_rates for the works-contract SAC on the " +
      "contract date, or drop the columns",
    note:
      "⚠️ THE DANGEROUS SHAPE. A column with a plausible default that nobody writes " +
      "and nobody reads looks configured. Every BOQ in the database says 18% and no " +
      "part of that came from a decision.",
  },
  /* ================================================================
   * 8. WRITE A TAX-BEARING TABLE AND TOUCH NO TAX COLUMN
   *
   * ⚠️ EVERY ONE OF THESE WAS FOUND BY `tests/security/tax-call-sites.test.ts`
   * §2 FAILING ON THE FIRST DRAFT OF THIS REGISTER, not by reading. That
   * is the whole argument for the test: the register was written from an
   * exhaustive audit, by someone who had just done the audit, and it was
   * still twelve writers short. A list maintained from memory is a list
   * that is right on the day it is written.
   * ============================================================== */
  {
    id: "invoice-payment-recorded",
    table: "invoices",
    drizzleSymbol: "invoices",
    file: "server/actions/billing.ts",
    fn: orphanName("recordManual", "Payment"),
    anchor: "update(invoices)",
    status: "non-tax-write",
    taxSource: "none — amount_paid_minor, status, paid_at",
    note: "Also unreachable: an orphan in the reachability baseline.",
  },
  {
    id: "invoice-voided",
    table: "invoices",
    drizzleSymbol: "invoices",
    file: "server/actions/invoicing.ts",
    fn: orphanName("void", "Invoice"),
    anchor: "update(invoices)",
    status: "non-tax-write",
    taxSource: "none — status, voided_at, notes",
    note: "Also unreachable: an orphan in the reachability baseline.",
  },
  {
    id: "eway-number-writeback",
    table: "sales_invoices",
    drizzleSymbol: "salesInvoices",
    file: "server/actions/eway.ts",
    fn: "recordEwayNumber / cancelEwayBill",
    anchor: "update(salesInvoices)",
    status: "non-tax-write",
    taxSource: "none — eway_bill_no and eway_bill_date only",
    note:
      "⭐ THE ONE MOST LIKELY TO BE MIS-WIRED. It writes sales_invoices, so a scan " +
      "for 'where are sales invoices written' surfaces it, and 0049's freeze trigger " +
      "explicitly permits these two columns to move after issue — which reads like " +
      "permission to write more. It is not.",
  },
  {
    id: "opening-balance-import",
    table: "sales_invoices",
    drizzleSymbol: "salesInvoices",
    file: "server/actions/import.ts",
    fn: "writeRow (entity sales_invoices)",
    anchor: "insert(salesInvoices)",
    status: "non-tax-write",
    taxSource:
      "deliberately none — taxable_value_minor is written as 0n and every head is " +
      "left at 0, because an opening balance is a receivable carried forward, not a " +
      "supply. No lines are inserted at all.",
    note:
      "⚠️ DO NOT WIRE THIS, AND THE REASON IS SUBTLE. These rows are the closing " +
      "balances of a system the customer is migrating FROM. The supply already " +
      "happened, was already taxed, and was already filed under the old system. " +
      "Computing GST on them would double-count every one of them in GSTR-1.",
  },
  {
    id: "three-way-match",
    table: "purchase_invoices",
    drizzleSymbol: "purchaseInvoices",
    file: "server/actions/purchase-orders.ts",
    fn: "runThreeWayMatch",
    anchor: "update(purchaseInvoices)",
    status: "non-tax-write",
    taxSource: "none — match_state and match_note",
  },
  {
    id: "booking-possession",
    table: "bookings",
    drizzleSymbol: "bookings",
    file: "server/actions/sales-posting.ts",
    fn: "recordPossession",
    anchor: "update(bookings)",
    status: "non-tax-write",
    taxSource: "none — possession and posting references",
  },
  {
    id: "fx-initial-recognition-sales",
    table: "sales_invoices",
    drizzleSymbol: "salesInvoices",
    file: "server/fx/initial-recognition.ts",
    fn: "recogniseSalesInvoice",
    anchor: "update(salesInvoices)",
    status: "non-tax-write",
    taxSource: "none — functional currency, functional total and the FX rate",
    note:
      "⚠️ AND IT MUST STAY THAT WAY. GST is charged and filed in INR whatever the " +
      "invoice currency; an FX revaluation that moved a tax head would restate a " +
      "filed return every time the rupee moved.",
  },
  {
    id: "fx-initial-recognition-purchase",
    table: "purchase_invoices",
    drizzleSymbol: "purchaseInvoices",
    file: "server/fx/initial-recognition.ts",
    fn: "recognisePurchaseInvoice",
    anchor: "update(purchaseInvoices)",
    status: "non-tax-write",
    taxSource: "none — FX columns only",
  },
  {
    id: "fx-revaluation-sales",
    table: "sales_invoices",
    drizzleSymbol: "salesInvoices",
    file: "server/fx/revaluation-service.ts",
    fn: "runRevaluation / settleForeignSalesInvoice",
    anchor: "update(salesInvoices)",
    status: "non-tax-write",
    taxSource: "none — fx_carried_functional_minor",
  },
  {
    id: "fx-revaluation-purchase",
    table: "purchase_invoices",
    drizzleSymbol: "purchaseInvoices",
    file: "server/fx/revaluation-service.ts",
    fn: "runRevaluation / settleForeignPurchaseInvoice",
    anchor: "update(purchaseInvoices)",
    status: "non-tax-write",
    taxSource: "none — fx_carried_functional_minor",
  },
  {
    id: "demand-dunning",
    table: "demand_notices",
    drizzleSymbol: "demandNotices",
    file: "server/receivables/dunning.ts",
    fn: "sendDunningLetter",
    anchor: "update(demandNotices)",
    status: "non-tax-write",
    taxSource: "none — dunning_stage and last_dunned_at",
  },
  {
    id: "demand-receipts",
    table: "demand_notices",
    drizzleSymbol: "demandNotices",
    file: "server/receivables/receipts.ts",
    fn: "recordReceipt / bounceReceipt / reallocateReceipt",
    anchor: "update(demandNotices)",
    status: "non-tax-write",
    taxSource: "none — allocated_minor, interest_paid_minor, status",
  },
];

/** Every table this register claims to cover. The test checks the schema against it. */
export const REGISTERED_TAX_TABLES: ReadonlySet<string> = new Set(
  TAX_CALL_SITES.map((s) => s.table),
);

/** The Wiring track's queue, in the order given. */
export function sitesToWire(): readonly CallSite[] {
  return TAX_CALL_SITES.filter(
    (s) => s.status === "must-wire" || s.status === "computes-but-unpinned",
  );
}

/**
 * ⚠️ EXPLICITLY NOT TO BE WIRED. Exported so that a future reader who
 * notices "this one wasn't done" finds the reason rather than the gap.
 */
export function sitesThatMustNotBeWired(): readonly CallSite[] {
  return TAX_CALL_SITES.filter((s) => s.status === "third-party-figures");
}
