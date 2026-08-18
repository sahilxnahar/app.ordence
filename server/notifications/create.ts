import "server-only";

/**
 * Ordence — Notification creation (internal)
 * Version: v0.88.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FUNCTION LIVES HERE AND NOT IN `server/actions/`
 * ══════════════════════════════════════════════════════════════════════
 * It used to be exported from `server/actions/notifications.ts`, which is
 * a `"use server"` file. That file's own header states the rule:
 *
 *     ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A "use server" file that
 *     exports anything else publishes it as an RPC endpoint reachable
 *     by anyone.
 *
 * The rule was followed — every export WAS an async function — and that
 * is precisely what made this one dangerous. `createNotification` takes
 * `tenantId` FROM ITS CALLER and passes it straight to `withTenant()`.
 * It never called `requireTenantContext()`.
 *
 * So it was a published endpoint that accepted the tenant to write into
 * as a parameter. Any authenticated session could invoke it with another
 * workspace's uuid and:
 *
 *   · insert a row into that workspace's notification feed
 *   · with an attacker-chosen title, body and actionUrl
 *   · and, at severity "critical" or "warning", EMAIL EVERY ACTIVE USER
 *     in that workspace — an Ordence-branded message containing a link
 *     the attacker chose
 *
 * Row-level security did not help. RLS enforces the tenant the
 * transaction declares, and this function let the caller declare it.
 * That is the one way past it, and it was reachable from a browser.
 *
 * ⚠️ THE FIX IS THE FILE IT IS IN, NOT A CHECK INSIDE IT.
 *
 * Adding `requireTenantContext()` here would have broken the two real
 * callers — a background worker and the MCP dispatcher — which have no
 * user session and legitimately act for a tenant they were given. The
 * correct boundary is: this is an INTERNAL module, `server-only`, not
 * callable from a browser at all. `check:boundaries` enforces that a
 * file like this declares `import "server-only"`, which is the line
 * above.
 *
 * If the UI ever needs to create a notification, add a THIN wrapper in
 * `server/actions/notifications.ts` that calls `requireTenantContext()`
 * and passes `ctx.tenant.id` — never a tenant id from the client.
 *
 * Callers, both server-side and both legitimate:
 *   server/ai/background-workers.ts
 *   server/mcp/dispatch.ts
 */

import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { notifications, users, tenants } from "@/db/schema";
import { sendEmail, buildNotificationEmail } from "@/lib/email/notifications";
import {
  parseNotificationPreferences,
  shouldEmailNotification,
} from "@/lib/notifications/preferences";

