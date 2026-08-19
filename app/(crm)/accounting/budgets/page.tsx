/**
 * Ordence — Budgets and variance
 * Version: v1.47.0-alpha · Batch 68
 *
 * A server component. The arithmetic is in `lib/accounting/budget.ts`,
 * the queries are in `server/actions/budgets.ts`, and this file chooses
 * a period and renders.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PERIOD IS A `financial_periods` ROW, NOT A DATE RANGE THE USER
 *    TYPES
 * ══════════════════════════════════════════════════════════════════════
 * Every other statement on this product takes a from-date and a to-date.
 * This one does not, and the difference is deliberate. A budget for
 * "April" compared against actuals for a range somebody typed is a
 * variance made of the calendar: every figure in it is individually
 * right and the comparison is not a comparison.
 *
 * ⭐ AND IT IS THE SAME ROW THE LEDGER LOCK READS, so the period this
 * report is drawn for and the period the books are closed for are the
 * same period by construction — which is what makes "a closed period's
 * budget is frozen" a rule with one meaning instead of two.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A WORKSPACE WITH NO ACCOUNTING PERIODS GETS A SENTENCE, NOT AN
 *    EMPTY TABLE
 * ══════════════════════════════════════════════════════════════════════
 * "No data" on a screen the customer has never been able to put data
 * into reads as a fault in the product. The remedy — create a period on
 * the accounting screen — is one click away and is named.
 */

import Link from "next/link";
import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  getBudgetVsActual,
  getBudgetWorkspace,
  saveBudgetLine,
} from "@/server/actions/budgets";
import { BudgetEditor } from "@/components/budgets/budget-editor";
import { VarianceTable } from "@/components/budgets/variance-table";

export const dynamic = "force-dynamic";

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const ctx = await requirePageContext();
  const params = await searchParams;

  const workspaceResult = await getBudgetWorkspace({ periodId: params.period });

  if (!workspaceResult.ok) {
    return (
      <main className="p-6">
        <h1 className="text-2xl font-bold">Budgets</h1>
        <p className="mt-2 text-sm text-destructive">{workspaceResult.error}</p>
      </main>
    );
  }

  const workspace = workspaceResult.data;

  /**
   * ⚠️ THE DEFAULT IS THE LAST OPEN PERIOD, FALLING BACK TO THE LAST
   * PERIOD OF ANY KIND. Defaulting to the FIRST period would open this
   * screen on the oldest month in the workspace — usually a closed one —
   * so the first thing a new user sees is a screen they cannot edit.
   */
  const chosenId =
    params.period ??
    [...workspace.periods].reverse().find((p) => p.isOpen)?.id ??
    workspace.periods[workspace.periods.length - 1]?.id;

  const period = workspace.periods.find((p) => p.id === chosenId) ?? null;

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const mayEdit = can(subject, "ledgers:update");

  const varianceResult = period ? await getBudgetVsActual({ periodId: period.id }) : null;

  async function save(input: {
    periodId: string;
    ledgerId: string;
    costCentreKey: string;
    amount: string;
  }) {
    "use server";
    const result = await saveBudgetLine(input);
    return result.ok ? ({ ok: true } as const) : ({ ok: false, error: result.error } as const);
  }

  return (
    <main className="space-y-8 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Budgets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A figure per accounting period, per account, per cost centre — measured
            against the same ledger the profit &amp; loss reads, over the same period
            and the same transaction statuses.
          </p>
          {/*
            🔴 THE SIGN CONVENTION IS ON THE PAGE, ONCE, IN WORDS.
            Over-spending on a cost and under-achieving on revenue are
            both bad news and have opposite arithmetic; a reader who has
            not been told which way round it is will read the expense half
            of the table backwards.
          */}
          <p className="mt-1 text-xs text-muted-foreground">
            A POSITIVE VARIANCE IS FAVOURABLE, on every line. For expenditure that is
            budget less actual; for revenue it is actual less budget. Spending less
            than planned and earning more than planned are both favourable, and they
            are opposite subtractions.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-sm">
          <Link
            href="/accounting/cost-centres"
            className="text-muted-foreground hover:underline"
          >
            Cost centres
          </Link>
          <Link href="/accounting" className="text-muted-foreground hover:underline">
            Back to accounting
          </Link>
        </div>
      </header>

      {workspace.periods.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          This workspace has no accounting periods yet. A budget is set against a
          period — the same row that locks the books when the month is closed — so
          create one on the{" "}
          <Link href="/accounting" className="underline">
            accounting screen
          </Link>{" "}
          first.
        </p>
      ) : (
        <>
          <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Period
              <select
                name="period"
                defaultValue={period?.id ?? ""}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                {workspace.periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.isOpen ? "" : ` — ${p.status}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
            >
              Show
            </button>
            {period && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {period.startDate} to {period.endDate}
              </p>
            )}
          </form>

          {period && (
            <section aria-labelledby="budget-edit-heading" className="space-y-3">
              <h2 id="budget-edit-heading" className="text-lg font-semibold">
                Set a budget
              </h2>
              <BudgetEditor
                periodId={period.id}
                periodLabel={period.label}
                periodIsOpen={period.isOpen}
                periodStatus={period.status}
                ledgers={workspace.ledgers}
                centres={workspace.costCentres.map((c) => ({
                  id: c.id,
                  code: c.code,
                  name: c.name,
                  isActive: c.isActive,
                }))}
                lines={workspace.lines.map((l) => ({
                  id: l.id,
                  ledgerId: l.ledgerId,
                  costCentreKey: l.costCentreKey,
                  amountMinor: l.amountMinor,
                }))}
                mayEdit={mayEdit}
                onSave={save}
              />
            </section>
          )}

          <section aria-labelledby="variance-heading" className="space-y-3">
            <h2 id="variance-heading" className="text-lg font-semibold">
              Budget versus actual
            </h2>
            {!varianceResult ? null : !varianceResult.ok ? (
              <p className="text-sm text-destructive">{varianceResult.error}</p>
            ) : (
              <VarianceTable
                rows={varianceResult.data.rows}
                totals={varianceResult.data.totals}
                reconciliation={varianceResult.data.reconciliation}
                caption={`Budget versus actual for ${varianceResult.data.period.label}, by account and cost centre`}
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}
