#!/usr/bin/env node
/**
 * Ordence — ⭐ GATE 13: NO LINK IN THE PRODUCT POINTS AT A 404
 * Added v1.37.0-alpha (Mega-wave 1, Batch 35)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS GATE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * Twelve links in this product led to a page that does not exist. Not
 * links to unfinished features behind a flag — ordinary buttons and row
 * links on live screens that a customer would click in their first hour:
 * "New lead", the unit code in the inventory grid, the order number in
 * the orders list, every Restore link in the recycle bin.
 *
 * ⚠️ NONE OF THE ELEVEN EXISTING GATES COULD SEE THEM. `check:reachability`
 * asks whether a server action has a caller. Nothing asked the mirror
 * question: whether a caller has a destination. `tsc` cannot help, because
 * `href="/sales/leads/new"` is a valid string.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY IT SHIPS WITH A REGISTRY INSTEAD OF A CLEAN PASS
 * ══════════════════════════════════════════════════════════════════════
 * A gate introduced red is a gate somebody deletes. A gate introduced
 * with an empty allowlist and a promise is a gate that never lands.
 *
 * So it ships the way `check:rls-writes` shipped: with the exact current
 * damage written down as a number that may only go DOWN. Every entry
 * below is a real 404 and a real piece of Batch 35. The gate fails if a
 * NEW one appears, and fails if this list is longer than KNOWN_DEAD_MAX.
 *
 * 🔴 THE LIST IS THE BACKLOG. When it reaches zero, delete the mechanism.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const ROOT = process.cwd();

/**
 * ⚠️ THIS NUMBER MAY ONLY DECREASE.
 *
 * Raising it to make a build pass converts the gate into a formality.
 * If a change genuinely needs a new destination, build the destination.
 */
/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WAVE 10 — THIS IS NOW ZERO. THE BACKLOG IS PAID OFF.
 * ══════════════════════════════════════════════════════════════════════
 * It was 8. The header above says: "THE LIST IS THE BACKLOG. When it
 * reaches zero, delete the mechanism." It has reached zero, and the
 * allowance is what is deleted , not the check.
 *
 * The eight, and what each cost:
 *
 *   /sales/bookings/:id        every row of the bookings list. BUILT, and
 *   /sales/bookings/new        it made 21 orphaned server actions
 *                              reachable , the whole demand, receipt and
 *                              payment-plan lifecycle.
 *   /sales/inventory/:id       every unit code in the grid. BUILT, with
 *                              hold, release, block and correct.
 *   /sales/inventory/new       REMOVED, not built: the create form was
 *                              already on the list page and a second
 *                              surface for the same eleven fields is the
 *                              duplication this codebase has paid for
 *                              before.
 *   /settings/recovery/:id/:id every Restore link. Its own entry said
 *                              "Soft delete works; undelete does not."
 *                              BUILT.
 *   /land/:id                  every parcel. BUILT, including the title
 *                              chain audit, which had no screen that
 *                              could ask it a question.
 *   /leads/:id                 every enquiry reference. REPOINTED: the
 *                              lead screen has always been at
 *                              `/sales/leads/:id`.
 *   /companies/:id             the statement's breadcrumb. REPOINTED to
 *                              the edit screen, which is the only screen
 *                              about a company there is.
 *
 * ⚠️ AT ZERO, ANY DEAD LINK FAILS THE BUILD. That is the whole point of
 * the number reaching zero, and it is why the entry list below is empty
 * rather than the file being deleted: a gate that only refuses NEW dead
 * links is exactly what is wanted once the old ones are gone.
 */
const KNOWN_DEAD_MAX = 0;

/**
 * ⭐ EMPTY SINCE WAVE 10. Every entry that was here has been built,
 * removed or repointed , see the note on `KNOWN_DEAD_MAX`. An entry
 * added here from now on is a deliberate, reviewable decision to ship a
 * 404, and it has to raise the budget above zero to do it.
 */
const KNOWN_DEAD = new Map([]);

/* ------------------------------------------------------------------ */
/* THE ROUTE TABLE                                                     */
/* ------------------------------------------------------------------ */

const SKIP = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * ⚠️ ROUTE GROUPS ARE STRIPPED. `app/(crm)/orders/page.tsx` serves
 * `/orders`, not `/(crm)/orders`. A checker that kept the group would
 * report every link in the product as dead, which is the failure mode
 * that makes people delete link checkers.
 */
const routes = [];
for (const f of walk(join(ROOT, "app"))) {
  const base = f.split("/").pop();
  if (base !== "page.tsx" && base !== "route.ts") continue;
  const r = relative(join(ROOT, "app"), dirname(f))
    .replace(/\\/g, "/")
    .replace(/\/?\([^)]+\)/g, "");
  routes.push("/" + r.replace(/^\/+/, ""));
}

