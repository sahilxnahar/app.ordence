/**
 * Ordence — Accounting
 * Version: v0.7.0-alpha
 *
 * A server component. It loads the chart of accounts, the trial balance and
 * the financial periods, then hands them to the client components that need
 * interactivity (the journal form and the close/reopen dialogs).
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE PERMISSION CHECK HERE USES `can()` AND NOT `checkPermission()`
 * ══════════════════════════════════════════════════════════════════════
 * `checkPermission()` RECORDS A DENIAL every time it returns false. That is
 * exactly right at the top of a server action — a real attempt was made and
 * refused, and an auditor wants to see it.
 *
 * It is exactly wrong for deciding whether to render a button. Every page
 * load by every user without the permission would write an audit row, and
 * within a week the denial log — the thing you would actually search after
 * an incident — is buried under thousands of entries recording nothing more
 * than "an accountant looked at the accounting page".
 *
 * So the UI uses the pure, side-effect-free `can()`. Hiding the button is a
 * courtesy to the user, not a security control; the server action still
 * calls `requirePermission()` and still records anyone who tries anyway.
 */

import Link from "next/link";
import { BookOpen, Lock } from "lucide-react";
import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  getLedgers,
  getTrialBalance,
  getRecentTransactions,
} from "@/server/actions/accounting";
import {
  getFinancialPeriods,
  createFinancialPeriod,
  closeFinancialPeriod,
  reopenFinancialPeriod,
} from "@/server/actions/periods";
import {
  resolveStatementPeriod,
  previousFyFor,
  describePeriod,
  todayInIndia,
  type StatementPeriod,
} from "@/lib/accounting/periods";
import { JournalEntryForm, type LedgerOption } from "./journal-form";
import { CreatePeriodForm } from "@/components/accounting/create-period-form";
import {
  ClosePeriodDialog,
  ReopenPeriodDialog,
  type PeriodSummary,
} from "./period-close-dialog";

export const dynamic = "force-dynamic";

/** Render a decimal string right-aligned, or an em dash for zero. */
function Amount({ value }: { value: string }) {
  const isZero = /^-?0\.00$/.test(value);
  return (
    <span className={isZero ? "text-muted-foreground" : "tabular-nums"}>
      {isZero ? "—" : value}
    </span>
  );
}

/**
 * ⭐ THE TRIAL BALANCE PERIOD PICKER — A PLAIN GET FORM.
 *
 * ⚠️ The period lives in the URL rather than in component state, so the
 * page a bookkeeper is looking at can be linked to an accountant and
 * render the same figures. It also works with no JavaScript, which is
 * the state this page is in for the first second of every load.
 *
 * The inputs show the RESOLVED dates. A malformed `?from=` falls back to
 * the financial year rather than erroring, and the user needs to see the
 * range they actually got, not the one they asked for.
 */
