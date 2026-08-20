# Integration pre-mortem , the questions I will ask each track

Track H, wave H6. Written **before** any delivery arrives.

## Why this exists, and why now

Seven reports will arrive together, each a few thousand confident words.
Read in that state, a reviewer's attention goes where the report directs
it, which is exactly where the author was most comfortable. Questions
written afterwards are shaped by the answer.

So these are written first, from the briefs and from what is in the
repository today. Each one is:

- **answerable in a sentence or a command**, so it is cheap to ask
- **falsifiable**, so "yes" and "no" look different
- aimed at **the specific way that track's work is most likely to be
  wrong**, not at generic quality

The standing pattern in this codebase, found 23 times, is built and
unreachable, declared and unenforced, or verified by a floor. Every
question below is a version of "which of those three is this".

**A track that cannot answer its own questions quickly has not finished,
regardless of what its report says.**

---

## Asked of every track, before the specific ones

1. **Show me the thing failing.** For each claim, what did you delete or
   break to confirm the check would have caught it? A test that has only
   ever passed is not evidence.
2. **Name what you did not do.** Section 4 of every report is "found and
   not fixed". If it is empty, that is a finding in itself: nobody has
   ever finished a wave here without leaving something.
3. **Which of your changes has no caller?** Grep your own new exports.
   `recordApiCall`, `captureError` and `siem.ts` were all written well and
   called by nothing.
4. **What in your brief was wrong?** Track G found four wrong claims
   before writing a line. A track reporting zero has probably not checked.
5. **Where does your work assume another track landed?** Name the
   assumption; do not implement across the boundary.

---

## Track A , Scheduler

The likely failure is a scheduler that runs, looks healthy, and either
double-fires or silently stops.

1. **Show me two concurrent claims on the same slot.** One claim, one
   skip. If the ledger's uniqueness is a unique index, show the index; if
   it is application logic, it is wrong.
2. **Disable a job and show the alert.** The dangerous failure is not a
   job that errors, it is a job that stops being scheduled. Which
   component notices absence, and how long does it take?
3. **Is cron on the web service or a separate one?** If it is on the web
   service, every replica fires every job. Show me where it runs.
4. **Which existing dormant jobs are now scheduled, and which are not?**
   The brief listed dunning, three prune functions, usage rollups,
   licence expiry, GSTR runs. Name each one's state.
5. **Replay versus live run.** Show a ledger row where the two are
   distinguishable. If they are not, a backfill will look like history.
6. **What happens if a run overruns its slot?** Skip, queue, or kill,
   declared per job. "It has not happened" is not an answer.

## Track B , Observability

The likely failure is telemetry that is wired, emits, and is never read;
or an SLO with no consequence.

1. **`recordApiCall`, `captureError`, `siem.ts` , name the call sites.**
   Not "wired". File and line.
2. **Trigger one and show me where it landed.** If it cannot be observed
   arriving, it is not observability.
3. **What fails when an observability export has no caller?** You were
   asked to add that check. Show it refusing a deliberately orphaned
   export.
4. **Four SLOs: what is the consequence of exhausting each budget?** An
   SLO without a written consequence is a wish.
5. **Show one trace id crossing browser, server action and database.**
6. **Per-tenant cost telemetry: show two tenants with different numbers.**
   One tenant proves plumbing, not attribution.
7. **Does anything you log contain a secret, a token, or PII?** Show me
   the allowlist, not the denylist.

## Track C , Database integrity

The likely failure is a coverage claim that is true of a sample.

1. **The six tables whose RLS lives only in ALL-IN-ONE.** I measured this
   in wave H2: it is 26 objects, 23 of them protections, on `contracts`,
   `contract_versions`, `clause_library`, `ledgers`, `journal_entries`,
   `transactions`. Does your fix cover all 23, or the 6 policies only?
   Run `npm run report:allinone` and show it empty, or explain the
   remainder.
2. **FORCE row level security: how many tenant tables have it, out of how
   many?** Exact counts. `>=` in an assertion is the defect that let a
   48-of-303 coverage check report PASS.
3. **Show me a cross-tenant read being refused on a table you did NOT
   hand-pick.** Ideally on all of them.
4. **Add an unprotected table and show the drift detector failing.**
5. **Two `updated_at` functions consolidated: did the count of tables
   with a working `updated_at` go down?** It must not.
6. **Every migration you shipped: what does it raise if the change did
   not take?** A migration that can succeed while doing nothing is the
   same bug as a floor.

## Track D , Fail closed

The likely failure is a fix proven by reading rather than by breaking.

