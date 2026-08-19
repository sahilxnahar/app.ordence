import "server-only";

/**
 * Ordence — ⭐ GSTR-2B Gate Composition
 * Version: v0.34.0-alpha
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
 * ⚠️ `guardGstr2bWrite` DELEGATES TO `guardPurchaseWrite`, which itself
 * delegates to `guardSalesWrite`. It is not a fourth copy of the same
 * four calls. Phase 22 wrote the composition, Phase 32 wrote a second
 * one WITHOUT the impersonation gate, Phase 33 chose the version WITH
 * it, and a fourth would be the point at which "the gates" stopped being
 * one thing.
 *
 * ⭐ THIS PHASE TAKES THE VERSION WITH THE IMPERSONATION GATE, and the
 * argument is the strongest yet: `gstr2b_documents` is the only table in
 * the product whose contents cannot be reconstructed from anything the
 * customer holds. A deleted purchase invoice can be re-entered from the
 * paper in the file; a deleted 2B statement can only be re-downloaded
 * from a portal that will never serve the same GENERATION of it again,
 * because it regenerates whenever a supplier files late.
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
export async function guardGstr2bWrite(args: {
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

export function gstr2bFail(
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
 * Every guard in `SQL-FILES/0024_phase34_gstr2b.sql` raises a sentence
 * written for a person — "GSTR-2B for 27… 2024-07 has already been
 * reconciled and FILED; the credit this file unlocks belongs to the
 * CURRENT period's return". That sentence is the entire explanation of a
 * rule nobody understands on first encounter, and the person hitting it
 * is doing something perfectly reasonable. Replacing it with "something
 * went wrong" throws away the only part of the interaction that teaches
 * anything, and leaves them to try again harder.
 *
 * Each mapping below names a specific constraint, so a NEW constraint
 * failing falls through to the generic message rather than being
 * mislabelled as something it is not.
 */
