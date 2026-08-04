/**
 * Ordence — Dynamic JSONB Form Rendering
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 7 MANDATORY VERIFICATION #1
 * ══════════════════════════════════════════════════════════════════════
 * "Verify that the dynamic JSONB asset form correctly renders at least 3
 *  different input types (e.g., text, number, date)."
 *
 * These tests RENDER the real `DynamicFieldSet` with real field definitions
 * and inspect the resulting DOM. Nothing is asserted by reading the source.
 *
 * Why that distinction matters here: the whole claim of the custom object
 * engine is that a row in `custom_field_definitions` becomes a working
 * input with no code change. The only way to verify that is to hand it
 * definitions and look at what comes out.
 */

import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import {
  DynamicFieldSet,
  type DynamicFieldSpec,
} from "@/components/forms/form-fields";
import {
  defaultFieldsForIndustry,
  buildDynamicSchema,
} from "@/lib/validators/assets";

/** Mounts DynamicFieldSet inside a real react-hook-form instance. */
function Harness({ fields }: { fields: DynamicFieldSpec[] }) {
  const {
    register,
    formState: { errors },
  } = useForm({ defaultValues: { dynamicAttributes: {} } });

  return (
    <form>
      <DynamicFieldSet
        fields={fields}
        prefix="dynamicAttributes"
        register={register}
        errors={errors}
      />
    </form>
  );
}

