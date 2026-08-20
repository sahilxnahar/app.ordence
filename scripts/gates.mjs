/**
 * Ordence — ⭐⭐⭐ THE GATE MANIFEST
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS: THREE LISTS THAT DRIFTED
 * ══════════════════════════════════════════════════════════════════════
 * Twenty-three gates were written across eleven waves. Each one was
 * written the day a specific bug was found, and each has since refused
 * that bug's return , which is the whole reason they are worth having.
 *
 * They were listed in THREE places, all maintained by hand:
 *
 *     package.json                  23 `check:*` scripts
 *     scripts/preflight.mjs          8 of them
 *     .github/workflows/…            5 of them
 *
 * So fourteen gates ran only when somebody remembered to type the
 * command. Among them: `check:tenant-isolation`, `check:action-reach`,
 * `check:security-events` and `check:permission-reach` , the four that
 * found, respectively, cross-tenant query shapes, 192 unreachable
 * features, ten security alarms that had never fired, and eleven
 * permissions the role screen promised and the product did not keep.
 *
 * ⚠️ A GATE THAT IS NOT IN CI IS A GATE THAT STOPS BEING RUN. Not
 * immediately , gradually, and then all at once on the day somebody is
 * in a hurry. The drift is not anybody's fault; it is what three
 * hand-maintained lists do.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO THERE IS ONE LIST, AND A GATE THAT CHECKS THE LIST
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/preflight.mjs` reads this. `.github/workflows/security-ci.yml`
 * reads this. `scripts/check-gate-coverage.mjs` (gate 24) fails the build
 * if a `check:*` script exists in `package.json` and is not here, or is
 * here and not run by CI.
 *
 * Adding a gate is now: write the script, add the npm script, add one
 * entry below. Forgetting the last step fails the build in the same
 * commit rather than in an audit two quarters later.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TIERS ARE ABOUT WHAT A GATE NEEDS, NOT HOW IMPORTANT IT IS
 * ══════════════════════════════════════════════════════════════════════
 *   static   reads the tree. Needs nothing. Runs everywhere, always,
 *            in under a second. Seventeen of them.
 *   database needs a real PostgreSQL. Runs in CI against the service
 *            container and locally only with `--full`.
 *   slow     minutes rather than seconds (tsc, the build, the suites).
 *
 * 🔴 A `database` GATE THAT CANNOT REACH A DATABASE MUST SAY SO AND
 * FAIL, NOT SKIP. `check:sql-executes` skips without
 * `HARNESS_DATABASE_URL` and its own comment names the risk: "a gate
 * that skips can quietly stop running". The manifest records which gates
 * can skip so the preflight summary can count them separately , a run
 * with four skips is not a green run.
 */

/**
 * @typedef {Object} Gate
 * @property {string} id          the npm script name, without `check:`
 * @property {string} script      the file it runs
 * @property {string[]} [args]    extra argv, when the script has modes
 * @property {"static"|"database"|"slow"} tier
 * @property {string} why         what it catches, in one sentence
 * @property {number} [wave]      the wave that introduced it
 * @property {boolean} [canSkip]  true when it degrades to a skip rather than a failure
 */

