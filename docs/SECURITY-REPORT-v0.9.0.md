# Security Report — v0.9.0-alpha

**Phase 9 — External Client Portal & Secure Approvals**
**Date:** 31 July 2026 · **Verdict: PASS**

---

## Summary

| Check | Result |
|---|---|
| TypeScript strict (`tsc --noEmit`) | **Clean** |
| Production build (`next build`) | **Clean — 28 routes** |
| Security tests (real PostgreSQL 16) | **113 / 113 passing** |
| UI & logic tests | **102 / 102 passing** |
| Tables under RLS | **25** (was 23) |
| Token entropy | **256 bits, `crypto.randomBytes`** |
| `Math.random()` in any security path | **None** |
| Raw tokens stored or logged | **None — SHA-256 only** |
| Server secrets in client bundle | **None** |
| Production dependency vulnerabilities | **0** |
| Server actions without a guard | **0 of 6 new** |

---

## The two mandatory Phase 9 verifications

### 1. Token generation uses a cryptographically secure randomiser

`tests/ui/portal-tokens.test.tsx` — **23 tests.**

A test cannot inspect which primitive a function called, so this is verified
two ways:

- **Source assertion.** The file is read, comments stripped (it *discusses*
  `Math.random()` at length), and asserted to contain no call to it, plus a
  required `randomBytes` import from `node:crypto`.
- **Property assertions.** 64 hex characters = **256 bits**; **zero
  collisions across 20,000 draws**; all 16 leading nibbles appear across
  2,000 draws within generous bounds.

Why this matters concretely: V8's `Math.random()` is xorshift128+. Given a
handful of consecutive outputs its internal state can be solved for and every
past and future output reconstructed. A client who legitimately received two
or three portal links could then derive the tokens for **every other
client's** contracts — with no brute force at all.

Verified manually as well:

```
token hex chars: 64 = 256 bits entropy
20000 draws -> collisions: 0
raw token !== hash: true
rejects "../../etc/passwd" -> false
rejects "<script>alert(1)" -> false
```

### 2. The portal strictly rejects expired and revoked tokens

`tests/security/portal-isolation.test.ts` — **25 tests against a real
PostgreSQL 16, connected as a NON-SUPERUSER.**

| Scenario | Result |
|---|---|
| Live, unexpired, unrevoked token | **Accepted** |
| Expired token | **Rejected** |
| Revoked token | **Rejected** |
| Nonexistent token | **Rejected** |
| Token revoked *mid-life* | **Rejected on the very next request** |
| Raw token searched in the table | **0 rows — only the hash is stored** |

Confirmed end-to-end against the built server:

```
malformed token                    -> 404
well-formed, nonexistent           -> 404
database completely unreachable    -> 404   (fail-closed)
portal document, bad token         -> 404
Clerk redirect                     -> none
```

Every failure returns **the same 404**. Distinguishing "never existed" from
"revoked yesterday" would confirm to an anonymous prober that a token was
once valid — information they did not have. The specific reason is logged
server-side.

---

## 🔴 A pre-existing bug found and fixed: `withTenant()` was silently dead

The portal is built entirely on `withTenant()`, so it was examined closely
before use. It did not work.

`withTenant()` set the tenant with `set_config(..., is_local => true)` —
**transaction-local** — but issued no explicit transaction. Outside one,
every statement is its own implicit transaction, so the setting was discarded
the instant the `SELECT set_config(...)` returned. Every subsequent query saw
an empty tenant, RLS matched nothing, and reads came back with **zero rows**.

Verified against PostgreSQL 16:

```
set_config(..., true), then a separate query   ->  ""
same, inside BEGIN / COMMIT                    ->  "<tenant-uuid>"
```

It failed **closed** — no data ever leaked — but any code path relying on
`withTenant()` for scoping returned nothing at all.

**The obvious fix is dangerous and was rejected.** `is_local => false` sets
the value for the whole *session*, i.e. the pooled connection, which then
returns to the pool still carrying that tenant. Also verified:

```
set_config(..., false); release(); connect()   ->  "<previous tenant>"
```

A genuine cross-tenant leak, introduced by the "fix".

The correct fix is an explicit transaction with `is_local => true` inside it:
the setting survives every statement in the callback and is discarded at
COMMIT, before the connection is reused. `tests/security/withtenant-scope.test.ts`
now asserts both behaviours so this cannot regress.

---

## 🟠 A test-quality bug: guards that passed for the wrong reason

Every tamper-guard test in `portal-isolation.test.ts` initially passed while
proving nothing.

The tamper triggers raise SQLSTATE **42501** (`insufficient_privilege`) — and
so does PostgreSQL when a role simply lacks a `GRANT`. The test role had no
privileges on `portal_links` (a `DROP ROLE` had aborted because the role owned
objects in another database), so *every* statement failed with
`permission denied for table portal_links`, carrying exactly the code the
tests asserted. Green, and meaningless.

Fixed with an `expectGuard()` helper that asserts the error message matches
the specific guard **and explicitly rejects** `permission denied for table` —
a message a real guard can never produce. This class of false pass is easy to
ship and hard to notice.

---

## Security architecture: how a sessionless page stays safe

Every layer built in Phases 1–8 derives the tenant from the Clerk session.
The portal has none, so the chain starts from the token instead:

```
token → resolvePortalToken() → tenantId → withTenant() → RLS
```

**`portal_links` is the only table in the platform consulted without a tenant
context.** It has to be — the tenant is unknown until the token is found.
That single lookup runs through `withPlatformScope()`, which demands a written
justification and is named to be obvious in a diff.

The bypass is acceptable because of three properties together, and would not
be without all three:

