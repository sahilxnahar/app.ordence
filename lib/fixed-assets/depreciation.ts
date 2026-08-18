/**
 * Ordence — ⭐⭐⭐ DEPRECIATION — TWO STATUTES, ONE SET OF ASSETS
 * Batch 100 · v1.53.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `grep -ril depreciation` across this repository returned four files
 * before this batch, and every one of them was a TALLY IMPORT validator.
 * Ordence could read a depreciation figure somebody else had computed
 * and could compute none of its own. An Indian company running its books
 * here therefore could not produce a depreciation schedule, could not
 * post the journal, and could not sign its accounts — the charge that
 * every fixed asset in the country carries was simply absent from the
 * profit and loss account.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE TWO COMPUTATIONS ARE DIFFERENT AND BOTH ARE COMPULSORY
 * ══════════════════════════════════════════════════════════════════════
 * This is the single most misunderstood thing about Indian fixed assets,
 * and collapsing the two is the defect this file is written to prevent.
 *
 *   COMPANIES ACT 2013, SCHEDULE II — the BOOK charge. It is per ASSET,
 *   it is USEFUL-LIFE based (not rate based), it is pro-rated by DAYS
 *   from the date the asset was put to use, it leaves a RESIDUAL value
 *   (Part A note 5: not more than five per cent of original cost), it
 *   allows SLM or WDV, it requires SIGNIFICANT COMPONENTS with different
 *   lives to be depreciated separately (note 4), and it adds 50% / 100%
 *   for double / triple shift working (note 6). This is what hits the
 *   P&L and the ledger.
 *
 *   INCOME-TAX ACT 1961, SECTION 32 — the TAX allowance. It is per BLOCK
 *   OF ASSETS (s.2(11)): every asset of the same class attracting the
 *   same rate is one pool, and the written-down value belongs to the
 *   POOL, not to any asset in it. It is RATE based. It has the half-rate
 *   rule (second proviso to s.32(1)): an asset acquired AND put to use
 *   for less than 180 days in that previous year gets half the rate that
 *   year. Sale proceeds ("moneys payable", s.43(6)(c)(i)(B)) come off the
 *   block and produce NO gain or loss at asset level. This never touches
 *   the ledger — it is a computation for the return.
 *
 * ⭐ THE TWO NUMBERS DIVERGE PERMANENTLY AND THAT DIVERGENCE IS THE
 *   POINT. The difference between book WDV and tax WDV is a TIMING
 *   DIFFERENCE and it is the input to deferred tax under AS 22 / Ind AS
 *   12. A product that computes only one of them cannot produce the
 *   other and cannot produce deferred tax at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ROUNDING RULE, STATED ONCE AND OBEYED EVERYWHERE BELOW
 * ══════════════════════════════════════════════════════════════════════
 * Every division floors, and the floored remainder is NOT thrown away —
 * it stays in the un-depreciated balance, so it is charged later. The
 * TERMINAL period (the one containing the end of the useful life, or the
 * disposal date) is charged EXACTLY the remaining depreciable amount
 * rather than a computed figure.
 *
 * ⭐ THE CONSEQUENCE, WHICH IS THE PROPERTY AN AUDITOR TESTS: summing
 *   every charge over the life of an asset gives cost − residual to the
 *   PAISE, under SLM and under WDV alike. Not "to the rupee". Exactly.
 *   An accumulated depreciation account that is ₹0.03 away from the
 *   schedule does not tie, and a fixed asset register that does not tie
 *   to the ledger is not evidence of anything.
 *
 * ⚠️ THIS FILE IS PURE. No `server-only`, no database, no `new Date()`,
 * no `Date` object at all — dates are `YYYY-MM-DD` strings and day
 * arithmetic is integer arithmetic, because `new Date("2026-04-01")` is
 * UTC midnight and is 31 March in half the world. The I/O lives in
 * `server/fixed-assets/depreciation-service.ts`, exactly as
 * `lib/inventory/valuation.ts` and `server/inventory/valuation-service.ts`
 * were split last batch.
 */

import { fyEndFor, fyStartFor, isIsoDate } from "@/lib/accounting/periods";

export class DepreciationError extends Error {}

/* ================================================================== */
/* ① DATE ARITHMETIC — INTEGER DAYS, NO `Date` OBJECT                  */
/* ================================================================== */

/**
 * Days since 1970-01-01 for a proleptic Gregorian date.
 *
 * ⚠️ HOWARD HINNANT'S `days_from_civil`, NOT `Date.parse`. Depreciation
 * is pro-rated by days and a single day of drift in one timezone moves
 * the charge — and moves it only for users west of Greenwich, which is
 * the kind of bug that is reported as "the auditor's number is different
 * from ours" a year later.
 */
