/**
 * Ordence — ⭐ THE MCP ENDPOINT
 * Version: v0.74.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY JSON-RPC BY HAND RATHER THAN THE MCP SDK
 * ══════════════════════════════════════════════════════════════════════
 * The official SDK's transports assume either a stdio process or a
 * long-lived stateful session object. Neither survives a serverless
 * request boundary: a Railway container can serve two calls from the same
 * client on two different instances, and a session held in module scope
 * would be present for one and missing for the other — intermittently,
 * and only under load.
 *
 * The subset MCP actually needs over HTTP is three methods: `initialize`,
 * `tools/list`, `tools/call`. Implementing those directly makes every
 * request self-contained and stateless, which is what this deployment
 * shape requires. It also adds no dependency to a project whose CI
 * already fails on unactionable advisories in packages it cannot upgrade.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS ROUTE IS PUBLIC IN THE MIDDLEWARE, AND THAT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════
 * "Public" here means only that `clerkMiddleware` does not demand a
 * browser session — an MCP client has no cookie jar and is never
 * redirected through a sign-in page.
 *
 * ⚠️ IT DOES NOT MEAN UNAUTHENTICATED. Every request must carry a bearer
 * token that resolves, through `mcp_resolve_token`, to a live, unrevoked,
 * unexpired grant. Without one this route answers 401 and does nothing
 * else. The tenant is derived from the token; a client cannot assert it,
 * which is the same rule that makes the middleware strip six headers.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  MCP_TOOLS,
  toolInputSchema,
  describeForModel,
} from "@/lib/mcp/registry";
import { resolveSession, dispatchTool } from "@/server/mcp/dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  status = 200,
) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status },
  );
}

/**
 * ⚠️ THE 401 SAYS NOTHING ABOUT WHY.
 *
 * "Token revoked", "token expired" and "no such token" are three
 * different sentences, and telling them apart is exactly what an attacker
 * holding a list of guesses needs. One message for all three.
 */
function unauthorized() {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message:
          "Unauthorised. Send a valid Ordence MCP token as " +
          "`Authorization: Bearer <token>`. Tokens are issued per workspace " +
          "in the Ordence admin console and can be revoked there.",
      },
    },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export async function POST(req: NextRequest) {
  /* ---- 1. bearer token ---- */
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return unauthorized();

  /* ---- 2. resolve, which applies revocation and expiry in the DB ---- */
  let session;
  try {
    session = await resolveSession(match[1]);
  } catch {
    /**
     * ⚠️ A DATABASE FAILURE HERE IS NOT A 401.
     *
     * Answering "unauthorised" when the database is simply unreachable
     * sends the operator to rotate a token that was never the problem.
     */
    return rpcError(null, -32603, "Ordence could not verify the token.", 503);
  }
  if (!session) return unauthorized();

  /* ---- 3. parse ---- */
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error — the body is not valid JSON.");
  }

  const { id, method, params } = body;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ordence", version: "0.74.0-alpha" },
        instructions:
          "Ordence is a multi-tenant CRM and ERP for the Indian market. This " +
          "token is bound to exactly one workspace and cannot see any other. " +
          "Call `ordence_whoami` first to learn which workspace and what the " +
          "token may do.\n\n" +
          "⚠️ This interface deliberately CANNOT approve a variation, certify " +
          "or approve an RA bill, verify a worker's UAN, check a measurement, " +
          "delete anything, or read the sensitive-data vault. Those carry " +
          "segregation-of-duties controls whose value is that a second HUMAN " +
          "looked. If a user asks for one of those, say plainly that it has to " +
          "be done by a person in the Ordence interface, and why.",
      });

    /** `notifications/initialized` is fire-and-forget; acknowledge and stop. */
    case "notifications/initialized":
      return new NextResponse(null, { status: 202 });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: MCP_TOOLS.filter(
          // A read_only token is not shown write tools at all. Offering a
          // tool that will certainly be refused wastes a turn and teaches
          // the model that refusals are normal.
          (t) => t.scope === "read_only" || session.scope === "read_write",
        ).map((t) => ({
          name: t.name,
          title: t.title,
          description: describeForModel(t),
          inputSchema: toolInputSchema(t),
        })),
      });

    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      const args =
        params?.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};

      if (!name) return rpcError(id, -32602, "tools/call needs a tool name.");

      const outcome = await dispatchTool(session, name, args);

      /**
       * ⚠️ A REFUSAL IS `isError: true` WITH THE REASON, NOT A TRANSPORT
       * ERROR.
       *
       * MCP treats a JSON-RPC error as "the server broke". A refusal is
       * the server working correctly and saying no. Returning the wrong
       * one makes a well-behaved policy decision look like an outage, and
       * the assistant retries instead of explaining.
       */
      if (!outcome.ok) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: outcome.reason }],
        });
      }

      return rpcResult(id, {
        content: [
          { type: "text", text: JSON.stringify(outcome.data, null, 2) },
        ],
        structuredContent: outcome.data,
      });
    }

    default:
      return rpcError(id, -32601, `Method not supported: ${method ?? "(none)"}`);
  }
}

/**
 * A GET is not part of the protocol here, but MCP clients probe with one.
 * Answering usefully saves an operator half an hour of "is the URL right".
 */
export async function GET() {
  return NextResponse.json({
    name: "ordence",
    protocol: "mcp",
    protocolVersion: PROTOCOL_VERSION,
    transport: "http-jsonrpc",
    authentication: "Authorization: Bearer <ordence mcp token>",
    method: "POST",
    note:
      "This endpoint speaks MCP over JSON-RPC. POST `initialize`, then " +
      "`tools/list`, then `tools/call`. A bearer token is required on every " +
      "request; the workspace is derived from the token and cannot be asserted " +
      "by the client.",
  });
}
