/**
 * ⭐⭐⭐ FRONT OFFICE, BATCH 10 — ORDER RHYTHM AND AUTOMATION EVENTS.
 *
 * 🔴 THE FIVE FAILURES THIS SUITE PINS DOWN.
 *
 *   ① Predicting for everybody. The salesman rings four people who were
 *      not due, gets four polite refusals, and stops opening the screen.
 *      After that the feature is worse than nothing, because it occupies
 *      the place where a real one would go.
 *
 *   ② A mean instead of a median. One bulk order before a price rise
 *      drags it far enough to make every prediction wrong.
 *
 *   ③ Measuring "stopped" against the calendar instead of against the
 *      customer's own gap. Ninety days is far too patient for a weekly
 *      customer and far too twitchy for a quarterly one.
 *
 *   ④ A nightly job that re-raises the same signal every night. Five
 *      tasks, and the feature is switched off on the third day.
 *
 *   ⑤ A prediction nobody scores, which is astrology.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DUE_NOW_DAYS,
  LAPSED_MULTIPLE,
  MAX_RELATIVE_SPREAD,
  MIN_ORDERS_FOR_RHYTHM,
  addDays,
  compareSignals,
  confidenceOf,
  daysBetween,
  detectRhythm,
  driftOf,
  median,
  medianAbsoluteDeviation,
  signalFrom,
  type Signal,
} from "@/lib/patterns/rhythm";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0068_order_rhythm.sql");
const SQL_CODE = sqlCode(SQL);
const ACTION = read("server/actions/rhythms.ts");
const PAGE = read("app/(crm)/rhythms/page.tsx");

const TODAY = "2026-08-13";

/** Monthly orders, dead regular, ending `daysAgo` before today. */
function monthly(count: number, daysAgo = 0): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    out.push(addDays(TODAY, -(daysAgo + i * 30)));
  }
  return out;
}

/* ================================================================== */
/* ⭐⭐⭐ ① IT REFUSES MORE OFTEN THAN IT PREDICTS                     */
/* ================================================================== */

describe("⭐⭐ what it will not predict", () => {
  /**
   * 🔴 TWO ORDERS IS ONE GAP, AND ONE GAP IS A COINCIDENCE. Three
   * orders is two gaps, and the middle of two numbers is their average
   * again, which defeats the entire reason for using a median.
   */
  it("refuses to predict from fewer than four orders", () => {
    expect(MIN_ORDERS_FOR_RHYTHM).toBe(4);
    for (const n of [2, 3]) {
      const r = detectRhythm(monthly(n), TODAY);
      expect(r.verdict).toBe("too_few_orders");
      expect(r.expectedNextOn).toBeNull();
    }
    expect(detectRhythm(monthly(4), TODAY).verdict).toBe("regular");
  });

  /**
   * ⭐ ONE ORDER IS NOT A BAD PATTERN, IT IS A DIFFERENT CUSTOMER, and
   * burying it in "not enough data" hides a real and actionable
   * category.
   */
  it("calls a single order what it is", () => {
    const r = detectRhythm(["2025-01-05"], TODAY);
    expect(r.verdict).toBe("one_off");
    expect(r.explanation).toContain("never came back");
  });

  it("says so when there are no orders at all", () => {
    expect(detectRhythm([], TODAY).verdict).toBe("too_few_orders");
  });

  /**
   * 🔴 IF THE GAPS SWING BY MORE THAN HALF THE TYPICAL GAP THERE IS NO
   * RHYTHM. Pretending otherwise produces a call list of guesses.
   */
  it("refuses a customer whose gaps swing wildly", () => {
    const erratic = ["2025-01-01", "2025-01-10", "2025-04-01", "2025-04-20", "2025-08-01"];
    const r = detectRhythm(erratic, TODAY);
    expect(r.verdict).toBe("irregular");
    expect(r.expectedNextOn).toBeNull();
    // ⚠️ And it explains in their numbers, not in statistics.
    expect(r.explanation).toContain("swing by about");
    expect(r.explanation).toContain("run out");
  });

  it("keeps the spread threshold at half the gap", () => {
    expect(MAX_RELATIVE_SPREAD).toBe(0.5);
  });

  /**
   * ⚠️ TWO INVOICES THE SAME MORNING ARE ONE ORDER. Counting both
   * invents a zero-day gap that halves the median.
   */
  it("collapses two invoices on the same day", () => {
    const dates = [...monthly(5), monthly(5)[2] as string];
    const r = detectRhythm(dates, TODAY);
    expect(r.orderCount).toBe(5);
    expect(r.medianGapDays).toBe(30);
  });

  /** 🔴 And the database refuses a date on anything but a regular rhythm. */
  it("refuses a predicted date from a non-regular verdict", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT customer_rhythms_only_regular_predicts CHECK ( verdict = 'regular' OR expected_next_on IS NULL )",
    );
  });

  it("refuses a prediction with no honest window", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT customer_rhythms_prediction_has_a_window",
    );
  });

  it("refuses a regular verdict without the history it claims", () => {
    expect(flat(SQL_CODE)).toContain(
      "verdict <> 'regular' OR (order_count >= 4 AND median_gap_days IS NOT NULL)",
    );
  });

  /**
   * ⭐ THE REFUSALS ARE STORED AND SHOWN. A screen showing only the
   * confident rows makes a business look like it has forty customers
   * when it has four hundred.
   */
  it("shows the customers it will not predict for", () => {
    expect(PAGE).toContain("What Ordence will not predict");
    expect(flat(PAGE)).toContain("order when they run out");
  });
});

