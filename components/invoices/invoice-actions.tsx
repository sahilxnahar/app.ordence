"use client";

/**
 * Ordence — Issue and cancel
 * Version: v0.94.0-alpha
 *
 * ⚠️ IMPORTED FROM `server/actions/`, NEVER FROM `server/invoicing/`.
 * That module begins with `import "server-only"`; importing it from a
 * `"use client"` file fails the production build, and `check:boundaries`
 * catches it in under a second rather than at deploy time.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ISSUING ASKS TWICE, AND CANCELLING ASKS FOR A REASON
 * ══════════════════════════════════════════════════════════════════════
 * Under Rule 53 an issued tax invoice cannot be edited — the only lawful
 * correction is a credit note, its own numbered document. The customer
 * holds their copy and may already have claimed input credit on it.
 *
 * So this is not a button that can be pressed by accident. The
 * confirmation states what becomes true, not "are you sure" — a dialog
 * that asks whether you are sure is answered "yes" without being read.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { issueInvoice, cancelInvoice } from "@/server/actions/sales-invoices";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function InvoiceActions({
  invoiceId,
  status,
  hasBlockingFindings,
  receivedMinor,
}: {
  invoiceId: string;
  status: string;
  hasBlockingFindings: boolean;
  receivedMinor: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const isDraft = status === "draft";
  const settled = receivedMinor !== "0";

  function doIssue() {
    setError(null);
    setConfirming(false);
    start(async () => {
      const res = await issueInvoice({ invoiceId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function doCancel() {
    setError(null);
    start(async () => {
      const res = await cancelInvoice({ invoiceId, reason });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCancelling(false);
      setReason("");
      router.refresh();
    });
  }

  if (status === "cancelled") {
    return <p className="text-sm text-muted-foreground">This invoice was cancelled.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {isDraft && !confirming && (
          <Button type="button" onClick={() => setConfirming(true)} disabled={pending}>
            Issue this invoice
          </Button>
        )}

        {/**
         * ⚠️ CANCELLING IS OFFERED ONLY WHILE NOTHING HAS BEEN RECEIVED.
         * The action refuses it anyway — cancelling a document a customer
         * has paid against strands their payment on something that no
         * longer exists — but a button that always fails teaches people
         * to distrust every button next to it.
         */}
        {!settled && !cancelling && !confirming && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setCancelling(true)}
            disabled={pending}
          >
            Cancel invoice
          </Button>
        )}
      </div>

      {confirming && (
        <div className="space-y-3 rounded border p-4">
          <p className="text-sm font-medium">
            Issuing assigns the next number in the series and freezes this document.
          </p>
          <p className="text-sm text-muted-foreground">
            After this it cannot be edited. The only lawful correction is a credit note —
            its own numbered document, reported on its own line of GSTR-1. The customer
            will hold this copy and may claim input credit against it.
          </p>

          {/**
           * ⚠️ A BLOCKING RULE 46 FINDING IS SHOWN HERE, NOT HIDDEN, AND
           * IT DOES NOT DISABLE THE BUTTON. The server decides what is
           * lawful; this is a warning at the moment it matters. Disabling
           * the button on a client-side check would be a rule enforced in
           * the one place a caller can skip.
           */}
          {hasBlockingFindings && (
            <p className="rounded border-l-2 border-destructive pl-3 text-sm">
              This invoice is missing fields Rule 46 requires. It can still be issued, and
              the customer&apos;s accountant may reject it.
            </p>
          )}

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

      {cancelling && (
        <div className="space-y-3 rounded border p-4">
          <p className="text-sm font-medium">Why is this invoice being cancelled?</p>
          <p className="text-sm text-muted-foreground">
            {/* Read back at an audit, possibly years later. */}
            This is recorded against the document and will be read back if the cancellation
            is ever questioned.
          </p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Raised against the wrong order — replaced by INV/2627/00042"
            rows={2}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={doCancel}
              disabled={pending || reason.trim().length < 4}
            >
              {pending ? "Cancelling…" : "Cancel this invoice"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCancelling(false);
                setReason("");
              }}
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