const routeMatchers = routes.map((r) => {
  const clean = r.replace(/\/+$/, "") || "/";
  if (!clean.includes("[")) return { literal: clean };

  /**
   * ⚠️ SUBSTITUTE VIA TOKENS, NEVER STRAIGHT TO REGEX SOURCE.
   *
   * The first version replaced each bracket form with its regex directly,
   * in sequence. The third replacement then matched the `[^/]` inside the
   * output of the first and rewrote it, producing `(?:/[^/]++)*` and a
   * "Nothing to repeat" crash.
   *
   * ⭐ A checker whose own escaping is fragile is a checker nobody trusts
   * the output of. Tokens are placed first, then expanded once, so no
   * replacement can ever see another's output.
   */
  const TOKENS = {
    OPTIONAL_CATCHALL: "(?:/[^/]+)*",
    CATCHALL: ".+",
    PARAM: "[^/]+",
  };

  const tokenised = clean
    /**
     * The optional catch-all eats its own slash, and getting this wrong
     * reported `/sign-in` as a 404. `[[...sign-in]]` serves BOTH
     * `/sign-in` and `/sign-in/factor-one`; leaving the preceding slash
     * mandatory breaks the bare form, which is the link on the landing
     * page.
     */
    .replace(/\/\[\[[^\]]+\]\]/g, "\u0001OPTIONAL_CATCHALL\u0001")
    .replace(/\[\.\.\.[^\]]+\]/g, "\u0001CATCHALL\u0001")
    .replace(/\[[^\]]+\]/g, "\u0001PARAM\u0001");

  const source = tokenised.replace(
    /\u0001(\w+)\u0001/g,
    (_, name) => TOKENS[name],
  );

  return { re: new RegExp("^" + source + "$") };
});

function resolves(path) {
  const clean = (path.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/");
  for (const m of routeMatchers) {
    if (m.literal !== undefined && m.literal === clean) return true;
    if (m.re && m.re.test(clean)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* THE LINKS                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A TEMPLATE LITERAL BECOMES A SHAPE, NOT A GUESS.
 * `` href={`/orders/${o.id}`} `` is normalised to `/orders/:id` and
 * matched against `/orders/[id]`. Substituting a placeholder string
 * instead would make `/orders/X` fail to match `[id]` for the wrong
 * reason and hide the real answer.
 */
const found = new Map();

for (const f of walk(ROOT)) {
  if (!/\.(tsx|ts)$/.test(f)) continue;
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  if (rel.startsWith("tests/") || rel.startsWith("scripts/")) continue;
  const body = readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  const record = (raw) => {
    const shape = raw.replace(/\$\{[^}]*\}/g, ":id");
    if (shape.startsWith("/api/")) return;
    if (!found.has(shape)) found.set(shape, new Set());
    found.get(shape).add(rel);
  };

  for (const m of body.matchAll(/href=["'](\/[^"'\s]*)["']/g)) record(m[1]);
  for (const m of body.matchAll(/href=\{`(\/[^`]*)`\}/g)) record(m[1]);
  for (const m of body.matchAll(
    /(?:router\.(?:push|replace)|redirect)\(\s*["'](\/[^"'\s]*)["']/g,
  )) record(m[1]);
  for (const m of body.matchAll(
    /(?:router\.(?:push|replace)|redirect)\(\s*`(\/[^`]*)`/g,
  )) record(m[1]);
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

const dead = [];
for (const [shape, sources] of found) {
  if (resolves(shape)) continue;
  dead.push({ shape, sources: [...sources].sort() });
}

const unexpected = dead.filter((d) => !KNOWN_DEAD.has(d.shape));
const fixed = [...KNOWN_DEAD.keys()].filter(
  (k) => !dead.some((d) => d.shape === k),
);

if (unexpected.length > 0) {
  console.error("\n🔴 check:links FAILED — a NEW dead link\n");
  for (const d of unexpected) {
    console.error(`  ${d.shape}`);
    console.error(`    linked from: ${d.sources.join(", ")}`);
    console.error(
      `    No route in app/ resolves this. A customer clicking it gets a 404.\n`,
    );
  }
  console.error(
    "Build the destination, or remove the link. Do not add it to\n" +
      "KNOWN_DEAD: that list is a record of existing damage being paid\n" +
      "down, not a place to put new damage.\n",
  );
  process.exit(1);
}

if (dead.length > KNOWN_DEAD_MAX) {
  console.error(
    `\n🔴 check:links FAILED — ${dead.length} dead links, budget is ${KNOWN_DEAD_MAX}.\n`,
  );
  process.exit(1);
}

console.log("✅ check:links");
console.log(`   ${found.size} internal link shapes, ${routes.length} routes.`);
console.log(
  `   ${dead.length} known dead (budget ${KNOWN_DEAD_MAX}), 0 new.`,
);
if (fixed.length > 0) {
  console.log(`   ⭐ ${fixed.length} fixed since the registry was written:`);
  for (const k of fixed) console.log(`      ${k}`);
  console.log(
    `   Lower KNOWN_DEAD_MAX to ${dead.length} and delete the fixed entries.`,
  );
}
for (const d of dead) {
  console.log(`   · ${d.shape} — ${KNOWN_DEAD.get(d.shape)}`);
}