/* ================================================================== */
/* ⭐⭐ ② MEDIAN, NOT MEAN, EVERYWHERE                                 */
/* ================================================================== */

describe("⭐⭐ robust arithmetic", () => {
  it("takes a median", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  /**
   * 🔴 ONE BULK ORDER BEFORE A PRICE RISE WOULD DRAG A MEAN far enough
   * to make every prediction wrong.
   */
  it("survives one wild gap that would wreck an average", () => {
    const gaps = [30, 30, 31, 29, 30, 400];
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(Math.round(mean)).toBe(92);
    expect(median(gaps)).toBe(30);
  });

  /**
   * ⭐ MEDIAN ABSOLUTE DEVIATION, NOT STANDARD DEVIATION. Pairing a
   * robust centre with a fragile spread is what makes a model look
   * stable and behave erratically.
   */
  it("measures the spread robustly too", () => {
    expect(medianAbsoluteDeviation([30, 30, 30, 30])).toBe(0);
    expect(medianAbsoluteDeviation([28, 30, 32, 30])).toBe(1);
    // ⚠️ The same outlier that would blow up a standard deviation.
    expect(medianAbsoluteDeviation([30, 30, 31, 29, 30, 400])).toBeLessThan(2);
  });

  it("counts whole days between civil dates", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(addDays("2026-08-13", 30)).toBe("2026-09-12");
  });

  /**
   * ⭐⭐ ARE THEIR GAPS GETTING LONGER? A customer drifting from 30 days
   * to 45 over a year is leaving slowly, and never appears on an overdue
   * report because each order is on time against a rhythm that is itself
   * decaying.
   */
  it("spots a customer who is slowing down", () => {
    expect(driftOf([28, 30, 29, 44, 46, 48])).toBe("slowing");
    expect(driftOf([46, 48, 44, 29, 30, 28])).toBe("quickening");
    expect(driftOf([30, 31, 29, 30, 31, 29])).toBe("steady");
  });

  /** ⚠️ Below a fifth either way is noise, and noise called a trend loses the reader. */
  it("does not call a small wobble a trend", () => {
    expect(driftOf([30, 30, 30, 33, 33, 33])).toBe("steady");
  });

  it("says nothing about drift from too few gaps", () => {
    expect(driftOf([30, 31])).toBe("unknown");
  });
});

/* ================================================================== */
/* ⭐⭐ ③ STOPPED IS MEASURED AGAINST THEIR OWN GAP                    */
/* ================================================================== */

