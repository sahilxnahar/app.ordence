"use server";

/**
 * Ordence — ⭐⭐ CONVERSATIONS, ON THE RECORD THEY ARE ABOUT
 * Version: v1.10.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ⭐ Ledgers do not create habit. Conversations do. And a discussion
 * about an invoice that lives in somebody's email is a discussion the
 * next person to pick up the file cannot find, which is how the same
 * question gets asked three times and answered differently twice.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  messageThreads,
  messages,
  threadParticipants,
} from "@/db/schema/front-office";
import { tasks } from "@/db/schema/work";
import { users } from "@/db/schema/core";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import {
  compareThreads,
  summariseInbox,
  threadState,
  type ThreadRow,
} from "@/lib/work/threads";

const READ = "crm.contacts.read" as const;
const WRITE = "crm.contacts.write" as const;

const SUBJECT_TYPES = [
  "company",
  "contact",
  "deal",
  "lead",
  "sales_order",
  "sales_invoice",
  "purchase_invoice",
  "receipt",
  "matter",
  "hearing",
  "project",
  "unit",
  "booking",
  "consignment",
  "stock_item",
  "asset",
  "licence",
  "compliance_task",
  "campaign",
  "other",
] as const;

/* ------------------------------------------------------------------ */

const startSchema = z.object({
  title: z.string().trim().max(300).optional(),
  subjectType: z.enum(SUBJECT_TYPES).nullish(),
  subjectId: z.string().uuid().nullish(),
  subjectLabel: z.string().trim().max(300).nullish(),
  participantIds: z.array(z.string().uuid()).default([]),
  firstMessage: z.string().trim().min(1).max(8000),
});

/**
 * ⭐⭐ START A CONVERSATION.
 *
 * ⚠️ A thread with neither a title nor a record it belongs to cannot be
 * found again by anybody who was not in it at the time. The database
 * refuses one; this refuses it in a sentence first.
 */
export async function startThread(input: unknown): Promise<
  ActionResult<{ threadId: string; messageId: string; participants: number }>
> {
  try {
    const data = startSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const hasType = data.subjectType !== null && data.subjectType !== undefined;
    const hasId = data.subjectId !== null && data.subjectId !== undefined;
    if (hasType !== hasId) {
      throw new Error(
        "A conversation is attached to a record or to nothing. Half a link will never resolve on a screen.",
      );
    }
    if (!data.title && !hasType) {
      throw new Error(
        "Give this a title or attach it to a record. A conversation with neither cannot be found again by anybody who was not in it at the time.",
      );
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [thread] = await tx
          .insert(messageThreads)
          .values({
            tenantId: ctx.tenant.id,
            title: data.title ?? null,
            subjectType: data.subjectType ?? null,
            subjectId: data.subjectId ?? null,
            subjectLabel: data.subjectLabel ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: messageThreads.id });
        if (!thread) throw new Error("The conversation could not be started.");

        /**
         * 🔴 THE AUTHOR IS A PARTICIPANT BEFORE THE FIRST MESSAGE. The
         * trigger in 0061 refuses a post from somebody who is not in the
         * thread, and that includes the person who just created it.
         */
        const wanted = new Set<string>([ctx.user.id, ...data.participantIds]);
        await tx.insert(threadParticipants).values(
          [...wanted].map((u) => ({
            tenantId: ctx.tenant.id,
            threadId: thread.id,
            userId: u,
            joinedVia: u === ctx.user.id ? ("creator" as const) : ("added" as const),
            /** ⭐ The creator has, by definition, read their own message. */
            lastReadAt: u === ctx.user.id ? new Date() : null,
          })),
        );

        const [msg] = await tx
          .insert(messages)
          .values({
            tenantId: ctx.tenant.id,
            threadId: thread.id,
            authorId: ctx.user.id,
            body: data.firstMessage,
          })
          .returning({ id: messages.id });
        if (!msg) throw new Error("The message could not be posted.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "message_thread",
          resourceId: thread.id,
          newValue: { subjectType: data.subjectType ?? null },
          severity: "info",
        });

        return { threadId: thread.id, messageId: msg.id, participants: wanted.size };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/messages");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "startThread");
  }
}

/* ------------------------------------------------------------------ */

/**
 * ⭐ POST INTO A CONVERSATION.
 *
 * 🔴 THE TRIGGER, NOT THIS ACTION, IS WHAT STOPS SOMEBODY POSTING INTO A
 *    THREAD THEY ARE NOT IN. Being able to see a thread and being part
 *    of it are two different things, and only one of them is a
 *    permission. The screen is not the boundary.
 */
export async function postMessage(input: unknown): Promise<
  ActionResult<{ id: string; addedParticipants: number }>
