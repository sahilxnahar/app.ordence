"use client";

/**
 * Ordence — 🔴🔴🔴 RECORDING A VENDOR'S TAX INVOICE
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `recordPurchaseInvoice` HAD NO CALLER, AND IT IS THE ONLY ONE
 * ══════════════════════════════════════════════════════════════════════
 * `/purchases` listed vendors and invoices and the ITC register. Every
 * read was wired; not one write was. `upsertVendor`,
 * `recordPurchaseInvoice`, `setPurchaseInvoiceStatus`,
 * `recordItcMovement` and `addVendorLedgerEntry` were reachable from
 * nothing, so the module was a report over a table that could not
 * receive a row.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE TAX IS TRANSCRIBED FROM THE SUPPLIER'S INVOICE, NEVER
 *        COMPUTED FROM OUR RATE MASTER
 * ══════════════════════════════════════════════════════════════════════
 * On the OUTWARD side the rate comes from the dated master, because we
 * decide it. Here the supplier decided it, and what we owe them is what
 * they billed.
 *
 * 🔴 THE MASTER CHECKS THE CHARGE, IT DOES NOT REPLACE IT. A supplier
 * billing 18% on a classification notified at 12% has overcharged, and
 * s.16(1) allows credit only on tax *"charged in respect of such
 * supply"* — which the excess is not. Substituting our rate would hide
 * the overcharge, pay it, and claim credit on it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ITC PURPOSE IS THE FIELD THAT MATTERS AND IT CANNOT BE GUESSED
 * ══════════════════════════════════════════════════════════════════════
 * s.17(5) blocks credit on whole categories, and s.17(2) apportions it
 * where a supply is used partly for exempt purposes. Neither can be
 * inferred from an invoice: cement bought to build a tower for sale
 * carries credit, and the same cement bought to build the developer's
 * own office does not. The person entering the bill is the only one who
 * knows which, and this is the moment they know it.
 *
 * ⚠️ THE PLACE OF SUPPLY IS SEPARATE FOR IMMOVABLE PROPERTY. s.12(3):
 * a contractor's bill for building a tower is a supply relating to
 * immovable property and its place of supply is the PROPERTY'S state,
 * not the recipient's. The server refuses the combination that is
 * inconsistent, and the second field appears only when it applies.
 */

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type VendorOption = {
  id: string;
  code: string;
  legalName: string;
  tdsApplicable: boolean;
  defaultTdsSection: string | null;
};
export type RegistrationOption = { id: string; gstin: string };

export const ITC_PURPOSES = [
  {
    value: "taxable_supply",
    label: "For making a taxable supply",
    help: "The ordinary case. Full credit.",
  },
  {
    value: "sold_before_completion",
    label: "Real estate, sold before completion",
    help: "Credit is available; the supply is taxable because it was sold before the completion certificate.",
  },
  {
    value: "own_account_construction",
    label: "Construction on own account",
    help: "🔴 BLOCKED by s.17(5)(d). Building for oneself carries no credit, even on the same materials.",
  },
  {
    value: "further_supply_works_contract",
    label: "Works contract, for further supply of works contract",
    help: "The exception inside s.17(5)(c). Credit survives only where the works contract feeds another works contract.",
  },
  {
    value: "plant_and_machinery",
    label: "Plant and machinery",
    help: "Excluded from the s.17(5)(d) block by its own definition. Credit is available.",
  },
  {
    value: "exempt_supply",
    label: "For an exempt supply",
    help: "🔴 No credit. s.17(2).",
  },
  {
    value: "common",
    label: "Common — taxable and exempt",
    help: "⚠️ Apportioned under Rule 42/43. The reversal is computed for the period, not now.",
  },
  {
    value: "non_business",
    label: "Non-business use",
    help: "🔴 No credit. s.17(1).",
  },
] as const;

export const EXPENDITURE_NATURES = [
  "goods",
  "input_service",
  "capital_goods",
  "motor_vehicle",
  "vessel_or_aircraft",
  "motor_vehicle_related_service",
  "food_and_beverage",
  "outdoor_catering",
  "beauty_or_health_service",
  "club_or_fitness_membership",
  "employee_travel_benefit",
  "life_or_health_insurance",
  "works_contract_service",
  "construction_material",
] as const;

const BLANK = {
  vendorId: "",
  recipientRegistrationId: "",
  invoiceNumber: "",
  invoiceDate: "",
  goodsReceivedDate: "",
  supplyType: "goods",
  placeOfSupplyCode: "",
  propertyStateCode: "",
  isReverseCharge: false,
  rcmSection: "",
  isTdsDeductible: false,
  tdsSection: "",
  isBillOfSupply: false,
  roundOff: "0",
};

