/**
 * Ordence — The Workflow Builder UI
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 26 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * Three claims are made about this builder, and all three are the sort
 * that quietly stop being true:
 *
 *   1. The action picker offers EXACTLY the engine's catalogue and
 *      nothing more. Two lists drift; the UI then offers an action the
 *      engine has never heard of and the save is refused.
 *   2. Validation errors are RENDERED, from the engine's own validator,
 *      while the author is still looking at the form.
 *   3. The publish dialog states the identity delegation plainly.
 *
 * These tests RENDER the real components against the real engine
 * exports. Nothing about the catalogue, the limits or the validator is
 * mocked — mocking any of them would make these tests assert that the
 * mocks agree with themselves.
 *
 * ⚠️ THE SERVER ACTIONS ARE THE ONLY THING STUBBED, and only because
 * `server/actions/workflows.ts` builds a database client at module
 * scope. That is exactly why `WorkflowBuilder` takes them as props
 * rather than importing them.
 */

import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ActionPicker } from "@/components/workflows/action-picker";
import { PublishDialog } from "@/components/workflows/publish-dialog";
import {
  WorkflowBuilder,
  type BuilderVersion,
} from "@/components/workflows/workflow-builder";
import {
  countSteps,
  createStep,
  definitionDepth,
  insertStep,
  moveStep,
  removeStep,
  requiredPermissionsFor,
  ROOT,
  suggestKey,
  bindingSuggestions,
} from "@/components/workflows/step-tree";
import { workflowState } from "@/components/workflows/presentation";

import { ACTION_CATALOG } from "@/lib/workflows/actions";
import { ACTION_TYPES, TRIGGER_TYPES } from "@/lib/workflows/program";
import { TRIGGER_CATALOG } from "@/lib/workflows/triggers";
import {
  MAX_NESTING_DEPTH,
  MAX_STEPS_PER_DEFINITION,
  MAX_ITERATIONS_PER_LOOP,
} from "@/lib/workflows/limits";
import { validateDefinition } from "@/lib/workflows/validation";
import type { WorkflowStep } from "@/lib/workflows/program";

/* ------------------------------------------------------------------ */
/* HARNESS                                                             */
/* ------------------------------------------------------------------ */

function okAction<T>(data: T) {
  return vi.fn(async () => ({ ok: true as const, data }));
}

function makeVersion(overrides: Partial<BuilderVersion> = {}): BuilderVersion {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    version: 3,
    status: "draft",
    triggerType: "record_updated",
    triggerConfig: { recordType: "lead", watchFields: ["status"] },
    steps: [],
    stepBudget: 100,
    notes: null,
    ...overrides,
  };
}

function renderBuilder(version: BuilderVersion = makeVersion()) {
  const onSaveDraft = okAction({
    versionId: version.id,
    version: version.version,
    validation: "Ready to publish.",
  });
  const onPublish = okAction({
    versionId: version.id,
    version: version.version,
    archivedVersion: null,
  });
  const onSetEnabled = okAction({ id: "wf", isEnabled: true });

  const utils = render(
    <WorkflowBuilder
      workflowId="22222222-2222-4222-8222-222222222222"
      workflowName="Notify the manager when a lead turns hot"
      workflowKey="notify-manager-hot-lead"
      isEnabled
      version={version}
      versions={[{ id: version.id, version: version.version, status: version.status }]}
      publisherLabel="Asha Rao (asha@ordence.example)"
      onSaveDraft={onSaveDraft}
      onPublish={onPublish}
      onSetEnabled={onSetEnabled}
    />,
  );

  return { ...utils, onSaveDraft, onPublish, onSetEnabled };
}

/* ================================================================== */
/* 1. THE PICKER IS THE ENGINE'S CATALOGUE — NOTHING MORE, NOTHING     */
/*    LESS                                                             */
/* ================================================================== */

