# v1.68.0-alpha , TWO STATUTES THE PRODUCT WAS NOT APPLYING

**Repo: `app.ordence`** * 🔴 **SQL: `0106`, run it before or after the push, either order is safe** * ⚠️ **No new environment variables**

**175 test files. 5,839 tests. All 15 gates green.**

- 🔴🔴 **RULE 53 , OUTPUT TAX WAS GROSS OF CREDIT NOTES.** Every workspace that
  has ever taken a return has been shown a GST liability that is **too high,
  every month**. The obvious fix, subtracting the credit notes, is wrong in four
  separate ways and each one produces a figure that foots:
  ① **s.34(2) has a deadline.** A note issued after 30 November following the
  financial year of the ORIGINAL supply does not reduce output tax at all. It is
  a commercial document; the tax stays. Subtracting it **under-declares**, which
  is the expensive direction. ② A reduction lands in the period it is **declared**
  in, not the period of the invoice it reverses. ③ **CGST reduces CGST.** The
  heads are different governments and netting across them is not netting.
  ④ **Netting below zero is carried, never clamped.** If credit notes exceed
  supplies in a period that is real, and it carries forward.
  ⭐ **One implementation, reached from both screens.** `lib/gstr1/netting.ts` is
  pure, and `getGstSummary` and `build.ts` both call the same
  `creditNoteEffect`, so the summary and the return cannot drift.
- 🔴🔴 **RULE 26 , TDS ON FOREIGN PAYMENTS USED NO RATE AT ALL.** Section 195
  deduction must be computed at the **telegraphic transfer buying rate**. The
  blocker was that `fx_rates` recorded *who published* a rate and not **which
  side of the spread it is** , mid, TT buying and TT selling are different
  numbers and the statute names one of them. `0106` adds the rate type.
  🔴 **It REFUSES rather than falling back.** No TT buying rate for the required
  date means no computation, by name. A short deduction makes the deductor
  **personally liable under s.201** plus interest under s.201(1A), so guessing a
  mid rate is the one answer that must never be available. `invertQuote`
  downgrades `tt_buying` to `unstated`, so a reciprocal cannot satisfy the rule
  either.
  ⭐ **The specified date is the earlier of credit and payment**, per s.195(1),
  and the code **refuses when it has neither** rather than defaulting to a clock.
  The common shape is credit in March and remittance in June; taking June gets
  the rate, the quarter **and** the s.201(1A) interest start all wrong.
  ⭐ The rate type is a **filter, not a preference**: excluded in SQL, excluded
  again in `pickQuote`, and refused by name if it somehow arrives. Turning the
  gate off makes 7 of 25 tests fail, so it cannot be decorative.

### ⚠️ A comment that had become a lie

`server/tds/registry.ts:173` still read *"Ordence applies Rule 26 nowhere, so
`chargeable_base_minor` is whatever rupee figure somebody typed."* True when
written, false as of this release, and it would have sent the next reader
hunting a gap that is closed. **A stale comment is a defect with a long fuse.**

### ⭐ Two gates ran for real for the first time

`check:sql-executes` and `check:rls-writes` have always **skipped** for want of a
database. This batch pointed `HARNESS_DATABASE_URL` at the throwaway PostgreSQL
and ran them properly. Both pass. `0106` applied **39 of 39 statements twice**,
one statement per connection, and 14 of 14 isolation and constraint refusals
held as a role with `rolsuper = f, rolbypassrls = f`.

### ⚠️ Known and not fixed

A tenant's reverse-direction rate outranks a correctly published direct one
(0101's precedence, not this batch's), so a conversion can **falsely refuse**
where a valid published rate exists. It fails **closed**, so no wrong deduction
results. And no screen yet lets a human enter a foreign-currency s.195 payment ,
the action and validator accept it, nothing calls them.

# v1.67.0-alpha , THREE STREAMS MERGED, ZERO COLLISIONS

**Repo: `app.ordence`** * 🔴 **SQL: `0104` then `0105`, in that order** * ⚠️ **No new environment variables**

**173 test files. 5,789 tests. All 15 gates green. `tsc` clean.**

Brief A (self-serve subdomains) and Brief B (per-tenant AI credentials) merged
into wave 5. **The three change sets did not overlap on a single file**, which
is what the partition was for.

## Brief A , the subdomain funnel exists

- 🔴 **The CSRF origin check now derives from `NEXT_PUBLIC_ZONE_DOMAIN`.** Every
  write from every tenant subdomain was answering 403 before Clerk and before
  routing, and every read worked, because GET is exempt. ⭐ The suffix match
  reuses `lib/tenant.ts`'s own `labelUnder()` rather than a private copy, so
  **the set of hosts that may WRITE and the set that RESOLVE are the same
  function**. A private copy in a security module is how those two drift, and
  the CSRF half is the one nobody notices.
- ⭐ **Depth is one label, refusing deeper.** `acme.ordence.com` is allowed,
  `a.b.ordence.com` is refused. Tenant slugs are one DNS label by construction.
- 🔴 **`/sign-up` → `/claim` → workspace, and the address is chosen BEFORE the
  Clerk organisation exists.** Choosing afterwards is a rename of a
  thirty-second-old workspace: it races the sole writer, and it spends 365 days
  of `0091`'s retention on an address nobody ever used.
- 🔴 **Every operator rename in this product took the workspace off the
  internet.** `middleware.ts:1031` compares Clerk's organisation slug against
  the host, and `renameTenantSlug` changed `tenants.slug` and never touched
  Clerk , so the console reported success, printed the new URL, and locked every
  member out with `/access-denied` on their own workspace. There is now a mirror
  that keeps the two equal, and it reconciles after commit.
- ⭐ **The rename decision went the other way from my inclination, with a better
  argument.** Recording a Clerk rename without applying it does not leave the
  address where it was , the dashboard edit has **already** changed the session
  claim, so not applying locks the workspace out. The precondition
  `rename-slug.ts` demanded (an owner notification) was built rather than
  waived, and the 301 already existed.

## Brief B , a workspace can bring its own AI key

- 🔴 **`lib/ai/client.ts` read `process.env[provider.envVar]` with no tenant
  dimension**, so every workspace shared one key, one budget, one rate limit and
  one circuit breaker. The key is now injected and the state is keyed by budget
  scope: `platform` or `tenant:<uuid>`.
- ⭐ **`budgetScopeFor("tenant", null)` throws** rather than falling back to the
  platform scope, because a silent fallback makes a resolver bug invisible by
  charging the platform for it.
- 🔴 **`lib/ai/client.ts:186` read `CLOUDFLARE_ACCOUNT_ID` directly**, which
  would have interpolated the platform's account id into a **customer's**
  Cloudflare token. It now comes from the credential.
- ⭐ **The confidential lane holds. A tenant's own open-lane key does not become
  eligible for tenant data**, and there is no override flag anywhere. The
  argument: the lane is about where the data goes, not about who pays, and a
  workspace admin cannot consent on behalf of four thousand contacts who have
  never heard of Cerebras. The honest answer to the customer is not "no" but
  "yes, with a Cloudflare key", which is self-service and one link away.
- ⭐ **A failure that a later provider papered over is still reported.** If a
  customer's Groq key is dead and Gemini answers, the request succeeds and the
  customer would otherwise never learn the key they pay for has stopped working.
- ⚠️ `settings/ai/page.tsx` hard-coded seven provider names against a registry of
  nine, so **OpenRouter , the only provider actually configured on production ,
  did not appear on the screen that exists to say which providers are
  configured.**

## What the merge proved

⭐ **Zero collisions.** Brief A touched 18 files, Brief B touched 26, wave 5
touched 21, and the intersection of all three was **empty** except for
`db/schema/index.ts`, which Brief B appended to at the very end exactly as the
brief demanded, and which wave 5 never touched.

`0105` was drilled independently: 15 of 15 statements twice, one statement per
connection, then tenant isolation proved as `ordence_app` with
`rolsuper = f, rolbypassrls = f`. A cannot forge a row for B, B cannot read or
delete A's rows, and **the table holds no column whose name contains key, secret
or token** , the credential itself lives in the vault.

# v1.66.0-alpha , THE ENGINES BECOME VISIBLE, AND A COMPLIANCE REPORT STOPS LYING

**Repo: `app.ordence`** * 🔴 **SQL: `0104`, run it before or after the push, either order is safe** * ⚠️ **No new environment variables**

Four batches in parallel. Two of them put a screen in front of an engine that
had none; two of them fixed numbers that were wrong.

- 🔴🔴 **THE GST REPORT WAS READING ORDENCE'S OWN SUBSCRIPTION INVOICES.**
  `getGstSummary` summed `billing.invoices` , the table where **Ordence bills
  its tenants** , and presented it as the tenant's outward supplies. An Indian
  business opened its GST report and saw its Ordence subscription bills.
  ⚠️ **Nothing caught it because both tables carry `cgst_minor`, `sgst_minor`,
  `igst_minor` and `taxable_value_minor` under exactly those names.** It
  compiled, it returned plausible rupee figures, and `db/schema/sales-invoices.ts`
  had warned about precisely this merge in its own header.
  Two more defects fell out of the same query: it filtered on `status = 'open'`,
  **which is not a value of `sales_invoice_status` at all**, and it counted
  LINES while the screen said "invoices".
  ⚠️ Named and not fixed: output tax is still gross of credit notes. Surfaced
  on the payload as `outputTaxExcludesCreditNotes` rather than left to be
  discovered at a return.
- 🔴 **FIXED ASSETS NOW HAS A SCREEN.** `0100` shipped Schedule II and Income
  Tax depreciation four batches ago and **nothing rendered it**. Register,
  depreciation run, whole-life schedule, income-tax block view, deferred tax,
  disposal. ⭐ **Compute and post are two separate buttons** , a posted run
  writes a journal and is frozen by a database trigger. The income-tax panel
  contains no path to `postDepreciation` at all, and a test asserts it.
- 🔴 **MULTI-CURRENCY NOW HAS A SCREEN.** `0101` shipped rates, restatement and
  revaluation and nothing called any of it. Rates, revaluation with its working
  paper, exposure by currency, conversion preview.
  ⭐ **A rate derived by inversion is labelled `derived` all the way to the
  screen**, because a customer evidencing a figure to an auditor needs to know
  the rate was computed rather than published.
  ⭐ **Skipped lines are shown with their reason.** A revaluation that silently
  ignores rows is worse than one that refuses.
- 🔴 **PAYABLES WERE CARRIED AT ZERO.** `0101` wired initial recognition for
  sales only and said so. So a foreign-currency bill had no functional figure,
  and its first revaluation booked **the entire invoice value** as an exchange
  difference. Now recognised at the bill-date rate, refusing rather than
  guessing when no rate exists for that date.
  ⭐ The ITC split apportions an already-translated tax head rather than
  re-converting it , re-converting is two more roundings that need not add back,
  and the balance check would refuse the journal by a paisa. **The odd minor
  unit is floored into cost, never into an input tax credit**: overstating a
  credit is a claim on the Government, overstating an expense is not.
- ⭐ **Three analytics views stopped adding currencies together.** `0104`
  regroups `v_asset_portfolio`, `v_contract_pipeline` and `v_ledger_daily` by
  the currency their underlying tables already carried.
  ⚠️ `v_ledger_daily` mattered most: a merged `isBalanced` could read **true**
  because two real imbalances in different currencies cancelled as bare numbers.

### ⚠️ Found on the way, not fixed, and it is the next thing to go wrong

`server/accounting/post-sales.ts` writes the literal `currency: "INR"` on nearly
every posting. Only `postExchangeDifference()` writes the functional currency.
So a workspace whose books are kept in dirhams has transactions **stamped INR
carrying dirham amounts**, and `v_ledger_daily` can only group by what the
column says , it cannot repair what the writer put there.

### ⚠️ And one of my own

`0100` shipped a complete depreciation engine that **no navigation reached for
four batches**. The screen in this release was added with a nav entry in the
same change, because built-and-unreachable is the same defect as
declared-and-unenforced wearing a different hat.

# v1.65.0-alpha , A RESERVED NAME MEANS A DIFFERENT ADDRESS, NEVER NO WORKSPACE

**Repo: `app.ordence`** * ⭐ **SQL: NONE. Push and it works.** * ⚠️ **No new environment variables**

Found in production. The founder created a Clerk organisation whose slug was
`ordence`, `lib/slug.ts` reserves that name, and the workspace was never
created. The screen said "your workspace is not ready yet" and nothing in the
system was going to change that.

- 🔴🔴 **THE SOLE PATH THAT CREATES A WORKSPACE HAD NO FALLBACK.**
  `_webhook.ts:425` took the Clerk organisation slug verbatim. `0091`'s guard
  trigger refused it, the transaction aborted, the handler returned 500, and no
  `tenants` row was ever written. The same failure was waiting for **any**
  customer whose organisation name normalises to a reserved word , Support,
  Admin, Billing, API, Portal, Secure, Status, Docs, Test, Dev, Mail, Pay,
  Invoice, GST and about sixty more , **and for any plain duplicate**. Two
  customers called Acme, and the second one gets nothing.
  The only conflict handling was `onConflictDoNothing` on the **organisation
  id**, which absorbs a redelivery and no name collision at all.
- ⭐ **The fix wires what already existed.** `suggestSlugs`,
  `rejectionFromPgError` and `checkSlugShape` have been in `lib/slug.ts` since
  0091 and were read by nothing on this path. **That is the tenth instance of
  this codebase's recurring defect**, and this one was the most expensive: it
  sat on the one code path a paying customer cannot route around.
- ⭐ **Deterministic by construction.** Svix delivers at least once, so two
  deliveries must converge on the same address. No clock, no randomness. The
  last-resort candidate derives from the Clerk organisation id, which is
  stable. For `ordence` the ladder is `ordence-india`, `ordence-group`,
  `ordence-projects`, ... then an id-derived name that cannot collide.
- 🔴 **Only slug refusals are caught.** A foreign key error, a NOT NULL
  violation or a dropped connection still propagates and still 500s, because
  Svix retrying those is correct. A catch-all here would have turned this fix
  into silent data loss, which is worse than the bug it replaces. There is a
  test that a non-slug error still reaches the 500.
- ⚠️ **A rename is NOT auto-fallen-back.** Changing an existing workspace's
  slug changes a live hostname and burns 0091's 365-day retention on the old
  one. If a Clerk rename resolves to a refused name, the slug is left alone,
  the display name still updates, and the refusal is recorded. Automating that
  rename would have been worse than not renaming.

### Two further defects found while fixing it

- 🔴 **Workspace creation was silently unaudited.** `writeAudit` opens its own
  `withTenant` transaction, and `audit_logs.tenant_id` has a foreign key to
  `tenants.id`. Called from inside the still-open provisioning transaction, the
  brand new tenant row is invisible on that second connection, so the insert
  failed its FK and `writeAudit`'s own catch swallowed it. **Every workspace
  ever created is missing its creation audit entry.** The write now happens
  after commit.
- 🔴 **A Clerk rename retained nothing.** The old update branch set
  `tenants.slug` with no `tenant_slug_history` bookkeeping, so the previous
  hostname was never released into the 365-day window , it was immediately
  free for another company while still live in bookmarks, in email and in the
  certificate transparency log. That is the exact hazard 0091's retention
  exists to prevent, bypassed by the one path that renames automatically.

### Still open, and it is a decision rather than a defect

⚠️ The webhook will still rename a live workspace automatically whenever the
new name **is** available. `rename-slug.ts` argues that a rename should be an
operator act with a stated reason, because there is no 301 redirect and no
owner notification yet. So an editor changing a field in the Clerk dashboard
can silently move a customer's public address. Worth deciding deliberately.

# v1.64.1-alpha , RESERVE THE RESEND HOSTS

**Repo: `app.ordence`** * 🔴 **SQL: `0103`, run it before or after the push, either order is safe** * ⚠️ **No new environment variables**

- 🔴 **Resend now has DNS under `ordence.com` and the reserved slug list did not
  know.** `updates.ordence.com` has been the verified sending domain for 16
  days; adding the root domain creates `send.ordence.com` with an MX and an
  SPF TXT. Neither label was reserved. `0103` adds `updates`, `send` and
  `resend`.
  ⭐ **The mechanism is subtler than 0092's and it generalises the rule.**
  `send` carries only an MX and a TXT, so the natural assumption is that the
  Railway wildcard still answers address queries for it. It does not: a DNS
  wildcard is used only when the queried name does not exist in the zone at
  all, and one MX record makes the name exist. An A query then returns NODATA
  rather than falling through to `*`. So a tenant claiming `send` would get a
  workspace whose hostname resolves to **nothing**.
  The rule is therefore not "an explicit address record beats a wildcard". It
  is **"any record at a name removes that name from the wildcard"**.
- ⚠️ **Second time this has fired.** Clerk in 0092, Resend here. Every time a
  vendor is given DNS under `ordence.com`, its labels are reserved in the same
  change. The reserved list is a mirror of the zone file, and a mirror goes
  stale silently.
- ⭐ **The SQL alone is enough to close the hole**, because 0091 deliberately
  made the reserved list a TABLE rather than a constraint. The database is the
  authority; `lib/slug.ts` is the advisory front-end copy that keeps the
  public form from naming a conflicting workspace.
- ⚠️ **A defect in my own verification, found and corrected.** My first check
  of "does the policy refuse an unscoped write" ran as `postgres`, which is a
  superuser, and superusers bypass RLS unconditionally. It printed a pass that
  proved nothing. Redone as a non-superuser role it refuses without platform
  scope and accepts with it, which is the actual claim. That is the third RLS
  bypass vector in this project's notes and it caught me anyway.

# v1.64.0-alpha , THE THREE ENGINES THAT WERE NOT THERE

**Repo: `app.ordence`** * 🔴 **SQL: `0100`, `0101`, `0102`, run IN THAT ORDER, BEFORE the code push** * ⚠️ **No new environment variables**

Mega-wave 4 closed three gaps that had the same shape as the seven before
them: a column that is stored and read by nothing.

- 🔴🔴 **FIXED ASSETS AND DEPRECIATION (`0100`) , the product could not
  produce a depreciation schedule at all.** `grep -ril depreciation`
  returned only Tally *import* validators: the system could read a figure
  somebody else had computed and could compute none of its own. New:
  `lib/fixed-assets/depreciation.ts` (pure, bigint paise, no `Date`),
  Companies Act Schedule II SLM and WDV with day-proration, residual,
  component accounting and shift uplift; **and, separately**, Income Tax
  s.32 block-of-assets with the half-rate rule under 180 days. The two
  computations diverge permanently and that divergence is the deferred-tax
  input. Depreciation posts through the existing `writePosting` path, not
  a second one, and inherits its closed-period refusal.
  ⭐ **Rounding is stated and tested**: every division floors, the residue
  stays in the balance, and the terminal period is charged the exact
  remainder, so a whole life sums to cost minus residual to the paisa.
  ⚠️ Two fields failed the read-at-a-computation test during the build.
  `block_class` was wired to the Appendix I rate whitelist. `cost_centre`
  was **deleted**, because it implied an allocation the single journal does
  not do.

- 🔴🔴 **MULTI-CURRENCY (`0101`) , and this one found a live control that
  was letting through 40 times its setting.** There were 16 `currency`
  columns in the schema and zero rate infrastructure, so `sum(amount_minor)`
  over a mixed set produced a number that was silently wrong.
  **The worst instance: `server/sales/refund-cap.ts` summed credit notes
  across currencies at 1:1 against a rupee cap.** Three USD 5,000 notes
  consumed 15,000 of a Rs 5,00,000 cap instead of about Rs 12,50,000.
  Now grouped per currency and converted; a bucket with no rate **refuses
  the issue**, because skipping it would relax the control.
  Six more currency-blind aggregations fixed (trial balance, credit-note
  headroom, GST summary, ageing labels, the reports formatter, and
  `lib/billing/money.ts`, which was wrong by 10x for KWD and 100x for CLF).
  ⚠️ **Minor units are not universally two decimals.** JPY has zero, KWD
  and BHD and OMR have three. The exponent is now carried per currency and
  an unknown code throws instead of defaulting.
  ⭐ Two rate tables, not one nullable column: published reference rates
  carry no `tenant_id`, manual rates are `tenant_id NOT NULL`. Isolation is
  structural rather than conditional on a predicate a future view could
  route around.

- 🔴 **BANK RECONCILIATION (`0102`) , and `bank_accounts.reconciled_to`
  turns out to have been the eighth instance of the pattern.** The column
  has existed since `0070`, is printed on screen, and the only write to it
  anywhere in the tree set it to `null`. Nothing read it, and `unmatch`
  deleted freely. There is now a reconciliation event that freezes its
  items, a **database trigger** that refuses any insert, update or delete
  of a match on or before the reconciled date, and a statement-level import
  digest so re-importing the same file adds nothing.
  ⚠️ **A pre-existing defect found while doing it:** `0087` granted
  `bank_line_matches` only `SELECT, INSERT` to `ordence_app`, with a
  comment claiming a guard trigger fired on UPDATE and DELETE regardless.
  **There was no such trigger.** On any deployment where `ordence_app`
  exists, `unmatch()` has never been able to run. `0102` creates the
  trigger `0087` assumed and grants the `DELETE`.
  ⭐ Auto-match scoring already existed and was **not** rebuilt. The
  suggestion stays advisory; a person confirms.

- ⚠️ **A defect in the delivered `0101`, found by the drill and not by
  reading.** The verdict SELECT at the end of the file contained a
  dollar-quoted literal whose delimiters had been mangled, so the very last
  statement was a syntax error. Under a browser console every earlier
  statement would have applied and the one row telling you it worked would
  have failed. Fixed before packaging. **This is the third time this
  project has been saved by running a file the way it is actually used
  rather than the way it reads.**

# v1.55.0-alpha — EVERY LINK IN THE STAFF CONSOLE

**Repo: `app.ordence`** · 🔴 **SQL: unchanged (`0086`–`0090`)** · ⚠️ **No new variables**

- 🔴🔴 **THE CONSOLE LOADED AND EVERY LINK IN IT WENT TO A 404.** Traced
  live against production, the chain was: click a nav item →
  `/platform/tenants` → not rewritten on the console host (it already
  starts with `/platform`) → falls through to tenant resolution → redirect
  to `/dashboard` → **that** IS rewritten to `/platform/dashboard` → which
  does not exist → 404.
  ⚠️ **The console is served at two base paths**: `/platform/x` on
  `app.ordence.com`, and `/x` on `admin.ordence.com` where middleware
  rewrites. Every link was written for the first and the operator uses the
  second.
  **Fixed with `lib/platform/console-href.ts`**, one helper reading the
  request's own Host header. All twelve hard-coded links updated; the one
  in a client component became relative, because a client component cannot
  read the host and a relative href resolves against whichever base it is on.
- ⚠️ **A fix that looked tidier was wrong, and testing caught it.** Turning
  the middleware rewrite into a redirect reads better and would have broken
  the one path that DID work, since the rewritten form is currently the only
  one that resolves. The links were wrong, not the routing.
- ⭐ **EIGHTEENTH GATE: `check:console-links`.** No hard-coded `/platform`
  href inside `app/platform/**`. Proven by reintroducing one.
- ⚠️ **Eighteen gates green. 128 test files, 4,467 passing.**
# v1.54.0-alpha — THE 500 ON EVERY ROUTE

**Repo: `app.ordence`** · 🔴 **SQL: unchanged (`0086`–`0090`)** · ⚠️ **No new variables**

- 🔴🔴 **THE ENTIRE APPLICATION WAS RETURNING 500, ON EVERY ROUTE, ON BOTH
  HOSTS.** `app/layout.tsx` is a server component and declared a wrapper
  that called `useUtmReport()`, a hook from a `"use client"` module.
  Declaring the wrapper inside the layout looks like it makes it a client
  component; it does not. The root layout renders on every request, so
  React threw on every route in the product while `/api/health` stayed
  200 and the deployment reported healthy. From the Wave 8b UTM item.
  **The fix is where the component lives, not what it does**: `UtmCapture`
  moved into the `"use client"` module and the layout renders it.
- ⭐ **SEVENTEENTH GATE: `check:client-hooks`.** A file without
  `"use client"` may not import and call a `use*` identifier from a file
  with it. Proven by reintroducing the exact defect.
