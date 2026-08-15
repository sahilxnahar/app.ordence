"use server";

/**
 * Ordence — ⭐⭐⭐ STATUTORY RATE MAINTENANCE
 * Version: v1.46.0-alpha · Batch 52
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT WAS MISSING, AND WHY IT WAS THE DANGEROUS KIND OF MISSING
 * ══════════════════════════════════════════════════════════════════════
 * `statutory_rates` has been effective-dated since Batch 15 and nothing
 * in the product could write a second row into it. `seedPayrollSetup`
 * writes opening figures once and deliberately never overwrites them.
 * So from the second day of a tenant's life:
 *
 *   • A Finance Act change — one happens every February — was a code
 *     deploy, in the middle of a payroll cycle.
 *   • A typo in a PF ceiling, an ESI threshold or a PT slab was a psql
 *     prompt, and the statement anybody reaches for is
 *     `UPDATE statutory_rates SET payload = ...`.
 *
 * ⚠️ THAT `UPDATE` IS THE WHOLE PROBLEM. It restates every payroll ever
 * computed against the row. Nothing errors, nothing is audited, and the
 * damage is invisible until somebody reissues an old payslip and it no
 * longer matches the PDF in the employee's inbox. The employee is right
 * and the system cannot explain itself.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ DESIGN POINT 1 — A RATE CHANGE IS A NEW ROW, NEVER AN EDIT
 * ══════════════════════════════════════════════════════════════════════
 * `addRateRevision` only ever INSERTs. The one thing it touches on an
 * existing row is `effective_to` on the open-ended incumbent, set to the
 * day before the successor starts — and even that is checked against the
 * engine's own resolution rule before it is written, so a close that
 * would change what a settled run reads is refused like anything else.
 *
 * 🔴 THERE IS NO `updateRate` EXPORT AND THAT ABSENCE IS THE FEATURE.
 * A generic update would be the first thing reached for the next time a
 * number is wrong, and it would be reached for at 9pm on payroll day.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ DESIGN POINT 2 — A CHANGE AND A CORRECTION ARE DIFFERENT THINGS
 *                        AND BOTH ARE REAL
 * ══════════════════════════════════════════════════════════════════════
 * A Budget moves the ESI threshold from 1 July. That is a CHANGE: the
 * old number was right for June and stays right for June forever. It is
 * ordinary maintenance, it needs no ceremony, and refusing it would push
 * people back to psql.
 *
 * Somebody typed ₹1,500 instead of ₹15,000 for the PF ceiling and two
 * payrolls have run against it. That is a CORRECTION: the old number was
 * never right, and putting it right means the payslips already issued
 * for those two months no longer match what the system now believes.
 * That is sometimes the correct thing to do — the alternative is a
 * system that permanently reproduces a known-wrong figure — but it is a
 * restatement of history and it must feel like one.
 *
 * 🔴 SO HOW DO WE TELL THEM APART? NOT BY ASKING. A radio button
 * labelled "this is a correction" is answered by whoever is in a hurry,
 * and the answer that avoids the extra permission is always the wrong
 * one. The distinction is decided by CONSEQUENCE, computed by the
 * server, from the runs that already exist:
 *
 *   A write is a CHANGE if no settled run's resolved rate rows move.
 *   A write is a CORRECTION if any of them do.
 *
 * `runsResolvedDifferently` in `lib/payroll/rate-periods.ts` answers
 * that by resolving the series before and after through the ENGINE'S OWN
 * selection rule and diffing. It cannot disagree with what payroll will
 * actually read, which a date heuristic could.
 *
 * ⭐ AND THE TWO DOORS ARE SEPARATELY PERMISSIONED:
 *   `addRateRevision`      — `payroll.manage`.
 *   `correctStatutoryRate` — `payroll.manage` AND `payroll.approve`,
 *                            via `requireAllPermissions`.
 *
 * ⚠️ THE SECOND PAIR IS DELIBERATE AND IT IS THE SAME ARGUMENT AS THE
 * TWO PAYROLL KEYS. `payroll.manage` sets salaries; `payroll.approve`
 * signs off the wage bill. Restating a rate a signed-off run used
 * rewrites what was signed off, so it needs the signature key too. The
 * person who maintains the rate table cannot silently rewrite what
 * somebody else approved.
 *
 * 🔴 WHAT I WANTED AND DO NOT HAVE: a dedicated
 * `payroll.rates.correct` key. `requirePermission` is typed
 * `PermissionKey` and the catalogue lives in `db/schema/auth.ts`, which
 * this batch must not touch. Composing two existing keys is the honest
 * approximation — it is strictly stronger than `payroll.manage` alone
 * and it is enforced at the export where `check:guards` can see it — but
 * it grants correction to everyone who can approve a run, which is
 * broader than it should be. Noted in the batch report.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ DESIGN POINT 3 — WHAT IS IN FORCE TODAY, AND WHO USED WHAT
 * ══════════════════════════════════════════════════════════════════════
 * `listStatutoryRates` returns every row grouped into series, each row
 * tagged with whether it is the one a payroll dated today would read and
 * with the runs that read it. Both are DERIVED, by replaying the
 * engine's selection at each run's `periodEnd` — the same date
 * `computeRun` passes to `loadRates`.
 *
 * ⚠️ DERIVED IS WEAKER THAN RECORDED AND I WANT TO SAY SO PLAINLY. If a
 * row's dates are later corrected, the derivation reports the run
 * against the row it would read NOW, not the row it actually read on the
 * day. A `payroll_run_rates` join table — run id, rate row id, kind,
 * scope, written at compute time — would make this a fact. It does not
 * exist and this batch cannot add it. Noted in the batch report.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ DESIGN POINT 4 — OVERLAPS ARE REFUSED, NOT WARNED ABOUT
 * ══════════════════════════════════════════════════════════════════════
 * See `resolutionFor` in `lib/payroll/rate-periods.ts` for what each
 * kind does with an overlap. Short version: for `pf`, `esi` and
 * `income_tax` it is an arbitrary pick, so payroll stops being a
 * function of its inputs; for `professional_tax` and `income_tax_slab`
 * the engine unions the rows, so two overlapping slab tables are
 * concatenated into one ladder and the same income band is charged
 * twice. Both produce a confident, plausible, wrong number.
 *
 * 🔴 THE DATABASE CANNOT ENFORCE THIS TODAY. A partial exclusion
 * constraint over `(tenant_id, kind, scope)` on the daterange
 * `[effective_from, coalesce(effective_to,'infinity')]` is the right
 * guarantee and it needs migration 0082, which another agent owns.
 * Until then this file is the only enforcement, which is exactly why it
 * refuses rather than warns, and why `listStatutoryRates` also SHOWS any
 * overlap already in the table — one written by the seed, by an import
 * or at a psql prompt is not something an application check can undo.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { payrollRuns, statutoryRates } from "@/db/schema/payroll";
import { requireAllPermissions, requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  RATE_KINDS,
  describeRuns,
  findOverlaps,
  isSettled,
  openIncumbent,
  previousDay,
  resolutionFor,
  rowsInForceOn,
  runsResolvedDifferently,
  runsUsingRow,
  seriesKey,
  withRevision,
  type RatePeriod,
  type RunPeriod,
} from "@/lib/payroll/rate-periods";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "payroll.read" as const;
const MANAGE = "payroll.manage" as const;
const APPROVE = "payroll.approve" as const;

/* ================================================================== */
/* ① VALIDATING A PAYLOAD                                              */
/* ================================================================== */

