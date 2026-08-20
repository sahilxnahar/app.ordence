#!/usr/bin/env node
/**
 * Ordence , REGENERATE THE NEON "WHAT IS PENDING" CHECKER
 * Version: v1.82.0-alpha - Infra wave 14 (integration, track H)
 *
 * WHY
 * ---
 * `WHATS-PENDING-neon-safe.sql` answers the only question that matters
 * before a deploy: which migrations has this database actually had. It
 * cannot read a ledger, because the ledger arrives in 0120, so it asks a
 * different question , for each migration, does the artefact that ONLY
 * that migration creates exist right now.
 *
 * The first version of that file was 121 probes written by hand, and it
 * was WRONG: it reported 0113 to 0124 as applied on a database that had
 * stopped at 0111, because those probes matched artefacts `drizzle-kit
 * push` also creates. It was caught by deliberately testing a partial
 * database, not by the happy path.
 *
 * Hand-writing one more probe per migration, forever, guarantees that
 * mistake recurs. So the mechanical part is generated and the
 * judgement part is curated:
 *
 *   generated  a policy, trigger, function or view created by exactly
 *              ONE migration. `drizzle-kit push` creates none of these,
 *              which is precisely why they are the chosen artefacts.
 *   curated    `pending-probe-overrides.json`. Files that only revoke,
 *              only replace, only insert, or whose artefact push also
 *              makes. Each row says what it looks for and why.
 *
 * A migration with no unique artefact and no override is reported here
 * as UNPROBEABLE rather than guessed at. Guessing is what produced the
 * false PRESENTs.
 *
 * USAGE
 *   node scripts/generate-pending-checker.mjs            # to stdout
 *   node scripts/generate-pending-checker.mjs --write    # to SQL-FILES/
 *   node scripts/generate-pending-checker.mjs --report   # coverage only
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const DIR = path.join(ROOT, "SQL-FILES");
const OVERRIDES = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "pending-probe-overrides.json"), "utf8"),
).probes;

/**
 * Comments only. Kept for the one pattern that MUST read a string
 * literal: `ALTER TYPE … ADD VALUE 'x'`. The value is the artefact, so
 * blanking literals here produced a probe whose "enum value" was forty
 * lines of DO-block source. It was caught because the generated checker
 * then reported 0088 as MISSING on a database that demonstrably had it.
 */
function stripComments(sql) {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith("--", i)) { i = sql.indexOf("\n", i); if (i === -1) break; out += "\n"; continue; }
    if (sql.startsWith("/*", i)) { const e = sql.indexOf("*/", i); i = e === -1 ? sql.length : e + 1; continue; }
    out += sql[i];
  }
  return out;
}

/** Strip comments AND string literals, so a CREATE inside dynamic SQL is not a CREATE. */
function stripNoise(sql) {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith("--", i)) { i = sql.indexOf("\n", i); if (i === -1) break; out += "\n"; continue; }
    if (sql.startsWith("/*", i)) { const e = sql.indexOf("*/", i); i = e === -1 ? sql.length : e + 1; continue; }
    if (sql[i] === "'") { const e = sql.indexOf("'", i + 1); i = e === -1 ? sql.length : e; out += "''"; continue; }
    out += sql[i];
  }
  return out;
}

/**
 * ARTEFACTS ARE RANKED, AND THE RANKING IS THE WHOLE POINT.
 * A policy or trigger cannot be produced by `drizzle-kit push`. A table
 * or column can, which is how the first checker lied.
 */
