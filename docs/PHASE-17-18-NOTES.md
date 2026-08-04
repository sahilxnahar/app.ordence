# Phases 17 & 18 — The Super Admin Console

Version: v0.14.0-alpha

> ⚠️ **This phase is NOT usable until the "INTEGRATION REQUIRED" section at the
> bottom is applied.** In particular, step 1 is a **blocker**: `withPlatformScope()`
> as currently written in `db/index.ts` reads **zero rows from every tenant-scoped
> table**, so the console renders empty pages. That is a pre-existing bug this
> phase found, not one it introduced — see §6. Everything fails closed, so nothing
> leaks in the meantime.

---

## 1. What was built

| File | What it is |
|---|---|
| `db/schema/platform.ts` | Five tables: `platform_staff`, `platform_impersonation_sessions`, `tenant_support_consents`, `platform_tenant_flags`, `platform_action_log`. |
| `lib/platform/roles.ts` | The two-key staff model, the grade → capability matrix, the env allowlist parser, step-up freshness. Pure. |
| `lib/platform/impersonation-policy.ts` | Consent model, session lengths, scope ceilings, the forbidden-operation deny-list, liveness. Pure. |
| `lib/platform/search-scopes.ts` | The cross-tenant search allow-list, query bounds, the search-term masker. Pure. |
| `lib/platform/flags-catalog.ts` | Closed flag catalogue; the "flags are not entitlements" boundary. Pure. |
| `lib/platform/health.ts` | Tenant health scoring and console display helpers. Pure. |
| `lib/platform/schemas.ts` | Zod for every console input. Lives here because `"use server"` files may only export async functions. |
| `server/platform/guard.ts` | `requirePlatformAdmin()`, `requireCapability()`, step-up, `recordPlatformAudit()`. |
| `server/platform/tenants.ts` | Directory, detail, health, suspend, reactivate. |
| `server/platform/impersonation.ts` | Start / stop / resolve / sweep, session binding, the operation gate. |
| `server/platform/search.ts` | Audited cross-tenant search, per-operator budget, the access log reader. |
| `server/platform/flags.ts` | Platform-side writes, tenant-side reads. |
| `server/platform/consent.ts` | **Runs as the customer**, not as platform staff. |
| `server/platform/staff.ts` | Grant / revoke / list platform access. |
| `server/platform/actions.ts` | `"use server"` wrappers. Thin; every one delegates to a gated implementation. |
| `app/platform/**` | Layout + banner slot, directory, tenant detail, search, staff access. |
| `components/platform/**` | Impersonation banner, danger dialog, tenant table, tenant actions, search client, flag editor. |
| `SQL-FILES/0014_phase17_platform.sql` | 9 sections, 15 numbered verification checks. |
| `tests/security/platform-isolation.test.ts` | 48 assertions against real PostgreSQL as `ameya_app`. |
| `tests/ui/platform-admin.test.tsx` | 74 assertions: policy, schemas, health, and the three UI safety controls. |

No new dependencies.

---

## 2. Who counts as platform staff

### The answer: two independent keys, **both** required

```
KEY 1  the caller's Clerk-VERIFIED primary email ∈ PLATFORM_ADMIN_EMAILS
KEY 2  an active, unexpired row in platform_staff for their Clerk user id
```

Neither alone. The reasoning is written out at length in `lib/platform/roles.ts`;
the short version is that the three candidates already in the codebase each fail
differently:

- **`users.role = 'platform_super_admin'`** — a row in a **tenant-scoped** table,
  inside a customer's own workspace, written by tenant-facing code. It already
  means something narrower and useful (`lib/billing/seats.ts`: our staff sitting
  in a customer workspace do not consume a seat the customer paid for). **This
  phase grants it nothing in the console**, deliberately: cross-tenant access
  must not be a property of a row inside one customer's tenant.
- **`PLATFORM_ADMIN_EMAILS`** — strong where the database is weak (changing it
  needs a reviewed commit and production env access, so a database compromise
  cannot add a name). Useless where the database is strong: it cannot be revoked
  at 03:00 without a deploy, cannot express expiry or grade, and keys on an
  email address, which is a label rather than an identity.
- **The Clerk session claim `sessionClaims.metadata.platformAdmin`** — used by
  `middleware.ts` to route `/platform(.*)`. That is fine as a **routing**
  decision. It must never be the **authorisation** decision (see §3 below).

