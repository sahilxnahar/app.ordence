/**
 * Ordence — ⭐⭐ NEW ORDER
 * Version: v1.42.0-alpha (Mega-wave 1, Batch 34, second half)
 * Runtime: Node
 *
 * 🔴 Until this page existed, `createOrder` had no caller and the product
 * could not take an order. The list, the detail page, fulfilment,
 * invoicing and every sales report read a table nothing could write to.
 */

import Link from "next/link";
import { createOrder } from "@/server/actions/orders";
import { getRegistrations, getParties } from "@/server/actions/gst";
import { listProjectOptions } from "@/server/actions/orders-form";
import { NewOrderForm } from "@/components/orders/new-order-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "New order · Ordence" };

type PartyRow = {
  id: string;
  legalName: string;
  gstin: string | null;
  stateCode: string | null;
  registrationType: string;
  isActive: boolean;
};

export default async function NewOrderPage() {
  const [regs, parties, projects] = await Promise.all([
    getRegistrations(),
    getParties("customer"),
    listProjectOptions(),
  ]);

  /**
   * ⚠️ A MISSING REGISTRATION IS EXPLAINED, NOT RENDERED AS AN EMPTY
   * DROPDOWN. `createOrder` refuses without one, because it cannot
   * determine a place of supply from nothing. An empty select with no
   * explanation sends somebody to a support channel.
   */
  const registrationOptions = regs.ok
    ? regs.data.rows
        .filter((r) => r.isActive)
        .map((r) => ({
          id: r.id,
          label: r.tradeName ?? r.legalName,
          hint: r.gstin,
        }))
    : [];

  const partyOptions = parties.ok
    ? (parties.data.rows as PartyRow[])
        .filter((p) => p.isActive)
        .map((p) => ({
          id: p.id,
          label: p.legalName,
          hint: p.gstin ?? `${p.registrationType}${p.stateCode ? ` · ${p.stateCode}` : ""}`,
        }))
    : [];

  const projectOptions = projects.ok ? projects.data.rows : [];

  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link href="/orders" className="text-sm text-muted-foreground hover:underline">
          ← All orders
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New order</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This creates a draft. Nothing is committed to the customer and no
          stock is reserved until you confirm it.
        </p>
      </div>

      {registrationOptions.length === 0 ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          This workspace has no active GST registration, so we cannot work out
          which tax applies to an order.{" "}
          <Link href="/gst" className="underline">
            Add your GSTIN
          </Link>{" "}
          first.
        </p>
      ) : partyOptions.length === 0 ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          There are no customers on file yet. A buyer&apos;s registration is what
          decides the tax split, so an order needs one.{" "}
          <Link href="/gst" className="underline">
            Add a customer
          </Link>
          .
        </p>
      ) : (
        <NewOrderForm
          action={createOrder}
          registrations={registrationOptions}
          parties={partyOptions}
          projects={projectOptions}
          today={today}
        />
      )}
    </main>
  );
}
