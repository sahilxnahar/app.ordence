/**
 * Ordence — Settings · AI Assistant
 * Version: v0.83.0-alpha
 *
 * Shows the 7 AI agents, their tool whitelists, and which providers
 * are available. Read-only status display.
 */

import { requirePageContext } from "@/server/tenant-context";
import { BUSINESS_AGENTS } from "@/lib/ai/agents/registry";

export const dynamic = "force-dynamic";

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

  const providers = [
    { name: "Cloudflare Workers AI", key: "CF_AI_TOKEN", lane: "Confidential", configured: readEnv("CF_AI_TOKEN") },
    { name: "Groq", key: "GROQ_API_KEY", lane: "Open", configured: readEnv("GROQ_API_KEY") },
    { name: "Google AI (Gemini)", key: "GOOGLE_AI_API_KEY", lane: "Open", configured: readEnv("GOOGLE_AI_API_KEY") },
    { name: "Mistral", key: "MISTRAL_API_KEY", lane: "Open", configured: readEnv("MISTRAL_API_KEY") },
    { name: "Cerebras", key: "CEREBRAS_API_KEY", lane: "Open", configured: readEnv("CEREBRAS_API_KEY") },
    { name: "Cohere", key: "COHERE_API_KEY", lane: "Open", configured: readEnv("COHERE_API_KEY") },
    { name: "GitHub Models", key: "GITHUB_MODELS_TOKEN", lane: "Open", configured: readEnv("GITHUB_MODELS_TOKEN") },
  ];

  const configuredCount = providers.filter((p) => p.configured).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">AI assistant</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {configuredCount > 0
            ? `${configuredCount} AI provider(s) configured. The assistant is operational.`
            : "No AI providers configured. Set at least one provider key in environment variables to enable the AI assistant."}
        </p>
      </div>

      {/* Providers */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">LLM providers</h3>
        <div className="space-y-2">
          {providers.map((p) => (
            <div
              key={p.key}
              className="flex items-center justify-between rounded-md border border-border px-4 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${p.configured ? "bg-green-500" : "bg-muted-foreground/30"}`} />
                <span className="text-sm font-medium">{p.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                  p.lane === "Confidential"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-blue-100 text-blue-700"
                }`}>
                  {p.lane}
                </span>
              </div>
              <span className={`text-xs ${p.configured ? "text-green-600" : "text-muted-foreground"}`}>
                {p.configured ? "Ready" : "Not set"}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-amber-700">Confidential lane</span> providers may receive tenant data.
          <span className="font-medium text-blue-700"> Open lane</span> providers only receive non-sensitive prompts.
        </p>
      </div>

      {/* Agents */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">Business agents ({BUSINESS_AGENTS.length})</h3>
        <div className="space-y-2">
          {BUSINESS_AGENTS.map((agent) => (
            <div key={agent.id} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{agent.label}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground capitalize">
                  {agent.sensitivity} lane
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{agent.blurb}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {agent.tools.map((tool) => (
                  <span key={tool} className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Goal planner */}
      <div className="rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Goal planner</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The goal planner converts natural language descriptions into validated workflow drafts.
          It uses the same AI providers listed above. Generated workflows can be saved as drafts
          and reviewed in the Automations section.
        </p>
        <a href="/assistant" className="mt-2 inline-block text-sm font-medium text-primary hover:underline">
          Open assistant →
        </a>
      </div>

      {/* Background workers */}
      <div className="rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Background intelligence workers (6)</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Six scheduled monitors that analyze your data and create notifications for risks:
          GST deadlines, receivables aging, GSTR-2B reconciliation drift, inventory reorder,
          compliance gaps, and site labour anomalies.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {readEnv("WORKER_API_SECRET")
            ? "✓ Worker API secret is set. Workers can be triggered via cron."
            : "⚠ WORKER_API_SECRET is not set. Workers cannot run."}
        </p>
      </div>
    </div>
  );
}
