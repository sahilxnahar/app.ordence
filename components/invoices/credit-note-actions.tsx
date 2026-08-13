"use client";

/**
 * Ordence — Issue or discard a credit note
 * Version: v0.96.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ISSUING IS THE IRREVERSIBLE STEP, AND IT IS THE SMALLER BUTTON
 * ══════════════════════════════════════════════════════════════════════
 * Issuing assigns a number in a series Rule 53 requires to be
 * consecutive, consumes the invoice's remaining credit, and puts a
 * document in the customer's hands that they will reverse input tax
 * credit against. None of that can be undone.
 *
 * ⚠️ SO THE CONFIRMATION SAYS WHAT BECOMES TRUE, NOT "ARE YOU SURE".
 * A dialog asking whether you are sure is answered "yes" without being
 * read — which makes it a delay rather than a check.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  issueCreditNote,
  discardCreditNoteDraft,
} from "@/server/actions/sales-invoices";
import { Button } from "@/components/ui/button";

export function CreditNoteActions({
  creditNoteId,
  status,
  invoiceNumber,
  totalLabel,
}: {
  creditNoteId: string;
  status: string;
  invoiceNumber: string;
  totalLabel: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  if (status === "cancelled") {
    return (
      <p className="text-sm text-muted-foreground">
        {/* Not deleted. The row stays so the numbering and the audit trail hold. */}
        This draft was discarded. It took no number and reversed nothing.
      </p>
    );
  }

  if (status !== "draft") {
    return (
      <p className="text-sm text-muted-foreground">
        This credit note has been issued. Under Rule 53 it cannot be edited or withdrawn —
        the customer holds it and has reversed input credit against it. A mistake on an
        issued credit note is corrected by a further document.
      </p>
    );
  }

  function doIssue() {
    setError(null);
    setConfirming(false);
    start(async () => {
      const res = await issueCreditNote({ creditNoteId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function doDiscard() {
    setError(null);
    setDiscarding(false);
    start(async () => {
      const res = await discardCreditNoteDraft({ creditNoteId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {!confirming && !discarding && (
          <Button type="button" onClick={() => setConfirming(true)} disabled={pending}>
            Issue this credit note
          </Button>
        )}
        {!confirming && !discarding && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setDiscarding(true)}
            disabled={pending}
          >
            Discard the draft
          </Button>
        )}
      </div>

      {confirming && (
        <div className="space-y-3 rounded border p-4">
          <p className="text-sm font-medium">
            Issuing assigns the next number in the credit-note series and reverses{" "}
            {totalLabel} of {invoiceNumber}.
          </p>
          <p className="text-sm text-muted-foreground">
            After this it cannot be edited or withdrawn. It appears in GSTR-1 as a credit
            note against {invoiceNumber}, and the customer reverses the input tax credit
            they claimed on that invoice.
          </p>
          <p className="text-sm text-muted-foreground">
            {/**
             * ⚠️ SAID OUT LOUD BECAUSE THE FAILURE IS CONFUSING WHEN IT
             * ARRIVES. Another credit note may have been issued against
             * this invoice since this draft was written, and the check
             * runs at issue, not at draft.
             */}
            If another credit note has been issued against this invoice since this draft was
            written, this will be refused — the checks run now, not when the draft was
            created.
          </p>
          <div className="flex gap-2">
            <Button type="button" onClick={doIssue} disabled={pending}>
              {pending ? "Issuing…" : "Issue it"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Not yet
            </Button>
          </div>
        </div>
      )}

      {discarding && (
        <div className="space-y-3 rounded border p-4">
          <p className="text-sm font-medium">Discard this draft?</p>
          <p className="text-sm text-muted-foreground">
            It has no number, nothing has been reversed, and the customer has never seen it.
            The record is kept and marked discarded rather than deleted, so the series stays
            consecutive.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={doDiscard}
              disabled={pending}
            >
              {pending ? "Discarding…" : "Discard it"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDiscarding(false)}
              disabled={pending}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
