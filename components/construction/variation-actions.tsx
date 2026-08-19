"use client";

/**
 * Ordence — Variation order client actions
 * Version: v0.73.0-alpha
 *
 * ⚠️ EVERY REFUSAL IS SHOWN VERBATIM.
 *
 * `lib/construction/variations.ts` refuses in full sentences written for
 * a quantity surveyor — why a raiser may not approve their own variation,
 * why an approved variation cannot be un-approved. Replacing those with
 * "Something went wrong" throws away the only part of the refusal that
 * teaches the operator anything, and sends them to support instead.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createVariation,
  setVariationLines,
  submitVariation,
  approveVariation,
  rejectVariation,
  withdrawVariation,
} from "@/server/actions/variations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const UOMS = [
  "cum", "sqm", "sqft", "rmt", "kg", "mt", "quintal",
  "nos", "bag", "brass", "ltr", "day", "month", "ls",
] as const;

const KINDS = [
  { value: "addition", label: "Addition — extra quantity of an existing item" },
  { value: "omission", label: "Omission — work removed from scope" },
  { value: "rate_change", label: "Rate change — same work, different rate" },
  { value: "substitution", label: "Substitution — one item replaced by another" },
  { value: "extra_item", label: "Extra item — work with no BOQ line at all" },
] as const;

export type BoqOption = { id: string; code: string; title: string; status: string };
export type ItemOption = {
  id: string;
  boqId: string;
  itemCode: string;
  description: string;
  uom: string;
};

/* ------------------------------------------------------------------ */

