import type { PermissionKey } from "@/db/schema/auth";
import "server-only";

/**
 * Ordence — Purchase Gate Composition
 * Version: v0.33.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SAME FOUR GATES, IN THE SAME ORDER, FOR THE SAME REASONS
 * ══════════════════════════════════════════════════════════════════════
 *   1. ACCESS      — may this workspace WRITE at all?
 *   2. ENTITLEMENT — has it paid for the capability?
 *   3. PERMISSION  — may this PERSON do it?
 *   4. IMPERSONATION — is this our own support staff wearing a
 *      customer's face, and is this something a session may never do?
 *
 * ⚠️ `guardPurchaseWrite` DELEGATES TO `guardSalesWrite`. It is not a
 * fifth copy of the same four calls. Phase 22 wrote that composition,
 * Phase 32 wrote a second one WITHOUT the impersonation gate, and a third
 * would be the point at which "the gates" stopped being one thing. The
 * purchase ledger is money leaving the company, so it gets the version
 * WITH the impersonation gate.
 *
 * ⚠️ THIS FILE IS NOT `"use server"`. It exports non-async helpers
 * alongside the async one, and a `"use server"` file that exports
 * anything but async functions publishes them as RPC endpoints.
 */

import { z } from "zod";
import { TenantAccessError, type TenantContext } from "@/server/tenant-context";
import { AccessRestrictedError } from "@/server/billing/access";
import { FeatureLockedError } from "@/server/entitlements";
import { PermissionDeniedError } from "@/lib/permissions";
import { guardSalesWrite } from "@/server/sales/guards";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * ⚠️ WRITE SITES ONLY. A gate on a `get*` function produces the worst
 * upgrade prompt in the product: a page that will not render at all
 * rather than a page that renders and refuses the button. Reads use
 * `requirePermission` alone.
 */
export async function guardPurchaseWrite(args: {
  operation: string;
  feature: FeatureKey;
  permission: PermissionKey;
  resource?: { type?: string; id?: string };
  impersonationOperation?: string;
}): Promise<TenantContext> {
  return guardSalesWrite(args);
}

/* ------------------------------------------------------------------ */
/* ERROR TRANSLATION                                                   */
/* ------------------------------------------------------------------ */

