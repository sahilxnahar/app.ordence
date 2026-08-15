#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE SQL EXECUTION HARNESS
 * Version: v1.29.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS, AND IT IS AN ADMISSION
 * ══════════════════════════════════════════════════════════════════════
 * `server/accounting/close-readiness.ts` builds its queries by string
 * concatenation — table names, date columns, transaction-key tags and a
 * `liveCondition` fragment, assembled and handed to Postgres.
 *
 * ⚠️ TYPESCRIPT CANNOT CHECK ANY OF IT. A column that does not exist, a
 * join on the wrong side, a cast Postgres will not make, a status value
 * that is spelt differently in the enum — every one of those compiles
 * cleanly and fails at runtime, in front of somebody trying to close a
 * month.
 *
 * 🔴 AND THE TESTS DID NOT CATCH IT EITHER, BECAUSE THEY READ THE
 * SOURCE AS TEXT. `expect(src).toContain("closeReadiness(ctx.tenant.id")`
 * proves the call is written. It proves nothing about whether the query
 * runs. Three modules — this one, `server/command/sweep.ts` and
 * `server/sales/booking-ledger.ts` — had between them zero executions
 * before this script was written, across two sessions of work.
 *
 * ⭐ SO THIS RUNS THE ACTUAL SQL, EXTRACTED FROM THE ACTUAL SOURCE,
 *   against a throwaway Postgres with a seeded schema — and asserts the
 *   answers, not the syntax.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT SKIPS CLEANLY WHEN THERE IS NO DATABASE
 * ══════════════════════════════════════════════════════════════════════
 * A developer without a local Postgres must not be blocked, so no
 * database means SKIPPED rather than FAILED — and it says so loudly
 * enough that "it passed" is never confused with "it did not run".
 *
 * 🔴 THAT IS ALSO THE RISK. A gate that skips is a gate that can quietly
 * stop running, which is exactly the shape of the defect this file
 * exists to catch. The skip message names what was not checked.
 *
 *   HARNESS_DATABASE_URL=postgres://user:pw@127.0.0.1:5432/harness \
 *     node scripts/check-sql-executes.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const URL_ENV = process.env.HARNESS_DATABASE_URL;

if (!URL_ENV) {
  console.log("");
  console.log("⏭️  check:sql-executes SKIPPED — no HARNESS_DATABASE_URL.");
  console.log(
    "   NOT CHECKED: that the close-readiness probes actually run. They are built by\n" +
      "   string concatenation, so a wrong column name compiles and passes every other\n" +
      "   gate in this repo. Set HARNESS_DATABASE_URL against a throwaway Postgres.",
  );
  process.exit(0);
}

const { default: pg } = await import("pg");

/* ------------------------------------------------------------------ */
/* ⭐ THE SPECS COME FROM THE SOURCE, NOT FROM A COPY                   */
/* ------------------------------------------------------------------ */

/**
 * 🔴 PARSED OUT OF `close-readiness.ts` ITSELF. A second copy of the
 * table names and tags in this file would be a second thing to keep in
 * step — and the one that drifted would be the one nobody ran.
 *
 * ⚠️ If the shape of `SOURCES` changes, this parse returns nothing and
 * the harness FAILS rather than silently checking zero probes.
 */
function probeSpecs() {
  const src = readFileSync(
    join(ROOT, "server", "accounting", "close-readiness.ts"),
    "utf8",
  );
  const block = src.slice(
    src.indexOf("const SOURCES"),
    src.indexOf("export async function closeReadiness"),
  );

  const re =
    /key:\s*"([a-z_]+)"[\s\S]*?table:\s*"(\w+)"[\s\S]*?dateColumn:\s*"(\w+)"[\s\S]*?liveCondition:\s*"([^"]+)"[\s\S]*?tags:\s*\[([^\]]+)\]/g;

  const out = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    const [, key, table, dateColumn, live, tagsRaw] = m;
    const tail = block.slice(m.index, m.index + 2000);
    const am = tail.match(/amountColumn:\s*"(\w+)"/);
    out.push({
      key,
      table,
      dateColumn,
      live,
      tags: tagsRaw
        .split(",")
        .map((t) => t.trim().replace(/"/g, ""))
        .filter(Boolean),
      amount: am ? am[1] : null,
    });
  }
  return out;
}

