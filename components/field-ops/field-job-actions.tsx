"use client";

/**
 * Ordence — ⭐ ENGINE 3 · FIELD WRITE ACTIONS
 * Version: v0.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE STATUS BUTTONS ARE DRAWN FROM `canTransition`. THE DATABASE
 *    STILL DECIDES.
 * ══════════════════════════════════════════════════════════════════════
 * `FIELD_JOB_TRANSITIONS` is imported here for one purpose: not offering
 * a button that cannot work. Offering "Complete" on a job nobody has
 * arrived at, and then apologising, teaches a dispatcher that the system
 * is unreliable — which is how you end up with a parallel spreadsheet.
 *
 * ⚠️ BUT THIS IS A HINT, NOT THE RULE. The page rendered a moment ago;
 * since then the technician's phone may have come back into coverage and
 * replayed four hours of queued events, and the job has moved. The
 * trigger in SQL-FILES/0036 is what actually decides, and its refusal is
 * already a sentence written for a person — so it is shown verbatim
 * rather than flattened into "Could not save".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THERE IS NO PATH BACKWARDS FROM `completed`
 * ══════════════════════════════════════════════════════════════════════
 * A finished job offers exactly one control: raise a follow-up job that
 * references it. If a completed job could be reopened in place, every
 * failed first attempt would edit itself out of the first-time-fix rate —
 * the figure would trend to 100% while the business got worse, and the
 * evidence of that would be the thing being deleted.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE EVENT ID IS MINTED BEFORE THE FIRST ATTEMPT, ON THIS DEVICE
 * ══════════════════════════════════════════════════════════════════════
 * `crypto.randomUUID()` at submit time, and the SAME value on a retry. A
 * server-generated id cannot tell a retry from a second visit — to the
 * server they are two POSTs — and the customer is then billed twice. This
 * browser form is the mild case; the phone app is the real one, and both
 * go through the same column.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveFieldJob,
  setFieldJobStatus,
  recordFieldVisit,
  recordFieldProof,
  recordFieldMaterial,
  reopenFieldJob,
} from "@/server/actions/field-ops";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type JobOption = {
  id: string;
  jobNumber: string;
  title: string;
  status: string;
  isClosed: boolean;
  /** ⭐ Computed on the server from `canTransition`. Empty = terminal. */
  nextStatuses: string[];
};

type VisitOption = { id: string; jobId: string; label: string };
type Option = { id: string; name: string };

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  dispatched: "Dispatched",
  travelling: "Travelling",
  on_site: "On site",
  paused: "Paused",
  completed: "Completed",
  could_not_complete: "Could not complete",
  cancelled: "Cancelled",
};

const FAILURE_REASONS = [
  "customer_absent",
  "access_denied",
  "site_not_ready",
  "part_unavailable",
  "wrong_address",
  "unsafe_conditions",
  "weather",
  "vehicle_breakdown",
  "customer_refused",
  "other",
] as const;

const PROOF_KINDS = [
  "photo_before",
  "photo_after",
  "signature",
  "otp",
  "barcode_scan",
  "document",
  "reading",
  "note",
] as const;

function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * ⭐ The device's idempotency key, minted before the first attempt.
 *
 * ⚠️ `crypto.randomUUID()` is unavailable on insecure origins in some
 * browsers, so there is a fallback — a form that cannot mint a key must
 * not silently send none, because the column is NOT NULL and the retry
 * would then be indistinguishable from a second visit.
 */
function newEventId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type Panel = "none" | "job" | "visit" | "proof" | "material" | "status";

