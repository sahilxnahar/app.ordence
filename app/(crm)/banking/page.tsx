/**
 * Ordence — ⭐ BANK RECONCILIATION
 * Version: v1.18.0-alpha
 *
 * 🔴 The statement is the truth about the bank. The ledger is the truth
 * about the business. This screen explains the difference; it never
 * removes it.
 */

import { getBankAccounts, importStatement } from "@/server/actions/banking";
import { ReconciliationWorkspace } from "@/components/banking/reconciliation-workspace";

export const dynamic = "force-dynamic";

export const metadata = { title: "Bank reconciliation · Ordence" };

export default async function BankingPage() {
  const result = await getBankAccounts();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Bank reconciliation</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Bank reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Two lists, not one number. Money that moved through the bank without
          being recorded here needs writing up. Money recorded here that has not
          reached the bank is usually a cheque waiting to be presented, and
          occasionally a customer who has not actually paid.
        </p>
      </div>

      <ReconciliationWorkspace
        accounts={result.data.accounts}
        statements={result.data.statements}
        importAction={importStatement}
      />
    </main>
  );
}
