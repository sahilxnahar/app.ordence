/**
 * Ordence — Identifier Validation for Runtime DDL
 * Version: v0.24.0-alpha
 *
 * Pure and isomorphic. No `@/db` import, no I/O, no Node APIs — the
 * builder UI, the server actions and the tests all reach the same verdict
 * about the same string.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ READ THIS BEFORE CHANGING ANYTHING IN THIS FILE ⭐⭐
 * ══════════════════════════════════════════════════════════════════════
 * Twenty-three phases of this product have had exactly one rule about SQL
 * injection: PARAMETERISE EVERYTHING. It worked because every untrusted
 * value was a value.
 *
 * This phase breaks that rule, because it has to. A table name is not a
 * value. `CREATE TABLE $1` is not valid SQL in any database, and no
 * driver will ever make it so. The name a customer typed has to end up
 * INTERPOLATED into a DDL string.
 *
 * So the defence is not "parameterise". It is three layers, and this file
 * is the first:
 *
 *   1. ⭐ THIS FILE — a strict ALLOWLIST. Not an escape, not a blocklist,
 *      not a sanitiser that strips bad characters. A name either matches
 *      `^[a-z][a-z0-9_]*$` or it is refused. Nothing is ever "cleaned up"
 *      and used: a sanitiser that turns `users"; DROP TABLE x; --` into
 *      `usersdroptablex` has silently created a table nobody asked for,
 *      which is the wrong failure.
 *
 *   2. `quote_ident` / `format('%I', …)` inside every SQL function in
 *      `SQL-FILES/0019_phase24_dynamic_objects.sql`. Never `||`. Even
 *      after layer 1 has passed, because a defence that exists once
 *      exists until somebody refactors it.
 *
 *   3. The SQL functions RE-VALIDATE with the same regex, in the
 *      database, as `SECURITY DEFINER`. TypeScript is not the only thing
 *      that can call a Postgres function; psql, a migration and a future
 *      API route can too.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE FIVE WAYS AN IDENTIFIER GETS YOU, AND WHERE EACH IS HANDLED
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. QUOTE BREAKING — `"; DROP TABLE users; --`
 *    Handled by the regex: `"`, `;`, ` ` and `-` are simply not in the
 *    allowed set. Handled AGAIN by `%I`, which doubles embedded quotes.
 *
 * 2. RESERVED WORDS — a column called `select`, `user`, `table`, `order`.
 *    These are not an injection; they are a time bomb. `%I` quotes them,
 *    so the CREATE succeeds, and every hand-written query against that
 *    column afterwards is a syntax error at a customer's site. Refused
 *    up front — see `RESERVED_WORDS`.
 *
 * 3. LENGTH — PostgreSQL identifiers are `NAMEDATALEN - 1` = 63 BYTES.
 *    Longer names are TRUNCATED SILENTLY, with a notice nobody reads.
 *    Two fields called `very_long_…_alpha` and `very_long_…_beta` then
 *    become the same column, and the second `ADD COLUMN` fails with
 *    "column already exists" — or worse, an index name truncates into a
 *    collision and one field's uniqueness constraint enforces another
 *    field's. Refused up front, measured in BYTES not characters.
 *
 * 4. UNICODE AND HOMOGLYPHS — `usеrs` with a Cyrillic е, `ｕsers` in
 *    fullwidth, `user​s` with a zero-width space. PostgreSQL accepts
 *    all of them as quoted identifiers, and they render identically to a
 *    reviewer. The regex is ASCII-only, so all of them are refused.
 *    ⚠️ AND THE ORDER OF OPERATIONS MATTERS — see `assertIdentifier`.
 *
 * 5. COLLISION WITH OUR OWN SCHEMA — a tenant defining an object called
 *    `users`, `tenants` or `audit_logs`. Handled STRUCTURALLY rather than
 *    by a list: every physical table this engine creates is prefixed
 *    `cx_`, and the prefix is enforced inside the database function, not
 *    only here. A list of core table names is checked too, because a
 *    prefix is only a guarantee while nobody removes it.
 */

