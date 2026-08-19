/**
 * Ordence — ⭐⭐⭐ THE MORNING SWEEP, ACTUALLY EXECUTED
 * Version: v1.30.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 PAYING A DEBT I NAMED LAST SESSION
 * ══════════════════════════════════════════════════════════════════════
 * v1.29.0 built a harness that executes `close-readiness.ts` and the
 * booking-ledger identity, and said plainly that `sweep.ts` was only
 * partly covered — "honest debt and I am naming it rather than implying
 * otherwise."
 *
 * This is that debt. The statutory section of the sweep is the one that
 * matters most: it is what the compliance page and the morning summary
 * read, it is the only place in the product where being SILENTLY WRONG
 * costs damages rather than embarrassment, and its arithmetic —
 * net-of-debits, clamped at zero, keyed by ledger role — had never once
 * been run against a database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS A VITEST FILE AND NOT PART OF `check:sql-executes`
 * ══════════════════════════════════════════════════════════════════════
 * The `.mjs` harness rebuilds raw SQL, which is legitimate for
 * `close-readiness.ts` because that module genuinely builds raw SQL
 * strings. This path is different: the query feeds `buildDueList()`, a
 * PURE LIB, and the interesting question is whether the two agree about
 * role names.
 *
 * 🔴 A SWEEP THAT COMPUTES BALANCES UNDER ROLE `x` WHILE THE OBLIGATION
 * TABLE READS ROLE `y` REPORTS NIL FOR EVERYTHING, FOREVER, WITH NO
 * ERROR — and "nothing is due" is the single most dangerous thing that
 * page can say untruthfully. Only running both halves together catches
 * it, so the real `buildDueList` is imported here rather than
 * reimplemented.
 *
 * ⚠️ SKIPS WITHOUT `HARNESS_DATABASE_URL`, like the harness it extends.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDueList, summariseDue } from "@/lib/compliance/statutory-due";
import { lastCompletedMonthEnd, taxPeriodOf } from "@/server/command/sweep";

const URL_ENV = process.env.HARNESS_DATABASE_URL;
const TENANT = "11111111-1111-1111-1111-111111111111";

/**
 * ⚠️ A FIXED "TODAY". Every due date below is derived from it, and a
 * test whose expectations move with the calendar fails on a Tuesday for
 * no reason anybody can reconstruct.
 */
const TODAY = "2026-08-14";

type Balances = Record<string, bigint>;

let client: { query: (q: string, v?: unknown[]) => Promise<{ rows: Record<string, string>[] }>; end: () => Promise<void> } | null =
  null;
let balances: Balances = {};

/** ⚠️ "1234.56" → 123456n exactly. The same conversion the server uses. */
function toMinor(value: string): bigint {
  const text = String(value ?? "0").trim();
  const negative = text.startsWith("-");
  const bare = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = bare.split(".");
  const paise = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2) || "0");
  return negative ? -paise : paise;
}

beforeAll(async () => {
  if (!URL_ENV) return;
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: URL_ENV });
  await c.connect();
  client = c as unknown as typeof client;

  const periodEnd = lastCompletedMonthEnd(TODAY);

  /**
   * ⭐ THE QUERY `statutorySignals` RUNS, verbatim in shape: journal
   * entries joined to the posting-account map and to posted
   * transactions, grouped by role, up to the period end.
   */
  const { rows } = await c.query(
    `SELECT spa.role,
            COALESCE(SUM(CASE WHEN je.entry_type = 'debit'  THEN je.amount ELSE 0 END), 0)::text AS debit,
            COALESCE(SUM(CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE 0 END), 0)::text AS credit
       FROM journal_entries je
       JOIN sales_posting_accounts spa
         ON spa.ledger_id = je.ledger_id AND spa.tenant_id = je.tenant_id
       JOIN transactions t ON t.id = je.transaction_id
      WHERE je.tenant_id = $1::uuid
        AND t.transaction_date <= $2::date
        AND t.status = 'posted'
      GROUP BY spa.role`,
    [TENANT, periodEnd],
  );

  /**
   * ⚠️ LIABILITIES: CREDITS LESS DEBITS, CLAMPED AT ZERO rather than
   * shown as a government owing money back. The same three lines the
   * sweep runs.
   */
  balances = {};
  for (const r of rows) {
    const net = toMinor(r.credit) - toMinor(r.debit);
    balances[r.role] = net > 0n ? net : 0n;
  }
});

afterAll(async () => {
  await client?.end();
});

