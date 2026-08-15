"use client";

/**
 * Ordence — ⭐⭐⭐ THE ATTENDANCE GRID
 * Version: v1.46.0-alpha · Batch 59
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE ONLY SCREEN IN THE PRODUCT THAT MOVES SOMEBODY'S PAY BY
 * ACCIDENT
 * ══════════════════════════════════════════════════════════════════════
 * Every row saved here is a day of somebody's salary. A misplaced click
 * on `absent` costs a real person a real day, and nothing downstream will
 * question it: the payroll run reads the number and prints a payslip.
 *
 * ⭐ SO THE SCREEN DOES THREE THINGS DELIBERATELY.
 *
 *   ① IT DEFAULTS TO NOTHING. There is no "mark everybody present"
 *      button and no pre-filled month. An employee with no attendance row
 *      is paid a full month, which is the correct default — most salaried
 *      staff are never marked present at all — and a grid that pre-filled
 *      thirty days would turn one careless save into thirty facts.
 *
 *   ② IT SHOWS THE LOSS OF PAY IT IS ABOUT TO CHARGE, in days, before
 *      the save. "3 days of loss of pay across 2 people" is a sentence
 *      somebody can disagree with; a grid of coloured cells is not.
 *
 *   ③ IT SAYS WHAT FREEZES. Once the payroll run covering these dates is
 *      approved, the database refuses any further change — and it is
 *      better to read that here than to meet it as an error.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type StaffRow = { id: string; employeeCode: string; fullName: string };
export type LeaveTypeOption = { id: string; code: string; label: string; isPaid: boolean };

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type Draft = {
  employeeId: string;
  onDate: string;
  status: string;
  lopFraction: string;
  leaveTypeId: string | null;
};

const STATUSES = [
  { value: "present", label: "Present", lop: "0.00" },
  { value: "on_duty", label: "On duty elsewhere", lop: "0.00" },
  { value: "weekly_off", label: "Weekly off", lop: "0.00" },
  { value: "holiday", label: "Declared holiday", lop: "0.00" },
  { value: "paid_leave", label: "Paid leave", lop: "0.00" },
  { value: "unpaid_leave", label: "Unpaid leave", lop: "1.00" },
  { value: "absent", label: "Absent — unexplained", lop: "1.00" },
] as const;

export function AttendanceGrid({
  staff,
  leaveTypes,
  canRecord,
  onRecord,
}: {
  staff: StaffRow[];
  leaveTypes: LeaveTypeOption[];
  canRecord: boolean;
  onRecord: (
    input: unknown,
  ) => Promise<Result<{ written: number; ledgerEntries: number; note: string }>>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [employeeId, setEmployeeId] = useState(staff[0]?.id ?? "");
  const [onDate, setOnDate] = useState("");
  const [status, setStatus] = useState<string>("absent");
  const [lopFraction, setLopFraction] = useState("1.00");
  const [leaveTypeId, setLeaveTypeId] = useState<string>("");

  /**
   * ⭐ THE TOTAL, RECOMPUTED FROM THE DRAFTS AND NEVER STORED. Same rule
   * as the balance: a running total kept in its own piece of state is one
   * `setState` away from disagreeing with the rows it claims to sum.
   */
  const totalLop = useMemo(
    () => drafts.reduce((t, d) => t + Number(d.lopFraction || "0"), 0),
    [drafts],
  );
  const peopleAffected = useMemo(
    () => new Set(drafts.filter((d) => Number(d.lopFraction) > 0).map((d) => d.employeeId)).size,
    [drafts],
  );

  if (!canRecord) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            You can see the attendance register but not change it. Recording attendance decides
            whether somebody is paid for a day, so it is a separate permission from reading it.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Record attendance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Only record the days that were not ordinary. Somebody with no row here is paid a full
          month, which is right — most salaried staff are never marked present at all.
        </p>

        <div className="flex flex-wrap gap-2">
          <select
            className="rounded border px-2 py-1 text-sm"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName} ({s.employeeCode})
              </option>
            ))}
          </select>
          <input
            type="date"
            className="rounded border px-2 py-1 text-sm"
            value={onDate}
            onChange={(e) => setOnDate(e.target.value)}
          />
          <select
            className="rounded border px-2 py-1 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              const found = STATUSES.find((s) => s.value === e.target.value);
              setLopFraction(found?.lop ?? "0.00");
            }}
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {status === "paid_leave" || status === "unpaid_leave" ? (
            <select
              className="rounded border px-2 py-1 text-sm"
              value={leaveTypeId}
              onChange={(e) => setLeaveTypeId(e.target.value)}
            >
              <option value="">Which leave type?</option>
              {leaveTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          ) : null}
          <label className="flex items-center gap-1 text-xs">
            Loss of pay
            <input
              className="w-16 rounded border px-2 py-1 text-sm"
              value={lopFraction}
              onChange={(e) => setLopFraction(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!employeeId || !onDate}
            onClick={() => {
              setDrafts((d) => [
                ...d.filter((x) => !(x.employeeId === employeeId && x.onDate === onDate)),
                { employeeId, onDate, status, lopFraction, leaveTypeId: leaveTypeId || null },
              ]);
              setOnDate("");
            }}
          >
            Add to the list
          </Button>
        </div>

        {/*
          🔴 A HALF DAY OF LOSS OF PAY ON PAID LEAVE IS A REAL CASE AND
          THE FIELD IS EDITABLE FOR IT. Somebody taking a full day against
          half a day of remaining balance is half leave and half loss of
          pay, and a model that derived the fraction from the status
          alone could not say so.
        */}
        <p className="text-xs text-muted-foreground">
          Loss of pay is editable on purpose. A full day taken against half a day of remaining
          balance is half leave and half loss of pay.
        </p>

        {drafts.length > 0 ? (
          <div className="space-y-2 rounded border p-2">
            {drafts.map((d) => (
              <div key={`${d.employeeId}-${d.onDate}`} className="flex items-center gap-2 text-xs">
                <span className="flex-1">
                  {staff.find((s) => s.id === d.employeeId)?.fullName} · {d.onDate} · {d.status}
                </span>
                <span className="tabular-nums">{d.lopFraction} day loss of pay</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDrafts((rows) =>
                      rows.filter(
                        (x) => !(x.employeeId === d.employeeId && x.onDate === d.onDate),
                      ),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <p className="rounded border border-amber-500 p-2 text-xs">
              This will charge {totalLop.toFixed(2)} days of loss of pay across {peopleAffected}{" "}
              {peopleAffected === 1 ? "person" : "people"}. Once the payroll run covering these
              dates is approved, the register for them is frozen and a correction has to go
              through the next month&apos;s payroll.
            </p>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await onRecord({ rows: drafts });
                  if (result.ok) {
                    toast.success(`${result.data.written} days recorded.`, {
                      description: result.data.note,
                    });
                    setDrafts([]);
                    router.refresh();
                  } else {
                    toast.error(result.error);
                  }
                })
              }
            >
              Record {drafts.length} {drafts.length === 1 ? "day" : "days"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
