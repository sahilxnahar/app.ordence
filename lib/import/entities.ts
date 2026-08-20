/**
 * Ordence — What Can Be Imported
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO ENTITIES, CHOSEN BECAUSE THEY ARE AS DIFFERENT AS THIS PRODUCT GETS
 * ══════════════════════════════════════════════════════════════════════
 * A framework proved with one entity is not a framework, and a framework
 * proved with two SIMILAR entities is not much better. These two were
 * picked because between them they exercise everything the abstraction
 * claims to handle:
 *
 *   COMPANIES        a flat table, a `.parse()` on a plain object schema,
 *                    an integer column, an enum column, and a natural key
 *                    that is one of TWO different fields depending on the
 *                    row (domain when there is one, name when there is not).
 *
 *   GST PARTIES      a schema with a `.superRefine()` carrying cross-field
 *                    rules, a nested `address` object assembled from six
 *                    flat CSV columns, a date column, an enum whose
 *                    canonical values are not what a human types, and a
 *                    natural key that is COMPOSITE — `(party_type, gstin)`,
 *                    matching the partial unique index the database
 *                    actually enforces.
 *
 * If the framework can express both without either of them contributing
 * code that runs, the third entity is a table entry.
 *
 * ⚠️ AN ALLOWLIST, NEVER A LOOKUP. Same reasoning as `BULK_ENTITIES` in
 * `server/actions/bulk.ts`: an entity resolved dynamically from a caller's
 * string is one migration away from letting a crafted value reach `users`
 * or the vault, where "create 500 of these from a file" is an attack.
 * Adding an entry here is a deliberate act with a code review on it.
 *
 * ⚠️ NO DATABASE IMPORT. The schemas come from `lib/validators/`, which is
 * pure by design and is imported by the forms too — that shared import is
 * the mechanism that makes the import path and the typing path the same
 * rules rather than two sets that agree today.
 */

import { COMPANY_SIZES, createCompanySchema } from "@/lib/validators/crm";
import { upsertPartySchema } from "@/lib/validators/gst";
import { OPENING_IMPORT_ENTITIES } from "./opening-entities";
import { ACCOUNTING_IMPORT_ENTITIES } from "./entities-accounting";
import { CRM_IMPORT_ENTITIES } from "./entities-crm";
import { PURCHASE_IMPORT_ENTITIES } from "./entities-purchases";
import { SALES_IMPORT_ENTITIES } from "./entities-sales";
import { INVENTORY_IMPORT_ENTITIES } from "./entities-inventory";
import { OPENING_CONTRACTS } from "./contract/opening-policies";
import type { ContractedImportEntity } from "./types";

/* ------------------------------------------------------------------ */
/* COMPANIES                                                           */
/* ------------------------------------------------------------------ */

