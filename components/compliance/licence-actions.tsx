"use client";

/**
 * Ordence — ⭐ ENGINE 4 · LICENCE WRITE ACTIONS
 * Version: v0.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO STATUS DROPDOWN ON THE LICENCE FORM
 * ══════════════════════════════════════════════════════════════════════
 * Look for it — you can record a licence, renew it, or retire it, but you
 * cannot simply set it to "active". `compliance_licence_status_from_dates()`
 * derives the status on every write: expired if the date has passed,
 * `renewal_due` inside the licence's own lead window, `active` otherwise.
 *
 * The reason is the failure it prevents. Left to a human, a fire NOC reads
 * `active` for eight months after it lapsed — nothing errors, nothing looks
 * wrong, and the first sign is an inspector standing in the lobby. An
 * expired licence does not cost a late fee; it stops the premises operating
 * that day, and the renewal itself takes weeks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO THE FORM ASKS HOW LONG A RENEWAL TAKES, NOT WHEN TO REMIND
 * ══════════════════════════════════════════════════════════════════════
 * "Expires in 40 days" means nothing on its own. A shops-and-establishment
 * renewal takes a week; a pollution-control consent can take three months,
 * and some renewals legally cannot be applied for until a window opens.
 * `renewalLeadDays` is the date from which being idle is ALREADY a problem
 * — which is why it lives per licence rather than as one global setting.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveComplianceLicence,
  renewComplianceLicence,
  retireComplianceLicence,
} from "@/server/actions/compliance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type CompanyOption = { id: string; name: string };

type LicenceOption = {
  id: string;
  name: string;
  status: string;
  validUntil: string | null;
};

type Panel = "none" | "licence" | "renew" | "retire";

const SELECT = "h-9 w-full rounded-md border bg-background px-3 text-sm";

const AUTHORITIES = [
  "gst", "income_tax", "mca_roc", "epfo", "esic", "labour",
  "professional_tax", "customs", "rbi", "sebi", "fssai",
  "pollution_control", "fire", "municipal", "transport_rto",
  "electricity_cea", "health_nmc", "drugs_licensing", "aerb",
  "state_excise", "legal_metrology", "internal", "other",
];

const SEVERITIES = ["informational", "low", "medium", "high", "critical"];

export function LicenceActions({
  companies,
  licences,
}: {
  companies: CompanyOption[];
  licences: LicenceOption[];
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("none");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * ⭐ THE SUBJECT IS A CHOICE, NEVER A DEFAULT.
   *
   * ⚠️ NULL means the licence is the tenant's own; set means it belongs to
   * a client they act for. A select that starts on "yours" is a select
   * people stop reading, and then a client's factory licence expires while
   * appearing in the practice's own column — chased by nobody, because
   * everybody assumed it was somebody else's row.
   */
  const [subjectMode, setSubjectMode] = useState<"" | "own" | "client">("");

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
  ) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        // ⚠️ Shown verbatim — the refusals are written for a person.
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
          variant={panel === "licence" ? "default" : "outline"}
          onClick={() => setPanel(panel === "licence" ? "none" : "licence")}
        >
          Record a licence
        </Button>
        <Button
          size="sm"
          variant={panel === "renew" ? "default" : "outline"}
          onClick={() => setPanel(panel === "renew" ? "none" : "renew")}
        >
          Renew
        </Button>
        <Button
          size="sm"
          variant={panel === "retire" ? "default" : "ghost"}
          onClick={() => setPanel(panel === "retire" ? "none" : "retire")}
        >
          Suspend / cancel / not required
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

      {panel === "licence" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Record a licence</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    saveComplianceLicence({
                      name: f.get("name"),
                      authority: f.get("authority"),
                      licenceNumber: f.get("licenceNumber") || null,
                      appliesTo: f.get("appliesTo") || null,
                      subjectMode: f.get("subjectMode"),
                      subjectCompanyId: f.get("subjectCompanyId") || null,
                      issuedOn: f.get("issuedOn") || null,
                      validFrom: f.get("validFrom") || null,
                      validUntil: f.get("validUntil") || null,
                      renewalLeadDays: f.get("renewalLeadDays"),
                      severity: f.get("severity"),
                      renewalFeeMinor: f.get("renewalFeeMinor") || null,
                      notes: f.get("notes") || null,
                    }),
                  "Licence recorded. Its status was set by the database from the dates you gave.",
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="l-name">Licence</Label>
                <Input
                  id="l-name"
                  name="name"
                  required
                  maxLength={300}
                  placeholder="FSSAI state licence"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="l-auth">Authority</Label>
                <select id="l-auth" name="authority" defaultValue="fssai" className={SELECT}>
                  {AUTHORITIES.map((a) => (
                    <option key={a} value={a}>
                      {a.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="l-num">Licence number</Label>
                <Input id="l-num" name="licenceNumber" maxLength={200} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="l-applies">Applies to</Label>
                <Input
                  id="l-applies"
                  name="appliesTo"
                  maxLength={300}
                  placeholder="Andheri kitchen · MH-01-AB-1234 · Dr Rao"
                />
              </div>

              {/* ⭐ Whose licence. Never assumed — see the state above. */}
              <div className="space-y-1">
                <Label htmlFor="l-subject">Whose licence is this?</Label>
                <select
                  id="l-subject"
                  name="subjectMode"
                  required
                  value={subjectMode}
                  onChange={(e) =>
                    setSubjectMode(e.target.value as "" | "own" | "client")
                  }
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
                <Label htmlFor="l-company">Client</Label>
                <select
                  id="l-company"
                  name="subjectCompanyId"
                  disabled={subjectMode !== "client"}
                  required={subjectMode === "client"}
                  defaultValue=""
                  className={SELECT}
                >
                  <option value="">
                    {companies.length === 0
                      ? "No companies on record"
                      : "Choose a client"}
                  </option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="l-issued">Issued on</Label>
                <Input id="l-issued" name="issuedOn" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="l-from">Valid from</Label>
                <Input id="l-from" name="validFrom" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="l-until">Valid until</Label>
                <Input id="l-until" name="validUntil" type="date" />
                <p className="text-[11px] text-muted-foreground">
                  ⚠️ A licence with no expiry recorded is invisible to every
                  alarm on this page — there is no date to count back from — and
                  it stays reassuringly green for ever.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="l-lead">How long a renewal takes (days)</Label>
                <Input
                  id="l-lead"
                  name="renewalLeadDays"
                  type="number"
                  min={0}
                  max={730}
                  defaultValue={60}
                />
                <p className="text-[11px] text-muted-foreground">
                  ⭐ Not a reminder. This is the date from which being idle is
                  already a problem — a week for a trade licence, three months
                  for a pollution-control consent.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="l-sev">Severity</Label>
                <select id="l-sev" name="severity" defaultValue="high" className={SELECT}>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="l-fee">Renewal fee (paise)</Label>
                <Input id="l-fee" name="renewalFeeMinor" inputMode="numeric" pattern="\d*" />
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="l-notes">Notes</Label>
                <Textarea id="l-notes" name="notes" rows={2} maxLength={5000} />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Saving…" : "Record licence"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  There is no status field here on purpose. The database works
                  it out from the expiry and the lead time, so a lapsed licence
                  cannot be described as active by somebody clicking through a
                  list.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {panel === "renew" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Renew</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(async () => {
                  const r = await renewComplianceLicence({
                    id: f.get("id"),
                    mode: f.get("mode"),
                    validFrom: f.get("validFrom") || null,
                    validUntil: f.get("validUntil") || null,
                    licenceNumber: f.get("licenceNumber") || null,
                    renewalFeeMinor: f.get("renewalFeeMinor") || null,
                    notes: f.get("notes") || null,
                  });
                  if (r.ok && r.data.status === "expired") {
                    setNotice(
                      "Recorded — but the database still reads this licence as EXPIRED. " +
                        "The new expiry date is already in the past. Check the date.",
                    );
                  }
                  return r;
                }, "Renewal recorded.");
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="rn-id">Licence</Label>
                <select id="rn-id" name="id" required defaultValue="" className={SELECT}>
                  <option value="" disabled>
                    Choose a licence
                  </option>
                  {licences.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} · {l.status.replace("_", " ")}
                      {l.validUntil ? ` · until ${l.validUntil}` : " · no expiry"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                {/* ⭐ Two different acts. See renewComplianceLicence. */}
                <Label htmlFor="rn-mode">Which is this?</Label>
                <select id="rn-mode" name="mode" defaultValue="renewed" className={SELECT}>
                  <option value="started">We have started the renewal</option>
                  <option value="renewed">The renewal came back</option>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Saying you have started stops the board nagging about a
                  licence somebody is already handling — without claiming it is
                  renewed while the application sits with the department.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rn-until">New expiry</Label>
                <Input id="rn-until" name="validUntil" type="date" />
                <p className="text-[11px] text-muted-foreground">
                  Required when the renewal has come back. Without it the
                  licence keeps counting down to the old date.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rn-from">New valid from</Label>
                <Input id="rn-from" name="validFrom" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rn-num">New licence number</Label>
                <Input id="rn-num" name="licenceNumber" maxLength={200} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rn-fee">Fee paid (paise)</Label>
                <Input id="rn-fee" name="renewalFeeMinor" inputMode="numeric" pattern="\d*" />
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="rn-notes">Notes</Label>
                <Textarea id="rn-notes" name="notes" rows={2} maxLength={5000} />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || licences.length === 0}>
                  {pending ? "Saving…" : "Record renewal"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  The resulting status is the database&apos;s answer, from the
                  new dates. A renewal entered with an expiry already in the
                  past comes back as expired — which is the correct reading, and
                  is worth seeing immediately.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {panel === "retire" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Suspend, cancel, or mark not required
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(
                  () =>
                    retireComplianceLicence({
                      id: f.get("id"),
                      status: f.get("status"),
                      reason: f.get("reason"),
                    }),
                  "Recorded. The licence stays on the register with the reason attached.",
                );
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="rt-id">Licence</Label>
                <select id="rt-id" name="id" required defaultValue="" className={SELECT}>
                  <option value="" disabled>
                    Choose a licence
                  </option>
                  {licences.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} · {l.status.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rt-status">What happened?</Label>
                <select
                  id="rt-status"
                  name="status"
                  defaultValue="not_required"
                  className={SELECT}
                >
                  <option value="not_required">No longer required</option>
                  <option value="suspended">Suspended by the authority</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  ⭐ These three are facts about the permission, not positions
                  on a calendar — so the database leaves them alone rather than
                  recomputing them from the expiry date.
                </p>
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="rt-reason">Why</Label>
                <Textarea
                  id="rt-reason"
                  name="reason"
                  required
                  rows={2}
                  maxLength={2000}
                  placeholder="Kitchen closed 30 Jun 2026; FSSAI registration surrendered"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={pending || licences.length === 0}>
                  {pending ? "Saving…" : "Record it"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  ⚠️ The row is not deleted and does not leave the register. An
                  inspector asking whether you held a licence in 2024 gets no
                  answer from a row that was tidied away — and &ldquo;not
                  required&rdquo;, said out loud, is a different thing from a
                  licence quietly missing from a list, which mostly means
                  somebody forgot.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
