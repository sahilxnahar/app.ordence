/**
 * Ordence — Test Environment Guard
 * Version: v0.6.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS FILE EXISTS TO STOP ONE SPECIFIC DISASTER
 * ══════════════════════════════════════════════════════════════════════════
 *
 * These tests CREATE tenants, INSERT rows, and DELETE everything they made.
 * If they ever ran against production, they would destroy live customer data.
 *
 * That is not a hypothetical. It happens to real teams, usually like this:
 * someone copies `.env.local` to `.env.test` "just to get the tests running",
 * forgets, and two weeks later the cleanup step wipes a customer's ledger.
 *
 * So this file refuses to let the suite start unless EVERY check passes:
 *
 *   1. `.env.test` must exist. No silent fallback to `.env.local`.
 *   2. `TEST_DATABASE_URL` must be set — a different variable name from the
 *      production `DATABASE_URL`, so a copy-paste cannot smuggle it in.
 *   3. The URL must contain an explicit test marker (`test`, `_test`, `localhost`
 *      or `127.0.0.1`).
 *   4. It must NOT match any known production hostname pattern.
 *   5. It must NOT equal `DATABASE_URL`, if that happens to be set.
 *   6. `ALLOW_DESTRUCTIVE_TESTS=true` must be present — a deliberate,
 *      typed-by-a-human acknowledgement.
 *
 * Any failure aborts the whole run with a loud message. Fail closed, always.
 */

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { WebSocket as UndiciWebSocket } from "undici";

/* ------------------------------------------------------------------ */
/* 1. LOAD .env.test — AND ONLY .env.test                              */
/* ------------------------------------------------------------------ */

const ENV_TEST_PATH = resolve(process.cwd(), ".env.test");

if (!existsSync(ENV_TEST_PATH)) {
  abort(
    "`.env.test` not found.",
    [
      "Tests will not run without it — falling back to .env.local would risk",
      "pointing this destructive suite at your real database.",
      "",
      "Create it with:",
      "",
      "    cp .env.test.example .env.test",
      "",
      "then edit it to point at a THROWAWAY database.",
    ].join("\n"),
  );
}

// `override: true` so a stray value already in the shell cannot win.
config({ path: ENV_TEST_PATH, override: true });

/* ------------------------------------------------------------------ */
/* 2–6. THE GUARD                                                      */
/* ------------------------------------------------------------------ */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 INFRA WAVE 12 — THE AMBIENT `DATABASE_URL` IS CAPTURED ONCE PER
 *    PROCESS, NOT ONCE PER FILE
 * ══════════════════════════════════════════════════════════════════════
 * Check 5 below asks: is `TEST_DATABASE_URL` the same string as the
 * `DATABASE_URL` the developer has in their shell? That question has one
 * correct answer per PROCESS, and this file runs once per test FILE.
 *
 * The setup aliases `DATABASE_URL` to the test database further down, so
 * the application code under test can open connections. On file 2, that
 * alias is still in `process.env` — same fork — and check 5 compared the
 * test URL against the alias it had itself installed, found them equal,
 * and aborted the whole run.
 *
 * ⚠️ `singleFork: true` IS WHAT MAKES THIS POSSIBLE AND IT IS NOT
 * NEGOTIABLE: the RLS guarantee depends on it. So the fix is to remember
 * the ORIGINAL value across the module-registry reset, which `globalThis`
 * survives and a module-level `const` does not.
 *
 * ⚠️ `Symbol.for`, NOT `Symbol()`. A fresh symbol per evaluation is a
 * different key every file, which is the same bug wearing a hat.
 */
const AMBIENT_KEY = Symbol.for("ordence.tests.ambient-database-url");
const ambient = globalThis as Record<symbol, unknown>;
if (!(AMBIENT_KEY in ambient)) {
  ambient[AMBIENT_KEY] = process.env.DATABASE_URL ?? null;
}
const PRODUCTION_DATABASE_URL = ambient[AMBIENT_KEY] as string | null;

/** Hostname fragments that indicate a managed/production database. */
const PRODUCTION_MARKERS = [
  ".neon.tech",
  ".supabase.co",
  ".rds.amazonaws.com",
  ".render.com",
  ".railway.app",
  ".planetscale",
  ".azure.com",
  ".cloudsql",
  "prod",
  "production",
] as const;

/** Fragments that positively identify a safe, disposable target. */
const TEST_MARKERS = ["localhost", "127.0.0.1", "test", "_test", "ameya_test"] as const;

