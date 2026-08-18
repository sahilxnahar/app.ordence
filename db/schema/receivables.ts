/**
 * Ordence — ⭐ Receivables & Demand Notices (Phase 38)
 * Version: v0.38.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT PHASE 38 IS: HOW A DEVELOPER ACTUALLY COLLECTS MONEY
 * ══════════════════════════════════════════════════════════════════════
 * Phase 22 sold the flat and built the payment plan. Phase 32 worked out
 * the tax on it. Nothing so far has ASKED THE BUYER FOR THE MONEY, and
 * that request is the single most repeated act in a development company:
 * a project of 240 flats on a nine-stage construction-linked plan raises
 * two thousand demands over its life, chases most of them at least once,
 * and lives or dies on how many are paid within thirty days.
 *
 * ⚠️ AND A DEMAND IS NOT A REMINDER. It is a legal document under the
 * Real Estate (Regulation and Development) Act. It is what the developer
 * relies on to charge interest, and — after the ladder in
 * `dunning_events` has been climbed — to terminate the allotment and
 * forfeit. If it does not state WHAT TRIGGERED IT, the whole chain is
 * unsupportable: the buyer's answer at the Authority is "the third slab
 * was not cast when you demanded for it", and the developer has nothing
 * on the document to answer with.
 *
 * That is why `trigger_label`, `trigger_kind` and `trigger_achieved_on`
 * are NOT NULL on `demand_notices`. Not for tidiness — because a demand
 * without them is a demand that cannot be enforced, and the moment
 * anybody notices is the moment it is needed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE TWO ERRORS THIS PHASE EXISTS TO PREVENT
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ 1. AN ALLOCATION THAT DOES NOT SUM.
 *
 *     A buyer pays ₹5,00,000 against three outstanding demands. That
 *     money has to land somewhere, exactly, and the buyer has to be able
 *     to be SHOWN where. Split it 1,66,666.66 × 3 and two paise vanish;
 *     round each up and the account is over-applied by a paisa that
 *     never clears. Neither is visible on any screen — the receipt says
 *     ₹5,00,000, the demands each say "part paid", and the difference is
 *     found a year later by whoever prepares the statement of account
 *     for a buyer who is now arguing about possession.
 *
 *     So `receipt_allocations` is the ledger of that split, one row per
 *     (receipt, demand), with the principal, tax and interest legs
 *     separated and a SENTENCE on each row. SQL 0027 §5 refuses, at
 *     commit, any receipt whose allocations do not add to its stated
 *     applied total, and any demand whose applied total disagrees with
 *     the allocations pointing at it.
 *
 * ⭐⭐ 2. INTEREST THAT COMPOUNDS SILENTLY.
 *
 *     ₹10,00,000 overdue for a year at 18%: ₹1,80,000 simple,
 *     ₹1,95,618 compounded monthly. The buyer was told one number and is
 *     charged the other, and NOTHING ON THE NOTICE SAYS WHICH RULE WAS
 *     USED. It is not fraud, it is a default in a config file — and it
 *     is indefensible in front of an Authority precisely because the
 *     document is silent.
 *
 *     So `interest_compounding`, `interest_day_count`, `interest_rate_bps`
 *     and `interest_grace_days` are stored ON EACH DEMAND rather than
 *     read from a policy at render time (the policy can change; the
 *     document cannot), and `interest_basis_note` is NOT NULL: the
 *     sentence that goes on the notice, in the notice's own language.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND THE THIRD THING, WHICH IS COMMERCIAL RATHER THAN LEGAL
 * ══════════════════════════════════════════════════════════════════════
 * `leads.preferred_lang` has existed since Phase 22 with a comment saying
 * exactly why: **a demand notice a buyer cannot read is a demand notice
 * that does not get paid.** This is the phase that cashes that in.
 *
 * `demand_notices.language` is the language the document was ISSUED in,
 * and `demand_notice_documents` keeps the rendered body per language with
 * a hash, because "what did we actually send them" is the first question
 * in every dispute. ⚠️ `words_language` on that table records which
 * language the amount-in-words is really in, which is NOT always the
 * document's language — see `lib/receivables/templates/` for why a
 * half-known numbering system is worse than English digits on a document
 * that has to be defended.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ RERA AND THE INTEREST RATE
 * ══════════════════════════════════════════════════════════════════════
 * Section 2(za) defines "interest" symmetrically: the rate the promoter
 * charges the allottee for a delayed payment must EQUAL the rate the
 * promoter pays the allottee for delayed possession, which the State
 * rules set at SBI's highest marginal cost of lending rate plus 2%.
 *
 * Most agreements in circulation still say 18% or 24% p.a., written
 * before RERA and never revised. So `reference_rate_bps` is stored beside
 * `interest_rate_bps` on every demand and `rate_exceeds_reference` is
 * computed at issue — the product does not refuse the configured rate
 * (that is a legal judgement the developer's counsel makes, and the rate
 * may be defensible on a pre-RERA agreement), it makes the gap IMPOSSIBLE
 * TO NOT SEE, on the document and in the register.
 *
 * ⚠️ Money is `bigint` paise. Rates are integer basis points. Dates that
 * are civil days — a notice date, a due date — are `date` columns handled
 * as `YYYY-MM-DD` strings, never `Date` objects with a time on them: a
 * due date that moves by a timezone is a day of interest charged to
 * somebody who paid on time.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  jsonb,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { bookings, leads, paymentMilestones, projects } from "./sales";
/**
 * ⭐ THE GRADE UNION LIVES IN `lib/`, NOT HERE, because the screen that
 * renders "recorded by a person" and the server that refuses to treat it
 * as a dispatch have to agree on the same five words. A second copy in
 * the schema is a second vocabulary, and the two diverge on the day a
 * grade is added.
 */
import type { ServiceEvidenceGrade } from "@/lib/receivables/service-evidence";

/* ------------------------------------------------------------------ */
/* ENUMS — THE DEMAND                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `superseded` IS NOT `cancelled`, AND COLLAPSING THEM LOSES THE ONE
 * FACT THAT MATTERS IN A DISPUTE.
 *
 *   cancelled  — the demand should never have gone out. Withdrawn.
 *   superseded — it went out, it was right, and a corrected one replaced
 *                it (the slab date was restated, the tax rate changed).
 *
 * A buyer who received both needs the record to say which happened, and
 * the interest clock on a superseded demand runs from the ORIGINAL due
 * date while a cancelled one has no clock at all.
 */
export const demandStatusEnum = pgEnum("demand_status", [
  "draft",
  "issued",
  "part_paid",
  "paid",
  "cancelled",
  "superseded",
]);

/**
 * ⭐ WHAT MADE THIS DEMAND FALL DUE. The most legally load-bearing enum
 * in the phase.
 *
 *   construction_event — "on completion of the 3rd slab". The RERA case:
 *                        collection tied to build progress, evidenced by
 *                        the engineer's certificate named in
 *                        `trigger_evidence`.
 *   scheduled_date     — a down-payment plan's "within 30 days of
 *                        booking". Time, not progress.
 *   booking_event      — booking, allotment, agreement execution.
 *   possession         — the final call, on offer of possession.
 *   statutory          — a stamp duty, registration or GST demand that
 *                        arises from law rather than from the plan.
 *
 * ⚠️ THERE IS NO `other`, DELIBERATELY. "Other" on a document whose whole
 * defence is stating its own trigger is a blank the Authority reads
 * aloud.
 */
