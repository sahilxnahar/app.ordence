#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE PERSONAL-DATA CLASSIFICATION GATE
 * Version: v1.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS EXISTS TO STOP, WHICH HAS NOT HAPPENED YET
 * ══════════════════════════════════════════════════════════════════════
 * Every other gate in this repository was written after something broke.
 * This one is written before, because the thing it prevents cannot be
 * noticed from inside the product.
 *
 * A workspace produces a data-principal export. It runs, it is complete
 * against the inventory, the customer hands it over and tells the person
 * "this is everything we hold about you". Six weeks earlier somebody
 * shipped a module with a `phone` column. Nothing failed. No test went
 * red. The export was complete against a list that had stopped being the
 * schema, and the only symptom is a sentence in a letter that is not
 * true.
 *
 * ⭐ SO THE LIST IS NOT ALLOWED TO BE THE AUTHORITY. `detector.ts` reads
 * the schema on every build and this gate fails when the schema contains
 * a table carrying personal-data-shaped columns that `classification.ts`
 * has not decided about. The list can only ever be a decision ABOUT
 * something the detector already found.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT CHECKS
 * ══════════════════════════════════════════════════════════════════════
 *   1. Every table the detector suspects is classified.       (the point)
 *   2. Every classified table still exists in the schema.     (stale)
 *   3. `operational` never covers a column that is
 *      unambiguously a person.                               (whitewash)
 *   4. Every declared reach column EXISTS on its table.       (typo)
 *   5. Every `parent` hop resolves to a classified table.     (dangling)
 *   6. No reach chain cycles, and every chain terminates.     (hang)
 *   7. Every principal kind maps to a table classified
 *      `principal`.                                          (anchor)
 *   8. Every retention id exists in `retention.ts`.           (typo)
 *   9. Every detector `link-` rule can actually fire.         (dead rule)
 *  10. The admitted-gap list has not grown.                   (drift)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT REFUSES TO PASS VACUOUSLY
 * ══════════════════════════════════════════════════════════════════════
 * If it parses zero tables, zero detector rules or zero classifications
 * it EXITS NON-ZERO rather than reporting success on an empty set. A
 * gate everybody believes is running and is not is the same defect as no
 * gate, wearing a green tick — the lesson `vitest.config.ts` records
 * about twenty-three suites that were never collected.
 *
 * ⚠️ AND IT PARSES `detector.ts` RATHER THAN RE-STATING ITS RULES. A
 * second copy of the rules in this file would be correct on the day it
 * was written and would drift the first time somebody tuned the real
 * one, and the drift would be invisible because both halves would still
 * pass.
 *
 * It does NOT require a database.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCHEMA_DIR = join(ROOT, "db", "schema");
const DETECTOR = join(ROOT, "lib", "dpdp", "detector.ts");
const CLASSIFICATION = join(ROOT, "lib", "dpdp", "classification.ts");
const RETENTION = join(ROOT, "lib", "dpdp", "retention.ts");
const BASELINE = join(ROOT, "scripts", "data-classification-baseline.json");
const ACCEPT = process.argv.includes("--accept");

let failures = 0;
const fail = (m) => {
  console.error(`::error::${m}`);
  failures++;
};

/* ================================================================== */
/* 1 · THE SCHEMA                                                      */
/* ================================================================== */

/**
 * ⚠️ THE COLUMN BLOCK IS FOUND BY BRACE BALANCING, NOT BY A REGEX OVER
 * THE WHOLE FILE. A flat regex also matches `index("...")` and
 * `uniqueIndex("...")` in the second argument and invents forty columns
 * per file that do not exist — which would make check 4 pass on typos.
 */
const COLTYPES =
  "uuid|varchar|text|integer|bigint|boolean|timestamp|date|jsonb|json|numeric|inet|real|doublePrecision|smallint|char|time|serial|\\w+Enum";

