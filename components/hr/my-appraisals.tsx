"use client";

/**
 * Ordence — ⭐⭐⭐ MY APPRAISAL, AND MY LINE'S
 * Version: v1.47.0-alpha · Batch 109
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO EMPLOYEE PICKER ON THIS SCREEN AND THERE MUST NEVER BE
 * ══════════════════════════════════════════════════════════════════════
 * `myAppraisals()` takes no arguments. This component renders whatever
 * that call returned and has no way to ask for anybody else's. A picker
 * here would mean an id in a request, and an id in a request is a value
 * somebody can change — which on this screen means reading a colleague's
 * manager review.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THREE REVIEWS, THREE READERSHIPS, RENDERED AS THREE THINGS
 * ══════════════════════════════════════════════════════════════════════
 * A withheld review is shown as a NAMED ABSENCE, never omitted. Silence
 * makes the subject conclude their manager wrote nothing and ask them at
 * the worst possible moment, and makes a manager conclude the skip-level
 * never happened and chase it. Existence is not content.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitAppraisalReview } from "@/server/actions/appraisals";
import type { MyAppraisalsView, ParticipantSubject } from "@/server/actions/appraisals";
import { RATING_LABELS, RATING_ORDER } from "@/lib/hr/appraisal";

// ⚠️ A LOOKUP THAT MISSES MUST NOT RENDER "undefined" AT AN EMPLOYEE.
// `Record<string, string>` indexes to `string | undefined` under
// `noUncheckedIndexedAccess`, and the honest fallback for an unrecognised
// review kind is the kind's own name, not a blank or a crash.
const kindTitle = (k: string): string => KIND_TITLE[k] ?? k.replace(/_/g, " ");

const KIND_TITLE: Record<string, string> = {
  self: "Self review",
  manager: "Manager review",
  skip_level: "Skip-level review",
};

function ReviewForm({
  subject,
  onDone,
}: {
  subject: ParticipantSubject;
  onDone: (note: string | null, error: string | null) => void;
}) {
  const [pending, start] = useTransition();
  const [rating, setRating] = useState<string>("meets");
  const [strengths, setStrengths] = useState("");
  const [improvements, setImprovements] = useState("");

  if (!subject.myReviewKind) return null;
  if (subject.myReviewSubmitted) {
    return (
      <p className="text-xs text-muted-foreground">
        Your {kindTitle(subject.myReviewKind).toLowerCase()} is submitted. A submitted review
        cannot be edited — it is evidence in the same way the outcome is.
      </p>
    );
  }
  if (subject.cycleStatus !== "open") {
    return (
      <p className="text-xs text-muted-foreground">
        This cycle is {subject.cycleStatus}. Reviews can only be written while it is open.
      </p>
    );
  }

  const send = (submit: boolean) =>
    start(async () => {
      const result = await submitAppraisalReview({
        subjectId: subject.subjectId,
        kind: subject.myReviewKind,
        rating,
        strengths,
        improvements,
        submit,
      });
      onDone(result.ok ? result.data.note : null, result.ok ? null : result.error);
    });

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">
        {kindTitle(subject.myReviewKind)} — yours to write
      </p>
      {/*
        🔴 THE SKIP-LEVEL WRITER IS TOLD WHO READS IT BEFORE THEY TYPE.
        A skip-level review is a check on the manager; somebody who
        believes the manager will read it writes a different, useless one.
      */}
      {subject.myReviewKind === "skip_level" ? (
        <p className="text-xs text-muted-foreground">
          Read by you and by HR. Never shown to {subject.employeeName} or to their manager.
        </p>
      ) : null}
      {subject.myReviewKind === "manager" ? (
        <p className="text-xs text-muted-foreground">
          {subject.employeeName} sees this when the outcome is released, not before.
        </p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`rate-${subject.subjectId}`}>Rating</Label>
        <select
          id={`rate-${subject.subjectId}`}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={rating}
          onChange={(e) => setRating(e.target.value)}
        >
          {RATING_ORDER.map((r) => (
            <option key={r} value={r}>
              {RATING_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`str-${subject.subjectId}`}>What went well</Label>
        <Textarea
          id={`str-${subject.subjectId}`}
          rows={3}
          value={strengths}
          onChange={(e) => setStrengths(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`imp-${subject.subjectId}`}>What to work on</Label>
        <Textarea
          id={`imp-${subject.subjectId}`}
          rows={3}
          value={improvements}
          onChange={(e) => setImprovements(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={pending} onClick={() => send(false)}>
          Save draft
        </Button>
        <Button disabled={pending} onClick={() => send(true)}>
          Submit
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A draft is private to you. Submitting freezes it.
      </p>
    </div>
  );
}

function SubjectCard({
  subject,
  onDone,
}: {
  subject: ParticipantSubject;
  onDone: (note: string | null, error: string | null) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
          <span>{subject.employeeName}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {subject.cycleName} · {subject.periodStart} to {subject.periodEnd}
          </span>
          <Badge variant="secondary">{subject.status}</Badge>
          {subject.rating ? <Badge>{RATING_LABELS[subject.rating]}</Badge> : null}
          {subject.amended ? <Badge variant="destructive">amended</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {subject.relation.isSubject && !subject.releasedAt ? (
          <p className="text-xs text-muted-foreground">
            Your outcome has not been released yet. It is shared with you once the conversation
            has happened, not the moment it is signed.
          </p>
        ) : null}
        {subject.summary ? <p>{subject.summary}</p> : null}

        <div className="space-y-2">
          {subject.reviews.map((r) => (
            <div key={r.kind} className="rounded-md border p-2">
              <p className="text-xs font-medium">
                {kindTitle(r.kind)} · {r.reviewerName}
                {r.submittedAt ? "" : " · draft"}
              </p>
              {/*
                ⭐ EXISTENCE, NEVER CONTENT. A withheld review is named
                and its reader is named. See `lib/hr/visibility.ts`.
              */}
              {r.withheld ? (
                <p className="text-xs text-muted-foreground">{r.withheld}</p>
              ) : (
                <>
                  {r.rating ? (
                    <p className="text-xs text-muted-foreground">{RATING_LABELS[r.rating]}</p>
                  ) : null}
                  {r.strengths ? <p className="mt-1">{r.strengths}</p> : null}
                  {r.improvements ? (
                    <p className="mt-1 text-muted-foreground">{r.improvements}</p>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>

        <ReviewForm subject={subject} onDone={onDone} />
      </CardContent>
    </Card>
  );
}

export function MyAppraisals({ view }: { view: MyAppraisalsView }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (note: string | null, err: string | null) => {
    setMessage(note);
    setError(err);
  };

  if (!view.linked) {
    return (
      <p className="text-sm text-muted-foreground">
        No employee record is linked to your sign-in, so there is no appraisal here. Whoever
        maintains the payroll can link them.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {view.duplicateLink ? (
        <p className="rounded-md border border-amber-500 p-3 text-xs">
          More than one employee record is linked to your sign-in. Every one of them is you, so
          nothing is hidden — but it is a data-entry fault worth fixing.
        </p>
      ) : null}

      {view.myChain.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          Your reporting line: {view.myChain.join(" → ")}
        </p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">About me</h2>
        {view.aboutMe.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You are not enrolled in an appraisal cycle.
          </p>
        ) : (
          view.aboutMe.map((s) => (
            <SubjectCard key={s.subjectId} subject={s} onDone={done} />
          ))
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">My line</h2>
        {/*
          🔴 THIS LIST IS THE PEOPLE WHOSE APPRAISAL ROW NAMES ME AS
          REVIEWER. It is not "everyone in the cycle filtered on screen":
          the narrowing is in the WHERE clause of the query, because RLS
          scopes by tenant and every colleague's row is in this tenant.
        */}
        {view.myLine.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody&rsquo;s appraisal names you as their reviewer.
          </p>
        ) : (
          view.myLine.map((s) => <SubjectCard key={s.subjectId} subject={s} onDone={done} />)
        )}
      </section>

      {/*
        ⚠️ THE HR SIGNPOST, NOT A WIDER VIEW OF THIS ENDPOINT. Somebody
        holding the HR key looks at their own one appraisal and concludes
        the product is broken. The answer is a link to the screen that
        does show everybody, guarded by its own permission and reading
        its own queries — never a boolean that widens this one.
      */}
      {view.canSeeEveryone ? (
        <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          You also hold the HR permission. This page still shows only your own appraisal and your
          own line — for everybody&rsquo;s, go to{" "}
          <Link href="/hr/appraisals" className="underline">
            Appraisals
          </Link>
          .
        </p>
      ) : null}

      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
