/**
 * Ordence — ⭐⭐⭐ THE REACHABILITY GATE
 * Version: v1.17.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS FILE EXISTS BECAUSE "IT COMPILES" WAS NOT ENOUGH
 * ══════════════════════════════════════════════════════════════════════
 * Five sessions shipped with `createConnection`, `saveCredential`,
 * `setConnectionActive`, `removeConnection`, `approveCampaign` and
 * `stopCampaign` all written, all tested in isolation, and all called by
 * nothing. Seven gates were green every time, because not one of them
 * asks whether a person can reach the feature.
 *
 * ⭐ SO THIS ONE DOES. An action that no screen imports is an action that
 * does not exist as far as the customer is concerned, and from now on
 * that fails the build rather than shipping quietly.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INTAKE_ROUTE_DIR,
  webhookPathFor,
  webhookUrlFor,
} from "@/lib/integrations/webhook-path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Strip comments, so a promise made in prose never satisfies a test. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the webhook address we hand out", () => {
  /**
   * 🔴 THE BUG THIS PINS. `createConnection` minted
   * `/api/webhooks/${connectorKey}/${token}` for five sessions. There has
   * never been a route with a connector segment, so every address the
   * product would have printed was a 404 — and for JustDial that address
   * goes to their account manager in an email and is then permanent.
   */
  it("names a route directory that is really on disk", () => {
    expect(existsSync(join(root, INTAKE_ROUTE_DIR, "route.ts"))).toBe(true);
  });

  it("builds a path that matches that directory", () => {
    const path = webhookPathFor("abc123");
    expect(path).toBe("/api/webhooks/intake/abc123");
    // The route dir, with the [token] placeholder filled in, IS the path.
    expect(`app${path}`).toBe(join(INTAKE_ROUTE_DIR.replace("[token]", "abc123")));
  });

  it("never puts the connector key in the address", () => {
    const source = code(read("server/actions/connections.ts"));
    // ⚠️ Matches the old shape specifically rather than the word
    // "webhooks", which legitimately appears elsewhere.
    expect(source).not.toMatch(/`\/api\/webhooks\/\$\{[^}]*[Cc]onnector/);
  });

  it("removes a trailing slash from the base rather than doubling it", () => {
    expect(webhookUrlFor("https://app.example.com/", "t")).toBe(
      "https://app.example.com/api/webhooks/intake/t",
    );
    expect(webhookUrlFor("https://app.example.com", "t")).toBe(
      "https://app.example.com/api/webhooks/intake/t",
    );
  });
});

describe("every connector says how it can be verified", () => {
  it("has a verifyMethod on all five, chosen from the table", () => {
    const source = code(read("lib/integrations/policy.ts"));
    const found = source.match(/verifyMethod:\s*"(\w+)"/g) ?? [];
    expect(found).toHaveLength(5);
    for (const f of found) {
      expect(f).toMatch(/"(fetch_probe|credential_probe|inbound_only)"/);
    }
  });

  /**
   * ⭐ JUSTDIAL PUSHES. There is no outbound call in existence, so a
   * Test button that claimed to check it would be a button that cannot
   * say anything true.
   */
  it("marks the push-only connectors inbound_only", () => {
    const source = read("lib/integrations/policy.ts");
    const justdial = source.slice(source.indexOf('key: "justdial"'));
    expect(justdial.slice(0, 2000)).toContain('verifyMethod: "inbound_only"');
  });

  /**
   * 🔴 AND WHATSAPP MUST NOT BE A FETCH PROBE. Meta charges per
   * delivered message, so a Test button that sends is a Test button that
   * spends.
   */
  it("verifies WhatsApp with a credential probe, never a send", () => {
    const source = read("lib/integrations/policy.ts");
    const whatsapp = source.slice(source.indexOf('key: "whatsapp"'));
    expect(whatsapp.slice(0, 2000)).toContain('verifyMethod: "credential_probe"');

    const probe = code(read("server/integrations/probe.ts"));
    // ⚠️ The probe reads the number's own record. It must never POST.
    expect(probe).not.toMatch(/method:\s*"POST"/);
    expect(probe).not.toContain("/messages");
  });
});

describe("the probe stays out of the way of the real log", () => {
  it("marks its runs as probes", () => {
    const probe = code(read("server/integrations/probe.ts"));
    expect(probe).toContain("isProbe: true");
  });

  it("opens the run before reading a credential", () => {
    const probe = code(read("server/integrations/probe.ts"));
    const insert = probe.indexOf(".insert(syncRuns)");
    // ⚠️ THE CALL, NOT THE IMPORT. `readForRunner` appears at the top of
    // the file in an import statement, which would make this assertion
    // pass for the wrong reason.
    const readSecret = probe.indexOf("readForRunner({");
    expect(insert).toBeGreaterThan(-1);
    expect(readSecret).toBeGreaterThan(-1);
    // 🔴 `readForRunner` refuses a read with no run to belong to, and
    // that rule is worth more than the INSERT it costs.
    expect(insert).toBeLessThan(readSecret);
  });

  it("never advances the cursor", () => {
    const probe = code(read("server/integrations/probe.ts"));
    expect(probe).not.toContain("cursorAt");
  });

  it("is filtered out of the runs a person reads", () => {
    const source = code(read("server/actions/connections.ts"));
    expect(source).toContain("eq(syncRuns.isProbe, false)");
  });
});

describe("the engines are reachable from a browser", () => {
  /**
   * ⭐⭐ THE POINT OF THE WHOLE SESSION, AS AN ASSERTION.
   *
   * ⚠️ Each of these was written, correct, and called by nothing.
   */
  const mustBeReached: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      "createConnection",
      ["app/(crm)/settings/connections/page.tsx", "components/integrations/connection-manager.tsx"],
    ],
    ["saveCredential", ["app/(crm)/settings/connections/page.tsx"]],
    ["setConnectionActive", ["app/(crm)/settings/connections/page.tsx"]],
    ["removeConnection", ["app/(crm)/settings/connections/page.tsx"]],
    ["approveCampaign", ["app/(crm)/campaigns/page.tsx"]],
    ["stopCampaign", ["app/(crm)/campaigns/page.tsx"]],
    ["declareTemplate", ["app/(crm)/messaging/templates/page.tsx"]],
  ];

  for (const [action, screens] of mustBeReached) {
    it(`${action} is called from a screen`, () => {
      const reached = screens.some((s) => existsSync(join(root, s)) && read(s).includes(action));
      expect(reached).toBe(true);
    });
  }
});

describe("no credential is ever rendered", () => {
  it("the setup screen has no way to display a stored secret", () => {
    const source = code(read("components/integrations/connection-manager.tsx"));
    // ⚠️ Inputs are write-only: they post a value and clear it. Nothing
    // renders `storedSecrets` as anything but a name.
    expect(source).not.toMatch(/value=\{[^}]*secretValue/);
    expect(source).toContain('type="password"');
  });

  /**
   * 🔴 THE VERIFY TOKEN IS THE SINGLE EXCEPTION, AND ONLY AT MINT TIME.
   * There is no action that can read one back, and this asserts that
   * nobody adds one.
   */
  it("has no action that reads a verify token back", () => {
    const source = code(read("server/actions/connections.ts"));
    expect(source).not.toMatch(/export async function (read|get|show)VerifyToken/);
    expect(source).toContain("generateVerifyToken");
  });
});

describe("a declared template may not claim approval", () => {
  it("the action always writes in_review", () => {
    const source = code(read("server/actions/templates.ts"));
    expect(source).toContain('status: "in_review"');
    expect(source).toContain('source: "declared"');
    // ⚠️ The status must not be an argument. See the header.
    expect(source).not.toMatch(/status:\s*z\.enum/);
  });

  it("the database refuses it too, so a future caller cannot get it wrong", () => {
    const sql = read("SQL-FILES/0069_connection_probes.sql");
    expect(sql).toContain("message_templates_only_sync_approves");
    expect(sql).toContain("status <> 'approved' OR source = 'synced'");
  });
});