/* ------------------------------------------------------------------ */
/* THE ALLOWLIST                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE REGEX. The single most important line in the phase.
 *
 * Anchored at both ends — an unanchored `/[a-z0-9_]+/` matches a
 * SUBSTRING and would happily approve `bob"; DROP TABLE users; --`.
 * Lowercase only, so there is no case-folding step between validation and
 * use (see `assertIdentifier`). Must start with a letter, because a
 * leading digit or underscore needs quoting in some tools and a leading
 * `pg_` is reserved by PostgreSQL itself.
 *
 * ⚠️ There is no `u` flag and no `\w`. `\w` is ASCII in JavaScript by
 * default but NOT under the `u` flag with `i`, and a future edit adding
 * flags to a `\w` pattern would quietly widen the allowlist to Unicode.
 * The explicit character class cannot do that.
 */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * PostgreSQL's `NAMEDATALEN - 1`. BYTES, not characters — and the
 * distinction is the whole reason `identifierByteLength` exists.
 */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * ⭐ THE PREFIX THAT MAKES COLLISION WITH A CORE TABLE IMPOSSIBLE.
 *
 * `cx_` — "custom object". Short on purpose: it is spent out of the
 * 63-byte budget on every runtime table.
 *
 * ⚠️ NO CORE TABLE MAY EVER BE NAMED `cx_*`. That is the contract this
 * prefix rests on, it is checked in the verification section of
 * `SQL-FILES/0019`, and it is why the prefix is enforced INSIDE the
 * database function rather than only being added here.
 */
export const PHYSICAL_TABLE_PREFIX = "cx_";

/**
 * How many bytes of the tenant's own name survive into the physical
 * table name. The rest of the 63-byte budget goes to the prefix and the
 * 8-hex-character discriminator.
 *
 *   3 (`cx_`) + 40 (api name) + 1 (`_`) + 8 (hex) = 52 bytes.
 */
export const MAX_OBJECT_API_NAME_LENGTH = 40;

/** Fields are columns, so they get the full budget minus nothing. */
export const MAX_FIELD_API_NAME_LENGTH = 50;

/* ------------------------------------------------------------------ */
/* SYSTEM COLUMNS — WHAT A FIELD MAY NEVER BE CALLED                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EVERY RUNTIME TABLE HAS THESE, AND A FIELD MAY NOT SHADOW ONE.
 *
 * ⚠️ `tenant_id` IS THE ONE THAT MATTERS AND IT IS NOT A NAMING QUIBBLE.
 *
 * A tenant who could define a field called `tenant_id` would be defining
 * a WRITABLE column that the row-level security policy reads. The generic
 * record writer would then accept `{"tenant_id": "<someone else's id>"}`
 * from a form post. The WITH CHECK clause refuses it — so this is not an
 * open door — but it is a door whose only lock is one clause in one
 * policy, and the failure if that clause is ever relaxed is a
 * cross-customer write. `ADD COLUMN tenant_id` would in fact fail with
 * "column already exists"; refusing it here means the customer gets a
 * sentence instead of a Postgres error, and the reviewer gets a list.
 *
 * The rest are ordinary shadowing: a field called `id` or `created_at`
 * makes the generic CRUD layer ambiguous about which one it means, and
 * "it means whichever one the query planner picked" is not an answer.
 *
 * ⚠️ THE POSTGRES SYSTEM COLUMNS ARE HERE TOO. `ctid`, `xmin`, `xmax`,
 * `cmin`, `cmax`, `tableoid` and `oid` are not in any `CREATE TABLE` but
 * they exist on every table, and `ADD COLUMN xmin` fails with a message
 * about a "system column" that means nothing to a person naming a field.
 */
export const SYSTEM_COLUMNS: readonly string[] = Object.freeze([
  // Ours, on every runtime table. See `SYSTEM_COLUMN_DDL` below.
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "deleted_at",
  "deleted_by",
  // PostgreSQL's, on every table whether you asked for them or not.
  "ctid",
  "oid",
  "xmin",
  "xmax",
  "cmin",
  "cmax",
  "tableoid",
]);

const SYSTEM_COLUMN_SET = new Set(SYSTEM_COLUMNS);

