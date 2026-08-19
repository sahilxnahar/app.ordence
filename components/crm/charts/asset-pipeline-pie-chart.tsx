"use client";

/**
 * Ordence — Asset Portfolio by Status
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A DONUT AND NOT A PIE
 * ══════════════════════════════════════════════════════════════════════
 * The hole is not decoration. A donut puts the headline figure — total
 * asset count — where the eye already is, so the chart answers "how many
 * altogether?" and "how are they split?" in one look. A solid pie has to
 * put that number somewhere else.
 *
 * Both forms are weak at precise comparison; people judge angle badly. So
 * every slice carries its count as a direct label, and the exact figures
 * are one click away in the table view. The shape is for proportion at a
 * glance, not for reading values off.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY AT MOST FIVE SLICES
 * ══════════════════════════════════════════════════════════════════════
 * A donut compares every slice against every other, so the palette has to
 * hold on the ALL-PAIRS test rather than just between neighbours. Measured
 * on this application's surfaces, the fourth and second slots (yellow and
 * orange) fail that floor together — normal-vision ΔE 13.7 against a 15
 * minimum.
 *
 * Five slices stays inside what was actually validated. Everything beyond
 * folds into a grey "Other", which is honest and countable, rather than
 * into a generated sixth hue that has passed no check at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TABLE VIEW IS REQUIRED, NOT A NICETY
 * ══════════════════════════════════════════════════════════════════════
 * Three light-mode hues measured below 3:1 against white. The rule that
 * comes with that is relief — the same information must be available as
 * text. Removing the toggle would leave those slices carrying meaning by
 * colour alone for a low-vision reader.
 */

import * as React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Table2, ChartPie } from "lucide-react";
import {
  useChartMode,
  formatLabelledValues,
  humaniseLabel,
  type LabelledValueLike,
} from "./use-chart-mode";
import { CATEGORICAL, MAX_CATEGORICAL_SLICES, OTHER_COLOR } from "./palette";

export type AssetSlice = {
  status: string;
  assetCount: number;
  /**
   * ⭐ ONE FIGURE PER CURRENCY, NOT ONE FIGURE. `assets.currency` has
   * always existed; until 0104 this was a single string holding the sum of
   * every currency in the slice, which is a number in the units of
   * nothing. The pie's GEOMETRY was never affected — it is drawn from
   * `assetCount`, and a count is currency-free — but the label beside each
   * wedge was.
   */
  valueByCurrency: LabelledValueLike[];
};

type PreparedSlice = {
  key: string;
  label: string;
  count: number;
  value: LabelledValueLike[];
  color: string;
  percent: number;
  isOther: boolean;
  /** Which statuses were folded in, so "Other" is never a mystery. */
  foldedFrom?: string[];
};

/* ------------------------------------------------------------------ */
/* TOOLTIP                                                             */
/* ------------------------------------------------------------------ */

function SliceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PreparedSlice }>;
}) {
  if (!active || !payload?.length) return null;

  const slice = payload[0]?.payload;
  if (!slice) return null;

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 shadow-md">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-[2px]"
          style={{ background: slice.color }}
        />
        {slice.label}
      </p>

      <p className="mt-1 text-xs text-muted-foreground">
        {slice.count} asset{slice.count === 1 ? "" : "s"} · {slice.percent.toFixed(1)}%
      </p>

      <p className="mt-0.5 text-xs font-medium tabular-nums text-foreground">
        {formatLabelledValues(slice.value)}
      </p>

      {slice.isOther && slice.foldedFrom && (
        <p className="mt-1 border-t border-border pt-1 text-[11px] text-muted-foreground">
          {slice.foldedFrom.map(humaniseLabel).join(", ")}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */

export function AssetPipelinePieChart({
  slices,
  totalAssets,
  totalValueByCurrency,
}: {
  slices: AssetSlice[];
  totalAssets: number;
  /** Never a scalar. See `AssetSlice.valueByCurrency`. */
  totalValueByCurrency: LabelledValueLike[];
}) {
  const mode = useChartMode();
  const [showTable, setShowTable] = React.useState(false);

  const prepared: PreparedSlice[] = React.useMemo(() => {
    const sorted = [...slices].sort((a, b) => b.assetCount - a.assetCount);
    const total = sorted.reduce((sum, s) => sum + s.assetCount, 0);
    if (total === 0) return [];

    const head = sorted.slice(0, MAX_CATEGORICAL_SLICES);
    const tail = sorted.slice(MAX_CATEGORICAL_SLICES);

    const result: PreparedSlice[] = head.map((s, i) => ({
      key: s.status,
      label: humaniseLabel(s.status),
      count: s.assetCount,
      value: s.valueByCurrency,
      // Fixed order by index. Colour follows the ENTITY as ranked here, and
      // the ranking is stable for a given data set — so the same status
      // keeps the same colour between renders.
      color: CATEGORICAL[mode][i]!,
      percent: (s.assetCount / total) * 100,
      isOther: false,
    }));

    if (tail.length > 0) {
      const count = tail.reduce((sum, s) => sum + s.assetCount, 0);

      // Summed as exact scaled integers. Adding a handful of rupee values
      // as floats drifts, and a dashboard that disagrees with the ledger by
      // a few paise undermines confidence in both numbers.
      //
      // 🔴 AND SUMMED PER CURRENCY. Folding four statuses into "Other" used
      // to fold four currencies into one number as well — the fold is
      // exactly where a mixed-currency total hides best, because nobody
      // expects "Other" to be precise.
      //
      // ⚠️ The `* 100n` here is the two decimal places of the
      // `numeric(20, 2)` column this string came from. It is NOT a
      // minor-unit conversion; the yen has no minor unit and the dinar has
      // three. See `lib/fx/currency.ts`.
      const folded = new Map<string, bigint>();
      for (const s of tail) {
        for (const v of s.valueByCurrency) {
          const [whole = "0", frac = "00"] = String(v.value ?? "0").split(".");
          const negative = whole.startsWith("-");
          const digits = negative ? whole.slice(1) : whole;
          const w = /^\d+$/.test(digits) ? BigInt(digits) : 0n;
          const f = BigInt(frac.padEnd(2, "0").slice(0, 2));
          const scaled = (w * 100n + f) * (negative ? -1n : 1n);
          folded.set(v.currency, (folded.get(v.currency) ?? 0n) + scaled);
        }
      }

      const foldedValues: LabelledValueLike[] = [...folded.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([currency, scaled]) => {
          const neg = scaled < 0n;
          const abs = neg ? -scaled : scaled;
          return {
            currency,
            value: `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`,
            currencyAssumed: false,
          };
        });

      result.push({
        key: "__other__",
        label: "Other",
        count,
        value: foldedValues,
        color: OTHER_COLOR[mode],
        percent: (count / total) * 100,
        isOther: true,
        foldedFrom: tail.map((s) => s.status),
      });
    }

    return result;
  }, [slices, mode]);

  const isEmpty = prepared.length === 0;

  return (
    <section className="space-y-3" aria-labelledby="asset-chart-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="asset-chart-heading" className="text-sm font-semibold">
            Portfolio by status
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {totalAssets} asset{totalAssets === 1 ? "" : "s"} ·{" "}
            {formatLabelledValues(totalValueByCurrency)}
          </p>
        </div>

        {!isEmpty && (
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
            aria-pressed={showTable}
          >
            {showTable ? (
              <>
                <ChartPie className="h-3.5 w-3.5" aria-hidden="true" />
                View as chart
              </>
            ) : (
              <>
                <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
                View as table
              </>
            )}
          </button>
        )}
      </div>

      {isEmpty ? (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No assets recorded yet.
        </p>
      ) : showTable ? (
        /* ── TABLE VIEW ──────────────────────────────────────────── */
        <div className="overflow-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Asset portfolio broken down by status</caption>
            <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Assets</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Share</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {prepared.map((slice) => (
                <tr key={slice.key}>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ background: slice.color }}
                      />
                      {slice.label}
                      {slice.isOther && slice.foldedFrom && (
                        <span className="text-xs text-muted-foreground">
                          ({slice.foldedFrom.length} statuses)
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{slice.count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {slice.percent.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatLabelledValues(slice.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* ── CHART VIEW ──────────────────────────────────────────── */
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <div className="relative h-56 w-full sm:w-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={prepared}
                  dataKey="count"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius="60%"
                  outerRadius="88%"
                  // A 2px gap of surface between segments, so neighbouring
                  // fills never read as one continuous shape.
                  paddingAngle={2}
                  strokeWidth={2}
                  // The stroke is the SURFACE colour, not a border colour —
                  // it is the gap, not an outline.
                  stroke={mode === "dark" ? "#1a1a1a" : "#ffffff"}
                  isAnimationActive={false}
                >
                  {prepared.map((slice) => (
                    <Cell key={slice.key} fill={slice.color} />
                  ))}
                </Pie>

                <Tooltip content={<SliceTooltip />} />
              </PieChart>
            </ResponsiveContainer>

            {/* The headline figure, in the hole. This is the whole reason
                for the donut form. `pointer-events-none` so it never
                intercepts a hover meant for a segment. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold tabular-nums">{totalAssets}</span>
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {totalAssets === 1 ? "Asset" : "Assets"}
              </span>
            </div>
          </div>

          {/* Legend with DIRECT VALUES beside every entry. This is the
              secondary encoding the palette validation obliges — identity
              and magnitude are both readable without relying on hue. */}
          <ul className="w-full flex-1 space-y-1.5">
            {prepared.map((slice) => (
              <li
                key={slice.key}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ background: slice.color }}
                  />
                  <span className="truncate">{slice.label}</span>
                </span>

                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {slice.count}
                  <span className="ml-1.5 text-xs">({slice.percent.toFixed(0)}%)</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
