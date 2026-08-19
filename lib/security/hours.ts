/**
 * Ordence — ⭐⭐ WHEN "OUT OF HOURS" IS, AND WHAT COUNTS AS BULK
 * Version: v1.77.0-alpha · Wave 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS ITS OWN PURE MODULE AND NOT A CONSTANT IN THE DETECTOR
 * ══════════════════════════════════════════════════════════════════════
 * Two different pieces of code have to agree on these numbers:
 *
 *   THE EMITTER  — `server/export/log.ts`, which decides at the moment of
 *                  an export whether to write `export.bulk` and
 *                  `export.off_hours`.
 *   THE DETECTOR — `server/security/anomalies.ts`, which later correlates
 *                  the two into a finding.
 *
 * Until wave 9 the numbers lived only in the detector, because nothing
 * emitted anything — the detector was both the only reader and the only
 * writer of its own vocabulary, and it read event types that had never
 * been written. Now that there is an emitter, a threshold defined in one
 * of them and re-typed in the other is a guarantee that they will
 * eventually disagree, and the failure would be silent: events emitted at
 * one boundary, correlated at another, findings quietly absent.
 *
 * ⚠️ PURE. No `server-only`, no database, no `next/*`. The detector is
 * server-only and the emitter is server-only, but a shared FACT that both
 * depend on must not inherit either one's runtime.
 */

/**
 * The hour of a timestamp in Asia/Kolkata.
 *
 * Computed by offset rather than by `Intl` because this runs on the Edge
 * and in Node and in a test, and `Intl` timezone data is not guaranteed
 * present in every one of those. IST is UTC+05:30 and has no daylight
 * saving — the one timezone where fixed-offset arithmetic is actually
 * correct.
 */
export function istHour(at: Date): number {
  const istMs = at.getTime() + (5 * 60 + 30) * 60_000;
  return new Date(istMs).getUTCHours();
}

/** IST. 22:00–06:00 is outside every working pattern this product serves. */
export const OFF_HOURS_START_HOUR_IST = 22;
export const OFF_HOURS_END_HOUR_IST = 6;

/** True when the moment falls in the off-hours window (22:00–06:00 IST). */
export function isOffHoursIst(at: Date): boolean {
  const hour = istHour(at);
  return hour >= OFF_HOURS_START_HOUR_IST || hour < OFF_HOURS_END_HOUR_IST;
}

/**
 * Rows in ONE export that make it "bulk".
 *
 * ⚠️ 500 IS A JUDGEMENT AND IT IS DELIBERATELY LOW. A person exporting a
 * filtered list to work on offline is in the tens; a person taking a
 * table is in the thousands. Five hundred sits above ordinary use and far
 * below "the whole customer master", so the event fires on the second
 * kind and not the first.
 *
 * ⚠️ THIS IS A COUNT OF RECORDS, NOT A COUNT OF EVENTS. The distinction
 * cost this codebase a rule: `detectOffHoursBulkExport` compared it
 * against `occurrenceCount`, which is the RECORDER'S COALESCING COUNTER —
 * so one export of fifty thousand rows scored 1 and would never have
 * fired, while five hundred tiny exports inside the coalescing window
 * would have. The comparison is now made HERE, at emission, where the
 * real row count is in hand.
 */
export const BULK_EXPORT_RECORDS = 500;

/** True when an export of this size counts as bulk. */
export function isBulkExport(rowCount: number): boolean {
  return rowCount >= BULK_EXPORT_RECORDS;
}
