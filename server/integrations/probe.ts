import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE PROBE: "DOES THIS ACTUALLY WORK?"
 * Version: v1.17.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A WRONG KEY AND A QUIET WEEK LOOK IDENTICAL
 * ══════════════════════════════════════════════════════════════════════
 * That sentence is the entire reason this file exists. Somebody pastes
 * an IndiaMART key on Monday, nothing arrives, and there is no way to
 * tell whether the key is wrong or nobody enquired. They find out on
 * Thursday, and the difference is three days of enquiries that went to
 * whoever answered first.
 *
 * ⭐ THE PROBE COLLAPSES THAT TO ONE CLICK AT THE MOMENT THE KEY IS
 * PASTED, which is the only moment the person is still holding the
 * seller panel open in another tab.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A PROBE IS NOT A SYNC, AND CONFLATING THEM BREAKS TWO THINGS
 * ══════════════════════════════════════════════════════════════════════
 * ① IT MUST NEVER MOVE THE CURSOR. `runConnection` advances `cursor_at`
 *    on success, so a probe that reused it would mark a week of real
 *    enquiries as already fetched and they would never be collected.
 *    Nothing would report this. The pipeline would simply be empty.
 *
 * ② IT MUST NOT DROWN THE LOG. The runs list is what a person reads on
 *    the morning leads stopped. Twenty setup attempts at the top of it
 *    push the actual failure off the screen, so probes are marked
 *    `is_probe` in 0069 and the screen filters them out by default.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND IT DELIBERATELY IGNORES "PAUSED" WHILE OBEYING "LOCKED"
 * ══════════════════════════════════════════════════════════════════════
 * `mayFetchNow` refuses a paused connection, and every new connection is
 * created paused because it has no credential yet. So routing the probe
 * through that verdict would mean the Test button never works at the one
 * moment it is needed.
 *
 * ⚠️ THE LOCKOUT IS NOT WAIVED THE SAME WAY. A lockout is the far end's
 * decision, not ours, and asking again during one extends it. Testing
 * your way into a fifteen minute IndiaMART block while setting up is a
 * spectacularly bad first impression, so the probe refuses and says how
 * long is left.
 */

import { and, desc, eq } from "drizzle-orm";
import {
  connections,
  syncRuns,
  webhookDeliveries,
  webhookEndpoints,
} from "@/db/schema/integrations";
import { CONNECTION_OWNER_KIND, readForRunner } from "@/server/vault/secrets";
import { policyFor, type VerifyMethod } from "@/lib/integrations/policy";
import { classifyIndiamartCode } from "@/lib/integrations/adapters/indiamart";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export interface ProbeReport {
  readonly ok: boolean;
  /** One line. What a person reads first and usually only. */
  readonly headline: string;
  /** What to do about it. Never a stack trace, never a raw body. */
  readonly detail: string;
}

/**
 * ⚠️ HOW LONG WE WAIT BEFORE CALLING IT DEAD.
 *
 * Deliberately short. This runs while somebody is watching a spinner,
 * and a probe that takes forty seconds is a probe people click twice.
 */
const PROBE_TIMEOUT_MS = 10_000;

