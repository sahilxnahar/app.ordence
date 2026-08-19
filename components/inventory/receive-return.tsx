"use client";

/**
 * Ordence — ⭐⭐ RECEIVING GOODS BACK
 * Version: v1.4.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE CONDITION FIELD IS THE POINT OF THIS FORM
 * ══════════════════════════════════════════════════════════════════════
 * Damaged goods returned into a selling warehouse are goods that WILL be
 * picked, and the person who finds out is the next customer. The
 * condition is captured at the door, by whoever opened the carton — the
 * only person who can see it — and it decides where the stock lands.
 *
 * ⚠️ AND THERE IS NO EXPIRY FIELD ON THIS FORM, DELIBERATELY. The
 * instinct on an inward movement is to ask for one, and whoever is at
 * the door would type today plus the shelf life — silently resetting the
 * clock on stock that has already spent nine months at a customer. The
 * batch has known when it expires since the day it was first received.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { receiveGoodsReturn } from "@/server/actions/goods-returns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  creditNoteDeadlineVerdict,
  RETURN_CONDITION_META,
  type ReturnCondition,
} from "@/lib/inventory/batch";

const REASONS = [
  ["damaged_in_transit", "Damaged in transit"],
  ["wrong_item", "Wrong item sent"],
  ["quality_rejection", "Quality rejection"],
  ["expired", "Expired"],
  ["excess_supply", "Excess supply"],
  ["order_cancelled", "Order cancelled"],
  ["sale_or_return", "Sale or return"],
  ["other", "Other"],
] as const;

type LineDraft = {
  description: string;
  batchNo: string;
  serialNo: string;
  quantity: string;
  condition: ReturnCondition;
  warehouseId: string;
  taxableRupees: string;
  taxRatePercent: string;
};

export function ReceiveReturn({
  invoiceId,
  invoiceNumber,
  invoiceDate,
  warehouses,
  today,
}: {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  warehouses: readonly { id: string; name: string; type: string }[];
  today: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selling = warehouses.filter((w) => w.type !== "quarantine");
  const quarantine = warehouses.filter((w) => w.type === "quarantine");

  const [returnNo, setReturnNo] = useState("");
  const [returnDate, setReturnDate] = useState(today);
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>("quality_rejection");
  const [challan, setChallan] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([
    {
      description: "",
      batchNo: "",
      serialNo: "",
      quantity: "1",
      condition: "saleable",
      warehouseId: selling[0]?.id ?? warehouses[0]?.id ?? "",
      taxableRupees: "",
      taxRatePercent: "18",
    },
  ]);

  /**
   * ⭐⭐ SECTION 34(2), COUNTED DOWN ON THE FORM.
   *
   * 🔴 THE DEADLINE RUNS FROM THE ORIGINAL SUPPLY DATE, NOT THE RETURN
   *    DATE. A March invoice returned in December has already missed it;
   *    a December invoice returned in March has eight months left. After
   *    the deadline the credit note can still be raised — the customer
   *    still owes less — but the GST on the original sale is gone.
   */
  const deadline = useMemo(
    () => creditNoteDeadlineVerdict({ supplyDate: invoiceDate, today }),
    [invoiceDate, today],
  );

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [
      ...prev,
      {
        description: "",
        batchNo: "",
        serialNo: "",
        quantity: "1",
        condition: "saleable",
        warehouseId: selling[0]?.id ?? warehouses[0]?.id ?? "",
        taxableRupees: "",
        taxRatePercent: "18",
      },
    ]);
  }

  function submit() {
    setError(null);
    if (!returnNo.trim()) {
      setError("Give the return a number — it goes on the inward challan.");
      return;
    }
    const bad = lines.findIndex((l) => !l.description.trim() || !l.warehouseId);
    if (bad >= 0) {
      setError(`Line ${bad + 1} needs a description and a destination.`);
      return;
    }

    start(async () => {
      const res = await receiveGoodsReturn({
        returnNo: returnNo.trim(),
        returnDate,
        invoiceId,
        reason,
        ...(challan.trim() ? { inwardChallanNo: challan.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines.map((l) => {
          const taxable = Math.round(Number(l.taxableRupees || "0") * 100);
          const bps = Math.round(Number(l.taxRatePercent || "0") * 100);
          return {
            description: l.description.trim(),
            ...(l.batchNo.trim() ? { batchNo: l.batchNo.trim() } : {}),
            ...(l.serialNo.trim() ? { serialNo: l.serialNo.trim() } : {}),
            quantity: l.quantity,
            condition: l.condition,
            warehouseId: l.warehouseId,
            taxableValueMinor: String(Math.max(0, taxable)),
            taxRateBps: bps,
            taxValueMinor: String(Math.max(0, Math.round((taxable * bps) / 10000))),
          };
        }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/inventory/returns/${res.data.id}`);
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Receive a return
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded border p-4 text-sm">
      <p className="font-medium">Against {invoiceNumber}</p>

      {/**
       * 🔴 THE DEADLINE, BEFORE ANYTHING IS TYPED. It is the one fact on
       * this form that costs money and cannot be recovered.
       */}
      <div
        className={`rounded border-l-2 p-3 ${
          deadline.taxRecoverable
            ? deadline.daysLeft <= 30
              ? "border-amber-500 bg-amber-50"
              : "border-sky-500 bg-sky-50"
            : "border-destructive bg-red-50"
        }`}
      >
        <p className="font-medium">{deadline.label}</p>
        <p className="mt-1 text-muted-foreground">{deadline.detail}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`gr-no-${invoiceId}`} required>
            Return number
          </Label>
          <Input
            id={`gr-no-${invoiceId}`}
            value={returnNo}
            onChange={(e) => setReturnNo(e.target.value)}
            placeholder="SR/2026-27/0007"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`gr-dt-${invoiceId}`} required>
            Received on
          </Label>
          <Input
            id={`gr-dt-${invoiceId}`}
            type="date"
            value={returnDate}
            onChange={(e) => setReturnDate(e.target.value)}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`gr-rs-${invoiceId}`}>Why it came back</Label>
          <Select
            id={`gr-rs-${invoiceId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value as (typeof REASONS)[number][0])}
          >
            {REASONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`gr-ch-${invoiceId}`}>Inward challan</Label>
          <Input
            id={`gr-ch-${invoiceId}`}
            value={challan}
            onChange={(e) => setChallan(e.target.value)}
            placeholder="The customer's delivery challan"
          />
        </div>
      </div>

      <div className="space-y-4">
        {lines.map((l, i) => {
          const meta = RETURN_CONDITION_META[l.condition];
          const destinations = meta.saleable ? selling : quarantine;
          return (
            <div key={i} className="space-y-3 rounded border p-3">
              <p className="text-xs font-medium text-muted-foreground">Line {i + 1}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`gl-d-${i}`} required>
                    What came back
                  </Label>
                  <Input
                    id={`gl-d-${i}`}
                    value={l.description}
                    onChange={(e) => setLine(i, { description: e.target.value })}
                    placeholder="Ultratech OPC 53 · 50 kg"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`gl-q-${i}`} required>
                    Quantity
                  </Label>
                  <Input
                    id={`gl-q-${i}`}
                    value={l.quantity}
                    onChange={(e) => setLine(i, { quantity: e.target.value })}
                    className="tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`gl-b-${i}`}>Batch</Label>
                  <Input
                    id={`gl-b-${i}`}
                    value={l.batchNo}
                    onChange={(e) => setLine(i, { batchNo: e.target.value })}
                    className="tabular-nums"
                  />
                  <p className="text-xs text-muted-foreground">
                    {/**
                     * 🔴 No expiry field here, on purpose. The batch
                     * already knows, and typing a new one would reset
                     * the clock on stock that has aged at a customer.
                     */}
                    The batch keeps the expiry it was received with. There is
                    nowhere to type a new one, deliberately.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`gl-s-${i}`}>Serial</Label>
                  <Input
                    id={`gl-s-${i}`}
                    value={l.serialNo}
                    onChange={(e) => setLine(i, { serialNo: e.target.value })}
                    className="tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`gl-c-${i}`} required>
                    Condition
                  </Label>
                  <Select
                    id={`gl-c-${i}`}
                    value={l.condition}
                    onChange={(e) => {
                      const c = e.target.value as ReturnCondition;
                      const dest = RETURN_CONDITION_META[c].saleable
                        ? selling[0]?.id
                        : quarantine[0]?.id;
                      setLine(i, { condition: c, ...(dest ? { warehouseId: dest } : {}) });
                    }}
                  >
                    {(Object.keys(RETURN_CONDITION_META) as ReturnCondition[]).map((c) => (
                      <option key={c} value={c}>
                        {RETURN_CONDITION_META[c].label}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground">{meta.note}</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`gl-w-${i}`} required>
                    Goes to
                  </Label>
                  <Select
                    id={`gl-w-${i}`}
                    value={l.warehouseId}
                    onChange={(e) => setLine(i, { warehouseId: e.target.value })}
                  >
                    {destinations.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                  {!meta.saleable && quarantine.length === 0 && (
                    <p className="text-xs text-destructive">
                      {/**
                       * ⚠️ Named rather than silently allowed. Without a
                       * quarantine location there is nowhere lawful for
                       * this stock to go, and the database will refuse it.
                       */}
                      There is no quarantine warehouse set up. Unsaleable returns
                      have nowhere to go until there is one.
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`gl-v-${i}`}>Value (₹)</Label>
                  <Input
                    id={`gl-v-${i}`}
                    value={l.taxableRupees}
                    onChange={(e) => setLine(i, { taxableRupees: e.target.value })}
                    className="tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`gl-t-${i}`}>GST %</Label>
                  <Input
                    id={`gl-t-${i}`}
                    value={l.taxRatePercent}
                    onChange={(e) => setLine(i, { taxRatePercent: e.target.value })}
                    className="tabular-nums"
                  />
                  {(l.condition === "expired" || l.condition === "scrap") && (
                    <p className="text-xs font-medium">
                      {/**
                       * ⭐ s.17(5)(h) SAID AT THE DOOR, while somebody is
                       * looking at the carton and knows the rate.
                       */}
                      This will be destroyed, so the input tax credit claimed on
                      it has to be reversed under s.17(5)(h).
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <Button type="button" size="sm" variant="outline" onClick={addLine}>
          Add another line
        </Button>
      </div>

      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Two bags split on the customer's forklift. Driver signed the challan."
        rows={2}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? "Recording…" : "Record the return"}
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
