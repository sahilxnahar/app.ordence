/**
 * Ordence — ⭐⭐⭐ A FRESH INSTALL THAT FAILS CLOSED, AND HAS AN OWNER
 * Version: v1.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO FAILURES THAT ONLY SHOW UP ON DAY ONE
 * ══════════════════════════════════════════════════════════════════════
 * Neither of these could be found by using the product, because both are
 * about the state a BRAND NEW deployment and a BRAND NEW workspace start
 * in — the one state nobody re-enters after the first week.
 *
 * ① THE DEPLOYMENT SERVED 200s WHILE UNABLE TO CREATE A WORKSPACE.
 *    `CLERK_WEBHOOK_SIGNING_SECRET` was optional in the schema and
 *    optional in `/api/diag`, and it is the SOLE path that writes a
 *    `tenants` or `users` row for a real signup. Without it: sign-up
 *    succeeds, the webhook 500s, and the user lands on "your workspace
 *    is not ready yet" while `/api/diag` reports `ok: true`.
 *
 * ② A SELF-SERVE WORKSPACE STARTED WITH NO OWNER.
 *    Clerk gives an organisation's creator `org:admin`, which mapped to
 *    `tenant_admin`, which is denied `billing:manage` by design. So the
 *    founding user could not subscribe, could not cancel, and could not
 *    promote anyone to owner — `updateUserRole` refuses to assign a role
 *    senior to your own. Every last-owner guard was vacuously satisfied
 *    because there was never an owner to be the last one.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootVerdict, BOOT_REQUIRED, BOOT_ADVISORY } from "@/lib/env-boot";
import { permissionsForRole } from "@/db/schema/auth";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* ================================================================== */
/* ① THE BOOT ASSERTION                                                */
/* ================================================================== */

describe("a misconfigured deployment refuses to start", () => {
  const full = Object.fromEntries(BOOT_REQUIRED.map((n) => [n, "set"]));

  it("passes when every required name is present", () => {
    const v = bootVerdict((n) => full[n], "production");
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
  });

  /**
   * 🔴 THE ONE THIS EXISTS FOR. Optional in `lib/env.ts`, optional in
   * `/api/diag`, and named as the top deployment problem in
   * `docs/ENVIRONMENT-VARIABLES.md` — three places, two of which
   * disagreed with the third.
   */
  it("treats the Clerk webhook secret as required", () => {
    expect(BOOT_REQUIRED).toContain("CLERK_WEBHOOK_SIGNING_SECRET");
    const without = { ...full, CLERK_WEBHOOK_SIGNING_SECRET: undefined };
    const v = bootVerdict((n) => without[n], "production");
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(["CLERK_WEBHOOK_SIGNING_SECRET"]);
  });

  /** ⚠️ An empty string is not a value. A trailing-space paste is the usual cause. */
  it("does not accept an empty or whitespace value as present", () => {
    for (const bad of ["", "   ", "\n"]) {
      const v = bootVerdict((n) => (n === "DATABASE_URL" ? bad : full[n]), "production");
      expect(v.ok, JSON.stringify(bad)).toBe(false);
      expect(v.missing).toContain("DATABASE_URL");
    }
  });

  it("names every missing variable, not just the first", () => {
    const v = bootVerdict(() => undefined, "production");
    expect(v.missing).toEqual([...BOOT_REQUIRED]);
  });

  /**
   * ⚠️ A DEVELOPER WITH HALF A `.env.local` GETS A WARNING, NOT A DEAD
   * PROCESS. The refusal is a production control; outside production it
   * reports and continues, so the failure surfaces on the page they
   * opened rather than as a server that will not come up.
   */
  it("only enforces in production", () => {
    expect(bootVerdict(() => undefined, "development").enforced).toBe(false);
    expect(bootVerdict(() => undefined, "test").enforced).toBe(false);
    expect(bootVerdict(() => undefined, undefined).enforced).toBe(false);
    expect(bootVerdict(() => undefined, "production").enforced).toBe(true);
  });

  /**
   * ⭐ ADVISORY IS NOT FATAL, AND THAT IS DELIBERATE. Refusing to boot
   * without Redis would mean a Redis outage takes the product down,
   * which is worse than a degraded limiter. What must not happen is
   * that these are absent and nobody ever finds out.
   */
  it("warns about the settings that change the security posture", () => {
    const names = BOOT_ADVISORY.map((a) => a.name);
    expect(names).toContain("UPSTASH_REDIS_REST_URL");
    expect(names).toContain("VAULT_ENCRYPTION_KEY");
    expect(names).toContain("VAULT_BLIND_INDEX_PEPPER");
    expect(names).toContain("CSP_ENFORCE");
    expect(names).toContain("PLATFORM_HOST");

    const v = bootVerdict((n) => full[n], "production");
    expect(v.ok).toBe(true);
    expect(v.advisory.map((a) => a.name).sort()).toEqual(names.slice().sort());
    for (const entry of v.advisory) expect(entry.consequence.length).toBeGreaterThan(30);
  });

  it("is actually called from instrumentation, before the Sentry gate", () => {
    const src = read("instrumentation.ts");
    const bootAt = src.indexOf("assertBootEnv()");
    const sentryAt = src.indexOf("if (!SENTRY_ENABLED) return;");
    expect(bootAt).toBeGreaterThan(-1);
    expect(bootAt).toBeLessThan(sentryAt);
  });

  /**
   * 🔴 I PROPOSED MOVING THE RAILWAY HEALTHCHECK TO `/api/ready` AND IT
   * WAS WRONG. `invoicing-wiring.test.ts` already argued the opposite
   * and argued it better: Railway RESTARTS a container that fails its
   * healthcheck, so a database-aware probe turns a Neon outage into a
   * restart loop that destroys the logs explaining it. This asserts the
   * reversal was recorded rather than quietly dropped.
   */
  it("records why the healthcheck was left alone", () => {
    expect(read("railway.json")).toContain('"healthcheckPath": "/api/health"');
    expect(read("lib/env-boot.ts")).toContain("AND THAT WAS WRONG");
  });
});