export async function createNotification(input: {
  tenantId: string;
  userId?: string;
  category: string;
  severity?: string;
  title: string;
  body?: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  source?: string;
  expiresAt?: Date;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const severity = input.severity ?? "info";

  /*
   * ⚠️ EMAIL IS OPT-IN BY SEVERITY, AND THE TEST IS EXHAUSTIVE ON PURPOSE.
   *
   * This condition used to read:
   *
   *     severity === "critical" || severity === "warning" || !input.severity
   *
   * The third clause meant the DEFAULT — an ordinary `info` notification with
   * no severity passed — also emailed every active user in the workspace.
   * `server/ai/background-workers.ts` creates these on a schedule, so the
   * practical effect was a mail-out per worker run per tenant. The comment
   * above it said "only if severity warrants it"; the code disagreed.
   */
  const shouldEmail = severity === "critical" || severity === "warning";

  try {
    /*
     * ⚠️ ONE TRANSACTION, NOT THREE ROUND TRIPS.
     *
     * The insert, the tenant name and the recipient list are all tenant-scoped
     * reads, so they belong in the same `withTenant()` block. Previously this
     * was an insert in one transaction, a `db` read, and a SECOND transaction
     * for the recipients — three separate connections per notification.
     *
     * 🔴 The tenant-name lookup was also silently broken. It used the plain
     * `db` client, which carries NO tenant context, so every RLS policy
     * evaluates `tenant_id = app_current_tenant_id()` against NULL and matches
     * nothing — the same failure documented on `withPlatformScope()`. It
     * returned zero rows and fell through to "Your workspace" every single
     * time. Inside the transaction it actually resolves.
     */
    const created = await withTenant(input.tenantId, async (tx) => {
      const result = await tx
        .insert(notifications)
        .values({
          tenantId: input.tenantId,
          userId: input.userId ?? null,
          category: input.category,
          severity,
          title: input.title,
          body: input.body ?? null,
          actionUrl: input.actionUrl ?? null,
          metadata: input.metadata ?? {},
          source: input.source ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning({ id: notifications.id });

      const id = result[0]?.id;
      if (!id) throw new Error("Notification insert returned no id.");

      if (!shouldEmail) {
        return { id, tenantName: null as string | null, recipients: [] as string[] };
      }

      const tenantRow = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);

      /*
       * ⭐⭐ THE PREFERENCE COLUMN IS READ HERE, AND THIS IS THE POINT OF
       * THE WHOLE CHANGE (0093 / v1.53.0).
       *
       * 🔴 UNTIL NOW THIS LINE SELECTED ONLY `email`, AND THAT WAS THE
       *    DEFECT. The settings screen let a user switch off "Inventory"
       *    or turn off email delivery entirely, and stored the answer in
       *    that browser's `localStorage`. This function — a background
       *    worker's function, running on a schedule with no browser
       *    anywhere near it — could not read that store and so emailed
       *    every active user regardless. The switch moved, went grey,
       *    and changed nothing. A control that reports success and does
       *    nothing is worse than no control, because the user stops
       *    watching for the mail they believe they silenced.
       *
       * ⚠️ THE PREFERENCE IS APPLIED HERE, INSIDE THE QUERY'S OWN
       *    TRANSACTION, RATHER THAN BY EACH CALLER. There are two
       *    callers today (a background worker and the MCP dispatcher)
       *    and neither knows the recipients — this function computes
       *    them. A filter anywhere else would be a filter one future
       *    caller forgets.
       */
      const userRows = await tx
        .select({ email: users.email, preferences: users.preferences })
        .from(users)
        .where(and(eq(users.tenantId, input.tenantId), eq(users.status, "active")))
        .limit(50);

      const recipients = userRows
        .filter((u) =>
          /*
           * ⚠️ `parseNotificationPreferences` IS TOTAL AND THAT MATTERS
           * MOST RIGHT HERE. One user's malformed JSONB must not throw
           * inside this map and lose the notification for the other
           * forty-nine. Junk resolves to the permissive defaults, so an
           * unreadable preference delivers rather than silences.
           */
          shouldEmailNotification(parseNotificationPreferences(u.preferences), {
            category: input.category,
            severity,
          }),
        )
        .map((u) => u.email)
        .filter(Boolean);

      return {
        id,
        tenantName: tenantRow[0]?.name ?? null,
        recipients,
      };
    });

    if (shouldEmail && created.recipients.length > 0) {
      /*
       * ⚠️ PARALLEL, NOT SEQUENTIAL, AND NEVER ALLOWED TO THROW.
       *
       * This was a `for` loop with an `await` inside it — up to fifty
       * sequential HTTPS round trips to Resend, on the request path, before
       * the caller got its notification id back. `allSettled` collapses that
       * to one round and cannot reject, so a single bad address cannot lose
       * the other forty-nine.
       *
       * TODO: move this to the existing QStash queue (`lib/queue/`). Email is
       * not the caller's business and should not be on its clock at all.
       * Parallelising is the containment, not the cure.
       */
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.ordence.com";
      const { html, text } = buildNotificationEmail({
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
        severity,
        tenantName: created.tenantName ?? "Your workspace",
        appUrl,
      });

      const subject = `[${severity.toUpperCase()}] ${input.title}`;

      const results = await Promise.allSettled(
        created.recipients.map((to) => sendEmail({ to, subject, html, text })),
      );

      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        console.error(
          `[notifications] ${failed}/${created.recipients.length} notification emails failed for tenant ${input.tenantId}.`,
        );
      }
    }

    /*
     * ⚠️ THE REAL ID. This used to return the literal string "created",
     * discarding the UUID the transaction had just computed. Every caller
     * that stored or echoed the id — including the `ordence_create_reminder`
     * MCP tool, which hands it to an AI agent — received the word "created"
     * where a UUID was promised by this function's own return type.
     */
    return { ok: true, id: created.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create notification.",
    };
  }
}
