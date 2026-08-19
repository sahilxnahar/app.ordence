/**
 * Ordence — ⭐⭐ THE SAME FILE, IMPORTED TWICE
 * Version: v1.64.0-alpha (Batch 0102)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS ALREADY HERE, AND WHY IT IS NOT ENOUGH
 * ══════════════════════════════════════════════════════════════════════
 * `fingerprintOf` in `./match.ts` fingerprints a LINE, and
 * `findDuplicates` REPORTS lines that look like ones already stored. That
 * is deliberate and correct at the line level: two genuinely separate
 * payments of the same amount on the same day do happen, and refusing
 * them would be wrong.
 *
 * ⚠️ BUT IT ONLY EVER WARNED. `importStatement` inserted a fresh
 * `bank_statements` row and every one of its lines regardless, then told
 * the operator afterwards that some of them looked familiar. Somebody
 * who downloads January, imports it, is not sure it worked and imports it
 * again ends up with every January line twice, a warning they have
 * already clicked past, and an account out by exactly the month's
 * turnover.
 *
 * ⭐⭐ A WHOLE FILE IMPORTED TWICE IS A DIFFERENT CLAIM FROM A LINE THAT
 *    LOOKS LIKE ANOTHER LINE, and it can be refused outright without
 *    ever refusing a legitimate import.
 *
 * Two separate months cannot collide: the period is in the digest. Two
 * genuinely different files for the same period cannot collide: the
 * balances and every line fingerprint are in the digest, in order. The
 * ONLY thing that collides with an existing statement is a byte-for-byte
 * equivalent re-import — which is exactly the thing to refuse.
 *
 * ⚠️ `node:crypto` LIVES IN THIS FILE AND NOT IN `./match.ts` OR
 * `./reconciliation.ts`, both of which are isomorphic and are imported by
 * code that renders. A crypto import in one of those would drag Node
 * built-ins into a browser bundle. `lib/tally/keys.ts` draws the same
 * line for the same reason.
 */

import { createHash } from "node:crypto";
import { fingerprintOf, type Minor } from "./match";

export interface DigestInput {
  readonly bankAccountId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly openingBalanceMinor: Minor;
  readonly closingBalanceMinor: Minor;
  readonly lines: ReadonlyArray<{
    valueDate: string;
    amountMinor: Minor;
    narration: string;
  }>;
}

/**
 * ⭐ A HEX SHA-256 OVER THE STATEMENT'S CONTENT, ORDER INCLUDED.
 *
 * ⚠️ THE LINES ARE **NOT** SORTED BEFORE HASHING, ON PURPOSE. Two exports
 * of the same statement come out of the same bank in the same order. A
 * file with the same lines in a different order is a different export and
 * deserves the operator's attention rather than a silent refusal — the
 * line-level duplicate report in `findDuplicates` is what catches that
 * case, and it catches it by warning, which is the right strength for a
 * judgement call.
 *
 * ⚠️ EACH FIELD IS LENGTH-DELIMITED. Concatenating `a|b` and `ab|`
 * without delimiters gives two different statements the same digest, and
 * a duplicate guard with a collision refuses a legitimate import — the
 * failure that gets a guard switched off.
 */
export function statementDigest(input: DigestInput): string {
  const parts: string[] = [
    "ordence-bank-statement-v1",
    input.bankAccountId,
    input.periodFrom,
    input.periodTo,
    input.openingBalanceMinor.toString(),
    input.closingBalanceMinor.toString(),
    String(input.lines.length),
  ];

  for (const line of input.lines) parts.push(fingerprintOf(line));

  const payload = parts.map((p) => `${p.length}:${p}`).join("");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
