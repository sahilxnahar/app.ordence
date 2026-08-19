"use client";

/**
 * Ordence — ⭐ Applying one receipt across several invoices
 * Version: v0.98.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE ALLOCATION IS TYPED AND NEVER INFERRED
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design is "apply oldest first" with one button. It is
 * wrong, and it is wrong in a way nobody notices for months.
 *
 * ⚠️ A CUSTOMER PAYING ₹5,00,000 USUALLY MEANS SOMETHING SPECIFIC BY IT
 * — three invoices in full, or one disputed bill deliberately left out.
 * Oldest-first quietly settles the disputed one and leaves a current
 * invoice short, so the dispute disappears from the ageing report while
 * remaining entirely alive in the customer's mind. The reconciliation
 * that follows is unwinnable because nobody recorded what was intended.
 *
 * So the person types the split, and the total is checked before it is
 * sent. `allocateReceipt` refuses an over-application anyway; this exists
 * so it is caught while the field is still under their cursor.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { allocateReceipt } from "@/server/actions/sales-invoices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseMoney } from "@/lib/billing/money";

function inr(minorUnits: string | bigint | null | undefined): string {
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
 * 🔴 RUPEES TYPED BY A HUMAN → PAISE, VIA THE PARSER THAT ALREADY EXISTS.
 *
 * ⚠️ `Math.round(parseFloat(v) * 100)` IS THE BUG THIS AVOIDS.
 * `parseFloat("1234.35") * 100` is `123434.99999999999`, and rounding
 * hides it until the one input where it does not. Money never touches a
 * float in this product, and a text box is exactly where that rule is
 * most tempting to break.
 *
 * ⚠️ IT DELEGATES TO `parseMoney`, IT DOES NOT REIMPLEMENT IT. This file
 * originally carried its own regex and its own BigInt arithmetic — a
 * second money parser, which is the same mistake as a second tax engine
 * and fails the same way: the two agree until one is edited.
 *
 * What is added here is only what a live text box needs and `parseMoney`
 * rightly refuses to guess at:
 *   • empty means zero, not an error — somebody is still typing
 *   • a NEGATIVE is refused. `parseMoney` allows one because billing has
 *     genuine credits; an allocation does not. Applying minus ₹500 to an
 *     invoice would increase what is owed from a screen labelled
 *     "receipt".
 */
function toMinor(input: string): bigint | null {
  const t = input.trim();
  if (t === "") return 0n;
  if (t.startsWith("-")) return null;
  try {
    return parseMoney(t, "INR");
  } catch {
    return null;
  }
}

export type OpenInvoiceView = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  status: string;
  totalMinor: string;
  receivedMinor: string;
  outstandingMinor: string;
};

