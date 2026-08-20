# Environment settings, as they actually are

Track H, wave H6. Measured against the live Railway production service on
20 August 2026, using variable NAMES only. **No value was read, and the
tool that produced this cannot read one.**

Regenerate with:

```
railway variables --json | jq -r 'keys[]' > /tmp/have.txt
node scripts/report-env-drift.mjs --have /tmp/have.txt
```

---

## The state today

- **7 required, all 7 set.** Nothing is missing that stops the app
  starting.
- 62 optional catalogued, 35 of them not set.
- 35 names set in total, 1 of which the catalogue does not list:
  `NODE_ENV`, which the platform injects. Not a fault.

So there is no emergency here. What follows is the list of features that
are OFF because nothing configured them, which is a different thing from
broken and is worth knowing before somebody reports it as a bug.

---

## Features that are off, and what that means

**Your own invoicing is not configured.**
`PLATFORM_GSTIN`, `PLATFORM_LEGAL_NAME`, `PLATFORM_ADDRESS`,
`PLATFORM_INVOICE_PREFIX` are unset. Ordence bills tenants; an invoice it
issues without a GSTIN and a legal name is not a valid tax invoice in
India. This is the most consequential item on the page and it is quiet.

**No payment provider is configured.**
Neither the Stripe nor the Razorpay names are set. Subscriptions,
therefore, cannot actually be charged. Correct if you are not yet
charging; a surprise if you think you are.

**Trial and dunning windows are on their defaults.**
`NEXT_PUBLIC_ORDENCE_TRIAL_GRACE_DAYS`,
`NEXT_PUBLIC_ORDENCE_TRIAL_NOTICE_DAYS`,
`NEXT_PUBLIC_ORDENCE_DUNNING_GRACE_DAYS` unset. Whatever the code's
default is, that is your policy. Worth confirming it is the policy you
intend, since it decides when a customer loses access.

**Release identification is half configured.**
`TELEMETRY_RELEASE` is set, `NEXT_PUBLIC_RELEASE` is not. Errors from the
browser may not be attributable to a version.

**Alerting has no finance recipient.** `FINANCE_ALERT_EMAILS` unset.

**One AI provider of eight.** `OPENROUTER_API_KEY` is set; Cerebras,
Cohere, Google, Groq, Mistral, GitHub Models and Cloudflare are not. Fine
if OpenRouter is the intended route; the catalogue implies choice.

**No unpooled database URL.** `DATABASE_URL_UNPOOLED` is read by
migration tooling, not by the running app. Its absence is why migrations
are run by hand in the Neon console, which is the current process anyway.

**Edge rate limiting is on its defaults.** `EDGE_LIMIT_MODE` and
`EDGE_LIMIT_PLATFORM_FAIL_OPEN` unset. The second of those decides
whether the platform limiter fails open. Read the code before assuming.

---

## Two absences that are CORRECT and should stay

**`SENTRY_AUTH_TOKEN` is not set, and must never be.** It is a build-time
credential. A runtime deployment has no use for it and setting it puts a
token where the application can read it.

**`SEED_ALLOW_PROD` is not set, and must never be.** Its name is its
warning.

---

## What is set that deserves a note

**`CRON_SECRET` and `WORKER_API_SECRET` are set.** Somebody prepared for
scheduled work. Nothing currently calls it on a schedule, which means the
door exists and nobody knocks. When Track A lands, this is the shared
secret it should be using rather than inventing another.

**`ORDENCE_INLINE_JOBS` is set.** Worth checking its value points the way
you expect once a real scheduler exists, because inline and scheduled
execution of the same job is how a job runs twice.

**`CSP_ENFORCE` is set** but `CSP_REPORT_URI` is not, so policy
violations are blocked and never reported. You will find out about a
broken page from a user rather than from a report.

---

## The rule this page exists to serve

A missing setting presents as a deployment that builds, ships an image,
starts, and dies with an empty log. That has happened here once and cost
a day to attribute. `check:env-drift` turns that into a line of output.

It reads names and refuses a file containing values, with a test
asserting it does not echo a value back even while complaining about it.
