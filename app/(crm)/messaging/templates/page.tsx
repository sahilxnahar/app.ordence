/**
 * Ordence — ⭐ TEMPLATES
 * Version: v1.17.0-alpha
 *
 * ⚠️ The screen that was missing between two finished engines. See
 * `server/actions/templates.ts` for why it did not exist until now.
 */

import Link from "next/link";
import { declareTemplate, disableTemplate, getTemplates } from "@/server/actions/templates";
import { TemplateManager } from "@/components/messaging/template-manager";

export const dynamic = "force-dynamic";

export const metadata = { title: "Templates · Ordence" };

export default async function TemplatesPage() {
  const result = await getTemplates();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Templates</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { templates, whatsappConnections } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Templates</h1>
        <p className="text-sm text-muted-foreground">
          WhatsApp will not carry a message to somebody who has not written to you
          in the last 24 hours unless it uses an approved template. Templates are
          written and approved in Meta&apos;s dashboard; this is where you tell
          Ordence which ones exist. Set the account up on{" "}
          <Link href="/settings/connections" className="underline">
            connections
          </Link>{" "}
          first.
        </p>
      </div>

      <TemplateManager
        templates={templates}
        whatsappConnections={whatsappConnections}
        declareAction={declareTemplate}
        disableAction={disableTemplate}
      />
    </main>
  );
}
