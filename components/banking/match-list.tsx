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

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

interface Line {
  id: string;
  valueDate: string;
  amountMinor: string;
  narration: string;
  headline: string;
  ambiguous: boolean;
  matched: { kind: string; id: string; documentNo: string | null } | null;
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
  confirmAction: (i: unknown) => Promise<Result<{ matched: true }>>;
  unmatchAction: (i: unknown) => Promise<Result<{ unmatched: true }>>;
}) {
  const [pending, startTransition] = useTransition();

  function confirm(line: Line, r: Ranked) {
    startTransition(async () => {
      const res = await confirmAction({
        statementLineId: line.id,
        matchedKind: r.kind,
        matchedId: r.candidateId,
        proposedScore: r.score,
        wasAmbiguous: line.ambiguous,
      });
      if (!res.ok) toast.error(res.error);
      else toast.success("Matched.");
    });
  }

  function drop(line: Line) {
    startTransition(async () => {
      const res = await unmatchAction({ statementLineId: line.id });
      if (!res.ok) toast.error(res.error);
      else toast.success("Unmatched.");
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
              {line.matched && <Badge>matched</Badge>}
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

            {line.matched ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  {line.matched.documentNo ?? line.matched.kind}
                </span>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={pending}
                  onClick={() => drop(line)}
                >
                  Unmatch
                </Button>
              </div>
            ) : (
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
                  <Button
                    variant="secondary"
                    className="mt-2 h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() => confirm(line, r)}
                  >
                    These are the same thing
                  </Button>
                </div>
              ))
            )}
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
