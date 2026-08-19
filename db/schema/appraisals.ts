/**
 * Ordence — ⭐⭐⭐ THE REPORTING HIERARCHY AND THE APPRAISAL CYCLE
 * Version: v1.47.0-alpha · Batch 109
 *
 * Mirrors `SQL-FILES/0085_appraisals_and_org.sql`. The reasoning lives
 * in both, because whoever opens the database in a client never sees
 * this file and whoever opens this file never runs the migration.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 WHAT WAS HERE BEFORE THIS BATCH: NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * This is not "completing a partial". `employees` (0075) has no
 * `manager_id`, no `reports_to`, and no reporting table hangs off it.
 * There was no appraisal table, no appraisal engine, and no org chart.
 * The recurring "a complete engine that nothing reaches" pattern does
 * NOT apply here — there was no engine either.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE REPORTING LINE IS ITS OWN TABLE AND NOT `employees.manager_id`
 * ══════════════════════════════════════════════════════════════════════
 * A single self-referencing column answers "who is your manager" and
 * cannot answer "who was your manager in October", which is the only
 * question an appraisal actually asks. A cycle covering April to
 * September, signed off in November by whoever happens to hold the
 * column today, is signed by somebody who may never have managed the
 * person. That signature is worthless and it looks exactly like a valid
 * one.
 *
 * ⭐ SO THE LINE IS DATED: one CURRENT row per employee (enforced by a
 * partial unique index) plus the history of every previous line. The
 * chart reads the current rows; an appraisal reads the row that covered
 * the review period.
 *
 * ⚠️ AND IT KEEPS THIS BATCH OUT OF `db/schema/payroll.ts`, which is
 * payroll's file. A new column on `employees` would have been a merge
 * conflict with a concurrently-edited table that computes wages.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A CYCLE IN THE HIERARCHY HANGS EVERY RECURSIVE QUERY THAT WALKS IT
 * ══════════════════════════════════════════════════════════════════════
 * A reports to B, B reports to A. `WITH RECURSIVE` has no idea it is
 * going round; it produces rows forever until the connection dies or
 * the plan spills the disk. Two ordinary edits, made a month apart by
 * two people who were each individually right, produce it — and the
 * database will not stop you, because a foreign key has no opinion
 * about reachability.
 *
 * ⭐ WHERE IT IS REFUSED, IN ORDER OF WHO CAN BE BYPASSED:
 *
 *   ① `reporting_lines_no_self` — a CHECK constraint. A row that names
 *      itself is the one-hop cycle and is refused by the table.
 *
 *   ② `reporting_lines_no_cycle()` — a BEFORE INSERT OR UPDATE TRIGGER
 *      in 0085. It walks up from the proposed manager through the
 *      CURRENT rows and raises if it meets the employee, and raises
 *      again past a depth of 64. 🔴 THIS IS THE ENFORCEMENT THAT
 *      MATTERS, because it is the only one a CSV import, a support
 *      session with a psql prompt, a future action, or a background job
 *      cannot go round.
 *
 *   ③ `lib/hr/hierarchy.ts#wouldCreateCycle` — the same rule in
 *      TypeScript, so the user gets a sentence naming the loop instead
 *      of a 500 with a Postgres error code in it.
 *
 * ⚠️ ③ IS A COURTESY AND ② IS THE CONTROL. If they ever disagree the
 * trigger wins, and the fix is to the TypeScript.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT HAPPENS TO THE REPORTS OF SOMEBODY WHO LEAVES — DECIDED
 * ══════════════════════════════════════════════════════════════════════
 * NOTHING AUTOMATIC. The leaver keeps their node, their reporting line
 * is not ended and their reports are not moved.
 *
 * ⚠️ THE TWO TEMPTING ALTERNATIVES ARE BOTH WORSE.
 *
 *   • Nulling the reports' manager on exit ORPHANS them silently. They
 *     vanish from under the branch they were on, reappear at the root
 *     next to the managing director, and nobody is told. Mid-cycle, the
 *     manager review for four people is now nobody's job and the cycle
 *     closes without it.
 *
 *   • Re-pointing them at the leaver's own manager — "promote the
 *     grandparent" — is worse still, because it looks correct. It
 *     silently changes who signs off an appraisal for a period that
 *     person did not supervise, and it does it without a human deciding
 *     anything.
 *
 * ⭐ SO THE LEAVER STAYS IN THE CHART, MARKED, AND THE ORPHAN RISK IS
 * MADE LOUD INSTEAD OF SILENT: `lib/hr/hierarchy.ts` reports every
 * report whose manager has left as an explicit `staleLines` list, the
 * org chart renders it as a warning band, and HR moves them by hand.
 * An appraisal already in flight is unaffected, because the reviewer is
 * SNAPSHOTTED onto `appraisal_subjects` when the person is enrolled.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A SIGNED-OFF OUTCOME IS EVIDENCE AND IS NOT EDITABLE
 * ══════════════════════════════════════════════════════════════════════
 * Once `appraisal_subjects.signed_off_at` is set, the outcome columns
 * are frozen by trigger. There is no "edit" and no "reopen".
 *
 * ⭐ A CORRECTION IS AN `appraisal_amendments` ROW: the previous rating,
 * the new rating, WHO, WHEN, and a reason of at least twenty characters
 * that the database insists on. The table is append-only by trigger.
 * The EFFECTIVE outcome is the latest amendment, or the original if
 * there is none — the same "a balance is a fold, never a column" rule
 * `leave_ledger` follows, for the same reason: a stored figure that has
 * been quietly overwritten cannot be argued with, and an appraisal is
 * argued with by definition.
 *
 * ⚠️ WHO MAY AMEND: `payroll.approve` — the sign-off key, not the
 * everyday HR key. See `server/actions/appraisals.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THIS IS NOT WIRED TO PAY. SAID PLAINLY, SO NOBODY ASSUMES.
 * ══════════════════════════════════════════════════════════════════════
 * There is NO money column anywhere in this file — no increment, no
 * bonus, no revised CTC, no percentage. Nothing in `server/payroll/**`,
 * `lib/payroll/**` or `server/actions/payroll.ts` reads any of these
 * tables, and nothing here writes a `pay_components` row, an
 * `employee_salary_structures` row or a payslip line.
 *
 * A rating of "outstanding" changes NOBODY'S SALARY. Somebody has to
 * open payroll and type the new figure. That is deliberate for this
 * batch: an appraisal engine that moves money on its own needs the
 * effective-dating, the approval separation and the arrears arithmetic
 * that a salary revision already has, and half of that is a wage bill
 * computed from a rating nobody signed.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  date,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { employees } from "./payroll";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A WORDED SCALE, NOT A NUMBER OUT OF FIVE.
 *
 * ⚠️ "3" IS NOT A RATING, IT IS HALF OF ONE. Out of five? Is five good?
 * Two products in this market use 1 = best. A stored integer means the
 * meaning lives in whichever screen last rendered it, and the day two
 * screens disagree the whole register is unreadable. Words survive
 * export to a spreadsheet, which is where appraisal data actually goes.
 */
