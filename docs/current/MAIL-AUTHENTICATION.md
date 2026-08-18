# Mail authentication for `ordence.com` — SPF, DKIM, DMARC

Version: v1.52.x · Batch 134

---

## 🔴 READ THIS FIRST — WHAT THIS DOCUMENT IS AND IS NOT

This is **a list of records to add and how to verify them**. It is **not** a
report that the records are in place.

Nobody could query DNS while this was written — the machine that produced it
has no resolver reachable for `ordence.com`. So every record below is stated
as *what to publish*, and every section ends with *the command that proves
whether it is actually published*. If you want to know the live state, run
those commands. Do not read this file as evidence.

Two things below are **known**, because they were confirmed in the Clerk
production console this session rather than guessed:

* `clkmail.ordence.com` — Clerk's mail CNAME — exists and is **verified**.
* `clk._domainkey.ordence.com` and `clk2._domainkey.ordence.com` — Clerk's two
  DKIM selectors — exist and are **verified**.

Everything else is a record to add, or a value to copy out of a vendor
dashboard. ⚠️ **Where this document names a vendor's hostname, confirm it
against that vendor's own DNS panel before pasting.** Vendors change include
hosts and selector names, and a stale include is indistinguishable from a
typo once mail starts failing.

---

## THE SITUATION, IN ONE PARAGRAPH

`ordence.com` has **two independent senders**:

| Sender | What it sends | Configured by |
|---|---|---|
| **Clerk** | Authentication mail: sign-in links, verification codes, password resets, invitations | Clerk production instance, DNS already verified |
| **Resend** | Product mail: invoices, statements, notifications, portal links | `RESEND_API_KEY` + `RESEND_FROM_EMAIL` on Railway (`lib/email/resend.ts`) |

Both send **as `ordence.com`**. That single fact is the whole difficulty, and
it is the reason this document exists instead of a one-line ticket.

---

## 🔴 SPF — ONE RECORD, TEN LOOKUPS, AND HOW ADDING A SENDER BREAKS MAIL THAT WORKED

### The two rules that catch people

**Rule 1 — exactly one SPF record per domain.**
`ordence.com` may carry **one** TXT record starting `v=spf1`. Not two. If a
second one is added — the usual way this happens is one person adds Resend's
record without noticing an existing one — receivers get `permerror`, and a
`permerror` is treated as a failure by a large share of receivers. Two valid
records are worse than one wrong record.

**Rule 2 — ten DNS lookups, total, including nested ones.**
SPF evaluation is capped at **10 DNS-querying mechanisms**. Over the cap is
again `permerror` — the same silent failure. What counts:

| Mechanism | Lookups |
|---|---|
| `include:` | 1 **plus everything the included record itself costs** |
| `a`, `mx`, `ptr`, `exists:` | 1 each (`mx` can cost more) |
| `redirect=` | 1 plus the target's cost |
| `ip4:`, `ip6:`, `all` | **0** |

⚠️ **A second `include:` is a real step toward that ceiling.** This is the
non-obvious failure mode of adding a sender: SPF was passing at, say, 8
lookups, somebody adds one more vendor whose record nests three deep, the
total crosses 10, and **mail that had been delivering for months starts
failing** — for both senders at once, including the authentication mail
people need in order to log in and report the problem.

### The merged record

```dns
Name:  ordence.com          (some registrars want "@" here)
Type:  TXT
TTL:   3600
Value: v=spf1 include:amazonses.com ~all
```

⭐ **One record, not two.** If Clerk's console shows you an SPF include for
the apex, it goes **inside this same string**, never in a second record:

```dns
v=spf1 include:amazonses.com include:<value-from-Clerk-console> ~all
```

### Why Clerk may not need an apex include at all

Clerk's setup is **CNAME-based**: `clkmail.ordence.com` is the custom
Return-Path (bounce) host, and it points at Clerk's own mail infrastructure.
SPF is checked against the **envelope sender's** domain, so for Clerk's mail
the check lands on `clkmail.ordence.com` and follows the CNAME to Clerk's
record — the apex record is not consulted, and Clerk costs you **zero apex
lookups**. Clerk's alignment with `ordence.com` then comes from DKIM (`clk.`
/ `clk2.` sign `d=ordence.com`), which is what DMARC needs.

🔴 **Confirm this rather than trusting it.** If Clerk's DNS page lists an SPF
value for the apex, add it to the merged string above. If it lists only the
mail CNAME and the two DKIM CNAMEs — which is what the console showed this
session — you do not.

The same argument applies to Resend if you send from a **subdomain**
(`RESEND_FROM_EMAIL` on e.g. `mail.ordence.com`): the SPF record goes on that
subdomain and the apex budget is untouched. Sending from the apex is the
choice that spends apex lookups.

### Counting the lookups you actually have

