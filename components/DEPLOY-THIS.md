# The new build , v1.65.0-alpha to v1.80.0-alpha

**Repository:** `sahilxnahar/app.ordence`, branch `main`
**Replaces:** commit `181dfe12` (v1.65.0-alpha, live since 18 Aug 22:40 UTC)
**452 files:** 183 modified, 269 new.

---

## First, the thing you asked about

**The 0122 message was not an error.** `109ms`, `8: DO`, and the amber text was
0122's own `RAISE NOTICE` listing the 215 tables it attached the change recorder
to. Neon styles notices that way. The only warning was cosmetic: the notice was
too long for query history. **0122 succeeded.**

---

## How to deploy

```
# from the root of your local clone of app.ordence, on main, clean tree
unzip -o ordence-v1.80.0-alpha-build.zip
git add -A
git commit -m "1.80.0"
git push
```

Railway builds from `main` and deploys automatically. Nothing else to change:
`railway.json` is untouched, the `build` and `start` scripts are untouched, and
**the dependency list is byte-identical to what is running now** , no new
packages, no `npm install` surprises. That is deliberate: every wave in this
product was built with a zero-new-dependencies rule.

⚠️ **Do not delete anything.** This is an overlay. Every file in the zip is
either new or a replacement; nothing needs removing.

---

## Then, and only then, the last two SQL files

You have run 0079 through 0126. Two remain, and they had to wait:

```
0106_tds_foreign_payments_rule_26.sql
0111_deemed_service_and_notice_authority.sql
```

Both add a `NOT NULL` column with no default to a table the OLD code writes to.
Under v1.65.0 they would have broken `server/fx/rate-service.ts` and
`server/receivables/dunning.ts` on the next write. Once this build is live, the
code supplies both columns and they are safe.

**Order: deploy first, then run these two, then run the checker again.** You
should see `pending: 0`.

Also worth running once the deploy is up: **`0128_change_log_retention.sql`**
(sent separately). 0122 attached the change recorder to 215 tables, so every
write is now two writes with two JSONB snapshots, into a table nothing reads
and nothing prunes. 0128 creates the prune. It deletes nothing by itself.

---

## What I verified, and what I could not

| check | result |
|---|---|
| `tsc --noEmit`, full tree | **clean** |
| 23 static CI gates | **23/23 pass** |
| Security suite, against a real PostgreSQL | **48 files, 1,290 tests, 0 failing** |
| UI suite | **200 files, 6,648 tests, 0 failing** |
| Migration files apply from empty | **122 files, 0 statements refused** |
| RLS coverage on a freshly built database | **309 tables enabled and forced** |
| Dependencies vs what is running now | **identical** |
| `next build` | 🔴 **NOT VERIFIED , see below** |

### 🔴 I could not run `next build`

It was OOM-killed twice in my container, at a 5.1 GB and then a 2.8 GB heap cap.
That is a limit of where I work, not a signal about the code. I am telling you
rather than leaving it implied.

What stands in its place:

- **`check:boundaries` passes.** That gate exists specifically to catch the
  server/client import errors that `next build` catches and `tsc` does not ,
  a client component importing a server module, a stripped `server-only` guard.
- **`tsc --noEmit` is clean** across the whole tree, with
  `noUncheckedIndexedAccess` on.
- **Your own Railway build works.** I read the build log of the deploy you
  think of as failed, 1.64.1: it compiled every route, emitted the full route
  table, and pushed the image successfully. The failure was after the build.
- **CI runs `npm run build` on every push to `main`**, so this is gated before
  it can reach production , just not by me.

**If the deploy fails, it will fail at the build step in Railway and roll back
to 1.65.0 on its own.** Nothing here can take the running site down; a failed
Railway deploy leaves the previous one serving.

### About those three failed deploys

1.64.1 and 1.64.01 are recorded as FAILED, and I looked at why, because a
repeat would matter. **The build succeeded and the image pushed.** The deploy
log is empty, which points at the container failing its healthcheck or exiting
before it logged anything, rather than at a compile error.

I could not determine the exact cause from outside , the logs simply are not
there. Two things worth knowing:

- The new build adds **no required environment variable**. `lib/env.ts` demands
  exactly two at boot, `CLERK_SECRET_KEY` and
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and both are already set on your
  service. `check:env-catalogue` passes.
- `railway.json` points its healthcheck at `/api/health`, which returns a static
  200 and touches nothing. So a healthcheck failure means the process was not
  up, not that a dependency was down.

If this deploy fails the same way, get me the deploy logs from the Railway
dashboard while it is failing , that is the one thing I could not retrieve.

---

## What is in the 452 files

| area | files | what it is |
|---|---|---|
| `app/` | 93 | the wave-10 route tree (Tally, bookings, inventory, land, purchases, TDS, receivables) and screens for the new modules |
| `server/` | 85 | seat control, BYO AI keys, exports, imports, drawings, rate limiter, DPDPA, the security and permission enforcement work |
| `lib/` | 74 | security hours, permission enforcement, CSRF fix, the email dispatcher fix, telemetry, import mapping |
| `tests/` | 66 | 1,290 security assertions and 6,648 UI assertions, including everything that pinned this wave's findings |
| `SQL-FILES/` | 37 | 0104 to 0128. You have applied 0104 to 0126 already; committing them keeps the repo the record. |
| `scripts/` | 33 | the gate manifest, the migration runner, the test bootstrap, the drizzle-kit wrapper |
| `components/` | 38 | purchases, receivables, TDS, GSTR2B, drawings, fixed assets, FX, team |
| `db/` | 17 | schema for every new module |

### The four npm scripts that changed

`db:generate`, `db:migrate`, `db:push` and `db:studio` now go through
`scripts/drizzle-kit.mjs` instead of calling `drizzle-kit` directly. That
wrapper exists because **`npx drizzle-kit push --force` exits 0 having created
zero tables** on this schema , BigInt money defeats its JSON serialiser , and
the wrapper treats that as the failure it is. `db:push` keeps its production
ban.

---

## What is still true after this deploy

These are known and unfixed, and none of them is a reason to delay:

1. **Nothing runs on a schedule.** No cron service is attached, so no queued
   email sends, the dunning ladder never advances, and five security detectors
   never sweep. Half a day of configuration, and it is the single highest-value
   thing left.
2. `recordApiCall` has no callers and writes a metric key nothing reads, so API
   usage is billed as zero.
3. `error_events` is never written, so the per-tenant error budget cannot exist.
4. The platform Observatory reads two columns that do not exist and throws.
5. `change_log` needs the 0128 prune and a schedule to run it.

All five are in the full audit with sizing.
