/**
 * Ordence — Impersonation Hardening (Batch 28)
 *
 * ══════════════════════════════════════════════════════════════════════
 * FOUR PROPERTIES, EACH OF WHICH WOULD FAIL SILENTLY
 * ══════════════════════════════════════════════════════════════════════
 *   1. A SESSION IS READ-ONLY UNTIL SOMEBODY DELIBERATELY LIFTS IT, and
 *      the lift can never exceed what the customer permitted.
 *   2. THIRTY MINUTES IS A CEILING ON THE STORED ROW, not only on new
 *      sessions — a row written with a longer expiry is still over at
 *      minute thirty, computed from a start time nothing can change.
 *   3. THE CUSTOMER'S BANNER NAMES THE HUMAN, THE REASON AND THE TIME,
 *      carries every state in WORDS, and has no way to make it go away
 *      other than ending the access.
 *   4. THE POLL STOPS WHEN NOBODY IS LOOKING and catches up the instant
 *      somebody is.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THESE ASSERTIONS DELIBERATELY DO NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * They do not pin a sentence, an href, a file path or a literal count.
 * Four tests in this repository have had to be rewritten for exactly
 * those, and every one of them broke while the code was getting BETTER.
 *
 * So: a refusal is asserted to BE a refusal and to mention the thing it
 * is about, never to equal a string. A duration is asserted against
 * `HARD_CAP_MINUTES` rather than against `30`. A state is asserted to
 * carry non-empty text that differs from the other state's, rather than
 * to read "Read only". Rewording any of this leaves the suite green;
 * removing the property does not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useVisiblePoll } from "@/components/platform/use-visible-poll";

import {
  HARD_CAP_MINUTES,
  MAX_SESSION_MINUTES,
  SESSION_MINUTES,
  SCOPE_LIFT_MIN_REASON,
  SCOPE_LIFT_RESOURCE,
  END_REASON_LABELS,
  cappedExpiry,
  effectiveScope,
  endReasonLabel,
  evaluateOperation,
  expiryFor,
  isSessionLive,
  minutesRemaining,
  resolveScope,
  scopeLiftProblem,
  sessionMinutes,
  MAX_SCOPE,
} from "@/lib/platform/impersonation-policy";

import { liftImpersonationScopeSchema } from "@/lib/platform/schemas";

const MODES = ["standing_consent", "incident_consent", "break_glass"] as const;
const SCOPES = ["read_only", "read_write"] as const;

const NOW = new Date("2026-08-17T09:00:00.000Z");
const minutes = (n: number) => n * 60_000;
const at = (offsetMinutes: number) => new Date(NOW.getTime() + minutes(offsetMinutes));

/* ================================================================== */
/* 1. READ-ONLY BY DEFAULT                                            */
/* ================================================================== */

describe("a session may read; writing is a separate act", () => {
  it("⭐ starts read-only for EVERY mode and EVERY consent, with no lift", () => {
    for (const mode of MODES) {
      for (const consent of [...SCOPES, null]) {
        const ceiling = resolveScope(mode, consent);
        expect(effectiveScope({ ceiling, lifted: false })).toBe("read_only");
      }
    }
  });

  it("⭐ a lift can never exceed what the customer permitted", () => {
    // The lift is a claim on an existing grant, not a grant of its own.
    expect(effectiveScope({ ceiling: "read_only", lifted: true })).toBe("read_only");
    expect(effectiveScope({ ceiling: "read_write", lifted: true })).toBe("read_write");
  });

  it("🔴 a WRITE is refused under the effective scope even when consent allowed it", () => {
    // This is the property the whole batch turns on: consent said
    // read-write, nobody lifted, so the write gate must still refuse.
    const scope = effectiveScope({ ceiling: "read_write", lifted: false });

    for (const op of [
      "contacts:update",
      "leads:create",
      "invoices:issue",
      "bookings:cancel",
      // ⚠️ A verb invented next year. The classifier fails closed, so
      // this must be refused too rather than quietly admitted.
      "widgets:frobnicate",
    ]) {
      const verdict = evaluateOperation(op, scope);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason ?? "").not.toHaveLength(0);
    }
  });

  it("reads are still permitted — the refusal is about changing, not looking", () => {
    const scope = effectiveScope({ ceiling: "read_write", lifted: false });
    for (const op of ["contacts:read", "invoices:list", "reports:view", "ledger:search"]) {
      expect(evaluateOperation(op, scope).allowed).toBe(true);
    }
  });

  it("once lifted, ordinary writes pass but the forbidden list still refuses", () => {
    const scope = effectiveScope({ ceiling: "read_write", lifted: true });
    expect(evaluateOperation("contacts:update", scope).allowed).toBe(true);

    // Consent is not a blank cheque. These outlive the session or cannot
    // be undone by the customer, and no lift reaches them.
    for (const op of ["roles:update", "users:invite", "delete:contact", "export:workspace"]) {
      expect(evaluateOperation(op, scope).allowed).toBe(false);
    }
  });
});

