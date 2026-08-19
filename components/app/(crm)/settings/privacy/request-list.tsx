"use client";

/**
 * The register, and the two buttons that act on it.
 *
 * ⚠️ A CLIENT COMPONENT BECAUSE THE EXPORT IS ASSEMBLED IN MEMORY AND
 * SAVED WITH AN OBJECT URL. There is deliberately no route to link to:
 * a GET endpoint returning one named person's complete record is exactly
 * the URL you do not want in a browser history, a proxy log or a shared
 * screenshot. `settings/recovery/export-button.tsx` makes the same
 * choice for the same reason.
 */

import { useState } from "react";
import { Download, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { runDataPrincipalErasure, runDataPrincipalExport } from "@/server/actions/dpdp";
import { cn } from "@/lib/utils";

type Row = {
  id: string;
  reference: string;
  kind: string;
  principalLabel: string;
  status: string;
  needsHumanDecision: boolean;
  receivedAt: Date | string;
  /**
   * 🔴 SHOWN, NOT MERELY STORED. This is the sentence that says how the
   * requester was established to be the Data Principal, and it is the
   * only defence against the failure that matters here — answering an
   * access request for the wrong person, which is itself a personal data
   * breach and which arrives disguised as good service.
   *
   * ⚠️ A column written and never displayed is a column nobody reviews.
   */
  verifiedHow: string;
  verifiedAt: Date | string | null;
  answeredAt: Date | string | null;
};

const when = (v: Date | string | null) =>
  v ? new Date(v).toISOString().slice(0, 10) : null;

export function RequestList({ initial }: { initial: Row[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRef, setConfirmRef] = useState("");

  if (initial.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        No requests recorded. When somebody asks what you hold about them, record
        it here first — including how you established they are who they say they
        are. Answering an access request for the wrong person is itself a
        personal data breach, and it arrives looking like good service.
      </p>
    );
  }

  async function doExport(id: string) {
    setBusy(id);
    try {
      const result = await runDataPrincipalExport(id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const blob = new Blob([result.data.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      /** Released immediately: one leaked object URL per click eventually takes the tab down. */
      URL.revokeObjectURL(url);

      toast.success(
        result.data.notSearched > 0
          ? `${result.data.rows.toLocaleString("en-IN")} records. ${result.data.notSearched} table(s) could not be searched and are named in the file.`
          : `${result.data.rows.toLocaleString("en-IN")} records exported.`,
      );
    } catch {
      toast.error("The export could not be prepared. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  async function doErase(id: string, reference: string) {
    setBusy(id);
    try {
      const result = await runDataPrincipalErasure({
        requestId: id,
        decisions: [],
        confirmReference: confirmRef,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data.refusedToRun) {
        /**
         * 🔴 NOT AN ERROR TOAST. Nothing was deleted and that is the
         * engine working: a table needed a person's decision. Styling it
         * as a failure teaches people to retry until it stops appearing.
         */
        toast.warning(
          `Nothing was erased for ${reference}. ${result.data.blockedOn.length} record set(s) need a decision from you.`,
        );
        return;
      }
      const total = Object.values(result.data.deleted).reduce((a, b) => a + b, 0);
      toast.success(
        `${total.toLocaleString("en-IN")} record(s) erased. The refusal notice is on the request.`,
      );
    } catch {
      toast.error("The erasure could not be run. Nothing was changed.");
    } finally {
      setBusy(null);
      setConfirmRef("");
    }
  }

  return (
    <ul className="mt-3 divide-y divide-border">
      {initial.map((r) => (
        <li key={r.id} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {r.reference} · {r.principalLabel}
              </p>
              <p className="text-xs text-muted-foreground">
                {r.kind} · {r.status}
                {r.needsHumanDecision ? " · waiting on a decision from you" : ""}
                {when(r.verifiedAt) ? ` · verified ${when(r.verifiedAt)}` : ""}
                {when(r.answeredAt) ? ` · answered ${when(r.answeredAt)}` : ""}
              </p>
              <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                Verified: {r.verifiedHow}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => doExport(r.id)}
                disabled={busy !== null}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium",
                  "bg-primary text-primary-foreground hover:bg-primary/90",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                )}
              >
                {busy === r.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="h-4 w-4" aria-hidden="true" />
                )}
                Export
              </button>

              {r.kind === "erasure" ? (
                <>
                  {/*
                    ⚠️ TYPING THE REFERENCE IS FRICTION, NOT SECURITY. The
                    permission check is the control. This is here because
                    the operation has no recycle bin behind it.
                  */}
                  <label className="sr-only" htmlFor={`confirm-${r.id}`}>
                    Type {r.reference} to confirm erasure
                  </label>
                  <input
                    id={`confirm-${r.id}`}
                    value={confirmRef}
                    onChange={(e) => setConfirmRef(e.target.value)}
                    placeholder={r.reference}
                    className="w-32 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => doErase(r.id, r.reference)}
                    disabled={busy !== null || confirmRef.trim() !== r.reference}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium",
                      "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                    )}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Erase
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