The asymmetry is the design: **granting** access needs a config deploy *and* a
database grant; **revoking** it needs either one. The cheap operation is the safe
one.

`platform_staff` also carries a grade — `support` / `engineer` / `owner` — because
"platform staff" is not one job. The support rota is the largest group and the
most phished, and it cannot suspend a workspace, cannot break-glass, and cannot
grant staff.

### Can a tenant admin promote themselves into platform staff today?

**Through the application: no.** Verified by reading every write path:

- `server/actions/team.ts` → `ASSIGNABLE_ROLES` (in `lib/validators/team.ts`)
  excludes `platform_super_admin`, so the Zod enum rejects it outright. Three
  further rules apply: nobody may grant a role they do not hold, nobody may
  change their own role, the last owner cannot be demoted.
- `app/api/webhooks/clerk/route.ts` → `mapClerkRole()` maps only
  `org:admin` / `org:owner` / `org:member`, defaulting **unknown roles to
  `read_only`**. A Clerk org role of `org:platform_super_admin` would be
  least-privilege, not most.
- No other code path writes `users.role`.

**Two caveats worth writing down.**

1. ⚠️ **The middleware claim may be self-service, depending on Clerk config.**
   `middleware.ts` gates `/platform(.*)` on
   `sessionClaims.metadata.platformAdmin === true`. Whether that is forgeable
   depends entirely on the Clerk **JWT template**: `{{user.public_metadata}}` is
   writable only with the backend secret key, but `{{user.unsafe_metadata}}` is
   writable by the signed-in user **from the browser**. If the template ever maps
   the latter, *any* authenticated user reaches the console route with one
   client-side API call. **Verify the template** — INTEGRATION step 4.
   This phase makes reaching the route worth nothing: `requirePlatformAdmin()`
   re-decides from the two keys and ignores the claim entirely.

2. ⚠️ **Server actions are not behind the route matcher at all.** A `"use server"`
   export is a POST to whatever page URL the browser is on, with a stable action
   id extractable from the client bundle. `middleware.ts`'s `/platform(.*)`
   matcher does not cover it. That is why the gate is on every function in
   `server/platform/**` rather than at the route boundary — and it is why a
   future phase must not "simplify" by trusting the layout.

Even so, note the residual: `users.role` is one careless `users:update` code path
away from being writable. That is why nothing in the console reads it.

---

## 3. Impersonation: the consent model, and the argument for it

### The problem, stated honestly

The rule everybody agrees with — never enter a customer's workspace without
permission — collides with the situation that generates the need: something is
broken, it is 03:00 in their timezone, and nobody will answer for nine hours.

### The three models

| Model | Verdict |
|---|---|
| **Per-incident consent only.** Purest. | **Rejected.** It fails exactly when support matters most, and — the part that matters — it does not prevent access, it *moves* it. An engineer locked out of the console at 03:00 opens a database client instead: no banner, no expiry, no forbidden-action list, no audit row naming them. A control people route around during incidents makes the system *less* observable. |
| **Standing consent only**, signed once at contract time. | **Rejected.** Operationally painless and quietly the worst option: a checkbox agreed to in 2024 by an employee who has since left becomes permanent, unreviewed access. Consent in name only. |
| ⭐ **Both, plus a narrower break-glass.** | **Chosen.** |

### The chosen model, and the one-sentence argument

> **The customer's inability to answer should REDUCE what we may do, not increase it.**

Everywhere else, "we could not reach anyone" is used to justify more latitude.
That is backwards. Consent is what converts a look into an *agreed* look; without
it the only defensible position is that we may **diagnose** and may not **change**.

| Mode | Scope | TTL | Requires |
|---|---|---|---|
| `standing_consent` | read **and write** | 60 min | A consent row granted by a tenant **owner**, expires in 90 days, revocable instantly, visible in their own settings. |
| `incident_consent` | read **and write** | 60 min | A consent row granted by a tenant owner or admin for one incident; the approval itself expires in 60 minutes if unused. |
| `break_glass` | ⭐ **READ-ONLY** | 15 min | `engineer` grade, ≥20-character justification, **out-of-band email to the workspace owners**, a `critical` audit row in the customer's own log, and a `security_events` row. |

Break-glass therefore buys the ability to **look**, urgently, with your name on it
and the customer told within seconds. It never buys the ability to change
anything. Every change still requires a human at the customer to have said yes,
which is the property that made the rule worth having.

Three details that make it hold rather than merely sound good:

- **Break-glass is REFUSED when usable consent exists.** Otherwise an operator
  could select it to skip the consent lookup, and the emergency mode becomes the
  default path — with the tenant notified for every routine ticket until they
  stop reading the emails.
- **`break_glass ⇒ read_only` is a CHECK constraint** (`breakglass_is_read_only`),
  not a TypeScript branch. A bug in `resolveScope()` cannot widen it.
- **Consent is re-read from the database at session start**, so a revocation
  takes effect immediately for anything new. It does not kill a running session —
  see the note in `server/platform/consent.ts` — but the running session expires
  within the hour, and the customer can see it and its end time.

### The other four requirements

- **Time-limited, and the clock is the authority.** Liveness is
  `now() < expires_at AND ended_at IS NULL`, evaluated on every use. Nothing
  depends on the sweeper, because a sweeper that stops running must not silently
  extend everyone's access. A 60-minute ceiling is also a CHECK constraint.
- **Attributable to the real human AND flagged.** Every audit row carries the
  operator's real Clerk id and email in the actor columns **and** the session id
  in `audit_logs.impersonation_id`. Both, not either: the actor answers "who",
  the flag answers "were they wearing somebody else's face". A trail recording
  only the customer's user blames the customer for our actions.
- **Visually unmistakable.** Non-dismissible banner; names the workspace in the
  largest text; states the scope in words; counts down from `expires_at` (never a
  decrementing timer, which drifts when the tab is backgrounded); break-glass is
  a different colour with an extra warning line.
- **No cookie.** The active session is looked up from the database by the
  operator's Clerk id. A cookie saying "you are impersonating Acme" *is* a
  credential — steal it, replay it, you are inside Acme. This also makes
  revocation immediate.

Plus **session binding**: the originating IP is recorded and re-checked on every
use; a mismatch **terminates** the session and writes a `critical` security event.
(User-agent is recorded but does not terminate — browsers rewrite it on update,
and locking an operator out mid-incident because Chrome patched itself is a real
cost for a very weak signal.)

---

## 4. What impersonation is forbidden from doing

The list is in `lib/platform/impersonation-policy.ts` with a per-entry reason.
The test used to build it:

1. Can the customer **undo** it themselves? If not, forbid it.
2. Does it **outlive the session**? If so, forbid it.
3. Would they be **surprised and angry** to discover it? If so, forbid it.

| Forbidden | Why |
|---|---|
| ⭐ `roles:*`, `users:invite`, `users:update`, `users:remove`, `apikeys:*`, `portal:create`, `integrations:*` | **The most important group.** All of them outlive the session. An impersonator who can mint a `tenant_owner` or invite an account they control has converted a 60-minute window into permanent access, and nothing in the expiry mechanism would notice. |
| `delete:*` | The customer cannot undo it and, uniquely, cannot even *detect* it — a deleted contact leaves no trace in their UI. |
| `periods:close`, `periods:reopen` | An attestation only the customer may make; reopening rewrites signed-off financial history. |
| `billing:*`, `payment:*`, `subscription:*` | Money the customer never sanctioned. Also protects us: an impersonated upgrade is indistinguishable from fraud. |
| `export:*` | Otherwise support becomes an exfiltration channel wearing the customer's face. |
| `support:consent*` | Otherwise the consent model is circular: enter under break-glass, write yourself a standing consent, re-enter with write access. |
| `settings:security` | MFA and session policy changes weaken the controls protecting the customer. |

**Enforcement, and an honest statement of where it currently is:**

- `assertImpersonationAllows(operation)` — the gate. Fully implemented. ⚠️ **Its
  call sites do not exist yet**, because this phase does not own
  `server/actions/**`. See INTEGRATION step 3.
- ⭐ **The DELETE guard is in the database** (`refuse_delete_under_impersonation`,
  Section 5 of 0014), on 19 tables covering customer records, financial history,
  money and access. Deletion is the one forbidden operation the customer cannot
  detect, so it gets an enforcement point no application refactor can forget.
  ⚠️ It is **armed but inert** until INTEGRATION step 2 sets
  `app.impersonation_id`. Tested by setting the GUC manually.
- The write classifier **fails closed**: any verb not positively recognised as a
  read counts as a write, so a new action added next year is refused under
  break-glass until somebody classifies it.

---

## 5. The line on cross-tenant data visibility

> **Platform records: yes, audited. Customer content: never, at any grade.**

