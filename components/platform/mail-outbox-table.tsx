"use client";

/**
 * Ordence — ⭐⭐ THE MAIL OUTBOX, AS AN OPERATOR SEES IT
 * Version: v1.54.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS SCREEN EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Because for four batches the answer to "did that reminder go out" was
 * a row in a table nobody could see that said `queued` and always would.
 * A queue with no drain and no window is indistinguishable from a
 * deletion, and the person who finds out is the SMB owner on a
 * collections call.
 *
 * ⭐ SO EVERY STATE CARRIES A WORD, NOT A COLOUR. `dead` and `bounced`
 * are different facts — one is us giving up, one is the customer's mail
 * server refusing — and a red dot cannot tell them apart. Roughly one in
 * twelve Indian men is colour-blind; the badge says the word.
 *
 * ⚠️ `consoleHref` COMES FROM `@/lib/platform/console-paths`, NEVER FROM
 * `@/lib/platform/console-href`. The latter carries `import "server-only"`
 * because it reads `headers()`, and a `"use client"` file importing it
 * fails `check-server-boundaries` and webpack alike. `isConsoleHost`
 * arrives as a prop from the page, which is the only place that can know
 * it — a client component has no `Host` header, and reading
 * `window.location` would be right in the browser and wrong during SSR.
 */

import { DataTable, type DataTableColumn } from "@/components/platform/data-table";
import { Badge } from "@/components/ui/badge";
import { consoleHref } from "@/lib/platform/console-paths";
import { describeOutboxStatus } from "@/lib/email/outbox";
import Link from "next/link";

export type MailOutboxRowView = {
  id: string;
  tenantId: string;
  purpose: string;
  toEmail: string;
  subject: string;
  category: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  queuedAtIso: string;
  sentAtIso: string | null;
  nextAttemptAtIso: string;
};

export type MailSuppressionRowView = {
  id: string;
  tenantId: string | null;
  email: string;
  reason: string;
  detail: string | null;
  source: string;
  suppressedAtIso: string;
};

/**
 * ⚠️ THE WORD IS THE STATUS. The variant only reinforces it — a reader
 * who cannot distinguish the variants still reads "dead-lettered".
 */
function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "sent"
      ? "secondary"
      : status === "bounced" || status === "dead"
        ? "destructive"
        : "outline";

  const word =
    status === "dead" ? "dead-lettered" : status === "sending" ? "claimed" : status;

  return (
    <Badge variant={variant} title={describeOutboxStatus(status)}>
      {word}
    </Badge>
  );
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "—" : at.toISOString().slice(0, 16).replace("T", " ");
}