describe("the refusals guarding the lift itself", () => {
  const longEnough = "x".repeat(SCOPE_LIFT_MIN_REASON + 5);

  it("🔴 break-glass can NEVER be lifted, whatever the ceiling or the reason", () => {
    for (const ceiling of SCOPES) {
      const problem = scopeLiftProblem({
        mode: "break_glass",
        ceiling,
        alreadyLifted: false,
        reason: longEnough,
      });
      expect(problem).toBeTruthy();
      // The sentence has to say WHICH rule refused, or the operator's
      // next move is a database client.
      expect(problem).toMatch(/break-glass/i);
    }
  });

  it("a read-only consent cannot be widened from our side", () => {
    for (const mode of ["standing_consent", "incident_consent"] as const) {
      expect(
        scopeLiftProblem({
          mode,
          ceiling: "read_only",
          alreadyLifted: false,
          reason: longEnough,
        }),
      ).toBeTruthy();
    }
  });

  it("a lifted session cannot be lifted again", () => {
    expect(
      scopeLiftProblem({
        mode: "standing_consent",
        ceiling: "read_write",
        alreadyLifted: true,
        reason: longEnough,
      }),
    ).toBeTruthy();
  });

  it("⭐ the reason floor is enforced at the boundary, not one character below it", () => {
    const base = {
      mode: "standing_consent" as const,
      ceiling: "read_write" as const,
      alreadyLifted: false,
    };
    expect(
      scopeLiftProblem({ ...base, reason: "x".repeat(SCOPE_LIFT_MIN_REASON - 1) }),
    ).toBeTruthy();
    expect(
      scopeLiftProblem({ ...base, reason: "x".repeat(SCOPE_LIFT_MIN_REASON) }),
    ).toBeNull();
    // Whitespace is not a reason.
    expect(
      scopeLiftProblem({ ...base, reason: " ".repeat(SCOPE_LIFT_MIN_REASON + 10) }),
    ).toBeTruthy();
  });

  it("the schema and the policy agree about how long a reason must be", () => {
    // Two independent floors that disagree means one of them is dead
    // code, and the dead one is always the stricter.
    expect(
      liftImpersonationScopeSchema.safeParse({
        sessionId: "00000000-0000-4000-8000-000000000000",
        reason: "x".repeat(SCOPE_LIFT_MIN_REASON - 1),
      }).success,
    ).toBe(false);
    expect(
      liftImpersonationScopeSchema.safeParse({
        sessionId: "00000000-0000-4000-8000-000000000000",
        reason: "x".repeat(SCOPE_LIFT_MIN_REASON),
      }).success,
    ).toBe(true);
  });

  it("break-glass's ceiling is read-only, so the lift path can never open for it", () => {
    // Belt and braces: the refusal above is explicit, and the scope
    // resolution makes it unreachable anyway.
    expect(MAX_SCOPE.break_glass).toBe("read_only");
    expect(resolveScope("break_glass", "read_write")).toBe("read_only");
  });

  it("the register resource type is a single shared constant", () => {
    // Three modules write, read and report on this string. It only has
    // to be non-empty and stable within a run — what matters is that
    // there is ONE of it.
    expect(SCOPE_LIFT_RESOURCE.trim()).not.toHaveLength(0);
  });
});

/* ================================================================== */
/* 2. THE THIRTY-MINUTE HARD CAP                                       */
/* ================================================================== */

