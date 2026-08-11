# DEPLOY-VERIFY

Run these after every deploy, in this order. Each one takes seconds and each
proves something a green deployment badge does not.

---

## 1. The tree that shipped is the tree you pushed

Open **https://app.ordence.com** and read the version string under the logo.

| Reads | Means |
|---|---|
| `v0.87.0-alpha` | ✅ this release is live |
| anything else | 🔴 the folder you pushed is not this folder — stop |

This string comes from `package.json` via `lib/version.ts`. It cannot drift from
the artefact, which is the whole reason the file exists. A green deploy with the
wrong version string has happened on this project and it will happen again.

**Before pushing:** open `package.json` and confirm `"version"`. There is a
stale `0.83.0` tree with no git repo on the build machine. Pushing that over
`main` is the most expensive mistake available.

---

## 2. The app is alive

```
https://app.ordence.com/api/health
```

`{"status":"ok","timestamp":"..."}`.

This endpoint deliberately reveals nothing else — no version, no dependency
status. That is a decision, not an omission; see the comment in the file.

Set this path as Railway's **Healthcheck Path** so a deploy that builds but
cannot serve never replaces the one that can.

---

## 3. Certificates are real on every hostname

```
app.ordence.com      → must load over HTTPS with no warning
admin.ordence.com    → must load over HTTPS with no warning
<anything>.ordence.com → must load over HTTPS with no warning
```

A hostname whose Railway row says *"Waiting for DNS update"* has no certificate
of its own. What answers is the CDN's edge certificate, which does not cover the
name — the browser calls that a hostname mismatch.

For Railway to issue, the DNS record must be **DNS only**, not proxied. Railway
cannot complete validation through a proxy.

---

## 4. Sign-in actually works

Load the sign-in page and complete one real sign-in. A deploy can be green,
healthy and certificate-clean while authentication is misconfigured, because
nothing above touches Clerk.

---

## 5. The database role is still the restricted one

```sql
SELECT rolname, rolcanlogin, rolbypassrls
FROM pg_roles
WHERE rolname ILIKE '%ordence%';
```

`ordence_app` must be `rolcanlogin = t` and **`rolbypassrls = f`**.

A role that bypasses row-level security is a role for which every tenant is one
tenant. This is the single check on this list that, if it fails, means data has
been exposed rather than merely unavailable.
