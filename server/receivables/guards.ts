import "server-only";

/**
 * Ordence — ⭐ Receivables Gate Composition
 * Version: v0.38.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SAME FOUR GATES, IN THE SAME ORDER, FOR THE SAME REASONS
 * ══════════════════════════════════════════════════════════════════════
 *   1. ACCESS        — may this workspace WRITE at all? An unpaid account
 *                      is read-only.
 *   2. ENTITLEMENT   — has it paid for the capability?
 *   3. PERMISSION    — may this PERSON do it?
 *   4. IMPERSONATION — is this our own support staff wearing a customer's
 *                      face, and is this something a session may never do?
 *
 * ⚠️ THE ORDER DECIDES WHO GETS THE MESSAGE. Reversed, a workspace owner
 * whose card expired is told "you do not have permission" and sent to an
 * administrator who is themselves.
 *
 * ⚠️ `guardReceivablesWrite` DELEGATES TO `guardSalesWrite`. It is not a
 * fifth copy of the same four calls — and it takes the version WITH the
 * impersonation gate deliberately. Everything in this phase either asks a
 * buyer for money, records money received, or threatens somebody's home;
 * a support session must not be able to do any of the three under a
 * customer's name, and none of the three is visible as ours afterwards.
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
import {
  AllocationError,
  AllocationImbalanceError,
} from "@/lib/receivables/allocation";
import { StatementImbalanceError } from "@/lib/receivables/statement";
import { TemplateRenderError } from "@/lib/receivables/render";
import { TemplatePackError } from "@/lib/receivables/templates/contract";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * ⚠️ WRITE SITES ONLY. A gate on a `get*` function produces the worst
 * upgrade prompt in the product: a page that will not render at all
 * rather than a page that renders and refuses the button. Reads use
 * `requirePermission` alone.
 */
export async function guardReceivablesWrite(args: {
  operation: string;
  feature: FeatureKey;
  permission: string;
  resource?: { type?: string; id?: string };
  impersonationOperation?: string;
}): Promise<TenantContext> {
  return guardSalesWrite(args);
}

/* ------------------------------------------------------------------ */
/* ERROR TRANSLATION                                                   */
/* ------------------------------------------------------------------ */

