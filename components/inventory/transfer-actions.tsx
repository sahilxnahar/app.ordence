"use client";

/**
 * Ordence — ⭐⭐ TRANSFER ACTIONS
 * Version: v1.5.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FORM ANSWERS "IS THIS A SUPPLY?" BEFORE ANY LINES ARE TYPED
 * ══════════════════════════════════════════════════════════════════════
 * A move between two of our own godowns can be a **taxable supply** —
 * Section 25(4) makes each GST registration a distinct person, and
 * Schedule I para 2 makes a supply between them taxable even with no
 * money changing hands.
 *
 * ⚠️ Finding that out at save time means re-keying the whole document as
 * a tax invoice, so the answer appears as soon as the two locations are
 * chosen. And it is decided by the **GSTINs**, not the states — which is
 * the mistake everybody makes, in both directions.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  receiveTransfer,
} from "@/server/actions/transfers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { transferTaxTreatment, transferVariance } from "@/lib/inventory/transfer";

export type WarehouseOption = {
  id: string;
  name: string;
  type: string;
  gstin: string | null;
  stateCode: string | null;
};

function inr(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function toMilli(v: string): bigint {
  const [whole = "0", frac = ""] = v.split(".");
  try {
    return BigInt(whole || "0") * 1000n + BigInt((frac + "000").slice(0, 3));
  } catch {
    return 0n;
  }
}

type LineDraft = {
  stockItemId: string;
  batchNo: string;
  qtyDispatched: string;
  unitCostRupees: string;
  taxRatePercent: string;
};

/* ------------------------------------------------------------------ */

