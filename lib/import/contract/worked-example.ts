/**
 * Ordence — ⭐⭐ WHAT A COMPLETE ENTITY LOOKS LIKE UNDER THE CONTRACT
 * Version: v1.84.0-alpha · Track M1
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE DELIVERABLE. THE TYPES ARE THE SUPPORTING MATERIAL.
 * ══════════════════════════════════════════════════════════════════════
 * Six tracks are about to write roughly twenty entity definitions
 * against the contract in `lib/import/types.ts`. A contract nobody can
 * follow is a contract that gets six different interpretations, and the
 * cost of that shows up months later as six subtly different undos.
 *
 * So: one entity, expressed completely, with the reasoning left in.
 *
 * ⚠️ AND IT IS DELIBERATELY NOT `companies`. The upgraded `companies`
 * definition in `entities.ts` is the boring case — self-contained, no
 * lookups, nothing structurally required — and copying it teaches
 * nothing about the twenty entities still to come, all of which refer to
 * something else. Contacts refer to companies. That single fact
 * exercises `dependsOn`, `lookups` and `requiredness` together, and the
 * interaction between those three is where the mistakes will be.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT IN `ALL_IMPORT_ENTITIES`, AND WHY THAT IS NOT A
 *    HALF-FINISHED JOB
 * ══════════════════════════════════════════════════════════════════════
 * The write path has no `contacts` branch. `writeRow` and
 * `findExistingByNaturalKey` in `server/actions/import.ts` dispatch on
 * `entity.table` with `if` chains, so an unhandled destination compiles
 * cleanly and falls through at runtime. Registering this entity would
 * put it in the customer's picker and let them upload a file that goes
 * nowhere.
 *
 * ⚠️ THAT FILE IS NOT THIS TRACK'S TO EDIT, and the three changes it
 * needs are written out as paste-ready code in `PATCH-REQUEST-M1.md`.
 * Until they land, this entity is a reference and a test fixture, and
 * `PendingImportTableKey` in `types.ts` is the marker saying so.
 *
 * ⭐ THE GENERAL LESSON FOR THE SIX TRACKS BEHIND THIS ONE: the contract
 * removes the guesswork from DEFINING an entity. It does not remove the
 * write-path branch. Budget for that branch in every entity you plan,
 * and do not register an entity whose branch is not there.
 */

import { createContactSchema } from "@/lib/validators/crm";
import type { PendingImportEntity } from "../types";

/* ------------------------------------------------------------------ */
/* ⭐⭐ CONTACTS — TRACK M1's WORKED EXAMPLE 2 OF 2                      */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * IF YOU ARE ONE OF THE SIX TRACKS ADDING ENTITIES, COPY THE SHAPE OF
 * THIS ONE, NOT OF `companies`.
 * ══════════════════════════════════════════════════════════════════════
 * `companies` is the boring case and it is above so the contract is
 * legible in isolation. This is the case that actually looks like the
 * twenty entities still to be written: it refers to something else, that
 * reference can fail, and the failure has to be visible in the PREVIEW
 * rather than at the write.
 *
 * Three things happen here that do not happen anywhere above:
 *
 * ① `dependsOn` is non-empty, so contacts land in wave 1 and companies
 *    in wave 0, and `resolveImportOrder()` says so without anybody
 *    hard-coding a list.
 *
 * ② `lookups` resolves a company BY NAME into `companyId`, once for the
 *    whole file, before either run writes anything.
 *
 * ③ `requiredness.structural` is EMPTY even though there is a lookup —
 *    and that combination is the one worth understanding. A contact with
 *    no company is a real contact; the lookup only has to succeed for
 *    rows that NAME a company. Compare `opening-customer-invoices`,
 *    where the identical lookup shape IS structural, because an invoice
 *    owed by nobody is not an invoice.
 *
 * ⚠️ THE SCHEMA IS `createContactSchema`, THE ONE THE FORM USES. Not a
 * copy, not an import variant. Same rule as everywhere else in this file.
 */
export const CONTACTS_WORKED_EXAMPLE: PendingImportEntity = {
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
   * ⚠️ `companyName` IS DELIBERATELY NOT IN THE PAYLOAD. It is an input
   * to the lookup, not a field on a contact — `createContactSchema` has
   * no such member and would strip it anyway. Passing it through would
   * put a value in the payload that nothing reads, which is how a field
   * survives a rename on one side only.
   */
  buildPayload: (values) => ({
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

  schema: createContactSchema,

  /**
   * ⚠️ EMAIL WHEN THERE IS ONE, OTHERWISE NAME PLUS COMPANY, AND THE
   * FALLBACK IS WEAK ON PURPOSE.
   *
   * An email address identifies a person. A name does not — this product
   * will hold several Rajesh Kumars — so the fallback qualifies the name
   * with the company, which is the best available discriminator and is
   * still not a good one. That weakness is why `skip` is recommended:
   * under `skip` a wrong match costs a row that was not imported, and
   * under `update` it costs a person's record overwritten with somebody
   * else's details.
   *
   * ⚠️ THE COMPANY IN THE FALLBACK KEY IS THE RAW NAME, not the resolved
   * id. `naturalKey` runs on the parsed payload, before lookups resolve,
   * and reaching for the id here would read a field that is not yet set —
   * which would silently key every row on `undefined` and collapse the
   * whole file onto one match. The name is what is available and it is
   * what the customer's two files agree on anyway.
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
   * contributes no lookup at all, which is what makes the unresolved
   * case reportable rather than universal — every row demanding a
   * company would refuse the legitimate independent contact.
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
     * 🔴 THE FIRST NON-EMPTY `dependsOn` IN THE PRODUCT.
     *
     * ⚠️ AND IT IS `hard` EVEN THOUGH THE COLUMN IS OPTIONAL. The
     * strength is about what happens to the FILE, not to a field. A
     * contacts export out of any real CRM has the company on almost
     * every row; loading it before the companies means almost every row
     * comes back with an unresolved lookup. That the odd independent
     * contact would have survived is not a reason to call the dependency
     * soft — it is a reason the wave-zero customer sees no errors at all.
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
     * ⚠️ EMPTY, AND THIS IS THE INSTRUCTIVE PART OF THE WHOLE EXAMPLE.
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
     * an invoice. The difference is not in the mechanism. It is a
     * judgement about the entity, which is why it has to be declared and
     * cannot be derived.
     */
    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "Where a contact has no email the match falls back to name plus company, which is weak — this product will hold several people with the same name. Under `skip` a wrong match costs you a row that was not imported. Under `update` it costs you one person's record overwritten with another's.",
    },
  },
};
