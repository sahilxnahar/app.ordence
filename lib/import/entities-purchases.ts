/**
 * Ordence — What Can Be Imported: PURCHASES
 * Version: v1.85.0-alpha · Phase 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO ENTITIES SHIP HERE, AND TWO WERE REFUSED. BOTH FACTS ARE THE WORK.
 * ══════════════════════════════════════════════════════════════════════
 * The brief named four: `vendors`, `purchase-bills`, `debit-notes` and
 * `payments`. Two of those cannot be built against this tree without
 * editing files Phase 6 does not own, and building them anyway would
 * produce the defect this codebase has been found to have more than
 * thirty times: built, offered in a picker, unreachable — or worse,
 * reachable and writing the wrong row. `TRACK-REPORT.md` §3 and §4 give
 * the proof for each refusal, with the commands that produced it.
 *
 * What ships:
 *
 *   vendors          → `vendors`.            The payee. Wave 0.
 *   purchase-bills   → `purchase_invoices`.  Header, one line, and the
 *                                            vendor-ledger leg. Wave 1.
 *
 * ⚠️ THIS FILE EXPORTS ONE MAP AND REGISTERS NOTHING. `ALL_IMPORT_ENTITIES`
 * in `lib/import/entities.ts` is the single allowlist on the write path
 * and five phases are adding to it at once. The one-line spread that
 * merges this map is in `PATCH-REQUEST-PHASE-6.md`, for integration to
 * apply — five phases each adding one line to one file is five clean
 * merges; five phases each rewriting that file is five conflicts.
 *
 * ⚠️ NO DATABASE IMPORT. Rule 7. Everything here is pure: the validators
 * out of `lib/validators/purchases.ts` (the same objects the forms
 * parse), `financialYearOf` out of `lib/gst/constants.ts`, and `zod`.
 * That purity is what lets the client wizard build a blank template from
 * these columns without dragging Postgres into the browser bundle.
 */

import { z } from "zod";
import { financialYearOf } from "@/lib/gst/constants";
import {
  expenditureNatureSchema,
  itcPurposeSchema,
  recordPurchaseInvoiceSchema,
  upsertVendorSchema,
  vendorTypeSchema,
} from "@/lib/validators/purchases";
import { supplyTypeSchema } from "@/lib/validators/gst";
import type { ContractedImportEntity, ImportLookup } from "./types";

/* ------------------------------------------------------------------ */
/* MONEY — THE UNIT CHANGES AT THIS BOUNDARY AND NOTHING SAYS SO        */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A `kind: "money"` COLUMN ARRIVES IN MINOR UNITS. THE PURCHASE
 *    VALIDATORS WANT MAJOR UNITS. THE FACTOR IS 100 AND IT IS SILENT.
 * ══════════════════════════════════════════════════════════════════════
 * `coerceMoneyMinor` in `lib/import/values.ts` reads `"1,250.50"` off a
 * spreadsheet and hands `buildPayload` the string `"125050"` — paise, as
 * a digit string, because a bigint cannot cross a server-action boundary
 * and a float cannot hold a crore of paise.
 *
 * `moneyString` in `lib/validators/purchases.ts` is
 * `/^-?\d+(\.\d{1,2})?$/` and `parseMoney` multiplies by 100. Handing it
 * `"125050"` is therefore not a type error, not a validation error, and
 * not a runtime error. It is a bill for ₹125,050 where the customer wrote
 * ₹1,250.50, written successfully, reported as success, and wrong by two
 * orders of magnitude on every row of the file.
 *
 * ⚠️ VERIFIED, NOT ASSUMED:
 *   `lib/import/values.ts:138`  coerceMoneyMinor(raw, exponent = 2)
 *   `lib/billing/money.ts:72`   parseMoney(amount, currency = "INR")
 *   `lib/validators/purchases.ts:45`  moneyString accepts "125050"
 *
 * ⚠️ AND THE CONVERSION IS STRING ARITHMETIC, NEVER `Number(v) / 100`.
 * Same reason `thousandthsToDecimal` in `server/import/writers/shared.ts`
 * is: the division is exact for small numbers and silently lossy for
 * large ones, and the symptom is a purchase register that is a few paise
 * out on the bills nobody looks at.
 *
 * ⚠️ THE EXPONENT IS FIXED AT 2 BECAUSE THIS IMPORT IS INR-ONLY.
 * `purchase_invoices.currency` takes its `INR` default and `pricePurchase`
 * is handed no other; a JPY bill (0 decimals) or a KWD bill (3) would
 * need a currency column, a per-row exponent and an FX rate on the date,
 * which is a different feature. Stated rather than left to be discovered.
 */
const MINOR_UNIT_DIGITS = 2;

function rupeesFromMinor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const negative = trimmed.startsWith("-");
  const digits = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+$/.test(digits)) return null;

  /*
   * `padStart(MINOR_UNIT_DIGITS + 1)` guarantees at least one digit
   * before the point: 5 paise is "0.05", never ".05", which `moneyString`
   * would refuse and which would read as a validation bug rather than as
   * a formatting one.
   */
  const padded = digits.padStart(MINOR_UNIT_DIGITS + 1, "0");
  const whole = padded.slice(0, -MINOR_UNIT_DIGITS);
  const fraction = padded.slice(-MINOR_UNIT_DIGITS);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** The same conversion where the validator wants a value rather than a null. */
function rupeesOrZero(value: unknown): string {
  return rupeesFromMinor(value) ?? "0";
}

/* ================================================================== */
/* 1 — VENDORS                                                         */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DESTINATION IS `vendors`, NOT `gst_parties`, AND THE BRIEF SAID
 *    OTHERWISE. THIS IS THE DEVIATION AND HERE IS THE ARGUMENT.
 * ══════════════════════════════════════════════════════════════════════
 * The brief maps `vendors` to `gst_parties` and asks Phase 6 to
 * coordinate with Phase 5 over the shared destination. Three facts, each
 * checkable in this tree, say the shared destination should not be
 * shared at all:
 *
 * ① `gst_parties` ALREADY HAS AN ENTITY, AND IT ALREADY COVERS VENDORS.
 *    `gstPartiesEntity` in `lib/import/entities.ts` is registered, has a
 *    required `partyType` column whose values are `customer` and
 *    `vendor`, and keys on `(party_type, gstin)` — the composite exists
 *    precisely so that the same firm can be both at once. A second entity
 *    writing that table with that key would be a second way to reach one
 *    destination with one identity. Under `update` the two would
 *    overwrite each other's rows and each would report success.
 *
 * ② `db/schema/purchases.ts:396` ARGUES AT LENGTH THAT A VENDOR IS NOT A
 *    GST PARTY. "`gst_parties` answers what tax identity did we transact
 *    under, and was it valid on the date of this document — it is DATED
 *    … A vendor is a single continuing relationship with payment terms, a
 *    bank account, an MSME status and a running balance, and it must
 *    survive its counterparty's re-registration without the balance
 *    splitting in two." Importing a vendor master into `gst_parties`
 *    would drop the payment terms, the Udyam number and the MSME
 *    category — which are the columns Section 43B(h) is enforced from.
 *
 * ③ THE FRAMEWORK ALREADY EXPECTS A `vendors` TABLE TO BE IMPORTABLE.
 *    `ImportLookupKind` in `lib/import/types.ts` carries `vendor_by_code`
 *    — "`vendors.code` — V-0042. Unique per workspace." — and
 *    `resolveLookups` in `server/actions/import.ts:432` resolves it
 *    against `vendors`. `opening-vendor-bills` already depends on it.
 *    Nothing can satisfy that dependency today, because no entity writes
 *    `vendors`. This one does.
 *
 * ⭐ WHICH DISSOLVES THE COORDINATION PROBLEM RATHER THAN SOLVING IT.
 *    Phase 5 and Phase 6 do not need to agree how to share `gst_parties`,
 *    because neither of them should add an entity to it: the entity that
 *    is already there carries both party types, and that is what
 *    `(party_type, gstin)` is for. Recorded here and in
 *    `TRACK-REPORT.md` §2, which is the record the brief asked both
 *    phases to keep.
 */
