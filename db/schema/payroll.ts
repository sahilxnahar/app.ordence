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

    taxRegime: taxRegimeEnum("tax_regime").default("new").notNull(),
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
