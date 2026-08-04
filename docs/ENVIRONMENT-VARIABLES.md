# Ordence — Environment Variables, from the start

**v0.48.0 · 2 August 2026 · written to be followed by someone who is not a developer**

Every value. Where to get it. Which box to paste it into. In order.
Do not skip Part 0.

---

## Part 0 — Read this first, it may save you the whole exercise

### 0.1 The log you sent me is the old one

The build log you pasted has these timestamps:

```
21:11:38.152  →  21:14:30.487
Total Upload: 3184.53 KiB / gzip: 3184.53 KiB
```

Those are **byte-for-byte identical** to the v21 failure we looked at *before*
you bought the $5 Workers Paid plan. Same second, same byte count. A new build
cannot produce an identical timestamp.

So this is almost certainly the **old failed build still sitting at the top of
the screen** — not a new failure after the upgrade.

**Before you change a single variable, do this:**

1. Go to <https://dash.cloudflare.com>
2. Left sidebar → **Compute (Workers)** → click **app-ordence**
3. Click the **Deployments** tab
4. Look at the **newest** row. Check its **date and time** against your watch.

- If the newest build is **older than the moment you upgraded to Paid** → no
  post-upgrade deploy has happened yet. Push any commit (or click **Retry
  build**) and wait. The size error should be gone: your cap is now 10 MB and
  the bundle is 3.1 MB.
- If the newest build is **after the upgrade and still says
  `Script startup exceeded CPU limit` or a size error** → send me *that* log,
  not this one.

### 0.2 The environment variables are almost certainly fine

I looked at your Variables screenshot. Eleven entries, all correct, including
the two new ones. **A missing environment variable cannot cause a size error.**
The build never got as far as reading them.

So why do the full review anyway? Because there are three real problems in
there that will bite you *after* the deploy starts succeeding, and they are
much harder to diagnose then than now:

| | Problem | What it will look like when it bites |
|---|---|---|
| 1 | **`CLERK_WEBHOOK_SIGNING_SECRET` may be unset** | Sign-up works. No tenant is ever created. The user lands on a broken dashboard. Probably the cause of that `digest 817564861` error |
| 2 | **Three security secrets are missing entirely** (`CRON_SECRET`, `UPLOAD_TICKET_SECRET`, `WORKER_API_SECRET`) | File uploads refuse; scheduled jobs refuse — or worse, run for anyone who finds the URL |
| 3 | **Your Clerk keys are `pk_test_` / `sk_test_`** | Hard stop at 100 users. Cannot onboard a real customer |

Part 1 onwards fixes all three and verifies everything else.

---

## Part 1 — The one rule that explains every variable problem you have had

There are **two different places** a setting can live, and they behave in
opposite ways.

### Place A — `wrangler.jsonc` (a file in your GitHub repository)

This is where **non-secret** settings live.

> 🛑 **`wrangler deploy` REPLACES the Worker's entire configuration with this
> file.** Anything you type into the Cloudflare dashboard that is *not also in
> this file* is **DELETED** on the next successful deploy — silently, while the
> deploy reports success.

This is exactly what happened to you before: after every push, the three
Secrets survived and all four plaintext variables vanished, and it looked like
somebody had deleted them by hand. Nobody did. The deploy did.

### Place B — Cloudflare dashboard → Secrets

This is where **secret** settings live: passwords, API keys, signing secrets.

Cloudflare stores Secrets separately and **wrangler never touches them**. They
survive every deploy. They are also write-only — once saved, nobody, including
you, can read the value back. Only replace it.

### The rule, in one line

> **Not secret → `wrangler.jsonc`. Secret → Cloudflare Secrets. Never both,
> never the other way round.**

The reason plaintext variables must NOT be typed into the dashboard is not
tidiness. It is that doing so creates a setting that works today and
disappears on a Tuesday three weeks from now for no visible reason.

