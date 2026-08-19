"use client";

/**
 * Ordence — ⭐⭐⭐ THE RERA STATUTORY LADDER
 * Version: v1.67.0-alpha · SQL 0111
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THERE IS NO "SEND ALL" ON THIS SCREEN AND THERE MUST NEVER BE ONE
 * ══════════════════════════════════════════════════════════════════════
 * Every other collections board in every other product has one. Here it
 * would be a button that serves forty cancellation warnings — forty
 * letters, each one the step before terminating an allotment and
 * forfeiting what a family has paid towards a home — from one click by
 * somebody who read a summary.
 *
 * ⭐ SO THE SHAPE OF THIS COMPONENT IS THE CONTROL. `onPreview` and
 * `onSend` each take ONE demand and ONE stage. There is no array
 * anywhere in this file, no selection checkbox, and no accumulator. It
 * is not that a bulk send is disabled; there is nothing here to enable.
 * `previewDunningSchema` and `sendDunningSchema` refuse arrays on the
 * server for the same reason, so a `curl` cannot do what the screen
 * cannot.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND HIDING A BUTTON IS A MISTAKE GUARD, NOT A BOUNDARY
 * ══════════════════════════════════════════════════════════════════════
 * Same warning as the credit control board, and it matters more here.
 * Every action this page reaches is a `"use server"` export, which is a
 * browser-reachable RPC endpoint, and `curl` has never rendered a
 * button. The refusals that matter are `permissionForStage` inside
 * `sendDunningNotice`, `canEscalate` inside `sendDunningLetter`, the
 * no-skip trigger in SQL 0027 §6 and the CHECKs in 0098 and 0111. If
 * this file were deleted tomorrow, not one of them would change.
 *
 * ⭐ WHAT THIS FILE IS FOR is making sure the person who DOES hold the
 * right sees the exact letter, the exact allottee, the exact amount and
 * the exact rung before they confirm — and sees what was served before,
 * and on whose authority, without leaving the row.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ MONEY ARRIVES AS A STRING OF PAISE AND IS NEVER PARSED
 * ══════════════════════════════════════════════════════════════════════
 * `Number("420000000")` is fine today and silently wrong at
 * ₹90,07,19,92,54,740.99. Nothing on this page does arithmetic; the
 * arithmetic happened against `bigint` in `lib/receivables/`.
 */

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/* ------------------------------------------------------------------ */
/* THE SHAPES, MIRRORED FROM THE SERVER                                */
/* ------------------------------------------------------------------ */

export type LadderStatutory = {
  stateCode: string | null;
  stateKnown: boolean;
  thresholdsUnverifiable: boolean;
  headline: string;
  detail: string;
  uniform: ReadonlyArray<{ basis: string; citation: string | null; point: string }>;
  stateDependent: ReadonlyArray<{ basis: string; citation: string | null; point: string }>;
};

export type LadderHistoryRow = {
  eventId: string;
  stage: string;
  rung: number;
  channel: string;
  evidenceWord: string;
  evidenceLabel: string;
  machineVerified: boolean;
  meaning: string;
  raisedAt: string | null;
  dispatchedAt: string | null;
  servedAt: string | null;
  serviceReference: string | null;
  dispatchFailureReason: string | null;
  serviceBasis: string | null;
  authorisedPermission: string;
  authorityRecorded: boolean;
};

export type LadderRow = {
  demandId: string;
  noticeNumber: string;
  bookingId: string;
  bookingReference: string;
  allotteeName: string;
  projectName: string;
  projectId: string | null;
  unitLabel: string;
  dueDate: string;
  daysOverdue: number;
  outstandingMinor: string;
  interestMinor: string;
  nextStage: string | null;
  nextRung: number | null;
  nextStageLabel: string | null;
  action: "send" | "needs_decision" | "none";
  reason: string;
  nextPermission: string | null;
  history: LadderHistoryRow[];
  unprovenCount: number;
  unrecordedAuthorityCount: number;
  statutory: LadderStatutory;
};

export type LadderRung = {
  stage: string;
  rung: number;
  label: string;
  permission: string;
  dangerous: boolean;
  needsNamedAuthoriser: boolean;
  why: string;
};

