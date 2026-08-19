/**
 * Ordence — ⭐⭐ ONE LEAD
 * Version: v1.43.0-alpha (Mega-wave 1, Batch 35)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `getLead` WAS COMPLETE AND HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * It returns the lead and its two hundred most recent activities, and
 * every row of the lead table and every card on the pipeline board linked
 * to `/sales/leads/${id}` — a route that did not exist. Both of the only
 * working screens in the domain were made of 404s, which is why
 * `check:links` found it.
 *
 * ⭐ THE HISTORY IS ON THE PAGE, NOT IN AN AUDIT VIEWER SOMEWHERE.
 * `lead_activities` is append-only and records every call, every stage
 * change, and who made it. In a commission dispute it is the only
 * document, and a record nobody can open is a record that gets argued
 * from memory instead.
 */

import Link from "next/link";
import { getLead, getSalesEntitlements } from "@/server/actions/sales-leads";
import { listLeadFormOptions } from "@/server/actions/sales-leads-form";
import { LeadDetailPanel } from "@/components/sales/lead-detail-panel";
import type { LeadFormValues } from "@/components/sales/lead-form";
import { Badge } from "@/components/ui/badge";
import {
  STAGE_LABELS,
  SOURCE_LABELS,
  consentStatus,
  followUpUrgency,
  localHourFor,
  isCivilCallingHour,
} from "@/lib/sales/pipeline";
import { cpLockDaysRemaining } from "@/lib/sales/commission";
import { fromMinorUnits } from "@/lib/validators/accounting";

export const dynamic = "force-dynamic";

/**
 * ⚠️ PAISE TO RUPEES FOR DISPLAY ONLY, BY SPLITTING THE STRING.
 *
 * 🔴 `Number(minor) / 100` is the obvious version and it is wrong above
 * about ₹90,000 crore, which a residential portfolio reaches — and it is
 * silently wrong, producing a figure that looks plausible. The digits are
 * never converted to a number at all here, so there is nothing to lose.
 */
