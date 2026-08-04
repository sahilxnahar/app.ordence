"use client";

/**
 * Ordence — One Custom Record
 * Version: v0.27.0-alpha
 *
 * ⚠️ HIDDEN FIELDS ARE NOT SHOWN HERE EITHER, and the page says how many
 * were withheld. A detail screen that silently omits three of a record's
 * eleven fields is a screen somebody reads a decision off, wrongly.
 *
 * ⚠️ DELETING A RECORD IS SOFT AND THE DIALOG SAYS SO. It stamps
 * `deleted_at` and every read already filters on it. That is a genuinely
 * different decision from dropping a field or a table — those destroy a
 * column or a table and demand a typed confirmation — and pretending
 * otherwise would train people to type past the ones that matter.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatFieldValue, type ObjectFieldRow } from "./presentation";
import type { ActionResult } from "@/lib/validators/crm";

export function RecordDetail({
  objectId,
  fields,
  record,
  relationLabels = {},
  onDelete,
}: {
  objectId: string;
  fields: readonly ObjectFieldRow[];
  record: Record<string, unknown>;
  /** Field api name → the linked record's own title, when it is known. */
  relationLabels?: Record<string, string>;
  onDelete: (input: unknown) => Promise<ActionResult<{ recordId: string }>>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = fields.filter((f) => !f.isHidden);
  const hiddenCount = fields.length - visible.length;
  const recordId = String(record.id ?? "");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button asChild variant="outline">
          <Link href={`/objects/${objectId}/records/${recordId}/edit`}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit
          </Link>
        </Button>
        <Button variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">Every visible field on this record</caption>
          <tbody>
            {visible.map((field) => (
              <tr key={field.id} className="border-b border-border last:border-b-0">
                <th
                  scope="row"
                  className="w-1/3 bg-muted/30 px-3 py-2 text-left align-top text-xs font-medium"
                >
                  {field.label}
                  {field.isRequired ? (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      required
                    </Badge>
                  ) : null}
                  <div className="font-mono text-[10px] font-normal text-muted-foreground">
                    {field.apiName}
                  </div>
                </th>
                <td className="px-3 py-2 align-top">
                  {field.fieldType === "relation" ? (
                    <>
                      {relationLabels[field.apiName] ??
                        formatFieldValue(field, record[field.apiName])}
                      {record[field.apiName] ? (
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {String(record[field.apiName])}
                        </div>
                      ) : null}
                    </>
                  ) : field.fieldType === "url" && record[field.apiName] ? (
                    <a
                      href={String(record[field.apiName])}
                      className="underline"
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {String(record[field.apiName])}
                    </a>
                  ) : (
                    formatFieldValue(field, record[field.apiName])
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Created {String(record.created_at ?? "—").slice(0, 19).replace("T", " ")} UTC.
        Last updated {String(record.updated_at ?? "—").slice(0, 19).replace("T", " ")} UTC.
        {hiddenCount > 0
          ? ` ${hiddenCount} field${hiddenCount === 1 ? " is" : "s are"} marked hidden and not shown here. The values are still stored.`
          : ""}
      </p>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this record?</DialogTitle>
            <DialogDescription>
              The row is kept and stamped as deleted, so it stops appearing in lists and
              can be recovered by support. This is not the same as dropping a field or a
              record type — those destroy a column or a table and ask you to type a name
              back.
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                setError(null);
                try {
                  const result = await onDelete({ objectId, recordId });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                  router.push(`/objects/${objectId}/records`);
                  router.refresh();
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
