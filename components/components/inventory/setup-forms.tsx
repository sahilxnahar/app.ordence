"use client";

/**
 * Ordence — 🔴🔴🔴 THE FIRST STORE AND THE FIRST STOCK ITEM
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE EMPTY STATE TOLD YOU TO DO SOMETHING THE PRODUCT COULD NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * `/inventory` read: *"No stock recorded yet. Add a store and a stock
 * item, then post an opening balance."*
 *
 * `saveWarehouse` and `saveStockItem` are the only inserts into
 * `warehouses` and `stock_items` in this product, and nothing called
 * either. Twenty reachable actions read one or the other — the stock
 * position, batches, serials, counts, transfers, goods returns,
 * purchase orders, the valuation. Every one of them correct over two
 * tables that could not receive a row, under an instruction to add rows.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ TWO CHOICES ON THESE FORMS ARE NOT PREFERENCES
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 **Allow negative stock** is offered as an explicit switch and never
 *    defaulted on, and the validator's own comment says why: switching
 *    it on means every valuation for that store depends on the paperwork
 *    catching up with the lorry. A store that can go negative produces a
 *    stock value that is arithmetic on a number nobody has counted.
 *
 * 🔴 **Valuation method** cannot be changed once the item has moved, and
 *    the copy says so at the moment of choosing rather than at the moment
 *    of refusing. Restating a year of issues under a different method is
 *    a restatement of the P&L, not a settings change.
 *
 * ⚠️ **Tracking mode** is the same shape: an item that has issued
 *    untracked stock cannot retrospectively acquire batch numbers,
 *    because the batches were never recorded and cannot be invented.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export const WAREHOUSE_TYPES = [
  { value: "own", label: "Own store" },
  { value: "site", label: "Site store" },
  { value: "consignment", label: "Consignment" },
  { value: "transit", label: "In transit" },
  { value: "third_party", label: "Third party" },
  { value: "quarantine", label: "Quarantine" },
] as const;

export const VALUATION_METHODS = [
  {
    value: "weighted_average",
    label: "Weighted average",
    help: "Each receipt re-averages the cost. The usual answer, and the one that survives an audit without a per-lot paper trail.",
  },
  {
    value: "fifo",
    label: "FIFO",
    help: "Oldest cost issues first. Needs the receipt history to be complete, because the cost of an issue is decided by a receipt that may be months old.",
  },
  {
    value: "specific",
    label: "Specific identification",
    help: "The cost of the exact unit issued. Only honest where units are individually identified — serial tracking, or a lot that is never mixed.",
  },
  {
    value: "standard",
    label: "Standard cost",
    help: "A fixed cost per unit with variances posted separately. ⚠️ The variance account has to be watched or the difference accumulates silently.",
  },
] as const;

const BLANK_WH = {
  code: "",
  name: "",
  warehouseType: "own",
  city: "",
  state: "",
  stateCode: "",
  gstin: "",
  allowNegativeStock: false,
  notes: "",
};

const BLANK_ITEM = {
  sku: "",
  name: "",
  description: "",
  uom: "nos",
  trackingMode: "none",
  valuationMethod: "weighted_average",
  hsnSacCode: "",
  reorderLevel: "",
  reorderQuantity: "",
  leadTimeDays: "",
  shelfLifeDays: "",
};

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

export function InventorySetupForms({
  saveWarehouseAction,
  saveStockItemAction,
}: {
  saveWarehouseAction: (i: unknown) => Promise<Result<{ id: string }>>;
  saveStockItemAction: (i: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [which, setWhich] = useState<"none" | "warehouse" | "item">("none");
  const [wh, setWh] = useState({ ...BLANK_WH });
  const [item, setItem] = useState({ ...BLANK_ITEM });
  const [fe, setFe] = useState<Record<string, string[]>>({});

  function submitWarehouse() {
    setFe({});
    startTransition(async () => {
      const res = await saveWarehouseAction({
        code: wh.code.trim(),
        name: wh.name.trim(),
        warehouseType: wh.warehouseType,
        city: wh.city.trim() || null,
        state: wh.state.trim() || null,
        stateCode: wh.stateCode.trim() || null,
        gstin: wh.gstin.trim().toUpperCase() || null,
        allowNegativeStock: wh.allowNegativeStock,
        notes: wh.notes.trim() || null,
      });
      if (!res.ok) {
        if (res.fieldErrors) setFe(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(`Store "${wh.name.trim()}" added.`);
      setWh({ ...BLANK_WH });
      setWhich("none");
    });
  }

  function submitItem() {
    setFe({});
    startTransition(async () => {
      const res = await saveStockItemAction({
        sku: item.sku.trim(),
        name: item.name.trim(),
        description: item.description.trim() || null,
        uom: item.uom.trim() || "nos",
        trackingMode: item.trackingMode,
        valuationMethod: item.valuationMethod,
        hsnSacCode: item.hsnSacCode.trim() || null,
        reorderLevel: item.reorderLevel.trim() || null,
        reorderQuantity: item.reorderQuantity.trim() || null,
        leadTimeDays: item.leadTimeDays ? Number(item.leadTimeDays) : null,
        shelfLifeDays: item.shelfLifeDays ? Number(item.shelfLifeDays) : null,
      });
      if (!res.ok) {
        if (res.fieldErrors) setFe(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(`${item.name.trim()} added.`);
      setItem({ ...BLANK_ITEM });
      setWhich("none");
    });
  }

  const chosenValuation = VALUATION_METHODS.find(
    (v) => v.value === item.valuationMethod,
  );

  if (which === "none") {
    return (
      <div className="flex flex-wrap gap-2 p-4">
        <Button variant="secondary" onClick={() => setWhich("warehouse")}>
          Add a store
        </Button>
        <Button variant="secondary" onClick={() => setWhich("item")}>
          Add a stock item
        </Button>
      </div>
    );
  }

  if (which === "warehouse") {
    return (
      <div className="space-y-4 border-b p-4 text-sm">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="wh-code">Code</Label>
            <Input
              id="wh-code"
              value={wh.code}
              placeholder="MAIN"
              onChange={(e) => setWh({ ...wh, code: e.target.value })}
            />
            <Errors list={fe.code} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="wh-name">Name</Label>
            <Input
              id="wh-name"
              value={wh.name}
              onChange={(e) => setWh({ ...wh, name: e.target.value })}
            />
            <Errors list={fe.name} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wh-type">Type</Label>
            <select
              id="wh-type"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={wh.warehouseType}
              onChange={(e) => setWh({ ...wh, warehouseType: e.target.value })}
            >
              {WAREHOUSE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="wh-city">City</Label>
            <Input
              id="wh-city"
              value={wh.city}
              onChange={(e) => setWh({ ...wh, city: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wh-state">State</Label>
            <Input
              id="wh-state"
              value={wh.state}
              onChange={(e) => setWh({ ...wh, state: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wh-sc">State code</Label>
            <Input
              id="wh-sc"
              maxLength={2}
              value={wh.stateCode}
              placeholder="29"
              onChange={(e) => setWh({ ...wh, stateCode: e.target.value })}
            />
            {/**
             * ⚠️ THE STATE CODE DECIDES CGST+SGST versus IGST on a stock
             * transfer between stores, which is a taxable supply between
             * distinct persons under s.25(4) CGST when the two are
             * registered in different states.
             */}
            <p className="text-xs text-muted-foreground">
              Decides whether a transfer out of this store is IGST or CGST and
              SGST. Two stores in different states are distinct persons under
              s.25(4) CGST and a movement between them is a supply.
            </p>
            <Errors list={fe.stateCode} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="wh-gstin">GSTIN of this store</Label>
            <Input
              id="wh-gstin"
              maxLength={15}
              value={wh.gstin}
              onChange={(e) => setWh({ ...wh, gstin: e.target.value })}
            />
            <Errors list={fe.gstin} />
          </div>
        </div>

        <label className="flex items-start gap-2 rounded-md border border-dashed p-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={wh.allowNegativeStock}
            onChange={(e) =>
              setWh({ ...wh, allowNegativeStock: e.target.checked })
            }
          />
          <span>
            <span className="font-medium">Allow stock to go negative</span>
            {/**
             * 🔴 THE VALIDATOR'S OWN REASON, ON THE SCREEN. Defaulting
             * this on is how a store's valuation quietly becomes
             * arithmetic over a quantity nobody has counted.
             */}
            <span className="block text-xs text-muted-foreground">
              🔴 Leave this off unless you mean it. Switching it on means every
              valuation for this store depends on the paperwork catching up
              with the lorry: goods can be issued before the receipt is
              entered, and the stock value in between is arithmetic on a
              quantity nobody has counted.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending || wh.code.trim() === "" || wh.name.trim() === ""}
            onClick={submitWarehouse}
          >
            Add the store
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setWhich("none");
              setWh({ ...BLANK_WH });
              setFe({});
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 border-b p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="it-sku">SKU</Label>
          <Input
            id="it-sku"
            value={item.sku}
            onChange={(e) => setItem({ ...item, sku: e.target.value })}
          />
          <Errors list={fe.sku} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="it-name">Name</Label>
          <Input
            id="it-name"
            value={item.name}
            onChange={(e) => setItem({ ...item, name: e.target.value })}
          />
          <Errors list={fe.name} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="it-uom">Unit of measure</Label>
          <Input
            id="it-uom"
            value={item.uom}
            placeholder="nos"
            onChange={(e) => setItem({ ...item, uom: e.target.value })}
          />
          {/**
           * ⚠️ QUANTITIES ARE INTEGER THOUSANDTHS THROUGHOUT THIS
           * PRODUCT. An item held in tonnes and issued in kilograms is
           * two items, not one with a conversion, because the conversion
           * would have to be applied at every historical movement.
           */}
          <p className="text-xs text-muted-foreground">
            One unit per item. Something bought in tonnes and issued in
            kilograms is two items, not one with a conversion.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="it-hsn">HSN or SAC</Label>
          <Input
            id="it-hsn"
            value={item.hsnSacCode}
            onChange={(e) => setItem({ ...item, hsnSacCode: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="it-track">Tracking</Label>
          <select
            id="it-track"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={item.trackingMode}
            onChange={(e) => setItem({ ...item, trackingMode: e.target.value })}
          >
            <option value="none">Not tracked</option>
            <option value="batch">By batch</option>
            <option value="serial">By serial number</option>
          </select>
          {/**
           * 🔴 SAID AT THE MOMENT OF CHOOSING. An item that has already
           * issued untracked stock cannot acquire batch numbers later:
           * the batches were never recorded and cannot be invented.
           */}
          <p className="text-xs text-muted-foreground">
            🔴 Choose now. An item that has issued untracked stock cannot be
            given batch numbers later, because those batches were never
            recorded and cannot be invented.
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="it-val">Valuation method</Label>
        <select
          id="it-val"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm sm:w-72"
          value={item.valuationMethod}
          onChange={(e) =>
            setItem({ ...item, valuationMethod: e.target.value })
          }
        >
          {VALUATION_METHODS.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{chosenValuation?.help}</p>
        {/**
         * 🔴 THE CONSEQUENCE OF CHANGING IT LATER, STATED BEFORE IT IS
         * CHOSEN rather than in the refusal that comes afterwards.
         */}
        <p className="text-xs text-muted-foreground">
          🔴 This cannot be changed once the item has moved. Restating a year
          of issues under a different method is a restatement of the profit and
          loss account, not a settings change.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="it-rl">Reorder level</Label>
          <Input
            id="it-rl"
            value={item.reorderLevel}
            onChange={(e) => setItem({ ...item, reorderLevel: e.target.value })}
          />
          <Errors list={fe.reorderLevel} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="it-rq">Reorder quantity</Label>
          <Input
            id="it-rq"
            value={item.reorderQuantity}
            onChange={(e) =>
              setItem({ ...item, reorderQuantity: e.target.value })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="it-lt">Lead time, days</Label>
          <Input
            id="it-lt"
            inputMode="numeric"
            value={item.leadTimeDays}
            onChange={(e) => setItem({ ...item, leadTimeDays: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="it-sl">Shelf life, days</Label>
          <Input
            id="it-sl"
            inputMode="numeric"
            value={item.shelfLifeDays}
            onChange={(e) =>
              setItem({ ...item, shelfLifeDays: e.target.value })
            }
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            pending || item.sku.trim() === "" || item.name.trim() === ""
          }
          onClick={submitItem}
        >
          Add the stock item
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setWhich("none");
            setItem({ ...BLANK_ITEM });
            setFe({});
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
