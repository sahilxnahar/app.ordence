#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE MIGRATION RUNNER
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS REPLACES
 * ══════════════════════════════════════════════════════════════════════
 * Pasting a file into the Neon browser console and reading the output.
 *
 * That worked, and it is why every file in `SQL-FILES/` is written to be
 * idempotent and to survive one-statement-per-connection. But it leaves
 * no record: "has 0117 been applied to production?" had no answer except
 * inferring it from the schema, which cannot tell a file that was
 * applied from one that was half-applied.
 *
 *     node scripts/migrate.mjs --status          what is applied, what is not
 *     node scripts/migrate.mjs --dry-run         what WOULD run, statement by statement
 *     node scripts/migrate.mjs --adopt           record the current state, once
 *     node scripts/migrate.mjs                   apply everything outstanding
 *     node scripts/migrate.mjs --to 0119         apply up to and including 0119
 *     node scripts/migrate.mjs --only 0120       apply exactly one file
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE STATEMENT PER CONNECTION, ALWAYS
 * ══════════════════════════════════════════════════════════════════════
 * This is the property that matters and the reason `psql -f` is not used.
 *
 * The Neon console sends every statement on its own connection. `psql -f`
 * sends the whole file on ONE connection, in one session, so a
 * transaction-local setting survives from statement to statement and a
 * failure part-way leaves a different state. Testing a file the way it
 * is NOT used proves nothing about the way it IS used, and that single
 * difference has cost this project more time than everything else.
 *
 * ⭐ SO THE RUNNER REPRODUCES THE CONSOLE. Which also means:
 *
 *   • `ALTER TYPE ... ADD VALUE` in 0118 works here without a special
 *     case, because it commits before the statement that uses the value.
 *   • `SET LOCAL` as its own statement does NOT work here, exactly as it
 *     does not work in the console. That is correct: the house rule is
 *     to wrap it in a `DO $$ ... PERFORM set_config(...) ... $$`, and a
 *     runner that quietly made the wrong form work would let the wrong
 *     form ship.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT REFUSES TO RUN OUT OF ORDER
 * ══════════════════════════════════════════════════════════════════════
 * If 0117 is unapplied and 0118 is not, running 0118 is refused with the
 * gap named. Files are written assuming their predecessors ran; applying
 * them out of order produces a schema that is neither the old one nor
 * the new one, and the failure surfaces weeks later in a query that
 * references a column that was never added.
 *
 * `--only` is the deliberate override, and it says so in the output.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IT WILL NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It has no `down`. There are no down migrations in this repository and
 * there should not be: several of these files add enum values, which
 * PostgreSQL cannot remove, and a `down` that silently does not undo
 * what `up` did is worse than no `down` at all. Rolling back a schema
 * here means restoring a branch, and `DEPLOY.md` says so.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { splitStatements } from "./lib/sql-statements.mjs";

const ROOT = process.cwd();
const DIR = join(ROOT, "SQL-FILES");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1] ?? null;
};

const MODE = {
  status: has("--status"),
  dryRun: has("--dry-run"),
  adopt: has("--adopt"),
  to: value("--to"),
  only: value("--only"),
  yes: has("--yes"),
};

/* ------------------------------------------------------------------ */
/* THE FILES                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `NNNN_name.sql` ONLY. `DRILL-…`, `VERIFY-…` and the historical
 * `ALL-IN-ONE-SETUP.sql` live in the same directory and are not
 * migrations. A runner that globbed `*.sql` would run the drills, and
 * the drills WRITE.
 */
