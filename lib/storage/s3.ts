/**
 * Ordence — ⭐ OBJECT STORAGE OVER THE S3 PROTOCOL
 * Version: v0.71.0-alpha
 * Runtime: anywhere `fetch` and Web Streams exist — Node, Railway, Workers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: THE MOVE OFF CLOUDFLARE WORKERS
 * ══════════════════════════════════════════════════════════════════════
 * `lib/storage/r2.ts` reached R2 through a Worker BINDING — `env.DOCUMENTS`,
 * an object Cloudflare injects into the runtime. It is fast, it needs no
 * credentials, and it exists only inside a Cloudflare Worker.
 *
 * On Railway there is no such object. `getCloudflareContext()` throws, the
 * binding resolves to null, and every upload and download fails with
 * "storage is not configured" — cleanly, but completely.
 *
 * ⚠️ THE FILES DO NOT NEED TO MOVE. R2 also speaks the ordinary S3
 * protocol over HTTPS, at
 *
 *     https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 *
 * so the same buckets, holding the same objects, are reachable from
 * anywhere with an API token. Nothing is migrated and nothing is copied.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY `aws4fetch` AND NOT `@aws-sdk/client-s3`
 * ══════════════════════════════════════════════════════════════════════
 * The AWS SDK is around 3 MB and pulls in a large dependency tree for what
 * is, here, four HTTP verbs against one host. `aws4fetch` does one thing —
 * SigV4-signs a `Request` — in a few kilobytes, using the platform `fetch`.
 *
 * That also keeps this file runtime-neutral. If this application ever
 * moves again, or runs on Workers for one deployment and Node for
 * another, the storage layer does not care.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CREDENTIALS ARE READ AT REQUEST TIME, NEVER AT MODULE LOAD
 * ══════════════════════════════════════════════════════════════════════
 * A module-level `new AwsClient(...)` runs during `next build`, on a
 * machine with no secrets, and either throws or freezes `undefined` into
 * the output. The same trap as the Clerk keys — see `app/layout.tsx`.
 */

import { AwsClient } from "aws4fetch";

export type S3Config = {
  accessKeyId: string;
  secretAccessKey: string;
  /** e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
};

/**
 * Read the four settings, or null when storage is not configured this way.
 *
 * ⚠️ ALL FOUR OR NOTHING. A deployment with three of them set is
 * misconfigured, and treating that as "configured" produces a signing
 * failure on the first upload rather than a clear refusal at the gate.
 */
export function readS3Config(): S3Config | null {
  const bag = process.env as Record<string, string | undefined>;

  const accessKeyId = bag.S3_ACCESS_KEY_ID;
  const secretAccessKey = bag.S3_SECRET_ACCESS_KEY;
  const endpoint = bag.S3_ENDPOINT;
  const bucket = bag.S3_BUCKET;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return null;

  return {
    accessKeyId,
    secretAccessKey,
    // A trailing slash produces a double slash in every signed URL, and
    // SigV4 signs the path — so the signature covers a path the server
    // does not recognise, and every request 403s with nothing to explain it.
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
  };
}

function clientFor(config: S3Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    /**
     * ⚠️ `region: "auto"` IS WHAT R2 REQUIRES, and it is not cosmetic.
     * SigV4 folds the region into the signing key, so a mismatch fails
     * with `SignatureDoesNotMatch` — an error that reads like a wrong
     * secret and sends somebody off to regenerate a perfectly good token.
     */
    region: "auto",
    service: "s3",
  });
}

/**
 * The URL for one object.
 *
 * ⚠️ EACH PATH SEGMENT IS ENCODED SEPARATELY, and the slashes are left
 * alone. `encodeURIComponent` on the whole key would turn every `/` into
 * `%2F` — a single flat object whose name contains slashes, which is not
 * the same object and will not be found. Keys in this product look like
 * `tenants/<uuid>/documents/<uuid>/name.pdf`.
 */
function objectUrl(config: S3Config, key: string): string {
  const path = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${config.endpoint}/${config.bucket}/${path}`;
}

export type S3Object = {
  size: number;
  body: ReadableStream;
  contentType: string | null;
};

export async function s3Get(config: S3Config, key: string): Promise<S3Object | null> {
  const response = await clientFor(config).fetch(objectUrl(config, key), { method: "GET" });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Storage read failed (${response.status}).`);
  }
  if (!response.body) return null;

  return {
    size: Number(response.headers.get("content-length") ?? 0),
    body: response.body,
    contentType: response.headers.get("content-type"),
  };
}

export async function s3Head(config: S3Config, key: string): Promise<{ size: number } | null> {
  const response = await clientFor(config).fetch(objectUrl(config, key), { method: "HEAD" });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Storage head failed (${response.status}).`);
  }
  return { size: Number(response.headers.get("content-length") ?? 0) };
}

export async function s3Put(
  config: S3Config,
  key: string,
  body: ReadableStream | ArrayBuffer,
  contentType: string,
  /**
   * ⚠️ REQUIRED WHEN `body` IS A STREAM, AND THIS IS THE ONE REAL
   * DIFFERENCE FROM THE BINDING.
   *
   * The R2 binding accepts a stream of unknown length. A signed S3 PUT
   * does not: SigV4 needs either a `Content-Length` or chunked-streaming
   * signing, and without one the request is rejected — or worse, some
   * stacks silently buffer the whole body in memory to compute it.
   *
   * The upload route already knows the length: it has been validated
   * against the ticket's ceiling before a byte is written. Passing it
   * through is exact and costs nothing.
   */
  contentLength?: number,
): Promise<{ size: number } | null> {
  const headers: Record<string, string> = { "content-type": contentType };

  if (contentLength !== undefined) {
    headers["content-length"] = String(contentLength);
  }

  const response = await clientFor(config).fetch(objectUrl(config, key), {
    method: "PUT",
    body: body as BodyInit,
    headers,
    // Node's fetch requires this to send a stream body at all.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);

  if (!response.ok) {
    throw new Error(`Storage write failed (${response.status}).`);
  }

  /*
   * ⚠️ THE STORED SIZE IS RE-READ, NOT ASSUMED.
   *
   * The quota system bills against what actually landed, and a client's
   * declared length is a claim. The binding returned the true size from
   * `put()`; S3 does not, so one HEAD is issued to get the same
   * guarantee. One extra round trip per upload, in exchange for a figure
   * that cannot be understated by a caller.
   */
  const head = await s3Head(config, key);
  return head ?? { size: contentLength ?? 0 };
}

export async function s3Delete(config: S3Config, key: string): Promise<void> {
  const response = await clientFor(config).fetch(objectUrl(config, key), { method: "DELETE" });

  /*
   * ⚠️ 404 IS SUCCESS. S3 delete is idempotent and so is the binding's.
   * `deleteDocument()` retries after a partial failure, and it must be
   * able to complete rather than dead-lock on bytes that are already gone.
   */
  if (!response.ok && response.status !== 404) {
    throw new Error(`Storage delete failed (${response.status}).`);
  }
}
