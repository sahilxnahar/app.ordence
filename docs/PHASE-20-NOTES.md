# Phase 20 — SecOps, SIEM Export & Rate Limiting

Version: v0.12.0-alpha
Closes: **SEC-005** (no rate limiting on search / webhook / upload),
**SEC-020** (no rate limiting on `/portal/[token]`),
**SEC-024** (no rate limiting on the billing webhook endpoints).

> ⚠️ **This phase is NOT complete until the "INTEGRATION REQUIRED" section at
> the bottom is applied.** Everything here is a library plus a schema. A rate
> limiter that is never called is a rate limiter that does nothing, and the
> three SEC issues stay open until the call sites exist. The wiring was left
> out deliberately: this phase does not own `middleware.ts`, `app/api/**`,
> `server/actions/**` or the schema barrel.

---

## 1. What was built

| File | What it is |
|---|---|
| `lib/security/events.ts` | The closed event-type enum, the severity model, and the redactor. Pure — importable from Edge, Node, a script and a test. |
| `lib/security/rate-limit.ts` | Named policies, Redis-backed with an in-memory fallback, key builders, `checkRateLimit()`. Never throws. No `node:` imports (Edge-safe). |
| `lib/security/siem.ts` | NDJSON and CEF serialisers plus the export cursor. Pure, no vendor SDK. |
| `db/schema/secops.ts` | `security_events` — one table, append-only, nullable `tenant_id` with a stated NULL policy. |
| `server/security/record.ts` | `recordSecurityEvent()` (best-effort) and `recordSecurityEventTx()` (transactional, throws). Burst coalescing. |
| `server/security/anomalies.ts` | Five rule-based detectors. Pure rules, impure runner. |
| `SQL-FILES/0012_phase20_secops.sql` | RLS (USING + WITH CHECK), append-only triggers, tenant-fix trigger, privileged retention function, REVOKE-then-GRANT, 10 numbered verification checks. |
| `tests/security/secops-isolation.test.ts` | 16 assertions against real PostgreSQL as `ameya_app`. |
| `tests/ui/rate-limit.test.tsx` | 26 assertions: boundary, key collision, fallback, no-leak 429. |
| `tests/ui/security-events.test.tsx` | 38 assertions: vocabulary, redaction, detector boundaries, SIEM injection. |

No new dependencies. `@upstash/ratelimit` and `@upstash/redis` were already
present; `lib/redis.ts`'s `getRedis()` is reused unchanged.

---

## 2. The boundary: `security_events` vs `audit_logs` vs `permission_denials`

This is the decision most likely to erode, so it is stated once, here, and
repeated in `lib/security/events.ts`, `db/schema/secops.ts` and
`SQL-FILES/0012_phase20_secops.sql`.

| Table | Records | Written by |
|---|---|---|
| `audit_logs` | What an authenticated principal **DID**. Has an actor, a resource and an intent. | `writeAudit()`, `recordSystemAudit()` |
| `permission_denials` | What a **known** principal was **REFUSED**. Still a user action; it simply did not happen. | `checkPermission()` |
| `security_events` | Everything that is **not a user action**: limiter trips, forged HMACs, garbage portal tokens, inferred patterns. | `recordSecurityEvent()` |

**The test to apply at a call site, in order:**

1. Is there an authenticated actor who *intended* this? → `audit_logs`.
2. Is it an authenticated actor being refused a permission? → `permission_denials`.
3. Anything else a security reviewer would want to see → `security_events`.

Nothing is written to two of the three.

**Why not merge into `audit_logs`?** Volume and trust. A scraper generates ten
thousand limiter trips a minute. Putting those in `audit_logs` buries the
twelve rows a year that say a human closed an accounting period — inside the
one table that has to be defensible in a dispute. The two streams also have
different retention lives: audit is kept for years, SecOps telemetry for
months (`prune_security_events()`).

**The one deliberate overlap.** `authz.denial_spike` is a `security_events` row
saying the *shape* of the denials changed. The individual denials are not
copied — only counted, with the finding pointing back at them.

---

## 3. Redis-absent fallback — the decision and the justification

`UPSTASH_REDIS_REST_URL` / `_TOKEN` are optional. Three options existed:

- **Fail closed (refuse everything).** Correct for a vault, catastrophic here.
  An unset environment variable would take the whole product offline for every
  user, triggered by the security feature itself, on the day someone typos a
  rotated token. The blast radius of the mistake exceeds the blast radius of
  the attack. **Rejected.**