describe("⭐⭐ the customer who has stopped", () => {
  /**
   * 🔴 A FIXED NINETY DAYS IS WRONG IN BOTH DIRECTIONS. Far too patient
   * for a weekly customer, far too twitchy for a quarterly one.
   */
  it("uses three times the customer's own gap", () => {
    expect(LAPSED_MULTIPLE).toBe(3);

    // Weekly customer, silent for a month: gone.
    const weekly = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"];
    expect(detectRhythm(weekly, TODAY).verdict).toBe("lapsed");

    // Quarterly customer, silent for a month: perfectly normal.
    const quarterly = ["2025-05-01", "2025-08-01", "2025-11-01", "2026-02-01", "2026-05-01"];
    expect(detectRhythm(quarterly, "2026-06-01").verdict).toBe("regular");
  });

  /** ⚠️ The explanation says why this line matters most. */
  it("says nothing else in an ERP reports an absence", () => {
    const r = detectRhythm(monthly(6, 120), TODAY);
    expect(r.verdict).toBe("lapsed");
    expect(r.explanation).toContain("quietly stopped");
  });

  /**
   * 🔴🔴 REPORTED EVEN AT LOW CONFIDENCE, and it is the only case that
   * is. Confidence measures how well we can predict their NEXT order;
   * somebody who has stopped has no next order, so a low score is
   * expected and is not a reason to stay quiet.
   */
  it("reports a lapse whatever the confidence", () => {
    const r = detectRhythm(monthly(6, 200), TODAY);
    expect(r.confidence).toBeLessThan(25);
    const s = signalFrom(r, TODAY, "Shah Traders", { minConfidence: 25 });
    expect(s?.kind).toBe("lapsed");
    expect(s?.priority).toBe("urgent");
  });

  /**
   * 🔴 AND IT SORTS ABOVE EVERYTHING. Not by confidence: the most
   * confident row is a customer about to order anyway, and ringing them
   * changes nothing.
   */
  it("puts the lapsed customer above the confident one", () => {
    const lapsed: Signal = {
      kind: "lapsed", dueOn: TODAY, daysOut: 0, confidence: 5,
      headline: "", detail: "", priority: "urgent",
    };
    const dueNow: Signal = {
      kind: "due_now", dueOn: TODAY, daysOut: 0, confidence: 95,
      headline: "", detail: "", priority: "high",
    };
    expect([dueNow, lapsed].sort(compareSignals)[0]?.kind).toBe("lapsed");
  });

  it("gives the lapsed query its own index", () => {
    expect(flat(SQL_CODE)).toContain(
      "CREATE INDEX IF NOT EXISTS customer_rhythms_lapsed_idx",
    );
  });

  /** ⭐ And the screen puts it first. */
  it("leads the screen with who has stopped", () => {
    expect(PAGE.indexOf("who have stopped")).toBeLessThan(
      PAGE.indexOf("Likely to order"),
    );
  });
});

/* ================================================================== */
/* ⭐ THE SIGNAL                                                       */
/* ================================================================== */

describe("⭐ what becomes a signal", () => {
  it("says a regular customer is due today", () => {
    const r = detectRhythm(monthly(8, 30), TODAY);
    expect(r.verdict).toBe("regular");
    const s = signalFrom(r, TODAY, "Kumar Industries");
    expect(s?.kind).toBe("due_now");
    expect(s?.headline).toContain("likely to order today");
  });

  it("keeps the due-now window tight", () => {
    expect(DUE_NOW_DAYS).toBe(2);
  });

  /**
   * 🔴 OVERDUE IS MEASURED AGAINST THEIR OWN WINDOW. A customer who
   * varies by five days is not late on day one.
   */
  it("does not call somebody late inside their own window", () => {
    const wobbly = ["2026-01-01", "2026-02-05", "2026-03-02", "2026-04-06", "2026-05-02"];
    const r = detectRhythm(wobbly, "2026-06-06");
    if (r.verdict === "regular") {
      const s = signalFrom(r, "2026-06-06", "X");
      expect(s?.kind).not.toBe("overdue");
    }
  });

  /** ⚠️ Nothing to say about somebody mid-cycle. */
  it("says nothing at all about a customer in the middle of their cycle", () => {
    const r = detectRhythm(monthly(8, 15), TODAY);
    expect(signalFrom(r, TODAY, "X")).toBeNull();
  });

  it("says nothing for an irregular customer", () => {
    const r = detectRhythm(
      ["2025-01-01", "2025-01-10", "2025-04-01", "2025-04-20", "2025-08-01"],
      TODAY,
    );
    expect(signalFrom(r, TODAY, "X")).toBeNull();
  });

  it("says nothing below the confidence floor", () => {
    const r = detectRhythm(monthly(8, 30), TODAY);
    expect(signalFrom(r, TODAY, "X", { minConfidence: 99 })).toBeNull();
  });
});