- ⚠️ **`app.ordence.com/platform` now returns 404 BY DESIGN.** Once
  `PLATFORM_HOST` resolves, the console is refused on the app host and
  lives at `admin.ordence.com`. That is the documented behaviour, not a
  regression.
- ⚠️ **Seventeen gates green. 128 test files, 4,467 passing.**
# v1.53.0-alpha — THE BUILD FIX, AND THE GATE THAT SHOULD HAVE CAUGHT IT

**Repo: `app.ordence`** · 🔴 **SQL: unchanged from v1.52.0 (`0086`–`0090`, all BEFORE the push)** · ⚠️ **No new variables**

- 🔴 **RAILWAY BUILD FAILURE FIXED.** `app/api/webhooks/clerk/route.ts`
  exported three handler functions so `_handlers.ts` could re-export them
  for the evidence tests. A Next.js `route.ts` may export only the HTTP
  verbs and Next's config fields; anything else is a **build error**, and
  the deploy went red.
  ⚠️ **Every gate was green when it shipped.** `tsc --noEmit` passed, all
  4,467 tests passed. That rule is enforced by types Next.js GENERATES
  during `next build`, so it does not exist until a full production build
  runs — and that build is OOM-killed on the machines this is developed
  on. The failure could only surface on Railway.
  **The implementation did not move.** It is `_webhook.ts`, byte for byte;
  `route.ts` is now three lines that re-export `POST`.
- ⭐ **NEW SIXTEENTH GATE: `check:route-exports`.** Static, no build, no
  memory. It reads every route file's exports against the list Next.js
  accepts. Verified by reintroducing the exact defect: it reports
  `"handleUserCreated" is not a valid Route export field` and exits 1.
- 🔴 **The rate limiter was importing the Node build of `@upstash/redis`
  into the Edge Runtime.** `next build` warned that `process.version` is
  unsupported there, and a warning is why it survived: the build goes
  green and the per-tenant limit is the thing that silently does not work
  in the runtime it was written for. Now `@upstash/redis/cloudflare`.
- ⭐ **`check:boundaries` caught the consequence unprompted.** Once the
  implementation left the route file it became an ordinary module, and the
  census asked it to declare itself. It now imports `server-only`.
- ⚠️ **Sixteen gates green. 128 test files, 4,467 passing.**
# v1.52.0-alpha — THE MERGE AND THE THIRD GUARD PUT BACK

**Repo: `app.ordence`** · 🔴 **SQL: `0086`, `0087`, `0088`, `0089`, `0090` — all BEFORE the code push** · ⚠️ **No new variables**

Manus's v1.51.0 test-harness work merged with the repair pass, and one
production guard restored that v1.51.0 deleted.

- 🔴🔴 **0090 DROPPED THE ONLY GUARD REFUSING AN INSERT INTO A CLOSED
  PERIOD, IN A FILE TITLED "message normalization" THAT SAID IT CHANGED
  NOTHING.** `transactions_period_lock` (0005) fires on UPDATE and DELETE
  only. `ordence_guard_closed_period` (0073) is the only one covering
  INSERT, and 0090 dropped it, because a test expected the header to land
  and only the leg to be refused. The database was stricter than the test.
  **Restored, with the reasoning written into the file.**
- 🔴 **0089 no longer leaks across tenants.** `FOR ALL USING (true)` was
  OR'd with the read policy and erased it; proven on PostgreSQL 16 and
  proven fixed the same way. `VERIFY-0089` rewritten to test behaviour
  rather than policy shape, and a DRILL added that reproduces the leak on
  purpose before showing the shipped clause refusing it.
- 🔴 **The payroll half-day now reaches the arithmetic.** `run.ts` passed
  the floored figure, so the centidays code never saw a fraction and a
  0.5-day loss of pay charged nothing. `unrepresentableCentidays` is
  derived again rather than hardcoded to 0, so the refusal at `run.ts`
  is a live guard instead of dead code.
- ⭐ **Both lockout reads are platform-scoped**, so `check:rls-writes` is
  green. Fixed independently by two authors the same way.
- ⭐ **New: `CHECK-EVERYTHING-neon-safe.sql`** — one read-only file, five
  result tabs: migration status, what to run in order, gaps, tenant
  isolation, and the connection's own flags.
- ⚠️ **Fifteen gates green. 128 test files, 4,467 passing.**
# v1.48.0-alpha — THE REPAIR WAVE, RUN UNDER INTEGRATION
## v1.51.0-alpha — Hardening III (stabilization)
**Repo: `app.ordence`** · 🔴 **SQL: 0090_period_close_message_normalization.sql** (applied locally before code work) · ⚠️ **No new variables**
Test-harness stabilization wave, no product features: the neon driver's WebSocket path now works against the disposable local PostgreSQL through a loopback WebSocket-to-PG bridge in `tests/setup.ts` (RFC 6455 framing, PG startup parsing, pg-message reassembly, outbox queue, drop of neon's preemptive cleartext password). `billing-gate.test.ts` and the whole security suite now run green end-to-end through `withTenant`'s real neon Pool/WS transport. No product code shipped in this wave; the pg_hba trust rules are local-only and never cross into Neon (throwaway PostgreSQL 16 only).

---

## v1.50.0-alpha — Hardening II + UX
**Repo: `app.ordence`** · 🔴 **SQL: 0089_hardening_login_lockouts.sql** (with 0088 pending from Wave 8) · ⚠️ **No new variables**
CSRF verification with origin binding and server-action digest presence checks, session-reset evidence on password rotation, failed sign-in evidence through the Clerk webhook, DB-backed login lockouts (`login_lockouts`, opt-in platform write), reset-link/upload-ticket expiry guarantees (10-minute upload tickets, enforced at verification), enumeration-prevention audit (no server-side email existence checks exist), 0087 function-surface correction (the application function EXECUTE grants the app role actually needs), and the Wave 8b UX set: dark mode with system fallback, cookie banner, top-bar site search, mobile menus, loading and hover states, scroll progress, copy buttons, print stylesheet, sticky headers, skip-to-content, password visibility toggle, UTM capture, form success/error states, confirmation modals, last-updated dates, expandable FAQ and the back-to-top floating control. **15 of 15 gates green; 4,442 UI tests passing; tsc clean.**

---

**Repo: `app.ordence`** · 🔴 **SQL: none new — this run fixes code and one pre-existing SQL policy from v1.47** · ⚠️ **No new variables**
The four interrupt-damaged batches from the mega-wave (opening balances,
cost centres and budgets, appraisals and the org chart, the platform
edge) plus the three found-not-fixed defects. No new features: this is
the wave that makes the shipped surface honest. **31 of 128 batches,
counted from files.**

## ⭐ WHY THE FOUR REPAIR BATCHES EXIST

**Opening balances (batch 58)** — reviewed and closed by hand. Import
imports `import/open` files; the ledger reconciles the opening trial
balance to zero on completion or refuses the import. The one gap found
is documented in the deploy file, not papered over.

**Cost centres and budgets (batch 68)** — reviewed and closed by hand.
Nullable `cost_centre_id` on journal lines with an "un-costed" bucket
that can never be hidden. The three carry-forward defects this run
fixes each have their own section below.

**Appraisals and the org chart (batch 109)** — reviewed and closed by
hand. One test in the shipped suite collapsed the release-semantics
assertion into the draft branch (a call without `submitted`), which is
now explicit on both calls. The readership matrix itself was correct.

**The platform edge (batch 31)** — reviewed and closed by hand. Limits
live in `lib/edge/limits.ts`; the enforcement sites pass the census.

## 🔴 THE THREE DEFECTS, FIXED AT THE SITE

**1. Payroll aborts on a half-day loss of pay.** `payslip.ts:216` called
`BigInt(worked)` where `worked` can be `30.5`, and `BigInt(30.5)` is a
RangeError that kills the entire company's payroll compute. Batch 50's
whole-days-only rule was a mitigation, not a fix. The fix: centidays.
`worked` is now stored and carried as centidays (1/100 of a day) end to
end — a half day is `3050`, arithmetic stays integer, `BigInt` stays
happy, and the loss-of-pay panel accepts half-day entries instead of
converting them to a problem. Money never left paise; attendance never
leaves centidays. The two rounding decisions are pinned in the deploy
file.

**2. An impersonated session attributed actions to the customer.**
`writeAudit` picked `user.email` and `role` from the session and never
looked at the platform operator behind it, so an operator's work under
impersonation wrote under the customer's name with no trace that a
human on the platform did it. It now picks `operatorEmail` from the
context when present and attributes the actor to the operator under
impersonation, with the customer identity preserved in metadata — one
content object, never a second row, so the audit ledger stays whole.

**3. `recordPlatformAudit` wrote outside the hash chain.** The platform
console's audit writer bypassed `appendChainedAuditRow` and inserted a
plain row — on the table whose whole point is that nothing gets in
without a `prev_hash`. The tenant branch now goes through the chained
writer; the chain constants it needs are exported from
`lib/audit/chain.ts` so there is exactly one chain and one copy of the
constants.

## 🛡 ONE NEW SCREEN, TWO GUARDS

The migrations-status screen ships behind its own key and is now
**explicitly platform-console evidence only**: `requirePlatformAdmin`
sits directly in the action body (visible to the guards census —
delegation into the library was invisible to it), and the library
function carries the same guard for every other caller. A status
endpoint any tenant could call would hand every workspace a map of
which enforcement exists in the database — including which hash-chain
columns a bad actor should blank.

## ⚠️ CARRY-FORWARD — NOW IN THE DEPLOY FILE, NOT IN MEMORY

**The 0079 policy anomaly.** The `tenant_health_events` and
`platform_entitlement_history` policies shipped in 0079 with
`WITH CHECK (app_platform_scope())`, which the RLS census reads as a
cross-tenant write permission. 0074's form —
`WITH CHECK (app_current_tenant_id() IS NULL)` — is the one the census
accepts and the one that matches the documented intent (platform
sessions only, tenant sessions never). Functionally identical today
because platform scope is the only writer, but the census treats the
two as different and the safer form is the documented intent, so 0086
is the corrective file in this package. **Read-only, one transaction.**

**The pre-existing test failures.** 24 security-suite failures persist,
all inherited from v1.47's own shipped code (the receivables trigger
assumptions, the tally/tds/wiring suites) and every one documented in
the v1.47 deploy file as found-not-fixed. None are caused by this run;
the diff against the v1.47 baseline shows zero regressions and two
fixes (the platform audit chain tests, which now pass).

## 📏 THE COUNTS, ENUMERATED FROM FILES

Tests: 5,646 (security 22 + unit/UI 5,426 passed; 24 security failures
pre-existing). Gates: 14 of 15 green — the fifteenth (RLS) fails only
on the two 0079 platform policies this package corrects via 0086.
Batch counter: 31 of 128.
# v1.47.0-alpha — THE WAVE THAT WAS CUT SHORT, LANDED WHOLE

**Repo: `app.ordence`** · 🔴 **SQL: `0083`, `0084`, `0085` — all three run BEFORE the code push, in that order** · ⚠️ **No new variables**

Eight file-disjoint tracks. Three were interrupted near the end and their
work was completed by hand during integration. **29 of 128 batches,
enumerated from the files rather than from memory, which corrects a
running tally that had drifted 4.5 high. Mega-wave 1 is complete.**

- 🔴🔴 **BATCH 50 · `attendance: []` IS GONE.** Payroll now reads
  `staff_attendance` and approved leave through a new bridge, entirely in
  **centidays**, and the LOP position is visible and reviewable BEFORE the
  run is approved. `computePayrollRun` no longer accepts an `attendance`
  array from the browser at all: shape-validated and believed, it let a
  crafted request dock any employee any number of days with nothing
  recording that the figure never came from the register.
- 🔴🔴 **A HALF-DAY LOP ABORTS THE ENTIRE PAYROLL COMPUTE.**
  `lib/payroll/payslip.ts:216` does `BigInt(worked)` where `worked` can be
  `30.5`. `BigInt(30.5)` is a **RangeError**, not a rounding. Unreachable
  while `attendance: []` stood; reachable the moment Batch 50 lands.
  Mitigated, not fixed: only whole days are charged and the remainder
  becomes a stated problem blocking approval.
- 🔴 **BATCH 40 · A CREDIT HOLD REFUSES THE WRITE**, inside
  `confirmOrder`'s own transaction, not by hiding a button. Exposure is
  billed plus unbilled; the billed half is checked two ways that share no
  source and the figure is structurally ABSENT from the payload when they
  disagree. Dunning **queues and sends nothing** — stated in the migration
  header, the module header, the table comment, and asserted by tests.
- 🔴 **BATCH 30 · UNDER IMPERSONATION, THE CUSTOMER'S AUDIT LOG RECORDS
  OUR STAFF'S ACTIONS UNDER THEIR OWN EMPLOYEE'S NAME.** `ctx.user` is the
  session subject, a real user row in the customer's tenant.
  `ctx.operatorEmail` is on the context and is never persisted. The
  comment at `server/audit.ts:352` asserts the opposite of its own code.
  Worked around on the page, not fixed at the source.
- 🔴 **BATCH 76 · `payroll_runs` HAS NO DATE OF PAYMENT.** The whole
  Payment of Wages Act is about that day and it is the first column an
  inspector reads. The wage register prints it blank-and-named rather
  than passing off `posted_at` as the day money moved. The loans register
  **refuses to generate** rather than print an empty correctly-headed form.
- ⭐ **BATCH 58 · opening balances**, riding Batch 57's import framework.
  ⭐ **BATCH 68 · cost centres on the journal LINE, not the header**, with
  budget-versus-actual. ⭐ **BATCH 109 · appraisals and an org chart that
  refuses a cycle in the reporting hierarchy.** ⭐ **BATCH 31 · per-tenant
  rate limits, body size caps and pagination bounds enforced in the query.**
- ⚠️ **Fifteen gates green. 122 test files, 4,347 passing (+499).**
- ⚠️ **New: `WHICH-MIGRATIONS-ARE-APPLIED-neon-safe.sql`**, a read-only
  file that reports which of 0001 to 0085 are on a database and the exact
  list to run, in order. Every migration is matched to an object only that
  migration creates, so no file can be reported applied because another
  happened to create the same thing.
# v1.46.0-alpha — EIGHT BATCHES IN ONE RUN

**Repo: `app.ordence`** · 🔴 **SQL: `0082_leave_and_attendance.sql` (run BEFORE the code push)** · ⚠️ **No new variables**

Eight file-disjoint tracks built concurrently, then one integration pass.
Batches 39, 59, 153, 49, 46+47, 52, plus two engine fixes carried over
from v1.44.0's found-not-fixed list. **25.5 of 128 batches.**

- 🔴🔴 **BATCH 59 · PAYROLL PAID EVERY SALARIED PERSON A FULL MONTH,
  ALWAYS.** `payroll-run-board.tsx` passed `attendance: []` hardcoded,
  because there was no table to read from: `site_attendance` records
  contract labour, who are on nobody's payroll. `0082` adds
  `staff_attendance` and a leave ledger. **A balance is derived from
  entries and never stored** — there is no `leave_balances` table and its
  absence is the design. Accrual is **earned, not granted**: a full
  year's entitlement appearing on 1 April for an October joiner is a
  liability the business does not owe and discovers in March.
- 🔴🔴 **A ONE-OWNER PLATFORM DEADLOCKED ITS OWN APPROVAL QUEUE THE DAY
  IT HIRED.** `soleOperator` counted every operator grade; every policy
  needs `owner`. Grant the first support engineer and the count becomes
  2, so the owner is refused ("another operator can approve it") and that
  operator is refused on grade. Nothing could be approved again.
  `decideRequest`'s answer is now recomputed and the caller's ignored,
  because a caller-supplied "am I alone" is a caller-supplied
  authorisation decision.
- 🔴 **A BILL WITH NO LINES REPORTED "the order, the receipt and the bill
  agree on every line"** to the control that authorises paying a vendor,
  and `purchase_invoices` carries its own header total, so it was payable
  for real money nothing had checked. Now `unmatched`, which the payment
  run already knows to stop on.
- 🔴 **THE LAST-ADMIN GUARD COUNTED REMAINING OWNERS WITHOUT ASKING
  WHETHER ANY OF THEM WAS STILL ON `PLATFORM_ADMIN_EMAILS`.** Access
  needs both keys. The screen refused that case; a screen is a mistake
  guard, not a boundary. The allowlist is now a term in the counting
  query.
- ⭐⭐ **BATCH 153 · A FIFTEENTH GATE THAT STANDS UP TWO LIVE TENANTS AND
  TRIES TO READ ACROSS.** The four existing isolation controls check
  facts, schema coverage, four representative shapes, and production with
  a tenant id belonging to no workspace. None of them issues a real query
  as tenant A for tenant B's rows. **It found Batch 59's leave tables
  unprotected on its first run, unaided.**
- ⭐⭐ **BATCH 49 · THE CASH-FLOW DOCTRINE GENERALISED.** Compute twice by
  routes that share no ledger; when they disagree render no figure at
  all. Applied to receivables and billing, which had no tie between the
  ageing report and the books at all.
- ⭐ **BATCH 52 · `statutory_rates` HAS BEEN EFFECTIVE-DATED SINCE BATCH
  15 WITH NO WAY TO WRITE A SECOND ROW.** A Finance Act slab move was a
  deploy or a psql prompt, and the obvious statement to type,
  `UPDATE statutory_rates SET payload = ...`, silently restates every
  payslip ever computed. Nothing errors and the employee finds out.
- ⭐ **BATCH 39 · THE ITC REVERSAL SHOWS ITS WORKING**, and **BATCH 46+47
  · offboarding and a configuration chain** so a customer's setting has
  provenance rather than being the moment somebody typed it.
- ⚠️ **Fifteen gates green. 114 test files, 3,848 passing (+276).**
# v1.24.0-alpha — GSTR-3B, THE SET-OFF, AND WHAT YOU ACTUALLY OWE

**Repo: `app.ordence`** · 🔴 **SQL: `0077` (run BEFORE the code push)** · ⚠️ **No new variables**

Batch 16. ⚠️ **Note the number: 0077, not 0076** — the third time a
retired number has tried to come back, and the third time the gate
refused it.

- 🔴🔴 **GSTR-1 IS A STATEMENT. GSTR-3B IS THE ONE YOU PAY FROM.**
  Ordence has built GSTR-1 since v0.9x and it settles nothing. The 3B is
  where output tax meets input credit and whatever is left has to leave a
  bank account by the twentieth.
- 🔴🔴🔴 **CGST CREDIT MAY NEVER BE SET OFF AGAINST SGST, OR THE OTHER
  WAY ROUND.** Not in any order, not as a last resort. They are different
  governments. A set-off that treats the pools as interchangeable
  produces a smaller, entirely plausible cash figure, and the department
  disagrees months later with interest attached. The set-off order is
  written as **data rather than control flow**, so it can be read against
  the section instead of simulated in somebody's head.
- ⭐⭐⭐ **AND A WORKED EXAMPLE IN THE TESTS CAUGHT A REAL FLAW IN MY OWN
  FIRST VERSION.** Spending the leftover IGST credit on CGST first — the
  obvious order — clears CGST, strands CGST credit that can never cross
  to SGST, and pays SGST **in cash**. On the example in the test that is
  ₹10,000 a month of avoidable cash. The remaining IGST is now allocated
  against the shortfall each head would still have after its own credit,
  proportionally. It is legal (any order is permitted), never worse, and
  frequently better.
- 🔴 **REVERSE CHARGE IS HELD OUT OF THE SET-OFF ENTIRELY.** It is
  payable in cash by law: the credit for it arises only once it has been
  paid, so discharging it from credit spends something that does not
  exist yet. It is the second most common 3B error.

- ⭐⭐ **THE RECLASSIFICATION JOURNAL, WHICH ALMOST NOBODY POSTS.**
  Invoices credit Output tax, purchases debit Input tax, and left alone
  both sides grow forever — a balance sheet showing ₹40 lakh owed and
  ₹38 lakh receivable when the business owes ₹2 lakh. It balances, it is
  arithmetically correct, and a lender reading it sees a company with a
  large tax liability. One journal now clears both sides by **exactly
  what the set-off utilised**, and leaves the cash portion in its own
  account.
- ⚠️ **THE AMOUNTS COME FROM THE SET-OFF, NEVER FROM THE BALANCES.**
  Clearing "whatever is in the account" would sweep up credit the return
  did not claim and output tax from a period already filed.

- ⭐⭐⭐ **AND THE SCREEN PEOPLE WILL ACTUALLY OPEN DAILY: WHAT IS DUE.**
  Everything owed to a government this month — GST, both TDS sections,
  provident fund, pension, ESI and professional tax — with due dates,
  **from actual ledger balances**. Every one of those liabilities was
  already correct and none of them was on one page: the only way to
  answer "what do I owe" was to open a trial balance and know which eight
  accounts to read, which is a thing nobody does on the 6th.
- 🔴 **IT IS NOT BEHIND A FEATURE GATE, AND THAT IS AN ETHICAL DECISION
  RATHER THAN A COMMERCIAL ONE.** A tenant who has stopped paying us
  still has to pay the Government, and the interest, late fees and
  provident-fund damages that follow a missed date are not ours to hold
  hostage. The module-registry gate refused the change until the
  reasoning was written down, which is the gate working.
- ⚠️ **"THE 15TH OF THE FOLLOWING MONTH", NEVER "THIRTY DAYS AFTER".**
  The two are different dates in eleven months out of twelve, and the
  second is how a compliance calendar quietly drifts.

- 🔴 **A BUG CAUGHT IN MY OWN CODE BEFORE IT SHIPPED.** `buildGstr3b`
  took the taxable value in its facts, used it for nothing, and did not
  return it — so the action storing the return wrote a literal zero. A 3B
  whose tax is right and whose taxable value is nil fails the portal's
  own validation, and it looked entirely plausible in the database.
- ⚠️ **AND MY OWN EDITS WENT INTO THE BUILD STAGING COPY TWICE MORE.**
  Same trap as last session: written to the staging tree, overwritten by
  the next sync, `tsc` green throughout because staging still had them.
  Caught both times by tests that read the source file.

**Gates:** all eight green — `tsc`, `check:boundaries`,
`check:migrations`, `check:sql`, `check:posting` (6 of 9, unchanged —
returns declare tax, they do not create it), `check:reachability`,
`test:ui` (77 files, **2,832 passing**, 55 new), `next build`. RLS drill
run as non-superuser `app_user`: 8 positives, 10 refusals, every refusal
paired.

**Deliberately not in this batch:** portal filing (needs a GSP, which
needs the LLP), GSTR-9 and 9C (they read a year of 3Bs, so a year of them
has to exist first), and the rule 42/43 apportionment calculator — the
reversal figure is **entered**, because apportioning credit needs
turnover splits Ordence does not model and a wrong reversal is a wrong
return with interest on it.

---

# v1.23.0-alpha — PAYROLL, AND A JOURNAL THAT DEBITS THE GROSS

**Repo: `app.ordence`** · 🔴 **SQL: `0075` (run BEFORE the code push)** · ⚠️ **No new variables**

Batch 15, the largest remaining piece. `check:posting` moves from 5 of 9
to **6 of 9**.

- 🔴🔴 **THE PAYROLL JOURNAL IS THE ONE MOST OFTEN GOT WRONG, AND IT IS
  ALWAYS WRONG IN THE SAME DIRECTION.** The wrong version debits
  "Salaries" with the NET paid and credits the bank. It balances. It is
  also understated by every rupee of PF, ESI, professional tax and TDS
  withheld — money the business spent on employing people and owes to
  somebody else. **Ordence debits the GROSS**, debits the employer's own
  contributions on top, and credits five separate liabilities.
- ⚠️ **AND IT NEVER TOUCHES THE BANK.** Payroll ACCRUES. What leaves the
  bank is a later event against Salaries Payable, on the day the transfer
  clears. Collapsing the two would claim money left the bank on a day it
  did not.
- 🔴 **PENSION IS ITS OWN PAYABLE, SEPARATE FROM PF.** Same challan,
  different account head. A single netted "PF payable" balance cannot be
  reconciled against an ECR — the same argument as the two stock variance
  accounts in v1.18.0.

