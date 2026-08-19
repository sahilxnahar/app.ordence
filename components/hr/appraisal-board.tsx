"use client";

/**
 * Ordence — ⭐⭐ THE APPRAISAL REGISTER, FOR HR
 * Version: v1.47.0-alpha · Batch 109
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE SENTENCE THIS SCREEN HAS TO CARRY
 * ══════════════════════════════════════════════════════════════════════
 * NOTHING HERE CHANGES ANYBODY'S PAY. A rating of "outstanding" writes
 * no pay component, no salary revision and no payslip line. It is said
 * on the screen, in the product, and not only in a comment — because the
 * assumption that an appraisal system feeds payroll is the default
 * assumption, and the cost of it being wrong is somebody not getting an
 * increment they were told they had.
 *
 * ⭐ AND THE SECOND SENTENCE: A SIGNED-OFF OUTCOME IS NOT EDITABLE.
 * There is no edit control on a signed row, only "record an amendment",
 * which asks for a reason and keeps the original.
 */

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  amendAppraisalOutcome,
  enrolInAppraisalCycle,
  releaseAppraisal,
  signOffAppraisal,
} from "@/server/actions/appraisals";
import type { CycleRegister, RegisterRow } from "@/server/actions/appraisals";
import { RATING_LABELS, RATING_ORDER } from "@/lib/hr/appraisal";

const KIND_LABEL: Record<string, string> = {
  self: "self",
  manager: "manager",
  skip_level: "skip-level",
};

function OutcomeForm({
  row,
  canSignOff,
  onDone,
}: {
  row: RegisterRow;
  canSignOff: boolean;
  onDone: (note: string | null, error: string | null) => void;
}) {
  const [pending, start] = useTransition();
  const [rating, setRating] = useState(row.rating ?? "meets");
  const [summary, setSummary] = useState(row.summary ?? "");
  const [reason, setReason] = useState("");

  if (!canSignOff) {
    return (
      <p className="text-xs text-muted-foreground">
        Signing off an outcome needs the approval permission — deliberately a different key from
        the one that runs the cycle, so the person who chases the reviews and the person who
        signs the verdict can be two people.
      </p>
    );
  }

  const signed = row.signedOffAt !== null;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`rating-${row.subjectId}`}>Outcome</Label>
          <select
            id={`rating-${row.subjectId}`}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={rating}
            onChange={(e) => setRating(e.target.value as typeof rating)}
          >
            {RATING_ORDER.map((r) => (
              <option key={r} value={r}>
                {RATING_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`summary-${row.subjectId}`}>Summary</Label>
          <Input
            id={`summary-${row.subjectId}`}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
      </div>

      {signed ? (
        <div className="space-y-2">
          {/*
            🔴 NO EDIT CONTROL ON A SIGNED ROW. The database refuses the
            update anyway; offering a control that would be refused
            teaches people the product is flaky.
          */}
          <div className="space-y-1">
            <Label htmlFor={`reason-${row.subjectId}`}>
              Why is this being changed? (at least 20 characters, kept forever)
            </Label>
            <Textarea
              id={`reason-${row.subjectId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
          <Button
            variant="outline"
            disabled={pending || reason.trim().length < 20}
            onClick={() =>
              start(async () => {
                const result = await amendAppraisalOutcome({
                  subjectId: row.subjectId,
                  rating,
                  summary,
                  reason,
                });
                onDone(result.ok ? result.data.note : null, result.ok ? null : result.error);
              })
            }
          >
            Record an amendment
          </Button>
          <p className="text-xs text-muted-foreground">
            The signed outcome stays exactly as it was. An amendment is a new record with your
            name, the time and your reason on it — the original is never overwritten.
          </p>
        </div>
      ) : (
        <Button
          disabled={pending || summary.trim().length === 0}
          onClick={() =>
            start(async () => {
              const result = await signOffAppraisal({
                subjectId: row.subjectId,
                rating,
                summary,
              });
              onDone(result.ok ? result.data.note : null, result.ok ? null : result.error);
            })
          }
        >
          Sign off
        </Button>
      )}
    </div>
  );
}

export function AppraisalBoard({ register }: { register: CycleRegister }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const done = (note: string | null, err: string | null) => {
    setMessage(note);
    setError(err);
  };

  return (
    <div className="space-y-6">
      {/*
        🔴 THE MONEY SENTENCE, ON THE SCREEN AND NOT ONLY IN A COMMENT.
      */}
      <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        Nothing on this screen changes anybody&rsquo;s pay. Ordence records the appraisal; the
        increment, if there is one, is entered on the payroll screen by whoever runs payroll.
        There is no link between the two, on purpose.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {register.cycle.name} · {register.cycle.periodStart} to {register.cycle.periodEnd} ·
            FY {register.cycle.fyLabel}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {register.cycle.enrolled} enrolled · {register.cycle.signedOff} signed off ·
            status {register.cycle.status}
          </p>
          {register.canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await enrolInAppraisalCycle({ cycleId: register.cycle.id });
                    done(result.ok ? result.data.note : null, result.ok ? null : result.error);
                  })
                }
              >
                Enrol everybody eligible
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Reviewers are taken from the reporting lines in force during the review period and
            fixed at enrolment. A reorganisation after that does not move a live appraisal.
          </p>
        </CardContent>
      </Card>

      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="space-y-2">
        {register.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody is enrolled in this cycle yet.
          </p>
        ) : null}
        {register.rows.map((row) => (
          <Card key={row.subjectId}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
                <span>{row.employeeName}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {row.employeeCode}
                </span>
                <Badge variant="secondary">{row.status}</Badge>
                {row.rating ? <Badge>{RATING_LABELS[row.rating]}</Badge> : null}
                {/*
                  ⭐ AN AMENDED OUTCOME SAYS SO ON THE ROW. A corrected
                  rating that looks identical to one nobody touched is how
                  a register stops being evidence.
                */}
                {row.amended ? (
                  <Badge variant="destructive">
                    amended ×{row.amendmentCount}
                  </Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-xs text-muted-foreground">
                Manager: {row.managerName ?? "none on record"} · Skip-level:{" "}
                {row.skipLevelName ?? "none"} · Reviews in:{" "}
                {row.reviewsSubmitted.length === 0
                  ? "none yet"
                  : row.reviewsSubmitted.map((k) => KIND_LABEL[k] ?? k).join(", ")}
              </p>
              {row.summary ? <p>{row.summary}</p> : null}
              {row.signedOffAt ? (
                <p className="text-xs text-muted-foreground">
                  Signed off {row.signedOffAt.slice(0, 10)}
                  {row.releasedAt
                    ? ` · released to the employee ${row.releasedAt.slice(0, 10)}`
                    : " · NOT yet released to the employee"}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen(open === row.subjectId ? null : row.subjectId)}
                >
                  {open === row.subjectId ? "Close" : "Outcome"}
                </Button>
                {register.canManage && row.signedOffAt && !row.releasedAt ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const result = await releaseAppraisal({ subjectId: row.subjectId });
                        done(
                          result.ok ? result.data.note : null,
                          result.ok ? null : result.error,
                        );
                      })
                    }
                  >
                    Release to the employee
                  </Button>
                ) : null}
              </div>

              {open === row.subjectId ? (
                <OutcomeForm row={row} canSignOff={register.canSignOff} onDone={done} />
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
