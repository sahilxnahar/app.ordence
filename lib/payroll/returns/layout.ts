/**
 * Ordence — ⭐⭐⭐ THE STATUTORY RETURN LAYOUTS, AS DATA
 * Version: v1.52.0-alpha · Batch 78
 *
 * Pure. No I/O, no `server-only`, no clock. Every date is an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 READ THIS BEFORE THE FIRST REAL FILING
 * ══════════════════════════════════════════════════════════════════════
 * The field orders below were encoded from the published EPFO ECR 2.0
 * and ESIC monthly-contribution documentation. THEY WERE NOT VERIFIED
 * AGAINST THE LIVE PORTAL, because the machine that wrote them has no
 * network. Every layout therefore carries `confirmedAgainstPortal:
 * false` and every consumer prints that fact on the file's cover.
 *
 * ⚠️ THIS PROJECT HAS ALREADY SHIPPED A VERIFY SCRIPT THAT PRINTED
 * "policies OK" over a real tenant leak. The identical failure here is a
 * layout that claims to be confirmed and is one column out — which does
 * not error, does not get rejected, and becomes the employer's filed
 * position.
 *
 * 🔴 SO THE FLAG IS PART OF THE DATA, NOT A COMMENT. Flip
 * `confirmedAgainstPortal` to `true` in a row only after somebody has
 * opened the current spec on the EPFO / ESIC portal and read the columns
 * off it, and add a NEW effective-dated row rather than editing an old
 * one — a return filed last March must still render with last March's
 * layout when it is re-generated for a revision.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY LAYOUTS ARE EFFECTIVE-DATED AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * ECR went from 1.0 to 2.0 and dropped four columns doing it. An
 * employer regenerating a 2015 return for a damages proceeding needs the
 * 2015 columns. `pickEffective` — the same one the rate engine uses —
 * selects by the PERIOD'S date, never by today's.
 */

import { pickEffective, type EffectiveDated } from "@/lib/payroll/statutory";

/* ------------------------------------------------------------------ */
/* ROUNDING, AS A DECLARED PROPERTY OF EVERY FIELD                     */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE PORTALS WANT RUPEES. THE ENGINE HOLDS PAISE. THE CONVERSION IS
 * THE SINGLE MOST DANGEROUS LINE IN THIS MODULE.
 *
 * ⚠️ AND THE RULE IS NOT ONE RULE. ESI contributions are rounded UP by
 * regulation (see `ceilRupeeFromBp` in `statutory.ts`); PF contributions
 * are rounded to the NEAREST rupee on the challan; a wage figure is a
 * fact about what was paid and has no statutory rounding of its own,
 * only a format constraint that it must be whole rupees.
 *
 * ⭐ SO THE MODE IS ATTACHED TO THE FIELD, in data, next to the reason.
 * A single `Math.round` at the edge would be tidier and would silently
 * disagree with the challan on some employee, some month.
 */
export type RupeeRounding = "nearest" | "floor" | "ceil";

/**
 * ⚠️ DAYS TOO. NCP days and ESIC "days for which wages were paid" are
 * both INTEGERS on the portal and both live here as centidays, because
 * half-day loss of pay is ordinary and real.
 */
export type DayRounding = "nearest" | "floor" | "ceil";

export const CENTIDAYS_PER_DAY = 100;

/**
 * ⭐ RUPEES FROM PAISE, WITH THE MODE NAMED AT THE CALL SITE.
 *
 * 🔴 IT REFUSES NEGATIVES rather than truncating them toward zero.
 * `floorToRupee` in `statutory.ts` divides bigints, which truncates
 * toward zero and is therefore NOT a floor below zero. No statutory
 * return field is ever negative, so the safe answer is to make the
 * caller deal with it as a finding instead of quietly emitting -0.
 */
export function rupeesFromPaise(paise: bigint, mode: RupeeRounding): bigint | null {
  if (paise < 0n) return null;
  const whole = paise / 100n;
  const remainder = paise % 100n;
  if (remainder === 0n) return whole;
  if (mode === "floor") return whole;
  if (mode === "ceil") return whole + 1n;
  // ⚠️ Half away from zero — the department's own arithmetic, matching
  // `roundToRupee`. Banker's rounding is defensible in a spreadsheet and
  // disagrees with the challan.
  return remainder >= 50n ? whole + 1n : whole;
}