- ⭐⭐⭐ **NOT ONE STATUTORY RATE IS A CONSTANT.** Every percentage,
  ceiling and slab is a row with an effective date. **Payroll is
  retrospective by nature:** somebody asks for last March's payslip and
  it must produce the number they were actually paid. A rate compiled
  into code means March gets recalculated with April's number the next
  time anybody reissues it, and nobody notices until the employee
  compares it with their bank statement.
- ⚠️ **AND A MISSING RATE REFUSES RATHER THAN DEDUCTING ZERO.** A payroll
  that quietly skips PF because nobody configured it is worse than one
  that stops: it produces a plausible payslip and is discovered by an
  inspector.

- ⭐⭐ **ESI HAS A CLIFF, NOT A CEILING, AND THAT IS THE WHOLE TRAP.** PF
  contributes on the ceiling when wages exceed it; ESI stops altogether.
  Treating them alike deducts 0.75% of ₹21,000 from somebody earning
  ₹40,000 who is not covered at all. The contribution-period continuation
  rule is implemented too: crossing the limit mid-period keeps somebody
  covered until the period ends, because dropping them the month they get
  a rise loses them medical cover.
- ⭐ **PROFESSIONAL TAX IS PER STATE, AND THREE STATES ARE SEEDED.** The
  rest are deliberately empty: a wrong slab is worse than a missing one,
  because a missing one says so on the payslip and a wrong one deducts a
  confident amount that is not right. Maharashtra's February top-up is
  included, and it is the reason the engine knows what month it is.

- 🔴 **INCOME TAX IS A PROJECTION AND THE CODE SAYS SO EVERYWHERE.**
  Monthly TDS under section 192 depends on declarations nobody has made
  yet. Every payslip carries the projection it was built from and its
  caveats. **The accountant's override is first-class**, because a
  payroll system that refuses their number is one that gets bypassed with
  a spreadsheet, after which nothing in the ledger is right.
- ⚠️ **NO PAN MEANS A REFUSAL, NOT A GUESSED 20%.** Applying section
  206AA to somebody who has simply not typed their PAN in yet is a very
  expensive way to chase a data-entry gap.

- ⭐⭐ **THE PAYSLIP CARRIES ITS OWN WORKING.** Every other total in this
  product is checked by a machine or not at all; a payslip is checked by
  a person with a calculator who is owed the money. So each line prints
  how it was arrived at, nothing is netted, and a figure the system is
  unsure of is a stated PROBLEM rather than a confident number. **A run
  with any problem cannot be approved.**
- 🔴 **APPROVAL FREEZES THE PAYSLIPS, IN THE DATABASE.** Approval is a
  signature on a wage bill. If a payslip can still change afterwards the
  signature attaches to nothing, and the change made after approval is
  never a typo — it is a number somebody wanted to be different. The
  remedy is to cancel with a reason and re-run, which leaves both on the
  record.
- ⚠️ **ONE LIVE RUN PER PERIOD, ENFORCED BY AN INDEX.** Two payrolls for
  the same March both post and the wage bill doubles in the ledger with
  nothing reporting a problem — every figure downstream then exactly
  twice the truth and entirely plausible.

- ⭐ **NO AADHAAR AND NO BANK ACCOUNT NUMBER.** Ordence accrues payroll
  and does not disburse it, so an account number here would be a
  credential sitting in a row every support session can read, in service
  of a feature that does not exist. When NEFT advice files are built they
  will read from `vault_secrets`.
- 🔴 **FOUR PERMISSIONS, AND THE SPLIT IS THE ONLY CONTROL THAT MATTERS.**
  The person who enters a raise and the person who signs off the month's
  wage bill must be able to be two different people. The accountant role
  gets `payroll.read` and `payroll.post` and deliberately not
  `payroll.manage`.

- 🔴 **A GAP FOUND IN EXISTING CODE WHILE BUILDING THIS.** v1.21.0 added
  the period lock to `writePosting` and not to `writePropertyPosting`.
  The DATA was never at risk — 0073's trigger sits on `transactions` and
  refuses the insert whichever writer attempts it — but a correct refusal
  delivered as an unhandled database exception is read as a bug, and the
  response to a bug is to look for a way around it. Fixed.
- ⚠️ **AND ONE OF MY OWN EDITS WAS SILENTLY LOST.** Three registry
  changes were written into the build staging copy instead of the source
  tree and then overwritten by the next sync. `tsc` was green because
  staging still had them. **The reachability test caught it**, which is
  exactly the job those tests exist to do.

**Gates:** all eight green — `tsc`, `check:boundaries`, `check:migrations`,
`check:sql`, **`check:posting` now 6 of 9**, `check:reachability`,
`test:ui` (76 files, **2,777 passing**, 73 new), `next build`. RLS drill
run as non-superuser `app_user`: 13 positives, 15 refusals, every refusal
paired.

**Deliberately not in this batch, and each said out loud:** NEFT advice
files, Form 16 and 24Q, arrears, gratuity, bonus, full-and-final
settlement, and an employee loan ledger. Every one is a real feature with
its own rules, and half a version of any of them produces numbers that
look right.

---

# v1.22.0-alpha — THE PANEL THAT COULD RECORD EVERYTHING AND STOP NOTHING

**Repo: `app.ordence`** · 🔴 **SQL: `0074` (run BEFORE the code push)** · ⚠️ **No new variables**

Admin panel, part two. Five gaps closed in one session. Billing cockpit
deferred at the owner's instruction, because it needs the LLP.

- 🔴🔴 **`platform_action_log` HAS BEEN COMPLETE SINCE THE CONSOLE WAS
  BUILT, AND NONE OF IT PREVENTS ANYTHING.** A log is written after the
  thing happened. On the afternoon somebody has two tabs open and the
  wrong workspace in the search box, it captures the mistake perfectly
  and forty-three people still cannot work. Un-suspending is one click;
  explaining twenty minutes of downtime to a customer is a relationship.
  **That asymmetry is the whole argument for this release.**

- ⭐⭐⭐ **THE APPROVAL QUEUE — SIX ACTIONS, NOT SIXTEEN.** Suspend,
  terminate, change what a paying customer can use, read without
  consent, raise an operator's grade, change a plan. Everything else
  still executes immediately, and that is the hard part: a queue that
  fires on routine work is a queue people learn to rubber-stamp, and a
  rubber-stamped approval is worse than none because it looks like a
  control in an audit. Provisioning, consented read-only impersonation
  and overrides on trial workspaces are deliberately absent.
- ⭐ **A WRAPPER, NOT A REWRITE.** `suspendTenant` is unchanged. The
  queue intercepts the validated arguments, stores them, and hands the
  identical arguments back to the identical function on approval. There
  is no second code path that could drift.
- ⭐⭐ **THE SINGLE-OPERATOR HATCH IS NAMED RATHER THAN HIDDEN.** Ordence
  has one operator. A queue that cannot be cleared is a queue that gets
  commented out at midnight, and then there is no control at all rather
  than a weak one. So self-approval is allowed and costs fifteen
  minutes, enforced by a database trigger rather than by the screen. It
  is flagged in the row and in the log, and it disappears the day a
  second operator exists.

- ⭐⭐⭐ **THE TOGGLE NOW SAYS WHAT IT DOES BEFORE IT DOES IT.** The
  switchboard has always worked and has never explained itself. Every
  fact on it described the STATE; none described the CONSEQUENCE, which
  is the thing an operator hesitates over on a call: does the customer's
  data go away? **It does not, and now the screen says so in those
  words.** An entitlement controls visibility, never existence.
- 🔴 **AND THE FIRST VERSION OF THAT PREVIEW LIED.** It received an
  empty record-count map, could not tell "not counted" from "zero", and
  told the operator "there is no data in these modules yet" about a
  workspace with eighteen hundred stock records — the exact sentence
  they would have repeated to the customer. Fixed, and the fix is that
  the preview now declines to give a number it does not have.
- 🔴 **A SECOND ONE IN THE SAME FILE.** It passed an empty plan-feature
  list, so `!planFeatures.includes(key)` was always true and it printed
  "their plan does not include this, so this is effectively a discount"
  on every enable, including ones the customer already pays for. It now
  reads the effective tier, which is not the same as the recorded plan
  for a trialing or lapsed workspace.
- ⭐ **WRITE, THEN FRESH READ, THEN RECORD BOTH.** A toggle that fails
  silently is worse than one that errors: it produces a ticket beginning
  "I enabled it, it should be working", and the operator's own screen
  agrees with the customer. Undo is a NEW history row, never a deletion.

- ⭐⭐ **TENANT HEALTH — AND A CORRECTION TO MY OWN STATUS DOCUMENT.**
  Doc 84 said Ordence had no health signal. That was wrong;
  `evaluateHealth` has scored workspaces since v0.14.0 and two screens
  call it. What was missing is PERSISTENCE and the three rules a
  snapshot structurally cannot see: a fortnight-over-fortnight collapse
  in engagement, an error rate against a workspace's OWN normal rather
  than a platform threshold, and an integration that has quietly stopped
  bringing anything in.
- 🔴 **THE SWEEP IS THE HALF THAT MAKES IT REAL.** The table, the rules
  and the screen were all written before anything CALLED the sweep —
  the eighth time this codebase has produced a complete engine nothing
  reaches. It now runs on read rather than on a schedule, because a
  screen that depends on a healthy scheduler is silently empty on
  exactly the morning the scheduler is what broke.
- ⚠️ **SEAT AND STORAGE PRESSURE ARE DELIBERATELY NOT RAISED.** They are
  sales signals that resolve themselves. Burying two rules that need a
  phone call under paperwork about workspaces doing well is how both get
  ignored.

- ⭐⭐⭐ **BREAK-GLASS HAS A PROCEDURE, NOT JUST A MODE.** It was already
  read-only, already fifteen minutes, already refused when consent
  exists, already emailed to the workspace owners. **Every one of those
  is paid once, by somebody who has already decided to reach for it, and
  none of them costs anything the next day.**
- 🔴 **SO THE CONTROL THAT CHANGES BEHAVIOUR IS A DEBT.** A break-glass
  session leaves the operator owing a written note within 24 hours, and
  until it is written THAT OPERATOR CANNOT BREAK GLASS AGAIN. It does
  not block consented support access, and it must not — making the debt
  block the path we want people on would push somebody towards the
  unconsented one on the day their queue is long.
- ⭐ **WITH THE ONE EXCEPTION THAT MAKES IT SAFE.** The debt becomes
  blocking only an hour after the session closed, so an operator who
  broke glass, found the problem was bigger than one workspace and needs
  a second one right now is not stopped to write paperwork mid-incident.
- ⭐ **AND A REASON WRITTEN FOR THE CUSTOMER, NOT THE LOG.** Fifty
  characters minimum, refused if it repeats the internal justification
  or is a bare ticket number, and printed verbatim in the email that
  tells the workspace owners their data was read without permission.
  Ordence's own owners are emailed too, within seconds — a control
  everyone has to remember to check is a control nobody checks.

- ⭐ **INCIDENT MODE.** At three in the morning nobody writes down what
  they did. An incident is a name for a bad hour so the post-mortem
  assembles itself from the log rather than from an argument a week
  later about the order of events.

- 🔴 **AND ONE MORE SELF-CORRECTION, CAUGHT BY A GATE.** `0074`
  originally argued at the bottom of the file that RLS on the two new
  tenant-carrying tables would be decoration, because they are only ever
  reached through `withPlatformScope`. Every clause of that was true and
  the conclusion was still wrong: **RLS that is not enabled is not a
  policy evaluating to false, it is no policy, and Postgres returns
  every row.** One tenant-side query joining `tenant_health_events` for
  a plausible reason and a customer reads our private assessment of
  their own churn risk. `npm run check:sql` refused the build.
- ⚠️ **THE DRILL CAUGHT A FLAW IN ITSELF, TOO.** The UPDATE meant to be
  refused by the resolution-note CHECK reported `UPDATE 0` and could
  have been written down as a pass. It was not: RLS had hidden every row
  from a session with no scope, so the statement never reached the
  constraint. **The paired positive is what gave it away**, which is the
  entire reason every refusal in this codebase is paired with one.

**Gates:** all eight green — `tsc`, `check:boundaries`, `check:migrations`,
`check:sql`, `check:posting`, `check:reachability`, `test:ui` (75 files, **2,704
passing**, 57 new), `next build`. RLS drill run as non-superuser `app_user`:
9 positives, 7 refusals, every refusal paired.

**Deferred, at the owner's instruction:** the billing cockpit. It needs
the LLP, `PLATFORM_GSTIN`, Razorpay and the GSP, and building the screen
before the entity exists would produce a cockpit with no instruments.

---

# v1.16.0-alpha — THE FEATURE THE OWNER ASKED FOR, AND THE HALF THAT IS WORTH MORE

**Repo: `app.ordence`** · 🔴 **SQL: `0068`** · ⚠️ **No new variables**

Front office, batch 10. Session 8 of Option B.

- ⭐⭐ **"The system should recognise purchase patterns of my customers
  and then notify me that this customer is likely to order today."** That
  is the top of the new screen, in the owner's own words.
- 🔴🔴 **AND THE HALF NOBODY ASKED FOR IS WORTH MORE: the customer who
  has STOPPED.** Somebody who ordered every month for two years and has
  not ordered for seven weeks has gone elsewhere, and nothing in an ERP
  reports an absence. Sales reports show what happened; they cannot show
  what did not. The nudge is worth a call. The silence is worth the
  account. It sits above the nudge on the screen.
- 🔴 **THE FAILURE MODE OF EVERY PREDICTION FEATURE IS CONFIDENCE.** It
  predicts for everybody, the salesman rings four people who were not
  due, gets four polite refusals, and stops opening the screen. After
  that it is worse than nothing, because it occupies the place where a
  real one would go. **So this refuses to predict more often than it
  predicts**, and the refusals are stored and shown.
- ⭐ **Four orders minimum.** Two orders is one gap and one gap is a
  coincidence; three orders is two gaps, and the middle of two numbers is
  their average again, which defeats the whole reason for a median.
- 🔴 **Median everywhere, and median absolute deviation for the spread.**
  One bulk order before a price rise drags a mean from 30 days to 92.
  Pairing a robust centre with a fragile spread is what makes a model
  look stable and behave erratically.
- ⚠️ **If the gaps swing by more than half the typical gap, it says so and
  predicts nothing.** Every 30 days give or take 5 is predictable; give or
  take 20 is a customer who orders when they run out.
- ⭐ **"Stopped" is three times their OWN gap, not ninety days.** A fixed
  calendar figure is far too patient for a weekly customer and far too
  twitchy for a quarterly one.
- ⭐⭐ **And a customer whose gaps are getting longer is flagged even
  though they are never late.** Somebody drifting from 30 days to 45 over
  a year is leaving slowly and never appears on an overdue report, because
  each order is on time against a rhythm that is itself decaying.
- 🔴 **Confidence is multiplied, not averaged**, so any one of history,
  tightness and freshness being poor sinks the answer. An average lets two
  good numbers hide a fatal one, and a score that reads 90% for everybody
  is a score nobody reads.
- ⚠️ **A signal is raised once per occurrence.** A nightly job that
  re-raises "this customer is due" for five nights produces five tasks and
  the feature is switched off on the third day. The lapse is keyed by
  month, the nudge by its expected date.
- 🔴 **A derived row cannot be edited by hand.** A prediction somebody can
  overrule is a prediction nobody can trust: six months later nothing says
  which rows were arithmetic and which were an optimistic salesman.
- ⭐⭐ **A prediction feature nobody scores is astrology.** Every signal
  records what happened next, cannot be edited afterwards, and cannot be
  scored twice. The screen says plainly when it has no track record yet,
  and says so again when its accuracy is worse than useful.
- 🔴🔴 **AND THE AUTOMATION ENGINE HAS EXISTED SINCE v0.7x WITH NO
  BUSINESS EVENT EVER REACHING IT.** `workflows` and its five tables have
  a full executor, conditions, watched-field loop prevention, a run log
  and a screen — and the only way to start one is a person pressing "run
  now". `record_created` and `record_updated` are in the trigger
  vocabulary and nothing has ever emitted one. `automation_events` is that
  queue, not a second engine.
- ⚠️ **Queued rather than called inline**, because a trigger that invoked
  a workflow directly would run somebody's HTTP step inside the
  transaction that created an invoice, and a slow endpoint would hold a
  lock on the ledger.
- 🔴 **A loop brake in the database.** Twenty events on one record in a
  minute is refused, naming the record. `watchFields` is the right first
  defence and it depends on the author scoping their trigger — and the
  author who did not is exactly the author who needs the brake.

All seven gates green. **2,501 tests** (50 new). **31 drills** against a
real PostgreSQL 16, with RLS re-run as a non-superuser.

---

# v1.15.0-alpha — THE AUDIENCE IS A LIST OF PEOPLE, NOT A SAVED FILTER

**Repo: `app.ordence`** · 🔴 **SQL: `0067`** · ⚠️ **No new variables**

Front office, batch 9. Session 7 of Option B, run alone because a
marketing send to the wrong list is the mistake this whole batch exists
to make impossible.

- 🔴🔴 **EVERY MARKETING TOOL STORES THE FILTER AND RE-RUNS IT AT SEND
  TIME.** So the list that goes out is not the list that was approved:
  somebody enquires in the twenty minutes between, matches the filter,
  and receives a campaign nobody decided to send them. The approval screen
  said 6,000 and 6,140 messages went. **Approval writes rows.**
  `campaign_recipients` is the audience, resolved once; the filter is kept
  as evidence of how it was built and never re-run.
- ⚠️ **And a trigger refuses an approval whose numbers do not match the
  audience that exists.** A product that resolves a list and then approves
  a different figure has moved the bug one table along.
- ⭐⭐ **Every exclusion is a row, with its reason.** A list of 9,000 that
  becomes 6,000 is a list where 3,000 people were dropped for reasons
  nobody saw. Some are correct (they withdrew consent), some are a data
  problem worth fixing (no mobile number), some are a decision somebody
  may disagree with (messaged last week). A silent exclusion is how a firm
  discovers it has been mailing 6,000 people instead of 9,000 for a year.
- 🔴 **The amount is typed, not ticked.** This is the only action in
  Ordence that spends thousands of rupees in one click and cannot be
  recalled. An amount somebody had to read and copy is an amount somebody
  read — forgiving about commas and rupee signs, exact about the number,
  because rejecting somebody on punctuation teaches them to copy and paste.
- ⚠️ **A stale audience cannot be approved.** A list built on Friday and
  approved on Monday has three days of withdrawn consents in it, and those
  are precisely the people who must not receive it.
- 🔴 **A campaign that would not fit under today's ceiling is refused
  before it starts.** One that stops at message 4,000 of 6,000 has told
  four thousand customers about an offer and left two thousand out, which
  is worse than never sending it.
- 🔴🔴 **WhatsApp error 131049 is never retried.** It is the per-user
  marketing limit — dynamic, personalised, unpublished — and repeated
  attempts within 24 hours can block delivery to that person for a further
  day. A loop that treats "failed" as "try again" turns one undelivered
  message into a customer nobody can reach until tomorrow. Same shape as
  the paused-template trap in v1.14.0.
- ⭐ **The default is not to retry at all.** A marketing message that
  failed once is not worth risking a second charge and a second complaint.
- 🔴 **The stop button is enforced per message, by the database.** A
  campaign to ten thousand people takes minutes and the moment somebody
  notices the wording is wrong is about ninety seconds in. A trigger on
  every send insert refuses anything from a stopped campaign, and also
  refuses anything from a campaign nobody approved.
- ⭐⭐ **Consent is the one thing re-read at send time.** The audience is
  frozen so nobody is ADDED; a withdrawal is somebody removing themselves,
  which must win however late it arrives. Under the DPDP Act "the list was
  already built" is not a defence.
- ⚠️ **A hold set by a person outranks any consent record.** A system that
  lets a later automated grant override it will message somebody who
  complained in writing.
- ⭐ **Verified, and worth knowing: WhatsApp sits outside TRAI's DLT
  registry**, which covers SMS and voice. What governs it is Meta's
  documented opt-in policy and the DPDP Act. Building DLT machinery for
  WhatsApp would be wasted work; assuming DLT compliance covers DPDP would
  be worse.

All seven gates green. **2,451 tests** (64 new). **34 drills** against a
real PostgreSQL 16, with RLS re-run as a non-superuser.

---

# v1.14.0-alpha — THE DUNNING LADDER HAS RECORDED WHATSAPP SERVICE SINCE 0027 AND NOTHING EVER SENT ONE

**Repo: `app.ordence`** · 🔴 **SQL: `0066`** · ⚠️ **No new variables**

Front office, batch 8. Session 6 of Option B, run alone because it is the
first thing in this system that spends real money per action.

- 🔴🔴 **`dunning_events.channel = 'whatsapp'` HAS BEEN A CLAIM, NOT A
  FACT.** That table has recorded WhatsApp service since 0027 — channel,
  recipient, date, amount outstanding, who authorised it — and its own
  comment calls it "the evidence that the buyer was given every chance".
  The row was written by a person ticking a box. **Nothing left the
  building.** A firm could hold a perfect, append-only, legally shaped
  record that a demand notice was served on a date when no message was
  sent at all. A gap in evidence is a gap; evidence of something that did
  not happen is a different problem, and the other side finds it.
- ⭐ So this batch does not build a messaging product. It builds the thing
  that makes that column true, and the same machinery then serves every
  other utility message the system already knew it wanted to send.
- 🔴🔴 **YOU ARE BILLED ON DELIVERY, NOT ON SEND.** Meta charges "only
  when a template message is delivered". A cost booked at send time is
  wrong in both directions: a send to a number that no longer has
  WhatsApp costs nothing, and a spend ceiling counting attempts stops a
  business sending messages it was never going to be charged for.
  `cost_minor` is NULL until the receipt arrives and a CHECK refuses a
  cost on anything undelivered.
- ⚠️ **Two facts v1.10.0 got wrong, corrected now that something actually
  sends.** Per-message billing replaced conversation billing on **1 July
  2025**, not 1 January 2026; and the charge lands on delivery, not on
  the click. Nothing depended on either until this session.
- ⭐⭐ **The 24 hour window is the difference between free and charged,
  and it is invisible.** A utility template inside an open customer
  service window is free; the identical template one minute later is
  charged. Nothing about the message changes, only the clock — which
  makes it the one optimisation that actually reduces a customer's bill,
  and no product tells them: send the reminder while the buyer is still
  in conversation.
- ⭐ **A free entry point window is 72 hours and everything inside it is
  free**, including marketing. It is opened by an ad click, so a business
  running those has a materially different cost profile.
- 🔴 **A paused template is not a failed one.** Meta pauses on complaints
  for three hours, then six, then **permanently disables**. A retry loop
  that treats a pause as transient walks into the third one, which cannot
  be undone. The second pause says so loudly.
- ⚠️ **Meta decides the category, not you.** A template written as
  `utility` that reads like an advertisement is moved to `marketing` and
  the identical send costs roughly seven times more. Nothing tells the
  business; the bill does, a month later. The requested category is kept
  so the drift is visible on screen.
- 🔴 **The idempotency key is ours, derived from what the message IS.**
  Meta returns a message id only in the response, which is no use for
  deciding whether to send. `demand:<id>:rung3` collides with itself,
  which is the point, and the database refuses the second one.
- ⚠️ **A timeout is not a failure.** We do not know whether it went, so
  the row is left pending rather than retried into a second copy of a
  payment reminder — and the screen shows that count rather than hiding
  it.
- 🔴 **The daily ceiling is enforced by a database trigger, counted on
  ATTEMPTS as well as spend.** Spend lags because it is billed on
  delivery; a runaway loop moves the attempt count immediately and the
  money figure minutes later, by which time it is gone. A refusal is
  recorded and does not count against the ceiling it is the record of.
- ⭐ **One gate, not five scattered checks**, and consent is first —
  because it is the only one where proceeding is a legal wrong rather
  than an expense.

All seven gates green. **2,387 tests** (72 new). **43 drills** against a
real PostgreSQL 16, with RLS re-run as a non-superuser.

---

# v1.13.0-alpha — THE FRAME NOW CARRIES SOMETHING

**Repo: `app.ordence`** · 🔴 **SQL: `0065`** · ⚠️ **No new variables** (the
two from v1.12.0 are still required)

Front office, batch 7. Session 5 of Option B: IndiaMART, JustDial and
Meta lead ads on the frame 0064 built.

