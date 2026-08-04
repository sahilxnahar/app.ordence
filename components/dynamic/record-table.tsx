"use client";

/**
 * Ordence — A List Of Any Custom Record Type
 * Version: v0.27.0-alpha
 *
 * One table that renders every tenant-defined record type, whatever shape
 * it happens to have. The columns come from the field list; nothing here
 * knows what a "site visit" is.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ SEARCH, SORT AND PAGING HAPPEN ON THE SERVER, AND SAY SO
 * ══════════════════════════════════════════════════════════════════════
 * `listDynamicRecords` takes `search`, `sortBy`, `sortDir`, `page` and
 * `pageSize`, and applies all of them in SQL. Filtering the page's fifty
 * rows in the browser instead would produce a search box that finds
 * nothing on record fifty-one — the classic defect, and the one people
 * report as "search is broken" rather than "search is paginated".
 *
 * So every control below is a round trip, driven through the URL. The URL
 * is also what makes a filtered list something somebody can send to a
 * colleague.
 *
 * ⚠️ AND THE SEARCH BOX SAYS WHAT IT SEARCHES. The engine searches the
 * DISPLAY FIELD only — searching every text column of an arbitrary table
 * is N ILIKEs per row on a table whose shape we do not control, which is
 * fine on fifty rows and takes an instance down on four hundred thousand.
 * A search box that quietly looks at one column is a search box people
 * think is broken.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE SAVED-VIEW BAR IS NOT MOUNTED HERE
 * ══════════════════════════════════════════════════════════════════════
 * `components/views/saved-view-bar.tsx` fits a list whose rows come from
 * `runSavedView` — a different pipeline, with its own filter compiler,
 * column resolver and permission gates. These rows come from the Phase 24
 * engine's own generic reader. Mounting the bar over rows it did not
 * produce would give a view picker that changes the badge and not the
 * data, which is worse than not offering one. Wiring the two together is
 * real work and is called out as not done rather than half done.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  formatFieldValue,
  gridFields,
  recordTitle,
  type ObjectFieldRow,
} from "./presentation";

export type RecordTableProps = {
  objectId: string;
  pluralLabel: string;
  singularLabel: string;
  displayFieldApiName: string | null;
  fields: readonly ObjectFieldRow[];
  rows: readonly Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
  sortBy: string | null;
  sortDir: "asc" | "desc";
};

export function RecordTable({
  objectId,
  pluralLabel,
  singularLabel,
  displayFieldApiName,
  fields,
  rows,
  total,
  page,
  pageSize,
  search,
  sortBy,
  sortDir,
}: RecordTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(search);

  const columns = gridFields(fields);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const go = (patch: Record<string, string | number | null>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | number | null> = {
      q: search || null,
      sort: sortBy,
      dir: sortDir,
      page,
      ...patch,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value === null || value === "" || value === undefined) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const displayField = fields.find((f) => f.apiName === displayFieldApiName);

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------- Controls ---------------- */}
      <div className="flex flex-wrap items-end gap-2">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            go({ q: query.trim() || null, page: 1 });
          }}
        >
          <div>
            <label htmlFor="record-search" className="mb-1 block text-xs font-medium">
              Search
            </label>
            <Input
              id="record-search"
              value={query}
              className="h-9 w-64"
              aria-describedby="record-search-help"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={displayField ? displayField.label : "Search"}
            />
          </div>
          <Button type="submit" variant="outline" className="h-9">
            <Search className="h-4 w-4" aria-hidden="true" />
            Search
          </Button>
        </form>

        <div>
          <label htmlFor="record-sort" className="mb-1 block text-xs font-medium">
            Sort by
          </label>
          <select
            id="record-sort"
            value={sortBy ?? ""}
            onChange={(event) => go({ sort: event.target.value || null, page: 1 })}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Newest first (created)</option>
            {fields.map((field) => (
              <option key={field.id} value={field.apiName}>
                {field.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="record-dir" className="mb-1 block text-xs font-medium">
            Direction
          </label>
          <select
            id="record-dir"
            value={sortDir}
            onChange={(event) => go({ dir: event.target.value, page: 1 })}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </div>

        <div className="ml-auto">
          <Button asChild>
            <Link href={`/objects/${objectId}/records/new`}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New {singularLabel.toLowerCase()}
            </Link>
          </Button>
        </div>
      </div>

      <p id="record-search-help" className="text-[11px] text-muted-foreground">
        {displayField ? (
          <>
            Search looks at <strong className="font-medium">{displayField.label}</strong>{" "}
            only — the field that identifies a record. Searching every column of a table
            this size is a sequential scan, so it is not offered rather than offered
            slowly.
          </>
        ) : (
          <>
            This record type has no display field, so there is nothing to search on.
          </>
        )}
      </p>

      {/* ---------------- Table ---------------- */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {rows.length} of {total} {pluralLabel.toLowerCase()}, page {page} of{" "}
            {lastPage}
          </caption>
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {displayField ? displayField.label : "Record"}
              </th>
              {columns
                .filter((f) => f.apiName !== displayFieldApiName)
                .map((field) => (
                  <th key={field.id} scope="col" className="px-3 py-2 font-medium">
                    {field.label}
                  </th>
                ))}
              <th scope="col" className="px-3 py-2 font-medium">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)} className="border-t border-border">
                <td className="px-3 py-2">
                  <Link
                    href={`/objects/${objectId}/records/${String(row.id)}`}
                    className="font-medium hover:underline"
                  >
                    {recordTitle(fields, displayFieldApiName, row)}
                  </Link>
                </td>
                {columns
                  .filter((f) => f.apiName !== displayFieldApiName)
                  .map((field) => (
                    <td key={field.id} className="px-3 py-2 text-xs">
                      {formatFieldValue(field, row[field.apiName])}
                    </td>
                  ))}
                <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                  {String(row.created_at ?? "").slice(0, 10) || "—"}
                </td>
              </tr>
            ))}

            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 2}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  {search
                    ? `Nothing matches "${search}".`
                    : `No ${pluralLabel.toLowerCase()} yet.`}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* ---------------- Paging ---------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Showing {rows.length.toLocaleString("en-IN")} of{" "}
          {total.toLocaleString("en-IN")} {pluralLabel.toLowerCase()}. Page {page} of{" "}
          {lastPage}.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => go({ page: page - 1 })}
          >
            Previous page
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => go({ page: page + 1 })}
          >
            Next page
          </Button>
        </div>
      </div>
    </div>
  );
}
