/**
 * ⭐⭐⭐ FRONT OFFICE, BATCH 1 AND 2 — TASKS, THE TIMELINE, THE CALENDAR.
 *
 * 🔴 THE TWO FAILURES THIS SUITE EXISTS TO PIN DOWN.
 *
 *    ① Work disappears in two ways that never show as overdue:
 *       assigned to nobody, and dated nowhere. A dashboard that counts
 *       only "late" reports a clean desk while both sit there.
 *
 *    ② A calendar that starts at today hides the hearing nobody
 *       attended and the filing that was missed. Those are the entries
 *       the screen exists for, and they are the ones every calendar
 *       drops the moment the day turns.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  OPEN_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskError,
  addDays,
  compareTasks,
  daysBetween,
  isLive,
  nextRecurrence,
  summariseWorkload,
  taskUrgency,
  type TaskRow,
} from "@/lib/work/tasks";
import {
  AGENDA_SOURCES,
  AgendaError,
  SOURCE_WEIGHT,
  buildAgenda,
  compareEntries,
  complianceEntry,
  eventEntry,
  hearingEntry,
  licenceEntry,
  milestoneEntry,
  taskEntry,
  type AgendaEntry,
} from "@/lib/work/agenda";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
/** ⚠️ JSX gets re-wrapped by the formatter. Collapse before asserting. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0060_tasks_activities_calendar.sql");
const TASK_LIB = read("lib/work/tasks.ts");
const AGENDA_LIB = read("lib/work/agenda.ts");
const TASK_ACTIONS = read("server/actions/tasks.ts");
const ACTIVITY_ACTIONS = read("server/actions/activities.ts");
const AGENDA_ACTIONS = read("server/actions/agenda.ts");
const TASK_PAGE = read("app/(crm)/tasks/page.tsx");
const CAL_PAGE = read("app/(crm)/calendar/page.tsx");
const BOARD = read("components/work/task-board.tsx");
const REGISTRY = read("lib/modules/registry.ts");
const SCHEMA = read("db/schema/work.ts");
const TEMPLATES = read("lib/industry-templates.ts");

const TODAY = "2026-08-13";

/* ================================================================== */
/* ① WHERE A TASK STANDS                                              */
/* ================================================================== */

