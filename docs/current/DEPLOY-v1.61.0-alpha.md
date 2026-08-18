# DEPLOY , Ordence v1.61.0-alpha (mega-wave 2 complete)

**Repo: `app.ordence`**

🔴 **SQL: ONE new migration, `0093_user_notification_preferences.sql`, BEFORE the code push.**
⚠️ **No new environment variables.**

**15 gates green. `tsc` clean. 150 test files. 5,120 tests, up from 4,944.**

---

## The seven batches

Enumerated from `docs/current/122-WHERE-EVERYTHING-STANDS.md`, not from memory: mega-wave 2 is **24 batches**, 15 were done, **9 were left**, and **7 were runnable**. Batch 24 needs a suspended workspace and batch 32 needs the two vault keys , both are yours, not mine.

| # | Batch | |
|---|---|---|
| **136** | `requireMfa` and idle timeout | 🔴 a false claim of a security control, now real |
| **135** | Notification preferences | out of `localStorage`, and now honoured on the send path |
| **48** | Credit-note caps and step-up | money leaving on one person's say-so |
| **134** | Mail authentication and a trust page | SPF/DKIM/DMARC records to add, and a public page that claims nothing false |
| **142** | Dark mode | light-first, remembered server-side |
| **143** | Backups and a restore drill | 🔴 the drill has NOT been run, and the runbook says so on every line |
| **119** | Vertical regression pack | 13 verticals, and it fails when a fourteenth is added unconfigured |

---

## 🔴 Batch 136 is the one to read

`tenants.settings.requireMfa` and `sessionIdleMinutes` were validated, written, defaulted, typed, rendered as form controls and read back into the form. **They were enforced nowhere.** `middleware.ts` never read either name.

The settings page's own help text said *"Enforced by your identity provider at sign-in."* **It was not.** A tenant admin ticked the box, the form saved, the page confirmed it, and nothing checked. In an ERP holding other people's payroll and GST filings that is a misrepresentation to the customer, not a missing feature , and it is the third instance of the same shape this month, after batch 43's three approval policies and this one's two settings.

⭐ **Enforced twice, on purpose, with one implementation.** The Edge middleware refuses on the signed session claim; `app/(crm)/layout.tsx` re-runs **the same function** against the database row in Node, because the Edge Runtime cannot open a connection. Two call sites, one decision, no drift.

**Already-open sessions are NOT grandfathered**, and the reasoning is stated rather than left implicit: an admin enabling MFA usually has a suspicion, and grandfathering exempts precisely the session they are worried about.

⚠️ **Failure modes chosen deliberately and differently.** A missing factor claim fails **closed** for MFA. The idle limit degrades **visibly** instead, emitting `x-ordence-session-policy: idle-unmeasured`, because every tenant has an idle default and failing closed there would brick the product.

---

## What the other six found

**48 , there is no refund domain.** `refund` in this codebase means a booking-cancellation ledger line, a Stripe webhook we receive, and a legal disbursement. The one place a person reduces what a customer owes is credit notes. **The agent scoped to what exists rather than inventing a refund domain to have something to cap**, and reused the existing `approval_limits` table whose `scope` is a `varchar` precisely so a new scope is a row and not a migration. **No SQL.** The daily total is summed from the ledger rows inside the transaction, never a counter, because a counter drifts silently in the direction of letting more money out.

**134 , the SPF lookup ceiling is the real constraint.** Clerk and Resend both send as `ordence.com`. SPF permits ten DNS lookups and exceeding it is `permerror`, which many receivers treat as failure , so adding a sender can break mail that was working. One merged record, not two. And `docs/current/MAIL-AUTHENTICATION.md` is framed as *records to add and how to verify them*, never as records in place, because there is no resolver here.

⭐ **The trust page's most valuable test asserts a banned-claim list** , SOC 2, ISO 27001, PCI, HIPAA, "bank-grade", "unhackable". It caught two sentences in the agent's own comments on the first run, and the prose was fixed rather than the rule weakened.

**142 , `localStorage` stays, for exactly one thing.** The pre-hydration paint-flash cache. The server row is the truth and storage is a refreshed cache of it, stated in a comment so the next reader does not delete it on sight of the house rule.

**143 , the ransomware property does not hold today.** Point-in-time restore lives inside the Neon account, R2 objects are deletable with the application's own credentials, and there is no off-provider copy. **A backup an attacker with your production credentials can delete is not a backup.** Three fixes are listed, every one tagged UNTESTED.

**119 , it was proved to have teeth.** Four breaks injected into a throwaway copy, five tests went red, each naming the vertical.

---

## ⚠️ Four findings reported and NOT fixed

Reported rather than quietly patched, because each is a product decision:

1. 🔴 **`generic` and `legal_advocate` verticals have no Finance or Compliance navigation at all.** No GST, no GSTR-2B, no TDS, no Tally. An advocate is GST-registered and deducts TDS; those screens are unreachable from their sidebar.
2. **Light-mode contrast fails WCAG AA on the primary button.** White on `--primary: 38 45% 46%` is ~3.5:1 against a 4.5:1 requirement. One token fixes it (lightness 46% → 38% gives 4.9:1) **but it shifts the brand gold product-wide**, so it is your call and not a theming batch's.
3. **Four nav ids point at two different destinations** across verticals: `deals`, `inventory`, `contracts`. One entitlement, two pages.
4. `eway` is offered to five industries. Rule 138 binds any registered person moving goods over ₹50,000. It is an offer list rather than a gate, so the engine is intact, but a hospital is never shown it.

⭐ **And the reassuring one: no statutory library branches on industry.** GST, TDS and payroll do not vary by vertical, because the law does not.

---

## Deploy

1. **`0093_user_notification_preferences.sql`** in Neon. One column, `users.preferences jsonb NOT NULL DEFAULT '{}'`. DDL only, no DML, so no RLS write can refuse it.
   - ⭐ **Drilled the way you actually run it:** split into its three statements, each sent on its own fresh connection as a non-superuser role, three times over for idempotence. No `BEGIN`, no `COMMIT`, no `SET LOCAL`.
2. Unzip `ordence-v1.61.0-alpha.zip`, commit, push.

⚠️ **Still not verified: `next build`.** OOM-killed in this container. `check:route-exports` and `check:client-hooks` exist because that gap broke Railway twice; they are a subset, not a substitute.

---

## Mega-wave 2 after this

**22 of 24 done.** Two remain and both are blocked on you:

| | |
|---|---|
| **24** suspension lockout | needs one suspended workspace to test against |
| **32** vault rotation | needs `VAULT_ENCRYPTION_KEY` + `VAULT_BLIND_INDEX_PEPPER` , `openssl rand -hex 32`, **never pasted to me** |

Then mega-wave 3 (Revenue, 19 left) is next, though four of its batches are blocked on AI provider keys.