export const appraisalRatingEnum = pgEnum("appraisal_rating", [
  "unsatisfactory",
  "needs_improvement",
  "meets",
  "exceeds",
  "outstanding",
]);

/**
 * ⭐ THREE ACTS, THREE VALUES, AND THEY ARE NOT INTERCHANGEABLE.
 *
 * 🔴 ONE `review` ROW WITH A `comments` FIELD WOULD HAVE BEEN THE OBVIOUS
 * BUILD AND IT WOULD BE WRONG, because the three have different authors,
 * different readers and different consequences:
 *
 *   `self`       — written by the subject about themselves. The subject
 *                  may always read it: they wrote it.
 *   `manager`    — written by the reporting manager. The subject sees it
 *                  only once the outcome is released, because a manager
 *                  who knows the subject is reading live writes a
 *                  different, less useful review.
 *   `skip_level` — written by the manager's manager, and NEVER shown to
 *                  the subject OR to the direct manager. 🔴 THAT IS THE
 *                  ENTIRE POINT OF A SKIP-LEVEL: it is a check ON the
 *                  manager. Showing it to them turns it into a second
 *                  manager review with extra steps.
 *
 * The visibility matrix is `lib/hr/visibility.ts` and it is a pure
 * function so it can be tested without a database.
 */
export const appraisalReviewKindEnum = pgEnum("appraisal_review_kind", [
  "self",
  "manager",
  "skip_level",
]);

