# Disaster Recovery Runbook

**Ordence · v0.21.0-alpha**

---

## Read this part first

**You do not have a working backup until you have restored one.**

Everything below is procedure. This line is the point: an untested backup
is a file you believe in. The way it fails is not "the restore is slow" —
it is discovering, on the worst day, that the file has been empty since
March, or that nobody knows the password, or that it restores a database
your application no longer understands.

> ⭐ **The rehearsal lives in [`docs/current/RESTORE-DRILL.md`](current/RESTORE-DRILL.md).**
> This file tells you what to do when something breaks. That one is the
> drill you run when nothing is broken, and it carries the results table
> where the measured numbers go. It is still empty — nobody has run it.
>
> ⚠️ **Two names below are stale.** This project deploys on **Railway**,
> not Vercel, and uploads live in **Cloudflare R2**, not Vercel Blob. The
> procedure is unchanged; the console you open is different.

There is a command that proves it:

```bash
npm run drill:restore
```

Run it against a **restored copy of a real backup**, not against your live
database. It refuses to run against anything that looks like production.

---

## The four things that can go wrong

They need completely different responses, and confusing them wastes the
hour that matters most.

| | What happened | Who fixes it | How long |
|---|---|---|---|
| **1** | Someone deleted a record by mistake | The customer, themselves | Seconds |
| **2** | Someone deleted a lot of records, or emptied something | You | Minutes |
| **3** | The database is damaged or corrupted | You + Neon | 1–4 hours |
| **4** | Neon is gone, or your account is | You, from an export | Days |

Work out which one you are in **before** you start typing. The response to
(1) applied to (3) does nothing; the response to (3) applied to (1) is a
catastrophic overreaction that loses everyone else's work since the
restore point.

---

## Level 1 — A customer deleted something

**They fix this themselves. You do nothing.**

Nothing in this system hard-deletes a customer record. "Delete" sets a
timestamp; the row stays exactly where it was.

The customer goes to **Settings → Recycle bin**, finds it, and clicks
restore. It stays visible there for **30 days**.

### If it is older than 30 days

It is still there. The 30 days governs **what the recycle bin shows**, not
what exists — nothing in this application permanently destroys a customer
row on a timer, deliberately. A sweeper whose failure mode is
unrecoverable data loss, running unattended forever, is not a feature.

So: it can be recovered by hand.

```sql
-- Find it. Widen the window as needed.
SELECT id, first_name, last_name, email, deleted_at
  FROM contacts
 WHERE tenant_id = 'THE-TENANT-UUID'
   AND deleted_at IS NOT NULL
 ORDER BY deleted_at DESC
 LIMIT 50;

-- Put it back.
UPDATE contacts
   SET deleted_at = NULL, deleted_by = NULL
 WHERE id = 'THE-RECORD-UUID'
   AND tenant_id = 'THE-TENANT-UUID';
```

⚠️ **Always include `tenant_id` in the WHERE clause.** You are connected as
an administrator, which means row-level security is not protecting you from
a typo. An `id` alone is one mistyped character away from touching another
customer's row.

### Why a restore might be refused

The app blocks three cases, and each is a real problem rather than
fussiness:

- **The parent was deleted too.** Restoring a contact whose company is
  still deleted produces a record that opens as broken. Restore the
  company first.
- **Something took its unique value.** They deleted `priya@acme.com`,
  created a new contact with the same address, and now want the old one
  back. Both cannot exist.
- **It falls in a closed accounting period.** Restoring it would change a
  number that has already been reported. That is a restatement, not a
  restore.

---

## Level 2 — A bulk deletion

Same mechanism, more rows. The question to answer **first** is *when*, not
*what*.

```sql
-- Where the damage is, by the minute.
SELECT date_trunc('minute', deleted_at) AS minute,
       count(*) AS rows_deleted
  FROM contacts
 WHERE tenant_id = 'THE-TENANT-UUID'
   AND deleted_at > now() - interval '7 days'
 GROUP BY 1
 ORDER BY 1 DESC;
```

A bulk mistake shows up as a spike in one or two minutes. Restore exactly
that window:

```sql
-- ⚠️ Run the SELECT first. Look at the count. Then run the UPDATE.
SELECT count(*) FROM contacts
 WHERE tenant_id = 'THE-TENANT-UUID'
   AND deleted_at BETWEEN '2026-08-01 14:32:00+05:30'
                      AND '2026-08-01 14:34:00+05:30';

UPDATE contacts
   SET deleted_at = NULL, deleted_by = NULL
 WHERE tenant_id = 'THE-TENANT-UUID'
   AND deleted_at BETWEEN '2026-08-01 14:32:00+05:30'
                      AND '2026-08-01 14:34:00+05:30';
```

**Who did it** is in the audit log:

```sql
SELECT created_at, actor_email, action, resource_type, resource_id
  FROM audit_logs
 WHERE tenant_id = 'THE-TENANT-UUID'
   AND action = 'delete'
   AND created_at > now() - interval '7 days'
 ORDER BY created_at DESC;
```

> ⚠️ **If this workspace was created before v0.14.1, that log may be
> empty.** A defect meant every audit write was silently rejected by
> row-level security. Fixed, but the history from before it is not
> recoverable — it was never written. Say so plainly if a customer asks.

