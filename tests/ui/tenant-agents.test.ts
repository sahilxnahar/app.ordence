/**
 * Ordence — ⭐⭐⭐ AGENTS THAT BELONG TO A TENANT
 * Version: v1.20.0-alpha
 *
 * ⚠️ Two rules are worth more than everything else here, and both are the
 * kind a later change removes for a good-sounding reason:
 *
 *   ① An agent with any tool is on the confidential lane.
 *   ② An agent that runs without a person may not act without one.
 *
 * Neither failure is visible afterwards. A mis-laned agent looks
 * identical and quietly exports the customer list. An agent given the
 * ability to send looks like a feature until the WhatsApp number is
 * banned.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATALOGUE_BY_KEY,
  CATALOGUE_SOURCE,
  STARTER_CATALOGUE,
  laneFor,
} from "@/lib/ai/agents/catalogue";
import { MCP_TOOLS } from "@/lib/mcp/registry";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/* ================================================================== */
/* THE CATALOGUE                                                       */
/* ================================================================== */

describe("the starter catalogue", () => {
  it("holds the twenty prompts from the pack", () => {
    expect(STARTER_CATALOGUE).toHaveLength(20);
  });

  it("names where they came from, in the data", () => {
    expect(CATALOGUE_SOURCE).toContain("Manus");
  });

  it("gives every one a non-trivial prompt", () => {
    for (const a of STARTER_CATALOGUE) {
      expect(a.systemPrompt.length).toBeGreaterThan(400);
      expect(a.key).toMatch(/^or_\d{2}_[a-z_]+$/);
    }
  });

  it("has no duplicate keys", () => {
    const keys = STARTER_CATALOGUE.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * 🔴 EVERY TOOL A CATALOGUE ENTRY ASKS FOR MUST EXIST. A shelf item
   * naming a tool Ordence does not have installs an agent that fails on
   * its first useful question, and the tenant blames the agent.
   */
  it("only names tools the MCP registry really has", () => {
    const known = new Set(
      (MCP_TOOLS as Array<{ name?: string; id?: string }>).flatMap((t) =>
        [t.name, t.id].filter(Boolean) as string[],
      ),
    );
    for (const a of STARTER_CATALOGUE) {
      for (const tool of a.tools) expect(known).toContain(tool);
    }
  });
});

/* ================================================================== */
/* RULE ①: THE LANE                                                    */
/* ================================================================== */

describe("an agent with any tool is on the confidential lane", () => {
  it("derives the lane rather than trusting it", () => {
    expect(laneFor([])).toBe("open");
    expect(laneFor(["ordence_whoami"])).toBe("tenant");
  });

  it("holds for every entry on the shelf", () => {
    for (const a of STARTER_CATALOGUE) {
      expect(a.sensitivity).toBe(laneFor(a.tools));
    }
  });

  /**
   * ⭐ AND THE COROLLARY MATTERS TOO. If everything were marked `tenant`
   * out of caution the confidential lane, which has two providers in it,
   * would be burned on writing ad headlines.
   */
  it("leaves the drafting agents on the open lane", () => {
    const open = STARTER_CATALOGUE.filter((a) => a.sensitivity === "open");
    expect(open.length).toBeGreaterThanOrEqual(10);
    for (const a of open) expect(a.tools).toHaveLength(0);
  });

  it("the installer never copies the shelf's claim", () => {
    const action = read("server/actions/agents.ts");
    expect(action).toContain("sensitivity: laneFor(item.tools)");
  });

  /**
   * 🔴 THE DANGEROUS EDIT IS NOT THE INSTALL. It is adding a tool six
   * months later to an agent that has always been open.
   */
  it("the editor recomputes the lane and does not accept one", () => {
    const action = read("server/actions/agents.ts");
    expect(action).toContain("const lane = laneFor(tools)");
    expect(action).not.toMatch(/sensitivity:\s*z\.enum/);
  });

  it("the database refuses the combination too", () => {
    const sql = read("SQL-FILES/0071_tenant_agents.sql");
    expect(sql).toContain("agent_definitions_tools_imply_tenant_lane");
    expect(sql).toContain("cardinality(tools) = 0 OR sensitivity = 'tenant'");
  });
});

/* ================================================================== */
/* RULE ②: AUTONOMY WITHOUT ACTION                                     */
/* ================================================================== */

describe("an agent that runs by itself may not act by itself", () => {
  it("writes its answer to a run row and nothing else", () => {
    const dispatch = read("server/automation/agent-dispatch.ts");
    expect(dispatch).toContain(".insert(agentRuns)");
  });

  /**
   * 🔴 THE LIST OF THINGS IT MUST NOT REACH. An event-triggered agent
   * that could send would message every new lead at about ₹1 each, to
   * people who never consented, from a number that gets banned for it.
   */
  it("cannot reach the send path, the campaign path or the vault", () => {
    const dispatch = read("server/automation/agent-dispatch.ts");
    for (const forbidden of [
      "messageSends",
      "sendMessage",
      "campaigns",
      "vaultSecrets",
      "readForRunner",
    ]) {
      expect(dispatch).not.toContain(forbidden);
    }
  });

  it("says so on the screen at the moment it is switched on", () => {
    const action = read("server/actions/agents.ts");
    expect(action).toContain("It cannot send anything");
  });

  it("attributes an unattended run to nobody rather than to a person", () => {
    const dispatch = read("server/automation/agent-dispatch.ts");
    expect(dispatch).toContain("userId: null");
    const sql = read("SQL-FILES/0071_tenant_agents.sql");
    // ⚠️ And a person-run must carry a name, which is the other half.
    expect(sql).toContain("agent_runs_person_has_a_name");
  });

  /**
   * ⚠️ THE AGENT IS TOLD ABOUT THE EVENT, NOT HANDED THE RECORD. Passing
   * the row would send customer data to whichever provider answered, and
   * on the open lane that provider may train on it.
   */
  it("passes the event, not the record", () => {
    const dispatch = read("server/automation/agent-dispatch.ts");
    expect(dispatch).toContain("recordId");
    expect(dispatch).not.toContain("SELECT * FROM");
  });
});

/* ================================================================== */
/* THE CAP                                                             */
/* ================================================================== */

describe("one careless trigger cannot starve the workspace", () => {
  it("counts runs rather than keeping a counter", () => {
    const dispatch = read("server/automation/agent-dispatch.ts");
    expect(dispatch).toContain("count(*)");
    expect(dispatch).toContain("dailyCap");
  });

  it("the database bounds the cap so it cannot be set to a million", () => {
    const sql = read("SQL-FILES/0071_tenant_agents.sql");
    expect(sql).toContain("daily_cap BETWEEN 1 AND 1000");
  });

  it("a failing agent does not lose the workflow run that succeeded", () => {
    const drain = read("server/automation/drain.ts");
    // ⚠️ THE CALL, NOT THE IMPORT. The name appears at the top of the
    // file in an import statement, and searching for the bare name finds
    // that first. Exactly the mistake this same suite made about
    // `readForRunner` in v1.17.0.
    const idx = drain.indexOf("dispatchAgentsForEvent({");
    expect(idx).toBeGreaterThan(-1);
    // ⚠️ Wrapped, so an agent fault is not recorded as an event failure.
    // The window is generous because the comment explaining WHY it is
    // wrapped sits between the `try` and the call, and that comment is
    // worth more than a tight assertion.
    expect(drain.slice(Math.max(0, idx - 1200), idx)).toContain("try {");
  });
});

/* ================================================================== */
/* ISOLATION                                                           */
/* ================================================================== */

describe("agents are a tenant's own", () => {
  it("every new table carries the tenant policy", () => {
    const sql = read("SQL-FILES/0071_tenant_agents.sql");
    for (const t of ["agent_definitions", "agent_triggers", "agent_runs"]) {
      expect(sql).toContain(`'${t}'`);
    }
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("keeps app_platform_scope out of WITH CHECK", () => {
    const sql = read("SQL-FILES/0071_tenant_agents.sql");
    const checks = sql.match(/WITH CHECK \([^)]*\)/g) ?? [];
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(c).not.toContain("app_platform_scope");
  });

  /**
   * ⭐ A COPY, NOT A REFERENCE. A tenant who spends an hour making an
   * agent sound like their business and then finds it reverted because
   * the vendor improved the wording does not use agents again.
   */
  it("installs by copying the prompt into the tenant's row", () => {
    const action = read("server/actions/agents.ts");
    expect(action).toContain("systemPrompt: item.systemPrompt");
  });

  it("installs each shelf item at most once", () => {
    const sql = read("SQL-FILES/0071_tenant_agents.sql");
    expect(sql).toContain("agent_definitions_catalogue_once");
  });
});

/* ================================================================== */
/* REACHABILITY                                                        */
/* ================================================================== */

describe("the whole thing is reachable from a browser", () => {
  for (const action of ["installAgent", "bindAgentTrigger", "editAgent"]) {
    it(`${action} is called from a screen`, () => {
      const screen = "app/(crm)/assistant/agents/page.tsx";
      expect(existsSync(join(root, screen))).toBe(true);
      expect(read(screen)).toContain(action);
    });
  }

  it("every catalogue key resolves", () => {
    for (const a of STARTER_CATALOGUE) {
      expect(CATALOGUE_BY_KEY[a.key]).toBeDefined();
    }
  });
});
