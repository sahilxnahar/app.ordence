/**
 * Ordence — ⭐ BANK RECONCILIATION
 * Version: v1.18.0-alpha
 *
 * 🔴 The statement is the truth about the bank. The ledger is the truth
 * about the business. This screen explains the difference; it never
 * removes it.
 */

import {
  createBankAccount,
  getBankAccounts,
  importStatement,
} from "@/server/actions/banking";
import { ReconciliationWorkspace } from "@/components/banking/reconciliation-workspace";
import { NewBankAccountForm } from "@/components/banking/new-bank-account-form";

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

      {/*
        ⭐ v1.39.0 (Batch 36): THE FORM IS ABOVE THE WORKSPACE WHEN THERE
        ARE NO ACCOUNTS, AND BELOW IT ONCE THERE ARE.

        🔴 An empty workspace used to be indistinguishable from a new
        workspace that had simply not added an account yet, which is
        exactly why nobody noticed that `insert(bankAccounts)` appeared
        nowhere in the tree. With no accounts, the first thing on the
        page is now the thing to do about it.
      */}
      {result.data.accounts.length === 0 ? (
        <NewBankAccountForm action={createBankAccount} suggestedCode="1010" />
      ) : null}

      <ReconciliationWorkspace
        accounts={result.data.accounts}
        statements={result.data.statements}
        importAction={importStatement}
      />

      {result.data.accounts.length > 0 ? (
        <NewBankAccountForm action={createBankAccount} suggestedCode="1010" />
      ) : null}
    </main>
  );
}
