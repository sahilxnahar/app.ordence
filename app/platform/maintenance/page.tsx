/**
 * Ordence — Platform Console · ⭐⭐⭐ MAINTENANCE MODE AND DEPLOY HISTORY
 * Version: v1.58.0-alpha
 * Runtime: Node (reads the database and the filesystem)
 *
 * ⚠️ THE GUARDS ARE ON THE ACTIONS, NOT ON THIS ROUTE.
 * `getMaintenanceOverview`, `setGlobalMaintenance` and
 * `setTenantMaintenance` each call `requireCapability` themselves, because
 * a server action is a POST to whatever URL the browser happens to be on.
 *
 * ⭐ TWO THINGS ON ONE PAGE BECAUSE THEY ARE ASKED TOGETHER. "Why is the
 * product read-only" and "what shipped just now" are the same question at
 * 3am, and a person holding one tab should not have to find the other.
 */

import {
  getMaintenanceOverview,
  setGlobalMaintenance,
  setTenantMaintenance,
} from "@/server/platform/control-actions";
import { listTenants } from "@/server/platform/tenants";
import { readDeployHistory } from "@/server/platform/deploy-history";
import { remainingMs } from "@/lib/platform/maintenance-policy";
import {
  MaintenanceConsole,
  type TenantOption,
} from "@/components/platform/maintenance-console";
import { DeployHistoryTable } from "@/components/platform/deploy-history-table";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function MaintenancePage() {
  const [overview, directory, deploys] = await Promise.all([
    getMaintenanceOverview(),
    listTenants({}),
    readDeployHistory(),
  ]);

  if (!overview.ok) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">
          {overview.error}
        </CardContent>
      </Card>
    );
  }

  /*
   * ⭐ THE COUNTDOWN'S ORIGIN IS THIS RENDER, ON THE SERVER, FROM THE
   * STORED END TIMESTAMP. It is recomputed on every render — including
   * every poll-driven `router.refresh()` — and the client only ever
   * re-derives it from the same absolute `endsAt`. A tab left open for six
   * hours therefore cannot extend or shorten the window it displays.
   */
  const renderedAt = new Date();
  const globalRemainingMs = remainingMs(overview.data.global?.endsAt ?? null, renderedAt);

  const tenantOptions: TenantOption[] = directory.ok
    ? directory.data.rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        slug: String(r.slug),
      }))
    : [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Maintenance and deploys</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Turning the product read-only, on purpose, and the little this
          system honestly knows about what is deployed.
        </p>
      </div>

      {!directory.ok ? (
        <p className="text-sm text-destructive">
          The workspace list could not be read, so a new per-workspace window
          cannot be started from this screen right now. Existing windows below
          can still be lifted.
        </p>
      ) : null}

      <MaintenanceConsole
        global={overview.data.global}
        globalRemainingMs={globalRemainingMs}
        tenantWindows={overview.data.tenants}
        tenantOptions={tenantOptions}
        renderedAt={renderedAt.toISOString()}
        onSetGlobal={setGlobalMaintenance}
        onSetTenant={setTenantMaintenance}
      />

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Deploy history</h2>
          {/*
            🔴 THE HONESTY PARAGRAPH IS PART OF THE FEATURE, NOT A
            DISCLAIMER. There is no deployments table in this system and
            this screen may not invent one. Anything below that is not the
            running process is a release NOTE — evidence that a version was
            prepared, never evidence that it deployed or succeeded.
          */}
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            <strong>What this can know:</strong> the version, commit and
            environment of the process answering this request, and the
            migration files present in this build. <strong>What it cannot
            know:</strong> when any earlier version was deployed, whether it
            succeeded, whether it was rolled back, or which migrations are
            actually applied in the database. Nothing here observes a deploy —
            Railway does the deploying and tells this process only about
            itself. Rows marked “recorded” are parsed from{" "}
            <code>CHANGELOG.md</code> and are a claim by whoever wrote the
            release note.
          </p>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            To learn what is actually applied, run{" "}
            <code>SQL-FILES/WHICH-MIGRATIONS-ARE-APPLIED-neon-safe.sql</code>{" "}
            against the database. This screen deliberately does not guess.
          </p>
          {deploys.gaps.map((gap) => (
            <p key={gap} className="mt-1 max-w-3xl text-sm text-amber-700 dark:text-amber-400">
              MISSING: {gap}
            </p>
          ))}
        </div>

        <DeployHistoryTable rows={deploys.rows} />
      </section>
    </div>
  );
}
