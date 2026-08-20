/**
 * Ordence — ⭐⭐ SALES ENTITIES FOR THE MIGRATION IMPORTER
 * Version: v1.85.0-alpha · Phase 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS IN THIS FILE, AND WHAT IS DELIBERATELY NOT
 * ══════════════════════════════════════════════════════════════════════
 * Phase 5 was briefed to deliver four entities: `customers`,
 * `sales-invoices`, `credit-notes` and `receipts`. Two of them are here.
 * The other two are refused, by name, further down this file, because
 * step 1 of the brief says so: *"Find the existing validator. If there is
 * no schema for this thing, the entity is not ready and you should say so
 * in your report rather than writing one."*
 *
 * There is no schema for a historical sales invoice and there is no
 * schema for a historical credit note. The refusal is written out in
 * `THE TWO ENTITIES THIS FILE DOES NOT DEFINE`, at the foot, with the
 * evidence, so that the gap reads as a decision rather than as an
 * oversight — and `PATCH-REQUEST-PHASE-5.md` says what would have to
 * exist, and who owns it, before it can be reversed.
 *
 * ⚠️ THIS FILE IS NOT A REGISTRY. It exports one map. The single
 * allowlist on the write path is `ALL_IMPORT_ENTITIES` in
 * `lib/import/entities.ts`, and `isImportEntityKey` is membership in
 * that one map. Five phases each adding one line to that file is five
 * clean merges; five phases each rewriting it is five conflicts — so the
 * spread is requested in `PATCH-REQUEST-PHASE-5.md` and applied by
 * integration.
 *
 * ⚠️ PURE. No database import, no clock, no `crypto`. Same rule as the
 * rest of `lib/import/`: the entity names a table with a string
 * discriminant, which is what lets the client wizard build a blank
 * template from this file without dragging Postgres into the browser
 * bundle.
 */

import { z } from "zod";
import { upsertPartySchema } from "@/lib/validators/gst";
import { recordReceiptSchema } from "@/lib/validators/sales-invoices";
import type { ContractedImportEntity, ImportLookup } from "./types";

/** Text from a parsed payload, or "". */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Case- and whitespace-insensitive folding.
 *
 * ⚠️ IT MUST MATCH WHAT THE SQL SIDE DOES, which is
 * `lower(regexp_replace(name, '\s+', ' ', 'g'))`. The composite natural
 * key is built here and compared against a key built in the writer from
 * that expression; two spellings of "the same" normalisation is two
 * things that agree until somebody changes one.
 */
function fold(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, " ");
}

/* ================================================================== */
/* 1 — CUSTOMERS                                                       */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DECISION PHASE 5 AND PHASE 6 HAD TO MAKE TOGETHER
 * ══════════════════════════════════════════════════════════════════════
 * `customers` (Phase 5) and `vendors` (Phase 6) write the SAME TABLE,
 * `gst_parties`, and the existing `gst-parties` entity already covers
 * both. Three answers were available:
 *
 *   ① Two new entities, each keyed on the GSTIN.        REFUSED.
 *   ② No new entities; keep `gst-parties` as the only way in.
 *   ③ Two new entities that are the SAME schema, the SAME destination
 *      and the SAME key SHAPE, differing only in that `partyType` is
 *      FIXED by the entity instead of being a column.   ⭐ CHOSEN.
 *
 * ① is refused because `db/schema/gst.ts` says the same firm can be a
 * customer and a vendor at once — a builder buys cement from a company it
 * also sells a shop to — which is why the database's unique index is
 * `(tenant_id, party_type, gstin) WHERE gstin IS NOT NULL AND is_active`
 * and not the GSTIN alone. Keying on the GSTIN alone would make the
 * vendor row and the customer row look like duplicates of each other, and
 * under `update` the second import would overwrite one with the other.
 *
 * ② is defensible and was rejected on one ground: a migrating customer
 * arrives with a CUSTOMER LIST and a VENDOR LIST, two files, produced by
 * two different people, and neither has a "customer or vendor" column in
 * it. Telling them to add one to each file is asking them to type a
 * constant ten thousand times, and the row where they mistype it is a
 * vendor in the customer master.
 *
 * ③ keeps the safety of ① impossible to lose: `partyType` is injected by
 * `buildPayload` and is not a column at all, so a customers file CANNOT
 * create a vendor row, whatever is in it. The natural key stays
 * `(party_type, gstin)` — the database's own index — and Phase 6's
 * `vendors` is the mirror image with `"vendor"` in the same place. Two
 * entities, one destination, one writer, no collision by construction.
 *
 * ⚠️ THE WRITER IS PHASE 1's EXISTING `gstPartiesWriter` AND NOT A NEW
 * ONE. `table` is `gst_parties`, which is already in `ImportTableKey`
 * and already in `IMPORT_WRITERS`, so this entity adds no destination and
 * needs no registry change. Its natural keys are built in exactly the
 * shape that writer's `findExisting` already reads (`gstin` and
 * `legalName`, values `partyType|value`) — verified against
 * `server/import/writers/gst-parties.ts`.
 */
