# Ordence — Every link you need, for rotating everything

**2 August 2026.** Companion to `ENVIRONMENT-VARIABLES.md`. This file is links only.

Your Cloudflare account ID is `ad6dd0d6cb1513eea62c34d216c9ef66`, so every
Cloudflare link below goes straight to *your* Worker, not a generic page.

---

## First — two things your screenshots just proved

### ✅ The deploys are working now

Recent builds shows **v23 green, 47m ago** and **v22 green, 1h ago**. The Paid
plan fixed the size problem. The log you sent me earlier was indeed the old
pre-upgrade one. Nothing more to do about deploys.

### 🔴 `CLERK_WEBHOOK_SIGNING_SECRET` has been deleted

Your Deployments list shows, 22 hours ago:

```
77aaad62   Add variable: CLERK_WEBHOOK_SIGNING_SECRET   Dashboard   by sahil
```

Your Variables screen right now shows **ten** entries, and that is not one of
them. Three Secrets (`CLERK_SECRET_KEY`, `DATABASE_URL`,
`DATABASE_URL_UNPOOLED`) and seven Plaintext. The webhook secret is gone.

It was added as **Plaintext**, not Secret. The v22 and v23 deploys — the first
two that ever *succeeded* — replaced the Worker's config from `wrangler.jsonc`,
and it was not in that file, so it was deleted. Cloudflare's own panel warns
about this in your third screenshot:

> *Update your **wrangler config** file with these changes to keep your local
> development environment in sync*

**This is why sign-ups create no tenant, and the most likely cause of the
`/dashboard` digest `817564861` error.** When you re-add it, the Type dropdown
must say **Secret**. Secrets survive deploys. Plaintext does not.

---

## 1. Cloudflare — where everything gets pasted

| What | Link |
|---|---|
| **Variables and secrets** (the one you need) | <https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/workers/services/view/app-ordence/production/settings> |
| Deployments & build logs | <https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/workers/services/view/app-ordence/production/deployments> |
| Live logs (to read a runtime error) | <https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/workers/services/view/app-ordence/production/observability> |
| R2 buckets (`ordence-cache`, `ordence-documents`) | <https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/r2/overview> |
| DNS for ordence.com (for Clerk & Resend records) | <https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/ordence.com/dns/records> |
| Your own Cloudflare API tokens (rotate if any leaked) | <https://dash.cloudflare.com/profile/api-tokens> |

---

## 2. Neon — `DATABASE_URL`, `DATABASE_URL_UNPOOLED`

| What | Link |
|---|---|
| Console (pick your project) | <https://console.neon.tech> |
| Project list | <https://console.neon.tech/app/projects> |

Inside your project:

- **To get the strings:** project overview → **Connect** button → toggle
  **Pooled connection** ON for `DATABASE_URL` (string contains `-pooler`),
  OFF for `DATABASE_URL_UNPOOLED` (no `-pooler`).
- **To rotate the password:** left sidebar → **Settings** → **Roles** (or
  **Branches → main → Roles**) → your role → **Reset password**.

> ⚠️ Resetting shows the new string **once**. Copy **both** the pooled and the
> unpooled form before you close it. Updating only one leaves sign-in working
> and every signed-in page dead — two different connection methods.

Both strings must end `?sslmode=require`.

---

## 3. Clerk — `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, publishable key

Clerk's `~` in a URL means "my last-active instance", so these open directly.

| What | Link |
|---|---|
| Dashboard home | <https://dashboard.clerk.com> |
| **API keys** — publishable + secret key | <https://dashboard.clerk.com/~/api-keys> |
| **Webhooks** — the signing secret you are missing | <https://dashboard.clerk.com/~/webhooks> |
| Domains (needed for the production instance) | <https://dashboard.clerk.com/~/domains> |

**To rotate the secret key:** API keys page → the `sk_…` box → **Regenerate**.

**To get the webhook secret:** Webhooks page →
- if no endpoint exists, **Add Endpoint**, URL
  `https://app.ordence.com/api/webhooks/clerk`, subscribe to `user.created`,
  `user.updated`, `organization.created`, `organizationMembership.created`
