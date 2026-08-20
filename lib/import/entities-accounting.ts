/**
 * Ordence — ⭐⭐⭐ WHAT CAN BE IMPORTED: ACCOUNTING AND MASTER DATA
 * Version: v1.85.0-alpha · Phase 8
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE ENTITIES, AND FIVE THAT ARE DELIBERATELY NOT HERE
 * ══════════════════════════════════════════════════════════════════════
 * The phase brief lists eight. Three of them are below. The other five
 * are absent, each for a reason that is written out in `TRACK-REPORT.md`
 * and summarised at the foot of this file, because the brief's own first
 * instruction is the one that decides it:
 *
 *   *"Find the existing validator. If there is no schema for this thing,
 *    the entity is not ready and you should say so in your report rather
 *    than writing one. A schema written for the importer is by definition
 *    not the one the form uses."*
 *
 * ⚠️ AN ENTITY REGISTERED WITHOUT A DESTINATION THAT WORKS IS THE DEFECT
 * THIS PROJECT HAS FOUND MORE THAN THIRTY TIMES — built, offered in the
 * picker, unreachable. Three of the five have no destination table at
 * all: `grep`ping all 312 `pgTable(...)` declarations in `db/schema/`
 * returns nothing named `tax_codes`, `payment_terms` or
 * `numbering_series`. Writing the table, the form's schema and the
 * importer in one phase would mean the importer IS the form, which
 * inverts rule 6 rather than satisfying it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE FILE, ONE EXPORTED MAP, AND NO EDIT TO `entities.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Ownership of `lib/import/entities.ts` is contested by five phases at
 * once. This file exports one map; the single-line spread that merges it
 * into `ALL_IMPORT_ENTITIES` is in `PATCH-REQUEST-PHASE-8.md` for
 * integration to apply. Five phases each adding one line is five clean
 * merges; five phases each rewriting that file is five conflicts.
 *
 * 🔴 AND THIS MAP IS NOT A SECOND REGISTRY. It is never consulted on the
 *    write path. `ALL_IMPORT_ENTITIES` remains the single allowlist and
 *    `isImportEntityKey` remains membership in it; a key present here and
 *    absent there resolves to nothing at all.
 *
 * ⚠️ NO DATABASE IMPORT. Same rule as `entities.ts`: the schemas come
 * from `lib/validators/`, which is pure and is imported by the forms too.
 * That shared import is the mechanism that makes the import path and the
 * typing path the same rules rather than two sets that agree today.
 */

import { createLedgerSchema } from "@/lib/validators/accounting";
import { costCentreSchema } from "@/lib/validators/budgets";
import { createHsnSacSchema } from "@/lib/validators/gst";
import type { ContractedImportEntity } from "./types";

/* ------------------------------------------------------------------ */
/* SHARED                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ USED BY EVERY `rowLabel` HERE. A label is what the report calls the
 * row when something goes wrong with it, and a blank one turns a
 * failed-rows CSV into a list of anonymous failures.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/* ================================================================== */
/* 1 — THE CHART OF ACCOUNTS                                          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE KEYSTONE. READ THIS BEFORE THE OTHER TWO.
 * ══════════════════════════════════════════════════════════════════════
 * Until this entity existed the chart of accounts was not imported, and
 * two files in this repository said so in writing:
 *
 *   · `lib/import/contract/opening-policies.ts` gives `dependsOn: []` for
 *     `opening-trial-balance` and argues it: *"the chart of accounts is
 *     not imported — it is seeded when the workspace is created and
 *     edited in the product. So the file's prerequisite is a setup step
 *     rather than another import, and expressing it as a dependency on an
 *     entity that does not exist would put a permanent dangling key in
 *     the graph."*
 *
 *   · That argument was correct on the day it was written and this entity
 *     is what makes it false.
 *
 * ⭐ SO THE LOAD ORDER OF THE WHOLE PRODUCT MOVES. `opening-trial-balance`
 * was wave 0 — the control total everything else is measured against —
 * and it becomes wave 1, behind this. `opening-customer-invoices` and
 * `opening-vendor-bills`, which depend on the trial balance, move from
 * wave 1 to wave 2. That edit is one object in a file this phase does not
 * own and it is the FIRST item in `PATCH-REQUEST-PHASE-8.md`, flagged for
 * integration rather than applied quietly, because it is the one change
 * in the migration that moves every other track's wave number.
 *
 * ⚠️ WHY THIS IS WORTH THE DISRUPTION. Every line of an opening trial
 * balance names an account CODE and is refused in the preview when the
 * code is not found — `ledger_by_code`, resolved before the write. A
 * customer migrating from Tally has a chart of two hundred accounts and
 * a seeded workspace has perhaps twenty. Without this entity the first
 * thing a migration asks of a bookkeeper is to type a hundred and eighty
 * accounts into a form, one at a time, before the import they came here
 * for will accept a single line.
 */