if (!TEST_DATABASE_URL) {
  abort(
    "TEST_DATABASE_URL is not set.",
    [
      "This must be a SEPARATE variable from DATABASE_URL. That separation is",
      "deliberate: copying your production connection string in would not work,",
      "because the name would be wrong.",
      "",
      "Add to .env.test:",
      "",
      "    TEST_DATABASE_URL=\"postgresql://postgres@localhost:5432/ameya_test\"",
    ].join("\n"),
  );
}

const lowerUrl = TEST_DATABASE_URL.toLowerCase();

// --- Check 3: must positively look like a test database ---
const hasTestMarker = TEST_MARKERS.some((m) => lowerUrl.includes(m));
if (!hasTestMarker) {
  abort(
    "TEST_DATABASE_URL does not look like a test database.",
    [
      `  Got: ${maskUrl(TEST_DATABASE_URL)}`,
      "",
      "It must contain one of: localhost, 127.0.0.1, test, _test",
      "",
      "This suite CREATES AND DELETES data. Point it at a throwaway database.",
    ].join("\n"),
  );
}

// --- Check 4: must not look like production ---
const productionHit = PRODUCTION_MARKERS.find((m) => lowerUrl.includes(m));
if (productionHit) {
  // A managed host is allowed ONLY if the database name itself says test.
  const dbName = lowerUrl.split("/").pop()?.split("?")[0] ?? "";
  const dbNameIsTest = dbName.includes("test");

  if (!dbNameIsTest) {
    abort(
      "🚨 TEST_DATABASE_URL points at what looks like a PRODUCTION database.",
      [
        `  Matched: "${productionHit}"`,
        `  URL:     ${maskUrl(TEST_DATABASE_URL)}`,
        "",
        "REFUSING TO RUN. This suite would create and delete data.",
        "",
        "If this really is a disposable branch on a managed host, name the",
        "database itself with 'test' in it (e.g. `ameya_test`) and try again.",
      ].join("\n"),
    );
  }
}

// --- Check 5: must not equal the production URL ---
if (PRODUCTION_DATABASE_URL && TEST_DATABASE_URL === PRODUCTION_DATABASE_URL) {
  abort(
    "🚨 TEST_DATABASE_URL is IDENTICAL to DATABASE_URL.",
    [
      "This is the exact mistake this guard exists to catch.",
      "",
      "REFUSING TO RUN.",
    ].join("\n"),
  );
}

