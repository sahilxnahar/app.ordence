/**
 * Ordence — The Billing Gate, read as source (S1)
 * Version: v0.83.2-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE READ SOURCE RATHER THAN RUNNING IT
 * ══════════════════════════════════════════════════════════════════════
 * Same reasoning as `tests/ui/contracting-sql-invariants.test.ts`: the
 * `ui` project runs in jsdom with no database, by design, so a developer
 * with no Postgres can still run it. Behavioural proof of the gate lives
 * in `tests/security/billing-gate.test.ts`.
 *
 * What these defend is different, cheaper, and — for this particular
 * defect — more important.
 *
 * ⚠️ THE ORIGINAL BUG WAS NOT A BROKEN GATE. IT WAS AN UNCALLED ONE.
 *
 * `requireAccess()` was correct, tested, and had 17 call sites where 151
 * were needed. Every behavioural test of the gate passed the entire time.
 * They tested the gate; nothing tested whether anything called it.
 *
 * That is the same failure mode this codebase has hit twice before and
 * written down both times: the impersonation trigger installed on
 * nineteen tables that nothing armed until v0.31.0, and the twenty-three
 * UI suites that were present, imported nothing that failed, and were
 * never collected. A guard that is not invoked is indistinguishable from
 * a guard that passes.
 *
 * So these tests assert the WIRING. They are deliberately dumb string
 * checks, and that is the point — they fail the moment somebody adds a
 * write without the guard, which no behavioural test would notice.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/* ------------------------------------------------------------------ */

const WRITE_PATHS: [file: string, fns: string[]][] = [
  ["server/actions/contacts.ts", ["createContact", "updateContact", "deleteContact"]],
  ["server/actions/companies.ts", ["createCompany", "updateCompany", "deleteCompany"]],
];

/** The body of one exported function, up to the next exported function. */
function bodyOf(src: string, fn: string): string | null {
  const start = src.indexOf(`export async function ${fn}`);
  if (start === -1) return null;
  const next = src.indexOf("\nexport async function ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("core CRM writes are wired to the billing gate", () => {
  for (const [file, fns] of WRITE_PATHS) {
    const src = readFileSync(file, "utf8");

    for (const fn of fns) {
      it(`⭐ ${fn}() calls requireAccess()`, () => {
        const body = bodyOf(src, fn);
        expect(body, `${fn} not found in ${file} — was it renamed?`).not.toBeNull();
        expect(body!, `${fn} does not call requireAccess()`).toMatch(/await requireAccess\(/);
      });

      it(`${fn}() gates BEFORE it validates`, () => {
        /*
         * ⚠️ ORDER MATTERS, AND NOT COSMETICALLY. A restricted workspace
         * should be told it is read-only, not handed a field-level
         * validation error for a form it was never going to be allowed to
         * submit. Reversing these two produces a confusing refusal that
         * reads like a bug in the form.
         */
        const body = bodyOf(src, fn)!;
        const gate = body.indexOf("await requireAccess(");
        const parse = body.search(/Schema\.parse\(|uuidSchema\.parse\(/);

        if (parse === -1) return; // nothing parsed in this function
        expect(gate, `${fn} validates before it checks billing standing`).toBeLessThan(parse);
      });
    }

    it(`${file} surfaces AccessRestrictedError instead of swallowing it`, () => {
      /*
       * Without this branch in `toActionError()`, a refusal degrades to
       * "Something went wrong. Please try again." — which tells a customer
       * whose card expired that the software is broken. That is the one
       * message guaranteed to produce a support ticket instead of a
       * payment.
       */
      expect(src).toMatch(/err instanceof AccessRestrictedError/);
      expect(src).toMatch(/from "@\/server\/billing\/access"/);
    });
  }
});

describe("the MCP surface is wired to the same gate", () => {
  const dispatch = readFileSync("server/mcp/dispatch.ts", "utf8");

  it("⭐ dispatch calls requireAccessForTenant()", () => {
    // Before v0.83.2 the dispatcher checked the token, its scope and RLS,
    // and never asked whether the workspace was paying — so an AI agent
    // kept writing to a workspace whose own staff were read-only.
    expect(dispatch).toContain("requireAccessForTenant");
  });

  it("gates on read_write scope, so read tools stay available", () => {
    // A lapsed customer must still be able to ask "what do I owe?" — that
    // is the call most likely to end in a payment.
    expect(dispatch).toMatch(/scope\s*===\s*["']read_write["']/);
  });

  it("the gate runs BEFORE the tool executes", () => {
    const gate = dispatch.indexOf("requireAccessForTenant");
    const exec = dispatch.indexOf("const data = await runTool(");
    expect(gate).toBeGreaterThan(-1);
    expect(exec).toBeGreaterThan(-1);
    expect(gate, "the billing gate runs after the tool has already written").toBeLessThan(exec);
  });
});

describe("deals.ts", () => {
  const src = readFileSync("server/actions/deals.ts", "utf8");

  it("⭐ still has no write functions — the moment it gains one, guard it", () => {
    /*
     * `deals.ts` needs no `requireAccess()` today because its only export
     * is a read. This test is the tripwire for that changing: a new
     * createDeal/updateDeal/deleteDeal added here without the guard
     * silently reopens the hole S1 closed, and nothing in the type system
     * would notice.
     */
    const writes = src.match(/export async function (create|update|delete)\w*/g) ?? [];
    expect(
      writes,
      `deals.ts gained a write (${writes.join(", ")}). Add ` +
        `requireAccess("deals:...") immediately after requireTenantContext().`,
    ).toHaveLength(0);
  });

  it("carries the note explaining why, so the absence reads as deliberate", () => {
    expect(src).toMatch(/THIS FILE CONTAINS NO WRITES/);
  });
});

describe("the gate itself still exports what its callers import", () => {
  const access = readFileSync("server/billing/access.ts", "utf8");

  it("exports both the session and the tenant-id entry points", () => {
    expect(access).toMatch(/export async function requireAccess\(/);
    expect(access).toMatch(/export async function requireAccessForTenant\(/);
    expect(access).toMatch(/export async function getAccessDecisionForTenant\(/);
  });

  it("⭐ the tenant-id path reads inside withTenant(), not through the bare db client", () => {
    /*
     * ⚠️ THE SUBTLE ONE. A plain `db` read carries no tenant context, so
     * every RLS policy evaluates `tenant_id = app_current_tenant_id()`
     * against NULL and matches nothing. The query returns zero rows, which
     * looks exactly like "this workspace has no subscription" — and would
     * grant full access to everyone. Same failure documented on
     * `withPlatformScope()` in `db/index.ts`.
     */
    const start = access.indexOf("export async function getAccessDecisionForTenant");
    const body = access.slice(start);
    expect(body).toMatch(/withTenant\(/);
  });

  it("⚠️ still fails OPEN — asserted so nobody 'hardens' it into an outage", () => {
    // Every other gate in this system fails closed. This one must not: the
    // cost of wrongly denying is that every paying customer loses their
    // workspace because one query timed out.
    expect(access).toMatch(/failing OPEN/i);
  });
});
