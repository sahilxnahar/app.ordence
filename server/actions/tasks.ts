"use server";

/**
 * Ordence — ⭐⭐ TASKS, AND THE TIMELINE THEY WRITE INTO
 * Version: v1.9.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO NUMBERS NOBODY REPORTS
 * ══════════════════════════════════════════════════════════════════════
 * Every task product counts what is overdue. Almost none count the two
 * ways work actually disappears:
 *
 *   **Assigned to nobody.** Nobody's problem, so nobody does it.
 *   **No due date.** On no dated list, so it never becomes overdue.
 *
 * ⚠️ Neither will ever appear as late, which means a dashboard counting
 * only overdue work reports a clean desk while the work sits there. Both
 * are counted here, separately, and both in red.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { activities, tasks } from "@/db/schema/work";
import { users } from "@/db/schema/core";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  compareTasks,
  isLive,
  summariseWorkload,
  taskUrgency,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/work/tasks";

const READ = "crm.contacts.read" as const;
const WRITE = "crm.contacts.write" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

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

const statuses = TASK_STATUSES as unknown as [TaskStatus, ...TaskStatus[]];
const priorities = TASK_PRIORITIES as unknown as [TaskPriority, ...TaskPriority[]];

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1, "A task needs a title.").max(300),
  detail: z.string().trim().max(4000).optional(),
  subjectType: z.enum(SUBJECT_TYPES).nullish(),
  subjectId: z.string().uuid().nullish(),
  subjectLabel: z.string().trim().max(300).nullish(),
  assignedTo: z.string().uuid().nullish(),
  dueOn: civilDay.nullish(),
  priority: z.enum(priorities).default("normal"),
  repeatEveryDays: z.number().int().positive().nullish(),
  repeatUntil: civilDay.nullish(),
});

/**
 * ⭐⭐ CREATE OR AMEND A TASK.
 *
 * ⚠️ The subject is half a link or a whole one. A type with no id, or an
 * id with no type, will never resolve on a screen and the database
 * refuses it; catching it here produces a sentence instead of a
 * constraint name.
 */
export async function saveTask(
  input: unknown,
): Promise<ActionResult<{ id: string; created: boolean }>> {
  try {
    const data = saveSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const hasType = data.subjectType !== null && data.subjectType !== undefined;
    const hasId = data.subjectId !== null && data.subjectId !== undefined;
    if (hasType !== hasId) {
      throw new Error(
        "A task is attached to a record or to nothing. Half a link, with a type but no record or a record but no type, will never resolve on a screen.",
      );
    }
    if (data.repeatEveryDays && !data.dueOn) {
      throw new Error(
        "A repeating task needs a due date to repeat from. Without one there is nothing to add the interval to, and the repeat silently never happens.",
      );
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          const [existing] = await tx
            .select({ id: tasks.id, status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.tenantId, ctx.tenant.id), eq(tasks.id, data.id)))
            .limit(1);
          if (!existing) throw new Error("That task does not exist.");
          /**
           * ⚠️ A FINISHED TASK IS NOT EDITED BACK OPEN HERE. Reopening
           * is its own action with its own audit line, because a task
           * that was completed and is now open again is a fact somebody
           * will ask about.
           */
          if (!isLive(existing.status as TaskStatus)) {
            throw new Error(
              "This task is already closed. Reopen it if the work came back, so the record shows that it did.",
            );
          }

          await tx
            .update(tasks)
            .set({
              title: data.title,
              detail: data.detail ?? null,
              subjectType: data.subjectType ?? null,
              subjectId: data.subjectId ?? null,
              subjectLabel: data.subjectLabel ?? null,
              assignedTo: data.assignedTo ?? null,
              dueOn: data.dueOn ?? null,
              priority: data.priority,
              repeatEveryDays: data.repeatEveryDays ?? null,
              repeatUntil: data.repeatUntil ?? null,
              updatedAt: new Date(),
              updatedBy: ctx.user.id,
            })
            .where(and(eq(tasks.tenantId, ctx.tenant.id), eq(tasks.id, data.id)));

          await writeAudit(ctx, {
            action: "update",
            resourceType: "task",
            resourceId: data.id,
            newValue: { title: data.title, dueOn: data.dueOn ?? null },
            severity: "info",
          });
          return { id: data.id, created: false };
        }

        const [row] = await tx
          .insert(tasks)
          .values({
            tenantId: ctx.tenant.id,
            title: data.title,
            detail: data.detail ?? null,
            subjectType: data.subjectType ?? null,
            subjectId: data.subjectId ?? null,
            subjectLabel: data.subjectLabel ?? null,
            assignedTo: data.assignedTo ?? null,
            dueOn: data.dueOn ?? null,
            priority: data.priority,
            repeatEveryDays: data.repeatEveryDays ?? null,
            repeatUntil: data.repeatUntil ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: tasks.id });

        if (!row) throw new Error("The task could not be saved.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "task",
          resourceId: row.id,
          newValue: { title: data.title, assignedTo: data.assignedTo ?? null },
          severity: "info",
        });
        return { id: row.id, created: true };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/tasks");
    revalidatePath("/calendar");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "saveTask");
  }
}