/**
 * The core tables this product ships. A runtime object may not take one
 * of these names even though the `cx_` prefix already makes a collision
 * impossible.
 *
 * ⚠️ THIS LIST IS BELT AND BRACES, NOT THE DEFENCE. It is deliberately
 * allowed to go stale — a new core table added in Phase 30 and forgotten
 * here is still uncollidable, because the prefix is enforced in the
 * database. If this were the only defence, a forgotten entry would be a
 * tenant able to create a table called `views` and shadow a core one.
 */
export const CORE_TABLE_NAMES: readonly string[] = Object.freeze([
  "tenants",
  "users",
  "audit_logs",
  "permissions",
  "roles",
  "role_permissions",
  "user_roles",
  "permission_denials",
  "contacts",
  "companies",
  "deals",
  "assets",
  "asset_relationships",
  "contracts",
  "contract_versions",
  "contract_signatures",
  "clause_library",
  "ledgers",
  "journal_entries",
  "transactions",
  "financial_periods",
  "documents",
  "portal_links",
  "plans",
  "subscriptions",
  "invoices",
  "invoice_lines",
  "payment_events",
  "payment_methods",
  "usage_counters",
  "usage_levels",
  "error_events",
  "web_vital_events",
  "security_events",
  "platform_staff",
  "platform_action_log",
  "platform_impersonation_sessions",
  "platform_tenant_flags",
  "tenant_support_consents",
  "projects",
  "units",
  "leads",
  "lead_activities",
  "bookings",
  "payment_milestones",
  "channel_partners",
  "workflows",
  "workflow_versions",
  "workflow_runs",
  "workflow_run_steps",
  "workflow_tasks",
  "custom_object_definitions",
  "custom_field_definitions",
  "custom_object_records",
  "dynamic_objects",
  "dynamic_fields",
  "change_log",
  "installation",
]);

const CORE_TABLE_SET = new Set(CORE_TABLE_NAMES);

/* ------------------------------------------------------------------ */
/* RESERVED WORDS                                                      */
/* ------------------------------------------------------------------ */

/**
 * PostgreSQL reserved key words — the `reserved` and
 * `reserved (can be function or type name)` categories of the SQL key
 * words appendix, plus the ANSI words that are reserved in enough other
 * engines to be worth refusing.
 *
 * ⚠️ WHY REFUSE THESE WHEN `%I` WOULD QUOTE THEM PERFECTLY WELL.
 *
 * Because the CREATE is not the problem. `format('%I', 'select')` emits
 * `"select"` and the column is created without complaint. The problem is
 * every line of SQL written about that column for the rest of its life —
 * by us in a report, by a customer's analyst in a BI tool, by a support
 * engineer at a psql prompt. All of them must remember the quotes, and
 * the day one of them forgets, the error is a syntax error in production
 * that reads as though the database is broken.
 *
 * Refusing costs a customer one rename at creation time. Accepting costs
 * somebody an incident, at an unknown future date, in a query we did not
 * write.
 */
export const RESERVED_WORDS: readonly string[] = Object.freeze([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc",
  "asymmetric", "authorization", "between", "bigint", "binary", "bit",
  "boolean", "both", "case", "cast", "char", "character", "check",
  "coalesce", "collate", "collation", "column", "concurrently",
  "constraint", "create", "cross", "current_catalog", "current_date",
  "current_role", "current_schema", "current_time", "current_timestamp",
  "current_user", "date", "dec", "decimal", "default", "deferrable",
  "desc", "distinct", "do", "else", "end", "except", "exists", "extract",
  "false", "fetch", "float", "for", "foreign", "freeze", "from", "full",
  "grant", "greatest", "group", "grouping", "having", "ilike", "in",
  "initially", "inner", "inout", "int", "integer", "intersect",
  "interval", "into", "is", "isnull", "join", "lateral", "leading",
  "least", "left", "like", "limit", "localtime", "localtimestamp",
  "national", "natural", "nchar", "none", "not", "notnull", "null",
  "nullif", "numeric", "offset", "on", "only", "or", "order", "out",
  "outer", "overlaps", "overlay", "placing", "position", "precision",
  "primary", "real", "references", "returning", "right", "row", "select",
  "session_user", "setof", "similar", "smallint", "some", "substring",
  "symmetric", "table", "tablesample", "then", "time", "timestamp", "to",
  "trailing", "treat", "trim", "true", "union", "unique", "user", "using",
  "values", "varchar", "variadic", "verbose", "when", "where", "window",
  "with", "xmlattributes", "xmlconcat", "xmlelement", "xmlexists",
  "xmlforest", "xmlnamespaces", "xmlparse", "xmlpi", "xmlroot",
  "xmlserialize", "xmltable",
]);

