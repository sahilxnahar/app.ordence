"use client";

/**
 * Ordence — ⭐⭐ THE ACCESS REVIEW TABLE
 * Version: v1.52.0-alpha (Batch 130)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `consoleHref` COMES FROM `@/lib/platform/console-paths`
 * ══════════════════════════════════════════════════════════════════════
 * NEVER from `@/lib/platform/console-href`, which is `server-only` and
 * fails `check-server-boundaries` the moment a client file imports it.
 * `isConsoleHost` arrives as a prop from the server page, because a
 * client component has no `Host` header and guessing from
 * `window.location` is a hydration mismatch.
 *
 * ⚠️ `j`, `k`, `x`, Enter and Escape ALL COME FROM `<DataTable>`. There is
 * no keyboard handling in this file, deliberately: a second implementation
 * is a second set of shortcuts that disagrees with the rest of the console
 * the first time either changes.
 */

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { DataTable, type DataTableColumn } from "@/components/platform/data-table";
import { ConfirmDestructive } from "@/components/platform/confirm-destructive";
import { consoleHref } from "@/lib/platform/console-paths";
import {
  REASON_PROBLEM_WORDS,
  durationWords,
  formatIST,
  monthKeyLabel,
  reasonProblem,
  reviewWord,
  type AccessReviewRow,
} from "@/lib/platform/access-review";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function AccessReviewConsole({
  rows,
  isConsoleHost,
  periodKey,
  periodLabel,
  monthKeys,
  initialSelectedIds,
  canRevoke,
  truncated,
  onBulkRevoke,
  onMarkReviewed,
}: {
  rows: readonly AccessReviewRow[];
  isConsoleHost: boolean;
  periodKey: string;
  periodLabel: string;
  monthKeys: readonly string[];
  /**
   * 🔴 THE SELECTION AS IT ARRIVED IN THE ADDRESS BAR, read server-side
   * by `readDataTableParams()`. Seeding state from it is what makes a
   * shared review link arrive with the same rows ticked. It is NOT a
   * permission — see the note on the revoke handler below.
   */
  initialSelectedIds: readonly string[];
  canRevoke: boolean;
  truncated: boolean;
  onBulkRevoke: (input: {
    itemIds: string[];
    reason: string;
  }) => Promise<Result<{ revokedGrants: number; revokedSessions: number }>>;
  onMarkReviewed: (input: {
    itemIds: string[];
    periodKey: string;
    note: string;
  }) => Promise<Result<{ marked: number }>>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([...initialSelectedIds]);
  const [revoking, setRevoking] = useState(false);
  const [marking, setMarking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * ⚠️ `<DataTable>` KEEPS THE SELECTION IN THE URL and reports it here.
   * `onSelectionChange` must be stable or the table's effect re-fires on
   * every render.
   */
  const handleSelection = useCallback((ids: string[]) => {
    setSelected(ids);
    setOutcome(null);
  }, []);

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.includes(r.itemId)),
    [rows, selected],
  );

  const columns: readonly DataTableColumn<AccessReviewRow>[] = [
    {
      key: "kind",
      header: "Access",
      accessor: (r) => r.kindLabel,
      sortable: true,
      cell: (r) => (
        <span className="text-sm">
          {r.kindLabel}
          {/* The grade in words beside the kind: "who could" is only half
              the answer without "how much". */}
          <span className="block text-xs text-muted-foreground">{r.whoGrade}</span>
        </span>
      ),
    },
    {
      key: "who",
      header: "Held by",
      accessor: (r) => r.who,
      sortable: true,
    },
    {
      key: "workspace",
      header: "Into",
      accessor: (r) => r.workspace,
      sortable: true,
      cell: (r) =>
        r.workspaceId ? (
          <Link
            href={consoleHref(`/platform/tenants/${r.workspaceId}`, isConsoleHost)}
            className="underline underline-offset-2"
          >
            {r.workspace}
          </Link>
        ) : (
          <span>{r.workspace}</span>
        ),
    },
    {
      key: "startedAt",
      header: "From",
      accessor: (r) => r.startedAt,
      sortable: true,
      cell: (r) => <span className="tabular-nums text-xs">{formatIST(r.startedAt)}</span>,
    },
    {
      key: "minutes",
      header: "For",
      align: "right",
      hideOnMobile: true,
      // ⚠️ The accessor is the NUMBER so the sort is numeric; the cell is
      // the sentence. Sorting on "45 days" against "22 min" as text puts
      // a three-week grant below a coffee break.
      accessor: (r) => r.minutes,
      sortable: true,
      cell: (r) => <span className="text-xs">{durationWords(r.minutes)}</span>,
    },
    {
      key: "reason",
      header: "Stated reason",
      accessor: (r) => r.reason ?? "",
      cell: (r) => {
        const problem = reasonProblem(r.reason);
        if (problem) {
          return (
            <span className="text-sm font-semibold">
              {REASON_PROBLEM_WORDS[problem]}
              {problem === "thin" && r.reason ? (
                <span className="block font-normal text-muted-foreground">
                  &ldquo;{r.reason}&rdquo;
                </span>
              ) : null}
            </span>
          );
        }
        return <span className="text-sm text-muted-foreground">{r.reason}</span>;
      },
    },
    {
      key: "state",
      header: "State",
      accessor: (r) => r.stateWord,
      sortable: true,
      // Every state is a WORD. One in twelve Indian men is colour-blind,
      // so "still open" can never be carried by a red pill alone.
      cell: (r) => (
        <span className={r.active ? "text-sm font-semibold" : "text-sm"}>{r.stateWord}</span>
      ),
    },
    {
      key: "reviewed",
      header: "Reviewed",
      accessor: (r) => (r.reviewedAt ? r.reviewedAt : ""),
      sortable: true,
      cell: (r) => (
        <span className="text-xs">
          {reviewWord(r)}
          {r.reviewedAt ? (
            <span className="block text-muted-foreground">
              {r.reviewedBy} · {formatIST(r.reviewedAt)}
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  function runMarkReviewed() {
    setError(null);
    startTransition(async () => {
      const result = await onMarkReviewed({
        itemIds: selected,
        periodKey,
        note: note.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMarking(false);
      setNote("");
      setOutcome(
        `${result.data.marked} ${result.data.marked === 1 ? "record" : "records"} marked reviewed for ${periodLabel}.`,
      );
      router.refresh();
    });
  }

  function runRevoke({ reason }: { reason: string }) {
    setError(null);
    startTransition(async () => {
      /**
       * 🔴 THESE IDS CAME OUT OF THE BROWSER'S QUERY STRING and are sent
       * back to the server AS A REQUEST, not as an authorisation. The
       * server re-parses every one, re-fetches the row by id from its own
       * table inside the transaction, re-checks the row's state and the
       * owner floor across the whole batch, and refuses the ENTIRE batch
       * if any single id fails. Nothing this component has done — not the
       * confirmation dialog, not the `canRevoke` prop that hid the button
       * — counts as permission. See `bulkRevokeAccess()`.
       */
      const result = await onBulkRevoke({ itemIds: selected, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRevoking(false);
      setSelected([]);
      setOutcome(
        `Revoked ${result.data.revokedGrants} standing ${result.data.revokedGrants === 1 ? "grant" : "grants"} ` +
          `and ended ${result.data.revokedSessions} ${result.data.revokedSessions === 1 ? "session" : "sessions"}.`,
      );
      router.refresh();
    });
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={selected.length === 0 || pending}
        onClick={() => {
          setError(null);
          setMarking(true);
        }}
      >
        Mark {selected.length || "none"} reviewed
      </Button>
      {canRevoke ? (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={selected.length === 0 || pending}
          onClick={() => {
            setError(null);
            setRevoking(true);
          }}
        >
          Revoke {selected.length || "none"}
        </Button>
      ) : (
        // The reason is stated rather than the button silently missing: an
        // operator who cannot see why assumes the screen is broken.
        <span className="text-xs text-muted-foreground">
          Revoking access needs owner grade.
        </span>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="month" className="text-xs text-muted-foreground">
            Period under review
          </label>
          <select
            id="month"
            name="month"
            defaultValue={periodKey}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {monthKeys.map((key) => (
              <option key={key} value={key}>
                {monthKeyLabel(key)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline" size="sm">
          Show month
        </Button>
      </form>

      {truncated ? (
        <p role="alert" className="text-sm font-semibold">
          This month has more access records than one page can hold, so this list is
          incomplete. Do not sign it off as a full review — narrow the period first.
        </p>
      ) : null}

      {outcome ? (
        <p role="status" className="text-sm font-semibold">
          {outcome}
        </p>
      ) : null}
      {error && !revoking && !marking ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DataTable
        id="ar"
        rows={rows}
        columns={columns}
        rowId={(r) => r.itemId}
        caption={`${rows.length} access records in ${periodLabel}`}
        unit="access records"
        selectable
        onSelectionChange={handleSelection}
        searchable
        searchLabel="Find an operator or a workspace"
        searchText={(r) => `${r.who} ${r.workspace} ${r.kindLabel} ${r.stateWord} ${r.reason ?? ""}`}
        filters={[
          {
            key: "kind",
            label: "Kind of access",
            options: [
              { value: "", label: "Grants and impersonations" },
              { value: "grant", label: "Standing grants only" },
              { value: "session", label: "Impersonations only" },
            ],
            match: (r, value) => r.kind === value,
          },
          {
            key: "flag",
            label: "Needs attention",
            options: [
              { value: "", label: "Everything" },
              { value: "unjustified", label: "No stated reason" },
              { value: "unreviewed", label: "Not yet reviewed" },
              { value: "active", label: "Still active" },
            ],
            match: (r, value) =>
              value === "unjustified"
                ? reasonProblem(r.reason) !== null
                : value === "unreviewed"
                  ? r.reviewedAt === null
                  : r.active,
            hint: "Unjustified access is listed first whatever this is set to.",
          },
        ]}
        pageSize={50}
        emptyTitle="No standing grants and no impersonations in this month"
        emptyHint="That is a complete answer, not a missing one — record the review anyway."
        toolbar={toolbar}
      />

      <ConfirmDestructive
        open={revoking}
        onOpenChange={(open) => {
          setRevoking(open);
          if (!open) setError(null);
        }}
        /**
         * ⚠️ THE COUNT IS THE THING TO RE-READ IN A BULK ACTION. There is
         * no single row name to type here, and the mistake this dialog
         * exists to catch is "I thought I had three selected" — so the
         * number and the month are what the operator must copy out.
         */
        objectName={`${selected.length} in ${periodLabel}`}
        objectLabel="access records"
        actionLabel={`Revoke ${selected.length}`}
        title="Revoke every selected access record"
        consequence={
          "Every standing grant in this selection stops working immediately, and " +
          "every live impersonation in it is cut off mid-request."
        }
        consequences={[
          "All or nothing: if any one row cannot be revoked — already ended, already revoked, or the last usable owner — none of them are.",
          "Nothing is deleted. The grants and sessions stay in the register as evidence, marked revoked.",
          "The reason you write is stored against every row in this batch and is what an auditor reads six months from now.",
          "This does not mark the rows reviewed. Revoking is the fix; the review is the record that somebody looked.",
        ]}
        pending={pending}
        error={error}
        onConfirm={runRevoke}
      />

      <Dialog
        open={marking}
        onOpenChange={(open) => {
          setMarking(open);
          if (!open) setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark {selected.length} reviewed</DialogTitle>
            <DialogDescription>
              Your name and the time are written into the action register against each
              selected row, for {periodLabel}. The register is append-only: a review
              recorded by mistake cannot be deleted, only superseded by a later one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="review-note" className="text-sm">
              Anything worth saying about these rows (optional)
            </label>
            <Textarea
              id="review-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="e.g. Confirmed with Priya that the September break-glass was the GST filing incident."
            />
            {selectedRows.some((r) => reasonProblem(r.reason) !== null) ? (
              <p className="text-sm font-semibold">
                Some of these rows have no stated reason. Marking them reviewed records
                that you accepted that — write down why here.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMarking(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={runMarkReviewed} disabled={pending}>
              {pending ? "Recording…" : "Record the review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
