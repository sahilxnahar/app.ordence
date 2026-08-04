"use client";

/**
 * Ordence — Record Types
 * Version: v0.27.0-alpha
 *
 * Everything this workspace has defined, what is in it, and how much room
 * is left.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE RECORD COUNT IS THE NUMBER SOMEBODY DECIDES ON
 * ══════════════════════════════════════════════════════════════════════
 * It is the count of LIVE records — `deleted_at IS NULL` — which is the
 * same predicate `dynamic_drop_object_table` uses when it checks the
 * confirmation. That is not a coincidence: the number here is the number
 * that has to be typed into the drop dialog, and two different definitions
 * of "how many records" would make that confirmation a puzzle.
 *
 * ⚠️ AND A COUNT THAT COULD NOT BE READ RENDERS AS "not counted", NEVER AS
 * ZERO. A zero somebody believes is the reason a full table gets dropped.
 */

import Link from "next/link";
import { Plus } from "lucide-react";
import { ObjectIcon } from "./object-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LimitMeter } from "./limit-meter";
import {
  MAX_OBJECTS_PER_TENANT,
  OBJECT_LIMIT_EXPLANATION,
  type ObjectSummary,
} from "./presentation";

export function ObjectList({ objects }: { objects: readonly ObjectSummary[] }) {
  const atCap = objects.length >= MAX_OBJECTS_PER_TENANT;

  return (
    <div className="flex flex-col gap-4">
      <LimitMeter
        label="Record types in this workspace"
        used={objects.length}
        max={MAX_OBJECTS_PER_TENANT}
        explanation={OBJECT_LIMIT_EXPLANATION}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Each record type is a real table with typed columns, real indexes and real
          foreign keys — not rows in a shared blob.
        </p>
        {/*
          ⚠️ AT THE CAP THIS IS A DISABLED BUTTON, NOT A DISABLED LINK.
          `Slot` forwards `disabled` to the anchor, where it is not an
          attribute — the link would still navigate, to a page that refuses.
          A control that cannot be used has to actually not work.
        */}
        {atCap ? (
          <Button disabled>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New record type
          </Button>
        ) : (
          <Button asChild>
            <Link href="/objects/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New record type
            </Link>
          </Button>
        )}
      </div>

      {atCap ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          This workspace has the maximum of {MAX_OBJECTS_PER_TENANT} record types.
          Archive or delete one before defining another.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {objects.length} custom record type{objects.length === 1 ? "" : "s"}
          </caption>
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Record type
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                API name
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Records
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Fields
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Created
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {objects.map((object) => (
              <tr key={object.id} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    <ObjectIcon name={object.icon || "box"} className="mt-0.5 h-4 w-4" />
                    <div>
                      <Link
                        href={`/objects/${object.id}/records`}
                        className="font-medium hover:underline"
                      >
                        {object.pluralLabel}
                      </Link>
                      {object.description ? (
                        <div className="text-[11px] text-muted-foreground">
                          {object.description}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </td>

                <td className="px-3 py-2">
                  <code className="font-mono text-xs">{object.apiName}</code>
                  <div className="text-[11px] text-muted-foreground">
                    <Badge variant="outline" className="text-[10px]">
                      permanent
                    </Badge>
                  </div>
                </td>

                <td className="px-3 py-2 text-right tabular-nums">
                  {object.recordCount === null ? (
                    <span className="text-xs text-muted-foreground" title="The count query did not return. It is not zero.">
                      not counted
                    </span>
                  ) : (
                    object.recordCount.toLocaleString("en-IN")
                  )}
                </td>

                <td className="px-3 py-2 text-right tabular-nums">
                  {object.fieldCount.toLocaleString("en-IN")}
                </td>

                <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                  {object.createdAt.slice(0, 10)}
                </td>

                <td className="px-3 py-2">
                  <div className="flex justify-end gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/objects/${object.id}/records`}>Records</Link>
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/objects/${object.id}`}>Design</Link>
                    </Button>
                  </div>
                </td>
              </tr>
            ))}

            {objects.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  No custom record types yet. A record type is how you track something
                  this product does not ship — a site visit, a snag, a handover.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