const customersEntity: ContractedImportEntity = {
  key: "customers",
  /** ⭐ WAVE 2C. No money column on this entity. */
  money: { source: "none" },
  label: "Customers",
  noun: { one: "customer", many: "customers" },
  description:
    "The people you invoice, and the GSTIN each is billed under. Their registration " +
    "is what decides CGST + SGST against IGST on every invoice you raise, so this " +
    "file goes in before anything that quotes it.",
  table: "gst_parties",
  feature: "gst.registry",
  createPermission: "gst:manage_parties",
  updatePermission: "gst:manage_parties",

  /**
   * ⚠️ THE COLUMNS ARE `gst-parties`' COLUMNS MINUS `partyType`, and that
   * subtraction is the entity. Everything else is deliberately identical,
   * including the aliases, because the two files come out of the same
   * exports and a customer who mapped one should recognise the other.
   */
  columns: [
    {
      field: "legalName",
      header: "Legal name",
      kind: "text",
      required: true,
      maxLength: 255,
      aliases: ["name", "customer", "party", "legalname", "registeredname", "companyname", "account"],
      help: "The name as registered. Rule 46(e) requires this exact name on the invoice.",
    },
    {
      field: "tradeName",
      header: "Trade name",
      kind: "text",
      required: false,
      maxLength: 255,
      aliases: ["tradingname", "tradename", "brand", "dba"],
      help: "What they are known as, if different.",
    },
    {
      field: "gstin",
      header: "GSTIN",
      kind: "text",
      required: false,
      maxLength: 15,
      aliases: ["gst", "gstno", "gstnumber", "gstinnumber", "taxid"],
      help:
        "Fifteen characters. Leave blank for an unregistered or overseas customer — " +
        "and then the registration type must say so.",
    },
    {
      field: "registrationType",
      header: "Registration type",
      kind: "enum",
      required: true,
      enumValues: ["regular", "composition", "unregistered", "sez", "overseas"],
      aliases: ["registration", "gsttype", "registrationtype", "taxpayertype"],
      help:
        "regular, composition, unregistered, sez or overseas. Must agree with " +
        "whether a GSTIN is present.",
    },
    {
      field: "panNumber",
      header: "PAN",
      kind: "text",
      required: false,
      maxLength: 10,
      aliases: ["pan", "pannumber", "pancard"],
      help: "Ten characters, e.g. AAAAA0000A.",
    },
    {
      field: "stateCode",
      header: "State code",
      kind: "text",
      required: false,
      maxLength: 2,
      aliases: ["state", "gststate", "statecode", "posstate"],
      help:
        "Two digits, e.g. 27 for Maharashtra — not the state's name. Leave blank " +
        "where there is a GSTIN and it is taken from the GSTIN's first two digits.",
    },
    {
      field: "effectiveFrom",
      header: "Effective from",
      kind: "date",
      required: true,
      aliases: ["from", "validfrom", "effectivefrom", "startdate", "since"],
      help:
        "YYYY-MM-DD. The day this tax identity became true. If you do not know, " +
        "use the date you started dealing with them.",
    },
    {
      field: "effectiveTo",
      header: "Effective to",
      kind: "date",
      required: false,
      aliases: ["to", "validto", "effectiveto", "enddate", "until"],
      help: "YYYY-MM-DD, or blank while it is still current.",
    },
    {
      field: "addressLine1",
      header: "Address line 1",
      kind: "text",
      required: false,
      maxLength: 255,
      aliases: ["address", "addressline1", "street"],
      help: "",
    },
    {
      field: "addressLine2",
      header: "Address line 2",
      kind: "text",
      required: false,
      maxLength: 255,
      aliases: ["addressline2"],
      help: "",
    },
    {
      field: "city",
      header: "City",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["town"],
      help: "",
    },
    {
      field: "state",
      header: "State name",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["statename", "province"],
      help: "The state's name for the printed address. The CODE is the column above.",
    },
    {
      field: "postalCode",
      header: "PIN code",
      kind: "text",
      required: false,
      maxLength: 20,
      aliases: ["pin", "pincode", "postalcode", "zip"],
      help: "",
    },
    {
      field: "country",
      header: "Country",
      kind: "text",
      required: false,
      maxLength: 60,
      aliases: ["countryname"],
      help: "",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 2000,
      aliases: ["comments", "remarks"],
      help: "",
    },
  ],

  /**
   * ⚠️ `partyType` IS INJECTED HERE AND IS NOT A COLUMN. That is the
   * whole safety property of this entity: a customers file cannot create
   * a vendor row, so it cannot collide with Phase 6's `vendors` under any
   * contents, mapping or duplicate mode.
   *
   * ⚠️ AND THE ADDRESS IS OMITTED ENTIRELY WHEN EVERY PART IS BLANK,
   * rather than sent as `{}` — copied deliberately from `gst-parties`,
   * where the reasoning is set out at length: on an update, `{}` would
   * overwrite an address already on the record with nothing, so importing
   * a file that simply has no address columns would ERASE addresses.
   */
  buildPayload: (values) => {
    const address: Record<string, string> = {};
    const put = (key: string, field: string) => {
      const v = values[field];
      if (typeof v === "string" && v.trim() !== "") address[key] = v;
    };
    put("line1", "addressLine1");
    put("line2", "addressLine2");
    put("city", "city");
    put("state", "state");
    put("postalCode", "postalCode");
    put("country", "country");

    return {
      partyType: "customer",
      legalName: values.legalName,
      tradeName: values.tradeName,
      gstin: values.gstin,
      panNumber: values.panNumber,
      registrationType: values.registrationType,
      stateCode: values.stateCode,
      effectiveFrom: values.effectiveFrom,
      effectiveTo: values.effectiveTo,
      notes: values.notes,
      ...(Object.keys(address).length > 0 ? { address } : {}),
    };
  },

  /**
   * 🔴 THE SAME OBJECT `saveParty` PARSES. Not a copy, not an import
   * variant. Its `.superRefine()` carries the three rules no amount of
   * column mapping reproduces: a `regular` or `composition` party must
   * have a GSTIN, an `unregistered` or `overseas` one must not, and a
   * state code where given must equal the GSTIN's first two digits —
   * because a GSTIN's prefix IS its state and a mismatch moves the
   * invoice between tax heads. `server/actions/gst.ts` names "an import
   * of historical bookings" as one of the four write paths that must not
   * bypass these; this is that import and it goes through the front door.
   */
  schema: upsertPartySchema,

  /**
   * ⚠️ THE KEY SHAPE IS `gst-parties`' KEY SHAPE, VALUE AND ALL, because
   * it is read by `gst-parties`' writer. `partyType` is in the value
   * rather than assumed, so the composite this entity produces is
   * literally the composite that writer's `findExisting` reconstructs
   * from the database — and a customer row can never match a vendor row.
   *
   * ⚠️ THE GSTIN IS UPPER-CASED BY THE SCHEMA before it reaches here, so
   * this compares what the database will actually store. Lower-casing it
   * would be wrong: the schema has already settled which spelling wins.
   *
   * ⚠️ THE UNREGISTERED FALLBACK IS THE LEGAL NAME AND IT IS WEAK, AND
   * SAYING SO IS THE POINT. An unregistered customer has no identifier —
   * that is what unregistered means — so the name is all there is, and
   * two different one-off customers with the same name look like one.
   * `skip` is recommended below precisely because it makes that weakness
   * harmless.
   */
  naturalKey: (parsed) => {
    const gstin = text(parsed.gstin);
    if (gstin !== "") {
      return {
        kind: "gstin",
        value: `customer|${gstin}`,
        label: `GSTIN ${gstin} as a customer`,
      };
    }
    const legalName = text(parsed.legalName);
    if (legalName === "") return null;
    return {
      kind: "legalName",
      value: `customer|${fold(legalName)}`,
      label: `name "${legalName}" as a customer`,
    };
  },

  rowLabel: (parsed) => (text(parsed.legalName) !== "" ? text(parsed.legalName) : "(no name)"),

  duplicateRule:
    "Two rows are the same customer when they carry the same GSTIN. A customer with " +
    "no GSTIN is matched on their name alone, which is a weaker match.",

  contract: {
    /**
     * ⚠️ NOTHING. Not even a soft edge to `companies`.
     *
     * A `gst_parties` row is a tax identity and carries no foreign key to
     * `companies` — `db/schema/gst.ts` has no such column — so a customer
     * list loads correctly into an empty workspace. Declaring a soft
     * dependency "because you probably want your CRM first" would be
     * advice dressed as a constraint, and the planner's screen would then
     * be full of sentences that are not about this file.
     *
     * 🔴 THE ENTITIES THAT DEPEND ON THIS ONE ARE THE ONES THAT SAY SO.
     * `receipts` below declares a hard edge to `customers`, which is what
     * puts this file first in the wave order.
     */
    dependsOn: [],
    /**
     * 🔴 `restore-prior`, FOR THE SAME REASON `gst-parties` IS, WITH THE
     * SAME SHARPNESS. This entity offers `update`, so a run can rewrite a
     * registration that pre-dates the migration. Deleting one on undo
     * would leave invoices pointing at a party that no longer exists, in
     * a system of record an assessing officer may later read.
     */
    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      escapes:
        "A customer overwritten in `update` mode may already have been quoted on invoices raised between the import and the undo. Restoring their prior values does not restate those invoices, which captured their GST details at issue and are deliberately immutable.",
      because:
        "`update` is offered, so a run can overwrite a tax identity that existed before the migration and carried history the import knows nothing about. The prior values are captured at write time because by undo time they are gone.",
    },
    /**
     * One row in, one row out, into the one table this entity names.
     * `gst_parties` is already in `ImportTableKey`, so this adds no
     * destination and no writer.
     */
    provenance: { targets: ["gst_parties"], cardinality: "one-to-one" },
    /**
     * ⚠️ EMPTY, AND DELIBERATELY.
     *
     * `requiredness.structural` is the third question — "without this
     * value the ROW IS NOT A THING" — and it is not a place to restate
     * the schema. Every absence that makes a customer not a customer is
     * already refused by `upsertPartySchema`, with its own sentence:
     * `legalName` is required, `registrationType` is required, and the
     * GSTIN rule is a `superRefine`. A second copy here would be a second
     * rule to keep in step, and the two copies would disagree the first
     * time the schema changed.
     */
    requiredness: { structural: [], messages: {} },
    duplicateDecision: {
      recommended: "skip",
      because:
        "Most second uploads are the whole file again after fixing a few rows, and `skip` makes that safe. The match for a customer with NO GSTIN is their name alone, which is weak — two different one-off customers with the same name look like one party — and `skip` makes that weakness harmless where `update` would let it overwrite the wrong record.",
    },
  },
};