describe("Action picker — driven by the engine's catalogue", () => {
  it("offers exactly the actions the engine has, and no others", async () => {
    render(<ActionPicker onAdd={vi.fn()} />);

    const select = screen.getByLabelText("Add a step");
    const offered = within(select)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    // Exactly the engine's list — set equality in both directions, so a
    // picker that quietly drops an action fails just as loudly as one
    // that invents one.
    expect([...offered].sort()).toEqual([...ACTION_TYPES].sort());
    expect(offered).toHaveLength(ACTION_TYPES.length);
  });

  it("does not offer `run_code`, because the engine does not have it", () => {
    render(<ActionPicker onAdd={vi.fn()} />);

    const values = within(screen.getByLabelText("Add a step"))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    expect(values).not.toContain("run_code");
    // Belt and braces: the engine really does not have it either, so the
    // assertion above cannot pass for the wrong reason.
    expect(ACTION_TYPES as readonly string[]).not.toContain("run_code");
  });

  it("labels every option from ACTION_CATALOG rather than from a local map", () => {
    render(<ActionPicker onAdd={vi.fn()} />);

    for (const action of ACTION_TYPES) {
      const option = within(screen.getByLabelText("Add a step")).getByRole("option", {
        // Anchored: "Wait" and "Wait for approval" are both real labels.
        name: new RegExp(`^${escapeRegExp(ACTION_CATALOG[action].label)}$`),
      });
      expect((option as HTMLOptionElement).value).toBe(action);
    }
  });

  it("groups options by the catalogue's own effect/control split", () => {
    const { container } = render(<ActionPicker onAdd={vi.fn()} />);
    const groups = Array.from(container.querySelectorAll("optgroup"));

    expect(groups.map((g) => g.getAttribute("label"))).toEqual([
      "Do something",
      "Control the flow",
    ]);

    const effectValues = Array.from(groups[0]!.querySelectorAll("option")).map(
      (o) => o.value,
    );
    expect(effectValues.every((v) => ACTION_CATALOG[v as never].kind === "effect")).toBe(
      true,
    );
  });

  it("surfaces the permission an action needs before it is added", async () => {
    const user = userEvent.setup();
    render(<ActionPicker onAdd={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("Add a step"), "http_request");

    // Read from the catalogue, not hardcoded in the assertion.
    expect(
      screen.getByText(ACTION_CATALOG.http_request.permission!, { exact: false }),
    ).toBeInTheDocument();
  });

  it("adds the chosen action and reports it to the caller", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<ActionPicker onAdd={onAdd} />);

    await user.selectOptions(screen.getByLabelText("Add a step"), "send_email");
    await user.click(screen.getByRole("button", { name: /Add send an email/i }));

    expect(onAdd).toHaveBeenCalledWith("send_email");
  });

  it("keeps a blocked action visible and disabled rather than hiding it", () => {
    render(
      <ActionPicker
        onAdd={vi.fn()}
        unavailable={{ iterator: "Too deeply nested to loop here." }}
      />,
    );

    const option = within(screen.getByLabelText("Add a step")).getByRole("option", {
      name: /For each/i,
    }) as HTMLOptionElement;

    expect(option.value).toBe("iterator");
    expect(option).toBeDisabled();
  });
});

describe("Trigger picker — driven by the engine's catalogue", () => {
  it("offers exactly the triggers the engine has", () => {
    renderBuilder();

    const values = within(screen.getByLabelText("Trigger"))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    expect([...values].sort()).toEqual([...TRIGGER_TYPES].sort());
  });

  it("describes each trigger from TRIGGER_CATALOG", () => {
    renderBuilder();
    expect(
      screen.getByText(TRIGGER_CATALOG.record_updated.description, { exact: false }),
    ).toBeInTheDocument();
  });
});

/* ================================================================== */
/* 2. VALIDATION IS THE ENGINE'S, AND IT IS RENDERED                   */
/* ================================================================== */

