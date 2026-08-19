# Phase 29 — Turning On The Super Admin Console

Version: v0.29.0-alpha
Audience: **anyone**. No programming knowledge is assumed. Where a command
has to be typed, it is written out in full and you can copy it exactly.

---

## What this is, in one paragraph

The Super Admin Console is the screen your own staff use to support a
customer: to see which workspaces exist, whether they are healthy, what
they pay, whether their last invoice was paid, and — with the customer's
recorded permission — to step inside their workspace for up to an hour to
diagnose a problem. Until now that screen was half-built, and the only way
to help a customer was for an engineer to open the database by hand. This
guide switches the finished console on.

**Read this before anything else:** the console deliberately **cannot**
show your staff a customer's own records — their contacts, their deals,
their documents, their contract text. That is not a setting you can turn
on. The database refuses it. Seeing a customer's records requires the
customer to have said yes, in writing, in their own account, and even then
it lasts an hour and every action is recorded with your staff member's
name on it. If somebody asks you to "just give support access to
everything", the honest answer is that the product is built so that
nobody can.

---

## Before you start, collect these three things

1. **Access to the Clerk dashboard** for this product (Clerk is what
   handles signing in). You need to be able to change settings, not just
   look at them.
2. **Access to wherever the application's environment variables are set** —
   on Vercel this is Project → Settings → Environment Variables.
3. **Someone who can run a database command.** Step 4 is one command. If
   nobody can run it, stop and find that person before starting; the
   console will not work without it.

Set aside about thirty minutes. Nothing in this guide deletes anything or
takes the product offline.

---

## Step 1 — Check the Clerk session token (THE MOST IMPORTANT STEP)

### Why this matters

Clerk gives every signed-in person a small signed pass, called a *session
token*, which the application reads. It can carry extra facts about the
person. There are two places those facts can come from and **they are not
the same**:

| Where the fact lives | Who can change it |
|---|---|
| `public_metadata` | **Only you**, from the Clerk dashboard or with the secret key |
| `unsafe_metadata` | **The signed-in person themselves, from their own browser** |

The application's front door checks a fact called `platformAdmin` to
decide whether to show someone the `/platform` address at all. If that
fact is taken from `unsafe_metadata`, then **any customer who signs up can
set it on themselves** and reach the console's front door. (They would
still get nothing once inside — the console re-checks everything from
scratch and would refuse them — but they should not get to the door at
all, and you should not have to rely on the second lock.)

### What to do

1. Open the **Clerk dashboard** and choose this application.
2. In the left menu go to **Configure → Sessions**.
3. Find the panel called **Customize session token**. Click **Edit** on
   the **Claims** editor.
4. Look at what is written there. You are looking for a line mentioning
   `metadata`.

**If the editor is empty, or has no `metadata` line, paste exactly this:**

```json
{
  "metadata": "{{user.public_metadata}}"
}
```

**If a `metadata` line already exists, check the right-hand side of it.**

| What you see | What it means | What to do |
|---|---|---|
| `"metadata": "{{user.public_metadata}}"` | ✅ Correct | Change nothing |
| `"metadata": "{{user.unsafe_metadata}}"` | 🔴 **Security problem** | Replace `unsafe_metadata` with `public_metadata` and save immediately |
| Something else entirely | Unclear | Do not guess. Show this page to whoever maintains the application |

5. Click **Save**.

> ⚠️ The words are one character apart in meaning and worlds apart in
> effect. `public` means "the public can READ it, only we can WRITE it".
> `unsafe` means "the user can write it from their browser". You want
> `public_metadata`. Always.

### The second half of this step: the `fva` claim

The console asks a staff member to re-confirm their identity before
anything dangerous (suspending a customer, entering a workspace, granting
another staff member access). For that check to be real rather than
decorative, the session token must carry a claim called **`fva`** —
"factor verification age", i.e. how many minutes ago they last proved who
they were with a second factor.