| Visible (audited, justified, bounded) | Not visible without consented impersonation |
|---|---|
| Tenant metadata: name, slug, plan, status, seats, storage, dates | Contacts, companies, deals, custom object values |
| Workspace **user** identities: email, name, role, status | Documents — including **filenames** |
| Subscriptions, invoices, payment state | Contract text and versions |
| Audit and security **metadata** | Journal narrations, ledger entries |
| Document **existence** by exact id: tenant, size, timestamps | Anything a customer typed about a third party |

**The argument.** The left column is data we are the **controller** of — we
created it to bill and provision, and support cannot function without it. A
customer asking "which of our people has admin?" expects us to know.

The right column is data about **third parties who never had a relationship with
us**. Acme's client list is Acme's client list; we are a **processor**. Under DPDP,
processing it for our own convenience is processing without a basis — "it made the
ticket faster" is not a purpose. There is also a commercial argument that survives
the legal one: the first question in every enterprise security review is "can your
staff read our data?", and *"only with your recorded consent, inside a 60-minute
audited session, and never by search"* wins deals that *"yes, if they have a
reason"* loses.

**How the line is enforced — structurally, in three places:**

1. **No query builder.** Each search scope is a hand-written query over a
   hand-written column list. You cannot search a table nobody wrote a function
   for; adding one is a visible diff.
2. **The result type cannot carry content.** `SearchResult` has no `content`,
   `body` or `fields` bag. Returning a contact's notes requires changing the type
   first, in a diff that says so.
3. ⭐ **The database refuses it.** Section 6 of `0014` grants the platform read
   scope **per table**: `tenants`, `users`, `subscriptions`, `invoices`,
   `documents` — and *deliberately not* `contacts`, `companies`, `deals`,
   `custom_object_records`, `assets`, `contracts`, `contract_versions`,
   `journal_entries`, `transactions`, `ledgers`. A platform operator at any
   grade, with a fully working platform connection and any TypeScript bug you
   like, reads **zero rows** from a customer's contact list. Asserted in Check 14
   and in `tests/security/platform-isolation.test.ts`.

**Bounds on the search itself:** mandatory justification (≥15 chars) written into
the log **before** results are returned; prefix-only on names, **exact-only** on
emails/identifiers; hard cap of 50 with **no pagination past it** (fifty at a
time, repeated, is the customer directory); 200 searches per operator per hour,
with the refusal itself recorded; the search term is **masked** before logging,
because a verbatim search log is itself an unbounded customer directory.

The search audit path is the one place in this codebase that **throws** if the
audit write fails. Everywhere else `writeAudit()` never throws, deliberately. For
a cross-tenant read, an unrecorded access is not a degraded outcome — it is the
outcome the whole design exists to prevent.

---

## 6. ⚠️ A pre-existing bug this phase found: `withPlatformScope()` does not work

`db/index.ts` documents `withPlatformScope()` as "the escape hatch for genuine
platform-wide operations (super-admin tooling, cross-tenant billing rollups)".
**It is not one.** It runs on the ordinary `db` client with no tenant context, so
`app_current_tenant_id()` returns NULL, and every tenant policy is a plain
equality:

```sql
USING (tenant_id = app_current_tenant_id())   -- tenant_id = NULL → NULL → not TRUE
```

Verified against PostgreSQL 16 as `ameya_app`, with data present:

```
SELECT count(*) FROM tenants;        -> 0
SELECT count(*) FROM users;          -> 0
SELECT count(*) FROM subscriptions;  -> 0
```

It fails **closed**, which is why nothing has leaked and why nobody noticed — but
the hatch has never opened. (The `OR (tenant_id IS NULL AND
app_current_tenant_id() IS NULL)` clauses on `payment_events` and
`security_events` are the exception that proves it: they were added so platform
tooling could read **orphan** rows, and they grant nothing else.)

**Any Phase 11–16 code relying on it for a cross-tenant rollup is silently
returning empty results.** Worth grepping for.

**The obvious fix is refused.** Adding `OR app_current_tenant_id() IS NULL` to the
tenant policies would make the console work in one line — and would turn the most
valuable property in this codebase (*"no context means zero rows, never all rows"*,
`db/index.ts`) into *"no context means all rows"*. One missed `withTenant()` would
become a full breach instead of an empty page.

