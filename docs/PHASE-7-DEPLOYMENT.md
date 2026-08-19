# Phase 7 Deployment — v0.7.0-alpha

**The CRUD Surface & Application UI**
**Date:** 31 July 2026

---

## What changed in plain terms

Before this phase your system was a vault with no doors. The data was safe,
the books balanced, the audit trail was unalterable — and the only way to put
anything in was a database script.

Phase 7 built the doors. You can now create and edit contacts, companies and
assets from the screen, post journal entries, close accounting periods,
change who has which role, and configure the workspace.

**Nothing about the security model changed.** Every new screen goes through
the same four layers that were already there.

---

## Before you start

You need about **15 minutes**. Nothing here can break your existing data.

You will need:

- Your GitHub repository (already set up in Phase 1)
- Your Vercel project (already set up in Phase 1)
- A terminal window

> **If a command fails,** stop and read the error before running the next
> one. Copy the message to me — do not run the same command repeatedly
> hoping for a different result.

---

## Step 1 — Open a terminal in your project

On a Mac, press `Cmd + Space`, type `Terminal`, press Enter. Then:

```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
```

Check you are in the right place:

```bash
pwd
```

It should print a path ending in `ameya-heights-os`. If it does not, the
folder is somewhere else — find it in Finder, and drag it onto the Terminal
window after typing `cd ` (with the space).

---

## Step 2 — Install the new packages

Phase 7 added form handling, notifications and UI test tooling:

```bash
npm install
```

This reads `package.json` and downloads what is listed there. It takes one to
three minutes. Some warnings scroll past — that is normal. What matters is
that it ends without the word `ERR!`.

Verify:

```bash
npm ls react-hook-form sonner
```

Both should appear with version numbers.

---

## Step 3 — Check the code compiles

```bash
npm run typecheck
```

**Expected output: nothing at all.** TypeScript prints errors and stays
silent on success. Silence is the pass.

---

## Step 4 — Run the tests

Two suites now exist.

**The UI tests** need no database:

```bash
npm run test:ui
```

Expected: `Tests  19 passed (19)`.

**The security tests** need a local test database. If you have not set one
up, skip this — CI runs it on every push:

```bash
npm run test:security
```

> ⚠️ **These tests never touch production.** The setup file runs six
> independent checks and aborts if it is pointed anywhere near a live
> database. That guard is deliberate. Do not disable it.

---

## Step 5 — Build it the way Vercel will

```bash
npm run build
```

Takes one to two minutes. At the end you should see a table of routes and
the line `✓ Compiled successfully`.

You should count **22 routes**. Phase 6 had 12.

If this fails, **do not push**. Vercel runs exactly this command, so a
failure here is a failure there — the difference is that here nobody sees it.

---

## Step 6 — Push to GitHub

```bash
git add .
git commit -m "Phase 7: CRUD surface, forms, settings and role management (v0.7.0-alpha)"
git push
```

If `git push` asks for a password, use a **personal access token**, not your
GitHub password — GitHub stopped accepting passwords in 2021. Generate one at
GitHub → Settings → Developer settings → Personal access tokens.

---

## Step 7 — Watch the deployment

1. Go to **vercel.com** and open your project.
2. You will see a new deployment marked **Building**.
3. Wait two to four minutes.
4. When it says **Ready**, click **Visit**.

If it says **Error**, click the deployment and read the log. The failure is
almost always the same thing that would have failed at Step 5.

---

## Step 8 — Check the new screens

Sign in and visit each of these. They should all load:

| Screen | What to look for |
|---|---|
| `/contacts` | A **New contact** button top right |
| `/contacts/new` | A form that saves and returns to the list |
| `/companies` | The new companies list |
| `/companies/new` | A form with domain, size and address |
| `/assets/new` | A **Details** section generated from your field definitions |
| `/accounting` | Trial balance, journal form, periods |
| `/settings` | Three tabs: General, Team, Financial |

### The two things worth testing by hand

**1. The accounting form should refuse to save unbalanced entries.**

Go to `/accounting`, choose two ledgers, and enter a debit of `1000.00`
against a credit of `900.00`. The **Post entry** button stays greyed out and
the panel tells you the difference. Make them equal and it turns on.

**2. The asset form should show fields specific to your industry.**

Go to `/assets/new`. Under **Details** you should see fields matching your
industry — carpet area and facing for a developer, case number and next
hearing for a law firm. Change the industry in `/settings` and come back; the
section changes with it. No deployment, no migration.

---

## What is still outstanding

| Item | Why it matters | Effort |
|---|---|---|
| **Run `ALL-IN-ONE-SETUP.sql`** | **Nothing is protected until this runs.** Still the single most important outstanding task. | 5 min |
| Enable branch protection on `main` | Without it, CI can go red and the merge still happens | 2 min |
| Delete the `_to_delete/` folder | Stale files from earlier phases | 1 min |
| Upgrade to Vercel Pro | **Required before your first paying customer** — Hobby forbids commercial use | $20/mo |

### Enabling branch protection (2 minutes)

1. GitHub → your repository → **Settings** → **Branches**
2. **Add branch protection rule**
3. Branch name pattern: `main`
4. Tick **Require status checks to pass before merging**
5. Search for and select **Security Gate**
6. **Create**

From then on, a commit that breaks tenant isolation, unbalances the books or
disables the submit gate cannot reach `main` — and therefore cannot reach
Vercel.

---

## If something goes wrong

**"Module not found" during build** — `npm install` did not finish. Run it
again and read the output.

**Screens load but nothing saves** — almost always the database setup SQL has
not been run. See the outstanding items above.

**"Your role does not include permission…"** — working as intended. Roles are
enforced. Change your own role from the Team tab using another owner account,
or check what your role actually is.

**Toasts do not appear** — hard-refresh once (`Cmd + Shift + R`). The
`<Toaster />` component was added to the root layout in this phase and a
cached page will not have it.
