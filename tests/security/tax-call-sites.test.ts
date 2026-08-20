/**
 * Ordence — THE CALL-SITE REGISTER IS COMPLETE, AND STAYS COMPLETE
 * Version: v1.81.0-alpha · Wave 17 · Track E
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FAILURE THIS FILE EXISTS TO PREVENT
 * ══════════════════════════════════════════════════════════════════════
 * `server/tax/compute.ts` has no callers. A Wiring track is going to add
 * them. The way that hand-off fails is not that the wiring is done badly
 * — it is that it is done to FIVE of the SIX paths, and the sixth keeps
 * computing GST its own way, forever, correctly, until the day the two
 * diverge.
 *
 * ⭐⭐ SO THIS FILE DOES NOT TEST THE REGISTER. IT TESTS THAT THE
 * REGISTER IS STILL TRUE. A list of call sites maintained by hand is a
 * list that is right on the day it is written. Every check below
 * re-derives the same set from a source that is NOT the register and
 * fails when the two disagree:
 *
 *   §1  from `information_schema` — a new tax-bearing TABLE
 *   §2  from the source tree      — a new WRITER of an existing table
 *   §3  back at the tree          — a registered writer that MOVED or was
 *                                   renamed or deleted
 *   §4  against PostgreSQL        — an `assertion` whose SQL is fiction
 *
 * ⚠️ §4 IS NOT PEDANTRY. The register's whole value to the Wiring track
 * is that each entry carries a SQL statement they can run to prove they
 * wired it. A statement that does not parse — a column that does not
 * exist, a foreign key that was assumed rather than read — is worse than
 * no statement, because it will be pasted, it will error, and the person
 * pasting it will conclude the register is unreliable and stop reading.
 * Two of the assertions in the register were wrong on the first draft for
 * exactly that reason: `eway_bill_items` has no `invoice_line_id` (items
 * relate to invoice lines by POSITION), and `purchase_order_lines` has no
 * `line_value_minor` and calls its parent key `po_id`. Both were found by
 * this check, not by reading.
 *
 * ⚠️ THIS FILE DOES NOT ASSERT THAT ANY SITE IS WIRED. Nothing is, yet.
 * It asserts that the map is complete. Asserting the wiring here would
 * make the suite red for work that belongs to another track and has not
 * started, and a permanently-red check is a check people learn to skip.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TAX_CALL_SITES, REGISTERED_TAX_TABLES } from "@/server/tax/call-sites";
import { asSuperuser } from "../setup";

const ROOT = process.cwd();

/* ================================================================== */
/* SOURCE WALK                                                         */
/* ================================================================== */

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "coverage", ".turbo",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * ⚠️ COMMENTS ARE STRIPPED BEFORE ANY SEARCH, AND THIS IS THE FIFTH TIME
 * THIS PROJECT HAS NEEDED THAT. `scripts/check-tax-decisions.mjs` carries
 * the full history: a check searches for the defect it prevents,
 * somebody writes a comment explaining the defect, and the check fires on
 * the comment. Here the shape is worse than a false positive — the
 * register itself and `server/tax/apply.ts` both QUOTE call sites like
 * `insert(salesInvoiceLines)` inside block comments. Without this, the
 * register would appear to be its own writer.
 *
 * Replaced with equal-length whitespace so line numbers stay true.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

/** Files that may mention a write without being one. */
const NOT_A_WRITER = new Set<string>([
  "server/tax/call-sites.ts",
  "server/tax/apply.ts",
  "server/tax/compute.ts",
  "server/tax/audit.ts",
]);

function isProductFile(rel: string): boolean {
  if (NOT_A_WRITER.has(rel)) return false;
  if (rel.startsWith("tests/")) return false;
  if (rel.startsWith("db/schema/")) return false;
  // Seed scripts write fixtures, not documents. Named rather than
  // pattern-matched, so a NEW script under scripts/ is a failure that
  // somebody has to look at.
  if (rel.startsWith("scripts/seed-")) return false;
  return true;
}

const SOURCE_FILES = walk(join(ROOT, "server"))
  .concat(walk(join(ROOT, "lib")))
  .concat(walk(join(ROOT, "app")))
  .concat(walk(join(ROOT, "components")))
  .concat(walk(join(ROOT, "scripts")))
  .map((f) => ({ rel: f.slice(ROOT.length + 1), code: stripComments(readFileSync(f, "utf8")) }))
  .filter((f) => isProductFile(f.rel));

/* ================================================================== */
/* §1 — EVERY TAX-BEARING TABLE IN THE DATABASE IS IN THE REGISTER      */
/* ================================================================== */

