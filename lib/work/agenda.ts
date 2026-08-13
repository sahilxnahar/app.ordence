/**
 * Ordence — ⭐⭐⭐ EVERYTHING DATED, IN ONE LIST
 * Version: v1.9.0-alpha
 *
 * Pure. No database, no clock. `today` is an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE POINT OF A CALENDAR IS NOT THE CALENDAR
 * ══════════════════════════════════════════════════════════════════════
 * Ordence already knew about six kinds of dated thing, and kept each of
 * them on its own screen:
 *
 *   hearings              (0058)   the diary a clerk reads at eight
 *   compliance due dates  (0032)   statutory filings
 *   licence expiries      (0032)   with their own lead time
 *   payment milestones    (sales)  money due from a buyer
 *   tasks                 (0060)   what somebody has to do
 *   calendar events       (0060)   where somebody has to be
 *
 * ⚠️ A person does not have six days. They have one. Six screens each
 * showing a true subset of tomorrow is the same failure as six systems,
 * and it produces the same result: a paper diary on the desk, which is
 * the only place all six appear together.
 *
 * ⭐ SO THE CALENDAR IS A MERGE, NOT A TABLE. Nothing here is stored.
 * Every source keeps its own record, its own rules and its own screen,
 * and this file puts them in one order.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE SOURCE IS ALWAYS NAMED
 * ══════════════════════════════════════════════════════════════════════
 * An agenda that says "Renewal, 14 March" and nothing else forces the
 * reader to go and find out what it is. Every entry carries where it
 * came from, so a person can act on it from the list.
 */

import { assertCivilDay, daysBetween } from "./tasks";

export class AgendaError extends Error {}

/* ------------------------------------------------------------------ */

export type AgendaSource =
  | "task"
  | "event"
  | "hearing"
  | "compliance"
  | "licence"
  | "milestone";

export const AGENDA_SOURCES: readonly AgendaSource[] = [
  "task",
  "event",
  "hearing",
  "compliance",
  "licence",
  "milestone",
] as const;

export const AGENDA_SOURCE_LABEL: Readonly<Record<AgendaSource, string>> = {
  task: "Task",
  event: "Diary",
  hearing: "Hearing",
  compliance: "Filing",
  licence: "Licence",
  milestone: "Payment due",
};

/**
 * 🔴 HOW BADLY IT HURTS TO MISS IT. This is not the same as priority,
 * and the difference is the whole reason the field exists.
 *
 *   consequential — a right is lost, or a statute is breached. A hearing
 *                   nobody attends, a filing missed, a licence expired.
 *                   These cannot be done late at all.
 *   commercial    — money moves later than it should. Recoverable.
 *   ordinary      — somebody's own work.
 */
export type AgendaWeight = "consequential" | "commercial" | "ordinary";

export const SOURCE_WEIGHT: Readonly<Record<AgendaSource, AgendaWeight>> = {
  hearing: "consequential",
  compliance: "consequential",
  licence: "consequential",
  milestone: "commercial",
  event: "ordinary",
  task: "ordinary",
};

export type AgendaEntry = {
  id: string;
  source: AgendaSource;
  /** The civil day it falls on. */
  on: string;
  /** Where there is a time as well. Display only; `on` decides the day. */
  atLabel?: string | null;
  title: string;
  /** One line of context: the client, the court, the unit, the amount. */
  detail?: string | null;
  /** Who it belongs to, where anybody owns it. */
  ownerId?: string | null;
  ownerName?: string | null;
  /** Deep link. */
  href?: string | null;
  weight: AgendaWeight;
};

export type AgendaDay = {
  on: string;
  /** Relative to `today`. Negative is the past. */
  offset: number;
  label: string;
  entries: readonly AgendaEntry[];
  /** ⭐ True where anything on this day cannot be done late. */
  hasConsequential: boolean;
};

/* ------------------------------------------------------------------ */
/* ORDER                                                               */
/* ------------------------------------------------------------------ */

const WEIGHT_RANK: Readonly<Record<AgendaWeight, number>> = {
  consequential: 0,
  commercial: 1,
  ordinary: 2,
};

/**
 * ⭐ WITHIN A DAY: what cannot be done late comes first.
 *
 * ⚠️ Not chronological within the day, deliberately. A hearing at four
 * in the afternoon still matters more than a call at ten, and a list
 * sorted by clock time buries it under the morning. The times are shown;
 * they just do not decide the order.
 */