**The fix applied** is an explicit, positive, transaction-local marker
(`app.platform_scope`) that a caller must deliberately set — exactly as
`app.current_tenant_id` is deliberately set — granted **per table**. Absence still
means no access. See INTEGRATION step 1 for the three lines that activate it.

---

## 7. Suspension

One column changes: `tenants.status → 'suspended'`. That is the whole mechanism,
deliberately the smallest possible one, and it is consistent with
`lib/billing/access-state.ts`, which already maps `tenantStatus === "suspended"`
to `locked` — and `locked` still returns `canExport: true`.

So a suspended customer can sign in, reach billing, and download everything they
own. They simply cannot use the product. **Nothing is deleted, and there is no
`deleteData` option anywhere in the schema** (asserted in the UI test).

**Reversal restores the status the tenant *had*,** read back from the append-only
audit row written at suspension time. Blindly setting `active` would silently
complete the onboarding of a tenant that was `pending` — a workspace that was
never finished becoming live, quietly becoming live. Because `audit_logs` is
append-only, the record of what to restore cannot be edited by whoever later
performs the restore.

The tenant detail page shows the customer's access state computed by the **same**
`evaluateAccess()` their own banner calls. A console with its own idea of what a
customer can do turns every support call into two people describing different
systems.

---

## 8. Making the console useless to a stolen session

| Control | Status |
|---|---|
| Two keys — a stolen session gives neither | ✅ done |
| Grade separation — a phished `support` account cannot suspend, break-glass or grant staff | ✅ done |
| Impersonation state in the database, not a cookie | ✅ done |
| IP binding — a replayed session from another network is **terminated**, not just logged | ✅ done |
| Short TTLs, hard 60-minute ceiling in a CHECK constraint | ✅ done |
| One live session per operator | ✅ done |
| Out-of-band notification the thief cannot suppress | ✅ done |
| Typed-slug confirmation + mandatory justification on every dangerous action | ✅ done |
| ⚠️ **Re-authentication (step-up)** | ⚠️ **partial — see below** |

### The honest caveat on step-up

`requireStepUp()` gates `tenants:suspend`, both impersonation capabilities,
`staff:manage` and `flags:write`. It has two behaviours:

- **Clerk `fva` claim present** → cryptographic. A second factor older than 15
  minutes is refused. This is the real control.
- **`fva` absent** → falls back to `platform_staff.last_step_up_at`, which records
  that somebody clicked "confirm" — something an attacker holding the session can
  also do. **It is a speed bump, not a control**, and every use writes a
  `warning` audit row saying exactly that.

Closing it needs the Clerk JWT template (and possibly `middleware.ts`), neither of
which this phase owns — INTEGRATION step 4. It is written down rather than quietly
shipped because a security control everyone believes exists is worse than one
everyone knows is missing.

---

## 9. Where the audit trail lives, and why it is (slightly) split

**The rule is mechanical, which is why it will not drift:**

```
has a tenant it belongs to  →  audit_logs          (the CUSTOMER can see it)
belongs to no tenant        →  platform_action_log  (platform only)
```

Nothing is written to both. Suspension, reactivation, impersonation start/stop,
tenant detail reads and flag changes all go into `audit_logs` **with the tenant's
id**, so they appear in the customer's own audit view — everything we do *to* a
tenant should be something they can see us doing.

The residue — a directory search that spans every tenant and belongs to none, a
staff grant, a capability denial — cannot go into `audit_logs`, and that is a fact
about the existing policy rather than a preference. The Phase 1 policy is
`WITH CHECK (tenant_id = app_current_tenant_id())`, so a NULL-tenant insert
evaluates `NULL = NULL` → NULL → not true. Verified as `ameya_app`:

```
INSERT INTO audit_logs (tenant_id, ...) VALUES (NULL, ...)
  →  ERROR: new row violates row-level security policy for table "audit_logs"
```

`platform_action_log` is append-only (trigger **and** no GRANT), for the same
reason `security_events` is: a DELETE privilege on it is functionally an "erase
the record of what I looked at" privilege, and the people with access to it are
the people it is about.

**If you would rather have one table**, the alternative is in INTEGRATION step 8.

---

## 10. Things that worry me

