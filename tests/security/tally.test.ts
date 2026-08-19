/**
 * Ordence — ⭐ Tally Integration
 * Version: v0.37.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Thirty-six phases say the same thing: the defects that survive are the
 * SILENT ones. This phase is silent in a new way — the failure happens in
 * a system this product does not own, days after the button was pressed,
 * and every screen on both sides looks correct.
 *
 *   • ⭐⭐ THE DOUBLE POST. April is exported and imported. A mapping is
 *     corrected and April is exported again. Tally does not de-duplicate
 *     on voucher number, date or amount — only on REMOTEID — so if one
 *     key comes out different, Tally adds a SECOND voucher. Both balance.
 *     The trial balance balances. Every register foots. April's revenue
 *     is simply twice what it was, and it is found at the year end by an
 *     auditor comparing the books to the GSTR-1.
 *
 *   • ⚠️ AN UNBALANCED VOUCHER. Tally rejects it part-way through an
 *     import, naming a voucher number in a file of two thousand, and on
 *     several builds abandons the rest — leaving an unknown prefix of
 *     March in somebody's statutory books.
 *
 *   • ⚠️ AN UNESCAPED AMPERSAND. "Shah & Sons" produces XML that is not
 *     well-formed. Tally answers "0 vouchers imported", or imports
 *     everything up to that character and stops.
 *
 *   • ⚠️ A LEDGER NAME THAT DOES NOT MATCH. Tally does not fail — it
 *     CREATES the ledger under a group it guesses and posts to it.
 *
 * So the tests below do not inspect constraints. They generate an export
 * twice and demand the same keys. They put `&`, `<`, `>`, `"`, `'` and a
 * control character into a vendor's name and round-trip it through the
 * XML. They reconcile a Tally file with one voucher missing and one
 * voucher ₹500 out and demand exactly those two findings.
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears only for fixtures and teardown, because a
 * superuser bypasses row-level security entirely and a suite written on
 * one proves nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, withoutTenant, expectError } from "../setup";

import {
  escapeXmlText,
  escapeXmlAttribute,
  decodeXmlEntities,
  sanitiseXmlText,
  isXmlSafe,
  renderDocument,
  leaf,
  compact,
  InvalidXmlTagError,
  type TallyXmlNode,
} from "@/lib/tally/xml";
import {
  formatTallyAmount,
  parseTallyAmount,
  toTallyDate,
  fromTallyDate,
  TallyAmountError,
} from "@/lib/tally/amounts";
import {
  deterministicRemoteId,
  isOurRemoteId,
  voucherContentHash,
  payloadHash,
  REMOTE_ID_PREFIX,
} from "@/lib/tally/keys";
import {
  buildLedgerIndex,
  resolveLedger,
  tryResolveLedger,
  foldLedgerName,
  findDuplicateNames,
  assessMapping,
  ledgerMasterNode,
  UnmappedLedgerError,
  TALLY_PRIMARY_GROUPS,
  TALLY_TAX_HEADS,
  type LedgerMapping,
} from "@/lib/tally/ledgers";
import {
  assertVoucherBalances,
  buildVoucher,
  buildSalesVoucher,
  buildPurchaseVoucher,
  buildReceiptVoucher,
  buildPaymentVoucher,
  buildJournalVoucher,
  buildContraVoucher,
  buildCreditNoteVoucher,
  buildDebitNoteVoucher,
  classifyVoucherType,
  draftContentHash,
  draftEntriesForStorage,
  voucherTotals,
  VoucherImbalanceError,
  VoucherShapeError,
  TALLY_VOUCHER_TYPE_NAMES,
  type VoucherFacts,
  type VoucherLeg,
} from "@/lib/tally/vouchers";
import {
  buildImportEnvelope,
  buildVoucherExportRequest,
} from "@/lib/tally/envelope";
import {
  parseXml,
  parseTallyExport,
  parseImportResponse,
  findAll,
  childText,
} from "@/lib/tally/parse";
import {
  reconcileVouchers,
  summariseReconciliation,
  type OurVoucherFacts,
} from "@/lib/tally/reconcile";
import {
  checkTallyEndpoint,
  isAlwaysForbiddenAddress,
} from "@/lib/tally/endpoint";
import {
  upsertTallyConnectionSchema,
  upsertTallyLedgerMappingSchema,
  generateTallyExportSchema,
  importTallyExportSchema,
  resolveReconciliationItemSchema,
  tallyLedgerNameSchema,
} from "@/lib/validators/tally";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantA: string;
let tenantB: string;
let userA: string;

let ledgerBankA: string;
let ledgerSalesA: string;
let ledgerDebtorA: string;
let ledgerB: string;

let mappingBankA: string;
let batchA: string;
let batchB: string;
let voucherA: string;
let importBatchA: string;
let importBatchB: string;

const RUPEE = 100n;
const R = (n: number | bigint) => BigInt(n) * RUPEE;

/** A key of the exact shape the database CHECK demands. */
const keyOf = (a: string, b: string, c: string) =>
  `${REMOTE_ID_PREFIX}-${a.repeat(8)}-${b.repeat(8)}-${c.repeat(24)}`;

const HASH_64 = "a".repeat(64);

/**
 * ⭐ THE VENDOR WHOSE NAME BREAKS XML.
 *
 * Every character that has to be escaped, plus a control character that
 * cannot be carried at all — which is what a paste out of a PDF or a
 * legacy accounting package actually produces.
 */
const HOSTILE_NAME = 'Shah & Sons <Pvt> "Builders" \u0001 O’Neill\'s';
const HOSTILE_NAME_CLEAN = 'Shah & Sons <Pvt> "Builders"  O’Neill\'s';

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA = randomUUID();
  ledgerBankA = randomUUID();
  ledgerSalesA = randomUUID();
  ledgerDebtorA = randomUUID();
  ledgerB = randomUUID();
  mappingBankA = randomUUID();
  batchA = randomUUID();
  batchB = randomUUID();
  voucherA = randomUUID();
  importBatchA = randomUUID();
  importBatchB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Tally Isolation A"],
      [tenantB, "Tally Isolation B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `tally-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'tally-a@example.test','tenant_admin','active')`,
      [userA, tenantA, `usr_${userA}`],
    );

    await c.query(
      `INSERT INTO ledgers (id, tenant_id, name, code, account_type)
       VALUES ($1,$2,'Bank — Current','1100','asset'),
              ($3,$2,'Sales — Residential','4000','revenue'),
              ($4,$2,'Sundry Debtors','1200','asset')`,
      [ledgerBankA, tenantA, ledgerSalesA, ledgerDebtorA],
    );
    await c.query(
      `INSERT INTO ledgers (id, tenant_id, name, code, account_type)
       VALUES ($1,$2,'B''s Bank','1100','asset')`,
      [ledgerB, tenantB],
    );

    await c.query(
      `INSERT INTO tally_ledger_mappings
         (id, tenant_id, source_kind, source_id, tally_ledger_name,
          tally_parent_group)
       VALUES ($1,$2,'ledger',$3,'HDFC Bank A/c','bank_accounts')`,
      [mappingBankA, tenantA, ledgerBankA],
    );
    await c.query(
      `INSERT INTO tally_ledger_mappings
         (tenant_id, source_kind, source_key, tally_ledger_name, tally_parent_group)
       VALUES ($1,'tax_head','output_cgst','Output CGST','duties_and_taxes')`,
      [tenantA],
    );
    await c.query(
      `INSERT INTO tally_ledger_mappings
         (tenant_id, source_kind, source_id, tally_ledger_name, tally_parent_group)
       VALUES ($1,'ledger',$2,'B Bank A/c','bank_accounts')`,
      [tenantB, ledgerB],
    );

    await c.query(
      `INSERT INTO tally_connections
         (tenant_id, name, company_name, host, port, allow_private_host)
       VALUES ($1,'A office','Ordence Pvt Ltd','192.168.1.20',9000,true)`,
      [tenantA],
    );
    await c.query(
      `INSERT INTO tally_connections (tenant_id, name, company_name)
       VALUES ($1,'B office','B Builders Pvt Ltd')`,
      [tenantB],
    );

    /* --- ⭐ A DELIVERED batch in A, with one voucher. ------------ */
    //
    // ⚠️ EXPLICIT BEGIN/COMMIT. The batch-totals guard is DEFERRABLE
    // INITIALLY DEFERRED, and `adminPool` runs in autocommit — where each
    // statement is its own transaction and the guard would fire before
    // the voucher rows caught up with the stated totals. The real write
    // path builds a batch in one transaction, which is what this
    // reproduces.
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO tally_export_batches
         (id, tenant_id, batch_number, period_start, period_end, company_name,
          status, voucher_count, total_debit_minor, total_credit_minor,
          payload_hash, generated_at, delivered_at)
       VALUES ($1,$2,'TALLY/2026-04/001', DATE '2026-04-01', DATE '2026-04-30',
               'Ordence Pvt Ltd','delivered',1,$3,$3,$4, now(), now())`,
      [batchA, tenantA, (R(100_000)).toString(), HASH_64],
    );
    await c.query(
      `INSERT INTO tally_vouchers
         (id, tenant_id, batch_id, voucher_type, remote_id, voucher_number,
          voucher_date, source_type, source_id, party_ledger_name,
          total_debit_minor, total_credit_minor, content_hash)
       VALUES ($1,$2,$3,'sales',$4,'AH/2026/0041', DATE '2026-04-12',
               'transaction',$5,'Shah & Sons',$6,$6,$7)`,
      [
        voucherA,
        tenantA,
        batchA,
        keyOf("a", "b", "c"),
        randomUUID(),
        R(100_000).toString(),
        HASH_64,
      ],
    );
    await c.query("COMMIT");

    await c.query("BEGIN");
    await c.query(
      `INSERT INTO tally_export_batches
         (id, tenant_id, batch_number, period_start, period_end, company_name,
          status, voucher_count, total_debit_minor, total_credit_minor,
          payload_hash, generated_at)
       VALUES ($1,$2,'TALLY/2026-04/001', DATE '2026-04-01', DATE '2026-04-30',
               'B Builders Pvt Ltd','generated',1,$3,$3,$4, now())`,
      [batchB, tenantB, R(55_000).toString(), "b".repeat(64)],
    );
    await c.query(
      `INSERT INTO tally_vouchers
         (tenant_id, batch_id, voucher_type, remote_id, voucher_number,
          voucher_date, source_type, source_id,
          total_debit_minor, total_credit_minor, content_hash)
       VALUES ($1,$2,'journal',$3,'B/2026/0001', DATE '2026-04-15',
               'transaction',$4,$5,$5,$6)`,
      [
        tenantB,
        batchB,
        keyOf("d", "e", "f"),
        randomUUID(),
        R(55_000).toString(),
        "b".repeat(64),
      ],
    );
    await c.query("COMMIT");

    /* --- Import batches and one finding each. -------------------- */
    await c.query(
      `INSERT INTO tally_import_batches
         (id, tenant_id, source_label, period_start, period_end, payload_hash,
          status, difference_count, unresolved_count)
       VALUES ($1,$2,'daybook-april.xml', DATE '2026-04-01', DATE '2026-04-30',
               $3,'reconciled',1,1)`,
      [importBatchA, tenantA, "c".repeat(64)],
    );
    await c.query(
      `INSERT INTO tally_import_batches
         (id, tenant_id, source_label, period_start, period_end, payload_hash,
          status, difference_count, unresolved_count)
       VALUES ($1,$2,'b-daybook.xml', DATE '2026-04-01', DATE '2026-04-30',
               $3,'reconciled',1,1)`,
      [importBatchB, tenantB, "d".repeat(64)],
    );
    await c.query(
      `INSERT INTO tally_reconciliation_items
         (tenant_id, import_batch_id, kind, remote_id, our_voucher_id,
          our_voucher_number, our_amount_minor, explanation)
       VALUES ($1,$2,'missing_in_tally',$3,$4,'AH/2026/0041',$5,
               'We exported it and Tally does not have it.')`,
      [tenantA, importBatchA, keyOf("a", "b", "c"), voucherA, R(100_000).toString()],
    );
    await c.query(
      `INSERT INTO tally_reconciliation_items
         (tenant_id, import_batch_id, kind, their_voucher_number,
          their_amount_minor, explanation)
       VALUES ($1,$2,'missing_in_ours','B/9999',$3,'Their year-end journal.')`,
      [tenantB, importBatchB, R(1_000).toString()],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [
      [tenantA, tenantB],
    ]);
  });
});

/* ================================================================== */
/* 1. CROSS-TENANT ISOLATION                                           */
/* ================================================================== */

describe("cross-tenant isolation", () => {
  it("a workspace sees only its own Tally rows on every table", async () => {
    for (const table of [
      "tally_connections",
      "tally_ledger_mappings",
      "tally_export_batches",
      "tally_vouchers",
      "tally_import_batches",
      "tally_reconciliation_items",
    ]) {
      const mine = await asTenant(tenantA, async (c) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id <> $1`,
          [tenantA],
        );
        return rows[0]?.n ?? -1;
      });
      expect(mine, `${table} leaked rows to another tenant`).toBe(0);
    }
  });

  it("A cannot read B's export batches even by naming the id", async () => {
    const rows = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM tally_export_batches WHERE id = $1`,
        [batchB],
      );
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("⭐ A cannot read B's vouchers — the party names and amounts on them are B's whole commercial position", async () => {
    const rows = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT party_ledger_name, total_debit_minor FROM tally_vouchers
         WHERE tenant_id = $1`,
        [tenantB],
      );
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("no tenant context reads ZERO rows, never all rows", async () => {
    const counts = await withoutTenant(async (c) => {
      const { rows } = await c.query(
        `SELECT (SELECT count(*)::int FROM tally_vouchers)        AS v,
                (SELECT count(*)::int FROM tally_export_batches)  AS b,
                (SELECT count(*)::int FROM tally_ledger_mappings) AS m`,
      );
      return rows[0];
    });
    expect(counts.v).toBe(0);
    expect(counts.b).toBe(0);
    expect(counts.m).toBe(0);
  });

  it("A cannot plant a mapping stamped with B's tenant id (WITH CHECK)", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_ledger_mappings
             (tenant_id, source_kind, source_key, tally_ledger_name,
              tally_parent_group)
           VALUES ($1,'tax_head','input_igst','Planted','duties_and_taxes')`,
          [tenantB],
        ),
      ),
    );
    expect(error).not.toBeNull();
  });

  it("⭐ A cannot put a voucher inside B's export batch — it would go into B's Tally company", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_vouchers
             (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
              source_type, source_id, total_debit_minor, total_credit_minor,
              content_hash)
           VALUES ($1,$2,'sales',$3, DATE '2026-04-20','transaction',$4,
                   1000,1000,$5)`,
          [tenantA, batchB, keyOf("1", "2", "3"), randomUUID(), HASH_64],
        ),
      ),
    );
    expect(error).not.toBeNull();
    // A composite foreign key, not a policy — the FK check runs as the
    // system and ignores RLS, which is precisely why it is composite.
    expect(error?.code).toBe("23503");
  });

  it("⭐ A cannot map another workspace's ledger — a polymorphic column has no composite FK to lean on", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_ledger_mappings
             (tenant_id, source_kind, source_id, tally_ledger_name,
              tally_parent_group)
           VALUES ($1,'ledger',$2,'Stolen Ledger','bank_accounts')`,
          [tenantA, ledgerB],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/No ledger exists in this workspace/i);
  });

  it("A cannot attach a reconciliation finding to B's import batch", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_reconciliation_items
             (tenant_id, import_batch_id, kind, their_voucher_number, explanation)
           VALUES ($1,$2,'missing_in_ours','X/1','planted')`,
          [tenantA, importBatchB],
        ),
      ),
    );
    expect(error).not.toBeNull();
  });

  it("⚠️ the application role cannot DELETE an export batch — losing it is what makes the next export re-send everything", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`DELETE FROM tally_export_batches WHERE id = $1`, [batchA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});

