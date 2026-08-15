#!/usr/bin/env node
/**
 * Ordence — ⭐ GATE 12: NO TAX DECIDED BY STRING COMPARISON
 * Added v1.37.0-alpha (Mega-wave 1, Batch 33)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS GATE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `lib/gst/place-of-supply.ts` is a complete, tested engine implementing
 * s.12(3) immovable property, s.7(5)(b) SEZ, s.10(1)(a) goods movement,
 * s.12(2) services and the UT/UTGST distinction, each with a statutory
 * reference.
 *
 * `server/actions/orders.ts` did not call it. It decided which tax
 * applies with:
 *
 *     const isInterState = data.placeOfSupplyCode !== sellerStateCode
 *
 * That single line ignored every rule in the engine. It is fixed. This
 * gate exists because the fix is one line and the mistake is one line,
 * and the mistake is the SHORTER of the two — a future developer adding
 * an import path, a REST endpoint or a quotation module will reach for
 * the comparison, because comparing two state codes is the obvious thing
 * to do and it is right most of the time.
 *
 * ⚠️ "RIGHT MOST OF THE TIME" IS THE DANGER, NOT THE DEFENCE. For a
 * plain intra-state supply of services to a registered buyer, the string
 * compare and the engine agree. They diverge exactly on the cases that
 * cost money: a works contract, an SEZ buyer, a Union Territory. Those
 * are rare enough to pass a review and common enough to appear in a
 * return.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT CHECKS, AND WHY EACH CHECK IS SHAPED THIS WAY
 * ══════════════════════════════════════════════════════════════════════
 * 1. No file outside the engine ASSIGNS an inter-state-shaped variable
 *    from a comparison of two things. Matching the assignment rather
 *    than the comparison is deliberate: comparing two state codes is
 *    legitimate in a filter, a test or a display; DERIVING THE TAX SPLIT
 *    from it is not.
 *
 * 2. Every file that computes tax imports the engine. A file that splits
 *    CGST/SGST/IGST without importing the determination is by definition
 *    deciding from something else.
 *
 * 3. The engine itself is not exempt from being reachable: it must have
 *    at least one caller outside its own tests. ⭐ This is the check that
 *    would have caught the original defect. The engine was perfect,
 *    tested, and imported by nothing, and every other gate was green.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ENGINE = "lib/gst/place-of-supply.ts";

/* ------------------------------------------------------------------ */
/* FILE WALK                                                           */
/* ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "coverage", ".turbo",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * ⚠️⚠️ THE PROSE TRAP, FIFTH OCCURRENCE, AND THE LAST ONE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * A GATE THAT READS COMMENTS FAILS ON ITS OWN EXPLANATION.
 * ══════════════════════════════════════════════════════════════════════
 * This has now happened five times in this codebase, always the same
 * way: a check searches for the defect it prevents, somebody writes a
 * comment explaining the defect, and the check fires on the comment. The
 * first four times it was fixed locally by matching a narrower slice of
 * the file. That was a fix for the instance, not the class.
 *
 * On this gate it happened twice in one run:
 *
 *   • `lib/inventory/transfer.ts` — a comment quoting the very ternary
 *     the fix had just removed.
 *   • `server/actions/sales-invoices.ts` — a comment EXPLAINING that
 *     calling `determinePlaceOfSupply()` here would be wrong, matched as
 *     though it were a call.
 *
 * The second one is the dangerous shape: it made a correct file look
 * like a caller, which would have hidden a genuinely uncalled engine.
 *
 * ⭐ SO CODE IS SEPARATED FROM PROSE ONCE, HERE, AND EVERY CHECK BELOW
 * READS ONLY CODE. Comments are replaced with equal-length whitespace so
 * that line numbers in every failure message stay true.
 */
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, " ");
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

const files = walk(ROOT).map((f) => {
  const raw = readFileSync(f, "utf8");
  return {
    path: relative(ROOT, f).replace(/\\/g, "/"),
    /** ⚠️ CODE ONLY. Never match against `raw` in a check. */
    body: stripCommentsAndStrings(raw),
    raw,
  };
});

const failures = [];
const notes = [];

/* ================================================================== */
/* ① NO INTER-STATE FLAG DERIVED FROM A COMPARISON                     */
/* ================================================================== */