- ⭐⭐ **A LEAD IN A LIST NOBODY OPENS IS A LEAD NOBODY RINGS.** That is
  the whole argument. Every business on the industry list already
  receives IndiaMART enquiries — as an email and a phone alert, answered
  when somebody happens to look. The value of importing them is not the
  row. It is that the row becomes a task with a time on it that shows as
  overdue when it is not done. 0060 built tasks, 0061 the timeline, 0064
  the frame; this is the sentence that joins them.
- 🔴🔴 **`if (!response.ok) markFailed()` IS THE BUG EVERYBODY WRITES.**
  IndiaMART answers **204 when nobody enquired**. So a quiet Sunday
  becomes an outage: consecutive failures climb, the backoff lengthens,
  the connection goes degraded, and the customer is told their
  integration is broken because business was slow. It is self-confirming
  — the quieter the account, the louder the false alarm. Their whole code
  map (204, 400, 401, 429, 500) is now encoded from their documentation.
- ⚠️ **And a 200 carrying `CODE: 401` is not a successful empty run.**
  Reading only the HTTP status makes a rejected key look like a quiet
  month, forever, with the connection reporting healthy.
- ⭐ **401 usually means "regenerated", not "wrong".** Somebody pressed
  the button in the seller panel and told nobody, so that is what the
  message says.
- 🔴🔴 **INDIAMART DEACTIVATES ITS PUSH AFTER 48 HOURS OF CONTINUOUS
  REJECTION**, and a person must switch it back on at their end. So a bug
  in our handler that returns 500 for two days does not delay leads — it
  **silently unsubscribes the customer**, and nothing reports it, because
  the requests simply stop, which looks exactly like a quiet week.
  Therefore: once the bytes are durably stored we answer 200, even for an
  enquiry we could not parse. A non-200 is reserved for the one case
  where a retry helps.
- 🔴 **A v1.12.0 assumption was wrong and is corrected.** A ternary
  assumed anything that was not JustDial signs with
  `x-hub-signature-256`. IndiaMART's push documents **no signature, no
  key and no header at all** — every push would have been recorded
  `absent` and refused. The verification method is now data in the policy
  table.
- ⭐⭐ **"The same EVENT arrived twice" and "the same PERSON enquired
  again" are different questions, and 0065 answers them differently.**
  IndiaMART pushes AND answers on the pull AND retries, so every enquiry
  reaches us more than once by design: a unique index on
  `(connection_id, external_id)` refuses it. A genuine second enquiry six
  months later is real business: it is shown as a possible duplicate and
  never refused, because refusing it teaches the salesman to type a fake
  number. Scoped to the **connection**, not the tenant — two IndiaMART
  panels have independent id sequences.
- ⚠️ **"IndiaMART Buyer" is not a name.** It is the placeholder the
  platform itself sends, and storing it produces a pipeline of identical
  rows and a mail merge that opens "Dear IndiaMART Buyer". `leads.name`
  is NOT NULL, so the fallback is the company, then the number they rang
  from — never a constant, so two nameless enquiries never look like one
  person.
- 🔴 **A Meta webhook is a notification, not a lead.** It carries
  `leadgen_id`, `form_id` and `ad_id` and **no answers**; those are
  fetched separately with `leads_retrieval`. The notice is never
  discarded, because it is the only trace that somebody enquired and the
  id is what finds them in Meta's own Leads Center.
- ⚠️ **Meta batches under load**, which is exactly when a campaign is
  working. Reading `entry[0].changes[0]` drops every enquiry after the
  first, silently, only when things are going well.
- ⭐ **A missed call gets a quarter of the follow-up time**, as a
  fraction of the one number the tenant chose rather than a second dial
  nobody understands. Somebody who rang and did not get through has tried
  hardest and is likeliest to be gone tomorrow.
- 🔴 **An enquiry is not consent to a marketing list.** That is the line
  every CRM crosses: enquiry becomes contact, contact becomes segment,
  and eighteen months later somebody who asked one question about pipe
  fittings gets a Diwali campaign. The narrow basis is recorded and
  nothing wider; the campaign session will find nothing here, which is
  correct.
- 🔴 **`lead_intake_failures` exists because the customer paid for that
  enquiry too.** Every path through the ingest ends in a row somebody can
  see, and each reason carries an instruction rather than a category.
- ⭐⭐ **And the screen reports a connection that is connected, whose
  every check succeeded, and which has brought nothing for a week.**
  Nothing else in the system reports that.

All seven gates green. **2,315 tests** (70 new). **41 drills** against a
real PostgreSQL 16, with RLS re-run as a non-superuser.

---

# v1.12.0-alpha — THE VAULT HAS EXISTED SINCE 0037 AND NOTHING HAD EVER WRITTEN TO IT

**Repo: `app.ordence`** · 🔴 **SQL: `0064`** · ⚠️ **TWO NEW RAILWAY
VARIABLES, and credentials cannot be saved without them**

Front office, batch 6. Session 4 of Option B, run alone because it is the
frame five later integrations all sit on.

- ⭐⭐ **ONE FRAME, BUILT ONCE, FOR FIVE INTEGRATIONS.** IndiaMART,
  JustDial, Meta, WhatsApp and email are five connections. Building the
  frame five times is five sessions and five different bugs, and the
  fifth is always the worst because by then nobody remembers how the
  first handled a retry.
- 🔴🔴 **AND THE SESSION FOUND A COMPLETE ENGINE NOBODY HAD EVER
  CALLED.** `vault_secrets` was built in v0.66.0-alpha with
  ciphertext-only storage, a key named rather than kept, an HMAC blind
  index, a masked display, a retention date set at write time, an erasure
  function that actually zeroes the value, and an append-only access log
  no application role may delete. It has `api_credential` in its own kind
  list. It is policied, granted, triggered and tested — **and not one
  line of application code touched it.** The encryption was specified to
  happen "in the Worker", and the Worker went away when Ordence moved to
  Railway. The table survived the move; the arm that fills it did not
  exist to move.
- ⚠️ **SO THE FIRST DRAFT OF 0064 CREATED A SECOND VAULT.** It is
  deleted. A private `connection_secrets` table beside the real one would
  have meant two erasure paths, two rotation stories, and an access log
  that does not cover the credentials most worth logging. Integration
  credentials go in `vault_secrets` under `owner_kind = 'connection'`.
- ⭐ **This is the first time Ordence holds somebody ELSE'S credential.**
  Everything stored until now was the tenant's own data. An IndiaMART key
  opens their seller account; a WhatsApp token sends messages in their
  name. The threat is no longer "somebody reads tenant A's rows", it is
  "somebody obtains a backup and can post as four hundred businesses" —
  and RLS does nothing about a stolen dump.
- 🔴 **Not one export in `server/actions/connections.ts` returns a
  credential.** Every export in a `"use server"` file is a
  browser-reachable RPC endpoint, and an action that returned a stored
  key would be an authenticated URL handing out every tenant's
  credentials while looking entirely ordinary in review.
- ⭐ **`api_credential` masking changed from four characters to none.**
  Nobody recognises an API key by its tail the way they recognise a card,
  so the four bought no recognition and cost a meaningful fraction of a
  short token. What a person actually needs — "is the key I just pasted
  the one that is loaded" — the blind index answers without showing any
  part of it.
- ⭐⭐ **`sync_runs` has three counts, not one.** "Fetched 40" answers
  nothing. Forty seen, forty repeats and nothing new is a healthy quiet
  day. Forty seen and forty NEW every single time is a cursor that is not
  moving, which looks like success and is a silent re-import. The health
  check catches it; nothing else would, because every individual run is
  green.
- 🔴 **The throttle is state on the connection, not a comment in a
  runner.** IndiaMART allows one call every five minutes, locks out for
  fifteen if five a minute is exceeded, answers a seven day window and
  keeps 365 days. A locked-out integration looks exactly like a broken
  one from the outside.
- 🔴 **A gap that cannot be refetched is reported, never narrowed
  quietly.** Four hundred days down against 365 days of retained history
  is thirty-five days nobody can recover. Silently clamping the window
  produces a successful-looking catch-up over a permanent hole.
- 🔴 **Not every failure is a retry.** A rejected key is never retried,
  because that is thousands of failed authentications a day against the
  customer's account and the far end eventually blocks the account rather
  than the request. Rate limits honour Retry-After exactly. Backoff is
  capped, because doubling without a ceiling reaches a nine-hour gap by
  the fourteenth failure — the far end came back after twenty minutes and
  the customer loses the day.
- ⭐⭐ **The customer is told on time, not on count.** "Alert after 5
  failures" is half an hour for a six-minute poll and five days for a
  daily one. The threshold is a duration since the last success.
- 🔴 **Four signature states, not a boolean.** `verified`, `invalid`,
  `absent`, `not_required`. Collapse the last two and an endpoint whose
  signing was accidentally switched off reads exactly like one whose
  signature is passing — every delivery shows a tick and the only real
  security control disappears without an error anywhere.
- ⚠️ **A replayed request is correctly signed**, which is what makes it a
  replay rather than a forgery, so the timestamp is checked even when the
  signature is perfect — and a timestamp in the FUTURE is rejected too.
- 🔴🔴 **A drill found a real bug.** The delivery guard froze the payload
  HASH and left the payload itself editable, so a stored body could be
  rewritten while the hash beside it went on attesting to the original.
  That is worse than no record: it is a record that looks verified and is
  not. Removal is still allowed, because a deletion request has to be
  answerable.
- 🔴 **`webhook_deliveries.purge_after` is `NOT NULL`.** A webhook body is
  somebody's name and phone number, and kept forever in a debugging table
  it is a DPDP problem hiding inside a developer tool.

All seven gates green. **2,245 tests** (80 new). **51 drills** against a
real PostgreSQL 16, with RLS re-run as a non-superuser.

---

# v1.11.0-alpha — THE EVENT THE TDS ENGINE HAS BEEN WAITING FOR SINCE 0025

**Repo: `app.ordence`** · 🔴 **SQL: `0063`** · ⚠️ **No new variables**

Front office, batch 5. Session 3 of Option B, run alone because it
touches the ledger.

- 🔴🔴 **THE UNPOSTED LIST SHRANK FOR THE FIRST TIME IN TWENTY SESSIONS.**
  **5 of 9** financial modules now reach the ledger, not 4. `tds` came
  off the list — not reworded, removed — because the payment posts.
- ⭐ **The TDS engine was never missing a feature. It was missing an
  EVENT.** Sections, thresholds, catch-up bases, lower deduction
  certificates, challans, quarterly returns and interest exposure have
  all existed since 0025. Tax is deducted when the money MOVES, and there
  were no payments. This migration creates the payment, and the action
  calls the existing engine rather than reimplementing a single line of
  its arithmetic.
- 🔴 **The liability is cleared in FULL, not net of the withholding.**
  `Dr Sundry Creditors 1,00,000 / Cr Bank 90,000 / Cr TDS payable
  10,000`. Debiting only the net is the common error and it leaves the
  withheld amount on the vendor's ledger as if still owed to them, on
  every bill, all year, until somebody clears it as a "reconciliation
  difference" — which is the firm writing off its own tax deposits.
- 🔴 **The payment arithmetic is done by the database.**
  `net = gross − tds + msme interest + rounding`, as a CHECK constraint.
  Every one of those has been got wrong in a real system: TDS added
  instead of deducted, interest netted off instead of added, and a "net"
  that was simply typed.
- 🔴 **A payment run over unmatched bills pays the wrong things faster**,
  which is why the three-way match ships in the same migration. The
  classic fraud is not a fake invoice: it is a real vendor billing for
  eleven when ten arrived, every month, for years.
- ⭐ **A tolerance is reported, never swallowed**, and the shipped
  default is **zero** — a tolerance nobody chose is a tolerance nobody
  owns.
- 🔴 **A bill cannot be paid twice.** The duplicate payment is the
  commonest loss in accounts payable and almost never involves anybody
  dishonest: the same invoice arrives by email and by post, gets two
  internal numbers, and is paid on two runs three weeks apart.
- 🔴 **The run is not sorted by age.** A bill to a **micro or small**
  enterprise unpaid at 31 March has its whole expense **added back to
  taxable income** — not delayed, added back — under s.43B(h) of the
  Income Tax Act 1961, renumbered **s.37(2)(g) of the Income Tax Act
  2025** from tax year 2026-27. Both citations are carried.
- ⚠️ **Fifteen days, not forty-five, unless there is a written
  agreement**, and no contract can exceed forty-five however it is
  drafted. The database refuses to record a ninety day clause at all.
- ⚠️ **Medium enterprises are not covered, and nor are traders.**
  Treating every registered MSME as in scope makes the report cry wolf
  until nobody reads it. A `material_supplier` is deliberately **not**
  assumed to be a manufacturer.
- ⭐ **s.16 MSMED interest gets its own ledger account**, debited as an
  expense: three times the RBI bank rate, compounded monthly, and never
  deductible under any section of the Income Tax Act. Burying it in
  general interest hides a cost that is treated differently from
  everything around it. **The bank rate is an argument, not a constant.**
- 🔴 **A payable had no due date at all**, so nothing could be aged.
  Added, and ageing runs from it and never from the bill date.
- 🔴🔴 **A bug the drill found, not the design: voiding a payment left
  every bill it had settled still showing as paid.** The allocation
  trigger excluded void payments but only fired on allocation changes,
  and voiding changes the payment. A cheque bounces, somebody voids it
  correctly, and the supplier silently stops being paid with no trace of
  why. `ordence_resync_on_void` fixes it and a test pins it.
- ⭐ **The migration gate caught a reused number.** 0062 is retired
  (`0062_security_batches.sql`, superseded), and the gate refused to let
  it be reused. The batch went out as **0063** with the gap declared.

**82 new tests** (2,165 total). **43 constraint and trigger drills** fired
against a real PostgreSQL 16 in both directions, plus RLS isolation
across all six new tables as a non-superuser.

# v1.10.0-alpha — A TICK BOX IS NOT CONSENT

**Repo: `app.ordence`** · 🔴 **SQL: `0061`** · ⚠️ **No new variables**

Front office, batch 3 and 4. Session 2 of Option B.

- ⭐ **NO SECOND LEAD TABLE WAS BUILT.** `leads` already existed and was
  already mostly generic; what was real-estate-shaped about it was the
  project link. 0061 **extends** it. Two answers to "who enquired" is
  worse than a gap, and somebody would reconcile them forever. The same
  decision as the price list in 0057.
- 🔴 **The same man, three times.** One person enquires as
  `+91 98765 43210`, `098765 43210` and `9876543210`, and a duplicate
  check on the stored text finds **none of them**. `phone_digits` is a
  **GENERATED ALWAYS** column taking the **last** ten digits, so it
  cannot drift from the column it comes from and cannot be forgotten by
  an import.
- ⚠️ **It is an index, not a unique constraint.** A genuine second
  enquiry six months later is a real lead. Refusing it teaches the
  salesman to type a fake number, which destroys the data the check
  depends on. The match is surfaced with its strength; a person decides.
- ⚠️ **A name alone is never more than "possible".** Ten thousand people
  are called Rajesh Kumar, and a product that merges on name quietly
  destroys real records. A merge is also refused outright where the lead
  has already turned into real business.
- 🔴🔴 **Consent, and the deadline is inside this plan.** The DPDP Rules
  2025 were notified **13 November 2025**; the penalty regime begins
  **May 2027**. Consent as a boolean is not consent, so there are two
  tables: the **notice** in the exact words shown, and the **consent**
  naming the notice it was given against.
- 🔴 **A grant that does not name its notice is ignored.** Not treated as
  weak evidence. Ignored, because it says somebody agreed and does not
  say what to, and that is exactly what an inspection asks for and does
  not find.
- 🔴 **A consent record cannot be deleted, at all.** Withdrawal is a
  state with a date on it, not an absence. The question after a
  complaint is always when the person said stop and whether anything
  went out afterwards, and a deleted row cannot answer it.
- 🔴 **One stop means stop.** A withdrawal defaults to every purpose and
  every channel. Somebody who unsubscribes from email and keeps getting
  WhatsApp will complain, and that is a complaint with a statutory shape.
- 🔴 **A notice is frozen the moment anybody agrees to it.** A notice
  whose wording can be changed afterwards is worth exactly as much as no
  notice at all. Publish a new version.
- ⭐ **A contractual basis covers a dispatch note, never a campaign.**
  Having a contract is the excuse every firm reaches for when it wants to
  send an offer, so it unlocks transactional and service only, and it
  still loses to a withdrawal.
- 🔴 **Exactly one won stage per pipeline board.** Two win columns
  produce two conversion rates and every report built on them disagrees
  with every other one. Positions must be contiguous from 1, or the
  board silently reorders itself the next time a stage is added.
- ⭐ **Internal messaging: the cheapest loyalty feature on the plan.**
  Ledgers do not create habit, conversations do. A discussion about an
  invoice lives **on the invoice**.
- 🔴 **You cannot post into a conversation you are not in.** Being able
  to see a thread and being part of it are two different things, and only
  one of them is a permission. The screen is not the boundary.
- ⭐ **A mention adds the person to the thread**, by trigger. A mention
  that notifies somebody who then cannot read the thread is worse than no
  mention.
- 🔴 **A message cannot be deleted and an edit says it was edited.** A
  conversation that can be quietly rewritten is worse than no record,
  because people rely on it.
- ⭐ **Muting never suppresses a message that named you.** Muting is
  "stop shouting about this", not "hide it from me even when it is
  addressed to me".
- ⭐ **WhatsApp send costs are computed before the send.** Marketing is
  about ₹1.09 a message in India and is never free, whatever the service
  window says; utility is roughly a seventh and free inside it. A
  campaign to 10,000 costs about **₹10,900**, spent the instant somebody
  clicks send. Rates are arguments, not constants.

**83 new tests** (2,083 total). **48 constraint and trigger drills** fired
against a real PostgreSQL 16 in both directions, plus RLS isolation
across all seven new tables as a non-superuser.

# v1.9.0-alpha — FIFTY-NINE MIGRATIONS AND NO TASK TABLE

**Repo: `app.ordence`** · 🔴 **SQL: `0060`** · ⚠️ **No new variables**

Front office, batch 1 and 2. The first session of the revised plan in
document 70.

- 🔴🔴 **Ordence could record what a business IS and not what anybody DID
  about it.** No task table anywhere in fifty-nine migrations. No
  follow-up, no assignment, no note against a customer, no "ring him
  Tuesday". That is why the spreadsheet survives: a system holding the
  ledger but not the follow-up leaves every human process outside it, and
  the data follows the process out.
- ⭐ **Three tables, and they are not the same thing.** `tasks` is what
  somebody has to do. `activities` is what actually happened.
  `calendar_events` is where somebody has to be. Merging them is the
  common mistake and it produces a to-do list full of history and a
  calendar full of wishes.
- 🔴 **A completed task must carry its evidence.**
  `tasks_done_is_evidenced` refuses "done" with no name and no time on
  it, and the action takes both from the session and the clock, never
  from the caller. A completion a caller can supply is a completion a
  caller can forge.
- 🔴 **The two numbers nobody reports.** Work disappears in two ways that
  never show as overdue: **assigned to nobody**, and **dated nowhere**.
  Both get their own counter, in red, ahead of the overdue count, because
  a dashboard counting only what is late reports a clean desk while both
  sit there.
- 🔴 **A repeat counts from the DUE date, not the completion date.** A
  monthly filing due on the 7th and completed on the 19th is still due on
  the 7th next month. Counting from completion lets a task that is always
  late drift out of its own cycle one slip at a time. And the next
  instance is created **by a trigger on completion**, not by a nightly
  job, so there is exactly one live copy and no backlog of forty
  identical rows the first time the job is left off.
- 🔴 **History that cannot be rewritten.**
  `ordence_guard_activity_immutable` refuses to edit or delete anything
  the system or an integration wrote. A manual note can be corrected,
  because people mistype at seven in the evening, but it cannot be moved
  to a different record or to a different day. That turns a correction
  into a fabrication.
- ⭐ **The calendar is a MERGE, not a table.** Six sources already knew
  their own dates and each kept its own screen: hearings, statutory
  filings, licence renewals, payment milestones, tasks and diary entries.
  A person does not have six days. Nothing on the calendar is stored;
  every source is still closed where it belongs.
- 🔴 **The past stays on the agenda.** A calendar starting at today hides
  the hearing nobody attended last Thursday and the filing due on the
  20th. Those are the entries the screen exists for. Missed items that
  **cannot be done late** get their own counter, separate from merely
  overdue.
- ⚠️ **A licence appears on its RENEWAL date, not its expiry date.** One
  expiring 30 June with a 60 day lead time is on the list from 1 May.
  Showing it on the 30th is showing it on the day it is already too late,
  which is how a compliance calendar manages to be technically correct
  and completely useless.
- ⭐ **Sorted by date first, priority second.** A normal task three weeks
  late beats an urgent one due next month. Sorting by priority first
  teaches users that priority is a lever, and within a month everything
  is urgent.
- ⚠️ **The business day is Asia/Kolkata, not the server's.** A meeting at
  eleven at night on the 3rd is on the 3rd for the person attending it.

**78 new tests** (2,000 total). **41 constraint and trigger drills** fired
against a real PostgreSQL 16 in both directions, plus RLS isolation
across all four new tables as a non-superuser.

# v1.8.0-alpha — WHO PAYS THE GST ON A LAWYER'S BILL

**Repo: `app.ordence`** · 🔴 **SQL: `0059`** · ⚠️ **No new variables**

Legal, batch 2. This one corrects a defect Ordence has been shipping
since v1.2.0.

- 🔴🔴 **`raiseInvoiceFromTime` charged 18% forward on every invoice,
  unconditionally.** For an advocate or a firm of advocates that is wrong
  nearly every time. Legal services are **exempt** (Notification
  12/2017-CT(R) Sr. No. 45) or on **reverse charge** (Notification
  13/2017-CT(R) Sr. No. 2, the client pays and the invoice carries no
  tax). Forward charge is the exception.
- ⚠️ **And the error is not symmetrical.** Tax charged that was not
  chargeable is money collected as tax — **s.76** requires it to be paid
  to the Government whether or not it was due, and the client cannot
  claim credit for it either. The firm cannot keep it and the client
  cannot use it. The fix forces the rate to zero on anything but forward
  charge: a caller cannot ask for reverse charge and 18% in one breath,
  because that combination *is* the bug.
- 🔴 **The ₹500 that costs ₹9,090.** Rule 33 takes a pure agent's
  recovery out of the value of supply — but Explanation (d) allows only
  "the actual amount incurred". Round a ₹50,000 court fee up to ₹50,500
  and the exclusion is lost on the **whole ₹50,500**, not on the ₹500.
  `matter_disbursements_pure_agent_is_at_actual` refuses the row. Not a
  warning — a warning on this gets clicked through at 7pm.
- 🔴 **Travel and courier cannot be pure agent recoveries.** The client
  was never liable to the airline. That is the whole test, and it is the
  second most common Rule 33 error after the markup.
- 🔴 **The threshold that decides the exemption is the CLIENT's.** A
  Mumbai firm billing a small business in Manipur applies ₹10 lakh, not
  ₹20 lakh — the same turnover is exempt in one State and on reverse
  charge in the other. Where published sources disagree about a State,
  Ordence uses ₹20 lakh (the answer that never leaves tax uncollected)
  and **says the figure must be confirmed by hand**.
- ⭐ **One question is left open on purpose.** A senior advocate billing
  another advocate or firm is genuinely unsettled. Ordence returns it
  flagged as ARGUABLE with the reasoning, in red — and the firm can
  record its own position, which the database will not store without a
  written reason.
- 🔴 **Kankariya, 20 December 2024.** A Lok Adalat award carries a full
  refund under s.21 of the Legal Services Authorities Act. A mediated
  settlement does **not** get that by extension — the Supreme Court held
  the two cannot be equated — and gets whatever the State's own Court
  Fees Act gives it. So the settlement **route** is recorded, and the
  entitlement is returned as an opinion with its citation rather than a
  promise.
- ⭐ **NO COURT FEE RATES SHIP, AND A TEST ENFORCES THAT.** Court fees
  are a State subject, amended on State budget cycles. A stale slab is
  worse than an empty table: a plaint returned for deficit court fee
  loses its filing date, and that can lose the limitation. The firm types
  its own schedule once; Ordence does the arithmetic and shows the
  working.