/**
 * ⚠️ `closed` IS NOT `cancelled`. A closed cycle happened and its
 * outcomes stand. A cancelled cycle is one somebody abandoned, and its
 * outcomes must never be quoted at anybody — but the rows stay, because
 * deleting an appraisal because it was inconvenient is the one thing an
 * employment tribunal reads as consciousness of guilt.
 */
export const appraisalCycleStatusEnum = pgEnum("appraisal_cycle_status", [
  "draft",
  "open",
  "closed",
  "cancelled",
]);

/**
 * The state of ONE person's appraisal inside a cycle.
 *
 * ⭐ `released` IS SEPARATE FROM `signed_off` ON PURPOSE. Signing off
 * fixes the evidence; releasing is the moment the subject is allowed to
 * read the manager's review. In most organisations those are days apart
 * and the gap is the conversation. Folding them into one state means the
 * employee reads the review before anybody has spoken to them.
 */
export const appraisalSubjectStatusEnum = pgEnum("appraisal_subject_status", [
  "pending",
  "self_submitted",
  "manager_submitted",
  "signed_off",
  "released",
]);

/* ------------------------------------------------------------------ */
/* ① THE REPORTING LINE                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ONE CURRENT LINE PER EMPLOYEE, PLUS THE HISTORY OF EVERY PREVIOUS
 * ONE.
 *
 * A row with `endedOn IS NULL` is the line in force. Ending it and
 * inserting a new one is how a reporting change is recorded; UPDATEing
 * the manager in place would erase the fact that anybody else ever held
 * the line, which is the fact an appraisal for last quarter depends on.
 *
 * ⚠️ NOBODY HAS A ROW AT ALL UNTIL SOMEBODY SETS ONE. The absence of a
 * line means "reports to nobody recorded" — the root of the chart — and
 * that is a legitimate state for a managing director and an unhelpful
 * one for everybody else. `lib/hr/hierarchy.ts` counts the roots and the
 * screen says so, because a chart with forty roots is not a chart.
 */
