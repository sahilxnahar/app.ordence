/**
 * Ordence — Platform Console · ⭐⭐ THE ISOLATION CANARY
 * Version: v1.45.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS SCREEN IS NOT THE ALERTING, AND IT SAYS SO ON ITSELF
 * ══════════════════════════════════════════════════════════════════════
 * The alerting is `/api/cron/canary` answering a non-2xx to a scheduler
 * that is not this process. This page exists so that a human who has
 * been told "the canary is red" can find out WHY in one click instead of
 * reading a JSON body out of a cron log.
 *
 * ⭐ IT RUNS THE PROBE ON READ, exactly as `app/platform/health` runs its
 * sweep on read, and for the reason that page gives: a screen that only
 * works when the scheduler is healthy is a screen that is silently empty
 * on the morning the scheduler is the thing that broke. Opening this
 * page is therefore always an honest, current answer — never a cached
 * reassurance.
 *
 * ⚠️ THE PROBE IS READ-ONLY AND CHEAP (a handful of bounded `count(*)`s),
 * so running it on every page load is affordable. If that ever stops
 * being true the fix is to bound the probe, not to cache the verdict —
 * a cached green tick is the failure this whole feature exists to
 * prevent.
 *
 * ⚠️ ACCESS. `/platform(.*)` is gated to platform staff in middleware,
 * and `requirePlatformAdmin()` is called here anyway, because the
 * middleware check is a claim in a session token and this one is a row
 * in the database. Both, always — that is the house rule for this
 * console.
 */

import {
  runCanaryProbe,
  getLastCanaryRun,
  CANARY_TARGETS,
  CANARY_SYNTHETIC_TENANT_ID,
  type CanaryVerdict,
} from "@/server/platform/canary";
import { requirePlatformAdmin } from "@/server/platform/guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * ⚠️ INCONCLUSIVE IS AMBER, NOT GREY.
 *
 * Grey reads as "nothing to see". The whole point of the third verdict
 * is that it demands the same attention as a failure — it means the
 * probe could not prove anything, which on this screen is the state an
 * operator is most likely to talk themselves out of.
 */
const TONE: Record<CanaryVerdict, { label: string; className: string }> = {
  pass: {
    label: "ISOLATION HELD",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  breach: {
    label: "P0 — CROSS-TENANT READ SUCCEEDED",
    className: "border-destructive/50 bg-destructive/10 text-destructive",
  },
  inconclusive: {
    label: "INCONCLUSIVE — NOTHING WAS PROVED",
    className: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
};

export default async function CanaryPage() {
  await requirePlatformAdmin();

  /**
   * ⚠️ READ THE PREVIOUS RUN BEFORE STARTING A NEW ONE, or this page
   * would only ever show itself. The slot is process-local, so on most
   * loads it is either empty or this page's own last visit — which is
   * why the panel below labels it rather than presenting it as a record.
   */
  const previous = getLastCanaryRun();
  const result = await runCanaryProbe();
  const tone = TONE[result.verdict];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Isolation canary</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          A scope is opened for a workspace that does not exist, and from inside
          it the probe tries to read rows belonging to workspaces that do. Any
          row it gets back is a cross-tenant read that happened in production,
          on real customer data. It writes nothing, ever.
        </p>
      </div>

      <div className={`rounded-lg border p-4 ${tone.className}`}>
        <p className="text-sm font-semibold">{tone.label}</p>
        <p className="mt-1 text-sm">{result.headline}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">The connection this ran on</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          {result.connection ? (
            <>
              <p>
                <strong className="text-foreground">Effective role</strong>{" "}
                {result.connection.currentUser}
                {result.connection.sessionUser !== result.connection.currentUser
                  ? ` (logged in as ${result.connection.sessionUser})`
                  : ""}
                {" — "}
                superuser: {String(result.connection.isSuperuser)}, BYPASSRLS:{" "}
                {String(result.connection.hasBypassRls)}.
              </p>
              <p>
                A role that is a superuser or carries BYPASSRLS is exempt from
                every policy in the database. From such a connection this probe
                reads zero rows for a reason that has nothing to do with
                isolation, so it refuses to report a pass at all. That refusal
                is the most important behaviour on this page.
              </p>
            </>
          ) : (
            <p>The probe never established what connection it was running on.</p>
          )}
          <p className="border-t pt-2">
            Synthetic workspace id{" "}
            <code className="text-foreground">{CANARY_SYNTHETIC_TENANT_ID}</code>. Verified
            on every run to belong to no real workspace — otherwise the probe would be
            reading that workspace&apos;s own rows and calling them a leak.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            What was attempted, table by table ({result.provenTargets} proved,{" "}
            {result.inconclusiveTargets} proved nothing)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {result.targets.length === 0 ? (
            <p className="text-muted-foreground">
              No table was attempted. The probe stopped before making any assertion —
              the reason is in the banner above.
            </p>
          ) : (
            result.targets.map((t) => (
              <div key={t.table} className="border-b pb-3 last:border-b-0 last:pb-0">
                <p className="font-medium text-foreground">
                  {t.table} — {TONE[t.verdict].label}
                </p>
                <p className="mt-1 text-muted-foreground">{t.note}</p>
                <p className="mt-1 text-muted-foreground">
                  witness {t.witnessRows} · own-scope control {t.controlRows} · wrong-scope
                  targeted {t.crossTenantRowsTargeted} · wrong-scope any{" "}
                  {t.crossTenantRowsAny} · RLS enabled {String(t.rlsEnabled)} · forced{" "}
                  {String(t.rlsForced)}
                </p>
              </div>
            ))
          )}
          <p className="border-t pt-2 text-muted-foreground">
            The two controls are what make a zero mean anything. <strong>Witness</strong> is
            a real workspace that really has rows in that table, chosen from the table
            itself. <strong>Own-scope control</strong> is that workspace reading its own
            rows successfully. Without both, a zero from the wrong scope is an empty table
            or a broken query, not isolation.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Where this actually alerts from</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">Not here.</strong> The alert is{" "}
            <code className="text-foreground">/api/cron/canary</code> answering 500 on a
            breach and 503 when it proved nothing, to a scheduler that is not this process.
            This screen is for reading the detail after that has already gone off.
          </p>
          <p>
            The last run recorded in <em>this</em> process was{" "}
            {previous
              ? `${previous.verdict} at ${previous.finishedAt}`
              : "never — nothing has run here since the last deploy"}
            . That record is in memory only: it is empty after every deploy and knows
            nothing about runs on other instances, which is exactly why it is not the
            alerting.
          </p>
          <p className="border-t pt-2">
            {CANARY_TARGETS.length} tables are probed, chosen for what a leak in them would
            cost rather than as a sample:{" "}
            {CANARY_TARGETS.map((t) => t.table).join(", ")}.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
