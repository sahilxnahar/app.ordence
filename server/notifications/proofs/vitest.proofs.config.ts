/**
 * Ordence — vitest configuration for Track G's proof files.
 *
 * RUN IT:
 *
 *     npx vitest run --config server/notifications/proofs/vitest.proofs.config.ts
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * The root `vitest.config.ts` collects `tests/security/**` and `tests/ui/**`
 * and nothing else, and `tests/**` is not in Track G's ownership block —
 * integration refuses a zip that writes outside the block, so a proof cannot
 * be delivered as a test file. This config points vitest at proof files that
 * live inside the block instead.
 *
 * ⭐ IT REUSES `tests/setup.ts` RATHER THAN REBUILDING IT, and that is the
 * important line below. That file carries the six production-safety checks
 * that refuse to run against anything but a throwaway database, and the
 * WebSocket bridge that lets the Neon driver — the one `withTenant()` uses —
 * talk to a local Postgres. A proof that stood up its own connection would be
 * proving something the application does not do, on a path with none of those
 * guards.
 *
 * ⚠️ THIS IS A DELIVERY VEHICLE, NOT A SECOND TEST SUITE. `PATCH-REQUEST-G.md`
 * names the `tests/` path each proof belongs at and the assertion it makes;
 * once integration moves them, this file and the `proofs/` directories should
 * be deleted in the same commit. Two places that collect tests is exactly the
 * split-brain this codebase keeps paying for.
 */

import { defineConfig } from "vitest/config";
import path from "node:path";

const root = path.resolve(__dirname, "../../..");

const alias = {
  "@": root,
  /**
   * ⚠️ Same aliasing, and the same reason, as the root config: the
   * `server-only` package's default export is a bare `throw`, which Next.js
   * never reaches because the react-server condition resolves it to an empty
   * file. Plain Node has no such condition, so without this every server
   * module aborts on its first line.
   */
  "server-only": path.resolve(root, "./node_modules/server-only/empty.js"),
};

export default defineConfig({
  root,
  resolve: { alias },
  test: {
    name: "track-g-proofs",
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["server/notifications/proofs/**/*.proof.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * ⚠️ ONE PROCESS, ONE FILE AT A TIME — copied from the security project
     * and for its reason: these proofs hold real transactions against a
     * shared pool, and two of them overlapping would fail for reasons neither
     * one contains.
     */
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
