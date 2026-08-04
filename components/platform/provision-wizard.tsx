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
        toast.error(result.error);
        // Re-plan so the operator sees why, rather than a bare toast.
        const fresh = await planAction(payload());
        if (fresh.ok) setPlan(fresh.data);
        return;
      }
      setOutcome(result.data);
      setPlan(null);
      toast.success(`Workspace ${result.data.slug} created.`);
    });
  }

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
          {!plan ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been created. Fill in the form and press preview — this
              side will show exactly what will happen, in order, before anything
              is written.
            </p>
          ) : (
            <>
              {plan.blockers.length > 0 && (
                <div className="rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/40">
                  <p className="text-sm font-medium text-red-700 dark:text-red-300">
                    Cannot proceed
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {plan.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
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

              <ol className="space-y-2">
                {plan.steps.map((step) => (
                  <li key={step.order} className="flex gap-3 text-sm">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs tabular-nums">
                      {step.order}
                    </span>
                    <span>
                      <span className="font-medium">{step.title}</span>
                      {step.external && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          outside the transaction
                        </Badge>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {step.detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>

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
                  Their menu on day one — {plan.industryLabel} on {plan.planTierLabel}
                </p>
                <p className="text-xs text-muted-foreground">
                  {plan.dayOneMenu.join(" · ")}
                </p>
                {plan.hiddenByPlan.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    In the pack but not in the plan, so it will not appear:{" "}
                    {plan.hiddenByPlan.join(", ")}.
                  </p>
                )}
              </div>

              {plan.dns.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    DNS records to give the customer
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

              <Button
                onClick={runProvision}
                disabled={pending || plan.blockers.length > 0}
                className="w-full"
              >
                {pending ? "Creating…" : `Create ${plan.slug}`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