---

## Level 3 — The database is damaged

This is where **point-in-time recovery** applies, and it is a different
kind of operation: it rolls back **everything, for every customer**, to a
chosen moment.

### ⚠️ Before you touch anything

**PITR is not a fix for one customer's mistake.** Rolling back four hours
to undo one deletion discards four hours of work belonging to every other
customer, and they will not know why. Use Level 1 or 2 unless the database
itself is genuinely broken.

Ask yourself, out loud: *is this damage that a targeted UPDATE cannot
repair?* If the answer is no, stop.

### The procedure (Neon)

1. **Stop the bleeding.** In Vercel, set the project to maintenance or
   pause the deployment. Restoring while writes continue produces a
   database that is neither the old state nor the new one.

2. **Pick the moment.** Neon's history goes back as far as your retention
   setting — **check what yours actually is right now, before you need
   it.** The free tier is short.

3. **Restore to a BRANCH, never over the top.**
   Neon console → your project → **Branches** → **New branch** → *from a
   point in time*. Name it `recovery-YYYY-MM-DD`.

   This is the most important step in the whole document. A branch leaves
   the damaged database intact, so if you chose the wrong moment you can
   try again. Restoring in place gives you one attempt, and if it is wrong
   you have destroyed the evidence as well as the data.

4. **Verify the branch before you point anything at it:**

   ```bash
   TEST_DATABASE_URL="postgresql://…the RECOVERY branch…" \
     npm run drill:restore
   ```

   Then check the specific thing you lost is actually present.

5. **Re-apply the security rules.** A restored branch may not carry its
   policies, depending on how the restore was performed:

   ```bash
   # Against the recovery branch:
   #   run SQL-FILES/ALL-IN-ONE-SETUP.sql
   npm run db:verify
   ```

   ⚠️ **Do not skip this.** A database with no row-level security works
   perfectly. Every page renders. The only difference is that every
   customer can read every other customer's data, and nothing tells you.

6. **Switch over.** Update `DATABASE_URL` in Vercel to the recovery
   branch and redeploy.

7. **Keep the damaged branch** for at least a week. It is your only
   evidence of what happened.

---

## Level 4 — Neon is gone, or your account is

The scenario nobody plans for: a suspended account, a billing dispute, a
provider outage measured in days, a region loss.

**Your recovery is the customer exports.** That is the honest answer, and
it is why the export exists.

Each customer can download a complete JSON copy of their workspace from
**Settings → Billing → Export**. It contains their records, their ledger,
their invoices and their audit trail.

### What this means practically

- **Encourage customers to export periodically.** A copy in their hands is
  the only backup that survives your account being suspended.
- **Take your own export of every tenant on a schedule** and store it
  somewhere with a *different* provider. Two copies in one account is one
  copy.
- The JSON restores into any empty PostgreSQL running this schema —
  including a self-hosted instance. That is deliberate.

### ⚠️ What Level 4 costs you

Be honest with yourself now rather than in the moment: rebuilding from
JSON exports means **whatever has changed since the last export is gone**.
If exports are monthly, you lose up to a month. This is a real gap and the
only way to close it is to take exports more often.

---

## Prevention — the four things worth doing today

**1. Run the drill, and write down the date.**

```bash
npm run drill:restore
```

A drill you ran six months ago is a drill you have not run. Quarterly is a
reasonable rhythm; after any schema change is better.

**2. Check your Neon retention window.** Find out what it actually is, not
what you assume. If it is shorter than the time it would take you to
*notice* a problem, it protects nothing.

**3. Never run `db:push` alone.** It removes every row-level security
policy — measured, 25 tables to 0 — and the application keeps working
perfectly afterwards. Always:

```
npm run db:push  →  run ALL-IN-ONE-SETUP.sql  →  npm run db:verify
```

**4. Take an off-provider copy.** Schedule an export of every tenant and
put it somewhere that is not Neon and not Vercel.

---

## If you are in the middle of an incident right now

1. **Stop writes.** Pause the Vercel deployment.
2. **Do not restore over your live database.** Branch.
3. **Work out which of the four levels you are in** before typing anything.
4. **Write down what you do, with timestamps.** You will need it, and you
   will not remember.
5. **Tell the affected customers early**, even before you know the answer.
   "We are investigating, your data is not lost, next update in an hour"
   buys more goodwill than silence followed by a perfect explanation.

---

## What this runbook does not cover

Stated plainly, because a runbook that pretends to be complete is worse
than one that admits its gaps:

- **No automated off-provider backup exists yet.** Exports are manual.
  Scheduling them is not built.
- **No tested restore of Vercel Blob.** Uploaded files live in Blob
  storage, and this runbook covers the database only. If Blob is lost, the
  document *metadata* restores and the files themselves do not.
- **The drill has never been run against a real Neon branch** — only
  against a local PostgreSQL 16 with the same schema. That proves the
  procedure and the code; it does not prove Neon's restore.
- **No RTO or RPO is committed.** The numbers would be guesses until
  someone has actually done a Level 3 restore under time pressure.

Those four are the honest gaps. The first one an enterprise customer asks
about will be the automated off-provider backup.
