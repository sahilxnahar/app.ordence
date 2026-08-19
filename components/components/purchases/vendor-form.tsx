"use client";

/**
 * Ordence — 🔴🔴🔴 CREATING A VENDOR
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `upsertVendor` IS THE ONLY INSERT INTO `vendors` AND NOTHING CALLED
 *    IT
 * ══════════════════════════════════════════════════════════════════════
 * Seventeen reachable server actions READ `vendors`: purchase orders,
 * the payment run, the ITC reversal working, BOQ detail, cost control,
 * RA bills, the sales posting backlog, site labour, MSME exposure,
 * vendor ageing, vendor statements. Every one of them worked correctly
 * over a table that could not receive a row.
 *
 * ⚠️ `/purchases` LISTED VENDORS AND SAID "No vendors yet", which reads
 * as an empty state and was in fact the only state.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE FIELDS ARE NOT A FORM DESIGN. EACH ONE DECIDES SOMETHING
 *        LATER.
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 **PAN** decides the TDS rate. Without one, s.206AA applies at twenty
 *    per cent and the deduction screen will say so — but only if the PAN
 *    is recorded here, because that is where the deductee is built from.
 *
 * 🔴 **MSME registration** decides whether s.43B(h) of the Income Tax Act
 *    bites: payment beyond the MSMED time limit is disallowed as a
 *    deduction in the year it was incurred. The Udyam number is
 *    MANDATORY with the claim, and the validator refuses the claim
 *    without it, because s.43B(h) only applies to an enterprise
 *    REGISTERED under the MSMED Act. A claim with no number is a
 *    disallowance that cannot be defended if challenged.
 *
 * 🔴 **Payment terms** are what the MSME clock is measured against, and
 *    the validator caps them at 365 days with the reason stated: terms
 *    beyond a year are not a term, they are a dispute.
 *
 * ⚠️ **GSTIN** is optional and its absence is meaningful, not missing.
 *    An unregistered vendor may put the supply under reverse charge, and
 *    a blank here is how the purchase screen knows to ask.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export const VENDOR_TYPES = [
  { value: "material_supplier", label: "Material supplier" },
  { value: "contractor", label: "Contractor" },
  { value: "professional", label: "Professional" },
  { value: "transporter", label: "Transporter" },
  { value: "landlord", label: "Landlord" },
  { value: "utility", label: "Utility" },
  { value: "government", label: "Government" },
  { value: "other", label: "Other" },
] as const;

const BLANK = {
  code: "",
  legalName: "",
  tradeName: "",
  vendorType: "material_supplier",
  gstin: "",
  panNumber: "",
  paymentTermsDays: "30",
  msmeRegistered: false,
  udyamNumber: "",
  msmeCategory: "micro",
  msmeRegisteredOn: "",
  tdsApplicable: false,
  defaultTdsSection: "",
  notes: "",
};

export function VendorForm({
  createAction,
  disabled,
  disabledReason,
}: {
  createAction: (i: unknown) => Promise<Result<{ id: string }>>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  /**
   * 🔴 THE ONE CROSS-FIELD RULE, MIRRORED FROM THE VALIDATOR SO THE
   * BUTTON EXPLAINS ITSELF. `upsertVendorSchema.superRefine` refuses an
   * MSME claim with no Udyam number and says why; a form that only
   * discovers it on submit teaches people to retype the same thing.
   */
  const msmeIncomplete = form.msmeRegistered && form.udyamNumber.trim() === "";
  const ready =
    form.code.trim() !== "" && form.legalName.trim() !== "" && !msmeIncomplete;

  function submit() {
    setFieldErrors({});
    startTransition(async () => {
      const res = await createAction({
        code: form.code.trim(),
        legalName: form.legalName.trim(),
        tradeName: form.tradeName.trim() || null,
        vendorType: form.vendorType,
        gstin: form.gstin.trim().toUpperCase() || null,
        panNumber: form.panNumber.trim().toUpperCase() || null,
        paymentTermsDays: Number(form.paymentTermsDays || "30"),
        msmeRegistered: form.msmeRegistered,
        udyamNumber: form.msmeRegistered ? form.udyamNumber.trim() || null : null,
        msmeCategory: form.msmeRegistered ? form.msmeCategory : null,
        msmeRegisteredOn: form.msmeRegistered
          ? form.msmeRegisteredOn || null
          : null,
        tdsApplicable: form.tdsApplicable,
        defaultTdsSection: form.tdsApplicable
          ? form.defaultTdsSection.trim() || null
          : null,
        notes: form.notes.trim() || null,
      });
      if (!res.ok) {
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(`${form.legalName.trim()} added.`);
      setForm({ ...BLANK });
      setOpen(false);
    });
  }

  const err = (k: string) =>
    fieldErrors[k]?.map((m) => (
      <p key={m} className="text-xs text-destructive">
        {m}
      </p>
    ));

  if (disabled) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {disabledReason ??
          "Your role does not include permission to manage vendors."}
      </p>
    );
  }

  if (!open) {
    return (
      <div className="p-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Add a vendor
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 border-b p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="v-code">Code</Label>
          <Input
            id="v-code"
            value={form.code}
            placeholder="ACME-01"
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
          {err("code")}
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="v-name">Legal name</Label>
          <Input
            id="v-name"
            value={form.legalName}
            onChange={(e) => setForm({ ...form, legalName: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            As it appears on their invoice, not the name you call them.
          </p>
          {err("legalName")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="v-trade">Trade name</Label>
          <Input
            id="v-trade"
            value={form.tradeName}
            onChange={(e) => setForm({ ...form, tradeName: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="v-type">Type</Label>
          <select
            id="v-type"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={form.vendorType}
            onChange={(e) => setForm({ ...form, vendorType: e.target.value })}
          >
            {VENDOR_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="v-terms">Payment terms, in days</Label>
          <Input
            id="v-terms"
            inputMode="numeric"
            value={form.paymentTermsDays}
            onChange={(e) =>
              setForm({ ...form, paymentTermsDays: e.target.value })
            }
          />
          {err("paymentTermsDays")}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="v-gstin">GSTIN</Label>
          <Input
            id="v-gstin"
            value={form.gstin}
            maxLength={15}
            onChange={(e) => setForm({ ...form, gstin: e.target.value })}
          />
          {/**
           * ⚠️ BLANK IS A FACT, NOT A GAP. An unregistered supplier can
           * put the supply under reverse charge, and the purchase screen
           * reads the absence to know to ask.
           */}
          <p className="text-xs text-muted-foreground">
            Leave blank if they are unregistered. That is a fact about them,
            not a missing field, and the purchase screen reads it to decide
            whether to ask about reverse charge.
          </p>
          {err("gstin")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="v-pan">PAN</Label>
          <Input
            id="v-pan"
            value={form.panNumber}
            maxLength={10}
            onChange={(e) => setForm({ ...form, panNumber: e.target.value })}
          />
          {/**
           * 🔴 THE FIELD THAT COSTS THE MOST TO LEAVE BLANK.
           */}
          <p className="text-xs text-muted-foreground">
            🔴 Without a PAN, section 206AA deducts tax at twenty per cent
            whatever the section rate is.
          </p>
          {err("panNumber")}
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-dashed p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={form.msmeRegistered}
            onChange={(e) =>
              setForm({ ...form, msmeRegistered: e.target.checked })
            }
          />
          <span>
            <span className="font-medium">
              Registered under the MSMED Act
            </span>
            {/**
             * 🔴 s.43B(h). THE CONSEQUENCE IS ON THE FORM because it is a
             * consequence for the BUYER, not for the vendor, and the
             * person ticking this box is the one it lands on.
             */}
            <span className="block text-xs text-muted-foreground">
              🔴 Paying them beyond the MSMED time limit is disallowed as a
              deduction under s.43B(h) of the Income Tax Act, in the year the
              expense was incurred. This box is what makes the exposure
              visible before the year ends.
            </span>
          </span>
        </label>

        {form.msmeRegistered && (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="v-udyam">Udyam Registration Number</Label>
              <Input
                id="v-udyam"
                value={form.udyamNumber}
                placeholder="UDYAM-KR-03-0000000"
                onChange={(e) =>
                  setForm({ ...form, udyamNumber: e.target.value })
                }
              />
              {msmeIncomplete && (
                <p className="text-xs text-destructive">
                  s.43B(h) only bites for an enterprise REGISTERED under the
                  MSMED Act. Without the number there is no registration to
                  rely on, and the disallowance cannot be defended if it is
                  challenged.
                </p>
              )}
              {err("udyamNumber")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="v-cat">Category</Label>
              <select
                id="v-cat"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.msmeCategory}
                onChange={(e) =>
                  setForm({ ...form, msmeCategory: e.target.value })
                }
              >
                <option value="micro">Micro</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="v-msme-on">Registered on</Label>
              <Input
                id="v-msme-on"
                type="date"
                value={form.msmeRegisteredOn}
                onChange={(e) =>
                  setForm({ ...form, msmeRegisteredOn: e.target.value })
                }
              />
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-dashed p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={form.tdsApplicable}
            onChange={(e) =>
              setForm({ ...form, tdsApplicable: e.target.checked })
            }
          />
          <span>
            <span className="font-medium">Tax is deducted at source</span>
            <span className="block text-xs text-muted-foreground">
              The default section is a starting point for the deduction screen,
              not a decision. The section that applies is decided per payment.
            </span>
          </span>
        </label>
        {form.tdsApplicable && (
          <div className="space-y-1 sm:w-56">
            <Label htmlFor="v-tds">Default section</Label>
            <Input
              id="v-tds"
              value={form.defaultTdsSection}
              placeholder="194C"
              onChange={(e) =>
                setForm({ ...form, defaultTdsSection: e.target.value })
              }
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || !ready} onClick={submit}>
          Add the vendor
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setForm({ ...BLANK });
            setFieldErrors({});
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
