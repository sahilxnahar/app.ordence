/**
 * Ordence — ⭐⭐⭐ ONE DRAWING: ITS REVISIONS, ITS COMMENTS, ITS QUANTITIES
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE THREE PANELS, IN THE ORDER SOMEBODY USES THEM
 * ══════════════════════════════════════════════════════════════════════
 *   ① the revisions, newest first, with what each superseded
 *   ② the unit — because nothing below it works until this is settled
 *   ③ the comments and the quantities taken off the current sheet
 *
 * ⚠️ ② IS NOT A SETTING BURIED IN A MENU. It is the second thing on the
 * page, because a drawing whose units nobody has stated is a drawing
 * nothing can be measured off, and hiding that turns a blocked workflow
 * into a support ticket.
 */

import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Badge } from "@/components/ui/badge";
import { getDrawingDetail } from "@/server/actions/drawings";
import { DrawingUnitPanel } from "./unit-panel";
import { MarkupList } from "./markup-list";
import { RevisionIntake } from "./revision-intake";
import { RevisionViewer } from "./revision-viewer";

export const dynamic = "force-dynamic";

async function Detail({ drawingId }: { drawingId: string }) {
  const result = await getDrawingDetail({ drawingId });
  if (!result.ok) return <p className="text-sm text-destructive">{result.error}</p>;

  const { revisions, markups, measurements } = result.data;
  const current = revisions[0];

  if (!current) {
    return (
      <p className="text-sm text-muted-foreground">
        This drawing has no file against it yet. A drawing in the register with no revision is a
        placeholder — useful when the number is known before the sheet arrives, and not something
        anybody can build from.
      </p>
    );
  }

  const declared = current.declaredUnit && current.declaredUnit !== "unitless";
  const unit = declared ? current.declaredUnit : current.assumedUnit;
  const unsupported = Object.entries(current.unsupported);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Issue a revision"
        description="Supersedes the one before it. The file is stored exactly as it arrived."
      >
        <RevisionIntake drawingId={drawingId} />
      </SectionCard>

      <SectionCard title="Revisions" description="Newest first. A superseded revision is frozen.">
        <ul className="space-y-2">
          {revisions.map((revision, index) => (
            <li
              key={revision.id}
              className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
            >
              <span className="font-medium">Rev {revision.revision}</span>
              {index === 0 ? <Badge>current</Badge> : null}
              {revision.supersededAt ? (
                <span className="text-xs text-muted-foreground">
                  superseded {revision.supersededAt.toISOString().slice(0, 10)}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {revision.entityCount.toLocaleString("en-IN")} entities ·{" "}
                {revision.layerCount} layers · {revision.sourceFormat.toUpperCase()}
              </span>
              <span className="text-xs text-muted-foreground">
                received {revision.receivedAt.toISOString().slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      </SectionCard>

      {/* ── ② THE UNIT ──────────────────────────────────────────────── */}
      <SectionCard
        title="What one drawing unit means"
        description="Everything measurable about this sheet depends on this, so it is recorded with a name and a time on it."
      >
        {declared ? (
          <p className="text-sm text-muted-foreground">
            The file states it: one drawing unit is one{" "}
            <strong className="text-foreground">
              {String(current.declaredUnit).replace(/s$/, "")}
            </strong>
            . Nothing to decide.
          </p>
        ) : (
          <DrawingUnitPanel
            revisionId={current.id}
            assumedUnit={current.assumedUnit}
            frozen={current.supersededAt !== null}
          />
        )}
      </SectionCard>

      {/* ── THE SHEET ITSELF ────────────────────────────────────────── */}
      <SectionCard
        title="The drawing"
        description="Parsed and drawn in your browser. Layers can be switched off; the ones the file itself switched off stay off."
      >
        <RevisionViewer revisionId={current.id} unit={unit ?? null} assumed={!declared} />
      </SectionCard>

      {/* ── ③ COMMENTS AND QUANTITIES ───────────────────────────────── */}
      <SectionCard
        title="Comments on this revision"
        description="Stored beside the drawing, never in it. The original file goes back to the consultant exactly as it arrived."
      >
        <MarkupList markups={markups} />
      </SectionCard>

      <SectionCard
        title="Quantities taken off this revision"
        description="Every one cites the revision, the unit basis and whether that basis was somebody's assumption."
      >
        {measurements.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has been measured off this sheet yet.
            {!unit
              ? " Nothing can be, until somebody says what one drawing unit means."
              : ""}
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {measurements.map((m) => (
              <li key={m.id} className="rounded-md border p-3">
                <span className="font-medium">{m.label}</span>{" "}
                <span className="tabular-nums">
                  {m.kind === "count" ? m.valueSi : m.valueSi.toFixed(3)}{" "}
                  {m.kind === "area" ? "m²" : m.kind === "length" ? "m" : ""}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {m.isExact || m.maxErrorSi === 0
                    ? "exact"
                    : `±${m.maxErrorSi.toFixed(4)} from curve flattening`}
                  {" · "}
                  1 unit = 1 {m.unitBasis.replace(/s$/, "")}
                  {m.unitWasAssumed ? ", assumed" : ", as the file states"}
                  {m.layer ? ` · layer ${m.layer}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {unsupported.length > 0 ? (
        <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            {/*
              🔴 ON THE SHEET'S OWN PAGE, not only in the viewer. Somebody
              reading the quantity list has to know what was not drawn.
            */}
            This revision contains{" "}
            {unsupported.map(([type, count]) => `${count} ${type}`).join(", ")} that Ordence does
            not read. Nothing derived from it accounts for{" "}
            {unsupported.length === 1 ? "them" : "those"}.
          </span>
        </p>
      ) : null}
    </div>
  );
}

export default async function DrawingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="space-y-6">
      <Link
        href="/drawings"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-2"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to the register
      </Link>

      <PageHeader title="Drawing" description="Revisions, comments and quantities." />

      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Detail drawingId={id} />
      </Suspense>
    </div>
  );
}
