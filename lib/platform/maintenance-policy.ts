/**
 * Ordence — Maintenance Mode: THE POLICY, WITH NO DATABASE IN IT
 * Version: v1.58.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS IS A SEPARATE, PURE FILE
 * ══════════════════════════════════════════════════════════════════════
 * The same three questions get asked in three places that must never
 * disagree: the enforcement point (`server/platform/maintenance.ts`, one
 * hop from `assertImpersonationAllows`), the customer's banner, and the
 * operator's console. If each computed "is it on?" for itself, the screen
 * would eventually say OFF while the database refused a save — and the
 * customer support call that follows is unanswerable.
 *
 * So: one file, no `server-only`, no imports from `@/db`. It is importable
 * from a `"use client"` banner and from a server action alike.
 *
 * 🔴 IT SHARES `isWriteOperation` WITH IMPERSONATION RATHER THAN
 * RE-DERIVING IT. Batch 28 already decided what counts as a write, and it
 * fails CLOSED — an unrecognised verb is a write. A second classifier
 * here would eventually classify `orders:submit` differently from the
 * impersonation gate, and the disagreement would show up as "read-only
 * mode let one thing through".
 */

import { isWriteOperation } from "./impersonation-policy";

/**
 * 🔴 THE PER-TENANT SWITCH IS A FLAG, NOT A NEW TABLE.
 *
 * `platform_tenant_flags` already carries everything maintenance mode
 * needs and nothing it does not: a mandatory `reason`, an `expires_at`
 * that IS the end of the window, a `value` jsonb for the customer-facing
 * sentence, who set it and when — plus the RLS asymmetry that makes it
 * writable only from platform scope. Inventing a parallel store would
 * have meant re-earning all of that, and a migration nobody can run.
 *
 * ⚠️ Registered in `flags-catalog.ts` as a kill switch, which is what
 * exempts it from the "grants a paid capability → must expire" rule. A
 * workspace frozen because it is corrupting its own data must stay frozen
 * until a human says otherwise, not until a timer says otherwise.
 */
export const MAINTENANCE_FLAG_KEY = "killswitch.maintenance_read_only" as const;

/**
 * 🔴 THE GLOBAL SWITCH IS AN EVENT IN `platform_action_log`, NOT A ROW
 * SOMEBODY UPDATES.
 *
 * There is no platform-wide settings table in this schema and this batch
 * may not create one. What exists is an append-only log with a mandatory
 * justification, an actor, a severity and a jsonb payload — so global
 * maintenance is modelled as what it actually is: a sequence of decisions
 * by named people. The STATE is the latest decision.
 *
 * ⭐ THIS IS BETTER THAN A SETTINGS ROW, NOT A CONSOLATION. A mutable
 * boolean can be flipped and re-flipped leaving nothing behind; here,
 * "who put the product into read-only at 02:14 and what did they write
 * down" is answerable by construction, because turning it OFF does not
 * erase turning it ON.
 *
 * ⚠️ The cost is honest and worth naming: reading the state is "latest
 * row wins", so two operators writing in the same second resolve by
 * `created_at`. Both events survive; only the winner takes effect.
 */
export const MAINTENANCE_LOG_RESOURCE = "platform_maintenance" as const;
export const MAINTENANCE_LOG_RESOURCE_ID = "global" as const;

export type MaintenanceScope = "global" | "tenant";

/** What is stored, in the one shape everything downstream reads. */
export type MaintenanceState = {
  scope: MaintenanceScope;
  /** As recorded. Whether it is in force NOW is `isMaintenanceActive`. */
  enabled: boolean;
  /** ISO, or null for "until somebody turns it off". */
  endsAt: string | null;
  /** The operator's sentence, shown to the CUSTOMER. May be empty. */
  message: string;
  /** The operator's reason, shown to OPERATORS and written to audit. */
  reason: string;
  /** ISO. When it was switched on. */
  since: string | null;
  setBy: string | null;
};

/**
 * ⚠️ AN EXPIRED WINDOW IS OFF, EVERYWHERE, WITHOUT A JOB RUNNING.
 *
 * The end time is not a reminder to somebody: it is the thing evaluated
 * on every call. Nothing sweeps the row. If the process that would have
 * swept it is the process that is down — which is the situation
 * maintenance mode exists for — a swept-row design leaves the product
 * frozen after the window closes.
 */
export function isMaintenanceActive(
  state: MaintenanceState | null,
  now: Date = new Date(),
): state is MaintenanceState {
  if (!state || !state.enabled) return false;
  if (!state.endsAt) return true;
  const end = Date.parse(state.endsAt);
  if (Number.isNaN(end)) return true; // unparseable end → stay closed, not open
  return end > now.getTime();
}

