"use client";

/**
 * Ordence — ⭐ ENGINE 4 · COMPLIANCE WRITE ACTIONS
 * Version: v0.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NOTHING ON THIS COMPONENT ASKS FOR A DUE DATE
 * ══════════════════════════════════════════════════════════════════════
 * Look for it — there is no date input on the deadline form. The form
 * collects the PERIOD ("July 2026"), and the database derives the due
 * date from that period and the obligation's own rule.
 *
 * That is not a saving of one field. GSTR-3B for July is due on 20
 * August, always — not twenty days after somebody created the row, and
 * not whatever they typed while looking at a different month. And an
 * obligation due "on the 31st" falls on the 30th in a 30-day month and
 * the 28th in February; the trigger clamps day 31 to the month's real
 * last day, so "31" reads as "the last day" correctly everywhere. A
 * hand-typed date gets that wrong roughly once a year, quietly, and
 * nothing in the register contradicts it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND NOTHING HERE COMPUTES A LATE FEE
 * ══════════════════════════════════════════════════════════════════════
 * Days late and the fee are computed by the completion trigger from the
 * dates and the obligation's stated rate and cap. The figures that come
 * back after saving are the database's, not an estimate made here — last
 * year's penalty must not change when this year's rate does.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO DELETE BUTTON ON THIS PAGE, FOR ANYTHING
 * ══════════════════════════════════════════════════════════════════════
 * Evidence cannot be deleted at all — the app role holds no DELETE
 * privilege on `compliance_evidence` (an explicit REVOKE in SQL 0032).
 * Completed and missed tasks cannot be deleted either. A compliance
 * register you can tidy is a register no inspector accepts, so the
 * corrections offered here are the ones that leave a trail: supersede
 * the document, mark the period not-applicable with a reason.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveComplianceObligation,
  deactivateComplianceObligation,
  generateComplianceTasks,
  completeComplianceTask,
  exemptComplianceTask,
  attachComplianceEvidence,
} from "@/server/actions/compliance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ObligationOption = {
  id: string;
  code: string;
  name: string;
  frequency: string;
  isActive: boolean;
  subjectCompanyId: string | null;
};

type CompanyOption = { id: string; name: string };

type TaskOption = {
  id: string;
  obligationName: string;
  periodLabel: string;
  status: string;
  dueDate: string | null;
};

type Panel =
  | "none"
  | "obligation"
  | "generate"
  | "complete"
  | "exempt"
  | "evidence"
  | "deactivate";

const SELECT = "h-9 w-full rounded-md border bg-background px-3 text-sm";

const AUTHORITIES = [
  "gst", "income_tax", "mca_roc", "epfo", "esic", "labour",
  "professional_tax", "customs", "rbi", "sebi", "fssai",
  "pollution_control", "fire", "municipal", "transport_rto",
  "electricity_cea", "health_nmc", "drugs_licensing", "aerb",
  "state_excise", "legal_metrology", "internal", "other",
];

const FREQUENCIES = [
  "monthly", "quarterly", "half_yearly", "annual", "one_time", "event_based",
];

const SEVERITIES = ["informational", "low", "medium", "high", "critical"];

/** Statuses that are already settled — nothing left to file. */
const SETTLED = new Set(["filed", "late_filed", "not_applicable", "waived"]);

/**
 * ⭐ THE SUBJECT PICKER, AND WHY IT HAS NO DEFAULT.
 *
 * ⚠️ `subject_company_id` NULL means "mine"; set means "a client's". Both
 * are ordinary, and a select that starts on "mine" is a select people
 * stop reading — after which a client's GST return is filed under the
 * practice's own name, counted in the wrong half of the board and chased
 * by nobody.
 *
 * The specific failure this exists to prevent runs the other way too: a
 * CA firm that files four hundred client returns on time and misses its
 * own ROC filing, because its own four obligations were lost in a list of
 * six hundred that all looked the same.
 */
