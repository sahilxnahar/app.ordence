import "server-only";

/**
 * Ordence — Credit control reads (internal)
 * Version: v1.46.0-alpha (Batch 40)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `server-only`, FOR THE SAME REASON AS `lib/credit/enforce.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Every function here takes a `tenantId` and an open transaction. In a
 * `"use server"` file that would be a published RPC endpoint accepting
 * the tenant to operate on — the single route past row-level security.
 * The declaration is what makes it unreachable from a browser, and
 * `check:boundaries` enforces the declaration.
 *
 * ⚠️ EVERY QUERY HERE STILL CARRIES `eq(table.tenantId, tenantId)`
 * DESPITE RLS. RLS is the boundary and the predicate is the message: a
 * refusal from RLS is a 500, a refusal from a predicate is an empty
 * result the caller can turn into a sentence.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  creditDunningLadders,
  creditDunningLog,
  creditDunningStages,
  creditHoldEvents,
  customerCreditProfiles,
} from "@/db/schema/credit";
import { companies, contacts } from "@/db/schema/crm";
import { salesOrders } from "@/db/schema/orders";
import {
  customerReceiptAllocations,
  customerReceipts,
  salesInvoices,
} from "@/db/schema/sales-invoices";
import { toBigIntAmount } from "@/lib/billing/money";
import {
  INVOICE_EXCLUDED_STATUSES,
  ORDER_EXCLUDED_STATUSES,
  type InvoiceExposureFact,
  type OrderCommitmentFact,
} from "@/lib/credit/headroom";
import { dunningKey, type DunningInvoiceFact, type DunningStageFact } from "@/lib/credit/dunning";
import type { withTenant } from "@/db";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * 🔴 THE RECEIPT STATUSES THAT SETTLE AN INVOICE, QUOTED FROM 0049 §2.
 *
 * ⚠️ THIS LIST MUST MATCH `sales_invoice_recalc_settlement()` EXACTLY, and
 * matching it is not a shared source — it is a shared DEFINITION. The
 * reconciliation check in `lib/credit/headroom.ts` compares the
 * maintained column `sales_invoices.received_minor` against a sum over
 * `customer_receipt_allocations` computed here. What the check is looking
 * for is the COLUMN going stale: a trigger that did not fire, a restore,
 * a backfill, a direct UPDATE.
 *
 * 🔴 IF THIS LIST DRIFTED FROM 0049'S, EVERY CUSTOMER WOULD BREACH and
 * the board would refuse to show a headroom figure for anybody — a false
 * breach, which trains people to ignore the real one. Changing 0049's
 * definition means changing this line in the same commit.
 */
const SETTLING_RECEIPT_STATUSES = ["pending", "cleared"] as const;

/* ------------------------------------------------------------------ */
/* EXPOSURE                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every invoice that bears on a customer's credit position, with BOTH
 * readings of what has been received against it.
 *
 * ⚠️ `allocatedMinor` IS LOADED EVEN THOUGH THE EXPOSURE ARITHMETIC
 * NEVER USES IT. It exists solely so the reconciliation has a second
 * source. A "tidy-up" that drops it because nothing reads it collapses a
 * two-source check into a one-source one, which `reconcile()` would then
 * fault — see the independence guard in `lib/reconciliation/gate.ts`.
 */