**In current versions of Clerk, `fva` is included automatically** and
there is nothing to do. To confirm:

1. Still on **Configure → Sessions**, look for a note listing the default
   claims in the session token. `fva` should be among them.
2. If your application uses an older, hand-written **JWT template** for
   the session token instead of the default one (Clerk dashboard →
   **Configure → JWT Templates**), open it and make sure it has not
   removed the default claims. A hand-written template that lists only
   its own claims will not contain `fva`.

**How to tell whether it is working, after you finish this guide:** ask a
staff member to suspend a test workspace. Then open the console's **Action
register** (see Step 8). If `fva` is missing, you will see a `warning`
entry saying in plain words that the identity re-check was *a click, not a
verified factor*. If `fva` is present, no such warning appears. The
console tells you the truth about its own controls either way — it does
not pretend.

---

## Step 2 — Say who your platform staff are (key 1 of 2)

Access to the console needs **two independent keys**, and one of them
lives outside the database on purpose: somebody who breaks into the
database still cannot let themselves in.

**Key 1 is a list of email addresses in the application's settings.**

1. Go to your hosting settings (on Vercel: Project → Settings →
   Environment Variables).
2. Add or edit a variable named exactly:

```
PLATFORM_ADMIN_EMAILS
```

3. Set its value to the work email addresses of your platform staff,
   separated by commas, with no spaces:

```
priya@yourcompany.com,arjun@yourcompany.com
```

4. Save, and **redeploy the application** so the change takes effect.

> Notes worth knowing:
> - The email must be one Clerk has **verified**. An unverified address is
>   just something somebody typed.
> - Removing a name from this list removes their access at the next
>   deploy. Removing their database grant (Step 6) removes it instantly.
>   Either one alone is enough to lock someone out — that asymmetry is
>   deliberate: **granting** access is hard, **revoking** it is easy.

---

## Step 3 — Mark those people in Clerk so the console appears

For each of the staff members from Step 2:

1. In the Clerk dashboard go to **Users** and click the person.
2. Open the **Metadata** tab.
3. In **Public metadata** (not *unsafe*, not *private*), paste exactly:

```json
{
  "platformAdmin": true
}
```

If there is already something in that box, add the line without deleting
what is there. For example:

```json
{
  "existingThing": "leave this alone",
  "platformAdmin": true
}
```

4. Save.
5. Ask them to sign out and sign in again, so they get a fresh pass.

> This only decides whether the console's address is reachable. It grants
> nothing. Both keys from Steps 2 and 6 are still required.

---

## Step 4 — Run the database file

This creates the indexes the new screens need, adds one safety rule, and
then **prints a report** telling you whether every protection is in place.

Someone with database access runs, from the project folder:

```
psql "$DATABASE_URL" -f SQL-FILES/0022_phase29_admin_console.sql
```

If Phase 17's file has never been run on this database, run that one
**first**:

```
psql "$DATABASE_URL" -f SQL-FILES/0014_phase17_platform.sql
psql "$DATABASE_URL" -f SQL-FILES/0022_phase29_admin_console.sql
```

### Reading the report

The command prints a series of small tables. **Every line should say
`PASS`.** Two of the checks pass by printing *no rows at all* — they list
problems, so an empty result is the good outcome. The output ends with:

```
PASS: platform scope is off by default (fail-closed)
```

If any line contains `*** FAIL ***`, stop and show the output to whoever
maintains the application. Do not carry on and do not "try it and see" —
each of those lines is a protection that is not currently in place.

It is safe to run this file twice. It changes nothing the second time.

---

## Step 5 — Check nobody can see what they should not

Optional but strongly recommended, and it takes one command. From the
project folder:

```
npx vitest run tests/security/admin-console.test.ts
```

You should see **39 passed**. These check, against a real database, that:

- a customer cannot read the platform's own tables;
- your staff cannot read customer records through the console;
- an impersonation session with no recorded consent is refused;
- an expired session is refused even if nothing tidied it up;
- the record of what your staff did cannot be edited or deleted —
  **not even by the database owner**.

If any of them fail, the console is not safe to use yet.

---

## Step 6 — Grant your first staff member (key 2 of 2)

The console is unreachable until at least one person holds a database
grant. That is the correct state for a fresh installation: a system that
starts with an all-powerful account is a system with an all-powerful
account nobody remembers.

The very first grant has to be made in the database, because there is
nobody in the console yet to make it. Someone with database access runs
this, replacing the three values in capitals:

```
psql "$DATABASE_URL" -c "INSERT INTO platform_staff (clerk_user_id, email, display_name, grade, status, expires_at, grant_reason) VALUES ('CLERK_USER_ID_HERE', 'EMAIL_HERE', 'FULL NAME HERE', 'owner', 'active', now() + interval '90 days', 'Initial platform owner grant, approved by <name>');"
```

- **CLERK_USER_ID_HERE** — from the Clerk dashboard: Users → click the
  person → the id at the top, which looks like `user_2abc...`. It is
  **not** their email.
- **EMAIL_HERE** — the same address you put in `PLATFORM_ADMIN_EMAILS`.
- **grade** — choose one:

| Grade | Can do | Cannot do |
|---|---|---|
| `support` | See workspaces, search, enter a workspace **with the customer's consent** | Suspend a workspace, emergency access, change flags, grant staff |
| `engineer` | The above, plus emergency read-only access and feature flags | Suspend a workspace, grant staff |
| `owner` | Everything, including suspending a workspace, granting staff, and ending another operator's session | — |

Give people the smallest grade that lets them do their job. The support
rota is the largest group and the most likely to be phished; a stolen
support account costs you a consented read, a stolen owner account costs
you the platform.

Note the `expires_at` value: **90 days**. Every grant should have an end
date. That is how a contractor from two years ago stops being able to read
every customer's billing record. After the first grant, further staff can
be added from the console itself, and the console warns about any grant
with no end date.

---

## Step 7 — Sign in and look around

Go to `https://your-app-address/platform`.

If you see a **"page not found"**, one of the two keys is missing. Check
that the email is in `PLATFORM_ADMIN_EMAILS` (Step 2, and that you
redeployed), and that the database row from Step 6 exists and has not
expired. The console deliberately says nothing more specific than "not
found" — telling a stranger *why* they were refused is telling them how
close they got.

What you should see:

| Screen | What it is for |
|---|---|
| **Workspaces** | Every customer: plan, health, seats, storage, revenue. Sort by any column, search by name, page through. |
| **Sessions** | Every time one of your staff has been inside a customer's workspace — and whether anyone is inside one right now. |
| **Search** | Find a workspace, a person or an invoice across every customer. Requires a written reason, every time. |
| **Action register** | What your staff did that belongs to no single customer — searches, staff grants, refused permissions. |
| **Staff access** | Who holds console access, at what grade, until when. |

Click a workspace name to open it. You will see tabs for usage over time,
billing and invoices, the people in that workspace, security events,
feature flags, support access, and everything the platform has done to
that customer.

> ⚠️ **Opening a workspace writes a note in that customer's own audit
> log**, which they can read. That is intended. Everything you do *to* a
> customer should be something they can see you doing. Browsing the list
> writes nothing.

---

## Step 8 — Understand the four things that are dangerous

### 1. Suspending a workspace

Locks everyone in that workspace out of the product until you reverse it.
**It deletes nothing.** The customer can still sign in, reach their
billing page, and download all of their data. Reversing it restores the
status they had before, read back from a record that cannot be edited.

Requires the `owner` grade, the workspace's address typed out by hand, and
a written reason of at least twenty characters that goes into the
customer's own audit log.

### 2. Entering a workspace (impersonation)