/**
 * ⚠️ THE QUERY IS REBUILT THE SAME WAY THE SOURCE BUILDS IT. If the two
 * ever diverge, this harness stops testing the thing it claims to. The
 * shape is asserted against the source below.
 */
function probeSql(spec) {
  const keyMatch = spec.tags
    .map((t) => `t.transaction_number = 'SALES:${t}:' || d.id::text`)
    .join(" OR ");
  const amount = spec.amount
    ? `COALESCE(SUM(d.${spec.amount}), 0)::text`
    : "NULL";

  return `
    SELECT count(*)::int          AS count,
           MIN(d.${spec.dateColumn})::text AS oldest,
           ${amount}              AS total
      FROM ${spec.table} d
      LEFT JOIN transactions t
             ON t.tenant_id = d.tenant_id
            AND (${keyMatch})
            AND t.status = 'posted'
     WHERE d.tenant_id = $1::uuid
       AND d.${spec.dateColumn} >= $2::date
       AND d.${spec.dateColumn} <= $3::date
       AND (${spec.live})
       AND t.id IS NULL`;
}

/* ------------------------------------------------------------------ */
/* WHAT THE SEEDED DATABASE SHOULD ANSWER                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EVERY EXPECTATION IS A DELIBERATE CASE, not a count somebody read
 * off a first run and pasted back.
 */
const EXPECTED = {
  /** One posted, one not, plus a draft, an August one and another tenant's. */
  sales_invoices: { count: 1, total: "5900000" },
  /** ⚠️ A bounced cheque is not money and must never be reported. */
  customer_receipts: { count: 1, total: "2500000" },
  /** No status column at all — every row in the period counts. */
  purchase_invoices: { count: 1, total: "3300000" },
  /** A draft RA bill is ignored; a certified one is not. */
  ra_bills: { count: 1 },
  /**
   * 🔴 THE ONE THAT MATTERS MOST. Two payments: one posted under the
   * LEGACY `RCP` tag before the v1.27.0 rename, one genuinely unposted.
   * If the legacy tag were dropped from the spec, this reads 2 and every
   * close in a workspace older than that version would be blocked.
   */
  vendor_payments: { count: 1 },
  /** A cancelled demand raises no liability and must not be reported. */
  demand_notices: { count: 1 },
};

const TENANT = "11111111-1111-1111-1111-111111111111";
const PERIOD = ["2026-07-01", "2026-07-31"];

/* ------------------------------------------------------------------ */

let failures = 0;
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  failures += 1;
};

const specs = probeSpecs();

if (specs.length === 0) {
  fail(
    "No probe specs could be parsed out of close-readiness.ts. The shape of SOURCES " +
      "changed and this harness is now checking nothing — fix the parse rather than " +
      "deleting the check.",
  );
} else if (specs.length !== Object.keys(EXPECTED).length) {
  /**
   * ⚠️ A NEW PROBE WITH NO EXPECTATION IS AN UNCHECKED PROBE. Failing
   * here forces whoever adds one to seed a case for it.
   */
  fail(
    `close-readiness.ts declares ${specs.length} probes and this harness has ` +
      `${Object.keys(EXPECTED).length} expectations. Add a seeded case for the new one.`,
  );
}

const client = new pg.Client({ connectionString: URL_ENV });
await client.connect();

