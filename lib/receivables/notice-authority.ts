/**
 * Ordence — ⭐⭐ WHICH RIGHT EACH RUNG OF THE LADDER NEEDS
 * Version: v1.67.0-alpha  ·  SQL 0111
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS A MODULE AND NOT A TERNARY
 * ══════════════════════════════════════════════════════════════════════
 * The rule existed. It lived as one line inside `sendDunningNotice`:
 *
 *     data.stage === "cancellation_warning"
 *       ? "receivables:warn_cancellation"
 *       : "receivables:dun"
 *
 * ⚠️ THAT IS ENOUGH TO REFUSE AND NOT ENOUGH TO OFFER. A screen cannot
 * read a ternary. So a screen that wanted to show the accountant which
 * rungs they may actually send had exactly two options: call the action
 * and catch the refusal, or write the mapping out a second time. The
 * second is what happens, and a rule written twice is a rule that will
 * be written differently — which for this rule means a button that
 * offers a cancellation warning to somebody the server will refuse, or,
 * worse, a screen whose copy of the mapping is the permissive one.
 *
 * ⭐ SO THE MAPPING IS DATA, IN ONE PLACE, PURE AND ISOMORPHIC. The
 * action reads it to decide what to require. The board reads it to
 * decide what to offer. SQL 0111 restates it as a CHECK constraint, so
 * a back-fill that never comes through either is refused as well.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THERE ARE TWO KEYS ACROSS FOUR RUNGS AND NOT FOUR
 * ══════════════════════════════════════════════════════════════════════
 * The temptation, reading "make the escalating rung need an escalating
 * right", is to mint `receivables:first_notice` and
 * `receivables:final_notice` so every rung has its own key. That would
 * be worse, for a reason `db/schema/auth.ts` already writes down about
 * this exact phase:
 *
 *   "Splitting any of that across two people would put an approval queue
 *    in the middle of a process that runs two thousand times over a
 *    project's life, and a gate somebody works around a hundred times a
 *    month is worse than no gate."
 *
 * A reminder, a first notice and a final notice are ONE ACT repeated —
 * chasing money the buyer already owes under a document they already
 * hold. The person doing it is the accountant, all quarter, every
 * quarter. A cancellation warning is A DIFFERENT ACT: it precedes
 * terminating an allotment and forfeiting what a family has paid towards
 * a home, it is answered by an advocate if it is answered at all, and
 * the consequences of getting the sequence wrong land on counsel.
 *
 * 🔴 THE SEAM IS THERE AND IT IS REAL, AND IT IS VISIBLE IN THE ROLE
 * TEMPLATES RATHER THAN ONLY IN THE CATALOGUE: `billing_admin` — the
 * accountant — holds `receivables:dun` and NOT
 * `receivables:warn_cancellation`. `manager` — Legal Counsel — holds
 * `receivables:warn_cancellation` and NOT `receivables:dun`. Neither can
 * do the other's rung. `ladderAuthorityProblem()` checks that both halves
 * of that split still exist, because a template edit that quietly gave
 * the accountant the top key would leave every other line in this file
 * true and the design gone.
 *
 * ⚠️ THIS FILE GRANTS NOTHING AND REFUSES NOTHING. It says which key an
 * act needs. `requirePermission` decides whether the person holds it,
 * `evaluatePermission` decides how, and the CHECK in 0111 decides
 * whether the row may record it. Reading this module is not a check.
 */

import {
  DANGEROUS_PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_TEMPLATES,
  permissionsForRole,
  type PermissionKey,
} from "@/db/schema/auth";
import type { SystemRole } from "@/db/schema";
import type { DunningStage } from "@/db/schema/receivables";
import {
  DUNNING_LADDER,
  DUNNING_STAGE_LABELS,
  requiresHumanAuthorisation,
  rungOf,
} from "./dunning";

/* ------------------------------------------------------------------ */
/* THE MAPPING                                                         */
/* ------------------------------------------------------------------ */

export type RungAuthority = {
  readonly stage: DunningStage;
  /** 1..4. The integer, never the enum's position — see `rungOf`. */
  readonly rung: number;
  readonly label: string;
  /** 🔴 The key `sendDunningNotice` requires before this rung is written. */
  readonly permission: PermissionKey;
  /** True when the key is on `DANGEROUS_PERMISSIONS`. */
  readonly dangerous: boolean;
  /**
   * ⭐ Whether the row itself must name a person and a reason. Distinct
   * from the permission: a key answers "may you", the named authoriser
   * answers "who decided", and a hearing asks the second one.
   */
  readonly needsNamedAuthoriser: boolean;
  /** One sentence for a screen, written for the person about to click. */
  readonly why: string;
};