export async function probeConnection(args: {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly now: Date;
  readonly fetchImpl?: typeof fetch;
}): Promise<ProbeReport> {
  const { tx, tenantId, connectionId, now } = args;
  const doFetch = args.fetchImpl ?? fetch;

  const [row] = await tx
    .select()
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)))
    .limit(1);

  if (!row) {
    return {
      ok: false,
      headline: "No such connection.",
      detail: "It may have been removed in another tab.",
    };
  }

  const policy = policyFor(row.connectorKey);
  if (!policy) {
    return {
      ok: false,
      headline: `Ordence does not know a system called "${row.connectorKey}".`,
      detail: "Nothing can be tested until that is corrected.",
    };
  }

  // ① 🔴 THE LOCKOUT IS THE FAR END'S DECISION AND WE HONOUR IT.
  if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) {
    const minutes = Math.max(
      1,
      Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 60_000),
    );
    return {
      ok: false,
      headline: `${policy.label} is not accepting requests from us for another ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      detail:
        "Testing again before then extends the block rather than shortening it. Nothing is wrong with the connection; wait it out.",
    };
  }

  // ② A revoked credential. Waiting does not fix it and neither does a probe.
  if (row.state === "revoked") {
    return {
      ok: false,
      headline: "The credential was rejected by the far end.",
      detail:
        "Testing cannot help. Someone has to paste a new key, and repeated rejected attempts can get the account itself blocked.",
    };
  }

  // ③ 🔴 THE RUN ROW IS OPENED BEFORE THE CREDENTIAL IS READ, AND THAT
  // ORDER IS NOT NEGOTIABLE.
  //
  // ⚠️ `readForRunner` refuses a read that has no `sync_runs` id to
  // belong to: "a credential may not be read outside a recorded run".
  // The tempting shortcut here was to add a `purpose` argument that
  // waives it for probes. That would have put a hole in the one rule
  // making credential access auditable, in exchange for saving one
  // INSERT. So the probe does what the runner does, and every read stays
  // attached to something a person can look up afterwards.
  const started = now;
  const openedRun = await tx
    .insert(syncRuns)
    .values({
      tenantId,
      connectionId,
      startedAt: started,
      outcome: "running",
      isProbe: true,
    })
    .returning({ id: syncRuns.id });

  const runId = openedRun[0]?.id as string | undefined;
  if (!runId) {
    return {
      ok: false,
      headline: "The test could not be recorded, so it was not run.",
      detail:
        "Nothing was sent to the far end. An unrecorded test is worse than no test, because nobody can tell afterwards whether it happened.",
    };
  }

  const report = await runByMethod(policy.verifyMethod, {
    tx,
    tenantId,
    connectionId,
    runId,
    row,
    policy,
    now,
    doFetch,
  });

  // ④ ⭐ CLOSED, ALWAYS, WHETHER IT PASSED OR FAILED.
  //
  // ⚠️ A log that only records failures cannot answer "was this ever
  // tested", which is the first question asked when a handover goes
  // wrong.
  //
  // 🔴 `is_probe` KEEPS IT OUT OF THE SYNC HISTORY. 0069 defaults it to
  // false, so every row written before today keeps meaning exactly what
  // it did.
  await tx
    .update(syncRuns)
    .set({
      finishedAt: new Date(started.getTime()),
      outcome: report.ok ? "success" : "failed",
      // ⚠️ 0064 requires a message on `failed`, so it is supplied one
      // way and left null the other.
      errorCode: report.ok ? null : "probe_failed",
      errorMessage: report.ok ? null : report.headline.slice(0, 500),
    })
    .where(eq(syncRuns.id, runId));

  return report;
}

/* ------------------------------------------------------------------ */
/* THE FOUR SHAPES, CHOSEN BY THE TABLE AND NOT BY AN `if`             */
/* ------------------------------------------------------------------ */

async function runByMethod(
  method: VerifyMethod,
  c: ProbeContext,
): Promise<ProbeReport> {
  switch (method) {
    case "inbound_only":
      return inboundOnly(c);
    case "credential_probe":
      return credentialProbe(c);
    case "fetch_probe":
      return fetchProbe(c);
  }
}

interface ProbeContext {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly connectionId: string;
  /** 🔴 The run this probe is, so the credential read has an owner. */
  readonly runId: string;
  readonly row: {
    connectorKey: string;
    config: unknown;
  };
  readonly policy: NonNullable<ReturnType<typeof policyFor>>;
  readonly now: Date;
  readonly doFetch: typeof fetch;
}

/**
 * ⭐ JUSTDIAL AND EMAIL. There is nothing to call, so the only honest
 * question is whether anything has ever arrived.
 *
 * 🔴 AND "NOTHING YET" IS REPORTED AS NOT-PROVEN, NOT AS FAILURE. A
 * JustDial connection on the day the address was emailed to their
 * account manager is working exactly as designed and has received
 * nothing. Calling that a failure would train people to ignore the
 * screen.
 */
async function inboundOnly(c: ProbeContext): Promise<ProbeReport> {
  // ⚠️ `webhook_deliveries` HANGS OFF THE ENDPOINT, NOT THE CONNECTION.
  // It has no `connection_id` column, so this joins rather than
  // pretending otherwise.
  const rows = await c.tx
    .select({ receivedAt: webhookDeliveries.receivedAt })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookEndpoints.id, webhookDeliveries.endpointId),
    )
    .where(
      and(
        eq(webhookDeliveries.tenantId, c.tenantId),
        eq(webhookEndpoints.connectionId, c.connectionId),
      ),
    )
    .orderBy(desc(webhookDeliveries.receivedAt))
    .limit(1);

  const last = rows[0]?.receivedAt as Date | undefined;

  if (!last) {
    return {
      ok: false,
      headline: `Nothing has arrived from ${c.policy.label} yet.`,
      detail: c.policy.selfService
        ? "That is normal until the far end is configured to send to the address above. This is not an error, and there is nothing here for us to call to find out more."
        : "Their account manager has to add the address above at their end. Until they do, nothing arrives and there is no way for us to check from this side.",
    };
  }

  return {
    ok: true,
    headline: `${c.policy.label} has reached us.`,
    detail: `The most recent delivery arrived ${last.toISOString()}. The address is correct and their end is sending to it.`,
  };
}

/**
 * ⭐⭐ WHATSAPP. The token is checked against the cheapest identity call
 * Meta offers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT MUST NOT SEND A MESSAGE, AND THE REASON IS THE BILL
 * ══════════════════════════════════════════════════════════════════════
 * The obvious test is "send yourself a message". Meta charges per
 * delivered message from 1 July 2025, so a Test button that sends is a
 * Test button that spends, and somebody clicking it five times while
 * getting the setup right has paid for five messages and possibly
 * annoyed a real person.
 *
 * ⚠️ Reading the phone number's own record proves the access token, the
 * phone number id and the account are all real and connected to each
 * other, which is every question setup actually has, and costs nothing.
 */
async function credentialProbe(c: ProbeContext): Promise<ProbeReport> {
  const config = (c.row.config ?? {}) as Record<string, unknown>;
  const phoneNumberId = typeof config.phoneNumberId === "string" ? config.phoneNumberId : null;

  if (!phoneNumberId) {
    return {
      ok: false,
      headline: "This connection has no phone number id yet.",
      detail:
        "It is on the same screen in Meta's dashboard as the access token, labelled Phone number ID. Add it and test again.",
    };
  }

  const secret = await readForRunner({
    tx: c.tx,
    tenantId: c.tenantId,
    ownerKind: CONNECTION_OWNER_KIND,
    ownerId: c.connectionId,
    label: "access_token",
    syncRunId: c.runId,
  });

  if (!secret.ok) {
    return {
      ok: false,
      headline: "No access token has been saved for this connection.",
      detail: secret.error,
    };
  }

  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}?fields=verified_name,quality_rating,display_phone_number`;

  const called = await callWithTimeout(c.doFetch, url, {
    headers: { authorization: `Bearer ${secret.value}` },
  });

  if (!called.ok) {
    return {
      ok: false,
      headline: "Could not reach Meta.",
      detail: called.note,
    };
  }

  if (called.status === 200) {
    const name =
      typeof called.body?.verified_name === "string" ? called.body.verified_name : null;
    const display =
      typeof called.body?.display_phone_number === "string"
        ? called.body.display_phone_number
        : null;
    const quality =
      typeof called.body?.quality_rating === "string" ? called.body.quality_rating : null;

    return {
      ok: true,
      headline: name
        ? `Connected to ${name}${display ? ` (${display})` : ""}.`
        : "The token works.",
      detail: quality
        ? `Meta reports this number's quality rating as ${quality}. A rating that falls to low is what precedes a template pause, so it is worth knowing before the first campaign.`
        : "The access token, the phone number id and the account all agree. No message was sent and nothing was charged.",
    };
  }

  // 🔴 190 IS THE ONE WORTH NAMING. An expired token is the single most
  // common WhatsApp setup failure, and "OAuthException" tells a business
  // owner nothing at all.
  const code = readGraphErrorCode(called.body);
  if (called.status === 401 || code === 190) {
    return {
      ok: false,
      headline: "Meta rejected the access token.",
      detail:
        "This is usually a temporary token that has expired. Generate a permanent token from a System User in Business Settings rather than the short one on the app dashboard, which lasts about an hour.",
    };
  }

  if (called.status === 404) {
    return {
      ok: false,
      headline: "Meta does not recognise that phone number id.",
      detail:
        "Check it against the WhatsApp section of your Meta app dashboard. It is a long number, and it is not the phone number itself.",
    };
  }

  return {
    ok: false,
    headline: `Meta refused the check with status ${called.status}.`,
    detail: readGraphErrorMessage(called.body) ?? "No reason was given.",
  };
}

