"use client";

/**
 * Ordence — ⭐⭐⭐ HEALTH EVENTS SOMEBODY HAS TO CLOSE
 * Version: v1.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT A DASHBOARD
 * ══════════════════════════════════════════════════════════════════════
 * The observatory is the dashboard. It shows numbers, it recomputes on
 * every load, and nothing on it can be finished.
 *
 * 🔴 THIS SCREEN IS A LIST OF THINGS THAT ARE STILL TRUE BECAUSE NOBODY
 * HAS DEALT WITH THEM. The difference is that a row here cannot be made
 * to disappear by the number moving. It goes away when a person writes
 * what they did, or when the sweep records that the cause resolved
 * itself — and it says which.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type HealthEventView = {
  id: string;
  tenantId: string;
  tenantName: string;
  ruleKey: string;
  severity: string;
  headline: string;
  whatToDo: string;
  detectedAt: string;
};

type Result = { ok: true } | { ok: false; error: string };

const SEVERITY_ORDER: Readonly<Record<string, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function HealthBoard({
  events,
  onResolve,
}: {
  events: HealthEventView[];
  onResolve: (input: { eventId: string; note: string }) => Promise<Result>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const sorted = [...events].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      a.detectedAt.localeCompare(b.detectedAt),
  );

  function resolve(id: string) {
    startTransition(async () => {
      const result = await onResolve({ eventId: id, note });
      if (result.ok) {
        setOpen(null);
        setNote("");
        toast.success("Closed.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing is open. Every rule was evaluated when this page loaded, so an
        empty list here means the rules ran and found nothing rather than that
        a scheduler is down.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {sorted.map((event) => (
        <Card key={event.id} data-testid={`health-${event.ruleKey}`}>
          <CardContent className="space-y-2 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  event.severity === "high"
                    ? "destructive"
                    : event.severity === "medium"
                      ? "outline"
                      : "secondary"
                }
              >
                {event.severity}
              </Badge>
              <span className="font-medium">{event.headline}</span>
              <Link
                href={`/platform/tenants/${event.tenantId}`}
                className="ml-auto text-xs underline"
              >
                open workspace
              </Link>
            </div>

            {/*
              ⭐ THE ACTION LINE, FROZEN AT DETECTION. An alert with no
              next step is noise with a colour, and looking today's advice
              up from the rule table would show a sentence the person who
              raised it never saw.
            */}
            <p className="text-sm text-muted-foreground">{event.whatToDo}</p>

            <p className="text-xs text-muted-foreground">
              Open since {new Date(event.detectedAt).toLocaleString("en-IN")} ·{" "}
              <code className="font-mono">{event.ruleKey}</code>
            </p>

            {open === event.id ? (
              <div className="space-y-2">
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="What did you do about it? Ten characters minimum, and the next person reads this rather than the alert."
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={pending} onClick={() => resolve(event.id)}>
                    Close it
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpen(null);
                      setNote("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setOpen(event.id)}>
                Close with a note
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
