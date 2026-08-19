"use client";

/**
 * Ordence — ⭐⭐⭐ DEMANDS, NOTICES AND RECEIPTS
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FOURTEEN SERVER ACTIONS WITH NO SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * The whole demand lifecycle , raise, preview, serve, withdraw, replace,
 * the dunning history , and the whole receipt lifecycle , record, bounce,
 * re-appropriate , existed and could not be reached. A developer using
 * Ordence could see an ageing report and could not raise the demand that
 * ageing report is about.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ FOUR SEPARATE PERMISSIONS, AND THE SPLIT IS NOT BUREAUCRACY
 * ══════════════════════════════════════════════════════════════════════
 *   receivables:raise_demand    compute what is owed and draft the notice
 *   receivables:issue_demand    SERVE it, withdraw it, replace it
 *   receivables:record_receipt  record money arriving
 *   receivables:allocate        move money between demands after the fact
 *
 * Serving is the one that starts a clock a buyer can be penalised
 * against, and withdrawing is the one that has to be explained later.
 * Recording a receipt and re-appropriating one are also different: the
 * first says money came in, the second changes what the buyer has
 * already been told about their own payment.
 *
 * ⚠️ PREVIEW BEFORE SERVE, ALWAYS OFFERED. A demand notice is a legal
 * document in the buyer's language. Serving one that nobody read is how
 * a firm discovers its interest rate clause reads wrongly in Kannada,
 * from the buyer's advocate.
 */

import { useState, useTransition } from "react";
import { AlertTriangle, Eye, IndianRupee, Scale, Send } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type DemandView = {
  id: string;
  noticeNumber: string;
  status: string;
  dueDate: string;
  totalMinor: string;
  allocatedMinor: string;
  rateExceedsReference: boolean;
  triggerLabel: string;
};

export type ReceiptView = {
  id: string;
  receiptNumber: string;
  receivedOn: string;
  amountMinor: string;
  allocatedMinor: string;
  status: string;
  allocations: Array<{ noticeNumber: string; amountMinor: string; explanation: string }>;
};

export type LadderStep = { stage: string; dueOn: string; automatic: boolean };

type NoticeService = {
  eventId: string;
  stage: string;
  evidenceWord: string;
  evidenceLabel: string;
  meaning: string;
  servedAt: string | null;
  serviceBasis: string | null;
};

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "kn", label: "Kannada" },
  { value: "ta", label: "Tamil" },
  { value: "te", label: "Telugu" },
  { value: "mr", label: "Marathi" },
] as const;

const TRIGGER_KINDS = [
  { value: "construction_event", label: "A construction event" },
  { value: "scheduled_date", label: "A date in the plan" },
  { value: "booking_event", label: "A booking event" },
  { value: "possession", label: "Possession" },
  { value: "statutory", label: "A statutory trigger" },
] as const;

const TAX_KINDS = [
  { value: "cgst_sgst", label: "CGST + SGST (same state)" },
  { value: "cgst_utgst", label: "CGST + UTGST (union territory)" },
  { value: "igst", label: "IGST (across states)" },
] as const;

const RECEIPT_METHODS = [
  "neft", "rtgs", "imps", "upi", "cheque", "demand_draft",
  "cash", "card", "netbanking", "home_loan_disbursement", "adjustment",
] as const;

