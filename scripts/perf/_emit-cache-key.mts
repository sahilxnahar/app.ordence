/**
 * Ordence — Track F · one line of output, for the subprocess proof
 * Version: v1.81.0-alpha · Wave 17
 *
 * `lib/cache/keys.ts` freezes its environment tag at module load, on
 * purpose: a key built from a value that can change mid-process would
 * write under one prefix and read under another. That makes the tag
 * impossible to vary inside one process, so the only honest way to prove
 * two deployments produce different keys is to BE two processes.
 *
 * This is that second process. It prints one key and exits.
 * Invoked only by `scripts/perf/prove-cache-isolation.mts`.
 */
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Same `server-only` neutralisation as the caller — see that file.
const EMPTY_SERVER_ONLY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "node_modules", "server-only", "empty.js",
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolver = (Module as any)._resolveFilename;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") return EMPTY_SERVER_ONLY;
  return resolver.call(this, request, ...rest);
};

const keys = await import("../../lib/cache/keys");
process.stdout.write(
  keys.tenantCacheKey("11111111-1111-4111-8111-111111111111", "ledger-list"),
);
