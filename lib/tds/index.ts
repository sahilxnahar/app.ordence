/**
 * Ordence — Tax Deducted at Source, pure logic barrel
 * Version: v0.36.0-alpha
 *
 * ⚠️ NOTHING IN `lib/tds/` IMPORTS `@/db`. These modules are the rules
 * themselves — the section catalogue, the cumulative threshold, 206AA,
 * 206AB, Section 197, the 201(1A) interest — and the payment-run screen
 * has to show the deduction BEFORE anything is saved. A person about to
 * release a contractor's running-account bill needs to see "⭐ the annual
 * threshold is crossed by this payment, so ₹1,000 comes off ₹25,000, not
 * ₹250" while they can still tell the contractor, not afterwards.
 *
 * Type-only imports from `@/db/schema/tds` are the exception and are
 * erased at compile time; they exist so an enum value is spelled the same
 * way in the database and in the engine.
 *
 * ⚠️ AND NOTHING HERE RESTATES PHASE 22 OR PHASE 33. The 194H rate and
 * threshold come from `lib/sales/commission.ts`, the TDS base comes from
 * `purchase_invoices.tds_base_minor` (already net of GST per CBDT
 * Circular 23/2017), and `applyRateBps` comes from `lib/billing/money.ts`
 * so a TDS figure cannot differ by a paisa from the same calculation on a
 * partner payout statement.
 */

export * from "./sections";
export * from "./calendar";
export * from "./thresholds";
export * from "./rates";
export * from "./interest";
export * from "./challans";
export * from "./certificates";
export * from "./returns";
export * from "./register";
