"use client";

/**
 * Ordence — ⭐⭐⭐ TEMPLATES, WHICH ARE THE THING THAT WAS MISSING
 * Version: v1.17.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO FINISHED ENGINES BOTH NEEDED A TEMPLATE ID AND NOTHING COULD
 * PRODUCE ONE
 * ══════════════════════════════════════════════════════════════════════
 * v1.14.0 built utility messaging. v1.15.0 built campaigns. Both take a
 * template id. `message_templates` could only ever be written by a sync
 * that does not exist yet, so the id could not exist either, so neither
 * engine could run even once.
 *
 * ⚠️ THE SCREEN IS DELIBERATELY HONEST ABOUT WHAT IT DOES NOT KNOW.
 * Declaring a template here does not approve it and cannot. Meta
 * approves templates, in their dashboard, on their timetable. Every
 * label on this screen is written to prevent the belief that pressing
 * Save here made something live.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface TemplateRow {
  id: string;
  connectionName: string;
  name: string;
  language: string;
  category: string;
  status: string;
  source: string;
  variableCount: number;
  body: string;
  blockedReason: string | null;
}

export function TemplateManager({
  templates,
  whatsappConnections,
  declareAction,
  disableAction,
}: {
  templates: readonly TemplateRow[];
  whatsappConnections: ReadonlyArray<{ id: string; name: string }>;
  declareAction: (i: unknown) => Promise<Result<{ id: string; variableCount: number }>>;
  disableAction: (i: unknown) => Promise<Result<{ disabled: true }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    connectionId: whatsappConnections[0]?.id ?? "",
    name: "",
    language: "en",
    category: "utility",
    body: "",
  });

  function declare() {
    if (!form.connectionId) {
      toast.error("Connect a WhatsApp account first. Templates belong to one.");
      return;
    }
    startTransition(async () => {
      const r = await declareAction(form);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setForm((p) => ({ ...p, name: "", body: "" }));
      toast.success(
        `Recorded with ${r.data.variableCount} variable${r.data.variableCount === 1 ? "" : "s"}. It is not approved until Meta says so.`,
      );
    });
  }

  function disable(id: string, name: string) {
    const reason = window.prompt(`Switch off "${name}". Why?`);
    if (!reason || reason.trim().length < 3) {
      if (reason !== null) toast.error("A short reason is needed.");
      return;
    }
    startTransition(async () => {
      const r = await disableAction({ templateId: id, reason: reason.trim() });
      if (!r.ok) toast.error(r.error);
      else toast.success("Switched off. The record and its message history stay.");
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Record a template</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {whatsappConnections.length === 0 ? (
            <p className="text-muted-foreground">
              Templates belong to a WhatsApp connection, and there is not one yet.
              Add it on the connections screen first.
            </p>
          ) : (
            <>
              {/**
               * ⚠️ THIS PARAGRAPH IS LOAD-BEARING. Without it people
               * believe this form creates a template. It does not, it
               * cannot, and the gap between those two beliefs is a
               * campaign that silently fails on its first send.
               */}
              <p className="text-muted-foreground">
                Write and submit the template in Meta&apos;s own dashboard first. This
                form records that it exists so Ordence can name it. It does not
                create it and it does not approve it.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="t-conn">WhatsApp account</Label>
                  <select
                    id="t-conn"
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={form.connectionId}
                    onChange={(e) => setForm((p) => ({ ...p, connectionId: e.target.value }))}
                  >
                    {whatsappConnections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <Label htmlFor="t-name">Template name</Label>
                  <Input
                    id="t-name"
                    value={form.name}
                    placeholder="order_dispatched"
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Exactly as it appears in Meta. Lower case, digits and
                    underscores only, which is their rule.
                  </p>
                </div>

                <div>
                  <Label htmlFor="t-lang">Language</Label>
                  <Input
                    id="t-lang"
                    value={form.language}
                    onChange={(e) => setForm((p) => ({ ...p, language: e.target.value }))}
                  />
                </div>

                <div>
                  <Label htmlFor="t-cat">Category</Label>
                  <select
                    id="t-cat"
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={form.category}
                    onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                  >
                    <option value="utility">Utility</option>
                    <option value="marketing">Marketing</option>
                    <option value="authentication">Authentication</option>
                  </select>
                  {/**
                   * 🔴 THE PRICE WARNING GOES NEXT TO THE FIELD THAT
                   * CHANGES THE PRICE, not in a help page.
                   */}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Meta decides this, not you, and they re-categorise. A utility
                    template that reads like an advertisement is moved to marketing
                    and the same send costs roughly seven times more.
                  </p>
                </div>
              </div>

              <div>
                <Label htmlFor="t-body">Body</Label>
                <Textarea
                  id="t-body"
                  rows={4}
                  value={form.body}
                  placeholder="Hello {{1}}, your order {{2}} has been dispatched."
                  onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Copy it exactly. The number of {"{{n}}"} placeholders has to match
                  the approved template or Meta refuses the send.
                </p>
              </div>

              <Button disabled={pending} onClick={declare}>
                Record it
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {templates.map((t) => (
        <Card key={t.id}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{t.name}</CardTitle>
              <Badge variant="secondary">{t.category}</Badge>
              <Badge variant="secondary">{t.language}</Badge>
              <Badge variant={t.status === "approved" ? "default" : "secondary"}>
                {t.status}
              </Badge>
              {/**
               * ⭐ "TOLD US" VERSUS "CONFIRMED". The distinction is the
               * whole reason `source` exists, so it is on the card.
               */}
              <Badge variant="secondary">
                {t.source === "synced" ? "confirmed by Meta" : "you told us"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">{t.connectionName}</p>
            <p className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{t.body}</p>
            <p className="text-xs text-muted-foreground">
              {t.variableCount} variable{t.variableCount === 1 ? "" : "s"}
            </p>
            {t.blockedReason && <p className="text-destructive">{t.blockedReason}</p>}
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs text-destructive"
              disabled={pending}
              onClick={() => disable(t.id, t.name)}
            >
              Switch off
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