const vendorsEntity: ContractedImportEntity = {
  key: "vendors",
  label: "Vendors",
  noun: { one: "vendor", many: "vendors" },
  description:
    "The suppliers, contractors and landlords you pay. Their code, their " +
    "payment terms and their MSME registration — which is what decides " +
    "whether a late payment is disallowed under Section 43B(h).",
  table: "vendors",
  feature: "purchases.invoices",
  createPermission: "purchases:manage_vendors",
  updatePermission: "purchases:manage_vendors",

  columns: [
    {
      field: "code",
      header: "Vendor code",
      kind: "text",
      required: true,
      maxLength: 40,
      aliases: ["vendorcode", "suppliercode", "partycode", "ledgercode", "alias", "id"],
      help:
        "Your own reference for this vendor, such as V-0042. It must be " +
        "present and unique, because every bill and every payment quotes it.",
    },
    {
      field: "legalName",
      header: "Legal name",
      kind: "text",
      required: true,
      maxLength: 255,
      aliases: ["name", "vendorname", "suppliername", "party", "registeredname", "firm"],
      help: "The name as registered. What their invoice is printed in.",
    },
    {
      field: "tradeName",
      header: "Trade name",
      kind: "text",
      required: false,
      maxLength: 255,
      aliases: ["tradingname", "brand", "dba", "shortname"],
      help: "What they are known as day to day, if it differs.",
    },
    {
      field: "vendorType",
      header: "Vendor type",
      kind: "enum",
      required: false,
      enumValues: vendorTypeSchema.options,
      aliases: ["type", "category", "suppliertype", "class"],
      help: `One of: ${vendorTypeSchema.options.join(", ")}. Defaults to other.`,
    },
    {
      field: "panNumber",
      header: "PAN",
      kind: "text",
      required: false,
      maxLength: 10,
      aliases: ["pan", "pannumber", "pancard", "incometaxno"],
      help: "Ten characters, e.g. AAAAA0000A. Refused if it is not that shape.",
    },
    {
      /**
       * ⚠️ THE ONE COLUMN WHOSE ABSENCE COSTS MONEY LATER.
       *
       * `vendors_msme_complete` and `vendors_terms_sane` are CHECK
       * constraints, and `upsertVendorSchema.superRefine` refuses an
       * MSME claim with no Udyam number and terms over 45 days for a
       * micro or small enterprise. A file that says "yes" here and
       * leaves the number blank is refused in the PREVIEW with the
       * validator's own sentence, which explains that Section 43B(h)
       * bites only for a REGISTERED enterprise.
       */
      field: "msmeRegistered",
      header: "MSME registered",
      kind: "boolean",
      required: false,
      aliases: ["msme", "udyamregistered", "ssi", "issmallenterprise"],
      help:
        "yes or no. Say yes only if they have a Udyam number, because " +
        "Section 43B(h) only applies to a registered enterprise — and then " +
        "the number and the category below become compulsory.",
    },
    {
      field: "udyamNumber",
      header: "Udyam number",
      kind: "text",
      required: false,
      maxLength: 19,
      aliases: ["udyam", "udyamregistrationnumber", "udyog", "msmeno"],
      help:
        "UDYAM-MH-01-0001234. A twelve-digit Udyog Aadhaar number is the " +
        "old scheme, was replaced in July 2020 and is refused.",
    },
    {
      field: "msmeCategory",
      header: "MSME category",
      kind: "enum",
      required: false,
      enumValues: ["micro", "small", "medium"],
      aliases: ["msmetype", "enterprisecategory", "msmeclass"],
      help:
        "micro, small or medium. It matters: 43B(h) applies to micro and " +
        "small only, and calling a medium vendor small raises a false alarm " +
        "on every bill they send.",
    },
    {
      field: "msmeRegisteredOn",
      header: "MSME registered on",
      kind: "date",
      required: false,
      aliases: ["udyamdate", "msmedate", "registeredon"],
      help: "YYYY-MM-DD. The date on the Udyam certificate.",
    },
    {
      field: "paymentTermsDays",
      header: "Payment terms (days)",
      kind: "integer",
      required: false,
      bounds: { min: 0, max: 365 },
      aliases: ["terms", "creditdays", "paymentterms", "creditperiod", "duedays"],
      help:
        "A whole number of days. Defaults to 30. Capped at 45 for a " +
        "registered micro or small enterprise — Section 15 of the MSMED " +
        "Act, and Section 32 voids any longer agreement.",
    },
    {
      field: "tdsApplicable",
      header: "TDS applicable",
      kind: "boolean",
      required: false,
      aliases: ["tds", "deducttds", "withholding"],
      help: "yes or no.",
    },
    {
      field: "defaultTdsSection",
      header: "TDS section",
      kind: "text",
      required: false,
      maxLength: 12,
      aliases: ["section", "tdssection", "itsection"],
      help: "Such as 194C or 194J.",
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
      header: "State",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["statename", "province"],
      help: "",
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
      field: "bankAccountName",
      header: "Bank account name",
      kind: "text",
      required: false,
      maxLength: 160,
      aliases: ["accountname", "beneficiaryname"],
      help: "",
    },
    {
      /**
       * ⚠️ THE LAST FOUR DIGITS ONLY, AND THE COLUMN IS NAMED THAT WAY
       * SO NOBODY PASTES THE WHOLE NUMBER IN. `vendors.bank_details`
       * stores `accountNumberLast4` and `upsertVendorSchema` caps it at
       * four characters — a full account number pasted here is refused
       * in the preview rather than stored.
       */
      field: "bankAccountLast4",
      header: "Bank account last 4",
      kind: "text",
      required: false,
      maxLength: 4,
      aliases: ["accountlast4", "acclast4", "last4"],
      help: "The last four digits only. A full account number is refused.",
    },
    {
      field: "bankIfsc",
      header: "IFSC",
      kind: "text",
      required: false,
      maxLength: 11,
      aliases: ["ifsc", "ifsccode", "rtgscode"],
      help: "Eleven characters, e.g. HDFC0001234.",
    },
    {
      field: "bankName",
      header: "Bank name",
      kind: "text",
      required: false,
      maxLength: 160,
      aliases: ["banker", "bank"],
      help: "",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 4000,
      aliases: ["comments", "remarks", "description"],
      help: "Free text.",
    },
  ],

  /**
   * ⚠️ TWO JSONB OBJECTS ASSEMBLED FROM FLAT COLUMNS, AND BOTH ARE
   * OMITTED ENTIRELY WHEN EVERY PART IS BLANK RATHER THAN SENT AS `{}`.
   *
   * Exactly the argument `gstPartiesEntity.buildPayload` makes and for
   * exactly the same consequence: `upsertVendor` writes
   * `address: data.address ?? {}`, so an `{}` arriving from a file that
   * simply has no address columns would ERASE an address already on the
   * record in `update` mode. Absent means "not supplied"; `blankIsNull`
   * in `values.ts` exists to preserve that distinction and it has to
   * survive this far.
   *
   * ⚠️ `gstin` IS DELIBERATELY NOT A COLUMN HERE. `upsertVendorSchema`
   * accepts one and `upsertVendor` DROPS IT — `vendors` has no `gstin`
   * column, only `gst_party_id`. Offering the column would put a value in
   * the file that validates, imports, reports success and is stored
   * nowhere, which is this codebase's characteristic defect wearing a
   * spreadsheet header. Linking a vendor to its `gst_parties` row needs a
   * `gst_party_by_gstin` lookup kind, which lives in a file Phase 6 does
   * not own; the patch is in `PATCH-REQUEST-PHASE-6.md` §5 and the
   * column arrives with it, not before.
   */
  buildPayload: (values) => {
    const address: Record<string, string> = {};
    const putAddress = (key: string, field: string) => {
      const v = values[field];
      if (typeof v === "string" && v.trim() !== "") address[key] = v;
    };
    putAddress("line1", "addressLine1");
    putAddress("line2", "addressLine2");
    putAddress("city", "city");
    putAddress("state", "state");
    putAddress("postalCode", "postalCode");
    putAddress("country", "country");

    const bankDetails: Record<string, string> = {};
    const putBank = (key: string, field: string) => {
      const v = values[field];
      if (typeof v === "string" && v.trim() !== "") bankDetails[key] = v;
    };
    putBank("accountName", "bankAccountName");
    putBank("accountNumberLast4", "bankAccountLast4");
    putBank("ifsc", "bankIfsc");
    putBank("bankName", "bankName");

    return {
      code: values.code,
      legalName: values.legalName,
      tradeName: values.tradeName,
      /*
       * ⚠️ `?? undefined` AND NOT `?? "other"`. The DEFAULT LIVES IN THE
       * SCHEMA. Writing it here would be a second copy of a rule, and the
       * copy is the one that survives a change to the other.
       */
      ...(values.vendorType === null || values.vendorType === undefined
        ? {}
        : { vendorType: values.vendorType }),
      panNumber: values.panNumber,
      ...(values.msmeRegistered === null || values.msmeRegistered === undefined
        ? {}
        : { msmeRegistered: values.msmeRegistered }),
      udyamNumber: values.udyamNumber,
      msmeCategory: values.msmeCategory,
      msmeRegisteredOn: values.msmeRegisteredOn,
      ...(values.paymentTermsDays === null || values.paymentTermsDays === undefined
        ? {}
        : { paymentTermsDays: values.paymentTermsDays }),
      ...(values.tdsApplicable === null || values.tdsApplicable === undefined
        ? {}
        : { tdsApplicable: values.tdsApplicable }),
      defaultTdsSection: values.defaultTdsSection,
      notes: values.notes,
      ...(Object.keys(address).length > 0 ? { address } : {}),
      ...(Object.keys(bankDetails).length > 0 ? { bankDetails } : {}),
    };
  },

  /**
   * 🔴 THE SAME SCHEMA `upsertVendor` PARSES — `server/actions/purchases.ts:162`.
   * Not a copy and not a looser one. The MSME rules, the 45-day statutory
   * cap and the Udyam shape all fire here, in the preview, with their own
   * sentences.
   */
  schema: upsertVendorSchema,

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE KEY IS `code`, AND IT IS THE INDEX THE DATABASE ALREADY HAS.
   * ══════════════════════════════════════════════════════════════════
   * `vendors_code_tenant_unique` is `UNIQUE (tenant_id, code)` —
   * `db/schema/purchases.ts:474`, and SQL 0240 in this phase proves it
   * refuses rather than merely existing. This is a STRONG key, unlike
   * the `legalName` fallback `gst_parties` is forced into: a vendor code
   * is the thing the customer's old system already used to identify the
   * relationship, it is what their bills quote, and it is what
   * `vendor_by_code` resolves against.
   *
   * ⚠️ THE MATCH IS CASE-INSENSITIVE HERE AND THE INDEX IS NOT.
   * `vendors_code_tenant_unique` is on the raw `code`, so `V-42` and
   * `v-42` are two different vendors to Postgres. Lower-casing the key
   * means the importer treats them as one and REFUSES the second row as
   * a duplicate within the file, rather than creating two vendors whose
   * codes differ only in case — which nobody can tell apart on a
   * payment run. That is deliberately STRICTER than the database, which
   * is the safe direction; `resolveLookups`' `vendor_by_code` is
   * `lower(code)` too, so a bill quoting either spelling finds it.
   *
   * ⚠️ AND THERE IS NO FALLBACK KEY. A vendor with no code is refused by
   * `upsertVendorSchema` before this runs, so `null` here is
   * unreachable — it is returned rather than thrown because
   * `naturalKey` is typed to allow it and a throw in the pure layer
   * would take the whole file down instead of one row.
   */
  naturalKey: (parsed) => {
    const code = typeof parsed.code === "string" ? parsed.code.trim() : "";
    if (code === "") return null;
    return {
      kind: "vendorCode",
      value: code.toLowerCase(),
      label: `vendor code ${code}`,
    };
  },

  rowLabel: (parsed) => {
    const name = typeof parsed.legalName === "string" ? parsed.legalName.trim() : "";
    const code = typeof parsed.code === "string" ? parsed.code.trim() : "";
    if (name !== "" && code !== "") return `${name} (${code})`;
    return name !== "" ? name : code !== "" ? code : "(no name)";
  },

  duplicateModes: ["skip", "update", "fail"],
  duplicateRule:
    "Vendors are matched on their code, ignoring upper and lower case. Two rows with the same code are the same vendor.",

  contract: {
    /**
     * ⚠️ EMPTY, AND IT IS A DECISION RATHER THAN AN OMISSION.
     *
     * A vendor points at a `gst_parties` row through `gst_party_id` and
     * at a company through `company_id`, and both are nullable. This
     * import sets neither — see the note on `gstin` above — so there is
     * nothing for the customer to load first. When the
     * `gst_party_by_gstin` lookup lands (PATCH-REQUEST §5) this becomes
     * a SOFT dependency on `gst-parties` and not a hard one, because a
     * vendor with no tax identity on file is still a vendor you can pay.
     */
    dependsOn: [],

    /**
     * 🔴 `restore-prior` BECAUSE `update` IS OFFERED. Gate 29 refuses
     * `update` together with `delete` by name, and it is right to: a
     * vendor record that pre-dates the migration carries a running
     * balance, a blocked reason somebody typed, and bank details a human
     * verified against a cheque. Overwriting those in `update` mode and
     * then DELETING the record on undo destroys data the run never
     * created — and `vendors` is `ON DELETE RESTRICT` from
     * `purchase_invoices` and `vendor_payments`, so the delete would
     * either fail loudly on a vendor with history or succeed on one
     * without, which is the worst of both.
     */
    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      escapes:
        "Bills and payments recorded against this vendor between the import and the undo are not removed and are not re-pointed. Restoring the vendor's prior name, terms and MSME status does not restate a 43B(h) exposure that was computed from the imported terms in the meantime.",
      because:
        "`update` is offered because a vendor code is a strong key and a correction pass over a vendor master is a normal thing to want. That makes overwriting a pre-existing record possible, so undo has to put the old values back rather than delete the row.",
    },

    /**
     * ⚠️ ONE TABLE, ONE ROW PER INPUT ROW. `vendors` has no child tables
     * this import writes: the address and the bank details are `jsonb`
     * columns on the row itself, which is exactly why they are `jsonb`.
     */
    provenance: { targets: ["vendors"], cardinality: "one-to-one" },

    /**
     * ⚠️ EMPTY, AND THIS IS THE CASE THE CONTRACT WARNS ABOUT FROM THE
     * OTHER DIRECTION.
     *
     * `code` and `legalName` genuinely are the two facts without which
     * the row is not a vendor. Both are `.min(1)` in `upsertVendorSchema`
     * and a blank arrives as `null`, so Zod refuses the row before
     * `requiredness` is ever consulted. Listing them here would be a
     * THIRD copy of a rule that already exists in two places, and the
     * copy is the one that goes stale — `types.ts` is explicit that
     * `requiredness` is not derivable from the schema, and the converse
     * is that it must not restate it either.
     *
     * The honest answer is therefore empty, and it is empty because
     * somebody checked, not because somebody forgot.
     */
    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "The first load of a vendor master goes into an empty workspace, where `skip` and `update` do the same thing. If the workspace is not empty, `update` rewrites payment terms, MSME status and bank details on vendors somebody may already have corrected by hand — and the payment run pays from those. Choose `update` deliberately, for a correction pass, when the file is the one you trust.",
    },
  },
};

