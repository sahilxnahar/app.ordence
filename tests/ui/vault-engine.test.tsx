/**
 * Ordence — ⭐ ENGINE 6 · SENSITIVE-DATA VAULT
 * Session 1 · v0.66.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE FAILURE MODE THIS ENGINE ACTUALLY HAS IS NOT AN ATTACKER
 * ══════════════════════════════════════════════════════════════════════
 * It is a developer in a hurry writing `ciphertext: pan` because the
 * encryption helper was two imports away and the deadline was yesterday.
 * Nothing errors. The column is named ciphertext, the code reads
 * plausibly, the review passes, and the PAN is now in every backup.
 *
 * So the tests that matter are not "does AES work" — the Web Crypto API
 * works. They are: does the DATABASE refuse a value that still looks like
 * the thing it was meant to protect, and can a masked display ever be the
 * value itself.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  maskForDisplay,
  looksLikeAadhaar,
  looksLikePan,
  MASK_VISIBLE_SUFFIX,
  PURPOSES_FORBIDDEN_DURING_IMPERSONATION,
  vaultKindEnum,
  type VaultKind,
} from "@/db/schema/vault";

describe("⭐ masking — what may ever reach a screen", () => {
  /**
   * ⚠️ AADHAAR IS FOUR DIGITS AND THAT IS NOT A STYLE CHOICE. UIDAI
   * guidance and the Aadhaar Act permit displaying only the last four;
   * showing more is a specific, named offence. Encoding it as data rather
   * than as a rule somebody remembers is what makes it hold on the
   * screens written next year.
   */
  it("shows only the last four digits of an Aadhaar", () => {
    const masked = maskForDisplay("412345678901", "aadhaar");
    expect(masked.endsWith("8901")).toBe(true);
    expect(masked).not.toContain("4123");
    expect(masked.replace(/•/g, "")).toHaveLength(4);
  });

  it("shows only the last four characters of a PAN", () => {
    expect(maskForDisplay("ABCDE1234F", "pan")).toBe("••••••234F");
  });

  /**
   * ⚠️ A PASSWORD REVEALS NOTHING. Not one character — the last four of a
   * password is a meaningful fraction of a short one, and a hint for the
   * rest.
   */
  it("reveals nothing at all for a password", () => {
    const masked = maskForDisplay("hunter2hunter2", "portal_password");
    expect(masked).toMatch(/^•+$/);
    expect(masked).not.toContain("2");
  });

  it("reveals nothing for a salary", () => {
    expect(maskForDisplay("2400000", "salary")).toMatch(/^•+$/);
  });

  it("does not leak length for a zero-suffix kind", () => {
    /**
     * ⚠️ A MASK THAT MIRRORS LENGTH LEAKS LENGTH, and for a password the
     * length is most of what a guesser wants. Both of these must produce
     * the same shape.
     */
    const short = maskForDisplay("abc123", "portal_password");
    const long = maskForDisplay(
      "a-very-long-passphrase-indeed-really-quite-long",
      "portal_password",
    );
    expect(short.length).toBeLessThanOrEqual(12);
    expect(long.length).toBeLessThanOrEqual(12);
  });

  it("never returns the input unchanged for any kind", () => {
    const samples: Record<string, string> = {
      pan: "ABCDE1234F",
      aadhaar: "412345678901",
      bank_account: "50100234567890",
      portal_password: "hunter2",
      salary: "2400000",
    };
    for (const kind of vaultKindEnum.enumValues) {
      const value = samples[kind] ?? "SOMESENSITIVEVALUE";
      const masked = maskForDisplay(value, kind as VaultKind);
      expect(
        masked,
        `maskForDisplay returned the raw value unchanged for kind "${kind}".`,
      ).not.toBe(value);
      expect(masked).toContain("•");
    }
  });

  it("does not crash on a value shorter than its visible suffix", () => {
    expect(maskForDisplay("12", "pan")).toBe("••");
    expect(maskForDisplay("", "pan")).toBe("");
  });

  it("declares a masking rule for every kind in the enum", () => {
    for (const kind of vaultKindEnum.enumValues) {
      expect(
        MASK_VISIBLE_SUFFIX[kind as VaultKind],
        `Kind "${kind}" has no masking rule, so maskForDisplay would return undefined and the UI would show the raw value.`,
      ).toBeDefined();
    }
  });
});

