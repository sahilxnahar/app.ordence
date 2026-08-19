/**
 * Ordence — ⚠️ RERA IS A CENTRAL ACT WITH STATE RULES, AND THE LADDER
 *            LIVES IN THE STATE HALF
 * Version: v1.67.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE REFUSES TO DO, AND THAT IS THE POINT OF IT
 * ══════════════════════════════════════════════════════════════════════
 * It carries NO table of per-State timelines. Not one number. The
 * obvious version of this module is a `Record<StateCode, { cureDays,
 * noticeDays, forfeitureCapBps }>` seeded with Maharashtra's figures and
 * a comment saying "add the others later", and it is wrong on the day it
 * ships for every project outside Maharashtra — silently, in a screen
 * that is about to threaten somebody's home, because a number on a
 * screen reads as authority whatever its provenance.
 *
 * ⭐ WHAT IT DOES INSTEAD IS SEPARATE THE TWO HALVES AND SAY WHICH IS
 * WHICH, so the person clicking knows which of the figures in front of
 * them came from the statute and which came from a settings page in this
 * product.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TWO HALVES
 * ══════════════════════════════════════════════════════════════════════
 * FIXED BY THE CENTRAL ACT, THE SAME IN EVERY STATE — Real Estate
 * (Regulation and Development) Act, 2016 (16 of 2016):
 *
 *   • s.2(za) — "interest" is SYMMETRIC. The rate the promoter charges
 *     an allottee for a delayed payment is the same rate the promoter
 *     pays for delayed possession. A ladder that charges 18% commits the
 *     promoter to 18% on every delayed flat in the tower.
 *   • s.11(5) — the promoter may cancel only in accordance with the
 *     terms of the agreement for sale; an allottee who says the
 *     cancellation was unilateral and without cause may approach the
 *     Authority. So the ladder's authority comes from THE AGREEMENT, and
 *     an agreement's steps are what have to be evidenced.
 *   • s.13(1) — no more than 10% of the cost may be taken without a
 *     registered agreement for sale. Below that line there is no
 *     agreement to cancel under.
 *   • s.19(6) and s.19(7) — the allottee is responsible for the payments
 *     in the agreement and is liable to interest at the prescribed rate
 *     for any delay.
 *
 * ⚠️ SET BY THE STATE, OR BY THE AGREEMENT DRAWN UNDER THE STATE'S MODEL
 * — s.84 gives the appropriate Government the power to make the rules,
 * s.20 has each State constitute its own Authority:
 *
 *   • THE RATE ITSELF. s.2(za) says "prescribed", and the prescribing is
 *     done by the State rules. It is commonly SBI's highest marginal cost
 *     of lending rate plus a margin — and the margin is NOT the same
 *     everywhere. Some States' rules prescribe plus 2%; others prescribe
 *     plus 1%. A product that hardcodes one of them is wrong in the other
 *     States and gives no sign of it.
 *   • THE CURE PERIOD before a cancellation, and how many notices precede
 *     it. This is the agreement's clause, drawn under the State's model
 *     form. It is NOT in the Central Act at all.
 *   • WHAT COUNTS AS VALID SERVICE. Most builder-buyer agreements name
 *     registered post to the address recorded in the agreement. Some
 *     also name email. An unopened email is not service under an
 *     agreement that does not say it is.
 *   • WHETHER, AND HOW MUCH, MAY BE FORFEITED. State rules and Authority
 *     orders differ, and several cap it against the consideration.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO WHAT THE PRODUCT ACTUALLY KNOWS
 * ══════════════════════════════════════════════════════════════════════
 * `dunning_policies` holds four day counts and a minimum gap. Those are
 * A WORKSPACE SETTING. They are not a statutory minimum, they have never
 * been checked against one, and this module's whole job is to make sure
 * nobody reading the board mistakes the first for the second.
 *
 * `projects.state_code` exists — added in 0080 for GST place of supply
 * under s.12(3) of the IGST Act — and is nullable and unset on the live
 * deployment. When it is unset this module says so in words rather than
 * choosing a State, because choosing one is the failure being avoided.
 *
 * Pure and isomorphic. No database, no `server-only`.
 */

/* ------------------------------------------------------------------ */

/** ⚠️ NAMED SO A SCREEN CAN BRANCH ON THE WORD, NEVER ON A BOOLEAN. */
export type StatutoryBasisWord = "central_act" | "state_or_agreement";

export type StatutoryPoint = {
  readonly basis: StatutoryBasisWord;
  /** The section, where there is one. Null where the source is the agreement. */
  readonly citation: string | null;
  readonly point: string;
};

/**
 * ⭐ THE UNIFORM HALF. These do not move between States, so the board may
 * state them whether or not `state_code` is set.
 */