export function compareEntries(a: AgendaEntry, b: AgendaEntry): number {
  const w = WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight];
  if (w !== 0) return w;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  /** Stable, so the list does not shuffle between renders. */
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* THE MERGE                                                           */
/* ------------------------------------------------------------------ */

function dayLabel(offset: number): string {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  if (offset < 0) return `${-offset} days ago`;
  return `In ${offset} days`;
}

/**
 * ⭐⭐ BUILD THE AGENDA.
 *
 * 🔴 THE PAST IS INCLUDED, AND THAT IS THE MOST IMPORTANT DECISION IN
 *    THIS FILE.
 *
 * ⚠️ A calendar that starts at today is a calendar that hides the
 * hearing nobody attended last Thursday and the filing that was due on
 * the 20th. Those are exactly the entries a person needs to see, and
 * they are the ones every calendar product drops off the top of the
 * screen the moment the day turns.
 *
 * So overdue entries stay on the agenda, on their own date, until they
 * are closed at source. `daysBack` decides how far.
 */
export function buildAgenda(args: {
  entries: readonly AgendaEntry[];
  today: string;
  /** How many days forward to show. */
  daysAhead?: number;
  /** 🔴 How far back to keep showing what was missed. */
  daysBack?: number;
  /** Filter to one person's day. Null keeps everybody's. */
  ownerId?: string | null;
}): {
  days: readonly AgendaDay[];
  overdueCount: number;
  consequentialOverdueCount: number;
  todayCount: number;
  total: number;
} {
  assertCivilDay(args.today);
  const ahead = args.daysAhead ?? 14;
  const back = args.daysBack ?? 30;
  if (ahead < 0 || back < 0) {
    throw new AgendaError("An agenda window cannot be negative.");
  }

  const byDay = new Map<string, AgendaEntry[]>();
  let overdue = 0;
  let consequentialOverdue = 0;
  let todayCount = 0;
  let total = 0;

  for (const e of args.entries) {
    assertCivilDay(e.on);
    if (args.ownerId !== null && args.ownerId !== undefined) {
      /**
       * ⚠️ An entry that belongs to nobody stays on everybody's list.
       * Filtering it out would make unowned work invisible on exactly
       * the screen that should surface it.
       */
      if (e.ownerId !== null && e.ownerId !== undefined && e.ownerId !== args.ownerId) {
        continue;
      }
    }

    const offset = daysBetween(args.today, e.on);
    if (offset > ahead || offset < -back) continue;

    total += 1;
    if (offset < 0) {
      overdue += 1;
      if (e.weight === "consequential") consequentialOverdue += 1;
    } else if (offset === 0) {
      todayCount += 1;
    }

    const list = byDay.get(e.on) ?? [];
    list.push(e);
    byDay.set(e.on, list);
  }

  const days: AgendaDay[] = [...byDay.entries()]
    .map(([on, entries]) => {
      const sorted = [...entries].sort(compareEntries);
      return {
        on,
        offset: daysBetween(args.today, on),
        label: dayLabel(daysBetween(args.today, on)),
        entries: sorted,
        hasConsequential: sorted.some((e) => e.weight === "consequential"),
      };
    })
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));

  return {
    days,
    overdueCount: overdue,
    consequentialOverdueCount: consequentialOverdue,
    todayCount,
    total,
  };
}

/* ------------------------------------------------------------------ */
/* THE ADAPTERS                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Each source keeps its own shape and its own rules. These turn six
 * shapes into one, and they are the only place that knows how each one
 * dates itself.
 */

export function taskEntry(t: {
  id: string;
  title: string;
  dueOn: string | null;
  subjectLabel: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
}): AgendaEntry | null {
  /** ⚠️ No date, no place on a dated list. The task screen reports it. */
  if (t.dueOn === null) return null;
  return {
    id: `task:${t.id}`,
    source: "task",
    on: t.dueOn,
    title: t.title,
    detail: t.subjectLabel,
    ownerId: t.assignedTo,
    ownerName: t.assigneeName,
    href: "/tasks",
    weight: SOURCE_WEIGHT.task,
  };
}

