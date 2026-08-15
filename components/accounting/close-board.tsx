"use client";

/**
 * Ordence — ⭐⭐⭐ CLOSING A MONTH
 * Version: v1.27.0-alpha · Batch 19
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SCREEN IS A WORKLIST, NOT A CONFIRMATION DIALOG
 * ══════════════════════════════════════════════════════════════════════
 * The close button is the least important thing on this page. What
 * matters is the list above it: every document dated in this month that
 * is not in the ledger, what sealing the month would do to it, and a
 * link to go and post it.
 *
 * ⚠️ SO THE BUTTON IS AT THE BOTTOM AND THE LIST IS AT THE TOP, and the
 * override is not offered at all until somebody has read what it would
 * do. A screen that leads with "Close period" and puts the warnings
 * underneath is a screen that gets clicked through.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type CloseItemView = {
  key: string;
  source: string;
  count: number;
  headline: string;
  consequence: string;
  where: string;
  amountMinor: string | null;
  oldest: string | null;
};

export type CloseReadinessData = {
  periodName: string;
  startDate: string;
  endDate: string;
  hasEnded: boolean;
  ready: boolean;
  headline: string;
  strandedCount: number;
  overrideWarning: string | null;
  blocking: CloseItemView[];
  advisory: CloseItemView[];
};

type Result = { ok: true; data: unknown } | { ok: false; error: string };

function rupees(minor: string): string {
  const value = BigInt(minor || "0");
  const whole = (value / 100n).toString();
  const paise = (value % 100n).toString().padStart(2, "0");
  return `₹${groupIndian(whole)}.${paise}`;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

function ItemCard({ item, blocking }: { item: CloseItemView; blocking: boolean }) {
  return (
    <Card
      className={blocking ? "border-destructive" : undefined}
      data-testid={`close-${item.key}`}
    >
      <CardContent className="space-y-1 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={item.where} className="font-medium underline">
            {item.headline}
          </Link>
          {blocking ? (
            <Badge variant="destructive">stops the close</Badge>
          ) : (
            <Badge variant="secondary">worth a look</Badge>
          )}
          {item.amountMinor && BigInt(item.amountMinor) > 0n ? (
            <span className="ml-auto font-semibold">{rupees(item.amountMinor)}</span>
          ) : null}
        </div>
        {item.oldest ? (
          <p className="text-xs text-muted-foreground">oldest dated {item.oldest}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">{item.consequence}</p>
      </CardContent>
    </Card>
  );
}

export function CloseBoard({
  periodId,
  data,
  canClose,
  onClose,
}: {
  periodId: string;
  data: CloseReadinessData;
  canClose: boolean;
  /**
   * ⚠️ TYPED, NOT `unknown`. `closeFinancialPeriod` takes a
   * `ClosePeriodInput` rather than parsing an opaque payload, so the
   * prop has to match it — and that is worth keeping: it means adding a
   * field to the close schema breaks this file at compile time instead
   * of silently sending a payload the action drops.
   */
  onClose: (input: {
    periodId: string;
    closingNotes?: string;
    forceUnbalanced?: boolean;
    strandDocumentsReason?: string;
  }) => Promise<Result>;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [showOverride, setShowOverride] = useState(false);

  function run(input: Parameters<typeof onClose>[0], ok: string) {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await onClose(input);
      if (result.ok) setMessage(ok);
      else setError(result.error);
    });
  }

  return (
    <div className="space-y-4">
      <Card className={data.ready ? undefined : "border-destructive"}>
        <CardContent className="pt-4">
          <p className="text-lg font-medium">{data.headline}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {data.periodName} · {data.startDate} to {data.endDate}
          </p>
        </CardContent>
      </Card>

      {/*
        ⭐ A MONTH THAT HAS NOT ENDED IS ITS OWN REFUSAL, and it is shown
        before the worklist because nothing on that list is worth doing
        yet — more documents are still arriving.
      */}
      {!data.hasEnded ? (
        <Card className="border-destructive">
          <CardContent className="pt-4 text-sm">
            This period has not ended yet. It cannot be declared final while more can still
            happen in it — everything recorded for the rest of the month would be locked out
            of the month it happened in.
          </CardContent>
        </Card>
      ) : null}

      {data.blocking.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">
            Post these first — {data.strandedCount} document
            {data.strandedCount === 1 ? "" : "s"}
          </h2>
          {data.blocking.map((item) => (
            <ItemCard key={item.key} item={item} blocking />
          ))}
        </div>
      ) : null}

      {data.advisory.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Worth knowing, does not stop the close</h2>
          {data.advisory.map((item) => (
            <ItemCard key={item.key} item={item} blocking={false} />
          ))}
        </div>
      ) : null}

      {message ? <p className="text-sm">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {canClose && data.hasEnded ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Close {data.periodName}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="close-notes">Closing notes</Label>
              <Textarea
                id="close-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything a person reading this in a year should know."
              />
            </div>

            {data.ready ? (
              <Button
                type="button"
                disabled={pending}
                onClick={() =>
                  run({ periodId, closingNotes: notes || undefined }, "Period closed.")
                }
              >
                Close the period
              </Button>
            ) : (
              <div className="space-y-3">
                {/*
                  🔴 THE OVERRIDE IS BEHIND A SECOND CLICK AND NEEDS A
                  WRITTEN REASON, WHERE THE UNBALANCED OVERRIDE NEEDS
                  NEITHER — because an unbalanced period is visible on
                  every report anybody ever runs, and a period sealed
                  over missing entries looks perfect. It balances: the
                  missing entries are missing from both sides.
                */}
                {!showOverride ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      The close is blocked until those documents are posted. If they
                      genuinely do not belong in this month, it can be closed anyway.
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setShowOverride(true)}
                    >
                      Close anyway, and say why
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-destructive">{data.overrideWarning}</p>
                    <div className="space-y-1">
                      <Label htmlFor="close-reason">
                        Why are these documents being left out of this month?
                      </Label>
                      <Textarea
                        id="close-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="A sentence somebody reading the audit log in a year can understand."
                      />
                    </div>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={pending || reason.trim().length < 20}
                      onClick={() =>
                        run(
                          {
                            periodId,
                            closingNotes: notes || undefined,
                            strandDocumentsReason: reason,
                          },
                          "Period closed with documents left outside it. The audit log names them.",
                        )
                      }
                    >
                      Close {data.periodName} with {data.strandedCount} document
                      {data.strandedCount === 1 ? "" : "s"} stranded
                    </Button>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {!canClose ? (
        <p className="text-xs text-muted-foreground">
          ⚠️ You can see what is outstanding and cannot close the period. That separation is
          deliberate: recording numbers and declaring them final are different jobs, and the
          Accountant role holds the first and not the second.
        </p>
      ) : null}
    </div>
  );
}
