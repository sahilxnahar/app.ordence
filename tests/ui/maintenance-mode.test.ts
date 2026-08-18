/**
 * Ordence — Maintenance mode: PROPERTIES, NOT SHAPES
 *
 * ⚠️ THE TEST THAT MATTERS IS THE LAST BLOCK: a write is refused at the
 * gate every tenant mutation already calls. Everything above it is the
 * policy that gate consults. None of it asserts a button is hidden — a
 * hidden button is a mistake guard and proves nothing about the boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateMaintenance,
  isMaintenanceActive,
  refusalSentence,
  remainingMs,
  formatRemaining,
  maintenanceStatusWord,
  MAINTENANCE_FLAG_KEY,
  type MaintenanceState,
} from "@/lib/platform/maintenance-policy";
import { isFlagKey, flagDefinitionFor } from "@/lib/platform/flags-catalog";

const NOW = new Date("2026-08-18T10:00:00.000Z");

function state(over: Partial<MaintenanceState> = {}): MaintenanceState {
  return {
    scope: "global",
    enabled: true,
    endsAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
    message: "",
    reason: "Migrating the ledger partition on the primary.",
    since: NOW.toISOString(),
    setBy: "ops@ordence.com",
    ...over,
  };
}

/* Deliberately spans verbs nobody has classified: the property is that
   anything not positively a read is refused, not that this list is. */
const WRITE_LIKE = [
  "invoices:create",
  "contacts:update",
  "delete:contact",
  "periods:close",
  "orders:frobnicate",
  "something:entirely_new",
];
const READ_LIKE = [
  "invoices:read",
  "contacts:list",
  "reports:view",
  "search:search",
  "documents:get",
  "invoice:preview",
  "contacts:read_many",
];

describe("maintenance policy — what it refuses", () => {
  it("refuses every operation that is not positively a read, while active", () => {
    for (const op of WRITE_LIKE) {
      const verdict = evaluateMaintenance(op, state(), NOW);
      expect(verdict.allowed, op).toBe(false);
      expect(verdict.reason, op).toBeTruthy();
    }
  });

  it("never refuses a read, so the product stays usable while frozen", () => {
    for (const op of READ_LIKE) {
      expect(evaluateMaintenance(op, state(), NOW).allowed, op).toBe(true);
    }
  });

  it("lets people sign in and out, because a freeze is not a lockout", () => {
    expect(evaluateMaintenance("auth:sign_out", state(), NOW).allowed).toBe(true);
    expect(evaluateMaintenance("session:end", state(), NOW).allowed).toBe(true);
  });

  it("refuses nothing when no window is on", () => {
    for (const op of [...WRITE_LIKE, ...READ_LIKE]) {
      expect(evaluateMaintenance(op, null, NOW).allowed, op).toBe(true);
      expect(evaluateMaintenance(op, state({ enabled: false }), NOW).allowed, op).toBe(true);
    }
  });

  it("stops enforcing the moment the stored end time has passed, with nothing sweeping it", () => {
    const past = state({ endsAt: new Date(NOW.getTime() - 1_000).toISOString() });
    expect(isMaintenanceActive(past, NOW)).toBe(false);
    for (const op of WRITE_LIKE) {
      expect(evaluateMaintenance(op, past, NOW).allowed, op).toBe(true);
    }
    // ...and the operator can still see the row, worded, rather than it
    // vanishing: "OFF" and "END PASSED" are different facts.
    expect(maintenanceStatusWord(past, NOW)).not.toBe(maintenanceStatusWord(null, NOW));
  });

  it("keeps enforcing with no end time at all", () => {
    const open = state({ endsAt: null });
    expect(isMaintenanceActive(open, NOW)).toBe(true);
    expect(evaluateMaintenance("invoices:create", open, NOW).allowed).toBe(false);
  });

  it("says what is happening and when it ends, in words, not in a colour", () => {
    const s = state();
    const sentence = refusalSentence(s, NOW);
    // The property: the sentence carries the remaining time DERIVED from
    // the stored timestamp, whatever that formatting happens to be.
    expect(sentence).toContain(formatRemaining(remainingMs(s.endsAt, NOW)));
    expect(sentence.toLowerCase()).toContain("maintenance");
    // Scope is distinguishable without seeing any styling.
    expect(refusalSentence(state({ scope: "tenant" }), NOW)).not.toEqual(sentence);
  });

  it("carries the operator's own sentence to the customer, verbatim", () => {
    const note = "The GST filing window reopens at 14:00 IST.";
    expect(refusalSentence(state({ message: note }), NOW)).toContain(note);
  });
});