> {
  try {
    const data = z
      .object({
        threadId: z.string().uuid(),
        body: z.string().trim().min(1).max(8000),
        mentionIds: z.array(z.string().uuid()).default([]),
        replyTo: z.string().uuid().nullish(),
      })
      .parse(input);
    const ctx = await requirePermission(WRITE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const before = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(threadParticipants)
          .where(eq(threadParticipants.threadId, data.threadId));

        const [row] = await tx
          .insert(messages)
          .values({
            tenantId: ctx.tenant.id,
            threadId: data.threadId,
            authorId: ctx.user.id,
            body: data.body,
            /** ⭐ The trigger adds anybody named here to the thread. */
            mentions: data.mentionIds,
            replyTo: data.replyTo ?? null,
          })
          .returning({ id: messages.id });
        if (!row) throw new Error("The message could not be posted.");

        const after = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(threadParticipants)
          .where(eq(threadParticipants.threadId, data.threadId));

        /** ⚠️ The author has read their own message. */
        await tx
          .update(threadParticipants)
          .set({ lastReadAt: new Date() })
          .where(
            and(
              eq(threadParticipants.threadId, data.threadId),
              eq(threadParticipants.userId, ctx.user.id),
            ),
          );

        return {
          id: row.id,
          addedParticipants: (after[0]?.n ?? 0) - (before[0]?.n ?? 0),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/messages");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "postMessage");
  }
}

/**
 * ⭐⭐ TURN A MESSAGE INTO A TASK.
 *
 * ⚠️ The commonest thing that happens in an internal conversation is
 * somebody agreeing to do something, and the commonest failure is that
 * nobody writes it down. The message keeps a link to the task so the
 * same sentence is not turned into three.
 */
export async function messageToTask(input: unknown): Promise<
  ActionResult<{ taskId: string }>
> {
  try {
    const data = z
      .object({
        messageId: z.string().uuid(),
        title: z.string().trim().min(1).max(300),
        assignedTo: z.string().uuid().nullish(),
        dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      })
      .parse(input);
    const ctx = await requirePermission(WRITE);

    const taskId = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [msg] = await tx
          .select({
            id: messages.id,
            body: messages.body,
            taskId: messages.taskId,
            threadId: messages.threadId,
            subjectType: messageThreads.subjectType,
            subjectId: messageThreads.subjectId,
            subjectLabel: messageThreads.subjectLabel,
          })
          .from(messages)
          .leftJoin(messageThreads, eq(messageThreads.id, messages.threadId))
          .where(
            and(eq(messages.tenantId, ctx.tenant.id), eq(messages.id, data.messageId)),
          )
          .limit(1);
        if (!msg) throw new Error("That message does not exist.");
        if (msg.taskId) {
          throw new Error(
            "This message has already been turned into a task. Open that one rather than raising a second for the same sentence.",
          );
        }

        const [task] = await tx
          .insert(tasks)
          .values({
            tenantId: ctx.tenant.id,
            title: data.title,
            detail: msg.body,
            /** ⭐ The task inherits what the conversation was about. */
            subjectType: msg.subjectType,
            subjectId: msg.subjectId,
            subjectLabel: msg.subjectLabel,
            assignedTo: data.assignedTo ?? null,
            dueOn: data.dueOn ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: tasks.id });
        if (!task) throw new Error("The task could not be created.");

        /**
         * ⚠️ Setting task_id is an UPDATE on a message, which the
         * history trigger allows because the body is untouched.
         */
        await tx
          .update(messages)
          .set({ taskId: task.id })
          .where(eq(messages.id, data.messageId));

        return task.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/messages");
    revalidatePath("/tasks");
    return { ok: true, data: { taskId } };
  } catch (err) {
    return toSalesActionError(err, "messageToTask");
  }
}

/* ------------------------------------------------------------------ */

/** ⭐ The inbox. Attention first, then unread, then by recency. */
export async function getInbox(): Promise<
  ActionResult<{
    rows: {
      id: string;
      title: string | null;
      subjectLabel: string | null;
      lastMessageAt: string | null;
      messageCount: number;
      isClosed: boolean;
      unread: boolean;
      needsAttention: boolean;
      tone: string;
    }[];
    summary: ReturnType<typeof summariseInbox>;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const now = new Date();

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const mine = await tx
          .select({
            threadId: threadParticipants.threadId,
            lastReadAt: threadParticipants.lastReadAt,
            isMuted: threadParticipants.isMuted,
          })
          .from(threadParticipants)
          .where(
            and(
              eq(threadParticipants.tenantId, ctx.tenant.id),
              eq(threadParticipants.userId, ctx.user.id),
            ),
          )
          .limit(500);

        if (mine.length === 0) return [] as ThreadRow[];

        const ids = mine.map((m) => m.threadId);
        const threads = await tx
          .select()
          .from(messageThreads)
          .where(
            and(
              eq(messageThreads.tenantId, ctx.tenant.id),
              inArray(messageThreads.id, ids),
            ),
          );

        /**
         * ⭐ Was the reader named in anything since they last looked?
         * That is louder than plain unread, and it survives muting.
         */
        const mentioned = await tx
          .select({ threadId: messages.threadId, at: messages.createdAt })
          .from(messages)
          .where(
            and(
              eq(messages.tenantId, ctx.tenant.id),
              inArray(messages.threadId, ids),
              sql`${ctx.user.id}::uuid = ANY(${messages.mentions})`,
            ),
          )
          .limit(2000);

        const byThread = new Map(mine.map((m) => [m.threadId, m]));
        const latestMention = new Map<string, Date>();
        for (const m of mentioned) {
          const cur = latestMention.get(m.threadId);
          if (!cur || m.at > cur) latestMention.set(m.threadId, m.at);
        }

        return threads.map((t) => {
          const p = byThread.get(t.id);
          const mentionAt = latestMention.get(t.id) ?? null;
          const lastRead = p?.lastReadAt ?? null;
          return {
            id: t.id,
            title: t.title,
            subjectLabel: t.subjectLabel,
            lastMessageAt: t.lastMessageAt ? t.lastMessageAt.toISOString() : null,
            messageCount: t.messageCount,
            isClosed: t.isClosed,
            lastReadAt: lastRead ? lastRead.toISOString() : null,
            isMuted: p?.isMuted ?? false,
            mentionedSinceRead:
              mentionAt !== null && (lastRead === null || mentionAt > lastRead),
          } satisfies ThreadRow;
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    const states = rows.map(threadState).sort(compareThreads);
    const summary = summariseInbox({ rows, now: now.toISOString() });

    return {
      ok: true,
      data: {
        rows: states.map((s) => ({
          id: s.id,
          title: s.title,
          subjectLabel: s.subjectLabel,
          lastMessageAt: s.lastMessageAt,
          messageCount: s.messageCount,
          isClosed: s.isClosed,
          unread: s.unread,
          needsAttention: s.needsAttention,
          tone: s.tone,
        })),
        summary,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getInbox");
  }
}

/** ⭐ One conversation, and marking it read. */
export async function getThread(input: unknown): Promise<
  ActionResult<{
    title: string | null;
    subjectLabel: string | null;
    isClosed: boolean;
    messages: {
      id: string;
      body: string;
      authorName: string | null;
      createdAt: string;
      editedAt: string | null;
      taskId: string | null;
    }[];
    participants: { id: string; name: string }[];
  }>
> {
  try {
    const data = z.object({ threadId: z.string().uuid() }).parse(input);
    const ctx = await requirePermission(READ);

    const out = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [thread] = await tx
          .select()
          .from(messageThreads)
          .where(
            and(
              eq(messageThreads.tenantId, ctx.tenant.id),
              eq(messageThreads.id, data.threadId),
            ),
          )
          .limit(1);
        if (!thread) throw new Error("That conversation does not exist.");

        const rows = await tx
          .select({
            id: messages.id,
            body: messages.body,
            createdAt: messages.createdAt,
            editedAt: messages.editedAt,
            taskId: messages.taskId,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(messages)
          .leftJoin(users, eq(users.id, messages.authorId))
          .where(
            and(
              eq(messages.tenantId, ctx.tenant.id),
              eq(messages.threadId, data.threadId),
            ),
          )
          .orderBy(asc(messages.createdAt))
          .limit(500);

        const people = await tx
          .select({
            id: users.id,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(threadParticipants)
          .leftJoin(users, eq(users.id, threadParticipants.userId))
          .where(eq(threadParticipants.threadId, data.threadId));

        /** ⭐ Opening it is reading it. */
        await tx
          .update(threadParticipants)
          .set({ lastReadAt: new Date() })
          .where(
            and(
              eq(threadParticipants.threadId, data.threadId),
              eq(threadParticipants.userId, ctx.user.id),
            ),
          );

        const name = (f: string | null, l: string | null, e: string | null) =>
          [f, l].filter(Boolean).join(" ").trim() || e || "Unnamed";

        return {
          title: thread.title,
          subjectLabel: thread.subjectLabel,
          isClosed: thread.isClosed,
          messages: rows.map((r) => ({
            id: r.id,
            body: r.body,
            authorName: name(r.first, r.last, r.email),
            createdAt: r.createdAt.toISOString(),
            editedAt: r.editedAt ? r.editedAt.toISOString() : null,
            taskId: r.taskId,
          })),
          participants: people
            .filter((p) => p.id !== null)
            .map((p) => ({ id: p.id as string, name: name(p.first, p.last, p.email) })),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data: out };
  } catch (err) {
    return toSalesActionError(err, "getThread");
  }
}
