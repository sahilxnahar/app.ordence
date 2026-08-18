import "server-only";

/**
 * Ordence — 🔴🔴 THE CREDIT-NOTE CAP ENFORCEMENT POINT
 * Version: v1.48.0-alpha (Batch 48)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS `import "server-only"` AND NOT IN `server/actions/`
 * ══════════════════════════════════════════════════════════════════════
 * Every export of a `"use server"` file is a browser-reachable RPC
 * endpoint. `assertCreditNoteWithinCaps` takes a `tenantId`, a `userId`
 * AND an open transaction — in a `"use server"` file that would be a
 * published endpoint accepting the tenant and the user to measure, which
 * is both a route past row-level security and a way to have the cap
 * evaluated against somebody else's day. Same shape, same reason, as
 * `lib/credit/enforce.ts` and `server/credit/position.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 IT RUNS INSIDE THE CALLER'S TRANSACTION AND IT ABORTS THE WRITE
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NOT BEFORE THE TRANSACTION, AND NOT IN THE FORM. Summing today's
 * credit notes on one connection and issuing on another is a race: two
 * tabs pressing Issue in the same second each read a total that does not
 * include the other, and the daily cap is passed by a business that
 * never intended to. Sharing `tx` puts the sum behind the same lock as
 * the write, and throwing from inside it rolls the whole issue back —
 * the number, the status, the ledger posting and the audit row, all or
 * nothing.
 *
 * 🔴 A `curl` AND A STALE TAB ARE REFUSED IDENTICALLY, because neither
 * of them is consulted. The UI may hide the Issue button as a courtesy;
 * this function is what makes hiding it merely a courtesy.
 *
 * ⚠️ AND IT DOES NOT FAIL OPEN. There is no `catch { return allowed }`
 * here. If `approval_limits` cannot be read the issue fails, loudly,
 * rather than degrading to "no row found, therefore no cap".
 */

import { and, eq, gte, notInArray, sql } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { approvalLimits } from "@/db/schema/credit";
import { salesCreditNotes } from "@/db/schema/sales-invoices";
import { toBigIntAmount } from "@/lib/billing/money";
import { todayInIndia } from "@/lib/accounting/periods";
import {
  assessCreditNoteCap,
  resolveCapMinor,
  CREDIT_NOTE_SCOPE,
  CREDIT_NOTE_DAILY_SCOPE,
  DEFAULT_DAILY_CAP_MINOR,
  DEFAULT_PER_NOTE_CAP_MINOR,
  type CreditNoteCapVerdict,
} from "@/lib/sales/refund-cap";
import {
  readFactorEvidence,
  NO_FACTOR_EVIDENCE,
  type FactorEvidence,
} from "@/lib/security/session-policy";
import type { SystemRole } from "@/db/schema/core";
import type { withTenant } from "@/db";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⭐ ITS OWN ERROR CLASS, AND THE REASON IS THE MESSAGE.
 *
 * 🔴 `toSalesActionError()` turns a plain `Error` into "Something went
 * wrong. Please try again." A cap refusal delivered as that sentence is
 * read as an outage: the person presses Issue again, then again, then
 * telephones support to report that credit notes are broken — while the
 * actual answer, "this one is above your limit and needs your manager",
 * sits in a server log nobody at the counter can see. The class exists
 * to be caught by name in `server/sales/guards.ts`; that is its whole
 * job.
 */
export class CreditNoteCapRefusal extends Error {
  readonly verdict: CreditNoteCapVerdict;
  readonly creditNoteId: string;

  constructor(creditNoteId: string, verdict: CreditNoteCapVerdict) {
    // ⚠️ THE WORD IS IN THE SENTENCE, not only in a badge on a screen.
    super(`${verdict.word}. ${verdict.reason}`);
    this.name = "CreditNoteCapRefusal";
    this.verdict = verdict;
    this.creditNoteId = creditNoteId;
  }
}

/**
 * Clerk's factor evidence for THIS request.
 *
 * ⚠️ READ BEFORE THE TRANSACTION OPENS, DELIBERATELY. `auth()` may reach
 * the network, and a network call held inside an open Postgres
 * transaction pins a connection for as long as an unrelated service
 * takes to answer. Nothing is lost by reading it early: the claim is
 * signed into the request's own session token and cannot change while
 * that request runs, so it is a constant of the request rather than
 * state the transaction has to protect.
 *
 * ⚠️ A FAILURE TO READ IT IS `NO_FACTOR_EVIDENCE`, WHICH REFUSES.
 * `measured: false` is the strict answer — see `stepUpFresh()`.
 */
export async function readRequestFactors(): Promise<FactorEvidence> {
  try {
    const { sessionClaims } = await auth();
    return readFactorEvidence(sessionClaims);
  } catch {
    return NO_FACTOR_EVIDENCE;
  }
}

