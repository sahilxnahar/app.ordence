"use client";

/**
 * Ordence — ⭐ MOVING A PURCHASE INVOICE THROUGH ITS STATUSES
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE STATUSES ARE NOT DECORATION , `approved` IS AN AUTHORISATION
 * ══════════════════════════════════════════════════════════════════════
 *   draft      recorded but not yet checked against the goods received
 *   recorded   checked, and in the books
 *   approved   authorised for payment. This is the one that lets money
 *              leave, so it is a deliberate act rather than a side effect
 *              of recording.
 *   paid       settled
 *   cancelled  withdrawn, with a reason
 *
 * `setPurchaseInvoiceStatus` was built and had no caller: every invoice
 * stayed at whatever status it was recorded with, forever.
 *
 * ⚠️ CANCELLING DEMANDS A REASON IN THE UI EVEN THOUGH THE SCHEMA MAKES
 * IT OPTIONAL. An invoice cancelled with no explanation is the row the
 * auditor asks about, and the person who cancelled it will not remember.
 */

import { useState, useTransition } from "react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const STATUSES = ["draft", "recorded", "approved", "paid", "cancelled"] as const;

export function InvoiceStatusControl(props: {
  invoiceId: string;
  status: string;
  setStatus: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(props.status);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const needsReason = status === "cancelled";

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await props.setStatus({
        id: props.invoiceId,
        status,
        reason: reason.trim() === "" ? null : reason.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs underline underline-offset-2"
      >
        {props.status}
      </button>
    );
  }

  return (
    <div className="space-y-1.5">
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      >
        {STATUSES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>

      {needsReason && (
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is it cancelled?"
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || (needsReason && reason.trim() === "")}
          className="rounded border border-input px-2 py-1 text-xs disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs underline underline-offset-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
