/**
 * Ordence — ⭐ THE STATUTORY RETURN FILES, AND THEIR DUE DATES
 * Version: v1.52.0-alpha · Batch 78
 *
 * Pure. The barrel, plus the ONE thing that belongs to all three files:
 * when each of them is due.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DUE DATE IS NOT COMPUTED HERE AND MUST NEVER BE
 * ══════════════════════════════════════════════════════════════════════
 * `lib/compliance/statutory-due.ts` already holds the obligation table:
 * PF and ESI on the 15th of the following month, professional tax on the
 * 20th with the assumption written on it. It also holds `dueDateFor`,
 * which says "the 15th of the following month" rather than "thirty days
 * after" — two different dates in eleven months out of twelve.
 *
 * ⚠️ A SECOND DUE-DATE NOTION IS HOW A COMPLIANCE CALENDAR DRIFTS. The
 * dashboard would say one date, the return file would print another, and
 * the one that is wrong is whichever the person happened to read. So
 * this module DELEGATES, and the only thing it adds is the mapping from
 * "which file" to "which obligation".
 */

import { OBLIGATION_BY_KIND, dueDateFor } from "@/lib/compliance/statutory-due";
import type { StatutoryReturnKind } from "./validate";

export * from "./layout";
export * from "./validate";
export * from "./ecr";
export * from "./esic";
export * from "./pt";

/**
 * ⭐ ONE FILE, ONE OBLIGATION. The mapping is explicit because the names
 * differ — "epfo_ecr" is the artefact, "provident_fund" is the liability.
 */
const OBLIGATION_FOR_RETURN: Readonly<Record<StatutoryReturnKind, string>> = Object.freeze({
  epfo_ecr: "provident_fund",
  esic_monthly: "esi",
  professional_tax: "professional_tax",
});

export interface ReturnDueInfo {
  readonly dueOn: string;
  readonly authority: string;
  readonly ifLate: string;
  readonly obligationLabel: string;
}

/**
 * ⚠️ RETURNS NULL RATHER THAN INVENTING A DATE. If the obligation table
 * ever loses a row, the file must refuse rather than print a plausible
 * 15th that nobody can trace to a rule.
 */
export function returnDueInfo(kind: StatutoryReturnKind, periodEnd: string): ReturnDueInfo | null {
  const obligationKind = OBLIGATION_FOR_RETURN[kind];
  const rule = OBLIGATION_BY_KIND[obligationKind];
  if (rule === undefined) return null;
  return {
    dueOn: dueDateFor(periodEnd, rule.dueDayNextMonth),
    authority: rule.authority,
    ifLate: rule.ifLate,
    obligationLabel: rule.label,
  };
}
