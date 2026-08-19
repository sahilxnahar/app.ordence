"use client";

/**
 * Ordence — ⭐⭐⭐ CONFIRMING A MATCH
 * Version: v1.18.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THERE IS NO "MATCH ALL" BUTTON AND THERE WILL NOT BE ONE
 * ══════════════════════════════════════════════════════════════════════
 * Two payments of the same amount on the same day score identically,
 * match each other's statement lines perfectly, reconcile to zero, and
 * leave two vendor accounts wrong. Nothing anywhere reports it, because
 * the arithmetic is flawless.
 *
 * ⭐ SO AMBIGUITY IS SHOWN AS AMBIGUITY. Where the top candidates score
 * within a few points of each other the screen says choosing would be a
 * guess, and lists them all rather than putting one first and hoping.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

interface Ranked {
  candidateId: string;
  score: number;
  confidence: string;
  reasons: string[];
  kind: string;
  documentNo: string | null;
  occurredOn: string;
}

interface Allocation {
  kind: string;
  id: string;
  documentNo: string | null;
  allocatedMinor: string;
}

interface Line {
  id: string;
  valueDate: string;
  amountMinor: string;
  narration: string;
  headline: string;
  ambiguous: boolean;
  matched: { kind: string; id: string; documentNo: string | null } | null;
  /**
   * ⭐⭐ EVERY ALLOCATION ON THIS LINE — 0110. One receipt against three
   * invoices is three rows here, and the screen has to show all three or
   * the operator cannot tell which one is wrong.
   */
  allocations: Allocation[];
  /** 🔴 SIGNED PAISE. Zero means fully explained. */
  residueMinor: string;
  ranked: Ranked[];
}