export function MailOutboxTable({
  rows,
  isConsoleHost,
}: {
  rows: readonly MailOutboxRowView[];
  isConsoleHost: boolean;
}) {
  const columns: readonly DataTableColumn<MailOutboxRowView>[] = [
    {
      key: "status",
      header: "State",
      accessor: (r) => r.status,
      sortable: true,
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "to",
      header: "Recipient",
      accessor: (r) => r.toEmail,
      sortable: true,
      cell: (r) => <span className="font-medium break-all">{r.toEmail}</span>,
    },
    {
      key: "subject",
      header: "Subject",
      accessor: (r) => r.subject,
      sortable: true,
    },
    {
      key: "purpose",
      header: "Kind",
      accessor: (r) => r.purpose,
      sortable: true,
      hideOnMobile: true,
    },
    {
      key: "workspace",
      header: "Workspace",
      accessor: (r) => r.tenantId,
      sortable: true,
      hideOnMobile: true,
      cell: (r) => (
        <Link
          className="underline underline-offset-4"
          href={consoleHref(`/platform/tenants/${r.tenantId}`, isConsoleHost)}
        >
          open
        </Link>
      ),
    },
    {
      key: "attempts",
      header: "Attempts",
      accessor: (r) => r.attempts,
      sortable: true,
      align: "right",
      hideOnMobile: true,
      cell: (r) => (
        <span className="tabular-nums">
          {r.attempts} of {r.maxAttempts}
        </span>
      ),
    },
    {
      key: "proof",
      header: "Provider id",
      accessor: (r) => r.providerMessageId,
      sortable: true,
      hideOnMobile: true,
      /*
       * 🔴 THE COLUMN THAT MAKES `sent` CHECKABLE. A row claiming to have
       * been sent with nothing here would be a claim with no evidence,
       * and this table is where somebody would notice.
       */
      cell: (r) =>
        r.providerMessageId ? (
          <code className="text-xs">{r.providerMessageId.slice(0, 12)}…</code>
        ) : (
          <span className="text-muted-foreground">no proof of send</span>
        ),
    },
    {
      key: "why",
      header: "Reason",
      accessor: (r) => r.lastErrorCode,
      sortable: true,
      /*
       * ⭐ THE REASON IS KEPT AND SHOWN. "Silently dropping a message is
       * worse than failing loudly" is only true if the loud failure is
       * somewhere a person looks.
       */
      cell: (r) =>
        r.lastErrorMessage ? (
          <span className="text-xs text-muted-foreground">{r.lastErrorMessage}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "queued",
      header: "Queued",
      accessor: (r) => r.queuedAtIso,
      sortable: true,
      hideOnMobile: true,
      cell: (r) => <span className="tabular-nums text-xs">{shortDate(r.queuedAtIso)}</span>,
    },
    {
      key: "next",
      header: "Next attempt",
      accessor: (r) => r.nextAttemptAtIso,
      sortable: true,
      hideOnMobile: true,
      cell: (r) =>
        r.status === "queued" ? (
          <span className="tabular-nums text-xs">{shortDate(r.nextAttemptAtIso)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <DataTable
      id="mailoutbox"
      rows={rows}
      columns={columns}
      rowId={(r) => r.id}
      caption="Messages in the outbox"
      unit="messages"
      searchable
      searchLabel="Search by recipient or subject"
      defaultSort={{ key: "queued", dir: "desc" }}
      emptyTitle="Nothing is waiting to go out."
      emptyHint="Queued mail appears here the moment something asks for it, and stays until it is sent, suppressed or dead-lettered."
      filters={[
        {
          key: "state",
          label: "State",
          options: [
            { value: "", label: "Any state" },
            { value: "queued", label: "Queued" },
            { value: "sending", label: "Claimed" },
            { value: "sent", label: "Sent" },
            { value: "bounced", label: "Bounced" },
            { value: "suppressed", label: "Suppressed" },
            { value: "dead", label: "Dead-lettered" },
          ],
          match: (row, value) => row.status === value,
          hint: "Claimed means a worker holds it right now. It may already have reached the provider, so nothing else may touch it.",
        },
      ]}
    />
  );
}

/**
 * ⭐ THE SUPPRESSION LIST, DELIBERATELY ON THE SAME SCREEN.
 *
 * 🔴 "WHY DID THIS CUSTOMER NEVER HEAR FROM US" IS ANSWERED HERE, AND
 * NOWHERE ELSE. A suppression on its own page is a suppression nobody
 * connects to the letter that did not arrive.
 */
export function MailSuppressionTable({
  rows,
}: {
  rows: readonly MailSuppressionRowView[];
}) {
  const columns: readonly DataTableColumn<MailSuppressionRowView>[] = [
    {
      key: "email",
      header: "Address",
      accessor: (r) => r.email,
      sortable: true,
      cell: (r) => <span className="font-medium break-all">{r.email}</span>,
    },
    {
      key: "reason",
      header: "Why",
      accessor: (r) => r.reason,
      sortable: true,
      cell: (r) => <Badge variant="destructive">{r.reason.replace(/_/g, " ")}</Badge>,
    },
    {
      key: "scope",
      header: "Applies to",
      accessor: (r) => (r.tenantId === null ? "every workspace" : r.tenantId),
      sortable: true,
      /*
       * ⚠️ A GLOBAL SUPPRESSION IS NOT AN OVERREACH, IT IS THE POINT.
       * Every tenant's mail leaves under one sending domain, so an
       * address that does not exist costs everyone's delivery for as
       * long as anybody keeps writing to it.
       */
      cell: (r) =>
        r.tenantId === null ? (
          <span title="Mail from every workspace leaves under one sending domain, so a dead address has to stop everywhere.">
            every workspace
          </span>
        ) : (
          <span className="text-muted-foreground">one workspace only</span>
        ),
    },
    {
      key: "detail",
      header: "What the provider said",
      accessor: (r) => r.detail,
      sortable: true,
      hideOnMobile: true,
    },
    {
      key: "source",
      header: "Recorded by",
      accessor: (r) => r.source,
      sortable: true,
      hideOnMobile: true,
    },
    {
      key: "at",
      header: "Since",
      accessor: (r) => r.suppressedAtIso,
      sortable: true,
      cell: (r) => <span className="tabular-nums text-xs">{shortDate(r.suppressedAtIso)}</span>,
    },
  ];

  return (
    <DataTable
      id="mailsuppression"
      rows={rows}
      columns={columns}
      rowId={(r) => r.id}
      caption="Suppressed addresses"
      unit="addresses"
      searchable
      searchLabel="Search by address"
      defaultSort={{ key: "at", dir: "desc" }}
      emptyTitle="No address is suppressed."
      emptyHint="A hard bounce or a spam complaint adds one automatically, and it stays until somebody lifts it with a written reason."
    />
  );
}
