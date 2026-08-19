/**
 * Ordence — ⭐⭐⭐ PAYROLL
 * Version: v1.23.0-alpha · Batch 15
 *
 * Mirrors `SQL-FILES/0075_payroll.sql`. The reasoning lives in both.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS DELIBERATELY DOES NOT STORE
 * ══════════════════════════════════════════════════════════════════════
 * NO AADHAAR. NO BANK ACCOUNT NUMBER. NO DATE OF BIRTH. NO MEDICAL,
 * MARITAL OR COMMUNITY DATA.
 *
 * ⚠️ THE BANK ACCOUNT IS THE ONE THAT NEEDS EXPLAINING, because a
 * payroll system that cannot pay anybody sounds broken. It is not an
 * oversight — Ordence ACCRUES payroll and does not disburse it. The
 * ledger records what is owed to employees; the transfer is made in the
 * bank's own portal and cleared here as a payment.
 *
 * 🔴 A BANK ACCOUNT NUMBER IN THIS TABLE WOULD BE A CREDENTIAL SITTING
 * IN A ROW EVERY SUPPORT SESSION CAN READ. When Ordence generates NEFT
 * advice files it will read them from `vault_secrets`, which exists and
 * is encrypted, and it will be a separate batch with its own argument.
 * Until then the honest answer is that the data is not here.
 *
 * ⭐ PAN IS STORED, because section 192 cannot be operated without it,
 * and its absence is a REFUSAL to compute rather than a silent 20%.
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
  jsonb,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { transactions } from "./accounting";

export const payrollRunStatusEnum = pgEnum("payroll_run_status", [
  /** Created, employees selected, nothing calculated. */
  "draft",
  /** Payslips exist. Still editable by recomputing. */
  "computed",
  /** ⭐ Signed off. Payslips frozen. Ready to post. */
  "approved",
  /** Journal written. Terminal. */
  "posted",
  /** Abandoned, with a reason. Never deleted. */
  "cancelled",
]);

export const taxRegimeEnum = pgEnum("tax_regime", ["new", "old"]);