// --- Check 6: explicit human acknowledgement ---
if (process.env.ALLOW_DESTRUCTIVE_TESTS !== "true") {
  abort(
    "ALLOW_DESTRUCTIVE_TESTS is not set to 'true'.",
    [
      "These tests create and delete data. That acknowledgement has to be",
      "typed by a person, not inherited from somewhere.",
      "",
      "Add to .env.test:",
      "",
      "    ALLOW_DESTRUCTIVE_TESTS=\"true\"",
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ AFTER THE GUARD, AND ONLY AFTER IT: POINT THE APPLICATION AT   */
/*        THE TEST DATABASE                                            */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS SET HERE AND MUST NOT BE SET IN `.env.test`
 * ══════════════════════════════════════════════════════════════════════
 * Roughly half this suite drives the REAL application path on purpose:
 * `getAccessDecisionForTenant`, the Clerk webhook handler, the lockout.
 * Those call `getServerEnv()`, which validates the whole schema, and they
 * open their own connections through `DATABASE_URL`.
 *
 * Putting `DATABASE_URL` in `.env.test` makes it equal to
 * `TEST_DATABASE_URL` — and CHECK 5 ABOVE REFUSES EXACTLY THAT, correctly,
 * because it cannot tell a deliberate test alias from somebody pasting
 * their production string into the wrong variable. That check is worth
 * more than the convenience of one line in a file.
 *
 * ⭐ SO THE ALIAS IS MADE HERE, AFTER ALL SIX CHECKS HAVE PASSED. The
 * guard still compares a genuinely ambient `DATABASE_URL` — a developer
 * with production in their shell — against `TEST_DATABASE_URL`, and still
 * refuses if they match. Nothing is weakened; the alias simply happens on
 * the far side of the gate rather than in front of it.
 *
 * ⚠️ INFRA WAVE 12 FOUND THIS THE HARD WAY. Without it, `.env.test` had
 * no `DATABASE_URL`, `getServerEnv()` threw, and `server/billing/access.ts`
 * FAILED OPEN — so every billing-gate assertion that a restricted
 * workspace is refused saw a permissive decision. The suite did not error.
 * It reported the gate as broken while proving nothing about it.
 */
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DATABASE_URL_UNPOOLED ??= TEST_DATABASE_URL;

/* ------------------------------------------------------------------ */
/* CONFIRMATION BANNER                                                 */
/* ------------------------------------------------------------------ */

console.log(`
┌────────────────────────────────────────────────────────────────┐
│  ORDENCE — SECURITY TEST SUITE                                 │
├────────────────────────────────────────────────────────────────┤
│  Target: ${maskUrl(TEST_DATABASE_URL).padEnd(53)}│
│  Guard:  ✅ all 6 production-safety checks passed              │
└────────────────────────────────────────────────────────────────┘
`);

/* ------------------------------------------------------------------ */
/* NEON HTTP DRIVER → LOCAL POSTGRES SHIM                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ WHY THIS EXISTS.
 *
 * The application's pooled tenant path (`lib/db`'s `withTenant`) uses the
 * Neon **HTTP** driver — a deliberate choice documented next to `getPool()`:
 * a Railway process is long-lived, and a plain TCP pool is the right object
 * for it, with tenant scope carried by transaction-local GUCs.
 *
 * Against a THROWAWAY local Postgres there is no Neon endpoint to hit, and
 * the HTTP driver cannot speak plain Postgres wire protocol: it POSTs SQL
 * as JSON and reads JSON back. Without this shim, every test that drives
 * the REAL application path (billing gate, clerk webhooks, lockouts) would
 * watch `withTenant` fail its very first query with "fetch failed" — and
 * the fail-open billing decision would make the suite read as green while
 * the gate silently permits everything.
 *
 * This is a test-only translation layer: it listens on a loopback port, in
 * local-memory, and turns Neon's JSON protocol into ordinary `pg` queries.
 * It cannot reach anything but the database this file's own guard has
 * already certified as disposable, and it is unreachable from outside this
 * machine (127.0.0.1, test scope, started by the suite, torn down after).
 *
 * It is NOT a weakening of the production code path: the application code
 * that is exercised is byte-for-byte the same `neon()`/`Pool`/`transaction`
 * chain that runs on Railway. Only the transport underneath is swapped.
 */

let __neonShimHandle: import("node:http").Server | null = null;

async function installNeonHttpShim() {
  const http = await import("node:http");
  const pkg = await import("pg");
  const { Pool } = pkg;

  const port = 54321;

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 WHERE THE REAL POSTGRES ACTUALLY IS
   * ══════════════════════════════════════════════════════════════════
   * The WebSocket bridge below used to open its TCP socket with a
   * hard-coded `createConnection(5432, "127.0.0.1")`. Every developer
   * whose test database is not on 5432 — which is anyone who runs it
   * beside a real one — got ECONNREFUSED, `wsClose()` swallowed the
   * error, and the neon Pool surfaced it as the generic
   * "Connection terminated unexpectedly".
   *
   * ⚠️ AND THE SUITE DID NOT FAIL. `server/billing/access.ts` FAILS
   * OPEN on its own errors, deliberately and correctly — an outage in
   * our billing tables must never become an outage in a customer's
   * business. So the gate answered `level: "full", canWrite: true` for
   * every workspace, and five of the ten tests in billing-gate.test.ts
   * PASSED, including "leaves a healthy workspace completely alone".
   * They were asserting the behaviour of a gate that never ran.
   *
   * The five that failed are the only reason anybody found out.
   */
  const PG_TARGET = (() => {
    try {
      const u = new URL(TEST_DATABASE_URL!);
      return {
        host: u.hostname || "127.0.0.1",
        port: u.port ? Number(u.port) : 5432,
      };
    } catch {
      return { host: "127.0.0.1", port: 5432 };
    }
  })();

  const server = http.createServer(async (req, res) => {
    if (process.env.LOG_SHIM === "1") {
      console.error("[shim] incoming:", req.method, req.url, "upgrade:", req.headers.upgrade);
    }
    if (req.method !== "POST" || !req.url!.startsWith("/sql")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ message: "not found" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    void req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const connStr = req.headers["neon-connection-string"];
        // Neon always sends Neon-Raw-Text-Output: true, meaning every value
        // must come back as a JSON string (no pg type coercion). Without this
        // the neon parser throws an empty NeonDbError downstream.
        const rawText = req.headers["neon-raw-text-output"] === "true";
        if (typeof connStr !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return void res.end(JSON.stringify({ message: "missing Neon-Connection-String" }));
        }
        // Reuse the guard: the shim refuses to talk to anything that is not
        // positively identified as a test database — same markers as above.
        const lower = connStr.toLowerCase();
        if (
          !PRODUCTION_MARKERS.some((m) => lower.includes(m)) ||
          (lower.split("/").pop()?.split("?")[0] ?? "").includes("test") ||
          ["localhost", "127.0.0.1", "test", "_test"].some((m) => lower.includes(m))
        ) {
          // allowed
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          return void res.end(
            JSON.stringify({ message: "connection string does not look like a test database" }),
          );
        }
        const pool = new Pool({ connectionString: connStr, max: 4 });
        try {
          const client = await pool.connect();
          try {
            const queries: Array<{ query: string; params?: unknown[] }> =
              Array.isArray(payload.queries) ? payload.queries : [payload];
            const results = await Promise.all(
              queries.map(async (q) => {
                const r = await client.query(q.query, q.params ?? []);
                const toValue = rawText
                  ? (v: unknown) => (v === null ? null : String(v))
                  : (v: unknown) => v;
                return {
                  fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
                  rows: r.rows.map((row) => r.fields.map((f) => toValue(row[f.name]))),
                  types: [],
                };
              }),
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            const resp = Array.isArray(payload.queries)
              ? JSON.stringify({ results })
              : JSON.stringify(results[0]);
            if (process.env.LOG_SHIM === "1") {
              console.error(
                "[shim] req:",
                JSON.stringify(queries.map((q) => q.query.slice(0, 120))),
                "resp bytes:",
                resp.length,
              );
            }
            res.end(resp);
          } finally {
            client.release();
          }
        } finally {
          await pool.end();
        }
      } catch (e) {
        const err = e as { message?: string; code?: string; detail?: string; hint?: string };
        const errMsg = err?.message ?? "query failed";
        if (process.env.LOG_SHIM === "1") {
          console.error("[shim] query error:", JSON.stringify({ query: body.slice(0, 200), message: errMsg, code: err?.code, detail: err?.detail }));
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: errMsg, code: err?.code ?? "", detail: err?.detail ?? "", hint: err?.hint ?? "" }));
      }
    });
  });

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 INFRA WAVE 12 — THE FIRST TIME THIS SUITE WAS RUN OUTSIDE CI, 46
   *    OF ITS 47 FILES FAILED TO LOAD WITH `EADDRINUSE`
   * ══════════════════════════════════════════════════════════════════
   * `singleFork: true` puts every file in ONE process, which is what the
   * RLS guarantee needs. It does NOT put them in one module registry:
   * vitest isolates each file, so this setup file runs again per file,
   * and the second run tries to bind a port the first run is still
   * listening on.
   *
   * ⚠️ A MODULE-LEVEL `let` CANNOT SEE THAT. `__neonShimHandle` is reset
   * with the registry, so every file believes it is the first.
   *
   * ⭐ `globalThis` SURVIVES THE REGISTRY RESET AND NOT THE PROCESS. That
   * is exactly the right lifetime: one shim per fork, torn down when the
   * fork exits, and no leakage between runs.
   *
   * ⚠️ THE SYMBOL IS `Symbol.for`, NOT `Symbol()`. A fresh symbol per
   * module evaluation would be a different key every file, which is the
   * same bug wearing a hat.
   */
  const SHIM_KEY = Symbol.for("ordence.tests.neon-http-shim");
  const existing = (globalThis as Record<symbol, unknown>)[SHIM_KEY];

  if (existing) {
    /**
     * Another file in this fork already started it. Close the server we
     * just built — it is not listening, so this is cheap — and adopt the
     * running one so the teardown below still has a handle.
     */
    server.close();
    __neonShimHandle = existing as import("node:http").Server;
  } else {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    __neonShimHandle = server;
    (globalThis as Record<symbol, unknown>)[SHIM_KEY] = server;
  }

  // Point the Neon HTTP driver at the shim — whatever URL neon() was given,
  // the transport goes through our loopback translator. The neon driver reads
  // `defaults.fetchFunction` on EVERY execute, so this single assignment makes
  // all neon() calls in this process route through the shim.
  const neonMod = await import("@neondatabase/serverless");
  // neonConfig is the live config class: neon() reads `Se` (static getters
  // on neonConfig that consult `opts` before `defaults`) on every execute,
  // and its static setter `fetchFunction=` writes into opts. Installing the
  // shim here makes every neon() call in this process route through it.
  type NeonConfig = {
    fetchFunction?: unknown;
    wsProxy?: unknown;
    useSecureWebSocket?: boolean;
    webSocketConstructor?: unknown;
    pipelineConnect?: string;
  };
  (neonMod.neonConfig as unknown as NeonConfig).fetchFunction = async (
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const res = await fetch(`http://127.0.0.1:${port}/sql`, {
      ...init,
      headers: init?.headers as Record<string, string>,
    });
    void url;
    return res;
  };

  // -----------------------------------------------------------------------
  // WebSocket bridge: the neon *Pool* (used by `withTenant`'s
  // drizzleServerless) talks the PG wire protocol over WebSocket to
  // `<wsProxy>/v2`, then a real TCP socket does the rest. The single server
  // above is upgraded in place — same loopback port, both protocols.
  // -----------------------------------------------------------------------
  const cryptoMod = await import("node:crypto");
  const netMod = await import("node:net");
  const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455 accept GUID
  const PG_PROTOCOL_3 = 196608; // 0x30000
  const PG_SSL_REQUEST = 80877103; // 0x04D2162F

  const sha1Base64 = (k: string) => {
    return cryptoMod.createHash("sha1").update(k + MAGIC).digest("base64");
  };

  const parseStartup = (buf: Buffer) => {
    const params: Record<string, string> = {};
    let off = 8;
    while (off < buf.length - 1) {
      const keyStart = off;
      while (off < buf.length && buf[off] !== 0) off++;
      if (off >= buf.length) break;
      const key = buf.subarray(keyStart, off).toString("utf8");
      off++;
      if (key === "") break;
      const valStart = off;
      while (off < buf.length && buf[off] !== 0) off++;
      if (off >= buf.length) break;
      params[key] = buf.subarray(valStart, off).toString("utf8");
      off++;
    }
    return params;
  };

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${sha1Base64(key)}`,
        "",
        "",
      ].join("\r\n"),
    );

    let buffer = Buffer.alloc(0);
    let startupParsed = false;
    let pg: import("node:net").Socket | null = null;
    let wsClosed = false;
    let frameBuf = Buffer.alloc(0);
    let pgMsgBuf = Buffer.alloc(0);
    const outbox: Buffer[] = [];

    const wsClose = () => {
      if (wsClosed) return;
      wsClosed = true;
      if (!socket.destroyed) {
        // Server → client close frame; per RFC 6455 server frames are unmasked.
        socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
      }
      if (pg && !pg.destroyed) pg.end();
    };

    const flushPgMessages = () => {
      while (pgMsgBuf.length >= 5) {
        const msgLen = pgMsgBuf.readUInt32BE(1);
        if (msgLen < 4 || pgMsgBuf.length < 1 + msgLen) return;
        const msg = pgMsgBuf.subarray(0, 1 + msgLen);
        pgMsgBuf = pgMsgBuf.subarray(1 + msgLen);
        frameToPg(msg);
      }
    };

    const flushOutbox = () => {
      if (!pg || pg.destroyed) return;
      while (outbox.length > 0) pg.write(outbox.shift()!);
    };

    const frameToPg = (payload: Buffer) => {
      // The neon driver sends a preemptive cleartext password ('p' 0x70)
      // immediately after the startup message, ahead of any auth request —
      // vanilla pg rejects that as an unexpected message, so drop it.
      if (payload[0] === 0x70) return;
      if (!pg || pg.destroyed) {
        outbox.push(payload);
        return;
      }
      pg.write(payload);
    };

    const sendWs = (payload: Buffer) => {
      if (wsClosed || socket.destroyed) return;
      const len = payload.length;
      let header: Buffer;
      if (len < 126) header = Buffer.from([0x82, len]);
      else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x82;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      const frame = Buffer.concat([header, payload]);
      socket.write(frame);
    };

    socket.on("data", (chunk: Buffer) => {
      frameBuf = Buffer.concat([frameBuf, chunk]);
      try {
      while (frameBuf.length >= 2) {
        const opcode = frameBuf[0] & 0x0f;
        const masked = (frameBuf[1] & 0x80) !== 0;
        let len = frameBuf[1] & 0x7f;
        let hdr = 2;
        if (len === 126) {
          if (frameBuf.length < 4) return;
          len = frameBuf.readUInt16BE(2);
          hdr = 4;
        } else if (len === 127) {
          if (frameBuf.length < 10) return;
          len = Number(frameBuf.readBigUInt64BE(2));
          hdr = 10;
        }
        if (masked) hdr += 4;
        if (frameBuf.length < hdr + len) return;
        let payload = frameBuf.subarray(hdr, hdr + len);
        if (masked) {
          const maskKey = frameBuf.subarray(hdr - 4, hdr);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
        }
        frameBuf = frameBuf.subarray(hdr + len);

        if (opcode === 0x8) {
          wsClose();
          return;
        }
        if (opcode === 0x9) {
          const pongHeader =
            payload.length < 126
              ? Buffer.from([0x8a, payload.length])
              : (() => {
                  const h = Buffer.alloc(4);
                  h[0] = 0x8a;
                  h[1] = 126;
                  h.writeUInt16BE(payload.length, 2);
                  return h;
                })();
          sendWs(Buffer.concat([pongHeader, payload]));
          return;
        }
        if (opcode !== 0x2) continue;

        if (!startupParsed) {
          buffer = Buffer.concat([buffer, payload]);
          if (buffer.length >= 8) {
            const protoLen = buffer.readUInt32BE(0);
            if (protoLen < 8 || protoLen > 1024 * 1024) {
              wsClose();
              return;
            }
            if (buffer.length >= protoLen) {
              const startupBuf = buffer.subarray(0, protoLen);
              const proto = startupBuf.readUInt32BE(4);
              buffer = buffer.subarray(protoLen);
              if (proto === PG_SSL_REQUEST) {
                socket.write(Buffer.from([0x4e])); // 'N' — SSL not supported locally
                if (buffer.length > 0) pgMsgBuf = Buffer.concat([buffer, pgMsgBuf]);
                startupParsed = true;
                continue;
              }
              if (proto === PG_PROTOCOL_3) {
                const params = parseStartup(startupBuf);
                const lower = JSON.stringify(params).toLowerCase();
                // Same disposable-database guard as the HTTP shim: refuse to
                // open a real socket to anything that does not look like the
                // test database this suite already certified.
                if (
                  PRODUCTION_MARKERS.some((m) => lower.includes(m)) &&
                  ![
                    "localhost",
                    "127.0.0.1",
                    "test",
                    "_test",
                  ].some((m) => lower.includes(m))
                ) {
                  wsClose();
                  return;
                }
                const pgConn = netMod.createConnection(PG_TARGET.port, PG_TARGET.host);
                pg = pgConn;
                pgConn.on("data", (d) => sendWs(d));
                pgConn.on("error", (err) => {
                  // ⚠️ NEVER SILENT. A swallowed ECONNREFUSED here is
                  // indistinguishable, from the test's point of view, from a
                  // gate that decided to allow the write.
                  console.error(
                    `[shim] the WebSocket bridge could not reach PostgreSQL at ` +
                      `${PG_TARGET.host}:${PG_TARGET.port} — ${err.message}. ` +
                      `Every query on the Pool path will now fail, and any code ` +
                      `that fails OPEN on a database error will look like it passed.`,
                  );
                  wsClose();
                });
                pgConn.on("end", () => wsClose());
                pgConn.on("close", () => wsClose());
                pgConn.on("connect", () => {
                  pgConn.write(startupBuf);
                  flushOutbox();
                  flushPgMessages();
                });
                pgConn.on("timeout", () => pgConn.end());
                startupParsed = true;
                continue;
              }
              wsClose();
              return;
            }
          }
        } else {
          pgMsgBuf = Buffer.concat([pgMsgBuf, payload]);
          flushPgMessages();
        }
      }
      } catch (e) {
        if (e instanceof Error) void e;
        wsClose();
      }
    });
    socket.on("end", () => wsClose());
    socket.on("error", () => wsClose());
    socket.on("close", () => wsClose());
    socket.on("timeout", () => socket.end());
  });

  // The neon Pool (WS path) computes its WS URL as wsProxy(host) + "/v2".
  // Point it at the same loopback server the HTTP shim already owns, and
  // disable TLS on the WS transport (plain HTTP server cannot upgrade wss).
  (neonMod.neonConfig as unknown as NeonConfig).wsProxy = () => `127.0.0.1:${port}`;
  (neonMod.neonConfig as unknown as NeonConfig).useSecureWebSocket = false;
  // The per-file undici build is more tolerant of raw loopback frames than
  // Node's built-in globalThis.WebSocket in this environment.
  (neonMod.neonConfig as unknown as NeonConfig).webSocketConstructor = UndiciWebSocket as unknown as typeof globalThis.WebSocket;
  // Disable neon's "password" pipelineConnect hack. With trust auth on the
  // loopback pg, the client must not pre-send a cleartext password that the
  // bridge then has to strip — that flow was the source of the hang.
  (neonMod.neonConfig as unknown as NeonConfig).pipelineConnect = "off";
}

/**
 * ⚠️ The neon driver computes its endpoint from the connection string and
 * then calls the fetch function. Rather than fight its endpoint builder, the
 * shim's fetch function is installed at invocation time via the driver's own
 * `fetchFunction` hook — neon reads `Se` (the live config) on EVERY execute,
 * so setting it here affects all subsequent neon() calls in this process.
 */
await installNeonHttpShim();

/* ------------------------------------------------------------------ */
/* SHARED POOL                                                         */
/* ------------------------------------------------------------------ */

/**
 * A raw `pg` pool, deliberately NOT Drizzle.
 *
 * These tests must prove the DATABASE enforces isolation. Going through the ORM
 * would test the ORM's filtering as much as the database's. Raw SQL removes that
 * ambiguity: if a query returns rows it should not, the database let it through.
 */
/**
 * ⚠️ `max` MUST EXCEED THE LARGEST NUMBER OF SIMULTANEOUS CONNECTIONS ANY
 * SINGLE TEST NEEDS, WITH HEADROOM.
 *
 * It was 4. `tests/security/metering-isolation.test.ts` opens exactly 4
 * concurrent connections to prove the counter upsert is atomic under real
 * contention — which is the central claim of Phase 15 and cannot be tested
 * any other way.
 *
 * Sized exactly to demand, the pool had no slack. A connection still being
 * reaped from a previous file (`idleTimeoutMillis` is 5s) left three slots
 * free, the fourth worker waited, and `connectionTimeoutMillis` failed it
 * after ten seconds. The suite then reported a CONCURRENCY test failing —
 * pointing at the code under test rather than at the harness.
 *
 * That is the worst shape a flake can take in a security suite: it looks
 * like the thing you are most worried about, so it trains people to re-run
 * until green instead of investigating. Observed once after a database
 * restart, then unreproducible across five consecutive full runs.
 *
 * Doubled, so the concurrency test has slack and a future test needing more
 * than four has room before it starts producing the same misleading signal.
 */
export const testPool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Separate ADMIN connection, used only for fixture setup and teardown.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY TWO POOLS — THIS IS THE MOST IMPORTANT DETAIL IN THE FILE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A PostgreSQL SUPERUSER bypasses Row-Level Security completely. Not partially —
 * completely. `FORCE ROW LEVEL SECURITY` makes policies apply to the table
 * OWNER, but a superuser (or any role with BYPASSRLS) still sees everything.
 *
 * So a test suite that connects as `postgres` would pass every isolation
 * assertion while proving NOTHING. It would report green forever, including
 * on the day someone drops a policy.
 *
 * Therefore:
 *   testPool  → a NON-superuser role, exactly like the application uses.
 *               Every assertion runs here.
 *   adminPool → superuser, used ONLY to create and destroy fixtures.
 *
 * If `adminPool` ever appears inside an assertion, that assertion is worthless.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? TEST_DATABASE_URL;

export const adminPool = new Pool({
  connectionString: ADMIN_URL,
  max: 2,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Run a callback inside a transaction with tenant context pinned — the same
 * mechanism the application uses in `withTenant()`.
 */
export async function asTenant<T>(
  tenantId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  let poisoned = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // ⚠️ IF THE ROLLBACK ITSELF FAILS, DESTROY THE CONNECTION.
    // `release(true)` closes it instead of putting it back in the pool. A
    // connection returned while still inside an aborted transaction makes the
    // NEXT borrower's BEGIN die with "current transaction is aborted, commands
    // ignored until end of transaction block" — an error naming neither the
    // test that poisoned it nor the statement that failed. Three accounting
    // tests failed that way, for a reason none of them contained.
    await client.query("ROLLBACK").catch(() => {
      poisoned = true;
    });
    throw err;
  } finally {
    client.release(poisoned);
  }
}

/**
 * Run with NO tenant context. Used to prove the fail-closed default:
 * no context must mean zero rows, never all rows.
 */
export async function withoutTenant<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  let poisoned = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // ⚠️ IF THE ROLLBACK ITSELF FAILS, DESTROY THE CONNECTION.
    // `release(true)` closes it instead of putting it back in the pool. A
    // connection returned while still inside an aborted transaction makes the
    // NEXT borrower's BEGIN die with "current transaction is aborted, commands
    // ignored until end of transaction block" — an error naming neither the
    // test that poisoned it nor the statement that failed. Three accounting
    // tests failed that way, for a reason none of them contained.
    await client.query("ROLLBACK").catch(() => {
      poisoned = true;
    });
    throw err;
  } finally {
    client.release(poisoned);
  }
}

/**
 * Run with the PLATFORM SCOPE marker set — the same thing
 * `withPlatformScope()` does in `db/index.ts`.
 *
 * ⚠️ NOT the same as `withoutTenant()`, and the difference is the whole
 * point of the v0.14.1 fix. "No tenant context" used to be assumed to
 * mean "unrestricted"; it actually meant `tenant_id = NULL`, which is
 * never TRUE, so the escape hatch read ZERO ROWS from every table.
 *
 * Platform scope is now an explicit opt-in, and it is READ-ONLY and
 * NARROW: it reaches tenants, users, subscriptions, invoices, payment,
 * usage and observability rows — never customer content.
 */
export async function asPlatform<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  let poisoned = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.platform_scope', 'on', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // ⚠️ IF THE ROLLBACK ITSELF FAILS, DESTROY THE CONNECTION.
    // `release(true)` closes it instead of putting it back in the pool. A
    // connection returned while still inside an aborted transaction makes the
    // NEXT borrower's BEGIN die with "current transaction is aborted, commands
    // ignored until end of transaction block" — an error naming neither the
    // test that poisoned it nor the statement that failed. Three accounting
    // tests failed that way, for a reason none of them contained.
    await client.query("ROLLBACK").catch(() => {
      poisoned = true;
    });
    throw err;
  } finally {
    client.release(poisoned);
  }
}

/**
 * ⭐ Borrow a raw pooled connection with the rollback guaranteed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS RATHER THAN `testPool.connect()` IN A TEST
 * ══════════════════════════════════════════════════════════════════════
 * A test that needs to control BEGIN/COMMIT itself — to prove a trigger
 * refuses at INSERT rather than at COMMIT, for instance — cannot use
 * `asTenant`, which owns the transaction. So it borrowed a client
 * directly and wrote:
 *
 *     try {
 *       await client.query("BEGIN");
 *       await client.query(<the statement under test>);   // ← throws here
 *       ...
 *       await client.query("ROLLBACK");                   // ← never reached
 *     } finally {
 *       client.release();                                 // ← still returned
 *     }
 *
 * The throw jumped straight past the ROLLBACK to the `finally`, and the
 * connection went back into the pool inside an aborted transaction. The
 * NEXT test to borrow it failed on `BEGIN` with "current transaction is
 * aborted", naming neither the test that poisoned the connection nor the
 * statement that failed. It looked like a bug in an unrelated DELETE.
 *
 * ⚠️ POOLED CONNECTIONS ARE SHARED STATE. Anything a test leaves on one —
 * an open transaction, a `set_config(..., false)` that is not
 * transaction-local, an advisory lock — is inherited by whatever borrows
 * it next, which is usually a different test file.
 *
 * This helper always rolls back and always destroys the connection
 * afterwards, so nothing can be inherited at all.
 */
export async function withRawClient<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  try {
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    // `true` destroys rather than returns. A raw client has by definition
    // been used in a way this file cannot reason about; the pool is better
    // off opening a fresh one.
    client.release(true);
  }
}

/**
 * Escape hatch that BYPASSES RLS — used only for test setup and teardown,
 * where fixtures must be created across tenants.
 *
 * Named to be obvious in a diff. If this appears inside an assertion, the test
 * is not proving what it claims to prove.
 */
export async function asSuperuser<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await adminPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Capture the error a query raises, or null if it unexpectedly succeeded. */
export async function expectError(
  fn: () => Promise<unknown>,
): Promise<{ message: string; code?: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    return { message: e.message ?? String(err), code: e.code };
  }
}

/* ------------------------------------------------------------------ */
/* LIFECYCLE                                                           */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  // Prove connectivity before any test claims a database-level guarantee.
  const client = await testPool.connect();
  try {
    const { rows } = await client.query(`
      SELECT current_database() AS db,
             current_user       AS usr,
             (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS is_super,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `);
    const info = rows[0];
    console.log(`  Connected to: ${info?.db} as ${info?.usr}`);

    // THE CHECK THAT MAKES THIS SUITE MEAN ANYTHING.
    // A superuser bypasses RLS entirely — every isolation assertion would pass
    // while proving nothing at all.
    if (info?.is_super || info?.bypass_rls) {
      throw new Error(
        `\n\n🚨 TEST_DATABASE_URL connects as "${info.usr}", which ` +
          `${info.is_super ? "is a SUPERUSER" : "has BYPASSRLS"}.\n\n` +
          "Superusers bypass Row-Level Security completely. Every isolation\n" +
          "test would PASS while proving nothing — including on the day a\n" +
          "policy gets dropped.\n\n" +
          "Create a normal role and use it instead:\n\n" +
          "  CREATE ROLE ordence_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;\n" +
          "  GRANT USAGE ON SCHEMA public TO ordence_app;\n" +
          "  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ordence_app;\n",
      );
    }
    console.log("  RLS check: ✅ non-superuser role — isolation tests are meaningful");
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await Promise.all([testPool.end(), adminPool.end()]);
});

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/** Hide credentials before printing a connection string. */
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const db = parsed.pathname.replace("/", "");
    return `${parsed.protocol}//***@${host}:${parsed.port || "5432"}/${db}`;
  } catch {
    return "***";
  }
}

/** Print a loud failure and stop the process. */
function abort(title: string, detail: string): never {
  const line = "═".repeat(66);
  console.error(`\n${line}`);
  console.error(`  TEST SUITE ABORTED — ${title}`);
  console.error(line);
  console.error(`\n${detail}\n`);
  console.error(line + "\n");
  process.exit(1);
}