/**
 * Operations that survive read-only mode.
 *
 * ⚠️ DELIBERATELY TINY, AND EVERY ENTRY IS AN ARGUMENT.
 *
 * Signing in and out are not changes to the customer's business data;
 * they are how a person stops being stuck on a page. Freezing them turns
 * a maintenance window into a lockout, and the first thing anybody does
 * when a product looks broken is sign out and back in.
 *
 * ⚠️ `support:` is NOT here. If we are read-only, our own staff writing
 * into the workspace is exactly the thing being paused.
 */
export const PERMITTED_DURING_MAINTENANCE = ["auth:", "session:"] as const;

export type MaintenanceVerdict = {
  allowed: boolean;
  /** Populated when refused. Shown verbatim; no error code archaeology. */
  reason: string | null;
  rule: "not_in_maintenance" | "read_permitted" | "exempt" | "refused";
  scope: MaintenanceScope | null;
};

/**
 * ⭐ THE DECISION. Reads are always allowed; writes are refused with a
 * sentence that names the scope and, when known, the end time.
 *
 * @param operation Namespaced, e.g. `"invoices:create"` — the SAME
 *                  vocabulary the impersonation gate uses, so a call site
 *                  declares its operation once and both gates read it.
 */
export function evaluateMaintenance(
  operation: string,
  state: MaintenanceState | null,
  now: Date = new Date(),
): MaintenanceVerdict {
  if (!isMaintenanceActive(state, now)) {
    return { allowed: true, reason: null, rule: "not_in_maintenance", scope: null };
  }
  if (!isWriteOperation(operation)) {
    return { allowed: true, reason: null, rule: "read_permitted", scope: state.scope };
  }
  if (PERMITTED_DURING_MAINTENANCE.some((p) => operation.startsWith(p))) {
    return { allowed: true, reason: null, rule: "exempt", scope: state.scope };
  }
  return {
    allowed: false,
    reason: refusalSentence(state, now),
    rule: "refused",
    scope: state.scope,
  };
}

/**
 * The sentence a customer reads when their save is refused.
 *
 * 🔴 IT SAYS WHAT IS HAPPENING, NOT THAT SOMETHING WENT WRONG. "Something
 * went wrong" during a planned window teaches people to distrust the
 * product for a thing we did on purpose.
 */
export function refusalSentence(state: MaintenanceState, now: Date = new Date()): string {
  const where =
    state.scope === "global"
      ? "Ordence is in maintenance mode"
      : "This workspace is in maintenance mode";
  const when = state.endsAt
    ? ` Expected to end in ${formatRemaining(remainingMs(state.endsAt, now))}.`
    : " No end time has been set yet.";
  const note = state.message.trim() ? ` ${state.message.trim()}` : "";
  return `${where}: changes are paused and nothing you type will be saved.${when}${note}`;
}

/** Milliseconds left, floored at zero. Never negative, never NaN. */
export function remainingMs(endsAt: string | null, now: Date = new Date()): number {
  if (!endsAt) return 0;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, end - now.getTime());
}

/**
 * "2 h 14 min", "9 min", "under a minute".
 *
 * ⚠️ WORDS, NOT A BARE `02:14`. One in twelve Indian men is colour-blind
 * and a red digital clock is not the only way this is misread — a bare
 * number is also ambiguous about its unit. The unit is always written.
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "no time left";
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 1) return "under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${totalMinutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

/**
 * The banner's one line.
 *
 * ⚠️ CARRIES THE WORD "READ-ONLY", not a colour and not an icon. The
 * banner is red; a colour-blind reader must lose nothing by not seeing
 * that it is red.
 */
export function maintenanceBannerText(
  state: MaintenanceState,
  now: Date = new Date(),
): string {
  const scope = state.scope === "global" ? "Ordence" : "This workspace";
  const tail = state.endsAt
    ? `ends in ${formatRemaining(remainingMs(state.endsAt, now))}`
    : "no end time set";
  return `${scope} is READ-ONLY — maintenance in progress — ${tail}`;
}

/** For the operator's screen. A word per state, never a colour alone. */
export function maintenanceStatusWord(
  state: MaintenanceState | null,
  now: Date = new Date(),
): "ON" | "SCHEDULED END PASSED" | "OFF" {
  if (!state || !state.enabled) return "OFF";
  return isMaintenanceActive(state, now) ? "ON" : "SCHEDULED END PASSED";
}
