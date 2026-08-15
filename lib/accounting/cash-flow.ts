/**
 * Ordence — ⭐⭐⭐ THE CASH FLOW STATEMENT, INDIRECT METHOD
 * Version: v1.44.0-alpha (Batch 65)
 *
 * Pure. No database, no clock, no ledger lookups. Money is `bigint`
 * paise throughout and never passes through a `Number`. The server
 * action in `server/actions/accounting.ts` loads the rows; every rupee
 * of judgement is decided here, where it can be exercised without
 * standing up Postgres.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE THIRD STATEMENT IS NOT OPTIONAL
 * ══════════════════════════════════════════════════════════════════════
 * A profitable business runs out of money. That sentence is the entire
 * reason this file exists. The P&L says a company earned ₹40 lakh; the
 * balance sheet says it owns ₹40 lakh of receivables; and the bank says
 * there is ₹11,000 in the account and payroll is on Friday. Two of those
 * three facts were already in the product. The one that would have said
 * so a quarter earlier was not.
 *
 * Every lender pack, every audited set of accounts under Schedule III of
 * the Companies Act, and every serious internal review wants three
 * statements. Ordence had two.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE INDIRECT METHOD, AND WHY IT IS AN IDENTITY HERE
 * ══════════════════════════════════════════════════════════════════════
 * The textbook recipe is: start from profit, add back non-cash charges,
 * adjust for movements in working capital, and you arrive at cash.
 *
 * In a double-entry ledger that recipe is not a heuristic — it is
 * arithmetic, and it follows from the one rule the database already
 * enforces with a deferred trigger. Write `m(L)` for a ledger's
 * DEBIT-POSITIVE movement over the period, `debits − credits`. Because
 * every transaction balances, and the statement is built from whole
 * transactions:
 *
 *        Σ m(L) over EVERY ledger  =  0
 *
 * Split that sum three ways — cash ledgers, other balance-sheet ledgers,
 * and profit-and-loss ledgers:
 *
 *        Σ_cash m  +  Σ_otherBS m  +  Σ_P&L m  =  0
 *
 * The period's profit, in the sign a reader expects (positive is a
 * profit), is credits less debits across the P&L accounts, i.e.
 * `netResult = −Σ_P&L m`. Substituting and rearranging:
 *
 *   🔴  Δcash  =  netResult  −  Σ_otherBS m
 *
 * That is the whole statement. Each non-cash balance-sheet ledger
 * contributes `−m(L)` — its CASH EFFECT — and the signs come out right
 * on their own:
 *
 *   • Receivables rise: a debit, `m > 0`, cash effect NEGATIVE. Money
 *     earned and not collected. Correct.
 *   • Payables rise: a credit, `m < 0`, cash effect POSITIVE. Costs
 *     incurred and not yet paid. Correct.
 *   • Share capital issued: a credit, cash effect POSITIVE. Correct.
 *   • A machine bought: a debit to fixed assets, cash effect NEGATIVE.
 *     Correct.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THIS IS WHY NOTHING IN THIS FILE LOOKS FOR "DEPRECIATION"
 * ══════════════════════════════════════════════════════════════════════
 * The obvious way to write step two — "add back non-cash charges" — is
 * to find the depreciation ledger and add its balance back. Do not.
 * There are two reasons and each one alone is fatal.
 *
 * ① IT WOULD BE A NAME MATCH, and this codebase has already decided
 *   that question. `db/schema/accounting.ts` says it outright about the
 *   posting-role table: "A LEDGER CANNOT BE GUESSED FROM ITS NAME OR ITS
 *   CODE. Every tenant builds their own chart of accounts." A tenant
 *   whose depreciation account is called "Wear & tear" or "5410" gets a
 *   cash flow statement that silently omits the add-back.
 *
 * ② IT WOULD DOUBLE COUNT. Depreciation is `Dr Depreciation expense,
 *   Cr Accumulated depreciation`. The debit already lowers `netResult`.
 *   The credit is a movement on a non-cash balance-sheet ledger, so it
 *   already appears in `Σ_otherBS m` with the opposite sign and cancels
 *   the expense exactly. The add-back is ALREADY THERE. Adding it a
 *   second time overstates cash from operations by the full charge.
 *
 * The same argument covers every non-cash charge there is — provisions,
 * bad-debt write-offs, unrealised revaluations, stock write-downs,
 * amortisation. Any entry whose other leg is a balance-sheet account
 * nets to zero here without being named, and any entry whose other leg
 * is cash is a real cash movement and should not be added back at all.
 *
 * ⚠️ THE PRICE OF THAT CORRECTNESS, STATED HONESTLY: the statement shows
 * the NET movement on each balance-sheet ledger, so a year in which
 * ₹10 lakh of plant was bought and ₹3 lakh depreciated shows one line of
 * −₹7 lakh rather than two lines of −₹10 lakh and +₹3 lakh. The total is
 * right and the narrative is coarser. Splitting them needs the ledger to
 * record which entries are non-cash, which is a schema change and not a
 * guess. See the note on categories below.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THERE IS NO OPERATING / INVESTING / FINANCING SPLIT, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * A textbook cash flow statement has three headings. This one does not,
 * and that is a decision rather than an omission.
 *
 * Sorting ledgers into operating, investing and financing needs to know
 * which assets are current and which are not, and which liabilities are
 * borrowings and which are trade. `ledgers.account_type` carries five
 * values — asset, liability, equity, revenue, expense — and none of them
 * says. `ledgers.type` carries operating/trust/escrow/retention/suspense,
 * which is about whose money it is, not where it sits on a cash flow.
 * Nothing else in the chart of accounts encodes it.
 *
 * So the three headings could only come from matching ledger names, and
 * a name match here is worse than no split at all: "Loan to director"
 * and "Loan from bank" differ by one word and land in different
 * sections with opposite signs. A statement with three confidently
 * wrong sections is filed from. A statement with two honest ones and a
 * note is queried.
 *
 * ⭐ WHAT WOULD FIX IT PROPERLY: a `cash_flow_category` column on
 * `ledgers`, defaulted per account type and editable per ledger, exactly
 * as `sales_posting_accounts` maps roles to ledgers rather than
 * inferring them. Until that column exists, this file groups by the
 * classification the schema actually has.
 */

