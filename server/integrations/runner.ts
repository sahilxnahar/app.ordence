/**
 * Ordence — ⭐⭐⭐ THE RUNNER
 * Version: v1.13.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE RUN ROW IS OPENED BEFORE THE FETCH AND CLOSED AFTER IT
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A run recorded only on completion is a run that leaves no trace
 * when the process dies mid-fetch — which is the exact moment somebody
 * wants to know what happened. A `running` row that never finished says
 * "we started this and did not come back", which is a real answer.
 *
 * ⚠️ AND THE `sync_runs` ROW IS ALSO WHAT ACCOUNTS FOR THE CREDENTIAL
 * READ. `readForRunner` in the vault refuses to hand over a key without
 * a run id, precisely so that no automated decryption happens with
 * nothing anywhere recording it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND 204 IS NOT A FAILURE
 * ══════════════════════════════════════════════════════════════════════
 * IndiaMART answers 204 when nobody enquired. `if (!res.ok) fail()` turns
 * a quiet Sunday into an outage, climbs the backoff, marks the connection
 * degraded and tells the customer their integration is broken because
 * business was slow.
 *
 * ⭐ Worse, it is self-confirming: the quieter the account, the more
 * "failures", so the smallest customers get the loudest false alarms.
 */

import "server-only";

import { and, eq } from "drizzle-orm";
import { connections, syncRuns } from "@/db/schema/integrations";
import { CONNECTION_OWNER_KIND, readForRunner } from "@/server/vault/secrets";
import {
  mayFetchNow,
  nextFetchWindow,
  policyFor,
  type ConnectionSnapshot,
  type SyncOutcome,
} from "@/lib/integrations/policy";
import { assessFailure, DEFAULT_BACKOFF } from "@/lib/integrations/backoff";
import {
  parseIndiamartRecord,
  readIndiamartResponse,
} from "@/lib/integrations/adapters/indiamart";
import { ingestEnquiry } from "./ingest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

const INDIAMART_PULL_URL = "https://mapi.indiamart.com/wservce/crm/crmListing/v2/";

export interface RunReport {
  readonly connectionId: string;
  readonly outcome: SyncOutcome;
  readonly seen: number;
  readonly fresh: number;
  readonly duplicate: number;
  readonly failed: number;
  readonly note: string;
}

/**
 * Fetch once for one connection.
 *
 * `fetchImpl` is injected so the whole path is testable without a
 * network. ⚠️ A runner that can only be exercised against the real
 * IndiaMART is a runner nobody exercises, and its rate limit makes
 * repeated testing a lockout.
 */
