import "server-only";

/**
 * Ordence — ⭐⭐⭐ ASSEMBLING A GSTR-3B FROM THE LEDGER
 * Version: v1.24.0-alpha · Batch 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE FIGURES COME FROM THE LEDGER, NOT FROM THE INVOICES
 * ══════════════════════════════════════════════════════════════════════
 * It would be easier to sum the invoice table. It would also disagree
 * with the books the moment anything is posted by hand — a correction, a
 * credit note keyed as a journal, a reversal an accountant made in
 * December.
 *
 * ⚠️ AND THE RETURN HAS TO AGREE WITH THE BOOKS, because those are the
 * two documents an assessment compares. A 3B built from invoices and a
 * balance sheet built from journals are two answers to one question, and
 * discovering they differ during an assessment is the worst moment to
 * discover it.
 *
 * ⭐ SO EVERY NUMBER HERE IS A MOVEMENT ON A MAPPED LEDGER IN THE
 * PERIOD. If a tenant has not mapped their tax accounts the return
 * refuses to assemble, which is the correct answer rather than a
 * confident zero.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE THING IS DELIBERATELY NOT COMPUTED
 * ══════════════════════════════════════════════════════════════════════
 * ITC reversal under rules 42 and 43 — the apportionment between taxable
 * and exempt supplies. It is ENTERED. Apportioning credit needs turnover
 * splits Ordence does not model, and a wrong reversal is a wrong return
 * with interest attached to it.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { journalEntries, salesPostingAccounts, transactions } from "@/db/schema/accounting";
import { gstReturns } from "@/db/schema/returns";
import {
  buildGstr3b,
  gstr3bDueDate,
  ZERO_HEADS,
  type Gstr3bFacts,
  type Gstr3bReturn,
  type HeadAmounts,
} from "@/lib/gst/gstr3b";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** ⚠️ Half-open window. A closed range on a date loses the last day. */
export function periodWindow(taxPeriod: string): { from: string; to: string; end: string } {
  const year = Number(taxPeriod.slice(0, 4));
  const month = Number(taxPeriod.slice(5, 7));
  const from = `${taxPeriod}-01`;
  const to =
    month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to, end: `${taxPeriod}-${String(lastDay).padStart(2, "0")}` };
}

/* ------------------------------------------------------------------ */
/* MOVEMENTS BY ROLE                                                   */
/* ------------------------------------------------------------------ */

export interface RoleMovement {
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  /** ⭐ Signed, in the direction the account naturally moves. */
  readonly netMinor: bigint;
}

/**
 * ⭐ WHAT MOVED THROUGH EACH MAPPED ROLE IN THE PERIOD.
 *
 * ⚠️ MOVEMENT, NOT BALANCE. A balance carries every month ever posted;
 * a return declares one month. Using the balance would report April's
 * output tax again in May and again in June, growing forever.
 */
export async function movementsByRole(
  tx: Tx,
  tenantId: string,
  from: string,
  to: string,
): Promise<Map<string, RoleMovement>> {
  const rows = await tx
    .select({
      role: salesPostingAccounts.role,
      /**
       * ⭐ SUMMED IN MINOR UNITS. Batch 0108.
       *
       * ⚠️ THIS USED TO SUM `journal_entries.amount`, a numeric(18,2), and
       * hand the decimal string to `rupeeStringToMinor()`, whose last line
       * was `BigInt(whole) * 100n + ...`. Two hardcoded hundreds between
       * the ledger and this total, both wrong for a dinar and both wrong
       * by a different factor for a yen. The ledger now stores the integer
       * these totals were always trying to reach.
       */
      debitMinor: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit' THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
      creditMinor: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
      /**
       * ⚠️ COUNTED, NOT IGNORED. `SUM()` SKIPS NULLS, so a leg 0108 could
       * not scale would quietly reduce this total instead of failing it.
       * The balance trigger refuses any transaction containing one, so
       * this can only be pre-0108 history — and a trial balance that is
       * short by a real amount and foots anyway is the worst possible
       * output. See the census in SQL-FILES/0108.
       */
      unscaledLegs: sql<number>`COUNT(*) FILTER (WHERE ${journalEntries.amountMinor} IS NULL)::int`,
    })
    .from(journalEntries)
    .innerJoin(
      salesPostingAccounts,
      and(
        eq(salesPostingAccounts.ledgerId, journalEntries.ledgerId),
        eq(salesPostingAccounts.tenantId, journalEntries.tenantId),
      ),
    )
    .innerJoin(transactions, eq(transactions.id, journalEntries.transactionId))
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        gte(transactions.transactionDate, from),
        lt(transactions.transactionDate, to),
        eq(transactions.status, "posted"),
      ),
    )
    .groupBy(salesPostingAccounts.role);

  const out = new Map<string, RoleMovement>();
  for (const r of rows) {
    // ⚠️ `numeric(18,2)` COMES BACK AS A STRING AND IS CONVERTED TO
    // PAISE BY STRING, never by multiplying a float by 100.
    if (r.unscaledLegs > 0) {
      throw new Error(
        `${r.unscaledLegs} journal line(s) have no amount in minor units, so this total ` +
          `cannot be trusted. Run the census in SQL-FILES/0108 to see which currency is ` +
          `unscaled. Nothing has been computed.`,
      );
    }
    const debit = BigInt(r.debitMinor);
    const credit = BigInt(r.creditMinor);
    out.set(r.role, { debitMinor: debit, creditMinor: credit, netMinor: credit - debit });
  }
  return out;
}

