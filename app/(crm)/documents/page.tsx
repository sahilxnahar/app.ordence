/**
 * Ordence — THE DOCUMENT REGISTER
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONLY SCREEN IN THE PRODUCT THAT CAN SEE A FILE NOTHING POINTS AT
 * ══════════════════════════════════════════════════════════════════════
 * Every record page already lists its own attachments, so a register
 * that merely repeated them would be a slower version of somewhere the
 * user already was. This one exists for the files those pages CANNOT
 * show:
 *
 *   `documents.entity_id` has no foreign key. It cannot: the link is
 *   `(entity_type, entity_id)` across five tables, and Postgres will not
 *   point a constraint at five tables at once. The schema says so
 *   plainly and calls the trade honest — it is.
 *
 * ⚠️ BUT NOTHING CASCADES. Delete the deal and the attachment rows stay.
 * The BYTES stay, in a private blob store that bills by the gigabyte,
 * past whatever retention the engagement letter promised. The only
 * screen that listed them was the deal page, and the deal page is gone.
 *
 * So this page opens with two counts nothing else in the product can
 * produce — files whose parent matches no row at all, and files whose
 * parent is soft-deleted — and only then shows the register.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NO DOWNLOAD LINKS ON THIS SCREEN, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * The bytes are served through `/api/documents/[id]/download`, which
 * re-checks the session and the tenant before streaming. This is a
 * read-only inventory: it says what exists, how big it is and whether
 * anything still points at it. Handing out a link to a file whose parent
 * record was deleted is the opposite of what the page is for.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listDocumentRegister } from "@/server/actions/documents";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Documents · Ordence" };

/**
 * Bytes, in the unit a human would say out loud.
 *
 * Binary units (1024) rather than decimal, because the blob store bills
 * in them and a register that disagrees with the invoice is a register
 * somebody has to reconcile by hand.
 */
function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const ENTITY_LABEL: Record<string, string> = {
  contract: "Contract",
  asset: "Asset",
  deal: "Deal",
  contact: "Contact",
  company: "Company",
};

/** The bit of a MIME type worth reading at a glance. */
function fileKind(mimeType: string): string {
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("image/")) return mimeType.slice(6).toUpperCase();
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "XLSX";
  if (mimeType.includes("word") || mimeType.includes("document")) return "DOCX";
  if (mimeType.startsWith("text/")) return mimeType.slice(5).toUpperCase();
  return mimeType.split("/").pop()?.slice(0, 12).toUpperCase() ?? "FILE";
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