const chartOfAccountsEntity: ContractedImportEntity = {
  key: "chart-of-accounts",
  label: "Chart of accounts",
  noun: { one: "account", many: "accounts" },
  description:
    "Every account your books are kept in, with its code and whether it is an " +
    "asset, a liability, equity, revenue or an expense. Load this before anything " +
    "else: every opening balance and every journal names an account by its code.",
  table: "ledgers",
  feature: "accounting.ledger",
  createPermission: "ledgers:create",
  updatePermission: "ledgers:update",

  columns: [
    {
      field: "code",
      header: "Account code",
      kind: "text",
      required: true,
      maxLength: 40,
      aliases: ["code", "accountcode", "glcode", "ledgercode", "accountno", "accountnumber", "gl"],
      help:
        "The code you already use, such as 1100. Letters, numbers, dot, dash and " +
        "underscore. This is what every other file matches an account on, so it " +
        "must be the same spelling you use in those files.",
    },
    {
      field: "name",
      header: "Account name",
      kind: "text",
      required: true,
      maxLength: 200,
      aliases: ["name", "accountname", "ledgername", "particulars", "description"],
      help: "What this account is called on your reports.",
    },
    {
      /**
       * 🔴 THE ONE COLUMN A CHART OF ACCOUNTS CANNOT BE IMPORTED WITHOUT,
       *    AND THE ONE MOST EXPORTS DO NOT HAVE.
       *
       * `accountType` decides the account's NORMAL BALANCE SIDE and which
       * statement it appears on. Getting it wrong does not fail: the
       * account is created, the opening balance posts to it, the trial
       * balance still balances, and a liability sits in the P&L as an
       * expense until somebody reads the accounts properly. There is no
       * error anywhere in that sequence.
       *
       * ⚠️ IT IS `required: true` AT THE HEADER LEVEL, which stops the run
       * before a single row is read rather than producing one error per
       * row. A file with no such column is not a chart of accounts we can
       * classify, and the honest thing is to say so once.
       */
      field: "accountType",
      header: "Account type",
      kind: "enum",
      required: true,
      enumValues: ["asset", "liability", "equity", "revenue", "expense"],
      aliases: ["type", "accounttype", "classification", "nature", "group", "headtype"],
      help:
        "One of: asset, liability, equity, revenue, expense. This decides which " +
        "statement the account appears on and which side its balance sits — it " +
        "cannot be guessed from the name and getting it wrong is silent.",
    },
    {
      /**
       * ⚠️ NOT THE SAME QUESTION AS `accountType`, AND THE TWO ARE
       * ROUTINELY CONFUSED. `accountType` is the accounting
       * classification; this is whose money it is. A trust bank account
       * and an operating bank account are both `asset`, and mixing them
       * is a regulatory breach rather than a reporting error — see the
       * header of `db/schema/accounting.ts`.
       */
      field: "type",
      header: "Fund type",
      kind: "enum",
      required: false,
      enumValues: ["operating", "trust", "escrow", "retention", "suspense"],
      aliases: ["fund", "fundtype", "ledgertype", "moneytype"],
      help:
        "operating (the firm's own money), trust or escrow (client money held on " +
        "trust), retention, or suspense. Leave blank for operating, which is most " +
        "accounts. Trust and escrow accounts are forced to require reconciliation.",
    },
    {
      field: "description",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 1_000,
      aliases: ["notes", "remarks", "comments", "narration"],
      help: "Free text. What this account is for, in your own words.",
    },
    {
      /**
       * ⚠️ THREE LETTERS, AND THE SCHEMA REFUSES ANYTHING ELSE RATHER
       * THAN TRUNCATING. `createLedgerSchema` has `.length(3)`, so "Rs"
       * and "Rupees" are both refused by name. That is right: a currency
       * silently coerced to the wrong code is a set of balances in a unit
       * nobody declared.
       */
      field: "currency",
      header: "Currency",
      kind: "text",
      required: false,
      maxLength: 3,
      aliases: ["ccy", "currencycode"],
      help: "Three-letter code such as INR. Leave blank for INR.",
    },
    {
      field: "requiresReconciliation",
      header: "Needs reconciliation",
      kind: "boolean",
      required: false,
      aliases: ["reconcile", "reconciliation", "bankreconciliation", "needsreconciliation"],
      help:
        "yes or no. Whether this account is reconciled against a statement. Trust " +
        "and escrow accounts are set to yes whatever this column says.",
    },
    /* ---- the bank block, folded into one object by buildPayload ---- */
    {
      field: "bankName",
      header: "Bank name",
      kind: "text",
      required: false,
      maxLength: 200,
      aliases: ["bank"],
      help: "Only for accounts that are a real bank account.",
    },
    {
      field: "bankAccountNumber",
      header: "Bank account number",
      kind: "text",
      required: false,
      maxLength: 40,
      aliases: ["accountnumberbank", "bankaccount", "bankaccountno"],
      help: "",
    },
    {
      field: "bankIfsc",
      header: "IFSC",
      kind: "text",
      required: false,
      maxLength: 20,
      aliases: ["ifsc", "ifsccode"],
      help: "",
    },
    {
      field: "bankBranch",
      header: "Branch",
      kind: "text",
      required: false,
      maxLength: 200,
      aliases: ["branch", "bankbranch"],
      help: "",
    },
    {
      field: "bankAccountHolder",
      header: "Account holder",
      kind: "text",
      required: false,
      maxLength: 200,
      aliases: ["accountholder", "holder", "inthenameof"],
      help: "",
    },
  ],

  /**
   * ⚠️ FIVE FLAT COLUMNS FOLD INTO ONE `bankDetails` OBJECT, and the
   * object is OMITTED ENTIRELY when every part is blank rather than sent
   * as `{}`.
   *
   * 🔴 THE DIFFERENCE MATTERS ON AN UPDATE. `createLedgerSchema` gives
   * `bankDetails` a `.default({})`, so an absent key becomes an empty
   * object and the writer would store it — erasing the IFSC and account
   * number already on a ledger, because the customer's file had no bank
   * columns in it. `gst-parties` makes exactly this argument about
   * addresses in `entities.ts` and it is the same mistake here with worse
   * consequences: those digits are what a payment is made against.
   *
   * ⚠️ SO THE WRITER, NOT THE SCHEMA, DECIDES. The payload carries
   * `bankDetails` only when at least one part was supplied, and
   * `ledgersWriter` writes the column only when the key is present. Both
   * halves are needed; the schema's default would otherwise reintroduce
   * it after this function has correctly left it out.
   */
  buildPayload: (values) => {
    const bank: Record<string, string> = {};
    const put = (key: string, field: string) => {
      const v = values[field];
      if (typeof v === "string" && v.trim() !== "") bank[key] = v;
    };
    put("bankName", "bankName");
    put("accountNumber", "bankAccountNumber");
    put("ifsc", "bankIfsc");
    put("branch", "bankBranch");
    put("accountHolder", "bankAccountHolder");

    /*
     * ⚠️ `undefined` AND NOT `null` FOR THE OPTIONAL ENUMS AND STRINGS.
     * A blank cell arrives as `null` (see `blankIsNull`), and
     * `z.enum([...]).default("operating")` refuses `null` outright — the
     * default only applies to an ABSENT key. A row with no fund type
     * would therefore fail with "Expected 'operating' | 'trust' | …,
     * received null", which is a refusal of a blank optional column.
     */
    const optional = (field: string): Record<string, unknown> => {
      const v = values[field];
      return v === null || v === undefined || v === "" ? {} : { [field]: v };
    };

    return {
      code: values.code,
      name: values.name,
      accountType: values.accountType,
      ...optional("type"),
      ...optional("description"),
      ...optional("currency"),
      ...optional("requiresReconciliation"),
      ...(Object.keys(bank).length > 0 ? { bankDetails: bank } : {}),
    };
  },

  /**
   * 🔴 THE SAME OBJECT `createLedger` PARSES, MOVED SO BOTH CAN REACH IT.
   *
   * It was declared inside `server/actions/accounting.ts`, which is
   * `"use server"` and may only export async functions — so it had one
   * possible caller and any second caller had to write a copy. The move
   * to `lib/validators/accounting.ts` is item 2 of the patch request and
   * changed none of the rules. See that file's note.
   */
  schema: createLedgerSchema,

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE CODE, COMPARED EXACTLY — NOT LOWER-CASED.
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ THIS IS THE OPPOSITE OF WHAT `companies` DOES, AND THE REASON IS
   * THE SAME REASON.
   *
   * `companies` lower-cases its domain key because the database's partial
   * unique index is what it must agree with, and that index is on the
   * domain. `ledgers_tenant_code_unique` is on `(tenant_id, code)` — the
   * raw column, no `upper()`, no `lower()` — and `createLedger` matches
   * with `eq(ledgers.code, data.code)`, also exact. So `1100` and `1100`
   * are one account and `Bank-A` and `BANK-A` are two, in the database
   * and therefore here.
   *
   * ⚠️ AND THE CONSEQUENCE IS NAMED RATHER THAN HIDDEN. A file whose
   * codes differ from the workspace's only in case will create a second
   * account rather than matching the first. That is what the database
   * does with the same two rows, so the alternative — matching
   * case-insensitively here — would mean the framework reports "1 update"
   * and Postgres performs 1 insert. The framework's idea of "the same
   * account" and the database's idea must not be allowed to disagree;
   * `entities.ts` makes that argument at length for `companies` and it
   * decides this the other way.
   *
   * ⚠️ WHITESPACE IS TRIMMED BY THE SCHEMA BEFORE IT REACHES HERE
   * (`z.string().trim()`), so a code with a trailing space from a
   * spreadsheet is already the code without it — in the key AND in what
   * is written, which is what stops those two from disagreeing.
   */
  naturalKey: (parsed) => {
    const code = typeof parsed.code === "string" ? parsed.code : "";
    if (code === "") return null;
    return { kind: "accountCode", value: code, label: `account code ${code}` };
  },

  rowLabel: (parsed) =>
    `${text(parsed.code, "?")} ${text(parsed.name, "(no name)")}`.trim(),

  duplicateRule:
    "Two rows are the same account when they have the same account code, compared " +
    "exactly as written — this is the rule your workspace's own index uses, so " +
    "codes differing only in upper and lower case are two different accounts here " +
    "and in your books.",

  /* ---------------------------------------------------------------- */
  /* ⭐⭐ TRACK M1 — THE CONTRACT                                       */
  /* ---------------------------------------------------------------- */

  contract: {
    /**
     * ⚠️ NOTHING, AND IT IS THE WHOLE POINT OF THE ENTITY.
     *
     * An account row is self-contained. That is what makes this wave 0
     * and what makes it able to be the prerequisite of everything else.
     *
     * 🔴 THE HIERARCHY IS THE ONE THING DELIBERATELY LEFT OUT, and it is
     *    left out because of the shape of the framework rather than lack
     *    of time. `ledgers.parent_ledger_id` exists and a real chart of
     *    accounts is a tree. Expressing it would mean a `parentCode`
     *    column resolved through `ledger_by_code` — and lookups resolve
     *    ONCE FOR THE WHOLE FILE, AGAINST THE DATABASE, BEFORE ANY ROW IS
     *    WRITTEN (`resolveLookups`). A parent that is on line 4 of the
     *    same file has not been written when line 40 is planned, so every
     *    child of a new parent would be refused in the preview with "that
     *    account was not found" — about a file that is completely correct.
     *
     *    Making it work needs the planner to order rows within a file,
     *    which it has no notion of and which is not this phase's to
     *    build. So the chart imports FLAT, the tree is set in the product
     *    afterwards, and this comment is here so the next author does not
     *    add the column and discover the reason by shipping it.
     */
    dependsOn: [],

    /**
     * 🔴 `restore-prior`, AND `delete` WOULD BE REFUSED BY GATE 29 ANYWAY
     *    BECAUSE `update` IS OFFERED — but it would be wrong here even if
     *    it were allowed, and for a reason `companies` does not have.
     *
     * ⚠️ AN ACCOUNT CANNOT BE DELETED ONCE IT HAS BEEN POSTED TO.
     * `journal_entries.ledger_id` is `ON DELETE RESTRICT`, and
     * `journal_entries` is append-only, so the rows holding an account in
     * place can never be removed either. An undo that tried to delete
     * would meet a foreign-key violation on exactly the accounts that
     * matter — the used ones — and leave the unused ones deleted. That is
     * the worst available outcome: a partial undo that looks like a full
     * one.
     */
    reversal: {
      kind: "restore-prior",
      /**
       * ⚠️ `"*"` — THE WHOLE ROW. Which columns an update writes depends
       * on which columns the customer's file has, so the set at risk is
       * not knowable here. One column must NOT be restored from the
       * import's idea of it and is not written by this writer at all:
       * `current_balance` is maintained by trigger on every posting and
       * is not the importer's to hold an opinion about.
       */
      capturePriorFields: ["*"],
      escapes:
        "An account that has been posted to cannot be removed, so an undo of a run " +
        "that CREATED accounts leaves the used ones in place and reports which. " +
        "Their cached balances stay as the postings left them: `current_balance` is " +
        "maintained by a database trigger and is not restored, because it is a fact " +
        "about the journal rather than about this row.",
      because:
        "`update` is offered, so a run can overwrite an account that pre-dates the " +
        "migration — carrying a description, a fund type and bank details somebody " +
        "set deliberately. Deleting those on undo would destroy data the run never " +
        "created; and `journal_entries.ledger_id` is ON DELETE RESTRICT, so the " +
        "delete would in any case succeed only for the accounts nobody had used.",
    },

    provenance: { targets: ["ledgers"], cardinality: "one-to-one" },

    /**
     * ⚠️ EMPTY, AND CHECKED RATHER THAN ASSUMED — WITH ONE CANDIDATE
     * CONSIDERED AND REJECTED IN WRITING.
     *
     * `accountType` is the field without which a row is not an account,
     * and it is the obvious thing to put here. It is not here because
     * `createLedgerSchema` already refuses it: `z.enum([...])` with no
     * `.optional()` fails a missing or blank value by name. Restating it
     * would be the second copy of a rule that `ImportRequiredness`'s own
     * documentation warns disagrees with the first the day the schema
     * moves — and this schema HAS just moved, in this phase.
     *
     * The distinction `requiredness` exists for — a field the schema
     * allows to be absent but without which the row is meaningless — has
     * no instance in this entity. Every such field is already refused.
     */
    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "The second upload of a chart of accounts is almost always the whole file " +
        "again after fixing a few rows, and `skip` makes that safe. `update` " +
        "rewrites accounts you already post to — and it can change an account's " +
        "TYPE, which moves it between the profit-and-loss account and the balance " +
        "sheet on every report you have ever run, retrospectively and silently. " +
        "Pick it only when the file is deliberately a correction, and note that it " +
        "needs a separate permission.",
    },
  },
};

