/**
 * Ordence — Tenant Detail Panels
 * Version: v0.29.0-alpha (Phase 29)
 *
 * Usage over time, invoices, security events, consent history and what
 * the platform itself has done to this workspace.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THESE ARE SERVER COMPONENTS ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * None of them has state, a handler or an effect. Shipping them to the
 * browser would add kilobytes to buy nothing — and a support console that
 * only renders once the bundle has loaded is a support console that is
 * slowest during an incident.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ACCESSIBILITY RULES OBEYED HERE, BECAUSE THEY ARE EASY TO LOSE
 * ══════════════════════════════════════════════════════════════════════
 *   • NO MEANING IN COLOUR ALONE. Every severity, status and level is a
 *     WORD as well as a colour. An operator with deuteranopia reading a
 *     security panel must not have to compare two reds.
 *   • THE BARS ARE DECORATION. The number is always present as text; the
 *     bar is `aria-hidden`. A chart a screen reader cannot read is a
 *     chart that hides the data from somebody.
 *   • REAL TABLES FOR TABULAR DATA, with real headers, so "what column is
 *     this?" is answerable by a screen reader.
 */

import Link from "next/link";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/billing/money";
// ⚠️ `console-paths`, not `console-href`: the latter is `server-only`.
// These panels are server components today, but the import that survives
// somebody adding `"use client"` at the top of this file is the pure one.
import { consoleHref } from "@/lib/platform/console-paths";
import type {
  UsagePoint,
  UsageLevelRow,
  InvoiceRow,
  SecurityEventRow,
  ConsentRow,
  PlatformActivityRow,
  TenantUserRow,
} from "@/server/platform/insights";

/* ------------------------------------------------------------------ */
/* SHARED                                                              */
/* ------------------------------------------------------------------ */

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

const METRIC_LABELS: Record<string, string> = {
  storage_bytes: "Storage",
  emails_sent: "Emails sent",
  api_calls: "API calls",
  portal_links_created: "Portal links",
};

