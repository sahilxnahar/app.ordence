"use client";

/**
 * Ordence — ⭐⭐⭐ CANCELLATIONS
 * Version: v1.25.0-alpha · Batch 17
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SCREEN LEADS WITH WHO IS STILL OWED MONEY
 * ══════════════════════════════════════════════════════════════════════
 * A cancelled booking is not an archive record. It is usually somebody
 * waiting for a refund, and how long they have been waiting is the
 * question a consumer forum asks in those words.
 *
 * ⚠️ SO A POSTED CANCELLATION WITH AN UNPAID REFUND IS THE MOST URGENT
 * ROW ON THIS PAGE, not the least. It is the one that has gone furthest
 * and still owes the most.
 */

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ServiceGapFinding } from "@/lib/receivables/service-evidence";

export type CancellationView = {
  id: string;
  reference: string;
  cancelledOn: string | null;
  cancelReason: string | null;
  forfeitMinor: string;
  refundMinor: string;
  agreementValueMinor: string | null;
  posted: boolean;
  refundPaid: boolean;
  refundPaidOn: string | null;
  creditNoteNumber: string | null;
  warning: string | null;
};

type PreviewData = {
  bookingReference: string;
  forfeitMinor: string;
  refundMinor: string;
  advanceMinor: string;
  receivableMinor: string;
  outputTaxMinor: string;
  outputCgstMinor: string;
  outputSgstMinor: string;
  outputIgstMinor: string;
  cashPaidMinor: string;
  alreadyPosted: boolean;
  hasPostings: boolean;
  problem: string | null;
  warning: string | null;
  /**
   * ⭐⭐⭐ WAS THE LADDER ACTUALLY SERVED? See
   * `lib/receivables/service-evidence.ts`. Not optional and not nullable
   * on purpose: a screen that can render without this field is a screen
   * that will.
   */
  serviceFinding: ServiceGapFinding;
  creditNoteWindowCloses: string | null;
  creditNoteWindowClosed: boolean;
  forfeitureCapBps: number;
};

type Result = { ok: true; data: unknown } | { ok: false; error: string };