/* ================================================================== */
/* ② WHAT `/api/diag` MAY SAY, AND TO WHOM                             */
/* ================================================================== */

describe("the diagnostic endpoint", () => {
  const diag = read("app/api/diag/route.ts");

  /**
   * 🔴 IT RETURNED THE CHARACTER LENGTH OF EVERY SECRET to anybody who
   * asked, including `CLERK_SECRET_KEY`, `WORKER_API_SECRET` and
   * `S3_SECRET_ACCESS_KEY`. The file's own header claimed it "never
   * returns the VALUE of anything", which was true and beside the
   * point: an exact length is a truncated-paste oracle and a
   * fingerprint of the key format.
   */
  it("reports presence and never length", () => {
    expect(diag).toContain("settings: Record<string, { present: boolean }>");
    expect(diag).not.toContain("length: value?.length");
    expect(diag).not.toMatch(/present: boolean; length: number/);
  });

  /**
   * 🔴 AND THE RAW DRIVER MESSAGE ON FAILURE. `/api/ready` deliberately
   * reduces the same thing to a SQLSTATE, with a comment saying a
   * driver error can carry the connection string and the endpoint is
   * unauthenticated. Both are unauthenticated. Only one had noticed.
   */
  it("returns a SQLSTATE rather than a driver message", () => {
    expect(diag).not.toMatch(/error: error instanceof Error \? error\.message/);
    expect(diag).toContain('code: (error as { code?: string })?.code ?? null');
  });

  /**
   * ⚠️ THE PROBES OPENED A NEON CONNECTION AND A WEBSOCKET TRANSACTION
   * ON EVERY REQUEST, unthrottled and unauthenticated. That is a
   * connection-budget exhaustion primitive as much as a disclosure.
   */
  it("runs the infrastructure probes only for platform staff", () => {
    expect(diag).toContain("getPlatformOperator");
    expect(diag).toContain("if (operator && settings.DATABASE_URL?.present)");
    expect(diag).toContain("Sign in as platform staff to run this probe.");
  });

  /**
   * ⭐ AND THE TWO-KEY REPORT STAYS PUBLIC, because that is the state
   * the endpoint exists to explain, it answers only about the caller's
   * own account, and it says nothing at all to somebody signed out.
   */
  it("keeps the platform two-key report reachable", () => {
    expect(read("middleware.ts")).toContain('"/api/diag"');
    expect(diag).toContain("NO EMAIL ADDRESSES, NO IDS, NO ALLOWLIST CONTENTS");
  });

  /** The vault keys were in no artifact anywhere, including this one. */
  it("knows the vault exists", () => {
    expect(diag).toContain('name: "Vault"');
    expect(diag).toContain("VAULT_ENCRYPTION_KEY");
    expect(diag).toContain("VAULT_BLIND_INDEX_PEPPER");
  });
});