/**
 * ⭐⭐ THE PAYLOAD IS `jsonb` AND THAT IS THE RIGHT SHAPE, BUT IT MEANS
 * NOTHING VALIDATES IT ON THE WAY IN EXCEPT THIS.
 *
 * 🔴 `loadRates` VALIDATES SHALLOWLY AND FAILS TO NULL, WHICH IS RIGHT
 * FOR IT AND NOT ENOUGH HERE. A missing `employeeRateBp` becomes a null
 * ruleset, which `buildPayslip` turns into a stated PROBLEM and a run
 * that cannot be approved — a loud, safe failure. But a payload with
 * `employeeRateBp: 12` instead of `1200` passes every check in
 * `loadRates` and deducts 0.12% of somebody's basic. There is no
 * problem, no error, and no way to notice except by arithmetic.
 *
 * ⚠️ SO THE DOOR VALIDATES STRICTLY AND THE ENGINE STAYS FORGIVING.
 * Rows that predate this screen — the seed's, an import's — still load.
 * Only new writes have to be well-formed.
 */

/**
 * 🔴 BASIS POINTS ARE INTEGERS AND MONEY IS A DIGIT STRING. NEVER A
 * FLOAT, ANYWHERE, IN EITHER.
 *
 * 8.33% is 833 basis points, not 0.0833. A float rate multiplied by a
 * bigint of paise does not type-check in the engine — which is the point
 * of the engine's design — so a float arriving here would be coerced
 * somewhere on the way and the coercion is where the rupee goes missing.
 * `z.number().int()` refuses `833.0000001` from a JSON body.
 *
 * ⚠️ AND MONEY IS A STRING, NOT A NUMBER, because paise ceilings run to
 * ₹50,00,000 (5,000,000,000 paise) for the surcharge threshold, and JSON
 * numbers are IEEE doubles. `z.number()` would accept it today and lose
 * precision the day somebody enters a nine-figure annual limit.
 */
const bpField = z
  .number()
  .int("A rate is whole basis points. 12% is 1200, and 8.33% is 833.")
  .min(0)
  .max(1_000_000);

const minorField = z
  .string()
  .regex(/^\d+$/, "An amount is whole paise as digits. ₹15,000 is \"1500000\".");

const minorFieldNullable = minorField.nullable();

const pfPayload = z
  .object({
    employeeRateBp: bpField,
    employerRateBp: bpField,
    pensionRateBp: bpField,
    edliRateBp: bpField,
    adminRateBp: bpField,
    wageCeilingMinor: minorField,
    pensionCeilingMinor: minorField,
  })
  .strict()
  /**
   * 🔴 THE PENSION SHARE CANNOT EXCEED THE EMPLOYER'S TOTAL.
   *
   * `computePf` computes the employer's PF half as
   * `employerTotal - pension` — deliberately, so the rounding rupee
   * belongs to one account rather than to neither and the ECR rejects
   * the file. That subtraction goes NEGATIVE if `pensionRateBp` is
   * greater than `employerRateBp`, and a negative PF credit posts to the
   * ledger as a debit to a liability. The arithmetic is right; the input
   * was never possible in law and has to be refused here.
   */
  .refine((p) => p.pensionRateBp <= p.employerRateBp, {
    message:
      "The pension rate is part of the employer's contribution, so it cannot exceed it. 8.33% of a 12% employer share is 833 and 1200.",
    path: ["pensionRateBp"],
  });

