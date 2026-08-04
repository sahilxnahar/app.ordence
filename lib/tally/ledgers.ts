/**
 * Ordence — ⭐ Ledger Master Mapping
 * Version: v0.37.0-alpha
 *
 * Pure and isomorphic. No database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE RULE: A LEDGER NAME IS LOOKED UP, NEVER DERIVED
 * ══════════════════════════════════════════════════════════════════════
 * Tally identifies a ledger by its NAME — free text, typed by whoever set
 * the company up ten years ago. And when Tally does not find the name in
 * a voucher, it does NOT fail. It CREATES the ledger.
 *
 *     Our account is "Sales — Residential Units". The firm's ledger is
 *     "Sales A/c". We export our name. Tally creates a second sales
 *     ledger, posts April to it, and reports a successful import.
 *
 *     The P&L now has two sales lines. Every saved report, every
 *     comparative and every drill-down in ten years of history points at
 *     the first one. The accountant finds it while preparing the audit
 *     file, in October.
 *
 * ⚠️ AND THE EM DASH MAKES IT WORSE. The same account exported through a
 * different encoding path can arrive as "Sales - Residential Units",
 * creating a THIRD ledger that looks identical in a printed report.
 *
 * ⭐ SO AN UNMAPPED ACCOUNT THROWS. `UnmappedLedgerError` names the
 * account and the export does not generate. A file that will not generate
 * is a ten-minute conversation with the accountant; a file that generates
 * and forks the chart of accounts is a year-end.
 *
 * ⚠️ AND MATCHING IS CASE-INSENSITIVE, BECAUSE TALLY'S IS. "Sales A/c"
 * and "SALES A/C" are one ledger to Tally and would be two mappings here
 * without the fold — after which each of our two accounts would post to
 * "its own" ledger and both would land in the same one, silently merged.
 */

import type { TallyLedgerGroup, TallyMappingSource } from "@/db/schema/tally";
import { compact, leaf, type TallyXmlNode } from "./xml";

/* ------------------------------------------------------------------ */
/* ⭐ TALLY'S PRIMARY GROUP NAMES                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE EXACT STRINGS TALLY SHIPS WITH, SPELLED TALLY'S WAY.
 *
 * ⚠️ THESE ARE NOT LABELS AND THEY ARE NOT TRANSLATABLE. "Duties &
 * Taxes" — with the ampersand, the space either side, and that exact
 * capitalisation — is the name of a group in every Tally company ever
 * created. "Duties and Taxes" is a NEW group, which Tally will create,
 * under Primary, where none of its GST reports will look for it.
 *
 * ⭐ THE AMPERSAND IS ALSO WHY `lib/tally/xml.ts` EXISTS. The very first
 * value this integration sends contains a character that breaks XML, and
 * it comes from Tally itself.
 */
export const TALLY_PRIMARY_GROUPS: Readonly<Record<TallyLedgerGroup, string>> =
  Object.freeze({
    sundry_debtors: "Sundry Debtors",
    sundry_creditors: "Sundry Creditors",
    sales_accounts: "Sales Accounts",
    purchase_accounts: "Purchase Accounts",
    duties_and_taxes: "Duties & Taxes",
    bank_accounts: "Bank Accounts",
    bank_od_account: "Bank OD A/c",
    cash_in_hand: "Cash-in-Hand",
    direct_expenses: "Direct Expenses",
    indirect_expenses: "Indirect Expenses",
    direct_incomes: "Direct Incomes",
    indirect_incomes: "Indirect Incomes",
    current_assets: "Current Assets",
    current_liabilities: "Current Liabilities",
    fixed_assets: "Fixed Assets",
    investments: "Investments",
    loans_and_advances_asset: "Loans & Advances (Asset)",
    secured_loans: "Secured Loans",
    unsecured_loans: "Unsecured Loans",
    capital_account: "Capital Account",
    reserves_and_surplus: "Reserves & Surplus",
    provisions: "Provisions",
    suspense_account: "Suspense A/c",
  });

