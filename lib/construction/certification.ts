/**
 * Ordence — ⭐⭐ The Certification Chain
 * Version: v0.43.0-alpha
 *
 * Pure. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ measured → checked → certified → approved → paid
 * ══════════════════════════════════════════════════════════════════════
 * Five steps, five people, and the separation between them is not
 * process hygiene — it is the control that stops a contractor being paid
 * for work that does not exist.
 *
 * ⚠️ THE PERSON WHO MEASURES MAY NOT CERTIFY. This is the oldest fraud in
 * construction and every public works manual in India separates the two
 * for the same reason: a site engineer who can write a measurement and
 * then certify it for payment needs no accomplice, leaves no anomaly, and
 * the only evidence is a measurement book entry they wrote themselves. It
 * is not detected by an audit of the bills, because the bills are
 * internally perfect. It is detected by somebody going to the building
 * and finding the wall is not there.
 *
 * ⚠️ AND THE LADDER MAY NOT SKIP A RUNG. A bill certified without ever
 * being checked has had no independent verification at all, and the
 * certificate says otherwise on its face. The order is enforced here and
 * again in SQL 0028 §10, because the application is not the only writer.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ON SMALL TEAMS
 * ══════════════════════════════════════════════════════════════════════
 * The obvious objection is that a small developer does not have five
 * people. The answer is that they have at least two, and the two that
 * must differ — the one who measures and the one who certifies — are
 * exactly the ones a small team is tempted to collapse, because the site
 * engineer is trusted and the office is far away. Collapsing them is what
 * this refuses. `MINIMUM_DISTINCT_ACTORS` names how many distinct people
 * a bill genuinely requires, so a configuration screen cannot quietly set
 * it to one.
 */

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type RaBillStepLike = "measured" | "checked" | "certified" | "approved" | "paid";

export type RaBillStatusLike =
  | "draft"
  | "measured"
  | "checked"
  | "certified"
  | "approved"
  | "paid"
  | "rejected";

export type CertificationRecord = {
  step: RaBillStepLike;
  actorId: string;
  actedAt?: Date | string;
  remarks?: string | null;
  certifiedAmountMinor?: bigint | null;
};

export class CertificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificationError";
  }
}

/* ------------------------------------------------------------------ */
/* THE LADDER                                                          */
/* ------------------------------------------------------------------ */

export type LadderRung = {
  step: RaBillStepLike;
  rung: number;
  /** The status the bill takes when this rung is climbed. */
  status: RaBillStatusLike;
  label: string;
  /** What this step is actually asserting. Shown next to the button. */
  assertion: string;
};

export const CERTIFICATION_LADDER: readonly LadderRung[] = Object.freeze([
  {
    step: "measured",
    rung: 1,
    status: "measured",
    label: "Measured",
    assertion:
      "I have measured this work on site and the quantities in the measurement " +
      "book are what is there.",
  },
  {
    step: "checked",
    rung: 2,
    status: "checked",
    label: "Checked",
    assertion:
      "I have independently verified a sample of these measurements against the " +
      "building and the working supports the quantities. ⚠️ Not: I have added " +
      "up the arithmetic.",
  },
  {
    step: "certified",
    rung: 3,
    status: "certified",
    label: "Certified",
    assertion:
      "⭐ The work described has been executed in accordance with the contract " +
      "and this amount is due to the contractor. This is the professional " +
      "certificate the contractor relies on and sues on.",
  },
  {
    step: "approved",
    rung: 4,
    status: "approved",
    label: "Approved for payment",
    assertion:
      "The deductions, recoveries and statutory withholdings are correct and " +
      "payment may be released.",
  },
  {
    step: "paid",
    rung: 5,
    status: "paid",
    label: "Paid",
    assertion: "The money has left, against the reference recorded.",
  },
]);

