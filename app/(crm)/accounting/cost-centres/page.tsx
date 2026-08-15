/**
 * Ordence — Cost centres
 * Version: v1.47.0-alpha · Batch 68
 *
 * A server component. It loads the cost centre list and the departmental
 * profit & loss for a chosen window and hands the interactive parts to
 * `components/budgets/`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE PERMISSION CHECK HERE USES `can()` AND NOT `checkPermission()`
 * ══════════════════════════════════════════════════════════════════════
 * `checkPermission()` RECORDS A DENIAL every time it returns false. That
 * is right at the top of a server action — a real attempt was made and
 * refused. It is wrong for deciding whether to render a button: every
 * page load by every user without the permission would write an audit
 * row, and within a week the denial log is buried under entries
 * recording nothing more than "somebody looked at the cost centre page".
 *
 * Hiding the button is a courtesy. The server action still calls
 * `requirePermission()` and still records anyone who tries anyway.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE "NOT ALLOCATED" ROW IS THE POINT OF THIS SCREEN TODAY
 * ══════════════════════════════════════════════════════════════════════
 * Nothing in the posting path writes `journal_entries.cost_centre_id`
 * yet, so on the day this ships the departmental P&L is one row called
 * "Not allocated" carrying the entire result. That is the honest render:
 * the report reconciles to the profit & loss to the paisa, and it says
 * out loud that none of it has been attributed. A screen that hid the
 * bucket would show an empty table and report a product limitation as
 * an absence of data.
 */

import Link from "next/link";
import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  createCostCentre,
  getCostCentreProfitAndLoss,
  listCostCentres,
  updateCostCentre,
} from "@/server/actions/budgets";
import {
  resolveStatementPeriod,
  describePeriod,
  todayInIndia,
  previousFyFor,
} from "@/lib/accounting/periods";
import { CostCentreBoard } from "@/components/budgets/cost-centre-form";
import { inrFromMinor } from "@/components/budgets/variance-table";
import { ReconciliationNotice } from "@/components/reconciliation/reconciliation-notice";

export const dynamic = "force-dynamic";

export default async function CostCentresPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requirePageContext();
  const params = await searchParams;

  /**
   * ⚠️ DEFAULTS TO THE CURRENT INDIAN FINANCIAL YEAR — 1 April to
   * 31 March — and never to "everything, forever". A since-inception
   * departmental result over-reports plausibly against a range that is
   * not printed on any return the customer files.
   */
  const period = resolveStatementPeriod({ from: params.from, to: params.to });
  const previous = previousFyFor(todayInIndia());

  const [listResult, plResult] = await Promise.all([
    listCostCentres(),
    getCostCentreProfitAndLoss({ from: period.from, to: period.to }),
  ]);

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const mayCreate = can(subject, "ledgers:create");
  const mayUpdate = can(subject, "ledgers:update");

  async function create(input: { code: string; name: string; description?: string }) {
    "use server";
    const result = await createCostCentre(input);
    return result.ok ? ({ ok: true } as const) : ({ ok: false, error: result.error } as const);
  }

  async function update(input: {
    id: string;
    name: string;
    description?: string;
    displayOrder: number;
    isActive: boolean;
  }) {
    "use server";
    const result = await updateCostCentre(input);
    return result.ok ? ({ ok: true } as const) : ({ ok: false, error: result.error } as const);
  }

  return (
    <main className="space-y-8 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Cost centres</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A reporting dimension over the ledger — department, branch, product line. A
            cost centre sits on a journal LINE, so one invoice can be split across two
            of them.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-sm">
          <Link href="/accounting/budgets" className="text-muted-foreground hover:underline">
            Budget versus actual
          </Link>
          <Link href="/accounting" className="text-muted-foreground hover:underline">
            Back to accounting
          </Link>
        </div>
      </header>

      <section aria-labelledby="cc-list-heading" className="space-y-3">
        <h2 id="cc-list-heading" className="text-lg font-semibold">
          The list
        </h2>
        {!listResult.ok ? (
          <p className="text-sm text-destructive">{listResult.error}</p>
        ) : (
          <CostCentreBoard
            rows={listResult.data}
            mayCreate={mayCreate}
            mayUpdate={mayUpdate}
            onCreate={create}
            onUpdate={update}
          />
        )}
      </section>

      <section aria-labelledby="cc-pl-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="cc-pl-heading" className="text-lg font-semibold">
              Profit &amp; loss by cost centre
            </h2>
            <p className="text-xs text-muted-foreground tabular-nums">
              {describePeriod(period)}
            </p>
            {/*
              ⚠️ WHAT COUNTS AS "IN THE BOOKS" IS STATED ON THE PAGE. This
              is the same filter the trial balance and the P&L use, and a
              departmental report that quietly used a different one would
              be the hardest kind of discrepancy to find.
            */}
            <p className="text-xs text-muted-foreground">
              Posted and reversed transactions. Voided and unposted entries are
              excluded; a reversal and the entry it reverses are both included and net
              to nothing.
            </p>
          </div>
          <form method="get" className="flex flex-wrap items-end gap-2">
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
            <Link
              href={`/accounting/cost-centres?from=${previous.from}&to=${previous.to}`}
              className="self-center text-xs text-muted-foreground hover:underline"
            >
              Previous FY
            </Link>
          </form>
        </div>

        {!plResult.ok ? (
          <p className="text-sm text-destructive">{plResult.error}</p>
        ) : !plResult.data.reconciliation.renderable ? (
          /*
           * 🔴 NO FIGURE AT ALL WHEN THE TWO ROUTES DISAGREE. Not an
           * asterisk and not an amber badge: a correct-looking number
           * under a heading that has just failed its own check reads as
           * verification to the person holding it.
           */
          <ReconciliationNotice reconciliation={plResult.data.reconciliation} />
        ) : (
          <div className="space-y-3">
            <ReconciliationNotice reconciliation={plResult.data.reconciliation} />
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Profit and loss grouped by cost centre, including the un-allocated
                  bucket
                </caption>
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">Code</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">Cost centre</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Revenue</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Expenditure</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Result</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Lines</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {plResult.data.buckets.map((b) => (
                    <tr key={b.key} className={b.isUncosted ? "bg-muted/20" : undefined}>
                      <td className="px-3 py-2 font-mono text-xs">{b.code || "—"}</td>
                      <td className="px-3 py-2">
                        {b.name}
                        {b.isUncosted && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            journal lines carrying no cost centre
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {inrFromMinor(b.revenueMinor)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {inrFromMinor(b.expenseMinor)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {inrFromMinor(b.netResultMinor)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                        {b.lineCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-border bg-muted/30 font-medium">
                  <tr>
                    <td className="px-3 py-2" colSpan={4}>
                      Total — equal to the profit &amp; loss for the same period
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {inrFromMinor(plResult.data.totalNetResultMinor)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
