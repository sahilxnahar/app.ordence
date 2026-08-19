/**
 * Ordence — Purchases & Input Tax Credit, pure logic barrel
 * Version: v0.33.0-alpha
 *
 * ⚠️ NOTHING IN `lib/purchases/` IMPORTS `@/db`. These modules are the
 * rules themselves — Section 17(5), Rule 42, Rule 43, the MSME clock —
 * and the bill-entry screen has to show the ITC verdict BEFORE anything
 * is saved. A person entering a contractor's bill needs to see "blocked
 * under 17(5)(d)" while they are still deciding which project to book it
 * to, not after.
 *
 * Type-only imports from `@/db/schema/purchases` are the exception and
 * are erased at compile time; they exist so an enum value is spelled the
 * same way in the database and in the engine.
 *
 * ⚠️ AND NOTHING HERE RESTATES PHASE 32. The tax arithmetic is
 * `computeInvoiceTax`, place of supply is `determinePlaceOfSupply`, the
 * rate comes from `resolveRateOn` over dated `hsn_sac_rates` rows, and
 * `applyRateBps`/`splitEvenly` come from `lib/billing/money.ts`. A second
 * rounding implementation that differs by one paisa from the one the
 * sales invoice uses is a discrepancy nobody can explain and an officer
 * will find.
 */

export * from "./itc";
export * from "./apportionment";
export * from "./vendor-ledger";
export * from "./register";