/** True when the paise value is already an exact rupee — nothing is lost. */
export function isWholeRupee(paise: bigint): boolean {
  return paise % 100n === 0n;
}

/**
 * ⭐ WHOLE DAYS FROM CENTIDAYS.
 *
 * ⚠️ THE RETURN CARRIES `exact` SO THE CALLER CAN SAY SO. A member with
 * 1.5 days of loss of pay becomes "2" or "1" depending on the mode, and
 * an operator who is not told that has no way to know the file disagrees
 * with the payslip they handed the employee.
 */
export function daysFromCentidays(
  centidays: number,
  mode: DayRounding,
): { days: number; exact: boolean } {
  const whole = Math.trunc(centidays / CENTIDAYS_PER_DAY);
  const rest = centidays - whole * CENTIDAYS_PER_DAY;
  if (rest === 0) return { days: whole, exact: true };
  if (mode === "floor") return { days: whole, exact: false };
  if (mode === "ceil") return { days: whole + 1, exact: false };
  return { days: rest >= 50 ? whole + 1 : whole, exact: false };
}

/* ------------------------------------------------------------------ */
/* ① EPFO — ELECTRONIC CHALLAN CUM RETURN                              */
/* ------------------------------------------------------------------ */

export type EcrFieldId =
  | "uan"
  | "member_name"
  | "gross_wages"
  | "epf_wages"
  | "eps_wages"
  | "edli_wages"
  | "epf_contribution_remitted"
  | "eps_contribution_remitted"
  | "epf_eps_difference_remitted"
  | "ncp_days"
  | "refund_of_advances";

export interface EcrFieldSpec {
  readonly id: EcrFieldId;
  /** ⚠️ The portal's own wording, not ours. Support calls quote it. */
  readonly label: string;
  readonly kind: "text" | "rupees" | "days";
  /** Null for text fields. */
  readonly rounding: RupeeRounding | DayRounding | null;
  /** 🔴 WHY this rounding and not the other one. */
  readonly why: string;
}

export interface EcrLayout extends EffectiveDated {
  readonly id: string;
  readonly version: string;
  /** 🔴 `#~#`. Three characters, and the portal is literal about it. */
  readonly delimiter: string;
  readonly fields: readonly EcrFieldSpec[];
  /** Where the field order came from, in words a CA can check. */
  readonly source: string;
  /** 🔴 FALSE until a human has read the live spec. Never default true. */
  readonly confirmedAgainstPortal: boolean;
  readonly note: string;
}

/**
 * ⭐ ECR 2.0 — ELEVEN FIELDS, `#~#` SEPARATED, ONE LINE PER MEMBER.
 *
 * ⚠️ THE THREE WAGE FIELDS ARE NOT THE SAME NUMBER and treating them as
 * one is the second most common ECR defect after NCP days:
 *   • GROSS WAGES — everything paid, including what PF is not charged on.
 *   • EPF WAGES  — the contribution base, capped at the wage ceiling
 *                  unless the employer has opted to pay on full wages.
 *   • EPS WAGES  — capped at the PENSION ceiling ALWAYS, and zero for a
 *                  member who is not in the pension scheme at all.
 *   • EDLI WAGES — capped like EPS, para 7 of the EDLI Scheme 1976.
 *
 * 🔴 NCP DAYS IS FIELD TEN AND IS THE ONE EMPLOYERS GET WRONG. See
 * `ecr.ts` for what it means and how loss-of-pay centidays map onto it.
 */