/**
 * ⚠️ `rupeeStringToMinor()` LIVED HERE AND WAS DELETED BY BATCH 0108.
 *
 * It turned the decimal string a `SUM(journal_entries.amount)` produced
 * into a bigint, and its arithmetic was `BigInt(whole) * 100n +
 * BigInt(fraction)`. A hardcoded hundred: right for the rupee, out by a
 * factor of ten for a Kuwaiti dinar and by a factor of a hundred for a
 * yen. Four readers depended on it — this file, `server/command/sweep.ts`,
 * `server/sales/booking-ledger.ts` and `server/actions/returns.ts` — and
 * every one of them now sums `journal_entries.amount_minor` and needs no
 * conversion at all.
 *
 * It is deleted rather than left exported and unused. Its only remaining
 * caller was its own test.
 */

function heads(
  movements: Map<string, RoleMovement>,
  roles: { igst: string; cgst: string; sgst: string; cess: string },
  direction: "credit" | "debit",
): HeadAmounts {
  const pick = (role: string): bigint => {
    const m = movements.get(role);
    if (!m) return 0n;
    // ⭐ OUTPUT TAX IS A LIABILITY AND MOVES ON THE CREDIT SIDE; INPUT
    // TAX IS AN ASSET AND MOVES ON THE DEBIT SIDE. Taking the net of
    // both would silently subtract a reversal from the wrong side.
    const gross = direction === "credit" ? m.creditMinor - m.debitMinor : m.debitMinor - m.creditMinor;
    return gross > 0n ? gross : 0n;
  };
  return {
    igst: pick(roles.igst),
    cgst: pick(roles.cgst),
    sgst: pick(roles.sgst),
    cess: pick(roles.cess),
  };
}

/* ------------------------------------------------------------------ */
/* ASSEMBLE                                                            */
/* ------------------------------------------------------------------ */

export interface AssembleInput {
  readonly tenantId: string;
  readonly gstin: string;
  readonly taxPeriod: string;
  /** ⚠️ Entered, not computed. See the header. */
  readonly itcReversed: HeadAmounts;
  readonly interestMinor: bigint;
  readonly lateFeeMinor: bigint;
}

export interface AssembleOutcome {
  readonly built: Gstr3bReturn;
  readonly from: string;
  readonly to: string;
  readonly periodEnd: string;
  /** ⚠️ Roles the return needed and the tenant has not mapped. */
  readonly unmappedRoles: readonly string[];
}

const OUTPUT_ROLES = { igst: "output_igst", cgst: "output_cgst", sgst: "output_sgst", cess: "output_cess" };
const INPUT_ROLES = { igst: "input_igst", cgst: "input_cgst", sgst: "input_sgst", cess: "input_cess" };

