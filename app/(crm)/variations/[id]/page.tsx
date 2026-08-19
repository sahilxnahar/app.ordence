/**
 * Ordence — One variation order
 * Version: v0.73.0-alpha
 *
 * ⚠️ ADDITIONS AND OMISSIONS ARE SHOWN SEPARATELY, NOT JUST THE NET.
 *
 * A net effect of zero can mean "nothing changed" or "₹40 lakh of work
 * added and ₹40 lakh removed". Those are entirely different
 * conversations with a contractor, and a single net figure cannot tell
 * them apart. The same reasoning as `previous_paid` on an RA bill: a
 * number that does not foot on the screen someone checks it against is
 * a number that starts an argument.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { FileDiff, ArrowLeft } from "lucide-react";
import { getVariationDetail, getVariationFormOptions } from "@/server/actions/variations";
import {
  VariationLinesForm,
  VariationDecisions,
} from "@/components/construction/variation-actions";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Variation · Ordence" };

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

function statusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "approved") return "default";
  if (status === "rejected") return "destructive";
  if (status === "withdrawn") return "outline";
  return "secondary";
}

export default async function VariationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [detail, options] = await Promise.all([
    getVariationDetail(id),
    getVariationFormOptions(),
  ]);

  if (!detail.ok) {
    return (
      <div className="space-y-4 p-6">
        <Link
          href="/variations"
          className="inline-flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to the register
        </Link>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-semibold text-destructive">
            Could not load this variation
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{detail.error}</p>
        </div>
      </div>
    );
  }

  const v = detail.data;
  if (!v) notFound();

  /** Only the BOQ this variation belongs to may be referenced by its lines. */
  const items = options.ok
    ? options.data.items.filter((it) => it.boqId === v.boqId)
    : [];

  const editable = v.status === "draft";

  return (
    <div className="space-y-6 p-6">
      <Link
        href="/variations"
        className="inline-flex items-center gap-1 text-sm hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to the register
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <FileDiff className="h-5 w-5" aria-hidden="true" />
            {v.variationNumber}
          </h1>
          <Badge variant={statusVariant(v.status)}>{v.status}</Badge>
          <Badge variant="outline">{kindLabel(v.kind)}</Badge>
        </div>
        <p className="text-sm">{v.title}</p>
        <p className="text-sm text-muted-foreground">
          Against{" "}
          <Link href={`/boq/${v.boqId}`} className="hover:underline">
            {v.boqCode} — {v.boqTitle}
          </Link>
        </p>
      </header>

      {/* ---- the money, split three ways ---- */}
      <section className="grid gap-3 sm:grid-cols-3" aria-label="Effect on the contract sum">
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Additions</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{inr(v.additions)}</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Omissions</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-destructive">
            {inr(v.omissions)}
          </p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Net effect{v.status !== "approved" ? " (not yet counted)" : ""}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{inr(v.effect)}</p>
        </div>
      </section>

      {/* ---- why ---- */}
      <section className="space-y-2" aria-labelledby="variation-reason">
        <h2 id="variation-reason" className="text-sm font-semibold">
          Why this was instructed
        </h2>
        <p className="whitespace-pre-wrap rounded-md border border-border p-3 text-sm">
          {v.reason}
        </p>
        <dl className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-4">
          <div>
            <dt className="font-medium">Instruction ref</dt>
            <dd>{v.instructionRef ?? "—"}</dd>
          </div>
          <div>
            <dt className="font-medium">Instructed on</dt>
            <dd>{v.instructedOn ?? "—"}</dd>
          </div>
          <div>
            <dt className="font-medium">Raised</dt>
            <dd>{new Date(v.createdAt).toLocaleDateString("en-IN")}</dd>
          </div>
          <div>
            <dt className="font-medium">
              {v.approvedAt ? "Approved" : v.rejectedAt ? "Rejected" : "Submitted"}
            </dt>
            <dd>
              {v.approvedAt
                ? new Date(v.approvedAt).toLocaleDateString("en-IN")
                : v.rejectedAt
                  ? new Date(v.rejectedAt).toLocaleDateString("en-IN")
                  : v.submittedAt
                    ? new Date(v.submittedAt).toLocaleDateString("en-IN")
                    : "—"}
            </dd>
          </div>
        </dl>
        {v.rejectionReason && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <strong>Rejected:</strong> {v.rejectionReason}
          </p>
        )}
      </section>

      {/* ---- the lines ---- */}
      <section className="space-y-3" aria-labelledby="variation-lines">
        <h2 id="variation-lines" className="text-sm font-semibold">
          Lines
        </h2>

        {v.lines.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No priced lines yet. A variation with no lines authorises nothing, but reads
            in the register as though it does.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Priced variation lines</caption>
              <thead className="border-b border-border bg-muted/40 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">#</th>
                  <th scope="col" className="px-3 py-2 font-medium">BOQ item</th>
                  <th scope="col" className="px-3 py-2 font-medium">Description</th>
                  <th scope="col" className="px-3 py-2 font-medium">Unit</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Quantity ±
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Rate</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Amount ±</th>
                </tr>
              </thead>
              <tbody>
                {v.lines.map((line) => (
                  <tr key={line.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 tabular-nums">{line.sequence}</td>
                    <td className="px-3 py-2 text-xs">
                      {line.boqItemCode ?? (
                        <span className="text-muted-foreground">extra item</span>
                      )}
                      {line.replacesRate && (
                        <div className="text-muted-foreground">replaces rate</div>
                      )}
                    </td>
                    <td className="px-3 py-2">{line.description}</td>
                    <td className="px-3 py-2 text-xs">{line.uom}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {line.quantityDelta}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(line.rate)}</td>
                    <td
                      className={`px-3 py-2 text-right font-medium tabular-nums ${
                        line.amountDelta.startsWith("-") ? "text-destructive" : ""
                      }`}
                    >
                      {inr(line.amountDelta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editable && (
          <VariationLinesForm
            variationId={v.id}
            kind={v.kind}
            items={items}
            initialLines={v.lines.map((l) => ({
              boqItemId: l.boqItemId ?? "",
              description: l.description,
              uom: l.uom,
              quantityDelta: l.quantityDelta,
              rate: l.rate,
              replacesRate: l.replacesRate,
            }))}
          />
        )}
      </section>

      {/* ---- decisions ---- */}
      <section className="space-y-3" aria-labelledby="variation-decisions">
        <h2 id="variation-decisions" className="text-sm font-semibold">
          Decisions
        </h2>
        <VariationDecisions
          variationId={v.id}
          status={v.status}
          viewerRaisedIt={v.viewerRaisedIt}
          lineCount={v.lines.length}
        />
      </section>
    </div>
  );
}
