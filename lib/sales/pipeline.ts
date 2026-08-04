/**
 * Ordence — Lead Pipeline Rules
 * Version: v0.22.0-alpha
 *
 * Pure and isomorphic. No database, no `server-only`, no I/O.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE HAS NO IMPORTS FROM `@/db`
 * ══════════════════════════════════════════════════════════════════════
 * This is the fourth time in this project that decision logic has had to
 * be pulled out of a file that touches the database — the billing state
 * machine, the invoice line builder and the metering recorder all had to
 * be extracted after the fact, twice because a test file could not import
 * them without opening a connection.
 *
 * So it is a rule now: **anything that decides is pure; anything that
 * writes lives in `server/`.** The Kanban board on the client and the
 * server action that guards the transition run the same function, which
 * is the only way to stop the board offering a move the server refuses.
 */

import type { LeadStatus, LeadTemperature, LeadSource } from "@/db/schema/sales";

/* ------------------------------------------------------------------ */
/* THE PIPELINE                                                        */
/* ------------------------------------------------------------------ */

/**
 * The ordered stages a lead moves through.
 *
 * ⚠️ `won` and `lost` are NOT stages on the board — they are outcomes.
 * `PIPELINE_STAGES` is what the Kanban renders; `LEAD_STATUSES` is the
 * full set. Mixing the two produces a board with two dead columns that
 * accumulate every lead the company has ever had.
 */
export const PIPELINE_STAGES = Object.freeze([
  "new",
  "contacted",
  "qualified",
  "site_visit",
  "negotiation",
  "booked",
] as const);

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const TERMINAL_STATUSES = Object.freeze(["won", "lost"] as const);

export const STAGE_LABELS: Readonly<Record<LeadStatus, string>> = Object.freeze({
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  site_visit: "Site visit",
  negotiation: "Negotiation",
  booked: "Booked",
  won: "Won",
  lost: "Lost",
});

export const SOURCE_LABELS: Readonly<Record<LeadSource, string>> = Object.freeze({
  website: "Website",
  referral: "Referral",
  walk_in: "Walk-in",
  campaign: "Campaign",
  portal: "Property portal",
  nri_desk: "NRI desk",
  broker: "Channel partner",
  other: "Other",
});

export function isPipelineStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* TRANSITIONS                                                         */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY MOVEMENT IS ALMOST FREE, AND WHERE IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * The temptation with a pipeline is to enforce a strict forward march:
 * `new` → `contacted` → `qualified`, no skipping, no going back.
 *
 * That is wrong, and the reason is worth stating because it is the
 * opposite of how the rest of this system is designed. Everywhere else
 * we refuse anything not explicitly permitted. Here, a sales process is
 * genuinely non-linear: a walk-in arrives already qualified, a buyer
 * goes cold after a site visit and has to be pulled back, a hot lead
 * jumps straight to negotiation because their brother already bought a
 * flat in the tower.
 *
 * A rep who cannot record what actually happened records something else.
 * Then the pipeline data is fiction, and every forecast built on it is
 * fiction too — which is a far worse outcome than an out-of-order stage.
 *
 * So movement between pipeline stages is free. THREE rules are enforced,
 * and each protects something real rather than a process ideal:
 */
export type TransitionRefusal = {
  allowed: false;
  reason: string;
  /** What the person should do instead. */
  remedy: string;
};

export type TransitionApproval = {
  allowed: true;
  /** True when the caller must supply a reason alongside the change. */
  requiresReason: boolean;
};

export type TransitionVerdict = TransitionApproval | TransitionRefusal;

export function canTransition(args: {
  from: LeadStatus;
  to: LeadStatus;
  /** Whether a live booking exists against this lead. */
  hasLiveBooking: boolean;
  /** Present when the caller has supplied a lost reason. */
  lostReason?: string | null;
}): TransitionVerdict {
  const { from, to, hasLiveBooking, lostReason } = args;

  if (from === to) {
    return { allowed: true, requiresReason: false };
  }

  /* RULE 1 — `won` is a consequence, not a click. ------------------- */
  //
  // A lead is won when a booking is registered, and the booking is the
  // evidence. Letting a rep mark `won` by hand produces a pipeline whose
  // conversion rate does not reconcile with the bookings ledger, and the
  // first person to notice is a finance lead a quarter later.
  if (to === "won" && !hasLiveBooking) {
    return {
      allowed: false,
      reason: "A lead is marked won by registering a booking, not by hand.",
      remedy:
        "Create the booking against a unit. This lead moves to won when that " +
        "booking is registered.",
    };
  }

  /* RULE 2 — a lost lead must say why. ------------------------------ */
  //
  // Enforced in the database too (`leads_lost_has_reason`). Duplicated
  // here so the UI can ask BEFORE the write rather than surfacing a
  // constraint violation, which reads to a user as a bug.
  if (to === "lost" && !lostReason?.trim()) {
    return {
      allowed: false,
      reason: "A lost lead needs a reason.",
      remedy:
        "Say what happened — price, location, timing, or lost to a " +
        "competitor. A pipeline of unexplained losses teaches nobody anything.",
    };
  }

  /* RULE 3 — a lead with a live booking cannot quietly go cold. ----- */
  //
  // Moving it backwards while a buyer holds a booking desynchronises the
  // pipeline from the inventory: the board says "negotiation", the flat
  // says "booked", and the two are reported to different people.
  if (hasLiveBooking && (to === "lost" || isEarlierStage(to, from))) {
    return {
      allowed: false,
      reason: "This lead has a live booking against a unit.",
      remedy:
        "Cancel the booking first, with a reason. That frees the unit and " +
        "releases the lead.",
    };
  }

  return { allowed: true, requiresReason: to === "lost" };
}