/* ================================================================== */
/* 2 — PURCHASE BILLS                                                  */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCHEMA PROBLEM, AND WHY THIS IS NOT AN "IMPORT VARIANT"
 * ══════════════════════════════════════════════════════════════════════
 * `recordPurchaseInvoiceSchema` — the object `recordPurchaseInvoice`
 * parses at `server/actions/purchases.ts:403` — requires `vendorId: uuid`.
 * No customer's purchase register carries our uuids. The row carries a
 * vendor CODE, and the framework turns a code into an id through
 * `lookups`, which run AFTER validation:
 *
 *   lib/import/plan.ts:282   entity.schema.safeParse(payload)
 *   lib/import/plan.ts:337   entity.lookups?.(parsedPayload)
 *
 * So a payload built for this schema fails on every row, and — because
 * `z.object` STRIPS unknown keys — `vendorCode` would not survive the
 * parse for `lookups` or `naturalKey` to read even if it did not.
 *
 * ⚠️ THE TEMPTING FIX IS A COPY OF THE SCHEMA WITH `vendorId` SWAPPED
 *    FOR `vendorCode`, AND THAT IS FORBIDDEN FOR GOOD REASON. That copy
 *    would leave behind the four `superRefine` rules: the Section 12(3)
 *    place-of-supply rule for immovable property, the Section 9(3)/9(4)
 *    reverse-charge citation, the bill-of-supply-carries-no-tax rule
 *    (Section 17(5)(e)), and the capital-goods-into-own-building rule
 *    that `lib/validators/purchases.ts` calls "the cheapest place to
 *    catch the most expensive mistake". An importer that skips those is
 *    how ten thousand unusable rows arrive at once.
 *
 * ⭐ SO THIS DELEGATES RATHER THAN COPIES. `importPurchaseBillSchema`
 *    RUNS `recordPurchaseInvoiceSchema`. Every rule in it fires, every
 *    issue it raises is re-raised with its own message, and the only
 *    edit is the one field the file cannot carry.
 *
 * 🔴 AND THE PLACEHOLDER IS DELETED FROM THE OUTPUT, NOT LEFT IN IT.
 *    A sentinel uuid that survived into the payload would be a value
 *    that means nothing sitting in the field the write reads — one
 *    misspelled `into:` away from being written to the database as a
 *    vendor. `vendorId` is therefore ABSENT from the parsed payload
 *    until `resolveLookups` puts a real one there, and
 *    `purchaseInvoicesWriter` refuses a payload that still has no
 *    `vendorId` by name. Two guards, in different files, for the failure
 *    that would otherwise be silent.
 */
