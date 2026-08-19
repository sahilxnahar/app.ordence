/**
 * Ordence — ⭐⭐ CONFIRMING A RESTORE
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RECYCLE BIN'S OWN NOTE SAID IT: "Soft delete works; undelete
 *    does not."
 * ══════════════════════════════════════════════════════════════════════
 * `check:links` carried `/settings/recovery/:id/:id` in its dead-link
 * budget with that sentence attached. Every Restore link on the recycle
 * bin gave a 404, and `canRestore` and `restoreFromRecycleBin` , both
 * written, both guarded , had no caller.
 *
 * A recycle bin whose Restore button 404s is worse than no recycle bin:
 * it tells a customer their data is recoverable, and it is not
 * recoverable by them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS A PAGE AND NOT A BUTTON ON THE LIST
 * ══════════════════════════════════════════════════════════════════════
 * `canRestore` exists because a restore is not always possible , the
 * parent may itself be deleted, a unique key may have been taken by
 * something created since, the record may reference a row that is gone.
 * That answer is a SENTENCE, not a boolean, and it has to be read before
 * the button is pressed rather than after.
 *
 * A one-click Restore on the list would either hide that sentence or
 * show it in a toast after the failure. Asking first, on its own screen,
 * is what makes the refusal useful.
 *
 * ⚠️ THE TABLE NAME COMES FROM THE URL AND IS UNTRUSTED. It is passed
 * through to `canRestore`, which validates it against the recoverable
 * registry , this page does not decide what is restorable, and must not,
 * because a second list of table names is a second thing to keep in step.
 */

import Link from "next/link";
import { ArrowLeft, RotateCcw } from "lucide-react";

import { canRestore } from "@/server/actions/recovery";
import { restoreFromRecycleBin } from "@/server/actions/recovery";
import { RestoreConfirm } from "./restore-confirm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Restore · Ordence" };

export default async function RestorePage({
  params,
}: {
  params: Promise<{ table: string; id: string }>;
}) {
  const { table, id } = await params;

  const verdict = await canRestore({ table, id });

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-3">
        <Link
          href="/settings/recovery"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to the recycle bin
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <RotateCcw className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          Restore this record
        </h1>
      </div>

      {!verdict.ok ? (
        /*
          ⚠️ THE ACTION'S OWN SENTENCE, VERBATIM. It distinguishes "no
          such record", "outside the recovery window" and "you do not
          have permission", and each of those has a different remedy.
        */
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          {verdict.error}
        </p>
      ) : (
        <RestoreConfirm
          table={table}
          id={id}
          allowed={verdict.data.allowed}
          message={verdict.data.message}
          restore={restoreFromRecycleBin}
        />
      )}
    </main>
  );
}
