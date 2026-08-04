# Phase 19 — Telemetry & Observability

Version: v0.12.0-alpha
Status: built, typechecked, tested, SQL executed against a real PostgreSQL 16.

---

## What this phase is

Error tracking, Core Web Vitals collection and per-tenant health signals, built
on our own Postgres with **no new npm dependency and no third-party SDK**.

| Concern | Where it lives |
| --- | --- |
| Tables, enums, CHECK constraints | `db/schema/telemetry.ts` |
| URL/PII scrubbing, error fingerprinting | `lib/telemetry/scrub.ts` |
| Server-side capture API | `lib/telemetry/report.ts` |
| Wire contract (shared client/server) | `lib/telemetry/ingest-schema.ts` |
| Browser reporter | `components/telemetry/web-vitals-reporter.tsx` |
| Public ingest endpoint | `app/api/telemetry/route.ts` |
| RLS, append-only, health view, retention | `SQL-FILES/0011_phase19_telemetry.sql` |
| Unit / adversarial tests | `tests/ui/telemetry.test.tsx` (67 tests) |
| Isolation tests | `tests/security/telemetry-isolation.test.ts` (21 tests) |

---

## ⛔ DELIBERATE SCOPE REDUCTION: SESSION REPLAY WAS NOT BUILT

The roadmap listed session replay. It is **not** in this phase, and I do not
think it should be added later without a specific, narrow justification. The
argument, so you can overrule it with the facts in front of you:

**1. In a CRM, the screen *is* the personal data.**
Replay records the DOM. Our DOM contains contact names, email addresses, phone
numbers, PAN and Aadhaar fields in the KYC surfaces, deal values, contract text
and the contents of the document vault viewer. A replay of an ordinary working
session is a near-complete copy of a customer's book of business, stored as a
video-like artefact that no `DELETE FROM contacts` will ever reach.

**2. Redaction does not reliably solve it, and its failures are silent.**
The standard answer is "mask everything and allow-list what to record", and it
genuinely helps. It also breaks in ways nobody notices:

- A masking rule keyed on a CSS class stops working the moment a component is
  refactored, and nothing fails — the recording just quietly contains real data.
- Dynamically-rendered content (a toast, a tooltip, a PDF preview canvas) is
  routinely missed by rules written against the static markup.
- Canvas and `<img>` content cannot be masked meaningfully at all; our document
  viewer is exactly that.
- Text typed into a masked field can still be reconstructed from keystroke
  timing and length in some implementations.

The failure mode of a leaky scrubber on a *structured* event is one bad column.
The failure mode of a leaky replay masker is a complete screen recording, and
you find out during a breach notification.

**3. It is a DPDP problem specifically, not a vague privacy concern.**
Under the DPDP Act our tenants are Data Fiduciaries and we are a Data Processor.
A replay store is a new copy of personal data, in a new location, with its own
retention, its own access control, and — with every commercial replay vendor —
its own cross-border transfer. Erasure requests would have to reach into it, and
"we cannot search inside recordings for a person" is not an answer that survives
contact with a regulator.

**4. What was built instead answers the same questions.**
The reason anybody asks for replay is "what was the user doing when it broke?".
Structured events answer that with a route pattern, an error fingerprint, a
severity, a release, a device class and an allow-listed metadata bag — without
ever copying screen content. What we give up is reproducing *unreported, subtle
UX confusion*, which is a product-research use case, not an incident-response
one, and is better served by asking five customers.

**If you want replay anyway**, my recommendation is: self-hosted only, opt-in
per tenant with a contractual amendment, recording disabled by default on every
route that renders a contact, a contract or a document, and a 7-day retention.
That is a project, not a component.

---

## Other things deliberately NOT built

- **Alerting / on-call routing.** The health view exposes the signal; nothing
  reads it yet. Alerting needs a delivery channel and an escalation policy,
  neither of which is a Phase 19 decision.
- **A dashboard UI.** No `components/telemetry` surface beyond the reporter.
  `telemetry_daily` is the query interface; the page that renders it belongs
  with whoever owns the admin shell.
- **Rate limiting on the ingest endpoint.** See below — this is the one gap I
  would call a real one.
- **A scheduled retention sweep.** The function exists; nothing calls it.
- **Source-map resolution for minified client stacks.** Client stacks will be
  minified in production and therefore only moderately useful. Symbolication
  needs a build-time upload step in `next.config.ts`, which I do not own.

---

## ⚠️ THINGS THAT WORRY ME

1. **The ingest endpoint has no rate limit.** It is public, it must be public
   (Web Vitals fire pre-auth, and a crash in the auth bootstrap has no session
   by definition), and every request is capped but the request *rate* is not.
   The residual risk is table growth and write load — a cost problem, not a
   disclosure one, because an anonymous caller can only write `tenant_id IS
   NULL` rows that no tenant can read. There is a marked `RATE LIMIT HOOK` at
   the top of `POST`. Wiring it correctly needs a trusted client IP, and
   `x-forwarded-for` is a client-settable header whose first entry is
   attacker-chosen — trusting it is a one-line bypass of any limit built on it.
   I left it as a hook rather than shipping a limiter that can be defeated by a
   header.

