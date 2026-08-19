/**
 * Ordence — Accounting Validation Schemas
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM `server/actions/accounting.ts`
 * ══════════════════════════════════════════════════════════════════════
 * A file marked `"use server"` may ONLY export async functions. Every other
 * export in such a file is compiled into a callable RPC endpoint reachable
 * by anyone on the internet. Exporting a Zod schema from a server-action
 * file therefore does two bad things at once: it fails the production build,
 * and — if the build somehow let it through — it publishes an endpoint we
 * never intended to expose.
 *
 * Schemas are pure, isomorphic values. They belong here, where BOTH the
 * server action and the client form can import them and validate against
 * exactly the same rules.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY MONEY IS A STRING HERE AND A BIGINT IN ARITHMETIC
 * ══════════════════════════════════════════════════════════════════════
 * `0.1 + 0.2 !== 0.3` in IEEE-754 floating point. A cent lost per
 * transaction is a general ledger that never reconciles. So amounts cross
 * the wire as decimal STRINGS (no precision to lose), and every sum is done
 * in BigInt minor units (paise). A float never touches money in this system.
 */

import { z } from "zod";
import { parseMajorToMinor, formatMinorPlain } from "@/lib/fx/currency";

/* ------------------------------------------------------------------ */
/* EXACT MONEY ARITHMETIC                                              */
/* ------------------------------------------------------------------ */

/**
 * Convert a decimal string to integer minor units (paise).
 * Throws on anything that is not a clean 2-decimal positive amount.
 */
export function toMinorUnits(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`Invalid amount "${amount}". Use a positive value like "1500.00".`);
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.padEnd(2, "0").slice(0, 2);
  return BigInt(whole) * 100n + BigInt(paddedFraction);
}

/** Convert integer minor units back to a 2-decimal string. */
export function fromMinorUnits(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

const uuidSchema = z.string().uuid("Invalid identifier.");

/**
 * ⭐ UP TO FOUR DECIMALS AT THE SHAPE LEVEL, AND THE CURRENCY DECIDES THE
 *    REAL LIMIT. Batch 0108.
 *
 * 🔴 THIS REGEX USED TO BE `\d{1,2}` DECIMALS AND THAT MADE A DINAR
 *    MANUAL JOURNAL UNENTERABLE. A Kuwaiti user typing 1.234 — a perfectly
 *    ordinary amount, 1234 fils — was told "Enter a positive amount with
 *    at most 2 decimals", which is not true of their currency and which no
 *    amount of retyping would satisfy.
 *
 * ⚠️ THE LEG DOES NOT KNOW ITS CURRENCY; the transaction does. So this
 *    check only rules out shapes that are wrong for EVERY currency (ISO
 *    4217 defines no exponent above 4), and `postTransactionSchema`'s
 *    superRefine below applies the real, per-currency limit through
 *    `parseMajorToMinor`, which names the currency and its decimal count
 *    in the refusal. A two-stage check, with the precise one where the
 *    information actually is.
 */
const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "Enter a positive amount with at most 4 decimals.")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero.");

export const journalLegSchema = z.object({
  ledgerId: uuidSchema,
  entryType: z.enum(["debit", "credit"]),
  amount: amountSchema,
  description: z.string().trim().max(1_000).optional(),
  counterpartyType: z.string().trim().max(40).optional(),
  counterpartyId: uuidSchema.optional(),
  counterpartyName: z.string().trim().max(300).optional(),
});

export const REFERENCE_TYPES = [
  "contract",
  "deal",
  "asset",
  "invoice",
  "payment",
  "receipt",
  "journal",
  "adjustment",
  "opening_balance",
] as const;

/* ------------------------------------------------------------------ */
/* TRANSACTION POSTING                                                 */
/* ------------------------------------------------------------------ */

export const postTransactionSchema = z
  .object({
    description: z.string().trim().min(1, "A description is required.").max(1_000),
    transactionDate: z.string().date("Enter a valid date."),
    transactionNumber: z.string().trim().max(60).optional(),
    referenceType: z.enum(REFERENCE_TYPES).default("journal"),
    referenceId: uuidSchema.optional().nullable(),
    currency: z.string().length(3).default("INR"),
    /** At least two legs — one entry alone can never balance. */
    legs: z.array(journalLegSchema).min(2, "A transaction needs at least two entries.").max(100),
  })
  .superRefine((val, ctx) => {
    // ════════════════════════════════════════════════════════════════
    // THE BALANCE RULE, ENFORCED IN EXACT INTEGER ARITHMETIC.
    //
    // This is the SECOND of three independent gates. The client form
    // disables its submit button (fast feedback), this schema rejects
    // the payload (server-side truth), and a DEFERRED constraint trigger
    // in PostgreSQL refuses the COMMIT (the gate that actually cannot
    // be bypassed). Any one of them could be removed by a future commit;
    // all three would have to be removed to corrupt the ledger.
    // ════════════════════════════════════════════════════════════════
    //
    // ⭐ AND IT IS DONE IN THE TRANSACTION'S OWN CURRENCY. Batch 0108.
    // `parseMajorToMinor` reads the exponent per currency, so "1.234" is
    // 1234 fils in KWD and is REFUSED, by name, in INR. `toMinorUnits`
    // multiplied everything by a hardcoded hundred and rejected a third
    // decimal outright.
    let debits = 0n;
    let credits = 0n;
    for (const leg of val.legs) {
      let minor: bigint;
      try {
        minor = parseMajorToMinor(leg.amount, val.currency);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["legs"],
          message: err instanceof Error ? err.message : `"${leg.amount}" is not a valid amount.`,
        });
        return;
      }
      if (minor <= 0n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["legs"],
          message: "Amount must be greater than zero.",
        });
        return;
      }
      if (leg.entryType === "debit") debits += minor;
      else credits += minor;
    }

    if (debits !== credits) {
      const difference = formatMinorPlain(
        debits > credits ? debits - credits : credits - debits,
        val.currency,
      );
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["legs"],
        message:
          `Entries do not balance. Debits ${fromMinorUnits(debits)} ` +
          `vs credits ${fromMinorUnits(credits)} — a difference of ${difference}.`,
      });
    }

    if (debits === 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["legs"],
        message: "A transaction must move a non-zero amount.",
      });
    }
  });

export type PostTransactionInput = z.input<typeof postTransactionSchema>;
