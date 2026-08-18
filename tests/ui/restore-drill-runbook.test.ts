/**
 * ⭐ THE MOST VALUABLE TEST IN THIS BATCH.
 *
 * It does not check that the runbook is well written. It checks that the
 * runbook has not been quietly promoted from a hypothesis to a fact.
 *
 * 🔴 THE FAILURE IT GUARDS AGAINST
 * A disaster-recovery document that reads as though the drill has been
 * run, when it has not, is the same defect this project shipped twice
 * already — a verify file that printed "policies OK" over a real
 * cross-tenant leak, a migration that reported success while applying
 * half-way — with a much larger blast radius. Somebody edits a sentence,
 * an "UNTESTED" disappears, and six months later a number nobody
 * measured is being quoted to an enterprise customer.
 *
 * ⚠️ EVERY ASSERTION HERE IS A PROPERTY, NOT A SHAPE. Nothing pins an
 * exact sentence, a heading position or a literal count of rows. Rewrite
 * the prose freely; the invariants are: the results table is empty, a
 * TESTED tag must name a drill that exists, and an untested claim carries
 * the word UNTESTED.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const RUNBOOK = read("docs/current/RESTORE-DRILL.md");
const HARNESS = read("scripts/verify-restore.mjs");

/** A markdown table row split into its cells, trimmed, pipes removed. */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * The results table is located by its header cells, never by line number
 * or heading text — so reordering the document does not break the test
 * and, more importantly, cannot hide the table from it.
 */
function resultsRows(): string[][] {
  const lines = RUNBOOK.split("\n");
  const headerIdx = lines.findIndex((l) => {
    if (!l.includes("|")) return false;
    const c = cellsOf(l).map((x) => x.toLowerCase());
    return (
      c.some((x) => x.startsWith("date")) &&
      c.some((x) => x.includes("wall-clock")) &&
      c.some((x) => x.includes("who ran"))
    );
  });
  expect(
    headerIdx,
    "the runbook must contain a results table with Date / Wall-clock / Who ran it columns",
  ).toBeGreaterThan(-1);

  const rows: string[][] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) break;
    rows.push(cellsOf(line));
  }
  return rows;
}

/** A cell counts as unfilled if it is a placeholder or empty. */
const PLACEHOLDER = /^[`_\s—–-]*$/;

describe("🔴 the runbook never claims the drill has been performed", () => {
  it("says at the top that it is not complete until a human fills it in", () => {
    const head = RUNBOOK.slice(0, 1400);
    expect(head).toMatch(/not complete|NOT COMPLETE/);
    expect(head.toLowerCase()).toContain("results table");
  });

  it("the results table exists and every cell in it is still a placeholder", () => {
    const rows = resultsRows();
    expect(rows.length, "there must be blank rows to fill in").toBeGreaterThan(0);

    const filled = rows.filter((r) => r.some((cell) => !PLACEHOLDER.test(cell)));
    expect(
      filled,
      "a results row carries content — if a drill was really run, this test " +
        "should be updated deliberately, not by editing the document alone",
    ).toEqual([]);
  });

  it("no drill date appears anywhere in the document", () => {
    /**
     * A date is the cheapest way to make a document look like evidence.
     * `YYYY-MM-DD` in a template position (`drill-YYYY-MM-DD`) is fine;
     * a real one is a claim.
     */
    const dates = RUNBOOK.match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? [];
    expect(dates, "a concrete date implies a drill that has not happened").toEqual([]);
  });

  it("contains no past-tense claim that a restore or drill was carried out", () => {
    const claims = [
      /**
       * ⚠️ The lookbehinds matter: this document deliberately states that
       * NO drill has been run, and a regex that cannot tell a denial from
       * a claim would force the honest sentence out of the file.
       */
      /(?<!no )(?<!never )\bdrill (?:was|has been) (?:run|performed|completed)/i,
      /\bwe (?:have )?restored\b/i,
      /\blast drill\s*:/i,
      /\b(?:measured|observed) (?:RTO|RPO) (?:was|of)\b/i,
      /\brestore took\b/i,
    ];
    const guilty = claims.filter((re) => re.test(RUNBOOK)).map(String);
    expect(guilty).toEqual([]);
  });
});

describe("🔴 every untested claim carries the word UNTESTED", () => {
  it("no line is tagged ASSUMED without also being tagged UNTESTED", () => {
    const bare = RUNBOOK.split("\n").filter(
      (l) => /\bASSUMED\b/.test(l) && !/\bUNTESTED\b/.test(l),
    );
    expect(bare).toEqual([]);
  });

  it("a TESTED tag must name a drill date that exists in the results table", () => {
    /**
     * ⭐ THE COUPLING. This is what makes the tag unfakeable: `TESTED`
     * is only legal in the form `TESTED (drill YYYY-MM-DD)`, and that
     * date has to appear in a filled results row. While the table is
     * empty, no TESTED tag can be legal — which is exactly the state the
     * project is in.
     *
     * ⚠️ The lookbehind excludes UNTESTED, which contains TESTED.
     */
    const tags = RUNBOOK.match(/(?<![A-Z])TESTED\b[^\n`]*/g) ?? [];

    /** A bare `TESTED` is not a legal tag: the drill it names is the point. */
    expect(tags.filter((t) => !/^TESTED\s*\(/.test(t))).toEqual([]);

    /** The legend's own `TESTED (drill YYYY-MM-DD)` template is not a claim. */
    const claimTags = tags.filter(
      (t) => /^TESTED\s*\(drill\s+\S/.test(t) && !t.includes("YYYY-MM-DD"),
    );
    const rowText = resultsRows()
      .map((r) => r.join(" "))
      .join("\n");

    for (const tag of claimTags) {
      const date = tag.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
      expect(date, `TESTED tag without a drill date: ${tag}`).toBeTruthy();
      expect(rowText, `TESTED tag names a drill absent from the results table: ${tag}`).toContain(
        date as string,
      );
    }
  });

  it("the RPO and RTO targets are present and their measured column is blank", () => {
    const lines = RUNBOOK.split("\n").filter((l) => l.includes("|"));
    const rpo = lines.find((l) => /\bRPO\b/.test(l) && /\|/.test(l));
    const rto = lines.find((l) => /\bRTO\b/.test(l) && /\|/.test(l));
    expect(rpo, "the runbook must state an RPO target").toBeTruthy();
    expect(rto, "the runbook must state an RTO target").toBeTruthy();
    /** At least one cell in each row is still a placeholder: the measurement. */
    for (const row of [rpo, rto]) {
      const blanks = cellsOf(row as string).filter((c) => /^`?_{2,}`?$/.test(c));
      expect(blanks.length, `no blank measured cell in: ${row}`).toBeGreaterThan(0);
    }
  });
});

