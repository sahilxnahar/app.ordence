# Porting Ameya Heights CRM into Ordence — the sequenced plan

**Decision:** absorb the whole Ameya domain model into Ordence, in waves.
**Direction of travel:** Ameya supplies the *domain*. Ordence supplies the *chassis*.
Nothing is copied as code. Every table is rebuilt multi-tenant.

---

## Why this direction, stated once

Ameya Heights CRM is a single-company system: 247 models, 195 screens, no
`tenant_id`, no row-level security, because it never needed either. It is
**deeper than Ordence on Indian real-estate domain** and shallower on
everything that makes software sellable to more than one company.

| | Ameya | Ordence |
|---|---|---|
| Land, title chain, heirs, JDA | ✅ | ❌ |
| RA bills with BOCW cess + retention + 194C | ✅ | ❌ |
| RERA 70/30 escrow split | ✅ | ❌ |
| POCM revenue recognition (Ind-AS 115) | ✅ | ❌ |
| Labour UAN / BOCW welfare | ✅ | ❌ |
| Litigation ladder to REAT, IBC moratorium | ✅ | ❌ |
| Multi-tenancy + RLS | ❌ | ✅ |
| Plans, entitlements, metering | ❌ | ✅ |
| Platform admin, impersonation with consent | ❌ | ✅ |
| GST rate history, GSTR-2B, TDS returns, Tally | partial | ✅ |

So: port the domain onto the chassis.

---

## ⚠️ The rule that applies to every single ported table

Ameya's tables have no tenant column. Ordence's have one, plus RLS, plus a
composite foreign key. **A ported table that keeps Ameya's shape is a
cross-customer data leak** — every page would work, nothing would error, and
one developer would read another's land deals.

Every ported table therefore gets, without exception:

1. `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`
2. `ENABLE` **and** `FORCE` ROW LEVEL SECURITY
3. A policy keyed on `current_setting('app.current_tenant_id', true)`
4. `UNIQUE (id, tenant_id)` so children can reference `(id, tenant_id)`
5. Composite FKs on every child — never a bare `parent_id`
6. Money as `bigint` paise, rates as integer basis points, quantities as
   `numeric(18,3)`. Never a float.
7. Rules that must always hold go in a **trigger**, not a server action.

---

## ⭐ The security checklist, inherited free

Ameya's own `SECURITY-REMEDIATION-v15.88/89` and `SECURITY-v15.90` found 38
issues, then found **8 bypasses of the first round of fixes**. That second
number is the valuable one. Every item below is checked against Ordence as
its wave lands, and all of them before the public REST API ships:

- **Fail-open machine endpoints** — a cron/ingest route that trusts the
  caller when its secret is unset. Must 503 by default, never proceed.
- **SSRF in outbound fetches and webhooks** — blocked private ranges are
  bypassable via IPv4-mapped IPv6 (`::ffff:a9fe:a9fe`), NAT64, and via a
  302 redirect into an internal host. Re-resolve after every redirect.
- **Privilege escalation through a sibling path** — `createUser` was fixed;
  `approveAccessRequest` set roles unchecked and reopened it.
- **IDOR** — object-level auth on every mutation and every download, not
  just the list view.
- **Export scoping** — CSV exports returned org-wide rows regardless of
  hierarchy.
- **API token scope not enforced** — read-only tokens could write.
- **Secrets in query strings** — move to Bearer headers, compare in
  constant time.
- **CSV formula injection** in every export (`=`, `+`, `-`, `@` prefixes).
- **CSP allowing `unsafe-eval`**; `next/image` as an open proxy.
- **Auth hygiene** — CSPRNG for 2FA codes, rate limit them, revoke sessions
  on password change, hash reset tokens at rest.
- **Backups in plaintext** under predictable names.

**And the single most transferable finding:** *fixes applied to one code
path while a sibling path kept the old behaviour.* That is the argument for
putting every rule in the database, where all paths meet.

---

## ⚠️ Two things to keep in view while porting

**The source system is essentially empty.** Ameya's own ROADMAP and PENDING
say it plainly: *"Nothing above matters while the system is empty."* One
project in the switcher. So these 247 models are an extremely well-informed
*hypothesis* about what a developer needs — not 247 requirements proven by
daily use. Anything touching real money or a statutory deadline is treated
as high confidence. The rest is built, but built last.

