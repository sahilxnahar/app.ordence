"use client";

/**
 * Ordence — Chart Colour Mode
 * Version: v0.10.0-alpha
 *
 * Recharts takes concrete colour values, not CSS custom properties, so a
 * chart cannot inherit dark mode the way the rest of the UI does. It has to
 * know which mode it is in and pick the matching validated step.
 *
 * WHY THE DARK VALUES ARE NOT A FILTER OVER THE LIGHT ONES:
 * They are separately chosen steps of the same hues, validated against the
 * dark surface. An automatic lightening would produce colours that passed
 * no check — which is how a palette that reads well on white becomes
 * unreadable on charcoal.
 */

import * as React from "react";

export function useChartMode(): "light" | "dark" {
  // Default to light for the server render, so the markup is stable and
  // hydration does not mismatch. The effect corrects it on mount.
  const [mode, setMode] = React.useState<"light" | "dark">("light");

  React.useEffect(() => {
    const read = (): "light" | "dark" => {
      const root = document.documentElement;

      // An explicit choice wins over the OS setting, both ways.
      if (root.classList.contains("dark") || root.dataset.theme === "dark") return "dark";
      if (root.classList.contains("light") || root.dataset.theme === "light") return "light";

      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    };

    setMode(read());

    // Follow both the OS setting and a runtime class/attribute change, so a
    // theme toggle repaints the charts without a reload.
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMedia = () => setMode(read());
    media?.addEventListener?.("change", onMedia);

    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    return () => {
      media?.removeEventListener?.("change", onMedia);
      observer.disconnect();
    };
  }, []);

  return mode;
}

/* ------------------------------------------------------------------ */
/* SHARED FORMATTING                                                   */
/* ------------------------------------------------------------------ */

/**
 * Format a decimal STRING as Indian-grouped currency, without ever parsing
 * it to a float.
 *
 * `1234567.89` → `₹12,34,567.89`
 *
 * Indian grouping is not every-three-digits: it is the last three, then
 * pairs. `Intl.NumberFormat("en-IN")` gets this right, but it takes a
 * number — so the grouping is done on the digit string directly and the
 * value never becomes a float at any point.
 */
/**
 * ⭐ A MONETARY FIGURE THAT KNOWS WHAT IT IS A QUANTITY OF.
 *
 * The shape `server/actions/analytics.ts` and `server/actions/reports.ts`
 * both emit. `currencyAssumed` is true when the label is the workspace's
 * functional currency applied because the underlying table has no
 * `currency` column at all — a property of the schema, not a measurement.
 */
export type LabelledValueLike = {
  currency: string;
  value: string;
  currencyAssumed: boolean;
};

/**
 * 🔴 RENDERS EVERY CURRENCY SIDE BY SIDE AND NEVER ADDS THEM.
 *
 * A dashboard tile has room for one number and that is exactly why the
 * previous version of these panels showed one: `sum()` across currencies
 * fits, and is meaningless. Two currencies produce two figures separated
 * by a middot; a reader can see there are two, which is the whole point.
 *
 * An empty list is an em dash, not "₹0.00" — no assets is not the same
 * fact as assets worth nothing.
 */
export function formatLabelledValues(values: readonly LabelledValueLike[]): string {
  if (values.length === 0) return "—";
  return values.map((v) => formatCurrencyString(v.value, v.currency)).join(" · ");
}

export function formatCurrencyString(value: string, currency = "INR"): string {
  const trimmed = String(value ?? "0").trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;

  const [whole = "0", fraction = "00"] = unsigned.split(".");

  // Indian digit grouping: last 3, then 2s.
  let grouped: string;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }

  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${grouped}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

/**
 * A short axis label: `1234567.89` → `₹12.3L`.
 *
 * This IS lossy, and deliberately so — an axis tick is a scale reference,
 * not a figure anyone reconciles against. Exact values appear in the
 * tooltip and the table view, both formatted from the original string.
 */
export function formatCompactCurrency(value: number, currency = "INR"): string {
  const symbol = currency === "INR" ? "₹" : "";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (abs >= 10_000_000) return `${sign}${symbol}${(abs / 10_000_000).toFixed(1)}Cr`;
  if (abs >= 100_000) return `${sign}${symbol}${(abs / 100_000).toFixed(1)}L`;
  if (abs >= 1_000) return `${sign}${symbol}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${symbol}${abs.toFixed(0)}`;
}

/** "in_progress" → "In progress". Enum values are not display strings. */
export function humaniseLabel(value: string): string {
  const spaced = String(value ?? "").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Decimal string → float, for geometry only.
 *
 * The single place money becomes a float in this application. It is called
 * to compute a pixel height and nothing else; every number a user READS is
 * formatted from the original string.
 */
export function toChartNumber(value: string): number {
  const n = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(n) ? n : 0;
}
