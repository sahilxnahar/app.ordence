/**
 * Ordence — Platform Console · ⭐⭐ THE CONFIGURATION CHAIN, GLOBALLY
 * Version: v1.43.0-alpha (Batch 47)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PAGE IS FOR, AND WHY IT HAS NO SAVE BUTTON
 * ══════════════════════════════════════════════════════════════════════
 * The per-workspace chain is editable on
 * `/platform/tenants/[id]/configure`. This page is the other half of the
 * same question: what does the chain say BEFORE anybody has thought
 * about a particular customer?
 *
 * ⚠️ THE GLOBAL AND PLAN LAYERS ARE CODE, AND THEY ARE MEANT TO BE. They
 * are the price list and the product's own defaults; changing them moves
 * every workspace that never disagreed, which is a decision that belongs
 * in a reviewed diff rather than in a text box at 03:00. So this screen
 * publishes them and does not offer to change them — a read-only screen
 * that says why is a control; an editable one here would be a way to
 * re-price every customer at once with no review.
 *
 * ⭐ AND IT NAMES THE READER OF EVERY VALUE. A configuration key nothing
 * consumes is the exact fault this batch was written to fix, so the
 * catalogue is forced to declare its consumers and this page prints
 * them. If a key ever appears here with no reader, that is a bug report
 * on a screen.
 */

import { consoleHref, onConsoleHost } from "@/lib/platform/console-href";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlatformOperator } from "@/server/platform/guard";
import {
  CONFIG_KEYS,
  configDefinition,
  formatConfigValue,
} from "@/lib/platform/config-chain";
import { APPROVAL_POLICIES } from "@/lib/platform/approvals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PlanTier } from "@/db/schema/core";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Configuration chain · Ordence Platform",
  robots: { index: false, follow: false },
};

const TIERS: readonly PlanTier[] = ["trial", "basic", "advanced", "ai", "enterprise"];

export default async function PlatformConfigPage() {
  // ⚠️ The console is served at two base paths. See
  // `lib/platform/console-href.ts` , a `/platform/...` link on the
  // console host is not a rewritten path and lands on a 404.
  const isConsole = await onConsoleHost();

  // ⚠️ The page-level check is a courtesy, not the boundary. Every read
  // and write behind the per-workspace screens re-checks its own
  // capability, because a server action is a POST to whatever URL the
  // browser is on and this route's protection does not extend to it.
  const operator = await getPlatformOperator();
  if (!operator) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Configuration chain</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every setting resolves <strong>global default → plan level → workspace
          override → effective value</strong>. The first two layers are code and ship in a
          reviewed diff; only the workspace override is data, and it carries whoever set it
          and why. Overrides are set per workspace on that workspace&rsquo;s configure
          screen.
        </p>
      </div>

      {CONFIG_KEYS.map((key) => {
        const def = configDefinition(key);
        return (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                {def.label}
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {key}
                </span>
                <Badge variant="outline">{def.type}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">{def.description}</p>

              <div className="rounded-md border border-border p-3 text-xs">
                <p>
                  <span className="text-muted-foreground">Global default: </span>
                  <strong>{formatConfigValue(key, def.globalDefault)}</strong>
                </p>
                <ul className="mt-2 space-y-1">
                  {TIERS.map((tier) => {
                    const value = def.planDefaults[tier];
                    return (
                      <li key={tier}>
                        <span className="text-muted-foreground">{tier}: </span>
                        {value === undefined ? (
                          <span className="italic text-muted-foreground">
                            inherits the global default
                          </span>
                        ) : (
                          <strong>{formatConfigValue(key, value)}</strong>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>

              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">What reads this value</summary>
                <ul className="mt-1 ml-4 list-disc space-y-1">
                  {def.consumers.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </details>
            </CardContent>
          </Card>
        );
      })}

      {/*
        ══════════════════════════════════════════════════════════════
        ⭐⭐ THE APPROVALS POLICY LIST, JOINED TO THE CHAIN
        ══════════════════════════════════════════════════════════════
        `/platform/approvals` publishes the six held actions as prose.
        That list was decorative in a specific way: nothing about a
        workspace could change any of it, so it was a poster describing
        constants.

        ⭐ ONE NUMBER IN IT IS NOW DATA. `tenant.terminate`'s cancel
        window is `offboarding.cancel_window_hours`, resolved per
        workspace and read by `scheduleTenantTermination` — an
        enterprise customer really does get a longer window than a trial.

        ⚠️ AND THE REST IS STILL CONSTANTS, WHICH IS SAID HERE RATHER
        THAN IMPLIED AWAY. Approver grade and the request-expiry hours
        live in `lib/platform/approvals.ts`, which this batch does not
        own. Pretending the whole table were configurable would be the
        same failure one level up.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What the chain governs in the approval queue</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {APPROVAL_POLICIES.map((p) => {
            const governed = p.kind === "tenant.terminate";
            return (
              <div key={p.kind} className="rounded-md border border-border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.label}</span>
                  <span className="font-mono text-muted-foreground">{p.kind}</span>
                  <Badge variant={governed ? "outline" : "secondary"}>
                    {governed ? "chain-governed" : "code constants only"}
                  </Badge>
                </div>
                <p className="mt-1 text-muted-foreground">
                  {p.approverGrade} approves · the request itself expires in {p.expiryHours}h
                  {governed
                    ? ` · once approved, the cancel window is offboarding.cancel_window_hours (${formatConfigValue(
                        "offboarding.cancel_window_hours",
                        configDefinition("offboarding.cancel_window_hours").globalDefault,
                      )} by default, longer on enterprise) and retention is offboarding.retention_days`
                    : " · nothing in the chain changes this for a particular workspace"}
                </p>
              </div>
            );
          })}
          <p className="border-t pt-3 text-muted-foreground">
            Approver grade and request expiry are constants in{" "}
            <code className="font-mono">lib/platform/approvals.ts</code>. They are not
            per-workspace and this screen does not pretend otherwise.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm">
        <Link href={consoleHref("/platform/tenants", isConsole)} className="underline">
          Set an override on a workspace
        </Link>
      </p>
    </div>
  );
}
