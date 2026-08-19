import "server-only";

/**
 * Ordence — ⭐⭐ THE RATE SERVICE — WHERE THE ENGINE MEETS THE TABLES
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM `lib/fx/*`
 * ══════════════════════════════════════════════════════════════════════
 * Same split as `lib/inventory/valuation.ts` and
 * `server/inventory/valuation-service.ts`. The arithmetic of AS 11 has to
 * be testable without a database, because accounting that can only be
 * exercised through a transaction is accounting that never gets
 * exercised. This file is the I/O half: it finds the rate, and it never
 * decides what the rate means.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RESOLUTION ORDER, AND WHY IT IS THIS WAY ROUND
 * ══════════════════════════════════════════════════════════════════════
 *   ① IDENTITY. from === to is 1, exactly, and touches no table. This is
 *      the path every existing INR-only workspace takes, which is why the
 *      batch changes no number that is on a screen today.
 *   ② THE TENANT'S OWN RATE, in the direction asked for.
 *   ③ THE TENANT'S OWN RATE, inverted.
 *   ④ THE PUBLISHED REFERENCE RATE, in the direction asked for.
 *   ⑤ THE PUBLISHED REFERENCE RATE, inverted.
 *
 * ⭐ THE TENANT WINS OVER THE PUBLISHED RATE, and that is deliberate. If
 *    a workspace has typed the rate their bank actually gave them, that
 *    is the rate their money moved at; the RBI reference rate is the
 *    fallback for the days they have not.
 *
 * ⭐ AND THE DIRECTION ASKED FOR WINS OVER THE INVERSION at each level. A
 *    published USD/INR is evidence; INR/USD derived from it is arithmetic
 *    we did. Both are usable and only one is a document, so the document
 *    is preferred and the derivation is labelled.
 *
 * 🔴 THERE IS NO "LATEST" PATH. `on` is a required argument on every
 *    function below. `resolveQuote` will reach BACKWARDS from `on` only
 *    when the caller passes a `StalenessPolicy` saying how far and why —
 *    it never reaches forwards, and it never reaches back by default.
 */

import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { withTenant, withPlatformScope } from "@/db";
import { currencyUnits, fxRates, fxReferenceRates } from "@/db/schema/fx";
import {
  KNOWN_CURRENCIES,
  assertKnownCurrency,
  minorUnitExponent,
  normaliseCurrencyCode,
} from "@/lib/fx/currency";
import {
  FxRateError,
  RATE_EXPONENT,
  describeRateType,
  formatRateScaled,
  identityQuote,
  invertQuote,
  makeQuote,
  parseRateToScaled,
  type FxQuote,
  type FxRateSource,
  type FxRateType,
  type StorableFxRateSource,
  type StorableFxRateType,
} from "@/lib/fx/rates";
import {
  assertStatutoryQuote,
  type StatutoryConversion,
  StatutoryRateError,
} from "@/lib/fx/statutory";
import type { StalenessPolicy } from "@/lib/fx/convert";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⚠️ `numeric(30,12)` ARRIVES AS A STRING AND IS PARSED AS TEXT.
 * `Number("83.215")` then `* 1e12` is 83214999999999.98 and the rate a
 * customer typed is not the rate their invoice used.
 */
function scaledFromNumeric(value: string): bigint {
  return parseRateToScaled(value.trim());
}

/** Scaled bigint → the exact `numeric(30,12)` literal to store. */
export function numericFromScaled(rateScaled: bigint): string {
  return formatRateScaled(rateScaled);
}

/* ================================================================== */
/* RESOLUTION                                                          */
/* ================================================================== */

export type RateLookup = {
  tenantId: string;
  from: string;
  to: string;
  /** 🔴 REQUIRED. The date of the event being measured. */
  on: string;
  /**
   * How far back the search may reach and why. Omit for "the day itself,
   * or nothing" — which is the only policy that needs no justification.
   */
  policy?: StalenessPolicy;
  /**
   * ⭐⭐ WHICH SIDE OF THE SPREAD IS ACCEPTABLE — 0106.
   *
   * 🔴 A FILTER, NOT A PREFERENCE. When set, rows of every other rate
   * type are excluded from the candidate set in SQL, so a mid rate cannot
   * be ranked, cannot be picked and cannot be returned. Ranking it lower
   * would have been the wrong design: "prefer TT buying, fall back to
   * mid" is the silent substitution this batch exists to end.
   *
   * ⚠️ OMITTING IT MEANS "ANY", which is what every AS 11 caller wants and
   * what every caller written before 0106 already does — an initial
   * recognition or a closing-rate revaluation names no side of the spread,
   * so filtering them would refuse conversions that are correct today.
   */
  rateType?: FxRateType;
};