const esiPayload = z
  .object({
    employeeRateBp: bpField,
    employerRateBp: bpField,
    wageLimitMinor: minorField,
  })
  .strict();

const incomeTaxPayload = z
  .object({
    standardDeductionMinor: minorField,
    rebateLimitMinor: minorField,
    rebateMaxMinor: minorField,
    cessRateBp: bpField,
    surchargeThresholdMinor: minorFieldNullable.optional(),
  })
  .strict();

/**
 * ⭐⭐ A SLAB LADDER IS VALIDATED AS A LADDER, NOT AS A LIST OF ROWS.
 *
 * 🔴 A GAP BETWEEN SLABS IS SILENT AND IT IS NOT THE SAME BUG IN BOTH
 * PLACES:
 *
 *   • `computeProfessionalTax` takes the FIRST slab whose bracket
 *     contains the salary. A salary that falls in a gap matches none, so
 *     it returns zero with a note that says the slab table has a gap —
 *     which is honest, but only if somebody reads payslip notes.
 *   • `projectMonthlyTds` walks the ladder accumulating tax band by
 *     band. A gap there is not a zero — it is a band of income taxed at
 *     the rate of whichever slab happens to straddle it, or at nothing.
 *     Under-withholding, discovered at assessment, by the employee.
 *
 * ⚠️ AND AN OVERLAP INSIDE ONE ROW'S LADDER is the same double-charge
 * as an overlap between two rows, just harder to see.
 *
 * ⭐ SO: the first slab starts at zero, each slab starts exactly one
 * paise after the previous ends, and exactly one slab — the last — is
 * open-ended. That is what every published slab table in the country
 * looks like, and anything else is a typo.
 */
function ladderRefinement<
  T extends { fromMinor: string; toMinor: string | null },
>(slabs: readonly T[], ctx: z.RefinementCtx): void {
  if (slabs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "A slab table with no slabs is not the same as no slab table. Leave the series absent instead — the engine says so on the payslip.",
    });
    return;
  }

  if (slabs[0]!.fromMinor !== "0") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The first slab must start at "0". A ladder that starts higher leaves the lowest earners uncovered and the shortfall is silent.',
    });
  }

  for (let i = 0; i < slabs.length; i += 1) {
    const slab = slabs[i]!;
    const last = i === slabs.length - 1;

    if (!last && slab.toMinor === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Slab ${i + 1} is open-ended but is not the last one. Only the top slab may have no upper bound.`,
      });
      continue;
    }
    if (last && slab.toMinor !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "The top slab must be open-ended. A capped top slab means an income above it is taxed at nothing at all.",
      });
    }
    if (slab.toMinor !== null && BigInt(slab.toMinor) < BigInt(slab.fromMinor)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Slab ${i + 1} ends before it begins.`,
      });
    }
    if (i > 0) {
      const prev = slabs[i - 1]!;
      if (prev.toMinor === null) continue;
      // ⚠️ EXACTLY ONE PAISE, because both bounds are inclusive. Every
      // comparison in the engine is `>= from && <= to`.
      if (BigInt(slab.fromMinor) !== BigInt(prev.toMinor) + 1n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Slab ${i + 1} starts at ${slab.fromMinor} paise but slab ${i} ends at ${prev.toMinor}. Slabs must be contiguous to the paise — a gap is income taxed by nothing and an overlap is income taxed twice.`,
        });
      }
    }
  }
}

const incomeTaxSlabPayload = z
  .object({
    slabs: z
      .array(
        z
          .object({
            fromMinor: minorField,
            toMinor: minorFieldNullable,
            rateBp: bpField,
          })
          .strict(),
      )
      .superRefine(ladderRefinement),
  })
  .strict();

const professionalTaxPayload = z
  .object({
    slabs: z
      .array(
        z
          .object({
            fromMinor: minorField,
            toMinor: minorFieldNullable,
            amountMinor: minorField,
            /**
             * ⭐ THE FEBRUARY TOP-UP. Maharashtra charges ₹300 in
             * February against ₹200 the rest of the year, and it is a
             * real rule rather than a rounding artefact — which is why
             * the payslip engine knows what month it is at all. Null
             * means the same amount every month.
             */
            februaryAmountMinor: minorFieldNullable,
          })
          .strict(),
      )
      .superRefine(ladderRefinement),
  })
  .strict();

/**
 * ⚠️ THE SCOPE IS PART OF THE RATE'S IDENTITY AND EACH KIND WANTS A
 * DIFFERENT ONE. A professional tax row with a null scope belongs to no
 * State, so `computeProfessionalTax` filters it out for everybody and
 * the row is invisible work. An income tax row with a null scope is
 * never selected by `loadRates`, which asks for `scope === regime`.
 * Both are rows that exist, look configured on a screen, and are read by
 * nothing.
 */
function validateScope(kind: string, scope: string | null): string | null {
  if (kind === "pf" || kind === "esi") {
    return scope === null ? null : "Provident fund and ESI are national. Leave the scope empty.";
  }
  if (kind === "income_tax" || kind === "income_tax_slab") {
    return scope === "new" || scope === "old"
      ? null
      : 'An income tax row belongs to a regime. The scope must be "new" or "old".';
  }
  if (kind === "professional_tax") {
    return scope !== null && /^[A-Z]{2}$/.test(scope)
      ? null
      : "Professional tax is a State tax. The scope must be a two-letter State code, and it is the State the employee WORKS in.";
  }
  return "Unknown rate kind.";
}

function validatePayload(
  kind: string,
  payload: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const schema =
    kind === "pf"
      ? pfPayload
      : kind === "esi"
        ? esiPayload
        : kind === "income_tax"
          ? incomeTaxPayload
          : kind === "income_tax_slab"
            ? incomeTaxSlabPayload
            : kind === "professional_tax"
              ? professionalTaxPayload
              : null;

  if (!schema) return { ok: false, error: "Unknown rate kind." };

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${first?.message ?? "The rate payload is not valid."}` };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}

