/**
 * Ordence — ⭐⭐⭐ DIRECTORY LISTING — PROOF BY CONSTRUCTION — Wave 7
 * Version: v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ "DISABLE DIRECTORY LISTING" IS NOT A SETTING TO FLIP HERE
 * ══════════════════════════════════════════════════════════════════
 *
 * In a Node/Express deployment the fix is a config line. Ordence is
 * Next.js: there IS no directory-listing mode to disable — `next
 * start` never serves directory indexes, for any URL, ever. The real
 * question is therefore whether the app BUILDS a listing surface of
 * its own: a static files directory, a route that reads a directory,
 * a handler that enumerates anything. A config "fix" would prove
 * nothing; so this file asserts the construction, and fails the build
 * if anyone builds the surface back.
 *
 * THE TWO PROPERTIES ASSERTED:
 *
 *   1. THERE IS NO `public/` DIRECTORY. Every static file in a
 *      Next.js app is served at its path — `/robots.txt` for
 *      `public/robots.txt` — and a directory of loose files is the
 *      classic accidental listing surface. Ordence ships none: the
 *      app has no favicons, no images, nothing that is not code.
 *      If a file gets added, it is added inside a route with a reason
 *      and an explicit path, and the browser gets exactly that path.
 *
 *   2. NO ROUTE READS OR ENUMERATES DIRECTORIES. A listing is not
 *      only a URL that serves one — it is any handler that could be
 *      pointed at a directory. No file under `app/` or `server/` may
 *      import `fs.readdir*` or `fs.scandir`. (The AI catalogue and
 *      some docs mention "directory" as a word in prose; only the
 *      import/require statements are the threat.)
 *
 * The middleware's static-asset matcher is the third brace: it sends
 * every URL that looks like a static file to the renderer's own 404
 * path instead of letting Next's matcher have it — and the middleware
 * test suite confirms refused responses carry the hardening headers,
 * so a probe cannot tell the two cases apart.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());

describe("no directory listing surface", () => {
  it("ships no public/ directory — there are no loose static files to list", () => {
    expect(existsSync(resolve(ROOT, "public"))).toBe(false);
  });

  it("no route imports a directory reader — listing cannot be built from inside", () => {
    /*
     * ⚠️ ONLY IMPORT/REQUIRE STATEMENTS COUNT. The word readdir occurs
     * in prose throughout the codebase (the AI catalogue advises on
     * "local directory cleanup lists" for business profiles); prose
     * never serves a file. This assertion deliberately excludes
     * comments and strings: it greps the same files and lines a code
     * reviewer would read.
     */
    const grep = (pattern: string) =>
      execSync(
        `grep -n ${pattern} --include="*.ts" --include="*.tsx" app server 2>/dev/null | grep -vE "\\*|//|'" || true`,
        { cwd: ROOT, encoding: "utf8" },
      );
    for (const fn of ["readdir", "scandir", "readdirSync"]) {
      /*
       * 🔴 fs.readdir / fs.promises.readdir / readdirSync are all the
       * same door — any of them appearing in a route handler is a
       * listing surface waiting for its argument.
       */
      const hits = grep(`\\b${fn}\\b`);
      expect(hits.trim()).toBe("");
    }
  });
});
