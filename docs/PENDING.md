# Ordence — everything still pending

**As of v34, 3 August 2026.** Ordered by what blocks what. Verified against
the codebase, not recalled.

---

## 0 · WAITING ON YOU — nothing I build lands until these happen

| # | Do this | Where | Why it matters |
|---|---|---|---|
| 1 | **Run `19.sql`** | Neon SQL Editor | Engine 4's four tables. Nothing compliance-related exists in your database yet |
| 2 | **Run `20.sql`** | Neon SQL Editor | Engine 1's three tables + the exclusion constraint |
| 3 | **Deploy v34** | Push to GitHub | 13 industries, 67 feature keys, both engines, the upload fix |
| 4 | **Open `https://admin.ordence.com/api/diag`** while signed in | Browser | The parked admin question. `"signedIn": true` → the fault is in the page. `false` → the session stops at `app.` and the fix is in Clerk |
| 5 | **Rotate every credential** | `ROTATION-LINKS.md` | Database password, Clerk secret, webhook secret, Upstash token, Resend key, four OpenRouter keys. All passed through chat |
| 6 | **Delete the old Clerk development instance** | Clerk → Danger zone | A second live credential set with a 100-user cap and no reason to exist |

---

## 1 · The engines — 2 of 6 built

| Engine | Unlocks | State |
|---|---|---|
| **4 · Compliance calendar** | all 10 | ✅ Schema, SQL, 16 behavioural + 6 RLS tests, 3 idempotent runs |
| **1 · Scheduling & capacity** | 5 verticals | ✅ Schema, SQL, 12 behavioural + 4 RLS tests, **9 concurrency trials** |
| **2 · Rate & pricing** | 6 verticals | 🔴 Not started |
| **3 · Field & mobile ops** | 5 verticals | 🔴 Not started |
| **5 · Metering & consumption** | 3 verticals | 🔴 Not started |
| **6 · Sensitive-data vault** | hospitals | 🔴 Not started — **and must exist before the first patient record** |

---

## 2 · ⭐ THE REAL GAP — 18 modules have no screen

This is the honest headline. The database, the entitlements and the menus all
know about these. **A user clicking one gets a 404.** They are hidden today
(`status: "coming_soon"`), so nothing advertises a dead link — but hidden is
not built.

**Engine screens — the engines exist, the pages do not:**

| Route | Engine | Note |
|---|---|---|
| `/compliance` | 4 | The deadline board. **This IS the CA vertical** |
| `/compliance/licences` | 4 | Expiring permissions |
| `/scheduling` | 1 | The calendar. Five verticals need it |
| `/rates` | 2 | Waiting on the engine |
| `/field-jobs` | 3 | Waiting on the engine |
| `/meters`, `/meters/readings` | 5 | Waiting on the engine |
| `/timesheets` | — | No engine needed; plain build |

**Pre-existing dead links, found by the registry in Section A:**

`/search` · `/deals` · `/calendar` · `/reports/cost` · `/billing`
(the real screen is `/settings/billing`) · `/documents` · `/settings/objects`

> ⚠️ **Engine 4 without `/compliance` is a database nobody can reach.** Of
> everything on this page, that one screen converts the most already-finished
> work into something a customer can use.

---

## 3 · Known defects

| # | Defect | Severity |
|---|---|---|
| 7 | **`/dashboard` fails with reference `2120306202`.** All three analytics views exist and are readable — checked. Cause still unknown; Neon swallowed the diagnostic output | Real. One screen |
| 8 | **`admin.ordence.com` 404s** though both platform keys verify on `app.` Almost certainly the session not crossing to the subdomain | Blocks the admin console |
| 9 | **Signing out throws a client-side exception.** The sign-out succeeds; the page crashes redrawing itself with no user | Cosmetic, but every user sees it |
| 10 | **Nine phases have never had their security tests run.** CI applied SQL only to `0022`; v26 fixed it but **the pipeline has never been watched go green** | Unknown, which is the problem |
| 11 | **Inventory: reversing a receipt below reserved quantity leaves you over-committed**, silently | Real. Flagged when built |
| 12 | `subscriptions` and `roles` were empty — 18.sql fixed subscriptions; **`roles` is still unseeded** | Likely behind #7 |

---

## 4 · Half-built, from earlier waves

| # | Item | State |
|---|---|---|
| 13 | **`labour` schema** (Port Wave C) | 8 tables written, **not registered** in `db/schema/index.ts`, no SQL, no tests |
| 14 | **`construction` schema** | Written, **not registered**. Invisible to the app |
| 15 | **`/contracting` screen** | Wave B's schema + SQL are done. No page at all |
| 16 | **Port waves D–J** | Capital, RERA escrow, legal, quality/safety, leasing, comms, platform |

---

## 5 · The client-onboarding architecture — 2 of 7 sections

| § | What | State |
|---|---|---|
| A | Module registry | ✅ v29 |
| B | Entitlement-driven sidebar | ✅ v29 |
| C | **Admin console** — tenant list, module toggles, audit | 🔴 Blocked on #8 |
| D | **One-click provisioning** | 🔴 |
| E | **Client setup wizard** | 🔴 |
| F | **Branding rendering** — logo, banner, colour, PDFs, email | 🔴 Columns exist, displayed nowhere |
| G | **Subdomains switched on** | 🔴 Wildcard DNS ✅, Clerk production ✅ — needs the resolver turned on and testing |

---

## 6 · Security

**38 findings and 8 bypasses** from your own Ameya audit, never run against
Ordence. **Must be done before the public REST API**, which is where most of
them bite.

Also open:

- **No Content-Security-Policy header at all.** Cheap mitigation for several
  of the 38
- **Razorpay** — blocked on your bank account
- **Resend** — verified and keyed, but **no email has ever been sent**
- **Upstash** — connected, but nothing reads or writes it

---

## 7 · What I would do next, in order

1. **`/compliance` and `/compliance/licences`** — turns Engine 4 from a schema
   into the professional-services vertical. Highest ratio of value to work on
   this page
2. **`/scheduling`** — same for Engine 1, across five verticals
3. **Engine 2 (pricing)** — unlocks 6
4. **Engine 3 (field ops)** — unlocks 5
5. **Engine 5 (metering)** — unlocks 3
6. **Admin console (C)** — once #8 is answered
7. **Engine 6 + hospitals** — last, deliberately: health data cannot be
   migrated into a vault afterwards without that migration being the breach

---

## The one-line summary

**Two engines are built and tested; four are not. Eighteen screens are missing,
and `/compliance` is the one that would convert the most finished work into
something a customer can actually use.**
