/**
 * Ordence — ⭐⭐⭐ THE DRAWING REGISTER
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS PAGE REPLACES
 * ══════════════════════════════════════════════════════════════════════
 * A folder on a shared drive containing `GF_PLAN_final_final2.dwg`.
 *
 * This product already had `boqs`, `boq_items`, `rate_analyses`,
 * `measurement_books`, `measurement_entries` and RA bills — the complete
 * construction billing chain — and NOTHING ANYWHERE THAT HELD A DRAWING.
 * Every quantity in that chain was typed in by somebody reading a printed
 * sheet, and the answer to "where did this 412 square metres come from"
 * was a person's memory.
 *
 * ⚠️ AND `documents` WAS NOT AN ANSWER. It holds a file against an
 * entity, which is right for a signed contract and wrong for a drawing: a
 * drawing has a NUMBER, a REVISION, a SCALE, and a rule that revision C
 * supersedes B.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TWO COLUMNS THIS REGISTER EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * "Which revision is current" and "can anything be measured off it yet".
 * Everything else is context.
 */

import { Suspense } from "react";
import Link from "next/link";
import { Ruler, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDrawings } from "@/server/actions/drawings";
import { DrawingIntake } from "./drawing-intake";

export const dynamic = "force-dynamic";

async function Register() {
  const result = await getDrawings();
  if (!result.ok) return <p className="text-sm text-destructive">{result.error}</p>;

  if (result.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No drawings yet. This is an empty register, not a missing one.
      </p>
    );
  }

  const unmeasurable = result.data.filter((d) => d.currentRevisionId && !d.unitKnown).length;

  return (
    <div className="space-y-3">
      {unmeasurable > 0 ? (
        <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            {/*
              🔴 THE NUMBER THAT MATTERS ON THIS SCREEN. A register full of
              drawings nobody can take a quantity off is a register that
              looks complete and is not.
            */}
            {unmeasurable} drawing{unmeasurable === 1 ? "" : "s"} cannot be measured yet, because
            the file does not say what one drawing unit means and nobody has said. Open{" "}
            {unmeasurable === 1 ? "it" : "them"} and set the unit before anybody takes a quantity
            off {unmeasurable === 1 ? "it" : "them"}.
          </span>
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Discipline</TableHead>
              <TableHead>Current revision</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Open comments</TableHead>
              <TableHead>Measurable</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.map((drawing) => (
              <TableRow key={drawing.id}>
                <TableCell className="whitespace-nowrap font-medium">
                  <Link
                    href={`/drawings/${drawing.id}`}
                    className="underline underline-offset-2"
                  >
                    {drawing.drawingNumber}
                  </Link>
                </TableCell>
                <TableCell className="text-sm">{drawing.title}</TableCell>
                <TableCell className="text-xs capitalize">{drawing.discipline}</TableCell>
                <TableCell className="text-xs">
                  {drawing.currentRevision ? (
                    <>
                      Rev {drawing.currentRevision}
                      <span className="ml-1 text-muted-foreground">
                        of {drawing.revisionCount}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">no file yet</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {drawing.status === "good_for_construction" ? (
                    <Badge>Good for construction</Badge>
                  ) : (
                    <span className="capitalize text-muted-foreground">
                      {drawing.status.replace(/_/g, " ")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {drawing.openMarkups > 0 ? (
                    <Badge variant="secondary">{drawing.openMarkups}</Badge>
                  ) : (
                    <span className="text-muted-foreground">none</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {!drawing.currentRevisionId ? (
                    <span className="text-muted-foreground">—</span>
                  ) : drawing.unitKnown ? (
                    <span className="text-muted-foreground">yes</span>
                  ) : (
                    <Badge variant="destructive">unit not set</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default function DrawingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Drawings"
        description="The register: which sheet is current, what it supersedes, and what can be measured off it."
      />

      <SectionCard
        title="The register"
        description="A drawing number is unique per project, ignoring case and spaces, because two sheets sharing a number is how a site builds to the wrong one."
      >
        <Suspense
          fallback={
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Ruler className="h-4 w-4" aria-hidden="true" />
              Loading the register…
            </p>
          }
        >
          <Register />
        </Suspense>
      </SectionCard>

      <SectionCard
        title="Add a drawing"
        description="DXF is read directly — every layer, every arc, every block. A DWG is refused with the two-click export that produces one."
      >
        <DrawingIntake />
      </SectionCard>
    </div>
  );
}