/* ================================================================== */
/* 2. ⭐⭐ EVERY GENERATED VOUCHER BALANCES                             */
/* ================================================================== */

describe("⭐⭐ every generated voucher balances", () => {
  const facts = (legs: VoucherLeg[], extra?: Partial<VoucherFacts>): VoucherFacts => ({
    tenantId: tenantA,
    sourceType: "transaction",
    sourceId: "11111111-1111-4111-8111-111111111111",
    voucherNumber: "AH/2026/0001",
    voucherDate: "2026-04-12",
    partyLedgerName: "Shah & Sons",
    legs,
    ...extra,
  });

  const twoSided = (amount: bigint): VoucherLeg[] => [
    { ledgerName: "Shah & Sons", isDebit: true, amountMinor: amount },
    { ledgerName: "Sales A/c", isDebit: false, amountMinor: amount },
  ];

  it("⭐ all eight voucher types build and balance", () => {
    const cases: Array<[string, () => unknown]> = [
      ["sales", () => buildSalesVoucher(facts(twoSided(R(118_000))))],
      ["purchase", () => buildPurchaseVoucher(facts(twoSided(R(59_000))))],
      [
        "receipt",
        () =>
          buildReceiptVoucher(
            facts(twoSided(R(25_000)), { partyLedgerName: "Shah & Sons" }),
          ),
      ],
      ["payment", () => buildPaymentVoucher(facts(twoSided(R(25_000))))],
      ["journal", () => buildJournalVoucher(facts(twoSided(R(1_250))))],
      [
        "contra",
        () =>
          buildContraVoucher(
            facts(
              [
                { ledgerName: "HDFC Bank A/c", isDebit: true, amountMinor: R(50_000) },
                { ledgerName: "Cash", isDebit: false, amountMinor: R(50_000) },
              ],
              { partyLedgerName: null },
            ),
          ),
      ],
      ["credit_note", () => buildCreditNoteVoucher(facts(twoSided(R(5_000))))],
      ["debit_note", () => buildDebitNoteVoucher(facts(twoSided(R(3_000))))],
    ];

    for (const [name, build] of cases) {
      const draft = build() as ReturnType<typeof buildJournalVoucher>;
      const totals = voucherTotals(draft.legs);
      expect(totals.debitMinor, `${name} debits`).toBe(totals.creditMinor);
      expect(totals.debitMinor, `${name} is not empty`).toBeGreaterThan(0n);
      expect(draft.voucherType).toBe(name);
    }
  });

  it("⭐⭐ an unbalanced voucher is REFUSED, and the message says why it matters", () => {
    expect(() =>
      buildJournalVoucher(
        facts([
          { ledgerName: "Cement", isDebit: true, amountMinor: R(100_000) },
          { ledgerName: "Vendor", isDebit: false, amountMinor: R(99_000) },
        ]),
      ),
    ).toThrow(VoucherImbalanceError);

    try {
      buildJournalVoucher(
        facts([
          { ledgerName: "Cement", isDebit: true, amountMinor: R(100_000) },
          { ledgerName: "Vendor", isDebit: false, amountMinor: R(99_000) },
        ]),
      );
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/out by 1000\.00/);
      expect(message).toMatch(/has NOT been written/);
    }
  });

  it("⭐ ONE PAISA out is refused too — a three-way GST split of an odd amount is exactly how it happens", () => {
    expect(() =>
      buildJournalVoucher(
        facts([
          { ledgerName: "A", isDebit: true, amountMinor: 100_00n },
          { ledgerName: "B", isDebit: false, amountMinor: 99_99n },
        ]),
      ),
    ).toThrow(VoucherImbalanceError);
  });

  it("a NEGATIVE leg is refused — direction is a field, never a sign", () => {
    expect(() =>
      buildJournalVoucher(
        facts([
          { ledgerName: "A", isDebit: true, amountMinor: -R(100) },
          { ledgerName: "B", isDebit: false, amountMinor: -R(100) },
        ]),
      ),
    ).toThrow(VoucherShapeError);
  });

  it("a ZERO leg is refused — Tally shows a ledger line of nothing", () => {
    expect(() =>
      buildJournalVoucher(
        facts([
          { ledgerName: "A", isDebit: true, amountMinor: 0n },
          { ledgerName: "B", isDebit: false, amountMinor: 0n },
        ]),
      ),
    ).toThrow(VoucherShapeError);
  });

  it("a voucher with NO legs is refused — it balances trivially and moves nothing", () => {
    expect(() => buildJournalVoucher(facts([]))).toThrow(VoucherShapeError);
  });

  it("⭐ a PARTIAL cost-centre allocation is refused — Tally parks the remainder where nobody looks", () => {
    expect(() =>
      buildPurchaseVoucher(
        facts([
          {
            ledgerName: "Cement",
            isDebit: true,
            amountMinor: R(100_000),
            costCentres: [
              { category: "Primary Cost Category", name: "Tower A", amountMinor: R(60_000) },
            ],
          },
          { ledgerName: "Vendor", isDebit: false, amountMinor: R(100_000) },
        ]),
      ),
    ).toThrow(/parks the remainder as unallocated/);
  });

  it("⭐ a FULL cost-centre split across two projects is accepted", () => {
    const draft = buildPurchaseVoucher(
      facts([
        {
          ledgerName: "Cement",
          isDebit: true,
          amountMinor: R(100_000),
          costCentres: [
            { category: "Primary Cost Category", name: "Tower A", amountMinor: R(60_000) },
            { category: "Primary Cost Category", name: "Tower B", amountMinor: R(40_000) },
          ],
        },
        { ledgerName: "Vendor", isDebit: false, amountMinor: R(100_000) },
      ]),
    );
    expect(draft.legs[0]?.costCentres).toHaveLength(2);
  });

  it("⚠️ a contra carrying a party is refused — Tally refuses it as a failed import", () => {
    expect(() =>
      buildContraVoucher(
        facts([
          { ledgerName: "HDFC", isDebit: true, amountMinor: R(1_000) },
          { ledgerName: "Cash", isDebit: false, amountMinor: R(1_000) },
        ]),
      ),
    ).toThrow(/may not carry a party/);
  });

  it("⚠️ a sales voucher with NO party is refused — it would appear in no GST report at all", () => {
    expect(() =>
      buildSalesVoucher(facts(twoSided(R(1_000)), { partyLedgerName: null })),
    ).toThrow(/must name a party/);
  });

  it("⭐⭐ the DATABASE refuses an unbalanced voucher too — the builder is not the only write path", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_vouchers
             (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
              source_type, source_id, total_debit_minor, total_credit_minor,
              content_hash)
           VALUES ($1,$2,'journal',$3, DATE '2026-04-20','transaction',$4,
                   10000000, 9999900, $5)`,
          [tenantA, batchA, keyOf("9", "8", "7"), randomUUID(), HASH_64],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/tally_vouchers_balances/);
  });

  it("⭐ the DATABASE refuses a key that is not one of ours — a randomUUID would duplicate on every re-export", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_vouchers
             (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
              source_type, source_id, total_debit_minor, total_credit_minor,
              content_hash)
           VALUES ($1,$2,'journal',$3, DATE '2026-04-20','transaction',$4,
                   1000,1000,$5)`,
          [tenantA, batchA, randomUUID(), randomUUID(), HASH_64],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/tally_vouchers_remote_id_shape/);
  });

  it("classifyVoucherType reads recorded decisions, never an account name", () => {
    expect(
      classifyVoucherType({
        referenceType: "invoice",
        legs: [
          { group: "sundry_creditors", isDebit: false },
          { group: "purchase_accounts", isDebit: true },
        ],
      }),
    ).toBe("purchase");

    expect(
      classifyVoucherType({
        referenceType: "invoice",
        legs: [
          { group: "sundry_debtors", isDebit: true },
          { group: "sales_accounts", isDebit: false },
        ],
      }),
    ).toBe("sales");

    // ⚠️ ALL legs must be cash/bank. A bank charge makes it a payment.
    expect(
      classifyVoucherType({
        referenceType: "payment",
        legs: [
          { group: "bank_accounts", isDebit: false },
          { group: "cash_in_hand", isDebit: true },
        ],
      }),
    ).toBe("contra");
    expect(
      classifyVoucherType({
        referenceType: "payment",
        legs: [
          { group: "bank_accounts", isDebit: false },
          { group: "cash_in_hand", isDebit: true },
          { group: "indirect_expenses", isDebit: true },
        ],
      }),
    ).toBe("payment");

    // ⚠️ The note's direction is the PARTY'S direction.
    expect(
      classifyVoucherType({
        referenceType: "adjustment",
        legs: [
          { group: "sundry_debtors", isDebit: false },
          { group: "sales_accounts", isDebit: true },
        ],
      }),
    ).toBe("credit_note");
    expect(
      classifyVoucherType({
        referenceType: "adjustment",
        legs: [
          { group: "sundry_creditors", isDebit: true },
          { group: "purchase_accounts", isDebit: false },
        ],
      }),
    ).toBe("debit_note");

    // The always-correct-if-dull fallback.
    expect(
      classifyVoucherType({
        referenceType: "opening_balance",
        legs: [
          { group: "capital_account", isDebit: false },
          { group: "fixed_assets", isDebit: true },
        ],
      }),
    ).toBe("journal");
  });
});

