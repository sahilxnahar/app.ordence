/**
 * Ordence — The Recoverable Catalogue
 * Version: v0.21.0-alpha
 *
 * Pure and isomorphic. Declares WHICH tables hold recoverable records,
 * what to call them in front of a customer, and — the part that actually
 * matters — what has to be true before a row can be put back.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY "UNDELETE" IS HARDER THAN IT SOUNDS
 * ══════════════════════════════════════════════════════════════════════
 * Setting `deleted_at = NULL` is one UPDATE. It is also, on its own,
 * wrong, in three specific ways that only surface later:
 *
 *   1. THE PARENT MAY BE GONE. Restoring a contact whose company was
 *      also deleted produces a record that renders as "— (deleted)" and
 *      cannot be edited. The customer restores it, sees it broken, and
 *      concludes the restore failed.
 *
 *   2. A UNIQUE KEY MAY HAVE BEEN REUSED. Delete a contact with
 *      priya@acme.com, create a new one with the same address, restore
 *      the old one — 23505, and if the caller swallows it, a silent
 *      no-op that reports success.
 *
 *   3. IT MAY BE INSIDE A CLOSED FINANCIAL PERIOD. A journal entry
 *      restored into a closed month changes a figure that has already
 *      been reported. That is not a restore, it is a restatement, and it
 *      needs a different conversation.
 *
 * So every entry below carries its own preconditions, and the restore
 * path checks them BEFORE writing rather than catching a constraint
 * violation afterwards — because the constraint tells you something
 * failed, not what the customer should do about it.
 */

/* ------------------------------------------------------------------ */
/* THE CATALOGUE                                                       */
/* ------------------------------------------------------------------ */

import type { PermissionKey } from "@/db/schema/auth";

export type RecoverableEntity = {
  /** Physical table name. */
  table: string;
  /** What a customer calls it. Singular. */
  label: string;
  labelPlural: string;
  /** Column holding the human-readable name, for the recycle-bin list. */
  displayColumn: string;
  /**
   * Parent references that must still be live before this row can be
   * restored. Checked in order; the first broken one is reported.
   */
  parents: { column: string; table: string; label: string }[];
  /**
   * Columns that participate in a partial unique index scoped to live
   * rows. If a live row now holds the same value, restoring would
   * collide.
   */
  uniqueWithinTenant: string[];
  /**
   * True when restoring this row can change a reported financial figure.
   * Those go through a stricter path — see `requiresFinancialReview`.
   */
  financiallySignificant: boolean;
  /**
   * 🔴 THE PERMISSION THE RESTORER MUST HOLD, added in v1.31.0.
   *
   * `restoreFromRecycleBin` required `contacts:update` for EVERY table
   * in this catalogue, so a `member` — who holds `contacts:update` but
   * neither `contracts:update` nor `documents:create` — could resurrect
   * a contract or a document that counsel had deliberately deleted.
   *
   * ⚠️ UN-DELETING IS AS CONSEQUENTIAL AS DELETING. If somebody may not
   * edit the thing, they may not bring it back either.
   */
  restorePermission: PermissionKey;
};

/**
 * ⚠️ NOT every table with a `deleted_at` column is here, and the
 * omissions are deliberate:
 *
 *   `tenants`          — restoring a whole workspace is a platform-admin
 *                        operation with billing consequences, not a
 *                        customer-facing undelete. Phase 17's console.
 *   `users`            — reactivation flows through the seat gate in
 *                        Phase 13, which can legitimately refuse. Putting
 *                        it here too would give two doors into one
 *                        decision.
 *   `subscriptions`    — never soft-deleted in practice; cancelled.
 *   `payment_methods`  — the provider token is likely revoked by now, so
 *                        a restored row would look valid and fail at the
 *                        moment of charge.
 *   `ledgers`          — a ledger with entries cannot be meaningfully
 *                        restored in isolation.
 *
 * Each of those has a real reason. "It has the column" is not one.
 */
export const RECOVERABLE_ENTITIES: readonly RecoverableEntity[] = Object.freeze([
  {
    table: "contacts",
    label: "Contact",
    labelPlural: "Contacts",
    // ⚠️ `contacts` has no `full_name`. A first draft of this catalogue
    // assumed one and the coherence test caught it — the recycle bin
    // would have thrown on the contacts category and shown nothing,
    // which reads to a customer as "gone forever".
    displayColumn: "first_name",
    parents: [{ column: "company_id", table: "companies", label: "Company" }],
    // A live contact may now hold this email.
    uniqueWithinTenant: ["email"],
    financiallySignificant: false,
    restorePermission: "contacts:update",
  },
  {
    table: "companies",
    label: "Company",
    labelPlural: "Companies",
    displayColumn: "name",
    parents: [],
    uniqueWithinTenant: [],
    financiallySignificant: false,
    restorePermission: "companies:update",
  },
  {
    table: "deals",
    label: "Deal",
    labelPlural: "Deals",
    displayColumn: "title",
    parents: [
      { column: "company_id", table: "companies", label: "Company" },
      { column: "contact_id", table: "contacts", label: "Contact" },
    ],
    uniqueWithinTenant: [],
    financiallySignificant: false,
    restorePermission: "deals:update",
  },
  {
    table: "assets",
    label: "Asset",
    labelPlural: "Assets",
    displayColumn: "name",
    parents: [],
    uniqueWithinTenant: ["code"],
    financiallySignificant: false,
    restorePermission: "assets:update",
  },
  {
    table: "contracts",
    label: "Contract",
    labelPlural: "Contracts",
    displayColumn: "title",
    parents: [],
    uniqueWithinTenant: [],
    // A contract carries a value that feeds the pipeline figures.
    financiallySignificant: true,
    restorePermission: "contracts:update",
  },
  {
    table: "documents",
    label: "Document",
    labelPlural: "Documents",
    displayColumn: "file_name",
    parents: [],
    uniqueWithinTenant: [],
    financiallySignificant: false,
    restorePermission: "documents:create",
  },
  {
    table: "custom_object_records",
    label: "Custom record",
    labelPlural: "Custom records",
    displayColumn: "display_value",
    parents: [
      {
        // Also caught by the coherence test: the column is
        // `definition_id`, not `object_definition_id`.
        column: "definition_id",
        table: "custom_object_definitions",
        label: "Record type",
      },
    ],
    uniqueWithinTenant: [],
    financiallySignificant: false,
    restorePermission: "custom_objects:update_record",
  },
]);

