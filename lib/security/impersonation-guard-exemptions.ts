/**
 * Ordence — ⭐⭐⭐ THE TWELVE TABLES WITH NO IMPERSONATION DELETE GUARD
 * Version: v1.83.0-alpha · Track D, wave 17
 *
 * Pure. Data plus one predicate. No database, no `server-only`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * SQL 0125's `attach_impersonation_guards()` puts
 * `no_delete_under_impersonation` on every tenant-scoped base table. On the
 * assembled wave-17 tree it covers **294 of 306**. Twelve do not have it.
 *
 * Wave 15 recommended leaving all twelve and said so in a report.
 * Integration's reply was the right one:
 *
 *   *"You recommended leaving all twelve and recording the decision so the
 *   next sweep does not re-derive it. Write that record; it belongs in a
 *   migration comment or a doc, not only in a report."*
 *
 * ⚠️ AND A COMMENT WOULD HAVE BEEN THE WRONG SHAPE, for the reason this
 * repository keeps relearning: a paragraph enforces nothing. Twelve tables
 * recorded in prose is twelve tables somebody re-derives in wave 19,
 * reaches the same conclusion, and writes down again — or, worse, a
 * THIRTEENTH appears and the prose still says twelve.
 *
 * So the decision is DATA, with a reason per table, and it is CHECKED:
 *
 *   • `tests/security/impersonation-guard-exemptions.test.ts` queries
 *     `pg_trigger` and asserts the live unguarded set is exactly this set.
 *     A new unguarded table fails the build naming itself; a table that
 *     GAINS the guard fails too, because a stale exemption claiming "this
 *     one is deliberate" is worse than no entry.
 *   • `SQL-FILES/TRACK-D-PENDING-NUMBER-impersonation-guard-exemption-record.sql`
 *     carries the same check as a migration that raises, for the database
 *     side.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ARGUMENT, ONCE, SO NOBODY HAS TO REBUILD IT
 * ══════════════════════════════════════════════════════════════════════
 * The guard exists so that a member of Ordence staff, inside a customer's
 * workspace wearing the customer's face, cannot DELETE the customer's
 * records. Every one of the twelve fails to be a thing that describes:
 *
 *   ① EVIDENCE — already protected by something STRICTER. An append-only
 *     trigger refuses DELETE from every role, impersonating or not, so the
 *     impersonation guard would be a weaker second lock on a stronger door.
 *   ② PLATFORM-OWNED — the rows are Ordence's, not the customer's. They
 *     carry a `tenant_id` because they are ABOUT a tenant, not because a
 *     tenant owns them. Refusing our staff a delete under impersonation
 *     would refuse the only people who legitimately administer them.
 *   ③ METERING — derived, regenerable, and not the customer's record of
 *     anything. Deleting a usage counter loses a number we recompute.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND WRITING IT DOWN CHANGED THE ANSWER FOR ONE OF THEM
 * ══════════════════════════════════════════════════════════════════════
 * Wave 15 recommended leaving ALL TWELVE. Turning that recommendation into
 * a check — `tests/security/impersonation-guard-exemptions.test.ts`, which
 * asks the database whether each claimed protection actually exists —
 * found that ELEVEN hold and ONE does not.
 *
 * `change_log` carries **no trigger at all**. Measured:
 *
 *     SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 *      WHERE NOT t.tgisinternal AND c.relname = 'change_log';
 *     (0 rows)
 *
 * What stops a delete today is a REVOKE: `has_table_privilege('ordence_app',
 * 'change_log', 'DELETE')` is `f`.
 *
 * ⚠️ AND A REVOKE IS INERT IN PRODUCTION. This project's own standing rule,
 * stated at the top of every Track brief: *"production connects as
 * `neondb_owner`, and that role OWNS the tables. A table owner is not
 * subject to GRANT or REVOKE … if you write a control that depends on a
 * GRANT, you have written nothing."*
 *
 * So `change_log` — the field-level history behind the audit trail — is
 * deletable in production, including by a member of Ordence staff inside a
 * customer's workspace wearing the customer's face. It is the one table of
 * the twelve where the wave-15 recommendation was wrong, and it is marked
 * `verdict: "needs_action"` below rather than quietly re-argued.
 *
 * ⚠️ NONE OF THE OTHER ELEVEN IS "we forgot". That distinction is the
 * entire value of this file: a reviewer who finds twelve gaps has to decide
 * whether they are gaps, and that decision costs an afternoon each time.
 */

