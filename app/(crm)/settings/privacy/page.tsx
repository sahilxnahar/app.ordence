/**
 * Ordence — ⭐⭐⭐ DATA PRINCIPAL RIGHTS
 * Version: v1.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS PAGE EXISTS AT ALL, AND NOT ONLY THE ENGINE BEHIND IT
 * ══════════════════════════════════════════════════════════════════════
 * This codebase has shipped a complete depreciation engine that no
 * navigation reached for four batches, thirty-four entitlement keys that
 * nothing gated, and dunning letters that queued and never sent. Built
 * and unreachable is the same defect as declared and unenforced.
 *
 * ⭐ So the engine and its route land together, and the route is in the
 * settings tab strip in the same commit.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PAGE IS HONEST ABOUT, AND MOST COMPLIANCE SCREENS ARE NOT
 * ══════════════════════════════════════════════════════════════════════
 * It states the coverage NUMBER — how many tables can be searched for
 * one person and how many cannot — before it offers to do anything. A
 * compliance feature that shows a green tick and not its own coverage is
 * a feature that tells a customer they have complied.
 */

import { Suspense } from "react";
import { ShieldCheck, FileWarning, Scale } from "lucide-react";
import { bestCaseCoverage } from "@/lib/dpdp/subject-graph";
import { citableRules } from "@/lib/dpdp/erasure";
import {
  PRINCIPAL_KINDS,
  PRINCIPAL_TABLES,
  personalDataTables,
  principalTables,
  tenantScopedTables,
  unreachableTables,
} from "@/lib/dpdp/classification";
import { PROCESSOR_NOTE } from "@/lib/dpdp/retention";
import { DPDP_RULE_7_COMMENCEMENT } from "@/lib/dpdp/breach";
/**
 * ⭐⭐⭐ THE INTAKE HALF, ADDED ON MERGE — wave two.
 *
 * 🔴 Brief H wired FULFILMENT (`runDataPrincipalExport`,
 * `runDataPrincipalErasure`, `recordBreachIntimation`) and not INTAKE.
 * `recordDataPrincipalRequest`, `previewDataPrincipalPlan` and
 * `recordPersonalDataBreach` had no caller anywhere, so the two lists
 * below could be acted on and nothing could get onto them.
 * `check:action-reachability` refused the merge and named all three.
 */
import {
  listDataPrincipalRequests,
  listPersonalDataBreaches,
  previewDataPrincipalPlan,
  recordDataPrincipalRequest,
  recordPersonalDataBreach,
} from "@/server/actions/dpdp";
import { RecordRequestForm } from "./record-request-form";
import { RecordBreachForm } from "./record-breach-form";
import { RequestList } from "./request-list";
import { BreachPanel } from "./breach-panel";

export const dynamic = "force-dynamic";

/**
 * ⭐ THE COVERAGE FIGURE IS COMPUTED, NOT WRITTEN DOWN.
 *
 * `bestCaseCoverage()` builds a plan for a fictional subject holding
 * every kind of anchor, which is the ceiling. So the number on this
 * screen moves the moment the inventory does — a hard-coded "we search
 * 162 tables" would be true on the day it was typed and would go on
 * being displayed long after it stopped being true.
 */

