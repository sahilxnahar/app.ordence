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
  closeFinancialPeriod,
  reopenFinancialPeriod,
} from "@/server/actions/periods";
import { JournalEntryForm, type LedgerOption } from "./journal-form";
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

export default async function AccountingPage() {
  const ctx = await requirePageContext();

  const [ledgersResult, trialBalanceResult, periodsResult, transactionsResult] =
    await Promise.all([
      getLedgers(),
      getTrialBalance(),
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
      <header>
        <h1 className="text-2xl font-bold">Accounting</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Double-entry general ledger. Every transaction must balance before it can
          be saved — enforced in the form, in the server action, and by the database.
        </p>
      </header>

      {/* ── TRIAL BALANCE ─────────────────────────────────────────── */}
      <section aria-labelledby="trial-balance-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="trial-balance-heading" className="text-lg font-semibold">
            Trial balance
          </h2>
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
                      <td className="px-3 py-2 text-right"><Amount value={row.totalDebit} /></td>
                      <td className="px-3 py-2 text-right"><Amount value={row.totalCredit} /></td>
                      <td className="px-3 py-2 text-right"><Amount value={row.balance} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-border bg-muted/30 font-medium">
                  <tr>
                    <td className="px-3 py-2" colSpan={3}>Totals</td>
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

        {!periodsResult.ok ? (
          <p className="text-sm text-destructive">{periodsResult.error}</p>
        ) : periodSummaries.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No periods defined yet.
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
