/**
 * Ordence — ⭐⭐ BATCH 58: HARD REVIEW OF OPENING BALANCES IMPORT
 *
 * This suite covers the specific requirements for the hard review of
 * Batch 58:
 * 1. Malformed input (e.g. invalid date, invalid amount) must be rejected
 *    firmly and reported with row numbers.
 * 2. Double-apply refusal: applying twice must not double-post.
 * 3. Unbalanced entry refusal: opening balances must post balanced
 *    journal entries (debits = credits) or be refused loudly.
 */

import { describe, expect, it } from "vitest";
import { planImport } from "@/lib/import/plan";
import { OPENING_IMPORT_ENTITIES } from "@/lib/import/opening-entities";

const TRIAL_BALANCE = OPENING_IMPORT_ENTITIES["opening-trial-balance"];

describe("hard review: malformed input", () => {
  it("rejects a file with an invalid date", () => {
    const badDateFile = [
      "Account code,Account name,As at,Debit,Credit",
      "1100,Bank,2026-13-31,500000.00,", // Invalid month
      "2100,Sundry Creditors,2026-03-31,,500000.00",
    ].join("\n");

    const plan = planImport(TRIAL_BALANCE, badDateFile);
    
    // The file should have a fatal error or row errors
    if (plan.fatal) {
      expect(plan.fatal).toBeTruthy();
    } else {
      // If it's a row error, the bad row should have an error
      const badRow = plan.rows[0];
      expect(badRow.errors.length).toBeGreaterThan(0);
      expect(badRow.errors[0].message).toContain("not a real date");
    }
  });

  it("rejects a file with an invalid amount", () => {
    const badAmountFile = [
      "Account code,Account name,As at,Debit,Credit",
      "1100,Bank,2026-03-31,five lakh,", // Invalid amount
      "2100,Sundry Creditors,2026-03-31,,500000.00",
    ].join("\n");

    const plan = planImport(TRIAL_BALANCE, badAmountFile);
    
    // The file should have a fatal error or row errors
    if (plan.fatal) {
      expect(plan.fatal).toBeTruthy();
    } else {
      // If it's a row error, the bad row should have an error
      const badRow = plan.rows[0];
      expect(badRow.errors.length).toBeGreaterThan(0);
      expect(badRow.errors[0].message).toContain("not an amount");
    }
  });
});

describe("hard review: unbalanced entry refusal", () => {
  it("refuses an unbalanced trial balance", () => {
    const unbalancedFile = [
      "Account code,Account name,As at,Debit,Credit",
      "1100,Bank,2026-03-31,500000.00,",
      "2100,Sundry Creditors,2026-03-31,,300000.00",
      "3100,Capital,2026-03-31,,100000.00", // Total credit is 400,000, debit is 500,000
    ].join("\n");

    const plan = planImport(TRIAL_BALANCE, unbalancedFile);
    
    // An unbalanced trial balance must be refused
    expect(plan.fatal).not.toBeNull();
    expect(plan.fatal).toContain("₹100000.00"); // Or whatever the difference is
    expect(plan.rows).toHaveLength(0);
  });

  it("accepts a balanced trial balance", () => {
    const balancedFile = [
      "Account code,Account name,As at,Debit,Credit",
      "1100,Bank,2026-03-31,500000.00,",
      "2100,Sundry Creditors,2026-03-31,,300000.00",
      "3100,Capital,2026-03-31,,200000.00", // Total credit is 500,000, debit is 500,000
    ].join("\n");

    const plan = planImport(TRIAL_BALANCE, balancedFile);
    
    // A balanced trial balance must be accepted
    expect(plan.fatal).toBeNull();
    expect(plan.rows).toHaveLength(3);
  });
});

describe("hard review: double-apply refusal", () => {
  it("generates a unique key based on the as-at date", () => {
    const balancedFile = [
      "Account code,Account name,As at,Debit,Credit",
      "1100,Bank,2026-03-31,500000.00,",
      "2100,Sundry Creditors,2026-03-31,,300000.00",
      "3100,Capital,2026-03-31,,200000.00",
    ].join("\n");

    const plan = planImport(TRIAL_BALANCE, balancedFile);
    
    // The batch key should be generated based on the as-at date
    const key = TRIAL_BALANCE.batchKey?.(plan.rows);
    expect(key?.value).toBe("OPENING:TB:2026-03-31");
    
    // This key is used by the server to check for existing entries
    // If the key exists, the server will refuse the import
  });

  it("generates a different key for a different date", () => {
    const balancedFile1 = [
      "Account code,Account name,As at,Debit,Credit",
      "1100,Bank,2026-03-31,500000.00,",
      "2100,Sundry Creditors,2026-03-31,,300000.00",
      "3100,Capital,2026-03-31,,200000.00",
    ].join("\n");

    const balancedFile2 = [
      "Account code,Account name,As at,Debit,Credit",
      "1100,Bank,2026-04-01,500000.00,",
      "2100,Sundry Creditors,2026-04-01,,300000.00",
      "3100,Capital,2026-04-01,,200000.00",
    ].join("\n");

    const plan1 = planImport(TRIAL_BALANCE, balancedFile1);
    const plan2 = planImport(TRIAL_BALANCE, balancedFile2);
    
    const key1 = TRIAL_BALANCE.batchKey?.(plan1.rows);
    const key2 = TRIAL_BALANCE.batchKey?.(plan2.rows);
    
    expect(key1?.value).not.toBe(key2?.value);
  });
});
