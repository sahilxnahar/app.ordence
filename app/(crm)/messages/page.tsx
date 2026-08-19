/**
 * Ordence — ⭐⭐ MESSAGES
 * Version: v1.10.0-alpha
 *
 * ⭐ Ledgers do not create habit. Conversations do.
 *
 * 🔴 AND THE CONVERSATION BELONGS ON THE RECORD IT IS ABOUT. A
 * discussion about an invoice that lives in somebody's email is a
 * discussion the next person to pick up the file cannot find, which is
 * how the same question gets asked three times and answered differently
 * twice.
 */

import Link from "next/link";
import { getInbox } from "@/server/actions/messages";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Messages · Ordence" };

export default async function MessagesPage() {
  const result = await getInbox();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Messages</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { rows, summary } = result.data;

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Messages</h1>
        <p className="text-sm text-muted-foreground">
          Conversations live on the record they are about, so the next person to
          open the file finds them. Nothing here can be deleted, and an edited
          message says it was edited.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card className={summary.needsAttention > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              You were named
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary.needsAttention}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⭐ Muting is "stop shouting about this", not "hide it
               * from me even when it is addressed to me".
               */}
              These show even in a muted conversation. Muting stops the noise,
              not the message addressed to you.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Unread
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{summary.unread}</p>
            <p className="text-xs text-muted-foreground">
              Worked out from two timestamps, never stored as a count.
            </p>
          </CardContent>
        </Card>

        <Card className={summary.stale > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Gone quiet
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{summary.stale}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⚠️ The counter nobody builds. An unanswered question
               * looks exactly like a finished conversation.
               */}
              Open for more than a fortnight with nothing said. An unanswered
              question looks exactly like a finished one.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              In total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{summary.total}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Your conversations</CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 Not by recency alone.
             */}
            Anything you were named in first, then unread, then by recency. The
            message that named you three days ago matters more than one nobody
            needs you for that arrived at lunchtime.
          </p>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. A conversation started on an invoice, a matter or a
              customer will appear here and stay attached to that record.
            </p>
          ) : (
            <div className="space-y-2">
              {rows.map((t) => (
                <div
                  key={t.id}
                  className={`flex flex-wrap items-start gap-2 border-b pb-2 text-sm last:border-0 ${
                    t.needsAttention ? "font-medium" : ""
                  }`}
                >
                  {t.needsAttention ? (
                    <Badge variant="destructive">named you</Badge>
                  ) : t.unread ? (
                    <Badge variant="secondary">unread</Badge>
                  ) : (
                    <Badge variant="outline">read</Badge>
                  )}
                  <span className="flex-1">
                    {t.title ?? t.subjectLabel ?? "Untitled"}
                    {t.subjectLabel && t.title && (
                      <p className="text-xs font-normal text-muted-foreground">
                        {t.subjectLabel}
                      </p>
                    )}
                  </span>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {t.messageCount} message{t.messageCount === 1 ? "" : "s"}
                  </span>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {t.lastMessageAt ? t.lastMessageAt.slice(0, 10) : "—"}
                  </span>
                  {t.isClosed && <Badge variant="outline">closed</Badge>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/tasks" className="underline">
          Tasks
        </Link>{" "}
        ·{" "}
        <Link href="/crm/consent" className="underline">
          Consent
        </Link>
      </p>
    </main>
  );
}
