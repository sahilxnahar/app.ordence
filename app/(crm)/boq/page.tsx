/**
 * Ordence — ⭐ BILLS OF QUANTITIES
 * Version: v0.69.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PAGE LEADS WITH, AND WHY IT IS NOT THE LIST
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design is a table of BOQs. It is also useless after the
 * first week: a quantity surveyor knows which BOQs exist, and opens this
 * screen to answer a different question — is anything wrong.
 *
 * So two warnings come first, and both of them are money:
 *
 *   1. ⚠️ BOQs WITH NO CONTRACT BEHIND THEM. A BOQ whose `contract_id` is
 *      null is invisible to every per-contract check in the product,
 *      including SQL 0041's over-billing guard. It is not a tidiness
 *      problem — it is a contract whose bills are UNCHECKED, and nothing
 *      else in the system will say so.
 *
 *   2. ⚠️ LINES CLAIMED BEYOND WHAT WAS MEASURED. Billed quantity ahead
 *      of measured quantity means somebody has been paid for work nobody
 *      recorded. This is the first thing to look at, every time.
 *
 * Then the list.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ MONEY ARRIVES AS A STRING AND IS FORMATTED AS ONE
 * ══════════════════════════════════════════════════════════════════════
 * Every figure on this page is paise held in a decimal string. It is
 * never converted to a number: `JSON.stringify` throws on a bigint, and
 * a contract sum that has been through a float is wrong in its last
 * digits with nothing to indicate it.
 */

import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, FileText } from "lucide-react";
import { listBoqs, getBoqFormOptions } from "@/server/actions/construction";
import { NewBoqForm } from "@/components/construction/boq-actions";
import { getBillingPosition } from "@/server/actions/cost-control";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Bills of Quantities · Ordence" };

/* ------------------------------------------------------------------ */
/* FORMATTING — decimal strings in, strings out                        */
/* ------------------------------------------------------------------ */

/**
 * Paise (as a decimal string) → Indian-grouped rupees.
 *
 * ⚠️ STRING SLICING, NOT `Number(...) / 100`. A contract sum in paise
 * passes 2^53 at about ₹90,000 crore, and portfolio totals get there.
 * The failure is silent and lands in the last digits — the ones somebody
 * reconciles against a contractor's own statement.
 */
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