const BLANK_LINE = {
  description: "",
  hsnSacCode: "",
  quantity: "",
  uqc: "",
  amount: "",
  rateBps: "1800",
  cgst: "0",
  sgst: "0",
  igst: "0",
  cess: "0",
  itcPurpose: "taxable_supply",
  expenditureNature: "goods",
  isCapitalGoods: false,
};

export function RecordPurchaseInvoiceForm({
  vendors,
  registrations,
  recordAction,
}: {
  vendors: readonly VendorOption[];
  registrations: readonly RegistrationOption[];
  recordAction: (i: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ ...BLANK });
  const [lines, setLines] = useState([{ ...BLANK_LINE }]);
  const [fe, setFe] = useState<Record<string, string[]>>({});

  const vendor = useMemo(
    () => vendors.find((v) => v.id === f.vendorId) ?? null,
    [vendors, f.vendorId],
  );

  /**
   * ⚠️ THE TOTAL IS SHOWN, NOT COLLECTED. Every figure below is
   * transcribed from the supplier's invoice, so a total the form computes
   * is a CHECK against the printed total and not a field. If they differ,
   * one of the lines is mistyped.
   */
  const totals = useMemo(() => {
    const sum = (get: (l: typeof BLANK_LINE) => string) =>
      lines.reduce((t, l) => t + BigInt(get(l).trim() || "0"), 0n);
    const taxable = sum((l) => l.amount);
    const tax =
      sum((l) => l.cgst) + sum((l) => l.sgst) + sum((l) => l.igst) + sum((l) => l.cess);
    return { taxable, tax, gross: taxable + tax + BigInt(f.roundOff || "0") };
  }, [lines, f.roundOff]);

  const rupees = (v: bigint) =>
    `₹${(v / 100n).toString()}.${(v % 100n).toString().padStart(2, "0")}`;

  const ready =
    f.vendorId !== "" &&
    f.invoiceNumber.trim() !== "" &&
    f.invoiceDate !== "" &&
    lines.every((l) => l.description.trim() !== "" && l.amount.trim() !== "");

  function submit() {
    setFe({});
    startTransition(async () => {
      const res = await recordAction({
        vendorId: f.vendorId,
        recipientRegistrationId: f.recipientRegistrationId || null,
        invoiceNumber: f.invoiceNumber.trim(),
        invoiceDate: f.invoiceDate,
        goodsReceivedDate: f.goodsReceivedDate || null,
        isBillOfSupply: f.isBillOfSupply,
        supplyType: f.supplyType,
        placeOfSupplyCode: f.placeOfSupplyCode.trim() || null,
        propertyStateCode: f.propertyStateCode.trim() || null,
        isReverseCharge: f.isReverseCharge,
        rcmSection: f.isReverseCharge ? f.rcmSection.trim() || null : null,
        isTdsDeductible: f.isTdsDeductible,
        tdsSection: f.isTdsDeductible ? f.tdsSection.trim() || null : null,
        roundOff: f.roundOff.trim() || "0",
        lines: lines.map((l, i) => ({
          lineNumber: i + 1,
          description: l.description.trim(),
          hsnSacCode: l.hsnSacCode.trim() || null,
          quantity: l.quantity.trim() || null,
          uqc: l.uqc.trim() || null,
          amount: l.amount.trim(),
          rateBps: Number(l.rateBps || "0"),
          cgst: l.cgst.trim() || "0",
          sgst: l.sgst.trim() || "0",
          igst: l.igst.trim() || "0",
          cess: l.cess.trim() || "0",
          isReverseCharge: f.isReverseCharge,
          itcPurpose: l.itcPurpose,
          expenditureNature: l.expenditureNature,
          isCapitalGoods: l.isCapitalGoods,
        })),
      });
      if (!res.ok) {
        if (res.fieldErrors) setFe(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(`Invoice ${f.invoiceNumber.trim()} recorded.`);
      setF({ ...BLANK });
      setLines([{ ...BLANK_LINE }]);
      setOpen(false);
    });
  }

  const setLine = (i: number, patch: Partial<typeof BLANK_LINE>) => {
    const next = [...lines];
    next[i] = { ...next[i], ...patch } as typeof BLANK_LINE;
    setLines(next);
  };

  if (!open) {
    return (
      <div className="p-4">
        <Button
          variant="secondary"
          disabled={vendors.length === 0}
          onClick={() => setOpen(true)}
        >
          Record a purchase invoice
        </Button>
        {vendors.length === 0 && (
          <span className="ml-2 text-xs text-muted-foreground">
            A bill belongs to a vendor. Add one first.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 border-b p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="pi-vendor">Vendor</Label>
          <select
            id="pi-vendor"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={f.vendorId}
            onChange={(e) => {
              const v = vendors.find((x) => x.id === e.target.value);
              setF({
                ...f,
                vendorId: e.target.value,
                /** ⚠️ A default, not a decision. See the TDS note below. */
                isTdsDeductible: v?.tdsApplicable ?? false,
                tdsSection: v?.defaultTdsSection ?? "",
              });
            }}
          >
            <option value="">Choose…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.code} · {v.legalName}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pi-num">Their invoice number</Label>
          <Input
            id="pi-num"
            value={f.invoiceNumber}
            onChange={(e) => setF({ ...f, invoiceNumber: e.target.value })}
          />
          {/**
           * 🔴 EXACTLY AS PRINTED. This string is what a GSTR-2B match is
           * made on. "INV/23-24/001" and "INV-23-24-001" are the same
           * invoice to a human and two different invoices to the
           * reconciliation.
           */}
          <p className="text-xs text-muted-foreground">
            🔴 Exactly as printed. This is what a GSTR-2B match is made on.
          </p>
          <Errors list={fe.invoiceNumber} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pi-date">Invoice date</Label>
          <Input
            id="pi-date"
            type="date"
            value={f.invoiceDate}
            onChange={(e) => setF({ ...f, invoiceDate: e.target.value })}
          />
          <Errors list={fe.invoiceDate} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pi-grn">Goods received on</Label>
          <Input
            id="pi-grn"
            type="date"
            value={f.goodsReceivedDate}
            onChange={(e) => setF({ ...f, goodsReceivedDate: e.target.value })}
          />
          {/**
           * ⚠️ s.16(2)(b): NO CREDIT UNTIL THE GOODS ARE RECEIVED. An
           * invoice dated March for goods received in April carries its
           * credit in April.
           */}
          <p className="text-xs text-muted-foreground">
            s.16(2)(b): no credit until the goods are received, whatever the
            invoice date says.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pi-reg">Our registration</Label>
          <select
            id="pi-reg"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={f.recipientRegistrationId}
            onChange={(e) =>
              setF({ ...f, recipientRegistrationId: e.target.value })
            }
          >
            <option value="">Choose…</option>
            {registrations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.gstin}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Whose electronic credit ledger this lands in.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pi-supply">Supply type</Label>
          <select
            id="pi-supply"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={f.supplyType}
            onChange={(e) => setF({ ...f, supplyType: e.target.value })}
          >
            <option value="goods">Goods</option>
            <option value="services">Services</option>
            <option value="immovable_property">Immovable property</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pi-pos">Place of supply, state code</Label>
          <Input
            id="pi-pos"
            maxLength={2}
            value={f.placeOfSupplyCode}
            onChange={(e) => setF({ ...f, placeOfSupplyCode: e.target.value })}
          />
          <Errors list={fe.placeOfSupplyCode} />
        </div>
        {f.supplyType === "immovable_property" && (
          <div className="space-y-1">
            <Label htmlFor="pi-prop">Property&apos;s state code</Label>
            <Input
              id="pi-prop"
              maxLength={2}
              value={f.propertyStateCode}
              onChange={(e) =>
                setF({ ...f, propertyStateCode: e.target.value })
              }
            />
            {/**
             * ⚠️ s.12(3). ONLY SHOWN WHERE IT APPLIES, because a field
             * that is usually irrelevant gets filled in with the
             * recipient's state out of habit.
             */}
            <p className="text-xs text-muted-foreground">
              s.12(3): for immovable property the place of supply is the
              property&apos;s state, not yours.
            </p>
            <Errors list={fe.propertyStateCode} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-4 rounded-md border border-dashed p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={f.isReverseCharge}
            onChange={(e) =>
              setF({ ...f, isReverseCharge: e.target.checked })
            }
          />
          <span>
            <span className="font-medium">Reverse charge</span>
            <span className="block text-xs text-muted-foreground">
              The tax is ours to pay to the Government, not theirs to collect.
              A separate transaction is posted for it.
            </span>
          </span>
        </label>
        {f.isReverseCharge && (
          <Input
            aria-label="RCM section"
            className="w-40"
            placeholder="9(3)"
            value={f.rcmSection}
            onChange={(e) => setF({ ...f, rcmSection: e.target.value })}
          />
        )}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={f.isTdsDeductible}
            onChange={(e) =>
              setF({ ...f, isTdsDeductible: e.target.checked })
            }
          />
          <span>
            <span className="font-medium">Tax is deductible at source</span>
            {/**
             * ⚠️ PREFILLED FROM THE VENDOR AND STILL A CHOICE. The vendor
             * flag is a default; whether this particular bill attracts a
             * deduction is a fact about the bill.
             */}
            <span className="block text-xs text-muted-foreground">
              Prefilled from the vendor. It is still this bill&apos;s decision.
              {vendor?.tdsApplicable
                ? ` ${vendor.legalName} is marked as deductible.`
                : ""}
            </span>
          </span>
        </label>
        {f.isTdsDeductible && (
          <Input
            aria-label="TDS section"
            className="w-32"
            placeholder="194C"
            value={f.tdsSection}
            onChange={(e) => setF({ ...f, tdsSection: e.target.value })}
          />
        )}
      </div>

      <div className="space-y-3">
        <p className="font-medium">Lines, as printed on their invoice</p>
        {lines.map((l, i) => (
          <div key={i} className="space-y-2 rounded-md border p-3">
            <div className="grid gap-2 sm:grid-cols-6">
              <div className="space-y-1 sm:col-span-3">
                <Label htmlFor={`l-desc-${i}`}>Description</Label>
                <Input
                  id={`l-desc-${i}`}
                  value={l.description}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`l-hsn-${i}`}>HSN / SAC</Label>
                <Input
                  id={`l-hsn-${i}`}
                  value={l.hsnSacCode}
                  onChange={(e) => setLine(i, { hsnSacCode: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`l-qty-${i}`}>Quantity</Label>
                <Input
                  id={`l-qty-${i}`}
                  value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`l-amt-${i}`}>Taxable value, paise</Label>
                <Input
                  id={`l-amt-${i}`}
                  inputMode="numeric"
                  value={l.amount}
                  onChange={(e) => setLine(i, { amount: e.target.value })}
                />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-5">
              <div className="space-y-1">
                <Label htmlFor={`l-rate-${i}`}>Rate charged, bps</Label>
                <Input
                  id={`l-rate-${i}`}
                  inputMode="numeric"
                  value={l.rateBps}
                  onChange={(e) => setLine(i, { rateBps: e.target.value })}
                />
              </div>
              {(["cgst", "sgst", "igst", "cess"] as const).map((k) => (
                <div key={k} className="space-y-1">
                  <Label htmlFor={`l-${k}-${i}`}>{k.toUpperCase()}, paise</Label>
                  <Input
                    id={`l-${k}-${i}`}
                    inputMode="numeric"
                    value={l[k]}
                    onChange={(e) => setLine(i, { [k]: e.target.value })}
                  />
                </div>
              ))}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`l-itc-${i}`}>What it is used for</Label>
                <select
                  id={`l-itc-${i}`}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={l.itcPurpose}
                  onChange={(e) => setLine(i, { itcPurpose: e.target.value })}
                >
                  {ITC_PURPOSES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {ITC_PURPOSES.find((p) => p.value === l.itcPurpose)?.help}
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`l-nat-${i}`}>Nature of the expenditure</Label>
                <select
                  id={`l-nat-${i}`}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={l.expenditureNature}
                  onChange={(e) =>
                    setLine(i, { expenditureNature: e.target.value })
                  }
                >
                  {EXPENDITURE_NATURES.map((n) => (
                    <option key={n} value={n}>
                      {n.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                {/**
                 * 🔴 THIS IS THE s.17(5) LIST. Motor vehicles, food and
                 * beverage, club membership, employee travel benefits and
                 * life or health insurance are blocked, each with its own
                 * exception. The engine in `lib/purchases/itc.ts` decides;
                 * this field is what it decides from.
                 */}
                <p className="text-xs text-muted-foreground">
                  🔴 Several of these are blocked outright by s.17(5), each with
                  its own exception. This is what the ITC engine reads.
                </p>
              </div>
            </div>
          </div>
        ))}
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => setLines([...lines, { ...BLANK_LINE }])}
        >
          Add a line
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-md border p-3">
        <div className="space-y-1 w-40">
          <Label htmlFor="pi-round">Round off, paise</Label>
          <Input
            id="pi-round"
            value={f.roundOff}
            onChange={(e) => setF({ ...f, roundOff: e.target.value })}
          />
        </div>
        {/**
         * ⚠️ A CHECK, NOT A FIELD. If this does not equal the printed
         * total, a line is mistyped — and finding that now is much
         * cheaper than finding it in a 2B mismatch three months later.
         */}
        <p className="text-muted-foreground">
          Taxable {rupees(totals.taxable)} · tax {rupees(totals.tax)} ·{" "}
          <span className="font-medium text-foreground">
            total {rupees(totals.gross)}
          </span>
          <span className="block text-xs">
            ⚠️ Compare that against the total printed on their invoice. If it
            differs, a line is mistyped, and finding it now is far cheaper than
            finding it in a GSTR-2B mismatch three months from now.
          </span>
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || !ready} onClick={submit}>
          Record the invoice
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setF({ ...BLANK });
            setLines([{ ...BLANK_LINE }]);
            setFe({});
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Errors({ list }: { list?: string[] }) {
  if (!list) return null;
  return (
    <>
      {list.map((m) => (
        <p key={m} className="text-xs text-destructive">
          {m}
        </p>
      ))}
    </>
  );
}