/* ================================================================== */
/* ② READING THE TABLE                                                 */
/* ================================================================== */

/**
 * ⚠️ A parsed JSON object, or a refusal. Never a silently empty payload.
 *
 * ⭐ THE PAYLOAD ARRIVES AS TEXT AND IS PARSED HERE ON PURPOSE. The five
 * payload shapes are the law's shapes — a slab table is a list of
 * brackets and a PF row is seven fields — and a form that flattened all
 * of them into a common set of boxes would have to drop something. What
 * it would drop is a slab, silently, which is the failure the ladder
 * validation below exists to catch. So the screen shows the real object,
 * and every field of it is checked before it is written.
 */
function parsePayloadText(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "A rate payload is a JSON object." };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "That is not valid JSON. Nothing has been written." };
  }
}

export interface RateRowView {
  readonly id: string;
  readonly kind: string;
  readonly scope: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly payload: Record<string, unknown>;
  readonly note: string | null;
  readonly createdAt: string;
  /** ⭐ True for the row a payroll dated today would read. */
  readonly inForceToday: boolean;
  /** Runs whose `periodEnd` resolves to this row. Derived, not recorded. */
  readonly runs: readonly RunPeriod[];
  /** 🔴 Runs from that list that are approved or posted — the settled ones. */
  readonly settledRunNos: readonly string[];
  /** Ids of rows in the same series in force at the same time. Should be empty. */
  readonly overlapsWith: readonly string[];
}

export interface RateSeriesView {
  readonly key: string;
  readonly kind: string;
  readonly scope: string | null;
  readonly label: string;
  readonly resolution: "single" | "union";
  readonly rows: readonly RateRowView[];
  /** ⚠️ Empty means no rate is configured for today, which is a refusal to compute. */
  readonly inForceTodayIds: readonly string[];
}

const KIND_LABEL: Record<string, string> = {
  pf: "Provident fund",
  esi: "Employees' State Insurance",
  professional_tax: "Professional tax",
  income_tax: "Income tax",
  income_tax_slab: "Income tax slabs",
};

/**
 * ⭐⭐ THE WHOLE TABLE, GROUPED INTO SERIES, WITH TODAY MARKED AND EVERY
 * ROW ATTRIBUTED TO THE RUNS THAT READ IT.
 *
 * ⚠️ `today` IS AN ARGUMENT WITH A DEFAULT RATHER THAN A CALL TO
 * `new Date()` BURIED IN THE LOOP, so the answer is reproducible and the
 * test can ask what was in force on a day that is not today.
 *
 * 🔴 THE CLOCK IS UTC AND THE COLUMNS ARE PLAIN `date`. Formatting
 * today's date through a local zone would flip the "in force today" flag
 * on the exact day a rate changes, in Asia/Kolkata, which is where every
 * user of this product is.
 */