- ⚠️ **What this does not do:** cause-list scraping, e-filing, bank
  reconciliation, or a State's actual fee schedule.

**90 new tests** (1,922 total). **36 constraint and trigger drills** fired
against a real PostgreSQL 16 in both directions, plus RLS isolation
across all six new tables as a non-superuser.

# v1.7.0-alpha — THE DATE THAT ENDS A CLAIM

**Repo: `app.ordence`** · 🔴 **SQL: `0058`** · ⚠️ **No new variables**

Legal, batch 1. The first industry batch that is about a deadline rather
than a document.

- 🔴 **"Matters" and "Cases" both pointed at `/assets?type=…`, and
  "Hearings" pointed at `/calendar`.** Three nav labels, no code behind
  any of them. A law firm opening Ordence found a fixed-asset register
  with the word "Matters" over it. That is not a thin feature, it is a
  label doing all the work — so `cases` and `hearings` are now **removed
  from the registry**, not repointed, and `matters` goes to a real screen.
- 🔴 **Limitation is computed, with its workings, and stored.**
  `lib/legal/limitation.ts` encodes twelve Articles of the Schedule plus
  s.34(3) of the Arbitration Act, applies **s.12(1)** (the day the period
  runs from is excluded), and applies **s.4** (where the period expires on
  a day the court is closed, it rolls to the reopening day — most software
  skips this and is quietly wrong in the client's disfavour).
  The screen shows the reasoning, not just the date: which Article, what it
  runs from, why that day was excluded, where it lands.
- 🔴 **The database refuses to revive a dead right.**
  s.18 starts a fresh period only where the acknowledgement was made
  *before* the period ran out. The same letter two days later gives
  nothing, and on a file the two look identical. `ordence_guard_limitation_reset`
  rejects the second one and says why. It also refuses a "reset" on a legal
  notice — only an acknowledgement (s.18) or a part payment (s.19) does it.
- 🔴 **A hearing that was held must produce the next date or a disposal.**
  `legal_hearings_held_has_a_future`. Neither means nobody is listed to
  attend, and that is how a suit is dismissed for default of appearance —
  not by a decision, by a blank field. `not_reached` is deliberately
  included; it is the most commonly forgotten one because nothing happened.
- 🔴 **A client ledger cannot go into debit — per client AND per matter.**
  `ordence_guard_client_account`. Money paid out that was not held for that
  client is another client's money, and there is no innocent version of that
  number. Funds on one matter are not available to another without a
  deliberate transfer. Fees leave the client account only against an issued
  bill (`client_account_entries_office_transfer_has_bill`). Bar Council of
  India Rules, Chapter II, Section II.
- ⭐ **Cheque dishonour deadlines under s.138 NI Act** — 30 days to send
  the demand, 15 days for the drawer to pay, cause of action the next day,
  one month to complain. Four dates from one dishonour memo, and the
  15-day window is the one people miscount.
- ⚠️ **"No limitation date" gets its own counter, in red, first.**
  A matter expiring next week is at least on a list. A matter with no
  expiry never appears on any report, whatever the date.
- ⚠️ **What this does not do:** court fees (State schedules — next batch),
  cause-list scraping, e-filing, and it does not reconcile the client bank
  account. The held figure is what the ledger says; agreeing it to the bank
  is still a person's job, and it is the job an inspection asks about.

**61 new tests** (1,832 total). **26 constraint and trigger drills** fired
against a real PostgreSQL 16 in both directions, including RLS isolation
as a non-superuser.

# v1.6.0-alpha — PRICES THAT ACTUALLY SELL, AND SECTION 15(3)

**Repo: `app.ordence`** · 🔴 **SQL: `0057`** · ⚠️ **No new variables**

Trading, batch 2. This finishes the industry.

- 🔴 **I did not build a price list table, and that is the point.**
  `rate_cards` and `rate_slabs` have existed since 0034 with customer,
  item, priority, half-open validity and `slab_mode`. A second table would
  have given two answers to "what does this cost this customer today".
- 🔴 **What was missing is that NOTHING SELECTED ONE.**
  `sales_order_lines.unit_price_minor` is typed in by hand, so a
  distributor with negotiated prices retyped them on every line and the
  price list was decoration. The fix is a resolver, not a schema.
- 🔴 **Specificity beats priority beats recency.** A card naming the
  customer always wins over a house list, however recently the list was
  published — and a card belonging to another customer never applies.
- ⚠️ **`validTo` is exclusive**, and the tie-break ends on the card code so
  a quote cannot change between being given and being honoured.
- 🔴 **Slab bands cannot overlap or leave a gap** — validated by a deferred
  trigger. A gap is the quiet one: flat pricing falls through to the last
  band, so a quantity matching nothing is charged at the TOP rate.
- ⚠️ **Progressive versus flat is 27% of the bill** on a common example.
  The mode is stated on the card and honoured, never guessed.
- 🔴 **A quote is checked against LANDED cost, not the invoice price.**
  On 4–8% trading margins an 8% freight uplift is the whole margin.
- 🔴 **Section 15(3)(b): a year-end rebate agreed in December cannot take
  back the GST on April's sales.** The agreement has to have existed at or
  before the supply. The credit note is legal; the tax is gone.
- ⚠️ Tested against the **earliest** supply in the period, not the latest —
  testing the latest would pass a whole year's rebate.
- 🔴 **The rebate is apportioned across the invoices that earned it**, in
  the same transaction. Software that stores it as one figure cannot
  produce the s.15(3)(b)(i) linkage afterwards. Tax is computed at each
  invoice's own rate, never an average.
- ⭐ **Circular 212/6/2024 was withdrawn by Circular 253/10/2025-GST on
  1 October 2025** — no certificate needed. ⚠️ But s.15(3)(b)(ii) itself
  was not amended: the recipient still has to have reversed the credit.
- ⭐ Validated against a real PostgreSQL 16: 7 drills, the slab trigger and
  every constraint refused what they exist to refuse.

# v1.5.0-alpha — STOCK TRANSFERS AND LANDED COST

**Repo: `app.ordence`** · 🔴 **SQL: `0056`** · ⚠️ **No new variables**

Trading, batch 1. Two things a distributor does every day and Ordence could
not do at all.

- 🔴 **A transfer was two independent movements and nothing joined them.**
  Post both at dispatch and the stock exists at the destination before the
  lorry does; post only the OUT and it vanishes off the balance sheet for
  three days. Both look fine.
- ⭐ **The `transit` warehouse type has been in the enum since 0029 and
  nothing ever used it.** It is now where goods live between dispatch and
  receipt — ours, on the balance sheet, in neither godown.
- 🔴 **Nothing can be sold out of a transit location** — enforced by trigger.
  Without that the model collapses back to stock sold from a lorry.
- 🔴 **An inter-GSTIN transfer is a TAXABLE SUPPLY.** s.25(4) makes each
  registration a distinct person; Schedule I para 2 makes a supply between
  them taxable without consideration. Tax invoice, not delivery challan.
- ⚠️ **And it is decided by the GSTINs, not the states** — the intuitive
  mistake, wrong in both directions. Two godowns in different states under
  one GSTIN are not a supply; two in one state under two GSTINs are.
- ⭐ **Rule 28's second proviso** — where the recipient has full ITC, the
  invoice value IS the open market value. Where it does not, the screen says
  an open market value has to be established rather than inventing one.
- 🔴 **100 bags leave and 98 arrive: the two missing bags do not vanish.**
  They are still in transit, on a balance somebody must explain. The
  shortfall is written off with a named approver, and the ITC on it reversed
  under s.17(5)(h) — "lost" is in the section by name.
- 🔴 **Landed cost did not exist.** Ind AS 2: cost of purchase includes
  duties and taxes *"other than those subsequently recoverable"*. Basic
  customs duty is a cost; **IGST on imports is a credit** — adjacent boxes on
  one bill of entry, and capitalising the IGST inflates stock AND loses the
  credit.
- ⚠️ **Freight apportions by weight, not value.** A container of feathers and
  lead split by value gives the lead almost no freight.
- 🔴 **Largest-remainder apportionment** — ₹10,000 over three lines sums to
  exactly ₹10,000, deterministically.
- 🔴 **The freight bill arrives after the goods.** The charge splits between
  stock and cost of sales by what is still on hand. Putting all of it on the
  remainder overstates closing stock AND the margin already reported — two
  errors in opposite directions with a correct total.
- ⭐ Validated against a real PostgreSQL 16: 12 drills, every constraint and
  the transit guard refused what they exist to refuse.

# v1.4.0-alpha — BATCH, EXPIRY, SERIAL AND GOODS COMING BACK

**Repo: `app.ordence`** · 🔴 **SQL: `0055`** · ⚠️ **No new variables**

Engine 8b. `batch_no`, `serial_no` and `expiry_date` have existed since 0029
as three free-text strings on a ledger row. This adds the masters they
should always have pointed at.

- 🔴 **The same batch could carry two different expiry dates**, typed by two
  people a week apart, with nothing to refuse it. A unique key on
  (item, batch) plus a trigger that names both dates is the fix.
- ⭐ **The trigger makes the existing code correct without rewriting it.**
  Every call site that inserts a movement with a `batch_no` now silently
  acquires a real batch row — so nothing had to be found and changed, which
  means nothing could be missed being found and changed.
- 🔴 **FEFO, not FIFO.** A batch received in January expiring in December
  must ship AFTER one received in March expiring in June. And a batch with
  no expiry sorts **last**, not first.
- 🔴 **Stock is saleable ON its expiry date**, not up to the day before.
- 🔴 **`tracking_mode = 'serial'` was a label with nothing behind it** — an
  item could be declared serial-tracked and receive fifty units with no
  serials. Now refused, and a dispatched serial cannot be dispatched again.
- ⚠️ **Warranty runs from dispatch, not receipt** — and 31 January plus one
  month is 28 February, not 3 March.
- 🔴 **Damaged returns cannot go back into a selling warehouse.** Enforced
  by trigger, because that stock would be picked for the next customer.
- 🔴 **Section 17(5)(h)** — a write-off is two entries, not one. The stock
  leaves AND the input tax credit is reversed. A zero reversal must be
  explained in a sentence, enforced by CHECK.
- ⭐ **Section 34(2)** — the credit-note tax deadline (30 November following
  the FY of the *original supply*) is counted down on screen. After it, the
  note is still legal and the GST is gone.
- ⚠️ **No `days_to_expiry` column and no nightly sweep.** Both need a job,
  and the night it does not run the screen says stock is fine on the day it
  stopped being fine.
- ⭐ Validated against a real PostgreSQL 16: 13 drills, every trigger and
  constraint refused what it exists to refuse.

# v1.3.0-alpha — E-WAY BILL · THE TRUCK THAT IS STANDING STILL

**Repo: `app.ordence`** · 🔴 **SQL: `0054`** · ⚠️ **No new variables**

Engine 8a. Unlocks Trading, Small Business, Solar equipment and Logistics —
none of them can move a consignment over ₹50,000 without this.

- 🔴 **Ordence PREPARES an e-way bill; it does not generate one.** No GSP
  credentials, so `prepared` is never rendered as coverage and the NIC
  EWB-01 JSON is exported for a human to upload. Pretending to submit
  would produce a screen that looks like it raised one and did not.
- 🔴 **The off-by-one-day.** Explanation 1 to Rule 138(10): each day
  expires at midnight of the day **immediately following** generation. A
  one-day bill raised at 00:04 on the 14th runs to the end of the **15th**.
  The naive `+ days × 24h` is short by up to a day, in the direction that
  expires a bill while a lorry is still moving.
- 🔴 **And it is the IST midnight.** Computing it in UTC moves every expiry
  5½ hours early — to 18:30 the previous evening.
- 🔴 **Explanation 2 has two halves that pull opposite ways.** Consignment
  value **includes** the tax and **excludes** exempt supply *only on a
  mixed document*. A wholly-exempt invoice keeps its whole value.
- ⚠️ **No State can raise the inter-state threshold**, and the override
  refuses to apply there.
- ⚠️ **200 km/day, and 20 km/day for over-dimensional cargo.**
- ⚠️ **The windows:** cancel within 24 h (never after verification in
  transit), extend only 8 h either side of expiry, 180-day document age,
  360-day lifetime ceiling from *original* generation.
- 🔴 **Every leg is kept.** Transshipment inserts; it never overwrites —
  and it buys no extra validity.
- ⚠️ **No `is_expired` column.** Expiry is computed from the timestamp on
  every render.
- ⭐ Validated against a real PostgreSQL 16: every CHECK and unique index
  refused the row it exists to refuse.

# v1.2.0-alpha — HOURS BECOME A TAX INVOICE

**Repo: `app.ordence`** · ⚠️ **No new SQL — `0053` from v1.1.0 is still required** · No new variables

v1.1.0 shipped the whole time engine with **nothing able to call it**. This
is the screen, and the last step it was missing.

- ⭐ **`/time`** — record time, rate card, approve, write off, and bill.
  The engine was tested and unreachable; a firm would have kept its hours
  in a spreadsheet, which is what the module exists to prevent.
- 🔴 **`raiseInvoiceFromTime`** — the invoice and the marking-as-billed
  happen in **ONE transaction**. An invoice raised without the entries
  being marked bills the same hours again next month.
- 🔴 **A count mismatch rolls the whole thing back** — two people billing
  the same time in the same second get a retry, not a double bill.
- ⚠️ **The value comes from the entry, never from re-pricing.** Each hour
  carries the rate that applied the day it was worked; re-resolving here
  would re-price a year of unbilled work at today's card.
- ⚠️ **Five refusals, each naming its count** — wrong client, already
  billed, not approved, non-billable, unrated.
- ⚠️ **Quantity is 1.000 and the unit price IS the line value**, so the
  invoice cannot disagree with the timesheet by paise. Hours are stated in
  the description, where a client reads them.
- 🔴 **`supplyType: "services"`** — Rule 48(1) prints two copies, not
  three. SAC 9982 by default, never an HSN.
- ⭐ **The entry form previews the rounding before it is applied**, out of
  the same functions the server uses. Seven minutes bills as twelve, and
  the first person to learn that must not be the client.
- ⚠️ **Selection is per client**, because an invoice is per client.
  Internal time is shown and cannot be billed.

# v1.1.0-alpha — TIME & BILLING, THE SHARED ENGINE

**Repo: `app.ordence`** · 🔴 **SQL: `0053`** · No new variables

The engine Legal and Professional Services both run on, and neither could
use — Ordence could invoice an hour, tax it, collect it and post it to the
ledger, and had nowhere to RECORD it.

- **`billing_rates`** — effective-dated, never overwritten. March work bills
  at March's rate even when invoiced in September.
- **`time_entries`** — duration in whole MINUTES as an integer. Never hours
  as a decimal.
- 🔴 **Six-minute units, rounded UP** — the legal standard, stated rather
  than assumed.
- 🔴 **Value = rate × minutes / 60, in that order, rounded half up.**
  Dividing first loses paise on every entry.
- ⭐ **No retainer table** — a retainer IS an unapplied customer receipt,
  already built in v0.98.0.
- Approved and pending time are never summed.

# v1.0.0-rc.4 — POSSESSION: THE DATE THAT MAKES REVENUE REAL

**Repo: `app.ordence`** · 🔴 **SQL: `0052` before pushing** · No new variables

- ⭐ **`/sales/possession`** — the screen `postPossession()` needed and did
  not have. Without it a developer collects a whole project and reports
  **zero turnover forever**.
- ⚠️ **The advance is DERIVED from served demands, never typed** — and it
  is the PRINCIPAL, never the total, because the GST went to output tax.
- ⚠️ **Possession is a DATE, not a status.** No `ALTER TYPE`, no second
  source of truth.
- 🔴 **A cancelled booking cannot be handed over** — refused in the action
  and by a CHECK constraint.
- The form shows the **Indian financial year** the revenue lands in, and
  warns about uncollected money without blocking.

# v1.0.0-rc.3 — REAL ESTATE REACHES THE LEDGER

**Repo: `app.ordence`** · ⚠️ **No SQL** · No new variables

- 🔴 **Money collected before possession is a LIABILITY, not revenue.**
  Ind AS 115. Three stages: demand → advance + GST, receipt → cash,
  possession → the only revenue leg there is.
- ⚠️ **The GST liability arises at the DEMAND, not at possession** —
  time of supply for construction services is the earlier of invoice or
  payment.
- ⭐ **The counterparty is the BOOKING.** Settles the question left open
  in Session 2 without inventing a company per home buyer.
- Section 194-IA TDS is treated as money received.
- `receivables` off the debt list; gate now **4 of 9**.

# v1.0.0-rc.2 — RA BILLS REACH THE LEDGER

**Repo: `app.ordence`** · ⚠️ **No SQL** · No new variables

- **RA bills post on CERTIFICATION.** Dr Work in Progress (gross),
  Cr Retention payable, Cr TDS payable, Cr Labour cess payable,
  Cr Recoveries, Cr Sundry Creditors (net).
- 🔴 **A NEGATIVE net payable flips the contractor leg to a DEBIT.** Lean
  months where recovered advances exceed work certified are normal — the
  schema says so — and a naive posting breaks on them.
- ⚠️ **Retention is a liability, not a reduction of cost.**
- ⚠️ **`tds_payable` (we deduct) is distinguished from `tds_receivable`
  (customers deduct from us)** in the role help text.
- **Gate debt list CORRECTED, not just extended:** `variations` removed
  (approving one moves no money), `labour` excuse rewritten to the real
  blocker (no payroll run exists at all). Now **3 of 9**.

# v1.0.0-rc.1 — THE PURCHASE SIDE, AND THE SEVENTH GATE

**Repo: `app.ordence`** · ⚠️ **No SQL** (`0051` from v016 covers it) · No new variables

- **Purchases post to the ledger.** Dr Expense + Dr Input CGST/SGST/IGST,
  Cr Sundry Creditors. 🔴 **Blocked ITC (Section 17(5)) is added to the
  expense, not held as an asset.**
- **Reverse charge is a SECOND transaction** — Dr Input tax (RCM),
  Cr RCM payable. The vendor is not a party to it and `rcm_tax_minor` is
  not part of the bill total.
- **The eligible/blocked split is taken line by line, never apportioned.**
- ⭐ **`check:posting` — the seventh gate.** Fails when an action module
  that writes financial documents has no path to `journal_entries`.
  Reports **2 of 10** and names the other eight with a reason and a session.
- Purchase roles share `sales_posting_accounts`; the setup screen splits
  sales and purchase.

# v0.99.0-alpha — THE BOOKS ARE TOLD

**Repo: `app.ordence`** · 🔴 **SQL: run `0051` BEFORE pushing** · No new variables

🔴 **Sales invoices never posted to the double-entry ledger.** Every invoice
raised across Phases 49–57 was absent from the P&L, the balance sheet, the
trial balance, the GST output liability and the Tally export — which reads the
ledger and only the ledger.

- **`lib/accounting/sales-posting.ts`** — pure leg builders. Invoice, credit
  note (a mirror, not a negative), receipt (TDS is an asset).
- **`server/accounting/post-sales.ts`** — resolves roles → the tenant's ledgers,
  refuses the whole posting when any role is unmapped, shares the caller's
  transaction.
- **`0051`** — `sales_posting_accounts` + a partial unique index on
  `transaction_number LIKE 'SALES:%'` so posting is idempotent at the database.
- **`/accounting/posting`** — map the roles, see the backlog, post it.
- Wired into `issueInvoice`, `issueCreditNote`, `recordCustomerReceipt`.
  ⚠️ Posting never blocks issuing.

# v0.98.0-alpha — THE LAST FOUR INVISIBLE ENGINES

**Repo: `app.ordence`** · **No SQL** · **No new Railway variables**

- **`/credit-notes/[id]/print`** — the credit note as a document, with the
  original invoice number and date in the header (Rule 53).
- **`/companies/[id]/statement`** — statement of account. Overdue, not-yet-due
  and unapplied credit shown as three figures, never netted.
- **`/gst/gstr1`** — the return, every table, warnings above the figures.
  Built, not filed, and it says so.
- **`/receipts` and `/receipts/[id]`** — unapplied cash, and applying one
  receipt across several invoices. Oldest-first is a button, never a default.
- 🔴 **`allocate-receipt.tsx` was a second money parser.** Now delegates to
  `parseMoney`.

# v0.97.0-alpha — THE PRINTED INVOICE

**Repo: `app.ordence`** · **No SQL** · **No new Railway variables**

- **`/invoices/[id]/print`** — the document itself. A4, one sheet per
  Rule 48(1) copy (three for goods, two for services), selectable text.
- **`lib/invoicing/amount-in-words.ts`** — Indian grouping. One Lakh, not
  One Hundred Thousand. `bigint`, exact past `MAX_SAFE_INTEGER`.
- **HSN/SAC summary** built server-side, grouped by code **and** unit.
- **Rule 46(o) and 46(q) rows print blank rather than being omitted.**
- Supplier read from the **registration frozen on the invoice**, not from
  today's settings.
- **No server-side PDF engine.** The browser is the renderer; see the note
  at the top of `lib/invoicing/print.ts`.

# v0.96.0-alpha — CREDIT NOTES, ON A SCREEN

**Repo: `app.ordence`** · **No SQL** · **No new Railway variables**

- **Credit-note UI.** `raiseCreditNote` and `issueCreditNote` have worked
  since Phase 52 with nothing rendering them. A sales return could not be
  processed by a human being. Three screens close that:
  `/invoices/[id]/credit`, `/credit-notes`, `/credit-notes/[id]`.
- **🔴 The line ceiling.** `sales_credit_note_within_invoice()` compares
  DOCUMENT TOTALS, so crediting 100 units of a 10-unit line at ₹0.01 each
  passed it. `assessCreditLines()` closes that, checked at raise AND at
  issue.
- **🔴 The credit-note series counted drafts.** Five open drafts made the
  first issued note `CN/00006`. Rule 46(b) via Rule 53 requires the series
  to be consecutive. Now counts issued notes only.
- **`discardCreditNoteDraft`** — marks a draft cancelled, never deletes.
- **Stale registry comments removed** — five `404s today` notes on routes
  that have existed for versions.
- **`disableLogger` → `webpack.treeshake.removeDebugLogging`** — the
  Sentry SDK deprecated it and said so on every build.

# Changelog

## v0.88.0-alpha — a published endpoint that took the tenant as a parameter

🔴 **Security.** `createNotification` was exported from
`server/actions/notifications.ts`, a `"use server"` file. That file's own header
states the rule it was obeying:

> ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A "use server" file that exports
> anything else publishes it as an RPC endpoint reachable by anyone.

Every export *was* an async function. That is what made this one dangerous.
`createNotification` took `tenantId` **from its caller** and passed it to
`withTenant()`. It never called `requireTenantContext()`.

So it was a browser-reachable endpoint that accepted the tenant to write into as
a parameter. Any authenticated session could invoke it with another workspace's
uuid and:

- insert a row into that workspace's notification feed,
- with an attacker-chosen `title`, `body` and `actionUrl`,
- and at severity `critical` or `warning`, send an **Ordence-branded email to
  every active user of that workspace**, containing a link the attacker chose.

Row-level security could not catch it. RLS enforces the tenant the transaction
declares, and this function let the caller declare it. That is the one route
past it, and it was reachable from a browser.

**The fix is the boundary, not a check inside the function.** Adding
`requireTenantContext()` would have broken the two real callers —
`server/ai/background-workers.ts` and `server/mcp/dispatch.ts` — which have no
user session and legitimately act for a tenant they were handed. The function
moved to `server/notifications/create.ts`, an internal `server-only` module that
is not callable from a browser at all. `check:boundaries` enforces the
declaration.

- **new** `server/notifications/create.ts` — the function, unchanged, with the
  reasoning recorded above it
- `server/actions/notifications.ts` — export removed; a comment block explains
  why, and what shape a future UI-facing wrapper must take (derive the tenant
  from `requireTenantContext()`, never from the client)
- `server/ai/background-workers.ts`, `server/mcp/dispatch.ts` — imports repointed
- unused imports cleaned from the action file

No behaviour change for either legitimate caller. No schema change, no migration,
no new dependency.

**Not changed, deliberately:** `server/actions/assets.ts` and
`server/actions/grid.ts` write without a permission gate, but both derive the
tenant from `requireTenantContext()` and carry tenant predicates on every query —
`grid.ts` says so in a comment: *"Fetching by id alone would be the IDOR."* They
are tenant-safe. What they lack is a per-role permission, and there is no
`assets:*` permission key in the catalogue to use. Adding one is a product
decision plus a role-seeding migration; gating them blind would lock every
existing user out of assets.

## v0.87.0-alpha — a deploy you can prove landed

No behaviour changes. This release exists so that one glance at the landing page
answers "did the tree I pushed actually ship?"

For roughly eighty releases the landing page printed a hardcoded `v0.1.0-alpha`.
v0.85.0-alpha replaced it with `lib/version.ts`, which reads `package.json` at
build time. On 11 August 2026 the live site was still printing `v0.1.0-alpha`
**after** a deployment reported SUCCESS — which means the tree that was pushed
was not the tree that had the fix. The deploy was green and the artefact was
wrong, and nothing in the pipeline said so.

So this version number is deliberately one the live site has never shown. After
deploying, https://app.ordence.com must read `v0.87.0-alpha`. If it reads
anything else, the push came from the wrong folder — regardless of what Railway
says.

- `package.json` — version 0.86.0-alpha → 0.87.0-alpha
- `lib/version.ts` — stale version comment removed; it named a release the file
  does not control, which is the same drift the file exists to prevent
- `DEPLOY-VERIFY.md` — the post-deploy checks, in order, with what each proves

Deliberately NOT changed: `app/api/health/route.ts`. It documents a decision to
reveal nothing about internals — no version, no dependency status. A liveness
probe that leaks the build is a fingerprint; the landing page already carries
the version for humans, and that is the right place for it.

## v0.84.0-alpha — CI hardening: the three gates that would have caught this project's worst incidents

Every check below exists because something got through. None is hypothetical.

### Added — `scripts/check-server-boundaries.mjs` (`npm run check:boundaries`)

A recursive `sed` once stripped `import "server-only"` from **66 files**,
including `tenant-context.ts`, `billing/access.ts`, `platform/guard.ts`,
`audit.ts` and both payment providers. **Every existing gate stayed green** —
`tsc`, the build, the entire security suite. The guard has no runtime
behaviour; deleting it removes only the alarm.

Checks: every module reaching `@/db`, `next/headers`, `@clerk/nextjs/server`
or `@/lib/env` declares a boundary · no `"use client"` file imports a
`server-only` module · a `"use server"` file exports only async functions.

**Found two real gaps on its first run**, both now fixed: `lib/queue/processors.ts`
(opens `withTenant()` transactions, no guard) and `db/index.ts` (exports the
client and both scope functions — the single most important module never to
reach a browser, and the one file that did not say so). 80 → **84** guarded.

⚠️ Its first draft flagged 30+ files in `lib/` that import `@/db/schema` for
**types only**. Type imports are erased at compile time — those modules are
pure GST/interest/seat arithmetic and are correctly importable anywhere.
Demanding a boundary on them is how a check trains people to silence it. The
rule now strips type imports and ignores `@/db/schema` entirely.

### Added — `scripts/check-migrations.mjs` (`npm run check:migrations`)

Three files were numbered 0062/0072/0076 when the highest real one was 0045.
`SQL-FILES/` is applied in numeric order, so numbering **is** execution order.
Nothing in CI read SQL filenames.

Checks duplicates, gaps, and reuse of a `_superseded/` number. The two
historical gaps (0004, 0010) are allowed **by name, with reasons** — a check
that tolerates a category of fault stops catching that fault.

### Added — `scripts/check-rls-coverage.mjs` (`npm run check:rls`)

Four tenant-scoped tables shipped with no RLS at all. The existing CI step
asserts a **floor** (`count >= 100`) — adding four unprotected tables to 160
protected ones leaves the count at 160. **A floor measures what was done
right; it cannot see what was done wrong.**

This asks the opposite question, exhaustively: for *every* table with a
`tenant_id` column — RLS enabled, forced, policied on `app_current_tenant_id()`,
and no `app_platform_scope()` in `WITH CHECK`. Zero thresholds. Fails closed
when it cannot run, because "found nothing" is not "passed".

### Added — `scripts/preflight.mjs` (`npm run preflight`)

One gate, invoked identically by CI and locally. Ordered by cost: the two
static checks take milliseconds and catch the two worst incidents here, so the
common case fails in under a second instead of after a four-minute build.
Runs all checks even after one fails, and reports a table.

### Added — `scripts/neon-status.mjs` (`npm run db:status`)

`SQL-FILES/` has no migration ledger — nothing records what ran. This reads
every `CREATE TABLE` out of every numbered file and reports each as APPLIED,
PARTIAL or MISSING against a live database. Read-only. **PARTIAL is the
interesting result**: a file that failed part-way, or a `drizzle-kit push`
that dropped something, leaves a database no single file describes.

### Added — `scripts/make-release.sh` (`npm run release`)

Builds a verified archive into `~/Downloads/ORDENCE ERP - APP.ORDENCE.COM/`.
Runs preflight first and aborts on failure — a zip built from a tree that does
not compile is worse than no zip. Verifies with `unzip -t` (a truncated
archive lists its entries happily until the central directory is read),
scans for secrets with an **anchored** match, and writes a checksum and
release notes.

⚠️ The secret scan is `grep -x`, not a substring. Unanchored, it flags
`.env.test.example` — a committed template with no real values — and a check
that cries wolf on a safe file is one people learn to ignore.

### Changed — `.github/workflows/security-ci.yml`

Boundary census and migration numbering run in the `build` job before `tsc`.
Exhaustive RLS coverage runs in `security-tests` after the SQL is applied,
alongside the existing floor check rather than replacing it.

**No `TEST_DATABASE_URL` secret is required.** CI starts its own PostgreSQL 16
service container and writes `.env.test` itself, so `billing-gate.test.ts`
runs automatically under `npm run test:security`.

## v0.83.2-alpha — Security Track S1: the billing gate on core CRM writes

`tsc --noEmit` passes clean. No new dependencies.

### 🔴 S1 — `past_due` workspaces could still write core CRM records

`requireAccess()` had **17 call sites** against `requirePermission()`'s 151,
and was absent from the three most-used write paths in the product. A
workspace in `past_due` or `unpaid` is supposed to be read-only; it could
still create, edit and delete contacts and companies.

Added to all six writes, immediately after `requireTenantContext()` and
**before** `parse()`:

| File | Guarded |
|---|---|
| `server/actions/contacts.ts` | `createContact`, `updateContact`, `deleteContact` |
| `server/actions/companies.ts` | `createCompany`, `updateCompany`, `deleteCompany` |

Before validation deliberately: a read-only workspace should hear that it is
read-only, not receive a field error for a form it was never going to be
allowed to submit.

`AccessRestrictedError` is now caught **first** in each file's
`toActionError()` and surfaced with the billing wording. Folding it into
"Something went wrong. Please try again." would tell a customer whose card
expired that the software is broken — the one message guaranteed to produce
a support ticket instead of a payment.

Reads are untouched. A customer in arrears must still be able to see their
own data.

### 🔴 The MCP surface bypassed the gate entirely

`server/actions/deals.ts` needed no change — its only export is
`listDealPipeline()`, a read. Auditing *why* surfaced the real hole: the
**only** deal write in the codebase is `ordence_update_deal_stage` in
`server/mcp/dispatch.ts`, and that dispatcher checked the token, the scope
and RLS — but never whether the workspace was still paying.

So a company's own staff were correctly read-only while an AI agent holding
a `read_write` token for the same workspace kept writing. Read-only that one
caller can walk around is not read-only.

- **`server/billing/access.ts`** — added `getAccessDecisionForTenant()` and
  `requireAccessForTenant()`. The existing path resolves the tenant from a
  Clerk session; MCP has no Clerk session, only `session.tenantId`. Both new
  functions fail OPEN on their own errors, matching `getAccessDecision()` —
  a billing-table outage must not stop a customer's agent pipeline. The
  subscription read runs inside `withTenant()`, because a plain `db` read
  with no tenant context returns zero rows under RLS and would have looked
  like "no subscription" and granted everyone full access.
- **`server/mcp/dispatch.ts`** — every tool declared `scope: "read_write"`
  now passes the gate before executing. Read tools are unaffected; an agent
  answering "what do I owe?" is the call most likely to end in a payment.

### Changed

- **`server/actions/deals.ts`** — a header explaining why it has no
  `requireAccess()` call and what to do the moment a write is added. A new
  write added without the guard silently reopens this hole and nothing in
  the type system would notice.

### Removed / renamed

- **`lib/command/registry.ts`** — deleted. Dead code with zero importers;
  the working ⌘K palette is `components/layout/command-bar.tsx` and carries
  its own action list. Two lists of command destinations would drift.
- **`MASTER_PLAN.md` → `docs/BATCH-PLAN-460.md`** — renamed rather than
  deleted. It is **not** a duplicate of `docs/MASTER-PLAN.md`: that file is
  a v0.25.0-alpha product roadmap (Waves A–H, "what unlocks money") and
  contains zero mentions of the 460 batches, the seven departments or
  `ui_governance_checks`. Deleting it would have destroyed the roadmap the
  batch work runs from. The similar names were the actual problem.

### Tests

**`tests/security/billing-gate.test.ts`** — 16 assertions across five groups,
against a real throwaway Postgres.

⚠️ **It drives `unpaid` + expired grace, NOT `past_due`** — and the header
explains why at length. `tests/ui/access-state.test.tsx` already pins the
commercial rule in a test named *"⭐ past_due NEVER restricts writes, at any
failure count"*: while the provider is still retrying, cutting access loses
the customer **and** the payment. Restriction begins only once the status is
`unpaid` and its seven-day grace window has closed — roughly three weeks
after the first failure.

A suite written against `past_due` would have gone red and looked like the S1
gate was broken, inviting somebody to "fix" it by making `past_due`
restrictive — silently reversing that decision and locking customers out on
their first failed card.

Covers: writes refused · **reads still succeed** · billing and export never
blocked · healthy workspace untouched · fails **open** on a lookup fault ·
MCP `read_write` gated while read tools stay available · RLS unaffected by
billing state.

Two of the groups are **source assertions**, deliberately. Every behavioural
test above passes whether or not `contacts.ts` actually calls the gate — they
test the gate, not its callers, and that is the exact shape of the original
defect: a correct, tested `requireAccess` with 17 call sites where 151 were
needed. So the suite also reads the source and asserts each write path calls
it, that `AccessRestrictedError` is surfaced rather than swallowed, that the
dispatcher still contains the `read_write` branch, and that `deals.ts` has
gained no write function.

### Coverage

`requireAccess` / `requireAccessForTenant` call sites: **17 → 32**.

## v0.83.1-alpha — The Build Fix, the Pooling Fix, and the Missing RLS

Canonical tree: **`ordence-v55 2`**. `tsc --noEmit` passes clean.
No new dependencies — `package.json` gained nothing.

### 🔴 THE BUILD FAILURE — found and fixed

`next build` had been failing with:

    x You're importing a component that needs "server-only".
    ./server/platform/users.ts
    Import trace: ./components/platform/user-actions.tsx

`components/platform/user-actions.tsx` is a `"use client"` component and it
imported `updateUserStatus` / `updateUserRole` **straight from**
`server/platform/users.ts` — a `server-only` module that reaches
`guard.ts` → `withPlatformScope()`, the cross-tenant read escape hatch.

This is why `tsc --noEmit` always passed: TypeScript does not check bundler
boundaries. Only webpack catches it.

**The fix is the house rule already written at the top of
`server/platform/actions.ts`:** *"Every one delegates immediately to a module
that starts with `import "server-only"`."* A client calls a `"use server"`
wrapper; the wrapper delegates to the server-only implementation, which does
its own authorisation. The two wrappers for users had simply never been
written. Added `updateUserStatusAction` and `updateUserRoleAction`.

**⚠️ A `sed` had deleted `import "server-only";` from `users.ts` as an
attempted fix. That has been reverted** (restored byte-identical from the
untouched sibling). Deleting the line removes the alarm, not the fault — and
it does not even work: the same error immediately reappears in `guard.ts`,
which also imports `next/headers` and genuinely cannot exist client-side.

**Swept all 33 client components** that import `@/server/*`. This was the
only violation; the other 32 were already correct.

### 🔴 Missing row-level security

`SQL-FILES/0062`, `0072` and `0076` created four tenant-scoped tables —
`deployment_releases`, `deployment_backups`, `security_batches`,
`flow_submissions` — with **no `ENABLE`, no `FORCE`, no policy**. In this
codebase RLS *is* the tenant boundary; a `tenant_id` column with no policy
behind it is a column, not isolation.

They were also numbered 0062/0072/0076 when the highest real migration was
0045, leaving permanent gaps.

Replaced by **`0046_deployment_flows_governance.sql`** — contiguous
numbering, the same four tables plus the `ui_governance_checks` tracker the
460-batch plan referenced but never defined, all with the policy shape every
other table here uses:

    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id())