/**
 * The instant the current Indian civil day began, as a `Date`.
 *
 * ⚠️ NOT `toISOString().slice(0, 10)`, AND NOT THE SERVER'S LOCAL ZONE.
 * India is UTC+05:30, so a UTC day boundary hands every user a fresh
 * daily cap at 05:30 in the morning and lets a second full day's worth
 * of credit notes out between then and midnight. `todayInIndia()` is the
 * civil date the rest of the product already agrees on; IST observes no
 * daylight saving, so the fixed offset below is exact rather than
 * approximately right.
 */
export function istDayStart(now: Date = new Date()): Date {
  return new Date(`${todayInIndia(now)}T00:00:00+05:30`);
}

/**
 * 🔴 THE GATE. Throws `CreditNoteCapRefusal`, aborting the caller's
 * transaction, when this person may not issue this credit note now.
 */
export async function assertCreditNoteWithinCaps(args: {
  tx: Tx;
  tenantId: string;
  /** The person pressing Issue. The day is measured against THEM. */
  userId: string;
  /** Their `system_role` — what `approval_limits.role` stores. */
  role: SystemRole;
  creditNoteId: string;
  /** 🔴 The document total in paise, tax included. Never a float. */
  noteTotalMinor: bigint;
  factors: FactorEvidence;
  now?: Date;
}): Promise<CreditNoteCapVerdict> {
  const now = args.now ?? new Date();

  /* ── THE CAPS ─────────────────────────────────────────────────── */
  const rows = await args.tx
    .select({ scope: approvalLimits.scope, maxValueMinor: approvalLimits.maxValueMinor })
    .from(approvalLimits)
    .where(
      and(
        eq(approvalLimits.tenantId, args.tenantId),
        eq(approvalLimits.role, args.role),
      ),
    );

  // ⚠️ `noUncheckedIndexedAccess` — `find` returns `T | undefined`, and
  // `resolveCapMinor` treats undefined as "no row", which is the default
  // figure rather than unlimited. That is the whole point of the helper.
  const perNote = resolveCapMinor(
    rows.find((r) => r.scope === CREDIT_NOTE_SCOPE) ?? null,
    DEFAULT_PER_NOTE_CAP_MINOR,
  );
  const daily = resolveCapMinor(
    rows.find((r) => r.scope === CREDIT_NOTE_DAILY_SCOPE) ?? null,
    DEFAULT_DAILY_CAP_MINOR,
  );

  /* ── THE DAY, SUMMED FROM THE LEDGER ──────────────────────────── */
  //
  // 🔴 SUMMED FROM THE ROWS THEMSELVES. There is no `issued_today_minor`
  // counter anywhere in this schema and there must never be one: a
  // counter is updated by exactly the code paths somebody remembered,
  // survives rollbacks it should not, and when it drifts it drifts
  // towards letting more money out — silently, because nothing compares
  // it with anything.
  //
  // ⚠️ MEASURED ON `issuedAt`, NOT ON `noteDate`. `noteDate` is a date
  // the person types and may lawfully backdate; using it would let
  // yesterday's date on today's document reset today's cap.
  //
  // ⚠️ AND ON THE SAME STATUS PREDICATE AS THE NUMBERING SERIES —
  // everything except drafts and cancellations. A draft has taken no
  // money and a cancelled note has given it back.
  const [today] = await args.tx
    .select({ totalMinor: sql<string | null>`coalesce(sum(${salesCreditNotes.totalMinor}), 0)` })
    .from(salesCreditNotes)
    .where(
      and(
        eq(salesCreditNotes.tenantId, args.tenantId),
        eq(salesCreditNotes.issuedBy, args.userId),
        gte(salesCreditNotes.issuedAt, istDayStart(now)),
        notInArray(salesCreditNotes.status, ["draft", "cancelled"]),
      ),
    );

  // ⚠️ AN AGGREGATE THAT COMES BACK WITH NO ROW AT ALL IS NOT ZERO — it
  // is a query that did not run the way we think it did. Refusing is the
  // only safe reading; treating it as ₹0 issued today would hand a full
  // fresh daily cap to whoever provoked it.
  if (!today) {
    throw new Error(
      "The day's credit-note total could not be read, so this credit note has not been " +
        "issued. Nothing has changed. Please try again.",
    );
  }

  const verdict = assessCreditNoteCap({
    noteTotalMinor: args.noteTotalMinor,
    issuedTodayMinor: toBigIntAmount(today.totalMinor),
    perNoteCapMinor: perNote.capMinor,
    perNoteCapIsDefault: perNote.capIsDefault,
    dailyCapMinor: daily.capMinor,
    dailyCapIsDefault: daily.capIsDefault,
    factors: args.factors,
  });

  if (verdict.outcome !== "allow") {
    throw new CreditNoteCapRefusal(args.creditNoteId, verdict);
  }
  return verdict;
}