/* ================================================================== */
/* 3. ⭐ XML ESCAPING                                                   */
/* ================================================================== */

describe("⭐ XML escaping", () => {
  it("escapes all five characters that break a document", () => {
    expect(escapeXmlText("&")).toBe("&amp;");
    expect(escapeXmlText("<")).toBe("&lt;");
    expect(escapeXmlText(">")).toBe("&gt;");
    expect(escapeXmlText('"')).toBe("&quot;");
    expect(escapeXmlText("'")).toBe("&apos;");
  });

  it("⭐ escapes the AMPERSAND FIRST — the ordering bug that produces &amp;lt;", () => {
    // If `<` were escaped before `&`, this would come out as `&amp;lt;`
    // and the accountant's file would contain the literal text "&lt;".
    expect(escapeXmlText("<")).toBe("&lt;");
    expect(escapeXmlText("&lt;")).toBe("&amp;lt;");
    expect(escapeXmlText("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("⭐ Tally's OWN group name contains an ampersand — the first value we ever send", () => {
    expect(TALLY_PRIMARY_GROUPS.duties_and_taxes).toBe("Duties & Taxes");
    const rendered = renderDocument({
      tag: "PARENT",
      text: TALLY_PRIMARY_GROUPS.duties_and_taxes,
    });
    expect(rendered).toContain("<PARENT>Duties &amp; Taxes</PARENT>");
    expect(rendered).not.toMatch(/<PARENT>[^<]*[&][^a-z#]/);
  });

  it("⭐ CONTROL CHARACTERS ARE REMOVED, NOT ESCAPED — &#x1B; is also illegal XML", () => {
    const { value, removed } = sanitiseXmlText("Shah\u0001 &\u001B Sons\u0000");
    expect(removed).toBe(3);
    expect(value).toBe("Shah & Sons");
    expect(escapeXmlText("a\u0001b")).toBe("ab");
    // ⚠️ Tab, newline and carriage return ARE legal and must survive.
    expect(sanitiseXmlText("a\tb\nc\rd").removed).toBe(0);
    expect(isXmlSafe("plain")).toBe(true);
    expect(isXmlSafe("bad\u0007")).toBe(false);
  });

  it("a lone surrogate is removed — String allows it and UTF-8 cannot encode it", () => {
    expect(sanitiseXmlText("a\uD800b").removed).toBe(1);
    // A well-formed pair survives.
    expect(sanitiseXmlText("a\u{1F600}b").removed).toBe(0);
  });

  it("attribute escaping closes the quote-injection route", () => {
    const node: TallyXmlNode = {
      tag: "VOUCHER",
      attrs: { REMOTEID: 'x" ACTION="Delete' },
      text: "",
      keepEmpty: true,
    };
    const rendered = renderDocument(node);
    expect(rendered).toContain('REMOTEID="x&quot; ACTION=&quot;Delete"');
    // Exactly ONE ACTION attribute survives — the injected one did not.
    expect(rendered.match(/ ACTION="/g) ?? []).toHaveLength(0);
    expect(escapeXmlAttribute('a"b')).toBe("a&quot;b");
  });

  it("⚠️ a tag name is validated, never escaped — it is built by us and never from data", () => {
    expect(() => renderDocument({ tag: "BAD TAG", text: "x" })).toThrow(
      InvalidXmlTagError,
    );
    expect(() => renderDocument({ tag: "<script>", text: "x" })).toThrow(
      InvalidXmlTagError,
    );
    // Tally's own dotted list tags are legal.
    expect(() =>
      renderDocument({ tag: "ALLLEDGERENTRIES.LIST", text: "x" }),
    ).not.toThrow();
  });

  it("⭐⭐ a whole envelope containing a hostile vendor name is well-formed", () => {
    const draft = buildSalesVoucher({
      tenantId: tenantA,
      sourceType: "transaction",
      sourceId: "22222222-2222-4222-8222-222222222222",
      voucherNumber: 'AH/2026/"41" & <42>',
      voucherDate: "2026-04-12",
      partyLedgerName: HOSTILE_NAME,
      narration: "Sale to Shah & Sons <urgent> — see ]]> note",
      legs: [
        { ledgerName: HOSTILE_NAME, isDebit: true, amountMinor: R(118_000) },
        { ledgerName: "Sales A/c & Co", isDebit: false, amountMinor: R(118_000) },
      ],
    });

    const xml = buildImportEnvelope({
      companyName: 'Ordence & Sons "Heights" <Pvt> Ltd',
      vouchers: [draft],
    });

    // ⭐ NO RAW `&` ANYWHERE. Every ampersand in the output must be the
    // start of an entity reference — this is the assertion that a real
    // Tally import would otherwise fail on.
    const rawAmpersands = xml.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g);
    expect(rawAmpersands, `raw ampersands: ${rawAmpersands?.join(",")}`).toBeNull();

    // And no raw `<` inside any text node — every one is a real tag.
    const withoutTags = xml.replace(/<[^>]*>/g, "");
    expect(withoutTags).not.toContain("<");

    // ⚠️ The control character never reached the file.
    expect(xml).not.toContain("\u0001");
  });

  it("decodeXmlEntities is a SINGLE pass — &amp;lt; is the literal text &lt;", () => {
    expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeXmlEntities("A &amp; B")).toBe("A & B");
    expect(decodeXmlEntities("&#65;&#x42;")).toBe("AB");
    // ⚠️ A numeric reference to an illegal character is dropped, not decoded.
    expect(decodeXmlEntities("a&#0;b")).toBe("ab");
  });

  it("a ledger master carries the group name with its ampersand intact", () => {
    const mapping: LedgerMapping = {
      sourceKind: "tax_head",
      sourceKey: "output_cgst",
      tallyLedgerName: "Output CGST & Cess",
      tallyParentGroup: "duties_and_taxes",
      isParty: false,
    };
    const xml = renderDocument(ledgerMasterNode(mapping));
    expect(xml).toContain("<PARENT>Duties &amp; Taxes</PARENT>");
    expect(xml).toContain("<NAME>Output CGST &amp; Cess</NAME>");
    expect(xml).toContain("<TAXTYPE>GST</TAXTYPE>");
  });

  it("the validator refuses a ledger name with a line break", () => {
    expect(() => tallyLedgerNameSchema.parse("Sales\nA/c")).toThrow();
    expect(tallyLedgerNameSchema.parse("  Sales A/c  ")).toBe("Sales A/c");
  });
});

/* ================================================================== */
/* 4. ⭐⭐ DETERMINISTIC KEYS — RE-EXPORT MUST NOT DOUBLE-POST          */
/* ================================================================== */

describe("⭐⭐ deterministic voucher keys", () => {
  const identity = {
    tenantId: "33333333-3333-4333-8333-333333333333",
    voucherType: "purchase" as const,
    sourceType: "purchase_invoice",
    sourceId: "44444444-4444-4444-8444-444444444444",
  };

  it("⭐ the same source row produces the same key, every time", () => {
    const first = deterministicRemoteId(identity);
    const second = deterministicRemoteId(identity);
    expect(second).toBe(first);
    expect(isOurRemoteId(first)).toBe(true);
  });

  it("⭐⭐ the key does NOT move when the amount, the date or the narration changes", () => {
    // The key is derived from the identity alone — nothing about the
    // voucher's CONTENT reaches it. A corrected invoice must keep the key
    // of the invoice it corrects, or the correction is a second voucher
    // sitting beside the wrong one.
    const base = buildPurchaseVoucher({
      tenantId: identity.tenantId,
      sourceType: identity.sourceType,
      sourceId: identity.sourceId,
      voucherNumber: "BILL/001",
      voucherDate: "2026-04-12",
      partyLedgerName: "Sahyadri Cement",
      narration: "as billed",
      legs: [
        { ledgerName: "Cement", isDebit: true, amountMinor: R(100_000) },
        { ledgerName: "Sahyadri Cement", isDebit: false, amountMinor: R(100_000) },
      ],
    });

    const corrected = buildPurchaseVoucher({
      tenantId: identity.tenantId,
      sourceType: identity.sourceType,
      sourceId: identity.sourceId,
      voucherNumber: "BILL/001-R",
      voucherDate: "2026-05-02",
      partyLedgerName: "Sahyadri Cement",
      narration: "corrected after site measurement",
      legs: [
        { ledgerName: "Cement", isDebit: true, amountMinor: R(97_500) },
        { ledgerName: "Sahyadri Cement", isDebit: false, amountMinor: R(97_500) },
      ],
    });

    expect(corrected.remoteId).toBe(base.remoteId);
    // ⭐ And the CONTENT hash DOES move, which is how the accountant is
    // told that this one actually changed.
    expect(draftContentHash(corrected)).not.toBe(draftContentHash(base));
  });

  it("⭐ regenerating a whole period twice produces an identical set of keys", () => {
    const build = () =>
      [1, 2, 3, 4, 5].map((n) =>
        buildSalesVoucher({
          tenantId: tenantA,
          sourceType: "transaction",
          sourceId: `5555555${n}-5555-4555-8555-555555555555`,
          voucherNumber: `AH/2026/000${n}`,
          voucherDate: `2026-04-0${n}`,
          partyLedgerName: "Shah & Sons",
          legs: [
            { ledgerName: "Shah & Sons", isDebit: true, amountMinor: R(1000 * n) },
            { ledgerName: "Sales A/c", isDebit: false, amountMinor: R(1000 * n) },
          ],
        }),
      );

    const april = build().map((d) => d.remoteId);
    const aprilAgain = build().map((d) => d.remoteId);
    expect(aprilAgain).toEqual(april);
    // Five distinct sources, five distinct keys.
    expect(new Set(april).size).toBe(5);
  });

  it("a different source, voucher type or tenant produces a DIFFERENT key", () => {
    const base = deterministicRemoteId(identity);
    expect(
      deterministicRemoteId({ ...identity, sourceId: randomUUID() }),
    ).not.toBe(base);
    expect(deterministicRemoteId({ ...identity, voucherType: "payment" })).not.toBe(
      base,
    );
    expect(deterministicRemoteId({ ...identity, tenantId: randomUUID() })).not.toBe(
      base,
    );
    // ⚠️ Two workspaces exporting into one Tally company would otherwise
    // collide on identical source ids and each ALTER the other's vouchers.
    expect(
      deterministicRemoteId({ ...identity, sourceType: "gst_invoice" }),
    ).not.toBe(base);
  });

  it("⚠️ the segments are hashed separately — the concatenation collision is closed", () => {
    // ("ab","c") and ("a","bc") would collide under sha256(a + b + c).
    const one = deterministicRemoteId({
      ...identity,
      sourceType: "ab",
      sourceId: "c",
    });
    const two = deterministicRemoteId({
      ...identity,
      sourceType: "a",
      sourceId: "bc",
    });
    expect(one).not.toBe(two);
  });

  it("the key shape matches what the database CHECK demands", () => {
    const key = deterministicRemoteId(identity);
    expect(key).toMatch(/^AHOS-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{24}$/);
    expect(key.length).toBeLessThanOrEqual(64);
    expect(isOurRemoteId(randomUUID())).toBe(false);
    expect(isOurRemoteId(null)).toBe(false);
  });

  it("⭐⭐ the DATABASE accepts the SAME key again for the same source — that is a re-import Tally will ALTER", async () => {
    const sourceId = randomUUID();
    const key = keyOf("1", "1", "1");
    const batch1 = randomUUID();
    const batch2 = randomUUID();

    await asSuperuser(async (c) => {
      for (const [id, number] of [
        [batch1, "TALLY/RE/001"],
        [batch2, "TALLY/RE/002"],
      ] as const) {
        await c.query("BEGIN");
        await c.query(
          `INSERT INTO tally_export_batches
             (id, tenant_id, batch_number, period_start, period_end, company_name,
              voucher_count, total_debit_minor, total_credit_minor)
           VALUES ($1,$2,$3, DATE '2026-04-01', DATE '2026-04-30','Verify',1,1000,1000)`,
          [id, tenantA, number],
        );
        await c.query(
          `INSERT INTO tally_vouchers
             (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
              source_type, source_id, total_debit_minor, total_credit_minor,
              content_hash)
           VALUES ($1,$2,'purchase',$3, DATE '2026-04-12','purchase_invoice',$4,
                   1000,1000,$5)`,
          [tenantA, id, key, sourceId, HASH_64],
        );
        await c.query("COMMIT");
      }
    });

    const count = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM tally_vouchers WHERE remote_id = $1`,
        [key],
      );
      return rows[0]?.n ?? 0;
    });
    expect(count).toBe(2);

    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM tally_export_batches WHERE id = ANY($1::uuid[])`, [
        [batch1, batch2],
      ]);
    });
  });

  it("⭐⭐ the DATABASE REFUSES a second, DIFFERENT key for a source already exported — this is the double post", async () => {
    const sourceId = randomUUID();
    const batch1 = randomUUID();
    const batch2 = randomUUID();

    await asSuperuser(async (c) => {
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO tally_export_batches
           (id, tenant_id, batch_number, period_start, period_end, company_name,
            voucher_count, total_debit_minor, total_credit_minor)
         VALUES ($1,$2,'TALLY/DUP/001', DATE '2026-04-01', DATE '2026-04-30',
                 'Verify',1,1000,1000)`,
        [batch1, tenantA],
      );
      await c.query(
        `INSERT INTO tally_vouchers
           (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
            source_type, source_id, total_debit_minor, total_credit_minor,
            content_hash)
         VALUES ($1,$2,'purchase',$3, DATE '2026-04-12','purchase_invoice',$4,
                 1000,1000,$5)`,
        [tenantA, batch1, keyOf("2", "2", "2"), sourceId, HASH_64],
      );
      await c.query("COMMIT");

      await c.query(
        `INSERT INTO tally_export_batches
           (id, tenant_id, batch_number, period_start, period_end, company_name)
         VALUES ($1,$2,'TALLY/DUP/002', DATE '2026-04-01', DATE '2026-04-30','Verify')`,
        [batch2, tenantA],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_vouchers
             (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
              source_type, source_id, total_debit_minor, total_credit_minor,
              content_hash)
           VALUES ($1,$2,'purchase',$3, DATE '2026-04-12','purchase_invoice',$4,
                   1000,1000,$5)`,
          [tenantA, batch2, keyOf("3", "3", "3"), sourceId, HASH_64],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/already been exported to Tally under the key/);
    expect(error?.message).toMatch(/SECOND voucher/);

    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM tally_export_batches WHERE id = ANY($1::uuid[])`, [
        [batch1, batch2],
      ]);
    });
  });

  it("⚠️ and the reverse — one key may not cover two different source rows", async () => {
    const key = keyOf("4", "4", "4");
    const batch = randomUUID();

    await asSuperuser(async (c) => {
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO tally_export_batches
           (id, tenant_id, batch_number, period_start, period_end, company_name,
            voucher_count, total_debit_minor, total_credit_minor)
         VALUES ($1,$2,'TALLY/COL/001', DATE '2026-04-01', DATE '2026-04-30',
                 'Verify',1,1000,1000)`,
        [batch, tenantA],
      );
      await c.query(
        `INSERT INTO tally_vouchers
           (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
            source_type, source_id, total_debit_minor, total_credit_minor,
            content_hash)
         VALUES ($1,$2,'purchase',$3, DATE '2026-04-12','purchase_invoice',$4,
                 1000,1000,$5)`,
        [tenantA, batch, key, randomUUID(), HASH_64],
      );
      await c.query("COMMIT");
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_vouchers
             (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
              source_type, source_id, total_debit_minor, total_credit_minor,
              content_hash)
           VALUES ($1,$2,'purchase',$3, DATE '2026-04-13','purchase_invoice',$4,
                   2000,2000,$5)`,
          [tenantA, batch, key, randomUUID(), HASH_64],
        ),
      ),
    );
    expect(error).not.toBeNull();

    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM tally_export_batches WHERE id = $1`, [batch]);
    });
  });

  it("the content hash is order-independent across legs but not across values", () => {
    const legs = [
      { ledgerName: "A", isDebit: true, amountMinor: 100n },
      { ledgerName: "B", isDebit: false, amountMinor: 100n },
    ];
    const forward = voucherContentHash({
      voucherType: "journal",
      voucherDate: "2026-04-01",
      entries: legs,
    });
    const reversed = voucherContentHash({
      voucherType: "journal",
      voucherDate: "2026-04-01",
      entries: [...legs].reverse(),
    });
    expect(reversed).toBe(forward);

    const changed = voucherContentHash({
      voucherType: "journal",
      voucherDate: "2026-04-01",
      entries: [
        { ledgerName: "A", isDebit: true, amountMinor: 101n },
        { ledgerName: "B", isDebit: false, amountMinor: 101n },
      ],
    });
    expect(changed).not.toBe(forward);
  });

  it("payloadHash is stable and 64 lower-case hex", () => {
    const hash = payloadHash("<ENVELOPE/>");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash("<ENVELOPE/>")).toBe(hash);
    expect(payloadHash("<ENVELOPE />")).not.toBe(hash);
  });
});

