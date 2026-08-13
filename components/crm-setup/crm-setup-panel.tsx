"use client";

/**
 * Ordence — ⭐⭐ LEAD SOURCES AND PIPELINE STAGES
 * Version: v1.21.0-alpha
 *
 * 🔴 These two tables were created in v1.10.0 and no screen has ever
 * referenced them. Every lead that has arrived from IndiaMART, JustDial
 * or Meta since v1.13.0 carries a null source because there was nothing
 * to point it at.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const CHANNELS = [
  "directory",
  "referral",
  "walk_in",
  "website",
  "social",
  "outbound",
  "other",
] as const;

export function CrmSetupPanel({
  sources,
  stages,
  leadsWithNoSource,
  createSourceAction,
  createStageAction,
}: {
  sources: ReadonlyArray<{
    id: string;
    name: string;
    connectorKey: string | null;
    isActive: boolean;
    leadCount: number;
  }>;
  stages: ReadonlyArray<{ id: string; name: string; position: number; outcome: string }>;
  leadsWithNoSource: number;
  createSourceAction: (i: unknown) => Promise<Result<{ id: string; name: string }>>;
  createStageAction: (i: unknown) => Promise<Result<{ id: string; name: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [src, setSrc] = useState({ name: "", channel: "directory", isPaid: false });
  const [stage, setStage] = useState({ name: "", position: "10", outcome: "open" });

  return (
    <div className="space-y-8">
      {leadsWithNoSource > 0 && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm">
            <p className="font-medium text-destructive">
              {leadsWithNoSource} lead{leadsWithNoSource === 1 ? " has" : "s have"} no
              source recorded.
            </p>
            <p className="mt-1 text-muted-foreground">
              {/**
               * ⚠️ THE HONEST EXPLANATION, because the alternative is
               * somebody assuming their staff forgot to fill a field.
               */}
              Until now there was nowhere to record one. Add your sources below and
              new enquiries will be labelled as they arrive; the existing ones stay
              unlabelled unless somebody sets them, because guessing where a lead
              came from is worse than admitting it is unknown.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Where enquiries come from</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label htmlFor="sn">Name</Label>
              <Input
                id="sn"
                value={src.name}
                placeholder="IndiaMART, walk-in, Rajesh referral"
                onChange={(e) => setSrc((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="sc">Kind</Label>
              <select
                id="sc"
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={src.channel}
                onChange={(e) => setSrc((p) => ({ ...p, channel: e.target.value }))}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={src.isPaid}
              onChange={(e) => setSrc((p) => ({ ...p, isPaid: e.target.checked }))}
            />
            {/**
             * ⭐ WHY THIS TICKBOX EARNS ITS PLACE. Cost per lead is only
             * computable if the system knows which sources were paid for.
             */}
            We pay for this one
          </label>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await createSourceAction(src);
                if (!r.ok) toast.error(r.error);
                else {
                  setSrc((p) => ({ ...p, name: "" }));
                  toast.success(`${r.data.name} added.`);
                }
              })
            }
          >
            Add source
          </Button>

          {sources.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="font-medium">{s.name}</span>
              {s.connectorKey && <Badge variant="secondary">{s.connectorKey}</Badge>}
              {!s.isActive && <Badge variant="secondary">inactive</Badge>}
              <span className="text-xs text-muted-foreground">
                {s.leadCount} lead{s.leadCount === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pipeline stages</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {/**
             * 🔴 THE WON/LOST POINT, STATED WHERE THE CHOICE IS MADE.
             */}
            A stage that ends the pipeline has to say which way it ended. A single
            &quot;closed&quot; stage puts won and lost in the same bucket and makes
            your conversion rate uncomputable.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="stn">Name</Label>
              <Input
                id="stn"
                value={stage.name}
                placeholder="Quoted"
                onChange={(e) => setStage((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="stp">Position</Label>
              <Input
                id="stp"
                inputMode="numeric"
                value={stage.position}
                onChange={(e) => setStage((p) => ({ ...p, position: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="sto">Ends the pipeline?</Label>
              <select
                id="sto"
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={stage.outcome}
                onChange={(e) => setStage((p) => ({ ...p, outcome: e.target.value }))}
              >
                <option value="open">No, still open</option>
                <option value="won">Yes, won</option>
                <option value="lost">Yes, lost</option>
              </select>
            </div>
          </div>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await createStageAction({
                  name: stage.name,
                  position: Number.parseInt(stage.position, 10) || 10,
                  outcome: stage.outcome,
                });
                if (!r.ok) toast.error(r.error);
                else {
                  setStage((p) => ({ ...p, name: "" }));
                  toast.success(`${r.data.name} added.`);
                }
              })
            }
          >
            Add stage
          </Button>

          {stages.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="tabular-nums text-xs text-muted-foreground">
                {s.position}
              </span>
              <span className="font-medium">{s.name}</span>
              {s.outcome !== "open" && (
                <Badge variant={s.outcome === "won" ? "default" : "destructive"}>
                  {s.outcome}
                </Badge>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
