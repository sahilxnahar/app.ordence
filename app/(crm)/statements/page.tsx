/**
 * Ordence — Financial statements
 * Version: v1.43.0-alpha (Batch 37)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WAVE 1 — P&L AND BALANCE SHEET FROM THE LEDGER THAT ALREADY BALANCES
 * ══════════════════════════════════════════════════════════════════════
 * The double-entry ledger has existed since Phase 4, enforced by a database
 * trigger rather than application code, and there was no way to look at it
 * except as a trial balance. These are the two statements every developer,
 * lender and auditor actually asks for.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BATCH 37 — THEY NOW COVER A PERIOD, AND THE TWO PERIODS DIFFER
 * ══════════════════════════════════════════════════════════════════════
 * Both statements used to be since inception, with no parameter anywhere
 * in the path. A customer in year two could not produce a financial-year
 * P&L at all: the page showed two years of revenue against two years of
 * cost, cross-footed perfectly, and said nothing about what range it was.
 *
 * The page now takes `?from=&to=` and defaults to the current Indian
 * financial year (1 April – 31 March). See `lib/accounting/periods.ts`
 * for why "all of time" was the wrong default.
 *
 * 🔴 THE P&L AND THE BALANCE SHEET DO NOT USE THE SAME WINDOW.
 * A P&L is a film: revenue and costs BETWEEN two dates.
 * A balance sheet is a photograph: what is owned and owed AT one date,
 * accumulated from inception. `getBalanceSheet` is deliberately given no
 * from-date. Give it one and the opening bank balance, the fixed assets,
 * the capital and the loans all drop out — and the statement still
 * balances while doing it, because any set of whole transactions
 * balances. It simply reports a company that owns nothing.
 *
 * ⚠️ WHICH IS WHY "RETAINED RESULT BROUGHT FORWARD" IS ON THE PAGE.
 * The accounting identity holds over a single window:
 *   Assets = Liabilities + Equity + (Revenue − Expenses)
 * with all four measured to the same date. The P&L shows only this
 * period's slice of that last term. The rest — last year's profit — is
 * shown as its own line. Omit it and every year-two customer is told in
 * red that their accounts do not balance.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ DERIVED, NEVER STORED
 * ══════════════════════════════════════════════════════════════════════
 * Both statements are computed from the ledger on every load. No cached
 * "statement" row exists, and none should — a stored statement is a
 * second version of the truth that drifts the moment somebody posts a
 * back-dated journal, and it drifts silently.
 *
 * ⚠️ SIGN CONVENTION, STATED ONCE.
 * `balance` from the server is debit-positive. That is correct for
 * assets and expenses, and inverted for liabilities, equity and revenue —
 * a liability of ₹10,000 arrives as -10000.00. So those three
 * categories are negated exactly once, here, at the presentation edge.
 * Getting this wrong produces a balance sheet that balances at zero and
 * means nothing.
 *
 * ⚠️ THE ACCOUNTING IDENTITY IS CHECKED AND SHOWN.
 * If it does not hold, the page says so at the top in red rather than
 * rendering two plausible-looking statements. A statement that is wrong
 * and confident is worse than no statement, because somebody files from
 * it.
 *
 * ⚠️ TRUST AND ESCROW LEDGERS ARE FLAGGED. Client money held on trust is
 * legally not the firm's asset. It appears on the balance sheet because it
 * must, and it is marked, because treating it as available cash is a
 * regulatory breach rather than an accounting error.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ BATCH 65 — THE THIRD STATEMENT
 * ══════════════════════════════════════════════════════════════════════
 * A profitable business runs out of money, and neither statement above
 * says so. The P&L reports ₹40 lakh of profit, the balance sheet reports
 * ₹40 lakh of receivables, and the bank has ₹11,000 in it. The cash flow
 * statement below is the one that connects them.
 *
 * 🔴 AND IT EITHER RECONCILES OR IT REFUSES TO RENDER. The closing cash
 * figure is computed two ways — built up from profit and the movements in
 * every non-cash account, and read straight off the cash and bank
 * ledgers — and if the two disagree the card shows the reasons and NO
 * FIGURES AT ALL. Not a number in amber, not a number with an asterisk.
 * Somebody decides whether to make payroll from this page, and a number
 * that is nearly right is acted on exactly like a number that is right.
 * See `lib/accounting/cash-flow.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BATCH 65 ALSO CHANGED THE NUMBERS IN THE TWO STATEMENTS ABOVE
 * ══════════════════════════════════════════════════════════════════════
 * Nothing in the statement path filtered `transactions.status`, so void
 * and unposted transactions were being counted as facts. All three
 * statements now include `posted` and `reversed` transactions and
 * nothing else — `reversed` is IN because a reversal is a separate
 * `posted` row and the entry it reverses is the `reversed` one, so
 * dropping `reversed` would leave every correction in the books with
 * nothing to correct. The full reasoning is on
 * `STATEMENT_TRANSACTION_STATUSES` in `server/actions/accounting.ts`.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  getProfitAndLoss,
  getBalanceSheet,
  getCashFlowStatement,
  type CashFlowResult,
} from "@/server/actions/accounting";
import {
  resolveStatementPeriod,
  previousFyFor,
  describePeriod,
  formatIso,
  todayInIndia,
  type StatementPeriod,
} from "@/lib/accounting/periods";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Financial statements · Ordence" };

function inr(minorUnits: string | bigint | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "₹0.00";
  const raw = String(minorUnits);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SERVER SENDS "1234.56". THIS PAGE COUNTS IN PAISE.
 * ══════════════════════════════════════════════════════════════════════
 * This conversion was missing entirely. The page did `BigInt(row.balance)`
 * on a value the accounting action produces with `fromMinorUnits`, i.e.
 * a two-decimal string — and `BigInt("1234.56")` does not round, it
 * THROWS. Any tenant with a single ledger row crashed this page on load,
 * including the ₹0.00 case, because `BigInt("0.00")` throws too.
 *
 * ⚠️ PARSED BY STRING SURGERY, NOT `Number(x) * 100`. A rupee value
 * large enough to matter to a lender is past the point where a double
 * multiplied by 100 still lands on an integer, and money is never a
 * float here.
 */
