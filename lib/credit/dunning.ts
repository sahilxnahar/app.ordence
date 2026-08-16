/**
 * Ordence — ⭐⭐ THE DUNNING LADDER
 * Version: v1.46.0-alpha (Batch 40)
 *
 * Pure. `bigint` paise, ISO date strings, and NO CLOCK — `asOf` is
 * always an argument. A collections schedule that reads `new Date()`
 * inside itself cannot be tested for the day it gets wrong, and the day
 * it gets wrong is the one where somebody is chased three stages at once.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS FILE PLANS. IT DOES NOT SEND. NOTHING IN BATCH 40 SENDS.
 * ══════════════════════════════════════════════════════════════════════
 * `planDunning()` returns a list of rows to WRITE into
 * `credit_dunning_log` with `delivery: "queued"`. There is no SMTP call,
 * no Resend call, no webhook, and no scheduler. `server/actions/credit
 * .ts#runDunningSweep` writes the queue rows and stops.
 *
 * ⚠️ THE ALTERNATIVE — recording `sent` at queue time because the row is
 * "about to" go out — is the specific trap this design exists to avoid.
 * It produces a customer record saying a reminder went out on the 14th,
 * a customer who never received it, and a collections call that opens
 * with "we have written to you three times" against somebody who can
 * prove otherwise. Whatever eventually delivers these rows writes `sent`
 * or `failed` back; until something does, the honest state is `queued`
 * and the board says so in those words.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IDEMPOTENCY: A STAGE THAT HAS BEEN RECORDED IS NEVER RECORDED AGAIN
 * ══════════════════════════════════════════════════════════════════════
 * The sweep is meant to be run daily, by hand, twice by accident, and
 * again after a crash halfway through. Three things make that safe, and
 * they are deliberately not the same mechanism:
 *
 *   ① `alreadyRecorded` below — a set of `${invoiceId}:${stageId}` keys
 *      loaded before planning. This is what produces a plan a human can
 *      read, with the skipped stages named.
 *   ② `credit_dunning_log_once_per_stage_key`, a UNIQUE INDEX on
 *      (tenant_id, invoice_id, stage_id). This is the actual guarantee.
 *      ① is a read-then-write and two containers can both pass it in the
 *      same millisecond; the index cannot be raced.
 *   ③ `ON CONFLICT DO NOTHING` at the insert, so ② produces a quiet
 *      no-op rather than an exception that aborts the rest of the sweep.
 *      A sweep that dies on invoice 40 of 300 because another container
 *      got there first is a sweep that never finishes.
 *
 * ⚠️ ① ALONE WOULD LOOK LIKE IT WORKED. It passes every single-process
 * test. The failure needs two workers and a customer who then receives
 * the same demanding letter twice, which is the most reliable way there
 * is to turn a late payer into an angry one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ONE RUNG PER INVOICE PER RUN, AND IT IS THE HIGHEST DUE ONE
 * ══════════════════════════════════════════════════════════════════════
 * An invoice that is 95 days past due when the ladder is first
 * configured qualifies for stages 1, 2, 3 and 4 simultaneously. Firing
 * all four sends a customer four escalating letters in one morning,
 * ending with a legal-notice tone, about a debt nobody had mentioned to
 * them before breakfast.
 *
 * ⭐ SO THE PLANNER PICKS THE HIGHEST STAGE WHOSE AGE HAS PASSED and
 * marks the lower ones as `superseded` rather than sending them. They
 * are still written to the log — as `suppressed`, with the reason —
 * because "we skipped stages 1 to 3" is a fact a collections team needs
 * to be able to see, and because leaving them unrecorded means the next
 * run would consider them again forever.
 */

/* ------------------------------------------------------------------ */
/* DATES                                                               */
/* ------------------------------------------------------------------ */

/**
 * Whole days between two ISO calendar dates, `to − from`.
 *
 * ⚠️ `Date.UTC` ON THE PARTS, NEVER `new Date(iso)`. Both arguments are
 * calendar dates with no time in them; parsing "2026-08-15" as an
 * instant makes it midnight UTC, and subtracting two of those is correct
 * only by accident. The caller supplies `asOf` from `todayInIndia()`, so
 * the timezone question has already been answered before this function
 * sees anything.
 */
