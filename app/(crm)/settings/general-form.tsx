"use client";

/**
 * Ordence — General Settings Form
 * Version: v0.7.0-alpha
 */

import * as React from "react";
import { TextField, SelectField, type SelectOption } from "@/components/forms/form-fields";
import {
  FormShell,
  FormError,
  FormSection,
  FormActions,
  useActionForm,
} from "@/components/forms/form-shell";
import { updateGeneralSettings } from "@/server/actions/settings";
import { z } from "zod";

/**
 * Mirrors `generalSchema` on the server. It is declared here rather than
 * imported because the server file is `"use server"` and may only export
 * async functions — the server re-validates with its own copy, which is the
 * one that decides what gets written.
 */
const clientGeneralSchema = z.object({
  name: z.string().trim().min(1, "Your workspace needs a name.").max(255),
  industry: z.string().min(1, "Choose an industry."),
  timezone: z.string().trim().min(1).max(64),
  locale: z.string().trim().min(2).max(10),
  dateFormat: z.enum(["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"]),
});

const TIMEZONES: SelectOption[] = [
  { value: "Asia/Kolkata", label: "India Standard Time (Asia/Kolkata)" },
  { value: "Asia/Dubai", label: "Gulf Standard Time (Asia/Dubai)" },
  { value: "Asia/Singapore", label: "Singapore (Asia/Singapore)" },
  { value: "Europe/London", label: "United Kingdom (Europe/London)" },
  { value: "America/New_York", label: "US Eastern (America/New_York)" },
  { value: "UTC", label: "Coordinated Universal Time (UTC)" },
];

const LOCALES: SelectOption[] = [
  { value: "en-IN", label: "English (India)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "en-US", label: "English (United States)" },
];

const DATE_FORMATS: SelectOption[] = [
  { value: "dd/MM/yyyy", label: "31/07/2026 — day first" },
  { value: "MM/dd/yyyy", label: "07/31/2026 — month first" },
  { value: "yyyy-MM-dd", label: "2026-07-31 — ISO" },
];

export function GeneralSettingsForm({
  defaults,
  industryChoices,
  canEdit,
}: {
  defaults: {
    name: string;
    industry: string;
    timezone: string;
    locale: string;
    dateFormat: string;
  };
  industryChoices: SelectOption[];
  canEdit: boolean;
}) {
  const { form, submit, isPending, serverError } = useActionForm({
    schema: clientGeneralSchema,
    action: updateGeneralSettings,
    successMessage: "Settings saved.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defaultValues: defaults as any,
  });

  const { register, watch, formState } = form;
  const errors = formState.errors;

  const selectedIndustry = watch("industry");
  const industryChanged = selectedIndustry !== defaults.industry;

  return (
    <FormShell onSubmit={submit}>
      <FormError message={serverError} />

      {!canEdit && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Your role does not include permission to change workspace settings.
        </p>
      )}

      <FormSection title="Workspace">
        <TextField
          name="name"
          label="Workspace name"
          required
          register={register}
          errors={errors}
          disabled={isPending || !canEdit}
        />

        <SelectField
          name="industry"
          label="Industry"
          required
          choices={industryChoices}
          help="Decides your navigation, dashboard widgets and the words the product uses."
          register={register}
          errors={errors}
          disabled={isPending || !canEdit}
        />

        {industryChanged && (
          <div
            role="alert"
            className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
          >
            <p className="font-medium text-amber-700 dark:text-amber-400">
              This changes how the whole workspace looks.
            </p>
            <p className="mt-1 text-muted-foreground">
              Your navigation, dashboard and terminology will all change on the next
              page load. <strong>No records are deleted or moved</strong> — the same
              data is simply presented in the language of the new industry. You can
              change it back at any time.
            </p>
          </div>
        )}
      </FormSection>

      <FormSection title="Regional">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            name="timezone"
            label="Timezone"
            choices={TIMEZONES}
            help="Used for timestamps and period boundaries."
            register={register}
            errors={errors}
            disabled={isPending || !canEdit}
          />
          <SelectField
            name="locale"
            label="Language & formatting"
            choices={LOCALES}
            register={register}
            errors={errors}
            disabled={isPending || !canEdit}
          />
          <SelectField
            name="dateFormat"
            label="Date format"
            choices={DATE_FORMATS}
            register={register}
            errors={errors}
            disabled={isPending || !canEdit}
          />
        </div>
      </FormSection>

      <FormActions
        isPending={isPending}
        submitLabel="Save settings"
        pendingLabel="Saving…"
        canSubmit={canEdit}
        blockedReason={canEdit ? undefined : "You do not have permission to change these."}
      />
    </FormShell>
  );
}
