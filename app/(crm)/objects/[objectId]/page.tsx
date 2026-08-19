/**
 * Ordence — Designing An Existing Record Type
 * Version: v0.27.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY BUTTON ON THIS PAGE RUNS DDL AGAINST A REAL TABLE
 * ══════════════════════════════════════════════════════════════════════
 * Adding a field is `ALTER TABLE … ADD COLUMN`. Removing one is
 * `DROP COLUMN` plus every value in it. Deleting the record type is
 * `DROP TABLE`. The page is laid out so that the reversible things are
 * above the irreversible ones, and the irreversible ones say what they
 * destroy in numbers rather than in adjectives.
 *
 * The live record count is read here rather than inside the dialog so
 * that the number the person reads and the number they type back come
 * from the same query — and the database re-checks it at the moment of
 * the drop anyway, which is what makes a stale number an aborted drop
 * instead of a lost table.
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addDynamicField,
  archiveDynamicObject,
  dropDynamicObject,
  getDynamicObject,
  listDynamicObjects,
  removeDynamicField,
  renameDynamicObject,
  updateDynamicField,
} from "@/server/actions/dynamic-objects";
import { Button } from "@/components/ui/button";
import { ObjectDesigner } from "@/components/dynamic/object-designer";
import { DropObjectDialog } from "@/components/dynamic/drop-object-dialog";
import { liveRecordCount, relationTargets, toFieldRows, toObjectSummary } from "../mapping";
import { Refusal } from "../refusal";

export const dynamic = "force-dynamic";

export default async function ObjectDesignerPage({
  params,
}: {
  params: Promise<{ objectId: string }>;
}) {
  const { objectId } = await params;

  return (
    <div className="p-6">
      <Suspense fallback={<Skeleton />}>
        <DesignerView objectId={objectId} />
      </Suspense>
    </div>
  );
}

async function DesignerView({ objectId }: { objectId: string }) {
  const [definition, siblings] = await Promise.all([
    getDynamicObject({ objectId }),
    listDynamicObjects(),
  ]);

  if (!definition.ok) {
    // ⚠️ "does not exist" is a 404, everything else is a refusal with the
    // server's own sentence. Collapsing the two would turn "ask your
    // administrator for `custom_objects:read`" into a blank page.
    if (/does not exist/i.test(definition.error)) notFound();
    return <Refusal message={definition.error} />;
  }

  const object = definition.data;
  const fields = toFieldRows(object.fields as Parameters<typeof toFieldRows>[0]);
  const recordCount = await liveRecordCount(object.id);
  const summary = toObjectSummary(
    object as Parameters<typeof toObjectSummary>[0],
    recordCount,
  );

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/objects" className="hover:underline">
              Record types
            </Link>{" "}
            / {object.label}
          </p>
          <h1 className="mt-1 text-2xl font-bold">{object.pluralLabel}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <code className="font-mono">{object.apiName}</code> ·{" "}
            {fields.length} field{fields.length === 1 ? "" : "s"} ·{" "}
            {recordCount === null
              ? "record count unavailable"
              : `${recordCount.toLocaleString("en-IN")} live record${recordCount === 1 ? "" : "s"}`}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/objects/${object.id}/records`}>View records</Link>
        </Button>
      </div>

      <ObjectDesigner
        object={summary}
        fields={fields}
        objectCount={siblings.ok ? siblings.data.rows.length : 0}
        relationTargets={
          siblings.ok ? relationTargets(siblings.data.rows, object.id) : []
        }
        actions={{
          onRename: renameDynamicObject,
          onAddField: addDynamicField,
          onUpdateField: updateDynamicField,
          onRemoveField: removeDynamicField,
        }}
      />

      {/* ================= The end of the page, deliberately ================= */}
      <section className="mt-6 rounded-lg border border-destructive/30 p-4">
        <h2 className="text-sm font-semibold text-destructive">Destroying this record type</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Archiving hides it and keeps everything. Deleting drops the table{" "}
          <code className="font-mono">{object.physicalTableName}</code> and every record
          in it, permanently, and asks you to type both the api name and the exact number
          of records being destroyed — because the database checks both.
        </p>
        <div className="mt-3">
          <DropObjectDialog
            objectId={object.id}
            apiName={object.apiName}
            label={object.label}
            physicalTableName={object.physicalTableName}
            recordCount={recordCount}
            onDrop={dropDynamicObject}
            onArchive={archiveDynamicObject}
          />
        </div>
      </section>
    </>
  );
}

function Skeleton() {
  return <div className="h-96 animate-pulse rounded-lg border border-border bg-muted/30" />;
}