describe("the hard cap on how long anyone can be inside", () => {
  it("⭐ no mode can ask for more than the cap", () => {
    expect(MAX_SESSION_MINUTES).toBeLessThanOrEqual(HARD_CAP_MINUTES);
    for (const mode of MODES) {
      expect(SESSION_MINUTES[mode]).toBeLessThanOrEqual(HARD_CAP_MINUTES);
      expect(sessionMinutes(mode)).toBeLessThanOrEqual(HARD_CAP_MINUTES);
      const expires = expiryFor(mode, NOW);
      expect(expires.getTime() - NOW.getTime()).toBeLessThanOrEqual(
        minutes(HARD_CAP_MINUTES),
      );
    }
  });

  it("🔴 a STORED row with a longer expiry is still over at the cap", () => {
    // The `expires_at` column is frozen by the database trigger, so a
    // session started before the cap existed cannot be rewritten. It is
    // re-decided instead, from `started_at`.
    const legacy = {
      startedAt: NOW,
      expiresAt: at(HARD_CAP_MINUTES * 3),
      endedAt: null,
    };

    expect(isSessionLive(legacy, at(HARD_CAP_MINUTES - 1))).toBe(true);
    expect(isSessionLive(legacy, at(HARD_CAP_MINUTES + 1))).toBe(false);
    expect(minutesRemaining(legacy, at(HARD_CAP_MINUTES + 1))).toBe(0);
    expect(minutesRemaining(legacy, NOW)).toBeLessThanOrEqual(HARD_CAP_MINUTES);
  });

  it("⭐ the cap can only ever SHORTEN a session, never extend one", () => {
    for (const storedMinutes of [1, 5, HARD_CAP_MINUTES - 1, HARD_CAP_MINUTES, 90, 600]) {
      const session = {
        startedAt: NOW,
        expiresAt: at(storedMinutes),
        endedAt: null,
      };
      expect(cappedExpiry(session).getTime()).toBeLessThanOrEqual(
        session.expiresAt.getTime(),
      );
      expect(cappedExpiry(session).getTime()).toBeLessThanOrEqual(
        NOW.getTime() + minutes(HARD_CAP_MINUTES),
      );
    }
  });

  it("a session shorter than the cap keeps its own, shorter deadline", () => {
    // Break-glass is deliberately shorter. The cap must not lengthen it.
    const short = { startedAt: NOW, expiresAt: at(5), endedAt: null };
    expect(isSessionLive(short, at(4))).toBe(true);
    expect(isSessionLive(short, at(6))).toBe(false);
  });

  it("🔴 remaining time is derived from the STORED start, not from anything handed in", () => {
    // A client that sends "I have 999 minutes left" changes nothing:
    // the only inputs consulted are the two frozen timestamps and the
    // server's own clock.
    const session = { startedAt: NOW, expiresAt: at(120), endedAt: null };
    const withNoise = { ...session, minutesLeft: 999, expiresAtClient: at(9999) };

    expect(cappedExpiry(withNoise).getTime()).toBe(cappedExpiry(session).getTime());
    expect(minutesRemaining(withNoise, at(5))).toBe(minutesRemaining(session, at(5)));
  });

  it("a closed session is closed whatever the clock says", () => {
    const closed = { startedAt: NOW, expiresAt: at(20), endedAt: at(2) };
    expect(isSessionLive(closed, at(3))).toBe(false);
    expect(minutesRemaining(closed, at(3))).toBe(0);
  });
});

/* ================================================================== */
/* 3. HOW A SESSION ENDED IS RECORDED IN WORDS                         */
/* ================================================================== */

describe("every ending carries a word, not a colour", () => {
  const keys = Object.keys(END_REASON_LABELS);

  it("⭐ the three endings that matter each have their own label", () => {
    // Expiry, the operator leaving, and the workspace ejecting us are
    // genuinely different events and a register that blurred them would
    // be unable to answer the question it exists for.
    for (const key of ["expired", "operator_ended", "revoked_by_tenant"]) {
      expect(keys).toContain(key);
    }
  });

  it("every label is a phrase a person can read, and no two are the same", () => {
    const seen = new Set<string>();
    for (const key of keys) {
      const label = endReasonLabel(key);
      expect(label.trim().length).toBeGreaterThan(0);
      // A phrase, not the enum token echoed back.
      expect(label.trim().split(/\s+/).length).toBeGreaterThan(1);
      expect(label).not.toBe(key);
      expect(seen.has(label)).toBe(false);
      seen.add(label);
    }
  });

  it("an unrecognised or absent reason still produces something readable", () => {
    // A blank cell reads as "nothing happened", which is the one thing
    // it definitely does not mean.
    expect(endReasonLabel(null).trim()).not.toHaveLength(0);
    expect(endReasonLabel("some_reason_added_next_year").trim()).not.toHaveLength(0);
  });
});

/* ================================================================== */
/* 4. THE BANNER THE CUSTOMER SEES                                     */
/* ================================================================== */

import { SupportAccessBanner } from "@/components/platform/support-access-banner";

const bannerProps = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  operatorEmail: "aparna@ordence.example",
  authority: "Standing consent",
  mode: "standing_consent",
  scope: "read_only",
  reason: "Ticket ORD-4471: the March GST return will not generate.",
  expiresAt: new Date(Date.now() + minutes(12)).toISOString(),
  minutesLeft: 12,
  viewer: "owner" as const,
};