/** @type {readonly Gate[]} */
export const GATES = Object.freeze([
  /* ---- static: the tree, read ------------------------------------- */
  {
    id: "boundaries",
    script: "scripts/check-server-boundaries.mjs",
    tier: "static",
    why: "a client component importing a server module, or a stripped server-only guard",
  },
  {
    id: "guards",
    script: "scripts/check-action-guards.mjs",
    tier: "static",
    why: "a server action that does not ask who is calling it, or a write behind an identity check only",
  },
  {
    id: "track-ownership",
    script: "scripts/check-track-ownership.mjs",
    args: ["--tree"],
    tier: "static",
    wave: 14,
    why: "two parallel tracks claiming one path, or a migration landing in another track's number block",
  },
  {
    id: "fail-open",
    script: "scripts/check-fail-open.mjs",
    tier: "static",
    wave: 14,
    why: "a catch block that records a failure as a success, undeclared",
  },
  {
    id: "import-contract",
    script: "scripts/check-import-contract.mjs",
    tier: "static",
    wave: 15,
    why: "an entity whose undo would delete records that pre-date the migration, or a load order with no solution",
  },
  {
    id: "writer-registry",
    script: "scripts/check-writer-registry.mjs",
    tier: "static",
    wave: 15,
    why: "an entity registered with no writer, reaching the customer's picker and writing nothing",
  },
  {
    id: "import-profiles",
    script: "scripts/check-import-profiles.mjs",
    tier: "static",
    wave: 15,
    why: "a source profile the reader can produce and the import_runs CHECK constraint refuses, which reads a file, writes forty thousand rows and then fails at the run record",
  },
  {
    id: "migrations",
    script: "scripts/check-migrations.mjs",
    tier: "static",
    why: "duplicate or out-of-sequence SQL files",
  },
  {
    id: "sql",
    script: "scripts/check-sql-completeness.mjs",
    tier: "static",
    why: "a tenant table with no RLS anywhere in SQL, or a table drizzle-kit push would drop",
  },
  {
    id: "rls-writes",
    script: "scripts/check-rls-writes.mjs",
    tier: "static",
    why: "a write on the unscoped client, which RLS cannot protect",
  },
  {
    id: "sql-rls-writes",
    script: "scripts/check-sql-rls-writes.mjs",
    tier: "static",
    why: "raw SQL that writes a tenant table without a scope",
  },
  {
    id: "tenant-isolation",
    script: "scripts/check-tenant-isolation.mjs",
    tier: "static",
    why: "a query shape that can cross a tenant boundary",
  },
  {
    id: "posting",
    script: "scripts/check-posting-coverage.mjs",
    tier: "static",
    why: "a money movement with no posting rule behind it",
  },
  {
    id: "tax-decisions",
    script: "scripts/check-tax-decisions.mjs",
    tier: "static",
    why: "a tax decision taken in code with no statutory reference recorded",
  },
  {
    id: "reachability",
    script: "scripts/check-reachability.mjs",
    tier: "static",
    why: "a table with a schema and a migration that no query reads",
  },
  {
    id: "action-reach",
    script: "scripts/check-action-reachability.mjs",
    tier: "static",
    wave: 1,
    why: "a server action , a public URL , that no screen calls",
  },
  {
    id: "route-exports",
    script: "scripts/check-route-exports.mjs",
    tier: "static",
    why: "a route file exporting something Next.js will not accept",
  },
  {
    id: "client-hooks",
    script: "scripts/check-client-hooks.mjs",
    tier: "static",
    why: "a server module calling a client hook",
  },
  {
    id: "links",
    script: "scripts/check-links.mjs",
    tier: "static",
    why: "a link to a route that does not exist. Budget is zero since wave 10.",
  },
  {
    id: "console-links",
    script: "scripts/check-console-links.mjs",
    tier: "static",
    why: "a platform console screen unreachable from the console navigation",
  },
  {
    id: "env-catalogue",
    script: "scripts/check-env-catalogue.mjs",
    tier: "static",
    why: "a setting the code reads that is on no paste sheet, so a deploy is missing it",
  },
  {
    id: "data-classification",
    script: "scripts/check-data-classification.mjs",
    tier: "static",
    wave: 0,
    why: "a table carrying personal data that the DPDPA inventory does not know about",
  },
  {
    id: "export-registry",
    script: "scripts/check-export-registry.mjs",
    tier: "static",
    wave: 5,
    why: "an export format declared in five places that disagree",
  },
  {
    id: "import-sources",
    script: "scripts/check-import-sources.mjs",
    tier: "static",
    wave: 6,
    why: "an import format declared in five places that disagree",
  },
  {
    id: "security-events",
    script: "scripts/check-security-events.mjs",
    tier: "static",
    wave: 9,
    why: "a declared security event type that nothing emits , an alarm that reads as silent",
  },
  {
    id: "permission-reach",
    script: "scripts/check-permission-reach.mjs",
    tier: "static",
    wave: 9,
    why: "a permission granted to some roles and withheld from others that no code consults",
  },
  {
    id: "gate-coverage",
    script: "scripts/check-gate-coverage.mjs",
    tier: "static",
    wave: 12,
    why: "a gate that exists and is not in this manifest, or is here and not run by CI",
  },
  {
    id: "unresolved-imports",
    script: "scripts/check-unresolved-imports.mjs",
    tier: "static",
    wave: 13,
    why: "an `@/` import pointing at a file that is not there, which `next build` finds only after a failed deploy",
  },
  {
    id: "sealed-grants",
    script: "scripts/check-sealed-grants.mjs",
    tier: "static",
    wave: 12,
    why: "a later migration granting a privilege an earlier one refused in a comment, which is how ordence_app got EXECUTE on prune_security_events",
  },

  /* ---- database: needs a real PostgreSQL ---------------------------- */
  {
    id: "sql-executes",
    script: "scripts/check-sql-executes.mjs",
    tier: "database",
    canSkip: true,
    why: "a migration that parses and fails at execution, one statement per connection, the way the console sends it",
  },
  {
    id: "rls",
    script: "scripts/check-rls-coverage.mjs",
    tier: "database",
    /**
     * ⚠️ `canSkip` IS ABSENT HERE ON PURPOSE, AND IT USED TO SAY `true`.
     * This gate does NOT skip: `check-rls-coverage.mjs` exits 1 without a
     * database URL, deliberately, because row-level security is the only
     * tenant isolation in this product and "I could not check" is not an
     * acceptable answer about it. The manifest claiming otherwise was a
     * third description of behaviour that lived in a fourth place.
     */
    why: "a tenant table whose RLS policy is absent from the live database rather than from the SQL",
  },
]);

/** Gates in a tier, in manifest order. */
export function gatesInTier(tier) {
  return GATES.filter((g) => g.tier === tier);
}

/** Every gate id, for the coverage check. */
export function gateIds() {
  return GATES.map((g) => g.id);
}

/**
 * The npm script name for a gate.
 *
 * ⚠️ ONE FUNCTION RATHER THAN STRING CONCATENATION AT EACH CALL SITE.
 * The prefix is a convention and conventions get typed differently.
 */
export function npmScript(gate) {
  return `check:${gate.id}`;
}
