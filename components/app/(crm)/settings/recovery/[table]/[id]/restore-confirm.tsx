"use client";

/**
 * Ordence — ⭐ THE RESTORE BUTTON
 * Version: v1.78.0-alpha · Wave 10
 *
 * ⚠️ THE VERDICT IS SHOWN WHETHER IT ALLOWS OR REFUSES. A restore that
 * cannot happen has a reason , the parent is itself deleted, a code has
 * been taken by something created since , and that reason is what the
 * person needs in order to do something about it. Hiding it and greying
 * out the button leaves them with a dead screen and no next step.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function RestoreConfirm(props: {
  table: string;
  id: string;
  allowed: boolean;
  message: string;
  restore: (input: { table: string; id: string }) => Promise<Result<{ label: string }>>;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await props.restore({ table: props.table, id: props.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(result.data.label);
      /**
       * ⚠️ REFRESHED RATHER THAN REDIRECTED IMMEDIATELY. The person
       * should see which record came back before the screen changes
       * under them; the bin is one click away and now one row shorter.
       */
      router.refresh();
    });
  }

  if (done) {
    return (
      <div className="space-y-3 rounded-md border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
        <p className="text-sm font-medium">&ldquo;{done}&rdquo; is back.</p>
        <button
          type="button"
          onClick={() => router.push("/settings/recovery")}
          className="text-sm underline underline-offset-2"
        >
          Back to the recycle bin
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      <p className="text-sm">{props.message}</p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {props.allowed ? (
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          {pending ? "Restoring…" : "Restore it"}
        </button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing can be restored from here until that is resolved.
        </p>
      )}
    </div>
  );
}
