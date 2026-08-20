# Ordence runbook

For the person on call, which is currently one person. Written to be read
at 3am by someone who did not write the code and is not thinking clearly.

Every section is: **what you will see**, **what it means**, **what to do
first**, **what NOT to do**.

---

## The three rules that override everything below

1. **Never run `drizzle-kit push` against production.** It drops row
   level security policies on 300+ tables and exits 0, reporting success.
   There is no undo. If you are ever unsure whether a command will do
   this, do not run the command.
2. **Never run a file named `DRILL-DO-NOT-RUN-IN-NEON-*.sql`** against
   Neon. They are destructive by design and safe only on a throwaway.
3. **When rebuilding from nothing, ALL-IN-ONE-SETUP.sql is step two and
   is not optional.** Skipping it silently costs 26 objects, 23 of them
   protections, on the accounting core: ledgers, journal entries,
   transactions, contracts. Run `npm run report:allinone` to see the
   list by name.

---

## 1. The site is down, or every page 500s

**What you will see.** Blank 500s on every URL, including pages that do
nothing. Railway shows the service as deployed.

**What it means.** Usually middleware. A thrown middleware is a blank 500
on every URL, which is why the middleware is wrapped and why that wrapper
is in the fail-open registry as a deliberate decision.

**What to do first.**
1. Railway, Deployments, look at the most recent one. If it deployed in
   the last hour, roll back to the previous deployment. Do this before
   diagnosing. Diagnose from a working site.
2. If the last deploy is old, check the database. A Neon outage presents
   as a total outage because tenant resolution needs one query.

**What NOT to do.** Do not redeploy the same build hoping it takes. Do
not run migrations to "fix" it.

---

## 2. A build fails

**What you will see.** Railway, "Deployment failed during build process".

**The three we have actually hit, in order of likelihood.**

- **`Module not found`.** The tree is missing files. Run
  `npm run check:unresolved-imports`. Note that webpack reports about
  five of these and stops; the gate reports all of them. We once had 305
  where webpack said 5.
- **`<something>/page.tsx doesn't have a root layout`.** `app/layout.tsx`
  is missing. Next names only the first orphaned page, not the cause.
- **Out of memory.** Expected locally, never in CI. `next build` cannot
  complete in an 8GB container. Do not try to fix this.

**What to do first.** Run `npm run gates:static` locally. It is seconds
and it finds most of these before Railway does.

---

## 3. Something that should run on a schedule has not run

**What you will see.** Dunning has not escalated. Old records are not
being pruned. Nobody got a reminder.

**What it means, as of this writing.** Nothing runs on a schedule. There
is no cron service. This is a known gap, not an incident.

**What to do first.** Confirm it is the known gap before treating it as a
failure. If a scheduler has since been added, check its run ledger for
the missed slot, then use its replay path rather than triggering the job
by hand; a job run twice can send a customer two demand notices with
different serial numbers, which in India is a legal problem rather than
an embarrassment.

---

## 4. A customer says they can see another customer's data

**Treat as the most serious event possible.** Tenant isolation is
PostgreSQL row level security and nothing else. There is no application
level filter behind it.

**What to do first.**
1. Get the two tenant ids and one concrete example record.
2. Run `SQL-FILES/IS-TENANT-ISOLATION-ACTUALLY-ON-neon-safe.sql`. It is
   read only. It answers whether FORCE row level security is on.
3. **The thing people get wrong here:** production connects as
   `neondb_owner`, which OWNS the tables. A table owner is not subject to
   GRANT or REVOKE, and plain `ENABLE ROW LEVEL SECURITY` does not apply
   to the owner. Only `FORCE` does. So a table that looks protected in
   the schema may not be protected for the running application.

**What NOT to do.** Do not "fix" it by adding an application level
filter to the one query involved. That leaves every other query exposed
and makes the real cause harder to find.

---

## 5. Nobody is receiving email

**What to do first.**
1. Check Resend for bounces and suppressions. A hard bounced address
   retried repeatedly damages the sending domain for every tenant, so it
   is a shared problem, not one customer's.
2. Check the domain is still verified.

**What to know.** The Resend SDK returns `{data, error}` and does NOT
throw. A sender that calls it and returns `true` reports success on every
failure. That bug existed here and is fixed; if you write a new sender,
read the result.

---

## 6. Billing looks wrong, or someone has access they should not

**What you will see.** A tenant using features above their plan.

**What it means.** The billing gate **fails open on purpose**. When the
database is unreachable it grants access, and it logs that it did. The
reasoning is written in `server/billing/access.ts`: wrongly denying takes
every paying customer's workspace offline over one bad query, which is a
much larger blast radius than a few hours of unbilled access.

**What to do first.** Search the logs for `failing OPEN`. If it is there,
you had a database problem, not a billing problem. Fix that.

**What NOT to do.** Do not change it to fail closed during an incident.
That converts a billing question into an outage.

---

## 7. Migrations: what is applied, and what to run

**Always start here.** Paste `SQL-FILES/WHATS-PENDING-neon-safe.sql` into
the Neon console. It is read only, takes a second, and is safe during
business hours. It tells you exactly which files this database is
missing.

Then run only those, oldest first, one at a time, reading the output of
each before starting the next.

**What it cannot tell you.** Whether a migration ran COMPLETELY. A file
that created its first object and then failed on statement forty reads as
present. If a number looks suspicious, run the `VERIFY-00NN` file beside
it.

**What NOT to do.** Do not run a batch of migrations as one paste. Do not
add `BEGIN` or `COMMIT` around them.

---

## 8. Neon console gotchas that will waste an hour

- `SET LOCAL` as its own statement does not work. Wrap it:
  `DO $$ BEGIN PERFORM set_config('app.platform_scope','on',true); <your write> END $$;`
- `ALTER TYPE ... ADD VALUE` cannot use the new value in the same
  transaction.
- Green `RAISE NOTICE` output is success, not an error. One of our
  migrations prints a long notice on completion and it has been reported
  as a failure more than once.

---

## 9. Shipping a build

`node scripts/release.mjs --version x.y.z-alpha`

It runs the gates and tests, checks the files whose absence kills the
build, bumps the version, writes ONE full-tree zip and a run order.
It does not deploy, push, tag or commit. That is deliberate: a tool that
can deploy is a tool that can deploy by accident.

**Always a full tree, never a patch.** Patches have failed twice; full
replacement has never failed. The only cost is the download size.

---

## 10. When you do not know

Stop. Roll back to the last known good deployment. Nothing in this system
degrades so fast that ten minutes of thinking costs more than a wrong
command run quickly.
