/**
 * Ordence — ⭐⭐⭐ THE FIXED ASSET REGISTER
 * Batch 100 · v1.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 MIGRATION 0100 BUILT THE ENGINE AND NOTHING RENDERED IT
 * ══════════════════════════════════════════════════════════════════════
 * Four tables, a pure Schedule II / section 32 engine and eleven guarded
 * server actions shipped without a single screen — and
 * `revalidatePath("/fixed-assets")` in those actions pointed at a page
 * that did not exist. An Indian company keeping its books here could not
 * produce a depreciation schedule, could not post the journal and could
 * not sign its accounts.
 *
 * ⚠️ THE "DEPRECIATED TO DATE" COLUMN IS THE SCHEDULE, NOT THE LEDGER,
 * AND THE HEADING SAYS SO. There is deliberately no accumulated-
 * depreciation column on `fixed_assets` — the posted lines are the
 * balance and nothing else is. What this column shows is the same engine
 * replayed over the years the asset has lived, which is the figure an
 * auditor recomputes and compares the ledger against.
 *
 * ⭐ AND A MISCONFIGURED ASSET SHOWS ITS REFUSAL HERE. An asset whose
 * useful life departs from Part C with no justification recorded cannot
 * be depreciated at all; the register is the place that has to say so,
 * because at the first run it stops the whole period.
 */

import Link from "next/link";
import { postingAccountsHref } from "@/lib/accounting/sales-posting";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RegisterAssetForm } from "@/components/fixed-assets/register-asset-form";
import {
  fixedAssetAccountsNeeded,
  listFixedAssets,
  registerFixedAsset,
} from "@/server/actions/fixed-assets";
import { checkPermission } from "@/server/audit";
import { todayInIndia } from "@/lib/accounting/periods";
import { SCHEDULE_II, SCHEDULE_II_CLASSES } from "@/lib/fixed-assets/depreciation";
import {
  ASSET_STATUSES,
  filterRegister,
  formatMinor,
  readBlockRow,
  readRegisterRow,
  workingToDate,
} from "@/lib/fixed-assets/register-view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Fixed assets · Ordence" };

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  in_use: "default",
  disposed: "secondary",
  written_off: "destructive",
};