1. **Did you use `tests/helpers/unreachable-db.ts`?** I built it for this
   in wave H4. If not, why not, and what did you use instead? A stubbed
   client that throws proves the stub throws.
2. **Show the billing gate refusing with the database genuinely
   unreachable** , and then under `blackhole()`, where the connection is
   accepted and answers nothing. Code that handles a refused connection
   correctly frequently hangs on silence.
3. **⚠️ Before you "fix" the billing gate: it fails open ON PURPOSE and
   it logs.** The reasoning is written in `server/billing/access.ts`. The
   audit line "fails open silently" is wrong on the word silently. What
   exactly did you change, and why is denying now safer than an outage
   for every paying customer?
4. **`withPlatformScope`: show me a stored justification, and show the
   write being refused when it is empty.**
5. **`lockout.ts`: show a lockout whose write failed being distinguishable
   from one that succeeded.**
6. **Unknown permission strings: does an unrecognised one refuse?** Show
   it.
7. **`leads:assign`: what is the recommendation, the migration text, and
   the blast radius?** You were told not to ship it. Confirm you did not.
8. **The seven entries in `scripts/fail-open-registry.json`** , did you
   edit any of those files? If so, the reason should now be a FAIL OPEN
   comment in the code and the registry entry deleted.

## Track E , GST and tax

The likely failure is two implementations that agree today.

1. **How many code paths create a taxable line, and do they all reach one
   computation?** Name them. Sales invoices, credit notes, RA bills,
   bookings, subscriptions, e-way linked movements were the ones I could
   see.
2. **Show the database refusing an invoice whose stored GST disagrees
   with recomputation.** Construct one.
3. **The backfill: which historical rows could NOT be computed, and how
   are they marked?** If the answer is "all of them computed", you used
   today's rates on old invoices and that is wrong.
4. **Rate registry: show the same HSN returning different rates for two
   dates.**
5. **Rounding: per line or per invoice, half-up or banker's?** One answer,
   applied everywhere. Show the place it is decided.
6. **Minor units: what does your code do for JPY (0), KWD (3), CLF (4)?**
7. **Pick one invoice and trace its tax to the rule that produced it.**
   If that trail does not exist, an accountant cannot defend the number.

## Track F , Performance

The likely failure is numbers measured in the wrong conditions.

1. **Were your measurements taken with row level security ON, connecting
   as a role subject to it?** A policy that calls a function per row can
   turn an index scan into something quadratic. Measuring as the owner
   gives numbers that are wrong in the flattering direction.
2. **At what row counts?** A plan on 40 rows tells you nothing about
   400,000, and the sequential scan that is optimal at 40 is what kills
   you later.
3. **For each index added: the plan before and the plan after.** No plan,
   no index.
4. **Which indexes did you REMOVE?** An unused index is pure write cost.
   If the answer is none, you did not look.
5. **Connection pool: show me the arithmetic.** Replicas times pool size
   against Neon's limit. A guess here is an outage when the second
   replica appears.
6. **Any endpoint that can still return unbounded rows?**
7. **Cache keys: does every one carry the tenant id?** RLS does not
   protect a cache. Show me the key construction.

## Track G , Durable jobs

The likely failure is a delivery guarantee that holds only when nothing
crashes.

1. **Show a side effect NOT emitted for a rolled-back transaction**, and
   one NOT lost from a committed one. Both directions, both demonstrated.
2. **Kill the process mid-job. Nothing stranded, nothing duplicated.**
   Show the ledger before and after.
3. **You reported that much of section 6 already ships at 0097.** What
   exactly did you not rebuild, and what did you find wrong with it?
4. **The dead letter queue: re-drive something and show the replay
   recorded as a replay**, not as a fresh event.
5. **Retries: what is the ceiling, and what happens at it?** Unbounded
   retry against a permanent failure is a denial of service you built.
6. **One tenant importing 200,000 rows: show another tenant's mail still
   moving.**
7. **Track A had not landed when you started. Which assumptions did you
   write down, and do they match what A actually delivered?** This is the
   first thing to check once both are in.

---

## What I do with the answers

A track is **accepted** when its zip passes `assemble-wave`, its report
passes `verify-report`, and it answers its questions above without
needing to go and check.

A track is **held** when the work looks right but a question cannot be
answered quickly. Held is not failed; it means the evidence has not been
produced yet.

A track is **refused** when a claim turns out to be false. In that case
the useful output is not the refusal, it is the question that found it,
which goes into the next wave's briefs.

⚠️ **None of this proves a track is correct.** It finds the specific
failures this codebase has produced before. Something new will get
through, and the honest position is that these questions narrow the risk
rather than remove it.