### Why a public key is not a secret

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` starts with `pk_` — *publishable*. It is
sent to every browser that loads your site; anyone can read it with View
Source. It is not a credential. Putting it in the repo is correct and
intended. The one that starts with `sk_` — *secret* — is the credential, and
it must never appear in a file.

---

## Part 2 — The complete list

Twenty-eight names. Grouped by whether the app is broken without them.

### Group 1 — REQUIRED. The app does not work without these.

| Name | Lives in | Where you get it |
|---|---|---|
| `DATABASE_URL` | 🔐 Secret | Neon |
| `DATABASE_URL_UNPOOLED` | 🔐 Secret | Neon |
| `CLERK_SECRET_KEY` | 🔐 Secret | Clerk |
| `CLERK_WEBHOOK_SIGNING_SECRET` | 🔐 Secret | Clerk |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | 📄 `wrangler.jsonc` | Clerk |
| `NEXT_PUBLIC_APP_URL` | 📄 `wrangler.jsonc` | You decide — `https://app.ordence.com` |
| `NEXT_PUBLIC_ROOT_DOMAIN` | 📄 `wrangler.jsonc` | You decide — `app.ordence.com` |
| `NEXT_PUBLIC_ZONE_DOMAIN` | 📄 `wrangler.jsonc` | You decide — `ordence.com` |
| `PLATFORM_HOST` | 📄 `wrangler.jsonc` | You decide — `admin.ordence.com` |
| `PLATFORM_ADMIN_EMAILS` | 📄 `wrangler.jsonc` | You decide — `Sahil@ordence.com` |

### Group 2 — SECURITY. Add these now. I have generated the values for you.

| Name | Lives in | What it protects |
|---|---|---|
| `UPLOAD_TICKET_SECRET` | 🔐 Secret | Signs upload links, so a link cannot be forged |
| `CRON_SECRET` | 🔐 Secret | Stops anyone who finds the URL from triggering scheduled jobs |
| `WORKER_API_SECRET` | 🔐 Secret | Authenticates the app calling its own internal endpoints |

### Group 3 — FEATURE SWITCHES. Missing = that one feature is inert.

| Name | Lives in | Feature |
|---|---|---|
| `ORDENCE_INLINE_JOBS` | 📄 `wrangler.jsonc` | Already set to `1`. Leave it |
| `RESEND_API_KEY` | 🔐 Secret | Email — demand notices, dunning, invites |
| `RESEND_FROM_EMAIL` | 📄 `wrangler.jsonc` | The "from" address on those emails |
| `RAZORPAY_KEY_ID` | 📄 `wrangler.jsonc` | Subscription billing |
| `RAZORPAY_KEY_SECRET` | 🔐 Secret | Subscription billing |
| `RAZORPAY_WEBHOOK_SECRET` | 🔐 Secret | Confirms a payment actually happened |
| `UPSTASH_REDIS_REST_URL` | 📄 `wrangler.jsonc` | Caching and rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | 🔐 Secret | Caching and rate limiting |

### Group 4 — YOUR OWN TAX IDENTITY. Needed only when you invoice a customer.

These are **Ordence's** details as the seller, not any client's.

| Name | Lives in | Example |
|---|---|---|
| `PLATFORM_LEGAL_NAME` | 📄 `wrangler.jsonc` | Your registered company name, exactly as on the GST certificate |
| `PLATFORM_GSTIN` | 📄 `wrangler.jsonc` | Your 15-character GSTIN |
| `PLATFORM_GST_STATE_CODE` | 📄 `wrangler.jsonc` | First 2 digits of that GSTIN — `29` for Karnataka, `27` Maharashtra |
| `PLATFORM_ADDRESS` | 📄 `wrangler.jsonc` | Registered address, one line |
| `PLATFORM_INVOICE_PREFIX` | 📄 `wrangler.jsonc` | e.g. `ORD` |

### Group 5 — NEVER put these in Cloudflare

| Name | Why not |
|---|---|
| `TEST_DATABASE_URL` | Points at the test database. In production it would let tests wipe live data |
| `TEST_ADMIN_DATABASE_URL` | Same |
| `DRILL_DATABASE_URL` | Same |
| `SEED_ALLOW_PROD` | Its only purpose is to let a seed script run against production |
| `STRIPE_SECRET_KEY` | Not used. Razorpay handles India |
| `STRIPE_WEBHOOK_SECRET` | Not used |
| `QSTASH_*` | Not used yet |

