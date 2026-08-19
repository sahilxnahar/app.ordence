/**
 * Ordence — ⭐⭐ Deterministic Voucher Identity
 * Version: v0.37.0-alpha
 *
 * Pure. `node:crypto` only, exactly as `lib/documents/render.ts` does —
 * Node runtime, no database, no `server-only`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE FILE THAT STOPS APRIL BEING IMPORTED TWICE
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TALLY DOES NOT DE-DUPLICATE ANYTHING.
 *
 * Import a file, notice a ledger was misnamed, fix the mapping, import
 * the same period again — and Tally adds every voucher a second time. It
 * does not compare voucher numbers, dates or amounts. Both copies are
 * balanced, so the trial balance still balances. The turnover is simply
 * double, and nothing anywhere says so.
 *
 * The single exception is `REMOTEID`. It is the field Tally's own
 * synchronisation uses to recognise a voucher that originated outside the
 * company, and given the same REMOTEID with `ACTION="Alter"` Tally
 * UPDATES the voucher in place instead of adding one.
 *
 * ⭐ SO THE REMOTEID IS THE ONLY THING STANDING BETWEEN A RE-EXPORT AND A
 * DOUBLED SET OF BOOKS, AND IT MUST THEREFORE BE PERFECTLY STABLE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THE KEY IS DERIVED FROM, AND — MORE IMPORTANTLY — WHAT IT IS
 * NOT
 * ══════════════════════════════════════════════════════════════════════
 * IN:  tenant id, voucher type, source type, source id.
 *
 * OUT — and every one of these was a tempting inclusion:
 *
 *   ✗ THE AMOUNT. A corrected invoice must keep the key of the invoice it
 *     corrects. Include the amount and every correction is a NEW voucher
 *     in Tally sitting beside the wrong one, which is the exact failure
 *     the key exists to prevent, arriving through the door marked "we
 *     fixed it".
 *   ✗ THE DATE. Same argument. A bill re-dated from 31 March to 1 April
 *     is one bill.
 *   ✗ THE BATCH ID. The key must be the SAME in April's export and in
 *     June's re-export of April. Including the batch guarantees it is not.
 *   ✗ A TIMESTAMP, A COUNTER, `randomUUID()`. Each of these produces a
 *     key that is unique — which is the opposite of what is wanted. A
 *     unique key per export IS the double post.
 *   ✗ THE LEDGER NAMES. Re-pointing a mapping from "Sales A/c" to "Sales
 *     Account" must ALTER the existing vouchers, not create a parallel
 *     set under the new name.
 *
 * ⚠️ THE TENANT ID IS IN, AND IT IS NOT OPTIONAL. Two workspaces
 * exporting into the same Tally company — a group with a shared accounts
 * department, which is common — would otherwise collide on identical
 * source ids and each would ALTER the other's vouchers.
 *
 * ⭐ AND SQL 0026 §6 ENFORCES IT AT THE DATABASE. If a source row has
 * already been exported under one key, a second, different key for it is
 * REFUSED. This file could be rewritten tomorrow by somebody who has not
 * read this comment; the trigger cannot be bypassed by rewriting it.
 */

import { createHash } from "node:crypto";
import type { TallyVoucherType } from "@/db/schema/tally";

/* ------------------------------------------------------------------ */
/* HASHING                                                             */
/* ------------------------------------------------------------------ */

/** SHA-256, lower-case hex. The same primitive Phase 8 uses for documents. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE REMOTE ID                                                    */
/* ------------------------------------------------------------------ */

export type VoucherIdentity = {
  tenantId: string;
  voucherType: TallyVoucherType;
  /** `purchase_invoice`, `gst_invoice`, `transaction`, `tds_challan`, … */
  sourceType: string;
  sourceId: string;
};

/**
 * The prefix. Present so that a human staring at a Tally voucher's remote
 * id can tell where it came from — which is the question when two systems
 * have both been posting into one company.
 */
export const REMOTE_ID_PREFIX = "AHOS";

/**
 * ⭐⭐ THE DETERMINISTIC KEY.
 *
 * Shape: `AHOS-<8 hex of tenant>-<8 hex of type>-<24 hex of source>`.
 * 4 + 1 + 8 + 1 + 8 + 1 + 24 = 47 characters, comfortably inside the
 * `varchar(64)` column and inside what Tally accepts.
 *
 * ⚠️ THE THREE SEGMENTS ARE HASHED SEPARATELY AND NOT AS ONE STRING, on
 * purpose. A single `sha256(tenant + type + source)` is vulnerable to the
 * oldest concatenation bug there is: `("ab", "c")` and `("a", "bc")`
 * produce the same digest. Source types are chosen by us and would
 * probably never collide — "probably never" is not a property one wants
 * on the field that decides whether a month of revenue is posted twice.
 *
 * ⚠️ AND IT IS NOT REVERSIBLE, WHICH IS ALSO DELIBERATE. Putting the
 * source id in plainly would publish an internal identifier into a file
 * that is emailed around, and a Tally company is read by the auditor, the
 * bank and whoever else asks.
 */