/* ------------------------------------------------------------------ */
/* WHAT THE CALLER SUPPLIES                                            */
/* ------------------------------------------------------------------ */

/**
 * One ledger's movement over the statement period.
 *
 * 🔴 `movementMinor` IS DEBIT-POSITIVE, exactly like `TrialBalanceRow.balance`
 * — `debits − credits`. It is NOT flipped for presentation. The single
 * flip for liabilities, equity and revenue happens once, in the UI, and
 * a second flip in here would produce a statement that reconciles to
 * minus the right answer.
 */
export type LedgerMovement = {
  ledgerId: string;
  code: string;
  name: string;
  /** `ledgers.type` — operating, trust, escrow, retention, suspense. */
  type: string;
  /** `ledgers.account_type` — asset, liability, equity, revenue, expense. */
  accountType: string;
  /** Debit-positive movement in paise over the period. */
  movementMinor: bigint;
};

/**
 * A ledger that holds cash or bank money, and the STRUCTURAL fact that
 * says so.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 HOW A CASH LEDGER IS IDENTIFIED, AND HOW IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It is never identified by its name or its code. `%bank%`, `%cash%` and
 * `code LIKE '1%'` are all wrong for some tenant, and wrong quietly: the
 * statement still reconciles when a cash ledger is missed — the missed
 * ledger simply moves from the cash line into the working-capital lines
 * and the closing cash figure comes out too small, with nothing on the
 * page to say so. There are exactly two structural sources:
 *
 *   • `bank_account` — a row in `bank_accounts` points at this ledger.
 *     `db/schema/banking.ts` exists precisely to record that a chart-of-
 *     accounts line corresponds to a real account with a real statement,
 *     and it enforces one bank account per ledger. This is the strongest
 *     signal in the system.
 *
 *   • `posting_role` — the tenant mapped the `bank` posting role to this
 *     ledger in `sales_posting_accounts`. That role is documented in
 *     `lib/accounting/sales-posting.ts` as "Bank / Cash — where customer
 *     receipts land", and it is how cash in hand is identified for a
 *     tenant who has no `bank_accounts` row for it. It is tenant-declared
 *     data, not inference.
 *
 * ⚠️ A LEDGER CAN BE BOTH, and must then be counted once. The action
 * de-duplicates by `ledgerId` before calling in here; `buildCashFlow`
 * de-duplicates again rather than trusting that, because counting one
 * bank account twice doubles the opening balance and produces a
 * discrepancy that looks like a missing transaction.
 */