/* ================================================================== */
/* 2 — COST CENTRES                                                   */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DEPARTMENTAL DIMENSION, AND WHY IT IS URGENT RATHER THAN TIDY
 * ══════════════════════════════════════════════════════════════════════
 * `journal_entries.cost_centre_id` is on the LINE and the table is
 * append-only. `db/schema/accounting.ts` states the consequence plainly:
 * a line coded to the wrong cost centre — or to none — is not fixed by an
 * UPDATE, because the trigger blocks UPDATE. It is fixed by reversing the
 * transaction and posting it again.
 *
 * 🔴 SO THE COST CENTRES MUST EXIST BEFORE THE HISTORY IS LOADED, NOT
 *    AFTER. A migration that loads a year of postings and then creates
 *    the departments has a year of postings in the unnamed bucket for
 *    ever, and re-grading them is a reversal and a re-post of every
 *    affected transaction rather than an afternoon's tidying.
 */
const costCentresEntity: ContractedImportEntity = {
  key: "cost-centres",
  label: "Cost centres",
  noun: { one: "cost centre", many: "cost centres" },
  description:
    "The departments, sites or projects you report costs against. Load these " +
    "before any postings: a journal line's cost centre is set when the line is " +
    "written and the ledger is append-only, so it cannot be added afterwards.",
  table: "cost_centres",
  /**
   * ⚠️ `accounting.ledger`, AND IT IS AN INHERITANCE RATHER THAN A
   * CHOICE. `server/actions/budgets.ts` calls no `requireFeature` at all
   * and guards cost centres with `ledgers:read` / `ledgers:create` /
   * `ledgers:update` — the accounting permissions, because a cost centre
   * is a dimension of the ledger and not a module of its own. `feature`
   * is a required member of an entity, so it names the feature those
   * permissions belong to. A workspace that can create ledgers can
   * create cost centres, which is the rule the product already applies.
   */
  feature: "accounting.ledger",
  createPermission: "ledgers:create",
  updatePermission: "ledgers:update",

  columns: [
    {
      field: "code",
      header: "Code",
      kind: "text",
      required: true,
      maxLength: 40,
      aliases: ["code", "costcentrecode", "ccode", "department", "departmentcode", "cc"],
      help:
        "The short handle you sort and group by — PROD, HO, SOUTH. Upper and lower " +
        "case are the same cost centre here, because two spellings of one " +
        "department split every report that groups by code without saying it split.",
    },
    {
      field: "name",
      header: "Name",
      kind: "text",
      required: true,
      maxLength: 200,
      aliases: ["name", "costcentrename", "departmentname", "title", "particulars"],
      help: "What this department is called on the reports.",
    },
    {
      field: "description",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 1_000,
      aliases: ["notes", "remarks", "comments"],
      help: "Free text.",
    },
    {
      field: "displayOrder",
      header: "Sort order",
      kind: "integer",
      required: false,
      bounds: { min: 0, max: 100_000 },
      aliases: ["order", "sortorder", "displayorder", "sequence", "sl", "slno"],
      help:
        "A whole number deciding the order on pickers and reports. Leave blank for " +
        "100; ties are broken by code.",
    },
  ],

  buildPayload: (values) => {
    /*
     * ⚠️ AN ABSENT `displayOrder` MUST STAY ABSENT rather than becoming
     * `null`. `z.number().default(100)` applies its default to a missing
     * key and REFUSES `null` — so passing the blank cell through as null
     * would fail every row of a file that simply has no sort column, with
     * "Expected number, received null" in the failed-rows CSV.
     */
    const out: Record<string, unknown> = {
      code: values.code,
      name: values.name,
    };
    if (typeof values.description === "string" && values.description.trim() !== "") {
      out.description = values.description;
    }
    if (typeof values.displayOrder === "number") out.displayOrder = values.displayOrder;
    return out;
  },

  /** The same object `createCostCentre` parses. See `lib/validators/budgets.ts`. */
  schema: costCentreSchema,

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 UPPER-CASED, BECAUSE THE UNIQUE INDEX IS ON `upper(code)`.
   * ══════════════════════════════════════════════════════════════════
   * `cost_centres_code_key` is `UNIQUE (tenant_id, upper(code))`, and
   * `createCostCentre` checks the clash with
   * `upper(code) = upper(:code)`. So "prod" and "PROD" are ONE cost
   * centre to the database, and keying on the raw string here would mean
   * the preview reports a creation that Postgres then refuses with a
   * unique violation halfway through the file.
   *
   * ⚠️ NOTE HOW THIS DIFFERS FROM `chart-of-accounts` TWENTY LINES UP,
   * WHICH KEYS EXACTLY. Neither is a style preference. Each matches the
   * index its own table actually has, and the two tables genuinely
   * disagree — `ledgers` has no `upper()` in its index and
   * `cost_centres` does. Copying either rule to the other table would
   * produce a framework whose idea of "the same thing" is not the
   * database's, which is the failure `entities.ts` sets out at length.
   */
  naturalKey: (parsed) => {
    const code = typeof parsed.code === "string" ? parsed.code : "";
    if (code === "") return null;
    return {
      kind: "costCentreCode",
      value: code.toUpperCase(),
      label: `code ${code.toUpperCase()}`,
    };
  },

  rowLabel: (parsed) => `${text(parsed.code, "?")} ${text(parsed.name, "(no name)")}`.trim(),

  duplicateRule:
    "Two rows are the same cost centre when their codes match ignoring upper and " +
    "lower case — the rule your workspace's own index uses, because one department " +
    "spelled two ways splits every report that groups by code.",

  contract: {
    dependsOn: [],

    /**
     * 🔴 `restore-prior`. `update` is offered, and a cost centre carries
     *    a name that appears as a column heading on every departmental
     *    report ever produced.
     *
     * ⚠️ AND THE ROWS CANNOT BE DELETED AT ALL ONCE USED. There is no
     * `deleted_at` on this table — deliberately, and
     * `db/schema/budgets.ts` explains why at length: a cost centre that
     * has been posted to is referenced by append-only journal lines that
     * can never be re-coded, so removing it turns last year's
     * departmental profit-and-loss into a column headed by a UUID. The
     * database refuses the delete outright (composite FK, ON DELETE
     * RESTRICT). `is_active = false` is what "we do not use that
     * department any more" means, and it is the strongest undo available
     * for a cost centre that has been used.
     */
    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      escapes:
        "A cost centre that a journal line already points at cannot be removed — " +
        "the database refuses it and the lines are append-only. An undo of a run " +
        "that created cost centres can only archive those, so they disappear from " +
        "the pickers and stay on the reports, which is what the product means by " +
        "retiring one.",
      because:
        "`update` is offered, so a run can rewrite the name and sort order of a " +
        "department that pre-dates the migration, and that name is the heading on " +
        "every report it appears in. Deleting on undo is not merely wrong here, it " +
        "is impossible for any cost centre that has been used.",
    },

    provenance: { targets: ["cost_centres"], cardinality: "one-to-one" },

    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "A department list is short and is usually loaded once. `skip` makes a " +
        "second upload of the same file harmless. `update` rewrites the names of " +
        "departments your existing reports are already headed by — pick it only " +
        "when the file is deliberately a renaming.",
    },
  },
};

