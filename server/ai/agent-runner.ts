import "server-only";

/**
 * Ordence — ⭐ THE AGENT RUNNER
 * Version: v0.76.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ══════════════════════════════════════════════════════════════════════
 * The orchestration layer that runs a business agent conversation. It:
 *
 *   1. Resolves the agent from the registry
 *   2. Converts the agent's tool whitelist into OpenAI tool definitions
 *   3. Constructs the conversation with the system prompt
 *   4. Calls the AI client (`lib/ai/client.ts`)
 *   5. If the AI makes tool calls, dispatches them through `dispatchTool`
 *   6. Feeds the tool results back to the AI
 *   7. Loops until the AI stops calling tools or hits a limit
 *   8. Returns the final response
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SECURITY: EVERY TOOL CALL GOES THROUGH THE EXISTING DISPATCH
 * ══════════════════════════════════════════════════════════════════════
 * The agent runner does NOT call server actions directly. It calls
 * `dispatchTool`, the same function the MCP HTTP route calls. That means:
 *
 *   - The token's scope is checked (read_only vs read_write)
 *   - The tool must exist in the registry (unknown fails closed)
 *   - Every query runs inside `withTenant()` under RLS
 *   - Every call is logged to `mcp_call_log`, including refusals
 *
 * No new security surface is created. The agent is a user with a token,
 * not a privileged system process.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CONVERSATION LOOP
 * ══════════════════════════════════════════════════════════════════════
 *
 *   user message
 *        │
 *        ▼
 *   ┌─ AI client ───────────────────────────┐
 *   │  returns: content OR tool_calls       │
 *   └────────────────┬──────────────────────┘
 *                   │
 *         tool_calls?─→ yes ─→ dispatch each ─→ feed results back ─→ loop
 *                   │
 *                   └─ no  ─→ return content
 *
 * The loop is bounded by `MAX_TOOL_ROUNDS` (8). An agent that calls
 * tools forever is stopped, not humoured.
 */

import {
  BUSINESS_AGENTS,
  findAgent,
  type AgentId,
  type BusinessAgent,
} from "@/lib/ai/agents/registry";
import { MCP_TOOLS, toolInputSchema, describeForModel } from "@/lib/mcp/registry";
import { chatCompletion, type ChatMessage, type ChatTool } from "@/lib/ai/client";
import { dispatchTool, type McpSession } from "@/server/mcp/dispatch";
import { getTenantPatterns } from "@/lib/ai/patterns";

/* ------------------------------------------------------------------ */
/* CONSTANTS                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EIGHT, NOT UNLIMITED.
 *
 * Each round is a network call to an AI provider, and each round may
 * call multiple tools. Eight rounds is enough for the most complex
 * business question (whoami → list obligations → get details → list
 * related data → synthesise) without letting a confused model spin
 * indefinitely on the user's token budget.
 */
const MAX_TOOL_ROUNDS = 8;

/* ------------------------------------------------------------------ */
/* TOOL DEFINITION BUILDING                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert the agent's tool whitelist into OpenAI function-calling format.
 *
 * Only tools in the agent's whitelist AND in the MCP registry are
 * included. The registry is the source of truth; the whitelist is the
 * filter.
 */
function buildTools(agent: BusinessAgent): ChatTool[] {
  const agentToolSet = new Set(agent.tools);
  return MCP_TOOLS.filter((t) => agentToolSet.has(t.name))
    .filter(
      // ⚠️ A read_only session is not offered write tools. Offering a
      // tool that will certainly be refused wastes a turn and teaches
      // the model that refusals are normal.
      (t) => t.scope === "read_only",
    )
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: describeForModel(t),
        parameters: toolInputSchema(t) as Record<string, unknown>,
      },
    }));
}

/* ------------------------------------------------------------------ */
/* THE AGENT RUN                                                       */
/* ------------------------------------------------------------------ */

export type AgentRunRequest = {
  agentId: AgentId;
  userMessage: string;
  session: McpSession;
  /** Optional conversation history (prior messages). */
  history?: ChatMessage[];
};

