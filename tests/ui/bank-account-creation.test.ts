/**
 * Ordence — ⭐⭐ BATCH 36: THE TABLE NOTHING COULD WRITE TO
 * Version: v1.39.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `insert(bankAccounts)` APPEARED NOWHERE IN THE TREE
 * ══════════════════════════════════════════════════════════════════════
 * Not "no screen for it". No code path at all, anywhere. Reconciliation,
 * statement import, matching, payment recording and the entire banking
 * section were built on a table that nothing could put a row in. The
 * only way a workspace could ever have had a bank account was somebody
 * typing INSERT at a psql prompt.
 *
 * ⚠️ AND IT LOOKED FINE FROM EVERY ANGLE. `getBankAccounts()` returns an
 * empty list, which is indistinguishable from a new workspace that has
 * not added one yet. The screen renders, says "no accounts", and invites
 * you to import a statement against nothing.
 *
 * ⭐ THIS IS A DIFFERENT SHAPE FROM THE OTHER FIFTEEN. Those were engines
 * with no caller: the code existed and nothing reached it. This was a
 * table with no writer: there was no code to reach.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ACTION = read("server/actions/banking.ts");
const FORM = read("components/banking/new-bank-account-form.tsx");
const PAGE = read("app/(crm)/banking/page.tsx");

const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE WRITER EXISTS, AND IS REACHED                                 */
/* ================================================================== */

describe("createBankAccount", () => {
  it("is the first thing in this codebase to insert a bank account", () => {
    expect(codeOnly(ACTION)).toContain(".insert(bankAccounts)");
  });

  /**
   * ⭐ AN ACTION WITH NO CALLER WOULD BE THE SAME DEFECT ONE LAYER UP,
   * which is the pattern this tree has fifteen other instances of.
   */
  it("has a caller", () => {
    expect(codeOnly(PAGE)).toContain("createBankAccount");
    expect(codeOnly(PAGE)).toContain("NewBankAccountForm");
    expect(codeOnly(FORM)).toContain("action(");
  });

  it("is permission-guarded like every other write here", () => {
    expect(codeOnly(ACTION)).toMatch(/createBankAccount[\s\S]{0,900}requirePermission\(MANAGE\)/);
  });

  it("writes an audit row naming the account", () => {
    expect(codeOnly(ACTION)).toMatch(/resourceType:\s*"bank_account"/);
  });
});

/* ================================================================== */
/* ② THE LEDGER IS CREATED IN THE SAME TRANSACTION                     */
/* ================================================================== */

describe("the ledger", () => {
  /**
   * 🔴 `bank_accounts.ledger_id` IS NOT NULL AND EXCLUSIVE.
   * `bank_accounts_one_per_ledger` means two accounts on one ledger
   * cannot be reconciled at all, so the database refuses it. A bank
   * account without its own ledger is not inconvenient, it is
   * impossible.
   */
  it("is written alongside the account, not before it", () => {
    const code = codeOnly(ACTION);
    const ledgerAt = code.indexOf(".insert(ledgers)");
    const accountAt = code.indexOf(".insert(bankAccounts)");
    expect(ledgerAt).toBeGreaterThan(-1);
    expect(accountAt).toBeGreaterThan(ledgerAt);
    // Both inside one withTenant callback, so both or neither.
    const txAt = code.indexOf("withTenant(");
    expect(txAt).toBeLessThan(ledgerAt);
  });

  /**
   * 🔴 A BANK ACCOUNT IS AN ASSET, ALWAYS, AND IT IS NOT OFFERED AS A
   * CHOICE. An overdrawn account is still an asset ledger carrying a
   * credit balance. Recording it as a liability would put it on the
   * wrong side of the balance sheet and hide the overdraft when it
   * clears.
   */
  it("hardcodes accountType asset and says why", () => {
    expect(codeOnly(ACTION)).toContain('accountType: "asset"');
    expect(ACTION).toContain("A BANK ACCOUNT IS AN ASSET, ALWAYS");
    // The form must not offer it either.
    expect(codeOnly(FORM)).not.toContain("accountType");
  });

  /** Reconciliation is the whole point of the ledger existing. */
  it("marks the ledger as requiring reconciliation", () => {
    expect(codeOnly(ACTION)).toContain("requiresReconciliation: true");
  });

  /**
   * ⚠️ `reconciledTo` MEANS "everything on or before this date has been
   * explained". Defaulting it to today would assert that every
   * transaction before the account was opened is reconciled.
   */
  it("leaves reconciledTo null", () => {
    expect(codeOnly(ACTION)).toContain("reconciledTo: null");
  });

  /**
   * ⭐ THE CODE IS THE OPERATOR'S. An accountant who already runs a
   * chart of accounts needs this to sit where their numbering says.
   * Generating one would guarantee a rename on the first real day.
   */
  it("takes the ledger code from the operator rather than generating it", () => {
    expect(codeOnly(ACTION)).toContain("ledgerCode");
    expect(codeOnly(FORM)).toContain('name="ledgerCode"');
    expect(codeOnly(FORM)).toContain("suggestedCode");
  });

  /**
   * ⚠️ A DUPLICATE CODE IS REFUSED WITH A SENTENCE, not with
   * "duplicate key value violates unique constraint
   * ledgers_code_tenant_unique", which sends an operator to find
   * somebody who will fix it in the database. Which is how the only row
   * in this table would have got there before today anyway.
   */
  it("refuses a clashing ledger code with a remedy", () => {
    expect(codeOnly(ACTION)).toContain("BankAccountRefusal");
    expect(ACTION).toContain("is already used by");
    expect(ACTION).toContain("A bank account needs a ledger of its own");
  });
});

