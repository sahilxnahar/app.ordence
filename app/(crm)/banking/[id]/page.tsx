/**
 * Ordence — ⭐⭐ MATCHING ONE STATEMENT
 * Version: v1.18.0-alpha
 *
 * ⚠️ TWO LISTS, NOT ONE NUMBER. A single "unreconciled" figure combines
 * money that moved without being recorded with money recorded that has
 * not moved, and those are completely different problems with completely
 * different people responsible for them.
 */

import Link from "next/link";
import {
  confirmMatch,
  getReconciliationStatement,
  getStatementWorkspace,
  postBankLineAdjustment,
  reopenBankReconciliation,
  signOffReconciliation,
  unmatch,
} from "@/server/actions/banking";
import { MatchList } from "@/components/banking/match-list";
import { ReconciliationStatementPanel } from "@/components/banking/reconciliation-statement";

export const dynamic = "force-dynamic";

export const metadata = { title: "Match statement · Ordence" };

export default async function StatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getStatementWorkspace({ statementId: id });
  /**
   * ⭐ FETCHED ALONGSIDE THE MATCH LIST, NOT INSTEAD OF IT. Matching is
   * the input and the reconciliation is the output, and somebody working
   * a month needs both on one screen — the whole reason the statement
   * never got written up before is that it lived nowhere.
   */
  const brs = await getReconciliationStatement({ statementId: id });

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Match statement</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const d = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">{d.accountLabel}</h1>
        <p className="text-sm text-muted-foreground">
          {d.periodFrom} to {d.periodTo} ·{" "}
          <Link href="/banking" className="underline">
            all statements
          </Link>
        </p>
      </div>

      <MatchList
        lines={d.lines.map((l) => ({
          id: l.line.id,
          valueDate: l.line.valueDate,
          amountMinor: l.line.amountMinor.toString(),
          narration: l.line.narration,
          headline: l.proposal.headline,
          ambiguous: l.proposal.ambiguous,
          matched: l.matched,
          /**
           * ⭐ EVERY ALLOCATION AND THE RESIDUE — 0110. `bigint` cannot
           * cross into a client component, so both go as exact decimal
           * strings. Neither is ever a Number.
           */
          allocations: l.allocations.map((a) => ({
            kind: a.kind,
            id: a.id,
            documentNo: a.documentNo,
            allocatedMinor: a.allocatedMinor.toString(),
          })),
          residueMinor: l.residueMinor.toString(),
          ranked: l.proposal.ranked.map((r) => ({
            candidateId: r.candidateId,
            score: r.score,
            confidence: r.confidence,
            reasons: [...r.reasons],
            kind: l.candidatesById[r.candidateId]?.kind ?? "journal_entry",
            documentNo: l.candidatesById[r.candidateId]?.documentNo ?? null,
            occurredOn: l.candidatesById[r.candidateId]?.occurredOn ?? "",
          })),
        }))}
        summary={{
          ledgerClosingMinor: d.statement.ledgerClosingMinor.toString(),
          statementClosingMinor: d.statement.statementClosingMinor.toString(),
          inBankNotBooksMinor: d.statement.inBankNotBooksMinor.toString(),
          inBooksNotBankMinor: d.statement.inBooksNotBankMinor.toString(),
          unexplainedMinor: d.statement.unexplainedMinor.toString(),
          reconciles: d.statement.reconciles,
          notes: [...d.statement.notes],
        }}
        confirmAction={confirmMatch}
        unmatchAction={unmatch}
      />

      {brs.ok ? (
        <ReconciliationStatementPanel
          statementId={id}
          periodTo={brs.data.periodTo}
          reconciledTo={brs.data.reconciledTo}
          printable={brs.data.printable.map((l) => ({
            label: l.label,
            amountMinor: l.amountMinor.toString(),
            effect: l.effect,
          }))}
          reconcilesExactly={brs.data.brs.reconcilesExactly}
          signOffPermitted={brs.data.brs.signOffPermitted}
          differenceMinor={brs.data.brs.differenceMinor.toString()}
          differenceAbsorbedMinor={brs.data.brs.differenceAbsorbedMinor.toString()}
          toleranceMinor={brs.data.brs.toleranceMinor.toString()}
          notes={[
            ...brs.data.brs.notes,
            /**
             * ⭐⭐ THE UNCLAIMED INPUT CREDIT ON THIS PERIOD'S CHARGES —
             * 0110. It belongs on THIS screen and not only on its own
             * register: this is where bank charges are discovered and
             * written up gross, so it is where the consequence of doing
             * so should be read.
             */
            ...(brs.data.unclaimedCreditNote === null
              ? []
              : [brs.data.unclaimedCreditNote]),
          ]}
          unpostedLines={brs.data.brs.items
            .filter((i) => i.side === "bank")
            .map((i) => ({
              id: i.sourceId,
              valueDate: i.occurredOn,
              amountMinor: i.amountMinor.toString(),
              narration: i.description,
            }))}
          history={brs.data.history.map((h) => ({
            id: h.id,
            reconciledTo: h.reconciledTo,
            status: h.status,
            differenceAbsorbedMinor: h.differenceAbsorbedMinor,
          }))}
          signOffAction={signOffReconciliation}
          reopenAction={reopenBankReconciliation}
          postAdjustmentAction={postBankLineAdjustment}
        />
      ) : (
        <p className="text-sm text-destructive">{brs.error}</p>
      )}
    </main>
  );
}