export function purchaseFail(
  error: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * Turn anything thrown into a safe, useful envelope.
 *
 * ⚠️ THE TRIGGER MESSAGES ARE PASSED THROUGH, NOT REPLACED.
 *
 * Every guard in `SQL-FILES/0023_phase33_purchases.sql` raises a sentence
 * written for a person — "this line was determined BLOCKED under Section
 * 17(5)(d), so no input tax credit may be claimed against it". That
 * sentence is the entire explanation of a rule nobody understands on
 * first encounter, and replacing it with "something went wrong" throws
 * away the only part of the interaction that teaches anything.
 *
 * Each mapping below names a specific constraint, so a NEW constraint
 * failing falls through to the generic message rather than being
 * mislabelled as something it is not.
 */
export function toPurchaseActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return purchaseFail(err.message);
  if (err instanceof AccessRestrictedError) return purchaseFail(err.message);
  if (err instanceof FeatureLockedError) return purchaseFail(err.message);
  if (err instanceof PermissionDeniedError) return purchaseFail(err.message);

  if (err instanceof z.ZodError) {
    return purchaseFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    // ⭐ THE ONE A USER WILL ACTUALLY HIT, AND THE MOST VALUABLE MESSAGE
    // IN THE PHASE. The site office and accounts both entering the same
    // contractor's bill is not misuse — it is a busy Friday — and the
    // person who loses the race has to be told what happened rather than
    // shown a constraint name.
    if (pg.constraint?.includes("purchase_invoices_no_duplicate_bill")) {
      return purchaseFail(
        "This vendor's invoice number has already been entered for this financial " +
          "year. Entering a bill twice claims the input tax credit twice and pays " +
          "the vendor twice — find the existing entry before adding another. If the " +
          "vendor has genuinely reused the number, ask them for a corrected " +
          "document: Rule 46(b) requires their serial to be unique for the year.",
      );
    }
    if (pg.constraint?.includes("itc_register_one_movement_per_period")) {
      return purchaseFail(
        "That credit has already been recorded for this tax period. Re-running the " +
          "period build does not double it — the existing movement stands.",
      );
    }
    if (pg.constraint?.includes("vendors_code_tenant_unique")) {
      return purchaseFail("That vendor code is already in use in this workspace.");
    }
    return purchaseFail("That record already exists.");
  }

  if (pg?.code === "23514") {
    const constraint = pg.constraint ?? "";

    // ⭐⭐ The most expensive mistake in the phase, refused by the
    // database. The message has to say WHY, because the person who hit it
    // believes they are right — they booked yesterday's identical cement
    // exactly this way.
    if (constraint.includes("own_account_blocked")) {
      return purchaseFail(
        "Input tax credit cannot be claimed on goods or services going into a " +
          "building we are constructing ON OUR OWN ACCOUNT — Section 17(5)(d) of " +
          "the CGST Act blocks it outright, even where the building is used in the " +
          "business. The tax is capitalised into the cost of the building. ⚠️ If " +
          "these units are in fact being SOLD under agreements dated before the " +
          "completion certificate, the purpose is 'sold before completion' and the " +
          "credit IS available — but that is a statement about the agreements, " +
          "evidenced by them, not a preference.",
      );
    }
    if (constraint.includes("block_reason_presence")) {
      return purchaseFail(
        "A blocked credit has to name the clause it is blocked under. At an " +
          "assessment the question is never 'is it blocked' but 'under which " +
          "clause', and a register that cannot answer loses the credit by default.",
      );
    }
    if (constraint.includes("itc_splits_exactly")) {
      return purchaseFail(
        "Every paisa of tax on a purchase is either claimable or blocked. The " +
          "figures do not add up to the tax on the document, which would leave " +
          "credit that reaches neither the return nor the cost of the building.",
      );
    }
    if (constraint.includes("common_implies_proportionate")) {
      return purchaseFail(
        "An input that feeds both taxable and exempt supplies is common credit and " +
          "has to be marked proportionate — Rule 42 requires part of it to be " +
          "reversed, and it is the reversal, not the claim, that an audit " +
          "reconstructs.",
      );
    }
    if (constraint.includes("bill_of_supply_no_tax")) {
      return purchaseFail(
        "A bill of supply carries no GST, so no credit can arise from it. A " +
          "composition dealer and an exempt supplier both issue one — Section " +
          "17(5)(e) blocks credit on anything received from a composition dealer.",
      );
    }
    if (constraint.includes("immovable_property_pos")) {
      return purchaseFail(
        "For a supply relating to immovable property the place of supply must be " +
          "the PROPERTY'S state (Section 12(3), IGST Act). A credit taxed to the " +
          "wrong state lands in a ledger with nothing to set it against.",
      );
    }
    if (constraint.includes("vendors_terms_sane")) {
      return purchaseFail(
        "Payment to a registered micro or small enterprise must be within 45 days " +
          "(Section 15, MSMED Act), and Section 32 voids any longer agreement. " +
          "Section 43B(h) of the Income-tax Act then disallows the whole " +
          "expenditure if payment is late.",
      );
    }
    if (constraint.includes("vendors_msme_complete")) {
      return purchaseFail(
        "An MSME claim needs the Udyam Registration Number and the category. " +
          "Section 43B(h) reaches an enterprise REGISTERED under the MSMED Act; " +
          "without the registration there is nothing to rely on.",
      );
    }
    if (constraint.includes("vendors_udyam_shape")) {
      return purchaseFail(
        "That is not a Udyam Registration Number. It looks like " +
          "UDYAM-MH-01-0001234. A twelve-digit number is the old Udyog Aadhaar, " +
          "which was replaced in July 2020 and is no longer verifiable.",
      );
    }
    if (constraint.includes("exactly_one_side")) {
      return purchaseFail(
        "A ledger entry is either a debit or a credit, never both and never " +
          "neither. A bill credits the vendor account (we owe more); a payment " +
          "debits it.",
      );
    }
    // The reconciliation trigger, the double-claim trigger and the
    // determination trigger all raise sentences written for a person.
    // Keep them.
    if (pg.message) return purchaseFail(stripPgNoise(pg.message));
    return purchaseFail("That change is not allowed.");
  }

  if (pg?.code === "23503") {
    if (pg.constraint?.includes("purchase_invoices_vendor_same_tenant")) {
      return purchaseFail(
        "That vendor has purchase invoices against them and cannot be removed. " +
          "The credit claimed on their bills is evidence — block the vendor " +
          "instead, which stops new bills and keeps the history.",
      );
    }
    if (pg.constraint?.includes("itc_register_invoice_same_tenant")) {
      return purchaseFail(
        "That purchase invoice's credit has already reached a return and the " +
          "invoice cannot be deleted. The register is the record that it was " +
          "claimed. Cancel it instead — a cancelled bill stops counting and stays.",
      );
    }
    if (pg.constraint?.includes("purchase_invoice_lines_rate_same_tenant")) {
      return purchaseFail(
        "That rate period is used by purchase invoices already recorded and cannot " +
          "be removed. It is the evidence that the supplier's charge was correct.",
      );
    }
    return purchaseFail(
      "Something this refers to no longer exists. Refresh the page and try again.",
    );
  }

  if (pg?.code === "42501") {
    if (pg.message) return purchaseFail(stripPgNoise(pg.message));
    return purchaseFail("That change is refused.");
  }

  console.error(`[purchases:${scope}]`, err);
  return purchaseFail("Something went wrong. Please try again.");
}

type PgErrorShape = { code?: string; constraint?: string; message?: string };

function asPgError(err: unknown): PgErrorShape | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as Record<string, unknown>;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  if (!code) return null;
  return {
    code,
    constraint:
      typeof candidate.constraint === "string" ? candidate.constraint : undefined,
    message: typeof candidate.message === "string" ? candidate.message : undefined,
  };
}

function stripPgNoise(message: string): string {
  return message
    .replace(/^error:\s*/i, "")
    .replace(/\s*CONTEXT:[\s\S]*$/i, "")
    .trim();
}