export const demandTriggerKindEnum = pgEnum("demand_trigger_kind", [
  "construction_event",
  "scheduled_date",
  "booking_event",
  "possession",
  "statutory",
]);

/**
 * ⭐ THE SIX LANGUAGES, AND WHY THESE SIX.
 *
 * English plus the five with the largest buyer populations in the markets
 * this product is built for — Hindi (national), Kannada (Bengaluru,
 * where the reference deployment is), Tamil, Telugu and Marathi. They
 * match the values `leads.preferred_lang` has carried since Phase 22.
 *
 * ⚠️ TWO-LETTER ISO 639-1, so `leads.preferred_lang` (a varchar(8)) maps
 * on to this without a translation table. A workspace that stores `kn-IN`
 * is normalised in `lib/receivables/templates/index.ts`, never here — the
 * database should not be the place a locale tag is parsed.
 */
export const noticeLanguageEnum = pgEnum("notice_language", [
  "en",
  "hi",
  "kn",
  "ta",
  "te",
  "mr",
]);

/**
 * ⚠️ THE ENUM THAT DECIDES HOW MUCH THE BUYER OWES, AND WHOSE DEFAULT IS
 * THEREFORE `simple`.
 *
 * On ₹10,00,000 held for a year at 18% the four options differ by nearly
 * ₹16,000. Whichever one a workspace picks is defensible; picking one
 * SILENTLY is not, which is why `interest_basis_note` beside it is NOT
 * NULL and why `lib/receivables/interest.ts` writes that sentence from
 * this value rather than from prose somebody typed.
 */
export const interestCompoundingEnum = pgEnum("interest_compounding", [
  "simple",
  "monthly",
  "quarterly",
  "annual",
]);

/**
 * ⚠️ THE DAY-COUNT CONVENTION, WHICH NOBODY THINKS TO ASK ABOUT AND WHICH
 * MOVES THE NUMBER BY 1.4%.
 *
 *   actual_365 — the Indian banking default. Days elapsed ÷ 365.
 *   actual_360 — days elapsed ÷ 360. Same rate, 1.4% more interest.
 *   thirty_360 — every month is 30 days. What a spreadsheet does when
 *                somebody writes `=months*rate/12`, and the reason a
 *                buyer's own calculation disagrees with ours by a few
 *                hundred rupees on a demand raised on the 31st.
 */
export const interestDayCountEnum = pgEnum("interest_day_count", [
  "actual_365",
  "actual_360",
  "thirty_360",
]);

/**
 * ⭐ WHICH LEG A RUPEE PAYS FIRST, AND IT IS A REAL LEGAL CHOICE.
 *
 * Section 60 of the Indian Contract Act gives the CREDITOR the right to
 * appropriate a payment where the debtor has not specified, and standard
 * practice — and most builder-buyer agreements — is interest first. The
 * buyer's interest is the other way: principal first stops the interest
 * accruing sooner.
 *
 * ⚠️ SO IT IS STORED AND STATED, NEVER ASSUMED. Every allocation row
 * carries an `explanation` naming the order used, because the whole
 * difference between an appropriation and a mistake is whether the
 * person paying can see which one happened.
 */
export const appropriationOrderEnum = pgEnum("appropriation_order", [
  "interest_first",
  "principal_first",
]);

/**
 * How a receipt was spread across open demands.
 *
 *   oldest_first — the default. The oldest demand is cleared first, which
 *                  is also what stops the ageing buckets filling up with
 *                  ancient part-paid rows.
 *   specified    — the buyer said "this ₹5,00,000 is against the 7th slab
 *                  demand". ⚠️ Under Section 59 of the Contract Act, a
 *                  debtor's express appropriation BINDS the creditor, so
 *                  this is not a convenience — it is the buyer exercising
 *                  a right, and the receipt has to record that they did.
 *   credit       — no demand was open. The money sits as a credit and is
 *                  applied when the next demand is raised.
 */
export const allocationStrategyEnum = pgEnum("allocation_strategy", [
  "oldest_first",
  "specified",
  "credit",
]);

/* ------------------------------------------------------------------ */
/* ENUMS — THE LADDER AND THE MONEY                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE DUNNING LADDER. FOUR RUNGS, IN ONE ORDER, AND NO RUNG MAY BE
 * SKIPPED.
 *
 *   reminder             — courteous, before or just after the due date.
 *   first_notice         — the formal one. Interest starts being stated.
 *   final_notice         — names the consequence.
 *   cancellation_warning — ⚠️ the one that precedes termination of the
 *                          allotment and forfeiture of what has been paid.
 *
 * ⚠️ SKIPPING IS NOT A PROCESS FOUL, IT IS THE DEFECT THAT LOSES THE
 * CASE. A buyer shown a cancellation warning who never received a first
 * notice has a complete answer at the Authority, and the developer's own
 * system is the evidence against them. SQL 0027 §6 refuses a rung whose
 * predecessor was never sent — including to a back-fill script, which is
 * how it happens.
 *
 * ⚠️ AND `cancellation_warning` REQUIRES A NAMED HUMAN. `authorised_by`
 * is enforced NOT NULL for that rung alone, because everything up to it
 * can be swept automatically and that last one may never be.
 */
export const dunningStageEnum = pgEnum("dunning_stage", [
  "reminder",
  "first_notice",
  "final_notice",
  "cancellation_warning",
]);

/**
 * ⚠️ `hand_delivery` AND `post` ARE ON THIS LIST BECAUSE THEY ARE WHAT
 * ACTUALLY COUNTS. Most builder-buyer agreements specify registered post
 * or courier to the address in the agreement as the mode of valid
 * service; an email nobody opened is not service. Recording the channel
 * is what lets somebody answer "was it served?" rather than "was it
 * sent?".
 */
export const dunningChannelEnum = pgEnum("dunning_channel", [
  "email",
  "whatsapp",
  "sms",
  "post",
  "courier",
  "hand_delivery",
  "portal",
]);

export const receiptMethodEnum = pgEnum("receipt_method", [
  "neft",
  "rtgs",
  "imps",
  "upi",
  "cheque",
  "demand_draft",
  "cash",
  "card",
  "netbanking",
  "home_loan_disbursement",
  "adjustment",
]);

/**
 * ⚠️ `bounced` IS WHY THIS ENUM EXISTS AND WHY A RECEIPT IS NOT SIMPLY A
 * ROW THAT MEANS "PAID".
 *
 * A cheque presented on the 5th and returned on the 12th was never money.
 * The demand it was applied against has been overdue the whole time, and
 * the interest clock never stopped — so a bounced receipt must release
 * its allocations rather than quietly stay applied. The CHECK on
 * `receipts` refuses a bounced receipt that still has money applied.
 */
