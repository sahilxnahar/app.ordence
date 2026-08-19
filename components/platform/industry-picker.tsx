"use client";

/**
 * Ordence — ⭐ INDUSTRY ASSIGNMENT, WITH THE DIFF SHOWN FIRST (Section E)
 * Version: v0.53.0
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS IS THE MOST DESTRUCTIVE NON-DESTRUCTIVE ACTION IN THE CONSOLE
 * ══════════════════════════════════════════════════════════════════════
 * It deletes nothing. It also changes what every person in a customer's
 * workspace sees the next time they load a page: the menu is rebuilt, the
 * dashboard tiles are replaced, and the word for their own customers
 * changes — "Contacts" becomes "Guests" becomes "Patients". Their
 * training material, their internal wiki and the sentence their staff
 * says on the phone all stop matching the product overnight.
 *
 * A confirmation dialog that says "are you sure?" is worthless against
 * that, because the operator has no way to be sure of anything. So the
 * preview is not an optional extra behind a button — it renders as soon
 * as a template is selected, and the Apply control sits underneath it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PREVIEW IS COMPUTED IN THE BROWSER, AND THAT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════
 * `previewIndustryChange()` is pure — templates and the module registry
 * are static data with no I/O. Running it here means flipping through
 * thirteen industries costs nothing and writes NO audit rows.
 *
 * ⚠️ That matters more than the latency. A server round-trip per
 * selection would put a "platform staff read this workspace" row in the
 * customer's audit log for every option an operator idly clicked through,
 * and an audit trail with thirteen accidental reads in it is an audit
 * trail nobody can use. The WRITE is audited, in detail; browsing is not
 * an access.
 *
 * ⚠️ The server recomputes the same diff before writing. This copy is a
 * rendering, never the record.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { industryOptions, previewIndustryChange } from "@/lib/platform/configuration";
import type { IndustryKey } from "@/lib/industry-templates";

type SetResult =
  | { ok: true }
  | { ok: false; error: string; needsStepUp?: boolean };

const MIN_REASON = 20;

export function IndustryPicker({
  tenantId,
  slug,
  current,
  currentLabel,
  wasUnrecognised,
  navAllowed,
  canWrite,
  onApply,
  onStepUp,
}: {
  tenantId: string;
  slug: string;
  current: IndustryKey;
  currentLabel: string;
  wasUnrecognised: boolean;
  navAllowed: Record<string, boolean>;
  canWrite: boolean;
  onApply: (input: {
    tenantId: string;
    industry: string;
    confirmSlug: string;
    reason: string;
  }) => Promise<SetResult>;
  onStepUp: () => Promise<{ ok: true }>;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<IndustryKey>(current);
  const [confirmSlug, setConfirmSlug] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const preview = previewIndustryChange({
    from: current,
    to: target,
    allowed: navAllowed,
  });

  function apply() {
    startTransition(async () => {
      const result = await onApply({ tenantId, industry: target, confirmSlug, reason });
      if (result.ok) {
        setConfirmSlug("");
        setReason("");
        toast.success(`Industry set to ${preview.toLabel}.`);
        router.refresh();
        return;
      }
      if (result.needsStepUp) {
        toast.error("Confirm your identity, then try again.");
        return;
      }
      toast.error(result.error);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Industry template</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">
            Currently <strong>{currentLabel}</strong>.
            {wasUnrecognised ? (
              <span className="text-destructive">
                {" "}
                ⚠️ The stored value is not one this build recognises, so the workspace has
                been falling back to Generic. Setting it here fixes that.
              </span>
            ) : null}
          </p>

          <div className="space-y-1">
            <Label htmlFor="industry">Move to</Label>
            <select
              id="industry"
              value={target}
              onChange={(e) => setTarget(e.target.value as IndustryKey)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {industryOptions().map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {preview.unchanged ? (
        <p className="text-sm text-muted-foreground">
          That is the template they are on. Pick another to see what would change.
        </p>
      ) : (
        <Card data-testid="industry-preview">
          <CardHeader>
            <CardTitle>
              What {preview.fromLabel} → {preview.toLabel} does to their workspace
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-xs text-muted-foreground">
              Computed against THIS workspace&rsquo;s entitlements at the owner&rsquo;s
              level — the widest view anybody in it has. Nothing is deleted by this
              change; menu items that disappear are screens, not records.
            </p>

            <DiffList
              title="Menu items that appear"
              empty="Nothing new appears."
              items={preview.appearing.map((i) =>
                i.note ? `${i.label} — ${i.note}` : i.label,
              )}
            />

            <DiffList
              title="Menu items that disappear"
              empty="Nothing they use today goes away."
              items={preview.disappearing.map((i) => i.label)}
              tone="destructive"
            />

            {/*
              ⭐ THE RENAMES GET THEIR OWN BLOCK AND THE MOST SPACE.
              A vanished menu item is noticed by whoever used it. A rename
              is noticed by EVERYBODY, immediately, and it is the change
              that generates the phone call.
            */}
            <section>
              <h4 className="text-sm font-medium">
                Words that change ({preview.terminology.length})
              </h4>
              {preview.terminology.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  The vocabulary is identical between these two templates.
                </p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {preview.terminology.map((t) => (
                    <li key={t.key} className="text-xs">
                      <code className="font-mono text-muted-foreground">{t.key}</code>{" "}
                      <span className="text-muted-foreground">{t.from ?? "—"}</span>
                      {" → "}
                      <strong>{t.to ?? "—"}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
              <DiffList
                title="Dashboard tiles added"
                empty="None."
                items={preview.dashboardAdded}
              />
              <DiffList
                title="Dashboard tiles removed"
                empty="None."
                items={preview.dashboardRemoved}
                tone="destructive"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {!preview.unchanged ? (
        <Card>
          <CardContent className="space-y-3 pt-4">
            <div className="space-y-1">
              <Label htmlFor="industry-slug">
                Type the workspace address to confirm ({slug})
              </Label>
              <Input
                id="industry-slug"
                value={confirmSlug}
                onChange={(e) => setConfirmSlug(e.target.value)}
                aria-describedby="industry-slug-help"
              />
              <p id="industry-slug-help" className="text-xs text-muted-foreground">
                Not a security control — anyone can type a slug. It is here because the
                console shows rows of near-identical workspaces and the failure it
                prevents is rearranging the wrong customer&rsquo;s product.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="industry-reason">
                Why? (goes to the customer&rsquo;s audit log)
              </Label>
              <Textarea
                id="industry-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={
                  !canWrite ||
                  pending ||
                  reason.trim().length < MIN_REASON ||
                  confirmSlug.trim() !== slug
                }
                title={canWrite ? undefined : "Platform owner grade required."}
                onClick={apply}
              >
                Apply {preview.toLabel}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await onStepUp();
                    toast.success("Identity confirmed for the next 15 minutes.");
                  })
                }
              >
                Confirm identity
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function DiffList({
  title,
  items,
  empty,
  tone,
}: {
  title: string;
  items: string[];
  empty: string;
  tone?: "destructive";
}) {
  return (
    <section>
      <h4 className="text-sm font-medium">
        {title} ({items.length})
      </h4>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1">
          {items.map((item) => (
            <li key={item}>
              <Badge variant={tone === "destructive" ? "destructive" : "secondary"}>
                {item}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
