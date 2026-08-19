/**
 * ⚠️ DEPRECATED AND KEPT ONLY AS A SIGNPOST — Infra wave 12.
 *
 * 🔴 THIS FILE COULD NEVER HAVE WORKED, and nothing ever called it, so
 * nobody found out.
 *
 * It set `BigInt.prototype.toJSON` and then used `execFileSync` to run
 * the drizzle-kit binary. `execFileSync` starts a NEW Node process. A
 * prototype modified in the parent does not exist in the child. The
 * patch was applied to a process whose only remaining job was to wait.
 *
 * The working version is `scripts/drizzle-kit.mjs`, which loads
 * `scripts/lib/bigint-json.mjs` INTO the child with `--import`, and
 * which also treats drizzle-kit's known silent failures as failures
 * regardless of its exit code.
 *
 *     node scripts/drizzle-kit.mjs push --force
 *
 * ⚠️ THIS FILE IS NOT DELETED because the shape of the mistake is worth
 * keeping where somebody will find it: a fix that is written, is
 * correct-looking, is never invoked, and is therefore never observed to
 * be wrong. That is the same defect class as everything wave 9 found,
 * occurring in the build tooling rather than in the product.
 */
throw new Error(
  "scripts/_bigint-monkeypatch.mjs never worked — use scripts/drizzle-kit.mjs instead. " +
    "See the comment in this file.",
);
