/**
 * Ordence — ⭐ THE ASSISTANT PAGE
 * Version: v0.77.0-alpha
 *
 * The in-CRM AI assistant. Two modes:
 *
 *   1. Chat — ask a question about GST, receivables, compliance, etc.
 *      The assistant calls read-only MCP tools and answers in plain English.
 *
 *   2. Goal Planner — describe a business goal in natural language and
 *      the AI generates a workflow program draft. The user reviews it
 *      and saves it as a draft in the Automations builder.
 *
 * 🔴 SECURITY: The page is a shell. All data access happens through
 * API routes, which construct read-only sessions and dispatch tool
 * calls through the existing MCP dispatch layer under RLS.
 */

import { requirePageContext } from "@/server/tenant-context";
import { AssistantTabs } from "./assistant-tabs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assistant · Ordence" };

export default async function AssistantPage() {
  await requirePageContext();
  return <AssistantTabs />;
}