type RateRow = {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  rateDate: string;
  source: string;
  /** ⚠️ NOT NULL IN THE DATABASE SINCE 0106. Never derived from `source`. */
  rateType: string;
  sourceReference: string | null;
};

function earliestAllowed(on: string, policy: StalenessPolicy | undefined): string {
  if (!policy || policy.kind === "exact") return on;
  const ms = Date.parse(`${on}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new FxRateError(`"${on}" is not a date in YYYY-MM-DD form.`);
  return new Date(ms - policy.maxDays * 86_400_000).toISOString().slice(0, 10);
}

function toQuote(row: RateRow): FxQuote {
  return makeQuote({
    baseCurrency: row.baseCurrency,
    quoteCurrency: row.quoteCurrency,
    rateScaled: scaledFromNumeric(row.rate),
    rateDate: row.rateDate,
    source: row.source as FxRateSource,
    rateType: row.rateType as FxRateType,
    sourceReference: row.sourceReference,
    rateId: row.id,
  });
}

/**
 * ⭐⭐ FIND THE RATE, OR RETURN `null`.
 *
 * 🔴 `null` IS A FACT ABOUT THE DATA AND NOT AN ERROR. "No rate is on file
 * for 31 March" is a true sentence that a screen can print next to an
 * unconverted subtotal. Throwing here would push every caller into a
 * try/catch whose obvious `catch` is to carry on with an unconverted
 * number, which is the failure this batch exists to end.
 *
 * ⚠️ THE CALLER MUST BE INSIDE `withTenant()`. `tx` is the tenant-pinned
 * transaction; the reference-rate read below happens on the same
 * connection, and `fx_reference_rates` is readable in any scope by design
 * (it is published data) while `fx_rates` is not.
 */
export async function resolveQuote(tx: Tx, lookup: RateLookup): Promise<FxQuote | null> {
  const from = normaliseCurrencyCode(lookup.from);
  const to = normaliseCurrencyCode(lookup.to);
  assertKnownCurrency(from);
  assertKnownCurrency(to);

  // ① Identity. No table, exact, and the path every INR workspace takes.
  // ⚠️ IT CARRIES THE REQUESTED RATE TYPE, because there is no spread
  // between a currency and itself: the TT buying rate of rupees for rupees
  // is one, and so is the selling rate and the mid.
  if (from === to) return identityQuote(from, lookup.on, lookup.rateType ?? "unstated");

  const floor = earliestAllowed(lookup.on, lookup.policy);

  /**
   * ⚠️ BOTH DIRECTIONS ARE FETCHED IN ONE QUERY AND RANKED IN CODE.
   * Two round trips would be two chances for the second to come back
   * empty because the first already consumed the interesting date.
   */
  const own = (await tx
    .select({
      id: fxRates.id,
      baseCurrency: fxRates.baseCurrency,
      quoteCurrency: fxRates.quoteCurrency,
      rate: fxRates.rate,
      rateDate: fxRates.rateDate,
      source: fxRates.source,
      rateType: fxRates.rateType,
      sourceReference: fxRates.sourceReference,
    })
    .from(fxRates)
    .where(
      and(
        eq(fxRates.tenantId, lookup.tenantId),
        lte(fxRates.rateDate, lookup.on),
        gte(fxRates.rateDate, floor),
        // ⭐ 0106 — a filter, so a wrong-side rate is never a candidate.
        ...(lookup.rateType ? [eq(fxRates.rateType, lookup.rateType)] : []),
        or(
          and(eq(fxRates.baseCurrency, from), eq(fxRates.quoteCurrency, to)),
          and(eq(fxRates.baseCurrency, to), eq(fxRates.quoteCurrency, from)),
        ),
      ),
    )
    .orderBy(desc(fxRates.rateDate))) as RateRow[];

  const published = (await tx
    .select({
      id: fxReferenceRates.id,
      baseCurrency: fxReferenceRates.baseCurrency,
      quoteCurrency: fxReferenceRates.quoteCurrency,
      rate: fxReferenceRates.rate,
      rateDate: fxReferenceRates.rateDate,
      source: fxReferenceRates.source,
      rateType: fxReferenceRates.rateType,
      sourceReference: fxReferenceRates.sourceReference,
    })
    .from(fxReferenceRates)
    .where(
      and(
        lte(fxReferenceRates.rateDate, lookup.on),
        gte(fxReferenceRates.rateDate, floor),
        ...(lookup.rateType ? [eq(fxReferenceRates.rateType, lookup.rateType)] : []),
        or(
          and(
            eq(fxReferenceRates.baseCurrency, from),
            eq(fxReferenceRates.quoteCurrency, to),
          ),
          and(
            eq(fxReferenceRates.baseCurrency, to),
            eq(fxReferenceRates.quoteCurrency, from),
          ),
        ),
      ),
    )
    .orderBy(desc(fxReferenceRates.rateDate))) as RateRow[];

  return pickQuote(own, published, from, to, lookup.rateType);
}

/**
 * ⭐ THE RANKING, PULLED OUT SO IT IS TESTABLE WITHOUT A DATABASE.
 * Exported for `tests/ui/fx.test.ts`, which asserts the precedence as a
 * RELATION between two candidate sets rather than by pinning a row.
 */
export function pickQuote(
  own: readonly RateRow[],
  published: readonly RateRow[],
  from: string,
  to: string,
  /**
   * ⭐ 0106 — WHEN GIVEN, EVERY OTHER RATE TYPE IS DISCARDED BEFORE
   * RANKING. Restated here as well as in the SQL because `pickQuote` is
   * the half that is exercised without a database, and a filter that
   * exists only in a `WHERE` clause is a filter no test can see.
   */
  requiredRateType?: FxRateType,
): FxQuote | null {
  const eligible = (rows: readonly RateRow[]): readonly RateRow[] =>
    requiredRateType ? rows.filter((r) => r.rateType === requiredRateType) : rows;
  const ownRows = eligible(own);
  const publishedRows = eligible(published);

  const direct = (rows: readonly RateRow[]): RateRow | null =>
    rows.find((r) => r.baseCurrency === from && r.quoteCurrency === to) ?? null;
  const reverse = (rows: readonly RateRow[]): RateRow | null =>
    rows.find((r) => r.baseCurrency === to && r.quoteCurrency === from) ?? null;

  const ownDirect = direct(ownRows);
  if (ownDirect) return toQuote(ownDirect);
  const ownReverse = reverse(ownRows);
  if (ownReverse) return invertQuote(toQuote(ownReverse));
  const pubDirect = direct(publishedRows);
  if (pubDirect) return toQuote(pubDirect);
  const pubReverse = reverse(publishedRows);
  if (pubReverse) return invertQuote(toQuote(pubReverse));
  return null;
}

/**
 * ⭐ THE SAME LOOKUP, BUT REFUSING RATHER THAN RETURNING NULL.
 *
 * For the paths where carrying on without a rate would be worse than
 * stopping — posting a foreign-currency invoice to the ledger, running a
 * revaluation. The message names the pair and the date so the tenant knows
 * exactly which rate to enter.
 */
export async function requireQuote(tx: Tx, lookup: RateLookup): Promise<FxQuote> {
  const quote = await resolveQuote(tx, lookup);
  if (quote) return quote;
  throw new FxRateError(
    `No exchange rate is on file to convert ${normaliseCurrencyCode(lookup.from)} to ` +
      `${normaliseCurrencyCode(lookup.to)} on ${lookup.on}. Nothing has been converted or ` +
      `posted. Enter the rate for that date — a figure translated at a rate nobody chose is ` +
      `worse than a figure that is not there.`,
  );
}

/* ================================================================== */
/* ⭐⭐⭐ A CONVERSION A STATUTE NAMES THE RATE FOR                     */
/* ================================================================== */

/**
 * ⭐⭐⭐ THE RATE RULE 26 NAMES, FOR THE DAY IT NAMES, OR A REFUSAL THAT
 * SAYS WHICH RATE IS MISSING FOR WHICH DAY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS A SEPARATE ENTRY POINT AND NOT AN ARGUMENT TO
 *    `requireQuote`
 * ══════════════════════════════════════════════════════════════════════
 * Because the difference is not a parameter, it is a promise. Every
 * caller of `requireQuote` gets the best rate on file, ranked, possibly
 * inverted, possibly a day old if it passed a staleness policy. A caller
 * of THIS function gets the number a rule names or an exception — no
 * ranking across rate types, no inversion, no window. Two behaviours that
 * different should not be two settings of one function, because a
 * default is how the wrong one gets chosen.
 *
 * ⚠️ IT FOLLOWS `requireQuote`'s SHAPE EXACTLY IN THE ONE WAY THAT
 * MATTERS: the message names the pair, the date and — new here — the rate
 * type, so the operator is told precisely which number to go and get.
 * "No rate available" would send somebody to enter a mid rate, which is
 * the failure.
 */
export async function requireStatutoryQuote(
  tx: Tx,
  args: {
    tenantId: string;
    from: string;
    to: string;
    /** 🔴 The date the STATUTE names. For Rule 26, the deduction date. */
    on: string;
    conversion: StatutoryConversion;
  },
): Promise<FxQuote> {
  const from = normaliseCurrencyCode(args.from);
  const to = normaliseCurrencyCode(args.to);

  const quote = await resolveQuote(tx, {
    tenantId: args.tenantId,
    from,
    to,
    on: args.on,
    // 🔴 NO STALENESS POLICY. Rule 26 fixes the date; `resolveQuote`
    // without a policy looks at that day and no other.
    rateType: args.conversion.rateType,
  });

  if (!quote) {
    /**
     * ⚠️ THE REFUSAL DISTINGUISHES "NO RATE AT ALL" FROM "A RATE OF THE
     * WRONG KIND", because the two send the operator to different places.
     * The second lookup is deliberately unfiltered and is only ever run on
     * the failure path.
     */
    const anyType = await resolveQuote(tx, {
      tenantId: args.tenantId,
      from,
      to,
      on: args.on,
    });
    const alsoOnFile = anyType
      ? ` A ${describeRateType(anyType.rateType)} for ${from}/${to} IS on file for that day ` +
        `and has NOT been used: ${describeQuoteSafe(anyType)}. These are different numbers.`
      : "";
    throw new StatutoryRateError({
      conversion: args.conversion,
      on: args.on,
      pair: `${from}/${to}`,
      message:
        `No ${describeRateType(args.conversion.rateType)} is on file for ${from}/${to} on ` +
        `${args.on}. Nothing has been converted and no tax has been computed. ` +
        `${args.conversion.statutoryRef} requires that rate for that date — ` +
        `${args.conversion.dateMeans}.${alsoOnFile} Enter the ` +
        `${describeRateType(args.conversion.rateType)} for ${from}/${to} on ${args.on}.`,
    });
  }

  // ⭐ The pure gate has the last word: side of the spread, day, direction
  // and whether we computed the number rather than being given it.
  assertStatutoryQuote({ quote, conversion: args.conversion, on: args.on, from, to });
  return quote;
}

function describeQuoteSafe(q: FxQuote): string {
  return `${q.baseCurrency}/${q.quoteCurrency} ${formatRateScaled(q.rateScaled)} (${q.source})`;
}

/* ================================================================== */
/* WRITING RATES                                                       */
/* ================================================================== */

/**
 * ⭐ THE TENANT'S OWN RATE. A tenant write, in the tenant's transaction,
 * under the ordinary tenant policy.
 *
 * ⚠️ `ON CONFLICT DO UPDATE` ON (tenant, pair, day), NOT AN INSERT. A rate
 * for a day that has already been used is corrected, not duplicated — and
 * `entered_by` and `updated_at` move with the correction, so the audit
 * trail shows who changed the number rather than only who first typed it.
 */
export async function recordTenantRate(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string | null;
    baseCurrency: string;
    quoteCurrency: string;
    /** Decimal text, up to twelve places. Never a `number`. */
    rate: string;
    rateDate: string;
    source?: StorableFxRateSource;
    /**
     * 🔴 REQUIRED SINCE 0106, AND WITH NO DEFAULT ON PURPOSE. The person
     * entering a rate is holding the advice it came from and knows whether
     * it is the buying side, the selling side or a mid. A default here
     * would put a guess in the column that a s.195 deduction is computed
     * from — and `unstated` is deliberately not offered, because that
     * value records history, not a new decision.
     */
    rateType: StorableFxRateType;
    sourceReference?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; rateScaled: bigint }> {
  const base = normaliseCurrencyCode(args.baseCurrency);
  const quote = normaliseCurrencyCode(args.quoteCurrency);
  assertKnownCurrency(base);
  assertKnownCurrency(quote);
  if (base === quote) {
    throw new FxRateError(
      `${base} to ${base} is exactly 1 and is never stored. Storing it would create a row that ` +
        `could later be edited to something other than 1.`,
    );
  }
  // Validate through the engine so a malformed rate never reaches the table.
  const validated = makeQuote({
    baseCurrency: base,
    quoteCurrency: quote,
    rateScaled: parseRateToScaled(args.rate),
    rateDate: args.rateDate,
    source: args.source ?? "manual",
    rateType: args.rateType,
  });

  const [row] = await tx
    .insert(fxRates)
    .values({
      tenantId: args.tenantId,
      baseCurrency: base,
      quoteCurrency: quote,
      rate: numericFromScaled(validated.rateScaled),
      rateDate: validated.rateDate,
      source: args.source ?? "manual",
      rateType: args.rateType,
      sourceReference: args.sourceReference ?? null,
      note: args.note ?? null,
      enteredBy: args.userId,
    })
    /**
     * ⚠️ THE RATE TYPE IS PART OF THE CONFLICT TARGET SINCE 0106, matching
     * `fx_rates_pair_day_type_key`. Without it a TT selling rate entered
     * on Tuesday would overwrite Tuesday's TT buying rate and the s.195
     * base would move without anybody touching a deduction.
     */
    .onConflictDoUpdate({
      target: [
        fxRates.tenantId,
        fxRates.baseCurrency,
        fxRates.quoteCurrency,
        fxRates.rateDate,
        fxRates.rateType,
      ],
      set: {
        rate: numericFromScaled(validated.rateScaled),
        source: args.source ?? "manual",
        sourceReference: args.sourceReference ?? null,
        note: args.note ?? null,
        enteredBy: args.userId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: fxRates.id });

  if (!row) throw new FxRateError("The rate could not be saved. Nothing has been changed.");
  return { id: row.id, rateScaled: validated.rateScaled };
}

/**
 * 🔴 A PUBLISHED RATE IS A PLATFORM WRITE AND NOTHING ELSE MAY WRITE ONE.
 *
 * `fx_reference_rates` has no `tenant_id`, its policy's `WITH CHECK` is
 * `app_platform_scope()`, and this is the only function that sets it. A
 * tenant that could write a "published" rate could put a number of its own
 * choosing in front of its auditor with the RBI's name on it.
 */
export async function recordReferenceRate(args: {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  rateDate: string;
  source: "rbi_reference" | "provider";
  /** 🔴 REQUIRED SINCE 0106. See `recordTenantRate`. */
  rateType: StorableFxRateType;
  sourceReference?: string | null;
}): Promise<{ id: string }> {
  const base = normaliseCurrencyCode(args.baseCurrency);
  const quote = normaliseCurrencyCode(args.quoteCurrency);
  const validated = makeQuote({
    baseCurrency: base,
    quoteCurrency: quote,
    rateScaled: parseRateToScaled(args.rate),
    rateDate: args.rateDate,
    source: args.source,
    rateType: args.rateType,
  });

  return withPlatformScope(
    "publishing a reference exchange rate, which is one fact for every workspace and is stored once",
    async (tx) => {
      const [row] = await tx
        .insert(fxReferenceRates)
        .values({
          baseCurrency: base,
          quoteCurrency: quote,
          rate: numericFromScaled(validated.rateScaled),
          rateDate: validated.rateDate,
          source: args.source,
          rateType: args.rateType,
          sourceReference: args.sourceReference ?? null,
        })
        .onConflictDoUpdate({
          target: [
            fxReferenceRates.baseCurrency,
            fxReferenceRates.quoteCurrency,
            fxReferenceRates.rateDate,
            fxReferenceRates.source,
            fxReferenceRates.rateType,
          ],
          set: {
            rate: numericFromScaled(validated.rateScaled),
            sourceReference: args.sourceReference ?? null,
            publishedAt: new Date(),
          },
        })
        .returning({ id: fxReferenceRates.id });
      if (!row) throw new FxRateError("The reference rate could not be published.");
      return { id: row.id };
    },
  );
}

/* ================================================================== */
/* THE EXPONENT TABLE, CHECKED AGAINST THE ENGINE                      */
/* ================================================================== */

export type CurrencyUnitsDivergence = {
  code: string;
  /** What `currency_units` says, or null when the row is missing. */
  inDatabase: number | null;
  /** What `lib/fx/currency.ts` says, or null when the code is unknown to it. */
  inEngine: number | null;
};

/**
 * 🔴 THE DUPLICATE, CHECKED.
 *
 * `currency_units` and `lib/fx/currency.ts` hold the same fact for two
 * different consumers — SQL-side reporting and the TypeScript engine. Two
 * copies of a fact drift, and this one would drift silently: a wrong
 * exponent in the table changes what a hand-written report prints and
 * nothing else, so nobody finds out from the application.
 *
 * ⭐ SO THE DUPLICATE IS A CACHE AND NOT A SECOND TRUTH: this reads both
 * and returns every disagreement, and `server/actions/fx.ts` surfaces the
 * list on the FX settings screen. A cache that is compared is safe; a
 * cache that is not is a second source of truth wearing a disguise.
 */
export async function verifyCurrencyUnits(tx: Tx): Promise<CurrencyUnitsDivergence[]> {
  const rows = await tx
    .select({ code: currencyUnits.code, exponent: currencyUnits.exponent })
    .from(currencyUnits);

  const inDb = new Map(rows.map((r) => [r.code, r.exponent]));
  const divergences: CurrencyUnitsDivergence[] = [];

  for (const code of KNOWN_CURRENCIES) {
    const engine = minorUnitExponent(code);
    const database = inDb.get(code);
    if (database === undefined || database !== engine) {
      divergences.push({ code, inDatabase: database ?? null, inEngine: engine });
    }
  }
  for (const [code, exponent] of inDb) {
    if (!KNOWN_CURRENCIES.includes(code)) {
      divergences.push({ code, inDatabase: exponent, inEngine: null });
    }
  }
  return divergences.sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * ⭐⭐ WHICH CURRENCIES MAY BE PUT ON A NEW DOCUMENT.
 *
 * 🔴 THIS IS THE READ THAT MAKES `currency_units.is_active` A CONTROL
 * RATHER THAN A COLUMN. A flag that is written by a seed and consulted by
 * nothing is the exact defect this batch exists to stop repeating —
 * `valuationMethod` and `requireMfa` were both that. So the picker is
 * built from this query and not from `KNOWN_CURRENCIES`, and deactivating
 * a code actually removes it from the list.
 *
 * ⚠️ IT INTERSECTS WITH THE ENGINE RATHER THAN TRUSTING THE TABLE. A row
 * the engine has never heard of cannot be offered, because nothing could
 * then format or convert an amount in it — `minorUnitExponent` would
 * throw at the first render. The intersection is the safe set, and
 * `verifyCurrencyUnits` is what reports the difference.
 */
export async function activeCurrencyCodes(tx: Tx): Promise<{ code: string; exponent: number }[]> {
  const rows = await tx
    .select({ code: currencyUnits.code, exponent: currencyUnits.exponent })
    .from(currencyUnits)
    .where(eq(currencyUnits.isActive, true));

  return rows
    .filter((r) => KNOWN_CURRENCIES.includes(r.code))
    .map((r) => ({ code: r.code, exponent: minorUnitExponent(r.code) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * ⚠️ EXPORTED FOR THE SEED IN SQL 0101 AND FOR NOTHING ELSE TO IMPROVISE.
 * The migration's `DO $seed$` block inserts exactly these rows; if the
 * engine list changes, this is what a later migration regenerates from.
 */
export function currencyUnitSeedRows(): { code: string; exponent: number }[] {
  return KNOWN_CURRENCIES.map((code) => ({ code, exponent: minorUnitExponent(code) }));
}

/** How many decimals a stored rate carries, for a UI that formats one. */
export const STORED_RATE_DECIMALS = RATE_EXPONENT;

/**
 * ⚠️ A COUNT, NOT A LIST. Used by the settings screen to say how many
 * rates are on file without pulling several thousand rows to the browser.
 */
export async function tenantRateCount(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(fxRates)
    .where(eq(fxRates.tenantId, tenantId));
  return row?.n ?? 0;
}
