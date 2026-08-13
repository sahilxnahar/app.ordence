/**
 * Ordence — ⭐⭐ THE LIMITATION ACT, 1963
 * Version: v1.7.0-alpha
 *
 * Pure. No database, and 🔴 **no clock** — every function that depends
 * on "today" takes it as an argument, because the only case worth
 * testing is the day the period expires.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS THE MOST CONSEQUENTIAL FILE IN THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * **Section 3.** A suit, appeal or application made after the prescribed
 * period *"shall be dismissed, although limitation has not been set up
 * as a defence."*
 *
 * The court raises it **of its own motion**. The other side does not
 * have to plead it. The client's claim is not weakened — it is gone, and
 * it is gone because of a date in a diary.
 *
 * ⚠️ Every other deadline in this product costs money. This one costs a
 * client their case and the firm its indemnity policy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND THE PERIODS LIVE HERE, IN CODE, NOT IN A TABLE
 * ══════════════════════════════════════════════════════════════════════
 * A table of limitation periods is a table somebody can edit — and a
 * three-year period that quietly becomes one is inherited by every
 * matter created afterwards, silently. Here they can be read, argued
 * with, and asserted in a test.
 */

export class LimitationError extends Error {}

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* CIVIL DATE ARITHMETIC                                               */
/* ------------------------------------------------------------------ */

function dayNumber(iso: string): number {
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new LimitationError(`Not a date: ${iso}`);
  return Math.floor(ms / DAY_MS);
}

function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(dayNumber(iso) + days);
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * ⚠️ ADDING YEARS, NOT 365 × n DAYS.
 *
 * A three-year period from 29 February 2024 ends on 28 February 2027,
 * not on 1 March. And 365 × 3 lands a day early in any span containing a
 * leap year — which is the safe direction, but it is still wrong, and
 * "the system said Tuesday" is not a defence to a struck-out suit.
 */
