/**
 * Ordence — The browser half of a logo upload
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO SECOND UPLOAD MECHANISM HERE
 * ══════════════════════════════════════════════════════════════════════
 * The product already has one: POST `/api/upload` authorises the file and
 * returns a SIGNED TICKET pinning the path, the content type and a byte
 * ceiling; PUT `/api/upload/put` presents the ticket with the session
 * cookie and streams the bytes into R2, re-checking every pinned value
 * and sniffing the magic bytes.
 *
 * This module calls those two routes and nothing else. A second uploader
 * would be a second place a file can arrive without the rate limit, the
 * quota, the allowlist, the magic-byte check and the tenant-prefixed
 * path — that is, a second thing to secure, and the one that gets
 * forgotten.
 *
 * ⚠️ WHAT IS DIFFERENT FROM `components/crm/document-vault.tsx`: step 3.
 * The vault then calls `saveDocumentRecord()` to file a row in
 * `documents`. A logo is not a document — it is not in the vault, not in
 * retention, not in the recycle bin — so this stops at the object key and
 * hands it to `updateBranding`, which is what stores it.
 */

/** What `/api/upload` answers. Mirrors the route's response. */
type UploadTicketResponse = {
  uploadUrl: string;
  ticket: string;
  pathname: string;
  expiresAt: number;
  maxBytes: number;
};

/**
 * The types a logo may be.
 *
 * ⚠️ A SUBSET OF `ALLOWED_MIME_TYPES`, NOT AN EXTENSION OF IT. Narrowing
 * an allowlist locally is safe; widening one is not, and nothing here
 * widens anything — `/api/upload` re-applies the full list regardless.
 *
 * 🔴 SVG IS ABSENT AND THAT IS DELIBERATE, even though it is the format a
 * designer will hand the customer. An SVG can carry script, and this
 * particular image is rendered on the SIGN-IN PAGE of the workspace,
 * before any session exists. It is the worst possible place in the
 * product for stored XSS. `lib/validators/storage.ts` refuses it for the
 * whole product and this wave does not argue with that.
 */
export const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export const LOGO_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";

/** 2 MB. A logo larger than this is a photograph somebody has mislabelled. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function describeLogoRefusal(file: File): string | null {
  if (!(LOGO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "Use a PNG, JPEG, WebP or GIF. SVG is not accepted — it can carry script, and this image is shown on your sign-in page.";
  }
  if (file.size > MAX_LOGO_BYTES) {
    return "That file is larger than 2 MB. A logo this size is usually a photograph — export it at around 400 pixels wide.";
  }
  return null;
}

async function errorMessageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error.trim()) return body.error;
  } catch {
    /* not JSON */
  }
  return fallback;
}

/**
 * Upload the logo and return the R2 object key.
 *
 * `tenantId` is used only as the ticket request's `entityId`; the PATH is
 * built server-side from the session's tenant, so a caller that lied
 * about it gets a key inside its own prefix anyway — and `updateBranding`
 * refuses any key that is not.
 */
export async function uploadLogo(args: { file: File; tenantId: string }): Promise<string> {
  const ticketResponse = await fetch("/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      entityType: "branding",
      entityId: args.tenantId,
      fileName: args.file.name,
      sizeBytes: args.file.size,
      contentType: args.file.type,
    }),
  });

  if (!ticketResponse.ok) {
    throw new Error(await errorMessageFrom(ticketResponse, "Could not authorise that upload."));
  }

  const ticket = (await ticketResponse.json()) as UploadTicketResponse;

  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "x-ordence-upload-ticket": ticket.ticket,
      "content-type": args.file.type,
    },
    body: args.file,
  });

  if (!put.ok) {
    throw new Error(await errorMessageFrom(put, "Could not store that logo."));
  }

  /*
   * The KEY, not the URL the route also returns. That URL is an
   * `r2://` reference for the `documents.file_url` column, which this
   * path does not write.
   */
  return ticket.pathname;
}

/**
 * Pull the pixels out of an image file, downscaled.
 *
 * ⚠️ DOWNSCALED TO 96px ON PURPOSE. Counting every pixel of a 2 MB PNG
 * on the main thread stalls the tab for long enough to be noticed, and
 * the answer does not change: the dominant colours of a logo survive a
 * bilinear downscale, and the ones that do not survive it are the ones
 * too rare to be a brand.
 *
 * Returns `null` rather than throwing when the browser cannot decode the
 * file — the screen then simply offers no suggestions and lets the person
 * keep the product colour, which is a working screen.
 */
export async function readImagePixels(file: File): Promise<Uint8ClampedArray | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => resolve(null);
      element.src = url;
    });
    if (!image) return null;

    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;

    context.drawImage(image, 0, 0, size, size);
    return context.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
