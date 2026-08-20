/**
 * Ordence — ⭐⭐ IMPORT ENTITIES: CRM
 * Version: v1.85.0-alpha · Phase 4
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS IN HERE, AND WHAT IS DELIBERATELY NOT
 * ══════════════════════════════════════════════════════════════════════
 * Phase 4 was briefed with five entities: `contacts`, `leads`, `deals`,
 * `activities` and `notes`. Two are here. Three are not, and the reason
 * is the same rule in all three cases — step 1 of the phase brief:
 *
 *   "Find the existing validator. If there is no schema for this thing,
 *    the entity is not ready and you should say so in your report rather
 *    than writing one. A schema written for the importer is by definition
 *    not the one the form uses."
 *
 *   · `deals`      — there is NO create/update schema for a deal anywhere
 *                    in the product. `server/actions/deals.ts` is reads
 *                    only, and its own header says so; the single deal
 *                    write in the codebase is `ordence_update_deal_stage`
 *                    in `server/mcp/dispatch.ts`, which parses nothing
 *                    and casts a raw string into the enum. There is no
 *                    schema to be the same as.
 *   · `activities` — a schema exists (`logSchema` in
 *                    `server/actions/activities.ts`) and it is the right
 *                    one, but it is a module-private const inside a
 *                    `"use server"` file. Exporting it would publish a
 *                    non-async export from a `"use server"` module, which
 *                    that file's own header forbids in its first line.
 *                    It has to MOVE, and that file is not ours.
 *   · `notes`      — there is no `notes` table. `ordence_create_note`
 *                    writes an `audit_logs` row with
 *                    `resourceType: "note"`. An importer cannot have a
 *                    destination the schema does not have.
 *
 * ⚠️ ALL THREE ARE WRITTEN UP IN `TRACK-REPORT.md` WITH THE COMMAND THAT
 * SHOWS IT, and the two that are one edit away have their edit written
 * out in `PATCH-REQUEST-PHASE-4.md`. Writing an import-only schema for
 * any of them would have produced three entities that validate
 * differently from the product they load data into, which is the exact
 * thing rule 6 exists to stop.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT A REGISTRY AND MUST NOT BECOME ONE
 * ══════════════════════════════════════════════════════════════════════
 * `ALL_IMPORT_ENTITIES` in `lib/import/entities.ts` is the single
 * allowlist on the write path and `isImportEntityKey` is membership in
 * it. This file exports ONE map that is spread into it by a single line,
 * applied by integration from `PATCH-REQUEST-PHASE-4.md`. Nothing here is
 * consulted at run time; five phases each adding one line to that file is
 * five clean merges, five phases each rewriting it is five conflicts.
 *
 * ⚠️ NO DATABASE IMPORT. Same rule as the rest of `lib/import/`: the
 * entity names its destination with a string discriminant, the writer in
 * `server/import/writers/crm/` does the SQL. That purity is what lets the
 * client wizard build a blank template from this file.
 */

import { createContactSchema } from "@/lib/validators/crm";
import { createLeadRefined } from "@/lib/validators/sales";
import { fromMinorUnits } from "@/lib/validators/accounting";
import type { ContractedImportEntity } from "./types";

