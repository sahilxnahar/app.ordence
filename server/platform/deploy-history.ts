import "server-only";

/**
 * Ordence — Deploy History: THE READS
 * Version: v1.58.0-alpha
 * Runtime: Node (touches the filesystem)
 *
 * ⚠️ EVERY READ HERE IS BEST-EFFORT AND DEGRADES TO A STATED ABSENCE.
 * `CHANGELOG.md` and `SQL-FILES/` are repository files, and a standalone
 * Next build is under no obligation to ship them. When they are missing
 * the screen must say "this build cannot see them" — not show an empty
 * table that reads as "there were no releases".
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  parseChangelogReleases,
  runningDeployRow,
  type DeployRow,
} from "@/lib/platform/deploy-history";

/**
 * ⚠️ CAPTURED AT MODULE LOAD, WHICH IS PROCESS START. This is the closest
 * honest proxy for "when did this deploy start serving" that the process
 * holds — Railway injects no deploy timestamp. It is labelled as process
 * start on the screen, never as deploy time.
 */
const PROCESS_STARTED_AT = new Date().toISOString();

export type DeployHistory = {
  rows: DeployRow[];
  /** What the screen must admit to. Rendered, not swallowed. */
  gaps: string[];
};

async function readVersion(root: string): Promise<string> {
  try {
    const raw = await readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? `v${parsed.version}` : "unknown";
  } catch {
    // ⚠️ `npm_package_version` is set by npm, not by the runtime, so it is
    // usually absent in production. Tried anyway; admitted when absent.
    const env = process.env.npm_package_version;
    return env ? `v${env}` : "unknown";
  }
}

export async function readDeployHistory(): Promise<DeployHistory> {
  const root = process.cwd();
  const gaps: string[] = [];

  const [version, changelog, migrations] = await Promise.all([
    readVersion(root),
    readFile(path.join(root, "CHANGELOG.md"), "utf8").catch(() => null),
    readdir(path.join(root, "SQL-FILES")).catch(() => null),
  ]);

  const numbered = (migrations ?? [])
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .map((f) => f.slice(0, 4))
    .sort();

  if (!changelog) {
    gaps.push(
      "CHANGELOG.md is not readable from this build, so no earlier releases can be listed at all — only the running process below.",
    );
  }
  if (!migrations) {
    gaps.push(
      "SQL-FILES/ is not readable from this build, so the migration numbers shipped alongside this code cannot be shown.",
    );
  }

  const commit = process.env.RAILWAY_GIT_COMMIT_SHA ?? null;
  if (!commit) {
    gaps.push(
      "RAILWAY_GIT_COMMIT_SHA is not set in this environment, so the running commit is genuinely unknown here — it is not being hidden.",
    );
  }

  const running = runningDeployRow({
    version,
    commit,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
    startedAt: PROCESS_STARTED_AT,
    lowestMigrationFile: numbered[0] ?? null,
    highestMigrationFile: numbered[numbered.length - 1] ?? null,
    migrationFileCount: migrations ? numbered.length : null,
  });

  const recorded = changelog ? parseChangelogReleases(changelog) : [];

  /*
   * ⚠️ THE CHANGELOG'S TOP ENTRY IS NOT NECESSARILY WHAT IS RUNNING.
   * Deploys are what Railway did with a commit; the changelog is what
   * somebody wrote in the repository. They drift, and the drift is the
   * single most useful thing this screen can show — so the running row
   * stays a separate row even when the versions match, rather than being
   * merged into the top release.
   */
  return { rows: [running, ...recorded], gaps };
}
