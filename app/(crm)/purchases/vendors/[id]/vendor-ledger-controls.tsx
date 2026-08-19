"use client";

/**
 * Ordence — ⭐⭐⭐ VENDOR LEDGER ENTRIES, MSME EXPOSURE, AND BLOCKING
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MSME CHECK IS THE REASON THIS COMPONENT EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `getMsmeExposure` answers one question: if this invoice was accepted on
 * date A and is paid on date B, does Section 43B(h) disallow the
 * deduction? The answer moves a whole year's expense into the next year's
 * books, and it is normally discovered by the CA at assessment, when
 * nothing can be done about it.
 *
 * ⚠️ IT IS A CALCULATOR, NOT A REPORT, AND THAT IS DELIBERATE. The
 * question is asked about a SPECIFIC invoice with a SPECIFIC acceptance
 * date, and the acceptance date is not the invoice date , it is the date
 * the goods or services were accepted, which is the date the 15 or 45 day
 * clock starts from. No stored field is reliably that date, so the person
 * who knows types it in.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AN ENTRY IS A DEBIT OR A CREDIT AND NEVER BOTH
 * ══════════════════════════════════════════════════════════════════════
 * `addVendorLedgerEntrySchema` refuses an entry where both are zero or
 * both are positive. The form enforces the same rule by asking for a
 * direction first and one amount second, so the impossible combination is
 * not reachable rather than being refused after the fact.
 */

import { useState, useTransition } from "react";
import { CalendarClock, Ban, Plus } from "lucide-react";

/**
 * ⚠️ THE ONLY ACTION THIS FILE IMPORTS RATHER THAN RECEIVING AS A PROP,
 * and the exception is deliberate. Every WRITE on this page is passed
 * down from the server component, which is the convention that keeps
 * `server/actions/*` out of the client module graph.
 *
 * `getMsmeExposure` is a pure question with no side effect, asked
 * repeatedly as somebody tries different dates, and threading it through
 * two component boundaries to reach the calculator that is its only
 * caller would be ceremony. `components/gst/itc-reversal-working.tsx`
 * does the same thing for the same reason.
 */
import { getMsmeExposure } from "@/server/actions/purchases";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const ENTRY_TYPES = [
  { value: "purchase_invoice", label: "Purchase invoice", direction: "credit" },
  { value: "debit_note", label: "Debit note", direction: "debit" },
  { value: "credit_note", label: "Credit note", direction: "credit" },
  { value: "payment", label: "Payment made", direction: "debit" },
  { value: "advance", label: "Advance paid", direction: "debit" },
  { value: "tds_deducted", label: "TDS deducted", direction: "debit" },
  { value: "retention_held", label: "Retention held", direction: "debit" },
  { value: "retention_released", label: "Retention released", direction: "credit" },
  { value: "adjustment", label: "Adjustment", direction: "debit" },
] as const;

