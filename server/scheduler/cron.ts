import "server-only";

/**
 * Ordence — CRON EXPRESSIONS, WITHOUT A DEPENDENCY
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `server/scheduling/registry.ts` already declares a `cronUtc` string on
 * every job, and `docs/current/CRON-RUNBOOK.md` already prints it. Nothing
 * has ever PARSED one. The strings are documentation: a human reads them
 * and types them into a scheduler's web form.
 *
 * A control plane cannot do that. To decide "which slots have come due
 * since the last tick", "what is the next run", or "which slots did we
 * miss while the service was down", the expression has to become a set of
 * instants. So this file turns the declarations that already exist into
 * the thing the ledger keys on.
 *
 * ⚠️ ZERO NEW DEPENDENCIES IS A HARD CONSTRAINT IN THIS PROJECT, and
 * `cron-parser` would have been the obvious import. It is not needed: the
 * grammar below is ~120 lines and timezone conversion is `Intl`, which is
 * in the platform. What a dependency would have bought is the exotic
 * syntax (`@yearly`, `L`, `W`, `#`, seconds fields) that this product does
 * not use and should not start using in a file operators read.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE PIECE OF CRON SEMANTICS EVERYBODY GETS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * When BOTH day-of-month and day-of-week are restricted (neither is `*`),
 * the two are OR-ed, not AND-ed. `0 0 1 * 1` is "the 1st of the month AND
 * ALSO every Monday", not "Mondays that fall on the 1st". This is the
 * documented Vixie-cron behaviour that every scheduler in the world
 * implements and that every hand-rolled parser implements backwards.
 * `matchesAt` implements the OR and `⑤` in this file's tests-by-execution
 * (server/scheduler/self-check.mjs) proves it.
 *
 * None of the eight registered jobs restricts both fields today, so an
 * AND implementation would be indistinguishable from a correct one right
 * now, and would silently mean the wrong thing for the first job that
 * does. That is the shape of defect this whole wave is about.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TIMEZONES
 * ══════════════════════════════════════════════════════════════════════
 * Slots are always stored and compared in UTC. A per-workspace schedule
 * (0130's `scheduler_tenant_schedules`) declares an IANA zone, and the
 * expression is matched against the WALL CLOCK in that zone via `Intl`,
 * so `0 9 * * *` in `Asia/Kolkata` is 03:30 UTC, and would stay correct
 * across a DST transition in a zone that has one. India has none, so this
 * is invisible today and would be a wrong-by-an-hour bug for the first
 * workspace outside it.
 */

export type CronField = {
  /** Sorted, de-duplicated, already range-checked. */
  readonly values: readonly number[];
  /** True when the field was literally `*`. Needed for the dom/dow OR rule. */
  readonly isWildcard: boolean;
};

export type ParsedCron = {
  readonly source: string;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
};

export class CronParseError extends Error {
  /**
   * ⚠️ A PLAIN FIELD AND AN ASSIGNMENT, NOT A `readonly` CONSTRUCTOR
   * PARAMETER PROPERTY. Parameter properties are the one TypeScript
   * feature that cannot be removed by erasing types — they generate an
   * assignment — so Node's built-in type stripping refuses a file that
   * uses one. `server/scheduler/self-check.mjs` imports this module
   * directly under that stripper to exercise the parser, and this track
   * cannot add a file under `tests/`. Two characters of convenience are
   * not worth a module that can only be tested by a bundler.
   */
  readonly expression: string;

  constructor(expression: string, detail: string) {
    super(`Cannot parse cron expression "${expression}": ${detail}`);
    this.name = "CronParseError";
    this.expression = expression;
  }
}

const BOUNDS: Record<string, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
};

/**
 * Parse one field.  Supports `*`, `n`, `a-b`, `*` + `/n`, `a-b` + `/n`, and any
 * comma-separated combination.
 *
 * ⚠️ IT THROWS ON ANYTHING ELSE RATHER THAN IGNORING IT. A parser that
 * silently drops `L` from `0 0 L * *` produces "midnight on every day of
 * the month", which is 30x the intended run rate and looks like a working
 * schedule.
 */
