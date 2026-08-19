import "server-only";

/**
 * Ordence — ⭐⭐ FETCHING A REVISION'S FILE BACK OUT OF STORAGE
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE SIZE CEILING IS THE POINT OF THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * A DXF is text, and a large site plan is genuinely 40MB of it. Reading
 * one into a string on the server, base64-ing it and sending it to a
 * browser is ~55MB across the wire and two copies in memory at each end.
 *
 * 🔴 SO IT IS REFUSED ABOVE A STATED SIZE, WITH THE SIZE IN THE MESSAGE,
 * rather than attempted and killed by the platform halfway. A request
 * that dies at 30MB looks like the product being broken; a sentence
 * naming 12MB and suggesting the sheet rather than the model is something
 * a drafter can act on in their own software.
 */

import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { drawingRevisions } from "@/db/schema/drawings";
import { documents } from "@/db/schema/storage";
import { DrawingError } from "./register";
import { getStoredObject, STORAGE_UNCONFIGURED_MESSAGE } from "@/lib/storage/r2";

/** ⚠️ Twelve megabytes of DXF is roughly a 200,000-entity drawing. */
export const MAX_VIEWABLE_BYTES = 12 * 1024 * 1024;

export async function readRevisionSource(
  tenantId: string,
  revisionId: string,
): Promise<string> {
  const row = await withTenant(tenantId, async (tx) => {
    const [found] = await tx
      .select({
        pathname: documents.blobPathname,
        sizeBytes: documents.sizeBytes,
        fileName: documents.fileName,
        sourceFormat: drawingRevisions.sourceFormat,
      })
      .from(drawingRevisions)
      .innerJoin(documents, eq(documents.id, drawingRevisions.documentId))
      .where(
        and(eq(drawingRevisions.tenantId, tenantId), eq(drawingRevisions.id, revisionId)),
      );
    return found ?? null;
  });

  if (!row) {
    throw new DrawingError("That revision is not in this workspace.");
  }
  if (row.sourceFormat !== "dxf") {
    throw new DrawingError(
      `This revision is a ${row.sourceFormat.toUpperCase()}, which Ordence stores and does not ` +
        `draw. Download it to open it in the program that made it.`,
    );
  }
  if (Number(row.sizeBytes) > MAX_VIEWABLE_BYTES) {
    throw new DrawingError(
      `"${row.fileName}" is ${(Number(row.sizeBytes) / 1024 / 1024).toFixed(0)} MB, and Ordence ` +
        `draws files up to ${MAX_VIEWABLE_BYTES / 1024 / 1024} MB in a browser. It is stored and ` +
        `downloadable. A file this size is usually the whole model rather than one sheet — ` +
        `exporting the layout you need produces a DXF an order of magnitude smaller and opens ` +
        `here.`,
    );
  }

  /**
   * ⚠️ `getStoredObject` AUTHORISES NOTHING — it says so in its own
   * header. Every check above this line is what makes the key safe to
   * ask for: the revision was found INSIDE `withTenant`, so RLS proved it
   * belongs to this workspace, and the pathname came from that row rather
   * than from the caller.
   */
  const object = await getStoredObject(row.pathname);
  if (!object) {
    throw new DrawingError(
      `The file for this revision is recorded and could not be read back from storage. ` +
        `${STORAGE_UNCONFIGURED_MESSAGE}`,
    );
  }

  /**
   * ⚠️ THE SIZE IS CHECKED AGAIN, against what storage actually holds.
   * `documents.size_bytes` is what was recorded at upload; a mismatch
   * means one of the two is wrong, and streaming an unbounded body into a
   * string on the strength of a stale number is how a page dies.
   */
  if (object.size > MAX_VIEWABLE_BYTES) {
    throw new DrawingError(
      `The stored file for this revision is ${(object.size / 1024 / 1024).toFixed(0)} MB, beyond ` +
        `the ${MAX_VIEWABLE_BYTES / 1024 / 1024} MB Ordence draws in a browser.`,
    );
  }

  const buffer = await new Response(object.body).arrayBuffer();
  return new TextDecoder("utf-8").decode(buffer);
}
