/**
 * Ordence — Platform Console · ⭐⭐⭐ TENANT HEALTH
 * Version: v1.22.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A CORRECTION TO MY OWN STATUS DOCUMENT
 * ══════════════════════════════════════════════════════════════════════
 * Doc 84 said Ordence had no tenant health signal. That was wrong.
 * `lib/platform/health.ts` has scored workspaces since v0.14.0 and both
 * the directory and the detail page call it.
 *
 * ⚠️ WHAT WAS MISSING IS PERSISTENCE, plus the three rules a snapshot
 * structurally cannot see: a fortnight-over-fortnight collapse in
 * engagement, an error rate against a workspace's OWN normal, and an
 * integration that has quietly stopped bringing anything in.
 *
 * ⭐ THE SWEEP RUNS ON READ, inside `getOpenHealthEvents`. A cron would
 * be tidier and would also leave this screen silently empty on the
 * morning the scheduler is the thing that broke.
 */

import {
  getOpenHealthEvents,
  resolveHealthEvent,
} from "@/server/platform/control-actions";
import { HealthBoard, type HealthEventView } from "@/components/platform/health-board";
import { TREND_THRESHOLDS } from "@/lib/platform/health-rules";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

async function resolve(input: { eventId: string; note: string }) {
  "use server";
  const result = await resolveHealthEvent(input);
  return result.ok ? ({ ok: true } as const) : ({ ok: false, error: result.error } as const);
}

export default async function HealthPage() {
  const result = await getOpenHealthEvents();

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">{result.error}</CardContent>
      </Card>
    );
  }

  const events: HealthEventView[] = result.data.map((r) => ({
    id: String(r.id),
    tenantId: String(r.tenantId),
    tenantName: String(r.tenantName ?? ""),
    ruleKey: String(r.ruleKey),
    severity: String(r.severity),
    headline: String(r.headline),
    whatToDo: String(r.whatToDo ?? ""),
    detectedAt: iso(r.detectedAt),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Health</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Things that are still true because nobody has dealt with them. A row
          here does not disappear when the number moves — it is closed by a
          person writing what they did, or by the sweep recording that the
          cause resolved itself, and it says which.
        </p>
      </div>

      <HealthBoard events={events} onResolve={resolve} />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">The three rules a snapshot cannot see</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">Engagement collapse</strong> — a
            drop of {Math.round(TREND_THRESHOLDS.collapseDropFraction * 100)}% or
            more in active people fortnight over fortnight, ignored below{" "}
            {TREND_THRESHOLDS.collapseMinimumPriorUsers} people in the prior
            period because two-to-one is a 50% drop and means nothing.
          </p>
          <p>
            <strong className="text-foreground">Error spike</strong> —{" "}
            {TREND_THRESHOLDS.errorSpikeMultiple} times the workspace&apos;s own
            trailing rate, never a platform-wide threshold. A busy workspace at
            2% may be healthy; a quiet one moving from 0.1% to 1% is broken, and
            only the comparison to itself distinguishes them.
          </p>
          <p>
            <strong className="text-foreground">Integration gone dark</strong> —
            no successful sync for {TREND_THRESHOLDS.integrationDarkHours} hours.
            Measured from the last success, never the last attempt, and the
            customer has almost certainly not noticed because from where they
            sit it looks like a quiet week.
          </p>
          <p className="border-t pt-2">
            Seat and storage pressure are deliberately NOT raised here. They are
            sales signals that resolve themselves, and burying two rules that
            need a phone call under a pile of paperwork about workspaces doing
            well is how both get ignored.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