**The source system's loudest complaint is clutter**, with a 14-batch
simplification plan that never got a go-ahead. Porting 247 models without
sequencing imports that problem. Hence waves, and hence the rule that a
module earns its screen by what it protects, not by what it stores.

---

## The waves

Ordered so that nothing waits on something unbuilt, and so the money and
the statutory deadlines come first.

### Wave A — Land, title and the JDA *(Phase 42)*
The beginning of a developer's asset lifecycle, and entirely absent from
Ordence. Nothing depends on it, so it is safe to build first.

`land_parcels` · `title_documents` · `title_chain_entries` · `landowners`
· `joint_development_agreements` · `land_conversions` · `khata_records`
· `estamp_certificates` · `powers_of_attorney` · `due_diligence_records`
· `approval_sanctions` · `liaison_logs` · `plan_sanctions`

⭐ Carry across, because an outsider would never guess them:
- `chain_order` on the deed chain, **so a gap is visible** rather than implied
- Landowner heir tree with `share_num`/`share_den` and `relinquish_deed_no`
- JDA `share_type` AREA_SHARE vs REVENUE_SHARE with developer/owner split
- Khata A / B / E — **B-khata is un-loanable**, which changes what can be sold
- Extent as acre **and** guntha; survey number, village, taluk, SRO office
- EC search window `period_from`/`period_to` — an EC is only as good as its window
- `sanctioned_far` vs `built_far` → `deviation_pct` gating **OC**

### Wave B — Construction execution and ⭐ RA bills *(Phase 43)*
The densest money model in the source system.

`ra_bills` · `ra_bill_lines` · `compliance_docs` · `structural_contracts`
· `engineer_certifications` · `boq_items` · `programme_activities`
· `activity_dependencies` · `progress_updates` · `delay_entries`
· `variation_orders` · `goods_receipts` · `drawing_transmittals`

⭐ The rules to encode as triggers, not screens:
- One RA bill = gross − previous paid, **1% BOCW cess**, **5% retention**,
  **194C TDS** → net payable. All four on one document.
- **A missing verified EPF/ESI challan blocks the vendor's settlement.**
  That is a policy; it belongs in the database.
- An uncleared engineer certification **blocks payment for that period**.
- Three-way match: ordered / received / billed quantity.
- `delay_entries.responsibility` — developer / contractor / consultant /
  authority / force majeure. This is the extension-of-time evidence pack,
  and it is what a claim turns on.

### Wave C — Labour and site *(Phase 44)*
`labour_uans` · `welfare_logs` · `piece_rate_entries` · `attendance`
· `duty_rosters` · `daily_site_logs` · `site_photos` · `vendor_defaults`

⭐ An invalid UAN flags the worker **at the gate**, not in a report.
⭐ BOCW welfare categories — creche, medical camp, drinking water,
sanitation — with headcount and photo as audit evidence.
⭐ `vendor_defaults` is cross-project: a subcontractor's abandonment
history follows him to the next site.

### Wave D — Capital, treasury and ⭐ revenue recognition *(Phase 45)*
`loan_facilities` · `loan_events` · `loan_covenants` · `investors`
· `investor_transactions` · `capital_stack_entries` · `escrow_movements`
· `bank_accounts` · `bank_statement_imports` · `bank_statement_lines`
· `cost_codes` · `budgets` · `budget_lines` · `budget_variances`
· `revenue_recognitions` · `feasibility_models`

⭐ POCM under Ind-AS 115: cost-to-date ÷ total estimated cost → percentage
→ revenue for the period, unique per project-period. Get this wrong and the
accounts are wrong in a way an auditor signs.
⭐ Covenant `direction` MIN/MAX with threshold vs current — **warn before
breach**, because after is too late.
⭐ Budget revisions `supersedes_id` rather than overwrite.

### Wave E — RERA escrow and sales depth *(Phase 46)*
`booking_escrow_splits` · `unit_pricing` · `parking_slots` · `home_loans`
· `sales_targets` · `incentive_slabs` · `incentive_entries` · `walk_ins`

