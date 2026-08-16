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
import { readJsonWithLimit, RequestTooLargeError } from "@/lib/edge/body-limit";
import { publishPlanHint } from "@/lib/edge/limits";

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

  /* ---- 2b. ⭐ TELL THE EDGE WHAT THIS WORKSPACE PAYS — Batch 31 ----
   *
   * `middleware.ts` runs in the Edge runtime and cannot open a database
   * connection, so it cannot read `tenants.plan_tier` and cannot choose
   * the right per-plan budget on its own. This is a Node path that has
   * already resolved a real tenant context, so it publishes the plan as
   * a short-lived hint the Edge can read.
   *
   * ⚠️ FIRE AND FORGET, AND NOT AWAITED. A cache warm may never be the
   * reason a request is slower or fails. A miss costs one request
   * measured against the generous fallback tier, which is argued at
   * `UNKNOWN_PLAN_FALLBACK_TIER`.
   */
  void publishPlanHint(ctx.clerkOrgId, ctx.tenant.planTier);

  /* ---- 3. parse the request ---- */
  //
  // ══════════════════════════════════════════════════════════════════
  // 🔴 THE MOST EXPENSIVE BODY IN THE PRODUCT, PREVIOUSLY UNBOUNDED
  // ══════════════════════════════════════════════════════════════════
  // `message` was capped at 4000 characters below. `history` was not
  // capped at all — and history is an ARRAY of prior messages that the
  // client supplies and we forward straight into the model. Every byte
  // of it becomes prompt tokens a third party bills us for.
  //
  // So the 4000-character check bounded the smallest field in the
  // payload and left the unbounded one alone. A client stuck in a retry
  // loop, resending a history that grows on each iteration, turns our
  // model spend into a curve with no ceiling — no attacker needed.
  //
  // ⚠️ THE MEASURED CHECK, NOT THE DECLARED ONE. Middleware already
  // refused an honest oversized `Content-Length`; this counts the bytes
  // that actually arrive and aborts the stream at the cap, which is what
  // holds against a chunked request or a lying header.
  //
  // ⚠️ 413 AND 400 STAY DIFFERENT. "Your JSON is malformed" sends an
  // integration author to look at their serialiser; the real problem is
  // that they sent 4 MB of perfectly valid JSON, and only a distinct
  // status with a stated limit says so.
  let body: AssistantRequest;
  try {
    body = await readJsonWithLimit<AssistantRequest>(req, "/api/assistant");
  } catch (err) {
    if (err instanceof RequestTooLargeError) {
      return NextResponse.json(
        { error: err.message, limitBytes: err.limitBytes },
        { status: 413 },
      );
    }
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