/* ================================================================== */
/* 5. ⭐ ROUND TRIP — GENERATE, PARSE BACK, NOTHING LOST                */
/* ================================================================== */

describe("⭐ round trip", () => {
  it("⭐⭐ every value survives generate → parse exactly, including the hostile name", () => {
    const draft = buildPurchaseVoucher({
      tenantId: tenantA,
      sourceType: "purchase_invoice",
      sourceId: "66666666-6666-4666-8666-666666666666",
      voucherNumber: 'BILL/2026/"17" & <18>',
      voucherDate: "2026-04-12",
      partyLedgerName: HOSTILE_NAME,
      partyGstin: "29AAAPA1234A1Z5",
      placeOfSupplyCode: "29",
      narration: "Cement & steel <urgent>: see note ]]> and 'terms'",
      reference: "PO/2026/0099 & annexure",
      legs: [
        {
          ledgerName: "Purchases — Cement & Steel",
          isDebit: true,
          amountMinor: 1_234_567n,
          hsnSac: "2523",
          gstRateBps: 2800,
        },
        { ledgerName: "Input CGST", isDebit: true, amountMinor: 172_839n },
        { ledgerName: HOSTILE_NAME, isDebit: false, amountMinor: 1_407_406n },
      ],
    });

    const xml = buildImportEnvelope({
      companyName: 'Ordence & Sons "Heights" <Pvt> Ltd',
      vouchers: [draft],
    });

    const parsed = parseTallyExport(xml);
    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.companyName).toBe('Ordence & Sons "Heights" <Pvt> Ltd');
    expect(parsed.vouchers).toHaveLength(1);

    const back = parsed.vouchers[0]!;

    // ⭐ The identity.
    expect(back.remoteId).toBe(draft.remoteId);
    // ⭐ The number, with every hostile character intact.
    expect(back.voucherNumber).toBe('BILL/2026/"17" & <18>');
    // ⭐ The date, through Tally's YYYYMMDD form and back.
    expect(back.voucherDate).toBe("2026-04-12");
    expect(back.voucherType).toBe("Purchase");
    // ⭐ The party — with the control character removed and nothing else.
    expect(back.partyLedgerName).toBe(HOSTILE_NAME_CLEAN);
    expect(back.narration).toBe(
      "Cement & steel <urgent>: see note ]]> and 'terms'",
    );
    expect(back.isCancelled).toBe(false);

    // ⭐⭐ THE MONEY, TO THE PAISA, WITH THE DIRECTION PRESERVED.
    expect(back.legs).toHaveLength(3);
    expect(back.totalDebitMinor).toBe(1_234_567n + 172_839n);
    expect(back.totalCreditMinor).toBe(1_407_406n);
    expect(back.totalDebitMinor).toBe(back.totalCreditMinor);

    const byName = new Map(back.legs.map((leg) => [leg.ledgerName, leg]));
    expect(byName.get("Purchases — Cement & Steel")).toEqual({
      ledgerName: "Purchases — Cement & Steel",
      isDebit: true,
      amountMinor: 1_234_567n,
    });
    expect(byName.get("Input CGST")?.amountMinor).toBe(172_839n);
    expect(byName.get(HOSTILE_NAME_CLEAN)).toEqual({
      ledgerName: HOSTILE_NAME_CLEAN,
      isDebit: false,
      amountMinor: 1_407_406n,
    });
  });

  it("⭐ the sign convention survives: a debit is a NEGATIVE amount with ISDEEMEDPOSITIVE Yes", () => {
    const draft = buildJournalVoucher({
      tenantId: tenantA,
      sourceType: "transaction",
      sourceId: "77777777-7777-4777-8777-777777777777",
      voucherDate: "2026-04-12",
      legs: [
        { ledgerName: "Dr Side", isDebit: true, amountMinor: 500_00n },
        { ledgerName: "Cr Side", isDebit: false, amountMinor: 500_00n },
      ],
    });
    const xml = buildImportEnvelope({ companyName: "X", vouchers: [draft] });

    expect(xml).toContain("<AMOUNT>-500.00</AMOUNT>");
    expect(xml).toContain("<AMOUNT>500.00</AMOUNT>");

    const entries = findAll(parseXml(xml).root, "ALLLEDGERENTRIES.LIST");
    const dr = entries.find((e) => childText(e, "LEDGERNAME") === "Dr Side")!;
    expect(childText(dr, "ISDEEMEDPOSITIVE")).toBe("Yes");
    expect(childText(dr, "AMOUNT")).toBe("-500.00");

    const back = parseTallyExport(xml).vouchers[0]!;
    expect(back.legs.find((l) => l.ledgerName === "Dr Side")?.isDebit).toBe(true);
    expect(back.legs.find((l) => l.ledgerName === "Cr Side")?.isDebit).toBe(false);
  });

  it("⭐ GST fields reach the file so Tally's own reports reconcile", () => {
    const draft = buildSalesVoucher({
      tenantId: tenantA,
      sourceType: "gst_invoice",
      sourceId: "88888888-8888-4888-8888-888888888888",
      voucherNumber: "AH/2026/0100",
      voucherDate: "2026-04-20",
      partyLedgerName: "Buyer Pvt Ltd",
      partyGstin: "27AAAPA1234A1Z5",
      // ⚠️ Section 12(3): the PROPERTY'S state, not the buyer's.
      placeOfSupplyCode: "27",
      gstRegistrationType: "Regular",
      legs: [
        {
          ledgerName: "Buyer Pvt Ltd",
          isDebit: true,
          amountMinor: R(118_000),
        },
        {
          ledgerName: "Sales A/c",
          isDebit: false,
          amountMinor: R(100_000),
          hsnSac: "995411",
          gstRateBps: 1800,
        },
        { ledgerName: "Output CGST", isDebit: false, amountMinor: R(9_000) },
        { ledgerName: "Output SGST", isDebit: false, amountMinor: R(9_000) },
      ],
    });

    const xml = buildImportEnvelope({ companyName: "X", vouchers: [draft] });
    expect(xml).toContain("<PARTYGSTIN>27AAAPA1234A1Z5</PARTYGSTIN>");
    expect(xml).toContain("<PLACEOFSUPPLY>27</PLACEOFSUPPLY>");
    expect(xml).toContain("<HSNCODE>995411</HSNCODE>");
    // 1800 bps rendered as a percentage, never as basis points.
    expect(xml).toContain("<GSTRATE>18</GSTRATE>");
    expect(xml).toContain("<PARTYGSTREGISTRATIONTYPE>Regular</PARTYGSTREGISTRATIONTYPE>");
  });

  it("⭐ cost centres reach the file, per LEDGER ENTRY", () => {
    const draft = buildPurchaseVoucher({
      tenantId: tenantA,
      sourceType: "purchase_invoice",
      sourceId: "99999999-9999-4999-8999-999999999999",
      voucherDate: "2026-04-20",
      partyLedgerName: "Sahyadri Cement",
      legs: [
        {
          ledgerName: "Cement",
          isDebit: true,
          amountMinor: R(100_000),
          costCentres: [
            {
              category: "Primary Cost Category",
              name: "Basaveshwar Heights — Tower A",
              amountMinor: R(60_000),
            },
            {
              category: "Primary Cost Category",
              name: "Basaveshwar Heights — Tower B",
              amountMinor: R(40_000),
            },
          ],
        },
        { ledgerName: "Sahyadri Cement", isDebit: false, amountMinor: R(100_000) },
      ],
    });

    const xml = buildImportEnvelope({ companyName: "X", vouchers: [draft] });
    expect(xml).toContain("<CATEGORY>Primary Cost Category</CATEGORY>");
    expect(xml).toContain("Basaveshwar Heights — Tower A");
    expect(xml).toContain("<AMOUNT>-60000.00</AMOUNT>");
    expect(xml).toContain("<AMOUNT>-40000.00</AMOUNT>");
  });

  it("the envelope carries the structure Tally requires", () => {
    const xml = buildImportEnvelope({ companyName: "Ordence", vouchers: [] });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<TALLYREQUEST>Import Data</TALLYREQUEST>");
    expect(xml).toContain("<REPORTNAME>Vouchers</REPORTNAME>");
    // ⭐ The element that decides WHICH company the import lands in.
    expect(xml).toContain("<SVCURRENTCOMPANY>Ordence</SVCURRENTCOMPANY>");
  });

  it("⭐ one TALLYMESSAGE per voucher, each with the UDF namespace", () => {
    const drafts = [1, 2, 3].map((n) =>
      buildJournalVoucher({
        tenantId: tenantA,
        sourceType: "transaction",
        sourceId: `aaaaaaa${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        voucherDate: "2026-04-12",
        legs: [
          { ledgerName: "A", isDebit: true, amountMinor: R(n) },
          { ledgerName: "B", isDebit: false, amountMinor: R(n) },
        ],
      }),
    );
    const xml = buildImportEnvelope({ companyName: "X", vouchers: drafts });
    expect(xml.match(/<TALLYMESSAGE /g) ?? []).toHaveLength(3);
    expect(xml.match(/xmlns:UDF="TallyUDF"/g) ?? []).toHaveLength(3);
    expect(parseTallyExport(xml).vouchers).toHaveLength(3);
  });

  it("ACTION is Create by default and Alter on a re-send", () => {
    const draft = buildJournalVoucher({
      tenantId: tenantA,
      sourceType: "transaction",
      sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      voucherDate: "2026-04-12",
      legs: [
        { ledgerName: "A", isDebit: true, amountMinor: R(1) },
        { ledgerName: "B", isDebit: false, amountMinor: R(1) },
      ],
    });
    expect(buildImportEnvelope({ companyName: "X", vouchers: [draft] })).toContain(
      'ACTION="Create"',
    );
    expect(
      buildImportEnvelope({ companyName: "X", vouchers: [draft], action: "Alter" }),
    ).toContain('ACTION="Alter"');
  });

  it("the export REQUEST uses Tally's YYYYMMDD dates", () => {
    const xml = buildVoucherExportRequest({
      companyName: "Ordence",
      fromDay: "2026-04-01",
      toDay: "2026-04-30",
    });
    expect(xml).toContain("<SVFROMDATE>20260401</SVFROMDATE>");
    expect(xml).toContain("<SVTODATE>20260430</SVTODATE>");
    expect(xml).toContain("<ID>Day Book</ID>");
  });

  it("the stored entries shape carries paise as decimal strings", () => {
    const draft = buildJournalVoucher({
      tenantId: tenantA,
      sourceType: "transaction",
      sourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      voucherDate: "2026-04-12",
      legs: [
        { ledgerName: "A", isDebit: true, amountMinor: 9_007_199_254_740_993n },
        { ledgerName: "B", isDebit: false, amountMinor: 9_007_199_254_740_993n },
      ],
    });
    const stored = draftEntriesForStorage(draft);
    // ⚠️ Above 2^53 — a `number` would round this and JSON.stringify
    // throws on a bigint, so a decimal string is the only honest carrier.
    expect(stored[0]?.amountMinor).toBe("9007199254740993");
    expect(JSON.parse(JSON.stringify(stored))[0].amountMinor).toBe(
      "9007199254740993",
    );
  });
});

/* ================================================================== */
/* 6. ⭐ AMOUNTS AND DATES                                              */
/* ================================================================== */

describe("⭐ paise ↔ Tally decimal", () => {
  it("formats exactly, by string surgery and never by division", () => {
    expect(formatTallyAmount(0n)).toBe("0.00");
    expect(formatTallyAmount(5n)).toBe("0.05");
    expect(formatTallyAmount(100n)).toBe("1.00");
    expect(formatTallyAmount(1234n)).toBe("12.34");
    expect(formatTallyAmount(-1234n)).toBe("-12.34");
    expect(formatTallyAmount(R(1_00_00_000))).toBe("10000000.00");
    // Above 2^53 paise — a float would have lost the last digits.
    expect(formatTallyAmount(9_007_199_254_740_993n)).toBe("90071992547409.93");
  });

  it("parses everything Tally emits, and round-trips exactly", () => {
    expect(parseTallyAmount("12.34")).toBe(1234n);
    expect(parseTallyAmount("12.3")).toBe(1230n);
    expect(parseTallyAmount("12")).toBe(1200n);
    expect(parseTallyAmount("-12.34")).toBe(-1234n);
    expect(parseTallyAmount("1,23,456.00")).toBe(12_345_600n);
    expect(parseTallyAmount("₹ 1,234.56")).toBe(123_456n);

    for (const paise of [0n, 1n, 99n, 100n, 123_456_789n, 9_007_199_254_740_993n]) {
      expect(parseTallyAmount(formatTallyAmount(paise))).toBe(paise);
    }
  });

  it("⚠️ THREE decimal places is a REFUSAL, not a rounding", () => {
    expect(() => parseTallyAmount("12.345")).toThrow(TallyAmountError);
    expect(() => parseTallyAmount("")).toThrow(TallyAmountError);
    expect(() => parseTallyAmount("twelve")).toThrow(TallyAmountError);
  });

  it("⚠️ dates use Tally's YYYYMMDD, both ways", () => {
    expect(toTallyDate("2026-04-01")).toBe("20260401");
    expect(fromTallyDate("20260401")).toBe("2026-04-01");
    expect(fromTallyDate("1-Apr-2026")).toBe("2026-04-01");
    expect(fromTallyDate("2026-04-01")).toBe("2026-04-01");
    expect(fromTallyDate("nonsense")).toBeNull();
    expect(() => toTallyDate("01/04/2026")).toThrow(TallyAmountError);
  });
});

/* ================================================================== */
/* 7. ⭐ THE RECONCILIATION DIFF                                        */
/* ================================================================== */

describe("⭐ the reconciliation diff", () => {
  const remoteMatched = keyOf("a", "1", "1");
  const remoteMissing = keyOf("a", "2", "2");
  const remoteDiffers = keyOf("a", "3", "3");

  const ours: OurVoucherFacts[] = [
    {
      id: "d1111111-1111-4111-8111-111111111111",
      remoteId: remoteMatched,
      voucherType: "sales",
      voucherNumber: "AH/2026/0001",
      voucherDate: "2026-04-05",
      partyLedgerName: "Shah & Sons",
      amountMinor: R(118_000),
      isCancelled: false,
    },
    {
      id: "d2222222-2222-4222-8222-222222222222",
      remoteId: remoteMissing,
      voucherType: "sales",
      voucherNumber: "AH/2026/0002",
      voucherDate: "2026-04-06",
      partyLedgerName: "Shah & Sons",
      amountMinor: R(59_000),
      isCancelled: false,
    },
    {
      id: "d3333333-3333-4333-8333-333333333333",
      remoteId: remoteDiffers,
      voucherType: "purchase",
      voucherNumber: "AH/2026/0003",
      voucherDate: "2026-04-07",
      partyLedgerName: "Sahyadri Cement",
      amountMinor: R(118_000),
      isCancelled: false,
    },
  ];

  /**
   * ⭐ THEIR FILE. Tally renumbered on import — 1247, not AH/2026/0001 —
   * which is why the match is on REMOTEID and not on the number.
   */
  const theirXml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <BODY><IMPORTDATA><REQUESTDATA>
    <TALLYMESSAGE>
      <VOUCHER REMOTEID="${remoteMatched}" VCHTYPE="Sales">
        <DATE>20260405</DATE>
        <VOUCHERNUMBER>1247</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Shah &amp; Sons</PARTYLEDGERNAME>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Shah &amp; Sons</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-118000.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Sales A/c</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>118000.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    </TALLYMESSAGE>
    <TALLYMESSAGE>
      <VOUCHER REMOTEID="${remoteDiffers}" VCHTYPE="Purchase">
        <DATE>20260407</DATE>
        <VOUCHERNUMBER>1249</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Sahyadri Cement</PARTYLEDGERNAME>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Cement</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-118500.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Sahyadri Cement</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>118500.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    </TALLYMESSAGE>
    <TALLYMESSAGE>
      <VOUCHER VCHTYPE="Journal">
        <DATE>20260430</DATE>
        <VOUCHERNUMBER>1300</VOUCHERNUMBER>
        <NARRATION>Depreciation for April</NARRATION>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Depreciation</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-42000.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Accumulated Depreciation</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>42000.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    </TALLYMESSAGE>
  </REQUESTDATA></IMPORTDATA></BODY>
</ENVELOPE>`;

  it("⭐⭐ reports the MISSING voucher and the DIFFERING one, and matches the rest", () => {
    const theirs = parseTallyExport(theirXml);
    expect(theirs.warnings).toHaveLength(0);
    expect(theirs.vouchers).toHaveLength(3);

    const result = reconcileVouchers(ours, theirs.vouchers);

    // ⭐ One clean match — on the REMOTEID, despite Tally having
    // renumbered AH/2026/0001 to 1247.
    expect(result.matchedCount).toBe(1);

    const missing = result.differences.find((d) => d.kind === "missing_in_tally");
    expect(missing).toBeDefined();
    expect(missing?.remoteId).toBe(remoteMissing);
    expect(missing?.ourVoucherNumber).toBe("AH/2026/0002");
    expect(missing?.ourAmountMinor).toBe(R(59_000));
    expect(missing?.theirAmountMinor).toBeNull();
    expect(missing?.explanation).toMatch(/not in the Tally file/);

    // ⭐ The dangerous one: same voucher, different figure.
    const differs = result.differences.find((d) => d.kind === "amount_differs");
    expect(differs).toBeDefined();
    expect(differs?.remoteId).toBe(remoteDiffers);
    expect(differs?.ourAmountMinor).toBe(R(118_000));
    expect(differs?.theirAmountMinor).toBe(R(118_500));
    expect(differs?.explanation).toMatch(/difference of 500\.00/);
    expect(differs?.explanation).toMatch(/append-only/);

    // ⚠️ Their own depreciation journal — reported, and reported as NORMAL.
    const theirsOnly = result.differences.find((d) => d.kind === "missing_in_ours");
    expect(theirsOnly).toBeDefined();
    expect(theirsOnly?.ourVoucherId).toBeNull();
    expect(theirsOnly?.theirAmountMinor).toBe(R(42_000));
    expect(theirsOnly?.explanation).toMatch(/USUALLY CORRECT, not an error/);

    expect(result.differences).toHaveLength(3);
  });

  it("⭐ the summary separates real work from the accountant doing their job", () => {
    const result = reconcileVouchers(ours, parseTallyExport(theirXml).vouchers);
    const summary = summariseReconciliation(result);
    expect(summary.matched).toBe(1);
    expect(summary.total).toBe(3);
    // ⚠️ `missing_in_ours` is NOT actionable — a worklist that is mostly
    // noise is a worklist nobody finishes.
    expect(summary.actionableCount).toBe(2);
    expect(summary.byKind.missing_in_tally).toBe(1);
    expect(summary.byKind.amount_differs).toBe(1);
  });

  it("⚠️ TOLERANCE IS ZERO — one paisa is reported", () => {
    const result = reconcileVouchers(
      [{ ...ours[0]!, amountMinor: R(118_000) + 1n }],
      parseTallyExport(theirXml).vouchers.slice(0, 1),
    );
    expect(result.matchedCount).toBe(0);
    expect(result.differences[0]?.kind).toBe("amount_differs");
  });

  it("⭐⭐ TWO of their vouchers under ONE of our keys is reported as the double post", () => {
    const doubled = theirXml.replace(
      /<TALLYMESSAGE>\s*<VOUCHER REMOTEID="[^"]*" VCHTYPE="Sales">[\s\S]*?<\/TALLYMESSAGE>/,
      (match) => `${match}${match}`,
    );
    const result = reconcileVouchers(ours, parseTallyExport(doubled).vouchers);
    const duplicate = result.differences.find((d) => d.kind === "duplicate_in_tally");
    expect(duplicate).toBeDefined();
    expect(duplicate?.theirAmountMinor).toBe(R(236_000));
    expect(duplicate?.explanation).toMatch(/This is the double post/);
    expect(duplicate?.explanation).toMatch(/cancelled in Tally/);
  });

  it("a date that moved is reported separately from an amount that moved", () => {
    const moved = theirXml.replace("<DATE>20260405</DATE>", "<DATE>20260501</DATE>");
    const result = reconcileVouchers(ours, parseTallyExport(moved).vouchers);
    const dateDiff = result.differences.find((d) => d.kind === "date_differs");
    expect(dateDiff).toBeDefined();
    expect(dateDiff?.theirVoucherDate).toBe("2026-05-01");
    expect(dateDiff?.explanation).toMatch(/moved between GST returns/);
  });

  it("a party that moved is reported, and the comparison folds case", () => {
    const renamed = theirXml.replace(
      /<PARTYLEDGERNAME>Shah &amp; Sons<\/PARTYLEDGERNAME>/,
      "<PARTYLEDGERNAME>Shah and Sons</PARTYLEDGERNAME>",
    );
    const result = reconcileVouchers(ours, parseTallyExport(renamed).vouchers);
    expect(result.differences.some((d) => d.kind === "party_differs")).toBe(true);

    const cased = theirXml.replace(
      /<PARTYLEDGERNAME>Shah &amp; Sons<\/PARTYLEDGERNAME>/,
      "<PARTYLEDGERNAME>SHAH &amp; SONS</PARTYLEDGERNAME>",
    );
    const folded = reconcileVouchers(ours, parseTallyExport(cased).vouchers);
    expect(folded.differences.some((d) => d.kind === "party_differs")).toBe(false);
  });

  it("their totals are rolled up for the batch row", () => {
    const result = reconcileVouchers(ours, parseTallyExport(theirXml).vouchers);
    expect(result.theirTotalDebitMinor).toBe(
      R(118_000) + R(118_500) + R(42_000),
    );
    expect(result.theirTotalDebitMinor).toBe(result.theirTotalCreditMinor);
  });
});

/* ================================================================== */
/* 8. ⭐ THE PARSER, AGAINST A HOSTILE FILE                             */
/* ================================================================== */

describe("⭐ the parser", () => {
  it("⭐ NEVER expands an entity and NEVER follows a DOCTYPE (XXE and billion laughs)", () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<ENVELOPE><BODY><X>&lol2;&xxe;</X></BODY></ENVELOPE>`;

    const { root, warnings } = parseXml(bomb);
    const x = findAll(root, "X")[0];
    // The custom entities are left as literal text — not expanded, not
    // fetched, not looked up.
    expect(x?.text).toBe("&lol2;&xxe;");
    expect(warnings.some((w) => w.code === "doctype_ignored")).toBe(true);
  });

  it("⚠️ a `>` inside an attribute value does not cut the tag in half", () => {
    const { root } = parseXml('<LEDGER NAME="A > B"><X>1</X></LEDGER>');
    expect(root?.tag).toBe("LEDGER");
    expect(root?.attrs.NAME).toBe("A > B");
    expect(childText(root!, "X")).toBe("1");
  });

  it("⚠️ a TRUNCATED export is recovered — Tally does this when a report times out", () => {
    const truncated = `<ENVELOPE><BODY><REQUESTDATA>
      <TALLYMESSAGE><VOUCHER REMOTEID="${keyOf("e", "e", "e")}" VCHTYPE="Sales">
        <DATE>20260405</DATE>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>B</LEDGERNAME><AMOUNT>100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      </VOUCHER></TALLYMESSAGE>
      <TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>2026`;

    const parsed = parseTallyExport(truncated);
    // The complete voucher before the break survives — and it is the
    // vouchers before the break the reconciliation needs.
    expect(parsed.vouchers.length).toBeGreaterThanOrEqual(1);
    expect(parsed.vouchers[0]?.totalDebitMinor).toBe(10_000n);
    expect(parsed.warnings.some((w) => w.code === "unclosed_elements")).toBe(true);
  });

  it("CDATA is taken literally and NOT entity-decoded", () => {
    const { root } = parseXml(
      "<LEDGERNAME><![CDATA[A&amp;B Traders]]></LEDGERNAME>",
    );
    expect(root?.text).toBe("A&amp;B Traders");
  });

  it("an unreadable amount becomes a warning, not a lost file", () => {
    const bad = `<ENVELOPE><REQUESTDATA><TALLYMESSAGE>
      <VOUCHER VCHTYPE="Sales"><DATE>20260405</DATE><VOUCHERNUMBER>7</VOUCHERNUMBER>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><AMOUNT>12.345</AMOUNT></ALLLEDGERENTRIES.LIST>
      </VOUCHER></TALLYMESSAGE></REQUESTDATA></ENVELOPE>`;
    const parsed = parseTallyExport(bad);
    expect(parsed.vouchers).toHaveLength(1);
    expect(parsed.warnings.some((w) => w.code === "unreadable_amount")).toBe(true);
  });

  it("⭐ Tally's import response is read from the COUNTS, not from HTTP 200", () => {
    const response = parseImportResponse(`<ENVELOPE>
      <CREATED>0</CREATED><ALTERED>0</ALTERED><IGNORED>0</IGNORED>
      <ERRORS>0</ERRORS><LASTVCHID>0</LASTVCHID>
    </ENVELOPE>`);
    // ⚠️ Nothing errored and nothing was created — the cheerful failure.
    expect(response.created).toBe(0);
    expect(response.errors).toBe(0);

    const failed = parseImportResponse(`<ENVELOPE>
      <CREATED>0</CREATED><ERRORS>2</ERRORS>
      <LINEERROR>Ledger 'Sales A/c' does not exist</LINEERROR>
    </ENVELOPE>`);
    expect(failed.errors).toBe(2);
    expect(failed.lineErrors).toEqual(["Ledger 'Sales A/c' does not exist"]);
  });
});

/* ================================================================== */
/* 9. ⭐ THE LEDGER MAPPING — LOOKED UP, NEVER GUESSED                  */
/* ================================================================== */

describe("⭐ ledger mapping", () => {
  const mappings: LedgerMapping[] = [
    {
      sourceKind: "ledger",
      sourceId: "e1111111-1111-4111-8111-111111111111",
      tallyLedgerName: "Sales A/c",
      tallyParentGroup: "sales_accounts",
      isParty: false,
    },
    {
      sourceKind: "vendor",
      sourceId: "e2222222-2222-4222-8222-222222222222",
      tallyLedgerName: "Sahyadri Cement & Co",
      tallyParentGroup: "sundry_creditors",
      isParty: true,
      partyGstin: "29AAACS1234A1Z5",
    },
    {
      sourceKind: "tax_head",
      sourceKey: "output_cgst",
      tallyLedgerName: "Output CGST",
      tallyParentGroup: "duties_and_taxes",
      isParty: false,
    },
  ];

  it("⭐ an UNMAPPED account is a REFUSAL, and the message says why a fallback is worse", () => {
    const index = buildLedgerIndex(mappings);
    expect(() =>
      resolveLedger(index, { kind: "ledger", id: randomUUID(), label: "Rent" }),
    ).toThrow(UnmappedLedgerError);

    try {
      resolveLedger(index, { kind: "ledger", id: randomUUID(), label: "Rent" });
    } catch (err) {
      expect((err as Error).message).toMatch(/Tally would CREATE a ledger/);
      expect((err as Error).message).toMatch(/quietly forked/);
    }

    expect(tryResolveLedger(index, { kind: "ledger", id: randomUUID() })).toBeNull();
  });

  it("resolves each kind by its own identity", () => {
    const index = buildLedgerIndex(mappings);
    expect(
      resolveLedger(index, {
        kind: "vendor",
        id: "e2222222-2222-4222-8222-222222222222",
      }).tallyLedgerName,
    ).toBe("Sahyadri Cement & Co");
    expect(
      resolveLedger(index, { kind: "tax_head", key: "output_cgst" })
        .tallyParentGroup,
    ).toBe("duties_and_taxes");
    // ⚠️ A vendor id is not a ledger id, even when it is the same uuid.
    expect(() =>
      resolveLedger(index, {
        kind: "ledger",
        id: "e2222222-2222-4222-8222-222222222222",
      }),
    ).toThrow(UnmappedLedgerError);
  });

  it("⭐ the name fold matches Tally's own: case and repeated spaces", () => {
    expect(foldLedgerName("Sales A/c")).toBe("sales a/c");
    expect(foldLedgerName("  SALES   A/C  ")).toBe("sales a/c");
    expect(findDuplicateNames([...mappings])).toHaveLength(0);
    expect(
      findDuplicateNames([
        ...mappings,
        {
          sourceKind: "ledger",
          sourceId: randomUUID(),
          tallyLedgerName: "sales  a/c",
          tallyParentGroup: "sales_accounts",
          isParty: false,
        },
      ]),
    ).toHaveLength(1);
  });

  it("⭐ the DATABASE refuses two accounts on one Tally ledger, folded", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_ledger_mappings
             (tenant_id, source_kind, source_id, tally_ledger_name,
              tally_parent_group)
           VALUES ($1,'ledger',$2,'hdfc  BANK a/c','bank_accounts')`,
          [tenantA, ledgerSalesA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505");
  });

  it("assessMapping names the silent failures of a syntactically perfect mapping", () => {
    const findings = assessMapping({
      sourceKind: "tax_head",
      sourceKey: "output_cgst",
      tallyLedgerName: " Output CGST ",
      tallyParentGroup: "indirect_expenses",
      isParty: false,
    });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("padded_name");
    expect(codes).toContain("tax_head_wrong_group");
    expect(
      findings.find((f) => f.code === "tax_head_wrong_group")?.message,
    ).toMatch(/GSTR-1 in Tally shows no tax/);

    expect(
      assessMapping({
        sourceKind: "ledger",
        sourceId: randomUUID(),
        tallyLedgerName: "X",
        tallyParentGroup: "sales_accounts",
        isParty: false,
        partyGstin: "29AAACS1234A1Z5",
      }).some((f) => f.code === "gstin_on_nominal" && f.severity === "refuse"),
    ).toBe(true);

    expect(
      assessMapping({
        sourceKind: "ledger",
        sourceId: randomUUID(),
        tallyLedgerName: "Y",
        tallyParentGroup: "suspense_account",
        isParty: false,
      }).some((f) => f.code === "mapped_to_suspense"),
    ).toBe(true);
  });

  it("the tax heads are a closed set and every group has Tally's own spelling", () => {
    expect(TALLY_TAX_HEADS).toContain("output_cgst");
    expect(TALLY_TAX_HEADS).toContain("round_off");
    expect(TALLY_PRIMARY_GROUPS.sundry_creditors).toBe("Sundry Creditors");
    expect(TALLY_PRIMARY_GROUPS.cash_in_hand).toBe("Cash-in-Hand");
    expect(TALLY_VOUCHER_TYPE_NAMES.credit_note).toBe("Credit Note");
  });
});

/* ================================================================== */
/* 10. ⭐⭐ THE SSRF POLICY ON THE DIRECT PUSH                          */
/* ================================================================== */

describe("⭐⭐ the Tally endpoint policy", () => {
  const config = (over: Partial<Parameters<typeof checkTallyEndpoint>[0]>) => ({
    host: "192.168.1.20",
    port: 9000,
    useTls: false,
    allowPrivateHost: false,
    ...over,
  });

  it("⭐ a private address is REFUSED until the workspace deliberately allows it", () => {
    const off = checkTallyEndpoint(config({ allowPrivateHost: false }));
    expect(off.allowed).toBe(false);
    if (!off.allowed) {
      expect(off.remedy).toMatch(/169\.254\.169\.254/);
      expect(off.remedy).toMatch(/use the file export/);
    }

    const on = checkTallyEndpoint(config({ allowPrivateHost: true }));
    expect(on.allowed).toBe(true);
    if (on.allowed) expect(on.reachesPrivateNetwork).toBe(true);
  });

  it("⭐⭐ THE METADATA SERVICE IS REFUSED EVEN WITH THE FLAG ON", () => {
    for (const host of [
      "169.254.169.254",
      "metadata.google.internal",
      "metadata",
      "instance-data",
      // ⚠️ The numeric forms a resolver accepts and a naive check misses.
      "2852039166", // 169.254.169.254 as a bare integer
      "0251.0376.0251.0376", // the same, in octal
      "[::ffff:169.254.169.254]",
    ]) {
      const verdict = checkTallyEndpoint(
        config({ host, allowPrivateHost: true }),
      );
      expect(verdict.allowed, `${host} was ALLOWED`).toBe(false);
    }
  });

  it("⭐ the always-forbidden ranges are forbidden whatever the flag says", () => {
    expect(isAlwaysForbiddenAddress("169.254.169.254")).toBe(true);
    expect(isAlwaysForbiddenAddress("0.0.0.0")).toBe(true);
    expect(isAlwaysForbiddenAddress("100.64.1.1")).toBe(true); // CGNAT
    expect(isAlwaysForbiddenAddress("239.255.255.250")).toBe(true); // multicast
    expect(isAlwaysForbiddenAddress("fe80::1")).toBe(true);
    // ⚠️ The hex form `URL` normalises the IPv4-mapped address to.
    expect(isAlwaysForbiddenAddress("::ffff:a9fe:a9fe")).toBe(true);
    // A LAN address is NOT always-forbidden — the flag decides it.
    expect(isAlwaysForbiddenAddress("192.168.1.20")).toBe(false);
    expect(isAlwaysForbiddenAddress("127.0.0.1")).toBe(false);
  });

  it("⭐ loopback and the RFC1918 ranges are the ONLY private ones permitted", () => {
    for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "172.20.0.5",
                        "192.168.0.9", "tally-pc"]) {
      const verdict = checkTallyEndpoint(config({ host, allowPrivateHost: true }));
      expect(verdict.allowed, `${host} was refused`).toBe(true);
    }
  });

  it("a public address needs no flag — a VPN concentrator or a port-forward", () => {
    const verdict = checkTallyEndpoint(
      config({ host: "tally.example.com", port: 443, useTls: true }),
    );
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.reachesPrivateNetwork).toBe(false);
  });

  it("⚠️ .internal and .svc are refused even when they look public", () => {
    for (const host of ["tally.internal", "tally.svc", "tally.cluster.local"]) {
      expect(
        checkTallyEndpoint(config({ host, allowPrivateHost: true })).allowed,
        host,
      ).toBe(false);
    }
  });

  it("only Tally's own ports are permitted — anything else is a port scan", () => {
    expect(checkTallyEndpoint(config({ port: 9000, allowPrivateHost: true })).allowed).toBe(true);
    expect(checkTallyEndpoint(config({ port: 9009, allowPrivateHost: true })).allowed).toBe(true);
    for (const port of [22, 5432, 6379, 3306, 8080]) {
      const verdict = checkTallyEndpoint(config({ port, allowPrivateHost: true }));
      expect(verdict.allowed, `port ${port} was allowed`).toBe(false);
      if (!verdict.allowed) expect(verdict.remedy).toMatch(/port scan/);
    }
  });

  it("credentials in the address are refused rather than stripped", () => {
    const verdict = checkTallyEndpoint(
      config({ host: "user:pass@192.168.1.20", allowPrivateHost: true }),
    );
    expect(verdict.allowed).toBe(false);
  });

  it("an empty host is a file-only connection, not an error to hide", () => {
    const verdict = checkTallyEndpoint(config({ host: "   " }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.remedy).toMatch(/file export/);
  });

  it("⚠️ the schema will not let a private-host exception exist without a host", () => {
    expect(() =>
      upsertTallyConnectionSchema.parse({
        name: "X",
        companyName: "Y",
        allowPrivateHost: true,
        port: 9000,
        useTls: false,
        isActive: true,
      }),
    ).toThrow();

    // And the database says the same thing.
    expect(
      upsertTallyConnectionSchema.parse({
        name: "X",
        companyName: "Y",
        host: "192.168.1.20",
        allowPrivateHost: true,
        port: 9000,
        useTls: false,
        isActive: true,
      }).host,
    ).toBe("192.168.1.20");
  });

  it("⚠️ the DATABASE refuses a private-host exception with no host named", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_connections
             (tenant_id, name, company_name, allow_private_host)
           VALUES ($1,'No host','X', true)`,
          [tenantA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/private_host_is_named/);
  });

  it("a URL pasted into the host field is refused with a useful sentence", () => {
    const result = upsertTallyConnectionSchema.safeParse({
      name: "X",
      companyName: "Y",
      host: "http://192.168.1.20:9000/",
      port: 9000,
      useTls: false,
      allowPrivateHost: false,
      isActive: true,
    });
    expect(result.success).toBe(false);
  });
});

/* ================================================================== */
/* 11. VALIDATORS                                                      */
/* ================================================================== */

describe("validators", () => {
  it("⚠️ an export period is bounded to a financial year", () => {
    const base = {
      companyName: "Ordence Pvt Ltd",
      voucherTypes: ["sales"] as const,
      includeMasters: false,
    };
    expect(
      generateTallyExportSchema.safeParse({
        ...base,
        periodStart: "2026-04-01",
        periodEnd: "2027-03-31",
      }).success,
    ).toBe(true);
    expect(
      generateTallyExportSchema.safeParse({
        ...base,
        periodStart: "2016-04-01",
        periodEnd: "2026-03-31",
      }).success,
    ).toBe(false);
    expect(
      generateTallyExportSchema.safeParse({
        ...base,
        periodStart: "2026-04-30",
        periodEnd: "2026-04-01",
      }).success,
    ).toBe(false);
  });

  it("⭐ a mapping has exactly one identity", () => {
    const base = {
      tallyLedgerName: "Sales A/c",
      tallyParentGroup: "sales_accounts" as const,
      isParty: false,
      createMasterOnExport: false,
      isActive: true,
    };
    expect(
      upsertTallyLedgerMappingSchema.safeParse({
        ...base,
        sourceKind: "ledger",
        sourceId: randomUUID(),
      }).success,
    ).toBe(true);
    // A tax head with a row id, or a ledger with a key — both refused.
    expect(
      upsertTallyLedgerMappingSchema.safeParse({
        ...base,
        sourceKind: "tax_head",
        sourceId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      upsertTallyLedgerMappingSchema.safeParse({
        ...base,
        sourceKind: "ledger",
        sourceKey: "output_cgst",
      }).success,
    ).toBe(false);
    // A free-text tax head is not in the closed set.
    expect(
      upsertTallyLedgerMappingSchema.safeParse({
        ...base,
        sourceKind: "tax_head",
        sourceKey: "cgst_output",
      }).success,
    ).toBe(false);
  });

  it("⚠️ closing a reconciliation finding requires a reason", () => {
    expect(
      resolveReconciliationItemSchema.safeParse({
        itemId: randomUUID(),
        status: "resolved",
      }).success,
    ).toBe(false);
    expect(
      resolveReconciliationItemSchema.safeParse({
        itemId: randomUUID(),
        status: "resolved",
        resolutionNote: "Posted a correcting journal on 3 May.",
      }).success,
    ).toBe(true);
  });

  it("⚠️ an import is size-bounded — a whole history reported against one month is noise", () => {
    expect(
      importTallyExportSchema.safeParse({
        sourceLabel: "daybook.xml",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        payload: "<ENVELOPE/>",
      }).success,
    ).toBe(true);
    expect(
      importTallyExportSchema.safeParse({
        sourceLabel: "daybook.xml",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        payload: "x".repeat(21 * 1024 * 1024),
      }).success,
    ).toBe(false);
  });
});

/* ================================================================== */
/* 12. BATCH INTEGRITY                                                 */
/* ================================================================== */

describe("batch integrity", () => {
  it("⭐ a batch whose stated totals disagree with its vouchers is REFUSED at commit", async () => {
    const batch = randomUUID();
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO tally_export_batches
             (id, tenant_id, batch_number, period_start, period_end, company_name,
              voucher_count, total_debit_minor, total_credit_minor)
           VALUES ($1,$2,'TALLY/LIE/001', DATE '2026-04-01', DATE '2026-04-30',
                   'Verify', 5, 500000, 500000)`,
          [batch, tenantA],
        );
        await c.query(
          `INSERT INTO tally_vouchers
             (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
              source_type, source_id, total_debit_minor, total_credit_minor,
              content_hash)
           VALUES ($1,$2,'journal',$3, DATE '2026-04-12','transaction',$4,
                   1000,1000,$5)`,
          [tenantA, batch, keyOf("5", "5", "5"), randomUUID(), HASH_64],
        );
      }),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/it actually holds/);
  });

  it("⭐ a batch whose totals do NOT balance is refused outright", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_export_batches
             (tenant_id, batch_number, period_start, period_end, company_name,
              total_debit_minor, total_credit_minor)
           VALUES ($1,'TALLY/UNB/001', DATE '2026-04-01', DATE '2026-04-30',
                   'Verify', 500000, 400000)`,
          [tenantA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/tally_export_batches_balances/);
  });

  it("⚠️ a generated batch must carry the hash of what it generated", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_export_batches
             (tenant_id, batch_number, period_start, period_end, company_name,
              status)
           VALUES ($1,'TALLY/NOHASH/001', DATE '2026-04-01', DATE '2026-04-30',
                   'Verify','generated')`,
          [tenantA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/generated_is_hashed/);
  });

  it("⚠️ importing the same Tally file twice is refused — it would double every finding", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_import_batches
             (tenant_id, source_label, period_start, period_end, payload_hash)
           VALUES ($1,'again.xml', DATE '2026-04-01', DATE '2026-04-30', $2)`,
          [tenantA, "c".repeat(64)],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505");
  });

  it("⭐ an `amount_differs` finding with equal amounts is refused — that is a bug in the diff", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_reconciliation_items
             (tenant_id, import_batch_id, kind, our_amount_minor,
              their_amount_minor, our_voucher_number, explanation)
           VALUES ($1,$2,'amount_differs', 1000, 1000, 'X/1','identical')`,
          [tenantA, importBatchA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/amount_differs_actually_differs/);
  });

  it("⚠️ a `missing_in_ours` finding may not name one of our vouchers", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tally_reconciliation_items
             (tenant_id, import_batch_id, kind, our_voucher_id,
              their_voucher_number, explanation)
           VALUES ($1,$2,'missing_in_ours',$3,'T/1','mislabelled')`,
          [tenantA, importBatchA, voucherA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/missing_in_ours_has_no_ours/);
  });
});

/* ================================================================== */
/* 13. SMALL PURE HELPERS                                              */
/* ================================================================== */

describe("node helpers", () => {
  it("leaf() omits an empty value unless asked to keep it", () => {
    expect(leaf("X", null)).toBeNull();
    expect(leaf("X", "")).toBeNull();
    expect(leaf("X", "", { keepEmpty: true })).toEqual({
      tag: "X",
      text: "",
      keepEmpty: true,
    });
    expect(compact([leaf("A", "1"), null, leaf("B", null)])).toHaveLength(1);
  });

  it("⭐ an empty NARRATION is emitted, because absent and empty mean different things to Tally", () => {
    const draft = buildJournalVoucher({
      tenantId: tenantA,
      sourceType: "transaction",
      sourceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      voucherDate: "2026-04-12",
      narration: null,
      legs: [
        { ledgerName: "A", isDebit: true, amountMinor: R(1) },
        { ledgerName: "B", isDebit: false, amountMinor: R(1) },
      ],
    });
    const xml = buildImportEnvelope({ companyName: "X", vouchers: [draft] });
    // Present and empty — which CLEARS it on an ALTER rather than leaving
    // whatever text Tally already had.
    expect(xml).toContain("<NARRATION></NARRATION>");
  });
});