function TrialBalancePeriodPicker({ period }: { period: StatementPeriod }) {
  const previous = previousFyFor(todayInIndia());
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        From
        <input
          type="date"
          name="from"
          defaultValue={period.from}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        To
        <input
          type="date"
          name="to"
          defaultValue={period.to}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
      </label>
      <button
        type="submit"
        className="rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
      >
        Apply
      </button>
      <div className="flex items-center gap-3 text-xs">
        <Link href="/accounting" className="text-muted-foreground hover:underline">
          This financial year
        </Link>
        <Link
          href={`/accounting?from=${previous.from}&to=${previous.to}`}
          className="text-muted-foreground hover:underline"
        >
          Previous financial year
        </Link>
      </div>
    </form>
  );
}

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requirePageContext();
  const params = await searchParams;

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE TRIAL BALANCE USED TO BE SINCE INCEPTION, WITH NO ALTERNATIVE
   * ══════════════════════════════════════════════════════════════════
   * `getTrialBalance()` took no arguments, so this table summed every
   * entry the tenant had ever posted. That is a useful number roughly
   * once — at the end of year one. After that it agrees with no return
   * and no set of accounts, and there was no parameter to pass.
   *
   * ⚠️ It now defaults to the CURRENT INDIAN FINANCIAL YEAR, not to all
   * time. See `lib/accounting/periods.ts` for why a since-inception
   * default is the dangerous one: it over-reports, plausibly, against a
   * range that is not printed anywhere.
   *
   * ⚠️ A PERIOD TRIAL BALANCE STILL BALANCES. Debits equal credits per
   * transaction, enforced by a deferred database trigger, so any subset
   * of whole transactions sums to zero. Narrowing the range cannot make
   * `isBalanced` false — which is why the close dialog below can still
   * trust it.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 BATCH 65 — AND IT NOW EXCLUDES VOID AND UNPOSTED TRANSACTIONS
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ THIS MOVED NUMBERS THAT WERE ALREADY ON SCREEN. Nothing in the
   * statement path filtered `transactions.status`, so a voided
   * transaction was counted in this table exactly like a real one.
   *
   * The set is now `posted` and `reversed`. `reversed` is INCLUDED, and
   * that is the half people get wrong: `reverseTransaction` writes the
   * mirror entry as a NEW `posted` transaction and marks the original
   * `reversed`, so filtering to "posted only" would keep every
   * correction and drop every thing it corrected — turnover would go
   * negative by the value of each reversed sale, in a trial balance that
   * still balances perfectly. Both rows, or neither. The reasoning lives
   * on `STATEMENT_TRANSACTION_STATUSES` in `server/actions/accounting.ts`.
   *
   * ⚠️ `isBalanced` IS UNAFFECTED. The filter selects whole transactions,
   * and a whole transaction balances by database trigger, so the close
   * dialog can still trust the flag.
   */
  const period = resolveStatementPeriod({ from: params.from, to: params.to });

  const [ledgersResult, trialBalanceResult, periodsResult, transactionsResult] =
    await Promise.all([
      getLedgers(),
      getTrialBalance({ from: period.from, to: period.to }),
      getFinancialPeriods(),
      getRecentTransactions(15),
    ]);

  if (!ledgersResult.ok) {
    return (
      <main className="p-6">
        <h1 className="text-2xl font-bold">Accounting</h1>
        <p className="mt-2 text-sm text-destructive">{ledgersResult.error}</p>
      </main>
    );
  }

  const ledgers = ledgersResult.data;

  // The form only ever offers ACTIVE ledgers. Posting into a deactivated
  // account is how a chart of accounts quietly rots.
  const ledgerOptions: LedgerOption[] = ledgers
    .filter((l) => l.isActive !== false)
    .map((l) => ({ id: l.id, code: l.code, name: l.name, type: l.type }));

  const periods = periodsResult.ok ? periodsResult.data : [];

  const periodSummaries: PeriodSummary[] = periods.map((p) => ({
    id: p.id,
    name: p.name,
    startDate: String(p.startDate),
    endDate: String(p.endDate),
    status: p.status,
    closedAt: p.closedAt ? new Date(p.closedAt).toISOString() : null,
    closingNotes: p.closingNotes ?? null,
  }));

  // Closed ranges are handed to the journal form so it can warn BEFORE the
  // user fills in ten legs and discovers the date is locked on submit.
  const lockedDates = periodSummaries
    .filter((p) => p.status === "closed" || p.status === "locked")
    .map((p) => ({ name: p.name, startDate: p.startDate, endDate: p.endDate }));

  const trialBalance = trialBalanceResult.ok ? trialBalanceResult.data : null;
  const transactions = transactionsResult.ok ? transactionsResult.data : [];

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const mayPost = can(subject, "transactions:post");
  const mayClose = can(subject, "periods:close");
  const mayReopen = can(subject, "periods:reopen");

  return (
    <main className="space-y-8 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Accounting</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Double-entry general ledger. Every transaction must balance before it can
            be saved — enforced in the form, in the server action, and by the database.
          </p>
        </div>
        {/* The three statements are one click away, in both directions. */}
        <Link href="/statements" className="text-sm text-muted-foreground hover:underline">
          Profit &amp; loss, balance sheet, cash flow
        </Link>
      </header>

      {/* ── TRIAL BALANCE ─────────────────────────────────────────── */}
      <section aria-labelledby="trial-balance-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="trial-balance-heading" className="text-lg font-semibold">
              Trial balance
            </h2>
            {/* The range the numbers below cover, always stated. */}
            <p className="text-xs text-muted-foreground tabular-nums">
              Movement for {describePeriod(period)}
            </p>
            {/*
              ⚠️ WHAT COUNTS AS "IN THE BOOKS" IS STATED ON THE PAGE, not
              just in a comment. This filter changed the figures in this
              table, and a bookkeeper comparing today's trial balance to
              last week's printout needs to be able to see why.
            */}
            <p className="text-xs text-muted-foreground">
              Posted and reversed transactions. Voided and unposted entries are
              excluded; a reversal and the entry it reverses are both included and
              net to nothing.
            </p>
          </div>
          {trialBalance && (
            <span
              role="status"
              className={
                trialBalance.isBalanced
                  ? "rounded-md border border-emerald-600/30 bg-emerald-600/5 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400"
                  : "rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1 text-xs font-medium text-destructive"
              }
            >
              {trialBalance.isBalanced
                ? "Balanced"
                : `Out of balance by ${trialBalance.difference}`}
            </span>
          )}
        </div>

        <TrialBalancePeriodPicker period={period} />

        {/*
          🔴 BATCH 0101 — THE TOTALS ARE NOT A QUANTITY OF ANYTHING WHEN
          LEDGERS IN MORE THAN ONE CURRENCY HAVE MOVEMENT IN THE PERIOD.

          ⚠️ IT IS SHOWN ABOVE THE TABLE AND NOT AS A FOOTNOTE. The failure
          this guards against is not an error — it is a plausible number
          that somebody reads, believes and files, and a caption under the
          totals is read after the number has already been believed.
        */}
        {trialBalance?.currencyMixed && trialBalance.currencyWarning && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {trialBalance.currencyWarning}
          </p>
        )}

        {!trialBalanceResult.ok ? (
          <p className="text-sm text-destructive">{trialBalanceResult.error}</p>
        ) : trialBalance && trialBalance.rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No ledgers yet. Create a chart of accounts before posting entries.
          </p>
        ) : (
          trialBalance && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Trial balance by ledger account, showing total debits and credits
                </caption>
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">Code</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">Account</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">Type</th>
                    {/* ⭐ 0101. Shown only when there is something to
                        distinguish — a column of "INR" on every row of an
                        INR-only workspace is noise that trains people to
                        stop reading the column. */}
                    {trialBalance.currencyMixed && (
                      <th scope="col" className="px-3 py-2 text-left font-medium">Currency</th>
                    )}
                    <th scope="col" className="px-3 py-2 text-right font-medium">Debit</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Credit</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {trialBalance.rows.map((row) => (
                    <tr key={row.ledgerId}>
                      <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
                      <td className="px-3 py-2">{row.name}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.accountType}
                      </td>
                      {trialBalance.currencyMixed && (
                        <td className="px-3 py-2 font-mono text-xs">{row.currency}</td>
                      )}
                      <td className="px-3 py-2 text-right"><Amount value={row.totalDebit} /></td>
                      <td className="px-3 py-2 text-right"><Amount value={row.totalCredit} /></td>
                      <td className="px-3 py-2 text-right"><Amount value={row.balance} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-border bg-muted/30 font-medium">
                  <tr>
                    <td className="px-3 py-2" colSpan={trialBalance.currencyMixed ? 4 : 3}>
                      Totals
                      {trialBalance.currencyMixed && (
                        <span className="ml-2 text-xs font-normal text-destructive">
                          ({trialBalance.currencies.join(" + ")} added together)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {trialBalance.totalDebits}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {trialBalance.totalCredits}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {trialBalance.isBalanced ? "0.00" : trialBalance.difference}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        )}
      </section>

      {/* ── POST AN ENTRY ────────────────────────────────────────── */}
      <section aria-labelledby="journal-heading" className="space-y-3">
        <h2 id="journal-heading" className="text-lg font-semibold">
          Post a journal entry
        </h2>

        {!mayPost ? (
          <p className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            Your role does not include permission to post transactions.
          </p>
        ) : ledgerOptions.length < 2 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            At least two active ledgers are needed before an entry can balance.
          </p>
        ) : (
          <div className="rounded-md border border-border p-4">
            <JournalEntryForm ledgers={ledgerOptions} lockedDates={lockedDates} />
          </div>
        )}
      </section>

      {/* ── PERIODS ──────────────────────────────────────────────── */}
      <section aria-labelledby="periods-heading" className="space-y-3">
        <h2 id="periods-heading" className="text-lg font-semibold">
          Financial periods
        </h2>

        {/**
          * ⭐⭐⭐ THE FORM THAT DID NOT EXIST — wave two.
          *
          * ══════════════════════════════════════════════════════════════
          * 🔴 "No periods defined yet." WAS NOT AN EMPTY STATE. IT WAS THE
          *    ONLY STATE.
          * ══════════════════════════════════════════════════════════════
          * `createFinancialPeriod` is the only insert into
          * `financial_periods` in this product and nothing called it. Yet
          * this page calls `closeFinancialPeriod` and
          * `reopenFinancialPeriod`, and `/accounting/close` calls two more.
          * You could close a period. You could not create one.
          *
          * 🔴 AND `closedPeriodFor()` READS THAT TABLE ON EVERY POSTING.
          * Against an empty table it always returns null, so the period
          * lock in `writePosting`, in `0073`, in `0100`, in `0102`, in
          * Brief D's `0108` trigger and in `0112`'s refusal message has
          * never once been able to fire in production. None of that code
          * is wrong. It reads a table one missing form kept empty.
          */}
        <CreatePeriodForm
          createAction={createFinancialPeriod}
          disabled={!mayClose}
          disabledReason="Your role does not include permission to define a period."
        />

        {!periodsResult.ok ? (
          <p className="text-sm text-destructive">{periodsResult.error}</p>
        ) : periodSummaries.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No periods defined yet. Until one exists and is closed, nothing in
            the ledger is date-locked: the period lock reads this table and an
            empty table refuses nothing.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {periodSummaries.map((period) => {
              const isClosed = period.status === "closed";
              const isLocked = period.status === "locked";
              return (
                <li
                  key={period.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {(isClosed || isLocked) && (
                        <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      )}
                      {period.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {period.startDate} to {period.endDate} · {period.status}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {period.status === "open" && (
                      <ClosePeriodDialog
                        period={period}
                        trialBalanceAgrees={trialBalance?.isBalanced ?? false}
                        difference={trialBalance?.difference ?? "unknown"}
                        closeAction={closeFinancialPeriod}
                        disabled={!mayClose}
                        disabledReason="Your role does not include permission to close a period."
                      />
                    )}
                    {isClosed && (
                      <ReopenPeriodDialog
                        period={period}
                        reopenAction={reopenFinancialPeriod}
                        disabled={!mayReopen}
                        disabledReason="Your role does not include permission to reopen a period."
                      />
                    )}
                    {isLocked && (
                      <span className="text-xs text-muted-foreground">
                        Permanently locked
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── RECENT TRANSACTIONS ──────────────────────────────────── */}
      <section aria-labelledby="recent-heading" className="space-y-3">
        <h2 id="recent-heading" className="text-lg font-semibold">
          Recent transactions
        </h2>

        {transactions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Nothing posted yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {transactions.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {String(t.transactionDate)}
                    {t.transactionNumber ? ` · ${t.transactionNumber}` : ""}
                    {t.status ? ` · ${t.status}` : ""}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums text-sm">
                  {t.currency ?? "INR"} {String(t.totalAmount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
        Entries cannot be edited or deleted once posted. Corrections are made by
        posting a reversing entry, so the original record and its correction both
        stay visible.{" "}
        <Link href="/dashboard" className="underline underline-offset-2">
          Back to dashboard
        </Link>
      </p>
    </main>
  );
}