/* ================================================================== */
/* ⭐⭐ CONFIDENCE IS HARD TO GET HIGH                                 */
/* ================================================================== */

describe("⭐⭐ confidence", () => {
  /**
   * 🔴 MULTIPLIED, NOT AVERAGED. Any one of history, tightness and
   * freshness being poor should sink the answer; an average lets two
   * good numbers hide a fatal one.
   */
  it("sinks on any one bad component", () => {
    const perfect = confidenceOf({
      orderCount: 20, relativeSpread: 0, daysSinceLast: 0, medianGap: 30,
    });
    expect(perfect).toBeGreaterThan(90);

    // Long history, tight gaps, but they last ordered two cycles ago.
    const stale = confidenceOf({
      orderCount: 20, relativeSpread: 0, daysSinceLast: 60, medianGap: 30,
    });
    expect(stale).toBeLessThan(50);

    // Fresh and tight, but only just enough orders.
    const thin = confidenceOf({
      orderCount: 4, relativeSpread: 0, daysSinceLast: 0, medianGap: 30,
    });
    expect(thin).toBeLessThan(30);
  });

  /** ⚠️ A number that reads 90% for everybody is a number nobody reads. */
  it("does not hand out a high score for a short history", () => {
    expect(
      confidenceOf({ orderCount: 5, relativeSpread: 0.2, daysSinceLast: 5, medianGap: 30 }),
    ).toBeLessThan(40);
  });

  it("stays inside 0 and 100, and the database insists", () => {
    expect(flat(SQL_CODE)).toContain("confidence BETWEEN 0 AND 100");
  });
});

/* ================================================================== */
/* ⭐⭐ ④ RAISED ONCE, NOT EVERY NIGHT                                 */
/* ================================================================== */

describe("⭐⭐ surviving a scheduler", () => {
  /**
   * 🔴 FIVE NIGHTS, FIVE TASKS, AND THE FEATURE IS SWITCHED OFF ON THE
   * THIRD DAY.
   */
  it("refuses the same signal twice for the same occurrence", () => {
    expect(flat(SQL_CODE)).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS rhythm_signals_once ON rhythm_signals (tenant_id, subject_type, subject_id, kind, occurrence)",
    );
  });

  /**
   * ⭐ THE OCCURRENCE IS THE EXPECTED DATE FOR A DUE SIGNAL AND THE
   * MONTH FOR A LAPSE, so a nightly job re-raises nothing.
   */
  it("keys a lapse by month and a due signal by its date", () => {
    expect(ACTION).toContain('signal.kind === "lapsed" ? today.slice(0, 7) : signal.dueOn');
  });

  it("inserts on conflict do nothing rather than checking first", () => {
    expect(ACTION).toContain("onConflictDoNothing");
  });

  /**
   * 🔴🔴 AND A SIGNAL BECOMES A TASK. A prediction on a screen is a
   * prediction nobody acts on; this business already has reports.
   */
  it("turns a signal into a task with today's date", () => {
    expect(ACTION).toContain(".insert(tasks)");
    expect(ACTION).toContain("dueOn: today");
  });
});

/* ================================================================== */
/* ⭐⭐ ⑤ A PREDICTION NOBODY SCORES IS ASTROLOGY                      */
/* ================================================================== */