describe("Validation — the engine's own validator, shown inline", () => {
  it("renders the error the engine reports for an empty workflow", () => {
    renderBuilder(makeVersion({ steps: [] }));

    // The engine's verdict, computed independently in the test.
    const verdict = validateDefinition({
      triggerType: "record_updated",
      triggerConfig: { recordType: "lead", watchFields: ["status"] },
      program: { steps: [] },
      stepBudget: 100,
    });
    expect(verdict.ok).toBe(false);

    for (const problem of verdict.errors) {
      expect(screen.getAllByText(problem.message, { exact: false }).length).toBeGreaterThan(
        0,
      );
    }
  });

  it("renders a step-level error next to the step that caused it", () => {
    const steps: WorkflowStep[] = [
      { key: "guard", action: "filter", conditions: { match: "all", conditions: [] } },
    ];
    renderBuilder(makeVersion({ steps }));

    // `filter_empty` — a filter with no conditions stops nothing.
    expect(
      screen.getAllByText(/This filter has no conditions/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/\[filter_empty\]/).length).toBeGreaterThan(0);
  });

  it("marks errors with role=alert and warnings without it", () => {
    const steps: WorkflowStep[] = [
      { key: "guard", action: "filter", conditions: { match: "all", conditions: [] } },
    ];
    renderBuilder(
      makeVersion({
        steps,
        // No watchFields → the engine emits `trigger_unscoped_update`, a
        // WARNING, which must not shout.
        triggerConfig: { recordType: "lead" },
      }),
    );

    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((node) => /filter has no conditions/i.test(node.textContent ?? ""))).toBe(
      true,
    );
    expect(
      alerts.some((node) => /runs on ANY change to the record/i.test(node.textContent ?? "")),
    ).toBe(false);

    // …but the warning IS on screen.
    expect(
      screen.getAllByText(/runs on ANY change to the record/i).length,
    ).toBeGreaterThan(0);
  });

  it("re-validates as the definition changes, without a round trip", async () => {
    const user = userEvent.setup();
    renderBuilder(makeVersion({ steps: [] }));

    expect(screen.getAllByText(/This workflow does nothing/i).length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByLabelText("Add a step"), "delay");
    await user.click(screen.getByRole("button", { name: /Add wait/i }));

    expect(screen.queryByText(/This workflow does nothing/i)).not.toBeInTheDocument();
  });

  it("blocks the publish button while the engine reports an error", () => {
    renderBuilder(makeVersion({ steps: [] }));
    expect(screen.getByRole("button", { name: /^Publish…$/ })).toBeDisabled();
  });
});

/* ================================================================== */
/* 3. ⭐ THE PUBLISH DIALOG STATES THE IDENTITY DELEGATION             */
/* ================================================================== */

