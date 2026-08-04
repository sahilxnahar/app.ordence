"use client";

/**
 * Ordence — Contact Form (create and edit)
 * Version: v0.7.0-alpha
 *
 * One component serves both routes. A create form and an edit form that
 * differ only in their default values and which action they call will drift
 * apart if written twice — a field added to one gets forgotten in the other,
 * and the bug surfaces as "editing wipes the value I just set".
 *
 * The `contact` prop decides the mode: absent means create, present means
 * edit.
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
import { createContactSchema, updateContactSchema } from "@/lib/validators/crm";
import { createContact, updateContact } from "@/server/actions/contacts";

export type ContactFormValues = {
  id?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  mobile: string;
  jobTitle: string;
  department: string;
  linkedinUrl: string;
  companyId: string;
  notes: string;
};

export function ContactForm({
  contact,
  companyOptions,
}: {
  /** Present means edit. Absent means create. */
  contact?: Partial<ContactFormValues> & { id: string };
  companyOptions: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const isEdit = Boolean(contact?.id);

  const choices: SelectOption[] = companyOptions.map((c) => ({
    value: c.id,
    label: c.name,
  }));

  const { form, submit, isPending, serverError } = useActionForm({
    schema: isEdit ? updateContactSchema : createContactSchema,
    action: (values) =>
      isEdit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? updateContact({ ...(values as any), id: contact!.id })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : createContact(values as any),
    successMessage: isEdit ? "Contact updated." : "Contact created.",
    defaultValues: {
      firstName: contact?.firstName ?? "",
      lastName: contact?.lastName ?? "",
      email: contact?.email ?? "",
      phone: contact?.phone ?? "",
      mobile: contact?.mobile ?? "",
      jobTitle: contact?.jobTitle ?? "",
      department: contact?.department ?? "",
      linkedinUrl: contact?.linkedinUrl ?? "",
      companyId: contact?.companyId ?? "",
      notes: contact?.notes ?? "",
      customFields: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    onSuccess: () => router.push("/contacts"),
  });

  const { register, formState } = form;
  const errors = formState.errors;

  return (
    <FormShell onSubmit={submit}>
      <FormError message={serverError} />

      <FormSection title="Who they are">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="firstName"
            label="First name"
            required
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="lastName"
            label="Last name"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="jobTitle"
            label="Job title"
            placeholder="Head of Projects"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="department"
            label="Department"
            register={register}
            errors={errors}
            disabled={isPending}
          />
        </div>

        <SelectField
          name="companyId"
          label="Company"
          choices={choices}
          placeholder={choices.length ? "No company" : "No companies yet"}
          help="A contact can stand alone — this is optional."
          register={register}
          errors={errors}
          disabled={isPending || choices.length === 0}
        />
      </FormSection>

      <FormSection title="How to reach them">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="email"
            label="Email"
            type="email"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="phone"
            label="Phone"
            type="tel"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="mobile"
            label="Mobile"
            type="tel"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="linkedinUrl"
            label="LinkedIn"
            type="url"
            placeholder="https://www.linkedin.com/in/…"
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
        submitLabel={isEdit ? "Save changes" : "Create contact"}
        pendingLabel="Saving…"
        onCancel={() => router.push("/contacts")}
      />
    </FormShell>
  );
}
