import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Ordence — Vitest Configuration
 * Version: v0.64.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO PROJECTS, BECAUSE THE TWO SUITES NEED OPPOSITE THINGS
 * ══════════════════════════════════════════════════════════════════════
 * They are not two flavours of the same thing:
 *
 *   security/  runs in NODE, against a real throwaway Postgres, and its
 *              whole purpose is to prove RLS holds. It must not have a
 *              DOM, and it MUST have the `.env.test` guard.
 *
 *   ui/        runs in JSDOM, renders components, and touches no
 *              database at all. Forcing the database guard on it would
 *              mean a developer cannot run a component test without
 *              standing up Postgres — which is how a suite stops being
 *              run.
 *
 * ⚠️ A SINGLE PROJECT CANNOT DO BOTH, AND TRYING SILENTLY DID NEITHER.
 * Before this file was split, `include` was `tests/** /*.test.ts` — which
 * does NOT match `.test.tsx`. Twenty-three UI suites, roughly six hundred
 * assertions, were present in the repository, imported nothing that
 * failed, and were never once collected. They did not fail; they simply
 * were not there. A green run reported on a suite that was not running.
 *
 * That is the failure mode worth naming here: a test that does not run
 * is more dangerous than a test that fails, because it is indistinguish-
 * able from a test that passes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE SECURITY PROJECT IS SEQUENTIAL
 * ══════════════════════════════════════════════════════════════════════
 *   singleFork: true
 *     RLS depends on a transaction-scoped setting
 *     (`app.current_tenant_id`). Parallel workers sharing a pool could
 *     interleave and produce a result that looks like a leak but is a
 *     test artifact — or, far worse, mask a real one. Sequential
 *     execution makes every failure meaningful.
 *
 *   testTimeout: 30s
 *     These tests create tenants, insert rows and run migrations. Slower
 *     than a unit test, and a timeout here would be a false failure.
 */

const alias = {
  "@": path.resolve(__dirname, "./"),

  /**
   * ⚠️ `server-only` IS A LANDMINE, NOT A LIBRARY.
   *
   * The package's default export is one statement: `throw new Error(...)`.
   * Next.js never hits it because the React Server Components build
   * resolves the `react-server` condition to an empty file; plain Node
   * has no such condition, so `import "server-only"` at the top of
   * `server/audit.ts` aborts the module the instant a test imports it.
   *
   * Pointing it at the package's OWN `empty.js` — the file Next.js uses —
   * is what lets the security suite test server modules directly. Nothing
   * is stubbed out or weakened: the marker has no runtime behaviour to
   * preserve.
   *
   * ⚠️ THIS DOES NOT MAKE IT SAFE TO IMPORT SERVER MODULES FROM CLIENT
   * COMPONENTS. That is enforced by the Next.js build, which does not
   * read this file.
   */
  "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
};

export default defineConfig({
  resolve: { alias },

  /**
   * ⚠️ REQUIRED FOR THE UI PROJECT, AND EASY TO MISS.
   *
   * The components use JSX without importing React, because Next.js
   * compiles with the automatic JSX runtime. Vitest's bare esbuild
   * defaults to the CLASSIC runtime, which emits `React.createElement`
   * into a module that never imported React — and the failure surfaces as
   * `ReferenceError: React is not defined` deep inside react-dom, which
   * reads like a broken component rather than a missing transform.
   */
  plugins: [react()],

  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Root-level: files never run concurrently with one another. The
    // security project needs this; the UI project does not mind it.
    fileParallelism: false,

    reporters: process.env.CI ? ["default", "junit"] : ["verbose"],
    outputFile: { junit: "./test-results/junit.xml" },

    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["server/**", "lib/**", "db/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/node_modules/**"],
    },

    projects: [
      {
        resolve: { alias },
        test: {
          name: "security",
          environment: "node",
          globals: true,
          // ⚠️ The `.env.test` guard. Never remove it — see tests/setup.ts.
          setupFiles: ["./tests/setup.ts"],
          include: ["tests/security/**/*.test.{ts,tsx}"],
          exclude: ["node_modules/**", ".next/**"],
          testTimeout: 30_000,
          hookTimeout: 30_000,

          /**
           * Sequential — see the note at the top of this file. Do not
           * change without reading it.
           *
           * ⚠️ `singleFork` IS THE ONE THAT CARRIES THE GUARANTEE: every
           * file runs in ONE process, one after another, so no two tests
           * can hold overlapping transactions against the shared pool.
           * (`fileParallelism` is set at the root instead — it is not a
           * valid project-level option, and putting it here typechecks
           * as an error while silently doing nothing.)
           */
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        resolve: { alias },
        // ⚠️ DECLARED HERE, NOT ONLY AT THE ROOT. A project does not
        // inherit the root `plugins` array, so a react() at the top level
        // alone leaves this project on the classic JSX runtime and every
        // render fails with `React is not defined`.
        plugins: [react()],
        test: {
          name: "ui",
          environment: "jsdom",
          globals: true,
          /**
           * ⚠️ NOT `tests/setup.ts`. That file's job is to refuse to run
           * against anything but a throwaway database — a guard these
           * tests have no need of, because they never open a connection.
           * Requiring it would make Postgres a prerequisite for running a
           * component test, and a suite with a setup cost is a suite that
           * stops being run locally.
           */
          setupFiles: ["./tests/ui/setup.ts"],
          include: ["tests/ui/**/*.test.{ts,tsx}"],
          exclude: ["node_modules/**", ".next/**"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
