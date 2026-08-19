import "server-only";

/**
 * Ordence — ⭐ Assembling an Export
 * Version: v0.37.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE SOURCE IS THE LEDGER, AND ONLY THE LEDGER
 * ══════════════════════════════════════════════════════════════════════
 * The tempting design is to export the documents: invoices from the
 * sales tables, bills from `purchase_invoices`, receipts from the
 * bookings. It is wrong, and it is wrong in the way this phase is
 * dedicated to:
 *
 *     ⚠️ EVERY ONE OF THOSE DOCUMENTS ALREADY HAS A TRANSACTION IN
 *     `transactions` / `journal_entries`. Exporting both puts the same
 *     economic event into Tally twice, under two different keys, and both
 *     copies balance.
 *
 * That is the double post arriving through the front door instead of
 * through a re-import — the same failure, with the same silence.
 *
 * ⭐ SO THERE IS EXACTLY ONE SOURCE: the double-entry ledger from Phase
 * 4, whose balance is enforced by a deferred constraint trigger at the
 * database. Three consequences follow, and all three are the point:
 *
 *   1. ⭐ EVERY GENERATED VOUCHER BALANCES BY CONSTRUCTION, because the
 *      transaction it comes from could not have been committed otherwise.
 *      `assertVoucherBalances` is still called — belt and braces on the
 *      one rule Tally rejects a whole import over — but it is asserting
 *      something the database already guaranteed.
 *   2. There is no possibility of a document and its ledger entry
 *      disagreeing in Tally, because only one of them is ever sent.
 *   3. The GST fields (party GSTIN, place of supply, HSN) are read from
 *      the document the transaction REFERENCES, and attached to the
 *      voucher the ledger produced. Enrichment, not a second source.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE REFUSES TO DO
 * ══════════════════════════════════════════════════════════════════════
 * It refuses to export a transaction touching an unmapped ledger, and it
 * refuses the WHOLE batch when it finds one. A partial export is worse
 * than no export: the accountant imports it, the trial balance in Tally
 * no longer matches ours, and finding out which vouchers were left out
 * means comparing two registers line by line.
 */

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { withTenant } from "@/db";
import { transactions, journalEntries } from "@/db/schema/accounting";
import { purchaseInvoices } from "@/db/schema/purchases";
import { invoices } from "@/db/schema/billing";
import {
  tallyExportBatches,
  tallyVouchers,
  type TallyVoucherType,
} from "@/db/schema/tally";
import {
  buildLedgerIndex,
  resolveLedger,
  TALLY_PRIMARY_GROUPS,
  type LedgerMapping,
} from "@/lib/tally/ledgers";
import {
  assertVoucherBalances,
  buildVoucher,
  classifyVoucherType,
  draftContentHash,
  draftEntriesForStorage,
  type TallyVoucherDraft,
  type VoucherLeg,
} from "@/lib/tally/vouchers";
import { buildImportEnvelope } from "@/lib/tally/envelope";
import { payloadHash } from "@/lib/tally/keys";
import {
  listCostCentreMappings,
  listLedgerMappings,
  loadPreviouslyDelivered,
  nextBatchNumber,
  toLedgerMapping,
} from "./registry";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type BuiltExport = {
  batchNumber: string;
  companyName: string;
  periodStart: string;
  periodEnd: string;
  voucherTypes: string[];
  drafts: TallyVoucherDraft[];
  masters: LedgerMapping[];
  xml: string;
  hash: string;
  bytes: number;
  totalDebitMinor: bigint;
  totalCreditMinor: bigint;
  /**
   * ⭐ `Alter` when EVERY voucher in the batch has been delivered before.
   *
   * ⚠️ THE ACTION IS PER FILE, NOT PER VOUCHER, BECAUSE TALLY'S ENVELOPE
   * IS. So a period containing both new and previously-sent vouchers goes
   * as `Create` — which is safe: Tally matches on REMOTEID first and
   * updates the ones it already has whatever the action says, and creates
   * the ones it does not. `Alter` on a file containing anything new is
   * the unsafe direction: Tally reports those "ignored", cheerfully, and
   * they silently never arrive.
   */
  action: "Create" | "Alter";
  /** Source rows whose content changed since the last delivery. */
  amendedRemoteIds: string[];
};

