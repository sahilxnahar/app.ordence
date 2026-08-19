"use client";

/**
 * Ordence — ⭐⭐⭐ THE SECRET ROTATION BOARD
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT THIS SCREEN SHOWS, EXHAUSTIVELY
 * ══════════════════════════════════════════════════════════════════════
 * The NAME, whether it is PRESENT, its CATEGORY, the AGE BAND of its last
 * recorded rotation, the CONSEQUENCE of it being absent, and WHO recorded
 * the last rotation.
 *
 * Not the value. Not a prefix. Not a suffix. Not the last four
 * characters. Not the length. `/api/diag` used to publish `{ present,
 * length }` for forty-seven names, unauthenticated, on the argument that
 * a length is not a value — but an exact character count tells an
 * attacker whether their paste was truncated and which issuer's key
 * format is in use. There is no field on this row carrying one; see the
 * header of `lib/platform/secret-board.ts`.
 *
 * 🔴 `consoleHref` FROM `@/lib/platform/console-paths`, NEVER FROM
 * `console-href` — that module is `server-only` and importing it here
 * fails `check-server-boundaries`. `isConsoleHost` arrives as a prop
 * because a browser has no `Host` header.
 *
 * ⚠️ THE BAND IS A WORD. "fresh", "ageing", "overdue", "never recorded".
 * Roughly one in twelve Indian men is colour-blind; the colour behind the
 * word is decoration and carries nothing on its own.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { DataTable, type DataTableColumn } from "@/components/platform/data-table";
import { consoleHref } from "@/lib/platform/console-paths";
import {
  SECRET_BANDS,
  bandSeverity,
  type SecretBoardRow,
} from "@/lib/platform/secret-board";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Result = { ok: true } | { ok: false; error: string };

/** The date the operator most often means: today, in their own timezone. */
function todayLocalIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * ⚠️ PRESENCE IS A WORD TOO. "set" / "absent", not a tick and a cross —
 * a tick at a glance is indistinguishable from a cross at a glance, and
 * this column is the one an operator scans fastest.
 */
function presenceWord(row: SecretBoardRow): string {
  return row.present ? "set" : "absent";
}

