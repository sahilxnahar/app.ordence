# Deployment Guide — v0.1.0-alpha

Written for a non-technical founder. Every command is copy-paste ready.
Budget about **60–90 minutes** the first time. Nothing here costs money.

**Legend:** 💻 = type in Terminal · 🌐 = do in your web browser

---

## Before you start — read this one warning

> ### ⚠️ Vercel's free "Hobby" plan forbids commercial use
>
> Vercel's own terms restrict Hobby to *"non-commercial, personal use only."*
> Hobby is perfect for **building and testing** Ordence — which is
> exactly what we're doing now. But **the day you take your first paying
> customer, you must be on Pro ($20/month)**, or Vercel can suspend the project.
>
> This isn't a reason to change plans today. Just don't build a business on
> Hobby and get surprised. Details in `COST-AND-UPGRADE-PATH.md`.

---

# PART A — Install the tools (one time only)

## Step 1: Open Terminal

Press `Cmd + Space`, type `Terminal`, press Enter. A text window opens.
This is where the 💻 commands go. Paste, press Enter, wait for the prompt to return.

## Step 2: Install Homebrew (the Mac software installer)

💻
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It asks for your Mac password. **You won't see anything as you type — that's normal.**
Type it and press Enter. Takes 5–10 minutes.

At the end it may print two `export PATH` lines and ask you to run them. If so, run them.
Otherwise run these (harmless if not needed):

💻
```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

## Step 3: Install Git and Node.js

💻
```bash
brew install git node
```

## Step 4: Confirm everything works

💻
```bash
git --version && node --version && npm --version
```

You want three version numbers. Node must be **20 or higher**.
If any command says "command not found", close Terminal, reopen it, try again.

## Step 5: Tell Git who you are

Use the same email as your GitHub account.

💻
```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

---

# PART B — Create your accounts (all free)

Sign up for these four. Use the **same email** for all of them.

| # | Service | URL | What it does |
|---|---------|-----|--------------|
| 1 | GitHub | github.com | Stores your code |
| 2 | Vercel | vercel.com | Runs your website |
| 3 | Neon | neon.tech | Your database |
| 4 | Clerk | clerk.com | Logins and companies |

**Tip:** when signing up for Vercel, choose **"Continue with GitHub."** It links
the two accounts automatically and saves a step later.

---

# PART C — Set up your database (Neon)

1. 🌐 Go to **neon.tech** → sign in → **Create project**
2. Name it `ordence`
3. Region: pick the one closest to your users
   *(India → Singapore; Europe → Frankfurt; US → Virginia)*
4. Click **Create**
5. You land on a page showing a **connection string**. Keep this tab open.

You need **two** versions of that string:

- 🌐 With the **"Pooled connection"** toggle **ON** → this is your `DATABASE_URL`
- 🌐 With that toggle **OFF** → this is your `DATABASE_URL_UNPOOLED`

Copy both into a notes file. They look like:
```
postgresql://neondb_owner:AbC123@ep-cool-name-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

> **The pooled one has `-pooler` in it.** That difference matters — pooled for the
> app, direct for migrations.

---

# PART D — Set up logins (Clerk)

1. 🌐 Go to **clerk.com** → sign in → **Create application**
2. Name: `Ordence`
3. Enable **Email** and **Google** as sign-in options
4. Click **Create application**

### Turn on Organizations — this is the multi-tenant switch

5. 🌐 In the left sidebar: **Configure** → **Organizations**
6. Toggle **Enable organizations** → **ON**

> Without this, every customer company shares one space. This toggle is what makes
> the product multi-tenant. Don't skip it.

### Copy your keys

7. 🌐 Left sidebar: **Configure** → **API Keys**
8. Copy both into your notes:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — starts `pk_test_…`
   - `CLERK_SECRET_KEY` — starts `sk_test_…`

> 🔒 The `sk_test_` one is a **password**. Never put it in a screenshot, a message,
> or any file that goes to GitHub.

---

# PART E — Get the code running on your Mac

## Step 1: Go to the project folder

💻
```bash
cd ~/Downloads/"SAAS CRM"/ordence
```

## Step 2: Install the building blocks

💻
```bash
npm install
```

Takes 2–3 minutes. Some warnings in yellow are normal. Red `ERROR` is not.

## Step 3: Create your secrets file

💻
```bash
cp .env.example .env.local
open -e .env.local
```

TextEdit opens. Replace the placeholder values with the real ones from your notes:

```bash
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NEXT_PUBLIC_ROOT_DOMAIN="localhost:3000"

DATABASE_URL="<your POOLED Neon string>"
DATABASE_URL_UNPOOLED="<your DIRECT Neon string>"

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_<yours>"
CLERK_SECRET_KEY="sk_test_<yours>"

PLATFORM_ADMIN_EMAILS="you@example.com"
```

Save with `Cmd + S` and close.

> `.env.local` is already in `.gitignore`, so it will never reach GitHub. That is
> deliberate and important.

## Step 4: Create the database tables

💻
```bash
npm run db:push
```

If it asks for confirmation, choose **Yes**. You should see tables being created.

## Step 5: 🔒 Turn on database-level tenant isolation (do not skip)

This is **SEC-001** from the security report. It's the safety net that stops one
customer from ever seeing another's data, even if the app code has a bug.

1. 🌐 Go to your Neon dashboard → **SQL Editor** in the left sidebar
2. 💻 In Terminal, print the file so you can copy it:
   ```bash
   cat db/migrations/0001_rls_and_audit_guard.sql
   ```
3. Copy **everything** it printed
4. Paste into Neon's SQL Editor → click **Run**

Then verify. Paste this into the SQL Editor and Run:

```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname='public'
  AND tablename IN ('tenants','users','roles','role_permissions','user_roles','audit_logs')