/** Bytes read as bytes, everything else as a plain count. */
function formatMetric(metric: string, raw: string): string {
  const value = Number(raw);
  if (metric === "storage_bytes") {
    if (!Number.isFinite(value)) return `${raw} bytes`;
    if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(2)} GB`;
    return `${Math.round(value / 1_048_576)} MB`;
  }
  return Number.isFinite(value) ? value.toLocaleString("en-IN") : raw;
}

/* ------------------------------------------------------------------ */
/* USAGE OVER TIME                                                     */
/* ------------------------------------------------------------------ */

/**
 * One row per billing period, per metric.
 *
 * ⚠️ THE PERIODS ARE BILLING PERIODS, NOT CALENDAR MONTHS. A subscription
 * anchored on the 9th has buckets running 9th→9th, which is why the dates
 * are printed rather than rendered as "March". A support engineer telling
 * a customer "your March usage" when the bucket is 9 Mar → 9 Apr is how a
 * billing dispute starts.
 */
export function UsagePanel({
  usage,
  levels,
}: {
  usage: UsagePoint[];
  levels: UsageLevelRow[];
}) {
  if (usage.length === 0 && levels.length === 0) {
    return <EmptyNote>No metered usage has been recorded for this workspace.</EmptyNote>;
  }

  const byMetric = new Map<string, UsagePoint[]>();
  for (const point of usage) {
    const list = byMetric.get(point.metric) ?? [];
    list.push(point);
    byMetric.set(point.metric, list);
  }

  return (
    <div className="space-y-6">
      {levels.length > 0 ? (
        <section aria-labelledby="usage-levels-heading">
          <h3 id="usage-levels-heading" className="text-sm font-medium">
            Current levels
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            A level is a reading now, not a total. &ldquo;Last verified&rdquo; is the last
            recount from source — a level that has only been adjusted by deltas can drift.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead>Now</TableHead>
                <TableHead>Peak this period</TableHead>
                <TableHead>Last event</TableHead>
                <TableHead>Last verified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {levels.map((l) => (
                <TableRow key={l.metric}>
                  <TableCell>{METRIC_LABELS[l.metric] ?? l.metric}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatMetric(l.metric, l.currentValue)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatMetric(l.metric, l.peakValue)}
                  </TableCell>
                  <TableCell className="text-xs">{shortDate(l.lastEventAt)}</TableCell>
                  <TableCell className="text-xs">
                    {l.lastReconciledAt ? (
                      shortDate(l.lastReconciledAt)
                    ) : (
                      <span className="text-muted-foreground">never recounted</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {[...byMetric.entries()].map(([metric, points]) => {
        const ordered = [...points].sort((a, b) =>
          a.periodStart.localeCompare(b.periodStart),
        );
        const peak = ordered.reduce(
          (max, p) => (Number(p.value) > max ? Number(p.value) : max),
          0,
        );

        return (
          <section key={metric} aria-labelledby={`usage-${metric}`}>
            <h3 id={`usage-${metric}`} className="text-sm font-medium">
              {METRIC_LABELS[metric] ?? metric} by billing period
            </h3>
            <ul className="mt-2 space-y-1">
              {ordered.map((p) => {
                const value = Number(p.value);
                const width = peak > 0 ? Math.max(2, Math.round((value / peak) * 100)) : 2;
                return (
                  <li
                    key={`${metric}-${p.periodStart}`}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="w-44 shrink-0 font-mono text-xs text-muted-foreground">
                      {shortDate(p.periodStart)} → {shortDate(p.periodEnd)}
                    </span>
                    {/* Decoration only — the number below is the data. */}
                    <span
                      aria-hidden
                      className="h-3 rounded-sm bg-primary/70"
                      style={{ width: `${width}%` }}
                    />
                    <span className="tabular-nums">{formatMetric(metric, p.value)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* INVOICES                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ AMOUNTS, DATES AND STATUS. NOT LINE ITEMS.
 *
 * "Why was I charged?" is answered by the total, the period and the
 * status. Line items describe what a customer bought seat-by-seat, and
 * this console has no reason to render them — the narrower panel is the
 * one that still answers the ticket.
 */
export function InvoicePanel({ invoices }: { invoices: InvoiceRow[] }) {
  if (invoices.length === 0) {
    return <EmptyNote>No invoices have been issued to this workspace.</EmptyNote>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Period</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Paid</TableHead>
          <TableHead>Due</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((inv) => {
          const unpaid =
            inv.status === "open" ||
            inv.status === "partially_paid" ||
            inv.status === "uncollectible";
          return (
            <TableRow key={inv.id} data-testid={`invoice-${inv.number}`}>
              <TableCell className="font-mono text-xs">{inv.number}</TableCell>
              <TableCell>
                {/* The word is the meaning; the variant is emphasis. */}
                <Badge variant={unpaid ? "destructive" : "secondary"}>{inv.status}</Badge>
              </TableCell>
              <TableCell className="text-xs">
                {shortDate(inv.periodStart)} → {shortDate(inv.periodEnd)}
              </TableCell>
              <TableCell className="tabular-nums">
                {formatMoney(BigInt(inv.totalMinor), inv.currency)}
              </TableCell>
              <TableCell className="tabular-nums">
                {formatMoney(BigInt(inv.amountPaidMinor), inv.currency)}
              </TableCell>
              <TableCell className="text-xs">{shortDate(inv.dueAt)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ */
/* SECURITY EVENTS                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ METADATA ONLY, AND THE IP IS A PREFIX.
 *
 * The `detail` JSONB column is deliberately not fetched or rendered — see
 * the header of `server/platform/insights.ts`. What is here answers the
 * ticket ("did somebody try to sign in as me?") without turning the
 * console into a viewer for whatever any future call site decides to log.
 */
export function SecurityPanel({ events }: { events: SecurityEventRow[] }) {
  if (events.length === 0) {
    return (
      <EmptyNote>
        No security events in the last 30 days. That is the normal state, not an error.
      </EmptyNote>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Event</TableHead>
          <TableHead>Severity</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Seen from</TableHead>
          <TableHead>Times</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="whitespace-nowrap text-xs">
              {e.occurredAt.slice(0, 16).replace("T", " ")}
            </TableCell>
            <TableCell>
              <div className="font-mono text-xs">{e.eventType}</div>
              {e.reason ? (
                <div className="text-xs text-muted-foreground">{e.reason}</div>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  e.severity === "critical"
                    ? "destructive"
                    : e.severity === "warning"
                      ? "outline"
                      : "secondary"
                }
              >
                {e.severity}
              </Badge>
            </TableCell>
            <TableCell className="text-xs">{e.source}</TableCell>
            <TableCell className="font-mono text-xs">
              {e.ipPrefix ?? <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell className="tabular-nums">{e.occurrenceCount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ */
/* THE PEOPLE IN THE WORKSPACE                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ IDENTITIES AND ROLES. NOT WHAT ANY OF THEM DID.
 *
 * "Which of our people has admin?" and "why can this person not sign in?"
 * are the two most common support questions in any B2B product, and a
 * console that cannot answer them sends the engineer to a database
 * client. Both are answered by the columns below.
 *
 * The list is READ-ONLY here, and that is enforced by the database rather
 * than by the absence of a button: `users` carries the platform clause on
 * its read policy and on neither write policy. Roles and status outlive
 * a support call, which is exactly why the impersonation deny-list
 * forbids `roles:*` and `users:update` too.
 */
export function PeoplePanel({ users }: { users: TenantUserRow[] }) {
  if (users.length === 0) {
    return <EmptyNote>This workspace has no users yet.</EmptyNote>;
  }

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Seat</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id} data-testid={`person-${u.id}`}>
              <TableCell>
                <div className="font-medium">{u.fullName ?? u.email}</div>
                <div className="text-xs text-muted-foreground">{u.email}</div>
              </TableCell>
              <TableCell className="text-sm">{u.role}</TableCell>
              <TableCell>
                <Badge variant={u.status === "active" ? "secondary" : "outline"}>
                  {u.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs">
                {u.lastSeenAt ? shortDate(u.lastSeenAt) : "never signed in"}
              </TableCell>
              <TableCell className="text-xs">
                {u.isPlatformStaff ? (
                  <span title="Our own staff — does not consume a seat the customer paid for">
                    ours, not billed
                  </span>
                ) : u.status === "active" ? (
                  "billed"
                ) : (
                  "not billed"
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Read-only. The console cannot change a role or a status — those outlive a support
        call, so the database does not grant the platform connection a write on this table
        at all.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CONSENT HISTORY                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE PANEL THAT MAKES CONSENT REAL RATHER THAN CLAIMED.
 *
 * A boolean would answer "may we?" and nothing else. When a customer asks
 * during a security review — and they do — the questions are who agreed,
 * when, to what, and until when. This panel is those four answers, read
 * from rows the platform can READ and physically cannot WRITE.
 */
export function ConsentPanel({ consents }: { consents: ConsentRow[] }) {
  if (consents.length === 0) {
    return (
      <EmptyNote>
        This workspace has never granted support access. Consented impersonation is
        unavailable; break-glass is read-only and emails the owners.
      </EmptyNote>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>State</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Allows</TableHead>
          <TableHead>Granted by</TableHead>
          <TableHead>Granted</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Reference</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {consents.map((c) => (
          <TableRow key={c.id} data-testid={`consent-${c.id}`}>
            <TableCell>
              {c.live ? (
                <Badge>live</Badge>
              ) : c.revokedAt ? (
                <Badge variant="destructive">revoked</Badge>
              ) : (
                <Badge variant="outline">expired</Badge>
              )}
            </TableCell>
            <TableCell>{c.mode}</TableCell>
            <TableCell>
              {c.scope === "read_only" ? "Look only" : "Look and change"}
            </TableCell>
            <TableCell className="text-xs">
              {c.grantedByEmail ?? "—"}
              {c.grantedByRole ? (
                <span className="text-muted-foreground"> ({c.grantedByRole})</span>
              ) : null}
            </TableCell>
            <TableCell className="text-xs">{shortDate(c.grantedAt)}</TableCell>
            <TableCell className="text-xs">{shortDate(c.expiresAt)}</TableCell>
            <TableCell className="text-xs">{c.reference ?? "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ */
/* WHAT THE PLATFORM DID TO THIS WORKSPACE                             */
/* ------------------------------------------------------------------ */

/**
 * Read back from the CUSTOMER'S OWN audit log, not from a private copy.
 *
 * There is only one record, and the customer can see it too. A console
 * with its own version of events is a console whose account of a Tuesday
 * can differ from the customer's, and the difference is discovered during
 * the argument.
 */
export function ActivityPanel({ rows }: { rows: PlatformActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyNote>
        Nobody from the platform has touched this workspace through the console.
      </EmptyNote>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{r.actorEmail ?? "unknown operator"}</span>
            <Badge variant="outline">{r.action}</Badge>
            <span className="font-mono text-xs">{r.resourceType}</span>
            {r.impersonationId ? (
              <Badge variant="destructive">taken while impersonating</Badge>
            ) : null}
            {r.severity === "critical" ? <Badge variant="destructive">critical</Badge> : null}
            <span className="ml-auto text-xs text-muted-foreground">
              {r.createdAt.slice(0, 16).replace("T", " ")}
            </span>
          </div>
          {r.reason ? <p className="mt-1 text-xs text-muted-foreground">{r.reason}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* IMPERSONATION HISTORY (per tenant)                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `isConsoleHost` IS A PROP, NOT SOMETHING THIS COMPONENT WORKS OUT.
 * `onConsoleHost()` reads request headers and is `server-only`; a link
 * built from `window.location` would be right in the browser and wrong
 * during SSR, which is the hydration mismatch that makes a link change
 * under the cursor. The page calls `onConsoleHost()` once and passes the
 * boolean down.
 *
 * It defaults to `false` so an older call site keeps producing the
 * canonical `/platform/...` path, which is correct on app.ordence.com.
 */
export function SessionHistoryLink({
  tenantId,
  isConsoleHost = false,
}: {
  tenantId: string;
  isConsoleHost?: boolean;
}) {
  return (
    <Link
      href={consoleHref(`/platform/sessions?tenant=${tenantId}`, isConsoleHost)}
      className="text-sm underline underline-offset-2"
    >
      Open the full session register for this workspace
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* INCIDENTS — THE TAB WITH NOTHING BEHIND IT YET                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ AN HONEST EMPTY TAB, NOT AN INVENTED ONE.
 *
 * "Which incidents hit THIS customer?" is a real question and the answer
 * is not in the database. `platform_incidents` records a `reference`, a
 * `severity`, who declared it and an `affected_filter` JSONB blob — and
 * that blob is a FILTER, not a membership list: nothing resolves it to a
 * set of workspace ids, and `getIncidents()` in
 * `server/platform/control-actions.ts` takes no tenant argument at all.
 *
 * 🔴 SO THIS PANEL SHOWS NOTHING RATHER THAN SOMETHING PLAUSIBLE. The
 * tempting move is to list every open incident here and let the operator
 * judge. That is worse than blank: an operator on a call would read out
 * "you were affected by INC-14" from a screen that never checked, and
 * the customer would believe them. A tab that says "we cannot answer
 * this" is a tab nobody misquotes.
 *
 * What is missing, precisely, so the next person can close it:
 *   • a resolver that turns `platform_incidents.affected_filter` into
 *     tenant ids (or a join table, if filters turn out to be the wrong
 *     shape), and
 *   • a tenant-scoped read beside `getIncidents()`.
 *
 * The link is a link to the global board, labelled as global.
 */
export function IncidentsNotWiredPanel({
  tenantName,
  incidentsHref,
}: {
  tenantName: string;
  incidentsHref: string;
}) {
  return (
    <div
      data-testid="incidents-not-wired"
      className="space-y-3 rounded-md border border-dashed border-border p-6 text-sm"
    >
      <p className="font-medium">Not wired yet — this tab cannot answer for {tenantName}.</p>
      <p className="text-muted-foreground">
        Incidents are recorded platform-wide. An incident row carries an{" "}
        <code className="font-mono">affected_filter</code> describing who was hit, and
        nothing in the codebase resolves that filter to workspace ids — so there is no
        honest way to say whether this workspace was one of them.
      </p>
      <p className="text-muted-foreground">
        Two things would close this: a resolver from{" "}
        <code className="font-mono">platform_incidents.affected_filter</code> to tenant
        ids, and a tenant-scoped read beside{" "}
        <code className="font-mono">getIncidents()</code> in{" "}
        <code className="font-mono">server/platform/control-actions.ts</code>, which today
        takes no tenant argument.
      </p>
      <p className="text-muted-foreground">
        Until then: blank is the truthful answer. An operator must not read a guess out to
        a customer as if the system had checked.
      </p>
      <Link href={incidentsHref} className="inline-block underline underline-offset-2">
        Open the platform-wide incident board (all workspaces, not this one)
      </Link>
    </div>
  );
}
