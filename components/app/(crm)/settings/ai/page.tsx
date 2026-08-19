/**
 * Ordence — Settings · AI assistant
 * Version: v1.65.0-alpha  (was v0.83.0-alpha)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS PAGE USED TO BE, AND WHY THAT WAS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * It read `process.env` by name and listed seven providers as configured
 * or not. That made "which providers exist" a PLATFORM-WIDE FACT shown
 * inside a customer's workspace — every tenant saw the same seven lights
 * and none of them was about their workspace.
 *
 * ⚠️ IT ALSO HARD-CODED THE LIST. Seven names, typed out, against a
 * registry that holds nine. OpenRouter and its `keyUrl` were absent, so
 * the one provider actually configured on the live deployment did not
 * appear on the screen that exists to say which providers are configured.
 * The list now comes from `AI_PROVIDERS` through the server, which is
 * the only copy.
 *
 * ⭐ AND IT IS NOW ABOUT THIS WORKSPACE. Which key answers each provider
 * — theirs or ours — what it cost them last time it failed, and where to
 * get one of their own.
 *
 * ⚠️ NOT ONE FIELD ON THIS PAGE SHOWS A CREDENTIAL. The server action
 * cannot return one.
 */

import Link from "next/link";
import { requirePageContext } from "@/server/tenant-context";
import { BUSINESS_AGENTS } from "@/lib/ai/agents/registry";
import {
  getAiProviders,
  /**
   * ⭐⭐⭐ 0115 — whose credits. `getAiSpend` is the only read that can
   * tell a customer whether "your own keys only" is actually true, and
   * before this it did not exist.
   */
  getAiSpend,
  removeAiProviderKey,
  saveAiProviderKey,
  setAiProviderEnabled,
} from "@/server/actions/ai-credentials";
import { ProviderKeyManager } from "@/components/ai/provider-key-manager";
import { AiSpendPanel } from "@/components/ai/spend-panel";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI assistant · Ordence" };

/**
 * ⚠️ Read at call time, inside the request, never at module scope. A
 * module-level read runs during `next build`, when the value is
 * legitimately absent, and freezes it for the process lifetime.
 */
function readEnv(name: string): boolean {
  try {
    const v = process.env[name];
    return typeof v === "string" && v.length > 0;
  } catch {
    return false;
  }
}

export default async function AiSettingsPage() {
  await requirePageContext();

  const [result, spend] = await Promise.all([getAiProviders(), getAiSpend()]);

  if (!result.ok) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">AI assistant</h2>
        <p className="text-sm text-destructive">{result.error}</p>
      </div>
    );
  }

  const {
    rows,
    schemaReady,
    vaultReady,
    vaultMessage,
    confidentialProvidersAvailable,
  } = result.data;

  const usingOwnKey = rows.filter((r) => r.effectiveSource === "tenant").length;
  const anyProvider = rows.filter((r) => r.effectiveSource !== null).length;

  return (
    <div className="space-y-8">
      {spend.ok && (
        <AiSpendPanel
          policy={spend.data.policy}
          policyLabel={spend.data.policyLabel}
          policyExplains={spend.data.policyExplains}
          rows={spend.data.rows}
          platformCalls={spend.data.platformCalls}
          tenantCalls={spend.data.tenantCalls}
          sinceIso={spend.data.sinceIso}
        />
      )}

      <div>
        <h2 className="text-lg font-medium">AI assistant</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {anyProvider === 0
            ? "No AI provider is available to this workspace. Add one of your own below, or ask Ordence to configure one."
            : `${anyProvider} provider${anyProvider === 1 ? "" : "s"} available` +
              (usingOwnKey > 0
                ? `, ${usingOwnKey} on ${usingOwnKey === 1 ? "a key" : "keys"} you supplied.`
                : ", all on Ordence's shared keys.")}
        </p>
      </div>

      {/* Providers */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Providers</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          A key you supply here is used only by this workspace, spends only your
          quota, and is billed to you. It is stored encrypted and no Ordence
          screen can read it back.
        </p>

        <ProviderKeyManager
          rows={rows}
          vaultReady={vaultReady}
          vaultMessage={vaultMessage}
          schemaReady={schemaReady}
          confidentialProvidersAvailable={confidentialProvidersAvailable}
          saveAction={saveAiProviderKey}
          removeAction={removeAiProviderKey}
          setEnabledAction={setAiProviderEnabled}
        />
      </section>

      {/* Agents */}
      <section>
        <h3 className="mb-3 text-sm font-semibold">
          Business agents ({BUSINESS_AGENTS.length})
        </h3>
        <div className="space-y-2">
          {BUSINESS_AGENTS.map((agent) => (
            <div key={agent.id} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{agent.label}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                  {agent.sensitivity === "tenant"
                    ? "sees your data"
                    : "drafting only"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{agent.blurb}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {agent.tools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Goal planner */}
      <section className="rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Goal planner</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The goal planner turns a sentence describing what you want automated
          into a workflow draft. A goal usually names your own customers,
          projects and money, so it uses the same providers that are allowed to
          see your data — not the drafting-only ones.
        </p>
        <Link
          href="/assistant"
          className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
        >
          Open assistant →
        </Link>
      </section>

      {/* Background workers */}
      <section className="rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">
          Background intelligence monitors (6)
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Six scheduled monitors that analyse your data and raise notifications:
          GST deadlines, receivables aging, GSTR-2B reconciliation drift,
          inventory reorder, compliance gaps, and site labour anomalies.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {/**
           * ⭐ TWO SEPARATE PRECONDITIONS, REPORTED SEPARATELY.
           *
           * 🔴 A monitor that cannot be triggered and a monitor that has
           * nowhere safe to ask are different failures with different
           * fixes, and one line saying "workers unavailable" would send
           * the customer to look at the wrong one.
           */}
          {readEnv("WORKER_API_SECRET")
            ? "The scheduler can trigger them."
            : "⚠ WORKER_API_SECRET is not set, so nothing can trigger them. That is Ordence's to fix."}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {confidentialProvidersAvailable > 0
            ? `${confidentialProvidersAvailable} provider${confidentialProvidersAvailable === 1 ? " is" : "s are"} permitted to analyse your data, so they can run.`
            : "⚠ No provider is permitted to see your data, so every run will refuse rather than send your records to a model that may train on them. Add a Cloudflare Workers AI key above."}
        </p>
      </section>
    </div>
  );
}