function Refusal({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

function Done({ message }: { message: string }) {
  return (
    <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">
      {message}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* 1 · RAISE                                                           */
/* ------------------------------------------------------------------ */

export function RaiseVariationForm({ boqs }: { boqs: BoqOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (boqs.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No issued bills of quantities. A variation varies what was agreed — issue a BOQ
        first.
      </p>
    );
  }

  function onSubmit(formData: FormData) {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await createVariation({
        boqId: String(formData.get("boqId") ?? ""),
        kind: String(formData.get("kind") ?? "addition"),
        title: String(formData.get("title") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        instructionRef: String(formData.get("instructionRef") ?? "") || null,
        instructedOn: String(formData.get("instructedOn") ?? "") || null,
      });

      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(`${res.data.variationNumber} raised as a draft. Add its lines next.`);
      router.refresh();
      router.push(`/variations/${res.data.id}`);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Raise a variation</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="boqId">Bill of quantities</Label>
              <select
                id="boqId"
                name="boqId"
                required
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {boqs.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="kind">Kind</Label>
              <select
                id="kind"
                name="kind"
                required
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="title">Title</Label>
            <Input id="title" name="title" required maxLength={255} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reason">Why this is needed</Label>
            <textarea
              id="reason"
              name="reason"
              required
              rows={3}
              maxLength={4000}
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              The contractor will ask. A variation with no stated reason is how a claim
              starts.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="instructionRef">Instruction reference</Label>
              <Input id="instructionRef" name="instructionRef" maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="instructedOn">Instructed on</Label>
              <Input id="instructedOn" name="instructedOn" type="date" />
            </div>
          </div>

          {error && <Refusal message={error} />}
          {done && <Done message={done} />}

          <Button type="submit" disabled={pending}>
            {pending ? "Raising…" : "Raise variation"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 2 · PRICE                                                           */
/* ------------------------------------------------------------------ */

type DraftLine = {
  boqItemId: string;
  description: string;
  uom: string;
  quantityDelta: string;
  rate: string;
  replacesRate: boolean;
};

const EMPTY_LINE: DraftLine = {
  boqItemId: "",
  description: "",
  uom: "cum",
  quantityDelta: "",
  rate: "",
  replacesRate: false,
};

export function VariationLinesForm({
  variationId,
  kind,
  items,
  initialLines,
}: {
  variationId: string;
  kind: string;
  items: ItemOption[];
  initialLines: DraftLine[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>(
    initialLines.length > 0 ? initialLines : [{ ...EMPTY_LINE }],
  );

  const rateChangeKind = kind === "rate_change" || kind === "substitution";

  function update(index: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function onSave() {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await setVariationLines({
        variationId,
        lines: lines.map((l) => ({
          boqItemId: l.boqItemId || null,
          description: l.description,
          uom: l.uom,
          quantityDelta: l.quantityDelta,
          rate: l.rate,
          replacesRate: rateChangeKind ? true : l.replacesRate,
        })),
      });

      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(
        `Saved. ${res.data.lineCount} ${
          res.data.lineCount === 1 ? "line" : "lines"
        }; effect on the contract sum ₹${res.data.effectMinor}.`,
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Priced lines</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rateChangeKind && (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs">
            ⚠️ On a <strong>{kind.replace("_", " ")}</strong> every line must name the BOQ
            item whose rate it replaces. The effect is the <em>difference</em> between the
            new and old rates — not the full new rate. Valuing it at the full rate would
            double the line into the contract sum.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          Quantities are <strong>signed</strong>. An omission of 40 cum is{" "}
          <code>-40</code>. Rates are always positive — the sign belongs on the quantity.
        </p>

        <div className="space-y-4">
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-6"
            >
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`item-${index}`}>BOQ item</Label>
                <select
                  id={`item-${index}`}
                  value={line.boqItemId}
                  onChange={(e) => update(index, { boqItemId: e.target.value })}
                  required={rateChangeKind}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">{rateChangeKind ? "Choose…" : "None — extra item"}</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.itemCode} — {it.description.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`desc-${index}`}>Description</Label>
                <Input
                  id={`desc-${index}`}
                  value={line.description}
                  onChange={(e) => update(index, { description: e.target.value })}
                  required
                  maxLength={2000}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`uom-${index}`}>Unit</Label>
                <select
                  id={`uom-${index}`}
                  value={line.uom}
                  onChange={(e) => update(index, { uom: e.target.value })}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {UOMS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`qty-${index}`}>Quantity ±</Label>
                <Input
                  id={`qty-${index}`}
                  value={line.quantityDelta}
                  onChange={(e) => update(index, { quantityDelta: e.target.value })}
                  inputMode="decimal"
                  placeholder="-40"
                  required
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`rate-${index}`}>Rate ₹</Label>
                <Input
                  id={`rate-${index}`}
                  value={line.rate}
                  onChange={(e) => update(index, { rate: e.target.value })}
                  inputMode="decimal"
                  placeholder="1450.00"
                  required
                />
              </div>

              <div className="flex items-end sm:col-span-4">
                {lines.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Remove line {index + 1}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {error && <Refusal message={error} />}
        {done && <Done message={done} />}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
          >
            Add a line
          </Button>
          <Button type="button" onClick={onSave} disabled={pending}>
            {pending ? "Saving…" : "Save and price"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 3 · THE STATE MACHINE                                               */
/* ------------------------------------------------------------------ */

export function VariationDecisions({
  variationId,
  status,
  viewerRaisedIt,
  lineCount,
}: {
  variationId: string;
  status: string;
  viewerRaisedIt: boolean;
  lineCount: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "That did not work.");
        return;
      }
      setDone(message);
      router.refresh();
    });
  }

  if (status === "approved") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Approved — and final</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            ⚠️ An approved variation has already moved the measurement ceiling, and work
            may have been measured and certified against it. There is no un-approve. To
            correct it, raise a <strong>further variation reversing this one</strong> —
            both then stay in the register, which is what a register is for.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (status === "withdrawn") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Withdrawn</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This variation is closed and cannot be reopened. Raise a new one.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Decisions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "draft" && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {lineCount === 0
                ? "Add priced lines before submitting."
                : `${lineCount} priced ${lineCount === 1 ? "line" : "lines"}.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={pending || lineCount === 0}
                onClick={() =>
                  run(() => submitVariation({ variationId }), "Submitted for approval.")
                }
              >
                Submit for approval
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(() => withdrawVariation({ variationId }), "Withdrawn.")
                }
              >
                Withdraw
              </Button>
            </div>
          </div>
        )}

        {status === "submitted" && (
          <div className="space-y-3">
            {viewerRaisedIt && (
              <p className="rounded-md border border-border bg-muted/40 p-3 text-xs">
                ⚠️ You raised this variation, so you cannot approve it. Somebody who can
                do both can award themselves work — raise an extra item, set its rate,
                approve it, and the measurement ceiling moves with no second person having
                seen the number. A different approver has to take this decision.
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="decision-reason">Reason (required to reject)</Label>
              <textarea
                id="decision-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={2000}
                className="w-full rounded-md border border-input bg-background p-2 text-sm"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={pending || viewerRaisedIt}
                onClick={() =>
                  run(
                    () => approveVariation({ variationId }),
                    "Approved. The measurement ceiling has moved.",
                  )
                }
              >
                Approve
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  run(
                    () => rejectVariation({ variationId, reason }),
                    "Rejected and sent back.",
                  )
                }
              >
                Reject
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(() => withdrawVariation({ variationId }), "Withdrawn.")
                }
              >
                Withdraw
              </Button>
            </div>
          </div>
        )}

        {status === "rejected" && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => withdrawVariation({ variationId }), "Withdrawn.")}
            >
              Withdraw
            </Button>
          </div>
        )}

        {error && <Refusal message={error} />}
        {done && <Done message={done} />}
      </CardContent>
    </Card>
  );
}