export function CreateTransfer({
  warehouses,
  items,
  today,
}: {
  warehouses: readonly WarehouseOption[];
  items: readonly { id: string; name: string; uom: string }[];
  today: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stores = warehouses.filter((w) => w.type !== "transit");
  const transits = warehouses.filter((w) => w.type === "transit");

  const [transferNo, setTransferNo] = useState("");
  const [transferDate, setTransferDate] = useState(today);
  const [fromId, setFromId] = useState(stores[0]?.id ?? "");
  const [toId, setToId] = useState(stores[1]?.id ?? "");
  const [transitId, setTransitId] = useState(transits[0]?.id ?? "");
  const [recipientHasFullItc, setRecipientHasFullItc] = useState(true);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([
    {
      stockItemId: items[0]?.id ?? "",
      batchNo: "",
      qtyDispatched: "1",
      unitCostRupees: "",
      taxRatePercent: "18",
    },
  ]);

  /**
   * ⭐ THE ANSWER, LIVE, FROM THE SAME PURE FUNCTION THE SERVER USES.
   * Two implementations of a tax rule is two answers, and the person
   * reading the screen would believe the wrong one.
   */
  const treatment = useMemo(() => {
    const from = warehouses.find((w) => w.id === fromId);
    const to = warehouses.find((w) => w.id === toId);
    return transferTaxTreatment({
      fromGstin: from?.gstin ?? null,
      toGstin: to?.gstin ?? null,
      fromStateCode: from?.stateCode ?? null,
      toStateCode: to?.stateCode ?? null,
    });
  }, [warehouses, fromId, toId]);

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function submit() {
    setError(null);
    if (!transferNo.trim()) {
      setError("Give the transfer a number — it goes on the challan.");
      return;
    }
    if (fromId === toId) {
      setError("The source and the destination are the same place.");
      return;
    }
    if (!transitId) {
      setError(
        "There is no transit location. Goods on a lorry have to sit somewhere that is not a selling warehouse — create one of type “transit”.",
      );
      return;
    }
    start(async () => {
      const res = await createTransfer({
        transferNo: transferNo.trim(),
        transferDate,
        fromWarehouseId: fromId,
        toWarehouseId: toId,
        transitWarehouseId: transitId,
        recipientHasFullItc,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines.map((l) => ({
          stockItemId: l.stockItemId,
          ...(l.batchNo.trim() ? { batchNo: l.batchNo.trim() } : {}),
          qtyDispatched: l.qtyDispatched,
          unitCostMinor: String(
            Math.max(0, Math.round(Number(l.unitCostRupees || "0") * 100)),
          ),
          taxRateBps: Math.round(Number(l.taxRatePercent || "0") * 100),
        })),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/inventory/transfers/${res.data.id}`);
    });
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        New transfer
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded border p-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="tr-no" required>
            Transfer number
          </Label>
          <Input
            id="tr-no"
            value={transferNo}
            onChange={(e) => setTransferNo(e.target.value)}
            placeholder="ST/2026-27/0014"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tr-dt" required>
            Date
          </Label>
          <Input
            id="tr-dt"
            type="date"
            value={transferDate}
            onChange={(e) => setTransferDate(e.target.value)}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tr-from" required>
            From
          </Label>
          <Select id="tr-from" value={fromId} onChange={(e) => setFromId(e.target.value)}>
            {stores.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.gstin ? ` · ${w.gstin}` : ""}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tr-to" required>
            To
          </Label>
          <Select id="tr-to" value={toId} onChange={(e) => setToId(e.target.value)}>
            {stores.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.gstin ? ` · ${w.gstin}` : ""}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tr-transit" required>
            In transit via
          </Label>
          <Select
            id="tr-transit"
            value={transitId}
            onChange={(e) => setTransitId(e.target.value)}
          >
            <option value="">— none set up —</option>
            {transits.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {/**
             * 🔴 The column this whole document exists for. Between
             * dispatch and receipt the stock is ours and is in neither
             * godown.
             */}
            Where the goods sit while they are on the lorry — ours, on the
            balance sheet, and in neither godown.
          </p>
        </div>
      </div>

      {/**
       * 🔴 THE ANSWER, BEFORE ANY LINES ARE TYPED.
       */}
      <div
        className={`rounded border-l-2 p-3 ${
          treatment.isTaxableSupply
            ? "border-amber-500 bg-amber-50"
            : "border-sky-500 bg-sky-50"
        }`}
      >
        <p className="font-medium">
          {treatment.isTaxableSupply
            ? `This is a taxable supply — it needs a tax invoice with ${
                treatment.taxKind === "igst" ? "IGST" : "CGST and SGST"
              } on it.`
            : "This is not a supply — a delivery challan under Rule 55, with no tax."}
        </p>
        <p className="mt-1 text-muted-foreground">{treatment.reason}</p>
        <p className="mt-1 text-xs text-muted-foreground">{treatment.authority}</p>
      </div>

      {treatment.isTaxableSupply && (
        <div className="flex items-center gap-2">
          <input
            id="tr-itc"
            type="checkbox"
            checked={recipientHasFullItc}
            onChange={(e) => setRecipientHasFullItc(e.target.checked)}
            className="h-4 w-4"
          />
          <div>
            <Label htmlFor="tr-itc">
              The receiving branch can claim the whole input tax credit
            </Label>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⭐ Rule 28's second proviso: where the recipient is
               * eligible for full ITC, the invoice value IS the open
               * market value. Untick it and an open market value has to
               * be established, which is real work.
               */}
              Rule 28&apos;s second proviso — if it can, whatever you declare is
              deemed the open market value and cost is a fine figure. If it
              cannot, an open market value has to be established.
            </p>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {lines.map((l, i) => (
          <div key={i} className="grid gap-3 rounded border p-3 sm:grid-cols-4">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`tl-i-${i}`} required>
                Item
              </Label>
              <Select
                id={`tl-i-${i}`}
                value={l.stockItemId}
                onChange={(e) => setLine(i, { stockItemId: e.target.value })}
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`tl-b-${i}`}>Batch</Label>
              <Input
                id={`tl-b-${i}`}
                value={l.batchNo}
                onChange={(e) => setLine(i, { batchNo: e.target.value })}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`tl-q-${i}`} required>
                Quantity
              </Label>
              <Input
                id={`tl-q-${i}`}
                value={l.qtyDispatched}
                onChange={(e) => setLine(i, { qtyDispatched: e.target.value })}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`tl-c-${i}`}>Unit cost (₹)</Label>
              <Input
                id={`tl-c-${i}`}
                value={l.unitCostRupees}
                onChange={(e) => setLine(i, { unitCostRupees: e.target.value })}
                className="tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                {/* ⭐ Cost travels with the goods so the far end values them right. */}
                Travels with the goods.
              </p>
            </div>
            {treatment.isTaxableSupply && (
              <div className="space-y-1">
                <Label htmlFor={`tl-t-${i}`}>GST %</Label>
                <Input
                  id={`tl-t-${i}`}
                  value={l.taxRatePercent}
                  onChange={(e) => setLine(i, { taxRatePercent: e.target.value })}
                  className="tabular-nums"
                />
              </div>
            )}
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            setLines((p) => [
              ...p,
              {
                stockItemId: items[0]?.id ?? "",
                batchNo: "",
                qtyDispatched: "1",
                unitCostRupees: "",
                taxRatePercent: "18",
              },
            ])
          }
        >
          Add a line
        </Button>
      </div>

      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Replenishing Nagpur ahead of the festival season."
        rows={2}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? "Creating…" : "Create"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function DispatchTransfer({ transferId }: { transferId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vehicleNo, setVehicleNo] = useState("");
  const [ewayBillNo, setEwayBillNo] = useState("");

  function submit() {
    setError(null);
    start(async () => {
      const res = await dispatchTransfer({
        transferId,
        ...(vehicleNo.trim() ? { vehicleNo: vehicleNo.trim().toUpperCase() } : {}),
        ...(ewayBillNo.trim() ? { ewayBillNo: ewayBillNo.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Dispatch
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="dp-v">Vehicle</Label>
          <Input
            id="dp-v"
            value={vehicleNo}
            onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
            placeholder="MH12AB1234"
            className="uppercase tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="dp-e">E-way bill</Label>
          <Input
            id="dp-e"
            value={ewayBillNo}
            onChange={(e) => setEwayBillNo(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            {/**
             * ⚠️ Rule 138 applies to a branch transfer just as much as to
             * a sale — it is the movement that is covered, not the sale.
             */}
            Required above ₹50,000 of goods moving, sale or not.
          </p>
        </div>
      </div>
      <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-3">
        <p className="font-medium">
          {/**
           * 🔴 Dispatch is irreversible, and the form says so. Once the
           * goods are on a lorry the transfer cannot be cancelled —
           * something has to account for them.
           */}
          Once this is dispatched it cannot be cancelled. The stock leaves the
          source and sits in transit until somebody counts it in at the other
          end.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Dispatching…" : "Dispatch it"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ RECEIVE — AND THE SHORTAGE IS THE POINT.
 *
 * 🔴 100 bags leave and 98 arrive. Receiving 98 and moving on makes the
 *    two missing bags simply vanish. Here they are named, valued, and
 *    they need an approver — because writing them off also reverses the
 *    input tax credit under s.17(5)(h).
 */
export function ReceiveTransfer({
  transferId,
  lines,
  people,
}: {
  transferId: string;
  lines: readonly {
    lineNo: number;
    itemName: string | null;
    qtyDispatched: string;
    unitCostMinor: string;
  }[];
  people: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<number, string>>(
    Object.fromEntries(lines.map((l) => [l.lineNo, l.qtyDispatched])),
  );
  const [approvedBy, setApprovedBy] = useState("");
  const [varianceNote, setVarianceNote] = useState("");
  const [itcRatePercent, setItcRatePercent] = useState("18");

  /**
   * ⚠️ COMPUTED BY THE SAME PURE FUNCTION THE SERVER USES, INCLUDING ITS
   * REFUSAL OF AN EXCESS. More arriving than left is stock from nowhere.
   */
  const variance = useMemo(() => {
    try {
      return transferVariance(
        lines.map((l) => ({
          lineNo: l.lineNo,
          description: l.itemName ?? `line ${l.lineNo}`,
          qtyDispatchedMilli: toMilli(l.qtyDispatched),
          qtyReceivedMilli: toMilli(counts[l.lineNo] ?? "0"),
          unitCostMinor: BigInt(l.unitCostMinor),
        })),
      );
    } catch {
      return null;
    }
  }, [lines, counts]);

  const isShort = (variance?.lines.length ?? 0) > 0;

  function submit() {
    setError(null);
    if (!variance) {
      setError(
        "More has been counted in than was sent out. If more genuinely arrived, the dispatch count was wrong — correct it at the sending end rather than creating stock here.",
      );
      return;
    }
    if (isShort && !approvedBy) {
      setError("Name who is approving the shortfall write-off.");
      return;
    }
    start(async () => {
      const res = await receiveTransfer({
        transferId,
        counts: lines.map((l) => ({
          lineNo: l.lineNo,
          qtyReceived: counts[l.lineNo] ?? "0",
        })),
        ...(approvedBy ? { varianceApprovedBy: approvedBy } : {}),
        ...(varianceNote.trim() ? { varianceNote: varianceNote.trim() } : {}),
        itcRateBps: Math.round(Number(itcRatePercent || "0") * 100),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Receive
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded border p-4 text-sm">
      <p className="font-medium">Count what actually arrived</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Item</th>
            <th className="py-2 pr-3 text-right font-medium">Sent</th>
            <th className="py-2 pr-3 text-right font-medium">Arrived</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineNo} className="border-b last:border-0">
              <td className="py-2 pr-3">{l.itemName ?? `Line ${l.lineNo}`}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{l.qtyDispatched}</td>
              <td className="py-2 pr-3 text-right">
                <Input
                  value={counts[l.lineNo] ?? ""}
                  onChange={(e) =>
                    setCounts((p) => ({ ...p, [l.lineNo]: e.target.value }))
                  }
                  className="h-8 w-28 text-right tabular-nums"
                  aria-label={`Received on line ${l.lineNo}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isShort && variance && (
        <div className="space-y-3 rounded border-l-2 border-destructive bg-red-50 p-3">
          <p className="font-medium tabular-nums">
            {/**
             * 🔴 NAMED AND VALUED. Without this the missing stock is
             * simply gone, sitting in transit with nothing explaining it.
             */}
            {variance.lines.length} line{variance.lines.length === 1 ? "" : "s"} short ·{" "}
            {inr(variance.totalLossMinor)} of stock left and never arrived.
          </p>
          <p className="text-muted-foreground">
            That stock is still sitting in transit. Receiving without accounting
            for it would leave it there forever. It gets written off out of
            transit — and because goods &ldquo;lost&rdquo; are named in
            s.17(5)(h), the input tax credit claimed on them is reversed too.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="rv-app" required>
                Approved by
              </Label>
              <Select
                id="rv-app"
                value={approvedBy}
                onChange={(e) => setApprovedBy(e.target.value)}
              >
                <option value="">— choose —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rv-itc">GST rate the credit was claimed at</Label>
              <Input
                id="rv-itc"
                value={itcRatePercent}
                onChange={(e) => setItcRatePercent(e.target.value)}
                className="tabular-nums"
              />
            </div>
          </div>
          <Textarea
            value={varianceNote}
            onChange={(e) => setVarianceNote(e.target.value)}
            placeholder="Two bags split in transit; driver signed the shortage on the challan."
            rows={2}
          />
        </div>
      )}

      {!variance && (
        <p className="text-sm text-destructive">
          More has been counted in than was sent out. If more genuinely arrived,
          the dispatch count was wrong — correct it at the sending end.
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Receiving…" : "Receive"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function CancelTransfer({ transferId }: { transferId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  function submit() {
    setError(null);
    if (reason.trim().length < 3) {
      setError("A cancellation carries a reason.");
      return;
    }
    start(async () => {
      const res = await cancelTransfer({ transferId, reason: reason.trim() });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Cancel transfer
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Raised against the wrong godown."
        rows={2}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={submit}
          disabled={pending}
        >
          {pending ? "Cancelling…" : "Cancel it"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Keep it
        </Button>
      </div>
    </div>
  );
}