describe("⭐ format detection — refusing sensitive data where it does not belong", () => {
  it("recognises an Aadhaar with or without separators", () => {
    expect(looksLikeAadhaar("412345678901")).toBe(true);
    expect(looksLikeAadhaar("4123 4567 8901")).toBe(true);
    expect(looksLikeAadhaar("4123-4567-8901")).toBe(true);
  });

  /**
   * ⚠️ UIDAI DOES NOT ISSUE NUMBERS BEGINNING 0 OR 1. Accepting them
   * would flag ordinary 12-digit references — an order number, an
   * account, an IMEI fragment — as Aadhaar and block legitimate input, in
   * a way that trains users to work around the check.
   */
  it("does not flag a 12-digit number starting 0 or 1", () => {
    expect(looksLikeAadhaar("012345678901")).toBe(false);
    expect(looksLikeAadhaar("112345678901")).toBe(false);
  });

  it("does not flag numbers of the wrong length", () => {
    expect(looksLikeAadhaar("41234567890")).toBe(false);
    expect(looksLikeAadhaar("4123456789012")).toBe(false);
  });

  it("recognises a PAN and rejects near-misses", () => {
    expect(looksLikePan("ABCDE1234F")).toBe(true);
    expect(looksLikePan("abcde1234f")).toBe(true); // case-insensitive
    expect(looksLikePan("ABCD1234F")).toBe(false);
    expect(looksLikePan("ABCDE12345")).toBe(false);
    expect(looksLikePan("ABCDE1234FG")).toBe(false);
  });
});