function parseSchema() {
  if (!existsSync(SCHEMA_DIR)) {
    fail(`${SCHEMA_DIR} not found — run from the project root.`);
    process.exit(1);
  }
/**
 * ⚠️ TEST SCRATCH FILES ARE SKIPPED UNLESS A TEST ASKS FOR THEM, AND BOTH
 *    HALVES OF THAT SENTENCE ARE LOAD-BEARING.
 *
 * 🔴 THE INCIDENT. `tests/ui/dpdp-inventory.test.ts` and
 * `tests/ui/boundary-rule-4.test.ts` each write a deliberately-bad file
 * into the source tree to prove their gate CATCHES it, then delete it.
 * Run the suite and the gates at the same time — which anybody doing
 * `npm test & npm run check:*` will, and which I did — and the gate scans
 * the other's scratch file and fails on a table that does not exist.
 *
 * ⚠️ IT LOOKS EXACTLY LIKE A REAL FAILURE. It names a plausible table
 * (`global_newsletter_signups`), it cites a real rule, and it goes away
 * on a re-run. A red gate that passes on retry is a gate people learn to
 * re-run instead of read, which is how a real failure gets clicked past.
 *
 * 🔴 AND THE OBVIOUS FIX — SKIP `__` FILES ALWAYS — IS WRONG, WHICH THOSE
 * TESTS PROVED IMMEDIATELY BY FAILING. Skipping them unconditionally
 * means the gate can no longer be shown to fire at all, and a check
 * nobody can demonstrate catching anything is a check nobody should
 * believe. The tests set `ORDENCE_GATE_FIXTURES=1`; nothing else does.
 */
const SCAN_FIXTURES = process.env.ORDENCE_GATE_FIXTURES === "1";
  const files = readdirSync(SCHEMA_DIR).filter(
    (f) => f.endsWith(".ts") && f !== "index.ts" && (SCAN_FIXTURES || !f.includes("__")),
  );
  const tables = [];
  for (const f of files) {
    const src = readFileSync(join(SCHEMA_DIR, f), "utf8");
    for (const m of src.matchAll(/export const (\w+)\s*=\s*pgTable\(\s*\n?\s*"([a-z0-9_]+)"/g)) {
      const open = src.indexOf("{", m.index + m[0].length);
      if (open < 0) continue;
      let depth = 0;
      let end = -1;
      for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) continue;
      const body = src.slice(open, end + 1);
      const cols = [
        ...body.matchAll(new RegExp(`\\w+\\s*:\\s*(?:${COLTYPES})\\(\\s*"([a-z0-9_]+)"`, "g")),
      ].map((x) => x[1]);
      tables.push({ file: f, table: m[2], columns: [...new Set(cols)] });
    }
  }
  return tables;
}

/* ================================================================== */
/* 2 · THE DETECTOR, READ OUT OF THE REAL FILE                        */
/* ================================================================== */

/**
 * 🔴 THE RULES ARE LIFTED VERBATIM OUT OF `lib/dpdp/detector.ts`.
 *
 * Each `{ rule: "...", kind: "...", test: /.../ }` literal is extracted
 * and the regex source is re-compiled here. If the extraction finds
 * nothing, the gate FAILS — it does not fall back to a built-in list,
 * because a fallback is how this file would go on reporting success
 * about rules it had stopped reading.
 */