export function receivablesFail(
  error: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * Turn anything thrown into a safe, useful envelope.
 *
 * ⚠️ THE TRIGGER AND LIBRARY MESSAGES ARE PASSED THROUGH, NOT REPLACED.
 *
 * Every guard in `SQL-FILES/0027_phase38_receivables.sql` raises a
 * sentence written for a person — "this demand has not been sent a first
 * notice, so a final notice cannot be sent". That sentence is the entire
 * explanation of a rule most people meet for the first time when they hit
 * it, and replacing it with "something went wrong" throws away the only
 * part of the interaction that teaches anything.
 *
 * Each mapping below names a specific constraint, so a NEW constraint
 * failing falls through to the generic message rather than being
 * mislabelled as something it is not.
 */
export function toReceivablesActionError(
  err: unknown,
  scope: string,
): ActionResult<never> {
  if (err instanceof TenantAccessError) return receivablesFail(err.message);
  if (err instanceof AccessRestrictedError) return receivablesFail(err.message);
  if (err instanceof FeatureLockedError) return receivablesFail(err.message);
  if (err instanceof PermissionDeniedError) return receivablesFail(err.message);

  if (err instanceof z.ZodError) {
    return receivablesFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  /* --- ⭐⭐ THE ARITHMETIC REFUSALS. ---------------------------- */
  //
  // ⚠️ THESE ARE NOT USER ERRORS AND THEY ARE NOT SHOWN AS ONE. An
  // imbalance means this code is wrong, and the correct behaviour is to
  // write nothing and say so — a receipt that is two paise short of
  // itself produces a statement of account that does not foot, found by
  // a buyer who is already in dispute.
  if (err instanceof AllocationImbalanceError || err instanceof StatementImbalanceError) {
    console.error(`[receivables:${scope}] IMBALANCE`, err);
    return receivablesFail(err.message);
  }

  if (err instanceof AllocationError) {
    return receivablesFail(`${err.message} ${err.remedy}`);
  }

  if (err instanceof TemplateRenderError || err instanceof TemplatePackError) {
    return receivablesFail(`${err.message} ${err.remedy}`);
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    // ⭐ THE MOST VALUABLE MESSAGE IN THE PHASE. Two live demands for one
    // milestone is not misuse — it is accounts and the project accountant
    // both doing their job — and the consequence lands on a buyer who has
    // paid.
    if (pg.constraint?.includes("demand_notices_one_live_per_milestone")) {
      return receivablesFail(
        "A demand is already outstanding for this milestone. ⚠️ Two live demands for " +
          "the same stage means two documents in the buyer's hands asking for the " +
          "same money: they pay one, the other ages into the 90+ bucket, and the " +
          "dunning ladder starts climbing against somebody who has paid in full. " +
          "Open the existing demand — cancel it or supersede it if it is wrong.",
      );
    }
    if (pg.constraint?.includes("dunning_events_rung_once")) {
      return receivablesFail(
        "That step of the ladder has already been sent on this demand. Re-sending " +
          "the same letter is fine, but it is recorded as the same rung — a second " +
          "row would make the ladder look as though it had been climbed twice.",
      );
    }
    if (pg.constraint?.includes("receipt_allocations_pair_unique")) {
      return receivablesFail(
        "This receipt is already applied to that demand. Change the existing " +
          "allocation rather than adding a second one — two rows for one pair would " +
          "double-count the payment on the buyer's statement.",
      );
    }
    if (pg.constraint?.includes("demand_notices_number_tenant_unique")) {
      return receivablesFail(
        "That demand number is already used in this workspace. A reused number on a " +
          "document a buyer quotes in a bank transfer is a payment nobody can match.",
      );
    }
    if (pg.constraint?.includes("receipts_number_tenant_unique")) {
      return receivablesFail("That receipt number is already used in this workspace.");
    }
    if (pg.constraint?.includes("demand_notice_documents_demand_doc_unique")) {
      return receivablesFail(
        "That document has already been rendered for this demand in that language. " +
          "The stored copy is what was served — re-rendering it would answer a " +
          "question about today's template rather than about the document in the " +
          "buyer's hand.",
      );
    }
    return receivablesFail("That record already exists.");
  }

  if (pg?.code === "23514") {
    const constraint = pg.constraint ?? "";

    if (constraint.includes("dunning_events_cancellation_is_authorised")) {
      return receivablesFail(
        "⚠️ A cancellation warning needs a named person and a stated reason. This is " +
          "the letter that precedes terminating the allotment and forfeiting what " +
          "the buyer has paid — everything below it can be sent by a scheduled " +
          'sweep, and this one may not be, ever. "The system sent it automatically" ' +
          "is not an answer anybody can give at a hearing.",
      );
    }
    if (constraint.includes("demand_notices_not_over_applied")) {
      return receivablesFail(
        "That would apply more money to this demand than the demand is for. An " +
          "over-payment is a CREDIT on the buyer's account, not a negative balance " +
          "on a document — the moment a demand can go past its own total, the " +
          "statement of account stops footing and no report shows why.",
      );
    }
    if (constraint.includes("receipts_not_over_applied")) {
      return receivablesFail(
        "That would apply more than this receipt is worth. The excess is a credit on " +
          "the buyer's account and is applied to the next demand raised.",
      );
    }
    if (constraint.includes("receipts_bounced_is_released")) {
      return receivablesFail(
        "A bounced receipt cannot keep money applied against a demand. Release its " +
          "allocations first — the cheque was never money, the demand was " +
          "outstanding throughout, and the interest clock never stopped.",
      );
    }
    if (constraint.includes("demand_notices_totals_balance")) {
      return receivablesFail(
        "This demand's total does not equal its principal plus its tax. This is a " +
          "defect — do not issue it, and report it. A document whose own arithmetic " +
          "fails in front of the person paying it cannot be defended.",
      );
    }
    if (constraint.includes("demand_notices_tax_kind_is_singular")) {
      return receivablesFail(
        "This demand carries both IGST and CGST/SGST. One supply is taxed one way — " +
          "and for a flat it is always the STATE THE FLAT IS IN (Section 12(3), IGST " +
          "Act), never the buyer's address.",
      );
    }
    if (constraint.includes("receipt_allocations_legs_balance")) {
      return receivablesFail(
        "An allocation's principal, tax and interest do not add up to its own total. " +
          "This is a defect — report it.",
      );
    }
    if (constraint.includes("dunning_policies_ladder_ascends")) {
      return receivablesFail(
        "Each step of the ladder must come strictly after the one before it. " +
          "Otherwise the sweep sends two letters on the same morning, which reads to " +
          "the buyer as a machine and to the Authority as a developer who never gave " +
          "them a chance.",
      );
    }
    if (constraint.includes("demand_notices_due_after_notice")) {
      return receivablesFail("A demand cannot fall due before the day it is dated.");
    }
    if (constraint.includes("demand_notices_ladder_follows_issue")) {
      return receivablesFail(
        "This demand has not been issued, so it cannot be chased. A letter about a " +
          "document the buyer never received is the fastest way to lose the argument " +
          "about whether they were ever asked.",
      );
    }
    if (constraint.includes("demand_notice_documents_fallback_is_honest")) {
      return receivablesFail(
        "A notice recorded as having fallen back to another language for its " +
          "amount-in-words must say which language. A row that cannot express the " +
          "fallback is a row that hides it.",
      );
    }
    // ⭐ The Section 5, 6 and 7 triggers raise sentences written for a
    // person — the skipped rung, the allocation that does not sum, the
    // issued demand that cannot be edited. Keep them.
    if (pg.message) return receivablesFail(stripPgNoise(pg.message));
    return receivablesFail("That change is not allowed.");
  }

  if (pg?.code === "42501") {
    return receivablesFail(
      "That is refused. A demand notice, a receipt and a rung of the dunning ladder " +
        "are all evidence in a dispute between this workspace and a buyer, and none " +
        "of them can be deleted — a demand raised in error is cancelled or " +
        "superseded, and a cheque that came back is marked bounced. Both keep the " +
        "row, and the row is what the buyer can be shown.",
    );
  }

  if (pg?.code === "23503") {
    return receivablesFail(
      "Something this refers to no longer exists. Refresh the page and try again.",
    );
  }

  console.error(`[receivables:${scope}]`, err);
  return receivablesFail("Something went wrong. Please try again.");
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