export async function runConnection(args: {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly now: Date;
  readonly fetchImpl?: typeof fetch;
}): Promise<RunReport> {
  const { tx, tenantId, connectionId, now } = args;
  const doFetch = args.fetchImpl ?? fetch;

  const [row] = await tx
    .select()
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)))
    .limit(1);

  if (!row) {
    return {
      connectionId,
      outcome: "failed",
      seen: 0,
      fresh: 0,
      duplicate: 0,
      failed: 0,
      note: "No such connection.",
    };
  }

  const snapshot: ConnectionSnapshot = {
    connectorKey: row.connectorKey,
    state: row.state,
    isActive: row.isActive,
    pollEverySeconds: row.pollEverySeconds,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    cursorAt: row.cursorAt,
    lockedUntil: row.lockedUntil,
  };

  // ① May we? The verdict decides the outcome we record, including the
  // ones where we do nothing at all.
  const verdict = mayFetchNow(snapshot, now);
  if (!verdict.mayFetch) {
    if (verdict.outcome) {
      await writeRun(tx, tenantId, connectionId, {
        outcome: verdict.outcome,
        startedAt: now,
        finishedAt: now,
        errorMessage:
          verdict.outcome === "failed" || verdict.outcome === "skipped_too_soon"
            ? verdict.reason
            : verdict.reason,
        // ⚠️ `skipped_*` needs no error, but 0064 requires one for
        // `failed`, so it is always supplied.
        errorCode: verdict.outcome === "failed" ? "not_permitted" : null,
      });
    }
    return {
      connectionId,
      outcome: verdict.outcome ?? "skipped_too_soon",
      seen: 0,
      fresh: 0,
      duplicate: 0,
      failed: 0,
      note: verdict.reason,
    };
  }

  const policy = policyFor(row.connectorKey);
  const window = nextFetchWindow(snapshot, now);

  // ② 🔴 THE RUN ROW IS OPENED FIRST. See the header.
  const runId = await openRun(tx, tenantId, connectionId, now, window.from, window.to);

  // ③ The credential, accounted for by that run.
  const secret = await readForRunner({
    tx,
    tenantId,
    ownerKind: CONNECTION_OWNER_KIND,
    ownerId: connectionId,
    label: "api_key",
    syncRunId: runId,
  });

  if (!secret.ok) {
    await closeRun(tx, runId, {
      outcome: "failed",
      finishedAt: now,
      errorCode: "no_credential",
      errorMessage: secret.error,
    });
    return {
      connectionId,
      outcome: "failed",
      seen: 0,
      fresh: 0,
      duplicate: 0,
      failed: 0,
      note: secret.error,
    };
  }

  // ④ The fetch itself. Only IndiaMART pulls in this release.
  if (row.connectorKey !== "indiamart") {
    await closeRun(tx, runId, {
      outcome: "failed",
      finishedAt: now,
      errorCode: "no_pull",
      errorMessage: `${policy?.label ?? row.connectorKey} sends to us; there is nothing to fetch.`,
    });
    return {
      connectionId,
      outcome: "failed",
      seen: 0,
      fresh: 0,
      duplicate: 0,
      failed: 0,
      note: "This connector does not support polling.",
    };
  }

  let body: unknown = null;
  let httpStatus = 0;
  try {
    const url = new URL(INDIAMART_PULL_URL);
    url.searchParams.set("glusr_crm_key", secret.value);
    url.searchParams.set("start_time", istStamp(window.from));
    url.searchParams.set("end_time", istStamp(window.to));

    const response = await doFetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    httpStatus = response.status;
    body = await response.json().catch(() => null);
  } catch (e) {
    const failure = assessFailure(
      {
        failureClass: "network",
        consecutiveFailures: row.consecutiveFailures + 1,
        message: e instanceof Error ? e.message.slice(0, 200) : "unreachable",
        lastSuccessAt: row.lastSuccessAt,
      },
      now,
      DEFAULT_BACKOFF,
    );
    await closeRun(tx, runId, {
      outcome: "failed",
      finishedAt: now,
      errorCode: "network",
      errorMessage: failure.stateReason.slice(0, 500),
      retryAfter: failure.lockedUntil,
    });
    return {
      connectionId,
      outcome: "failed",
      seen: 0,
      fresh: 0,
      duplicate: 0,
      failed: 0,
      note: failure.stateReason,
    };
  }

  const answer = readIndiamartResponse(body, httpStatus);

  // ⑤ 🔴 THE QUIET DAY. Recorded as a success that saw nothing, which is
  // exactly what it is, and the cursor still moves.
  if (answer.kind === "empty") {
    await closeRun(tx, runId, { outcome: "success", finishedAt: now });
    await advanceCursor(tx, tenantId, connectionId, window.to);
    return {
      connectionId,
      outcome: "success",
      seen: 0,
      fresh: 0,
      duplicate: 0,
      failed: 0,
      note: answer.note,
    };
  }

  if (answer.kind === "error") {
    const failure = assessFailure(
      {
        failureClass: answer.failureClass,
        consecutiveFailures: row.consecutiveFailures + 1,
        message: answer.message,
        errorCode: answer.code,
        lockoutSeconds: policy?.lockoutSeconds,
        lastSuccessAt: row.lastSuccessAt,
      },
      now,
      DEFAULT_BACKOFF,
    );
    await closeRun(tx, runId, {
      outcome: "failed",
      finishedAt: now,
      errorCode: answer.code,
      errorMessage: answer.message.slice(0, 500),
      retryAfter: failure.lockedUntil,
    });
    // ⭐ A rejected key is not a lock, it is a stop. The health trigger
    // in 0064 would only mark it degraded, so the state is set here.
    if (failure.state === "revoked") {
      await tx
        .update(connections)
        .set({
          state: "revoked",
          stateReason: failure.stateReason.slice(0, 500),
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(connections.id, connectionId));
    }
    return {
      connectionId,
      outcome: "failed",
      seen: 0,
      fresh: 0,
      duplicate: 0,
      failed: 0,
      note: answer.message,
    };
  }

  // ⑥ The records.
  let fresh = 0;
  let duplicate = 0;
  let failed = 0;

  for (const record of answer.records) {
    const parsed = parseIndiamartRecord(record);
    const result = await ingestEnquiry(
      {
        tx,
        tenantId,
        connectionId,
        connectorLabel: policy?.label ?? row.connectorKey,
        runId,
        now,
      },
      parsed,
      record,
    );
    if (result.outcome === "created") fresh += 1;
    else if (result.outcome === "duplicate") duplicate += 1;
    else failed += 1;
  }

  const seen = answer.records.length;

  /**
   * ⚠️ `partial` WHERE ANYTHING FAILED, AND 0064 THEN REQUIRES A REASON.
   *
   * 🔴 Recording a run as a clean success while three enquiries went into
   * the failure list is how a customer discovers in March that they have
   * been losing leads since November.
   */
  const outcome: SyncOutcome = failed > 0 ? "partial" : "success";

  await closeRun(tx, runId, {
    outcome,
    finishedAt: now,
    itemsSeen: seen,
    itemsNew: fresh,
    itemsDuplicate: duplicate,
    itemsFailed: failed,
    errorMessage:
      failed > 0
        ? `${failed} of ${seen} enquiries could not be filed automatically and are listed on the enquiries screen.`
        : null,
    errorCode: failed > 0 ? "intake_partial" : null,
  });

  // ⑦ ⭐ THE CURSOR MOVES TO THE WINDOW WE ASKED FOR, not to `now`.
  //
  // ⚠️ Moving it to `now` after a clamped window silently skips whatever
  // fell between the end of the window and the present, and the gap is
  // invisible because the run succeeded.
  await advanceCursor(tx, tenantId, connectionId, window.to);

  return {
    connectionId,
    outcome,
    seen,
    fresh,
    duplicate,
    failed,
    note: window.note,
  };
}

