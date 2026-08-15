/**
 * Ordence — ⭐⭐⭐ LEAVE AND STAFF ATTENDANCE
 * Version: v1.46.0-alpha · Batch 59
 *
 * Mirrors `SQL-FILES/0082_leave_and_attendance.sql`. The reasoning lives
 * in both, because the two are read by different people at different
 * times and a decision recorded in only one of them is a decision the
 * other reader gets to re-take.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY A NEW FILE AND NOT AN EXTENSION OF `payroll.ts`
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/payroll.ts` mirrors `SQL-FILES/0075_payroll.sql` one-to-one.
 * That pairing is the only reason anybody can answer "which migration
 * created this column" without `git log`, and it is what
 * `check:sql-completeness` leans on. Six new tables appended to
 * `payroll.ts` would make that file mirror two migrations and neither
 * cleanly.
 *
 * ⚠️ AND THE TWO SUBJECTS ARE NOT THE SAME SUBJECT. Payroll is a wage
 * BILL: it accrues money, posts a journal and creates statutory
 * liabilities. Leave is an ENTITLEMENT LEDGER denominated in days, whose
 * only contact with money is that a day of unpaid absence reduces one
 * month's pay and a day of encashment increases it. Somebody
 * administering leave — a line manager approving three days off — has no
 * business in the file that holds everybody's salary, and the import
 * graph is where that separation either exists or does not.
 *
 * `leave.ts` imports `employees` from `payroll.ts`, and that is the only
 * direction the dependency runs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE FOUR DECISIONS THIS FILE IS MADE OF
 * ══════════════════════════════════════════════════════════════════════
 *
 * ① ACCRUAL IS EARNED, NOT GRANTED.
 *    The default is `monthly_earned`: entitlement is earned across the
 *    leave year in proportion to the days the person was actually on the
 *    rolls, and it is written as a dated ledger entry at the end of each
 *    month. A full year's balance appearing on 1 April for somebody who
 *    joins in October is a liability the business does not owe and
 *    cannot get back once it is taken. `annual_advance` exists because
 *    some employers genuinely do grant up front, but it is a choice a
 *    person makes on a screen that says what it costs, not the default.
 *
 * ② A BALANCE IS DERIVED FROM ENTRIES, NEVER STORED.
 *    🔴 THERE IS NO `leave_balances` TABLE IN THIS FILE, AND ITS ABSENCE
 *    IS THE DESIGN. A stored balance is a cache of a sum, and a cache
 *    that disagrees with its ledger is unarguable with an employee: they
 *    have their own list of the days they took, and "the system says 8"
 *    is not an answer to it. `leave_ledger` is append-only by trigger and
 *    the balance is `sum(days_delta)`, computed by
 *    `lib/leave/balance.ts` and by nothing else.
 *
 * ③ CARRY-FORWARD AND ENCASHMENT HAVE CAPS AND THE CAPS ARE NOT NULL.
 *    ⚠️ `carry_forward_cap_days` AND `encashment_cap_days` ARE BOTH
 *    `NOT NULL`, with no "unlimited" sentinel of any kind. Uncapped
 *    carry-forward compounds every year into a liability that appears on
 *    nobody's balance sheet until the person resigns and asks to be paid
 *    for it. Zero is a legal and common answer — "use it or lose it" —
 *    and it has to be typed, because a cap that defaults to infinity is a
 *    cap nobody decided.
 *
 * ④ AN APPROVED REQUEST AND AN ATTENDANCE RECORD ARE DIFFERENT FACTS.
 *    Approving four days in December COMMITS four days; it does not spend
 *    them. People cancel plans, fall ill in the middle of a holiday, and
 *    come in anyway. The balance only moves when `staff_attendance` says
 *    the person was actually absent on an actual date. Until then the
 *    approval shows as `committed`, which reduces what they may apply for
 *    next and does not reduce what they have earned.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT STORE
 * ══════════════════════════════════════════════════════════════════════
 * NO GENDER, NO MARITAL STATUS, NO PREGNANCY DATE, NO MEDICAL
 * CERTIFICATE CONTENT, NO DIAGNOSIS.
 *
 * 🔴 THIS IS THE ONE PLACE IN THE PRODUCT WHERE THE OBVIOUS FEATURE IS
 * THE DANGEROUS ONE. "Maternity leave under the Maternity Benefit Act
 * needs to know who is eligible" is true, and the version of it that
 * stores a gender flag and an expected date of delivery turns a leave
 * table into special-category health data that every support session can
 * read. Ordence models maternity as a LEAVE TYPE that is assigned by an
 * `adjustment` entry from somebody holding `leave.manage`. The
 * eligibility decision is made by a human, off-system, and what is
 * recorded is the entitlement, not the reason for it.
 *
 * ⚠️ AND `leave_requests.reason` IS FREE TEXT THAT THE UI LABELS AS
 * OPTIONAL. An employee who types a diagnosis into it has volunteered it;
 * a required field would have demanded it.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  numeric,
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
 * ⭐ HOW A LEAVE TYPE COMES INTO EXISTENCE FOR AN EMPLOYEE.
 *
 * 🔴 `monthly_earned` IS THE DEFAULT AND THE RECOMMENDED ANSWER. Days are
 * earned in proportion to service inside the leave year and written at
 * each month end. A joiner in October has earned roughly half a year's
 * worth by 31 March and nothing more, which is what the business owes.
 *
 * ⚠️ `annual_advance` GRANTS THE WHOLE ENTITLEMENT ON THE FIRST DAY OF
 * THE LEAVE YEAR (or on joining, pro-rated for the remainder of the
 * year — see `lib/leave/accrual.ts`, which refuses to grant a full year
 * to a part-year joiner even under this method, because that is the
 * specific mistake this batch exists to prevent). It is offered because
 * casual and sick leave are commonly granted up front in Indian
 * establishments and pretending otherwise makes the product wrong for
 * most of its users. It carries a real cost: somebody who takes all
 * twelve days in April and resigns in May has been paid for days they
 * did not earn, and recovering that is a full-and-final settlement
 * matter Ordence does not do.
 *
 * ⭐ `none` IS FOR TYPES THAT ARE NEVER EARNED — loss of pay is the
 * obvious one. It has no entitlement, no accrual and no balance; it
 * exists so that an absence can be classified rather than left blank.
 */