function toMinor(decimal: string | null | undefined): bigint {
  const raw = (decimal ?? "0").trim();
  if (raw === "") return 0n;
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [whole = "0", frac = ""] = body.split(".");
  // A malformed value must not be silently read as zero — but it must not
  // take the whole statement down either. Non-digits parse as nothing,
  // which shows up as a broken identity check rather than a 500.
  const wholeMinor = /^\d*$/.test(whole) ? BigInt(whole || "0") * 100n : 0n;
  const fracMinor = BigInt((frac.replace(/\D/g, "") + "00").slice(0, 2));
  const minor = wholeMinor + fracMinor;
  return negative ? -minor : minor;
}

type Row = {
  ledgerId: string;
  code: string;
  name: string;
  type: string;
  accountType: string;
  balance: string;
};

/**
 * Debit-positive balance → the sign a reader expects for that category.
 *
 * ⚠️ The ONLY place this inversion happens. See the header.
 */
function presentationBalance(row: Row): bigint {
  const raw = toMinor(row.balance);
  return row.accountType === "asset" || row.accountType === "expense" ? raw : -raw;
}

/** Ledger types that are not the firm's own money. */
const RESTRICTED_TYPES = new Set(["trust", "escrow", "retention"]);

function Section({
  title,
  rows,
  total,
}: {
  title: string;
  rows: Array<Row & { presented: bigint }>;
  total: bigint;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between border-b px-4 py-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide">{title}</h3>
        <span className="font-medium tabular-nums">{inr(total)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.ledgerId} className="flex items-baseline gap-3 px-4 py-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
              <span className="flex-1">
                {r.name}
                {RESTRICTED_TYPES.has(r.type) && (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    {r.type} — not the firm&apos;s money
                  </Badge>
                )}
              </span>
              <span className="tabular-nums">{inr(r.presented)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ CASH FLOW — INDIRECT METHOD                                    */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THESE FIGURES ARE ALREADY IN THE READER'S SIGN. DO NOT FLIP THEM.
 * ══════════════════════════════════════════════════════════════════════
 * Everything else on this page arrives debit-positive and is negated
 * once, in `presentationBalance`, for liabilities, equity and revenue.
 * `cashEffect` is NOT one of those values. The server has already turned
 * each ledger's debit-positive movement into its effect on cash, so
 * POSITIVE IS CASH IN for every line regardless of account type — an
 * increase in payables and an issue of share capital both arrive
 * positive, and a purchase of plant arrives negative.
 *
 * Passing these through `presentationBalance` would invert the liability
 * and equity lines only, which would leave a statement whose sections
 * look plausible, whose total is wrong, and which the reconciliation
 * would then reject with a gap nobody could account for — because the
 * gap would be in the rendering, not in the ledger.
 */
function CashFlowSection({
  title,
  note,
  rows,
  total,
}: {
  title: string;
  note: string;
  rows: CashFlowResult["assetMovements"];
  total: string;
}) {
  /**
   * ⚠️ FILTERED IN THE UI, NOT IN THE ARITHMETIC. A ledger that did not
   * move contributes exactly nothing to the total, so hiding it here
   * cannot change a figure — and hiding it in `buildCashFlow` would mean
   * the reconciliation ran against a different set of rows from the one
   * on screen, which is the kind of divergence that makes a gap
   * impossible to trace.
   *
   * ⚠️ COMPARED AS PAISE, NOT AS THE STRING "0.00". A `.00` suffix is a
   * formatting detail; a zero is a number.
   */
  const moved = rows.filter((r) => toMinor(r.cashEffect) !== 0n);

  return (
    <div>
      <div className="flex items-baseline justify-between border-b px-4 py-2">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide">{title}</h3>
          <p className="text-xs font-normal normal-case text-muted-foreground">{note}</p>
        </div>
        <span className="font-medium tabular-nums">{inr(toMinor(total))}</span>
      </div>
      {moved.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No movement.</p>
      ) : (
        <ul className="divide-y">
          {moved.map((r) => (
            <li key={r.ledgerId} className="flex items-baseline gap-3 px-4 py-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
              <span className="flex-1">
                {r.name}
                {RESTRICTED_TYPES.has(r.type) && (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    {r.type} — not the firm&apos;s money
                  </Badge>
                )}
              </span>
              <span className="tabular-nums">{inr(toMinor(r.cashEffect))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * ⭐⭐⭐ THE CASH FLOW STATEMENT, OR THE REASON THERE ISN'T ONE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `usable === false` RENDERS NO FIGURE FROM THE STATEMENT. AT ALL.
 * ══════════════════════════════════════════════════════════════════════
 * This is the single rule this component exists to enforce, and it is
 * worth being blunt about why the softer options are all wrong.
 *
 * The tempting alternative is to render the statement with a warning
 * banner above it. That does not work. The person reading this page is
 * deciding whether there is enough money to make payroll on Friday, and
 * a closing cash figure that is nearly right is acted on in exactly the
 * same way as one that is right. The banner is read once; the number is
 * copied into a spreadsheet.
 *
 * The other tempting alternative is to render the ACTUAL closing balance
 * — the one read straight off the cash ledgers — on the grounds that it
 * is a fact rather than a derivation. That is worse, because it is true
 * and misleading at the same time: it would be presented under the
 * heading of a statement that has just failed its own consistency check,
 * so the reader would take the whole statement as verified.
 *
 * ⚠️ THE GAP ITSELF IS SHOWN, because it is a diagnostic and not a
 * statement figure, and because "your books are out by ₹4,317.00" sends
 * somebody to the right transaction while "something is wrong" sends
 * them to support.
 */
function CashFlowCard({ data }: { data: CashFlowResult }) {
  if (!data.usable) {
    return (
      <Card className="border-red-400 dark:border-red-700">
        <CardHeader>
          <CardTitle className="text-red-700 dark:text-red-300">
            Cash flow statement unavailable — it does not reconcile
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            No figures are shown below on purpose. A cash flow statement that is
            nearly right is acted on exactly like one that is right.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ul className="list-disc space-y-2 pl-5">
            {data.failureReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {!data.reconciles && (
            <p className="text-muted-foreground">
              The two routes to the closing cash balance differ by{" "}
              <strong className="tabular-nums text-foreground">
                {inr(toMinor(data.discrepancy))}
              </strong>
              . The ledger enforces balance per transaction at the database
              level, so this is not an unbalanced journal — it is a movement
              that has gone missing from one of the accounts above.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const netMovement = toMinor(data.netMovement);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash flow statement</CardTitle>
        <p className="text-xs text-muted-foreground tabular-nums">
          Indirect method · for the period {describePeriod(data.period)}
        </p>
        {/*
          ⚠️ THE READER IS TOLD WHAT "CASH" MEANS HERE. These ledgers are
          identified structurally — a linked bank account, or the tenant's
          mapped Bank / Cash posting role — never by matching a name. A
          cash account that was missed does not break the reconciliation;
          it just quietly reports less money than the business has, and
          listing the accounts is what makes that visible.
        */}
        <p className="text-xs text-muted-foreground">
          Cash and bank:{" "}
          {data.cashLedgers.map((c) => `${c.name}${c.code ? ` (${c.code})` : ""}`).join(", ")}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex items-baseline justify-between border-b px-4 py-3">
          <div>
            <span className="text-sm font-semibold uppercase tracking-wide">
              Result for the period
            </span>
            {/*
              ⚠️ NO SEPARATE "ADD BACK DEPRECIATION" LINE, AND THAT IS
              CORRECT. Every non-cash charge has its other leg on a
              balance-sheet account, so it already appears below with the
              opposite sign and cancels itself. Adding it here as well
              would count it twice. See `lib/accounting/cash-flow.ts`.
            */}
            <p className="text-xs font-normal normal-case text-muted-foreground">
              From the profit &amp; loss above. Non-cash charges need no separate
              add-back — the other leg of each one appears below and cancels it.
            </p>
          </div>
          <span className="font-medium tabular-nums">{inr(toMinor(data.netResult))}</span>
        </div>

        <CashFlowSection
          title="Movements in assets other than cash"
          note="Receivables, stock, prepayments, fixed assets. Money tied up is money out."
          rows={data.assetMovements}
          total={data.assetMovementTotal}
        />
        <CashFlowSection
          title="Movements in liabilities and equity"
          note="Payables, borrowings, capital. Money owed and not yet paid is money still in hand."
          rows={data.fundingMovements}
          total={data.fundingMovementTotal}
        />

        <div className="flex items-baseline justify-between border-t-2 px-4 py-3">
          <span className="font-semibold">Net movement in cash and bank</span>
          <span
            className={`text-lg font-semibold tabular-nums ${
              netMovement >= 0n ? "text-emerald-600" : "text-red-600"
            }`}
          >
            {inr(netMovement)}
          </span>
        </div>

        <div className="flex items-baseline justify-between border-t px-4 py-2 text-sm">
          <span>Cash and bank at {formatIso(data.openingAsAt)}</span>
          <span className="tabular-nums">{inr(toMinor(data.openingCash))}</span>
        </div>
        <div className="flex items-baseline justify-between border-t-2 px-4 py-3">
          <span className="font-semibold">
            Cash and bank at {formatIso(data.asAt)}
          </span>
          <span className="text-lg font-semibold tabular-nums">
            {inr(toMinor(data.actualClosingCash))}
          </span>
        </div>

        {/*
          ⭐ THE RECONCILIATION IS STATED EVEN WHEN IT PASSES. A check
          that only speaks up on failure is a check nobody believes is
          running — and this one is the reason the figure above can be
          trusted at all.
        */}
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          Reconciled. The closing balance was computed twice — built up from the
          profit and the movements above, and read straight off the cash and bank
          ledgers — and the two agree to the paisa. They share no ledger between
          them, so they agree only if the books are complete.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * ⭐ THE PERIOD PICKER — A PLAIN GET FORM, NOT A CLIENT COMPONENT.
 *
 * ⚠️ Two consequences that are the point rather than a compromise: the
 * chosen period lives in the URL, so a statement can be bookmarked,
 * emailed to an accountant, or attached to a support ticket and it will
 * render the same numbers; and it works before any JavaScript has
 * loaded, which matters on the page somebody opens to check a figure
 * during a call.
 *
 * The inputs show the RESOLVED dates, not what was typed. If a query
 * string was malformed and fell back to the financial-year default, the
 * user sees the dates they actually got rather than the ones they asked
 * for and did not receive.
 */
function PeriodPicker({ period }: { period: StatementPeriod }) {
  const today = todayInIndia();
  const previous = previousFyFor(today);

  return (
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        From
        <input
          type="date"
          name="from"
          defaultValue={period.from}
          className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        To
        <input
          type="date"
          name="to"
          defaultValue={period.to}
          className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
        />
      </label>
      <button
        type="submit"
        className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
      >
        Apply
      </button>
      <div className="flex items-center gap-3 text-xs">
        {/* The two ranges an Indian business asks for by name. */}
        <Link href="/statements" className="text-muted-foreground hover:underline">
          This financial year
        </Link>
        <Link
          href={`/statements?from=${previous.from}&to=${previous.to}`}
          className="text-muted-foreground hover:underline"
        >
          Previous financial year
        </Link>
      </div>
    </form>
  );
}

async function StatementsBody({ period }: { period: StatementPeriod }) {
  /**
   * ⚠️ TWO CALLS, NOT ONE, AND DELIBERATELY SO. The P&L is asked for the
   * period; the balance sheet is asked for the position at the period's
   * end date and reads from inception. One shared query cannot serve
   * both without one of the two being wrong.
   */
  const [plResult, bsResult, cfResult] = await Promise.all([
    getProfitAndLoss({ from: period.from, to: period.to }),
    getBalanceSheet({ from: period.from, to: period.to }),
    /**
     * ⚠️ A THIRD CALL, AND A THIRD WINDOW. The cash flow needs the
     * period's movement AND two cumulative positions — the day before the
     * period opened and the period end. It resolves those itself from the
     * same period object, so the three statements on this page cannot
     * disagree about what range they cover.
     */
    getCashFlowStatement({ from: period.from, to: period.to }),
  ]);

  if (!plResult.ok || !bsResult.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Statements unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {plResult.ok ? bsResult.ok ? "" : bsResult.error : plResult.error}
          </p>
        </CardContent>
      </Card>
    );
  }

  const withPresentation = (rows: readonly Row[]) =>
    rows.map((r) => ({ ...r, presented: presentationBalance(r) }));

  const plRows = withPresentation(plResult.data.rows as Row[]);
  const bsRows = withPresentation(bsResult.data.rows as Row[]);

  const of = (list: Array<Row & { presented: bigint }>, accountType: string) =>
    list.filter((r) => r.accountType === accountType && r.presented !== 0n);
  const sum = (list: Array<{ presented: bigint }>) =>
    list.reduce((acc, r) => acc + r.presented, 0n);

  // P&L — movement in the period.
  const revenue = of(plRows, "revenue");
  const expenses = of(plRows, "expense");
  const totalRevenue = sum(revenue);
  const totalExpenses = sum(expenses);
  const netResult = toMinor(plResult.data.netResult);

  // Balance sheet — position at the end of the period, from inception.
  const assets = of(bsRows, "asset");
  const liabilities = of(bsRows, "liability");
  const equity = of(bsRows, "equity");
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity);

  const retainedToDate = toMinor(bsResult.data.retainedResultToDate);

  /**
   * ⚠️ PROFIT EARNED BEFORE THIS PERIOD BEGAN.
   * Cumulative result less this period's result. For a first-year
   * business this is zero and the line is hidden; from year two it is
   * the number that makes the balance sheet add up, and hiding it would
   * make the page accuse a correct ledger of being unbalanced.
   */
  const broughtForward = retainedToDate - netResult;

  /**
   * Assets = Liabilities + Equity + retained result. Checked, not assumed.
   *
   * ⚠️ MEASURED ON THE CUMULATIVE FIGURES, ALL FOUR TO THE SAME DATE.
   * Substituting the period's `netResult` here would make the gap equal
   * to last year's profit and flag every established business as broken.
   *
   * This quantity is also the trial-balance difference: negating
   * liabilities, equity and revenue for presentation means the sum of the
   * raw debit-positive balances is exactly this gap. If it is non-zero,
   * debits do not equal credits.
   */
  const identityGap = totalAssets - (totalLiabilities + totalEquity + retainedToDate);

  const restrictedCash = sum(assets.filter((r) => RESTRICTED_TYPES.has(r.type)));

  return (
    <div className="space-y-6">
      {identityGap !== 0n && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              These statements do not balance — do not file from them
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Assets do not equal liabilities plus equity plus the retained
              result as at {formatIso(bsResult.data.asAt)}. Gap:{" "}
              <strong>{inr(identityGap)}</strong>.
            </p>
            <p className="text-muted-foreground">
              The ledger enforces balance at the database level, so this
              normally cannot happen. It means a ledger is missing an account
              type, or a journal was posted outside the guarded path.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(totalRevenue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(totalExpenses)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {netResult >= 0n ? "Profit" : "Loss"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={`text-2xl font-semibold tabular-nums ${
                netResult >= 0n ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {inr(netResult)}
            </p>
          </CardContent>
        </Card>
        <Card className={restrictedCash !== 0n ? "border-amber-300 dark:border-amber-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Restricted funds
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(restrictedCash)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Trust, escrow and retention. On the balance sheet, not available
              to spend.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Profit &amp; loss</CardTitle>
            <p className="text-xs text-muted-foreground tabular-nums">
              For the period {describePeriod(period)}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Section title="Revenue" rows={revenue} total={totalRevenue} />
            <Section title="Expenses" rows={expenses} total={totalExpenses} />
            <div className="flex items-baseline justify-between border-t-2 px-4 py-3">
              <span className="font-semibold">
                {netResult >= 0n ? "Profit for the period" : "Loss for the period"}
              </span>
              <span
                className={`text-lg font-semibold tabular-nums ${
                  netResult >= 0n ? "text-emerald-600" : "text-red-600"
                }`}
              >
                {inr(netResult)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Balance sheet</CardTitle>
            {/* 🔴 "As at", never "for the period". A position, not a range. */}
            <p className="text-xs text-muted-foreground tabular-nums">
              As at {formatIso(bsResult.data.asAt)} · balances accumulate from
              inception, not from the start of the period
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Section title="Assets" rows={assets} total={totalAssets} />
            <Section title="Liabilities" rows={liabilities} total={totalLiabilities} />
            <Section title="Equity" rows={equity} total={totalEquity} />
            {broughtForward !== 0n && (
              <div className="flex items-baseline justify-between border-t px-4 py-2 text-sm">
                <span>Retained result brought forward</span>
                <span className="tabular-nums">{inr(broughtForward)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between border-t px-4 py-2 text-sm">
              <span>Result for the period</span>
              <span className="tabular-nums">{inr(netResult)}</span>
            </div>
            <div className="flex items-baseline justify-between border-t-2 px-4 py-3">
              <span className="font-semibold">Liabilities + equity + retained</span>
              <span className="text-lg font-semibold tabular-nums">
                {inr(totalLiabilities + totalEquity + retainedToDate)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/*
        ⚠️ THE CASH FLOW IS RENDERED EVEN WHEN IT CANNOT BE RENDERED —
        the card itself decides between the statement and the explanation.
        A failing cash flow does NOT suppress the P&L and the balance
        sheet above it: those two are checked against a different identity
        and can be perfectly sound while the cash reconciliation is not.
      */}
      {cfResult.ok ? (
        <CashFlowCard data={cfResult.data} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Cash flow statement unavailable</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{cfResult.error}</p>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Derived from the ledger on every load — nothing is cached, so a
        back-dated journal is reflected immediately. Journals are selected by
        their transaction date, so a back-dated entry lands in the period it
        belongs to rather than the one it was typed in. Every amount is integer
        paise; no floating point touches these figures. Posted and reversed
        transactions are included; voided and unposted ones are not — a reversal
        and the entry it reverses are one fact in two rows, so both are counted
        and they net to nothing.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
        <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
      </div>
      {/* The cash flow card, which is full width below the other two. */}
      <div className="h-80 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;

  /**
   * ⚠️ RESOLVED HERE AS WELL AS IN THE ACTIONS, ON PURPOSE.
   * The picker and the statement headings must show the SAME period the
   * numbers were computed for. `resolveStatementPeriod` is pure and
   * idempotent — feeding it its own output returns that output — so
   * passing the resolved dates down to the actions guarantees the label
   * and the figures agree even when the query string was junk.
   */
  const period = resolveStatementPeriod({ from: params.from, to: params.to });

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Financial statements
          </h1>
          <p className="text-sm text-muted-foreground">
            Profit &amp; loss, balance sheet and cash flow, derived from the ledger.
          </p>
          <p className="text-sm font-medium tabular-nums">
            {describePeriod(period)}
          </p>
        </div>
        <Link href="/accounting" className="text-sm text-muted-foreground hover:underline">
          Ledgers &amp; journals
        </Link>
      </header>

      <PeriodPicker period={period} />

      {/*
        ⚠️ The key re-suspends when the period changes. Without it React
        reuses the resolved boundary and the user stares at the previous
        year's figures while the new ones load, with nothing to say the
        page is busy.
      */}
      <Suspense key={`${period.from}:${period.to}`} fallback={<Skeleton />}>
        <StatementsBody period={period} />
      </Suspense>
    </div>
  );
}
