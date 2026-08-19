"use client";

/**
 * Ordence — ⭐⭐ THE FORM THAT LETS THE PRODUCT TAKE A LEAD
 * Version: v1.43.0-alpha (Mega-wave 1, Batch 35)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `createLead` AND `updateLead` HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * The pipeline board, the lead table, the saved views, the scoring, the
 * NRI calling-hour column, the channel-partner protection window — all of
 * it read a table the product could not write to. The "New lead" button
 * on the leads list pointed at `/sales/leads/new`, which was a 404, and
 * that button is the first thing a trial clicks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE COMPONENT, TWO ACTIONS
 * ══════════════════════════════════════════════════════════════════════
 * `updateLeadSchema` IS `createLeadSchema.partial()` plus an id, so a
 * second form for editing would be the same twenty fields with the same
 * validation rules maintained twice. They drift within a release: the
 * create form learns about consent and the edit form does not, and the
 * only way to fix a lead's consent evidence becomes deleting it.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SOURCE_LABELS } from "@/lib/sales/pipeline";
import type { LeadSource, LeadTemperature } from "@/db/schema/sales";

export type LeadFormOption = { id: string; label: string; hint?: string };

/**
 * ⚠️ Every value here is a STRING, including the budgets.
 *
 * The rupee figures leave this component exactly as typed. See `submit()`.
 */
export type LeadFormValues = {
  name: string;
  email: string;
  phone: string;
  source: LeadSource;
  temperature: LeadTemperature;
  budgetMin: string;
  budgetMax: string;
  requirement: string;
  projectId: string;
  ownerId: string;
  channelPartnerId: string;
  isNri: boolean;
  country: string;
  timezone: string;
  locality: string;
  consentSource: string;
  preferredLang: string;
};

export const BLANK_LEAD: LeadFormValues = {
  name: "",
  email: "",
  phone: "",
  source: "website",
  temperature: "warm",
  budgetMin: "",
  budgetMax: "",
  requirement: "",
  projectId: "",
  ownerId: "",
  channelPartnerId: "",
  isNri: false,
  country: "",
  timezone: "",
  locality: "",
  consentSource: "",
  preferredLang: "en",
};

type Result =
  | { ok: true; data: { id: string } }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

type LeadAction = (input: unknown) => Promise<Result>;

/**
 * ⚠️ AN EMPTY OPTIONAL FIELD IS SENT AS `null`, NEVER AS `""`.
 *
 * 🔴 The schemas validate what they are given. `email` is
 * `.email().optional().nullable()`, so `""` is not "absent" — it is a
 * string that fails, and the operator who left the field blank is told
 * "That is not a valid email address" about a box they never touched.
 * The same trap is set by `country` (`.length(2)`), `timezone` (checked
 * against `Intl`) and both budget fields.
 *
 * On the edit path `null` also carries the right meaning: clear it.
 */
const orNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