export const leaveAccrualMethodEnum = pgEnum("leave_accrual_method", [
  "monthly_earned",
  "annual_advance",
  "none",
]);

/**
 * 🔴 THE VOCABULARY OF THE LEDGER, AND EVERY ONE OF THESE IS A ROW WITH A
 * SIGN ON IT. `days_delta` is signed; the kind says WHY.
 *
 * ⚠️ THE SPLIT BETWEEN THE FIRST GROUP AND THE LAST TWO IS DECISION ④.
 *
 *   BALANCE-MOVING          opening_balance, accrual, carry_forward_in,
 *                           lapse, taken, encashed, adjustment
 *   COMMITMENT-MOVING       commitment, commitment_release
 *
 * A `commitment` is what an APPROVAL writes. It never changes what the
 * employee has earned; it changes what they may still apply for. When
 * attendance records the day as actually taken, a `taken` entry moves the
 * balance and a `commitment_release` cancels the reservation. If the
 * request is cancelled instead, only the `commitment_release` is written
 * and the balance was never touched.
 *
 * ⭐ THERE IS NO `correction` OR `delete`. A wrong entry is fixed by an
 * `adjustment` with the opposite sign and a note. That is what makes the
 * append-only trigger survivable: the ledger is the argument, and an
 * argument you can quietly edit is not one.
 */
export const leaveEntryKindEnum = pgEnum("leave_entry_kind", [
  /** Migrated-in balance on the day the workspace started using Ordence. */
  "opening_balance",
  /** Earned. Written by the accrual run, dated to the month it belongs to. */
  "accrual",
  /** Brought in from the previous leave year, already capped. */
  "carry_forward_in",
  /** ⚠️ The part of last year's balance that exceeded the cap. Negative. */
  "lapse",
  /** 🔴 Written from ATTENDANCE, never from an approval. Negative. */
  "taken",
  /** Paid out in cash. Negative. */
  "encashed",
  /** A human decision, with a note. Either sign. */
  "adjustment",
  /** An approval reserving days. Negative. Does not move the balance. */
  "commitment",
  /** Cancels a reservation. Positive. Does not move the balance. */
  "commitment_release",
]);

/**
 * ⚠️ `withdrawn` IS NOT HERE AND `cancelled` IS. One status for "it did
 * not happen" is enough; who cancelled it is `decided_by`, and why is
 * `decision_note`. Two statuses that mean the same thing produce two
 * code paths that drift.
 */
export const leaveRequestStatusEnum = pgEnum("leave_request_status", [
  /** Being typed. Reserves nothing. */
  "draft",
  /** Awaiting a decision. ⭐ ALREADY RESERVES — see the overlap constraint. */
  "submitted",
  /** Approved. A `commitment` entry exists for it. */
  "approved",
  /** Refused, with a reason. */
  "rejected",
  /** Called off by either side. Any commitment is released. */
  "cancelled",
]);

/**
 * 🔴 THE STATUS IS THE FACT. `lop_fraction` IS THE MONEY.
 *
 * ⚠️ THEY ARE STORED SEPARATELY AND NOT DERIVED FROM EACH OTHER, WHICH
 * LOOKS REDUNDANT AND IS NOT. `paid_leave` with a zero LOP fraction and
 * `paid_leave` with a half LOP fraction are both real: the second is
 * somebody who took a full day off with only half a day of balance left,
 * which is an extremely common Indian payroll case and one that a
 * status-only model cannot express at all. A CHECK keeps the pairs that
 * are nonsense — `weekly_off` with a LOP fraction, `absent` with none —
 * out of the table.
 */
