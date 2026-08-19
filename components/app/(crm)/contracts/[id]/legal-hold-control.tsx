"use client";

/**
 * Ordence — ⭐⭐ THE LEGAL HOLD CONTROL
 * Version: v1.77.0-alpha · Wave 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS A FORM WITH A REQUIRED SENTENCE AND NOT A TOGGLE
 * ══════════════════════════════════════════════════════════════════════
 * A switch labelled "Legal hold" would be one mis-click away from
 * releasing evidence in a live matter, and it would record nothing about
 * why. Both directions therefore ask for a written reason before the
 * button does anything, and the server refuses anything under ten
 * characters — see `server/actions/legal-hold.ts`.
 *
 * ⚠️ THE LIFT IS PRESENTED AS THE HEAVIER OF THE TWO, which is the
 * opposite of the usual "destructive action is the red one" convention
 * and is correct here. Placing a hold is conservative: it makes the
 * product do less and nothing is lost. Lifting one re-exposes a record to
 * editing and to the retention purge while a dispute may still be open.
 */

import { useState, useTransition } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";

type Result = { ok: true } | { ok: false; error: string };

export function LegalHoldControl(props: {
  contractId: string;
  legalHold: boolean;
  legalHoldReason: string | null;
  place: (input: { contractId: string; reason: string }) => Promise<Result>;
  lift: (input: { contractId: string; reason: string }) => Promise<Result>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const held = props.legalHold;

  function submit() {
    setError(null);
    const trimmed = reason.trim();

    /**
     * ⚠️ CHECKED HERE AND ON THE SERVER. This one is a courtesy so the
     * person is not told after a round trip; the server's is the
     * enforcement, because a client check is a suggestion.
     */
    if (trimmed.length < 10) {
      setError("Write at least a sentence. This is the record of why the hold changed.");
      return;
    }

    startTransition(async () => {
      const action = held ? props.lift : props.place;
      const result = await action({ contractId: props.contractId, reason: trimmed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReason("");
    });
  }

  return (
    <section
      aria-labelledby="legal-hold-heading"
      className="space-y-3 rounded-md border border-border p-4"
    >
      <h2 id="legal-hold-heading" className="flex items-center gap-2 text-lg font-semibold">
        {held ? (
          <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden="true" />
        ) : (
          <ShieldCheck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        )}
        Legal hold
      </h2>

      <p className="text-sm text-muted-foreground">
        {held ? (
          <>
            This contract is frozen. Documents cannot be added or removed, no client link can be
            issued, no signature can be taken, and the retention schedule will not delete it.
          </>
        ) : (
          <>
            Placing a hold freezes this contract and everything attached to it, and stops the
            retention schedule from ever deleting it. Use it when a dispute is anticipated.
          </>
        )}
      </p>

      {held && props.legalHoldReason && (
        <p className="rounded border border-border bg-muted/40 p-3 text-sm">
          <span className="font-medium">On record: </span>
          {props.legalHoldReason}
        </p>
      )}

      <div className="space-y-2">
        <label htmlFor="legal-hold-reason" className="block text-sm font-medium">
          {held ? "Why is the hold being lifted?" : "Why is a hold being placed?"}
        </label>
        <textarea
          id="legal-hold-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={2000}
          disabled={pending}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          placeholder={
            held
              ? "The matter closed on 3 August; counsel has confirmed the hold may be released."
              : "Notice of dispute received from the counterparty on 1 August."
          }
        />
        <p className="text-xs text-muted-foreground">
          This sentence is written into the audit trail with the person and the time. It is what
          gets produced if the decision is ever questioned.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className={
          held
            ? "inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-60"
            : "inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        }
      >
        {pending ? "Recording…" : held ? "Lift the hold" : "Place a hold"}
      </button>
    </section>
  );
}
