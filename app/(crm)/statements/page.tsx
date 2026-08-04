/**
 * Ordence — Financial statements
 * Version: v0.32.0-alpha
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
 * ⚠️ DERIVED, NEVER STORED
 * ══════════════════════════════════════════════════════════════════════
 * Both statements are computed from `getTrialBalance()` on every load. No
 * cached "statement" row exists, and none should — a stored statement is a
 * second version of the truth that drifts the moment somebody posts a
 * back-dated journal, and it drifts silently.
 *
 * ⚠️ SIGN CONVENTION, STATED ONCE.
 * `balance` from the trial balance is debit-positive. That is correct for
 * assets and expenses, and inverted for liabilities, equity and revenue —
 * a liability of ₹10,000 arrives as -1000000 paise. So those three
 * categories are negated exactly once, here, at the presentation edge.
 * Getting this wrong produces a balance sheet that balances at zero and
 * means nothing.
 *
 * ⚠️ THE ACCOUNTING IDENTITY IS CHECKED AND SHOWN.
 * Assets = Liabilities + Equity + (Revenue − Expenses). If it does not
 * hold, the page says so at the top in red rather than rendering two
 * plausible-looking statements. A statement that is wrong and confident is
 * worse than no statement, because somebody files from it.
 *
 * ⚠️ TRUST AND ESCROW LEDGERS ARE FLAGGED. Client money held on trust is
 * legally not the firm's asset. It appears on the balance sheet because it
 * must, and it is marked, because treating it as available cash is a
 * regulatory breach rather than an accounting error.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getTrialBalance } from "@/server/actions/accounting";
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
  const raw = BigInt(row.balance || "0");
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

async function StatementsBody() {
  const result = await getTrialBalance();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Statements unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { rows, totalDebits, totalCredits, isBalanced, difference } = result.data;

  const enriched = (rows as Row[]).map((r) => ({ ...r, presented: presentationBalance(r) }));
  const of = (accountType: string) =>
    enriched.filter((r) => r.accountType === accountType && r.presented !== 0n);
  const sum = (list: Array<{ presented: bigint }>) =>
    list.reduce((acc, r) => acc + r.presented, 0n);

  const assets = of("asset");
  const liabilities = of("liability");
  const equity = of("equity");
  const revenue = of("revenue");
  const expenses = of("expense");

  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity);
  const totalRevenue = sum(revenue);
  const totalExpenses = sum(expenses);
  const netResult = totalRevenue - totalExpenses;

  // Assets = Liabilities + Equity + retained result. Checked, not assumed.
  const identityGap = totalAssets - (totalLiabilities + totalEquity + netResult);

  const restrictedCash = sum(assets.filter((r) => RESTRICTED_TYPES.has(r.type)));

  return (
    <div className="space-y-6">
      {(!isBalanced || identityGap !== 0n) && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              These statements do not balance — do not file from them
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!isBalanced && (
              <p>
                Trial balance is out by <strong>{inr(difference)}</strong>. Debits{" "}
                {inr(totalDebits)} against credits {inr(totalCredits)}.
              </p>
            )}
            {identityGap !== 0n && (
              <p>
                Assets do not equal liabilities plus equity plus the period
                result. Gap: <strong>{inr(identityGap)}</strong>.
              </p>
            )}
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
          </CardHeader>
          <CardContent className="p-0">
            <Section title="Assets" rows={assets} total={totalAssets} />
            <Section title="Liabilities" rows={liabilities} total={totalLiabilities} />
            <Section title="Equity" rows={equity} total={totalEquity} />
            <div className="flex items-baseline justify-between border-t px-4 py-2 text-sm">
              <span>Result for the period</span>
              <span className="tabular-nums">{inr(netResult)}</span>
            </div>
            <div className="flex items-baseline justify-between border-t-2 px-4 py-3">
              <span className="font-semibold">Liabilities + equity + result</span>
              <span className="text-lg font-semibold tabular-nums">
                {inr(totalLiabilities + totalEquity + netResult)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Derived from the trial balance on every load — nothing is cached, so a
        back-dated journal is reflected immediately. Every amount is integer
        paise; no floating point touches these figures.
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
    </div>
  );
}

export default function StatementsPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Financial statements
          </h1>
          <p className="text-sm text-muted-foreground">
            Profit &amp; loss and balance sheet, derived from the ledger.
          </p>
        </div>
        <Link href="/accounting" className="text-sm text-muted-foreground hover:underline">
          Ledgers &amp; journals
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <StatementsBody />
      </Suspense>
    </div>
  );
}