export type CashLedger = {
  ledgerId: string;
  code: string;
  name: string;
  source: "bank_account" | "posting_role";
};

export type CashFlowInput = {
  /** EVERY ledger's movement over the period — cash and non-cash alike. */
  movements: readonly LedgerMovement[];
  cashLedgers: readonly CashLedger[];
  /**
   * Cash and bank, cumulative from inception to the day BEFORE the
   * period opened. See `previousDay` in `lib/accounting/periods.ts` for
   * why it is the day before and not the first day.
   */
  openingCashMinor: bigint;
  /**
   * 🔴 CASH AND BANK, CUMULATIVE FROM INCEPTION TO THE PERIOD END,
   * READ STRAIGHT OFF THE LEDGERS. This is the FACT the whole statement
   * is checked against. It is loaded by its own query and is never
   * derived from anything else in this file.
   */
  actualClosingCashMinor: bigint;
};

/* ------------------------------------------------------------------ */
/* WHAT COMES BACK                                                     */
/* ------------------------------------------------------------------ */

/** One ledger's contribution, already signed as an effect on cash. */
export type CashFlowLine = {
  ledgerId: string;
  code: string;
  name: string;
  type: string;
  accountType: string;
  /** Positive is cash IN. `−movementMinor`. See the header. */
  cashEffectMinor: bigint;
};

export type CashFlowStatement = {
  /** The period's profit, credit-positive. Positive is a profit. */
  netResultMinor: bigint;

  /** Non-cash ASSET ledgers, signed as cash effects. */
  assetMovements: CashFlowLine[];
  assetMovementTotalMinor: bigint;

  /** LIABILITY and EQUITY ledgers, signed as cash effects. */
  fundingMovements: CashFlowLine[];
  fundingMovementTotalMinor: bigint;

  /** `netResult + assets + funding` — what the indirect method says. */
  netMovementMinor: bigint;

  openingCashMinor: bigint;
  /** `opening + netMovement`. DERIVED. */
  computedClosingCashMinor: bigint;
  /** Straight off the cash ledgers. A FACT, never derived. */
  actualClosingCashMinor: bigint;

  /**
   * The movement on the cash ledgers over the period, taken DIRECTLY
   * from the period query rather than built up. A second, independent
   * route to the same number — see `reconciles`.
   */
  directCashMovementMinor: bigint;

  /** `computedClosing − actualClosing`. Must be zero. */
  discrepancyMinor: bigint;
  /**
   * The other gap: `(opening + directCashMovement) − actualClosing`.
   * Must also be zero, and catches a different fault. See `reconciles`.
   */
  snapshotGapMinor: bigint;

  /**
   * 🔴 TRUE ONLY WHEN BOTH GAPS ARE ZERO. When false the caller must
   * refuse to render the figures. See the note on `buildCashFlow`.
   */
  reconciles: boolean;

  /** The ledgers treated as cash, and the structural reason for each. */
  cashLedgers: CashLedger[];

  /**
   * Configuration faults that make the statement meaningless even if the
   * arithmetic happens to close. Plain sentences, shown to the user.
   */
  problems: string[];

  /** `reconciles && problems.length === 0`. The only safe-to-render flag. */
  usable: boolean;
};

