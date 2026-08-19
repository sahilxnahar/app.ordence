"use client";

/**
 * Ordence — ⭐⭐ ADDING A DATED RATE
 * Version: v1.46.0-alpha · Batch 52
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FORM CANNOT EDIT ANYTHING AND THAT IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════
 * There is no row id in its state, no "edit" affordance anywhere on it,
 * and the only action it can reach is an INSERT. Design point 1 says a
 * rate change is a new row and never an edit; a form with an id field
 * and a "save" button is one refactor away from being an update, and
 * that refactor gets made by somebody who is not thinking about the
 * payslip in an employee's inbox.
 *
 * ⭐ IT PRE-FILLS FROM THE ROW IN FORCE, WHICH IS A DIFFERENT THING FROM
 * EDITING IT. Almost every real rate change moves one number out of
 * seven — the PF ceiling, the ESI limit, one slab's rate. Making
 * somebody retype the other six is how the other six acquire typos.
 *
 * ⚠️ AND THE DEFAULT DATE IS THE FIRST OF NEXT MONTH, NOT TODAY. A
 * statutory change takes effect from a date in a notification, and that
 * date is essentially never the day somebody happens to be typing.
 * Defaulting to today would put a rate change in the middle of a period
 * that is already half worked, which is the one shape nobody means.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type RevisionResult =
  | { ok: true; data: { id: string; closedRowId: string | null; note: string } }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type SeriesOption = {
  key: string;
  kind: string;
  scope: string | null;
  label: string;
  /** The payload of the row in force today, as pretty JSON, or a skeleton. */
  templateJson: string;
};

/**
 * ⭐ SKELETONS FOR A SERIES THAT DOES NOT EXIST YET, so that adding
 * Tamil Nadu's professional tax is not an exercise in guessing field
 * names. Every figure is a placeholder rather than a plausible number:
 * a skeleton pre-filled with Karnataka's amounts would be saved
 * unchanged by somebody in a hurry.
 */
const SKELETON: Record<string, string> = {
  pf: JSON.stringify(
    {
      employeeRateBp: 0,
      employerRateBp: 0,
      pensionRateBp: 0,
      edliRateBp: 0,
      adminRateBp: 0,
      wageCeilingMinor: "0",
      pensionCeilingMinor: "0",
    },
    null,
    2,
  ),
  esi: JSON.stringify(
    { employeeRateBp: 0, employerRateBp: 0, wageLimitMinor: "0" },
    null,
    2,
  ),
  income_tax: JSON.stringify(
    {
      standardDeductionMinor: "0",
      rebateLimitMinor: "0",
      rebateMaxMinor: "0",
      cessRateBp: 0,
      surchargeThresholdMinor: null,
    },
    null,
    2,
  ),
  income_tax_slab: JSON.stringify(
    { slabs: [{ fromMinor: "0", toMinor: null, rateBp: 0 }] },
    null,
    2,
  ),
  professional_tax: JSON.stringify(
    {
      slabs: [
        { fromMinor: "0", toMinor: null, amountMinor: "0", februaryAmountMinor: null },
      ],
    },
    null,
    2,
  ),
};

