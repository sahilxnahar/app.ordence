"use client";

/**
 * Ordence — ⭐⭐ RECORDING A MILESTONE PAYMENT
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT THE SAME THING AS A RECEIPT
 * ══════════════════════════════════════════════════════════════════════
 * `recordMilestonePayment` marks a STAGE of the payment plan as paid.
 * `recordPayment` in the receivables panel below records MONEY ARRIVING
 * and appropriates it across demands under Section 59 of the Contract
 * Act. They are different operations with different permissions and
 * different consequences, and a screen that blurred them would produce a
 * plan that says paid and a ledger that says nothing arrived.
 *
 * The sentence under the heading says so, because "record payment"
 * appearing twice on one page with different meanings is a trap.
 *
 * ⚠️ THE AMOUNT DEFAULTS TO WHAT IS OUTSTANDING ON THAT STAGE, which is
 * the answer nine times in ten, and is editable because the tenth is a
 * part payment.
 */

import { useState, useTransition } from "react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type MilestoneView = {
  id: string;
  label: string;
  sequence: number;
  amount: string;
  paid: string;
  outstandingRupees: string;
  dueDate: string;
  status: string;
};

const STATUS_TONE: Record<string, string> = {
  paid: "text-emerald-700 dark:text-emerald-400",
  overdue: "text-destructive font-medium",
  partial: "text-amber-700 dark:text-amber-400",
};

export function MilestonePayments(props: {
  rows: readonly MilestoneView[];
  canRecord: boolean;
  record: (input: unknown) => Promise<Result<{ milestoneId: string; status: string }>>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function open(row: MilestoneView) {
    setOpenId(row.id);
    setAmount(row.outstandingRupees);
    setPaidAt("");
    setReference("");
    setError(null);
    setNotice(null);
  }

  function submit(milestoneId: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.record({
        milestoneId,
        amount,
        paidAt: paidAt === "" ? null : paidAt,
        reference: reference.trim() === "" ? null : reference.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Stage recorded as ${result.data.status}.`);
      setOpenId(null);
    });
  }

  return (
    <div className="space-y-3">
      {props.canRecord && (
        <p className="text-xs text-muted-foreground">
          This marks a stage of the plan as paid. Money arriving, and how it is appropriated
          across demands, is recorded under Receivables below.
        </p>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Stage</th>
              <th scope="col" className="px-3 py-2 font-medium">Due</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Paid</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              {props.canRecord && <th scope="col" className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="px-3 py-2">
                  <span className="text-muted-foreground">{row.sequence}.</span> {row.label}
                </td>
                <td className="px-3 py-2 text-xs">{row.dueDate}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.amount}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.paid}</td>
                <td className={`px-3 py-2 text-xs ${STATUS_TONE[row.status] ?? ""}`}>
                  {row.status}
                </td>
                {props.canRecord && (
                  <td className="px-3 py-2 text-right">
                    {row.status !== "paid" && (
                      <button
                        type="button"
                        onClick={() => open(row)}
                        className="text-xs underline underline-offset-2"
                      >
                        record
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openId && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-3">
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
              <span className="font-medium">Paid on</span>
              <input
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Reference</span>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="UTR, cheque number"
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
              onClick={() => submit(openId)}
              disabled={pending}
              className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
            >
              {pending ? "Recording…" : "Record it"}
            </button>
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
    </div>
  );
}