export function deterministicRemoteId(identity: VoucherIdentity): string {
  const tenant = sha256Hex(`tenant:${identity.tenantId}`).slice(0, 8);
  const type = sha256Hex(`vtype:${identity.voucherType}`).slice(0, 8);
  const source = sha256Hex(
    `source:${identity.sourceType}:${identity.sourceId}`,
  ).slice(0, 24);
  return `${REMOTE_ID_PREFIX}-${tenant}-${type}-${source}`;
}

/** True when a string looks like one of ours. Used by the reconciliation. */
export function isOurRemoteId(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^AHOS-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{24}$/.test(value.trim());
}

/* ------------------------------------------------------------------ */
/* ⭐ THE CONTENT HASH                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT THE VOUCHER SAYS, HASHED — the complement of the remote id.
 *
 * The remote id answers "which voucher is this?". The content hash
 * answers "has it changed since we last sent it?", and the pair is what
 * makes a re-export honest:
 *
 *   same id, same hash      → nothing moved. Safe to re-send as an ALTER,
 *                             and safe to leave out of the file entirely.
 *   same id, different hash → ⭐ somebody amended the source. This is the
 *                             voucher the accountant needs told about.
 *   new id                  → genuinely new.
 *
 * ⚠️ WITHOUT IT, THE ONLY HONEST ANSWER TO "WHAT CHANGED?" IS "RE-IMPORT
 * EVERYTHING", and re-importing everything is how an ALTER of two
 * thousand unchanged vouchers overwrites two thousand narrations the
 * accountant edited by hand.
 *
 * ⚠️ THE INPUT IS CANONICALISED — fields in a fixed order, amounts as
 * decimal strings, legs sorted. `JSON.stringify` of an object literal
 * depends on insertion order, so a refactor that reorders two fields
 * would change every hash in the database and report the entire ledger as
 * amended.
 */
export type HashableVoucher = {
  voucherType: string;
  voucherDate: string;
  voucherNumber?: string | null;
  partyLedgerName?: string | null;
  partyGstin?: string | null;
  placeOfSupplyCode?: string | null;
  narration?: string | null;
  reference?: string | null;
  isCancelled?: boolean;
  entries: Array<{
    ledgerName: string;
    isDebit: boolean;
    amountMinor: bigint | string;
    costCentres?: Array<{ category: string; name: string; amountMinor: bigint | string }>;
    hsnSac?: string | null;
    gstRateBps?: number | null;
  }>;
};

export function voucherContentHash(voucher: HashableVoucher): string {
  const legs = voucher.entries
    .map((entry) => {
      const centres = (entry.costCentres ?? [])
        .map((c) => `${c.category}${c.name}${String(c.amountMinor)}`)
        .sort()
        .join("");
      return [
        entry.ledgerName,
        entry.isDebit ? "D" : "C",
        String(entry.amountMinor),
        entry.hsnSac ?? "",
        entry.gstRateBps === null || entry.gstRateBps === undefined
          ? ""
          : String(entry.gstRateBps),
        centres,
      ].join("");
    })
    /**
     * ⚠️ SORTED, BECAUSE THE ORDER OF THE LEGS IS NOT ACCOUNTING
     * INFORMATION. Dr Cement / Cr Vendor and Cr Vendor / Dr Cement are
     * the same voucher, and a hash that disagreed would report a
     * difference every time the builder's iteration order changed.
     */
    .sort()
    .join("");

  const canonical = [
    voucher.voucherType,
    voucher.voucherDate,
    voucher.voucherNumber ?? "",
    voucher.partyLedgerName ?? "",
    voucher.partyGstin ?? "",
    voucher.placeOfSupplyCode ?? "",
    voucher.narration ?? "",
    voucher.reference ?? "",
    voucher.isCancelled ? "cancelled" : "live",
    legs,
  ].join("");

  return sha256Hex(canonical);
}

/**
 * ⭐ The hash of the file as sent. Stored on `tally_export_batches`, so
 * "is the file in my downloads folder the one you think you sent?" has an
 * answer that is not a guess about timestamps.
 */
export function payloadHash(xml: string): string {
  return sha256Hex(xml);
}