function inr(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const paise = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${new Intl.NumberFormat("en-IN").format(whole)}.${paise}`;
}

export function ReceivablesPanel(props: {
  bookingId: string;
  buyerLanguage: string;
  demands: readonly DemandView[];
  receipts: readonly ReceiptView[];
  ladder: readonly LadderStep[];
  canRaise: boolean;
  canIssue: boolean;
  canRecordReceipt: boolean;
  canAllocate: boolean;
  raise: (
    input: unknown,
  ) => Promise<Result<{ id: string; noticeNumber: string; rateFlagged: boolean; rateMessage: string }>>;
  preview: (
    input: unknown,
  ) => Promise<Result<{ subject: string; body: string; wordsFellBack: boolean; wordsLanguage: string }>>;
  serve: (
    input: unknown,
  ) => Promise<
    Result<{ id: string; documents: Array<{ language: string; subject: string; wordsFellBack: boolean }> }>
  >;
  withdraw: (input: unknown) => Promise<Result<{ id: string }>>;
  replace: (input: unknown) => Promise<Result<{ id: string }>>;
  history: (demandId: string) => Promise<Result<NoticeService[]>>;
  record: (
    input: unknown,
  ) => Promise<
    Result<{
      id: string;
      receiptNumber: string;
      allocatedMinor: string;
      creditMinor: string;
      narrative: string[];
    }>
  >;
  bounce: (input: unknown) => Promise<Result<{ id: string; releasedMinor: string }>>;
  reapply: (input: unknown) => Promise<Result<{ id: string; narrative: string[] }>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section aria-labelledby="receivables-heading" className="space-y-4">
      <h2 id="receivables-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Scale className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        Receivables
      </h2>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/30">
          {notice}
        </p>
      )}

      {/* ── THE LADDER ────────────────────────────────────────────── */}
      {props.ladder.length > 0 && (
        <div className="rounded-md border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What happens next, and when
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {props.ladder.map((step) => (
              <li key={`${step.stage}-${step.dueOn}`} className="flex flex-wrap gap-2">
                <span className="font-medium">{step.stage}</span>
                <span className="text-muted-foreground">on {step.dueOn}</span>
                {/*
                  ⚠️ AUTOMATIC vs MANUAL IS THE FACT THAT MATTERS. A step
                  the sweep will take on its own is a letter that leaves
                  the building without anybody reading it that morning.
                */}
                <span className="text-xs text-muted-foreground">
                  {step.automatic ? "sent automatically" : "needs somebody to send it"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── DEMANDS ───────────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Demands</h3>
        {props.demands.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Nothing has been demanded against this booking yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {props.demands.map((demand) => (
              <DemandRow
                key={demand.id}
                demand={demand}
                buyerLanguage={props.buyerLanguage}
                canIssue={props.canIssue}
                pending={pending}
                preview={props.preview}
                serve={props.serve}
                withdraw={props.withdraw}
                replace={props.replace}
                history={props.history}
                onError={setError}
                onNotice={setNotice}
                start={startTransition}
              />
            ))}
          </ul>
        )}
      </div>

      {props.canRaise && (
        <RaiseDemand
          bookingId={props.bookingId}
          buyerLanguage={props.buyerLanguage}
          raise={props.raise}
          pending={pending}
          start={startTransition}
          onError={setError}
          onNotice={setNotice}
        />
      )}

      {/* ── RECEIPTS ──────────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Receipts</h3>
        {props.receipts.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No money recorded against this booking yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {props.receipts.map((receipt) => (
              <ReceiptRow
                key={receipt.id}
                receipt={receipt}
                canAllocate={props.canAllocate}
                canBounce={props.canRecordReceipt}
                pending={pending}
                bounce={props.bounce}
                reapply={props.reapply}
                onError={setError}
                onNotice={setNotice}
                start={startTransition}
              />
            ))}
          </ul>
        )}
      </div>

      {props.canRecordReceipt && (
        <RecordReceipt
          bookingId={props.bookingId}
          record={props.record}
          pending={pending}
          start={startTransition}
          onError={setError}
          onNotice={setNotice}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* ONE DEMAND                                                          */
/* ------------------------------------------------------------------ */

function DemandRow(props: {
  demand: DemandView;
  buyerLanguage: string;
  canIssue: boolean;
  pending: boolean;
  preview: (input: unknown) => Promise<Result<{ subject: string; body: string; wordsFellBack: boolean; wordsLanguage: string }>>;
  serve: (input: unknown) => Promise<Result<{ id: string; documents: Array<{ language: string; subject: string; wordsFellBack: boolean }> }>>;
  withdraw: (input: unknown) => Promise<Result<{ id: string }>>;
  replace: (input: unknown) => Promise<Result<{ id: string }>>;
  history: (demandId: string) => Promise<Result<NoticeService[]>>;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  start: (fn: () => void) => void;
}) {
  const { demand } = props;
  const [draft, setDraft] = useState<{ subject: string; body: string; wordsFellBack: boolean } | null>(null);
  const [events, setEvents] = useState<NoticeService[] | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [showWithdraw, setShowWithdraw] = useState(false);

  function preview() {
    props.onError(null);
    props.start(async () => {
      const result = await props.preview({
        demandId: demand.id,
        language: props.buyerLanguage,
      });
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      setDraft(result.data);
    });
  }

  function serve() {
    props.onError(null);
    props.onNotice(null);
    props.start(async () => {
      const result = await props.serve({ demandId: demand.id });
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      const languages = result.data.documents.map((d) => d.language).join(", ");
      const fellBack = result.data.documents.some((d) => d.wordsFellBack);
      props.onNotice(
        `Notice ${demand.noticeNumber} served in ${languages}.` +
          (fellBack
            ? " ⚠️ The amount in words fell back to English in at least one language, because the " +
              "number-to-words rendering for it is not complete. Read it before it is relied on."
            : ""),
      );
    });
  }

  function loadHistory() {
    props.onError(null);
    props.start(async () => {
      const result = await props.history(demand.id);
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      setEvents(result.data);
    });
  }

  function withdraw() {
    props.onError(null);
    props.start(async () => {
      const result = await props.withdraw({ demandId: demand.id, reason: withdrawReason.trim() });
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      props.onNotice(`Notice ${demand.noticeNumber} withdrawn.`);
      setShowWithdraw(false);
      setWithdrawReason("");
    });
  }

  const outstanding = BigInt(demand.totalMinor) - BigInt(demand.allocatedMinor);

  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{demand.noticeNumber}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{demand.status}</span>
        <span className="text-xs text-muted-foreground">
          {demand.triggerLabel} · due {demand.dueDate}
        </span>
        <span className="ml-auto tabular-nums">
          {inr(demand.totalMinor)}
          {outstanding > 0n && (
            <span className="ml-1 text-xs text-muted-foreground">
              ({inr(outstanding.toString())} outstanding)
            </span>
          )}
        </span>
      </div>

      {/*
        🔴 THE RATE FLAG IS NOT DECORATION. An interest rate above the
        reference rate is the single most common ground on which a demand
        notice is set aside, and it is set aside in full , not reduced to
        the permitted rate.
      */}
      {demand.rateExceedsReference && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          The interest on this demand exceeds the reference rate. A notice on those terms is
          routinely set aside in full rather than reduced.
        </p>
      )}

      <div className="flex flex-wrap gap-3 text-xs">
        <button type="button" onClick={preview} disabled={props.pending} className="inline-flex items-center gap-1 underline underline-offset-2 disabled:opacity-60">
          <Eye className="h-3 w-3" aria-hidden="true" />
          preview the notice
        </button>
        <button type="button" onClick={loadHistory} disabled={props.pending} className="underline underline-offset-2 disabled:opacity-60">
          service history
        </button>
        {props.canIssue && demand.status !== "withdrawn" && (
          <>
            <button type="button" onClick={serve} disabled={props.pending} className="inline-flex items-center gap-1 underline underline-offset-2 disabled:opacity-60">
              <Send className="h-3 w-3" aria-hidden="true" />
              serve it
            </button>
            <button type="button" onClick={() => setShowWithdraw((v) => !v)} className="text-destructive underline underline-offset-2">
              withdraw
            </button>
          </>
        )}
      </div>

      {showWithdraw && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={withdrawReason}
            onChange={(e) => setWithdrawReason(e.target.value)}
            placeholder="Why is this being withdrawn?"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            onClick={withdraw}
            disabled={props.pending || withdrawReason.trim().length < 5}
            className="rounded-md border border-input px-2 py-1.5 text-xs disabled:opacity-60"
          >
            Withdraw
          </button>
        </div>
      )}

      {draft && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-3">
          <p className="text-xs font-semibold">{draft.subject}</p>
          {draft.wordsFellBack && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              The amount in words fell back to English. Read it before serving.
            </p>
          )}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{draft.body}</pre>
        </div>
      )}

      {events && (
        <ul className="space-y-1 rounded-md border bg-muted/20 p-3 text-xs">
          {events.length === 0 && <li className="text-muted-foreground">Never served.</li>}
          {events.map((event) => (
            <li key={event.eventId}>
              <span className="font-medium">{event.stage}</span> , {event.evidenceLabel} (
              <span className="font-mono">{event.evidenceWord}</span>)
              {event.servedAt ? ` on ${event.servedAt}` : ""}
              <span className="block text-muted-foreground">{event.meaning}</span>
              {event.serviceBasis && (
                <span className="block text-muted-foreground">Basis: {event.serviceBasis}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* RAISING ONE                                                         */
/* ------------------------------------------------------------------ */

function RaiseDemand(props: {
  bookingId: string;
  buyerLanguage: string;
  raise: (input: unknown) => Promise<Result<{ id: string; noticeNumber: string; rateFlagged: boolean; rateMessage: string }>>;
  pending: boolean;
  start: (fn: () => void) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [milestoneId, setMilestoneId] = useState("");
  const [triggerKind, setTriggerKind] = useState<string>("construction_event");
  const [triggerLabel, setTriggerLabel] = useState("");
  const [triggerAchievedOn, setTriggerAchievedOn] = useState("");
  const [triggerEvidence, setTriggerEvidence] = useState("");
  const [noticeDate, setNoticeDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [taxKind, setTaxKind] = useState<string>("cgst_sgst");
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [language, setLanguage] = useState(props.buyerLanguage || "en");

  function submit() {
    props.onError(null);
    props.onNotice(null);
    props.start(async () => {
      const result = await props.raise({
        bookingId: props.bookingId,
        milestoneId,
        triggerKind,
        triggerLabel,
        triggerAchievedOn,
        triggerEvidence: triggerEvidence.trim() === "" ? null : triggerEvidence.trim(),
        noticeDate,
        ...(dueDate === "" ? {} : { dueDate }),
        language,
        taxKind,
        placeOfSupplyCode: placeOfSupply,
      });
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      props.onNotice(
        `Demand ${result.data.noticeNumber} raised.` +
          (result.data.rateFlagged ? ` ⚠️ ${result.data.rateMessage}` : ""),
      );
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium"
      >
        Raise a demand
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <h3 className="text-sm font-semibold">Raise a demand</h3>
      <p className="text-sm text-muted-foreground">
        A demand is computed against one stage of the payment plan and the event that made it
        fall due. It is drafted here and served separately , nothing leaves the building
        until somebody serves it.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Milestone id</span>
          <input
            value={milestoneId}
            onChange={(e) => setMilestoneId(e.target.value.trim())}
            placeholder="The stage this demand is for"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">What made it fall due</span>
          <select
            value={triggerKind}
            onChange={(e) => setTriggerKind(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {TRIGGER_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Name the event</span>
          <input
            value={triggerLabel}
            onChange={(e) => setTriggerLabel(e.target.value)}
            placeholder="On completion of the 3rd slab"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <span className="block text-xs text-muted-foreground">
            This sentence appears on the notice. It is what the buyer, and later a forum, reads
            as the reason the money fell due.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Achieved on</span>
          <input
            type="date"
            value={triggerAchievedOn}
            onChange={(e) => setTriggerAchievedOn(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Notice date</span>
          <input
            type="date"
            value={noticeDate}
            onChange={(e) => setNoticeDate(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Due date</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <span className="block text-xs text-muted-foreground">
            Leave empty to use the policy&rsquo;s own demand period.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">GST treatment</span>
          <select
            value={taxKind}
            onChange={(e) => setTaxKind(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {TAX_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Place of supply</span>
          <input
            value={placeOfSupply}
            onChange={(e) => setPlaceOfSupply(e.target.value.replace(/\D/g, "").slice(0, 2))}
            placeholder="29"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          />
          <span className="block text-xs text-muted-foreground">
            The two-digit state code. For immovable property it is where the property is, not
            where the buyer lives.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Notice language</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={
            props.pending ||
            milestoneId === "" ||
            triggerLabel.trim() === "" ||
            triggerAchievedOn === "" ||
            noticeDate === "" ||
            placeOfSupply.length !== 2
          }
          className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {props.pending ? "Working…" : "Raise it"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ONE RECEIPT                                                         */
/* ------------------------------------------------------------------ */

function ReceiptRow(props: {
  receipt: ReceiptView;
  canAllocate: boolean;
  canBounce: boolean;
  pending: boolean;
  bounce: (input: unknown) => Promise<Result<{ id: string; releasedMinor: string }>>;
  reapply: (input: unknown) => Promise<Result<{ id: string; narrative: string[] }>>;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  start: (fn: () => void) => void;
}) {
  const { receipt } = props;
  const [showBounce, setShowBounce] = useState(false);
  const [bouncedOn, setBouncedOn] = useState("");
  const [bounceReason, setBounceReason] = useState("");
  const [showReapply, setShowReapply] = useState(false);
  const [reapplyReason, setReapplyReason] = useState("");

  function bounce() {
    props.onError(null);
    props.start(async () => {
      const result = await props.bounce({
        receiptId: receipt.id,
        bouncedOn,
        reason: bounceReason.trim(),
      });
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      props.onNotice(
        `Receipt ${receipt.receiptNumber} bounced. ${inr(result.data.releasedMinor)} released back to the demands it had been applied to.`,
      );
      setShowBounce(false);
    });
  }

  function reapply() {
    props.onError(null);
    props.start(async () => {
      const result = await props.reapply({
        receiptId: receipt.id,
        strategy: "oldest_first",
        reason: reapplyReason.trim(),
      });
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      props.onNotice(result.data.narrative.join(" "));
      setShowReapply(false);
    });
  }

  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{receipt.receiptNumber}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{receipt.status}</span>
        <span className="text-xs text-muted-foreground">received {receipt.receivedOn}</span>
        <span className="ml-auto tabular-nums">{inr(receipt.amountMinor)}</span>
      </div>

      {receipt.allocations.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {receipt.allocations.map((allocation, i) => (
            <li key={`${allocation.noticeNumber}-${i}`}>
              {allocation.noticeNumber}: {inr(allocation.amountMinor)} , {allocation.explanation}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-3 text-xs">
        {props.canBounce && receipt.status !== "bounced" && (
          <button type="button" onClick={() => setShowBounce((v) => !v)} className="text-destructive underline underline-offset-2">
            it bounced
          </button>
        )}
        {props.canAllocate && receipt.status !== "bounced" && (
          <button type="button" onClick={() => setShowReapply((v) => !v)} className="underline underline-offset-2">
            re-appropriate
          </button>
        )}
      </div>

      {showBounce && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={bouncedOn}
            onChange={(e) => setBouncedOn(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <input
            value={bounceReason}
            onChange={(e) => setBounceReason(e.target.value)}
            placeholder="What the bank said"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            onClick={bounce}
            disabled={props.pending || bouncedOn === "" || bounceReason.trim().length < 3}
            className="rounded-md border border-input px-2 py-1.5 text-xs disabled:opacity-60"
          >
            Record the bounce
          </button>
        </div>
      )}

      {showReapply && (
        <div className="space-y-2">
          {/*
            ⚠️ RE-APPROPRIATION CHANGES WHAT THE BUYER HAS ALREADY BEEN
            TOLD ABOUT THEIR OWN PAYMENT. Under Section 59 of the Contract
            Act their direction binds us, so moving money away from where
            they asked it to go needs a reason on the record.
          */}
          <input
            value={reapplyReason}
            onChange={(e) => setReapplyReason(e.target.value)}
            placeholder="Why is the money being moved?"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            onClick={reapply}
            disabled={props.pending || reapplyReason.trim().length < 5}
            className="rounded-md border border-input px-2 py-1.5 text-xs disabled:opacity-60"
          >
            Re-appropriate oldest first
          </button>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* RECORDING MONEY                                                     */
/* ------------------------------------------------------------------ */

function RecordReceipt(props: {
  bookingId: string;
  record: (input: unknown) => Promise<Result<{ id: string; receiptNumber: string; allocatedMinor: string; creditMinor: string; narrative: string[] }>>;
  pending: boolean;
  start: (fn: () => void) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [receivedOn, setReceivedOn] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("neft");
  const [instrumentRef, setInstrumentRef] = useState("");
  const [tdsCredit, setTdsCredit] = useState("");

  function submit() {
    props.onError(null);
    props.onNotice(null);
    props.start(async () => {
      const result = await props.record({
        bookingId: props.bookingId,
        receivedOn,
        amountMinor: amount,
        ...(tdsCredit.trim() === "" ? {} : { tdsCreditMinor: tdsCredit.trim() }),
        method,
        instrumentRef: instrumentRef.trim() === "" ? null : instrumentRef.trim(),
        /**
         * ⚠️ OLDEST FIRST UNLESS THE BUYER SAID OTHERWISE. Under Section
         * 59 a buyer's direction binds us, and recording a specific
         * appropriation needs the instructions this simple form does not
         * collect. Defaulting to oldest-first and saying so is honest;
         * silently choosing it would not be.
         */
        strategy: "oldest_first",
      });
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      props.onNotice(
        `Receipt ${result.data.receiptNumber}: ${inr(result.data.allocatedMinor)} applied` +
          (BigInt(result.data.creditMinor) > 0n
            ? `, ${inr(result.data.creditMinor)} held as credit.`
            : ".") +
          ` ${result.data.narrative.join(" ")}`,
      );
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm font-medium"
      >
        <IndianRupee className="h-4 w-4" aria-hidden="true" />
        Record money received
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <h3 className="text-sm font-semibold">Record money received</h3>
      <p className="text-sm text-muted-foreground">
        Applied to the oldest outstanding demand first. Anything left over is held as a credit
        against this buyer rather than being applied to a demand that has not been raised.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Received on</span>
          <input
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Amount (paise)</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="500000 = ₹5,000.00"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">How</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {RECEIPT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Reference</span>
          <input
            value={instrumentRef}
            onChange={(e) => setInstrumentRef(e.target.value)}
            placeholder="UTR or cheque number"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">TDS deducted by the buyer (paise)</span>
          <input
            value={tdsCredit}
            onChange={(e) => setTdsCredit(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm sm:w-72"
          />
          <span className="block text-xs text-muted-foreground">
            Section 194-IA: a buyer paying over ₹50 lakh deducts 1% and pays it to the
            government. That money never reaches the bank account and the demand is still
            satisfied by it.
          </span>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={props.pending || receivedOn === "" || amount === ""}
          className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {props.pending ? "Recording…" : "Record it"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2 text-sm underline underline-offset-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