describe("§1 the register covers every tax-bearing table the schema has", () => {
  /**
   * ⭐ THE LIST COMES FROM `information_schema`, NOT FROM A CONSTANT.
   * A constant listing the tables would be a second hand-maintained list
   * with the same defect as the first, and the two would agree with each
   * other while both being out of date.
   */
  it("no table carries a CGST/SGST/IGST column without a register entry", async () => {
    const rows = await asSuperuser(async (c) =>
      c.query<{ table_name: string }>(`
        SELECT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public'
           AND t.table_type = 'BASE TABLE'
           AND c.column_name IN ('cgst_minor','igst_minor','reversed_cgst_minor','reversed_igst_minor')
         GROUP BY c.table_name
         ORDER BY c.table_name
      `),
    );

    // `tax_decisions` is Track E's own audit trail and is not a document.
    // `gstr2b_rows` and `gst_returns` ARE in the register, deliberately,
    // so that the answer to "why isn't this wired" is written down.
    const exempt = new Set(["tax_decisions", "gst_rate_pin_status"]);

    const missing = rows.rows
      .map((r) => r.table_name)
      .filter((t) => !exempt.has(t) && !REGISTERED_TAX_TABLES.has(t));

    expect(
      missing,
      `These tables carry a GST split and no entry in server/tax/call-sites.ts:\n` +
        `  ${missing.join("\n  ")}\n` +
        `A new tax-bearing table is a new place GST can be computed a second way. ` +
        `Add an entry — including one whose status is "no-tax-columns" or ` +
        `"third-party-figures" if that is the honest answer — rather than deleting ` +
        `this check.`,
    ).toEqual([]);
  });

  it("every register entry names a table that actually exists", async () => {
    const rows = await asSuperuser(async (c) =>
      c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      ),
    );
    const real = new Set(rows.rows.map((r) => r.table_name));
    const phantom = [...REGISTERED_TAX_TABLES].filter((t) => !real.has(t));

    expect(
      phantom,
      `The register names tables that do not exist: ${phantom.join(", ")}. ` +
        `An entry for a dropped table is a wiring instruction nobody can follow.`,
    ).toEqual([]);
  });
});

/* ================================================================== */
/* §2 — EVERY WRITER IN THE TREE IS IN THE REGISTER                     */
/* ================================================================== */

describe("§2 the register covers every writer of those tables", () => {
  /**
   * ⚠️ MATCHES `.insert(sym)` AND `.update(sym)` ON THE DRIZZLE SYMBOL,
   * which is the only form the codebase uses for these tables. A raw-SQL
   * write would slip past — so §2b looks for that separately rather than
   * pretending one regex covers both.
   */
  it("no file inserts or updates a registered table without a register entry", () => {
    const symbols = new Map<string, string>();
    for (const site of TAX_CALL_SITES) symbols.set(site.drizzleSymbol, site.table);

    const registered = new Set(
      TAX_CALL_SITES.map((s) => `${s.file}::${s.drizzleSymbol}`),
    );

    const found: string[] = [];
    for (const file of SOURCE_FILES) {
      for (const [sym, table] of symbols) {
        const re = new RegExp(`\\.(insert|update)\\(\\s*${sym}\\s*[,)]`);
        if (!re.test(file.code)) continue;
        const key = `${file.rel}::${sym}`;
        if (!registered.has(key)) found.push(`${file.rel} writes ${table} (${sym})`);
      }
    }

    expect(
      found,
      `Undeclared writers of a tax-bearing table:\n  ${found.join("\n  ")}\n` +
        `Every one of these is a place GST can be stored, and therefore a place it ` +
        `can be stored differently from everywhere else. Add it to ` +
        `server/tax/call-sites.ts with an honest status.`,
    ).toEqual([]);
  });

  it("§2b no raw SQL writes a registered table outside SQL-FILES", () => {
    const tables = [...REGISTERED_TAX_TABLES];
    const found: string[] = [];
    for (const file of SOURCE_FILES) {
      for (const table of tables) {
        const re = new RegExp(
          `(INSERT\\s+INTO|UPDATE)\\s+(public\\.)?${table}\\b`,
          "i",
        );
        if (re.test(file.code)) found.push(`${file.rel} raw-writes ${table}`);
      }
    }
    expect(
      found,
      `Raw SQL writes to a tax-bearing table:\n  ${found.join("\n  ")}\n` +
        `A raw write bypasses the Drizzle symbol and therefore bypasses §2. If one ` +
        `is legitimate, register it; do not widen this check.`,
    ).toEqual([]);
  });
});

/* ================================================================== */
/* §3 — EVERY REGISTER ENTRY STILL DESCRIBES REALITY                    */
/* ================================================================== */

