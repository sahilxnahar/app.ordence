/**
 * Ordence — ⭐⭐ AGENTS
 * Version: v1.20.0-alpha
 *
 * 🔴 Agents were a compiled list of seven until 0071. A compiled list can
 * only change by a deploy, and a deploy is something only the vendor can
 * do, so no customer could ever have an eighth.
 */

import Link from "next/link";
import {
  bindAgentTrigger,
  editAgent,
  getAgentShelf,
  installAgent,
} from "@/server/actions/agents";
import { AgentShelf } from "@/components/agents/agent-shelf";

export const dynamic = "force-dynamic";

export const metadata = { title: "Agents · Ordence" };

export default async function AgentsPage() {
  const result = await getAgentShelf();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Assistants that belong to this workspace. An agent can be given a job
          and left to do it when something happens, and when it does it writes a
          draft for somebody to read. It cannot send a message, change a record
          or spend money, and that limit is in the database rather than in a
          setting. Sending still goes through{" "}
          <Link href="/campaigns" className="underline">
            campaigns
          </Link>
          , with the approval and the spend cap.
        </p>
      </div>

      <AgentShelf
        shelf={result.data.shelf}
        mine={result.data.mine}
        installAction={installAgent}
        bindAction={bindAgentTrigger}
        editAction={editAgent}
      />
    </main>
  );
}
