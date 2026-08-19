"use client";

/**
 * Ordence — ⭐⭐ STEP TWO: PUT THE RESTATEMENT IN THE LEDGER
 * Batch 0101 · the multi-currency console
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS A SEPARATE FILE BECAUSE IT IS A SEPARATE DECISION
 * ══════════════════════════════════════════════════════════════════════
 * Running a revaluation computes a number and writes down the working.
 * Posting it moves the reported profit. They are two acts, they are
 * reviewed by different people, and a single button that did both would
 * mean the review happened after the journal rather than before it.
 *
 * ⚠️ SO THE BUTTON ARMS BEFORE IT FIRES. One click says what is about to
 * happen; the second one does it. That is the same friction the period
 * close dialog uses, and for the same reason: this is the moment a
 * working paper becomes a reported figure.
 *
 * ⚠️ THE GUARD IS `fx:revalue`, ON THE SERVER, ON EVERY CALL. Rendering
 * or not rendering this button decides nothing — a server action is a
 * POST to whatever URL the browser is on.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { postFxRevaluationRun } from "@/server/actions/fx";

export function PostRevaluation({
  revaluationId,
  posted,
  unpostedReason,
  canRevalue,
}: {
  revaluationId: string;
  posted: boolean;
  unpostedReason: string | null;
  canRevalue: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [armed, setArmed] = React.useState(false);

  if (posted) {
    return (
      <div className="rounded border p-3 text-sm" data-testid="fx-post-state">
        <Badge variant="secondary" className="text-[10px]">
          posted
        </Badge>{" "}
        The exchange difference is in the ledger. Posting it again would double-count it, so
        this run cannot be posted twice.
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded border p-3" data-testid="fx-post-state">
      <p className="text-sm font-medium">Step 2 — post it to the ledger</p>
      {unpostedReason && (
        <p className="text-xs text-muted-foreground" data-testid="fx-unposted-reason">
          {unpostedReason}
        </p>
      )}
      {!canRevalue ? (
        <p className="text-xs text-muted-foreground">
          You do not have <span className="font-mono">fx:revalue</span>, so you can read this
          working paper but not book it.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {armed ? (
            <>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await postFxRevaluationRun(revaluationId);
                    if (!result.ok) {
                      toast.error(result.error);
                      setArmed(false);
                      return;
                    }
                    toast.success("The exchange difference is in the ledger.");
                    setArmed(false);
                    router.refresh();
                  })
                }
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Yes — post the exchange difference
              </Button>
              <Button type="button" variant="ghost" onClick={() => setArmed(false)}>
                Cancel
              </Button>
              <span className="text-xs text-muted-foreground">
                This writes a journal dated the reporting date and moves the reported profit.
              </span>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => setArmed(true)}>
              Post to the ledger
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