/** Position on the board; -1 for the terminal outcomes. */
export function stageIndex(status: LeadStatus): number {
  return (PIPELINE_STAGES as readonly string[]).indexOf(status);
}

function isEarlierStage(candidate: LeadStatus, reference: LeadStatus): boolean {
  const a = stageIndex(candidate);
  const b = stageIndex(reference);
  if (a === -1 || b === -1) return false;
  return a < b;
}

/* ------------------------------------------------------------------ */
/* SCORING                                                             */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * A SCORE IS A SORT ORDER, NOT A PREDICTION
 * ══════════════════════════════════════════════════════════════════════
 * This is arithmetic over things we know, weighted by what tends to
 * matter in a residential sale. It is not a model, it has not been
 * validated against outcomes, and calling it "AI lead scoring" would be
 * a lie that somebody eventually acts on.
 *
 * What it is good for: putting the twenty leads a rep should call today
 * at the top of a list of four hundred. That is a real problem and this
 * solves it.
 *
 * ⚠️ Deliberately deterministic and total — same input, same score, no
 * clock, no randomness. A score that changes when nothing changed
 * destroys trust in the whole column.
 */
export const SCORE_WEIGHTS = Object.freeze({
  /** Someone who walked into a site office has already spent a Saturday. */
  source: Object.freeze({
    walk_in: 20,
    referral: 18,
    nri_desk: 14,
    broker: 12,
    portal: 10,
    campaign: 8,
    website: 8,
    other: 4,
  } satisfies Record<LeadSource, number>),

  /** How far through the process they are. */
  stage: Object.freeze({
    new: 0,
    contacted: 6,
    qualified: 14,
    site_visit: 22,
    negotiation: 30,
    booked: 34,
    won: 34,
    lost: 0,
  } satisfies Record<LeadStatus, number>),

  temperature: Object.freeze({
    hot: 16,
    warm: 8,
    cold: 0,
  } satisfies Record<LeadTemperature, number>),

  /** Reachability. A lead with no phone number cannot be worked. */
  hasPhone: 6,
  hasEmail: 3,
  /** A stated budget is a stated intention. */
  hasBudget: 8,
  /** A named project means they want a specific thing. */
  hasProject: 5,
  /** Lawful basis to contact them. Without it the lead is unusable. */
  hasConsent: 8,
});

export const MAX_SCORE = 100;

export function scoreLead(lead: {
  source: LeadSource;
  status: LeadStatus;
  temperature: LeadTemperature;
  phone?: string | null;
  email?: string | null;
  budgetMinMinor?: bigint | null;
  budgetMaxMinor?: bigint | null;
  projectId?: string | null;
  consentAt?: Date | null;
}): number {
  // A lost lead scores zero. Any other answer puts dead leads at the top
  // of a list sorted by score, which is precisely the wrong list.
  if (lead.status === "lost") return 0;

  let score = 0;
  score += SCORE_WEIGHTS.source[lead.source] ?? 0;
  score += SCORE_WEIGHTS.stage[lead.status] ?? 0;
  score += SCORE_WEIGHTS.temperature[lead.temperature] ?? 0;

  if (lead.phone?.trim()) score += SCORE_WEIGHTS.hasPhone;
  if (lead.email?.trim()) score += SCORE_WEIGHTS.hasEmail;
  if (lead.budgetMinMinor != null || lead.budgetMaxMinor != null) {
    score += SCORE_WEIGHTS.hasBudget;
  }
  if (lead.projectId) score += SCORE_WEIGHTS.hasProject;
  if (lead.consentAt) score += SCORE_WEIGHTS.hasConsent;

  // Clamped, because the database CHECK constraint refuses anything
  // outside 0–100 and a rejected write is a worse outcome than a score
  // that tops out.
  return Math.max(0, Math.min(MAX_SCORE, score));
}

/* ------------------------------------------------------------------ */
/* FOLLOW-UP                                                           */
/* ------------------------------------------------------------------ */

