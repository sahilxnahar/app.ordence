/**
 * Ordence — ⭐⭐⭐ BATCH 45: THE ISOLATION CANARY
 * Version: v1.45.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS SUITE IS ACTUALLY GUARDING
 * ══════════════════════════════════════════════════════════════════════
 * Not "does the probe run". The probe is twenty lines of counting. What
 * has to be guarded is the set of REFUSALS — the cases where the probe
 * must decline to report a pass — because every one of them is a case
 * where the tempting behaviour and the correct behaviour differ, and
 * where the tempting behaviour produces a permanently green tick that is
 * evidence of nothing.
 *
 * ⭐ SO THE PROBE IS DRIVEN, NOT GREPPED. `@/db` is replaced with a fake
 * transaction that answers each statement from a script, which lets a
 * test say "the connection has BYPASSRLS" or "this table leaked three
 * rows" and assert what the probe then does. A suite that only checked
 * the source for the word `rolbypassrls` would pass against a file that
 * read the column and ignored it — which is exactly the bug worth
 * catching.
 *
 * ⚠️ THE SOURCE-TEXT ASSERTIONS AT THE END RUN THROUGH `codeOnly`.
 * This file's subject is covered in explanatory comments containing the
 * words INSERT, UPDATE and DELETE; a test that grepped whole files for
 * those would fail on the prose that exists to explain why they are
 * absent. Comments are blanked before any absence is asserted.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/* ================================================================== */
/* THE FAKE DATABASE                                                   */
/* ================================================================== */

/**
 * ⚠️ `vi.hoisted`, BECAUSE `vi.mock` IS HOISTED ABOVE EVERY IMPORT.
 * A plain `const` declared here would still be in its temporal dead zone
 * when the mock factory runs, and the failure reads as "cannot access
 * before initialization" from inside a module that looks unrelated.
 */
const H = vi.hoisted(() => ({
  /** Set by each test before it calls the probe. */
  script: null as null | Record<string, unknown>,
  /** Every statement the probe issued, rendered. The write-proof. */
  statements: [] as string[],
  /** Every scope the probe opened, in order. */
  scopes: [] as string[],
}));

const TABLES = ["users", "contacts", "sales_invoices", "documents", "audit_logs"] as const;
const VICTIM = "77777777-7777-4777-8777-777777777777";

vi.mock("@/db", () => {
  /**
   * Drizzle's `sql` object serialises its chunks, so `JSON.stringify`
   * gives back both the literal SQL text (including the
   * `/* ordence:canary ... *​/` tag each statement carries) and any
   * `sql.identifier` value. That is enough to dispatch on, and it means
   * the fake does not need to understand SQL.
   */
  const tableOf = (rendered: string) =>
    TABLES.find((t) => rendered.includes(`{"value":"${t}"}`)) ?? null;

  const answer = (rendered: string): Record<string, unknown>[] => {
    const s = (H.script ?? {}) as Record<string, never>;
    const table = tableOf(rendered);

    if (rendered.includes("ordence:canary role")) return [s.role];
    if (rendered.includes("ordence:canary synthetic-collision")) return [{ n: s.collision }];
    if (rendered.includes("ordence:canary table-facts")) return s.facts as never[];
    if (rendered.includes("ordence:canary victim")) {
      const v = table ? (s.victim as Record<string, unknown>)[table] : null;
      return v ? [v as Record<string, unknown>] : [];
    }
    if (rendered.includes("ordence:canary control")) {
      const n = table ? (s.control as Record<string, number>)[table] : 0;
      return [{ n }];
    }
    if (rendered.includes("ordence:canary cross-tenant")) {
      const c = table ? (s.cross as Record<string, unknown>)[table] : { targeted: 0, any_rows: 0 };
      return [c as Record<string, unknown>];
    }
    throw new Error(`The canary issued a statement this fake does not know: ${rendered}`);
  };

  const tx = {
    execute: async (q: unknown) => {
      const rendered = JSON.stringify(q);
      H.statements.push(rendered);
      return { rows: answer(rendered) };
    },
  };

  return {
    withTenant: async (tenantId: string, cb: (t: typeof tx) => unknown) => {
      H.scopes.push(`tenant:${tenantId}`);
      return cb(tx);
    },
    withPlatformScope: async (reason: string, cb: (t: typeof tx) => unknown) => {
      H.scopes.push(`platform:${reason.slice(0, 20)}`);
      return cb(tx);
    },
  };
});