export function recoverableFor(table: string): RecoverableEntity | null {
  return RECOVERABLE_ENTITIES.find((entity) => entity.table === table) ?? null;
}

export const RECOVERABLE_TABLES = RECOVERABLE_ENTITIES.map((e) => e.table);

/* ------------------------------------------------------------------ */
/* RETENTION                                                           */
/* ------------------------------------------------------------------ */

/**
 * How long a deleted record stays recoverable.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY 30 DAYS AND WHY IT IS NOT ENFORCED BY DELETION
 * ══════════════════════════════════════════════════════════════════════
 * Thirty days covers the realistic accident: someone deletes the wrong
 * record on a Friday and notices when a colleague asks about it. It is
 * also the window most people expect, because it is what every consumer
 * product has trained them to expect.
 *
 * ⚠️ NOTHING IN THIS PHASE HARD-DELETES ANYTHING AFTER THE WINDOW.
 *
 * That is deliberate, and it is the opposite of what a "retention
 * period" usually implies. A sweeper that permanently destroys customer
 * rows on a timer is a piece of code whose failure mode is unrecoverable
 * data loss, running unattended, forever. The first time its predicate
 * is subtly wrong — a timezone, a join, a `deleted_at` set by an
 * unrelated migration — it deletes something nobody asked it to, and
 * there is no undo.
 *
 * So the window governs what the RECYCLE BIN SHOWS, not what exists.
 * Older rows stay in the database, invisible to the customer, and are
 * removed by a deliberate human operation under DPDP erasure — which is
 * a request that has to be answered anyway and comes with a person
 * attached to it.
 *
 * The cost is storage. The alternative cost is a headline.
 */
export const RECOVERY_WINDOW_DAYS = 30;

export function isWithinRecoveryWindow(deletedAt: Date, now: Date): boolean {
  const ageMs = now.getTime() - deletedAt.getTime();
  return ageMs >= 0 && ageMs <= RECOVERY_WINDOW_DAYS * 86_400_000;
}

/** Days left before a record drops out of the recycle bin. */
export function daysRemaining(deletedAt: Date, now: Date): number {
  const elapsed = Math.floor((now.getTime() - deletedAt.getTime()) / 86_400_000);
  return Math.max(0, RECOVERY_WINDOW_DAYS - elapsed);
}

/* ------------------------------------------------------------------ */
/* PRECONDITIONS                                                       */
/* ------------------------------------------------------------------ */

export type RestoreBlocker =
  | { kind: "parent_deleted"; parentLabel: string; parentTable: string }
  | { kind: "unique_conflict"; column: string; value: string }
  | { kind: "outside_window"; deletedAt: string }
  | { kind: "period_closed"; periodLabel: string }
  | { kind: "not_recoverable"; table: string };

export type RestoreVerdict = {
  allowed: boolean;
  blockers: RestoreBlocker[];
  /** Ready to show a customer. Says what to do, not just what is wrong. */
  message: string;
};

/**
 * Turn blockers into something a person can act on.
 *
 * ⚠️ EVERY MESSAGE NAMES THE REMEDY. "Cannot restore: parent deleted" is
 * a status; "Restore the company first, then this contact" is an
 * instruction. The second one closes the support ticket.
 */
export function describeRestore(blockers: RestoreBlocker[]): RestoreVerdict {
  if (blockers.length === 0) {
    return { allowed: true, blockers: [], message: "This can be restored." };
  }

  const first = blockers[0]!;

  switch (first.kind) {
    case "parent_deleted":
      return {
        allowed: false,
        blockers,
        message:
          `The ${first.parentLabel.toLowerCase()} this belongs to was also ` +
          `deleted. Restore the ${first.parentLabel.toLowerCase()} first, then ` +
          `come back to this — restoring it now would leave a record you ` +
          `cannot open.`,
      };

    case "unique_conflict":
      return {
        allowed: false,
        blockers,
        message:
          `Another record is already using ${first.column} “${first.value}”. ` +
          `Change or remove that one first, or edit this record's ${first.column} ` +
          `after restoring a copy.`,
      };

    case "outside_window":
      return {
        allowed: false,
        blockers,
        message:
          `This was deleted more than ${RECOVERY_WINDOW_DAYS} days ago, so it no ` +
          `longer appears in the recycle bin. It has not been destroyed — ` +
          `contact us and we can recover it.`,
      };

    case "period_closed":
      return {
        allowed: false,
        blockers,
        message:
          `This falls inside ${first.periodLabel}, which has been closed. ` +
          `Restoring it would change a figure that has already been reported. ` +
          `Reopen the period first if that is genuinely what you intend.`,
      };

    case "not_recoverable":
      return {
        allowed: false,
        blockers,
        message:
          `Records of this type are not restored from the recycle bin. ` +
          `Contact us and we will help.`,
      };
  }
}
