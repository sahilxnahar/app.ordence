"use client";

/**
 * Ordence — ⭐⭐ BATCH ACTIONS
 * Version: v1.4.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE WRITE-OFF FORM SHOWS THE TAX BEFORE THE BUTTON IS PRESSED
 * ══════════════════════════════════════════════════════════════════════
 * Writing off expired stock is not one entry. Section 17(5)(h) blocks
 * the input tax credit claimed on goods written off, so the credit has
 * to be reversed as well — and most software does only the stock half.
 * The figure appears on the form, not in an accountant's reconciliation
 * eight months later.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setBatchStatus, updateBatch, writeOffBatch } from "@/server/actions/batches";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { itcReversalOnWriteOff } from "@/lib/inventory/batch";

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

/* ------------------------------------------------------------------ */

/**
 * ⭐ CORRECT AN EXPIRY DATE — the ONLY place it can be changed.
 *
 * 🔴 A GOODS RECEIPT CANNOT DO IT. The 0055 trigger refuses a movement
 *    whose expiry disagrees with the batch, precisely so that correcting
 *    it is a deliberate act by somebody who has looked at the carton.
 */
export function EditBatch({
  batchId,
  batchNo,
  expiryDate,
  manufactureDate,
}: {
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  manufactureDate: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(expiryDate ?? "");
  const [made, setMade] = useState(manufactureDate ?? "");
  const [note, setNote] = useState("");

  function submit() {
    setError(null);
    if (note.trim().length < 10) {
      setError("Say why in a sentence — this changes what can be sold.");
      return;
    }
    start(async () => {
      const res = await updateBatch({
        batchId,
        expiryDate: expiry || null,
        manufactureDate: made || null,
        note: note.trim(),
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
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Correct dates
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <p className="font-medium">Batch {batchNo}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`bm-${batchId}`}>Manufactured</Label>
          <Input
            id={`bm-${batchId}`}
            type="date"
            value={made}
            onChange={(e) => setMade(e.target.value)}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`be-${batchId}`}>Expires</Label>
          <Input
            id={`be-${batchId}`}
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            {/* Stock is saleable ON its expiry date, not up to the day before. */}
            Stock is saleable on this date, and not the day after.
          </p>
        </div>
      </div>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Carton reads 03/2028; the goods-inward entry had 03/2027."
        rows={2}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Save"}
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
 * ⭐ QUARANTINE, RELEASE, RECALL.
 *
 * 🔴 THIS IS NOT A LABEL. The 0055 trigger refuses an outward movement
 *    from a recalled or written-off batch, so pressing this actually
 *    stops a picker being sent to the stock — which is the only version
 *    of a recall that works.
 */
export function BatchStatusButton({
  batchId,
  batchNo,
  status,
}: {
  batchId: string;
  batchNo: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState(status === "active" ? "quarantined" : "active");
  const [note, setNote] = useState("");

  function submit() {
    setError(null);
    if (note.trim().length < 10) {
      setError("A status change carries a reason.");
      return;
    }
    start(async () => {
      const res = await setBatchStatus({
        batchId,
        status: next as "active" | "quarantined" | "expired" | "recalled" | "written_off",
        note: note.trim(),
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
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        {status === "active" ? "Quarantine / recall" : "Change status"}
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <p className="font-medium">Batch {batchNo}</p>
      <div className="space-y-1">
        <Label htmlFor={`bs-${batchId}`}>New status</Label>
        <Select id={`bs-${batchId}`} value={next} onChange={(e) => setNext(e.target.value)}>
          <option value="active">Active — can be sold</option>
          <option value="quarantined">Quarantined — held pending a decision</option>
          <option value="expired">Expired — past its date</option>
          <option value="recalled">Recalled — must not leave the building</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          {/**
           * 🔴 The database enforces this on the way out, not a report.
           */}
          Anything other than active stops stock being issued from this batch —
          enforced by the database, not by a warning on a screen.
        </p>
      </div>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Supplier recall notice 14/08 — sediment reported in this lot."
        rows={2}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Apply"}
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
 * ⭐⭐ WRITE OFF, AND GIVE BACK THE INPUT TAX CREDIT.
 *
 * ⚠️ THE REVERSAL IS PREVIEWED FROM THE SAME PURE FUNCTION THE SERVER
 * USES. Two implementations of a tax rule is two answers, and the person
 * reading the screen would believe the wrong one.
 */
export function WriteOffBatch({
  batchId,
  batchNo,
  quantity,
  valueMinor,
  uom,
  warehouses,
  people,
}: {
  batchId: string;
  batchNo: string;
  quantity: string;
  valueMinor: string;
  uom: string;
  warehouses: readonly { id: string; name: string; type: string }[];
  people: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [qty, setQty] = useState(quantity);
  const [reason, setReason] = useState<
    "expiry" | "damage" | "theft" | "obsolescence" | "recall" | "sample"
  >("expiry");
  const [itcRatePercent, setItcRatePercent] = useState("18");
  const [isManufactured, setIsManufactured] = useState(false);
  const [itcNote, setItcNote] = useState("");
  const [approvedBy, setApprovedBy] = useState(people[0]?.id ?? "");
  const [note, setNote] = useState("");

  /**
   * ⭐ THE COST IS PRO-RATED FROM THE BALANCE, NEVER TYPED. A form field
   * for the value being written off lets somebody destroy ₹4,00,000 of
   * stock and declare ₹40,000 of it, and both figures look reasonable on
   * the screen they appear on.
   */
  const preview = useMemo(() => {
    const onHand = Number(quantity);
    const wanted = Number(qty);
    if (!Number.isFinite(onHand) || !Number.isFinite(wanted) || onHand <= 0) return null;
    if (wanted <= 0 || wanted > onHand) return null;
    const bps = Math.round(Number(itcRatePercent || "0") * 100);
    if (!Number.isInteger(bps) || bps < 0) return null;

    const costMinor =
      (BigInt(valueMinor) * BigInt(Math.round(wanted * 1000))) /
      BigInt(Math.round(onHand * 1000));
    try {
      return {
        costMinor,
        ...itcReversalOnWriteOff({
          costMinor,
          itcRateBps: bps,
          reason,
          isManufactured,
        }),
      };
    } catch {
      return null;
    }
  }, [quantity, qty, valueMinor, itcRatePercent, reason, isManufactured]);

  function submit() {
    setError(null);
    if (note.trim().length < 10) {
      setError("A write-off needs a written reason of at least ten characters.");
      return;
    }
    if (!approvedBy) {
      setError("Name the approver. The person who found it should not be the only one who signed it off.");
      return;
    }
    start(async () => {
      const res = await writeOffBatch({
        batchId,
        warehouseId,
        quantity: qty,
        reason,
        itcRateBps: Math.round(Number(itcRatePercent || "0") * 100),
        isManufactured,
        ...(itcNote.trim() ? { itcNote: itcNote.trim() } : {}),
        approvedBy,
        note: note.trim(),
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
      <Button type="button" size="sm" variant="destructive" onClick={() => setOpen(true)}>
        Write off
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded border p-4 text-sm">
      <p className="font-medium">
        Write off batch {batchNo} — {quantity} {uom} on hand, {inr(BigInt(valueMinor))}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`wo-wh-${batchId}`} required>
            From which store
          </Label>
          <Select
            id={`wo-wh-${batchId}`}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`wo-qty-${batchId}`} required>
            Quantity
          </Label>
          <Input
            id={`wo-qty-${batchId}`}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`wo-rsn-${batchId}`}>Reason</Label>
          <Select
            id={`wo-rsn-${batchId}`}
            value={reason}
            onChange={(e) =>
              setReason(
                e.target.value as
                  | "expiry"
                  | "damage"
                  | "theft"
                  | "obsolescence"
                  | "recall"
                  | "sample",
              )
            }
          >
            <option value="expiry">Expired</option>
            <option value="damage">Damaged</option>
            <option value="theft">Lost or stolen</option>
            <option value="obsolescence">Obsolete</option>
            <option value="recall">Recalled</option>
            <option value="sample">Free sample or gift</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`wo-itc-${batchId}`}>GST rate the credit was claimed at</Label>
          <Input
            id={`wo-itc-${batchId}`}
            value={itcRatePercent}
            onChange={(e) => setItcRatePercent(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            {/* The rate when it was BOUGHT, not today's rate. */}
            The rate on the purchase, not today&apos;s.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`wo-app-${batchId}`} required>
            Approved by
          </Label>
          <Select
            id={`wo-app-${batchId}`}
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
        <div className="flex items-end gap-2">
          <input
            id={`wo-mfg-${batchId}`}
            type="checkbox"
            checked={isManufactured}
            onChange={(e) => setIsManufactured(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor={`wo-mfg-${batchId}`} className="pb-2">
            We manufactured this
          </Label>
        </div>
      </div>

      {/**
       * 🔴 THE HALF EVERY OTHER PRODUCT SKIPS, ON THE FORM.
       */}
      {preview && (
        <div
          className={`rounded border-l-2 p-3 ${
            preview.arguable ? "border-amber-500 bg-amber-50" : "border-destructive bg-red-50"
          }`}
        >
          <p className="font-medium tabular-nums">
            {inr(preview.costMinor)} of stock destroyed ·{" "}
            {inr(preview.reversalMinor)} of input tax credit to reverse
          </p>
          <p className="mt-1 text-muted-foreground">{preview.explanation}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Section 17(5)(h). Declared in the GSTR-3B for the month of the
            write-off.
          </p>
        </div>
      )}

      {preview && preview.reversalMinor === 0n && (
        <div className="space-y-1">
          <Label htmlFor={`wo-note-${batchId}`} required>
            Why is there no reversal?
          </Label>
          <Input
            id={`wo-note-${batchId}`}
            value={itcNote}
            onChange={(e) => setItcNote(e.target.value)}
            placeholder="Nil-rated goods; no credit was ever claimed on this purchase."
          />
          <p className="text-xs text-muted-foreground">
            {/**
             * ⚠️ A zero is either correct or it is exactly the mistake
             * this path exists to catch, and the row cannot say which.
             */}
            Zero is sometimes right — and it is also the most common way a
            s.17(5)(h) reversal gets missed. Say which it is.
          </p>
        </div>
      )}

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Expired 31/07. Destroyed at site with the supplier's representative present."
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
          {pending ? "Writing off…" : "Write it off"}
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