describe("⭐⭐ scoring", () => {
  it("records what actually happened next", () => {
    expect(flat(SQL_CODE)).toContain(
      "outcome IS NULL OR outcome IN ('ordered', 'no_order', 'dismissed')",
    );
  });

  /** ⚠️ Scoring against a record somebody edited afterwards measures nothing. */
  it("refuses to change what was predicted", () => {
    expect(flat(SQL_CODE)).toContain("IF NEW.kind IS DISTINCT FROM OLD.kind");
    expect(SQL_CODE).toContain("measures nothing");
  });

  /** 🔴 Re-scoring until it looks right is the oldest trick there is. */
  it("refuses to score the same prediction twice", () => {
    expect(flat(SQL_CODE)).toContain(
      "IF OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN",
    );
  });

  /**
   * ⭐ `dismissed` COUNTS NEITHER WAY. Somebody closing a card without
   * looking is not evidence, and counting it as a miss would make an
   * honest feature look broken.
   */
  it("excludes a dismissal from the scoreboard", () => {
    expect(ACTION).toContain("outcome IN ('ordered', 'no_order')");
  });

  /** 🔴 And the screen says plainly when it has earned nothing yet. */
  it("admits it has no track record until it has one", () => {
    expect(flat(PAGE)).toContain("asking you to trust it on nothing");
  });

  it("says so when the predictions are worse than useful", () => {
    expect(flat(PAGE)).toContain("worse than useful");
  });
});

/* ================================================================== */
/* ⭐⭐ THE ENGINE THAT NEVER RECEIVED AN EVENT                        */
/* ================================================================== */

describe("⭐⭐ automation events", () => {
  /**
   * 🔴 `workflows` HAS HAD TRIGGERS, CONDITIONS, AN EXECUTOR, A RUN LOG
   * AND A SCREEN SINCE v0.7x, and the only way to start one is a person
   * pressing "run now".
   */
  it("names the vocabulary the existing engine already uses", () => {
    expect(flat(SQL_CODE)).toContain(
      "trigger_type IN ('record_created', 'record_updated', 'record_deleted', 'webhook')",
    );
  });

  /**
   * ⭐ A TABLE RATHER THAN A DIRECT CALL. A trigger that invoked a
   * workflow inline would run somebody's HTTP step inside the
   * transaction that created an invoice, and a slow endpoint would hold
   * a lock on the ledger.
   */
  it("queues rather than calling the executor inline", () => {
    expect(flat(SQL)).toContain("hold a lock on the ledger");
    expect(flat(SQL_CODE)).toContain(
      "CREATE INDEX IF NOT EXISTS automation_events_pending_idx",
    );
  });

  /**
   * 🔴🔴 THE LOOP BRAKE. Workflow A updates a lead, which raises
   * `record_updated`, which runs workflow A. `watchFields` is the right
   * first defence and it depends on the author scoping their trigger —
   * and the author who did not is exactly the author who needs a brake.
   */
  it("refuses twenty events on one record in a minute", () => {
    expect(SQL_CODE).toContain("FUNCTION ordence_guard_automation_storm");
    expect(SQL_CODE).toContain("IF v_recent >= 20 THEN");
    expect(SQL_CODE).toContain("That is a loop, not a business process");
  });

  /** ⭐ And it names the record, so the loop can be found. */
  it("names the record in the refusal", () => {
    expect(SQL_CODE).toContain("NEW.record_id, NEW.record_type");
  });

  /** 🔴 DPDP again: an event carries somebody's data. */
  it("gives every event a deletion date", () => {
    expect(flat(SQL_CODE)).toContain("purge_after date NOT NULL");
  });
});

describe("⭐ 0068's own rules", () => {
  /**
   * 🔴🔴 A PREDICTION SOMEBODY CAN OVERRIDE IS A PREDICTION NOBODY CAN
   * TRUST. Six months later nothing says which rows were arithmetic and
   * which were an optimistic salesman.
   */
  it("refuses a hand edit of a derived row", () => {
    expect(SQL_CODE).toContain("FUNCTION ordence_guard_rhythm");
    expect(SQL_CODE).toContain(
      "IF NEW.computed_at IS NOT DISTINCT FROM OLD.computed_at THEN",
    );
    expect(SQL_CODE).toContain("which rows were arithmetic and which were opinion");
  });

  /** ⚠️ A pattern built on drafts predicts things that will not happen. */
  it("builds the pattern only from invoices that were actually raised", () => {
    expect(ACTION).toContain("i.status IN ('issued', 'part_paid', 'paid')");
  });

  it("puts platform scope in USING and never in WITH CHECK", () => {
    const policies = SQL_CODE.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(3);
    for (const p of policies) {
      expect(p.slice(p.indexOf("WITH CHECK"))).not.toContain("app_platform_scope");
    }
  });
});
