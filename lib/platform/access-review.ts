/**
 * Ordence — ⭐⭐ THE MONTHLY ACCESS REVIEW, PURE HALF
 * Version: v1.52.0-alpha (Batch 130)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS SCREEN EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * We sell to Indian SMBs whose books are read by auditors, bankers and
 * inspectors. Every one of them eventually asks the same question, and
 * it is not "is your database encrypted": it is WHO FROM YOUR COMPANY
 * COULD SEE MY BOOKS LAST QUARTER, AND WHY. Sessions and staff grants are
 * both already recorded — `platform_impersonation_sessions` and
 * `platform_staff` — but they are recorded in two places, on two screens,
 * with two vocabularies, and neither screen closes the loop by recording
 * that a human LOOKED at them.
 *
 * ⚠️ AND IT CANNOT BE RECONSTRUCTED LATER. "Who reviewed the June
 * grants?" has no answer if nobody wrote one down in June. That is the
 * one thing on this page that is genuinely irrecoverable, which is why
 * the review mark is the feature and the table is only the scaffolding.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FINDING IS THE GRANT NOBODY JUSTIFIED
 * ══════════════════════════════════════════════════════════════════════
 * A blank `grant_reason` is not a hole in this UI to be papered over with
 * an em dash. It is exactly the row an auditor is hunting for: somebody
 * handed out access to customer books and left no sentence saying why.
 * So `reasonProblem()` classifies it, `reviewOrder()` floats it to the
 * top of the table, and the cell renders WORDS ("No stated reason"),
 * never a red dot — one in twelve Indian men is colour-blind.
 *
 * ⚠️ THIS FILE IS IMPORTED BY A CLIENT COMPONENT. Nothing here may touch
 * the database, `headers()`, or `server-only`.
 */

import { HARD_CAP_MINUTES, MIN_JUSTIFICATION_LENGTH } from "@/lib/platform/impersonation-policy";

/* ------------------------------------------------------------------ */
/* THE TWO KINDS OF ACCESS, AND HOW ONE ID NAMES BOTH                  */
/* ------------------------------------------------------------------ */

/**
 * A standing grant (a row in `platform_staff` — access to EVERY
 * workspace, for as long as it lasts) or one impersonation session
 * (access to ONE workspace, for at most thirty minutes).
 *
 * ⚠️ THEY ARE LISTED TOGETHER AND THEY ARE NOT THE SAME THING. A grant
 * is a standing capability; a session is one use of it. An auditor wants
 * both in one list — "who could, and who did" — but the table always
 * says which is which in words, because a reviewer who confuses them
 * either panics at a routine grant or shrugs at a live session.
 */
export type AccessReviewKind = "grant" | "session";

export const ACCESS_REVIEW_KIND_LABELS: Readonly<Record<AccessReviewKind, string>> =
  Object.freeze({
    grant: "Standing grant",
    session: "Impersonation",
  });

/**
 * The id the browser sees, e.g. `grant:6f1c…` or `session:9ab2…`.
 *
 * 🔴 THE PREFIX IS NOT A PERMISSION AND NOT A TYPE PROOF. It travels in
 * the address bar and anybody can write one. The server re-parses it,
 * re-fetches the underlying row BY ID FROM THE RIGHT TABLE, and treats a
 * mismatch as a forgery. The prefix exists so the server knows which
 * table to interrogate — not so it can skip the interrogation.
 */
