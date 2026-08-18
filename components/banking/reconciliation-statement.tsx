"use client";

/**
 * Ordence — ⭐⭐⭐ THE BANK RECONCILIATION STATEMENT
 * Version: v1.64.0-alpha (Batch 0102)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCREEN IS THE ARTEFACT AN AUDITOR ASKS FOR
 * ══════════════════════════════════════════════════════════════════════
 * The match list above it pairs lines with documents. That is the input.
 * This is the output: bank balance, the outstanding items by name, book
 * balance, and the button that says so on a date.
 *
 * ⚠️ THE ORDER AND THE SIGNS COME FROM `printableBrs()`, NOT FROM HERE.
 * Two screens laying the same reconciliation out differently is how one
 * of them ends up adding a line that should be subtracted — and it foots
 * either way, because the reader checks the total against the total.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface PrintLine {
  label: string;
  amountMinor: string;
  effect: "opening" | "add" | "subtract" | "total";
}

export interface UnpostedLine {
  id: string;
  valueDate: string;
  amountMinor: string;
  narration: string;
}

function rupees(minor: string): string {
  const n = BigInt(minor);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = (abs / 100n).toString();
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "−" : ""}₹${whole}.${paise}`;
}

export function ReconciliationStatementPanel({
  statementId,
  periodTo,
  reconciledTo,
  printable,
  reconcilesExactly,
  signOffPermitted,
  differenceMinor,
  differenceAbsorbedMinor,
  toleranceMinor,
  notes,
  unpostedLines,
  history,
  signOffAction,
  reopenAction,
  postAdjustmentAction,
}: {
  statementId: string;
  periodTo: string;
  reconciledTo: string | null;
  printable: readonly PrintLine[];
  reconcilesExactly: boolean;
  signOffPermitted: boolean;
  differenceMinor: string;
  differenceAbsorbedMinor: string;
  toleranceMinor: string;
  notes: readonly string[];
  unpostedLines: readonly UnpostedLine[];
  history: ReadonlyArray<{
    id: string;
    reconciledTo: string;
    status: string;
    differenceAbsorbedMinor: string;
  }>;
  signOffAction: (i: unknown) => Promise<Result<{ reconciledTo: string; note: string }>>;
  reopenAction: (i: unknown) => Promise<Result<{ note: string }>>;
  postAdjustmentAction: (i: unknown) => Promise<Result<{ note: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState<string | null>(null);

  function run(work: () => Promise<Result<{ note: string }>>) {
    startTransition(async () => {
      const r = await work();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.data.note);
    });
  }

  const alreadySigned = history.some(
    (h) => h.status === "signed_off" && h.reconciledTo === periodTo,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Bank reconciliation statement as at {periodTo}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <table className="w-full">
            <tbody>
              {printable.map((line, i) => (
                <tr
                  key={`${line.label}-${i}`}
                  className={
                    line.effect === "total" || line.effect === "opening"
                      ? "border-t font-medium"
                      : ""
                  }
                >
                  <td className="py-1 pr-4">
                    {line.effect === "add" ? "Add: " : null}
                    {line.effect === "subtract" ? "Less: " : null}
                    {line.label}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {rupees(line.amountMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/*
            🔴 THE VERDICT IS NOT "GREEN OR RED". An account that footed
            exactly and one that was signed within a tolerance are
            different states, and collapsing them into one tick is how a
            permanent difference becomes invisible.
          */}
          <div className="flex flex-wrap items-center gap-2">
            {reconcilesExactly ? (
              <Badge variant="secondary">Reconciles exactly</Badge>
            ) : signOffPermitted ? (
              <Badge variant="destructive">
                Does not foot · {rupees(differenceMinor)} within the{" "}
                {rupees(toleranceMinor)} tolerance
              </Badge>
            ) : (
              <Badge variant="destructive">
                Does not reconcile · {rupees(differenceMinor)} unexplained
              </Badge>
            )}
            {reconciledTo ? (
              <Badge variant="outline">Locked to {reconciledTo}</Badge>
            ) : (
              <Badge variant="outline">Nothing reconciled yet</Badge>
            )}
          </div>

          {BigInt(differenceAbsorbedMinor) !== 0n ? (
            <p className="text-xs text-destructive">
              {rupees(differenceAbsorbedMinor)} would be allowed through by the
              tolerance configured on this account. It will be recorded on the
              reconciliation as a difference, because it is one. A tolerance is
              permission to sign, never evidence that the account balanced.
            </p>
          ) : null}

          {notes.map((n) => (
            <p key={n} className="text-xs text-muted-foreground">
              {n}
            </p>
          ))}

          <div className="space-y-2 border-t pt-4">
            <Label htmlFor="brs-note">Note for the record (optional)</Label>
            <Input
              id="brs-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the next person reading this statement should know."
            />
            <Button
              disabled={pending || !signOffPermitted || alreadySigned}
              onClick={() =>
                run(() =>
                  signOffAction({
                    statementId,
                    reconciledTo: periodTo,
                    note: note.trim() || undefined,
                  }),
                )
              }
            >
              Sign off as reconciled to {periodTo}
            </Button>
            <p className="text-xs text-muted-foreground">
              {alreadySigned
                ? "This date has already been signed off. Reopen it below if the signed figure is wrong."
                : signOffPermitted
                  ? "After this, matches on lines dated on or before this date can no longer be added or removed. That is what makes the signed figure reproducible."
                  : "A statement that does not foot cannot be signed. A confirmed match is wrong or something is missing from both lists — it is not a rounding error, and it will not become one by being signed."}
            </p>
          </div>
        </CardContent>
      </Card>

      {/*
        ⭐⭐ THE ENTRIES THE BOOKS DO NOT HAVE, POSTED FROM WHERE THEY
        WERE FOUND. `lib/banking/match.ts` has said "somebody has to write
        it up" since v1.18.0 and nothing in the banking module could.
      */}
      {unpostedLines.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              In the bank, not in the books
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Bank charges and interest can be written up from here, dated the
              day the bank has them. Anything else on this list is a document
              that belongs somewhere else — a vendor payment, a customer
              receipt, a transfer — and should be recorded there and matched
              here, not written up as an adjustment with no counterparty.
            </p>
            {unpostedLines.map((line) => {
              const outward = BigInt(line.amountMinor) < 0n;
              return (
                <div
                  key={line.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"
                >
                  <div className="min-w-0">
                    <div className="tabular-nums">
                      {line.valueDate} · {rupees(line.amountMinor)}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {line.narration}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        postAdjustmentAction({
                          statementLineId: line.id,
                          // ⚠️ THE SIGN DECIDES WHICH IS EVEN OFFERED. A
                          // charge cannot put money in and interest
                          // cannot take it out, and the server refuses a
                          // contradiction rather than trusting this.
                          kind: outward ? "bank_charge" : "interest_credited",
                        }),
                      )
                    }
                  >
                    {outward ? "Post as bank charge" : "Post as interest received"}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {history.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Signed reconciliations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {history.map((h) => (
              <div key={h.id} className="space-y-2 border-b pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums">{h.reconciledTo}</span>
                  <Badge variant={h.status === "signed_off" ? "secondary" : "outline"}>
                    {h.status === "signed_off" ? "signed off" : "reopened"}
                  </Badge>
                  {BigInt(h.differenceAbsorbedMinor) !== 0n ? (
                    <Badge variant="destructive">
                      {rupees(h.differenceAbsorbedMinor)} absorbed by tolerance
                    </Badge>
                  ) : null}
                </div>
                {h.status === "signed_off" ? (
                  reopening === h.id ? (
                    <div className="space-y-2">
                      <Label htmlFor={`reason-${h.id}`}>
                        Why is the signed figure wrong?
                      </Label>
                      <Input
                        id={`reason-${h.id}`}
                        value={reopenReason}
                        onChange={(e) => setReopenReason(e.target.value)}
                        placeholder="Somebody reading this in a year has to be able to act on it."
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending || reopenReason.trim().length < 20}
                        onClick={() =>
                          run(() =>
                            reopenAction({
                              reconciliationId: h.id,
                              reason: reopenReason.trim(),
                            }),
                          )
                        }
                      >
                        Reopen this reconciliation
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        The reconciliation row is kept and marked reopened, with
                        your reason on it. The lock goes back to exactly where it
                        stood before this was signed.
                      </p>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setReopening(h.id)}
                    >
                      Reopen…
                    </Button>
                  )
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