export function daysBetween(fromIso: string, toIso: string): number {
  const parse = (iso: string): number => {
    const [y, m, d] = iso.split("-").map((p) => Number.parseInt(p, 10));
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((parse(toIso) - parse(fromIso)) / 86_400_000);
}

/** `fromIso` plus `days`, as an ISO calendar date. */
export function addDays(fromIso: string, days: number): string {
  const [y, m, d] = fromIso.split("-").map((p) => Number.parseInt(p, 10));
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* THE FACTS                                                           */
/* ------------------------------------------------------------------ */

export type DunningChannel = "email" | "sms" | "whatsapp" | "call" | "letter" | "visit";

export type DunningStageFact = {
  id: string;
  stageNo: number;
  label: string;
  /**
   * 🔴 AGE PAST THE DUE DATE, NOT PAST THE INVOICE DATE. An invoice dated
   * the 1st on 30-day terms is not one day overdue on the 2nd. Counting
   * from the invoice date puts "you are overdue" in front of somebody
   * who is inside their agreed terms, which is the fastest way to make a
   * good payer stop answering the phone.
   */
  daysPastDue: number;
  channel: DunningChannel;
  templateKey: string | null;
  /** Reaching this rung places an `automatic` hold. */
  placesHold: boolean;
};

export type DunningInvoiceFact = {
  id: string;
  invoiceNumber: string;
  companyId: string;
  companyName: string;
  /**
   * ⚠️ NULLABLE, AND A NULL DUE DATE IS NOT DUNNED. `sales_invoices
   * .due_date` is nullable, and an invoice with no agreed due date has
   * no age past due — inventing one from the invoice date plus a guessed
   * term is how a customer on 90-day government terms gets a final
   * notice on day 31.
   */
  dueDate: string | null;
  /** Paise, outstanding. */
  outstandingMinor: bigint;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
};

export type DunningAction = {
  invoiceId: string;
  invoiceNumber: string;
  companyId: string;
  companyName: string;
  stageId: string;
  stageNo: number;
  stageLabel: string;
  channel: DunningChannel;
  templateKey: string | null;
  /** The invoice's real age on `asOf`, not the stage's threshold. */
  daysPastDue: number;
  amountDueMinor: bigint;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  /**
   * 🔴 `queued` for the rung actually being actioned; `suppressed` for
   * the lower rungs it overtook. See the header — both are written, and
   * neither is `sent`.
   */
  delivery: "queued" | "suppressed";
  suppressionReason: string | null;
  /** Whether this rung places an automatic hold. */
  placesHold: boolean;
  /**
   * The date the NEXT rung falls due, computed from the invoice's due
   * date and that rung's age. NULL when this was the last rung.
   */
  nextActionOn: string | null;
};

export type DunningSkip = {
  invoiceId: string;
  invoiceNumber: string;
  /** A sentence, for the board. Never an error. */
  why: string;
};

export type DunningPlan = {
  asOf: string;
  actions: DunningAction[];
  skipped: DunningSkip[];
};

/* ------------------------------------------------------------------ */
/* THE PLANNER                                                         */
/* ------------------------------------------------------------------ */

/** The idempotency key. Mirrors the unique index in 0083 exactly. */
export function dunningKey(invoiceId: string, stageId: string): string {
  return `${invoiceId}:${stageId}`;
}

/**
 * ⭐ WORK OUT WHAT TO RECORD TODAY.
 *
 * ⚠️ `alreadyRecorded` IS A SET OF `dunningKey()` VALUES, loaded from
 * `credit_dunning_log` before planning. It is the readable half of the
 * idempotency story; the unique index is the enforcing half. See the
 * header — both are needed and neither is sufficient.
 *
 * ⚠️ A CHANNEL WITH NO ADDRESS IS SKIPPED WITH A SENTENCE, NEVER QUEUED.
 * The database refuses an `email` row with no `recipient_email` (a CHECK
 * constraint in 0083), and hitting that constraint would abort the whole
 * sweep for one customer with no contact on file. Refusing it here
 * produces a work item — "no e-mail address on the account" — which is
 * the actual problem.
 */
export function planDunning(args: {
  /** ISO date. From `todayInIndia()` at the caller. Never `new Date()` here. */
  asOf: string;
  invoices: readonly DunningInvoiceFact[];
  stages: readonly DunningStageFact[];
  alreadyRecorded: ReadonlySet<string>;
}): DunningPlan {
  const { asOf, invoices, alreadyRecorded } = args;

  /** Gentlest first. The ladder's order is `daysPastDue`, not `stageNo`. */
  const stages = [...args.stages].sort((a, b) => a.daysPastDue - b.daysPastDue);

  const actions: DunningAction[] = [];
  const skipped: DunningSkip[] = [];

  if (stages.length === 0) {
    for (const inv of invoices) {
      skipped.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        why: "No dunning ladder is configured, so nobody is being chased. A ladder shipped by us would be the schedule most workspaces chase on, chosen by nobody.",
      });
    }
    return { asOf, actions, skipped };
  }

  for (const inv of invoices) {
    if (!inv.dueDate) {
      skipped.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        why: "No due date on the invoice, so it has no age past due. Set the payment terms rather than guessing them.",
      });
      continue;
    }

    if (inv.outstandingMinor <= 0n) {
      skipped.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        why: "Nothing outstanding.",
      });
      continue;
    }

    const age = daysBetween(inv.dueDate, asOf);

    /**
     * ⚠️ `age < 0` IS "NOT YET DUE" AND IS NOT AN ERROR. It is the state
     * every invoice is in for most of its life, and the sweep runs over
     * all of them.
     */
    const dueStages = stages.filter(
      (s) => age >= s.daysPastDue && !alreadyRecorded.has(dunningKey(inv.id, s.id)),
    );

    if (dueStages.length === 0) {
      continue;
    }

    /** 🔴 THE HIGHEST DUE RUNG. See the header. */
    const fire = dueStages[dueStages.length - 1]!;
    const superseded = dueStages.slice(0, -1);

    const addressMissing =
      (fire.channel === "email" && !inv.recipientEmail) ||
      ((fire.channel === "sms" || fire.channel === "whatsapp") && !inv.recipientPhone);

    if (addressMissing) {
      skipped.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        why: `Stage ${fire.stageNo} (${fire.label}) goes out by ${fire.channel} and this customer has no ${
          fire.channel === "email" ? "e-mail address" : "phone number"
        } on file. Nothing has been recorded, because a log row saying we wrote to somebody we could not write to is worse than no row.`,
      });
      continue;
    }

    /**
     * ⭐ THE NEXT-ACTION DATE, FROM THE DUE DATE AND THE NEXT RUNG'S AGE.
     * Not "today plus seven": a diary that reshuffles itself every time
     * somebody edits the ladder is a diary nobody works from.
     */
    const next = stages.find((s) => s.daysPastDue > fire.daysPastDue);
    const nextActionOn = next ? addDays(inv.dueDate, next.daysPastDue) : null;

    for (const s of superseded) {
      actions.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        companyId: inv.companyId,
        companyName: inv.companyName,
        stageId: s.id,
        stageNo: s.stageNo,
        stageLabel: s.label,
        channel: s.channel,
        templateKey: s.templateKey,
        daysPastDue: age,
        amountDueMinor: inv.outstandingMinor,
        recipientName: inv.recipientName,
        recipientEmail: inv.recipientEmail,
        recipientPhone: inv.recipientPhone,
        delivery: "suppressed",
        suppressionReason: `Overtaken — the invoice is ${age} days past due and stage ${fire.stageNo} applies. Sending stages ${s.stageNo} and ${fire.stageNo} on one morning reads as four escalating letters about a debt nobody had mentioned.`,
        /**
         * ⚠️ A SUPPRESSED RUNG NEVER PLACES A HOLD, whatever the stage
         * says. The hold belongs to the rung that was actually actioned;
         * placing one from a rung we deliberately did not send would
         * refuse a customer on the strength of a letter they never got.
         */
        placesHold: false,
        nextActionOn,
      });
    }

    actions.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      companyId: inv.companyId,
      companyName: inv.companyName,
      stageId: fire.id,
      stageNo: fire.stageNo,
      stageLabel: fire.label,
      channel: fire.channel,
      templateKey: fire.templateKey,
      daysPastDue: age,
      amountDueMinor: inv.outstandingMinor,
      recipientName: inv.recipientName,
      recipientEmail: inv.recipientEmail,
      recipientPhone: inv.recipientPhone,
      delivery: "queued",
      suppressionReason: null,
      placesHold: fire.placesHold,
      nextActionOn,
    });
  }

  return { asOf, actions, skipped };
}

/**
 * The one-line summary the board prints after a sweep.
 *
 * ⚠️ IT SAYS "QUEUED", NEVER "SENT". Decision ⑥ of 0083 is not a
 * database decision — it is a decision about what the product is allowed
 * to claim, and the claim is made in this sentence.
 */
export function describeSweep(plan: DunningPlan): string {
  const queued = plan.actions.filter((a) => a.delivery === "queued").length;
  const suppressed = plan.actions.length - queued;
  const holds = plan.actions.filter((a) => a.delivery === "queued" && a.placesHold).length;

  const parts = [
    `${queued} reminder${queued === 1 ? "" : "s"} queued as at ${plan.asOf}`,
  ];
  if (suppressed > 0) parts.push(`${suppressed} earlier stage${suppressed === 1 ? "" : "s"} recorded as overtaken`);
  if (holds > 0) parts.push(`${holds} account${holds === 1 ? "" : "s"} put on hold by the ladder`);
  if (plan.skipped.length > 0) parts.push(`${plan.skipped.length} invoice${plan.skipped.length === 1 ? "" : "s"} skipped`);

  return `${parts.join(", ")}. Nothing has been sent — these are queued records waiting on a delivery channel.`;
}