const RESERVED_WORD_SET = new Set(RESERVED_WORDS);

/**
 * `pg_`, `information_schema` and `sql_` are reserved by PostgreSQL for
 * its own catalogues. A table called `pg_leads` is legal today and is the
 * kind of thing that breaks on a major-version upgrade.
 *
 * ⚠️ `cx_` is here as well, for the user-facing API NAME only. Without
 * it a tenant could name an object `cx_users`, whose physical table would
 * be `cx_cx_users_<hex>` — harmless, but the double prefix reads like a
 * bug and invites somebody to "fix" it by stripping one.
 */
const FORBIDDEN_PREFIXES = ["pg_", "sql_", "information_schema", "cx_"] as const;

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

/**
 * A refusal a person can act on.
 *
 * ⚠️ THE MESSAGE NAMES WHAT WAS WRONG, NEVER ECHOES THE INPUT VERBATIM
 * INTO ANYTHING BUT A STRING. It is shown in a form field, so it is
 * escaped by React on the way out — but the value is also written to
 * logs, and an identifier containing a newline would forge a log line.
 * `describeInput` below is what makes that safe.
 */
export class IdentifierError extends Error {
  constructor(
    readonly kind: IdentifierKind,
    readonly reason: IdentifierRejection,
    message: string,
  ) {
    super(message);
    this.name = "IdentifierError";
  }
}

export type IdentifierKind = "object" | "field";

export type IdentifierRejection =
  | "empty"
  | "not_a_string"
  | "too_long"
  | "non_ascii"
  | "bad_shape"
  | "reserved_word"
  | "system_column"
  | "core_table"
  | "forbidden_prefix";

/* ------------------------------------------------------------------ */
/* THE VALIDATOR                                                       */
/* ------------------------------------------------------------------ */

/**
 * Byte length under UTF-8, which is what PostgreSQL counts.
 *
 * ⚠️ `"café".length` is 4. Its byte length is 5. A name of 63 characters
 * containing one accented letter is 64 bytes and is TRUNCATED by the
 * server, silently. `TextEncoder` is in every runtime this file targets —
 * Node, the Edge runtime and the browser — so this stays isomorphic.
 *
 * (In practice `assertIdentifier` refuses non-ASCII before this matters.
 * It is measured in bytes anyway, because the day somebody widens the
 * regex is the day this becomes the only thing standing between a
 * customer and a silently truncated column.)
 */
export function identifierByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Render an untrusted string safely for an error message or a log line. */
function describeInput(value: unknown): string {
  if (typeof value !== "string") return `a ${typeof value}`;
  const flattened = value.replace(/[\p{C}\p{Z}]/gu, "·").slice(0, 60);
  return `"${flattened}"`;
}

/**
 * ⭐ THE GATE. Every identifier that reaches SQL passes through here.
 *
 * Returns the validated name unchanged. It does NOT clean, trim, lower-
 * case or otherwise repair its input, and that is deliberate:
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THERE IS NO `.toLowerCase()` OR `.trim()` IN THIS FUNCTION
 * ══════════════════════════════════════════════════════════════════════
 * The tempting shape is `validate(input.trim().toLowerCase())`. It is
 * wrong in a way that takes a while to see, and it is the classic
 * Unicode case-folding trap:
 *
 *   "İ".toLowerCase()          → "i̇"   (U+0069 + U+0307, TWO code points)
 *   "ſ".toUpperCase()          → "S"
 *   "K".toLowerCase()     → "k"    (KELVIN SIGN)
 *
 * A pipeline that folds case and THEN validates has changed the string
 * between the customer typing it and the check happening — so what was
 * checked is not what was typed, and any reasoning about the input is
 * about a different string. Worse, in a locale-aware `toLocaleLowerCase`
 * the mapping depends on the SERVER'S locale, so the same input can pass
 * on one machine and fail on another.
 *
 * So: the caller normalises for SUGGESTION purposes (`suggestApiName`),
 * and what the customer finally submits is checked exactly as submitted.
 * A capital letter is a refusal with a helpful message, not a silent
 * rewrite.
 */
