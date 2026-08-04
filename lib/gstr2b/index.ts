/**
 * Ordence — ⭐ GSTR-2B reconciliation, pure logic barrel
 * Version: v0.34.0-alpha
 *
 * ⚠️ NOTHING IN `lib/gstr2b/` IMPORTS `@/db`. The import screen has to
 * show what a 2B file contains, and what it will and will not match,
 * BEFORE anything is written — because the moment an import lands it
 * becomes a document somebody has to reconcile. A parse that can only be
 * checked by performing it is a parse nobody checks.
 *
 * Type-only imports from `@/db/schema/gstr2b` are the exception and are
 * erased at compile time; they exist so an enum value is spelled the same
 * way in the database and in the engine.
 *
 * ⚠️ AND NOTHING HERE RESTATES PHASE 32 OR 33. The Section 16(4)
 * deadline is `itcClaimDeadlinePeriod` from `lib/purchases/register.ts`,
 * the day arithmetic is `daysBetween` from
 * `lib/purchases/vendor-ledger.ts`, and the eligible credit a mismatch
 * puts at risk is Phase 33's Section 17(5) determination read off the
 * invoice. A second deadline rule that differed by a month from the first
 * would be found by an officer and by nobody else.
 */

export * from "./invoice-number";
export * from "./tolerance";
export * from "./parse";
export * from "./matching";
export * from "./summary";
export * from "./chase";
