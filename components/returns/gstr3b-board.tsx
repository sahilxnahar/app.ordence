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
  const [reversals, setReversals] = useState({ igst: "", cgst: "", sgst: "" });
  const [extras, setExtras] = useState({ interest: "", lateFee: "" });
  const [open, setOpen] = useState<string | null>(null);
  const [arn, setArn] = useState("");
  const [reason, setReason] = useState("");

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
                <Input id="period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-07" />
              </Field>
              <div className="flex items-end">
                <Button
                  disabled={pending}
                  onClick={() =>
                    act(
                      onPrepare({
                        gstin,
                        taxPeriod: period,
                        itcReversedIgstMinor: toMinor(reversals.igst),
                        itcReversedCgstMinor: toMinor(reversals.cgst),
                        itcReversedSgstMinor: toMinor(reversals.sgst),
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

            <details className="rounded border p-3 text-xs">
              <summary className="cursor-pointer font-medium">
                ITC reversals, interest and late fee
              </summary>
              <p className="mt-2 text-muted-foreground">
                🔴 <strong>Reversals are entered, not calculated.</strong> Apportioning credit
                between taxable and exempt supplies under rules 42 and 43 depends on turnover
                splits Ordence does not model, and a wrong reversal is a wrong return with
                interest attached. Your accountant&apos;s figure goes here.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field id="rev-igst" label="IGST reversed (₹)">
                  <Input id="rev-igst" value={reversals.igst} onChange={(e) => setReversals({ ...reversals, igst: e.target.value })} />
                </Field>
                <Field id="rev-cgst" label="CGST reversed (₹)">
                  <Input id="rev-cgst" value={reversals.cgst} onChange={(e) => setReversals({ ...reversals, cgst: e.target.value })} />
                </Field>
                <Field id="rev-sgst" label="SGST reversed (₹)">
                  <Input id="rev-sgst" value={reversals.sgst} onChange={(e) => setReversals({ ...reversals, sgst: e.target.value })} />
                </Field>
                <Field id="interest" label="Interest (₹)" help="An expense, never creditable.">
                  <Input id="interest" value={extras.interest} onChange={(e) => setExtras({ ...extras, interest: e.target.value })} />
                </Field>
                <Field id="latefee" label="Late fee (₹)" help="An expense, and disallowed for income tax.">
                  <Input id="latefee" value={extras.lateFee} onChange={(e) => setExtras({ ...extras, lateFee: e.target.value })} />
                </Field>
              </div>
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
