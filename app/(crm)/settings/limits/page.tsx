/**
 * Ordence — Settings · Limits
 * Version: v1.31.0-alpha (Batch 31)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A LIMIT NOBODY CAN SEE IS A LIMIT NOBODY BELIEVES IN
 * ══════════════════════════════════════════════════════════════════════
 * The capacity limiter shipped in Batch 31 refuses requests on numbers
 * nobody in the product had ever been shown. That produces one specific
 * support conversation, repeatedly:
 *
 *     "Our sync started failing at 11am."
 *     "You were over your request budget."
 *     "What budget? Over by how much? Since when?"
 *
 * and neither party can answer, because the counter lives in Upstash and
 * the numbers live in a TypeScript constant. This page answers all three
 * questions from the same source the middleware enforces against — there
 * is no second copy of any figure below.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ READING THIS PAGE MUST NOT MOVE THE METER
 * ══════════════════════════════════════════════════════════════════════
 * `peekEdgeLimit()` uses Upstash's `getRemaining`, which reads without
 * incrementing. Rendering with `limit()` would mean that opening the
 * page consumed the budget the page exists to report — and a support
 * engineer refreshing during an incident would push a struggling
 * workspace over its own ceiling while investigating why it was over its
 * ceiling.
 *
 * ⚠️ "NOT MEASURED" IS RENDERED DIFFERENTLY FROM "MEASURED AND FINE".
 * When there is no shared counter the remaining column says so in words
 * rather than showing a full budget. A dashboard that displays a
 * reassuring number for a control that is not running is worse than no
 * dashboard: it converts an unknown into a false certainty, and somebody
 * makes a decision on it.
 *
 * ⚠️ NOT LINKED FROM `settings-tabs.tsx` YET — that file belongs to
 * another track this run. Reachable at `/settings/limits`.
 */

import { requirePageContext } from "@/server/tenant-context";
import { requirePermission } from "@/server/audit";
import { TIER_LABELS } from "@/lib/entitlements/features";
import {
  budgetFor,
  BODY_LIMIT_RULES,
  FAIL_MODE,
  RATE_LIMIT_EXEMPT_PREFIXES,
  maxPageSizeForPlan,
} from "@/lib/edge/budgets";
import {
  peekEdgeLimit,
  isSharedCounterConfigured,
  type EdgeLimitPosition,
} from "@/lib/edge/limits";
import { ABSOLUTE_MAX_PAGE_SIZE, MAX_PAGE_OFFSET } from "@/lib/pagination";

export const dynamic = "force-dynamic";