describe("the countdown cannot be stretched by a paused tab", () => {
  it("is a pure function of the stored end time and the clock", () => {
    const endsAt = new Date(NOW.getTime() + 45 * 60_000).toISOString();
    // "Ticked" a hundred times versus computed once: identical, because
    // nothing is being decremented.
    let ticked = 0;
    for (let i = 0; i < 100; i += 1) ticked = remainingMs(endsAt, NOW);
    expect(ticked).toBe(remainingMs(endsAt, NOW));

    // A tab asleep for ten minutes wakes to LESS time, never more.
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect(remainingMs(endsAt, later)).toBeLessThan(remainingMs(endsAt, NOW));
    expect(remainingMs(endsAt, later)).toBe(remainingMs(endsAt, NOW) - 10 * 60_000);
  });

  it("floors at zero and never reports a negative or unparseable window", () => {
    expect(remainingMs(new Date(NOW.getTime() - 9e6).toISOString(), NOW)).toBe(0);
    expect(remainingMs("not a timestamp", NOW)).toBe(0);
    expect(remainingMs(null, NOW)).toBe(0);
  });

  it("always states a unit, so the number is never ambiguous", () => {
    for (const ms of [1, 59_000, 60_000, 3_600_000, 7_500_000]) {
      expect(formatRemaining(ms)).toMatch(/[a-z]/i);
    }
  });
});

describe("the per-tenant switch reuses the existing flag mechanism", () => {
  it("is a real, registered flag rather than an invented key", () => {
    expect(isFlagKey(MAINTENANCE_FLAG_KEY)).toBe(true);
  });

  it("is a kill switch, so it is not forced to expire", () => {
    const def = flagDefinitionFor(MAINTENANCE_FLAG_KEY);
    expect(def).not.toBeNull();
    expect(def?.isKillSwitch).toBe(true);
    expect(def?.grantsPaidCapability).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   🔴 THE ONE THAT MATTERS: A WRITE IS ACTUALLY REFUSED AT THE GATE.
   ══════════════════════════════════════════════════════════════════════
   Not "the save button is hidden". This calls the same function every
   tenant-side mutation in the codebase calls — Batch 28's
   `assertImpersonationAllows` — with nobody impersonating, and expects it
   to throw because the product is paused. */

function chain(rows: unknown[]) {
  const self: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "orderBy", "limit", "innerJoin"]) {
    self[m] = () => self;
  }
  self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return self;
}

async function loadGate(globalRow: unknown | null) {
  vi.resetModules();
  vi.doMock("@/db", () => ({
    withPlatformScope: async (_reason: string, cb: (db: unknown) => Promise<unknown>) =>
      cb({ select: () => chain(globalRow ? [globalRow] : []) }),
    withTenant: async () => {
      throw new Error("withTenant must not be reached by the maintenance gate.");
    },
  }));
  return import("@/server/platform/impersonation");
}

describe("enforcement: the gate every mutation calls", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("@/db"));

  const facts = {
    impersonationId: null,
    impersonationScope: null,
    tenant: { id: "11111111-1111-4111-8111-111111111111" },
  };

  it("REFUSES a write when global maintenance is on, with nobody impersonating", async () => {
    const gate = await loadGate({
      metadata: { enabled: true, endsAt: null, message: "" },
      justification: "Rebuilding the invoice index across the fleet.",
      createdAt: new Date(),
      actorEmail: "ops@ordence.com",
    });

    await expect(gate.assertImpersonationAllows("invoices:create", facts)).rejects.toThrow(
      /maintenance/i,
    );
  });

  it("still allows reads while refusing writes", async () => {
    const gate = await loadGate({
      metadata: { enabled: true, endsAt: null, message: "" },
      justification: "Rebuilding the invoice index across the fleet.",
      createdAt: new Date(),
      actorEmail: "ops@ordence.com",
    });

    await expect(
      gate.assertImpersonationAllows("invoices:read", facts),
    ).resolves.toBeUndefined();
  });

  it("allows the same write once the switch is off", async () => {
    const gate = await loadGate({
      metadata: { enabled: false, endsAt: null, message: "" },
      justification: "Lifted after the index rebuild finished.",
      createdAt: new Date(),
      actorEmail: "ops@ordence.com",
    });

    await expect(
      gate.assertImpersonationAllows("invoices:create", facts),
    ).resolves.toBeUndefined();
  });

  it("allows writes when no decision has ever been recorded", async () => {
    const gate = await loadGate(null);
    await expect(
      gate.assertImpersonationAllows("invoices:create", facts),
    ).resolves.toBeUndefined();
  });
});