/**
 * ⚠️ THE FIVE VALUES OF `account_type`, SPLIT THE ONLY TWO WAYS THAT
 * MATTER HERE. Kept as sets rather than string comparisons so that an
 * account type nobody anticipated falls through to the `problems` list
 * instead of silently contributing nothing — a ledger that belongs to no
 * bucket breaks the identity by exactly its own movement, and the
 * reconciliation would then report a gap with no explanation attached.
 */
const PL_TYPES: ReadonlySet<string> = new Set(["revenue", "expense"]);
const ASSET_TYPES: ReadonlySet<string> = new Set(["asset"]);
const FUNDING_TYPES: ReadonlySet<string> = new Set(["liability", "equity"]);

function sortByCode(a: CashFlowLine, b: CashFlowLine): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * ⭐⭐⭐ BUILD THE STATEMENT, AND CHECK IT AGAINST THE BANK.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE RECONCILIATION IS THE POINT OF THIS FUNCTION
 * ══════════════════════════════════════════════════════════════════════
 * Everything above this line is arithmetic that, on a healthy ledger,
 * cannot come out wrong. That is exactly why the check has to exist: a
 * derivation that is right by construction is a derivation nobody looks
 * at, and the day the construction stops holding is the day it starts
 * lying with total confidence.
 *
 * So the closing cash figure is computed TWICE, by two routes that share
 * no arithmetic, and the two are compared:
 *
 *   ROUTE A — the indirect method.
 *     opening cash + profit − movements on every non-cash ledger.
 *     Touches every ledger in the chart of accounts EXCEPT the cash ones.
 *
 *   ROUTE B — the bank and cash ledgers themselves.
 *     The cumulative balance of the cash ledgers at the period end,
 *     loaded by its own query. Touches ONLY the cash ledgers.
 *
 * The two routes have no ledger in common. They agree only if the ledger
 * is complete and consistent, which is what a cash flow statement is
 * claiming when it prints a closing balance.
 *
 * ⚠️ AND A THIRD FIGURE IS CHECKED TOO, because the two gaps catch
 * different faults and a statement that reports the wrong one sends
 * somebody looking in the wrong place:
 *
 *   `discrepancyMinor`  — Route A against Route B. Non-zero means a
 *      ledger's movement has gone missing from the build-up: a ledger
 *      soft-deleted after it was posted to (`ledgerBalances` filters on
 *      `deleted_at`, so its entries survive in `journal_entries` while
 *      its movement vanishes from the statement), an account type this
 *      file does not bucket, or a cash ledger counted in both routes.
 *
 *   `snapshotGapMinor`  — opening + the cash ledgers' OWN period
 *      movement, against the closing snapshot. This compares three
 *      queries that should tile the timeline exactly: (−∞, from) plus
 *      [from, to] equals (−∞, to]. Non-zero means the windows do not
 *      tile — an off-by-one on the opening cutoff is the way that
 *      happens, and it is invisible in `discrepancyMinor` because both
 *      routes would inherit the same bad opening balance and cancel.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHEN IT DOES NOT RECONCILE, THE ANSWER IS WORDS, NOT A NUMBER
 * ══════════════════════════════════════════════════════════════════════
 * `usable` is false and the caller must render an explanation in place
 * of the statement. Not a figure with an asterisk, not a figure in
 * amber, not the statement with a warning above it — no closing cash
 * figure at all.
 *
 * A cash flow statement is read by somebody deciding whether to make
 * payroll, draw on a facility, or lend. A number that is nearly right is
 * acted upon exactly like a number that is right. The only safe failure
 * mode for this statement is refusing to produce one, and saying which
 * of the faults above it looks like.
 */