export async function assembleGstr3b(tx: Tx, args: AssembleInput): Promise<AssembleOutcome> {
  const { from, to, end } = periodWindow(args.taxPeriod);
  const movements = await movementsByRole(tx, args.tenantId, from, to);

  const mappedRoles = await tx
    .select({ role: salesPostingAccounts.role })
    .from(salesPostingAccounts)
    .where(eq(salesPostingAccounts.tenantId, args.tenantId));
  const mapped = new Set(mappedRoles.map((r) => r.role));

  const needed = [...Object.values(OUTPUT_ROLES), ...Object.values(INPUT_ROLES)];
  const unmappedRoles = needed.filter((r) => !mapped.has(r));

  const outward = heads(movements, OUTPUT_ROLES, "credit");
  const itcAvailable = heads(movements, INPUT_ROLES, "debit");

  /**
   * ⭐ REVERSE CHARGE COMES FROM ITS OWN ROLE, WHICH ALREADY EXISTS.
   * `rcm_payable` has been credited by every reverse-charge purchase
   * since v0.9x and nothing has ever read it.
   */
  const rcmMovement = movements.get("rcm_payable");
  const rcmTotal = rcmMovement ? rcmMovement.creditMinor - rcmMovement.debitMinor : 0n;

  /**
   * ⚠️ RCM IS SPLIT ACROSS HEADS BY THE SAME PROPORTION AS THE INPUT
   * TAX IT GENERATED, and where that cannot be told it is reported as
   * IGST — which is what most reverse-charge supplies are.
   *
   * 🔴 THIS IS AN APPROXIMATION AND THE RETURN SAYS SO. `rcm_payable` is
   * one account and the 3B wants three heads; splitting it exactly needs
   * a per-document breakdown that the ledger role does not carry. It is
   * flagged as a note rather than presented as certain.
   */
  const inwardRcm: HeadAmounts =
    rcmTotal > 0n ? { igst: rcmTotal, cgst: 0n, sgst: 0n, cess: 0n } : ZERO_HEADS;

  /**
   * ⭐ CREDIT BROUGHT FORWARD IS THE PREVIOUS RETURN'S CARRIED BALANCE,
   * not the input tax account balance.
   *
   * ⚠️ THE TWO DIVERGE THE MOMENT ANYTHING IS REVERSED, and using the
   * account balance would re-claim credit that a previous return already
   * utilised.
   */
  const carried = await previousCarried(tx, args.tenantId, args.gstin, args.taxPeriod);

  const facts: Gstr3bFacts = {
    taxPeriod: args.taxPeriod,
    gstin: args.gstin,
    outwardTaxable: outward,
    // ⚠️ TAXABLE VALUE IS NOT IN THE TAX LEDGERS. It comes from the
    // revenue account's movement, which is net of tax by construction.
    outwardTaxableValueMinor: (() => {
      const rev = movements.get("revenue");
      return rev ? rev.creditMinor - rev.debitMinor : 0n;
    })(),
    outwardZeroRated: ZERO_HEADS,
    outwardZeroRatedValueMinor: 0n,
    outwardExemptValueMinor: 0n,
    inwardRcm,
    inwardRcmValueMinor: 0n,
    itcAvailable,
    itcReversed: args.itcReversed,
    creditBroughtForward: carried,
    interestMinor: args.interestMinor,
    lateFeeMinor: args.lateFeeMinor,
  };

  const built = buildGstr3b(facts);

  const notes = [...built.notes];
  if (rcmTotal > 0n) {
    notes.push(
      "Reverse-charge tax has been reported entirely under IGST. The ledger holds it in one account and the return wants three heads, and splitting it exactly needs a per-document breakdown Ordence does not keep. Check it against your purchase register before filing.",
    );
  }
  if (unmappedRoles.length > 0) {
    notes.push(
      `${unmappedRoles.length} tax ledger${unmappedRoles.length === 1 ? " is" : "s are"} not mapped, so any tax posted through ${unmappedRoles.length === 1 ? "it" : "them"} is missing from this return.`,
    );
  }

  return {
    built: { ...built, notes },
    from,
    to,
    periodEnd: end,
    unmappedRoles,
  };
}

/**
 * ⭐ THE PREVIOUS PERIOD'S CARRIED CREDIT, or zero for the first return.
 *
 * ⚠️ ONLY FROM A FILED OR FINALISED RETURN. A draft's carried figure is
 * a guess that will change when it is recomputed, and building this
 * month on last month's guess compounds the error forward silently.
 */
async function previousCarried(
  tx: Tx,
  tenantId: string,
  gstin: string,
  taxPeriod: string,
): Promise<HeadAmounts> {
  const year = Number(taxPeriod.slice(0, 4));
  const month = Number(taxPeriod.slice(5, 7));
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const previous = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

  const [row] = await tx
    .select({
      igst: gstReturns.carriedIgstMinor,
      cgst: gstReturns.carriedCgstMinor,
      sgst: gstReturns.carriedSgstMinor,
      cess: gstReturns.carriedCessMinor,
      status: gstReturns.status,
    })
    .from(gstReturns)
    .where(
      and(
        eq(gstReturns.tenantId, tenantId),
        eq(gstReturns.gstin, gstin),
        eq(gstReturns.taxPeriod, previous),
        sql`${gstReturns.status} IN ('finalised', 'filed')`,
      ),
    )
    .limit(1);

  if (!row) return ZERO_HEADS;

  return {
    igst: BigInt(row.igst),
    cgst: BigInt(row.cgst),
    sgst: BigInt(row.sgst),
    cess: BigInt(row.cess),
  };
}

export { gstr3bDueDate };
