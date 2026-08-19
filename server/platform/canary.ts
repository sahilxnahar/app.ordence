import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE CANARY: A SYNTHETIC CROSS-TENANT READ, ON A SCHEDULE
 * Version: v1.45.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Every other isolation control in this repository is a control somebody
 * has to keep caring about. `scripts/check-rls-writes.mjs` runs when a
 * developer runs the gates. `SQL-FILES/VERIFY-0079-neon-safe.sql` runs
 * when somebody remembers to paste it into a SQL console.
 * `tests/security/**` runs against a throwaway Postgres that is not the
 * database holding customers' money.
 *
 * ⭐ NONE OF THEM RUN AGAINST PRODUCTION, EVERY HOUR, FOREVER. This one
 * does. It is the only isolation control that keeps working after
 * everybody has stopped paying attention — which is the condition under
 * which isolation actually has to hold.
 *
 * It does exactly one thing: it opens a tenant scope for a workspace
 * that DOES NOT EXIST, and from inside that scope it tries to read rows
 * that belong to a workspace that DOES. Any row it gets back is a
 * cross-tenant read that happened in production, on real customer data,
 * and it is a P0.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE SINGLE MOST IMPORTANT THING IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * A probe that runs as a role which BYPASSES ROW-LEVEL SECURITY REPORTS
 * SUCCESS FOR THE WRONG REASON, AND GIVES FALSE ASSURANCE FOREVER.
 *
 * Read that again, because it is not obvious in the direction you expect.
 * The intuition is "a bypassing role would see the other tenant's rows,
 * so the probe would go red, so we would find out". That intuition is
 * exactly backwards about which failure matters. Consider the two cases:
 *
 *   ① The connection bypasses RLS AND the policies are perfect.
 *      The cross-tenant read RETURNS ROWS. The probe goes red. Somebody
 *      investigates, discovers the role is wrong, and fixes it. Noisy,
 *      but self-correcting.
 *
 *   ② The connection bypasses RLS AND somebody "fixes" the noise.
 *      This is the case that kills you. The obvious way to quieten ①
 *      is to narrow what the probe reads until it stops returning rows —
 *      an extra `WHERE`, a table that happens to be empty, a
 *      `withPlatformScope` wrapper "so the probe can see the data it
 *      needs". Now the probe is GREEN, on a connection where RLS is not
 *      in effect at all, and it will stay green through every future
 *      policy regression, because policies are not what is being tested.
 *      The green tick is then evidence of nothing, and it is *believed*,
 *      which is worse than having no probe.
 *
 * ⚠️ `neondb_owner` HAS BYPASSRLS. `ordence_app` DOES NOT. Every deploy
 * document in this repository says `DATABASE_URL` must name
 * `ordence_app`, and `scripts/check-rls-writes.mjs` recorded, by
 * executing, that the application cannot currently run as that role. So
 * case ① and case ② are not hypothetical here — the deployment as it
 * stands is precisely the connection this probe must refuse to bless.
 *
 * ⭐ SO THE PROBE CHECKS ITS OWN PRIVILEGES FIRST, AND IF IT CAN BYPASS
 * RLS IT REFUSES TO REPORT A PASS AT ALL. Not a pass with a warning; not
 * a pass with a footnote. `INCONCLUSIVE`, which the scheduled endpoint
 * reports as a NON-2xx, so it is as loud as a failure. The only two
 * things this probe is allowed to say are "I proved isolation held" and
 * "I could not prove anything" — and it is only allowed to say the first
 * one from a connection where the proof is possible.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THERE ARE THREE WAYS TO BYPASS RLS, NOT ONE, AND THE THIRD IS THE
 *    ONE THAT GETS MISSED
 * ══════════════════════════════════════════════════════════════════════
 *   1. `rolsuper`      — a superuser is exempt from everything.
 *   2. `rolbypassrls`  — the explicit attribute. `neondb_owner` has it.
 *   3. TABLE OWNERSHIP. 🔴 **The owner of a table is exempt from that
 *      table's policies unless the table also has FORCE ROW LEVEL
 *      SECURITY.** A role with neither `rolsuper` nor `rolbypassrls`
 *      still sees every row of a table it owns when only
 *      `ENABLE ROW LEVEL SECURITY` was applied.
 *
 * A privilege check that looked only at `pg_roles` would clear a
 * connection that is exempt by ownership, and this probe would then
 * report a pass earned by the exemption rather than by the policy. So
 * the per-table facts are read from `pg_class` too, and a target that is
 * owned by us without FORCE is INCONCLUSIVE for that table — never a
 * pass.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THE OTHER HALF: PROVING THE PROBE COULD HAVE FAILED
 * ══════════════════════════════════════════════════════════════════════
 * "I read zero rows" is worthless on its own. A typo in a table name, a
 * `WHERE` that matches nothing, a target table that is simply empty in
 * this database, a tenant id that belongs to no workspace — every one of
 * those returns zero rows and would be reported as isolation holding.
 * That is the same defect `scripts/check-rls-writes.mjs` refuses to
 * commit: it pairs every refusal with the positive case that must still
 * work, "because a test that only shows things being refused cannot tell
 * correctly locked down from broken".
 *
 * So each target carries TWO controls before its assertion counts:
 *
 *   WITNESS — under `withPlatformScope`, a REAL tenant that really has
 *             rows in this table is chosen. If no workspace has any rows
 *             here, there is nothing to fail to see, and the target is
 *             INCONCLUSIVE rather than a pass.
 *
 *   CONTROL — under `withTenant(victim)`, that tenant's own rows must be
 *             VISIBLE. If they are not, the scope mechanism is not
 *             pointing at anything, so a zero from the cross-tenant read
 *             proves nothing about isolation. INCONCLUSIVE again.
 *
 * Only with both controls green does the cross-tenant zero mean what it
 * looks like it means.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS PROBE NEVER WRITES ANYTHING. NOT ONE ROW.
 * ══════════════════════════════════════════════════════════════════════
 * Every statement below is a `SELECT count(*)`. It writes no tenant
 * data, no platform data, and no record of itself — the durable record
 * is the scheduled endpoint's non-2xx and its log line, which is a
 * channel that does not depend on the database this probe is
 * interrogating.
 *
 * A canary that wrote a "canary ran" row would need INSERT permission on
 * something, would need that INSERT to work under the very role whose
 * privileges are in question, and would give an attacker who found this
 * endpoint an unauthenticated write primitive. None of that buys
 * anything the HTTP status does not already give.
 *
 * ⚠️ The transaction is NOT marked `SET TRANSACTION READ ONLY`, and not
 * for want of trying: `withTenant()` issues `SELECT set_config(...)` as
 * the transaction's first statement, and Postgres refuses to change the
 * access mode after the first statement has run (25001). Read-only is
 * therefore enforced by construction instead — the only SQL in this file
 * is counting, and the table names are a module constant that no request
 * can influence.
 */