type LedgerLeg = {
  ledgerId: string;
  entryType: "debit" | "credit";
  /**
   * ⭐ THE INTEGER, AS AN INTEGER. Batch 0108.
   *
   * ⚠️ THIS WAS `amount: string` AND WENT THROUGH `toPaise()`. The ledger
   * now stores the minor units it was always counting in, so the string
   * surgery that used to stand between them is gone — along with its
   * hardcoded two decimal places, which turned a dinar into a rupee and a
   * yen into a hundredth of one.
   */
  amountMinor: bigint;
  description: string | null;
  counterpartyName: string | null;
};

/* ------------------------------------------------------------------ */
/* ⭐ BUILD                                                             */
/* ------------------------------------------------------------------ */

export async function buildExport(args: {
  tenantId: string;
  companyName: string;
  periodStart: string;
  periodEnd: string;
  voucherTypes: readonly TallyVoucherType[];
  includeMasters: boolean;
}): Promise<BuiltExport> {
  const [mappingRows, costCentreRows] = await Promise.all([
    listLedgerMappings(args.tenantId),
    listCostCentreMappings(args.tenantId),
  ]);

  const mappings = mappingRows.map(toLedgerMapping);
  const index = buildLedgerIndex(mappings);

  const costCentreByProject = new Map(
    costCentreRows.map((row) => [
      row.projectId,
      { category: row.tallyCostCategory, name: row.tallyCostCentreName },
    ]),
  );

  /* --- The ledger, in one query per side. ----------------------- */

  const txRows = await withTenant(args.tenantId, async (tx) =>
    tx
      .select({
        id: transactions.id,
        transactionNumber: transactions.transactionNumber,
        description: transactions.description,
        transactionDate: transactions.transactionDate,
        referenceType: transactions.referenceType,
        referenceId: transactions.referenceId,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.tenantId, args.tenantId),
          // ⚠️ POSTED ONLY. A pending transaction is not yet a fact, and a
          // reversed one is represented by its reversing entry — exporting
          // both would post the mistake and its correction as two live
          // vouchers, which is right in the ledger and confusing in Tally.
          eq(transactions.status, "posted"),
          gte(transactions.transactionDate, args.periodStart),
          lte(transactions.transactionDate, args.periodEnd),
        ),
      )
      .orderBy(asc(transactions.transactionDate), asc(transactions.id)),
  );

  if (txRows.length === 0) {
    return emptyExport(args);
  }

  const txIds = txRows.map((row) => row.id);

  const legRows = await withTenant(args.tenantId, async (tx) =>
    tx
      .select({
        transactionId: journalEntries.transactionId,
        ledgerId: journalEntries.ledgerId,
        entryType: journalEntries.entryType,
        amountMinor: journalEntries.amountMinor,
        description: journalEntries.description,
        counterpartyName: journalEntries.counterpartyName,
      })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, args.tenantId),
          inArray(journalEntries.transactionId, txIds),
        ),
      ),
  );

  const legsByTransaction = new Map<string, LedgerLeg[]>();
  for (const row of legRows) {
    const existing = legsByTransaction.get(row.transactionId) ?? [];
    existing.push({
      ledgerId: row.ledgerId,
      entryType: row.entryType,
      /**
       * ⚠️ REFUSED, NOT DEFAULTED, WHEN THE LEDGER HAS NOT BEEN SCALED.
       * `amount_minor` is nullable in the type because 0108 is allowed to
       * leave a leg unscaled — a currency `currency_units` does not carry,
       * or a value that is not a whole number of that currency's minor
       * units. Exporting such a leg as zero would send Tally a voucher
       * that is short by a real amount and balances anyway.
       */
      amountMinor: (() => {
        if (row.amountMinor === null) {
          throw new Error(
            `A journal line in transaction ${row.transactionId} has no amount in minor units, ` +
              `so it cannot be exported. Run the census in SQL-FILES/0108 to see which ` +
              `currency is unscaled, and correct it before exporting.`,
          );
        }
        return row.amountMinor;
      })(),
      description: row.description,
      counterpartyName: row.counterpartyName,
    });
    legsByTransaction.set(row.transactionId, existing);
  }

  /* --- ⭐ GST enrichment, from whatever the transaction references. */

  const gstFacts = await loadGstFacts(args.tenantId, txRows);

  /* --- Build. --------------------------------------------------- */

  const wanted = new Set<string>(args.voucherTypes);
  const drafts: TallyVoucherDraft[] = [];
  const usedMappings = new Map<string, LedgerMapping>();

  for (const tx of txRows) {
    const legs = legsByTransaction.get(tx.id) ?? [];
    if (legs.length === 0) continue;

    const resolved = legs.map((leg) => {
      // ⭐ THROWS `UnmappedLedgerError`, naming the account. The whole
      // batch fails — see the file header for why a partial one is worse.
      const mapping = resolveLedger(index, {
        kind: "ledger",
        id: leg.ledgerId,
      });
      usedMappings.set(mapping.tallyLedgerName, mapping);
      return { leg, mapping };
    });

    const voucherType = classifyVoucherType({
      referenceType: tx.referenceType,
      legs: resolved.map(({ leg, mapping }) => ({
        group: mapping.tallyParentGroup,
        isDebit: leg.entryType === "debit",
      })),
    });

    if (!wanted.has(voucherType)) continue;

    const gst = tx.referenceId ? gstFacts.get(tx.referenceId) : undefined;

    /**
     * ⭐ THE PARTY. Tally reads receivables ageing, payables ageing and
     * both GST returns off this field and NOT off the entries — so a
     * sales voucher without it imports, posts correctly, and appears in
     * no GST report at all.
     *
     * It is the first leg whose mapping says `isParty`, which is a
     * recorded decision rather than a guess at a name.
     */
    const partyMapping = resolved.find(({ mapping }) => mapping.isParty)?.mapping;

    const voucherLegs: VoucherLeg[] = resolved.map(({ leg, mapping }) => {
      const amountMinor = leg.amountMinor;
      const centre = gst?.projectId
        ? costCentreByProject.get(gst.projectId)
        : undefined;

      return {
        ledgerName: mapping.tallyLedgerName,
        isDebit: leg.entryType === "debit",
        amountMinor,
        /**
         * ⭐ THE PER-PROJECT P&L. One allocation covering the whole leg —
         * a partial allocation is refused by `assertVoucherBalances`,
         * because Tally accepts one and parks the remainder as
         * unallocated where nobody looks.
         *
         * ⚠️ NOT ON PARTY LEDGERS. A cost centre on a Sundry Debtor makes
         * the customer's balance itself project-specific, which breaks
         * the ageing and is not what anybody means by per-project P&L.
         */
        costCentres:
          centre && !mapping.isParty
            ? [{ category: centre.category, name: centre.name, amountMinor }]
            : undefined,
        hsnSac: gst?.hsnSac ?? null,
        gstRateBps: gst?.gstRateBps ?? null,
      };
    });

    const draft = buildVoucher(voucherType, {
      tenantId: args.tenantId,
      sourceType: "transaction",
      sourceId: tx.id,
      voucherNumber: tx.transactionNumber,
      voucherDate: tx.transactionDate,
      partyLedgerName:
        voucherType === "contra" ? null : (partyMapping?.tallyLedgerName ?? null),
      partyGstin: voucherType === "contra" ? null : (gst?.gstin ?? partyMapping?.partyGstin ?? null),
      placeOfSupplyCode: gst?.placeOfSupplyCode ?? null,
      gstRegistrationType: gst?.gstin ? "Regular" : null,
      narration: tx.description,
      reference: gst?.documentNumber ?? tx.transactionNumber,
      referenceDate: gst?.documentDate ?? null,
      legs: voucherLegs,
    });

    // ⭐⭐ Belt and braces on the one rule Tally rejects a whole import
    // over. `buildVoucher` already did this; saying so twice costs
    // nothing and the alternative costs an afternoon.
    assertVoucherBalances(draft);

    drafts.push(draft);
  }

  /* --- ⭐ CREATE OR ALTER? ------------------------------------- */

  const delivered = await loadPreviouslyDelivered(
    args.tenantId,
    drafts.map((d) => d.sourceId),
  );

  let allPreviouslyDelivered = drafts.length > 0;
  const amendedRemoteIds: string[] = [];

  for (const draft of drafts) {
    const previous = delivered.get(
      `${draft.sourceType}:${draft.sourceId}:${draft.voucherType}`,
    );
    if (!previous) {
      allPreviouslyDelivered = false;
      continue;
    }
    // ⭐ Same key, different content — the accountant needs telling which
    // vouchers actually moved rather than being handed a file of two
    // thousand unchanged ones.
    if (previous.contentHash !== draftContentHash(draft)) {
      amendedRemoteIds.push(draft.remoteId);
    }
  }

  const action: "Create" | "Alter" = allPreviouslyDelivered ? "Alter" : "Create";

  /* --- Render. -------------------------------------------------- */

  const masters = args.includeMasters
    ? [...usedMappings.values()].filter((m) => m.createMasterOnExport)
    : [];

  const xml = buildImportEnvelope({
    companyName: args.companyName,
    masters,
    vouchers: drafts,
    action,
  });

  let totalDebitMinor = 0n;
  let totalCreditMinor = 0n;
  for (const draft of drafts) {
    for (const leg of draft.legs) {
      if (leg.isDebit) totalDebitMinor += leg.amountMinor;
      else totalCreditMinor += leg.amountMinor;
    }
  }

  return {
    batchNumber: await nextBatchNumber(args.tenantId, args.periodStart),
    companyName: args.companyName,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    voucherTypes: [...wanted],
    drafts,
    masters,
    xml,
    hash: payloadHash(xml),
    bytes: Buffer.byteLength(xml, "utf8"),
    totalDebitMinor,
    totalCreditMinor,
    action,
    amendedRemoteIds,
  };
}

