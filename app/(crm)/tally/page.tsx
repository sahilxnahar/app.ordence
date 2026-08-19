/**
 * Ordence — Tally integration
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WAVE 1 — PHASE 37's SYNC, MADE VISIBLE
 * ══════════════════════════════════════════════════════════════════════
 * Connections, ledger and cost-centre mappings, export batches with
 * deterministic REMOTEIDs, import batches and a reconciliation queue were
 * all built. None of it had a screen.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY TALLY IS AN INTEGRATION AND NOT A COMPETITOR
 * ══════════════════════════════════════════════════════════════════════
 * Tally is the statutory book of record in most Indian firms and will stay
 * that way — the auditor asks for it, the CA works in it. The value here is
 * not replacing it; it is that nobody types the same voucher twice.
 *
 * ⚠️ THE REMOTEID IS DETERMINISTIC, AND THAT IS THE WHOLE FEATURE.
 * Re-exporting a batch UPDATES the voucher in Tally rather than creating a
 * second one. Anyone who has spent an afternoon deleting duplicated
 * vouchers from a Tally ledger understands why a re-runnable export is
 * worth more than a faster one.
 *
 * ⚠️ BROKEN MAPPINGS ARE THE ALARM ON THIS PAGE.
 * A mapping that is inactive, or that the engine has flagged, does not
 * error at export time — the transactions are simply absent from the
 * batch, and the discrepancy surfaces weeks later when the two systems
 * disagree. The inactive case is the nastier one: the ledger LOOKS mapped
 * in a list. So the count sits at the top, before anything reassuring.
 *
 * ⚠️ `endpointVerdict` IS SHOWN VERBATIM. Tally usually listens on a
 * private LAN address, which a cloud Worker cannot reach. The engine says
 * what the endpoint policy would decide *right now, without sending*, and
 * that sentence is more useful than a green dot that means nothing.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  getTallyConnections,
  getTallyLedgerMappings,
  getTallyExportBatches,
  /* ⭐⭐⭐ WAVE 10 — the write half of this module, which had no caller. */
  getTallyCostCentreMappings,
  getTallyImportBatches,
  getTallyMappableSources,
  getTallyReconciliation,
  getTallyTaxHeads,
  generateTallyExport,
  importTallyExport,
  markTallyExportDelivered,
  pushTallyExport,
  resolveTallyReconciliationItem,
  retireTallyLedgerMapping,
  upsertTallyConnection,
  upsertTallyCostCentreMapping,
  upsertTallyLedgerMapping,
} from "@/server/actions/tally";
import { TallyConnectionForm } from "./tally-connection-form";
import { TallyMappingEditor } from "./tally-mapping-editor";
import { TallyExportPanel } from "./tally-export-panel";
import { TallyImportPanel } from "./tally-import-panel";
import { TallyCostCentres } from "./tally-cost-centres";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tally · Ordence" };

