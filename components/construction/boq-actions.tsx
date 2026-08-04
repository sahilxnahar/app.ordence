"use client";

/**
 * Ordence — ⭐ BOQ WRITE ACTIONS
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY NUMBER ON THIS FORM IS A STRING, START TO FINISH
 * ══════════════════════════════════════════════════════════════════════
 * `<input type="number">` looks correct and is the wrong control here.
 * Its `valueAsNumber` has already been through a float before any of this
 * code sees it, and `Math.round(8.115 * 1e6)` is 8114999 rather than
 * 8115000 — so a quantity is wrong in its sixth decimal place before
 * validation has even run.
 *
 * The server's `toMicro()` parses the TEXT the user typed, with string
 * arithmetic. This component's only job is to not damage that text on the
 * way. `inputMode="decimal"` gives phones the numeric keypad without
 * handing the value to the browser's number parser.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE FORM DOES NOT VALIDATE WHAT THE SERVER VALIDATES
 * ══════════════════════════════════════════════════════════════════════
 * There is no client-side check that the BOQ is still a draft, that the
 * code is unique, or that the quantity is positive. All three are
 * enforced server-side and two of them are database constraints.
 *
 * Duplicating them here would mean two rule sets that must agree forever,
 * and the one that drifts is always the copy nobody is looking at. The
 * server's refusals are already written as sentences a person can act on,
 * so they are shown verbatim.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBoq, addBoqItems, issueBoq, openMeasurementBook } from "@/server/actions/construction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Option = { id: string; label: string };

export type BoqActionOptions = {
  projects: Option[];
  contracts: Option[];
  vendors: Option[];
};

const UOMS = [
  ["cum", "cum — cubic metre"],
  ["sqm", "sqm — square metre"],
  ["sqft", "sqft — square foot"],
  ["rmt", "rmt — running metre"],
  ["kg", "kg"],
  ["mt", "MT — tonne"],
  ["quintal", "quintal"],
  ["nos", "nos — number"],
  ["bag", "bag"],
  ["brass", "brass — 100 cft"],
  ["ltr", "litre"],
  ["day", "day"],
  ["month", "month"],
  ["ls", "LS — lump sum"],
] as const;

const CATEGORIES = [
  "earthwork", "piling_foundation", "concrete", "reinforcement", "formwork",
  "masonry", "plaster", "flooring", "waterproofing", "doors_windows",
  "painting", "plumbing", "electrical", "hvac", "fire_fighting", "lifts",
  "external_development", "preliminaries", "miscellaneous",
] as const;

function humanise(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Shared result handling. The server's message is the message. */
function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
    onDone?: () => void,
  ) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That could not be saved.");
        return;
      }
      setNotice(success);
      onDone?.();
      router.refresh();
    });
  }

  return { error, notice, pending, run, setError };
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) {
    return (
      <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (notice) {
    return (
      <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">
        {notice}
      </p>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* NEW BOQ                                                             */
/* ------------------------------------------------------------------ */

export function NewBoqForm({ options }: { options: BoqActionOptions }) {
  const [open, setOpen] = useState(false);
  const { error, notice, pending, run } = useAction();

  const [projectId, setProjectId] = useState("");
  const [contractId, setContractId] = useState("");
  const [contractorVendorId, setContractorVendorId] = useState("");
  const [workPackage, setWorkPackage] = useState("");
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [retentionPct, setRetentionPct] = useState("5");

  function submit() {
    run(
      () =>
        createBoq({
          projectId,
          workPackage,
          code,
          title,
          contractorVendorId: contractorVendorId || null,
          contractId: contractId || null,
          /*
           * ⚠️ PERCENT IN, BASIS POINTS OUT. Nobody in a site office
           * thinks in basis points, and nobody in this schema stores
           * anything else. `Math.round` is safe here and only here: a
           * retention rate has at most two decimals and never leaves the
           * range 0–100, so the float cannot drift into a wrong integer.
           */
          retentionRateBps: Math.round(Number(retentionPct || "0") * 100),
        }),
      "BOQ created. Add its priced items next.",
      () => {
        setOpen(false);
        setCode("");
        setTitle("");
        setWorkPackage("");
      },
    );
  }

  return (
    <div className="space-y-3">
      <Button size="sm" variant={open ? "default" : "outline"} onClick={() => setOpen(!open)}>
        {open ? "Cancel" : "New BOQ"}
      </Button>

      <Feedback error={error} notice={notice} />

      {open && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">New bill of quantities</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="boq-project">Project</Label>
              <select
                id="boq-project"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Choose…</option>
                {options.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="boq-contract">Works contract</Label>
              <select
                id="boq-contract"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={contractId}
                onChange={(e) => setContractId(e.target.value)}
              >
                <option value="">None yet — tender stage</option>
                {options.contracts.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              {/*
                ⚠️ SAID OUT LOUD, ON THE FORM, AT THE MOMENT IT MATTERS.
                A BOQ with no contract is excluded from the over-billing
                check entirely — every bill against it goes unverified.
                That is a legitimate state at tender stage and a dangerous
                one afterwards, and the difference is invisible unless
                somebody is told.
              */}
              {!contractId && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Without a contract, bills raised against this BOQ are not checked
                  against the authorised quantity. Fine at tender stage — attach the
                  contract once it is signed.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="boq-vendor">Contractor</Label>
              <select
                id="boq-vendor"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={contractorVendorId}
                onChange={(e) => setContractorVendorId(e.target.value)}
              >
                <option value="">Not appointed</option>
                {options.vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="boq-package">Work package</Label>
              <Input
                id="boq-package"
                value={workPackage}
                onChange={(e) => setWorkPackage(e.target.value)}
                placeholder="RCC framework"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="boq-code">Code</Label>
              <Input
                id="boq-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="BOQ-RCC-01"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="boq-title">Title</Label>
              <Input
                id="boq-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="RCC works, Tower 3"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="boq-retention">Retention %</Label>
              <Input
                id="boq-retention"
                inputMode="decimal"
                value={retentionPct}
                onChange={(e) => setRetentionPct(e.target.value)}
              />
            </div>

            <div className="flex items-end sm:col-span-2">
              <Button size="sm" disabled={pending} onClick={submit}>
                {pending ? "Saving…" : "Create BOQ"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PRICE IT — ADD ITEMS, THEN ISSUE                                    */
/* ------------------------------------------------------------------ */

type DraftItem = {
  itemCode: string;
  description: string;
  uom: string;
  category: string;
  quantity: string;
  rate: string;
};

const EMPTY_ITEM: DraftItem = {
  itemCode: "",
  description: "",
  uom: "cum",
  category: "concrete",
  quantity: "",
  rate: "",
};

export function BoqItemEditor({ boqId, status }: { boqId: string; status: string }) {
  const { error, notice, pending, run } = useAction();
  const [rows, setRows] = useState<DraftItem[]>([{ ...EMPTY_ITEM }]);
  const [confirmIssue, setConfirmIssue] = useState(false);

  const editable = status === "draft";

  function update(index: number, patch: Partial<DraftItem>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function submitItems() {
    const filled = rows.filter((row) => row.itemCode.trim() && row.description.trim());
    run(
      () => addBoqItems({ boqId, items: filled }),
      `${filled.length} ${filled.length === 1 ? "item" : "items"} added. The contract sum has been recomputed from the lines.`,
      () => setRows([{ ...EMPTY_ITEM }]),
    );
  }

  if (!editable) {
    return (
      <div className="space-y-3">
        <Feedback error={error} notice={notice} />
        <p className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          This BOQ has been {status}, so its lines are frozen. Extra or changed scope from
          here is a variation order — which keeps the original contract sum intact and
          records who approved the change.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Feedback error={error} notice={notice} />

      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={index} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-6">
            <div className="space-y-1">
              <Label htmlFor={`code-${index}`} className="text-xs">Item code</Label>
              <Input
                id={`code-${index}`}
                value={row.itemCode}
                onChange={(e) => update(index, { itemCode: e.target.value })}
                placeholder="2.03"
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`desc-${index}`} className="text-xs">Description</Label>
              <Input
                id={`desc-${index}`}
                value={row.description}
                onChange={(e) => update(index, { description: e.target.value })}
                placeholder="M30 RCC in columns and shear walls"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor={`uom-${index}`} className="text-xs">Unit</Label>
              <select
                id={`uom-${index}`}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={row.uom}
                onChange={(e) => update(index, { uom: e.target.value })}
              >
                {UOMS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`qty-${index}`} className="text-xs">Quantity</Label>
              {/*
                ⚠️ `type="text"`, NOT `type="number"`. See the file header:
                the browser's number parser would put this value through a
                float before the server ever parses the text.
              */}
              <Input
                id={`qty-${index}`}
                inputMode="decimal"
                value={row.quantity}
                onChange={(e) => update(index, { quantity: e.target.value })}
                placeholder="1000"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor={`rate-${index}`} className="text-xs">Rate ₹ / unit</Label>
              <Input
                id={`rate-${index}`}
                inputMode="decimal"
                value={row.rate}
                onChange={(e) => update(index, { rate: e.target.value })}
                placeholder="6800.00"
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`cat-${index}`} className="text-xs">Category</Label>
              <select
                id={`cat-${index}`}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={row.category}
                onChange={(e) => update(index, { category: e.target.value })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{humanise(c)}</option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setRows([...rows, { ...EMPTY_ITEM }])}>
          Add another line
        </Button>
        <Button size="sm" disabled={pending} onClick={submitItems}>
          {pending ? "Saving…" : "Save lines"}
        </Button>
      </div>

      {/*
        ⚠️ ISSUING IS A ONE-WAY DOOR AND THE BUTTON SAYS SO BEFORE IT IS
        PRESSED, not after. Confirmation exists here because the
        consequence is not reversible from the interface: after this,
        every change is a variation order with its own approval.
      */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
        {!confirmIssue ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Issue this BOQ when the lines are final.
            </p>
            <Button size="sm" variant="outline" onClick={() => setConfirmIssue(true)}>
              Issue BOQ
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              Issuing freezes every line on this BOQ.
            </p>
            <p className="text-xs text-muted-foreground">
              After this, the priced lines are what the contractor agreed to and cannot be
              edited. Extra or changed scope becomes a variation order, which keeps the
              original contract sum intact and records who approved the change. There is no
              undo from this screen.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(() => issueBoq({ boqId }), "BOQ issued. The lines are now frozen.", () =>
                    setConfirmIssue(false),
                  )
                }
              >
                {pending ? "Issuing…" : "Yes, issue it"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmIssue(false)}>
                Not yet
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* OPEN A MEASUREMENT BOOK                                             */
/* ------------------------------------------------------------------ */

export function NewMeasurementBookForm({ boqId }: { boqId: string }) {
  const { error, notice, pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [bookNumber, setBookNumber] = useState("");
  const [openedOn, setOpenedOn] = useState("");

  return (
    <div className="space-y-3">
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
        {open ? "Cancel" : "Open a measurement book"}
      </Button>

      <Feedback error={error} notice={notice} />

      {open && (
        <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="mb-number">Book number</Label>
            <Input
              id="mb-number"
              value={bookNumber}
              onChange={(e) => setBookNumber(e.target.value)}
              placeholder="MB-T3-01"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mb-opened">Opened on</Label>
            <Input
              id="mb-opened"
              type="date"
              value={openedOn}
              onChange={(e) => setOpenedOn(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  () => openMeasurementBook({ boqId, bookNumber, openedOn }),
                  "Measurement book opened.",
                  () => setOpen(false),
                )
              }
            >
              {pending ? "Opening…" : "Open book"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