/* ------------------------------------------------------------------ */
/* THE RUN ROW                                                         */
/* ------------------------------------------------------------------ */

async function openRun(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  startedAt: Date,
  from: Date,
  to: Date,
): Promise<string> {
  const rows = await tx
    .insert(syncRuns)
    .values({
      tenantId,
      connectionId,
      startedAt,
      windowFrom: from,
      windowTo: to,
      outcome: "running",
    })
    .returning({ id: syncRuns.id });
  const id = rows[0]?.id as string | undefined;
  if (!id) throw new Error("The sync run could not be opened.");
  return id;
}

async function closeRun(
  tx: Tx,
  runId: string,
  patch: {
    outcome: SyncOutcome;
    finishedAt: Date;
    itemsSeen?: number;
    itemsNew?: number;
    itemsDuplicate?: number;
    itemsFailed?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryAfter?: Date | null;
  },
): Promise<void> {
  await tx.update(syncRuns).set(patch).where(eq(syncRuns.id, runId));
}

async function writeRun(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  values: Record<string, unknown>,
): Promise<void> {
  await tx.insert(syncRuns).values({ tenantId, connectionId, ...values });
}

async function advanceCursor(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  to: Date,
): Promise<void> {
  await tx
    .update(connections)
    .set({ cursorAt: to })
    .where(
      and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)),
    );
}

/**
 * ⚠️ INDIAMART WANTS IST, IN ITS OWN FORMAT, AND SAYS SO NOWHERE
 * PROMINENT. Sending UTC asks for a window five and a half hours in the
 * past, which quietly loses every enquiry in that gap on the first run
 * and then keeps a permanent offset.
 */
export function istStamp(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("day")}-${get("month")}-${get("year")}${get("hour")}:${get("minute")}:${get("second")}`;
}
