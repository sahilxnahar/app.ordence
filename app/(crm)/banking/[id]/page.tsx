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
  getStatementWorkspace,
  unmatch,
} from "@/server/actions/banking";
import { MatchList } from "@/components/banking/match-list";

export const dynamic = "force-dynamic";

export const metadata = { title: "Match statement · Ordence" };

export default async function StatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getStatementWorkspace({ statementId: id });

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
    </main>
  );
}
