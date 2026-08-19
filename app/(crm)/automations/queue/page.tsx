/**
 * Ordence — ⭐⭐ THE AUTOMATION QUEUE
 * Version: v1.19.0-alpha
 *
 * 🔴 A CORRECTION. v1.16.0 said 0068 gave the workflow engine its first
 * business events. It did not: the table was created and nothing ever
 * wrote a row, and `dispatchRecordEvent` had been complete and uncalled
 * since v0.23.0. This screen is where the bridge between them is visible.
 */

import Link from "next/link";
import {
  getAutomationQueue,
  purgeAutomationEvents,
  runAutomationQueue,
} from "@/server/actions/automation";
import { QueuePanel } from "@/components/automations/queue-panel";

export const dynamic = "force-dynamic";

export const metadata = { title: "Automation queue · Ordence" };

export default async function AutomationQueuePage() {
  const result = await getAutomationQueue();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Automation queue</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Automation queue</h1>
        <p className="text-sm text-muted-foreground">
          Business events waiting to be handed to the workflow engine. On a
          healthy day this is empty within seconds and there is nothing here to
          look at. It exists for the morning somebody asks why a workflow did not
          run. See your{" "}
          <Link href="/automations" className="underline">
            workflows
          </Link>
          .
        </p>
      </div>

      <QueuePanel
        pending={result.data.pending}
        recent={result.data.recent}
        runAction={runAutomationQueue}
        purgeAction={purgeAutomationEvents}
      />
    </main>
  );
}