export function assertIdentifier(value: unknown, kind: IdentifierKind): string {
  if (typeof value !== "string") {
    throw new IdentifierError(
      kind,
      "not_a_string",
      `A ${kind} name must be text, not ${describeInput(value)}.`,
    );
  }

  if (value.length === 0) {
    throw new IdentifierError(kind, "empty", `A ${kind} name is required.`);
  }

  // ⚠️ ASCII CHECK BEFORE THE SHAPE CHECK, so the message is accurate.
  // `/^[a-z][a-z0-9_]*$/` would reject `usеrs` (Cyrillic е) with "use
  // lowercase letters" — advice the customer has already followed, on a
  // character that looks exactly like the one they were told to use.
  // Naming the real problem is the difference between a ten-second fix
  // and a support ticket.
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new IdentifierError(
      kind,
      "non_ascii",
      `A ${kind} name may only use plain ASCII letters, digits and ` +
        `underscores. ${describeInput(value)} contains a character that is not ` +
        `one of those — often a look-alike pasted from a document, such as a ` +
        `Cyrillic "е" or a non-breaking space. They are indistinguishable on ` +
        `screen and would become two different columns.`,
    );
  }

  const maxLength =
    kind === "object" ? MAX_OBJECT_API_NAME_LENGTH : MAX_FIELD_API_NAME_LENGTH;

  // ⚠️ BYTES, and checked against our own budget rather than Postgres's
  // 63. The physical table name is built from this plus a prefix and a
  // discriminator; leaving the check to the database means discovering
  // the overflow after the metadata row has been written.
  if (identifierByteLength(value) > maxLength) {
    throw new IdentifierError(
      kind,
      "too_long",
      `A ${kind} name may be at most ${maxLength} characters. PostgreSQL ` +
        `truncates longer names to 63 bytes without an error, which would ` +
        `silently merge two differently-named ${kind}s into one.`,
    );
  }

  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new IdentifierError(
      kind,
      "bad_shape",
      `${describeInput(value)} is not a valid ${kind} name. Use lowercase ` +
        `letters, digits and underscores only, starting with a letter — for ` +
        `example "site_visit" or "unit_number". Spaces, punctuation and ` +
        `capitals are refused rather than corrected, because a name that is ` +
        `quietly rewritten is a name that does not match what you typed.`,
    );
  }

  for (const prefix of FORBIDDEN_PREFIXES) {
    if (value.startsWith(prefix)) {
      throw new IdentifierError(
        kind,
        "forbidden_prefix",
        `A ${kind} name may not start with "${prefix}". That prefix is ` +
          `reserved — "pg_", "sql_" and "information_schema" by PostgreSQL ` +
          `itself, and "cx_" by this engine for the physical tables it ` +
          `creates.`,
      );
    }
  }

  if (RESERVED_WORD_SET.has(value)) {
    throw new IdentifierError(
      kind,
      "reserved_word",
      `"${value}" is a reserved SQL word. It can be quoted and would work ` +
        `here, but every query written about it afterwards — in a report, a ` +
        `BI tool, or at a psql prompt during an incident — has to remember ` +
        `the quotes, and the first one that forgets is a syntax error in ` +
        `production. Try "${value}_name" or something more specific.`,
    );
  }

  if (kind === "field" && SYSTEM_COLUMN_SET.has(value)) {
    throw new IdentifierError(
      kind,
      "system_column",
      `"${value}" is a system column that every record already has. ` +
        (value === "tenant_id"
          ? `It is the column row-level security is enforced on: a writable ` +
            `field of that name would let a form post decide which workspace ` +
            `a record belongs to.`
          : `Choose another name — the record already carries this one, and ` +
            `two columns of the same name cannot be told apart.`),
    );
  }

  if (kind === "object" && CORE_TABLE_SET.has(value)) {
    throw new IdentifierError(
      kind,
      "core_table",
      `"${value}" is the name of a built-in record type. Your object would ` +
        `get its own physical table either way — the "${PHYSICAL_TABLE_PREFIX}" ` +
        `prefix guarantees that — but the name would be permanently ` +
        `ambiguous in every conversation about your data.`,
    );
  }

  return value;
}

