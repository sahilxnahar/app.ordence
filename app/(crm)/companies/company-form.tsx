"use client";

/**
 * Ordence — Company Form (create and edit)
 * Version: v0.7.0-alpha
 *
 * Same one-component-two-modes approach as `ContactForm`. See the note there.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  TextField,
  TextareaField,
  SelectField,
  type SelectOption,
} from "@/components/forms/form-fields";
import {
  FormShell,
  FormError,
  FormSection,
  FormActions,
  useActionForm,
} from "@/components/forms/form-shell";
import {
  createCompanySchema,
  updateCompanySchema,
  COMPANY_SIZES,
} from "@/lib/validators/crm";
import { createCompany, updateCompany } from "@/server/actions/companies";

const SIZE_CHOICES: SelectOption[] = COMPANY_SIZES.map((s) => ({
  value: s,
  label: `${s} employees`,
}));

export type CompanyFormValues = {
  id?: string;
  name: string;
  domain: string;
  industry: string;
  employeeCount: string;
  companySize: string;
  website: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  notes: string;
};

export function CompanyForm({
  company,
}: {
  /** Present means edit. Absent means create. */
  company?: Partial<CompanyFormValues> & { id: string };
}) {
  const router = useRouter();
  const isEdit = Boolean(company?.id);

  const { form, submit, isPending, serverError } = useActionForm({
    schema: isEdit ? updateCompanySchema : createCompanySchema,
    action: (values) =>
      isEdit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? updateCompany({ ...(values as any), id: company!.id })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : createCompany(values as any),
    successMessage: isEdit ? "Company updated." : "Company created.",
    defaultValues: {
      name: company?.name ?? "",
      domain: company?.domain ?? "",
      industry: company?.industry ?? "",
      employeeCount: company?.employeeCount ?? "",
      companySize: company?.companySize ?? "",
      website: company?.website ?? "",
      phone: company?.phone ?? "",
      addressLine1: company?.addressLine1 ?? "",
      addressLine2: company?.addressLine2 ?? "",
      city: company?.city ?? "",
      state: company?.state ?? "",
      postalCode: company?.postalCode ?? "",
      country: company?.country ?? "IN",
      notes: company?.notes ?? "",
      customFields: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    onSuccess: () => router.push("/companies"),
  });

  const { register, formState } = form;
  const errors = formState.errors;

  return (
    <FormShell onSubmit={submit}>
      <FormError message={serverError} />

      <FormSection title="Company">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="name"
            label="Name"
            required
            placeholder="Ordence Developers Pvt Ltd"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="domain"
            label="Domain"
            placeholder="ordence.com"
            help="Just the domain — no https:// and no trailing path."
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="industry"
            label="Industry"
            placeholder="Real estate development"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <SelectField
            name="companySize"
            label="Size"
            choices={SIZE_CHOICES}
            placeholder="Not specified"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="employeeCount"
            label="Employee count"
            type="number"
            help="Exact headcount, if you know it."
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="website"
            label="Website"
            type="url"
            placeholder="https://ordence.com"
            register={register}
            errors={errors}
            disabled={isPending}
          />
        </div>
      </FormSection>

      <FormSection title="Contact & address">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="phone" label="Phone" type="tel" register={register} errors={errors} disabled={isPending} />
          <TextField name="addressLine1" label="Address line 1" register={register} errors={errors} disabled={isPending} />
          <TextField name="addressLine2" label="Address line 2" register={register} errors={errors} disabled={isPending} />
          <TextField name="city" label="City" placeholder="Bengaluru" register={register} errors={errors} disabled={isPending} />
          <TextField name="state" label="State" placeholder="Karnataka" register={register} errors={errors} disabled={isPending} />
          <TextField name="postalCode" label="PIN code" placeholder="560079" register={register} errors={errors} disabled={isPending} />
          <TextField
            name="country"
            label="Country code"
            placeholder="IN"
            help="Two letters, ISO 3166-1."
            register={register}
            errors={errors}
            disabled={isPending}
          />
        </div>
      </FormSection>

      <FormSection title="Notes">
        <TextareaField
          name="notes"
          label="Internal notes"
          rows={4}
          help="Visible to your team only."
          register={register}
          errors={errors}
          disabled={isPending}
        />
      </FormSection>

      <FormActions
        isPending={isPending}
        submitLabel={isEdit ? "Save changes" : "Create company"}
        pendingLabel="Saving…"
        onCancel={() => router.push("/companies")}
      />
    </FormShell>
  );
}
