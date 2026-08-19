/**
 * Ordence — ⭐⭐ THE REGISTER, AS A SCREEN NEEDS IT
 * Batch 100 · v1.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS AND WHY IT IS PURE
 * ══════════════════════════════════════════════════════════════════════
 * `listFixedAssets()` returns `Record<string, unknown>` rows, because
 * paise cross the action boundary as digit strings and `bigint` does not
 * survive JSON. Something has to turn that back into typed facts, and it
 * must not be a component: the money rule in this product is that a
 * component FORMATS and never CALCULATES.
 *
 * ⚠️ THE "DEPRECIATION TO DATE" FIGURE ON THE REGISTER IS THE SCHEDULE
 * FIGURE, NOT THE POSTED BALANCE, AND EVERY SCREEN THAT SHOWS IT SAYS SO.
 * `db/schema/fixed-assets.ts` deliberately carries no accumulated-
 * depreciation column — the posted `depreciation_lines` are the balance
 * and nothing else is. So this replays the SAME engine that produces the
 * charge, over the financial years the asset has lived through, and
 * labels the answer as the working rather than as the ledger. A figure
 * captioned "accumulated depreciation" that is really a projection is
 * exactly the kind of number an auditor ties to nothing.
 *
 * ⭐ AND A MISCONFIGURED ASSET PRODUCES A REFUSAL, NOT A ZERO. An asset
 * whose useful life departs from Schedule II Part C with no justification
 * recorded cannot be depreciated at all, and the register is where that
 * has to be visible — a blank cell reads as "nothing charged yet".
 */

import {
  companiesActCharge,
  DepreciationError,
  DEPRECIATION_METHODS,
  isScheduleIIClass,
  SCHEDULE_II,
  SHIFT_USAGES,
  type DepreciationMethod,
  type ScheduleIIClass,
  type ShiftUsage,
} from "./depreciation";
import { fyEndFor, fyStartFor } from "@/lib/accounting/periods";

/* ================================================================== */
/* ① MONEY — FORMATTED HERE, SO NO COMPONENT EVER DOES ARITHMETIC      */
/* ================================================================== */

/**
 * Paise to rupees, grouped the Indian way (2,2,3).
 *
 * ⚠️ STRING ARITHMETIC ON THE DIGITS, never `Number(minor) / 100`. A
 * cost above ₹90,07,19,92,54,740 loses precision the moment it becomes a
 * double, and a fixed asset register is exactly where large figures live.
 */
export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