/* ------------------------------------------------------------------ */

const closeSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["done", "cancelled"]),
  outcome: z.string().trim().max(2000).optional(),
  cancelledReason: z.string().trim().max(500).optional(),
});

/**
 * ⭐⭐ CLOSE A TASK, AND SAY WHAT HAPPENED.
 *
 * 🔴 THE COMPLETION IS EVIDENCED BY THE SERVER, NOT BY THE FORM. Who and
 *    when come from the session and the clock, never from the client. A
 *    completion a caller can supply is a completion a caller can forge.
 *
 * ⭐ AND THE RECURRENCE HAPPENS IN THE DATABASE, on the trigger, not
 *    here. If this action were bypassed by an import or a script the
 *    next instance would still be created.
 */
export async function closeTask(input: unknown): Promise<
  ActionResult<{ id: string; recurredId: string | null; nextDueOn: string | null }>
> {
  try {
    const data = closeSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    if (data.status === "cancelled" && !data.cancelledReason) {
      throw new Error(
        "A cancelled task has to say why. Cancelled with no reason is indistinguishable from forgotten, and the two need different conversations.",
      );
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [before] = await tx
          .select({
            id: tasks.id,
            status: tasks.status,
            title: tasks.title,
            subjectType: tasks.subjectType,
            subjectId: tasks.subjectId,
            subjectLabel: tasks.subjectLabel,
          })
          .from(tasks)
          .where(and(eq(tasks.tenantId, ctx.tenant.id), eq(tasks.id, data.id)))
          .limit(1);
        if (!before) throw new Error("That task does not exist.");
        if (!isLive(before.status as TaskStatus)) {
          throw new Error("That task is already closed.");
        }

        await tx
          .update(tasks)
          .set({
            status: data.status,
            /** 🔴 From the server. Never from the caller. */
            completedAt: new Date(),
            completedBy: ctx.user.id,
            outcome: data.outcome ?? null,
            cancelledReason: data.cancelledReason ?? null,
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(and(eq(tasks.tenantId, ctx.tenant.id), eq(tasks.id, data.id)));

        /** ⭐ The trigger in 0060 creates the next instance, if there is one. */
        const [recurred] = await tx
          .select({ id: tasks.id, dueOn: tasks.dueOn })
          .from(tasks)
          .where(and(eq(tasks.tenantId, ctx.tenant.id), eq(tasks.recurredFrom, data.id)))
          .limit(1);

        /**
         * ⭐ CLOSING A TASK WRITES TO THE TIMELINE OF THE RECORD IT
         * BELONGED TO. That is the whole reason the timeline exists: the
         * customer's history should show that somebody rang them, without
         * anybody having to write it twice.
         */
        if (before.subjectType && before.subjectId) {
          await tx.insert(activities).values({
            tenantId: ctx.tenant.id,
            subjectType: before.subjectType,
            subjectId: before.subjectId,
            subjectLabel: before.subjectLabel,
            kind: "status_change",
            summary:
              data.status === "done"
                ? `Task completed: ${before.title}`
                : `Task cancelled: ${before.title}`,
            body: data.outcome ?? data.cancelledReason ?? null,
            userId: ctx.user.id,
            /** 🔴 system, so the timeline row cannot later be edited away. */
            source: "system",
            taskId: data.id,
            createdBy: ctx.user.id,
          });
        }

        await writeAudit(ctx, {
          action: "update",
          resourceType: "task",
          resourceId: data.id,
          newValue: { status: data.status },
          severity: "info",
        });

        return {
          id: data.id,
          recurredId: recurred?.id ?? null,
          nextDueOn: recurred?.dueOn ?? null,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/tasks");
    revalidatePath("/calendar");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "closeTask");
  }
}

/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT IS ON THE DESK.
 *
 * ⚠️ Evaluated against today on every read. Nothing stores a "days
 * remaining", because the morning a nightly job does not run is the
 * morning every row shows the wrong number and the number still looks
 * like a number.
 */
export async function getTasks(input?: unknown): Promise<
  ActionResult<{
    rows: {
      id: string;
      title: string;
      detail: string | null;
      subjectType: string | null;
      subjectId: string | null;
      subjectLabel: string | null;
      assignedTo: string | null;
      assigneeName: string | null;
      dueOn: string | null;
      priority: TaskPriority;
      status: TaskStatus;
      urgency: string;
      urgencyLabel: string;
      tone: string;
      repeats: boolean;
    }[];
    workload: ReturnType<typeof summariseWorkload>;
    today: string;
  }>
> {
  try {
    const filter = z
      .object({
        mineOnly: z.boolean().default(false),
        includeClosed: z.boolean().default(false),
      })
      .parse(input ?? {});
    const ctx = await requirePermission(READ);
    const today = new Date().toISOString().slice(0, 10);

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const conditions = [eq(tasks.tenantId, ctx.tenant.id)];
        if (!filter.includeClosed) {
          conditions.push(inArray(tasks.status, ["open", "in_progress", "blocked"]));
        }
        if (filter.mineOnly) conditions.push(eq(tasks.assignedTo, ctx.user.id));

        return tx
          .select({
            id: tasks.id,
            title: tasks.title,
            detail: tasks.detail,
            subjectType: tasks.subjectType,
            subjectId: tasks.subjectId,
            subjectLabel: tasks.subjectLabel,
            assignedTo: tasks.assignedTo,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            dueOn: tasks.dueOn,
            priority: tasks.priority,
            status: tasks.status,
            repeatEveryDays: tasks.repeatEveryDays,
          })
          .from(tasks)
          .leftJoin(users, eq(users.id, tasks.assignedTo))
          .where(and(...conditions))
          .limit(1000);
      },
      { impersonationId: ctx.impersonationId },
    );

    const workload = summariseWorkload(
      rows.map((r) => ({
        id: r.id,
        status: r.status as TaskStatus,
        priority: r.priority as TaskPriority,
        dueOn: r.dueOn,
        assignedTo: r.assignedTo,
      })),
      today,
    );

    const out = rows
      .map((r) => {
        const v = taskUrgency({
          status: r.status as TaskStatus,
          dueOn: r.dueOn,
          today,
        });
        const name =
          [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || r.email || null;
        return {
          id: r.id,
          title: r.title,
          detail: r.detail,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          subjectLabel: r.subjectLabel,
          assignedTo: r.assignedTo,
          assigneeName: name,
          dueOn: r.dueOn,
          priority: r.priority as TaskPriority,
          status: r.status as TaskStatus,
          urgency: v.urgency,
          urgencyLabel: v.label,
          tone: v.tone,
          repeats: r.repeatEveryDays !== null,
        };
      })
      .sort(compareTasks);

    return { ok: true, data: { rows: out, workload, today } };
  } catch (err) {
    return toSalesActionError(err, "getTasks");
  }
}

/** ⭐ Who a task can be given to. */
export async function getAssignableUsers(): Promise<
  ActionResult<{ people: { id: string; name: string }[] }>
> {
  try {
    const ctx = await requirePermission(READ);
    const people = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select({
            id: users.id,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.tenantId, ctx.tenant.id))
          .orderBy(asc(users.firstName))
          .limit(500),
      { impersonationId: ctx.impersonationId },
    );

    return {
      ok: true,
      data: {
        people: people.map((p) => ({
          id: p.id,
          name: [p.first, p.last].filter(Boolean).join(" ").trim() || p.email || "Unnamed",
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getAssignableUsers");
  }
}