/**
 * Matches an assignment to something named like the tax split whose
 * right-hand side is a `===` or `!==` comparison.
 *
 * ⚠️ DELIBERATELY DOES NOT MATCH BARE COMPARISONS. `a !== b` appears
 * thousands of times legitimately. What is never legitimate is letting
 * one decide which tax applies, and an assignment is how that happens.
 */
const DERIVED_SPLIT =
  /\b(?:const|let|var)\s+(is[A-Z]\w*(?:InterState|Interstate)|interState\w*|isIgst\w*)\s*(?::[^=]+)?=\s*[^;]*?[!=]==[^;]*?;/gs;

/**
 * ⭐ AND THE TERNARY FORM, which is what the original defect actually
 * looked like. A regex matching only `x = a !== b` would have missed
 * `x = cond ? a !== b : false` — the exact shape that shipped.
 */
const DERIVED_SPLIT_TERNARY =
  /\b(?:const|let|var)\s+(is[A-Z]\w*(?:InterState|Interstate)|interState\w*)\s*(?::[^=]+)?=\s*[^;]*\?[^;]*[!=]==[^;]*:[^;]*;/gs;

const SPLIT_EXEMPT = new Set([
  ENGINE,
  // The engine's own tests must be free to construct the wrong answer in
  // order to assert that the engine rejects it.
  "tests/ui/place-of-supply.test.ts",
  "tests/ui/gst-tax.test.ts",
  "tests/ui/orders-place-of-supply.test.ts",
  // This gate quotes the defect it exists to prevent.
  "scripts/check-tax-decisions.mjs",
]);

for (const f of files) {
  if (SPLIT_EXEMPT.has(f.path)) continue;
  for (const re of [DERIVED_SPLIT, DERIVED_SPLIT_TERNARY]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(f.body)) !== null) {
      const line = f.body.slice(0, m.index).split("\n").length;
      failures.push(
        `${f.path}:${line}\n` +
          `    \`${m[1]}\` is assigned from a comparison.\n` +
          `    Which tax applies is a determination under the IGST Act, not a\n` +
          `    string comparison. Call determinePlaceOfSupply() from\n` +
          `    ${ENGINE} and read .isInterState from its result.\n` +
          `    A comparison cannot express s.12(3) immovable property,\n` +
          `    s.7(5)(b) SEZ, or the UT/UTGST distinction.`,
      );
    }
  }
}

/* ================================================================== */
/* ② FILES THAT SPLIT TAX MUST IMPORT THE ENGINE                       */
/* ================================================================== */

/**
 * ⚠️ THE FIRST VERSION OF THIS CHECK WAS WRONG AND IS WORTH RECORDING.
 *
 * It flagged any file assigning `cgstMinor:`, on the theory that writing
 * a tax amount means deciding a split. That produced five failures and
 * FOUR OF THEM WERE FALSE: `cgstMinor: row.cgstMinor` is reading a
 * column, not choosing an Act. Only `lib/inventory/transfer.ts` was
 * real, and it was already caught by check ① one line earlier.
 *
 * A gate that cries wolf four times out of five gets an exemption list
 * bolted onto it within a month, and the exemption list is where the
 * next real defect hides. So the check is now narrower and asks the
 * question that actually matters:
 *
 *   🔴 DOES ANY CODE CHOOSE BETWEEN IGST AND CGST WITHOUT `taxKindFor`?
 *
 * `taxKindFor(isInterState, placeOfSupply)` is exported from the engine
 * precisely so this choice has one implementation. It is the function
 * that knows a Union Territory takes UTGST rather than SGST — the
 * distinction a hand-written ternary silently drops, which is how every
 * intra-UT supply in this codebase was billed under the wrong Act.
 */
