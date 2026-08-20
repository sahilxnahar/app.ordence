/**
 * Ordence — 🔴 THE FILE'S FINGERPRINT, TAKEN IN THE BROWSER
 * Version: v1.89.0-alpha · Wave 2A
 *
 * ══════════════════════════════════════════════════════════════════════
 * WITHOUT THIS, TWO TABS START TWO RUNS OVER ONE FILE
 * ══════════════════════════════════════════════════════════════════════
 * `startImportRun` keys a run on (workspace, entity, fingerprint) so that
 * the second attempt at the same file RESUMES the first instead of
 * beginning a rival one. In `update` mode two rival runs cannot both be
 * undone: the second captures the FIRST run's values as the "prior", so
 * undoing run 2 restores the migration and undoing run 1 afterwards
 * destroys what run 2 put back. There is no order in which the customer
 * can be told what will happen.
 *
 * `beginImportRun` therefore REQUIRES the fingerprint and refuses
 * anything that is not `sha256:<64 lower-case hex>`. It has required it
 * since Phase 2 and nothing has ever sent it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ OVER THE BYTES — NOT THE PARSED RECORDS, AND NOT THE NAME
 * ══════════════════════════════════════════════════════════════════════
 * A customer who fixes one cell and re-uploads has a DIFFERENT file and
 * deserves a different run. A customer who renames the file has not.
 *
 * ⭐ AND THAT IS ALSO WHY IT IS TAKEN OVER THE BYTES RATHER THAN AFTER
 * READING: choosing a different sheet of the same workbook, or correcting
 * a column mapping, rewrites the records this wizard holds and must not
 * start a second migration over the same upload.
 *
 * 🔴 A FINGERPRINT OVER THE FILE NAME WOULD BE IDEMPOTENCY THAT IS
 * PRESENT AND INERT — a key that never collides, a claim that is always
 * "new", and a screen that never says "resumed". That is this codebase's
 * characteristic defect in one line, which is why the shape is checked in
 * three places: here, in `startImportRun`, and by the database constraint
 * `import_runs_fingerprint_shape`.
 *
 * ⚠️ THE BYTES DO NOT LEAVE THE MACHINE. WebCrypto hashes locally; the
 * server receives 64 hex characters and never the file.
 */

/** The shape `beginImportRun` and the database both refuse anything else. */
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class FingerprintUnavailableError extends Error {
  constructor() {
    super(
      "Your browser could not fingerprint this file, so the migration was not started. " +
        "Without it, uploading the same file twice would start two migrations that cannot " +
        "both be undone. This needs a secure connection (https) — if you are on one, please " +
        "tell support which browser you are using.",
    );
    this.name = "FingerprintUnavailableError";
  }
}

/**
 * ⚠️ `crypto.subtle` IS ABSENT ON AN INSECURE ORIGIN, and the failure is
 * a `TypeError` on a property nobody checked. Refusing by name here means
 * the customer is told the migration did not start, rather than watching
 * `beginImportRun` reject an `undefined` fingerprint with a message about
 * a regular expression.
 */
export async function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new FingerprintUnavailableError();
  /**
   * ⚠️ A FRESH BUFFER, NOT `bytes.buffer`. A `Uint8Array` can be a VIEW
   * onto a larger `ArrayBuffer` — which is exactly what `subarray` and
   * several of the readers in `lib/import/sources/` produce — and hashing
   * the whole underlying buffer would fingerprint bytes the customer's
   * file does not contain, silently, and differently on every path.
   */
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest("SHA-256", copy);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
