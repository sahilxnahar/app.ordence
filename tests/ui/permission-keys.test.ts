/**
 * Ordence — ⭐⭐⭐ THE KEYS THAT DENIED EVERYONE
 * Version: v1.31.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS ABOUT
 * ══════════════════════════════════════════════════════════════════════
 * `PERMISSION_CATALOG` holds 180 keys. `requirePermission` was typed
 * `string`. Five keys in daily use were not in the catalogue:
 *
 *   settings.manage            13 files
 *   crm.contacts.read          11 files
 *   crm.contacts.write          7 files
 *   purchases.invoices.read     2 files
 *   purchases.invoices.create   2 files
 *
 * `evaluatePermission` fails CLOSED on an unrecognised key — correctly,
 * because the alternative turns every typo into a security hole. So
 * every one of those guards returned `unknown_permission` and denied
 * EVERY user, including `tenant_owner`. Twenty-four files: tasks,
 * activities, agenda, enquiries, messaging, campaigns, consent notices,
 * banking, connections, stock counts, purchase orders, templates,
 * agents, legal billing, time billing, sales posting, landed cost and
 * vendor payments.
 *
 * ⚠️ `check:guards` PASSED ALL OF THEM. It matched guard NAMES and had
 * never once looked at the argument, so it reported
 * `578 endpoints, 534 authorisation-checked` while a quarter of the
 * product was unreachable.
 *
 * ⭐ THE REAL FIX IS THE TYPE. `requirePermission(permission:
 * PermissionKey)` makes an unknown key a compile error, and typing it
 * immediately found a sixth and a seventh the greps had missed:
 * `construction.variation.approve`, used by `approveVariation`,
 * `rejectVariation` AND — by copy-paste — `verifyUan`.
 *
 * This file is the belt to that braces. A type is only enforced where
 * the value is typed; a string arriving from a config file, a database
 * row or a `JSON.parse` is not.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PERMISSION_CATALOG,
  ALL_PERMISSIONS,
  DANGEROUS_PERMISSIONS,
  ROLE_TEMPLATES,
  permissionsForRole,
} from "@/db/schema/auth";
import { evaluatePermission } from "@/lib/permissions";
import { RECOVERABLE_ENTITIES } from "@/lib/backup/recoverable";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every .ts/.tsx under a directory, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(rel, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/* ================================================================== */
/* ① NO GUARD MAY NAME A KEY THAT DOES NOT EXIST                       */
/* ================================================================== */

