/**
 * Ordence — Object Storage (Cloudflare R2)
 * Version: v0.21.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT REPLACED WHAT
 * ══════════════════════════════════════════════════════════════════════════
 * This module replaces `@vercel/blob`. The security model is unchanged and
 * is restated here because it is the only reason any of this is shaped the
 * way it is:
 *
 *   • Objects are PRIVATE. The bucket has no public URL, no custom domain
 *     and no `r2.dev` access enabled. There is no such thing as "the URL of
 *     a document" that could leak from a log, an email or a Referer header.
 *
 *   • Every read goes through a route that re-checks either the Clerk
 *     session (`/api/documents/[id]/download`) or the portal token
 *     (`/portal/[token]/documents/[documentId]`) FIRST, and streams the
 *     bytes itself. Revoking access takes effect on the next request.
 *
 *   • Every key starts `tenants/<tenant-uuid>/`. That prefix is built
 *     server-side from the session and verified again by
 *     `pathnameBelongsToTenant()` before any read, write or delete.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A BINDING AND NOT S3 CREDENTIALS
 * ══════════════════════════════════════════════════════════════════════════
 * R2 also speaks the S3 API, which would let us mint presigned URLs the
 * browser uploads to directly — the closest literal translation of what
 * Vercel Blob did.
 *
 * We use the Worker BINDING instead:
 *
 *   • No long-lived access key exists to leak. A binding is scoped to this
 *     Worker by the platform; there is no `R2_SECRET_ACCESS_KEY` to rotate,
 *     to commit by accident, or to explain to a non-technical operator.
 *   • The bytes cross a connection we already authenticated. With a
 *     presigned PUT, the browser talks to R2 directly and our code is out of
 *     the conversation — exactly the property that forced every constraint
 *     to be decided up-front in the Vercel design.
 *   • One fewer thing to configure on deploy day.
 *
 * What we give up: uploads now flow THROUGH the Worker. Cloudflare caps a
 * request body at 100 MB on the free zone plans; our own ceiling is 50 MB
 * (MAX_FILE_BYTES), so there is head-room. Resumable multipart upload is
 * gone — see docs/CLOUDFLARE-DEPLOY.md, "What degrades".
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  readS3Config,
  s3Delete,
  s3Get,
  s3Head,
  s3Put,
  type S3Config,
} from "@/lib/storage/s3";

/**
 * The subset of R2Bucket this application actually uses.
 *
 * Declared narrowly on purpose: it documents the entire surface area of our
 * dependency on R2 in nine lines, and it keeps every consumer honest about
 * what is available.
 */
export type DocumentBucket = {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<
    | {
        size: number;
        body: ReadableStream;
        httpMetadata?: { contentType?: string };
      }
    | null
  >;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string | null,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<{ size: number; key: string } | null>;
  delete(key: string): Promise<void>;
};

/**
 * The R2 bucket, or null when it is not bound.
 *
 * ⚠️ RETURNS NULL RATHER THAN THROWING, and every caller must handle it.
 *
 * `getCloudflareContext()` throws outside a Worker — in a unit test, in a
 * `next build` render pass, in `next dev` before the platform proxy is up.
 * The old code had exactly this shape around `BLOB_READ_WRITE_TOKEN` for
 * exactly this reason: a missing storage binding must degrade to a clear
 * "storage is not configured" message on one feature, not take down every
 * page that happens to import a module that imports this one.
 */