function rupees(minor: string): string {
  const n = BigInt(minor);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = (abs / 100n).toString();
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "−" : ""}₹${whole}.${paise}`;
}

export function MatchList({
  lines,
  summary,
  confirmAction,
  unmatchAction,
}: {
  lines: readonly Line[];
  summary: {
    ledgerClosingMinor: string;
    statementClosingMinor: string;
    inBankNotBooksMinor: string;
    inBooksNotBankMinor: string;
    unexplainedMinor: string;
    reconciles: boolean;
    notes: string[];
  };
  confirmAction: (i: unknown) => Promise<
    Result<{ matched: true; allocatedMinor: string; residueMinor: string; note: string }>
  >;
  unmatchAction: (
    i: unknown,
  ) => Promise<Result<{ unmatched: true; residueMinor: string; note: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  /**
   * ⚠️ KEYED BY LINE AND CANDIDATE. One override box per line would put
   * the amount typed for one invoice onto whichever candidate was
   * clicked next, which is a wrong allocation that looks like a typo.
   */
  const [override, setOverride] = useState<Record<string, string>>({});

  function confirm(line: Line, r: Ranked) {
    const key = `${line.id}:${r.candidateId}`;
    const typed = override[key]?.trim();
    startTransition(async () => {
      const res = await confirmAction({
        statementLineId: line.id,
        matchedKind: r.kind,
        matchedId: r.candidateId,
        /**
         * 🔴 OMITTED WHEN THE BOX IS EMPTY, AND THE SERVER THEN USES
         *    WHAT IS LEFT ON THE LINE — not the whole line. Sending "0"
         *    or the full amount from here would put the default in two
         *    places, and the one on the client is the one that goes
         *    stale while somebody else is matching the same statement.
         */
        ...(typed !== undefined && typed.length > 0
          ? { allocatedMinor: typed }
          : {}),
        proposedScore: r.score,
        wasAmbiguous: line.ambiguous,
      });
      if (!res.ok) toast.error(res.error);
      else toast.success(res.data.note);
    });
  }

  function drop(line: Line, allocation?: Allocation) {
    startTransition(async () => {
      const res = await unmatchAction({
        statementLineId: line.id,
        ...(allocation
          ? { matchedKind: allocation.kind, matchedId: allocation.id }
          : {}),
      });
      if (!res.ok) toast.error(res.error);
      else toast.success(res.data.note);
    });
  }

  return (
    <div className="space-y-6">
      {/**
       * ⭐ THE RECONCILIATION STATEMENT FIRST. It is the answer; the
       * lines below are the working.
       */}
      <Card className={summary.reconciles ? undefined : "border-destructive"}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {summary.reconciles
              ? "This account reconciles."
              : "This account does not reconcile."}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <Row label="What our books say" value={rupees(summary.ledgerClosingMinor)} />
            <Row label="What the bank says" value={rupees(summary.statementClosingMinor)} />
            <Row
              label="In the bank, not in the books"
              value={rupees(summary.inBankNotBooksMinor)}
            />
            <Row
              label="In the books, not in the bank"
              value={rupees(summary.inBooksNotBankMinor)}
            />
          </div>
          {!summary.reconciles && (
            <p className="font-medium text-destructive">
              Unexplained: {rupees(summary.unexplainedMinor)}
            </p>
          )}
          {summary.notes.map((n, i) => (
            <p key={i} className="text-muted-foreground">
              {n}
            </p>
          ))}
        </CardContent>
      </Card>

      {lines.map((line) => (
        <Card key={line.id}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base tabular-nums">
                {rupees(line.amountMinor)}
              </CardTitle>
              <Badge variant="secondary">{line.valueDate}</Badge>
              {/**
               * ⭐⭐ THREE STATES, NOT TWO — 0110. A line carrying an
               * allocation that does not cover it is NOT "matched", and
               * labelling it so is the screen telling a comfortable lie
               * about money that is still outstanding.
               */}
              {line.allocations.length > 0 &&
                (BigInt(line.residueMinor) === 0n ? (
                  <Badge>fully explained</Badge>
                ) : (
                  <Badge variant="destructive">
                    part explained · {rupees(line.residueMinor)} left
                  </Badge>
                ))}
              {line.ambiguous && <Badge variant="destructive">ambiguous</Badge>}
            </div>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {line.narration}
            </p>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className={line.ambiguous ? "text-destructive" : "text-muted-foreground"}>
              {line.headline}
            </p>

            {/**
             * ⭐ WHAT IS ALREADY ON THIS LINE, EACH REMOVABLE ON ITS OWN.
             * Before 0110 "Unmatch" cleared the line, because a line
             * could only hold one thing. With three allocations the
             * operator almost always wants to remove the one that is
             * wrong, and clearing all three to fix one invites the
             * second and third being re-entered from memory.
             */}
            {line.allocations.length > 0 && (
              <div className="space-y-2">
                {line.allocations.map((a) => (
                  <div
                    key={`${a.kind}:${a.id}`}
                    className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                  >
                    <span className="font-medium">{a.documentNo ?? a.kind}</span>
                    <Badge variant="secondary">{a.kind.replace(/_/g, " ")}</Badge>
                    <span className="tabular-nums text-muted-foreground">
                      {rupees(a.allocatedMinor)} of this line
                    </span>
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={pending}
                      onClick={() => drop(line, a)}
                    >
                      Unmatch this one
                    </Button>
                  </div>
                ))}
                {line.allocations.length > 1 && (
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() => drop(line)}
                  >
                    Clear this line
                  </Button>
                )}
              </div>
            )}

            {/**
             * 🔴 CANDIDATES ARE STILL OFFERED WHILE ANYTHING IS LEFT.
             * A partly explained line needs the next invoice, and a
             * screen that stops offering after the first match is a
             * screen where one receipt against three invoices is
             * representable in the database and unreachable by hand.
             */}
            {BigInt(line.residueMinor) !== 0n &&
              line.ranked.slice(0, 4).map((r) => (
                <div key={r.candidateId} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {r.documentNo ?? r.candidateId.slice(0, 8)}
                    </span>
                    <Badge variant="secondary">{r.kind.replace(/_/g, " ")}</Badge>
                    <Badge variant="secondary">{r.occurredOn}</Badge>
                    <Badge variant={r.confidence === "strong" ? "default" : "secondary"}>
                      {r.confidence}
                    </Badge>
                  </div>
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {r.reasons.map((reason, i) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      className="h-7 px-2 text-xs"
                      disabled={pending}
                      onClick={() => confirm(line, r)}
                    >
                      These are the same thing
                    </Button>
                    {/**
                     * ⚠️ PAISE, AND EMPTY BY DEFAULT. Empty means "what
                     * is left on this line", worked out by the server at
                     * the moment of the write. Pre-filling it here would
                     * put a figure on screen that goes stale the instant
                     * somebody else allocates against the same line.
                     *
                     * 🔴 THE REFUSAL IS WHAT MAKES THIS SAFE, not the
                     * box. Over-allocating is refused by the server AND
                     * by the trigger, and the refusal names how much is
                     * actually left.
                     */}
                    <Input
                      inputMode="numeric"
                      className="h-7 w-40 text-xs"
                      placeholder="paise, or leave blank"
                      aria-label={`How much of this line ${r.documentNo ?? "this document"} accounts for, in paise`}
                      value={override[`${line.id}:${r.candidateId}`] ?? ""}
                      onChange={(e) =>
                        setOverride((prior) => ({
                          ...prior,
                          [`${line.id}:${r.candidateId}`]: e.target.value,
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">
                      Blank allocates the {rupees(line.residueMinor)} still
                      unexplained on this line.
                    </span>
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
