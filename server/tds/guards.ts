import "server-only";

/**
 * Ordence — TDS Gate Composition
 * Version: v0.36.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SAME FOUR GATES, IN THE SAME ORDER, FOR THE SAME REASONS
 * ══════════════════════════════════════════════════════════════════════
 *   1. ACCESS        — may this workspace WRITE at all?
 *   2. ENTITLEMENT   — has it paid for the capability?
 *   3. PERMISSION    — may this PERSON do it?
 *   4. IMPERSONATION — is this our own support staff wearing a
 *      customer's face, and is this something a session may never do?
 *
 * ⚠️ `guardTdsWrite` DELEGATES TO `guardPurchaseWrite`, which delegates
 * to `guardSalesWrite`. It is not a fourth copy of the same four calls.
 * TDS is money leaving the company to a third party under a statutory
 * obligation, so it gets the version WITH the impersonation gate — the
 * same one the purchase ledger gets, and for a stronger reason: a
 * deduction recorded under an impersonated session is a figure that will
 * appear in a stranger's Form 26AS.
 *
 * ⚠️ THIS FILE IS NOT `"use server"`. It exports non-async helpers
 * alongside the async one, and a `"use server"` file that exports
 * anything but async functions publishes them as RPC endpoints.
 */

import type { PermissionKey } from "@/db/schema/auth";
import { z } from "zod";
import { TenantAccessError, type TenantContext } from "@/server/tenant-context";
import { AccessRestrictedError } from "@/server/billing/access";
import { FeatureLockedError } from "@/server/entitlements";
import { PermissionDeniedError } from "@/lib/permissions";
import { guardPurchaseWrite } from "@/server/purchases/guards";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * ⚠️ WRITE SITES ONLY. A gate on a `get*` function produces the worst
 * upgrade prompt in the product: a page that will not render at all
 * rather than a page that renders and refuses the button. Reads use
 * `requirePermission` alone.
 */
export async function guardTdsWrite(args: {
  operation: string;
  feature: FeatureKey;
  permission: PermissionKey;
  resource?: { type?: string; id?: string };
  impersonationOperation?: string;
}): Promise<TenantContext> {
  return guardPurchaseWrite(args);
}

/* ------------------------------------------------------------------ */
/* ERROR TRANSLATION                                                   */
/* ------------------------------------------------------------------ */

