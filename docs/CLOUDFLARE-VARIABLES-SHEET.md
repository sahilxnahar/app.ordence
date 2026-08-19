# Ordence — Cloudflare setup sheet (v2)

> ⚠️ **A LIVE DATABASE PASSWORD USED TO BE WRITTEN OUT IN THIS FILE.**
> It has been replaced with `<YOUR-NEON-PASSWORD>`. Treat the old one as
> burned and rotate it in Neon → Roles → Reset password. A credential in a
> file inside the repository is a credential in every clone, every backup
> and every deploy tarball — the redaction below removes it going forward,
> it does not un-share it.

**⚠️ This file contains passwords. Keep it OUT of your GitHub folder.**

---

## 🎉 What changed in this version

**You no longer need the "Build variables and secrets" list.** Ignore
everything I said earlier about entering the same seven values twice.

The old code checked for its settings *while being assembled*. On Cloudflare
the assembling happens on one machine and the running happens on another, so
settings attached to the Worker were invisible at assembly time — which is
exactly why your build died on `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.

The new code reads its settings **when a visitor loads a page** instead. I
have verified this by building it here with **no environment variables set at
all** — it completes cleanly.

**One list. Seven values. The list you have already filled in.**

---

# Step 1 — Fix two wrong values

You already have all seven entered under **Settings → Variables and secrets**.
Two of them are wrong.

### `DATABASE_URL` — currently has the OLD password

It reads `…<YOUR-NEON-PASSWORD>@…`. You reset that password; it no longer opens
anything. Click the ✏️ pencil and replace the whole value with:

```
postgresql://neondb_owner:<YOUR-NEON-PASSWORD>@ep-raspy-math-azduzr7s-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

### `DATABASE_URL_UNPOOLED` — has the words `YOUR_PASSWORD` in it

The placeholder got pasted literally. Replace the whole value with:

```
postgresql://neondb_owner:<YOUR-NEON-PASSWORD>@ep-raspy-math-azduzr7s.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

> Both now use `<YOUR-NEON-PASSWORD>`. The first has `-pooler`, the second does
> not. That is the only difference between the two lines.

### While you are editing — change three of them to Secret

Every row currently says **Plaintext**, which means anyone who ever opens
that dashboard page can read your database password in full. Use the pencil
on each of these and switch the type to **Secret**:

- `CLERK_SECRET_KEY`
- `DATABASE_URL`
- `DATABASE_URL_UNPOOLED`

The other four are public values and can stay as Plaintext.

---

# Step 2 — Fix the build commands

**Settings → scroll to the `Build` section.**

| Field | Set it to |
|---|---|
| Build command | `npx opennextjs-cloudflare build` |
| Deploy command | `npx wrangler deploy` |

**Why this matters:** your log showed `next build` running. That produces a
*website*. Cloudflare needs a *Worker* — a different shape of output
entirely. Even with every value correct, `next build` alone produces nothing
Cloudflare can run.

---

# Step 3 — Create two storage buckets

**Left sidebar → Storage & databases → R2 → Create bucket.** Twice.

```
ordence-cache
ordence-documents
```

Exact spelling. Leave every other option at its default. Free up to 10 GB.

Wrangler does not create these for you — it stops with *"the specified
bucket does not exist"* and the deploy goes red.

---

# Step 4 — Upload the new code

Replace the contents of your GitHub folder with the new package, then in
GitHub Desktop: **Commit to main** → **Push origin**.

Pushing starts a build automatically. You do not need to click anything in
Cloudflare.

---

# Step 5 — Connect app.ordence.com

🛑 **There is a wrong turn here that is easy to take. Read this before
clicking.**

When you click **+ Add Domain**, a small box appears with a search field and
**ordence.com** listed underneath it.

### ✅ Do this

**Click the `ordence.com` row** (the one with the `›` arrow on the right).
Cloudflare then asks which subdomain you want, and you type `app` — or the
full `app.ordence.com` — into *that* screen.

### ❌ Do NOT do this

Do not type `app.ordence.com` into the first search box. It replies:

> *No zones match app.ordence.com… start by adding the domain to Cloudflare*

and offers a blue **Onboard domain** button. **That button is a trap.** It
treats `app.ordence.com` as a brand-new, separate website needing its own
nameservers — which do not exist and cannot be created at your registrar.
You would end up with a permanently "Pending" zone that never activates, and
the real subdomain still unmade.

A subdomain is not a new domain. It lives *inside* `ordence.com`, which
Cloudflare already runs for you. That is why you pick the parent first.

> **If you already clicked Onboard domain:** go to **Account home**, find the
> `app.ordence.com` entry in your list of websites, open it, and delete it
> from the bottom of its Overview page. Then start again from ✅ above.

Once added, the status shows **Initializing** for one to five minutes, then
**Active**. Cloudflare creates the DNS record and the SSL certificate itself
— do not add a DNS record by hand, it causes a conflict.

---

# Step 6 — The database security files

**Neon → SQL Editor.** Open your `ordence` folder →
`SQL-FILES` → `RUN-THESE-IN-ORDER`. Twelve files, `01` through `12`.

For each, in number order: open in TextEdit → select all → copy → paste into
the SQL Editor → **Run** → clear → next.

Look for **PASS** in the results. If you ever see **FAIL**, stop.

**Do not skip this.** Without it the CRM works perfectly — every page loads,
nothing errors — and every customer can read every other customer's leads,
bookings and finances. There is no visible symptom.

---

# The seven values, for reference

All in **Settings → Variables and secrets**. One list only.

| Variable name | Value | Type |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_cHJldHR5LXNocmV3LTQyLmNsZXJrLmFjY291bnRzLmRldiQ` | Plaintext |
| `NEXT_PUBLIC_APP_URL` | `https://app.ordence.com` | Plaintext |
| `NEXT_PUBLIC_ROOT_DOMAIN` | `app.ordence.com` | Plaintext |
| `CLERK_SECRET_KEY` | `<YOUR-CLERK-SECRET-KEY>` | 🔒 Secret |
| `PLATFORM_ADMIN_EMAILS` | `Sahil@ordence.com` | Plaintext |
| `DATABASE_URL` | the `-pooler` string above | 🔒 Secret |
| `DATABASE_URL_UNPOOLED` | the plain string above | 🔒 Secret |

---

# Order of operations

1. Fix the two database values, set three to Secret *(Step 1)*
2. Fix the two build commands *(Step 2)*
3. Create the two R2 buckets *(Step 3)*
4. Push the new code from GitHub Desktop *(Step 4)* — **this starts a build**
5. Connect `app.ordence.com` — parent domain first *(Step 5)*
6. Watch **Deployments** for green
7. Run the twelve SQL files in Neon *(Step 6)*

---

# Two things to expect

**Error 1102 — Worker exceeded CPU time limit.** The free plan allows 10
milliseconds of processing per page; a CRM page typically wants 10–20.
Nothing is broken and no data is at risk. Fix: **Workers plans → Workers
Paid**, $5/month, then reload.

**Clerk shows a small development banner.** These are `pk_test_` / `sk_test_`
keys, capped at 100 users. Right for launching; before real customers, use
**Go to prod** in Clerk, add `app.ordence.com` there, and swap in the
`pk_live_` / `sk_live_` keys. Two values changed, one rebuild.