describe("the workspace's own support-access banner", () => {
  it("⭐ names the human, so the customer has somebody to ask about", () => {
    render(<SupportAccessBanner {...bannerProps} />);
    expect(screen.getByText(bannerProps.operatorEmail)).toBeInTheDocument();
  });

  it("⭐ states the reason the operator gave", () => {
    render(<SupportAccessBanner {...bannerProps} />);
    expect(screen.getByTestId("support-access-banner")).toHaveTextContent(
      bannerProps.reason,
    );
  });

  it("⭐ shows how long is left rather than only that access exists", () => {
    render(<SupportAccessBanner {...bannerProps} />);
    const countdown = screen.getByTestId("support-access-countdown");
    // A number of some kind. Which number, and how it is worded, is not
    // this test's business.
    expect(countdown.textContent ?? "").toMatch(/\d/);
  });

  it("⭐⭐ the read-only and read-write states differ in WORDS, not only colour", () => {
    const { unmount } = render(<SupportAccessBanner {...bannerProps} scope="read_only" />);
    const readOnlyText = screen.getByTestId("support-access-scope").textContent ?? "";
    unmount();

    render(<SupportAccessBanner {...bannerProps} scope="read_write" />);
    const readWriteText = screen.getByTestId("support-access-scope").textContent ?? "";

    expect(readOnlyText.trim()).not.toHaveLength(0);
    expect(readWriteText.trim()).not.toHaveLength(0);
    expect(readOnlyText).not.toBe(readWriteText);
  });

  it("🔴 there is NO way to dismiss it — the only control ends the access", async () => {
    render(<SupportAccessBanner {...bannerProps} onEnd={async () => ({ ok: true })} />);
    for (const label of [/dismiss/i, /close/i, /hide/i, /got it/i, /understood/i]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    // Whatever buttons exist, every one of them is about ending access.
    for (const button of screen.getAllByRole("button")) {
      expect(button.textContent ?? "").toMatch(/end|leave/i);
    }
  });

  it("a member with no authority gets the notice and no button at all", () => {
    render(<SupportAccessBanner {...bannerProps} viewer="member" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // …but is told who at their own company can act, so the notice is
    // not a worry with no remedy.
    expect(screen.getByTestId("support-access-banner")).toHaveTextContent(/owner|admin/i);
  });

  it("announces itself to assistive technology", () => {
    render(<SupportAccessBanner {...bannerProps} />);
    const banner = screen.getByTestId("support-access-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveAttribute("aria-live", "assertive");
  });

  it("says so when write access has been taken, and why", () => {
    render(
      <SupportAccessBanner
        {...bannerProps}
        scope="read_write"
        writeAccessReason="Correcting the HSN code on invoice INV-2291."
      />,
    );
    expect(screen.getByTestId("support-access-banner")).toHaveTextContent(
      /HSN code on invoice INV-2291/,
    );
  });
});

/* ================================================================== */
/* 5. THE POLL PAUSES WHEN NOBODY IS LOOKING                           */
/* ================================================================== */

/**
 * ⚠️ A LOCAL ROUTER MOCK IS NOT NEEDED HERE — the hook is exercised
 * directly, with a spy of our own, because what is being asserted is the
 * hook's behaviour and not any particular component's use of it.
 */
function Poller({ tick, intervalMs }: { tick: () => void; intervalMs: number }) {
  useVisiblePoll(tick, intervalMs);
  return null;
}

function setHidden(value: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("the visibility-aware poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("polls while the tab is visible", () => {
    const tick = vi.fn();
    render(<Poller tick={tick} intervalMs={1000} />);

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(tick.mock.calls.length).toBeGreaterThan(0);
  });

  it("🔴 fires NOTHING while the tab is hidden", () => {
    const tick = vi.fn();
    render(<Poller tick={tick} intervalMs={1000} />);

    act(() => {
      setHidden(true);
    });
    tick.mockClear();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // A background tab left open overnight must not issue a request
    // every interval for a screen nobody is looking at.
    expect(tick).not.toHaveBeenCalled();
  });

  it("⭐ catches up IMMEDIATELY when the tab becomes visible again", () => {
    const tick = vi.fn();
    render(<Poller tick={tick} intervalMs={1000} />);

    act(() => {
      setHidden(true);
      vi.advanceTimersByTime(60_000);
    });
    tick.mockClear();

    act(() => {
      setHidden(false);
    });
    // Somebody returning to a tab they left ten minutes ago must not
    // spend another interval reading a banner about a session that
    // ended while they were away.
    expect(tick).toHaveBeenCalled();
  });

  it("stops entirely once unmounted, so a closed banner leaves no timer behind", () => {
    const tick = vi.fn();
    const { unmount } = render(<Poller tick={tick} intervalMs={1000} />);
    unmount();
    tick.mockClear();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(tick).not.toHaveBeenCalled();
  });
});