2. **`scrubText` is a deny-list and cannot be complete.** It removes emails,
   phone numbers, PAN, Aadhaar-shaped runs, JWTs, bearer credentials and uuids.
   It cannot remove `Could not save deal for Priya Sharma` — a human name in
   free text matches no regex. The real defence is that callers pass exception
   messages, not record contents. Check 8 in the migration is the standing audit
   query for this (`message ~* email-shape`); it should be run periodically, and
   a row appearing there means the tables are in scope for an erasure request.

3. **INP is approximated, and the approximation is pessimistic.** Without the
   `web-vitals` package I take the worst interaction latency rather than the
   ~98th percentile. On pages with hundreds of interactions this over-reports.
   It will never tell us things are fine when they are not, which is the right
   direction to be wrong in, but do not compare our INP against an external
   benchmark. If per-element INP attribution is ever needed, add the dependency
   and delete `web-vitals-reporter.tsx` rather than extending it.

4. **`fingerprintError()` uses FNV-1a, not SHA-256.** Deliberate: the module
   must be importable from a client component, `node:crypto` is unavailable
   there and `crypto.subtle` is async (an async fingerprint would make every
   capture path async, including inside error handlers). It is not a security
   hash and the only consequence of a forced collision is two unrelated bugs
   sharing a triage row. Stated in the file so nobody promotes it later.

5. **Client stacks are trusted to be stacks.** `source` is hardcoded to
   `"client"` on the ingest path so a forged POST cannot launder a fake backend
   error into triage, but the *content* of a client-reported error is whatever
   the caller sent. Anonymous rows are unattributed and invisible to tenants,
   so the blast radius is our own platform-scope triage queue being noisy.

6. **The retention sweep's escape hatch.** `error_events` is append-only via
   trigger, with one exception: a transaction-local
   `app.telemetry_retention_sweep = 'on'` setting. It is set with `is_local =
   true` inside the function for exactly the reason documented in `db/index.ts`
   — `false` would leave the flag on the pooled *connection* and let the next
   request delete error evidence. Anyone editing that function must keep the
   `true`.

---

## Retention (future work, not done)

- Both tables carry a `captured_at` index specifically so a sweep is a cheap
  ranged `DELETE` rather than a full scan (asserted by Check 6).
- `telemetry_retention_sweep(p_days integer DEFAULT 90)` exists and refuses a
  window under 7 days.
- **Nothing calls it.** Neon does not give us `pg_cron` by default and adding a
  Vercel Cron entry touches files I do not own. Until it is scheduled, retention
  is a manual operation, and that should be stated in whatever privacy notice
  covers diagnostics.
- If `telemetry_daily` stops being fast enough, the right answer is a real
  rollup *table* written by the sweep — not a materialised view, because a stale
  health dashboard that looks live is worse than a slow one.

---

## What I verified vs. what I only wrote

**Actually executed:**

- `npx tsc --noEmit` — **clean**, run after the final edit.
- `npx vitest run --config vitest.ui.config.ts tests/ui/telemetry.test.tsx` —
  **67 passed**.
- `npx vitest run tests/security/telemetry-isolation.test.ts` — **21 passed**,
  as the non-superuser `ameya_app` role against the local PostgreSQL 16.
- `psql -h 127.0.0.1 -U postgres -d ameya_test -f SQL-FILES/0011_phase19_telemetry.sql`
  — **ran end to end, all nine verification checks PASS.** To do this I created
  `error_events` and `web_vital_events` by hand in a scratch DDL file matching
  the Drizzle schema (since I do not own `db/schema/index.ts` and could not
  push), ran the migration, then deleted the scratch file. **The two tables now
  exist in `ameya_test`** — created by hand, so re-verify them against
  `drizzle-kit push` output before trusting the shape. All test fixture rows
  were cleaned up; both tables are empty.

**Written but NOT executed:**

- `npm run build` and `drizzle-kit push` — not run, as instructed.
- The migration has never run against a database where the tables were created
  by Drizzle. Column types and constraint names were transcribed by hand into
  the scratch DDL; a mismatch (most plausibly `numeric(14,4)` or an enum name)
  would only surface on a real push.
- `components/telemetry/web-vitals-reporter.tsx` is typechecked but **not
  render-tested**. jsdom does not implement `PerformanceObserver`, so a test
  would assert against a stub of the very API the component exists to use — I
  judged that worth less than the impression of coverage it would give. Its
  behaviour under a real browser is unverified.