function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
  const negative = minorUnits.startsWith("-");
  const digits = (negative ? minorUnits.slice(1) : minorUnits).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function bytes(n: number | null): string {
  if (!n) return "—";
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function TallyBody() {
  const [
    connections,
    mappings,
    batches,
    sources,
    taxHeads,
    costCentres,
    importBatches,
  ] = await Promise.all([
    getTallyConnections(true),
    getTallyLedgerMappings(),
    getTallyExportBatches({ limit: 25 }),
    /*
      ⭐ WAVE 10 — everything the editors need, fetched with the page
      rather than on a click. Each is `tally:read`, so a caller who can
      see this page can see all of it, and a failure in one leaves the
      others working: every result is checked independently below.
    */
    getTallyMappableSources(),
    getTallyTaxHeads(),
    getTallyCostCentreMappings(),
    getTallyImportBatches(),
  ]);

  const connectionRows = connections.ok ? connections.data.rows : [];
  const mappingRows = mappings.ok ? mappings.data.rows : [];
  const batchRows = batches.ok ? batches.data.rows : [];
  const sourceRows = sources.ok ? sources.data.rows : [];
  const sourcesTruncated = sources.ok ? sources.data.truncated : false;
  const taxHeadList = taxHeads.ok ? taxHeads.data.heads : [];
  /**
   * ⚠️ `groups` IS THE TALLY GROUP TABLE, value to label , not a
   * head-to-group map. The tax head's group is decided by the editor,
   * which defaults it to Duties & Taxes and says why.
   */
  const primaryGroups = Object.entries(taxHeads.ok ? taxHeads.data.groups : {}).map(
    ([value, label]) => ({ value, label }),
  );
  const costCentreRows = costCentres.ok ? costCentres.data.rows : [];
  const importBatchRows = importBatches.ok ? importBatches.data.rows : [];

  /*
   * ⚠️ NOT "rows with no Tally name" — a mapping row always has one, because
   * the row IS the mapping. The real signal is `findings`: the engine's own
   * validation of whether this mapping will actually work, plus mappings
   * that exist but have been switched off.
   *
   * An inactive mapping is the dangerous case. The ledger looks mapped in a
   * list, and its transactions are silently excluded from every export.
   */
  const problematic = mappingRows.filter(
    (m) => !m.isActive || m.findings.some((f) => f.severity !== "info"),
  );
  const activeConnections = connectionRows.filter((c) => c.isActive);
  const lastBatch = batchRows[0];

  return (
    <div className="space-y-6">
      {/* The alarm, before anything reassuring. See the page header. */}
      {problematic.length > 0 ? (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader>
            <CardTitle>
              {problematic.length} mapping{problematic.length === 1 ? "" : "s"} need
              attention
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              An inactive or invalid mapping does not error at export time. The
              transactions are simply absent from the batch, and the difference
              surfaces weeks later when the two systems disagree.
            </p>
            <ul className="divide-y rounded-md border">
              {problematic.slice(0, 20).map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-2 p-3 text-sm">
                  <span className="font-medium">{m.tallyLedgerName}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.sourceKind}
                    {m.sourceKey ? ` · ${m.sourceKey}` : ""}
                  </span>
                  {!m.isActive && (
                    <Badge variant="secondary" className="text-[10px]">inactive</Badge>
                  )}
                  {/* The engine's own findings, verbatim — they name the fault. */}
                  {m.findings
                    .filter((f) => f.severity !== "info")
                    .map((f) => (
                      <Badge
                        key={f.code}
                        variant={f.severity === "error" ? "destructive" : "outline"}
                        className="text-[10px] font-normal"
                      >
                        {f.message}
                      </Badge>
                    ))}
                </li>
              ))}
            </ul>
            {problematic.length > 20 && (
              <p className="text-xs text-muted-foreground">
                …and {problematic.length - 20} more.
              </p>
            )}
          </CardContent>
        </Card>
      ) : mappingRows.length > 0 ? (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
          Every mapping is active and valid. Nothing will be silently dropped
          from an export.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Connections
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {activeConnections.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {connectionRows.length - activeConnections.length} inactive
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Ledgers mapped
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {mappingRows.length - problematic.length}
              <span className="text-base text-muted-foreground">
                /{mappingRows.length}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              active and valid
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Last batch
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {lastBatch ? lastBatch.voucherCount : 0}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {lastBatch ? `vouchers · ${lastBatch.status}` : "no batches yet"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Last batch value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(lastBatch?.totalDebitMinor ?? "0")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {lastBatch?.periodStart
                ? `${lastBatch.periodStart} → ${lastBatch.periodEnd}`
                : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {connectionRows.length === 0 ? (
            <div className="space-y-2 p-6">
              <p className="text-sm text-muted-foreground">
                No Tally connection configured.
              </p>
              <p className="text-xs text-muted-foreground">
                Tally listens on a local network address on the machine it runs
                on. A cloud Worker cannot reach a private address directly — the
                usual arrangement is a file-based export the accountant imports,
                or a relay on the same network.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Name</th>
                    <th className="p-3 font-medium">Tally company</th>
                    <th className="p-3 font-medium">Endpoint</th>
                    <th className="p-3 font-medium">Last push</th>
                    <th className="p-3 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {connectionRows.map((c) => (
                    <tr key={c.id} className="hover:bg-muted/30">
                      <td className="p-3">
                        {c.name}
                        {!c.isActive && (
                          <Badge variant="secondary" className="ml-2 text-[10px]">
                            inactive
                          </Badge>
                        )}
                      </td>
                      <td className="p-3">{c.companyName}</td>
                      <td className="p-3 font-mono text-xs">
                        {c.host ?? "—"}:{c.port}
                        <div className="flex gap-1 pt-1">
                          {c.useTls && (
                            <Badge variant="outline" className="text-[10px]">TLS</Badge>
                          )}
                          {c.allowPrivateHost && (
                            <Badge variant="outline" className="text-[10px]">
                              private host allowed
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {c.lastPushAt ?? "never"}
                        {c.lastPushStatus && (
                          <span className="block">{c.lastPushStatus}</span>
                        )}
                        {c.lastPushDetail && (
                          <span className="block">{c.lastPushDetail}</span>
                        )}
                      </td>
                      <td className="p-3 text-xs">
                        {/*
                          The engine's own words about what would happen if we
                          pushed right now. More useful than a status dot,
                          because it names the reason.
                        */}
                        {c.endpointVerdict}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export batches</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {batchRows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No export batches yet. A batch covers a date range, carries a
              payload hash, and can be re-sent safely — the REMOTEID on each
              voucher is deterministic, so Tally updates rather than
              duplicates.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Batch</th>
                    <th className="p-3 font-medium">Period</th>
                    <th className="p-3 text-right font-medium">Vouchers</th>
                    <th className="p-3 text-right font-medium">Debit total</th>
                    <th className="p-3 font-medium">Delivery</th>
                    <th className="p-3 font-medium">Payload</th>
                    <th className="p-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {batchRows.map((b) => (
                    <tr key={b.id} className="hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">
                        {b.batchNumber}
                        <span className="block text-muted-foreground">
                          {b.companyName}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {b.periodStart} → {b.periodEnd}
                      </td>
                      <td className="p-3 text-right tabular-nums">{b.voucherCount}</td>
                      <td className="p-3 text-right tabular-nums">
                        {inr(b.totalDebitMinor)}
                      </td>
                      <td className="p-3 text-muted-foreground">{b.deliveryMode}</td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {bytes(b.payloadBytes)}
                        {b.payloadHash && (
                          /*
                            First 12 characters is enough to compare two
                            batches by eye and confirm a re-send is byte-for-byte
                            the same payload.
                          */
                          <span className="block font-mono">
                            {b.payloadHash.slice(0, 12)}…
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        <Badge
                          variant={
                            b.status === "delivered"
                              ? "secondary"
                              : b.status === "failed"
                                ? "destructive"
                                : "outline"
                          }
                          className="text-[10px]"
                        >
                          {b.status}
                        </Badge>
                        {b.deliveredAt && (
                          <span className="block text-xs text-muted-foreground">
                            {b.deliveredAt}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/*
        ⭐⭐⭐ WAVE 10 — THE WRITE HALF.

        Everything above this line existed and was read-only. Thirteen
        server actions , connections, mappings, cost centres, generate,
        push, deliver, import, reconcile , were built, tested, guarded,
        and reachable from nowhere. A screen that can only observe a
        module nobody can configure shows an empty list on every workspace
        and reads as a feature that does not work.
      */}
      <TallyConnectionForm rows={connectionRows} save={upsertTallyConnection} />

      <TallyMappingEditor
        rows={mappingRows}
        sources={sourceRows}
        sourcesTruncated={sourcesTruncated}
        taxHeads={taxHeadList}
        primaryGroups={primaryGroups}
        save={upsertTallyLedgerMapping}
        retire={retireTallyLedgerMapping}
      />

      <TallyCostCentres rows={costCentreRows} save={upsertTallyCostCentreMapping} />

      <TallyExportPanel
        connections={connectionRows.map((c) => ({
          id: c.id,
          name: c.name,
          isActive: c.isActive,
          host: c.host,
        }))}
        /*
          ⚠️ THE COMPANY NAME DEFAULTS FROM THE FIRST ACTIVE CONNECTION.
          Tally matches the company by name on import, and re-typing it
          per export is how a trailing space creates a second company
          there rather than failing.
        */
        defaultCompanyName={activeConnections[0]?.companyName ?? ""}
        generate={generateTallyExport}
        push={pushTallyExport}
        markDelivered={markTallyExportDelivered}
      />

      <TallyImportPanel
        batches={importBatchRows}
        runImport={importTallyExport}
        loadReconciliation={getTallyReconciliation}
        resolve={resolveTallyReconciliationItem}
      />

      <div className="rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium">Why re-sending a batch is safe</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Every voucher carries a REMOTEID derived deterministically from the
          transaction it represents. Sending the same batch twice makes Tally
          update the existing vouchers rather than create a second set — which
          is the difference between an integration you can retry and one you
          have to clean up afterwards.
        </p>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function TallyPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Tally</h1>
          <p className="text-sm text-muted-foreground">
            Connections, ledger mappings and export batches.
          </p>
        </div>
        <Link href="/statements" className="text-sm text-muted-foreground hover:underline">
          Financial statements
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <TallyBody />
      </Suspense>
    </div>
  );
}