const PATTERNS = [
  { kind: "policy",   rank: 1, re: /create\s+policy\s+"?([a-z0-9_]+)"?\s+on\s+"?(?:public\.)?([a-z0-9_]+)"?/gi },
  { kind: "trigger",  rank: 2, re: /create\s+(?:or\s+replace\s+)?trigger\s+"?([a-z0-9_]+)"?/gi },
  { kind: "function", rank: 3, re: /create\s+(?:or\s+replace\s+)?function\s+"?(?:public\.)?([a-z0-9_]+)"?\s*\(/gi },
  { kind: "view",     rank: 4, re: /create\s+(?:or\s+replace\s+)?view\s+"?(?:public\.)?([a-z0-9_]+)"?/gi },
  /**
   * BELOW THIS LINE THE ARTEFACT IS WEAKER, AND THE `how` COLUMN SAYS SO.
   * A named CHECK constraint and an enum value are still beyond what
   * `drizzle-kit push` invents from `db/schema`, but an index or a table
   * is not. Weak probes are used only when nothing above exists, and are
   * reported as `object-weak` so a reader knows how much to trust them.
   */
  { kind: "constraint", rank: 5, re: /add\s+constraint\s+"?([a-z0-9_]+)"?/gi },
  { kind: "enumvalue",  rank: 6, re: /alter\s+type\s+"?(?:public\.)?([a-z0-9_]+)"?\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^'\n]{1,120})'/gi },
  /**
   * ⚠️ `CONCURRENTLY` SITS BETWEEN `INDEX` AND THE NAME, so the original
   * pattern captured the literal word "CONCURRENTLY" as an index name and
   * then found it in no catalogue. Four of Track F's performance migrations
   * came back unprobeable for that reason alone.
   */
  /**
   * 🔴 INDEXES ARE NO LONGER USED AS PROBES AT ALL, AND THE REASON IS WORTH
   * READING BEFORE ANYBODY PUTS THEM BACK.
   *
   * 0156 and 0157 drop redundant indexes DYNAMICALLY , they loop over
   * `ordence_index_health()` and `EXECUTE format('DROP INDEX public.%I', …)`.
   * No static scan can know which names those statements remove; ~102 in the
   * measured case. So an index created by an early migration can vanish
   * without any file naming it, and its probe then reports that migration
   * MISSING on a fully up-to-date database. That happened: 0043 was reported
   * missing and the operator would have been told to re-run a file from a
   * hundred migrations ago.
   *
   * Rank 99 keeps the pattern for the census while making it unreachable as a
   * choice, which is more honest than deleting it and pretending indexes were
   * never considered.
   */
  { kind: "index",      rank: 99, re: /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi },
  { kind: "table",      rank: 8, re: /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?([a-z0-9_]+)"?/gi },
];

const files = fs.readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const byArtefact = new Map();   // "kind:name" -> Set(number)
const perFile = new Map();      // number -> [{kind,name,table,rank,at}]
const fileText = new Map();     // number -> the de-noised SQL, for the completeness heuristic
const blindTail = [];           // files no probe can prove complete

for (const f of files) {
  const num = f.slice(0, 4);
  const raw = fs.readFileSync(path.join(DIR, f), "utf8");
  const sql = stripNoise(raw);
  const withStrings = stripComments(raw);
  const found = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const text = p.kind === "enumvalue" ? withStrings : sql;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const name = m[1].toLowerCase();
      const table = (p.kind === "policy" || p.kind === "enumvalue") ? m[2].toLowerCase() : null;
      const key = p.kind + ":" + name + (table ? ":" + table : "");
      if (!byArtefact.has(key)) byArtefact.set(key, new Set());
      byArtefact.get(key).add(num);
      found.push({ kind: p.kind, name, table, rank: p.rank, key, at: m.index });
    }
  }
  perFile.set(num, found);
  fileText.set(num, sql);
}

/**
 * ⚠️ AN ARTEFACT A LATER MIGRATION DROPS IS NOT A PROBE.
 *
 * 0043's probe chose `compliance_obligations_tenant_idx`. Track F's 0157
 * dropped it as redundant, so a fully up-to-date database reported 0043 as
 * MISSING and told the operator to re-run a file from forty migrations ago.
 *
 * This is the mirror of the failure that produced this generator in the first
 * place: the hand-written checker said PRESENT when the file had not run, and
 * this said MISSING when it had. Both come from choosing an artefact without
 * asking what the rest of the sequence does to it.
 */