export const LADDER_BY_STEP: Readonly<Record<RaBillStepLike, LadderRung>> =
  Object.freeze(
    Object.fromEntries(CERTIFICATION_LADDER.map((rung) => [rung.step, rung])) as Record<
      RaBillStepLike,
      LadderRung
    >,
  );

export function rungOf(step: RaBillStepLike): number {
  return LADDER_BY_STEP[step].rung;
}

export function nextStep(current: RaBillStepLike | null): RaBillStepLike | null {
  if (current === null) return "measured";
  const next = CERTIFICATION_LADDER.find((rung) => rung.rung === rungOf(current) + 1);
  return next?.step ?? null;
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ SEGREGATION OF DUTIES                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE PAIRS THAT MAY NOT BE THE SAME PERSON, AND WHY EACH ONE.
 *
 * ⚠️ THIS IS A LIST OF SPECIFIC FRAUDS, NOT A GENERAL PRINCIPLE. Written
 * as "all five must differ" it would be an arbitrary rule somebody
 * eventually relaxes; written as the actual failure each pair prevents,
 * it is a rule people keep.
 */
export const SEGREGATED_PAIRS: readonly {
  a: RaBillStepLike;
  b: RaBillStepLike;
  why: string;
}[] = Object.freeze([
  {
    a: "measured",
    b: "certified",
    why:
      "⭐⭐ THE ONE THAT MATTERS MOST. Somebody who can both measure work and " +
      "certify it for payment can pay a contractor for work that does not " +
      "exist, needs no accomplice, and leaves no anomaly — the bill is " +
      "internally perfect and the only evidence is a measurement they wrote " +
      "themselves.",
  },
  {
    a: "measured",
    b: "checked",
    why:
      "Checking a measurement means verifying it against the building. Somebody " +
      "checking their own entries is not a control, and a bill whose every " +
      "input was verified by the person who wrote it has no independent " +
      "evidence behind it at all.",
  },
  {
    a: "checked",
    b: "certified",
    why:
      "The certificate says the work was executed in accordance with the " +
      "contract, relying on the check. A certifier who performed the check is " +
      "relying on themselves and the certificate asserts otherwise on its face.",
  },
  {
    a: "certified",
    b: "approved",
    why:
      "⭐ Certification is a professional opinion that the work is due; " +
      "approval is the commercial decision to release money against it. One " +
      "person doing both can move money out of the company on their own " +
      "signature, which is the same separation as posting versus closing a " +
      "period.",
  },
]);

/**
 * ⭐ How many genuinely different people a completed bill requires.
 *
 * ⚠️ NAMED SO IT CANNOT BE CONFIGURED AWAY. From the pairs above the
 * minimum is three: A measures, B checks and approves, C certifies. It is
 * not one, it is not two, and a settings screen that let it become either
 * would remove the control while leaving every screen looking the same.
 */
export const MINIMUM_DISTINCT_ACTORS = 3;

export type SegregationBreach = {
  stepA: RaBillStepLike;
  stepB: RaBillStepLike;
  actorId: string;
  message: string;
};

/**
 * ⭐⭐ CHECK A PROPOSED STEP AGAINST EVERY STEP ALREADY TAKEN.
 *
 * Returns the breach, or null. ⚠️ IT TAKES THE HISTORY, NOT THE BILL'S
 * CURRENT COLUMNS — a bill that was measured, rejected and re-measured
 * has two measurers in its history, and the person who certifies must
 * differ from BOTH. Checking only the latest would let the first measurer
 * certify the re-measured bill.
 */
export function segregationBreach(args: {
  step: RaBillStepLike;
  actorId: string;
  history: readonly CertificationRecord[];
}): SegregationBreach | null {
  for (const pair of SEGREGATED_PAIRS) {
    const other =
      pair.a === args.step ? pair.b : pair.b === args.step ? pair.a : null;
    if (!other) continue;

    const clash = args.history.find(
      (record) => record.step === other && record.actorId === args.actorId,
    );
    if (!clash) continue;

    return {
      stepA: args.step,
      stepB: other,
      actorId: args.actorId,
      message:
        `The same person cannot ${verb(args.step)} a bill they ${pastVerb(other)}. ` +
        `⚠️ REFUSED: ${pair.why}`,
    };
  }
  return null;
}

function verb(step: RaBillStepLike): string {
  switch (step) {
    case "measured":
      return "measure";
    case "checked":
      return "check";
    case "certified":
      return "certify";
    case "approved":
      return "approve";
    case "paid":
      return "record payment on";
  }
}

function pastVerb(step: RaBillStepLike): string {
  switch (step) {
    case "measured":
      return "measured";
    case "checked":
      return "checked";
    case "certified":
      return "certified";
    case "approved":
      return "approved";
    case "paid":
      return "paid";
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE TRANSITION                                                   */
/* ------------------------------------------------------------------ */

export type CertificationOutcome = {
  step: RaBillStepLike;
  rung: number;
  status: RaBillStatusLike;
  assertion: string;
  distinctActors: number;
};

/**
 * ⭐⭐ TAKE THE NEXT STEP, OR REFUSE AND SAY WHY.
 *
 * Four refusals: a skipped rung, a repeated step, a bill in the wrong
 * state, and — the one this file exists for — the same person twice.
 */
export function certify(args: {
  step: RaBillStepLike;
  actorId: string;
  status: RaBillStatusLike;
  history: readonly CertificationRecord[];
}): CertificationOutcome {
  if (!args.actorId?.trim()) {
    throw new CertificationError(
      `A ${args.step} step needs a named person. ⚠️ "The system certified it" is ` +
        `not an answer at an audit, and an unattributed certification cannot be ` +
        `segregated from anything.`,
    );
  }

  if (args.status === "rejected") {
    throw new CertificationError(
      "This bill has been rejected. It cannot be advanced — correct the " +
        "measurements and raise it again, so that the rejection and the " +
        "correction both stay in the record.",
    );
  }
  if (args.status === "paid") {
    throw new CertificationError(
      "This bill has been paid. Nothing further happens to it: the money has " +
        "left and the record of what it was paid against must not move " +
        "afterwards.",
    );
  }

  const alreadyTaken = args.history.find((record) => record.step === args.step);
  if (alreadyTaken) {
    throw new CertificationError(
      `This bill has already been ${pastVerb(args.step)} by ${alreadyTaken.actorId}. ` +
        `⚠️ A step happens once — two certifications is two professional ` +
        `opinions on one document, and the contractor will rely on whichever is ` +
        `larger.`,
    );
  }

  const highest = args.history.reduce(
    (max, record) => Math.max(max, rungOf(record.step)),
    0,
  );
  const wanted = rungOf(args.step);

  if (wanted !== highest + 1) {
    const missing = CERTIFICATION_LADDER.filter(
      (rung) => rung.rung > highest && rung.rung < wanted,
    ).map((rung) => rung.label);

    throw new CertificationError(
      `This bill cannot be ${pastVerb(args.step)} — it has not been ` +
        `${missing.join(", ") || "advanced"} yet. ⚠️ REFUSED: the ladder may not ` +
        `skip a rung. A bill certified without ever being checked has had no ` +
        `independent verification at all, and the certificate asserts otherwise ` +
        `on its face — which is what the contractor relies on and what an ` +
        `auditor reads.`,
    );
  }

  const breach = segregationBreach({
    step: args.step,
    actorId: args.actorId,
    history: args.history,
  });
  if (breach) throw new CertificationError(breach.message);

  const rung = LADDER_BY_STEP[args.step];
  const actors = new Set(args.history.map((record) => record.actorId));
  actors.add(args.actorId);

  return {
    step: args.step,
    rung: rung.rung,
    status: rung.status,
    assertion: rung.assertion,
    distinctActors: actors.size,
  };
}

/**
 * ⭐ IS THE CHAIN ON THIS BILL COMPLETE AND SOUND?
 *
 * Used by the contract-account screen and by the final-bill check.
 * Returns the problems, empty when the chain is clean.
 */
export function auditChain(
  history: readonly CertificationRecord[],
): string[] {
  const problems: string[] = [];

  const seen = new Set<RaBillStepLike>();
  for (const record of history) {
    if (seen.has(record.step)) {
      problems.push(
        `The ${record.step} step appears more than once. A step happens once.`,
      );
    }
    seen.add(record.step);
  }

  const rungs = [...seen].map(rungOf).sort((a, b) => a - b);
  for (let i = 0; i < rungs.length; i += 1) {
    const reached = rungs[i];
    if (reached === undefined || reached === i + 1) continue;
    problems.push(
      `The chain skips a rung: it reaches ${CERTIFICATION_LADDER[reached - 1]?.label} ` +
        `without ${CERTIFICATION_LADDER[i]?.label}. ⚠️ The steps before a ` +
        `certificate are what the certificate relies on.`,
    );
    break;
  }

  for (const pair of SEGREGATED_PAIRS) {
    const a = history.find((record) => record.step === pair.a);
    const b = history.find((record) => record.step === pair.b);
    if (a && b && a.actorId === b.actorId) {
      problems.push(
        `${a.actorId} both ${pastVerb(pair.a)} and ${pastVerb(pair.b)} this bill. ` +
          `⚠️ ${pair.why}`,
      );
    }
  }

  const actors = new Set(history.map((record) => record.actorId));
  if (history.length >= CERTIFICATION_LADDER.length && actors.size < MINIMUM_DISTINCT_ACTORS) {
    problems.push(
      `This bill was taken through all five steps by ${actors.size} person(s). ` +
        `⚠️ A complete chain needs at least ${MINIMUM_DISTINCT_ACTORS} distinct ` +
        `people; fewer means the separations above were not real.`,
    );
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* ⭐ THE FINAL BILL                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A FINAL BILL CLOSES THE CONTRACT, so the things that must be true
 * before it is certified are different from an ordinary bill's.
 *
 * ⚠️ THE ONE PEOPLE MISS IS THE OPEN VARIATION. A variation still sitting
 * at `submitted` when the final bill is certified is work the contractor
 * has done, believes they are owed for, and has now been told is outside
 * the final account. That is where claims come from.
 */
export function finalBillBlockers(args: {
  openVariationCount: number;
  unrecoveredAdvanceMinor: bigint;
  uncheckedMeasurementCount: number;
  retentionOutstandingMinor: bigint;
  defectLiabilityMonths: number;
}): string[] {
  const problems: string[] = [];

  if (args.openVariationCount > 0) {
    problems.push(
      `${args.openVariationCount} variation(s) are still open. ⚠️ A variation ` +
        `unresolved when the final account is settled is work the contractor has ` +
        `done and believes they are owed for. Settling around it does not make ` +
        `it go away; it makes it a claim.`,
    );
  }

  if (args.unrecoveredAdvanceMinor > 0n) {
    problems.push(
      `${args.unrecoveredAdvanceMinor} paise of advance is still outstanding. An ` +
        `advance unrecovered at contract close is an unsecured loan to somebody ` +
        `leaving site, and the guarantee behind it has usually expired.`,
    );
  }

  if (args.uncheckedMeasurementCount > 0) {
    problems.push(
      `${args.uncheckedMeasurementCount} measurement(s) have never been checked. ` +
        `The final bill is the last opportunity — after it, nobody goes back to ` +
        `the building.`,
    );
  }

  if (args.retentionOutstandingMinor > 0n && args.defectLiabilityMonths <= 0) {
    problems.push(
      `${args.retentionOutstandingMinor} paise of retention is held and the ` +
        `contract records no defect liability period. ⚠️ Retention with no ` +
        `release date is retention nobody ever releases — which is the ` +
        `contractor's money sitting on our balance sheet until they claim it ` +
        `with interest.`,
    );
  }

  return problems;
}