describe("Publish dialog — the delegation is stated, not buried", () => {
  const cleanValidation = { ok: true, errors: [], warnings: [] };

  function renderDialog(props: Partial<React.ComponentProps<typeof PublishDialog>> = {}) {
    const onConfirm = vi.fn();
    render(
      <PublishDialog
        open
        onOpenChange={vi.fn()}
        versionNumber={4}
        workflowName="Nightly follow-up sweep"
        triggerType="scheduled"
        validation={cleanValidation}
        summary="Ready to publish."
        requiredPermissions={["leads:update", "workflows:send_email"]}
        publisherLabel="Asha Rao (asha@ordence.example)"
        onConfirm={onConfirm}
        {...props}
      />,
    );
    return { onConfirm };
  }

  it("says plainly that publishing lends the publisher's identity to every future unattended run", () => {
    renderDialog();

    expect(
      screen.getByText(
        /Publishing lends your identity to every future unattended run/i,
      ),
    ).toBeInTheDocument();
  });

  it("names the publisher and says the runs act as them", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText(/Asha Rao \(asha@ordence\.example\)/).length)
      .toBeGreaterThan(0);
    expect(
      within(dialog).getByText(/with your permissions, on\s+your behalf/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /It can do anything you can do, to any record you can reach/i,
      ),
    ).toBeInTheDocument();
  });

  it("requires an explicit acknowledgement before it will publish", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    const publish = screen.getByRole("button", {
      name: /Publish and delegate my permissions/i,
    });
    expect(publish).toBeDisabled();

    await user.click(
      screen.getByLabelText(/act with my permissions when it runs\s+unattended/i),
    );

    expect(publish).toBeEnabled();
    await user.click(publish);
    expect(onConfirm).toHaveBeenCalledWith({ acceptWarnings: false });
  });

  it("lists the permissions the publisher must personally hold", () => {
    renderDialog();

    expect(
      screen.getByText(/You must personally hold these permissions/i),
    ).toBeInTheDocument();
    expect(screen.getByText("workflows:send_email")).toBeInTheDocument();
    expect(screen.getByText("leads:update")).toBeInTheDocument();
    expect(
      screen.getByText(/An automation can never do more than the person who published it/i),
    ).toBeInTheDocument();
  });

  it("refuses to publish while the engine reports an error, whatever is ticked", () => {
    renderDialog({
      validation: {
        ok: false,
        errors: [
          {
            code: "program_empty",
            where: "program",
            message: "This workflow does nothing.",
            remedy: "Add at least one action.",
          },
        ],
        warnings: [],
      },
      summary: "1 problem must be fixed first.",
    });

    expect(screen.getByText(/This cannot be published yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Publish and delegate my permissions/i }),
    ).toBeDisabled();
  });

  it("makes accepting warnings a second, separate decision", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      validation: {
        ok: true,
        errors: [],
        warnings: [
          {
            code: "trigger_unscoped_update",
            where: "trigger",
            message: "This runs on ANY change to the record, including its own.",
            remedy: "Name the fields you care about.",
          },
        ],
      },
      summary: "Ready to publish, with 1 warning.",
    });

    const publish = screen.getByRole("button", {
      name: /Publish and delegate my permissions/i,
    });

    await user.click(
      screen.getByLabelText(/act with my permissions when it runs\s+unattended/i),
    );
    // Acknowledged, but the warning has not been accepted.
    expect(publish).toBeDisabled();

    await user.click(screen.getByLabelText(/want to publish\s+anyway/i));
    expect(publish).toBeEnabled();

    await user.click(publish);
    expect(onConfirm).toHaveBeenCalledWith({ acceptWarnings: true });
  });

  it("sets acknowledgeRunsAsMe when the builder publishes", async () => {
    const user = userEvent.setup();
    const steps: WorkflowStep[] = [{ key: "hold", action: "delay", seconds: 60 }];
    const { onPublish } = renderBuilder(makeVersion({ steps }));

    await user.click(screen.getByRole("button", { name: /^Publish…$/ }));
    await user.click(
      screen.getByLabelText(/act with my permissions when it runs\s+unattended/i),
    );
    await user.click(
      screen.getByRole("button", { name: /Publish and delegate my permissions/i }),
    );

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![0]).toMatchObject({ acknowledgeRunsAsMe: true });
  });
});

/* ================================================================== */
/* 4. THE LIMITS ARE SHOWN BEFORE THEY ARE HIT                         */
/* ================================================================== */

describe("Limits — visible while there is still room", () => {
  it("shows the step, depth and budget ceilings with the engine's numbers", () => {
    renderBuilder();

    const stepMeter = screen.getByRole("meter", { name: /Steps in this workflow/i });
    expect(stepMeter).toHaveAttribute("aria-valuemax", String(MAX_STEPS_PER_DEFINITION));

    const depthMeter = screen.getByRole("meter", { name: /Nesting depth/i });
    expect(depthMeter).toHaveAttribute("aria-valuemax", String(MAX_NESTING_DEPTH));

    expect(
      screen.getByText(new RegExp(MAX_ITERATIONS_PER_LOOP.toLocaleString("en-IN"))),
    ).toBeInTheDocument();
  });

  it("counts up as steps are added, so the ceiling is approached visibly", async () => {
    const user = userEvent.setup();
    renderBuilder(makeVersion({ steps: [] }));

    expect(screen.getByRole("meter", { name: /Steps in this workflow/i })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );

    await user.selectOptions(screen.getByLabelText("Add a step"), "delay");
    await user.click(screen.getByRole("button", { name: /Add wait/i }));

    expect(screen.getByRole("meter", { name: /Steps in this workflow/i })).toHaveAttribute(
      "aria-valuenow",
      "1",
    );
  });

  it("states the limit in words as well as in a bar, so it is not colour-only", () => {
    const steps: WorkflowStep[] = Array.from({ length: 95 }, (_, i) => ({
      key: `wait_${i}`,
      action: "delay" as const,
      seconds: 60,
    }));
    renderBuilder(makeVersion({ steps }));

    expect(screen.getByText(/close to the limit/i)).toBeInTheDocument();
  });
});