export function FieldJobActions({
  jobs,
  visits,
  assignees,
  customers,
  jobKinds,
  defaultJobKind,
}: {
  jobs: JobOption[];
  visits: VisitOption[];
  assignees: Option[];
  customers: Option[];
  jobKinds: string[];
  /** "housekeeping" on the hospitality variant, so a new job lands on it. */
  defaultJobKind: string | null;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("none");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** The job whose status is being moved, and the move being attempted. */
  const [statusJobId, setStatusJobId] = useState<string>(jobs[0]?.id ?? "");
  const [targetStatus, setTargetStatus] = useState<string>("");

  const statusJob = jobs.find((j) => j.id === statusJobId) ?? null;
  const openJobs = jobs.filter((j) => !j.isClosed);
  const completedJobs = jobs.filter((j) => j.status === "completed");

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
  ) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        /**
         * ⚠️ SHOWN VERBATIM. The trigger's refusal names the job, the
         * status it is in, and every legal next step. Replacing it with
         * "Could not save" throws away the only part a dispatcher can act
         * on — and this engine's whole status design rests on that
         * refusal being readable.
         */
        setError(res.error ?? "That could not be saved.");
        return;
      }
      setNotice(success);
      setPanel("none");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={panel === "job" ? "default" : "outline"}
          onClick={() => setPanel(panel === "job" ? "none" : "job")}
        >
          New job
        </Button>
        <Button
          size="sm"
          variant={panel === "status" ? "default" : "outline"}
          onClick={() => setPanel(panel === "status" ? "none" : "status")}
        >
          Move a job
        </Button>
        <Button
          size="sm"
          variant={panel === "visit" ? "default" : "outline"}
          onClick={() => setPanel(panel === "visit" ? "none" : "visit")}
        >
          Record visit
        </Button>
        <Button
          size="sm"
          variant={panel === "proof" ? "default" : "outline"}
          onClick={() => setPanel(panel === "proof" ? "none" : "proof")}
        >
          Add proof
        </Button>
        <Button
          size="sm"
          variant={panel === "material" ? "default" : "outline"}
          onClick={() => setPanel(panel === "material" ? "none" : "material")}
        >
          Record material
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-400 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {/* ── NEW JOB ──────────────────────────────────────────────────── */}
      {panel === "job" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New job</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveFieldJob({
                      title: f.get("title"),
                      description: f.get("description") || null,
                      jobKind: f.get("jobKind"),
                      priority: f.get("priority"),
                      status: f.get("status"),
                      customerCompanyId: f.get("customerCompanyId") || null,
                      siteAddress: f.get("siteAddress") || null,
                      siteLandmark: f.get("siteLandmark") || null,
                      siteLatitude: f.get("siteLatitude") || null,
                      siteLongitude: f.get("siteLongitude") || null,
                      windowStart: f.get("windowStart") || null,
                      windowEnd: f.get("windowEnd") || null,
                      estimatedMinutes: f.get("estimatedMinutes") || null,
                      assignedUserId: f.get("assignedUserId") || null,
                      crewName: f.get("crewName") || null,
                      quotedAmountMinor: f.get("quotedAmountMinor") || null,
                    }),
                  "Job raised.",
                );
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="j-title">What is the job</Label>
                <Input
                  id="j-title"
                  name="title"
                  required
                  maxLength={250}
                  placeholder="Inverter not switching over"
                />
              </div>
              <div className="space-y-1">
                {/* ⭐ The filter the hospitality board runs on. A blank or
                    misspelt kind is a job on nobody's screen. */}
                <Label htmlFor="j-kind">Kind</Label>
                <Input
                  id="j-kind"
                  name="jobKind"
                  required
                  maxLength={60}
                  defaultValue={defaultJobKind ?? jobKinds[0] ?? "service"}
                  list="field-job-kinds"
                  placeholder="installation"
                />
                <datalist id="field-job-kinds">
                  {jobKinds.map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-priority">Priority</Label>
                <select
                  id="j-priority"
                  name="priority"
                  defaultValue="standard"
                  className={SELECT_CLASS}
                >
                  {["routine", "standard", "urgent", "emergency"].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-status">Raise as</Label>
                <select
                  id="j-status"
                  name="status"
                  defaultValue="scheduled"
                  className={SELECT_CLASS}
                >
                  <option value="scheduled">Scheduled</option>
                  <option value="draft">Draft</option>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Every move after this one goes through the database.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-customer">Customer</Label>
                <select
                  id="j-customer"
                  name="customerCompanyId"
                  defaultValue=""
                  className={SELECT_CLASS}
                >
                  <option value="">—</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-assignee">Assign to</Label>
                <select
                  id="j-assignee"
                  name="assignedUserId"
                  defaultValue=""
                  className={SELECT_CLASS}
                >
                  <option value="">Unassigned</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-crew">Crew</Label>
                <Input id="j-crew" name="crewName" maxLength={120} placeholder="Van 4" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="j-address">Site address</Label>
                <Input id="j-address" name="siteAddress" maxLength={2000} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-landmark">Landmark</Label>
                <Input id="j-landmark" name="siteLandmark" maxLength={250} />
              </div>
              <div className="space-y-1">
                {/* ⚠️ Both or neither — one alone is the Gulf of Guinea,
                    and every check-in would be flagged thousands of km out. */}
                <Label htmlFor="j-lat">Site latitude</Label>
                <Input id="j-lat" name="siteLatitude" placeholder="19.0760" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-lng">Site longitude</Label>
                <Input id="j-lng" name="siteLongitude" placeholder="72.8777" />
                <p className="text-[11px] text-muted-foreground">
                  Both or neither. Only used to measure how far a check-in was.
                </p>
              </div>
              <div className="space-y-1">
                {/* ⭐ A window, not an appointment. Lateness is measured
                    against the end of it. */}
                <Label htmlFor="j-ws">Window from</Label>
                <Input id="j-ws" name="windowStart" type="datetime-local" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-we">Window to</Label>
                <Input id="j-we" name="windowEnd" type="datetime-local" />
                <p className="text-[11px] text-muted-foreground">
                  What the customer was actually told. &ldquo;Overdue&rdquo; means past this.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-est">Estimated minutes</Label>
                <Input id="j-est" name="estimatedMinutes" type="number" min={1} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="j-quote">Quoted (paise)</Label>
                <Input
                  id="j-quote"
                  name="quotedAmountMinor"
                  inputMode="numeric"
                  pattern="\d*"
                />
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="j-desc">Detail</Label>
                <Textarea id="j-desc" name="description" rows={2} maxLength={5000} />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Saving…" : "Raise job"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── MOVE A JOB ───────────────────────────────────────────────── */}
      {panel === "status" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Move a job</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="s-job">Job</Label>
                <select
                  id="s-job"
                  className={SELECT_CLASS}
                  value={statusJobId}
                  onChange={(e) => {
                    setStatusJobId(e.target.value);
                    setTargetStatus("");
                  }}
                >
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.jobNumber} — {j.title} ({STATUS_LABEL[j.status] ?? j.status})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {statusJob && statusJob.nextStatuses.length === 0 && (
              <div className="space-y-2 rounded-md border px-4 py-3 text-sm">
                <p className="font-medium">
                  {STATUS_LABEL[statusJob.status] ?? statusJob.status} is final.
                </p>
                <p className="text-muted-foreground">
                  Nothing moves out of it. If the work came back, raise a
                  follow-up job that references this one — that way the failed
                  first attempt stays in the record, which is the only reason
                  the first-time-fix rate means anything.
                </p>
                {statusJob.status === "completed" && (
                  <form
                    className="flex flex-wrap items-end gap-2 pt-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      run(
                        () =>
                          reopenFieldJob({
                            id: statusJob.id,
                            reason: f.get("reason"),
                          }),
                        "Follow-up job raised against the completed one.",
                      );
                    }}
                  >
                    <div className="min-w-[18rem] flex-1 space-y-1">
                      <Label htmlFor="s-reopen">What came back</Label>
                      <Input
                        id="s-reopen"
                        name="reason"
                        required
                        maxLength={1000}
                        placeholder="Same fault reported four days later"
                      />
                    </div>
                    <Button type="submit" size="sm" disabled={pending}>
                      {pending ? "Raising…" : "Raise follow-up job"}
                    </Button>
                  </form>
                )}
              </div>
            )}

            {statusJob && statusJob.nextStatuses.length > 0 && (
              <form
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run(
                    () =>
                      setFieldJobStatus({
                        id: statusJob.id,
                        status: f.get("status"),
                        failureReason: f.get("failureReason") || null,
                        failureNote: f.get("failureNote") || null,
                      }),
                    "Job moved.",
                  );
                }}
              >
                <div className="space-y-1">
                  {/* ⭐ Only the moves the transition table permits are
                      offered. The database still has the final word. */}
                  <Label htmlFor="s-status">Move to</Label>
                  <select
                    id="s-status"
                    name="status"
                    className={SELECT_CLASS}
                    value={targetStatus || statusJob.nextStatuses[0]}
                    onChange={(e) => setTargetStatus(e.target.value)}
                  >
                    {statusJob.nextStatuses.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s] ?? s}
                      </option>
                    ))}
                  </select>
                </div>

                {(targetStatus || statusJob.nextStatuses[0]) ===
                  "could_not_complete" && (
                  <>
                    <div className="space-y-1">
                      {/* ⚠️ REQUIRED. The database refuses the move without
                          it, and "closed" is not "completed". */}
                      <Label htmlFor="s-reason">Why not</Label>
                      <select
                        id="s-reason"
                        name="failureReason"
                        required
                        defaultValue="customer_absent"
                        className={SELECT_CLASS}
                      >
                        {FAILURE_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {humanise(r)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="s-note">Detail</Label>
                      <Input
                        id="s-note"
                        name="failureNote"
                        maxLength={2000}
                        placeholder="Gate locked, security had no key"
                      />
                    </div>
                  </>
                )}

                <div className="sm:col-span-2 lg:col-span-3">
                  <Button type="submit" size="sm" disabled={pending}>
                    {pending ? "Moving…" : "Move job"}
                  </Button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Completing a job needs a checked-in visit against it. That
                    is enforced in the database, not here — a job closed with
                    nobody having arrived looks identical to one that went
                    perfectly.
                  </p>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── RECORD A VISIT ───────────────────────────────────────────── */}
      {panel === "visit" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Record a visit</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  async () => {
                    const res = await recordFieldVisit({
                      jobId: f.get("jobId"),
                      // ⭐ Minted here, on the device, before the attempt.
                      clientEventId: newEventId(),
                      checkedInAt: f.get("checkedInAt") || null,
                      checkedInLatitude: f.get("checkedInLatitude") || null,
                      checkedInLongitude: f.get("checkedInLongitude") || null,
                      checkedInAccuracyM: f.get("checkedInAccuracyM") || null,
                      checkedOutAt: f.get("checkedOutAt") || null,
                      technicianUserId: f.get("technicianUserId") || null,
                      notes: f.get("notes") || null,
                    });
                    if (res.ok && res.data.deduplicated) {
                      setNotice(
                        "That event had already been recorded. The retry was absorbed — one visit, not two.",
                      );
                    }
                    return res;
                  },
                  "Visit recorded.",
                );
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="v-job">Job</Label>
                <select id="v-job" name="jobId" required className={SELECT_CLASS}>
                  {openJobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.jobNumber} — {j.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="v-tech">Technician</Label>
                <select
                  id="v-tech"
                  name="technicianUserId"
                  defaultValue=""
                  className={SELECT_CLASS}
                >
                  <option value="">Me</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                {/* ⚠️ The DEVICE clock, not the server's. A visit synced at
                    18:40 that happened at 11:05 is an 11:05 visit. */}
                <Label htmlFor="v-in">Checked in at</Label>
                <Input id="v-in" name="checkedInAt" type="datetime-local" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="v-out">Checked out at</Label>
                <Input id="v-out" name="checkedOutAt" type="datetime-local" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="v-acc">GPS accuracy (m)</Label>
                <Input id="v-acc" name="checkedInAccuracyM" type="number" min={0} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="v-lat">Check-in latitude</Label>
                <Input id="v-lat" name="checkedInLatitude" placeholder="19.0760" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="v-lng">Check-in longitude</Label>
                <Input id="v-lng" name="checkedInLongitude" placeholder="72.8777" />
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="v-notes">Notes</Label>
                <Textarea id="v-notes" name="notes" rows={2} maxLength={2000} />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button
                  type="submit"
                  size="sm"
                  disabled={pending || openJobs.length === 0}
                >
                  {pending ? "Recording…" : "Record visit"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  A check-in far from the site is recorded and flagged for a
                  supervisor, never refused. GPS in a basement is wrong by
                  hundreds of metres, and refusing the check-in does not stop
                  the work — it stops the work being written down.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── ADD PROOF ────────────────────────────────────────────────── */}
      {panel === "proof" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Add proof of service</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const visitId = String(f.get("visitId") ?? "");
                const visit = visits.find((v) => v.id === visitId);
                run(
                  async () => {
                    const res = await recordFieldProof({
                      jobId: visit?.jobId ?? "",
                      visitId,
                      kind: f.get("kind"),
                      value: f.get("value") || null,
                      storageKey: f.get("storageKey") || null,
                      acceptedByName: f.get("acceptedByName") || null,
                      otpVerified: f.get("otpVerified") === "on",
                      capturedAt: f.get("capturedAt") || null,
                      clientEventId: newEventId(),
                    });
                    if (res.ok && res.data.deduplicated) {
                      setNotice("That proof had already been recorded. The retry was absorbed.");
                    }
                    return res;
                  },
                  "Proof recorded. It cannot be edited or removed.",
                );
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                {/* ⭐ Proof attaches to a VISIT, not to a job in general —
                    which trip produced it is half of what it proves. */}
                <Label htmlFor="p-visit">Visit</Label>
                <select id="p-visit" name="visitId" required className={SELECT_CLASS}>
                  {visits.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-kind">Kind</Label>
                <select id="p-kind" name="kind" defaultValue="photo_after" className={SELECT_CLASS}>
                  {PROOF_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {humanise(k)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-value">Value</Label>
                <Input
                  id="p-value"
                  name="value"
                  maxLength={5000}
                  placeholder="Meter reading, scanned code, note"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-key">Storage key</Label>
                <Input id="p-key" name="storageKey" maxLength={500} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-at">Captured at</Label>
                <Input id="p-at" name="capturedAt" type="datetime-local" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-by">Accepted by</Label>
                <Input id="p-by" name="acceptedByName" maxLength={200} />
              </div>
              <div className="flex items-end gap-2">
                {/* ⭐ The VERDICT only. The code itself is never stored —
                    otherwise anyone with read access could reconstruct an
                    acceptance, which is the whole point of sending it to
                    the customer's own number. */}
                <input id="p-otp" name="otpVerified" type="checkbox" className="h-4 w-4" />
                <Label htmlFor="p-otp" className="text-sm font-normal">
                  OTP verified on the customer&rsquo;s own number
                </Label>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || visits.length === 0}>
                  {pending ? "Recording…" : "Add proof"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  This is append-only. There is no edit and no delete, in the
                  application or in the database — a photo that can be replaced
                  afterwards is not evidence, it is a picture. A correction is a
                  new record alongside the old one.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── RECORD MATERIAL ──────────────────────────────────────────── */}
      {panel === "material" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Record material</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    recordFieldMaterial({
                      jobId: f.get("jobId"),
                      visitId: f.get("visitId") || null,
                      itemCode: f.get("itemCode"),
                      itemName: f.get("itemName"),
                      quantity: f.get("quantity"),
                      unit: f.get("unit") || "nos",
                      unitCostMinor: f.get("unitCostMinor") || "0",
                      isBillable: f.get("isBillable") === "on",
                      isWarranty: f.get("isWarranty") === "on",
                      serialNumber: f.get("serialNumber") || null,
                    }),
                  "Material recorded.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="m-job">Job</Label>
                <select id="m-job" name="jobId" required className={SELECT_CLASS}>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.jobNumber} — {j.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                {/* ⭐ Against the trip, where possible. A part fitted on
                    visit two and returned on visit three is two movements. */}
                <Label htmlFor="m-visit">Visit</Label>
                <select id="m-visit" name="visitId" defaultValue="" className={SELECT_CLASS}>
                  <option value="">Not tied to a visit</option>
                  {visits.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-code">Item code</Label>
                <Input id="m-code" name="itemCode" required maxLength={100} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-name">Item name</Label>
                <Input id="m-name" name="itemName" required maxLength={250} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-qty">Quantity</Label>
                <Input id="m-qty" name="quantity" required defaultValue="1" />
                <p className="text-[11px] text-muted-foreground">
                  Negative returns a part to van stock. Zero is refused.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-unit">Unit</Label>
                <Input id="m-unit" name="unit" defaultValue="nos" maxLength={20} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-cost">Unit cost (paise)</Label>
                <Input
                  id="m-cost"
                  name="unitCostMinor"
                  inputMode="numeric"
                  pattern="-?\d*"
                  defaultValue="0"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-serial">Serial number</Label>
                <Input id="m-serial" name="serialNumber" maxLength={120} />
              </div>
              <div className="flex items-end gap-4">
                <span className="flex items-center gap-2">
                  <input
                    id="m-bill"
                    name="isBillable"
                    type="checkbox"
                    defaultChecked
                    className="h-4 w-4"
                  />
                  <Label htmlFor="m-bill" className="text-sm font-normal">
                    Billable
                  </Label>
                </span>
                <span className="flex items-center gap-2">
                  {/* ⚠️ Stated, never inferred from the billable flag. */}
                  <input id="m-warr" name="isWarranty" type="checkbox" className="h-4 w-4" />
                  <Label htmlFor="m-warr" className="text-sm font-normal">
                    Warranty
                  </Label>
                </span>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || jobs.length === 0}>
                  {pending ? "Recording…" : "Record material"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {completedJobs.length > 0 && panel === "none" && (
        <p className="text-xs text-muted-foreground">
          {completedJobs.length} completed job
          {completedJobs.length === 1 ? "" : "s"} — completed is final. Work that
          comes back is a new job referencing the old one, under &ldquo;Move a
          job&rdquo;.
        </p>
      )}
    </div>
  );
}