export type GuardExemptionReason = "evidence" | "platform_owned" | "metering";

/**
 * ⚠️ THE FIELD THAT STOPS THIS BEING A RUBBER STAMP.
 *
 * `leave` — the exemption holds; the guard would add nothing.
 * `needs_action` — recorded as exempt today and it SHOULD NOT BE. The entry
 *   exists so the gap is visible and attributed, not so it is blessed. A
 *   ledger where every row says "fine" is a ledger nobody re-reads.
 */
export type GuardExemptionVerdict = "leave" | "needs_action";

/**
 * What actually refuses a DELETE, as a machine-checkable claim.
 *
 * ⚠️ `revoke_only` IS NOT A PROTECTION IN THIS DEPLOYMENT and the name says
 * so. Production connects as the table OWNER, which GRANT and REVOKE do not
 * bind. The test asserts that anything resting on `revoke_only` is marked
 * `needs_action`.
 */
export type GuardProtection = "delete_trigger" | "revoke_only" | "none";

export type GuardExemption = {
  /** The Postgres table name. */
  readonly table: string;
  readonly reason: GuardExemptionReason;
  readonly verdict: GuardExemptionVerdict;
  /** Why this table does not need the guard, in one sentence a reviewer can check. */
  readonly note: string;
  /**
   * ⭐ CHECKED AGAINST `pg_trigger` AND `has_table_privilege`, not trusted.
   * A claim of `delete_trigger` on a table with no trigger fails the build.
   */
  readonly protection: GuardProtection;
  /** The human name of the protector, for a reviewer reading the ledger. */
  readonly protectedBy: string | null;
};

/**
 * ⚠️ THE ORDER IS ALPHABETICAL AND MUST STAY THAT WAY. The test compares
 * this against `ORDER BY table_name` from the database; a hand-sorted list
 * that drifted would produce a diff about ordering rather than about
 * coverage, which is exactly the noise that gets a check disabled.
 */