const AUTHORITY: Readonly<Record<DunningStage, RungAuthority>> = Object.freeze({
  reminder: Object.freeze({
    stage: "reminder",
    rung: rungOf("reminder"),
    label: DUNNING_STAGE_LABELS.reminder,
    permission: "receivables:dun",
    dangerous: DANGEROUS_PERMISSIONS.includes("receivables:dun"),
    needsNamedAuthoriser: requiresHumanAuthorisation("reminder"),
    why: "A reminder about a demand the buyer already holds. Collections work, done by whoever chases payments.",
  }),
  first_notice: Object.freeze({
    stage: "first_notice",
    rung: rungOf("first_notice"),
    label: DUNNING_STAGE_LABELS.first_notice,
    permission: "receivables:dun",
    dangerous: DANGEROUS_PERMISSIONS.includes("receivables:dun"),
    needsNamedAuthoriser: requiresHumanAuthorisation("first_notice"),
    why: "The same act as a reminder, in firmer words. Still a letter about a document the buyer already holds.",
  }),
  final_notice: Object.freeze({
    stage: "final_notice",
    rung: rungOf("final_notice"),
    label: DUNNING_STAGE_LABELS.final_notice,
    permission: "receivables:dun",
    dangerous: DANGEROUS_PERMISSIONS.includes("receivables:dun"),
    needsNamedAuthoriser: requiresHumanAuthorisation("final_notice"),
    why:
      "The last rung that is still only about money. It threatens nothing about the allotment itself, so it stays with the person collecting.",
  }),
  cancellation_warning: Object.freeze({
    stage: "cancellation_warning",
    rung: rungOf("cancellation_warning"),
    label: DUNNING_STAGE_LABELS.cancellation_warning,
    permission: "receivables:warn_cancellation",
    dangerous: DANGEROUS_PERMISSIONS.includes("receivables:warn_cancellation"),
    needsNamedAuthoriser: requiresHumanAuthorisation("cancellation_warning"),
    why:
      "⚠️ A different act, not a firmer letter. This one precedes terminating the allotment and forfeiting what the buyer has paid towards a home. It is deliberately withheld from the accountant who does every other collections task, and it names the person who decided.",
  }),
});

export function authorityForStage(stage: DunningStage): RungAuthority {
  return AUTHORITY[stage];
}

/**
 * 🔴 THE ONE FUNCTION THE SERVER ACTION CALLS. Everything else in this
 * file exists so that this answer can be shown on a screen and asserted
 * in a test rather than inferred from a ternary.
 */
export function permissionForStage(stage: DunningStage): PermissionKey {
  return AUTHORITY[stage].permission;
}