export type AgentRunResult =
  | { ok: true; content: string; toolCalls: number; rounds: number }
  | { ok: false; reason: string };

/**
 * ⭐ Run one agent conversation to completion.
 *
 * The conversation starts with the agent's system prompt, includes any
 * prior history, and appends the user's message. The AI may call tools,
 * which are dispatched through the existing MCP dispatch layer, and the
 * results are fed back. The loop ends when the AI returns content without
 * tool calls, or when the round limit is reached.
 */
export async function runAgent(
  request: AgentRunRequest,
): Promise<AgentRunResult> {
  const { agentId, userMessage, session, history } = request;

  const agent = findAgent(agentId);
  if (!agent) {
    return { ok: false, reason: `No agent called "${agentId}".` };
  }

  // ⚠️ TENANT PATTERNS — learned facts from past runs. See Phase D.
  // These are injected into the system prompt so the agent knows, e.g.,
  // "this tenant's clients typically dispute invoices over ₹5 lakh".
  const patterns = await getTenantPatterns(session.tenantId);
  const patternContext =
    patterns.length > 0
      ? `\n\nLEARNED PATTERNS FOR THIS WORKSPACE (from past agent runs):\n` +
        patterns
          .map(
            (p) =>
              `- ${p.patternType}: ${p.patternKey} ` +
              `(seen ${p.occurrenceCount}x, last: ${p.lastSeen.toISOString().slice(0, 10)})` +
              (p.patternData.summary ? ` — ${p.patternData.summary}` : ""),
          )
          .join("\n")
      : "";

  // Build the conversation
  const tools = buildTools(agent);
  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt + patternContext },
    ...(history ?? []),
    { role: "user", content: userMessage },
  ];

  let totalToolCalls = 0;
  let rounds = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1;

    const response = await chatCompletion({
      messages,
      tools: tools.length > 0 ? tools : undefined,
      sensitivity: agent.sensitivity,
      temperature: 0.3,
    });

    if (!response.ok) {
      return { ok: false, reason: response.reason };
    }

    const { message } = response.result;

    // If the AI did not request tool calls, we are done.
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return {
        ok: true,
        content: message.content || "I could not generate a response.",
        toolCalls: totalToolCalls,
        rounds,
      };
    }

    // The AI requested tool calls. Add the assistant message (with the
    // tool calls) to the conversation, then dispatch each one.
    messages.push(message);

    for (const toolCall of message.tool_calls) {
      totalToolCalls++;

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        // ⚠️ A model that produces malformed JSON gets a clear error
        // back, not a crash. The error message tells it what happened.
        messages.push({
          role: "tool",
          content: JSON.stringify({
            error: "Could not parse tool arguments as JSON.",
          }),
          tool_call_id: toolCall.id,
        });
        continue;
      }

      // ⚠️ THE TOOL IS DISPATCHED THROUGH THE EXISTING MCP DISPATCH.
      // Same token, same scope check, same RLS, same audit log.
      const outcome = await dispatchTool(
        session,
        toolCall.function.name,
        parsedArgs,
      );

      const toolResponse = outcome.ok
        ? JSON.stringify(outcome.data, null, 2)
        : `Error: ${outcome.reason}`;

      messages.push({
        role: "tool",
        content: toolResponse,
        tool_call_id: toolCall.id,
      });
    }

    // Loop continues — the AI will see the tool results and decide
    // whether to call more tools or produce a final answer.
  }

  // ⚠️ RAN OUT OF ROUNDS. Return what we have rather than hanging.
  return {
    ok: true,
    content:
      "I reached the maximum number of tool calls for this conversation. " +
      "Here is what I found so far — please ask again if you need more detail.",
    toolCalls: totalToolCalls,
    rounds,
  };
}

/**
 * List all available agents for the UI picker. Read-only, no auth.
 */
export function listAgents(): Array<{
  id: AgentId;
  label: string;
  blurb: string;
  schedulable: boolean;
}> {
  return BUSINESS_AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    blurb: a.blurb,
    schedulable: a.schedulable,
  }));
}
