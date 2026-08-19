#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ `drizzle-kit`, RUN SO THAT IT ACTUALLY WORKS
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FOUND
 * ══════════════════════════════════════════════════════════════════════
 * `npx drizzle-kit push --force`, against an empty database, in a
 * non-TTY shell:
 *
 *     • prints `TypeError: Do not know how to serialize a BigInt`
 *     • prints `Interactive prompts require a TTY terminal`
 *     • CREATES ZERO TABLES
 *     • EXITS 0
 *
 * That last line is the whole problem. `.github/workflows/security-ci.yml`
 * has a step called "Create the schema" whose body is exactly that
 * command. It reports success and creates nothing.
 *
 * ⚠️ A STEP THAT REPORTS SUCCESS AND DOES NOTHING is the failure mode
 * this codebase has now found in a security hook, a rate limiter, an
 * anomaly detector, ten alarm types, eleven permissions — and here, in
 * the tooling that builds the schema those things are tested against.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THIS WRAPPER DOES
 * ══════════════════════════════════════════════════════════════════════
 *   ① loads `lib/bigint-json.mjs` INTO the drizzle-kit process, so the
 *      BigInt snapshot serialises instead of throwing;
 *   ② passes `--force` through, and refuses to be run without it in a
 *      non-TTY shell, because the interactive prompt cannot be answered
 *      and drizzle-kit's own response to that is to exit 0;
 *   ③ 🔴 EXITS NON-ZERO IF THE OUTPUT CONTAINS AN ERROR, whatever
 *      drizzle-kit's own exit code says. The tool lies about its exit
 *      code; the wrapper does not have to believe it.
 *
 * ⚠️ THIS IS NOT AN ENDORSEMENT OF `push`. `npm run db:push` is still
 * banned in production and still guarded, because push DROPS RLS
 * POLICIES on 300+ tables. This wrapper exists so that the two places
 * push is legitimate — a fresh CI database and a fresh local test
 * database, both with no policies to drop — actually work.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, "lib", "bigint-json.mjs");
const args = process.argv.slice(2);

if (args.includes("push") && !args.includes("--force") && !process.stdout.isTTY) {
  console.error(
    "\n🔴 `push` without `--force` in a non-interactive shell.\n\n" +
      "   drizzle-kit will try to prompt, fail to prompt, and exit 0 having done\n" +
      "   nothing. Add --force, or run it in a terminal.\n",
  );
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ["node_modules/drizzle-kit/bin.cjs", ...args],
  {
    cwd: join(here, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      /**
       * ⚠️ `--import` AND NOT `-r`. The preload is an ES module and
       * `--require` cannot load one. `-r` fails with a message about
       * `require() of an ES Module`, which reads as a bug in the preload
       * rather than in how it was loaded.
       */
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
    },
  },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

/**
 * 🔴 THE OUTPUT IS THE SOURCE OF TRUTH, NOT THE EXIT CODE.
 *
 * These two strings are the two ways drizzle-kit has been observed to
 * fail silently in this repository. Matching on message text is fragile
 * and it is still better than trusting a 0 that is wrong — and when the
 * message changes, this fails loudly on the next CI run rather than
 * quietly forever.
 */
const SILENT_FAILURES = [
  "Do not know how to serialize a BigInt",
  "Interactive prompts require a TTY",
];

const lied = SILENT_FAILURES.filter((needle) => output.includes(needle));

if (result.status !== 0 || lied.length > 0) {
  if (lied.length > 0) {
    console.error(
      `\n🔴 drizzle-kit exited ${result.status} and its output contains:\n` +
        lied.map((l) => `      "${l}"`).join("\n") +
        `\n\n   Treating that as a failure. A schema step that reports success and creates\n` +
        `   nothing is worse than one that fails.\n`,
    );
  }
  process.exit(1);
}
