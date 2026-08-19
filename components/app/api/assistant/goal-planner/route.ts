/**
 * Ordence — Goal Planner API Route
 * Version: v0.77.0-alpha
 *
 * Takes a natural-language goal and returns a validated workflow program
 * draft. The draft is NOT published — the user must review it and
 * publish through the normal workflow builder.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getTenantContext } from "@/server/tenant-context";
import { checkFeature } from "@/server/entitlements";
import { refusalFor } from "@/lib/entitlements/upgrade";
import { planGoal } from "@/lib/ai/goal-planner";
// ⭐ 0105 · this workspace's own provider keys where it has supplied any.
import { tenantChatCompletion } from "@/server/ai/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in to use the goal planner." },
      { status: 401 },
    );
  }

  const ctx = await getTenantContext();
  if (!ctx) {
    return NextResponse.json(
      { error: "No workspace is active." },
      { status: 403 },
    );
  }

  /**
   * ⭐ THE COPILOT GATE — Batch 0109.
   *
   * ⚠️ BEFORE THE BODY IS EVEN PARSED, because everything below this
   * line ends in a model call this company pays a third party for. A
   * gate placed after the work has been done refuses nothing that costs
   * anything.
   *
   * 402 rather than 403: this is a plan boundary, not a permission one,
   * and the body names the plan that includes it. See
   * `lib/entitlements/upgrade.ts` for why those are different remedies
   * aimed at different people.
   */
  const copilot = await checkFeature("ai.copilot", ctx);
  if (!copilot.allowed) {
    const refusal = refusalFor(copilot, null);
    return NextResponse.json(
      {
        error: refusal.sentence,
        requiredTier: refusal.requiredTier,
        upgradeHref: refusal.href,
      },
      { status: 402 },
    );
  }

  let body: { goal?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  const goal = body.goal?.trim();
  if (!goal || goal.length < 5) {
    return NextResponse.json(
      { error: "Describe a goal to automate (at least 5 characters)." },
      { status: 400 },
    );
  }

  if (goal.length > 2000) {
    return NextResponse.json(
      { error: "Keep the goal under 2000 characters." },
      { status: 400 },
    );
  }

  const result = await planGoal({
    goal,
    tenantId: ctx.tenant.id,
    // ⚠️ The tenant comes from the SESSION, never from the body.
    chat: (request) =>
      tenantChatCompletion({ ...request, tenantId: ctx.tenant.id }),
  });

  if (!result.ok && result.reason && !result.errors.length) {
    return NextResponse.json(
      { error: result.reason },
      { status: 503 },
    );
  }

  return NextResponse.json(result);
}
