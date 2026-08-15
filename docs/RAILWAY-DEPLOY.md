# Ordence on Railway

**v0.71.0-alpha · 4 August 2026**

This replaces `docs/CLOUDFLARE-DEPLOY.md` as the deployment reference. That
file is kept, not deleted — see "Why Cloudflare does not go away" below.

---

## What actually changed

Almost nothing in the application. Next.js runs natively on Node, which is
what Railway provides, so `next build` + `next start` is the whole runtime
story. No `@opennextjs/cloudflare` build step, no 10 MB Worker size ceiling,
no `wrangler deploy` replacing the variable set on every push.

Three things did change, and only one of them needed code.

### 1. File storage — needed code

On Cloudflare, `lib/storage/r2.ts` reached R2 through a Worker **binding**
(`env.DOCUMENTS`). A binding is an object Cloudflare injects into the
runtime. It does not exist anywhere else, so on Railway every upload and
download failed with "storage is not configured".

`lib/storage/s3.ts` reaches the **same R2 buckets** over the ordinary S3
protocol instead. Nothing was migrated and no object moved: R2 serves both
protocols against the same data.

> ⚠️ **Both backends are still present, and that is deliberate.**
> `resolveBackend()` tries the binding first and falls back to S3. A
> migration that deletes the old path the moment the new one is written has
> no way back — if the S3 credentials turn out to be wrong on the first real
> upload, the Cloudflare deployment that worked an hour ago no longer exists.

### 2. Scheduled work — needs a Railway cron

`worker.ts` exported a `scheduled()` handler. That is a Cloudflare Cron
Trigger and Railway has no equivalent binding.

The work itself is reachable over HTTP at `/api/workers`, authenticated by
`WORKER_API_SECRET` — it always was; the Cron Trigger was only one caller.
So the replacement is a Railway cron service that curls that endpoint. See
"Scheduled jobs" below.

Until that exists, `ORDENCE_INLINE_JOBS=1` keeps background work running
inside the request that triggers it. Slower, never silent.

### 3. The image optimiser — a security consequence, not a config one

> ⚠️ On Cloudflare Workers, Next's Node image optimiser was never invoked, so
> the bundled `sharp`/libvips advisory did not apply to the deployment.
> **On Railway it does.** `scripts/audit-gate.mjs` carries that exception
> with a deliberately short expiry rather than the old year-long one. It is
> not a theoretical change of platform; it is a change of exposure.

---

## Why Cloudflare does not go away

"Cloudflare" is three separate products here, and only one is being replaced.

| Product | Role | Status |
|---|---|---|
| **DNS for `ordence.com`** | Resolves the domain | **Stays.** This is how `app.ordence.com` finds Railway. |
| **R2 buckets** | Customer documents | **Stays.** Reached over S3 instead of a binding. |
| **The Worker** | Ran the application | **Retired** once Railway is verified. |

Deleting the Cloudflare zone takes the domain down. Deleting the R2 buckets
deletes customers' files.

---

## Environment variables

Railway has no equivalent of `wrangler.jsonc`, so every value below is set in
the Railway dashboard under **Variables**. That is an improvement: on
Cloudflare, a variable absent from `wrangler.jsonc` was silently deleted by
the next `wrangler deploy`.

### Required — the app will not work without these

| Name | Where it comes from |
|---|---|
| `DATABASE_URL` | Neon, pooled connection string |
| `DATABASE_URL_UNPOOLED` | Neon, direct connection string |
| `CLERK_SECRET_KEY` | Clerk → API keys |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk → API keys |
| `NEXT_PUBLIC_APP_URL` | `https://app.ordence.com` |
| `NEXT_PUBLIC_ROOT_DOMAIN` | `app.ordence.com` |
| `NEXT_PUBLIC_ZONE_DOMAIN` | `ordence.com` — without it, tenant subdomains and the staff console do not resolve |
| `PLATFORM_HOST` | `admin.ordence.com` |
| `PLATFORM_ADMIN_EMAILS` | Comma-separated staff addresses |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Clerk → Webhooks |

### File storage — all four, or uploads refuse

| Name | Value |
|---|---|
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | The R2 bucket holding documents |
| `S3_ACCESS_KEY_ID` | From an R2 API token |
| `S3_SECRET_ACCESS_KEY` | From the same token — shown once, at creation |

> ⚠️ `readS3Config()` returns null unless **all four** are present. Three of
> four is a misconfiguration, and treating it as configured would move the
> failure from a clear refusal at the gate to a signing error on the first
> upload in production.

### Recommended

| Name | Value | Why |
|---|---|---|
| `CSP_ENFORCE` | `false` | Report-only until violations have been collected. See `lib/security/csp.ts`. |
| `ORDENCE_INLINE_JOBS` | `1` | Runs background work inline until a cron service exists. |
| `WORKER_API_SECRET` | A long random string | Authenticates `/api/workers`. Required before the cron service is useful. |
| `RESEND_API_KEY` | Resend | Transactional email |
| `RESEND_FROM_EMAIL` | `Ordence <noreply@updates.ordence.com>` | Must be a verified Resend domain |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash | Without them the rate limiter is per-instance memory, which is a speed bump rather than a control |
| `CLERK_ENCRYPTION_KEY` | Any long random string | Clerk logs a warning without it |

### Not needed on Railway

`NEXT_INC_CACHE_R2_BUCKET`, `DOCUMENTS`, `JOB_QUEUE` — all Worker bindings.

---

## Scheduled jobs

Create a **second service** in the same Railway project:

- Source: the same repo
- **Cron schedule**: `0 1 * * *` (01:00 UTC)
- **Start command**:

  ```
  curl -fsS -X POST "$APP_URL/api/workers" \
    -H "Authorization: Bearer $WORKER_API_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"mode":"cron"}'
  ```

  > 🔴 **This command was wrong until v1.32.0** and could never have
  > worked. It sent `x-worker-secret`, a header the route does not read
  > — `app/api/workers/route.ts` accepts `Authorization: Bearer` — and
  > it sent no body, so even with correct authentication the route
  > returns 400 "Nothing to do" without `{"mode":"cron"}`. `-f` makes
  > curl exit non-zero, so the sweep has been failing loudly rather than
  > silently, which is the only good part of it.

- Variables: `APP_URL` = `https://app.ordence.com`, and the same
  `WORKER_API_SECRET` as the web service.

> ⚠️ `-f` matters. Without it `curl` exits 0 on an HTTP 500, so a failing
> nightly sweep reports success every night and nobody finds out until a
> month of contract-expiry notices never went out.

---

## What to check after the first deploy

```
https://app.ordence.com/api/health   → 200
https://app.ordence.com/api/diag     → "missingRequiredSettings": []
```

`/api/diag` reports which settings the running server can actually see. It
reports presence only, never values, and it is deliberately public — the
fault it exists to diagnose is one where signing in is what does not work.

Then, in the browser:

- `/dashboard` loads
- `admin.ordence.com` reaches the staff console
- Sign out returns to the home page without an error
- Upload a document, then download it again — this is the only real test of
  the S3 credentials

---

## Rolling back

The Cloudflare Worker is still deployable from this same repo:

```
npm run deploy
```

That builds with `@opennextjs/cloudflare` and pushes to Cloudflare exactly as
before. The storage layer prefers the R2 binding when it is present, so a
Cloudflare deployment keeps using the binding and needs none of the S3
variables.

Point DNS back at the Worker and the rollback is complete. Keep it that way
until an upload and a download have both been verified on Railway.
