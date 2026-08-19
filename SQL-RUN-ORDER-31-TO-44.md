# The SQL files to run, in order

Your check said **28 of 40 applied**. This is the list that closes the gap.

**Run them top to bottom. Do not skip and do not reorder.** Each one is safe to
run twice, so if you lose your place, running one again costs nothing.

For each file: open it → select all → copy → paste into the Neon SQL Editor →
Run → wait for it to finish → move to the next one.

---

## The order

| Run | File | What it is | How long |
|---|---|---|---|
| 1 | `31.sql` | Row-level security foundation + the audit-log guard | seconds |
| 2 | `32.sql` | **NEW** — the tables for Compliance and Scheduling | ~10 sec |
| 3 | `33.sql` | Compliance calendar (rules, filings, evidence, licences) | ~10 sec |
| 4 | `34.sql` | Scheduling (resources, bookings, blocked time) | ~10 sec |
| 5 | `35.sql` | The big one — 33 tables for the engines, BOQ and site labour | ~60 sec |
| 6 | `36.sql` | Engine 2 — rate cards and pricing | ~15 sec |
| 7 | `37.sql` | Engine 5 — utility meters and readings | ~15 sec |
| 8 | `38.sql` | Engine 3 — field jobs and mobile technicians | ~15 sec |
| 9 | `39.sql` | Engine 6 — the sensitive-data vault | ~15 sec |
| 10 | `40.sql` | BOQ, measurement books, variations, site labour | ~15 sec |
| 11 | `41.sql` | Stock reservation floor | ~5 sec |
| 12 | `42.sql` | Joins the BOQ world to the RA-bill world | ~10 sec |
| 13 | `43.sql` | MCP assistant access | ~5 sec |
| — | `44.sql` | **The checker.** Run this LAST to confirm | ~2 sec |

`35.sql` is 2,600 lines. It will look like it has hung. Give it a minute.

---

## When you are done

Run `44.sql`. In Section 1 every row should say **APPLIED**.

Then check the other three sections:

- **Section 2** — "Views WITHOUT security_invoker" must be **0**.
- **Section 3** — must be **empty**. Any row here is a table every customer
  could read. If you see rows, send me the list and stop.
- **Section 4** — must be **empty**.

---

## What went wrong, and why you never saw it

**`32.sql` did not exist until today.** That is the actual finding.

Compliance (`33.sql`) and Scheduling (`34.sql`) each start by checking that
their tables exist, and refuse to run if they do not. Nothing created those
tables. The file that was supposed to — the big paste-only tables file,
`35.sql` — covers Engines 2, 3, 5 and 6, plus BOQ and site labour. It does not
cover Engine 1 or Engine 4.

So those two files refused to run every single time, and would have gone on
refusing forever. The guard worked perfectly. It reported a missing
prerequisite that no file supplied. Two engines have been written-but-never-
installed for as long as they have existed, and only the checker found it —
because it probes for a real object in your database rather than trusting a
list of what I think I sent you.

`32.sql` is what I wrote today to close that hole. 7 tables, 8 types.

**And I got the labels wrong.** In `28.sql` and `30.sql` the column headed
"sent to you as" was partly guessed. I have now checked every file by
fingerprint against what is actually in your folder. The truth:

| Migration | I said | Actually sent as |
|---|---|---|
| `0034` Engine 2 pricing | 21.sql | **21.sql** ✓ but labelled 0021 |
| `0035` Engine 5 meters | 22.sql | **22.sql** ✓ but labelled 0022 |
| `0036` Engine 3 field ops | 23.sql | **23.sql** ✓ but labelled 0023 |
| `0037` Engine 6 vault | 24.sql | **24.sql** ✓ but labelled 0024 |
| `0038` Site labour | 25.sql | **25.sql** ✓ but labelled 0025 |
| `0039` The tables file | "20.sql?" | **20.sql** |

The numbers were right; the rows they were printed against were wrong, which
made the report unreadable. `44.sql` has the corrected mapping. The status
column — the part that decides what you actually run — was correct throughout.

---

## How I know this list works

I built a clean PostgreSQL 16 database and ran all thirteen files in exactly
the order above. All thirteen completed. Then I ran all thirteen **again** on
the same database to prove re-running is harmless — all thirteen completed a
second time with no errors and no changes.

Afterwards: all 7 new tables had row-level security **enabled and forced**,
each with a policy; all 15 views had `security_invoker = true`, meaning none
of them can leak across tenants.

One honest limit: files `41` and `42` reference tables created by migrations
you already have applied. I recreated those by hand to test, so what I proved
is that those two files run correctly against tables of that shape — not
against your exact production copies. Every other file was tested end to end.
