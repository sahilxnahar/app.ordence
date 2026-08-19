/**
 * Ordence — ⭐⭐⭐ THE STATEMENT OF ACCOUNT, OR THE REASON THERE ISN'T ONE
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `figures` IS ABSENT WHEN THE STATEMENT DOES NOT RECONCILE, AND THIS
 *    COMPONENT MUST NOT PAPER OVER THAT
 * ══════════════════════════════════════════════════════════════════════
 * `getStatementOfAccount` refuses to produce figures when the demand
 * ledger and the books disagree. `server/actions/receivables.ts` explains
 * why at length: this document LEAVES THE BUILDING. A buyer keeps it and
 * produces it in a consumer forum when the developer's ledger says
 * something different, at which point the developer is explaining under
 * oath why their own two systems disagreed and nobody noticed.
 *
 * ⚠️ SO WHEN `figures` IS ABSENT, THIS RENDERS THE BREACH AND NOTHING
 * ELSE. Not a zero, not a dash, not a partial table. The narrative lives
 * inside `figures` for the same reason: every line of it quotes a rupee
 * amount, so printing the prose while withholding the totals would hand
 * over exactly the numbers the gate refused, in sentences , and prose
 * reads as MORE authoritative than a table because somebody appears to
 * have written it.
 *
 * ⚠️ A SERVER COMPONENT. It has no interaction and the figures are
 * already resolved; making it a client component would ship the
 * reconciliation vocabulary to the browser for no reason.
 */

import { AlertTriangle, FileText } from "lucide-react";

type Check = {
  id: string;
  claim: string;
  reportLabel: string;
  reportMinor: string;
  ledgerLabel: string;
  ledgerMinor: string;
  differenceMinor: string;
  toleranceMinor: string;
  breached: boolean;
  sentence: string;
};

export type StatementView = {
  asOf: string;
  figures?: {
    demandedMinor: string;
    receivedMinor: string;
    outstandingMinor: string;
    interestOutstandingMinor: string;
    creditMinor: string;
    payableTodayMinor: string;
    narrative: string[];
  };
  reconciliation: {
    subject: string;
    state: string;
    checks: Check[];
    breaches: string[];
    notes: string[];
    renderable: boolean;
  };
  breachCauses: string[];
};

function inr(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const paise = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${new Intl.NumberFormat("en-IN").format(whole)}.${paise}`;
}

export function StatementOfAccount({ statement }: { statement: StatementView }) {
  const { figures, reconciliation, breachCauses } = statement;

  return (
    <section aria-labelledby="statement-heading" className="space-y-3">
      <h2 id="statement-heading" className="flex items-center gap-2 text-lg font-semibold">
        <FileText className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        Statement of account
        <span className="text-sm font-normal text-muted-foreground">as at {statement.asOf}</span>
      </h2>

      {figures ? (
        <>
          <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Demanded</dt>
              <dd className="font-semibold tabular-nums">{inr(figures.demandedMinor)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Received</dt>
              <dd className="font-semibold tabular-nums">{inr(figures.receivedMinor)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Outstanding</dt>
              <dd className="font-semibold tabular-nums">{inr(figures.outstandingMinor)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Interest outstanding</dt>
              <dd className="font-semibold tabular-nums">
                {inr(figures.interestOutstandingMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Credit in hand</dt>
              <dd className="font-semibold tabular-nums">{inr(figures.creditMinor)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Payable today</dt>
              <dd className="font-semibold tabular-nums">{inr(figures.payableTodayMinor)}</dd>
            </div>
          </dl>

          {figures.narrative.length > 0 && (
            <ul className="space-y-1 rounded-md border border-border p-4 text-sm">
              {figures.narrative.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            No statement can be produced for this buyer today.
          </p>
          <p className="text-sm text-muted-foreground">
            The demand ledger and the books disagree, and this document is one a buyer keeps.
            Ordence will not hand over a figure it cannot stand behind.
          </p>
          {breachCauses.length > 0 && (
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {breachCauses.map((cause) => (
                <li key={cause}>{cause}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/*
        ⚠️ THE CHECKS ARE SHOWN EITHER WAY. When the statement reconciles
        they are the evidence that it does; when it does not they are the
        only route to fixing it. Hiding them on success would mean the
        first time anybody sees this table is the day it is bad news.
      */}
      {reconciliation.checks.length > 0 && (
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            How this reconciles to the books
          </summary>
          <ul className="mt-2 space-y-2 text-sm">
            {reconciliation.checks.map((check) => (
              <li key={check.id} className={check.breached ? "text-destructive" : ""}>
                <p>{check.sentence}</p>
                <p className="text-xs text-muted-foreground">
                  {check.reportLabel} {inr(check.reportMinor)} · {check.ledgerLabel}{" "}
                  {inr(check.ledgerMinor)} · difference {inr(check.differenceMinor)}
                </p>
              </li>
            ))}
          </ul>
          {reconciliation.notes.map((note, i) => (
            <p key={i} className="mt-2 text-xs text-muted-foreground">
              {note}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