const TAX_KIND_TERNARY =
  /\?\s*["']igst["']\s*:\s*["']cgst_(?:sgst|utgst)["']|\?\s*["']cgst_(?:sgst|utgst)["']\s*:\s*["']igst["']/g;

for (const f of files) {
  if (SPLIT_EXEMPT.has(f.path)) continue;
  if (f.path.startsWith("tests/")) continue;
  TAX_KIND_TERNARY.lastIndex = 0;
  let m;
  while ((m = TAX_KIND_TERNARY.exec(f.body)) !== null) {
    if (f.body.includes("taxKindFor")) continue;
    const line = f.body.slice(0, m.index).split("\n").length;
    failures.push(
      `${f.path}:${line}\n` +
        `    Chooses between IGST and CGST with a ternary.\n` +
        `    A two-way choice cannot express the third answer: an\n` +
        `    intra-state supply in a Union Territory is CGST + UTGST, a\n` +
        `    different Act and a different GSTR-1 box. Use taxKindFor()\n` +
        `    from ${ENGINE}, which returns all three.`,
    );
  }
}

/* ================================================================== */
/* ③ THE ENGINE MUST HAVE A CALLER                                     */
/* ================================================================== */

/**
 * 🔴 THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT.
 *
 * Before v1.37.0 the engine was complete, correct, covered by tests, and
 * imported by no production file. Every other gate was green, because
 * every other gate asks whether the code that exists is well formed. No
 * gate asked whether it is REACHED.
 *
 * `check:reachability` counts orphaned server actions. It does not count
 * orphaned pure functions, because a pure library with no caller is
 * usually just a utility waiting for one. This one was not a utility. It
 * was the tax.
 */
const engineCallers = files.filter(
  (f) =>
    f.path !== ENGINE &&
    !f.path.startsWith("tests/") &&
    !f.path.startsWith("scripts/") &&
    /determinePlaceOfSupply\s*\(/.test(f.body),
);

if (engineCallers.length === 0) {
  failures.push(
    `${ENGINE}\n` +
      `    The place-of-supply engine has NO production caller.\n` +
      `    🔴 This is the exact state the codebase was in before v1.37.0:\n` +
      `    a complete, correct, tested engine that decided nothing, while\n` +
      `    the live path compared two strings. An engine with no caller is\n` +
      `    not a safeguard, it is a document.`,
  );
} else {
  notes.push(
    `place-of-supply engine reached from ${engineCallers.length} production file${
      engineCallers.length === 1 ? "" : "s"
    }: ${engineCallers.map((f) => f.path).join(", ")}`,
  );
}

/* ================================================================== */
/* ④ THE DETERMINATION MUST BE STORED, NOT JUST USED                   */
/* ================================================================== */

/**
 * ⚠️ A determination that is computed and discarded cannot be audited
 * later, and "which rule produced this?" is the first question at an
 * assessment. Every caller that PERSISTS a determination must persist
 * its basis alongside.
 *
 * ⭐ PURE FUNCTIONS ARE EXCLUDED, and the distinction is real rather
 * than convenient. `lib/inventory/transfer.ts` calls the engine and
 * returns a treatment to its caller; it writes nothing, so there is no
 * row on which a basis could be stored. Requiring it to store one would
 * have forced either a fake column or an exemption entry, and exemption
 * entries are where the next real defect hides.
 */
for (const f of engineCallers) {
  const persists = /\.insert\(|\.update\(|\.values\(/.test(f.body);
  if (!persists) continue;
  if (!/placeOfSupplyBasis/.test(f.body)) {
    failures.push(
      `${f.path}\n` +
        `    Calls determinePlaceOfSupply() but never stores\n` +
        `    \`placeOfSupplyBasis\`. The conclusion is kept and the reasoning\n` +
        `    is thrown away, so nobody can answer "which rule produced this"\n` +
        `    at an assessment. The DB CHECK sales_orders_pos_has_basis will\n` +
        `    reject the row anyway; failing here says why.`,
    );
  }
}

/* ================================================================== */
/* REPORT                                                              */
/* ================================================================== */

if (failures.length > 0) {
  console.error("\n🔴 check:tax-decisions FAILED\n");
  for (const f of failures) console.error("  " + f + "\n");
  console.error(
    `${failures.length} problem${failures.length === 1 ? "" : "s"}.\n\n` +
      "Which tax applies is decided by lib/gst/place-of-supply.ts and\n" +
      "nowhere else. The total is identical whichever way it is decided,\n" +
      "so a mistake here is invisible on the document and surfaces at the\n" +
      "buyer's reconciliation months later.\n",
  );
  process.exit(1);
}

console.log("✅ check:tax-decisions");
console.log("   No tax split is derived from a string comparison.");
for (const n of notes) console.log("   " + n);