- **Fail open (allow everything).** Then anyone who can make Redis unreachable
  — or who finds a deployment where it was never configured — gets an
  unlimited login endpoint. **Rejected as the whole answer.**
- **Degrade to a per-instance in-memory sliding-window log.** ← **chosen.**

**Be honest about what the fallback is worth.** On Vercel there may be a
hundred warm instances and a request lands on any of them, so the effective
limit is `limit × instances`; memory is lost on every cold start. **It is a
speed bump, not a control.** It stops a naive script and a runaway client
loop. It does not stop a distributed attack.

Which is why the degradation is **loud**: the first time a process falls back
it logs a `[SECURITY]` warning and fires `onRateLimitDegraded()`, once per
process (not per request — that would be a million rows an hour into an
append-only table, drowning the alarm it raises). Wire the listener to
`recordSecurityEvent({ type: "rate_limit.degraded" })` from a Node entry point
— see INTEGRATION step 7.

**The one policy that is fail-open even here is `webhook`**
(`enforceWhenDegraded: false`). A per-instance counter sees only a slice of the
provider's traffic and could reject a legitimate redelivery burst on very
little evidence. A missed limit costs some compute; a wrongly-dropped webhook
costs a payment. Signature verification is unaffected.

`checkRateLimit()` **never throws.** If everything inside it fails it allows
and logs. A limiter that throws turns a Redis blip into a 500 on every route
it guards — a worse outage than the abuse it prevents.

---

## 4. Rate-limit keying

Keying is the whole design; the numbers are the easy part.

| Surface | Key | Why |
|---|---|---|
| Search, upload, generic API | `tenantRateLimitKey(tenantId, userId)` | Tenant prefix **first and mandatory**, so tenant A's traffic can never exhaust tenant B's budget. That would be a cross-tenant availability leak any customer could mount. |
| Sign-in | `ipRateLimitKey(ip)` (plus the identifier) | No session exists yet. |
| Portal | **both** `portalRateLimitKey(token, ip)` **and** `portalSourceRateLimitKey(ip)` | See below. |
| Webhooks | `webhookRateLimitKey(provider, ip)` — the **source**, never the endpoint | A shared endpoint counter would let one attacker's flood exhaust the budget and cause *our provider's* events to be rejected. Nuisance → lost revenue. |

### The portal, in detail (SEC-020)

- **IP only** punishes an office behind one NAT — most law firms, every site
  wifi. Six people opening the same contract at 10am exhaust the budget and
  the seventh gets a 429 on a link we sent them. Meanwhile an enumerator just
  rotates IPs, which is cheap. Broken product, zero protection.
- **Token only** gives every guess its own fresh budget, because every guess is
  a different key. Exactly zero protection against the attack it was installed
  for.
- **Both.** The compound key contains a leaked link being hammered without
  touching anyone else's. The token-independent source key counts an
  enumerator as one source however many tokens it tries. **Check both**; the
  compound key alone resets per token.

The **raw token never becomes a Redis key** — it is a live 256-bit credential
and keys appear in `MONITOR`, slow logs, the Upstash console and error
messages. A SHA-256 prefix counts identically and is worthless if disclosed.

IP components are **/24 (v4) or /64 (v6) prefixes**, not exact addresses: a
mobile client changes address between requests within one /64, and anyone with
a VPS holds a /64 — i.e. 18 quintillion free buckets if you count addresses.

### Policies

| Policy | Limit | Window | Enforces when degraded |
|---|---|---|---|
| `auth` | 10 | 60s | yes |
| `search` | 30 | 60s | yes |
| `upload` | 20 | 300s | yes |
| `portal` | 20 | 60s | yes |
| `webhook` | 600 | 60s | **no** |
| `api` | 300 | 60s | yes |

---

## 5. The webhook endpoints are a special case (SEC-024)

`app/api/webhooks/razorpay/route.ts` is public and unauthenticated by
necessity — a server-to-server call carries no session, and the HMAC is the
auth. Rate limiting it has a property no other policy has: **a rejection costs
money.** Razorpay reads a 429 as a delivery failure, retries with backoff, and
eventually gives up. The dropped event may be `subscription.charged`; we then
dun a customer who paid and suspend an account in good standing.

**A retry storm is legitimate traffic.** If our endpoint is briefly down the
provider redelivers everything it queued — hundreds of real events in a burst,
all needed. A limit tuned to "normal" traffic throttles precisely the recovery
we want to succeed.

So `webhook` is a **DoS ceiling, not a business rule**: 600/minute is an order
of magnitude above any plausible redelivery burst at this scale while still
bounding a flood. Note that forged payloads are already cheap to refuse — the
HMAC check is one hash, before any database work — so this limiter protects the
**invocation bill**, not the subscription state. The signature protects that.