/* ================================================================== */
/* 3 — TAX CODES (HSN AND SAC)                                        */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IMPORTS THE CODES AND NOT THE RATES, AND THE SPLIT IS THE
 *    PRODUCT'S MOST CAREFULLY ARGUED DESIGN DECISION.
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/gst.ts` sets out, in four defences, why a rate is a fact
 * about a PERIOD and never a property of a code: under-construction
 * residential property was 12% with credit until 31 March 2019 and 5%
 * without from 1 April. If the rate lived on the code and the code were
 * later updated, *"every 2019 invoice re-renders at 5%, the PDF a buyer
 * downloads no longer matches the one they were sent, the reconciliation
 * against GSTR-1 fails for a whole quarter — AND NOTHING ERRORS."*
 *
 * ⚠️ SO A CODE IMPORTED HERE IS NOT YET USABLE ON AN INVOICE, AND THE
 * DESCRIPTION SAYS SO IN THE PICKER. `resolveRateOn` needs a rate period
 * covering the invoice's date; a code with none resolves to nothing and
 * `codesWithoutRateOn` in `server/gst/registry.ts` exists precisely to
 * list them. Importing rate PERIODS is a second entity with a second
 * shape — dated windows that must not overlap, enforced by an EXCLUDE
 * constraint — and it is not in this phase. Saying that here is the
 * difference between a customer who loads their codes and then opens the
 * rate screen, and one who loads their codes and believes they are done.
 */
const taxCodesEntity: ContractedImportEntity = {
  key: "tax-codes",
  label: "Tax codes (HSN and SAC)",
  noun: { one: "tax code", many: "tax codes" },
  description:
    "The HSN and SAC codes you bill under, with what each covers. This loads the " +
    "CODES only — a code still needs a dated rate period before it can be used on " +
    "an invoice, because a GST rate is a fact about a period and not a property of " +
    "the code.",
  table: "hsn_sac_codes",
  feature: "gst.rate_master",
  /**
   * ⚠️ `gst:manage_rates` FOR BOTH, WHICH IS WHAT `createHsnSacCode`
   * ALREADY REQUIRES. It is deliberately one of the four permissions
   * `db/schema/auth.ts` singles out as one a mistake in is invisible:
   * "a mistyped rate is charged on every invoice".
   */
  createPermission: "gst:manage_rates",
  updatePermission: "gst:manage_rates",

  columns: [
    {
      field: "code",
      header: "HSN or SAC code",
      kind: "text",
      required: true,
      maxLength: 8,
      aliases: ["code", "hsn", "sac", "hsncode", "saccode", "hsnsac", "itemcode"],
      help:
        "Digits only. An HSN is 2, 4, 6 or 8 digits — how many you must quote " +
        "depends on turnover, 4 below ₹5 crore and 6 above. A SAC is six digits " +
        "beginning 99.",
    },
    {
      /**
       * ⚠️ REQUIRED, AND NOT DERIVED FROM THE CODE EVEN THOUGH IT LOOKS
       * DERIVABLE. Every SAC begins 99 and is six digits — but so does a
       * perfectly legitimate six-digit HSN beginning 99, and the CHECK
       * constraint `hsn_sac_codes_shape` reads the two rules apart by
       * `kind`. Guessing would put a goods code in the services half of
       * GSTR-1, which is rejected at filing rather than here.
       */
      field: "kind",
      header: "Goods or services",
      kind: "enum",
      required: true,
      enumValues: ["hsn", "sac"],
      aliases: ["type", "kind", "codetype", "goodsorservices", "category"],
      help:
        "hsn for goods, sac for services. It cannot be worked out from the code — " +
        "a six-digit HSN can begin 99 too — and the wrong one is rejected by the " +
        "GST portal at filing rather than here.",
    },
    {
      field: "description",
      header: "Description",
      kind: "text",
      required: true,
      maxLength: 500,
      aliases: ["description", "particulars", "itemdescription", "narration", "details"],
      help: "What this code covers, in your own words. Required — a bare code is unusable by anyone else.",
    },
    {
      field: "uqc",
      header: "Unit (UQC)",
      kind: "text",
      required: false,
      maxLength: 10,
      aliases: ["uqc", "unit", "uom", "unitofmeasure", "unitquantitycode"],
      help:
        "The unit quantity code — SQM, NOS, MTR. Rule 46(g) requires the quantity " +
        "AND its unit for goods, and GSTR-1 rejects a free-text unit. Leave blank " +
        "for services, which have no quantity in that sense.",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 2_000,
      aliases: ["remarks", "comments", "internalnotes"],
      help: "Free text, for your own reference.",
    },
  ],

  buildPayload: (values) => ({
    code: values.code,
    kind: values.kind,
    description: values.description,
    /*
     * ⚠️ `null` IS CORRECT HERE AND WOULD BE WRONG ABOVE. Both of these
     * are `.optional().nullable()` in `createHsnSacSchema`, so a blank
     * cell passing through as `null` is accepted and means "no unit",
     * which is exactly what a blank means for a service. Compare the two
     * entities above, where the schema's `.default(...)` refuses `null`
     * and the key has to be omitted instead. The difference is in the
     * schemas, not in a house style, which is why each `buildPayload`
     * states which one it is dealing with.
     */
    uqc: values.uqc ?? null,
    notes: values.notes ?? null,
  }),

  /**
   * 🔴 THE SAME OBJECT `createHsnSacCode` PARSES, imported unchanged from
   * `lib/validators/gst.ts`. It carries the two rules that make a code
   * filable rather than merely storable — the SAC shape and the HSN
   * digit count — as a `.superRefine()`, with sentences, and the database
   * carries both again as `hsn_sac_codes_shape`. A bulk path that skipped
   * the schema would meet the CHECK as a `23514` with no row number.
   *
   * ⚠️ THIS IS THE ONLY ONE OF THE THREE ENTITIES THAT NEEDED NO PATCH
   * REQUEST TO REACH ITS SCHEMA, because `lib/validators/gst.ts` already
   * held it where both callers could see it. That is the shape the other
   * two have now been moved into.
   */
  schema: createHsnSacSchema,

  /**
   * The code, exactly. `hsn_sac_codes_code_tenant_unique` is
   * `UNIQUE (tenant_id, code)` on the raw column — and the schema refuses
   * anything but digits, so there is no case to normalise. Stating the
   * key as exact is still the honest thing: it says the rule was checked
   * against the index rather than inherited from the entity above.
   */
  naturalKey: (parsed) => {
    const code = typeof parsed.code === "string" ? parsed.code : "";
    if (code === "") return null;
    return { kind: "taxCode", value: code, label: `code ${code}` };
  },

  rowLabel: (parsed) => `${text(parsed.code, "?")} ${text(parsed.description, "")}`.trim(),

  duplicateRule:
    "Two rows are the same tax code when the codes match. Note that the same digits " +
    "cannot be both an HSN and a SAC in one workspace — the index is on the code " +
    "alone — so a file carrying both spellings of one number will report the second " +
    "as a duplicate of the first.",

  contract: {
    dependsOn: [],

    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      /**
       * 🔴 THE ESCAPE IS THE POINT OF THIS ENTITY'S CONTRACT AND IT IS
       *    NOT HYPOTHETICAL.
       *
       * `hsn_sac_rates.hsn_sac_id` references this row, and
       * `invoice_lines.gst_rate_id` pins the exact rate row an invoice
       * used, ON DELETE RESTRICT, *"so history cannot be unmade"*. A code
       * that has acquired a rate period since the import cannot be
       * deleted, and neither can one whose rate an invoice has used.
       */
      escapes:
        "A code that has been given a rate period since the import — or whose rate " +
        "an invoice has already used — cannot be removed: the rate row references " +
        "it and the invoice line pins the rate, both ON DELETE RESTRICT, precisely " +
        "so that history cannot be unmade. An undo leaves those codes in place and " +
        "names them.",
      because:
        "`update` is offered, so a run can rewrite the description and unit of a " +
        "code that pre-dates the migration. Deleting on undo would destroy a code " +
        "the customer set up themselves — and would fail anyway for every code that " +
        "has a rate, which is every code that is actually in use.",
    },

    provenance: { targets: ["hsn_sac_codes"], cardinality: "one-to-one" },

    /**
     * ⚠️ EMPTY, WITH A CANDIDATE CONSIDERED AND REJECTED IN WRITING —
     * AND THIS ONE IS THE CLOSEST CALL IN THE PHASE.
     *
     * `uqc` is the candidate. Rule 46(g) requires the quantity and its
     * unit for GOODS, and GSTR-1 rejects a free-text unit, so an HSN with
     * no UQC is a code that cannot be filed. That is very nearly "the row
     * is not a thing".
     *
     * 🔴 IT IS REJECTED BECAUSE `createHsnSacSchema` ACCEPTS IT AND THE
     *    FORM THEREFORE DOES TOO. Making it structural here would mean
     *    the importer refuses rows the single-record form creates
     *    happily — an import that is STRICTER than the form, which is the
     *    same defect as one that is looser, in the direction nobody
     *    checks for. A customer would fix a file to satisfy a rule the
     *    product does not have.
     *
     * If a UQC-less HSN should be refused, the place to say so is
     * `createHsnSacSchema`, once, where both paths read it.
     */
    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "A code list is loaded once and re-uploaded whole after fixing a few rows; " +
        "`skip` makes that safe. `update` rewrites the description and unit of " +
        "codes your invoices already quote — the rates themselves are never touched " +
        "by this import, and cannot be, because they live in dated periods on a " +
        "different table.",
    },
  },
};

/* ================================================================== */
/* THE MAP                                                            */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IS NOT IN THIS MAP, AND WHY — THE SHORT VERSION
 * ══════════════════════════════════════════════════════════════════════
 * The long version, with the command run for each, is in
 * `TRACK-REPORT.md`. Every one of these was refused rather than
 * forgotten:
 *
 *   `journals`          The framework can express one document per FILE
 *                       (the opening trial balance) and one document per
 *                       ROW (everything else). A general journal file is
 *                       MANY documents per file, which is neither. Every
 *                       leg of one voucher shares its natural key, and
 *                       `planImportRecords` refuses the second row
 *                       carrying a key the first row already had — so a
 *                       two-line voucher loses its second line before it
 *                       reaches the database. Proven by execution.
 *
 *   `currencies`        There is no `currencies` table. `currency_units`
 *                       is PLATFORM-scoped — no `tenant_id`, primary key
 *                       `code` — and is checked against
 *                       `lib/fx/currency.ts` by `verifyCurrencyUnits()`.
 *                       One tenant importing it would change the minor
 *                       units of every other tenant's money.
 *
 *   `payment-terms`     No table, no schema, no form.
 *   `numbering-series`  No table, no schema, no form.
 *
 *   `custom-fields`     Two systems, and neither has a per-record form.
 *                       `custom_field_definitions` is only ever written
 *                       wholesale by `defineCustomObject`; the other
 *                       system's `addDynamicField` runs DDL per call and
 *                       its undo DROPS THE COLUMN AND EVERY VALUE IN IT.
 *
 * ⚠️ AND THE ONE THING THAT WOULD MAKE THIS LIST DANGEROUS IS ADDING A
 * KEY TO IT WITHOUT A WRITER. `IMPORT_WRITERS` is a `Record` over the
 * destination union, so a destination with no writer is a compile error —
 * but an ENTITY with a destination somebody else already wrote is not.
 * All three destinations below are new in this phase and each has exactly
 * one writer, under `server/import/writers/accounting/`.
 */
export const ACCOUNTING_IMPORT_ENTITIES = {
  "chart-of-accounts": chartOfAccountsEntity,
  "cost-centres": costCentresEntity,
  "tax-codes": taxCodesEntity,
} as const satisfies Record<string, ContractedImportEntity>;

export type AccountingImportEntityKey = keyof typeof ACCOUNTING_IMPORT_ENTITIES;
