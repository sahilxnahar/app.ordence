/**
 * Ordence — Cron for Scheduled Triggers
 * Version: v0.23.0-alpha
 *
 * Pure. Five fields, no seconds, no `@yearly` aliases, no library.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE MINIMUM IS ONE MINUTE AND THE ANSWER IS ALWAYS "THE NEXT ONE"
 * ══════════════════════════════════════════════════════════════════════
 * A scheduled workflow is dispatched by something that wakes up
 * periodically and asks "what is due?". Two properties follow, and both
 * are easy to get wrong:
 *
 *   • `nextFireAt` must be STRICTLY AFTER the reference instant.
 *     Returning the current minute means a dispatcher that runs at
 *     10:00:30, fires the 10:00 job, stores `next_run_at = 10:00`, and
 *     fires it again at 10:00:45. A workflow that "sometimes runs twice"
 *     is a workflow that sometimes emails a buyer twice.
 *
 *   • A MISSED WINDOW IS NOT REPLAYED. If the dispatcher was down from
 *     02:00 to 06:00, an hourly workflow does not fire four times at
 *     06:00. It fires once. The alternative — catch-up — is how a
 *     four-hour outage becomes a thousand emails at the moment the system
 *     comes back, which is the worst possible moment.
 *
 * ⚠️ TIMEZONES ARE EVALUATED WITH `Intl`, NOT WITH AN OFFSET.
 * "Every weekday at 9am" means 9am where the customer is, and a stored
 * numeric offset is wrong twice a year in every country with DST. The
 * cost is one `Intl.DateTimeFormat` per candidate minute, which is
 * nothing next to the cost of a demand notice going out at 8am.
 */

/* ------------------------------------------------------------------ */
/* PARSING                                                             */
/* ------------------------------------------------------------------ */

export type CronField = {
  /** Sorted, de-duplicated, all values this field matches. */
  values: number[];
  /** True when the field was `*` — needed for the day-of-week rule below. */
  wildcard: boolean;
};

export type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

export type CronParseResult =
  | { ok: true; cron: ParsedCron }
  | { ok: false; error: string };

const FIELD_RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 0 and 7 are both Sunday, as in every crontab ever written.
  { name: "day of week", min: 0, max: 7 },
] as const;

export function parseCron(expression: string): CronParseResult {
  if (typeof expression !== "string") {
    return { ok: false, error: "A schedule is required." };
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return {
      ok: false,
      error:
        `A schedule has five fields — minute hour day-of-month month day-of-week. ` +
        `Got ${parts.length}. Example: "0 9 * * 1-5" is every weekday at 9am.`,
    };
  }

  const fields: CronField[] = [];
  for (let index = 0; index < 5; index += 1) {
    const range = FIELD_RANGES[index]!;
    const raw = parts[index] ?? "";
    const parsed = parseField(raw, range.min, range.max);
    if (!parsed) {
      return {
        ok: false,
        error: `"${raw}" is not a valid ${range.name} (${range.min}–${range.max}).`,
      };
    }
    fields.push(parsed);
  }

  // Sunday normalised to 0 so the weekday comparison has one form.
  const dayOfWeek = fields[4]!;
  dayOfWeek.values = [...new Set(dayOfWeek.values.map((v) => (v === 7 ? 0 : v)))].sort(
    (a, b) => a - b,
  );

  return {
    ok: true,
    cron: {
      minute: fields[0]!,
      hour: fields[1]!,
      dayOfMonth: fields[2]!,
      month: fields[3]!,
      dayOfWeek,
    },
  };
}

function parseField(raw: string, min: number, max: number): CronField | null {
  const values = new Set<number>();
  let wildcard = false;

  for (const part of raw.split(",")) {
    if (part.length === 0) return null;

    const [rawRange, stepPart] = part.split("/");
    const rangePart = rawRange ?? "";
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) return null;
    }

    let start: number;
    let end: number;

    if (rangePart === "*") {
      wildcard = stepPart === undefined;
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [from, to] = rangePart.split("-");
      start = Number(from ?? "");
      end = Number(to ?? "");
    } else {
      start = Number(rangePart);
      end = start;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < min || end > max || start > end) return null;

    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) return null;
  return { values: [...values].sort((a, b) => a - b), wildcard };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression).ok;
}

/* ------------------------------------------------------------------ */
/* MATCHING                                                            */
/* ------------------------------------------------------------------ */

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

/**
 * ⚠️ THE DAY-OF-MONTH / DAY-OF-WEEK RULE IS AN **OR**, NOT AN AND.
 *
 * `0 0 13 * 5` means "the 13th, AND every Friday" — not "Friday the
 * 13th". It is genuinely surprising, it is what every crontab on every
 * Unix system does, and an implementation that quietly uses AND will run
 * a monthly job about eleven times fewer than the author expects. The
 * rule only applies when BOTH fields are restricted; if either is `*`,
 * the other simply decides.
 */