export function SecretRotationBoard({
  rows,
  isConsoleHost,
  onRecordRotation,
}: {
  rows: readonly SecretBoardRow[];
  isConsoleHost: boolean;
  onRecordRotation: (input: {
    name: string;
    reason: string;
    rotatedOn: string;
  }) => Promise<Result>;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<SecretBoardRow | null>(null);
  const [reason, setReason] = useState("");
  const [rotatedOn, setRotatedOn] = useState(todayLocalIso());
  const [pending, startTransition] = useTransition();

  /** Categories present in the data — never a hand-typed filter list. */
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const row of rows) if (!seen.includes(row.category)) seen.push(row.category);
    return seen;
  }, [rows]);

  function submit() {
    if (!target) return;
    const name = target.name;
    startTransition(async () => {
      const result = await onRecordRotation({ name, reason, rotatedOn });
      if (result.ok) {
        setTarget(null);
        setReason("");
        toast.success(
          `Recorded that ${name} was rotated. The value itself is unchanged — rotate it in Railway.`,
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const columns: readonly DataTableColumn<SecretBoardRow>[] = [
    {
      key: "name",
      header: "Setting",
      accessor: (r) => r.name,
      sortable: true,
      cell: (r) => (
        <div className="space-y-0.5">
          <div className="font-medium tabular-nums">{r.name}</div>
          <div className="text-xs text-muted-foreground">
            {r.category}
            {r.bootRole === "required"
              ? " · required to boot"
              : r.bootRole === "advisory"
                ? " · advisory"
                : ""}
          </div>
        </div>
      ),
    },
    {
      /**
       * ⭐ THE BAND, AND THE NUMBER OF DAYS BESIDE IT WHEN THERE IS ONE.
       * When there is not, the cell says so in words and shows no number
       * at all — not a zero, not a dash that could be read as recent.
       */
      key: "age",
      header: "Last rotation",
      accessor: (r) =>
        // Sorted worst-first by band, then by age within the band. An
        // operator opening this screen wants the top of the list to be
        // the thing to do next.
        bandSeverity(r.bandKey) * 100_000 + (r.daysSinceRotation ?? 0),
      sortable: true,
      cell: (r) => {
        const band = SECRET_BANDS[r.bandKey];
        return (
          <div className="flex items-baseline gap-2">
            {r.daysSinceRotation === null ? null : (
              <span className="text-2xl font-semibold leading-none tabular-nums">
                {r.daysSinceRotation}
                <span className="ml-1 text-xs font-normal text-muted-foreground">days</span>
              </span>
            )}
            <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${band.tone}`}>
              {band.word}
            </span>
          </div>
        );
      },
    },
    {
      key: "recorded",
      header: "Recorded by",
      accessor: (r) => r.lastRotatedAt ?? "",
      sortable: true,
      hideOnMobile: true,
      cell: (r) =>
        r.lastRotatedAt === null ? (
          <span className="text-xs text-muted-foreground">
            never recorded — nobody has written a rotation of this down
          </span>
        ) : (
          <div className="space-y-0.5 text-xs">
            <div>{new Date(r.lastRotatedAt).toISOString().slice(0, 10)}</div>
            <div className="text-muted-foreground">{r.rotatedBy ?? "actor not recorded"}</div>
            {r.rotationReason === null ? null : (
              <div className="max-w-xs text-muted-foreground">{r.rotationReason}</div>
            )}
          </div>
        ),
    },
    {
      key: "present",
      header: "Visible to the app",
      accessor: (r) => presenceWord(r),
      sortable: true,
      cell: (r) => (
        <Badge variant={r.present ? "secondary" : r.bootRole === "optional" ? "outline" : "destructive"}>
          {presenceWord(r)}
        </Badge>
      ),
    },
    {
      /**
       * ⚠️ THE CONSEQUENCE IS `BOOT_ADVISORY`'S OWN SENTENCE, shown
       * verbatim. Those strings were written to say exactly what breaks,
       * and paraphrasing them here would create a second description that
       * drifts from the one the boot assertion prints in the deploy log.
       */
      key: "consequence",
      header: "If it is absent",
      accessor: (r) => r.consequence ?? "",
      hideOnMobile: true,
      cell: (r) => (
        <p className="max-w-md text-xs text-muted-foreground">
          {r.consequence ??
            (r.bootRole === "required"
              ? "the deployment refuses to start — it is on the boot assertion's required list"
              : "no list records a consequence; the feature this setting serves is simply off")}
        </p>
      ),
    },
  ];

  return (
    <>
      <DataTable
        id="secrets"
        rows={rows}
        columns={columns}
        rowId={(r) => r.name}
        caption="Every setting Ordence reads, how old its last recorded rotation is, and what breaks without it. No value, prefix or length is shown."
        unit="settings"
        defaultSort={{ key: "age", dir: "desc" }}
        searchable
        searchLabel="Find a setting"
        searchText={(r) => `${r.name} ${r.category} ${r.consequence ?? ""}`}
        filters={[
          {
            key: "band",
            label: "Age",
            options: [
              { value: "overdue", label: "overdue" },
              { value: "ageing", label: "ageing" },
              { value: "fresh", label: "fresh" },
              { value: "never-recorded", label: "never recorded" },
            ],
            match: (row, value) => row.bandKey === value,
          },
          {
            key: "presence",
            label: "Visible to the app",
            options: [
              { value: "set", label: "set" },
              { value: "absent", label: "absent" },
            ],
            match: (row, value) => presenceWord(row) === value,
          },
          {
            key: "category",
            label: "Category",
            options: categories.map((c) => ({ value: c, label: c })),
            match: (row, value) => row.category === value,
          },
        ]}
        rowActions={(row) => (
          <Button size="sm" variant="outline" onClick={() => setTarget(row)}>
            Record a rotation
          </Button>
        )}
        toolbar={
          <Link
            href={consoleHref("/platform/log", isConsoleHost)}
            className="text-xs underline underline-offset-2"
          >
            Every rotation recorded here is a row in the action register
          </Link>
        }
      />

      <Dialog open={target !== null} onOpenChange={(open) => (open ? null : setTarget(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a rotation of {target?.name}</DialogTitle>
            {/*
              🔴 SAID ON THE SCREEN, NOT ONLY IN A COMMENT. An operator who
              believes this form rotated the key will not go and rotate the
              key — which would turn the board into the thing it exists to
              prevent: a green tick over a stale credential.
            */}
            <DialogDescription>
              This writes down that a rotation happened. It does not change the value and
              cannot: the value is set in Railway by a human, and this console can neither
              read it nor write it. Rotate it there first, then record it here.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="rotated-on">
                The day it was rotated
              </label>
              <Input
                id="rotated-on"
                type="date"
                value={rotatedOn}
                max={todayLocalIso()}
                onChange={(e) => setRotatedOn(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="rotation-reason">
                Why it was rotated
              </label>
              <Textarea
                id="rotation-reason"
                rows={3}
                value={reason}
                placeholder="Scheduled ninety-day rotation. / Contractor offboarded. / Suspected exposure in a log."
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                A sentence at least. In a year this is the only thing that explains the row.
                {" "}
                <strong>Never paste the value or any part of it here</strong> — the register
                is retained for years and readable by every platform grade.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || reason.trim().length < 10}>
              {pending ? "Recording…" : "Record it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