1. ⭐ **The `audit_logs` write path is broken platform-wide. VERIFIED, not
   suspected.** `writeAudit()`, `writeSystemAudit()` and `recordDenial()` in
   `server/audit.ts` all use the plain `db` client with **no tenant context** and
   a real `tenant_id`. That is the same RLS `WITH CHECK` failure as §6, in the
   other direction. Reproduced against PostgreSQL 16 as `ameya_app`:

   ```
   -- exactly what writeAudit() issues: no context, real tenant id
   INSERT INTO audit_logs (tenant_id, action, resource_type)
   VALUES ('<a real tenant uuid>', 'read', 'probe');
   →  ERROR: new row violates row-level security policy for table "audit_logs"
   ```

   And `writeAudit()` **never throws** — by design, so an audit failure cannot
   roll back a user's work — so this fails **completely silently** except for one
   `[AUDIT WRITE FAILED]` line on stderr. If the deployed database has RLS applied
   (it should; `db:verify` checks it), **the platform's entire audit trail and
   permission-denial log are empty in production.**

   Not my file to fix, but the fix is one line each — see INTEGRATION step 13.
   **Check this before anything else in this document**; it undermines Phase 5,
   Phase 20 and every compliance claim built on them, and this phase's own
   tenant-attributed rows are the only ones currently written correctly (they go
   through `withTenant()`).
2. **`app.impersonation_id` is set by nothing**, so the database DELETE guard —
   the strongest control in this phase — is inert until step 2.
3. **`ALL-IN-ONE-SETUP.sql` will revert Section 6** if it is run after `0014`,
   because it re-creates `tenant_self_isolation` and friends without the platform
   clause. The console would go blank (fail closed). Ordering matters — step 7.
4. **Consent revocation does not kill a running session.** Bounded to ≤60 minutes
   and visible to the customer, but it is a real gap and it is a deliberate one
   (the alternative is letting a tenant connection write the platform's evidence
   table).
5. **Step-up is theatre without `fva`.** Stated above, repeated here.
6. **Impersonation has no tenant-side effect yet.** The session exists, expires
   and is audited, but `requireTenantContext()` does not consult it, so the
   operator does not actually *see* the customer's workspace. Step 5.

---

# INTEGRATION REQUIRED

Everything below is in a file this phase does not own. Nothing here works until
these are applied. Ordered by how badly it is needed.

### 1. ⭐ BLOCKER — `db/index.ts`: make `withPlatformScope()` actually scope

Replace the body. It must run in a **transaction** and pin the marker
transaction-locally, for exactly the reasons the `withTenant()` comment already
gives (session-level `set_config` leaks across pooled connections; outside a
transaction the setting is discarded immediately).

```ts
export async function withPlatformScope<T>(
  reason: string,
  callback: (
    database: Parameters<Parameters<typeof withTenant>[1]>[0],
  ) => Promise<T>,
): Promise<T> {
  if (!reason || reason.length < 10) {
    throw new Error("[SECURITY] withPlatformScope() requires a written justification.");
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[PLATFORM SCOPE] Bypassing tenant isolation: ${reason}`);
  }

  const { DATABASE_URL } = getServerEnv();
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const database = drizzleServerless(pool, { schema });
    return await database.transaction(async (tx) => {
      // Transaction-local, exactly like app.current_tenant_id. Discarded at
      // COMMIT, so the connection returns to the pool with no platform scope.
      await tx.execute(sql`SELECT set_config('app.platform_scope', 'on', true)`);
      return callback(tx);
    });
  } finally {
    await pool.end();
  }
}
```

Note the **signature change**: the callback now receives a transaction handle
rather than `Database`. Every call site in `server/platform/**` derives its
parameter type from `withPlatformScope` itself
(`Parameters<Parameters<typeof withPlatformScope>[1]>[0]`), so they adapt with no
edit. Grep for other callers before merging.

### 2. `db/index.ts`: let `withTenant()` carry the impersonation id

Arms the database DELETE guard (Section 5 of `0014`).

```ts
export async function withTenant<T>(
  tenantId: string,
  callback: (tx: /* … */) => Promise<T>,
  options: { impersonationId?: string | null } = {},   // ← new
): Promise<T> {
  // … inside the transaction, after the tenant set_config:
  if (options.impersonationId) {
    await tx.execute(
      sql`SELECT set_config('app.impersonation_id', ${options.impersonationId}, true)`,
    );
  }
  // …
}
```

### 3. `db/schema/index.ts`: export the new schema

```ts
// Platform console — staff, impersonation evidence, consent, flags (Phases 17–18)
export * from "./platform";
```

Then `npx drizzle-kit push` to create the five tables and six enums, **then run
`SQL-FILES/0014_phase17_platform.sql`** — RLS, the tamper triggers, the DELETE
guard, the platform read scope, the constraints and the grants are all in there
and none of them are created by `push`.

### 4. Clerk: the JWT template, for both the routing claim and step-up

- **Verify** the session token template maps `{{user.public_metadata}}`, **never**
  `{{user.unsafe_metadata}}`, into `metadata`. If it maps unsafe metadata, any
  signed-in user can set `platformAdmin: true` from the browser and reach
  `/platform`. (They get nothing there — but they should not get there.)
- **Add `fva`** to the session token so `assertStepUpFresh()` can be
  cryptographic instead of advisory. Until then every dangerous action writes a
  `warning` audit row saying the step-up was not verified.

### 5. `server/tenant-context.ts`: honour an active impersonation

Currently a platform operator has no `orgId`, so `requireTenantContext()` throws
and the operator cannot actually see the customer's workspace. Suggested shape —
**note it must fail closed and must never widen an ordinary user's context**:

```ts
import { getActiveImpersonation } from "@/server/platform/impersonation";

