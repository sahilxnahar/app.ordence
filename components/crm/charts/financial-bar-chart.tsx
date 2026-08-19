"use client";

/**
 * Ordence — 30-Day Ledger Balances
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY GROUPED BARS AND NOT A DUAL-AXIS LINE
 * ══════════════════════════════════════════════════════════════════════
 * Debits and credits are the same measure in the same unit, compared day
 * by day. That is a magnitude-comparison job, which is what bars are for.
 *
 * A second y-axis was never on the table. Two y-scales let a chart imply
 * any relationship the author likes — the crossing point is an artefact of
 * where you put the axes, not of the data. Both series share one scale
 * here, so "the blue bar is taller" means exactly what it looks like.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY EVERY DAY IS DRAWN, INCLUDING EMPTY ONES
 * ══════════════════════════════════════════════════════════════════════
 * The view generates a full 30-day spine, so a day with no transactions
 * arrives as an explicit zero rather than a missing row.
 *
 * That matters more than it sounds. A `GROUP BY date` returns only days
 * with activity, and a chart drawn from that renders three transactions in
 * a fortnight as three ADJACENT bars — which reads as three consecutive
 * trading days. The gaps are information.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TABLE VIEW IS NOT OPTIONAL
 * ══════════════════════════════════════════════════════════════════════
 * The palette validator flagged three light-mode hues below 3:1 contrast
 * against white. The obligation that comes with that is relief: the same
 * numbers must be readable as text. That is what "View as table" is for,
 * and it is also the accessible path for anyone who cannot use the chart
 * at all. It should not be removed to tidy the UI.
 */

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Table2, ChartColumn } from "lucide-react";
import { useChartMode, formatCurrencyString, formatCompactCurrency, toChartNumber } from "./use-chart-mode";
import { FINANCIAL_SERIES, CHROME } from "./palette";

export type LedgerDayPoint = {
  day: string;
  debits: string;
  credits: string;
  netMovement: string;
  transactionCount: number;
};

type ChartRow = {
  day: string;
  label: string;
  debits: number;
  credits: number;
  debitsExact: string;
  creditsExact: string;
  transactionCount: number;
};

function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/* ------------------------------------------------------------------ */
/* TOOLTIP                                                             */
/* ------------------------------------------------------------------ */

/**
 * The tooltip shows EXACT values, formatted from the original decimal
 * strings — not from the floats the bars were drawn with. The geometry is
 * approximate; the numbers a person reads never are.
 */
function LedgerTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  /** ⚠️ Threaded in rather than defaulted. See the component header. */
  currency: string;
}) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 shadow-md">
      <p className="text-xs font-semibold text-foreground">{row.label}</p>

      <dl className="mt-1.5 space-y-1">
        <div className="flex items-center justify-between gap-6 text-xs">
          <dt className="flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: "var(--chart-debits)" }}
            />
            Debits
          </dt>
          <dd className="font-medium tabular-nums text-foreground">
            {formatCurrencyString(row.debitsExact, currency)}
          </dd>
        </div>

        <div className="flex items-center justify-between gap-6 text-xs">
          <dt className="flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: "var(--chart-credits)" }}
            />
            Credits
          </dt>
          <dd className="font-medium tabular-nums text-foreground">
            {formatCurrencyString(row.creditsExact, currency)}
          </dd>
        </div>
      </dl>

      <p className="mt-1.5 border-t border-border pt-1.5 text-[11px] text-muted-foreground">
        {row.transactionCount === 0
          ? "No transactions"
          : `${row.transactionCount} transaction${row.transactionCount === 1 ? "" : "s"}`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ONE CHART PER CURRENCY, AND THE CURRENCY IS A REQUIRED PROP.
 *
 * `v_ledger_daily` groups by `transactions.currency` since 0104, and
 * `getLedgerTrailing30()` returns one series per currency. A workspace
 * posting in two currencies renders two of these, because a trial balance
 * is only balanced WITHIN a currency: merging two series and asking
 * whether the window foots gives "out of balance" on books that are in
 * order, or "balanced" on books that are not because two imbalances
 * cancelled as bare numbers.
 *
 * ⚠️ THE PROP HAS NO DEFAULT. `formatCurrencyString` defaults to INR and
 * that default is exactly how an unlabelled figure acquires a rupee sign
 * it never earned.
 */
export function FinancialBarChart({
  days,
  currency,
  totalDebits,
  totalCredits,
  isBalanced,
  difference,
  activeDays,
}: {
  days: LedgerDayPoint[];
  currency: string;
  totalDebits: string;
  totalCredits: string;
  isBalanced: boolean;
  difference: string;
  activeDays: number;
}) {
  const mode = useChartMode();
  const [showTable, setShowTable] = React.useState(false);

  const debitColor = FINANCIAL_SERIES.debits[mode];
  const creditColor = FINANCIAL_SERIES.credits[mode];

  const rows: ChartRow[] = React.useMemo(
    () =>
      days.map((d) => ({
        day: d.day,
        label: shortDay(d.day),
        // Floats, for pixel heights only.
        debits: toChartNumber(d.debits),
        credits: toChartNumber(d.credits),
        // Strings, for everything a person reads.
        debitsExact: d.debits,
        creditsExact: d.credits,
        transactionCount: d.transactionCount,
      })),
    [days],
  );

  const hasAnyActivity = activeDays > 0;

  return (
    <section
      className="space-y-3"
      aria-labelledby="ledger-chart-heading"
      // Exposed as custom properties so the tooltip swatches use the same
      // validated values as the bars, without threading props through.
      style={
        {
          "--chart-debits": debitColor,
          "--chart-credits": creditColor,
        } as React.CSSProperties
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="ledger-chart-heading" className="text-sm font-semibold">
            Ledger movement — last 30 days ({currency})
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hasAnyActivity
              ? `${activeDays} of 30 days had activity`
              : "No transactions in the last 30 days"}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
          aria-pressed={showTable}
        >
          {showTable ? (
            <>
              <ChartColumn className="h-3.5 w-3.5" aria-hidden="true" />
              View as chart
            </>
          ) : (
            <>
              <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
              View as table
            </>
          )}
        </button>
      </div>

      {/* Headline totals, formatted from strings — exact. */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: debitColor }}
            />
            Total debits
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">
            {formatCurrencyString(totalDebits, currency)}
          </dd>
        </div>

        <div className="rounded-md border border-border p-3">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: creditColor }}
            />
            Total credits
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">
            {formatCurrencyString(totalCredits, currency)}
          </dd>
        </div>

        {/*
          The balance verdict. A word and an icon, never colour alone —
          status colours are reserved and always carry a label.
        */}
        <div className="col-span-2 rounded-md border border-border p-3 sm:col-span-1">
          <dt className="text-xs text-muted-foreground">Balance</dt>
          <dd
            className={
              isBalanced
                ? "mt-1 text-lg font-semibold text-emerald-700 dark:text-emerald-400"
                : "mt-1 text-lg font-semibold text-destructive"
            }
          >
            {isBalanced ? "Balanced" : `Out by ${formatCurrencyString(difference, currency)}`}
          </dd>
        </div>
      </dl>

      {showTable ? (
        /* ── TABLE VIEW ──────────────────────────────────────────── */
        <div className="max-h-80 overflow-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Daily ledger debits and credits for the last 30 days
            </caption>
            <thead className="sticky top-0 bg-muted/80 text-xs uppercase text-muted-foreground backdrop-blur">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">Day</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Debits</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Credits</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Txns</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.day} className={row.transactionCount === 0 ? "text-muted-foreground" : ""}>
                  <td className="px-3 py-1.5">{row.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatCurrencyString(row.debitsExact, currency)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatCurrencyString(row.creditsExact, currency)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {row.transactionCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !hasAnyActivity ? (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Nothing has been posted to the ledger in the last 30 days.
        </p>
      ) : (
        /* ── CHART VIEW ──────────────────────────────────────────── */
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
              {/* Recessive grid: horizontal only. Vertical lines add no
                  information on a categorical axis and compete with bars. */}
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={CHROME.grid[mode]}
                vertical={false}
              />

              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: CHROME.axis[mode] }}
                tickLine={false}
                axisLine={{ stroke: CHROME.grid[mode] }}
                // 30 labels will not fit on a phone. Recharts drops the
                // ones that would collide rather than rotating them into
                // an unreadable fan.
                interval="preserveStartEnd"
                minTickGap={24}
              />

              <YAxis
                tick={{ fontSize: 11, fill: CHROME.axis[mode] }}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => formatCompactCurrency(v, currency)}
              />

              <Tooltip
                content={<LedgerTooltip currency={currency} />}
                cursor={{ fill: CHROME.grid[mode], opacity: 0.35 }}
              />

              {/* Two series, so a legend is always present — identity is
                  never carried by colour alone. */}
              <Legend
                verticalAlign="bottom"
                height={28}
                iconType="square"
                iconSize={9}
                formatter={(value) => (
                  <span className="text-xs text-muted-foreground">{value}</span>
                )}
              />

              {/* 4px rounded data-ends, anchored to the baseline. The
                  2px gap between adjacent bars is the surface showing
                  through, which keeps neighbouring fills from reading as
                  one shape. */}
              <Bar
                dataKey="debits"
                name={FINANCIAL_SERIES.debits.label}
                fill={debitColor}
                radius={[4, 4, 0, 0]}
                maxBarSize={14}
              />
              <Bar
                dataKey="credits"
                name={FINANCIAL_SERIES.credits.label}
                fill={creditColor}
                radius={[4, 4, 0, 0]}
                maxBarSize={14}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
