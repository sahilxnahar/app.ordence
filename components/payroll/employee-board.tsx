"use client";

/**
 * Ordence — ⭐⭐ EMPLOYEES AND WHAT THEY ARE PAID
 * Version: v1.23.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A RAISE IS A NEW ROW AND THE FORM SAYS SO
 * ══════════════════════════════════════════════════════════════════════
 * There is no "edit the amount" control here, deliberately. Setting a
 * new amount closes the old one the day before the new one starts, and
 * both stay on the record.
 *
 * ⚠️ EDITING IN PLACE WOULD SILENTLY RE-PRICE EVERY PAYSLIP EVER
 * REISSUED FROM THAT ROW. Payroll is retrospective by nature: somebody
 * asks for last March's payslip and it has to produce the number they
 * were actually paid.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupees } from "./payroll-run-board";

export type EmployeeView = {
  id: string;
  employeeCode: string;
  fullName: string;
  designation: string | null;
  department: string | null;
  workStateCode: string;
  joinedOn: string;
  leftOn: string | null;
  hasPan: boolean;
  pfExempt: boolean;
  esiExempt: boolean;
  taxRegime: string;
};

export type StructureView = {
  id: string;
  componentId: string;
  code: string;
  label: string;
  kind: string;
  monthlyAmountMinor: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type ComponentView = { id: string; code: string; label: string; kind: string };

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function EmployeeBoard({
  employees,
  components,
  structures,
  canManage,
  onSaveEmployee,
  onSetStructure,
}: {
  employees: EmployeeView[];
  components: ComponentView[];
  structures: Record<string, StructureView[]>;
  canManage: boolean;
  onSaveEmployee: (input: Record<string, unknown>) => Promise<Result<{ id: string }>>;
  onSetStructure: (input: {
    employeeId: string;
    componentId: string;
    monthlyAmountMinor: string;
    effectiveFrom: string;
    reason?: string;
  }) => Promise<Result<{ id: string; note: string }>>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [openStructure, setOpenStructure] = useState<string | null>(null);

  const [form, setForm] = useState({
    employeeCode: "",
    fullName: "",
    designation: "",
    workStateCode: "KA",
    joinedOn: new Date().toISOString().slice(0, 10),
    pan: "",
  });

  const [pay, setPay] = useState({
    componentId: components[0]?.id ?? "",
    rupeesAmount: "",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    reason: "",
  });

  return (
    <div className="space-y-6">
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Add someone</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {adding ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Employee code" id="code">
                    <Input
                      id="code"
                      value={form.employeeCode}
                      onChange={(e) => setForm({ ...form, employeeCode: e.target.value })}
                    />
                  </Field>
                  <Field label="Full name" id="name">
                    <Input
                      id="name"
                      value={form.fullName}
                      onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                    />
                  </Field>
                  <Field label="Designation" id="designation">
                    <Input
                      id="designation"
                      value={form.designation}
                      onChange={(e) => setForm({ ...form, designation: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="Works in (State code)"
                    id="state"
                    help="Where they WORK, not where the company is registered. This is what decides professional tax."
                  >
                    <Input
                      id="state"
                      maxLength={2}
                      value={form.workStateCode}
                      onChange={(e) =>
                        setForm({ ...form, workStateCode: e.target.value.toUpperCase() })
                      }
                    />
                  </Field>
                  <Field label="Joined on" id="joined">
                    <Input
                      id="joined"
                      type="date"
                      value={form.joinedOn}
                      onChange={(e) => setForm({ ...form, joinedOn: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="PAN"
                    id="pan"
                    help="Needed to withhold tax. Without it, a payslip that owes tax is refused rather than taxed at a guessed rate."
                  >
                    <Input
                      id="pan"
                      maxLength={10}
                      value={form.pan}
                      onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })}
                    />
                  </Field>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await onSaveEmployee({
                          ...form,
                          designation: form.designation || undefined,
                          pan: form.pan || null,
                        });
                        if (result.ok) {
                          toast.success("Added.");
                          setAdding(false);
                          setForm({ ...form, employeeCode: "", fullName: "", pan: "" });
                          router.refresh();
                        } else {
                          toast.error(result.error);
                        }
                      })
                    }
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                Add an employee
              </Button>
            )}
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">People ({employees.length})</h2>
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody yet. Contract labour on site belongs under Site labour rather than here — they
            are paid through their contractor&apos;s bill, not a payslip.
          </p>
        ) : null}

        {employees.map((e) => {
          const lines = (structures[e.id] ?? []).filter((s) => s.effectiveTo === null);
          const total = lines
            .filter((l) => l.kind === "earning")
            .reduce((sum, l) => sum + BigInt(l.monthlyAmountMinor), 0n);

          return (
            <Card key={e.id} data-testid={`employee-${e.employeeCode}`}>
              <CardContent className="space-y-2 pt-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{e.fullName}</span>
                  <span className="text-xs text-muted-foreground">{e.employeeCode}</span>
                  <Badge variant="outline">{e.workStateCode}</Badge>
                  {e.leftOn ? <Badge variant="secondary">left {e.leftOn}</Badge> : null}
                  {!e.hasPan ? <Badge variant="destructive">no PAN</Badge> : null}
                  {e.pfExempt ? <Badge variant="outline">PF exempt</Badge> : null}
                  <span className="ml-auto font-semibold">{rupees(total.toString())} a month</span>
                </div>

                {lines.length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {lines.map((l) => (
                      <span key={l.id} className="mr-3">
                        {l.label} {rupees(l.monthlyAmountMinor)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-destructive">
                    No salary structure. This employee would compute a payslip of nothing.
                  </p>
                )}

                {canManage ? (
                  openStructure === e.id ? (
                    <div className="space-y-2 rounded border p-3">
                      <p className="text-xs text-muted-foreground">
                        Setting an amount closes the current one the day before this takes effect.
                        Both stay on the record, so old payslips still reproduce what was actually
                        paid.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field label="Component" id={`comp-${e.id}`}>
                          <select
                            id={`comp-${e.id}`}
                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={pay.componentId}
                            onChange={(ev) => setPay({ ...pay, componentId: ev.target.value })}
                          >
                            {components.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Amount a month (₹)" id={`amt-${e.id}`}>
                          <Input
                            id={`amt-${e.id}`}
                            inputMode="decimal"
                            value={pay.rupeesAmount}
                            onChange={(ev) => setPay({ ...pay, rupeesAmount: ev.target.value })}
                          />
                        </Field>
                        <Field label="From" id={`from-${e.id}`}>
                          <Input
                            id={`from-${e.id}`}
                            type="date"
                            value={pay.effectiveFrom}
                            onChange={(ev) => setPay({ ...pay, effectiveFrom: ev.target.value })}
                          />
                        </Field>
                      </div>
                      <Input
                        placeholder="Why? (annual review, promotion, correction)"
                        value={pay.reason}
                        onChange={(ev) => setPay({ ...pay, reason: ev.target.value })}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const minor = toMinor(pay.rupeesAmount);
                              if (minor === null) {
                                toast.error("That amount is not a number of rupees.");
                                return;
                              }
                              const result = await onSetStructure({
                                employeeId: e.id,
                                componentId: pay.componentId,
                                monthlyAmountMinor: minor,
                                effectiveFrom: pay.effectiveFrom,
                                reason: pay.reason || undefined,
                              });
                              if (result.ok) {
                                toast.success(result.data.note);
                                setOpenStructure(null);
                                setPay({ ...pay, rupeesAmount: "", reason: "" });
                                router.refresh();
                              } else {
                                toast.error(result.error);
                              }
                            })
                          }
                        >
                          Set it
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setOpenStructure(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setOpenStructure(e.id)}>
                      Set what they are paid
                    </Button>
                  )
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
}

/**
 * ⚠️ RUPEES TO PAISE BY STRING, NEVER BY MULTIPLYING A FLOAT.
 * `Math.round(18500.55 * 100)` is fine and `x * 100` for arbitrary
 * decimal input is not — and the failure is a paisa in somebody's salary.
 */
function toMinor(input: string): string | null {
  const text = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return `${whole}${fraction.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
}

function Field({
  label,
  id,
  help,
  children,
}: {
  label: string;
  id: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}
