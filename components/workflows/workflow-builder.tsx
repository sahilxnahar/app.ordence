"use client";

/**
 * Ordence — The Workflow Builder
 * Version: v0.24.0-alpha
 *
 * The screen the whole phase exists for. An engine with no builder is a
 * feature no customer can reach.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE BUILDER HOLDS NO OPINIONS OF ITS OWN
 * ══════════════════════════════════════════════════════════════════════
 * Every list it offers and every rule it enforces is imported:
 *
 *   actions          → `ACTION_TYPES` / `ACTION_CATALOG`
 *   triggers         → `TRIGGER_TYPES` / `TRIGGER_CATALOG`
 *   record types     → `RECORD_TYPES`
 *   writable columns → `RECORD_TYPES[…].writableColumns`
 *   limits           → `lib/workflows/limits.ts`
 *   validity         → `validateDefinition`, the server's own function
 *
 * The temptation in a builder is to be helpful — to soften a rule, to
 * pre-fill a default the engine would reject, to hide an action that
 * "probably won't work". Every one of those creates a second opinion,
 * and the moment the two disagree the author is shown a green screen and
 * then a refusal. One source, checked early.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AN ACTIVE VERSION IS READ-ONLY, AND THE BUILDER SAYS WHY
 * ══════════════════════════════════════════════════════════════════════
 * A run can sit suspended on an approval for days holding a CURSOR — a
 * position inside the step list. Editing the definition underneath it
 * makes that position mean something else: step 3 was an email and is
 * now a delete. So editing a live version produces a NEW DRAFT, the
 * database refuses anything else, and the banner explains it rather than
 * leaving the author to discover a disabled form.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { History, Save, Power, PlayCircle, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_STEP_BUDGET,
  MAX_CONFIGURABLE_STEP_BUDGET,
} from "@/lib/workflows/limits";
import { summariseValidation, validateDefinition } from "@/lib/workflows/validation";
import type {
  TriggerConfig,
  WorkflowStep,
  WorkflowTriggerType,
} from "@/lib/workflows/program";
import type { ActionResult } from "@/lib/validators/crm";
import { LimitsMeter } from "./limits-meter";
import { PublishDialog } from "./publish-dialog";
import { StepList } from "./step-list";
import { TriggerEditor } from "./trigger-editor";
import { ValidationPanel, problemsFor } from "./validation-panel";
import {
  countSteps,
  definitionDepth,
  requiredPermissionsFor,
  ROOT,
} from "./step-tree";

/* ------------------------------------------------------------------ */
/* PROPS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE SERVER ACTIONS ARE PASSED IN, NOT IMPORTED.
 *
 * `server/actions/workflows.ts` reaches the database at module scope, so
 * importing it here would make this component unmountable in any context
 * without a `DATABASE_URL` — including the test that proves the action
 * picker matches the engine. Passing them from the page keeps the
 * component honest about what it depends on, and testable.
 */
export type SaveDraftAction = (input: unknown) => Promise<
  ActionResult<{ versionId: string; version: number; validation: string }>
>;
export type PublishAction = (input: unknown) => Promise<
  ActionResult<{ versionId: string; version: number; archivedVersion: number | null }>
>;
export type SetEnabledAction = (input: unknown) => Promise<
  ActionResult<{ id: string; isEnabled: boolean }>
>;
export type RunNowAction = (input: unknown) => Promise<
  ActionResult<{ runId: string; status: string }>
>;

export type BuilderVersion = {
  id: string;
  version: number;
  status: "draft" | "active" | "archived";
  triggerType: WorkflowTriggerType;
  triggerConfig: TriggerConfig;
  steps: WorkflowStep[];
  stepBudget: number;
  notes: string | null;
};

export type WorkflowBuilderProps = {
  workflowId: string;
  workflowName: string;
  workflowKey: string;
  isEnabled: boolean;
  version: BuilderVersion;
  /** Every version, newest first — for the "which am I looking at" picker. */
  versions: readonly { id: string; version: number; status: string }[];
  /** How the publisher appears in the audit trail. */
  publisherLabel: string;
  onSaveDraft: SaveDraftAction;
  onPublish: PublishAction;
  onSetEnabled: SetEnabledAction;
  onRunNow?: RunNowAction;
};

/* ------------------------------------------------------------------ */
/* THE BUILDER                                                         */
/* ------------------------------------------------------------------ */

