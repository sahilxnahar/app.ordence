/**
 * Ordence — Goal Planner Save API Route
 * Version: v0.77.0-alpha
 *
 * Saves an AI-generated workflow program as a DRAFT. The draft must
 * still be published through the normal workflow builder, which runs
 * the full validation and permission checks.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getTenantContext } from "@/server/tenant-context";
import { createWorkflow } from "@/server/actions/workflows";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in." },
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

  let body: {
    name?: string;
    description?: string;
    triggerType?: string;
    triggerConfig?: Record<string, unknown>;
    program?: { steps: unknown[] };
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  if (!body.program?.steps || !Array.isArray(body.program.steps)) {
    return NextResponse.json(
      { error: "A valid workflow program is required." },
      { status: 400 },
    );
  }

  if (!body.triggerType) {
    return NextResponse.json(
      { error: "A trigger type is required." },
      { status: 400 },
    );
  }

  // ⚠️ Generate a URL-safe key from the name. The createWorkflow
  // action validates this against its own schema.
  const key = (body.name ?? "ai-workflow")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "ai-workflow";

  const result = await createWorkflow({
    key,
    name: body.name ?? "AI-generated workflow",
    description: body.description,
    triggerType: body.triggerType,
    triggerConfig: body.triggerConfig ?? {},
    program: { steps: body.program.steps },
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Could not create the workflow draft." },
      { status: 400 },
    );
  }

  return NextResponse.json({ id: result.data.id });
}