**Placement matters:** put the limiter check **after** `request.text()` and
**before** `verifyWebhook()`, and key it on the source IP. See step 3.

---

## 6. Anomaly detection — five counting rules, no ML

Rule-based, thresholded, readable, testable with a fixed array. **There is no
machine learning and there will not be**, because: it could not be explained
to a customer or a regulator; it would be trained on unlabelled traffic and so
would learn that any compromise already in progress is normal; a model that
stops firing looks exactly like a quiet month; and the attacks worth catching
(stuffing, enumeration, 3am bulk export) are all obvious in a `COUNT`.

When a rule produces false positives, **raise the threshold and write down
why.** That is a conversation. A retrain is not.

| Rule | Fires when | Severity |
|---|---|---|
| `auth.failed_login_burst` | >15 failed sign-ins from one network / 10 min | critical |
| `authz.denial_spike` | >25 denials by **one user** / 15 min | warning |
| `portal.token_shared` | one token from >5 distinct networks / 60 min | warning |
| `export.off_hours_bulk` | ≥500 records exported, 22:00–06:00 IST | notice |
| `rate_limit.sustained_pressure` | >40 limiter trips from one network / 15 min | warning |

**The detector does not act.** No account is locked, no token revoked, no IP
banned. Automated response on rules this simple means an attacker who can forge
`X-Forwarded-For` gets any user locked out on demand — our detector becomes
their DoS tool. Response stays human until the rules have a track record.

`export.off_hours_bulk` is `notice`, never critical, deliberately: it describes
a *person*, and 2am is also normal for an operations lead in another timezone.

Run `runAnomalyDetection()` from a **scheduled job**, on a **platform-scoped
connection** (otherwise RLS hides the `tenant_id IS NULL` perimeter rows, and
those are where a pre-authentication attack shows up first).

---

## 7. SIEM export

NDJSON (ECS-shaped) and CEF. No vendor SDK — the customer's SOC already exists
and it is not ours to choose; an SDK would put a supply chain inside the one
subsystem whose integrity we are asserting; and pushing from a serverless
function means promising a delivery guarantee we cannot honour.

Both formats are line-delimited, so both strip newlines from every value. That
is a control, not tidiness: an attacker-chosen `\n` in a user-agent could
terminate the record and have the remainder parse as a **second,
attacker-authored event** — forging "severity: info, all clear" inside the log
that was recording the attack. CEF is the more exposed of the two because it
has no quoting mechanism.

Export progress uses an **external `(created_at, id)` high-water mark**, not an
`exported_at` UPDATE. Updating a column on an append-only table would require
carving an exception into the trigger, and an exception is a general UPDATE
path that a later change reuses. The tuple (not the timestamp alone) is
required because two rows can share a millisecond: a timestamp-only cursor
either skips one (evidence lost) or repeats it forever. Export is
**at-least-once** — a duplicate alert is deduplicated on `externalId`, a
missing one is an attack nobody saw.

---

## 8. Database

- RLS with **both** `USING` and `WITH CHECK`. Without `WITH CHECK` a tenant can
  INSERT a row stamped with another tenant's id — on this table that means
  forging security history against a customer, or filing your own intrusion
  under someone else's name.
- **Append-only.** UPDATE unconditionally refused; DELETE refused except via
  `prune_security_events()`, which is `SECURITY DEFINER` with a pinned
  `search_path`, revoked from `PUBLIC`, and granted only to `ameya_maintenance`
  (if that role exists). Compromising the web application must not confer the
  ability to erase the record of having compromised it.
- `tenant_id` FK is `ON DELETE SET NULL`, not `CASCADE` — deleting a tenant must
  not silently erase the record of attacks mounted against them or from them.
- Grants: **REVOKE first**, then `GRANT SELECT, INSERT`. An additive-only block
  is a no-op against any prior `GRANT ALL ON ALL TABLES`, which is the first
  thing anyone runs when a query fails with "permission denied". On this table
  the privilege being restricted is "erase the evidence".

---

## 9. Verified vs. only written

**Executed, output read:**

- `npx tsc --noEmit` — **clean**.
- `SQL-FILES/0012_phase20_secops.sql` — **executed** against the local
  PostgreSQL 16 (`ameya_test`). All 10 verification checks returned **PASS**;
  the orphan-FK check returned zero rows as intended. The table itself does not
  exist in `db/schema/index.ts` yet (barrel not owned by this phase), so it was
  created for the run from a scratch DDL matching `db/schema/secops.ts`
  exactly — see the caveat below.
