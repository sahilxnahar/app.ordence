/**
 * Ordence — ⭐ TEACH `JSON.stringify` ABOUT `BigInt`, IN THE PROCESS THAT
 *              NEEDS IT
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS AND `scripts/_bigint-monkeypatch.mjs` DID NOT
 *    WORK
 * ══════════════════════════════════════════════════════════════════════
 * `drizzle-kit` JSON-encodes a snapshot of the schema. Several tables in
 * this product carry `bigint` columns — money is stored in minor units as
 * `bigint` throughout — and `JSON.stringify` throws on a BigInt:
 *
 *     TypeError: Do not know how to serialize a BigInt
 *
 * Somebody hit this and wrote `scripts/_bigint-monkeypatch.mjs`, which
 * sets `BigInt.prototype.toJSON` and then calls `execFileSync` to run the
 * drizzle-kit binary.
 *
 * ⚠️ THAT CANNOT WORK, AND IT WAS NEVER CALLED BY ANYTHING SO NOBODY
 * FOUND OUT. `execFileSync` starts a NEW Node process. A prototype
 * modified in the parent does not exist in the child. The patch was
 * applied to a process that then did nothing but wait.
 *
 * ⭐ THIS FILE IS LOADED INTO THE CHILD ITSELF, via
 * `NODE_OPTIONS=--import=…`, so the prototype is patched in the process
 * that calls `JSON.stringify`.
 *
 * ⚠️ `Number(this)` LOSES PRECISION ABOVE 2^53 AND THAT IS ACCEPTABLE
 * HERE AND NOWHERE ELSE. This is a SCHEMA snapshot: the BigInts in it are
 * column defaults and sequence bounds, not money. `lib/export/values.ts`
 * makes the opposite choice for the same type, because there the BigInt
 * IS money and `Number()` on it is a silent wrong answer on a customer's
 * invoice.
 */
BigInt.prototype.toJSON = function () {
  return Number(this);
};