/**
 * ⭐ THE GROUPS TALLY'S GST REPORTS ACTUALLY READ.
 *
 * ⚠️ A tax ledger mapped anywhere but `Duties & Taxes` produces a company
 * whose GSTR-1 in Tally has no output tax on it — while the balance sheet
 * balances perfectly, because the money is in the right total under the
 * wrong heading. `assessMapping` warns on it.
 */
const TAX_GROUPS: ReadonlySet<TallyLedgerGroup> = new Set([
  "duties_and_taxes",
] as const);

/**
 * ⭐ THE PERMITTED TAX HEADS. A closed set, not free text.
 *
 * ⚠️ IF THIS WERE FREE TEXT IT WOULD BE A SECOND CHART OF ACCOUNTS, kept
 * by nobody, and a voucher builder asking for `output_cgst` against a
 * workspace that spelled it `cgst_output` would fall through to
 * "unmapped" at export time — which is a refusal, so it is safe, but it
 * is a refusal on the last day of the month with no way to see it coming.
 */
export const TALLY_TAX_HEADS = Object.freeze([
  "output_cgst",
  "output_sgst",
  "output_igst",
  "output_cess",
  "input_cgst",
  "input_sgst",
  "input_igst",
  "input_cess",
  /** ⭐ Reverse charge under Section 9(3)/9(4). A liability, not a credit. */
  "rcm_payable",
  /** TDS deducted from a vendor and not yet deposited. A liability. */
  "tds_payable",
  /** TDS deducted FROM us by a customer. An asset — it is our tax, prepaid. */
  "tds_receivable",
  /** ⚠️ Rule 46's rounding. Without a ledger for it, every invoice is out. */
  "round_off",
  /** Retention held back from a contractor's bill. A liability. */
  "retention_payable",
] as const);

export type TallyTaxHead = (typeof TALLY_TAX_HEADS)[number];

