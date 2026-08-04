/**
 * Ordence — Background Jobs (Cloudflare Queues)
 * Version: v0.21.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT REPLACED WHAT, AND WHY IT HAD TO
 * ══════════════════════════════════════════════════════════════════════════
 * This module replaces `lib/queue/bullmq.ts`. The job definitions, the tenant
 * guard and the processors are unchanged; only the transport moved.
 *
 * BullMQ needs a process that stays alive holding an open TCP connection to
 * Redis, blocking on BRPOPLPUSH. A Cloudflare Worker is neither: it has no
 * long-lived process and cannot open a raw TCP socket to Upstash at all. The
 * old file's own header said this was irreconcilable on Vercel; on Workers it
 * is not merely awkward, it is impossible. `ioredis` and `bullmq` are gone
 * from package.json entirely.
 *
 * Cloudflare Queues provides what BullMQ provided:
 *
 *   BullMQ                          Cloudflare Queues
 *   ──────────────────────────────  ──────────────────────────────────────
 *   queue.add()                     env.JOB_QUEUE.send()
 *   Worker(queue, processor)        queue() handler in worker.ts
 *   attempts: 3, exponential        max_retries + platform backoff
 *   dead-letter queue               dead_letter_queue in wrangler.jsonc
 *   removeOnComplete/Fail           automatic (messages are acked or retried)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ THE FALLBACK, STATED PLAINLY
 * ══════════════════════════════════════════════════════════════════════════
 * The queue binding is deliberately optional so a first deploy works before
 * the queue exists. When it is absent, `enqueueJob()` does ONE of two things
 * depending on `ORDENCE_INLINE_JOBS`:
 *
 *   "1"  Run the processor SYNCHRONOUSLY, inside the caller's request. The
 *        user waits for it. The result says `via: "inline"`, so the caller
 *        knows the work is already finished rather than pending.
 *
 *   "0"  Refuse. `{queued:false, reason:"queue_unavailable"}`.
 *
 * There is NO third branch that returns success without doing anything. A
 * queue that silently swallows jobs is the failure mode this whole file is
 * written to make impossible: every path either does the work, or tells the
 * caller it did not.
 *
 * Inline execution is viable here only because the volumes are low and the
 * Workers Paid plan allows up to 5 minutes of CPU per request (Vercel Hobby
 * allowed 10 seconds, which is why this was never an option before). It is
 * still a degradation — see docs/CLOUDFLARE-DEPLOY.md.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

/* ------------------------------------------------------------------ */
/* JOB DEFINITIONS                                                     */
/* ------------------------------------------------------------------ */

/**
 * Logical queue names.
 *
 * ⚠️ These are no longer Redis key namespaces — Cloudflare Queues routes by
 * BINDING, and there is one binding (`JOB_QUEUE`). They survive as labels:
 * every enqueue and every processed job is logged with one, so queue
 * behaviour stays attributable per subsystem, and splitting into three real
 * queues later is a wrangler.jsonc change rather than a code change.
 */