const VENDOR_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

export const importPurchaseBillSchema = z
  .object({
    vendorCode: z
      .string({
        required_error: "The vendor's code in Ordence, such as V-0042.",
        invalid_type_error: "The vendor's code in Ordence, such as V-0042.",
      })
      .trim()
      .min(1, "The vendor's code in Ordence, such as V-0042.")
      .max(40),
  })
  /*
   * ⚠️ `passthrough`, NOT `strict` AND NOT THE DEFAULT STRIP. The default
   * would delete every other field before the delegate ever saw it.
   */
  .passthrough()
  .transform((value, ctx) => {
    const { vendorCode, ...rest } = value as Record<string, unknown> & {
      vendorCode: string;
    };

    const parsed = recordPurchaseInvoiceSchema.safeParse({
      ...rest,
      vendorId: VENDOR_ID_PLACEHOLDER,
    });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        /*
         * ⚠️ A LINE ISSUE IS REPORTED AGAINST ITS FLAT COLUMN.
         *
         * The delegate raises `["lines", 0, "amount"]`. `plan.ts:284`
         * reads `issue.path[0]` to find the column whose HEADER goes in
         * the failed-rows CSV, so left alone every line problem in the
         * file would be filed under a column called "lines" — which is
         * not a header in the customer's spreadsheet and cannot be
         * found in it. One row is one line here, so `path[2]` IS the
         * flat column's field name.
         */
        const path =
          issue.path[0] === "lines" && typeof issue.path[2] === "string"
            ? [issue.path[2]]
            : issue.path;
        ctx.addIssue({ ...issue, path });
      }
      return z.NEVER;
    }

    const { vendorId: _resolvedByLookup, ...bill } = parsed.data;
    return { ...bill, vendorCode };
  });

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE ROW IS ONE BILL WITH ONE LINE, AND THAT IS A LIMIT, NOT A
 *    DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * `buildPayload` is `(values) => payload` — one row in, one payload out.
 * There is no mechanism in the framework for grouping several rows into
 * one document except `atomic`/`batchKey`, which make the WHOLE FILE one
 * document (that is what the opening trial balance uses). Neither shape
 * is "these four rows are one four-line bill".
 *
 * So a bill with four taxable lines at different rates cannot be
 * expressed, and a file that has one will import four separate bills
 * with the same invoice number — except that it will not, because the
 * natural key below collapses them and the second row is refused inside
 * the file with a message naming the first. The customer is told, in the
 * preview, rather than discovering four bills.
 *
 * ⭐ AND ONE LINE IS THE RIGHT SHAPE FOR THE FILE PEOPLE ACTUALLY HAVE.
 * A purchase register exported from Tally or Busy is one row per bill
 * carrying the taxable value and the tax under each head. That is what
 * this reads. A multi-line bill needs a `groupBy` on the entity
 * definition — `PATCH-REQUEST-PHASE-6.md` §6 — and it is proposed there
 * rather than faked here.
 */
