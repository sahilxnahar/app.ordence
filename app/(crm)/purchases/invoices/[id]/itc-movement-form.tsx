"use client";

/**
 * Ordence — ⭐⭐ RECORDING AN ITC MOVEMENT
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE REASON IS A CLOSED SET AND THAT IS THE WHOLE VALUE OF THIS FORM
 * ══════════════════════════════════════════════════════════════════════
 * A reversal recorded as "adjustment" is a reversal nobody can defend in
 * an assessment. Every reason in the list below is a specific provision:
 *
 *   rule_37_non_payment_180_days   the supplier was not paid within 180
 *                                  days, so the credit reverses and can
 *                                  be reclaimed when they are paid
 *   rule_42_common_reversal        the proportion attributable to exempt
 *                                  supply
 *   rule_43_capital_reversal       the same, for capital goods, over 60
 *                                  months
 *   supplier_not_filed             it is not in our 2B because they have
 *                                  not filed their 1
 *   credit_note_received          they issued a credit note
 *
 * ⚠️ THE FOUR TAX HEADS ARE SEPARATE FIELDS AND NOT ONE TOTAL. A reversal
 * has to be apportioned across CGST, SGST, IGST and cess exactly as the
 * original claim was, because that is how it appears in the 3B. One
 * figure split by the software would be a guess.
 */

import { useState, useTransition } from "react";
import { Undo2 } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const STATUSES = [
  { value: "claimed", label: "Claimed" },
  { value: "blocked", label: "Blocked" },
  { value: "deferred", label: "Deferred" },
  { value: "reversed", label: "Reversed" },
] as const;

const REASONS = [
  { value: "invoice_claim", label: "Claimed against the invoice" },
  { value: "rcm_self_assessed", label: "Reverse charge, self-assessed" },
  { value: "section_17_5_blocked", label: "Blocked by Section 17(5)" },
  { value: "rule_42_common_reversal", label: "Rule 42 , common credit" },
  { value: "rule_43_capital_reversal", label: "Rule 43 , capital goods" },
  { value: "rule_37_non_payment_180_days", label: "Rule 37 , unpaid 180 days" },
  { value: "credit_note_received", label: "Credit note received" },
  { value: "goods_not_received", label: "Goods not received" },
  { value: "supplier_not_filed", label: "Supplier has not filed" },
  { value: "reclaim_after_payment", label: "Reclaimed after payment" },
  { value: "annual_true_up", label: "Annual true-up" },
] as const;

export function ItcMovementForm(props: {
  invoiceId: string;
  vendorId: string;
  taxPeriod: string | null;
  lines: readonly { id: string; label: string }[];
  registrations: readonly { id: string; label: string }[];
  record: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [open, setOpen] = useState(false);
  const [taxPeriod, setTaxPeriod] = useState(props.taxPeriod ?? "");
  const [registrationId, setRegistrationId] = useState("");
  const [lineId, setLineId] = useState("");
  const [status, setStatus] = useState<string>("reversed");
  const [reason, setReason] = useState<string>("rule_37_non_payment_180_days");
  const [statutoryRef, setStatutoryRef] = useState("");
  const [note, setNote] = useState("");
  const [cgst, setCgst] = useState("0");
  const [sgst, setSgst] = useState("0");
  const [igst, setIgst] = useState("0");
  const [cess, setCess] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const nothingEntered =
    Number(cgst) <= 0 && Number(sgst) <= 0 && Number(igst) <= 0 && Number(cess) <= 0;

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.record({
        taxPeriod,
        registrationId: registrationId === "" ? null : registrationId,
        purchaseInvoiceId: props.invoiceId,
        purchaseInvoiceLineId: lineId === "" ? null : lineId,
        vendorId: props.vendorId,
        status,
        reason,
        statutoryRef: statutoryRef.trim() === "" ? null : statutoryRef.trim(),
        note: note.trim() === "" ? null : note.trim(),
        cgst,
        sgst,
        igst,
        cess,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Movement recorded against the register.");
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <section className="rounded-md border border-border p-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 text-sm underline underline-offset-2"
        >
          <Undo2 className="h-4 w-4" aria-hidden="true" />
          Record an ITC movement against this invoice
        </button>
        {notice && (
          <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <h2 className="text-sm font-semibold">Record an ITC movement</h2>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Tax period</span>
          <input
            value={taxPeriod}
            onChange={(e) => setTaxPeriod(e.target.value)}
            placeholder="2026-07"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          />
          <span className="block text-xs text-muted-foreground">
            The period the movement belongs in, which is not always the invoice&rsquo;s.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Registration</span>
          <select
            value={registrationId}
            onChange={(e) => setRegistrationId(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Not specified</option>
            {props.registrations.map((registration) => (
              <option key={registration.id} value={registration.id}>
                {registration.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Line</span>
          <select
            value={lineId}
            onChange={(e) => setLineId(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">The whole invoice</option>
            {props.lines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {STATUSES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Reason</span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {REASONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["CGST", cgst, setCgst],
          ["SGST", sgst, setSgst],
          ["IGST", igst, setIgst],
          ["Cess", cess, setCess],
        ].map(([label, value, setter]) => (
          <label key={label as string} className="space-y-1 text-sm">
            <span className="font-medium">{label as string} (₹)</span>
            <input
              value={value as string}
              onChange={(e) => (setter as (v: string) => void)(e.target.value)}
              inputMode="decimal"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Apportion it across the heads exactly as the original claim was. That is how it
        appears in the 3B, and a single figure split by software would be a guess.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Statutory reference</span>
          <input
            value={statutoryRef}
            onChange={(e) => setStatutoryRef(e.target.value)}
            placeholder="Rule 37(1)"
            maxLength={24}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Note</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
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
          disabled={pending || taxPeriod.trim() === "" || nothingEntered}
          className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Recording…" : "Record it"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
