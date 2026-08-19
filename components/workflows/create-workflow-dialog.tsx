"use client";

/**
 * Ordence — New Automation
 * Version: v0.24.0-alpha
 *
 * Four fields, and only one of them is a decision: the trigger.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE KEY IS DERIVED AND STILL EDITABLE
 * ══════════════════════════════════════════════════════════════════════
 * `workflows.key` is a stable slug — support quotes it, the API uses it,
 * and it is unique per workspace. Asking somebody to invent one before
 * they have written the automation is a form field standing between them
 * and the thing they came to do; hiding it entirely means it is
 * generated, ugly and permanent.
 *
 * So it is derived from the name as they type, and it stops following
 * the moment they touch it. Two lines of state for a field nobody thinks
 * about and everybody eventually needs.
 *
 * ⚠️ A NEW WORKFLOW IS BORN SWITCHED OFF, and the dialog says so. Not by
 * a flag — by having no active version. Nothing runs until somebody
 * publishes, which is a separate permission and a separate decision.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TRIGGER_TYPES } from "@/lib/workflows/program";
import { TRIGGER_CATALOG } from "@/lib/workflows/triggers";
import type { WorkflowTriggerType } from "@/lib/workflows/program";
import type { ActionResult } from "@/lib/validators/crm";

export type CreateWorkflowAction = (input: unknown) => Promise<
  ActionResult<{ id: string; versionId: string }>
>;

export function CreateWorkflowDialog({
  onCreate,
}: {
  onCreate: CreateWorkflowAction;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [triggerType, setTriggerType] = useState<WorkflowTriggerType>("record_updated");
  const [error, setError] = useState<string | null>(null);

  const effectiveKey = keyTouched ? key : slugify(name);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await onCreate({
        key: effectiveKey,
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        triggerType,
        triggerConfig: TRIGGER_CATALOG[triggerType].recordScoped
          ? { recordType: "lead" }
          : triggerType === "scheduled"
            ? { cron: "0 9 * * 1-5", timezone: "Asia/Kolkata" }
            : {},
        program: { steps: [] },
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setOpen(false);
      router.push(`/automations/${result.data.id}`);
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" aria-hidden="true" />
          New automation
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>
            It starts as a draft and does nothing at all until somebody publishes it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label htmlFor="wf-name" className="mb-1 block text-xs font-medium">
              Name
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </label>
            <Input
              id="wf-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Notify the manager when a lead turns hot"
            />
          </div>

          <div>
            <label htmlFor="wf-key" className="mb-1 block text-xs font-medium">
              Key
            </label>
            <Input
              id="wf-key"
              value={effectiveKey}
              onChange={(event) => {
                setKeyTouched(true);
                setKey(event.target.value);
              }}
              className="font-mono"
              aria-describedby="wf-key-help"
            />
            <p id="wf-key-help" className="mt-1 text-[11px] text-muted-foreground">
              Lowercase letters, digits, hyphens and underscores. It is how support and
              the API refer to this automation, so it is worth reading well.
            </p>
          </div>

          <div>
            <label htmlFor="wf-desc" className="mb-1 block text-xs font-medium">
              What it is for (optional)
            </label>
            <Textarea
              id="wf-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div>
            <label htmlFor="wf-trigger" className="mb-1 block text-xs font-medium">
              Trigger
            </label>
            <select
              id="wf-trigger"
              value={triggerType}
              onChange={(event) =>
                setTriggerType(event.target.value as WorkflowTriggerType)
              }
              aria-describedby="wf-trigger-help"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {TRIGGER_TYPES.map((value) => (
                <option key={value} value={value}>
                  {TRIGGER_CATALOG[value].label}
                </option>
              ))}
            </select>
            <p id="wf-trigger-help" className="mt-1 text-[11px] text-muted-foreground">
              {TRIGGER_CATALOG[triggerType].description}
              {TRIGGER_CATALOG[triggerType].unattended
                ? " Runs of this kind have no live person, so they act with the permissions of whoever publishes the workflow."
                : ""}
            </p>
          </div>
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
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || name.trim() === "" || effectiveKey === ""}
          >
            {pending ? "Creating…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Name → key. Conservative: it must satisfy `workflowKeySchema`. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  // The schema requires a LETTER first — "2024-review" would be refused,
  // and a key the user cannot see is a refusal they cannot act on.
  return /^[a-z]/.test(slug) ? slug : slug ? `wf-${slug}`.slice(0, 80) : "";
}