describe("§3 the register has not gone stale", () => {
  it("every entry's file exists", () => {
    const missing = TAX_CALL_SITES.filter(
      (s) => !existsSync(join(ROOT, s.file)),
    ).map((s) => `${s.id} → ${s.file}`);
    expect(
      missing,
      `Register entries whose file is gone:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * ⭐ THE ANCHOR, NOT THE LINE NUMBER. A line number goes stale in
   * silence — the entry keeps pointing somewhere, just not where the
   * write is. A literal substring from the call site goes stale loudly,
   * which is the only kind of staleness worth having.
   */
  it("every entry's anchor is still present in its file", () => {
    const drifted: string[] = [];
    for (const site of TAX_CALL_SITES) {
      const path = join(ROOT, site.file);
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf8");
      if (!raw.includes(site.anchor)) {
        drifted.push(`${site.id}: "${site.anchor}" no longer appears in ${site.file}`);
      }
    }
    expect(
      drifted,
      `Register entries that no longer match their file:\n  ${drifted.join("\n  ")}\n` +
        `The code moved and the map did not. Update the anchor in the same commit ` +
        `that moved the code — that is what the anchor is for.`,
    ).toEqual([]);
  });

  it("ids are unique, so a failure message names one thing", () => {
    const ids = TAX_CALL_SITES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every must-wire entry says what to call", () => {
    const silent = TAX_CALL_SITES.filter(
      (s) =>
        (s.status === "must-wire" || s.status === "computes-but-unpinned") &&
        !s.requiredCall,
    ).map((s) => s.id);
    expect(
      silent,
      `These sites are queued for wiring and do not say what to call: ${silent.join(", ")}. ` +
        `"Wire this" is not an instruction.`,
    ).toEqual([]);
  });
});

/* ================================================================== */
/* §4 — EVERY ASSERTION IN THE REGISTER IS REAL SQL                     */
/* ================================================================== */

describe("§4 the proofs the register hands the Wiring track actually run", () => {
  /**
   * ⚠️ THE PLACEHOLDER TEST IS `/<[a-z][a-z ]*>/`, NOT `includes("<")`,
   * AND THE FIRST DRAFT GOT THIS WRONG IN THE DANGEROUS DIRECTION. Half
   * these statements contain `<>` — SQL's not-equals — so a bare
   * `includes("<")` silently excluded eight of the fourteen assertions
   * from ever being executed. The block still passed. That is the
   * `count(*) >= 10 THEN 'PASS'` shape one more time: a check that runs
   * over a filtered-to-nothing set and reports success.
   */
  const executable = TAX_CALL_SITES.filter(
    (s) => s.assertion && !/<[a-z][a-z ]*>/.test(s.assertion.sql),
  );

  it("there is at least one executable assertion, so this block is not vacuous", () => {
    // ⚠️ WITHOUT THIS, A TYPO IN THE FILTER MAKES §4 PASS BY TESTING
    // NOTHING — the `count(*) >= 10 THEN 'PASS'` shape, applied to a
    // test. It has been found 23 times in this codebase.
    expect(executable.length).toBeGreaterThan(10);
  });

  for (const site of executable) {
    it(`${site.id}: its assertion SQL parses and executes`, async () => {
      const sql = site.assertion?.sql ?? "";
      await asSuperuser(async (c) => {
        // ⚠️ EXECUTED, NOT EXPLAINed. `EXPLAIN` would catch a bad column
        // but not a function that does not exist, and half these
        // assertions call gst_apply_rate_bps() from 0147. Running them
        // is cheap: every one is a count over an empty or tiny table.
        await c.query(sql);
      });
    });
  }

  it("every assertion states what the number must be", () => {
    const mute = TAX_CALL_SITES.filter(
      (s) => s.assertion && s.assertion.expect.trim().length === 0,
    ).map((s) => s.id);
    expect(mute, `Assertions with no stated expectation: ${mute.join(", ")}`).toEqual([]);
  });
});

/* ================================================================== */
/* §5 — THE THINGS THAT MUST NOT BE WIRED SAY WHY                       */
/* ================================================================== */

describe("§5 refusals are justified, not merely recorded", () => {
  it("every third-party-figures entry explains why it must not be wired", () => {
    const unexplained = TAX_CALL_SITES.filter(
      (s) => s.status === "third-party-figures" && !s.note && !s.taxSource,
    ).map((s) => s.id);
    expect(
      unexplained,
      `These sites are excluded from wiring with no reason given: ${unexplained.join(", ")}. ` +
        `An unexplained exclusion is indistinguishable from an oversight, which is ` +
        `exactly the confusion this register exists to remove.`,
    ).toEqual([]);
  });

  it("every unreachable entry says so rather than being quietly queued", () => {
    const sites = TAX_CALL_SITES.filter((s) => s.status === "unreachable");
    expect(sites.length).toBeGreaterThan(0);
    for (const s of sites) {
      expect(s.note, `${s.id} is marked unreachable with no explanation`).toBeTruthy();
    }
  });
});
