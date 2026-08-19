"use client";

/**
 * Ordence — Workspace address (rename), operator-only
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCREEN IS A MISTAKE GUARD. IT IS NOT THE BOUNDARY.
 * ══════════════════════════════════════════════════════════════════════
 * The button below is rendered DISABLED for a grade that cannot rename —
 * the same choice `TenantActions` makes and for the same reason: a hidden
 * control teaches a support engineer that the capability does not exist,
 * so when they need it they ask for a script instead of a grade.
 *
 * ⚠️ NOTHING HERE REFUSES ANYTHING. `renameTenantSlugAction` is a
 * `"use server"` export, which means a public HTTP endpoint with a stable
 * action id, reachable by POST from any page in the product by anybody who
 * can read a network tab. The refusal that counts is
 * `requireCapability("tenants:provision")` inside
 * `server/platform/rename-slug.ts`, and after that the guard trigger and
 * two unique indexes in `0091_slug_authority.sql`.
 *
 * ⭐ WHY THE DIALOG SAYS SO MUCH. A rename is a hostname change: it moves
 * the address on every bookmark, every emailed invoice link and every
 * message a site engineer forwarded. The operator is about to make a
 * promise to a customer about what still works, and the consequence list
 * is where they read the true answer before they make it.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DangerDialog } from "./danger-dialog";

/**
 * ⚠️ MIRRORS `RELEASE_REASON_MIN` IN `server/platform/rename-slug.ts`.
 * The server re-validates, so this number can only ever be a courtesy —
 * if the two drift, the dialog enables its button a few characters early
 * and the server says no. The opposite drift (this number larger) would
 * be invisible and harmless.
 */
const MIN_REASON = 10;

type RenameResult =
  | {
      ok: true;
      data: {
        previousSlug: string;
        newSlug: string;
        workspaceUrl: string;
        retainedUntil: string;
        pending: string[];
      };
    }
  | { ok: false; error: string };

export type RenameSlugCardProps = {
  tenantId: string;
  currentSlug: string;
  /** False for every grade below owner. The control is shown, not hidden. */
  canRename: boolean;
  onRename: (input: {
    tenantId: string;
    confirmSlug: string;
    newSlug: string;
    releaseReason: string;
  }) => Promise<RenameResult>;
};

export function RenameSlugCard(props: RenameSlugCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * ⭐⭐ THE RECEIPT STAYS ON THE SCREEN AFTER THE DIALOG CLOSES.
   *
   * ⚠️ A TOAST IS THE WRONG CARRIER FOR "and here is what you must now do
   * by hand". Nothing in this product tells the customer their address
   * changed; that sentence has to survive long enough for the operator to
   * act on it, and a toast is gone in four seconds.
   */
  const [receipt, setReceipt] = useState<string[] | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4" aria-hidden />
          Workspace address
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="font-mono">{props.currentSlug}</p>

        <p className="text-xs text-muted-foreground">
          Changing this changes the hostname the customer&rsquo;s people type. The old
          address answers a permanent redirect for 365 days and stays blocked for every
          workspace, including this one, for the whole of that period.
        </p>

        {/*
          ⚠️ STATED ON THE SCREEN, NOT ONLY IN A CODE COMMENT. The reason
          there is no customer-facing version of this control is that the
          owner notification does not exist yet — and the person most
          likely to be asked "why can't they do this themselves?" is the
          operator standing on this page.
        */}
        <p className="text-xs text-muted-foreground">
          Operator-only for now: a rename is a hostname change, and the customer is not
          notified by anything in the product. Tell their owner yourself.
        </p>

        {receipt ? (
          <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs">
            {receipt.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          disabled={!props.canRename || pending}
          onClick={() => {
            setError(null);
            setNewSlug("");
            setOpen(true);
          }}
        >
          Change address
        </Button>
        {!props.canRename ? (
          <p className="text-xs text-muted-foreground">
            Platform owner grade only — the same grade that can provision a workspace.
          </p>
        ) : null}
      </CardContent>

      <DangerDialog
        open={open}
        onOpenChange={setOpen}
        title="Change this workspace's address"
        description={`${props.currentSlug} stops being the customer's front door the moment this completes.`}
        consequences={[
          "Every bookmark, emailed invoice link and saved shortcut on the old address gets a permanent redirect to the new one.",
          "The old address is retained for 365 days: no workspace can claim it, including this one.",
          "A name too similar to the old one is refused as well — hyphens, 0/o and 1/l/i all fold together.",
          "Nothing in this product tells the customer. You have to.",
          "No data is moved, deleted or re-keyed. Only the hostname changes.",
        ]}
        confirmValue={props.currentSlug}
        confirmLabel="Type the CURRENT address to confirm you are on the right workspace"
        justificationLabel="Why is the address changing?"
        minJustification={MIN_REASON}
        actionLabel="Change address"
        pending={pending}
        error={error}
        extra={
          <div className="space-y-1">
            <Label htmlFor="rename-new-slug">New address</Label>
            <Input
              id="rename-new-slug"
              value={newSlug}
              autoComplete="off"
              spellCheck={false}
              placeholder="acme-india"
              onChange={(e) => setNewSlug(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers and hyphens. 3 to 63 characters. The database
              decides whether it is free — this field cannot.
            </p>
          </div>
        }
        onConfirm={({ confirmValue, justification }) => {
          setError(null);
          startTransition(async () => {
            const result = await props.onRename({
              tenantId: props.tenantId,
              confirmSlug: confirmValue,
              newSlug,
              releaseReason: justification,
            });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setOpen(false);
            setReceipt([
              `Moved from ${result.data.previousSlug} to ${result.data.newSlug} — ${result.data.workspaceUrl}`,
              ...result.data.pending,
            ]);
            toast.success(`Address changed to ${result.data.newSlug}.`);
            router.refresh();
          });
        }}
      />
    </Card>
  );
}
