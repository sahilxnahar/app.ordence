/**
 * Ordence — ⭐ One e-way bill
 * Version: v1.3.0-alpha
 *
 * ⚠️ THE ANSWER TO "CAN THIS MOVE" IS THE FIRST THING ON THE PAGE, in a
 * sentence rather than in a status chip. Everything else — the legs, the
 * items, the payload — is what somebody needs AFTER they know.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getEwayBillDetail } from "@/server/actions/eway";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AddEwayLeg,
  CancelEway,
  EwayPayload,
  ExtendEway,
  RecordEwayNumber,
} from "@/components/gst/eway-actions";
import {
  ewayHealth,
  EWAY_SUB_SUPPLY_TYPES,
  type EwayStatus,
  type EwaySubSupplyType,
} from "@/lib/gst/eway";
import { placeOfSupplyName } from "@/lib/gst/constants";

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

/** ⚠️ IST, because the portal counts validity in IST and nothing else. */
function ist(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TONE_CLASS: Record<string, string> = {
  ok: "border-emerald-500 bg-emerald-50",
  warn: "border-amber-500 bg-amber-50",
  danger: "border-destructive bg-red-50",
  neutral: "border-muted bg-muted",
};

export default async function EwayDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getEwayBillDetail(id);
  if (!result.ok) notFound();

  const { bill, legs, items, payload } = result.data;
  const now = new Date();
  const health = ewayHealth({
    status: bill.status as EwayStatus,
    validUntil: bill.validUntil ? new Date(bill.validUntil) : null,
    vehicleNo: bill.vehicleNo,
    now,
  });

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/gst/eway" className="underline">
              E-way bills
            </Link>
          </p>
          <h1 className="text-2xl font-semibold">
            {bill.ewbNo ?? bill.documentNo}
          </h1>
          <p className="text-sm text-muted-foreground tabular-nums">
            {bill.documentNo} · {bill.documentDate} ·{" "}
            {EWAY_SUB_SUPPLY_TYPES[bill.subSupplyType as EwaySubSupplyType] ??
              bill.subSupplyType}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {bill.status === "prepared" && (
            <RecordEwayNumber ewayBillId={bill.id} hasPartB={legs.length > 0} />
          )}
          {bill.status !== "cancelled" && (
            <AddEwayLeg ewayBillId={bill.id} nextLegNo={legs.length + 1} />
          )}
        </div>
      </div>

      {/**
       * 🔴 THE SENTENCE, NOT THE CHIP. "Expired" is a word; "moving on it
       * is a detention under s.129" is a decision.
       */}
      <div className={`rounded border-l-4 p-4 ${TONE_CLASS[health.tone] ?? ""}`}>
        <p className="font-semibold">{health.label}</p>
        <p className="mt-1 text-sm">{health.detail}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Consignment value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">
              {inr(bill.consignmentValueMinor)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {/**
               * 🔴 EXPLANATION 2 SPELLED OUT ON THE SCREEN. It includes
               * tax and excludes exempt supply on a mixed document — two
               * halves that pull in opposite directions, and both of
               * them get dropped in practice.
               */}
              {inr(bill.taxableValueMinor)} taxable + {inr(bill.taxValueMinor)} tax
              {bill.exemptValueMinor !== "0" && (
                <> · {inr(bill.exemptValueMinor)} exempt, excluded</>
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Valid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm tabular-nums">{ist(bill.validFrom)}</p>
            <p className="text-sm font-semibold tabular-nums">
              → {ist(bill.validUntil)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/* Counted from the FIRST Part B entry, never from Part A. */}
              Counted from when the first vehicle was entered · {bill.distanceKm} km
              {bill.vehicleType === "odc" ? " · ODC" : ""}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Route
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm tabular-nums">
              {bill.fromPincode} → {bill.toPincode}
            </p>
            <p className="text-xs text-muted-foreground">
              {placeOfSupplyName(bill.fromStateCode)} →{" "}
              {placeOfSupplyName(bill.toStateCode)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {bill.transporterName ?? "No transporter named"}
            </p>
          </CardContent>
        </Card>
      </div>

      {bill.status === "active" && bill.validUntil && bill.generatedAt && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Extend</CardTitle>
          </CardHeader>
          <CardContent>
            <ExtendEway
              ewayBillId={bill.id}
              validUntilIso={bill.validUntil}
              generatedAtIso={bill.generatedAt}
              distanceKm={bill.distanceKm}
              vehicleType={bill.vehicleType === "odc" ? "odc" : "regular"}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Vehicles{" "}
            <span className="font-normal text-muted-foreground">({legs.length})</span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 Every leg the goods ever travelled on. An officer's
             * question is "where has this been", and a single mutable
             * vehicle column cannot answer it.
             */}
            Every leg, kept. A transshipment adds a row; it never replaces one.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {legs.length === 0 ? (
            <p className="text-sm text-destructive">
              No Part B. This e-way bill is not valid for movement, and no validity
              has started.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Leg</th>
                  <th className="py-2 pr-3 font-medium">Mode</th>
                  <th className="py-2 pr-3 font-medium">Vehicle / document</th>
                  <th className="py-2 pr-3 font-medium">From</th>
                  <th className="py-2 pr-3 font-medium">Entered</th>
                  <th className="py-2 pr-3 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l) => (
                  <tr key={l.legNo} className="border-b last:border-0">
                    <td className="py-2 pr-3 tabular-nums">{l.legNo}</td>
                    <td className="py-2 pr-3">{l.transportMode}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {l.vehicleNo ?? l.transporterDocNo ?? "—"}
                    </td>
                    <td className="py-2 pr-3">{l.fromPlace ?? "—"}</td>
                    <td className="py-2 pr-3 tabular-nums">{ist(l.enteredAt)}</td>
                    <td className="py-2 pr-3">
                      {l.reasonNote ?? l.reasonCode ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Goods{" "}
            <span className="font-normal text-muted-foreground">({items.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Item</th>
                <th className="py-2 pr-3 font-medium">HSN</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Taxable</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.lineNo} className="border-b last:border-0">
                  <td className="py-2 pr-3 tabular-nums">{i.lineNo}</td>
                  <td className="py-2 pr-3">
                    {i.productName}
                    {i.isExempt && (
                      <Badge variant="outline" className="ml-1">
                        exempt
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{i.hsnCode}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {i.quantity} {i.uqc}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {inr(i.taxableValueMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Upload to the portal</CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * ⚠️ THE HONEST SHAPE OF A PRODUCT WITH NO GSP CREDENTIALS.
             * Ordence builds the file; a human uploads it; the number
             * comes back and is recorded here.
             */}
            Ordence has no portal credentials. This is the EWB-01 JSON for the
            NIC bulk-upload tool — upload it, then record the number that comes
            back.
          </p>
        </CardHeader>
        <CardContent>
          <EwayPayload payload={payload} />
        </CardContent>
      </Card>

      {bill.status !== "cancelled" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Cancel</CardTitle>
          </CardHeader>
          <CardContent>
            <CancelEway ewayBillId={bill.id} generatedAtIso={bill.generatedAt} />
          </CardContent>
        </Card>
      )}

      {bill.cancelReason && (
        <p className="text-sm text-muted-foreground">
          Cancelled: {bill.cancelReason}
        </p>
      )}
    </main>
  );
}