export const reportingLines = pgTable(
  "reporting_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The person who reports. */
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),

    /**
     * The person they report to.
     *
     * ⚠️ `restrict`, NOT `cascade` AND NOT `set null`. Deleting a manager
     * row must not silently delete or blank the lines of everybody under
     * them — see the header on what happens when somebody leaves.
     * `employees` is not deleted in normal operation anyway; `leftOn` is
     * set. This makes the abnormal case refuse rather than cascade.
     */
    managerId: uuid("manager_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),

    effectiveFrom: date("effective_from").notNull(),
    /** Null while in force. */
    endedOn: date("ended_on"),

    /** Why the line changed. Free text, shown in the history. */
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("reporting_lines_id_tenant_key").on(t.id, t.tenantId),
    /**
     * 🔴 THE PARTIAL UNIQUE INDEX IS WHAT MAKES "CURRENT" MEAN SOMETHING.
     * Two open lines for one employee means two managers, and every
     * recursive walk would visit the person twice and produce a chart
     * with duplicate subtrees.
     */
    oneCurrentPerEmployee: uniqueIndex("reporting_lines_current_key")
      .on(t.tenantId, t.employeeId)
      .where(sql`ended_on IS NULL`),
    /** The direct-reports lookup, which the chart does once per node. */
    byManager: index("reporting_lines_manager_idx").on(t.tenantId, t.managerId, t.endedOn),
    byEmployee: index("reporting_lines_employee_idx").on(t.tenantId, t.employeeId, t.effectiveFrom),
    /**
     * 🔴 THE ONE-HOP CYCLE, REFUSED BY THE TABLE ITSELF. Longer cycles
     * need the trigger in 0085; this one does not, and a constraint the
     * planner enforces on every row is cheaper and impossible to skip.
     */
    noSelf: check("reporting_lines_no_self", sql`${t.employeeId} <> ${t.managerId}`),
    datesOrdered: check(
      "reporting_lines_dates_ordered",
      sql`${t.endedOn} IS NULL OR ${t.endedOn} >= ${t.effectiveFrom}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ② THE CYCLE — WHO IS REVIEWED, OVER WHAT PERIOD                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE PERIOD IS A PROPERTY OF THE CYCLE AND IT IS NOT THE FINANCIAL
 * YEAR BY ASSUMPTION.
 *
 * ⚠️ INDIAN EMPLOYERS APPRAISE ON THE FINANCIAL YEAR MORE OFTEN THAN
 * NOT — 1 April to 31 March — and `fyLabel` records which one a cycle
 * belongs to so the register can be read by year. But half-yearly and
 * calendar-year cycles are common enough that hardcoding April would
 * make the product fit only the workspaces that guessed as we did. The
 * dates are typed; the FY label is derived from `periodEnd` by
 * `lib/hr/appraisal.ts#fyLabelFor`, in Asia/Kolkata civil dates, never
 * from a `Date` object's timezone.
 */
export const appraisalCycles = pgTable(
  "appraisal_cycles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 120 }).notNull(),

    /** The period being reviewed. Inclusive at both ends. */
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    /** ⭐ "2025-26". Derived, stored, and indexed so a year can be listed. */
    fyLabel: varchar("fy_label", { length: 7 }).notNull(),

    selfReviewDueOn: date("self_review_due_on"),
    managerReviewDueOn: date("manager_review_due_on"),

    status: appraisalCycleStatusEnum("status").default("draft").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("appraisal_cycles_id_tenant_key").on(t.id, t.tenantId),
    nameUnique: uniqueIndex("appraisal_cycles_name_key").on(t.tenantId, t.name),
    byYear: index("appraisal_cycles_fy_idx").on(t.tenantId, t.fyLabel, t.periodStart),
    datesOrdered: check("appraisal_cycles_dates_ordered", sql`${t.periodEnd} > ${t.periodStart}`),
    /**
     * ⚠️ A "REVIEW PERIOD" OF FOUR YEARS IS NOT A REVIEW PERIOD. It is a
     * mistyped year, and it silently makes every enrolment pick the
     * wrong historical reporting line.
     */
    periodSane: check(
      "appraisal_cycles_period_sane",
      sql`${t.periodEnd} - ${t.periodStart} BETWEEN 27 AND 400`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ③ THE SUBJECT — ONE PERSON'S APPRAISAL IN ONE CYCLE                 */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 THE REVIEWERS ARE SNAPSHOTTED HERE AT ENROLMENT, NOT LOOKED UP
 *      AT READ TIME.
 *
 * `managerEmployeeId` and `skipLevelEmployeeId` are copies of the
 * reporting line as it stood over the review period. They are columns,
 * not joins.
 *
 * ⚠️ THE JOIN-AT-READ-TIME VERSION IS SHORTER AND IT IS THE BUG. A
 * reorganisation in week three would move a live appraisal to a manager
 * who has never met the person, delete the half-written review of the
 * one who has, and do it to forty people at once with nobody informed.
 * `payslips` makes the same call about `employees` for the same reason:
 * joining at read time shows today's answer to a question about
 * September.
 *
 * ⭐ SKIP-LEVEL IS NULLABLE AND OFTEN NULL. It is the manager's own
 * manager, and near the top of a small company there isn't one. A null
 * means "no skip-level review is expected", which the screen states
 * rather than showing an empty box that looks unfinished forever.
 */
export const appraisalSubjects = pgTable(
  "appraisal_subjects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    cycleId: uuid("cycle_id")
      .notNull()
      .references(() => appraisalCycles.id, { onDelete: "cascade" }),

    /** The person being reviewed. */
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),

    /** Who reviews them, frozen at enrolment. Null = no manager on record. */
    managerEmployeeId: uuid("manager_employee_id").references(() => employees.id, {
      onDelete: "restrict",
    }),
    skipLevelEmployeeId: uuid("skip_level_employee_id").references(() => employees.id, {
      onDelete: "restrict",
    }),

    status: appraisalSubjectStatusEnum("status").default("pending").notNull(),

    /**
     * 🔴 THE OUTCOME. FROZEN BY TRIGGER ONCE `signedOffAt` IS SET.
     * Corrections go to `appraisal_amendments`; see the file header.
     */
    outcomeRating: appraisalRatingEnum("outcome_rating"),
    outcomeSummary: text("outcome_summary"),

    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    signedOffBy: uuid("signed_off_by").references(() => users.id, { onDelete: "set null" }),

    /** ⭐ When the subject became allowed to read the manager review. */
    releasedAt: timestamp("released_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("appraisal_subjects_id_tenant_key").on(t.id, t.tenantId),
    /** ⚠️ One appraisal per person per cycle. Two is a duplicate enrolment. */
    oneePerCycle: uniqueIndex("appraisal_subjects_cycle_employee_key").on(
      t.tenantId,
      t.cycleId,
      t.employeeId,
    ),
    /**
     * 🔴 THE INDEX THE LINE-SCOPED READ DEPENDS ON. A manager's queue is
     * "the subjects whose manager is me", and it must not be a full scan
     * of the register — a slow query is the reason somebody later
     * "optimises" it into a wider one.
     */
    byManager: index("appraisal_subjects_manager_idx").on(
      t.tenantId,
      t.managerEmployeeId,
      t.cycleId,
    ),
    bySkip: index("appraisal_subjects_skip_idx").on(t.tenantId, t.skipLevelEmployeeId, t.cycleId),
    byEmployee: index("appraisal_subjects_employee_idx").on(t.tenantId, t.employeeId),
    /**
     * ⚠️ A SIGN-OFF WITHOUT A RATING IS A SIGNATURE ON A BLANK PAGE, and
     * it is exactly what an over-eager "mark all complete" button
     * produces.
     */
    signedHasOutcome: check(
      "appraisal_subjects_signed_has_outcome",
      sql`${t.signedOffAt} IS NULL OR ${t.outcomeRating} IS NOT NULL`,
    ),
    /** ⚠️ Nothing is released to the subject before it is signed off. */
    releaseAfterSignoff: check(
      "appraisal_subjects_release_after_signoff",
      sql`${t.releasedAt} IS NULL OR ${t.signedOffAt} IS NOT NULL`,
    ),
    /** A person cannot be their own reviewer at either level. */
    reviewerNotSelf: check(
      "appraisal_subjects_reviewer_not_self",
      sql`(${t.managerEmployeeId} IS NULL OR ${t.managerEmployeeId} <> ${t.employeeId})
          AND (${t.skipLevelEmployeeId} IS NULL OR ${t.skipLevelEmployeeId} <> ${t.employeeId})
          AND (${t.skipLevelEmployeeId} IS NULL OR ${t.managerEmployeeId} IS NULL
               OR ${t.skipLevelEmployeeId} <> ${t.managerEmployeeId})`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ④ THE REVIEWS — THREE DIFFERENT ACTS                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ONE ROW PER (SUBJECT, KIND). The self review, the manager review
 * and the skip-level review are three rows, not three columns on one.
 *
 * 🔴 AND THE REVIEWER IS CHECKED AGAINST THE KIND BY A TRIGGER IN 0085
 * (`appraisal_reviews_reviewer_matches_kind`). A `manager` row whose
 * reviewer is not the snapshotted manager is refused by the database,
 * so a mis-shaped write from any future code path — an import, a script,
 * a second action — cannot quietly file somebody else's opinion as the
 * manager's.
 *
 * ⚠️ `submittedAt IS NULL` MEANS DRAFT, AND A DRAFT IS PRIVATE TO ITS
 * AUTHOR. Once it is set the row is frozen by trigger: a review somebody
 * has acted on is evidence in the same way the outcome is, and "let me
 * just soften that line" after the conversation is exactly the edit that
 * must leave a trace rather than happen.
 */
export const appraisalReviews = pgTable(
  "appraisal_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    subjectId: uuid("subject_id")
      .notNull()
      .references(() => appraisalSubjects.id, { onDelete: "cascade" }),

    kind: appraisalReviewKindEnum("kind").notNull(),

    /** Who wrote it. Checked against `kind` by trigger. */
    reviewerEmployeeId: uuid("reviewer_employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),

    /**
     * ⚠️ NULLABLE ON PURPOSE. A self review that had to carry a rating
     * would force people to grade themselves before saying anything,
     * and the number they type under that pressure is noise.
     */
    rating: appraisalRatingEnum("rating"),

    strengths: text("strengths"),
    improvements: text("improvements"),

    /** Null while a draft. Setting it freezes the row. */
    submittedAt: timestamp("submitted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("appraisal_reviews_id_tenant_key").on(t.id, t.tenantId),
    oneOfEachKind: uniqueIndex("appraisal_reviews_subject_kind_key").on(
      t.tenantId,
      t.subjectId,
      t.kind,
    ),
    byReviewer: index("appraisal_reviews_reviewer_idx").on(t.tenantId, t.reviewerEmployeeId),
  }),
);

/* ------------------------------------------------------------------ */
/* ⑤ THE AMENDMENTS — APPEND-ONLY, AND THE ONLY WAY TO CHANGE AN        */
/*    OUTCOME AFTER SIGN-OFF                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE EFFECTIVE OUTCOME IS `latest amendment ?? subject.outcomeRating`
 * AND IT IS NEVER WRITTEN BACK TO THE SUBJECT ROW.
 *
 * Writing it back would give the register a column that disagrees with
 * its own history the first time an amendment is inserted by anything
 * that forgets the second write — and the disagreement would be
 * invisible, because both numbers look like ratings. `leave_ledger`
 * makes exactly this call about balances and says why at length.
 *
 * ⚠️ `reason` IS NOT NULL WITH A LENGTH FLOOR THE DATABASE ENFORCES.
 * "typo" is not a reason to change what somebody's performance was
 * recorded as, and an optional reason field is an empty reason field.
 */
export const appraisalAmendments = pgTable(
  "appraisal_amendments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    subjectId: uuid("subject_id")
      .notNull()
      .references(() => appraisalSubjects.id, { onDelete: "cascade" }),

    previousRating: appraisalRatingEnum("previous_rating").notNull(),
    newRating: appraisalRatingEnum("new_rating").notNull(),
    previousSummary: text("previous_summary"),
    newSummary: text("new_summary"),

    /** 🔴 THE ACTOR. Not "the system", not the last person to log in. */
    amendedBy: uuid("amended_by").references(() => users.id, { onDelete: "set null" }),
    /** The actor's own employee row, when they have one. */
    amendedByEmployeeId: uuid("amended_by_employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),

    amendedAt: timestamp("amended_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("appraisal_amendments_id_tenant_key").on(t.id, t.tenantId),
    bySubject: index("appraisal_amendments_subject_idx").on(t.tenantId, t.subjectId, t.amendedAt),
    reasonMeant: check(
      "appraisal_amendments_reason_meant",
      sql`length(btrim(${t.reason})) >= 20`,
    ),
    /** ⚠️ An amendment that changes nothing is a row that muddies the trail. */
    changesSomething: check(
      "appraisal_amendments_changes_something",
      sql`${t.newRating} <> ${t.previousRating}
          OR ${t.newSummary} IS DISTINCT FROM ${t.previousSummary}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type ReportingLine = typeof reportingLines.$inferSelect;
export type AppraisalCycle = typeof appraisalCycles.$inferSelect;
export type AppraisalSubject = typeof appraisalSubjects.$inferSelect;
export type AppraisalReview = typeof appraisalReviews.$inferSelect;
export type AppraisalAmendment = typeof appraisalAmendments.$inferSelect;
export type AppraisalRating = (typeof appraisalRatingEnum.enumValues)[number];
export type AppraisalReviewKind = (typeof appraisalReviewKindEnum.enumValues)[number];
