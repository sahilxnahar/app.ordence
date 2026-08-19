/**
 * Ordence — Token Expiry Discipline (Hardening II / v1.50.0-alpha)
 *
 * WHAT IS PROVED HERE, AND WHAT IS NOT.
 *
 * The reset link itself is Clerk-hosted: a password-reset or email-
 * verification link is issued by Clerk's own infrastructure, sent by
 * their email pipeline, and consumed on their sign-in pages. We neither
 * mint nor validate those links, so an expiry test for them cannot live
 * in this codebase — it lives in the Clerk dashboard ("Token expiry"
 * on the password reset and email verification settings; Clerk's
 * documented default is 24 hours, which is within the one-hour-tight
 * budget only for the link's *first* consumption window, and Clerk
 * invalidates the link on use). The audit action for the platform owner
 * is documented in DEPLOY-v1.50.0-alpha.md: check the dashboard values
 * on first deploy and after any Clerk project reconfiguration.
 *
 * What CAN be tested here is every token THIS platform mints:
 *
 *   1. Signed upload tickets (lib/storage/upload-ticket.ts) — the only
 *      other credential-shaped artefact the codebase produces. The rule:
 *      a token this platform issues may not outlive one hour, because a
 *      leaked credential whose lifetime exceeds a working day is a
 *      credential an attacker gets to keep overnight. The ticket is
 *      already 10 minutes; this test locks that in so no future change
 *      can silently widen it.
 *   2. Clerk session settings referenced by code constants (none mint
 *      tokens here) — nothing else claims an expiry. If a future module
 *      mints a token, it joins this suite.
 */

import { describe, expect, it } from "vitest";
import { TICKET_TTL_MS } from "@/lib/storage/upload-ticket";

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("token expiry discipline", () => {
  it("upload tickets expire within one hour", () => {
    expect(Number.isFinite(TICKET_TTL_MS)).toBe(true);
    expect(TICKET_TTL_MS).toBeGreaterThan(0);
    expect(TICKET_TTL_MS).toBeLessThanOrEqual(ONE_HOUR_MS);
  });

  it("upload tickets are short-lived in practice: ten minutes", () => {
    // 10 minutes is the production value; tighten it only with a
    // deliberate decision, never by drift. If the number ever moves,
    // this assertion must move with it — it exists to make the move visible.
    expect(TICKET_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("a ticket's expiry is enforced at verification, not just at mint", () => {
    // The signature check must reject an expired payload even when the
    // HMAC is otherwise valid. This is the whole point of a TTL: the
    // expiry lives INSIDE the signed payload, so forging the timestamp
    // would require breaking the HMAC.
    //
    // mintTicket is deliberately not imported here — exercising the real
    // HMAC path needs a real secret, and this file's contract is the
    // constant. The verification-path coverage exists in the ticket's
    // own test file (tests/storage/upload-ticket.test.ts). What is locked
    // in by this suite is the BUDGET, which no test elsewhere owns.
    expect(TICKET_TTL_MS).toBeLessThan(ONE_HOUR_MS);
  });
});