⭐ The **70/30 split** is mandatory, per receipt, with a UTR on each leg.
⭐ A withdrawal from the designated account **stores the certified
percentage as evidence at the time of withdrawal** — not as a lookup later.
⭐ Pricing is floor rise + PLC + view premium, computed on read, never
stored as one number.
⭐ Home loan `noc_issued` (developer → bank) and `tripartite_signed`.

### Wave F — Legal and litigation *(Phase 47)*
`litigation_matters` · `litigation_hearings` · `litigation_escalations`
· `adr_cases` · `adr_events` · `vendor_insolvency_cases` · `trademarks`
· `trademark_events` · `contract_records` · `insurance_policies`

⭐ The forum ladder RERA → **REAT** → High Court → Supreme Court as a
self-referencing appeal chain.
⭐ IBC: an NCLT moratorium under s.14 **freezes vendor advances in code**.
⭐ Trademark class 37, renewal at ten years.

### Wave G — Quality, safety and environment *(Phase 48)*
`inspections` · `inspection_items` · `non_conformances` · `safety_records`
· `work_permits` · `statutory_obligations` · `compliance_doc_expiries`
· `env_clearance_conditions` · `waste_manifests` · `risk_entries`

⭐ `is_hold_point` — **work cannot be covered up until the inspection
passes.** That is the single most valuable field in this wave.
⭐ Work permits: hot work, height, confined space, lifting, excavation.
⭐ EC conditions tracked individually with evidence, and BREACHED as a state.

### Wave H — Leasing and post-handover *(Phase 49)*
`tenants_leasing` · `leases` · `rent_schedule_items` · `commercial_tenancies`
· `maintenance_charges` · `maintenance_requests` · `snag_tickets`
· `customer_documents` · `assets_facility` · `iot_readings`

### Wave I — Communications and automation *(Phase 50)*
`whatsapp_sessions` · `whatsapp_messages` · `message_templates`
· `email_sequences` · `sequence_steps` · `sequence_enrollments`
· `overdue_notices` · `campaigns` · `social_posts` · `automation_rules`
· `conversations` · `chat_messages`

⭐ `stop_on_stage` — a sequence exits when the lead reaches a status, not
just when they reply.
⭐ `overdue_notices` is a per-channel nudge ledger with `snoozed_until`,
which is how you avoid the 73-emails-in-three-days incident in Ameya's own
notes.
Note: Ameya never registered the Meta WhatsApp app and ran an unofficial
container instead. Ordence should do this properly or not at all.

### Wave J — Platform and extensibility *(Phase 51)*
`custom_field_defs` · `api_tokens` · `webhooks` · `saved_views`
· `saved_reports` · `number_sequences` · `data_requests` · `consent_records`
· `guest_sandboxes` (+ sandbox tables)

Much of this already exists in Ordence in a stronger form — Phase 24's
runtime custom objects supersede `CustomFieldDef`; Phase 25's views engine
supersedes `SavedView`. Port only the genuine gaps:
⭐ `number_sequences` driving human document numbers (LEAD-2044, RA-1001)
⭐ **DPDPA**: append-only `consent_records` where a withdrawal never erases
the earlier grant, plus export / delete / correction requests
⭐ A demo sandbox isolated **by separate tables**, not by a `WHERE` clause

---

## What is deliberately NOT ported

- **Prisma.** Ordence is Drizzle. The models come across; the ORM does not.
- **Anything already stronger in Ordence** — GST rate history, GSTR-2B
  reconciliation, TDS returns and challans, the Tally export keying,
  receivables and the dunning ladder, dynamic objects, saved views.
- **`SecretCashEntry`** — an OTP-locked private cash book. Defensible in a
  single-company system the owner controls. In a multi-tenant SaaS it is a
  hidden ledger we host on someone else's behalf, and it should be a
  conversation before it is a table.
- **The telephony AI engine, Razorpay, the letterhead** — built and idle in
  the source. Idle in one system is not evidence of need in another.

---

## Ordering principle

Money and statutory deadlines first. Then evidence you would need in a
dispute. Then convenience. A module earns its screen by what it protects.