function migrationFiles() {
  return readdirSync(DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .map((filename) => {
      const body = readFileSync(join(DIR, filename), "utf8");
      return {
        version: Number(filename.slice(0, 4)),
        filename,
        body,
        checksum: createHash("sha256").update(body, "utf8").digest("hex"),
        statements: splitStatements(body),
      };
    })
    .sort((a, b) => a.version - b.version);
}

/* ------------------------------------------------------------------ */
/* THE CONNECTION                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `DATABASE_URL_UNPOOLED` IS PREFERRED AND THE REASON IS NOT SPEED.
 * DDL through a connection pooler in transaction mode can land on a
 * different backend between statements, which is fine for this runner
 * (it opens a new connection per statement anyway) and is NOT fine for
 * the advisory-lock-shaped things a future version might do. Using the
 * direct URL keeps the door open and costs nothing.
 */
function connectionString() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "\n🔴 No DATABASE_URL_UNPOOLED or DATABASE_URL.\n\n" +
        "   This runner never takes a connection string as an argument, deliberately: a\n" +
        "   credential in a shell history is a credential in a backup of that shell\n" +
        "   history. Set it in the environment for the command.\n",
    );
    process.exit(2);
  }
  return url;
}

/**
 * 🔴 A PRODUCTION DATABASE NEEDS `--yes`.
 *
 * Not because the migrations are dangerous , they are idempotent , but
 * because the operator should have to say which database they meant.
 * The heuristic is deliberately loose: anything that is not obviously
 * local counts as production.
 */
function looksLocal(url) {
  return /@(localhost|127\.0\.0\.1|\/tmp|host\.docker\.internal)/.test(url);
}

