/**
 * Ordence — ⭐⭐⭐ WHAT THIS TOGGLE ACTUALLY DOES
 * Version: v1.22.0-alpha
 *
 * Pure. No database, no network, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TOGGLE HAS ALWAYS WORKED. IT HAS NEVER EXPLAINED ITSELF.
 * ══════════════════════════════════════════════════════════════════════
 * `setTenantFlag` writes an `entitlement:` row and the customer's
 * navigation changes. What the operator never sees is what they are
 * about to do, and `featuresGainedBy` and `featuresLostBy` have existed
 * in `lib/entitlements/features.ts` since the tier system was built with
 * nothing on the console calling either of them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE AWKWARD DIRECTION IS THE ONE THAT MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * Enabling something is easy to be confident about. Disabling is where
 * an operator hesitates, on a call, with the customer waiting, because
 * they do not know whether the customer's data is about to disappear.
 *
 * 🔴 IT IS NOT, AND THE PREVIEW SAYS SO IN THOSE WORDS. An entitlement
 * controls VISIBILITY, never existence. Eighteen hundred stock records
 * stay exactly where they are and come back the moment the module is
 * re-enabled. An operator who knows that toggles confidently; one who
 * does not, does not.
 */

export type DiffDirection = "enable" | "disable";

export interface ModuleFact {
  /** The nav id, e.g. "inventory". */
  readonly id: string;
  readonly label: string;
  /** The feature key that gates it, or null where it is always on. */
  readonly featureKey: string | null;
  readonly status: "live" | "beta" | "coming_soon";
}

export interface DiffInput {
  readonly featureKey: string;
  readonly direction: DiffDirection;
  readonly tenantName: string;
  /** Every module in the registry, with its gating feature. */
  readonly modules: readonly ModuleFact[];
  /** Which features the tenant's PLAN already grants. */
  readonly planFeatures: readonly string[];
  /**
   * ⭐ Record counts keyed by module id.
   *
   * 🔴🔴 A MISSING KEY MEANS "NOT COUNTED", NOT "ZERO", AND THE
   * DIFFERENCE IS THE WHOLE POINT OF THIS FIELD.
   *
   * ⚠️ I GOT THIS WRONG ON THE FIRST PASS. The caller passed `{}`
   * because counting rows across an arbitrary module is hard, and the
   * preview cheerfully told the operator "there is no data in these
   * modules yet" about a workspace with eighteen hundred stock records.
   * That sentence is the one an operator repeats to a customer, and it
   * would have been a lie produced by the code that exists to stop
   * exactly that.
   */
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly userCount: number;
}

export interface EntitlementDiff {
  readonly headline: string;
  /** Modules that appear. */
  readonly gains: readonly ModuleFact[];
  /** Modules that disappear from view. */
  readonly hides: readonly ModuleFact[];
  /**
   * ⭐ THE LINE THAT STOPS THE HESITATION. Empty on an enable.
   */
  readonly keepsNote: string | null;
  /** Things worth saying that are not gains or losses. */
  readonly notes: readonly string[];
  /**
   * 🔴 REASONS TO REFUSE. Non-empty means the screen must not offer the
   * button at all rather than letting it fail on submit.
   */
  readonly blockers: readonly string[];
  readonly affectedUsers: number;
}

