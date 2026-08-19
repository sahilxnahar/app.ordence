/**
 * Ordence — Deploy History: WHAT WE CAN HONESTLY SAY
 * Version: v1.58.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO DEPLOYMENTS TABLE, AND THIS FILE DOES NOT PRETEND.
 * ══════════════════════════════════════════════════════════════════════
 * Nothing in this system observes a deploy. Railway does the deploying
 * and tells the process exactly two things about it — the commit SHA and
 * the environment name — and only about the deploy that is running RIGHT
 * NOW. The repository knows more, but it knows it as documentation:
 * `package.json` carries a version, `CHANGELOG.md` carries a release per
 * heading, `SQL-FILES/` carries migration numbers.
 *
 * ⭐ SO THE VIEW IS TWO KINDS OF ROW AND SAYS WHICH IS WHICH:
 *
 *   OBSERVED   exactly one row — the running process. Commit, environment
 *              and version are facts read from this process.
 *   RECORDED   one row per CHANGELOG heading. A release note is evidence
 *              that a version was PREPARED. It is NOT evidence that it
 *              deployed, when it deployed, or that it succeeded.
 *
 * ⚠️ `outcome` IS THEREFORE "unknown" ON EVERY RECORDED ROW, and it stays
 * unknown. Filling it with "succeeded" because the next version exists
 * would be inventing the history this file refuses to invent — and a
 * fabricated green column is worse than an empty one, because somebody
 * will make a rollback decision from it.
 *
 * ⚠️ MIGRATION RANGES ARE PARSED FROM PROSE and are a CLAIM by whoever
 * wrote the release note, not a reading of the database. What is actually
 * applied lives in the database, and `SQL-FILES/WHICH-MIGRATIONS-ARE-
 * APPLIED-neon-safe.sql` is the thing that answers it. This batch may not
 * run SQL, so it links the question rather than answering it.
 */

export type DeploySourceKind = "observed" | "recorded";

export type DeployRow = {
  id: string;
  /** e.g. `v1.55.0-alpha`. Always known — it is the heading or the package. */
  version: string;
  /** Full SHA when Railway injected one, else null. NEVER a guess. */
  commit: string | null;
  /** `"production"`, `"staging"`… or null when the variable is unset. */
  environment: string | null;
  /**
   * ISO. Only the observed row has one, and even that is PROCESS START,
   * not deploy time — the closest honest proxy this process holds.
   */
  deployedAt: string | null;
  /** e.g. `0086–0090`, or `none stated`. Prose, faithfully echoed. */
  migrationRange: string;
  outcome: DeployOutcome;
  source: DeploySourceKind;
  title: string;
};

/**
 * ⚠️ A WORD, ALWAYS. One in twelve Indian men is colour-blind, so
 * "unknown" is never conveyed by a grey dot alone.
 */
export type DeployOutcome = "running" | "unknown";

export const DEPLOY_OUTCOME_LABELS: Readonly<Record<DeployOutcome, string>> =
  Object.freeze({
    running: "RUNNING — this process",
    unknown: "UNKNOWN — not observed",
  });

export const DEPLOY_SOURCE_LABELS: Readonly<Record<DeploySourceKind, string>> =
  Object.freeze({
    observed: "Observed (live process)",
    recorded: "Recorded (release note)",
  });

/** A `# v1.55.0-alpha — TITLE` heading. */
const HEADING = /^#\s+(v[0-9][^\s—-]*)\s*[—-]*\s*(.*)$/;

/**
 * Pull the migration numbers out of a release note's meta line.
 *
 * ⚠️ RETURNS WHAT THE PROSE SAID, INCLUDING "unchanged". Normalising
 * "unchanged (`0086`–`0090`)" into "0086–0090" would turn "this release
 * ran no migrations" into "this release ran five", which is the exact
 * misreading somebody makes at 3am while deciding whether a rollback is
 * safe.
 */
export function parseMigrationRange(metaLine: string | null): string {
  if (!metaLine) return "none stated";
  const sqlPart = metaLine.match(/SQL:\s*([^·]*)/i)?.[1] ?? "";
  if (!sqlPart.trim()) return "none stated";

  const unchanged = /unchanged|none new|no new/i.test(sqlPart);
  const numbers = [...sqlPart.matchAll(/\b(\d{4})\b/g)].map((m) => m[1]).sort();

  if (numbers.length === 0) return unchanged ? "unchanged (none stated)" : "none stated";

  const first = numbers[0] ?? "";
  const last = numbers[numbers.length - 1] ?? first;
  const span = first === last ? first : `${first}–${last}`;
  return unchanged ? `unchanged (${span})` : span;
}

/**
 * Turn `CHANGELOG.md` into rows. Pure: give it the text, get the rows.
 *
 * ⚠️ NO DATES. The changelog carries none, and deriving one from file
 * mtime or from "the batch numbers look sequential" is invention. The
 * column stays empty and the screen says why.
 */
export function parseChangelogReleases(markdown: string): DeployRow[] {
  const lines = markdown.split(/\r?\n/);
  const rows: DeployRow[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = HEADING.exec(line);
    const version = match?.[1];
    if (!match || !version) continue;

    // The meta line is the next non-empty line when it is the bold
    // "Repo: … SQL: …" strip. Anything else means this release did not
    // write one, which is itself worth showing as "none stated".
    let meta: string | null = null;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      const candidate = lines[j] ?? "";
      if (!candidate.trim()) continue;
      if (/SQL:/i.test(candidate)) meta = candidate;
      break;
    }

    rows.push({
      id: `changelog:${version}:${rows.length}`,
      version,
      commit: null,
      environment: null,
      deployedAt: null,
      migrationRange: parseMigrationRange(meta),
      outcome: "unknown",
      source: "recorded",
      title: (match[2] ?? "").trim(),
    });
  }

  return rows;
}

/** The facts a running process actually holds about itself. */
export type RunningDeployFacts = {
  version: string;
  commit: string | null;
  environment: string | null;
  startedAt: string;
  /** Highest migration file present in the build, or null if unreadable. */
  highestMigrationFile: string | null;
  lowestMigrationFile: string | null;
  migrationFileCount: number | null;
};

export function runningDeployRow(facts: RunningDeployFacts): DeployRow {
  const range =
    facts.lowestMigrationFile && facts.highestMigrationFile
      ? facts.lowestMigrationFile === facts.highestMigrationFile
        ? `${facts.lowestMigrationFile} (present in build)`
        : `${facts.lowestMigrationFile}–${facts.highestMigrationFile} (present in build)`
      : "unreadable in this build";

  return {
    id: "running",
    version: facts.version,
    commit: facts.commit,
    environment: facts.environment,
    deployedAt: facts.startedAt,
    // ⚠️ "present in build" ≠ "applied". Said in the cell, not only in
    // the page's footnote, because a table cell gets screenshotted and
    // pasted into a chat without its footnote.
    migrationRange: range,
    outcome: "running",
    source: "observed",
    title: "The process answering this request",
  };
}

/** Short SHA for display. ⚠️ Null stays null — never "unknown" as a value. */
export function shortCommit(commit: string | null): string {
  if (!commit) return "not injected";
  return commit.slice(0, 12);
}