---

## Part 3 — Getting every value, step by step

Do these in order. Have a plain text file open to paste values into as you go;
some of these screens show a value once and never again.

---

### 3.1 NEON — the database (2 values)

**Link:** <https://console.neon.tech>

1. Sign in. You land on the project list. Click your Ordence project.
2. On the project overview there is a **Connect** button, top right of the
   Connection Details box. Click it.
3. A panel opens with a dropdown for **branch**, **database**, and **role**.
   - Branch: `main` (or `production` if you renamed it)
   - Database: your database name
   - Role: your role
4. Below that is a toggle labelled **Pooled connection** or a dropdown labelled
   **Connection type**.

**Value 1 — `DATABASE_URL`**

- Make sure **Pooled connection is ON** (connection type = *Pooled connection*).
- The string shown will contain **`-pooler`** in the middle. That is how you
  confirm you have the right one:
  `postgresql://…@ep-something-**pooler**.ap-southeast-1.aws.neon.tech/…`
- Click the copy icon. Paste it into your text file, labelled `DATABASE_URL`.

**Value 2 — `DATABASE_URL_UNPOOLED`**

- Turn **Pooled connection OFF** (connection type = *Direct connection*).
- The string now has **no** `-pooler`.
- Copy. Label it `DATABASE_URL_UNPOOLED`.

> ⚠️ Both strings must end with `?sslmode=require`. If yours does not, add it.
> Without it the Worker cannot connect and the error message is about TLS, not
> about the missing parameter.

> ⚠️ If the password shown is `****` or hidden, click **Reset password** — but
> read Part 6 first, because resetting it invalidates the string you are
> currently running on.

---

### 3.2 CLERK — sign-in (3 values)

**Link:** <https://dashboard.clerk.com>

#### First, decide: Development or Production?

Look at the top of the Clerk dashboard. There is a pill that says
**Development** or **Production**.

Your current keys start with `pk_test_` and `sk_test_`, so you are on a
**Development** instance. That is:

- capped at **100 users**, permanently
- served from `pretty-shrew-42.clerk.accounts.dev`, not your domain
- **not usable for a paying customer**

**You must create a Production instance before onboarding anyone real.** You do
not have to do it today, but do not build any further on the assumption that
the test keys will carry over — they will not, and every user created on the
development instance stays there.

To create it: the environment pill at the top → **Create production instance**.
Clerk will ask you to add DNS records to `ordence.com`. Since your DNS is
already at Cloudflare, that is Cloudflare dashboard → **ordence.com** → **DNS**
→ **Add record**, copying each name/value Clerk shows you. Clerk verifies them
automatically, usually within a few minutes.

Whichever instance you use, the next three steps are the same.

**Value 3 — `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`**