/**
 * ⭐ INDIAMART AND META LEAD ADS. Make the ordinary call over the
 * narrowest window the far end allows.
 *
 * ⚠️ NARROW ON PURPOSE. A probe that asks for seven days on a busy
 * seller pulls hundreds of enquiries into a response nobody reads, and
 * spends one of the twelve requests an hour IndiaMART permits.
 */
async function fetchProbe(c: ProbeContext): Promise<ProbeReport> {
  const secret = await readForRunner({
    tx: c.tx,
    tenantId: c.tenantId,
    ownerKind: CONNECTION_OWNER_KIND,
    ownerId: c.connectionId,
    label: "api_key",
    syncRunId: c.runId,
  });

  if (!secret.ok) {
    return {
      ok: false,
      headline: "No key has been saved for this connection yet.",
      detail: secret.error,
    };
  }

  if (c.row.connectorKey !== "indiamart") {
    // ⚠️ Meta lead ads has no cheap list call that proves anything a
    // person cares about: the leads endpoint is per-form, and a business
    // with no form yet gets an empty list from a perfectly good token.
    // Rather than print a green tick for that, say what is true.
    return {
      ok: false,
      headline: "This connector cannot be proven from our side yet.",
      detail:
        "Meta only reveals leads through a specific form, so an empty answer here would mean either a working setup with no enquiries or a broken one. Connect the form and the first real lead is the test.",
    };
  }

  const from = new Date(c.now.getTime() - 60 * 60 * 1000);
  const url = new URL("https://mapi.indiamart.com/wservce/crm/crmListing/v2/");
  url.searchParams.set("glusr_crm_key", secret.value);
  url.searchParams.set("start_time", istStampForProbe(from));
  url.searchParams.set("end_time", istStampForProbe(c.now));

  const called = await callWithTimeout(c.doFetch, url.toString(), {});

  if (!called.ok) {
    return { ok: false, headline: "Could not reach IndiaMART.", detail: called.note };
  }

  // 🔴 INDIAMART ANSWERS 200 WITH THE REAL VERDICT IN THE BODY. Treating
  // the HTTP status as the answer reports a rejected key as a success.
  const bodyCode =
    typeof called.body?.CODE === "number"
      ? called.body.CODE
      : Number.parseInt(String(called.body?.CODE ?? ""), 10);

  const verdict = Number.isFinite(bodyCode) ? classifyIndiamartCode(bodyCode) : null;

  // ⭐ 204 IS "NOBODY ENQUIRED", NOT A FAULT, and the adapter already
  // says so. 200 returns null from the classifier because the caller is
  // expected to read records, which for a probe means counting them.
  if (verdict === null || verdict.kind === "empty") {
    const seen = Array.isArray(called.body?.RESPONSE) ? called.body.RESPONSE.length : 0;
    return {
      ok: true,
      headline: "IndiaMART accepted the key.",
      detail:
        seen > 0
          ? `${seen} enquir${seen === 1 ? "y" : "ies"} in the last hour. Turning the connection on will bring them in.`
          : "Nothing in the last hour, which on most days is normal. The key is right, which is what this was checking. A brand new key also sees nothing older than itself for its first 24 hours.",
    };
  }

  if (verdict.kind === "error" && verdict.failureClass === "auth") {
    return {
      ok: false,
      headline: "IndiaMART rejected the key.",
      detail:
        "Copy it again from Lead Manager in your seller panel. The pull API also needs a paid seller account; on a free account the key exists but is refused.",
    };
  }

  if (verdict.kind === "error" && verdict.failureClass === "rate_limited") {
    return {
      ok: false,
      headline: "IndiaMART is rate limiting us.",
      detail:
        "Nothing is wrong with the key. They allow one call every five minutes; wait that long and test once more.",
    };
  }

  // ⚠️ THE ADAPTER'S OWN WORDS, NOT A RESTATEMENT OF THEM. Every message
  // in `classifyIndiamartCode` was written for a person to read, and
  // paraphrasing them here would create a second place they have to be
  // kept correct.
  return {
    ok: false,
    headline: `IndiaMART answered with code ${Number.isFinite(bodyCode) ? bodyCode : "an unreadable value"}.`,
    detail:
      verdict.kind === "error"
        ? verdict.message
        : typeof called.body?.MESSAGE === "string"
          ? called.body.MESSAGE
          : "No reason was given.",
  };
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY FAILURE MODE OF `fetch` BECOMES A SENTENCE, not an exception.
 * A probe that throws turns into a red toast reading "fetch failed",
 * which is indistinguishable from a bug in Ordence and generates a
 * support ticket rather than a corrected key.
 */
async function callWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<
  | { ok: true; status: number; body: Record<string, unknown> | null }
  | { ok: false; note: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { ok: true, status: res.status, body };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      note: aborted
        ? `They did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds. That is usually their end being slow rather than anything wrong with your setup. Try once more.`
        : "The request could not be completed. If this keeps happening it is on our side, not yours.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function readGraphErrorCode(body: Record<string, unknown> | null): number | null {
  const error = body?.error as Record<string, unknown> | undefined;
  const code = error?.code;
  return typeof code === "number" ? code : null;
}

function readGraphErrorMessage(body: Record<string, unknown> | null): string | null {
  const error = body?.error as Record<string, unknown> | undefined;
  const message = error?.message;
  return typeof message === "string" ? message : null;
}

/**
 * ⚠️ INDIAMART WANTS IST IN ITS OWN FORMAT. This mirrors `istStamp` in
 * the runner deliberately rather than importing it, because importing
 * the runner would pull `ingestEnquiry` and the whole write path into a
 * module whose entire point is that it writes nothing.
 */
function istStampForProbe(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}${get("hour")}:${get("minute")}:${get("second")}`;
}