export const IMPERSONATION_GUARD_EXEMPTIONS: readonly GuardExemption[] = [
  {
    table: "audit_logs",
    verdict: "leave",
    protection: "delete_trigger",
    reason: "evidence",
    note:
      "The customer-facing record of who did what. A DELETE is refused for every " +
      "role, impersonating or not — the impersonation guard would be a strictly " +
      "weaker lock on a door that is already bolted.",
    protectedBy: "append-only trigger + hash chain",
  },
  {
    table: "change_log",
    verdict: "needs_action",
    protection: "revoke_only",
    reason: "evidence",
    note:
      "🔴 THE ONE THAT WAS WRONG. Field-level history behind the audit trail — and " +
      "unlike its four siblings it carries NO trigger at all. `pg_trigger` returns " +
      "zero rows for it. The only thing refusing a DELETE is a REVOKE from " +
      "`ordence_app`, which does not bind `neondb_owner`, which is what production " +
      "connects as. It needs either `no_delete_under_impersonation` or a " +
      "`change_log_no_delete` trigger matching `audit_logs_no_delete`; a REVOKE is " +
      "not a control in this deployment.",
    protectedBy: "REVOKE from ordence_app only — ⚠️ INERT against the production owner",
  },
  {
    table: "error_events",
    verdict: "leave",
    protection: "delete_trigger",
    reason: "evidence",
    note:
      "Diagnostics we keep about our own failures. Never the customer's record of " +
      "anything, and never a thing a customer asks us to delete on their behalf.",
    protectedBy: "append-only trigger",
  },
  {
    table: "permission_denials",
    verdict: "leave",
    protection: "delete_trigger",
    reason: "evidence",
    note:
      "Every refused permission check. A cluster of these is the clearest early " +
      "signal of an account being misused, which is precisely why deleting them " +
      "must not be possible for anyone rather than merely hard under impersonation.",
    protectedBy: "append-only trigger",
  },
  {
    table: "platform_impersonation_sessions",
    verdict: "leave",
    protection: "none",
    reason: "platform_owned",
    note:
      "🔴 THE RECORD OF THE IMPERSONATION ITSELF. Guarding it with a trigger keyed " +
      "on `app.impersonation_id` would mean the session row could not be closed by " +
      "the session that opened it. The guard would be self-defeating here in the " +
      "most literal sense.",
    protectedBy: "platform RLS + append-only closure semantics",
  },
  {
    table: "platform_tenant_flags",
    verdict: "leave",
    protection: "none",
    reason: "platform_owned",
    note:
      "Feature overrides Ordence sets for one workspace. Written by platform staff " +
      "through the console, never by the tenant; a tenant-facing delete guard would " +
      "protect the customer from a row the customer cannot see or set.",
    protectedBy: "platform capability check (`flags:write`)",
  },
  {
    table: "security_events",
    verdict: "leave",
    protection: "delete_trigger",
    reason: "evidence",
    note:
      "The SecOps stream. DELETE is refused for every role INCLUDING the table " +
      "owner; retention is `prune_security_events()`, which requires a privileged " +
      "role. Measured in wave 15: even the superuser is refused.",
    protectedBy: "prevent_security_event_delete / prevent_security_event_mutation",
  },
  {
    table: "tenant_health_events",
    verdict: "leave",
    protection: "none",
    reason: "platform_owned",
    note:
      "Ordence's own churn and health signals about an account. The customer is the " +
      "subject, not the author; nothing here is theirs to lose.",
    protectedBy: "platform read scope",
  },
  {
    table: "tenant_support_consents",
    verdict: "leave",
    protection: "none",
    reason: "platform_owned",
    note:
      "⚠️ THE CONSENT THAT AUTHORISES IMPERSONATION IN THE FIRST PLACE. It is the " +
      "customer's grant to us, administered on our side; a staff member inside a " +
      "workspace must not be able to delete the record of the permission they are " +
      "using — which is an argument for append-only, not for this guard.",
    protectedBy: "platform capability check + withdrawal-not-deletion semantics",
  },
  {
    table: "usage_counters",
    verdict: "leave",
    protection: "none",
    reason: "metering",
    note:
      "Derived counters recomputed from source events. Deleting one loses a number " +
      "the next sweep regenerates; it is not a customer record.",
    protectedBy: null,
  },
  {
    table: "usage_levels",
    verdict: "leave",
    protection: "none",
    reason: "metering",
    note: "The tier a counter resolves to. Same argument as `usage_counters`.",
    protectedBy: null,
  },
  {
    table: "web_vital_events",
    verdict: "leave",
    protection: "none",
    reason: "metering",
    note:
      "Browser performance samples. Aggregate, anonymous to the workspace's own " +
      "users, and regenerated continuously by traffic.",
    protectedBy: null,
  },
];

export const EXEMPT_TABLE_NAMES: readonly string[] =
  IMPERSONATION_GUARD_EXEMPTIONS.map((e) => e.table);

export function exemptionFor(table: string): GuardExemption | null {
  return IMPERSONATION_GUARD_EXEMPTIONS.find((e) => e.table === table) ?? null;
}

/**
 * The SQL the test and the migration both run.
 *
 * ⚠️ ONE COPY, EXPORTED, RATHER THAN TWO NEARLY-IDENTICAL QUERIES. Two
 * hand-maintained copies of a coverage query is how a check ends up
 * measuring something subtly different from the thing it reports on —
 * `relkind='r'` in one and not the other would silently pull 22 views into
 * the count.
 */
export const UNGUARDED_TENANT_TABLES_SQL = `
  SELECT c.table_name
    FROM information_schema.columns c
    JOIN pg_class k
      ON k.relname = c.table_name
     AND k.relnamespace = 'public'::regnamespace
   WHERE c.table_schema = 'public'
     AND c.column_name = 'tenant_id'
     AND k.relkind = 'r'
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = k.oid
          AND t.tgname = 'no_delete_under_impersonation'
     )
   ORDER BY 1
`;