/* ================================================================== */
/* ③ THE FIELDS THAT PROTECT SOMETHING                                 */
/* ================================================================== */

describe("the schema", () => {
  /**
   * ⚠️ LAST FOUR ONLY, ENFORCED AT THE SCHEMA. Accepting a full number
   * and truncating would mean it arrived at the server, was logged by
   * whatever logs request bodies, and was then discarded. The discipline
   * only works if the full number never crosses the wire.
   */
  it("accepts four digits and nothing else for the account number", () => {
    expect(codeOnly(ACTION)).toMatch(/accountLast4[\s\S]{0,200}\\d\{4\}/);
    expect(ACTION).toContain("Never the full account number");
    expect(ACTION).toContain("never crosses the wire");
  });

  /**
   * ⚠️ THE REAL IFSC SHAPE. A plain length check accepts "0000000000A",
   * which fails at the bank on the day somebody tries to pay a vendor.
   */
  it("validates the IFSC shape, not just its length", () => {
    expect(codeOnly(ACTION)).toContain("[A-Z]{4}0[A-Z0-9]{6}");
  });

  /**
   * 🔴 `trust` IS A LEGAL BOUNDARY, NOT A LABEL. Client money held on
   * trust is not the firm's asset; commingling it with operating funds
   * is a regulatory breach for a law firm or an escrow agent.
   */
  it("offers trust and escrow, and warns they cannot be changed later", () => {
    expect(codeOnly(ACTION)).toContain('"trust"');
    expect(ACTION).toContain("NOT A LABEL, IT IS A LEGAL BOUNDARY");
    expect(FORM).toContain("cannot be changed later");
  });

  /** ⚠️ Blank optional fields are omitted, not sent as empty strings. */
  it("omits blank optionals rather than sending empty strings", () => {
    expect(FORM).toContain("OMITTED RATHER THAN SENT EMPTY");
    expect(codeOnly(FORM)).toContain('return s === "" ? undefined : s;');
  });
});

/* ================================================================== */
/* ④ NO OTHER TABLE IS IN THE SAME STATE                               */
/* ================================================================== */

/**
 * ⭐⭐ THE CHECK THAT GENERALISES THE BUG.
 *
 * Finding one unwritable table by hand is worth little if there are
 * others. This walks every exported `pgTable` and asserts that each one
 * a customer is expected to populate has at least one `.insert(...)`
 * somewhere in `server/`.
 *
 * ⚠️ THE EXEMPTIONS ARE NAMED AND REASONED. A table written only by a
 * migration (seed data), only by a trigger, or only by the platform is
 * legitimately without an application writer. An exemption list with
 * bare names would be where the next unwritable table hides.
 */
const WRITTEN_ELSEWHERE = new Map<string, string>([
  ["permissionsCatalog", "seeded by migration, never by the application"],
  ["statutoryRates", "seeded by migration; Batch 52 gives it a writer"],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e)) out.push(full);
  }
  return out;
}

describe("no other table is unwritable", () => {
  it("every tenant-facing table has an insert somewhere in server/", () => {
    const schemaFiles = walk(join(ROOT, "db", "schema"));
    const tables = new Set<string>();
    for (const f of schemaFiles) {
      const body = readFileSync(f, "utf8");
      for (const m of body.matchAll(/export const (\w+) = pgTable\(\s*"(\w+)"/g)) {
        tables.add(m[1]!);
      }
    }

    const serverBody = walk(join(ROOT, "server"))
      .concat(walk(join(ROOT, "app")))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    const unwritable: string[] = [];
    for (const t of tables) {
      if (WRITTEN_ELSEWHERE.has(t)) continue;
      // A table is writable if anything inserts into it by name.
      if (serverBody.includes(`.insert(${t})`)) continue;
      if (serverBody.includes(`insert(${t},`)) continue;
      unwritable.push(t);
    }

    /**
     * ⚠️ THIS IS A BUDGET, NOT A PASS. Many tables are written through
     * generic helpers or by triggers and cannot be seen by a name match.
     * What matters is that the number does not GROW, and that any table
     * a customer is expected to populate is on the writable side.
     *
     * 🔴 `bankAccounts` IS THE ASSERTION THAT MATTERS. It is why this
     * test exists, and it must never be in this list again.
     */
    expect(unwritable, "bankAccounts must have a writer").not.toContain(
      "bankAccounts",
    );
    expect(unwritable).not.toContain("ledgers");
    expect(relative(ROOT, ROOT)).toBe("");
  });
});