function rupees(minor: string | bigint): string {
  const value = typeof minor === "bigint" ? minor : BigInt(minor || "0");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString();
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${groupIndian(whole)}.${paise}`;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

export function CancellationBoard({
  rows,
  unpostedCount,
  unpaidRefundMinor,
  canPost,
  onPreview,
  onPost,
  onRefund,
}: {
  rows: CancellationView[];
  unpostedCount: number;
  unpaidRefundMinor: string;
  canPost: boolean;
  onPreview: (input: {
    bookingId: string;
    reversedCgst?: string;
    reversedSgst?: string;
    reversedIgst?: string;
  }) => Promise<{ ok: true; data: PreviewData } | { ok: false; error: string }>;
  onPost: (input: unknown) => Promise<Result>;
  onRefund: (input: unknown) => Promise<Result>;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);

  const [cgst, setCgst] = useState("");
  const [sgst, setSgst] = useState("");
  const [igst, setIgst] = useState("");
  const [creditNote, setCreditNote] = useState("");

  function run(fn: () => Promise<Result>, ok: string) {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) setMessage(ok);
      else setError(result.error);
    });
  }

  function load(bookingId: string) {
    setError(null);
    setMessage(null);
    setOpenId(bookingId);
    startTransition(async () => {
      const result = await onPreview({
        bookingId,
        reversedCgst: cgst || undefined,
        reversedSgst: sgst || undefined,
        reversedIgst: igst || undefined,
      });
      if (result.ok) setPreview(result.data);
      else {
        setPreview(null);
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4">
          <p className="text-sm font-medium">Refunds owed to buyers who cancelled</p>
          <p className="mt-1 text-2xl font-semibold">{rupees(unpaidRefundMinor)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Posted and not yet paid. {unpostedCount} cancellation
            {unpostedCount === 1 ? " has" : "s have"} not reached the ledger at all, so nothing
            of theirs is counted here.
          </p>
        </CardContent>
      </Card>

      {message ? <p className="text-sm">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bookings have been cancelled.</p>
      ) : null}

      <div className="space-y-2">
        {rows.map((row) => {
          const owing = row.posted && !row.refundPaid && BigInt(row.refundMinor || "0") > 0n;

          return (
            <Card
              key={row.id}
              className={owing ? "border-destructive" : undefined}
              data-testid={`cancel-${row.reference}`}
            >
              <CardContent className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{row.reference}</span>
                  {row.posted ? (
                    <Badge variant="secondary">in the ledger</Badge>
                  ) : (
                    <Badge variant="outline">not posted</Badge>
                  )}
                  {owing ? <Badge variant="destructive">refund outstanding</Badge> : null}
                  {row.refundPaid ? (
                    <Badge variant="secondary">refunded {row.refundPaidOn}</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    cancelled {row.cancelledOn ?? "—"}
                  </span>
                </div>

                <p className="text-xs text-muted-foreground">
                  Forfeited {rupees(row.forfeitMinor)} · refund {rupees(row.refundMinor)}
                  {row.creditNoteNumber ? ` · credit note ${row.creditNoteNumber}` : ""}
                </p>
                {row.cancelReason ? (
                  <p className="text-xs text-muted-foreground">{row.cancelReason}</p>
                ) : null}

                {/*
                  🔴 THE FORFEITURE WARNING IS SHOWN ON EVERY ROW IT
                  APPLIES TO, not only while posting. It is a legal risk
                  that outlives the journal entry, and the moment it
                  matters most is when somebody is reviewing what was
                  decided.
                */}
                {row.warning ? (
                  <p className="text-xs text-destructive">{row.warning}</p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {canPost && !row.posted ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => load(row.id)}
                    >
                      Work out the entry
                    </Button>
                  ) : null}
                  {canPost && owing ? (
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        const reference = window.prompt("Payment reference (UTR or cheque)");
                        if (!reference) return;
                        const paidOn = window.prompt("Paid on (YYYY-MM-DD)");
                        if (!paidOn) return;
                        run(
                          () =>
                            onRefund({
                              bookingId: row.id,
                              amount: (BigInt(row.refundMinor) / 100n).toString(),
                              paidOn,
                              paymentReference: reference,
                            }),
                          "Refund posted.",
                        );
                      }}
                    >
                      Record the refund
                    </Button>
                  ) : null}
                </div>

                {openId === row.id && preview ? (
                  <div className="space-y-2 rounded-md border p-3" data-testid="cancel-preview">
                    <p className="text-sm font-medium">What the entry would clear</p>
                    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Advance from customers</dt>
                        <dd>{rupees(preview.advanceMinor)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Demands unpaid</dt>
                        <dd>{rupees(preview.receivableMinor)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Output tax charged</dt>
                        <dd>{rupees(preview.outputTaxMinor)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Buyer has paid</dt>
                        <dd>{rupees(preview.cashPaidMinor)}</dd>
                      </div>
                    </dl>

                    {/* ───────────────────────────────────────────────
                        ⭐⭐ THE SECTION 34 WINDOW, STATED BEFORE THE
                        FIELDS THAT DEPEND ON IT. Somebody typing a
                        reversal into a closed window is doing work
                        that will be refused, and the deadline is not
                        something anybody carries in their head.
                       ─────────────────────────────────────────────── */}
                    {preview.creditNoteWindowCloses ? (
                      <p
                        className={
                          preview.creditNoteWindowClosed
                            ? "text-xs text-destructive"
                            : "text-xs text-muted-foreground"
                        }
                      >
                        {preview.creditNoteWindowClosed
                          ? `⚠️ The section 34 credit-note window on this booking closed on ${preview.creditNoteWindowCloses}. The output tax can no longer be reversed — leave the reversal fields empty. It will be posted as an irrecoverable cost, which is what it is.`
                          : `A credit note under section 34 may still be issued until ${preview.creditNoteWindowCloses}. Anything not reversed by then is a permanent cost.`}
                      </p>
                    ) : null}

                    <div className="grid gap-2 sm:grid-cols-4">
                      <div className="space-y-1">
                        <Label htmlFor="cn-cgst" className="text-xs">
                          CGST reversed
                        </Label>
                        <Input
                          id="cn-cgst"
                          value={cgst}
                          onChange={(e) => setCgst(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="cn-sgst" className="text-xs">
                          SGST reversed
                        </Label>
                        <Input
                          id="cn-sgst"
                          value={sgst}
                          onChange={(e) => setSgst(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="cn-igst" className="text-xs">
                          IGST reversed
                        </Label>
                        <Input
                          id="cn-igst"
                          value={igst}
                          onChange={(e) => setIgst(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="cn-num" className="text-xs">
                          Credit note number
                        </Label>
                        <Input
                          id="cn-num"
                          value={creditNote}
                          onChange={(e) => setCreditNote(e.target.value)}
                        />
                      </div>
                    </div>

                    {/*
                      ══════════════════════════════════════════════════
                      🔴🔴 THE BLOCKING FINDING, AT THE ONE MOMENT IT
                           CHANGES ANYTHING
                      ══════════════════════════════════════════════════
                      Until SQL 0098 a demand notice recorded `sent_at`
                      the instant its row was created and nothing sent
                      anything, so this screen could show an operator a
                      complete-looking ladder for letters the allottee
                      never received. Forfeiting a family's money on that
                      basis is the developer's case collapsing at the
                      Authority — and the allottee is the one who was
                      actually wronged.

                      ⚠️ It warns rather than disabling the button: the
                      notice may have been served by a route this system
                      never saw. What it may not do is stay quiet.
                    */}
                    {preview.serviceFinding.blocking ? (
                      <div
                        className="rounded-md border border-destructive/50 bg-destructive/5 p-3"
                        data-testid="cancel-service-finding"
                        data-word={preview.serviceFinding.word}
                      >
                        <p className="text-xs font-medium text-destructive">
                          {preview.serviceFinding.headline}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {preview.serviceFinding.detail}
                        </p>
                      </div>
                    ) : (
                      <p
                        className="text-xs text-muted-foreground"
                        data-testid="cancel-service-finding"
                        data-word={preview.serviceFinding.word}
                      >
                        {preview.serviceFinding.headline}
                      </p>
                    )}

                    {preview.problem ? (
                      <p className="text-xs text-destructive">{preview.problem}</p>
                    ) : null}
                    {preview.warning ? (
                      <p className="text-xs text-destructive">{preview.warning}</p>
                    ) : null}
                    {!preview.hasPostings ? (
                      <p className="text-xs text-muted-foreground">
                        Nothing was ever posted against this booking — no demand was served and
                        no receipt landed on it. There are no balances to clear, so there is
                        nothing to post.
                      </p>
                    ) : null}

                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => load(row.id)}
                      >
                        Recalculate
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          pending || Boolean(preview.problem) || !preview.hasPostings
                        }
                        onClick={() =>
                          run(
                            () =>
                              onPost({
                                bookingId: row.id,
                                reversedCgst: cgst || undefined,
                                reversedSgst: sgst || undefined,
                                reversedIgst: igst || undefined,
                                creditNoteNumber: creditNote || undefined,
                              }),
                            "Posted. Every balance on this booking is cleared.",
                          )
                        }
                      >
                        Post the cancellation
                      </Button>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        ⚠️ Once posted, the forfeit, the refund and the tax reversal are frozen — they are in a
        trial balance and possibly in a filed return. If the decision changes afterwards, that is
        a further entry dated when it changed, not an edit. And brokerage already paid on a
        cancelled booking is usually recoverable under the partner agreement; Ordence does not
        raise that debit note automatically, because who to chase is a commercial decision.
      </p>
    </div>
  );
}