- click the endpoint → **Signing Secret** → reveal → copy. Starts `whsec_`.
- to rotate an existing one: same page → **Roll secret**.

**Production instance** (before your first paying customer — the test keys cap
you at 100 users and do not migrate): environment pill at the top of the
dashboard → **Create production instance**. It gives you DNS records to add at
the Cloudflare DNS link in section 1.

---

## 4. OpenRouter — the four leaked keys

| What | Link |
|---|---|
| **Keys** — delete all four here | <https://openrouter.ai/settings/keys> |
| Usage & spend (check nothing ran up a bill) | <https://openrouter.ai/activity> |
| Credits | <https://openrouter.ai/settings/credits> |

Delete each key. Only create replacements if something actually calls
OpenRouter — Ordence currently does not. Then remove them from
`AMEYA-CRM-MASTER-DETAILS.md` **and** purge them from git history, or they stay
readable in every old commit.

---

## 5. Resend — `RESEND_API_KEY`

| What | Link |
|---|---|
| API keys | <https://resend.com/api-keys> |
| Domains (verify `ordence.com`) | <https://resend.com/domains> |

DNS records Resend gives you go in at the Cloudflare DNS link in section 1, set
to **DNS only** (grey cloud). The key is shown once, starts `re_`.

---

## 6. Razorpay — `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, webhook secret

| What | Link |
|---|---|
| Dashboard | <https://dashboard.razorpay.com> |
| API keys | <https://dashboard.razorpay.com/app/website-app-settings/api-keys> |
| Webhooks | <https://dashboard.razorpay.com/app/webhooks> |

Key secret is shown once. The **webhook secret is one you invent** — Razorpay
does not generate it; type a strong random string and save it in both places.

---

## 7. Upstash — Redis (optional, not set up yet)

| What | Link |
|---|---|
| Console | <https://console.upstash.com> |
| Redis databases | <https://console.upstash.com/redis> |

---

## 8. GitHub — where `wrangler.jsonc` lives

| What | Link |
|---|---|
| Personal access tokens (rotate if any leaked) | <https://github.com/settings/tokens> |

If any secret was ever committed, deleting the line is not enough. Use
`git filter-repo` or GitHub Support to purge history, then rotate the secret
anyway — assume it was scraped.

---

## The order to do it in

Do these **one at a time**, checking `https://app.ordence.com/api/diag` between
each. Rotating several at once means a failure tells you nothing about which
one caused it.

1. **Re-add `CLERK_WEBHOOK_SIGNING_SECRET` as a Secret** — section 3.
   This one is a fix, not a rotation. Do it first; it costs nothing and
   probably repairs sign-up.
2. **Add the three generated secrets** — `UPLOAD_TICKET_SECRET`,
   `CRON_SECRET`, `WORKER_API_SECRET`, values in `ENVIRONMENT-VARIABLES.md`
   Part 3.3. Type = **Secret**.
3. **Delete the four OpenRouter keys** — section 4. Zero risk, nothing uses them.
4. **Roll the Clerk webhook secret** — section 3. Update Cloudflare immediately.
5. **Regenerate the Clerk secret key** — section 3. A few seconds of failed
   sign-ins; do it at a quiet hour.
6. **Reset the Neon password** — section 2. Update **both** database Secrets
   before anything else. This is the one with a real outage window.

After all six: sign up a brand-new test user and confirm a row appears in
`tenants`. That is the only test that proves the webhook secret is right.

---

## The rule, once more, because it is what bit you

> **Not secret → `wrangler.jsonc` in the repo.
> Secret → Cloudflare, with Type set to Secret.**
>
> A value typed into the dashboard as **Plaintext** and absent from
> `wrangler.jsonc` is **deleted by the next successful deploy** — silently,
> while the deploy reports success. That is exactly what happened to
> `CLERK_WEBHOOK_SIGNING_SECRET` between v21 and v23.