/* ================================================================== */
/* ③ THE ENV SCHEMA KNOWS WHAT THE CODE READS                          */
/* ================================================================== */

describe("lib/env.ts declares what the code actually reads", () => {
  const env = read("lib/env.ts");

  /**
   * 🔴 THE FILE CLAIMED THIS RECONCILIATION WAS DONE. Twelve names were
   * still absent, including all four `S3_*`. A typo in
   * `S3_SECRET_ACCESS_KEY` produced no error anywhere and a document
   * vault reporting "storage is not configured" — which is what it also
   * says when storage genuinely is not configured.
   */
  it("declares the object-storage and AI provider names", () => {
    for (const name of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "CLOUDFLARE_ACCOUNT_ID",
      "CF_AI_TOKEN",
      "GROQ_API_KEY",
      "CEREBRAS_API_KEY",
      "GOOGLE_AI_API_KEY",
      "MISTRAL_API_KEY",
      "COHERE_API_KEY",
      "GITHUB_MODELS_TOKEN",
      "SENTRY_DSN",
      "CSP_REPORT_URI",
    ]) {
      expect(env, name).toContain(`${name}: z.string().optional()`);
    }
  });

  /** ⚠️ Declared-but-never-parsed is dead validation that reads as coverage. */
  it("parses every client name it declares", () => {
    const declared = [
      ...read("lib/env.ts")
        .slice(env.indexOf("const clientSchema"), env.indexOf("/* ----------------------------- LOADERS"))
        .matchAll(/^\s{2}(NEXT_PUBLIC_[A-Z0-9_]+):/gm),
    ].map((m) => m[1]);
    const parsed = env.slice(env.indexOf("clientSchema.safeParse({"));
    expect(declared.length).toBeGreaterThan(5);
    for (const name of declared) expect(parsed, name).toContain(name);
  });
});

/* ================================================================== */
/* ④ THE DOCUMENTS NO LONGER CONTRADICT THE CODE                       */
/* ================================================================== */

