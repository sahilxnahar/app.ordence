"use client";

/**
 * Ordence — ⭐⭐ THE BOOKING FORM
 * Version: v1.78.0-alpha · Wave 10
 *
 * ⚠️ THE AGREEMENT VALUE PRE-FILLS FROM THE UNIT AND STAYS EDITABLE.
 * The list price is the right answer most of the time and is wrong
 * exactly when it matters , a negotiated discount, a corner-unit
 * premium , so it is a default rather than a fact.
 *
 * ⚠️ THE PLAN TEMPLATE IS OPTIONAL HERE. A booking with no plan is a
 * legitimate intermediate state; the booking screen offers the plan
 * builder afterwards. Forcing the choice at creation time is how a
 * template gets picked to get past the form.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type Option = { id: string; label: string; hint: string | null };
type UnitOption = Option & { priceRupees: string };

export function NewBookingForm(props: {
  leads: readonly Option[];
  units: readonly UnitOption[];
  unavailableCount: number;
  templates: readonly { key: string; name: string }[];
  create: (input: unknown) => Promise<Result<{ id: string; reference: string }>>;
}) {
  const router = useRouter();
  const [leadId, setLeadId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [agreementValue, setAgreementValue] = useState("");
  const [planTemplateKey, setPlanTemplateKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function chooseUnit(id: string) {
    setUnitId(id);
    const unit = props.units.find((u) => u.id === id);
    // Only pre-fill an empty field — never overwrite a figure somebody typed.
    if (unit && agreementValue.trim() === "") setAgreementValue(unit.priceRupees);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await props.create({
        leadId,
        unitId,
        agreementValue,
        planTemplateKey: planTemplateKey === "" ? null : planTemplateKey,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/sales/bookings/${result.data.id}`);
    });
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Buyer</span>
        <select
          value={leadId}
          onChange={(e) => setLeadId(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Choose a lead</option>
          {props.leads.map((lead) => (
            <option key={lead.id} value={lead.id}>
              {lead.label}
              {lead.hint ? ` (${lead.hint})` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Unit</span>
        <select
          value={unitId}
          onChange={(e) => chooseUnit(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Choose an available unit</option>
          {props.units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.label}
              {unit.hint ? ` , ${unit.hint}` : ""}
            </option>
          ))}
        </select>
        {props.unavailableCount > 0 && (
          <span className="block text-xs text-muted-foreground">
            {props.unavailableCount} unit{props.unavailableCount === 1 ? " is" : "s are"} not
            listed because {props.unavailableCount === 1 ? "it is" : "they are"} held, booked
            or blocked.
          </span>
        )}
      </label>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Agreement value (₹)</span>
        <input
          value={agreementValue}
          onChange={(e) => setAgreementValue(e.target.value)}
          inputMode="decimal"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <span className="block text-xs text-muted-foreground">
          Pre-filled from the unit&rsquo;s list price. Change it if the deal is different.
        </span>
      </label>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Payment plan</span>
        <select
          value={planTemplateKey}
          onChange={(e) => setPlanTemplateKey(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Decide later</option>
          {props.templates.map((template) => (
            <option key={template.key} value={template.key}>
              {template.name}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={pending || leadId === "" || unitId === "" || agreementValue.trim() === ""}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create the booking"}
      </button>
    </div>
  );
}