function parseDetector() {
  if (!existsSync(DETECTOR)) {
    fail(`${DETECTOR} not found. The detector is the authority for what looks like personal data; without it this gate proves nothing.`);
    process.exit(1);
  }
  const src = readFileSync(DETECTOR, "utf8");
  const rules = [];
  for (const m of src.matchAll(
    /\{\s*rule:\s*"([\w-]+)"\s*,\s*kind:\s*"(\w+)"\s*,\s*test:\s*\/(.+?)\/\s*,?\s*\}/g,
  )) {
    let re;
    try {
      re = new RegExp(m[3]);
    } catch (e) {
      fail(`detector.ts rule "${m[1]}" has a pattern this gate cannot compile: ${e.message}`);
      continue;
    }
    rules.push({ rule: m[1], kind: m[2], test: re });
  }
  /**
   * 🔴🔴 THE INTEGRITY CHECK, AND IT IS HERE BECAUSE IT ALREADY CAUGHT
   *      THIS FILE OUT.
   *
   * The first version of the extraction regex ended `\/\s*\}` and so
   * refused to match a rule literal written with a trailing comma before
   * its closing brace. Two rules — `freeform-jsonb` and `freeform-text`,
   * the ones covering `custom_fields`, `metadata`, `payload` and `notes`
   * — were silently dropped. The gate reported success, on 39 rules
   * instead of 41, and twenty-five tables stopped being suspected of
   * holding personal data at all.
   *
   * ⚠️ NOTHING WOULD EVER HAVE SAID SO. The output printed a rule count
   * nobody had a second number to compare it against, which is the exact
   * shape of the defect this gate was written to prevent, occurring
   * inside the gate.
   *
   * ⭐ So the count of `rule:` keys in the file is compared against the
   * count actually parsed. Two numbers from two different readings of
   * the same text; a parser that quietly stops seeing things now has to
   * make them disagree.
   */
  const declared = [...src.matchAll(/\brule:\s*"([\w-]+)"/g)].map((m) => m[1]);
  if (declared.length !== rules.length) {
    const missing = declared.filter((d) => !rules.some((r) => r.rule === d));
    fail(
      `detector.ts declares ${declared.length} rules and this gate parsed ${rules.length}. ` +
        `Not parsed: ${missing.join(", ") || "(name unknown)"}. ` +
        `The gate is reading less than the detector defines, so every table those rules would have flagged is invisible to it. ` +
        `Fix the extraction in parseDetector() — do NOT adjust the rule formatting to suit the regex.`,
    );
  }

  const excluded = new Set();
  const exBlock = src.match(/const NOT_PERSONAL = new Map<string, string>\(\[([\s\S]*?)\]\);/);
  if (exBlock) {
    for (const e of exBlock[1].matchAll(/\["([a-z0-9_]+)"\s*,/g)) excluded.add(e[1]);
  }
  /**
   * 🔴 ONE EXCLUSION MAP, AND THIS CHECK IS WHY.
   *
   * A second `new Map<string, string>` merged into `NOT_PERSONAL` at
   * runtime is invisible to a textual parser, so the detector would
   * exempt a column and this gate would not — and the gate would then
   * demand a classification for a table nobody needs to classify, or
   * worse, fail to notice that the detector had stopped flagging one.
   * It happened while this batch was being written.
   */
  const maps = [...src.matchAll(/new Map<string, string>\(/g)].length;
  if (maps !== 1) {
    fail(
      `detector.ts defines ${maps} \`new Map<string, string>\` literals. This gate reads exactly one — NOT_PERSONAL — as text, ` +
        `so any other exclusion map is invisible to it and the gate and the detector will disagree about which columns are personal data.`,
    );
  }
  if (excluded.size === 0) {
    fail("Parsed ZERO entries out of NOT_PERSONAL in detector.ts. If the map really is empty the check is harmless; if the parse broke, every excluded column is now being treated as personal data and the noise will get this gate switched off.");
  }
  return { rules, excluded };
}

function detect(columns, rules, excluded) {
  const signals = [];
  for (const c of columns) {
    if (excluded.has(c) && c !== "name") continue;
    for (const r of rules) if (r.test.test(c)) signals.push({ column: c, ...r });
  }
  return signals;
}

/* ================================================================== */
/* 3 · THE CLASSIFICATION, READ OUT OF THE REAL FILE                  */
/* ================================================================== */

/**
 * ⚠️ TEXTUAL, LIKE `check-sql-completeness.mjs`. The gates in this
 * repository are plain `node` with `node:fs` and nothing else, so they
 * run before an install and cannot be broken by one.
 */
function parseClassification() {
  if (!existsSync(CLASSIFICATION)) {
    fail(`${CLASSIFICATION} not found.`);
    process.exit(1);
  }
  const src = readFileSync(CLASSIFICATION, "utf8");
  const entries = [];
  const re = /const \w+: TableClassification = \{([\s\S]*?)\n\};/g;
  for (const m of src.matchAll(re)) {
    const body = m[1];
    const table = body.match(/table:\s*"([a-z0-9_]+)"/)?.[1];
    const holds = body.match(/holds:\s*"(\w+)"/)?.[1];
    const scope = body.match(/scope:\s*"(\w+)"/)?.[1] ?? null;
    const scopeNote = body.match(/scopeNote:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? null;
    const because = body.match(/because:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? null;
    const retention = body.match(/retention:\s*(?:"([\w-]+)"|null)/)?.[1] ?? null;
    if (!table || !holds) continue;
    const reaches = [];
    for (const r of body.matchAll(/\{\s*via:\s*"(\w+)"([^}]*)\}/g)) {
      const via = r[1];
      const rest = r[2];
      const get = (k) => rest.match(new RegExp(`${k}:\\s*"([^"]*)"`))?.[1] ?? null;
      reaches.push({
        via,
        column: get("column"),
        principal: get("principal"),
        table: get("table"),
        from: get("from"),
        idColumn: get("idColumn"),
        kindColumn: get("kindColumn"),
        identifier: get("identifier"),
      });
    }
    entries.push({ table, holds, scope, scopeNote, because, retention, reaches });
  }

  const principalTables = {};
  const pt = src.match(/export const PRINCIPAL_TABLES: Record<PrincipalKind, string> = \{([\s\S]*?)\};/);
  if (pt) for (const m of pt[1].matchAll(/(\w+):\s*"([a-z0-9_]+)"/g)) principalTables[m[1]] = m[2];

  return { entries, principalTables };
}

function parseRetentionIds() {
  if (!existsSync(RETENTION)) {
    fail(`${RETENTION} not found.`);
    process.exit(1);
  }
  const src = readFileSync(RETENTION, "utf8");
  return new Set([...src.matchAll(/^\s{2}"([\w-]+)":\s*\{$/gm)].map((m) => m[1]));
}

/* ================================================================== */
/* RUN                                                                 */
/* ================================================================== */

const schema = parseSchema();
const { rules, excluded } = parseDetector();
const { entries, principalTables } = parseClassification();
const retentionIds = parseRetentionIds();

/**
 * 🔴 THE VACUOUS-PASS GUARD. Each of these being non-empty is what makes
 * every check below mean anything.
 */
if (schema.length === 0) fail("Parsed ZERO tables out of db/schema/. The parser is broken or the directory moved; every check below would pass vacuously.");
if (rules.length === 0) fail("Parsed ZERO rules out of lib/dpdp/detector.ts. Without the detector this gate cannot suspect anything and would pass on any schema at all.");
if (entries.length === 0) fail("Parsed ZERO classifications out of lib/dpdp/classification.ts.");
if (retentionIds.size === 0) fail("Parsed ZERO retention rules out of lib/dpdp/retention.ts.");
if (failures > 0) {
  console.error("\n❌ Data classification gate FAILED before it began.\n");
  process.exit(1);
}

const schemaByTable = new Map(schema.map((t) => [t.table, t]));
const entryByTable = new Map(entries.map((e) => [e.table, e]));

/* --- 1. every suspected table is classified ------------------------ */

const suspected = [];
for (const t of schema) {
  const signals = detect(t.columns, rules, excluded);
  if (signals.length > 0) suspected.push({ ...t, signals });
}

for (const t of suspected) {
  if (!entryByTable.has(t.table)) {
    const worst = t.signals.find((s) => s.kind === "identifier") ?? t.signals[0];
    fail(
      `\`${t.table}\` (db/schema/${t.file}) looks like it carries personal data — ` +
        `column \`${worst.column}\` matched the "${worst.rule}" rule (${worst.kind}) — ` +
        `and lib/dpdp/classification.ts does not classify it. ` +
        `Until it does, the data-principal export will not search this table and the erasure planner will not consider it, ` +
        `and neither will say so. Add an entry stating what it holds and how to reach one person's rows.`,
    );
  }
}

/* --- 2. no stale entries ------------------------------------------- */

for (const e of entries) {
  if (!schemaByTable.has(e.table)) {
    fail(
      `classification.ts classifies \`${e.table}\`, which no longer exists in db/schema/. ` +
        `A stale entry makes the inventory look more complete than it is.`,
    );
  }
}

/* --- 3. `operational` may not cover an unambiguous person ---------- */

/**
 * ⚠️ NAMES, ADDRESSES AND CO-ORDINATES ARE ALLOWED TO BE OPERATIONAL,
 * because a warehouse has an address, a price plan has a name and a
 * construction project has a latitude. An email, a phone number, a date
 * of birth, a photograph, an IP address or a social handle is not a
 * building.
 *
 * 🔴 GEOLOCATION WAS ON THIS LIST AND WAS WRONG. It failed `projects`,
 * whose latitude is a building site. The rule that a co-ordinate is
 * always a person is the same over-reach as the rule that an address is
 * always a person, and this file already rejected the second.
 *
 * ⚠️ AND `identifier`-KIND SIGNALS STILL FAIL REGARDLESS, WITH ONE
 * EXCEPTION MADE ABOVE: `rera-number` was demoted to `direct` because
 * `projects.rera_number` registers a building and
 * `channel_partners.rera_number` registers an agent.
 */
const NEVER_OPERATIONAL = new Set([
  "email", "phone", "date-of-birth", "demographic", "biometric-or-image",
  "network-identity", "social-handle",
]);

for (const t of suspected) {
  const e = entryByTable.get(t.table);
  if (!e || e.holds !== "operational") continue;
  if (!e.because || e.because.trim().length === 0) {
    fail(`\`${t.table}\` is classified "operational" with no \`because\`. An unexplained "there is no personal data here" is the assertion this gate exists to doubt.`);
  }
  const bad = t.signals.filter((s) => s.kind === "identifier" || NEVER_OPERATIONAL.has(s.rule));
  for (const s of bad) {
    fail(
      `\`${t.table}\` is classified "operational" but column \`${s.column}\` matched "${s.rule}" (${s.kind}). ` +
        `That column is a person on its face. Either the classification is wrong or the column is misnamed; ` +
        `if it is genuinely not personal, add it to NOT_PERSONAL in detector.ts by exact name, with a reason.`,
    );
  }
}

/* --- 3b. scope, which is half mechanical -------------------------- */

/**
 * 🔴 THE MECHANICAL HALF: A TABLE WITH NO `tenant_id` CANNOT BE
 *    TENANT-SCOPED. There is no RLS policy on it, no `withTenant()`
 *    filter reaches it, and a workspace's data-principal request that
 *    searched it would be reading across every customer at once.
 *
 * ⚠️ THE OTHER HALF IS NOT MECHANICAL. `platform_tenant_flags` HAS a
 * `tenant_id` and is still Ordence's own record, because the person
 * named on it is an Ordence engineer. That direction cannot be derived
 * and so it must be justified in writing.
 */
for (const e of entries) {
  const t = schemaByTable.get(e.table);
  if (!t) continue;
  if (!e.scope) {
    fail(`\`${e.table}\` declares no scope. Whose Data Fiduciary duty a row falls under decides whether a workspace's erasure may touch it, and an undeclared answer defaults to nothing safe.`);
    continue;
  }
  if (e.scope !== "tenant" && e.scope !== "platform") {
    fail(`\`${e.table}\` declares scope "${e.scope}", which is neither "tenant" nor "platform".`);
    continue;
  }
  const hasTenantId = t.columns.includes("tenant_id");
  if (!hasTenantId && e.scope === "tenant") {
    fail(
      `\`${e.table}\` has no \`tenant_id\` column and is declared scope "tenant". ` +
        `Nothing isolates it per workspace, so a workspace's data-principal search would read every customer's rows at once. ` +
        `It must be scope "platform".`,
    );
  }
  if (hasTenantId && e.scope === "platform" && !e.scopeNote) {
    fail(
      `\`${e.table}\` is tenant-scoped in the schema but classified scope "platform" with no \`scopeNote\`. ` +
        `That is a defensible call — \`platform_tenant_flags\` names an Ordence engineer — and it withholds a table from every ` +
        `customer's data-principal request, so the reason has to be written down.`,
    );
  }
}

/* --- 4-6. reaches resolve, and chains terminate -------------------- */

const hasColumn = (table, column) => schemaByTable.get(table)?.columns.includes(column) ?? false;

for (const e of entries) {
  const t = schemaByTable.get(e.table);
  if (!t) continue;
  if (e.reaches.length === 0) {
    fail(`\`${e.table}\` declares no reaches at all. Even an admitted gap must be written down as { via: "none", because: "..." } so it reaches the export manifest.`);
    continue;
  }
  for (const r of e.reaches) {
    switch (r.via) {
      case "self":
        if (!r.principal) fail(`\`${e.table}\`: a "self" reach with no principal.`);
        break;
      case "column":
        if (!r.column || !hasColumn(e.table, r.column))
          fail(`\`${e.table}\` reaches a ${r.principal} through column \`${r.column}\`, which does not exist on that table. The export would return nothing and report success.`);
        if (r.principal && !principalTables[r.principal])
          fail(`\`${e.table}\` names principal "${r.principal}", which is not in PRINCIPAL_TABLES.`);
        break;
      case "parent":
        if (!r.column || !hasColumn(e.table, r.column))
          fail(`\`${e.table}\` hops to \`${r.table}\` through column \`${r.column}\`, which does not exist on \`${e.table}\`.`);
        if (!r.table || !entryByTable.has(r.table))
          fail(`\`${e.table}\` hops to \`${r.table}\`, which has no classification of its own. A chain that ends at an unclassified table ends nowhere.`);
        break;
      case "reverse":
        if (!r.from || !schemaByTable.has(r.from))
          fail(`\`${e.table}\` is reached in reverse from \`${r.from}\`, which is not a table.`);
        else if (!r.column || !hasColumn(r.from, r.column))
          fail(`\`${e.table}\` is reached in reverse through \`${r.from}.${r.column}\`, which does not exist.`);
        break;
      case "identifier":
        if (!r.column || !hasColumn(e.table, r.column))
          fail(`\`${e.table}\` matches by identifier on column \`${r.column}\`, which does not exist on that table.`);
        break;
      case "polymorphic":
        if (!r.idColumn || !hasColumn(e.table, r.idColumn))
          fail(`\`${e.table}\` declares a polymorphic reach on \`${r.idColumn}\`, which does not exist.`);
        if (!r.kindColumn || !hasColumn(e.table, r.kindColumn))
          fail(`\`${e.table}\` declares a polymorphic discriminator \`${r.kindColumn}\`, which does not exist. Without it the id points at nothing knowable.`);
        break;
      case "none":
        break;
      default:
        fail(`\`${e.table}\` declares an unknown reach kind "${r.via}".`);
    }
  }
}

/**
 * 🔴 CYCLES AND DEAD ENDS. `a -> b -> a` makes the export walker hang or
 * recurse until the process dies, and a chain of `parent` hops that
 * never meets a principal is a table nobody can actually search however
 * many entries it passes through.
 */
function terminates(table, seen) {
  if (seen.has(table)) return { ok: false, why: `cycle: ${[...seen, table].join(" -> ")}` };
  const e = entryByTable.get(table);
  if (!e) return { ok: false, why: `\`${table}\` is not classified` };
  const next = new Set(seen).add(table);
  for (const r of e.reaches) {
    if (r.via === "self" || r.via === "column" || r.via === "identifier" || r.via === "polymorphic" || r.via === "reverse")
      return { ok: true };
    if (r.via === "none") return { ok: true };
    if (r.via === "parent" && r.table) {
      const sub = terminates(r.table, next);
      if (sub.ok) return { ok: true };
    }
  }
  return { ok: false, why: `no reach from \`${table}\` ever arrives at a person` };
}

for (const e of entries) {
  if (e.holds === "operational") continue;
  const v = terminates(e.table, new Set());
  if (!v.ok) fail(`\`${e.table}\`: ${v.why}.`);
}

/* --- 7. anchors ---------------------------------------------------- */

for (const [kind, table] of Object.entries(principalTables)) {
  const e = entryByTable.get(table);
  if (!e) fail(`PRINCIPAL_TABLES maps "${kind}" to \`${table}\`, which is not classified.`);
  else if (e.holds !== "principal")
    fail(`PRINCIPAL_TABLES maps "${kind}" to \`${table}\`, which is classified "${e.holds}" rather than "principal". The anchor of an export must be somebody's own record.`);
}

/* --- 8. retention ids exist ---------------------------------------- */

for (const e of entries) {
  if (e.retention && !retentionIds.has(e.retention))
    fail(`\`${e.table}\` cites retention rule "${e.retention}", which does not exist in lib/dpdp/retention.ts. A refusal citing a rule that is not there names no statute at all.`);
}

/* --- 9. no dead detector rules ------------------------------------- */

/**
 * 🔴 THIS CHECK WAS WRONG WHEN IT WAS FIRST WRITTEN AND THE FIX IS THE
 *    INTERESTING PART.
 *
 * It required EVERY detector rule to match at least one real column, on
 * the reasoning that a rule which cannot fire reads as coverage and
 * provides none. It then failed nine rules — `aadhaar`, `passport`,
 * `date-of-birth`, `demographic`, `voter-id` and the rest — because this
 * schema holds none of those columns.
 *
 * ⭐ BUT THOSE RULES ARE NOT DEAD, THEY ARE PROSPECTIVE. The entire
 * value of the `aadhaar` rule is that it fires on the day somebody adds
 * `aadhaar_number` to an onboarding table, which is precisely the event
 * this whole gate exists to catch. Deleting it to make the gate green
 * would be removing the alarm because the building is not on fire.
 *
 * ⚠️ A `link-` RULE IS DIFFERENT. It asserts a JOIN PATH — "rows about a
 * person can be found through this column" — and a join path to a column
 * that does not exist is a claim about reachability that is false today.
 * So `link-` rules must fire; the rest are allowed to wait, and the
 * ones waiting are PRINTED, because "this product stores no date of
 * birth and no Aadhaar number" is a fact worth stating out loud.
 */
const allColumns = new Set(schema.flatMap((t) => t.columns));
const ruleFires = (r) => {
  for (const c of allColumns) {
    if (excluded.has(c) && c !== "name") continue;
    if (r.test.test(c)) return true;
  }
  return false;
};
const prospective = [];
for (const r of rules) {
  if (ruleFires(r)) continue;
  if (r.rule.startsWith("link-")) {
    fail(
      `detector.ts rule "${r.rule}" claims a join path through a column that exists nowhere in db/schema/. ` +
        `A link rule is an assertion that rows about a person can be REACHED that way, and this one cannot. ` +
        `Fix the pattern or delete it — a prospective link rule is not the same as a prospective identifier rule.`,
    );
  } else {
    prospective.push(r.rule);
  }
}

/* --- 10. the admitted gaps have not grown -------------------------- */

const gaps = entries
  .filter((e) => e.holds !== "operational" && e.reaches.some((r) => r.via === "none"))
  .map((e) => e.table)
  .sort();

if (ACCEPT) {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        gaps,
        _why:
          "Each table below carries personal data that the data-principal export CANNOT reach. " +
          "The list may shrink. It may not grow without somebody re-running --accept and explaining why, " +
          "because a new gap is a table a customer will be told does not hold their data.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`  ⭐ Baseline written: ${gaps.length} admitted gap(s).`);
}

if (!existsSync(BASELINE)) {
  console.log("  ⚠️  No gap baseline recorded yet. Run with --accept to write one.\n");
} else {
  const known = new Set(JSON.parse(readFileSync(BASELINE, "utf8")).gaps ?? []);
  const closed = [...known].filter((t) => !gaps.includes(t));
  if (closed.length) console.log(`  ⭐ ${closed.length} gap(s) closed since the baseline: ${closed.join(", ")}`);
  for (const t of gaps) {
    if (!known.has(t))
      fail(
        `\`${t}\` is a NEW admitted gap: it carries personal data and no reach finds one person's rows in it. ` +
          `A person asking this workspace what it holds about them will be told, in a document, that this table holds nothing. ` +
          `Either declare a reach or run this gate with --accept and be able to defend the entry.`,
      );
  }
}

/* ================================================================== */

const counts = entries.reduce((a, e) => ((a[e.holds] = (a[e.holds] ?? 0) + 1), a), {});
const platformCount = entries.filter((e) => e.scope === "platform").length;
const edges = entries.reduce((a, e) => a + e.reaches.filter((r) => r.via !== "none").length, 0);

if (failures > 0) {
  console.error(`\n❌ Data classification FAILED — ${failures} problem(s).\n`);
  process.exit(1);
}

if (prospective.length) {
  console.log(
    `  ⭐ ${prospective.length} detector rule(s) match nothing in this schema today and are kept as tripwires: ` +
      `${prospective.join(", ")}. This product currently stores none of those.`,
  );
}

console.log(
  `✅ Data classification — ${schema.length} tables in db/schema/, ` +
    `${suspected.length} suspected of carrying personal data by ${rules.length} detector rules, ` +
    `${entries.length} classified (${counts.principal ?? 0} principal, ${counts.personal ?? 0} personal, ${counts.operational ?? 0} operational), ` +
    `${edges} reach edges, ${platformCount} out of a workspace's reach as Ordence's own, ${gaps.length} admitted gap(s).`,
);