export async function requireTenantContext(): Promise<TenantContext> {
  const { userId, orgId } = await auth();
  if (!userId) throw new TenantAccessError("No authenticated session.", "unauthenticated");

  // ⚠️ ONLY when there is a LIVE session for THIS Clerk user. Returns null for
  // every ordinary request, so the existing path is untouched.
  if (!orgId) {
    const active = await getActiveImpersonation();
    if (active) return buildImpersonatedContext(active);   // role: read_only-ish
    throw new TenantAccessError("No active organization selected.", "no_organization");
  }
  // … existing path unchanged …
}
```

The impersonated context must set `impersonationId` so `writeAudit()` can stamp
it, and must pass it to `withTenant(..., { impersonationId })`.

### 6. `server/audit.ts`: stamp the impersonation id

`writeAudit()` already accepts everything else it needs. Add:

```ts
impersonationId: (ctx as { impersonationId?: string }).impersonationId ?? null,
```

Without this, actions taken under impersonation are attributed to the real human
(good) but **not flagged as impersonated** (bad) — a reviewer cannot tell an
operator's action apart from a customer's.

### 7. `server/actions/**`: call the operation gate

At the top of every mutating action, after the permission check:

```ts
import { assertImpersonationAllows } from "@/server/platform/impersonation";

export async function deleteContact(id: string) {
  const ctx = await requirePermission("contacts:delete");
  await assertImpersonationAllows("delete:contact");   // ← no-op when not impersonating
  // …
}
```

The operation string is `namespace:verb` and must match the prefixes in
`FORBIDDEN_UNDER_IMPERSONATION`. It returns silently when nobody is impersonating,
so it is safe to call unconditionally. Also catch `ImpersonationForbiddenError`
in each action's `toActionError()` so the operator sees the real reason.

### 8. `SQL-FILES/ALL-IN-ONE-SETUP.sql`: append `0014`, and mind the order

⚠️ **`0014` re-creates the policies on `tenants`, `users`, `subscriptions`,
`invoices` and `documents`** to add the platform read clause. If ALL-IN-ONE is run
*after* `0014`, it reverts them and the console goes blank (fail closed, no leak).
Append `0014` **last**, or fold Section 6 into the ALL-IN-ONE policy definitions.

### 9. Optional — one audit table instead of two

If you would rather not have `platform_action_log`, widen the Phase 1 policy with
the same NULL allowance `payment_events` already carries, and change
`recordPlatformAudit()` to insert `tenant_id = NULL` rows into `audit_logs`:

```sql
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  );
```

This is a change to a Phase 1 policy, so it belongs to whoever owns
`0001_rls_and_audit_guard.sql` and `ALL-IN-ONE-SETUP.sql`. It is written out here
rather than applied.

### 10. `app/(crm)/settings/`: the customer-facing consent page

`server/platform/consent.ts` provides `grantSupportConsent()`,
`revokeSupportConsent()` and `getSupportConsentState()`, and
`server/platform/actions.ts` already exports thin `"use server"` wrappers. What is
missing is a settings tab that:

- shows whether support access is currently granted, by whom, and until when;
- lets an **owner** turn standing consent on/off and an **owner or admin** grant
  incident consent;
- lists past impersonation sessions (the RLS policy lets the tenant read its own).

That last one is the highest-value item in this list for enterprise sales.

### 11. `app/api/workers/route.ts`: schedule the sweeper

```ts
import { sweepExpiredImpersonations } from "@/server/platform/impersonation";
// hourly
const closed = await sweepExpiredImpersonations();
```

⚠️ **This does not expire anything** — those sessions ended the moment the clock
passed `expires_at`. It only writes down *why*, so the console shows "expired"
instead of an open row that is not open. If it never runs, nothing is less safe.

### 12. `scripts/verify-security.ts`: add the platform checks

Mirror Checks 3, 6, 13 and 14 from `0014` §9 — in particular:

- `tenant_support_consents` `WITH CHECK` does **not** admit a NULL context
  (the platform cannot manufacture consent);
- `ameya_app` holds no `DELETE` on `platform_impersonation_sessions` or
  `platform_action_log`;
- no customer-content table has `app_platform_scope` in its policy.

### 13. ⭐ `server/audit.ts`: the audit trail is currently being silently discarded

See §10.1 — verified, not theoretical. `writeAudit()`, `writeSystemAudit()` and
`recordDenial()` all INSERT a real `tenant_id` from a connection with **no tenant
context**, which RLS refuses. Because `writeAudit()` swallows its error, nothing
surfaces.

The fix is to write in the tenant's own context, which is where those rows belong:

```ts
// server/audit.ts — writeAudit()
import { withTenant } from "@/db";

await withTenant(ctx.tenant.id, async (tx) => {
  await tx.insert(auditLogs).values({ /* … unchanged … */ });
});
```

Same change in `writeSystemAudit(tenantId, …)` and in `recordDenial()` (which
writes `permission_denials`, under an identical policy). `server/platform/guard.ts`
already does exactly this and can be used as the reference.

⚠️ Do **not** "fix" it by widening the `audit_logs` policy to admit a NULL
context — that would let any context-less connection write into any tenant's audit
log, which is strictly worse than losing the rows.

**Suggested regression test** (add to `tests/security/audit-immutability.test.ts`):
an INSERT into `audit_logs` with a real `tenant_id` from `withoutTenant()` must be
refused, and the same INSERT from `asTenant()` must succeed. That asserts the
policy is doing its job *and* pins the requirement that the application writes in
context.

### 14. `CHANGELOG.md`

```
### Phases 17 & 18 — Super Admin Console (v0.14.0-alpha)
- Platform staff model: two independent keys (env allowlist + revocable DB grant).
- Consented, time-limited, read-only-by-default impersonation with append-only evidence.
- Break-glass: read-only, 15 minutes, mandatory justification, customer notified.
- Audited, bounded cross-tenant search over platform records only.
- Tenant suspension (reversible, destroys nothing) and per-tenant feature flags.
- ⚠️ FOUND: `withPlatformScope()` read zero rows from every tenant table under RLS.
  Fixed with an explicit per-table platform read scope; see docs/PHASE-17-18-NOTES.md §6.
