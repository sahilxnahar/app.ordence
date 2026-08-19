/**
 * Ordence — Batch 0108 · THE LEDGER'S OWN CURRENCY
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT EACH TEST HERE WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * D1  `journal_entries.amount` was `numeric(18,2)`, so a three-decimal
 *     dinar was unrepresentable and silently rounded at write time.
 * D2  `server/accounting/post-sales.ts` stamped the literal `"INR"` on
 *     nine of its ten transaction writers, so a dirham book carried
 *     transactions labelled with a currency they were not in.
 * D3  Twenty-seven posting roles were emitted by builders, checked at
 *     posting time, and absent from BOTH the posting-accounts form and
 *     the validator that would have let anybody set them.
 *
 * 🔴 ASSERT PROPERTIES, NEVER SHAPES. There is no `toBe(66)` below and
 * there must not be. Pinning the role count fails the next correct change
 * — five such assertions have already failed five correct changes in this
 * codebase. Every assertion here is an invariant: "every role a builder
 * can emit is settable", "no writer names a currency literal", "nothing
 * between the ledger and a total multiplies by a hundred". A correct
 * change keeps them true; the defect makes them false.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  POSTING_ROLE_REGISTRY,
  POSTING_ROLE_KEYS,
  POSTING_MODULES,
  POSTING_ROLE_META,
  PURCHASE_ROLE_META,
  CONSTRUCTION_ROLE_META,
  PROPERTY_ROLE_META,
  METERING_ROLE_META,
  PAYROLL_ROLE_META,
  RETURN_ROLE_META,
  FIXED_ASSET_ROLE_META,
  FX_ROLE_META,
  modulesNeeding,
  postingAccountsHref,
  type PostingModuleKey,
} from "@/lib/accounting/sales-posting";
import {
  formatMinorPlain,
  parseMajorToMinor,
  minorUnitExponent,
} from "@/lib/fx/currency";
import { postTransactionSchema } from "@/lib/validators/accounting";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * ⭐⭐ CODE WITH THE COMMENTS TAKEN OUT.
 *
 * 🔴 AN "IT NO LONGER DOES X" ASSERTION MUST NOT READ THE PROSE THAT SAYS
 * IT NO LONGER DOES X. Two assertions in this very file failed on their
 * first run for exactly that reason: the comment beside the fix quoted the
 * defect it had fixed — `Math.abs(debits - credits) < 0.005`, `NO FORCE
 * ROW LEVEL SECURITY` — and the regex matched the explanation instead of
 * the code.
 *
 * That is not a harmless flake. A negative assertion that can be satisfied
 * by deleting a comment, and broken by writing one, tests documentation
 * rather than behaviour. Stripping comments first is what makes "this file
 * does not do X" mean it.
 */
