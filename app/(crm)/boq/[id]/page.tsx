/**
 * Ordence — ⭐ ONE BILL OF QUANTITIES
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS ROUTE DID NOT EXIST AND THE LIST LINKED TO IT
 * ══════════════════════════════════════════════════════════════════════
 * `/boq` shipped last session with every code in the table linking to
 * `/boq/{id}`. Nothing was there. Every one of those links was a 404 —
 * the exact failure the module registry's `coming_soon` status exists to
 * prevent, introduced by hand in the same week.
 *
 * Worth naming rather than quietly fixing: a customer cannot tell a
 * missing feature from a broken product. Both look like software that
 * does not work.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ QUANTITIES ARE MICRO-UNITS. THE DIVIDE HAPPENS ONCE, IN `qty()`
 * ══════════════════════════════════════════════════════════════════════
 * And it is done on the decimal STRING, not through a float. A quantity
 * on this page sits next to the contractor's own figure in a meeting;
 * 12.35 against their 12.345 is an argument nobody needs.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { getBoqDetail } from "@/server/actions/construction";
import { BoqItemEditor, NewMeasurementBookForm } from "@/components/construction/boq-actions";
import {
  RecordMeasurementForm,
  CheckMeasurementControls,
} from "@/components/construction/measurement-actions";
import { requirePageContext } from "@/server/tenant-context";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "BOQ · Ordence" };

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
 * Micro-units → a readable quantity, by slicing the string.
 *
 * ⚠️ NOT `Number(scaled) / 1e6`. That is exact for the values anybody
 * tests with and stops being exact as quantities grow — and the error
 * lands in the decimals, which is precisely where a contractor checks.
 */