This is the most dangerous capability in the product, and it is built to
be difficult on purpose.

- The customer must have **granted support access in their own settings**,
  in their own account. Your staff **cannot create that permission
  themselves** — the database physically refuses to let them.
- The session lasts **at most sixty minutes**, and the limit is in the
  database, not in the code. It cannot be extended afterwards.
- A bar across the top of the screen names the workspace, states whether
  it is look-only or look-and-change, and counts down. It cannot be
  dismissed.
- Your staff can never delete anything, change anybody's role, invite
  anybody, change billing, or export data — whatever the session says.
- The workspace's owners are **emailed** that somebody entered.
- Every action is recorded against the real person's name and flagged as
  having been taken while impersonating.

**Emergency access ("break-glass")** exists for when a customer cannot be
reached at 3am. It is **look-only, fifteen minutes**, requires the
`engineer` grade or higher, emails the customer immediately, and is
**refused if the customer has already granted permission** — so it cannot
become the everyday shortcut.

### 3. Ending somebody else's session

On the **Sessions** screen, an `owner` can end a live session belonging to
another staff member — for a stolen laptop, or a session that should never
have been started. It takes effect immediately. The evidence record is not
deleted or altered; only the end time and the reason are added.

### 4. Feature flags

Switching a capability on or off for one customer. Every flag needs a
written reason, and a flag that unlocks something the customer would
otherwise pay for **must** have an end date. A flag with no end date is a
private fork of the product for one customer that nobody remembers
agreeing to; the console nags about it.

---

## Step 9 — Tell your customers how to grant support access

Support access starts with the customer, not with you. There is currently
**no page in the customer's own settings** where they can turn it on — see
"What is still outstanding" below. Until that page ships, a customer's
permission has to be recorded by someone with database access, on the
customer's written instruction (an email from an owner or administrator at
the customer, kept on file):

```
psql "$DATABASE_URL" -c "INSERT INTO tenant_support_consents (tenant_id, mode, scope, granted_by_email, granted_by_role, expires_at, reference, note) VALUES ('TENANT_ID_HERE', 'incident', 'read_only', 'WHO_AT_THE_CUSTOMER_ASKED@example.com', 'tenant_owner', now() + interval '60 minutes', 'TICKET REFERENCE', 'Consent given by email, kept on file');"
```

- **mode** — `incident` for one problem (expires in an hour) or
  `standing` for an ongoing arrangement (expires in ninety days).
- **scope** — `read_only` (look, do not touch) or `read_write`.
  `read_only` is the honest default for a customer who just wants a bug
  diagnosed.
- **TENANT_ID_HERE** — copy it from the address bar when the workspace is
  open in the console.

> ⚠️ **Do not record a permission the customer did not give.** The whole
> value of this system is that "the customer agreed" is a fact somebody
> can check afterwards, with a name, a time and a reference against it.

---

## What is still outstanding, stated plainly

These are real gaps. They are written down rather than quietly omitted,
because a control everybody believes exists is worse than one everybody
knows is missing.

### A. A staff member cannot yet *see* the customer's screens

Everything about impersonation works — consent is checked, the session is
created and expires, the banner appears, the customer is emailed, every
action is recorded. But the product's own pages still refuse the operator,
because they resolve which workspace to show from the staff member's own
organisation and a platform staff member does not belong to the customer's
organisation.

Closing this is a **six-line change in one file** that Phase 29 was not
permitted to edit. The ready-made function already exists at
`server/platform/impersonation-context.ts`. Whoever maintains
`server/tenant-context.ts` needs to add, inside `requireTenantContext()`,
immediately before the line that throws `"No active organization
selected."`:

```ts
import { getImpersonatedTenantContext } from "@/server/platform/impersonation-context";

// ⚠️ Only when there is a LIVE session for THIS Clerk user. Returns null
// for every ordinary request, so the existing path is untouched.
if (!orgId) {
  const impersonated = await getImpersonatedTenantContext(requestId);
  if (impersonated) return impersonated;
  throw new TenantAccessError("No active organization selected.", "no_organization");
}
```