async function DocumentsBody() {
  const result = await listDocumentRegister();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Document register unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    documents,
    orphaned,
    stranded,
    breakdown,
    totalBytes,
    unreachableBytes,
    liveCount,
    deletedCount,
    unattributedCount,
    largest,
  } = result.data;

  return (
    <div className="space-y-6">
      {/* ── 1 · ORPHANED. The parent matches nothing at all. ───────── */}
      {orphaned.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {orphaned.length} file{orphaned.length === 1 ? " is" : "s are"}{" "}
              attached to a record that does not exist —{" "}
              {bytes(orphaned.reduce((a, d) => a + d.sizeBytes, 0))} still stored
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">
              {orphaned.slice(0, 12).map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{d.fileName}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {ENTITY_LABEL[d.entityType] ?? d.entityType}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    {d.entityId.slice(0, 8)}
                  </span>
                  <span className="tabular-nums text-xs">{bytes(d.sizeBytes)}</span>
                  <span className="text-xs text-muted-foreground">
                    uploaded {shortDate(d.createdAt)}
                    {d.uploadedByName ? ` by ${d.uploadedByName}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {orphaned.length > 12 && (
              <p className="text-xs text-muted-foreground">
                …and {orphaned.length - 12} more in the register below.
              </p>
            )}
            <p className="text-muted-foreground">
              ⚠️ The link between a file and the record it belongs to is
              polymorphic, so the database cannot enforce it — no foreign key,
              no cascade, no complaint. These rows name a parent that is not
              there. The bytes are still in the blob store, still billed for,
              and reachable from no screen in the product except this one.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · STRANDED. Parent exists, but soft-deleted. ─────────── */}
      {stranded.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {stranded.length} file{stranded.length === 1 ? "" : "s"} hang off a
              record that has been deleted
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {stranded.slice(0, 12).map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{d.fileName}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {ENTITY_LABEL[d.entityType] ?? d.entityType}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {d.entityLabel ?? "unnamed"} — deleted
                  </span>
                  <span className="tabular-nums text-xs">{bytes(d.sizeBytes)}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              The parent row survives a delete so the audit trail can still
              answer &ldquo;what was removed, by whom, when&rdquo;. Its
              attachments survive with it — and no screen in the product will
              show them again, because the screen that showed them was the
              record page. A signed agreement in this state is still on disk
              and still discoverable; it is simply no longer findable by anyone
              who needs it.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · The numbers. ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Files held
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{liveCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {bytes(totalBytes)} across every record type.
            </p>
          </CardContent>
        </Card>

        <Card
          className={
            unreachableBytes > 0 ? "border-red-300 dark:border-red-800" : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Stored but unreachable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {bytes(unreachableBytes)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {orphaned.length + stranded.length} file
              {orphaned.length + stranded.length === 1 ? "" : "s"} no record page
              can show.
            </p>
          </CardContent>
        </Card>

        {/* ⭐ A row with no uploader is a file nobody can be asked about. */}
        <Card
          className={
            unattributedCount > 0 ? "border-amber-300 dark:border-amber-800" : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              No uploader recorded
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {unattributedCount}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The uploader is cleared when a person is removed from the
              workspace — the file outlives the account.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Removed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{deletedCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Rows kept as evidence. The bytes themselves were destroyed at the
              moment of deletion.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 4 · Footprint and the biggest files. ──────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where the files hang</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {breakdown.map((b) => (
                  <tr key={b.entityType} className={b.count === 0 ? "opacity-50" : ""}>
                    <td className="px-4 py-2">
                      {ENTITY_LABEL[b.entityType] ?? b.entityType}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {b.count}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {bytes(b.bytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Largest files</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {largest.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                Nothing stored yet.
              </p>
            ) : (
              <ul className="divide-y">
                {largest.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-baseline gap-3 px-4 py-2 text-sm"
                  >
                    <span className="truncate font-medium">{d.fileName}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                      {bytes(d.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 5 · The register. ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>The register</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {documents.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No files stored yet.
              </p>
              <p className="mx-auto max-w-2xl text-xs text-muted-foreground">
                A document here is a file attached to a contract, an asset, a
                deal, a contact or a company — a signed agreement, a title
                deed, an acknowledgement, a scan. It is uploaded from the
                record it belongs to, not from this page. The bytes go to a
                private store and are served only through an endpoint that
                re-checks who is asking; this register is the inventory of what
                exists, how much of it there is, and whether anything still
                points at it.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">File</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Attached to</th>
                    <th className="px-4 py-2 text-right font-medium">Size</th>
                    <th className="px-4 py-2 font-medium">Uploaded</th>
                    <th className="px-4 py-2 font-medium">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {documents.slice(0, 300).map((d) => (
                    <tr
                      key={d.id}
                      className={
                        d.isOrphaned
                          ? "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20 dark:hover:bg-red-950/30"
                          : d.isStranded
                            ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20"
                            : d.isDeleted
                              ? "opacity-55"
                              : "hover:bg-muted/40"
                      }
                    >
                      <td className="px-4 py-2 font-medium">
                        {d.fileName}
                        {d.description && (
                          <div className="text-xs font-normal text-muted-foreground">
                            {d.description}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                        {fileKind(d.mimeType)}
                      </td>
                      {/* ⭐ The three states of a polymorphic link, never
                          collapsed into one tick: named, deleted, absent. */}
                      <td className="px-4 py-2 text-xs">
                        <Badge variant="outline" className="text-[10px]">
                          {ENTITY_LABEL[d.entityType] ?? d.entityType}
                        </Badge>{" "}
                        {d.isOrphaned ? (
                          <span className="font-medium text-red-700 dark:text-red-300">
                            record not found
                          </span>
                        ) : d.isStranded ? (
                          <span className="font-medium text-amber-700 dark:text-amber-300">
                            {d.entityLabel ?? "unnamed"} — deleted
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {d.entityLabel ?? "unnamed"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {bytes(d.sizeBytes)}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {shortDate(d.createdAt)}
                        {d.isDeleted && d.deletedAt && (
                          <div className="text-[10px]">
                            removed {shortDate(d.deletedAt)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {d.uploadedByName ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Metadata lives in the database, under row-level security; the bytes
        live in a private blob store and are streamed only through an endpoint
        that re-checks the session and the tenant first. Deleting a document
        destroys the object and keeps the row — the row is the evidence that
        the file existed and was removed, and the object is the confidential
        content somebody asked to be gone. The link from a file to its record
        is polymorphic and therefore unenforced by the database, which is why
        the two counts at the top of this page exist at all. This screen writes
        nothing.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function DocumentsPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
          <p className="text-sm text-muted-foreground">
            Every file the workspace holds — and the ones nothing points at any
            more.
          </p>
        </div>
        <Link
          href="/contracts"
          className="text-sm text-muted-foreground hover:underline"
        >
          Contracts
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <DocumentsBody />
      </Suspense>
    </div>
  );
}