export function addYears(iso: string, years: number): string {
  const parts = iso.slice(0, 10).split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) throw new LimitationError(`Not a date: ${iso}`);

  const targetYear = y + years;
  /** 29 February in a non-leap year clamps to the 28th. */
  const lastDay = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addMonths(iso: string, months: number): string {
  const parts = iso.slice(0, 10).split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) throw new LimitationError(`Not a date: ${iso}`);

  const idx = m - 1 + months;
  const targetYear = y + Math.floor(idx / 12);
  const targetMonth = ((idx % 12) + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* THE ARTICLES                                                        */
/* ------------------------------------------------------------------ */

export type LimitationUnit = "days" | "months" | "years";

export type LimitationArticle = {
  key: string;
  /** How it is cited on a file note. */
  citation: string;
  description: string;
  /** ⚠️ The event the period runs FROM. Getting this wrong is the
   *  commonest error, and it is invisible in the answer. */
  runsFrom: string;
  period: number;
  unit: LimitationUnit;
  /** ⭐ Whether s.18 / s.19 can restart it. Not everything can. */
  extendableByAcknowledgement: boolean;
  note?: string;
};

/**
 * ⭐ A CURATED SET, NOT THE WHOLE SCHEDULE.
 *
 * ⚠️ The Schedule to the Act has 137 Articles. Shipping a partial list
 * as though it were complete is how somebody picks the closest-looking
 * entry for a matter it does not cover. Every entry here is one an
 * Indian practice meets weekly, and the residuary Article 113 is
 * included precisely so there is always a correct answer for anything
 * absent.
 */
export const LIMITATION_ARTICLES: Readonly<Record<string, LimitationArticle>> =
  Object.freeze({
    art_18: {
      key: "art_18",
      citation: "Article 18",
      description: "Price of goods sold and delivered, no fixed period of credit",
      runsFrom: "the date of delivery of the goods",
      period: 3,
      unit: "years",
      extendableByAcknowledgement: true,
    },
    art_19: {
      key: "art_19",
      citation: "Article 19",
      description: "Money payable for money lent",
      runsFrom: "when the loan is made",
      period: 3,
      unit: "years",
      extendableByAcknowledgement: true,
    },
    art_22: {
      key: "art_22",
      citation: "Article 22",
      description: "Money deposited under an agreement, payable on demand",
      runsFrom: "when the demand is made",
      period: 3,
      unit: "years",
      extendableByAcknowledgement: true,
      note: "⚠️ The clock starts on the DEMAND, not on the deposit. A deposit made in 2015 and demanded in 2025 is in time.",
    },
    art_55: {
      key: "art_55",
      citation: "Article 55",
      description: "Compensation for breach of contract",
      runsFrom: "when the contract is broken, or when the breach in a continuing breach ceases",
      period: 3,
      unit: "years",
      extendableByAcknowledgement: true,
    },
    art_58: {
      key: "art_58",
      citation: "Article 58",
      description: "To obtain any other declaration",
      runsFrom: "when the right to sue first accrues",
      period: 3,
      unit: "years",
      extendableByAcknowledgement: false,
      note: "⚠️ FIRST accrues — not the most recent occasion. A recurring grievance does not restart it.",
    },
    art_62: {
      key: "art_62",
      citation: "Article 62",
      description: "To enforce payment of money charged upon immovable property",
      runsFrom: "when the money sued for becomes due",
      period: 12,
      unit: "years",
      extendableByAcknowledgement: true,
    },
    art_65: {
      key: "art_65",
      citation: "Article 65",
      description: "Possession of immovable property based on title",
      runsFrom: "when the possession of the defendant becomes adverse to the plaintiff",
      period: 12,
      unit: "years",
      extendableByAcknowledgement: false,
    },
    art_113: {
      key: "art_113",
      citation: "Article 113",
      description: "Any suit for which no period is provided elsewhere — the residuary",
      runsFrom: "when the right to sue accrues",
      period: 3,
      unit: "years",
      extendableByAcknowledgement: true,
      note: "⭐ Use this when nothing else fits. It is the Schedule's own catch-all, and it is three years.",
    },
    art_116_hc: {
      key: "art_116_hc",
      citation: "Article 116",
      description: "Appeal to a High Court from a decree or order under the CPC",
      runsFrom: "the date of the decree or order",
      period: 90,
      unit: "days",
      extendableByAcknowledgement: false,
      note: "🔴 Section 12(2) excludes the time taken to obtain a certified copy of the decree. Record the application and delivery dates on the matter.",
    },
    art_116_other: {
      key: "art_116_other",
      citation: "Article 116",
      description: "Appeal to any other court from a decree or order under the CPC",
      runsFrom: "the date of the decree or order",
      period: 30,
      unit: "days",
      extendableByAcknowledgement: false,
    },
    art_136: {
      key: "art_136",
      citation: "Article 136",
      description: "Execution of any decree or order of a civil court",
      runsFrom: "when the decree or order becomes enforceable",
      period: 12,
      unit: "years",
      extendableByAcknowledgement: false,
      note: "⚠️ Twelve years, and it is not extendable by acknowledgement — a judgment debtor's promise does not buy a decree-holder more time to execute.",
    },
    art_137: {
      key: "art_137",
      citation: "Article 137",
      description: "Any other application for which no period is provided",
      runsFrom: "when the right to apply accrues",
      period: 3,
      unit: "years",
      extendableByAcknowledgement: false,
    },
    /**
     * ⭐ NOT THE LIMITATION ACT — the Arbitration and Conciliation Act.
     *
     * 🔴 Section 34(3): three months from receipt of the award, plus a
     *    further thirty days if the court is satisfied there was
     *    sufficient cause — **"but not thereafter"**. Those three words
     *    are absolute: s.5 of the Limitation Act does not apply, and no
     *    court can condone a day beyond the thirty.
     */
    arb_34: {
      key: "arb_34",
      citation: "s.34(3), Arbitration and Conciliation Act, 1996",
      description: "Application to set aside an arbitral award",
      runsFrom: "the date the party received the award",
      period: 3,
      unit: "months",
      extendableByAcknowledgement: false,
      note: '🔴 Three months, plus a further thirty days only on sufficient cause — "but not thereafter". That phrase is absolute; nothing beyond the thirty can be condoned.',
    },
  });

/* ------------------------------------------------------------------ */
/* COMPUTING THE DATE                                                  */
/* ------------------------------------------------------------------ */

export type LimitationComputation = {
  articleKey: string;
  citation: string;
  /** Before any court-closure adjustment. */
  rawExpiry: string;
  /** ⭐ The date to diarise, after s.4. */
  expiresOn: string;
  /** True when s.4 pushed it forward. */
  extendedByCourtClosure: boolean;
  /** The plain-language explanation, for the file note. */
  workings: string[];
};

/**
 * ⭐⭐ THE DATE A CLAIM DIES.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SECTION 12(1): THE STARTING DAY IS EXCLUDED
 * ══════════════════════════════════════════════════════════════════════
 * *"In computing the period of limitation for any suit, appeal or
 * application, the day from which such period is to be reckoned, shall
 * be excluded."*
 *
 * ⚠️ So a contract broken on 3 April 2023 gives three years running from
 * **4 April 2023**, expiring on **3 April 2026** — not the 2nd. Software
 * that adds three years to the cause-of-action date and stops is a day
 * short, and it is short in the direction that makes a lawyer file
 * early, which is harmless. Software that adds three years and then adds
 * a day for the exclusion, twice, is a day LATE — and that is a
 * struck-out suit.
 *
 * ⭐ The arithmetic here: exclude the starting day by beginning on the
 * next, then take the period from there, then step back one so the last
 * day is inclusive. It lands on the anniversary, which is the answer
 * every practitioner expects.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SECTION 4: WHEN THE COURT IS SHUT
 * ══════════════════════════════════════════════════════════════════════
 * *"Where the prescribed period expires on a day when the court is
 * closed, the suit, appeal or application may be instituted on the day
 * that the court reopens."*
 *
 * ⚠️ Most software does not do this. It fails in the safe direction —
 * showing a date earlier than the true one — but it also makes the
 * product unable to answer the question a client actually asks, which is
 * whether there is still time.
 */
export function computeLimitation(args: {
  articleKey: string;
  causeOfActionDate: string;
  /** Days on which the relevant court is closed. */
  courtHolidays?: readonly string[];
  /** ⚠️ s.12(2)–(4): days excluded while a certified copy was obtained. */
  excludedDays?: number;
}): LimitationComputation {
  const article = LIMITATION_ARTICLES[args.articleKey];
  if (!article) {
    throw new LimitationError(
      `No limitation period is recorded for "${args.articleKey}". If nothing in the Schedule fits, Article 113 is the residuary — three years from when the right to sue accrues.`,
    );
  }

  const workings: string[] = [];

  /** 🔴 s.12(1) — the starting day is excluded. */
  const startsOn = addDays(args.causeOfActionDate, 1);
  workings.push(
    `${article.citation} runs from ${article.runsFrom}, here ${args.causeOfActionDate}. Section 12(1) excludes that day, so the period runs from ${startsOn}.`,
  );

  let end: string;
  if (article.unit === "years") {
    end = addDays(addYears(startsOn, article.period), -1);
  } else if (article.unit === "months") {
    end = addDays(addMonths(startsOn, article.period), -1);
  } else {
    end = addDays(startsOn, article.period - 1);
  }
  workings.push(
    `${article.period} ${article.unit} from there expires on ${end}.`,
  );

  if (args.excludedDays && args.excludedDays > 0) {
    end = addDays(end, args.excludedDays);
    workings.push(
      `Section 12 excludes a further ${args.excludedDays} day${args.excludedDays === 1 ? "" : "s"} — the time requisite for obtaining a certified copy — carrying it to ${end}.`,
    );
  }

  const rawExpiry = end;

  /** 🔴 s.4 — roll forward to the reopening day. */
  let extendedByCourtClosure = false;
  const holidays = new Set(args.courtHolidays ?? []);
  let guard = 0;
  while (holidays.has(end)) {
    end = addDays(end, 1);
    extendedByCourtClosure = true;
    guard += 1;
    if (guard > 400) {
      throw new LimitationError(
        "The court appears to be closed for more than a year on the calendar recorded. Check the holiday list before relying on this date.",
      );
    }
  }
  if (extendedByCourtClosure) {
    workings.push(
      `🔴 The court is closed on ${rawExpiry}. Section 4 allows filing on the day it reopens, which is ${end}.`,
    );
  }

  return {
    articleKey: article.key,
    citation: article.citation,
    rawExpiry,
    expiresOn: end,
    extendedByCourtClosure,
    workings,
  };
}

/* ------------------------------------------------------------------ */
/* SECTIONS 18 AND 19 — THE FRESH PERIOD                               */
/* ------------------------------------------------------------------ */

export type AcknowledgementResult = {
  accepted: boolean;
  newExpiry: string | null;
  reason: string;
};

/**
 * ⭐⭐ AN ACKNOWLEDGEMENT IN WRITING, OR A PART PAYMENT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A FRESH PERIOD — BUT ONLY IF IT WAS MADE BEFORE EXPIRY
 * ══════════════════════════════════════════════════════════════════════
 * Section 18(1): where an acknowledgement of liability is made in
 * writing and signed **before the expiration of the prescribed period**,
 * a fresh period is computed from the date of the acknowledgement.
 *
 * ⚠️ **THAT IS THE WHOLE TRAP.** An acknowledgement on day 1,094 of a
 * three-year period gives three more years. The same letter on day 1,096
 * gives **nothing** — the right was already dead, and nothing in the Act
 * revives it. The two letters look identical on a file, and the
 * difference is two days nobody was watching.
 *
 * ⚠️ AND NOT EVERY PERIOD CAN BE EXTENDED. Execution of a decree under
 * Article 136 is twelve years and is not extendable — a judgment
 * debtor's promise does not buy a decree-holder more time.
 */
export function applyAcknowledgement(args: {
  articleKey: string;
  currentExpiry: string;
  acknowledgementDate: string;
  courtHolidays?: readonly string[];
}): AcknowledgementResult {
  const article = LIMITATION_ARTICLES[args.articleKey];
  if (!article) {
    throw new LimitationError(`Unknown limitation article: ${args.articleKey}`);
  }

  if (!article.extendableByAcknowledgement) {
    return {
      accepted: false,
      newExpiry: null,
      reason: `${article.citation} is not extended by an acknowledgement. ${article.note ?? "Sections 18 and 19 do not reach this period."}`,
    };
  }

  /** 🔴 "Before the expiration" — on the last day still counts. */
  if (args.acknowledgementDate > args.currentExpiry) {
    return {
      accepted: false,
      newExpiry: null,
      reason: `🔴 This is dated ${args.acknowledgementDate} and the period expired on ${args.currentExpiry}. Section 18 starts a fresh period only where the acknowledgement was made before the period ran out. Nothing in the Act revives a right that has already died — this is evidence of a moral obligation and of nothing else.`,
    };
  }

  /**
   * ⭐ THE FRESH PERIOD RUNS FROM THE ACKNOWLEDGEMENT, and s.12(1)
   * excludes that day too — the same rule, applied again.
   */
  const fresh = computeLimitation({
    articleKey: args.articleKey,
    causeOfActionDate: args.acknowledgementDate,
    ...(args.courtHolidays ? { courtHolidays: args.courtHolidays } : {}),
  });

  return {
    accepted: true,
    newExpiry: fresh.expiresOn,
    reason: `Acknowledged on ${args.acknowledgementDate}, before the period expired on ${args.currentExpiry}. Section 18 gives a fresh ${article.period} ${article.unit} running from that date, so the new expiry is ${fresh.expiresOn}.`,
  };
}

/* ------------------------------------------------------------------ */
/* THE COMPOUND DEADLINE NOBODY GETS RIGHT                             */
/* ------------------------------------------------------------------ */

export type ChequeDeadlines = {
  noticeDueBy: string;
  drawerPayBy: string | null;
  causeOfActionOn: string | null;
  complaintDueBy: string | null;
  workings: string[];
};

/**
 * ⭐⭐ SECTION 138 OF THE NEGOTIABLE INSTRUMENTS ACT — THREE DEADLINES
 *      IN A ROW, AND EACH ONE STARTS THE NEXT.
 *
 * ① The payee must give **written notice within 30 days** of receiving
 *    information from the bank that the cheque was dishonoured.
 * ② The drawer then has **15 days** from receiving that notice to pay.
 * ③ If he does not, the cause of action arises on the 16th day — and the
 *    complaint must be filed **within one month** of it.
 *
 * 🔴 THE FAILURE IS ALWAYS THE SAME: the 30 days is counted from the
 *    cheque date rather than from the bank's memo, or the one month is
 *    counted from the notice rather than from the expiry of the fifteen
 *    days. Both put the complaint outside time on a claim that was
 *    perfectly good.
 *
 * ⚠️ AND IF THE DRAWER PAYS INSIDE THE FIFTEEN DAYS THERE IS NO OFFENCE
 * AT ALL. The cause of action never arises, which is why it is returned
 * as null rather than as a date somebody might diarise.
 */
export function chequeDishonourDeadlines(args: {
  /** The date the bank's return memo was received. Not the cheque date. */
  dishonourInformedOn: string;
  /** When the statutory notice was actually served, if it has been. */
  noticeServedOn?: string | null;
  /** True if the drawer paid within the fifteen days. */
  paidWithinNoticePeriod?: boolean;
}): ChequeDeadlines {
  const workings: string[] = [];

  const noticeDueBy = addDays(args.dishonourInformedOn, 30);
  workings.push(
    `The bank's memo was received on ${args.dishonourInformedOn}. Written notice must be given within 30 days — by ${noticeDueBy}.`,
  );

  if (!args.noticeServedOn) {
    return {
      noticeDueBy,
      drawerPayBy: null,
      causeOfActionOn: null,
      complaintDueBy: null,
      workings: [
        ...workings,
        "⚠️ No notice has been served yet, so nothing further has started running. Everything after this depends on the date the drawer receives it.",
      ],
    };
  }

  const drawerPayBy = addDays(args.noticeServedOn, 15);
  workings.push(
    `Notice served on ${args.noticeServedOn}. The drawer has 15 days to pay — until ${drawerPayBy}.`,
  );

  if (args.paidWithinNoticePeriod) {
    return {
      noticeDueBy,
      drawerPayBy,
      causeOfActionOn: null,
      complaintDueBy: null,
      workings: [
        ...workings,
        "⭐ The drawer paid inside the fifteen days, so no offence was committed and no cause of action ever arose. There is nothing to diarise.",
      ],
    };
  }

  /** 🔴 The cause of action arises on the day AFTER the fifteen expire. */
  const causeOfActionOn = addDays(drawerPayBy, 1);
  const complaintDueBy = addMonths(causeOfActionOn, 1);
  workings.push(
    `🔴 The cause of action arises on ${causeOfActionOn} — the day after the fifteen days expire, not the day the notice was sent.`,
    `The complaint must be filed within one month of that, by ${complaintDueBy}.`,
  );

  return { noticeDueBy, drawerPayBy, causeOfActionOn, complaintDueBy, workings };
}

/* ------------------------------------------------------------------ */
/* WHAT THE SCREEN SAYS                                                */
/* ------------------------------------------------------------------ */

export type LimitationHealth = {
  tone: "ok" | "warn" | "danger" | "expired" | "unknown";
  label: string;
  detail: string;
  daysLeft: number | null;
};

/**
 * ⭐ HOW MUCH TIME IS LEFT, AND WHAT TO DO ABOUT IT.
 *
 * 🔴 A MATTER WITH NO LIMITATION DATE IS ITS OWN ALARM, and it is the
 *    most dangerous row on the list — not because the date is close, but
 *    because the matter will never appear on the report that would have
 *    saved it.
 *
 * ⚠️ AND THE LAST DAY IS A FULL DAY. A period expiring today can still
 * be filed today. Showing it as expired sends somebody home.
 */
export function limitationHealth(args: {
  expiresOn: string | null;
  today: string;
  /** Below this, it is urgent. Firms differ; 90 days is a common default. */
  warnDays?: number;
}): LimitationHealth {
  if (!args.expiresOn) {
    return {
      tone: "unknown",
      label: "No limitation date",
      detail:
        "🔴 Nothing computes a deadline for this matter, so it will never appear on the report that would have caught it. Record the cause-of-action date and the Article.",
      daysLeft: null,
    };
  }

  const daysLeft = daysBetween(args.today, args.expiresOn);
  const warn = args.warnDays ?? 90;

  if (daysLeft < 0) {
    return {
      tone: "expired",
      label: `Time-barred ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} ago`,
      detail:
        "🔴 The period has run. Under section 3 the court must dismiss a suit filed now even if the other side never pleads limitation. If there is a ground for condonation under section 5, it has to be applied for and proved — it is not automatic.",
      daysLeft,
    };
  }
  if (daysLeft === 0) {
    return {
      tone: "danger",
      /** ⚠️ Today is still a filing day. */
      label: "Expires today",
      detail: "It can still be filed today. Not tomorrow.",
      daysLeft,
    };
  }
  if (daysLeft <= 30) {
    return {
      tone: "danger",
      label: `${daysLeft} days left`,
      detail:
        "Papers, court fee and vakalatnama all have to be ready before this date, not on it.",
      daysLeft,
    };
  }
  if (daysLeft <= warn) {
    return {
      tone: "warn",
      label: `${daysLeft} days left`,
      detail: "Inside the review window. Confirm the client's instructions are current.",
      daysLeft,
    };
  }
  return {
    tone: "ok",
    label: `${daysLeft} days left`,
    detail: "In time.",
    daysLeft,
  };
}