describe("every permission a guard names is in the catalogue", () => {
  /**
   * 🔴 THE REGRESSION THIS FILE EXISTS FOR.
   *
   * Resolves both forms the codebase actually uses: an inline literal,
   * and the far more common file-local
   * `const READ = "contacts:read" as const;`.
   */
  it("finds no unknown key in any guard call, inline or via a const", () => {
    const catalogue = new Set<string>(ALL_PERMISSIONS);
    const unknown: string[] = [];

    const GUARDS =
      /(?:requirePermission|requireAllPermissions|requireFeatureAndPermission|checkPermission|canAll|canAny|can)\s*\(([^;]{0,300})/g;
    const PROP = /permission:\s*(?:([A-Z][A-Z0-9_]*)|"([a-z0-9_]+[.:][a-z0-9_.:]+)")/g;

    for (const file of [...walk("server"), ...walk("lib")]) {
      const src = read(file);

      const consts: Record<string, string> = {};
      for (const m of src.matchAll(
        /(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=\s*"([a-z0-9_]+[.:][a-z0-9_.:]+)"/g,
      )) {
        consts[m[1]] = m[2];
      }

      const seen = new Set<string>();
      const collect = (segment: string) => {
        for (const lit of segment.matchAll(/"([a-z0-9_]+[.:][a-z0-9_.:]+)"/g)) {
          seen.add(lit[1]);
        }
        for (const id of segment.matchAll(/\b([A-Z][A-Z0-9_]{1,})\b/g)) {
          if (consts[id[1]]) seen.add(consts[id[1]]);
        }
      };
      for (const m of src.matchAll(GUARDS)) collect(m[1]);
      for (const m of src.matchAll(PROP)) collect(m[0]);

      for (const key of seen) {
        /**
         * ⚠️ PLATFORM CAPABILITIES ARE A DIFFERENT VOCABULARY.
         * `tenants:suspend`, `impersonate:breakglass` and the rest live
         * in `lib/platform/roles.ts` and go to `requireCapability`, not
         * `requirePermission`. Excluding them by prefix is honest here
         * because `PlatformCapability` is its own closed union and has
         * its own test.
         */
        if (/^(tenants|impersonate|staff|flags|entitlements|observatory|search):/.test(key)) {
          continue;
        }
        if (!catalogue.has(key)) unknown.push(`${file}: ${key}`);
      }
    }

    expect(unknown).toEqual([]);
  });

  /**
   * ⭐ THE FIVE, BY NAME. If any comes back, this says which.
   */
  it("does not contain the five keys that were dead until v1.31.0", () => {
    const dead = [
      "settings.manage",
      "crm.contacts.read",
      "crm.contacts.write",
      "purchases.invoices.read",
      "purchases.invoices.create",
    ];
    const offenders: string[] = [];
    for (const file of [...walk("server"), ...walk("lib"), ...walk("app")]) {
      const src = read(file);
      for (const key of dead) if (src.includes(`"${key}"`)) offenders.push(`${file}: ${key}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * 🔴 AN UNKNOWN KEY MUST DENY, NOT GRANT. The whole reason the five
   * were invisible is that the failure was silent AND safe. If this
   * ever inverted, the same class of typo would become a hole instead
   * of an outage.
   */
  it("denies an unknown key even to the owner", () => {
    const verdict = evaluatePermission(
      { role: "tenant_owner", overrides: {} },
      "settings.manage" as never,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("unknown_permission");
  });

  /**
   * ⚠️ THE TYPE IS THE PRIMARY CONTROL, so assert it is still there.
   * A future refactor widening this back to `string` would silently
   * re-open the door that the five walked through.
   */
  it("keeps the guard signatures typed to PermissionKey", () => {
    const audit = read("server/audit.ts");
    expect(audit).toContain("permission: PermissionKey,");
    expect(audit).toContain("permissions: readonly PermissionKey[],");
    expect(audit).not.toMatch(/export async function requirePermission\(\s*permission: string/);

    const perms = read("lib/permissions.ts");
    expect(perms).toContain("permission: PermissionKey): boolean");
  });
});

/* ================================================================== */
/* ② THE KEYS ADDED THIS SESSION                                       */
/* ================================================================== */

describe("the permissions added in v1.31.0", () => {
  /**
   * ⭐ `construction.variation.approve` WAS ARGUED FOR IN PROSE AND
   * NEVER EXISTED. `approveVariation`'s own comment says raising and
   * approving must be separately grantable "or the segregation of
   * duties is a matter of who happens to hold the role". Both approval
   * and rejection denied everybody.
   */
  it("has a real key for approving a BOQ variation", () => {
    expect(ALL_PERMISSIONS).toContain("construction.variation.approve");
    expect(DANGEROUS_PERMISSIONS).toContain("construction.variation.approve");

    const src = read("server/actions/variations.ts");
    expect(src).toContain('"construction.variation.approve"');
  });

  /**
   * 🔴 AND IT IS NOT THE KEY FOR VERIFYING A WORKER'S UAN.
   * `verifyUan` had copied it. Its three siblings in the same file all
   * use `construction.boq.manage`, so it does too.
   */
  it("does not gate UAN verification on the variation-approval key", () => {
    const src = read("server/actions/labour.ts");
    expect(src).not.toContain('"construction.variation.approve"');
    expect(src).toContain('permission: "construction.boq.manage"');
  });

  /**
   * ⚠️ SEGREGATION SURVIVES. The person who raises a variation must not
   * be able to approve it by virtue of the same role, so no explicit
   * template may hold the approval key. `tenant_owner` and
   * `tenant_admin` take it from `"*"` / `ALL_PERMISSIONS`, which is the
   * same position `construction.boq.manage` is already in.
   */
  it("grants variation approval to nobody by role template", () => {
    for (const [role, template] of Object.entries(ROLE_TEMPLATES)) {
      if (template.permissions === "*") continue;
      if (role === "tenant_admin") continue;
      expect(template.permissions).not.toContain("construction.variation.approve");
    }
  });

  /**
   * 🔴 A STOCKTAKE IS A WRITE. `stock-counts.ts` argues at length that
   * counting and approving must be different permissions, and then used
   * `inventory.stock.read` for the counting side — which `read_only`
   * and `guest` both hold.
   */
  it("has a write-side key for recording a stocktake", () => {
    expect(ALL_PERMISSIONS).toContain("inventory.counts.record");
    const src = read("server/actions/stock-counts.ts");
    expect(src).toContain('const COUNT = "inventory.counts.record"');
    expect(src).not.toContain('const COUNT = "inventory.stock.read"');
    expect(permissionsForRole("read_only")).not.toContain("inventory.counts.record");
    expect(permissionsForRole("guest")).not.toContain("inventory.counts.record");
  });

  /** A goods receipt posts stock. It was behind the permission to look at it. */
  it("gates a goods receipt on posting stock, not on reading it", () => {
    const src = read("server/actions/purchase-orders.ts");
    expect(src).toContain('const RECEIVE = "inventory.movements.post"');
  });
});

/* ================================================================== */
/* ③ THE EXPORT                                                        */
/* ================================================================== */

describe("who can take the whole workspace out", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 `exportWorkspace` RETURNED 26 TABLES BEHIND `settings:read`
   * ══════════════════════════════════════════════════════════════════
   * Contacts, contracts, documents, ledgers, transactions, journal
   * entries, invoices — and the audit log. `read_only` holds
   * `settings:read`. That role is deliberately denied
   * `contacts:export`, `reports:export`, `leads:export` and even
   * `tds:read`, on the stated grounds that a role handed out for "let
   * them see the numbers" should not carry a hundred third parties'
   * PANs. One key it did hold returned all of it, unaudited and
   * unthrottled.
   */
  it("requires a permission the read-only role does not hold", () => {
    expect(ALL_PERMISSIONS).toContain("workspace:export");
    expect(DANGEROUS_PERMISSIONS).toContain("workspace:export");

    expect(permissionsForRole("read_only")).not.toContain("workspace:export");
    expect(permissionsForRole("guest")).not.toContain("workspace:export");
    expect(permissionsForRole("member")).not.toContain("workspace:export");

    // ⭐ And a customer trying to leave must still be able to.
    expect(permissionsForRole("tenant_owner")).toContain("workspace:export");
    expect(permissionsForRole("tenant_admin")).toContain("workspace:export");
  });

  it("is what the action actually asks for", () => {
    const src = read("server/actions/recovery.ts");
    expect(src).toContain('requirePermission("workspace:export")');
    expect(src).not.toContain('requirePermission("settings:read")');
  });

  /**
   * 🔴 NOTHING RECORDED THE LARGEST READ IN THE PRODUCT. "Did anyone
   * take a copy of everything before they left?" was unanswerable.
   */
  it("writes a critical audit row with the row counts, before returning", () => {
    const src = read("server/actions/recovery.ts");
    const auditAt = src.indexOf("await writeAudit(ctx, {");
    const returnAt = src.indexOf("json: serialiseExport(exported)");
    expect(auditAt).toBeGreaterThan(-1);
    expect(auditAt).toBeLessThan(returnAt);
    expect(src).toContain('severity: "critical"');
    expect(src).toContain("totalRows");
  });

  /** One export is a backup. Fifty is a leak. There was no limit at all. */
  it("has a budget", () => {
    const src = read("server/actions/recovery.ts");
    expect(src).toContain("checkRateLimit(");
    expect(src).toContain("tenantRateLimitKey(ctx.tenant.id, ctx.user.id)");
  });

  /**
   * ⚠️ THE PAYWALL EXEMPTION IS ON THE OPERATION PREFIX, not the
   * permission, so a locked customer can still leave with their data.
   */
  it("stays exempt from the paywall", async () => {
    const { isExemptWrite } = await import("@/lib/billing/access-state");
    expect(isExemptWrite("export:workspace")).toBe(true);
  });
});

/* ================================================================== */
/* ④ UN-DELETING IS AS CONSEQUENTIAL AS DELETING                       */
/* ================================================================== */

describe("the recycle bin asks the right permission per entity", () => {
  /**
   * 🔴 `restoreFromRecycleBin` REQUIRED `contacts:update` FOR EVERY
   * TABLE. A `member` holds it and holds neither `contracts:update` nor
   * `documents:create`, so the bin was a way around both — a contract
   * counsel deliberately deleted could be brought back by anyone who
   * could edit a contact.
   */
  it("carries a restore permission on every recoverable entity", () => {
    const catalogue = new Set<string>(ALL_PERMISSIONS);
    for (const entity of RECOVERABLE_ENTITIES) {
      expect(entity.restorePermission, entity.table).toBeTruthy();
      expect(catalogue.has(entity.restorePermission), entity.table).toBe(true);
      // ⚠️ Never a read key. Restoring is a write.
      expect(entity.restorePermission, entity.table).not.toMatch(/[.:]read$/);
    }
  });

  it("reads that permission rather than a hard-coded one", () => {
    const src = read("server/actions/recovery.ts");
    expect(src).toContain("requirePermission(entity.restorePermission)");
    expect(src).not.toContain('requirePermission("contacts:update")');
  });

  /** The specific crossing that was possible before. */
  it("no longer lets a contact editor restore a contract", () => {
    const contracts = RECOVERABLE_ENTITIES.find((e) => e.table === "contracts")!;
    expect(contracts.restorePermission).toBe("contracts:update");
    expect(permissionsForRole("member")).not.toContain("contracts:update");
  });
});

/* ================================================================== */
/* ⑤ THE GATE THAT NOW LOOKS AT THE ARGUMENT                           */
/* ================================================================== */

describe("check:guards reads the permission, not just the guard's name", () => {
  it("has the read-key-on-a-write assertion", () => {
    const gate = read("scripts/check-action-guards.mjs");
    expect(gate).toContain("READ_SHAPED");
    expect(gate).toContain("permissionKeysIn");
    expect(gate).toContain("every permission it requires is a READ key");
  });

  /**
   * ⚠️ IT MUST READ THE DELEGATE'S KEY TOO. `orders.ts` and
   * `variations.ts` pass the permission into a local `transition()`
   * helper, so the key is at the call site and the guard is one hop
   * away. A version that only looked at the endpoint body would see no
   * keys at all and say nothing.
   */
  it("follows the key into a local helper", () => {
    const gate = read("scripts/check-action-guards.mjs");
    expect(gate).toContain("guardBodies.push(calleeBody)");
  });

  /**
   * ⭐ THE ONE HONEST EXEMPTION. `getThread` writes `lastReadAt` on the
   * caller's OWN participant row and nothing else. Opening a thread is
   * reading it.
   */
  it("exempts the read-with-a-side-effect explicitly, with a reason", () => {
    const gate = read("scripts/check-action-guards.mjs");
    expect(gate).toContain('"messages.ts#getThread"');
    expect(gate).toContain("Marks the caller's own participant row as read");
  });
});