export type LadderPreview = {
  demandId: string;
  noticeNumber: string;
  bookingReference: string;
  allotteeName: string;
  projectName: string;
  unitLabel: string;
  stage: string;
  rung: number;
  stageLabel: string;
  channel: string;
  recipient: string | null;
  language: string;
  outstandingMinor: string;
  interestMinor: string;
  daysOverdue: number;
  dueDate: string;
  subject: string;
  body: string;
  wordsFellBack: boolean;
  wouldDispatch: boolean;
  permission: string;
  needsNamedAuthoriser: boolean;
  authorityWhy: string;
  refusal: { reason: string; remedy: string } | null;
  statutory: LadderStatutory;
};

type Fail = { ok: false; error: string };
type Ok<T> = { ok: true; data: T };

/* ------------------------------------------------------------------ */

/** Paise in, rupees out. Never parsed to a number — see the header. */
function inr(minor: string | null | undefined): string {
  if (!minor) return "₹0.00";
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

/**
 * ⚠️ THE BADGE COLOURS FROM `machineVerified`, NEVER FROM THE LABEL TEXT.
 * A person's tick and a verified send must not be able to render
 * identically, and the only field that cannot be made to lie about which
 * is which is the one the server derived from the grade.
 */
function EvidenceBadge({ row }: { row: LadderHistoryRow }) {
  if (row.machineVerified) {
    return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">{row.evidenceLabel}</Badge>;
  }
  if (row.evidenceWord === "deemed") {
    return <Badge className="bg-amber-600 text-white hover:bg-amber-600">{row.evidenceLabel}</Badge>;
  }
  if (row.evidenceWord === "human_recorded") {
    return <Badge variant="secondary">{row.evidenceLabel}</Badge>;
  }
  return <Badge variant="destructive">{row.evidenceLabel}</Badge>;
}

/**
 * ⭐ WHAT IS STATUTE AND WHAT IS A SETTING IN THIS PRODUCT.
 *
 * 🔴 IT IS RENDERED ON THE CONFIRM PANEL, NOT TUCKED INTO A HELP PAGE.
 * The day counts on this ladder come from `dunning_policies`, which is a
 * screen in this workspace. Nothing has ever checked them against any
 * State's rules, because RERA is a Central Act with State-made rules
 * (s.84) and Ordence carries no table of them. A person about to serve a
 * cancellation warning reading "60 days" needs to know which of those two
 * things they are looking at, at the moment they read it.
 */
function StatutoryPanel({ statutory }: { statutory: LadderStatutory }) {
  return (
    <div
      className={`rounded-md border p-3 text-xs ${
        statutory.stateKnown ? "bg-muted/40" : "border-amber-500/60 bg-amber-500/10"
      }`}
    >
      <p className="font-medium">{statutory.headline}</p>
      <p className="mt-1 text-muted-foreground">{statutory.detail}</p>
      {/*
        🔴 THIS SENTENCE DOES NOT GO AWAY WHEN THE STATE IS FILLED IN.

        ⚠️ `thresholdsUnverifiable` IS A SEPARATE FIELD FROM `stateKnown`
        FOR EXACTLY THAT REASON. Knowing the State tells you whose rules
        apply; it does not let this product check a day count, because it
        carries no table of them and deliberately never will. A panel that
        branched only on `stateKnown` would start showing a quiet all-clear
        the morning somebody typed "27" into a project, and the day counts
        would be no more verified than they were the day before.
      */}
      {statutory.thresholdsUnverifiable ? (
        <p className="mt-1 font-medium">
          ⚠️ The day counts on this ladder are this workspace&apos;s dunning policy.
          Nothing in Ordence has checked them against any State&apos;s rules or against
          the agreement for sale.
        </p>
      ) : null}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <p className="font-medium">Same in every State</p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {statutory.uniform.map((p) => (
              <li key={p.point}>
                {p.citation ? <span className="font-mono">{p.citation}</span> : null}{" "}
                {p.point}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium">Set by the State, or by the agreement</p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {statutory.stateDependent.map((p) => (
              <li key={p.point}>
                {p.citation ? <span className="font-mono">{p.citation}</span> : null}{" "}
                {p.point}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function DunningLadderBoard({
  asOf,
  rows,
  truncated,
  authority,
  heldPermissions,
  onPreview,
  onSend,
  onRecordPostalService,
  onRecordDeemedService,
}: {
  asOf: string;
  rows: LadderRow[];
  truncated: boolean;
  authority: LadderRung[];
  /**
   * ⭐ WHAT THIS PERSON ACTUALLY HOLDS, resolved on the server from the
   * same catalogue the guard uses. The board compares it against
   * `nextPermission` — which the server derived from
   * `permissionForStage` — so the screen never re-decides which key a
   * rung needs. It only decides whether to offer the button.
   */
  heldPermissions: string[];
  onPreview: (input: {
    demandId: string;
    stage: string;
    channel: string;
  }) => Promise<Ok<LadderPreview> | Fail>;
  onSend: (input: {
    demandId: string;
    stage: string;
    channel: string;
    authorisedReason?: string;
  }) => Promise<Ok<{ id: string }> | Fail>;
  onRecordPostalService: (input: {
    eventId: string;
    reference: string;
  }) => Promise<Ok<{ id: string }> | Fail>;
  onRecordDeemedService: (input: {
    eventId: string;
    reference: string;
    basis: string;
  }) => Promise<Ok<{ id: string }> | Fail>;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 🔴 ONE row at a time. A string, never a Set — see the file header. */
  const [openDemandId, setOpenDemandId] = useState<string | null>(null);
  const [preview, setPreview] = useState<LadderPreview | null>(null);
  const [channel, setChannel] = useState("email");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const [serviceEventId, setServiceEventId] = useState<string | null>(null);
  const [serviceKind, setServiceKind] = useState<"postal" | "deemed">("postal");
  const [reference, setReference] = useState("");
  const [basis, setBasis] = useState("");

  const holds = (permission: string | null): boolean =>
    permission !== null && heldPermissions.includes(permission);

  function reset() {
    setPreview(null);
    setReason("");
    setConfirmed(false);
  }

  function loadPreview(row: LadderRow) {
    if (!row.nextStage) return;
    setError(null);
    setMessage(null);
    setOpenDemandId(row.demandId);
    reset();
    const stage = row.nextStage;
    startTransition(async () => {
      const result = await onPreview({ demandId: row.demandId, stage, channel });
      if (result.ok) setPreview(result.data);
      else setError(result.error);
    });
  }

  /**
   * ⭐⭐ THE CONFIRM. One demand, one rung, and only from a preview that
   * is on screen.
   *
   * 🔴 IT READS `preview.stage`, NOT THE ROW'S. If the preview on screen
   * is for a different rung from the one the row now says is next — the
   * board was loaded five minutes ago and a colleague sent the first
   * notice in between — the letter the person read is the letter that
   * gets sent, and the server's own ladder gate refuses it as
   * `already_sent`. Sending the row's idea of "next" instead would send a
   * document nobody had read.
   */
  function send() {
    if (!preview) return;
    setError(null);
    setMessage(null);
    const input = {
      demandId: preview.demandId,
      stage: preview.stage,
      channel: preview.channel,
      ...(preview.needsNamedAuthoriser ? { authorisedReason: reason } : {}),
    };
    startTransition(async () => {
      const result = await onSend(input);
      if (result.ok) {
        setMessage(
          preview.wouldDispatch
            ? `${preview.stageLabel} raised for ${preview.allotteeName} and queued for dispatch. It is not served until the provider acknowledges it — the ladder will show a message id when it does.`
            : `${preview.stageLabel} raised for ${preview.allotteeName}. Nothing has been sent: this channel is one a person delivers, so record the delivery with its reference when it happens.`,
        );
        setOpenDemandId(null);
        reset();
      } else {
        setError(result.error);
      }
    });
  }

  function recordService() {
    if (!serviceEventId) return;
    setError(null);
    setMessage(null);
    const eventId = serviceEventId;
    const kind = serviceKind;
    startTransition(async () => {
      const result =
        kind === "deemed"
          ? await onRecordDeemedService({ eventId, reference, basis })
          : await onRecordPostalService({ eventId, reference });
      if (result.ok) {
        setMessage(
          kind === "deemed"
            ? "Recorded as DEEMED served — served in law without proof of receipt, under the basis you stated, with your name on it."
            : "Recorded as served by a named person, with a reference. It is not a dispatch and will never render as one.",
        );
        setServiceEventId(null);
        setReference("");
        setBasis("");
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {message ? (
        <p className="rounded-md border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/*
        ⭐ THE LADDER AND ITS RIGHTS, STATED ONCE AT THE TOP.
        ⚠️ It is rendered from what the server sent, not from a copy of
        the mapping written here. A screen holding its own copy is how a
        button comes to offer a rung the server refuses.
      */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">The ladder, and who may climb each rung</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Rung</th>
                <th className="p-3 font-medium">Right it needs</th>
                <th className="p-3 font-medium">You</th>
                <th className="p-3 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {authority.map((rung) => (
                <tr key={rung.stage}>
                  <td className="p-3 font-medium">
                    {rung.rung}. {rung.label}
                  </td>
                  <td className="p-3">
                    <code className="font-mono text-xs">{rung.permission}</code>
                    {rung.dangerous ? (
                      <Badge variant="destructive" className="ml-2">
                        dangerous
                      </Badge>
                    ) : null}
                  </td>
                  <td className="p-3">
                    {holds(rung.permission) ? (
                      <Badge variant="outline">held</Badge>
                    ) : (
                      <Badge variant="secondary">not held</Badge>
                    )}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">{rung.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nothing is overdue as at {asOf}. The ladder only lists demands that have been
            issued and are past their due date — a demand that is not yet due is not a
            chase, and a draft is not a document the buyer has ever seen.
          </CardContent>
        </Card>
      ) : null}

      {rows.map((row) => {
        const open = openDemandId === row.demandId;
        const canAct = holds(row.nextPermission);
        return (
          <Card key={row.demandId}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {row.allotteeName}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      · {row.projectName} · {row.unitLabel}
                    </span>
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Demand {row.noticeNumber} · booking {row.bookingReference} · due{" "}
                    {row.dueDate}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums">
                    {inr(row.outstandingMinor)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    plus {inr(row.interestMinor)} interest
                  </p>
                  <Badge
                    variant={row.daysOverdue > 90 ? "destructive" : "outline"}
                    className="mt-1"
                  >
                    {row.daysOverdue}d overdue
                  </Badge>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              {/*
                ⚠️ THE UNPROVEN COUNT SITS ABOVE THE NEXT-RUNG BUTTON, not
                below it. Climbing another rung on a ladder whose earlier
                rungs were never proved to have reached anybody is the
                mistake this whole batch exists to make visible, and it
                has to be read BEFORE the button, not after.
              */}
              {row.unprovenCount > 0 ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  ⚠️ {row.unprovenCount} rung(s) already raised on this demand have nothing
                  behind them — nothing dispatched, nothing recorded as delivered. A later
                  rung served on a buyer who never received an earlier one hands them a
                  complete answer at the Authority, with this system's own record as the
                  evidence.
                </p>
              ) : null}
              {row.unrecordedAuthorityCount > 0 ? (
                <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
                  {row.unrecordedAuthorityCount} rung(s) predate authority recording, so
                  this system cannot show which right they were raised under.
                </p>
              ) : null}

              {row.history.length > 0 ? (
                <div className="rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="p-2 font-medium">Rung</th>
                        <th className="p-2 font-medium">Raised</th>
                        <th className="p-2 font-medium">Dispatched</th>
                        <th className="p-2 font-medium">Served</th>
                        <th className="p-2 font-medium">Evidence</th>
                        <th className="p-2 font-medium">Under</th>
                        <th className="p-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {row.history.map((h) => (
                        <tr key={h.eventId} className="align-top">
                          <td className="p-2">
                            {h.rung}. {h.stage.replace(/_/g, " ")}
                            <span className="block text-xs text-muted-foreground">
                              {h.channel.replace(/_/g, " ")}
                            </span>
                          </td>
                          <td className="p-2 tabular-nums">{day(h.raisedAt)}</td>
                          <td className="p-2 tabular-nums">
                            {day(h.dispatchedAt)}
                            {h.dispatchFailureReason ? (
                              <span className="block text-xs text-destructive">
                                {h.dispatchFailureReason}
                              </span>
                            ) : null}
                          </td>
                          <td className="p-2 tabular-nums">{day(h.servedAt)}</td>
                          <td className="p-2">
                            <EvidenceBadge row={h} />
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {h.meaning}
                            </span>
                            {h.serviceReference ? (
                              <span className="mt-1 block font-mono text-xs">
                                {h.serviceReference}
                              </span>
                            ) : null}
                            {/*
                              ⭐ THE BASIS IS PRINTED, NOT HIDDEN BEHIND
                              THE BADGE. "Deemed served" with the reasoning
                              out of sight is the tick box again, wearing
                              the strongest label in the product.
                            */}
                            {h.serviceBasis ? (
                              <span className="mt-1 block text-xs italic text-muted-foreground">
                                Basis: {h.serviceBasis}
                              </span>
                            ) : null}
                          </td>
                          <td className="p-2 text-xs">
                            {h.authorityRecorded ? (
                              <code className="font-mono">{h.authorisedPermission}</code>
                            ) : (
                              <span className="text-muted-foreground">not recorded</span>
                            )}
                          </td>
                          <td className="p-2 text-right">
                            {h.evidenceWord === "none" ||
                            h.evidenceWord === "legacy_unverified" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pending}
                                onClick={() => {
                                  setServiceEventId(h.eventId);
                                  setServiceKind("postal");
                                  setReference("");
                                  setBasis("");
                                  setError(null);
                                  setMessage(null);
                                }}
                              >
                                Record service
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No rung has been raised on this demand yet.
                </p>
              )}

              {/* --- The service form, for one event at a time. ------- */}
              {serviceEventId &&
              row.history.some((h) => h.eventId === serviceEventId) ? (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={serviceKind === "postal" ? "default" : "outline"}
                      onClick={() => setServiceKind("postal")}
                    >
                      Delivered — record it
                    </Button>
                    <Button
                      size="sm"
                      variant={serviceKind === "deemed" ? "default" : "outline"}
                      onClick={() => setServiceKind("deemed")}
                      /*
                       * ⚠️ DEEMING NEEDS THE CANCELLATION KEY, NOT THE
                       * DUNNING ONE. It is a conclusion in law that clears
                       * the gate before a forfeiture, so it sits with the
                       * person who authorises the forfeiture warning. The
                       * server refuses it either way; this stops somebody
                       * typing out a basis they will not be allowed to
                       * record.
                       */
                      disabled={!holds("receivables:warn_cancellation")}
                    >
                      Deemed served in law
                    </Button>
                  </div>
                  {serviceKind === "deemed" &&
                  !holds("receivables:warn_cancellation") ? (
                    <p className="text-xs text-muted-foreground">
                      Deeming service needs{" "}
                      <code className="font-mono">receivables:warn_cancellation</code>,
                      the same right as a cancellation warning. It is the conclusion that
                      lets a forfeiture proceed on a letter nobody watched arrive.
                    </p>
                  ) : null}
                  <div>
                    <Label htmlFor="svc-ref">
                      {serviceKind === "deemed"
                        ? "Consignment number of the cover that came back, or the endorsement reference"
                        : "Speed post, RPAD or courier reference"}
                    </Label>
                    <Input
                      id="svc-ref"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      placeholder="EX123456789IN"
                    />
                  </div>
                  {serviceKind === "deemed" ? (
                    <div>
                      <Label htmlFor="svc-basis">
                        The clause or section that makes this good service
                      </Label>
                      <Textarea
                        id="svc-basis"
                        value={basis}
                        onChange={(e) => setBasis(e.target.value)}
                        placeholder="Clause 14.2 of the agreement for sale — notice to the address recorded therein; cover returned endorsed 'refused'. s.27, General Clauses Act 1897."
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        In the words you would use at a hearing. This is stored on the
                        notice and printed beside the grade — a deeming with no stated
                        basis is a tick box at the top of the evidence scale, and the
                        database refuses one.
                      </p>
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={pending} onClick={recordService}>
                      Record
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setServiceEventId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}

              {/* --- What comes next. -------------------------------- */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                <div className="text-sm">
                  <p className="font-medium">
                    {row.nextStageLabel
                      ? `Next: ${row.nextStageLabel}`
                      : "Nothing further on the ladder"}
                  </p>
                  <p className="text-xs text-muted-foreground">{row.reason}</p>
                  {row.nextPermission ? (
                    <p className="mt-1 text-xs">
                      Needs <code className="font-mono">{row.nextPermission}</code>
                      {canAct ? null : (
                        <span className="text-muted-foreground">
                          {" "}
                          — you do not hold it. This rung is somebody else&apos;s
                          decision.
                        </span>
                      )}
                    </p>
                  ) : null}
                </div>
                {row.nextStage && canAct ? (
                  <Button
                    variant={row.action === "needs_decision" ? "destructive" : "default"}
                    disabled={pending}
                    onClick={() => loadPreview(row)}
                  >
                    Read the letter first
                  </Button>
                ) : null}
              </div>

              {/* --- ⭐⭐⭐ THE PREVIEW, AND THE ONLY CONFIRM. -------- */}
              {open && preview ? (
                <div className="space-y-3 rounded-md border-2 border-primary/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      Rung {preview.rung} · {preview.stageLabel}
                    </p>
                    <Badge variant="outline">
                      {preview.wouldDispatch
                        ? "will be queued for email dispatch"
                        : "will be raised, not sent"}
                    </Badge>
                  </div>

                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">Allottee</dt>
                      <dd className="font-medium">{preview.allotteeName}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">To</dt>
                      <dd className="font-medium">{preview.recipient ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Amount demanded</dt>
                      <dd className="font-medium tabular-nums">
                        {inr(preview.outstandingMinor)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Interest</dt>
                      <dd className="font-medium tabular-nums">
                        {inr(preview.interestMinor)}
                      </dd>
                    </div>
                  </dl>

                  <StatutoryPanel statutory={preview.statutory} />

                  {preview.refusal ? (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                      {preview.refusal.reason} {preview.refusal.remedy}
                    </p>
                  ) : null}

                  {/*
                    🔴 THE LETTER ITSELF, VERBATIM. Not a summary and not
                    a template name. These are the characters that will be
                    stored in `demand_notice_documents` and sent — the
                    question asked in every dispute is "what did you
                    actually send them", and the only honest answer is the
                    one the person confirming has read.
                  */}
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Subject: <span className="font-medium">{preview.subject}</span>
                    </p>
                    <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">
                      {preview.body}
                    </pre>
                    {preview.wordsFellBack ? (
                      <p className="mt-1 text-xs text-amber-600">
                        ⚠️ The amount in words fell back to another language.
                      </p>
                    ) : null}
                  </div>

                  {preview.needsNamedAuthoriser ? (
                    <div className="space-y-2 rounded-md border border-destructive/40 p-3">
                      <p className="text-sm font-medium text-destructive">
                        {preview.authorityWhy}
                      </p>
                      <Label htmlFor="auth-reason">
                        Why this allotment, and why now. Your name goes on it.
                      </Label>
                      <Textarea
                        id="auth-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Three rungs served and unanswered since 12 March; instructed by the board on 4 August after the allottee declined the revised schedule."
                      />
                      <label className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(e) => setConfirmed(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span>
                          I have read this letter in full. I understand it precedes
                          terminating {preview.allotteeName}&apos;s allotment of{" "}
                          {preview.unitLabel} and forfeiting what has been paid, and that
                          the cure period and forfeiture position are set by the
                          agreement and this project&apos;s State rules, not by this
                          screen.
                        </span>
                      </label>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {/*
                      ⚠️ ONE BUTTON, ONE DEMAND, ONE RUNG. The label names
                      the person on purpose: "Send" is a verb about a
                      system, "Serve the cancellation warning on Priya
                      Sharma" is a sentence about somebody's home.
                    */}
                    <Button
                      variant={preview.needsNamedAuthoriser ? "destructive" : "default"}
                      disabled={
                        pending ||
                        preview.refusal !== null ||
                        (preview.needsNamedAuthoriser &&
                          (!confirmed || reason.trim().length < 10))
                      }
                      onClick={send}
                    >
                      Serve the {preview.stageLabel.toLowerCase()} on{" "}
                      {preview.allotteeName}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setOpenDemandId(null);
                        reset();
                      }}
                    >
                      Not now
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}

      {truncated ? (
        <p className="text-xs text-muted-foreground">
          ⚠️ More demands are overdue than are shown here. This is a page of the arrears,
          not the arrears — narrow it by project, or read the totals on the receivables
          report, which reconciles to the ledger before it prints a figure.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        As at {asOf}. This screen sends nothing on its own and has no bulk action: a
        button that served forty cancellation warnings from one click would be a button
        for forfeiting forty families&apos; deposits without reading forty letters. Every
        rung is one preview, one confirmation, and one audit row naming who authorised
        it, under which right, at what time and against which rung.
      </p>
    </div>
  );
}
