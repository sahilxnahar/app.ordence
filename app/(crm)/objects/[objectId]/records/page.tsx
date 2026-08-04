/**
 * Ordence — Records Of Any Custom Record Type
 * Version: v0.27.0-alpha
 * Runtime: Node
 *
 * One route that lists every tenant-defined record type. The columns, the
 * sort options and the search target all come from the field list; nothing
 * in this file knows what any of them mean.
 *
 * ⚠️ SEARCH, SORT AND PAGE ARE URL PARAMETERS AND ARE APPLIED IN SQL.
 * `listDynamicRecords` does all three server-side. Doing any of them in
 * the browser would produce a search box that finds nothing on record
 * fifty-one, which people report as "search is broken" and are right to.
 *
 * ⚠️ `sortBy` LOOKS LIKE A FILTER AND IS AN IDENTIFIER POSITION. It is
 * passed straight through, because the engine resolves it against the
 * object's actual field list and refuses anything not on it — a stronger
 * guarantee than any check this page could make, and the reason not to
 * make a weaker one here that reads like the real one.
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getDynamicObject,
  listDynamicRecords,
} from "@/server/actions/dynamic-objects";
import { Button } from "@/components/ui/button";
import { RecordTable } from "@/components/dynamic/record-table";
import { DEFAULT_PAGE_SIZE } from "@/lib/dynamic/limits";
import { toFieldRows } from "../../mapping";
import { Refusal } from "../../refusal";

export const dynamic = "force-dynamic";

type Search = { q?: string; sort?: string; dir?: string; page?: string };

export default async function RecordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ objectId: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ objectId }, query] = await Promise.all([params, searchParams]);

  return (
    <div className="p-6">
      <Suspense fallback={<Skeleton />}>
        <RecordsView objectId={objectId} query={query} />
      </Suspense>
    </div>
  );
}

async function RecordsView({ objectId, query }: { objectId: string; query: Search }) {
  const definition = await getDynamicObject({ objectId });
  if (!definition.ok) {
    if (/does not exist/i.test(definition.error)) notFound();
    return <Refusal message={definition.error} />;
  }

  const object = definition.data;
  const fields = toFieldRows(object.fields as Parameters<typeof toFieldRows>[0]);

  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const sortDir = query.dir === "asc" ? "asc" : "desc";
  const search = (query.q ?? "").trim();
  // Only a name that is actually a field is sent. An unknown one would be
  // refused by the engine with a sentence about a field this record type
  // does not have, which is accurate and useless to somebody who edited a
  // URL by hand.
  const sortBy =
    query.sort && fields.some((f) => f.apiName === query.sort) ? query.sort : null;

  const records = await listDynamicRecords({
    objectId,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(sortBy ? { sortBy } : {}),
    sortDir,
  });

  if (!records.ok) return <Refusal message={records.error} />;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/objects" className="hover:underline">
              Record types
            </Link>{" "}
            / {object.pluralLabel}
          </p>
          <h1 className="mt-1 text-2xl font-bold">{object.pluralLabel}</h1>
          {object.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{object.description}</p>
          ) : null}
        </div>
        <Button asChild variant="outline">
          <Link href={`/objects/${object.id}`}>Design this record type</Link>
        </Button>
      </div>

      <RecordTable
        objectId={object.id}
        pluralLabel={object.pluralLabel}
        singularLabel={object.label}
        displayFieldApiName={object.displayFieldApiName}
        fields={fields}
        rows={records.data.rows}
        total={records.data.total}
        page={records.data.page}
        pageSize={records.data.pageSize}
        search={search}
        sortBy={sortBy}
        sortDir={sortDir}
      />
    </>
  );
}

function Skeleton() {
  return <div className="h-96 animate-pulse rounded-lg border border-border bg-muted/30" />;
}
