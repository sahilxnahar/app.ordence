/**
 * Ordence — ⭐⭐⭐ THE COST CENTRE DIMENSION
 * Version: v1.47.0-alpha · Batch 68
 *
 * Pure. No database, no clock, no imports from `server/`. Money is
 * `bigint` paise throughout and never passes through a `Number`. The
 * action loads rows; every rupee of judgement is decided here, where it
 * can be exercised without standing up Postgres.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE UN-COSTED BUCKET IS THE ENTIRE POINT OF THIS MODULE
 * ══════════════════════════════════════════════════════════════════════
 * `journal_entries.cost_centre_id` is nullable, and it is nullable for
 * two independent reasons that will both be true forever:
 *
 *   ① THE OTHER SIDE OF THE ENTRY HAS NO DEPARTMENT. An electricity
 *      bill debits two expense lines and credits one payable. The
 *      payable belongs to the supplier, not to Production or to Head
 *      Office, and a schema that demanded a cost centre on every leg
 *      would force somebody to invent one for it.
 *
 *   ② NOBODY HAS CODED IT YET. Every workspace starts with a full
 *      history of lines carrying no cost centre, and will keep acquiring
 *      more of them for as long as any posting path (an auto-posted
 *      sales invoice, a payroll run, an import) does not ask.
 *
 * ⚠️ THE TWO WAYS EVERY IMPLEMENTATION OF THIS FEATURE GOES WRONG, AND
 * BOTH ARE SILENT:
 *
 *   • DROPPING THE NULLS. An inner join to `cost_centres` is what an ORM
 *     writes by default and what looks right in review. The departmental
 *     P&L now sums to less than the P&L by an amount nothing on the page
 *     states. Every individual figure on it is correct.
 *
 *   • LUMPING THE NULLS SOMEWHERE. Into the first cost centre, into a
 *     "General" default, into whichever row the `GROUP BY` collapsed
 *     them onto. The total is now right and one department is carrying
 *     everybody else's uncoded cost. The person who runs that department
 *     disputes their own numbers, and they are right to.
 *
 * 🔴 SO THE BUCKET IS A ROW. It has a stable key, a label written in
 * words rather than a dash, and a subtotal, and it sorts LAST rather
 * than first — a screen whose top line is "Not allocated ₹1,40,00,000"
 * on day one reads as a fault in the product; the same line at the
 * bottom of a list of real departments reads as work to do, which is
 * what it is.
 *
 * ⚠️ IT IS NEVER HIDDEN WHEN IT IS ZERO EITHER — see `groupByCostCentre`.
 * A workspace that has finished coding everything wants to SEE that the
 * un-costed line is nil; an absent line is indistinguishable from a
 * report that has stopped looking.
 */

/* ------------------------------------------------------------------ */
/* THE BUCKET WITH NO COST CENTRE                                      */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE KEY FOR THE UN-COSTED BUCKET, AND IT IS NOT A UUID AND NOT AN
 * EMPTY STRING.
 *
 * ⚠️ IT MUST NEVER COLLIDE WITH A REAL `cost_centres.id`. An empty
 * string would sort first and read as a rendering bug; a nil UUID
 * (`00000000-…`) would be a legal value for the column, so a future
 * migration seeding a "General" cost centre could collide with it and
 * merge two buckets that mean opposite things. The double underscores
 * make it unmistakably a sentinel to anybody reading a URL or a test.
 */
export const UNCOSTED_KEY = "__uncosted__";

/**
 * What it is called on screen.
 *
 * ⚠️ "NOT ALLOCATED", NOT "OTHER", NOT "GENERAL", AND NOT "—".
 * "Other" and "General" both read like a department, and a reader who
 * takes them for one stops asking why it is so large. A dash reads as
 * missing data in a table where every other row has a name. "Not
 * allocated" says what is true — nobody has decided — which is the only
 * label that provokes the action the number deserves.
 */
export const UNCOSTED_LABEL = "Not allocated";