export const receiptStatusEnum = pgEnum("receipt_status", [
  "pending",
  "cleared",
  "bounced",
  "cancelled",
]);

/* ------------------------------------------------------------------ */
/* RECEIVABLE POLICY                                                   */
/* ------------------------------------------------------------------ */

/**
 * The interest and demand terms a project collects under.
 *
 * ⚠️ A POLICY IS A DEFAULT, NOT A SOURCE OF TRUTH FOR AN ISSUED DEMAND.
 * Every rate, rule and grace period is COPIED on to the demand when it is
 * raised. A policy edited in March must not silently restate what a
 * January notice said — the notice is a document that was served, and a
 * system that recomputes served documents from current settings is a
 * system that cannot answer "what did we tell them?".
 *
 * `project_id` NULL means the workspace default. One row per project
 * beats a column on `projects` because the terms change over a project's
 * life and a superseded policy is worth keeping.
 */
export const receivablePolicies = pgTable(
  "receivable_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** NULL = the workspace-wide default. */
    projectId: uuid("project_id"),

    name: varchar("name", { length: 160 }).notNull(),

    /* --- Interest -------------------------------------------------- */
    /** The agreement's rate, per annum, in basis points. 1800 = 18%. */
    interestRateBps: integer("interest_rate_bps").default(1800).notNull(),
    /**
     * ⭐ THE RERA SYMMETRIC RATE — what this promoter would have to PAY an
     * allottee for delayed possession. SBI's highest MCLR + 2%, per the
     * State rules, and the ceiling Section 2(za) implies for what may be
     * charged the other way.
     *
     * Stored rather than looked up, because MCLR moves and a demand must
     * be judged against the rate that applied when it was raised.
     */
    referenceRateBps: integer("reference_rate_bps").default(1110).notNull(),
    compounding: interestCompoundingEnum("compounding").default("simple").notNull(),
    dayCount: interestDayCountEnum("day_count").default("actual_365").notNull(),
    /**
     * Days after the due date before interest begins.
     *
     * ⚠️ NOT THE SAME AS MOVING THE DUE DATE. Interest runs from the DUE
     * DATE once the grace expires in most agreements — the grace forgives
     * the trivially late payer, it does not shorten the period for the
     * one who pays in March.
     */
    graceDays: integer("grace_days").default(0).notNull(),
    /** ⚠️ Does the grace, once exceeded, forgive the graced days too? */
    graceForgivesElapsedDays: boolean("grace_forgives_elapsed_days")
      .default(false)
      .notNull(),

    /* --- The demand ------------------------------------------------ */
    /** Days from the notice date to the due date. */
    demandDueDays: integer("demand_due_days").default(15).notNull(),
    /** GST rate applied to a construction demand. 500 = 5%. */
    gstRateBps: integer("gst_rate_bps").default(500).notNull(),

    /* --- Receipts -------------------------------------------------- */
    appropriationOrder: appropriationOrderEnum("appropriation_order")
      .default("interest_first")
      .notNull(),
    defaultAllocationStrategy: allocationStrategyEnum("default_allocation_strategy")
      .default("oldest_first")
      .notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("receivable_policies_tenant_idx").on(t.tenantId, t.isActive),
    projectIdx: index("receivable_policies_project_idx").on(t.tenantId, t.projectId),

    /**
     * ⚠️ 10000 bps is 100% PER ANNUM. Anything above it is a typed extra
     * digit, not a commercial decision — and the database is the last
     * place that can say so before it reaches a document.
     *
     * ⚠️ AND IT DOES NOT CAP AT THE RERA REFERENCE RATE. That comparison
     * is a legal judgement about a particular agreement, and refusing it
     * here would stop a developer recording the rate their own pre-RERA
     * contract actually says. `lib/receivables/interest.ts` FLAGS it
     * instead, loudly, on the demand and in the register.
     */
    ratesSane: check(
      "receivable_policies_rates_sane",
      sql`${t.interestRateBps} >= 0 AND ${t.interestRateBps} <= 10000
          AND ${t.referenceRateBps} >= 0 AND ${t.referenceRateBps} <= 10000
          AND ${t.gstRateBps} >= 0 AND ${t.gstRateBps} <= 10000`,
    ),
    periodsSane: check(
      "receivable_policies_periods_sane",
      sql`${t.graceDays} >= 0 AND ${t.graceDays} <= 365
          AND ${t.demandDueDays} >= 0 AND ${t.demandDueDays} <= 365`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* DUNNING POLICY                                                      */
/* ------------------------------------------------------------------ */

/**
 * When each rung of the ladder becomes due, measured in days past the
 * demand's due date.
 *
 * ⚠️ THE INTERVALS ARE STRICTLY INCREASING, ENFORCED. A policy whose
 * final notice fires before its first notice does not produce an error —
 * it produces a sweep that sends both on the same morning, which reads to
 * the buyer as a machine and to the Authority as a developer who never
 * gave them a chance.
 */
export const dunningPolicies = pgTable(
  "dunning_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"),

    name: varchar("name", { length: 160 }).notNull(),

    /** Days past due at which each rung becomes due. */
    reminderAfterDays: integer("reminder_after_days").default(3).notNull(),
    firstNoticeAfterDays: integer("first_notice_after_days").default(15).notNull(),
    finalNoticeAfterDays: integer("final_notice_after_days").default(30).notNull(),
    cancellationWarningAfterDays: integer("cancellation_warning_after_days")
      .default(60)
      .notNull(),

    /**
     * ⚠️ THE MINIMUM GAP BETWEEN TWO RUNGS, WHATEVER THE DAY THRESHOLDS
     * SAY. A demand raised late, or a policy edited mid-chase, can put two
     * thresholds in the past at once; without this the ladder is climbed
     * in a single sweep and the buyer receives a first notice and a final
     * notice in the same minute.
     */
    minGapDays: integer("min_gap_days").default(7).notNull(),

    /**
     * Send the reminder before the due date instead of after it.
     * Stored as a positive number of days; 0 disables the pre-reminder.
     */
    preDueReminderDays: integer("pre_due_reminder_days").default(0).notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("dunning_policies_tenant_idx").on(t.tenantId, t.isActive),
    projectIdx: index("dunning_policies_project_idx").on(t.tenantId, t.projectId),

    ladderAscends: check(
      "dunning_policies_ladder_ascends",
      sql`${t.reminderAfterDays} < ${t.firstNoticeAfterDays}
          AND ${t.firstNoticeAfterDays} < ${t.finalNoticeAfterDays}
          AND ${t.finalNoticeAfterDays} < ${t.cancellationWarningAfterDays}`,
    ),
    daysSane: check(
      "dunning_policies_days_sane",
      sql`${t.reminderAfterDays} >= 0 AND ${t.cancellationWarningAfterDays} <= 3650
          AND ${t.minGapDays} >= 0 AND ${t.minGapDays} <= 365
          AND ${t.preDueReminderDays} >= 0 AND ${t.preDueReminderDays} <= 90`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* DEMAND NOTICES                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE LEGAL DOCUMENT.
 *
 * Raised AGAINST a `payment_milestones` row — Phase 22's construction-
 * linked plan — when that milestone's trigger is achieved. It is not a
 * second copy of the milestone: the milestone says what was AGREED, the
 * demand says what was ASKED FOR, on what date, on what evidence, with
 * what tax and on what interest terms. The two diverge the first time a
 * demand is raised for part of a milestone, or superseded, or raised at a
 * tax rate that changed after the agreement was signed.
 *
 * ⚠️ ONE LIVE DEMAND PER MILESTONE. SQL 0027 §2 enforces it with a
 * partial unique index. Two live demands for the third slab is two
 * documents in a buyer's hands asking for the same money — they pay one,
 * the other ages into the 90+ bucket, and the ladder starts climbing
 * against somebody who has paid.
 */
export const demandNotices = pgTable(
  "demand_notices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⭐ THE NUMBER SERIES. Human-facing, unique per workspace, quoted on
     * the payment and in every later letter — "your demand AH/DN/2026/0041"
     * is what a buyer's bank reference says.
     */
    noticeNumber: varchar("notice_number", { length: 40 }).notNull(),

    bookingId: uuid("booking_id").notNull(),
    /**
     * ⚠️ NOT NULLABLE. A demand is raised against a milestone, full stop —
     * that is what makes it a construction-linked demand rather than an
     * invoice. Ad-hoc charges (maintenance, a transfer fee) are invoices
     * under Phase 32 and do not belong in this register, because the
     * ageing, the ladder and the forfeiture chain all assume a milestone.
     */
    milestoneId: uuid("milestone_id").notNull(),
    /** Denormalised for the per-project ageing report. */
    projectId: uuid("project_id"),
    /** The buyer, for language and service address. */
    leadId: uuid("lead_id"),

    status: demandStatusEnum("status").default("draft").notNull(),

    /* --- ⭐ WHAT TRIGGERED IT (RERA) ------------------------------- */
    //
    // ⚠️ ALL THREE ARE NOT NULL AND THAT IS THE POINT OF THE TABLE. A
    // demand that cannot say what fell due, and when it was achieved, is
    // a demand that cannot be defended — and the day it needs defending
    // is years after the person who raised it left.
    triggerKind: demandTriggerKindEnum("trigger_kind").notNull(),
    /** "On completion of the 3rd slab" — the milestone's own words. */
    triggerLabel: varchar("trigger_label", { length: 255 }).notNull(),
    /** The civil day the event was achieved. Never the day it was billed. */
    triggerAchievedOn: date("trigger_achieved_on", { mode: "string" }).notNull(),
    /**
     * The engineer's certificate, the RERA quarterly update, the
     * photograph reference. Free text because it is a citation, not a
     * foreign key — most of it lives on paper or in the QPR PDF.
     */
    triggerEvidence: text("trigger_evidence"),

    /* --- Dates ----------------------------------------------------- */
    noticeDate: date("notice_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),

    /* --- Money ----------------------------------------------------- */
    /** The milestone amount being demanded, before tax. Paise. */
    principalMinor: bigint("principal_minor", { mode: "bigint" }).notNull(),
    gstRateBps: integer("gst_rate_bps").default(0).notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    taxMinor: bigint("tax_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** principal + tax. The figure on the face of the notice. */
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),

    /* --- ⭐ INTEREST TERMS, FROZEN ON TO THE DOCUMENT -------------- */
    interestRateBps: integer("interest_rate_bps").default(0).notNull(),
    referenceRateBps: integer("reference_rate_bps").default(0).notNull(),
    /** ⭐ Computed at issue. See the file header on Section 2(za). */
    rateExceedsReference: boolean("rate_exceeds_reference").default(false).notNull(),
    compounding: interestCompoundingEnum("compounding").default("simple").notNull(),
    dayCount: interestDayCountEnum("day_count").default("actual_365").notNull(),
    graceDays: integer("grace_days").default(0).notNull(),
    /**
     * ⚠️ NOT NULL, AND IT IS THE SENTENCE THAT GOES ON THE NOTICE.
     * "Interest at 18% per annum, simple, on the outstanding principal
     * from 15 May 2026 (7 days' grace)". Generated from the columns above
     * by `lib/receivables/interest.ts`, in the notice's language, so it
     * cannot drift from the arithmetic it describes.
     */
    interestBasisNote: text("interest_basis_note").notNull(),

    /* --- What has been received ------------------------------------ */
    //
    // ⚠️ DERIVED AND STORED, WITH THE DATABASE HOLDING THE TWO IN STEP.
    // The list page and the ageing report read these; SQL 0027 §5 refuses
    // any value that disagrees with the allocation rows.
    allocatedMinor: bigint("allocated_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    interestPaidMinor: bigint("interest_paid_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /* --- Service and language -------------------------------------- */
    language: noticeLanguageEnum("language").default("en").notNull(),

    /* --- The ladder ------------------------------------------------ */
    /** The highest rung sent. NULL until the first one goes out. */
    dunningStage: dunningStageEnum("dunning_stage"),
    lastDunnedAt: timestamp("last_dunned_at", { withTimezone: true }),

    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /** The demand that replaced this one. */
    supersededById: uuid("superseded_by_id"),

    notes: text("notes"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    numberPerTenant: uniqueIndex("demand_notices_number_tenant_unique").on(
      t.tenantId,
      t.noticeNumber,
    ),
    tenantIdx: index("demand_notices_tenant_idx").on(t.tenantId, t.status),
    bookingIdx: index("demand_notices_booking_idx").on(t.tenantId, t.bookingId),
    milestoneIdx: index("demand_notices_milestone_idx").on(t.tenantId, t.milestoneId),
    /** Drives the ageing report and the dunning sweep. */
    dueIdx: index("demand_notices_due_idx").on(t.tenantId, t.dueDate, t.status),
    projectIdx: index("demand_notices_project_idx").on(t.tenantId, t.projectId),
    ladderIdx: index("demand_notices_ladder_idx").on(t.tenantId, t.dunningStage),

    principalPositive: check(
      "demand_notices_principal_positive",
      sql`${t.principalMinor} > 0`,
    ),
    /**
     * ⭐ THE FACE OF THE NOTICE MUST ADD UP. A total that is not principal
     * plus tax is a document whose own arithmetic fails in front of the
     * person paying it.
     */
    totalsBalance: check(
      "demand_notices_totals_balance",
      sql`${t.taxMinor} = ${t.cgstMinor} + ${t.sgstMinor} + ${t.igstMinor} + ${t.cessMinor}
          AND ${t.totalMinor} = ${t.principalMinor} + ${t.taxMinor}`,
    ),
    /**
     * ⚠️ CGST/SGST AND IGST ARE MUTUALLY EXCLUSIVE. A demand carrying both
     * has been taxed twice for one supply, and the buyer pays it because
     * the total still adds up.
     */
    taxKindIsSingular: check(
      "demand_notices_tax_kind_is_singular",
      sql`(${t.igstMinor} = 0) OR (${t.cgstMinor} = 0 AND ${t.sgstMinor} = 0)`,
    ),
    amountsNonNegative: check(
      "demand_notices_amounts_non_negative",
      sql`${t.cgstMinor} >= 0 AND ${t.sgstMinor} >= 0 AND ${t.igstMinor} >= 0
          AND ${t.cessMinor} >= 0 AND ${t.taxMinor} >= 0 AND ${t.totalMinor} >= 0
          AND ${t.allocatedMinor} >= 0 AND ${t.interestPaidMinor} >= 0`,
    ),
    /**
     * ⭐⭐ A DEMAND MAY NOT BE OVER-APPLIED. An over-payment is a CREDIT on
     * the buyer's account, not a negative balance on a document — the
     * moment a demand can go past its own total, the statement of account
     * stops footing and no report anywhere shows why.
     */
    notOverApplied: check(
      "demand_notices_not_over_applied",
      sql`${t.allocatedMinor} <= ${t.totalMinor}`,
    ),
    ratesSane: check(
      "demand_notices_rates_sane",
      sql`${t.interestRateBps} >= 0 AND ${t.interestRateBps} <= 10000
          AND ${t.referenceRateBps} >= 0 AND ${t.referenceRateBps} <= 10000
          AND ${t.gstRateBps} >= 0 AND ${t.gstRateBps} <= 10000
          AND ${t.graceDays} >= 0 AND ${t.graceDays} <= 365`,
    ),
    dueAfterNotice: check(
      "demand_notices_due_after_notice",
      sql`${t.dueDate} >= ${t.noticeDate}`,
    ),
    /** ⚠️ A demand that has left the building must say when it did. */
    issuedIsDated: check(
      "demand_notices_issued_is_dated",
      sql`${t.status} = 'draft' OR ${t.status} = 'cancelled' OR ${t.issuedAt} IS NOT NULL`,
    ),
    cancelHasReason: check(
      "demand_notices_cancel_has_reason",
      sql`${t.status} <> 'cancelled' OR ${t.cancelReason} IS NOT NULL`,
    ),
    /** A superseded demand must name its replacement, or it is just lost. */
    supersededNamesSuccessor: check(
      "demand_notices_superseded_names_successor",
      sql`${t.status} <> 'superseded' OR ${t.supersededById} IS NOT NULL`,
    ),
    /**
     * ⚠️ AN UNSERVED DEMAND CANNOT HAVE BEEN CHASED. A ladder rung against
     * a draft is a letter about a document the buyer never received.
     */
    ladderFollowsIssue: check(
      "demand_notices_ladder_follows_issue",
      sql`${t.dunningStage} IS NULL OR ${t.issuedAt} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* THE RENDERED NOTICE                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT WE ACTUALLY SENT, IN THE LANGUAGE WE ACTUALLY SENT IT IN.
 *
 * A template is code and code is deployed. The document a buyer holds was
 * produced by whatever the template said on the day — and "what did your
 * notice actually say?" is the first question in every dispute, asked
 * about a notice sent two releases ago.
 *
 * So the rendered body is STORED, with a hash, per language. Re-rendering
 * from the template later would answer a question about today's code
 * rather than about the document in the buyer's hand.
 *
 * ⚠️ `words_language` IS SEPARATE FROM `language` DELIBERATELY. A Tamil
 * notice whose amount-in-words we cannot produce correctly in Tamil
 * carries English digits, and the row has to say so — see
 * `lib/receivables/templates/index.ts`. A wrong amount in words on a
 * legal notice is worse than an untranslated one, and a column that
 * cannot express "we fell back" is a column that hides it.
 */
export const demandNoticeDocuments = pgTable(
  "demand_notice_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    demandId: uuid("demand_id").notNull(),

    language: noticeLanguageEnum("language").notNull(),
    templateKey: varchar("template_key", { length: 60 }).notNull(),
    templateVersion: varchar("template_version", { length: 20 }).notNull(),

    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** sha-256 of the body, lower-case hex. The bytes are the evidence. */
    bodyHash: varchar("body_hash", { length: 64 }).notNull(),

    /** "Rupees Five Lakh Only" — or the digits, when we cannot say it. */
    amountInWords: text("amount_in_words").notNull(),
    /** ⚠️ Which language those words are REALLY in. */
    wordsLanguage: noticeLanguageEnum("words_language").notNull(),
    /** True when the words fell back to English digits. Reportable. */
    wordsFellBack: boolean("words_fell_back").default(false).notNull(),

    renderedAt: timestamp("rendered_at", { withTimezone: true }).defaultNow().notNull(),
    renderedBy: uuid("rendered_by"),
  },
  (t) => ({
    /**
     * ⚠️ KEYED ON THE TEMPLATE AS WELL AS THE LANGUAGE, AND THE FIRST
     * DRAFT WAS NOT.
     *
     * A demand produces FIVE documents in a language over its life — the
     * notice itself and the four rungs of the ladder. Keyed on (demand,
     * language) alone, the first notice silently fails to store because
     * the demand notice is already there in that language, and the answer
     * to "what did the final notice actually say?" is missing for exactly
     * the letters that end up in front of an Authority.
     */
    demandDocumentUnique: uniqueIndex("demand_notice_documents_demand_doc_unique").on(
      t.tenantId,
      t.demandId,
      t.language,
      t.templateKey,
    ),
    tenantIdx: index("demand_notice_documents_tenant_idx").on(t.tenantId),
    demandIdx: index("demand_notice_documents_demand_idx").on(t.tenantId, t.demandId),

    hashShape: check(
      "demand_notice_documents_hash_shape",
      sql`${t.bodyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    bodyNotBlank: check(
      "demand_notice_documents_body_not_blank",
      sql`btrim(${t.body}) <> ''`,
    ),
    /**
     * ⚠️ A FALLBACK MUST SAY IT FELL BACK TO SOMETHING ELSE. `wordsFellBack`
     * with `words_language` still equal to the document's language is a row
     * claiming both things at once, which is how the fallback stops being
     * reportable.
     */
    fallbackIsHonest: check(
      "demand_notice_documents_fallback_is_honest",
      sql`(NOT ${t.wordsFellBack}) OR ${t.wordsLanguage} <> ${t.language}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* THE DUNNING LADDER                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ WHAT WAS SENT, WHEN, THROUGH WHAT CHANNEL, AND ON WHOSE AUTHORITY.
 *
 * Append-only in practice (no DELETE grant): this table IS the evidence
 * that the buyer was given every chance before the allotment was
 * threatened. A gap in it is a gap in the developer's case.
 */
export const dunningEvents = pgTable(
  "dunning_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    demandId: uuid("demand_id").notNull(),

    stage: dunningStageEnum("stage").notNull(),
    /**
     * ⭐ 1..4, MATCHING THE STAGE. Redundant with `stage` on purpose: the
     * no-skip trigger in SQL 0027 §6 compares integers, and a CHECK keeps
     * the integer and the enum from ever disagreeing. Comparing enum
     * labels by name is how a reordered enum silently reorders a legal
     * process.
     */
    rung: integer("rung").notNull(),

    channel: dunningChannelEnum("channel").notNull(),
    language: noticeLanguageEnum("language").default("en").notNull(),
    /** The address, number or handle it went to. Service evidence. */
    recipient: varchar("recipient", { length: 320 }),

    /**
     * 🔴🔴 LEGACY AND FROZEN. DO NOT READ THIS AS EVIDENCE OF ANYTHING.
     *
     * Until SQL 0098 this was `NOT NULL DEFAULT now()` — it was populated
     * BY THE ACT OF INSERTING THE ROW, in a table whose whole purpose is
     * to prove the buyer was given every chance. Nothing sent anything.
     * On every pre-0098 row it records a person pressing a button.
     *
     * ⚠️ 0098 dropped the default and the NOT NULL, and added
     * `dunning_events_sent_at_is_not_a_claim` — a CHECK that refuses a
     * `sent_at` on any row still graded `none`. Since `none` is what
     * every INSERT gets, creating a notice can no longer assert a send.
     * Use `dispatchedAt`, `servedAt` and `serviceEvidence`.
     */
    sentAt: timestamp("sent_at", { withTimezone: true }),

    /* ---- ⭐⭐ THE THREE FACTS, SEPARATED BY 0098 ------------------ */

    /**
     * ① RAISED. A person at the developer decided to demand. True of
     * every row that exists — which is exactly why it is not evidence of
     * service and must not sit in the same column as one.
     *
     * ⚠️ Nullable only for legacy rows; a CHECK requires it on the rest.
     * A NOT NULL DEFAULT now() would have stamped migration day onto
     * notices raised two years ago.
     */
    raisedAt: timestamp("raised_at", { withTimezone: true }),

    /**
     * ② DISPATCHED. It left our system and the provider acknowledged it.
     *
     * 🔴 WRITTEN ONLY BY `server/email/outbox.ts`, NEVER BY A FORM. It
     * cannot exist without `dispatchProviderMessageId` (CHECK), and that
     * id can only come back from Resend — so no human interface can
     * reach this state however the UI is wired.
     */
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchProviderMessageId: varchar("dispatch_provider_message_id", { length: 200 }),
    /** Which outbox row is carrying it. Null for post and hand delivery. */
    dispatchOutboxId: uuid("dispatch_outbox_id"),
    /**
     * ⚠️ A DEAD LETTER IS A FACT, AND IT IS THE ONE NOBODY LOOKS FOR. A
     * notice whose address hard-bounced is not "pending" — it is NOT
     * SERVED, and the person about to cancel an allotment needs the
     * reason in words rather than an absence.
     */
    dispatchFailedAt: timestamp("dispatch_failed_at", { withTimezone: true }),
    dispatchFailureReason: varchar("dispatch_failure_reason", { length: 500 }),

    /** ③ SERVED. It reached the allottee, or is deemed to have. */
    servedAt: timestamp("served_at", { withTimezone: true }),

    /**
     * 🔴 WHICH KIND OF CLAIM THIS ROW IS. See
     * `lib/receivables/service-evidence.ts` for the grades and what each
     * one may be relied on for.
     *
     * ⭐ DEFAULTS TO `none` — raised, and nothing more. Every existing
     * row was filled with `legacy_unverified` by the ADD COLUMN itself,
     * which is how 0098 marks three years of history without an UPDATE
     * and without inventing a single dispatch.
     */
    serviceEvidence: varchar("service_evidence", { length: 24 })
      .$type<ServiceEvidenceGrade>()
      .default("none")
      .notNull(),

    /**
     * ⚠️ POST AND HAND DELIVERY ARE REAL AND MUST BE RECORDABLE — most
     * builder-buyer agreements name registered post to the address in the
     * agreement as the mode of valid service, and an unopened email is
     * not service. So a human may record them, but only as a NAMED person
     * with a reference somebody can look up, and never as a dispatch.
     */
    serviceRecordedBy: uuid("service_recorded_by"),
    serviceRecordedAt: timestamp("service_recorded_at", { withTimezone: true }),
    /** Speed post / RPAD consignment or courier AWB. Required by CHECK. */
    serviceReference: varchar("service_reference", { length: 120 }),

    /** Days past due at the moment it was sent. Frozen; never recomputed. */
    daysOverdue: integer("days_overdue").notNull(),
    outstandingMinor: bigint("outstanding_minor", { mode: "bigint" }).notNull(),
    interestMinor: bigint("interest_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⚠️ NOT NULL FOR `cancellation_warning`, ENFORCED BY CHECK.
     *
     * Everything below that rung may be swept by a scheduled job.
     * Threatening to terminate an allotment and forfeit somebody's money
     * may not be, ever — and "the system sent it automatically" is not an
     * answer anybody can give at a hearing.
     */
    authorisedBy: uuid("authorised_by"),
    authorisedReason: text("authorised_reason"),

    documentId: uuid("document_id"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    demandIdx: index("dunning_events_demand_idx").on(t.tenantId, t.demandId, t.rung),
    tenantIdx: index("dunning_events_tenant_idx").on(t.tenantId, t.sentAt),
    stageIdx: index("dunning_events_stage_idx").on(t.tenantId, t.stage),
    /** ⭐ One rung is sent once per demand. A second copy is a re-send. */
    rungOnce: uniqueIndex("dunning_events_rung_once").on(
      t.tenantId,
      t.demandId,
      t.stage,
    ),

    rungMatchesStage: check(
      "dunning_events_rung_matches_stage",
      sql`(${t.stage} = 'reminder' AND ${t.rung} = 1)
          OR (${t.stage} = 'first_notice' AND ${t.rung} = 2)
          OR (${t.stage} = 'final_notice' AND ${t.rung} = 3)
          OR (${t.stage} = 'cancellation_warning' AND ${t.rung} = 4)`,
    ),
    /** ⭐⭐ The rung that may never be automatic. */
    cancellationIsAuthorised: check(
      "dunning_events_cancellation_is_authorised",
      sql`${t.stage} <> 'cancellation_warning'
          OR (${t.authorisedBy} IS NOT NULL AND btrim(coalesce(${t.authorisedReason}, '')) <> '')`,
    ),
    amountsSane: check(
      "dunning_events_amounts_sane",
      sql`${t.outstandingMinor} >= 0 AND ${t.interestMinor} >= 0`,
    ),

    /* ---- 🔴🔴 0098 · THREE FACTS, ENFORCED ----------------------- */

    evidenceKnown: check(
      "dunning_events_service_evidence_known",
      sql`${t.serviceEvidence} IN ('none','system_dispatch','human_recorded','deemed','legacy_unverified')`,
    ),

    /**
     * 🔴🔴 THE ONE THAT KILLS THE OLD BEHAVIOUR. Every INSERT gets
     * `service_evidence = 'none'` from the column default, so a row
     * cannot be born carrying a send timestamp. Asserting a send now
     * needs a second statement with something to show for itself.
     */
    sentAtIsNotAClaim: check(
      "dunning_events_sent_at_is_not_a_claim",
      sql`${t.sentAt} IS NULL OR ${t.serviceEvidence} <> 'none'`,
    ),
    /** Dispatch and its proof are one fact; neither may exist alone. */
    dispatchNeedsProof: check(
      "dunning_events_dispatch_needs_proof",
      sql`(${t.dispatchedAt} IS NULL AND ${t.dispatchProviderMessageId} IS NULL)
          OR (${t.dispatchedAt} IS NOT NULL AND ${t.dispatchProviderMessageId} IS NOT NULL)`,
    ),
    /** ⚠️ A posted letter can never wear the machine's badge. */
    systemDispatchIsMachineOnly: check(
      "dunning_events_system_dispatch_is_machine_only",
      sql`${t.serviceEvidence} <> 'system_dispatch'
          OR (${t.dispatchedAt} IS NOT NULL AND ${t.channel} IN ('email','whatsapp'))`,
    ),
    humanRecordIsNotADispatch: check(
      "dunning_events_human_record_is_not_a_dispatch",
      sql`${t.serviceEvidence} NOT IN ('human_recorded','deemed') OR ${t.dispatchedAt} IS NULL`,
    ),
    humanRecordNamesAPerson: check(
      "dunning_events_human_record_names_a_person",
      sql`${t.serviceEvidence} <> 'human_recorded'
          OR (${t.serviceRecordedBy} IS NOT NULL
              AND ${t.serviceRecordedAt} IS NOT NULL
              AND btrim(coalesce(${t.serviceReference}, '')) <> '')`,
    ),
    servedNeedsEvidence: check(
      "dunning_events_served_needs_evidence",
      sql`${t.servedAt} IS NULL OR ${t.serviceEvidence} <> 'none'`,
    ),
    raisedAtPresent: check(
      "dunning_events_raised_at_present",
      sql`${t.raisedAt} IS NOT NULL OR ${t.serviceEvidence} = 'legacy_unverified'`,
    ),
    /** 🔴 A legacy row can never be promoted into evidence it never had. */
    legacyIsNeverPromoted: check(
      "dunning_events_legacy_is_never_promoted",
      sql`${t.serviceEvidence} <> 'legacy_unverified'
          OR (${t.dispatchedAt} IS NULL
              AND ${t.dispatchProviderMessageId} IS NULL
              AND ${t.servedAt} IS NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RECEIPTS                                                            */
/* ------------------------------------------------------------------ */

/**
 * Money received against a booking.
 *
 * ⭐ NOT AGAINST A DEMAND. A buyer transfers ₹5,00,000; which demands it
 * settles is a decision made afterwards, sometimes by them (Section 59 of
 * the Contract Act) and sometimes by us (Section 60). Tying the receipt
 * to one demand at the point of receipt would make the common case — one
 * transfer clearing two and a half demands — unrecordable.
 *
 * ⚠️ `tds_credit_minor` IS NOT DECORATION, AND WITHOUT IT EVERY DEMAND ON
 * A RESALE-VALUE FLAT IS PERMANENTLY SHORT.
 *
 * Section 194-IA makes the BUYER deduct 1% of the consideration on any
 * property over ₹50 lakh and pay it to the Government on the developer's
 * behalf. So a ₹10,00,000 demand is settled by ₹9,90,000 in the bank plus
 * ₹10,000 the developer will claim in their own return. Counting only
 * what arrived leaves 1% outstanding on every single demand, ages into
 * the buckets, and starts a dunning ladder against a buyer who paid in
 * full and did exactly what the law told them to.
 */
export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    receiptNumber: varchar("receipt_number", { length: 40 }).notNull(),
    bookingId: uuid("booking_id").notNull(),
    projectId: uuid("project_id"),
    leadId: uuid("lead_id"),

    receivedOn: date("received_on", { mode: "string" }).notNull(),
    /** What actually arrived. Paise. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    /** ⭐ Section 194-IA tax the buyer withheld. Settles the demand too. */
    tdsCreditMinor: bigint("tds_credit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** Sum of the allocation rows. Held in step by SQL 0027 §5. */
    allocatedMinor: bigint("allocated_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    method: receiptMethodEnum("method").notNull(),
    status: receiptStatusEnum("status").default("cleared").notNull(),
    allocationStrategy: allocationStrategyEnum("allocation_strategy")
      .default("oldest_first")
      .notNull(),
    appropriationOrder: appropriationOrderEnum("appropriation_order")
      .default("interest_first")
      .notNull(),

    /** Cheque number, UTR, UPI reference. What the buyer will quote. */
    instrumentRef: varchar("instrument_ref", { length: 120 }),
    bankRef: varchar("bank_ref", { length: 120 }),
    clearedOn: date("cleared_on", { mode: "string" }),
    bouncedOn: date("bounced_on", { mode: "string" }),
    bounceReason: text("bounce_reason"),

    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    numberPerTenant: uniqueIndex("receipts_number_tenant_unique").on(
      t.tenantId,
      t.receiptNumber,
    ),
    tenantIdx: index("receipts_tenant_idx").on(t.tenantId, t.receivedOn),
    bookingIdx: index("receipts_booking_idx").on(t.tenantId, t.bookingId),
    statusIdx: index("receipts_status_idx").on(t.tenantId, t.status),
    /**
     * ⭐ Finds unapplied credit — money sitting on a buyer's account with
     * no demand to answer. `allocated_minor` is in the index so the
     * "credit outstanding" query is answered from it rather than by
     * reading every receipt a project has ever taken.
     */
    creditIdx: index("receipts_credit_idx").on(
      t.tenantId,
      t.bookingId,
      t.allocatedMinor,
    ),

    amountPositive: check("receipts_amount_positive", sql`${t.amountMinor} > 0`),
    amountsNonNegative: check(
      "receipts_amounts_non_negative",
      sql`${t.tdsCreditMinor} >= 0 AND ${t.allocatedMinor} >= 0`,
    ),
    /**
     * ⭐⭐ A RECEIPT MAY NOT APPLY MORE THAN IT IS WORTH. The excess is a
     * credit — a real thing with a real balance — and the instant this
     * check is absent the credit becomes an over-application spread
     * silently across demands nobody chose.
     */
    notOverApplied: check(
      "receipts_not_over_applied",
      sql`${t.allocatedMinor} <= ${t.amountMinor} + ${t.tdsCreditMinor}`,
    ),
    /** ⚠️ A returned cheque was never money. It cannot still be applied. */
    bouncedIsReleased: check(
      "receipts_bounced_is_released",
      sql`${t.status} <> 'bounced' OR ${t.allocatedMinor} = 0`,
    ),
    bouncedIsDated: check(
      "receipts_bounced_is_dated",
      sql`${t.status} <> 'bounced' OR ${t.bouncedOn} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ALLOCATIONS                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ WHERE THE MONEY WENT, TO THE PAISA, WITH A SENTENCE.
 *
 * One row per (receipt, demand). The three legs are separate because they
 * are three different things to three different readers:
 *
 *   principal — reduces what the buyer owes on the flat.
 *   tax       — is the GST already charged on that demand, and is what
 *               the developer must account for in a return.
 *   interest  — is income, and is the leg a buyer will dispute.
 *
 * A single `amount_minor` would make the statement of account impossible
 * to produce and the GST position impossible to reconcile.
 *
 * ⚠️ `explanation` IS NOT NULL AND IS NOT A NOTE. It is the line the
 * buyer is shown: "₹1,20,000 of receipt RCP/2026/0088 applied to demand
 * AH/DN/2026/0041 (oldest first; interest before principal)". The whole
 * requirement of this phase is that a split can be EXPLAINED, and an
 * explanation generated later from columns is an explanation that changes
 * when the code does.
 */
export const receiptAllocations = pgTable(
  "receipt_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    receiptId: uuid("receipt_id").notNull(),
    demandId: uuid("demand_id").notNull(),

    /** The order this allocation was applied in. 1-based. */
    sequence: integer("sequence").notNull(),

    principalMinor: bigint("principal_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxMinor: bigint("tax_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    interestMinor: bigint("interest_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** principal + tax + interest. Enforced. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    basis: allocationStrategyEnum("basis").notNull(),
    appropriationOrder: appropriationOrderEnum("appropriation_order")
      .default("interest_first")
      .notNull(),
    explanation: text("explanation").notNull(),

    allocatedAt: timestamp("allocated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    allocatedBy: uuid("allocated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** ⭐ One receipt touches one demand once. Two rows would double-count. */
    oncePerPair: uniqueIndex("receipt_allocations_pair_unique").on(
      t.tenantId,
      t.receiptId,
      t.demandId,
    ),
    receiptIdx: index("receipt_allocations_receipt_idx").on(
      t.tenantId,
      t.receiptId,
      t.sequence,
    ),
    demandIdx: index("receipt_allocations_demand_idx").on(t.tenantId, t.demandId),

    legsBalance: check(
      "receipt_allocations_legs_balance",
      sql`${t.amountMinor} = ${t.principalMinor} + ${t.taxMinor} + ${t.interestMinor}`,
    ),
    /**
     * ⚠️ POSITIVE, NOT NON-NEGATIVE. A zero allocation is a row saying
     * "some of this receipt went to that demand" about no money — it
     * appears on the buyer's statement, foots to nothing, and is
     * indistinguishable from a bug that dropped a leg.
     */
    amountPositive: check(
      "receipt_allocations_amount_positive",
      sql`${t.amountMinor} > 0 AND ${t.principalMinor} >= 0
          AND ${t.taxMinor} >= 0 AND ${t.interestMinor} >= 0`,
    ),
    sequencePositive: check(
      "receipt_allocations_sequence_positive",
      sql`${t.sequence} >= 1`,
    ),
    explanationNotBlank: check(
      "receipt_allocations_explanation_not_blank",
      sql`btrim(${t.explanation}) <> ''`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const receivablePoliciesRelations = relations(receivablePolicies, ({ one }) => ({
  tenant: one(tenants, {
    fields: [receivablePolicies.tenantId],
    references: [tenants.id],
  }),
  project: one(projects, {
    fields: [receivablePolicies.projectId],
    references: [projects.id],
  }),
}));

export const dunningPoliciesRelations = relations(dunningPolicies, ({ one }) => ({
  tenant: one(tenants, { fields: [dunningPolicies.tenantId], references: [tenants.id] }),
  project: one(projects, {
    fields: [dunningPolicies.projectId],
    references: [projects.id],
  }),
}));

export const demandNoticesRelations = relations(demandNotices, ({ one, many }) => ({
  tenant: one(tenants, { fields: [demandNotices.tenantId], references: [tenants.id] }),
  booking: one(bookings, {
    fields: [demandNotices.bookingId],
    references: [bookings.id],
  }),
  milestone: one(paymentMilestones, {
    fields: [demandNotices.milestoneId],
    references: [paymentMilestones.id],
  }),
  project: one(projects, {
    fields: [demandNotices.projectId],
    references: [projects.id],
  }),
  lead: one(leads, { fields: [demandNotices.leadId], references: [leads.id] }),
  issuer: one(users, { fields: [demandNotices.issuedBy], references: [users.id] }),
  documents: many(demandNoticeDocuments),
  dunning: many(dunningEvents),
  allocations: many(receiptAllocations),
}));

export const demandNoticeDocumentsRelations = relations(
  demandNoticeDocuments,
  ({ one }) => ({
    demand: one(demandNotices, {
      fields: [demandNoticeDocuments.demandId],
      references: [demandNotices.id],
    }),
  }),
);

export const dunningEventsRelations = relations(dunningEvents, ({ one }) => ({
  demand: one(demandNotices, {
    fields: [dunningEvents.demandId],
    references: [demandNotices.id],
  }),
  document: one(demandNoticeDocuments, {
    fields: [dunningEvents.documentId],
    references: [demandNoticeDocuments.id],
  }),
}));

export const receiptsRelations = relations(receipts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [receipts.tenantId], references: [tenants.id] }),
  booking: one(bookings, { fields: [receipts.bookingId], references: [bookings.id] }),
  lead: one(leads, { fields: [receipts.leadId], references: [leads.id] }),
  allocations: many(receiptAllocations),
}));

export const receiptAllocationsRelations = relations(receiptAllocations, ({ one }) => ({
  receipt: one(receipts, {
    fields: [receiptAllocations.receiptId],
    references: [receipts.id],
  }),
  demand: one(demandNotices, {
    fields: [receiptAllocations.demandId],
    references: [demandNotices.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type ReceivablePolicy = typeof receivablePolicies.$inferSelect;
export type NewReceivablePolicy = typeof receivablePolicies.$inferInsert;
export type DunningPolicy = typeof dunningPolicies.$inferSelect;
export type NewDunningPolicy = typeof dunningPolicies.$inferInsert;
export type DemandNotice = typeof demandNotices.$inferSelect;
export type NewDemandNotice = typeof demandNotices.$inferInsert;
export type DemandNoticeDocument = typeof demandNoticeDocuments.$inferSelect;
export type NewDemandNoticeDocument = typeof demandNoticeDocuments.$inferInsert;
export type DunningEvent = typeof dunningEvents.$inferSelect;
export type NewDunningEvent = typeof dunningEvents.$inferInsert;
export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;
export type ReceiptAllocation = typeof receiptAllocations.$inferSelect;
export type NewReceiptAllocation = typeof receiptAllocations.$inferInsert;

export type DemandStatus = (typeof demandStatusEnum.enumValues)[number];
export type DemandTriggerKind = (typeof demandTriggerKindEnum.enumValues)[number];
export type NoticeLanguage = (typeof noticeLanguageEnum.enumValues)[number];
export type InterestCompounding = (typeof interestCompoundingEnum.enumValues)[number];
export type InterestDayCount = (typeof interestDayCountEnum.enumValues)[number];
export type AppropriationOrder = (typeof appropriationOrderEnum.enumValues)[number];
export type AllocationStrategy = (typeof allocationStrategyEnum.enumValues)[number];
export type DunningStage = (typeof dunningStageEnum.enumValues)[number];
export type DunningChannel = (typeof dunningChannelEnum.enumValues)[number];
export type ReceiptMethod = (typeof receiptMethodEnum.enumValues)[number];
export type ReceiptStatus = (typeof receiptStatusEnum.enumValues)[number];
