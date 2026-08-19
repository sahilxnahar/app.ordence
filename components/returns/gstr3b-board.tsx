"use client";

/**
 * Ordence — ⭐⭐⭐ GSTR-3B, WITH THE SET-OFF SHOWN
 * Version: v1.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SET-OFF IS PRINTED MOVE BY MOVE, WITH THE RULE THAT PERMITTED
 * EACH ONE
 * ══════════════════════════════════════════════════════════════════════
 * A screen that shows only "cash payable ₹2,40,000" is asking the
 * accountant to trust it. They will not, and they are right not to —
 * they will re-derive it in a spreadsheet, and then there are two
 * answers.
 *
 * ⚠️ SO EVERY MOVEMENT OF CREDIT IS LISTED WITH ITS REASON. Reading
 * "₹1,20,000 of IGST credit against CGST liability — IGST credit left
 * after clearing IGST may be used against CGST" takes ten seconds and
 * replaces the spreadsheet.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ItcReversalWorking,
  type ComputedReversal,
} from "@/components/gst/itc-reversal-working";

export function rupees(minor: string): string {
  const value = BigInt(minor || "0");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toLocaleString("en-IN");
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${whole}.${paise}`;
}

export type ReturnView = {
  id: string;
  gstin: string;
  taxPeriod: string;
  status: string;
  dueOn: string | null;
  arn: string | null;
  hasJournal: boolean;
  outputIgstMinor: string;
  outputCgstMinor: string;
  outputSgstMinor: string;
  itcIgstMinor: string;
  itcCgstMinor: string;
  itcSgstMinor: string;
  cashIgstMinor: string;
  cashCgstMinor: string;
  cashSgstMinor: string;
  cashCessMinor: string;
  interestMinor: string;
  lateFeeMinor: string;
  totalCashMinor: string;
  carriedIgstMinor: string;
  carriedCgstMinor: string;
  carriedSgstMinor: string;
  setoffMoves: Array<{
    creditHead: string;
    liabilityHead: string;
    amountMinor: string;
    rule: string;
  }>;
  notes: string[];
  problems: string[];
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function Gstr3bBoard({
  rows,
  defaultGstin,
  canPrepare,
  canPost,
  onPrepare,
  onFinalise,
  onFile,
  onPost,
  onSupersede,
}: {
  rows: ReturnView[];
  defaultGstin: string;
  canPrepare: boolean;
  canPost: boolean;
  onPrepare: (input: {
    gstin: string;
    taxPeriod: string;
    itcReversedIgstMinor: string;
    itcReversedCgstMinor: string;
    itcReversedSgstMinor: string;
    itcReversedCessMinor: string;
    /**
     * ⭐ WHAT THE ENGINE SAID, sent alongside what is actually going in
     * the return. The server refuses a difference between the two
     * without a written reason and records BOTH — see `prepareGstr3b`.
     * Absent when the operator never ran the working, which the server
     * treats as an override of "not computed" and also refuses silently
     * to accept.
     */
    itcReversalComputedIgstMinor?: string;
    itcReversalComputedCgstMinor?: string;
    itcReversalComputedSgstMinor?: string;
    itcReversalComputedCessMinor?: string;
    itcReversalBasis?: string;
    itcReversalOverrideReason?: string;
    interestMinor: string;
    lateFeeMinor: string;
  }) => Promise<Result<{ id: string; note: string }>>;
  onFinalise: (input: { returnId: string }) => Promise<Result<{ note: string }>>;
  onFile: (input: { returnId: string; arn: string }) => Promise<Result<{ note: string }>>;
  onPost: (input: { returnId: string }) => Promise<Result<{ note: string }>>;
  onSupersede: (input: { returnId: string; reason: string }) => Promise<Result<{ note: string }>>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [gstin, setGstin] = useState(defaultGstin);
  const [period, setPeriod] = useState(lastMonth());
  /**
   * ⚠️ CESS IS A BOX HERE NOW AND WAS NOT BEFORE. The Rule 42 engine
   * apportions four heads because the four are not in the same ratio as
   * one another; a form with three boxes would drop a computed cess
   * reversal on the floor, which is precisely the silent under-reversal
   * this batch exists to stop.
   */
  const [reversals, setReversals] = useState({ igst: "", cgst: "", sgst: "", cess: "" });
  /**
   * ⭐ WHAT THE ENGINE COMPUTED, kept separately from what is in the
   * boxes. Two fields rather than one because the whole point is that the
   * pair can differ and the difference is what has to be explained —
   * overwriting the computed figure with the operator's edit would leave
   * nothing to compare against and nothing to record.
   */
  const [computed, setComputed] = useState<ComputedReversal | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [extras, setExtras] = useState({ interest: "", lateFee: "" });
  const [open, setOpen] = useState<string | null>(null);
  const [arn, setArn] = useState("");
  const [reason, setReason] = useState("");

  /**
   * ⚠️ COMPARED HEAD BY HEAD IN PAISE, NEVER ON THE TOTAL AND NEVER AS A
   * NUMBER. Two sets of four heads can sum to the same total and still be
   * a different return — ₹1,000 moved from CGST to SGST files cleanly,
   * balances, and reverses credit in the wrong pool. Comparing totals
   * would let exactly that through without a reason.
   */
  const enteredHeadsMinor = [
    toMinor(reversals.igst),
    toMinor(reversals.cgst),
    toMinor(reversals.sgst),
    toMinor(reversals.cess),
  ];
  const computedHeadsMinor = computed
    ? [computed.igstMinor, computed.cgstMinor, computed.sgstMinor, computed.cessMinor]
    : null;
  const enteredTotalMinor = enteredHeadsMinor
    .reduce((sum, head) => sum + BigInt(head), 0n)
    .toString();

  /**
   * 🔴 NO WORKING RUN AT ALL IS ALSO AN OVERRIDE, and treating it as
   * anything else reopens the hole. If a non-zero reversal could be typed
   * simply by never pressing "Compute", the reason would be optional in
   * practice for everyone who wanted it to be.
   */
  const overrides = computedHeadsMinor
    ? computedHeadsMinor.some((head, i) => BigInt(head) !== BigInt(enteredHeadsMinor[i] ?? "0"))
    : BigInt(enteredTotalMinor) !== 0n;

  function act<T extends { note: string }>(p: Promise<Result<T>>) {
    startTransition(async () => {
      const result = await p;
      if (result.ok) {
        setOpen(null);
        setArn("");
        setReason("");
        toast.success(result.data.note);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {canPrepare ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Prepare a return</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id="gstin" label="GSTIN" help="One return per registration. Credit does not move between States.">
                <Input id="gstin" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} maxLength={15} />
              </Field>
              <Field id="period" label="Tax period" help="YYYY-MM">
                {/*
                  🔴 CHANGING THE MONTH DISCARDS THE COMPUTED REVERSAL AND
                  THE FIGURES IN THE BOXES. July's Rule 42 answer attached
                  to August's return is a perfectly-formed number for the
                  wrong period: it reconciles to nothing, it files
                  cleanly, and the only way anybody finds it is the
                  demand. Keeping the boxes populated across a period
                  change would make that the DEFAULT behaviour.
                */}
                <Input
                  id="period"
                  value={period}
                  onChange={(e) => {
                    setPeriod(e.target.value);
                    setComputed(null);
                    setReversals({ igst: "", cgst: "", sgst: "", cess: "" });
                    setOverrideReason("");
                  }}
                  placeholder="2026-07"
                />
              </Field>
              <div className="flex items-end">
                <Button
                  disabled={pending || (overrides && overrideReason.trim().length < 20)}
                  title={
                    overrides && overrideReason.trim().length < 20
                      ? "The reversal differs from the computed figure. Say why, in a sentence."
                      : undefined
                  }
                  onClick={() =>
                    act(
                      onPrepare({
                        gstin,
                        taxPeriod: period,
                        itcReversedIgstMinor: toMinor(reversals.igst),
                        itcReversedCgstMinor: toMinor(reversals.cgst),
                        itcReversedSgstMinor: toMinor(reversals.sgst),
                        itcReversedCessMinor: toMinor(reversals.cess),
                        // ⭐ BOTH NUMBERS CROSS THE WIRE. The server, not
                        // this component, decides whether the difference
                        // is permitted — a client-side check alone is a
                        // suggestion, because the action is a URL.
                        ...(computed
                          ? {
                              itcReversalComputedIgstMinor: computed.igstMinor,
                              itcReversalComputedCgstMinor: computed.cgstMinor,
                              itcReversalComputedSgstMinor: computed.sgstMinor,
                              itcReversalComputedCessMinor: computed.cessMinor,
                              itcReversalBasis: computed.basis,
                            }
                          : {}),
                        ...(overrideReason.trim() === ""
                          ? {}
                          : { itcReversalOverrideReason: overrideReason.trim() }),
                        interestMinor: toMinor(extras.interest),
                        lateFeeMinor: toMinor(extras.lateFee),
                      }),
                    )
                  }
                >
                  Prepare from the ledger
                </Button>
              </div>
            </div>

            <details className="rounded border p-3 text-xs" open>
              <summary className="cursor-pointer font-medium">
                ITC reversals, interest and late fee
              </summary>

              {/*
                ⭐⭐ THE REVERSAL IS COMPUTED HERE NOW. It used to be three
                empty boxes with a note saying Ordence does not model the
                turnover splits. It does — `lib/purchases/itc.ts` decides
                Section 17(5) line by line and `lib/purchases/apportionment.ts`
                runs Rule 42 to the paisa — and the engines were simply not
                wired to this form.
              */}
              <div className="mt-3">
                <ItcReversalWorking
                  taxPeriod={period}
                  onUse={(next) => {
                    setComputed(next);
                    setReversals({
                      igst: fromMinor(next.igstMinor),
                      cgst: fromMinor(next.cgstMinor),
                      sgst: fromMinor(next.sgstMinor),
                      cess: fromMinor(next.cessMinor),
                    });
                    // A fresh computation retires the previous reason: it
                    // explained a difference against a figure that no
                    // longer exists.
                    setOverrideReason("");
                  }}
                />
              </div>

              <p className="mt-3 text-muted-foreground">
                The boxes below hold what actually goes in the return. They stay editable —
                an accountant with a figure from their own working papers is a legitimate
                case, and Rule 43 on capital goods bought in earlier periods is not in the
                computed number. ⚠️ But a change has to be explained, and both figures are
                kept with the return.
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field id="rev-igst" label="IGST reversed (₹)" help={computedHelp(computed?.igstMinor)}>
                  <Input id="rev-igst" value={reversals.igst} onChange={(e) => setReversals({ ...reversals, igst: e.target.value })} />
                </Field>
                <Field id="rev-cgst" label="CGST reversed (₹)" help={computedHelp(computed?.cgstMinor)}>
                  <Input id="rev-cgst" value={reversals.cgst} onChange={(e) => setReversals({ ...reversals, cgst: e.target.value })} />
                </Field>
                <Field id="rev-sgst" label="SGST reversed (₹)" help={computedHelp(computed?.sgstMinor)}>
                  <Input id="rev-sgst" value={reversals.sgst} onChange={(e) => setReversals({ ...reversals, sgst: e.target.value })} />
                </Field>
                <Field id="rev-cess" label="Cess reversed (₹)" help={computedHelp(computed?.cessMinor)}>
                  <Input id="rev-cess" value={reversals.cess} onChange={(e) => setReversals({ ...reversals, cess: e.target.value })} />
                </Field>
                <Field id="interest" label="Interest (₹)" help="An expense, never creditable.">
                  <Input id="interest" value={extras.interest} onChange={(e) => setExtras({ ...extras, interest: e.target.value })} />
                </Field>
                <Field id="latefee" label="Late fee (₹)" help="An expense, and disallowed for income tax.">
                  <Input id="latefee" value={extras.lateFee} onChange={(e) => setExtras({ ...extras, lateFee: e.target.value })} />
                </Field>
              </div>

              {/*
                🔴 THE OVERRIDE BOX APPEARS ONLY WHEN THERE IS SOMETHING TO
                EXPLAIN, and it is not optional once it does. Silently
                letting a typed figure replace a computed one is the
                failure this batch removes: the return would carry the
                accountant's number, the register would carry the
                engine's, and nothing would record that they differed or
                why.
              */}
              {overrides ? (
                <div
                  className="mt-3 space-y-2 rounded border border-amber-400 p-3"
                  data-testid="reversal-override"
                >
                  <p className="text-amber-700 dark:text-amber-400">
                    ⚠️ This differs from the computed reversal
                    {computed
                      ? `: computed ${rupees(
                          (
                            BigInt(computed.igstMinor) +
                            BigInt(computed.cgstMinor) +
                            BigInt(computed.sgstMinor) +
                            BigInt(computed.cessMinor)
                          ).toString(),
                        )}, entered ${rupees(enteredTotalMinor)}`
                      : " — no working was run for this period at all"}
                    . Both figures and your reason are stored with the return.
                  </p>
                  <Textarea
                    id="reversal-override-reason"
                    rows={2}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Why is the return carrying a different figure? e.g. Rule 43 slice on the 2024-25 chillers, per working paper WP-42."
                  />
                  <p className="text-muted-foreground">
                    At least twenty characters. &quot;Adjustment&quot; is not a reason anybody
                    can check three years from now.
                  </p>
                </div>
              ) : null}
            </details>
          </CardContent>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No return has been prepared yet. Prepare one and Ordence assembles it from what is
          actually in the ledger — not from the invoice table, because the return and the books
          are the two documents an assessment compares.
        </p>
      ) : null}

      {rows.map((r) => (
        <Card key={r.id} data-testid={`return-${r.taxPeriod}`}>
          <CardContent className="space-y-4 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.taxPeriod}</span>
              <Badge variant={r.status === "filed" ? "secondary" : "outline"}>{r.status}</Badge>
              {r.problems.length > 0 ? <Badge variant="destructive">problem</Badge> : null}
              {r.hasJournal ? <Badge variant="secondary">posted</Badge> : null}
              {r.arn ? <code className="font-mono text-xs">{r.arn}</code> : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {r.dueOn ? `due ${r.dueOn}` : null}
              </span>
            </div>

            {/* ---- 🔴 The number somebody has to find money for ------ */}
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Payable in cash</div>
              <div className="text-2xl font-semibold">{rupees(r.totalCashMinor)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                IGST {rupees(r.cashIgstMinor)} · CGST {rupees(r.cashCgstMinor)} · SGST{" "}
                {rupees(r.cashSgstMinor)}
                {BigInt(r.interestMinor || "0") > 0n ? ` · interest ${rupees(r.interestMinor)}` : ""}
                {BigInt(r.lateFeeMinor || "0") > 0n ? ` · late fee ${rupees(r.lateFeeMinor)}` : ""}
              </div>
            </div>

            <div className="grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <div className="font-medium">Output tax</div>
                <div className="text-muted-foreground">
                  IGST {rupees(r.outputIgstMinor)} · CGST {rupees(r.outputCgstMinor)} · SGST{" "}
                  {rupees(r.outputSgstMinor)}
                </div>
              </div>
              <div>
                <div className="font-medium">Credit available</div>
                <div className="text-muted-foreground">
                  IGST {rupees(r.itcIgstMinor)} · CGST {rupees(r.itcCgstMinor)} · SGST{" "}
                  {rupees(r.itcSgstMinor)}
                </div>
              </div>
            </div>

            {/* ---- ⭐ THE WORKING ------------------------------------ */}
            {r.setoffMoves.length > 0 ? (
              <div className="rounded border p-3 text-xs">
                <div className="mb-2 font-medium">How the credit was used</div>
                <table className="w-full">
                  <tbody>
                    {r.setoffMoves.map((m, i) => (
                      <tr key={`${m.creditHead}-${m.liabilityHead}-${i}`} className="border-b last:border-0">
                        <td className="py-1">
                          {m.creditHead.toUpperCase()} credit → {m.liabilityHead.toUpperCase()}{" "}
                          liability
                          <div className="text-muted-foreground">{m.rule}</div>
                        </td>
                        <td className="py-1 text-right align-top">{rupees(m.amountMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 text-muted-foreground">
                  Carried forward: IGST {rupees(r.carriedIgstMinor)} · CGST{" "}
                  {rupees(r.carriedCgstMinor)} · SGST {rupees(r.carriedSgstMinor)}
                </div>
              </div>
            ) : null}

            {r.problems.map((p) => (
              <p key={p} className="text-xs text-destructive">
                {p}
              </p>
            ))}
            {r.notes.map((n) => (
              <p key={n} className="text-xs text-muted-foreground">
                {n}
              </p>
            ))}

            {/* ---- Actions ---------------------------------------- */}
            <div className="flex flex-wrap gap-2 border-t pt-3">
              {r.status === "draft" && canPrepare ? (
                <Button
                  size="sm"
                  disabled={pending || r.problems.length > 0}
                  title={r.problems.length > 0 ? "Resolve the problems first." : undefined}
                  onClick={() => act(onFinalise({ returnId: r.id }))}
                >
                  Finalise
                </Button>
              ) : null}

              {r.status === "finalised" && canPrepare ? (
                <Button size="sm" variant="outline" onClick={() => setOpen(`file-${r.id}`)}>
                  Record as filed
                </Button>
              ) : null}

              {(r.status === "finalised" || r.status === "filed") && !r.hasJournal && canPost ? (
                <Button size="sm" disabled={pending} onClick={() => act(onPost({ returnId: r.id }))}>
                  Post the set-off journal
                </Button>
              ) : null}

              {r.status !== "filed" && r.status !== "superseded" && canPrepare ? (
                <Button size="sm" variant="destructive" onClick={() => setOpen(`sup-${r.id}`)}>
                  Supersede
                </Button>
              ) : null}
            </div>

            {open === `file-${r.id}` ? (
              <div className="space-y-2 rounded border p-3">
                <p className="text-xs text-muted-foreground">
                  Ordence does not file — that needs a GSP. Key the figures into the portal, then
                  paste the acknowledgement number it gives you. Once recorded, the figures are
                  locked: GST provides no amendment of a filed 3B, so a mistake is corrected in a
                  later period.
                </p>
                <Input value={arn} onChange={(e) => setArn(e.target.value)} placeholder="Acknowledgement number (ARN)" />
                <div className="flex gap-2">
                  <Button size="sm" disabled={pending} onClick={() => act(onFile({ returnId: r.id, arn }))}>
                    Record it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {open === `sup-${r.id}` ? (
              <div className="space-y-2 rounded border p-3">
                <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being replaced?" />
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" disabled={pending} onClick={() => act(onSupersede({ returnId: r.id, reason }))}>
                    Supersede it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                    Keep it
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * Paise back to a rupee string for a form field.
 *
 * ⚠️ INTEGER DIVISION ON A BIGINT, NOT `Number(minor) / 100`. The round
 * trip through a float is exact for small figures and stops being exact
 * somewhere above ninety crore of credit — and the failure is a wrong
 * reversal in the box, not an error anybody sees.
 */
function fromMinor(minor: string): string {
  const value = BigInt(minor || "0");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** The engine's figure, shown under the box the operator may change. */
function computedHelp(minor: string | undefined): string {
  return minor === undefined
    ? "No working run yet — compute the reversal above."
    : `Computed: ${rupees(minor)}`;
}

/** ⚠️ Rupees to paise by string, never by multiplying a float. */
function toMinor(input: string): string {
  const text = (input || "0").trim().replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return "0";
  const [whole, fraction = ""] = text.split(".");
  return `${whole}${fraction.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
}

function lastMonth(): string {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(first.getTime() - 86_400_000);
  return end.toISOString().slice(0, 7);
}

function Field({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}