describe("the deployment documents", () => {
  /**
   * 🔴 THE MOST EXPENSIVE LINE IN THESE FILES. `neondb_owner` carries
   * BYPASSRLS, which overrides even FORCE ROW LEVEL SECURITY — so a
   * deployment set up from HANDOVER ran with tenant isolation inert on
   * 249 tables while every page worked perfectly. Two other documents
   * said the opposite, in bold, as a STOP gate.
   */
  it("no longer tells the operator to connect as the Neon owner", () => {
    const handover = read("docs/HANDOVER.md");
    expect(handover).not.toContain("postgresql://neondb_owner:");
    expect(handover).toContain("ordence_app");
    expect(handover).toContain("BYPASSRLS");
  });

  /** And it no longer tells them to verify by counting characters. */
  it("stops asking the operator to check secret lengths", () => {
    expect(read("docs/HANDOVER.md")).not.toContain("The expected lengths are");
  });

  /**
   * 🔴 PASTING THE SHIPPED BLOCK MADE THE CUSTOMER APP UNREACHABLE.
   * `PLATFORM_HOST` was set to the same value as `NEXT_PUBLIC_APP_URL`,
   * so every request classified as the platform host and `/dashboard`
   * and `/sign-in` rewrote into `/platform/*`, which 404. `/api/*` kept
   * working, so `/api/health` stayed green.
   */
  it("does not set PLATFORM_HOST to the application's own hostname", () => {
    const paste = read("RAILWAY-VARIABLES-PASTE.txt");
    const appUrl = paste.match(/^NEXT_PUBLIC_APP_URL=(.+)$/m)?.[1]?.trim();
    const platformHost = paste.match(/^PLATFORM_HOST=(.*)$/m)?.[1]?.trim();
    expect(appUrl).toBeTruthy();
    expect(platformHost).toBe("");
    expect(appUrl).not.toContain(String(platformHost || " never"));
  });

  it("ships the vault names it never mentioned", () => {
    for (const file of ["RAILWAY-VARIABLES-PASTE.txt", ".env.example"]) {
      expect(read(file), file).toContain("VAULT_ENCRYPTION_KEY");
      expect(read(file), file).toContain("VAULT_BLIND_INDEX_PEPPER");
    }
  });

  /**
   * ⚠️ THE CRON COMMAND COULD NEVER HAVE WORKED. It sent
   * `x-worker-secret`, a header the route does not read, and no body,
   * so even correct authentication returns 400 "Nothing to do".
   */
  it("documents a cron command the route would actually accept", () => {
    /**
     * ⚠️ THE NOTE UNDER THE COMMAND QUOTES THE OLD HEADER on purpose,
     * so nobody re-adds it. Assert on the fenced blocks rather than on
     * the file — the same trap `four-eyes.test.ts` fell into an hour
     * earlier, and `purchase-posting.test.ts` twice before that.
     */
    const deploy = read("docs/RAILWAY-DEPLOY.md");
    const blocks = [...deploy.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join("\n");
    expect(blocks).not.toContain("x-worker-secret");
    expect(blocks).toContain("Authorization: Bearer $WORKER_API_SECRET");
    expect(blocks).toContain('{"mode":"cron"}');

    /** ⚠️ The route reads the header name lower-cased, as Fetch normalises it. */
    const route = read("app/api/workers/route.ts");
    expect(route).toContain('headerList.get("authorization")');
    expect(route).toContain('authHeader?.startsWith("Bearer ")');
    expect(route).not.toContain("x-worker-secret");
  });

  /**
   * 🔴 THREE SECRETS WERE PRINTED AS LITERALS in a committed document
   * under "copy these exactly". Anyone with repository read access held
   * the worker bearer token, the cron secret and the upload-ticket HMAC
   * key. The literals are gone; the rotation is the owner's to do.
   */
  it("no longer prints generated secrets as literals", () => {
    const doc = read("docs/ENVIRONMENT-VARIABLES.md");
    const block = doc.slice(doc.indexOf("UPLOAD_TICKET_SECRET"));
    expect(block.slice(0, 400)).not.toMatch(/=\s*[A-Za-z0-9_-]{20,}/);
    expect(doc).toContain("openssl rand -hex 32");
    expect(doc).toContain("rotate all three now");
  });
});

/* ================================================================== */
/* ⑤ EVERY WORKSPACE GETS AN OWNER, AND CLERK CANNOT TAKE IT           */
/* ================================================================== */

describe("workspace ownership", () => {
  const hook = read("app/api/webhooks/clerk/route.ts");

  /** The premise: only an owner can pay. */
  it("keeps billing:manage out of tenant_admin", () => {
    expect(permissionsForRole("tenant_owner")).toContain("billing:manage");
    expect(permissionsForRole("tenant_admin")).not.toContain("billing:manage");
  });

  /**
   * 🔴 THE FOUNDER IS THE OWNER. Clerk's default creator role is
   * `org:admin`, so a self-serve workspace previously started with zero
   * `tenant_owner` rows and nobody who could subscribe.
   */
  it("makes the workspace creator the owner", () => {
    expect(hook).toContain("const isCreator =");
    expect(hook).toContain("membership.organization.created_by === clerkUserId");
    expect(hook).toContain("const isFounder = isCreator ||");
    expect(hook).toContain('isFounder ? "tenant_owner" : mapClerkRole(membership.role)');
  });

  /**
   * ⚠️ TWO SIGNALS, EITHER SUFFICIENT — so a Clerk payload that omits
   * `created_by` does not leave a workspace ownerless.
   */
  it("falls back to the first member when Clerk names no creator", () => {
    expect(hook).toContain("priorMembers");
    expect(hook).toContain("isNull(users.deletedAt)");
  });

  /**
   * 🔴 CLERK CANNOT MINT AN OWNER. The webhook wrote whatever role
   * Clerk reported with no rank check, no self check and no owner
   * count, while `updateUserRole` has all three. Clerk's membership UI
   * is reachable by any `org:admin`, so a `tenant_admin` editing their
   * own membership could arrive back as `tenant_owner` and gain
   * `billing:manage` plus the ability to demote every other owner.
   */
  it("never maps a Clerk role to tenant_owner", () => {
    const fn = hook.slice(hook.indexOf("function mapClerkRole"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toContain('return "tenant_owner"');
    expect(body).toContain('case "org:owner":');
    expect(body).toContain('return "tenant_admin"');
  });

  /**
   * 🔴 AND CANNOT DEMOTE ONE. The reverse, and the one that strands a
   * workspace: an owner edited in Clerk came back as `tenant_admin` and
   * the last `billing:manage` vanished with no in-product action. It
   * also silently reverted in-app demotions of a rogue admin.
   */
  it("ignores a Clerk role change for an existing owner, and says so", () => {
    expect(hook).toContain('const keepsOwnRole = existing.role === "tenant_owner"');
    expect(hook).toContain("role: keepsOwnRole ? existing.role : role");
    expect(hook).toContain(
      "ownership is granted in the product, not in the identity provider",
    );
  });

  /**
   * 🔴 THE LAST OWNER SURVIVES `membership.deleted`. `updateUserStatus`
   * counts remaining owners; this path did not, so removing the last
   * owner from the Clerk organisation left a workspace nobody could pay
   * for and nobody could appoint an owner in.
   *
   * ⚠️ THE ROW IS RETAINED RATHER THAN THE EVENT REFUSED — a non-2xx
   * makes Clerk retry forever. They cannot sign in either way.
   */
  it("retains the last owner row when Clerk removes the membership", () => {
    expect(hook).toContain('if (existing.role === "tenant_owner")');
    expect(hook).toContain("The last owner was removed from the Clerk organisation");
    expect(hook).toContain('newValue: { status: existing.status, refused: "offboarded" }');
  });
});

/* ================================================================== */
/* ⑥ WHO COUNTS AS AN OWNER                                            */
/* ================================================================== */

describe("the last-owner guards count the right people", () => {
  const team = read("server/actions/team.ts");

  /**
   * 🔴 A GHOST COULD BE THE LAST OWNER. Both guards used
   * `ne(status, "suspended")` with no `deletedAt` filter, and
   * `user_status` has FOUR values — so `offboarded` passed, and so did
   * a soft-deleted row. A workspace whose only remaining owners left two
   * years ago read as having two, and the real one could be demoted on
   * that basis.
   */
  it("counts only active, undeleted owners", () => {
    expect(team).toContain("function usableOwners(tenantId: string)");
    expect(team).toContain('eq(users.status, "active")');
    expect(team).toContain("isNull(users.deletedAt)");
    expect(team).not.toMatch(/ne\(users\.status, "suspended"\)/);
  });

  /** ⚠️ One predicate, used by both guards, so they cannot drift apart. */
  it("uses the same predicate in both guards", () => {
    expect(team.match(/usableOwners\(ctx\.tenant\.id\)/g)?.length).toBe(2);
  });

  /**
   * The team screen computes its own owner count from this list, so an
   * offboarded owner appeared as a colleague AND as an owner, and the
   * page agreed with the server about a number both had wrong.
   */
  it("does not list soft-deleted people as team members", () => {
    expect(team).toContain(
      "and(eq(users.tenantId, ctx.tenant.id), isNull(users.deletedAt))",
    );
  });
});