import { sql } from "drizzle-orm";
import { withPlatformScope, withTenant } from "@/db";

/* ------------------------------------------------------------------ */
/* THE SYNTHETIC TENANT                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE WORKSPACE THAT DOES NOT EXIST.
 *
 * A fixed, obviously-fake UUID — `...0ca9a9` reads as "canary" — rather
 * than a random one, so that if it ever shows up in `pg_stat_activity`,
 * a slow-query log or a support ticket, it is instantly recognisable as
 * this probe and not as a customer.
 *
 * ⚠️ IT MUST SATISFY `withTenant()`'s UUID SHAPE CHECK, which insists on
 * a version nibble in 1-8 and a variant nibble in 8-b. A "creative"
 * placeholder like `deadbeef-...` is rejected before it reaches the
 * database, and the probe would fail with a malformed-tenant error that
 * looks like an outage.
 *
 * 🔴 AND IT IS VERIFIED NOT TO EXIST ON EVERY RUN. If a real workspace
 * were ever created with this id, the probe would be reading that
 * workspace's own rows and calling them a cross-tenant leak — a false
 * P0, at 3am, repeatedly. A canary that cries wolf gets muted, and a
 * muted canary is worse than no canary, so the collision check is a
 * refusal (INCONCLUSIVE) rather than a warning.
 */
export const CANARY_SYNTHETIC_TENANT_ID = "00000000-0000-4000-8000-0000000ca9a9";

/**
 * ⚠️ HOW MANY ROWS ANY COUNT IS ALLOWED TO TOUCH.
 *
 * Every question this probe asks is "is that zero or not zero?" — never
 * "how many?". Counting all of a leaked table would be a full scan of
 * the largest table in the product, on an hourly schedule, to compute a
 * number nobody reads. The counts are therefore taken over a bounded
 * subquery, and a reported `1000` means "at least 1000", which is
 * already several orders of magnitude past "this is a P0".
 */
const PROBE_ROW_CAP = 1000;

/**
 * ⚠️ AND HOW FAR THE VICTIM SEARCH IS ALLOWED TO SCAN.
 *
 * Picking "the tenant with the most rows" over a whole table is a sort
 * of the whole table. Picking one over the first few thousand rows finds
 * a real tenant with real rows just as well, and costs an index-free
 * scan of a bounded prefix.
 */
const VICTIM_SCAN_CAP = 5000;

/* ------------------------------------------------------------------ */
/* THE TARGETS                                                         */
/* ------------------------------------------------------------------ */

export interface CanaryTarget {
  /** PHYSICAL table name. Spliced as an identifier, never as text. */
  readonly table: string;
  /** Plain English, for the incident channel. Not decoration. */
  readonly whatALeakMeans: string;
}