function SubjectPicker({
  idPrefix,
  companies,
}: {
  idPrefix: string;
  companies: CompanyOption[];
}) {
  const [mode, setMode] = useState<"" | "own" | "client">("");

  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-subject`}>Whose obligation is this?</Label>
        <select
          id={`${idPrefix}-subject`}
          name="subjectMode"
          required
          value={mode}
          onChange={(e) => setMode(e.target.value as "" | "own" | "client")}
          className={SELECT}
        >
          <option value="" disabled>
            Choose — this is never assumed
          </option>
          <option value="own">Yours</option>
          <option value="client">A client&apos;s</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-company`}>Client</Label>
        <select
          id={`${idPrefix}-company`}
          name="subjectCompanyId"
          disabled={mode !== "client"}
          required={mode === "client"}
          defaultValue=""
          className={SELECT}
        >
          <option value="">
            {companies.length === 0 ? "No companies on record" : "Choose a client"}
          </option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          Your own filings and your clients&apos; are counted separately on the
          board. That split is the only thing that stops a practice missing
          its own return while filing four hundred others on time.
        </p>
      </div>
    </>
  );
}

export function ComplianceActions({
  obligations,
  companies,
  tasks,
}: {
  obligations: ObligationOption[];
  companies: CompanyOption[];
  tasks: TaskOption[];
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("none");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const openTasks = tasks.filter((t) => !SETTLED.has(t.status));
  const activeObligations = obligations.filter((o) => o.isActive);

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
         * ⚠️ THE DATABASE'S REFUSAL IS SHOWN VERBATIM. Every rule in this
         * engine is a trigger, and the trigger messages are written for a
         * person: "Cannot mark 'Jul 2026' as filed without a filing
         * reference (ARN / challan / receipt number)". Replacing that with
         * "Could not save" throws away the only part that says what to do.
         */
        setError(res.error ?? "That could not be saved.");
        return;
      }
      setNotice(success);
      setPanel("none");
      router.refresh();
    });
  }

  function taskLabel(t: TaskOption): string {
    return `${t.obligationName} · ${t.periodLabel}${
      t.dueDate ? ` · due ${t.dueDate}` : ""
    }${t.status === "missed" ? " · MISSED" : ""}`;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={panel === "generate" ? "default" : "outline"}
          onClick={() => setPanel(panel === "generate" ? "none" : "generate")}
        >
          Generate deadlines
        </Button>
        <Button
          size="sm"
          variant={panel === "complete" ? "default" : "outline"}
          onClick={() => setPanel(panel === "complete" ? "none" : "complete")}
        >
          Record a filing
        </Button>
        <Button
          size="sm"
          variant={panel === "obligation" ? "default" : "outline"}
          onClick={() => setPanel(panel === "obligation" ? "none" : "obligation")}
        >
          Add obligation
        </Button>
        <Button
          size="sm"
          variant={panel === "evidence" ? "default" : "outline"}
          onClick={() => setPanel(panel === "evidence" ? "none" : "evidence")}
        >
          Attach evidence
        </Button>
        <Button
          size="sm"
          variant={panel === "exempt" ? "default" : "outline"}
          onClick={() => setPanel(panel === "exempt" ? "none" : "exempt")}
        >
          Did not apply
        </Button>
        <Button
          size="sm"
          variant={panel === "deactivate" ? "default" : "ghost"}
          onClick={() => setPanel(panel === "deactivate" ? "none" : "deactivate")}
        >
          Stop an obligation
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

      {/* ── GENERATE. The period, never the due date. ───────────────── */}
      {panel === "generate" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Generate deadlines</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(async () => {
                  const r = await generateComplianceTasks({
                    obligationId: f.get("obligationId"),
                    periodStart: f.get("periodStart"),
                    periods: f.get("periods"),
                    periodLabel: f.get("periodLabel") || null,
                  });
                  if (r.ok) {
                    setNotice(
                      `${r.data.created} deadline(s) generated${
                        r.data.skipped > 0
                          ? `, ${r.data.skipped} already existed`
                          : ""
                      }${
                        r.data.firstDueDate
                          ? ` · first one falls due ${r.data.firstDueDate}`
                          : ""
                      }.`,
                    );
                  }
                  return r;
                }, "Deadlines generated.");
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="g-obligation">Obligation</Label>
                <select
                  id="g-obligation"
                  name="obligationId"
                  required
                  defaultValue=""
                  className={SELECT}
                >
                  <option value="" disabled>
                    Choose an obligation
                  </option>
                  {activeObligations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.frequency.replace("_", " ")}
                      {o.subjectCompanyId === null ? " · yours" : " · a client's"})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                {/* ⚠️ THE PERIOD, NOT THE DEADLINE. See the file header. */}
                <Label htmlFor="g-start">First period starts</Label>
                <Input id="g-start" name="periodStart" type="date" required />
                <p className="text-[11px] text-muted-foreground">
                  The due date is worked out by the database from this period
                  and the obligation&apos;s own rule — including the day-31
                  clamp, so an obligation due on the 31st lands on the 28th in
                  February rather than failing.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="g-count">How many periods</Label>
                <Input
                  id="g-count"
                  name="periods"
                  type="number"
                  min={1}
                  max={36}
                  defaultValue={12}
                />
                <p className="text-[11px] text-muted-foreground">
                  Generating ahead is the point: the reminder ladder counts back
                  from a due date, and a deadline that does not exist yet has no
                  date to count back from. Running this twice is safe — existing
                  periods are skipped, never duplicated.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="g-label">Label for the first period</Label>
                <Input
                  id="g-label"
                  name="periodLabel"
                  maxLength={60}
                  placeholder="Q2 FY27 (optional)"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button
                  type="submit"
                  size="sm"
                  disabled={pending || activeObligations.length === 0}
                >
                  {pending ? "Generating…" : "Generate"}
                </Button>
                {activeObligations.length === 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No active obligations yet. Add one first — an obligation is
                    the rule; a deadline is generated from it.
                  </p>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── COMPLETE. `missed` is terminal; this records late_filed. ── */}
      {panel === "complete" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Record a filing</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(async () => {
                  const r = await completeComplianceTask({
                    id: f.get("id"),
                    filingReference: f.get("filingReference"),
                    notes: f.get("notes") || null,
                  });
                  if (r.ok) {
                    setNotice(
                      r.data.status === "late_filed"
                        ? `Recorded as FILED LATE — ${r.data.daysLate} day(s) late. The late fee was computed by the database from the obligation's own rate.`
                        : "Recorded as filed, on time.",
                    );
                  }
                  return r;
                }, "Filing recorded.");
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="c-task">Deadline</Label>
                <select id="c-task" name="id" required defaultValue="" className={SELECT}>
                  <option value="" disabled>
                    Choose the deadline you filed
                  </option>
                  {openTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {taskLabel(t)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                {/* ⚠️ Required, and the database refuses it empty. */}
                <Label htmlFor="c-ref">Acknowledgement</Label>
                <Input
                  id="c-ref"
                  name="filingReference"
                  required
                  maxLength={200}
                  placeholder="ARN / challan / SRN"
                />
                <p className="text-[11px] text-muted-foreground">
                  A filing you cannot quote a reference for is a filing you
                  cannot prove. The database refuses one without it.
                </p>
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="c-notes">Notes</Label>
                <Textarea id="c-notes" name="notes" rows={2} maxLength={5000} />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button
                  type="submit"
                  size="sm"
                  disabled={pending || openTasks.length === 0}
                >
                  {pending ? "Saving…" : "Record filing"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  ⚠️ A missed deadline does not go back to pending. Filing it
                  now records it as <span className="font-medium">filed late</span>,
                  with the days late and the fee computed from the dates — not
                  from what was selected here. The pattern of late filings is
                  the only warning that comes before a missed one.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── OBLIGATION. The rule, not the deadline. ─────────────────── */}
      {panel === "obligation" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Add obligation</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveComplianceObligation({
                      code: f.get("code"),
                      name: f.get("name"),
                      authority: f.get("authority"),
                      frequency: f.get("frequency"),
                      severity: f.get("severity"),
                      subjectMode: f.get("subjectMode"),
                      subjectCompanyId: f.get("subjectCompanyId") || null,
                      dueMonthOffset: f.get("dueMonthOffset"),
                      dueDayOfMonth: f.get("dueDayOfMonth"),
                      lateFeePerDayMinor: f.get("lateFeePerDayMinor") || null,
                      lateFeeCapMinor: f.get("lateFeeCapMinor") || null,
                      legalReference: f.get("legalReference") || null,
                      applicabilityNote: f.get("applicabilityNote") || null,
                      reminderLeadDays: f.get("reminderLeadDays"),
                      isActive: true,
                    }),
                  "Obligation saved. It generates nothing until you generate deadlines from it.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="o-code">Code</Label>
                <Input
                  id="o-code"
                  name="code"
                  required
                  maxLength={100}
                  placeholder="gst.gstr3b"
                />
                <p className="text-[11px] text-muted-foreground">
                  The stable machine key. Never renumber it.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-name">Name</Label>
                <Input
                  id="o-name"
                  name="name"
                  required
                  maxLength={300}
                  placeholder="GSTR-3B monthly return"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-auth">Authority</Label>
                <select id="o-auth" name="authority" defaultValue="gst" className={SELECT}>
                  {AUTHORITIES.map((a) => (
                    <option key={a} value={a}>
                      {a.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Recorded because compliance is always asked about by one
                  regulator at a time.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-freq">Frequency</Label>
                <select id="o-freq" name="frequency" defaultValue="monthly" className={SELECT}>
                  {FREQUENCIES.map((k) => (
                    <option key={k} value={k}>
                      {k.replace("_", " ")}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Event-based obligations have no schedule — a new hire, an
                  accident. They generate one period at a time.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-sev">Severity</Label>
                <select id="o-sev" name="severity" defaultValue="medium" className={SELECT}>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <SubjectPicker idPrefix="o" companies={companies} />

              <div className="space-y-1">
                {/* ⚠️ Zero is legitimate — advance tax falls due inside the
                    period it relates to. It is not "unset". */}
                <Label htmlFor="o-offset">Months after the period ends</Label>
                <Input
                  id="o-offset"
                  name="dueMonthOffset"
                  type="number"
                  min={0}
                  max={24}
                  defaultValue={1}
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  0 is allowed: some things fall due inside the period itself.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-day">Day of that month</Label>
                <Input
                  id="o-day"
                  name="dueDayOfMonth"
                  type="number"
                  min={1}
                  max={31}
                  defaultValue={20}
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  ⭐ 31 means &ldquo;the last day&rdquo;. The database clamps it
                  to the month&apos;s real length, so February needs no special
                  case and no separate flag.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-fee">Late fee per day (paise)</Label>
                <Input
                  id="o-fee"
                  name="lateFeePerDayMinor"
                  inputMode="numeric"
                  pattern="\d*"
                />
                <p className="text-[11px] text-muted-foreground">
                  Stated in advance. ₹50/day feels ignorable until the board
                  shows it as ₹50 × 3 registrations × 40 days.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-cap">Cap (paise)</Label>
                <Input
                  id="o-cap"
                  name="lateFeeCapMinor"
                  inputMode="numeric"
                  pattern="\d*"
                />
                <p className="text-[11px] text-muted-foreground">
                  ⚠️ Leave blank if the statute does not cap it. Blank means
                  uncapped; 0 would mean the fee is capped at nothing.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-legal">Legal reference</Label>
                <Input
                  id="o-legal"
                  name="legalReference"
                  maxLength={300}
                  placeholder="S.39 CGST Act"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-remind">Reminders start (days before)</Label>
                <Input
                  id="o-remind"
                  name="reminderLeadDays"
                  type="number"
                  min={0}
                  max={365}
                  defaultValue={7}
                />
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="o-applies">When does this apply?</Label>
                <Textarea
                  id="o-applies"
                  name="applicabilityNote"
                  rows={2}
                  maxLength={2000}
                  placeholder="Turnover above ₹5 crore; registered in Maharashtra only"
                />
                <p className="text-[11px] text-muted-foreground">
                  Written for a human, never inferred by a rule. A tenant
                  switched off by logic nobody remembers writing has no idea
                  they have stopped filing.
                </p>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Saving…" : "Save obligation"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  ⚠️ Saving this creates the RULE, not a deadline. Nothing is
                  due until deadlines are generated from it — and an obligation
                  producing no deadlines is the one failure on this page you
                  cannot see by looking at it.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── EVIDENCE. Append-only; superseding, never replacing. ────── */}
      {panel === "evidence" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Attach evidence</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    attachComplianceEvidence({
                      taskId: f.get("taskId"),
                      kind: f.get("kind"),
                      title: f.get("title"),
                      documentId: f.get("documentId") || null,
                      contentSha256: f.get("contentSha256") || null,
                      filingReference: f.get("filingReference") || null,
                      filedOn: f.get("filedOn") || null,
                      notes: f.get("notes") || null,
                      supersedesEvidenceId: f.get("supersedesEvidenceId") || null,
                    }),
                  "Evidence recorded.",
                );
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="e-task">Deadline this proves</Label>
                <select id="e-task" name="taskId" required defaultValue="" className={SELECT}>
                  <option value="" disabled>
                    Choose the deadline
                  </option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {taskLabel(t)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="e-kind">Kind</Label>
                <Input
                  id="e-kind"
                  name="kind"
                  required
                  maxLength={60}
                  placeholder="acknowledgement"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="e-title">Title</Label>
                <Input
                  id="e-title"
                  name="title"
                  required
                  maxLength={300}
                  placeholder="GSTR-3B Jul 2026 — filed ARN receipt"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="e-doc">Document id</Label>
                <Input id="e-doc" name="documentId" maxLength={36} placeholder="uuid" />
                <p className="text-[11px] text-muted-foreground">
                  Bytes live in object storage; this points at them.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="e-hash">SHA-256 of the file</Label>
                <Input id="e-hash" name="contentSha256" maxLength={64} placeholder="64 hex characters" />
                <p className="text-[11px] text-muted-foreground">
                  ⭐ This is what makes the evidence worth having. Without it,
                  &ldquo;here is what we filed&rdquo; is a PDF somebody could
                  have edited last week. It cannot be changed afterwards.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="e-ref">Filing reference</Label>
                <Input id="e-ref" name="filingReference" maxLength={200} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="e-on">Filed on</Label>
                <Input id="e-on" name="filedOn" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="e-sup">Supersedes evidence id</Label>
                <Input id="e-sup" name="supersedesEvidenceId" maxLength={36} placeholder="uuid" />
                <p className="text-[11px] text-muted-foreground">
                  ⚠️ The correction path. A revised return does not erase the
                  original — being able to show BOTH is what a revision is.
                </p>
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="e-notes">Notes</Label>
                <Textarea id="e-notes" name="notes" rows={2} maxLength={5000} />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || tasks.length === 0}>
                  {pending ? "Saving…" : "Attach evidence"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  ⚠️ Evidence is append-only and there is no delete — the
                  application has no privilege to remove a row, by design. To
                  correct something, attach the new document and name the one it
                  supersedes.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── NOT APPLICABLE / WAIVED. A decision, with a reason. ─────── */}
      {panel === "exempt" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">This period did not apply</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    exemptComplianceTask({
                      id: f.get("id"),
                      status: f.get("status"),
                      reason: f.get("reason"),
                    }),
                  "Recorded, with the reason attached.",
                );
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="x-task">Deadline</Label>
                <select id="x-task" name="id" required defaultValue="" className={SELECT}>
                  <option value="" disabled>
                    Choose the deadline
                  </option>
                  {openTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {taskLabel(t)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="x-status">Which is it?</Label>
                <select id="x-status" name="status" defaultValue="not_applicable" className={SELECT}>
                  <option value="not_applicable">Did not apply</option>
                  <option value="waived">Waived</option>
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="x-reason">Why</Label>
                <Textarea
                  id="x-reason"
                  name="reason"
                  required
                  rows={2}
                  maxLength={2000}
                  placeholder="Not registered for professional tax in this state"
                />
                <p className="text-[11px] text-muted-foreground">
                  ⚠️ Required, and the database requires it too. &ldquo;We did
                  not file because we are not registered&rdquo; and &ldquo;we
                  did not file&rdquo; look identical six months later in a
                  register that only records the status.
                </p>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || openTasks.length === 0}>
                  {pending ? "Saving…" : "Record the decision"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  This is neither &ldquo;done&rdquo; nor &ldquo;ignored&rdquo;.
                  It is a stated decision, kept in its own bucket on the board so
                  it never gets counted as a return that was filed.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── DEACTIVATE. Not a delete, and never can be. ─────────────── */}
      {panel === "deactivate" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Stop an obligation</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    deactivateComplianceObligation({
                      id: f.get("id"),
                      isActive: false,
                      reason: f.get("reason"),
                      effectiveTo: f.get("effectiveTo") || null,
                    }),
                  "That obligation will generate no further deadlines. Everything already filed stays on the register.",
                );
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="d-ob">Obligation</Label>
                <select id="d-ob" name="id" required defaultValue="" className={SELECT}>
                  <option value="" disabled>
                    Choose an obligation
                  </option>
                  {activeObligations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-to">Applied until</Label>
                <Input id="d-to" name="effectiveTo" type="date" />
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="d-reason">Why does it no longer apply?</Label>
                <Textarea
                  id="d-reason"
                  name="reason"
                  required
                  rows={2}
                  maxLength={2000}
                  placeholder="GST registration surrendered on 31 Mar 2026"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || activeObligations.length === 0}>
                  {pending ? "Saving…" : "Stop generating deadlines"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  ⚠️ There is no delete here. Removing the obligation would take
                  every deadline ever generated from it with it — the filings,
                  their acknowledgement numbers and their evidence — and the
                  register could no longer show that you ever filed at all.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
