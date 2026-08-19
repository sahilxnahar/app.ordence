/**
 * Ordence — ⭐⭐⭐ EFFECTIVE-DATED RATE PERIODS
 * Version: v1.46.0-alpha · Batch 52
 *
 * Pure. No database, no network, no clock. Every date is an argument,
 * for the same reason `lib/payroll/statutory.ts` is: this is the module
 * that decides whether a rate change restates a payslip somebody is
 * already holding, and that decision has to be testable by hand.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `statutory_rates` has been effective-dated since Batch 15 and there
 * has never been a way to write a second row into it. `seedPayrollSetup`
 * inserts opening figures once and deliberately never overwrites. After
 * that, a wrong PF ceiling — or the Finance Act moving a slab, which
 * happens every February — was a code deploy or a psql prompt.
 *
 * ⚠️ AND A psql PROMPT IS THE DANGEROUS ONE, because the obvious thing
 * to type is `UPDATE statutory_rates SET payload = ...`. That single
 * statement silently restates every payroll ever computed against that
 * row. Nothing errors. Nothing is logged. The next time anybody reissues
 * March's payslip it prints a different number from the one in the
 * employee's inbox, and the employee is the one who finds out.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE SELECTION RULE HERE MUST BE THE ENGINE'S, NOT A COPY OF IT
 * ══════════════════════════════════════════════════════════════════════
 * Everything below answers one question: given a set of rows and a date,
 * WHICH ROWS DOES A PAYROLL RUN ON THAT DATE ACTUALLY READ. If this file
 * answers it differently from `server/payroll/run.ts`, the screen shows
 * a rate history that is confidently wrong, which is worse than showing
 * none — an auditor would believe it.
 *
 * So `rowsInForceOn` delegates the hard half to `pickEffective`, the
 * engine's own function, rather than reimplementing "latest start wins".
 *
 * 🔴 AND THE ENGINE RESOLVES TWO KINDS OF SERIES DIFFERENTLY, WHICH IS
 * NOT OBVIOUS AND IS THE MOST IMPORTANT FACT IN THIS FILE. See
 * `resolutionFor` below.
 */

import { pickEffective, type EffectiveDated } from "@/lib/payroll/statutory";

/* ------------------------------------------------------------------ */
/* THE KINDS                                                           */
/* ------------------------------------------------------------------ */

/**
 * The five `statutory_rates.kind` values the engine knows how to read.
 * Anything else in the column is a row `loadRates` silently ignores, so
 * the maintenance screen refuses to write one rather than offering a
 * free-text box that produces rows nothing will ever read.
 */
export const RATE_KINDS = [
  "pf",
  "esi",
  "professional_tax",
  "income_tax",
  "income_tax_slab",
] as const;

export type RateKind = (typeof RATE_KINDS)[number];

