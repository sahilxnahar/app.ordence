/**
 * Ordence — ⭐ ONE RUNNING-ACCOUNT BILL
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE DEDUCTION STACK IS SHOWN IN FULL, LINE BY LINE
 * ══════════════════════════════════════════════════════════════════════
 * A bill that shows only "net payable ₹9,20,000" is a number a
 * subcontractor cannot check and will therefore dispute. Every deduction
 * between the gross and the net is listed with its rate, because that is
 * the arithmetic they will redo on their side, and the two have to agree
 * line for line or the conversation is about the software instead of the
 * work.
 *
 * ⚠️ NONE OF THESE FIGURES IS COMPUTED HERE. Cess, retention, TDS and
 * `net_payable` are all derived by a database trigger from the gross
 * value. Recomputing them for display would introduce a second
 * implementation of the same arithmetic, and the copy that drifts is
 * always the one nobody is looking at — which would be this one.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { getRaBillDetail } from "@/server/actions/ra-bills";
import { BillTransitionControls } from "@/components/contracting/ra-bill-actions";
import { requirePageContext } from "@/server/tenant-context";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "RA Bill · Ordence" };

/** Paise as a decimal string → Indian-grouped rupees. Never via a float. */
function inr(minor: string | null | undefined): string {
  if (!minor) return "₹0.00";
  const raw = String(minor);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

const bps = (value: number | null): string =>
  value == null ? "—" : `${(value / 100).toFixed(2)}%`;

function statusTone(status: string): {
  label: string;
  hint: string;
  variant: "default" | "secondary" | "outline" | "destructive";
} {
  switch (status) {
    case "draft": return { label: "Draft", hint: "Not yet certified", variant: "secondary" };
    case "submitted": return { label: "Submitted", hint: "Awaiting the engineer", variant: "secondary" };
    case "certified": return { label: "Certified", hint: "Value agreed — not yet approved for payment", variant: "default" };
    case "approved": return { label: "Approved", hint: "Cleared for payment, subject to EPF/ESI evidence", variant: "default" };
    case "paid": return { label: "Paid", hint: "Money has moved", variant: "outline" };
    case "rejected": return { label: "Rejected", hint: "Sent back", variant: "destructive" };
    case "cancelled": return { label: "Cancelled", hint: "Withdrawn", variant: "outline" };
    default: return { label: status, hint: "", variant: "outline" };
  }
}

export default async function RaBillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // The viewer's identity decides which transitions they may take: the
  // raiser may not certify, the certifier may not approve.
  const ctx = await requirePageContext();
  const result = await getRaBillDetail(id);

  if (!result.ok) {
    if (/does not exist/i.test(result.error)) notFound();
    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{result.error}</p>
        </div>
      </div>
    );
  }

  const bill = result.data;
  const tone = statusTone(bill.status);

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link
          href="/ra-bills"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          All bills
        </Link>
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-xl font-bold">{bill.billNo}</h1>
          <Badge variant={tone.variant}>{tone.label}</Badge>
          <span className="text-sm text-muted-foreground">{tone.hint}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          RA-{bill.sequence}
          {bill.contractNo ? ` · ${bill.contractNo}` : ""}
          {bill.vendorName ? ` · ${bill.vendorName}` : ""}
          {bill.projectName ? ` · ${bill.projectName}` : ""}
          {bill.periodFrom && bill.periodTo ? ` · ${bill.periodFrom} → ${bill.periodTo}` : ""}
        </p>
      </header>

      {/*
        ⚠️ WHO DID WHAT, AT THE TOP, WITH NAMES.
        Three decisions by three people is the whole control. Two names
        that are the same is what a reviewer needs to be able to SEE — and
        a screen that shows only "certified ✓" hides exactly that.
      */}
      <section className="rounded-md border border-border p-4" aria-labelledby="bill-trail">
        <h2 id="bill-trail" className="text-sm font-semibold">Who signed what</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          {[
            ["Raised by", bill.createdByName],
            ["Certified by", bill.certifiedByName],
            ["Approved by", bill.approvedByName],
          ].map(([label, name]) => (
            <div key={label}>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 text-sm">{name || "—"}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ---- THE MONEY --------------------------------------------- */}

      <section className="space-y-3" aria-labelledby="bill-money">
        <h2 id="bill-money" className="text-sm font-semibold">The arithmetic</h2>

        {/*
          ══════════════════════════════════════════════════════════════
          ⚠️ `previousPaidMinor` IS NOT IN THIS COLUMN, AND THAT IS A FIX.
          ══════════════════════════════════════════════════════════════
          It was, on the first version of this page — listed as
          "Less: previously paid on this contract", which reads correctly
          and is wrong.

          SQL 0031 computes:

              net = gross − cess − retention − TDS − other deductions

          `previous_paid_minor` is NOT subtracted. `gross_value_minor` is
          the value of THIS bill's work, not the cumulative position, so
          deducting what was already paid would take the same money off
          twice.

          Caught by seeding real data and reading the figures: on RA-02
          the displayed column would have shown deductions summing to
          more than the stated net payable. A total that does not foot,
          on the page a subcontractor checks their payment against, is
          the worst possible place for it — they will not conclude the
          screen is wrong, they will conclude they are being short-paid.

          The cumulative position is genuinely useful, so it is shown
          BELOW the total as context rather than inside the sum.
        */}
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">How the net payable is arrived at</caption>
            <tbody>
              {[
                ["Gross value of work in this bill", bill.grossValueMinor, null, false],
                ["Less: BOCW cess", `-${bill.cessMinor}`, bps(bill.cessRateBps), true],
                ["Less: retention", `-${bill.retentionMinor}`, bps(bill.retentionRateBps), true],
                [
                  `Less: TDS${bill.tdsSection ? ` (${bill.tdsSection})` : ""}`,
                  `-${bill.tdsMinor}`,
                  bps(bill.tdsRateBps),
                  true,
                ],
              ].map(([label, value, rate, muted]) => (
                <tr key={String(label)} className="border-b border-border">
                  <td className="px-3 py-2">{label}</td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">{rate ?? ""}</td>
                  <td
                    className={
                      muted
                        ? "px-3 py-2 text-right tabular-nums text-muted-foreground"
                        : "px-3 py-2 text-right tabular-nums"
                    }
                  >
                    {inr(String(value))}
                  </td>
                </tr>
              ))}
              <tr className="bg-muted/40">
                <td className="px-3 py-2 font-semibold">Net payable on this bill</td>
                <td />
                <td className="px-3 py-2 text-right text-base font-bold tabular-nums">
                  {inr(bill.netPayableMinor)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="text-sm">
            <span className="text-muted-foreground">Already paid on this contract: </span>
            <span className="font-medium tabular-nums">{inr(bill.previousPaidMinor)}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Context, not a deduction. The figure above is the value of this bill&apos;s work
            alone — subtracting earlier payments from it would take the same money off twice.
            This is what has already gone out on bills marked paid.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          Every deduction above is computed by the database from the gross value and the
          contract&apos;s rates. None of it is typed, and none of it can be overridden from
          this screen.
        </p>
      </section>

      {/* ---- LINES -------------------------------------------------- */}

      <section className="space-y-3" aria-labelledby="bill-lines">
        <h2 id="bill-lines" className="text-sm font-semibold">Lines</h2>

        {/*
          ⚠️ THE UNCHECKED COUNT IS SURFACED BEFORE THE TABLE. Day-work and
          provisional sums legitimately have no BOQ line behind them — and
          that means SQL 0041's over-billing guard skipped them. Somebody
          approving a payment should know which lines nothing verified.
        */}
        {bill.uncheckedLines > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              {bill.uncheckedLines} {bill.uncheckedLines === 1 ? "line has" : "lines have"} no
              BOQ item behind {bill.uncheckedLines === 1 ? "it" : "them"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Day-work and provisional sums are legitimate, and they are not checked against
              any authorised quantity. Read those lines yourself.
            </p>
          </div>
        )}

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Lines on this bill</caption>
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">#</th>
                <th scope="col" className="px-3 py-2 font-medium">Item</th>
                <th scope="col" className="px-3 py-2 font-medium">Description</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Quantity</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Rate</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((line) => (
                <tr key={line.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 tabular-nums">{line.lineNo}</td>
                  <td className="px-3 py-2">
                    {line.boqCode ?? "—"}
                    {!line.boqItemId && (
                      <div className="text-xs text-amber-700 dark:text-amber-400">unchecked</div>
                    )}
                  </td>
                  <td className="px-3 py-2">{line.description}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line.quantity} {line.unit}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(line.rateMinor)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(line.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- WHAT HAPPENS NEXT -------------------------------------- */}

      <section className="space-y-3" aria-labelledby="bill-next">
        <h2 id="bill-next" className="text-sm font-semibold">What happens next</h2>
        <BillTransitionControls
          raBillId={bill.id}
          status={bill.status}
          viewerRaisedIt={bill.createdBy === ctx.user.id}
          viewerCertifiedIt={bill.certifiedBy === ctx.user.id}
        />
      </section>
    </div>
  );
}