/* ================================================================== */
/* 5. REORDERING IS NOT DRAG-ONLY                                      */
/* ================================================================== */

describe("Reordering — a keyboard can do everything a mouse can", () => {
  const steps: WorkflowStep[] = [
    { key: "first", action: "delay", seconds: 60 },
    { key: "second", action: "delay", seconds: 120 },
  ];

  it("gives every step real Move up / Move down buttons", () => {
    renderBuilder(makeVersion({ steps }));

    expect(screen.getByRole("button", { name: /Move step 1, Wait, down/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Move step 2, Wait, up/i })).toBeEnabled();
    // The ends are disabled rather than absent, so focus order is stable.
    expect(screen.getByRole("button", { name: /Move step 1, Wait, up/i })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Move step 2, Wait, down/i }),
    ).toBeDisabled();
  });

  it("actually reorders when the button is pressed", async () => {
    const user = userEvent.setup();
    renderBuilder(makeVersion({ steps }));

    const keysBefore = screen
      .getAllByLabelText(/^Step key$/)
      .map((input) => (input as HTMLInputElement).value);
    expect(keysBefore).toEqual(["first", "second"]);

    await user.click(screen.getByRole("button", { name: /Move step 1, Wait, down/i }));

    const keysAfter = screen
      .getAllByLabelText(/^Step key$/)
      .map((input) => (input as HTMLInputElement).value);
    expect(keysAfter).toEqual(["second", "first"]);
  });

  it("removes a step through a labelled button", async () => {
    const user = userEvent.setup();
    renderBuilder(makeVersion({ steps }));

    await user.click(screen.getByRole("button", { name: /Remove step 1, Wait/i }));

    const keys = screen
      .getAllByLabelText(/^Step key$/)
      .map((input) => (input as HTMLInputElement).value);
    expect(keys).toEqual(["second"]);
  });
});

/* ================================================================== */
/* 6. THE READ-ONLY RULE FOR A LIVE VERSION                            */
/* ================================================================== */