export function dayNumber(iso: string): number {
  if (!isIsoDate(iso)) {
    throw new DepreciationError(
      `"${iso}" is not a date this engine can use. Dates here are YYYY-MM-DD strings.`,
    );
  }
  const y0 = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));

  const y = y0 - (m <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of `dayNumber`. */
export function isoFromDayNumber(days: number): string {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * ⭐ INCLUSIVE ON BOTH ENDS, AND THAT IS A DELIBERATE ACCOUNTING CHOICE.
 *
 * An asset put to use on 1 April and held to 31 March was in use for 365
 * days, not 364. The same convention is applied to the disposal date:
 * depreciation is charged UP TO AND INCLUDING the day the asset went.
 * Whichever convention is chosen it has to be the same one in the charge
 * and in the 180-day test, or an asset can be full-rate for tax and
 * charged 179 days of book depreciation on the same facts.
 */
export function inclusiveDays(from: string, to: string): number {
  const n = dayNumber(to) - dayNumber(from) + 1;
  return n > 0 ? n : 0;
}

/** `months` calendar months after `iso`, clamped to the end of the month. */
export function addMonths(iso: string, months: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  const last = daysInMonth(ny, nm);
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return table[month - 1] ?? 30;
}

/** 365, or 366 across a 29 February. The denominator of a per-annum rate. */
export function daysInFinancialYear(anyDayInIt: string): number {
  return inclusiveDays(fyStartFor(anyDayInIt), fyEndFor(anyDayInIt));
}

/* ================================================================== */
/* ② MONEY — FLOORED DIVISION THAT NEVER LOSES A PAISA UPWARDS         */
/* ================================================================== */

/**
 * `value × numerator / denominator`, floored, in exact bigint paise.
 *
 * ⚠️ MULTIPLY FIRST, DIVIDE ONCE. Dividing first and multiplying back is
 * how a schedule ends up three rupees short of the asset's cost, and the
 * shortfall is invisible until somebody adds up the register.
 */
export function mulDivFloor(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new DepreciationError("Division by zero in a depreciation computation.");
  }
  const product = value * numerator;
  const q = product / denominator;
  // BigInt division truncates toward zero; depreciation figures here are
  // never negative, so truncation and floor agree. Asserted rather than
  // assumed, because a negative would silently round the wrong way.
  if (product < 0n) {
    throw new DepreciationError("A depreciation computation produced a negative amount.");
  }
  return q;
}

/* ================================================================== */
/* ③ SCHEDULE II PART C — THE PRESCRIBED LIVES                         */
/* ================================================================== */

/**
 * ⭐ THE LIVES ARE HERE SO THAT A DIFFERENT ONE HAS TO BE JUSTIFIED.
 *
 * Part C of Schedule II prescribes a useful life for each class. A
 * company MAY use a different one — the note under Part C permits it
 * "where a company adopts a useful life different from that specified"
 * provided the difference is justified by technical advice and DISCLOSED
 * in the financial statements.
 *
 * 🔴 SO `usefulLifeMonths` IS NOT FREE-TEXT CONFIGURATION. If it differs
 * from the prescribed life for the class, `companiesActCharge` REFUSES
 * to compute unless `lifeJustification` is present. That is the whole
 * anti-pattern this batch exists to avoid: a column somebody sets and
 * nothing reads. Here the class, the life AND the justification are all
 * read at the point the number is produced, and a mismatch stops the
 * computation rather than being quietly accepted.
 *
 * ⚠️ `noExtraShift` IS SCHEDULE II PART A NOTE 6 ("NESD" — no extra
 * shift depreciation). Extra shift depreciation applies to PLANT AND
 * MACHINERY only, and not even to all of it: continuous process plant,
 * buildings, furniture and office equipment are excluded. Deriving it
 * from the class rather than storing a boolean means nobody can tick a
 * box that makes a building depreciate 50% faster.
 */
export type ScheduleIIClass =
  | "building_rcc"
  | "building_other"
  | "factory_building"
  | "plant_machinery_general"
  | "plant_machinery_continuous_process"
  | "electrical_installations"
  | "furniture_fittings"
  | "office_equipment"
  | "computer_end_user"
  | "computer_server_network"
  | "motor_vehicle"
  | "motor_vehicle_on_hire"
  | "laboratory_equipment"
  | "intangible";

export type ScheduleIISpec = {
  readonly label: string;
  /**
   * Months of prescribed useful life, or null where Schedule II
   * prescribes none.
   */
  readonly usefulLifeMonths: number | null;
  /** True where Part A note 6 forbids extra shift depreciation. */
  readonly noExtraShift: boolean;
  readonly note: string;
};

export const SCHEDULE_II: Readonly<Record<ScheduleIIClass, ScheduleIISpec>> = {
  building_rcc: {
    label: "Building — RCC frame structure (other than factory)",
    usefulLifeMonths: 60 * 12,
    noExtraShift: true,
    note: "Part C I(a). Sixty years. Extra shift depreciation does not apply to buildings.",
  },
  building_other: {
    label: "Building — other than RCC frame",
    usefulLifeMonths: 30 * 12,
    noExtraShift: true,
    note: "Part C I(b). Thirty years.",
  },
  factory_building: {
    label: "Factory building",
    usefulLifeMonths: 30 * 12,
    noExtraShift: true,
    note: "Part C I(a) read with the factory-building entry. Thirty years.",
  },
  plant_machinery_general: {
    label: "Plant and machinery — general",
    usefulLifeMonths: 15 * 12,
    noExtraShift: false,
    note: "Part C IV(i). Fifteen years, and the one class extra shift depreciation squarely applies to.",
  },
  plant_machinery_continuous_process: {
    label: "Continuous process plant",
    usefulLifeMonths: 25 * 12,
    noExtraShift: true,
    note: "Part C IV(ii). Twenty-five years, marked NESD — a continuous process plant runs three shifts by definition, so note 6 would double-count.",
  },
  electrical_installations: {
    label: "Electrical installations and equipment",
    usefulLifeMonths: 10 * 12,
    noExtraShift: true,
    note: "Part C II. Ten years.",
  },
  furniture_fittings: {
    label: "Furniture and fittings",
    usefulLifeMonths: 10 * 12,
    noExtraShift: true,
    note: "Part C VI. Ten years, NESD.",
  },
  office_equipment: {
    label: "Office equipment",
    usefulLifeMonths: 5 * 12,
    noExtraShift: true,
    note: "Part C VII. Five years, NESD.",
  },
  computer_end_user: {
    label: "Computers — end user devices (desktops, laptops)",
    usefulLifeMonths: 3 * 12,
    noExtraShift: true,
    note: "Part C VII(a). Three years.",
  },
  computer_server_network: {
    label: "Computers — servers and networks",
    usefulLifeMonths: 6 * 12,
    noExtraShift: true,
    note: "Part C VII(b). Six years.",
  },
  motor_vehicle: {
    label: "Motor vehicles — own use",
    usefulLifeMonths: 8 * 12,
    noExtraShift: true,
    note: "Part C V(ii). Eight years.",
  },
  motor_vehicle_on_hire: {
    label: "Motor vehicles — used in a business of running them on hire",
    usefulLifeMonths: 6 * 12,
    noExtraShift: true,
    note: "Part C V(i). Six years.",
  },
  laboratory_equipment: {
    label: "Laboratory equipment",
    usefulLifeMonths: 10 * 12,
    noExtraShift: true,
    note: "Part C III. Ten years for general laboratory equipment.",
  },
  intangible: {
    label: "Intangible asset",
    /**
     * 🔴 NULL, AND NULL IS THE HONEST ANSWER. Schedule II Part C
     * prescribes no life for intangibles: Part A note 3 sends them to
     * the accounting standards (AS 26 / Ind AS 38), where the life is a
     * judgement about the asset. So every intangible needs a written
     * justification, always.
     */
    usefulLifeMonths: null,
    noExtraShift: true,
    note: "Schedule II Part A note 3 — amortised under AS 26 / Ind AS 38, which prescribe no life. One must be justified for each asset.",
  },
};

export const SCHEDULE_II_CLASSES = Object.keys(SCHEDULE_II) as ScheduleIIClass[];

export function isScheduleIIClass(value: string): value is ScheduleIIClass {
  return Object.prototype.hasOwnProperty.call(SCHEDULE_II, value);
}

/* ================================================================== */
/* ④ THE ASSET, AS THE ENGINE NEEDS IT                                 */
/* ================================================================== */

export const DEPRECIATION_METHODS = ["slm", "wdv"] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export const SHIFT_USAGES = ["single", "double", "triple"] as const;
export type ShiftUsage = (typeof SHIFT_USAGES)[number];

/**
 * 🔴 REFUSED BY NAME, NEVER DEFAULTED. The valuation batch closed a
 * defect where a method fell through to whatever the code happened to do;
 * an unrecognised depreciation method must stop the computation and say
 * which value it does not know, not quietly straight-line the asset.
 */
export function assertKnownMethod(method: string): asserts method is DepreciationMethod {
  if (!(DEPRECIATION_METHODS as readonly string[]).includes(method)) {
    throw new DepreciationError(
      `"${method}" is not a depreciation method this engine implements. It knows ${DEPRECIATION_METHODS.join(
        " and ",
      )}. Nothing has been depreciated — fix the asset's method rather than accepting a default.`,
    );
  }
}

export function assertKnownShift(shift: string): asserts shift is ShiftUsage {
  if (!(SHIFT_USAGES as readonly string[]).includes(shift)) {
    throw new DepreciationError(
      `"${shift}" is not a shift pattern this engine knows. Schedule II Part A note 6 recognises ${SHIFT_USAGES.join(
        ", ",
      )} working and nothing else.`,
    );
  }
}

export type FixedAssetFacts = {
  readonly id: string;
  readonly assetNo: string;
  readonly assetClass: ScheduleIIClass;
  /** Capitalised cost in paise. For a component, the component's own cost. */
  readonly costMinor: bigint;
  /** Basis points of cost. Schedule II Part A note 5 caps this at 500. */
  readonly residualBp: number;
  /** Required when `residualBp` exceeds the 5% Schedule II ceiling. */
  readonly residualJustification: string | null;
  readonly usefulLifeMonths: number;
  /** Required when the life differs from the Part C life for the class. */
  readonly lifeJustification: string | null;
  readonly method: DepreciationMethod;
  readonly shiftUsage: ShiftUsage;
  /** ⚠️ NOT the acquisition date. Depreciation runs from USE. */
  readonly putToUseOn: string;
  readonly disposedOn: string | null;
  /**
   * Accumulated depreciation already POSTED, as at the day before the
   * period being computed. Folded from the posted lines by the service —
   * there is deliberately no counter column on the asset.
   */
  readonly accumulatedDepreciationMinor: bigint;
};

/** Residual value in paise. Floored, so residual is never overstated. */
export function residualMinor(facts: Pick<FixedAssetFacts, "costMinor" | "residualBp">): bigint {
  return mulDivFloor(facts.costMinor, BigInt(facts.residualBp), 10000n);
}

/** Cost less residual — the total that will ever be charged. */
export function depreciableBaseMinor(
  facts: Pick<FixedAssetFacts, "costMinor" | "residualBp">,
): bigint {
  return facts.costMinor - residualMinor(facts);
}

/** The last day of the asset's useful life, inclusive. */
export function usefulLifeEndsOn(facts: Pick<FixedAssetFacts, "putToUseOn" | "usefulLifeMonths">): string {
  // ⚠️ MINUS ONE DAY. Twelve months from 1 April 2025 ends on 31 March
  // 2026 inclusive, which is 365 days — not 1 April 2026, which would be
  // 366 and would make a one-year asset outlive its year.
  return isoFromDayNumber(dayNumber(addMonths(facts.putToUseOn, facts.usefulLifeMonths)) - 1);
}

/** Total days of useful life. The SLM denominator. */
export function usefulLifeDays(
  facts: Pick<FixedAssetFacts, "putToUseOn" | "usefulLifeMonths">,
): number {
  return inclusiveDays(facts.putToUseOn, usefulLifeEndsOn(facts));
}

/* ------------------------------------------------------------------ */
/* THE WDV RATE, DERIVED FROM THE LIFE                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ SCHEDULE II GIVES A LIFE, NOT A RATE, SO THE RATE IS DERIVED:
 *
 *        r = 1 − (residual / cost) ^ (1 / years)
 *
 * For fifteen-year plant with a 5% residual this returns 1810 basis
 * points — 18.10% — which is the figure in every published Schedule II
 * WDV table, and for a sixty-year building 487bp (4.87%), likewise.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE ONE FLOATING-POINT OPERATION IN THIS FILE, AND WHY IT IS SAFE
 * ══════════════════════════════════════════════════════════════════════
 * `Math.pow` is not bit-identical across JavaScript engines. It is
 * accurate to about one unit in the last place — roughly 1e-16 relative
 * — and the result here is ROUNDED TO WHOLE BASIS POINTS, a granularity
 * of 1e-4. For the answer to differ between two engines the true value
 * would have to sit within 1e-16 of a half-basis-point boundary.
 *
 * 🔴 AND EVEN THEN THE SCHEDULE STILL TERMINATES EXACTLY, because the
 * rate never decides the final figure: the terminal period is charged
 * the remaining depreciable amount outright. The rate decides the SHAPE
 * of the curve; the residual decides where it ends.
 *
 * 🔴 A NIL RESIDUAL IS REFUSED UNDER WDV, and this is a real limitation
 * of the reducing-balance method rather than a missing feature: with
 * residual zero the formula gives a rate of 100%, which would write the
 * asset off in its first year. Schedule II's WDV rate is undefined at a
 * nil residual. Such an asset must be on SLM.
 */
export function wdvRateBp(facts: FixedAssetFacts): number {
  const residual = residualMinor(facts);
  if (residual <= 0n) {
    throw new DepreciationError(
      `${facts.assetNo} is on the written-down value method with a nil residual value. ` +
        `The Schedule II WDV rate is 1 − (residual ÷ cost)^(1/life), which is 100% when the ` +
        `residual is nil — the asset would be written off in its first year. Put it on the ` +
        `straight line method, or give it a residual value.`,
    );
  }
  if (residual >= facts.costMinor) {
    throw new DepreciationError(
      `${facts.assetNo} has a residual value that is not less than its cost, so there is nothing to depreciate.`,
    );
  }
  const years = facts.usefulLifeMonths / 12;
  const ratio = Number(residual) / Number(facts.costMinor);
  const rate = 1 - Math.pow(ratio, 1 / years);
  return Math.round(rate * 10000);
}

/**
 * ⭐ SCHEDULE II PART A NOTE 6 — EXTRA SHIFT DEPRECIATION.
 *
 * "the depreciation shall be increased by 50% for that period" for double
 * shift working and "by 100%" for triple shift. It applies FOR THE PERIOD
 * the asset was so used, which is why the shift is read per run and not
 * baked into the rate.
 *
 * 🔴 AND IT DOES NOT APPLY TO NESD ASSETS. A building worked three
 * shifts does not wear out faster in the eyes of Schedule II. The class
 * decides, not a tickbox — see `SCHEDULE_II`.
 */
export function shiftFactorBp(assetClass: ScheduleIIClass, shift: ShiftUsage): number {
  assertKnownShift(shift);
  if (SCHEDULE_II[assetClass].noExtraShift) return 10000;
  if (shift === "double") return 15000;
  if (shift === "triple") return 20000;
  return 10000;
}

/* ================================================================== */
/* ⑤ THE COMPANIES ACT CHARGE                                          */
/* ================================================================== */

export type DepreciationPeriod = {
  /** Inclusive first day. */
  readonly from: string;
  /** Inclusive last day. */
  readonly to: string;
};

export type CompaniesActLine = {
  readonly assetId: string;
  readonly assetNo: string;
  readonly method: DepreciationMethod;
  readonly costMinor: bigint;
  readonly residualMinor: bigint;
  readonly openingAccumulatedMinor: bigint;
  readonly openingCarryingMinor: bigint;
  readonly daysInUse: number;
  readonly usefulLifeDays: number;
  /** Whole basis points. Null on SLM, which has no rate. */
  readonly rateBp: number | null;
  readonly shiftFactorBp: number;
  readonly chargeMinor: bigint;
  readonly closingAccumulatedMinor: bigint;
  readonly closingCarryingMinor: bigint;
  /** True where this period took the asset to its residual value. */
  readonly terminal: boolean;
  readonly notes: readonly string[];
};

/**
 * 🔴 THE CONFIGURATION IS VALIDATED WHERE IT IS USED, NOT WHERE IT IS
 * TYPED IN. A form can be bypassed by an API call, an import or a fix-up
 * script; this function cannot, because nothing produces a depreciation
 * figure without going through it.
 */
export function assertAssetIsDepreciable(facts: FixedAssetFacts): void {
  assertKnownMethod(facts.method);
  assertKnownShift(facts.shiftUsage);

  if (!isScheduleIIClass(facts.assetClass)) {
    throw new DepreciationError(
      `${facts.assetNo} is classified as "${facts.assetClass}", which is not a Schedule II Part C class this engine knows.`,
    );
  }
  if (facts.costMinor <= 0n) {
    throw new DepreciationError(`${facts.assetNo} has no cost, so there is nothing to depreciate.`);
  }
  if (facts.usefulLifeMonths < 1) {
    throw new DepreciationError(`${facts.assetNo} has a useful life of less than one month.`);
  }
  if (facts.residualBp < 0 || facts.residualBp > 10000) {
    throw new DepreciationError(
      `${facts.assetNo} has a residual value of ${facts.residualBp} basis points of cost, which is not a proportion.`,
    );
  }

  /**
   * 🔴 SCHEDULE II PART A NOTE 5 — "the residual value of an asset shall
   * not be more than five per cent of the original cost of the asset".
   * The note continues: where a company uses a different residual it
   * must be justified by technical advice and disclosed. So a residual
   * above 5% is not forbidden — it is CONDITIONAL, and the condition is
   * a written justification. Refusing without one is the only way that
   * sentence means anything inside software.
   */
  if (facts.residualBp > 500 && !facts.residualJustification) {
    throw new DepreciationError(
      `${facts.assetNo} carries a residual value of ${(facts.residualBp / 100).toFixed(2)}% of cost. ` +
        `Schedule II Part A note 5 caps it at 5% unless the company justifies the difference by ` +
        `technical advice and discloses it. Record that justification against the asset, or bring ` +
        `the residual down to 5%. Nothing has been depreciated.`,
    );
  }

  const prescribed = SCHEDULE_II[facts.assetClass].usefulLifeMonths;
  if (prescribed !== facts.usefulLifeMonths && !facts.lifeJustification) {
    throw new DepreciationError(
      prescribed === null
        ? `${facts.assetNo} is an intangible asset, for which Schedule II prescribes no useful life — ` +
          `Part A note 3 sends it to AS 26 / Ind AS 38, where the life is a judgement about the asset. ` +
          `Record the basis for ${facts.usefulLifeMonths} months against the asset. Nothing has been amortised.`
        : `${facts.assetNo} is depreciated over ${facts.usefulLifeMonths} months and Schedule II Part C ` +
          `prescribes ${prescribed} months for ${SCHEDULE_II[facts.assetClass].label}. A different life is ` +
          `permitted where it is justified by technical advice and disclosed in the financial statements. ` +
          `Record that justification against the asset. Nothing has been depreciated.`,
    );
  }

  if (dayNumber(facts.putToUseOn) < 0) {
    throw new DepreciationError(`${facts.assetNo} has an implausible put-to-use date.`);
  }
}

/**
 * ⭐⭐ ONE ASSET, ONE PERIOD, THE WHOLE WORKING.
 *
 * ⚠️ THE PERIOD MUST LIE INSIDE ONE FINANCIAL YEAR. A written-down-value
 * charge is a per-ANNUM rate pro-rated by days, and the denominator is
 * the number of days in the financial year — 365 or 366. A window
 * straddling 31 March has two denominators and no honest answer, so it
 * is refused rather than guessed at.
 */
export function companiesActCharge(
  facts: FixedAssetFacts,
  period: DepreciationPeriod,
): CompaniesActLine {
  assertAssetIsDepreciable(facts);

  if (period.from > period.to) {
    throw new DepreciationError(
      `The period ${period.from} to ${period.to} runs backwards. Nothing has been depreciated.`,
    );
  }
  if (fyStartFor(period.from) !== fyStartFor(period.to)) {
    throw new DepreciationError(
      `The period ${period.from} to ${period.to} crosses 31 March. Depreciation is computed within ` +
        `one financial year at a time — a reducing-balance rate is per annum and a window spanning ` +
        `two years has two denominators. Run each year separately.`,
    );
  }

  const notes: string[] = [];
  const residual = residualMinor(facts);
  const base = depreciableBaseMinor(facts);
  const openingAccumulated = facts.accumulatedDepreciationMinor;
  const openingCarrying = facts.costMinor - openingAccumulated;
  const remaining = base - openingAccumulated;
  const lifeDays = usefulLifeDays(facts);
  const lifeEnd = usefulLifeEndsOn(facts);

  /* ---- The window the asset was actually in use for ---------------- */
  const start = facts.putToUseOn > period.from ? facts.putToUseOn : period.from;
  const disposalEnd = facts.disposedOn !== null && facts.disposedOn < period.to
    ? facts.disposedOn
    : period.to;
  const end = disposalEnd;
  const days = inclusiveDays(start, end);

  const factorBp = shiftFactorBp(facts.assetClass, facts.shiftUsage);
  const rate = facts.method === "wdv" ? wdvRateBp(facts) : null;

  /**
   * ⭐ THE TERMINAL PERIOD. Either the useful life ends inside it, or the
   * asset was disposed of inside it. Both mean this is the last charge
   * the asset will ever take, so it takes the whole remaining balance
   * and accumulated depreciation lands EXACTLY on cost − residual.
   *
   * ⚠️ A DISPOSAL IS TERMINAL EVEN MID-LIFE, and it does NOT accelerate
   * the charge: `chargeMinor` on a disposal is the ordinary time-
   * apportioned figure, and the un-recovered balance goes to the profit
   * or loss on sale instead. Writing the asset down to residual on the
   * way out would move that loss out of "loss on sale of asset" and into
   * "depreciation", which is a different line in the P&L and a different
   * disclosure.
   */
  const disposedInPeriod =
    facts.disposedOn !== null && facts.disposedOn >= period.from && facts.disposedOn <= period.to;
  const lifeEndsInPeriod = lifeEnd >= period.from && lifeEnd <= period.to;

  let charge = 0n;

  if (remaining <= 0n) {
    notes.push(
      "Fully depreciated. The asset stays in the books at its residual value until it is disposed of — Schedule II charges nothing further.",
    );
  } else if (days <= 0) {
    if (facts.putToUseOn > period.to) {
      notes.push(
        `Not yet put to use on ${period.to}. Depreciation runs from the date of USE, not the date of purchase.`,
      );
    } else {
      notes.push(`Already disposed of on ${facts.disposedOn}. No charge in this period.`);
    }
  } else {
    if (facts.method === "slm") {
      /**
       * SLM: an equal amount for every day of the useful life.
       * base × daysInUse ÷ lifeDays, floored — the floored paise stay in
       * `remaining` and are picked up by a later period.
       */
      charge = mulDivFloor(base, BigInt(days), BigInt(lifeDays));
    } else {
      /**
       * WDV: the derived per-annum rate on the OPENING carrying amount,
       * pro-rated by days in the financial year.
       *
       * ⚠️ ON THE OPENING CARRYING AMOUNT, NOT ON THE DEPRECIABLE BASE.
       * Reducing balance means the balance reduces; applying the rate to
       * cost every year is straight line wearing a rate.
       */
      charge = mulDivFloor(
        openingCarrying,
        BigInt(rate as number) * BigInt(days),
        10000n * BigInt(daysInFinancialYear(period.from)),
      );
    }

    if (factorBp !== 10000) {
      const before = charge;
      charge = mulDivFloor(charge, BigInt(factorBp), 10000n);
      notes.push(
        `Schedule II Part A note 6: ${facts.shiftUsage} shift working increases the charge by ` +
          `${(factorBp - 10000) / 100}% — ${before} paise becomes ${charge} paise.`,
      );
    } else if (facts.shiftUsage !== "single" && SCHEDULE_II[facts.assetClass].noExtraShift) {
      notes.push(
        `${SCHEDULE_II[facts.assetClass].label} is marked NESD in Schedule II Part A note 6, so ` +
          `${facts.shiftUsage} shift working adds nothing. ${SCHEDULE_II[facts.assetClass].note}`,
      );
    }

    if (charge > remaining) {
      charge = remaining;
      notes.push(
        "Capped at the un-depreciated balance. An asset is never written below its residual value.",
      );
    }
  }

  let terminal = false;
  if (lifeEndsInPeriod && remaining > 0n && !disposedInPeriod) {
    /**
     * 🔴 THE RESIDUE RULE, AND IT IS THE WHOLE REASON THE SCHEDULE TIES.
     * Every earlier period floored its division and left a paisa or two
     * behind; under WDV the geometric curve also never quite reaches the
     * residual. The last period of the useful life takes whatever is
     * left, so accumulated depreciation equals cost − residual to the
     * paisa and the register agrees with the ledger.
     */
    charge = remaining;
    terminal = true;
    notes.push(
      `Final period of the useful life (ends ${lifeEnd}). Charged the whole remaining balance so that ` +
        `accumulated depreciation lands exactly on cost less residual — the rounding residue of every ` +
        `earlier period is absorbed here.`,
    );
  } else if (disposedInPeriod) {
    terminal = true;
    notes.push(
      `Disposed of on ${facts.disposedOn}. Depreciation is charged up to and including that date; ` +
        `the balance left is dealt with in the profit or loss on disposal, not here.`,
    );
  }

  const closingAccumulated = openingAccumulated + charge;

  return {
    assetId: facts.id,
    assetNo: facts.assetNo,
    method: facts.method,
    costMinor: facts.costMinor,
    residualMinor: residual,
    openingAccumulatedMinor: openingAccumulated,
    openingCarryingMinor: openingCarrying,
    daysInUse: days,
    usefulLifeDays: lifeDays,
    rateBp: rate,
    shiftFactorBp: factorBp,
    chargeMinor: charge,
    closingAccumulatedMinor: closingAccumulated,
    closingCarryingMinor: facts.costMinor - closingAccumulated,
    terminal,
    notes,
  };
}

export type CompaniesActRun = {
  readonly period: DepreciationPeriod;
  readonly lines: readonly CompaniesActLine[];
  readonly totalChargeMinor: bigint;
};

/** Every asset, one period. The figure that reaches the ledger. */
export function companiesActRun(
  assets: readonly FixedAssetFacts[],
  period: DepreciationPeriod,
): CompaniesActRun {
  const lines = assets.map((a) => companiesActCharge(a, period));
  return {
    period,
    lines,
    totalChargeMinor: lines.reduce((sum, l) => sum + l.chargeMinor, 0n),
  };
}

/**
 * ⭐ THE WHOLE LIFE, YEAR BY YEAR — what an auditor asks to see.
 *
 * ⚠️ IT REPLAYS RATHER THAN INTEGRATING A FORMULA, for the same reason
 * `lib/inventory/valuation.ts` replays the movements: the schedule an
 * auditor recomputes and the charge the ledger took come out of the same
 * function, so they cannot disagree.
 */
export function companiesActSchedule(facts: FixedAssetFacts): CompaniesActLine[] {
  const lines: CompaniesActLine[] = [];
  const lifeEnd = usefulLifeEndsOn(facts);
  let accumulated = facts.accumulatedDepreciationMinor;
  let cursor = fyStartFor(facts.putToUseOn);
  // ⚠️ A HARD STOP. A malformed life must not spin forever; a hundred
  // financial years is longer than any Schedule II life.
  for (let guard = 0; guard < 100; guard += 1) {
    const from = cursor;
    const to = fyEndFor(cursor);
    const line = companiesActCharge({ ...facts, accumulatedDepreciationMinor: accumulated }, {
      from,
      to,
    });
    lines.push(line);
    accumulated = line.closingAccumulatedMinor;
    if (to >= lifeEnd) break;
    if (facts.disposedOn !== null && to >= facts.disposedOn) break;
    cursor = isoFromDayNumber(dayNumber(to) + 1);
  }
  return lines;
}

/* ================================================================== */
/* ⑥ DISPOSAL — THE COMPANIES ACT VIEW                                 */
/* ================================================================== */

export type BookDisposal = {
  readonly costMinor: bigint;
  readonly accumulatedMinor: bigint;
  readonly carryingAmountMinor: bigint;
  readonly considerationMinor: bigint;
  /** One of these is zero. Both are positive amounts. */
  readonly gainMinor: bigint;
  readonly lossMinor: bigint;
};

/**
 * ⭐ ASSET BY ASSET, WITH A GAIN OR A LOSS. This is the Companies Act
 * treatment and it is NOT what the Income-tax Act does with the same
 * facts — see `incomeTaxBlockYear`, where the proceeds simply come off
 * the block and no gain or loss arises at all.
 *
 * 🔴 THE TWO ARE NOT RECONCILED AND MUST NOT BE. A machine sold at a
 * book profit of ₹2 lakh may produce no taxable gain whatsoever because
 * its block still holds other assets. Collapsing them would either
 * invent a tax liability or hide a real one.
 */
export function bookDisposal(args: {
  readonly costMinor: bigint;
  readonly accumulatedMinor: bigint;
  readonly considerationMinor: bigint;
}): BookDisposal {
  if (args.considerationMinor < 0n) {
    throw new DepreciationError("Sale consideration cannot be negative.");
  }
  const carrying = args.costMinor - args.accumulatedMinor;
  const difference = args.considerationMinor - carrying;
  return {
    costMinor: args.costMinor,
    accumulatedMinor: args.accumulatedMinor,
    carryingAmountMinor: carrying,
    considerationMinor: args.considerationMinor,
    gainMinor: difference > 0n ? difference : 0n,
    lossMinor: difference < 0n ? -difference : 0n,
  };
}

/* ================================================================== */
/* ⑦ INCOME-TAX ACT, SECTION 32 — THE BLOCK OF ASSETS                  */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A BLOCK IS A POOL AND THE WDV BELONGS TO THE POOL
 * ══════════════════════════════════════════════════════════════════════
 * Section 2(11) defines a block as a group of assets of the same class
 * in respect of which the same percentage of depreciation is prescribed.
 * Once an asset is in a block it stops having a tax identity of its own:
 * there is no per-asset tax WDV, no per-asset tax depreciation and — the
 * consequence people miss — no per-asset profit or loss on sale.
 *
 * s.43(6)(c)(i) gives the whole arithmetic:
 *   opening WDV
 *     + actual cost of assets acquired during the year
 *     − moneys payable in respect of assets sold, discarded or destroyed
 *       (together with scrap value), CAPPED so the block never goes below
 *       nil
 *   = the value on which depreciation is allowed.
 */
export const IT_BLOCK_CLASSES = [
  "building",
  "furniture_fittings",
  "plant_machinery",
  "intangible",
] as const;
export type ItBlockClass = (typeof IT_BLOCK_CLASSES)[number];

/**
 * ⭐⭐ THE RATES APPENDIX I PRESCRIBES FOR EACH CLASS, IN BASIS POINTS.
 *
 * 🔴 THIS EXISTS SO THAT `block_class` IS READ AT THE COMPUTATION RATHER
 * THAN BEING A LABEL. A block carrying "furniture" and a rate of 40% is
 * not a judgement call somebody made — it is a typo that will be carried
 * forward in the written-down value of that pool for as long as the
 * company exists, and it inflates the allowance fourfold in the meantime.
 *
 * ⚠️ THE RATE ITSELF IS STILL THE TAXPAYER'S TO CHOOSE, and deliberately
 * so: which Appendix I entry an asset falls under is a judgement about the
 * asset, and a "computer" at 40% and general plant at 15% look identical
 * on a purchase invoice. What this refuses is a rate that appears NOWHERE
 * in the appendix for that class.
 *
 * ⚠️ 40% IS THE CEILING SINCE THE 2017 AMENDMENT to Rule 5 — no block
 * carries a higher rate for any assessee.
 */
export const IT_RATES_BY_CLASS: Readonly<Record<ItBlockClass, readonly number[]>> = {
  /** 5% residential, 10% other than residential, 40% purely temporary erections. */
  building: [500, 1000, 4000],
  /** 10%, and only 10%. */
  furniture_fittings: [1000],
  /**
   * 15% general; 20% ships; 30% motor buses, lorries and taxis used in a
   * business of running them on hire; 40% computers and software, books
   * owned by a professional, and pollution control equipment.
   */
  plant_machinery: [1500, 2000, 3000, 4000],
  /** 25% — know-how, patents, copyrights, trademarks, licences, franchises. */
  intangible: [2500],
};

export type ItAddition = {
  readonly assetId: string;
  readonly assetNo: string;
  readonly actualCostMinor: bigint;
  readonly putToUseOn: string;
};

export type ItDisposal = {
  readonly assetId: string;
  readonly assetNo: string;
  /** s.43(6)(c)(i)(B) "moneys payable", including scrap value. */
  readonly moneysPayableMinor: bigint;
  readonly disposedOn: string;
};

export type ItBlockFacts = {
  readonly blockId: string;
  readonly blockName: string;
  readonly blockClass: ItBlockClass;
  /** Whole basis points. 15% plant and machinery is 1500. */
  readonly rateBp: number;
  readonly openingWdvMinor: bigint;
  readonly additions: readonly ItAddition[];
  readonly disposals: readonly ItDisposal[];
  /**
   * How many assets remain in the block once the year's disposals are
   * out. Zero means the block CEASES TO EXIST, which changes the answer
   * — see the s.50(2) branch below.
   */
  readonly assetsRemaining: number;
};

export type ItAdditionLine = ItAddition & {
  readonly daysInUse: number;
  readonly halfRate: boolean;
};

export type ItBlockYear = {
  readonly blockId: string;
  readonly blockName: string;
  readonly rateBp: number;
  readonly fyStart: string;
  readonly fyEnd: string;
  readonly openingWdvMinor: bigint;
  readonly fullRateAdditionsMinor: bigint;
  readonly halfRateAdditionsMinor: bigint;
  readonly moneysPayableMinor: bigint;
  /** What the full rate is applied to. */
  readonly fullRateBaseMinor: bigint;
  /** What half the rate is applied to. */
  readonly halfRateBaseMinor: bigint;
  readonly depreciationMinor: bigint;
  readonly closingWdvMinor: bigint;
  /** s.50(1). Positive when proceeds exceeded the whole block. */
  readonly shortTermCapitalGainMinor: bigint;
  /** s.50(2). Positive when the block emptied with value left in it. */
  readonly shortTermCapitalLossMinor: bigint;
  readonly blockCeases: boolean;
  readonly additions: readonly ItAdditionLine[];
  readonly notes: readonly string[];
};

/**
 * The second proviso to s.32(1): an asset "acquired by the assessee
 * during the previous year and is put to use for the purposes of business
 * or profession for a period of less than one hundred and eighty days in
 * that previous year" gets half the depreciation that year.
 *
 * ⚠️ ACQUIRED **AND** PUT TO USE IN THAT YEAR. An asset bought two years
 * ago and first used this year is not an "addition of the year" for this
 * proviso — it entered the block when it was acquired. This engine is
 * given the additions of the year by the service and applies the day
 * count to them; the acquisition-year test lives with the caller because
 * only the register knows the acquisition date.
 *
 * ⚠️ 180 DAYS COUNTED INCLUSIVELY TO 31 MARCH. Put to use on 3 October in
 * a normal year is exactly 180 days and takes the FULL rate; 4 October is
 * 179 and takes half. That one day is worth 7.5% of the cost of the asset
 * on a 15% block, so the boundary is tested rather than assumed.
 */
export function daysInUseInYear(putToUseOn: string, fyEnd: string): number {
  return inclusiveDays(putToUseOn, fyEnd);
}

export function isHalfRateAddition(putToUseOn: string, fyEnd: string): boolean {
  return daysInUseInYear(putToUseOn, fyEnd) < 180;
}

/**
 * ⭐⭐⭐ ONE BLOCK, ONE PREVIOUS YEAR.
 *
 * 🔴 THE ORDER OF THE FOUR BRANCHES BELOW IS THE LAW AND NOT A
 *    PREFERENCE. Proceeds come off before depreciation is computed
 *    (s.43(6)(c)(i)(B)), the block cannot go below nil (the same clause),
 *    an empty block gets NO depreciation however much value is left in it
 *    (s.32 requires an asset to be owned and used), and only then do the
 *    s.50 capital gain and loss branches arise.
 */
export function incomeTaxBlockYear(
  facts: ItBlockFacts,
  fy: { readonly fyStart: string; readonly fyEnd: string },
): ItBlockYear {
  if (facts.rateBp < 0 || facts.rateBp > 10000) {
    throw new DepreciationError(
      `${facts.blockName} has a depreciation rate of ${facts.rateBp} basis points, which is not a percentage. ` +
        `Appendix I to the Income-tax Rules, 1962 prescribes the rate for each block.`,
    );
  }
  /**
   * 🔴 THE CLASS IS READ HERE, NOT JUST STORED. See `IT_RATES_BY_CLASS`.
   */
  const permitted = IT_RATES_BY_CLASS[facts.blockClass];
  if (!permitted) {
    throw new DepreciationError(
      `"${facts.blockClass}" is not one of the four classes a block of assets falls into under s.2(11) ` +
        `read with Appendix I — ${IT_BLOCK_CLASSES.join(", ")}. Nothing has been computed.`,
    );
  }
  if (!permitted.includes(facts.rateBp)) {
    throw new DepreciationError(
      `${facts.blockName} is classified as ${facts.blockClass} and carries a rate of ` +
        `${(facts.rateBp / 100).toFixed(2)}%. Appendix I to the Income-tax Rules, 1962 prescribes ` +
        `${permitted.map((r) => `${r / 100}%`).join(", ")} for that class and nothing else. A rate that ` +
        `appears nowhere in the appendix is carried forward in this pool's written-down value for as long ` +
        `as the company exists — correct the class or the rate. Nothing has been computed.`,
    );
  }

  if (facts.openingWdvMinor < 0n) {
    throw new DepreciationError(
      `${facts.blockName} has a negative opening written-down value. A block never goes below nil — ` +
        `an excess of sale proceeds is a short-term capital gain under s.50(1), not a negative block.`,
    );
  }

  const notes: string[] = [];

  const additions: ItAdditionLine[] = facts.additions.map((a) => {
    const days = daysInUseInYear(a.putToUseOn, fy.fyEnd);
    return { ...a, daysInUse: days, halfRate: days < 180 };
  });

  const fullAdditions = additions
    .filter((a) => !a.halfRate)
    .reduce((s, a) => s + a.actualCostMinor, 0n);
  const halfAdditions = additions
    .filter((a) => a.halfRate)
    .reduce((s, a) => s + a.actualCostMinor, 0n);

  const moneysPayable = facts.disposals.reduce((s, d) => s + d.moneysPayableMinor, 0n);

  const total = facts.openingWdvMinor + fullAdditions + halfAdditions;

  /**
   * ⭐ THE REDUCTION IS TRACED TO THE ASSET THAT WAS SOLD, which is more
   * accurate than the usual "reduce it from the block somehow". If the
   * asset sold was itself a half-rate addition of THIS year, its proceeds
   * come out of the half-rate pool; otherwise out of the full-rate pool.
   * Getting this wrong moves cost between a full-rate and a half-rate
   * bucket, which changes the allowance by half the rate.
   */
  const halfRateIds = new Set(additions.filter((a) => a.halfRate).map((a) => a.assetId));
  let halfProceeds = 0n;
  let fullProceeds = 0n;
  for (const d of facts.disposals) {
    if (halfRateIds.has(d.assetId)) halfProceeds += d.moneysPayableMinor;
    else fullProceeds += d.moneysPayableMinor;
  }

  let halfBase = halfAdditions - halfProceeds;
  let fullBase = facts.openingWdvMinor + fullAdditions - fullProceeds;

  // Spill in either direction: a pool cannot be negative on its own, so
  // an over-recovery in one is taken out of the other.
  if (halfBase < 0n) {
    fullBase += halfBase;
    halfBase = 0n;
  }
  if (fullBase < 0n) {
    halfBase += fullBase;
    fullBase = 0n;
    if (halfBase < 0n) halfBase = 0n;
  }

  let shortTermCapitalGain = 0n;
  let shortTermCapitalLoss = 0n;
  let depreciation = 0n;
  const blockCeases = facts.assetsRemaining <= 0;

  if (moneysPayable > total) {
    /**
     * 🔴 s.50(1). The proceeds have exhausted the block. The excess is a
     * SHORT-TERM capital gain — short-term however long the asset was
     * held, because s.50 deems it so — and the block closes at nil.
     * There is no depreciation in a year the block was exhausted.
     */
    shortTermCapitalGain = moneysPayable - total;
    notes.push(
      `Moneys payable of ${moneysPayable} paise exceed the block's written-down value plus additions ` +
        `(${total} paise). Section 50(1) makes the excess of ${shortTermCapitalGain} paise a SHORT-TERM ` +
        `capital gain — short term however long the assets were held — and the block closes at nil. ` +
        `No depreciation is allowable in a year the block is exhausted.`,
    );
  } else if (blockCeases) {
    /**
     * 🔴 s.50(2). The block still has value but no asset left in it.
     * Depreciation needs an asset that is owned AND used; there is none.
     * The balance is a short-term capital LOSS.
     */
    shortTermCapitalLoss = total - moneysPayable;
    notes.push(
      `Every asset in this block has gone and ${shortTermCapitalLoss} paise of written-down value ` +
        `remains. Section 32 allows depreciation only on an asset owned and used, so none is allowable; ` +
        `section 50(2) makes the balance a SHORT-TERM capital loss.`,
    );
  } else {
    depreciation =
      mulDivFloor(fullBase, BigInt(facts.rateBp), 10000n) +
      // 🔴 HALF THE RATE, computed as ÷20000 rather than as (rate÷2)÷10000
      // so that an odd rate — 7.5% is 750bp — does not lose a basis point
      // to integer division before it is ever applied.
      mulDivFloor(halfBase, BigInt(facts.rateBp), 20000n);

    if (halfBase > 0n) {
      notes.push(
        `${halfBase} paise of additions were put to use for less than 180 days in this previous year, ` +
          `so the second proviso to s.32(1) allows half the rate on them.`,
      );
    }
  }

  /**
   * 🔴 A CEASED BLOCK CLOSES AT NIL, AND THE BALANCE IS NOT LOST — IT HAS
   * ALREADY BECOME A s.50(2) SHORT-TERM CAPITAL LOSS ABOVE. Carrying the
   * value forward as well would relieve it twice: once as a capital loss
   * this year and again as depreciation in every year after it, on a
   * block that holds nothing.
   */
  const closing = blockCeases ? 0n : total - moneysPayable - depreciation;

  return {
    blockId: facts.blockId,
    blockName: facts.blockName,
    rateBp: facts.rateBp,
    fyStart: fy.fyStart,
    fyEnd: fy.fyEnd,
    openingWdvMinor: facts.openingWdvMinor,
    fullRateAdditionsMinor: fullAdditions,
    halfRateAdditionsMinor: halfAdditions,
    moneysPayableMinor: moneysPayable,
    fullRateBaseMinor: fullBase,
    halfRateBaseMinor: halfBase,
    depreciationMinor: depreciation,
    // ⚠️ NEVER NEGATIVE. Where the proceeds exhausted the block the excess
    // has already become a s.50(1) gain above; carrying a negative block
    // forward would allow that gain to be depreciated away next year.
    closingWdvMinor: closing > 0n ? closing : 0n,
    shortTermCapitalGainMinor: shortTermCapitalGain,
    shortTermCapitalLossMinor: shortTermCapitalLoss,
    blockCeases,
    additions,
    notes,
  };
}

/* ================================================================== */
/* ⑧ THE DIVERGENCE — WHAT DEFERRED TAX IS COMPUTED ON                 */
/* ================================================================== */

export type TemporaryDifference = {
  readonly bookCarryingMinor: bigint;
  readonly taxWdvMinor: bigint;
  /** Positive when the books carry more than the tax computation does. */
  readonly differenceMinor: bigint;
  /** "deferred_tax_liability" | "deferred_tax_asset" | "none". */
  readonly gives: "deferred_tax_liability" | "deferred_tax_asset" | "none";
  readonly note: string;
};

/**
 * ⭐ THE ONE NUMBER THAT ONLY EXISTS BECAUSE BOTH COMPUTATIONS WERE DONE.
 *
 * 🔴 AND ORDENCE DOES NOT APPLY A TAX RATE TO IT. The rate depends on
 * which regime the company is in (s.115BAA at 22%, s.115BAB at 15%, the
 * ordinary rate, plus surcharge and cess that turn on turnover and total
 * income), whether MAT applies, and the reasonable certainty test for
 * recognising a deferred tax asset. Guessing 25% and printing a deferred
 * tax figure would be a number in a balance sheet that nobody chose.
 * The DIFFERENCE is a fact; the tax on it is a judgement.
 */
export function temporaryDifference(args: {
  readonly bookCarryingMinor: bigint;
  readonly taxWdvMinor: bigint;
}): TemporaryDifference {
  const difference = args.bookCarryingMinor - args.taxWdvMinor;
  return {
    bookCarryingMinor: args.bookCarryingMinor,
    taxWdvMinor: args.taxWdvMinor,
    differenceMinor: difference,
    gives:
      difference > 0n
        ? "deferred_tax_liability"
        : difference < 0n
          ? "deferred_tax_asset"
          : "none",
    note:
      difference === 0n
        ? "Book and tax written-down values agree, so this block gives rise to no timing difference."
        : difference > 0n
          ? "The books carry more than the tax computation does — tax depreciation has run ahead of book " +
            "depreciation. That reverses in later years and is a DEFERRED TAX LIABILITY under AS 22 / " +
            "Ind AS 12. ⚠️ Ordence states the difference and does not apply a rate to it: the rate depends " +
            "on the company's regime under s.115BAA / s.115BAB and on surcharge and cess."
          : "The tax computation carries more than the books do — book depreciation has run ahead. That is " +
            "a DEFERRED TAX ASSET, recognisable only where there is reasonable certainty of sufficient " +
            "future taxable income. ⚠️ That certainty is a judgement, so no figure is computed here.",
  };
}