1. It is **exactly one query**, on one table, filtered by an indexed 256-bit
   secret.
2. It returns **only the link row** — not the contract, not the documents.
3. **Every subsequent read is pinned** to the resolved tenant, so full RLS
   applies from that point.

The alternative — an RLS policy permitting anonymous reads of `portal_links` —
would leave that table permanently readable with no tenant context by anything
that ever connects to the database.

### Replay prevention: three independent layers

A signing URL sits in an inbox forever, so signing twice must be *impossible*:

1. **Compare-and-swap.** `UPDATE ... SET is_active = false WHERE id = ? AND
   is_active = true`. Atomic: of two concurrent submissions exactly one
   updates a row. The link is consumed **before** the signature is written —
   a check-then-act would leave a window.
2. **A UNIQUE index** on `contract_signatures.portal_link_id`. Verified: a
   second insert raises 23505.
3. **Status guard.** An already-signed contract is refused outright.

### Tokens are stored as hashes, not plaintext

Only SHA-256 of the token is stored. A stolen backup, a SQL injection
anywhere, or a rogue admin with read access yields **hashes**, not working
credentials.

Plain SHA-256 rather than bcrypt/argon2 is deliberate: slow KDFs defeat brute
force against *low-entropy human-chosen* secrets. These are 256 bits from a
CSPRNG — no dictionary, no pattern, no feasible search space. A slow hash
would add latency to every page load and buy nothing.

**The cost, stated plainly:** a link is displayable exactly once. It cannot be
recovered later because we genuinely do not have it. Staff who need it again
must regenerate, which invalidates the old one — which is the correct
behaviour anyway. `token_prefix` (8 characters, never used for
authentication) keeps links identifiable without keeping them usable.

### Database-level tamper guards

| Guarantee | Enforced by |
|---|---|
| Token hash immutable | Trigger — holds **even for a superuser** |
| Link cannot be re-aimed at another record | Trigger |
| View-only cannot be **upgraded** to signing | Trigger |
| Expired link cannot be extended | Trigger |
| Downgrade to view-only still permitted | (verified — a guard that blocks everything is useless) |
| Link lifetime 1 day – 180 days | CHECK constraint |
| Signatures append-only | Triggers — hold for a superuser |

Re-aiming is the obvious attack: point a live link the client still holds from
a ₹50,000 purchase order at a ₹5 crore sale agreement. Upgrading permission
silently is the subtler one — it would turn a read-only share into signing
authority without the recipient ever being told.

### Separation of duties

Issuing a **view** link requires `contracts:update`. Issuing a **signing**
link requires `contracts:approve` — strictly more. Someone who cannot approve
a contract internally must not be able to hand that power to an outsider.

### Headers, verified on the running server

| Header | Portal | Rest of app |
|---|---|---|
| `Referrer-Policy` | `no-referrer` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` | `SAMEORIGIN` |
| `X-Robots-Tag` | `noindex, nofollow, noarchive, nosnippet` | — |
| `Cache-Control` | `private, no-store` | — |

The token is **in the URL path**, so the realistic leak is a `Referer` header,
not brute force — which is why `no-referrer` matters more here than the
entropy does. `X-Frame-Options: DENY` rules out clickjacking a signature.

### The portal has its own download route

`/portal/[token]/documents/[id]` rather than reusing
`/api/documents/[id]/download`. Teaching the internal route to also accept
portal tokens would give the endpoint every authenticated user relies on a
second, weaker way in. Two doors with one lock each, not one door with two.

It checks three things, and the third is the one that is easy to miss: the
document must be attached to **the exact record the link points at**. Without
that, a client holding a valid link to their own purchase order could pass any
other document id from the same tenant and read it — every other check would
pass honestly.

---

## Outstanding

| ID | Item | Severity |
|---|---|---|
| **SEC-001** | Run `ALL-IN-ONE-SETUP.sql` on production | **BLOCKING** |
| SEC-016 | Enable branch protection requiring "Security Gate" | High |
| **SEC-020** | **No rate limiting on `/portal/[token]`** | **Medium (new)** |
| SEC-002 | Nonce-based Content-Security-Policy | Medium |
| SEC-005 | Rate limiting on search, webhook and upload tokens | Medium |
| SEC-018 | Orphaned blobs — reconciliation sweep | Low |
| SEC-019 | No virus scanning on upload | Low |
| SEC-021 | Portal links are not auto-expired by a sweep | Low (new) |

### On SEC-020

Guessing a 256-bit token is infeasible, so this is not about brute force. It
is about **abuse of an unauthenticated endpoint**: someone hammering
`/portal/<random>` costs Vercel function invocations and database round trips
on the Hobby plan's finite budget. Upstash Ratelimit is already a dependency;
this is a small piece of work worth doing before the portal is publicised.

---

## Honest limitations

- **This is an electronic record of assent, not a PKI digital signature.**
  There is no certificate and no signer-held private key. Under India's IT Act
  2000 that distinction matters, and it is stated in the schema and on the
  contract page rather than buried.
- **The signer's identity is only as strong as their inbox.** Anyone with
  access to the recipient's email can open and sign. That is the standard
  model for lightweight e-signature, and it is a real limitation — a
  high-value agreement warrants a provider with identity verification.
- **No end-to-end browser test** drives a real signature through a real
  database. The layers are individually tested; their composition is not.
- **The portal has not been tested against a real Neon endpoint** from this
  environment — the local probe used plain PostgreSQL over TCP, which the Neon
  driver cannot speak. That is what surfaced the fail-closed hardening, but
  full portal rendering needs verifying on the deployed environment.
- **Vercel Hobby forbids commercial use.** Unchanged by any code here.
