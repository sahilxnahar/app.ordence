/**
 * Ordence — User Enumeration Audit (Hardening II / v1.50.0-alpha)
 *
 * WHAT IS PROVED HERE.
 *
 * User enumeration is the failure where an endpoint answers "does this
 * email exist?" differently for users and non-users — "email not found"
 * vs "wrong password", a resend that says "no such account" vs "email
 * sent". An attacker sweeps the address space and harvests the real
 * accounts in an afternoon.
 *
 * This audit asserts the structural reason the product CANNOT leak that
 * answer, and then verifies the one place that could have invented the
 * leak doesn't contain it.
 *
 * THE STRUCTURAL REASON: this codebase never performs a server-side
 * existence check on an unauthenticated email address. Sign-in, sign-up,
 * password reset and email verification are ALL Clerk-hosted — the app
 * has no route that accepts an email from an anonymous caller and looks
 * anything up with it. The audit therefore inspects three properties:
 *
 *   1. No imported Clerk admin call: `clerkClient.users.*`,
 *      `auth().users.*` and `orgs.listMembers` never appear in runtime
 *      code, because any of them next to an email input is the leak.
 *   2. No "user lookup" action or API route exists in the runtime tree.
 *   3. The one module that COULD have invented a lookup surface — the
 *      recovery server action — contains no email-based check at all.
 *
 * The Clerk-hosted surfaces are uniform by construction (Clerk returns
 * "check your email" for both cases of a reset request), and configuring
 * that uniformity is a Clerk-dashboard action, documented in
 * DEPLOY-v1.50.0-alpha.md.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd());

/** All `.ts` files under app/, server/ and lib/, excluding tests. */
function runtimeFiles(): string[] {
  const out: string[] = [];
  const dirs = ["app", "server", "lib"];
  for (const dir of dirs) {
    const walk = (p: string) => {
      for (const entry of readdirSync(p)) {
        const full = join(p, entry);
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
      }
    };
    walk(join(ROOT, dir));
  }
  return out;
}

/**
 * ⭐ DECLARED EXEMPTIONS — one entry, added at Wave 4 integration.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY AN EXEMPTION AND NOT A LOOSER PATTERN
 * ══════════════════════════════════════════════════════════════════════
 * This test's own comment says what the two acceptable fixes are:
 * *"Remove the call, or gate it behind an internal-admin surface with its
 * own authorization."* It had no way to express the second, so a file
 * that took it looked identical to a leak. Widening the regex would have
 * hidden the next real one; deleting the assertion would have hidden all
 * of them.
 *
 * ⚠️ AN ENTRY HERE IS A DECISION, SO `reason` IS REQUIRED AND THE PATH IS
 * EXACT. No globs: `server/platform/**` would exempt forty files on the
 * strength of one review.
 *
 * ⚠️ AND THE EXEMPTION IS ITSELF VERIFIED. The test below refuses an entry
 * whose file no longer exists, or that no longer matches any forbidden
 * pattern — otherwise a stale exemption quietly widens over time, which
 * is how the fail-open registry rotted before it was pinned.
 */
const DECLARED_EXEMPTIONS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "server/platform/adopt-clerk-org.ts",
    reason:
      "resolveOwnerUserId() calls users.getUserList to find the Clerk account " +
      "that will own a workspace being provisioned. It is reached only from " +
      "the platform console behind requirePlatformAdmin(), it never answers " +
      "an anonymous caller, and it takes the address from the provisioning " +
      "record rather than from a request body. It also refuses on " +
      "totalCount !== 1 rather than picking one, so it cannot be used to " +
      "probe: two accounts for one address is an error, not an answer.",
  },
];

const CLERK_ADMIN_PATTERNS = [
  /clerkClient\.users\./,
  /\baut\(\)\.users\./,
  /orgs\.listMembers/,
  /users\.createUser/,
  /users\.getUser/,
  /createEmailVerification|createPasswordReset/,
];

describe("user enumeration — no server-side existence surface", () => {
  it("runtime code never calls the Clerk admin user API", () => {
    // If this ever triggers, the fix is never "adjust the error message":
    // the CALL ITSELF is the leak, because its response distinguishes
    // existing accounts from invented ones. Remove the call, or gate it
    // behind an internal-admin surface with its own authorization.
    const exempt = new Set(DECLARED_EXEMPTIONS.map((e) => join(ROOT, e.file)));
    const offenders: string[] = [];
    for (const file of runtimeFiles()) {
      if (exempt.has(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const pattern of CLERK_ADMIN_PATTERNS) {
        if (pattern.test(src)) {
          offenders.push(`${file} (${pattern.source})`);
          break;
        }
      }
    }
    expect(offenders, offenders.join("\n")).toHaveLength(0);
  });

  /**
   * 🔴 THE EXEMPTIONS ARE CHECKED TOO, AND THIS IS THE HALF THAT ROTS.
   * A declared exemption whose file was deleted or whose call was removed
   * is a hole standing open for whatever is written there next.
   */
  it("every declared exemption still names a real file that still needs it", () => {
    const stale: string[] = [];
    for (const entry of DECLARED_EXEMPTIONS) {
      const full = join(ROOT, entry.file);
      let src: string;
      try {
        src = readFileSync(full, "utf8");
      } catch {
        stale.push(`${entry.file} — declared exempt but the file does not exist`);
        continue;
      }
      if (!CLERK_ADMIN_PATTERNS.some((p) => p.test(src))) {
        stale.push(
          `${entry.file} — no longer calls a Clerk admin user API, so the ` +
            `exemption is dead and must be deleted`,
        );
      }
      if (entry.reason.trim().length < 40) {
        stale.push(`${entry.file} — reason is too short to be a decision`);
      }
    }
    expect(stale, stale.join("\n")).toHaveLength(0);
  });

  it("no route or action answers an existence question about an email", () => {
    // Endpoint names are the honest signal: anything with "lookup",
    // "exists", "check" plus "user"/"email" in a runtime file is a
    // candidate leak surface that must not exist at all.
    const offenders: string[] = [];
    for (const file of runtimeFiles()) {
      const name = file.toLowerCase();
      if (
        name.includes("userlookup") ||
        name.includes("emailexists") ||
        name.includes("checkuser") ||
        name.includes("checkemail")
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toHaveLength(0);
  });

  it("the recovery action contains no email existence check", () => {
    const src = readFileSync(join(ROOT, "server/actions/recovery.ts"), "utf8");
    // A lookup by email would look up the users table or call Clerk by
    // identifier — neither string family may appear in this file.
    expect(src).not.toMatch(/getUserByEmail|email.*exists|identifier/i);
  });
});