export const metadata = { title: "Limits · Ordence" };

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export default async function LimitsSettingsPage() {
  /**
   * ⚠️ THE PAGE GUARDS ITSELF. Same reasoning as the audit trail: without
   * a check at the top, somebody without the permission gets a rendered
   * frame, a heading, and an exception in the middle — a screen that
   * confirms the feature exists and that they were nearly allowed to see
   * it.
   *
   * ⚠️ `settings:read`, AN EXISTING KEY, NOT A NEW ONE. This page shows a
   * workspace its own configuration; that is what `settings:read` already
   * means, and every role that may look at workspace settings may
   * reasonably look at its request budget. Minting `limits:read` would
   * add a key that every role template has to be taught about, for a
   * distinction nobody would ever want to draw.
   */
  /**
   * ⚠️ CONTEXT FIRST, PERMISSION SECOND, AND THE ORDER IS THE WHOLE
   * POINT. `requirePermission()` resolves the tenant through
   * `requireTenantContext()`, which THROWS for a user whose Clerk
   * organisation exists but whose `tenants` row does not. That is not an
   * error — the workspace simply is not provisioned yet — and letting it
   * throw replaces the whole `(crm)` group with an error digest. See the
   * long note on `requirePageContext` in server/tenant-context.ts: that
   * exact ordering mistake was shipped on seven pages at once.
   */
  const ctx = await requirePageContext();
  await requirePermission("settings:read");

  const tier = ctx.tenant.planTier;
  const orgId = ctx.clerkOrgId;

  const identity = { kind: "tenant", orgId } as const;

  /**
   * ⚠️ Both surfaces are read CONCURRENTLY and neither is allowed to
   * fail the page. `peekEdgeLimit` already resolves rather than throws
   * on a Redis error, so this is belt and braces — a settings page that
   * 500s because a cache is unreachable is a worse outcome than a
   * settings page that says the cache is unreachable.
   */
  const [appPosition, apiPosition] = await Promise.all([
    peekEdgeLimit("app", identity, tier),
    peekEdgeLimit("api", identity, tier),
  ]);

  const counterConfigured = isSharedCounterConfigured();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Limits</h1>
        <p className="text-sm text-muted-foreground">
          What this workspace may consume, and where it currently stands. Your
          plan is <strong>{TIER_LABELS[tier] ?? tier}</strong>.
        </p>
      </header>

      {/* ---- REQUEST RATE ------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Requests per minute</h2>
        <p className="text-sm text-muted-foreground">
          Counted per workspace, not per person, because the cost being
          protected — database compute and shared connections — is incurred per
          workspace. Browser traffic and programmatic traffic have separate
          budgets so a runaway integration cannot lock your own staff out of
          the app.
        </p>

        {!counterConfigured && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            No shared counter is configured for this deployment, so limits are
            counted per server instance only. The figures below are the
            budgets; the current position cannot be measured.
          </p>
        )}

        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Surface</th>
              <th className="py-1 font-medium">Budget</th>
              <th className="py-1 font-medium">Remaining now</th>
              <th className="py-1 font-medium">If the counter is unreachable</th>
            </tr>
          </thead>
          <tbody>
            <PositionRow
              label="App (browser)"
              position={appPosition}
              failMode={FAIL_MODE.app}
            />
            <PositionRow
              label="API (integrations)"
              position={apiPosition}
              failMode={FAIL_MODE.api}
            />
          </tbody>
        </table>

        <p className="text-xs text-muted-foreground">
          Every response carries <code>x-ratelimit-remaining</code> and{" "}
          <code>x-ordence-limit-mode</code>. The mode matters:{" "}
          <code>enforced</code> means a shared counter answered,{" "}
          <code>degraded</code> means only this server instance is counting.
        </p>

        <p className="text-xs text-muted-foreground">
          Never counted, so that a monitor or a payment provider can never be
          throttled into failure: {RATE_LIMIT_EXEMPT_PREFIXES.join(", ")}.
        </p>
      </section>

      {/* ---- BODY SIZE ---------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Request size</h2>
        <p className="text-sm text-muted-foreground">
          A request larger than its endpoint&rsquo;s ceiling is refused with a
          413 and a stated reason before the body is read.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Endpoint</th>
              <th className="py-1 font-medium">Maximum body</th>
            </tr>
          </thead>
          <tbody>
            {BODY_LIMIT_RULES.map((rule) => (
              <tr key={rule.prefix} className="border-t">
                <td className="py-1">
                  <code>{rule.prefix === "/" ? "everything else" : rule.prefix}</code>
                </td>
                <td className="py-1 tabular-nums">{formatBytes(rule.maxBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ---- PAGINATION --------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Page size</h2>
        <p className="text-sm text-muted-foreground">
          A list request may ask for at most{" "}
          <strong>{maxPageSizeForPlan(tier)}</strong> rows on your plan (never
          more than {ABSOLUTE_MAX_PAGE_SIZE} on any plan), and may skip at most{" "}
          {MAX_PAGE_OFFSET.toLocaleString("en-IN")} rows.
        </p>
        <p className="text-sm text-muted-foreground">
          A larger request is not silently truncated. The response says it was
          clamped and reports whether more rows exist, so a page that was cut
          short can never be mistaken for the end of the data.
        </p>
      </section>
    </div>
  );
}

function PositionRow({
  label,
  position,
  failMode,
}: {
  label: string;
  position: EdgeLimitPosition;
  failMode: string;
}) {
  const budget = budgetFor(position.tier, position.surface);
  return (
    <tr className="border-t">
      <td className="py-1">{label}</td>
      <td className="py-1 tabular-nums">
        {budget.limit.toLocaleString("en-IN")} / {budget.windowSeconds}s
      </td>
      <td className="py-1 tabular-nums">
        {position.remaining === null ? (
          <span className="text-muted-foreground">not measured</span>
        ) : (
          position.remaining.toLocaleString("en-IN")
        )}
      </td>
      <td className="py-1">
        {failMode === "closed" ? "requests refused" : "counted per instance"}
      </td>
    </tr>
  );
}
