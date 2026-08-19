/**
 * Ordence — Settings · Financial
 * Version: v0.7.0-alpha
 */

import Link from "next/link";
import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { getWorkspaceSettings } from "@/server/actions/settings";
import { checkCurrencyUnits } from "@/server/actions/fx";
import { functionalCurrencyFromSettings } from "@/lib/fx/currency";
import { FinancialSettingsForm } from "./financial-form";

export const dynamic = "force-dynamic";

export default async function FinancialSettingsPage() {
  const ctx = await requirePageContext();
  const [result, units] = await Promise.all([getWorkspaceSettings(), checkCurrencyUnits()]);

  if (!result.ok) {
    return <p className="text-sm text-destructive">{result.error}</p>;
  }

  const s = result.data.settings;

  /**
   * ⭐ THE FUNCTIONAL CURRENCY, READ THE WAY THE ENGINE READS IT.
   *
   * 🔴 `isDefault` IS THE POINT. A workspace that never chose one keeps
   * its books in INR because Ordence decided that, not because the
   * customer did — and every revaluation, every conversion and every
   * total on the FX console is denominated in it. An assumed currency
   * that is never said out loud is how somebody finds out from a
   * restatement.
   */
  const functional = functionalCurrencyFromSettings(s);

  return (
    <div className="space-y-6">
      <FinancialSettingsForm
        canEdit={can(
          { role: ctx.role, overrides: ctx.user.permissionOverrides },
          "settings:update",
        )}
        defaults={{
          currency: (s.currency as string) ?? "INR",
          country: (s.country as string) ?? "IN",
          fiscalYearStartMonth: String(s.fiscalYearStartMonth ?? 4),
          requireMfa: s.requireMfa === true,
          sessionIdleMinutes: String(s.sessionIdleMinutes ?? 60),
        }}
      />

      <section className="space-y-2 rounded border p-4">
        <h2 className="text-sm font-semibold">Currency and exchange rates</h2>
        <p className="text-sm text-muted-foreground" data-testid="settings-functional-currency">
          Your books are kept in <span className="font-medium">{functional.code}</span>
          {functional.isDefault
            ? " — assumed, because no functional currency has been chosen for this workspace."
            : "."}
        </p>
        <p className="text-sm">
          <Link href="/fx" className="underline">
            Exchange rates, exposure and the reporting-date restatement
          </Link>
        </p>

        {/*
          🔴 THE DUPLICATE, SURFACED — `checkCurrencyUnits`.
          `currency_units` in the database and `lib/fx/currency.ts` in the
          engine hold the same exponent table for two different consumers,
          because a SQL report cannot import TypeScript. Two copies of a
          fact drift, and this one would drift SILENTLY: a wrong exponent
          in the table changes what a hand-written report prints and
          nothing else. So it is compared, and the comparison is on a
          screen. A duplicate that is checked is a cache; a duplicate that
          is not is a second source of truth wearing a disguise.
        */}
        {!units.ok ? (
          <p className="text-sm text-destructive">{units.error}</p>
        ) : units.data.agree ? (
          <p className="text-xs text-muted-foreground" data-testid="currency-units-agree">
            Minor-unit check: the database&apos;s <span className="font-mono">currency_units</span>{" "}
            table and the engine&apos;s exponent table agree on every currency. JPY has no
            decimal places, the Gulf dinars have three, and nothing in this product divides by
            a hundred.
          </p>
        ) : (
          <div className="space-y-2" data-testid="currency-units-diverged">
            <p className="text-sm text-destructive">
              Minor-unit check: {units.data.divergences.length} currenc
              {units.data.divergences.length === 1 ? "y disagrees" : "ies disagree"} between
              the database and the engine. A SQL-side report will scale those amounts
              differently from this application.
            </p>
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-2 font-medium">Currency</th>
                    <th className="p-2 text-right font-medium">In the database</th>
                    <th className="p-2 text-right font-medium">In the engine</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {units.data.divergences.map((d) => (
                    <tr key={d.code}>
                      <td className="p-2 font-mono text-xs">{d.code}</td>
                      <td className="p-2 text-right tabular-nums">
                        {d.inDatabase ?? "missing"}
                      </td>
                      <td className="p-2 text-right tabular-nums">{d.inEngine ?? "unknown"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
