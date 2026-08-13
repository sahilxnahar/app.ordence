"use client";

/**
 * Ordence — ⭐⭐⭐ THE AGENT SHELF
 * Version: v1.20.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE LANE IS SHOWN ON EVERY CARD AND IS NOT A SETTING
 * ══════════════════════════════════════════════════════════════════════
 * It is derived from whether the agent has tools, because a tool returns
 * real business data and most free AI providers may train on what they
 * are sent. Presenting it as a dropdown would invite somebody to set an
 * agent that reads customers to the fast free lane, which is exactly the
 * mistake the lane exists to make impossible.
 *
 * ⭐ AND THE AUTONOMY SENTENCE IS SHOWN AT THE MOMENT SOMEBODY SWITCHES
 * IT ON, not in a help page. People assume an autonomous agent can act.
 * This one writes and stops, and that has to be said where the decision
 * is made.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

interface ShelfItem {
  key: string;
  label: string;
  blurb: string;
  tools: readonly string[];
  sensitivity: string;
  installed: boolean;
}

interface MyAgent {
  id: string;
  name: string;
  blurb: string;
  catalogueKey: string | null;
  tools: readonly string[];
  sensitivity: string;
  isEnabled: boolean;
  triggers: ReadonlyArray<{
    id: string;
    triggerType: string;
    recordType: string;
    dailyCap: number;
    isEnabled: boolean;
  }>;
}

/** ⚠️ Only the record types something in Ordence actually emits today. */
const RECORD_TYPES = [
  "purchase_order",
  "goods_receipt",
  "purchase_invoice",
] as const;

export function AgentShelf({
  shelf,
  mine,
  installAction,
  bindAction,
  editAction,
}: {
  shelf: readonly ShelfItem[];
  mine: readonly MyAgent[];
  installAction: (i: unknown) => Promise<Result<{ id: string; name: string }>>;
  bindAction: (i: unknown) => Promise<Result<{ bound: true; note: string }>>;
  editAction: (
    i: unknown,
  ) => Promise<Result<{ sensitivity: string; laneChanged: boolean }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [binding, setBinding] = useState<string | null>(null);
  const [recordType, setRecordType] = useState<string>(RECORD_TYPES[0]);
  const [cap, setCap] = useState("20");

  return (
    <div className="space-y-8">
      {/* ── MINE ─────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Your agents</h2>
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet. Install one from the shelf below and edit it until it sounds
            like your business. Your copy is yours: changing it never affects
            anyone else, and we never overwrite your wording.
          </p>
        ) : (
          mine.map((a) => (
            <Card key={a.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">{a.name}</CardTitle>
                  <Badge variant={a.sensitivity === "tenant" ? "default" : "secondary"}>
                    {a.sensitivity === "tenant"
                      ? "confidential lane"
                      : "drafting only"}
                  </Badge>
                  {!a.isEnabled && <Badge variant="secondary">off</Badge>}
                  {a.triggers.length > 0 && <Badge>runs by itself</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">{a.blurb}</p>

                {a.tools.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Reads: {a.tools.join(", ")}. Because it can read your data it
                    only ever goes to a provider that has committed in writing not
                    to train on it.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Drafts text and reads nothing. Safe on any provider, which
                    means it is also the fastest.
                  </p>
                )}

                {a.triggers.map((t) => (
                  <p key={t.id} className="text-xs">
                    Runs on <strong>{t.triggerType.replace(/_/g, " ")}</strong> for{" "}
                    <strong>{t.recordType.replace(/_/g, " ")}</strong>, up to{" "}
                    {t.dailyCap} times a day.
                  </p>
                ))}

                <div className="flex flex-wrap items-end gap-2">
                  {binding === a.id ? (
                    <>
                      <div>
                        <Label htmlFor={`rt-${a.id}`}>When this happens</Label>
                        <select
                          id={`rt-${a.id}`}
                          className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                          value={recordType}
                          onChange={(e) => setRecordType(e.target.value)}
                        >
                          {RECORD_TYPES.map((r) => (
                            <option key={r} value={r}>
                              a {r.replace(/_/g, " ")} is created
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="w-28">
                        <Label htmlFor={`cap-${a.id}`}>Max per day</Label>
                        <Input
                          id={`cap-${a.id}`}
                          inputMode="numeric"
                          value={cap}
                          onChange={(e) => setCap(e.target.value)}
                        />
                      </div>
                      <Button
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const r = await bindAction({
                              agentId: a.id,
                              triggerType: "record_created",
                              recordType,
                              dailyCap: Number.parseInt(cap, 10) || 20,
                            });
                            if (!r.ok) toast.error(r.error);
                            else {
                              setBinding(null);
                              toast.success(r.data.note);
                            }
                          })
                        }
                      >
                        Switch it on
                      </Button>
                      <Button variant="ghost" onClick={() => setBinding(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        disabled={pending}
                        onClick={() => setBinding(a.id)}
                      >
                        Make it run by itself
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const r = await editAction({
                              agentId: a.id,
                              isEnabled: !a.isEnabled,
                            });
                            if (!r.ok) toast.error(r.error);
                            else toast.success(a.isEnabled ? "Switched off." : "Switched on.");
                          })
                        }
                      >
                        {a.isEnabled ? "Switch off" : "Switch on"}
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {/* ── THE SHELF ────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Available to install</h2>
        <p className="text-sm text-muted-foreground">
          Starting points, not finished agents. Install one and it becomes a copy
          you own and can rewrite.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {shelf.map((s) => (
            <Card key={s.key}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-sm">{s.label}</CardTitle>
                  {s.installed && <Badge variant="secondary">installed</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <p className="text-muted-foreground">{s.blurb}</p>
                <Button
                  variant={s.installed ? "ghost" : "secondary"}
                  className="h-7 px-2 text-xs"
                  disabled={pending || s.installed}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await installAction({ catalogueKey: s.key });
                      if (!r.ok) toast.error(r.error);
                      else toast.success(`${r.data.name} installed. It is yours to edit.`);
                    })
                  }
                >
                  {s.installed ? "Already yours" : "Install"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