describe("🔴 the boundary: due today is not late", () => {
  it("calls a task due today 'today', not overdue", () => {
    const v = taskUrgency({ status: "open", dueOn: TODAY, today: TODAY });
    expect(v.urgency).toBe("today");
    expect(v.daysUntilDue).toBe(0);
  });

  it("calls yesterday one day late", () => {
    const v = taskUrgency({ status: "open", dueOn: "2026-08-12", today: TODAY });
    expect(v.urgency).toBe("overdue");
    expect(v.daysUntilDue).toBe(-1);
    expect(v.label).toBe("1 day late");
    expect(v.tone).toBe("danger");
  });

  it("calls tomorrow tomorrow", () => {
    const v = taskUrgency({ status: "open", dueOn: "2026-08-14", today: TODAY });
    expect(v.urgency).toBe("soon");
    expect(v.label).toBe("Tomorrow");
  });

  it("treats the seventh day out as soon and the eighth as later", () => {
    expect(taskUrgency({ status: "open", dueOn: "2026-08-20", today: TODAY }).urgency).toBe(
      "soon",
    );
    expect(taskUrgency({ status: "open", dueOn: "2026-08-21", today: TODAY }).urgency).toBe(
      "later",
    );
  });

  it("🔴 marks an undated open task as DANGER, not as calm", () => {
    const v = taskUrgency({ status: "open", dueOn: null, today: TODAY });
    /**
     * ⚠️ The most dangerous state on the screen and it looks like the
     * quietest one. Never late, never chased, never done.
     */
    expect(v.urgency).toBe("undated");
    expect(v.tone).toBe("danger");
    expect(v.daysUntilDue).toBeNull();
  });

  it("ignores dates once the task is closed", () => {
    expect(
      taskUrgency({ status: "done", dueOn: "2020-01-01", today: TODAY }).urgency,
    ).toBe("done");
    expect(
      taskUrgency({ status: "cancelled", dueOn: null, today: TODAY }).urgency,
    ).toBe("cancelled");
  });

  it("crosses a month end and a leap day without drifting", () => {
    expect(daysBetween("2026-08-31", "2026-09-01")).toBe(1);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("refuses a date that is not a civil day", () => {
    expect(() => taskUrgency({ status: "open", dueOn: "13-08-2026", today: TODAY })).toThrow(
      TaskError,
    );
  });

  it("knows which statuses are still live", () => {
    expect(OPEN_STATUSES).toEqual(["open", "in_progress", "blocked"]);
    expect(isLive("blocked")).toBe(true);
    expect(isLive("done")).toBe(false);
    expect(TASK_STATUSES).toHaveLength(5);
    expect(TASK_PRIORITIES).toHaveLength(4);
  });
});

/* ================================================================== */
/* ② THE TWO NUMBERS NOBODY REPORTS                                   */
/* ================================================================== */

describe("🔴 unassigned and undated are counted separately, and both in red", () => {
  const rows: TaskRow[] = [
    { id: "a", status: "open", priority: "normal", dueOn: "2026-08-01", assignedTo: "u1" },
    { id: "b", status: "open", priority: "high", dueOn: TODAY, assignedTo: "u1" },
    { id: "c", status: "open", priority: "low", dueOn: "2026-08-16", assignedTo: "u2" },
    /** 🔴 Nobody's name on it. */
    { id: "d", status: "open", priority: "urgent", dueOn: "2026-08-20", assignedTo: null },
    /** 🔴 No date on it. */
    { id: "e", status: "in_progress", priority: "normal", dueOn: null, assignedTo: "u2" },
    /** Closed: counts for nothing. */
    { id: "f", status: "done", priority: "urgent", dueOn: "2020-01-01", assignedTo: "u1" },
  ];

  const w = summariseWorkload(rows, TODAY);

  it("counts only live work", () => {
    expect(w.live).toBe(5);
  });

  it("counts the two invisible states", () => {
    expect(w.unassigned).toBe(1);
    expect(w.undated).toBe(1);
  });

  it("⚠️ neither of them shows as overdue, which is the whole problem", () => {
    /** Only task "a" is genuinely late. */
    expect(w.overdue).toBe(1);
  });

  it("reports today and the coming week apart", () => {
    expect(w.today).toBe(1);
    /** ⚠️ Both 16 Aug (3 days) and 20 Aug (7 days) are inside the week. */
    expect(w.soon).toBe(2);
  });

  it("names the worst overdue in days", () => {
    expect(w.worstOverdueDays).toBe(12);
  });

  it("sorts people by what is late, not by name", () => {
    const first = w.byAssignee[0];
    expect(first?.userId).toBe("u1");
    expect(first?.overdue).toBe(1);
  });

  it("keeps unassigned work visible as its own row", () => {
    expect(w.byAssignee.some((a) => a.userId === null)).toBe(true);
  });
});

/* ================================================================== */
/* ③ ORDER                                                            */
/* ================================================================== */

describe("🔴 date first, priority second", () => {
  it("puts a late normal task above an urgent one due next month", () => {
    const late = { id: "1", dueOn: "2026-07-20", priority: "normal" as const };
    const urgent = { id: "2", dueOn: "2026-09-20", priority: "urgent" as const };
    expect([urgent, late].sort(compareTasks)[0]).toBe(late);
  });

  it("breaks a same-day tie by priority", () => {
    const a = { id: "1", dueOn: TODAY, priority: "low" as const };
    const b = { id: "2", dueOn: TODAY, priority: "urgent" as const };
    expect([a, b].sort(compareTasks)[0]).toBe(b);
  });

  it("⚠️ sorts undated tasks LAST, not first", () => {
    const dated = { id: "1", dueOn: "2030-01-01", priority: "low" as const };
    const undated = { id: "2", dueOn: null, priority: "urgent" as const };
    expect([undated, dated].sort(compareTasks)[0]).toBe(dated);
  });

  it("is stable, so the list does not shuffle between renders", () => {
    const a = { id: "aaa", dueOn: TODAY, priority: "normal" as const };
    const b = { id: "bbb", dueOn: TODAY, priority: "normal" as const };
    expect([b, a].sort(compareTasks).map((x) => x.id)).toEqual(["aaa", "bbb"]);
  });
});

/* ================================================================== */
/* ④ RECURRENCE                                                       */
/* ================================================================== */

describe("🔴 a repeat counts from the DUE date, not the completion date", () => {
  it("adds the interval to the due date", () => {
    expect(nextRecurrence({ dueOn: "2026-08-07", repeatEveryDays: 30 })).toBe(
      "2026-09-06",
    );
  });

  it("⚠️ does not drift when the task was finished late", () => {
    /**
     * A monthly filing due on the 7th, completed on the 19th, is still
     * due on the 7th next cycle. Counting from completion lets a task
     * that is always late slide quietly out of its own cycle, one slip
     * at a time, until it is a month adrift and nobody can say when it
     * moved.
     */
    const next = nextRecurrence({ dueOn: "2026-08-07", repeatEveryDays: 30 });
    expect(next).toBe("2026-09-06");
    expect(next).not.toBe(addDays("2026-08-19", 30));
  });

  it("stops at the end date", () => {
    expect(
      nextRecurrence({
        dueOn: "2026-08-07",
        repeatEveryDays: 30,
        repeatUntil: "2026-09-01",
      }),
    ).toBeNull();
  });

  it("runs right up to the end date", () => {
    expect(
      nextRecurrence({
        dueOn: "2026-08-07",
        repeatEveryDays: 30,
        repeatUntil: "2026-09-06",
      }),
    ).toBe("2026-09-06");
  });

  it("refuses an interval that is not a positive whole number", () => {
    expect(() => nextRecurrence({ dueOn: TODAY, repeatEveryDays: 0 })).toThrow(TaskError);
    expect(() => nextRecurrence({ dueOn: TODAY, repeatEveryDays: 1.5 })).toThrow(TaskError);
  });
});

/* ================================================================== */
/* ⑤ THE AGENDA                                                       */
/* ================================================================== */

const ENTRY = (over: Partial<AgendaEntry> = {}): AgendaEntry => ({
  id: "x",
  source: "task",
  on: TODAY,
  title: "Something",
  weight: "ordinary",
  ...over,
});

describe("🔴 the past stays on the agenda", () => {
  it("keeps a missed hearing on the list, on the day it was missed", () => {
    const built = buildAgenda({
      entries: [
        ENTRY({ id: "h1", source: "hearing", on: "2026-08-06", weight: "consequential" }),
      ],
      today: TODAY,
    });
    expect(built.overdueCount).toBe(1);
    expect(built.consequentialOverdueCount).toBe(1);
    expect(built.days[0]?.on).toBe("2026-08-06");
    expect(built.days[0]?.offset).toBe(-7);
    expect(built.days[0]?.label).toBe("7 days ago");
  });

  it("separates what is merely late from what cannot be done late", () => {
    const built = buildAgenda({
      entries: [
        ENTRY({ id: "t1", source: "task", on: "2026-08-01", weight: "ordinary" }),
        ENTRY({ id: "c1", source: "compliance", on: "2026-08-01", weight: "consequential" }),
      ],
      today: TODAY,
    });
    expect(built.overdueCount).toBe(2);
    expect(built.consequentialOverdueCount).toBe(1);
    expect(built.days[0]?.hasConsequential).toBe(true);
  });

  it("labels today and tomorrow in words", () => {
    const built = buildAgenda({
      entries: [ENTRY({ id: "a", on: TODAY }), ENTRY({ id: "b", on: "2026-08-14" })],
      today: TODAY,
    });
    expect(built.days.map((d) => d.label)).toEqual(["Today", "Tomorrow"]);
    expect(built.todayCount).toBe(1);
  });

  it("respects the window in both directions", () => {
    const built = buildAgenda({
      entries: [
        ENTRY({ id: "old", on: "2026-01-01" }),
        ENTRY({ id: "far", on: "2027-01-01" }),
        ENTRY({ id: "in", on: TODAY }),
      ],
      today: TODAY,
      daysAhead: 14,
      daysBack: 30,
    });
    expect(built.total).toBe(1);
  });

  it("refuses a negative window", () => {
    expect(() => buildAgenda({ entries: [], today: TODAY, daysAhead: -1 })).toThrow(
      AgendaError,
    );
  });
});

describe("🔴 within a day, what cannot be done late comes first", () => {
  it("puts a hearing above a task on the same day", () => {
    const task = ENTRY({ id: "t", source: "task", weight: "ordinary" });
    const hearing = ENTRY({ id: "h", source: "hearing", weight: "consequential" });
    expect([task, hearing].sort(compareEntries)[0]).toBe(hearing);
  });

  it("puts money above ordinary work but below a statutory date", () => {
    const money = ENTRY({ id: "m", source: "milestone", weight: "commercial" });
    const task = ENTRY({ id: "t", source: "task", weight: "ordinary" });
    const filing = ENTRY({ id: "c", source: "compliance", weight: "consequential" });
    expect([task, money, filing].sort(compareEntries).map((e) => e.id)).toEqual([
      "c",
      "m",
      "t",
    ]);
  });

  it("weights every source, and the consequential ones are the statutory ones", () => {
    expect(AGENDA_SOURCES).toHaveLength(6);
    expect(SOURCE_WEIGHT.hearing).toBe("consequential");
    expect(SOURCE_WEIGHT.compliance).toBe("consequential");
    expect(SOURCE_WEIGHT.licence).toBe("consequential");
    expect(SOURCE_WEIGHT.milestone).toBe("commercial");
    expect(SOURCE_WEIGHT.task).toBe("ordinary");
    expect(SOURCE_WEIGHT.event).toBe("ordinary");
  });
});

describe("⚠️ an entry belonging to nobody stays on everybody's list", () => {
  it("keeps unowned work in a personal view", () => {
    const built = buildAgenda({
      entries: [
        ENTRY({ id: "mine", ownerId: "u1" }),
        ENTRY({ id: "theirs", ownerId: "u2" }),
        ENTRY({ id: "nobodys", ownerId: null }),
      ],
      today: TODAY,
      ownerId: "u1",
    });
    const ids = built.days.flatMap((d) => d.entries.map((e) => e.id));
    expect(ids).toContain("mine");
    expect(ids).toContain("nobodys");
    expect(ids).not.toContain("theirs");
  });
});

/* ================================================================== */
/* ⑥ THE ADAPTERS                                                     */
/* ================================================================== */

describe("🔴 a licence appears on its RENEWAL date, not its expiry date", () => {
  it("subtracts the lead time", () => {
    const e = licenceEntry({
      id: "l1",
      name: "Trade licence",
      validUntil: "2026-06-30",
      renewalLeadDays: 60,
      authority: "Municipal",
      ownerUserId: null,
      ownerName: null,
    });
    /**
     * ⚠️ Showing it on 30 June is showing it on the day it is already
     * too late, which is how a compliance calendar is technically
     * correct and completely useless.
     */
    expect(e?.on).toBe("2026-05-01");
    expect(e?.title).toContain("Renew");
    expect(e?.detail).toContain("2026-06-30");
    expect(e?.weight).toBe("consequential");
  });

  it("handles a zero lead time without moving the date", () => {
    const e = licenceEntry({
      id: "l2",
      name: "X",
      validUntil: "2026-06-30",
      renewalLeadDays: 0,
      authority: null,
      ownerUserId: null,
      ownerName: null,
    });
    expect(e?.on).toBe("2026-06-30");
  });

  it("drops a licence with no expiry date rather than guessing one", () => {
    expect(
      licenceEntry({
        id: "l3",
        name: "X",
        validUntil: null,
        renewalLeadDays: 60,
        authority: null,
        ownerUserId: null,
        ownerName: null,
      }),
    ).toBeNull();
  });
});

describe("⭐ the other adapters", () => {
  it("drops an undated task rather than inventing a day for it", () => {
    expect(
      taskEntry({
        id: "t",
        title: "x",
        dueOn: null,
        subjectLabel: null,
        assignedTo: null,
        assigneeName: null,
      }),
    ).toBeNull();
  });

  it("drops a cancelled diary entry from the agenda but not from the record", () => {
    const e = eventEntry(
      {
        id: "e",
        title: "x",
        startsAt: "2026-08-13T05:30:00.000Z",
        allDay: false,
        location: null,
        organiserId: null,
        organiserName: null,
        status: "cancelled",
      },
      () => TODAY,
      () => "11:00",
    );
    expect(e).toBeNull();
  });

  it("shows a time on a timed entry and none on an all-day one", () => {
    const timed = eventEntry(
      {
        id: "e",
        title: "x",
        startsAt: "2026-08-13T05:30:00.000Z",
        allDay: false,
        location: "Office",
        organiserId: "u1",
        organiserName: "A",
        status: "confirmed",
      },
      () => TODAY,
      () => "11:00",
    );
    expect(timed?.atLabel).toBe("11:00");

    const allDay = eventEntry(
      {
        id: "f",
        title: "x",
        startsAt: "2026-08-13T05:30:00.000Z",
        allDay: true,
        location: null,
        organiserId: null,
        organiserName: null,
        status: "confirmed",
      },
      () => TODAY,
      () => "11:00",
    );
    expect(allDay?.atLabel).toBeNull();
  });

  it("⚠️ drops a settled milestone and keeps a part-paid one", () => {
    const money = (minor: bigint) => `Rs${minor}`;
    const settled = milestoneEntry(
      {
        id: "m1",
        label: "Slab 3",
        dueOn: TODAY,
        amountMinor: 100n,
        amountPaidMinor: 100n,
        status: "pending",
        unitLabel: "A-101",
      },
      money,
    );
    expect(settled).toBeNull();

    const partPaid = milestoneEntry(
      {
        id: "m2",
        label: "Slab 4",
        dueOn: TODAY,
        amountMinor: 100n,
        amountPaidMinor: 40n,
        status: "pending",
        unitLabel: "A-101",
      },
      money,
    );
    /** ⭐ The OUTSTANDING amount, not the original one. */
    expect(partPaid?.title).toContain("Rs60");
    expect(partPaid?.weight).toBe("commercial");
  });

  it("links a hearing back to its matter", () => {
    const e = hearingEntry({
      id: "h",
      matterId: "m-1",
      hearingDate: TODAY,
      matterNo: "M-001",
      title: "Sharma v Kapoor",
      courtName: "Bombay High Court",
      purpose: "arguments",
      appearedBy: "u1",
      appearedByName: "Counsel",
    });
    expect(e.href).toBe("/legal/matters/m-1");
    expect(e.title).toContain("M-001");
    expect(e.weight).toBe("consequential");
  });

  it("carries the period on a filing", () => {
    const e = complianceEntry({
      id: "c",
      dueDate: TODAY,
      periodLabel: "Jul 2026",
      obligationName: "GSTR-1",
      ownerUserId: null,
      ownerName: null,
    });
    expect(e.title).toBe("GSTR-1");
    expect(e.detail).toBe("Jul 2026");
  });
});

/* ================================================================== */
/* ⑦ THE RULES THAT LIVE IN THE DATABASE                              */
/* ================================================================== */

describe("🔴 0060 puts the rules where nothing can route around them", () => {
  const sql = sqlCode(SQL);

  it("refuses a completed task with no evidence of who and when", () => {
    expect(sql).toContain("tasks_done_is_evidenced");
    expect(flat(sql)).toMatch(
      /tasks_done_is_evidenced CHECK \(\s*status <> 'done' OR \(completed_at IS NOT NULL AND completed_by IS NOT NULL\)/,
    );
  });

  it("refuses a cancelled task with no reason", () => {
    expect(sql).toContain("tasks_cancelled_is_explained");
  });

  it("⚠️ refuses an open task that still carries a completion", () => {
    expect(sql).toContain("tasks_open_is_not_completed");
  });

  it("refuses half a subject link", () => {
    expect(sql).toContain("tasks_subject_is_whole");
    expect(sql).toContain("activities_subject_type_known");
  });

  it("refuses a repeating task with no date to repeat from", () => {
    expect(sql).toContain("tasks_repeat_needs_a_due_date");
  });

  it("creates the next recurrence on completion, not on a schedule", () => {
    expect(sql).toContain("ordence_recur_task");
    expect(sql).toContain("AFTER UPDATE ON tasks");
    /** ⚠️ And guards against a double completion creating two. */
    expect(flat(sql)).toMatch(/IF EXISTS \(\s*SELECT 1 FROM tasks\s*WHERE tenant_id = NEW\.tenant_id\s*AND recurred_from = NEW\.id/);
  });

  it("🔴 makes system and integration activities immutable", () => {
    expect(sql).toContain("ordence_guard_activity_immutable");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON activities");
    expect(flat(sql)).toMatch(/cannot be rewritten|cannot be edited/i);
  });

  it("refuses to move a note onto a different record or a different day", () => {
    expect(flat(sql)).toMatch(/cannot be moved to a different record/i);
    expect(flat(sql)).toMatch(/time something happened cannot be changed/i);
  });

  it("requires a direction on a contact event", () => {
    expect(sql).toContain("activities_contact_has_direction");
  });

  it("names the integration on any row that came from one", () => {
    expect(sql).toContain("activities_integration_is_named");
    expect(sql).toContain("activities_external_unique");
  });

  it("refuses a diary entry that ends before it starts", () => {
    expect(sql).toContain("calendar_events_ends_after_start");
    expect(flat(sql)).toMatch(/CHECK \(ends_at > starts_at\)/);
  });

  it("refuses to un-cancel an entry, or to move one that already happened", () => {
    expect(sql).toContain("ordence_guard_event_history");
    expect(flat(sql)).toMatch(/cannot be un-cancelled/i);
    expect(flat(sql)).toMatch(/already in the past and cannot be moved/i);
  });

  it("refuses an attendee who is nobody", () => {
    expect(sql).toContain("calendar_event_attendees_is_somebody");
  });

  it("puts RLS on every new table, with platform scope in USING only", () => {
    for (const t of ["tasks", "activities", "calendar_events", "calendar_event_attendees"]) {
      expect(sql, t).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(sql, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    }
    const withChecks = sql.match(/WITH CHECK \([^)]*\)/g) ?? [];
    expect(withChecks.length).toBeGreaterThan(0);
    for (const w of withChecks) expect(w).not.toContain("app_platform_scope");
  });
});

/* ================================================================== */
/* ⑧ THE RULES THAT LIVE IN THE ACTIONS                               */
/* ================================================================== */

describe("🔴 the actions refuse the quiet mistakes with a sentence", () => {
  it("takes the completion from the server, never from the caller", () => {
    const c = code(TASK_ACTIONS);
    expect(c).toContain("completedAt: new Date()");
    expect(c).toContain("completedBy: ctx.user.id");
    /** ⚠️ The close schema must not accept them from outside. */
    expect(c).not.toMatch(/completedBy:\s*z\./);
    expect(c).not.toMatch(/completedAt:\s*z\./);
  });

  it("refuses a cancellation with no reason", () => {
    expect(flat(code(TASK_ACTIONS))).toMatch(/cancelled task has to say why/i);
  });

  it("refuses half a subject link", () => {
    expect(flat(code(TASK_ACTIONS))).toMatch(/Half a link/);
  });

  it("refuses a repeating task with no due date", () => {
    expect(flat(code(TASK_ACTIONS))).toMatch(/repeating task needs a due date/i);
  });

  it("⭐ writes to the record's own timeline when a task is closed", () => {
    const c = code(TASK_ACTIONS);
    expect(c).toContain("insert(activities)");
    /** 🔴 As `system`, so the row cannot be edited away afterwards. */
    expect(c).toMatch(/source: "system"/);
  });

  it("requires a direction on a call, email or message", () => {
    expect(flat(code(ACTIVITY_ACTIONS))).toMatch(/Say which way it went/i);
  });

  it("🔴 refuses a timeline entry dated in the future", () => {
    const c = flat(code(ACTIVITY_ACTIONS));
    expect(c).toMatch(/dated in the future/i);
    expect(c).toMatch(/is a task, not a record/i);
  });

  it("orders the timeline by when it happened, not when it was typed", () => {
    expect(code(ACTIVITY_ACTIONS)).toContain("desc(activities.occurredAt)");
    expect(code(ACTIVITY_ACTIONS)).not.toContain("desc(activities.createdAt)");
  });

  it("refuses a diary entry that ends before it starts", () => {
    expect(flat(code(AGENDA_ACTIONS))).toMatch(/ends before it starts/i);
  });

  it("🔴 derives the business day in Asia/Kolkata, not from the server", () => {
    const c = code(AGENDA_ACTIONS);
    expect(c).toContain('"Asia/Kolkata"');
    expect(c).toContain("timeZone: IST");
  });

  it("⚠️ drops filings that are already done from the agenda", () => {
    expect(code(AGENDA_ACTIONS)).toMatch(/f\.status === "filed"/);
  });
});

/* ================================================================== */
/* ⑨ THE SCREENS                                                      */
/* ================================================================== */

describe("⭐ the screens lead with what nobody else counts", () => {
  it("shows unassigned and undated as their own counters, in red", () => {
    const p = flat(TASK_PAGE);
    expect(p).toMatch(/Nobody&apos;s name on it|Nobody's name on it/);
    expect(p).toMatch(/No date on it/);
    expect(p).toMatch(/never shows up as late/i);
  });

  it("says why the person list is sorted by lateness", () => {
    expect(flat(TASK_PAGE)).toMatch(/hides whoever is drowning/i);
  });

  it("🔴 the calendar keeps the past and says so", () => {
    const p = flat(CAL_PAGE);
    expect(p).toMatch(/Missed, and cannot be done late/);
    expect(p).toMatch(/Still shown, on the day it was due/i);
  });

  it("explains the licence lead time where the decision is visible", () => {
    expect(flat(CAL_PAGE)).toMatch(/renewal date, not its expiry date/i);
  });

  it("explains the recurrence rule where somebody sets it", () => {
    expect(flat(BOARD)).toMatch(/creates the next one when this one is completed/i);
    expect(flat(BOARD)).toMatch(/counts from the due date/i);
  });

  it("sorts the board by date first and says so", () => {
    expect(flat(BOARD)).toMatch(/date first and priority second/i);
  });
});

describe("⭐ registered, charged for, and in every industry", () => {
  it("puts tasks and calendar in the registry under home, not free", () => {
    const c = code(REGISTRY);
    for (const nav of ["tasks", "calendar"]) {
      expect(c, nav).toContain(`navId: "${nav}"`);
    }
    const block = c.slice(c.indexOf('navId: "tasks"'), c.indexOf('navId: "search"'));
    expect(block).not.toContain("feature: null");
    expect(block).toContain('group: "home"');
  });

  it("🔴 puts them in the CORE nav, so every industry gets them", () => {
    /**
     * ⚠️ A trading company and a law firm must get the same answer to
     * "what am I doing today". Putting these behind an industry section
     * would give them different ones.
     */
    const core = TEMPLATES.slice(
      TEMPLATES.indexOf("const CORE_NAV_SECTION"),
      TEMPLATES.indexOf("const ADMIN_NAV_SECTION"),
    );
    expect(core).toContain('href: "/tasks"');
    expect(core).toContain('href: "/calendar"');
  });

  it("declares the new tables in the Drizzle schema", () => {
    for (const t of ["tasks", "activities", "calendarEvents", "calendarEventAttendees"]) {
      expect(SCHEMA, t).toContain(`export const ${t} = pgTable`);
    }
    expect(read("db/schema/index.ts")).toContain('export * from "./work"');
  });
});

describe("⚠️ the libs stay pure", () => {
  it("reads no clock and no database", () => {
    for (const [name, src] of [
      ["tasks", TASK_LIB],
      ["agenda", AGENDA_LIB],
    ] as const) {
      const c = code(src);
      expect(c, name).not.toMatch(/Date\.now\(/);
      expect(c, name).not.toContain("@/db");
      /** ⚠️ `new Date(` is allowed only for arithmetic on a passed-in value. */
      expect(c, name).not.toMatch(/new Date\(\)/);
    }
  });
});