export const QUEUE_NAMES = {
  documents: "ordence:documents",
  accounting: "ordence:accounting",
  notifications: "ordence:notifications",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Every job payload must carry the tenant. No exceptions. */
export type BaseJobData = {
  tenantId: string;
  /** User who initiated the job, for audit attribution. */
  requestedByUserId?: string;
  /** Correlates worker logs with the originating request. */
  correlationId?: string;
};

export type GeneratePdfJob = BaseJobData & {
  kind: "generate_pdf";
  contractId: string;
  versionNumber?: number;
  /** Where the rendered file should be stored. */
  outputKey: string;
  options?: {
    includeWatermark?: boolean;
    watermarkText?: string;
    pageSize?: "A4" | "Letter";
  };
};

export type AssembleDocumentJob = BaseJobData & {
  kind: "assemble_document";
  contractId: string;
  templateId?: string;
  mergeSourceType?: "asset" | "contact" | "company" | "deal";
  mergeSourceId?: string;
};

export type LedgerAggregationJob = BaseJobData & {
  kind: "ledger_aggregation";
  ledgerId?: string;
  fromDate: string;
  toDate: string;
  /** What to produce: trial balance, statement, reconciliation report. */
  reportType: "trial_balance" | "ledger_statement" | "reconciliation";
};

export type ContractExpiryScanJob = BaseJobData & {
  kind: "contract_expiry_scan";
  lookaheadDays: number;
};

export type JobData =
  | GeneratePdfJob
  | AssembleDocumentJob
  | LedgerAggregationJob
  | ContractExpiryScanJob;

export type JobKind = JobData["kind"];

/** Which logical queue each job kind belongs to. */
export const QUEUE_FOR_KIND: Record<JobKind, QueueName> = {
  generate_pdf: QUEUE_NAMES.documents,
  assemble_document: QUEUE_NAMES.documents,
  ledger_aggregation: QUEUE_NAMES.accounting,
  contract_expiry_scan: QUEUE_NAMES.notifications,
};

/* ------------------------------------------------------------------ */
/* TRANSPORT                                                           */
/* ------------------------------------------------------------------ */

/** The one method we use on the Queues binding. Narrow by design. */
type JobQueueBinding = { send(message: unknown): Promise<void> };

/**
 * The Cloudflare Queues producer binding, or null.
 *
 * Null in three legitimate situations: the queue has not been created yet,
 * the code is running in a unit test, or it is running during `next build`.
 * All three must degrade rather than crash.
 */
export function getJobQueue(): JobQueueBinding | null {
  try {
    const binding = getCloudflareContext().env.JOB_QUEUE;
    return (binding as unknown as JobQueueBinding | undefined) ?? null;
  } catch {
    return null;
  }
}

/** True when real background processing is available. */
export function isQueueEnabled(): boolean {
  return getJobQueue() !== null;
}

/**
 * ⚠️ THE INLINE FALLBACK SWITCH. Set in wrangler.jsonc under `vars`.
 *
 * Defaults to ENABLED when unset, so a fresh deployment with no queue still
 * performs the work rather than dropping it. Set `ORDENCE_INLINE_JOBS=0` once
 * a real queue is bound.
 */
export function isInlineFallbackEnabled(): boolean {
  // ⚠️ Read through a `string` before comparing. `wrangler types`
  // generates `worker-configuration.d.ts` from the LITERAL value in
  // wrangler.jsonc, so `ORDENCE_INLINE_JOBS` is typed as `"1"` — and
  // TypeScript then rejects `!== "0"` as a comparison between two types
  // with no overlap. The narrowing is an artefact of the generator, not
  // a fact about runtime: at runtime this is whatever the deployment set.
  const raw: string = String(process.env.ORDENCE_INLINE_JOBS ?? "1");
  return raw !== "0";
}

/** Human-readable description of how background work is currently handled. */
export function describeJobTransport(): string {
  if (isQueueEnabled()) return "cloudflare-queue";
  return isInlineFallbackEnabled() ? "inline (no queue bound)" : "disabled (no queue bound)";
}

/* ------------------------------------------------------------------ */
/* ENQUEUE                                                             */
/* ------------------------------------------------------------------ */

export type EnqueueResult =
  /** Accepted by Cloudflare Queues. Will run shortly, in the background. */
  | { queued: true; via: "queue"; jobId: string; queue: QueueName }
  /** Already finished, synchronously, inside this request. */
  | { queued: true; via: "inline"; jobId: string; queue: QueueName }
  /** Did NOT happen. The caller must surface this. */
  | {
      queued: false;
      reason: "queue_unavailable" | "enqueue_failed" | "inline_failed";
      error?: string;
    };

/**
 * Hand a job to the background system.
 *
 * ⚠️ NEVER RETURNS SUCCESS FOR WORK THAT DID NOT HAPPEN. Read the three
 * branches below against that sentence.
 */
export async function enqueueJob(data: JobData): Promise<EnqueueResult> {
  if (!data.tenantId) {
    // Programmer error, not a runtime condition — fail loudly.
    throw new Error("[SECURITY] enqueueJob() requires a tenantId on every job.");
  }

  const queueName = QUEUE_FOR_KIND[data.kind];
  const jobId = `${data.tenantId}:${data.kind}:${crypto.randomUUID()}`;
  const queue = getJobQueue();

  /* --- 1. Real queue ------------------------------------------------ */
  if (queue) {
    try {
      await queue.send({ ...data, jobId, queue: queueName });
      return { queued: true, via: "queue", jobId, queue: queueName };
    } catch (err) {
      console.error("[jobs] enqueue failed:", err);
      return {
        queued: false,
        reason: "enqueue_failed",
        error: err instanceof Error ? err.message : "unknown",
      };
    }
  }

  /* --- 2. No queue, inline fallback disabled ------------------------ */
  if (!isInlineFallbackEnabled()) {
    return { queued: false, reason: "queue_unavailable" };
  }

  /* --- 3. No queue, run it here and now ------------------------------
   *
   * The import is dynamic for two reasons, both load-bearing:
   *
   *   • `processors.ts` imports the job TYPES from this module. A static
   *     import back would be a runtime cycle.
   *   • `processors.ts` pulls in the whole database layer. Loading it lazily
   *     keeps it out of any bundle that only ever ENQUEUES.
   */
  try {
    const { processJob } = await import("./processors");
    const result = await processJob(data);

    if (!result.ok) {
      return {
        queued: false,
        reason: "inline_failed",
        error: result.error ?? "Inline processing failed.",
      };
    }

    return { queued: true, via: "inline", jobId, queue: queueName };
  } catch (err) {
    console.error("[jobs] inline execution threw:", err);
    return {
      queued: false,
      reason: "inline_failed",
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

/* ------------------------------------------------------------------ */
/* TENANT GUARD                                                        */
/* ------------------------------------------------------------------ */

/**
 * Validate that a job carries a usable tenant before any database work.
 *
 * A queue consumer has no HTTP request and no Clerk session. Without this
 * check a malformed job would run with no tenant context — RLS would return
 * nothing, but the application would already have lost its isolation
 * guarantee silently. Better to reject the job loudly.
 *
 * ⚠️ Now matters MORE than it did under BullMQ, not less. A Cloudflare Queue
 * message is JSON that arrived over the network; nothing about the transport
 * proves our own code produced it.
 */
export function assertJobTenant(data: unknown): asserts data is JobData {
  if (!data || typeof data !== "object") {
    throw new Error("[SECURITY] Job payload is not an object.");
  }
  const tenantId = (data as { tenantId?: unknown }).tenantId;
  if (typeof tenantId !== "string" || !isUuid(tenantId)) {
    throw new Error("[SECURITY] Job payload is missing a valid tenantId.");
  }
  const kind = (data as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !(kind in QUEUE_FOR_KIND)) {
    throw new Error(`[SECURITY] Unknown job kind: ${String(kind)}`);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