/* ================================================================== */
/* 2 — RECEIPTS                                                        */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DOUBLE-COUNT DECISION, WHICH IS THE ONE THAT COSTS MONEY
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/opening-entities.ts` already settles this for the product,
 * and this entity follows that ruling rather than inventing a second one:
 *
 *   "⭐ SO EXACTLY ONE OF THEM POSTS, AND IT IS THE TRIAL BALANCE."
 *
 * A receipt banked before the cutover is ALREADY inside two figures the
 * opening trial balance carries: the bank balance it increased and the
 * debtors balance it reduced. Posting it again on import would add it a
 * second time — and the balance sheet would still balance, because the
 * contra doubles too, so nothing anywhere would report an error.
 *
 * ⚠️ SO AN IMPORTED RECEIPT POSTS NOTHING TO THE GENERAL LEDGER. It is
 * sub-ledger detail, exactly as an opening customer invoice is: it exists
 * so the customer's account history, statement of account and TDS credits
 * are there on day one. `server/import/writers/sales/customer-receipts.ts`
 * carries the same note at the line where it does NOT call
 * `postCustomerReceipt`, because that is where somebody will one day
 * wonder why the call is missing.
 *
 * ⚠️ THE ALTERNATIVE — "post, unless an opening trial balance exists" —
 * WAS REJECTED. It makes the customer's books depend on the ORDER they
 * uploaded their files in: receipts first and they post, trial balance
 * first and they do not. Same data, two different sets of books, and
 * nothing on screen to say which one they got.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THIS FILE IS FOR, IN THE CUSTOMER'S WORDS
 * ══════════════════════════════════════════════════════════════════════
 * Money you have received and NOT yet applied to an invoice: advances,
 * on-account payments, the cheque that arrived the week you switched
 * over. That is the only receipt worth importing, and the reason is
 * arithmetic rather than taste — `openingCustomerInvoiceSchema` refuses
 * an invoice with nothing outstanding and takes `outstandingMinor` NET of
 * what has been paid, so every receipt that HAS been applied to a
 * pre-cutover invoice is already reflected in the opening invoice list.
 * Importing it as well would show the customer money twice.
 *
 * 🔴 THEREFORE THIS ENTITY WRITES NO ALLOCATIONS. It creates the receipt
 * and stops. See `TRACK-REPORT.md §4` for the three consequences of that,
 * including the one that argues against it.
 */
const receiptsEntity: ContractedImportEntity = {
  key: "receipts",
  /**
   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
   * currency; there is no currency column. The exponent follows from
   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
   */
  money: { source: "workspace" },
  label: "Customer receipts",
  noun: { one: "receipt", many: "receipts" },
  description:
    "Money received from customers that has not been applied to an invoice — advances " +
    "and payments on account. These are recorded against the customer's account and " +
    "do NOT move your bank balance, because your opening trial balance already " +
    "includes them.",
  table: "customer_receipts",

  /**
   * ⚠️ THE FEATURE AND THE PERMISSIONS ARE THE ONES THE SINGLE-RECORD
   * ACTION ALREADY USES — `server/actions/sales-invoices.ts` guards
   * `recordCustomerReceipt` with `sales.orders` and
   * `sales.receipts.record`. A new key would be a second answer to a
   * question the permission table already answers, and the person who
   * should be allowed to do this in bulk is exactly the person allowed to
   * do it one at a time.
   */
  feature: "sales.orders",
  createPermission: "sales.receipts.record",
  /**
   * ⚠️ UNREACHABLE BY CONSTRUCTION — `duplicateModes` below excludes
   * `update`, and the guard asks for this only in `update` mode. It is
   * still the honest value: amending a receipt somebody has reconciled
   * against is the allocation permission's business, not the recording
   * one's.
   */
  updatePermission: "sales.receipts.allocate",

  columns: [
    {
      field: "customerName",
      header: "Customer",
      kind: "text",
      required: true,
      maxLength: 255,
      aliases: ["company", "party", "account", "customername", "receivedfrom", "payer"],
      help:
        "The customer's name exactly as their company record is named in Ordence. " +
        "Load your customer and company lists first — a name that does not match " +
        "one is reported before anything is written, not after.",
    },
    {
      field: "receivedOn",
      header: "Received on",
      kind: "date",
      required: true,
      aliases: ["date", "receiptdate", "paymentdate", "receivedon", "valuedate"],
      help:
        "YYYY-MM-DD. The day the money arrived, not the day you are importing — " +
        "it is what a statement of account shows against the payment.",
    },
    {
      field: "amountMinor",
      header: "Amount",
      kind: "money",
      required: true,
      aliases: ["amount", "value", "paid", "receiptamount", "amountreceived"],
      help: "In rupees, e.g. 12500.50. What actually reached the bank.",
    },
    {
      /**
       * ⭐ TAX THE CUSTOMER WITHHELD, and it settles the account as surely
       * as cash — `recordReceiptSchema` makes the same argument at
       * length. A customer who deducts TDS has paid that money, to the
       * Government, on our behalf. A migration that drops the column
       * leaves every such customer permanently short on their account and
       * starts a dunning ladder against somebody who paid in full.
       */
      field: "tdsCreditMinor",
      header: "TDS deducted",
      kind: "money",
      required: false,
      aliases: ["tds", "tdsamount", "taxdeducted", "withholding", "tdscredit"],
      help:
        "In rupees. Tax your customer withheld under Section 194-Q and its neighbours. " +
        "Leave blank where none was deducted.",
    },
    {
      field: "method",
      header: "Method",
      kind: "enum",
      required: true,
      enumValues: ["cash", "cheque", "neft", "rtgs", "imps", "upi", "card", "adjustment"],
      aliases: ["mode", "paymentmethod", "paymentmode", "instrument", "type"],
      help: "One of: cash, cheque, neft, rtgs, imps, upi, card, adjustment.",
    },
    {
      /**
       * 🔴 THIS COLUMN IS THE NATURAL KEY WHEN IT IS PRESENT, and the
       * `help` says so, because a customer who leaves it blank is
       * choosing a weaker re-run guarantee and is entitled to know that
       * while the file is still in front of them.
       */
      field: "instrumentRef",
      header: "Reference",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["reference", "utr", "chequeno", "chequenumber", "transactionid", "instrumentref", "refno"],
      help:
        "The UTR, cheque number or transaction id. Where you give one, this is what a " +
        "re-import matches on — two rows with the same reference are the same payment.",
    },
    {
      field: "bankRef",
      header: "Bank reference",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["bankref", "statementref", "bankreference"],
      help: "Your own bank's reference for the credit, if you have it.",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 2000,
      aliases: ["comments", "remarks", "narration", "description"],
      help: "Free text. What the payment was said to be for.",
    },
  ],

  /**
   * ⚠️ `companyId` IS ABSENT HERE AND THAT IS NOT AN OMISSION.
   *
   *
   * The customer is named, not identified — a migration file cannot carry
   * an Ordence uuid, because the workspace it is being loaded into did not
   * exist when the file was exported. The uuid arrives from the LOOKUP
   * below, which the framework resolves once for the whole file, in the
   * PREVIEW, before anything is written. See `schema` for how the form's
   * own rule about `companyId` is still enforced.
   */
  buildPayload: (values) => ({
    customerName: values.customerName,
    receivedOn: values.receivedOn,
    amountMinor: values.amountMinor,
    ...(values.tdsCreditMinor === undefined || values.tdsCreditMinor === null
      ? {}
      : { tdsCreditMinor: values.tdsCreditMinor }),
    method: values.method,
    ...(values.instrumentRef === undefined || values.instrumentRef === null
      ? {}
      : { instrumentRef: values.instrumentRef }),
    ...(values.bankRef === undefined || values.bankRef === null
      ? {}
      : { bankRef: values.bankRef }),
    ...(values.notes === undefined || values.notes === null ? {} : { notes: values.notes }),
  }),

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE FORM'S OWN SCHEMA, MINUS THE ONE FIELD THE FILE CANNOT CARRY
   * ══════════════════════════════════════════════════════════════════
   * `recordReceiptSchema` is the object `recordCustomerReceipt` parses.
   * Every rule in it applies here unchanged: the amount is whole paise as
   * digits, the date is a civil day, the method is the closed list the
   * database's own enum holds, the TDS credit is a non-negative amount.
   *
   * ⚠️ `.omit({ companyId: true })` IS NOT A LOOSER SCHEMA AND MUST NOT
   *    BECOME ONE. It removes exactly one field — a uuid that identifies
   *    a row in THIS workspace, which no exported file can contain — and
   *    the importer supplies it itself from the lookup. It is the same
   *    object, not a copy: a rule added to `recordReceiptSchema` tomorrow
   *    is in force here the moment it lands, which is the entire property
   *    rule 6 exists to protect.
   *
   * 🔴 AND THE FULL SCHEMA, `companyId` INCLUDED, IS RE-IMPOSED AT THE
   *    WRITE, once the lookup has supplied the uuid — see
   *    `server/import/writers/sales/customer-receipts.ts`, which parses
   *    `recordReceiptSchema` (not the omitted one) before it inserts.
   *    So no row reaches `customer_receipts` that the form would have
   *    refused; the schema is simply applied in two steps because the
   *    identity is resolved between them.
   */
  schema: recordReceiptSchema.omit({ companyId: true }).extend({
    /**
     * ⚠️ THE FIELD THAT REPLACES `companyId`, AND IT HAS TO BE IN THE
     * SCHEMA RATHER THAN MERELY IN `buildPayload`.
     *
     * `z.object()` STRIPS unknown keys. A `customerName` that the schema
     * does not declare is silently dropped from the parsed payload — and
     * `naturalKey` and `lookups` both run on the PARSED payload, so the
     * key would be null and the lookup empty for every row in the file.
     * Every receipt would import with no customer and no duplicate
     * protection, reporting success. Verified by executing the planner
     * against a file without it: `tests/ui/import-sales-entities.test.ts`
     * keeps that proof.
     *
     * ⚠️ THE `.min(1)` MESSAGE IS THE ONE THE CUSTOMER READS in the
     * failed-rows CSV, so it says what to do rather than what is wrong.
     */
    customerName: z
      .string({
        required_error: "Name the customer exactly as their company record is named in Ordence.",
        invalid_type_error: "Name the customer exactly as their company record is named in Ordence.",
      })
      .trim()
      .min(1, "Name the customer exactly as their company record is named in Ordence.")
      .max(255),
  }),

  /**
   * ⭐ THE CUSTOMER IS RESOLVED IN THE PREVIEW, NEVER AT THE WRITE.
   *
   * `company_by_name` is the same lookup kind the opening customer
   * invoices use, resolved by one query for the whole file in
   * `server/actions/import.ts`. A name that matches nothing becomes an
   * ordinary reported error with the sentence below, in the dry run,
   * where the customer can still fix the file — rather than a foreign-key
   * violation at 3am on cutover night.
   */
  lookups: (parsed): readonly ImportLookup[] => {
    const name = text(parsed.customerName);
    if (name === "") return [];
    return [
      {
        kind: "company_by_name",
        value: fold(name),
        into: "companyId",
        missing:
          `No customer named "${name}" is in this workspace. Load your customer list first, ` +
          `or correct the spelling here — the name has to match the company record exactly ` +
          `(capitals and extra spaces do not matter).`,
      },
    ];
  },

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE KEY IS THE CUSTOMER'S OWN PAYMENT REFERENCE, AND THE FALLBACK
   *    IS WEAK AND SAYS SO
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ IT CANNOT BE THE RECEIPT NUMBER. `customer_receipts.receipt_number`
   * is ASSIGNED BY ORDENCE, not supplied — `recordCustomerReceipt`
   * derives it and `recordReceiptSchema` has no field for it. There is
   * nothing in an imported file that will ever equal it, so keying on it
   * would mean every re-run duplicates every row.
   *
   * ⭐ SO THE KEY IS `(customer, reference)` WHERE A REFERENCE IS GIVEN.
   * A UTR identifies a payment; a cheque number identifies one within a
   * bank account. Two rows quoting the same reference for the same
   * customer are the same money, and a re-upload of the whole file
   * matches them.
   *
   * ⚠️ AND WHERE THERE IS NO REFERENCE — cash over the counter — the key
   * is `(customer, date, amount, method)` and IT IS GENUINELY WEAK: a
   * customer who pays ₹5,000 in cash twice on the same day has two
   * receipts that this cannot tell apart, and the second will be reported
   * as a duplicate and skipped. That is the wrong answer in that case,
   * and it is the better of the two available wrong answers — the
   * alternative is that every cash receipt duplicates on every re-run,
   * silently, into the customer's account history.
   *
   * ⚠️ THE FOLD IS ON THE CUSTOMER'S NAME AND NOT ON `companyId`, because
   * the natural key is computed by the PURE layer, before the lookup has
   * resolved. The writer rebuilds the same composite from the database
   * with `lower(regexp_replace(name, '\s+', ' ', 'g'))`, which is what
   * `fold` above reproduces exactly.
   */
  naturalKey: (parsed) => {
    const customer = fold(parsed.customerName);
    if (customer === "") return null;
    const reference = text(parsed.instrumentRef);
    if (reference !== "") {
      return {
        kind: "reference",
        value: `${customer}|${reference.toUpperCase()}`,
        label: `reference ${reference} from ${text(parsed.customerName)}`,
      };
    }
    const receivedOn = text(parsed.receivedOn);
    const amount = text(parsed.amountMinor);
    const method = text(parsed.method);
    if (receivedOn === "" || amount === "" || method === "") return null;
    return {
      kind: "unreferenced",
      value: `${customer}|${receivedOn}|${amount}|${method}`,
      label: `a ${method} receipt from ${text(parsed.customerName)} on ${receivedOn} (no reference given, so this is a weak match)`,
    };
  },

  rowLabel: (parsed) => {
    const customer = text(parsed.customerName);
    const reference = text(parsed.instrumentRef);
    if (customer === "") return "(no customer)";
    return reference === "" ? customer : `${customer} — ${reference}`;
  },

  /**
   * 🔴 NO `update`, AND THAT IS A DECISION ABOUT MONEY RATHER THAN A
   *    CONVENIENCE.
   *
   * A receipt is a record that money arrived. Overwriting one in bulk
   * rewrites the amount, the date or the method under an allocation
   * somebody has already made against it and a statement the customer has
   * already been sent. The single-record product has no "edit receipt"
   * either: a receipt that did not arrive is BOUNCED, which keeps the row
   * and releases its allocations, because the interest clock never
   * stopped. An importer offering `update` would be offering an operation
   * the product itself refuses to perform.
   *
   * ⚠️ AND EXCLUDING IT IS WHAT MAKES `reversal: delete` HONEST BELOW.
   * Gate 29 refuses `update` with `delete` by name, and rightly: in
   * `update` mode an undo would delete records that pre-date the run.
   * With `update` gone, every row this entity writes is a row it created.
   */
  duplicateModes: ["skip", "fail"],

  duplicateRule:
    "Two rows are the same receipt when they are from the same customer and quote the " +
    "same reference. Where no reference is given they are compared on customer, date, " +
    "amount and method together, which is a weaker match.",

  contract: {
    dependsOn: [
      {
        entity: "customers",
        strength: "hard",
        because:
          "Every receipt names the customer it came from, and a name we cannot find is a row we cannot write. Load your customer list first, or the whole file will be reported back to you as unmatched names.",
      },
      {
        /**
         * ⚠️ SOFT, NOT HARD, AND THE DISTINCTION EARNS ITS KEEP HERE.
         *
         * A receipt is written and is complete without the opening
         * position. What the opening trial balance changes is what the
         * receipt MEANS — see the double-count note at the head of this
         * entity — not whether it can be written. A hard edge would stop
         * a customer who does not yet have their accountant's trial
         * balance from loading anything at all, and most customers do not
         * have all their files on day one.
         */
        entity: "opening-trial-balance",
        strength: "soft",
        because:
          "These receipts do not move your bank balance, because your opening trial balance is what carries it. You can load them first — the figures will only be complete once the trial balance is in.",
      },
    ],
    /**
     * ⭐ `delete`, AND IT IS THE HONEST ANSWER RATHER THAN THE EASY ONE.
     *
     * `update` is not offered (see `duplicateModes`), so every row this
     * entity writes is a row that did not exist before the run: deleting
     * it restores the prior state exactly. This is case ① in
     * `ImportReversalPolicy` and it is the only entity in this phase that
     * qualifies for it.
     *
     * ⚠️ IT DEPENDS ON PROVENANCE EXISTING. "Delete the rows this run
     * created" is answerable only from `import_row_provenance`; the
     * timestamp alternative would sweep up every receipt the customer's
     * staff keyed in by hand during the migration window, and a migration
     * takes hours while the office does not stop. That sidecar table is
     * Phase 2's to build and IS NOT IN THIS TREE — `TRACK-REPORT.md §2`
     * records that, because a reversal policy that reads as complete
     * while nothing can execute it is exactly the defect this project
     * keeps finding.
     */
    reversal: {
      kind: "delete",
      escapes:
        "Nothing. These receipts post nothing to the general ledger, send nothing to the customer, and are not allocated to any invoice, so deleting one leaves no trace anywhere else. The receipt NUMBERS it consumed are not reused, which is deliberate: a number that appeared on a statement should never come back attached to different money.",
      because:
        "`update` is not offered, so every row is a row this run created and deleting it restores the prior state exactly. Nothing that pre-dates the migration can be reached by this undo.",
    },
    /**
     * ⚠️ ONE TABLE AND `one-to-one`, BECAUSE THIS ENTITY WRITES NO
     * ALLOCATIONS. If allocation is ever added — see
     * `PATCH-REQUEST-PHASE-5.md` — this becomes two targets and `many`,
     * and `customer_receipt_allocations` has to become a destination in
     * its own right, or the allocation rows are unattributable and the
     * undo leaves them behind driving the `received_minor` trigger.
     */
    provenance: { targets: ["customer_receipts"], cardinality: "one-to-one" },
    /**
     * ⭐ THE ONE ENTITY IN THIS PHASE WITH A NON-EMPTY `structural`.
     *
     * A receipt with no customer on it is money from nobody: it cannot be
     * applied to an invoice, cannot appear on a statement, and violates
     * `customer_receipts.company_id NOT NULL` at the insert. That is the
     * third question — "without this value the ROW IS NOT A THING" — and
     * the answer is yes.
     *
     * 🔴 IT NAMES `customerName` AND NOT `companyId`, AND THE DIFFERENCE
     *    MATTERS ENOUGH TO WRITE DOWN.
     *
     * `structural` names PAYLOAD fields, post-Zod. `companyId` is not one
     * of them: it does not exist until `server/actions/import.ts` has
     * resolved the lookup and written it in, which happens AFTER the
     * payload is parsed. An implementation of `requiredness` that ran
     * where the type says it runs would find `companyId` absent on every
     * row of every file and refuse all of them.
     *
     * ⚠️ AND TODAY NOTHING READS THIS MEMBER AT ALL. `requiredness` is
     * consulted by `checkImportContract()` and by nothing else in the
     * tree — not `lib/import/plan.ts`, not `server/actions/import.ts`.
     * The refusal a customer actually gets for a nameless receipt comes
     * from the schema's `.min(1)` above, and for an unmatched name from
     * the lookup's `missing` sentence, both in the preview. See
     * `TRACK-REPORT.md §2`; declaring it correctly is this phase's job,
     * enforcing it is not.
     */
    requiredness: {
      structural: ["customerName"],
      messages: {
        customerName:
          "This receipt does not say which customer it came from. Money with no customer on it cannot be applied to an invoice or shown on a statement, so the row cannot be imported.",
      },
    },
    duplicateDecision: {
      recommended: "skip",
      because:
        "A re-upload of the same file must not credit the same money twice. `skip` guarantees that. Note that a receipt with no reference is matched on customer, date, amount and method together — so two genuinely separate cash payments of the same amount, from the same customer, on the same day will look like one and the second will be skipped. Give each row a reference and that ambiguity disappears.",
    },
  },
};

/* ================================================================== */
/* THE MAP                                                             */
/* ================================================================== */

/**
 * ⚠️ ONE MAP, EXPORTED, AND NOT SPREAD INTO ANYTHING HERE.
 *
 * `lib/import/entities.ts` is contested by five phases at once, so this
 * file does not edit it. The single-line spread that makes these two
 * entities reachable is written out in `PATCH-REQUEST-PHASE-5.md` for
 * integration to apply.
 *
 * 🔴 UNTIL THAT LINE LANDS, NEITHER ENTITY IS REACHABLE, AND THAT IS
 *    CORRECT RATHER THAN UNFINISHED. Reach is membership in
 *    `ALL_IMPORT_ENTITIES` and nothing else — not this map, not the
 *    writer registry, which is keyed by destination and cannot make
 *    anything importable.
 */
export const SALES_IMPORT_ENTITIES = {
  customers: customersEntity,
  receipts: receiptsEntity,
} as const satisfies Record<string, ContractedImportEntity>;

export type SalesImportEntityKey = keyof typeof SALES_IMPORT_ENTITIES;

/* ================================================================== */
/* THE TWO ENTITIES THIS FILE DOES NOT DEFINE                          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `sales-invoices` AND `credit-notes` ARE REFUSED, NOT FORGOTTEN
 * ══════════════════════════════════════════════════════════════════════
 * Phase 5's brief asks for four entities. Two are above. These two are
 * not here, and this note exists so that the next person to open this
 * file reads the gap as a decision that was made rather than as work
 * somebody dropped.
 *
 * ──────────────────────────────────────────────────────────────────────
 * `sales-invoices` — there is no schema for a historical invoice
 * ──────────────────────────────────────────────────────────────────────
 * Step 1 of the phase brief: *"Find the existing validator. In
 * `lib/validators/`. If there is no schema for this thing, the entity is
 * not ready and you should say so in your report rather than writing one.
 * A schema written for the importer is by definition not the one the form
 * uses."*
 *
 * There is exactly one way to create a sales invoice in this product,
 * and it is `raiseInvoiceFromOrderSchema` in
 * `lib/validators/sales-invoices.ts`. It requires:
 *
 *   · `orderId` — a CONFIRMED Ordence sales order. `raiseInvoiceFromOrder`
 *     refuses a draft one by name, reads the tax determination the order
 *     froze at confirmation, and takes the customer, the place of supply
 *     and every line from it. A historical invoice out of Tally has no
 *     order in Ordence and never will.
 *   · `lines: [{ orderLineId }]` — uuids of lines of that same order.
 *
 * And it deliberately CANNOT carry the customer's own invoice number.
 * `issueInvoiceSchema`'s comment is explicit: *"THERE IS NO
 * `invoiceNumber` FIELD AND THERE NEVER WILL BE. The number is derived
 * inside the transaction that issues the document. A caller who can
 * choose it can collide with a document already in a customer's file, and
 * Rule 46(b) requires the series to be consecutive — a caller-supplied
 * number cannot be."* A migration's whole point is that the numbers come
 * from the system being left behind.
 *
 * ⚠️ SO BUILDING THIS ENTITY REQUIRES EITHER (a) A SCHEMA WRITTEN FOR THE
 *    IMPORTER, which rule 6 forbids in the same breath as describing it,
 *    or (b) A DELIBERATE PRODUCT DECISION to let a number be supplied
 *    from outside the series. (b) is a decision about invoice numbering
 *    under Rule 46(b); it is not Phase 5's to take as a side effect of an
 *    import feature. `PATCH-REQUEST-PHASE-5.md §1` writes out what such a
 *    schema would have to express, which of `raiseInvoiceFromOrderSchema`'s
 *    rules it would still have to enforce, and who owns the decision.
 *
 * ⭐ AND THE COST OF REFUSING IS SMALLER THAN IT LOOKS. Open receivables
 * — the part a customer needs to trade on day one — already migrate,
 * through `opening-customer-invoices`, which exists, is contracted, has a
 * writer, and carries each invoice's own number, date and outstanding
 * amount. What is refused is full historical invoice HISTORY, with lines
 * and tax, which nobody needs in order to raise their first invoice in
 * Ordence.
 *
 * ──────────────────────────────────────────────────────────────────────
 * `credit-notes` — refused twice over
 * ──────────────────────────────────────────────────────────────────────
 * `raiseCreditNoteSchema` requires `invoiceId`, a uuid of an invoice that
 * is already in this workspace, and its lines optionally reference
 * `invoiceLineId`. `sales_credit_notes.invoice_id` is `NOT NULL`, so the
 * dependency is the database's and not merely the schema's: a credit note
 * in this product is always ABOUT an invoice.
 *
 * ⚠️ THE INVOICES IT WOULD BE ABOUT ARE THE ONES REFUSED ABOVE, and the
 * ones that DO import — `opening-customer-invoices` — are explicitly not
 * tax invoices: their taxable value is zero, because the supply and the
 * tax were reported by the system being left behind. A credit note under
 * Section 34 reduces a tax liability that this workspace never recorded.
 * Importing one would either restate a return that another system filed,
 * or write a document with no tax effect that looks exactly like one that
 * has — and an assessing officer reads them the same way.
 *
 * ⭐ THE CORRECT MIGRATION FOR A PRE-CUTOVER CREDIT NOTE IS THE ONE THE
 * PRODUCT ALREADY IMPLEMENTS: it is already netted off the outstanding
 * figure on the opening invoice list, in exactly the way a part-payment
 * is, and the tax it carried was reported by the old system.
 */
