# Security Report — v0.8.0-alpha

**Phase 8 — Cloud Storage, Document Assembly & Transactional Email**
**Date:** 31 July 2026 · **Verdict: PASS**

---

## Summary

| Check | Result |
|---|---|
| TypeScript strict (`tsc --noEmit`) | **Clean** |
| Production build (`next build`) | **Clean — 26 routes** |
| Security tests (real PostgreSQL 16) | **86 / 86 passing** |
| UI & route tests | **79 / 79 passing** |
| Tables under RLS | **23** (was 22) |
| Server secrets in client bundle | **None** — including the new Blob and Resend keys |
| Production dependency vulnerabilities | **0** |
| Exported server actions without a tenant guard | **0 of 6 new** |
| API routes without a session check | **0 of 2 new** |
| Non-async exports in `"use server"` files | **0** |
| Literal control characters in new source | **0** |

---

## The two mandatory Phase 8 verifications

### 1. The Blob token generator strictly enforces the Clerk session

`tests/ui/upload-authorization.test.tsx` — **19 tests against the real route
handler.** Clerk is replaced only at the `requireTenantContext` boundary;
everything downstream (Zod validation, path construction, the allowlist, the
size ceiling, error mapping) is the genuine implementation.

An upload token is a **write capability** for the blob store. Once issued, the
browser talks to Vercel directly and our code is out of the conversation — so
every constraint has to be decided at issuance.

| Scenario | Result |
|---|---|
| No Clerk session | **401, no token** |
| Session with no organisation | **403** |
| Suspended user | **403** |
| Inactive tenant | **403** |
| Client requests `tenants/<other-tenant>/…` | **Ignored — path rebuilt from session** |
| Filename `../../../etc/passwd` | **Traversal stripped** |
| Two tenants, identical filename | **Disjoint paths** |
| Token content types | **Allowlist attached; `text/html` and `image/svg+xml` absent** |
| Token size ceiling | **50 MB, attached to the token** |
| Token access mode | **`private`** |
| Token overwrite | **Refused** |
| Token lifetime | **10 minutes** |
| Missing / malformed / oversized client payload | **400, never defaulted** |
| `BLOB_READ_WRITE_TOKEN` absent | **503 with an actionable message** |
| `GET` | **405** |

**The single most important assertion** is that a client-supplied pathname aimed
at another tenant is ignored. If the route honoured it, a caller could request
`tenants/<victim>/…` and receive a perfectly valid token to write there — with
every other control in the system intact and irrelevant.

### 2. RLS on `documents` isolates files by `tenant_id`

`tests/security/document-isolation.test.ts` — **17 tests against a real
PostgreSQL 16, connected as a NON-SUPERUSER.** That second part is not a
detail: a superuser bypasses RLS entirely, so a suite connected as one would
report green forever, including after every policy was dropped.

| Scenario | Result |
|---|---|
| Tenant A lists documents | **Sees only its own** |
| Tenant B reads A's document by exact ID | **0 rows** |
| Tenant B searches by A's blob pathname | **0 rows** |
| No tenant context | **0 rows — never all rows** |
| Garbage tenant context | **0 rows** |
| Tenant B UPDATEs A's document | **0 rows affected; A's row verified unchanged** |
| Tenant B DELETEs A's document | **0 rows affected; row still present** |
| Tenant B INSERTs a row stamped with A's id | **Rejected, SQLSTATE 42501** |
| INSERT with no tenant context | **Rejected** |
| Move a document between tenants | **Rejected** |
| Move a document between tenants **as superuser** | **Rejected, 42501** |
| Re-attach to a different parent record | **Rejected, 42501** |
| Rewrite the blob pathname | **Rejected, 42501** |
| Update a permitted field on one's own document | **Succeeds** |

The superuser test is the decisive one. A superuser bypasses RLS completely, so
if tenant-immutability lived only in the policy it would succeed. It is a trigger
precisely so that it does not.

The last row matters too: a guard that blocked everything would be trivial to
pass and useless in practice.

---

## ⚠️ What these tests do NOT prove

**They say nothing about the file bytes.** Those live in Vercel Blob, outside
PostgreSQL, where `app.current_tenant_id` has never been heard of.

Stating "RLS protects our documents" without that caveat would be the most
dangerous half-truth available in this phase. The bytes are protected by a
separate, deliberate mechanism:

- uploaded with **`access: 'private'`** — not fetchable by URL
- served only through `/api/documents/[id]/download`, which re-derives the
  session, loads the row scoped to the tenant, confirms the stored path sits
  inside that tenant's prefix, and only then streams

Verifying the private-access behaviour end-to-end requires a real Blob store and
is a manual step in the deployment guide (paste a download URL into a signed-out
browser; it must refuse).

---

## Security decisions and why they went this way

### Blobs are private, not public

The default in most tutorials is `access: 'public'`, and it is the wrong default
here. A public blob URL is readable by **anyone who ever sees it** — a forwarded
email, browser history, a proxy log — forever, with no session, no tenant check
and no audit trail. For a CRM holding executed legal agreements that is not
acceptable, and RLS on the metadata table compensates for none of it.

The cost is that every download runs through a serverless function, consuming
duration and egress. That is a deliberate trade of bandwidth for correctness of
access control. If download volume ever becomes the constraint, the upgrade is
short-lived signed URLs issued **after these same checks** — the checks do not
change, only what gets returned.

### The email recipient comes from the database, not the request

`sendContractToClient` has **no `to` parameter**. The address is read from the
contract's linked contact, inside the tenant.

