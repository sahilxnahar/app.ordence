"use client";

/**
 * Ordence — ⭐⭐⭐ THE CONFIGURATION CHAIN, ON THE SCREEN
 * Version: v1.46.0-alpha (Batch 47)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SCREEN'S JOB IS TO ANSWER "WHERE DOES THIS NUMBER COME FROM?"
 * ══════════════════════════════════════════════════════════════════════
 * Not "what is it" — a form field already showed that, and that was the
 * whole problem. Three settings in this console were a value with no
 * provenance: an operator could see 8192 and could not tell whether it
 * was the plan's number, a promise somebody made in a sales call, or a
 * typo from eighteen months ago. So nobody changed them.
 *
 * Every row here renders all three layers, marks which one wins, and
 * names the person who set the override.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND NOTHING SAVES WITHOUT A PREVIEW
 * ══════════════════════════════════════════════════════════════════════
 * The save button is disabled until the server has answered "effective
 * value for Acme changes from 2048 MB to 8192 MB". That is not a
 * confirmation step for its own sake — it is the sentence that catches
 * the specific failure this whole batch exists for: an override set to
 * the number the plan already gives, which changes nothing today and
 * silently freezes the workspace out of the next plan change.
 *
 * ⚠️ THE PREVIEW COMES FROM THE SERVER, not from the pure function this
 * component could also call. The client's copy of the plan tier and the
 * current override is as old as the page, and an operator who spent four
 * minutes writing a reason is previewing against a workspace that may
 * have been upgraded in the meantime.
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

const MIN_REASON = 20;

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; needsStepUp?: boolean; fieldErrors?: Record<string, string[]> };

export type ChainLayerView = {
  layer: "global" | "plan" | "tenant";
  label: string;
  present: boolean;
  /**
   * ⚠️ THE RAW VALUE AS WELL AS THE FORMATTED ONE, and the edit box
   * seeds from the raw. `formatted` carries a unit and elides long text
   * at 120 characters with an ellipsis — seeding a textarea from it
   * would silently truncate a suspension message the moment somebody
   * opened it to change one word.
   */
  value: string | number | null;
  formatted: string | null;
  reason?: string | null;
  setByEmail?: string | null;
  setAt?: string | null;
};

export type ChainRowView = {
  key: string;
  label: string;
  description: string;
  type: "integer" | "text";
  consumers: readonly string[];
  layers: readonly ChainLayerView[];
  effective: string | number;
  effectiveFormatted: string;
  effectiveLayer: "global" | "plan" | "tenant";
  invalidOverride: string | null;
};

export type DiffView = {
  key: string;
  label: string;
  changed: boolean;
  fromFormatted: string;
  toFormatted: string;
  fromLayer: string;
  toLayer: string;
  sentence: string;
  note: string | null;
};