export const staffAttendanceStatusEnum = pgEnum("staff_attendance_status", [
  "present",
  /** Working, but not at the usual place. Paid, and not leave. */
  "on_duty",
  /** The weekly holiday. Paid. Not deducted from any balance. */
  "weekly_off",
  /** A declared holiday from `holiday_calendar`. Paid. */
  "holiday",
  /** Taken against a leave type with a balance. Paid. */
  "paid_leave",
  /** Taken against a type with no balance left, or an unpaid type. */
  "unpaid_leave",
  /** 🔴 Nobody told anybody. Full loss of pay until somebody regularises it. */
  "absent",
]);

/* ------------------------------------------------------------------ */
/* ① THE LEAVE YEAR                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE LEAVE YEAR IS A ROW, NOT A CONSTANT.
 *
 * ⚠️ HARDCODING 1 APRIL – 31 MARCH WOULD BE WRONG FOR A LARGE MINORITY
 * OF INDIAN EMPLOYERS. The financial year is April–March and the leave
 * year very often is too, which is why the seed uses it — but calendar
 * year is common in multinationals, and joining-anniversary years exist.
 * A constant in code means the only workspaces the product fits are the
 * ones that guessed the same way we did.
 *
 * 🔴 CLOSING A PERIOD IS THE EVENT THAT CARRIES FORWARD AND LAPSES, and
 * both are written as ledger entries into the NEXT period. `is_closed`
 * is therefore not a display flag — it is the record that the
 * carry-forward has already run, and it is what stops it running twice
 * and doubling everybody's opening balance.
 */
export const leavePeriods = pgTable(
  "leave_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** "FY 2025-26". Free text, because the convention is the tenant's. */
    label: varchar("label", { length: 60 }).notNull(),

    startsOn: date("starts_on").notNull(),
    /** Inclusive. 31 March, not 1 April. */
    endsOn: date("ends_on").notNull(),

    /**
     * ⚠️ SET BY THE CLOSE, NEVER BY HAND ON A SCREEN. Once true, the
     * carry-forward entries for the following period exist and running
     * the close again would write them a second time.
     */
    isClosed: boolean("is_closed").default(false).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("leave_periods_id_tenant_key").on(t.id, t.tenantId),
    startUnique: uniqueIndex("leave_periods_start_key").on(t.tenantId, t.startsOn),
    rangeIdx: index("leave_periods_range_idx").on(t.tenantId, t.startsOn, t.endsOn),
    /** A leave year that ends before it starts is a typo with consequences. */
    datesOrdered: check("leave_periods_dates_ordered", sql`${t.endsOn} > ${t.startsOn}`),
    /**
     * ⚠️ A "LEAVE YEAR" OF FOUR YEARS IS NOT A LEAVE YEAR. The accrual
     * divides the entitlement across the period, so a period length
     * nobody meant silently changes everybody's monthly accrual rate.
     */
    lengthSane: check(
      "leave_periods_length_sane",
      sql`${t.endsOn} - ${t.startsOn} BETWEEN 27 AND 400`,
    ),
  }),
);

/**
 * ⭐ DECLARED HOLIDAYS, BECAUSE OTHERWISE "FIVE DAYS OF LEAVE" IS
 * AMBIGUOUS.
 *
 * ⚠️ THIS IS NOT `court_holidays` (legal.ts) AND NOT THE SCHEDULING
 * MODULE'S `holiday` BLOCK REASON. Those answer "is the registry open"
 * and "is this room bookable". This one answers "does Thursday come out
 * of the employee's balance", which is a money question with a different
 * owner and a different list — a company observes Ugadi whether or not
 * the High Court does.
 *
 * 🔴 `is_restricted` IS THE INDIAN SPECIFIC THAT MOST PRODUCTS MISS. A
 * restricted holiday (RH / optional holiday) is published on the calendar
 * but only paid if the employee elects to take it, and each employee gets
 * a fixed number of elections. Modelling it as an ordinary holiday pays
 * everybody for every festival on the list.
 */
export const holidayCalendar = pgTable(
  "holiday_calendar",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    onDate: date("on_date").notNull(),
    label: varchar("label", { length: 120 }).notNull(),

    /**
     * ⚠️ Optional. A holiday list is frequently per-location in India —
     * Maharashtra observes Gudi Padwa, Karnataka observes Ugadi, and a
     * company with offices in both publishes two lists. NULL means "every
     * location", which is the common case and therefore the default.
     */
    workStateCode: varchar("work_state_code", { length: 2 }),

    isRestricted: boolean("is_restricted").default(false).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("holiday_calendar_id_tenant_key").on(t.id, t.tenantId),
    /**
     * ⚠️ THE STATE CODE IS PART OF THE KEY, so one date can be a holiday
     * in Karnataka and a working day in Maharashtra. Two rows for the
     * same date and the same state is a duplicated import.
     */
    dateUnique: uniqueIndex("holiday_calendar_date_key").on(
      t.tenantId,
      t.onDate,
      t.workStateCode,
    ),
    dateIdx: index("holiday_calendar_date_idx").on(t.tenantId, t.onDate),
  }),
);