export function toGstr2bActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return gstr2bFail(err.message);
  if (err instanceof AccessRestrictedError) return gstr2bFail(err.message);
  if (err instanceof FeatureLockedError) return gstr2bFail(err.message);
  if (err instanceof PermissionDeniedError) return gstr2bFail(err.message);

  if (err instanceof z.ZodError) {
    return gstr2bFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    if (pg.constraint?.includes("gstr2b_documents_identity_unique")) {
      return gstr2bFail(
        "This exact statement has already been imported for this GSTIN and period — " +
          "the file is byte-for-byte identical to one already on record. If the " +
          "portal has regenerated 2B because a supplier filed late, download it " +
          "again: the new file will have a different hash and will import.",
      );
    }
    if (pg.constraint?.includes("gstr2b_reconciliations_period_unique")) {
      return gstr2bFail(
        "A reconciliation already exists for this GSTIN and period. Re-run it rather " +
          "than starting a second one — two reconciliations of one month would give " +
          "two answers to how much credit is available, and nothing would say which " +
          "one the return was built from.",
      );
    }
    // ⭐ The one-to-one indexes. A user cannot cause this from the UI; it
    // means a re-run appended instead of replacing.
    if (
      pg.constraint?.includes("gstr2b_matches_one_per_2b_row") ||
      pg.constraint?.includes("gstr2b_matches_one_per_invoice")
    ) {
      return gstr2bFail(
        "That document is already matched in this period's reconciliation. Matching " +
          "one invoice to two things makes the matched total exceed the books total " +
          "and drops a supplier off the chase list — which reads as good news. This " +
          "is a defect: report it rather than retrying.",
      );
    }
    return gstr2bFail("That record already exists.");
  }

  if (pg?.code === "23514") {
    const constraint = pg.constraint ?? "";

    // ⭐⭐ THE RULE THE PHASE TURNS ON.
    if (constraint.includes("no_silent_auto_accept")) {
      return gstr2bFail(
        "Only an EXACT match can be accepted automatically. Anything else — a value " +
          "that differs, a number that differs only in punctuation, an amendment — " +
          "has something left to judge, and a person has to be named against the " +
          "decision. At an assessment the question is 'on what basis did you treat " +
          "these as one document', and the answer cannot be 'the software did'.",
      );
    }
    if (constraint.includes("refusal_has_reason")) {
      return gstr2bFail(
        "Say why this is not a match, or what it is waiting for. Without a reason " +
          "the same exception is re-investigated from scratch every month until " +
          "somebody accepts it to make it go away.",
      );
    }
    if (constraint.includes("books_reconcile") || constraint.includes("twob_reconcile")) {
      return gstr2bFail(
        "This reconciliation does not add up: the tax in the books must equal what " +
          "matched plus what did not, and the same on the 2B side. A gap means an " +
          "invoice is in no bucket or in two — which makes 'in books, not in 2B' " +
          "smaller than it should be, and that reads as fewer suppliers to chase.",
      );
    }
    if (constraint.includes("category_matches_sides")) {
      return gstr2bFail(
        "The match category and what it points at disagree. An exact match with no " +
          "purchase invoice, or a 'not in books' match that names one, is a " +
          "contradiction — this is a defect, not a data-entry problem.",
      );
    }
    if (constraint.includes("exact_has_no_delta")) {
      return gstr2bFail(
        "A match labelled EXACT carries a difference. The label is what a reviewer " +
          "trusts and the difference is what an officer finds. Report this.",
      );
    }
    if (constraint.includes("heads_exclusive")) {
      return gstr2bFail(
        "A row carries IGST as well as CGST/SGST. On a spreadsheet import that means " +
          "the tax columns were mapped wrongly — check the header row against the " +
          "portal's own export, because this silently doubles the credit for a whole " +
          "month.",
      );
    }
    if (constraint.includes("amendment_names_original")) {
      return gstr2bFail(
        "An amendment row does not say which document it amends. An amendment " +
          "SUPERSEDES the original rather than adding to it, so without the " +
          "original's number the credit would be counted twice.",
      );
    }
    if (constraint.includes("gstin_presence")) {
      return gstr2bFail(
        "A row has no supplier GSTIN. Only an import of goods — a bill of entry, " +
          "where the counterparty is Customs — legitimately has none. Anything else " +
          "would sit in the worklist forever as an unmatched supplier who does not " +
          "exist.",
      );
    }
    if (constraint.includes("raw_present")) {
      return gstr2bFail(
        "The imported file is empty. The raw statement is the evidence for every " +
          "match built on it and cannot be stored blank.",
      );
    }
    if (constraint.includes("failure_explained")) {
      return gstr2bFail(
        "A failed import has to record why it failed, and a successful one must not " +
          "carry a stale reason.",
      );
    }
    // ⭐ The within-statement and summary-agreement triggers raise
    // sentences written for a person. Keep them.
    if (pg.message) return gstr2bFail(stripPgNoise(pg.message));
    return gstr2bFail("That change is not allowed.");
  }

  if (pg?.code === "42501") {
    // ⭐⭐ The freeze and the raw-immutability guard both land here, and
    // their messages ARE the explanation of the rule. The person hitting
    // them is doing something reasonable and has to be redirected, not
    // blocked.
    if (pg.message) return gstr2bFail(stripPgNoise(pg.message));
    return gstr2bFail(
      "That change is refused. A period whose GSTR-3B has been filed cannot be " +
        "re-imported or restated — the credit a late filing unlocks belongs to the " +
        "period you are filing now.",
    );
  }

  if (pg?.code === "23503") {
    if (pg.constraint?.includes("gstr2b_matches_invoice_same_tenant")) {
      return gstr2bFail(
        "That purchase invoice no longer exists in this workspace. Refresh the " +
          "worklist and run the reconciliation again.",
      );
    }
    return gstr2bFail(
      "Something this refers to no longer exists. Refresh the page and try again.",
    );
  }

  console.error(`[gstr2b:${scope}]`, err);
  return gstr2bFail("Something went wrong. Please try again.");
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