/* ------------------------------------------------------------------ */
/* ① EMPLOYEES                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ SEPARATE FROM `users` AND FROM `site_workers`, AND BOTH SEPARATIONS
 * ARE LOAD-BEARING.
 *
 * `users` are people who can sign in. Most employees on a payroll never
 * will, and half the people who sign in are not on the payroll.
 *
 * `site_workers` are contract labour brought by a vendor, paid through
 * that vendor's RA bill. They are on nobody's payroll and giving them
 * payslips would misstate the employment relationship in a way a labour
 * inspector cares about.
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    employeeCode: varchar("employee_code", { length: 40 }).notNull(),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    designation: varchar("designation", { length: 120 }),
    department: varchar("department", { length: 120 }),

    /** ⭐ Optional link to a sign-in account. Most employees have none. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * 🔴 THE STATE THE EMPLOYEE WORKS IN, WHICH DRIVES PROFESSIONAL TAX.
     * Not the state the company is registered in. A Bengaluru company
     * with three people in Mumbai owes Maharashtra PT for those three.
     */
    workStateCode: varchar("work_state_code", { length: 2 }).notNull(),

    joinedOn: date("joined_on").notNull(),
    /** Null while employed. Set on exit; payroll stops after it. */
    leftOn: date("left_on"),

    /** ⚠️ Needed for section 192. Its ABSENCE refuses tax, never guesses. */
    pan: varchar("pan", { length: 10 }),
    uan: varchar("uan", { length: 12 }),
    esicNumber: varchar("esic_number", { length: 17 }),

    pfExempt: boolean("pf_exempt").default(false).notNull(),
    /** The employer's choice to contribute above the statutory ceiling. */
    pfOnFullWages: boolean("pf_on_full_wages").default(false).notNull(),
    esiExempt: boolean("esi_exempt").default(false).notNull(),

    /**
     * ⚠️ THE REGIME USED FOR THIS MONTH'S WITHHOLDING, AND NOTHING ELSE.
     * It is a single current value with no year on it, so it is the right
     * input for `projectMonthlyTds` and the WRONG input for a certificate
     * covering a year that has closed.
     */
    taxRegime: taxRegimeEnum("tax_regime").default("new").notNull(),
    /**
     * 🔴🔴 THE ELECTION, PER FINANCIAL YEAR, BECAUSE IT IS ONE.
     *
     * s.115BAC(6) makes the choice a per-year option, and the Finance Act
     * 2023 reversed which regime is the DEFAULT. So "which regime applied
     * in 2022-23" cannot be derived from `tax_regime` above, from the
     * payslips, or from anything else the system holds — it can only be
     * recorded when the employee declares it.
     *
     * ⭐ SHAPE: `{ "2025-26": { regime, declaredOn, recordedBy } }`.
     * `lib/payroll/form16.ts#parseRegimeElections` is a TOTAL parser: any
     * junk resolves to "no election on file", which produces a refusal
     * rather than a wrong regime — and a wrong regime is a wrong tax by
     * tens of thousands of rupees.
     *
     * ⚠️ NO BACKFILL. `{}` is the true value for every existing row: no
     * employee has yet declared anything through this field. Backfilling
     * today's `tax_regime` into past years would record a choice the
     * employee never made, on a document they will file a return with.
     */
    taxRegimeElections: jsonb("tax_regime_elections")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    /** Chapter VI-A declarations. Ignored under the new regime. */
    declaredDeductionsMinor: numeric("declared_deductions_minor", {
      precision: 18,
      scale: 0,
    })
      .default("0")
      .notNull(),

    /**
     * ⭐ THE ACCOUNTANT'S OWN TDS FIGURE, IN PAISE, OR NULL TO PROJECT.
     *
     * ⚠️ FIRST-CLASS RATHER THAN A HACK. A payroll system that refuses
     * the number the accountant arrived at is a payroll system that gets
     * bypassed with a spreadsheet, after which nothing in the ledger is
     * right.
     */
    tdsOverrideMinor: numeric("tds_override_minor", { precision: 18, scale: 0 }),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("employees_id_tenant_key").on(t.id, t.tenantId),
    codeUnique: uniqueIndex("employees_code_key").on(t.tenantId, t.employeeCode),
    activeIdx: index("employees_active_idx").on(t.tenantId, t.isActive, t.fullName),
    /** ⚠️ One UAN per person. Two means an identity has been reused. */
    uanUnique: uniqueIndex("employees_uan_key")
      .on(t.tenantId, t.uan)
      .where(sql`${t.uan} IS NOT NULL`),
    panShape: check(
      "employees_pan_shape",
      sql`${t.pan} IS NULL OR ${t.pan} ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`,
    ),
    /** An exit date before a joining date is a typo, not a career. */
    datesOrdered: check(
      "employees_dates_ordered",
      sql`${t.leftOn} IS NULL OR ${t.leftOn} >= ${t.joinedOn}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ② PAY COMPONENTS AND STRUCTURE                                      */
/* ------------------------------------------------------------------ */

export const payComponents = pgTable(
  "pay_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 40 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    /** earning · deduction */
    kind: varchar("kind", { length: 12 }).notNull(),

    pfApplicable: boolean("pf_applicable").default(false).notNull(),
    esiApplicable: boolean("esi_applicable").default(true).notNull(),
    taxable: boolean("taxable").default(true).notNull(),

    /**
     * 🔴 THE MOST ARGUED-ABOUT FLAG IN INDIAN PAYROLL. False means the
     * amount is paid in full regardless of days worked. Getting it
     * backwards on one component produces a payslip that is wrong by a
     * plausible amount for everybody who took a day off.
     */
    proRates: boolean("pro_rates").default(true).notNull(),

    displayOrder: integer("display_order").default(100).notNull(),
    isActive: boolean("is_active").default(true).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("pay_components_id_tenant_key").on(t.id, t.tenantId),
    codeUnique: uniqueIndex("pay_components_code_key").on(t.tenantId, t.code),
    kindKnown: check("pay_components_kind_known", sql`${t.kind} IN ('earning', 'deduction')`),
  }),
);

/**
 * ⚠️ EFFECTIVE-DATED, AND NEVER UPDATED IN PLACE.
 *
 * 🔴 A RAISE IS A NEW ROW. Editing the old one silently re-prices every
 * payslip that has ever been reissued from it, and payroll is
 * retrospective by nature: an employee asks for last March's payslip and
 * it must produce the number they were actually paid.
 */
export const employeePayStructure = pgTable(
  "employee_pay_structure",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    componentId: uuid("component_id")
      .notNull()
      .references(() => payComponents.id, { onDelete: "restrict" }),

    /** Paise, for a full month. */
    monthlyAmountMinor: numeric("monthly_amount_minor", {
      precision: 18,
      scale: 0,
    }).notNull(),

    effectiveFrom: date("effective_from").notNull(),
    /** Null means still in force. */
    effectiveTo: date("effective_to"),

    reason: text("reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("employee_pay_structure_id_tenant_key").on(t.id, t.tenantId),
    lookupIdx: index("employee_pay_structure_lookup_idx").on(
      t.tenantId,
      t.employeeId,
      t.effectiveFrom,
    ),
    positive: check(
      "employee_pay_structure_amount_sane",
      sql`${t.monthlyAmountMinor} >= 0`,
    ),
    ordered: check(
      "employee_pay_structure_dates_ordered",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ③ STATUTORY RATES — ROWS, NEVER CONSTANTS                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ ONE TABLE, A `kind` COLUMN AND A JSONB PAYLOAD.
 *
 * ⚠️ FOUR NARROW TABLES WOULD BE MORE TYPED AND WOULD ALSO MEAN A
 * MIGRATION EVERY TIME THE FINANCE ACT INVENTS A NEW LEVY. The shapes
 * are validated in `lib/payroll/statutory.ts`, which is pure and
 * tested, and the database's job here is to remember them with dates
 * attached.
 *
 * 🔴 THE POINT IS THE DATES. Payroll is retrospective: March must be
 * calculable in September with March's rates. A rate compiled into code
 * makes that impossible and nobody notices until an employee asks for a
 * duplicate payslip.
 */
export const statutoryRates = pgTable(
  "statutory_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** pf · esi · professional_tax · income_tax · income_tax_slab */
    kind: varchar("kind", { length: 30 }).notNull(),
    /** State code for professional tax; regime for income tax; else null. */
    scope: varchar("scope", { length: 20 }),

    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),

    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("statutory_rates_id_tenant_key").on(t.id, t.tenantId),
    lookupIdx: index("statutory_rates_lookup_idx").on(
      t.tenantId,
      t.kind,
      t.scope,
      t.effectiveFrom,
    ),
    ordered: check(
      "statutory_rates_dates_ordered",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ④ THE RUN                                                           */
/* ------------------------------------------------------------------ */

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    runNo: varchar("run_no", { length: 30 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    status: payrollRunStatusEnum("status").default("draft").notNull(),

    /* ---- Totals, frozen at compute time ------------------------- */
    employeeCount: integer("employee_count").default(0).notNull(),
    grossMinor: numeric("gross_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    employeePfMinor: numeric("employee_pf_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employerPfMinor: numeric("employer_pf_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employerPensionMinor: numeric("employer_pension_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    edliMinor: numeric("edli_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    pfAdminMinor: numeric("pf_admin_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employeeEsiMinor: numeric("employee_esi_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employerEsiMinor: numeric("employer_esi_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    professionalTaxMinor: numeric("professional_tax_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    tdsMinor: numeric("tds_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    otherDeductionsMinor: numeric("other_deductions_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    netPayMinor: numeric("net_pay_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employerCostMinor: numeric("employer_cost_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),

    /** 🔴 Payslips carrying a problem. A run with any of these cannot be approved. */
    problemCount: integer("problem_count").default(0).notNull(),

    computedAt: timestamp("computed_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvalNote: text("approval_note"),

    postedAt: timestamp("posted_at", { withTimezone: true }),
    /** ⭐ The journal. Its presence is what "posted" means. */
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "restrict",
    }),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),

    /* ---- 🔴🔴 WHEN THE MONEY ACTUALLY REACHED THE EMPLOYEE ------- */
    /**
     * ⭐⭐⭐ THE DEFECT MIGRATION 0094 FIXES: THIS ROW COULD SAY WHAT WAS
     * COMPUTED AND NOT WHEN IT WAS PAID.
     *
     * The whole of the Payment of Wages Act, 1936 is about this day.
     * s.5(1) requires wages before the expiry of the seventh day after
     * the wage period in an establishment employing fewer than a
     * thousand persons and the tenth otherwise; the register s.13A
     * obliges an employer to keep, and the one an inspector opens, is a
     * register of DATES PAID. `approvedAt` and `postedAt` answer neither.
     *
     * 🔴 PAYMENT IS NOT A STATUS VALUE AND IT IS NOT ON THE STATUS AXIS.
     * `status` is a one-way ladder — draft → computed → approved →
     * posted — and each rung is an internal act: a signature, a journal.
     * Payment is a fact about a bank, it can FAIL after approval, and it
     * can succeed on the second attempt. A `paid` status would force a
     * backwards status transition to record a bounced NEFT file, which
     * every state machine in Ordence forbids, and it would make the
     * unpayable case (`posted` and never paid) invisible. So payment is
     * a separate, nullable axis: NULL `paidOn` means unpaid, and it
     * never means "approved, so presumably paid".
     */
    paidOn: date("paid_on"),
    /**
     * ⭐ THE UTR, CHEQUE NUMBER OR CASH VOUCHER. ⚠️ Nullable, because a
     * cash-paid establishment has none and refusing to record the DATE
     * for want of a REFERENCE would defeat the whole column.
     */
    paymentReference: text("payment_reference"),
    paymentMode: varchar("payment_mode", { length: 20 }),
    paymentMarkedAt: timestamp("payment_marked_at", { withTimezone: true }),
    paymentMarkedBy: uuid("payment_marked_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * 🔴 THE APPROVED-AND-BOUNCED CASE, WHICH IS THE WHOLE REASON
     * APPROVAL AND PAYMENT ARE SEPARATE. A run approved on the 3rd whose
     * transfer failed on the 6th is late on the 8th, and every
     * status-based screen in Ordence shows it as green.
     */
    paymentFailedOn: date("payment_failed_on"),
    paymentFailureReason: text("payment_failure_reason"),
    /**
     * ⚠️ THE DUE DATE IS FROZEN ON THE ROW RATHER THAN DERIVED AT READ
     * TIME, because the s.5(1) band depends on how many persons the
     * ESTABLISHMENT employed, and that changes. A register reprinted in
     * 2027 must show the date that governed in 2025, not the date
     * today's headcount would produce. `lib/compliance/statutory-due.ts`
     * computes it; this column remembers what it said.
     */
    wagePaymentDueOn: date("wage_payment_due_on"),
    /** `under_1000` | `1000_or_more` — the s.5(1) band that produced it. */
    wagePaymentBand: varchar("wage_payment_band", { length: 20 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("payroll_runs_id_tenant_key").on(t.id, t.tenantId),
    runNoUnique: uniqueIndex("payroll_runs_no_key").on(t.tenantId, t.runNo),
    /**
     * 🔴 ONE LIVE RUN PER PERIOD. Two payrolls for the same March both
     * post, and the wage bill doubles in the ledger with nothing
     * anywhere reporting a problem. A cancelled run does not count,
     * which is what makes a redo possible.
     */
    onePerPeriod: uniqueIndex("payroll_runs_one_live_per_period")
      .on(t.tenantId, t.periodStart)
      .where(sql`status <> 'cancelled'`),
    statusIdx: index("payroll_runs_status_idx").on(t.tenantId, t.status, t.periodStart),
    periodOrdered: check(
      "payroll_runs_period_ordered",
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
    /**
     * 🔴 A RUN CANNOT BE PAID BEFORE IT WAS APPROVED. Not a workflow
     * nicety: a payment date on an unapproved run is either a typo or an
     * unauthorised transfer, and both are worth a failed write.
     */
    paidNeedsApproval: check(
      "payroll_runs_paid_needs_approval",
      sql`${t.paidOn} IS NULL OR ${t.approvedAt} IS NOT NULL`,
    ),
    /**
     * ⚠️ PAID AND FAILED CANNOT BOTH STAND. A retry that succeeds must
     * clear the failure, otherwise the register shows a run that both
     * bounced and settled and nobody can tell which is current.
     */
    paidNotFailed: check(
      "payroll_runs_paid_not_failed",
      sql`${t.paidOn} IS NULL OR ${t.paymentFailedOn} IS NULL`,
    ),
    /** ⭐ A failure with no reason is a record that helps nobody. */
    failureNeedsReason: check(
      "payroll_runs_failure_needs_reason",
      sql`${t.paymentFailedOn} IS NULL OR ${t.paymentFailureReason} IS NOT NULL`,
    ),
    /** ⭐ The overdue-and-unpaid lookup this whole column set exists for. */
    unpaidIdx: index("payroll_runs_unpaid_idx").on(
      t.tenantId,
      t.wagePaymentDueOn,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⑤ PAYSLIPS                                                          */
/* ------------------------------------------------------------------ */

export const payslips = pgTable(
  "payslips",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    runId: uuid("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),

    /**
     * ⭐ THE EMPLOYEE'S NAME AND CODE, FROZEN.
     *
     * ⚠️ A payslip reissued after a name change must show the name that
     * was on it. Joining to `employees` at read time shows today's, and
     * a payslip that does not match the one the employee holds is worse
     * than no payslip.
     */
    employeeName: varchar("employee_name", { length: 200 }).notNull(),
    employeeCode: varchar("employee_code", { length: 40 }).notNull(),

    daysInMonth: integer("days_in_month").notNull(),
    payableDays: numeric("payable_days", { precision: 6, scale: 2 }).notNull(),
    lopDays: numeric("lop_days", { precision: 6, scale: 2 }).default("0").notNull(),

    grossMinor: numeric("gross_minor", { precision: 18, scale: 0 }).notNull(),
    pfWagesMinor: numeric("pf_wages_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employeePfMinor: numeric("employee_pf_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employerPfMinor: numeric("employer_pf_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employerPensionMinor: numeric("employer_pension_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    edliMinor: numeric("edli_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    pfAdminMinor: numeric("pf_admin_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employeeEsiMinor: numeric("employee_esi_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    employerEsiMinor: numeric("employer_esi_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    professionalTaxMinor: numeric("professional_tax_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    tdsMinor: numeric("tds_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    otherDeductionsMinor: numeric("other_deductions_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    totalDeductionsMinor: numeric("total_deductions_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    netPayMinor: numeric("net_pay_minor", { precision: 18, scale: 0 }).notNull(),

    /** ⚠️ True means the tax figure is an estimate to be trued up. */
    tdsIsProjection: boolean("tds_is_projection").default(false).notNull(),
    tdsOverridden: boolean("tds_overridden").default(false).notNull(),

    /** ⭐ Every line, with its working, frozen at compute time. */
    lines: jsonb("lines").$type<unknown[]>().notNull(),
    notes: jsonb("notes").$type<string[]>().default([]).notNull(),
    problems: jsonb("problems").$type<string[]>().default([]).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("payslips_id_tenant_key").on(t.id, t.tenantId),
    /** ⚠️ One payslip per employee per run. Two is a duplicate payment. */
    onePerEmployee: uniqueIndex("payslips_run_employee_key").on(t.runId, t.employeeId),
    runIdx: index("payslips_run_idx").on(t.tenantId, t.runId),
    employeeIdx: index("payslips_employee_idx").on(t.tenantId, t.employeeId),
  }),
);

export type Employee = typeof employees.$inferSelect;
export type PayComponentRow = typeof payComponents.$inferSelect;
export type PayrollRun = typeof payrollRuns.$inferSelect;
export type Payslip = typeof payslips.$inferSelect;
export type StatutoryRate = typeof statutoryRates.$inferSelect;

/* ------------------------------------------------------------------ */
/* ⑥ FULL AND FINAL SETTLEMENTS                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ THE EXIT SETTLEMENT. There was no separation flow in Ordence at
 * all before this: `employees.left_on` was a date that stopped payroll
 * and nothing anywhere assembled what the leaver was owed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE INPUTS ARE STORED AND NOT JUST THE TOTAL
 * ══════════════════════════════════════════════════════════════════════
 * A settlement is disputed years later, before the authority under s.15
 * of the Payment of Wages Act, 1936 or the controlling authority under
 * s.7 of the Payment of Gratuity Act, 1972. By then the gratuity ceiling
 * has moved, the leave ledger has been corrected and the pay structure
 * has been superseded. RECOMPUTING FROM TODAY'S TABLES PRODUCES A
 * DIFFERENT NUMBER AND PROVES NOTHING.
 *
 * ⭐ So `inputs` holds the argument set verbatim — the balance in
 * centidays, the daily rate, the gratuity rule rows that were in force,
 * every recovery line with its reference — and `computed` holds the
 * working. The row IS the evidence. The flat columns beside them exist
 * only so the figures can be summed in SQL without parsing JSON.
 *
 * ⚠️ MONEY IS `numeric(18,0)` PAISE HERE AS EVERYWHERE ELSE. Not a
 * float, and read back as a decimal string that becomes a `bigint`.
 */
export const employeeSettlements = pgTable(
  "employee_settlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    employeeId: uuid("employee_id")
      .notNull()
      // 🔴 RESTRICT, not cascade. Deleting an employee must not delete
      // the evidence of what they were paid on the way out.
      .references(() => employees.id, { onDelete: "restrict" }),

    settlementNo: varchar("settlement_no", { length: 30 }).notNull(),

    /** ⭐ Inclusive, as `lib/payroll/gratuity.ts` defines it. */
    lastWorkingDay: date("last_working_day").notNull(),
    /** The `TerminationCause` union — it drives the gratuity proviso. */
    cause: varchar("cause", { length: 30 }).notNull(),

    /* ---- The figures, flat, for SQL ------------------------------ */
    partMonthWagesMinor: numeric("part_month_wages_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    leaveEncashmentMinor: numeric("leave_encashment_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    noticePayMinor: numeric("notice_pay_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    gratuityStatutoryMinor: numeric("gratuity_statutory_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    gratuityExGratiaMinor: numeric("gratuity_ex_gratia_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    grossDuesMinor: numeric("gross_dues_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),

    /* ---- The s.7(3) machinery, on the row ------------------------ */
    /**
     * 🔴 THE BASE THE CAP BITES ON, AND IT EXCLUDES GRATUITY. s.2(vi) of
     * the Payment of Wages Act, 1936 excludes gratuity payable on
     * termination from "wages". Storing the base separately from the
     * gross is what lets an auditor see that the exclusion was applied.
     */
    deductionCapBaseMinor: numeric("deduction_cap_base_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    /** 5000 or 7500 basis points — s.7(3) and its co-operative proviso. */
    deductionCapBp: integer("deduction_cap_bp").default(5000).notNull(),
    recoveriesClaimedMinor: numeric("recoveries_claimed_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    /** ⭐ Zero on a refusal. NEVER a figure clamped down to the cap. */
    deductionsAppliedMinor: numeric("deductions_applied_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    netPayableMinor: numeric("net_payable_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),

    /**
     * 🔴 TRUE MEANS THE SETTLEMENT IS UNLAWFUL AS CLAIMED AND MAY NOT BE
     * ISSUED. It is stored rather than recomputed because the refusal is
     * itself a fact the employer was told, on a date, and an employer who
     * paid anyway needs to be shown to have been warned.
     */
    refused: boolean("refused").default(false).notNull(),
    refusalReason: text("refusal_reason"),

    /* ---- The working ---------------------------------------------- */
    inputs: jsonb("inputs").notNull(),
    computed: jsonb("computed").notNull(),

    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),

    /**
     * ⭐ THE SAME SEPARATION AS `payroll_runs`, FOR THE SAME REASON, AND
     * IT MATTERS MORE HERE: the leaver has no access to the system and
     * nobody chasing the transfer on their behalf.
     * 🔴 The date the wages fell due for a terminated employee is
     * anchored to the LAST WORKING DAY, not the 7th of the following
     * month — the wage-period rule in s.5(1) governs a wage period and
     * this person no longer has one.
     */
    wagePaymentDueOn: date("wage_payment_due_on"),
    paidOn: date("paid_on"),
    paymentReference: text("payment_reference"),
    paymentFailedOn: date("payment_failed_on"),
    paymentFailureReason: text("payment_failure_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("employee_settlements_id_tenant_key").on(t.id, t.tenantId),
    noUnique: uniqueIndex("employee_settlements_no_key").on(t.tenantId, t.settlementNo),
    /**
     * ⚠️ ONE LIVE SETTLEMENT PER EMPLOYEE. Two full-and-finals for the
     * same person is two gratuity payments, and the second one is the
     * kind of error that is only ever found by the auditor.
     */
    oneLive: uniqueIndex("employee_settlements_one_per_employee").on(t.tenantId, t.employeeId),
    dueIdx: index("employee_settlements_due_idx").on(t.tenantId, t.wagePaymentDueOn),
    /** 🔴 A refusal without its reason is the record that helps nobody. */
    refusalNeedsReason: check(
      "employee_settlements_refusal_needs_reason",
      sql`${t.refused} = false OR ${t.refusalReason} IS NOT NULL`,
    ),
    /**
     * 🔴🔴 A REFUSED SETTLEMENT MAY NOT BE PAID. This is the database's
     * copy of the rule in `lib/payroll/settlement.ts`: an over-cap
     * settlement is a refusal, not a clamp, and no code path anywhere may
     * quietly mark one paid.
     */
    refusedNotPaid: check(
      "employee_settlements_refused_not_paid",
      sql`${t.refused} = false OR ${t.paidOn} IS NULL`,
    ),
    paidNotFailed: check(
      "employee_settlements_paid_not_failed",
      sql`${t.paidOn} IS NULL OR ${t.paymentFailedOn} IS NULL`,
    ),
    /** ⭐ The deduction can never exceed the cap, in the database too. */
    withinCap: check(
      "employee_settlements_within_cap",
      sql`${t.deductionsAppliedMinor} * 10000 <= ${t.deductionCapBaseMinor} * ${t.deductionCapBp}`,
    ),
  }),
);

export type EmployeeSettlement = typeof employeeSettlements.$inferSelect;

/* ================================================================== */
/* ⑦ ADVANCES, LOANS AND REIMBURSEMENTS — 0096                         */
/* ================================================================== */

/**
 * Ordence — ⭐⭐⭐ EMPLOYEE ADVANCES AND LOANS
 *
 * Mirrors `SQL-FILES/0096_advances_loans_and_reimbursements.sql`. The
 * reasoning lives in both. The engine is `lib/payroll/advances.ts`.
 *
 * 🔴🔴 THERE IS NO `outstanding_minor` COLUMN ON THIS TABLE AND THERE
 * MUST NEVER BE ONE. The balance is folded from
 * `employee_advance_recoveries` every time it is read. A counter is
 * decremented by a payroll run, and payroll runs get reversed, re-run
 * and run twice; nothing complains, because a counter has no way to know
 * it is wrong. The failure lands on a person's salary in both
 * directions — money taken after the advance was repaid, or a debt that
 * was already settled.
 *
 * 🔴 AND IT IS A RECEIVABLE, NOT PAYROLL COST. Disbursing an advance
 * converts cash into a claim on the employee; it belongs on the balance
 * sheet. ⚠️ STATED GAP: it is not posted to the ledger in this release —
 * see `advanceLedgerIntent()`.
 */
export const employeeAdvances = pgTable(
  "employee_advances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      // 🔴 RESTRICT. Deleting an employee must not delete the record of
      // money they were lent and may still owe.
      .references(() => employees.id, { onDelete: "restrict" }),

    advanceNo: varchar("advance_no", { length: 30 }).notNull(),

    /** The `AdvanceKind` union — it picks the s.7(2) clause. */
    kind: varchar("kind", { length: 30 }).notNull(),

    /** ⚠️ Paise, `numeric(18,0)`. Never a float, never rupees. */
    principalMinor: numeric("principal_minor", { precision: 18, scale: 0 }).notNull(),
    disbursedOn: date("disbursed_on").notNull(),

    /**
     * 🔴 s.12 OF THE PAYMENT OF WAGES ACT, 1936 — THE RULES OF RECOVERY
     * MUST BE PRESCRIBED. An advance recovered at the employer's monthly
     * discretion is not what s.12(b) contemplates. Both columns are NOT
     * NULL: no agreement, no deduction.
     */
    agreementReference: text("agreement_reference").notNull(),
    employeeConsentedOn: date("employee_consented_on").notNull(),

    instalmentCount: integer("instalment_count").notNull(),
    /** "YYYY-MM". The wage period the first instalment falls in. */
    firstRecoveryPeriod: varchar("first_recovery_period", { length: 7 }).notNull(),

    /**
     * ⚠️ Basis points per annum; 0 is interest-free and that is the
     * common case. Recorded because it decides whether Rule 3(7)(i) of
     * the Income-tax Rules, 1962 is in play — see `perquisiteValuation`.
     */
    interestRateBp: integer("interest_rate_bp").default(0).notNull(),

    /**
     * 🔴 ALWAYS `not_computed` TODAY, AND THE COLUMN EXISTS TO SAY SO
     * OUT LOUD. Valuing an interest-free loan needs the SBI rate for the
     * corresponding loan as on the first day of the previous year, which
     * Ordence does not hold. A stated gap on every row beats a number
     * derived from a guessed rate landing in somebody's Form 16.
     */
    perquisiteValuation: varchar("perquisite_valuation", { length: 20 })
      .default("not_computed")
      .notNull(),

    /** 'active' | 'closed' | 'written_off' | 'cancelled'. */
    status: varchar("status", { length: 20 }).default("active").notNull(),

    /**
     * ⚠️ A WAIVED LOAN IS TAXABLE IN THE EMPLOYEE'S HANDS and Ordence
     * does not decide the head or the year. The amount is stored so the
     * accountant has the figure; the treatment is theirs.
     */
    writtenOffMinor: numeric("written_off_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    writtenOffOn: date("written_off_on"),
    writtenOffReason: text("written_off_reason"),

    /** ⭐ The State's s.12(b) rules, verbatim, or null where unconfigured. */
    stateLimits: jsonb("state_limits"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("employee_advances_id_tenant_key").on(t.id, t.tenantId),
    noUnique: uniqueIndex("employee_advances_no_key").on(t.tenantId, t.advanceNo),
    employeeIdx: index("employee_advances_employee_idx").on(t.tenantId, t.employeeId, t.status),
    positivePrincipal: check(
      "employee_advances_principal_positive",
      sql`${t.principalMinor} > 0`,
    ),
    /** 🔴 s.12(b) speaks of "the instalments". At least one, agreed. */
    instalmentsAgreed: check(
      "employee_advances_instalments_agreed",
      sql`${t.instalmentCount} >= 1`,
    ),
    /** ⚠️ A write-off without a reason is a hole in the balance sheet. */
    writeOffNeedsReason: check(
      "employee_advances_write_off_needs_reason",
      sql`${t.writtenOffMinor} = 0 OR (${t.writtenOffOn} IS NOT NULL AND ${t.writtenOffReason} IS NOT NULL)`,
    ),
    /** More cannot be waived than was lent. */
    writeOffWithinPrincipal: check(
      "employee_advances_write_off_within_principal",
      sql`${t.writtenOffMinor} >= 0 AND ${t.writtenOffMinor} <= ${t.principalMinor}`,
    ),
  }),
);

export type EmployeeAdvance = typeof employeeAdvances.$inferSelect;

/**
 * ⭐ THE AGREED SCHEDULE — s.12(b), "the instalments by which they may
 * be recovered".
 *
 * ⚠️ THIS TABLE IS MUTABLE AND THE RECOVERY LEDGER IS NOT, WHICH IS THE
 * RIGHT WAY ROUND. A refused instalment is DEFERRED — its `period` moves
 * to the far end of the schedule and its `amount_minor` does not change.
 * The plan may move; what was actually taken from someone's wages may
 * not.
 *
 * 🔴 THE INSTALMENTS SUM TO THE PRINCIPAL EXACTLY. `buildInstalmentSchedule`
 * makes the last one absorb the remainder, so ₹10,000 over three months
 * is 3333.33 + 3333.33 + 3333.34 rather than three equal instalments
 * that recover a paise too few (the advance never closes) or a paise too
 * many (an unauthorised deduction under s.7(1), however trivial).
 */
export const employeeAdvanceInstalments = pgTable(
  "employee_advance_instalments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    advanceId: uuid("advance_id")
      .notNull()
      .references(() => employeeAdvances.id, { onDelete: "cascade" }),

    /** 1-based and STABLE across deferrals, so the ledger can name it. */
    seq: integer("seq").notNull(),
    /** "YYYY-MM". Moves on deferral; `seq` does not. */
    period: varchar("period", { length: 7 }).notNull(),
    amountMinor: numeric("amount_minor", { precision: 18, scale: 0 }).notNull(),

    /**
     * ⭐ HOW MANY WAGE PERIODS THIS INSTALMENT HAS BEEN PUSHED BACK BY A
     * s.7(3) REFUSAL. Visible because an employer whose employee is too
     * close to the cap month after month needs to see it happening.
     */
    deferrals: integer("deferrals").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("employee_advance_instalments_id_tenant_key").on(t.id, t.tenantId),
    seqUnique: uniqueIndex("employee_advance_instalments_seq_key").on(t.tenantId, t.advanceId, t.seq),
    periodIdx: index("employee_advance_instalments_period_idx").on(t.tenantId, t.period),
    positive: check("employee_advance_instalments_positive", sql`${t.amountMinor} > 0`),
  }),
);

export type EmployeeAdvanceInstalment = typeof employeeAdvanceInstalments.$inferSelect;

/**
 * 🔴🔴 THE RECOVERY LEDGER. APPEND-ONLY, IN THE DATABASE, BY TRIGGER.
 *
 * This is the ONLY source of the outstanding balance, and it is evidence
 * of a deduction from a named person's wages on a named payslip. A row
 * that can be edited afterwards is not evidence — the same argument that
 * makes `audit_logs` and `permission_denials` append-only, with more
 * money on it. `employee_advance_recoveries_no_update` and
 * `..._no_delete` enforce it below the application, so no future action,
 * migration or console session can quietly rewrite what was taken.
 *
 * ⭐ THE CAP WORKING IS ON EVERY ROW. `cap_base_minor`, `cap_bp` and
 * `other_deductions_minor` are what s.7(3) was applied to at the time.
 * An employee querying a deduction two years later is entitled to the
 * working, and re-deriving it from today's payslip proves nothing.
 */
export const employeeAdvanceRecoveries = pgTable(
  "employee_advance_recoveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    advanceId: uuid("advance_id")
      .notNull()
      // 🔴 RESTRICT, not cascade. The evidence outlives the header row.
      .references(() => employeeAdvances.id, { onDelete: "restrict" }),
    /** Nullable only for a recovery made outside a payroll run. */
    payslipId: uuid("payslip_id").references(() => payslips.id, { onDelete: "restrict" }),

    /** "YYYY-MM" — the wage period s.7(3) was measured over. */
    period: varchar("period", { length: 7 }).notNull(),
    /** ⚠️ Paise actually deducted. Never a clamped part-instalment. */
    amountMinor: numeric("amount_minor", { precision: 18, scale: 0 }).notNull(),
    instalmentSeq: integer("instalment_seq").notNull(),

    /* ---- The s.7(3) working, frozen ------------------------------- */
    capBaseMinor: numeric("cap_base_minor", { precision: 18, scale: 0 }).notNull(),
    capBp: integer("cap_bp").default(5000).notNull(),
    otherDeductionsMinor: numeric("other_deductions_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),

    recoveredOn: date("recovered_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("employee_advance_recoveries_id_tenant_key").on(t.id, t.tenantId),
    /**
     * ⚠️ ONE RECOVERY PER ADVANCE PER WAGE PERIOD. A payroll run that is
     * re-run must not deduct twice from the same month's wages, and on
     * an append-only table the unique index is the only thing that can
     * stop it.
     */
    onePerPeriod: uniqueIndex("employee_advance_recoveries_period_key").on(
      t.tenantId,
      t.advanceId,
      t.period,
    ),
    advanceIdx: index("employee_advance_recoveries_advance_idx").on(t.tenantId, t.advanceId),
    positive: check("employee_advance_recoveries_positive", sql`${t.amountMinor} > 0`),
    /**
     * 🔴🔴 s.7(3) IN THE DATABASE, in integer basis points so no rounding
     * can creep in: (this recovery + the other deductions of the same
     * wage period) × 10000 ≤ wages × bp. The same shape as
     * `employee_settlements_within_cap`, because it is the same rule.
     */
    withinCap: check(
      "employee_advance_recoveries_within_cap",
      sql`(${t.amountMinor} + ${t.otherDeductionsMinor}) * 10000 <= ${t.capBaseMinor} * ${t.capBp}`,
    ),
  }),
);

export type EmployeeAdvanceRecovery = typeof employeeAdvanceRecoveries.$inferSelect;

/**
 * Ordence — ⭐⭐⭐ REIMBURSEMENT CLAIMS
 *
 * 🔴🔴 THE EVIDENCE IS A COLUMN, AND THE TAX TREATMENT IS DERIVED FROM
 * IT. `treatment` is never a user's choice. `lib/payroll/reimbursements.ts`
 * adds up the acceptable documents, and the part with nothing behind it
 * becomes a TAXABLE ALLOWANCE under s.17(1)(iv) of the Income-tax Act,
 * 1961 rather than a tax-free repayment of expenditure.
 *
 * ⭐ THE CHECK CONSTRAINT BELOW IS THE DATABASE'S COPY OF THAT RULE: a
 * row may not claim a single paise of non-wages treatment while carrying
 * no evidence. It exists because the whole feature is one boolean away
 * from being a tickbox that makes tax disappear, and a rule that lives
 * only in a pure function is a rule an insert can walk around.
 */
export const employeeReimbursementClaims = pgTable(
  "employee_reimbursement_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),

    claimNo: varchar("claim_no", { length: 30 }).notNull(),
    category: varchar("category", { length: 40 }).notNull(),
    description: text("description").notNull(),
    incurredOn: date("incurred_on").notNull(),

    claimedMinor: numeric("claimed_minor", { precision: 18, scale: 0 }).notNull(),
    /** Paise proven by acceptable documents, capped at the claim. */
    evidencedMinor: numeric("evidenced_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    /** 🔴 Not wages: outside PF, ESI, professional tax and s.192. */
    notWagesMinor: numeric("not_wages_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),
    /** 🔴 Salary income. Taxable. The part with no bill behind it. */
    taxableAllowanceMinor: numeric("taxable_allowance_minor", { precision: 18, scale: 0 })
      .default("0")
      .notNull(),

    /** The `ReimbursementTreatment` union. DERIVED, never chosen. */
    treatment: varchar("treatment", { length: 40 }).notNull(),
    /**
     * ⚠️ 'no' or 'notDecided'. Ordence does NOT decide whether PF and ESI
     * reach the allowance portion — it turns on s.2(b) of the EPF Act,
     * 1952 and s.2(22) of the ESI Act, 1948 and the boundary is argued
     * establishment by establishment. A stated "not decided" on the
     * screen is worth more than a confident flag that is wrong here.
     */
    pfOnAllowance: varchar("pf_on_allowance", { length: 20 }).default("no").notNull(),
    esiOnAllowance: varchar("esi_on_allowance", { length: 20 }).default("no").notNull(),

    /** ⭐ The documents themselves — kind, reference, date, amount. */
    evidence: jsonb("evidence").default(sql`'[]'::jsonb`).notNull(),
    /** The inputs and the working, so the assessment reproduces itself. */
    assessment: jsonb("assessment").notNull(),

    /** 🔴 The employer's certificate that it was incurred on duty. */
    incurredForEmployer: boolean("incurred_for_employer").default(false).notNull(),

    status: varchar("status", { length: 20 }).default("submitted").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    /** The payslip it was paid on, where it was paid through payroll. */
    payslipId: uuid("payslip_id").references(() => payslips.id, { onDelete: "set null" }),
    paidOn: date("paid_on"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("employee_reimbursement_claims_id_tenant_key").on(t.id, t.tenantId),
    noUnique: uniqueIndex("employee_reimbursement_claims_no_key").on(t.tenantId, t.claimNo),
    employeeIdx: index("employee_reimbursement_claims_employee_idx").on(
      t.tenantId,
      t.employeeId,
      t.status,
    ),
    /** ⭐ Nothing is lost and nothing is invented: the split is the claim. */
    splitAddsUp: check(
      "employee_reimbursement_claims_split_adds_up",
      sql`${t.notWagesMinor} + ${t.taxableAllowanceMinor} = ${t.claimedMinor}`,
    ),
    /**
     * 🔴🔴 NO EVIDENCE, NO TAX-FREE TREATMENT. The rule the whole feature
     * exists for, enforced where an insert cannot route around it.
     */
    notWagesNeedsEvidence: check(
      "employee_reimbursement_claims_not_wages_needs_evidence",
      sql`${t.notWagesMinor} = 0 OR (jsonb_array_length(${t.evidence}) > 0 AND ${t.incurredForEmployer} = true)`,
    ),
    /** Evidence can never prove more than was claimed. */
    evidenceWithinClaim: check(
      "employee_reimbursement_claims_evidence_within_claim",
      sql`${t.evidencedMinor} >= 0 AND ${t.evidencedMinor} <= ${t.claimedMinor}`,
    ),
    /** The non-wages part is never more than what the documents prove. */
    notWagesWithinEvidence: check(
      "employee_reimbursement_claims_not_wages_within_evidence",
      sql`${t.notWagesMinor} <= ${t.evidencedMinor}`,
    ),
  }),
);

export type EmployeeReimbursementClaim = typeof employeeReimbursementClaims.$inferSelect;