/**
 * How overdue a follow-up is, in whole days. Negative means it is still
 * in the future.
 *
 * ⚠️ Takes `now` as an argument rather than calling `new Date()`. A
 * function that reads the clock cannot be tested without mocking time,
 * and the mock is where the bugs hide.
 */
export function daysOverdue(nextFollowUpAt: Date | null, now: Date): number | null {
  if (!nextFollowUpAt) return null;
  const ms = now.getTime() - nextFollowUpAt.getTime();
  return Math.floor(ms / 86_400_000);
}

export type FollowUpUrgency = "none" | "scheduled" | "due" | "overdue" | "stale";

/**
 * ⚠️ `stale` exists as a separate rung from `overdue` because they need
 * different responses. Two days late is a phone call; three weeks late
 * means the lead has effectively been abandoned and should go back into
 * the pool rather than sit on one rep's list forever.
 */
export const STALE_AFTER_DAYS = 14;

export function followUpUrgency(
  nextFollowUpAt: Date | null,
  now: Date,
): FollowUpUrgency {
  const overdue = daysOverdue(nextFollowUpAt, now);
  if (overdue === null) return "none";
  if (overdue < 0) return "scheduled";
  if (overdue === 0) return "due";
  if (overdue >= STALE_AFTER_DAYS) return "stale";
  return "overdue";
}

/* ------------------------------------------------------------------ */
/* NRI CALLING WINDOWS                                                 */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY A CRM NEEDS TO KNOW WHAT TIME IT IS WHERE THE BUYER LIVES
 * ══════════════════════════════════════════════════════════════════════
 * Calling a buyer in New Jersey at 11am IST is calling them at 1:30am.
 * It happens constantly, it is the fastest way to lose an NRI lead, and
 * no amount of training fixes it because the rep is looking at a list,
 * not a clock.
 *
 * So the list tells them. This returns the local hour for a lead's
 * timezone and whether it is a civil time to ring.
 *
 * Uses `Intl`, which is in every runtime we target and carries the
 * timezone database with it — no dependency, no table to maintain, and
 * daylight saving handled by somebody whose job that is.
 */
export const CALLING_WINDOW = Object.freeze({ startHour: 9, endHour: 21 });

export function localHourFor(timezone: string | null | undefined, at: Date): number | null {
  if (!timezone) return null;
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(at);
    const hour = Number.parseInt(formatted, 10);
    return Number.isFinite(hour) ? hour : null;
  } catch {
    // An invalid timezone string must not take down a list of 400 leads.
    // Unknown reads as "we cannot advise", not as "go ahead".
    return null;
  }
}

export function isCivilCallingHour(
  timezone: string | null | undefined,
  at: Date,
): boolean | null {
  const hour = localHourFor(timezone, at);
  if (hour === null) return null;
  return hour >= CALLING_WINDOW.startHour && hour < CALLING_WINDOW.endHour;
}

/* ------------------------------------------------------------------ */
/* DPDP CONSENT                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Under the Digital Personal Data Protection Act, contacting someone
 * about a property needs a lawful basis. `consent_at` plus
 * `consent_source` is the evidence.
 *
 * This does NOT block the call — a lead can be contacted under other
 * lawful bases, and a CRM that refuses to let a company phone its own
 * walk-in visitor would simply be worked around. It marks the record so
 * the gap is visible, which is what makes it fixable.
 */
export function consentStatus(lead: {
  consentAt?: Date | null;
  consentSource?: string | null;
}): { hasEvidence: boolean; note: string } {
  if (lead.consentAt && lead.consentSource?.trim()) {
    return { hasEvidence: true, note: `Consent recorded — ${lead.consentSource}.` };
  }
  if (lead.consentAt) {
    return {
      hasEvidence: false,
      note: "A consent date is recorded but not where it came from. Add the source.",
    };
  }
  return {
    hasEvidence: false,
    note:
      "No consent evidence on this lead. Record how you obtained permission " +
      "to contact them before running a campaign against it.",
  };
}

/* ------------------------------------------------------------------ */
/* BOARD LIMITS                                                        */
/* ------------------------------------------------------------------ */

/**
 * How many leads each Kanban column loads.
 *
 * ⚠️ LIVES HERE, NOT IN THE SERVER ACTION, AND THAT IS NOT TIDINESS.
 *
 * A `"use server"` file may export ONLY async functions. `export const
 * BOARD_COLUMN_LIMIT = 50` in one is compiled into a public RPC endpoint
 * and fails the production build — which is what happened to six Zod
 * schemas in Phase 7, and to this constant during Phase 22 before the
 * typecheck-then-build pass caught it.
 *
 * It also needs to be readable by the client, which renders the "showing
 * 50 of 312" line. Two copies of that number is how the count and the
 * list disagree.
 */
export const BOARD_COLUMN_LIMIT = 50;