export const ECR_LAYOUTS: readonly EcrLayout[] = Object.freeze([
  {
    id: "epfo_ecr_2_0",
    version: "2.0",
    effectiveFrom: "2012-04-01",
    effectiveTo: null,
    delimiter: "#~#",
    source:
      "EPFO Unified Portal, ECR 2.0 file format (Employees' Provident Funds Scheme 1952 para 36; " +
      "Pension Scheme 1995 para 20; EDLI Scheme 1976 para 10). Encoded from the published field " +
      "list, NOT read off the live portal.",
    confirmedAgainstPortal: false,
    note:
      "🔴 CONFIRM THE COLUMN ORDER AND THE DELIMITER AGAINST THE CURRENT EPFO ECR HELP FILE BEFORE " +
      "THE FIRST UPLOAD. A file one column out is accepted by nothing, which is the harmless case; " +
      "a file with the wage columns transposed uploads cleanly and files wrong numbers.",
    fields: [
      {
        id: "uan",
        label: "UAN",
        kind: "text",
        rounding: null,
        why: "Twelve digits, allotted by EPFO. There is no valid substitute value — see `ecr.ts`.",
      },
      {
        id: "member_name",
        label: "MEMBER NAME",
        kind: "text",
        rounding: null,
        why:
          "⚠️ Must match the name in the UAN repository, not the name on the payslip. A mismatch " +
          "is a rejection at upload, and a marriage-name change is the usual cause.",
      },
      {
        id: "gross_wages",
        label: "GROSS WAGES",
        kind: "rupees",
        rounding: "nearest",
        why:
          "A statement of what was paid; the scheme prescribes no rounding of its own, only that " +
          "the file carries whole rupees. Nearest keeps the sum closest to the payroll total.",
      },
      {
        id: "epf_wages",
        label: "EPF WAGES",
        kind: "rupees",
        rounding: "nearest",
        why: "As gross wages. This is the base the 12% was actually charged on.",
      },
      {
        id: "eps_wages",
        label: "EPS WAGES",
        kind: "rupees",
        rounding: "nearest",
        why: "As gross wages, after the pension ceiling has already been applied in paise.",
      },
      {
        id: "edli_wages",
        label: "EDLI WAGES",
        kind: "rupees",
        rounding: "nearest",
        why: "As gross wages, after the EDLI ceiling has already been applied in paise.",
      },
      {
        id: "epf_contribution_remitted",
        label: "EPF CONTRI REMITTED",
        kind: "rupees",
        rounding: "nearest",
        why:
          "🔴 The EMPLOYEE'S share. `computePf` has already rounded it to the rupee, so this " +
          "conversion is exact and `validateEcr` blocks the file if it is not.",
      },
      {
        id: "eps_contribution_remitted",
        label: "EPS CONTRI REMITTED",
        kind: "rupees",
        rounding: "nearest",
        why: "The employer's 8.33% pension share, already rupee-exact from the engine.",
      },
      {
        id: "epf_eps_difference_remitted",
        label: "EPF EPS DIFF REMITTED",
        kind: "rupees",
        rounding: "nearest",
        why:
          "⚠️ NOT the employer's whole 12%. It is the employer's share MINUS the pension share, " +
          "which is what the challan's A/c 1 employer column expects.",
      },
      {
        id: "ncp_days",
        label: "NCP DAYS",
        kind: "days",
        rounding: "nearest",
        why:
          "🔴 Non-contributory period. Integer on the portal, fractional in real payroll. " +
          "`ecr.ts` names every member whose value was rounded and by how much.",
      },
      {
        id: "refund_of_advances",
        label: "REFUND OF ADVANCES",
        kind: "rupees",
        rounding: "nearest",
        why:
          "Repayment of a scheme advance. Ordence does not model scheme advances, so it is zero " +
          "unless the caller supplies one, and the file says so rather than implying nil is a fact.",
      },
    ],
  },
]);

export function ecrLayoutFor(onDate: string): EcrLayout | null {
  return pickEffective(ECR_LAYOUTS, onDate);
}

/* ------------------------------------------------------------------ */
/* ② ESIC — MONTHLY CONTRIBUTION                                       */
/* ------------------------------------------------------------------ */

export type EsicColumnId =
  | "ip_number"
  | "ip_name"
  | "days_worked"
  | "total_monthly_wages"
  | "reason_code"
  | "last_working_day";

export interface EsicColumnSpec {
  readonly id: EsicColumnId;
  readonly label: string;
  readonly kind: "text" | "rupees" | "days" | "date";
  readonly rounding: RupeeRounding | DayRounding | null;
  readonly why: string;
}

