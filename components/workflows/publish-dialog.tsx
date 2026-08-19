"use client";

/**
 * Ordence — The Publish Dialog
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ PUBLISHING IS THE MOMENT AUTHORITY IS DELEGATED, AND THE DIALOG
 *    SAYS SO IN THE FIRST SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * Everything else about a draft is bookkeeping. Publishing is not: for a
 * scheduled or webhook trigger it writes the publisher's user id into
 * `workflow_versions.run_as_user_id`, and from then on every unattended
 * run acts AS THEM, with their permissions, re-read live on every run,
 * for as long as the version stays active.
 *
 * That is a delegation of authority. It is exactly the kind of thing
 * that, done by accident, nobody can account for six months later when
 * the question is "who authorised this automation to email nine hundred
 * buyers?".
 *
 * So it is not a footnote, not a tooltip, and not the third bullet under
 * a "Learn more" link. It is the largest block of text in the dialog, in
 * plain words, above the button — and the server refuses the publish
 * without the acknowledgement this checkbox sets
 * (`publishVersionSchema.acknowledgeRunsAsMe`, a `z.literal(true)`).
 *
 * ⚠️ THE CHECKBOX IS NOT THE PROTECTION. The server re-validates the
 * definition, re-checks `workflows:publish`, re-checks the entitlements
 * and re-checks that the publisher personally holds every permission the
 * definition needs. This dialog can be bypassed with a curl command and
 * nothing about the outcome changes. What it is for is making sure the
 * person who does it knows what they did.
 */

import { useId, useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TRIGGER_CATALOG } from "@/lib/workflows/triggers";
import type { WorkflowTriggerType } from "@/lib/workflows/program";
import type { ValidationResult } from "@/lib/workflows/validation";
import { ProblemList } from "./validation-panel";

export type PublishDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versionNumber: number;
  workflowName: string;
  triggerType: WorkflowTriggerType;
  validation: ValidationResult;
  summary: string;
  /** Permissions the definition needs, computed from the engine's catalogues. */
  requiredPermissions: readonly string[];
  /** How the publisher is identified in the audit trail. */
  publisherLabel: string;
  onConfirm: (args: { acceptWarnings: boolean }) => void;
  pending?: boolean;
  error?: string | null;
};

export function PublishDialog({
  open,
  onOpenChange,
  versionNumber,
  workflowName,
  triggerType,
  validation,
  summary,
  requiredPermissions,
  publisherLabel,
  onConfirm,
  pending = false,
  error = null,
}: PublishDialogProps) {
  const baseId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const [acceptWarnings, setAcceptWarnings] = useState(false);

  const unattended = TRIGGER_CATALOG[triggerType].unattended;
  const blocked = validation.errors.length > 0;
  const needsWarningAccept = validation.warnings.length > 0;

  const canPublish =
    !blocked && acknowledged && (!needsWarningAccept || acceptWarnings) && !pending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setAcknowledged(false);
          setAcceptWarnings(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Publish version {versionNumber} of &ldquo;{workflowName}&rdquo;
          </DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>

        {/* ⭐ THE DELEGATION WARNING. First, largest, unmissable. */}
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-700"
              aria-hidden="true"
            />
            <div className="space-y-2 text-sm text-amber-900">
              <p className="font-semibold">
                Publishing lends your identity to every future unattended run.
              </p>
              <p>
                {unattended ? (
                  <>
                    This workflow&apos;s trigger is{" "}
                    <strong>{TRIGGER_CATALOG[triggerType].label.toLowerCase()}</strong>,
                    so nobody is present when it runs. Every one of those runs will act
                    as <strong>{publisherLabel}</strong> — with your permissions, on
                    your behalf, whether or not you are at your desk.
                  </>
                ) : (
                  <>
                    A run started by a person acts as that person. But this version
                    still records <strong>{publisherLabel}</strong> as the identity any
                    unattended run would borrow, and the trigger can be changed later
                    without republishing the idea behind it.
                  </>
                )}
              </p>
              <p>
                It can do anything you can do, to any record you can reach, and it will
                keep doing it until somebody switches the workflow off or publishes a
                different version. Your permissions are re-read on every run, so if
                your account is suspended the automation stops with it.
              </p>
              <p>
                This is recorded in the audit log against your name, as a warning-level
                entry, with the trigger and the version number.
              </p>
            </div>
          </div>
        </div>

        {requiredPermissions.length > 0 ? (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
            <p className="font-medium">
              You must personally hold these permissions for this to publish:
            </p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {requiredPermissions.map((permission) => (
                <li
                  key={permission}
                  className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {permission}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-muted-foreground">
              An automation can never do more than the person who published it. If you
              are missing one, the publish is refused and names it — ask somebody who
              holds it to publish, or remove those steps.
            </p>
          </div>
        ) : null}

        {blocked ? (
          <div>
            <p className="text-sm font-medium text-destructive">
              This cannot be published yet.
            </p>
            <ProblemList problems={validation.errors} tone="error" />
          </div>
        ) : null}

        {needsWarningAccept ? (
          <div>
            <ProblemList
              problems={validation.warnings}
              tone="warning"
              heading="Publishing anyway means accepting these"
            />
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <input
              id={`${baseId}-ack`}
              type="checkbox"
              checked={acknowledged}
              disabled={blocked}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <label htmlFor={`${baseId}-ack`} className="text-sm">
              I understand that this workflow will act with my permissions when it runs
              unattended, and that I am responsible for what it does.
            </label>
          </div>

          {needsWarningAccept ? (
            <div className="flex items-start gap-2">
              <input
                id={`${baseId}-warn`}
                type="checkbox"
                checked={acceptWarnings}
                disabled={blocked}
                onChange={(event) => setAcceptWarnings(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <label htmlFor={`${baseId}-warn`} className="text-sm">
                I have read the {validation.warnings.length} warning
                {validation.warnings.length === 1 ? "" : "s"} above and want to publish
                anyway.
              </label>
            </div>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canPublish}
            onClick={() => onConfirm({ acceptWarnings })}
          >
            {pending ? "Publishing…" : "Publish and delegate my permissions"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
