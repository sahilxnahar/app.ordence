/**
 * Ordence — Conversation Memory
 * Version: v0.83.0-alpha
 *
 * Stores AI assistant chat history per tenant so past conversations
 * can be retrieved for context. Uses the existing audit_logs table
 * with a dedicated resourceType "ai_conversation" — no new table needed.
 *
 * ⚠️ TENANT-SCOPED via withTenant() under RLS.
 * ⚠️ APPEND-ONLY. A conversation is never edited or deleted.
 */

import "server-only";

import { and, eq, desc, sql } from "drizzle-orm";
import { withTenant, db } from "@/db";
import { auditLogs } from "@/db/schema";

export type ConversationMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  timestamp: string;
};

export type Conversation = {
  id: string;
  agentId: string;
  messages: ConversationMessage[];
  createdAt: string;
};

/**
 * Save a conversation to the audit log.
 * Called after the agent runner completes a conversation.
 */
export async function saveConversation(
  tenantId: string,
  agentId: string,
  messages: ConversationMessage[],
): Promise<void> {
  if (messages.length === 0) return;

  await withTenant(tenantId, async (tx) => {
    await tx.insert(auditLogs).values({
      tenantId,
      action: "read",
      resourceType: "ai_conversation",
      resourceId: agentId,
      newValue: {
        agentId,
        messageCount: messages.length,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content.slice(0, 2000), // cap individual messages
          toolName: m.toolName,
          timestamp: m.timestamp,
        })),
      },
      reason: `AI conversation with ${agentId} (${messages.length} messages)`,
    });
  });
}

/**
 * Retrieve recent conversations for a tenant, optionally filtered by agent.
 * Returns the last N conversations, newest first.
 */
export async function getRecentConversations(
  tenantId: string,
  agentId?: string,
  limit = 5,
): Promise<Conversation[]> {
  try {
    const conditions = [
      eq(auditLogs.tenantId, tenantId),
      eq(auditLogs.resourceType, "ai_conversation"),
    ];

    if (agentId) {
      conditions.push(eq(auditLogs.resourceId, agentId));
    }

    const rows = await withTenant(tenantId, (tx) =>
      tx
        .select({
          id: auditLogs.id,
          resourceId: auditLogs.resourceId,
          newValue: auditLogs.newValue,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
    );

    return rows.map((r) => {
      const value = r.newValue as {
        agentId?: string;
        messages?: ConversationMessage[];
      };
      return {
        id: r.id,
        agentId: value.agentId ?? r.resourceId ?? "unknown",
        messages: value.messages ?? [],
        createdAt: r.createdAt.toISOString(),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get a summary of past conversations for the agent runner to inject
 * into the system prompt as context.
 */
export async function getConversationContext(
  tenantId: string,
  agentId: string,
): Promise<string> {
  const conversations = await getRecentConversations(tenantId, agentId, 3);

  if (conversations.length === 0) return "";

  const summaries = conversations.map((conv) => {
    const userMessages = conv.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content.slice(0, 200))
      .join(" | ");
    return `[${conv.createdAt.slice(0, 10)}] ${userMessages}`;
  });

  return `Past conversations with this tenant:\n${summaries.join("\n")}\n\nUse this context to provide more relevant answers, but do not repeat information already discussed.`;
}