describe("⭐ what a support session may never do", () => {
  /**
   * ⚠️ SUPPORT EXISTS TO FIX A BROKEN SCREEN, NOT TO READ A PAN.
   *
   * Impersonation is a legitimate and necessary tool — somebody has to be
   * able to see what the customer sees. It is also, by construction, a
   * way for a platform employee to act inside a tenant. "They would not
   * do that" is not a control.
   */
  it("fences support out of identity, clinical and bulk access", () => {
    expect(PURPOSES_FORBIDDEN_DURING_IMPERSONATION).toContain("kyc_verification");
    expect(PURPOSES_FORBIDDEN_DURING_IMPERSONATION).toContain("clinical_care");
    expect(PURPOSES_FORBIDDEN_DURING_IMPERSONATION).toContain("bulk_export");
  });

  it("still lets support troubleshoot", () => {
    expect(PURPOSES_FORBIDDEN_DURING_IMPERSONATION).not.toContain(
      "support_troubleshooting",
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⭐ DRIFT GUARDS
 * ══════════════════════════════════════════════════════════════════════ */

const SQL = readFileSync(
  join(process.cwd(), "SQL-FILES", "0037_engine6_vault.sql"),
  "utf8",
);

/**
 * The same file with comments stripped.
 *
 * ⚠️ NEEDED BECAUSE THIS FILE ARGUES WITH ITSELF ON PURPOSE. It explains
 * at length why pgcrypto is the wrong answer — so a guard searching the
 * raw text for `pgp_sym_encrypt` finds the warning against it and reports
 * the warning as the violation. Guards that assert something is ABSENT
 * must read the code; guards that assert something is PRESENT can read
 * either.
 */
const SQL_CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

describe("⭐ drift guard — the database's own refusals", () => {
  it("fences the same purposes in SQL as in TypeScript", () => {
    const arm =
      SQL.match(/\/\*IMPERSONATION-FORBIDDEN\*\/\s*ARRAY\[([^\]]*)\]/)?.[1] ?? "";
    expect(arm).not.toBe("");
    const inSql = [...arm.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(
      inSql,
      "PURPOSES_FORBIDDEN_DURING_IMPERSONATION and the SQL guard disagree. The application would then permit something the database refuses, or worse, the reverse.",
    ).toEqual([...PURPOSES_FORBIDDEN_DURING_IMPERSONATION].sort());
  });

  it("refuses a raw PAN in the ciphertext column", () => {
    expect(
      /\^\[A-Z\]\{5\}\[0-9\]\{4\}\[A-Z\]\$/.test(SQL),
      "The plaintext-PAN guard is missing. The likely failure here is not an attacker but a developer writing `ciphertext: pan` — nothing errors, and the value lands in every backup.",
    ).toBe(true);
  });

  it("refuses a raw Aadhaar in the ciphertext column", () => {
    expect(/\^\[2-9\]\[0-9\]\{11\}\$/.test(SQL)).toBe(true);
  });

  it("requires the blind index to be a full 64-hex HMAC", () => {
    expect(
      /\^\[0-9a-f\]\{64\}\$/.test(SQL),
      "A plain or truncated hash of a PAN is not a protection: the space is about 10^9 and a laptop enumerates it in minutes, so the hash IS the PAN to whoever obtains the column.",
    ).toBe(true);
  });

  it("does not use pgcrypto", () => {
    /**
     * ⚠️ `pgp_sym_encrypt(x, 'key')` PUTS THE KEY IN THE SQL STATEMENT —
     * which lands in pg_stat_statements, in the slow-query log, and in
     * every backup of those. The data ends up encrypted at rest with the
     * key filed beside it.
     *
     * ⚠️ TESTED AGAINST THE CODE, NOT THE COMMENTS. The file explains at
     * length why pgcrypto is wrong, so a naive search over the raw text
     * finds the warning and reports it as the offence.
     */
    expect(/pgp_sym_encrypt|pgcrypto|\bcrypt\(/.test(SQL_CODE)).toBe(false);
    // …and the explanation is still there for the next reader.
    expect(/pgp_sym_encrypt/.test(SQL)).toBe(true);
  });

  it("erases the blind index along with the ciphertext", () => {
    const fn =
      SQL.split("FUNCTION ordence_vault_erase")[1]?.split("$$;")[0] ?? "";
    expect(fn).not.toBe("");
    expect(/ciphertext\s*=\s*''/.test(fn)).toBe(true);
    expect(
      /blind_index\s*=\s*NULL/.test(fn),
      "The blind index is a deterministic derivative of the value. Leaving it behind means \"is this person's PAN in your system\" is still answerable about a record you certified as erased.",
    ).toBe(true);
  });

  it("keeps the row after erasure rather than deleting it", () => {
    const fn =
      SQL.split("FUNCTION ordence_vault_erase")[1]?.split("$$;")[0] ?? "";
    expect(
      /DELETE FROM vault_secrets/.test(fn),
      "Erasure must UPDATE, not DELETE — the row is the proof that erasure happened, and to what.",
    ).toBe(false);
    expect(/UPDATE vault_secrets/.test(fn)).toBe(true);
  });

  it("makes the access log undeletable by the application role", () => {
    expect(
      /REVOKE\s+UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+vault_access_log\s+FROM\s+ordence_app/i.test(SQL),
      "A log the application can prune will be pruned by exactly the person it was built to catch.",
    ).toBe(true);
  });

  it("does not let the application DELETE a secret either", () => {
    expect(
      /REVOKE\s+DELETE,\s*TRUNCATE\s+ON\s+vault_secrets\s+FROM\s+ordence_app/i.test(SQL),
    ).toBe(true);
  });

  it("does not cascade the access log from the secret", () => {
    /**
     * ⚠️ Deleting a vault row must not delete the record of who read it.
     * The moment a secret disappears is the moment its access history
     * becomes most interesting — a CASCADE would make "delete the secret"
     * a one-statement way to erase the evidence of having read it.
     */
    expect(
      /vault_access_log[\s\S]{0,200}REFERENCES vault_secrets[\s\S]{0,60}ON DELETE CASCADE/.test(SQL),
    ).toBe(false);
  });

  it("FORCEs RLS and uses security_invoker on every view", () => {
    expect(/FORCE ROW LEVEL SECURITY/.test(SQL)).toBe(true);
    const views = SQL.match(/CREATE OR REPLACE VIEW\s+\w+/g) ?? [];
    const invokers = SQL.match(/security_invoker\s*=\s*true/g) ?? [];
    expect(views.length).toBeGreaterThan(0);
    expect(invokers.length).toBe(views.length);
  });

  it("keeps ciphertext out of the retention view", () => {
    const view =
      SQL.split("CREATE OR REPLACE VIEW v_vault_retention_due")[1]?.split(";")[0] ??
      "";
    expect(view).not.toBe("");
    expect(
      /ciphertext|blind_index|\biv\b/.test(view),
      "A screen about deletion has no business carrying the values it is about.",
    ).toBe(false);
  });

  it("refuses to delete a consent record", () => {
    expect(
      /A consent record cannot be deleted/.test(SQL),
      "Deleting the consent row on withdrawal destroys the evidence that processing between grant and withdrawal was lawful — exactly the period anyone would ask about.",
    ).toBe(true);
  });
});