export function isTallyTaxHead(value: string): value is TallyTaxHead {
  return (TALLY_TAX_HEADS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* THE MAPPING                                                         */
/* ------------------------------------------------------------------ */

export type LedgerMapping = {
  sourceKind: TallyMappingSource;
  /** Set for every kind except `tax_head`. */
  sourceId?: string | null;
  /** Set only for `tax_head`. */
  sourceKey?: string | null;
  tallyLedgerName: string;
  tallyParentGroup: TallyLedgerGroup;
  isParty: boolean;
  partyGstin?: string | null;
  partyStateCode?: string | null;
  createMasterOnExport?: boolean;
};

/** What a voucher builder asks for. */
export type LedgerRef =
  | { kind: "ledger"; id: string; label?: string }
  | { kind: "vendor"; id: string; label?: string }
  | { kind: "customer"; id: string; label?: string }
  | { kind: "tax_head"; key: TallyTaxHead };

/**
 * ⭐ THE REFUSAL. Named, so `server/tally/exporter.ts` can turn it into a
 * sentence that says WHICH account and WHAT to do about it — which is the
 * entire difference between a useful error and "export failed".
 */
export class UnmappedLedgerError extends Error {
  readonly ref: LedgerRef;

  constructor(ref: LedgerRef) {
    const what =
      ref.kind === "tax_head"
        ? `the tax head "${ref.key}"`
        : `the ${ref.kind} ${ref.label ? `"${ref.label}" ` : ""}(${ref.id})`;
    super(
      `No Tally ledger is mapped for ${what}. ⚠️ The export will not be ` +
        `generated, and that is deliberate: sending our own account name instead ` +
        `would not fail — Tally would CREATE a ledger under a group it guessed ` +
        `and post to it, so the import would report success while the chart of ` +
        `accounts quietly forked. Map it on the Tally mappings screen first.`,
    );
    this.name = "UnmappedLedgerError";
    this.ref = ref;
  }
}

export type LedgerIndex = {
  byRow: ReadonlyMap<string, LedgerMapping>;
  byKey: ReadonlyMap<string, LedgerMapping>;
  /** ⚠️ Case-folded, because Tally matches names case-insensitively. */
  byName: ReadonlyMap<string, LedgerMapping>;
};

/**
 * Build the lookup once per export rather than scanning per voucher.
 *
 * ⚠️ A DUPLICATE NAME IS NOT SILENTLY COLLAPSED HERE. The database refuses
 * it (SQL 0026 §2, on `lower(name)`), so reaching this function with two
 * mappings on one name means the data was written by something other than
 * the application — a restore, a support fix at a psql prompt — and the
 * honest response is to keep the first and let `findDuplicateNames` report
 * it, rather than to pick one and carry on.
 */
export function buildLedgerIndex(mappings: readonly LedgerMapping[]): LedgerIndex {
  const byRow = new Map<string, LedgerMapping>();
  const byKey = new Map<string, LedgerMapping>();
  const byName = new Map<string, LedgerMapping>();

  for (const mapping of mappings) {
    if (mapping.sourceId) {
      byRow.set(`${mapping.sourceKind}:${mapping.sourceId}`, mapping);
    }
    if (mapping.sourceKey) {
      byKey.set(`${mapping.sourceKind}:${mapping.sourceKey}`, mapping);
    }
    const folded = foldLedgerName(mapping.tallyLedgerName);
    if (!byName.has(folded)) byName.set(folded, mapping);
  }

  return { byRow, byKey, byName };
}

/**
 * ⭐ THE FOLD TALLY APPLIES. Case-insensitive AND whitespace-collapsing:
 * "Sales  A/c" (two spaces, from a copy-paste) and "Sales A/c" are one
 * ledger to Tally, and two rows here without this.
 */
export function foldLedgerName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * ⭐ Resolve, or refuse. There is no third outcome and no fallback.
 */
export function resolveLedger(index: LedgerIndex, ref: LedgerRef): LedgerMapping {
  const found =
    ref.kind === "tax_head"
      ? index.byKey.get(`tax_head:${ref.key}`)
      : index.byRow.get(`${ref.kind}:${ref.id}`);
  if (!found) throw new UnmappedLedgerError(ref);
  return found;
}

/** Non-throwing variant, for the "what is still unmapped?" screen. */
export function tryResolveLedger(
  index: LedgerIndex,
  ref: LedgerRef,
): LedgerMapping | null {
  try {
    return resolveLedger(index, ref);
  } catch {
    return null;
  }
}

/** Names carried by more than one mapping. Should always be empty. */
export function findDuplicateNames(
  mappings: readonly LedgerMapping[],
): Array<{ folded: string; names: string[] }> {
  const seen = new Map<string, string[]>();
  for (const mapping of mappings) {
    const folded = foldLedgerName(mapping.tallyLedgerName);
    seen.set(folded, [...(seen.get(folded) ?? []), mapping.tallyLedgerName]);
  }
  return [...seen.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([folded, names]) => ({ folded, names }));
}

/* ------------------------------------------------------------------ */
/* MAPPING HEALTH                                                      */
/* ------------------------------------------------------------------ */

export type MappingFinding = {
  severity: "refuse" | "warn";
  code: string;
  message: string;
};

/**
 * ⭐ WHAT IS WRONG WITH A MAPPING BEFORE IT COSTS ANYTHING.
 *
 * Each of these is a real, silent failure mode of a mapping that is
 * syntactically perfect.
 */
export function assessMapping(mapping: LedgerMapping): MappingFinding[] {
  const findings: MappingFinding[] = [];
  const name = mapping.tallyLedgerName;

  if (name.trim().length === 0) {
    findings.push({
      severity: "refuse",
      code: "blank_name",
      message:
        "A Tally ledger name cannot be blank. Tally would create a ledger with " +
        "an empty name, which no report will ever show and no search will find.",
    });
  }

  if (name !== name.trim()) {
    findings.push({
      severity: "warn",
      code: "padded_name",
      message:
        `"${name}" has leading or trailing whitespace. Tally trims it on entry ` +
        `but not always on import, so this can create a second ledger that ` +
        `prints identically to the first.`,
    });
  }

  if (mapping.sourceKind === "tax_head" && !TAX_GROUPS.has(mapping.tallyParentGroup)) {
    findings.push({
      severity: "warn",
      code: "tax_head_wrong_group",
      message:
        `"${name}" carries tax but is filed under ` +
        `"${TALLY_PRIMARY_GROUPS[mapping.tallyParentGroup]}". ⚠️ Tally's own GST ` +
        `reports read "Duties & Taxes" and nothing else — filed elsewhere, the ` +
        `balance sheet still balances and the GSTR-1 in Tally shows no tax.`,
    });
  }

  if (mapping.isParty && mapping.tallyParentGroup !== "sundry_debtors" &&
      mapping.tallyParentGroup !== "sundry_creditors") {
    findings.push({
      severity: "warn",
      code: "party_not_under_sundry",
      message:
        `"${name}" is marked as a party ledger but is not under Sundry Debtors ` +
        `or Sundry Creditors. Bill-wise details and the receivables/payables ` +
        `ageing only work under those two groups — the balance will be right ` +
        `and the ageing, which is what anyone actually opens, will be empty.`,
    });
  }

  if (mapping.partyGstin && !mapping.isParty) {
    findings.push({
      severity: "refuse",
      code: "gstin_on_nominal",
      message:
        `"${name}" is not a party ledger and cannot carry a GSTIN. Tally reads ` +
        `the GSTIN from the PARTY ledger; on a nominal one it is inert, and its ` +
        `presence means a customer has been mapped to a nominal account.`,
    });
  }

  if (mapping.tallyParentGroup === "suspense_account") {
    findings.push({
      severity: "warn",
      code: "mapped_to_suspense",
      message:
        `"${name}" is mapped to Suspense A/c. That is where Tally puts what it ` +
        `cannot place — a deliberate mapping to it means a month of postings ` +
        `will sit somewhere nobody reconciles.`,
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* ⭐ LEDGER MASTER MESSAGES                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE `<LEDGER>` MASTER, EMITTED ONLY WHEN ASKED FOR.
 *
 * ⚠️ SENDING MASTERS BY DEFAULT IS DESTRUCTIVE AND LOOKS HELPFUL.
 * `ACTION="Alter"` on a ledger that already exists OVERWRITES the
 * accountant's settings — the parent group, the bill-wise flag, the
 * credit period, the opening balance behaviour. A firm with ten years of
 * books has all of those set on purpose, and an export that "helpfully"
 * ensures the masters exist resets them every month.
 *
 * So `createMasterOnExport` is per-mapping and off by default. It is for
 * the first-time setup of a brand-new company, which is the only time
 * this is the right thing to do.
 */
export function ledgerMasterNode(mapping: LedgerMapping): TallyXmlNode {
  return {
    tag: "LEDGER",
    attrs: {
      NAME: mapping.tallyLedgerName,
      /** ⚠️ RESERVEDNAME must be empty or Tally treats it as a system ledger. */
      RESERVEDNAME: "",
      /**
       * ⭐ `Alter` with `Create` semantics. Tally's importer creates when
       * absent and alters when present; `Create` alone FAILS on an
       * existing name, and a whole file fails with it.
       */
      ACTION: "Create",
    },
    children: compact([
      leaf("NAME", mapping.tallyLedgerName),
      leaf("PARENT", TALLY_PRIMARY_GROUPS[mapping.tallyParentGroup]),
      leaf("ISBILLWISEON", mapping.isParty ? "Yes" : "No"),
      // ⚠️ Only party ledgers get a GSTIN, and only registered ones.
      mapping.isParty && mapping.partyGstin
        ? leaf("PARTYGSTIN", mapping.partyGstin)
        : null,
      mapping.isParty && mapping.partyGstin
        ? leaf("GSTREGISTRATIONTYPE", "Regular")
        : mapping.isParty
          ? leaf("GSTREGISTRATIONTYPE", "Unregistered")
          : null,
      mapping.isParty && mapping.partyStateCode
        ? leaf("PLACEOFSUPPLY", mapping.partyStateCode)
        : null,
      // ⚠️ Tally needs to know a tax ledger IS a tax ledger, or its GST
      // reports will not aggregate it even inside Duties & Taxes.
      mapping.tallyParentGroup === "duties_and_taxes"
        ? leaf("TAXTYPE", "GST")
        : null,
    ]),
  };
}
