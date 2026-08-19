/**
 * Ordence — ⭐⭐ THE CONTENT DIGEST PRINTED ON EVERY REGISTER
 * Version: v1.50.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT IT IS FOR, WHICH IS NOT SECURITY
 * ══════════════════════════════════════════════════════════════════════
 * Two printouts of "Wage register — April 2026" sitting on a desk. Are
 * they the same document? Today the only way to answer is to read both
 * of them, column by column, and people do not. The digest answers it in
 * five seconds.
 *
 * ⚠️ THIS IS A CHANGE DETECTOR, NOT A TAMPER-PROOF SEAL. Anybody who can
 * change the data can regenerate the document and get a matching digest
 * for the new figures. It catches the case that actually happens —
 * nobody meaning any harm, a run cancelled and re-run, a document
 * quietly not being the one that was produced last quarter. The audit
 * chain in `lib/audit/chain.ts` is the thing that answers the malicious
 * question, and it is a different mechanism for a different reader.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY FNV-1a AND NOT SHA-256
 * ══════════════════════════════════════════════════════════════════════
 * `crypto.subtle.digest` is async, is not present in every runtime this
 * code compiles for, and would make a pure formatting function
 * asynchronous all the way up through the builders. FNV-1a over BigInt
 * is twelve lines, synchronous, isomorphic, and deterministic on every
 * runtime — which is the only property a change detector needs.
 *
 * 🔴 IT IS NOT A CRYPTOGRAPHIC HASH AND MUST NEVER BE USED AS ONE. If
 * somebody later wants a seal rather than a detector, that is a
 * different function with a different name, not a swap behind this one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 CANONICALISATION IS THE PART THAT IS EASY TO GET WRONG
 * ══════════════════════════════════════════════════════════════════════
 * `JSON.stringify(rows)` is NOT canonical: object key order follows
 * insertion order, so the same figures assembled by two code paths hash
 * differently and the document reports a change that did not happen. A
 * digest with false positives is a digest people learn to ignore.
 *
 * So: columns in declared order, cells looked up BY COLUMN ID in that
 * same order, `null` encoded distinctly from the empty string, and every
 * field length-prefixed so that ["ab","c"] and ["a","bc"] cannot collide.
 */

import type { RegisterCell, RegisterRow } from "./document";
import type { RegisterColumn } from "./spec";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/**
 * ⚠️ HASHES THE UTF-8 CODE UNITS, NOT THE CODE POINTS. Employee names in
 * this product are routinely Devanagari, Kannada and Tamil, and a hash
 * that walked `charCodeAt` would still be deterministic — but encoding
 * once, here, means the digest is stable if this ever needs to be
 * reproduced outside JavaScript.
 */
function fnv1a64(text: string): bigint {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/**
 * ⭐ LENGTH-PREFIXED, NULL-DISTINGUISHED, COLUMN-ORDERED.
 *
 * `~` marks a not-recorded cell and cannot be confused with a cell whose
 * text is "~", because that cell is written as `1:~` and the null is
 * written as `~` alone.
 */
function encodeCell(cell: RegisterCell): string {
  if (cell === null) return "~";
  return `${cell.length}:${cell}`;
}

export function canonicalise(args: {
  readonly kind: string;
  readonly formNumber: string | null;
  readonly ruleSetId: string;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly columns: readonly RegisterColumn[];
  readonly rows: readonly RegisterRow[];
}): string {
  const parts: string[] = [
    `k=${args.kind}`,
    `f=${args.formNumber ?? "~"}`,
    `r=${args.ruleSetId}`,
    `p=${args.periodFrom ?? "~"}..${args.periodTo ?? "~"}`,
    `c=${args.columns.map((c) => `${c.id}|${c.label}`).join("")}`,
  ];

  for (const row of args.rows) {
    /**
     * ⚠️ THE ROW KEY IS PART OF THE DIGEST. Two documents with identical
     * figures for different employees — which happens on a small payroll
     * where three people are on the same salary — must not collide.
     */
    const cells = args.columns.map((c) => encodeCell(row.cells[c.id] ?? null));
    parts.push(`row=${row.key}${cells.join("")}`);
  }

  return parts.join("");
}

/**
 * ⭐ THE DIGEST AS PRINTED: sixteen lowercase hex characters, grouped in
 * fours, because a human is going to compare it against a printout by
 * eye and unbroken hex is where that goes wrong.
 */
export function digestOf(args: Parameters<typeof canonicalise>[0]): string {
  const hex = fnv1a64(canonicalise(args)).toString(16).padStart(16, "0");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}
