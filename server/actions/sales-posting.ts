"use server";

/**
 * Ordence — ⭐ Mapping the chart of accounts, and clearing the backlog
 * Version: v0.99.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT. The
 * posting itself lives in `server/accounting/post-sales.ts`, which is
 * `import "server-only"` precisely because its functions DO take a
 * tenant and a transaction.
 */

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { ledgers, salesPostingAccounts } from "@/db/schema/accounting";
import {
  salesInvoices,
  salesCreditNotes,
  customerReceipts,
} from "@/db/schema/sales-invoices";
import { companies } from "@/db/schema/crm";
import { purchaseInvoices, purchaseInvoiceLines, vendors } from "@/db/schema/purchases";
import { raBills } from "@/db/schema/contracting";
import { demandNotices } from "@/db/schema/receivables";
import { bookings } from "@/db/schema/sales";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  postSalesInvoice,
  postSalesCreditNote,
  postCustomerReceipt,
  postPurchaseInvoice,
  postRaBill,
  postPossession,
  postedKeys,
  salesTransactionKey,
} from "@/server/accounting/post-sales";
import {
  POSTING_ROLE_META,
  PURCHASE_ROLE_META,
  CONSTRUCTION_ROLE_META,
  PROPERTY_ROLE_META,
  type PostingRole,
  type PurchasePostingRole,
} from "@/lib/accounting/sales-posting";

/**
 * ⚠️ ONE MAP TABLE, TWO ROLE SETS. `sales_posting_accounts` is keyed by an
 * opaque `role` varchar precisely so the purchase roles are rows rather
 * than a second table carrying a second RLS policy to keep in step.
 */
const ALL_ROLE_META: Record<
  string,
  { label: string; tallyGroup: string; accountType: string; help: string }
> = { ...POSTING_ROLE_META, ...PURCHASE_ROLE_META, ...CONSTRUCTION_ROLE_META, ...PROPERTY_ROLE_META };
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const setAccountSchema = z.object({
  role: z.enum(
    Object.keys(ALL_ROLE_META) as [string, ...string[]],
  ),
  ledgerId: z.string().uuid(),
});

/**
 * ⚠️ GATED ON `settings:update`, NOT on an invoicing permission. Choosing
 * which ledger turnover lands in is a decision about the books, not about
 * a document — and somebody who may raise an invoice should not be able
 * to silently redirect a year of revenue into a different account.
 */
const SETTINGS_PERMISSION = "settings:update" as const;

export async function getSalesPostingSetup(): Promise<
  ActionResult<{
    roles: {
      role: PostingRole | PurchasePostingRole;
      side: "sales" | "purchase" | "construction" | "property";
      label: string;
      tallyGroup: string;
      accountType: string;
      help: string;
      ledgerId: string | null;
      ledgerLabel: string | null;
    }[];
    ledgers: { id: string; code: string; name: string; accountType: string }[];
    unmappedCount: number;
  }>
