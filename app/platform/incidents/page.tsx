/**
 * Ordence — Platform Console · ⭐⭐⭐ INCIDENTS AND BREAK-GLASS
 * Version: v1.22.0-alpha
 * Runtime: Node
 *
 * ⚠️ The guards are on the actions, not on this route. `declareIncident`,
 * `resolveIncident`, `getIncidents`, `getMyBreakGlassDebt` and
 * `writeBreakGlassNote` each call `requireCapability` themselves, because
 * a server action is a POST to whatever URL the browser happens to be on.
 */

import {
  declareIncident,
  getIncidents,
  getMyBreakGlassDebt,
  resolveIncident,
  writeBreakGlassNote,
} from "@/server/platform/control-actions";
import { getPlatformOperator } from "@/server/platform/guard";
import {
  IncidentBoard,
  type IncidentView,
  type WriteUpView,
} from "@/components/platform/incident-board";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

export default async function IncidentsPage() {
  const operator = await getPlatformOperator();
  const [incidentResult, debtResult] = await Promise.all([
    getIncidents(),
    getMyBreakGlassDebt(),
  ]);

  if (!incidentResult.ok || !debtResult.ok) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">
          {incidentResult.ok ? debtResult.ok ? "" : debtResult.error : incidentResult.error}
        </CardContent>
      </Card>
    );
  }

  const incidents: IncidentView[] = incidentResult.data.map((r) => ({
    id: String(r.id),
    reference: String(r.reference),
    title: String(r.title),
    severity: String(r.severity),
    declaredAt: iso(r.declaredAt),
    resolvedAt: r.resolvedAt ? iso(r.resolvedAt) : null,
    summary: r.summary === null || r.summary === undefined ? null : String(r.summary),
  }));

  const writeUps: WriteUpView[] = debtResult.data.all.map((r) => ({
    sessionId: String(r.sessionId),
    tenantName: String(r.tenantName ?? ""),
    actorEmail: String(r.actorEmail ?? ""),
    justification: String(r.justification ?? ""),
    closedAt: iso(r.closedAt),
    dueAt: iso(r.dueAt),
    overdue: Boolean(r.overdue),
    hoursLate: Number(r.hoursLate ?? 0),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Incidents</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          A name for a bad hour, so everything done during it can be tied
          together afterwards, and the ledger of break-glass sessions still
          waiting to be written up.
        </p>
      </div>

      <IncidentBoard
        incidents={incidents}
        writeUps={writeUps}
        myEmail={operator?.email ?? ""}
        onDeclare={declareIncident}
        onResolve={resolveIncident}
        onWriteUp={writeBreakGlassNote}
      />
    </div>
  );
}