/** Non-throwing form, for live validation as somebody types. */
export function checkIdentifier(
  value: unknown,
  kind: IdentifierKind,
): { ok: true; value: string } | { ok: false; reason: IdentifierRejection; error: string } {
  try {
    return { ok: true, value: assertIdentifier(value, kind) };
  } catch (err) {
    if (err instanceof IdentifierError) {
      return { ok: false, reason: err.reason, error: err.message };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* PHYSICAL NAMES                                                      */
/* ------------------------------------------------------------------ */

const HEX_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;

/**
 * ⭐ THE PHYSICAL TABLE NAME. Computed ONCE, at creation, and never again.
 *
 *     cx_<api_name>_<first 8 hex of the object's uuid>
 *
 * Three properties, each of which is load-bearing:
 *
 * 1. IT CANNOT COLLIDE WITH A CORE TABLE. Nothing we ship is named
 *    `cx_*`, the SQL function refuses to create a table without the
 *    prefix, and the verification section asserts no core table has
 *    acquired one.
 *
 * 2. IT CANNOT COLLIDE WITH ANOTHER TENANT'S OBJECT. Two workspaces both
 *    creating "Property" is not unusual — it is the expected case — and
 *    without the discriminator the second `CREATE TABLE` would fail with
 *    "relation already exists", telling one customer about the existence
 *    of another. The uuid fragment is derived from a `gen_random_uuid()`
 *    primary key, so it carries no information about who owns it.
 *
 * 3. ⭐ IT IS STABLE ACROSS RENAMES, WHICH IS THE ENTIRE POINT.
 *    `renameObject` changes the LABEL and nothing else. A physical
 *    `ALTER TABLE … RENAME` would be an ACCESS EXCLUSIVE lock on a table
 *    that may hold millions of rows, in the middle of a working day,
 *    triggered by somebody fixing a typo — and every foreign key, index,
 *    saved view and support runbook naming the old table would need
 *    finding. The physical name is an internal address. The label is what
 *    people see. They are allowed to disagree forever.
 *
 * ⚠️ The api name is NOT re-checked for length here beyond an assertion,
 * because `assertIdentifier` has already bounded it to 40 bytes. The
 * arithmetic — 3 + 40 + 1 + 8 = 52 — leaves 11 bytes of headroom against
 * the 63-byte ceiling, which is the budget index names are built from in
 * `SQL-FILES/0019`.
 */
export function physicalTableName(apiName: string, objectId: string): string {
  const validated = assertIdentifier(apiName, "object");

  // The id is ours (a uuid primary key), never the customer's — but it
  // still reaches an interpolated DDL string, so it is checked like
  // everything else that does.
  const suffix = objectId.replace(/-/g, "").slice(0, 8).toLowerCase();
  if (!HEX_SUFFIX_PATTERN.test(suffix)) {
    throw new IdentifierError(
      "object",
      "bad_shape",
      "Internal error: the object id is not a uuid, so no physical table " +
        "name can be derived from it. Refusing rather than guessing.",
    );
  }

  const name = `${PHYSICAL_TABLE_PREFIX}${validated}_${suffix}`;

  /* Unreachable given the bounds above — and asserted anyway, because the
   * failure it guards against (a silently truncated table name) is
   * invisible until two objects share one table. */
  if (identifierByteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new IdentifierError(
      "object",
      "too_long",
      `Internal error: the physical table name "${name}" is longer than ` +
        `PostgreSQL's 63-byte limit and would be truncated.`,
    );
  }

  return name;
}

/**
 * ⭐ A NAME THAT ARRIVED FROM THE DATABASE IS STILL UNTRUSTED.
 *
 * The generic CRUD layer reads `physical_table_name` out of
 * `dynamic_objects` and interpolates it into a query. That value was
 * validated when it was written — months ago, by a code path that may
 * since have been edited, into a row that a restore, a support fix or a
 * bug could have altered.
 *
 * So it is checked again on the way out. This is the cheapest assertion
 * in the codebase and it is the one standing between "a corrupted
 * metadata row" and "arbitrary SQL execution as the application role".
 */
export function assertPhysicalTableName(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(PHYSICAL_TABLE_PREFIX)) {
    throw new IdentifierError(
      "object",
      "bad_shape",
      `Refusing to query ${describeInput(value)}: a runtime object's table ` +
        `must be named "${PHYSICAL_TABLE_PREFIX}…". This value came from the ` +
        `metadata table and does not have that shape, which means either the ` +
        `row is corrupt or something is trying to point this engine at a ` +
        `table it does not own.`,
    );
  }

  if (
    !IDENTIFIER_PATTERN.test(value) ||
    identifierByteLength(value) > MAX_IDENTIFIER_BYTES
  ) {
    throw new IdentifierError(
      "object",
      "bad_shape",
      `Refusing to query ${describeInput(value)}: it is not a valid ` +
        `PostgreSQL identifier.`,
    );
  }

  return value;
}

/** The same argument, one level down, for a stored column name. */
export function assertPhysicalColumnName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER_PATTERN.test(value) ||
    identifierByteLength(value) > MAX_IDENTIFIER_BYTES
  ) {
    throw new IdentifierError(
      "field",
      "bad_shape",
      `Refusing to query the column ${describeInput(value)}: it is not a ` +
        `valid PostgreSQL identifier. This value came from the metadata ` +
        `table, so a failure here means the row is corrupt.`,
    );
  }

  // ⚠️ System columns are legitimate targets for the CRUD layer's own
  // SELECT list, but never for a value read out of `dynamic_fields`. A
  // field row claiming to be `tenant_id` is the shape a compromise would
  // take, and it must not be usable as a writable column.
  if (SYSTEM_COLUMN_SET.has(value)) {
    throw new IdentifierError(
      "field",
      "system_column",
      `Refusing to treat the system column "${value}" as a custom field.`,
    );
  }

  return value;
}

