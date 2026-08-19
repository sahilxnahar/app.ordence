/**
 * Ordence — Create One Custom Record
 * Version: v0.27.0-alpha
 * Runtime: Node
 *
 * The form is generated from the field definitions. There is no per-object
 * component, no code generation and no build step — which is the claim the
 * whole engine rests on, and this page is where a customer sees it.
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  createDynamicRecord,
  getDynamicObject,
} from "@/server/actions/dynamic-objects";
import { RecordForm } from "@/components/dynamic/record-form";
import { relationChoices, toFieldRows } from "../../../mapping";
import { Refusal } from "../../../refusal";

export const dynamic = "force-dynamic";

export default async function NewRecordPage({
  params,
}: {
  params: Promise<{ objectId: string }>;
}) {
  const { objectId } = await params;

  return (
    <div className="p-6">
      <Suspense fallback={<Skeleton />}>
        <FormView objectId={objectId} />
      </Suspense>
    </div>
  );
}

async function FormView({ objectId }: { objectId: string }) {
  const definition = await getDynamicObject({ objectId });
  if (!definition.ok) {
    if (/does not exist/i.test(definition.error)) notFound();
    return <Refusal message={definition.error} />;
  }

  const object = definition.data;
  const fields = toFieldRows(object.fields as Parameters<typeof toFieldRows>[0]);
  const choices = await relationChoices(fields);

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
          / New
        </p>
        <h1 className="mt-1 text-2xl font-bold">New {object.label.toLowerCase()}</h1>
      </div>

      <div className="max-w-2xl">
        <RecordForm
          objectId={object.id}
          objectLabel={object.label.toLowerCase()}
          fields={fields}
          record={null}
          relationChoices={choices}
          onSubmit={createDynamicRecord}
          redirectTo={`/objects/${object.id}/records`}
          cancelHref={`/objects/${object.id}/records`}
        />
      </div>
    </>
  );
}

function Skeleton() {
  return <div className="h-96 animate-pulse rounded-lg border border-border bg-muted/30" />;
}
