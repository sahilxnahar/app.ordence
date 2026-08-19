/**
 * Ordence — ⭐ THE ROW SHAPES BOTH SIDES SHARE
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE ARE NOT IN `server/cad/register.ts`
 * ══════════════════════════════════════════════════════════════════════
 * `check:boundaries` refused the first draft of `markup-list.tsx`, which
 * is a client component and imported its row type from the server module:
 *
 *     app/(crm)/drawings/[id]/markup-list.tsx is "use client" and imports
 *     @/server/cad/register, which is server-only.
 *
 * ⚠️ AND `import type` WOULD NOT HAVE MADE IT SAFE, only invisible. The
 * import is erased at compile time today; the moment somebody adds a
 * value to that import line — a helper, a constant — a server module with
 * a database client in it is in the browser bundle, and nothing would
 * have failed until then.
 *
 * ⭐ SO THE SHAPES LIVE HERE, WHERE BOTH SIDES MAY IMPORT THEM, and the
 * server module re-exports them so its own callers are unchanged.
 */

export type DrawingRow = {
  readonly id: string;
  readonly drawingNumber: string;
  readonly title: string;
  readonly discipline: string;
  readonly status: string;
  readonly currentRevisionId: string | null;
  readonly currentRevision: string | null;
  readonly revisionCount: number;
  readonly openMarkups: number;
  /**
   * ⭐ WHETHER ANYTHING CAN BE MEASURED OFF THIS SHEET YET. The second
   * most important column in the register, after "which revision".
   */
  readonly unitKnown: boolean;
};

export type RevisionRow = {
  readonly id: string;
  readonly revision: string;
  readonly revisionOrder: number;
  readonly documentId: string;
  readonly sourceFormat: string;
  readonly entityCount: number;
  readonly layerCount: number;
  /** 🔴 What Ordence could not read, by name. `{"HATCH": 412}`. */
  readonly unsupported: Record<string, number>;
  readonly declaredUnit: string | null;
  readonly assumedUnit: string | null;
  readonly supersededAt: Date | null;
  readonly receivedAt: Date;
  readonly notes: string | null;
};

export type MarkupRow = {
  readonly id: string;
  readonly kind: string;
  /** ⚠️ In drawing units, never screen pixels. */
  readonly points: { x: number; y: number }[];
  readonly body: string | null;
  readonly colour: string;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
};

export type MeasurementRow = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly layer: string | null;
  /** ⭐ In SI, always. */
  readonly valueSi: number;
  readonly maxErrorSi: number;
  readonly isExact: boolean;
  readonly unitBasis: string;
  readonly unitWasAssumed: boolean;
  readonly takenAt: Date;
};
