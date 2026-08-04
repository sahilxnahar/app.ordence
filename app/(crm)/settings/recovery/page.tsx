/**
 * Ordence — Recycle Bin & Export
 * Version: v0.21.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONLY JOB OF THIS PAGE IS TO REDUCE PANIC
 * ══════════════════════════════════════════════════════════════════════
 * Everyone who opens it has just realised they deleted something. The
 * page has about two seconds to answer one question — "is it gone?" —
 * before the reader starts composing a support email.
 *
 * So the reassurance is the FIRST thing, above the list, stated plainly
 * and without conditions. The list is second. The export is last,
 * because the person who needs it is calmer.
 */

import { Suspense } from "react";
import { Trash2, Download, RotateCcw } from "lucide-react";
import { getRecycleBin } from "@/server/actions/recovery";
import { RECOVERY_WINDOW_DAYS } from "@/lib/backup/recoverable";
import { ExportButton } from "./export-button";

export const dynamic = "force-dynamic";

export default function RecoveryPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Recycle bin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Anything deleted in the last {RECOVERY_WINDOW_DAYS} days, and a
          complete copy of your data.
        </p>
      </header>

      {/*
        Above the list, deliberately. Someone who has just deleted a
        client record does not read past the first sentence until they
        know the answer.
      */}
      <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
        <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">
          Deleting never destroys anything here.
        </p>
        <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-200">
          Records are hidden, not erased. Anything from the last{" "}
          {RECOVERY_WINDOW_DAYS} days is below and can be put back in one click.
          Older than that, it is still safe — ask us and we will recover it.
        </p>
      </section>

      <Suspense fallback={<BinSkeleton />}>
        <BinList />
      </Suspense>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Download className="h-4 w-4" aria-hidden="true" />
          Download a copy of everything
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          One file containing your contacts, companies, deals, assets,
          contracts, documents, ledger, invoices and activity history. Keep it
          somewhere safe — a copy in your hands is the backup that survives
          anything happening to us.
        </p>
        <ExportButton />
      </section>
    </div>
  );
}

async function BinList() {
  const result = await getRecycleBin();

  if (!result.ok) {
    return (
      <section className="rounded-lg border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground">{result.error}</p>
      </section>
    );
  }

  const { records, partial } = result.data;

  if (records.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-8 text-center">
        <Trash2
          className="mx-auto mb-2 h-6 w-6 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">
          Nothing deleted in the last {RECOVERY_WINDOW_DAYS} days.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      {/*
        Stated rather than hidden. A bin that silently omits a category
        tells the customer their record is gone forever.
      */}
      {partial ? (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
          Some record types could not be listed. Nothing has been lost — please
          contact us so we can look.
        </p>
      ) : null}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Deleted</th>
            <th className="py-2 pr-4 font-medium">Available for</th>
            <th className="py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={`${record.table}:${record.id}`} className="border-b last:border-0">
              <td className="py-2 pr-4 text-muted-foreground">
                {record.entityLabel}
              </td>
              <td className="py-2 pr-4 font-medium">{record.displayName}</td>
              <td className="py-2 pr-4 text-muted-foreground">
                {new Date(record.deletedAt).toLocaleDateString("en-IN", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                  timeZone: "Asia/Kolkata",
                })}
              </td>
              <td className="py-2 pr-4 tabular-nums">
                {/* Amber near the end, so the urgency is visible without
                    reading the number. */}
                <span
                  className={
                    record.daysLeft <= 3
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground"
                  }
                >
                  {record.daysLeft} more day{record.daysLeft === 1 ? "" : "s"}
                </span>
              </td>
              <td className="py-2">
                <a
                  href={`/settings/recovery/${record.table}/${record.id}`}
                  className="inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-2"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Restore
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BinSkeleton() {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="space-y-2" aria-hidden="true">
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
      <span className="sr-only">Loading deleted records…</span>
    </section>
  );
}
