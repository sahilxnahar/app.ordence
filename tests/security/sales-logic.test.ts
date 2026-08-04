/**
 * Ordence — Sales Domain Logic
 * Version: v0.22.0-alpha
 *
 * Pure functions only. No database, no fixtures, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE ARITHMETIC TESTS ARE THE SERIOUS ONES HERE
 * ══════════════════════════════════════════════════════════════════════
 * The isolation tests next door prove the database refuses what it must.
 * These prove the numbers are right — and the numbers in this phase are
 * ones an outsider checks with a calculator:
 *
 *   • A payment plan's milestones must sum to the agreement value
 *     EXACTLY. Short by ₹1 and the account never closes; over by ₹1 and
 *     you have demanded more than the contract says.
 *   • A broker's commission is audited by the broker, the same
 *     afternoon, every time.
 *
 * `bigint` throughout, and every assertion uses `n` literals. A single
 * `Number()` in this file would make it pass while the product is wrong.
 */

import { describe, it, expect } from "vitest";
import {
  canTransition,
  scoreLead,
  followUpUrgency,
  isCivilCallingHour,
  localHourFor,
  consentStatus,
  stageIndex,
  PIPELINE_STAGES,
  STALE_AFTER_DAYS,
} from "@/lib/sales/pipeline";
import {
  canHold,
  canBook,
  isHoldLive,
  resolveHoldPolicy,
  holdExpiryFor,
  summariseAvailability,
  isBookingCollision,
  describeBookingCollision,
} from "@/lib/sales/inventory";
import {
  computeCommission,
  computeTds,
  canAttribute,
  cpLockExpiry,
  resolveCpLockDays,
  TDS_194H_BPS,
  TDS_NO_PAN_BPS,
} from "@/lib/sales/commission";
import {
  buildPlan,
  validateTemplate,
  templateFor,
  summarisePlan,
  deriveMilestoneStatus,
  PLAN_TEMPLATES,
  FULL_BPS,
} from "@/lib/sales/payment-plan";

const NOW = new Date("2026-08-01T10:00:00+05:30");

/* ================================================================== */
/* PIPELINE                                                            */
/* ================================================================== */