export default async function FixedAssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ assetClass?: string; status?: string }>;
}) {
  const { assetClass, status } = await searchParams;
  const [register, accounts, manage] = await Promise.all([
    listFixedAssets(),
    fixedAssetAccountsNeeded(),
    checkPermission("fixed_assets.manage"),
  ]);

  /**
   * 🔴 A DENIAL IS A STATE, NOT A CRASH. `listFixedAssets` refuses with
   * the permission system's own sentence; printing it is the whole
   * handling this page needs.
   */
  if (!register.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Fixed assets</h1>
        <p role="alert" className="text-sm text-destructive">
          {register.error}
        </p>
      </main>
    );
  }

  const asAt = todayInIndia();
  const rows = register.data.assets.map(readRegisterRow);
  const blocks = register.data.blocks.map(readBlockRow);
  const visible = filterRegister(rows, { assetClass, status });
  const unmapped = accounts.ok ? accounts.data.roles.filter((r) => !r.mapped) : [];

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Fixed assets</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The register the Companies Act depreciates and the Income-tax Act pools. Two
          statutes, one set of assets, two figures that diverge permanently — and neither
          is a correction of the other.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/fixed-assets/depreciation" className="underline">
            Depreciation runs
          </Link>{" "}
          ·{" "}
          <Link href="/fixed-assets/income-tax" className="underline">
            Income tax &amp; deferred tax
          </Link>
        </p>
      </div>

      {unmapped.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Accounts still to map</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="text-muted-foreground">
              {/* ⭐ Answered before the first run, not at the moment posting fails. */}
              Depreciation cannot reach the ledger until these are mapped. A journal
              missing a leg does not balance, so nothing would be posted.
            </p>
            <ul className="list-disc pl-5">
              {unmapped.map((r) => (
                <li key={r.role}>
                  <span className="font-medium">{r.label}</span> — {r.help}
                </li>
              ))}
            </ul>
            {/**
              * ⭐⭐ THE DESTINATION. Batch 0108.
              *
              * 🔴 THIS PANEL COMPUTED EXACTLY WHICH ACCOUNTS WERE MISSING,
              * NAMED THEM, EXPLAINED WHY EACH MATTERED — AND OFFERED NO WAY
              * TO GO AND MAP ANY OF THEM. It could not: until this batch the
              * posting-accounts screen's role list was built from four of
              * the nine families, so `depreciation_expense` and the other
              * five were absent from the form AND rejected by
              * `setSalesPostingAccount`'s validator. A screen that tells you
              * what is wrong and cannot take you to the fix is a screen that
              * teaches people the product is broken.
              */}
            <p className="pt-2">
              <Link
                href={postingAccountsHref("fixed_assets")}
                className="underline underline-offset-4"
              >
                Map these accounts
              </Link>
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Assets{" "}
            <span className="font-normal text-muted-foreground">({visible.length})</span>
          </CardTitle>
          <form className="flex flex-wrap gap-2 pt-2" action="/fixed-assets">
            <select
              name="assetClass"
              defaultValue={assetClass ?? "all"}
              aria-label="Filter by class"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="all">Every class</option>
              {SCHEDULE_II_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {SCHEDULE_II[c].label}
                </option>
              ))}
            </select>
            <select
              name="status"
              defaultValue={status ?? "all"}
              aria-label="Filter by status"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="all">Every status</option>
              {ASSET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="h-9 rounded-md border border-input px-3 text-sm"
            >
              Filter
            </button>
          </form>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {rows.length === 0
                ? "No assets are capitalised yet. Depreciation is computed from what is in this register, so an empty register charges nothing."
                : "Nothing matches those filters."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Asset</th>
                  <th className="py-2 pr-3 font-medium">Class</th>
                  <th className="py-2 pr-3 font-medium">Cost</th>
                  <th className="py-2 pr-3 font-medium">Method</th>
                  <th className="py-2 pr-3 font-medium">Put to use</th>
                  <th className="py-2 pr-3 font-medium">
                    Depreciated to date
                    <span className="block font-normal normal-case">
                      per the Schedule II working
                    </span>
                  </th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => {
                  const working = workingToDate(a, asAt);
                  return (
                    <tr key={a.id} className="border-b align-top last:border-0">
                      <td className="py-2 pr-3">
                        <Link href={`/fixed-assets/${a.id}`} className="font-medium underline">
                          {a.assetNo}
                        </Link>
                        <p className="text-xs text-muted-foreground">{a.description}</p>
                      </td>
                      <td className="py-2 pr-3">
                        {a.assetClassLabel}
                        {a.prescribedLifeMonths !== null &&
                          a.prescribedLifeMonths !== a.usefulLifeMonths && (
                            <p className="text-xs text-amber-700">
                              {a.usefulLifeMonths} months, against {a.prescribedLifeMonths}{" "}
                              prescribed
                            </p>
                          )}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{formatMinor(a.costMinor)}</td>
                      <td className="py-2 pr-3 uppercase">{a.depreciationMethod}</td>
                      <td className="py-2 pr-3 tabular-nums">{a.putToUseOn}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {working.ok ? (
                          <>
                            {formatMinor(working.chargedMinor)}
                            <p className="text-xs text-muted-foreground">
                              carrying {formatMinor(working.carryingMinor)}
                            </p>
                          </>
                        ) : (
                          <span className="text-xs text-destructive">{working.refusal}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={STATUS_TONE[a.status] ?? "outline"}>
                          {a.status.replace("_", " ")}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <RegisterAssetForm
        blocks={blocks}
        registerAction={registerFixedAsset}
        canManage={manage.allowed}
      />
    </main>
  );
}