Platform scope in `USING` only — read across tenants for support, never
write. The old files moved to `SQL-FILES/_superseded/` with a README. 0046
is idempotent, so it repairs an already-migrated database rather than
duplicating.

### 🔴 The v55 notification regression

- **Every notification emailed everyone.** The severity test read
  `critical || warning || !input.severity` — the third clause meant the
  DEFAULT case emailed every active user, and `background-workers.ts`
  creates those on a schedule.
- **50 sequential awaited Resend calls** on the request path → now
  `Promise.allSettled`, one round, cannot reject.
- **Returned the literal string `"created"`** instead of the UUID its own
  return type promised. `ordence_create_reminder` was handing the word
  "created" to an AI agent.
- **The tenant-name lookup read zero rows, always** — it used the plain `db`
  client with no tenant context, so RLS matched nothing. Every email said
  "Your workspace". Folded into the tenant transaction, collapsing three
  connections per notification into one.

### ⭐ `withTenant()` no longer opens a pool per call

`db/index.ts` created a new `Pool` and called `pool.end()` on **every**
tenant-scoped query — correct for Cloudflare Workers, wrong for the
long-lived Node process Railway runs, where it meant a fresh TCP handshake
and TLS negotiation per query and a straight run at Neon's connection limit.

Now one lazily-created process-wide pool with an `error` handler so an
evicted idle client cannot kill the process. **Isolation is unaffected:**
every setting uses `set_config(..., is_local => true)` inside an explicit
transaction, so it is discarded at COMMIT before the connection is reused.

### 🔴 `ordence_create_compliance_task` could never have run

It omitted `period_start` and `period_end` (both NOT NULL) and supplied
`due_date`, whose schema comment reads *"Written by trigger. Never accept
this from a form."* A cast — `as unknown as typeof complianceTasks.$inferInsert`
— suppressed the only check that would have caught it. Now matches the
documented convention in `server/actions/compliance.ts` and is idempotent by
constraint.

### Added

- `components/layout/command-bar.tsx` — ⌘K palette on `@radix-ui/react-dialog`
  (already a dependency) rather than adding `cmdk`. Filtering is server-side
  via `globalSearch()` under RLS. 200ms debounce, because search is
  rate-limited server-side.
- `server/actions/bulk.ts` — bulk soft-delete and owner reassignment over a
  hardcoded entity allowlist. One transaction, one audit entry with a
  `batchId`, permission checked once before the first write, capped at 500.
  Soft delete only. Calls `requireAccess()`.
- `lib/documents/csv.ts` — CSV export with formula-injection neutralising
  (CWE-1236), UTF-8 BOM so ₹ and Devanagari survive Excel, CRLF per RFC 4180,
  explicit column allowlist.

### Notes

- **No `cmdk`, no `xlsx`, no `puppeteer`.** Puppeteer in particular pulls
  ~170 MB of Chromium at install on a builder that was already the fragile
  part of this project, and `lib/billing/invoice-render.ts` already emits a
  Rule-46 invoice with print styles.
- **The seven files pasted in from the previous AI session are retained and
  currently imported by zero modules** — `lib/ui/tokens.ts`,
  `lib/command/registry.ts`, `lib/flows/registry.ts`,
  `lib/security/toolkit.ts`, the two `components/ui/` wrappers, and
  `deployment-control/page.tsx`. They compile; nothing uses them yet.
  `lib/security/toolkit.ts` also duplicates token hashing that
  `server/mcp/dispatch.ts` already does — two hashing paths will diverge.
- **Still open:** `requireAccess()` has 17 call sites against
  `requirePermission()`'s 151, and is absent from `contacts.ts`,
  `companies.ts` and `deals.ts`. A `past_due` workspace is meant to be
  read-only and can still write core CRM records.
- `npm install` reports 12 vulnerabilities (6 high) and an
  `eslint@10` / `eslint-config-next@16` peer conflict against `next@15`.

## v0.21.0-alpha — PITR, Backup & Restore (1 August 2026)

**Wave 2 complete** (bar the admin-console wiring). A recycle bin, a
tenant export, a disaster-recovery runbook, and a drill that proves a
restore actually works.

### Added
- **`lib/backup/recoverable.ts`** — the catalogue of what can be restored,
  with per-entity preconditions. Deliberate omissions (users, tenants,
  payment methods) each carry a reason.
- **`server/backup/restore.ts`** — the recycle bin, with preconditions
  checked BEFORE writing and re-checked inside the transaction.
- **`server/backup/export.ts`** — a complete tenant export. Answers three
  requirements at once: disaster recovery, the DPDP right of access, and
  the ability to leave.
- **`scripts/restore-drill.ts`** (`npm run drill:restore`) — a real
  restore against a real database, refusing to run against production.
- **`docs/DISASTER-RECOVERY.md`** — four incident levels, each with a
  different response, and an explicit list of what the runbook does not
  cover.
- **`app/(crm)/settings/recovery/`** — the recycle bin and export UI.

### The decisions
- **Nothing hard-deletes on a timer.** The 30-day window governs what the
  recycle bin SHOWS, not what exists. A sweeper whose failure mode is
  unrecoverable data loss, running unattended forever, is not a feature.
- **Restore is blocked when the parent is deleted**, when a live row has
  taken a unique value, or when it falls in a closed financial period.
  Each message names the remedy, not just the status.
- **The export is an allowlist**, never a scan of `information_schema` —
  a dynamic export is one migration away from including a token table.
- **The export includes soft-deleted rows**, deliberately: "a copy of your
  data" means everything, and it is what makes the file a real backup.
- **Export is permitted at every access level**, including a hard lockout.
  Under DPDP the right of access does not lapse over an unpaid invoice.

### Found by these tests
- **Two wrong column names in my own catalogue** (`contacts.full_name`,
  `custom_object_records.object_definition_id`). Either would have made
  a whole category of the recycle bin throw and render empty — which reads
  to a customer as "gone forever". Caught by coherence tests that check
  the catalogue against the live schema.
- **The drill initially ran everything on one connection** and failed at
  "create a workspace" with an RLS violation. That was RLS working
  correctly, but it meant five reported failures that said nothing about
  whether a restore works. Split into app and admin pools, as the test
  suite already does.

### Tests
- `tests/security/recovery.test.ts` — 21 tests, including a sweep proving
  a tenant-scoped read of every exported table returns zero foreign rows.
- Totals: **361 security** (was 340), **556 UI** (unchanged).

---


## v0.16.0-alpha — Invoicing & the Billing Portal (1 August 2026)

**Wave 1 complete.** GST-compliant invoice generation, a customer billing
portal, and the constraints that stop an invoice being created wrongly.

### Added
- **`server/billing/invoice-generator.ts`** — draft → attach lines → issue,
  all in one transaction. The order is forced by the database, not by
  convention.
- **`lib/billing/invoice-lines.ts`** — pure line composition. Extra seats
  get their OWN line; prorations show credit and charge separately.
- **`lib/billing/invoice-render.ts`** — a self-contained GST tax invoice
  with every field Rule 46 requires, amount-in-words in the Indian
  numbering system, and print styles.
- **`server/actions/invoicing.ts`** — read, download, issue by hand, void.
- **`app/(crm)/settings/billing/`** — the portal, with a per-panel Suspense
  boundary so one slow query cannot blank the page a lapsed customer came
  to fix.
- **`SQL-FILES/0015_phase16_invoicing.sql`** — the duplicate-period index,
  the empty-invoice guard, REVOKE-before-GRANT, 8 verification checks.

### The constraints that matter
- **One invoice per subscription period**, by partial unique index.
  Proven by racing four concurrent attempts: exactly one wins.
- **A voided invoice frees the period** for a corrected one — the only
  supported route back from a mistaken issue.
- **An invoice cannot be issued with no lines.** The Phase 11 trigger
  prevents CHANGING an issued invoice, not issuing an empty one.
- **No DELETE on invoices.** A number that vanishes from a series is
  exactly what an auditor asks about.
- Invoice numbers are unique across the whole platform, not per tenant —
  GST requires the series consecutive across the registration.

### Fixed
- **`amountInWords` returned lowercase for amounts under one rupee.**
  Capitalisation was applied to the rupee words, which are empty below
  ₹1. Caught by sweeping a range rather than checking one value.
- **A concurrency test was asserting a property the code deliberately does
  not have.** It fired four deltas at a level starting from zero and
  expected an order-independent sum; the clamp at zero discards a negative
  delta that lands first. The clamp is correct — a negative storage level
  would hand a tenant unlimited free quota. The test was rewritten to
  assert what is true and valuable, with the clamp given its own test.
- **Two tests were mutating shared fixture state**, producing failures that
  pointed somewhere else entirely. Both made hermetic, and an implicit
  ordering dependency they had been hiding was removed.
- **Pure logic extracted out of a database-importing module for the third
  time.** The rule now stated explicitly: decision logic does not live in a
  file that imports the database.

### Tests
- `tests/ui/invoicing.test.tsx` — 35 tests: every Rule 46 field, hostile
  input in the customer's own legal name, Indian numbering.
- `tests/security/invoicing-integrity.test.ts` — 11 tests including the
  concurrency race.
- Totals: **556 UI** (was 521), **340 security** (was 328). Both stable
  across repeated runs.

---


## v0.15.0-alpha — Usage Metering, Integrated (1 August 2026)

Phase 15 wired into the running application, and the Phase 17/18 schema
brought into the barrel and the composite SQL.

### Integrated
- `usage_counters` / `usage_levels` exported, pushed and under forced RLS.
- **Storage reservation shares one transaction with the document row.** A
  row without a reservation is free storage that compounds silently; a
  reservation without a row refuses an honest customer space they are not
  using. Both are silent, so they land together or not at all.
- **Release on delete is best-effort and outside the transaction.** Rolling
  back a failed meter update would leave the blob already gone from storage
  while the row survived — a document the customer can see and never open.
  An over-count that the nightly reconcile corrects beats a dangling
  reference that nothing does.
- **Quota gate on upload only.** Never on delete, download or export — a
  customer at their limit must always be able to free space and to leave
  with their data. Asserted by test.
- Portal-link creation metered, best-effort.
- `db:verify` extended: **38 tables under forced RLS, 40 policies, 11
  append-only tables.** All checks green.

### Fixed
- **Test pool was sized exactly to demand.** `max: 4` with a concurrency
  test needing exactly 4 simultaneous connections. Any lingering connection
  starved it, and the suite then reported a CONCURRENCY test failing —
  pointing at the code under test rather than the harness. That is the worst
  shape a flake can take in a security suite. Doubled, with the reasoning
  recorded.
- **Public env values now supplied to the UI suite.** `lib/env.ts` parses
  `clientEnv` at module scope and throws, which is correct for production
  and means any module transitively importing it explodes under test. This
  surfaced twice as nineteen unrelated AUTHORISATION tests failing.
- The upload suite now mocks the quota gate (it reaches the database, and
  `getServerEnv()` correctly refuses to run under jsdom) **and asserts the
  gate is present and ordered before token issuance** — a mocked dependency
  you also rely on being present can otherwise be deleted with the suite
  still green.

### Tests
- **521 UI** (was 395), **328 security** (was 238).

---


## v0.14.0-alpha — Lockout, Dunning & Access Restriction (31 July 2026)

**Wave 1, Phase 4 of 6.** The paywall — written around one principle:
**never lock out a customer who is trying to pay you.**

