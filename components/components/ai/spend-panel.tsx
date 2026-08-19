"use client";

/**
 * Ordence — ⭐⭐⭐ WHOSE AI CREDITS
 * Version: v1.72.0-alpha (0115)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE NUMBER THIS SCREEN EXISTS FOR IS `platformCalls`
 * ══════════════════════════════════════════════════════════════════════
 * A workspace on "your own keys only" should see it at **zero**. If it is
 * not zero then either the policy is not what they were told, or the
 * resolver has a hole — and either way somebody should find that out from
 * this screen rather than from an invoice.
 *
 * ⚠️ THE SPLIT BY WHOSE KEY IS THE WHOLE DESIGN. A combined "you used
 * 1.4M tokens" answers a question nobody is asking. Split, it answers
 * "how much of it did Ordence pay for", which is the only version that
 * changes anything.
 *
 * ⭐ AND THE POLICY IS SHOWN WITHOUT A CONTROL. A workspace cannot move
 * itself onto Ordence's keys — that is Ordence's decision and it is made
 * in the platform console with a reason recorded. Showing the setting
 * with no switch is honest; hiding it would leave the customer unable to
 * explain their own bill.
 */

import { Badge } from "@/components/ui/badge";

export type SpendRow = {
  providerId: string;
  credentialSource: string;
  calls: number;
  failedCalls: number;
  totalTokens: number;
};

export function AiSpendPanel({
  policy,
  policyLabel,
  policyExplains,
  rows,
  platformCalls,
  tenantCalls,
  sinceIso,
}: {
  policy: string;
  policyLabel: string;
  policyExplains: string;
  rows: readonly SpendRow[];
  platformCalls: number;
  tenantCalls: number;
  sinceIso: string;
}) {
  const since = sinceIso.slice(0, 10);
  const byoOnly = policy === "byo_required";

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Whose keys paid for this</h3>
        <Badge variant={byoOnly ? "default" : "secondary"}>{policyLabel}</Badge>
      </div>

      <p className="text-sm text-muted-foreground">{policyExplains}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase text-muted-foreground">
            Calls on your keys
          </p>
          <p className="text-2xl font-semibold tabular-nums">{tenantCalls}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-muted-foreground">
            Calls on Ordence&apos;s keys
          </p>
          {/**
           * 🔴 RED WHEN IT SHOULD BE ZERO AND IS NOT. Under
           * `byo_required` the platform set is not merged at all, so a
           * non-zero here means something is not as described. Saying so
           * plainly is better than a number the customer has to interpret.
           */}
          <p
            className={
              byoOnly && platformCalls > 0
                ? "text-2xl font-semibold tabular-nums text-destructive"
                : "text-2xl font-semibold tabular-nums"
            }
          >
            {platformCalls}
          </p>
          {byoOnly && platformCalls > 0 && (
            <p className="text-xs text-destructive">
              🔴 This should be zero on this policy. These calls predate the
              policy change, or something is not as described — tell Ordence.
            </p>
          )}
          {byoOnly && platformCalls === 0 && (
            <p className="text-xs text-muted-foreground">
              As it should be. Nothing here is charged to Ordence.
            </p>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No AI calls recorded since {since}.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2 font-medium">Provider</th>
                <th className="py-2 font-medium">Whose key</th>
                <th className="py-2 text-right font-medium">Calls</th>
                <th className="py-2 text-right font-medium">Failed</th>
                <th className="py-2 text-right font-medium">Tokens</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={`${r.providerId}:${r.credentialSource}`}>
                  <td className="py-2">{r.providerId}</td>
                  <td className="py-2">
                    <Badge
                      variant={
                        r.credentialSource === "platform"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {r.credentialSource === "platform" ? "Ordence" : "Yours"}
                    </Badge>
                  </td>
                  <td className="py-2 text-right tabular-nums">{r.calls}</td>
                  {/**
                   * ⚠️ FAILURES ARE SHOWN, because a workspace whose key
                   * is broken retries all day and every retry cost tokens
                   * at the provider. A table of successes only would show
                   * that workspace as cheapest in the month it cost most.
                   */}
                  <td className="py-2 text-right tabular-nums">
                    {r.failedCalls > 0 ? (
                      <span className="text-destructive">{r.failedCalls}</span>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {r.totalTokens > 0 ? r.totalTokens.toLocaleString("en-IN") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Since {since}. ⚠️ A blank token count means the provider did not report
        usage on those calls, which is not the same as zero — it is recorded as
        unknown rather than counted as nothing.
      </p>
    </section>
  );
}
