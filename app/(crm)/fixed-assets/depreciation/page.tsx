/**
 * Ordence — ⭐⭐⭐ THE DEPRECIATION RUN
 * Batch 100 · v1.65.0-alpha
 *
 * 🔴 COMPUTING AND POSTING ARE TWO ACTIONS, TWO PERMISSIONS AND TWO
 * BUTTONS. See `components/fixed-assets/depreciation-runner.tsx` for why
 * collapsing them would be faster and wrong.
 */

import Link from "next/link";
import {
  depreciationRunDetail,
  postDepreciation,
  runDepreciation,
} from "@/server/actions/fixed-assets";
import { checkPermission } from "@/server/audit";
import { DepreciationRunner } from "@/components/fixed-assets/depreciation-runner";
import { previousDay, todayInIndia } from "@/lib/accounting/periods";
import { addMonths } from "@/lib/fixed-assets/depreciation";

export const dynamic = "force-dynamic";

export const metadata = { title: "Depreciation · Ordence" };

export default async function DepreciationPage() {
  const [manage, post] = await Promise.all([
    checkPermission("fixed_assets.manage"),
    checkPermission("fixed_assets.post"),
  ]);

  /**
   * ⚠️ THE MONTH, NOT THE YEAR. A period must lie inside one financial
   * year and a calendar month always does — including March, which ends
   * on the 31st and never spills over 1 April.
   */
  const today = todayInIndia();
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = previousDay(addMonths(monthStart, 1));

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <Link href="/fixed-assets" className="text-xs underline">
          Fixed assets
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Depreciation</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The Companies Act charge, per asset, pro-rated by days from the date each asset
          was put to use. It is computed first and posted afterwards, deliberately: the
          first month a company runs this is the month it discovers an asset carrying the
          wrong useful life, and that discovery is only cheap before the charge is in the
          statutory books.
        </p>
      </div>

      <DepreciationRunner
        defaultPeriodStart={monthStart}
        defaultPeriodEnd={monthEnd}
        runAction={runDepreciation}
        postAction={postDepreciation}
        detailAction={depreciationRunDetail}
        canManage={manage.allowed}
        canPost={post.allowed}
      />

      <p className="text-sm text-muted-foreground">
        {/* ⭐ The section 32 allowance is a different number and has its own screen. */}
        The income-tax allowance on the same assets is a different computation and is
        never posted —{" "}
        <Link href="/fixed-assets/income-tax" className="underline">
          see it beside the books
        </Link>
        .
      </p>
    </main>
  );
}