/** True for the sentinel above. The only place the comparison is made. */
export function isUncosted(key: string): boolean {
  return key === UNCOSTED_KEY;
}

/** The key a bucket gets, given a journal line's nullable cost centre. */
export function bucketKeyFor(costCentreId: string | null | undefined): string {
  return costCentreId ?? UNCOSTED_KEY;
}

/* ------------------------------------------------------------------ */
/* CODES                                                               */
/* ------------------------------------------------------------------ */

/** How a cost centre code is stored and compared. */
export const COST_CENTRE_CODE_MAX = 40;

const CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * ⚠️ CODES ARE COMPARED CASE-INSENSITIVELY AND STORED AS TYPED.
 *
 * "prod" and "PROD" as two cost centres is two departments with one
 * name, and every report that groups by code shows the split without
 * saying that it split. The database enforces it with a unique index on
 * `upper(code)`; this function is what lets the action say so in a
 * sentence before the insert fails with a constraint name.
 *
 * ⭐ STORED AS TYPED rather than upper-cased on the way in, because a
 * business that writes its cost centres as "Prod-North" gets to keep
 * that on its own reports. Uniqueness and presentation are different
 * questions and only one of them needs folding.
 */
export function normaliseCostCentreCode(code: string): string {
  return code.trim();
}

/** The comparison key. Never rendered. */
export function costCentreCodeKey(code: string): string {
  return normaliseCostCentreCode(code).toUpperCase();
}

export type CostCentreCodeProblem =
  | { ok: true; code: string }
  | { ok: false; reason: string };

export function validateCostCentreCode(raw: string): CostCentreCodeProblem {
  const code = normaliseCostCentreCode(raw);
  if (code.length === 0) return { ok: false, reason: "Enter a code." };
  if (code.length > COST_CENTRE_CODE_MAX) {
    return { ok: false, reason: `A code may be at most ${COST_CENTRE_CODE_MAX} characters.` };
  }
  if (!CODE_SHAPE.test(code)) {
    return {
      ok: false,
      reason:
        "A code may use letters, numbers, dot, dash and underscore, and must start with a letter or a number.",
    };
  }
  return { ok: true, code };
}

/* ------------------------------------------------------------------ */
/* GROUPING THE LEDGER BY COST CENTRE                                  */
/* ------------------------------------------------------------------ */

/**
 * One journal line as this module needs it. Debit and credit are kept
 * apart rather than netted, for the same reason `ledgerBalances` in
 * `server/actions/accounting.ts` keeps them apart: the sign flip belongs
 * in exactly one place and it is not here.
 */
export type CostedLine = {
  costCentreId: string | null;
  ledgerId: string;
  /** `revenue` | `expense` | anything else, which is filtered out. */
  accountType: string;
  debitMinor: bigint;
  creditMinor: bigint;
};

/** A cost centre as the report knows it — the sentinel included. */
export type CostCentreRef = {
  key: string;
  code: string;
  name: string;
};

/** The un-costed bucket, as a `CostCentreRef`. */
export const UNCOSTED_REF: CostCentreRef = {
  key: UNCOSTED_KEY,
  code: "",
  name: UNCOSTED_LABEL,
};

export type CostCentreBucket = {
  centre: CostCentreRef;
  /** Credits less debits over revenue and expense ledgers. Positive is a profit. */
  netResultMinor: bigint;
  revenueMinor: bigint;
  expenseMinor: bigint;
  /** How many journal lines landed here. Zero is legal and is shown. */
  lineCount: number;
};

/**
 * ⭐ REVENUE AND EXPENSE ONLY. The balance-sheet accounts are excluded
 * here rather than filtered by the caller, exactly as `getProfitAndLoss`
 * does — a departmental report that carries the bank balance around with
 * it is one careless `.map()` away from adding cash to turnover.
 */
export const PL_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["revenue", "expense"]);