- The ingest route handler is typechecked but has no integration test; there is
  no request-level harness in this repo and adding one touches shared config.
  Its schema, scrubbing and clamping logic are all unit-tested via
  `lib/telemetry/*`.

---

# INTEGRATION REQUIRED

Everything below is in a file I do not own. Nothing in this phase works until
these are applied.

### 1. `db/schema/index.ts` — export the new schema

Add alongside the other barrel exports:

```ts
export * from "./telemetry";
```

Then `npx drizzle-kit push` to create `error_events`, `web_vital_events` and the
five new enums (`telemetry_severity`, `web_vital_metric`, `web_vital_rating`,
`telemetry_device_class`, `telemetry_connection`).

**Then run `SQL-FILES/0011_phase19_telemetry.sql`** — RLS, the append-only
triggers, the `telemetry_daily` view and the grants are all in there, and none
of them are created by `push`.

### 2. `lib/env.ts` — add one optional server variable

In `serverSchema`, near the platform block:

```ts
  // --- Telemetry (Phase 19) ---
  //
  // Deploy identity stamped onto every telemetry row. Optional: without it
  // rows carry release "unknown", which is degraded but not broken. Falls
  // back to VERCEL_GIT_COMMIT_SHA automatically, so on Vercel it usually
  // need not be set at all.
  TELEMETRY_RELEASE: z.string().max(80).optional(),

  // Kill switch. Set to "true" to stop all telemetry writes without a
  // deploy — the first thing you want during a write-amplification
  // incident. Opt-OUT by design: telemetry that must be switched on is
  // telemetry that is off in the environment where it mattered.
  TELEMETRY_DISABLED: z.string().optional(),
```

Both are read via `process.env` directly in `lib/telemetry/report.ts` and the
ingest route (so that a missing env cannot throw inside an error handler); the
schema entries are for documentation and `.env.example` parity. Add them to
`.env.example` too.

### 3. `middleware.ts` — make `/api/telemetry` public

**Required.** Without it Clerk 401s every beacon, and the highest-volume signal
in the system is silently zero. Add to the public-route matcher alongside the
webhook routes:

```ts
  "/api/telemetry",
```

Note this route is *intentionally* reachable without a session — see the header
of `app/api/telemetry/route.ts`. It resolves the tenant from the session when
one exists and writes a NULL-tenant row otherwise.

### 4. `app/layout.tsx` (or the root app layout) — mount the reporter

```tsx
import { WebVitalsReporter } from "@/components/telemetry/web-vitals-reporter";
// …inside <body>, once:
<WebVitalsReporter />
```

**Mount it exactly once.** It has a module-level guard against a second mount,
but two mounts in two different layouts would double-count every metric and
silently halve the accuracy of every percentile.

### 5. `scripts/verify-security.ts` — add these assertions

Following the existing pattern for `payment_events`:

```
• error_events and web_vital_events: relrowsecurity AND relforcerowsecurity
• both policies have a non-null with_check
• error_events has both append-only triggers, tgenabled = 'O'
• telemetry_daily EXISTS and its reloptions @> ARRAY['security_invoker=true']
    ⭐ highest-value check in this phase — without security_invoker the view
      returns every tenant's telemetry to every caller
• these constraints exist:
    error_events_route_is_pattern, error_events_fingerprint_shape,
    web_vital_events_route_is_pattern, web_vital_events_value_sane
• zero rows from:
    SELECT 1 FROM error_events
     WHERE route_pattern LIKE '%?%' OR route_pattern LIKE '%://%'
• zero rows from:
    SELECT 1 FROM error_events
     WHERE message ~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
```

The exact SQL for all of these is Sections 6 Checks 1–8 of
`SQL-FILES/0011_phase19_telemetry.sql`; they can be copied verbatim.

### 6. `SQL-FILES/ALL-IN-ONE-SETUP.sql`

Append `0011_phase19_telemetry.sql` after the Phase 11 billing block. It depends
on `tenants`, `users` and `app_current_tenant_id()`, all of which exist by then,
and on PostgreSQL 15+ for `security_invoker`.

### 7. `CHANGELOG.md`

```
### Phase 19 — Telemetry & Observability (v0.12.0-alpha)
- Structured error tracking and Core Web Vitals collection, no third-party SDK.
- error_events (append-only) and web_vital_events, both under RLS with the
  payment_events NULL-tenant pattern.
- telemetry_daily: per-tenant daily health rollup, security_invoker.
- PII scrubbing with route patterning and stable error fingerprinting.
- Session replay explicitly OUT of scope — see docs/PHASE-19-NOTES.md.
```

### 8. No new npm dependencies were added

Confirmed: `package.json` is untouched. The reporter uses `PerformanceObserver`
and `navigator.sendBeacon` directly; fingerprinting uses a pure-JS hash. If you
later decide the INP approximation is not good enough, `web-vitals` is the
dependency to add — nothing else here needs one.
