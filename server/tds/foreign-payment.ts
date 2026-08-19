import "server-only";

/**
 * Ordence — ⭐⭐ RULE 26, WHERE THE RULE MEETS THE RATE TABLES
 * Batch 0106
 *
 * The I/O half of `lib/tds/foreign-payments.ts`, and the same split as
 * `lib/fx/convert.ts` / `server/fx/rate-service.ts`: the rule is testable
 * without a database, this file finds the rate and decides nothing.
 *
 * ⚠️ IT IS THE ONLY PATH FROM A FOREIGN-CURRENCY PAYMENT TO A RUPEE
 * CHARGEABLE BASE. `convertMinor` would happily translate the same amount
 * at whatever quote it was handed — a mid rate off a feed, yesterday's
 * rate, an inverted one — and produce a number that foots. Everything
 * that makes this figure defensible is in the two functions it calls.
 */

import { withTenant } from "@/db";
import { requireStatutoryQuote } from "@/server/fx/rate-service";
import { RULE_26_TT_BUYING } from "@/lib/fx/statutory";
import {
  TDS_FUNCTIONAL_CURRENCY,
  deductionDateFor,
  foreignPaymentBase,
  type DeductionDateVerdict,
  type ForeignPaymentBase,
} from "@/lib/tds/foreign-payments";
import { normaliseCurrencyCode } from "@/lib/fx/currency";
import { identityQuote } from "@/lib/fx/rates";

export type ForeignPaymentMeasurement = {
  readonly date: DeductionDateVerdict;
  readonly base: ForeignPaymentBase;
};

/**
 * ⭐⭐⭐ MEASURE A FOREIGN-CURRENCY PAYMENT FOR TDS, OR REFUSE AND SAY
 * WHICH RATE IS MISSING FOR WHICH DAY.
 *
 * ⚠️ THE ORDER IS LOAD-BEARING AND IS THE OPPOSITE OF THE OBVIOUS ONE.
 * The deduction date is established FIRST, from the credit and payment
 * dates, and only then is a rate looked up — for that date and no other.
 * Looking the rate up first would mean choosing a date to look it up on,
 * and the date nearest to hand on a payment screen is the payment date,
 * which is the wrong one whenever the credit came first.
 *
 * ⚠️ A RUPEE PAYMENT STILL COMES THROUGH HERE. It resolves to the
 * identity quote — exactly 1, from no table — so a caller does not have
 * to branch, and the branch that would otherwise exist is where a
 * foreign payment eventually gets treated as a rupee one.
 */
export async function measureForeignPayment(
  tenantId: string,
  args: {
    /** The amount as paid, in that currency's own minor units. */
    foreignAmountMinor: bigint;
    foreignCurrency: string;
    /** When the sum was credited to the payee's account in our books. */
    creditDate: string | null;
    /** When the money left the bank. */
    paymentDate: string | null;
  },
): Promise<ForeignPaymentMeasurement> {
  const foreignCurrency = normaliseCurrencyCode(args.foreignCurrency);

  // ① The date the statute names, from the two events — never from a clock
  //    and never from an invoice.
  const date = deductionDateFor({
    creditDate: args.creditDate,
    paymentDate: args.paymentDate,
  });

  // ② The rate the statute names, for that date, or a refusal.
  const quote =
    foreignCurrency === TDS_FUNCTIONAL_CURRENCY
      ? identityQuote(TDS_FUNCTIONAL_CURRENCY, date.deductionDate, RULE_26_TT_BUYING.rateType)
      : await withTenant(tenantId, async (tx) =>
          requireStatutoryQuote(tx, {
            tenantId,
            from: foreignCurrency,
            to: TDS_FUNCTIONAL_CURRENCY,
            on: date.deductionDate,
            conversion: RULE_26_TT_BUYING,
          }),
        );

  // ③ The arithmetic, which is the only part that cannot go wrong quietly.
  const base = foreignPaymentBase({
    foreignAmountMinor: args.foreignAmountMinor,
    foreignCurrency,
    deductionDate: date.deductionDate,
    quote,
  });

  return { date, base };
}