function code(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const POST_SALES = read("server/accounting/post-sales.ts");
const SCHEMA = read("db/schema/accounting.ts");
const MIGRATION = read("SQL-FILES/0108_journal_entries_minor_units.sql");
const SETUP_ACTION = read("server/actions/sales-posting.ts");
const SETUP_FORM = read("components/invoices/posting-setup.tsx");

/* ================================================================== */
/* D1 · THE LEDGER CAN HOLD A DINAR                                    */
/* ================================================================== */

describe("🔴 D1 — the ledger counts in minor units", () => {
  it("declares amount_minor as a bigint and demotes amount to a nullable mirror", () => {
    /**
     * The property: the authoritative column is an integer type, and the
     * old decimal column can no longer be relied on to be there.
     */
    expect(SCHEMA).toMatch(/amountMinor:\s*bigint\("amount_minor",\s*\{\s*mode:\s*"bigint"\s*\}\)/);
    // `.notNull()` on `amount` is what 0108 removes; a mirror that cannot
    // be NULL cannot represent a leg below one hundredth of a major unit.
    expect(code("db/schema/accounting.ts")).not.toMatch(
      /amount:\s*numeric\("amount",\s*\{\s*precision:\s*18,\s*scale:\s*2\s*\}\)\.notNull\(\)/,
    );
  });

  it("no posting writer hands a decimal string to the journal any more", () => {
    /**
     * 🔴 THE DEFECT, STATED AS A PROPERTY. Every leg used to be written as
     * `amount: formatMoneyPlain(l.amountMinor, "INR")` — a bigint turned
     * into a two-decimal string with the currency hardcoded. Any
     * reappearance of a leg written through a formatter is the bug back.
     */
    const legWrites = code("server/accounting/post-sales.ts").match(/^\s*amount:\s*format\w+\(/gm) ?? [];
    expect(legWrites).toEqual([]);
    expect(POST_SALES).toMatch(/amountMinor:\s*l\.amountMinor/);
  });

  it("a three-decimal dinar survives the round trip; a two-decimal column could not", () => {
    /**
     * This is the arithmetic the old schema destroyed. 1234 fils is 1.234
     * dinars, and `numeric(18,2)` rounded it to 1.23 on the way in.
     */
    expect(minorUnitExponent("KWD")).toBe(3);
    expect(formatMinorPlain(1234n, "KWD")).toBe("1.234");
    expect(parseMajorToMinor("1.234", "KWD")).toBe(1234n);

    // ⭐ AND THE ROUNDING THAT USED TO HAPPEN IS A REAL LOSS, not a rounding
    // of no consequence: it is 4 fils on a single leg, every leg.
    const throughOldColumn = parseMajorToMinor("1.23", "KWD");
    expect(throughOldColumn).not.toBe(1234n);
    expect(1234n - throughOldColumn).toBe(4n);
  });

  it("a yen amount is not a hundredth of itself", () => {
    // A blanket x100 backfill would have turned 1234 yen into 123400 yen.
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(formatMinorPlain(1234n, "JPY")).toBe("1234");
    expect(parseMajorToMinor("1234", "JPY")).toBe(1234n);
  });

  it("the migration scales by the row's own currency and never by a literal 100", () => {
    /**
     * 🔴 THE PROOF THIS BATCH OWES. A `amount * 100` backfill is correct
     * for the rupee, overstates a yen a hundred fold and understates a
     * dinar ten fold. The property: the backfill's multiplier is derived
     * from `currency_units.exponent`, never written down.
     */
    expect(MIGRATION).toMatch(/10::numeric \^ cu\.exponent/);
    expect(code("SQL-FILES/0108_journal_entries_minor_units.sql")).not.toMatch(/amount \* 100\b/);
  });

  it("the migration proves precision and overflow BEFORE it writes anything", () => {
    const censusAt = MIGRATION.indexOf("ordence_journal_currency_census");
    const backfillAt = MIGRATION.indexOf("$backfill$");
    expect(censusAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeGreaterThan(censusAt);
    // Both proofs are reported, not asserted-away.
    expect(MIGRATION).toMatch(/lossy_legs/);
    expect(MIGRATION).toMatch(/overflow_legs/);
    // 🔴 numeric(18,2) x 10^4 exceeds a bigint. The claim "it always fits"
    // is false and the file must ask the data rather than argue the type.
    expect(MIGRATION).toMatch(/9223372036854775807/);
  });

  it("the backfill re-arms every guard it disables, inside one statement", () => {
    /**
     * The property: nothing in this file can leave `journal_entries`
     * mutable. The DISABLEs and the ENABLEs are inside a single
     * `DO $backfill$ ... $backfill$;` — one statement, one connection, one
     * transaction — so a failure rolls the DISABLE back with everything
     * else, and the block asserts the re-arm rather than assuming it.
     */
    const block = MIGRATION.slice(
      MIGRATION.indexOf("DO $backfill$"),
      MIGRATION.indexOf("$backfill$;") + "$backfill$;".length,
    );
    const disabled = block.match(/DISABLE TRIGGER (\w+)/g) ?? [];
    const enabled = block.match(/ENABLE TRIGGER (\w+)/g) ?? [];
    expect(disabled.length).toBeGreaterThan(0);
    expect(new Set(disabled.map((d) => d.replace("DISABLE ", "")))).toEqual(
      new Set(enabled.map((e) => e.replace("ENABLE ", ""))),
    );
    expect(block).toMatch(/is still disabled/);
  });

  it("the backfill respects RLS by pinning each tenant, and never weakens it", () => {
    /**
     * 🔴 `journal_entries` HAS NO PLATFORM-SCOPE CLAUSE, deliberately. A
     * file that reached across tenants by turning FORCE RLS off would be a
     * file somebody copies.
     */
    expect(MIGRATION).toMatch(/set_config\('app\.current_tenant_id'/);
    const sql = code("SQL-FILES/0108_journal_entries_minor_units.sql");
    expect(sql).not.toMatch(/NO FORCE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY/);
  });

  it("the fill trigger runs before the ledger-balance trigger, not after", () => {
    /**
     * 🔴 THE DEFECT THIS ENCODES COST A WHOLE POSTING PATH. PostgreSQL
     * fires BEFORE ROW triggers in alphabetical order by NAME. The first
     * draft called this trigger `journal_entries_zz_fill_minor` so it
     * would run last; `update_ledger_balance` therefore read a NULL
     * `NEW.amount`, `current_balance + NULL` was NULL, and every posting
     * died on a NOT NULL constraint in `ledgers`. The `aa_` prefix is the
     * fix and it is load-bearing.
     */
    expect(MIGRATION).toMatch(/journal_entries_aa_fill_minor/);
    expect(code("SQL-FILES/0108_journal_entries_minor_units.sql")).not.toMatch(/journal_entries_zz_fill_minor/);
    expect("journal_entries_aa_fill_minor" < "journal_entries_update_balance").toBe(true);
  });

  it("the balance check foots on the integer and refuses an unscaled leg by name", () => {
    /**
     * Without this a dinar book cannot post at all: three legs of 1.235
     * foot in fils and do not foot in their two-decimal mirrors.
     * And SUM() skips NULLs, so an unscaled leg must be named rather than
     * quietly making an unbalanced transaction look balanced.
     */
    const fn = MIGRATION.slice(MIGRATION.indexOf("FUNCTION public.enforce_double_entry_balance"));
    expect(fn).toMatch(/SUM\(CASE WHEN entry_type = 'debit'\s+THEN amount_minor/);
    expect(fn).toMatch(/FILTER \(WHERE amount_minor IS NULL\)/);
    expect(fn).toMatch(/have no amount_minor/);
  });

  it("every converted reader refuses an unscaled leg instead of summing around it", () => {
    /**
     * 🔴 THE SUBTLE ONE. `SUM()` IGNORES NULLS. A leg 0108 could not scale
     * would silently shrink a trial balance — and shrink it on BOTH sides
     * if the transaction had one leg of each — producing a report that is
     * short by a real amount and foots anyway. Every reader that now sums
     * `amountMinor` must also count the NULLs.
     */
    const readers = [
      "server/actions/accounting.ts",
      "server/actions/periods.ts",
      "server/actions/budgets.ts",
      "server/returns/assemble.ts",
      "server/command/sweep.ts",
      "server/sales/booking-ledger.ts",
      "server/actions/returns.ts",
      "lib/queue/processors.ts",
    ];
    for (const file of readers) {
      const code = read(file);
      expect(code, `${file} sums amountMinor`).toMatch(/journalEntries\.amountMinor/);
      expect(code, `${file} counts what it could not scale`).toMatch(/unscaledLegs/);
    }
  });

  it("the period-close and trial-balance gates compare integers, not floats", () => {
    /**
     * 🔴 THE GATE THAT SEALS A PERIOD USED TO BE
     * `Math.abs(debits - credits) < 0.005` over two `Number()`s — an
     * epsilon on IEEE-754 doubles, guarding the statement an auditor is
     * given. Two integers are equal or they are not.
     */
    const periods = read("server/actions/periods.ts");
    expect(periods).toMatch(/debitsMinor === creditsMinor/);
    expect(code("server/actions/periods.ts")).not.toMatch(/Math\.abs\(debits - credits\)/);

    const processors = read("lib/queue/processors.ts");
    expect(processors).toMatch(/isBalanced: totalDebitsMinor === totalCreditsMinor/);
    expect(code("lib/queue/processors.ts")).not.toMatch(/Math\.abs\(totalDebits - totalCredits\)/);
  });

  it("nothing between the ledger and a total multiplies by a hardcoded hundred", () => {
    /**
     * `rupeeStringToMinor` and `toPaise` both ended in `* 100n` and both
     * stood between `journal_entries` and a reported figure. They are
     * deleted, not left exported and unused.
     */
    expect(code("server/returns/assemble.ts")).not.toMatch(/rupeeStringToMinor/);
    expect(code("server/tally/exporter.ts")).not.toMatch(/toPaise/);
  });
});

/* ================================================================== */
/* D2 · THE BOOKS ARE NOT ASSUMED TO BE IN RUPEES                      */
/* ================================================================== */

describe("🔴 D2 — no posting stamps a currency it was not told", () => {
  it("no transaction writer names a currency literal", () => {
    /**
     * 🔴 THE DEFECT, AS A PROPERTY. Nine writers wrote `currency: "INR"`.
     * A view can only group by what the column says; 1.66.0's
     * `v_ledger_daily` now faithfully groups a dirham book under INR
     * because the writer put INR there. Any literal on a `currency:` key
     * in this file is that bug returning.
     */
    const literals = code("server/accounting/post-sales.ts").match(/^\s*currency:\s*"[A-Z]{3}"/gm) ?? [];
    expect(literals).toEqual([]);
  });

  it("the functional currency is read from the tenant, with no default", () => {
    expect(POST_SALES).toMatch(/functionalCurrencyFromSettings\(/);
    expect(POST_SALES).toMatch(/const functionalCurrency = await functionalCurrencyFor\(tx, args\.tenantId\)/);
    // ⚠️ A workspace that cannot be read must not silently become INR.
    expect(POST_SALES).toMatch(/could not be read/);
  });

  it("every writer that stamps a currency resolved one first", () => {
    /**
     * The property that survives somebody adding an eleventh writer:
     * `currency: functionalCurrency` may not appear without a
     * `functionalCurrencyFor` call in the same function.
     */
    const uses = (POST_SALES.match(/currency: functionalCurrency,/g) ?? []).length;
    const resolves = (POST_SALES.match(/await functionalCurrencyFor\(/g) ?? []).length;
    expect(uses).toBeGreaterThan(0);
    expect(resolves).toBeGreaterThanOrEqual(uses);
  });

  it("totals are formatted with the currency's own exponent", () => {
    // `formatMoneyPlain` is a hardcoded two decimals; `formatMinorPlain`
    // reads the exponent per currency.
    expect(POST_SALES).toMatch(/totalAmount: formatMinorPlain\(debitTotal, functionalCurrency\)/);
    expect(formatMinorPlain(1234n, "JPY")).toBe("1234");
    expect(formatMinorPlain(1234n, "KWD")).toBe("1.234");
    expect(formatMinorPlain(1234n, "INR")).toBe("12.34");
  });

  it("a manual journal in a three-decimal currency can be entered at all", () => {
    /**
     * 🔴 `amountSchema` USED TO BE `\\d{1,2}` DECIMALS AND THE BALANCE
     * CHECK USED `toMinorUnits`, a hardcoded x100 whose regex refused a
     * third decimal. A Kuwaiti user typing 1.234 was told "at most 2
     * decimals" — not true of their currency, and no retyping would fix it.
     */
    const dinar = postTransactionSchema.safeParse({
      description: "Dinar journal",
      transactionDate: "2026-08-01",
      currency: "KWD",
      legs: [
        { ledgerId: "11111111-1111-4111-8111-111111111111", entryType: "debit", amount: "1.234" },
        { ledgerId: "22222222-2222-4222-8222-222222222222", entryType: "credit", amount: "1.234" },
      ],
    });
    expect(dinar.success).toBe(true);

    // ⭐ AND THE SAME STRING IS STILL REFUSED IN RUPEES, by name. A
    // currency-aware check is not a looser check.
    const rupees = postTransactionSchema.safeParse({
      description: "Rupee journal",
      transactionDate: "2026-08-01",
      currency: "INR",
      legs: [
        { ledgerId: "11111111-1111-4111-8111-111111111111", entryType: "debit", amount: "1.234" },
        { ledgerId: "22222222-2222-4222-8222-222222222222", entryType: "credit", amount: "1.234" },
      ],
    });
    expect(rupees.success).toBe(false);
  });

  it("an unbalanced journal is still refused, in whatever currency", () => {
    const bad = postTransactionSchema.safeParse({
      description: "Unbalanced",
      transactionDate: "2026-08-01",
      currency: "KWD",
      legs: [
        { ledgerId: "11111111-1111-4111-8111-111111111111", entryType: "debit", amount: "1.235" },
        { ledgerId: "22222222-2222-4222-8222-222222222222", entryType: "credit", amount: "1.234" },
      ],
    });
    expect(bad.success).toBe(false);
  });
});

/* ================================================================== */
/* D3 · EVERY ROLE A BUILDER EMITS CAN BE MAPPED                       */
/* ================================================================== */

describe("🔴 D3 — the posting-accounts screen reaches every role", () => {
  const FAMILIES: ReadonlyArray<readonly [PostingModuleKey, Record<string, unknown>]> = [
    ["sales", POSTING_ROLE_META],
    ["purchase", PURCHASE_ROLE_META],
    ["construction", CONSTRUCTION_ROLE_META],
    ["property", PROPERTY_ROLE_META],
    ["metering", METERING_ROLE_META],
    ["payroll", PAYROLL_ROLE_META],
    ["gst_return", RETURN_ROLE_META],
    ["fixed_assets", FIXED_ASSET_ROLE_META],
    ["fx", FX_ROLE_META],
  ];

  it("🔴 every role any builder can emit is in the registry", () => {
    /**
     * THE INVARIANT THE OLD SCREEN BROKE. `ALL_ROLE_META` was
     * `{...POSTING, ...PURCHASE, ...CONSTRUCTION, ...PROPERTY}` — four of
     * nine families — so twenty-seven roles that every posting path checks
     * were invisible to the form. No count is pinned here: adding a tenth
     * family and forgetting the registry is what this fails on.
     */
    for (const [, meta] of FAMILIES) {
      for (const role of Object.keys(meta)) {
        expect(POSTING_ROLE_KEYS, `${role} must be mappable`).toContain(role);
      }
    }
  });

  it("🔴 every role in the registry is ACCEPTED by the write path", () => {
    /**
     * THE HALF THAT MADE IT A CLOSED LOOP. `setSalesPostingAccount`
     * validated with `z.enum(Object.keys(ALL_ROLE_META))`, so `fx_gain`
     * was not merely missing from the form — the server action REFUSED it.
     * The FX refusal said "map them on the posting-accounts screen"; the
     * screen would have rejected the write.
     */
    expect(SETUP_ACTION).toMatch(/z\.enum\(POSTING_ROLE_KEYS/);
    expect(code("server/actions/sales-posting.ts")).not.toMatch(/Object\.keys\(ALL_ROLE_META\)/);
  });

  it("names the module behind every role, and a shared role names all of them", () => {
    for (const entry of POSTING_ROLE_REGISTRY) {
      expect(entry.modules.length).toBeGreaterThan(0);
      for (const m of entry.modules) expect(POSTING_MODULES[m]).toBeDefined();
    }
    /**
     * ⚠️ THE OLD `side` WAS A PRECEDENCE CHAIN AND GAVE ONE ANSWER WHERE
     * THE TRUTH IS SEVERAL. `bank` is needed by a sales receipt and by a
     * vendor payment; calling it "a sales role" is why nobody maps it
     * before running payroll.
     */
    expect(modulesNeeding("bank")).toContain("sales");
    expect(modulesNeeding("bank")).toContain("purchase");
    expect(modulesNeeding("output_cgst")).toContain("gst_return");
  });

  it("the form groups by module and no longer knows about `side`", () => {
    expect(SETUP_FORM).toMatch(/moduleStatus/);
    expect(code("components/invoices/posting-setup.tsx")).not.toMatch(/r\.side === side/);
    // The deep-link anchor the refusal messages point at must exist.
    expect(SETUP_FORM).toMatch(/id=\{`module-\$\{mod\.key\}`\}/);
  });

  it("🔴 the refusals that named a screen now name its address", () => {
    /**
     * `fixedAssetAccountsNeeded()` computed exactly which accounts were
     * missing, listed them, explained each — and offered no way to go and
     * map any of them. 0100 shipped a depreciation engine no navigation
     * reached for four batches; this was the same defect one level down.
     */
    expect(postingAccountsHref("fixed_assets")).toBe("/accounting/posting#module-fixed_assets");
    expect(read("server/actions/fixed-assets.ts")).toMatch(/mapAccountsSentence\("fixed_assets"\)/);
    expect(read("app/(crm)/fixed-assets/page.tsx")).toMatch(
      /postingAccountsHref\("fixed_assets"\)/,
    );
  });

  it("the screen it points at is reachable from the menu", () => {
    // ⚠️ Built-and-unreachable is the same defect wearing a different hat.
    expect(read("lib/modules/registry.ts")).toMatch(/href: "\/accounting\/posting"/);
  });
});

/* ================================================================== */
/* THE HOUSE RULES THIS FILE MUST NOT BREAK                            */
/* ================================================================== */

describe("0108 obeys the migration rules that have cost this project time", () => {
  it("has no BEGIN and no COMMIT", () => {
    const sql = code("SQL-FILES/0108_journal_entries_minor_units.sql");
    expect(sql).not.toMatch(/^\s*BEGIN;/m);
    expect(sql).not.toMatch(/^\s*COMMIT;/m);
  });

  it("never sets platform scope as a bare statement", () => {
    // `SET LOCAL app.platform_scope` on its own line reports success and
    // has evaporated before the next statement runs.
    expect(code("SQL-FILES/0108_journal_entries_minor_units.sql")).not.toMatch(/^\s*SET LOCAL app\.platform_scope/m);
    expect(MIGRATION).toMatch(/PERFORM set_config\('app\.platform_scope', 'on', true\)/);
  });

  it("puts the diagnostic in front of the risky section", () => {
    expect(MIGRATION.indexOf("0108 · who is running this")).toBeLessThan(
      MIGRATION.indexOf("DO $backfill$"),
    );
    // ⚠️ And it prints who is running, because a drill run as `postgres`
    // passes every refusal test and proves nothing.
    expect(MIGRATION).toMatch(/is_superuser/);
    expect(MIGRATION).toMatch(/bypasses_rls/);
  });

  it("is idempotent statement by statement", () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS amount_minor/);
    expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(MIGRATION).toMatch(/DROP TRIGGER IF EXISTS .* ON public\.journal_entries/);
    expect(MIGRATION).toMatch(/DROP CONSTRAINT IF EXISTS/);
    expect(MIGRATION).toMatch(/WHERE .*amount_minor IS NULL/s);
  });

  it("states BOTH deploy orders, because one of them is fatal", () => {
    expect(MIGRATION).toMatch(/IF THE SQL LANDS FIRST/);
    expect(MIGRATION).toMatch(/IF THE CODE LANDS FIRST/);
    expect(MIGRATION).toMatch(/42703/);
  });

  it("carries a rollback, and says where the rollback stops working", () => {
    expect(MIGRATION).toMatch(/DROP COLUMN IF EXISTS amount_minor/);
    expect(MIGRATION).toMatch(/THE ROLLBACK IS NOT AVAILABLE THE OTHER WAY ROUND/);
  });
});
