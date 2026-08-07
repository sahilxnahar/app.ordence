/**
 * Ordence — ⭐ THE ASSISTANT API ROUTE
 * Version: v0.77.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ══════════════════════════════════════════════════════════════════════
 * The HTTP endpoint that the in-CRM assistant chat calls. It:
 *
 *   1. Resolves the tenant context from the Clerk session (NOT an MCP
 *      token — this is the UI path, already authenticated)
 *   2. Constructs a synthetic McpSession with read_only scope
 *   3. Calls the agent runner with the user's message and selected agent
 *   4. Returns the agent's response as JSON
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SECURITY: READ-ONLY, ALWAYS
 * ══════════════════════════════════════════════════════════════════════
 * The session constructed here is ALWAYS read_only. The agent runner
 * already filters tools to read-only only, and the dispatch layer checks
 * scope on every call. A UI-originated assistant can never write, approve,
 * certify or delete — by construction, not by convention.
 *
 * ⚠️ Every tool call the agent makes is still logged to mcp_call_log
 * with tokenId = null (UI-originated) and the acting user's id. The
 * audit trail is complete; it just doesn't point to a token.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getTenantContext } from "@/server/tenant-context";
import { runAgent, listAgents } from "@/server/ai/agent-runner";
import type { AgentId } from "@/lib/ai/agents/registry";
import type { McpSession } from "@/server/mcp/dispatch";
import type { ChatMessage } from "@/lib/ai/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AssistantRequest = {
  agentId?: string;
  message?: string;
  history?: ChatMessage[];
};

export async function POST(req: NextRequest) {
  /* ---- 1. authenticate via Clerk ---- */
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in to use the assistant." },
      { status: 401 },
    );
  }

  /* ---- 2. resolve tenant context ---- */
  const ctx = await getTenantContext();
  if (!ctx) {
    return NextResponse.json(
      { error: "No workspace is active. Create or select an organization." },
      { status: 403 },
    );
  }

  /* ---- 3. parse the request ---- */
  let body: AssistantRequest;
  try {
    body = (await req.json()) as AssistantRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  const agentId = body.agentId as AgentId | undefined;
  const message = body.message?.trim();

  if (!agentId) {
    return NextResponse.json(
      { error: "Select an assistant to talk to." },
      { status: 400 },
    );
  }

  if (!message || message.length < 2) {
    return NextResponse.json(
      { error: "Type a question for the assistant." },
      { status: 400 },
    );
  }

  if (message.length > 4000) {
    return NextResponse.json(
      { error: "The message is too long. Keep it under 4000 characters." },
      { status: 400 },
    );
  }

  /* ---- 4. construct the synthetic session ---- */
  //
  // ⚠️ READ-ONLY, ALWAYS. The agent runner filters tools to read-only,
  // and the dispatch layer checks scope. This is defence in depth —
  // even if a future agent accidentally includes a write tool in its
  // whitelist, the scope check refuses it.
  const session: McpSession = {
    tokenId: null, // UI-originated — no MCP token
    tenantId: ctx.tenant.id,
    scope: "read_only",
    actingUserId: ctx.user.id,
  };

  /* ---- 5. run the agent ---- */
  try {
    const result = await runAgent({
      agentId,
      userMessage: message,
      session,
      history: body.history,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.reason },
        { status: 503 },
      );
    }

    return NextResponse.json({
      content: result.content,
      toolCalls: result.toolCalls,
      rounds: result.rounds,
    });
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "The assistant encountered an error.";
    return NextResponse.json(
      { error: reason },
      { status: 500 },
    );
  }
}

/**
 * GET returns the list of available agents for the UI picker.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: "Sign in to see available assistants." },
      { status: 401 },
    );
  }

  return NextResponse.json({ agents: listAgents() });
}