async function emptyExport(args: {
  tenantId: string;
  companyName: string;
  periodStart: string;
  periodEnd: string;
  voucherTypes: readonly TallyVoucherType[];
}): Promise<BuiltExport> {
  const xml = buildImportEnvelope({
    companyName: args.companyName,
    vouchers: [],
  });
  return {
    batchNumber: await nextBatchNumber(args.tenantId, args.periodStart),
    companyName: args.companyName,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    voucherTypes: [...args.voucherTypes],
    drafts: [],
    masters: [],
    xml,
    hash: payloadHash(xml),
    bytes: Buffer.byteLength(xml, "utf8"),
    totalDebitMinor: 0n,
    totalCreditMinor: 0n,
    action: "Create",
    amendedRemoteIds: [],
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ PERSIST                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ONE TRANSACTION, AND THE TOTALS ARE WRITTEN LAST.
 *
 * The batch-totals guard (SQL 0026 §7) is DEFERRABLE INITIALLY DEFERRED
 * precisely so this sequence is possible: insert the batch, insert the
 * vouchers, update the totals, commit. An immediate constraint would
 * reject the batch row before its first voucher existed.
 */
export async function persistExport(args: {
  tenantId: string;
  userId: string | null;
  connectionId: string | null;
  built: BuiltExport;
  notes: string | null;
}): Promise<string> {
  return withTenant(args.tenantId, async (tx) => {
    const [batch] = await tx
      .insert(tallyExportBatches)
      .values({
        tenantId: args.tenantId,
        connectionId: args.connectionId,
        batchNumber: args.built.batchNumber,
        periodStart: args.built.periodStart,
        periodEnd: args.built.periodEnd,
        voucherTypes: args.built.voucherTypes,
        status: "generated",
        deliveryMode: "file",
        companyName: args.built.companyName,
        voucherCount: 0,
        masterCount: args.built.masters.length,
        totalDebitMinor: 0n,
        totalCreditMinor: 0n,
        payloadHash: args.built.hash,
        payloadBytes: args.built.bytes,
        generatedAt: new Date(),
        notes: args.notes,
        createdBy: args.userId,
      })
      .returning({ id: tallyExportBatches.id });

    const batchId = batch?.id;
    if (!batchId) throw new Error("The export batch could not be created.");

    if (args.built.drafts.length > 0) {
      await tx.insert(tallyVouchers).values(
        args.built.drafts.map((draft) => {
          let debit = 0n;
          let credit = 0n;
          for (const leg of draft.legs) {
            if (leg.isDebit) debit += leg.amountMinor;
            else credit += leg.amountMinor;
          }
          return {
            tenantId: args.tenantId,
            batchId,
            voucherType: draft.voucherType,
            remoteId: draft.remoteId,
            voucherNumber: draft.voucherNumber ?? null,
            voucherDate: draft.voucherDate,
            sourceType: draft.sourceType,
            sourceId: draft.sourceId,
            partyLedgerName: draft.partyLedgerName ?? null,
            partyGstin: draft.partyGstin ?? null,
            placeOfSupplyCode: draft.placeOfSupplyCode ?? null,
            gstRegistrationType: draft.gstRegistrationType ?? null,
            narration: draft.narration ?? null,
            reference: draft.reference ?? null,
            referenceDate: draft.referenceDate ?? null,
            totalDebitMinor: debit,
            totalCreditMinor: credit,
            entries: draftEntriesForStorage(draft),
            contentHash: draftContentHash(draft),
            isCancelled: draft.isCancelled ?? false,
          };
        }),
      );
    }

    await tx
      .update(tallyExportBatches)
      .set({
        voucherCount: args.built.drafts.length,
        totalDebitMinor: args.built.totalDebitMinor,
        totalCreditMinor: args.built.totalCreditMinor,
      })
      .where(
        and(
          eq(tallyExportBatches.tenantId, args.tenantId),
          eq(tallyExportBatches.id, batchId),
        ),
      );

    return batchId;
  });
}

/* ------------------------------------------------------------------ */
/* GST ENRICHMENT                                                      */
/* ------------------------------------------------------------------ */

type GstFacts = {
  gstin: string | null;
  placeOfSupplyCode: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  projectId: string | null;
  hsnSac: string | null;
  gstRateBps: number | null;
};

/**
 * ⭐ THE GST FIELDS, READ FROM THE DOCUMENT THE TRANSACTION REFERENCES.
 *
 * ⚠️ NOT RE-DERIVED. The place of supply in particular was decided once,
 * at invoice time, by the Phase 32 engine — and for anything relating to
 * immovable property Section 12(3) of the IGST Act makes it the
 * PROPERTY'S state rather than the buyer's. A Bengaluru buyer purchasing
 * a Pune flat is an intra-state supply in Maharashtra. Recomputing it
 * here from an address would flip the invoice between IGST and CGST+SGST
 * in Tally's GST reports while the invoice we actually issued said the
 * other thing.
 */
async function loadGstFacts(
  tenantId: string,
  txRows: readonly { referenceType: string; referenceId: string | null }[],
): Promise<Map<string, GstFacts>> {
  const facts = new Map<string, GstFacts>();

  const referenceIds = txRows
    .filter((row) => row.referenceId !== null)
    .map((row) => row.referenceId as string);
  if (referenceIds.length === 0) return facts;

  const [purchases, sales] = await Promise.all([
    withTenant(tenantId, async (tx) =>
      tx
        .select({
          id: purchaseInvoices.id,
          supplierGstin: purchaseInvoices.supplierGstin,
          placeOfSupplyCode: purchaseInvoices.placeOfSupplyCode,
          invoiceNumber: purchaseInvoices.invoiceNumber,
          invoiceDate: purchaseInvoices.invoiceDate,
          projectId: purchaseInvoices.projectId,
        })
        .from(purchaseInvoices)
        .where(
          and(
            eq(purchaseInvoices.tenantId, tenantId),
            inArray(purchaseInvoices.id, referenceIds),
          ),
        ),
    ),
    withTenant(tenantId, async (tx) =>
      tx
        .select({
          id: invoices.id,
          customerGstin: invoices.customerGstin,
          placeOfSupplyCode: invoices.placeOfSupplyCode,
          invoiceNumber: invoices.invoiceNumber,
        })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, referenceIds))),
    ),
  ]);

  for (const row of purchases) {
    facts.set(row.id, {
      gstin: row.supplierGstin,
      placeOfSupplyCode: row.placeOfSupplyCode,
      documentNumber: row.invoiceNumber,
      documentDate: row.invoiceDate,
      projectId: row.projectId,
      // ⚠️ HSN is per LINE, not per invoice, and a voucher built from the
      // ledger has no line detail. Left null rather than picking the first
      // line's code — a single HSN stamped on a mixed bill is a wrong
      // classification in Tally's HSN summary, which is filed.
      hsnSac: null,
      gstRateBps: null,
    });
  }

  for (const row of sales) {
    facts.set(row.id, {
      gstin: row.customerGstin,
      placeOfSupplyCode: row.placeOfSupplyCode,
      documentNumber: row.invoiceNumber,
      documentDate: null,
      projectId: null,
      hsnSac: null,
      gstRateBps: null,
    });
  }

  return facts;
}

/* ------------------------------------------------------------------ */
/* MONEY                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `toPaise()` LIVED HERE AND WAS DELETED BY BATCH 0108, NOT ORPHANED.
 *
 * It turned the `numeric(18,2)` string this table used to hold into a
 * bigint of paise by string surgery — correctly, and with a good reason
 * written down for why it was not `Number(x) * 100`. What it could not do
 * was be right for any currency but a two-decimal one: its last line was
 * `BigInt(whole) * 100n + BigInt(paise)`, a hardcoded hundred, so a KWD
 * voucher left here understated by a factor of ten.
 *
 * `journal_entries.amount_minor` now holds the integer directly, so there
 * is nothing left to convert. Deleting it was the point of the batch;
 * leaving it behind unused would have been one more thing in this
 * codebase that exists and is reached by nothing.
 */

/** For the "what is still unmapped?" screen. Exported for the actions layer. */
export function describeGroup(group: string): string {
  return (
    TALLY_PRIMARY_GROUPS[group as keyof typeof TALLY_PRIMARY_GROUPS] ?? group
  );
}