export function AllocateReceipt({
  receiptId,
  unappliedMinor,
  openInvoices,
}: {
  receiptId: string;
  unappliedMinor: string;
  openInvoices: OpenInvoiceView[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const unapplied = BigInt(unappliedMinor);

  const parsed = useMemo(
    () =>
      openInvoices.map((inv) => {
        const raw = amounts[inv.id] ?? "";
        const minor = toMinor(raw);
        return {
          inv,
          raw,
          minor,
          malformed: minor === null,
          overInvoice: minor !== null && minor > BigInt(inv.outstandingMinor),
        };
      }),
    [openInvoices, amounts],
  );

  const applied = parsed.reduce((sum, p) => sum + (p.minor ?? 0n), 0n);
  const remaining = unapplied - applied;
  const anyMalformed = parsed.some((p) => p.malformed);
  const anyOverInvoice = parsed.some((p) => p.overInvoice);
  const overReceipt = applied > unapplied;

  const chosen = parsed.filter((p) => (p.minor ?? 0n) > 0n);
  const blocked =
    pending || chosen.length === 0 || anyMalformed || anyOverInvoice || overReceipt;

  /**
   * ⚠️ A CONVENIENCE, NOT A DEFAULT. Oldest-first is offered as a button
   * somebody presses and can then edit — never as the state the form
   * opens in. The difference is whether a person decided, or whether the
   * software decided and nobody read it.
   */
  function fillOldestFirst() {
    let left = unapplied;
    const next: Record<string, string> = {};
    for (const inv of openInvoices) {
      if (left <= 0n) break;
      const due = BigInt(inv.outstandingMinor);
      const take = due < left ? due : left;
      const whole = take / 100n;
      const frac = take % 100n;
      next[inv.id] = `${whole}.${String(frac).padStart(2, "0")}`;
      left -= take;
    }
    setAmounts(next);
  }

  function submit() {
    setError(null);
    start(async () => {
      const res = await allocateReceipt({
        receiptId,
        allocations: chosen.map((p) => ({
          invoiceId: p.inv.id,
          amountMinor: String(p.minor ?? 0n),
        })),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      setAmounts({});
    });
  }

  if (openInvoices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {/* Not a disabled form — there is genuinely nothing to apply this to. */}
        This customer has no open invoices. The money stays unapplied until one is issued,
        which is correct — it is theirs, and it is recorded.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">Unapplied on this receipt</span>
        <span className="font-semibold tabular-nums">{inr(unappliedMinor)}</span>
        <Button type="button" variant="outline" size="sm" onClick={fillOldestFirst}>
          Fill oldest first
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Invoice</th>
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 font-medium">Due</th>
              <th className="py-2 pr-3 text-right font-medium">Total</th>
              <th className="py-2 pr-3 text-right font-medium">Outstanding</th>
              <th className="py-2 pr-3 text-right font-medium">Apply (₹)</th>
            </tr>
          </thead>
          <tbody>
            {parsed.map(({ inv, raw, malformed, overInvoice }) => (
              <tr key={inv.id} className="border-b last:border-0">
                <td className="py-2 pr-3">{inv.invoiceNumber}</td>
                <td className="py-2 pr-3 tabular-nums">{inv.invoiceDate}</td>
                <td className="py-2 pr-3 tabular-nums">{inv.dueDate ?? "—"}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{inr(inv.totalMinor)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {inr(inv.outstandingMinor)}
                </td>
                <td className="py-2 pr-3 text-right">
                  <Input
                    value={raw}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label={`Amount to apply to ${inv.invoiceNumber}`}
                    onChange={(e) =>
                      setAmounts((s) => ({ ...s, [inv.id]: e.target.value }))
                    }
                    className={`w-32 text-right tabular-nums ${
                      malformed || overInvoice ? "border-destructive" : ""
                    }`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1 rounded border p-4 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Being applied</span>
          <span className="tabular-nums">{inr(applied)}</span>
        </div>
        <div className="flex justify-between font-medium">
          <span>Left unapplied after this</span>
          <span className="tabular-nums">{inr(remaining < 0n ? 0n : remaining)}</span>
        </div>
        {/**
         * ⚠️ LEAVING MONEY UNAPPLIED IS ALLOWED AND IS NOT AN ERROR.
         * An advance genuinely has nothing to apply to yet. The figure is
         * shown so it is a decision rather than an oversight.
         */}
        {remaining > 0n && !overReceipt && (
          <p className="pt-1 text-xs text-muted-foreground">
            That is fine — an advance sits unapplied until there is an invoice for it. It
            stays visible on the statement either way.
          </p>
        )}
      </div>

      {anyMalformed && (
        <p className="rounded border-l-2 border-destructive pl-3 text-sm">
          Amounts take rupees and up to two decimals — <code>12500</code> or{" "}
          <code>12500.50</code>.
        </p>
      )}
      {anyOverInvoice && (
        <p className="rounded border-l-2 border-destructive pl-3 text-sm">
          {parsed
            .filter((p) => p.overInvoice)
            .map((p) => `${p.inv.invoiceNumber} only has ${inr(p.inv.outstandingMinor)} outstanding.`)
            .join(" ")}
        </p>
      )}
      {overReceipt && (
        <p className="rounded border-l-2 border-destructive pl-3 text-sm">
          That is {inr(applied - unapplied)} more than this receipt has left on it. A
          receipt cannot pay out more than came in.
        </p>
      )}

      <Button type="button" onClick={submit} disabled={blocked}>
        {pending ? "Applying…" : `Apply ${inr(applied)} across ${chosen.length} invoice${chosen.length === 1 ? "" : "s"}`}
      </Button>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
