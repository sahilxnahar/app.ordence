/**
 * Ordence — Platform Console · ⭐⭐ MAIL
 * Version: v1.54.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCREEN THAT SHOULD HAVE EXISTED FOUR BATCHES AGO
 * ══════════════════════════════════════════════════════════════════════
 * `credit_dunning_log` recorded reminders as `queued`. Nothing sent
 * them. Nothing showed them. The only person who found out was an SMB
 * owner on a collections call, being told by a customer that they had
 * never received anything.
 *
 * ⚠️ IT IS CROSS-TENANT AND THAT IS NOT A CONVENIENCE. Mail from every
 * workspace leaves under one sending domain, so one workspace mailing
 * dead addresses degrades delivery for every other customer — and nobody
 * inside that workspace can see it happening. Deliverability is the one
 * operational problem that genuinely is not a tenant's own.
 *
 * ⚠️ THE CAPABILITY IS CHECKED IN `readOutboxForConsole()`, NOT HERE. A
 * page-level guard protects the page and nothing else; the function is
 * what is reachable from the rest of the server tree.
 */

import Link from "next/link";
import { readOutboxForConsole } from "@/server/email/outbox";
import {
  MailOutboxTable,
  MailSuppressionTable,
} from "@/components/platform/mail-outbox-table";
import { consoleHref, onConsoleHost } from "@/lib/platform/console-href";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Mail · Ordence Platform",
  robots: { index: false, follow: false },
};

export default async function PlatformMailPage() {
  const [data, isConsole] = await Promise.all([
    readOutboxForConsole({ limit: 200 }).catch((err: unknown) => {
      console.error("[platform/mail] could not read the outbox", err);
      return null;
    }),
    onConsoleHost(),
  ]);

  if (!data) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">
          The outbox could not be read. Nothing has been changed — this screen only
          reports.
        </CardContent>
      </Card>
    );
  }

  /*
   * ⚠️ COUNTED HERE, NOT IN SQL, BECAUSE THE READ IS ALREADY CAPPED. A
   * COUNT(*) over the whole table beside a capped list would print a
   * headline number the table below cannot account for, and somebody
   * would spend an afternoon looking for the missing rows.
   */
  const counts = data.outbox.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  const stuck = data.outbox.filter(
    (r) => r.status === "dead" || r.status === "bounced",
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Mail</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything this product has been asked to send, and how far each message
          got. A message is only marked <strong>sent</strong> when the provider
          returned a message id — a row with no provider id is not proof of
          delivery and is never counted as one.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {data.outbox.length} message{data.outbox.length === 1 ? "" : "s"} shown ·{" "}
          {counts["queued"] ?? 0} queued · {counts["sent"] ?? 0} sent ·{" "}
          {counts["bounced"] ?? 0} bounced · {counts["suppressed"] ?? 0} suppressed ·{" "}
          {counts["dead"] ?? 0} dead-lettered.
        </p>
        {stuck > 0 ? (
          <p className="mt-2 text-sm">
            {stuck} message{stuck === 1 ? " has" : "s have"} not reached anybody. The
            reason is on each row — a permanent rejection is dead-lettered with the
            reason kept rather than retried, because a loop against a permanent
            refusal is what costs a sending domain its reputation.
          </p>
        ) : null}
      </div>

      <MailOutboxTable
        rows={data.outbox.map((r) => ({
          id: r.id,
          tenantId: r.tenantId,
          purpose: r.purpose,
          toEmail: r.toEmail,
          subject: r.subject,
          category: r.category,
          status: r.status,
          attempts: r.attempts,
          maxAttempts: r.maxAttempts,
          providerMessageId: r.providerMessageId,
          lastErrorCode: r.lastErrorCode,
          lastErrorMessage: r.lastErrorMessage,
          /*
           * ⚠️ SERIALISED TO ISO AT THE BOUNDARY. A `Date` crossing into
           * a client component is re-hydrated as a string anyway, and a
           * component typed as if it were still a Date is a `.getTime()`
           * that throws in the browser and not in the test.
           */
          queuedAtIso: r.queuedAt.toISOString(),
          sentAtIso: r.sentAt ? r.sentAt.toISOString() : null,
          nextAttemptAtIso: r.nextAttemptAt.toISOString(),
        }))}
        isConsoleHost={isConsole}
      />

      <div>
        <h2 className="text-base font-semibold">Suppressed addresses</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A hard bounce or a spam complaint stops future sends to an address without
          anybody having to remember. It applies to every workspace, because the
          sending reputation it protects belongs to all of them —{" "}
          <Link
            className="underline underline-offset-4"
            href={consoleHref("/platform/health", isConsole)}
          >
            delivery health
          </Link>
          .
        </p>
        <div className="mt-4">
          <MailSuppressionTable
            rows={data.suppressions.map((r) => ({
              id: r.id,
              tenantId: r.tenantId,
              email: r.email,
              reason: r.reason,
              detail: r.detail,
              source: r.source,
              suppressedAtIso: r.suppressedAt.toISOString(),
            }))}
          />
        </div>
      </div>
    </div>
  );
}