Every control built in Phases 1–7 governs who may read data *inside* the
platform. An email leaves. There is no revocation, no audit of forwarding, and
no un-sending. That makes the recipient the most security-relevant field on the
screen, and not one worth trusting a client with.

Sends are audited at `notice` severity with the recipient recorded. **Failed**
sends are audited too — "we tried to send this outside the tenant and could not"
is information an auditor wants as much as a success.

### Deletion is deliberately asymmetric

The blob is **hard**-deleted; the row is **soft**-deleted.

The row is evidence — it records that a file existed, who uploaded it, who
removed it. The bytes are the confidential content, and "we hid it from the
list" is not what a deletion request means.

The order is also deliberate: **blob first, then row.** If the blob delete fails
we abort and the row stays visible, so the user sees the file still listed and
can retry — which is truthful. The other order would mark a file deleted while
its bytes remained, and nobody would ever find out.

### Uploads are refused while a contract is under legal hold

The point of a hold is that evidence does not change. The contract detail page
disables both upload and delete while `legal_hold` is set.

---

## Defects found and fixed during this phase

### 🟠 An `onUploadCompleted` webhook that could never fire

The natural design writes the database row in Vercel Blob's completion webhook.
It was implemented, then **removed** on discovering two independent problems:

1. `/api/upload` is not in the middleware's public-route list, so a session and
   active organisation are required before a request reaches the handler. Vercel
   calls the webhook server-to-server with no cookie — it would have received a
   401 every time.
2. It never fires on `localhost` regardless, because Vercel cannot reach a
   laptop.

Making the route public would have let the webhook through, at the cost of
removing a session check from the endpoint that mints write capabilities. That
trade was declined. The authoritative write is the server action, which behaves
identically in every environment.

Shipping a callback that silently never runs would have been worse than not
having one.

### 🟠 Literal control characters in two regexes — twice

Both `sanitizeFileName` and `escUrl` were first written with **raw control bytes
embedded in their character classes** — the identical defect this codebase
shipped in Phase 3's URL sanitiser, where it made `java\tscript:` slip through.

Both rewritten with explicit `\u` escapes and verified behaviourally:

```
"../../../etc/passwd"    -> "passwd"
"report<U+202E>gnp.exe"  -> "reportgnp.exe"
"java\tscript:alert(1)"  -> "#"
"JaVaScRiPt:alert(1)"    -> "#"
"data:text/html,<script>"-> "#"
"//evil.com"             -> "#"
```

A repository scan for literal control and bidi characters in new source now
returns zero and is part of the release checks.

### 🟡 `access: "public"` in the upload call

The client component was written with `access: "public"`, contradicting the
entire private-storage design documented three files away. Caught before the
build. A test now asserts the issued token carries `access: "private"`, so the
contradiction cannot reappear silently.

### 🟡 A stray non-English word in a comment

Cosmetic, but removed on the same principle as the control characters: source
that cannot be read cleanly cannot be reviewed reliably.

---

## New attack surface reviewed

**Two API routes**, both requiring a session — via middleware *and* via
`requireTenantContext()` inside the handler. A header set by middleware is only
as trustworthy as everything that can write one, so the tenant is re-derived
rather than read.

**Six server actions**, all guarded, verified mechanically.

**The polymorphic parent link** is the one place a foreign key cannot help:
PostgreSQL does not know which table `entity_id` points into. `parentBelongsToTenant`
re-creates that guarantee in code — and checks **ownership**, not merely
existence. A foreign key proves a row exists; it does not prove it is yours, and
tenant B passing tenant A's contract id would satisfy `EXISTS` perfectly.

**The file-type allowlist** excludes `text/html` and `image/svg+xml` despite
both being ordinary document types. Both carry executable script; served from an
origin a user is signed into, they become stored XSS. SVG is the common miss
because it reads as "an image".

**Downloads** are sent with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`, so an uploaded file cannot be rendered inline
as same-origin content.

---

## Outstanding

| ID | Item | Severity |
|---|---|---|
| **SEC-001** | Run `ALL-IN-ONE-SETUP.sql` on production | **BLOCKING** |
| SEC-016 | Enable branch protection requiring "Security Gate" | High |
| SEC-002 | Nonce-based Content-Security-Policy | Medium |
| SEC-005 | Rate limiting on search, webhook **and upload token issuance** | Medium |
| SEC-013 | Bank reconciliation UI | Medium |
| **SEC-018** | **Orphaned blobs** — reconciliation sweep for objects with no row | **Low (new)** |
| SEC-019 | No virus scanning on upload | Low (new) |
| SEC-011 | Binary PDF output (currently print-ready HTML) | Low |
| SEC-015 | Permission override admin UI | Low |

**Closed this phase:** none. **Opened:** SEC-018, SEC-019.

### On SEC-019, stated plainly

Uploaded files are **not scanned for malware**. The allowlist blocks the obvious
script-bearing types and downloads are forced rather than rendered, so the risk
to *this application* is low. The risk is to whoever opens the file on their own
machine. Proper scanning needs a third-party service and is not free; it belongs
in the conversation before you onboard a customer who uploads files from
outside their own organisation.

---

## Honest limitations

- **The private-access behaviour is not covered by an automated test.** It needs
  a real Blob store; a mock asserting our own mock would prove nothing. It is a
  manual verification step in the deployment guide.
- **No end-to-end test** drives a real browser through upload → download →
  delete against a real store and database. Each layer is tested; their
  composition is not.
- **Email delivery is not tested against Resend.** The templates and the
  dispatcher's failure handling are; whether a message reaches an inbox depends
  on DNS records this codebase cannot verify.
- **Vercel Hobby forbids commercial use.** A licensing fact, unchanged by any
  code in this phase.
