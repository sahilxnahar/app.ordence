/**
 * Ordence — Tally Validation Schemas
 * Version: v0.37.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SERVER ACTIONS
 * ══════════════════════════════════════════════════════════════════════
 * A file marked `"use server"` may ONLY export async functions. Every
 * other export in such a file is compiled into a callable RPC endpoint
 * reachable by anyone on the internet. Schemas are pure values, so they
 * live here and are imported by the action AND by the form — which is
 * also the only way to stop a form accepting input the action rejects.
 *
 * ⚠️ THE SHARED PRIMITIVES ARE IMPORTED, NOT RESTATED. `gstinSchema`,
 * `stateCodeSchema` and `civilDaySchema` come from `lib/validators/gst.ts`.
 * A second GSTIN rule that disagrees with the first by one character is
 * worse than no second rule.
 */

import { z } from "zod";
import { civilDaySchema, optionalGstin, stateCodeSchema } from "./gst";
import { TALLY_TAX_HEADS } from "@/lib/tally/ledgers";

const uuid = z.string().uuid("Not a valid identifier.");

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A TALLY LEDGER NAME. Free text, and the freedom is the hazard.
 *
 * ⚠️ TRIMMED, BECAUSE TALLY TRIMS ON ENTRY AND NOT ALWAYS ON IMPORT.
 * "Sales A/c " with a trailing space, pasted out of a spreadsheet,
 * becomes a SECOND ledger that prints identically to the first in every
 * report — and the two are only distinguishable by exporting them.
 *
 * ⚠️ AND IT IS NOT ALLOWED TO CONTAIN A NEWLINE. Tally accepts one and
 * shows it as a ledger whose name wraps, which nobody can search for.
 */
export const tallyLedgerNameSchema = z
  .string()
  .trim()
  .min(1, "A Tally ledger name cannot be blank.")
  .max(200, "Tally ledger names are at most 200 characters.")
  .refine((value) => !/[\r\n\t]/.test(value), {
    message:
      "A ledger name cannot contain a line break or a tab. Tally accepts it and " +
      "then shows a ledger nobody can search for.",
  });

/**
 * ⭐ THE COMPANY NAME, EXACTLY AS TYPED INTO TALLY.
 *
 * ⚠️ THIS IS THE FIELD THAT LOSES A MONTH. Every firm keeps last year's
 * company open beside this year's — "Ordence Pvt Ltd" and "Ordence
 * Heights Pvt Ltd (2023-24)" — and an import goes into whichever one the
 * envelope names, or into whichever is open if it names none. Neither
 * case fails.
 */
export const tallyCompanyNameSchema = z
  .string()
  .trim()
  .min(1, "The Tally company name is required.")
  .max(200)
  .refine((value) => !/[\r\n]/.test(value), {
    message: "A company name cannot contain a line break.",
  });

export const tallyVoucherTypeSchema = z.enum([
  "sales",
  "purchase",
  "receipt",
  "payment",
  "journal",
  "contra",
  "credit_note",
  "debit_note",
]);

export const tallyLedgerGroupSchema = z.enum([
  "sundry_debtors",
  "sundry_creditors",
  "sales_accounts",
  "purchase_accounts",
  "duties_and_taxes",
  "bank_accounts",
  "bank_od_account",
  "cash_in_hand",
  "direct_expenses",
  "indirect_expenses",
  "direct_incomes",
  "indirect_incomes",
  "current_assets",
  "current_liabilities",
  "fixed_assets",
  "investments",
  "loans_and_advances_asset",
  "secured_loans",
  "unsecured_loans",
  "capital_account",
  "reserves_and_surplus",
  "provisions",
  "suspense_account",
]);

export const tallyMappingSourceSchema = z.enum([
  "ledger",
  "vendor",
  "customer",
  "tax_head",
]);

/**
 * ⭐ A CLOSED SET, NOT FREE TEXT. See `lib/tally/ledgers.ts` — a
 * free-text tax head would be a second chart of accounts kept by nobody,
 * and a builder asking for `output_cgst` against a workspace that spelled
 * it `cgst_output` would fail on the last day of the month.
 */
export const tallyTaxHeadSchema = z.enum(
  TALLY_TAX_HEADS as unknown as [string, ...string[]],
);

