/**
 * Ordence — ⭐⭐⭐ SECTION 32, BESIDE THE BOOKS
 * Batch 100 · v1.65.0-alpha
 *
 * 🔴 THIS SCREEN NEVER OFFERS TO POST ANYTHING. The section 32 allowance
 * is a computation for the return; putting the Income-tax Act's figure
 * into a Companies Act balance sheet would overstate accumulated
 * depreciation by the whole timing difference, and a CHECK constraint in
 * 0100 refuses it whatever a screen asks for.
 */

import Link from "next/link";
import {
  deferredTaxWorking,
  listFixedAssets,
  runIncomeTaxDepreciation,
  saveItBlock,
} from "@/server/actions/fixed-assets";
import { checkPermission } from "@/server/audit";
import { IncomeTaxPanel } from "@/components/fixed-assets/income-tax-panel";
import { todayInIndia } from "@/lib/accounting/periods";
import { readBlockRow } from "@/lib/fixed-assets/register-view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Income-tax depreciation · Ordence" };

export default async function IncomeTaxDepreciationPage() {
  const [register, manage] = await Promise.all([
    listFixedAssets(),
    checkPermission("fixed_assets.manage"),
  ]);

  if (!register.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Income-tax depreciation</h1>
        <p role="alert" className="text-sm text-destructive">
          {register.error}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <Link href="/fixed-assets" className="text-xs underline">
          Fixed assets
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Income-tax depreciation</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Section 32 on the same assets the Companies Act charge runs on. It is per BLOCK
          rather than per asset, rate based rather than useful-life based, and halved for
          an asset used under 180 days. It produces a different number, both numbers are
          right, and the difference between them is what deferred tax is computed on.
        </p>
      </div>

      <IncomeTaxPanel
        blocks={register.data.blocks.map(readBlockRow)}
        defaultAnyDayInYear={todayInIndia()}
        runItAction={runIncomeTaxDepreciation}
        deferredAction={deferredTaxWorking}
        saveBlockAction={saveItBlock}
        canManage={manage.allowed}
      />

      <p className="text-sm text-muted-foreground">
        <Link href="/fixed-assets/depreciation" className="underline">
          The Companies Act charge
        </Link>{" "}
        is the one that reaches the ledger.
      </p>
    </main>
  );
}