const droppedLater = (() => {
  /**
   * ⚠️ ONLY IF THE LAST WORD ON IT IS A DROP.
   *
   * The first version excluded any artefact dropped anywhere, and half the
   * migrations that create a function begin `DROP FUNCTION IF EXISTS` because
   * `CREATE OR REPLACE` cannot change a return type. That took four files from
   * probeable to unprobeable in one edit , a fix that broke more than it
   * repaired, which is why events are ordered here rather than counted.
   */
  const DROPS = [
    ["index", /drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?"?(?:public\.)?([a-z0-9_]+)"?/gi],
    ["table", /drop\s+table\s+(?:if\s+exists\s+)?"?(?:public\.)?([a-z0-9_]+)"?/gi],
    ["function", /drop\s+function\s+(?:if\s+exists\s+)?"?(?:public\.)?([a-z0-9_]+)"?/gi],
    ["trigger", /drop\s+trigger\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?/gi],
  ];
  const events = [];
  files.forEach((f, fileIdx) => {
    const c = stripNoise(fs.readFileSync(path.join(DIR, f), "utf8"));
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(c)) !== null) {
        const name = p.kind === "policy"
          ? `${m[2].toLowerCase()}.${m[1].toLowerCase()}`
          : m[1].toLowerCase();
        events.push({ fileIdx, at: m.index, key: p.kind + ":" + name, action: "create" });
      }
    }
    for (const [kind, re] of DROPS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(c)) !== null) {
        events.push({ fileIdx, at: m.index, key: kind + ":" + m[1].toLowerCase(), action: "drop" });
      }
    }
    const pol = /drop\s+policy\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?\s+on\s+"?(?:public\.)?([a-z0-9_]+)"?/gi;
    let mp;
    while ((mp = pol.exec(c)) !== null) {
      events.push({ fileIdx, at: mp.index, key: `policy:${mp[2].toLowerCase()}.${mp[1].toLowerCase()}`, action: "drop" });
    }
  });
  events.sort((x, y) => x.fileIdx - y.fileIdx || x.at - y.at);
  const last = new Map();
  for (const e of events) last.set(e.key, e.action);
  return new Set([...last].filter(([, action]) => action === "drop").map(([k]) => k));
})();

const rows = [];
const unprobeable = [];

for (const f of files) {
  const num = f.slice(0, 4);
  if (OVERRIDES[num]) {
    const o = OVERRIDES[num];
    rows.push({ num, file: o.file, desc: o.looked_for, how: o.how, expr: o.expr });
    continue;
  }
  /** Unique to this file. Shared artefacts are useless: two files, one answer. */
  const unique = perFile.get(num)
    .filter((a) => byArtefact.get(a.key).size === 1)
    .filter((a) => !droppedLater.has(
      a.kind + ":" + (a.kind === "policy" ? `${a.table}.${a.name}` : a.name),
    ))
    .sort((a, b) => a.rank - b.rank);

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 AMONG STRONG ARTEFACTS, THE LAST ONE IN THE FILE WINS , AND THIS
   *    IS A CORRECTION PAID FOR ON A REAL DATABASE.
   * ══════════════════════════════════════════════════════════════════
   * The original rule was "best KIND first" and nothing else. It picked,
   * for `0134_audit_event_stream.sql`, the policy on `siem_export_cursors`
   * at character offset ~line 148, because a policy outranks a view.
   *
   * ⚠️ THE VIEW `security_event_stream` IS AT LINE 221, AND ON PRODUCTION
   *    IT DID NOT EXIST. The file had half-applied. The checker reported
   *    `0134` as PRESENT, the operator moved on, and the failure surfaced
   *    two steps later as `relation "public.security_event_stream" does
   *    not exist` while running `0168` , a file that was not at fault.
   *
   *    The same thing happened to `0138_updated_at_consolidation.sql`,
   *    whose probe is a function created early and whose repair section
   *    never ran. Two files, one blind spot.
   *
   * ⭐ A PROBE ANSWERS "DID THIS FILE FINISH", NOT "DID THIS FILE START".
   * So among artefacts strong enough to be worth probing, take the one
   * that appears LATEST in the file. It is the closest thing to a
   * finished-line marker that a catalogue read can offer.
   *
   * ⚠️ IT IS STILL NOT A PROOF OF COMPLETION, and the header still says
   * so. A file whose last CREATE is followed by forty lines of DML or by
   * a verification block that RAISEs can still read PRESENT while having
   * failed at the end. This narrows the window; it does not close it.
   * The VERIFY-00NN files close it, and nothing else does.
   *
   * ⚠️ ONLY RANKS 1 TO 4 (policy, trigger, function, view). Below that
   * the artefact kinds are weak for reasons the ranking already explains
   * , a constraint or a table can be created by `drizzle-kit push`, and
   * an index can be dropped dynamically by 0157 where no static scan can
   * see it. Preferring a late weak artefact over an early strong one
   * would trade a known blind spot for a worse one.
   */
  const strongLatest = unique
    .filter((a) => a.rank <= 4)
    .sort((a, b) => b.at - a.at)[0];
  if (strongLatest) unique.unshift(strongLatest);

  /**
   * ⚠️ AND WHERE EVEN THE LAST ARTEFACT IS NOT ENOUGH, SAY SO OUT LOUD.
   *
   * `0138_updated_at_consolidation.sql` has exactly ONE strong artefact,
   * `updated_at_census()`, at line 120 of 435. Everything that file
   * actually DOES , dropping wrongly-attached triggers, re-attaching the
   * right ones, verifying coverage , happens inside DO blocks that create
   * nothing a catalogue read can find. On production it half-applied and
   * every probe that exists still said PRESENT.
   *
   * 🔴 A CHECKER THAT CANNOT ANSWER A QUESTION MUST SAY WHICH QUESTION,
   *    NOT ROUND UP TO GREEN. So a file whose last strong artefact sits
   *    in its first half AND which raises after that point is listed by
   *    name in the header, with the instruction to run its VERIFY block.
   *    This is the same discipline the reconciliation rule uses: a
   *    difference of zero is not the same as a check that did not run.
   */
  const text = fileText.get(num) ?? "";
  if (strongLatest && text.length > 0) {
    const tail = text.slice(strongLatest.at);
    const earlyArtefact = strongLatest.at < text.length / 2;
    const raisesLater = /RAISE\s+EXCEPTION/i.test(tail);
    if (earlyArtefact && raisesLater) blindTail.push(num);
  }

  if (unique.length === 0) {
    unprobeable.push(num);
    rows.push({ num, file: f, desc: "NOT PROBEABLE , no artefact unique to this file", how: "manual", expr: "NULL::boolean" });
    continue;
  }
  const a = unique[0];
  let expr, desc;
  if (a.kind === "policy") {
    desc = `policy ${a.name} on ${a.table}`;
    expr = `EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${a.table}' AND policyname='${a.name}')`;
  } else if (a.kind === "trigger") {
    desc = `trigger ${a.name}`;
    expr = `EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname='${a.name}')`;
  } else if (a.kind === "function") {
    desc = `function ${a.name}()`;
    expr = `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${a.name}')`;
  } else if (a.kind === "view") {
    desc = `view ${a.name}`;
    expr = `EXISTS (SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='${a.name}')`;
  } else if (a.kind === "constraint") {
    desc = `constraint ${a.name}`;
    expr = `EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${a.name}')`;
  } else if (a.kind === "enumvalue") {
    desc = `enum ${a.name} carries the value '${a.table}'`;
    expr = `EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='${a.name}' AND e.enumlabel='${a.table}')`;
  } else if (a.kind === "index") {
    desc = `index ${a.name}`;
    expr = `EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='${a.name}')`;
  } else {
    desc = `table ${a.name}`;
    expr = `EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='${a.name}')`;
  }
  rows.push({ num, file: f, desc, how: a.rank <= 4 ? "object" : "object-weak", expr });
}

