"use client";

/**
 * Ordence — New Asset Form
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS FORM IS HALF HAND-WRITTEN AND HALF GENERATED
 * ══════════════════════════════════════════════════════════════════════
 * The "Basics", "Value & size" and "Location" sections are ordinary JSX,
 * because every asset in every industry has a name, a type and a status.
 *
 * The "Details" section is not written at all. It is produced by
 * `DynamicFieldSet` from the `fields` prop — rows out of
 * `custom_field_definitions`. A real-estate tenant gets carpet area
 * (number), facing (select), possession date (date) and RERA registered
 * (checkbox). A law firm gets case number (text), court (select), next
 * hearing (date) and claim value (currency). Same component, same build,
 * zero migrations between them.
 *
 * That is the whole point of the custom object engine, and this form is
 * where it becomes visible: adding a field to a tenant's workspace changes
 * this screen without anyone deploying anything.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  TextField,
  TextareaField,
  SelectField,
  DynamicFieldSet,
  type DynamicFieldSpec,
  type SelectOption,
} from "@/components/forms/form-fields";
import {
  FormShell,
  FormError,
  FormSection,
  FormActions,
  useActionForm,
} from "@/components/forms/form-shell";
import { createAssetSchema } from "@/lib/validators/assets";
import { createAsset } from "@/server/actions/assets";

const STATUS_OPTIONS: SelectOption[] = [
  { value: "draft", label: "Draft" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In progress" },
  { value: "available", label: "Available" },
  { value: "reserved", label: "Reserved" },
  { value: "under_offer", label: "Under offer" },
  { value: "occupied", label: "Occupied" },
  { value: "sold", label: "Sold" },
  { value: "leased", label: "Leased" },
  { value: "maintenance", label: "Maintenance" },
  { value: "inactive", label: "Inactive" },
  { value: "archived", label: "Archived" },
];

const AREA_UNIT_OPTIONS: SelectOption[] = [
  { value: "sqft", label: "Square feet" },
  { value: "sqm", label: "Square metres" },
  { value: "sqyd", label: "Square yards" },
  { value: "acre", label: "Acres" },
  { value: "guntha", label: "Guntha" },
  { value: "cent", label: "Cents" },
];

export function AssetForm({
  fields,
  assetTypeOptions,
}: {
  /** Field definitions from the tenant's workspace. Drives the Details section. */
  fields: DynamicFieldSpec[];
  /** Asset types this industry actually uses, so the list is not 20 items long. */
  assetTypeOptions: SelectOption[];
}) {
  const router = useRouter();

  const { form, submit, isPending, serverError } = useActionForm({
    schema: createAssetSchema,
    action: createAsset,
    successMessage: "Asset created.",
    defaultValues: {
      name: "",
      assetType: assetTypeOptions[0]?.value ?? "custom",
      status: "draft",
      currency: "INR",
      areaUnit: "sqft",
      quantity: 1,
      dynamicAttributes: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    onSuccess: (asset) => {
      router.push(`/assets?created=${asset.id}`);
    },
  });

  const { register, formState } = form;
  const errors = formState.errors;

  return (
    <FormShell onSubmit={submit}>
      <FormError message={serverError} />

      {/* ── FIXED HALF ────────────────────────────────────────────── */}
      <FormSection title="Basics" description="Fields every asset has, whatever the industry.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="name"
            label="Name"
            required
            placeholder="Tower A — Unit 304"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="code"
            label="Reference code"
            placeholder="BSVN-TWR-A-U304"
            help="Your own numbering. Shown in listings and documents."
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <SelectField
            name="assetType"
            label="Type"
            required
            choices={assetTypeOptions}
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <SelectField
            name="status"
            label="Status"
            choices={STATUS_OPTIONS}
            register={register}
            errors={errors}
            disabled={isPending}
          />
        </div>

        <TextareaField
          name="description"
          label="Description"
          rows={3}
          register={register}
          errors={errors}
          disabled={isPending}
        />
      </FormSection>

      <FormSection title="Value & size">
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            name="valueAmount"
            label="Value"
            placeholder="4500000.00"
            help="Stored exactly. Money is never held as a floating-point number here."
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="areaValue"
            label="Area"
            placeholder="1240.00"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <SelectField
            name="areaUnit"
            label="Area unit"
            choices={AREA_UNIT_OPTIONS}
            help="Never assumed — a plot in guntha and a flat in sq ft are both normal."
            register={register}
            errors={errors}
            disabled={isPending}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            name="quantity"
            label="Quantity"
            type="number"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="acquiredDate"
            label="Acquired on"
            type="date"
            register={register}
            errors={errors}
            disabled={isPending}
          />
          <TextField
            name="commissionedDate"
            label="Commissioned on"
            type="date"
            register={register}
            errors={errors}
            disabled={isPending}
          />
        </div>
      </FormSection>

      <FormSection title="Location">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="addressLine1" label="Address line 1" register={register} errors={errors} disabled={isPending} />
          <TextField name="addressLine2" label="Address line 2" register={register} errors={errors} disabled={isPending} />
          <TextField name="locality" label="Locality" placeholder="Basaveshwar Nagar" register={register} errors={errors} disabled={isPending} />
          <TextField name="city" label="City" placeholder="Bengaluru" register={register} errors={errors} disabled={isPending} />
          <TextField name="state" label="State" placeholder="Karnataka" register={register} errors={errors} disabled={isPending} />
          <TextField name="postalCode" label="PIN code" placeholder="560079" register={register} errors={errors} disabled={isPending} />
        </div>
      </FormSection>

      {/* ── VARIABLE HALF — GENERATED, NOT WRITTEN ────────────────── */}
      {fields.length > 0 && (
        <FormSection
          title="Details"
          description="These fields are defined by your workspace. Change them in Settings and this section changes with them — no deployment needed."
        >
          <DynamicFieldSet
            fields={fields}
            prefix="dynamicAttributes"
            register={register}
            errors={errors}
            disabled={isPending}
            columns={2}
          />
        </FormSection>
      )}

      <FormActions
        isPending={isPending}
        submitLabel="Create asset"
        pendingLabel="Creating…"
        onCancel={() => router.push("/assets")}
      />
    </FormShell>
  );
}
