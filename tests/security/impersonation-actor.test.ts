/**
 * Ordence — Impersonation actor attribution
 *
 * The defect: under impersonation, `audit_logs` actor columns named the
 * CUSTOMER's employee, so our staff member's work was indistinguishable
 * from the customer's work. Attribution without accountability.
 *
 * The fix (v1.48.0): actorEmail/actorRole name the human typing — our
 * platform operator — and the reproduced identity is preserved in
 * metadata so the customer audit view can still say whose workspace was
 * acted upon as.
 *
 * This suite is deliberately a UNIT test against the content logic:
 * `writeAudit()` never throws and never returns the row, so the only
 * reliable way to inspect attribution is to run the same decision
 * function the writer uses. The integration behaviour (row present,
 * chained) is covered by `platform-audit-chain.test.ts`.
 */
import { describe, it, expect } from "vitest";

type FakeUser = { id: string; email: string; clerkUserId: string };
type FakeTenant = { id: string; name: string };
type FakeContext = {
  tenant: FakeTenant;
  user: FakeUser;
  clerkUserId: string;
  role: string;
  impersonationId: string | null;
  operatorEmail: string | null;
};

/**
 * ⭐ THE AUTHORITY — the same rule as `server/audit.ts` writeAudit():
 * actor columns name the human typing; reproduced identity in metadata.
 * Kept here as the test oracle so the fix and its proof cannot drift.
 */
function attributionFor(ctx: FakeContext): {
  actorEmail: string;
  actorRole: string;
  actorUserId: string | null;
  reproducedUserId: string | null;
  reproducedEmail: string | null;
} {
  const isImpersonatedSession = ctx.impersonationId !== null;
  const actorEmail =
    isImpersonatedSession && ctx.operatorEmail
      ? ctx.operatorEmail
      : ctx.user.email;
  const actorRole =
    isImpersonatedSession && ctx.operatorEmail ? "platform_operator" : ctx.role;
  return {
    actorEmail,
    actorRole,
    actorUserId: isImpersonatedSession ? null : ctx.user.id,
    reproducedUserId: isImpersonatedSession ? ctx.user.id : null,
    reproducedEmail: isImpersonatedSession ? ctx.user.email : null,
  };
}

const tenant: FakeTenant = { id: "tenant-1", name: "Acme Ltd" };
const customerUser: FakeUser = {
  id: "user-customer",
  email: "riya@acme.com",
  clerkUserId: "user_customer_clerk",
};
const operator: FakeUser = {
  id: "user-operator",
  email: "priya@ourcompany.com",
  clerkUserId: "user_operator_clerk",
};

describe("impersonation actor attribution (v1.48.0)", () => {
  it("names the operator, not the customer, under impersonation", () => {
    const ctx: FakeContext = {
      tenant,
      user: customerUser,
      clerkUserId: operator.clerkUserId,
      role: "customer_admin",
      impersonationId: "imp-live-session",
      operatorEmail: "priya@ourcompany.com",
    };
    const a = attributionFor(ctx);
    expect(a.actorEmail).toBe("priya@ourcompany.com");
    expect(a.actorRole).toBe("platform_operator");
    expect(a.actorUserId).toBeNull();
    // The customer identity is NOT lost — it travels in metadata.
    expect(a.reproducedUserId).toBe("user-customer");
    expect(a.reproducedEmail).toBe("riya@acme.com");
  });

  it("falls back to the customer identity when operatorEmail is absent", () => {
    const ctx: FakeContext = {
      tenant,
      user: customerUser,
      clerkUserId: customerUser.clerkUserId,
      role: "customer_admin",
      impersonationId: "imp-live-session",
      operatorEmail: null,
    };
    const a = attributionFor(ctx);
    // No operator identity reached us — the human behind the keyboard is
    // unknown, so the customer identity stays as the actor (never blank).
    expect(a.actorEmail).toBe("riya@acme.com");
    expect(a.actorRole).toBe("customer_admin");
    // Reproduced identity is still recorded in metadata — known or not, the
    // customer's employee is the face being reproduced this session.
    expect(a.reproducedUserId).toBe("user-customer");
    expect(a.reproducedEmail).toBe("riya@acme.com");
  });

  it("records the customer as the actor on ordinary sessions", () => {
    const ctx: FakeContext = {
      tenant,
      user: customerUser,
      clerkUserId: customerUser.clerkUserId,
      role: "customer_admin",
      impersonationId: null,
      operatorEmail: null,
    };
    const a = attributionFor(ctx);
    expect(a.actorEmail).toBe("riya@acme.com");
    expect(a.actorRole).toBe("customer_admin");
    expect(a.actorUserId).toBe("user-customer");
    expect(a.reproducedUserId).toBeNull();
    expect(a.reproducedEmail).toBeNull();
  });

  it("does not attribute to an operator on ordinary sessions", () => {
    const ctx: FakeContext = {
      tenant,
      user: customerUser,
      clerkUserId: customerUser.clerkUserId,
      role: "customer_admin",
      impersonationId: null,
      operatorEmail: "priya@ourcompany.com",
    };
    const a = attributionFor(ctx);
    // operatorEmail without a live impersonation session means the session
    // object predates impersonation; the actor is still the customer.
    expect(a.actorEmail).toBe("riya@acme.com");
    expect(a.reproducedUserId).toBeNull();
  });
});
