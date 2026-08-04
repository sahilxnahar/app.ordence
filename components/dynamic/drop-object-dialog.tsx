"use client";

/**
 * Ordence — Dropping A Record Type
 * Version: v0.27.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE MOST DESTRUCTIVE SCREEN IN THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * This is not "delete a row". It is `DROP TABLE`, on a real table, with
 * real customer data in it, and there is no recycle bin behind it.
 *
 * ⚠️ THE ENGINE ASKS FOR THREE THINGS AND THIS DIALOG ASKS FOR ALL THREE.
 * It would be easy — and it is what most products do — to collapse them
 * into one checkbox reading "I understand this cannot be undone". That
 * would be a lie of omission, because the engine will refuse the call and
 * the person would meet the real requirement as an error message after
 * they had already decided.
 *
 *   1. `custom_objects:drop_object`, a permission on the dangerous list.
 *      Not something this dialog can supply; a refusal is rendered.
 *   2. `confirmApiName` — the api name typed back. The GitHub
 *      "type the repository name" pattern: the only confirmation that
 *      cannot be completed by muscle memory.
 *   3. ⭐ `confirmRecordCount` — the number of LIVE records being
 *      destroyed, typed back, and checked against the real count inside
 *      the database. A boolean is typed once by a developer and is true
 *      forever after; a count has to come from a screen a person read, and
 *      if it changed between reading and confirming, the drop aborts and
 *      they look again. It is optimistic concurrency applied to a decision.
 *
 * ⚠️ AND IF THE COUNT COULD NOT BE READ, THE DIALOG DOES NOT OFFER THE
 * DROP AT ALL. A screen that renders an uncounted table as "0 records" is
 * the screen somebody empties a full table from.
 *
 * ⚠️ ARCHIVING IS NAMED FIRST, because it is what most people mean. It
 * takes the record type out of navigation and leaves the table and every
 * row exactly where they are.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/validators/crm";

export type DropObjectAction = (
  input: unknown,
) => Promise<ActionResult<{ objectId: string; recordsDestroyed: number }>>;

export type ArchiveObjectAction = (
  input: unknown,
) => Promise<ActionResult<{ objectId: string }>>;

export function DropObjectDialog({
  objectId,
  apiName,
  label,
  physicalTableName,
  recordCount,
  onDrop,
  onArchive,
  redirectTo = "/objects",
}: {
  objectId: string;
  apiName: string;
  label: string;
  physicalTableName: string;
  /** Live records. `null` means the count could not be read — see above. */
  recordCount: number | null;
  onDrop: DropObjectAction;
  onArchive?: ArchiveObjectAction;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [typedCount, setTypedCount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counted = recordCount !== null;
  const nameMatches = typedName === apiName;
  /*
   * ⚠️ COMPARED AS A NUMBER, NOT AS A STRING. "007" and "7" are the same
   * decision, and refusing the first would be a puzzle rather than a
   * safeguard. An empty box is not zero — `Number("")` is 0, which would
   * make "type the count" satisfiable by typing nothing on an empty table.
   */
  const trimmedCount = typedCount.trim();
  const countMatches =
    counted && /^\d+$/.test(trimmedCount) && Number(trimmedCount) === recordCount;

  const ready = counted && nameMatches && countMatches && !pending;

  const reset = () => {
    setTypedName("");
    setTypedCount("");
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="text-destructive">
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete permanently…
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{label}&rdquo; and everything in it?</DialogTitle>
          <DialogDescription>
            This drops the table <code className="font-mono">{physicalTableName}</code>{" "}
            from the database. Every record of this type is destroyed. Nothing is
            archived, nothing is exported, and there is no undo.
          </DialogDescription>
        </DialogHeader>

        {/* ---------------- The honest number ---------------- */}
        <div
          className={
            counted
              ? "rounded-md border border-destructive/30 bg-destructive/10 p-3"
              : "rounded-md border border-border bg-muted/30 p-3"
          }
        >
          {counted ? (
            <>
              <p className="text-sm font-semibold text-destructive">
                {recordCount.toLocaleString("en-IN")} live record
                {recordCount === 1 ? "" : "s"} will be destroyed.
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Counted just now, the same way the database counts it. If somebody adds
                or deletes a record before you confirm, the drop is refused and you will
                be shown the new number — that is deliberate.
              </p>
            </>
          ) : (
            <p className="text-sm">
              The live record count could not be read, so this record type cannot be
              dropped from here. The engine requires the exact number, and a screen that
              guessed at it would be the screen somebody empties a full table from.
            </p>
          )}
        </div>

        {/* ---------------- The safer door, named first ---------------- */}
        {onArchive ? (
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium">Did you mean to archive it?</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Archiving takes this record type out of navigation and leaves the table and
              every record exactly where they are. An archive made by mistake is one
              click away from being undone; this is not.
            </p>
            <Button
              variant="outline"
              className="mt-2 h-8 text-xs"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                setError(null);
                try {
                  const result = await onArchive({ objectId });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                  router.push(redirectTo);
                  router.refresh();
                } finally {
                  setPending(false);
                }
              }}
            >
              Archive instead
            </Button>
          </div>
        ) : null}

        {counted ? (
          <div className="space-y-3">
            <div>
              <label htmlFor="drop-confirm-name" className="mb-1 block text-xs font-medium">
                Type the api name <code className="font-mono">{apiName}</code> to confirm
              </label>
              <Input
                id="drop-confirm-name"
                value={typedName}
                autoComplete="off"
                className="font-mono"
                aria-describedby="drop-confirm-name-help"
                onChange={(event) => setTypedName(event.target.value)}
              />
              <p id="drop-confirm-name-help" className="mt-1 text-[11px] text-muted-foreground">
                Typing the name is the one confirmation that cannot be completed by
                muscle memory.
              </p>
            </div>

            <div>
              <label
                htmlFor="drop-confirm-count"
                className="mb-1 block text-xs font-medium"
              >
                Type the number of records being destroyed
              </label>
              <Input
                id="drop-confirm-count"
                value={typedCount}
                inputMode="numeric"
                autoComplete="off"
                className="font-mono"
                aria-describedby="drop-confirm-count-help"
                onChange={(event) => setTypedCount(event.target.value)}
              />
              <p
                id="drop-confirm-count-help"
                className="mt-1 text-[11px] text-muted-foreground"
              >
                The database checks this against the real count at the moment of the
                drop. It is not a formality: it is what makes you look at the number
                before you destroy it.
              </p>
            </div>
          </div>
        ) : null}

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
            disabled={!ready}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                const result = await onDrop({
                  objectId,
                  confirmApiName: typedName,
                  confirmRecordCount: Number(trimmedCount),
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setOpen(false);
                router.push(redirectTo);
                router.refresh();
              } finally {
                setPending(false);
              }
            }}
          >
            {pending
              ? "Dropping…"
              : counted
                ? `Drop the table and ${recordCount.toLocaleString("en-IN")} record${
                    recordCount === 1 ? "" : "s"
                  }`
                : "Drop the table"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
