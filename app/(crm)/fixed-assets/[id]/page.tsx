/**
 * Ordence — ⭐⭐ ONE ASSET: THE SCHEDULE AN AUDITOR ASKS FOR
 * Batch 100 · v1.65.0-alpha
 *
 * ⚠️ THE SCHEDULE IS COMPUTED FROM ZERO, NOT FROM WHAT HAS BEEN POSTED,
 * and the heading says so. Starting it from the posted balance would make
 * it agree with the ledger by construction and prove nothing — the whole
 * value of the working is that it is an independent recomputation.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DisposeAsset } from "@/components/fixed-assets/dispose-asset";
import {
  depreciationSchedule,
  disposeFixedAsset,
  listFixedAssets,
} from "@/server/actions/fixed-assets";
import { checkPermission } from "@/server/audit";
import { formatMinor, readRegisterRow } from "@/lib/fixed-assets/register-view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Fixed asset · Ordence" };

const money = (v: unknown): string => {
  const s = String(v ?? "");
  return /^-?\d+$/.test(s) ? formatMinor(BigInt(s)) : "—";
};

export default async function FixedAssetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [register, post] = await Promise.all([
    listFixedAssets(),
    checkPermission("fixed_assets.post"),
  ]);

  if (!register.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Fixed asset</h1>
        <p role="alert" className="text-sm text-destructive">
          {register.error}
        </p>
      </main>
    );
  }

  const asset = register.data.assets.map(readRegisterRow).find((a) => a.id === id);
  if (!asset) notFound();

  const schedule = await depreciationSchedule({ assetId: id });

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link href="/fixed-assets" className="text-xs underline">
          Fixed assets
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {asset.assetNo}
          <Badge variant={asset.status === "in_use" ? "default" : "secondary"}>
            {asset.status.replace("_", " ")}
          </Badge>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{asset.description}</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">How it is depreciated</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase text-muted-foreground">Cost</p>
            <p className="tabular-nums">{formatMinor(asset.costMinor)}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Class</p>
            <p>{asset.assetClassLabel}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Method</p>
            <p className="uppercase">{asset.depreciationMethod}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Useful life</p>
            <p className="tabular-nums">
              {asset.usefulLifeMonths} months
              {asset.prescribedLifeMonths !== null &&
                asset.prescribedLifeMonths !== asset.usefulLifeMonths &&
                ` · Part C prescribes ${asset.prescribedLifeMonths}`}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Residual</p>
            <p className="tabular-nums">{asset.residualBp} bp of cost</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Shift working</p>
            <p>{asset.shiftUsage}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Acquired</p>
            <p className="tabular-nums">{asset.acquiredOn}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Put to use</p>
            <p className="tabular-nums">{asset.putToUseOn}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Location</p>
            <p>{asset.location ?? "—"}</p>
          </div>
          {asset.lifeJustification !== null && (
            <div className="sm:col-span-3">
              <p className="text-xs uppercase text-muted-foreground">
                Justification for the useful life — Schedule II Part C
              </p>
              <p>{asset.lifeJustification}</p>
            </div>
          )}
          {asset.residualJustification !== null && (
            <div className="sm:col-span-3">
              <p className="text-xs uppercase text-muted-foreground">
                Justification for the residual — Part A note 5
              </p>
              <p>{asset.residualJustification}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            The whole-life schedule
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              recomputed from zero, not read back from the ledger
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto text-sm">
          {!schedule.ok ? (
            <p role="alert" className="text-destructive">
              {schedule.error}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Method</th>
                  <th className="py-2 pr-3 font-medium">Days</th>
                  <th className="py-2 pr-3 font-medium">Rate</th>
                  <th className="py-2 pr-3 font-medium">Opening accumulated</th>
                  <th className="py-2 pr-3 font-medium">Charge</th>
                  <th className="py-2 pr-3 font-medium">Closing accumulated</th>
                  <th className="py-2 pr-3 font-medium">Carrying</th>
                </tr>
              </thead>
              <tbody>
                {schedule.data.years.map((y, index) => (
                  <tr key={index} className="border-b align-top last:border-0">
                    <td className="py-2 pr-3">
                      {String(y.method ?? "")}
                      {y.terminal === true && (
                        <Badge variant="outline" className="ml-2">
                          final
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{String(y.daysInUse ?? "")}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {y.rateBp === null || y.rateBp === undefined
                        ? "—"
                        : `${Number(y.rateBp) / 100}%`}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {money(y.openingAccumulatedMinor)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums font-medium">
                      {money(y.chargeMinor)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {money(y.closingAccumulatedMinor)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{money(y.closingCarryingMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <DisposeAsset
        assetId={asset.id}
        assetNo={asset.assetNo}
        disposeAction={disposeFixedAsset}
        canPost={post.allowed}
        alreadyDisposed={asset.status !== "in_use"}
      />
    </main>
  );
}
