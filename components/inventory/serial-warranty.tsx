"use client";

/**
 * Ordence — ⭐ Setting a warranty on one unit
 * Version: v1.4.0-alpha
 *
 * 🔴 WARRANTY RUNS FROM DISPATCH, NOT FROM RECEIPT INTO OUR WAREHOUSE.
 *    A panel that sat in a store for eight months has not used eight
 *    months of its cover. Starting the clock at receipt shortens every
 *    customer's warranty by however long the stock took to sell — and it
 *    is the customer who discovers it, at the point of a claim.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setSerialWarranty } from "@/server/actions/batches";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { warrantyUntil } from "@/lib/inventory/batch";

export function SerialWarranty({
  serialId,
  serialNo,
  dispatched,
}: {
  serialId: string;
  serialNo: string;
  dispatched: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [months, setMonths] = useState("60");
  const [startFrom, setStartFrom] = useState("");

  /**
   * ⚠️ PREVIEWED FROM THE SAME FUNCTION THE SERVER USES, including the
   * month-end rule: 31 January plus one month is 28 February, not
   * 3 March. Letting the date overflow gives a customer three extra days
   * of cover in some months and none in others — arbitrary, and
   * impossible to explain when it is disputed.
   */
  const preview = useMemo(() => {
    if (!startFrom) return null;
    const m = Number(months);
    if (!Number.isInteger(m) || m < 0) return null;
    try {
      return warrantyUntil({ dispatchedOn: startFrom, warrantyMonths: m });
    } catch {
      return null;
    }
  }, [startFrom, months]);

  function submit() {
    setError(null);
    const m = Number(months);
    if (!Number.isInteger(m) || m < 0) {
      setError("Warranty is a whole number of months.");
      return;
    }
    start(async () => {
      const res = await setSerialWarranty({
        serialId,
        warrantyMonths: m,
        ...(startFrom ? { startFrom } : {}),
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs underline text-muted-foreground"
      >
        set warranty
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded border p-3">
      <p className="text-xs font-medium">{serialNo}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`sw-m-${serialId}`} className="text-xs">
            Months
          </Label>
          <Input
            id={`sw-m-${serialId}`}
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            className="h-8 w-20 tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`sw-s-${serialId}`} className="text-xs">
            Starts
          </Label>
          <Input
            id={`sw-s-${serialId}`}
            type="date"
            value={startFrom}
            onChange={(e) => setStartFrom(e.target.value)}
            className="h-8 w-40 tabular-nums"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {dispatched
          ? "Leave the date blank to run it from the day this unit shipped."
          : /**
             * ⚠️ NOT YET DISPATCHED MEANS NOT YET STARTED. A warranty
             * that begins while the unit is still on our shelf is cover
             * the customer never gets.
             */
            "This unit has not shipped, so its warranty has not started. Give an explicit date only for a unit sold before Ordence."}
      </p>
      {preview && (
        <p className="text-xs font-medium tabular-nums">Covered until {preview}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
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