export function LeadForm({
  action,
  mode,
  leadId,
  initial,
  projects,
  partners,
  owners,
  withheld,
  onDone,
}: {
  action: LeadAction;
  mode: "create" | "edit";
  /** Required in edit mode; `updateLeadSchema` needs the id. */
  leadId?: string;
  initial: LeadFormValues;
  projects: LeadFormOption[];
  partners: LeadFormOption[];
  owners: LeadFormOption[];
  /** Option lists the caller may not read, from `listLeadFormOptions`. */
  withheld: string[];
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [values, setValues] = useState<LeadFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const set = <K extends keyof LeadFormValues>(key: K, value: LeadFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  function submit() {
    setError(null);
    setFieldErrors({});

    /**
     * ⚠️ THE REACHABILITY RULE IS CHECKED HERE TOO, MIRRORING
     * `createLeadRefined`.
     *
     * Not `required` on both inputs — that would demand BOTH, which is
     * wrong: a walk-in who left a phone number and no email is a lead.
     * The rule is "at least one", HTML cannot express it, and the server
     * refuses with a sentence naming both fields. Asking here means the
     * rep is told before the round trip rather than after it.
     */
    if (!values.email.trim() && !values.phone.trim()) {
      setError(
        "Add a phone number or an email address — a lead you cannot reach is not a lead.",
      );
      return;
    }

    const payload = {
      ...(mode === "edit" ? { id: leadId } : {}),
      name: values.name.trim(),
      email: orNull(values.email),
      phone: orNull(values.phone),
      preferredLang: orNull(values.preferredLang),
      source: values.source,
      temperature: values.temperature,
      /**
       * ⭐ THE BUDGETS GO OVER THE WIRE AS THE RUPEE STRINGS THAT WERE
       * TYPED. NOTHING HERE MULTIPLIES BY 100.
       *
       * 🔴 `Number("4500000.50") * 100` is the obvious version and it is
       * wrong twice: it is a float, and it is a SECOND implementation of
       * `toMinorUnits`, which already splits the string on the decimal
       * point and builds a bigint. Two implementations of the same
       * conversion disagree by a paisa on the first awkward figure, and
       * the one in the browser is the one nobody tests.
       *
       * So the browser sends rupees and the server owns paise. That is
       * also why there is no "budget range" summary on this form: it
       * would be arithmetic on money, here, in JavaScript.
       */
      budgetMin: orNull(values.budgetMin),
      budgetMax: orNull(values.budgetMax),
      requirement: orNull(values.requirement),
      projectId: orNull(values.projectId),
      ownerId: orNull(values.ownerId),
      channelPartnerId: orNull(values.channelPartnerId),
      isNri: values.isNri,
      country: orNull(values.country),
      timezone: orNull(values.timezone),
      locality: orNull(values.locality),
      consentSource: orNull(values.consentSource),
    };

    start(async () => {
      const result = await action(payload);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      if (mode === "create") {
        // Straight to the lead, not back to the list. The next thing the
        // rep does is log the call they are already on.
        router.push(`/sales/leads/${result.data.id}`);
        return;
      }
      router.refresh();
      onDone?.();
    });
  }

  const fieldError = (name: string) => fieldErrors[name]?.[0] ?? null;

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="font-medium">Who they are</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="lead-name">Name</Label>
            <Input
              id="lead-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              required
              maxLength={255}
              placeholder="Rohit Sharma"
            />
            {fieldError("name") ? (
              <p className="text-xs text-destructive">{fieldError("name")}</p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="lead-phone">Phone</Label>
            <Input
              id="lead-phone"
              value={values.phone}
              onChange={(e) => set("phone", e.target.value)}
              maxLength={32}
              placeholder="+91 98765 43210"
            />
            {/*
              ⚠️ NO `pattern` HERE. `lib/validators/sales.ts` is
              deliberately permissive about phone numbers, because a
              validator strict enough to be "correct" rejects the landline
              a builder has used for twenty years — and the rep responds by
              typing it into the notes, where nothing can dial it.
            */}
            {fieldError("phone") ? (
              <p className="text-xs text-destructive">{fieldError("phone")}</p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="lead-email">Email</Label>
            <Input
              id="lead-email"
              type="email"
              value={values.email}
              onChange={(e) => set("email", e.target.value)}
              maxLength={320}
            />
            {fieldError("email") ? (
              <p className="text-xs text-destructive">{fieldError("email")}</p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="lead-locality">Locality</Label>
            <Input
              id="lead-locality"
              value={values.locality}
              onChange={(e) => set("locality", e.target.value)}
              maxLength={160}
              placeholder="Whitefield"
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          A phone number or an email address is enough. One of the two is
          required — a lead you cannot reach is not a lead.
        </p>
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="font-medium">What they want</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="lead-source">Where they came from</Label>
            <select
              id="lead-source"
              value={values.source}
              onChange={(e) => set("source", e.target.value as LeadSource)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {/*
                ⚠️ THE LABELS COME FROM `lib/sales/pipeline.ts`, the same
                map the board and the table render. A hand-written list
                here is how "Walk-in" becomes "Walk in" on one screen.
              */}
              {(Object.keys(SOURCE_LABELS) as LeadSource[]).map((key) => (
                <option key={key} value={key}>
                  {SOURCE_LABELS[key]}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              This weighs the lead score. Somebody who walked into a site
              office has already spent a Saturday.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="lead-temperature">How warm</Label>
            <select
              id="lead-temperature"
              value={values.temperature}
              onChange={(e) => set("temperature", e.target.value as LeadTemperature)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="hot">Hot</option>
              <option value="warm">Warm</option>
              <option value="cold">Cold</option>
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="lead-budget-min">Budget from (₹)</Label>
            <Input
              id="lead-budget-min"
              inputMode="decimal"
              value={values.budgetMin}
              onChange={(e) => set("budgetMin", e.target.value)}
              placeholder="4500000"
            />
            {fieldError("budgetMin") ? (
              <p className="text-xs text-destructive">{fieldError("budgetMin")}</p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="lead-budget-max">Budget to (₹)</Label>
            <Input
              id="lead-budget-max"
              inputMode="decimal"
              value={values.budgetMax}
              onChange={(e) => set("budgetMax", e.target.value)}
              placeholder="6000000"
            />
            {fieldError("budgetMax") ? (
              <p className="text-xs text-destructive">{fieldError("budgetMax")}</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="lead-requirement">What they asked for</Label>
          <textarea
            id="lead-requirement"
            value={values.requirement}
            onChange={(e) => set("requirement", e.target.value)}
            maxLength={4000}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            placeholder="3BHK, east facing, possession within a year"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="lead-project">Project</Label>
            <select
              id="lead-project"
              value={values.projectId}
              onChange={(e) => set("projectId", e.target.value)}
              disabled={withheld.includes("projects")}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Not decided yet</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {/*
              ⚠️ AN EMPTY LIST IS EXPLAINED RATHER THAN LEFT EMPTY, and
              the two reasons for it are different. "You cannot see
              projects" is a role problem for an administrator; "there are
              no projects" is work for the person reading this.
            */}
            {withheld.includes("projects") ? (
              <p className="text-xs text-muted-foreground">
                Your role cannot read the project list, so this stays unset.
              </p>
            ) : projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No projects on file yet. A named project adds to the lead score.
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="lead-owner">Owner</Label>
            <select
              id="lead-owner"
              value={values.ownerId}
              onChange={(e) => set("ownerId", e.target.value)}
              disabled={withheld.includes("owners")}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {/*
                ⚠️ "Me" IS THE BLANK OPTION, not a name. `createLead`
                falls back to the acting user when `ownerId` is absent, so
                an unset owner is not an unowned lead — and saying so here
                stops a rep assigning themselves by hand every time.
              */}
              <option value="">Me</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {withheld.includes("owners") ? (
              <p className="text-xs text-muted-foreground">
                Your role cannot list colleagues. This lead will be yours.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="font-medium">Attribution and consent</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="lead-partner">Channel partner</Label>
            <select
              id="lead-partner"
              value={values.channelPartnerId}
              onChange={(e) => set("channelPartnerId", e.target.value)}
              disabled={withheld.includes("partners")}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Direct — no broker</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.hint ? ` · ${p.hint}` : ""}
                </option>
              ))}
            </select>
            {/*
              🔴 THE PROTECTION WINDOW STARTS THE MOMENT THIS IS SET, and
              the rep should know that before they set it. `createLead`
              records `cp_locked_until` at registration; after that the
              `leads_cp_lock` trigger refuses to move the attribution
              until it expires. A lead attributed to a broker with no
              window recorded is a commission argument with no evidence on
              either side, which is why it is not settable later "when we
              know".
            */}
            <p className="text-xs text-muted-foreground">
              Naming a firm starts their commission-protection window on this
              lead. It cannot be reassigned until that window expires.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="lead-consent">How you got permission to contact them</Label>
            <Input
              id="lead-consent"
              value={values.consentSource}
              onChange={(e) => set("consentSource", e.target.value)}
              maxLength={120}
              placeholder="Website enquiry form, 14 Aug"
            />
            {/*
              ⚠️ NOT REQUIRED, DELIBERATELY. Under the DPDP Act contacting
              somebody about a property needs a lawful basis, and consent
              is one of several — a CRM that refused to record a walk-in
              until a consent box was ticked would simply be worked
              around, on paper. Recording it is what makes the gap
              visible, and visible is what makes it fixable.
            */}
            <p className="text-xs text-muted-foreground">
              Optional, and worth filling in: this is the evidence behind any
              campaign you later run against this lead.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="font-medium">Overseas buyer</h2>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.isNri}
            onChange={(e) => set("isNri", e.target.checked)}
          />
          This buyer is an NRI
        </label>

        {/*
          ⭐ THE TIMEZONE IS THE FIELD THAT MATTERS, AND ONLY HERE.
          Calling a buyer in New Jersey at 11am IST is calling them at
          1:30am. The leads table shows their local clock and hides the
          ones it is uncivil to ring — but only for leads that carry a
          timezone, so an NRI lead saved without one is invisible to the
          single feature built for it.
        */}
        {values.isNri ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="lead-timezone">Their timezone</Label>
              <Input
                id="lead-timezone"
                value={values.timezone}
                onChange={(e) => set("timezone", e.target.value)}
                maxLength={64}
                placeholder="America/New_York"
              />
              {fieldError("timezone") ? (
                <p className="text-xs text-destructive">{fieldError("timezone")}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Without this the list cannot tell you what time it is where they
                are, which is the fastest way to lose an NRI lead.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="lead-country">Country code</Label>
              <Input
                id="lead-country"
                value={values.country}
                onChange={(e) => set("country", e.target.value.toUpperCase())}
                maxLength={2}
                placeholder="US"
              />
              {fieldError("country") ? (
                <p className="text-xs text-destructive">{fieldError("country")}</p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="lead-lang">Language for notices</Label>
              <Input
                id="lead-lang"
                value={values.preferredLang}
                onChange={(e) => set("preferredLang", e.target.value)}
                maxLength={8}
                placeholder="en"
              />
              <p className="text-xs text-muted-foreground">
                A payment demand a buyer cannot read does not get paid.
              </p>
            </div>
          </div>
        ) : null}
      </section>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {mode === "create" ? "Create lead" : "Save changes"}
        </Button>
        {onDone ? (
          <Button type="button" variant="outline" disabled={pending} onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