const companiesEntity: ContractedImportEntity = {
  key: "companies",
  /** ⭐ WAVE 2C. No money column on this entity. */
  money: { source: "none" },
  label: "Companies",
  noun: { one: "company", many: "companies" },
  description:
    "Organisations you sell to or buy from. The list most workspaces start with.",
  table: "companies",
  feature: "crm.companies",
  createPermission: "companies:create",
  updatePermission: "companies:update",

  columns: [
    {
      field: "name",
      header: "Name",
      kind: "text",
      required: true,
      maxLength: 255,
      aliases: ["company", "companyname", "organisation", "organization", "firm", "account"],
      help: "The organisation's name. The only column that must be present.",
    },
    {
      field: "domain",
      header: "Domain",
      kind: "text",
      required: false,
      maxLength: 253,
      aliases: ["website domain", "emaildomain", "webdomain"],
      help:
        "Bare domain such as ordence.com — no https:// and no path. " +
        "Where present this is what a re-import matches on.",
    },
    {
      field: "industry",
      header: "Industry",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["sector", "vertical"],
      help: "Free text.",
    },
    {
      field: "employeeCount",
      header: "Employees",
      kind: "integer",
      required: false,
      bounds: { min: 0, max: 10_000_000 },
      aliases: ["headcount", "staff", "employeecount", "noofemployees"],
      help: "A whole number. 1,200 with a comma is accepted.",
    },
    {
      field: "companySize",
      header: "Size band",
      kind: "enum",
      required: false,
      enumValues: COMPANY_SIZES,
      aliases: ["size", "companysize", "band"],
      help: `One of: ${COMPANY_SIZES.join(", ")}.`,
    },
    {
      field: "website",
      header: "Website",
      kind: "text",
      required: false,
      maxLength: 512,
      aliases: ["url", "site", "webaddress"],
      help: "A full URL including https://.",
    },
    {
      field: "phone",
      header: "Phone",
      kind: "text",
      required: false,
      maxLength: 40,
      aliases: ["telephone", "mobile", "contactnumber"],
      help: "Free text — extensions and country codes are kept as written.",
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
      aliases: ["province", "region"],
      help: "The state's name. (GST parties use the two-digit code instead.)",
    },
    {
      field: "postalCode",
      header: "PIN code",
      kind: "text",
      required: false,
      maxLength: 20,
      aliases: ["pin", "pincode", "postalcode", "zip", "postcode"],
      help: "",
    },
    {
      field: "country",
      header: "Country",
      kind: "text",
      required: false,
      maxLength: 2,
      aliases: ["countrycode"],
      help: "Two-letter code, e.g. IN. Anything longer is refused, not truncated.",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 10_000,
      aliases: ["comments", "remarks", "description"],
      help: "Free text. Line breaks survive if the cell is quoted.",
    },
  ],

  buildPayload: (values) => ({ ...values, customFields: {} }),
  schema: createCompanySchema,

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE NATURAL KEY IS THE DOMAIN, AND THE NAME ONLY WHEN THERE IS NO
   *    DOMAIN. THE ORDER IS NOT ARBITRARY.
   * ══════════════════════════════════════════════════════════════════
   * `companies` already has a partial unique index on
   * `(tenant_id, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL`
   * — the database will refuse a second row with the same domain
   * regardless of what this function says. Keying on anything else would
   * mean the framework's idea of "the same company" and the database's
   * idea disagree, and the disagreement surfaces as a raw constraint
   * violation halfway through a run instead of as a planned update.
   * `db/schema/crm.ts` calls the domain "the natural dedupe key during
   * imports" in its own comment; this is that.
   *
   * ⚠️ THE NAME FALLBACK IS WEAKER AND IS USED ANYWAY, DELIBERATELY.
   * Most real CRM exports have a domain for a minority of rows. With no
   * fallback, re-uploading a file would duplicate every domain-less
   * company in it — which is the exact failure constraint 3 exists to
   * prevent, and it would hit the majority of rows. Names are compared
   * case- and whitespace-insensitively because "ACME Traders" and "Acme
   * Traders  " are one company by any reading.
   *
   * ⚠️ AND ITS FAILURE MODE IS NAMED ON SCREEN. Two genuinely different
   * businesses can share a name — there is more than one "Sharma
   * Enterprises" in India — so under `update` a name match can merge two
   * real companies into one record. The wizard says this in the sentence
   * next to the duplicate-handling choice, before the run, which is the
   * only moment saying it is any use.
   */
  naturalKey: (parsed) => {
    const domain = typeof parsed.domain === "string" ? parsed.domain.trim() : "";
    if (domain !== "") {
      return {
        kind: "domain",
        value: domain.toLowerCase(),
        label: `domain ${domain.toLowerCase()}`,
      };
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (name === "") return null;
    return {
      kind: "name",
      value: name.toLowerCase().replace(/\s+/g, " "),
      label: `name "${name}"`,
    };
  },

  rowLabel: (parsed) => (typeof parsed.name === "string" ? parsed.name : "(no name)"),

  /* ---------------------------------------------------------------- */
  /* ⭐⭐ TRACK M1 — THE CONTRACT. WORKED EXAMPLE 1 OF 2.                */
  /* ---------------------------------------------------------------- */

  /**
   * ⚠️ READ THIS ONE FIRST IF YOU ARE ADDING AN ENTITY.
   *
   * `companies` was chosen as the first worked example because it is the
   * boring case, and the boring case is where the contract has to be
   * legible. Everything below is a decision with a reason attached, and
   * the reasons are the part that took the time.
   */
  contract: {
    /**
     * ⚠️ NOTHING, AND IT IS THE REASON COMPANIES ARE WAVE ZERO.
     *
     * A company row is self-contained: every value it needs is in the
     * row. That is unusual and it is why this is the file a customer is
     * asked for first.
     */
    dependsOn: [],

    /**
     * 🔴 `restore-prior`, NOT `delete`, AND THE DIFFERENCE IS THE WHOLE
     *    REASON THIS MEMBER EXISTS.
     *
     * `companies` offers `update`, and customers use it — the second
     * upload of a customer list is usually a refresh, not a first load.
     * In `update` mode this entity OVERWRITES a record that existed
     * before the migration, carrying notes, deals and history the import
     * knows nothing about. An undo that deleted it would destroy data
     * that was never part of the run, in the name of undoing the run.
     *
     * ⚠️ AND `restore-prior` IS NOT FREE. The prior values must be
     * captured at write time, because by undo time they are gone. That
     * capture is Track M2's ledger; this declaration is what tells M2 to
     * take it. `checkImportContract()` refuses `restore-prior` with an
     * empty capture list, because an undo that runs and restores nothing
     * is worse than one that refuses.
     */
    reversal: {
      kind: "restore-prior",
      /**
       * ⚠️ `"*"` — THE WHOLE ROW, AND THAT IS THE RIGHT ANSWER HERE
       * RATHER THAN A LAZY ONE. An import in `update` mode writes every
       * mapped column, and which columns are mapped depends on the
       * customer's file, so the set of fields at risk is not knowable
       * when this definition is written. Naming individual fields would
       * be naming the ones today's template happens to carry.
       */
      capturePriorFields: ["*"],
      /**
       * ⚠️ WAS `null`, WHICH WAS A CLAIM AND THE CLAIM WAS FALSE.
       * `lib/import/types.ts`: "`null` IS A CLAIM, NOT A DEFAULT. It says
       * the author looked." This table carries a `*_set_updated_at` BEFORE
       * UPDATE trigger whose entire body is `NEW.updated_at = now()`, so an
       * undo cannot put that column back.
       *
       * 🔴 MEASURED, NOT ARGUED. Phase 2's `import_restore_prior_values()`
       *    re-reads each row after restoring it and returns every column
       *    that did not come back:  rows_affected 1 | unrestored {updated_at}
       *    Gate 29 could never have seen this: it reads declarations.
       */
      escapes:
        "The record's `last updated` timestamp will read the moment of the undo rather than the moment before the import. Every other field comes back exactly as it was; a database trigger rewrites that one on any change.",
      because:
        "This entity offers `update`, so a run can overwrite records that pre-date the migration. Deleting those on undo would destroy customer data the run never created. The prior values are captured at write time because they do not survive to undo time.",
    },

    provenance: { targets: ["companies"], cardinality: "one-to-one" },

    /**
     * ⚠️ EMPTY, AND CHECKED RATHER THAN ASSUMED. `createCompanySchema`
     * already refuses a blank name, which is the only field without
     * which a company is not a company. Restating it here would be a
     * second copy of a rule that would disagree with the first the day
     * the schema moved.
     */
    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "Most second uploads are the whole file again after fixing a few rows, and `skip` makes that safe. `update` turns the import into a mass edit of records you already have — pick it only when the file is deliberately a refresh, and note that it needs a separate permission.",
    },
  },
};

