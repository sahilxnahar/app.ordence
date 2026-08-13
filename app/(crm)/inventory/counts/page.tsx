/**
 * Ordence — ⭐ STOCK COUNTS
 * Version: v1.18.0-alpha
 *
 * 🔴 `stock_counts` has existed since 0029 and no screen has ever
 * referenced it. See `server/actions/stock-counts.ts`.
 */

import { getCounts, openCount, postCount } from "@/server/actions/stock-counts";
import { CountManager } from "@/components/inventory/count-manager";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stock counts · Ordence" };

export default async function StockCountsPage() {
  const result = await getCounts();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Stock counts</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Stock counts</h1>
        <p className="text-sm text-muted-foreground">
          The only thing in the system that checks whether the stock figures are
          true. Counters are not shown what the system expects, deliberately: a
          sheet with the figure already on it is a confirmation exercise rather
          than a count.
        </p>
      </div>

      <CountManager
        counts={result.data.counts}
        warehouses={result.data.warehouses}
        openAction={openCount}
        postAction={postCount}
      />
    </main>
  );
}
