/**
 * Ordence — Variation register
 * Version: v0.73.0-alpha
 *
 * ⭐ THE REGISTER IS THE POINT.
 *
 * A variation order changes the contract sum and the measurement ceiling.
 * On a disputed contract the first document anyone asks for is the
 * variation register: what was instructed, when, by whom, for how much,
 * and whether it was ever approved. A system that stores variations but
 * cannot show them in one list is not usable as evidence.
 *
 * ⚠️ WITHDRAWN AND REJECTED VARIATIONS STAY VISIBLE. A register that
 * hides what was refused is a register that answers the wrong question —
 * "what did we agree" instead of "what was asked, and what happened to
 * it". Both are shown, with the refusal reason attached.
 */

import { Suspense } from "react";
import Link from "next/link";
import { FileDiff } from "lucide-react";
import { listVariations, getVariationFormOptions } from "@/server/actions/variations";
import { RaiseVariationForm } from "@/components/construction/variation-actions";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Variations · Ordence" };

/**
 * Indian digit grouping on a signed decimal string.
 * `"-1234567.50"` → `"-₹12,34,567.50"`.
 */
function inr(decimal: string | null | undefined): string {
  if (!decimal) return "₹0.00";
  const raw = String(decimal);
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [wholeRaw = "0", fracRaw = "00"] = body.split(".");
  const frac = (fracRaw + "00").slice(0, 2);
  const lastThree = wholeRaw.slice(-3);
  const rest = wholeRaw.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "addition":
      return "Addition";
    case "omission":
      return "Omission";
    case "rate_change":
      return "Rate change";
    case "substitution":
      return "Substitution";
    case "extra_item":
      return "Extra item";
    default:
      return kind;
  }
}

function statusTone(status: string): {
  label: string;
  hint: string;
  variant: "default" | "secondary" | "outline" | "destructive";
} {
  switch (status) {
    case "draft":
      return { label: "Draft", hint: "Not submitted", variant: "secondary" };
    case "submitted":
      return {
        label: "Submitted",
        hint: "Awaiting a second person — the raiser cannot approve it",
        variant: "secondary",
      };
    case "approved":
      return {
        label: "Approved",
        hint: "Final. The measurement ceiling has moved",
        variant: "default",
      };
    case "rejected":
      return { label: "Rejected", hint: "Sent back with a reason", variant: "destructive" };
    case "withdrawn":
      return { label: "Withdrawn", hint: "Closed, cannot reopen", variant: "outline" };
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

function PanelSkeleton() {
  return <div className="h-24 animate-pulse rounded-md border border-border bg-muted/30" />;
}

/* ------------------------------------------------------------------ */

async function RaisePanel() {
  const options = await getVariationFormOptions();

  if (!options.ok) {
    return <PanelError title="Could not load the bills of quantities" message={options.error} />;
  }

  return <RaiseVariationForm boqs={options.data.boqs} />;
}

async function VariationRegister() {
  const result = await listVariations();

  if (!result.ok) {
    return <PanelError title="Could not load the variation register" message={result.error} />;
  }

  if (result.data.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No variations yet. Every change to agreed scope belongs here — including the ones
        that were later refused.
      </p>
    );
  }

  /**
   * ⚠️ ONLY APPROVED VARIATIONS COUNT TOWARDS THE CONTRACT SUM.
   *
   * A total that included drafts and submissions would tell a project
   * manager the contract is worth more than anybody has agreed to pay.
   */
  let approvedNet = 0;
  let pendingCount = 0;
  for (const v of result.data) {
    if (v.status === "approved") approvedNet += Number(v.effect);
    if (v.status === "draft" || v.status === "submitted") pendingCount += 1;
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Approved effect on contract sum</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {inr(approvedNet.toFixed(2))}
          </p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Awaiting a decision</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{pendingCount}</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Variations on record</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{result.data.length}</p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">Variation register</caption>
          <thead className="border-b border-border bg-muted/40 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Variation</th>
              <th scope="col" className="px-3 py-2 font-medium">BOQ</th>
              <th scope="col" className="px-3 py-2 font-medium">Kind</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Instructed</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Effect on contract sum
              </th>
            </tr>
          </thead>
          <tbody>
            {result.data.map((v) => {
              const tone = statusTone(v.status);
              const negative = v.effect.startsWith("-");
              return (
                <tr key={v.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <Link
                      href={`/variations/${v.id}`}
                      className="font-medium hover:underline"
                    >
                      {v.variationNumber}
                    </Link>
                    <div className="text-xs text-muted-foreground">{v.title}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <Link href={`/boq/${v.boqId}`} className="hover:underline">
                      {v.boqCode}
                    </Link>
                    <div className="text-muted-foreground">{v.boqTitle}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">{kindLabel(v.kind)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={tone.variant}>{tone.label}</Badge>
                    {tone.hint && (
                      <div className="mt-1 text-xs text-muted-foreground">{tone.hint}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {v.instructedOn ?? "—"}
                    {v.instructionRef && <div>{v.instructionRef}</div>}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-medium tabular-nums ${
                      negative ? "text-destructive" : ""
                    }`}
                  >
                    {inr(v.effect)}
                    {v.status !== "approved" && (
                      <div className="text-xs font-normal text-muted-foreground">
                        not yet counted
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function VariationsPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <FileDiff className="h-5 w-5" aria-hidden="true" />
          Variation orders
        </h1>
        <p className="text-sm text-muted-foreground">
          Every change to agreed scope — what was instructed, for how much, and what
          happened to it.
        </p>
      </header>

      <section className="space-y-3" aria-labelledby="raise-variation">
        <h2 id="raise-variation" className="text-sm font-semibold">
          Raise a variation
        </h2>
        <Suspense fallback={<PanelSkeleton />}>
          <RaisePanel />
        </Suspense>
      </section>

      <section className="space-y-3" aria-labelledby="variation-register">
        <h2 id="variation-register" className="text-sm font-semibold">
          Register
        </h2>
        <Suspense fallback={<PanelSkeleton />}>
          <VariationRegister />
        </Suspense>
      </section>
    </div>
  );
}