/** Rupees typed into a form to whole paise. Returns null on anything else. */
export function parseRupeesToMinor(input: string): string | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return `${whole}${frac.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
}

/** Basis points as a percentage, for a label. */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

/* ================================================================== */
/* ② READING THE ACTION'S ROWS BACK INTO FACTS                         */
/* ================================================================== */

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const nullableStr = (v: unknown): string | null =>
  v === null || v === undefined ? null : str(v);
const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const minor = (v: unknown): bigint => {
  const s = str(v);
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
};

export type RegisterRow = {
  readonly id: string;
  readonly assetNo: string;
  readonly description: string;
  readonly assetClass: string;
  readonly assetClassLabel: string;
  readonly costMinor: bigint;
  readonly residualBp: number;
  readonly residualJustification: string | null;
  readonly usefulLifeMonths: number;
  readonly lifeJustification: string | null;
  readonly prescribedLifeMonths: number | null;
  readonly depreciationMethod: string;
  readonly shiftUsage: string;
  readonly acquiredOn: string;
  readonly putToUseOn: string;
  readonly disposedOn: string | null;
  readonly disposalConsiderationMinor: bigint | null;
  readonly status: string;
  readonly location: string | null;
  readonly itBlockId: string | null;
};

export function readRegisterRow(raw: Record<string, unknown>): RegisterRow {
  const assetClass = str(raw.assetClass);
  return {
    id: str(raw.id),
    assetNo: str(raw.assetNo),
    description: str(raw.description),
    assetClass,
    assetClassLabel: isScheduleIIClass(assetClass)
      ? SCHEDULE_II[assetClass].label
      : assetClass,
    costMinor: minor(raw.costMinor),
    residualBp: int(raw.residualBp),
    residualJustification: nullableStr(raw.residualJustification),
    usefulLifeMonths: int(raw.usefulLifeMonths),
    lifeJustification: nullableStr(raw.lifeJustification),
    prescribedLifeMonths:
      raw.prescribedLifeMonths === null || raw.prescribedLifeMonths === undefined
        ? null
        : int(raw.prescribedLifeMonths),
    depreciationMethod: str(raw.depreciationMethod),
    shiftUsage: str(raw.shiftUsage),
    acquiredOn: str(raw.acquiredOn),
    putToUseOn: str(raw.putToUseOn),
    disposedOn: nullableStr(raw.disposedOn),
    disposalConsiderationMinor:
      raw.disposalConsiderationMinor === null || raw.disposalConsiderationMinor === undefined
        ? null
        : minor(raw.disposalConsiderationMinor),
    status: str(raw.status),
    location: nullableStr(raw.location),
    itBlockId: nullableStr(raw.itBlockId),
  };
}

export type BlockRow = {
  readonly id: string;
  readonly name: string;
  readonly blockClass: string;
  readonly rateBp: number;
  readonly openingWdvMinor: bigint;
  readonly openingWdvAsAt: string;
  readonly notes: string | null;
};

export function readBlockRow(raw: Record<string, unknown>): BlockRow {
  return {
    id: str(raw.id),
    name: str(raw.name),
    blockClass: str(raw.blockClass),
    rateBp: int(raw.rateBp),
    openingWdvMinor: minor(raw.openingWdvMinor),
    openingWdvAsAt: str(raw.openingWdvAsAt),
    notes: nullableStr(raw.notes),
  };
}

/* ================================================================== */
/* ③ THE JUSTIFICATION THE FORM HAS TO ASK FOR BEFORE IT SUBMITS       */
/* ================================================================== */

export type JustificationDemand = {
  /** True when Schedule II requires a written life justification. */
  readonly lifeNeedsJustification: boolean;
  /** True when Part A note 5 requires a written residual justification. */
  readonly residualNeedsJustification: boolean;
  readonly prescribedLifeMonths: number | null;
  readonly reasons: readonly string[];
};

/**
 * ⭐ THE SAME TWO CONDITIONS `assertAssetIsDepreciable` ENFORCES, ASKED
 * BEFORE THE FORM IS SENT RATHER THAN AFTER IT IS REFUSED.
 *
 * 🔴 THIS IS NOT THE CONTROL. The engine is, and it cannot be walked
 * around by an import or a script. This exists so that a person typing a
 * different useful life is told WHY the box below it appeared, instead of
 * discovering it in a refusal.
 */
export function justificationDemand(input: {
  readonly assetClass: string;
  readonly usefulLifeMonths: number;
  readonly residualBp: number;
}): JustificationDemand {
  const prescribed = isScheduleIIClass(input.assetClass)
    ? SCHEDULE_II[input.assetClass].usefulLifeMonths
    : null;
  const lifeNeeds = prescribed !== input.usefulLifeMonths;
  const residualNeeds = input.residualBp > 500;
  const reasons: string[] = [];
  if (lifeNeeds) {
    reasons.push(
      prescribed === null
        ? "Schedule II Part C prescribes no life for this class — Part A note 3 sends it to AS 26 / " +
          "Ind AS 38, where the life is a judgement about the asset. It must be written down."
        : `Schedule II Part C prescribes ${prescribed} months for this class and this asset is on ` +
          `${input.usefulLifeMonths}. A different life is permitted where it is justified by technical ` +
          `advice and disclosed in the financial statements.`,
    );
  }
  if (residualNeeds) {
    reasons.push(
      `Schedule II Part A note 5 caps the residual value at 5% of cost, and this is ` +
        `${formatBp(input.residualBp)}. A higher residual is permitted where it is justified by ` +
        `technical advice and disclosed.`,
    );
  }
  return {
    lifeNeedsJustification: lifeNeeds,
    residualNeedsJustification: residualNeeds,
    prescribedLifeMonths: prescribed,
    reasons,
  };
}

/* ================================================================== */
/* ④ THE WORKING TO DATE — SAME ENGINE, NEVER A SECOND FORMULA         */
/* ================================================================== */

export type WorkingToDate =
  | {
      readonly ok: true;
      readonly chargedMinor: bigint;
      readonly carryingMinor: bigint;
      readonly residualMinor: bigint;
      readonly years: number;
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * ⭐ REPLAYS `companiesActCharge` ONE FINANCIAL YEAR AT A TIME, exactly
 * as `companiesActSchedule` does, up to `asAt`.
 *
 * ⚠️ ONE YEAR AT A TIME BECAUSE A WDV RATE IS PER ANNUM. The engine
 * refuses a window that crosses 31 March, and it is right to — a window
 * spanning two years has two denominators.
 */
export function workingToDate(row: RegisterRow, asAt: string): WorkingToDate {
  if (!isScheduleIIClass(row.assetClass)) {
    return {
      ok: false,
      refusal: `"${row.assetClass}" is not a Schedule II Part C class this engine knows.`,
    };
  }
  if (!(DEPRECIATION_METHODS as readonly string[]).includes(row.depreciationMethod)) {
    return {
      ok: false,
      refusal: `"${row.depreciationMethod}" is not a depreciation method this engine implements.`,
    };
  }
  if (!(SHIFT_USAGES as readonly string[]).includes(row.shiftUsage)) {
    return {
      ok: false,
      refusal: `"${row.shiftUsage}" is not a shift pattern Schedule II Part A note 6 recognises.`,
    };
  }

  const base = {
    id: row.id,
    assetNo: row.assetNo,
    assetClass: row.assetClass as ScheduleIIClass,
    costMinor: row.costMinor,
    residualBp: row.residualBp,
    residualJustification: row.residualJustification,
    usefulLifeMonths: row.usefulLifeMonths,
    lifeJustification: row.lifeJustification,
    method: row.depreciationMethod as DepreciationMethod,
    shiftUsage: row.shiftUsage as ShiftUsage,
    putToUseOn: row.putToUseOn,
    disposedOn: row.disposedOn,
  };

  try {
    let accumulated = 0n;
    let residual = 0n;
    let years = 0;
    let cursor = fyStartFor(row.putToUseOn);
    // A hundred financial years is longer than any Schedule II life; the
    // same hard stop `companiesActSchedule` carries, for the same reason.
    for (let guard = 0; guard < 100 && cursor <= asAt; guard += 1) {
      const fyEnd = fyEndFor(cursor);
      const to = fyEnd < asAt ? fyEnd : asAt;
      const line = companiesActCharge(
        { ...base, accumulatedDepreciationMinor: accumulated },
        { from: cursor, to },
      );
      accumulated = line.closingAccumulatedMinor;
      residual = line.residualMinor;
      years += 1;
      if (fyEnd >= asAt) break;
      cursor = nextDayAfterFyEnd(fyEnd);
    }
    return {
      ok: true,
      chargedMinor: accumulated,
      carryingMinor: row.costMinor - accumulated,
      residualMinor: residual,
      years,
    };
  } catch (err) {
    if (err instanceof DepreciationError) return { ok: false, refusal: err.message };
    throw err;
  }
}

/** 31 March + one day is 1 April. Stated once rather than parsed. */
function nextDayAfterFyEnd(fyEnd: string): string {
  return `${Number(fyEnd.slice(0, 4)) + 1}-04-01`;
}

/* ================================================================== */
/* ⑤ THE FILTERS                                                       */
/* ================================================================== */

export const ASSET_STATUSES = ["in_use", "disposed", "written_off"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export function filterRegister(
  rows: readonly RegisterRow[],
  filters: { readonly assetClass?: string | null; readonly status?: string | null },
): RegisterRow[] {
  return rows.filter((r) => {
    if (filters.assetClass && filters.assetClass !== "all" && r.assetClass !== filters.assetClass) {
      return false;
    }
    if (filters.status && filters.status !== "all" && r.status !== filters.status) return false;
    return true;
  });
}