export function accessReviewItemId(kind: AccessReviewKind, id: string): string {
  return `${kind}:${id}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Split a submitted item id, or return null.
 *
 * ⚠️ THE UUID SHAPE IS CHECKED HERE ON PURPOSE. These strings end up in a
 * `WHERE id = $1` against a `uuid` column, and Postgres raises 22P02 on a
 * malformed literal — which would turn one junk id in a batch of forty
 * into a database error rather than a clean refusal.
 */
export function parseAccessReviewItemId(
  raw: string,
): { kind: AccessReviewKind; id: string } | null {
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const kind = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (kind !== "grant" && kind !== "session") return null;
  if (!UUID_RE.test(id)) return null;
  return { kind, id };
}

/* ------------------------------------------------------------------ */
/* THE PERIOD — A CALENDAR MONTH IN INDIAN CIVIL TIME                  */
/* ------------------------------------------------------------------ */

/**
 * 🔴 +05:30, FIXED, AND NOT `toISOString()`.
 *
 * "The month of July" means July as the customer's accountant means it,
 * and their day rolls over at midnight IST. Cutting the window on UTC
 * boundaries moves five and a half hours of sessions into the wrong
 * month — the busiest five and a half hours, since 00:00–05:30 IST is
 * exactly when nobody is working and 18:30–24:00 UTC is exactly when
 * everybody is.
 *
 * India has never observed daylight saving, so a fixed offset is exact
 * rather than an approximation, and a fixed offset can be reasoned about
 * in a test without a timezone database.
 */
const IST_OFFSET_MINUTES = 330;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function istFieldsOf(instant: Date): { year: number; month: number } {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
}

/** The instant at which a given IST calendar month begins, in UTC terms. */
function istMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1) - IST_OFFSET_MINUTES * 60_000);
}

export type ReviewPeriod = {
  /** `YYYY-MM`, the value carried in `?month=`. */
  key: string;
  /** "July 2026" — for the heading and for the audit row's reason. */
  label: string;
  /** Inclusive lower bound. */
  from: Date;
  /** EXCLUSIVE upper bound, so two adjacent months never double-count. */
  to: Date;
};

function periodFor(year: number, month: number): ReviewPeriod {
  const from = istMonthStart(year, month);
  const to = istMonthStart(year, month + 1);
  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    label: `${MONTH_NAMES[month] ?? "Unknown"} ${year}`,
    from,
    to,
  };
}

/**
 * The default window: the LAST COMPLETE calendar month.
 *
 * ⚠️ NOT "the last thirty days", and not the current month. A review is a
 * sign-off on a closed period; reviewing a month that is still running
 * means signing off on rows that do not exist yet, and the next reviewer
 * cannot tell whether the gap was examined or simply had not happened.
 */
export function previousCalendarMonthIST(now: Date): ReviewPeriod {
  const { year, month } = istFieldsOf(now);
  return month === 0 ? periodFor(year - 1, 11) : periodFor(year, month - 1);
}

/** The months offered in the picker: this one, then backwards. */
export function recentMonthKeys(now: Date, count: number): string[] {
  const { year, month } = istFieldsOf(now);
  const keys: string[] = [];
  for (let back = 0; back < count; back += 1) {
    const total = year * 12 + month - back;
    keys.push(periodFor(Math.floor(total / 12), total % 12).key);
  }
  return keys;
}

/**
 * Resolve `?month=YYYY-MM`, falling back to the previous calendar month.
 *
 * ⚠️ AN UNPARSEABLE MONTH FALLS BACK RATHER THAN ERRORING, and the
 * heading always names the month actually being shown, so a mistyped URL
 * can never leave somebody signing off on a period they did not mean —
 * they can see which month they got.
 */
export function resolveReviewPeriod(raw: string | null | undefined, now: Date): ReviewPeriod {
  if (!raw) return previousCalendarMonthIST(now);
  const match = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (!match) return previousCalendarMonthIST(now);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    return previousCalendarMonthIST(now);
  }
  if (!Number.isInteger(month) || month < 0 || month > 11) {
    return previousCalendarMonthIST(now);
  }
  return periodFor(year, month);
}

export function monthKeyLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const month = Number(match[2]) - 1;
  return `${MONTH_NAMES[month] ?? key} ${match[1]}`;
}

/* ------------------------------------------------------------------ */
/* THE ROW                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `workspace` IS A SENTENCE, NOT AN ID. A standing grant reaches every
 * workspace, and writing "—" there would read as "none". It says so.
 */
export const EVERY_WORKSPACE = "Every workspace";

export type AccessReviewRow = {
  /** `grant:<uuid>` or `session:<uuid>`. See `parseAccessReviewItemId`. */
  itemId: string;
  kind: AccessReviewKind;
  kindLabel: string;
  /** The human who held the access. Our staff, never a customer. */
  who: string;
  whoGrade: string;
  workspace: string;
  workspaceId: string | null;
  /** ISO. Granted at, or session start. */
  startedAt: string;
  /** ISO, or null for a standing grant with NO END DATE — itself notable. */
  endsAt: string | null;
  /** Whole minutes the access lasted (or has lasted so far); null when open-ended. */
  minutes: number | null;
  /** The stated reason, verbatim. Null or blank is the finding. */
  reason: string | null;
  /** Still usable right now, by the clock — never by a nullable end column. */
  active: boolean;
  /** The state in WORDS. "Live now", "Ended", "Revoked", "Expired". */
  stateWord: string;
  /** ISO of the LATEST review mark, or null. Derived from the register. */
  reviewedAt: string | null;
  reviewedBy: string | null;
};

/* ------------------------------------------------------------------ */
/* 🔴 THE FINDING                                                       */
/* ------------------------------------------------------------------ */

export type ReasonProblem = "missing" | "thin";

/**
 * ⚠️ TWO DIFFERENT FAILURES, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   • `missing` — nobody wrote anything. Impersonation refuses to start
 *     without a justification, so in practice this is a STANDING GRANT
 *     handed out with no recorded reason: the single worst row on the
 *     page and the reason the page exists.
 *   • `thin`    — something was written, and it is shorter than the
 *     minimum a new impersonation must clear today. Older rows predate
 *     that floor. Not a scandal, but it is not an explanation either.
 */
export function reasonProblem(reason: string | null | undefined): ReasonProblem | null {
  const text = (reason ?? "").trim();
  if (text.length === 0) return "missing";
  if (text.length < MIN_JUSTIFICATION_LENGTH) return "thin";
  return null;
}

export const REASON_PROBLEM_WORDS: Readonly<Record<ReasonProblem, string>> = Object.freeze({
  missing: "No stated reason",
  thin: "Reason too short to explain anything",
});

/** The word for the review column. Never a tick, never a colour. */
export function reviewWord(row: AccessReviewRow): string {
  return row.reviewedAt ? "Reviewed" : "Not reviewed";
}

/**
 * ⭐ THE ORDER THE AUDITOR WANTS, NOT THE ORDER THE DATABASE HAS.
 *
 * Unjustified access first, then whatever is still open, then everything
 * else newest-first. A reviewer who runs out of time must have spent it
 * on the rows that would have made the finding.
 */
export function reviewOrder(row: AccessReviewRow): number {
  if (reasonProblem(row.reason) === "missing") return 0;
  if (reasonProblem(row.reason) === "thin") return 1;
  if (row.active) return 2;
  if (!row.reviewedAt) return 3;
  return 4;
}

export function sortForReview(rows: readonly AccessReviewRow[]): AccessReviewRow[] {
  return [...rows].sort((a, b) => {
    const byRank = reviewOrder(a) - reviewOrder(b);
    if (byRank !== 0) return byRank;
    return b.startedAt.localeCompare(a.startedAt);
  });
}

/** How many rows on this page an auditor would call a finding. */
export function countFindings(rows: readonly AccessReviewRow[]): number {
  return rows.filter((r) => reasonProblem(r.reason) !== null).length;
}

export function countUnreviewed(rows: readonly AccessReviewRow[]): number {
  return rows.filter((r) => r.reviewedAt === null).length;
}

/* ------------------------------------------------------------------ */
/* ⚠️ "REVIEWED" IS A LOG-DERIVED STATE. READ THIS BEFORE TRUSTING IT.  */
/* ------------------------------------------------------------------ */

/**
 * The `resource_type` a review mark is filed under in
 * `platform_action_log`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO `access_review` TABLE AND THIS BATCH MAY NOT CREATE ONE.
 * ══════════════════════════════════════════════════════════════════════
 * So "reviewed" is not a column anybody can read. It is DERIVED by
 * reading the action register back and looking for rows of this
 * `resource_type` whose `resource_id` is the item id. That works, and it
 * has three costs that are stated here rather than discovered later:
 *
 *   ① NO UNIQUE CONSTRAINT. Two operators reviewing the same row at the
 *      same moment produce TWO rows, and nothing in the database objects.
 *      That is why `latestReviewByItem()` takes the newest per item
 *      rather than asserting there is exactly one.
 *   ② THE READ IS THE INDEX. There is no `reviewed_at` to filter or sort
 *      on in SQL; a period's marks are fetched and folded in memory. Fine
 *      at a month's volume, and it would not be fine at a year's.
 *   ③ NO UN-REVIEW. The register is append-only by trigger, so a review
 *      recorded in error cannot be deleted — only superseded by a later
 *      row. An auditor therefore sees both, which is the correct
 *      outcome and worth saying out loud.
 *
 * ⚠️ AND THE MARK MUST BE WRITTEN WITH `tenantId: null`. `recordPlatformAudit`
 * routes a tenant-attributed row into that tenant's own `audit_logs`,
 * where this page cannot read it back — the derived state would silently
 * lose every review of an impersonation session.
 */
export const ACCESS_REVIEW_RESOURCE = "platform_access_review";

export type ReviewMark = {
  itemId: string;
  reviewedAt: string;
  reviewedBy: string;
};

/**
 * Fold register rows into one mark per item — the LATEST, per cost ① above.
 *
 * ⚠️ TIES BROKEN BY ORDER OF ARRIVAL, so the caller's `ORDER BY
 * created_at DESC, id DESC` decides. Two marks in the same millisecond is
 * not a scenario worth a second column; picking deterministically is.
 */
export function latestReviewByItem(
  marks: readonly ReviewMark[],
): ReadonlyMap<string, ReviewMark> {
  const byItem = new Map<string, ReviewMark>();
  for (const mark of marks) {
    const existing = byItem.get(mark.itemId);
    if (!existing || existing.reviewedAt < mark.reviewedAt) {
      byItem.set(mark.itemId, mark);
    }
  }
  return byItem;
}

/* ------------------------------------------------------------------ */
/* DURATION, IN WORDS                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ "45 days" AND "22 minutes" IN ONE COLUMN. A standing grant and an
 * impersonation are measured in different units by the people who care
 * about them, and forcing both into minutes gives an auditor "64,800"
 * where they wanted "a month and a half".
 */
export function durationWords(minutes: number | null): string {
  if (minutes === null) return "No end date";
  if (minutes < 1) return "Under a minute";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} hr`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * The longest an impersonation can possibly have lasted, restated here so
 * a reviewer reading a "31 min" row knows it is impossible rather than
 * merely surprising.
 */
export const IMPERSONATION_CEILING_MINUTES = HARD_CAP_MINUTES;

/* ------------------------------------------------------------------ */
/* TIMESTAMPS, IN INDIAN CIVIL TIME, DETERMINISTICALLY                 */
/* ------------------------------------------------------------------ */

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * "12 Jul 2026, 14:05 IST".
 *
 * ⚠️ HAND-FORMATTED RATHER THAN `toLocaleString`, for two reasons that
 * both bite this page specifically. First, the row is rendered on the
 * server and hydrated in the browser, and the two ICU builds disagree
 * about the space before "pm" — a hydration mismatch on an audit screen
 * is a screen an operator stops trusting. Second, a reviewer copying a
 * timestamp into a note to an auditor must copy the SAME string every
 * time, whatever laptop they are on.
 *
 * ⚠️ AND THE ZONE IS NAMED IN THE OUTPUT. A bare "14:05" beside a
 * customer's complaint about 2pm is a fifteen-minute argument.
 */
export function formatIST(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown";
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const month = SHORT_MONTHS[shifted.getUTCMonth()] ?? "???";
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${shifted.getUTCFullYear()}, ${hours}:${minutes} IST`;
}