/* ------------------------------------------------------------------ */
/* CONNECTIONS                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A HOST IS A HOSTNAME OR AN IP, AND NOT A URL. Somebody will paste
 * `http://192.168.1.20:9000/` in, and accepting it would produce a
 * connection whose stored host is a URL — which `lib/tally/endpoint.ts`
 * would then wrap in another scheme and refuse for a reason nobody can
 * read.
 */
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/^[a-z]+:\/\//i.test(value), {
    message:
      "Enter just the address — 192.168.1.20 or tally-pc — without http:// and " +
      "without the port. The port is the field below.",
  })
  .refine((value) => !value.includes("/"), {
    message: "A host has no path. Enter just the address.",
  });

export const upsertTallyConnectionSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, "Give this connection a name.").max(120),
  companyName: tallyCompanyNameSchema,
  host: hostSchema.optional().nullable(),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(9000),
  useTls: z.boolean().default(false),
  /**
   * ⭐⭐ THE DELIBERATE EXCEPTION. Off by default, and the description on
   * the form says why. See `lib/tally/endpoint.ts`.
   */
  allowPrivateHost: z.boolean().default(false),
  isActive: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional().nullable(),
})
  .refine((data) => !data.allowPrivateHost || Boolean(data.host), {
    path: ["host"],
    message:
      "Reaching a private address needs an address to reach. A permission with " +
      "no host named is a permission nobody can review.",
  });

/* ------------------------------------------------------------------ */
/* ⭐ MAPPINGS                                                          */
/* ------------------------------------------------------------------ */