### Added
- **`lib/billing/access-state.ts`** — a five-rung ladder (full → notice →
  warning → restricted → locked) with the copy for each. Pure and
  isomorphic.
- **`server/billing/access.ts`** — `requireAccess()`, `checkAccess()`,
  `getAccessBanner()`, `AccessRestrictedError`.
- Access gate wired ahead of the entitlement and permission gates on all
  twelve write paths.

### The rules
- **`past_due` NEVER restricts anything**, at any failure count. While the
  provider is still retrying, cutting access is the worst of both worlds.
- **`unpaid` still honours a 7-day grace window.** Earliest possible
  restriction is roughly three weeks after the first failure.
- **Restriction means READ-ONLY, never hidden.** Every record stays
  visible and exportable.
- **Export is permitted at every level, including a hard lock.** Retaining
  someone's data while denying them a copy is a DPDP problem, not a
  collections strategy.
- **Billing is reachable at every level** — a paywall you cannot pay
  through is just a wall. Enforced by an exempt-prefix list, tested
  against adversarial namespaces.
- **A trial does not hard-stop at midnight** — three days of read-write
  grace, because a trial that stops dead catches people mid-evaluation.
- **Cancelling keeps full access through the paid period.**
- **Administrative suspension outranks billing**, checked first, so paying
  an invoice cannot silently un-suspend a workspace suspended for abuse.
- **No collections language.** Asserted by test — no "delinquent",
  "overdue", "arrears".

### Design note — this gate FAILS OPEN
Every other gate fails closed. This one cannot: a failed subscription
query must not take every paying customer's workspace away. A few hours
of unbilled access is a smaller blast radius than a self-inflicted outage.
Administrative suspension still applies, because it is decided from the
tenant row rather than the query that failed.

### Tests
- `tests/ui/access-state.test.tsx` — 28 tests, including a sweep over every
  status × grace × trial combination asserting no state ever hides or
  blocks export of a customer's own data.
- Totals: **395 UI** (was 367), **238 security** (unchanged).

---


## v0.13.0-alpha — Seat Licensing (31 July 2026)

**Wave 1, Phase 3 of 6.** Seat counting and enforcement. No new tables, no
new dependencies, shared bundle unchanged.

### Added
- **`lib/billing/seats.ts`** — pure seat arithmetic. `occupiesSeat`,
  `computeSeatState`, `canTakeSeats`, overage and warning copy.
- **`server/billing/seats.ts`** — `countSeatsInUse`, `countSeatsPurchased`,
  `requireSeat`, `getSeatSummary`, `SeatLimitError`.
- `getSeatUsage()` action for the team page.
- Enforcement on user reactivation and on the Clerk membership webhook.

### The seat rules, stated explicitly
- **Invited users HOLD a seat.** The most commonly got-wrong rule: without
  it a 5-seat workspace can invite fifty people and someone is surprised
  on acceptance day.
- **Suspended users free a seat** — that is how a customer swaps one
  employee for another. The consequence is that *reactivating* someone
  consumes a seat and can fail, which is checked and explained.
- **`platform_super_admin` never consumes a customer's seat.** Billing
  someone for our own support engineer would be indefensible.
- **Guests never consume a seat** — closer to a portal visitor than an
  employee.
- **Nobody is auto-suspended when a workspace goes over.** Choosing six of
  eleven employees to lock out is not a decision an algorithm should make.
  Everyone keeps working; only *adding* is blocked.
- **Blocks rather than auto-charging.** Silently adding seats to an invoice
  produces a bill the admin never agreed to.

### Design notes
- Seats are counted **live**, never cached. A `seatsUsed` counter would
  need every status-changing path to remember to adjust it, and one missed
  path means a customer is blocked with seats free, or exceeds what they
  paid for.
- The Clerk webhook path **does not refuse** — a non-2xx makes Clerk retry
  forever and strands the user in the identity provider. It creates the
  user, lets the workspace go over, and writes an audit row.
- The seat rule is written twice (SQL and TypeScript).
  `tests/security/seat-licensing.test.ts` asserts they agree against a real
  database over a fixture covering every status and both exempt roles.

### Tests
- `tests/security/seat-licensing.test.ts` — 30 tests.
- Totals: **238 security** (was 208), **367 UI** (unchanged).

---


## v0.12.0-alpha — Entitlements & Feature Gating (31 July 2026)

**Wave 1, Phase 2 of 6.** One `can(feature)` gate the whole product
consults. No new dependencies; shared bundle unchanged at 102 kB.

### Added
- **`lib/entitlements/features.ts`** — 26 gateable features, each with a
  `minTier`. Pure and isomorphic so the pricing page, the navigation and
  the server gate read one matrix. Tiers are a ladder, so a higher tier is
  always a strict superset.
- **`server/entitlements.ts`** — `requireFeature()` (throws, for writes),
  `checkFeature()` / `can()` (returns, for reads), `checkFeatures()`,
  `getEntitlementSummary()`. Deduplicated per-request with React `cache()`.
- **`components/billing/feature-gate.tsx`** — `FeatureGate`,
  `UpgradePrompt`, `LockedControl`.
- Gates wired into 12 write paths across accounting, periods, storage,
  custom objects, contracts and the portal.

### Design decisions
- **Entitlement is checked BEFORE permission.** Order does not change the
  outcome, only the message — and telling a workspace owner they "lack
  permission" for something they have not bought sends them to ask an
  administrator who is themselves.
- **Reads are never gated.** A downgrade must not make the customer's own
  ledger, contracts or documents look deleted. They can look; they cannot
  write.
- **A trial is treated as Advanced**, not as the cheapest tier — a trial
  that unlocks the least impressive version sells nothing.
- **A lapsed workspace drops to Basic**, not to zero, and its message says
  "paused, your data is safe" rather than "upgrade".
- The subscription row is authoritative; `tenants.plan_tier` is only a
  fallback, because a delayed webhook would otherwise gate a customer who
  has just paid.

### Fixed (found by these tests)
- **`isFeatureKey` used the `in` operator**, so `toString`, `constructor`
  and `__proto__` all read as known features. It happened to fail closed
  through a chain of coincidences, and reported the wrong reason. Now
  `Object.hasOwn`.
- **`inert=""` rendered nothing.** React drops an empty string for
  boolean-ish attributes, so the "locked" subtree stayed fully keyboard
  focusable with no visible symptom — only a keyboard or screen-reader
  user would ever have found it. Now `inert={true}`.
- **An automated pass put three gates on `getTrialBalance` and none on
  `postTransaction`** — reads gated, writes open. Corrected, and a test
  now fails if any action whose name starts with `get`/`list`/`find` is
  ever feature-gated again.

### Tests
- `tests/ui/entitlements.test.tsx` — 29 tests including the
  superset property across every tier pair, prototype-pollution keys, and
  a source scan asserting no action compares `planTier` directly.
- Totals: **236 UI** (was 207), **171 security** (unchanged).

---


## v0.11.0-alpha — Billing Foundation (31 July 2026)

**Wave 1, Phase 1 of 6.** The machinery to charge people. No new production
dependencies; the shared client bundle is unchanged at 102 kB.

### Added
- **`db/schema/billing.ts`** — six tables: `plans` (platform catalogue, no
  tenant_id, protected by GRANT), `subscriptions`, `invoices`,
  `invoice_lines`, `payment_events` (append-only evidence), `payment_methods`
  (provider tokens only — no PAN, no CVV, no PCI scope).
- **`lib/billing/money.ts`** — exact BigInt minor-unit arithmetic, GST
  computation (CGST/SGST vs IGST), GSTIN validation with mod-36 checksum,
  second-based proration, month-end-safe interval arithmetic.
- **`lib/billing/providers/`** — Razorpay, Stripe and manual adapters behind
  one interface. HMAC verification via `node:crypto`; no SDKs.
- **`lib/billing/state-machine.ts`** — the pure subscription transition
  table, extracted so it is testable without a database.
- **`lib/billing/redact.ts`** — Luhn-checked payload redaction before
  permanent storage.
- **`server/billing/reconcile.ts`** — the single path by which a provider
  event changes state. Idempotent, transactional, order-aware.
- **`app/api/webhooks/{razorpay,stripe}/route.ts`** — public endpoints,
  Node runtime, verify-before-parse.
- **`server/actions/billing.ts`** — checkout, plan preview, cancellation,
  manual settlement, billing profile.
- **`SQL-FILES/0009_phase11_billing.sql`** — RLS on five tables, append-only
  triggers, issued-invoice immutability, invoice numbering sequence, grants.
- **`scripts/seed-plans.ts`** (`npm run seed:plans`) — idempotent upsert that
  never reprices existing customers.

### Security
- **Webhook replay protection** — UNIQUE index on
  `payment_events(provider, provider_event_id)`, global rather than
  per-tenant so one tenant cannot replay another's event.
- **Out-of-order protection** — `subscriptions.last_provider_event_at`
  high-water mark against the provider's timestamp.
- **One live subscription per tenant** — partial unique index, preventing
  double billing after a failed cancellation.
- **Issued invoices immutable** — amounts, number, tenant, tax identity and
  line items all fixed once issued; drafts remain editable.
- **🔴 Fixed: additive GRANTs were not a restriction.** The grant block only
  added privileges, so a prior blanket `GRANT ALL` would have left the
  application able to reprice its own plans and alter payment evidence. Now
  revokes first. `db:verify` asserts it.
- `db:verify` extended from 7 checks to 10.
- 30 tables now under forced RLS (was 25).

### Tests
- `tests/security/billing-isolation.test.ts` — 45 tests, real PostgreSQL 16,
  non-superuser.
- `tests/ui/billing-webhooks.test.tsx` — 60 tests: signature forgery,
  replay, tampering, secret rotation, event normalisation, redaction, and
  the full state machine.
- `tests/ui/billing-money.test.tsx` — 45 tests including property tests over
  every hour of a month.
- Totals: **171 security** (was 126), **207 UI** (was 102).

### Fixed
- A control-character detection test that itself contained literal control
  characters.
- `tgenabled::text` cast in a verification query that crashed on PG16.

### Known limitations
- **Provider plan ids are not set, so nothing can be purchased yet.**
  Fifteen minutes of Razorpay dashboard work; documented in the deployment
  guide.
- Invoice *generation* is Phase 16; proration is computed but not charged
  until Phase 14.
- No end-to-end test against a live provider sandbox.

---


Versions follow `MAJOR.MINOR.PATCH`. Every batch increments MINOR; every fix
within a batch increments PATCH. Each version passes a security run before release.

---

## [v0.10.0-alpha] — 2026-07-31 — Executive Dashboards & Financial Analytics

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.10.0.md))
**Tests:** 228 passing (126 security + 102 UI) · **Build:** clean, 28 routes · **Prod vulns:** 0

### Added
- **Three SQL analytics views**, all created `WITH (security_invoker = true)`:
  `v_asset_portfolio`, `v_ledger_daily` (30-day date spine), `v_contract_pipeline`
- **`db/schema/analytics.ts`** — Drizzle view TYPES only, via `.existing()`, so
  `drizzle-kit push` cannot recreate them without `security_invoker`
- **`server/actions/analytics.ts`** — aggregates inside `withTenant()`, summed in
  BigInt paise, never floats
- **Rebuilt dashboard** — six independent `<Suspense>` boundaries, each panel
  fetching its own data so the page streams instead of blocking on the slowest query
- **Skeleton loaders** that reserve layout, preventing content jump
- **`FinancialBarChart`**, **`AssetPipelinePieChart`**, **`RecentActivityFeed`**
  (virtualized), **`QuickActions`**
- **`npm run db:verify`** — interrogates the live database and exits non-zero if
  RLS, policies, `WITH CHECK`, `security_invoker` or integrity triggers are missing
- **13 new tests** proving RLS isolation through the views

### 🔴 Critical operational finding: `drizzle-kit push` drops every RLS policy
`push` treats anything absent from the Drizzle schema as drift. Our policies live
in `SQL-FILES/`, so it deletes them. Measured:

```
before  npm run db:push  ->  25 tables with RLS,  25 policies
after   npm run db:push  ->   0 tables with RLS,   0 policies
```

The application keeps working — every page renders, every query succeeds. The only
difference is that tenants can read each other's data.

No harm has occurred: every deployment guide runs `ALL-IN-ONE-SETUP.sql` *after*
`push`, which restores everything. But a standalone `push` would remove every
tenant boundary silently. Mitigated with `db:verify` (fails non-zero), a warning
printed by `db:push`, a CI step, and explicit documentation. **SEC-022** recommends
`db:generate` over `db:push` for production.

### ⭐ RLS does NOT cascade into SQL views
A PostgreSQL view runs as its OWNER, not the caller. Measured before writing any
view — a non-superuser session pinned to ONE tenant:

```
naive view      (no option)                ->  6 tenants visible
safe  view      (security_invoker = true)  ->  1 tenant  visible
```

Nothing errors; the dashboard renders; the numbers are the whole platform's. All
three views use `security_invoker`, the SQL refuses to run on PostgreSQL < 15, and
a test builds both kinds side by side to demonstrate the difference rather than
assert it.

### Bundle impact — Recharts does NOT bloat the app
```
Routes loading the Recharts chunk:  1 of 33  (/dashboard)
Recharts chunk:                     105 kB gzipped
Shared-by-all baseline:              98 kB gzipped  (UNCHANGED)
Public portal route:                120 kB          (UNCHANGED)
```

### Chart design
Colour was **computed, not chosen** — every hue validated against the real chart
surfaces. Three light-mode hues measured below 3:1 contrast, so every chart ships a
legend, direct value labels and a **"View as table"** toggle. Categorical hues in
fixed order, never cycled; donut capped at 5 slices with the tail folded to "Other";
no dual-axis charts; status colours reserved and always paired with a word.

### Changed
- Superseded Phase 5 dashboard (`server/dashboard.ts`, `dashboard/charts.tsx`)
  moved to `_to_delete/phase10-superseded/`

### Known limitations
- **SEC-023 (new, low):** views re-aggregate on every load. Correct and fast for a
  single tenant's row counts; revisit past ~1M journal entries.
- The dashboard has **not been rendered in a real browser** yet — data layer, types
  and build are verified; visual geometry is not.

---

## [v0.9.0-alpha] — 2026-07-31 — External Client Portal & Secure Approvals

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.9.0.md))
**Tests:** 215 passing (113 security + 102 UI) · **Build:** clean, 28 routes · **Prod vulns:** 0

### Added
- **`portal_links` table** — 256-bit bearer credentials, stored as SHA-256
  hashes. RLS `ENABLE` + `FORCE`, plus a tamper-guard trigger covering the
  token, target, permission and expiry
- **`contract_signatures` table** — append-only signature evidence with IP,
  user agent, content hash and the verbatim consent statement
- **`lib/portal/tokens.ts`** — `crypto.randomBytes` generation, hashing,
  shape validation, constant-time comparison, masking
- **`server/portal-context.ts`** — sessionless tenant resolution:
  `token → resolve → tenantId → withTenant() → RLS`
- **`/portal/[token]`** — public, branded, read-only document view requiring
  no Clerk account
- **`/portal/[token]/documents/[id]`** — token-authenticated download, separate
  from the internal route by design
- **`server/actions/signatures.ts`** — approve-and-sign with three independent
  layers of replay prevention
- **`server/actions/portal.ts`** — generate, list, revoke, revoke-all
- **`components/crm/portal-manager.tsx`** — one-time link reveal, copy, revoke
- **`ContractReadyEmail` now carries the portal URL**, so a recipient clicks
  from their inbox straight into the document instead of a sign-in page
- **48 new tests** — 25 portal isolation and token rejection, 23 token
  cryptography

### Fixed
- **🔴 `withTenant()` was silently returning zero rows.** It set
  `app.current_tenant_id` with `is_local => true` but opened no transaction, so
  the setting was discarded before the next statement and every RLS policy
  matched nothing. Present since Phase 1. It failed **closed** — nothing
  leaked — but any code path relying on it for scoping returned nothing.
  Fixed with an explicit transaction; both behaviours are now asserted in
  `tests/security/withtenant-scope.test.ts`.

  The obvious alternative (`is_local => false`) was **rejected as dangerous**:
  it sets the value for the pooled *connection*, which then returns to the pool
  still carrying that tenant. Verified — the next borrower inherits it.

- **🟠 Tamper-guard tests passed for the wrong reason.** Our triggers raise
  SQLSTATE 42501, and so does a missing `GRANT`. The test role had no
  privileges on `portal_links`, so every guard test was green while proving
  nothing. Fixed with an `expectGuard()` helper that matches the guard's
  message and explicitly rejects `permission denied for table`.

- **🟠 The portal returned 500 on a database outage**, exposing a stack trace
  to an anonymous visitor. `resolvePortalToken` now never throws — any
  unexpected failure becomes a refusal, which is the fail-closed direction.
  Verified: with the database unreachable, the portal returns a clean 404.

### Security decisions worth knowing
- **Tokens are stored hashed.** A stolen backup yields hashes, not working
  links. The cost: a link is displayable exactly once and cannot be recovered.
- **Every failure returns the same 404.** "Revoked" and "never existed" are
  indistinguishable to a visitor; the real reason is logged server-side.
- **Signing requires `contracts:approve`; viewing requires `contracts:update`.**
  Someone who cannot approve internally cannot delegate that power outward.
- **Replay is prevented three ways:** an atomic compare-and-swap that consumes
  the link *before* writing the signature, a UNIQUE index on
  `portal_link_id`, and a contract status guard.
- **A view-only link can never be upgraded to signing** — that would turn a
  read-only share into signing authority without the recipient being told.
  Downgrading is allowed.
- **`Referrer-Policy: no-referrer` and `X-Frame-Options: DENY` on `/portal`.**
  The token is in the URL, so a `Referer` leak is the realistic risk — not
  brute force against 256 bits.

### Known limitations
- **SEC-020 (new, medium):** no rate limiting on `/portal/[token]`. Not a
  guessing risk; an abuse-of-invocations risk on the Hobby plan.
- This is an **electronic record of assent, not a PKI digital signature**, and
  the signer's identity is only as strong as their inbox. Both are stated in
  the product, not buried.

---

## [v0.8.0-alpha] — 2026-07-31 — Cloud Storage, Document Assembly & Transactional Email

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.8.0.md))
**Tests:** 165 passing (86 security + 79 UI) · **Build:** clean, 26 routes · **Prod vulns:** 0

### Added
- **`documents` table** (`db/schema/storage.ts`) — polymorphic attachments for
  contracts, assets, deals, contacts and companies. RLS `ENABLE` + **`FORCE`**,
  plus two immutability triggers (tenant and parent/pathname)
- **`/api/upload`** — Vercel Blob client-token issuer. Verifies the Clerk
  session, **rebuilds the storage path from the session's tenant id**, and
  attaches the content-type allowlist, size ceiling and a 10-minute expiry to
  the token itself
- **`/api/documents/[id]/download`** — authenticated streaming download. Files
  are stored **private**; this route re-checks session and tenant on every
  request
- **`saveDocumentRecord` / `getDocuments` / `deleteDocument`** — with parent
  ownership verification standing in for the foreign key a polymorphic link
  cannot have
- **`lib/email/resend.ts`** — typed dispatcher that never throws, degrades
  cleanly without an API key, and de-duplicates via idempotency keys
- **`ContractReadyEmail` and `LedgerAlertEmail`** — HTML + plain-text, every
  interpolation escaped, `href` schemes allowlisted
- **`DocumentVault`** — drag-and-drop, per-file progress, virtualized list
- **Contract detail page** with the vault mounted and a "Send to Client" flow
- **Contracts list page**
- **36 new tests** — 17 document isolation (real PostgreSQL), 19 Blob token
  authorisation, and 41 email-safety assertions

### Security decisions worth knowing
- **Blobs are `private`, not `public`.** A public blob URL is readable by
  anyone who ever sees it, forever, with no session and no tenant check — and
  RLS cannot help, because the bytes are not in PostgreSQL. This is the single
  most consequential choice in the phase.
- **The upload path is rebuilt server-side.** The client's requested pathname
  is ignored. Honouring it would let a caller request
  `tenants/<victim>/…` and receive a valid token to write there.
- **The email recipient comes from the database, not the request.** There is no
  `to` field on `sendContractToClient`; the address is read from the contract's
  linked contact. An email cannot be recalled, so this is not a field worth
  trusting a client with.
- **Deletion is asymmetric on purpose:** the blob is hard-deleted, the row is
  soft-deleted. The bytes are the confidential part; the row is the audit trail.
  The blob is removed FIRST, so a storage failure leaves the file visible and
  retryable rather than hidden-but-present.

### Fixed / avoided during this phase
- **`onUploadCompleted` removed rather than shipped broken.** `/api/upload` is
  not a public route, so `middleware.ts` requires a session — Vercel's
  server-to-server webhook would have received a 401 on every call. It also
  never fires on localhost. The authoritative write is the server action.
- **Literal control characters in two regexes**, in `sanitizeFileName` and
  `escUrl` — the same defect this codebase shipped once before in the URL
  sanitiser. Both rewritten with explicit `\u` escapes and tested against tab
  and newline scheme-splitting payloads.
- **A stray non-English word** in a code comment, and an `access: "public"`
  that contradicted the private-storage design, both caught before build.

### Known limitation
- **SEC-018 (new, low):** if the browser tab closes between the upload
  completing and `saveDocumentRecord` committing, the object is orphaned in
  storage with no row. A storage-cost leak, not an exposure — the object is
  private and unreachable without a row. A reconciliation sweep is the fix.

---

## [v0.7.0-alpha] — 2026-07-31 — The CRUD Surface & Application UI

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.7.0.md))
**Tests:** 19 UI + 69 security = 88 passing · **Build:** clean, 22 routes · **Prod vulns:** 0

### Added
- **Form infrastructure** — `useActionForm` hook wiring Zod schemas to server
  actions, with server field errors mapped back onto the inputs they belong to
- **`DynamicFieldSet`** — renders a working form from `custom_field_definitions`
  rows; 12 field types, no migration required to add one
- **Contacts** — create and edit pages, one component serving both modes
- **Companies** — full CRUD (`server/actions/companies.ts`), list, create, edit
- **Assets** — `server/actions/assets.ts` and a create page whose Details
  section is generated from the tenant's own field definitions
- **Accounting page** — trial balance, journal entry form, period list
- **Period close/reopen dialogs** — **resolves SEC-014**. Reopening requires a
  written reason of 15+ characters, recorded in the audit log
- **Settings** — General, Team and Financial tabs as separate routes
- **Role management** (`server/actions/team.ts`) — assign roles, suspend and
  reinstate, with three anti-escalation rules enforced server-side
- **`<Toaster />`** mounted in the root layout — without it every toast in the
  application was a silent no-op
- **UI test suite** — 19 tests in jsdom driving real components with real
  keyboard input; wired into the CI security gate as a required job

### Fixed
- **`watch("legs")` did not track the field array** in the journal entry form.
  The running balance read ₹0.00 no matter what was typed, so the submit button
  could never enable — **the accounting form was completely unusable**. Replaced
  with `useWatch`. Found by the balance-gate tests, not by reading the code.
- **`required` never reached the form controls.** Every field component passed
  it to the label (for the asterisk) but not to the input, so required fields
  were not announced to screen readers and browser validation never fired.
  Fixed across all five controls.
- **Six Zod schemas exported from `"use server"` files** (`accounting.ts`,
  `periods.ts`, `documents.ts`). Next.js compiles every non-async export in such
  a file into a public RPC endpoint; the build fails once a page imports it.
  Moved to `lib/validators/`. Verified the failure mode with a probe build
  rather than assuming it.
- **`ASSIGNABLE_ROLES` exported from `server/actions/team.ts`** — the same
  defect, introduced during this phase and caught by the build.
- Removed a duplicate role-ranking table from the team UI. Two copies of a
  privilege ordering is exactly the kind of duplication that drifts apart.

### Notes
- `tsc --noEmit` does **not** catch the `"use server"` export rule. Only
  `next build` does, and only once a page imports the file. A repository-wide
  scan for the pattern is now part of the release checks.
- Settings tabs are routes, not a client `<Tabs>` panel: each loads only its own
  data and gets a real, linkable URL.

---

## [v0.6.0-alpha] — 2026-07-31 — Automated Security Tests & CI

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.6.0.md))
**Tests:** 69 passing against real PostgreSQL 16 · **Build:** clean · **Prod vulns:** 0