ORDER BY tablename;
```

**All six rows must show `rowsecurity = true`.** If any says `false`, the script
didn't fully run — re-run it.

## Step 6: Start it up

💻
```bash
npm run dev
```

🌐 Open **http://localhost:3000**

You should see the Ordence landing page. Click **Create workspace**,
sign up, and create an organization. You'll land on the dashboard.

> **Expected on first run:** the dashboard says *"Finishing setup…"*. That's
> correct behaviour — Clerk created the organization, but the matching database
> row needs the webhook we build in **Phase 2**. Nothing is broken.

To stop the server: press `Ctrl + C` in Terminal.

---

# PART F — Put your code on GitHub

## Step 1: Create an empty repository

1. 🌐 Go to **github.com/new**
2. Repository name: `ordence`
3. Select **Private** ← important, this is commercial code
4. **Do NOT** tick "Add a README", "Add .gitignore", or "Choose a license".
   The folder already has these; ticking them causes a conflict.
5. Click **Create repository**
6. Leave the page open — you need the URL from it.

## Step 2: Upload your code

Run these **one at a time**. Replace `YOUR-USERNAME` with your GitHub username.

💻
```bash
cd ~/Downloads/"SAAS CRM"/ordence
git init
git add .
git commit -m "feat: v0.1.0-alpha — multi-tenant foundation, schema, edge middleware"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/ordence.git
git push -u origin main
```

**On `git push`, a browser window opens asking you to sign in to GitHub.** Approve it.

### Verify nothing secret escaped

💻
```bash
git ls-files | grep -c "env.local"
```

**This must print `0`.** If it prints `1`, stop and tell me — your keys are exposed
and we need to rotate them.

---

# PART G — Deploy to Vercel

## Step 1: Import the project

1. 🌐 Go to **vercel.com/new**
2. Find `ordence` in the list → click **Import**
   *(If you don't see it: click "Adjust GitHub App Permissions" and grant access.)*
3. Framework Preset should auto-detect **Next.js**. Leave all build settings alone.

## Step 2: Add your environment variables

**This is the step people get wrong. Do it before clicking Deploy.**

On the import screen, expand the **Environment Variables** section. Add each row
below — Name on the left, Value on the right, clicking **Add** after each.

| Name | Value |
|---|---|
| `DATABASE_URL` | your POOLED Neon string |
| `DATABASE_URL_UNPOOLED` | your DIRECT Neon string |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_…` |
| `CLERK_SECRET_KEY` | `sk_test_…` |
| `NEXT_PUBLIC_APP_URL` | `https://ordence.vercel.app` |
| `NEXT_PUBLIC_ROOT_DOMAIN` | `ordence.vercel.app` |
| `PLATFORM_ADMIN_EMAILS` | your email |

> You won't know your exact Vercel URL until after the first deploy. Use the
> guessed one above, then correct it in Step 4 if Vercel assigned something different.

## Step 3: Deploy

Click **Deploy**. Takes 2–4 minutes. You'll get a confetti screen and a live URL.

## Step 4: Fix the URL variables if needed

1. 🌐 Look at the URL Vercel gave you
2. If it differs from what you entered, go to **Settings → Environment Variables**
3. Correct `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_ROOT_DOMAIN`
4. Go to **Deployments** → click the `…` on the newest → **Redeploy**

## Step 5: Point Clerk at your live site

1. 🌐 In Clerk: **Configure → Domains** (or **Paths**)
2. Add your Vercel URL as an allowed origin
3. For real production later, you'd switch Clerk from Development to Production keys

## Step 6: Confirm it's alive

🌐 Visit `https://your-url.vercel.app/api/health`

You want:
```json
{"status":"ok","timestamp":"2026-07-31T..."}
```

✅ **Deployed.**

---

# How you'll work from now on

Every future change follows the same three commands:

💻
```bash
git add .
git commit -m "describe what changed"
git push
```

Vercel notices the push and redeploys automatically in about two minutes.
No further clicking required.

---

# When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: brew` | Terminal hasn't reloaded | Close and reopen Terminal |
| Build fails: "Invalid publishable key" | Clerk key missing/typo'd in Vercel | Re-check Environment Variables, redeploy |
| Build fails: "DATABASE_URL must be a valid URL" | Connection string got truncated | Re-copy the whole string from Neon |
| Site loads, login does nothing | Vercel URL not allowed in Clerk | Part G, Step 5 |
| `permission denied` on git push | GitHub auth expired | Run `git push` again and approve in browser |
| Dashboard stuck on "Finishing setup…" | **Expected in v0.1.0** | Resolved in Phase 2 |

---

## Your safety checklist before moving to Phase 2

- [ ] `git ls-files | grep -c "env.local"` prints `0`
- [ ] All six tables report `rowsecurity = true` in Neon
- [ ] GitHub repository is set to **Private**
- [ ] `/api/health` returns `{"status":"ok"}`
- [ ] You can sign up, create an organization, and reach the dashboard