export function buildCashFlow(input: CashFlowInput): CashFlowStatement {
  const problems: string[] = [];

  /**
   * ⚠️ DE-DUPLICATED BY LEDGER ID. A ledger can be both a `bank_accounts`
   * row and the tenant's mapped `bank` posting role — the common case for
   * a tenant with one current account, in fact. Counting it twice would
   * not break the identity (the set membership below is what matters),
   * but it would list the account twice on the page, and the page is what
   * tells the reader what "cash" means in this statement.
   */
  const cashLedgers: CashLedger[] = [];
  const cashLedgerIds = new Set<string>();
  for (const ledger of input.cashLedgers) {
    if (cashLedgerIds.has(ledger.ledgerId)) continue;
    cashLedgerIds.add(ledger.ledgerId);
    cashLedgers.push(ledger);
  }

  /**
   * 🔴 NO CASH LEDGER MEANS NO CASH FLOW STATEMENT.
   *
   * ⚠️ AND THIS CASE RECONCILES PERFECTLY, WHICH IS WHY IT IS CHECKED
   * SEPARATELY. With an empty cash set the opening balance is zero, the
   * closing balance is zero, and every ledger in the business lands in
   * the working-capital lines — so `Δcash = 0` and `actual = 0` and the
   * arithmetic closes. The page would render a complete, balanced,
   * internally consistent statement saying the company holds no money.
   */
  if (cashLedgers.length === 0) {
    problems.push(
      "No ledger in this workspace is identified as cash or bank, so there is nothing " +
        "to reconcile to. Link a bank account to its ledger under Banking, or map the " +
        "Bank / Cash posting role, and this statement will work. It is deliberately " +
        "not guessed from ledger names.",
    );
  }

  const movementById = new Map<string, LedgerMovement>();
  for (const m of input.movements) movementById.set(m.ledgerId, m);

  /**
   * ⚠️ A CASH LEDGER THAT THE BALANCE QUERY NEVER RETURNED. The query
   * excludes soft-deleted ledgers; `bank_accounts.ledger_id` is
   * `ON DELETE RESTRICT` but nothing stops a row being soft-deleted with
   * a bank account still pointing at it. Its money then exists in
   * `journal_entries` and appears in neither route, and the statement is
   * short by that account's whole balance.
   */
  for (const ledger of cashLedgers) {
    if (!movementById.has(ledger.ledgerId)) {
      problems.push(
        `The ledger behind "${ledger.name}" (${ledger.code}) is linked as a cash or bank ` +
          `account but is not in the chart of accounts — it has probably been deleted. ` +
          `Its balance is missing from this statement.`,
      );
    }
  }

  let netResultMinor = 0n;
  let directCashMovementMinor = 0n;
  const assetMovements: CashFlowLine[] = [];
  const fundingMovements: CashFlowLine[] = [];

  for (const m of input.movements) {
    /**
     * 🔴 CASH MEMBERSHIP IS TESTED FIRST, BEFORE ACCOUNT TYPE, AND THE
     * ORDER IS LOAD-BEARING. A bank ledger is an ASSET. Bucket by
     * account type first and it lands in `assetMovements` as well as in
     * the cash total, the same rupees are counted on both sides of the
     * reconciliation, and the gap comes out at exactly twice the period's
     * cash movement — a number large enough to look like a missing
     * transaction and shaped exactly like one.
     */
    if (cashLedgerIds.has(m.ledgerId)) {
      /**
       * ⚠️ A CASH LEDGER MUST NOT BE A REVENUE OR EXPENSE ACCOUNT.
       * If a tenant has mapped the Bank / Cash posting role to a P&L
       * ledger, that ledger is now excluded from `netResult` — the
       * profit figure silently changes and the statement still closes,
       * because the identity does not care which bucket a ledger is in
       * as long as it is in exactly one. Refuse instead.
       */
      if (PL_TYPES.has(m.accountType)) {
        problems.push(
          `"${m.name}" (${m.code}) is mapped as a cash or bank account but is a ` +
            `${m.accountType} ledger. Cash is an asset; this mapping would take it out of ` +
            `the profit for the period and put it in the bank balance.`,
        );
      }
      directCashMovementMinor += m.movementMinor;
      continue;
    }

    if (PL_TYPES.has(m.accountType)) {
      // Credit-positive: positive is a profit. See the header identity.
      netResultMinor -= m.movementMinor;
      continue;
    }

    const line: CashFlowLine = {
      ledgerId: m.ledgerId,
      code: m.code,
      name: m.name,
      type: m.type,
      accountType: m.accountType,
      // Cash effect is minus the debit-positive movement. See the header.
      cashEffectMinor: -m.movementMinor,
    };

    if (ASSET_TYPES.has(m.accountType)) {
      assetMovements.push(line);
    } else if (FUNDING_TYPES.has(m.accountType)) {
      fundingMovements.push(line);
    } else {
      /**
       * ⚠️ AN ACCOUNT TYPE THIS FILE DOES NOT KNOW. Unreachable through
       * the enum today. If it ever happens, the ledger belongs to no
       * bucket, the identity breaks by exactly its movement, and the
       * discrepancy below would otherwise be reported with no cause
       * attached. Naming it here is the difference between a five-minute
       * fix and an afternoon.
       */
      problems.push(
        `"${m.name}" (${m.code}) has account type "${m.accountType}", which this ` +
          `statement does not know how to classify. Its movement is missing from the ` +
          `figures below.`,
      );
    }
  }

  assetMovements.sort(sortByCode);
  fundingMovements.sort(sortByCode);

  const assetMovementTotalMinor = assetMovements.reduce(
    (acc, l) => acc + l.cashEffectMinor,
    0n,
  );
  const fundingMovementTotalMinor = fundingMovements.reduce(
    (acc, l) => acc + l.cashEffectMinor,
    0n,
  );

  const netMovementMinor =
    netResultMinor + assetMovementTotalMinor + fundingMovementTotalMinor;

  const computedClosingCashMinor = input.openingCashMinor + netMovementMinor;

  const discrepancyMinor = computedClosingCashMinor - input.actualClosingCashMinor;
  const snapshotGapMinor =
    input.openingCashMinor + directCashMovementMinor - input.actualClosingCashMinor;

  const reconciles = discrepancyMinor === 0n && snapshotGapMinor === 0n;

  return {
    netResultMinor,
    assetMovements,
    assetMovementTotalMinor,
    fundingMovements,
    fundingMovementTotalMinor,
    netMovementMinor,
    openingCashMinor: input.openingCashMinor,
    computedClosingCashMinor,
    actualClosingCashMinor: input.actualClosingCashMinor,
    directCashMovementMinor,
    discrepancyMinor,
    snapshotGapMinor,
    reconciles,
    cashLedgers,
    problems,
    usable: reconciles && problems.length === 0,
  };
}