export const CENTRAL_ACT_POINTS: readonly StatutoryPoint[] = Object.freeze([
  Object.freeze({
    basis: "central_act" as const,
    citation: "RERA 2016, s.2(za)",
    point:
      "Interest is symmetric. Whatever rate this ladder charges an allottee for a late payment is the rate the promoter owes on every delayed possession in the project.",
  }),
  Object.freeze({
    basis: "central_act" as const,
    citation: "RERA 2016, s.11(5)",
    point:
      "A promoter may cancel only in accordance with the terms of the agreement for sale. The ladder's authority is the agreement's clause, not this product's policy screen — and an allottee may put a unilateral cancellation to the Authority.",
  }),
  Object.freeze({
    basis: "central_act" as const,
    citation: "RERA 2016, s.13(1)",
    point:
      "No more than ten per cent of the cost may be taken without a registered agreement for sale. Below that line there is no agreement to cancel under.",
  }),
  Object.freeze({
    basis: "central_act" as const,
    citation: "RERA 2016, s.19(6) and s.19(7)",
    point:
      "The allottee owes the payments set out in the agreement and interest at the prescribed rate for delay. What the notice demands must be what the agreement says.",
  }),
]);

/**
 * ⚠️ THE HALF THIS PRODUCT DOES NOT KNOW. Listed as questions rather than
 * answers, because an answer here would be a guess wearing a citation.
 */
export const STATE_DEPENDENT_POINTS: readonly StatutoryPoint[] = Object.freeze([
  Object.freeze({
    basis: "state_or_agreement" as const,
    citation: "RERA 2016, s.84 (State rules)",
    point:
      "The interest rate itself. The Act says 'prescribed'; the State's rules prescribe it, commonly as SBI's highest MCLR plus a margin — and the margin differs between States.",
  }),
  Object.freeze({
    basis: "state_or_agreement" as const,
    citation: null,
    point:
      "How long the allottee has to cure, and how many notices come first. This is the agreement's clause drawn under the State's model form. It is not in the Central Act, and the day counts on this ladder are a setting in this workspace, not a statutory floor.",
  }),
  Object.freeze({
    basis: "state_or_agreement" as const,
    citation: null,
    point:
      "What counts as valid service. Most agreements name registered post to the address recorded in the agreement; some also name email. An unopened email is not service under an agreement that does not say it is.",
  }),
  Object.freeze({
    basis: "state_or_agreement" as const,
    citation: "RERA 2016, s.20 (the State's Authority)",
    point:
      "Whether anything may be forfeited on cancellation and how much. State rules and Authority orders differ, and several measure the cap against the consideration.",
  }),
]);

/* ------------------------------------------------------------------ */

export type StatutoryLadderContext = {
  /** ⭐ `projects.state_code` verbatim. Null when the project has none. */
  readonly stateCode: string | null;
  readonly stateKnown: boolean;
  /**
   * 🔴 TRUE WHENEVER THE LADDER'S DAY COUNTS CANNOT BE COMPARED TO
   * ANYTHING. It is true when the State is unknown AND it stays true when
   * the State is known, because this product carries no table of State
   * timelines to compare against — see the header. A screen that read
   * this as "unset state" would start showing a false all-clear the day
   * somebody fills the field in.
   */
  readonly thresholdsUnverifiable: boolean;
  readonly headline: string;
  readonly detail: string;
  readonly uniform: readonly StatutoryPoint[];
  readonly stateDependent: readonly StatutoryPoint[];
};

/**
 * ⚠️ TWO CODES ARE NOT A STATE LIST. `state_code` is the two-digit GST
 * State code — "27" for Maharashtra, "29" for Karnataka. This function
 * does not resolve it to a name and does not validate it against a list,
 * because a list here would be the first half of the table the header
 * refuses to carry.
 */
export function statutoryLadderContext(args: {
  stateCode: string | null | undefined;
  projectName?: string | null;
}): StatutoryLadderContext {
  const raw = typeof args.stateCode === "string" ? args.stateCode.trim() : "";
  const stateCode = raw === "" ? null : raw;
  const stateKnown = stateCode !== null;
  const where = args.projectName?.trim() ? `"${args.projectName.trim()}"` : "this project";

  return {
    stateCode,
    stateKnown,
    // 🔴 Always true. See the field's own comment.
    thresholdsUnverifiable: true,
    headline: stateKnown
      ? `State code ${stateCode}. The steps below are this workspace's dunning policy, not that State's statutory minimum.`
      : `No State recorded for ${where}. The steps below are this workspace's dunning policy and nothing has been checked against any State's rules.`,
    detail: stateKnown
      ? "RERA is a Central Act with State-made rules (s.84) and a State Authority (s.20). Ordence carries no table of per-State timelines, so knowing the State does not let it verify these day counts — it only tells you whose rules and whose model agreement apply. The cure period before a cancellation, the prescribed interest margin and what may be forfeited all come from there and from the agreement for sale, never from this screen."
      : "RERA is a Central Act with State-made rules (s.84) and a State Authority (s.20), so the cure period, the prescribed interest margin and the forfeiture position all depend on where the project is. `projects.state_code` is unset here — it was added for GST place of supply and has never been filled in. Set it on the project so this notice records which State's rules it was raised under; the ladder is not blocked, because a data gap is not a reason to stop somebody serving a lawful notice.",
    uniform: CENTRAL_ACT_POINTS,
    stateDependent: STATE_DEPENDENT_POINTS,
  };
}