import {
  runCanaryProbe,
  verdictFor,
  httpStatusForVerdict,
  getLastCanaryRun,
  __resetCanaryStateForTests,
  CANARY_TARGETS,
  CANARY_SYNTHETIC_TENANT_ID,
  CANARY_BYPASS_REFUSAL,
  type CanaryConnectionFacts,
  type CanaryTargetResult,
} from "@/server/platform/canary";

/** A database where everything is exactly as it should be. */
function healthy(overrides: Record<string, unknown> = {}) {
  return {
    role: {
      current_user_name: "ordence_app",
      session_user_name: "ordence_app",
      rolsuper: false,
      rolbypassrls: false,
    },
    collision: 0,
    facts: TABLES.map((t) => ({
      table_name: t,
      rls_enabled: true,
      rls_forced: true,
      owned_by_probe_role: false,
    })),
    victim: Object.fromEntries(TABLES.map((t) => [t, { tenant_id: VICTIM, n: 42 }])),
    control: Object.fromEntries(TABLES.map((t) => [t, 42])),
    cross: Object.fromEntries(TABLES.map((t) => [t, { targeted: 0, any_rows: 0 }])),
    ...overrides,
  };
}

beforeEach(() => {
  H.statements = [];
  H.scopes = [];
  H.script = healthy();
  __resetCanaryStateForTests();
});

const issued = (tag: string) => H.statements.filter((s) => s.includes(tag));

/* ================================================================== */
/* ① 🔴 THE REFUSAL THAT MATTERS MOST                                  */
/* ================================================================== */

describe("a connection that bypasses RLS", () => {
  /**
   * 🔴 The whole feature. `neondb_owner` has BYPASSRLS; `ordence_app`
   * does not. From a bypassing connection a cross-tenant read returning
   * zero rows says nothing about isolation, so a pass reported from one
   * is false assurance that will be believed forever.
   */
  it("is INCONCLUSIVE, never a pass, when the role carries BYPASSRLS", async () => {
    H.script = healthy({
      role: {
        current_user_name: "neondb_owner",
        session_user_name: "neondb_owner",
        rolsuper: false,
        rolbypassrls: true,
      },
    });

    const result = await runCanaryProbe();

    expect(result.verdict).toBe("inconclusive");
    expect(result.verdict).not.toBe("pass");
    expect(result.headline).toContain(CANARY_BYPASS_REFUSAL);
    expect(result.headline).toContain("neondb_owner");
  });

  it("is INCONCLUSIVE when the role is a superuser", async () => {
    H.script = healthy({
      role: {
        current_user_name: "postgres",
        session_user_name: "postgres",
        rolsuper: true,
        rolbypassrls: false,
      },
    });

    const result = await runCanaryProbe();
    expect(result.verdict).toBe("inconclusive");
    expect(result.headline).toContain(CANARY_BYPASS_REFUSAL);
  });

  /**
   * ⭐⭐ AND IT STOPS BEFORE ASSERTING ANYTHING.
   *
   * Running the cross-tenant reads "for information" would put a row
   * count next to the word INCONCLUSIVE, and a zero there is precisely
   * the number that talks somebody into treating the run as green.
   */
  it("attempts no cross-tenant read at all, so there is no zero to misread", async () => {
    H.script = healthy({
      role: {
        current_user_name: "neondb_owner",
        session_user_name: "neondb_owner",
        rolsuper: false,
        rolbypassrls: true,
      },
    });

    const result = await runCanaryProbe();

    expect(issued("ordence:canary cross-tenant")).toHaveLength(0);
    expect(result.targets).toHaveLength(0);
    expect(result.provenTargets).toBe(0);
  });

  /**
   * 🔴 THE GUARANTEE LIVES IN THE DECISION FUNCTION TOO, not only in the
   * early return. A future caller that assembled targets itself and
   * asked for a verdict must get the same refusal.
   */
  it("cannot be talked into a pass even when every target looks perfect", () => {
    const bypassing: CanaryConnectionFacts = {
      currentUser: "neondb_owner",
      sessionUser: "neondb_owner",
      isSuperuser: false,
      hasBypassRls: true,
      bypassesRls: true,
    };
    const perfect: CanaryTargetResult[] = TABLES.map((table) => ({
      table,
      verdict: "pass",
      victimTenantId: VICTIM,
      witnessRows: 10,
      controlRows: 10,
      crossTenantRowsTargeted: 0,
      crossTenantRowsAny: 0,
      rlsEnabled: true,
      rlsForced: true,
      ownedByProbeRole: false,
      note: "",
    }));

    const { verdict, headline } = verdictFor(bypassing, perfect);
    expect(verdict).toBe("inconclusive");
    expect(headline).toContain(CANARY_BYPASS_REFUSAL);
  });
});