function parseField(name: keyof typeof BOUNDS, raw: string, expression: string): CronField {
  const bound = BOUNDS[name];
  /* c8 ignore next 3 -- BOUNDS is a closed literal; this is a type guard for
     noUncheckedIndexedAccess, not a reachable branch. */
  if (!bound) {
    throw new CronParseError(expression, `unknown field "${name}"`);
  }

  const text = raw.trim();
  if (text.length === 0) {
    throw new CronParseError(expression, `the ${name} field is empty`);
  }

  const isWildcard = text === "*";
  const found = new Set<number>();

  for (const part of text.split(",")) {
    const stepSplit = part.split("/");
    if (stepSplit.length > 2) {
      throw new CronParseError(expression, `"${part}" has more than one step`);
    }

    const rangeText = stepSplit[0] ?? "";
    const stepText = stepSplit[1];

    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronParseError(expression, `"${part}" has a step that is not a positive integer`);
      }
    }

    let from: number;
    let to: number;

    if (rangeText === "*") {
      from = bound.min;
      to = bound.max;
    } else if (rangeText.includes("-")) {
      const ends = rangeText.split("-");
      if (ends.length !== 2) {
        throw new CronParseError(expression, `"${part}" is not a range`);
      }
      from = Number(ends[0]);
      to = Number(ends[1]);
    } else {
      from = Number(rangeText);
      to = stepText === undefined ? from : bound.max;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new CronParseError(expression, `"${part}" is not numeric`);
    }
    if (from < bound.min || to > bound.max || from > to) {
      throw new CronParseError(
        expression,
        `"${part}" is outside ${bound.min}-${bound.max} for the ${name} field`,
      );
    }

    for (let v = from; v <= to; v += step) found.add(v);
  }

  /**
   * ⚠️ 7 IS SUNDAY AND SO IS 0. Both spellings are in the wild and a
   * `0 0 * * 7` that matched nothing would be a job that never fires with
   * a schedule that reads correct.
   */
  if (name === "dayOfWeek" && found.has(7)) {
    found.delete(7);
    found.add(0);
  }

  return {
    values: [...found].sort((a, b) => a - b),
    isWildcard,
  };
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      expression,
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}. ` +
        `Six-field expressions with a seconds column are not supported and would be ` +
        `interpreted with every column shifted by one.`,
    );
  }

  return {
    source: expression.trim(),
    minute: parseField("minute", fields[0] ?? "", expression),
    hour: parseField("hour", fields[1] ?? "", expression),
    dayOfMonth: parseField("dayOfMonth", fields[2] ?? "", expression),
    month: parseField("month", fields[3] ?? "", expression),
    dayOfWeek: parseField("dayOfWeek", fields[4] ?? "", expression),
  };
}

/* ------------------------------------------------------------------ */
/* WALL CLOCK IN A ZONE                                                */
/* ------------------------------------------------------------------ */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  formatterCache.set(timeZone, made);
  return made;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type WallClock = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

/**
 * The wall-clock fields of a UTC instant, as seen in `timeZone`.
 *
 * ⚠️ `Intl` IS THE ONLY CORRECT ANSWER AVAILABLE WITHOUT A DEPENDENCY.
 * The alternative — adding a fixed offset — is right for India and wrong
 * for every zone with daylight saving, twice a year, silently.
 */
export function wallClock(at: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const weekday = WEEKDAY_INDEX[get("weekday")];

  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    dayOfMonth: Number(get("day")),
    month: Number(get("month")),
    // `?? 0` is a type guard, not a fallback: `weekday: "short"` in en-GB
    // always produces one of the seven keys above.
    dayOfWeek: weekday ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* MATCHING                                                            */
/* ------------------------------------------------------------------ */

export function matchesAt(cron: ParsedCron, at: Date, timeZone = "UTC"): boolean {
  const w = wallClock(at, timeZone);

  if (!cron.minute.values.includes(w.minute)) return false;
  if (!cron.hour.values.includes(w.hour)) return false;
  if (!cron.month.values.includes(w.month)) return false;

  const domMatch = cron.dayOfMonth.values.includes(w.dayOfMonth);
  const dowMatch = cron.dayOfWeek.values.includes(w.dayOfWeek);

  /**
   * 🔴 THE OR RULE. See this file's header. When both fields are
   * restricted the day matches if EITHER does; when only one is
   * restricted, only that one is consulted; when neither is, every day
   * matches.
   */
  if (cron.dayOfMonth.isWildcard && cron.dayOfWeek.isWildcard) return true;
  if (cron.dayOfMonth.isWildcard) return dowMatch;
  if (cron.dayOfWeek.isWildcard) return domMatch;
  return domMatch || dowMatch;
}

const MINUTE_MS = 60_000;

/** Truncate to the start of the minute. Slots are minute-granular. */
export function floorToMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
}

/**
 * How many minutes `slotsBetween` will ever step. 40 days.
 *
 * 🔴 A BOUND THE CALLER CANNOT SEE IS A BOUND NOBODY RAISES — the same
 * lesson `MAX_TENANTS_PER_JOB` records. So this does not silently stop at
 * the cap: it throws, naming the window it was asked for. A backfill over
 * six months is a real request and the honest answer is "do it in
 * chunks", not a list that quietly begins 40 days ago.
 */
export const MAX_SCAN_MINUTES = 40 * 24 * 60;

/**
 * Every slot in `(fromExclusive, toInclusive]`.
 *
 * Exclusive at the start on purpose: the caller passes the last slot it
 * already handled, and an inclusive start would re-offer it on every tick.
 * The ledger would refuse the duplicate claim, so the bug would be
 * invisible — a tick doing N redundant claim attempts a minute, forever.
 */
export function slotsBetween(
  cron: ParsedCron,
  fromExclusive: Date,
  toInclusive: Date,
  timeZone = "UTC",
): Date[] {
  const start = floorToMinute(fromExclusive).getTime() + MINUTE_MS;
  const end = floorToMinute(toInclusive).getTime();

  if (end < start) return [];

  const minutes = Math.floor((end - start) / MINUTE_MS) + 1;
  if (minutes > MAX_SCAN_MINUTES) {
    throw new RangeError(
      `slotsBetween was asked to scan ${minutes} minutes (${Math.round(minutes / 1440)} days), ` +
        `over the ${MAX_SCAN_MINUTES / 1440}-day limit. Split the window rather than ` +
        `accepting a truncated list: a backfill that silently starts 40 days ago is a ` +
        `backfill that silently skips everything before that.`,
    );
  }

  const out: Date[] = [];
  for (let t = start; t <= end; t += MINUTE_MS) {
    const at = new Date(t);
    if (matchesAt(cron, at, timeZone)) out.push(at);
  }
  return out;
}

/**
 * The next slot strictly after `after`, or null if there is none within
 * the scan limit.
 *
 * ⚠️ RETURNS NULL RATHER THAN THROWING, and the calendar renders that as
 * "no run in the next 40 days" rather than as a blank cell. `0 0 30 2 *`
 * — the 30th of February — is a valid expression with no next slot ever,
 * and the honest rendering of it is the one that says so.
 */
export function nextSlotAfter(cron: ParsedCron, after: Date, timeZone = "UTC"): Date | null {
  let t = floorToMinute(after).getTime() + MINUTE_MS;
  const limit = t + MAX_SCAN_MINUTES * MINUTE_MS;
  for (; t <= limit; t += MINUTE_MS) {
    const at = new Date(t);
    if (matchesAt(cron, at, timeZone)) return at;
  }
  return null;
}

/**
 * The cadence, in seconds, measured rather than declared: the gap between
 * the next two slots after `from`.
 *
 * ⭐ THIS IS WHAT MAKES THE WATCHDOG WINDOW IMPOSSIBLE TO GET WRONG.
 * `server/scheduler/policy.ts` derives `maxSilenceSeconds` from this, so
 * changing a job's cron automatically moves its alarm window. A window
 * typed in by hand next to a cron string is two declarations of one fact,
 * and the day they disagree is the day the alarm is wrong in whichever
 * direction is least useful.
 *
 * Returns null for an expression with fewer than two slots in the window.
 */
export function cadenceSeconds(cron: ParsedCron, from: Date, timeZone = "UTC"): number | null {
  const first = nextSlotAfter(cron, from, timeZone);
  if (!first) return null;
  const second = nextSlotAfter(cron, first, timeZone);
  if (!second) return null;
  return Math.round((second.getTime() - first.getTime()) / 1000);
}

/**
 * The longest gap between consecutive slots over one probe window.
 *
 * 🔴 `cadenceSeconds` ALONE IS NOT SAFE FOR AN IRREGULAR SCHEDULE, and
 * `rera_dunning_plan` is one: `0 3 * * 1-5` has a 24-hour gap from Monday
 * to Tuesday and a 72-hour gap from Friday to Monday. A watchdog window
 * built from the 24-hour measurement alarms every weekend, and an alarm
 * that cries wolf every Saturday is an alarm somebody mutes on the third
 * Saturday. The window has to be built from the WORST gap.
 */
export function worstGapSeconds(
  cron: ParsedCron,
  from: Date,
  probeDays = 32,
  timeZone = "UTC",
): number | null {
  const slots = slotsBetween(
    cron,
    from,
    new Date(from.getTime() + probeDays * 24 * 60 * MINUTE_MS),
    timeZone,
  );
  if (slots.length < 2) return null;

  let worst = 0;
  for (let i = 1; i < slots.length; i += 1) {
    const a = slots[i - 1];
    const b = slots[i];
    if (!a || !b) continue;
    worst = Math.max(worst, b.getTime() - a.getTime());
  }
  return worst === 0 ? null : Math.round(worst / 1000);
}

/** A human rendering, for the jobs calendar. Never throws. */
export function describeCron(expression: string): string {
  try {
    const parsed = parseCron(expression);
    const next = nextSlotAfter(parsed, new Date());
    return next ? `${parsed.source} · next ${next.toISOString()}` : `${parsed.source} · no next run`;
  } catch (err) {
    return `${expression} · UNPARSEABLE: ${err instanceof Error ? err.message : String(err)}`;
  }
}
