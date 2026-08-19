"use client";

/**
 * Ordence — ⭐ Raising a credit note against an issued invoice
 * Version: v0.96.0-alpha
 *
 * ⚠️ IMPORTED FROM `server/actions/`, NEVER FROM `server/invoicing/`.
 * That module begins with `import "server-only"`; importing it from a
 * `"use client"` file fails the production build, and
 * `check:boundaries` catches it in under a second rather than at deploy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PREVIEW IS COMPUTED BY THE INVOICE ENGINE, NOT BY THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * `previewCreditNote()` calls the same `buildInvoice()` the server calls.
 * Adding up the lines here in JavaScript would be four lines of code and
 * would eventually produce a form that says ₹11,800 above a document
 * that says ₹11,799 — a disagreement found by a customer's accountant
 * rather than by us. There is one tax engine in this product.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FORM STARTS FROM THE INVOICE'S OWN LINES
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NOT AN EMPTY FORM. A credit note reverses a supply that was already
 * described, priced and taxed on a document the customer is holding.
 * Re-typing the description and the rate is how a return ends up at 18%
 * against a line billed at 12% — the total looks right and the tax is
 * wrong in two ledgers at once.
 *
 * The price and the tax rate are therefore COPIED and not editable. What
 * a person chooses is which lines, and how much of each.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { raiseCreditNote } from "@/server/actions/sales-invoices";
import {
  CREDIT_NOTE_REASON_META,
  previewCreditNote,
  type CreditNoteReasonCode,
} from "@/lib/invoicing/credit-note";
import { toQtyMinor } from "@/lib/invoicing/build";
import { taxKindFor } from "@/lib/gst/place-of-supply";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Money formatting from a digit string. Never `/ 100`. */
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

function pct(bps: number | null): string {
  if (bps === null) return "—";
  return bps % 100 === 0 ? `${bps / 100}%` : `${(bps / 100).toFixed(2)}%`;
}

export type CreditableLineView = {
  id: string;
  lineNo: number;
  description: string;
  hsnSacCode: string | null;
  uom: string;
  taxRateBps: number | null;
  unitPriceMinor: string;
  quantity: string;
  quantityCreditedIssued: string;
  remainingQty: string;
};

type Picked = { checked: boolean; quantity: string };