function firstOfNextMonth(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

export function RateRevisionForm({
  options,
  onAdd,
}: {
  options: SeriesOption[];
  onAdd: (input: {
    kind: string;
    scope: string | null;
    effectiveFrom: string;
    payloadJson: string;
    note: string;
  }) => Promise<RevisionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [selected, setSelected] = useState(options[0]?.key ?? "");
  const [kind, setKind] = useState(options[0]?.kind ?? "pf");
  const [scope, setScope] = useState(options[0]?.scope ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(firstOfNextMonth());
  const [payloadJson, setPayloadJson] = useState(options[0]?.templateJson ?? SKELETON.pf!);
  const [note, setNote] = useState("");

  /** ⚠️ "__new__" is a series that does not exist yet, not a kind. */
  const isNewSeries = selected === "__new__";

  function chooseSeries(key: string) {
    setSelected(key);
    if (key === "__new__") {
      setKind("professional_tax");
      setScope("");
      setPayloadJson(SKELETON.professional_tax!);
      return;
    }
    const option = options.find((o) => o.key === key);
    if (!option) return;
    setKind(option.kind);
    setScope(option.scope ?? "");
    setPayloadJson(option.templateJson);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Add a rate, effective from a date</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          This adds a row. It never edits one. The rate currently in force is closed the day
          before this one starts and its numbers are left exactly as they are, so a payslip
          reissued for an earlier month still reproduces what was actually paid.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="rate-series">Rate</Label>
            <Select
              id="rate-series"
              value={selected}
              onChange={(e) => chooseSeries(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
              <option value="__new__">A rate not configured yet…</option>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="rate-from" required>
              In force from
            </Label>
            <Input
              id="rate-from"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </div>
        </div>

        {isNewSeries ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="rate-kind">Kind</Label>
              <Select
                id="rate-kind"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setPayloadJson(SKELETON[e.target.value] ?? "{}");
                }}
              >
                <option value="pf">Provident fund</option>
                <option value="esi">Employees&apos; State Insurance</option>
                <option value="professional_tax">Professional tax (a State)</option>
                <option value="income_tax">Income tax (a regime)</option>
                <option value="income_tax_slab">Income tax slabs (a regime)</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rate-scope">Scope</Label>
              <Input
                id="rate-scope"
                value={scope}
                placeholder={
                  kind === "professional_tax" ? "State code, e.g. TN" : "new or old"
                }
                onChange={(e) => setScope(e.target.value.toUpperCase())}
              />
              {/*
                ⭐ THE STATE IS THE ONE THE EMPLOYEE WORKS IN, NOT THE ONE
                THE COMPANY IS REGISTERED IN. A Bengaluru company with
                three people in Mumbai owes Maharashtra professional tax
                for those three, and getting this backwards produces a
                confident deduction under the wrong State's rules.
              */}
              <p className="text-xs text-muted-foreground">
                {kind === "professional_tax"
                  ? "The State the employee WORKS in, not the one the company is registered in."
                  : kind === "income_tax" || kind === "income_tax_slab"
                    ? "The tax regime this applies to: new or old."
                    : "Provident fund and ESI are national. Leave this empty."}
              </p>
            </div>
          </div>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="rate-payload" required>
            The figures
          </Label>
          <Textarea
            id="rate-payload"
            rows={12}
            className="font-mono text-xs"
            value={payloadJson}
            onChange={(e) => setPayloadJson(e.target.value)}
          />
          {/*
            🔴 BASIS POINTS AND PAISE, AND NEITHER IS EVER A DECIMAL.
            8.33% is 833. ₹15,000 is "1500000". A rate entered as 8.33
            deducts a hundredth of what it should and looks like a
            correctly calculated exemption; a ceiling entered as 15000
            caps provident fund at ₹150.
          */}
          <p className="text-xs text-muted-foreground">
            Rates are whole basis points — 12% is <code>1200</code>, 8.33% is <code>833</code>.
            Amounts are whole paise as text — ₹15,000 is <code>&quot;1500000&quot;</code>. Never a
            decimal, in either: 8.33 entered as a rate deducts a hundredth of what it should and
            nothing in the payslip looks wrong.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="rate-note" required>
            Where this number came from
          </Label>
          <Textarea
            id="rate-note"
            rows={2}
            value={note}
            placeholder="e.g. EPFO circular of 12 June 2025, ceiling raised to ₹21,000 from 1 July."
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            In two years this line is the only record of why the number is what it is. A
            gazette date and a number is enough; &quot;updated&quot; is not.
          </p>
        </div>

        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await onAdd({
                kind,
                scope: scope.trim() === "" ? null : scope.trim(),
                effectiveFrom,
                payloadJson,
                note,
              });
              if (result.ok) {
                toast.success(result.data.note);
                setNote("");
                router.refresh();
              } else {
                /*
                  ⚠️ THE REFUSAL IS SHOWN IN FULL AND NOT TRUNCATED. The
                  most important one this form can produce is "that would
                  restate PR-2025-04 and PR-2025-05", and it names the
                  runs. A toast that clipped it to "Check the form" would
                  send somebody to psql.
                */
                toast.error(result.error, { duration: 12_000 });
              }
            })
          }
        >
          Add this rate
        </Button>
      </CardContent>
    </Card>
  );
}