export async function loadInvoiceFacts(
  tx: Tx,
  tenantId: string,
  companyIds: readonly string[],
): Promise<Map<string, InvoiceExposureFact[]>> {
  const byCompany = new Map<string, InvoiceExposureFact[]>();
  if (companyIds.length === 0) return byCompany;

  const rows = await tx
    .select({
      id: salesInvoices.id,
      companyId: salesInvoices.companyId,
      invoiceNumber: salesInvoices.invoiceNumber,
      status: salesInvoices.status,
      orderId: salesInvoices.orderId,
      dueDate: salesInvoices.dueDate,
      totalMinor: salesInvoices.totalMinor,
      receivedMinor: salesInvoices.receivedMinor,
    })
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.tenantId, tenantId),
        inArray(salesInvoices.companyId, [...companyIds]),
      ),
    );

  /**
   * 🔴 THE SECOND SOURCE, LOADED AS ITS OWN QUERY AGAINST ITS OWN TABLE.
   *
   * ⚠️ NOT A JOIN ONTO THE INVOICE SELECT ABOVE, AND NOT A CTE. Two
   * separate statements against two separate tables is what makes the
   * reconciliation in `lib/credit/headroom.ts` a two-source check rather
   * than a restatement of one row. A single query producing both numbers
   * would still LOOK like a reconciliation — a green tick, a
   * "reconciled" badge — while proving only that the query is
   * deterministic. See ① in the header of `lib/reconciliation/gate.ts`.
   */
  const allocationRows =
    rows.length === 0
      ? []
      : await tx
          .select({
            invoiceId: customerReceiptAllocations.invoiceId,
            allocatedMinor: sql<string>`COALESCE(SUM(${customerReceiptAllocations.amountMinor}), 0)`,
          })
          .from(customerReceiptAllocations)
          .innerJoin(
            customerReceipts,
            and(
              eq(customerReceipts.id, customerReceiptAllocations.receiptId),
              eq(customerReceipts.tenantId, customerReceiptAllocations.tenantId),
            ),
          )
          .where(
            and(
              eq(customerReceiptAllocations.tenantId, tenantId),
              inArray(customerReceipts.status, [...SETTLING_RECEIPT_STATUSES]),
              inArray(
                customerReceiptAllocations.invoiceId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .groupBy(customerReceiptAllocations.invoiceId);

  const allocatedByInvoice = new Map<string, bigint>(
    allocationRows.map((a) => [a.invoiceId, toBigIntAmount(a.allocatedMinor)]),
  );

  for (const r of rows) {
    const fact: InvoiceExposureFact = {
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      status: r.status,
      orderId: r.orderId,
      dueDate: r.dueDate,
      /**
       * ⚠️ `toBigIntAmount` ON EVERY MONEY COLUMN, NOT A CAST. Drizzle
       * returns `mode: "bigint"` columns as strings on the HTTP driver
       * path and as bigints on the WebSocket one. A raw value reaching
       * the arithmetic as a string makes `total - received` a string
       * subtraction — loud on a good day, silent on a bad one.
       */
      totalMinor: toBigIntAmount(r.totalMinor),
      receivedMinor: toBigIntAmount(r.receivedMinor),
      allocatedMinor: allocatedByInvoice.get(r.id) ?? 0n,
    };
    const list = byCompany.get(r.companyId);
    if (list) list.push(fact);
    else byCompany.set(r.companyId, [fact]);
  }

  return byCompany;
}

/** Every live order, for the unbilled half of the exposure. */
export async function loadOrderCommitments(
  tx: Tx,
  tenantId: string,
  companyIds: readonly string[],
): Promise<Map<string, OrderCommitmentFact[]>> {
  const byCompany = new Map<string, OrderCommitmentFact[]>();
  if (companyIds.length === 0) return byCompany;

  /**
   * ⚠️ FILTERED IN SQL AND FILTERED AGAIN BY `unbilledCommitment()`. The
   * SQL filter is the index-friendly one; the second is what a test can
   * exercise without a database. They read the same constant, so they
   * cannot disagree.
   */
  const counted = salesOrders.status.enumValues.filter(
    (s) => !ORDER_EXCLUDED_STATUSES.includes(s),
  );

  const rows = await tx
    .select({
      id: salesOrders.id,
      companyId: salesOrders.companyId,
      orderNo: salesOrders.orderNo,
      status: salesOrders.status,
      totalMinor: salesOrders.totalMinor,
    })
    .from(salesOrders)
    .where(
      and(
        eq(salesOrders.tenantId, tenantId),
        inArray(salesOrders.companyId, [...companyIds]),
        inArray(salesOrders.status, counted),
      ),
    );

  for (const r of rows) {
    if (!r.companyId) continue;
    const fact: OrderCommitmentFact = {
      id: r.id,
      orderNo: r.orderNo,
      status: r.status,
      totalMinor: toBigIntAmount(r.totalMinor),
    };
    const list = byCompany.get(r.companyId);
    if (list) list.push(fact);
    else byCompany.set(r.companyId, [fact]);
  }

  return byCompany;
}

/* ------------------------------------------------------------------ */
/* CUSTOMERS OF INTEREST                                               */
/* ------------------------------------------------------------------ */

export type CreditSubject = {
  companyId: string;
  companyName: string;
  creditLimitMinor: bigint | null;
  autoHoldEnabled: boolean;
  dunningLadderId: string | null;
  activeHold: {
    id: string;
    source: "manual" | "automatic";
    reason: string;
    placedAt: Date;
  } | null;
};

/**
 * The customers the credit board is about.
 *
 * ⚠️ A CREDIT PROFILE ROW, OR AN ACTIVE HOLD. Not every company in the
 * workspace: a board that lists ten thousand customers with no limit set
 * and ₹0 exposure is a board nobody opens, and the exposure query behind
 * it would read every invoice ever raised. A customer with no profile
 * and no hold has no ceiling and cannot be over it — there is nothing to
 * say about them that the customer record does not already say.
 */
export async function loadCreditSubjects(
  tx: Tx,
  tenantId: string,
): Promise<CreditSubject[]> {
  const profiles = await tx
    .select({
      companyId: customerCreditProfiles.companyId,
      companyName: companies.name,
      creditLimitMinor: customerCreditProfiles.creditLimitMinor,
      autoHoldEnabled: customerCreditProfiles.autoHoldEnabled,
      dunningLadderId: customerCreditProfiles.dunningLadderId,
    })
    .from(customerCreditProfiles)
    .innerJoin(
      companies,
      and(
        eq(companies.id, customerCreditProfiles.companyId),
        eq(companies.tenantId, customerCreditProfiles.tenantId),
      ),
    )
    .where(eq(customerCreditProfiles.tenantId, tenantId));

  const holds = await tx
    .select({
      id: creditHoldEvents.id,
      companyId: creditHoldEvents.companyId,
      companyName: companies.name,
      source: creditHoldEvents.source,
      reason: creditHoldEvents.reason,
      placedAt: creditHoldEvents.placedAt,
    })
    .from(creditHoldEvents)
    .innerJoin(
      companies,
      and(
        eq(companies.id, creditHoldEvents.companyId),
        eq(companies.tenantId, creditHoldEvents.tenantId),
      ),
    )
    .where(
      and(eq(creditHoldEvents.tenantId, tenantId), isNull(creditHoldEvents.releasedAt)),
    )
    .orderBy(desc(creditHoldEvents.placedAt));

  const holdByCompany = new Map<string, (typeof holds)[number]>();
  for (const h of holds) if (!holdByCompany.has(h.companyId)) holdByCompany.set(h.companyId, h);

  const subjects = new Map<string, CreditSubject>();

  for (const p of profiles) {
    subjects.set(p.companyId, {
      companyId: p.companyId,
      companyName: p.companyName,
      creditLimitMinor:
        p.creditLimitMinor === null ? null : toBigIntAmount(p.creditLimitMinor),
      autoHoldEnabled: p.autoHoldEnabled,
      dunningLadderId: p.dunningLadderId,
      activeHold: null,
    });
  }

  for (const [companyId, h] of holdByCompany) {
    const existing = subjects.get(companyId);
    const activeHold = {
      id: h.id,
      source: h.source,
      reason: h.reason,
      placedAt: h.placedAt,
    };
    if (existing) existing.activeHold = activeHold;
    else
      subjects.set(companyId, {
        companyId,
        companyName: h.companyName,
        creditLimitMinor: null,
        autoHoldEnabled: false,
        dunningLadderId: null,
        activeHold,
      });
  }

  return [...subjects.values()].sort((a, b) => a.companyName.localeCompare(b.companyName));
}

/* ------------------------------------------------------------------ */
/* DUNNING                                                             */
/* ------------------------------------------------------------------ */

/**
 * The ladder to chase with: the one asked for, else the tenant's
 * default, else nothing.
 *
 * ⚠️ "ELSE NOTHING" IS THE ANSWER, NOT "ELSE A BUILT-IN 15/30/60". A
 * default ladder shipped by us would be the schedule most workspaces
 * chase on, chosen by nobody, and the first time it is wrong it is wrong
 * in front of a customer.
 */
export async function loadDunningLadder(
  tx: Tx,
  tenantId: string,
  ladderId?: string,
): Promise<{ id: string; name: string; stages: DunningStageFact[] } | null> {
  const [ladder] = await tx
    .select({ id: creditDunningLadders.id, name: creditDunningLadders.name })
    .from(creditDunningLadders)
    .where(
      ladderId
        ? and(
            eq(creditDunningLadders.tenantId, tenantId),
            eq(creditDunningLadders.id, ladderId),
            eq(creditDunningLadders.isActive, true),
          )
        : and(
            eq(creditDunningLadders.tenantId, tenantId),
            eq(creditDunningLadders.isDefault, true),
            eq(creditDunningLadders.isActive, true),
          ),
    )
    .limit(1);

  if (!ladder) return null;

  const stages = await tx
    .select({
      id: creditDunningStages.id,
      stageNo: creditDunningStages.stageNo,
      label: creditDunningStages.label,
      daysPastDue: creditDunningStages.daysPastDue,
      channel: creditDunningStages.channel,
      templateKey: creditDunningStages.templateKey,
      placesHold: creditDunningStages.placesHold,
    })
    .from(creditDunningStages)
    .where(
      and(
        eq(creditDunningStages.tenantId, tenantId),
        eq(creditDunningStages.ladderId, ladder.id),
      ),
    );

  return { id: ladder.id, name: ladder.name, stages };
}

/**
 * Every invoice that could be chased, with the contact it would be
 * chased at.
 *
 * ⚠️ `draft` AND `cancelled` ARE EXCLUDED IN SQL. A customer has never
 * seen a draft; chasing one is chasing them for a document that does not
 * exist.
 */
export async function loadChaseableInvoices(
  tx: Tx,
  tenantId: string,
): Promise<DunningInvoiceFact[]> {
  const rows = await tx
    .select({
      id: salesInvoices.id,
      invoiceNumber: salesInvoices.invoiceNumber,
      companyId: salesInvoices.companyId,
      companyName: companies.name,
      companyPhone: companies.phone,
      status: salesInvoices.status,
      dueDate: salesInvoices.dueDate,
      totalMinor: salesInvoices.totalMinor,
      receivedMinor: salesInvoices.receivedMinor,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
    })
    .from(salesInvoices)
    .innerJoin(
      companies,
      and(
        eq(companies.id, salesInvoices.companyId),
        eq(companies.tenantId, salesInvoices.tenantId),
      ),
    )
    .leftJoin(
      contacts,
      and(
        eq(contacts.id, salesInvoices.contactId),
        eq(contacts.tenantId, salesInvoices.tenantId),
      ),
    )
    .where(eq(salesInvoices.tenantId, tenantId));

  return rows
    /**
     * ⚠️ THE SAME EXCLUSION LIST THE EXPOSURE ARITHMETIC USES, IMPORTED
     * RATHER THAN RETYPED. A customer has never seen a draft; chasing
     * one is chasing them for a document that does not exist. A
     * cancelled invoice is not a debt.
     */
    .filter((r) => !INVOICE_EXCLUDED_STATUSES.includes(r.status))
    .map((r) => {
      const outstanding = toBigIntAmount(r.totalMinor) - toBigIntAmount(r.receivedMinor);
      const name = [r.contactFirstName, r.contactLastName].filter(Boolean).join(" ").trim();
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        companyId: r.companyId,
        companyName: r.companyName,
        dueDate: r.dueDate,
        outstandingMinor: outstanding > 0n ? outstanding : 0n,
        recipientName: name.length > 0 ? name : r.companyName,
        recipientEmail: r.contactEmail,
        /** ⚠️ The company's number is the fallback, never a guess at one. */
        recipientPhone: r.contactPhone ?? r.companyPhone,
      } satisfies DunningInvoiceFact;
    });
}

/**
 * Every (invoice, stage) pair already recorded for this tenant.
 *
 * ⚠️ THE READABLE HALF OF THE IDEMPOTENCY STORY. The enforcing half is
 * `credit_dunning_log_once_per_stage_key`. See the header of
 * `lib/credit/dunning.ts` — this set is what lets the sweep report which
 * stages it skipped; the index is what holds when two containers run it
 * in the same millisecond.
 */
export async function loadRecordedDunning(
  tx: Tx,
  tenantId: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({
      invoiceId: creditDunningLog.invoiceId,
      stageId: creditDunningLog.stageId,
    })
    .from(creditDunningLog)
    .where(eq(creditDunningLog.tenantId, tenantId));

  return new Set(rows.map((r) => dunningKey(r.invoiceId, r.stageId)));
}