/** Status → the words a reader needs, not just a colour. */
function statusTone(status: string): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  switch (status) {
    case "draft":
      return { label: "Draft — still editable", variant: "secondary" };
    case "issued":
      return { label: "Issued — lines frozen", variant: "default" };
    case "superseded":
      return { label: "Superseded", variant: "outline" };
    case "closed":
      return { label: "Closed", variant: "outline" };
    default:
      return { label: status, variant: "outline" };
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
/* 1 · WHAT IS WRONG                                                   */
/* ------------------------------------------------------------------ */

async function WarningsPanel() {
  const result = await getBillingPosition();

  if (!result.ok) {
    // A permission refusal reads as an explanation, not a red error card:
    // `construction.costs.read` is not held by every role, and a site
    // engineer opening this page has done nothing wrong.
    return (
      <section className="rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">{result.error}</p>
      </section>
    );
  }

  const { overClaimed, unlinkedBoqs, totalUnclaimedMinor, unclaimed } = result.data;
  const nothingWrong = overClaimed.length === 0 && unlinkedBoqs === 0;

  return (
    <section className="space-y-3" aria-labelledby="boq-warnings">
      <h2 id="boq-warnings" className="text-sm font-semibold">
        What needs looking at
      </h2>

      {nothingWrong && (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Nothing is over-claimed, and every BOQ is attached to a contract.
        </p>
      )}

      {/*
        ⚠️ THE UNLINKED COUNT IS SHOWN EVEN WHEN IT IS THE ONLY FINDING.
        A BOQ with no contract is excluded from the over-claim check
        entirely, so "0 over-claimed lines" on a workspace with unlinked
        BOQs means "0 found in the part I could see" — and that is a very
        different sentence.
      */}
      {unlinkedBoqs > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {unlinkedBoqs} {unlinkedBoqs === 1 ? "BOQ is" : "BOQs are"} not attached to a
            works contract
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Bills raised against {unlinkedBoqs === 1 ? "it" : "them"} are not checked against
            the authorised quantity, because there is no contract to check them through.
            Attach the contract on the BOQ to switch that check on.
          </p>
        </div>
      )}

      {overClaimed.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {overClaimed.length} {overClaimed.length === 1 ? "line has" : "lines have"} been
            billed beyond what was measured
          </p>
          <ul className="mt-3 space-y-2">
            {overClaimed.slice(0, 8).map((line) => (
              <li key={line.boqItemId} className="text-sm">
                <span className="font-medium">{line.itemCode ?? "—"}</span>{" "}
                <span className="text-muted-foreground">{line.description}</span>
                <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                  measured {line.measuredQty} {line.uom} · billed {line.billedQty} {line.uom}
                  {line.contractNo ? ` · ${line.contractNo}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Not a warning — an opportunity, and the one a subcontractor rings
        up about. Work measured, checked, and never claimed is the most
        common reason a contractor stops turning up.
      */}
      {unclaimed.length > 0 && (
        <div className="rounded-md border border-border p-4">
          <p className="text-sm font-semibold">
            {inr(totalUnclaimedMinor)} of measured work has not been billed
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Across {unclaimed.length} {unclaimed.length === 1 ? "line" : "lines"}. It is a
            liability that appears in no bill register until somebody raises the bill.
          </p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 2 · THE LIST                                                        */
/* ------------------------------------------------------------------ */

async function BoqList() {
  const result = await listBoqs();

  if (!result.ok) {
    return <PanelError title="Could not load the BOQs" message={result.error} />;
  }

  if (result.data.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No bills of quantities yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">Bills of quantities</caption>
        <thead className="border-b border-border bg-muted/40 text-left">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Code</th>
            <th scope="col" className="px-3 py-2 font-medium">Work package</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Items</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Original</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Revised</th>
          </tr>
        </thead>
        <tbody>
          {result.data.map((boq) => {
            const tone = statusTone(boq.status);
            return (
              <tr key={boq.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <Link href={`/boq/${boq.id}`} className="font-medium hover:underline">
                    {boq.code}
                  </Link>
                  <div className="text-xs text-muted-foreground">{boq.title}</div>
                </td>
                <td className="px-3 py-2">{boq.workPackage}</td>
                <td className="px-3 py-2">
                  <Badge variant={tone.variant}>{tone.label}</Badge>
                  {/*
                    ⚠️ Stated in words on the row, not only in the warning
                    panel above. Somebody scanning the list has to be able
                    to see that this BOQ's bills go unchecked without
                    scrolling back up and cross-referencing a count.
                  */}
                  {!boq.contractId && (
                    <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      no contract — bills unchecked
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{boq.itemCount}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(boq.originalSumMinor)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(boq.revisedSumMinor)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3 · THE FORM                                                        */
/* ------------------------------------------------------------------ */

async function NewBoqPanel() {
  const result = await getBoqFormOptions();

  /*
   * ⚠️ NO FORM RATHER THAN AN EMPTY FORM. A caller without
   * `construction.boq.read` cannot populate the dropdowns, and a form
   * with three empty selects reads as "there are no projects" — which
   * sends somebody off to create one they already have.
   */
  if (!result.ok) return null;

  return (
    <NewBoqForm
      options={{
        projects: result.data.projects.map((p) => ({ id: p.id, label: `${p.code} — ${p.name}` })),
        contracts: result.data.contracts.map((c) => ({
          id: c.id,
          label: `${c.contractNo} — ${c.title}`,
        })),
        vendors: result.data.vendors.map((v) => ({ id: v.id, label: v.name })),
      }}
    />
  );
}

/* ------------------------------------------------------------------ */

function PanelSkeleton() {
  return <div className="h-24 animate-pulse rounded-md border border-border bg-muted/30" />;
}

export default function BoqPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <FileText className="h-5 w-5" aria-hidden="true" />
          Bills of quantities
        </h1>
        <p className="text-sm text-muted-foreground">
          What each contractor is authorised to build, what has been measured, and what has
          been claimed.
        </p>
      </header>

      {/*
        ⚠️ TWO SUSPENSE BOUNDARIES, NOT ONE. The warnings run an aggregate
        over every BOQ line in the workspace; the list is an indexed read.
        Sharing a boundary would hold the fast half hostage to the slow
        one — and the list is what somebody usually came for.
      */}
      <Suspense fallback={<PanelSkeleton />}>
        <WarningsPanel />
      </Suspense>

      {/*
        ⚠️ ITS OWN SUSPENSE BOUNDARY. The form needs three dropdown lists
        — projects, contracts, vendors — and none of them is needed to
        read the table. Sharing a boundary would hold the list behind
        data that only matters if somebody presses "New BOQ".
      */}
      <Suspense fallback={<PanelSkeleton />}>
        <NewBoqPanel />
      </Suspense>

      <section className="space-y-3" aria-labelledby="boq-list">
        <h2 id="boq-list" className="text-sm font-semibold">
          All bills of quantities
        </h2>
        <Suspense fallback={<PanelSkeleton />}>
          <BoqList />
        </Suspense>
      </section>
    </div>
  );
}