/* ================================================================== */
/* ② THE THIRD BYPASS VECTOR: TABLE OWNERSHIP WITHOUT FORCE            */
/* ================================================================== */

describe("a table the probe's own role owns", () => {
  /**
   * ⚠️ The owner of a table is exempt from its policies unless FORCE ROW
   * LEVEL SECURITY is set — with no `rolsuper` and no `rolbypassrls` in
   * sight. A privilege check that read only `pg_roles` would clear this
   * connection and then report a pass earned by the exemption.
   */
  it("proves nothing without FORCE ROW LEVEL SECURITY", async () => {
    H.script = healthy({
      facts: TABLES.map((t) => ({
        table_name: t,
        rls_enabled: true,
        rls_forced: t !== "contacts",
        owned_by_probe_role: t === "contacts",
      })),
    });

    const result = await runCanaryProbe();
    const contacts = result.targets.find((t) => t.table === "contacts");

    expect(contacts?.verdict).toBe("inconclusive");
    expect(contacts?.note).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("is a pass when the owner is forced, because then the policy applies to it too", async () => {
    H.script = healthy({
      facts: TABLES.map((t) => ({
        table_name: t,
        rls_enabled: true,
        rls_forced: true,
        owned_by_probe_role: true,
      })),
    });

    const result = await runCanaryProbe();
    expect(result.verdict).toBe("pass");
    expect(result.provenTargets).toBe(TABLES.length);
  });
});

/* ================================================================== */
/* ③ 🔴 THE BREACH                                                     */
/* ================================================================== */

describe("when the cross-tenant read succeeds", () => {
  it("is a P0 breach naming the table, and the whole run goes red", async () => {
    H.script = healthy({
      cross: {
        ...Object.fromEntries(TABLES.map((t) => [t, { targeted: 0, any_rows: 0 }])),
        sales_invoices: { targeted: 3, any_rows: 3 },
      },
    });

    const result = await runCanaryProbe();

    expect(result.verdict).toBe("breach");
    expect(result.headline).toContain("sales_invoices");
    expect(result.headline).toContain("P0");
    expect(httpStatusForVerdict(result.verdict)).toBe(500);

    const leaked = result.targets.find((t) => t.table === "sales_invoices");
    expect(leaked?.verdict).toBe("breach");
    expect(leaked?.victimTenantId).toBe(VICTIM);
    expect(leaked?.note).toContain(VICTIM);
  });

  /**
   * ⚠️ A POLICY THAT IS MISSING RATHER THAN WRONG. A table with
   * `USING (true)` may return nothing for one particular tenant filter
   * and everything with no filter at all, so both questions are asked.
   */
  it("catches a table that leaks with no WHERE even when the targeted read is empty", async () => {
    H.script = healthy({
      cross: {
        ...Object.fromEntries(TABLES.map((t) => [t, { targeted: 0, any_rows: 0 }])),
        documents: { targeted: 0, any_rows: 91 },
      },
    });

    const result = await runCanaryProbe();
    expect(result.verdict).toBe("breach");
    expect(result.targets.find((t) => t.table === "documents")?.verdict).toBe("breach");
  });

  /** ⚠️ Four green tables do not average out one that leaked. */
  it("does not let the passing tables dilute it", async () => {
    H.script = healthy({
      cross: {
        ...Object.fromEntries(TABLES.map((t) => [t, { targeted: 0, any_rows: 0 }])),
        users: { targeted: 1, any_rows: 1 },
      },
    });

    const result = await runCanaryProbe();
    expect(result.provenTargets).toBe(TABLES.length - 1);
    expect(result.verdict).toBe("breach");
  });

  /**
   * ⚠️ NO ROW-LEVEL SECURITY AT ALL IS A BREACH, NOT AN INCONCLUSIVE.
   * There is no policy to prove or disprove; the table is simply
   * readable from every scope, which is the outcome policies exist to
   * prevent.
   */
  it("treats a table with RLS switched off as a breach", async () => {
    H.script = healthy({
      facts: TABLES.map((t) => ({
        table_name: t,
        rls_enabled: t !== "audit_logs",
        rls_forced: true,
        owned_by_probe_role: false,
      })),
    });

    const result = await runCanaryProbe();
    expect(result.targets.find((t) => t.table === "audit_logs")?.verdict).toBe("breach");
    expect(result.verdict).toBe("breach");
  });
});

/* ================================================================== */
/* ④ ⭐ THE CONTROLS: PROVING THE PROBE COULD HAVE FAILED               */
/* ================================================================== */

describe("the two positive controls", () => {
  /**
   * 🔴 A zero from an empty table is not isolation. This is the shape of
   * false assurance that needs no bug at all to occur — a young database
   * produces it by itself.
   */
  it("refuses to pass a table no workspace has any rows in", async () => {
    H.script = healthy({
      victim: { ...Object.fromEntries(TABLES.map((t) => [t, { tenant_id: VICTIM, n: 42 }])), documents: null },
    });

    const result = await runCanaryProbe();
    const doc = result.targets.find((t) => t.table === "documents");

    expect(doc?.verdict).toBe("inconclusive");
    expect(doc?.note).toContain("nothing to fail to see");
  });

  /**
   * ⚠️ If a CORRECT scope cannot read, an INCORRECT scope reading
   * nothing is a foregone conclusion rather than a result.
   */
  it("refuses to pass when the victim cannot see its own rows", async () => {
    H.script = healthy({
      control: { ...Object.fromEntries(TABLES.map((t) => [t, 42])), contacts: 0 },
    });

    const result = await runCanaryProbe();
    const contacts = result.targets.find((t) => t.table === "contacts");

    expect(contacts?.verdict).toBe("inconclusive");
    expect(contacts?.note).toContain("positive control failed");
  });

  /** ⭐ And with nothing conclusive anywhere, the RUN proves nothing. */
  it("is INCONCLUSIVE overall when not one target could be used", async () => {
    H.script = healthy({
      victim: Object.fromEntries(TABLES.map((t) => [t, null])),
    });

    const result = await runCanaryProbe();
    expect(result.verdict).toBe("inconclusive");
    expect(result.provenTargets).toBe(0);
    expect(httpStatusForVerdict(result.verdict)).toBe(503);
  });

  /**
   * ⚠️ THE ONE JUDGEMENT CALL, PINNED SO IT CANNOT DRIFT SILENTLY. One
   * empty table does not hold the whole probe red — a permanently red
   * check is a check that gets ignored — but the coverage gap is named
   * in the headline rather than left to be discovered.
   */
  it("still passes with a partial coverage gap, and says so in numbers", async () => {
    H.script = healthy({
      victim: { ...Object.fromEntries(TABLES.map((t) => [t, { tenant_id: VICTIM, n: 42 }])), documents: null },
    });

    const result = await runCanaryProbe();
    expect(result.verdict).toBe("pass");
    expect(result.inconclusiveTargets).toBe(1);
    expect(result.headline).toContain("documents");
  });
});

/* ================================================================== */
/* ⑤ THE SYNTHETIC TENANT                                              */
/* ================================================================== */

describe("the synthetic tenant", () => {
  it("is a UUID `withTenant()` will actually accept", () => {
    // The same regex `db/index.ts` guards with. A "creative" placeholder
    // is refused before it reaches the database, and the probe then
    // fails with a malformed-tenant error that reads like an outage.
    expect(CANARY_SYNTHETIC_TENANT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("is the scope every cross-tenant read is attempted from", async () => {
    await runCanaryProbe();
    expect(H.scopes).toContain(`tenant:${CANARY_SYNTHETIC_TENANT_ID}`);
    // And the victim's own scope is opened too — that is the control.
    expect(H.scopes).toContain(`tenant:${VICTIM}`);
  });

  /**
   * 🔴 A COLLISION WOULD MAKE EVERY ROW A FALSE P0, ON A SCHEDULE, UNTIL
   * SOMEBODY MUTED THE CANARY. Muting is the only outcome that actually
   * loses the control, so the collision check refuses rather than warns.
   */
  it("refuses to assert anything if a real workspace holds its id", async () => {
    H.script = healthy({ collision: 1 });

    const result = await runCanaryProbe();
    expect(result.verdict).toBe("inconclusive");
    expect(result.headline).toContain(CANARY_SYNTHETIC_TENANT_ID);
    expect(issued("ordence:canary cross-tenant")).toHaveLength(0);
  });
});

/* ================================================================== */
/* ⑥ ⚠️ IT NEVER WRITES. PROVED BY EXECUTION, NOT BY GREP.             */
/* ================================================================== */

describe("what the probe is allowed to do to the database", () => {
  it("issues nothing but SELECTs, across every phase of a full run", async () => {
    await runCanaryProbe();

    expect(H.statements.length).toBeGreaterThan(0);
    for (const statement of H.statements) {
      expect(statement).toMatch(/SELECT/);
      expect(statement).not.toMatch(/INSERT\s|UPDATE\s|DELETE\s|TRUNCATE|ALTER\s|DROP\s/i);
    }
  });

  /**
   * ⭐ AND IT DOES NOT WRITE ON THE WAY TO A BREACH EITHER. A probe that
   * recorded its own findings would need INSERT permission under exactly
   * the role whose privileges are in question, and would report "I could
   * not record my own result" as its most common failure.
   */
  it("issues nothing but SELECTs when it finds a leak", async () => {
    H.script = healthy({
      cross: {
        ...Object.fromEntries(TABLES.map((t) => [t, { targeted: 0, any_rows: 0 }])),
        contacts: { targeted: 5, any_rows: 5 },
      },
    });

    const result = await runCanaryProbe();
    expect(result.verdict).toBe("breach");
    for (const statement of H.statements) {
      expect(statement).not.toMatch(/INSERT\s|UPDATE\s|DELETE\s/i);
    }
  });

  /**
   * ⚠️ IT COUNTS, IT NEVER SELECTS A COLUMN. Nothing it learns about a
   * customer beyond "there are rows" can reach a log line, an HTTP
   * response or an incident channel, because it is never read into
   * memory in the first place.
   */
  it("selects no customer column anywhere", async () => {
    await runCanaryProbe();
    const dataReads = H.statements.filter((s) => s.includes("ordence:canary cross-tenant"));
    expect(dataReads.length).toBeGreaterThan(0);
    for (const statement of dataReads) {
      expect(statement).toMatch(/SELECT 1/);
    }
  });
});

/* ================================================================== */
/* ⑦ THE STATUS CODE IS THE ALERT                                      */
/* ================================================================== */

describe("the verdict-to-status mapping", () => {
  /**
   * 🔴 INCONCLUSIVE IS A NON-2xx, and this is the assertion that keeps it
   * that way. Every scheduler in existence draws 2xx green. If
   * INCONCLUSIVE returned 200, the deployment as it stands — running as
   * a BYPASSRLS role — would show a green isolation check forever, on a
   * database where row-level security is not in effect.
   */
  it("reserves 200 for a proved pass", () => {
    expect(httpStatusForVerdict("pass")).toBe(200);
    expect(httpStatusForVerdict("breach")).toBe(500);
    expect(httpStatusForVerdict("inconclusive")).toBe(503);
    expect(httpStatusForVerdict("inconclusive")).not.toBe(200);
  });
});

/* ================================================================== */
/* ⑧ THE LAST RUN, AND WHAT IT IS NOT                                  */
/* ================================================================== */

describe("the in-process record", () => {
  it("is empty until something runs, and holds the latest verdict after", async () => {
    expect(getLastCanaryRun()).toBeNull();
    const result = await runCanaryProbe();
    expect(getLastCanaryRun()?.verdict).toBe(result.verdict);
    expect(getLastCanaryRun()?.finishedAt).toBe(result.finishedAt);
  });

  /** Even a refusal is recorded — a console showing nothing after a
   *  bypass refusal would look like the probe had never run. */
  it("records refusals too", async () => {
    H.script = healthy({
      role: {
        current_user_name: "neondb_owner",
        session_user_name: "neondb_owner",
        rolsuper: false,
        rolbypassrls: true,
      },
    });
    await runCanaryProbe();
    expect(getLastCanaryRun()?.verdict).toBe("inconclusive");
  });
});

/* ================================================================== */
/* ⑨ IT IS REACHABLE, AND THE ROUTE MAPS THE VERDICT                   */
/* ================================================================== */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments blanked. Whole-file greps fail on their own prose. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const ROUTE = read("app/api/cron/canary/route.ts");
const MIDDLEWARE = read("middleware.ts");
const LAYOUT = read("app/platform/layout.tsx");

describe("the scheduled entry point", () => {
  it("exists at a path a scheduler can call", () => {
    expect(existsSync(join(ROOT, "app/api/cron/canary/route.ts"))).toBe(true);
  });

  /**
   * ⚠️ WITHOUT THIS ENTRY THE CANARY IS AN ORPHAN — present, correct, and
   * refused with 401 on every run. A probe that never runs is
   * indistinguishable from a probe that always passes.
   */
  it("is public in middleware, or the scheduler is refused by Clerk on every run", () => {
    expect(codeOnly(MIDDLEWARE)).toContain('"/api/cron/canary"');
  });

  it("authenticates itself with CRON_SECRET in constant time", () => {
    const code = codeOnly(ROUTE);
    expect(code).toContain("CRON_SECRET");
    expect(code).toContain("timingSafeEqual");
  });

  /** ⚠️ A missing secret must mean "refuse", never "run openly". */
  it("fails closed when no secret is configured", () => {
    expect(codeOnly(ROUTE)).toContain("status: 503");
    expect(ROUTE).toContain("refuses to run");
  });

  /** Vercel Cron issues GET; worker.ts and curl send POST. Both, or it
   *  silently never runs on one of them. */
  it("answers both verbs", () => {
    const code = codeOnly(ROUTE);
    expect(code).toContain("export async function GET");
    expect(code).toContain("export async function POST");
  });

  /**
   * 🔴 The status must come from the verdict, not from whether the route
   * threw. A route that hard-codes 200 and puts the verdict in the body
   * is a route whose alerting does not exist.
   */
  it("takes its HTTP status from the verdict", () => {
    expect(codeOnly(ROUTE)).toContain("httpStatusForVerdict(result.verdict)");
  });

  /** The response body must never grow into row contents. */
  it("never selects or echoes customer columns", () => {
    const code = codeOnly(ROUTE);
    expect(code).not.toContain("SELECT");
    expect(code).not.toMatch(/\binsert\b/i);
  });
});

describe("the platform console panel", () => {
  it("exists and is linked from the console nav", () => {
    expect(existsSync(join(ROOT, "app/platform/canary/page.tsx"))).toBe(true);
    expect(codeOnly(LAYOUT)).toContain('"/platform/canary"');
  });

  it("is gated on platform staff in the page as well as the middleware", () => {
    expect(codeOnly(read("app/platform/canary/page.tsx"))).toContain("requirePlatformAdmin()");
  });
});

/* ================================================================== */
/* ⑩ THE TARGET LIST                                                   */
/* ================================================================== */

describe("what is probed", () => {
  it("covers the tables whose leak would cost the most", () => {
    expect(CANARY_TARGETS.map((t) => t.table)).toEqual([...TABLES]);
  });

  /** Every target explains, in English, what a leak there means — that
   *  sentence is what ends up in the incident channel. */
  it("says what a leak in each one means", () => {
    for (const target of CANARY_TARGETS) {
      expect(target.whatALeakMeans.length).toBeGreaterThan(40);
    }
  });
});