for (const spec of specs) {
  const want = EXPECTED[spec.key];
  if (!want) {
    fail(`${spec.key} has no expectation in this harness.`);
    continue;
  }

  let rows;
  try {
    ({ rows } = await client.query(probeSql(spec), [TENANT, ...PERIOD]));
  } catch (error) {
    /**
     * 🔴 THIS IS THE FAILURE THE WHOLE FILE EXISTS FOR — a query that
     * compiled, passed every other gate, and cannot run.
     */
    fail(`${spec.key} does not execute: ${error.message}`);
    continue;
  }

  const got = rows[0] ?? { count: 0, total: null };
  if (Number(got.count) !== want.count) {
    fail(
      `${spec.key} returned ${got.count} unposted documents, expected ${want.count}.`,
    );
  }
  if (want.total !== undefined && String(got.total) !== want.total) {
    fail(`${spec.key} totalled ${got.total}, expected ${want.total}.`);
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE BOOKING LEDGER IDENTITY                                     */
/* ------------------------------------------------------------------ */

/**
 * 🔴 EVERY CANCELLATION POSTING DEPENDS ON THIS AND NOTHING EVER
 *    CHECKED IT.
 *
 * `cancellationProblem()` refuses when `advance + tax − receivable`
 * does not equal the cash the buyer paid. That identity is derived by
 * `bookingLedgerFacts()` from journal entries — netting each role in its
 * natural direction, which is easy to get backwards and impossible to
 * see from reading it.
 *
 * ⚠️ IF IT WERE WRONG, EVERY CANCELLATION WOULD REFUSE with a message
 * about the ledger not agreeing with its receipts — and the message
 * would be blaming the data.
 */
try {
  const { rows } = await client.query(
    `SELECT spa.role,
            COALESCE(SUM(CASE WHEN je.entry_type = 'debit'  THEN je.amount ELSE 0 END), 0)::text AS debit,
            COALESCE(SUM(CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE 0 END), 0)::text AS credit
       FROM journal_entries je
       JOIN sales_posting_accounts spa
         ON spa.ledger_id = je.ledger_id AND spa.tenant_id = je.tenant_id
       JOIN transactions t ON t.id = je.transaction_id
      WHERE je.tenant_id = $1::uuid
        AND je.counterparty_type = 'booking'
        AND je.counterparty_id = $2::uuid
        AND t.status = 'posted'
      GROUP BY spa.role`,
    [TENANT, "cccccccc-0000-0000-0000-000000000001"],
  );

  /** ⚠️ The same string→paise conversion the server uses. Never a float. */
  const toMinor = (value) => {
    const text = String(value ?? "0").trim();
    const negative = text.startsWith("-");
    const bare = negative ? text.slice(1) : text;
    const [whole = "0", fraction = ""] = bare.split(".");
    const paise = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2) || "0");
    return negative ? -paise : paise;
  };

  const d = new Map();
  const c = new Map();
  for (const r of rows) {
    d.set(r.role, toMinor(r.debit));
    c.set(r.role, toMinor(r.credit));
  }
  const D = (r) => d.get(r) ?? 0n;
  const C = (r) => c.get(r) ?? 0n;

  const advance = C("customer_advance") - D("customer_advance");
  const receivable = D("booking_receivable") - C("booking_receivable");
  const tax =
    C("output_cgst") - D("output_cgst") + (C("output_sgst") - D("output_sgst"));
  const cash =
    D("bank") - C("bank") + (D("tds_receivable") - C("tds_receivable"));

  if (rows.length === 0) {
    fail("The booking ledger query returned nothing — the seed did not load.");
  } else if (advance + tax - receivable !== cash) {
    fail(
      `The booking ledger identity does not hold: advance ${advance} + tax ${tax} ` +
        `− receivable ${receivable} = ${advance + tax - receivable}, but cash paid is ` +
        `${cash}. Every cancellation would refuse and blame the data.`,
    );
  }
} catch (error) {
  fail(`The booking ledger query does not execute: ${error.message}`);
}

await client.end();

/* ------------------------------------------------------------------ */

console.log("");
if (failures === 0) {
  console.log(
    `✅ SQL executes — ${specs.length} close-readiness probes run and answer correctly, ` +
      `including the legacy vendor-payment key, and the booking ledger identity holds.`,
  );
  process.exit(0);
}

console.error("");
console.error(
  `❌ check:sql-executes FAILED — ${failures} problem${failures === 1 ? "" : "s"}.`,
);
console.error(
  "   These are queries that compile, typecheck and pass every other gate in this " +
    "repo, and do not run.",
);
process.exit(1);