describe("lead transitions", () => {
  it("allows moving forward, backward and skipping stages", async () => {
    // ⚠️ THE PERMISSIVE CASE IS THE ONE WORTH ASSERTING. A pipeline that
    // enforces a strict march makes reps record fiction, and every
    // forecast built on the data is then fiction too.
    const moves: [string, string][] = [
      ["new", "negotiation"],
      ["site_visit", "contacted"],
      ["qualified", "booked"],
    ];

    for (const [from, to] of moves) {
      const verdict = canTransition({
        from: from as never,
        to: to as never,
        hasLiveBooking: false,
      });
      expect(verdict.allowed, `${from} → ${to}`).toBe(true);
    }
  });

  it("refuses `won` without a booking", () => {
    const verdict = canTransition({
      from: "negotiation",
      to: "won",
      hasLiveBooking: false,
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.remedy).toMatch(/booking/i);
    }
  });

  it("allows `won` once a booking exists", () => {
    const verdict = canTransition({
      from: "booked",
      to: "won",
      hasLiveBooking: true,
    });
    expect(verdict.allowed).toBe(true);
  });

  it("refuses `lost` without a reason and accepts it with one", () => {
    expect(
      canTransition({ from: "qualified", to: "lost", hasLiveBooking: false }).allowed,
    ).toBe(false);

    // Whitespace is not a reason.
    expect(
      canTransition({
        from: "qualified",
        to: "lost",
        hasLiveBooking: false,
        lostReason: "   ",
      }).allowed,
    ).toBe(false);

    expect(
      canTransition({
        from: "qualified",
        to: "lost",
        hasLiveBooking: false,
        lostReason: "Bought elsewhere",
      }).allowed,
    ).toBe(true);
  });

  it("refuses moving a booked lead backwards while a booking is live", () => {
    const verdict = canTransition({
      from: "booked",
      to: "contacted",
      hasLiveBooking: true,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("treats a no-op transition as allowed", () => {
    expect(
      canTransition({ from: "qualified", to: "qualified", hasLiveBooking: true }).allowed,
    ).toBe(true);
  });

  it("puts the pipeline stages in a stable order and excludes the outcomes", () => {
    expect(stageIndex("new")).toBe(0);
    expect(stageIndex("booked")).toBe(PIPELINE_STAGES.length - 1);
    // ⚠️ won/lost are outcomes, not columns. A board that rendered them
    // would grow two columns holding every lead the company ever had.
    expect(stageIndex("won")).toBe(-1);
    expect(stageIndex("lost")).toBe(-1);
  });
});

describe("lead scoring", () => {
  it("is deterministic — same input, same score", () => {
    const lead = {
      source: "walk_in" as const,
      status: "site_visit" as const,
      temperature: "hot" as const,
      phone: "+919000000000",
      email: "buyer@example.com",
      budgetMinMinor: 5_000_000n,
      budgetMaxMinor: 9_000_000n,
      projectId: "p1",
      consentAt: NOW,
    };
    expect(scoreLead(lead)).toBe(scoreLead(lead));
  });

  it("never exceeds 100, which is the database CHECK bound", () => {
    // ⚠️ If this clamp were missing, the maximal lead would be rejected
    // by `leads_score_sane` — the best lead in the workspace would be
    // the one that could not be saved.
    const maximal = scoreLead({
      source: "walk_in",
      status: "booked",
      temperature: "hot",
      phone: "+919000000000",
      email: "buyer@example.com",
      budgetMinMinor: 1n,
      budgetMaxMinor: 2n,
      projectId: "p1",
      consentAt: NOW,
    });
    expect(maximal).toBeLessThanOrEqual(100);
    expect(maximal).toBeGreaterThan(0);
  });

  it("scores a lost lead zero", () => {
    expect(
      scoreLead({
        source: "walk_in",
        status: "lost",
        temperature: "hot",
        phone: "+919000000000",
        consentAt: NOW,
      }),
    ).toBe(0);
  });

  it("ranks a reachable lead above an unreachable one", () => {
    const reachable = scoreLead({
      source: "website",
      status: "contacted",
      temperature: "warm",
      phone: "+919000000000",
    });
    const unreachable = scoreLead({
      source: "website",
      status: "contacted",
      temperature: "warm",
    });
    expect(reachable).toBeGreaterThan(unreachable);
  });
});

describe("follow-up urgency", () => {
  it("separates due, overdue and stale", () => {
    const day = 86_400_000;
    expect(followUpUrgency(null, NOW)).toBe("none");
    expect(followUpUrgency(new Date(NOW.getTime() + day), NOW)).toBe("scheduled");
    expect(followUpUrgency(new Date(NOW.getTime() - 1000), NOW)).toBe("due");
    expect(followUpUrgency(new Date(NOW.getTime() - 3 * day), NOW)).toBe("overdue");
    // ⚠️ `stale` is a separate rung because it needs a different
    // response: three weeks late is an abandoned lead, not a late call.
    expect(
      followUpUrgency(new Date(NOW.getTime() - (STALE_AFTER_DAYS + 1) * day), NOW),
    ).toBe("stale");
  });
});

describe("NRI calling windows", () => {
  it("knows that 10am in India is the middle of the night in New Jersey", () => {
    // 10:00 IST on 1 Aug 2026 = 00:30 EDT.
    expect(localHourFor("America/New_York", NOW)).toBe(0);
    expect(isCivilCallingHour("America/New_York", NOW)).toBe(false);
    expect(isCivilCallingHour("Asia/Kolkata", NOW)).toBe(true);
  });

  it("returns null rather than 'go ahead' for an unknown timezone", () => {
    // ⚠️ Fails to UNKNOWN, not to permitted. A garbled timezone string
    // must not read as "fine to call at 2am".
    expect(isCivilCallingHour("Mars/Olympus_Mons", NOW)).toBeNull();
    expect(isCivilCallingHour(null, NOW)).toBeNull();
  });
});

describe("DPDP consent", () => {
  it("requires both a date and a source to count as evidence", () => {
    expect(consentStatus({ consentAt: NOW, consentSource: "Website form" }).hasEvidence).toBe(
      true,
    );
    expect(consentStatus({ consentAt: NOW }).hasEvidence).toBe(false);
    expect(consentStatus({}).hasEvidence).toBe(false);
  });
});

/* ================================================================== */
/* INVENTORY                                                           */
/* ================================================================== */

describe("hold policy", () => {
  it("clamps absurd settings rather than trusting the form", () => {
    // A tenant admin typing 3650 should get a year, not a decade of
    // frozen inventory.
    const policy = resolveHoldPolicy({ defaultDays: 900, maxDays: 3650 });
    expect(policy.maxDays).toBe(365);
    expect(policy.defaultDays).toBeLessThanOrEqual(policy.maxDays);
  });

  it("never produces a default longer than the maximum", () => {
    const policy = resolveHoldPolicy({ defaultDays: 60, maxDays: 7 });
    expect(policy.defaultDays).toBeLessThanOrEqual(7);
  });

  it("caps the requested hold length at the policy maximum", () => {
    const policy = resolveHoldPolicy({ defaultDays: 7, maxDays: 14 });
    const expiry = holdExpiryFor(NOW, 90, policy);
    const days = (expiry.getTime() - NOW.getTime()) / 86_400_000;
    expect(days).toBe(14);
  });
});

describe("unit availability", () => {
  const base = { code: "A-1203", status: "available" as const };

  it("permits holding and booking a free unit", () => {
    expect(canHold(base, "lead-1", NOW).allowed).toBe(true);
    expect(canBook(base, "lead-1", NOW).allowed).toBe(true);
  });

  it("refuses a blocked unit and says a block does not expire", () => {
    const verdict = canHold({ ...base, status: "blocked" }, "lead-1", NOW);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.remedy).toMatch(/does not expire/i);
  });

  it("refuses a sold unit", () => {
    expect(canBook({ ...base, status: "sold" }, "lead-1", NOW).allowed).toBe(false);
  });

  it("refuses a unit held for someone else, and permits it for the holder", () => {
    const held = {
      ...base,
      status: "held" as const,
      holdUntil: new Date(NOW.getTime() + 86_400_000),
      heldForLeadId: "lead-1",
    };
    expect(canBook(held, "lead-2", NOW).allowed).toBe(false);
    // ⚠️ The other half. A hold that stopped its OWN buyer from booking
    // would make the feature actively harmful.
    expect(canBook(held, "lead-1", NOW).allowed).toBe(true);
  });

  it("treats an expired hold as free", () => {
    const lapsed = {
      ...base,
      status: "held" as const,
      holdUntil: new Date(NOW.getTime() - 1000),
      heldForLeadId: "lead-1",
    };
    expect(isHoldLive(lapsed, NOW)).toBe(false);
    expect(canBook(lapsed, "lead-2", NOW).allowed).toBe(true);
  });

  it("refuses a deleted unit", () => {
    expect(canBook({ ...base, deletedAt: NOW }, "lead-1", NOW).allowed).toBe(false);
  });
});

describe("absorption", () => {
  it("excludes blocked units from the denominator", () => {
    // ══════════════════════════════════════════════════════════════
    // 30 flats withheld for promoters were never on the market.
    // Counting them as unsold makes a project look like it is failing,
    // and that number goes to a board.
    // ══════════════════════════════════════════════════════════════
    const summary = summariseAvailability([
      { status: "sold" },
      { status: "sold" },
      { status: "available" },
      { status: "available" },
      { status: "blocked" },
      { status: "blocked" },
    ]);

    expect(summary.total).toBe(6);
    expect(summary.blocked).toBe(2);
    // 2 absorbed of 4 marketable = 50%, not 33%.
    expect(summary.absorptionPct).toBe(50);
  });

  it("does not divide by zero when everything is blocked", () => {
    const summary = summariseAvailability([{ status: "blocked" }]);
    expect(summary.absorptionPct).toBe(0);
  });
});

describe("booking collision translation", () => {
  it("recognises the constraint by name and by message", () => {
    expect(
      isBookingCollision({ code: "23505", constraint: "bookings_one_live_per_unit" }),
    ).toBe(true);
    expect(
      isBookingCollision({
        code: "23505",
        message: 'duplicate key value violates unique constraint "bookings_one_live_per_unit"',
      }),
    ).toBe(true);
  });

  it("does not claim an unrelated uniqueness error is a double-sale", () => {
    // ⚠️ Mislabelling matters. Telling a user "someone booked that flat"
    // when they actually reused a unit code sends them chasing a
    // colleague who did nothing.
    expect(
      isBookingCollision({ code: "23505", constraint: "units_code_project_unique" }),
    ).toBe(false);
    expect(isBookingCollision({ code: "23503" })).toBe(false);
    expect(isBookingCollision(null)).toBe(false);
    expect(isBookingCollision("23505")).toBe(false);
  });

  it("explains that nothing was saved", () => {
    const message = describeBookingCollision("A-1203");
    expect(message).toMatch(/A-1203/);
    expect(message).toMatch(/no double booking/i);
  });
});

/* ================================================================== */
/* COMMISSION                                                          */
/* ================================================================== */

describe("commission", () => {
  it("computes 2% of ₹85,00,000 exactly", () => {
    const result = computeCommission({
      basis: "percent_of_sale",
      rateBps: 200,
      agreementValueMinor: 850_000_000n, // ₹85,00,000 in paise
    });
    expect(result.problem).toBeNull();
    expect(result.grossMinor).toBe(17_000_000n); // ₹1,70,000
  });

  it("computes 1.5 months of rent", () => {
    const result = computeCommission({
      basis: "months_of_rent",
      rateBps: 0,
      monthsCentis: 150,
      monthlyRentMinor: 4_500_000n, // ₹45,000
    });
    expect(result.grossMinor).toBe(6_750_000n); // ₹67,500
  });

  it("returns a flat fee unchanged", () => {
    const result = computeCommission({
      basis: "flat_fee",
      rateBps: 0,
      flatMinor: 2_500_000n,
    });
    expect(result.grossMinor).toBe(2_500_000n);
  });

  it("returns zero WITH a problem rather than throwing", () => {
    // ⚠️ A commission page listing 200 partners must not blank out
    // because one has a half-configured agreement.
    const result = computeCommission({ basis: "percent_of_sale", rateBps: 200 });
    expect(result.grossMinor).toBe(0n);
    expect(result.problem).toMatch(/agreement value/i);
  });

  it("refuses a rate above 100%", () => {
    const result = computeCommission({
      basis: "percent_of_sale",
      rateBps: 10_001,
      agreementValueMinor: 100_000n,
    });
    expect(result.problem).not.toBeNull();
  });

  it("shows its workings, so a disputed figure can be re-derived", () => {
    const result = computeCommission({
      basis: "percent_of_sale",
      rateBps: 250,
      agreementValueMinor: 100_000_000n,
    });
    expect(result.workings).toMatch(/2\.50%/);
  });
});

describe("TDS", () => {
  it("does not deduct below the annual threshold", () => {
    const result = computeTds({ grossMinor: 1_000_000n, hasPan: true }); // ₹10,000
    expect(result.applicable).toBe(false);
    expect(result.tdsMinor).toBe(0n);
    expect(result.netMinor).toBe(1_000_000n);
  });

  it("⚠️ applies the threshold to the YEAR, not the payment", () => {
    // ══════════════════════════════════════════════════════════════
    // A partner paid ₹15,000 twice HAS crossed ₹20,000. Testing each
    // payment in isolation is the classic way to under-deduct, and the
    // assessment arrives years later with interest.
    // ══════════════════════════════════════════════════════════════
    const second = computeTds({
      grossMinor: 1_500_000n,
      hasPan: true,
      ytdGrossMinor: 1_500_000n,
    });
    expect(second.applicable).toBe(true);
    expect(second.rateBps).toBe(TDS_194H_BPS);
    expect(second.tdsMinor).toBe(75_000n); // 5% of ₹15,000 = ₹750
  });

  it("deducts 20% when there is no PAN, and says why", () => {
    const result = computeTds({ grossMinor: 10_000_000n, hasPan: false });
    expect(result.rateBps).toBe(TDS_NO_PAN_BPS);
    expect(result.tdsMinor).toBe(2_000_000n);
    expect(result.explanation).toMatch(/206AA/);
    // The message has to be actionable — this is what gets the broker to
    // submit their PAN.
    expect(result.explanation).toMatch(/add the partner's pan/i);
  });

  it("net plus TDS always equals gross", () => {
    for (const gross of [10_000_000n, 3_333_333n, 1n + 10_000_000n]) {
      const result = computeTds({ grossMinor: gross, hasPan: true });
      expect(result.netMinor + result.tdsMinor).toBe(gross);
    }
  });
});

describe("commission protection window", () => {
  it("refuses re-attribution while the window is open", () => {
    const verdict = canAttribute({
      currentPartnerId: "cp-1",
      cpLockedUntil: new Date(NOW.getTime() + 86_400_000),
      incomingPartnerId: "cp-2",
      now: NOW,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("allows it once the window has closed", () => {
    const verdict = canAttribute({
      currentPartnerId: "cp-1",
      cpLockedUntil: new Date(NOW.getTime() - 1000),
      incomingPartnerId: "cp-2",
      now: NOW,
    });
    expect(verdict.allowed).toBe(true);
  });

  it("allows re-confirming the SAME partner", () => {
    const verdict = canAttribute({
      currentPartnerId: "cp-1",
      cpLockedUntil: new Date(NOW.getTime() + 86_400_000),
      incomingPartnerId: "cp-1",
      now: NOW,
    });
    expect(verdict.allowed).toBe(true);
  });

  it("clamps a configured window to a year", () => {
    expect(resolveCpLockDays(10_000)).toBe(365);
    expect(resolveCpLockDays(null)).toBe(90);
    expect(resolveCpLockDays(0)).toBe(1);
    expect(resolveCpLockDays(Number.NaN)).toBe(90);
  });

  it("computes the expiry from the registration date", () => {
    const expiry = cpLockExpiry(NOW, 90);
    expect((expiry.getTime() - NOW.getTime()) / 86_400_000).toBe(90);
  });
});

/* ================================================================== */
/* ⭐ PAYMENT PLANS — THE ARITHMETIC                                   */
/* ================================================================== */

describe("payment plan templates", () => {
  it("every built-in template sums to exactly 100%", () => {
    // ⚠️ Checked in INTEGER BASIS POINTS. Summed as percentages in
    // floating point this is 99.99999999999999 and a validator written
    // the obvious way rejects a perfect plan.
    for (const template of PLAN_TEMPLATES) {
      const total = template.stages.reduce((sum, s) => sum + s.shareBps, 0);
      expect(total, template.name).toBe(FULL_BPS);
      expect(validateTemplate(template.stages), template.name).toBeNull();
    }
  });

  it("rejects a template that is short, and says how much by", () => {
    const problem = validateTemplate([
      { label: "On booking", shareBps: 1000 },
      { label: "On possession", shareBps: 8000 },
    ]);
    expect(problem).not.toBeNull();
    expect(problem!.message).toMatch(/90\.00%/);
    expect(problem!.remedy).toMatch(/10\.00%/);
  });

  it("rejects a template that is over", () => {
    const problem = validateTemplate([
      { label: "On booking", shareBps: 5000 },
      { label: "On possession", shareBps: 6000 },
    ]);
    expect(problem!.remedy).toMatch(/consumer-forum/i);
  });

  it("rejects an unlabelled or non-positive stage", () => {
    expect(validateTemplate([{ label: "  ", shareBps: 10_000 }])).not.toBeNull();
    expect(
      validateTemplate([
        { label: "A", shareBps: 10_000 },
        { label: "B", shareBps: 0 },
      ]),
    ).not.toBeNull();
    expect(validateTemplate([])).not.toBeNull();
  });
});

describe("⭐ payment plan arithmetic", () => {
  it("milestones sum EXACTLY to the agreement value, for awkward amounts", () => {
    // ══════════════════════════════════════════════════════════════
    // THE INVARIANT THE WHOLE MODULE EXISTS FOR.
    //
    // 10% of ₹87,45,633.47 is not a whole number of paise. Nine such
    // stages leave a remainder, and it has to land somewhere. Short by
    // ₹1 and the final demand under-collects forever; over by ₹1 and
    // you have demanded more than the agreement.
    // ══════════════════════════════════════════════════════════════
    const template = templateFor("construction_linked")!;

    const awkward = [
      874_563_347n, // ₹87,45,633.47
      1n,
      7n,
      999_999_999_999n,
      123_456_789n,
      100n,
    ];

    for (const value of awkward) {
      const plan = buildPlan({ agreementValueMinor: value, stages: template.stages });
      expect(plan.ok, `value ${value}`).toBe(true);
      if (!plan.ok) continue;

      const total = plan.milestones.reduce((sum, m) => sum + m.amountMinor, 0n);
      expect(total, `value ${value} must reconcile exactly`).toBe(value);
      expect(plan.totalMinor).toBe(value);
    }
  });

  it("every built-in template reconciles for every awkward amount", () => {
    for (const template of PLAN_TEMPLATES) {
      for (const value of [1n, 33n, 874_563_347n, 5_000_000_001n]) {
        const plan = buildPlan({ agreementValueMinor: value, stages: template.stages });
        expect(plan.ok).toBe(true);
        if (!plan.ok) continue;
        const total = plan.milestones.reduce((sum, m) => sum + m.amountMinor, 0n);
        expect(total, `${template.key} @ ${value}`).toBe(value);
      }
    }
  });

  it("puts the remainder on the LAST stage, not the first", () => {
    // ⚠️ On the first stage it would inflate the booking demand — the
    // very first number the buyer sees would not match the percentage in
    // their agreement, and that conversation happens on day one.
    const plan = buildPlan({
      agreementValueMinor: 7n,
      stages: [
        { label: "A", shareBps: 3333 },
        { label: "B", shareBps: 3333 },
        { label: "C", shareBps: 3334 },
      ],
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // 7 × 3333 / 10000 = 2.33 → 2 for the first two; the last takes 3.
    expect(plan.milestones[0]!.amountMinor).toBe(2n);
    expect(plan.milestones[1]!.amountMinor).toBe(2n);
    expect(plan.milestones[2]!.amountMinor).toBe(3n);
  });

  it("numbers the stages from 1, in order", () => {
    const template = templateFor("down_payment")!;
    const plan = buildPlan({ agreementValueMinor: 100_000_000n, stages: template.stages });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.milestones.map((m) => m.sequence)).toEqual([1, 2, 3]);
  });

  it("refuses a plan on a booking with no value", () => {
    const plan = buildPlan({
      agreementValueMinor: 0n,
      stages: templateFor("down_payment")!.stages,
    });
    expect(plan.ok).toBe(false);
  });
});

describe("milestone status", () => {
  it("is derived from what was demanded and what arrived", () => {
    const common = { dueDate: null, now: NOW };
    expect(
      deriveMilestoneStatus({ amountMinor: 100n, amountPaidMinor: 0n, ...common }),
    ).toBe("pending");
    expect(
      deriveMilestoneStatus({ amountMinor: 100n, amountPaidMinor: 40n, ...common }),
    ).toBe("partial");
    expect(
      deriveMilestoneStatus({ amountMinor: 100n, amountPaidMinor: 100n, ...common }),
    ).toBe("paid");
    // An over-payment still reads as paid, not as an error.
    expect(
      deriveMilestoneStatus({ amountMinor: 100n, amountPaidMinor: 150n, ...common }),
    ).toBe("paid");
  });

  it("marks an unpaid past-due milestone overdue, but not a settled one", () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    expect(
      deriveMilestoneStatus({
        amountMinor: 100n,
        amountPaidMinor: 40n,
        dueDate: past,
        now: NOW,
      }),
    ).toBe("overdue");
    expect(
      deriveMilestoneStatus({
        amountMinor: 100n,
        amountPaidMinor: 100n,
        dueDate: past,
        now: NOW,
      }),
    ).toBe("paid");
  });
});

describe("plan summary", () => {
  const past = new Date(NOW.getTime() - 86_400_000);
  const future = new Date(NOW.getTime() + 86_400_000);

  it("reports collected, outstanding and overdue separately", () => {
    const summary = summarisePlan(
      [
        { label: "On booking", sequence: 1, amountMinor: 100n, amountPaidMinor: 100n, dueDate: past },
        { label: "On slab", sequence: 2, amountMinor: 200n, amountPaidMinor: 50n, dueDate: past },
        { label: "On possession", sequence: 3, amountMinor: 300n, amountPaidMinor: 0n, dueDate: future },
      ],
      NOW,
    );

    expect(summary.totalMinor).toBe(600n);
    expect(summary.collectedMinor).toBe(150n);
    expect(summary.outstandingMinor).toBe(450n);
    // Only the past-due shortfall counts as overdue.
    expect(summary.overdueMinor).toBe(150n);
    expect(summary.nextDue?.label).toBe("On slab");
  });

  it("⚠️ clamps an over-payment so the plan cannot exceed 100% collected", () => {
    // An excess is a credit and belongs in the ledger, not in this
    // percentage. Uncapped, a buyer who rounded up makes the project
    // look more collected than it is.
    const summary = summarisePlan(
      [
        { label: "A", sequence: 1, amountMinor: 100n, amountPaidMinor: 500n, dueDate: null },
        { label: "B", sequence: 2, amountMinor: 100n, amountPaidMinor: 0n, dueDate: null },
      ],
      NOW,
    );

    expect(summary.collectedMinor).toBe(100n);
    expect(summary.collectedPct).toBeLessThanOrEqual(100);
  });

  it("orders by sequence regardless of input order", () => {
    const summary = summarisePlan(
      [
        { label: "Third", sequence: 3, amountMinor: 100n, amountPaidMinor: 0n, dueDate: null },
        { label: "First", sequence: 1, amountMinor: 100n, amountPaidMinor: 0n, dueDate: null },
      ],
      NOW,
    );
    expect(summary.nextDue?.label).toBe("First");
  });

  it("handles an empty plan without dividing by zero", () => {
    const summary = summarisePlan([], NOW);
    expect(summary.totalMinor).toBe(0n);
    expect(summary.collectedPct).toBe(0);
    expect(summary.nextDue).toBeNull();
  });
});