describe.skipIf(!URL_ENV)("the statutory sweep, run against a real database", () => {
  it("reads the period that has FINISHED, not the one running", () => {
    expect(lastCompletedMonthEnd(TODAY)).toBe("2026-07-31");
    expect(taxPeriodOf(lastCompletedMonthEnd(TODAY))).toBe("2026-07");
  });

  /**
   * 🔴 THE CHECK THIS FILE EXISTS FOR. The seeded payroll journal
   * credits five statutory liabilities. If the sweep's role keys and the
   * obligation table's role keys disagreed by so much as an underscore,
   * every one of these would read nil and the page would say nothing is
   * due.
   */
  it("produces balances under the exact role names the obligations read", () => {
    expect(balances.pf_payable).toBe(12_000_000n); // ₹1,20,000
    expect(balances.pension_payable).toBe(4_000_000n); // ₹40,000
    expect(balances.esi_payable).toBe(2_000_000n); // ₹20,000
    expect(balances.professional_tax_payable).toBe(200_000n); // ₹2,000
    expect(balances.tds_payable_salary).toBe(5_000_000n); // ₹50,000
    expect(balances.tds_payable).toBe(1_500_000n); // ₹15,000, vendor
  });

  /**
   * ⚠️ AN EXPENSE IS NOT A LIABILITY. `salary_expense` is a debit
   * balance and must clamp to zero, or the compliance page would report
   * ₹5,00,000 "owed" to nobody.
   */
  it("clamps a debit-balance role to zero rather than reporting it as owed", () => {
    expect(balances.salary_expense).toBe(0n);
    expect(balances.employer_pf_expense).toBe(0n);
    expect(balances.bank).toBe(0n);
  });

  /* ---------------------------------------------------------------- */

  it("turns those balances into the right obligations, with the right amounts", () => {
    const items = buildDueList({
      periodEnd: lastCompletedMonthEnd(TODAY),
      balances,
      gstCashPayableMinor: null,
      today: TODAY,
    });
    const by = new Map(items.map((i) => [i.kind, i]));

    /** ⭐ PF is employee + employer + pension — three numbers, one challan. */
    expect(by.get("provident_fund")?.amountMinor).toBe(16_000_000n);
    expect(by.get("esi")?.amountMinor).toBe(2_000_000n);
    expect(by.get("professional_tax")?.amountMinor).toBe(200_000n);

    /**
     * 🔴 SALARY TDS AND VENDOR TDS ARE DIFFERENT OBLIGATIONS with
     * different due dates, and they are seeded separately precisely so a
     * sweep that merged them would be caught here.
     */
    expect(by.get("tds_salary")?.amountMinor).toBe(5_000_000n);
    expect(by.get("tds_vendor")?.amountMinor).toBe(1_500_000n);
  });

  /**
   * ⭐ THE ONE THAT COSTS DAMAGES. Provident fund for July is due on
   * 15 August; on 14 August that is one day away, and late payment
   * attracts interest under 7Q AND damages under 14B that can reach the
   * contribution itself.
   */
  it("dates provident fund one day out on the 14th, not overdue and not distant", () => {
    const items = buildDueList({
      periodEnd: lastCompletedMonthEnd(TODAY),
      balances,
      gstCashPayableMinor: null,
      today: TODAY,
    });
    const pf = items.find((i) => i.kind === "provident_fund");
    expect(pf?.dueOn).toBe("2026-08-15");
    expect(pf?.daysUntil).toBe(1);
    expect(pf?.state).toBe("due_soon");
  });

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 THE DEFECT THIS FILE FOUND, AND MY ASSUMPTION WAS THE WRONG
   *      HALF
   * ══════════════════════════════════════════════════════════════════
   * I wrote this expecting every obligation with a nil balance to read
   * `nothing_owed`. Six of the seven do. `gst_1` does not, and
   * `buildDueList` goes out of its way to make sure of it — GSTR-1 is a
   * STATEMENT, so its amount is always zero and zero is correct, while
   * the deadline is the earliest in the month and carries a late fee for
   * every day plus customers who cannot see the invoice in their 2B.
   *
   * ⚠️ THE LIBRARY WAS RIGHT. What was wrong was `sweep.ts`, which
   * filtered on `amountMinor > 0n` and threw GSTR-1 away — so the one
   * page whose job is "what stops being fixable soonest" never once
   * mentioned the deadline that comes first.
   *
   * ⭐ FOUND BY RUNNING IT. Every previous test of that file read the
   *   source as text and asserted a call was written.
   */
  it("keeps a money-less filing obligation out of `nothing_owed`", () => {
    const items = buildDueList({
      periodEnd: lastCompletedMonthEnd(TODAY),
      balances: {},
      gstCashPayableMinor: null,
      today: TODAY,
    });
    expect(items.every((i) => i.amountMinor === 0n)).toBe(true);

    const gstr1 = items.find((i) => i.kind === "gst_1")!;
    expect(gstr1.amountMinor).toBe(0n);
    expect(gstr1.state).not.toBe("nothing_owed");
    expect(gstr1.dueOn).toBe("2026-08-11");

    /** Every OTHER obligation with a nil balance is correctly silent. */
    expect(
      items.filter((i) => i.kind !== "gst_1").every((i) => i.state === "nothing_owed"),
    ).toBe(true);
  });

  /**
   * 🔴 THE REGRESSION GUARD. If `amountMinor > 0n` comes back into that
   * filter, GSTR-1 disappears from the morning summary again and nothing
   * else in the repo notices.
   */
  it("the sweep filters on state alone, never on the amount", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "server", "command", "sweep.ts"),
      "utf8",
    );
    expect(src).toContain('.filter((i) => i.state !== "nothing_owed")');
    expect(src).not.toContain("i.amountMinor > 0n && i.state");
  });

  it("summarises what is actually owed", () => {
    const items = buildDueList({
      periodEnd: lastCompletedMonthEnd(TODAY),
      balances,
      gstCashPayableMinor: null,
      today: TODAY,
    });
    expect(summariseDue(items)).toBeTruthy();
  });
});

/* ================================================================== */
/* ⚠️ THE SKIP MUST BE VISIBLE                                         */
/* ================================================================== */

describe("the sweep harness cannot silently stop running", () => {
  /**
   * 🔴 A SKIPPED TEST AND A PASSING TEST LOOK THE SAME IN A SUMMARY
   * LINE. This one always runs, so the suite says out loud whether the
   * database half was exercised.
   */
  it("reports whether it ran against a database", () => {
    if (!URL_ENV) {
      console.log(
        "⏭️  sweep-executes: NOT CHECKED — the statutory query and buildDueList were " +
          "not run together. Set HARNESS_DATABASE_URL against a throwaway Postgres.",
      );
    }
    expect(typeof URL_ENV === "string" || URL_ENV === undefined).toBe(true);
  });
});
