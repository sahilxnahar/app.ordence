/**
 * Ordence — Is row-level security actually in force for THIS connection?
 * Version: v1.60.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Tenant isolation in this product IS row-level security. 171 tables
 * carry `FORCE ROW LEVEL SECURITY`, `check:rls` fails the build on a
 * single unprotected one, and `withTenant` exists to set the GUC those
 * policies read.
 *
 * ⚠️ NONE OF THAT APPLIES TO A ROLE WITH `rolbypassrls`. The policies
 *    still exist. `pg_class.relforcerowsecurity` is still true.
 *    `check:rls` still passes, because it reads pg_catalog. And the
 *    engine skips every policy for that role.
 *
 * On Neon, the default owner `neondb_owner` HAS `rolbypassrls`. So
 * whether tenant isolation is enforced by the database or resting
 * entirely on the application remembering `withTenant` came down to one
 * fact nobody had ever checked: which role `DATABASE_URL` authenticates
 * as.
 *
 * 🔴 IT TOOK TEN SESSIONS TO ANSWER, AND THE REASON IS THAT NOTHING IN
 *    THE PRODUCT COULD SEE IT. Every signal was green. `check:rls`
 *    measured the catalog, which was correct, and was blind to the one
 *    thing that decided whether the catalog mattered.
 *
 *    That is the same defect shape as the CI floor of
 *    `if [ "$COUNT" -lt 100 ]` that `check:rls` itself was written to
 *    replace: a check that measures the wrong thing passes confidently.
 *
 * ⭐ SO THE PRODUCT NOW REPORTS IT. The answer today is the good one
 *    (`ordence_app`, `rolbypassrls = false`), and this module exists so
 *    that if it ever silently changes , a new environment, a debugging
 *    session, someone pasting the owner URL into Railway , something
 *    says so instead of everything staying green.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS ADVISORY AND NOT A BOOT REFUSAL
 * ══════════════════════════════════════════════════════════════════════
 * `lib/env-boot.ts` deliberately asks one question per name and never
 * touches the network, because a boot assertion that can fail for an
 * interesting reason will one day refuse a deploy at 2am for a reason
 * nobody can reproduce. A database round trip at boot is exactly that.
 *
 * Refusing to start would also mean a Neon blip takes the product down,
 * which is a worse failure than a degraded posture nobody can see. So:
 * reported loudly, everywhere an operator looks, never fatal.
 *
 * This module is PURE. It does no I/O so it can be tested without a
 * database. The query lives in `server/platform/rls-posture.ts`.
 */

export type RlsPostureFacts = {
  /** `current_user` of the connection the application actually made. */
  role: string;
  /** `pg_roles.rolbypassrls` for that role. */
  bypassesRls: boolean;
  /** `pg_roles.rolsuper` for that role. */
  isSuperuser: boolean;
};

export type RlsPostureLevel = "enforced" | "bypassed" | "unknown";

export type RlsPosture = {
  level: RlsPostureLevel;
  /** Short label. ⚠️ Carries a WORD, never a colour alone. */
  label: string;
  /** What is true, in one sentence an operator can act on. */
  detail: string;
  /** What to do about it. Empty when there is nothing to do. */
  remedy: string;
};

/**
 * 🔴 A SUPERUSER BYPASSES RLS *AND* EVERY TRIGGER-BASED CONTROL, so it is
 *    reported separately rather than folded into the same message. The
 *    slug guard, the period-close guard and the append-only ledger guards
 *    are triggers. `rolbypassrls` alone leaves those intact; superuser
 *    does not.
 */
export function interpretRlsPosture(facts: RlsPostureFacts | null): RlsPosture {
  if (facts === null) {
    return {
      level: "unknown",
      label: "UNKNOWN",
      detail:
        "The database did not answer which role this connection uses, so whether row-level security applies is unknown.",
      remedy:
        "Treat as unverified rather than as safe. Re-check once the database is reachable.",
    };
  }

  if (facts.isSuperuser) {
    return {
      level: "bypassed",
      label: "BYPASSED (superuser)",
      detail:
        `The application connects as "${facts.role}", a SUPERUSER. Row-level security is skipped, ` +
        "and so is every trigger-based control: the slug guard, the closed-period guard and the " +
        "append-only ledger guards.",
      remedy:
        "Repoint DATABASE_URL at a non-superuser role without BYPASSRLS. `ordence_app` is the role " +
        "0087 narrows grants for.",
    };
  }

  if (facts.bypassesRls) {
    return {
      level: "bypassed",
      label: "BYPASSED",
      detail:
        `The application connects as "${facts.role}", which has BYPASSRLS. Every FORCE ROW LEVEL ` +
        "SECURITY policy is skipped for it, so tenant isolation rests entirely on every code path " +
        "calling withTenant, with no backstop. Trigger-based guards still apply.",
      remedy:
        "Repoint DATABASE_URL at `ordence_app`. Check grant coverage first: switching to a " +
        "half-privileged role fails mid-transaction, which is worse than failing at boot.",
    };
  }

  return {
    level: "enforced",
    label: "ENFORCED",
    detail:
      `The application connects as "${facts.role}", which does not bypass row-level security. ` +
      "A query that forgets withTenant returns zero rows rather than another tenant's rows.",
    remedy: "",
  };
}

/** True when the posture is anything other than confirmed-enforced. */
export function rlsPostureNeedsAttention(posture: RlsPosture): boolean {
  return posture.level !== "enforced";
}