/* ------------------------------------------------------------------ */
/* GST PARTIES                                                         */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ENTITY THAT DECIDES THE TAX
 * ══════════════════════════════════════════════════════════════════════
 * A `gst_parties` row is not a contact record with a tax field on it. It
 * is the answer to "what tax identity do we bill this buyer under, and
 * was it valid on the date of the document" — the buyer's registration is
 * what flips an invoice between CGST+SGST and IGST, and an SEZ buyer is
 * inter-state under s.7(5)(b) even across the road.
 *
 * ⚠️ WHICH IS WHY THIS IMPORT GOES THROUGH `upsertPartySchema` AND NOT
 * NEAR AN INSERT. That schema's `.superRefine()` carries three rules that
 * no amount of column mapping would reproduce:
 *
 *   • a `regular` or `composition` party MUST have a GSTIN — without one
 *     the supply is reported as B2C and the buyer loses input credit they
 *     were entitled to, which they discover at their own year end;
 *   • an `unregistered` or `overseas` party must NOT have one;
 *   • a state code, where given, must equal the GSTIN's first two digits,
 *     because a GSTIN's prefix IS its state and a mismatch moves the
 *     invoice between tax heads.
 *
 * The database enforces all three again as CHECK constraints. A bulk path
 * that skipped the schema would meet them as `23514` violations with no
 * row number and no explanation — which is precisely the "one of four
 * write paths" problem `server/actions/gst.ts` warns about at the top.
 */