function qty(scaled: string | null | undefined): string {
  if (!scaled) return "0.000";
  const raw = String(scaled);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(7, "0");
  const whole = digits.slice(0, -6) || "0";
  const frac = digits.slice(-6).replace(/0{3}$/, "");
  return `${negative ? "-" : ""}${whole}.${frac || "000"}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "draft": return "Draft — still editable";
    case "issued": return "Issued — lines frozen";
    case "superseded": return "Superseded";
    case "closed": return "Closed";
    default: return status;
  }
}

function measurementBadge(status: string): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  switch (status) {
    case "recorded": return { label: "Awaiting check", variant: "secondary" };
    case "checked": return { label: "Checked", variant: "default" };
    case "billed": return { label: "Billed", variant: "outline" };
    case "rejected": return { label: "Rejected", variant: "destructive" };
    default: return { label: status, variant: "outline" };
  }
}

export default async function BoqDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  /*
   * ⚠️ THE CONTEXT IS RESOLVED HERE TOO, and not only for the tenant.
   * `ctx.user.id` is what decides whether the viewer may check each
   * measurement — the person who recorded it may not. Passing it down
   * per row is the only way that rule can be stated on the screen rather
   * than discovered as a refusal.
   */
  const ctx = await requirePageContext();
  const result = await getBoqDetail(id);

  if (!result.ok) {
    // A genuinely missing BOQ is a 404. A permission refusal is not, and
    // conflating them would tell somebody a record does not exist when it
    // does — which is its own small information leak.
    if (/does not exist/i.test(result.error)) notFound();
    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{result.error}</p>
        </div>
      </div>
    );
  }

  const boq = result.data;
  const priced = boq.items.filter((item) => !item.isHeading);
  const awaitingCheck = boq.measurements.filter((m) => m.status === "recorded");

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link
          href="/boq"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          All bills of quantities
        </Link>
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-xl font-bold">{boq.code}</h1>
          <Badge variant={boq.status === "draft" ? "secondary" : "default"}>
            {statusLabel(boq.status)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {boq.title} · {boq.workPackage}
          {boq.projectName ? ` · ${boq.projectName}` : ""}
          {boq.contractorName ? ` · ${boq.contractorName}` : ""}
        </p>

        {/*
          ⚠️ THE MISSING CONTRACT IS SAID HERE, AT THE TOP, IN WORDS.
          Without it, SQL 0041's over-billing guard skips every line on
          every bill raised against this BOQ — silently. A reader has no
          other way to know the check is off.
        */}
        {!boq.contractId && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              No works contract attached
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Bills raised against this BOQ are not checked against the authorised
              quantity, because there is no contract to check them through. Attach one
              once it is signed.
            </p>
          </div>
        )}
      </header>

      <dl className="grid gap-3 sm:grid-cols-4">
        {[
          ["Original sum", inr(boq.originalSumMinor)],
          ["Revised sum", inr(boq.revisedSumMinor)],
          ["Priced lines", String(priced.length)],
          ["Retention", `${(boq.retentionRateBps / 100).toFixed(2)}%`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border border-border p-3">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {/* ---- LINES ------------------------------------------------- */}

      <section className="space-y-3" aria-labelledby="boq-items">
        <h2 id="boq-items" className="text-sm font-semibold">Priced lines</h2>

        {priced.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Priced lines on this BOQ</caption>
              <thead className="border-b border-border bg-muted/40 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Code</th>
                  <th scope="col" className="px-3 py-2 font-medium">Description</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Quantity</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Rate</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {priced.map((item) => (
                  <tr key={item.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium">{item.itemCode}</td>
                    <td className="px-3 py-2">{item.description}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {qty(item.quantityScaled)} {item.uom}
                      {/*
                        A variation is shown as an ADDITION to the original,
                        never folded into it. "1,000 + 150" tells a reader
                        that scope changed; "1,150" does not, and the
                        difference is the whole audit trail.
                      */}
                      {item.variedQuantityScaled && item.variedQuantityScaled !== "0" && (
                        <div className="text-xs text-muted-foreground">
                          + {qty(item.variedQuantityScaled)} varied
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(item.rateMinor)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(item.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <BoqItemEditor boqId={boq.id} status={boq.status} />
      </section>

      {/* ---- MEASUREMENT ------------------------------------------- */}

      <section className="space-y-3" aria-labelledby="boq-measurement">
        <h2 id="boq-measurement" className="text-sm font-semibold">Measurement</h2>

        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
          {boq.books.length === 0 ? (
            <span>No measurement book open.</span>
          ) : (
            boq.books.map((book) => (
              <span key={book.id} className="rounded border border-border px-2 py-0.5 text-xs">
                {book.bookNumber} · opened {book.openedOn}
                {book.isClosed ? " · closed" : ""}
              </span>
            ))
          )}
        </div>

        <NewMeasurementBookForm boqId={boq.id} />

        <RecordMeasurementForm
          books={boq.books.filter((b) => !b.isClosed).map((b) => ({ id: b.id, bookNumber: b.bookNumber }))}
          items={priced.map((item) => ({
            id: item.id,
            itemCode: item.itemCode,
            description: item.description,
            uom: item.uom,
          }))}
        />

        {awaitingCheck.length > 0 && (
          <p className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            {awaitingCheck.length}{" "}
            {awaitingCheck.length === 1 ? "measurement is" : "measurements are"} waiting to be
            checked. Nothing can be billed until somebody other than the measurer has agreed
            them.
          </p>
        )}

        {boq.measurements.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Measurements recorded against this BOQ</caption>
              <thead className="border-b border-border bg-muted/40 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Item</th>
                  <th scope="col" className="px-3 py-2 font-medium">Where</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Quantity</th>
                  <th scope="col" className="px-3 py-2 font-medium">Measured by</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Check</th>
                </tr>
              </thead>
              <tbody>
                {boq.measurements.map((entry) => {
                  const badge = measurementBadge(entry.status);
                  return (
                    <tr key={entry.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">{entry.itemCode ?? "—"}</td>
                      <td className="px-3 py-2">
                        {entry.locationRef}
                        {entry.levelRef && (
                          <div className="text-xs text-muted-foreground">{entry.levelRef}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {entry.isDeduction && (
                          <span className="mr-1 text-muted-foreground">less</span>
                        )}
                        {qty(entry.quantityScaled)}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {entry.measuredByName || "—"}
                        <div className="text-muted-foreground">{entry.measuredOn}</div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {/*
                          ⚠️ THE CHECKER IS NAMED, NOT JUST TICKED. A
                          measurement whose measurer and checker are the
                          same person is a control that did not happen —
                          and "checked ✓" alone hides exactly that.
                        */}
                        {entry.checkedByName && (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            by {entry.checkedByName}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {entry.status === "recorded" ? (
                          <CheckMeasurementControls
                            measurementEntryId={entry.id}
                            viewerIsMeasurer={entry.measuredBy === ctx.user.id}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
