"use client";

/**
 * Ordence — ⭐⭐⭐ CREDIT TERMS, HOLDS, OVERRIDES AND APPROVAL LIMITS
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NINE ACTIONS AND A BOARD THAT COULD ONLY WATCH
 * ══════════════════════════════════════════════════════════════════════
 * `/receivables/credit` showed every customer's exposure, headroom and
 * hold state, and could change none of it. Setting a limit, placing a
 * hold, releasing one, overriding one for a single order, and capping
 * what each role may approve , all built, all guarded, all reachable from
 * nowhere.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO WAYS TO PLACE A HOLD, AND THEY ARE NOT THE SAME THING
 * ══════════════════════════════════════════════════════════════════════
 *   setCreditHold     sets the flag ON THE COMPANY. A manual hold. It
 *                     stays until somebody clears it.
 *   placeCreditHold   creates a HOLD RECORD with a reason from a closed
 *                     set. That is what the automatic sweep raises, and
 *                     `releaseCreditHold` takes a hold id rather than a
 *                     company id because a company can have had several
 *                     over time and the audit trail is per hold.
 *
 * A screen that offered one button for both would make "release" ambiguous
 * on a company carrying a manual flag and an automatic record at once.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE OVERRIDE IS THE MOST SERIOUS CONTROL HERE
 * ══════════════════════════════════════════════════════════════════════
 * `recordCreditHoldOverride` lets ONE order go out to a customer who is
 * on hold. Its own validator demands eight characters of reason with the
 * sentence: "It will be read back if the debt goes bad." That is exactly
 * right, and the form repeats it rather than showing a required-field
 * asterisk.
 */

import { useState, useTransition } from "react";
import { CircleSlash, Gauge, ShieldOff, Unlock } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type CreditRow = {
  companyId: string;
  companyName: string;
  onHold: boolean;
  holdId: string | null;
  holdSource: "manual" | "automatic" | null;
};

const HOLD_REASONS = [
  { value: "over_limit", label: "Over their credit limit" },
  { value: "overdue", label: "Overdue invoices" },
  { value: "manual", label: "A decision somebody took" },
  { value: "dispute", label: "A dispute" },
] as const;

const APPROVAL_SCOPES = [
  { value: "sales_order", label: "A sales order" },
  { value: "discount_pct", label: "A discount percentage" },
  { value: "purchase_order", label: "A purchase order" },
  { value: "write_off", label: "A write-off" },
  { value: "credit_note", label: "One credit note" },
  { value: "credit_note_daily", label: "Credit notes in one day" },
] as const;