export interface EsicLayout extends EffectiveDated {
  readonly id: string;
  readonly version: string;
  /**
   * ⚠️ ESIC'S OWN TEMPLATE IS A SPREADSHEET. We emit the same columns as
   * delimited text because a spreadsheet writer is not a thing this
   * module may own — it is pure, and a workbook is a binary artefact.
   * The operator pastes it into the portal's template. THAT IS STATED ON
   * THE FILE, because "we produced the ESIC file" would otherwise read
   * as "this uploads as-is", and it does not.
   */
  readonly delimiter: string;
  readonly columns: readonly EsicColumnSpec[];
  readonly source: string;
  readonly confirmedAgainstPortal: boolean;
  readonly note: string;
}

/**
 * ⭐ REASON CODES FOR ZERO WORKING DAYS, AS DATA.
 *
 * 🔴 A ROW WITH ZERO DAYS AND NO REASON CODE IS REJECTED BY THE PORTAL,
 * and — worse — a row with zero days and the WRONG reason code is
 * accepted and quietly ends somebody's coverage. "Left service" against
 * a person who was merely on unpaid leave removes them from the register.
 */
export const ESIC_ZERO_DAY_REASONS: Readonly<Record<string, string>> = Object.freeze({
  "0": "Not applicable — the person worked and was paid",
  "1": "On leave without wages",
  "2": "Left service",
  "3": "Retired",
  "4": "Out of coverage (wages above the limit at the START of a contribution period)",
  "5": "Expired",
  "6": "Non-implemented area",
  "7": "Suspension",
  "8": "Strike or lock-out",
  "9": "Other",
});

export const ESIC_LAYOUTS: readonly EsicLayout[] = Object.freeze([
  {
    id: "esic_monthly_contribution_v1",
    version: "1",
    effectiveFrom: "2010-04-01",
    effectiveTo: null,
    delimiter: ",",
    source:
      "ESIC portal, Monthly Contribution bulk-upload template (Employees' State Insurance Act 1948 " +
      "s.39 and reg.26 of the ESI (General) Regulations 1950). Encoded from the published column " +
      "list, NOT read off the live portal.",
    confirmedAgainstPortal: false,
    note:
      "🔴 THIS IS A TRANSCRIPTION WORKSHEET, NOT A PORTAL-READY WORKBOOK. Confirm the column order " +
      "against the template downloaded from the ESIC portal for the month being filed, and paste " +
      "the values into that template rather than uploading this text file.",
    columns: [
      {
        id: "ip_number",
        label: "IP Number",
        kind: "text",
        rounding: null,
        why: "Ten digits. A covered person without one cannot be filed — see `esic.ts`.",
      },
      { id: "ip_name", label: "IP Name", kind: "text", rounding: null, why: "As registered with ESIC." },
      {
        id: "days_worked",
        label: "No of Days for which wages paid/payable",
        kind: "days",
        rounding: "nearest",
        why:
          "⚠️ Integer on the portal. It drives the 78-day qualification for sickness benefit, so a " +
          "day lost here is a benefit lost. Every rounded value is named on the file.",
      },
      {
        id: "total_monthly_wages",
        label: "Total Monthly Wages",
        kind: "rupees",
        rounding: "nearest",
        why:
          "🔴 THE PORTAL RECOMPUTES THE CONTRIBUTION FROM THIS NUMBER. `esic.ts` re-derives it from " +
          "the rounded rupee figure and compares it with what we are actually paying, because a " +
          "wage rounded one way and a challan computed the other differ by a rupee per person.",
      },
      {
        id: "reason_code",
        label: "Reason Code for Zero working days",
        kind: "text",
        rounding: null,
        why: "See ESIC_ZERO_DAY_REASONS. Mandatory whenever days worked is zero.",
      },
      {
        id: "last_working_day",
        label: "Last Working Day",
        kind: "date",
        rounding: null,
        why: "Required with the reason codes that end the employment relationship.",
      },
    ],
  },
]);

export function esicLayoutFor(onDate: string): EsicLayout | null {
  return pickEffective(ESIC_LAYOUTS, onDate);
}