> {
  try {
    const ctx = await requirePermission("sales.invoices.read");

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [mapped, available] = await Promise.all([
        tx
          .select({
            role: salesPostingAccounts.role,
            ledgerId: salesPostingAccounts.ledgerId,
          })
          .from(salesPostingAccounts)
          .where(eq(salesPostingAccounts.tenantId, ctx.tenant.id)),
        tx
          .select({
            id: ledgers.id,
            code: ledgers.code,
            name: ledgers.name,
            accountType: ledgers.accountType,
          })
          .from(ledgers)
          .where(and(eq(ledgers.tenantId, ctx.tenant.id), isNull(ledgers.deletedAt)))
          .orderBy(ledgers.code),
      ]);

      const byRole = new Map(mapped.map((m) => [m.role, m.ledgerId]));
      const byId = new Map(available.map((l) => [l.id, `${l.code} — ${l.name}`]));

      const roles = Object.keys(ALL_ROLE_META).map((role) => {
        const ledgerId = byRole.get(role) ?? null;
        const meta = ALL_ROLE_META[role] as {
          label: string;
          tallyGroup: string;
          accountType: string;
          help: string;
        };
        return {
          role: role as PostingRole | PurchasePostingRole,
          /** ⚠️ Grouped on screen — nine sales roles and nine purchase
           *  roles in one undifferentiated list is a form nobody finishes. */
          side: (role in PROPERTY_ROLE_META
            ? "property"
            : role in CONSTRUCTION_ROLE_META
              ? "construction"
              : role in PURCHASE_ROLE_META
                ? "purchase"
                : "sales") as "sales" | "purchase" | "construction" | "property",
          ...meta,
          ledgerId,
          ledgerLabel: ledgerId ? (byId.get(ledgerId) ?? null) : null,
        };
      });

      return {
        roles,
        ledgers: available,
        unmappedCount: roles.filter((r) => r.ledgerId === null).length,
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getSalesPostingSetup");
  }
}

export async function setSalesPostingAccount(
  input: unknown,
): Promise<ActionResult<{ role: string }>> {
  try {
    const data = setAccountSchema.parse(input);
    const ctx = await requirePermission(SETTINGS_PERMISSION);

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * ⚠️ THE LEDGER IS VERIFIED TO BE THIS TENANT'S. The unique index
         * would not catch a uuid from another workspace — RLS would, but
         * relying on a policy to produce a comprehensible error is how a
         * user gets "permission denied" for a typo.
         */
        const [ledger] = await tx
          .select({ id: ledgers.id })
          .from(ledgers)
          .where(
            and(
              eq(ledgers.tenantId, ctx.tenant.id),
              eq(ledgers.id, data.ledgerId),
              isNull(ledgers.deletedAt),
            ),
          )
          .limit(1);

        if (!ledger) throw new Error("That ledger no longer exists.");

        await tx
          .insert(salesPostingAccounts)
          .values({
            tenantId: ctx.tenant.id,
            role: data.role,
            ledgerId: data.ledgerId,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .onConflictDoUpdate({
            target: [salesPostingAccounts.tenantId, salesPostingAccounts.role],
            set: {
              ledgerId: data.ledgerId,
              updatedBy: ctx.user.id,
              updatedAt: new Date(),
            },
          });

        /**
         * ⚠️ `critical`, AND IT RECORDS THE ROLE. Re-pointing "revenue"
         * at a different ledger silently changes where every future
         * invoice lands. The change itself is legitimate; being unable to
         * find out when it happened is not.
         */
        await writeAudit(ctx, {
          action: "update",
          resourceType: "sales_posting_account",
          resourceId: data.ledgerId,
          newValue: { role: data.role, ledgerId: data.ledgerId },
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/accounting/posting");
    return { ok: true, data: { role: data.role } };
  } catch (err) {
    return toSalesActionError(err, "setSalesPostingAccount");
  }
}

type BacklogRow = {
  kind: "invoice" | "credit_note" | "receipt" | "purchase" | "ra_bill";
  id: string;
  number: string;
  date: string;
  customerName: string | null;
  amountMinor: string;
};

/**
 * ⭐ WHAT IS ISSUED AND NOT IN THE BOOKS.
 *
 * ⚠️ DERIVED, NEVER STORED. "Issued, with no `SALES:` transaction against
 * it" is the definition — so it cannot drift out of step with reality the
 * way a status column does, and correcting one never needs a migration.
 */
export async function getSalesPostingBacklog(): Promise<
  ActionResult<{ rows: BacklogRow[]; totalMinor: string }>
> {
  try {
    const ctx = await requirePermission("sales.invoices.read");

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [invs, notes, receipts, bills, raRows] = await Promise.all([
        tx
          .select({
            id: salesInvoices.id,
            number: salesInvoices.invoiceNumber,
            date: salesInvoices.invoiceDate,
            customerName: salesInvoices.customerLegalName,
            amount: salesInvoices.totalMinor,
          })
          .from(salesInvoices)
          .where(
            and(
              eq(salesInvoices.tenantId, ctx.tenant.id),
              /** ⚠️ Drafts have no number and no accounting effect. */
              inArray(salesInvoices.status, ["issued", "part_paid", "paid"]),
            ),
          ),
        tx
          .select({
            id: salesCreditNotes.id,
            number: salesCreditNotes.creditNoteNumber,
            date: salesCreditNotes.noteDate,
            customerName: salesCreditNotes.customerLegalName,
            amount: salesCreditNotes.totalMinor,
          })
          .from(salesCreditNotes)
          .where(
            and(
              eq(salesCreditNotes.tenantId, ctx.tenant.id),
              inArray(salesCreditNotes.status, ["issued", "part_paid", "paid"]),
            ),
          ),
        tx
          .select({
            id: customerReceipts.id,
            number: customerReceipts.receiptNumber,
            date: customerReceipts.receivedOn,
            customerName: companies.name,
            amount: customerReceipts.amountMinor,
            tds: customerReceipts.tdsCreditMinor,
          })
          .from(customerReceipts)
          .leftJoin(
            companies,
            and(
              eq(companies.id, customerReceipts.companyId),
              eq(companies.tenantId, ctx.tenant.id),
            ),
          )
          .where(
            and(
              eq(customerReceipts.tenantId, ctx.tenant.id),
              eq(customerReceipts.status, "cleared"),
            ),
          ),
        /**
         * ⚠️ DRAFTS AND CANCELLED BILLS ARE EXCLUDED. A draft has not been
         * accepted as a liability, and a cancelled one never was.
         */
        tx
          .select({
            id: purchaseInvoices.id,
            number: purchaseInvoices.invoiceNumber,
            date: purchaseInvoices.invoiceDate,
            vendorName: vendors.legalName,
            amount: purchaseInvoices.totalMinor,
          })
          .from(purchaseInvoices)
          .leftJoin(
            vendors,
            and(
              eq(vendors.id, purchaseInvoices.vendorId),
              eq(vendors.tenantId, ctx.tenant.id),
            ),
          )
          .where(
            and(
              eq(purchaseInvoices.tenantId, ctx.tenant.id),
              inArray(purchaseInvoices.status, ["recorded", "approved", "paid"]),
            ),
          ),
        /** ⚠️ From CERTIFIED onward — that is when the work was proved. */
        tx
          .select({
            id: raBills.id,
            number: raBills.billNo,
            date: raBills.periodTo,
            vendorName: vendors.legalName,
            amount: raBills.grossValueMinor,
          })
          .from(raBills)
          .leftJoin(
            vendors,
            and(eq(vendors.id, raBills.vendorId), eq(vendors.tenantId, ctx.tenant.id)),
          )
          .where(
            and(
              eq(raBills.tenantId, ctx.tenant.id),
              inArray(raBills.status, ["certified", "approved", "paid"]),
            ),
          ),
      ]);

      const candidates: (BacklogRow & { key: string })[] = [
        ...invs.map((r) => ({
          kind: "invoice" as const,
          id: r.id,
          number: r.number,
          date: String(r.date),
          customerName: r.customerName,
          amountMinor: serializeAmount(toBigIntAmount(r.amount)),
          key: salesTransactionKey("invoice", r.id),
        })),
        ...notes.map((r) => ({
          kind: "credit_note" as const,
          id: r.id,
          number: r.number,
          date: String(r.date),
          customerName: r.customerName,
          amountMinor: serializeAmount(toBigIntAmount(r.amount)),
          key: salesTransactionKey("credit_note", r.id),
        })),
        ...receipts.map((r) => ({
          kind: "receipt" as const,
          id: r.id,
          number: r.number,
          date: String(r.date),
          customerName: r.customerName,
          amountMinor: serializeAmount(
            toBigIntAmount(r.amount) + toBigIntAmount(r.tds),
          ),
          key: salesTransactionKey("receipt", r.id),
        })),
        ...bills.map((r) => ({
          kind: "purchase" as const,
          id: r.id,
          number: r.number,
          date: String(r.date),
          customerName: r.vendorName,
          amountMinor: serializeAmount(toBigIntAmount(r.amount)),
          key: salesTransactionKey("purchase", r.id),
        })),
        ...raRows.map((r) => ({
          kind: "ra_bill" as const,
          id: r.id,
          number: r.number,
          date: r.date ? String(r.date) : "",
          customerName: r.vendorName,
          amountMinor: serializeAmount(toBigIntAmount(r.amount)),
          key: salesTransactionKey("ra_bill", r.id),
        })),
      ];

      const done = await postedKeys(
        tx,
        ctx.tenant.id,
        candidates.map((c) => c.key),
      );

      const rows = candidates
        .filter((c) => !done.has(c.key))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      let total = 0n;
      for (const r of rows) total += BigInt(r.amountMinor);

      return {
        rows: rows.map(({ key: _k, ...rest }) => rest),
        totalMinor: serializeAmount(total),
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getSalesPostingBacklog");
  }
}

/**
 * Post everything that can be posted.
 *
 * ⚠️ IT REPORTS WHAT IT COULD NOT DO, and does not treat that as failure.
 * A tenant who has mapped seven of nine roles can post their invoices and
 * not their receipts, and being told exactly that is more useful than a
 * refusal with no breakdown.
 *
 * ⚠️ EACH DOCUMENT GETS ITS OWN TRANSACTION. One long transaction over
 * three hundred documents holds locks on `transactions` for the whole
 * run and rolls the lot back on the last one. Idempotency is what makes
 * per-document safe: a re-run skips what already landed.
 */
export async function postSalesBacklog(): Promise<
  ActionResult<{ posted: number; skipped: number; missingRoles: string[] }>
> {
  try {
    const ctx = await requirePermission(SETTINGS_PERMISSION);
    const backlog = await getSalesPostingBacklog();
    if (!backlog.ok) return backlog;

    let posted = 0;
    let skipped = 0;
    const missing = new Set<string>();

    for (const row of backlog.data.rows) {
      const outcome = await withTenant(
        ctx.tenant.id,
        async (tx) => {
          if (row.kind === "invoice") {
            const [inv] = await tx
              .select()
              .from(salesInvoices)
              .where(
                and(
                  eq(salesInvoices.tenantId, ctx.tenant.id),
                  eq(salesInvoices.id, row.id),
                ),
              )
              .limit(1);
            if (!inv) return null;
            return postSalesInvoice(tx, {
              tenantId: ctx.tenant.id,
              userId: ctx.user.id,
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              invoiceDate: String(inv.invoiceDate),
              companyId: inv.companyId,
              customerName: inv.customerLegalName,
              tax: {
                taxableValueMinor: toBigIntAmount(inv.taxableValueMinor),
                cgstMinor: toBigIntAmount(inv.cgstMinor),
                sgstMinor: toBigIntAmount(inv.sgstMinor),
                igstMinor: toBigIntAmount(inv.igstMinor),
                cessMinor: toBigIntAmount(inv.cessMinor),
                roundOffMinor: toBigIntAmount(inv.roundOffMinor),
                totalMinor: toBigIntAmount(inv.totalMinor),
              },
            });
          }

          if (row.kind === "credit_note") {
            const [note] = await tx
              .select()
              .from(salesCreditNotes)
              .where(
                and(
                  eq(salesCreditNotes.tenantId, ctx.tenant.id),
                  eq(salesCreditNotes.id, row.id),
                ),
              )
              .limit(1);
            if (!note) return null;
            const [inv] = await tx
              .select({ invoiceNumber: salesInvoices.invoiceNumber })
              .from(salesInvoices)
              .where(
                and(
                  eq(salesInvoices.tenantId, ctx.tenant.id),
                  eq(salesInvoices.id, note.invoiceId),
                ),
              )
              .limit(1);
            return postSalesCreditNote(tx, {
              tenantId: ctx.tenant.id,
              userId: ctx.user.id,
              creditNoteId: note.id,
              creditNoteNumber: note.creditNoteNumber,
              noteDate: String(note.noteDate),
              invoiceNumber: inv?.invoiceNumber ?? "—",
              companyId: note.companyId,
              customerName: note.customerLegalName,
              tax: {
                taxableValueMinor: toBigIntAmount(note.taxableValueMinor),
                cgstMinor: toBigIntAmount(note.cgstMinor),
                sgstMinor: toBigIntAmount(note.sgstMinor),
                igstMinor: toBigIntAmount(note.igstMinor),
                cessMinor: toBigIntAmount(note.cessMinor),
                roundOffMinor: toBigIntAmount(note.roundOffMinor),
                totalMinor: toBigIntAmount(note.totalMinor),
              },
            });
          }

          if (row.kind === "ra_bill") {
            const [b] = await tx
              .select({
                id: raBills.id,
                billNo: raBills.billNo,
                vendorId: raBills.vendorId,
                periodTo: raBills.periodTo,
                grossValueMinor: raBills.grossValueMinor,
                retentionAmountMinor: raBills.retentionAmountMinor,
                tdsAmountMinor: raBills.tdsAmountMinor,
                cessAmountMinor: raBills.cessAmountMinor,
                otherDeductionsMinor: raBills.otherDeductionsMinor,
                netPayableMinor: raBills.netPayableMinor,
                vendorName: vendors.legalName,
              })
              .from(raBills)
              .leftJoin(
                vendors,
                and(eq(vendors.id, raBills.vendorId), eq(vendors.tenantId, ctx.tenant.id)),
              )
              .where(and(eq(raBills.tenantId, ctx.tenant.id), eq(raBills.id, row.id)))
              .limit(1);
            if (!b) return null;
            return postRaBill(tx, {
              tenantId: ctx.tenant.id,
              userId: ctx.user.id,
              billId: b.id,
              billNumber: b.billNo,
              billDate: b.periodTo
                ? String(b.periodTo)
                : new Date().toISOString().slice(0, 10),
              vendorId: b.vendorId,
              contractorName: b.vendorName,
              grossValueMinor: b.grossValueMinor,
              retentionAmountMinor: b.retentionAmountMinor,
              tdsAmountMinor: b.tdsAmountMinor,
              cessAmountMinor: b.cessAmountMinor,
              otherDeductionsMinor: b.otherDeductionsMinor,
              netPayableMinor: b.netPayableMinor,
            });
          }

          if (row.kind === "purchase") {
            const [bill] = await tx
              .select({
                id: purchaseInvoices.id,
                invoiceNumber: purchaseInvoices.invoiceNumber,
                invoiceDate: purchaseInvoices.invoiceDate,
                vendorId: purchaseInvoices.vendorId,
                vendorName: vendors.legalName,
                roundOffMinor: purchaseInvoices.roundOffMinor,
                totalMinor: purchaseInvoices.totalMinor,
                rcmTaxMinor: purchaseInvoices.rcmTaxMinor,
                rcmSection: purchaseInvoices.rcmSection,
              })
              .from(purchaseInvoices)
              .leftJoin(
                vendors,
                and(
                  eq(vendors.id, purchaseInvoices.vendorId),
                  eq(vendors.tenantId, ctx.tenant.id),
                ),
              )
              .where(
                and(
                  eq(purchaseInvoices.tenantId, ctx.tenant.id),
                  eq(purchaseInvoices.id, row.id),
                ),
              )
              .limit(1);
            if (!bill) return null;

            const billLines = await tx
              .select({
                taxableValueMinor: purchaseInvoiceLines.taxableValueMinor,
                cgstMinor: purchaseInvoiceLines.cgstMinor,
                sgstMinor: purchaseInvoiceLines.sgstMinor,
                igstMinor: purchaseInvoiceLines.igstMinor,
                cessMinor: purchaseInvoiceLines.cessMinor,
                itcEligibility: purchaseInvoiceLines.itcEligibility,
              })
              .from(purchaseInvoiceLines)
              .where(
                and(
                  eq(purchaseInvoiceLines.tenantId, ctx.tenant.id),
                  eq(purchaseInvoiceLines.purchaseInvoiceId, bill.id),
                ),
              );

            const outcome = await postPurchaseInvoice(tx, {
              tenantId: ctx.tenant.id,
              userId: ctx.user.id,
              invoiceId: bill.id,
              invoiceNumber: bill.invoiceNumber,
              invoiceDate: String(bill.invoiceDate),
              vendorId: bill.vendorId,
              vendorName: bill.vendorName,
              lines: billLines.map((l) => ({
                taxableValueMinor: l.taxableValueMinor,
                cgstMinor: l.cgstMinor,
                sgstMinor: l.sgstMinor,
                igstMinor: l.igstMinor,
                cessMinor: l.cessMinor,
                itcBlocked: l.itcEligibility === "blocked",
              })),
              roundOffMinor: bill.roundOffMinor,
              totalMinor: bill.totalMinor,
              rcmTaxMinor: bill.rcmTaxMinor,
              rcmSection: bill.rcmSection,
            });
            /** ⚠️ Normalised so the caller need not know a bill can write two. */
            return outcome.posted
              ? { posted: true as const, transactionId: outcome.transactionIds[0] ?? "" }
              : outcome;
          }

          const [r] = await tx
            .select({
              id: customerReceipts.id,
              receiptNumber: customerReceipts.receiptNumber,
              receivedOn: customerReceipts.receivedOn,
              companyId: customerReceipts.companyId,
              customerName: companies.name,
              amountMinor: customerReceipts.amountMinor,
              tdsCreditMinor: customerReceipts.tdsCreditMinor,
            })
            .from(customerReceipts)
            .leftJoin(
              companies,
              and(
                eq(companies.id, customerReceipts.companyId),
                eq(companies.tenantId, ctx.tenant.id),
              ),
            )
            .where(
              and(
                eq(customerReceipts.tenantId, ctx.tenant.id),
                eq(customerReceipts.id, row.id),
              ),
            )
            .limit(1);
          if (!r) return null;
          return postCustomerReceipt(tx, {
            tenantId: ctx.tenant.id,
            userId: ctx.user.id,
            receiptId: r.id,
            receiptNumber: r.receiptNumber,
            receivedOn: String(r.receivedOn),
            companyId: r.companyId,
            customerName: r.customerName,
            cashMinor: toBigIntAmount(r.amountMinor),
            tdsMinor: toBigIntAmount(r.tdsCreditMinor),
          });
        },
        { impersonationId: ctx.impersonationId },
      );

      if (outcome === null) continue;
      if (outcome.posted) {
        posted += 1;
      } else {
        skipped += 1;
        if (outcome.reason === "unmapped_roles") {
          for (const m of outcome.missing) missing.add(m);
        }
      }
    }

    if (posted > 0) {
      await writeAudit(ctx, {
        action: "create",
        resourceType: "sales_posting_run",
        resourceId: null,
        newValue: { posted, skipped },
        severity: "warning",
      });
    }

    revalidatePath("/accounting/posting");
    revalidatePath("/accounting");
    return { ok: true, data: { posted, skipped, missingRoles: [...missing] } };
  } catch (err) {
    return toSalesActionError(err, "postSalesBacklog");
  }
}

/* ================================================================== */
/* ⭐ POSSESSION — Phase 62                                             */
/* ================================================================== */

/**
 * ⭐⭐ THE ACTION THAT MAKES PROPERTY REVENUE POSSIBLE AT ALL.
 *
 * 🔴 `postPossession()` was written and tested in v1.0.0-rc.3 and
 *    NOTHING COULD CALL IT. A developer running Ordence would collect
 *    every rupee of a project, watch "Advance from Customers" grow to the
 *    whole book value, and report **zero turnover, forever**. Every
 *    figure correct; the P&L empty.
 *
 * ⚠️ THE ADVANCE IS DERIVED FROM THE DEMANDS, NOT TYPED. It is the sum
 * of `principal_minor` on every demand that reached the ledger — which
 * is exactly what sits in the `customer_advance` liability. Accepting a
 * figure from a form would let somebody recognise revenue that no demand
 * ever raised.
 *
 * ⚠️ AND IT IS THE PRINCIPAL, NEVER THE TOTAL. The GST on those demands
 * was credited to output tax, not to the advance. Releasing the total
 * would recognise the Government's money as turnover.
 */
const recordPossessionSchema = z.object({
  bookingId: z.string().uuid(),
  possessionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
  note: z.string().trim().max(2000).optional(),
});

export async function recordPossession(
  input: unknown,
): Promise<ActionResult<{ bookingId: string; revenueRecognisedMinor: string }>> {
  try {
    const data = recordPossessionSchema.parse(input);
    const ctx = await requirePermission(SETTINGS_PERMISSION);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [booking] = await tx
          .select({
            id: bookings.id,
            reference: bookings.reference,
            status: bookings.status,
            unitId: bookings.unitId,
            possessionDate: bookings.possessionDate,
          })
          .from(bookings)
          .where(and(eq(bookings.tenantId, ctx.tenant.id), eq(bookings.id, data.bookingId)))
          .limit(1);

        if (!booking) throw new Error("That booking no longer exists.");

        /**
         * ⚠️ A CANCELLED BOOKING CANNOT BE HANDED OVER. The database
         * refuses it too — `bookings_possession_not_cancelled` in 0052 —
         * because the combination recognises revenue AND refunds the
         * buyer, and it balances.
         */
        if (booking.status === "cancelled") {
          throw new Error(
            `Booking ${booking.reference} was cancelled. A cancelled booking cannot be handed over.`,
          );
        }

        /**
         * ⚠️ REFUSED, NOT SILENTLY RE-DATED. Possession happens once. If
         * the date was wrong, that is a correction somebody should have
         * to make deliberately — moving revenue between financial years
         * is not an edit to wave through.
         */
        if (booking.possessionDate) {
          throw new Error(
            `Possession for booking ${booking.reference} was already recorded on ${booking.possessionDate}. Revenue has been recognised against that date.`,
          );
        }

        const [advance] = await tx
          .select({
            principal: sql<string>`coalesce(sum(${demandNotices.principalMinor}), 0)::text`,
          })
          .from(demandNotices)
          .where(
            and(
              eq(demandNotices.tenantId, ctx.tenant.id),
              eq(demandNotices.bookingId, booking.id),
              /** ⚠️ The same statuses that reached the ledger. */
              inArray(demandNotices.status, ["issued", "part_paid", "paid"]),
            ),
          );

        const advanceMinor = toBigIntAmount(advance?.principal ?? "0");

        if (advanceMinor <= 0n) {
          throw new Error(
            `No demand has been served on booking ${booking.reference}, so there is nothing to recognise. Recording possession would create revenue out of nothing.`,
          );
        }

        await tx
          .update(bookings)
          .set({
            possessionDate: data.possessionDate,
            possessionRecordedAt: new Date(),
            possessionRecordedBy: ctx.user.id,
            possessionNote: data.note ?? null,
          })
          .where(and(eq(bookings.tenantId, ctx.tenant.id), eq(bookings.id, booking.id)));

        await postPossession(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          bookingId: booking.id,
          bookingReference: booking.reference,
          possessionDate: data.possessionDate,
          unitLabel: null,
          buyerName: null,
          advanceMinor,
        });

        /**
         * ⚠️ `critical`. Recognising revenue is the single most
         * consequential thing anybody does in this product — it changes
         * a tax computation.
         */
        await writeAudit(ctx, {
          action: "update",
          resourceType: "booking",
          resourceId: booking.id,
          newValue: {
            possessionDate: data.possessionDate,
            revenueRecognisedMinor: serializeAmount(advanceMinor),
          },
          reason: data.note ?? undefined,
          severity: "critical",
        });

        return { bookingId: booking.id, revenueRecognisedMinor: serializeAmount(advanceMinor) };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/sales/bookings");
    revalidatePath("/accounting/posting");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordPossession");
  }
}

/**
 * Bookings that could be handed over, and what recognising each is worth.
 *
 * ⚠️ IT EXCLUDES BOOKINGS WITH NO SERVED DEMAND. A booking nobody has
 * billed has no advance to release, and offering it would put a button
 * next to a row where pressing it can only produce an error.
 */
export async function listPossessionCandidates(): Promise<
  ActionResult<{
    rows: {
      bookingId: string;
      reference: string;
      status: string;
      advanceMinor: string;
      collectedMinor: string;
      possessionDate: string | null;
    }[];
    pendingTotalMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission("sales.invoices.read");

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          bookingId: bookings.id,
          reference: bookings.reference,
          status: bookings.status,
          possessionDate: bookings.possessionDate,
          advance: sql<string>`coalesce(sum(${demandNotices.principalMinor}), 0)::text`,
          collected: sql<string>`coalesce(sum(${demandNotices.allocatedMinor}), 0)::text`,
        })
        .from(bookings)
        .leftJoin(
          demandNotices,
          and(
            eq(demandNotices.bookingId, bookings.id),
            eq(demandNotices.tenantId, ctx.tenant.id),
            inArray(demandNotices.status, ["issued", "part_paid", "paid"]),
          ),
        )
        .where(
          and(
            eq(bookings.tenantId, ctx.tenant.id),
            notInArray(bookings.status, ["cancelled"]),
          ),
        )
        .groupBy(
          bookings.id,
          bookings.reference,
          bookings.status,
          bookings.possessionDate,
        );

      let pending = 0n;
      const mapped = rows
        .filter((r) => toBigIntAmount(r.advance) > 0n)
        .map((r) => {
          const adv = toBigIntAmount(r.advance);
          if (!r.possessionDate) pending += adv;
          return {
            bookingId: r.bookingId,
            reference: r.reference,
            status: r.status,
            advanceMinor: serializeAmount(adv),
            collectedMinor: serializeAmount(toBigIntAmount(r.collected)),
            possessionDate: r.possessionDate ? String(r.possessionDate) : null,
          };
        })
        .sort((a, b) => (a.reference < b.reference ? -1 : 1));

      return { rows: mapped, pendingTotalMinor: serializeAmount(pending) };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "listPossessionCandidates");
  }
}
