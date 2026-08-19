/**
 * Ordence — ⭐ PURCHASE ORDERS
 * Version: v1.19.0-alpha
 *
 * 🔴 These tables have existed since 0063 and nothing wrote to them. See
 * `server/actions/purchase-orders.ts`.
 */

import {
  approvePurchaseOrder,
  getPurchaseOrders,
  raisePurchaseOrder,
} from "@/server/actions/purchase-orders";
import { OrderManager } from "@/components/purchases/order-manager";

export const dynamic = "force-dynamic";

export const metadata = { title: "Purchase orders · Ordence" };

export default async function PurchaseOrdersPage() {
  const result = await getPurchaseOrders();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Purchase orders</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Purchase orders</h1>
        <p className="text-sm text-muted-foreground">
          What was agreed, before anything arrives. The receipt records what
          actually turned up, and the bill is checked against both. A business
          pays the bill, and the three agreeing is the only defence against
          paying for something that was never ordered or never came.
        </p>
      </div>

      <OrderManager
        orders={result.data.orders}
        vendors={result.data.vendors}
        raiseAction={raisePurchaseOrder}
        approveAction={approvePurchaseOrder}
      />
    </main>
  );
}