function money(minor: bigint | null): string | null {
  if (minor === null) return null;
  const raw = String(minor);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const paise = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${paise}`;
}

const URGENCY_NOTE: Readonly<Record<string, string | null>> = {
  none: null,
  scheduled: null,
  due: "Due today",
  overdue: "Overdue",
  stale: "Stale — nobody has spoken to this buyer in weeks",
};

export default async function LeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [result, entitlements, options] = await Promise.all([
    getLead({ id }),
    getSalesEntitlements(),
    listLeadFormOptions(),
  ]);

  if (!result.ok) {
    /**
     * ⚠️ A REFUSAL IS NOT A 404, AND THIS PAGE DOES NOT GUESS WHICH IT IS.
     *
     * `getLead` answers "you may not read leads" and "no such lead" in the
     * same shape, so the only way to tell them apart here would be to
     * match on the text of the message — which turns a copy edit in the
     * action into a routing change, silently.
     *
     * 🔴 SO THE MESSAGE IS SHOWN AS WRITTEN. Rendering `notFound()` for
     * both would send an operator with the wrong role hunting for a
     * record that is sitting right there, and the afternoon they lose to
     * that is the reason this rule exists.
     */
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 p-6">
        <Link href="/sales/leads" className="text-sm text-muted-foreground hover:underline">
          ← Pipeline
        </Link>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { lead, activities } = result.data;
  const now = new Date();

  const urgency = followUpUrgency(lead.nextFollowUpAt, now);
  const consent = consentStatus(lead);
  const lockDays = cpLockDaysRemaining(lead.cpLockedUntil, now);
  const localHour = localHourFor(lead.timezone, now);
  const civil = isCivilCallingHour(lead.timezone, now);

  const budgetFrom = money(lead.budgetMinMinor);
  const budgetTo = money(lead.budgetMaxMinor);

  /**
   * ⚠️ THE FORM GETS RUPEE STRINGS, PRODUCED BY BIGINT DIVISION.
   *
   * `fromMinorUnits` is the inverse of the `toMinorUnits` the action will
   * run on the way back, so a lead edited without touching the budget
   * fields round-trips to the same paise. Formatting with `money()` here
   * instead would put "₹45,00,000.00" into a field validated by
   * `/^\d{1,15}(\.\d{1,2})?$/`, and every save would be refused.
   *
   * 🔴 And a `bigint` cannot cross into a client component at all, which
   * makes this conversion something the compiler insists on rather than
   * something a reviewer has to notice.
   */
  const initial: LeadFormValues = {
    name: lead.name,
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    source: lead.source,
    temperature: lead.temperature,
    budgetMin: lead.budgetMinMinor === null ? "" : fromMinorUnits(lead.budgetMinMinor),
    budgetMax: lead.budgetMaxMinor === null ? "" : fromMinorUnits(lead.budgetMaxMinor),
    requirement: lead.requirement ?? "",
    projectId: lead.projectId ?? "",
    ownerId: lead.ownerId ?? "",
    channelPartnerId: lead.channelPartnerId ?? "",
    isNri: lead.isNri,
    country: lead.country ?? "",
    timezone: lead.timezone ?? "",
    locality: lead.locality ?? "",
    consentSource: lead.consentSource ?? "",
    preferredLang: lead.preferredLang ?? "en",
  };

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link href="/sales/leads" className="text-sm text-muted-foreground hover:underline">
          ← Pipeline
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{lead.name}</h1>
          <Badge variant="outline">{STAGE_LABELS[lead.status]}</Badge>
          <Badge variant="outline">{lead.temperature}</Badge>
          {lead.isNri ? <Badge variant="outline">NRI</Badge> : null}
          <span className="text-sm tabular-nums text-muted-foreground">
            Score {lead.score}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {lead.reference} · {SOURCE_LABELS[lead.source]}
          {lead.locality ? ` · ${lead.locality}` : ""}
          {lead.phone ? ` · ${lead.phone}` : ""}
          {lead.email ? ` · ${lead.email}` : ""}
        </p>
      </div>

      {/*
        ⭐ THE CLOCK WHERE THE BUYER IS, ON THE ONE SCREEN A REP OPENS
        BEFORE DIALLING. Calling a buyer in New Jersey at 11am IST is
        calling them at 1:30am, it happens constantly, and no amount of
        training fixes it because the rep is looking at a record, not a
        clock. The list already says this; the detail page is where the
        call actually gets made from.
      */}
      {localHour !== null ? (
        <p
          className={
            civil
              ? "text-sm text-muted-foreground"
              : "rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          }
        >
          It is {String(localHour).padStart(2, "0")}:00 where they are
          {lead.timezone ? ` (${lead.timezone})` : ""}.
          {civil ? "" : " Do not call — this is the fastest way to lose an NRI lead."}
        </p>
      ) : null}

      {lead.status === "lost" && lead.lostReason ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <strong>Lost:</strong> {lead.lostReason}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground">Budget</h2>
          <p className="mt-1 text-sm">
            {budgetFrom || budgetTo
              ? `${budgetFrom ?? "—"} to ${budgetTo ?? "—"}`
              : "Not stated. A stated budget is a stated intention, and it lifts the score."}
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground">Next follow-up</h2>
          <p className="mt-1 text-sm">
            {lead.nextFollowUpAt
              ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(
                  lead.nextFollowUpAt,
                )
              : "Not scheduled"}
          </p>
          {URGENCY_NOTE[urgency] ? (
            <p className="mt-1 text-xs text-destructive">{URGENCY_NOTE[urgency]}</p>
          ) : null}
        </div>

        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground">Attribution</h2>
          {/*
            ⭐ THE PROTECTION WINDOW IS SHOWN AS DAYS REMAINING, not as a
            timestamp. "Locked until 12 Nov" is a date somebody has to do
            arithmetic on while a broker is on the phone; "31 days" is the
            answer to the question actually being asked.
          */}
          <p className="mt-1 text-sm">
            {lead.channelPartnerId
              ? lockDays === null
                ? "Registered to a channel partner. The protection window has expired."
                : `Registered to a channel partner. Protected for ${lockDays} more day${lockDays === 1 ? "" : "s"}.`
              : "Direct. No broker has a claim on this lead."}
          </p>
        </div>
      </div>

      {/*
        ⚠️ THE CONSENT NOTE IS SHOWN WHETHER OR NOT IT IS SATISFIED, and
        it does NOT block anything. Under the DPDP Act contacting somebody
        about a property needs a lawful basis, and consent is one of
        several — a CRM that refused to let a company ring its own walk-in
        visitor would be worked around on paper within a week. Marking the
        gap is what makes it fixable.
      */}
      <p
        className={
          consent.hasEvidence
            ? "text-sm text-muted-foreground"
            : "rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
        }
      >
        {consent.note}
      </p>

      <LeadDetailPanel
        leadId={lead.id}
        status={lead.status}
        // The same reading the board takes. The server counts the live
        // bookings itself before allowing any move.
        hasLiveBooking={lead.status === "booked" || lead.status === "won"}
        initial={initial}
        projects={options.ok ? options.data.projects : []}
        partners={options.ok ? options.data.partners : []}
        owners={options.ok ? options.data.owners : []}
        withheld={options.ok ? options.data.withheld : ["projects", "partners", "owners"]}
        canWrite={entitlements.ok && entitlements.data["sales.pipeline"] === true}
      />

      <div className="rounded-lg border bg-card p-4">
        <h2 className="font-medium">What has happened to this lead</h2>
        {activities.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing logged yet. Every call recorded here is evidence later.
          </p>
        ) : (
          <ol className="mt-3 space-y-2 text-sm">
            {activities.map((a) => (
              <li key={a.id} className="flex gap-3">
                <span className="w-40 shrink-0 text-muted-foreground">
                  {new Date(a.occurredAt).toLocaleString()}
                </span>
                <span>
                  <strong>{a.type.replace(/_/g, " ")}</strong>
                  {a.subject ? ` — ${a.subject}` : ""}
                  {a.outcome ? ` · ${a.outcome}` : ""}
                  {a.notes ? (
                    <span className="block text-muted-foreground">{a.notes}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}
