/**
 * Ordence — ⭐ THE RATCHET: WHO IS ALLOWED TO CALL THE MAIL PROVIDER.
 * Track G / wave 17 / v1.83.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY A LIST AND NOT A PARAGRAPH
 * ══════════════════════════════════════════════════════════════════════
 * Wave 16 found four modules that call the provider directly, bypassing
 * `email_outbox` and therefore bypassing the suppression list, the attempt
 * ceiling, the retry schedule and the delivery record all at once. All four
 * are outside Track G's ownership, so the finding was written into a report.
 *
 * ⚠️ A FINDING IN A REPORT IS A FINDING THAT GETS RE-DISCOVERED. This project
 * has a name for the shape: declared and unenforced. So the list is data, in a
 * pure module, with a function that compares it against what is actually in
 * the repository — and the comparison is meant to be run by a test.
 *
 * ⭐ THE RULE IS ONE-WAY. An entry may be REMOVED when a module is moved onto
 * the outbox. An entry may never be ADDED. A new direct caller is a
 * regression, and the assertion that catches it is `diffProviderCallers`
 * returning a non-empty `added`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT "BYPASS" COSTS, SO THE LIST IS NOT READ AS BOOKKEEPING
 * ══════════════════════════════════════════════════════════════════════
 * A direct send is not merely un-retried. It is:
 *
 *   · UNSUPPRESSED. A hard-bounced mailbox is offered to the provider again
 *     on every run. Mail from every workspace leaves under ONE sending
 *     domain, so the reputation cost lands on tenants doing nothing wrong.
 *     It is the only email failure in this product that is not confined to
 *     the tenant causing it.
 *   · UNRECORDED. Nothing can answer "did we send it, and did it arrive".
 *     For `server/actions/contracts.ts` and `server/actions/portal.ts` that
 *     matters most: a contract sent to a counterparty is the kind of message
 *     somebody later has to prove was sent.
 *   · UNBOUNDED IN THE OTHER DIRECTION. A rate limit is logged and the
 *     message is gone.
 *
 * No I/O, no `server-only`, no `node:` imports. Pure and total, so the
 * comparison can run anywhere.
 */

/**
 * The module every path below imports from. Written in two pieces so that
 * this file does not itself match a grep for the import statement — a
 * catalogue that appears in its own scan is the `check:reachability` mistake
 * one layer down.
 */
export const PROVIDER_MODULE = ["@/lib/email", "resend"].join("/");

export type ProviderCallerKind =
  /** The one module that may send. Everything else routes through the outbox. */
  | "dispatcher"
  /** 🔴 Calls a send function directly. Every one of these is a defect. */
  | "bypass"
  /**
   * Imports only a predicate (`isEmailEnabled`, `isValidEmail`) and sends
   * nothing. Harmless, but listed: the import is what a future edit turns
   * into a send without anybody noticing it crossed a line.
   */
  | "predicate-only";

export type ProviderCaller = {
  readonly path: string;
  readonly kind: ProviderCallerKind;
  readonly why: string;
};

/**
 * ⚠️ VERIFIED BY GREP AGAINST 1.81.0-alpha AND RE-VERIFIED EACH WAVE, not
 * copied from a previous report. `lib/email/proofs/provider-callers.proof.ts`
 * is what re-verifies it.
 */
export const PROVIDER_CALLERS: readonly ProviderCaller[] = Object.freeze([
  Object.freeze({
    path: "server/email/outbox.ts",
    kind: "dispatcher",
    why:
      "The dispatcher. The only module permitted to send: it claims a row under a lease, checks the suppression list at send time, passes the same idempotency key on every attempt, and writes the outcome back.",
  }),
  Object.freeze({
    path: "server/actions/contracts.ts",
    kind: "bypass",
    why:
      "Calls sendContractReadyEmail directly at line 324. A contract sent to a counterparty is evidence somebody may later have to produce, and nothing records that it left.",
  }),
  Object.freeze({
    path: "server/actions/portal.ts",
    kind: "bypass",
    why:
      "Calls sendContractReadyEmail directly at line 278. Same message, same absence of a record, second call site.",
  }),
  Object.freeze({
    path: "server/platform/impersonation.ts",
    kind: "bypass",
    why:
      "Calls sendEmail directly at lines 1401 and 1483. These notify a workspace that a platform operator entered it — the one email whose non-delivery is itself a governance failure.",
  }),
  Object.freeze({
    path: "server/workflows/effects.ts",
    kind: "bypass",
    why:
      "Calls sendEmail directly at line 405, from a tenant-authored workflow. Tenant-authored means the volume is not ours to predict, which makes an unsuppressed, unbounded sender the worst of the four for the shared sending domain.",
  }),
  Object.freeze({
    path: "app/(crm)/contracts/[id]/page.tsx",
    kind: "predicate-only",
    why:
      "Imports isEmailEnabled to decide whether to show a button. Sends nothing. Listed so that the day it stops being predicate-only, the change is visible.",
  }),
] as const);

/** Just the paths, sorted, for a set comparison. */
export const PERMITTED_PROVIDER_CALLERS: readonly string[] = Object.freeze(
  PROVIDER_CALLERS.map((c) => c.path).sort(),
);

/** The ones that are defects rather than architecture. The number that must fall. */
export const PROVIDER_BYPASSES: readonly string[] = Object.freeze(
  PROVIDER_CALLERS.filter((c) => c.kind === "bypass")
    .map((c) => c.path)
    .sort(),
);

export function describeProviderCaller(path: string): ProviderCaller | undefined {
  return PROVIDER_CALLERS.find((c) => c.path === path);
}

export type ProviderCallerDiff = {
  /** 🔴 A caller in the repository that is not on the list. Always a regression. */
  readonly added: readonly string[];
  /** ⭐ A listed caller no longer in the repository. Progress — shrink the list. */
  readonly removed: readonly string[];
};

/**
 * ⭐ THE COMPARISON, PURE, SO THE TEST IS ONE CALL AND ONE ASSERTION.
 *
 * ⚠️ IT IS DELIBERATELY NOT SYMMETRIC IN MEANING. `added` must be empty or the
 * build is wrong. `removed` being non-empty is good news that still fails the
 * check — because a list that silently over-states the problem stops being
 * believed, and the whole point of a ratchet is that the number is trusted.
 */
export function diffProviderCallers(actual: readonly string[]): ProviderCallerDiff {
  const permitted = new Set(PERMITTED_PROVIDER_CALLERS);
  const found = new Set(actual);
  return Object.freeze({
    added: Object.freeze([...found].filter((p) => !permitted.has(p)).sort()),
    removed: Object.freeze([...permitted].filter((p) => !found.has(p)).sort()),
  });
}
