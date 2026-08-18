/**
 * Ordence — Deploy history: THE HONESTY IS THE FEATURE
 *
 * ⚠️ These assert what the view REFUSES to claim. There is no deployments
 * table; a test that pinned a row count or an exact version string would
 * pass while the view quietly started inventing dates.
 */

import { describe, it, expect } from "vitest";
import {
  parseChangelogReleases,
  parseMigrationRange,
  runningDeployRow,
  shortCommit,
  DEPLOY_OUTCOME_LABELS,
} from "@/lib/platform/deploy-history";

const SAMPLE = [
  "# v1.55.0-alpha — EVERY LINK IN THE STAFF CONSOLE",
  "",
  "**Repo: `app.ordence`** · 🔴 **SQL: unchanged (`0086`–`0090`)** · ⚠️ **No new variables**",
  "",
  "- something happened",
  "",
  "# v1.48.0-alpha — THE REPAIR WAVE",
  "",
  "**Repo: `app.ordence`** · 🔴 **SQL: `0083`, `0084`, `0085` — all three run BEFORE the code push**",
  "",
  "# v0.9.0-alpha — NO META LINE AT ALL",
  "",
  "- nothing else",
].join("\n");

describe("what a release note can and cannot tell us", () => {
  const rows = parseChangelogReleases(SAMPLE);

  it("finds one row per release heading and nothing else", () => {
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.version.startsWith("v"))).toBe(true);
  });

  it("NEVER invents a deploy date or an outcome for a release note", () => {
    for (const row of rows) {
      expect(row.deployedAt, row.version).toBeNull();
      expect(row.commit, row.version).toBeNull();
      expect(row.outcome, row.version).toBe("unknown");
      expect(row.source, row.version).toBe("recorded");
    }
  });

  it("keeps 'unchanged' attached to the range, so it cannot be misread as 'applied'", () => {
    const unchanged = parseMigrationRange("**SQL: unchanged (`0086`–`0090`)** · x");
    expect(unchanged).toMatch(/unchanged/i);
    expect(unchanged).toContain("0086");

    const applied = parseMigrationRange("**SQL: `0083`, `0084`, `0085` — before the push**");
    expect(applied).not.toMatch(/unchanged/i);
    expect(applied).toContain("0083");
    expect(applied).toContain("0085");
  });

  it("states an absence rather than guessing when a release wrote no meta line", () => {
    const noMeta = rows.find((r) => r.version.startsWith("v0.9"));
    expect(noMeta?.migrationRange).toMatch(/none stated/i);
  });
});

describe("the one row this system actually observes", () => {
  it("is the only row marked observed, and is the only one with a time", () => {
    const running = runningDeployRow({
      version: "v1.57.0-alpha",
      commit: "abc123def456789",
      environment: "production",
      startedAt: "2026-08-18T10:00:00.000Z",
      lowestMigrationFile: "0001",
      highestMigrationFile: "0090",
      migrationFileCount: 90,
    });
    expect(running.source).toBe("observed");
    expect(running.outcome).toBe("running");
    expect(running.deployedAt).toBeTruthy();
    // ⚠️ It must not claim the migrations are APPLIED — only present.
    expect(running.migrationRange).toMatch(/present in build/i);
    expect(running.migrationRange).not.toMatch(/\bapplied\b/i);
  });

  it("admits an unset commit instead of printing a placeholder that looks like one", () => {
    const running = runningDeployRow({
      version: "v1.57.0-alpha",
      commit: null,
      environment: null,
      startedAt: "2026-08-18T10:00:00.000Z",
      lowestMigrationFile: null,
      highestMigrationFile: null,
      migrationFileCount: null,
    });
    expect(running.commit).toBeNull();
    expect(shortCommit(running.commit)).toMatch(/not injected/i);
    expect(running.migrationRange).toMatch(/unreadable/i);
  });

  it("labels every outcome with a word, never a colour alone", () => {
    for (const label of Object.values(DEPLOY_OUTCOME_LABELS)) {
      expect(label).toMatch(/[A-Z]{3,}/);
    }
  });
});
