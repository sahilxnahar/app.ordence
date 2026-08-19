/**
 * Ordence — ⭐⭐⭐ INTEREST AND THE DUNNING LADDER
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE POLICIES DECIDE EVERY NUMBER ON EVERY DEMAND NOTICE, AND THERE
 *    WAS NO SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * `getReceivableSettings`, `saveReceivablePolicy` and `saveDunningPolicy`
 * were built and called by nothing. A workspace therefore had whatever
 * policy was seeded, and could not see it, let alone change it.
 *
 * These are not preferences. The interest rate goes on a legal document,
 * the appropriation order decides whether a payment clears principal or
 * interest first, and the ladder decides on which morning a letter leaves
 * the building.
 *
 * ⚠️ THE REFERENCE RATE IS WHY `exceedsReference` EXISTS. A demand
 * charging above it is routinely set aside IN FULL rather than reduced to
 * the permitted rate, so the flag is shown on the policy itself and not
 * only at the moment a demand is raised.
 */

import Link from "next/link";
import { ArrowLeft, Percent } from "lucide-react";

import {
  getReceivableSettings,
  saveDunningPolicy,
  saveReceivablePolicy,
} from "@/server/actions/receivables";
import { ReceivablePolicyForm } from "./receivable-policy-form";
import { DunningPolicyForm } from "./dunning-policy-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Receivables settings · Ordence" };

export default async function ReceivableSettingsPage() {
  const result = await getReceivableSettings();

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="space-y-3">
        <Link
          href="/receivables"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to receivables
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Percent className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          Interest and the dunning ladder
        </h1>
        <p className="text-sm text-muted-foreground">
          These decide the numbers on every demand notice and the morning each letter leaves.
        </p>
      </div>

      {!result.ok ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          {result.error}
        </p>
      ) : (
        <>
          {/*
            ⚠️ THE EXISTING POLICIES ARE LISTED WITH THEIR RATE FLAG
            BEFORE EITHER FORM. A workspace that already has a policy
            charging above the reference rate needs to see that before it
            is asked to add another one.
          */}
          {result.data.policies.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Interest policies</h2>
              <ul className="divide-y rounded-md border">
                {result.data.policies.map((policy) => (
                  <li key={policy.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                    <span className="font-medium">{policy.name}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {(policy.interestRateBps / 100).toFixed(2)}% a year
                    </span>
                    {policy.exceedsReference && (
                      <span className="text-xs text-destructive">
                        above the reference rate , a notice on these terms is routinely set
                        aside in full rather than reduced
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.data.ladders.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Dunning ladders</h2>
              <ul className="divide-y rounded-md border">
                {result.data.ladders.map((ladder) => (
                  <li key={ladder.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                    <span className="font-medium">{ladder.name}</span>
                    <span className="text-xs text-muted-foreground">
                      first reminder after {ladder.reminderAfterDays} days
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <ReceivablePolicyForm save={saveReceivablePolicy} />
          <DunningPolicyForm save={saveDunningPolicy} />
        </>
      )}
    </main>
  );
}