const purchaseBillsEntity: ContractedImportEntity = {
  key: "purchase-bills",
  label: "Purchase bills",
  noun: { one: "bill", many: "bills" },
  description:
    "Your vendors' invoices, with the tax they charged and what each " +
    "purchase was for. Load your vendors first. One row is one bill.",
  table: "purchase_invoices",
  feature: "purchases.invoices",
  createPermission: "purchases:record_invoice",
  updatePermission: "purchases:record_invoice",

  columns: [
    {
      field: "vendorCode",
      header: "Vendor code",
      kind: "text",
      required: true,
      maxLength: 40,
      aliases: ["vendor", "supplier", "suppliercode", "vendorcode", "partycode", "ledger"],
      help:
        "The vendor's code in Ordence, such as V-0042 — not their name. " +
        "Import your vendors first so this can be matched.",
    },
    {
      field: "invoiceNumber",
      header: "Bill number",
      kind: "text",
      required: true,
      maxLength: 64,
      aliases: ["billno", "invoiceno", "invoicenumber", "billnumber", "docno", "reference"],
      help:
        "The vendor's own number, exactly as printed. It is what they will " +
        "quote back at you and what the duplicate check matches on.",
    },
    {
      field: "invoiceDate",
      header: "Bill date",
      kind: "date",
      required: true,
      aliases: ["date", "billdate", "invoicedate", "docdate", "voucherdate"],
      help:
        "YYYY-MM-DD. The date on the bill, not the date you are importing " +
        "it. Every ageing bucket and the 43B(h) clock are measured from it.",
    },
    /**
     * ══════════════════════════════════════════════════════════════════
     * 🔴 THERE IS NO DUE-DATE COLUMN, AND ITS ABSENCE IS A FINDING
     *    RATHER THAN AN OVERSIGHT.
     * ══════════════════════════════════════════════════════════════════
     * `purchase_invoices.due_date` exists (SQL 0063 line 294) and
     * `server/actions/vendor-payments.ts` reads it twice — into the
     * ageing at line 119 and into `allocateOldestFirst` at line 320.
     *
     * ⚠️ NOTHING IN THIS PRODUCT EVER WRITES IT. Verified:
     *
     *   grep -rn "purchaseInvoices" --include=*.ts server/ app/ lib/ \
     *     | grep -E "\.insert\(|\.update\("
     *
     * returns seven sites — one insert in `recordPurchaseInvoice` and
     * six updates across `purchase-orders.ts`, `fx/initial-recognition.ts`
     * and `fx/revaluation-service.ts` — and not one of them names
     * `dueDate`. `recordPurchaseInvoiceSchema` has no such member either.
     * Every purchase bill in this product therefore has a NULL due date,
     * and the payment run allocates oldest-first over a column that is
     * always null.
     *
     * 🔴 SO THE IMPORTER COULD ONLY SET IT WITH A SECOND STATEMENT AFTER
     *    `recordPurchaseInvoice` RETURNS — a write outside the
     *    transaction that wrote the bill. If that second statement
     *    failed, the bill would exist, the row would be reported as an
     *    error, and the re-run would SKIP it as a duplicate: the due
     *    date would be lost permanently and the report would have said
     *    the bill was not imported. Half a write dressed as a whole one
     *    is the shape this project keeps finding.
     *
     * The column arrives when `recordPurchaseInvoice` accepts a due
     * date. The two-line patch is `PATCH-REQUEST-PHASE-6.md` §3.
     */
    {
      field: "goodsReceivedDate",
      header: "Goods received on",
      kind: "date",
      required: false,
      aliases: ["grndate", "receiveddate", "goodsreceived", "deliverydate"],
      help:
        "YYYY-MM-DD, or blank. Section 16(2)(b) makes credit available only " +
        "once the goods have actually been received.",
    },
    {
      field: "description",
      header: "Description",
      kind: "text",
      required: true,
      maxLength: 2000,
      aliases: ["particulars", "narration", "item", "details", "linedescription"],
      help: "What was bought. One line per bill, so one description per bill.",
    },
    {
      field: "hsnSacCode",
      header: "HSN or SAC",
      kind: "text",
      required: false,
      maxLength: 8,
      aliases: ["hsn", "sac", "hsncode", "saccode", "hsnsac"],
      help:
        "The classification the vendor billed under. Where it matches your " +
        "rate master the notified rate is checked against what they charged.",
    },
    {
      field: "amount",
      header: "Taxable value",
      kind: "money",
      required: true,
      aliases: ["taxablevalue", "basicamount", "netamount", "assessablevalue", "value"],
      help:
        "The amount BEFORE tax, in rupees — 1250.50. Not the bill total; " +
        "the tax goes in its own columns below.",
    },
    {
      field: "discount",
      header: "Discount",
      kind: "money",
      required: false,
      aliases: ["disc", "tradediscount", "lessdiscount"],
      help:
        "In rupees, or blank. A discount larger than the line is a credit " +
        "note from the vendor, not a bill, and is refused.",
    },
    {
      /**
       * ⚠️ BASIS POINTS, AND THE UNFRIENDLY UNIT IS THE CORRECT ONE.
       *
       * `purchaseLineSchema.rateBps` is `z.number().int()`, and GST has
       * real rates that are not whole percentages: 0.25% on rough
       * diamonds, 1.5% on job work in the diamond trade, 3% on gold.
       * A "GST rate %" column of kind `integer` cannot express any of
       * them, and one of kind `money` would produce the coercion
       * layer's own error message — "write it as rupees" — on a column
       * that is not rupees. `ImportColumnKind` has no decimal-percentage
       * member; the proposal for one is PATCH-REQUEST §6, and until it
       * lands the honest column is the one the validator actually takes.
       */
      field: "rateBps",
      header: "GST rate (basis points)",
      kind: "integer",
      required: true,
      bounds: { min: 0, max: 10_000 },
      aliases: ["gstrate", "taxrate", "rate", "ratebps", "gstpercent", "taxpercent"],
      help:
        "In basis points: 1800 for 18%, 500 for 5%, 0 for exempt, 25 for " +
        "0.25%. Basis points because 0.25% and 1.5% are real GST rates and " +
        "a whole percentage cannot express them.",
    },
    {
      field: "cgst",
      header: "CGST",
      kind: "money",
      required: false,
      aliases: ["cgstamount", "centraltax", "cgstamt"],
      help: "In rupees, as the vendor charged it. Blank means none.",
    },
    {
      field: "sgst",
      header: "SGST",
      kind: "money",
      required: false,
      aliases: ["sgstamount", "statetax", "utgst", "sgstamt"],
      help: "In rupees, as the vendor charged it. Blank means none.",
    },
    {
      field: "igst",
      header: "IGST",
      kind: "money",
      required: false,
      aliases: ["igstamount", "integratedtax", "igstamt"],
      help:
        "In rupees, as the vendor charged it. A bill carries IGST or " +
        "CGST+SGST, never both.",
    },
    {
      field: "cess",
      header: "Cess",
      kind: "money",
      required: false,
      aliases: ["cessamount", "compensationcess", "cessamt"],
      help: "In rupees. Blank means none.",
    },
    {
      field: "cessRateBps",
      header: "Cess rate (basis points)",
      kind: "integer",
      required: false,
      bounds: { min: 0, max: 100_000 },
      aliases: ["cessrate", "cessratebps", "cesspercent"],
      help: "In basis points. Blank means none.",
    },
    {
      field: "roundOff",
      header: "Round off",
      kind: "money",
      required: false,
      aliases: ["rounding", "roundoff", "adjustment"],
      help:
        "In rupees, and it may be negative. What the vendor added or took " +
        "off to reach a round total.",
    },
    {
      field: "supplyType",
      header: "Supply type",
      kind: "enum",
      required: false,
      enumValues: supplyTypeSchema.options,
      aliases: ["type", "naturesupply", "supplynature"],
      help:
        `One of: ${supplyTypeSchema.options.join(", ")}. Defaults to goods. ` +
        "immovable_property changes where the credit lands and needs the " +
        "property's state below.",
    },
    {
      field: "placeOfSupplyCode",
      header: "Place of supply",
      kind: "text",
      required: false,
      maxLength: 2,
      aliases: ["pos", "placeofsupply", "poscode", "supplystate"],
      help: "Two digits, e.g. 27 for Maharashtra — not the state's name.",
    },
    {
      field: "propertyStateCode",
      header: "Property state",
      kind: "text",
      required: false,
      maxLength: 2,
      aliases: ["propertystate", "sitestate", "projectstate"],
      help:
        "Two digits. Required when the supply type is immovable_property: " +
        "under Section 12(3) the place of supply is where the property is.",
    },
    {
      field: "isBillOfSupply",
      header: "Bill of supply",
      kind: "boolean",
      required: false,
      aliases: ["billofsupply", "bos", "composition", "exemptbill"],
      help:
        "yes or no. A bill of supply carries no GST, so no credit arises " +
        "from it — tax typed against one is refused.",
    },
    {
      field: "isReverseCharge",
      header: "Reverse charge",
      kind: "boolean",
      required: false,
      aliases: ["rcm", "reversecharge", "isrcm"],
      help:
        "yes or no. If yes, say which provision in the next column — the " +
        "tax is payable in cash, not out of the credit ledger.",
    },
    {
      field: "rcmSection",
      header: "Reverse charge section",
      kind: "text",
      required: false,
      maxLength: 16,
      aliases: ["rcmsection", "section", "rcmprovision"],
      help: "9(3), 9(4) or 5(3). Rule 46(p) requires a self-invoice to cite it.",
    },
    {
      /**
       * 🔴 REQUIRED, AND THE FILE IS REFUSED WITHOUT THE HEADER.
       *
       * `purchaseLineSchema.itcPurpose` has NO default, deliberately, and
       * `lib/validators/purchases.ts:288` says why: "defaulting the
       * answer to the eligible one means a person entering a cement bill
       * for the company's own head office claims the credit by pressing
       * Enter, and Section 17(5)(d) is the single most expensive mistake
       * in this product."
       *
       * ⚠️ THE COLUMN DEFAULT IN THE DATABASE IS NOT A LICENCE. That
       * same note says the column defaults to `taxable_supply` "so that
       * an import of historical bills does not fail" — but this import
       * goes through the front door, through the schema the form parses,
       * and a five-thousand-row file that silently claims credit on
       * five thousand bills is precisely the failure the note is
       * describing at scale. `required: true` means a file without the
       * header is refused BEFORE a row is read, with one sentence the
       * customer can act on, rather than five thousand wrong claims.
       */
      field: "itcPurpose",
      header: "What it was for",
      kind: "enum",
      required: true,
      enumValues: itcPurposeSchema.options,
      aliases: ["itcpurpose", "purpose", "creditpurpose", "usage", "itc"],
      help:
        `One of: ${itcPurposeSchema.options.join(", ")}. This decides ` +
        "whether the input tax credit is available, and it has no default: " +
        "cement for your own building is own_account_construction and its " +
        "credit is blocked by Section 17(5)(d).",
    },
    {
      field: "expenditureNature",
      header: "Nature of spend",
      kind: "enum",
      required: false,
      enumValues: expenditureNatureSchema.options,
      aliases: ["nature", "spendtype", "expensetype", "expenditure"],
      help:
        `One of: ${expenditureNatureSchema.options.join(", ")}. Defaults to ` +
        "goods. Several of these are blocked outright by Section 17(5).",
    },
    {
      field: "isCapitalGoods",
      header: "Capital goods",
      kind: "boolean",
      required: false,
      aliases: ["capital", "iscapital", "capitalgoods", "fixedasset"],
      help: "yes or no. Capital goods going into your own building carry their blocked GST into the cost.",
    },
    {
      field: "taxPeriod",
      header: "Tax period",
      kind: "text",
      required: false,
      maxLength: 7,
      aliases: ["period", "gstperiod", "returnperiod", "month"],
      help: "YYYY-MM, such as 2024-07 — the GSTR-3B period the credit is claimed in.",
    },
    {
      field: "isTdsDeductible",
      header: "TDS deductible",
      kind: "boolean",
      required: false,
      aliases: ["tds", "tdsapplicable", "deducttds"],
      help: "yes or no.",
    },
    {
      field: "tdsSection",
      header: "TDS section",
      kind: "text",
      required: false,
      maxLength: 12,
      aliases: ["tdssection", "itsection"],
      help: "Such as 194C or 194J.",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 4000,
      aliases: ["remarks", "comments"],
      help: "Free text.",
    },
  ],

  /**
   * ⚠️ THE FLAT ROW BECOMES A HEADER PLUS A ONE-ELEMENT `lines` ARRAY,
   * AND EVERY MONEY FIELD CHANGES UNIT ON THE WAY. See `rupeesFromMinor`
   * at the top of this file: the coercion layer produced paise and the
   * validator wants rupees, and nothing between the two would have said
   * so.
   *
   * ⚠️ `isReverseCharge` IS WRITTEN TWICE, TO THE HEADER AND TO THE LINE,
   * AND THAT IS NOT A DUPLICATE. `purchase_invoices.is_reverse_charge`
   * decides whether the tax is paid in cash; `purchase_invoice_lines.
   * is_reverse_charge` is what `pricePurchase` sums into `rcmTaxMinor`.
   * A one-line bill has one answer, so the same answer goes in both
   * places; a multi-line bill could legitimately differ, which is one
   * more thing the grouping proposal in PATCH-REQUEST §6 would have to
   * settle.
   */
  buildPayload: (values) => ({
    vendorCode: values.vendorCode,
    invoiceNumber: values.invoiceNumber,
    invoiceDate: values.invoiceDate,
    goodsReceivedDate: values.goodsReceivedDate,
    ...(values.isBillOfSupply === null || values.isBillOfSupply === undefined
      ? {}
      : { isBillOfSupply: values.isBillOfSupply }),
    ...(values.supplyType === null || values.supplyType === undefined
      ? {}
      : { supplyType: values.supplyType }),
    placeOfSupplyCode: values.placeOfSupplyCode,
    propertyStateCode: values.propertyStateCode,
    ...(values.isReverseCharge === null || values.isReverseCharge === undefined
      ? {}
      : { isReverseCharge: values.isReverseCharge }),
    rcmSection: values.rcmSection,
    taxPeriod: values.taxPeriod,
    ...(values.isTdsDeductible === null || values.isTdsDeductible === undefined
      ? {}
      : { isTdsDeductible: values.isTdsDeductible }),
    tdsSection: values.tdsSection,
    roundOff: rupeesOrZero(values.roundOff),
    notes: values.notes,

    lines: [
      {
        lineNumber: 1,
        description: values.description,
        hsnSacCode: values.hsnSacCode,
        /*
         * ⚠️ `?? undefined` AND NOT `?? "0"`. A BLANK TAXABLE VALUE MUST
         * BE REFUSED, NOT READ AS ZERO. `amount` is the one money field
         * on this row with no schema default, and a bill for nothing is
         * not a bill — quietly turning an empty cell into ₹0 would
         * import it, report success, and leave a payable of zero against
         * a vendor who is owed money. `undefined` reaches
         * `nonNegativeMoney` as a missing required value and the row is
         * refused in the preview.
         */
        amount: rupeesFromMinor(values.amount) ?? undefined,
        ...(rupeesFromMinor(values.discount) === null
          ? {}
          : { discount: rupeesOrZero(values.discount) }),
        rateBps: values.rateBps,
        ...(values.cessRateBps === null || values.cessRateBps === undefined
          ? {}
          : { cessRateBps: values.cessRateBps }),
        cgst: rupeesOrZero(values.cgst),
        sgst: rupeesOrZero(values.sgst),
        igst: rupeesOrZero(values.igst),
        cess: rupeesOrZero(values.cess),
        ...(values.isReverseCharge === null || values.isReverseCharge === undefined
          ? {}
          : { isReverseCharge: values.isReverseCharge }),
        itcPurpose: values.itcPurpose,
        ...(values.expenditureNature === null || values.expenditureNature === undefined
          ? {}
          : { expenditureNature: values.expenditureNature }),
        ...(values.isCapitalGoods === null || values.isCapitalGoods === undefined
          ? {}
          : { isCapitalGoods: values.isCapitalGoods }),
      },
    ],
  }),

  schema: importPurchaseBillSchema,

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE KEY IS THE UNIQUE INDEX, EXPRESSION FOR EXPRESSION.
   * ══════════════════════════════════════════════════════════════════
   * `SQL-FILES/0023_phase33_purchases.sql:539`:
   *
   *   CREATE UNIQUE INDEX purchase_invoices_no_duplicate_bill
   *     ON purchase_invoices (
   *       tenant_id, vendor_id,
   *       upper(btrim(invoice_number)),
   *       indian_financial_year(invoice_date))
   *     WHERE status <> 'cancelled';
   *
   * So the key is the vendor, the bill number UPPER-CASED and trimmed,
   * and the FINANCIAL YEAR of the bill's own date — not the date itself.
   * A vendor may reuse serial 001 next year and that is a different bill;
   * the same serial twice in one year is the same bill.
   *
   * ⚠️ THE VENDOR IS THE CODE, NOT THE ID. `naturalKey` runs on the
   * parsed payload BEFORE lookups resolve — `plan.ts:299` against
   * `plan.ts:337` — so reaching for `vendorId` here would read a field
   * that is not set yet and key every row in the file on `undefined`,
   * collapsing the whole file onto one match. The worked example makes
   * the identical point about `companyName`. The code is what the two
   * files agree on anyway.
   *
   * ⚠️ `financialYearOf` AND NOT A LOCAL COPY. `lib/gst/constants.ts:155`
   * is the one place that decides where 1 April falls, and the SQL
   * function `indian_financial_year` produces the same `2024-25`
   * spelling. Two places that each decide when a financial year begins
   * is two places that can disagree, and the one that disagrees is never
   * the one being read.
   *
   * 🔴 AND `WHERE status <> 'cancelled'` IS MIRRORED IN THE WRITER, NOT
   *    HERE. The pure layer cannot know a row's status; `findExisting`
   *    in `server/import/writers/purchases/purchase-invoices.ts` excludes
   *    cancelled bills for the same reason the index does — a bill
   *    somebody cancelled must be enterable again, and matching it would
   *    make the re-entry silently skip.
   */
  naturalKey: (parsed) => {
    const code = typeof parsed.vendorCode === "string" ? parsed.vendorCode.trim() : "";
    const number =
      typeof parsed.invoiceNumber === "string" ? parsed.invoiceNumber.trim() : "";
    const date = typeof parsed.invoiceDate === "string" ? parsed.invoiceDate : "";
    if (code === "" || number === "" || date === "") return null;

    const year = financialYearOf(date);
    return {
      kind: "vendorBillFy",
      value: `${code.toLowerCase()}|${number.toUpperCase()}|${year}`,
      label: `bill ${number} from ${code} in ${year}`,
    };
  },

  rowLabel: (parsed) => {
    const number =
      typeof parsed.invoiceNumber === "string" ? parsed.invoiceNumber.trim() : "";
    const code = typeof parsed.vendorCode === "string" ? parsed.vendorCode.trim() : "";
    if (number === "") return code === "" ? "(no bill number)" : code;
    return code === "" ? number : `${number} — ${code}`;
  },

  /**
   * 🔴 THE VENDOR CODE BECOMES `vendorId` HERE AND NOWHERE ELSE, AND IT
   *    IS THE ONLY THING THAT PUTS A `vendorId` IN THE PAYLOAD AT ALL.
   *
   * The delegating schema deletes the placeholder, so a row whose lookup
   * misses reaches the write path with no `vendorId` — except that it
   * does not reach the write path at all, because
   * `server/actions/import.ts:577` turns an unresolved lookup into an
   * ordinary row error carrying the sentence below, in the PREVIEW, for
   * both runs, from one call site.
   *
   * ⚠️ AND THE LOOKUP IS UNCONDITIONAL, unlike the worked example's,
   * which skips a row that names no company. A bill owed to nobody is
   * not a bill — the same distinction `types.ts` draws between a contact
   * with no company (real) and an invoice with no customer (not an
   * invoice). `vendorCode` is `.min(1)` in the schema above, so the
   * empty case is already refused and this never sees it.
   */
  lookups: (parsed): readonly ImportLookup[] => {
    const raw = typeof parsed.vendorCode === "string" ? parsed.vendorCode.trim() : "";
    if (raw === "") return [];
    return [
      {
        kind: "vendor_by_code",
        value: raw.toLowerCase(),
        into: "vendorId",
        missing: `No vendor with the code "${raw}" is in your workspace. Import your vendors first, or correct the code here — a bill has to be owed to somebody.`,
      },
    ];
  },

  /**
   * 🔴 NO `update`, AND THE REASON IS THE LEDGER RATHER THAN A
   *    PREFERENCE.
   *
   * Recording a bill writes four things in one transaction: the header,
   * its lines, a `vendor_ledger_entries` credit, and a journal entry
   * through `recognisePurchaseInvoice`. `journal_entries` is append-only
   * by design — the schema says so in a comment where `updatedAt` and
   * `deletedAt` would have been. There is no operation in this product
   * that rewrites a recorded bill in place, and offering one from an
   * importer would be offering an operation the ledger cannot perform.
   *
   * ⚠️ WHICH IS ALSO WHAT MAKES THE REVERSAL POLICY BELOW LEGAL. Gate 29
   * refuses `update` together with `reverse-entry` by name.
   */
  duplicateModes: ["skip", "fail"],
  duplicateRule:
    "A bill is matched on the vendor, the bill number ignoring case and spaces, and the financial year the bill is dated in — which is exactly the duplicate rule the database itself enforces. The same serial next year is a different bill.",

  contract: {
    dependsOn: [
      {
        entity: "vendors",
        strength: "hard",
        because:
          "Every bill is owed to a vendor and quotes their code, so your vendor list has to be in before the bills that point at it. Loading the bills first means every single row comes back saying the vendor is not there.",
      },
    ],

    /**
     * 🔴 `reverse-entry`, NOT `delete`, AND THE DIFFERENCE IS AN AUDIT
     *    TRAIL.
     *
     * Deleting an imported bill would leave behind the journal entry it
     * posted — `journal_entries` cannot be deleted, and `transactions`
     * carries the balanced pair. An undo that removes the payable and
     * leaves the double entry gives the customer books that do not tie,
     * which is worse than either doing nothing or doing it properly.
     * A posted bill is undone by a reversing entry dated when the
     * reversal happened, which is what an accountant would do by hand.
     *
     * ⚠️ AND THE INPUT TAX CREDIT IS THE PART THAT ESCAPES. If the tax
     * period has been filed, the credit claimed on these bills is in a
     * return that has gone to the Government. Reversing the entry does
     * not unfile it; that is a credit reversal in a later period with
     * its own interest consequence under Section 50. The planner shows
     * that sentence BEFORE the run.
     *
     * 🔴 AND THERE IS NOTHING BEHIND ANY OF THIS YET. `import_row_provenance`
     *    does not exist in this tree — `grep -rn "import_row_provenance"
     *    SQL-FILES/` returns nothing, and `lib/import/types.ts:337` cites
     *    "SQL 0196", which is not a file. So this policy is a declaration
     *    that Phase 2 will implement, not a behaviour that can be
     *    demonstrated today. `TRACK-REPORT.md` §5 says so plainly rather
     *    than claiming an undo this phase could not run.
     */
    reversal: {
      kind: "reverse-entry",
      escapes:
        "Input tax credit claimed on these bills in a GSTR-3B that has already been filed does not come back with the entry. Reversing it is a credit reversal in a later period, with interest under Section 50 running from the date it was taken. Payments already allocated against an imported bill are not unallocated.",
      because:
        "Recording a bill posts to `journal_entries`, which is append-only by design — the schema says so in a comment where `updatedAt` and `deletedAt` would have been. Deleting the bill would leave the double entry behind and the books would not tie. A posted entry is corrected by reversing it, on its own date, with its own audit trail.",
    },

    /**
     * ⚠️ ONE TARGET, AND THE OTHER THREE TABLES CANNOT BE NAMED.
     *
     * This entity writes `purchase_invoices`, `purchase_invoice_lines`,
     * `vendor_ledger_entries`, `journal_entries` and `transactions` in
     * one transaction. `ImportProvenancePolicy.targets` is typed
     * `readonly (ImportTableKey | PendingImportTableKey)[]`, and
     * `ImportTableKey` is ALSO the key of `IMPORT_WRITERS` — a `Record`
     * over the union. Naming `purchase_invoice_lines` here would
     * therefore be a compile error demanding a WRITER for a table that
     * is never written on its own.
     *
     * 🔴 THAT IS A REAL HOLE AND IT IS REPORTED RATHER THAN PAPERED
     *    OVER: provenance can attribute the header and nothing under it,
     *    so a reconciliation counting line rows against input rows has
     *    no sidecar to read. `cardinality: "many"` is what stops that
     *    from reading as 0 provenance rows missing — `types.ts:376`
     *    says cardinality exists precisely to stop a checker reporting
     *    false misses. The proposal to split the destination union from
     *    the provenance union is PATCH-REQUEST §4.
     */
    provenance: { targets: ["purchase_invoices"], cardinality: "many" },

    /**
     * ⚠️ ONE STRUCTURAL FIELD, AND IT IS THE ONE THE SCHEMA CANNOT
     * REFUSE.
     *
     * `vendorId` is not a member of `importPurchaseBillSchema` — it is
     * put into the payload by `resolveLookups` after validation. So Zod
     * cannot refuse a row that has none, and this is the only place that
     * can say a bill owed to nobody is not a bill. `types.ts` uses
     * exactly this example: "`sales_invoices` would make a customer
     * optional in the identical shape, and an invoice with no customer
     * is not an invoice."
     *
     * ⚠️ `vendorCode` IS NOT LISTED. It is `.min(1)` in the schema and a
     * blank is refused before this is consulted; listing it would be the
     * third copy of one rule. Compare `vendors` above, where the same
     * reasoning produces an empty list.
     */
    requiredness: {
      structural: ["vendorId"],
      messages: {
        vendorId:
          "This bill is not linked to a vendor. A bill owed to nobody cannot be paid, cannot be aged and cannot carry its input tax credit — check the vendor code against your vendor list.",
      },
    },

    duplicateDecision: {
      recommended: "skip",
      because:
        "`skip` is what makes re-uploading the whole file safe, and re-uploading the whole file is the normal second action: a first run reports failures, you fix those rows, and the file on your desktop is still the whole file. Every bill already in Ordence is left exactly as it is. `fail` is there for the run where a duplicate means the file itself is wrong and you want to know before anything lands.",
    },
  },
};

/* ------------------------------------------------------------------ */
/* THE MAP                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ONE EXPORT, AND IT IS NOT A REGISTRY.
 *
 * `ALL_IMPORT_ENTITIES` in `lib/import/entities.ts` is the single
 * allowlist on the write path and `isImportEntityKey` is membership in
 * it. This map is a contribution to that one, applied by the one-line
 * spread in `PATCH-REQUEST-PHASE-6.md`. Nothing here makes an entity
 * reachable and nothing here should ever be consulted by the server.
 *
 * ⚠️ `satisfies` RATHER THAN AN ANNOTATION, so the keys stay literal and
 * `AnyImportEntityKey` gains `"vendors"` and `"purchase-bills"` rather
 * than widening to `string`.
 */
export const PURCHASE_IMPORT_ENTITIES = {
  vendors: vendorsEntity,
  "purchase-bills": purchaseBillsEntity,
} as const satisfies Record<string, ContractedImportEntity>;
