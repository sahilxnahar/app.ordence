/**
 * Ordence — ⭐⭐ SETTINGS → AUDIT TRAIL
 * Version: v1.60.0-alpha (Batch 30)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ROWS EXISTED. THE SCREEN DID NOT.
 * ══════════════════════════════════════════════════════════════════════
 * `audit_logs` has been written since Phase 1, hardened by an
 * append-only trigger in 0001 and hash-chained in 0081. Every reader of
 * it was internal: the platform console, a verification script, a
 * security test. A customer could not see one row of their own history
 * by any route in the product.
 *
 * ⚠️ WHICH MADE EVERY CLAIM ABOUT IT UNVERIFIABLE BY THE PERSON IT WAS
 * MADE TO. `/settings/support-access` tells a customer that support
 * cannot enter without permission and that "every visit is recorded".
 * Recorded where? Until this page, in a table only we could read. A
 * promise whose evidence only the promiser can see is a promise.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE FIRST TAB IS "ORDENCE STAFF ACCESS"
 * ══════════════════════════════════════════════════════════════════════
 * A customer opening an audit page for the first time is almost always
 * doing one of two things: investigating something inside their own
 * company, or answering a security questionnaire about us. The second
 * has no other screen. Defaulting the page to everything and burying
 * staff access behind a dropdown would technically satisfy the
 * requirement and practically hide it.
 *
 * ⚠️ NOT DEFAULTED TO STAFF ACCESS, THOUGH — defaulted to EVERYTHING,
 * with staff access as the first and loudest filter and its own summary
 * card above the table. A page that opens filtered looks like a page
 * with nothing on it on the (very common, and good) day when no staff
 * member has been anywhere near the workspace.
 */

import Link from "next/link";
import { requirePermission } from "@/server/audit";
import { can } from "@/lib/permissions";
import { loadAuditTrail, exportAuditTrail } from "@/server/actions/audit-trail";
import { AuditTrailView } from "@/components/audit/audit-trail-view";
import { parseAuditFilters } from "@/lib/audit/customer-view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Audit trail · Ordence" };

export default async function AuditTrailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /**
   * ⚠️ THE PAGE GUARDS ITSELF AS WELL AS THE ACTION.
   *
   * `loadAuditTrail()` calls `requirePermission("audit:read")` and would
   * refuse on its own, so this looks redundant. It is not: without it,
   * somebody without the permission gets a rendered page frame, a
   * heading that says "Audit trail", and an exception inside the data
   * call — a screen that tells them the feature exists and that they
   * were nearly allowed to use it. Failing at the top produces the
   * ordinary permission-denied path instead.
   */
  const ctx = await requirePermission("audit:read");

  /**
   * ⭐ THE DOWNLOAD BUTTON IS HIDDEN FROM PEOPLE THE ENDPOINT WOULD
   * REFUSE, AND THE ENDPOINT STILL REFUSES THEM.
   *
   * ⚠️ THIS IS PRESENTATION, NOT SECURITY, AND THE ORDER MATTERS.
   * `exportAuditTrail()` requires `audit:read` AND `workspace:export` on
   * its own first line; hiding the button changes nothing about who may
   * call the URL. What it changes is that a `security_admin` — who can
   * read every row here and cannot download them — is not offered a
   * button that throws.
   *
   * ⚠️ `can()` RATHER THAN `checkPermission()`. The latter RECORDS a
   * denial, and recording one on every page load for a role that is
   * meant to live on this screen would fill `permission_denials` with
   * noise and bury the cluster of real denials that table exists to make
   * visible.
   */
  const canExport = can(
    { role: ctx.role, overrides: ctx.user.permissionOverrides },
    "workspace:export",
  );

  const params = await searchParams;
  const first = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  /**
   * ⭐ THE URL IS THE FILTER STATE, AND THAT IS DELIBERATE ON THIS PAGE
   * MORE THAN MOST. "Send me the link to what you were looking at" is
   * the first thing anybody says during an incident, and a filter held
   * only in React state cannot be sent.
   *
   * ⚠️ PARSED THROUGH THE SAME `parseAuditFilters()` THE ACTION USES, so
   * a hand-edited query string cannot express anything the RPC endpoint
   * would not also accept.
   */
  const initialFilters = parseAuditFilters({
    category: first("category"),
    from: first("from"),
    to: first("to"),
    actor: first("actor"),
  });

  const initial = await loadAuditTrail(initialFilters);

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit trail</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          What happened in this workspace, who did it and when — including every
          time Ordence staff touched your data. Times are shown in Indian
          Standard Time.
        </p>
      </div>

      <AuditTrailView
        initialEvents={initial.events}
        initialCursor={initial.nextCursor}
        initialHasMore={initial.hasMore}
        initialFilters={{
          category: initialFilters.category,
          from: initialFilters.from,
          to: initialFilters.to,
          actor: initialFilters.actor,
        }}
        canExport={canExport}
        loadAction={loadAuditTrail}
        exportAction={exportAuditTrail}
      />

      <p className="border-t border-border pt-4 text-xs text-muted-foreground">
        Support access is granted and revoked on{" "}
        <Link
          href="/settings/support-access"
          className="underline underline-offset-2"
        >
          the support access page
        </Link>
        . Nothing you do there can remove an entry from this log.
      </p>
    </main>
  );
}
