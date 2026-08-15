import "server-only";

/**
 * Ordence — Tally Gate Composition
 * Version: v0.37.0-alpha
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
 * ⚠️ `guardTallyWrite` DELEGATES TO `guardPurchaseWrite`, which delegates
 * to `guardSalesWrite`. It is not a fifth copy of the same four calls.
 * Tally is where numbers leave this product and enter a customer's
 * STATUTORY books, so it gets the version WITH the impersonation gate —
 * and for a stronger reason than the purchase ledger has: an export
 * generated under an impersonated session becomes a file somebody imports
 * into the books an auditor signs, and there would be nothing in the
 * customer's own UI to say we did it.
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
import { UnmappedLedgerError } from "@/lib/tally/ledgers";
import { VoucherImbalanceError, VoucherShapeError } from "@/lib/tally/vouchers";
import { TallyAmountError } from "@/lib/tally/amounts";
import { InvalidXmlTagError } from "@/lib/tally/xml";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * ⚠️ WRITE SITES ONLY. A gate on a `get*` function produces the worst
 * upgrade prompt in the product: a page that will not render at all
 * rather than a page that renders and refuses the button. Reads use
 * `requirePermission` alone.
 */
export async function guardTallyWrite(args: {
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

export function tallyFail(
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
 * The key-stability guard in `SQL-FILES/0026_phase37_tally.sql` raises
 * the only paragraph anybody will ever read explaining why re-exporting
 * a period is safe and why it stopped being safe. Replacing it with
 * "something went wrong" throws away the only part of the interaction
 * that teaches anything — and this is a rule most people meet for the
 * first time at the moment they hit it.
 *
 * Each mapping below names a specific constraint, so a NEW constraint
 * failing falls through to the generic message rather than being
 * mislabelled as something it is not.
 */
export function toTallyActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return tallyFail(err.message);
  if (err instanceof AccessRestrictedError) return tallyFail(err.message);
  if (err instanceof FeatureLockedError) return tallyFail(err.message);
  if (err instanceof PermissionDeniedError) return tallyFail(err.message);

  if (err instanceof z.ZodError) {
    return tallyFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  /* --- The pure-layer refusals. Their messages ARE the explanation. */

  // ⭐ The one an accountant meets on their first export. It names the
  // account and says why a fallback would be worse than a refusal.
  if (err instanceof UnmappedLedgerError) return tallyFail(err.message);
  // ⭐⭐ The balance assertion. Never expected to reach a user — if it
  // does, the builder has a defect and the message says so.
  if (err instanceof VoucherImbalanceError) return tallyFail(err.message);
  if (err instanceof VoucherShapeError) return tallyFail(err.message);
  if (err instanceof TallyAmountError) return tallyFail(err.message);
  if (err instanceof InvalidXmlTagError) {
    return tallyFail(
      "The export could not be built because an element name was not valid. " +
        "This is a defect, not a data problem — please report it.",
    );
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    // ⭐⭐ THE MOST VALUABLE MESSAGE IN THE PHASE. Keep the trigger's own
    // paragraph: it is the entire explanation of why Tally doubles books.
    if (pg.message && /already been exported to Tally under the key/.test(pg.message)) {
      return tallyFail(stripPgNoise(pg.message));
    }
    if (pg.message && /Tally key .* is already used by a different/.test(pg.message)) {
      return tallyFail(stripPgNoise(pg.message));
    }
    if (pg.constraint?.includes("tally_ledger_mappings_name_ci_unique")) {
      return tallyFail(
        "Another account is already mapped to that Tally ledger. ⚠️ Tally matches " +
          "ledger names case-insensitively and ignores repeated spaces, so " +
          '"Sales A/c" and "sales  a/c" are one ledger to it. Two of our ' +
          "accounts posting to one of theirs is not a tidy merge — the " +
          "reconciliation can then never attribute a difference to either of " +
          'them, so the report says "₹4,000 out on Sales A/c" and can never say ' +
          "on what.",
      );
    }
    if (pg.constraint?.includes("tally_cost_centre_name_ci_unique")) {
      return tallyFail(
        "Another project is already mapped to that Tally cost centre. Two " +
          "projects sharing one cost centre produce a per-project P&L that " +
          "silently reports the sum of both — which is the one number this " +
          "feature exists to give you.",
      );
    }
    if (pg.constraint?.includes("tally_ledger_mappings_source_row_unique") ||
        pg.constraint?.includes("tally_ledger_mappings_source_key_unique")) {
      return tallyFail(
        "That account is already mapped. Two live mappings for one account would " +
          "mean the Tally ledger a voucher posts to is decided by a sort order, " +
          "and both would look correct on this screen.",
      );
    }
    if (pg.constraint?.includes("tally_import_batches_payload_unique")) {
      return tallyFail(
        "That exact file has already been imported and reconciled. Importing it " +
          "again would double every finding and make the worklist look twice as " +
          "bad as it is — which is how a reconciliation report stops being read. " +
          "Open the existing one instead.",
      );
    }
    if (pg.constraint?.includes("tally_vouchers_batch_remote_unique")) {
      return tallyFail(
        "That voucher is already in this batch. Two copies in one file are " +
          "resolved by Tally importing whichever it parsed last, so the figure " +
          "in the books would be decided by nothing anybody controls.",
      );
    }
    if (pg.constraint?.includes("tally_export_batches_number_unique")) {
      return tallyFail("A batch with that number already exists.");
    }
    if (pg.constraint?.includes("tally_connections_name_tenant_unique")) {
      return tallyFail("A Tally connection with that name already exists.");
    }
    return tallyFail("That record already exists.");
  }

  if (pg?.code === "23514") {
    const constraint = pg.constraint ?? "";
    if (constraint.includes("tally_vouchers_balances")) {
      return tallyFail(
        "⚠️ That voucher does not balance and has not been written. This is a " +
          "defect — please report it. Tally rejects an unbalanced voucher " +
          "part-way through an import, naming a voucher number in a file of " +
          "thousands, and on several builds it abandons the rest.",
      );
    }
    if (constraint.includes("tally_vouchers_remote_id_shape")) {
      return tallyFail(
        "⚠️ A voucher was given a Tally key that is not one of ours. This is a " +
          "defect — please report it. A random key is perfectly unique, imports " +
          "perfectly, and produces a duplicate voucher on every re-export.",
      );
    }
    if (constraint.includes("tally_export_batches_balances")) {
      return tallyFail(
        "The batch totals do not balance. This is a defect — please report it " +
          "rather than importing anything from this batch.",
      );
    }
    if (constraint.includes("tally_vouchers_non_zero_unless_cancelled")) {
      return tallyFail(
        "A voucher with no amount on it was rejected. It would import " +
          "successfully and move nothing, which is how a dropped amount survives " +
          "being looked at.",
      );
    }
    if (constraint.includes("tally_connections_private_host_is_named")) {
      return tallyFail(
        "Reaching a private address needs an address to reach. A permission with " +
          "no host named is a permission nobody can review.",
      );
    }
    if (constraint.includes("tally_ledger_mappings_gstin_only_on_party")) {
      return tallyFail(
        "Only a party ledger carries a GSTIN. Tally reads it from the PARTY " +
          "ledger; on a nominal one it is inert.",
      );
    }
    if (constraint.includes("tally_reconciliation_amount_differs")) {
      return tallyFail(
        "A difference was recorded with two identical amounts. This is a defect " +
          "in the reconciliation — please report it.",
      );
    }
    // The batch-totals guard raises a sentence written for a person.
    if (pg.message) return tallyFail(stripPgNoise(pg.message));
    return tallyFail("That change is not allowed.");
  }

  if (pg?.code === "23503") {
    // ⭐ The Section 5 trigger raises this code with its own explanation
    // of why a polymorphic column has no foreign key to lean on.
    if (pg.message) return tallyFail(stripPgNoise(pg.message));
    return tallyFail(
      "Something this refers to no longer exists. Refresh the page and try again.",
    );
  }

  if (pg?.code === "42501") {
    if (pg.message) return tallyFail(stripPgNoise(pg.message));
    return tallyFail(
      "That change is refused. An export batch is the record that a period was " +
        "already sent — losing it is what makes the next export send everything " +
        "again as new.",
    );
  }

  console.error(`[tally:${scope}]`, err);
  return tallyFail("Something went wrong. Please try again.");
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
