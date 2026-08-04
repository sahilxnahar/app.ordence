"use client";

/**
 * Ordence — Tenant Directory Table
 * Version: v0.14.0-alpha
 *
 * Pure presentation over data the server already decided to show. It
 * takes no tenant ids it was not given, performs no fetching, and holds
 * no privilege of its own.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONE COLUMN THAT IS NOT DECORATION
 * ══════════════════════════════════════════════════════════════════════
 * `impersonationLive` renders a loud marker. It answers "is one of us
 * inside a customer's workspace right now?", which is the question a
 * platform operator should be able to answer at a glance and which — in
 * most support consoles — cannot be answered at all without a database
 * query. Putting it in the directory, next to the customer's name, is
 * what makes it a normal thing to notice rather than an investigation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SORTING IS LINKS, NOT STATE (Phase 29)
 * ══════════════════════════════════════════════════════════════════════
 * Each sortable heading is an ordinary `<Link>` carrying the whole query
 * string. Three consequences, all of them wanted:
 *
 *   • The SERVER sorts, over the whole result set, so page 2 of a
 *     sort-by-MRR is the real page 2. Sorting the fifty rows that
 *     happen to be loaded produces a list that looks ordered and is not.
 *   • The current view is a URL. An operator can paste "the customers
 *     closest to their seat limit" into a ticket.
 *   • It works with JavaScript off, which is the state the console is in
 *     on the day something else in the bundle is broken.
 *
 * Accessibility: the active column carries `aria-sort`, and the direction
 * is ALSO stated in the link's accessible name — an arrow glyph alone is
 * meaning carried by a shape, which a screen reader does not announce and
 * a colour-blind operator cannot compare.
 */

import Link from "next/link";
import { Radio } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  HEALTH_LABELS,
  healthBadgeVariant,
  relativeTime,
  formatStorage,
  type HealthLevel,
} from "@/lib/platform/health";
import { formatMoney } from "@/lib/billing/money";

export type TenantRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
  planTier: string;
  subscriptionStatus: string | null;
  seatsInUse: number;
  seatLimit: number;
  storageUsedMb: number;
  storageLimitMb: number;
  lastActivityAt: string | null;
  health: { level: HealthLevel; score: number; headline: string };
  impersonationLive: boolean;
  /**
   * Committed MRR in minor units, as a string.
   *
   * Optional because this component is also rendered by tests and by
   * callers that predate Phase 29; an absent value renders as "—" rather
   * than as zero. A missing number and a zero are different facts and
   * showing them the same way is how "this customer pays us nothing"
   * gets said out loud about a customer who pays us plenty.
   */
  mrrMinor?: string;
  currency?: string;
};

/**
 * A column the operator can sort by, with the href that would do it.
 * Built on the server, where the current query string is known.
 */
export type SortLink = {
  href: string;
  /** "ascending" | "descending" | "none" — passed straight to `aria-sort`. */
  active: "ascending" | "descending" | "none";
};

export type TenantSortLinks = Partial<Record<
  "name" | "plan" | "seats" | "storage" | "activity" | "mrr" | "created" | "status",
  SortLink
>>;

export function TenantTable({
  rows,
  now = new Date(),
  sortLinks,
}: {
  rows: TenantRow[];
  /** Injected so the rendered output is deterministic in tests. */
  now?: Date;
  /** Omitted → plain headings, no sorting. */
  sortLinks?: TenantSortLinks;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No workspaces match these filters.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead label="Workspace" link={sortLinks?.name} />
          <SortableHead label="Plan" link={sortLinks?.plan} />
          <TableHead>Health</TableHead>
          <SortableHead label="Seats" link={sortLinks?.seats} />
          <SortableHead label="Storage" link={sortLinks?.storage} />
          <SortableHead label="MRR" link={sortLinks?.mrr} />
          <SortableHead label="Last activity" link={sortLinks?.activity} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} data-testid={`tenant-row-${row.slug}`}>
            <TableCell>
              <div className="flex items-center gap-2">
                <Link
                  href={`/platform/tenants/${row.id}`}
                  className="font-medium hover:underline"
                >
                  {row.name}
                </Link>
                {row.impersonationLive ? (
                  <span
                    data-testid="live-impersonation-marker"
                    title="Platform staff are inside this workspace right now"
                    className="inline-flex items-center gap-1 rounded-sm bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white"
                  >
                    <Radio className="h-3 w-3" aria-hidden />
                    In session
                  </span>
                ) : null}
              </div>
              <div className="font-mono text-xs text-muted-foreground">{row.slug}</div>
            </TableCell>

            <TableCell>
              <div>{row.planTier}</div>
              <div className="text-xs text-muted-foreground">
                {row.subscriptionStatus ?? "no subscription"}
              </div>
            </TableCell>

            <TableCell>
              <Badge variant={healthBadgeVariant(row.health.level)}>
                {HEALTH_LABELS[row.health.level]}
              </Badge>
              <div className="mt-1 text-xs text-muted-foreground">
                {row.health.headline}
              </div>
            </TableCell>

            <TableCell className="tabular-nums">
              {row.seatsInUse}/{row.seatLimit}
            </TableCell>

            <TableCell className="tabular-nums">
              {formatStorage(row.storageUsedMb)}
              <span className="text-xs text-muted-foreground">
                {" "}
                / {formatStorage(row.storageLimitMb)}
              </span>
            </TableCell>

            <TableCell className="tabular-nums">
              {row.mrrMinor === undefined ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span title="Committed monthly recurring revenue">
                  {formatMoney(BigInt(row.mrrMinor), row.currency ?? "INR")}
                </span>
              )}
            </TableCell>

            <TableCell className="text-xs text-muted-foreground">
              {relativeTime(row.lastActivityAt ? new Date(row.lastActivityAt) : null, now)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A heading that is a sort control when it can be, and a plain heading
 * when it cannot.
 *
 * ⚠️ The direction is in the TEXT of the link, not only in an icon.
 * "Seats, sorted ascending — click to reverse" is announced by a screen
 * reader; a chevron is not, and a colour change is meaning carried by
 * colour alone.
 */
function SortableHead({ label, link }: { label: string; link?: SortLink }) {
  if (!link) return <TableHead>{label}</TableHead>;

  const suffix =
    link.active === "ascending"
      ? " — sorted lowest first, activate to reverse"
      : link.active === "descending"
        ? " — sorted highest first, activate to reverse"
        : " — activate to sort by this column";

  return (
    <TableHead aria-sort={link.active}>
      <Link
        href={link.href}
        className="inline-flex items-center gap-1 rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{label}</span>
        <span aria-hidden className="text-xs">
          {link.active === "ascending" ? "▲" : link.active === "descending" ? "▼" : "↕"}
        </span>
        <span className="sr-only">{suffix}</span>
      </Link>
    </TableHead>
  );
}