describe("An active version is read-only, and says why", () => {
  it("explains the cursor problem instead of just disabling the form", () => {
    renderBuilder(
      makeVersion({
        status: "active",
        steps: [{ key: "hold", action: "delay", seconds: 60 }],
      }),
    );

    expect(screen.getByText(/cannot be edited/i)).toBeInTheDocument();
    expect(
      screen.getByText(/holding a position in this step\s+list/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save as a new draft/i }),
    ).toBeInTheDocument();
  });

  it("omits the add-step picker entirely on a version that cannot be edited", () => {
    renderBuilder(
      makeVersion({
        status: "archived",
        steps: [{ key: "hold", action: "delay", seconds: 60 }],
      }),
    );

    expect(screen.queryByLabelText("Add a step")).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* 7. SAVING PASSES THE ENGINE'S SHAPE, NOT A UI SHAPE                 */
/* ================================================================== */

describe("Saving a draft", () => {
  it("sends the trigger, the config and the program the engine expects", async () => {
    const user = userEvent.setup();
    const version = makeVersion({
      steps: [{ key: "hold", action: "delay", seconds: 90 }],
    });
    const { onSaveDraft } = renderBuilder(version);

    await user.click(screen.getByRole("button", { name: /^Save draft$/ }));

    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    expect(onSaveDraft.mock.calls[0]![0]).toMatchObject({
      workflowId: "22222222-2222-4222-8222-222222222222",
      versionId: version.id,
      triggerType: "record_updated",
      program: { steps: [{ key: "hold", action: "delay", seconds: 90 }] },
      stepBudget: 100,
    });
  });

  it("omits the version id on a non-draft, so the server branches a new draft", async () => {
    const user = userEvent.setup();
    const { onSaveDraft } = renderBuilder(
      makeVersion({
        status: "active",
        steps: [{ key: "hold", action: "delay", seconds: 60 }],
      }),
    );

    await user.click(screen.getByRole("button", { name: /Save as a new draft/i }));

    expect(onSaveDraft.mock.calls[0]![0]).toMatchObject({ versionId: undefined });
  });
});

/* ================================================================== */
/* 8. THE PURE STEP-TREE MODEL                                         */
/* ================================================================== */

describe("Step tree — the editing arithmetic", () => {
  const leaf = (key: string): WorkflowStep => ({ key, action: "delay", seconds: 60 });

  it("inserts, removes and moves inside a nested branch without touching siblings", () => {
    let steps: WorkflowStep[] = [
      {
        key: "branch",
        action: "if_else",
        conditions: { match: "all", conditions: [] },
        then: [leaf("a"), leaf("b")],
        otherwise: [leaf("z")],
      },
    ];

    const thenPath = [{ index: 0, slot: "then" as const }];

    steps = insertStep(steps, thenPath, 1, leaf("mid"));
    expect(branchKeys(steps, "then")).toEqual(["a", "mid", "b"]);
    expect(branchKeys(steps, "otherwise")).toEqual(["z"]);

    steps = moveStep(steps, thenPath, 2, -1);
    expect(branchKeys(steps, "then")).toEqual(["a", "b", "mid"]);

    steps = removeStep(steps, thenPath, 0);
    expect(branchKeys(steps, "then")).toEqual(["b", "mid"]);
    expect(branchKeys(steps, "otherwise")).toEqual(["z"]);
  });

  it("refuses to move a step off either end rather than wrapping", () => {
    const steps = [leaf("a"), leaf("b")];
    expect(moveStep(steps, ROOT, 0, -1)).toEqual(steps);
    expect(moveStep(steps, ROOT, 1, 1)).toEqual(steps);
  });

  it("counts nested steps the way the validator counts them", () => {
    const steps: WorkflowStep[] = [
      {
        key: "loop",
        action: "iterator",
        source: "steps.find.records",
        body: [leaf("a"), leaf("b")],
      },
      leaf("c"),
    ];
    expect(countSteps(steps)).toBe(4);
    expect(definitionDepth(steps)).toBe(2);
  });

  it("agrees with the validator about when nesting is too deep", () => {
    // Build a chain of loops exactly one level past the limit.
    let inner: WorkflowStep = leaf("bottom");
    for (let i = 0; i < MAX_NESTING_DEPTH; i += 1) {
      inner = {
        key: `loop_${i}`,
        action: "iterator",
        source: "steps.find.records",
        body: [inner],
      };
    }
    const steps = [inner];

    expect(definitionDepth(steps)).toBeGreaterThan(MAX_NESTING_DEPTH);
    const verdict = validateDefinition({
      triggerType: "manual",
      triggerConfig: {},
      program: { steps },
    });
    expect(verdict.errors.some((e) => e.code === "nesting_too_deep")).toBe(true);
  });

  it("never suggests a key that is already taken, at any depth", () => {
    const steps: WorkflowStep[] = [
      {
        key: "delay",
        action: "if_else",
        conditions: { match: "all", conditions: [] },
        then: [{ key: "delay_2", action: "delay", seconds: 5 }],
        otherwise: [],
      },
    ];
    const taken = ["delay", "delay_2"];
    expect(suggestKey("delay", taken)).toBe("delay_3");
    expect(countSteps(steps)).toBe(2);
  });

  it("creates steps the engine's own schema recognises", () => {
    for (const action of ACTION_TYPES) {
      const step = createStep(action, "a_step");
      expect(step.action).toBe(action);
      expect(step.key).toBe("a_step");
    }
  });

  it("only offers bindings that are already in scope", () => {
    const steps: WorkflowStep[] = [
      { key: "find_leads", action: "find_records", recordType: "lead" },
      { key: "later", action: "delay", seconds: 5 },
    ];

    const atFirst = bindingSuggestions({
      steps,
      path: ROOT,
      index: 0,
      triggerType: "manual",
      triggerConfig: {},
    }).map((s) => s.path);

    // Nothing from a step that has not run yet.
    expect(atFirst).not.toContain("steps.find_leads.records");

    const atSecond = bindingSuggestions({
      steps,
      path: ROOT,
      index: 1,
      triggerType: "manual",
      triggerConfig: {},
    }).map((s) => s.path);

    expect(atSecond).toContain("steps.find_leads.records");
    expect(atSecond).toContain("steps.find_leads.count");
  });

  it("offers the loop alias inside a loop body and not outside it", () => {
    const steps: WorkflowStep[] = [
      {
        key: "each_lead",
        action: "iterator",
        source: "steps.find_leads.records",
        itemAlias: "lead",
        body: [{ key: "inner", action: "delay", seconds: 5 }],
      },
    ];

    const inside = bindingSuggestions({
      steps,
      path: [{ index: 0, slot: "body" }],
      index: 0,
      triggerType: "manual",
      triggerConfig: {},
    }).map((s) => s.path);

    expect(inside).toContain("lead");
    expect(inside).toContain("item");

    const outside = bindingSuggestions({
      steps,
      path: ROOT,
      index: 0,
      triggerType: "manual",
      triggerConfig: {},
    }).map((s) => s.path);

    expect(outside).not.toContain("lead");
  });

  it("derives required permissions from the catalogues, not from a local list", () => {
    const steps: WorkflowStep[] = [
      { key: "mail", action: "send_email", to: "a@b.c", subject: "hi", body: "" },
      {
        key: "kill",
        action: "delete_record",
        recordType: "lead",
        recordId: "{{ trigger.record.id }}",
      },
    ];

    const required = requiredPermissionsFor(steps);
    expect(required).toContain(ACTION_CATALOG.send_email.permission);
    expect(required).toContain("leads:delete");
    // A pure control step contributes nothing.
    expect(requiredPermissionsFor([{ key: "w", action: "delay", seconds: 1 }])).toEqual(
      [],
    );
  });
});

/* ================================================================== */
/* 9. STATUS IS THREE FACTS, NOT ONE                                   */
/* ================================================================== */

describe("Workflow state", () => {
  it("distinguishes a published-but-switched-off workflow from a draft", () => {
    expect(
      workflowState({ archivedAt: null, isEnabled: true, activeVersion: 2 }),
    ).toBe("active");
    expect(
      workflowState({ archivedAt: null, isEnabled: false, activeVersion: 2 }),
    ).toBe("paused");
    expect(
      workflowState({ archivedAt: null, isEnabled: true, activeVersion: null }),
    ).toBe("draft");
    expect(
      workflowState({ archivedAt: "2026-01-01", isEnabled: true, activeVersion: 2 }),
    ).toBe("archived");
  });
});

/* ------------------------------------------------------------------ */

function branchKeys(steps: WorkflowStep[], slot: "then" | "otherwise"): string[] {
  const first = steps[0];
  if (!first || first.action !== "if_else") return [];
  return (slot === "then" ? first.then : first.otherwise).map((s) => s.key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* A drag is still supported; it is simply not the only path. */
describe("Drag and drop remains available alongside the buttons", () => {
  it("reorders on drop within the same list", () => {
    renderBuilder(
      makeVersion({
        steps: [
          { key: "first", action: "delay", seconds: 60 },
          { key: "second", action: "delay", seconds: 120 },
        ],
      }),
    );

    const items = screen.getAllByRole("listitem");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      effectAllowed: "move",
    };

    fireEvent.dragStart(items[0]!, { dataTransfer });
    fireEvent.dragOver(items[1]!, { dataTransfer });
    fireEvent.drop(items[1]!, { dataTransfer });

    const keys = screen
      .getAllByLabelText(/^Step key$/)
      .map((input) => (input as HTMLInputElement).value);
    expect(keys).toEqual(["second", "first"]);
  });
});