/* ------------------------------------------------------------------ */
/* CONTACTS                                                            */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS IS TRACK M1's WORKED EXAMPLE, FINISHED.
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/contract/worked-example.ts` held this entity fully
 * contracted and deliberately unregistered, because the write path had no
 * `contacts` branch and registering it would have put a destination in
 * the customer's picker that silently wrote nothing — or, before Phase 1,
 * wrote a GST PARTY, `gst_parties` being the unguarded code after the
 * last `if`.
 *
 * ⭐ WHAT CHANGED IS NOT THIS DEFINITION. It is `server/import/writers/
 * crm/contacts.ts`, which makes the destination real, and the registry
 * entry that makes omitting it a compile error. The definition below is
 * M1's, moved verbatim apart from its `table` type and the comments that
 * described it as pending, because a "port" that also edits behaviour is
 * a port nobody can review.
 *
 * 🔴 AND `PendingImportTableKey` GOES WITH IT. M1 called that type a debt
 * marker whose goal is to be empty; `"contacts"` was its only member, so
 * the type is deleted rather than emptied — an empty union type is an
 * invitation to add to it. The deletion is in the patch request because
 * `lib/import/types.ts` is not this phase's file.
 */
const contacts: ContractedImportEntity = {
  key: "contacts",
  label: "Contacts",
  noun: { one: "contact", many: "contacts" },
  description:
    "The people at the organisations you deal with. Load your companies first so contacts can be linked to them.",
  table: "contacts",
  feature: "crm.contacts",
  createPermission: "contacts:create",
  updatePermission: "contacts:update",

  columns: [
    {
      field: "firstName",
      header: "First name",
      kind: "text",
      required: true,
      maxLength: 100,
      aliases: ["first", "firstname", "givenname", "forename", "name"],
      help: "The only column that must be present.",
    },
    {
      field: "lastName",
      header: "Last name",
      kind: "text",
      required: false,
      maxLength: 100,
      aliases: ["last", "lastname", "surname", "familyname"],
      help: "Optional. Many exports carry a single full-name column instead.",
    },
    {
      field: "email",
      header: "Email",
      kind: "text",
      required: false,
      maxLength: 320,
      aliases: ["emailaddress", "mail", "primaryemail", "workemail"],
      help:
        "Where present this is what a re-import matches on, so a second " +
        "upload updates the person rather than adding them again.",
    },
    {
      field: "phone",
      header: "Phone",
      kind: "text",
      required: false,
      maxLength: 40,
      aliases: ["telephone", "landline", "worknumber"],
      help: "Kept as written, including extensions and country codes.",
    },
    {
      field: "mobile",
      header: "Mobile",
      kind: "text",
      required: false,
      maxLength: 40,
      aliases: ["cell", "cellphone", "mobilenumber", "handphone"],
      help: "Kept as written.",
    },
    {
      field: "jobTitle",
      header: "Job title",
      kind: "text",
      required: false,
      maxLength: 150,
      aliases: ["title", "designation", "role", "position"],
      help: "Free text.",
    },
    {
      field: "department",
      header: "Department",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["dept", "division", "team"],
      help: "Free text.",
    },
    {
      field: "linkedinUrl",
      header: "LinkedIn",
      kind: "text",
      required: false,
      maxLength: 512,
      aliases: ["linkedin", "linkedinprofile", "li"],
      help: "A full URL including https://.",
    },
    {
      /**
       * ⚠️ A NAME, NOT AN ID, AND THE FIELD IS `companyName` RATHER THAN
       * `companyId`. Nobody's export carries our uuids. The name is what
       * the customer's old system holds, and `lookups` below turns it
       * into an id once for the whole file.
       */
      field: "companyName",
      header: "Company",
      kind: "text",
      required: false,
      maxLength: 255,
      aliases: ["company", "organisation", "organization", "account", "employer", "firm"],
      help:
        "The organisation this person works at, spelled as it is in your " +
        "companies list. Leave blank for a contact who belongs to nobody.",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 10_000,
      aliases: ["comments", "remarks", "description"],
      help: "Free text.",
    },
  ],

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 `companyName` IS IN THE PAYLOAD, AND M1's WORKED EXAMPLE SAID IT
   *    MUST NOT BE. THE WORKED EXAMPLE WAS WRONG, AND ONLY EXECUTION
   *    SHOWED IT.
   * ══════════════════════════════════════════════════════════════════
   * The original reasoning reads well: the company name is an input to
   * the lookup, not a field on a contact, and `createContactSchema` has
   * no such member and would strip it anyway.
   *
   * ⚠️ THE SECOND HALF OF THAT SENTENCE IS THE DEFECT. `lib/import/
   * plan.ts:337` calls `entity.lookups?.(parsedPayload)` — the payload
   * AFTER Zod, and a `z.object` strips unknown keys. So with the name
   * left out of `buildPayload`, `parsed.companyName` is `undefined` in
   * BOTH `lookups` and `naturalKey`, and the consequences are:
   *
   *   ① every row contributes NO lookup, so no contact is ever linked to
   *      a company and no unresolved company is ever reported. The
   *      import reports full success and quietly loses the association
   *      the customer's whole file was arranged around.
   *   ② the fallback natural key degrades from "name at company" to
   *      "name at nothing", so two different people with the same name
   *      at two different companies become one contact.
   *
   * Both were reported as passes by inspection and as failures by the
   * first test that ran the thing: `contacts` created 4 rows where the
   * preview had promised 3, because the row naming a company that does
   * not exist was never checked.
   *
   * ⭐ THE FIX IS THE SHAPE THE FOUR OPENING ENTITIES ALREADY USE.
   * `opening-customer-invoices` keeps `customerName` in its payload and
   * its schema declares it. This one cannot declare it — the schema is
   * the form's and the form has no such field — so the payload is passed
   * through instead. See `schema` below.
   */
  buildPayload: (values) => ({
    companyName: values.companyName,
    firstName: values.firstName,
    lastName: values.lastName,
    email: values.email,
    phone: values.phone,
    mobile: values.mobile,
    jobTitle: values.jobTitle,
    department: values.department,
    linkedinUrl: values.linkedinUrl,
    notes: values.notes,
    customFields: {},
  }),

  /**
   * 🔴 `.passthrough()`, AND IT IS NOT A LOOSENING.
   *
   * The schema is still `createContactSchema` — the same object
   * `createContact()` parses, with every rule it carries. `z.object`
   * defaults to STRIPPING unknown keys, and `.passthrough()` changes
   * only that: nothing is validated differently, nothing is permitted
   * that was refused, no field becomes optional. What it buys is that
   * `companyName` survives Zod so `lookups` and `naturalKey` can read
   * it, which they are documented to do and — before this — could not.
   *
   * ⚠️ THE THREE ALTERNATIVES, AND WHY EACH IS WORSE:
   *   · a copy of the schema with `companyName` added — rule 6, the copy
   *     that drifts the first time the form changes;
   *   · adding `companyName` to `createContactSchema` itself — a field
   *     on the contact FORM that the form does not have, in a file this
   *     phase does not own;
   *   · leaving it out — the two silent failures described above.
   *
   * ⚠️ THE EXTRA KEY REACHES `writeRow`, WHICH IGNORES IT. The writer
   * names every column it sets; it does not spread the payload. A future
   * writer that spreads would insert a `companyName` column that does
   * not exist and fail loudly at the first row, which is the acceptable
   * direction for that mistake to fail in.
   */
  schema: createContactSchema.passthrough(),

  /**
   * ⚠️ EMAIL WHEN THERE IS ONE, OTHERWISE NAME PLUS COMPANY, AND THE
   * FALLBACK IS WEAK ON PURPOSE.
   *
   * An email address identifies a person. A name does not — this product
   * will hold several Rajesh Kumars — so the fallback qualifies the name
   * with the company, which is the best available discriminator and is
   * still not a good one. That weakness is why `skip` is recommended.
   *
   * ⚠️ THE COMPANY IN THE FALLBACK KEY IS THE RAW NAME, not the resolved
   * id. `naturalKey` runs on the parsed payload, before lookups resolve,
   * and reaching for the id here would read a field that is not yet set —
   * which would silently key every row on `undefined` and collapse the
   * whole file onto one match.
   */
  naturalKey: (parsed) => {
    const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
    if (email !== "") {
      return { kind: "email", value: email, label: `email ${email}` };
    }
    const first = typeof parsed.firstName === "string" ? parsed.firstName.trim() : "";
    const last = typeof parsed.lastName === "string" ? parsed.lastName.trim() : "";
    const full = `${first} ${last}`.trim().toLowerCase().replace(/\s+/g, " ");
    if (full === "") return null;
    const company =
      typeof parsed.companyName === "string"
        ? parsed.companyName.trim().toLowerCase().replace(/\s+/g, " ")
        : "";
    return {
      kind: "nameCompany",
      value: `${full}|${company}`,
      label: company === "" ? `name "${full}"` : `name "${full}" at ${company}`,
    };
  },

  rowLabel: (parsed) => {
    const first = typeof parsed.firstName === "string" ? parsed.firstName : "";
    const last = typeof parsed.lastName === "string" ? parsed.lastName : "";
    const full = `${first} ${last}`.trim();
    return full === "" ? "(no name)" : full;
  },

  /**
   * 🔴 ONLY WHEN A COMPANY IS NAMED. A row with a blank company
   * contributes no lookup at all, which is what makes the unresolved case
   * reportable rather than universal — every row demanding a company
   * would refuse the legitimate independent contact.
   */
  lookups: (parsed) => {
    const raw = typeof parsed.companyName === "string" ? parsed.companyName.trim() : "";
    if (raw === "") return [];
    return [
      {
        kind: "company_by_name" as const,
        value: raw.toLowerCase().replace(/\s+/g, " "),
        into: "companyId",
        missing: `No company named "${raw}" is in your workspace. Import your companies first, or correct the spelling here.`,
      },
    ];
  },

  duplicateModes: ["skip", "update", "fail"],
  duplicateRule:
    "Contacts are matched on email address where there is one, and otherwise on name together with company.",

  contract: {
    /**
     * 🔴 `hard` EVEN THOUGH THE COLUMN IS OPTIONAL. The strength is about
     * what happens to the FILE, not to a field. A contacts export out of
     * any real CRM has the company on almost every row; loading it before
     * the companies means almost every row comes back with an unresolved
     * lookup. That the odd independent contact would have survived is not
     * a reason to call the dependency soft.
     */
    dependsOn: [
      {
        entity: "companies",
        strength: "hard",
        because:
          "Contacts are linked to companies by name, so your companies list has to be in before the contacts that point at it.",
      },
    ],

    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      escapes: null,
      because:
        "`update` is offered, so a run can overwrite a contact record that pre-dates the migration and carries activity history. Deleting those on undo would destroy data the run never created.",
    },

    provenance: { targets: ["contacts"], cardinality: "one-to-one" },

    /**
     * ⚠️ EMPTY, AND THE COMBINATION IS THE INSTRUCTIVE PART.
     *
     * There is a lookup, the lookup can miss, and `companyId` is still
     * NOT structural — because a contact who belongs to no company is a
     * real contact, and refusing them would refuse every sole trader in
     * the file. An unresolved company here becomes an ordinary row error
     * carrying the `missing` sentence above, in both runs, from one call
     * site.
     *
     * Compare `opening-customer-invoices`, whose lookup has exactly this
     * shape and IS structural, because an invoice owed by nobody is not
     * an invoice. The difference is a judgement about the entity.
     */
    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "Where a contact has no email the match falls back to name plus company, which is weak — this product will hold several people with the same name. Under `skip` a wrong match costs you a row that was not imported. Under `update` it costs you one person's record overwritten with another's.",
    },
  },
};

/* ------------------------------------------------------------------ */
/* LEADS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCHEMA IS `createLeadRefined`, NOT `createLeadSchema`, AND THE
 *    DIFFERENCE IS ONE LINE THAT DECIDES WHETHER THE ROW IS A LEAD
 * ══════════════════════════════════════════════════════════════════════
 * `createLead()` in `server/actions/sales-leads.ts` parses
 * `createLeadSchema` and then, four lines later, hand-checks the rule the
 * refinement states:
 *
 *     if (!data.email?.trim() && !data.phone?.trim()) return salesFail(
 *       "Add a phone number or an email address — a lead you cannot
 *        reach is not a lead.")
 *
 * `createLeadRefined` is that same schema object carrying that same rule
 * with that same sentence. Using the bare schema here would give the
 * importer a validator LOOSER than the form's — the one shape rule 6
 * forbids — and it would write leads with no way to contact them, at
 * scale, which is the only way this defect ever appears.
 *
 * ⚠️ IT ALSO CARRIES THE RE-RUN GUARANTEE. `naturalKey` below keys on
 * email, then on phone. A row with neither has no key, and a keyless row
 * is created again on every re-run. The refinement is what makes that
 * case impossible rather than merely unlikely: a row with neither never
 * reaches the write in either run.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ FIVE COLUMNS OF THE SCHEMA ARE NOT OFFERED, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * `projectId`, `ownerId` and `channelPartnerId` are uuids. Nobody's
 * export carries our uuids, so a column for one would be a column that is
 * always blank or always wrong; the honest way to offer them is a
 * `lookups` kind resolving a project code or a partner code, and
 * `ImportLookupKind` lives in `lib/import/types.ts`, which this phase
 * does not own. The three are named in `PATCH-REQUEST-PHASE-4.md` as the
 * follow-up rather than half-built here.
 *
 * `latitude` and `longitude` are floating-point degrees and there is no
 * float column kind — `integer` would silently truncate 19.076 to 19,
 * which is a point 8km away and still inside Mumbai, so nothing would
 * look wrong on the map. Refused rather than approximated.
 */
const leads: ContractedImportEntity = {
  key: "leads",
  label: "Leads",
  noun: { one: "lead", many: "leads" },
  description:
    "Enquiries you have not yet qualified — the top of your pipeline. A lead needs a phone number or an email address, because a lead you cannot reach is not a lead.",
  table: "leads",
  feature: "sales.pipeline",
  createPermission: "leads:create",
  updatePermission: "leads:update",

  columns: [
    {
      field: "name",
      header: "Name",
      kind: "text",
      required: true,
      maxLength: 255,
      aliases: ["leadname", "enquirername", "customername", "party", "fullname"],
      help: "Who enquired. The only column that must be present.",
    },
    {
      field: "email",
      header: "Email",
      kind: "text",
      required: false,
      maxLength: 320,
      aliases: ["emailaddress", "mail", "emailid"],
      help:
        "Where present this is what a re-import matches on, so a second " +
        "upload updates the enquiry rather than adding it again.",
    },
    {
      field: "phone",
      header: "Phone",
      kind: "text",
      required: false,
      maxLength: 32,
      aliases: ["mobile", "contactnumber", "cell", "whatsapp", "telephone"],
      help:
        "Kept as written. Matching ignores the formatting and uses the last " +
        "ten digits, so +91 98765 43210 and 09876543210 are the same person.",
    },
    {
      field: "source",
      header: "Source",
      kind: "enum",
      required: false,
      enumValues: [
        "website",
        "referral",
        "walk_in",
        "campaign",
        "portal",
        "nri_desk",
        "broker",
        "other",
      ],
      aliases: ["leadsource", "channel", "origin", "camefrom"],
      help: "Where the enquiry came from. Blank is treated as website.",
    },
    {
      field: "temperature",
      header: "Temperature",
      kind: "enum",
      required: false,
      enumValues: ["hot", "warm", "cold"],
      aliases: ["interest", "priority", "rating"],
      help: "How keen they are. Blank is treated as warm.",
    },
    {
      /**
       * ⚠️ RUPEES IN THE FILE, PAISE IN THE DATABASE, AND NEITHER OF
       * THOSE IS WHAT THE SCHEMA WANTS — see `buildPayload`.
       */
      field: "budgetMin",
      header: "Budget from",
      kind: "money",
      required: false,
      aliases: ["minbudget", "budgetlow", "budgetfrom", "budgetstart"],
      help: "The bottom of their range, in rupees. No symbol needed.",
    },
    {
      field: "budgetMax",
      header: "Budget to",
      kind: "money",
      required: false,
      aliases: ["maxbudget", "budgethigh", "budgetto", "budgetend", "budget"],
      help:
        "The top of their range, in rupees. The database refuses a maximum " +
        "below the minimum, which is the usual sign the two columns are swapped.",
    },
    {
      field: "requirement",
      header: "Requirement",
      kind: "text",
      required: false,
      maxLength: 4000,
      aliases: ["notes", "remarks", "enquiry", "message", "comments"],
      help: "What they asked for, in their words.",
    },
    {
      field: "locality",
      header: "Locality",
      kind: "text",
      required: false,
      maxLength: 160,
      aliases: ["area", "location", "neighbourhood", "neighborhood"],
      help: "The area they are looking in.",
    },
    {
      field: "isNri",
      header: "NRI",
      kind: "boolean",
      required: false,
      aliases: ["nri", "overseas", "nonresident"],
      help: "Yes for a buyer living outside India. Blank is treated as no.",
    },
    {
      field: "country",
      header: "Country",
      kind: "text",
      required: false,
      maxLength: 2,
      aliases: ["countrycode", "nation"],
      help: "Two letters, for example AE or US. Only meaningful for an NRI buyer.",
    },
    {
      field: "timezone",
      header: "Timezone",
      kind: "text",
      required: false,
      maxLength: 64,
      aliases: ["tz", "timezoneid"],
      help:
        'An IANA name such as America/New_York. This is what stops somebody ' +
        "ringing a buyer in New Jersey at 1:30am their time.",
    },
    {
      field: "preferredLang",
      header: "Language",
      kind: "text",
      required: false,
      maxLength: 8,
      aliases: ["language", "lang", "preferredlanguage"],
      help:
        "The language for demand notices and WhatsApp, as a short code such " +
        "as en, hi or mr. Blank is treated as en.",
    },
    {
      /**
       * 🔴 THE DPDP EVIDENCE COLUMN, AND IT IS OFFERED ON PURPOSE.
       *
       * Under the Digital Personal Data Protection Act contacting someone
       * about a property needs a lawful basis, and `consent_source` is
       * the evidence. A migration is exactly the moment that evidence is
       * lost: ten thousand leads arrive from a system that recorded it,
       * land here with the column blank, and the workspace now holds ten
       * thousand people it cannot show a basis for calling.
       *
       * ⚠️ `consent_at` IS NOT A COLUMN IN THIS FILE. `createLead()` sets
       * it to the moment of the write when a source is given, and the
       * importer does the same rather than accepting a date from the
       * spreadsheet: a consent timestamp typed into a CSV is evidence of
       * nothing, and back-dating it is worse than leaving it blank.
       */
      field: "consentSource",
      header: "Consent source",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["consent", "optin", "lawfulbasis", "consentevidence"],
      help:
        "Where their permission to be contacted came from — a form name, a " +
        "campaign, a signed sheet. Leave blank if you do not have it.",
    },
  ],

  /**
   * ⚠️ THE MONEY GOES OUT AS RUPEES, AND THAT IS NOT A LAPSE.
   *
   * `coerceMoneyMinor` hands `buildPayload` a string of PAISE, because
   * the preview report is JSON and `JSON.stringify` throws on a bigint.
   * `createLeadSchema` takes `budgetMin` as a rupee string matching
   * /^\d{1,15}(\.\d{1,2})?$/ and calls `toMinorUnits` on it itself.
   *
   * So the paise are converted back with `fromMinorUnits`, the schema's
   * own regex judges the result, and `toMinorUnits` inside the action's
   * validator turns it into the bigint the column holds. Skipping the
   * round trip — passing paise to a schema expecting rupees — would
   * multiply every budget in the file by a hundred and pass every check
   * on the way, because 450000000 is a perfectly valid amount.
   *
   * ⚠️ AND `undefined` RATHER THAN `null` FOR THE THREE DEFAULTED
   * MEMBERS. `source`, `temperature` and `isNri` carry Zod defaults; an
   * explicit `null` defeats a default and fails the enum instead of
   * falling back to "website", "warm" and false.
   */
  buildPayload: (values) => {
    const money = (raw: unknown): string | undefined =>
      typeof raw === "string" && raw.trim() !== "" ? fromMinorUnits(BigInt(raw)) : undefined;

    return {
      name: values.name,
      email: values.email,
      phone: values.phone,
      preferredLang: values.preferredLang,
      source: values.source ?? undefined,
      temperature: values.temperature ?? undefined,
      budgetMin: money(values.budgetMin),
      budgetMax: money(values.budgetMax),
      requirement: values.requirement,
      isNri: values.isNri ?? undefined,
      country: values.country,
      timezone: values.timezone,
      locality: values.locality,
      consentSource: values.consentSource,
      customFields: {},
    };
  },

  schema: createLeadRefined,

  /**
   * 🔴 EMAIL, THEN THE LAST TEN DIGITS OF THE PHONE. BOTH ARE STRONG,
   *    AND THE PHONE ONE IS THE ONE THE DATABASE ALREADY BELIEVES.
   *
   * `leads.phone_digits` is `GENERATED ALWAYS AS
   * right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'), 10)` and
   * `leads.email_key` is `lower(btrim(coalesce(email,'')))`. Both were
   * added because +91 98765 43210, 098765 43210 and 9876543210 are the
   * same man and a match on the raw text finds none of them.
   *
   * ⚠️ SO THE KEY IS COMPUTED THE SAME WAY HERE, IN TYPESCRIPT, AND THE
   * WRITER COMPARES IT AGAINST THE GENERATED COLUMN RATHER THAN AGAINST
   * `phone`. Two normalisations that must agree are one normalisation
   * more than is safe; this one defers to the database's, which cannot be
   * forgotten by a future write path because the column computes itself.
   *
   * ⚠️ A PHONE WITH FEWER THAN TEN DIGITS IS NOT A KEY. `right(x, 10)` of
   * "1234" is "1234", so a four-digit extension typed into the phone
   * column would key every such row onto each other and collapse a
   * hundred distinct leads onto one. Below ten digits the phone is kept
   * as data and ignored as a key, and the row falls through to no key at
   * all — which `createLeadRefined` has already made impossible unless
   * there is an email.
   */
  naturalKey: (parsed) => {
    const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
    if (email !== "") {
      return { kind: "emailKey", value: email, label: `email ${email}` };
    }
    const digits =
      typeof parsed.phone === "string" ? parsed.phone.replace(/[^0-9]/g, "") : "";
    if (digits.length >= 10) {
      const last10 = digits.slice(-10);
      return { kind: "phoneDigits", value: last10, label: `phone ending ${last10}` };
    }
    return null;
  },

  rowLabel: (parsed) => (typeof parsed.name === "string" && parsed.name.trim() !== "" ? parsed.name : "(no name)"),

  duplicateModes: ["skip", "update", "fail"],
  duplicateRule:
    "Leads are matched on email address where there is one, and otherwise on the last ten digits of the phone number.",

  contract: {
    /**
     * ⚠️ EMPTY, AND IT IS A DECISION RATHER THAN AN OMISSION.
     *
     * A lead refers to nothing that must already exist. The three columns
     * that would have made it depend on something — project, owner,
     * channel partner — are the three deliberately not offered above, and
     * a dependency declared for a column nobody can fill would put
     * `leads` in wave 1 and tell every customer to load a projects file
     * first before importing enquiries that name no project.
     *
     * ⭐ SO LEADS LOAD IN WAVE 0, alongside companies, and a sales team
     * whose export is the first file they reach for — which the phase
     * brief warns is the normal case — is not blocked on anything.
     */
    dependsOn: [],

    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      escapes: null,
      because:
        "`update` is offered, so a run can overwrite a lead that pre-dates the migration and carries a score, a status, a channel-partner lock and a call history. Deleting those on undo would destroy data the run never created. Rows the run CREATED take their `lead_activities` history with them, because that table's foreign key to `leads` is ON DELETE CASCADE — nothing escapes an undo.",
    },

    provenance: { targets: ["leads"], cardinality: "one-to-one" },

    /**
     * ⚠️ EMPTY, FOR A DIFFERENT REASON THAN CONTACTS'.
     *
     * Contacts' emptiness is a judgement about an unresolved lookup.
     * Leads have no lookups at all, and the one rule that decides whether
     * a row is a lead — a phone or an email — is not expressible here:
     * `structural` is a list of fields, each independently required, and
     * "one of these two" is not a list. It lives in `createLeadRefined`,
     * which refuses the row in the PREVIEW with the sentence the form
     * uses, which is where it belongs.
     */
    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "A lead in your workspace has been worked on — it carries a score, a status and the notes of whoever called it. Under `skip` an enquiry you already have is left alone. Under `update` the row in your spreadsheet, which is usually the original enquiry, overwrites the version your team has since corrected.",
    },
  },
};

/* ------------------------------------------------------------------ */
/* THE MAP                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ONE EXPORT, ONE SPREAD, ONE LINE IN `entities.ts`.
 *
 * `satisfies` rather than an annotation, so the keys stay literal and
 * `AnyImportEntityKey` gains `"contacts"` and `"leads"` when this is
 * spread in — an annotation would widen the key type to `string` and
 * quietly take that away from `isImportEntityKey`'s callers.
 */
export const CRM_IMPORT_ENTITIES = {
  contacts,
  leads,
} as const satisfies Record<string, ContractedImportEntity>;

export type CrmImportEntityKey = keyof typeof CRM_IMPORT_ENTITIES;