/**
 * ⭐ WHY THIS STATEMENT CANNOT BE SHOWN, IN SENTENCES A USER CAN ACT ON.
 *
 * ⚠️ RETURNS AN EMPTY ARRAY WHEN THE STATEMENT IS FINE, so the caller
 * renders the failure card on `length > 0` and never has to decide what
 * "usable but with problems" would mean — there is no such state.
 *
 * ⚠️ THE CONFIGURATION PROBLEMS COME FIRST. A missing bank-account link
 * is a thing the customer can fix in a minute; a reconciliation gap is a
 * thing they must escalate. Leading with the gap sends somebody to
 * support for a problem they could have solved themselves.
 */
export function explainCashFlowFailure(statement: CashFlowStatement): string[] {
  const reasons = [...statement.problems];

  if (!statement.reconciles) {
    if (statement.discrepancyMinor !== 0n) {
      reasons.push(
        "The cash built up from profit and the movements in every other account does " +
          "not equal the closing balance of the cash and bank ledgers. Something posted " +
          "in this period is not represented in the accounts above — most often a ledger " +
          "that was deleted after entries had been posted to it.",
      );
    }
    if (statement.snapshotGapMinor !== 0n) {
      reasons.push(
        "The opening cash balance plus this period's movement on the cash and bank " +
          "ledgers does not equal their closing balance. The opening, movement and " +
          "closing figures were read separately and do not line up, so at least one of " +
          "the three covers the wrong range of dates.",
      );
    }
  }

  return reasons;
}