| Record shown above | Top-level lookups |
|---|---|
| `include:amazonses.com` | 1, plus whatever that record nests |
| plus a Clerk apex include, if the console gives you one | 2, plus nesting |

⚠️ **The nested cost is the part you cannot eyeball**, and it changes when a
vendor edits their own record without telling you. Measure it:

```bash
# What the apex actually publishes today
dig +short TXT ordence.com | grep spf1

# What one include expands to (repeat for each include, recursively)
dig +short TXT amazonses.com

# Or use a checker that does the recursion and prints the count:
#   https://www.kitterman.com/spf/validate.html   (enter ordence.com)
#   https://mxtoolbox.com/SuperTool.aspx?action=spf%3aordence.com
```

Record the number somewhere durable. **A count of 8 is not comfortable** — it
is one vendor change away from broken.

### `~all` or `-all`

Start with `~all` (softfail: "this was probably not us"). Move to `-all`
(hardfail) only after DMARC aggregate reports show a week with no legitimate
sender failing SPF. `-all` published while some forgotten sender — a billing
system, a monitoring tool, a marketing platform — still sends as `ordence.com`
is a self-inflicted outage.

### What breaks if SPF is wrong

* **Two `v=spf1` records** → `permerror` → treated as failure by many
  receivers → both auth mail and invoices land in spam or bounce.
* **Over 10 lookups** → `permerror` → same, and it appears *later*, without a
  DNS change of your own.
* **`-all` published too early** → legitimate mail from an un-listed sender is
  rejected outright, not spam-foldered. Hard bounces.
* **Right record, wrong envelope domain** → SPF passes for the vendor's own
  bounce domain but is not *aligned* with `ordence.com`, so DMARC ignores the
  pass. This is why DKIM matters more than SPF here.

---

## DKIM — PER-SENDER SIGNATURES, WHICH IS WHY BOTH SENDERS CAN COEXIST

⭐ **DKIM has no lookup budget.** Every sender gets its own selector, and
selectors do not compete. This is the mechanism that makes two senders on one
domain workable at all, and it is the reason the DMARC policy below can be
tightened even while SPF is at its ceiling.

### Clerk — already published and verified (confirmed this session)

```dns
Name:  clk._domainkey.ordence.com     Type: CNAME   Value: <from Clerk console>
Name:  clk2._domainkey.ordence.com    Type: CNAME   Value: <from Clerk console>
Name:  clkmail.ordence.com            Type: CNAME   Value: <from Clerk console>
```

🔴 **Do not delete or "tidy" these.** Removing `clkmail` breaks the Return-Path
and therefore Clerk's SPF alignment; removing either `clk` selector breaks
signing on whichever key Clerk is currently rotating to. Both failures land on
**sign-in and password-reset mail**, i.e. the mail whose failure prevents
customers from reaching support through the product.

### Resend — to add

```dns
Name:  resend._domainkey.ordence.com
Type:  TXT
Value: <the p=... public key from the Resend dashboard, pasted whole>
```

⚠️ **`resend` is Resend's usual selector name; confirm the exact selector and
value in the Resend dashboard for this domain.** Resend may also ask for a
`send.ordence.com` MX record and a matching SPF TXT on that subdomain — if it
does, take that option: it keeps Resend's lookups off the apex budget entirely.

Long keys: some registrars split a 2048-bit key across quoted chunks. Paste
the value exactly as the dashboard gives it; do not insert spaces or line
breaks yourself.

### Verify

```bash
dig +short TXT resend._domainkey.ordence.com
dig +short CNAME clk._domainkey.ordence.com
dig +short CNAME clk2._domainkey.ordence.com
dig +short CNAME clkmail.ordence.com
```

Then send one real message through each sender and read the received headers:
`Authentication-Results:` must show `dkim=pass` **and** `header.d=ordence.com`.
`dkim=pass` with `header.d=` some vendor domain is a pass that DMARC will not
count.

### What breaks if DKIM is wrong

* Missing or wrong selector → `dkim=fail`. Under `p=none` nothing visible
  happens; under `p=quarantine` or `p=reject` that sender's mail stops.
* Key present but `d=` a vendor domain → not aligned → DMARC failure even
  though the signature is valid.
* Mail forwarded through a mailing list usually breaks SPF but **survives
  DKIM** — which is exactly why DKIM is the one to get right before tightening
  DMARC.

---

## DMARC — START AT `p=none`, AND EARN EACH STEP

### The record to add

```dns
Name:  _dmarc.ordence.com
Type:  TXT
TTL:   3600
Value: v=DMARC1; p=none; rua=mailto:dmarc-reports@ordence.com; fo=1; adkim=r; aspf=r; pct=100
```

