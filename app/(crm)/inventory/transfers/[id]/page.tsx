/**
 * Ordence — ⭐ One transfer
 * Version: v1.5.0-alpha
 *
 * ⚠️ THE TAX TREATMENT IS SHOWN WITH ITS AUTHORITY, not as a chip. "Tax
 * invoice" is a label; "these are two separate registrations, so they
 * are distinct persons under s.25(4) and this is a supply under
 * Schedule I para 2" is something somebody can defend at an assessment.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getTransferDetail } from "@/server/actions/transfers";
import { getTeamMembers } from "@/server/actions/team";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CancelTransfer,
  DispatchTransfer,
  ReceiveTransfer,
} from "@/components/inventory/transfer-actions";

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

const TONE_CLASS: Record<string, string> = {
  ok: "border-emerald-500 bg-emerald-50",
  warn: "border-amber-500 bg-amber-50",
  danger: "border-destructive bg-red-50",
  neutral: "border-muted bg-muted",
};

export default async function TransferDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [result, team] = await Promise.all([getTransferDetail(id), getTeamMembers()]);
  if (!result.ok) notFound();

  const { header, lines } = result.data;
  const people = team.ok
    ? team.data.map((m) => ({
        id: m.id,
        name: [m.firstName, m.lastName].filter(Boolean).join(" ").trim() || m.email,
      }))
    : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/inventory/transfers" className="underline">
              Stock transfers
            </Link>
          </p>
          <h1 className="text-2xl font-semibold">{header.transferNo}</h1>
          <p className="text-sm text-muted-foreground tabular-nums">
            {header.transferDate} · {header.fromName ?? "—"} → {header.toName ?? "—"}
            {header.transitName ? ` · via ${header.transitName}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {header.status === "draft" && (
            <>
              <DispatchTransfer transferId={header.id} />
              <CancelTransfer transferId={header.id} />
            </>
          )}
          {header.status === "dispatched" && (
            <ReceiveTransfer
              transferId={header.id}
              lines={lines.map((l) => ({
                lineNo: l.lineNo,
                itemName: l.itemName,
                qtyDispatched: l.qtyDispatched,
                unitCostMinor: l.unitCostMinor,
              }))}
              people={people}
            />
          )}
        </div>
      </div>

      <div className={`rounded border-l-4 p-4 ${TONE_CLASS[header.healthTone] ?? ""}`}>
        <p className="font-semibold">{header.healthLabel}</p>
        <p className="mt-1 text-sm">{header.healthDetail}</p>
      </div>

      {/**
       * 🔴 THE TREATMENT WITH ITS AUTHORITY. Recording an inter-GSTIN
       * move on a challan understates one GSTIN's outward supply AND
       * denies the other branch its credit — both found at the same
       * assessment.
       */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {header.isTaxableSupply ? "This is a taxable supply" : "This is not a supply"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{header.treatmentReason}</p>
          <p className="text-xs text-muted-foreground">{header.treatmentAuthority}</p>
          <div className="flex flex-wrap gap-4 pt-2 text-sm tabular-nums">
            <span>
              <span className="text-muted-foreground">Document: </span>
              {header.documentType === "tax_invoice" ? "tax invoice" : "delivery challan"}
              {header.documentNo ? ` ${header.documentNo}` : ""}
            </span>
            {header.fromGstin && (
              <span>
                <span className="text-muted-foreground">From GSTIN: </span>
                {header.fromGstin}
              </span>
            )}
            {header.toGstin && (
              <span>
                <span className="text-muted-foreground">To GSTIN: </span>
                {header.toGstin}
              </span>
            )}
            {header.isTaxableSupply && (
              <>
                <span>
                  <span className="text-muted-foreground">Taxable value: </span>
                  {inr(header.taxableValueMinor)}
                </span>
                <span>
                  <span className="text-muted-foreground">Tax: </span>
                  {inr(header.taxMinor)}
                </span>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Lines{" "}
            <span className="font-normal text-muted-foreground">({lines.length})</span>
          </CardTitle>
          {header.shortLines > 0 && (
            <p className="text-sm text-destructive">
              {/**
               * 🔴 The shortfall is named, not netted away. That stock
               * left and never arrived, and s.17(5)(h) takes back the
               * credit claimed on it.
               */}
              {header.shortLines} line{header.shortLines === 1 ? "" : "s"} arrived
              short. That stock was written off out of transit, and the input tax
              credit on it reversed under s.17(5)(h).
            </p>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Item</th>
                <th className="py-2 pr-3 font-medium">Batch</th>
                <th className="py-2 pr-3 text-right font-medium">Sent</th>
                <th className="py-2 pr-3 text-right font-medium">Arrived</th>
                <th className="py-2 pr-3 text-right font-medium">Unit cost</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineNo} className="border-b last:border-0 align-top">
                  <td className="py-2 pr-3 tabular-nums">{l.lineNo}</td>
                  <td className="py-2 pr-3">
                    {l.itemName ?? "—"}
                    {l.varianceNote && (
                      <p className="text-xs text-muted-foreground">{l.varianceNote}</p>
                    )}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{l.batchNo ?? "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {l.qtyDispatched}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {l.qtyReceived ?? "—"}
                    {l.shortBy && (
                      <Badge variant="destructive" className="ml-1">
                        short {l.shortBy}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {inr(l.unitCostMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {header.notes && <p className="text-sm text-muted-foreground">{header.notes}</p>}
    </main>
  );
}