describe("⚠️ the runbook names what a restore does not restore", () => {
  it("covers the identity directory, object storage, secrets and the vault key", () => {
    /** Properties, not phrasing: each subject must be discussed somewhere. */
    expect(RUNBOOK).toMatch(/Clerk/);
    expect(RUNBOOK).toMatch(/\bR2\b/);
    expect(RUNBOOK).toMatch(/Railway/);
    expect(RUNBOOK).toMatch(/VAULT_ENCRYPTION_KEY/);
    expect(RUNBOOK.toLowerCase()).toContain("ciphertext");
  });

  it("answers the ransomware question with an explicit verdict", () => {
    /**
     * The question may be reworded; the verdict may change when the
     * mechanism changes. What may never happen is the verdict quietly
     * becoming "holds" without evidence, so a positive verdict is only
     * legal alongside a drill row or an UNTESTED qualifier.
     */
    const verdict = RUNBOOK.split("\n").find((l) => /^\*\*Verdict[:.]/.test(l.trim()));
    expect(verdict, "the immutability section must end in a verdict line").toBeTruthy();
    const v = verdict as string;
    const negative = /DOES NOT HOLD/i.test(v);
    if (!negative) {
      expect(
        /UNTESTED/.test(v) || resultsRows().some((r) => !PLACEHOLDER.test(r[0] ?? "")),
        "a claim that the ransomware property holds needs a drill behind it",
      ).toBe(true);
    }
  });
});

describe("🔴 the harness refuses rather than passing vacuously", () => {
  it("exits non-zero without the acknowledgement flag, and explains itself", () => {
    const r = spawnSync(process.execPath, ["scripts/verify-restore.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, RESTORE_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/x" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/REFUS/i);
    /** The refusal must say WHY, not print a usage line. */
    expect((r.stderr ?? "").length).toBeGreaterThan(200);
  });

  it("exits non-zero when the database cannot be reached", () => {
    /**
     * ⚠️ "could not check" and "checked, fine" must never share an exit
     * code. Port 1 refuses instantly, so this costs nothing.
     */
    const r = spawnSync(
      process.execPath,
      ["scripts/verify-restore.mjs", "--i-know-this-is-a-restore"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          RESTORE_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nothing_here",
          PRODUCTION_DATABASE_URL: "",
        },
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toMatch(/COHERENT/);
  });

  it("treats zero tables as fatal in source, not as an empty loop", () => {
    /**
     * A behavioural test would need a live empty database. The property
     * asserted instead is structural and still real: the emptiness branch
     * exists, is checked before the per-table work, and terminates the
     * process rather than appending to a findings list.
     */
    const emptyCheck = HARNESS.indexOf("tables === 0");
    expect(emptyCheck, "the harness must test for zero tables explicitly").toBeGreaterThan(-1);
    const firstTableLoop = HARNESS.indexOf("for (const t of COUNTED)");
    expect(emptyCheck).toBeLessThan(firstTableLoop);
    const branch = HARNESS.slice(emptyCheck, emptyCheck + 400);
    expect(branch).toMatch(/fatal\(/);
  });

  it("guards the target against being production by host, not by string equality", () => {
    expect(HARNESS).toContain("PRODUCTION_DATABASE_URL");
    expect(HARNESS).toMatch(/hostOf\(PROD\)\s*===\s*hostOf\(TARGET\)/);
  });

  it("never reports success from a catch block", () => {
    /** The shape that turns a broken verifier green: catch → warn → exit 0. */
    const catchBlock = HARNESS.slice(HARNESS.indexOf("} catch (err)"));
    expect(catchBlock).toMatch(/fatal\(/);
    expect(catchBlock).not.toMatch(/process\.exit\(0\)/);
  });
});