/**
 * ⭐ FIVE TABLES, CHOSEN FOR WHAT A LEAK IN THEM WOULD ACTUALLY COST.
 *
 * Not "a representative sample" — the four kinds of harm a multi-tenant
 * ERP can do to a customer, plus the one table whose leak is also an
 * evidentiary problem:
 *
 *   users          — the identity boundary itself
 *   contacts       — the customer's customers, i.e. their commercial list
 *   sales_invoices — money, amounts and counterparties
 *   documents      — files, which is where the contracts and PII sit
 *   audit_logs     — the record of who did what, and therefore the thing
 *                    a regulator asks for
 *
 * 🔴 THIS LIST IS A CONSTANT AND NOTHING MAY ADD TO IT AT RUNTIME. It is
 * spliced into SQL as an IDENTIFIER via `sql.identifier`, so a name that
 * arrived from a request would be an injection surface in the one file
 * in this repository that must not have one. No function here takes a
 * table name as a parameter, and that is deliberate rather than
 * incidental.
 */
export const CANARY_TARGETS: readonly CanaryTarget[] = [
  {
    table: "users",
    whatALeakMeans:
      "One workspace can enumerate another workspace's people. Every other boundary in the product is downstream of this one.",
  },
  {
    table: "contacts",
    whatALeakMeans:
      "One workspace can read another workspace's customer list — the single most directly saleable thing in an ERP.",
  },
  {
    table: "sales_invoices",
    whatALeakMeans:
      "One workspace can read another workspace's revenue, counterparties and prices.",
  },
  {
    table: "documents",
    whatALeakMeans:
      "One workspace can enumerate another workspace's files, which is where contracts and identity documents live.",
  },
  {
    table: "audit_logs",
    whatALeakMeans:
      "One workspace can read another workspace's audit trail. A leak here is also an evidentiary failure, because the record a regulator asks for is the record that leaked.",
  },
];

/* ------------------------------------------------------------------ */
/* RESULT SHAPES                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THREE VERDICTS, AND THE THIRD IS NOT A SHADE OF THE FIRST.
 *
 *   "pass"          — a cross-tenant read was genuinely attempted, on a
 *                     connection that could not have bypassed RLS,
 *                     against a real tenant that really has rows, and it
 *                     returned nothing.
 *   "breach"        — it returned something. P0.
 *   "inconclusive"  — the probe could not put itself in a position to
 *                     prove either. NOT a pass. Reported as a non-2xx.
 */
export type CanaryVerdict = "pass" | "breach" | "inconclusive";

/** What the connection running the probe is allowed to do to RLS. */
export interface CanaryConnectionFacts {
  /** The role RLS actually evaluates against. */
  readonly currentUser: string;
  /**
   * The role that logged in. Differs from `currentUser` after `SET ROLE`,
   * and is reported so an operator can see WHY the effective role is what
   * it is rather than only that it is wrong.
   */
  readonly sessionUser: string;
  readonly isSuperuser: boolean;
  readonly hasBypassRls: boolean;
  /** `rolsuper || rolbypassrls`. The thing every decision below reads. */
  readonly bypassesRls: boolean;
}

export interface CanaryTargetResult {
  readonly table: string;
  readonly verdict: CanaryVerdict;
  /** The REAL tenant whose rows the probe tried to steal. */
  readonly victimTenantId: string | null;
  /** Rows that tenant really has, seen under platform scope. The witness. */
  readonly witnessRows: number;
  /** Rows visible under `withTenant(victim)`. The positive control. */
  readonly controlRows: number;
  /** Rows visible under `withTenant(synthetic)` WHERE tenant_id = victim. */
  readonly crossTenantRowsTargeted: number;
  /** Rows visible under `withTenant(synthetic)` with no WHERE at all. */
  readonly crossTenantRowsAny: number;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  /** True when the probe's own role owns the table (see bypass vector 3). */
  readonly ownedByProbeRole: boolean;
  readonly note: string;
}

export interface CanaryResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tookMs: number;
  readonly verdict: CanaryVerdict;
  readonly headline: string;
  readonly syntheticTenantId: string;
  readonly connection: CanaryConnectionFacts | null;
  readonly targets: readonly CanaryTargetResult[];
  /** Targets that could not prove anything. Coverage, reported honestly. */
  readonly inconclusiveTargets: number;
  /** Targets that reached a real, earned pass. */
  readonly provenTargets: number;
}

/**
 * 🔴 THE EXACT WORDS, HOISTED TO A CONSTANT.
 *
 * They are a constant rather than an inline string because they are the
 * one sentence in this system that must never be softened into something
 * an operator can read as "fine". A future edit that wants to make the
 * dashboard less red has to delete this, by name, on purpose.
 */
export const CANARY_BYPASS_REFUSAL =
  "INCONCLUSIVE: this connection bypasses RLS, so this probe proves nothing";

/* ------------------------------------------------------------------ */
/* THE PROBE                                                           */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

/** Neon returns `{ rows }` over HTTP and a bare array over the pool. */
function rowsOf(raw: unknown): Row[] {
  if (Array.isArray(raw)) return raw as Row[];
  const maybe = (raw as { rows?: unknown[] } | null)?.rows;
  return (Array.isArray(maybe) ? maybe : []) as Row[];
}

