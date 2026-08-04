/**
 * Ordence — ⭐ RUNNING-ACCOUNT BILLS
 * Version: v0.69.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAGE OPENS WITH WORK WAITING TO BE BILLED, NOT WITH BILLS
 * ══════════════════════════════════════════════════════════════════════
 * A bill register is a record of decisions already taken. Useful, and not
 * what somebody opens this screen to do.
 *
 * What they came for is the question a subcontractor is currently ringing
 * them about: work that has been measured, checked by somebody
 * independent, and never claimed. That money sits in nobody's ledger — it
 * is not on a bill, so it is not a payable; it is not a provision,
 * because nobody made one — and it is the most common reason a
 * subcontractor stops turning up to site.
 *
 * So `getBillableWork()` leads, and the register follows.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS PAGE DELIBERATELY DOES NOT OFFER
 * ══════════════════════════════════════════════════════════════════════
 * There is no "new bill" form with a quantity box and a rate box.
 *
 * That form is the design under every construction fraud the control
 * structure in `server/actions/ra-bills.ts` exists to prevent, because a
 * typed quantity has no relationship to anything that was measured,
 * checked, or built. A bill here is assembled from measurements or it is
 * not raised at all — so the only action on this screen is "raise a bill
 * for the work that is ready", and the work decides the figures.
 */

import { Suspense } from "react";
import { IndianRupee, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { listRaBills, getBillableWork } from "@/server/actions/ra-bills";
import { RaiseBillForm } from "@/components/contracting/ra-bill-actions";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "RA Bills · Ordence" };

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

/**
 * Where a bill has got to, in words.
 *
 * ⚠️ THE WORDS MATTER MORE THAN THE COLOUR HERE. "Certified" and
 * "approved" are one step apart and mean completely different things —
 * one is an engineer's opinion about the work, the other is an
 * instruction to pay. A reader who can only tell them apart by shade will
 * eventually get it wrong.
 */
function statusTone(status: string): {
  label: string;
  hint: string;
  variant: "default" | "secondary" | "outline" | "destructive";
} {
  switch (status) {
    case "draft":
      return { label: "Draft", hint: "Not submitted", variant: "secondary" };
    case "submitted":
      return { label: "Submitted", hint: "Awaiting the engineer", variant: "secondary" };
    case "certified":
      return {
        label: "Certified",
        hint: "Engineer agrees the value — not yet approved for payment",
        variant: "default",
      };
    case "approved":
      return {
        label: "Approved",
        hint: "Cleared for payment — EPF/ESI evidence still required to pay",
        variant: "default",
      };
    case "paid":
      return { label: "Paid", hint: "Money has moved", variant: "outline" };
    case "rejected":
      return { label: "Rejected", hint: "Sent back", variant: "destructive" };
    case "cancelled":
      return { label: "Cancelled", hint: "Withdrawn", variant: "outline" };
    default:
      return { label: status, hint: "", variant: "outline" };
  }
}

function PanelError({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-semibold text-destructive">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1 · READY TO BILL                                                   */
/* ------------------------------------------------------------------ */

async function BillableWorkPanel() {
  const result = await getBillableWork();

  if (!result.ok) {
    return (
      <section className="rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">{result.error}</p>
      </section>
    );
  }

  if (result.data.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No checked, unbilled work. Either nothing has been measured since the last bill, or
        measurements are still waiting to be checked by somebody other than the person who
        took them.
      </p>
    );
  }

  const total = result.data.reduce((sum, row) => sum + BigInt(row.valueMinor || "0"), 0n);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          {inr(total.toString())} of checked work has not been claimed
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          It is in no bill register and in no ledger. Whichever month somebody finally
          raises these bills, it all lands at once.
        </p>
      </div>

      {/*
        ⚠️ THE FORM SITS WITH THE WORK IT DRAWS FROM, not in a header
        button. Raising a bill is not a standalone act — it is "sweep up
        what has been checked on this contract", and the list above is
        the thing being swept.
      */}
      <RaiseBillForm contracts={result.data} />

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">Checked, unbilled work by contract</caption>
          <thead className="border-b border-border bg-muted/40 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Contract</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Measurements</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {result.data.map((row) => (
              <tr key={row.contractId} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <span className="font-medium">{row.contractNo}</span>
                  <div className="text-xs text-muted-foreground">{row.title}</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{row.entries}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(row.valueMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2 · THE REGISTER                                                    */
/* ------------------------------------------------------------------ */

async function BillRegister() {
  const result = await listRaBills();

  if (!result.ok) {
    return <PanelError title="Could not load the bills" message={result.error} />;
  }

  if (result.data.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No running-account bills yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">Running-account bills</caption>
        <thead className="border-b border-border bg-muted/40 text-left">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Bill</th>
            <th scope="col" className="px-3 py-2 font-medium">Period</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Gross</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Retention</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">TDS</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Net payable</th>
          </tr>
        </thead>
        <tbody>
          {result.data.map((bill) => {
            const tone = statusTone(bill.status);
            return (
              <tr key={bill.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <Link href={`/ra-bills/${bill.id}`} className="font-medium hover:underline">
                    {bill.billNo}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    RA-{bill.sequence} · {bill.lines}{" "}
                    {bill.lines === 1 ? "line" : "lines"}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {bill.periodFrom && bill.periodTo
                    ? `${bill.periodFrom} → ${bill.periodTo}`
                    : "—"}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={tone.variant}>{tone.label}</Badge>
                  {tone.hint && (
                    <div className="mt-1 text-xs text-muted-foreground">{tone.hint}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(bill.grossValueMinor)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {inr(bill.retentionMinor)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {inr(bill.tdsMinor)}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {inr(bill.netPayableMinor)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PanelSkeleton() {
  return <div className="h-24 animate-pulse rounded-md border border-border bg-muted/30" />;
}

export default function RaBillsPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <IndianRupee className="h-5 w-5" aria-hidden="true" />
          Running-account bills
        </h1>
        <p className="text-sm text-muted-foreground">
          What each subcontractor has claimed, what has been certified, and what is owed.
        </p>
      </header>

      <section className="space-y-3" aria-labelledby="ready-to-bill">
        <h2 id="ready-to-bill" className="text-sm font-semibold">
          Ready to bill
        </h2>
        <Suspense fallback={<PanelSkeleton />}>
          <BillableWorkPanel />
        </Suspense>
      </section>

      <section className="space-y-3" aria-labelledby="bill-register">
        <h2 id="bill-register" className="text-sm font-semibold">
          Bill register
        </h2>
        <Suspense fallback={<PanelSkeleton />}>
          <BillRegister />
        </Suspense>
      </section>
    </div>
  );
}
