/**
 * Ordence — Settings · Integrations
 * Version: v0.83.0-alpha
 *
 * Shows the connection status of every external integration.
 * Read-only — configuration is done via environment variables.
 */

import { requirePageContext } from "@/server/tenant-context";

export const dynamic = "force-dynamic";

function readEnv(name: string): boolean {
  try {
    const v = process.env[name];
    return typeof v === "string" && v.length > 0;
  } catch {
    return false;
  }
}

type Integration = {
  name: string;
  description: string;
  configured: boolean;
  vars: Array<{ name: string; set: boolean }>;
  docs?: string;
};

export default async function IntegrationsPage() {
  const ctx = await requirePageContext();

  const integrations: Integration[] = [
    {
      name: "Email (Resend)",
      description: "Transaction email delivery for notifications, receipts, and alerts.",
      configured: readEnv("RESEND_API_KEY"),
      vars: [
        { name: "RESEND_API_KEY", set: readEnv("RESEND_API_KEY") },
        { name: "RESEND_FROM_EMAIL", set: readEnv("RESEND_FROM_EMAIL") },
      ],
    },
    {
      name: "Object Storage (Cloudflare R2)",
      description: "Document and file storage via S3-compatible API.",
      configured: readEnv("S3_ENDPOINT") && readEnv("S3_ACCESS_KEY_ID") && readEnv("S3_SECRET_ACCESS_KEY") && readEnv("S3_BUCKET"),
      vars: [
        { name: "S3_ENDPOINT", set: readEnv("S3_ENDPOINT") },
        { name: "S3_BUCKET", set: readEnv("S3_BUCKET") },
        { name: "S3_ACCESS_KEY_ID", set: readEnv("S3_ACCESS_KEY_ID") },
        { name: "S3_SECRET_ACCESS_KEY", set: readEnv("S3_SECRET_ACCESS_KEY") },
      ],
    },
    {
      name: "Cache (Upstash Redis)",
      description: "Rate limiting, caching, and session state.",
      configured: readEnv("UPSTASH_REDIS_REST_URL") && readEnv("UPSTASH_REDIS_REST_TOKEN"),
      vars: [
        { name: "UPSTASH_REDIS_REST_URL", set: readEnv("UPSTASH_REDIS_REST_URL") },
        { name: "UPSTASH_REDIS_REST_TOKEN", set: readEnv("UPSTASH_REDIS_REST_TOKEN") },
      ],
    },
    {
      name: "Payments (Razorpay)",
      description: "Subscription billing and one-time payments for Indian customers.",
      configured: readEnv("RAZORPAY_KEY_ID") && readEnv("RAZORPAY_KEY_SECRET"),
      vars: [
        { name: "RAZORPAY_KEY_ID", set: readEnv("RAZORPAY_KEY_ID") },
        { name: "RAZORPAY_KEY_SECRET", set: readEnv("RAZORPAY_KEY_SECRET") },
        { name: "RAZORPAY_WEBHOOK_SECRET", set: readEnv("RAZORPAY_WEBHOOK_SECRET") },
      ],
    },
    {
      name: "AI — Cloudflare Workers AI",
      description: "Confidential lane: allowed to see tenant data.",
      configured: readEnv("CLOUDFLARE_ACCOUNT_ID") && readEnv("CF_AI_TOKEN"),
      vars: [
        { name: "CLOUDFLARE_ACCOUNT_ID", set: readEnv("CLOUDFLARE_ACCOUNT_ID") },
        { name: "CF_AI_TOKEN", set: readEnv("CF_AI_TOKEN") },
      ],
    },
    {
      name: "AI — Groq",
      description: "Open lane: fast inference for drafting and summaries.",
      configured: readEnv("GROQ_API_KEY"),
      vars: [{ name: "GROQ_API_KEY", set: readEnv("GROQ_API_KEY") }],
    },
    {
      name: "AI — Google AI",
      description: "Open lane: Gemini models for analysis.",
      configured: readEnv("GOOGLE_AI_API_KEY"),
      vars: [{ name: "GOOGLE_AI_API_KEY", set: readEnv("GOOGLE_AI_API_KEY") }],
    },
    {
      name: "AI — Mistral",
      description: "Open lane: European-hosted models.",
      configured: readEnv("MISTRAL_API_KEY"),
      vars: [{ name: "MISTRAL_API_KEY", set: readEnv("MISTRAL_API_KEY") }],
    },
    {
      name: "Background Workers",
      description: "Scheduled intelligence monitors. Protected by WORKER_API_SECRET.",
      configured: readEnv("WORKER_API_SECRET"),
      vars: [
        { name: "WORKER_API_SECRET", set: readEnv("WORKER_API_SECRET") },
        { name: "ORDENCE_INLINE_JOBS", set: readEnv("ORDENCE_INLINE_JOBS") },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Integrations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connection status for every external service. Configuration is done via environment
          variables in the deployment settings.
        </p>
      </div>

      <div className="space-y-3">
        {integrations.map((integration) => (
          <div
            key={integration.name}
            className={`rounded-lg border p-4 ${integration.configured ? "border-border" : "border-dashed border-border"}`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${integration.configured ? "bg-green-500" : "bg-muted-foreground/30"}`}
                  />
                  <span className="text-sm font-medium">{integration.name}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{integration.description}</p>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  integration.configured
                    ? "bg-green-100 text-green-700"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {integration.configured ? "Connected" : "Not configured"}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {integration.vars.map((v) => (
                <span
                  key={v.name}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                    v.set
                      ? "bg-green-50 text-green-600"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {v.set ? "✓" : "✗"} {v.name}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-md border border-border bg-muted/20 p-4">
        <p className="text-xs text-muted-foreground">
          To configure an integration, set the environment variables in Railway → Variables.
          The AI assistant requires at least one AI provider key to function.
          The notification system requires RESEND_API_KEY to send email alerts.
        </p>
      </div>
    </div>
  );
}