1. Left sidebar → **Configure** → **API keys**
   (direct: <https://dashboard.clerk.com/last-active?path=api-keys>)
2. The first box is **Publishable key**. Starts with `pk_test_` or `pk_live_`.
3. Copy it.

**Value 4 — `CLERK_SECRET_KEY`**

1. Same page, box below. **Secret key**, starts with `sk_test_` or `sk_live_`.
2. Click the eye icon to reveal, then copy.
3. This one is a real credential. It goes in Secrets, never in a file.

**Value 5 — `CLERK_WEBHOOK_SIGNING_SECRET`** ← *the one most likely missing*

1. Left sidebar → **Configure** → **Webhooks**
   (direct: <https://dashboard.clerk.com/last-active?path=webhooks>)
2. **If there is no endpoint listed**, click **Add Endpoint**:
   - **Endpoint URL:** `https://app.ordence.com/api/webhooks/clerk`
   - **Subscribe to events:** tick `user.created`, `user.updated`,
     `organization.created`, `organization.updated`,
     `organizationMembership.created`
   - Click **Create**
3. Click the endpoint. On its page find **Signing Secret**. Click to reveal.
4. It starts with **`whsec_`**. Copy it.

> This is the value that decides whether a new sign-up ever becomes a tenant in
> your database. Without it the webhook arrives, fails verification, and is
> discarded — and the only symptom is a user with no company.

---

### 3.3 THE THREE SECURITY SECRETS — I generated these for you (3 values)

These are not obtained from any website. They are random strings that only your
Worker knows. I generated them with a cryptographic random number generator —
**copy these exactly**:

```
UPLOAD_TICKET_SECRET   =   1GSZtlO8JT_N86zG9Dqjjcdfw6gIpSOkvphc_uUpNeg
CRON_SECRET            =   sTHq4KNKEDFqiqdfq7sQQnvZGM6mQ40SpI0VIZeuYBc
WORKER_API_SECRET      =   Eg4ymJs0yVapH0xPdwvIyGZcYrl6AEc6Bx453EJSlf0
```

> ⚠️ These are now written in this document, which is on your disk. That is
> fine for today. If this file is ever shared, emailed, or committed to git,
> regenerate all three. There is a command for it in Part 6.

---

### 3.4 RESEND — email (2 values) · *optional, do it when you want email working*

**Link:** <https://resend.com>

1. Sign up / sign in.
2. Left sidebar → **Domains** → **Add Domain**. Enter `ordence.com`.
3. Resend shows you three DNS records (an MX, and two TXT for DKIM and SPF).
4. Add each one at Cloudflare: dashboard → **ordence.com** → **DNS** → **Add
   record**. Copy the Type, Name and Value exactly.
   - ⚠️ Set the proxy status to **DNS only** (grey cloud, not orange) for these.
     Proxying a mail record breaks it.
5. Back in Resend, click **Verify**. Wait until it goes green.
6. Left sidebar → **API Keys** → **Create API Key**.
   - Name: `ordence-production`
   - Permission: **Sending access**
   - Domain: `ordence.com`
7. **Value 6 — `RESEND_API_KEY`**: shown **once**. Starts with `re_`. Copy it
   now; you cannot see it again.
8. **Value 7 — `RESEND_FROM_EMAIL`**: you choose. Use
   `Ordence <noreply@ordence.com>`.

---

### 3.5 RAZORPAY — billing (3 values) · *optional, do it when you charge someone*

**Link:** <https://dashboard.razorpay.com>

1. Sign in. Top-right has a **Test / Live** toggle. Use **Test** until you are
   genuinely ready to take money.
2. Left sidebar → **Account & Settings** → **API Keys** → **Generate Key**.
3. **Value 8 — `RAZORPAY_KEY_ID`**: starts `rzp_test_` or `rzp_live_`. Not
   secret — it goes in the file.
4. **Value 9 — `RAZORPAY_KEY_SECRET`**: shown **once**, in the same download.
   Save it now. Secret.
5. Left sidebar → **Account & Settings** → **Webhooks** → **Add New Webhook**:
   - **URL:** `https://app.ordence.com/api/webhooks/razorpay`
   - **Secret:** type any strong random string and **write it down** — Razorpay
     does not generate it, you invent it
   - **Active Events:** `payment.captured`, `payment.failed`,
     `subscription.charged`, `subscription.cancelled`
6. **Value 10 — `RAZORPAY_WEBHOOK_SECRET`**: the string you just invented.

---

### 3.6 UPSTASH — caching (2 values) · *optional, skip for now*

**Link:** <https://console.upstash.com>

1. **Create Database** → Type **Regional** → region closest to your Neon region.
2. Open it, scroll to **REST API**.
3. **Value 11 — `UPSTASH_REDIS_REST_URL`** — the `https://…upstash.io` line.
4. **Value 12 — `UPSTASH_REDIS_REST_TOKEN`** — click the eye icon, copy.

---

### 3.7 YOUR GST DETAILS — from your own paperwork (5 values)

Not from any website. From your GST registration certificate.

- `PLATFORM_LEGAL_NAME` — the **Legal Name of Business** field on the
  certificate. Not your trading name, not "Ordence" unless that is what the
  certificate says.
- `PLATFORM_GSTIN` — the 15-character number.
- `PLATFORM_GST_STATE_CODE` — the **first two digits** of that GSTIN. Karnataka
  `29`, Maharashtra `27`, Delhi `07`, Tamil Nadu `33`, Gujarat `24`.
- `PLATFORM_ADDRESS` — principal place of business, one line.
- `PLATFORM_INVOICE_PREFIX` — you choose. `ORD` is fine.

> If you are not GST-registered yet, leave all five out. The platform-invoice
> feature stays inert; nothing else is affected.

---

## Part 4 — Where each value goes

Now you have the values. Two destinations.

---

### 4.1 Secrets → Cloudflare dashboard

**Exact path:**

1. <https://dash.cloudflare.com>
2. Left sidebar → **Compute (Workers)**
3. Click **app-ordence**
4. Top tabs → **Settings**
5. Scroll to **Variables and Secrets**
6. For each one below: **+ Add** → set **Type** to **Secret** → paste the name
   → paste the value → **Save**

> ⚠️ **Type must be Secret, not Text.** A credential saved as Text is readable
> by anyone with dashboard access *and* gets deleted by the next deploy. Both
> failures at once.

Add these, in this order:

| # | Name | Type | Value from |
|---|---|---|---|
| 1 | `DATABASE_URL` | **Secret** | 3.1 |
| 2 | `DATABASE_URL_UNPOOLED` | **Secret** | 3.1 |
| 3 | `CLERK_SECRET_KEY` | **Secret** | 3.2 |
| 4 | `CLERK_WEBHOOK_SIGNING_SECRET` | **Secret** | 3.2 |
| 5 | `UPLOAD_TICKET_SECRET` | **Secret** | 3.3 |
| 6 | `CRON_SECRET` | **Secret** | 3.3 |
| 7 | `WORKER_API_SECRET` | **Secret** | 3.3 |
| 8 | `RESEND_API_KEY` | **Secret** | 3.4 — skip if not doing email |
| 9 | `RAZORPAY_KEY_SECRET` | **Secret** | 3.5 — skip if not billing |
| 10 | `RAZORPAY_WEBHOOK_SECRET` | **Secret** | 3.5 — skip if not billing |
| 11 | `UPSTASH_REDIS_REST_TOKEN` | **Secret** | 3.6 — skip |

**Then delete anything set as plain Text on that screen.** Every one of them
belongs in `wrangler.jsonc` instead, and leaving a duplicate there is how you
end up debugging a value that is right in one place and stale in the other.

---

### 4.2 Non-secrets → `wrangler.jsonc` in your repository

Open `ordence/wrangler.jsonc`. Find the block that starts `"vars": {`. Replace
that whole block with this — filling in your own GST details, or deleting those
five lines if you are not registered:

```jsonc
  "vars": {
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": "pk_test_cHJldHR5LXNocmV3LTQyLmNsZXJrLmFjY291bnRzLmRldiQ",
    "NEXT_PUBLIC_APP_URL": "https://app.ordence.com",
    "NEXT_PUBLIC_ROOT_DOMAIN": "app.ordence.com",
    "NEXT_PUBLIC_ZONE_DOMAIN": "ordence.com",
    "PLATFORM_HOST": "admin.ordence.com",
    "PLATFORM_ADMIN_EMAILS": "Sahil@ordence.com",
    "ORDENCE_INLINE_JOBS": "1"
  },
```

That is exactly what is in there now — which is the point. **Your plaintext
variables are correct.** Nothing to change today.

When you turn on email, billing or GST invoicing, add the non-secret half of
each pair to this same block:

```jsonc
    "RESEND_FROM_EMAIL": "Ordence <noreply@ordence.com>",
    "RAZORPAY_KEY_ID": "rzp_test_XXXXXXXXXXXX",
    "UPSTASH_REDIS_REST_URL": "https://xxxx.upstash.io",
    "PLATFORM_LEGAL_NAME": "Your Company Private Limited",
    "PLATFORM_GSTIN": "29AAAAA0000A1Z5",
    "PLATFORM_GST_STATE_CODE": "29",
    "PLATFORM_ADDRESS": "Your address, City, State PIN",
    "PLATFORM_INVOICE_PREFIX": "ORD"
```

> ⚠️ **Never put a Secret in this file.** It is committed to GitHub. If you
> paste `sk_live_…` or a database password here, it is published — and git
> keeps it in history even after you delete the line.

---

## Part 5 — Verify. This is the part people skip.

I extended the diagnostic endpoint this version so it now checks **all
twenty-eight names**, not seven.

After your next successful deploy, open this in a browser:

**<https://app.ordence.com/api/diag>**

It returns JSON. It never shows a value — only whether each one is visible to
the running Worker, and how many characters long it is (enough to catch a
truncated paste, useless to a thief).

**What good looks like:**

```json
{
  "missing": [],
  "database": { "connected": true, "tables": 180, "policies": 300 },
  "transaction": { "ok": true }
}
```

**How to read it:**

| What you see | What it means | What to do |
|---|---|---|
| `"missing": []` | Every REQUIRED name is present | Nothing |
| `"missing": ["CLERK_WEBHOOK_SIGNING_SECRET"]` | That one is not set | Part 3.2, then 4.1 |
| `"length": 0` on a name | Saved, but empty — a paste that did not take | Re-paste it |
| `"length"` much shorter than expected | Truncated paste | Re-copy the whole string |
| `database.connected: false` | Wrong password, or `?sslmode=require` missing | Redo 3.1 |
| `database.tables: 0` | Connected to the wrong database, or the schema was never created | Check the database name in the connection string |
| `transaction.ok: false` but `database.connected: true` | The pooled string is wrong, or you swapped the two | Redo 3.1 carefully — `-pooler` in `DATABASE_URL` |

> The last row is the one worth understanding. Those are two **different**
> connection methods. Sign-in can work while every signed-in page is broken,
> because tenant isolation runs over the second one. A check that only tested
> the first would report a healthy deployment.

---

## Part 6 — Rotate the exposed credentials

Separately from all of the above: several live credentials passed through chat
during setup, and four OpenRouter keys are sitting in a tracked file. Treat
every one as compromised.

**Do this after the deploy is green, not before** — rotating a key while
deploys are failing means you cannot tell which change broke what.

### Order matters. Do them one at a time and verify between each.

**1. The four OpenRouter keys** — <https://openrouter.ai/keys>
Delete each one. Create replacements only if something actually uses them. They
are billable; a leaked one gets used.
Then remove them from `AMEYA-CRM-MASTER-DETAILS.md` **and** rewrite the git
history, or the file stays readable in every old commit.

**2. The Clerk secret key** — Clerk → **API keys** → the `sk_` box → **Regenerate**
Immediately paste the new value into Cloudflare Secrets. There is a gap of a
few seconds where sign-in fails. Do it at a quiet hour.

**3. The Clerk webhook secret** — Clerk → **Webhooks** → your endpoint →
**Roll secret**. Paste the new `whsec_` into Cloudflare Secrets.

**4. The Neon password** — Neon → project → **Roles** → your role → **Reset
password**. Neon shows the new connection string **once**. Copy both the pooled
and unpooled forms and update **both** Cloudflare Secrets before doing anything
else. Getting only one of the two is the classic way to end up with sign-in
working and the dashboard dead.

**To regenerate the three secrets from 3.3** (only if this document leaks),
run this on your machine and use the three lines it prints:

```bash
node -e "const c=require('crypto');for(const n of ['CRON_SECRET','UPLOAD_TICKET_SECRET','WORKER_API_SECRET'])console.log(n+' = '+c.randomBytes(32).toString('base64url'))"
```

---

## Part 7 — The checklist

Tick these off in order.

- [ ] **0.1** — Checked the Deployments tab. Confirmed whether the newest build
      is before or after the Paid upgrade
- [ ] **3.1** — Both Neon strings copied. `-pooler` in one, not the other. Both
      end `?sslmode=require`
- [ ] **3.2** — Clerk publishable key, secret key, **and webhook signing
      secret** copied. Webhook endpoint exists and points at
      `https://app.ordence.com/api/webhooks/clerk`
- [ ] **3.3** — Three generated secrets copied
- [ ] **4.1** — All seven required Secrets saved in Cloudflare with Type =
      **Secret**
- [ ] **4.1** — Any leftover plain-Text entries on that screen deleted
- [ ] **4.2** — `wrangler.jsonc` `vars` block matches Part 4.2 (it already does)
- [ ] Deploy. Wait for green
- [ ] **5** — `/api/diag` opened. `missing` is `[]`, `connected` true,
      `transaction.ok` true
- [ ] Sign up a brand-new test user. Confirm a row appears in `tenants`. This is
      the only real test of the webhook secret
- [ ] **6** — Rotate the OpenRouter keys, Clerk secret, webhook secret, Neon
      password — in that order, verifying between each
- [ ] Create the Clerk **Production** instance before the first paying customer

---

## Appendix — Every name, one table

| Name | Where | Required? | Source |
|---|---|---|---|
| `DATABASE_URL` | 🔐 Secret | ✅ | Neon → Connect → **Pooled** |
| `DATABASE_URL_UNPOOLED` | 🔐 Secret | ✅ | Neon → Connect → **Direct** |
| `CLERK_SECRET_KEY` | 🔐 Secret | ✅ | Clerk → API keys |
| `CLERK_WEBHOOK_SIGNING_SECRET` | 🔐 Secret | ✅ | Clerk → Webhooks → Signing Secret |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | 📄 file | ✅ | Clerk → API keys |
| `NEXT_PUBLIC_APP_URL` | 📄 file | ✅ | `https://app.ordence.com` |
| `NEXT_PUBLIC_ROOT_DOMAIN` | 📄 file | ✅ | `app.ordence.com` |
| `NEXT_PUBLIC_ZONE_DOMAIN` | 📄 file | ✅ | `ordence.com` |
| `PLATFORM_HOST` | 📄 file | ✅ | `admin.ordence.com` |
| `PLATFORM_ADMIN_EMAILS` | 📄 file | ✅ | `Sahil@ordence.com` |
| `UPLOAD_TICKET_SECRET` | 🔐 Secret | 🔒 | Generated — Part 3.3 |
| `CRON_SECRET` | 🔐 Secret | 🔒 | Generated — Part 3.3 |
| `WORKER_API_SECRET` | 🔐 Secret | 🔒 | Generated — Part 3.3 |
| `ORDENCE_INLINE_JOBS` | 📄 file | ➖ | `1` — already set |
| `RESEND_API_KEY` | 🔐 Secret | ➖ | Resend → API Keys |
| `RESEND_FROM_EMAIL` | 📄 file | ➖ | You choose |
| `RAZORPAY_KEY_ID` | 📄 file | ➖ | Razorpay → API Keys |
| `RAZORPAY_KEY_SECRET` | 🔐 Secret | ➖ | Razorpay → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` | 🔐 Secret | ➖ | You invent it |
| `UPSTASH_REDIS_REST_URL` | 📄 file | ➖ | Upstash → REST API |
| `UPSTASH_REDIS_REST_TOKEN` | 🔐 Secret | ➖ | Upstash → REST API |
| `PLATFORM_LEGAL_NAME` | 📄 file | ➖ | GST certificate |
| `PLATFORM_GSTIN` | 📄 file | ➖ | GST certificate |
| `PLATFORM_GST_STATE_CODE` | 📄 file | ➖ | First 2 digits of GSTIN |
| `PLATFORM_ADDRESS` | 📄 file | ➖ | GST certificate |
| `PLATFORM_INVOICE_PREFIX` | 📄 file | ➖ | You choose |
| `TEST_DATABASE_URL` | ❌ local only | — | Never in Cloudflare |
| `TEST_ADMIN_DATABASE_URL` | ❌ local only | — | Never in Cloudflare |
| `DRILL_DATABASE_URL` | ❌ local only | — | Never in Cloudflare |
| `SEED_ALLOW_PROD` | ❌ never | — | Never anywhere |

✅ app broken without it · 🔒 security · ➖ one feature inert without it