| Tag | Meaning here |
|---|---|
| `p=none` | Monitor only. Receivers change nothing; they just report. |
| `rua=` | Where aggregate XML reports go. **This is the entire point of stage one.** |
| `fo=1` | Ask for a failure report when either SPF or DKIM fails, not only when both do. |
| `adkim=r` / `aspf=r` | Relaxed alignment: a subdomain signature counts for the parent. Strict (`s`) breaks the `clkmail` and `send.` subdomain arrangements. |
| `pct=100` | Applies to all mail — meaningless under `p=none`, matters when you tighten. |

Make sure `dmarc-reports@ordence.com` is a mailbox somebody will actually
open, or point `rua` at a DMARC reporting service. Reports are compressed XML
and arrive daily, in volume; a `rua` nobody reads is the same as no `rua`.

### ⚠️ THE ESCALATION, AND THE EVIDENCE EACH STEP REQUIRES

🔴 **Going straight to `p=reject` before reading a week of aggregate reports is
how a company stops receiving its own invoices** — and stops its own customers
from receiving password resets. The failure is silent at the sending end:
your logs say "sent", the receiver says nothing, and you find out from a
customer weeks later.

**Stage 1 → `p=none`.** Publish today. Change nothing else. Wait at least
**7 days**, preferably 14 to cover a full billing cycle.

**Stage 1 → 2, the evidence required:**
* Aggregate reports name **every** source sending as `ordence.com` — and you
  recognise every one of them. An unrecognised source is either a forgotten
  system or a forger; either way you cannot tighten until you know which.
* Clerk's and Resend's volumes both appear, both showing `dkim=pass` with
  `header.d=ordence.com`.
* Any remaining failures are explained (typically forwarding, which fails SPF
  and passes DKIM — acceptable) rather than merely tolerated.

**Stage 2 → `p=quarantine`, and start at `pct=10`:**

```dns
v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc-reports@ordence.com; fo=1; adkim=r; aspf=r
```

Ten percent means a mistake costs one message in ten, not all of them. Raise
`pct` to 25, 50, 100 over a couple of weeks, watching reports at each step.

**Stage 2 → 3, the evidence required:**
* A **full month** at `p=quarantine; pct=100` with no legitimate mail
  quarantined — confirmed by report data, not by the absence of complaints.
  People do not report mail they never knew was sent.
* Any newly-added sender (a payroll tool, an e-invoicing vendor, a CA's
  portal) is already aligned before it sends its first message.

**Stage 3 → `p=reject`:**

```dns
v=DMARC1; p=reject; rua=mailto:dmarc-reports@ordence.com; fo=1; adkim=r; aspf=r; pct=100
```

### What breaks if DMARC is wrong

* `p=reject` with a broken or missing DKIM selector → **all** mail as
  `ordence.com` is rejected at the receiver. Invoices, statements, sign-in
  links, everything, at once.
* `p=reject` with `adkim=s` while Clerk signs from a subdomain → same outage,
  from a one-character difference.
* No DMARC record at all → anyone may forge `ordence.com` and receivers have
  no instruction. For a product that emails invoices to Indian SMBs and their
  CAs, that is the record worth having even at `p=none`.

---

## VERIFICATION CHECKLIST — RUN THIS, DO NOT TRUST THIS FILE

```bash
# 1. Exactly ONE line back. Two lines = permerror.
dig +short TXT ordence.com | grep spf1

# 2. Lookup count under 10, including nesting. Use a recursive checker.
#    https://www.kitterman.com/spf/validate.html

# 3. All four DKIM/mail records resolve.
dig +short CNAME clkmail.ordence.com
dig +short CNAME clk._domainkey.ordence.com
dig +short CNAME clk2._domainkey.ordence.com
dig +short TXT   resend._domainkey.ordence.com

# 4. DMARC present and at the stage you think it is.
dig +short TXT _dmarc.ordence.com

# 5. THE ONLY TEST THAT COUNTS: send one real message through EACH sender
#    to an external mailbox and read the headers.
#    Trigger a Clerk sign-in email, and trigger one product email.
#    Both must show, in Authentication-Results:
#        spf=pass      (or a documented, understood softfail)
#        dkim=pass  header.d=ordence.com
#        dmarc=pass
```

⭐ Step 5 is the one people skip and the only one that proves anything.
Records resolving is not the same as mail passing.

---

## WHERE THE SENDING CONFIG LIVES IN THIS REPO

* `lib/email/resend.ts` — reads `RESEND_API_KEY` and `RESEND_FROM_EMAIL`.
  Note its fallback: with `RESEND_FROM_EMAIL` unset it sends as
  `onboarding@resend.dev`, which is **not** `ordence.com` and therefore not
  covered by anything in this document. If mail is arriving from
  `resend.dev`, the environment variable is missing, not the DNS.
* `lib/platform/env-catalog.ts` — lists both Resend variables as optional;
  they are set on Railway.
* Clerk's records are managed from the Clerk production console, not from
  this repo.