export function CreditControls(props: {
  rows: readonly CreditRow[];
  roles: readonly string[];
  canManageCredit: boolean;
  canApproveOrderCredit: boolean;
  canManageRoles: boolean;
  getPosition: (
    input: unknown,
  ) => Promise<
    Result<{
      companyId: string;
      creditLimitMinor: string | null;
      paymentTermsDays: number | null;
      onHold: boolean;
      holdReason: string | null;
      exposureMinor: string;
      headroomMinor: string | null;
      contributingOrders: number;
      message: string;
    }>
  >;
  setTerms: (input: unknown) => Promise<Result<{ companyId: string }>>;
  setHold: (input: unknown) => Promise<Result<{ companyId: string; onHold: boolean }>>;
  placeHold: (
    input: unknown,
  ) => Promise<Result<{ companyId: string; alreadyHeld: boolean }>>;
  releaseHold: (input: unknown) => Promise<Result<{ holdId: string; released: boolean }>>;
  recordOverride: (
    input: unknown,
  ) => Promise<Result<{ orderId: string; overrideId: string }>>;
  setApprovalLimit: (input: unknown) => Promise<Result<{ role: string; scope: string }>>;
  removeApprovalLimit: (input: unknown) => Promise<Result<{ role: string; scope: string }>>;
  runSweep: (
    input: unknown,
  ) => Promise<
    Result<{
      asOf: string;
      queued: number;
      suppressed: number;
      holdsPlaced: number;
      skipped: { invoiceNumber: string; why: string }[];
    }>
  >;
}) {
  const [companyId, setCompanyId] = useState(props.rows[0]?.companyId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = props.rows.find((row) => row.companyId === companyId) ?? null;

  /* ---- position --------------------------------------------------- */
  const [position, setPosition] = useState<{ message: string } | null>(null);

  /* ---- terms ------------------------------------------------------ */
  const [limitRupees, setLimitRupees] = useState("");
  const [termsDays, setTermsDays] = useState("");
  const [termsNote, setTermsNote] = useState("");

  /* ---- hold ------------------------------------------------------- */
  const [holdReason, setHoldReason] = useState("");
  const [structuredReason, setStructuredReason] = useState<string>("overdue");

  /* ---- override --------------------------------------------------- */
  const [orderId, setOrderId] = useState("");
  const [overrideReason, setOverrideReason] = useState("");

  /* ---- approval limits --------------------------------------------- */
  const [role, setRole] = useState(props.roles[0] ?? "");
  const [scope, setScope] = useState<string>("sales_order");
  const [maxRupees, setMaxRupees] = useState("");

  /* ---- sweep ------------------------------------------------------- */
  const [sweepPreview, setSweepPreview] = useState(true);

  function run<T>(fn: () => Promise<Result<T>>, onOk: (data: T) => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOk(result.data);
    });
  }

  /** Rupees to paise, without a float in the middle. */
  function paise(rupees: string): string | null {
    if (rupees.trim() === "") return null;
    const [whole = "0", frac = ""] = rupees.trim().split(".");
    return `${whole}${(frac + "00").slice(0, 2)}`.replace(/^(-?)0+(?=\d)/, "$1");
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/30">
          {notice}
        </p>
      )}

      {/* ── PICK A CUSTOMER ───────────────────────────────────────── */}
      {props.rows.length > 0 && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Work on one customer</h2>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="font-medium">Customer</span>
              <select
                value={companyId}
                onChange={(e) => {
                  setCompanyId(e.target.value);
                  setPosition(null);
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {props.rows.map((row) => (
                  <option key={row.companyId} value={row.companyId}>
                    {row.companyName}
                    {row.onHold ? ` , on hold (${row.holdSource ?? "manual"})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={pending || companyId === ""}
                onClick={() =>
                  run(
                    () => props.getPosition({ companyId }),
                    (data) => setPosition({ message: data.message }),
                  )
                }
                className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
              >
                Where do they stand?
              </button>
            </div>
          </div>

          {/*
            ⭐ `message` IS A SENTENCE THE ENGINE WROTE, and it is shown
            verbatim. It already names the exposure, the headroom and how
            many orders contribute; re-deriving that here would be a
            second opinion that can disagree with the first.
          */}
          {position && <p className="rounded-md border bg-muted/30 p-3 text-sm">{position.message}</p>}
        </section>
      )}

      {/* ── TERMS ─────────────────────────────────────────────────── */}
      {props.canManageCredit && chosen && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Credit terms for {chosen.companyName}
          </h2>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Credit limit (₹)</span>
              <input
                value={limitRupees}
                onChange={(e) => setLimitRupees(e.target.value)}
                inputMode="decimal"
                placeholder="Empty for no limit"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Payment terms (days)</span>
              <input
                type="number"
                min={0}
                max={3650}
                value={termsDays}
                onChange={(e) => setTermsDays(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Note</span>
              <input
                value={termsNote}
                onChange={(e) => setTermsNote(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  props.setTerms({
                    companyId,
                    creditLimitMinor: paise(limitRupees),
                    paymentTermsDays: termsDays.trim() === "" ? null : Number(termsDays),
                    note: termsNote.trim() === "" ? null : termsNote.trim(),
                  }),
                () => setNotice("Terms saved."),
              )
            }
            className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save the terms"}
          </button>
        </section>
      )}

      {/* ── HOLDS ─────────────────────────────────────────────────── */}
      {props.canManageCredit && chosen && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Holds
          </h2>

          <div className="space-y-2">
            <p className="text-sm font-medium">A decision somebody took</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                placeholder="Whoever takes the customer's call will need this"
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <button
                type="button"
                disabled={pending || (!chosen.onHold && holdReason.trim().length < 4)}
                onClick={() =>
                  run(
                    () =>
                      props.setHold(
                        chosen.onHold
                          ? { companyId, onHold: false, reason: holdReason.trim() || undefined }
                          : { companyId, onHold: true, reason: holdReason.trim() },
                      ),
                    (data) =>
                      setNotice(data.onHold ? "Account put on hold." : "Hold cleared."),
                  )
                }
                className="rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
              >
                {chosen.onHold ? "Take them off hold" : "Put them on hold"}
              </button>
            </div>
          </div>

          <div className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium">A hold with a recorded cause</p>
            <p className="text-xs text-muted-foreground">
              This is the shape the automatic sweep raises. It creates a hold record that can
              be released on its own, so a company that has been held twice keeps both stories.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={structuredReason}
                onChange={(e) => setStructuredReason(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {HOLD_REASONS.map((reason) => (
                  <option key={reason.value} value={reason.value}>
                    {reason.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () => props.placeHold({ companyId, reason: structuredReason }),
                    (data) =>
                      setNotice(
                        data.alreadyHeld
                          ? "They were already held , nothing changed."
                          : "Hold recorded.",
                      ),
                  )
                }
                className="rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
              >
                Record a hold
              </button>

              {chosen.holdId && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () =>
                        props.releaseHold({
                          holdId: chosen.holdId,
                          reason: holdReason.trim() || undefined,
                        }),
                      (data) =>
                        setNotice(
                          data.released ? "Hold released." : "That hold was already released.",
                        ),
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
                >
                  <Unlock className="h-4 w-4" aria-hidden="true" />
                  Release this hold
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── OVERRIDE ──────────────────────────────────────────────── */}
      {props.canApproveOrderCredit && (
        <section className="space-y-3 rounded-lg border border-amber-300 p-4 dark:border-amber-800">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <CircleSlash className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
            Let one order through anyway
          </h2>
          <p className="text-sm text-muted-foreground">
            This releases a single order to a customer who is on hold. The hold stays. The
            reason is read back if the debt goes bad.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Order</span>
              <input
                value={orderId}
                onChange={(e) => setOrderId(e.target.value.trim())}
                placeholder="The order's id"
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="font-medium">Why</span>
              <input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>

          <button
            type="button"
            disabled={pending || orderId === "" || overrideReason.trim().length < 8}
            onClick={() =>
              run(
                () => props.recordOverride({ orderId, reason: overrideReason.trim() }),
                () => {
                  setNotice("Override recorded against the order.");
                  setOrderId("");
                  setOverrideReason("");
                },
              )
            }
            className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? "Recording…" : "Record the override"}
          </button>
        </section>
      )}

      {/* ── APPROVAL LIMITS ───────────────────────────────────────── */}
      {props.canManageRoles && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">What each role may approve</h2>
          <p className="text-sm text-muted-foreground">
            No row means no authority for that scope , except the two credit-note scopes,
            which fall back to a stated default rather than to zero or to unlimited.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Role</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {props.roles.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Scope</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {APPROVAL_SCOPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Ceiling (₹)</span>
              <input
                value={maxRupees}
                onChange={(e) => setMaxRupees(e.target.value)}
                inputMode="decimal"
                placeholder="Empty for unlimited"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending || role === ""}
              onClick={() =>
                run(
                  () =>
                    props.setApprovalLimit({
                      role,
                      scope,
                      maxValueMinor: paise(maxRupees),
                    }),
                  (data) => setNotice(`Limit set for ${data.role} on ${data.scope}.`),
                )
              }
              className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
            >
              Set the limit
            </button>
            <button
              type="button"
              disabled={pending || role === ""}
              onClick={() =>
                run(
                  () => props.removeApprovalLimit({ role, scope }),
                  (data) =>
                    setNotice(
                      `Limit removed for ${data.role} on ${data.scope}. They now have no authority for it.`,
                    ),
                )
              }
              className="rounded-md border border-input px-3 py-2 text-sm disabled:opacity-60"
            >
              Remove it
            </button>
          </div>
        </section>
      )}

      {/* ── THE SWEEP ─────────────────────────────────────────────── */}
      {props.canManageCredit && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Run the dunning sweep</h2>
          <p className="text-sm text-muted-foreground">
            Queues the reminders that are due today and places automatic holds where the
            ladder says so.
          </p>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={sweepPreview}
              onChange={(e) => setSweepPreview(e.target.checked)}
            />
            <span>
              <span className="block">Preview only</span>
              <span className="block text-xs text-muted-foreground">
                Reports what it would do without queueing a letter or placing a hold. Leave
                this on the first time.
              </span>
            </span>
          </label>

          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                () => props.runSweep({ preview: sweepPreview }),
                (data) =>
                  setNotice(
                    `${sweepPreview ? "Would queue" : "Queued"} ${data.queued}, suppressed ${
                      data.suppressed
                    }, ${sweepPreview ? "would place" : "placed"} ${data.holdsPlaced} hold${
                      data.holdsPlaced === 1 ? "" : "s"
                    }${
                      data.skipped.length > 0
                        ? `. Skipped: ${data.skipped
                            .slice(0, 5)
                            .map((s) => `${s.invoiceNumber} (${s.why})`)
                            .join(", ")}`
                        : ""
                    }.`,
                  ),
              )
            }
            className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? "Running…" : sweepPreview ? "Preview the sweep" : "Run the sweep"}
          </button>
        </section>
      )}
    </div>
  );
}