async function withClient(url, fn) {
  const client = new pg.Client({
    connectionString: url,
    /** ⚠️ Neon requires TLS and rejects a client that does not ask for it. */
    ssl: looksLocal(url) ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/* ------------------------------------------------------------------ */
/* THE LEDGER                                                          */
/* ------------------------------------------------------------------ */

const LEDGER = "public.schema_migrations";

async function ledgerExists(url) {
  return withClient(url, async (c) => {
    const r = await c.query(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [LEDGER],
    );
    return Boolean(r.rows[0]?.present);
  });
}

async function readLedger(url) {
  return withClient(url, async (c) => {
    const r = await c.query(
      `SELECT version, filename, checksum, applied_at, applied_by
         FROM ${LEDGER} ORDER BY version`,
    );
    return new Map(r.rows.map((row) => [Number(row.version), row]));
  });
}

async function recordApplied(url, file, durationMs, adopted) {
  await withClient(url, async (c) => {
    await c.query(
      `INSERT INTO ${LEDGER}
         (version, filename, checksum, statement_count, applied_by, app_version, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (version) DO UPDATE SET
         checksum        = EXCLUDED.checksum,
         statement_count = EXCLUDED.statement_count,
         applied_at      = now(),
         applied_by      = EXCLUDED.applied_by,
         app_version     = EXCLUDED.app_version,
         duration_ms     = EXCLUDED.duration_ms`,
      [
        file.version,
        file.filename,
        file.checksum,
        file.statements.length,
        adopted ? "adopted" : process.env.MIGRATION_ACTOR ?? process.env.USER ?? "unknown",
        appVersion(),
        durationMs,
      ],
    );
  });
}

function appVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* APPLYING ONE FILE                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY STATEMENT ON A NEW CONNECTION, AND THE FAILURE STOPS THE FILE.
 *
 * Continuing past a failed statement is the behaviour of the console
 * only because a human is reading each result. Unattended, continuing
 * means the remaining statements run against a schema the file did not
 * expect , which is how a partial migration becomes a corrupt one.
 */
async function applyFile(url, file) {
  const started = Date.now();
  let index = 0;

  for (const statement of file.statements) {
    index += 1;
    const label = `${file.filename} [${index}/${file.statements.length}]`;
    try {
      await withClient(url, (c) => c.query(statement));
      process.stdout.write(`    ✅ ${label}\n`);
    } catch (err) {
      process.stdout.write(`    🔴 ${label}\n`);
      console.error(
        `\n       ${err.severity ?? "ERROR"} ${err.code ?? ""}: ${err.message}` +
          (err.detail ? `\n       DETAIL: ${err.detail}` : "") +
          (err.hint ? `\n       HINT: ${err.hint}` : ""),
      );
      console.error(
        `\n       The statement:\n\n${statement
          .split("\n")
          .map((l) => "         " + l)
          .join("\n")}\n`,
      );
      console.error(
        `🔴 ${file.filename} stopped at statement ${index}. Statements 1 to ${index - 1} have ` +
          `been applied and committed — every file here is idempotent, so fix the cause and\n` +
          `   run the same file again.\n`,
      );
      return { ok: false, durationMs: Date.now() - started, failedAt: index };
    }
  }

  return { ok: true, durationMs: Date.now() - started };
}

/* ------------------------------------------------------------------ */
/* MAIN                                                                */
/* ------------------------------------------------------------------ */

const url = connectionString();
const files = migrationFiles();

if (files.length === 0) {
  console.error("🔴 No NNNN_*.sql files in SQL-FILES/.");
  process.exit(1);
}

const hasLedger = await ledgerExists(url);

if (!hasLedger) {
  /**
   * ⚠️ THE LEDGER IS ITSELF A MIGRATION, so the first run has a
   * chicken-and-egg problem and it is solved by saying so rather than by
   * creating the table silently. A tool that creates schema it was not
   * asked to create is a tool nobody can predict.
   */
  console.log(
    `\n⚠️  ${LEDGER} does not exist on this database.\n\n` +
      `   It is created by SQL-FILES/0120_schema_migrations.sql, which is itself a\n` +
      `   migration. Apply that one file first:\n\n` +
      `       node scripts/migrate.mjs --only 0120\n\n` +
      `   Then, on a database that already has migrations applied:\n\n` +
      `       node scripts/migrate.mjs --adopt\n`,
  );
  if (!MODE.only) process.exit(1);
}

const applied = hasLedger ? await readLedger(url) : new Map();

/* ---- --status ------------------------------------------------------ */

if (MODE.status) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log("\n" + "═".repeat(78));
  console.log(`  MIGRATIONS  ·  ${files.length} files  ·  ${applied.size} recorded as applied`);
  console.log("═".repeat(78));

  let drift = 0;
  for (const file of files) {
    const row = applied.get(file.version);
    if (!row) {
      console.log(`  ⬜ ${pad(file.filename, 52)} not applied`);
      continue;
    }
    /**
     * ⚠️ A CHECKSUM MISMATCH IS REPORTED AND IS NOT AN ERROR. A corrected
     * comment changes the checksum and changes nothing else. Refusing
     * would teach people to edit the ledger by hand, which is the one
     * habit that makes it worthless.
     */
    const changed = row.checksum !== file.checksum;
    if (changed) drift += 1;
    console.log(
      `  ${changed ? "🟨" : "✅"} ${pad(file.filename, 52)} ` +
        `${new Date(row.applied_at).toISOString().slice(0, 16).replace("T", " ")}` +
        `${row.applied_by === "adopted" ? "  (adopted)" : ""}` +
        `${changed ? "  ← file has changed since" : ""}`,
    );
  }
  console.log("═".repeat(78));
  const outstanding = files.filter((f) => !applied.has(f.version));
  console.log(
    `  ${outstanding.length} outstanding` +
      (drift > 0 ? `  ·  ${drift} file(s) edited after being applied` : ""),
  );
  console.log("");
  process.exit(0);
}

/* ---- --adopt ------------------------------------------------------- */

if (MODE.adopt) {
  const toAdopt = files.filter((f) => !applied.has(f.version));
  console.log(
    `\n⚠️  ADOPTING ${toAdopt.length} file(s) as already applied, WITHOUT RUNNING THEM.\n\n` +
      `   Every row is written with applied_by = 'adopted' so nobody ever mistakes\n` +
      `   an adopted row for an observed one. Do this ONCE, on a database you know\n` +
      `   is up to date.\n`,
  );
  if (!looksLocal(url) && !MODE.yes) {
    console.error("🔴 This does not look like a local database. Add --yes if you meant it.\n");
    process.exit(1);
  }
  for (const file of toAdopt) {
    await recordApplied(url, file, 0, true);
    console.log(`  ✅ adopted ${file.filename}`);
  }
  console.log(`\n${toAdopt.length} adopted.\n`);
  process.exit(0);
}

/* ---- what to run --------------------------------------------------- */

let queue;

if (MODE.only) {
  const version = Number(MODE.only);
  const file = files.find((f) => f.version === version);
  if (!file) {
    console.error(`🔴 No migration numbered ${MODE.only}.`);
    process.exit(1);
  }
  console.log(
    `\n⚠️  --only ${MODE.only}: running one file, out of order if it is out of order.\n` +
      `   This is the deliberate override. Files assume their predecessors ran.\n`,
  );
  queue = [file];
} else {
  queue = files.filter((f) => !applied.has(f.version));
  if (MODE.to) queue = queue.filter((f) => f.version <= Number(MODE.to));

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE OUT-OF-ORDER CHECK, AND WHAT IT ACTUALLY CATCHES
   * ══════════════════════════════════════════════════════════════════
   * The queue is always in ascending order and always starts at the
   * lowest outstanding file, so "a gap below the queue" cannot happen.
   * Writing that check would have been writing a check that never fires,
   * which this codebase has found eighteen times and is done finding.
   *
   * What CAN happen, and what this refuses, is the opposite: a file in
   * the queue numbered BELOW something already applied. That means the
   * database was migrated out of order at some point , almost always by
   * `--only`, or by somebody pasting one file into the console , and the
   * older file is now about to run against a schema its author never
   * saw.
   *
   * ⚠️ 0118 IS THE CONCRETE EXAMPLE. It adds an enum value. If 0119 has
   * already run and 0118 has not, 0118's later statements are executing
   * against a rate-limit schema that did not exist when it was written.
   * Nothing may break. That is the problem: nothing may break for weeks.
   */
  const highestApplied = Math.max(-1, ...[...applied.keys()]);
  const backwards = queue.filter((f) => f.version < highestApplied);

  if (backwards.length > 0) {
    console.error(
      `\n🔴 Refusing: this database has already applied migration ` +
        `${String(highestApplied).padStart(4, "0")}, and ` +
        `${backwards.map((b) => b.filename).join(", ")} ` +
        `${backwards.length === 1 ? "is" : "are"} numbered below it.\n\n` +
        `   The database was migrated out of order at some point. Running an older file\n` +
        `   now executes it against a schema its author never saw — and the failure\n` +
        `   surfaces weeks later, in a query referencing a column that was never added,\n` +
        `   rather than here.\n\n` +
        `   Look at \`node scripts/migrate.mjs --status\` first. Use --only, once per\n` +
        `   file, if you have read them and you mean it.\n`,
    );
    process.exit(1);
  }
}

if (queue.length === 0) {
  console.log("\n✅ Nothing outstanding.\n");
  process.exit(0);
}

/* ---- --dry-run ------------------------------------------------------ */

if (MODE.dryRun) {
  console.log(`\n${queue.length} file(s) would run, in this order:\n`);
  for (const file of queue) {
    console.log(`  ${file.filename}  ·  ${file.statements.length} statements`);
    for (const [i, statement] of file.statements.entries()) {
      const first = statement
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("--"))[0];
      console.log(`      ${String(i + 1).padStart(3)}. ${(first ?? "").slice(0, 92)}`);
    }
    console.log("");
  }
  console.log("Nothing was executed.\n");
  process.exit(0);
}

/* ---- apply ---------------------------------------------------------- */

if (!looksLocal(url) && !MODE.yes) {
  console.error(
    `\n🔴 This does not look like a local database and ${queue.length} file(s) would be applied.\n\n` +
      `   Add --yes when you mean it. Run --dry-run first if you are not sure what\n` +
      `   would happen.\n`,
  );
  process.exit(1);
}

console.log(`\nApplying ${queue.length} file(s)…\n`);

let appliedCount = 0;
for (const file of queue) {
  console.log(`  ── ${file.filename}  (${file.statements.length} statements)`);
  const result = await applyFile(url, file);
  if (!result.ok) {
    console.error(
      `\n${appliedCount} file(s) applied before this one. The ledger records them; run again ` +
        `after fixing the cause.\n`,
    );
    process.exit(1);
  }
  await recordApplied(url, file, result.durationMs, false);
  appliedCount += 1;
  console.log(`     recorded  ·  ${result.durationMs} ms\n`);
}

console.log(`✅ ${appliedCount} file(s) applied and recorded.\n`);