/**
 * ⭐⭐ GROUP THE JOURNAL BY COST CENTRE.
 *
 * 🔴 `centres` IS THE FULL LIST OF THE TENANT'S COST CENTRES, INCLUDING
 * ARCHIVED ONES, AND EVERY ONE OF THEM GETS A BUCKET EVEN IF NOTHING
 * POSTED TO IT.
 *
 * ⚠️ A DEPARTMENT WITH NO ACTIVITY MUST APPEAR WITH A ZERO, not vanish.
 * Vanishing is how a department whose costs stopped being coded looks
 * exactly like a department that was closed, and the difference between
 * those two is the entire reason somebody opened this screen.
 *
 * 🔴 AND THE UN-COSTED BUCKET IS ALWAYS PRESENT, UNCONDITIONALLY. Not
 * "when it has lines". See the header.
 */
export function groupByCostCentre(
  lines: readonly CostedLine[],
  centres: readonly CostCentreRef[],
): CostCentreBucket[] {
  const buckets = new Map<string, CostCentreBucket>();

  const seed = (centre: CostCentreRef) => {
    if (buckets.has(centre.key)) return;
    buckets.set(centre.key, {
      centre,
      netResultMinor: 0n,
      revenueMinor: 0n,
      expenseMinor: 0n,
      lineCount: 0,
    });
  };

  for (const centre of centres) seed(centre);
  seed(UNCOSTED_REF);

  for (const line of lines) {
    if (!PL_ACCOUNT_TYPES.has(line.accountType)) continue;
    const key = bucketKeyFor(line.costCentreId);
    /**
     * ⚠️ A LINE POINTING AT A COST CENTRE THAT IS NOT IN `centres` GETS
     * ITS OWN BUCKET RATHER THAN BEING DISCARDED.
     *
     * It should be impossible — the foreign key is composite on
     * (cost_centre_id, tenant_id) and the delete is RESTRICTed — but
     * "should be impossible" is not a reason to make money disappear
     * from a total. The bucket carries the raw id as its name so
     * whoever sees it can go and look.
     */
    if (!buckets.has(key)) {
      seed({ key, code: "", name: `Unknown cost centre (${key})` });
    }
    const bucket = buckets.get(key) as CostCentreBucket;

    /**
     * Revenue is credit-positive and expense is debit-positive, so the
     * net of the two is simply credits minus debits across both. Same
     * derivation as `netResultMinor` in `server/actions/accounting.ts`,
     * and deliberately so: two definitions of "profit" in one product is
     * two answers to the only question this screen asks.
     */
    bucket.netResultMinor += line.creditMinor - line.debitMinor;
    if (line.accountType === "revenue") {
      bucket.revenueMinor += line.creditMinor - line.debitMinor;
    } else {
      bucket.expenseMinor += line.debitMinor - line.creditMinor;
    }
    bucket.lineCount += 1;
  }

  return sortBuckets([...buckets.values()]);
}

/**
 * ⭐ REAL COST CENTRES BY CODE, THEN THE UN-COSTED BUCKET, THEN ANYTHING
 * UNRECOGNISED. See the header for why "Not allocated" sorts last.
 */
export function sortBuckets(buckets: readonly CostCentreBucket[]): CostCentreBucket[] {
  const rank = (b: CostCentreBucket) => {
    if (isUncosted(b.centre.key)) return 1;
    if (b.centre.code === "") return 2;
    return 0;
  };
  return [...buckets].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return a.centre.code.localeCompare(b.centre.code) || a.centre.name.localeCompare(b.centre.name);
  });
}

/**
 * The sum of every bucket's net result.
 *
 * ⭐ THIS IS THE FIGURE THAT MUST EQUAL THE P&L's `netResult`, AND IT IS
 * COMPUTED HERE SO THAT THE COMPARISON IN `lib/accounting/budget.ts`
 * SUMS THE THING THAT IS ACTUALLY ON SCREEN rather than re-running the
 * source query. A check that re-reads the source proves the query is
 * deterministic and nothing else — see `lib/reconciliation/gate.ts` ①.
 */
export function totalNetResultMinor(buckets: readonly CostCentreBucket[]): bigint {
  return buckets.reduce((acc, b) => acc + b.netResultMinor, 0n);
}