/* ------------------------------------------------------------------ */
/* SUGGESTION                                                          */
/* ------------------------------------------------------------------ */

/**
 * Turn a human label into a proposed api name.
 *
 * ⚠️ THIS IS A SUGGESTION, NOT A SANITISER, AND THE DIFFERENCE IS THE
 * POINT OF THE WHOLE FILE.
 *
 * Its output is put in a form field for a person to see and accept. It is
 * never fed straight into `physicalTableName` without passing
 * `assertIdentifier` first — because a sanitiser used as a gate is how
 * `"; DROP TABLE users; --` becomes a table called `droptableusers` that
 * somebody now has to explain.
 *
 * If it cannot produce anything valid it returns an empty string and the
 * customer types their own. It never guesses.
 */
export function suggestApiName(label: string, kind: IdentifierKind): string {
  const maxLength =
    kind === "object" ? MAX_OBJECT_API_NAME_LENGTH : MAX_FIELD_API_NAME_LENGTH;

  const ascii = label
    // Decompose accents, then drop the combining marks: "Société" → "Societe".
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, maxLength)
    .replace(/_+$/g, "");

  // Must start with a letter. A label of "2024 Targets" suggests
  // `f_2024_targets` for a field — prefixed rather than silently dropped,
  // so the digits the customer typed survive.
  const candidate = /^[a-z]/.test(ascii) ? ascii : ascii ? `f_${ascii}`.slice(0, maxLength) : "";

  const result = checkIdentifier(candidate, kind);
  return result.ok ? result.value : "";
}