export async function listStatutoryRates(
  today?: string,
): Promise<ActionResult<{ series: readonly RateSeriesView[]; asOf: string; note: string }>> {
  try {
    const ctx = await requirePermission(READ);

    const asOf =
      typeof today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(today)
        ? today
        : new Date().toISOString().slice(0, 10);

    const { rows, runs } = await withTenant(ctx.tenant.id, async (tx) => {
      const rateRows = await tx
        .select()
        .from(statutoryRates)
        .where(eq(statutoryRates.tenantId, ctx.tenant.id))
        .orderBy(desc(statutoryRates.effectiveFrom));

      /**
       * ⚠️ EVERY RUN, NOT ONLY THE SETTLED ONES. A draft that already
       * read a rate is worth showing next to the row, because the person
       * about to change that rate wants to know a run is open against
       * it. The SETTLED subset is what gates the correction.
       */
      const runRows = await tx
        .select({
          id: payrollRuns.id,
          runNo: payrollRuns.runNo,
          periodStart: payrollRuns.periodStart,
          periodEnd: payrollRuns.periodEnd,
          status: payrollRuns.status,
        })
        .from(payrollRuns)
        .where(eq(payrollRuns.tenantId, ctx.tenant.id))
        .orderBy(desc(payrollRuns.periodStart));

      return { rows: rateRows, runs: runRows };
    });

    const periods: RatePeriod[] = rows.map(toPeriod);
    const runPeriods: RunPeriod[] = runs.map((r) => ({
      id: String(r.id),
      runNo: String(r.runNo),
      periodStart: String(r.periodStart),
      periodEnd: String(r.periodEnd),
      status: String(r.status),
    }));

    const bySeries = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = seriesKey(row.kind, row.scope);
      const bucket = bySeries.get(key);
      if (bucket) bucket.push(row);
      else bySeries.set(key, [row]);
    }

    const series: RateSeriesView[] = [...bySeries.entries()]
      .map(([key, seriesRows]) => {
        const head = seriesRows[0]!;
        const seriesPeriods = periods.filter(
          (p) => seriesKey(p.kind, p.scope) === key,
        );
        const liveToday = rowsInForceOn(seriesPeriods, asOf).map((r) => r.id);

        const viewRows: RateRowView[] = [...seriesRows]
          .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)))
          .map((row) => {
            const period = toPeriod(row);
            const usedBy = runsUsingRow({
              rowId: period.id,
              series: seriesPeriods,
              runs: runPeriods,
            });
            return {
              id: String(row.id),
              kind: String(row.kind),
              scope: row.scope === null ? null : String(row.scope),
              effectiveFrom: String(row.effectiveFrom),
              effectiveTo: row.effectiveTo === null ? null : String(row.effectiveTo),
              payload: row.payload,
              note: row.note,
              createdAt:
                row.createdAt instanceof Date
                  ? row.createdAt.toISOString()
                  : String(row.createdAt),
              inForceToday: liveToday.includes(String(row.id)),
              runs: usedBy,
              settledRunNos: usedBy.filter((r) => isSettled(r.status)).map((r) => r.runNo),
              overlapsWith: findOverlaps(seriesPeriods, period).map((r) => r.id),
            };
          });

        return {
          key,
          kind: String(head.kind),
          scope: head.scope === null ? null : String(head.scope),
          label: `${KIND_LABEL[String(head.kind)] ?? String(head.kind)}${head.scope ? ` · ${String(head.scope)}` : ""}`,
          resolution: resolutionFor(String(head.kind)),
          rows: viewRows,
          inForceTodayIds: liveToday,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      ok: true,
      data: {
        series,
        asOf,
        note: "Which runs used which row is worked out by replaying the engine's own selection at each run's period end. It is a derivation, not a record: correcting a row's dates changes the answer retrospectively.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

function toPeriod(row: {
  id: string;
  kind: string;
  scope: string | null;
  effectiveFrom: unknown;
  effectiveTo: unknown;
}): RatePeriod {
  return {
    id: String(row.id),
    kind: String(row.kind),
    scope: row.scope === null ? null : String(row.scope),
    effectiveFrom: String(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : String(row.effectiveTo),
  };
}

/* ================================================================== */
/* ③ THE CHANGE DOOR                                                   */
/* ================================================================== */

const revisionSchema = z.object({
  kind: z.enum(RATE_KINDS),
  scope: z.string().trim().max(20).nullish(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "An effective date is required."),
  /** ⚠️ Text, parsed here, so a malformed body is a message and not a 500. */
  payloadJson: z.string().min(2).max(20_000),
  note: z
    .string()
    .trim()
    .min(10, "Say what changed and where the number came from. In a year this line is the only record of why.")
    .max(2_000),
});

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ A CHANGE: A NEW ROW, FROM A DATE, THAT RESTATES NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * The ordinary door, and it must stay ordinary. A Budget change is
 * routine maintenance that happens every February and a workflow with
 * ceremony on it is a workflow people route around with psql.
 *
 * 🔴 IT REFUSES IN THREE PLACES AND EACH REFUSAL IS A DIFFERENT FAILURE:
 *
 *   1. An OVERLAP with an existing row in the same series. Two rows in
 *      force on one day makes payroll non-deterministic — an arbitrary
 *      pick for `pf`/`esi`/`income_tax`, a double-counted slab ladder for
 *      `professional_tax`/`income_tax_slab`.
 *
 *   2. A write that would RESTATE a settled run. That is a correction
 *      wearing a change's clothes, and it is sent to the other door with
 *      the affected runs named. This is the check that makes the
 *      change/correction distinction structural rather than a promise.
 *
 *   3. A payload the engine would misread. See `validatePayload`.
 *
 * ⚠️ AND IT NEVER TOUCHES THE OLD ROW'S PAYLOAD OR ITS START DATE. It
 * closes the open-ended incumbent at the day before the new row starts,
 * which removes it from no date it was already resolving for — and even
 * that is put through the diff in (2) before it is written.
 */
export async function addRateRevision(
  input: unknown,
): Promise<ActionResult<{ id: string; closedRowId: string | null; note: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = revisionSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the form.",
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const d = parsed.data;
    const scope = d.scope === undefined || d.scope === null || d.scope === "" ? null : d.scope;

    const scopeError = validateScope(d.kind, scope);
    if (scopeError) return { ok: false, error: scopeError };

    const payloadText = parsePayloadText(d.payloadJson);
    if (!payloadText.ok) return { ok: false, error: payloadText.error };
    const payload = validatePayload(d.kind, payloadText.value);
    if (!payload.ok) return { ok: false, error: payload.error };

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ id: string; closedRowId: string | null }>> => {
        const { series, runs } = await loadSeriesAndRuns(tx, ctx.tenant.id, d.kind, scope);

        /**
         * ⚠️ A PLACEHOLDER ID, BECAUSE THE ROW DOES NOT EXIST YET AND
         * THE OVERLAP CHECK COMPARES BY ID. Anything that cannot collide
         * with a uuid works; "candidate" cannot.
         */
        const candidate: RatePeriod = {
          id: "candidate",
          kind: d.kind,
          scope,
          effectiveFrom: d.effectiveFrom,
          effectiveTo: null,
        };

        const incumbent = openIncumbent(series, d.kind, scope);

        /**
         * 🔴 THE SAME START DATE IS ITS OWN REFUSAL, CHECKED FIRST FOR
         * THE SAKE OF THE MESSAGE. Two rows sharing an `effective_from`
         * is the one overlap even `pickEffective`'s "latest start wins"
         * tie-break cannot resolve — the winner is whichever order
         * Postgres returned them in, which can differ between two runs
         * of the same payroll.
         */
        if (series.some((r) => r.effectiveFrom === d.effectiveFrom)) {
          return {
            error: `A rate for this series already starts on ${d.effectiveFrom}. Two rows starting the same day is the one case where even "latest start wins" cannot choose between them, and the same payroll could compute differently twice. If that row is wrong, correct it.`,
          };
        }

        // 🔴 (1) OVERLAP. Checked against the series as it would be after
        // the incumbent is closed, so the ordinary "new rate supersedes
        // the open one" case is not reported as an overlap against
        // itself.
        const projected = withRevision(series, candidate);
        const overlaps = findOverlaps(projected, candidate);
        if (overlaps.length > 0) {
          const names = overlaps
            .map((r) => `${r.effectiveFrom} to ${r.effectiveTo ?? "open"}`)
            .join("; ");
          return {
            error: `A rate for this series is already in force over that period (${names}). Two rows in force on the same day means payroll picks one of them arbitrarily, so this is refused rather than written. Close the existing period first, or correct it.`,
          };
        }

        // 🔴 (2) WOULD THIS RESTATE ANYTHING SETTLED?
        const settled = runs.filter((r) => isSettled(r.status));
        const restated = runsResolvedDifferently({
          before: series,
          after: projected,
          runs: settled,
        });
        if (restated.length > 0) {
          return {
            error: `A rate starting ${d.effectiveFrom} would change what ${describeRuns(restated)} computed — ${restated.length === 1 ? "that run has" : "those runs have"} already been signed off and the payslips are with the employees. That is a correction to history, not a rate change, and it is a separate action that records a reason and names the runs it restates.`,
          };
        }

        const closedRowId =
          incumbent && incumbent.effectiveTo === null && incumbent.effectiveFrom < d.effectiveFrom
            ? incumbent.id
            : null;

        if (closedRowId) {
          /**
           * ⭐ THE ONLY WRITE THIS ACTION MAKES TO AN EXISTING ROW, AND
           * IT IS A DATE, NEVER A NUMBER. The incumbent's payload is
           * untouched, so a payslip reissued for any month it covered
           * still reproduces the figure that was actually paid.
           */
          await tx
            .update(statutoryRates)
            .set({ effectiveTo: previousDay(d.effectiveFrom) })
            .where(
              and(
                eq(statutoryRates.tenantId, ctx.tenant.id),
                eq(statutoryRates.id, closedRowId),
              ),
            );
        }

        const [inserted] = await tx
          .insert(statutoryRates)
          .values({
            tenantId: ctx.tenant.id,
            kind: d.kind,
            scope,
            effectiveFrom: d.effectiveFrom,
            effectiveTo: null,
            payload: payload.value,
            note: d.note,
            createdBy: ctx.user.id,
          })
          .returning({ id: statutoryRates.id });

        return { id: inserted?.id ?? "", closedRowId };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "statutory_rates",
      resourceId: outcome.id,
      newValue: {
        kind: d.kind,
        scope,
        effectiveFrom: d.effectiveFrom,
        payload: payload.value,
      },
      metadata: { closedRowId: outcome.closedRowId, restatesHistory: false },
      reason: d.note,
      severity: "notice",
    });

    revalidatePath("/payroll/rates");
    return {
      ok: true,
      data: {
        id: outcome.id,
        closedRowId: outcome.closedRowId,
        note: outcome.closedRowId
          ? `Added. The previous rate has been closed on ${previousDay(d.effectiveFrom)} and its numbers are untouched, so any payslip reissued for an earlier month still reproduces what was actually paid.`
          : "Added. Nothing existing was changed.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ================================================================== */
/* ④ THE CORRECTION DOOR                                               */
/* ================================================================== */

const correctionSchema = z.object({
  rowId: z.string().uuid(),
  payloadJson: z.string().min(2).max(20_000),
  /**
   * ⭐ THE DATES ARE CORRECTABLE TOO, AND THAT IS NOT SCOPE CREEP. The
   * commonest statutory typo after a wrong figure is a wrong START —
   * a Budget change entered as 1 April when the notification said
   * 1 July. Sending somebody to psql for the second-commonest case
   * defeats the whole batch.
   */
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  reason: z
    .string()
    .trim()
    .min(
      20,
      "A correction restates payslips people have already been given. Twenty characters is not much to ask for the reason.",
    )
    .max(2_000),
  /**
   * 🔴🔴 THE RUN NUMBERS THE CALLER BELIEVES THIS AFFECTS.
   *
   * ⚠️ THIS IS NOT A CHECKBOX AND IT IS NOT DECORATION. The server
   * computes the list itself and REFUSES if what it was sent disagrees —
   * including if it was sent an empty list and the real answer is three
   * runs. A confirmation dialog the caller can satisfy without reading
   * is a confirmation dialog that confirms nothing, and the failure mode
   * this guards is precise: somebody opens the correction screen, a
   * colleague approves another run in the next tab, and the correction
   * lands on one more month than the person authorised.
   */
  acknowledgeRuns: z.array(z.string().trim().max(30)).max(500),
});

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 A CORRECTION: THE ONE ACTION THAT REWRITES HISTORY
 * ══════════════════════════════════════════════════════════════════════
 * Everything else in this file exists so that this function is rarely
 * needed. It is still needed. The alternative to correcting a typo in a
 * rate two payrolls used is a system that reproduces a known-wrong
 * figure forever, and that is not a safer system — it is one that lies
 * quietly instead of loudly.
 *
 * ⭐ WHAT MAKES IT DIFFERENT FROM `addRateRevision`, IN ORDER:
 *
 *   • TWO PERMISSIONS, at the export, where `check:guards` can see both.
 *     `payroll.manage` is who maintains rates. `payroll.approve` is who
 *     signs off a wage bill. Restating a settled run rewrites what was
 *     signed off, so it needs the signing key as well. (The key I
 *     actually want, `payroll.rates.correct`, does not exist and cannot
 *     be added this batch — see the header.)
 *
 *   • A REASON OF AT LEAST TWENTY CHARACTERS, written into the row's own
 *     note AND into the audit log, because the audit log is where a
 *     reviewer looks and the note is where the next payroll operator
 *     looks, and they are not the same person.
 *
 *   • AN ACKNOWLEDGEMENT THAT NAMES THE RUNS, checked against the
 *     server's own list. See `acknowledgeRuns`.
 *
 *   • THE SUPERSEDED FIGURES PRESERVED IN THE NOTE. There is no
 *     `previous_payload` column, so the row's own `note` carries the
 *     numbers this correction replaced. It is a text field doing a
 *     column's job and I would rather say that out loud than lose the
 *     old figures entirely — without them, "the ceiling was corrected"
 *     does not tell anybody what it was corrected FROM, and the payslips
 *     in employees' inboxes become unexplainable.
 *
 * ⚠️ IT IS DELIBERATELY NOT AVAILABLE FOR A ROW NO SETTLED RUN USED.
 * That case is not a correction — nothing is being restated — and it
 * belongs at the ordinary door. Two ways to do the harmless thing is one
 * way too many, and the second one is the one people learn.
 */
export async function correctStatutoryRate(
  input: unknown,
): Promise<ActionResult<{ id: string; restatedRuns: readonly string[]; note: string }>> {
  try {
    const ctx = await requireAllPermissions([MANAGE, APPROVE]);
    const parsed = correctionSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { ok: false, error: first?.message ?? "Check the form." };
    }
    const d = parsed.data;
    const effectiveTo = d.effectiveTo === undefined || d.effectiveTo === null ? null : d.effectiveTo;

    if (effectiveTo !== null && effectiveTo < d.effectiveFrom) {
      return { ok: false, error: "A rate cannot stop applying before it starts." };
    }

    const payloadText = parsePayloadText(d.payloadJson);
    if (!payloadText.ok) return { ok: false, error: payloadText.error };

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ id: string; restated: readonly string[] }>> => {
        const [existing] = await tx
          .select()
          .from(statutoryRates)
          .where(
            and(eq(statutoryRates.tenantId, ctx.tenant.id), eq(statutoryRates.id, d.rowId)),
          )
          .limit(1);

        if (!existing) return { error: "No such rate row." };

        const payload = validatePayload(String(existing.kind), payloadText.value);
        if (!payload.ok) return { error: payload.error };

        const scope = existing.scope === null ? null : String(existing.scope);
        const { series, runs } = await loadSeriesAndRuns(
          tx,
          ctx.tenant.id,
          String(existing.kind),
          scope,
        );

        const before = toPeriod(existing);
        const after: RatePeriod = {
          ...before,
          effectiveFrom: d.effectiveFrom,
          effectiveTo,
        };

        // 🔴 AN OVERLAP IS STILL REFUSED, EVEN HERE. A correction is
        // permission to restate history, never permission to make
        // payroll non-deterministic. The two are unrelated and
        // collapsing them would make the loud door a way round the
        // quiet check.
        const projected = series.map((r) => (r.id === after.id ? after : r));
        const overlaps = findOverlaps(projected, after);
        if (overlaps.length > 0) {
          const names = overlaps
            .map((r) => `${r.effectiveFrom} to ${r.effectiveTo ?? "open"}`)
            .join("; ");
          return {
            error: `Those dates would put this row in force at the same time as another (${names}). Two rows in force on one day means payroll reads an arbitrary one, and no reason justifies that.`,
          };
        }

        /**
         * ⭐⭐ THE BLAST RADIUS, COMPUTED TWO WAYS BECAUSE THERE ARE TWO
         * WAYS TO RESTATE A RUN.
         *
         *   • The run's SELECTION changes — this row moves in or out of
         *     what it reads. `runsResolvedDifferently` catches that.
         *   • The run still reads this row and the NUMBERS in it change.
         *     No set moves, so only `runsUsingRow` catches that, and it
         *     is by far the commoner case: a typo fix leaves the dates
         *     alone.
         *
         * ⚠️ A correction that changes neither is possible — an edit to
         * a row nothing settled ever read — and it is refused below
         * rather than silently allowed through the loud door.
         */
        const settled = runs.filter((r) => isSettled(r.status));
        const bySelection = runsResolvedDifferently({
          before: series,
          after: projected,
          runs: settled,
        });
        const byPayload = runsUsingRow({ rowId: before.id, series, runs: settled });

        const restatedMap = new Map<string, RunPeriod>();
        for (const r of [...bySelection, ...byPayload]) restatedMap.set(r.id, r);
        const restated = [...restatedMap.values()].sort((a, b) =>
          a.periodStart.localeCompare(b.periodStart),
        );

        if (restated.length === 0) {
          return {
            error:
              "No approved or posted run reads this row, so nothing is being restated and this is not a correction. Add a new dated row at the ordinary door instead — that leaves the history intact and is what you want here.",
          };
        }

        /**
         * 🔴 THE ACKNOWLEDGEMENT MUST MATCH EXACTLY, BOTH WAYS. Missing
         * a run means the caller was shown a shorter list than the truth
         * — most likely because somebody approved a run while this
         * screen was open. Naming an extra one means the caller is
         * working from a stale page and does not know what they are
         * about to change.
         */
        const expected = [...restated.map((r) => r.runNo)].sort();
        const acknowledged = [...d.acknowledgeRuns].sort();
        if (expected.join("|") !== acknowledged.join("|")) {
          return {
            error: `This correction restates ${describeRuns(restated)}. That is not the list you confirmed, so nothing has been written — reload the screen and read it again before confirming.`,
          };
        }

        /**
         * ⭐ THE SUPERSEDED FIGURES, KEPT IN THE ROW'S OWN NOTE.
         *
         * 🔴 THIS IS A TEXT COLUMN DOING A DATA COLUMN'S JOB and it is
         * the compromise this batch is stuck with. What belongs here is
         * `superseded_payload jsonb`, `corrected_at`, `corrected_by` and
         * `correction_reason` — a real correction record. Without them,
         * losing the old numbers would mean nobody could ever explain a
         * payslip issued before the correction, which is the exact
         * failure the whole batch is about.
         */
        const stamp = [
          `— CORRECTED ${new Date().toISOString().slice(0, 10)} —`,
          `Restates: ${restated.map((r) => `${r.runNo} (${r.status})`).join(", ")}.`,
          `Reason: ${d.reason}`,
          `Superseded figures: ${JSON.stringify(existing.payload)}`,
          `Superseded period: ${String(existing.effectiveFrom)} to ${existing.effectiveTo === null ? "open" : String(existing.effectiveTo)}.`,
        ].join("\n");

        await tx
          .update(statutoryRates)
          .set({
            payload: payload.value,
            effectiveFrom: d.effectiveFrom,
            effectiveTo,
            note: existing.note ? `${existing.note}\n\n${stamp}` : stamp,
          })
          .where(
            and(eq(statutoryRates.tenantId, ctx.tenant.id), eq(statutoryRates.id, d.rowId)),
          );

        return { id: d.rowId, restated: restated.map((r) => r.runNo) };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    /**
     * ⚠️ `critical`, AND THE OLD ROW IN FULL. This is the only entry in
     * the audit log that records money already paid being restated, and
     * it is the only place the previous figures survive in machine-
     * readable form. Anything less than the whole row here and a
     * reviewer six months out cannot reconstruct what a payslip was
     * computed from.
     */
    await writeAudit(ctx, {
      action: "update",
      resourceType: "statutory_rates",
      resourceId: outcome.id,
      newValue: { effectiveFrom: d.effectiveFrom, effectiveTo, payload: payloadText.value },
      metadata: { restatesHistory: true, restatedRuns: outcome.restated },
      reason: d.reason,
      severity: "critical",
    });

    revalidatePath("/payroll/rates");
    return {
      ok: true,
      data: {
        id: outcome.id,
        restatedRuns: outcome.restated,
        note: `Corrected. ${outcome.restated.join(", ")} ${outcome.restated.length === 1 ? "was" : "were"} computed against the old figures and any payslip reissued from ${outcome.restated.length === 1 ? "it" : "them"} will now show the new ones. The payslips those runs already produced are frozen in the database and are unchanged — the two now disagree, and telling the affected employees is a thing a person has to do.`,
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ================================================================== */
/* SHARED LOADING                                                      */
/* ================================================================== */

type Refusal = { error: string };
type Ok<T> = T & { error?: undefined };
type Outcome<T> = Refusal | Ok<T>;

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⭐ ONE SERIES AND EVERY RUN.
 *
 * ⚠️ THE SERIES IS NARROWED IN SQL AND THE RUNS ARE NOT. Narrowing runs
 * by date would need the series' own dates first, and getting that
 * predicate subtly wrong would UNDERSTATE the blast radius of a
 * correction — a refusal that fires too rarely is worse than a query
 * that reads a few hundred rows.
 */
async function loadSeriesAndRuns(
  tx: Tx,
  tenantId: string,
  kind: string,
  scope: string | null,
): Promise<{ series: RatePeriod[]; runs: RunPeriod[] }> {
  const rows = await tx
    .select({
      id: statutoryRates.id,
      kind: statutoryRates.kind,
      scope: statutoryRates.scope,
      effectiveFrom: statutoryRates.effectiveFrom,
      effectiveTo: statutoryRates.effectiveTo,
    })
    .from(statutoryRates)
    .where(
      and(
        eq(statutoryRates.tenantId, tenantId),
        eq(statutoryRates.kind, kind),
        scope === null
          ? sql`${statutoryRates.scope} IS NULL`
          : eq(statutoryRates.scope, scope),
      ),
    );

  const runRows = await tx
    .select({
      id: payrollRuns.id,
      runNo: payrollRuns.runNo,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      status: payrollRuns.status,
    })
    .from(payrollRuns)
    .where(eq(payrollRuns.tenantId, tenantId));

  return {
    series: rows.map(toPeriod),
    runs: runRows.map((r) => ({
      id: String(r.id),
      runNo: String(r.runNo),
      periodStart: String(r.periodStart),
      periodEnd: String(r.periodEnd),
      status: String(r.status),
    })),
  };
}