export default async function PrivacyPage() {
  const c = bestCaseCoverage();
  const gaps = unreachableTables();
  const personal = personalDataTables().length;
  const inWorkspaceScope = tenantScopedTables().filter((t) => t.holds !== "operational").length;
  const anchors = principalTables();
  const rules = citableRules();
  const requests = await listDataPrincipalRequests();
  const breaches = await listPersonalDataBreaches();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Data principal rights</h1>
        {/*
          ⭐ THE TWO HATS, SAID OUT LOUD ON THE SCREEN THAT ACTS ON THEM.
          `PROCESSOR_NOTE` is the same sentence the engine reasons from,
          rendered rather than paraphrased — a second wording here would
          drift from the one the code enforces.
        */}
        <p className="mt-1 text-sm text-muted-foreground">{PROCESSOR_NOTE}</p>
      </header>

      {/*
        🔴 THE COVERAGE, FIRST, BEFORE ANY BUTTON.
        Somebody about to tell a person "this is everything we hold about
        you" is entitled to know how much of the product that sentence
        actually covers.
      */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          What a search covers
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Tables holding personal data</dt>
            <dd className="text-lg font-semibold">{personal}</dd>
            <dd className="text-xs text-muted-foreground">
              {inWorkspaceScope} of them yours
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Searchable for one person</dt>
            <dd className="text-lg font-semibold">{c.searched}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Not searchable by anyone</dt>
            <dd className="text-lg font-semibold">{c.unreachable}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Ordence&rsquo;s own records</dt>
            <dd className="text-lg font-semibold">{c.outOfScope}</dd>
          </div>
        </dl>

        {gaps.length > 0 ? (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
            <p className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-100">
              <FileWarning className="h-4 w-4" aria-hidden="true" />
              {gaps.length} record set{gaps.length === 1 ? "" : "s"} cannot be
              searched for an individual
            </p>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
              Every export names {gaps.length === 1 ? "it" : "them"} in the file
              itself, so nobody is told these are empty when we have not looked:{" "}
              {gaps.map((g) => g.table).join(", ")}.
            </p>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Every table holding personal data can be searched for an individual.
          </p>
        )}

        {/*
          ⚠️ THE ANCHORS, LISTED. An operator recording a request has to
          know which kinds of record can be attached to a person, and
          Ordence deliberately does not infer them from a shared email
          address — `info@` on a family business would merge two people
          and disclose each to the other.
        */}
        <p className="mt-4 text-sm">
          A person can be anchored to any of these records:{" "}
          {anchors
            .map((a) => a.table)
            .sort()
            .join(", ")}
          .
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          A lead who has booked a unit is an allottee; the record is{" "}
          <code>{PRINCIPAL_TABLES.lead}</code>.
        </p>

        <p className="mt-3 text-xs text-muted-foreground">
          These figures are computed from the data inventory each time this page
          loads. A build fails if a new table carrying personal data is added and
          nobody classifies it.
        </p>
      </section>

      {/*
        ⭐ THE REFUSALS, VISIBLE BEFORE ANYBODY ASKS.
        A retention policy nobody can read until the day it is needed is a
        retention policy that surprises somebody on that day.
      */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Scale className="h-4 w-4" aria-hidden="true" />
          What erasure will not delete, and why
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Section 8(7) requires erasure <em>unless retention is necessary for
          compliance with any law for the time being in force</em>. These are the
          provisions this workspace relies on. Each refusal names one.
        </p>
        <ul className="mt-3 space-y-3">
          {rules.map((r) => (
            <li key={r.id} className="border-l-2 border-border pl-3 text-sm">
              <p className="font-medium">{r.provision}</p>
              <p className="text-muted-foreground">{r.period}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Runs from {r.clock}. Last checked against the provision itself on{" "}
                {r.verified}.
              </p>
              {r.kind === "unverified" ? (
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  ⚠️ Not confirmed. Erasures touching these records stop and wait
                  for a person rather than being decided automatically in either
                  direction.
                </p>
              ) : null}
              {r.kind === "derived-limitation" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  No provision states a period for this. It is derived from how
                  long the record can still be demanded, and is described that way
                  in the notice.
                </p>
              ) : null}
              {r.kind === "immutable-by-design" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Not a legal requirement. A design decision, and we say so to the
                  person rather than citing a law that does not exist.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">Requests</h2>
        <Suspense fallback={<p className="mt-2 text-sm text-muted-foreground">Loading…</p>}>
          <RecordRequestForm
            principalKinds={PRINCIPAL_KINDS}
            recordAction={recordDataPrincipalRequest}
            previewAction={previewDataPrincipalPlan}
          />
          <RequestList initial={requests.ok ? requests.data : []} />
        </Suspense>
      </section>

      {/*
        ⭐ THE BREACH REGISTER. `security_events` records that something
        happened; this is the artefact s.8(6) requires be SENT, to two
        audiences, on two different clocks.
      */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">Personal data breaches</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Section 8(6) requires you to tell both the Data Protection Board and
          every affected person. CERT&#8209;In&rsquo;s directions of 28 April 2022
          separately require reporting within six hours of noticing, and that one
          binds you today.
        </p>
        <RecordBreachForm recordAction={recordPersonalDataBreach} />
        <BreachPanel breaches={breaches.ok ? breaches.data : []} />
      </section>

      {/*
        ⚠️ THE COMMENCEMENT DATE, STATED. Building to a rule that is
        notified and not yet in force is a deliberate choice and the
        person using this screen should know which it is.
      */}
      <p className="text-xs text-muted-foreground">
        The DPDP Rules 2025 were notified on 13 November 2025. The operative
        compliance rules — notice, breach intimation under Rule 7 and the
        retention rules — commence around{" "}
        {DPDP_RULE_7_COMMENCEMENT.toISOString().slice(0, 10)}. Ordence builds to
        them early on purpose; nothing on this page assumes they are already in
        force.
      </p>
    </div>
  );
}