export function VendorLedgerControls(props: {
  vendorId: string;
  vendorName: string;
  isActive: boolean;
  msmeRegistered: boolean;
  paymentTermsDays: number;
  asOf: string;
  canRecord: boolean;
  canManage: boolean;
  addEntry: (input: unknown) => Promise<Result<{ id: string }>>;
  setActive: (input: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /* ---- ledger entry --------------------------------------------- */
  const [showEntry, setShowEntry] = useState(false);
  const [entryType, setEntryType] = useState<string>("payment");
  const [entryDate, setEntryDate] = useState(props.asOf);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [excludeFromAgeing, setExcludeFromAgeing] = useState(false);

  const direction =
    ENTRY_TYPES.find((t) => t.value === entryType)?.direction ?? "debit";

  /* ---- block ----------------------------------------------------- */
  const [blockReason, setBlockReason] = useState("");

  function addEntry() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.addEntry({
        vendorId: props.vendorId,
        entryDate,
        entryType,
        referenceNumber: reference.trim() === "" ? null : reference.trim(),
        description: description.trim() === "" ? null : description.trim(),
        // Exactly one of the two carries the amount. See the header.
        debit: direction === "debit" ? amount : "0",
        credit: direction === "credit" ? amount : "0",
        dueDate: dueDate === "" ? null : dueDate,
        excludeFromAgeing,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Entry recorded.");
      setAmount("");
      setReference("");
      setDescription("");
      setShowEntry(false);
    });
  }

  function toggleActive() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.setActive({
        id: props.vendorId,
        isActive: !props.isActive,
        blockedReason: blockReason.trim() === "" ? null : blockReason.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(
        props.isActive
          ? "Vendor blocked. New invoices against them will be refused."
          : "Vendor unblocked.",
      );
    });
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      {/* ── MSME ──────────────────────────────────────────────────── */}
      <MsmeCalculator
        vendorId={props.vendorId}
        registered={props.msmeRegistered}
        paymentTermsDays={props.paymentTermsDays}
        asOf={props.asOf}
      />

      {/* ── LEDGER ENTRY ──────────────────────────────────────────── */}
      {props.canRecord && (
        <section className="space-y-3 rounded-md border border-border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Plus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Record against this vendor
          </h2>

          {!showEntry ? (
            <button
              type="button"
              onClick={() => setShowEntry(true)}
              className="text-sm underline underline-offset-2"
            >
              Add a payment, a retention or an adjustment
            </button>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span className="font-medium">What</span>
                  <select
                    value={entryType}
                    onChange={(e) => setEntryType(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {ENTRY_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                  <span className="block text-xs text-muted-foreground">
                    {direction === "debit"
                      ? "Reduces what we owe them."
                      : "Increases what we owe them."}
                  </span>
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Date</span>
                  <input
                    type="date"
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Amount (₹)</span>
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Reference</span>
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Due date</span>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Note</span>
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={excludeFromAgeing}
                  onChange={(e) => setExcludeFromAgeing(e.target.checked)}
                />
                <span>
                  <span className="block">Leave this out of the ageing</span>
                  <span className="block text-xs text-muted-foreground">
                    For retention held under a contract: a real liability that is deliberately
                    not chased, and counting it as overdue would overstate what is late.
                  </span>
                </span>
              </label>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={addEntry}
                  disabled={pending || amount.trim() === "" || Number(amount) <= 0}
                  className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
                >
                  {pending ? "Recording…" : "Record it"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowEntry(false)}
                  className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {/* ── BLOCK ─────────────────────────────────────────────────── */}
      {props.canManage && (
        <section className="space-y-2 rounded-md border border-border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Ban className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            {props.isActive ? "Stop using this vendor" : "Start using them again"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Blocking refuses new invoices against them. It does not touch what is already
            owed, and it does not delete anything.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {props.isActive && (
              <input
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder="Why"
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            )}
            <button
              type="button"
              onClick={toggleActive}
              disabled={pending}
              className="rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
            >
              {props.isActive ? "Block them" : "Unblock them"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SECTION 43B(h)                                                      */
/* ------------------------------------------------------------------ */

function MsmeCalculator(props: {
  vendorId: string;
  registered: boolean;
  paymentTermsDays: number;
  asOf: string;
}) {
  const [acceptedOn, setAcceptedOn] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [result, setResult] = useState<{
    applies: boolean;
    effectiveTermDays: number;
    dueDate: string;
    daysOverdue: number;
    disallowanceRisk: boolean;
    message: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function check() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const response = await getMsmeExposure({
        vendorId: props.vendorId,
        acceptedOn,
        asOf: props.asOf,
        paidOn: paidOn === "" ? null : paidOn,
      });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setResult(response.data);
    });
  }

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Section 43B(h) , is a payment late enough to lose the deduction?
      </h2>

      {!props.registered ? (
        <p className="text-sm text-muted-foreground">
          This vendor is not recorded as a registered micro or small enterprise, so 43B(h)
          does not apply to them. Their payment terms are {props.paymentTermsDays} days.
          {/*
            ⚠️ SAID PLAINLY RATHER THAN HIDDEN. "Not applicable" is only
            true if the MSME flag is right, and the flag is right only if
            somebody entered the Udyam number. Showing the check greyed
            out with the reason is what prompts that.
          */}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            The clock starts when the goods or services were <strong>accepted</strong>, which
            is not the invoice date. Paying late does not attract interest here , it moves
            the whole expense into the year of payment.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Accepted on</span>
              <input
                type="date"
                value={acceptedOn}
                onChange={(e) => setAcceptedOn(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Paid on</span>
              <input
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <span className="block text-xs text-muted-foreground">
                Leave empty to ask &ldquo;where does it stand today?&rdquo;
              </span>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={check}
                disabled={pending || acceptedOn === ""}
                className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
              >
                {pending ? "Checking…" : "Check it"}
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {result && (
            <div
              className={
                result.disallowanceRisk
                  ? "space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
                  : "space-y-1 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/30"
              }
            >
              <p className="font-medium">{result.message}</p>
              <p className="text-xs text-muted-foreground">
                Term {result.effectiveTermDays} days · due {result.dueDate}
                {result.daysOverdue > 0 ? ` · ${result.daysOverdue} days over` : ""}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
