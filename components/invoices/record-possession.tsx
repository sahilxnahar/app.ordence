"use client";

/**
 * Ordence — Recording possession
 * Version: v1.0.0-rc.4
 *
 * ⚠️ THE CONFIRMATION NAMES THE AMOUNT AND THE YEAR. This is the single
 * most consequential button in the product: it recognises revenue, which
 * changes a tax computation. "Are you sure" is answered without being
 * read; "This recognises ₹84,00,000 as turnover in FY 2026-27" is not.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordPossession } from "@/server/actions/sales-posting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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

/**
 * ⚠️ THE INDIAN FINANCIAL YEAR RUNS APRIL TO MARCH, and that is the
 * whole reason this is shown. A flat handed over on 2 April lands in a
 * different year from one handed over on 30 March, and the person
 * pressing the button is usually thinking in calendar months.
 */
function financialYear(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return "—";
  const start = m >= 4 ? y : y - 1;
  return `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function RecordPossession({
  bookingId,
  reference,
  advanceMinor,
  collectedMinor,
}: {
  bookingId: string;
  reference: string;
  advanceMinor: string;
  collectedMinor: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");

  const outstanding = BigInt(advanceMinor) - BigInt(collectedMinor);

  function submit() {
    setError(null);
    start(async () => {
      const res = await recordPossession({
        bookingId,
        possessionDate: date,
        ...(note.trim() ? { note: note.trim() } : {}),
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
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Record possession
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border p-4 text-sm">
      <p className="font-medium">Hand over {reference}</p>

      <div className="space-y-1">
        <label htmlFor={`pd-${bookingId}`} className="text-xs font-medium">
          Possession date
        </label>
        <Input
          id={`pd-${bookingId}`}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-48 tabular-nums"
        />
        {date && (
          <p className="text-xs text-muted-foreground">
            {/* The date decides which year the turnover is taxed in. */}
            Revenue lands in <span className="font-medium">{financialYear(date)}</span>.
          </p>
        )}
      </div>

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Keys handed over at site office, snag list signed."
        rows={2}
      />

      <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-3">
        <p className="font-medium">
          This recognises {inr(advanceMinor)} as turnover
          {date ? ` in ${financialYear(date)}` : ""}.
        </p>
        <p className="mt-1 text-muted-foreground">
          It moves the whole advance into revenue and cannot be undone from this
          screen — correcting it later means a journal somebody has to explain.
        </p>
        {outstanding > 0n && (
          <p className="mt-1 font-medium">
            {/**
             * ⚠️ SHOWN, AND IT DOES NOT BLOCK. Control has transferred;
             * the revenue is earned in full even if the last instalment
             * has not arrived. But handing over keys to somebody who
             * still owes money is a decision, not an oversight.
             */}
            ⚠️ {inr(String(outstanding))} is still uncollected on this booking. The
            revenue is recognised in full regardless — that is correct, and worth
            knowing before you hand over the keys.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button type="button" onClick={submit} disabled={pending || date === ""}>
          {pending ? "Recording…" : "Record possession"}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
          Not yet
        </Button>
      </div>

      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
