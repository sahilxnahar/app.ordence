"use client";

/**
 * Ordence — The Month Grid
 * Version: v0.28.0-alpha
 *
 * The renderer for `viewType: "calendar"`. The engine has supported it
 * since Phase 25 — `validateDefinition` requires a `dateField`, the
 * planner will happily window on one — and nothing had ever drawn it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ PLAIN REACT AND DATE ARITHMETIC. NO CALENDAR LIBRARY.
 * ══════════════════════════════════════════════════════════════════════
 * A month grid is six weeks of seven cells. The whole computation is
 * `monthGrid()` below, and it is thirty lines. Every date library in the
 * ecosystem is bigger than the feature.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE THREE THINGS A CALENDAR GETS WRONG, AND WHAT IS DONE ABOUT EACH
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. ⭐ WHICH DAY A TIMESTAMP FALLS ON.
 *    `next_follow_up_at` is a `timestamptz`. A follow-up at 00:30 IST is
 *    18:00 UTC the PREVIOUS day, so bucketing by the ISO string puts it
 *    in the wrong cell — and the reader, who is in Bengaluru, sees a call
 *    scheduled for a day they did not schedule it.
 *
 *    So `dayKey()` uses the LOCAL calendar parts (`getFullYear`,
 *    `getMonth`, `getDate`), which is the same clock the browser draws
 *    the rest of the page against. It never touches `toISOString()`.
 *
 * 2. THE WEEK STARTS ON MONDAY.
 *    Not a style choice — `resolveDateWindow()` in `lib/views/operators.ts`
 *    resolves `this_week` to a Monday-start window, for the stated reason
 *    that this product's users close deals on Saturdays. A grid that
 *    started on Sunday would draw "this week" straddling two rows.
 *
 * 3. THE MONTH IS ALWAYS SIX ROWS.
 *    A grid that is five rows in February and six in March jumps every
 *    time somebody pages through it, and the "next month" button moves
 *    out from under the cursor. Six rows always; the trailing cells are
 *    from the next month and are marked as such in text.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ACCESSIBILITY
 * ══════════════════════════════════════════════════════════════════════
 *   • A real `<table>` with `<th scope="col">` weekday headers. A grid of
 *     `<div>`s tells a screen-reader user nothing about which column a
 *     cell is in.
 *   • ⚠️ TODAY IS MARKED WITH THE WORD "today", not only with a ring. So
 *     is "not in this month". Colour and border are the fast path for
 *     people who can see them and are never the only path.
 *   • The month navigation is two buttons and a "Today" button, all
 *     labelled with the month they go to rather than with "‹" alone.
 */

import { Fragment } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export type CalendarEvent = {
  id: string;
  title: string;
  /** ⭐ Placed by its LOCAL calendar date. See note 1 in the header. */
  date: Date;
  detail?: string | null;
  href?: string;
};

export type CalendarViewProps = {
  /** Any date inside the month to draw. */
  month: Date;
  events: CalendarEvent[];
  /** "Next follow up" — named so the reader knows WHICH date they see. */
  dateFieldLabel: string;
  onMonthChange?: (month: Date) => void;
  /** Injected so the "today" marker is testable at any instant. */
  today?: Date;
  /** True when the caller sees only records assigned to them. Announced. */
  scopedToOwnRecords?: boolean;
  /**
   * True when the query hit its page size, so some records in this month
   * are not drawn. ⚠️ Announced — a calendar that silently omits half a
   * month is a calendar somebody plans a week from.
   */
  truncated?: boolean;
  emptyMessage?: string;
  footer?: ReactNode;
};

/** Monday first — see note 2 in the header. */
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MONTH_FORMAT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });
const DAY_FORMAT = new Intl.DateTimeFormat("en-IN", { dateStyle: "full" });

/** How many events one cell lists before it says "and N more". */
const EVENTS_PER_DAY = 4;