function int(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

/**
 * ⭐ THE PROBE. READ-ONLY, AND IT REFUSES MORE OFTEN THAN IT PASSES.
 *
 * ⚠️ FOUR SEPARATE TRANSACTIONS, AND THE SEPARATION IS LOAD-BEARING.
 * The obvious optimisation is to do all of this in one transaction,
 * swapping `set_config` values between phases. That would be a bug with
 * a green tick on it: `app.platform_scope` set in the census phase is
 * TRANSACTION-local, so it would still be `'on'` during the cross-tenant
 * read, every policy's `OR app_platform_scope()` branch would match, the
 * probe would get rows back and declare a P0 that is not one. False P0s
 * are how canaries get muted. Separate `withTenant`/`withPlatformScope`
 * calls mean each phase starts from a clean transaction with exactly the
 * one marker it is entitled to.
 */
export async function runCanaryProbe(): Promise<CanaryResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const finish = (
    verdict: CanaryVerdict,
    headline: string,
    connection: CanaryConnectionFacts | null,
    targets: readonly CanaryTargetResult[],
  ): CanaryResult => {
    const finishedAtMs = Date.now();
    const result: CanaryResult = {
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      tookMs: finishedAtMs - startedAtMs,
      verdict,
      headline,
      syntheticTenantId: CANARY_SYNTHETIC_TENANT_ID,
      connection,
      targets,
      inconclusiveTargets: targets.filter((t) => t.verdict === "inconclusive").length,
      provenTargets: targets.filter((t) => t.verdict === "pass").length,
    };
    LAST_RUN = result;
    return result;
  };

  /* ================================================================
   * PHASE A — WHAT AM I, AND AM I ALLOWED TO PROVE ANYTHING?
   * ================================================================
   * ⚠️ RUN INSIDE `withTenant`, NOT ON THE PLAIN CLIENT. The question is
   * not "what privileges does some connection have" — it is "what
   * privileges does THE CONNECTION THAT WILL RUN THE ASSERTIONS have".
   * Asking on a different code path is how a probe ends up certifying a
   * connection it never used. `pg_roles` carries no RLS of its own, so
   * the tenant marker is irrelevant to the answer and merely proves the
   * answer came from the right place.
   */
  let connection: CanaryConnectionFacts;
  try {
    connection = await withTenant(CANARY_SYNTHETIC_TENANT_ID, async (tx) => {
      const raw = await tx.execute(sql`
        /* ordence:canary role */
        SELECT current_user::text          AS current_user_name,
               session_user::text          AS session_user_name,
               r.rolsuper                  AS rolsuper,
               r.rolbypassrls              AS rolbypassrls
          FROM pg_roles r
         WHERE r.rolname = current_user
      `);
      const row = rowsOf(raw)[0] ?? {};
      const isSuperuser = bool(row.rolsuper);
      const hasBypassRls = bool(row.rolbypassrls);
      return {
        currentUser: String(row.current_user_name ?? "unknown"),
        sessionUser: String(row.session_user_name ?? "unknown"),
        isSuperuser,
        hasBypassRls,
        bypassesRls: isSuperuser || hasBypassRls,
      };
    });
  } catch (err) {
    /**
     * ⚠️ A PROBE THAT CANNOT RUN IS INCONCLUSIVE, NEVER A PASS AND NEVER
     * A BREACH. Calling a connection failure a breach pages somebody for
     * a network blip; calling it a pass is the lie this whole file
     * exists to prevent.
     */
    return finish(
      "inconclusive",
      `INCONCLUSIVE: the canary could not reach the database to check its own privileges (${
        err instanceof Error ? err.message : "unknown error"
      }). Nothing was proved either way.`,
      null,
      [],
    );
  }

  /**
   * 🔴🔴 THE REFUSAL. THE WHOLE FILE IS BUILT AROUND THIS BRANCH.
   *
   * ⚠️ IT RETURNS BEFORE ANY ASSERTION IS EVEN ATTEMPTED, on purpose.
   * Running the cross-tenant reads anyway and reporting them "for
   * information" would put a row count next to the word INCONCLUSIVE,
   * and a zero there is the exact number that talks somebody into
   * treating this as a pass. There is nothing informative to gather from
   * a connection where the mechanism under test is not in effect, so
   * nothing is gathered.
   */
  if (connection.bypassesRls) {
    return finish(
      "inconclusive",
      `${CANARY_BYPASS_REFUSAL}. The connection runs as "${connection.currentUser}"` +
        `${connection.isSuperuser ? " (superuser)" : ""}` +
        `${connection.hasBypassRls ? " (BYPASSRLS)" : ""}` +
        `, which is exempt from every row-level security policy in the database. ` +
        `A cross-tenant read returning zero rows here would say nothing about ` +
        `isolation, so no assertion was made. Point DATABASE_URL at a role ` +
        `without BYPASSRLS (the deploy checklist names ordence_app) and this ` +
        `probe becomes capable of proving something.`,
      connection,
      [],
    );
  }

  /* ================================================================
   * PHASE B — THE CENSUS. Under platform scope, and READ-ONLY.
   * ================================================================
   * Three things, all of which must be true before any assertion counts:
   * the synthetic tenant does not exist; RLS is actually on (and forced,
   * if we own the table); and there is a real workspace with real rows
   * to try to steal.
   */
  type Census = {
    syntheticCollides: boolean;
    facts: Map<string, { rlsEnabled: boolean; rlsForced: boolean; ownedByProbeRole: boolean }>;
    victims: Map<string, { tenantId: string; witnessRows: number }>;
  };

  let census: Census;
  try {
    census = await withPlatformScope(
      "Canary probe: confirm the synthetic tenant is fictional and find a real workspace with real rows to attempt a cross-tenant read against",
      async (tx) => {
        const collisionRaw = await tx.execute(sql`
          /* ordence:canary synthetic-collision */
          SELECT count(*)::int AS n
            FROM tenants
           WHERE id = ${CANARY_SYNTHETIC_TENANT_ID}
        `);
        const syntheticCollides = int(rowsOf(collisionRaw)[0]?.n) > 0;

        /**
         * ⭐ BYPASS VECTOR 3, READ FROM THE CATALOGUE.
         *
         * `relrowsecurity` false means the table has no RLS at all — a
         * real finding, and the cross-tenant read below will duly return
         * everything. `relforcerowsecurity` false matters only when WE
         * OWN THE TABLE, because an owner is exempt from its own
         * policies without FORCE; that combination is the quiet one, and
         * it is why `pg_roles` alone is not enough.
         */
        const factsRaw = await tx.execute(sql`
          /* ordence:canary table-facts */
          SELECT c.relname::text                            AS table_name,
                 c.relrowsecurity                           AS rls_enabled,
                 c.relforcerowsecurity                      AS rls_forced,
                 (pg_get_userbyid(c.relowner) = current_user) AS owned_by_probe_role
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relkind = 'r'
             AND c.relname IN (${sql.join(
               CANARY_TARGETS.map((t) => sql`${t.table}`),
               sql`, `,
             )})
        `);

        const facts = new Map<
          string,
          { rlsEnabled: boolean; rlsForced: boolean; ownedByProbeRole: boolean }
        >();
        for (const row of rowsOf(factsRaw)) {
          facts.set(String(row.table_name), {
            rlsEnabled: bool(row.rls_enabled),
            rlsForced: bool(row.rls_forced),
            ownedByProbeRole: bool(row.owned_by_probe_role),
          });
        }

        /**
         * ⭐ THE WITNESS. A REAL TENANT ID, TAKEN FROM REAL DATA.
         *
         * ⚠️ NOT "the first tenant in the tenants table". A workspace
         * that signed up and never used the product has no rows in these
         * tables, and a cross-tenant read that targets it returns zero
         * whether isolation holds or not — a pass earned by an empty
         * table. The victim is therefore drawn FROM THE TARGET TABLE
         * ITSELF, so by construction it has rows there.
         *
         * ⚠️ Bounded to a prefix (`VICTIM_SCAN_CAP`) so this is not a
         * full sort of the largest table in the product every hour. Which
         * tenant it lands on may vary between runs; that is a feature,
         * because over a week the probe has attempted the read against
         * many different real workspaces rather than the same one.
         */
        const victims = new Map<string, { tenantId: string; witnessRows: number }>();
        for (const target of CANARY_TARGETS) {
          if (!facts.has(target.table)) continue;
          const raw = await tx.execute(sql`
            /* ordence:canary victim */
            SELECT s.tenant_id::text AS tenant_id, count(*)::int AS n
              FROM (
                SELECT tenant_id
                  FROM ${sql.identifier(target.table)}
                 WHERE tenant_id IS NOT NULL
                 LIMIT ${VICTIM_SCAN_CAP}
              ) s
             GROUP BY s.tenant_id
             ORDER BY n DESC
             LIMIT 1
          `);
          const row = rowsOf(raw)[0];
          if (!row?.tenant_id) continue;
          victims.set(target.table, {
            tenantId: String(row.tenant_id),
            witnessRows: int(row.n),
          });
        }

        return { syntheticCollides, facts, victims };
      },
    );
  } catch (err) {
    return finish(
      "inconclusive",
      `INCONCLUSIVE: the canary could not take its census (${
        err instanceof Error ? err.message : "unknown error"
      }), so it never established that there was anything to fail to see.`,
      connection,
      [],
    );
  }

  /**
   * 🔴 A COLLISION MAKES EVERY SUBSEQUENT ASSERTION MEANINGLESS.
   *
   * If a real workspace holds the synthetic id, then `withTenant(
   * synthetic)` is a legitimate tenant scope and every row it returns is
   * that workspace's own. The probe would report a P0 that is not one,
   * on a schedule, until somebody muted it.
   */
  if (census.syntheticCollides) {
    return finish(
      "inconclusive",
      `INCONCLUSIVE: a real workspace exists with the canary's synthetic tenant id ` +
        `(${CANARY_SYNTHETIC_TENANT_ID}). Every read below would be that workspace's ` +
        `own data, so the probe refuses to call it a leak. Change ` +
        `CANARY_SYNTHETIC_TENANT_ID, or delete the workspace if it is a test artefact.`,
      connection,
      [],
    );
  }

  /* ================================================================
   * PHASE C — THE POSITIVE CONTROL. One tenant scope per target.
   * ================================================================
   * ⚠️ THIS IS THE HALF THAT PROVES THE PROBE COULD HAVE FAILED. It
   * reads the victim's OWN rows under the victim's OWN scope, which is
   * an ordinary, sanctioned application read. If it comes back zero, the
   * scoping mechanism is not returning data for anybody and the
   * cross-tenant zero in Phase D is a foregone conclusion rather than a
   * result.
   *
   * ⚠️ IT COUNTS. It never selects a column. Nothing this probe learns
   * about a customer beyond "there are rows" can end up in a log line,
   * an HTTP response or an incident channel, because it is never read
   * into memory in the first place.
   */
  const controlRows = new Map<string, number>();
  for (const target of CANARY_TARGETS) {
    const victim = census.victims.get(target.table);
    if (!victim) continue;
    try {
      const n = await withTenant(victim.tenantId, async (tx) => {
        const raw = await tx.execute(sql`
          /* ordence:canary control */
          SELECT count(*)::int AS n
            FROM (
              SELECT 1
                FROM ${sql.identifier(target.table)}
               WHERE tenant_id = ${victim.tenantId}
               LIMIT ${PROBE_ROW_CAP}
            ) s
        `);
        return int(rowsOf(raw)[0]?.n);
      });
      controlRows.set(target.table, n);
    } catch {
      // Leave it unset: an absent control is an INCONCLUSIVE target
      // below, which is exactly what a control that did not run means.
    }
  }

  /* ================================================================
   * PHASE D — 🔴 THE ASSERTION. ONE TRANSACTION, WRONG TENANT ON PURPOSE.
   * ================================================================
   * A single `withTenant(synthetic)` transaction covering every target,
   * so the whole cross-tenant attempt is one clearly-delimited scope in
   * the database's own logs rather than five scattered ones.
   *
   * Two questions per table, and they catch different failures:
   *
   *   TARGETED — `WHERE tenant_id = <a real, live workspace>`. This is
   *              the literal thing an attacker with a tenant id would
   *              try, and it is the assertion the brief asks for.
   *
   *   ANY      — no WHERE at all. Catches the policy that is MISSING
   *              rather than wrong: a table with `USING (true)`, or with
   *              RLS never enabled, returns everything here while a
   *              targeted read against one particular tenant might still
   *              happen to be empty.
   *
   * The synthetic tenant owns nothing — verified in Phase B — so ANY
   * non-zero answer to either question is rows this scope must not have
   * been able to see.
   */
  let crossReads = new Map<string, { targeted: number; any: number }>();
  let crossReadError: string | null = null;
  try {
    crossReads = await withTenant(CANARY_SYNTHETIC_TENANT_ID, async (tx) => {
      const out = new Map<string, { targeted: number; any: number }>();
      for (const target of CANARY_TARGETS) {
        const victim = census.victims.get(target.table);
        if (!victim) continue;
        const raw = await tx.execute(sql`
          /* ordence:canary cross-tenant */
          SELECT
            (SELECT count(*)::int
               FROM (
                 SELECT 1
                   FROM ${sql.identifier(target.table)}
                  WHERE tenant_id = ${victim.tenantId}
                  LIMIT ${PROBE_ROW_CAP}
               ) a) AS targeted,
            (SELECT count(*)::int
               FROM (
                 SELECT 1
                   FROM ${sql.identifier(target.table)}
                  LIMIT ${PROBE_ROW_CAP}
               ) b) AS any_rows
        `);
        const row = rowsOf(raw)[0] ?? {};
        out.set(target.table, { targeted: int(row.targeted), any: int(row.any_rows) });
      }
      return out;
    });
  } catch (err) {
    /**
     * ⚠️ AN ERROR HERE IS NOT A PASS, however tempting the reading is.
     * "The database refused the query" and "the policy correctly
     * returned nothing" are different facts, and only the second one is
     * evidence of isolation.
     */
    crossReadError = err instanceof Error ? err.message : "unknown error";
  }

  /* ================================================================
   * ASSEMBLE
   * ================================================================ */
  const targets: CanaryTargetResult[] = CANARY_TARGETS.map((target) => {
    const facts = census.facts.get(target.table);
    const victim = census.victims.get(target.table);
    const control = controlRows.get(target.table);
    const cross = crossReads.get(target.table);

    const base = {
      table: target.table,
      victimTenantId: victim?.tenantId ?? null,
      witnessRows: victim?.witnessRows ?? 0,
      controlRows: control ?? 0,
      crossTenantRowsTargeted: cross?.targeted ?? 0,
      crossTenantRowsAny: cross?.any ?? 0,
      rlsEnabled: facts?.rlsEnabled ?? false,
      rlsForced: facts?.rlsForced ?? false,
      ownedByProbeRole: facts?.ownedByProbeRole ?? false,
    };

    if (!facts) {
      return {
        ...base,
        verdict: "inconclusive" as const,
        note: `No table named "${target.table}" in the public schema, so nothing was attempted against it. Either a migration has not run or this target is stale.`,
      };
    }

    /**
     * 🔴 BYPASS VECTOR 3, PER TABLE. We hold no BYPASSRLS attribute — the
     * Phase A refusal already covered that — but the OWNER of a table is
     * exempt from its policies unless FORCE ROW LEVEL SECURITY is set.
     * A zero from a table we are exempt on is a zero we did not earn.
     */
    if (facts.ownedByProbeRole && !facts.rlsForced) {
      return {
        ...base,
        verdict: "inconclusive" as const,
        note: `The probe's role owns "${target.table}" and the table has ENABLE but not FORCE ROW LEVEL SECURITY, so the owner is exempt from its own policies. Any zero here would be the exemption, not the policy. Run ALTER TABLE ${target.table} FORCE ROW LEVEL SECURITY.`,
      };
    }

    if (!facts.rlsEnabled) {
      /**
       * ⚠️ A BREACH, NOT AN INCONCLUSIVE. There is no policy to prove or
       * disprove — the table is simply readable across tenants by any
       * scope, which is the outcome the policies exist to prevent. It
       * matters that this reads as the same colour as a leak, because it
       * IS one.
       */
      return {
        ...base,
        verdict: "breach" as const,
        note: `"${target.table}" does not have row-level security enabled at all, so every workspace's rows are readable from every scope. ${target.whatALeakMeans}`,
      };
    }

    if (crossReadError) {
      return {
        ...base,
        verdict: "inconclusive" as const,
        note: `The cross-tenant read could not be executed (${crossReadError}). A query that did not run is not a query that returned nothing.`,
      };
    }

    if (!victim) {
      return {
        ...base,
        verdict: "inconclusive" as const,
        note: `No workspace has any rows in "${target.table}" in this database, so there is nothing to fail to see. A zero here would be an empty table, not isolation.`,
      };
    }

    if (control === undefined || control === 0) {
      /**
       * ⚠️ THE CONTROL FAILING IS ITS OWN ALARM. Either the scoping
       * mechanism is broken (in which case every screen in the product
       * is empty and somebody already knows) or the probe is pointed at
       * the wrong thing. Both mean the assertion below is worthless, and
       * neither is a pass.
       */
      return {
        ...base,
        verdict: "inconclusive" as const,
        note: `The positive control failed: under withTenant(${victim.tenantId}) the probe could not see that tenant's own ${victim.witnessRows} row(s) in "${target.table}". Until a correct scope can read, an incorrect scope reading nothing proves nothing.`,
      };
    }

    if (!cross) {
      return {
        ...base,
        verdict: "inconclusive" as const,
        note: `The cross-tenant read produced no answer for "${target.table}".`,
      };
    }

    if (cross.targeted > 0 || cross.any > 0) {
      /* 🔴🔴 THE ONE THIS FILE EXISTS FOR. */
      return {
        ...base,
        verdict: "breach" as const,
        note:
          `CROSS-TENANT READ SUCCEEDED. Scoped to the synthetic workspace ` +
          `${CANARY_SYNTHETIC_TENANT_ID}, which owns nothing, the probe read ` +
          `${cross.targeted} row(s) belonging to workspace ${victim.tenantId} and ` +
          `${cross.any} row(s) in total from "${target.table}". ${target.whatALeakMeans}`,
      };
    }

    return {
      ...base,
      verdict: "pass" as const,
      note: `Scoped to a workspace that does not exist, the probe read 0 of workspace ${victim.tenantId}'s ${control} visible row(s) in "${target.table}", on a connection that cannot bypass RLS.`,
    };
  });

  const { verdict, headline } = verdictFor(connection, targets);
  return finish(verdict, headline, connection, targets);
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EXPORTED AND PURE, SO IT CAN BE TESTED WITHOUT A DATABASE.
 *
 * The rules, in the order they are applied, and why each is the way
 * round it is:
 *
 *   ① A BYPASSING CONNECTION IS INCONCLUSIVE NO MATTER WHAT THE TARGETS
 *      SAY. This is checked FIRST and it is checked again here even
 *      though `runCanaryProbe` returns early, because this function is
 *      the thing a future caller will reach for and the guarantee has to
 *      live where the decision is made, not where today's caller happens
 *      to stand.
 *
 *   ② ANY BREACH MAKES THE RUN A BREACH. Four green tables do not
 *      average out one that leaked.
 *
 *   ③ NO PROVEN TARGET MEANS INCONCLUSIVE. Green requires that at least
 *      one real cross-tenant read was actually attempted and actually
 *      returned nothing. "Everything was skipped" is not a pass.
 *
 *   ④ ⚠️ OTHERWISE PASS, WITH THE COVERAGE GAP NAMED IN THE HEADLINE.
 *      This is the one judgement call in the file. The strict
 *      alternative — any inconclusive target makes the whole run
 *      inconclusive — was rejected because an empty `documents` table on
 *      a young database would hold the probe permanently red, and a
 *      permanently red check is a check that gets ignored, which is the
 *      failure mode this whole file is trying to avoid. So the run may
 *      be green while its coverage is partial, but the headline says so
 *      in numbers rather than leaving it to be discovered.
 */
export function verdictFor(
  connection: CanaryConnectionFacts | null,
  targets: readonly CanaryTargetResult[],
): { verdict: CanaryVerdict; headline: string } {
  if (!connection) {
    return {
      verdict: "inconclusive",
      headline: "INCONCLUSIVE: the canary never established what connection it was running on.",
    };
  }

  if (connection.bypassesRls) {
    return {
      verdict: "inconclusive",
      headline:
        `${CANARY_BYPASS_REFUSAL}. The connection runs as "${connection.currentUser}", ` +
        `which is exempt from every row-level security policy in the database.`,
    };
  }

  const breaches = targets.filter((t) => t.verdict === "breach");
  if (breaches.length > 0) {
    return {
      verdict: "breach",
      headline:
        `P0: CROSS-TENANT READ SUCCEEDED against ${breaches.length} table(s) — ` +
        `${breaches.map((b) => b.table).join(", ")}. A scope for a workspace that ` +
        `does not exist returned rows belonging to workspaces that do. Treat this ` +
        `as a live data-isolation incident, not a test failure.`,
    };
  }

  const proven = targets.filter((t) => t.verdict === "pass");
  const inconclusive = targets.filter((t) => t.verdict === "inconclusive");

  if (proven.length === 0) {
    return {
      verdict: "inconclusive",
      headline:
        `INCONCLUSIVE: not one of the ${targets.length} target table(s) could be used ` +
        `to attempt a real cross-tenant read, so nothing was proved. ` +
        `${inconclusive.map((t) => `${t.table}: ${t.note}`).join(" ")}`,
    };
  }

  return {
    verdict: "pass",
    headline:
      `Isolation held: ${proven.length} of ${targets.length} table(s) were read ` +
      `under a scope for a workspace that does not exist, against real workspace ` +
      `ids with real rows, and returned nothing — on a connection ` +
      `("${connection.currentUser}") that cannot bypass RLS.` +
      (inconclusive.length > 0
        ? ` ⚠️ ${inconclusive.length} target(s) proved nothing this run: ${inconclusive
            .map((t) => t.table)
            .join(", ")}.`
        : ""),
  };
}

/**
 * ⚠️ 200 IS RESERVED FOR "I PROVED IT".
 *
 * 🔴 INCONCLUSIVE IS A NON-2xx, and that is the single most consequential
 * line in this file after the bypass refusal. Every scheduler in
 * existence — Vercel Cron, Cloudflare's dashboard, an uptime monitor,
 * whatever replaces them — draws a 2xx green and everything else red. If
 * INCONCLUSIVE returned 200, the deployment as it stands today (running
 * as a BYPASSRLS role, per `scripts/check-rls-writes.mjs`) would show a
 * green isolation check forever, on a database where row-level security
 * is not in effect. That is the exact false assurance this file exists
 * to make impossible, and it would arrive through the status code rather
 * than through the words.
 *
 * ⚠️ SO THIS ENDPOINT IS EXPECTED TO BE RED ON FIRST DEPLOY. That is not
 * a bug to be tuned away. It goes green when `DATABASE_URL` names a role
 * without BYPASSRLS, and not before.
 *
 * 503 rather than 500 for INCONCLUSIVE so that a human reading the logs
 * can tell "the probe could not prove anything" from "the probe proved
 * something terrible" without opening the body.
 */
export function httpStatusForVerdict(verdict: CanaryVerdict): number {
  if (verdict === "pass") return 200;
  if (verdict === "breach") return 500;
  return 503;
}

/* ------------------------------------------------------------------ */
/* THE LAST RUN, FOR THE CONSOLE                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ IN-PROCESS AND DELIBERATELY NOT DURABLE.
 *
 * This is a convenience for the platform console panel, not a record.
 * It lives in the module scope of one Node process, so it is empty after
 * every deploy and says nothing about a run that happened on another
 * instance.
 *
 * 🔴 IT IS NOT THE ALERTING, AND THE PANEL SAYS SO. The alerting is the
 * scheduled endpoint's non-2xx, which reaches a scheduler that is not
 * this process and does not restart when this one does. Storing the
 * result in a table instead was considered and rejected for the reason
 * at the top of this file: a probe that writes needs INSERT permission
 * under exactly the role whose privileges are in question, and would
 * report "I could not record my own result" as its most common failure.
 */
let LAST_RUN: CanaryResult | null = null;

export function getLastCanaryRun(): CanaryResult | null {
  return LAST_RUN;
}

/** Tests only. The module-level slot would otherwise leak between cases. */
export function __resetCanaryStateForTests(): void {
  LAST_RUN = null;
}
