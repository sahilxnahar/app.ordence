/**
 * Ordence — Edit One Custom Record
 * Version: v0.27.0-alpha
 * Runtime: Node
 *
 * ⚠️ `updateDynamicRecord` IS A PATCH. An absent key means "leave it
 * alone", which is why the form sends `null` for a box somebody emptied
 * rather than omitting it — omitting it would make clearing a value
 * impossible, silently.
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getDynamicObject,
  getDynamicRecord,
  updateDynamicRecord,
} from "@/server/actions/dynamic-objects";
import { RecordForm } from "@/components/dynamic/record-form";
import { recordTitle } from "@/components/dynamic/presentation";
import { relationChoices, toFieldRows } from "../../../../mapping";
import { Refusal } from "../../../../refusal";

export const dynamic = "force-dynamic";

export default async function EditRecordPage({
  params,
}: {
  params: Promise<{ objectId: string; recordId: string }>;
}) {
  const { objectId, recordId } = await params;

  return (
    <div className="p-6">
      <Suspense fallback={<Skeleton />}>
        <EditView objectId={objectId} recordId={recordId} />
      </Suspense>
    </div>
  );
}

async function EditView({ objectId, recordId }: { objectId: string; recordId: string }) {
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
  const choices = await relationChoices(fields);
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
          /{" "}
          <Link
            href={`/objects/${object.id}/records/${recordId}`}
            className="hover:underline"
          >
            {title}
          </Link>{" "}
          / Edit
        </p>
        <h1 className="mt-1 text-2xl font-bold">Edit {title}</h1>
      </div>

      <div className="max-w-2xl">
        <RecordForm
          objectId={object.id}
          objectLabel={object.label.toLowerCase()}
          fields={fields}
          record={record.data}
          relationChoices={choices}
          onSubmit={updateDynamicRecord}
          redirectTo={`/objects/${object.id}/records/${recordId}`}
          cancelHref={`/objects/${object.id}/records/${recordId}`}
        />
      </div>
    </>
  );
}

function Skeleton() {
  return <div className="h-96 animate-pulse rounded-lg border border-border bg-muted/30" />;
}
