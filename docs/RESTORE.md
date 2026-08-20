# Restore, and how to know it worked

Track H, wave H7. For the person doing this at 3am, who has never done it
before, which is currently everyone.

---

## The thing that makes this dangerous

**A restore almost always produces a database.** That is not the failure
mode. The failure is a database that starts, serves pages, passes a smoke
test, and is missing some of the protections that keep one customer's
data away from another.

Twenty-three of those protections exist in `ALL-IN-ONE-SETUP.sql` and in
no numbered migration, on the accounting core: `contracts`,
`contract_versions`, `clause_library`, `ledgers`, `journal_entries`,
`transactions`. A restore that skips that file loses them silently.

So the rule for this page is: **restoring is the easy half. Proving the
restore is complete is the half that needs a procedure.**

---

## 1. Restoring from Neon point-in-time recovery

This is the first thing to try, because it is the only option that keeps
your DATA.

1. Neon console, your project, **Branches**.
2. Create a branch from a timestamp BEFORE the damage. Neon calls this
   restore or branch-from-history depending on where you click.
3. **Do not point the application at it yet.** Verify first, section 3.
4. Only when it verifies, move the connection string over.

**Choose the timestamp carefully.** Everything after it is gone. If the
damage was gradual, for example a bad migration applied an hour ago and
customers have worked since, you are choosing between losing an hour of
customer work and keeping the damage. That is a business decision, not a
technical one, and it belongs to you.

**Neon retains history for a limited window** and the window depends on
the plan. If the damage is older than the window, point-in-time recovery
is not available and you are in section 2.

---

## 2. Rebuilding the schema from the files

This gives you a correct, EMPTY database. It does not give you data. Use
it when point-in-time recovery is not available, or when standing up a
new environment.

**The order is three steps and none is optional:**

1. `drizzle-kit push` , creates 55 of the 313 tables.
   🔴 Test and local only. NEVER against production: it drops row level
   security policies on 300+ tables and exits 0.
2. `SQL-FILES/ALL-IN-ONE-SETUP.sql` , creates the rest, including
   `tenants`, `users`, `roles`, `audit_logs`, and 23 protections that
   exist nowhere else. `npm run report:allinone` lists them by name.
3. The numbered files, in order, oldest first.

⚠️ **Applying the numbered files to an empty database refuses 111 of
122.** They ALTER tables they do not create. That is expected and is not
a fault; it means you skipped step one or two.

`scripts/bootstrap-test-db.mjs` does exactly this sequence and is the
reference. Read it rather than improvising.

---

## 3. Proving the restore is complete , do not skip this

```
PGHOST=<host> PGPORT=<port> PGUSER=<user> \
  node scripts/drill-rebuild.mjs --db <database>
```

**It refuses any non-local host.** That is deliberate: it is a drill, and
a drill pointed at production is how drills stop being safe. To check a
restored Neon branch, take a dump of it into a local PostgreSQL and run
the drill there.

What it does: reads every SQL file, works out which named policies,
triggers and functions SHOULD exist, subtracts the ones a later file
drops, and names the ones the database does not have.

**The expectations are computed from the files, never written down.** A
hardcoded "expect at least 300 policies" is the defect this whole
codebase keeps repeating: 0014's impersonation check said `count(*) >= 10
THEN 'PASS'` and passed at 48 of 303.

A healthy answer looks like this:

```
  policy    expected  206   present  314   missing 0
  trigger   expected  248   present  688   missing 0
  function  expected  247   present  471   missing 0
  row level security enabled on 309 table(s), FORCED on 309
```

Present exceeds expected because `drizzle-kit push` and
`ALL-IN-ONE-SETUP.sql` create objects the numbered files never mention.
**Missing is the number that matters, and it must be zero.**

### The FORCE line is the one to read twice

`enabled` and `FORCED` should be the same number. Production connects as
the table OWNER, and **an owner is not subject to `ENABLE ROW LEVEL
SECURITY`. Only `FORCE` applies to it.** A table with RLS enabled and not
forced has a policy that is decorative for the running application. The
drill prints those tables by name.

### Then, on the database itself

Run `SQL-FILES/WHATS-PENDING-neon-safe.sql` in the Neon console. Read
only. It tells you which numbered migrations the restored database is
missing. Run those, oldest first, one at a time.

Then `SQL-FILES/IS-TENANT-ISOLATION-ACTUALLY-ON-neon-safe.sql`, which
answers the FORCE question against the live database rather than against
a copy.

---

## 4. Before you point the application at it

- `node scripts/report-env-drift.mjs --have <names file>` , a restored
  database with the old connection string still configured is a very
  quiet disaster.
- Check the app connects as the role you expect. Production connects as
  `neondb_owner`. If a restore changes that, every grant-based control
  changes behaviour with it.
- Take a fresh backup of the restored state before you resume traffic.

---

## 5. What is NOT covered here, honestly

- **Nobody has performed this against real Neon point-in-time recovery.**
  The verification half has been exercised end to end against a throwaway
  PostgreSQL; the Neon half is written from the console's documented
  behaviour. The first real run will find something this page does not
  say.
- **Restoring data, as opposed to schema, has no procedure here.** Neon
  branching keeps your data and that is the whole plan. If you ever need
  selective restore, one tenant recovered while others keep working, that
  does not exist and would be real work.
- **Nothing tests this on a schedule**, because nothing in Ordence runs
  on a schedule yet. A restore procedure nobody has rehearsed in six
  months is a procedure that has quietly rotted. When a scheduler exists,
  a quarterly rehearsal against a throwaway is worth one hour.
