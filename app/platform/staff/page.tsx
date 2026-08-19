/**
 * Ordence — Platform Console · Staff Access
 * Version: v1.43.0-alpha (Mega-wave 2, Batch 42)
 *
 * The access review page, and — since Batch 42 — the only place in the
 * product where platform access is actually given and taken away.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BEFORE THIS, EVERY GRANT IN THIS PRODUCT WAS A HAND-WRITTEN INSERT
 * ══════════════════════════════════════════════════════════════════════
 * `grantPlatformStaff` and `revokePlatformStaff` were complete and had
 * ZERO CALLERS. This page read the table and offered no way to change it,
 * so adding a colleague — or removing one whose laptop had just been
 * stolen — meant a psql prompt against the production database.
 *
 * ⚠️ THE REVOCATION HALF IS THE URGENT ONE. `platform_staff` is designed
 * as the FAST key: the env allowlist needs a reviewed deploy to change,
 * this needs one UPDATE. That asymmetry — "the cheap operation is the
 * safe one" — only exists if the cheap operation has a button.
 *
 * ⭐ THE COLUMN TO READ IS `On allowlist`. Platform access needs BOTH an
 * entry in `PLATFORM_ADMIN_EMAILS` (a reviewed config deploy) and an
 * active row here. A row whose email is no longer on the allowlist cannot
 * sign in — which is correct — but it is also a stale grant nobody
 * cleaned up, and drift between the two keys is exactly what an access
 * review is for.
 */

import { Suspense } from "react";
import { getStaffDirectory } from "@/server/platform/staff";
import {
  grantPlatformStaffAction,
  revokePlatformStaffAction,
  recordStepUpAction,
} from "@/server/platform/actions";
import { StaffConsole } from "@/components/platform/staff-console";
import { onConsoleHost } from "@/lib/platform/console-href";

export const dynamic = "force-dynamic";

export const metadata = { title: "Platform access · Ordence" };

export default function PlatformStaffPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Platform access</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Everyone who can cross a tenant boundary. Access needs two independent keys:
          the deploy-time <code className="font-mono">PLATFORM_ADMIN_EMAILS</code>{" "}
          allowlist and an active grant below. Revoking either one is enough; creating
          access needs both, and this screen can only turn the second.
        </p>
      </div>

      <Suspense fallback={<div className="h-40 animate-pulse rounded-md bg-muted" />}>
        <StaffDirectory />
      </Suspense>
    </div>
  );
}

async function StaffDirectory() {
  // ⚠️ The console is served at two base paths. A grant held by
  // `staff.elevate` links to the approvals queue, and `/platform/...` on
  // the console host is not a rewritten path — it is a 404.
  const isConsole = await onConsoleHost();
  const result = await getStaffDirectory();
  if (!result.ok) return <p className="text-sm text-destructive">{result.error}</p>;

  /**
   * ⚠️ THE ACTIONS ARE PASSED AS PROPS, and every one of them is a
   * `"use server"` wrapper rather than the engine function itself.
   *
   * `server/platform/staff.ts` opens with `import "server-only"` and
   * reaches `guard.ts`, which uses `withPlatformScope()` — the deliberate
   * cross-tenant escape hatch. A `"use client"` component importing that
   * chain fails the production build, and the correct answer is never to
   * strip the marker: it is to go through the wrapper, which is what
   * makes the function reachable from a browser AT ALL while leaving
   * `requireCapability("staff:manage")` where it belongs, inside the
   * implementation.
   *
   * ⚠️ AND REMEMBER WHAT THAT MEANS: all three are public HTTP endpoints
   * with stable action ids. Nothing about the rendering below protects
   * them; the guard inside the engine does, on every call, including the
   * ones that arrive by curl from a different page entirely.
   */
  return (
    <StaffConsole
      rows={result.data.rows}
      candidates={result.data.candidates}
      usableOwners={result.data.usableOwners}
      usableAllowlistedOwners={result.data.usableAllowlistedOwners}
      operator={result.data.operator}
      allowlistConfigured={result.data.allowlistConfigured}
      onGrant={grantPlatformStaffAction}
      onRevoke={revokePlatformStaffAction}
      onStepUp={recordStepUpAction}
      isConsoleHost={isConsole}
    />
  );
}