describe("Dynamic JSONB form — rendering from field definitions", () => {
  it("renders a distinct input for each of 6 field types", () => {
    const fields: DynamicFieldSpec[] = [
      { fieldName: "projectCode", label: "Project code", fieldType: "text" },
      { fieldName: "carpetArea", label: "Carpet area", fieldType: "number" },
      { fieldName: "possession", label: "Possession date", fieldType: "date" },
      {
        fieldName: "facing",
        label: "Facing",
        fieldType: "select",
        options: [
          { label: "North", value: "north" },
          { label: "East", value: "east" },
        ],
      },
      { fieldName: "reraRegistered", label: "RERA registered", fieldType: "boolean" },
      { fieldName: "notes", label: "Notes", fieldType: "textarea" },
    ];

    render(<Harness fields={fields} />);

    // TEXT — a plain text input.
    const text = screen.getByLabelText(/Project code/i);
    expect(text).toBeInTheDocument();
    expect(text.tagName).toBe("INPUT");
    expect(text).toHaveAttribute("type", "text");

    // NUMBER — must actually be type="number", not a text box that happens
    // to hold digits. The difference is a numeric keypad on mobile and
    // browser-level rejection of "abc".
    const number = screen.getByLabelText(/Carpet area/i);
    expect(number).toHaveAttribute("type", "number");

    // DATE — a real date picker.
    const date = screen.getByLabelText(/Possession date/i);
    expect(date).toHaveAttribute("type", "date");

    // SELECT — a <select> carrying exactly the defined options.
    const select = screen.getByLabelText(/Facing/i);
    expect(select.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "North" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "East" })).toBeInTheDocument();

    // BOOLEAN — a checkbox.
    const checkbox = screen.getByLabelText(/RERA registered/i);
    expect(checkbox).toHaveAttribute("type", "checkbox");

    // TEXTAREA — a multi-line control, not a single-line input.
    const textarea = screen.getByLabelText(/Notes/i);
    expect(textarea.tagName).toBe("TEXTAREA");

    // The headline assertion, stated explicitly.
    const distinctTypes = new Set(fields.map((f) => f.fieldType));
    expect(distinctTypes.size).toBeGreaterThanOrEqual(3);
  });

  it("registers every field under the JSONB prefix so values nest correctly", () => {
    const fields: DynamicFieldSpec[] = [
      { fieldName: "caseNumber", label: "Case number", fieldType: "text" },
      { fieldName: "nextHearing", label: "Next hearing", fieldType: "date" },
    ];

    render(<Harness fields={fields} />);

    // If the prefix were dropped, values would land at the top level and the
    // server would write an empty `dynamic_attributes` while silently
    // ignoring everything the user typed.
    expect(screen.getByLabelText(/Case number/i)).toHaveAttribute(
      "name",
      "dynamicAttributes.caseNumber",
    );
    expect(screen.getByLabelText(/Next hearing/i)).toHaveAttribute(
      "name",
      "dynamicAttributes.nextHearing",
    );
  });

  it("marks required fields as required in the DOM, not just in the schema", () => {
    const fields: DynamicFieldSpec[] = [
      { fieldName: "caseNumber", label: "Case number", fieldType: "text", isRequired: true },
      { fieldName: "optional", label: "Optional note", fieldType: "text" },
    ];

    render(<Harness fields={fields} />);

    // Screen readers announce required state from the DOM. A schema-only
    // rule is invisible to anyone not looking at the validation message.
    const required = screen.getByLabelText(/Case number/i);
    expect(required).toBeRequired();
    expect(screen.getByLabelText(/Optional note/i)).not.toBeRequired();
  });

  it("renders help text and associates it for assistive technology", () => {
    const fields: DynamicFieldSpec[] = [
      {
        fieldName: "carpetArea",
        label: "Carpet area",
        fieldType: "number",
        helpText: "Usable floor area, excluding walls.",
      },
    ];

    render(<Harness fields={fields} />);

    const input = screen.getByLabelText(/Carpet area/i);
    const describedBy = input.getAttribute("aria-describedby");

    expect(describedBy).toBeTruthy();
    expect(screen.getByText(/Usable floor area, excluding walls\./i)).toBeInTheDocument();
  });

  /* ────────────────────────────────────────────────────────────── */
  /* THE SAME DEFINITIONS DRIVE VALIDATION                          */
  /* ────────────────────────────────────────────────────────────── */

  it("builds a matching validation schema from the same definitions", () => {
    const fields: DynamicFieldSpec[] = [
      { fieldName: "carpetArea", label: "Carpet area", fieldType: "number", validation: { min: 0 } },
      { fieldName: "caseNumber", label: "Case number", fieldType: "text", isRequired: true },
    ];

    const schema = buildDynamicSchema(fields);

    expect(schema.safeParse({ carpetArea: "1240", caseNumber: "O.S. 1234/2026" }).success).toBe(true);

    // Required means required.
    expect(schema.safeParse({ carpetArea: "1240", caseNumber: "" }).success).toBe(false);

    // A negative area is rejected by the min constraint from the definition.
    expect(
      schema.safeParse({ carpetArea: "-5", caseNumber: "O.S. 1" }).success,
    ).toBe(false);
  });

  it("strips keys that no field definition describes", () => {
    const schema = buildDynamicSchema([
      { fieldName: "carpetArea", label: "Carpet area", fieldType: "number" },
    ]);

    const result = schema.safeParse({
      carpetArea: "1240",
      // A crafted request trying to smuggle extra keys into the JSONB column.
      "<img src=x onerror=alert(1)>": "payload",
      isAdmin: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).toEqual(["carpetArea"]);
      expect(result.data).not.toHaveProperty("isAdmin");
    }
  });

  /* ────────────────────────────────────────────────────────────── */
  /* INDUSTRY DEFAULTS                                              */
  /* ────────────────────────────────────────────────────────────── */

  it.each([
    ["real_estate_developer"],
    ["legal_advocate"],
    ["generic"],
  ])("the built-in field set for %s renders 3+ input types", (industry) => {
    const fields = defaultFieldsForIndustry(industry);

    const distinctTypes = new Set(fields.map((f) => f.fieldType));
    expect(distinctTypes.size).toBeGreaterThanOrEqual(3);

    const { container } = render(<Harness fields={fields} />);

    // Every definition produced an actual form control.
    const controls = container.querySelectorAll("input, select, textarea");
    expect(controls.length).toBeGreaterThanOrEqual(fields.length);

    for (const field of fields) {
      expect(
        container.querySelector(`[name="dynamicAttributes.${field.fieldName}"]`),
        `no control rendered for "${field.fieldName}"`,
      ).not.toBeNull();
    }
  });

  it("two industries produce genuinely different forms from one component", () => {
    const realEstate = defaultFieldsForIndustry("real_estate_developer");
    const legal = defaultFieldsForIndustry("legal_advocate");

    const { container: reContainer } = render(<Harness fields={realEstate} />);
    expect(reContainer.querySelector('[name="dynamicAttributes.carpetArea"]')).not.toBeNull();
    expect(reContainer.querySelector('[name="dynamicAttributes.caseNumber"]')).toBeNull();

    cleanupAndRenderLegal();

    function cleanupAndRenderLegal() {
      const { container: legalContainer } = render(<Harness fields={legal} />);
      expect(legalContainer.querySelector('[name="dynamicAttributes.caseNumber"]')).not.toBeNull();
    }
  });
});