export function RaiseCreditNote({
  invoiceId,
  invoiceNumber,
  invoiceDate,
  isInterState,
  placeOfSupplyCode,
  headroomMinor,
  lines,
}: {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  isInterState: boolean;
  placeOfSupplyCode: string | null;
  headroomMinor: string;
  lines: CreditableLineView[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  /**
   * ⚠️ DEFAULTS TO THE INVOICE DATE, NOT TO TODAY.
   *
   * A credit note dated today for a return that happened last month
   * lands in the wrong GSTR-1 period. Defaulting to today is defaulting
   * to "whenever somebody got round to typing it", which is exactly the
   * date that is wrong. The invoice date is at least in the right
   * neighbourhood and is visibly worth changing.
   */
  const [noteDate, setNoteDate] = useState(invoiceDate);
  const [reasonCode, setReasonCode] = useState<CreditNoteReasonCode>("sales_return");
  const [reason, setReason] = useState("");

  const creditable = useMemo(
    () => lines.filter((l) => toQtyMinor(l.remainingQty) > 0n),
    [lines],
  );

  const [picked, setPicked] = useState<Record<string, Picked>>(() =>
    Object.fromEntries(
      creditable.map((l) => [l.id, { checked: false, quantity: l.remainingQty }]),
    ),
  );

  const chosen = creditable.filter((l) => picked[l.id]?.checked);

  /**
   * ⚠️ OVER-QUANTITY IS CAUGHT HERE AND AGAIN ON THE SERVER, and the
   * server one is the one that counts. This exists so a person is told
   * while the field is still under their cursor — not so the rule lives
   * in the browser.
   */
  const overLines = chosen.filter((l) => {
    const q = picked[l.id]?.quantity ?? "0";
    return toQtyMinor(q) > toQtyMinor(l.remainingQty);
  });
  const emptyLines = chosen.filter((l) => toQtyMinor(picked[l.id]?.quantity ?? "0") <= 0n);

  const preview = useMemo(() => {
    if (chosen.length === 0 || overLines.length > 0 || emptyLines.length > 0) return null;
    try {
      return previewCreditNote({
        lines: chosen.map((l) => ({
          invoiceLineId: l.id,
          description: l.description,
          quantity: picked[l.id]?.quantity ?? "0",
          unitPriceMinor: BigInt(l.unitPriceMinor),
          taxRateBps: l.taxRateBps ?? 0,
          hsnSacCode: l.hsnSacCode,
          uom: l.uom,
        })),
        taxKind: taxKindFor(isInterState, placeOfSupplyCode ?? "27"),
        placeOfSupplyCode: placeOfSupplyCode ?? "27",
      });
      /**
       * ⚠️ A FAILED PREVIEW SHOWS NOTHING RATHER THAN A STALE FIGURE.
       * A number left over from the previous keystroke is worse than a
       * blank: it is a total somebody would sign off.
       */
    } catch {
      return null;
    }
  }, [chosen, picked, isInterState, placeOfSupplyCode, overLines.length, emptyLines.length]);

  const total = preview?.tax.amountPayableMinor ?? null;
  const overHeadroom = total !== null && total > BigInt(headroomMinor);

  const blocked =
    pending ||
    chosen.length === 0 ||
    overLines.length > 0 ||
    emptyLines.length > 0 ||
    overHeadroom ||
    reason.trim().length < 4;

  function submit() {
    setError(null);
    setConfirming(false);
    start(async () => {
      const res = await raiseCreditNote({
        invoiceId,
        noteDate,
        reasonCode,
        reason: reason.trim(),
        lines: chosen.map((l) => ({
          invoiceLineId: l.id,
          description: l.description,
          quantity: picked[l.id]?.quantity ?? "0",
          unitPriceMinor: l.unitPriceMinor,
          taxRateBps: l.taxRateBps ?? 0,
          ...(l.hsnSacCode ? { hsnSacCode: l.hsnSacCode } : {}),
        })),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/credit-notes/${res.data.id}`);
      router.refresh();
    });
  }

  if (creditable.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {/* Not a disabled form. There is genuinely nothing left to reverse. */}
        Every line on {invoiceNumber} has already been credited in full. There is nothing
        left on this invoice to reverse.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-medium">What is coming back</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Credit</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 text-right font-medium">Invoiced</th>
                <th className="py-2 pr-3 text-right font-medium">Still creditable</th>
                <th className="py-2 pr-3 text-right font-medium">Rate</th>
                <th className="py-2 pr-3 text-right font-medium">GST</th>
                <th className="py-2 pr-3 text-right font-medium">Quantity to credit</th>
              </tr>
            </thead>
            <tbody>
              {creditable.map((l) => {
                const p = picked[l.id] ?? { checked: false, quantity: l.remainingQty };
                const over = toQtyMinor(p.quantity) > toQtyMinor(l.remainingQty);
                return (
                  <tr key={l.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <input
                        type="checkbox"
                        aria-label={`Credit line ${l.lineNo}`}
                        checked={p.checked}
                        onChange={(e) =>
                          setPicked((s) => ({
                            ...s,
                            [l.id]: { ...p, checked: e.target.checked },
                          }))
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <span className="tabular-nums text-muted-foreground">{l.lineNo}. </span>
                      {l.description}
                      {l.hsnSacCode && (
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          HSN/SAC {l.hsnSacCode}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {l.quantity} {l.uom}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {l.remainingQty} {l.uom}
                      {toQtyMinor(l.quantityCreditedIssued) > 0n && (
                        <span className="block text-xs text-muted-foreground">
                          {l.quantityCreditedIssued} already credited
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(l.unitPriceMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{pct(l.taxRateBps)}</td>
                    <td className="py-2 pr-3 text-right">
                      <Input
                        value={p.quantity}
                        inputMode="decimal"
                        aria-label={`Quantity to credit on line ${l.lineNo}`}
                        disabled={!p.checked}
                        onChange={(e) =>
                          setPicked((s) => ({
                            ...s,
                            [l.id]: { ...p, quantity: e.target.value },
                          }))
                        }
                        className={`w-28 text-right tabular-nums ${over ? "border-destructive" : ""}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {overLines.length > 0 && (
          <p className="rounded border-l-2 border-destructive pl-3 text-sm">
            {/* Named, not "invalid input". */}
            {overLines
              .map(
                (l) =>
                  `Line ${l.lineNo} has only ${l.remainingQty} ${l.uom} left uncredited.`,
              )
              .join(" ")}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">On what ground</h2>
        {/**
         * ⚠️ A CLOSED LIST BECAUSE SECTION 34(1) IS A CLOSED LIST. Free
         * text here would let "because the customer asked" become a
         * ground, and that is the credit note an officer disallows.
         */}
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(CREDIT_NOTE_REASON_META) as CreditNoteReasonCode[]).map((code) => {
            const meta = CREDIT_NOTE_REASON_META[code];
            const active = reasonCode === code;
            return (
              <button
                key={code}
                type="button"
                onClick={() => setReasonCode(code)}
                className={`rounded border p-3 text-left text-sm ${active ? "border-foreground" : "border-muted"}`}
              >
                <span className="block font-medium">{meta.label}</span>
                <span className="block text-xs text-muted-foreground">{meta.statute}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{meta.help}</span>
              </button>
            );
          })}
        </div>

        <div className="space-y-1">
          <label htmlFor="cn-reason" className="text-sm font-medium">
            What happened
          </label>
          <p className="text-xs text-muted-foreground">
            Read back at an audit, possibly years later, by someone who was not there.
          </p>
          <Textarea
            id="cn-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="12 bags returned undamaged on 3 August against DC/0114 — customer over-ordered."
            rows={2}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="cn-date" className="text-sm font-medium">
            Note date
          </label>
          <p className="text-xs text-muted-foreground">
            Decides which GSTR-1 period this reversal falls in. Use the date the goods came
            back, not the date you are typing.
          </p>
          <Input
            id="cn-date"
            type="date"
            value={noteDate}
            onChange={(e) => setNoteDate(e.target.value)}
            className="w-48 tabular-nums"
          />
        </div>
      </section>

      <section className="space-y-2 rounded border p-4">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Taxable value</span>
          <span className="tabular-nums">{inr(preview?.tax.taxableMinor ?? "0")}</span>
        </div>
        {/**
         * ⚠️ THE HEADS ARE SHOWN SEPARATELY, as on the invoice. A
         * customer reconciles CGST, SGST and IGST against three
         * different ledgers, and the reversal has to land in the same
         * three.
         */}
        {isInterState ? (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">IGST</span>
            <span className="tabular-nums">{inr(preview?.tax.igstMinor ?? "0")}</span>
          </div>
        ) : (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">CGST</span>
              <span className="tabular-nums">{inr(preview?.tax.cgstMinor ?? "0")}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">SGST / UTGST</span>
              <span className="tabular-nums">{inr(preview?.tax.sgstMinor ?? "0")}</span>
            </div>
          </>
        )}
        <div className="flex justify-between border-t pt-2 font-semibold">
          <span>Credit note total</span>
          <span className="tabular-nums">{total === null ? "—" : inr(total)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Still creditable on {invoiceNumber}</span>
          <span className="tabular-nums">{inr(headroomMinor)}</span>
        </div>
        {overHeadroom && (
          <p className="rounded border-l-2 border-destructive pl-3 text-sm">
            This note is larger than what is left uncredited on {invoiceNumber}. A credit
            note can only reverse what was actually billed.
          </p>
        )}
      </section>

      {!confirming && (
        <Button type="button" onClick={() => setConfirming(true)} disabled={blocked}>
          Review this credit note
        </Button>
      )}

      {confirming && (
        <div className="space-y-3 rounded border p-4">
          {/**
           * ⚠️ THE CONFIRMATION STATES WHAT BECOMES TRUE. A dialog that
           * asks whether you are sure is answered "yes" without being
           * read.
           */}
          <p className="text-sm font-medium">
            This creates a DRAFT credit note for {total === null ? "—" : inr(total)} against{" "}
            {invoiceNumber}.
          </p>
          <p className="text-sm text-muted-foreground">
            Nothing is reversed yet and the customer sees nothing. A draft takes no number
            and consumes none of the invoice&apos;s remaining credit — issuing it does both.
          </p>
          <div className="flex gap-2">
            <Button type="button" onClick={submit} disabled={blocked}>
              {pending ? "Creating…" : "Create the draft"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Back
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
