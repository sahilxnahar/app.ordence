"use client";

/**
 * Ordence — ⭐ MOVING A BOOKING THROUGH ITS STAGES
 * Version: v1.78.0-alpha · Wave 10
 *
 * ⚠️ THE STAGES ARE NOT A STATUS FIELD, THEY ARE A LEGAL SEQUENCE.
 * Tentative is a soft hold. Confirmed means money has moved. Agreement
 * means a document has been executed. Registered means it has been
 * stamped and entered at the sub-registrar, which is the point after
 * which unwinding it costs the buyer real money.
 *
 * ⚠️ ONLY FORWARD, AND ONE STEP AT A TIME. `advanceBooking` accepts any
 * of the four, and the server is what enforces the sequence; this offers
 * the next one only, because a dropdown containing "tentative" beside a
 * registered booking invites somebody to try.
 */

import { useState, useTransition } from "react";
import { ChevronRight } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const ORDER = ["tentative", "confirmed", "agreement", "registered"] as const;

const LABELS: Record<string, string> = {
  tentative: "Tentative",
  confirmed: "Confirmed",
  agreement: "Agreement executed",
  registered: "Registered",
};

const MEANING: Record<string, string> = {
  confirmed: "Money has been received against this booking.",
  agreement: "The agreement to sell has been signed by both sides.",
  registered: "Registered at the sub-registrar. Unwinding it after this costs the buyer.",
};

export function BookingStageControl(props: {
  bookingId: string;
  status: string;
  advance: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const index = ORDER.indexOf(props.status as (typeof ORDER)[number]);
  const next = index >= 0 && index < ORDER.length - 1 ? ORDER[index + 1] : null;

  if (!next) return null;

  function move() {
    setError(null);
    startTransition(async () => {
      const result = await props.advance({ id: props.bookingId, status: next });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section className="space-y-2 rounded-md border border-border p-4">
      <p className="text-sm">
        <span className="font-medium">{LABELS[props.status] ?? props.status}</span> today.
      </p>
      <p className="text-sm text-muted-foreground">{MEANING[next]}</p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={move}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Recording…" : `Move to ${LABELS[next]}`}
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
