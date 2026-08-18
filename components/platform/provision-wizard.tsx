"use client";

/**
 * Ordence — Provisioning wizard
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO STEPS, AND THE FIRST ONE IS NOT SKIPPABLE
 * ══════════════════════════════════════════════════════════════════════
 * Describe → read the plan → approve. There is no "create" button on the
 * form itself, and adding one would be a mistake worth resisting.
 *
 * Provisioning is the only genuinely irreversible operation in the
 * platform: it mints a public hostname and a billing identity, and
 * "delete it and try again" stops being true the moment somebody logs in.
 * A confirmation dialog would not help — people click those. Reading a
 * numbered list of what is about to happen is a different cognitive act
 * from dismissing a modal, and it is the one that catches a typo in a
 * slug before it becomes a customer's address.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { ProvisionPlan, ProvisionOutcome } from "@/server/platform/provisioning";
import { CONFIGURABLE_PLAN_TIERS } from "@/lib/platform/configuration";
import { suggestSlugs } from "@/lib/slug";

type IndustryOption = { key: string; label: string; description: string };

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function ProvisionWizard({
  industries,
  planAction,
  provisionAction,
}: {
  industries: IndustryOption[];
  planAction: (input: unknown) => Promise<Result<ProvisionPlan>>;
  provisionAction: (input: unknown) => Promise<Result<ProvisionOutcome>>;
}) {
  const [pending, startTransition] = useTransition();
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [outcome, setOutcome] = useState<ProvisionOutcome | null>(null);
  /**
   * ⭐ THE SERVER'S REFUSAL, KEPT ON THE SCREEN.
   *
   * 🔴 THE DISABLED BUTTON IS A MISTAKE GUARD, NOT A BOUNDARY.
   * `provisionTenant()` re-plans inside its own transaction and
   * `claimSlug()` inserts with `ON CONFLICT (slug) DO NOTHING`, so a slug
   * that was free when the dry run ran can be gone by the time apply
   * arrives — the race the plan cannot close. That refusal used to be a
   * toast, which vanishes in four seconds and takes the reason with it.
   * It is state now, rendered with the alternatives, because the operator
   * reading it has a customer on the phone waiting for an address.
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [form, setForm] = useState({
    name: "",
    legalName: "",
    slug: "",
    industry: industries[0]?.key ?? "generic",
    // ⚠️ `trial`, not `free`. See the note on `planTier` in
    // `server/platform/provisioning.ts` — the four values this form used
    // to offer were not members of the `plan_tier` enum at all, so every
    // provision failed on the INSERT.
    planTier: "trial",
    seatLimit: "5",
    storageLimitMb: "1024",
    trialDays: "14",
    ownerEmail: "",
    customDomain: "",
    reason: "",
  });

  /** The shape both server functions expect. Built once so they cannot drift. */
  function payload() {
    return {
      ...form,
      legalName: form.legalName || undefined,
      customDomain: form.customDomain || undefined,
      seatLimit: Number.parseInt(form.seatLimit, 10),
      storageLimitMb: Number.parseInt(form.storageLimitMb, 10),
      trialDays: Number.parseInt(form.trialDays, 10),
    };
  }

  function set(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Any edit invalidates the plan. Approving a plan that describes
    // different values from the ones in the form is the exact failure this
    // whole two-step design exists to prevent.
    setPlan(null);
    setRefusal(null);
    setFieldErrors({});
  }

  function runPlan() {
    startTransition(async () => {
      const result = await planAction(payload());
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }
      setFieldErrors({});
      setPlan(result.data);
    });
  }

  function runProvision() {
    startTransition(async () => {
      const result = await provisionAction(payload());
      if (!result.ok) {
        /*
         * ⚠️ THE MESSAGE IS THE SERVER'S, WORD FOR WORD, AND IT IS NOT
         * COLLAPSED INTO "provisioning failed". `provisionTenant()`
         * distinguishes four database refusals — taken, too similar,
         * reserved, recently released — and each one tells the operator a
         * different thing to do next. Keeping it verbatim is what makes
         * the panel below useful instead of decorative.
         */
        setRefusal(result.error);
        toast.error(result.error);
        // Re-plan so the operator sees the CURRENT state of the world,
        // not the one that was true before somebody else claimed the name.
        const fresh = await planAction(payload());
        if (fresh.ok) setPlan(fresh.data);
        return;
      }
      setOutcome(result.data);
      setPlan(null);
      setRefusal(null);
      toast.success(`Workspace ${result.data.slug} created.`);
    });
  }

  /**
   * ⚠️ CANDIDATES, NOT OFFERS. `suggestSlugs()` only checks SHAPE — it
   * cannot know what is taken, reserved or inside the 365-day retention
   * window. So pressing one does NOT provision anything: it loads the name
   * into the form and clears the plan, and the operator has to preview it,
   * which is the query that asks the database. Presenting these as
   * "available" would teach the operator that this screen's answers are
   * unreliable on the one screen where they most need to believe it.
   */
  const alternatives = suggestSlugs(form.slug, 4);

  /*
   * ⭐ THE TWO HALVES OF THE DIFF. `mutating && !external` is what this
   * transaction writes and can roll back; `external` is what survives it
   * as a job for a person. Splitting the numbered list by that flag is
   * the whole point of the flag existing on `ProvisionStep`.
   */
  const writesInTransaction = plan ? plan.steps.filter((s) => s.mutating && !s.external) : [];
  const leftPending = plan ? plan.steps.filter((s) => s.external) : [];

  /* ── Done ────────────────────────────────────────────────────────── */
  if (outcome) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Workspace created</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            <span className="font-medium">{outcome.slug}</span> is live at{" "}
            <a
              href={outcome.workspaceUrl}
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              {outcome.workspaceUrl}
            </a>
          </p>

          {outcome.pending.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
              <p className="text-sm font-medium">Still outstanding</p>
              <p className="mt-1 text-xs text-muted-foreground">
                These touch systems outside our database, so they could not be
                part of the transaction. They are listed rather than attempted
                silently — a half-finished provision should be visible.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {outcome.pending.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <Button variant="outline" onClick={() => setOutcome(null)}>
            Provision another
          </Button>
        </CardContent>
      </Card>
    );
  }

  const field = (key: string) => fieldErrors[key]?.[0];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* ── Step 1: describe ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>1 · Describe the workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Workspace name</Label>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Ameya Heights"
            />
            {field("name") && <p className="text-xs text-red-600">{field("name")}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="slug">Address</Label>
            <div className="flex items-center gap-1">
              <Input
                id="slug"
                value={form.slug}
                onChange={(e) => set("slug", e.target.value)}
                placeholder="ameya"
                className="font-mono"
              />
              <span className="whitespace-nowrap text-sm text-muted-foreground">
                .app.ordence.com
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              This becomes a public hostname. It cannot be changed once anyone
              has signed in.
            </p>
            {field("slug") && <p className="text-xs text-red-600">{field("slug")}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="industry">Industry pack</Label>
            <select
              id="industry"
              value={form.industry}
              onChange={(e) => set("industry", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {industries.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {industries.find((i) => i.key === form.industry)?.description}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="planTier">Plan</Label>
              <select
                id="planTier"
                value={form.planTier}
                onChange={(e) => set("planTier", e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {CONFIGURABLE_PLAN_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="trialDays">Trial days</Label>
              <Input
                id="trialDays"
                type="number"
                min={0}
                max={90}
                value={form.trialDays}
                onChange={(e) => set("trialDays", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seatLimit">Seats</Label>
              <Input
                id="seatLimit"
                type="number"
                min={1}
                value={form.seatLimit}
                onChange={(e) => set("seatLimit", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="storageLimitMb">Storage (MB)</Label>
              <Input
                id="storageLimitMb"
                type="number"
                min={100}
                value={form.storageLimitMb}
                onChange={(e) => set("storageLimitMb", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ownerEmail">Owner email</Label>
            <Input
              id="ownerEmail"
              type="email"
              value={form.ownerEmail}
              onChange={(e) => set("ownerEmail", e.target.value)}
              placeholder="owner@customer.com"
            />
            {field("ownerEmail") && (
              <p className="text-xs text-red-600">{field("ownerEmail")}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="customDomain">Custom domain (optional)</Label>
            <Input
              id="customDomain"
              value={form.customDomain}
              onChange={(e) => set("customDomain", e.target.value)}
              placeholder="crm.customer.com"
              className="font-mono"
            />
            {field("customDomain") && (
              <p className="text-xs text-red-600">{field("customDomain")}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reason">Who is this for?</Label>
            <Input
              id="reason"
              value={form.reason}
              onChange={(e) => set("reason", e.target.value)}
              placeholder="Signed 2 Aug, onboarding call Monday"
            />
            <p className="text-xs text-muted-foreground">
              Goes into the audit trail. Required.
            </p>
            {field("reason") && <p className="text-xs text-red-600">{field("reason")}</p>}
          </div>

          <Button onClick={runPlan} disabled={pending} className="w-full">
            {pending ? "Working…" : "Preview what this will do"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Step 2: read the plan ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>2 · Read the plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            🔴 THE REFUSAL, RENDERED — NOT A TOAST.
            The dry run said this could proceed and the database said no.
            That is not a bug and not a generic failure: between the two
            somebody else claimed the name, or the retention window moved.
            The operator needs the reason and a next name, on screen, for
            as long as it takes them to type it.
          */}
          {refusal && (
            <div className="rounded-md border-2 border-red-400 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950/40">
              <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                Refused — nothing was created
              </p>
              <p className="mt-1 text-sm">{refusal}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                The whole provision ran inside one transaction and it was rolled
                back. There is no half-made workspace to clean up, and the owner
                email was not sent.
              </p>
              {alternatives.length > 0 && (
                <div className="mt-3 space-y-1">
                  <p className="text-xs font-medium">
                    Names of the right shape — press one to load it, then preview
                    it. Shape only: whether it is free is a question for the
                    database, and preview is what asks.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {alternatives.map((candidate) => (
                      <Button
                        key={candidate}
                        type="button"
                        size="sm"
                        variant="outline"
                        className="font-mono"
                        onClick={() => set("slug", candidate)}
                      >
                        {candidate}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {!plan ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been created. Fill in the form and press preview — this
              side will show exactly what will happen, in order, before anything
              is written.
            </p>
          ) : (
            <>
              {/*
                ⚠️ ADVISORY, AND IT SAYS SO. Time passes between reading
                this and approving it. `claimSlug()` inserts with ON
                CONFLICT DO NOTHING inside the transaction and is the only
                thing that actually decides — everything below is what
                WOULD happen if nothing changes in the meantime.
              */}
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  Dry run · nothing has been written.
                </span>{" "}
                This is advice, not a reservation. The address is claimed at the
                moment you press create, not now, so somebody else can take it
                between these two clicks. If they do, the create is refused and
                nothing is created.
              </p>

              {plan.blockers.length > 0 && (
                <div className="rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/40">
                  <p className="text-sm font-medium text-red-700 dark:text-red-300">
                    Blocked — create is switched off
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Each of these is a refusal the database would issue. Clear
                    them in the form on the left and preview again.
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {plan.blockers.map((b) => (
                      // ⚠️ The blocker string already carries the operator
                      // message from `lib/slug.ts` — what to do about it is
                      // part of the sentence, not a separate lookup here,
                      // so the wording cannot drift away from the refusal.
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                  {alternatives.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium">Try instead:</span>
                      {alternatives.map((candidate) => (
                        <Button
                          key={candidate}
                          type="button"
                          size="sm"
                          variant="outline"
                          className="font-mono"
                          onClick={() => set("slug", candidate)}
                        >
                          {candidate}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {plan.warnings.map((w) => (
                <p
                  key={w}
                  className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40"
                >
                  {w}
                </p>
              ))}

              {/*
                ⭐⭐ THE DIFF. The plan already computed all of this and
                nothing showed it as a CHANGE — a numbered list of five
                verbs does not tell an operator what is different
                afterwards. Two columns do: what is true now, what is true
                after. Every line on the right is a line the transaction
                writes; the external steps are below, separately, because
                they are NOT true when the button stops spinning.
              */}
              <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Now
                  </p>
                  <ul className="space-y-1.5 text-sm">
                    <li>
                      <span className="font-mono text-xs break-all">
                        {plan.workspaceUrl}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        No workspace holds this address.
                      </span>
                    </li>
                    <li className="text-muted-foreground">
                      No roles, no industry pack, no billing identity.
                    </li>
                    {plan.dns.length > 0 && (
                      <li className="text-muted-foreground">
                        The custom domain points nowhere we control.
                      </li>
                    )}
                  </ul>
                </div>

                <div className="space-y-2 sm:border-l sm:pl-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    After you press create
                  </p>
                  <ul className="space-y-1.5 text-sm">
                    <li>
                      <Badge variant="secondary" className="mr-1.5 text-[10px]">
                        created
                      </Badge>
                      <span className="font-mono text-xs break-all">
                        {plan.workspaceUrl}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Live immediately — the wildcard record already resolves.
                      </span>
                    </li>
                    {writesInTransaction.map((step) => (
                      <li key={step.order}>
                        {/*
                          ⚠️ THE WORD "created", NOT A GREEN DOT. One in
                          twelve Indian men is colour-blind; a colour that
                          carries meaning on its own carries none for them.
                        */}
                        <Badge variant="secondary" className="mr-1.5 text-[10px]">
                          created
                        </Badge>
                        <span className="font-medium">{step.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {step.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/*
                ⚠️ NOT PART OF THE TRANSACTION, SO NOT PART OF "AFTER".
                These are listed as work that remains, because a provision
                that half-happened must be visible or it becomes an orphan
                nobody knows to finish.
              */}
              {leftPending.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Still yours to do afterwards — outside the transaction
                  </p>
                  <ul className="space-y-1.5 text-sm">
                    {leftPending.map((step) => (
                      <li key={step.order}>
                        <Badge variant="outline" className="mr-1.5 text-[10px]">
                          pending
                        </Badge>
                        <span className="font-medium">{step.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {step.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/*
                ⭐ WHAT THE CUSTOMER ACTUALLY SEES ON DAY ONE.
                The industry pack and the plan were both inputs on the left
                and neither was ever an outcome on the right. That gap is
                where the "but sales promised us Rate Cards" call comes
                from — and it is cheapest to correct before the workspace
                exists.
              */}
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  Granted on day one — {plan.industryLabel} on {plan.planTierLabel}{" "}
                  <span className="font-normal text-muted-foreground">
                    ({plan.dayOneMenu.length} of{" "}
                    {plan.dayOneMenu.length + plan.hiddenByPlan.length} screens in
                    the pack)
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {plan.dayOneMenu.join(" · ")}
                </p>
                {plan.hiddenByPlan.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {/* ⚠️ "Not granted" in words. This is the difference
                        between what sales described and what the customer
                        will see, and it is cheapest to correct now. */}
                    Not granted by {plan.planTierLabel}, so these will not appear:{" "}
                    {plan.hiddenByPlan.join(", ")}.
                  </p>
                )}
              </div>

              {plan.dns.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    DNS records the customer must add before the domain works
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {/* ⚠️ We do not add these. Nothing in this transaction
                        touches Cloudflare, so the domain stays recorded and
                        unverified until these two resolve. The verification
                        token is derived from the slug, so previewing again
                        gives the same value — hand it over twice safely. */}
                    Creating the workspace does not create these. Until they
                    resolve the custom domain is recorded and unverified, and the
                    workspace address above is the live one.
                  </p>
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-left">
                        <tr>
                          <th className="p-2 font-medium">Type</th>
                          <th className="p-2 font-medium">Name</th>
                          <th className="p-2 font-medium">Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y font-mono">
                        {plan.dns.map((record) => (
                          <tr key={`${record.type}-${record.name}`}>
                            <td className="p-2">{record.type}</td>
                            <td className="p-2 break-all">{record.name}</td>
                            <td className="p-2 break-all">{record.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Button
                  onClick={runProvision}
                  disabled={pending || plan.blockers.length > 0}
                  className="w-full"
                >
                  {pending ? "Creating…" : `Create ${plan.slug}`}
                </Button>
                {/*
                  ⚠️ A DISABLED BUTTON THAT DOES NOT SAY WHY IS A BUG
                  REPORT. The state is carried by the sentence, not by the
                  greyed-out fill, for the colour-blindness reason above.
                */}
                <p className="text-xs text-muted-foreground">
                  {plan.blockers.length > 0
                    ? `Create is off: ${plan.blockers.length} blocker${
                        plan.blockers.length === 1 ? "" : "s"
                      } above must be cleared first. It is a guard against a
                       mistake, not the boundary — the database refuses these
                       again at insert time whatever this screen shows.`
                    : "No blockers as of this preview. The address is claimed when you press create, not now."}
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