export const upsertTallyLedgerMappingSchema = z
  .object({
    id: uuid.optional(),
    sourceKind: tallyMappingSourceSchema,
    /** Set for every kind except `tax_head`. */
    sourceId: uuid.optional().nullable(),
    /** Set only for `tax_head`. */
    sourceKey: tallyTaxHeadSchema.optional().nullable(),
    tallyLedgerName: tallyLedgerNameSchema,
    tallyParentGroup: tallyLedgerGroupSchema,
    isParty: z.boolean().default(false),
    partyGstin: optionalGstin,
    partyStateCode: stateCodeSchema.optional().nullable(),
    createMasterOnExport: z.boolean().default(false),
    isActive: z.boolean().default(true),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  /**
   * ⭐ EXACTLY ONE IDENTITY. The database says the same thing
   * (`tally_ledger_mappings_identity_is_singular`); this says it in a
   * sentence somebody can act on before the insert is attempted.
   */
  .refine(
    (data) =>
      data.sourceKind === "tax_head"
        ? Boolean(data.sourceKey) && !data.sourceId
        : Boolean(data.sourceId) && !data.sourceKey,
    {
      path: ["sourceId"],
      message:
        "A tax head is identified by its key and everything else by its row. A " +
        "mapping with both has two identities, and the lookup would find it " +
        "under one and miss it under the other.",
    },
  )
  .refine((data) => !data.partyGstin || data.isParty, {
    path: ["partyGstin"],
    message:
      "Only a party ledger carries a GSTIN. Tally reads it from the PARTY " +
      "ledger; on a nominal one it is inert and its presence means a customer " +
      "has been mapped to a nominal account.",
  });

export const upsertTallyCostCentreMappingSchema = z.object({
  id: uuid.optional(),
  projectId: uuid,
  tallyCostCentreName: tallyLedgerNameSchema,
  tallyCostCategory: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .default("Primary Cost Category"),
  isActive: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const deleteTallyMappingSchema = z.object({ id: uuid });

/* ------------------------------------------------------------------ */
/* ⭐ EXPORT                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE PERIOD IS INCLUSIVE BOTH ENDS AND IS BOUNDED.
 *
 * A period of "everything" is what somebody asks for the first time, and
 * it produces a file of ten years that will not import, cannot be
 * reviewed, and — if it half-imports — is unrecoverable. A financial year
 * is the largest span anybody has a reason to send in one go.
 */
export const generateTallyExportSchema = z
  .object({
    connectionId: uuid.optional().nullable(),
    companyName: tallyCompanyNameSchema,
    periodStart: civilDaySchema,
    periodEnd: civilDaySchema,
    voucherTypes: z
      .array(tallyVoucherTypeSchema)
      .min(1, "Choose at least one voucher type.")
      .default(["sales", "purchase", "receipt", "payment", "journal"]),
    /** Emit the ledger masters too. Off by default — see `ledgerMasterNode`. */
    includeMasters: z.boolean().default(false),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((data) => data.periodEnd >= data.periodStart, {
    path: ["periodEnd"],
    message: "The period ends before it starts.",
  })
  .refine((data) => spanInDays(data.periodStart, data.periodEnd) <= 400, {
    path: ["periodEnd"],
    message:
      "Export at most a financial year at a time. ⚠️ A ten-year file cannot be " +
      "reviewed before it is imported, and a partial import of one is not " +
      "recoverable — Tally has no undo for an import.",
  });

/**
 * ⭐ MARKING A BATCH DELIVERED. The action that flips the next export of
 * the same rows from CREATE to ALTER.
 *
 * ⚠️ IT IS A SEPARATE ACT FROM GENERATING, and that is the point. A file
 * that was generated and never imported must not make the next export an
 * ALTER of vouchers Tally does not have — Tally would report them
 * "ignored" and the period would silently never arrive.
 */
export const markTallyExportDeliveredSchema = z.object({
  batchId: uuid,
  /** What the accountant saw. Optional, because they often just say "done". */
  responsePayload: z.string().max(100_000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

/**
 * ⭐ THE DIRECT PUSH. See `server/tally/push.ts` and
 * `lib/tally/endpoint.ts` for why this is the constrained path.
 */
export const pushTallyExportSchema = z.object({
  batchId: uuid,
  connectionId: uuid,
});

/* ------------------------------------------------------------------ */
/* ⭐ IMPORT AND RECONCILIATION                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A SIZE LIMIT, AND IT IS NOT ARBITRARY. A day book for a busy month
 * is a few megabytes. Ten megabytes is a year. A hundred is somebody's
 * whole history, and parsing it inside a request is how the request times
 * out after having done all the work.
 */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export const importTallyExportSchema = z
  .object({
    connectionId: uuid.optional().nullable(),
    sourceLabel: z.string().trim().min(1, "Name the file.").max(255),
    periodStart: civilDaySchema,
    periodEnd: civilDaySchema,
    /** The raw XML, verbatim. Kept as evidence — see the schema comment. */
    payload: z
      .string()
      .min(1, "The file is empty.")
      .max(
        MAX_IMPORT_BYTES,
        "That file is larger than 20 MB. A day book for one period is a few " +
          "megabytes; a file this size is a whole history, and reconciling ten " +
          "years against one month reports everything as a difference.",
      ),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((data) => data.periodEnd >= data.periodStart, {
    path: ["periodEnd"],
    message: "The period ends before it starts.",
  });

export const resolveReconciliationItemSchema = z.object({
  itemId: uuid,
  status: z.enum(["open", "explained", "resolved"]),
  resolutionNote: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable(),
})
  /**
   * ⚠️ CLOSING A DIFFERENCE WITHOUT SAYING WHY IS HOW A RECONCILIATION
   * BECOMES A BUTTON. The note is the only thing that distinguishes "we
   * checked, it is the year-end depreciation journal" from "it was in the
   * way".
   */
  .refine((data) => data.status === "open" || Boolean(data.resolutionNote), {
    path: ["resolutionNote"],
    message:
      "Say why. A difference closed with no reason recorded is indistinguishable " +
      "from one nobody looked at, and the next person to open this report cannot " +
      "tell which it was.",
  });

export const tallyBatchQuerySchema = z.object({
  status: z
    .enum(["draft", "generated", "delivered", "failed", "superseded"])
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function spanInDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type UpsertTallyConnectionInput = z.infer<typeof upsertTallyConnectionSchema>;
export type UpsertTallyLedgerMappingInput = z.infer<
  typeof upsertTallyLedgerMappingSchema
>;
export type UpsertTallyCostCentreMappingInput = z.infer<
  typeof upsertTallyCostCentreMappingSchema
>;
export type GenerateTallyExportInput = z.infer<typeof generateTallyExportSchema>;
export type ImportTallyExportInput = z.infer<typeof importTallyExportSchema>;