export function ConfigChainPanel({
  tenantId,
  tenantName,
  planTier,
  rows,
  storageColumnMb,
  storageColumnDisagrees,
  versions,
  versionsReadable,
  canWrite,
  onPreview,
  onSave,
  onStepUp,
}: {
  tenantId: string;
  tenantName: string;
  planTier: string;
  rows: ChainRowView[];
  storageColumnMb: number;
  storageColumnDisagrees: boolean;
  versions: Array<{
    key: string;
    at: string;
    actorEmail: string | null;
    fromFormatted: string | null;
    toFormatted: string | null;
    reason: string | null;
  }>;
  versionsReadable: boolean;
  canWrite: boolean;
  onPreview: (input: {
    tenantId: string;
    key: string;
    mode: "set" | "clear";
    value?: string;
  }) => Promise<Result<DiffView>>;
  onSave: (input: {
    tenantId: string;
    key: string;
    mode: "set" | "clear";
    value?: string;
    reason: string;
  }) => Promise<Result<DiffView>>;
  onStepUp: () => Promise<{ ok: true }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<"set" | "clear">("set");
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [error, setError] = useState<string | null>(null);

  function begin(row: ChainRowView, nextMode: "set" | "clear") {
    setEditing(row.key);
    setMode(nextMode);
    setDraft(nextMode === "set" ? currentTenantValue(row) : "");
    setReason("");
    // ⚠️ CLEARED WHENEVER THE INPUTS MOVE. A preview left on screen next
    // to a value that has since been edited is a sentence that describes
    // a change nobody is about to make.
    setDiff(null);
    setError(null);
  }

  function preview() {
    if (!editing) return;
    setError(null);
    startTransition(async () => {
      const result = await onPreview({
        tenantId,
        key: editing,
        mode,
        ...(mode === "set" ? { value: draft } : {}),
      });
      if (!result.ok) {
        setDiff(null);
        setError(result.error);
        return;
      }
      setDiff(result.data);
    });
  }

  function save() {
    if (!editing) return;
    setError(null);
    startTransition(async () => {
      const result = await onSave({
        tenantId,
        key: editing,
        mode,
        ...(mode === "set" ? { value: draft } : {}),
        reason,
      });
      if (!result.ok) {
        if (result.needsStepUp) {
          toast.error("Confirm your identity, then try again.");
          return;
        }
        setError(result.error);
        return;
      }
      toast.success(result.data.sentence);
      setEditing(null);
      setDiff(null);
      setReason("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
        Every setting resolves <strong>global default → {planTier} plan → workspace
        override</strong>. The layer in bold is the one in force. An override is the only
        layer that is data: it carries whoever set it and why, and removing it is what makes
        the plan decide again.
      </p>

      {storageColumnDisagrees ? (
        <p
          role="alert"
          data-testid="storage-column-disagrees"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          ⚠️ The enforced storage ceiling on this workspace is{" "}
          <strong>{storageColumnMb} MB</strong>, which is not what the chain below resolves
          to. The column is what the upload path actually enforces, and it wins until
          somebody saves the storage ceiling through this screen or the plan form. Every
          workspace created before the chain existed looks like this.
        </p>
      ) : null}

      {rows.map((row) => {
        const isEditing = editing === row.key;
        return (
          <Card key={row.key}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                {row.label}
                <Badge variant={row.effectiveLayer === "tenant" ? "destructive" : "outline"}>
                  {row.effectiveFormatted}
                </Badge>
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {row.key}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">{row.description}</p>

              {row.invalidOverride ? (
                <p role="alert" className="rounded-md border border-destructive/40 p-2 text-xs">
                  {row.invalidOverride}
                </p>
              ) : null}

              <ol className="space-y-1">
                {row.layers.map((layer) => (
                  <li
                    key={layer.layer}
                    className={
                      layer.layer === row.effectiveLayer
                        ? "rounded-md border border-primary/40 bg-primary/5 p-2 text-xs"
                        : "p-2 text-xs text-muted-foreground"
                    }
                  >
                    <span className="font-medium">{layer.label}: </span>
                    {layer.present ? (
                      <span className={layer.layer === row.effectiveLayer ? "font-semibold" : ""}>
                        {layer.formatted}
                      </span>
                    ) : (
                      <span className="italic">
                        {layer.layer === "plan"
                          ? "no plan-level value — inherits the global default"
                          : "no override — the plan decides"}
                      </span>
                    )}
                    {layer.layer === "tenant" && layer.present ? (
                      <span className="block">
                        set by {layer.setByEmail ?? "an unknown operator"}
                        {layer.setAt ? ` on ${layer.setAt.slice(0, 10)}` : ""}
                        {layer.reason ? ` — ${layer.reason}` : ""}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>

              {/*
                ⭐ WHO READS THIS VALUE, BY NAME. A configuration key that
                nothing consumes is exactly the fault this batch fixed, so
                the catalogue is made to name its readers and the screen
                prints them. Where a value is NOT yet read by the thing an
                operator would assume, that sentence is here too.
              */}
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">What reads this value</summary>
                <ul className="mt-1 ml-4 list-disc space-y-1">
                  {row.consumers.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </details>

              {isEditing ? (
                <div className="space-y-3 rounded-md border border-border p-3">
                  {mode === "set" ? (
                    <div className="space-y-1">
                      <Label htmlFor={`value-${row.key}`}>New workspace override</Label>
                      {row.type === "text" ? (
                        <Textarea
                          id={`value-${row.key}`}
                          rows={3}
                          value={draft}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            setDiff(null);
                          }}
                        />
                      ) : (
                        <Input
                          id={`value-${row.key}`}
                          type="number"
                          value={draft}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            setDiff(null);
                          }}
                        />
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Removing the override. The workspace follows the {planTier} plan again —
                      including any future change to it.
                    </p>
                  )}

                  <Button variant="outline" size="sm" disabled={pending} onClick={preview}>
                    Preview the effect
                  </Button>

                  {diff ? (
                    <div
                      data-testid="config-diff"
                      className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm"
                    >
                      <p className="font-medium">{diff.sentence}</p>
                      {diff.note ? (
                        <p className="mt-1 text-xs text-muted-foreground">{diff.note}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {diff.fromLayer} → {diff.toLayer}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Preview before saving. The save stays disabled until you have read what
                      the effective value for {tenantName} becomes.
                    </p>
                  )}

                  <div className="space-y-1">
                    <Label htmlFor={`reason-${row.key}`}>
                      Why? (goes to the customer&rsquo;s own audit log)
                    </Label>
                    <Textarea
                      id={`reason-${row.key}`}
                      rows={2}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {reason.trim().length}/{MIN_REASON} characters minimum.
                    </p>
                  </div>

                  {error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={
                        !canWrite || pending || diff === null || reason.trim().length < MIN_REASON
                      }
                      onClick={save}
                    >
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setEditing(null);
                        setDiff(null);
                      }}
                    >
                      Close
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canWrite}
                    title={canWrite ? undefined : "Platform owner grade required."}
                    onClick={() => begin(row, "set")}
                  >
                    {row.effectiveLayer === "tenant" ? "Change the override" : "Override for this workspace"}
                  </Button>
                  {row.effectiveLayer === "tenant" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canWrite}
                      onClick={() => begin(row, "clear")}
                    >
                      Remove the override
                    </Button>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            Read back from this customer&rsquo;s own append-only audit log. There is no
            private platform copy and no separate version table — a history split across two
            tables cannot prove anything, because a reader has to trust both are complete.
          </p>
          {!versionsReadable ? (
            <p role="alert" className="text-destructive">
              The history could not be read. Empty is not the same as nothing happened —
              treat this as unknown, not as clear.
            </p>
          ) : versions.length === 0 ? (
            <p className="text-muted-foreground">No configuration change has been recorded.</p>
          ) : (
            <ul className="space-y-2">
              {versions.map((v, i) => (
                <li key={`${v.key}-${v.at}-${i}`} className="rounded-md border border-border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{v.key}</span>
                    <span>
                      {v.fromFormatted ?? "—"} → {v.toFormatted ?? "—"}
                    </span>
                    <span className="ml-auto text-muted-foreground">
                      {v.actorEmail ?? "unknown"} · {v.at.slice(0, 16).replace("T", " ")}
                    </span>
                  </div>
                  {v.reason ? <p className="mt-1 text-muted-foreground">{v.reason}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

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
  );
}

/**
 * Seed the edit box with the override if there is one, and with the
 * effective value otherwise.
 *
 * ⚠️ THE EFFECTIVE VALUE, NOT AN EMPTY BOX. Starting empty invites
 * somebody to retype a 400-character suspension message from memory, and
 * what they type will not be what was there.
 */
function currentTenantValue(row: ChainRowView): string {
  const tenant = row.layers.find((l) => l.layer === "tenant");
  if (tenant?.present && tenant.value !== null && tenant.value !== undefined) {
    return String(tenant.value);
  }
  return String(row.effective);
}