export function CalendarView({
  month,
  events,
  dateFieldLabel,
  onMonthChange,
  today,
  scopedToOwnRecords = false,
  truncated = false,
  emptyMessage = "Nothing falls in this month.",
  footer,
}: CalendarViewProps) {
  const anchor = startOfMonth(month);
  const grid = monthGrid(anchor);
  const byDay = groupByDay(events);
  const now = today ?? new Date();
  const todayKey = dayKey(now);

  return (
    <div className="flex flex-col gap-3">
      {scopedToOwnRecords ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          You are seeing only the records assigned to you. Ask an administrator for
          workspace-wide visibility if you need the rest.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{MONTH_FORMAT.format(anchor)}</h2>
        <span className="text-xs text-muted-foreground">
          by {dateFieldLabel.toLowerCase()}
        </span>

        {onMonthChange ? (
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => onMonthChange(addMonths(anchor, -1))}
            >
              <span aria-hidden="true">←</span>
              <span className="ml-1">{MONTH_FORMAT.format(addMonths(anchor, -1))}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => onMonthChange(startOfMonth(now))}
            >
              Today
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => onMonthChange(addMonths(anchor, 1))}
            >
              <span className="mr-1">{MONTH_FORMAT.format(addMonths(anchor, 1))}</span>
              <span aria-hidden="true">→</span>
            </Button>
          </div>
        ) : null}
      </div>

      {truncated ? (
        <p
          role="status"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
        >
          More records fall in this month than this calendar loads, so some are not
          drawn. Narrow the filter, or use the table to see them all.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">
            {MONTH_FORMAT.format(anchor)} — {events.length}{" "}
            {events.length === 1 ? "record" : "records"} by {dateFieldLabel.toLowerCase()}
          </caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              {WEEKDAYS.map((day, index) => (
                <th key={day} scope="col" className="px-2 py-1.5 font-medium">
                  <span aria-hidden="true">{WEEKDAYS_SHORT[index]}</span>
                  <span className="sr-only">{day}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((week, weekIndex) => (
              <tr key={weekIndex}>
                {week.map((day) => {
                  const key = dayKey(day);
                  const dayEvents = byDay.get(key) ?? [];
                  const outside = day.getMonth() !== anchor.getMonth();
                  const isToday = key === todayKey;

                  return (
                    <td
                      key={key}
                      className={[
                        "h-24 border border-border align-top p-1",
                        outside ? "bg-muted/30" : "",
                        isToday ? "ring-2 ring-inset ring-primary" : "",
                      ].join(" ")}
                    >
                      <div className="flex items-baseline justify-between gap-1">
                        <span
                          className={[
                            "text-xs tabular-nums",
                            outside ? "text-muted-foreground" : "font-medium",
                          ].join(" ")}
                        >
                          {day.getDate()}
                        </span>
                        {/*
                          ⚠️ THE WORDS, NOT ONLY THE RING AND THE GREY.
                          Announced to a screen reader and readable by
                          anybody who cannot distinguish the two shades.
                        */}
                        <span className="sr-only">
                          {DAY_FORMAT.format(day)}
                          {isToday ? " — today" : ""}
                          {outside ? " — outside this month" : ""}
                          {dayEvents.length > 0
                            ? ` — ${dayEvents.length} ${
                                dayEvents.length === 1 ? "record" : "records"
                              }`
                            : ""}
                        </span>
                        {isToday ? (
                          <span
                            aria-hidden="true"
                            className="rounded bg-primary px-1 text-[9px] font-medium uppercase text-primary-foreground"
                          >
                            Today
                          </span>
                        ) : null}
                      </div>

                      {dayEvents.length > 0 ? (
                        <ul className="mt-1 space-y-0.5">
                          {dayEvents.slice(0, EVENTS_PER_DAY).map((event) => (
                            <li key={event.id}>
                              {event.href ? (
                                <a
                                  href={event.href}
                                  className="block truncate rounded bg-accent/60 px-1 py-0.5 text-[11px] hover:underline"
                                  title={event.detail ?? event.title}
                                >
                                  {event.title}
                                </a>
                              ) : (
                                <span
                                  className="block truncate rounded bg-accent/60 px-1 py-0.5 text-[11px]"
                                  title={event.detail ?? event.title}
                                >
                                  {event.title}
                                </span>
                              )}
                            </li>
                          ))}
                          {dayEvents.length > EVENTS_PER_DAY ? (
                            <li className="px-1 text-[10px] text-muted-foreground">
                              and {dayEvents.length - EVENTS_PER_DAY} more
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      ) : null}

      {footer ? <Fragment>{footer}</Fragment> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* THE ARITHMETIC — PURE, AND EXPORTED SO IT IS TESTED WITHOUT A DOM   */
/* ------------------------------------------------------------------ */

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * ⚠️ BUILT FROM (year, month + delta, 1) RATHER THAN BY ADDING DAYS.
 * `Date` normalises an out-of-range month, so month 12 becomes January of
 * the next year and month -1 becomes December of the previous one — for
 * free and correctly. Adding 30 days lands on the 2nd of March from the
 * 31st of January, which is the classic version of this bug.
 */
export function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

/**
 * Six weeks of seven days covering `month`, Monday first.
 *
 * ⚠️ `new Date(y, m, d)` WITH AN OUT-OF-RANGE `d` IS THE WHOLE TRICK.
 * Day 0 is the last day of the previous month and day 35 of a 31-day
 * month is the 4th of the next one — the runtime does the carrying, so
 * there is no leap-year branch in this file to get wrong.
 */
export function monthGrid(month: Date): Date[][] {
  const first = startOfMonth(month);
  // getDay(): 0 = Sunday. Monday-start means Sunday is 6 columns in.
  const leading = (first.getDay() + 6) % 7;

  const weeks: Date[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const days: Date[] = [];
    for (let day = 0; day < 7; day += 1) {
      days.push(
        new Date(first.getFullYear(), first.getMonth(), 1 - leading + week * 7 + day),
      );
    }
    weeks.push(days);
  }
  return weeks;
}

/**
 * The cell a date belongs in.
 *
 * ⭐ LOCAL PARTS, NEVER `toISOString()`. See note 1 in the file header —
 * this one line is the difference between a follow-up appearing on the
 * day it was scheduled and appearing on the day before it.
 */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function groupByDay(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (Number.isNaN(event.date.getTime())) continue;
    const key = dayKey(event.date);
    const list = byDay.get(key);
    if (list) list.push(event);
    else byDay.set(key, [event]);
  }
  // Within a day, earliest first. Two follow-ups on the same afternoon in
  // arbitrary order is a list a rep cannot work down.
  for (const list of byDay.values()) {
    list.sort((a, b) => a.date.getTime() - b.date.getTime());
  }
  return byDay;
}
