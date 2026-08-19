/**
 * Ordence — ⭐⭐⭐ PERMISSIONS THAT ARE DECLARED AND NOT ENFORCED
 * Version: v1.77.0-alpha · Wave 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS LEDGER EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `PERMISSION_CATALOG` in `db/schema/auth.ts` declares 194 keys. A wave 9
 * sweep found ELEVEN that appeared nowhere in the product outside the
 * catalogue and the role templates — not in a guard, not in a wrapper,
 * not in a query. Every one of them was granted to specific roles and
 * withheld from others, which is to say: the role screen described
 * boundaries that did not exist.
 *
 * The four worst were fixed rather than recorded:
 *
 *   assets:read            every asset read ran on a session alone, so a
 *                          custom role built WITHOUT it read assets fine
 *   transactions:read      every member of every workspace could read the
 *   ledgers:read           complete general ledger, trial balance, P&L,
 *                          balance sheet and cash flow statement, while
 *                          the model gives both keys to finance roles only
 *   clauses:read           the negotiated clause bank was readable by
 *                          anybody who could create a contract
 *   contracts:legal_hold   the flag was honoured in five places and
 *                          settable from nowhere in the product
 *   roles:read             had no screen to gate, so one was built
 *
 * The rest are recorded HERE, each with the reason it is not enforced and
 * what would have to exist for it to be. That is the difference between a
 * known gap and a forgotten one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE IS NOT DOCUMENTATION. `scripts/check-permission-reach.mjs`
 * FAILS THE BUILD IN BOTH DIRECTIONS.
 * ══════════════════════════════════════════════════════════════════════
 *   • A catalogue key that appears in no code and is not listed below
 *     fails — that is a new instance of the same defect.
 *   • A key listed below that HAS since appeared in code also fails —
 *     because a stale entry claiming "nothing enforces this" is worse
 *     than no entry at all, and the person who wired it is the only one
 *     who will ever know to remove the line.
 *
 * It is modelled on `lib/entitlements/enforcement.ts`, which does the
 * same job for plan feature keys and was written for the same reason.
 */

export type UnenforcedPermission = {
  /** The catalogue key. */
  readonly key: string;
  /** Which non-wildcard roles hold it today. Empty means owner/admin only. */
  readonly heldBy: readonly string[];
  /** Why nothing checks it, and what would have to exist for something to. */
  readonly reason: string;
};

export const DECLARED_ONLY_PERMISSIONS: readonly UnenforcedPermission[] = [
  {
    key: "leads:assign",
    heldBy: ["member"],
    reason:
      "Reassigning a lead is real — `updateLead` writes `leads.owner_id` — and it is gated by " +
      "`leads:update`, not by this key. Enforcing this key as written would make things WORSE, " +
      "not better: `member` holds it and `manager` does not, so a manager would lose the " +
      "ability to reassign their own team's leads while their reports kept it. That is almost " +
      "certainly a mistake in the role template rather than an intended boundary, and correcting " +
      "a customer-visible role definition is a decision the owner takes, not a decision a " +
      "security sweep takes on their behalf. Enforce it once the templates are settled.",
  },
  {
    key: "leads:export",
    heldBy: [],
    reason:
      "There is no leads dataset in the export registry (`server/export/datasets.ts`). The five " +
      "datasets that exist carry `reports:export`, `contacts:export`, `tally:export` and " +
      "`audit:read`, and each is checked. This key becomes enforceable the moment a leads " +
      "dataset is added, and `scripts/check-export-registry.mjs` will require a permission on it.",
  },
  {
    key: "assets:delete",
    heldBy: [],
    reason:
      "Assets are never deleted in this product. There is no delete or archive action in " +
      "`server/actions/assets.ts` — an asset that is out of service gets a status. The key " +
      "describes an operation that does not exist, so nothing can check it. Held by the wildcard " +
      "roles only, so no role template promises anything this omission breaks.",
  },
  {
    key: "contracts:delete",
    heldBy: [],
    reason:
      "Contracts soft-delete into the recycle bin rather than being deleted, and the recycle bin " +
      "in `server/actions/recovery.ts` gates its read and its restore on `contacts:read`. That " +
      "is a separate and arguable choice; what matters here is that no code path deletes a " +
      "contract, so there is nothing for this key to guard.",
  },
  {
    key: "contracts:sign",
    heldBy: ["manager"],
    reason:
      "Signature is taken from the EXTERNAL counterparty through `/portal/<token>`, and an " +
      "external signer holds no role at all — the token is their entire authority, which is why " +
      "`server/portal-context.ts` exists. The internal act that delegates signing authority is " +
      "issuing a signing link, and that is already gated on `contracts:approve` in " +
      "`server/actions/portal.ts`. This key would describe an internal countersignature, which " +
      "the product does not have.",
  },
  {
    key: "clauses:manage",
    heldBy: ["manager"],
    reason:
      "There is no clause library management screen. Rows in `clause_library` can be READ during " +
      "contract creation (now gated on `clauses:read`, wave 9) and are created by nothing in the " +
      "product. When a clause library editor is built, this is its key.",
  },
];

/** The keys, for the gate and for tests. */
export const DECLARED_ONLY_KEYS: readonly string[] = DECLARED_ONLY_PERMISSIONS.map((p) => p.key);

export function unenforcedReason(key: string): string | null {
  return DECLARED_ONLY_PERMISSIONS.find((p) => p.key === key)?.reason ?? null;
}