Two related one-line changes belong with it:

- `server/audit.ts` → `writeAudit()` should stamp
  `impersonationId: (ctx as { impersonationId?: string }).impersonationId ?? null`
  so an action taken while impersonating is *flagged* as such and not
  merely attributed.
- `db/index.ts` → `withTenant()` should accept an
  `{ impersonationId }` option and set it with
  `SELECT set_config('app.impersonation_id', $1, true)`, which arms the
  database's delete guard. Until then that guard is installed and inert.

**Until this lands:** your staff can be told a customer's plan, usage,
invoices and security events by the console, and can start a properly
consented session — but to see a customer's actual screens they still need
an engineer. Nothing is unsafe; a capability is simply missing.

### B. Customer-facing consent page

`server/platform/consent.ts` already contains everything needed
(`grantSupportConsent`, `revokeSupportConsent`, `getSupportConsentState`),
and the server actions are exported. What is missing is a tab in the
customer's own settings that shows whether support access is on, who
granted it, until when, and lists past sessions. That last list is the
single highest-value item here for enterprise sales — "here is every time
our staff entered your workspace, and why" answers the hardest question in
any security review. Until it exists, use the manual route in Step 9.

### C. The tidy-up job is not scheduled

`sweepExpiredImpersonations()` marks finished sessions as finished. ⚠️ **It
does not end anything** — sessions end when their clock runs out, whether
or not anything writes it down. If it never runs, nothing is less safe;
the history is just untidy. To schedule it, whoever owns
`app/api/workers/route.ts` adds an hourly call.

### D. Impersonation limits are not yet enforced inside the product's own actions

The list of things an impersonating operator may never do (delete records,
change roles, invite people, touch billing, export) is fully written and
enforced at the database level for deletions. Wiring it into every
individual action in `server/actions/**` — one line each,
`await assertImpersonationAllows("delete:contact")` — is still to do, and
becomes meaningful the moment (A) lands.

---

## If something goes wrong

| Symptom | Most likely cause | Fix |
|---|---|---|
| `/platform` shows "page not found" | One of the two keys missing | Re-check Steps 2, 3 and 6 — and that you redeployed after Step 2 |
| The console loads but every list is empty | The database file has not been run | Step 4 |
| "Confirm your identity to continue" and no way forward | The identity re-check has no record | Step 1's `fva` note; ask the person to sign out and in again |
| A staff member is on the list but shows "no — stale grant" | Their email was removed from `PLATFORM_ADMIN_EMAILS` | Either restore the email or revoke the database grant. Do not leave it half-removed |
| "This workspace has not given support access" | Correct behaviour, not a fault | Ask the customer for permission (Step 9), or use emergency access if this is a genuine emergency |

**To lock somebody out immediately**, at any hour, with no deploy:

```
psql "$DATABASE_URL" -c "UPDATE platform_staff SET status = 'revoked', revoked_at = now(), revoke_reason = 'REASON HERE' WHERE email = 'THEIR_EMAIL_HERE';"
```

Their next click is refused. Any session they had inside a customer's
workspace should also be ended from the **Sessions** screen by an `owner`.

---

## A short list of things that are true, which you can tell a customer

- Our staff cannot read your contacts, deals, documents or contracts from
  our admin tools. The database refuses it, at every staff level.
- Our staff can only enter your workspace if someone at your organisation
  has granted permission in your own account, and that permission expires.
- Every entry lasts at most one hour and ends automatically.
- Emergency access, for when you cannot be reached, is **look-only**, lasts
  fifteen minutes, and emails your workspace owners immediately.
- Everything we do to your workspace appears in **your own** audit log,
  not only in ours.
- The record of our staff's access cannot be edited or deleted by our
  staff — including by whoever is being asked about.