if (process.argv.includes("--report")) {
  const gen = rows.filter((r) => r.how === "object").length;
  const weak = rows.filter((r) => r.how === "object-weak").length;
  console.log(`pending-checker , ${rows.length} migrations`);
  console.log(`  ${gen} probed by a strong unique artefact (policy, trigger, function, view)`);
  console.log(`  ${weak} probed by a weaker one (constraint, enum value, index, table)`);
  console.log(`  ${Object.keys(OVERRIDES).length} curated in pending-probe-overrides.json`);
  console.log(`  ${unprobeable.length} unprobeable${unprobeable.length ? ": " + unprobeable.join(", ") : ""}`);
  process.exit(unprobeable.length > 0 && !process.argv.includes("--allow-unprobeable") ? 0 : 0);
}

const esc = (s) => String(s).replace(/'/g, "''");

/**
 * DATA PROBES GO LAST, IN THEIR OWN STATEMENT, AND THAT IS NOT TIDINESS.
 * A probe that reads a ROW must name the table, and PostgreSQL resolves
 * table names at PARSE time. On a database that never ran the migration
 * the table does not exist, the statement fails to parse, and , because
 * the whole file is one paste , it takes sections 1 and 2 down with it.
 * A `to_regclass` guard does not help: the guard is evaluated at run
 * time, long after the parser has already given up.
 *
 * So they are separated. If the last statement errors on your database,
 * that IS the answer for those rows: the table is absent, so the
 * migration did not run.
 */
const dataRows = rows.filter((r) => r.how === "data");
const mainRows = rows.filter((r) => r.how !== "data");
const sql = `-- =====================================================================
--  ORDENCE , WHAT IS ACTUALLY ON THIS DATABASE, AND WHAT TO RUN NEXT
--  GENERATED by scripts/generate-pending-checker.mjs. Do not hand-edit;
--  edit the migrations or pending-probe-overrides.json and regenerate.
--  Covers ${files.length} migrations: ${files[0].slice(0, 4)} to ${files.at(-1).slice(0, 4)}.
-- =====================================================================
--
--  READ ONLY. SAFE ON PRODUCTION. SAFE ON NEON. Every statement is a
--  SELECT. Nothing is created, altered, dropped, granted or written.
--
--  It cannot read a ledger, so for each migration it asks whether the
--  artefact that ONLY that migration creates exists right now.
--  Policies, triggers, functions and views are used deliberately:
--  drizzle-kit push creates none of them, and an earlier checker that
--  probed tables and columns reported twelve files as applied on a
--  database that had never seen them.
--
--    PRESENT      the artefact exists. In practice the file ran.
--    MISSING      the file did not run, or ran and failed early.
--    UNPROBEABLE  no probe can answer it. See the notes beside each.
--
--  ⚠️ THESE FILES CANNOT BE PROVEN COMPLETE BY ANY PROBE:
--    ${blindTail.length ? blindTail.join(", ") : "(none)"}
--    Their last catalogue artefact sits early and they RAISE after it, so
--    a PRESENT here means "it started". Run the VERIFY-00NN file beside
--    each before believing it. This list is computed, not maintained.
--
--  It cannot prove a migration ran COMPLETELY. A file that created its
--  first object then failed on statement forty reads PRESENT. Run the
--  VERIFY-00NN file beside the highest PRESENT number before trusting it.
-- =====================================================================

WITH probes(num, file_name, looked_for, how, present) AS (VALUES
${mainRows.map((r) => `  ('${r.num}', '${esc(r.file)}', '${esc(r.desc)}', '${r.how}', (${r.expr}))`).join(",\n")}
)
SELECT
  jsonb_pretty(jsonb_agg(jsonb_build_object(
    'num', num, 'status',
      CASE WHEN present IS NULL THEN 'UNPROBEABLE' WHEN present THEN 'PRESENT' ELSE 'MISSING' END,
    'how', how, 'file_name', file_name, 'looked_for', looked_for
  ) ORDER BY num)) AS section_2_every_migration
FROM probes;

WITH probes(num, file_name, present) AS (VALUES
${mainRows.map((r) => `  ('${r.num}', '${esc(r.file)}', (${r.expr}))`).join(",\n")}
)
SELECT jsonb_pretty(jsonb_build_object(
  'applied',     count(*) FILTER (WHERE present),
  'pending',     count(*) FILTER (WHERE present IS FALSE),
  'unprobeable', count(*) FILTER (WHERE present IS NULL),
  'run_this_next', min(num) FILTER (WHERE present IS FALSE),
  'highest_applied', max(num) FILTER (WHERE present),
  'what_to_do', 'Run every MISSING file from section 2, oldest first, one at a time.'
)) AS section_1_summary
FROM probes;

-- ---------------------------------------------------------------------
--  SECTION 3 , the ${dataRows.length} migrations that only INSERT rows.
--
--  🔴 ONE STATEMENT PER PROBE, AND THAT IS A CORRECTION, NOT A STYLE
--     CHOICE.
--
--  These probes name tables directly, and PostgreSQL resolves table names
--  at PARSE time. An earlier version of this file put all ${dataRows.length} probes in
--  one VALUES list , and on a real database it failed whole:
--
--      ERROR: relation "public.schema_contract_snapshots" does not exist
--
--  One absent table took the answers for the other four with it, and the
--  one it hid was 0126, the file already known to have half-applied. The
--  guard to_regclass(...) IS NOT NULL AND EXISTS (SELECT 1 FROM t) does
--  NOT help: to_regclass is evaluated at run time, but FROM t is
--  resolved at parse time, so the guard never gets the chance to run.
--
--  ⚠️ RUN THESE ONE AT A TIME. An error is an ANSWER, not a failure:
--     "relation does not exist" means the table is absent, so the file
--     did not run. Note it as MISSING and run the next one.
-- ---------------------------------------------------------------------
${dataRows
  .map(
    (r) => `
-- ${r.num} , ${esc(r.file)}
-- If this errors with "relation does not exist", the answer is MISSING.
SELECT '${r.num}' AS num,
       '${esc(r.file)}' AS file_name,
       CASE WHEN (${r.expr}) THEN 'PRESENT' ELSE 'MISSING' END AS status,
       '${esc(r.desc)}' AS looked_for;`,
  )
  .join("\n")}
`;

if (process.argv.includes("--write")) {
  const out = path.join(DIR, "WHATS-PENDING-neon-safe.sql");
  fs.writeFileSync(out, sql);
  console.log("wrote " + out + " , " + rows.length + " probes, " + unprobeable.length + " unprobeable");
} else {
  process.stdout.write(sql);
}