/* ------------------------------------------------------------------ */
/* ② THE LEAVE TYPES                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE POLICY, WRITTEN DOWN AS COLUMNS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS TABLE IS NOT: A STATUTORY CALCULATOR
 * ══════════════════════════════════════════════════════════════════════
 * Indian leave entitlement is not one rule. Earned leave for a factory
 * worker comes from section 79 of the Factories Act 1948 — one day for
 * every twenty days worked, credited in the FOLLOWING year, with its own
 * carry-forward limit. Everybody else is covered by their State's Shops
 * and Establishments Act, and those differ from each other on the number
 * of days, on whether sick and casual leave are separate, and on what
 * lapses.
 *
 * ⚠️ ORDENCE DOES NOT KNOW WHICH ACT APPLIES TO A GIVEN EMPLOYEE, AND A
 * PRODUCT THAT GUESSED WOULD BE CONFIDENTLY WRONG FOR MOST OF ITS USERS.
 * So this table models the CONTRACTUAL policy the employer has actually
 * decided, and `annual_entitlement_days` carries a note in the UI saying
 * that it must be at least the statutory minimum for the establishment.
 * The check is a human's, made once, and recorded here.
 */
export const leaveTypes = pgTable(
  "leave_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** "EL", "CL", "SL", "LOP". Stable; the label may be renamed freely. */
    code: varchar("code", { length: 20 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),

    /**
     * 🔴 FALSE MEANS EVERY DAY TAKEN IS LOSS OF PAY. Loss of pay is
     * modelled as a leave TYPE rather than as the absence of one, so that
     * an unpaid day is applied for, approved and recorded exactly like
     * any other — which is the only way the payroll number and the leave
     * register ever agree.
     */
    isPaid: boolean("is_paid").default(true).notNull(),

    accrualMethod: leaveAccrualMethodEnum("accrual_method")
      .default("monthly_earned")
      .notNull(),

    /**
     * Days per full leave year, for somebody on the rolls the whole year.
     * ⚠️ NUMERIC, NOT INTEGER: 1.25 days a month is a real policy and
     * 15 days a year is not divisible by 12.
     */
    annualEntitlementDays: numeric("annual_entitlement_days", { precision: 7, scale: 2 })
      .default("0")
      .notNull(),

    /**
     * ⭐ ROUNDING, MADE EXPLICIT AND STORED, BECAUSE IT IS THE FIRST
     * THING AN EMPLOYEE NOTICES. 0.5 rounds every accrual to a half day.
     * 0 means no rounding at all.
     *
     * ⚠️ THE ROUNDING IS APPLIED TO THE CUMULATIVE TARGET AND NOT TO EACH
     * MONTH — see `lib/leave/accrual.ts`. Rounding each month
     * independently turns 1.25 days a month into 18 days a year against
     * an entitlement of 15, and the error is invisible until March.
     */
    accrualRoundToDays: numeric("accrual_round_to_days", { precision: 4, scale: 2 })
      .default("0.5")
      .notNull(),

    /**
     * ⚠️ PROBATION. Days on the rolls before this many days of service
     * have elapsed earn nothing. Common, legal in most Shops Acts for
     * contractual leave above the statutory floor, and a silent source of
     * argument when it is applied without being written down anywhere.
     */
    probationDays: integer("probation_days").default(0).notNull(),

    /**
     * 🔴🔴 DECISION ③. NOT NULL, NO SENTINEL FOR "UNLIMITED".
     *
     * The maximum number of days that may cross from one leave year into
     * the next. Everything above it is written as a `lapse` entry with
     * the reason on it, so the employee can see what expired and when.
     *
     * ⚠️ UNCAPPED CARRY-FORWARD IS AN OFF-BALANCE-SHEET LIABILITY. Thirty
     * people quietly accumulating five unused days a year for six years
     * is nine hundred days of salary the accounts have never once
     * mentioned, and it becomes payable in a single quarter the first
     * time a team turns over. Zero — use it or lose it — is a perfectly
     * good answer. It just has to be typed.
     */
    carryForwardCapDays: numeric("carry_forward_cap_days", { precision: 7, scale: 2 })
      .default("0")
      .notNull(),

    /**
     * 🔴🔴 DECISION ③, THE OTHER HALF. The maximum days that may be paid
     * out in cash in one leave year. Same argument, same NOT NULL, same
     * absence of an "unlimited" value.
     */
    encashmentCapDays: numeric("encashment_cap_days", { precision: 7, scale: 2 })
      .default("0")
      .notNull(),

    /**
     * ⚠️ HOW MANY DAYS MUST REMAIN AFTER AN ENCASHMENT. Encashing a
     * balance to zero and then falling ill is how an employee ends up on
     * loss of pay in the month after they were paid for their leave.
     */
    encashmentMinRetainDays: numeric("encashment_min_retain_days", {
      precision: 7,
      scale: 2,
    })
      .default("0")
      .notNull(),

    /**
     * ⭐ MAY THE BALANCE GO BELOW ZERO, AND BY HOW MUCH. Some employers
     * let staff borrow against future accrual; most do not.
     * `max_negative_days` is meaningless unless this is true, and the
     * CHECK says so rather than leaving a stale number in the row.
     */
    allowNegativeBalance: boolean("allow_negative_balance").default(false).notNull(),
    maxNegativeDays: numeric("max_negative_days", { precision: 7, scale: 2 })
      .default("0")
      .notNull(),

    /**
     * 🔴 THE OTHER MOST ARGUED-ABOUT FLAG, AFTER `pro_rates` IN PAYROLL.
     *
     * TRUE: an intervening Sunday or declared holiday inside a leave
     * period is DEDUCTED from the balance. This is normal for earned or
     * privilege leave in many establishments — the block of days is what
     * is granted.
     *
     * FALSE: only working days come out of the balance. Normal for casual
     * and sick leave.
     *
     * ⚠️ GETTING THIS BACKWARDS ON ONE TYPE COSTS EVERY EMPLOYEE WHO
     * TAKES A LONG HOLIDAY EXACTLY TWO DAYS A WEEK, and it looks like a
     * plausible number the whole time.
     */
    countsHolidaysAndOffs: boolean("counts_holidays_and_offs").default(false).notNull(),

    /** Reject an application submitted fewer than this many days ahead. */
    minNoticeDays: integer("min_notice_days").default(0).notNull(),
    /** Null means no limit. */
    maxConsecutiveDays: numeric("max_consecutive_days", { precision: 7, scale: 2 }),

    /** ⭐ Half days are ordinary in Indian practice. Some types forbid them. */
    allowHalfDay: boolean("allow_half_day").default(true).notNull(),

    displayOrder: integer("display_order").default(100).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("leave_types_id_tenant_key").on(t.id, t.tenantId),
    codeUnique: uniqueIndex("leave_types_code_key").on(t.tenantId, t.code),
    activeIdx: index("leave_types_active_idx").on(t.tenantId, t.isActive, t.displayOrder),

    entitlementSane: check(
      "leave_types_entitlement_sane",
      sql`${t.annualEntitlementDays} >= 0 AND ${t.annualEntitlementDays} <= 365`,
    ),
    capsSane: check(
      "leave_types_caps_sane",
      sql`${t.carryForwardCapDays} >= 0 AND ${t.encashmentCapDays} >= 0
          AND ${t.encashmentMinRetainDays} >= 0 AND ${t.maxNegativeDays} >= 0`,
    ),
    /**
     * ⚠️ ROUNDING GRANULARITY ABOVE ONE DAY IS NOT ROUNDING, IT IS A
     * DIFFERENT ACCRUAL POLICY, and it would round a 1.25-day month to
     * zero forever.
     */
    roundingSane: check(
      "leave_types_rounding_sane",
      sql`${t.accrualRoundToDays} >= 0 AND ${t.accrualRoundToDays} <= 1`,
    ),
    /** A stale negative limit on a type that forbids negatives is a lie. */
    negativeConsistent: check(
      "leave_types_negative_consistent",
      sql`${t.allowNegativeBalance} OR ${t.maxNegativeDays} = 0`,
    ),
    /**
     * 🔴 A TYPE THAT IS NEVER EARNED CANNOT CARRY FORWARD OR BE ENCASHED.
     * Loss of pay with a carry-forward cap of 5 is not a policy, it is a
     * row nobody read back.
     */
    noAccrualNoBalance: check(
      "leave_types_no_accrual_no_balance",
      sql`${t.accrualMethod} <> 'none'
          OR (${t.annualEntitlementDays} = 0
              AND ${t.carryForwardCapDays} = 0
              AND ${t.encashmentCapDays} = 0)`,
    ),
    probationSane: check(
      "leave_types_probation_sane",
      sql`${t.probationDays} >= 0 AND ${t.probationDays} <= 730`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ③ THE LEDGER — DECISION ②                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ EVERY MOVEMENT OF EVERY BALANCE, AND THE ONLY PLACE A BALANCE
 * COMES FROM.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 APPEND-ONLY BY TRIGGER, LIKE `audit_logs`
 * ══════════════════════════════════════════════════════════════════════
 * `leave_ledger_block_mutation()` refuses UPDATE and DELETE. A mistaken
 * entry is corrected by an `adjustment` in the opposite direction with a
 * note, exactly as a mistaken journal entry is reversed rather than
 * erased.
 *
 * ⚠️ WHICH IS WHY EVERY FOREIGN KEY HERE IS `RESTRICT` AND NOT
 * `CASCADE`. A cascade is a DELETE, and a DELETE the trigger refuses
 * turns "deactivate this employee" into an error message nobody can act
 * on. Employees are deactivated (`is_active`), leave types are
 * deactivated, requests are cancelled — nothing in this module is ever
 * deleted, and the FKs are what make that true rather than customary.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE IDEMPOTENCY KEY IS THE ACCRUAL'S WHOLE SAFETY STORY
 * ══════════════════════════════════════════════════════════════════════
 * `leave_ledger_accrual_once` — UNIQUE (tenant, employee, type,
 * effective_on) WHERE kind = 'accrual' — is what makes running the
 * monthly accrual twice for May a no-op instead of a doubling. An accrual
 * run is exactly the kind of job that gets triggered twice: a cron that
 * retried, an admin who clicked because the first click seemed slow, a
 * deploy that replayed a queue. Without this index the second run is
 * silent and everybody's balance is wrong by one month, forever, because
 * the ledger is append-only and the fix is another visible entry.
 */
export const leaveLedger = pgTable(
  "leave_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * ⚠️ `restrict`, NOT `cascade` — see the block comment above. Nothing
     * cascades into an append-only table.
     */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    leaveTypeId: uuid("leave_type_id")
      .notNull()
      .references(() => leaveTypes.id, { onDelete: "restrict" }),
    periodId: uuid("period_id")
      .notNull()
      .references(() => leavePeriods.id, { onDelete: "restrict" }),

    kind: leaveEntryKindEnum("kind").notNull(),

    /**
     * 🔴 SIGNED, AND IN DAYS. Positive earns, negative spends.
     *
     * ⚠️ `numeric(7,2)` AND NOT A FLOAT, for the same reason money is
     * `numeric(18,0)` and not a float: 0.1 + 0.2 is not 0.3 in binary
     * floating point, and a leave balance that prints as 12.299999999999
     * is a support ticket. Drizzle hands numerics back as strings; the
     * arithmetic happens in `lib/leave/balance.ts` in integer hundredths
     * of a day, which is the exact analogue of paise.
     */
    daysDelta: numeric("days_delta", { precision: 7, scale: 2 }).notNull(),

    /**
     * ⭐ THE DATE THE ENTRY BELONGS TO, WHICH IS NOT `created_at`. A May
     * accrual run in June is dated 31 May. Backdating a correction is
     * ordinary and honest; pretending it was written then is not, and
     * `created_at` is the column that says when it was actually typed.
     */
    effectiveOn: date("effective_on").notNull(),

    /**
     * ⚠️ NO `.references()` ON THESE TWO, AND IT IS NOT AN OVERSIGHT.
     * `leave_requests` and `staff_attendance` are declared BELOW this
     * table and they point back at it, so a Drizzle-level reference in
     * both directions is a cycle. The foreign keys are real and are
     * declared in `SQL-FILES/0082_leave_and_attendance.sql`, which is the
     * authority for constraints in this codebase anyway — `drizzle-kit
     * push` builds tables and the numbered files build the guarantees.
     */
    requestId: uuid("request_id"),
    attendanceId: uuid("attendance_id"),

    /**
     * ⚠️ REQUIRED ON AN `adjustment`, ENFORCED BY A CHECK. An unexplained
     * manual movement of somebody's leave balance is the single entry in
     * this table most likely to be disputed, and "there is a note on it"
     * is the difference between an answer and an accusation.
     */
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("leave_ledger_id_tenant_key").on(t.id, t.tenantId),
    /**
     * ⭐ THE INDEX THE BALANCE QUERY LIVES ON. Every read of this table
     * is "every entry for this person and this type in this period", and
     * without it the fold degrades into a sequential scan of the whole
     * workspace's leave history on every screen.
     */
    balanceIdx: index("leave_ledger_balance_idx").on(
      t.tenantId,
      t.employeeId,
      t.leaveTypeId,
      t.periodId,
    ),
    dateIdx: index("leave_ledger_effective_idx").on(t.tenantId, t.effectiveOn),
    requestIdx: index("leave_ledger_request_idx").on(t.tenantId, t.requestId),

    /** 🔴 The accrual run's idempotency key. See the block comment. */
    accrualOnce: uniqueIndex("leave_ledger_accrual_once")
      .on(t.tenantId, t.employeeId, t.leaveTypeId, t.effectiveOn)
      .where(sql`kind = 'accrual'`),

    /** A zero-day entry says nothing and makes the ledger harder to read. */
    deltaNonZero: check("leave_ledger_delta_non_zero", sql`${t.daysDelta} <> 0`),
    /**
     * ⚠️ THE SIGN IS PART OF THE MEANING. An `accrual` of −3 or a `taken`
     * of +2 is a bug in whatever wrote it, and it would fold into a
     * balance that looks entirely reasonable.
     */
    signMatchesKind: check(
      "leave_ledger_sign_matches_kind",
      sql`(${t.kind} IN ('accrual', 'carry_forward_in', 'commitment_release') AND ${t.daysDelta} > 0)
          OR (${t.kind} IN ('lapse', 'taken', 'encashed', 'commitment') AND ${t.daysDelta} < 0)
          OR (${t.kind} IN ('opening_balance', 'adjustment'))`,
    ),
    adjustmentExplained: check(
      "leave_ledger_adjustment_explained",
      sql`${t.kind} <> 'adjustment' OR (${t.note} IS NOT NULL AND length(btrim(${t.note})) >= 3)`,
    ),
    /**
     * 🔴 DECISION ④, ENFORCED. A `taken` entry MUST point at the
     * attendance row that caused it. Without this a `taken` can be
     * written from an approval, which is precisely the conflation this
     * module exists to prevent — and once one exists nobody can tell
     * which days were actually absent.
     */
    takenFromAttendance: check(
      "leave_ledger_taken_from_attendance",
      sql`${t.kind} <> 'taken' OR ${t.attendanceId} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ④ THE REQUEST                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ AN APPLICATION, ITS DECISION, AND NOTHING ELSE.
 *
 * 🔴 `days` IS STORED AND IT IS NOT A BALANCE. It is the number of days
 * this application ASKS FOR, computed once by
 * `lib/leave/request.ts#requestedDays` from the dates, the type's
 * holiday rule and the calendar in force at the time. Storing it is
 * correct for the same reason an invoice stores its own line totals: the
 * holiday calendar can be edited afterwards, and an application must
 * still say what it said when it was approved.
 *
 * ⚠️ WHAT IS *NOT* STORED HERE IS THE BALANCE IT LEAVES BEHIND. That is
 * decision ②, and a `balance_after` column here would be the stored
 * balance in disguise.
 */
export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    leaveTypeId: uuid("leave_type_id")
      .notNull()
      .references(() => leaveTypes.id, { onDelete: "restrict" }),

    fromOn: date("from_on").notNull(),
    /** Inclusive. */
    toOn: date("to_on").notNull(),

    /** ⭐ Half days at either end. A three-and-a-half day absence is normal. */
    halfDayStart: boolean("half_day_start").default(false).notNull(),
    halfDayEnd: boolean("half_day_end").default(false).notNull(),

    /** As computed when the application was made. See the block comment. */
    days: numeric("days", { precision: 7, scale: 2 }).notNull(),

    status: leaveRequestStatusEnum("status").default("draft").notNull(),

    /** ⚠️ Optional, and labelled optional. See the header on health data. */
    reason: text("reason"),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * 🔴 REQUIRED ON A REJECTION, ENFORCED BY A CHECK. A refusal with no
     * reason is the thing an employee escalates, and the person who has
     * to answer for it three months later is not the person who clicked.
     */
    decisionNote: text("decision_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("leave_requests_id_tenant_key").on(t.id, t.tenantId),
    employeeIdx: index("leave_requests_employee_idx").on(
      t.tenantId,
      t.employeeId,
      t.fromOn,
    ),
    /** The approver's queue: everything awaiting a decision, oldest first. */
    pendingIdx: index("leave_requests_pending_idx")
      .on(t.tenantId, t.status, t.fromOn)
      .where(sql`status = 'submitted'`),

    datesOrdered: check("leave_requests_dates_ordered", sql`${t.toOn} >= ${t.fromOn}`),
    daysPositive: check(
      "leave_requests_days_positive",
      sql`${t.days} > 0 AND ${t.days} <= 400`,
    ),
    /**
     * ⚠️ A HALF DAY AT BOTH ENDS OF A ONE-DAY APPLICATION IS ZERO DAYS,
     * and the arithmetic that produced it was asked a question that makes
     * no sense. A single day taken as a half day sets `half_day_start`.
     */
    halfDaysCoherent: check(
      "leave_requests_half_days_coherent",
      sql`${t.fromOn} <> ${t.toOn} OR NOT (${t.halfDayStart} AND ${t.halfDayEnd})`,
    ),
    rejectionExplained: check(
      "leave_requests_rejection_explained",
      sql`${t.status} <> 'rejected'
          OR (${t.decisionNote} IS NOT NULL AND length(btrim(${t.decisionNote})) >= 3)`,
    ),
    decidedTogether: check(
      "leave_requests_decided_together",
      sql`(${t.status} IN ('approved', 'rejected')) = (${t.decidedAt} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⑤ STAFF ATTENDANCE — THE TABLE BATCH 50 IS WAITING FOR              */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ ONE ROW PER SALARIED PERSON PER DAY, AND THE ONLY SOURCE OF
 * LOSS OF PAY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `components/payroll/payroll-run-board.tsx` passes `attendance: []` to
 * the payroll compute. It is hardcoded, and it is hardcoded because
 * there was nowhere for the data to come from: `db/schema/labour.ts` has
 * an `attendance_kind` enum for CONSTRUCTION LABOUR check-in/check-out
 * punches, and contract labour is paid through a vendor's RA bill and is
 * on nobody's payroll. So every payroll run has paid every salaried
 * person a full month whatever they did, and loss of pay could not be
 * entered at all.
 *
 * ⚠️ `site_attendance` IS NOT THIS TABLE AND MUST NOT BECOME IT. It
 * records punches — a timestamp and a direction — for people who are not
 * employees. This one records a DAY'S VERDICT for people who are. Merging
 * them would put contract labour into payslips, which misstates the
 * employment relationship in a way a labour inspector cares about, and it
 * is the same separation `employees` vs `site_workers` already makes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE FRACTION, NOT TWO
 * ══════════════════════════════════════════════════════════════════════
 * The table stores `lop_fraction` and no `paid_fraction`.
 *
 * 🔴 A SECOND COLUMN THAT MUST ALWAYS EQUAL `1 - lop_fraction` IS THE
 * STORED-BALANCE MISTAKE AT THE SCALE OF ONE DAY. The moment one of them
 * is written without the other, a day is both paid and unpaid and the
 * payslip and the register disagree about a person's salary.
 *
 * ⚠️ AND PAYROLL ONLY NEEDS THE LOP HALF. `server/payroll/run.ts` derives
 * `payableDays` from the days the person was on the rolls in the period —
 * it already handles joiners and leavers correctly and does not need
 * attendance to tell it. The one thing attendance adds to the money is
 * `lopDays = sum(lop_fraction)`.
 */
export const staffAttendance = pgTable(
  "staff_attendance",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),

    onDate: date("on_date").notNull(),

    status: staffAttendanceStatusEnum("status").notNull(),

    /**
     * 🔴 THE NUMBER THAT REACHES THE PAYSLIP. 0.00 · 0.50 · 1.00 in
     * practice, but `numeric(3,2)` because quarter days exist in some
     * establishments and a CHECK is a better place to say "no" than a
     * type is.
     */
    lopFraction: numeric("lop_fraction", { precision: 3, scale: 2 })
      .default("0")
      .notNull(),

    /**
     * ⚠️ NULLABLE, AND ITS NULLABILITY IS DECISION ④ AGAIN. Somebody who
     * simply did not turn up is `absent` with no leave type and no
     * request. Forcing a type here would make the system unable to record
     * the most common reason anybody looks at this screen.
     */
    leaveTypeId: uuid("leave_type_id").references(() => leaveTypes.id, {
      onDelete: "restrict",
    }),
    requestId: uuid("request_id").references(() => leaveRequests.id, {
      onDelete: "restrict",
    }),

    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("staff_attendance_id_tenant_key").on(t.id, t.tenantId),
    /**
     * 🔴 ONE VERDICT PER PERSON PER DAY. Two rows for one day double the
     * loss of pay, and a payslip short by a plausible amount is the
     * hardest kind of error to notice.
     */
    dayUnique: uniqueIndex("staff_attendance_day_key").on(
      t.tenantId,
      t.employeeId,
      t.onDate,
    ),
    /** ⭐ The exact shape of the payroll query: a tenant, a date range. */
    periodIdx: index("staff_attendance_period_idx").on(t.tenantId, t.onDate, t.employeeId),
    requestIdx: index("staff_attendance_request_idx").on(t.tenantId, t.requestId),

    fractionSane: check(
      "staff_attendance_fraction_sane",
      sql`${t.lopFraction} >= 0 AND ${t.lopFraction} <= 1`,
    ),
    /**
     * 🔴 THE PAIRS THAT ARE NONSENSE, REFUSED AT THE DATABASE.
     *
     * A weekly off or a declared holiday with loss of pay on it means
     * somebody has been docked for a Sunday. An `absent` day with no loss
     * of pay means an unexplained absence was paid in full. Both are
     * single-keystroke errors on a grid of thirty days and neither looks
     * wrong in a list.
     *
     * ⚠️ `paid_leave` IS DELIBERATELY ALLOWED A NON-ZERO FRACTION. Taking
     * a full day against half a day of balance is real, and the other
     * half is loss of pay.
     */
    statusFractionCoherent: check(
      "staff_attendance_status_fraction_coherent",
      sql`(${t.status} IN ('present', 'on_duty', 'weekly_off', 'holiday') AND ${t.lopFraction} = 0)
          OR (${t.status} = 'absent' AND ${t.lopFraction} > 0)
          OR (${t.status} = 'unpaid_leave' AND ${t.lopFraction} > 0)
          OR (${t.status} = 'paid_leave')`,
    ),
    /** A leave day with no type recorded cannot be reconciled to anything. */
    leaveHasType: check(
      "staff_attendance_leave_has_type",
      sql`${t.status} NOT IN ('paid_leave', 'unpaid_leave') OR ${t.leaveTypeId} IS NOT NULL`,
    ),
  }),
);