/** The ladder in order, with the right each rung needs. */
export function ladderAuthority(): readonly RungAuthority[] {
  return DUNNING_LADDER.map((stage) => AUTHORITY[stage]);
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE INVARIANT, CHECKED AT RUNTIME AND NOT ONLY IN A TEST        */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WOULD BREAK THIS SILENTLY, AND WHY A TEST ALONE IS NOT ENOUGH
 * ══════════════════════════════════════════════════════════════════════
 * The mapping above is safe on its own. What is NOT safe is the thing it
 * depends on and does not own: `ROLE_TEMPLATES`. Adding
 * `receivables:warn_cancellation` to the accountant's template is a
 * one-line edit in a different file, it reads like a convenience, every
 * type checks, every existing test passes, and the separation of duties
 * this whole batch rests on is gone with no symptom.
 *
 * ⭐ SO THE BOARD ASKS THIS QUESTION BEFORE IT RENDERS, and refuses to
 * present the ladder if the answer is not null. A screen that offered a
 * per-rung authority the role model no longer honours would be worse
 * than no screen: it would be a screen that says the safety catch is on.
 *
 * ⚠️ IT RETURNS A SENTENCE, NOT A BOOLEAN, AND IT NEVER THROWS. A throw
 * at module load takes the whole product down for a permission-model
 * regression that only affects one screen, which is not a trade anybody
 * would make on purpose.
 */
export function ladderAuthorityProblem(): string | null {
  const roles = Object.keys(ROLE_TEMPLATES) as SystemRole[];
  return assessLadderAuthority(ladderAuthority(), (role, key) =>
    (permissionsForRole(role as SystemRole) as readonly string[]).includes(key),
    roles,
  );
}

/**
 * ⚠️ THE RULE, SEPARATED FROM WHERE IT READS THE ROLE MODEL, AND ONLY SO
 * THAT BOTH BRANCHES CAN BE EXERCISED.
 *
 * 🔴 A VERIFY FUNCTION THAT HAS ONLY EVER BEEN RUN ON THE PASSING CASE IS
 * NOT A VERIFY FUNCTION. Every clause below refuses something, and a
 * clause that has never refused anything is indistinguishable from a
 * clause with a typo in it. Taking the role lookup as an argument lets a
 * test hand it a broken permission model and read the refusal.
 *
 * ⚠️ IT IS NOT A BACK DOOR. Nothing in the product calls this with
 * anything but the real templates — `ladderAuthorityProblem()` is the
 * only production caller and it closes over `permissionsForRole`. A
 * caller that passed a lax lookup would be lying to itself about its own
 * screen, which no amount of API design prevents.
 */
export function assessLadderAuthority(
  rungs: readonly RungAuthority[],
  holds: (role: string, permission: PermissionKey) => boolean,
  roles: readonly string[],
): string | null {
  for (const rung of rungs) {
    if (!(rung.permission in PERMISSION_CATALOG)) {
      return `Rung ${rung.rung} (${rung.label}) requires "${rung.permission}", which is not in the permission catalogue. A key nothing recognises fails closed at every call site, so this rung cannot be sent by anybody.`;
    }
  }

  /*
   * ⭐ MONOTONIC IN THE RUNG. Once a rung needs a key on the dangerous
   * list, every rung above it must too. The reverse — a dangerous third
   * rung under an ordinary fourth — is the shape of a regression that
   * looks tidy in a diff.
   */
  let sawDangerous = false;
  for (const rung of rungs) {
    if (rung.dangerous) sawDangerous = true;
    else if (sawDangerous) {
      return `Rung ${rung.rung} (${rung.label}) needs an ordinary key while a lower rung needs a dangerous one. The ladder's authority must not weaken as it climbs.`;
    }
  }

  const top = rungs[rungs.length - 1];
  const first = rungs[0];
  if (!top || !first) return "The dunning ladder is empty.";

  if (top.permission === first.permission) {
    return `A reminder and a ${top.label.toLowerCase()} both require "${top.permission}". They are not the same act: one chases money the buyer already owes, the other precedes forfeiting what a family has paid towards a home.`;
  }

  if (!top.dangerous) {
    return `"${top.permission}" guards the ${top.label.toLowerCase()} and is not on the dangerous list, so a denial is not audited as one.`;
  }

  if (!top.needsNamedAuthoriser) {
    return `The ${top.label.toLowerCase()} does not require a named authoriser. "The system sent it automatically" is not an answer anybody can give at a hearing.`;
  }

  /*
   * 🔴 THE SPLIT MUST STILL BE REAL, IN BOTH DIRECTIONS. Two different
   * key names prove nothing if one role holds both and no role holds
   * only one — that is a distinction on paper with one person behind it.
   */
  const collectorOnly = roles.some(
    (r) => holds(r, first.permission) && !holds(r, top.permission),
  );
  if (!collectorOnly) {
    return `Every role that may send a reminder may also send a ${top.label.toLowerCase()}. The key that precedes a forfeiture is meant to be withheld from the person who chases the money all quarter, and no role template withholds it any more.`;
  }

  const authoriserOnly = roles.some(
    (r) => holds(r, top.permission) && !holds(r, first.permission),
  );
  if (!authoriserOnly) {
    return `No role holds "${top.permission}" without also holding "${first.permission}". The authoriser is meant to be a second person, not the collector with an extra key.`;
  }

  /*
   * ⚠️ AND WHOEVER MAY AUTHORISE MUST BE ABLE TO READ THE ACCOUNT. A
   * signature on somebody else's summary is what this batch exists to
   * stop being possible.
   */
  for (const role of roles) {
    if (holds(role, top.permission) && !holds(role, "receivables:read")) {
      return `Role "${role}" may authorise a ${top.label.toLowerCase()} without holding "receivables:read". Authorising a forfeiture without being able to read the account it is about is a signature on somebody else's summary.`;
    }
  }

  return null;
}
