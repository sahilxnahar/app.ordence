"use client";

/**
 * Ordence — Site labour client actions
 * Version: v0.73.0-alpha
 *
 * ⚠️ THE ADMISSIBILITY REFUSAL IS THE MOST IMPORTANT THING ON THIS
 * SCREEN, and it is shown in full. "This worker is not admissible" with
 * no reason gets a supervisor to click something else until it works.
 * The reason — an unverified UAN — tells them what to fix.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  registerSiteWorker,
  verifyWorkerUan,
  recordSiteAttendance,
  upsertDailySiteLog,
  recordPieceRateEntry,
} from "@/server/actions/labour";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type Option = { id: string; name: string };
export type WorkerRow = {
  id: string;
  workerName: string;
  trade: string | null;
  uan: string | null;
  uanStatus: string;
  isAdmissible: boolean;
  blockedReason: string | null;
};

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

export function RegisterWorkerForm({
  projects,
  vendors,
}: {
  projects: Option[];
  vendors: Option[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await registerSiteWorker({
        workerName: String(formData.get("workerName") ?? ""),
        trade: String(formData.get("trade") ?? "") || null,
        projectId: String(formData.get("projectId") ?? "") || null,
        vendorId: String(formData.get("vendorId") ?? "") || null,
        uan: String(formData.get("uan") ?? "") || null,
        phone: String(formData.get("phone") ?? "") || null,
        inductedOn: String(formData.get("inductedOn") ?? "") || null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(
        "Registered. The worker is NOT yet admissible to site — their UAN has to be " +
          "verified first.",
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Register a worker</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="workerName">Name</Label>
              <Input id="workerName" name="workerName" required maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="trade">Trade</Label>
              <Input id="trade" name="trade" maxLength={100} placeholder="Mason, bar bender…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="uan">UAN (12 digits)</Label>
              <Input id="uan" name="uan" maxLength={12} inputMode="numeric" />
              <p className="text-xs text-muted-foreground">
                Leave blank if not applicable. A typed UAN is a claim, not a verification.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" maxLength={20} inputMode="tel" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="projectId">Project</Label>
              <select
                id="projectId"
                name="projectId"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">—</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vendorId">Labour contractor</Label>
              <select
                id="vendorId"
                name="vendorId"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">—</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inductedOn">Inducted on</Label>
              <Input id="inductedOn" name="inductedOn" type="date" />
            </div>
          </div>

          {error && <Refusal message={error} />}
          {done && <Done message={done} />}

          <Button type="submit" disabled={pending}>
            {pending ? "Registering…" : "Register worker"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export function WorkerRowActions({ worker }: { worker: WorkerRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [showReject, setShowReject] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "That did not work.");
        return;
      }
      setShowReject(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {!worker.isAdmissible && (
          <>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(() => verifyWorkerUan({ workerId: worker.id, outcome: "valid" }))
              }
            >
              UAN verified
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() =>
                  verifyWorkerUan({ workerId: worker.id, outcome: "not_applicable" }),
                )
              }
            >
              Not applicable
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => setShowReject((v) => !v)}
            >
              Reject
            </Button>
          </>
        )}

        {worker.isAdmissible && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() => recordSiteAttendance({ workerId: worker.id, kind: "check_in" }))
              }
            >
              Check in
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() => recordSiteAttendance({ workerId: worker.id, kind: "check_out" }))
              }
            >
              Check out
            </Button>
          </>
        )}
      </div>

      {showReject && (
        <div className="space-y-2">
          <Label htmlFor={`reject-${worker.id}`} className="text-xs">
            Why is the UAN being rejected?
          </Label>
          <Input
            id={`reject-${worker.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
          />
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              run(() =>
                verifyWorkerUan({
                  workerId: worker.id,
                  outcome: "invalid",
                  rejectionReason: reason,
                }),
              )
            }
          >
            Confirm rejection
          </Button>
        </div>
      )}

      {error && <Refusal message={error} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function DailySiteLogForm({ projects }: { projects: Option[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (projects.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No projects yet. A site log belongs to a site.
      </p>
    );
  }

  function onSubmit(formData: FormData) {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await upsertDailySiteLog({
        projectId: String(formData.get("projectId") ?? ""),
        logDate: String(formData.get("logDate") ?? ""),
        weather: String(formData.get("weather") ?? "") || null,
        rainfallMm: String(formData.get("rainfallMm") ?? "") || null,
        hoursLost: String(formData.get("hoursLost") ?? "") || null,
        labourCount: Number(formData.get("labourCount") ?? 0),
        workDone: String(formData.get("workDone") ?? "") || null,
        issues: String(formData.get("issues") ?? "") || null,
        visitors: String(formData.get("visitors") ?? "") || null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(res.data.created ? "Site log recorded." : "Site log updated for that date.");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Daily site log</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-xs text-muted-foreground">
          ⚠️ This is an extension-of-time document. &ldquo;It rained on the 14th and we
          lost six hours&rdquo; is worth more on a delayed contract than the day&rsquo;s
          work. One log per project per day — saving again updates that day.
        </p>
        <form action={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="log-projectId">Project</Label>
              <select
                id="log-projectId"
                name="projectId"
                required
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="logDate">Date</Label>
              <Input id="logDate" name="logDate" type="date" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="labourCount">Labour on site</Label>
              <Input
                id="labourCount"
                name="labourCount"
                type="number"
                min={0}
                defaultValue={0}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="weather">Weather</Label>
              <Input id="weather" name="weather" maxLength={100} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rainfallMm">Rainfall (mm)</Label>
              <Input id="rainfallMm" name="rainfallMm" inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hoursLost">Hours lost</Label>
              <Input id="hoursLost" name="hoursLost" inputMode="decimal" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="workDone">Work done</Label>
            <textarea
              id="workDone"
              name="workDone"
              rows={2}
              maxLength={8000}
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="issues">Issues</Label>
              <textarea
                id="issues"
                name="issues"
                rows={2}
                maxLength={8000}
                className="w-full rounded-md border border-input bg-background p-2 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="visitors">Visitors</Label>
              <textarea
                id="visitors"
                name="visitors"
                rows={2}
                maxLength={4000}
                className="w-full rounded-md border border-input bg-background p-2 text-sm"
              />
            </div>
          </div>

          {error && <Refusal message={error} />}
          {done && <Done message={done} />}

          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save site log"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export function PieceRateForm({
  projects,
  vendors,
}: {
  projects: Option[];
  vendors: Option[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (projects.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No projects yet.
      </p>
    );
  }

  function onSubmit(formData: FormData) {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await recordPieceRateEntry({
        projectId: String(formData.get("projectId") ?? ""),
        vendorId: String(formData.get("vendorId") ?? "") || null,
        workItem: String(formData.get("workItem") ?? ""),
        unit: String(formData.get("unit") ?? "sqft"),
        quantity: String(formData.get("quantity") ?? ""),
        ratePerUnit: String(formData.get("ratePerUnit") ?? ""),
        measuredOn: String(formData.get("measuredOn") ?? ""),
        witnessedByName: String(formData.get("witnessedByName") ?? "") || null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(`Recorded. ₹${res.data.amount}.`);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Record measured piece work</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-xs text-muted-foreground">
          ⚠️ You are recorded as the person who measured this. That is not a form field on
          purpose — whoever measured has to be whoever was there, and it is that name the
          contractor&rsquo;s claim will quote back.
        </p>
        <form action={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="pr-projectId">Project</Label>
              <select
                id="pr-projectId"
                name="projectId"
                required
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pr-vendorId">Labour contractor</Label>
              <select
                id="pr-vendorId"
                name="vendorId"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">—</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="measuredOn">Measured on</Label>
              <Input id="measuredOn" name="measuredOn" type="date" required />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="workItem">Work item</Label>
            <Input id="workItem" name="workItem" required maxLength={300} />
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="quantity">Quantity</Label>
              <Input id="quantity" name="quantity" inputMode="decimal" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="unit">Unit</Label>
              <Input id="unit" name="unit" defaultValue="sqft" maxLength={20} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ratePerUnit">Rate ₹ / unit</Label>
              <Input id="ratePerUnit" name="ratePerUnit" inputMode="decimal" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="witnessedByName">Witnessed by</Label>
              <Input id="witnessedByName" name="witnessedByName" maxLength={200} />
            </div>
          </div>

          {error && <Refusal message={error} />}
          {done && <Done message={done} />}

          <Button type="submit" disabled={pending}>
            {pending ? "Recording…" : "Record measurement"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