- `npx vitest run --config vitest.ui.config.ts tests/ui/rate-limit.test.tsx
  tests/ui/security-events.test.tsx` — **64 passed**.
- `npx vitest run tests/security/secops-isolation.test.ts` — **16 passed**,
  as `ameya_app` (non-superuser, RLS meaningful).

**Written but NOT executed:**

- The Redis-backed path of `checkRateLimit()`. There is no Upstash instance in
  this environment, so every limiter test exercises the **in-memory fallback**.
  The Upstash branch is a ~15-line call into `@upstash/ratelimit` and is
  untested here. **Verify it manually on a preview deployment with Upstash
  configured before trusting SEC-005/020/024 as closed.**
- `recordSecurityEvent()` / `recordSecurityEventTx()` against a live database.
  `buildSecurityEventRow()` (redaction, severity floor) is unit-tested; the
  actual INSERT is not, because `db` connects at module load and the schema
  barrel does not export `securityEvents` yet.
- `runAnomalyDetection()`'s queries. The five **rules** are unit-tested at their
  exact boundaries; the Drizzle reads around them are not.
- `prune_security_events()`'s happy path with real data (the guard rail — refuses
  <30 days — and the privilege separation both are tested).

---

# INTEGRATION REQUIRED

Apply these yourself; this phase does not own any of the files below.

### 0. Schema barrel — `db/schema/index.ts`

Add, after the billing line:

```ts
// SecOps — structured security event stream (Phase 20)
export * from "./secops";
```

Then `npm run db:push`, then run `SQL-FILES/0012_phase20_secops.sql`, then
`npm run db:verify`. Also fold 0012 into `SQL-FILES/ALL-IN-ONE-SETUP.sql`.

### 1. Search — `server/actions/search.ts`

At the top of **`globalSearch()`** (line ~80) and **`quickSearch()`** (line
~320), after the existing `requireTenantContext()` / permission call and before
any query:

```ts
const rl = await checkRateLimit(
  "search",
  tenantRateLimitKey(ctx.tenant.id, ctx.user.id),
);
if (!rl.allowed) {
  await recordRateLimitTrip({
    policy: "search",
    source: "actions/search",
    tenantId: ctx.tenant.id,
    actorUserId: ctx.user.id,
    degraded: rl.degraded,
  });
  throw new Error("Too many requests. Please slow down.");
}
```

Imports:
```ts
import { checkRateLimit, tenantRateLimitKey } from "@/lib/security/rate-limit";
import { recordRateLimitTrip } from "@/server/security/record";
```

### 2. Upload — `app/api/upload/route.ts`

Inside `POST()` (line 85), **immediately after** the tenant context is
established and **before** the Blob token is signed:

```ts
const rl = await checkRateLimit("upload", tenantRateLimitKey(tenantId, userId));
if (!rl.allowed) {
  await recordRateLimitTrip({
    policy: "upload", source: "api/upload", tenantId,
    actorUserId: userId, route: "/api/upload", degraded: rl.degraded,
  });
  return NextResponse.json(rateLimitBody(), {
    status: 429,
    headers: rateLimitHeaders(rl, { authenticated: true }),
  });
}
```

### 3. Webhooks — `app/api/webhooks/razorpay/route.ts` and `.../stripe/route.ts`

In `POST()`, **after** `rawBody = await request.text()` and the 1 MB size check,
**before** `verifyWebhook()`:

```ts
const sourceIp =
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

const rl = await checkRateLimit("webhook", webhookRateLimitKey("razorpay", sourceIp));
if (!rl.allowed) {
  await recordRateLimitTrip({
    policy: "webhook", source: "api/webhooks/razorpay", ipAddress: sourceIp,
    route: "/api/webhooks/razorpay", degraded: rl.degraded,
  });
  // 429 with Retry-After only. Providers back off and redeliver; the body
  // must stay empty of detail because this endpoint is public.
  return NextResponse.json(rateLimitBody(), {
    status: 429,
    headers: rateLimitHeaders(rl, { authenticated: false }),
  });
}
```

(Use `"stripe"` in the Stripe route.) **Do not** move this before the size
check, and **do not** lower the 600/min limit without re-reading section 5.

While you are in these files, also record the signature failure — this is the
highest-value row in the whole table:

```ts
if (!verification.ok) {
  await recordSecurityEvent({
    type: verification.reason === "missing_secret"
      ? "webhook.secret_missing"
      : "webhook.signature_invalid",
    source: "api/webhooks/razorpay",
    tenantId: null,               // unattributed by necessity — see §8
    ipAddress: sourceIp,
    route: "/api/webhooks/razorpay",
    detail: { provider: "razorpay", reason: verification.reason },
    reason: "Webhook signature verification failed.",
  });
  ...existing response, unchanged...
}
```

### 4. Portal page — `app/portal/[token]/page.tsx`

In `PortalPage()` (line 87), **before** `resolvePortalToken(token)`:

```ts
const facts = await getVisitorFacts();

// TWO checks. The compound key contains a hammered link; the source key
// catches an enumerator, who gets a fresh compound key per guess.
const [byToken, bySource] = await Promise.all([
  checkRateLimit("portal", await portalRateLimitKey(token, facts.ipAddress)),
  checkRateLimit("portal", portalSourceRateLimitKey(facts.ipAddress)),
]);

if (!byToken.allowed || !bySource.allowed) {
  await recordSecurityEvent({
    type: "rate_limit.exceeded",
    source: "portal",
    ipAddress: facts.ipAddress,
    subjectType: "portal_token_ref",
    subjectId: token.slice(0, 8),      // ⚠️ PREFIX ONLY. Never the token.
    detail: { policy: "portal", scope: byToken.allowed ? "source" : "token" },
  });
  notFound();   // same response as every other portal failure — no new oracle
}
```

Apply the identical block to
`app/portal/[token]/documents/[documentId]/route.ts` (`GET`, line 56), returning
`new NextResponse(null, { status: 429, headers: rateLimitHeaders(d, { authenticated: false }) })`.

### 5. Sign-in — `middleware.ts`

On the Clerk sign-in POST path only:

```ts
const rl = await checkRateLimit("auth", ipRateLimitKey(ip));
if (!rl.allowed) {
  return new NextResponse(JSON.stringify(rateLimitBody()), {
    status: 429,
    headers: { "content-type": "application/json",
               ...rateLimitHeaders(rl, { authenticated: false }) },
  });
}
```

⚠️ **Do not call `recordSecurityEvent()` from middleware.** It imports the
database client and middleware runs on the Edge. Record from a Node route or
from the degradation listener instead.

### 6. Generic backstop — `middleware.ts`

Apply the `api` policy to `/api/*` keyed by `tenantRateLimitKey()` when a
session exists and `ipRateLimitKey()` when it does not. Exclude
`/api/webhooks/*` (they have their own policy) and `/api/health`.

### 7. Degradation alarm — a Node-only entry point (e.g. `instrumentation.ts`)

```ts
import { onRateLimitDegraded } from "@/lib/security/rate-limit";
import { recordSecurityEvent } from "@/server/security/record";

onRateLimitDegraded(({ policy, reason, message }) => {
  void recordSecurityEvent({
    type: "rate_limit.degraded",
    source: "rate-limiter",
    detail: { policy, reason, message },
    reason: "Rate limiter is running without Redis; limits are per-instance only.",
  });
});
```

### 8. Scheduled detector

Add a cron/QStash job calling `runAnomalyDetection()` every 15 minutes on a
**platform-scoped** connection, and a nightly
`SELECT prune_security_events(180, false)` as the maintenance role.

### 9. `scripts/verify-security.ts`

Add checks mirroring 0012 Section 6: RLS enabled **and** forced on
`security_events`, the policy has a `WITH CHECK`, all three triggers exist, and
`ameya_app` holds neither UPDATE nor DELETE.

---

## Things that worry me

1. **The Upstash path is untested here.** Every limiter assertion runs on the
   memory fallback. Confirm on a preview deployment with Redis configured.
2. **The fallback is genuinely weak on serverless.** It is documented as a
   speed bump in four places, and someone will still eventually cite it as
   protection. If Upstash is not configured in production, SEC-005/020/024 are
   only *partially* closed — say so in the CHANGELOG.
3. **`x-forwarded-for` is trusted for keying.** Correct on Vercel (the edge
   overwrites it); wrong on a self-hosted deployment behind an arbitrary proxy,
   where an attacker can mint a fresh bucket per request. It is never used for
   an authorization decision, only for counting and evidence — but on
   self-hosted it makes IP-keyed limits bypassable. Worth a deployment note.
4. **Burst coalescing makes `occurrence_count` a lower bound** across
   instances. Any dashboard reading it must say so, or someone will quote it as
   an exact figure in an incident report.
5. **Nothing calls any of this yet.** Until INTEGRATION is applied, the three
   SEC issues remain open.
