"use client";

/**
 * Ordence — ⭐⭐ CANCELLING A BOOKING
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS THE HEAVIEST BUTTON ON THE PAGE AND IT SITS LAST
 * ══════════════════════════════════════════════════════════════════════
 * Cancelling frees the unit back onto the market, forfeits or refunds
 * money, and , if the booking reached agreement , starts a credit-note
 * window that closes. `cancelBooking` demands a written reason for
 * exactly that reason, and the field says why rather than being a
 * required-field asterisk.
 *
 * ⚠️ FORFEIT AND REFUND ARE BOTH OPTIONAL AND NEITHER DEFAULTS. A
 * pre-filled forfeiture figure is a suggestion the software has no
 * standing to make: what may be retained depends on the agreement, on
 * how far the build has progressed, and on a body of consumer-forum
 * decisions that a text input cannot summarise. The server records
 * whatever is entered and flags what looks unreasonable; it does not
 * choose.
 *
 * ⚠️ THE POSTING IS A SEPARATE STEP. This records the cancellation.
 * `previewCancellationPosting` and `postBookingCancellation` , on the
 * cancellations screen , are what move it through the ledger, and they
 * are deliberately not on this button.
 */

import { useState, useTransition } from "react";
import { XCircle } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function BookingCancellation(props: {
  bookingId: string;
  cancel: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [forfeit, setForfeit] = useState("");
  const [refund, setRefund] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await props.cancel({
        id: props.bookingId,
        reason: reason.trim(),
        forfeitAmount: forfeit.trim() === "" ? undefined : forfeit.trim(),
        refundAmount: refund.trim() === "" ? undefined : refund.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setReason("");
    });
  }

  if (!open) {
    return (
      <section className="rounded-md border border-border p-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 text-sm text-destructive underline underline-offset-2"
        >
          <XCircle className="h-4 w-4" aria-hidden="true" />
          Cancel this booking
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-md border border-destructive/40 p-4">
      <h2 className="text-lg font-semibold text-destructive">Cancel this booking</h2>
      <p className="text-sm text-muted-foreground">
        The unit goes back on the market immediately. Money already received does not move on
        its own , what is forfeited and what is refunded is recorded here and posted
        separately from the cancellations screen.
      </p>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Why</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          placeholder="Buyer withdrew after their home loan was declined on 3 August."
        />
        <span className="block text-xs text-muted-foreground">
          This frees a unit and moves money. The sentence is the record of why.
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Forfeited (₹)</span>
          <input
            value={forfeit}
            onChange={(e) => setForfeit(e.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Refunded (₹)</span>
          <input
            value={refund}
            onChange={(e) => setRefund(e.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || reason.trim().length === 0}
          className="rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-60"
        >
          {pending ? "Cancelling…" : "Cancel the booking"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
        >
          Keep it
        </button>
      </div>
    </section>
  );
}
