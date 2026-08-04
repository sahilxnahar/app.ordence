/**
 * Ordence — Document Storage Validation
 * Version: v0.8.0-alpha
 *
 * Shared by the upload route, the server actions and the client vault, so
 * all three agree on what a legal upload is. Lives outside any
 * `"use server"` file because such files may only export async functions.
 */

import { z } from "zod";

export const DOCUMENT_ENTITY_TYPES = [
  "contract",
  "asset",
  "deal",
  "contact",
  "company",
] as const;

export type DocumentEntityTypeInput = (typeof DOCUMENT_ENTITY_TYPES)[number];

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE IS AN ALLOWLIST AND NOT A BLOCKLIST
 * ══════════════════════════════════════════════════════════════════════
 * A blocklist ("no .exe, no .sh") loses to the first extension nobody
 * thought of, and there are thousands. An allowlist fails closed: a type
 * that is not named here cannot be uploaded, and adding one is a deliberate
 * act.
 *
 * `text/html` and `image/svg+xml` are deliberately ABSENT even though they
 * are ordinary, harmless-looking document types. Both can carry executable
 * script. Served from a domain a user is logged into, they become stored
 * cross-site scripting — the uploader ends up running code in a colleague's
 * session. SVG in particular is a favourite because it reads as "an image".
 */
export const ALLOWED_MIME_TYPES = [
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "text/plain",
  "text/csv",
  // Images (raster only — see the note above on SVG)
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/tiff",
  // Archives
  "application/zip",
] as const;

/** Extensions matching the allowlist, used for the file picker's `accept`. */
export const ALLOWED_EXTENSIONS = [
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".rtf", ".txt", ".csv",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".tif", ".tiff",
  ".zip",
] as const;

/**
 * 50 MB per file.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY 50 MB IS SAFE ON CLOUDFLARE (v0.21.0)
 * ══════════════════════════════════════════════════════════════════════
 * On Cloudflare the bytes DO pass through our Worker, so the platform's
 * request-body cap now applies to us where it never did before. That cap is
 * 100 MB on the Free and Pro zone plans — twice this ceiling, so a 50 MB
 * file has head-room, and a file that exceeds 50 MB is refused by our own
 * check with a message rather than by the edge with an opaque 413.
 *
 * ⚠️ RAISING THIS ABOVE 100 MB WOULD NOT WORK. The refusal would move from
 * our code (a sentence the user can act on) to Cloudflare's (a bare 413
 * nobody can explain). Raising it needs a Business/Enterprise zone plan, or
 * a switch to R2 multipart uploads.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Vercel's request body limit.
 *
 * Retained because the Vercel build still works and the UI quotes it there.
 * It is NOT the binding constraint on Cloudflare — see MAX_FILE_BYTES.
 */
export const VERCEL_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;

/**
 * The JSON envelope the client sends to `/api/upload` as `clientPayload`.
 * The route re-validates it — a client payload is user input, however
 * friendly the component that produced it.
 */
export const uploadClientPayloadSchema = z.object({
  entityType: z.enum(DOCUMENT_ENTITY_TYPES),
  entityId: z.string().uuid("Invalid record identifier."),
  fileName: z.string().trim().min(1).max(400),
  sizeBytes: z.number().int().min(1).max(MAX_FILE_BYTES),
  /**
   * ⚠️ ADDED IN v0.21.0 AND IT IS NOT COSMETIC.
   *
   * Vercel Blob enforced the content-type allowlist for us, because it held
   * the upload token. Cloudflare R2 does not — the bytes come back through
   * our own Worker. The declared type therefore has to be stated here,
   * checked against `ALLOWED_MIME_TYPES` by `/api/upload`, and PINNED into
   * the signed ticket so `/api/upload/put` can refuse a body that arrives
   * claiming something else.
   *
   * Required, not optional. An optional field here would silently disable the
   * allowlist for any caller that omitted it — which is precisely the shape
   * of bug that turns "no SVG uploads" into stored XSS.
   */
  contentType: z.string().trim().min(1).max(200),
});

export type UploadClientPayload = z.infer<typeof uploadClientPayloadSchema>;

/** What `saveDocumentRecord` accepts once the browser's upload has finished. */
export const saveDocumentSchema = z.object({
  entityType: z.enum(DOCUMENT_ENTITY_TYPES),
  entityId: z.string().uuid("Invalid record identifier."),
  fileName: z.string().trim().min(1).max(400),
  fileUrl: z.string().url("Invalid file URL."),
  blobPathname: z.string().trim().min(1).max(1024),
  sizeBytes: z.number().int().min(1).max(MAX_FILE_BYTES),
  mimeType: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});

export type SaveDocumentInput = z.input<typeof saveDocumentSchema>;

/* ------------------------------------------------------------------ */
/* FILENAME SAFETY                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reduce a user-supplied filename to something safe to place in a storage
 * path and in a `Content-Disposition` header.
 *
 * What this defends against, concretely:
 *
 *   `../../../etc/passwd`      → path traversal out of the tenant prefix
 *   `report<U+202E>gnp.exe`     → a right-to-left override making an
 *                                 executable read as "reportexe.png"
 *   `invoice"; rm -rf /`        → header and shell injection
 *   a 900-character name        → storage keys that break at the edge
 *
 * Note this sanitises the STORAGE PATH. The original name is kept intact in
 * the `file_name` column so the user still sees what they uploaded — it is
 * escaped at render time, never trusted as markup.
 */
export function sanitizeFileName(input: string): string {
  const base = input
    // Strip any directory component — both separators, both platforms.
    .replace(/^.*[\\/]/, "")
    // Control characters and Unicode bidirectional overrides.
    //
    // These are written as EXPLICIT ESCAPES, never as literal bytes. A
    // regex containing raw control characters is invisible in review,
    // survives copy-paste badly, and can silently stop matching — this
    // codebase has already shipped that bug once, in the URL sanitiser.
    //
    // \u202A-\u202E and \u2066-\u2069 are the bidi overrides that let
    // "report\u202Egnp.exe" render as "reportexe.png".
    .replace(
      /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
      "",
    )
    // Anything outside a conservative allowlist becomes an underscore.
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // Collapse runs, and leading dots that would make a hidden file.
    .replace(/_{2,}/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200);

  return base.length > 0 ? base : "file";
}

/**
 * Build the blob storage path.
 *
 * The tenant id is the FIRST segment. That is not decoration: it means every
 * object is namespaced by tenant at the storage layer, so a bug in path
 * construction produces a broken path rather than one tenant's file landing
 * inside another tenant's prefix.
 *
 * The timestamp prevents two uploads of "scan.pdf" from colliding, without
 * relying on the storage provider's random-suffix behaviour.
 */
export function buildBlobPathname(params: {
  tenantId: string;
  entityType: string;
  entityId: string;
  fileName: string;
  now: number;
}): string {
  const safe = sanitizeFileName(params.fileName);
  return `tenants/${params.tenantId}/${params.entityType}/${params.entityId}/${params.now}-${safe}`;
}

/**
 * Confirm a stored pathname really sits inside a tenant's prefix.
 *
 * Used as a defence-in-depth check before deleting or streaming an object:
 * even if a row were somehow tampered with, we refuse to touch bytes that do
 * not live under the requesting tenant's namespace.
 */
export function pathnameBelongsToTenant(pathname: string, tenantId: string): boolean {
  if (pathname.includes("..")) return false;
  return pathname.startsWith(`tenants/${tenantId}/`);
}

/** Human-readable size. `1536` → `1.5 KB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/** True if the browser-reported type is one we accept. */
export function isAllowedMimeType(mimeType: string): boolean {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}