export function WorkflowBuilder({
  workflowId,
  workflowName,
  workflowKey,
  isEnabled,
  version,
  versions,
  publisherLabel,
  onSaveDraft,
  onPublish,
  onSetEnabled,
  onRunNow,
}: WorkflowBuilderProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [triggerType, setTriggerType] = useState<WorkflowTriggerType>(version.triggerType);
  const [triggerConfig, setTriggerConfig] = useState<TriggerConfig>(
    version.triggerConfig ?? {},
  );
  const [steps, setSteps] = useState<WorkflowStep[]>(version.steps ?? []);
  const [stepBudget, setStepBudget] = useState<number>(
    version.stepBudget ?? DEFAULT_STEP_BUDGET,
  );
  const [notes, setNotes] = useState<string>(version.notes ?? "");

  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const readOnly = version.status !== "draft";

  /* ⭐ The engine's own validator, on every render. Pure, so it is free. */
  const validation = useMemo(
    () =>
      validateDefinition({
        triggerType,
        triggerConfig,
        program: { steps },
        stepBudget,
      }),
    [triggerType, triggerConfig, steps, stepBudget],
  );

  const summary = useMemo(() => summariseValidation(validation), [validation]);
  const stepCount = useMemo(() => countSteps(steps), [steps]);
  const depth = useMemo(() => definitionDepth(steps), [steps]);
  const permissions = useMemo(() => requiredPermissionsFor(steps), [steps]);

  const mutate = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setDirty(true);
    setMessage(null);
  };

  /* ---------------------------------------------------------------- */
  /* SAVE                                                             */
  /* ---------------------------------------------------------------- */

  const draftPayload = () => ({
    workflowId,
    // ⚠️ Omitted when the version is not a draft, which is what makes
    // "edit a live workflow" mean "branch a new draft" rather than
    // "mutate something a run is part-way through".
    versionId: version.status === "draft" ? version.id : undefined,
    triggerType,
    triggerConfig,
    program: { steps },
    stepBudget,
    notes: notes.trim() === "" ? null : notes.trim(),
  });

  const save = (): Promise<string | null> =>
    onSaveDraft(draftPayload()).then((result) => {
      if (!result.ok) {
        setError(result.error);
        return null;
      }
      setError(null);
      setDirty(false);
      setMessage(
        `Saved as version ${result.data.version}. ${result.data.validation}`,
      );
      router.refresh();
      return result.data.versionId;
    });

  const handleSave = () => {
    setMessage(null);
    startTransition(() => {
      void save();
    });
  };

  /* ---------------------------------------------------------------- */
  /* PUBLISH                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * ⚠️ SAVES FIRST, ALWAYS.
   *
   * Publishing a version id while unsaved edits sit in the browser
   * publishes the OLD definition, silently, and the author's evidence
   * that their change went live is that the publish succeeded. So the
   * draft is written and the id that comes back is the one published.
   */
  const handlePublish = ({ acceptWarnings }: { acceptWarnings: boolean }) => {
    setPublishError(null);
    startTransition(async () => {
      const versionId = dirty || readOnly ? await save() : version.id;
      if (!versionId) {
        setPublishError("The draft could not be saved, so nothing was published.");
        return;
      }

      const result = await onPublish({
        versionId,
        // The server's schema is `z.literal(true)` — there is no way to
        // publish without it, and the checkbox in the dialog is what
        // sets it.
        acknowledgeRunsAsMe: true,
        acceptWarnings,
      });

      if (!result.ok) {
        setPublishError(result.error);
        return;
      }

      setPublishOpen(false);
      setMessage(
        `Version ${result.data.version} is live.` +
          (result.data.archivedVersion
            ? ` Version ${result.data.archivedVersion} was archived — runs already inside it finish against it.`
            : ""),
      );
      router.refresh();
    });
  };

  /* ---------------------------------------------------------------- */
  /* KILL SWITCH                                                      */
  /* ---------------------------------------------------------------- */

  const handleEnabled = (next: boolean) => {
    startTransition(async () => {
      const result = await onSetEnabled({ workflowId, isEnabled: next });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setMessage(
        next
          ? "Switched on. It will run the next time its trigger fires."
          : "Switched off. Nothing new will start; runs already in flight continue.",
      );
      router.refresh();
    });
  };

  const handleRunNow = () => {
    if (!onRunNow) return;
    startTransition(async () => {
      const result = await onRunNow({ workflowId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setMessage(
        `Run finished with status "${result.data.status}". It ran as you, not as the person who published it.`,
      );
      router.refresh();
    });
  };

  /* ---------------------------------------------------------------- */
  /* RENDER                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{workflowName}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <code className="font-mono">{workflowKey}</code> · version{" "}
            {version.version} · {version.status}
            {dirty ? " · unsaved changes" : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {versions.length > 1 ? (
            <div>
              <label htmlFor="version-picker" className="sr-only">
                Which version to look at
              </label>
              <select
                id="version-picker"
                value={version.id}
                onChange={(event) =>
                  router.push(`/automations/${workflowId}?version=${event.target.value}`)
                }
                className="h-9 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {versions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    Version {entry.version} — {entry.status}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <Button asChild variant="outline" className="h-9">
            <Link href={`/automations/runs?workflowId=${workflowId}`}>
              <History className="h-4 w-4" aria-hidden="true" />
              Run history
            </Link>
          </Button>

          {onRunNow && triggerType === "manual" ? (
            <Button
              type="button"
              variant="outline"
              className="h-9"
              disabled={pending}
              onClick={handleRunNow}
            >
              <PlayCircle className="h-4 w-4" aria-hidden="true" />
              Run now
            </Button>
          ) : null}

          <Button
            type="button"
            variant="outline"
            className="h-9"
            disabled={pending}
            onClick={() => handleEnabled(!isEnabled)}
          >
            <Power className="h-4 w-4" aria-hidden="true" />
            {isEnabled ? "Deactivate" : "Activate"}
          </Button>

          <Button type="button" className="h-9" disabled={pending} onClick={handleSave}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {readOnly ? "Save as a new draft" : "Save draft"}
          </Button>

          <Button
            type="button"
            variant="default"
            className="h-9"
            disabled={pending || validation.errors.length > 0}
            onClick={() => {
              setPublishError(null);
              setPublishOpen(true);
            }}
          >
            <Rocket className="h-4 w-4" aria-hidden="true" />
            Publish…
          </Button>
        </div>
      </header>

      {readOnly ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">
            Version {version.version} is {version.status} and cannot be edited.
          </strong>{" "}
          A run can sit suspended inside it for days holding a position in this step
          list; editing underneath it would make that position mean something else.
          Changes you make here are saved as a NEW draft.
        </p>
      ) : null}

      {message ? (
        <p
          role="status"
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800"
        >
          {message}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-4">
          <TriggerEditor
            triggerType={triggerType}
            triggerConfig={triggerConfig}
            disabled={readOnly}
            problems={problemsFor(validation, "trigger")}
            onChange={(next) => {
              setTriggerType(next.triggerType);
              setTriggerConfig(next.triggerConfig);
              setDirty(true);
              setMessage(null);
            }}
          />

          <section aria-label="Steps" className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Then do this</h2>
              <p className="text-xs text-muted-foreground">
                Runs top to bottom. Drag a step, or use the up and down buttons.
              </p>
            </div>

            <StepList
              steps={steps}
              onChange={mutate(setSteps)}
              path={ROOT}
              validation={validation}
              triggerType={triggerType}
              triggerConfig={triggerConfig}
              readOnly={readOnly}
            />

            {problemsFor(validation, "program").errors.length > 0 ? (
              <div className="mt-3">
                <ValidationPanel
                  result={{
                    ok: false,
                    errors: problemsFor(validation, "program").errors,
                    warnings: [],
                  }}
                  summary="About the workflow as a whole"
                />
              </div>
            ) : null}
          </section>
        </div>

        <aside className="space-y-4">
          <ValidationPanel result={validation} summary={summary} />

          <LimitsMeter stepCount={stepCount} depth={depth} stepBudget={stepBudget} />

          <div className="rounded-lg border border-border bg-card p-3">
            <label htmlFor="step-budget" className="mb-1 block text-xs font-medium">
              Step budget for one run
            </label>
            <Input
              id="step-budget"
              type="number"
              min={1}
              max={MAX_CONFIGURABLE_STEP_BUDGET}
              value={stepBudget}
              disabled={readOnly}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                mutate(setStepBudget)(
                  Number.isFinite(parsed) ? Math.trunc(parsed) : DEFAULT_STEP_BUDGET,
                );
              }}
              aria-describedby="step-budget-help"
            />
            <p id="step-budget-help" className="mt-1 text-[11px] text-muted-foreground">
              A version may tighten the engine&apos;s ceiling of{" "}
              {MAX_CONFIGURABLE_STEP_BUDGET}, never loosen it. A loop you know should
              never exceed twenty gets a much earlier and much more readable failure
              than the engine-wide limit.
            </p>

            <label htmlFor="version-notes" className="mb-1 mt-3 block text-xs font-medium">
              Notes on this version
            </label>
            <Textarea
              id="version-notes"
              value={notes}
              disabled={readOnly}
              onChange={(event) => mutate(setNotes)(event.target.value)}
              placeholder="What changed, and why."
            />
          </div>

          {permissions.length > 0 ? (
            <div className="rounded-lg border border-border bg-card p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Permissions this needs
              </h3>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {permissions.map((permission) => (
                  <li
                    key={permission}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]"
                  >
                    {permission}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Whoever publishes must personally hold all of them. The server checks
                this at publish and names anything missing.
              </p>
            </div>
          ) : null}
        </aside>
      </div>

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        versionNumber={version.version}
        workflowName={workflowName}
        triggerType={triggerType}
        validation={validation}
        summary={summary}
        requiredPermissions={permissions}
        publisherLabel={publisherLabel}
        onConfirm={handlePublish}
        pending={pending}
        error={publishError}
      />
    </div>
  );
}