export function isRateKind(value: string): value is RateKind {
  return (RATE_KINDS as readonly string[]).includes(value);
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 TWO RESOLUTION RULES, AND CONFUSING THEM CORRUPTS DIFFERENTLY
 * ══════════════════════════════════════════════════════════════════════
 *
 * "single" — `pf`, `esi`, `income_tax`. `loadRates` calls
 * `pickEffective` on these, so exactly ONE row wins on any given day and
 * the rest are ignored. An overlap here is a silent arbitrary pick:
 * latest `effective_from` wins, and if two rows share an
 * `effective_from` the winner depends on the order Postgres happened to
 * return them. Payroll stops being a function of its inputs.
 *
 * "union" — `professional_tax`, `income_tax_slab`. `loadRates` does NOT
 * call `pickEffective` on these. It `flatMap`s EVERY row in force on the
 * date into one flat list of slabs, because a State's slab table is
 * legitimately several slabs and they all apply together.
 *
 * ⚠️ SO AN OVERLAP IN A "union" SERIES IS WORSE THAN AN ARBITRARY PICK.
 * Two `income_tax_slab` rows for the new regime both in force on the
 * same day are concatenated, `projectMonthlyTds` sorts the combined list
 * by `fromMinor` and walks it, and the employee is taxed through TWO
 * overlapping slab ladders — the same band charged twice. The result is
 * a confident, plausible, roughly-double TDS figure with nothing in the
 * system reporting a problem.
 *
 * 🔴 Two overlapping `professional_tax` rows for one State are the same
 * shape: `computeProfessionalTax` filters by state and date and takes
 * the FIRST slab whose bracket contains the salary. Which of the two
 * tables that comes from is array order, i.e. nothing.
 *
 * ⭐ THIS IS WHY THE SCREEN REFUSES OVERLAPS FOR EVERY KIND rather than
 * only for the ones `pickEffective` touches. The "union" kinds need it
 * more, not less.
 */
export type Resolution = "single" | "union";

export function resolutionFor(kind: string): Resolution {
  return kind === "professional_tax" || kind === "income_tax_slab" ? "union" : "single";
}

/* ------------------------------------------------------------------ */
/* THE SHAPES                                                          */
/* ------------------------------------------------------------------ */

/** One `statutory_rates` row, reduced to what period arithmetic needs. */
export interface RatePeriod extends EffectiveDated {
  readonly id: string;
  readonly kind: string;
  /** State code for professional tax, regime for income tax, else null. */
  readonly scope: string | null;
}

/**
 * ⭐ A SERIES IS `kind` + `scope`, AND THE SCOPE IS PART OF THE IDENTITY.
 *
 * ⚠️ Karnataka's professional tax and Maharashtra's are not two versions
 * of one rate — they are two independent effective-dated series that
 * happen to share a `kind`. Treating them as one series would report
 * every State's table as overlapping every other State's, and the
 * overlap refusal would be unusable and therefore switched off.
 */
export function seriesKey(kind: string, scope: string | null): string {
  return `${kind}::${scope ?? ""}`;
}

/** One payroll run, reduced to what period arithmetic needs. */
export interface RunPeriod {
  readonly id: string;
  readonly runNo: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: string;
}

/**
 * ⭐⭐ THE RUNS WHOSE NUMBERS ARE SETTLED.
 *
 * `approved` froze the payslips and `posted` put the wage bill in the
 * ledger. Both mean a figure has left this system: an employee has the
 * payslip, and in the posted case the general ledger has the journal.
 * Restating either is a real-world event, not a database edit.
 *
 * ⚠️ `draft` AND `computed` ARE DELIBERATELY NOT SETTLED. Those are
 * calculations somebody is still editing, and treating them as settled
 * would mean an abandoned draft from last March permanently blocks
 * every future rate change — which is exactly the kind of obstacle
 * whose first fix is to delete the check.
 *
 * `cancelled` is excluded because the money never moved.
 */
export function isSettled(status: string): boolean {
  return status === "approved" || status === "posted";
}

/* ------------------------------------------------------------------ */
/* DATE ARITHMETIC                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ UTC, ALWAYS, AND NEVER THE LOCAL CLOCK. These are `date` columns
 * with no time and no zone. Parsing "2025-04-01" in IST and formatting
 * it back gives 2025-03-31 for half the world, which would close a rate
 * period one day early and hand one day of April's payroll to March's
 * ceiling.
 */
export function previousDay(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

export function nextDay(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + 86_400_000).toISOString().slice(0, 10);
}

/**
 * ⭐ INCLUSIVE AT BOTH ENDS, WHICH IS WHAT THE COLUMNS MEAN.
 *
 * `effective_to` is the LAST day the row applies, not the first day it
 * does not. A half-open reading here would call a row ending 31 March
 * and a row starting 1 April an overlap, and every legitimate rate
 * change in the country would be refused.
 */
export function periodsOverlap(
  a: EffectiveDated,
  b: EffectiveDated,
): boolean {
  const aEnd = a.effectiveTo;
  const bEnd = b.effectiveTo;
  const aStartsBeforeBEnds = bEnd === null || a.effectiveFrom <= bEnd;
  const bStartsBeforeAEnds = aEnd === null || b.effectiveFrom <= aEnd;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/**
 * Every row in the same series that would be in force at the same time
 * as `candidate`. `candidate.id` is excluded so an edit does not report
 * itself.
 *
 * 🔴 THIS IS THE REFUSAL, NOT A WARNING. Two rows in force on one day is
 * not a cosmetic problem — see `resolutionFor` above for what each kind
 * does with it. An overlap that is written and then flagged is an
 * overlap that produced payslips before anybody read the flag.
 */
export function findOverlaps<T extends RatePeriod>(
  series: readonly T[],
  candidate: RatePeriod,
): T[] {
  return series.filter(
    (r) =>
      r.id !== candidate.id &&
      seriesKey(r.kind, r.scope) === seriesKey(candidate.kind, candidate.scope) &&
      periodsOverlap(r, candidate),
  );
}

/* ------------------------------------------------------------------ */
/* WHAT A RUN ON A GIVEN DAY ACTUALLY READS                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE ROWS OF ONE SERIES A PAYROLL DATED `onDate` WOULD LOAD.
 *
 * ⚠️ `series` MUST ALREADY BE ONE SERIES. Passing a mixed list would
 * make `pickEffective` choose between Karnataka's slabs and
 * Maharashtra's on the basis of which was notified more recently.
 */
export function rowsInForceOn<T extends RatePeriod>(
  series: readonly T[],
  onDate: string,
): T[] {
  const live = series.filter(
    (r) => r.effectiveFrom <= onDate && (r.effectiveTo === null || r.effectiveTo >= onDate),
  );
  if (live.length === 0) return [];

  if (resolutionFor(live[0]!.kind) === "union") return live;

  // 🔴 THE ENGINE'S OWN FUNCTION. Reimplementing "latest start wins"
  // here would be two implementations of one rule, and the day they
  // diverge is the day this screen starts lying about history.
  const winner = pickEffective(live, onDate);
  return winner ? [winner] : [];
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WHICH RUNS READ THIS ROW
 * ══════════════════════════════════════════════════════════════════════
 * This is the answer design point 3 asks for, and it is derived rather
 * than recorded, because there is no column recording it. See the report
 * in `server/actions/statutory-rates.ts` for the column that would make
 * this a fact instead of an inference.
 *
 * 🔴 THE DATE IS THE RUN'S `periodEnd`, AND THAT IS NOT A CHOICE MADE
 * HERE. `computeRun` calls `loadRates(tx, tenantId, args.periodEnd)`.
 * If that ever becomes `periodStart`, this function silently attributes
 * runs to the wrong rows in exactly the month a rate changed — the one
 * month anybody is looking. `tests/ui/statutory-rates.test.ts` asserts
 * the engine still passes `periodEnd`, so the two cannot drift quietly.
 *
 * ⚠️ FOR PROFESSIONAL TAX THIS SAYS "IN FORCE FOR THIS RUN", NOT "USED
 * ON SOMEBODY'S PAYSLIP". A run containing nobody working in West
 * Bengal still loads West Bengal's slabs and simply finds no employee
 * they apply to. Narrowing this by the States actually present would
 * mean reading every payslip, and it would UNDERSTATE the blast radius
 * of a correction — the direction that matters is overstating it.
 */
export function runsUsingRow(args: {
  readonly rowId: string;
  readonly series: readonly RatePeriod[];
  readonly runs: readonly RunPeriod[];
}): RunPeriod[] {
  return args.runs.filter((run) => {
    if (run.status === "cancelled") return false;
    return rowsInForceOn(args.series, run.periodEnd).some((r) => r.id === args.rowId);
  });
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE FUNCTION THAT DECIDES CHANGE vs CORRECTION
 * ══════════════════════════════════════════════════════════════════════
 * Given the series as it is (`before`) and as it would be (`after`), the
 * runs whose SELECTION changes. If this list is empty the write only
 * affects periods nobody has been paid for yet — that is a CHANGE, and
 * `payroll.manage` is enough. If it is not empty the write restates
 * money that has already left, and that is a CORRECTION.
 *
 * ⭐ IT COMPARES RESOLVED ROW SETS RATHER THAN GUESSING FROM DATES.
 * "Is `effectiveFrom` in the past" is the obvious test and it is wrong
 * in both directions: a back-dated row in a period an incumbent already
 * covers with a LATER start changes nothing under `pickEffective`, and a
 * forward-dated row can still change a "union" series if a settled run's
 * period end falls after it. Resolving both worlds and diffing is the
 * only test that cannot disagree with the engine.
 *
 * ⚠️ THIS CATCHES SET CHANGES ONLY. Editing a row's PAYLOAD while
 * leaving its dates alone changes no set and is caught by
 * `runsUsingRow` instead. A correction has to check both, and
 * `correctStatutoryRate` does.
 */
export function runsResolvedDifferently(args: {
  readonly before: readonly RatePeriod[];
  readonly after: readonly RatePeriod[];
  readonly runs: readonly RunPeriod[];
}): RunPeriod[] {
  return args.runs.filter((run) => {
    if (run.status === "cancelled") return false;
    const b = rowsInForceOn(args.before, run.periodEnd)
      .map((r) => r.id)
      .sort();
    const a = rowsInForceOn(args.after, run.periodEnd)
      .map((r) => r.id)
      .sort();
    return b.join("|") !== a.join("|");
  });
}

/**
 * ⭐ THE SERIES AS IT WOULD BE AFTER INSERTING `candidate` AND CLOSING
 * THE INCUMBENT THE DAY BEFORE.
 *
 * 🔴 CLOSING THE INCUMBENT IS THE ONLY EDIT A CHANGE MAKES TO AN
 * EXISTING ROW, and it is defensible precisely because it cannot restate
 * anything: setting `effective_to` to the day before the successor
 * starts removes the row from no date it was previously in force on
 * *and already resolved for*. `runsResolvedDifferently` is still run
 * over the result rather than trusted — if the arithmetic above is ever
 * wrong, the diff catches it and the write is refused.
 *
 * ⚠️ ONLY THE OPEN-ENDED INCUMBENT IS CLOSED. A row that already has an
 * `effective_to` was closed by somebody deliberately, and silently
 * moving it would be the mutation this whole file exists to prevent.
 *
 * 🔴🔴 EXACTLY ONE ROW IS CLOSED, AND "EXACTLY" IS LOAD-BEARING. If a
 * series has already gone wrong and carries TWO open-ended rows — from
 * an import, or a psql prompt, or the day before the overlap refusal
 * existed — closing both here would model something the caller does not
 * do. `addRateRevision` issues one UPDATE, against the incumbent with
 * the latest start. A projection that tidied up the other one would show
 * no overlap, the write would go through, and the stray open row would
 * then be in force alongside the new rate: a fresh overlap, created by
 * the very function whose job is to refuse them.
 *
 * ⭐ SO THIS MODELS THE ONE WRITE FAITHFULLY, `findOverlaps` sees the
 * leftover open row, and the write is refused with the existing mess
 * named. Fixing that mess is a correction, which is the right door.
 */
export function withRevision<T extends RatePeriod>(
  series: readonly T[],
  candidate: T,
): T[] {
  const key = seriesKey(candidate.kind, candidate.scope);
  const closedDay = previousDay(candidate.effectiveFrom);
  const incumbent = openIncumbent(
    series.filter((r) => r.id !== candidate.id),
    candidate.kind,
    candidate.scope,
  );
  const closes =
    incumbent !== null && incumbent.effectiveFrom < candidate.effectiveFrom
      ? incumbent.id
      : null;

  const adjusted = series.map((r) => {
    if (seriesKey(r.kind, r.scope) !== key) return r;
    if (r.id !== closes) return r;
    return { ...r, effectiveTo: closedDay };
  });

  return [...adjusted.filter((r) => r.id !== candidate.id), candidate];
}

/**
 * The open-ended row of a series, if there is one. There should be at
 * most one; more than one is an overlap and is reported as such.
 */
export function openIncumbent<T extends RatePeriod>(
  series: readonly T[],
  kind: string,
  scope: string | null,
): T | null {
  const key = seriesKey(kind, scope);
  const open = series.filter((r) => seriesKey(r.kind, r.scope) === key && r.effectiveTo === null);
  if (open.length === 0) return null;
  return [...open].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]!;
}

/* ------------------------------------------------------------------ */
/* PRESENTATION                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A SENTENCE NAMING THE RUNS, FOR THE CONFIRMATION AND THE AUDIT.
 *
 * ⚠️ IT NAMES THEM RATHER THAN COUNTING THEM. "3 runs affected" is a
 * number somebody clicks past. "PR-2025-04, PR-2025-05 and PR-2025-06
 * will be restated" is a sentence that makes somebody stop and check
 * whether June is the one they meant.
 */
export function describeRuns(runs: readonly RunPeriod[]): string {
  if (runs.length === 0) return "no payroll runs";
  const names = runs.map((r) => r.runNo);
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * ⚠️ Paise to rupees for display only. Never fed back into arithmetic.
 *
 * 🔴 IT NEVER TOUCHES `Number`. The surcharge threshold is ₹50 lakh —
 * 5,000,000,000 paise — and annual figures go higher. Routing a display
 * string through a double to get thousands separators is exactly the
 * kind of conversion that reads back a rupee short, and the person who
 * notices is the employee comparing a screen to their payslip. Grouping
 * is done on the digits.
 *
 * ⭐ AND THE GROUPING IS INDIAN: last three digits, then twos.
 * ₹5,00,00,000 is five crore, and rendering it as ₹50,000,000 asks an
 * Indian payroll operator to count zeroes.
 */
export function rupeesFromMinor(minor: string): string {
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, "");
  const paise = digits.slice(-2);

  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped =
    rest === "" ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;

  return `${negative ? "-" : ""}₹${grouped}.${paise}`;
}

/** Basis points to a percentage string. 1200 → "12%". */
export function percentFromBp(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