const gstPartiesEntity: ContractedImportEntity = {
  key: "gst-parties",
  /** ⭐ WAVE 2C. No money column on this entity. */
  money: { source: "none" },
  label: "GST parties",
  noun: { one: "party", many: "parties" },
  description:
    "Customers and vendors and the GSTIN each is billed under. Their registration " +
    "is what decides CGST+SGST against IGST on every invoice you raise.",
  table: "gst_parties",
  feature: "gst.registry",
  createPermission: "gst:manage_parties",
  updatePermission: "gst:manage_parties",

  columns: [
    {
      field: "partyType",
      header: "Customer or vendor",
      kind: "enum",
      required: true,
      enumValues: ["customer", "vendor"],
      aliases: ["type", "partytype", "direction", "role"],
      help:
        "customer or vendor. Part of the identity, not a label — the same firm " +
        "can legitimately be both, and they are two rows.",
    },
    {
      field: "legalName",
      header: "Legal name",
      kind: "text",
      required: true,
      maxLength: 255,
      aliases: ["name", "party", "legalname", "registeredname", "companyname"],
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
        "Fifteen characters. Leave blank for an unregistered or overseas party — " +
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
   * ⚠️ SIX FLAT COLUMNS FOLD INTO ONE `address` OBJECT.
   *
   * `gst_parties.address` is `jsonb`. A CSV cannot express that, and
   * asking a customer to paste JSON into a spreadsheet cell is not an
   * import feature. This is the entire reason `buildPayload` exists as a
   * member of the entity definition rather than the framework doing
   * `{ ...values }` and calling it done — an entity whose storage shape
   * differs from its spreadsheet shape is the normal case, not the
   * exception.
   *
   * ⚠️ AND THE ADDRESS IS OMITTED ENTIRELY WHEN EVERY PART IS BLANK,
   * rather than sent as `{}`. On an update, `{}` would overwrite an
   * address already on the record with nothing — so importing a file that
   * simply has no address columns would ERASE addresses. Absent means
   * "not supplied"; that distinction is what `blankIsNull` in
   * `values.ts` exists to preserve, and it has to survive this far.
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
      partyType: values.partyType,
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

  schema: upsertPartySchema,

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE KEY IS `(party_type, gstin)`, WHICH IS THE INDEX THE DATABASE
   *    ALREADY HAS.
   * ══════════════════════════════════════════════════════════════════
   * `gst_parties_gstin_type_unique` is
   * `UNIQUE (tenant_id, party_type, gstin) WHERE gstin IS NOT NULL AND is_active`.
   * The party type is IN the key because the same firm can be a customer
   * and a vendor at once — `db/schema/gst.ts` gives the example: a builder
   * buys cement from a company it also sells a shop to. Keying on the
   * GSTIN alone would make the vendor row and the customer row look like
   * duplicates of each other, and under `update` the second import would
   * overwrite one with the other.
   *
   * ⚠️ THE GSTIN IS UPPER-CASED BY THE SCHEMA BEFORE IT REACHES HERE, so
   * this compares what the database will actually store. Lower-casing the
   * key would be wrong: `27AAAAA0000A1Z5` and `27aaaaa0000a1z5` are the
   * same registration and the schema has already settled which spelling
   * wins.
   *
   * ⚠️ THE UNREGISTERED FALLBACK IS `(party_type, legal_name)` AND IT IS
   * GENUINELY WEAK. An unregistered party has no identifier — that is
   * what "unregistered" means — so a name is all there is. Two different
   * one-off vendors with the same name will look like one party. That is
   * still better than the alternative, which is that every unregistered
   * party duplicates on every re-run; and `skip` mode makes the weak
   * match harmless, which is why the wizard recommends it.
   */
  naturalKey: (parsed) => {
    const partyType = typeof parsed.partyType === "string" ? parsed.partyType : "";
    const gstin = typeof parsed.gstin === "string" ? parsed.gstin.trim() : "";
    if (gstin !== "") {
      return {
        kind: "gstin",
        value: `${partyType}|${gstin}`,
        label: `GSTIN ${gstin} as a ${partyType}`,
      };
    }
    const legalName = typeof parsed.legalName === "string" ? parsed.legalName.trim() : "";
    if (legalName === "") return null;
    return {
      kind: "legalName",
      value: `${partyType}|${legalName.toLowerCase().replace(/\s+/g, " ")}`,
      label: `name "${legalName}" as a ${partyType}`,
    };
  },

  rowLabel: (parsed) =>
    typeof parsed.legalName === "string" ? parsed.legalName : "(no name)",

  /**
   * ⭐⭐ TRACK M1 — THE CONTRACT.
   *
   * ⚠️ NOTE HOW LITTLE OF THIS RESEMBLES `companies`, WHICH IS THE POINT
   * OF HAVING WRITTEN BOTH.
   */
  contract: {
    dependsOn: [],
    /**
     * 🔴 `restore-prior` FOR THE SAME REASON AS `companies` — this entity
     * offers `update` — but with a materially sharper consequence. A GST
     * party carries the registration a customer's invoices are raised
     * against. Overwriting one and then deleting it on undo would leave
     * invoices pointing at a party that no longer exists, in a system of
     * record an assessing officer may later read.
     */
    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      escapes:
        "A party overwritten in `update` mode may already have been quoted on invoices raised between the import and the undo. Restoring the party's prior values does not restate those invoices, which captured their GST details at issue and are deliberately immutable.",
      because:
        "`update` is offered, so a run can rewrite a registration that pre-dates the migration. The escape above is real and is shown before the run rather than discovered after it.",
    },
    provenance: { targets: ["gst_parties"], cardinality: "one-to-one" },
    requiredness: { structural: [], messages: {} },
    duplicateDecision: {
      recommended: "skip",
      because:
        "The natural key for an UNREGISTERED party is only its name and type, which is a weak match — two different one-off vendors with the same name look like one party. `skip` makes that weakness harmless; `update` would let the weak match overwrite the wrong record.",
    },
  },
};


/* ------------------------------------------------------------------ */
/* THE REGISTRY                                                        */
/* ------------------------------------------------------------------ */

export const IMPORT_ENTITIES = {
  companies: companiesEntity,
  "gst-parties": gstPartiesEntity,
} as const satisfies Record<string, ContractedImportEntity>;

export type ImportEntityKey = keyof typeof IMPORT_ENTITIES;

export const IMPORT_ENTITY_KEYS = Object.keys(IMPORT_ENTITIES) as ImportEntityKey[];

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ BATCH 58 — TWO LISTS FOR THE SCREENS, ONE ALLOWLIST FOR THE SERVER
 * ══════════════════════════════════════════════════════════════════════
 * `IMPORT_ENTITIES` is what the general import picker offers: lists you
 * load because you have them. The opening-balance entities are a one-time
 * migration with an ORDER to it, and they get their own screen — see the
 * note at the foot of `lib/import/opening-entities.ts`.
 *
 * ⚠️ BUT THERE IS EXACTLY ONE ALLOWLIST ON THE WRITE PATH, and it is this
 * one. Two registries the server switched between would be two places an
 * entity could be reachable from, and the second one is the one nobody
 * remembers to guard. `server/actions/import.ts` resolves through
 * `ALL_IMPORT_ENTITIES` and through `isImportEntityKey`, which is
 * membership in it — never a dynamic lookup on a caller's string.
 */
/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ TRACK M1 — THE ALLOWLIST IS ALSO WHERE THE CONTRACT IS REQUIRED
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TYPE CHANGED FROM `ImportEntityDefinition` TO
 *    `ContractedImportEntity`, AND THAT ONE-WORD CHANGE IS THE
 *    ENFORCEMENT.
 *
 * An entity is reachable from the server only by being in this map —
 * that is what the note above says and it is why `isImportEntityKey` is
 * membership in it rather than a dynamic lookup. Requiring the contract
 * HERE therefore means: an entity without a contract is an entity the
 * write path cannot reach. Not a lint. Not a convention. The same guard
 * that already stops a crafted entity string from reaching `users`.
 *
 * ⚠️ WHY THE OPENING ENTITIES ARE DECORATED RATHER THAN EDITED.
 * `opening-entities.ts` belongs to another track. Their four contracts
 * are declared in `contract/opening-policies.ts`, which this track owns,
 * and merged here. That file argues the case at length and asks to be
 * deleted once the owning track folds the objects into its own
 * definitions.
 *
 * 🔴 THIS MERGE CANNOT MAKE AN ENTITY REACHABLE. It only adds a member
 *    to an entity already present in `OPENING_IMPORT_ENTITIES`. A key
 *    that appears in `OPENING_CONTRACTS` and nowhere else contributes
 *    nothing at all — and `checkImportContract()` at CI gate 29 refuses
 *    that state rather than letting it sit, because a contract written
 *    for an entity that does not exist is a contract somebody believes
 *    is in force.
 */
const openingWithContracts = Object.fromEntries(
  Object.entries(OPENING_IMPORT_ENTITIES).map(([key, definition]) => [
    key,
    { ...definition, contract: OPENING_CONTRACTS[key as keyof typeof OPENING_CONTRACTS] },
  ]),
) as {
  [K in keyof typeof OPENING_IMPORT_ENTITIES]: ContractedImportEntity;
};

export const ALL_IMPORT_ENTITIES = {
  ...IMPORT_ENTITIES,
  /*
   * ⭐⭐ PHASE 8 , accounting and master data, declared in
   * `entities-accounting.ts` because ownership of THIS file is contested by
   * five phases at once. Five phases each adding one line is five clean
   * merges; five phases each rewriting it is five conflicts.
   */
  ...ACCOUNTING_IMPORT_ENTITIES,
  /* ⭐⭐ PHASE 4 , CRM. */
  ...CRM_IMPORT_ENTITIES,
  /* ⭐⭐ PHASE 5 , sales. */
  ...SALES_IMPORT_ENTITIES,
  /* ⭐⭐ PHASE 6 , purchases. */
  ...PURCHASE_IMPORT_ENTITIES,
  /* ⭐⭐ PHASE 7 , inventory. */
  ...INVENTORY_IMPORT_ENTITIES,
  ...openingWithContracts,
} as const satisfies Record<string, ContractedImportEntity>;

export type AnyImportEntityKey = keyof typeof ALL_IMPORT_ENTITIES;

/**
 * ⚠️ A TYPE GUARD, BECAUSE THE KEY ARRIVES FROM A BROWSER.
 *
 * `IMPORT_ENTITIES[input.entity]` on an unchecked string is a prototype
 * lookup away from returning `Object.prototype.constructor`. Checking
 * membership against the known keys first means an unrecognised value is
 * a refusal rather than an object with a `columns` property nobody meant.
 */
export function isImportEntityKey(value: unknown): value is AnyImportEntityKey {
  return typeof value === "string" && Object.hasOwn(ALL_IMPORT_ENTITIES, value);
}