export function tdsFail(
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
 * Every guard in `SQL-FILES/0025_phase36_tds.sql` raises a sentence
 * written for a person — "₹1,00,000 has been paid under Section 194C
 * this year and only ₹25,000 has been brought into charge". That
 * sentence is the entire explanation of a rule most people meet for the
 * first time when they hit it, and replacing it with "something went
 * wrong" throws away the only part of the interaction that teaches
 * anything.
 *
 * Each mapping below names a specific constraint, so a NEW constraint
 * failing falls through to the generic message rather than being
 * mislabelled as something it is not.
 */
export function toTdsActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return tdsFail(err.message);
  if (err instanceof AccessRestrictedError) return tdsFail(err.message);
  if (err instanceof FeatureLockedError) return tdsFail(err.message);
  if (err instanceof PermissionDeniedError) return tdsFail(err.message);

  if (err instanceof z.ZodError) {
    return tdsFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    // ⭐ THE MOST VALUABLE MESSAGE IN THE PHASE. Two deductee rows for one
    // PAN is not misuse — it is the site office and accounts each setting
    // up the same firm — and the consequence is silent under-deduction.
    if (pg.constraint?.includes("tds_deductees_pan_tenant_unique")) {
      return tdsFail(
        "That PAN is already on file for another deductee in this workspace. ⚠️ It " +
          "has to be one record: the ₹1,00,000 annual threshold under Section 194C " +
          "is on the PAN, not on the contract, so two rows split the year's running " +
          "total in two and each half sits comfortably under the limit while the " +
          "person is over it. Nothing on either row would look wrong. Find the " +
          "existing deductee and record this payment against them.",
      );
    }
    if (pg.constraint?.includes("tds_challans_oltas_key")) {
      return tdsFail(
        "That challan is already recorded. BSR code, deposit date and serial " +
          "number together are the challan's identity in the Government's own " +
          "system, so a second copy would let a month's deductions be mapped " +
          "across two records of one payment — the register would reconcile " +
          "perfectly while only half the money had moved.",
      );
    }
    if (pg.constraint?.includes("tds_returns_period_key")) {
      return tdsFail(
        "A return has already been prepared for this TAN, form, year and quarter. " +
          "A second ORIGINAL statement would put two sets of credit into the " +
          "deductees' Form 26AS, which the Department resolves by rejecting one of " +
          "them. A change to a filed return is a correction statement.",
      );
    }
    if (pg.constraint?.includes("tds_certificates_quarter_key")) {
      return tdsFail(
        "A certificate has already been assembled for this deductee for that " +
          "quarter. Two would mean the vendor holds two documents for one period, " +
          "and whichever they attach to their return is the one their assessment " +
          "is decided on.",
      );
    }
    if (pg.constraint?.includes("tds_deductees_code_tenant_unique")) {
      return tdsFail("That deductee code is already in use in this workspace.");
    }
    if (pg.constraint?.includes("tds_ldc_number_tenant_unique")) {
      return tdsFail(
        "That certificate number is already recorded for this section.",
      );
    }
    return tdsFail("That record already exists.");
  }

  if (pg?.code === "23514") {
    const constraint = pg.constraint ?? "";

    if (constraint.includes("tds_deductees_pan_status_consistent")) {
      return tdsFail(
        "A PAN status of 'valid' needs a PAN. ⚠️ Without one the rate engine would " +
          "apply the ordinary rate to a deductee who has furnished nothing, where " +
          "Section 206AA requires 20%. The shortfall is recoverable from US under " +
          "Section 201(1), and Section 205 bars us from getting it back from them " +
          "once it is deposited.",
      );
    }
    if (constraint.includes("tds_deductees_specified_person_evidenced")) {
      return tdsFail(
        "Record the date the Compliance Check utility was run. The determination " +
          "that somebody is a specified person under Section 206AB belongs to the " +
          "Income-tax Department, not to us, and an undated copy of it cannot be " +
          "relied on at an assessment.",
      );
    }
    if (constraint.includes("tds_deductions_outcome_matches_money")) {
      return tdsFail(
        "The outcome recorded on this deduction does not match the money on it. A " +
          "row marked below the threshold cannot carry tax, and a row marked " +
          "deducted cannot carry none. ⚠️ The usual cause is an outcome copied " +
          "from the previous payment.",
      );
    }
    if (constraint.includes("tds_deductions_chargeable_within_payment")) {
      return tdsFail(
        "The chargeable base does not fit the payment. The catch-up is PART of the " +
          "chargeable base, and the rest of it cannot exceed this payment.",
      );
    }
    if (constraint.includes("tds_deductions_aggregate_balances")) {
      return tdsFail(
        "The running total does not run: the aggregate after this payment must be " +
          "the aggregate before it plus the payment. ⚠️ That aggregate is what the " +
          "annual threshold is tested against, so a wrong one decides the deduction " +
          "wrongly and nothing on the row would show it.",
      );
    }
    if (constraint.includes("tds_deductions_catch_up_bounded")) {
      return tdsFail(
        "More earlier payments are being brought into charge than were ever made. " +
          "That over-deducts, and the deductee cannot recover it from us — only on " +
          "their own return a year later.",
      );
    }
    if (constraint.includes("tds_deductions_certificate_rate_is_evidenced")) {
      return tdsFail(
        "⭐ A reduced rate has to name the Section 197 certificate that authorised " +
          "it. A deduction below the section's rate is either a certificate or a " +
          "short deduction, and there is no third possibility. A certificate that " +
          "is not quoted on the return is no defence — the Department reads the " +
          "statement, not the drawer.",
      );
    }
    if (constraint.includes("tds_challans_total_balances")) {
      return tdsFail(
        "The challan's total is not the sum of its boxes. ITNS 281 carries tax, " +
          "surcharge, cess, interest and fee separately and the return quotes each " +
          "one — a total that disagrees is a reconciliation against a figure the " +
          "Government never saw.",
      );
    }
    if (constraint.includes("tds_challans_bsr_shape")) {
      return tdsFail(
        "A BSR code is exactly seven digits, INCLUDING leading zeros. ⚠️ A " +
          "spreadsheet strips them — 0001234 arrives as 1234 — and a challan " +
          "quoted with the wrong BSR matches nothing in OLTAS, so the return is " +
          "accepted and every deductee on that challan gets no credit.",
      );
    }
    if (constraint.includes("tan_shape")) {
      return tdsFail(
        "That is not a TAN. A Tax Deduction Account Number is four letters, five " +
          "digits and one letter — RTKA12345B. ⚠️ A PAN is five letters, four " +
          "digits and one letter; both are ten characters, which is why one gets " +
          "pasted into the other's field.",
      );
    }
    if (constraint.includes("tds_certificates_deposited_bounded")) {
      return tdsFail(
        "A certificate cannot certify more than was deducted. Doing so hands the " +
          "deductee a credit they will claim and their assessing officer will " +
          "disallow — from THEM, months later, on our paper.",
      );
    }
    if (constraint.includes("tds_returns_filed_is_evidenced")) {
      return tdsFail(
        "A filed return needs the date and the provisional receipt number. Without " +
          "them 'we filed it' is a claim rather than a fact, and the Section 234E " +
          "fee at ₹200 a day runs until the Department says it holds the statement.",
      );
    }
    if (constraint.includes("tds_ldc_window_sane")) {
      return tdsFail("A certificate cannot expire before it takes effect.");
    }
    // ⭐ The 206AA floor guard, the certificate-window guard, the
    // cumulative-threshold guard and the challan-capacity guard all raise
    // sentences written for a person. Keep them.
    if (pg.message) return tdsFail(stripPgNoise(pg.message));
    return tdsFail("That change is not allowed.");
  }

  if (pg?.code === "23503") {
    if (pg.constraint?.includes("tds_deductions_deductee_same_tenant")) {
      return tdsFail(
        "That deductee has tax deducted against their PAN and cannot be removed. " +
          "The deduction is the evidence for the credit in their Form 26AS — " +
          "deactivate them instead, which stops new deductions and keeps the " +
          "history.",
      );
    }
    if (pg.constraint?.includes("tds_deductions_challan_same_tenant")) {
      return tdsFail(
        "That challan discharges deductions already recorded and cannot be " +
          "removed. It is the proof the money reached the Government; without it " +
          "those deductees get no credit at all.",
      );
    }
    if (pg.constraint?.includes("tds_deductions_certificate_same_tenant")) {
      return tdsFail(
        "That Section 197 certificate is the authority for a rate already applied " +
          "and cannot be removed. Withdrawing it turns a lawful lower deduction " +
          "into an unexplained short one. Mark it inactive instead.",
      );
    }
    return tdsFail(
      "Something this refers to no longer exists. Refresh the page and try again.",
    );
  }

  if (pg?.code === "42501") {
    if (pg.message) return tdsFail(stripPgNoise(pg.message));
    return tdsFail("That change is refused.");
  }

  console.error(`[tds:${scope}]`, err);
  return tdsFail("Something went wrong. Please try again.");
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