export function getDocumentBucket(): DocumentBucket | null {
  try {
    const bucket = getCloudflareContext().env.DOCUMENTS;
    return (bucket as unknown as DocumentBucket | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * ⭐ WHICH BACKEND IS AVAILABLE — added v0.71.0 for the move to Railway.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE BINDING IS TRIED FIRST, AND THAT ORDER IS DELIBERATE.
 * ══════════════════════════════════════════════════════════════════════
 * Inside a Cloudflare Worker the binding is strictly better: no
 * credentials cross the wire, no signature to compute, no round trip to
 * a public endpoint. Where it exists, it wins.
 *
 * Everywhere else — Railway, a Node server, `next dev`, a test — it does
 * not exist, and the same R2 buckets are reached over the ordinary S3
 * protocol instead. Same objects, same keys, nothing migrated.
 *
 * ⚠️ KEEPING BOTH PATHS IS NOT INDECISION. A migration in which the old
 * path is deleted the moment the new one is written is a migration with
 * no way back: if the S3 credentials turn out to be wrong on the first
 * real upload, the Cloudflare deployment that was working an hour ago no
 * longer exists to fall back to. Both work until one has been proven.
 */
type Backend =
  | { kind: "binding"; bucket: DocumentBucket }
  | { kind: "s3"; config: S3Config };

function resolveBackend(): Backend | null {
  const bucket = getDocumentBucket();
  if (bucket) return { kind: "binding", bucket };

  const config = readS3Config();
  if (config) return { kind: "s3", config };

  return null;
}

/** Whether document storage is usable in this environment. */
export function isStorageConfigured(): boolean {
  return resolveBackend() !== null;
}

/**
 * The message shown when storage is unbound.
 *
 * Centralised so the four routes that can hit this condition say the same
 * actionable thing rather than four different vague ones.
 */
export const STORAGE_UNCONFIGURED_MESSAGE =
  "File storage is not configured for this deployment. " +
  "Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY " +
  "(all four), or bind an R2 bucket on Cloudflare. See docs/RAILWAY-DEPLOY.md.";

/* ------------------------------------------------------------------ */
/* OPERATIONS                                                          */
/* ------------------------------------------------------------------ */

export type StoredObject = {
  size: number;
  body: ReadableStream;
  contentType: string | null;
};

/**
 * Fetch an object for streaming back to a caller.
 *
 * ⚠️ DOES NOT AUTHORISE ANYTHING. The caller must already have established
 * who is asking and that the key belongs to their tenant. This function
 * exists below that decision, not around it.
 */
export async function getStoredObject(key: string): Promise<StoredObject | null> {
  const backend = resolveBackend();
  if (!backend) return null;

  if (backend.kind === "s3") return s3Get(backend.config, key);

  const object = await backend.bucket.get(key);
  if (!object) return null;

  return {
    size: object.size,
    body: object.body,
    contentType: object.httpMetadata?.contentType ?? null,
  };
}

/** True when an object already exists at `key`. Used to refuse overwrites. */
export async function objectExists(key: string): Promise<boolean> {
  const backend = resolveBackend();
  if (!backend) return false;

  if (backend.kind === "s3") return (await s3Head(backend.config, key)) !== null;
  return (await backend.bucket.head(key)) !== null;
}

/**
 * Write an object.
 *
 * Returns the size R2 actually stored, which is the only trustworthy figure:
 * a client's declared `Content-Length` is a claim, and the quota system bills
 * against reality.
 */
export async function putStoredObject(
  key: string,
  body: ReadableStream | ArrayBuffer,
  contentType: string,
  /**
   * ⚠️ OPTIONAL FOR THE BINDING, EFFECTIVELY REQUIRED FOR S3.
   *
   * The R2 binding accepts a stream of unknown length. A signed S3 PUT
   * needs a `Content-Length`. The upload route already has the figure —
   * it validated it against the ticket ceiling — so it passes it through
   * rather than making the storage layer buffer to find out.
   */
  contentLength?: number,
): Promise<{ size: number } | null> {
  const backend = resolveBackend();
  if (!backend) return null;

  if (backend.kind === "s3") {
    return s3Put(backend.config, key, body, contentType, contentLength);
  }

  const result = await backend.bucket.put(key, body, { httpMetadata: { contentType } });
  return result ? { size: result.size } : null;
}

/**
 * Delete an object.
 *
 * R2 `delete` is idempotent: removing a key that is not there is a success,
 * not an error. That is the behaviour `deleteDocument()` wants — a retry
 * after a partial failure must be able to complete rather than dead-lock on
 * bytes that are already gone.
 */
export async function deleteStoredObject(key: string): Promise<void> {
  const backend = resolveBackend();
  if (!backend) {
    throw new Error(STORAGE_UNCONFIGURED_MESSAGE);
  }

  if (backend.kind === "s3") {
    await s3Delete(backend.config, key);
    return;
  }
  await backend.bucket.delete(key);
}
