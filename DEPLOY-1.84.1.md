# Deploy v1.84.1-alpha , the build fix

Target repo **`app.ordence`**. **No SQL.** Push the code.

## What failed

```
Error: Job "prune_change_log" has cron "0 3 1 * *", which produces
fewer than two slots in the next 32 days
[Error: Failed to collect page data for /api/workers]
```

**This was never a scheduler failure.** `deriveMaxSilenceSeconds` throws
at module load, `buildCatalog()` runs at module scope, `/api/workers`
imports it, and `next build` collects page data for that route. The
compile succeeded , it died collecting page data.

## It was three jobs, not one

The build stops at the first, so the log names one. Measured against the
real catalogue:

| job | cron | before |
|---|---|---|
| `prune_change_log` | `0 3 1 * *` | no second slot in 32 days |
| `prune_security_events` | `30 3 1 * *` | no second slot in 32 days |
| `prune_usage_counters` | `0 4 1 * *` | no second slot in 32 days |

**Fixing only the job the log named would have produced three more failed
deploys, one per attempt.**

## Two fixes tried and rejected

**Widen the probe past 32 days.** Refused by the code itself:
`slotsBetween` throws above 40 days, and its message argues the case ,
"a backfill that silently starts 40 days ago is a backfill that silently
skips everything before that." That limit is load-bearing. A monthly cron
needs up to 62 days. The two cannot be reconciled by moving a number.

**Add three `maxSilenceOverrideSeconds` entries**, which is what the error
message recommends. Rejected: monthly is not an exotic cadence, it is the
most common retention cadence in the product, and three hand-written
windows reintroduce exactly what the derivation exists to prevent , a
window typed next to a cron string, two declarations of one fact.

## The fix

Hop instead of scanning. `nextSlotAfter` finds the next slot without
enumerating a range, and each hop of a monthly cron is at most 31 days,
comfortably inside the same 40-day bound. `deriveMaxSilenceSeconds` falls
back to chained hops only when the enumerating probe finds fewer than two
slots.

It takes the **worst of 14 hops, not the first**. A monthly gap is 28, 29,
30 or 31 days depending on when it is asked; deriving from a February hop
would leave the window three days short of a real July-to-August silence,
and a watchdog that is short fires on a healthy system, which is how an
alarm gets muted.

## Result

| job | cron | gap | watchdog window |
|---|---|---|---|
| `prune_scheduler_runs` | `40 2 * * 0` | 7.0d | 14.0d **(unchanged)** |
| `prune_change_log` | `0 3 1 * *` | 31.0d | 62.0d |
| `prune_security_events` | `30 3 1 * *` | 31.0d | 62.0d |
| `prune_usage_counters` | `0 4 1 * *` | 31.0d | 62.0d |

Stable across start dates in August, January and February , checked,
because a derivation that depends on the day you ask is not a derivation.

**No existing window changed.** A fallback that only runs when the probe
returns nothing cannot alter a job the probe can see.

## Verified

```
npx tsc --noEmit          clean
npm run gates:static      27/27 passed
```

## One thing to know before the scheduler runs

🔴 **`0128` is MISSING on your database.** `prune_change_log` calls
`public.prune_change_log(180, false)`, and `0128` is the file that creates
that function. The build will now pass and the job will be scheduled, but
it will fail at run time until `0128` is applied.

`0128` is first in the run order I sent. Same applies to `0132` for
`prune_scheduler_runs`.
