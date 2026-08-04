/**
 * Ordence — SETTINGS · CUSTOM OBJECTS (THE DEFINITIONS)
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT `/objects`, AND THE DIFFERENCE IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════
 * `/objects` is the RECORDS view: it lists runtime record types and the
 * rows inside them, and it is where somebody goes to look at data. It is
 * on the main navigation because it is used daily.
 *
 * This page answers a different question, asked by a different person on
 * a different day: what SHAPES has this workspace defined, on which of
 * the two engines, and which of those definitions are quietly not doing
 * what whoever wrote them believes they do.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THERE ARE TWO ENGINES, AND ONLY ONE OF THEM KEEPS ITS PROMISES
 * ══════════════════════════════════════════════════════════════════════
 * JSONB (Phase 2, `custom_object_definitions`) — every record of every
 *   type is a row in one shared table with a `data` JSONB column. Zero
 *   migrations, one set of RLS policies, and NO per-field constraints of
 *   any kind. There is no NOT NULL, no UNIQUE and no FOREIGN KEY, because
 *   there is no column to hang one on.
 *
 * RUNTIME (Phase 24, `dynamic_objects`) — a real `CREATE TABLE` with
 *   typed columns, real indexes, real foreign keys, and RLS attached in
 *   the same transaction as the create.
 *
 * ⚠️ SO THE PAGE LEADS WITH `is_unique` ON THE JSONB ENGINE. That flag is
 * written by the designer, stored on the field, echoed back by every read
 * — and enforced by absolutely nothing. Not by the database, which has no
 * column to index, and not by `validateRecordData()`, which does not look
 * at it. A workspace that ticked "unique" on an employee code has been
 * accepting duplicates ever since, with a settings screen telling them
 * otherwise. Nothing errors, nothing warns, and it surfaces when two rows
 * appear in a report and somebody has to decide which one is real.
 *
 * That is the most expensive sentence this page can say, so it says it
 * first and it says which fields.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getCustomObjectSettings } from "@/server/actions/custom-objects";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Custom objects · Ordence" };

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

async function ObjectSettingsBody() {
  const result = await getCustomObjectSettings();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Definitions unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { legacy, runtime, unenforcedUniqueCount, legacyRecordCount } = result.data;

  const withUnenforced = legacy.filter((o) => o.unenforcedUniqueFields.length > 0);
  const untitled = legacy.filter((o) => o.displayFieldMissing && o.recordCount > 0);
  const hiddenWithData = legacy.filter((o) => !o.isActive && o.recordCount > 0);
  const liveRuntime = runtime.filter((o) => !o.archivedAt);
  const archivedRuntime = runtime.filter((o) => o.archivedAt);

  if (legacy.length === 0 && runtime.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>This workspace has not defined any record types</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            A custom object is a record type this workspace invents for itself
            — &quot;Site&quot;, &quot;Rig&quot;, &quot;Batch&quot;,
            &quot;Inspection&quot; — with its own fields, its own list view and
            its own records, without anybody writing a migration.
          </p>
          <p>
            This page is where the SHAPES are inspected: which types exist,
            which fields they carry, which engine holds them and whether the
            rules on those fields are actually enforced. The records
            themselves live at{" "}
            <Link href="/objects" className="underline">
              /objects
            </Link>
            .
          </p>
          <p>
            New types are created on the runtime engine, which issues a real
            table with typed columns, real indexes and row-level security
            attached in the same transaction. Start there:{" "}
            <Link href="/objects/new" className="underline">
              define a record type
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── 1 · THE PROMISE NOBODY KEEPS. ──────────────────────────── */}
      {withUnenforced.length > 0 && (
        <Card className="border-red-400 dark:border-red-800">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {unenforcedUniqueCount} field
              {unenforcedUniqueCount === 1 ? " is" : "s are"} marked unique and
              nothing enforces it
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">
              {withUnenforced.map((o) => (
                <li key={o.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{o.pluralName}</span>
                  <span className="text-xs text-muted-foreground">
                    {o.unenforcedUniqueFields.join(", ")}
                  </span>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {o.recordCount} record{o.recordCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              ⚠️ These fields live in a shared JSONB column, so there is no
              column for a unique index to sit on — and the record validator
              does not check the flag either. Duplicates have been accepted
              since the day the field was created, silently, and the only way
              to find them is to look. The runtime engine enforces uniqueness
              with a real index on a real column, which is why moving the type
              across is a fix rather than a preference.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · RECORDS WITH NOTHING TO CALL THEM. ─────────────────── */}
      {untitled.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {untitled.length} object
              {untitled.length === 1 ? " has" : "s have"} no usable display
              field
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {untitled.map((o) => (
                <li key={o.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{o.pluralName}</span>
                  <span className="text-xs text-muted-foreground">
                    {o.displayFieldName
                      ? `points at "${o.displayFieldName}", which no longer exists`
                      : "no display field set"}
                  </span>
                  <span className="tabular-nums text-xs">
                    {o.recordCount} record{o.recordCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              The display field is the value that represents a record in every
              list, picker and search result. When it names a field that has
              been removed, the denormalised copy stops being maintained and
              records appear as blank rows — present, countable, and impossible
              to tell apart.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · SWITCHED OFF, STILL FULL. ─────────────────────────── */}
      {hiddenWithData.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader>
            <CardTitle className="text-base">
              {hiddenWithData.length} inactive object
              {hiddenWithData.length === 1 ? "" : "s"} still hold data
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {hiddenWithData.map((o) => (
                <li key={o.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{o.pluralName}</span>
                  <span className="tabular-nums text-xs">
                    {o.recordCount} record{o.recordCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Deactivating an object hides it from navigation and removes
              nothing. The records are still there, still counted against
              storage, and still subject to whatever retention obligation
              covers them — which is a data-protection question rather than a
              tidiness one.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 4 · THE RUNTIME ENGINE. ───────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>
            Record types with real tables
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              runtime engine
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-4">
          {runtime.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been defined on the runtime engine yet. A type
              created here gets a physical table with typed columns, real
              indexes, real foreign keys and row-level security attached in the
              same transaction as the create — so a numeric field sorts as a
              number and a required field is required by the database rather
              than by whichever code path happened to run.{" "}
              <Link href="/objects/new" className="underline">
                Define one
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">Type</th>
                    <th className="px-2 py-2 font-medium">API name</th>
                    <th className="px-2 py-2 text-right font-medium">Fields</th>
                    <th className="px-2 py-2 text-right font-medium">
                      Enforced unique
                    </th>
                    <th className="px-2 py-2 font-medium">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[...liveRuntime, ...archivedRuntime].map((o) => (
                    <tr key={o.id} className={o.archivedAt ? "opacity-60" : ""}>
                      <td className="px-2 py-2">
                        <Link href={`/objects/${o.id}`} className="font-medium underline">
                          {o.pluralLabel}
                        </Link>
                      </td>
                      <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                        {o.apiName}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {o.fieldCount}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {o.uniqueFields}
                      </td>
                      <td className="px-2 py-2">
                        {o.archivedAt ? (
                          <Badge variant="outline" className="text-[10px]">
                            archived {day(o.archivedAt)}
                          </Badge>
                        ) : o.isActive ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-300 text-[10px] text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                          >
                            live
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            hidden
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {archivedRuntime.length > 0 && (
            <p className="text-xs text-muted-foreground">
              ⚠️ An archived type still OWNS ITS TABLE and every row in it.
              Archiving hides it; only an explicit drop — which makes the
              caller state the live record count being destroyed — removes the
              data. That is deliberate: a metadata row deleted without the
              table behind it would leave personal data nothing in this product
              can enumerate, which is unanswerable when somebody asks for a
              copy of everything held about them.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 5 · THE JSONB ENGINE. ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>
            Record types stored as JSONB
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              original engine · {legacyRecordCount} record
              {legacyRecordCount === 1 ? "" : "s"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-4">
          {legacy.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is defined on the original engine. That is the better
              place to be: everything here would be stored in a shared JSONB
              column with no column types, no unique indexes and no foreign
              keys, and every rule would be application code that some future
              import path forgets to run.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">Type</th>
                    <th className="px-2 py-2 font-medium">Slug</th>
                    <th className="px-2 py-2 text-right font-medium">Fields</th>
                    <th className="px-2 py-2 text-right font-medium">Records</th>
                    <th className="px-2 py-2 font-medium">Origin</th>
                    <th className="px-2 py-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {legacy.map((o) => (
                    <tr key={o.id} className={o.isActive ? "" : "opacity-60"}>
                      <td className="px-2 py-2">
                        <span className="font-medium">{o.pluralName}</span>
                        {o.description && (
                          <div className="max-w-sm truncate text-xs text-muted-foreground">
                            {o.description}
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap gap-1">
                          {o.unenforcedUniqueFields.length > 0 && (
                            <Badge
                              variant="outline"
                              className="border-red-400 text-[10px] text-red-700 dark:border-red-800 dark:text-red-300"
                            >
                              {o.unenforcedUniqueFields.length} unenforced unique
                            </Badge>
                          )}
                          {o.displayFieldMissing && (
                            <Badge
                              variant="outline"
                              className="border-amber-400 text-[10px] text-amber-700 dark:border-amber-700 dark:text-amber-300"
                            >
                              no display field
                            </Badge>
                          )}
                          {!o.isActive && (
                            <Badge variant="outline" className="text-[10px]">
                              inactive
                            </Badge>
                          )}
                          {o.isSystem && (
                            <Badge variant="outline" className="text-[10px]">
                              from a template
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                        {o.slug}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {o.fieldCount}
                        {o.requiredFields > 0 && (
                          <div className="text-[10px] text-muted-foreground">
                            {o.requiredFields} required
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {o.recordCount}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {o.industryTemplate ?? "hand-built"}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {day(o.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            ⚠️ &quot;Required&quot; on this engine is enforced by the record
            validator and by nothing underneath it, exactly as
            &quot;unique&quot; is enforced by nothing at all. Every write that
            goes through the validator is checked; any path that does not — a
            bulk import, a future API — stores what it is given. Sorting is
            textual too: a JSONB key has no type, so a price of 1000 sorts
            before a price of 9
            and a total is a cast per row.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        This page is read-only. Fields are added and edited where the type
        lives —{" "}
        <Link href="/objects" className="underline">
          /objects
        </Link>{" "}
        for the runtime engine, and its own designer for the JSONB one. What is
        here is the answer to &quot;what have we actually defined, and which of
        it is real&quot;, which is a question worth being able to ask without
        the ability to change anything.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="h-40 animate-pulse rounded-lg border bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function CustomObjectSettingsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Custom objects</h2>
        <p className="text-sm text-muted-foreground">
          The record types this workspace has defined, on both engines — and
          which of their rules the database actually keeps. The records
          themselves are at{" "}
          <Link href="/objects" className="underline">
            /objects
          </Link>
          .
        </p>
      </div>

      <Suspense fallback={<Skeleton />}>
        <ObjectSettingsBody />
      </Suspense>
    </div>
  );
}
