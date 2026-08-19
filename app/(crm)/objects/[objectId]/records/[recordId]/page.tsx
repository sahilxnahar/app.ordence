/**
 * Ordence — One Custom Record
 * Version: v0.27.0-alpha
 * Runtime: Node
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  deleteDynamicRecord,
  getDynamicObject,
  getDynamicRecord,
} from "@/server/actions/dynamic-objects";
import { RecordDetail } from "@/components/dynamic/record-detail";
import { recordTitle } from "@/components/dynamic/presentation";
import { relationChoices, toFieldRows } from "../../../mapping";
import { Refusal } from "../../../refusal";

export const dynamic = "force-dynamic";

export default async function RecordPage({
  params,
}: {
  params: Promise<{ objectId: string; recordId: string }>;
}) {
  const { objectId, recordId } = await params;

  return (
    <div className="p-6">
      <Suspense fallback={<Skeleton />}>
        <DetailView objectId={objectId} recordId={recordId} />
      </Suspense>
    </div>
  );
}

async function DetailView({
  objectId,
  recordId,
}: {
  objectId: string;
  recordId: string;
}) {
  const [definition, record] = await Promise.all([
    getDynamicObject({ objectId }),
    getDynamicRecord({ objectId, recordId }),
  ]);

  if (!definition.ok) {
    if (/does not exist/i.test(definition.error)) notFound();
    return <Refusal message={definition.error} />;
  }
  if (!record.ok) {
    if (/does not exist/i.test(record.error)) notFound();
    return <Refusal message={record.error} />;
  }

  const object = definition.data;
  const fields = toFieldRows(object.fields as Parameters<typeof toFieldRows>[0]);

  /*
   * The linked records' own titles, so a relation reads as a name rather
   * than as a uuid. Resolved from the same helper the form uses, so the
   * label in the picker and the label on the detail page agree.
   */
  const choices = await relationChoices(fields);
  const relationLabels: Record<string, string> = {};
  for (const field of fields) {
    if (field.fieldType !== "relation") continue;
    const value = record.data[field.apiName];
    if (!value) continue;
    const match = (choices[field.apiName] ?? []).find((c) => c.id === String(value));
    if (match) relationLabels[field.apiName] = match.label;
  }

  const title = recordTitle(fields, object.displayFieldApiName, record.data);

  return (
    <>
      <div className="mb-5">
        <p className="text-xs text-muted-foreground">
          <Link href="/objects" className="hover:underline">
            Record types
          </Link>{" "}
          /{" "}
          <Link href={`/objects/${object.id}/records`} className="hover:underline">
            {object.pluralLabel}
          </Link>{" "}
          / {title}
        </p>
        <h1 className="mt-1 text-2xl font-bold">{title}</h1>
      </div>

      <div className="max-w-3xl">
        <RecordDetail
          objectId={object.id}
          fields={fields}
          record={record.data}
          relationLabels={relationLabels}
          onDelete={deleteDynamicRecord}
        />
      </div>
    </>
  );
}

function Skeleton() {
  return <div className="h-96 animate-pulse rounded-lg border border-border bg-muted/30" />;
}
