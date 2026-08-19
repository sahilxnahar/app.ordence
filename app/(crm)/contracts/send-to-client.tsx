"use client";

/**
 * Ordence — Send Contract to Client
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A CONFIRMATION DIALOG AND NOT A BUTTON
 * ══════════════════════════════════════════════════════════════════════
 * Almost everything else in this application is reversible. A contact can
 * be edited, a document deleted, a period reopened.
 *
 * An email cannot be recalled. Once it is delivered, the draft agreement is
 * in someone else's inbox permanently, and no permission in this system
 * reaches it. That asymmetry deserves more friction than a single click.
 *
 * So the dialog shows the exact recipient address before anything is sent,
 * and states plainly that the status will move. The recipient is displayed
 * rather than entered: the server reads it from the contract's linked
 * contact and ignores anything the client might send, so showing an
 * editable field here would be a lie about what actually happens.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Send, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sendContractToClient } from "@/server/actions/contracts";

export function SendToClientButton({
  contractId,
  contractTitle,
  recipientName,
  recipientEmail,
  currentStatus,
  emailConfigured,
}: {
  contractId: string;
  contractTitle: string;
  recipientName: string | null;
  /** Null when no contact is linked, or the contact has no address. */
  recipientEmail: string | null;
  currentStatus: string;
  emailConfigured: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [isPending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (open) setMessage("");
  }, [open]);

  const willAdvance = currentStatus === "draft" || currentStatus === "internal_review";

  // Every reason the button cannot be used, in priority order. Each is
  // shown to the user rather than leaving a dead control on the page.
  const blockedReason = !emailConfigured
    ? "Email is not configured for this deployment."
    : !recipientEmail
      ? "Link a client contact with an email address first."
      : null;

  function handleSend() {
    startTransition(async () => {
      try {
        const result = await sendContractToClient({ contractId, message: message.trim() || undefined });

        if (result.ok) {
          toast.success(`Sent to ${result.data.recipient}.`);
          setOpen(false);
          router.refresh();
          return;
        }
        toast.error(result.error);
      } catch (err) {
        console.error("[send to client]", err);
        toast.error("Could not reach the server. Please try again.");
      }
    });
  }

  if (blockedReason) {
    return (
      <Button variant="outline" disabled title={blockedReason}>
        <Send className="h-4 w-4" aria-hidden="true" />
        Send to client
      </Button>
    );
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Send className="h-4 w-4" aria-hidden="true" />
        Send to client
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send this contract for review?</DialogTitle>
            <DialogDescription>{contractTitle}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Will be emailed to
              </p>
              <p className="mt-1 font-medium">
                {recipientName ? `${recipientName} — ` : ""}
                {recipientEmail}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                This address comes from the contact linked to this contract. To send
                somewhere else, change the linked contact — it cannot be overridden here.
              </p>
            </div>

            <div
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
              role="alert"
            >
              <TriangleAlert
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <span className="text-muted-foreground">
                An email cannot be recalled once it is sent.
                {willAdvance && (
                  <>
                    {" "}
                    The contract will also move to <strong>counterparty review</strong>.
                  </>
                )}
              </span>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="covering-note">Covering note (optional)</Label>
              <Textarea
                id="covering-note"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Anything you would like the client to read alongside the document."
              />
              <p className="text-xs text-muted-foreground">
                {message.trim().length}/2000
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? "Sending…" : "Send now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