```

---

## Verified vs written

**Executed, passing:**

- `npx tsc --noEmit` — **clean**.
- `npx vitest run --config vitest.ui.config.ts tests/ui/platform-admin.test.tsx` —
  **74 passed**. Full UI suite: **517 passed / 14 files**, no regressions.
- `psql -f SQL-FILES/0014_phase17_platform.sql` against PostgreSQL 16 — ran to
  completion, **all 15 verification checks PASS**, zero rows from every
  "no rows = pass" check. Tables were created first from a scratch DDL mirroring
  `db/schema/platform.ts` (deleted afterwards; the tables remain in `ameya_test`
  so the suite is repeatable).
- `npx vitest run tests/security/platform-isolation.test.ts` — **48 passed**.
  Full security suite: **320 passed / 13 files**, no regressions from the policy
  changes in Section 6.

**Written but NOT executed** (they cannot run without the integration above, a
Clerk session and a live database connection):

- Every function in `server/platform/**` — type-checked, never invoked at runtime.
  In particular `getPlatformOperator()` has never authenticated a real Clerk user,
  and `startImpersonation()` has never created a session through the application
  (the security test creates its fixtures in SQL).
- Every page in `app/platform/**` — type-checked, never rendered. `npm run build`
  was not run, as instructed.
- The impersonation notification email — `sendEmail()` is best-effort and
  unconfigured in this environment.

**Known incomplete:** the DELETE guard is inert until step 2; the deny-list has no
call sites until step 7; step-up is advisory until step 4; impersonation has no
tenant-side effect until step 5; there is no customer-facing consent UI (step 10).