export function eventEntry(
  e: {
    id: string;
    title: string;
    startsAt: string;
    allDay: boolean;
    location: string | null;
    organiserId: string | null;
    organiserName: string | null;
    status: string;
  },
  /** ⚠️ The day is decided in the business's timezone, not the server's. */
  toCivilDay: (isoTimestamp: string) => string,
  toTimeLabel: (isoTimestamp: string) => string,
): AgendaEntry | null {
  /** A cancelled entry leaves the agenda; the record keeps it. */
  if (e.status === "cancelled") return null;
  return {
    id: `event:${e.id}`,
    source: "event",
    on: toCivilDay(e.startsAt),
    atLabel: e.allDay ? null : toTimeLabel(e.startsAt),
    title: e.title,
    detail: e.location,
    ownerId: e.organiserId,
    ownerName: e.organiserName,
    href: "/calendar",
    weight: SOURCE_WEIGHT.event,
  };
}

export function hearingEntry(h: {
  id: string;
  matterId: string;
  hearingDate: string;
  matterNo: string | null;
  title: string | null;
  courtName: string | null;
  purpose: string | null;
  appearedBy: string | null;
  appearedByName: string | null;
}): AgendaEntry {
  return {
    id: `hearing:${h.id}`,
    source: "hearing",
    on: h.hearingDate,
    title: `${h.matterNo ?? "Matter"} · ${h.purpose ?? "listed"}`,
    detail: [h.courtName, h.title].filter(Boolean).join(" · ") || null,
    ownerId: h.appearedBy,
    ownerName: h.appearedByName,
    href: `/legal/matters/${h.matterId}`,
    /** 🔴 A hearing nobody attends can end the suit. */
    weight: SOURCE_WEIGHT.hearing,
  };
}

export function complianceEntry(c: {
  id: string;
  dueDate: string;
  periodLabel: string | null;
  obligationName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
}): AgendaEntry {
  return {
    id: `compliance:${c.id}`,
    source: "compliance",
    on: c.dueDate,
    title: c.obligationName ?? "Filing due",
    detail: c.periodLabel,
    ownerId: c.ownerUserId,
    ownerName: c.ownerName,
    href: "/compliance-board",
    weight: SOURCE_WEIGHT.compliance,
  };
}

/**
 * 🔴 A LICENCE APPEARS ON ITS RENEWAL DATE, NOT ITS EXPIRY DATE.
 *
 * ⚠️ A licence that expires on 30 June with a 60 day lead time needs to
 * be on somebody's list on 1 May. Putting it on the agenda on 30 June is
 * putting it there on the day it is already too late, which is the
 * single most common way a compliance calendar is useless while being
 * technically correct.
 */
export function licenceEntry(l: {
  id: string;
  name: string;
  validUntil: string | null;
  renewalLeadDays: number;
  authority: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
}): AgendaEntry | null {
  if (l.validUntil === null) return null;
  const lead = Number.isInteger(l.renewalLeadDays) ? Math.max(0, l.renewalLeadDays) : 0;
  const on = addDaysIso(l.validUntil, -lead);
  return {
    id: `licence:${l.id}`,
    source: "licence",
    on,
    title: `Renew: ${l.name}`,
    detail: `Expires ${l.validUntil}${l.authority ? ` · ${l.authority}` : ""}`,
    ownerId: l.ownerUserId,
    ownerName: l.ownerName,
    href: "/licences",
    weight: SOURCE_WEIGHT.licence,
  };
}

export function milestoneEntry(
  m: {
    id: string;
    label: string;
    dueOn: string | null;
    amountMinor: bigint;
    amountPaidMinor: bigint;
    status: string;
    unitLabel: string | null;
  },
  formatMoney: (minor: bigint) => string,
): AgendaEntry | null {
  if (m.dueOn === null) return null;
  /** ⚠️ Settled money is off the list. Part paid is still on it. */
  const outstanding = m.amountMinor - m.amountPaidMinor;
  if (outstanding <= 0n || m.status === "paid") return null;
  return {
    id: `milestone:${m.id}`,
    source: "milestone",
    on: m.dueOn,
    title: `${m.label} · ${formatMoney(outstanding)}`,
    detail: m.unitLabel,
    ownerId: null,
    ownerName: null,
    href: "/receivables",
    weight: SOURCE_WEIGHT.milestone,
  };
}

/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** Local to this file so the adapters have no import cycle. */
function addDaysIso(iso: string, days: number): string {
  const t = Date.parse(`${assertCivilDay(iso)}T00:00:00Z`) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