function matchesDate(cron: ParsedCron, parts: LocalParts): boolean {
  if (!cron.month.values.includes(parts.month)) return false;

  const domRestricted = !cron.dayOfMonth.wildcard;
  const dowRestricted = !cron.dayOfWeek.wildcard;

  const domMatch = cron.dayOfMonth.values.includes(parts.day);
  const dowMatch = cron.dayOfWeek.values.includes(parts.weekday);

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  if (domRestricted) return domMatch;
  if (dowRestricted) return dowMatch;
  return true;
}

function matchesTime(cron: ParsedCron, parts: LocalParts): boolean {
  return cron.hour.values.includes(parts.hour) && cron.minute.values.includes(parts.minute);
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
});

function localParts(instant: Date, timezone: string): LocalParts | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });

    const found: Record<string, string> = {};
    for (const part of formatter.formatToParts(instant)) {
      found[part.type] = part.value;
    }

    return {
      year: Number(found.year),
      month: Number(found.month),
      day: Number(found.day),
      hour: Number(found.hour),
      minute: Number(found.minute),
      weekday: WEEKDAY_INDEX[found.weekday ?? ""] ?? 0,
    };
  } catch {
    // An unknown timezone. The caller decides what to do; guessing UTC
    // here would silently move somebody's 9am by five and a half hours.
    return null;
  }
}

export function isValidTimezone(timezone: string): boolean {
  return localParts(new Date(), timezone) !== null;
}

/* ------------------------------------------------------------------ */
/* THE NEXT FIRE                                                       */
/* ------------------------------------------------------------------ */

const MINUTE_MS = 60_000;
/** A year of day-skips plus a day of minute-steps, with room to spare. */
const MAX_SCAN_ITERATIONS = 4_000;

/**
 * The first instant strictly after `after` at which this schedule fires.
 *
 * Returns null when the expression is invalid, the timezone is unknown,
 * or nothing matches within a year — `0 0 30 2 *` (the 30th of February)
 * parses cleanly and can never occur, and a dispatcher that stored `null`
 * for it simply never runs it, which is the correct outcome.
 */
export function nextCronFireAt(
  expression: string,
  after: Date,
  timezone = "UTC",
): Date | null {
  const parsed = parseCron(expression);
  if (!parsed.ok) return null;
  if (!isValidTimezone(timezone)) return null;

  const cron = parsed.cron;

  // Strictly after: round up to the start of the NEXT minute. See the
  // header — firing on the current minute is how a job runs twice.
  let cursor = new Date((Math.floor(after.getTime() / MINUTE_MS) + 1) * MINUTE_MS);

  for (let iteration = 0; iteration < MAX_SCAN_ITERATIONS; iteration += 1) {
    const parts = localParts(cursor, timezone);
    if (!parts) return null;

    if (!matchesDate(cron, parts)) {
      // Skip to the next local midnight rather than stepping a minute at
      // a time. A yearly schedule would otherwise need half a million
      // iterations to find its next fire.
      const minutesLeftToday = (23 - parts.hour) * 60 + (60 - parts.minute);
      cursor = new Date(cursor.getTime() + minutesLeftToday * MINUTE_MS);
      continue;
    }

    if (matchesTime(cron, parts)) return cursor;

    cursor = new Date(cursor.getTime() + MINUTE_MS);
  }

  return null;
}

/**
 * A sentence describing the schedule, for the builder and for run history.
 * Deliberately conservative: it recognises the shapes people actually
 * write and falls back to the raw expression rather than inventing a
 * description that might be wrong.
 */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression);
  if (!parsed.ok) return parsed.error;

  const { minute, hour, dayOfMonth, month, dayOfWeek } = parsed.cron;
  const everyMinute = minute.wildcard;
  const everyHour = hour.wildcard;

  if (everyMinute && everyHour) return "Every minute.";
  if (everyHour && minute.values.length === 1) {
    return `Every hour at ${pad(minute.values[0] ?? 0)} minutes past.`;
  }

  if (
    minute.values.length === 1 &&
    hour.values.length === 1 &&
    month.wildcard &&
    dayOfMonth.wildcard
  ) {
    const time = `${pad(hour.values[0] ?? 0)}:${pad(minute.values[0] ?? 0)}`;
    if (dayOfWeek.wildcard) return `Every day at ${time}.`;
    const days = dayOfWeek.values.map((d) => WEEKDAY_NAMES[d] ?? String(d)).join(", ");
    return `Every ${days} at ${time}.`;
  }

  return `Cron: ${expression.trim()}`;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
