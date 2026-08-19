/**
 * Ordence — ⭐⭐⭐ ONE VENDOR: WHAT IS OWED, WHEN, AND WHAT IT COSTS TO
 *              BE LATE
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ELEVEN PURCHASES ACTIONS WITH NO CALLER, AND THE MSME ONE MATTERS
 *    MOST
 * ══════════════════════════════════════════════════════════════════════
 * The purchases screen could create a vendor, record an invoice and read
 * the ITC register. It could not show what any vendor was owed. These
 * were built and reachable from nowhere:
 *
 *   getVendorBalances     what every vendor is owed, in one list
 *   getVendorStatement    the running account for one of them
 *   getVendorAgeing       how old it is, in buckets
 *   getMsmeExposure       🔴 whether Section 43B(h) has bitten
 *   addVendorLedgerEntry  a payment, a retention, a TDS deduction
 *   setVendorActive       stop using this vendor, with a reason
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY `getMsmeExposure` IS THE ONE THAT JUSTIFIES THIS PAGE
 * ══════════════════════════════════════════════════════════════════════
 * Section 43B(h) of the Income-tax Act, in force from AY 2024-25:
 * a payment to a registered micro or small enterprise that is made LATE
 * is not deductible in the year it was incurred. It is deductible in the
 * year it is actually paid.
 *
 * That is not a penalty and not interest. It is a whole year's expense
 * moving into the next year's books, discovered by the CA at assessment,
 * long after anybody could have paid the invoice on time.
 *
 * The engine that computes it was written. Nothing asked it anything.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building, TriangleAlert } from "lucide-react";

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  addVendorLedgerEntry,
  getVendors,
  getVendorAgeing,
  getVendorStatement,
  setVendorActive,
} from "@/server/actions/purchases";
import { Badge } from "@/components/ui/badge";
import { VendorLedgerControls } from "./vendor-ledger-controls";

export const dynamic = "force-dynamic";

function inr(minor: string | null | undefined): string {
  if (!minor) return "₹0.00";
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

/** Today in IST, as a civil day. The ageing "as at" is a date, not a moment. */
function todayIst(): string {
  const now = new Date(Date.now() + (5 * 60 + 30) * 60_000);
  return now.toISOString().slice(0, 10);
}

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext();
  const asOf = todayIst();

  const [vendorsResult, statementResult, ageingResult] = await Promise.all([
    getVendors(true),
    getVendorStatement(id),
    getVendorAgeing({ vendorId: id, asOf }),
  ]);

  if (!vendorsResult.ok) notFound();
  const vendor = vendorsResult.data.rows.find((row) => row.id === id);
  if (!vendor) notFound();

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const canManage = can(subject, "purchases:manage_vendors");
  const canRecord = can(subject, "purchases:record_invoice");

  const statement = statementResult.ok ? statementResult.data : null;
  const ageing = ageingResult.ok ? ageingResult.data : null;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="space-y-3">
        <Link
          href="/purchases"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to purchases
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Building className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              {vendor.legalName}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {vendor.code}
              {vendor.tradeName ? ` · trading as ${vendor.tradeName}` : ""}
              {vendor.panNumber ? ` · PAN ${vendor.panNumber}` : " · no PAN on file"}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {vendor.msmeRegistered && (
              <Badge variant="secondary">
                MSME{vendor.msmeCategory ? ` · ${vendor.msmeCategory}` : ""}
              </Badge>
            )}
            <Badge variant={vendor.isActive ? "outline" : "destructive"}>
              {vendor.isActive ? "Active" : "Blocked"}
            </Badge>
          </div>
        </div>
      </div>

      {/*
        🔴 SECTION 206AA. A missing PAN is a 20% deduction rather than the
        normal rate, and it is discovered after the payment has gone out ,
        at which point it is being recovered from a subcontractor who has
        left the site.
      */}
      {vendor.tdsApplicable && !vendor.panNumber && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <span>
            TDS applies to this vendor and no PAN is on file. Section 206AA requires deduction
            at 20%, or twice the normal rate, whichever is higher. Get the PAN before the next
            payment leaves.
          </span>
        </p>
      )}

      {/* ── WHAT IS OWED ──────────────────────────────────────────── */}
      <section aria-labelledby="owed-heading" className="space-y-3">
        <h2 id="owed-heading" className="text-lg font-semibold">
          What is owed, as at {asOf}
        </h2>

        {!ageing ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {ageingResult.ok ? "" : ageingResult.error}
          </p>
        ) : (
          <>
            <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Outstanding</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {inr(ageing.outstandingMinor)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Not yet due</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {inr(ageing.notYetDueMinor)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Excluded from ageing</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {inr(ageing.excludedMinor)}
                </dd>
                {/*
                  ⚠️ EXCLUDED IS NOT ZERO AND NOT HIDDEN. Retention held
                  against a subcontractor is a real liability that is
                  deliberately not chased; showing it as outstanding would
                  overstate what is late, and hiding it entirely would
                  lose money from the total.
                */}
              </div>
            </dl>

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Age</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {ageing.buckets.map((bucket) => (
                    <tr key={bucket.label} className="border-t">
                      <td className="px-3 py-2">{bucket.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {inr(bucket.amountMinor)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {bucket.entryCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* ── THE RUNNING ACCOUNT ───────────────────────────────────── */}
      <section aria-labelledby="statement-heading" className="space-y-3">
        <h2 id="statement-heading" className="text-lg font-semibold">
          Running account
        </h2>

        {!statement ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {statementResult.ok ? "" : statementResult.error}
          </p>
        ) : statement.rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Nothing recorded against this vendor yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2 font-medium">What</th>
                  <th scope="col" className="px-3 py-2 font-medium">Reference</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Debit</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Credit</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {statement.rows.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="px-3 py-2 text-xs">{row.entryDate}</td>
                    <td className="px-3 py-2">
                      {row.entryType.replace(/_/g, " ")}
                      {row.description && (
                        <span className="block text-xs text-muted-foreground">
                          {row.description}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{row.referenceNumber ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.debitMinor === "0" ? "" : inr(row.debitMinor)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.creditMinor === "0" ? "" : inr(row.creditMinor)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {inr(row.balanceMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30">
                  <td colSpan={5} className="px-3 py-2 text-right font-medium">
                    Closing balance
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {inr(statement.closingBalanceMinor)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <VendorLedgerControls
        vendorId={vendor.id}
        vendorName={vendor.legalName}
        isActive={vendor.isActive}
        msmeRegistered={vendor.msmeRegistered}
        paymentTermsDays={vendor.paymentTermsDays}
        asOf={asOf}
        canRecord={canRecord}
        canManage={canManage}
        addEntry={addVendorLedgerEntry}
        setActive={setVendorActive}
      />
    </main>
  );
}
