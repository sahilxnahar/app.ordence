/**
 * Ordence — Request Body Size Limits
 * Version: v1.31.0-alpha (Batch 31)
 * Runtime: Edge AND Node. No `node:` imports.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NOTHING BOUNDED THE COST OF A SINGLE REQUEST
 * ══════════════════════════════════════════════════════════════════════
 * Two routes capped their body before this batch: `/api/telemetry`
 * (64 KiB, checked twice, correctly) and `/api/upload/put` (a signed
 * ticket with a per-file ceiling). Everything else — the assistant, MCP,
 * every server action — called `await req.json()` on whatever arrived.
 *
 * `await request.json()` on an unbounded body is the whole vulnerability.
 * It buffers the entire payload into the isolate's memory BEFORE any
 * validation runs, so a Zod schema that would have rejected the payload
 * in microseconds never gets the chance. On a Worker with a fixed memory
 * ceiling the process dies; on Node it survives and the bill arrives
 * later. Either way the attacker spent one request and no CPU.
 *
 * ⚠️ THE ASSISTANT ROUTE IS THE EXPENSIVE ONE. Its body becomes prompt
 * tokens that a third party charges us for. An unbounded body there is
 * not a memory problem, it is a denial-of-WALLET, and it does not need an
 * attacker: one client stuck in a loop resending its own chat history,
 * which grows every iteration, does it by accident.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `Content-Length` IS A CLAIM, NOT A MEASUREMENT. BOTH CHECKS EXIST.
 * ══════════════════════════════════════════════════════════════════════
 *   THE DECLARED CHECK (`checkDeclaredBodySize`) runs in middleware,
 *   before a byte of body is read. It is cheap and it is kind — refusing
 *   a 60 MB upload before transferring it saves the caller's bandwidth as
 *   well as ours. It is also trivially defeated: a `Transfer-Encoding:
 *   chunked` request carries no `Content-Length` at all, and a hostile
 *   client can simply lie.
 *
 *   THE MEASURED CHECK (`readBodyWithLimit`) runs in the route, counts
 *   ACTUAL bytes as they arrive, and aborts the stream the moment the cap
 *   is passed. This is the one that holds. It is the reason the declared
 *   check being bypassable is acceptable rather than alarming.
 *
 * 🔴 THE MEASURED CHECK COUNTS BYTES, NOT CHARACTERS. `"…".length` is
 * UTF-16 code units; a body of astral-plane characters is up to four
 * times the bytes its `.length` suggests, so a cap built on `.length`
 * is a cap four times looser than it reads. Reading the stream in
 * `Uint8Array` chunks sidesteps the question entirely.
 */

import { bodyLimitFor, type BodyLimitRule } from "@/lib/edge/budgets";

/* ------------------------------------------------------------------ */
/* THE DECLARED CHECK — EDGE, BEFORE THE BODY IS READ                  */
/* ------------------------------------------------------------------ */

export type BodySizeVerdict =
  | { ok: true; limitBytes: number; declaredBytes: number | null }
  | {
      ok: false;
      limitBytes: number;
      declaredBytes: number;
      /** Category, for the response body. Never a stack trace. */
      code: "request_too_large";
      message: string;
    };

/**
 * Refuse an oversized request from its declared length alone.
 *
 * ⚠️ ONLY REFUSES ON A PRESENT, PARSEABLE, OVERSIZED VALUE. An absent
 * header, a non-numeric one and a negative one all pass, deliberately:
 * this check exists to make the honest case cheap, and treating a missing
 * header as a violation would refuse every legitimate chunked upload and
 * every GET.
 */
