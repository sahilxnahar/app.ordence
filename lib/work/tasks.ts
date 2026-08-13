/**
 * Ordence — ⭐⭐ WHAT IS ON SOMEBODY'S DESK
 * Version: v1.9.0-alpha
 *
 * Pure. No database, no clock. `today` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE CLOCK IS AN ARGUMENT, AGAIN
 * ══════════════════════════════════════════════════════════════════════
 * A task list is the one screen where "is this overdue" is computed on
 * every render for every row. A function that reads the clock itself
 * cannot be tested at a boundary, and the boundary is the whole point:
 * a task due today is not overdue, and a task due yesterday is.
 *
 * ⚠️ AND THERE IS NO STORED "DAYS REMAINING" ANYWHERE. The morning a
 * nightly job does not run is the morning every task shows the wrong
 * number, and nobody notices because the number looks like a number.
 */

export class TaskError extends Error {}

/* ------------------------------------------------------------------ */

export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

export const TASK_PRIORITIES: readonly TaskPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;

/** ⭐ Still live. Everything else is finished, one way or another. */
export const OPEN_STATUSES: readonly TaskStatus[] = ["open", "in_progress", "blocked"] as const;

export function isLive(status: TaskStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/* ------------------------------------------------------------------ */
/* WHERE A TASK STANDS                                                 */
/* ------------------------------------------------------------------ */

export type TaskUrgency =
  /** Finished. */
  | "done"
  | "cancelled"
  /** 🔴 Past its date and still live. */
  | "overdue"
  /** Due today. */
  | "today"
  /** Due within the next week. */
  | "soon"
  /** Further out. */
  | "later"
  /**
   * ⚠️ NO DUE DATE AND STILL OPEN. Deliberately its own state and not
   * folded into "later" — a task with no date never appears on any
   * dated list, so it is invisible on exactly the screens people read.
   */
  | "undated";

export type TaskVerdict = {
  urgency: TaskUrgency;
  /** Negative where overdue. Null where there is no date. */
  daysUntilDue: number | null;
  label: string;
  tone: "ok" | "warn" | "danger" | "muted";
};

const DAY_MS = 86_400_000;

/** Whole days between two civil dates. Never a float, never a timezone. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${assertCivilDay(fromIso)}T00:00:00Z`);
  const b = Date.parse(`${assertCivilDay(toIso)}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

export function assertCivilDay(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new TaskError(`Expected a date as YYYY-MM-DD, got "${iso}".`);
  }
  return iso;
}

/** ⭐ Add whole days to a civil date without touching a timezone. */
export function addDays(iso: string, days: number): string {
  if (!Number.isInteger(days)) throw new TaskError("Days must be a whole number.");
  const t = Date.parse(`${assertCivilDay(iso)}T00:00:00Z`) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

export function taskUrgency(args: {
  status: TaskStatus;
  dueOn: string | null;
  today: string;
}): TaskVerdict {
  if (args.status === "done") {
    return { urgency: "done", daysUntilDue: null, label: "Done", tone: "ok" };
  }
  if (args.status === "cancelled") {
    return { urgency: "cancelled", daysUntilDue: null, label: "Cancelled", tone: "muted" };
  }

  if (args.dueOn === null) {
    /**
     * 🔴 THE MOST DANGEROUS STATE ON THE SCREEN, and it looks like the
     * calmest one. A task with no date is never late, never chased, and
     * never done.
     */
    return {
      urgency: "undated",
      daysUntilDue: null,
      label: "No date",
      tone: "danger",
    };
  }

  const days = daysBetween(args.today, args.dueOn);

  if (days < 0) {
    return {
      urgency: "overdue",
      daysUntilDue: days,
      label: days === -1 ? "1 day late" : `${-days} days late`,
      tone: "danger",
    };
  }
  if (days === 0) {
    return { urgency: "today", daysUntilDue: 0, label: "Today", tone: "warn" };
  }
  if (days <= 7) {
    return {
      urgency: "soon",
      daysUntilDue: days,
      label: days === 1 ? "Tomorrow" : `In ${days} days`,
      tone: "warn",
    };
  }
  return {
    urgency: "later",
    daysUntilDue: days,
    label: `In ${days} days`,
    tone: "ok",
  };
}

/* ------------------------------------------------------------------ */
/* RECURRENCE                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ The next instance of a repeating task.
 *
 * 🔴 COUNTED FROM THE DUE DATE, NOT FROM THE COMPLETION DATE. A monthly
 * filing due on the 7th that somebody completes on the 19th is still due
 * on the 7th next month. Counting from completion lets a task that is
 * always done late drift quietly out of its own cycle, one slip at a
 * time, until it is a month adrift and nobody can say when it moved.
 */
export function nextRecurrence(args: {
  dueOn: string;
  repeatEveryDays: number;
  repeatUntil?: string | null;
}): string | null {
  if (!Number.isInteger(args.repeatEveryDays) || args.repeatEveryDays <= 0) {
    throw new TaskError("A repeat interval must be a whole number of days above zero.");
  }
  const next = addDays(args.dueOn, args.repeatEveryDays);
  if (args.repeatUntil && next > assertCivilDay(args.repeatUntil)) return null;
  return next;
}

/* ------------------------------------------------------------------ */
/* THE WORKLOAD                                                        */
/* ------------------------------------------------------------------ */

export type TaskRow = {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueOn: string | null;
  assignedTo: string | null;
};

export type Workload = {
  live: number;
  overdue: number;
  today: number;
  soon: number;
  /** 🔴 Open, and nobody's name on it. */
  unassigned: number;
  /** 🔴 Open, and no date on it. */
  undated: number;
  /** The oldest thing still not done, in days late. Zero if nothing is late. */
  worstOverdueDays: number;
  byAssignee: { userId: string | null; live: number; overdue: number }[];
};

/**
 * ⭐⭐ THE FOUR NUMBERS A MANAGER ACTUALLY LOOKS AT.
 *
 * ⚠️ `unassigned` and `undated` are reported separately and both in red,
 * because they are the two ways work disappears without anybody deciding
 * to drop it. A task assigned to nobody is nobody's problem. A task with
 * no date is on no list. Neither will ever show up as overdue, so a
 * dashboard that counts only overdue work reports a clean desk while the
 * work sits there.
 */
export function summariseWorkload(rows: readonly TaskRow[], today: string): Workload {
  assertCivilDay(today);

  let live = 0;
  let overdue = 0;
  let dueToday = 0;
  let soon = 0;
  let unassigned = 0;
  let undated = 0;
  let worst = 0;

  const perUser = new Map<string | null, { live: number; overdue: number }>();

  for (const r of rows) {
    if (!isLive(r.status)) continue;
    live += 1;

    if (r.assignedTo === null) unassigned += 1;

    const bucket = perUser.get(r.assignedTo) ?? { live: 0, overdue: 0 };
    bucket.live += 1;

    const v = taskUrgency({ status: r.status, dueOn: r.dueOn, today });
    if (v.urgency === "undated") {
      undated += 1;
    } else if (v.urgency === "overdue") {
      overdue += 1;
      bucket.overdue += 1;
      const late = -(v.daysUntilDue ?? 0);
      if (late > worst) worst = late;
    } else if (v.urgency === "today") {
      dueToday += 1;
    } else if (v.urgency === "soon") {
      soon += 1;
    }

    perUser.set(r.assignedTo, bucket);
  }

  const byAssignee = [...perUser.entries()]
    .map(([userId, b]) => ({ userId, live: b.live, overdue: b.overdue }))
    /** ⚠️ Worst first. A list sorted by name hides the person drowning. */
    .sort((a, b) => b.overdue - a.overdue || b.live - a.live);

  return {
    live,
    overdue,
    today: dueToday,
    soon,
    unassigned,
    undated,
    worstOverdueDays: worst,
    byAssignee,
  };
}

/* ------------------------------------------------------------------ */
/* ORDER                                                               */
/* ------------------------------------------------------------------ */

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * ⭐ THE ORDER A LIST OF WORK SHOULD BE IN.
 *
 * 🔴 Date first, priority second. A "normal" task three weeks late beats
 * an "urgent" one due next month, and every product that sorts by
 * priority first teaches its users that the priority field is a lie they
 * can set to urgent to get attention.
 *
 * ⚠️ Undated tasks sort LAST, not first. They are surfaced by their own
 * counter, in red, rather than by clogging the top of the list somebody
 * reads every morning.
 */
export function compareTasks(
  a: { dueOn: string | null; priority: TaskPriority; id: string },
  b: { dueOn: string | null; priority: TaskPriority; id: string },
): number {
  if (a.dueOn === null && b.dueOn !== null) return 1;
  if (a.dueOn !== null && b.dueOn === null) return -1;
  if (a.dueOn !== null && b.dueOn !== null && a.dueOn !== b.dueOn) {
    return a.dueOn < b.dueOn ? -1 : 1;
  }
  const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (p !== 0) return p;
  /** ⚠️ A stable tie-break, so the list does not shuffle between renders. */
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
