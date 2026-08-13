/**
 * Ordence — ⭐ One goods return
 * Version: v1.4.0-alpha
 *
 * ⚠️ THE CONDITION OF EACH LINE IS SHOWN WITH ITS CONSEQUENCE, not as a
 * bare word. "Damaged" is a label; "goes to quarantine, because a
 * damaged unit returned to a selling location is a unit the next
 * customer receives" is the reason the field exists.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getGoodsReturnDetail } from "@/server/actions/goods-returns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

function inr(minorUnits: string | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "₹0.00";
  const raw = String(minorUnits);
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

export default async function GoodsReturnDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getGoodsReturnDetail(id);
  if (!result.ok) notFound();

  const { header, lines } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/inventory/returns" className="underline">
            Goods returned
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">{header.returnNo}</h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          {header.returnDate} · {header.reason.replace(/_/g, " ")}
          {header.companyName ? ` · ${header.companyName}` : ""}
          {header.invoiceNumber ? ` · against ${header.invoiceNumber}` : ""}
        </p>
      </div>

      {/**
       * 🔴 THE DEADLINE FIRST. It is the one fact here that costs money
       * and cannot be recovered once it has passed.
       */}
      {header.taxRecoverable !== null && (
        <div
          className={`rounded border-l-4 p-4 ${
            header.taxRecoverable
              ? "border-emerald-500 bg-emerald-50"
              : "border-destructive bg-red-50"
          }`}
        >
          <p className="font-semibold">{header.deadlineLabel}</p>
          <p className="mt-1 text-sm">
            {header.taxRecoverable
              ? `Raise the credit note before ${header.taxAdjustmentDeadline} and the GST on the original sale comes back. Section 34(2).`
              : `The s.34(2) window closed on ${header.taxAdjustmentDeadline}. A credit note still reduces what the customer owes, and the GST on the original sale is not recoverable.`}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Value returned
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">
              {inr(header.taxableValueMinor)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              + {inr(header.taxValueMinor)} GST
            </p>
          </CardContent>
        </Card>
        <Card className={header.unsaleableLines > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Cannot be resold
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">
              {header.unsaleableLines} of {header.lineCount}
            </p>
            <p className="text-xs text-muted-foreground">
              Held in quarantine, not back on the shelf.
            </p>
          </CardContent>
        </Card>
        <Card
          className={header.itcReversalMinor !== "0" ? "border-destructive" : undefined}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Input tax credit to reverse
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">
              {inr(header.itcReversalMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/* ⭐ s.17(5)(h) — on the lines that will be destroyed. */}
              Section 17(5)(h), on the lines that will be destroyed.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What came back</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {lines.map((l) => (
            <div key={l.lineNo} className="border-b pb-4 last:border-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {l.description}
                    {l.itemName && l.itemName !== l.description && (
                      <span className="text-muted-foreground"> · {l.itemName}</span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {l.quantity} {l.uom}
                    {l.batchNo ? ` · batch ${l.batchNo}` : ""}
                    {l.serialNo ? ` · serial ${l.serialNo}` : ""}
                    {l.warehouseName ? ` → ${l.warehouseName}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <Badge variant={l.condition === "saleable" ? "default" : "secondary"}>
                    {l.condition}
                  </Badge>
                  <p className="mt-1 text-sm tabular-nums">
                    {inr(l.taxableValueMinor)}
                  </p>
                  {l.itcReversalMinor !== "0" && (
                    <p className="text-xs text-destructive tabular-nums">
                      {inr(l.itcReversalMinor)} ITC
                    </p>
                  )}
                </div>
              </div>
              {/** ⚠️ The consequence, not the label. */}
              <p className="mt-1 text-xs text-muted-foreground">{l.conditionNote}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {header.notes && (
        <p className="text-sm text-muted-foreground">{header.notes}</p>
      )}
    </main>
  );
}