export function previewChange(input: DiffInput): EntitlementDiff {
  const touched = input.modules.filter((m) => m.featureKey === input.featureKey);
  const blockers: string[] = [];
  const notes: string[] = [];

  if (touched.length === 0) {
    blockers.push(
      `No module in Ordence is gated by "${input.featureKey}", so this toggle would change nothing a person can see. That is a fault in the feature catalogue rather than in this workspace.`,
    );
  }

  const beta = touched.filter((m) => m.status === "beta");
  const soon = touched.filter((m) => m.status === "coming_soon");

  if (soon.length > 0 && input.direction === "enable") {
    // ⚠️ ENABLING SOMETHING UNBUILT IS THE FASTEST WAY TO LOSE A
    // CUSTOMER'S TRUST: they click it, it does nothing, and everything
    // else you told them is now in question.
    blockers.push(
      `${soon.map((m) => m.label).join(", ")} ${soon.length === 1 ? "is" : "are"} not built yet. Enabling ${soon.length === 1 ? "it" : "them"} would put a menu item in front of the customer that goes nowhere.`,
    );
  }

  if (beta.length > 0 && input.direction === "enable") {
    notes.push(
      `${beta.map((m) => m.label).join(", ")} ${beta.length === 1 ? "is" : "are"} in beta. Worth saying to the customer before they find out from a rough edge.`,
    );
  }

  // ⭐ THE PLAN CHECK. An override that grants something the plan does
  // not include is legitimate and common, and it should be visible
  // rather than silent, because it is a discount nobody recorded.
  if (input.direction === "enable" && !input.planFeatures.includes(input.featureKey)) {
    notes.push(
      "Their plan does not include this. Enabling it is an override, which is fine, but it is effectively a discount and nothing else in the system will remember why.",
    );
  }

  if (input.direction === "disable" && input.planFeatures.includes(input.featureKey)) {
    notes.push(
      "Their plan DOES include this. Turning it off takes away something they are paying for, so there should be a reason they would recognise.",
    );
  }

  const counted = touched.filter((m) =>
    Object.prototype.hasOwnProperty.call(input.recordCounts, m.id),
  );
  const affected = counted.reduce((sum, m) => sum + (input.recordCounts[m.id] ?? 0), 0);
  /** ⚠️ True only when EVERY touched module was actually counted. */
  const countsAreComplete = touched.length > 0 && counted.length === touched.length;

  if (input.direction === "enable") {
    return {
      headline: `Enabling ${input.featureKey} for ${input.tenantName}`,
      gains: touched,
      hides: [],
      keepsNote: null,
      notes,
      blockers,
      affectedUsers: input.userCount,
    };
  }

  /**
   * 🔴 THE SENTENCE THIS WHOLE MODULE EXISTS FOR.
   *
   * ⚠️ Written with the real number in it, because "your data is safe"
   * is what everybody says and "all 1,847 stock records stay exactly
   * where they are" is what somebody believes.
   */
  const keepsNote = !countsAreComplete
    ? // 🔴 THE HONEST VERSION, USED WHEN WE HAVE NOT COUNTED. It makes
      // the promise that matters and declines to make the one it cannot
      // support. "However much data is in there" is a sentence an
      // operator can say to a customer without being wrong.
      `Whatever is in ${touched.length === 1 ? "this module" : "these modules"} stays exactly where it is. Nothing is deleted. It becomes invisible, not gone, and all of it reappears the moment this is switched back on. This screen has not counted the records, so it is not going to tell you a number it does not have.`
    : affected > 0
      ? `All ${affected.toLocaleString("en-IN")} record${affected === 1 ? "" : "s"} in ${touched.length === 1 ? "this module" : "these modules"} stay exactly where they are. Nothing is deleted. They become invisible, not gone, and every one of them reappears the moment this is switched back on.`
      : "There is no data in these modules yet, so nothing becomes hidden. Only the menu changes.";

  return {
    headline: `Disabling ${input.featureKey} for ${input.tenantName}`,
    gains: [],
    hides: touched,
    keepsNote,
    notes,
    blockers,
    affectedUsers: input.userCount,
  };
}

/* ------------------------------------------------------------------ */
/* VERIFICATION                                                        */
/* ------------------------------------------------------------------ */

export interface VerifyResult {
  readonly ok: boolean;
  readonly note: string;
}

/**
 * ⭐⭐ DID IT ACTUALLY TAKE EFFECT?
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A TOGGLE THAT SILENTLY FAILS IS WORSE THAN ONE THAT ERRORS
 * ══════════════════════════════════════════════════════════════════════
 * An error is a problem the operator can see and act on. A silent
 * failure produces a support ticket that begins "I enabled it, it should
 * be working", and the operator's own screen agrees with the customer
 * that it is on. Two people then look in the wrong place for an hour.
 *
 * ⚠️ SO THE CHECK IS A FRESH READ FROM THE DATABASE, NOT THE VALUE THE
 * WRITE RETURNED. Confirming a write by reading back what you just sent
 * confirms nothing at all.
 */
export function verifyChange(args: {
  readonly expected: boolean;
  readonly observed: boolean | null;
  readonly featureKey: string;
}): VerifyResult {
  if (args.observed === null) {
    // ⚠️ NULL IS NOT FALSE. A missing flag row and a flag set to false
    // mean different things, and reporting the first as the second sends
    // somebody looking for a write that never happened.
    return {
      ok: false,
      note: `No entitlement row for ${args.featureKey} came back at all. The write did not land, which is different from it landing as "off".`,
    };
  }

  if (args.observed !== args.expected) {
    return {
      ok: false,
      note: `Asked for ${args.expected ? "enabled" : "disabled"} and the database still says ${args.observed ? "enabled" : "disabled"}. Do not tell the customer this is done.`,
    };
  }

  return {
    ok: true,
    note: `Confirmed on a fresh read: ${args.featureKey} is now ${args.expected ? "enabled" : "disabled"}.`,
  };
}