export function checkDeclaredBodySize(
  pathname: string,
  contentLength: string | null | undefined,
): BodySizeVerdict {
  const rule = bodyLimitFor(pathname);

  if (contentLength === null || contentLength === undefined || contentLength === "") {
    return { ok: true, limitBytes: rule.maxBytes, declaredBytes: null };
  }

  const declared = Number(contentLength);
  if (!Number.isFinite(declared) || declared < 0) {
    return { ok: true, limitBytes: rule.maxBytes, declaredBytes: null };
  }

  if (declared > rule.maxBytes) {
    return {
      ok: false,
      limitBytes: rule.maxBytes,
      declaredBytes: declared,
      code: "request_too_large",
      message: tooLargeMessage(rule, declared),
    };
  }

  return { ok: true, limitBytes: rule.maxBytes, declaredBytes: declared };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A 413 THAT SAYS WHAT HAPPENED AND WHAT TO DO
 * ══════════════════════════════════════════════════════════════════════
 * The alternative — an unhandled `PayloadTooLargeError` surfacing as a
 * 500 with a stack trace — is wrong twice over. It tells the caller
 * nothing actionable ("something broke, maybe retry?" is the worst
 * possible advice for a request that will fail identically forever), and
 * it tells an attacker our framework, our file layout and our line
 * numbers.
 *
 * ⚠️ THE LIMIT IS STATED, AND THAT IS NOT AN INFORMATION LEAK. A body
 * size ceiling is not a secret — it is an interface contract, and the
 * integration author on the other end cannot chunk their payload
 * correctly without knowing it. Contrast the rate limiter, whose exact
 * remaining budget IS withheld from anonymous callers, because there the
 * number lets an attacker calibrate rather than comply.
 */
function tooLargeMessage(rule: BodyLimitRule, declaredBytes: number): string {
  return (
    `Request body is too large: ${formatBytes(declaredBytes)} was sent and ` +
    `this endpoint accepts at most ${formatBytes(rule.maxBytes)}. ` +
    `Send fewer records per request, or upload files through /api/upload.`
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/** The refusal body. Same shape as `jsonError` in middleware.ts. */
export function bodyTooLargeBody(verdict: Extract<BodySizeVerdict, { ok: false }>): {
  error: { code: string; message: string; limitBytes: number };
} {
  return {
    error: {
      code: verdict.code,
      message: verdict.message,
      limitBytes: verdict.limitBytes,
    },
  };
}

/* ------------------------------------------------------------------ */
/* THE MEASURED CHECK — THE ONE THAT HOLDS                             */
/* ------------------------------------------------------------------ */

export class RequestTooLargeError extends Error {
  readonly code = "request_too_large" as const;
  readonly status = 413 as const;
  constructor(
    readonly limitBytes: number,
    readonly readBytes: number,
  ) {
    super(
      `Request body exceeded ${formatBytes(limitBytes)} (stopped after ` +
        `${formatBytes(readBytes)}). Send a smaller payload.`,
    );
    this.name = "RequestTooLargeError";
  }
}

/**
 * Read a request body as text, aborting as soon as the cap is passed.
 *
 * ⚠️ THIS IS NOT `await request.text()` FOLLOWED BY A LENGTH CHECK, AND
 * THE DIFFERENCE IS THE ENTIRE POINT. Buffering first and measuring
 * afterwards means the attacker has already made us allocate the memory
 * they wanted us to allocate; the check then reports a problem we already
 * suffered. Reading in chunks and cancelling the stream means a 1 GB body
 * costs us the first `maxBytes` and nothing more.
 *
 * ⚠️ THE STREAM IS EXPLICITLY CANCELLED. Returning early without
 * cancelling leaves the connection consuming socket buffer and, on some
 * runtimes, keeps the request alive until the client finishes sending —
 * which is precisely the resource the attacker was trying to hold.
 *
 * @throws {RequestTooLargeError} when the cap is passed.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const body = request.body;

  // Some runtimes (and every test double) present no stream. Fall back to
  // the buffered read, then measure — weaker, but never weaker than the
  // status quo, and still refuses.
  if (!body) {
    const text = await request.text();
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > maxBytes) throw new RequestTooLargeError(maxBytes, bytes);
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {
          /* Cancelling a stream that already ended is not an error. */
        });
        throw new RequestTooLargeError(maxBytes, total);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * `readBodyWithLimit` + `JSON.parse`, which is what every caller wants.
 *
 * ⚠️ A PARSE FAILURE AND AN OVERSIZE FAILURE ARE DIFFERENT ERRORS AND
 * MUST STAY DIFFERENT. Collapsing both into "400 bad request" is how an
 * integration author spends an afternoon debugging their JSON when the
 * actual problem is that they sent 4 MB of perfectly valid JSON.
 */
export async function readJsonWithLimit<T = unknown>(
  request: Request,
  pathnameOrBytes: string | number,
): Promise<T> {
  const maxBytes =
    typeof pathnameOrBytes === "number"
      ? pathnameOrBytes
      : bodyLimitFor(pathnameOrBytes).maxBytes;

  const text = await readBodyWithLimit(request, maxBytes);
  return JSON.parse(text) as T;
}