### Added
- **Vitest setup** with a 6-check production-database guard (3 verified firing)
- **`tests/security/rls-isolation.test.ts`** — 24 tests
- **`tests/security/accounting-triggers.test.ts`** — 23 tests
- **`tests/security/audit-immutability.test.ts`** — 22 tests
- **`.github/workflows/security-ci.yml`** — 5 jobs, real Postgres service container
- **`docs/PROJECT-STATUS.md`** — full done/pending inventory

### Fixed
- **`drizzle.config.ts` pointed at `./db/schema.ts`**, which stopped existing in
  Phase 5. Every `drizzle-kit push`/`generate` would have failed.
- **Tests were connecting as a superuser**, which bypasses RLS entirely. Every
  isolation test would have passed while proving nothing. Now uses a
  non-superuser role, with a startup check that aborts if it detects one.

### Security
- **SEC-004 RESOLVED** — isolation is now machine-verified on every commit
- Coverage tests fail if any future table with a `tenant_id` lacks RLS or a policy
- Trigger *timing* asserted, not just existence: balance check deferred, period lock immediate

### Known limitations
- **SEC-016:** branch protection not yet enabled — CI reports but cannot block

---

## [v0.5.0-alpha] — 2026-07-31 — Financial Controls, RBAC, Audit & Dashboards

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.5.0.md))
**Build:** Clean · TS strict · 0 prod vulns · 10/10 period-lock · 11/11 RBAC · 7/7 permission engine

### Added
- **Financial period close** (`financial_periods` + `enforce_period_close` trigger) —
  the database rejects any journal entry dated inside a closed period, on INSERT,
  UPDATE and DELETE. Periods cannot overlap (`EXCLUDE USING gist`). **Resolves SEC-012.**
- **Period actions** (`server/actions/periods.ts`) — create, close (with trial-balance
  verification and a ledger snapshot), reopen (separate permission, written reason,
  critical-severity audit).
- **Permission catalog** (`db/schema/auth.ts`) — 50 permissions, 9 role templates,
  `permission_denials` table for security review.
- **Permission engine** (`lib/permissions.ts`) — pure, Edge-safe, fail-closed.
  Revoke always beats grant.
- **Audit enforcement** (`server/audit.ts`) — `checkPermission` / `requirePermission`
  decide and record in one call. Dangerous denials also write a `security_event`.
- **Executive dashboard** (`app/(crm)/dashboard/`) — Recharts, polymorphic by industry.
  Real estate: cost-to-completion, retainage, unit status. Legal: retainer balances,
  contract lifecycle. Every chart paired with a screen-reader data table.
- **Phase 5 seeder** — 9 users across 8 roles, 8 ledgers, 4 periods (2 closed),
  50 balanced transactions, 100 audit logs, 18 permission denials.
- **`SQL-FILES/` folder** — all SQL in one place. `ALL-IN-ONE-SETUP.sql` is now
  1,134 lines, 13 sections, 12 verification checks, 22 protected tables.

### Changed
- `audit_logs` gained `metadata` (jsonb) and `severity` columns.
- **Did NOT create `system_audit_logs`.** The Phase 1 `audit_logs` table already
  covers it and is already append-only. A second table would fragment the trail
  across two places, so proving anything would require querying both.
- **Did NOT redeclare `user_roles` / `role_permissions`.** Both exist from Phase 1;
  duplicating them would break the build and split authorization in two.

### Security
- 4 tables now append-only: audit_logs, contract_versions, journal_entries, permission_denials.
- Separation of duties verified by executed test: the Accountant role can post
  entries but cannot close a period.
- Unknown permission strings are DENIED — a typo cannot grant access.
- 22 tables under Row-Level Security.

### Known limitations
- No UI for period close — server action only (SEC-014)
- No admin UI for permission overrides (SEC-015)
- **No automated cross-tenant isolation test suite (SEC-004)** — the most valuable
  remaining gap

---

## [v0.4.0-alpha] — 2026-07-31 — Legal CLM, Trust Accounting, Grid Persistence & Workers

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.4.0.md))
**Build:** Clean · TS strict · 0 prod vulnerabilities · 7/7 balance tests · 10/10 worker auth · 12/12 grid checks

### Added
- **Grid persistence** (`server/actions/grid.ts`) — `updateAssetCell`,
  `updateCustomRecordCell`, `bulkUpdateAssetStatus`. JSONB path allowlisting,
  prototype-pollution guards, depth/key caps, full audit trail. **Resolves SEC-009.**
- **Legal CLM** (`db/schema/clm.ts`) — `contracts`, `contract_versions`
  (immutable, SHA-256 hash-chained), `clause_library`.
- **Double-entry accounting** (`db/schema/accounting.ts`) — `ledgers`,
  `transactions`, `journal_entries`. Trust/escrow/retention ledger types.
- **Balance enforcement** — deferred constraint trigger validates debits = credits
  at COMMIT. Exact BigInt paise arithmetic in the app layer; NUMERIC(18,2) in the DB.
- **BullMQ queue** (`lib/queue/bullmq.ts`, `lib/queue/processors.ts`) — 4 job kinds,
  tenant-asserted payloads, graceful degradation when Redis is absent.
- **Worker endpoint** (`app/api/workers/route.ts`) — QStash signature, bearer secret
  (timing-safe), or Vercel Cron. Fail-closed. Bounded to 7.5s / 5 jobs.
- **Document assembly** (`server/actions/documents.ts`) — merge-field resolution,
  version chaining, `verifyContractIntegrity()`.
- **Contract renderer** (`lib/documents/render.ts`) — print-optimised HTML, fully escaped.
- **⭐ `ALL-IN-ONE-SETUP.sql`** — every migration (Phases 1–4) consolidated into one
  idempotent file with six built-in verification checks.

### Security
- Money never touches a JS float — proven in test: `0.1 + 0.2 !== 0.3`.
- Journal entries, contract versions and audit logs are all append-only at DB level.
- Cross-tenant journal posting blocked by trigger (ledger AND transaction tenancy).
- Worker secrets compared with `timingSafeEqual` — `===` leaks the prefix by timing.
- 20 tables now under Row-Level Security.

### Known limitations
- No period-close locking — back-dated entries are possible (**SEC-012**, Phase 5)
- PDF output is print-ready HTML, not binary PDF (SEC-011)
- Bank reconciliation schema exists but has no UI (SEC-013)

---

## [v0.3.0-alpha] — 2026-07-31 — Industry Routing, Asset Catalog & Virtual Grids

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.3.0.md))
**Build:** Compiles clean · TypeScript strict · 0 production vulnerabilities · 33/33 XSS checks pass

### Added
- **Industry routing engine** (`lib/industry-templates.ts`, `app/(crm)/layout.tsx`) —
  Real Estate Developer and Legal Advocate templates. Navigation, dashboard widgets
  and terminology morph from one database field. Role-filtered server-side.
- **Universal asset schema** (`db/schema/assets.ts`) — `assets` (20 asset types,
  12 statuses, JSONB attributes, GIN-indexed) and `asset_relationships` (graph edges
  with 8 relationship types).
- **Virtualized grid** (`components/crm/virtual-grid.tsx`) — TanStack Table v8 +
  TanStack Virtual. Infinite scroll, inline editing with optimistic updates,
  bulk selection, dynamic JSONB columns. Constant DOM footprint.
- **Safe rendering layer** (`lib/safe-render.ts`) — XSS-hardened JSONB display.
- **Stress-test seeder** (`scripts/seed-basaveshwar-project.ts`) — real Basaveshwar
  Nagar development: 194 assets, 193 relationships, 4-level-deep JSONB.
- **Global search** (`server/actions/search.ts`) — 4 entities, tenant-filtered first.
- **TanStack Query provider** (`app/providers.tsx`) — per-session client.
- RLS policies + cross-tenant graph triggers (`0003_phase3_rls.sql`).

### Fixed
- Literal control characters were written into `lib/safe-render.ts`, making it a
  binary file and the URL-sanitising regex unreliable. Replaced with explicit
  `\u0000-\u001F` escapes. This mattered: `java\tscript:` executes in browsers.
- Email validation allowed `<script>@evil.com` (no whitespace, one `@`). Replaced
  the permissive pattern with an RFC 5322 dot-atom allowlist.
- `onCommit` type mismatch in the dynamic column builder.

### Security
- 33/33 XSS payloads blocked by an executed test suite, not inspection.
- Tenant filter verified as the FIRST predicate in all 4 search queries by parsing source.
- Cross-tenant asset graph edges blocked at the database level.
- Self-referencing asset edges blocked (would loop tree traversal forever).
- Prototype-pollution keys blocked in JSONB path lookups.
- `QueryClient` created per session — a module-level client leaks cache across tenants during SSR.

### Known limitations
- Inline edits do not persist — `onCellEdit` is a stub pending Phase 4 (**SEC-009**)
- `/assets` caps at 1,000 rows; needs cursor pagination (SEC-010)
- No CSP yet (SEC-002); no rate limiting on search (SEC-005)

---

## [v0.2.0-alpha] — 2026-07-31 — Vertical Core, Clerk Sync & Custom Objects

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.2.0.md))
**Build:** Compiles clean · TypeScript strict · 0 production vulnerabilities · Middleware 87.1 kB

### Added
- **Clerk organization webhook** (`app/api/webhooks/clerk/route.ts`) — Svix-verified,
  handles `organization.created/updated/deleted` and `organizationMembership.created/updated/deleted`.
  Auto-provisions tenants with default branding, INR/IST settings and a 14-day trial.
- **CRM entities** (`db/schema/crm.ts`) — `companies`, `contacts`, `deals` with
  JSONB custom fields, GIN indexes, soft delete and tenant-led composite indexes.
- **Dynamic custom object engine** (`db/schema/custom-objects.ts`) —
  `custom_object_definitions`, `custom_field_definitions`, `custom_object_records`.
  Tenants define new business entities with zero migrations. 12 field types.
- **Server actions** (`server/actions/`) — full CRUD for contacts, define/read/create
  for custom objects. All Zod-validated, all tenant-scoped from the session.
- **Data grid** (`components/crm/data-grid.tsx`) — TanStack Table v8, sorting,
  pagination, search, WCAG 2.1 AA (aria-sort, keyboard rows, live regions).
  `buildDynamicColumns()` renders JSONB custom fields by declared type.
- **Schema barrel** (`db/schema/index.ts`) — single import surface.
- **Validators** (`lib/validators/crm.ts`) — schemas and pure helpers, importable by clients.
- RLS policies and cross-tenant reference triggers for all six new tables (`0002_phase2_rls.sql`).

### Fixed
- Build failure: `"use server"` files may only export async functions. Zod schemas and
  pure helpers moved to `lib/validators/crm.ts` — also removes them as unintended RPC endpoints.

### Security
- 10/10 server actions verified to derive `tenantId` from session and scope every query.
- `tenantId` is structurally impossible to supply from the client.
- Webhook ordering verified: raw body read → signature verified → only then any DB write.
- Cross-tenant FK references blocked by `assert_same_tenant()` database triggers.
- Unknown JSONB keys rejected rather than stored; `javascript:`/`data:` URLs blocked.

### Known limitations
- `updateCustomRecord` / `deleteCustomRecord` not yet implemented (SEC-007)
- `isUnique` on custom fields declared but not enforced (SEC-008)
- No CSP yet — needs nonce configuration for Clerk (SEC-002)
- Webhook endpoint is not rate-limited (SEC-005)

---

## [v0.1.0-alpha] — 2026-07-31 — Foundation

**Security run:** ✅ PASS ([report](docs/SECURITY-REPORT-v0.1.0.md))
**Build:** ✅ Compiles clean · TypeScript strict · 0 production vulnerabilities

### Added
- Next.js 15 App Router project, TypeScript strict mode (`noUncheckedIndexedAccess` on)
- Complete Drizzle schema: `tenants`, `users`, `roles`, `permissions`,
  `role_permissions`, `user_roles`, `audit_logs`
- PostgreSQL Row-Level Security policies on all six tenant tables
- Append-only `audit_logs` enforced by database triggers
- Edge multi-tenant middleware with header-spoofing defense and host/session verification
- Serverless-optimised Neon client with `withTenant()` transaction scoping
- Zod-validated environment with browser-access guard
- Tenant-namespaced Redis cache and rate limiter
- Security headers (HSTS, nosniff, frame-options, permissions-policy)
- Clerk Organizations integration — sign-in, sign-up, onboarding, dashboard
- Deployment guide, cost/upgrade guide, security report

### Security
- Pinned `postcss ^8.5.25`, `sharp ^0.35.3`, `brace-expansion ^2.0.2` via overrides
- Upgraded `drizzle-orm` → 0.45.2 (resolved HIGH advisory)
- Reduced 18 vulnerabilities → **0 in production dependencies**
- Disabled production source maps and `x-powered-by` header

### Known limitations
- Tenant rows are not auto-created yet — Clerk webhook lands in Phase 2 (SEC-003)
- No Content-Security-Policy yet — needs nonce config for Clerk (SEC-002)
- BullMQ workers cannot run on Vercel; separate host needed from Phase 3 (SEC-006)

## v1.37.0-alpha — Mega-wave 1, batches 33 and 35 (partial)

### 🔴 The tax was decided by comparing two strings (Batch 33)

`server/actions/orders.ts:231-236` decided CGST+SGST versus IGST with
`data.placeOfSupplyCode !== sellerStateCode`, while
`lib/gst/place-of-supply.ts` held a complete engine covering s.12(3)
immovable property, s.7(5)(b) SEZ, s.10(1)(a) goods movement, s.12(2)
services and the UT/UTGST distinction. Nothing called it.

The order table could not hold the engine's answer: two columns, and
nowhere for the site of a works contract, the recipient being an SEZ
unit, or an intra-UT supply. SQL 0080 adds six columns to `sales_orders`,
`state_code` to `projects`, and four CHECK constraints.

Three further sites found by the new gate rather than by reading:
- `lib/inventory/transfer.ts` — its own comment named the SEZ case four
  lines above the comparison that got it wrong.
- `server/actions/time-billing.ts` — took `isInterState` as a
  client-supplied boolean and defaulted place of supply to `"27"`.
- the same file — `isUnionTerritory: false`, hardcoded.

### Twelve links led to a 404 (Batch 35, partial)

New `check:links` gate walks the route table. `/sales` was a 404 with
seven working sub-sections underneath it; that one is built. Eleven
remain, registered with a budget that may only decrease.

### Gates: thirteen
- ⭐ `check:tax-decisions` (new) — no tax split derived from a comparison
- ⭐ `check:links` (new) — no internal link without a destination

## v1.38.0-alpha — Mega-wave 1, batch 51

### 🔴 One hardcoded `"0"` made every month behave like April

`server/payroll/run.ts:398` passed `tdsAlreadyDeductedMinor: "0"` into a
true-up that is otherwise correct. Every month was computed as if nothing
had been deducted yet: roughly double the correct deduction by September,
and in March the entire annual liability again on top of eleven months
already paid.

⚠️ It failed in the direction nobody complains about. Over-deduction is
refunded when the employee files, so the employer never hears about it.

`tdsDeductedThisFy` reads posted and approved runs in the same Indian
financial year, strictly before the period being computed, in one query
for the whole run.

### ⭐ And a branch that could never fire

`lib/payroll/statutory.ts` carries a caveat for "the year's tax is
already withheld". With the history forced to zero, `outstanding` always
equalled `liability`, so the condition was unsatisfiable. Correct code,
unreachable, same shape as the place-of-supply engine one layer down.

### 🔴 Batch 50 is blocked, and this is the finding

Feeding real attendance into the run needs an attendance table. There
isn't one: `labour.ts` has an `attendanceKindEnum` for construction
labour and nothing for staff. Batch 50 cannot ship before Batch 59.

## v1.39.0-alpha — Mega-wave 1, batch 36 (bank accounts)

### 🔴 `insert(bankAccounts)` appeared nowhere in the tree

Not "no screen". No code path at all. Reconciliation, statement import,
matching and payment recording were all built on a table nothing could
put a row in. The only way a workspace could have had a bank account was
somebody typing INSERT at a psql prompt.

⚠️ It looked fine from every angle: `getBankAccounts()` returns an empty
list, indistinguishable from a workspace that has not added one yet.

`createBankAccount` writes the ledger and the account in ONE transaction,
because `bank_accounts.ledger_id` is NOT NULL and `one_per_ledger` makes
it exclusive, so an account without its own ledger is impossible.

- `accountType: "asset"` is hardcoded, not offered. An overdrawn account
  is still an asset ledger carrying a credit balance.
- The ledger code comes from the operator's chart of accounts.
- Last four digits only, enforced at the schema so the full number never
  crosses the wire.
- Real IFSC shape, not a length check.
- `trust` and `escrow` offered, with a warning that they cannot change.

### ⭐ And a sweep that generalises it

A new test walks all 256 `pgTable` exports and asserts `bankAccounts` and
`ledgers` have writers. 52 tables have no named insert; several match
what the master checklist already flagged as unreachable, including
`campaigns`, `worksContracts` and `retentionReleases`.

## v1.40.0-alpha — Mega-wave 2, batch 41 (support consent)

### 🔴 No screen anywhere granted consent, so every visit was break-glass

`server/platform/consent.ts` is complete: two modes, role rules, expiry
per mode, and a circularity gate. `grantSupportConsent`,
`revokeSupportConsent` and `getSupportConsentState` had zero callers.

Support was never blocked. It worked through break-glass, the EMERGENCY
path. With no way to grant consent, routine and emergency collapsed into
one, so every legitimate visit looked like an emergency and the signal
the emergency path carries stopped meaning anything.

New: `/settings/support-access` with the live state first, both grant
modes, immediate revocation, and the full history.

⚠️ `check:guards` failed the new action file on first write and was
right: `requireTenantContext()` answers "who are you", not "may you do
this". The door now asks a permission and the engine still asks a role.

## v1.41.0-alpha — Mega-wave 1, batch 34 (order detail)

### 🔴 Eleven of twelve actions in `orders.ts` had no caller

1,288 lines: confirmation with credit assessment, amendment with
revisions, cancellation with a mandatory reason, hold, release, close,
fulfilment, delivery. Only `listOrders` was imported anywhere.

`getOrder` was the sharpest case: complete, returning the order, its
lines and its full event history, while the orders list linked every
order number to a route that did not exist.

New `/orders/[id]` reaches SIX of the eleven: getOrder, confirmOrder,
cancelOrder, holdOrder, releaseOrder, closeOrder.

- Buttons are derived from status, mirroring the 0028 triggers rather
  than replacing them. The database stays the authority; the screen just
  stops offering what will be refused.
- Cancellation and hold reasons are asked for BEFORE the action, so the
  ten-character minimum does not teach people to type "x" ten times.
- Fulfilled and cancelled quantities shown separately, never merged into
  a "remaining": one owes goods, the other owes a credit note.

### check:links budget 11 → 10

## v1.42.0-alpha — Batch 34 complete: the product can take an order

### 🔴 `createOrder` had no caller

New `/orders/new`, linked from the orders list. Batch 34 is now complete:
all six lifecycle actions plus creation are reachable.

Two deliberate omissions in the form:

- **It sends no place of supply.** After Batch 33 the server determines
  it and refuses if what it was sent disagrees. A form that guessed would
  turn that refusal into a routine obstacle, and the first fix anybody
  reached for would be to stop sending it.
- **It computes no money.** A running total would be a second
  implementation of `priceLine`, in floating point, in a browser, and the
  two would disagree by a paisa on the first multi-rate order.

### ⚠️ Rupees to paise without a float

`Math.round(Number("1.005") * 100)` returns 100, not 101, because
`1.005 * 100` is `100.49999999999999`. The string is split on the decimal
point instead, so a digit that was never converted cannot be lost.

### ⭐ Projects that cannot answer s.12(3) are marked

Batch 33 makes the engine refuse a works contract with no site state
code. The project dropdown shows which projects have one, so the refusal
is visible while choosing rather than a surprise at save time.

## v1.43.0-alpha — Batch 38, first half: the GRN moves the stock

### 🔴 A goods receipt wrote its own row and left the stock ledger alone

`recordGoodsReceipt` wrote a `goods_receipts` row, wrote its lines,
recomputed the purchase order status, emitted an automation event, and
never inserted a `stock_movements` row.

⚠️ So inventory could only ever go DOWN. `sales_dispatch` writes
movements; `purchase_receipt` did not. A warehouse that received a
hundred and sold ten showed minus ten.

- Accepted quantity only. Rejected goods are on the premises and are not
  ours: awaiting return, never bought, no credit owed.
- Lines with no `stockItemId` are skipped, not defaulted. A service or
  freight line has nothing to move.
- A receipt of items with no warehouse is refused, not guessed.
- `unitPriceMinor` added to the SELECT so the movement carries a cost.
  Without it every receipt would be costless, and Batch 86 would later
  value a ledger of costless receipts.

### ⚠️ Still open in Batch 38

`recordGoodsReceipt` and `runThreeWayMatch` still have no UI caller, and
`recordPurchaseInvoice` has none either. The correctness half is done;
the screens are the second half.

## v1.44.0-alpha — four batches in one run (first parallel wave)

Four file-disjoint tracks built concurrently by subagents, then one
integration pass. Previous runs delivered one batch each.

### Batch 38 second half — the purchase receipt screen
`/purchases/orders/[id]` reaches `recordGoodsReceipt` (first path by
which inventory can go UP) and `runThreeWayMatch` (first thing ever able
to set `purchase_invoices.match_state`, which the payment run has read
since v1.11.0).

### Batch 37 — statement periods
P&L, balance sheet and trial balance take a period, defaulting to the
current Indian FY rather than since inception. 🔴 The balance sheet takes
an "as at" and keeps `from: null`, because a from-date would filter out
opening balances and every asset would vanish. `retainedResultToDate`
added so the accounting identity still holds in year two.

⚠️ Also fixed in passing: `app/(crm)/statements/page.tsx` was CRASHING on
every load. `BigInt("1234.56")` throws, and the action produces decimal
strings. Any tenant with one ledger row got an exception.

### Batch 45 — canary probes
`/api/cron/canary` attempts cross-tenant reads against real tenant ids on
a schedule. 🔴 Refuses to report a pass when the connection bypasses RLS,
returning 503 INCONCLUSIVE rather than a green tick that would be false
assurance forever. Also detects the third bypass vector: a table owner is
exempt from its own policies without FORCE.

### Batch 35 — lead screens
`/sales/leads/new` and `/sales/leads/[id]`. All 8 exports of
`sales-leads.ts` now have callers; five had none.

### check:links budget 10 → 8

## v1.45.0-alpha — six batches in one run

🔴 SQL: yes. `0081_audit_hash_chain.sql`.
🔴 ORDER: run the SQL FIRST, then push the code. This is the OPPOSITE of
0079 and 0080. The new writer inserts columns that raise 42703 on an
unmigrated database, and `writeAudit`'s catch would swallow it — silently
turning the audit trail off, which is the exact defect this hardens.

### Three-way match was matching across purchase orders
`runThreeWayMatch` joined bill lines to order lines on `lower(description)`
tenant-wide, with no `po_id`. Now a LATERAL join restricted to the bill's
own order, one row per bill line. A bill with no `po_id` returns
`no_order` rather than a verdict about an order it never named.

Also: `recomputeOrderStatus` compared totals across all lines, so an
over-delivery on one line masked a shortfall on another.

### Batch 57 — CSV import, the first data import of any kind
Generic framework, two entities, own parser (BOM, CRLF, quoted newlines).
Preview and commit share one code path with the mode branch below every
decision. Failed rows download as a valid re-uploadable CSV.

### Batch 65 — cash flow statement, indirect method
Closing cash computed twice by two routes sharing no ledger. When they
disagree it renders NO figure, including the true closing balance.

### Statements now filter transaction status: posted + reversed
🔴 "Posted only" would keep every correction and drop everything
corrected, leaving turnover permanently lower in a statement that still
balances.

### Batch 42 — platform staff console
`grantPlatformStaff`/`revokePlatformStaff` had zero callers; every grant
was hand-written SQL.

### Batch 44 — audit hash chaining (SQL 0081)
### Batch 107 — employee self-service

### check:guards TIER2 list gained `guardImport`
The list was incomplete, not the code.
