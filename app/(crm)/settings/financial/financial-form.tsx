"use client";

/**
 * Ordence — Financial Settings Form
 * Version: v0.7.0-alpha
 */

import * as React from "react";
import { z } from "zod";
import {
  TextField,
  SelectField,
  CheckboxField,
  type SelectOption,
} from "@/components/forms/form-fields";
import {
  FormShell,
  FormError,
  FormSection,
  FormActions,
  useActionForm,
} from "@/components/forms/form-shell";
import { updateFinancialSettings } from "@/server/actions/settings";

/** Mirrors `financialSchema` on the server, which remains the deciding copy. */
const clientFinancialSchema = z.object({
  currency: z.string().trim().length(3, "Use a 3-letter code such as INR."),
  country: z.string().trim().length(2, "Use a 2-letter code such as IN."),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  requireMfa: z.coerce.boolean(),
  sessionIdleMinutes: z.coerce.number().int().min(5).max(1440),
});

const CURRENCIES: SelectOption[] = [
  { value: "INR", label: "Indian Rupee (INR)" },
  { value: "USD", label: "US Dollar (USD)" },
  { value: "AED", label: "UAE Dirham (AED)" },
  { value: "GBP", label: "Pound Sterling (GBP)" },
  { value: "EUR", label: "Euro (EUR)" },
  { value: "SGD", label: "Singapore Dollar (SGD)" },
];

const MONTHS: SelectOption[] = [
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April — Indian fiscal year" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];

export function FinancialSettingsForm({
  defaults,
  canEdit,
}: {
  defaults: {
    currency: string;
    country: string;
    fiscalYearStartMonth: string;
    requireMfa: boolean;
    sessionIdleMinutes: string;
  };
  canEdit: boolean;
}) {
  const { form, submit, isPending, serverError } = useActionForm({
    schema: clientFinancialSchema,
    action: updateFinancialSettings,
    successMessage: "Financial settings saved.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defaultValues: defaults as any,
  });

  const { register, formState } = form;
  const errors = formState.errors;

  return (
    <FormShell onSubmit={submit}>
      <FormError message={serverError} />

      {!canEdit && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Your role does not include permission to change these settings.
        </p>
      )}

      <FormSection
        title="Currency & fiscal year"
        description="These are defaults for new records. Existing entries keep the currency they were posted in."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            name="currency"
            label="Default currency"
            choices={CURRENCIES}
            register={register}
            errors={errors}
            disabled={isPending || !canEdit}
          />
          <TextField
            name="country"
            label="Country code"
            help="Two letters, ISO 3166-1 — used for tax and address defaults."
            register={register}
            errors={errors}
            disabled={isPending || !canEdit}
          />
          <SelectField
            name="fiscalYearStartMonth"
            label="Fiscal year starts"
            choices={MONTHS}
            help="Drives period naming and year-end reporting. India runs April to March."
            register={register}
            errors={errors}
            disabled={isPending || !canEdit}
          />
        </div>

        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Changing the currency does <strong>not</strong> convert anything. Amounts
          already posted keep the currency they were recorded in — a ledger that
          silently re-denominated its history would be worse than useless.
        </p>
      </FormSection>

      <FormSection title="Access controls">
        <CheckboxField
          name="requireMfa"
          label="Require multi-factor authentication for everyone"
          help="Enforced by your identity provider at sign-in. Strongly recommended for any workspace holding client money."
          register={register}
          errors={errors}
          disabled={isPending || !canEdit}
        />

        <TextField
          name="sessionIdleMinutes"
          label="Sign out after inactivity (minutes)"
          type="number"
          help="Between 5 and 1440. Shorter is safer on shared machines."
          register={register}
          errors={errors}
          disabled={isPending || !canEdit}
        />
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
