# Ordence — the 500-feature catalogue, audited against the code

**Every feature in your catalogue, checked against what is actually in the repository.**
Not a plan. A measurement — taken by reading the schema, the routes and the libraries,
not by remembering what we discussed.

| | Count | Share |
|---|---:|---:|
| ✅ Built | 35 | 7% |
| 🟡 Partial | 77 | 15% |
| ⬜ Not started | 388 | 77% |
| **Total** | **500** | |

**How to read this.** ✅ means the capability exists and is reachable. 🟡 means the hard
part — usually the schema, the isolation rules or an engine — is done and what remains is
a surface or a wiring job. ⬜ means nothing exists.

🟡 is the important column. It is where the cheapest wins are, because the expensive,
dangerous part is already built and tested.

---

## CRM · Contacts & Companies (1–20)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 1 | Unified contact timeline | 🟡 | `contacts`/`companies`/`deals` exist and audit_logs records changes; no single merged timeline view yet. |
| 2 | Company ↔ contact ↔ deal relationship graph | 🟡 | Relations exist in schema; `assetRelationships` proves the graph pattern. No visual explorer. |
| 3 | Duplicate detection with AI merge | ⬜ | Nothing. Needs a match key + review queue before AI is worth adding. |
| 4 | Custom fields of every type | ✅ | `customFieldDefinitions` + `dynamicFields`. Formula/rollup types still to add. |
| 5 | Field-level history and audit trail | ✅ | `auditLogs` is append-only and enforced by trigger, plus `change_log` captures old/new per column. |
| 6 | Contact enrichment from public sources | ⬜ | Needs an enrichment provider and a consent story first. |
| 7 | Social profile auto-linking | ⬜ |  |
| 8 | Household/group accounts (B2C) | ⬜ | Modelled cheaply later via dynamic objects. |
| 9 | Contact scoring with signal weights | ⬜ |  |
| 10 | Smart lists — dynamic saved segments | 🟡 | `savedViews` engine exists with filter trees; needs auto-refresh + list semantics. |
| 11 | Bulk edit with preview-before-apply | ⬜ | The preview-before-apply half is the valuable half. |
| 12 | GDPR/DPDPA consent tracking | 🟡 | `tenantSupportConsents` covers support access only, not marketing consent. |
| 13 | Do-not-contact / comms preferences | ⬜ |  |
| 14 | Ownership rules and round-robin | 🟡 | Lead owner exists on `leads`; no routing engine. |
| 15 | Org charts inside company records | ⬜ |  |
| 16 | Birthday/anniversary triggers | ⬜ | Cheap once the workflow engine has date-based triggers (it does). |
| 17 | Multi-language records + transliteration search | ⬜ | Matters for India. Postgres `unaccent` + trigram is the path. |
| 18 | Geo-map view of contacts/accounts | ⬜ |  |
| 19 | VCard/CSV/Excel import with mapping memory | ⬜ | High priority — it is the migration on-ramp from Zoho/Salesforce. |
| 20 | Business-card scan → contact (mobile) | ⬜ | Blocked on there being a mobile app at all. |

## CRM · Pipeline & Deals (21–40)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 21 | Drag-drop kanban with per-stage automation | ✅ | `/sales/leads` board + `lib/sales/pipeline.ts`; workflow triggers fire on stage change. |
| 22 | Multiple pipelines per tenant | 🟡 | One pipeline shape today. Schema change plus a picker. |
| 23 | Weighted forecast by stage probability | ⬜ |  |
| 24 | Deal rotting alerts | ⬜ | Trivial on the existing time-based workflow trigger. |
| 25 | Required fields per stage | ⬜ |  |
| 26 | Deal splits across reps for commission | 🟡 | `lib/sales/commission.ts` computes partner commission; no rep splits. |
| 27 | Products/line items with margin | 🟡 | `invoiceLines` exists; deals have no line items. |
| 28 | Multi-currency deals with FX snapshots | ⬜ | Money is BigInt paise throughout — currency is a real schema change, not a display one. |
| 29 | Win/loss reasons with analytics | ⬜ |  |
| 30 | Competitor tracking per deal | ⬜ |  |
| 31 | Deal rooms — shared page with the buyer | 🟡 | `portalLinks` already does tokenised external access; deal rooms are a new surface on it. |
| 32 | E-signature on deal documents | ✅ | `contractSignatures` with audit trail. |
| 33 | Stage-conversion funnel analytics | ⬜ |  |
| 34 | Sales velocity metrics | ⬜ |  |
| 35 | Kanban swimlanes | ⬜ |  |
| 36 | Gantt of expected closes | ⬜ |  |
| 37 | Renewal pipelines from won deals | ⬜ |  |
| 38 | Approval gates for discounts | 🟡 | `workflowTasks` is a general approval engine; not wired to discounts. |
| 39 | Deal templates | ⬜ |  |
| 40 | Next-best-action AI per deal | ⬜ | Wave D. |

## CRM · Activities, Tasks & Calendar (41–55)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 41 | Two-way Google/Microsoft calendar sync | ⬜ | Big one. OAuth + webhook + conflict resolution. |
| 42 | Meeting scheduler pages per rep | ⬜ |  |
| 43 | Round-robin and collective scheduling | ⬜ |  |
| 44 | Task queues with SLA timers | 🟡 | `workflowTasks` has assignment; no SLA clock. |
| 45 | Recurring tasks and cadences | ⬜ |  |
| 46 | Sequences: task+email+call playbooks | ⬜ |  |
| 47 | Meeting notes with AI summary | ⬜ | Wave D. |
| 48 | Voice memos transcribed | ⬜ |  |
| 49 | Daily agenda digest | ⬜ |  |
| 50 | Follow-up nudges on quiet threads | ⬜ |  |
| 51 | Time-zone-aware scheduling | ⬜ |  |
| 52 | In-app reminders + push | ⬜ |  |
| 53 | No-show automation | ⬜ |  |
| 54 | Route planning for field reps | ⬜ |  |
| 55 | Check-in/check-out geo-logging | 🟡 | `leadActivities` can hold visit records; no geo capture. |

## CRM · Email & Messaging (56–75)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 56 | Two-way email sync with thread matching | ⬜ | The single biggest missing CRM capability. Nothing works properly without it. |
| 57 | Shared team inboxes | ⬜ |  |
| 58 | Email templates with variables | 🟡 | `lib/email` has transactional templates; no tenant-editable library. |
| 59 | Open/click/reply tracking | ⬜ |  |
| 60 | Send-later, recipient-timezone send | ⬜ |  |
| 61 | AI email drafting in the rep's voice | ⬜ | Wave D. |
| 62 | AI thread summarisation | ⬜ | Wave D. |
| 63 | Sentiment detection | ⬜ |  |
| 64 | Attachment library with versions | 🟡 | `documents` + R2 storage; no library UI. |
| 65 | Spam-safe sending, domain health | ⬜ |  |
| 66 | DKIM/SPF/DMARC wizard per tenant | ⬜ |  |
| 67 | Signature manager | ⬜ |  |
| 68 | Snippets | ⬜ |  |
| 69 | Bounce/unsubscribe suppression | ⬜ | Legally load-bearing before any bulk send. |
| 70 | WhatsApp Business API inbox | ⬜ | Highest-value channel for the India market. |
| 71 | SMS conversations | ⬜ |  |
| 72 | Telegram/Instagram/Messenger inbox | ⬜ |  |
| 73 | Internal comments and @mentions | ⬜ |  |
| 74 | Collision detection | ⬜ |  |
| 75 | Conversation CSAT micro-surveys | ⬜ |  |

## CRM · Calling & Telephony (76–90)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 76 | Click-to-call (WebRTC) | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 77 | Call recording with consent | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 78 | AI transcription to timeline | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 79 | Live talk-track prompts | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 80 | Local presence numbers | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 81 | Power dialer | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 82 | Voicemail drop | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 83 | Outcome dispositions | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 84 | Whisper/barge/listen coaching | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 85 | Callback scheduling | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 86 | IVR builder | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 87 | Call SLA dashboards | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 88 | Twilio/Exotel/Knowlarity/Plivo adapters | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 89 | AI-assisted call scorecards | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |
| 90 | Spam-likely number hygiene | ⬜ | No telephony layer exists at all. One adapter (Exotel or Twilio) unlocks 76–85 together. |

## CRM · Marketing & Campaigns (91–115)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 91 | Visual email campaign builder | ⬜ |  |
| 92 | Landing page builder on tenant domain | ⬜ | Also the cross-sell engine — see the web-dev plan. |
| 93 | Web forms with spam protection | ⬜ | Start here: forms are the cheapest path to first value. |
| 94 | Marketing automation canvas | ⬜ | The workflow engine already does this shape — reuse, do not rebuild. |
| 95 | Lead scoring fit + behaviour | ⬜ |  |
| 96 | Drip nurture journeys | ⬜ |  |
| 97 | A/B/n with auto-winner | ⬜ |  |
| 98 | UTM capture and attribution | ⬜ |  |
| 99 | Campaign ROI tied to closed deals | ⬜ | The number that justifies the whole module. |
| 100 | Event/webinar module | ⬜ |  |
| 101 | QR campaigns with scan analytics | ⬜ |  |
| 102 | Referral engine | ⬜ |  |
| 103 | Review-request flows | ⬜ |  |
| 104 | Social scheduler with approvals | ⬜ |  |
| 105 | Server-side audience sync | ⬜ |  |
| 106 | Suppression lists and frequency caps | ⬜ |  |
| 107 | Preference centre pages | ⬜ |  |
| 108 | AI subject-line variants | ⬜ |  |
| 109 | Newsletter with tenant sending domain | ⬜ |  |
| 110 | Pop-ups/banners with targeting | ⬜ |  |
| 111 | Cart-abandonment journeys | ⬜ |  |
| 112 | Lifecycle stages | ⬜ |  |
| 113 | Multi-language variants | ⬜ |  |
| 114 | Send-time optimisation | ⬜ |  |
| 115 | Marketing calendar | ⬜ |  |

## CRM · Lead Capture & Routing (116–130)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 116 | Instant lead routing at the edge | 🟡 | Middleware runs at the edge already; no routing engine. |
| 117 | Speed-to-lead dashboard | ⬜ | The one metric that most predicts conversion. Cheap once activities are timestamped. |
| 118 | Lead source taxonomy | 🟡 | `leads.source` is free text; needs a controlled vocabulary. |
| 119 | Round-robin with capacity and hours | ⬜ |  |
| 120 | Territory management | ⬜ |  |
| 121 | Lead-to-account matching | ⬜ |  |
| 122 | Facebook/Google lead-form ingestion | ⬜ | Direct revenue impact for the India SMB market. |
| 123 | Chat widget with AI qualification | ⬜ |  |
| 124 | AI phone receptionist | ⬜ |  |
| 125 | Missed-call → WhatsApp text-back | ⬜ | Cheap, and disproportionately loved by Indian SMBs. |
| 126 | Portal adapters (99acres, JustDial) | ⬜ | Real-estate pack depends on this. |
| 127 | Duplicate-lead merge on entry | ⬜ |  |
| 128 | Junk-lead ML filter | ⬜ |  |
| 129 | SLA escalation chains | 🟡 | Workflow engine can express it; no lead-specific SLA model. |
| 130 | Lead recycling pools | ⬜ |  |

## CRM · Sales Intelligence & AI (131–155)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 131 | AI assistant on every screen | ⬜ | Wave D foundation. Everything 131–155 waits on the RAG + agent layer. |
| 132 | Deal-risk scoring with explanations | ⬜ |  |
| 133 | AI vs committed forecast | ⬜ |  |
| 134 | Churn-risk early warning | ⬜ |  |
| 135 | Whitespace analysis | ⬜ |  |
| 136 | Lookalike lead discovery | ⬜ |  |
| 137 | Meeting-prep briefs | ⬜ |  |
| 138 | Auto-logged everything | ⬜ | Depends on email + calendar sync existing first. |
| 139 | Relationship strength scoring | ⬜ |  |
| 140 | Buying-committee detection | ⬜ |  |
| 141 | Price-sensitivity suggestions | ⬜ |  |
| 142 | Anomaly alerts | ⬜ |  |
| 143 | Natural-language reporting | ⬜ |  |
| 144 | AI data hygiene | ⬜ |  |
| 145 | Conversation intelligence | ⬜ |  |
| 146 | Competitor-mention tracking | ⬜ |  |
| 147 | Generative account plans | ⬜ |  |
| 148 | Smart morning digests | ⬜ |  |
| 149 | Objection-handling suggestions | ⬜ |  |
| 150 | Translation layer | ⬜ |  |
| 151 | AI role-play trainer | ⬜ |  |
| 152 | First-party intent signals | ⬜ |  |
| 153 | Why-this-score transparency | ⬜ | Non-negotiable if any of the above ship. |
| 154 | Per-tenant AI model + privacy settings | ⬜ | Must exist before AI touches customer data. |
| 155 | Human-approval mode for AI actions | ⬜ | Ship this with the first agent, not after. |

## CRM · Quotes, CPQ & Documents (156–170)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 156 | Quote builder with bundles and tiers | 🟡 | `invoices`/`invoiceLines` and price logic exist; no quote object. |
| 157 | Guided selling questionnaires | ⬜ |  |
| 158 | Discount approval matrices | 🟡 | `workflowTasks` approvals exist, unwired. |
| 159 | Proposal documents from templates | 🟡 | `lib/documents/render.ts` renders branded documents. |
| 160 | Interactive web quotes | 🟡 | `portalLinks` is the delivery mechanism, already built. |
| 161 | E-sign with audit certificate | ✅ | `contractSignatures`. |
| 162 | Payment link in quote | 🟡 | Razorpay/Stripe wired for invoices; not quotes. |
| 163 | Quote expiry with follow-up | ⬜ |  |
| 164 | Contract repository with renewals | ✅ | `contracts` + `contractVersions`. |
| 165 | Clause library and redlines | ✅ | `clauseLibrary`. |
| 166 | Multi-language multi-currency output | ⬜ |  |
| 167 | Margin guardrails for managers | ⬜ |  |
| 168 | Document analytics | ⬜ |  |
| 169 | Accepted quote → order → invoice | 🟡 | Invoice side exists; no order object. |
| 170 | Version compare between revisions | 🟡 | `contractVersions` stores them; no diff UI. |

## CRM · Customer Service & Success (171–195)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 171 | Ticketing with SLA policies | ⬜ | No ticket object exists. This is a whole module. |
| 172 | Omnichannel queue | ⬜ | Depends on 56/70. |
| 173 | Knowledge base on tenant domain | ⬜ |  |
| 174 | AI answer bot grounded in tenant KB | ⬜ |  |
| 175 | Deflection analytics | ⬜ |  |
| 176 | CSAT/NPS/CES | ⬜ |  |
| 177 | Customer health scores | ⬜ |  |
| 178 | Success playbooks | ⬜ |  |
| 179 | Escalation matrices | ⬜ |  |
| 180 | Field-service scheduling | ⬜ |  |
| 181 | Installed-base tracking | ⬜ | `assets` is close to this already. |
| 182 | Warranty and AMC | ⬜ |  |
| 183 | Loaner/replacement flows | ⬜ |  |
| 184 | Community forum | ⬜ |  |
| 185 | Status pages | ⬜ |  |
| 186 | In-app guides | ⬜ |  |
| 187 | Renewal management | ⬜ |  |
| 188 | Voice-of-customer clustering | ⬜ |  |
| 189 | Refund/return cases | ⬜ |  |
| 190 | Billable support time | ⬜ |  |
| 191 | Unified customer portal | ⬜ | `portalLinks` gives you the auth model for free. |
| 192 | Proactive customer alerts | ⬜ |  |
| 193 | Agent assist with citations | ⬜ |  |
| 194 | Skills-based routing | ⬜ |  |
| 195 | FCR analytics | ⬜ |  |

## CRM · Analytics & Reporting (196–215)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 196 | Dashboard builder with TV mode | 🟡 | `/dashboard` exists with fixed charts; not a builder. |
| 197 | Scheduled report delivery | ⬜ |  |
| 198 | Cohort analysis | ⬜ |  |
| 199 | Rep leaderboards | ⬜ |  |
| 200 | Activity vs outcome correlation | ⬜ |  |
| 201 | SQL-free metric builder | 🟡 | `lib/views/registry.ts` derives fields from Drizzle metadata — the hard half is done. |
| 202 | Cross-object reporting | 🟡 | Same engine, needs joins. |
| 203 | Goal tracking with pace lines | ⬜ |  |
| 204 | Funnel visualisation | ⬜ |  |
| 205 | Attribution model comparison | ⬜ |  |
| 206 | Data export API + webhooks | 🟡 | `server/backup/export.ts` does full export; no public API. |
| 207 | Embedded analytics in portals | ⬜ |  |
| 208 | Snapshot history | 🟡 | `change_log` makes point-in-time reconstruction possible. |
| 209 | Opt-in cross-tenant benchmarks | ⬜ | Needs an explicit consent gate — do not build casually. |
| 210 | Alert rules on any metric | ⬜ |  |
| 211 | Report permissions by role | 🟡 | RBAC exists (`roles`, `permissions`). |
| 212 | Currency-normalised rollups | ⬜ |  |
| 213 | PDF board-pack export | ⬜ |  |
| 214 | CRM adoption heatmap | 🟡 | `webVitalEvents` + `usageCounters` hold the raw signal. |
| 215 | Chart annotation layer | ⬜ |  |

## CRM · Automation & Workflow Engine (216–235)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 216 | Visual workflow builder | ✅ | `components/workflows/workflow-builder.tsx`, 6 triggers, 13 actions. |
| 217 | Cross-module automation | 🟡 | Engine supports it; targets limited to built modules. |
| 218 | Time-based triggers | ✅ |  |
| 219 | Webhook in/out with signing | 🟡 | Inbound webhooks for Clerk/Razorpay/Stripe are signed; no tenant-defined outbound. |
| 220 | Sandboxed code steps | ⬜ | Deliberately deferred — arbitrary code in a shared Worker needs care. |
| 221 | Approval workflows with delegation | ✅ | `workflowTasks` + approvals inbox. |
| 222 | Human-in-the-loop pause | ✅ |  |
| 223 | Error queues with replay | 🟡 | `workflowRunSteps` records failure; no replay. |
| 224 | Versioned workflows draft/publish | ✅ | `workflowVersions`. |
| 225 | Template gallery per industry | ⬜ | Direct dependency of the industry packs. |
| 226 | Rate-limit-aware bulk actions | 🟡 | `lib/security/rate-limit.ts`. |
| 227 | Scheduled batch jobs | 🟡 | `/api/workers` + cron; inline fallback on Workers. |
| 228 | Formula fields with rollups | ⬜ |  |
| 229 | Auto-create related record trees | 🟡 | Single record creation exists. |
| 230 | Field-change triggers old/new | ✅ | `change_log` supplies both values. |
| 231 | Multi-tenant automation isolation | ✅ | Chain guard plus RLS; tested. |
| 232 | Dry-run simulation mode | ⬜ | High value, low cost. Build with the admin panel. |
| 233 | Per-record audit of automated actions | ✅ | `auditLogs` + `workflowRunSteps`. |
| 234 | Kill-switch with blast radius | 🟡 | Workflows can be unpublished; no blast-radius report. |
| 235 | Workflow template marketplace | ⬜ |  |

## CRM · Collaboration & Mobile (236–250)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 236 | Record following | ⬜ |  |
| 237 | Team chat on records | ⬜ |  |
| 238 | Gamification | ⬜ |  |
| 239 | Co-browse | ⬜ |  |
| 240 | Guest collaborators | ⬜ | `portalLinks` is 80% of this. |
| 241 | Offline-capable PWA | ⬜ | The desktop build at /root/ameya-desktop proved PGlite runs the whole schema offline — that work transfers. |
| 242 | Mobile event lead capture | ⬜ |  |
| 243 | Voice commands | ⬜ |  |
| 244 | WhatsApp bot for reps | ⬜ |  |
| 245 | Push-first approvals | ⬜ |  |
| 246 | WhatsApp catalog sync | ⬜ |  |
| 247 | Home-screen widgets | ⬜ |  |
| 248 | Biometric app lock | ⬜ |  |
| 249 | Low-bandwidth mode | ⬜ |  |
| 250 | In-tenant announcements | ⬜ |  |

## ERP · Inventory & Warehouse (251–270)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 251 | Multi-warehouse stock with bins | ⬜ | No inventory module. `units` is real-estate inventory, a different thing. |
| 252 | Real-time stock sync to quotes | ⬜ |  |
| 253 | Batch/lot with expiry | ⬜ |  |
| 254 | Serial-number lifecycle | ⬜ |  |
| 255 | Barcode/QR scanning | ⬜ |  |
| 256 | Reorder points → draft POs | ⬜ |  |
| 257 | ABC and dead-stock analysis | ⬜ |  |
| 258 | Transfers with in-transit | ⬜ |  |
| 259 | Cycle counting | ⬜ |  |
| 260 | Kitting and bundles | ⬜ |  |
| 261 | UoM conversions | ⬜ |  |
| 262 | Landed-cost allocation | ⬜ | Ties into `purchaseInvoices`, which exists. |
| 263 | FIFO/weighted-average costing | ⬜ |  |
| 264 | Negative-stock guards | ⬜ |  |
| 265 | Consignment stock | ⬜ |  |
| 266 | Warranty stock segregation | ⬜ |  |
| 267 | Putaway and pick-path | ⬜ |  |
| 268 | Packaging suggestions | ⬜ |  |
| 269 | FEFO picking | ⬜ |  |
| 270 | Stock aging | ⬜ |  |

## ERP · Procurement (271–285)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 271 | Requisitions with approvals | 🟡 | `workflowTasks` supplies approvals; no requisition object. |
| 272 | RFQ with quote comparison | ⬜ |  |
| 273 | Vendor scorecards | 🟡 | `vendors` exists; no scoring. |
| 274 | Blanket POs | ⬜ |  |
| 275 | Three-way match | 🟡 | `purchaseInvoices` + `itcRegister` do invoice matching; no PO or GRN. |
| 276 | Partial receipts and tolerances | ⬜ |  |
| 277 | Vendor portals | 🟡 | `portalLinks` again. |
| 278 | Auto-PO from reorder rules | ⬜ |  |
| 279 | Import purchase with duty/forex | ⬜ |  |
| 280 | Contract pricing windows | ⬜ |  |
| 281 | Vendor KYC onboarding | 🟡 | `vendors` carries GSTIN and MSME status. |
| 282 | Payment schedules against POs | 🟡 | `vendorLedgerEntries`. |
| 283 | Debit notes and returns | ⬜ |  |
| 284 | Spend analytics | ⬜ |  |
| 285 | Approval limits by role/amount | 🟡 | RBAC + approvals exist, unwired. |

## ERP · Manufacturing (286–300)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 286 | Multi-level BOM | ⬜ | No manufacturing module. Note: `boqs` is construction Bill of Quantities — a different animal from a Bill of Materials. |
| 287 | Work orders with routing | ⬜ |  |
| 288 | Capacity scheduling | ⬜ |  |
| 289 | Shop-floor terminal | ⬜ |  |
| 290 | Material issue and backflush | ⬜ |  |
| 291 | Scrap and yield | ⬜ |  |
| 292 | Quality gates | ⬜ |  |
| 293 | NCR and CAPA | ⬜ |  |
| 294 | Subcontracting/job work | ⬜ |  |
| 295 | Preventive maintenance | ⬜ |  |
| 296 | OEE dashboards | ⬜ |  |
| 297 | Standard vs actual cost | ⬜ |  |
| 298 | Engineering change orders | ⬜ |  |
| 299 | By-product accounting | ⬜ |  |
| 300 | Batch production records | ⬜ |  |

## ERP · Finance & Accounting (301–325)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 301 | Double-entry ledger under everything | ✅ | `ledgers`, `transactions`, `journalEntries`. Balance enforced by database trigger, not by application code. |
| 302 | Invoice builder, branded, recurring | 🟡 | `invoices` + `invoiceLines`; recurring not built. |
| 303 | GST invoicing, e-invoice, e-way | 🟡 | GST schema and rate engine built (dated rates via EXCLUDE gist). IRP/e-way integration not built. |
| 304 | GSTR-1/3B reports | ⬜ | GSTR-2B reconciliation IS built; 1 and 3B are not. |
| 305 | TDS/TCS with certificates | ✅ | `tdsDeductions`, `tdsCertificates`, cumulative thresholds, challans, returns. |
| 306 | Payment links on invoices | ✅ | Razorpay + Stripe. |
| 307 | Bank feed reconciliation | ⬜ |  |
| 308 | Dunning for receivables | ✅ | `dunningPolicies`, `demandNotices` in six languages, `dunningEvents`. |
| 309 | Credit limits at order entry | ⬜ |  |
| 310 | AR/AP aging | 🟡 | Receivables side exists. |
| 311 | Expense claims with OCR | ⬜ |  |
| 312 | Multi-entity accounting | 🟡 | Tenant isolation is the mechanism; sub-entities not modelled. |
| 313 | Cost and profit centres | 🟡 | `tallyCostCentreMappings` implies the concept. |
| 314 | Budgets vs actuals | ⬜ |  |
| 315 | Fixed-asset register | 🟡 | `assets` is a CRM asset, not a depreciating fixed asset. |
| 316 | Journal approvals and period locks | ✅ | `financialPeriods` with close/lock. |
| 317 | Cash-flow forecasting | ⬜ |  |
| 318 | Deferred revenue schedules | ⬜ |  |
| 319 | Audit trail export | ✅ | `server/backup/export.ts`. |
| 320 | Price lists | ⬜ |  |
| 321 | Credit/debit notes | 🟡 | Purchase side has debit notes. |
| 322 | Petty cash | ⬜ | Phase 39 — the conversation you wanted to have first. |
| 323 | P&L, balance sheet, cash flow | 🟡 | Ledger supports it; no statement renderer. |
| 324 | Consolidated group reporting | ⬜ |  |
| 325 | Accountant guest role | 🟡 | RBAC can express it. |

## ERP · Billing & Subscriptions (326–340)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 326 | Plans with trials and proration | ✅ | `plans`, `subscriptions`. |
| 327 | Usage/metered billing | 🟡 | `usageCounters`, `usageLevels` meter; no rating engine. |
| 328 | Hybrid invoices | ⬜ |  |
| 329 | Self-serve billing portal | ✅ | `/settings/billing`. |
| 330 | Smart dunning retries | 🟡 | `paymentEvents` records failures. |
| 331 | Coupons and credits | ⬜ |  |
| 332 | Revenue recognition | ⬜ |  |
| 333 | MRR/ARR/churn/LTV | ⬜ | Belongs in the Revenue Observatory. |
| 334 | Reseller commission statements | 🟡 | `lib/sales/commission.ts` is reusable. |
| 335 | Multi-gateway routing | 🟡 | Both gateways exist; no routing rules. |
| 336 | Tax engines per jurisdiction | 🟡 | India GST built. |
| 337 | Grace periods and suspension | 🟡 | `entitlements` gates features. |
| 338 | Plan-change history | 🟡 | `change_log`. |
| 339 | Invoice sequencing per entity | ✅ | Statutory prefix and sequence. |
| 340 | Gateway token vaulting | ✅ | `paymentMethods` stores tokens only — no card data ever touches our servers. |

## ERP · HR & Payroll (341–355)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 341 | Employee directory and org chart | ⬜ | No HR module. `users` is app access, not employment. |
| 342 | Geo-fenced attendance | ⬜ |  |
| 343 | Shift rosters | ⬜ |  |
| 344 | Leave policies and accruals | ⬜ |  |
| 345 | India payroll: PF, ESI, PT, TDS | ⬜ | TDS engine exists and is reusable; the rest is new. |
| 346 | Reimbursements | ⬜ |  |
| 347 | Onboarding/offboarding checklists | ⬜ |  |
| 348 | Appraisals and OKRs | ⬜ |  |
| 349 | Recruitment pipeline | ⬜ | Reuses the kanban engine — cheapest HR feature to ship. |
| 350 | Offer letters with e-sign | ⬜ | `contractSignatures` transfers directly. |
| 351 | Timesheets billable to projects | ⬜ |  |
| 352 | Training and certification expiry | ⬜ |  |
| 353 | Employee self-service | ⬜ |  |
| 354 | HR case management | ⬜ |  |
| 355 | Attrition analytics | ⬜ |  |

## ERP · Projects & Services (356–370)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 356 | Project boards from won deals | 🟡 | `projects` exists but is a real-estate development project, not a services project. Needs a second shape. |
| 357 | Gantt with critical path | ⬜ |  |
| 358 | Resource heatmap | ⬜ |  |
| 359 | Estimate vs actual vs billed | ⬜ |  |
| 360 | Milestone billing | 🟡 | `paymentMilestones` exists for bookings. |
| 361 | Retainers with hour-bank | ⬜ |  |
| 362 | Client-visible project portals | 🟡 | `portalLinks`. This is the web-dev cross-sell surface. |
| 363 | Deliverable approval gates | 🟡 | Approvals engine. |
| 364 | Time tracking | ⬜ |  |
| 365 | Profitability per project | ⬜ |  |
| 366 | Service templates | ⬜ |  |
| 367 | Risk/issue registers | ⬜ |  |
| 368 | Change-request workflow | ⬜ |  |
| 369 | Capacity-based delivery dates | ⬜ |  |
| 370 | Post-mortem records | ⬜ |  |

## ERP · Supply Chain & Orders (371–385)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 371 | Order management | ⬜ | No order object. Blocks 372–385 and 169. |
| 372 | Available-to-promise | ⬜ |  |
| 373 | Pick-pack-ship | ⬜ |  |
| 374 | Courier integrations | ⬜ |  |
| 375 | Tracking pages on tenant domain | ⬜ |  |
| 376 | COD reconciliation | ⬜ |  |
| 377 | RMA flows | ⬜ |  |
| 378 | Drop-shipping | ⬜ |  |
| 379 | Backorders | ⬜ |  |
| 380 | Own-fleet route planning | ⬜ |  |
| 381 | Proof of delivery | ⬜ |  |
| 382 | Demand forecasting | ⬜ |  |
| 383 | Fill-rate and OTIF | ⬜ |  |
| 384 | EDI/CSV ingestion | ⬜ |  |
| 385 | Distributor portals | ⬜ |  |

## Platform · Multi-Tenant & White-Label (386–400)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 386 | Tenant provisioning in under 60s | 🟡 | `tenants` + Clerk orgs; no wizard. Admin panel item 2. |
| 387 | Custom domains with automatic TLS | ⬜ | Cloudflare for SaaS. Needed before any tenant goes live on their own domain. |
| 388 | Per-tenant theming from one token | ✅ |  |
| 389 | White-label mode | 🟡 | Theming built; no logo/powered-by controls. |
| 390 | Per-tenant feature flags | ✅ | `platformTenantFlags` + `lib/entitlements`. |
| 391 | Usage quotas with graceful limits | ✅ | `usageCounters`, `usageLevels`. |
| 392 | Sandbox tenants | ⬜ |  |
| 393 | Cross-tenant template marketplace | ⬜ |  |
| 394 | Self-serve tenant data export | 🟡 | Export exists; not self-serve. |
| 395 | Regional data residency | ⬜ |  |
| 396 | Per-tenant sending identities | ⬜ |  |
| 397 | Tenant health score | ⬜ | Admin panel item 3. |
| 398 | In-tenant admin | ✅ | `/settings/team`, roles, permissions. |
| 399 | Tenant-facing changelog | ⬜ |  |
| 400 | Agency mode | ⬜ | The web-dev arm depends on this. |

## Platform · Security, Access & Compliance (401–410)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 401 | RBAC with record-level sharing | ✅ | `roles`, `permissions`, `rolePermissions`, `userRoles` + RLS underneath. |
| 402 | SSO per tenant | 🟡 | Clerk provides Google/Microsoft; SAML/OIDC per tenant not configured. |
| 403 | 2FA/passkeys, device management | 🟡 | Clerk capability, not surfaced. |
| 404 | Field-level encryption | ⬜ |  |
| 405 | IP allow-lists and login hours | ⬜ |  |
| 406 | Tamper-evident audit log | ✅ | Append-only, enforced by trigger — even a superuser cannot rewrite it. |
| 407 | Retention policies with legal hold | ⬜ |  |
| 408 | DSR export/erase tooling | 🟡 | Export built; cross-module erase not. |
| 409 | Anomalous-access alerts | 🟡 | `securityEvents` records; no alerting. |
| 410 | Scoped API keys with rotation | ⬜ | Blocks 411. |

## Platform · Developer & Integrations (411–420)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 411 | REST + webhook API for every object | ⬜ | Blocked on 410. High priority — it is what makes 412/416/418 possible. |
| 412 | Zapier/Make connectors | ⬜ |  |
| 413 | Native integrations | 🟡 | Tally BUILT (deterministic REMOTEID, export batches, reconciliation). Razorpay/Stripe BUILT. Google/M365/Slack not. |
| 414 | Embedded iframe widgets | ⬜ |  |
| 415 | Custom objects | ✅ | `dynamicObjects` + `dynamic_create_object_table()` which refuses to create a table without RLS. This is the universal-CRM keystone and it is done. |
| 416 | App marketplace | ⬜ |  |
| 417 | CLI + sandbox | ⬜ |  |
| 418 | Event stream (CDC) | 🟡 | `change_log` is exactly a CDC feed — needs an outbound transport. |
| 419 | Import wizard from Zoho/Salesforce/HubSpot | ⬜ | Highest-leverage unbuilt integration: it is how customers arrive. |
| 420 | FTP/email-inbox ingestion | ⬜ |  |

## Industry Pack · Real Estate (421–428)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 421 | Unit/tower inventory with availability grid | ✅ | `projects`, `units`, `/sales/inventory`. |
| 422 | Site-visit scheduling with geo check-in | 🟡 | `leadActivities`; no geo. |
| 423 | Broker/channel-partner portals with payouts | 🟡 | `channelPartners` + commission engine built; no portal. |
| 424 | Cost sheets and payment schedules | ✅ | `paymentMilestones`, `lib/sales/payment-plan.ts` — remainder lands on the last stage so the sum equals the agreement value exactly. |
| 425 | RERA documentation trails | 🟡 | Audit log + documents; no RERA-specific pack. |
| 426 | Demand letters tied to construction stages | ✅ | `demandNotices` + construction milestones. |
| 427 | Possession/handover checklists | ⬜ |  |
| 428 | Resale/rental lifecycle | ⬜ |  |

## Industry Pack · Healthcare & Clinics (429–436)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 429 | Pack feature 429 | ⬜ | Confidential-record tiers must come first — health data changes the RLS story. |
| 430 | Pack feature 430 | ⬜ |  |
| 431 | Pack feature 431 | ⬜ |  |
| 432 | Pack feature 432 | ⬜ |  |
| 433 | Pack feature 433 | ⬜ |  |
| 434 | Pack feature 434 | ⬜ |  |
| 435 | Pack feature 435 | ⬜ |  |
| 436 | Pack feature 436 | ⬜ |  |

## Industry Pack · Education & Coaching (437–444)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 437 | Pack feature 437 | ⬜ | Closest to shippable: admission funnel is the lead pipeline, fee plans are the payment-milestone engine. |
| 438 | Pack feature 438 | ⬜ |  |
| 439 | Pack feature 439 | ⬜ |  |
| 440 | Pack feature 440 | ⬜ |  |
| 441 | Pack feature 441 | ⬜ |  |
| 442 | Pack feature 442 | ⬜ |  |
| 443 | Pack feature 443 | ⬜ |  |
| 444 | Pack feature 444 | ⬜ |  |

## Industry Pack · Financial Services (445–452)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 445 | Pack feature 445 | ⬜ | KYC expiry and commission reconciliation both reuse existing engines. |
| 446 | Pack feature 446 | ⬜ |  |
| 447 | Pack feature 447 | ⬜ |  |
| 448 | Pack feature 448 | ⬜ |  |
| 449 | Pack feature 449 | ⬜ |  |
| 450 | Pack feature 450 | ⬜ |  |
| 451 | Pack feature 451 | ⬜ |  |
| 452 | Pack feature 452 | ⬜ |  |

## Industry Pack · Retail & D2C (453–460)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 453 | Pack feature 453 | ⬜ | Blocked on inventory (251–270) and orders (371). |
| 454 | Pack feature 454 | ⬜ |  |
| 455 | Pack feature 455 | ⬜ |  |
| 456 | Pack feature 456 | ⬜ |  |
| 457 | Pack feature 457 | ⬜ |  |
| 458 | Pack feature 458 | ⬜ |  |
| 459 | Pack feature 459 | ⬜ |  |
| 460 | Pack feature 460 | ⬜ |  |

## Industry Pack · Manufacturing & Distribution (461–468)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 461 | Pack feature 461 | ⬜ | Blocked on manufacturing (286–300). |
| 462 | Pack feature 462 | ⬜ |  |
| 463 | Pack feature 463 | ⬜ |  |
| 464 | Pack feature 464 | ⬜ |  |
| 465 | Pack feature 465 | ⬜ |  |
| 466 | Pack feature 466 | ⬜ |  |
| 467 | Pack feature 467 | ⬜ |  |
| 468 | Pack feature 468 | ⬜ |  |

## Industry Pack · Hospitality & Events (469–476)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 469 | Pack feature 469 | ⬜ | Availability calendar is the unit-inventory grid with a date axis. |
| 470 | Pack feature 470 | ⬜ |  |
| 471 | Pack feature 471 | ⬜ |  |
| 472 | Pack feature 472 | ⬜ |  |
| 473 | Pack feature 473 | ⬜ |  |
| 474 | Pack feature 474 | ⬜ |  |
| 475 | Pack feature 475 | ⬜ |  |
| 476 | Pack feature 476 | ⬜ |  |

## Industry Pack · Legal & Professional Services (477–484)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 477 | Pack feature 477 | ⬜ | Matter management maps onto contracts + projects; time-and-billing is new. |
| 478 | Pack feature 478 | ⬜ |  |
| 479 | Pack feature 479 | ⬜ |  |
| 480 | Pack feature 480 | ⬜ |  |
| 481 | Pack feature 481 | ⬜ |  |
| 482 | Pack feature 482 | ⬜ |  |
| 483 | Pack feature 483 | ⬜ |  |
| 484 | Pack feature 484 | ⬜ |  |

## Industry Pack · Logistics & Transport (485–492)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 485 | Pack feature 485 | ⬜ | Blocked on orders and fleet objects. |
| 486 | Pack feature 486 | ⬜ |  |
| 487 | Pack feature 487 | ⬜ |  |
| 488 | Pack feature 488 | ⬜ |  |
| 489 | Pack feature 489 | ⬜ |  |
| 490 | Pack feature 490 | ⬜ |  |
| 491 | Pack feature 491 | ⬜ |  |
| 492 | Pack feature 492 | ⬜ |  |

## Industry Pack · Agencies & Studios (493–500)

| # | Feature | Status | Note |
|---:|---|:--:|---|
| 493 | Pack feature 493 | ⬜ | Directly serves the web-dev arm — build this pack first for internal use. |
| 494 | Pack feature 494 | ⬜ |  |
| 495 | Pack feature 495 | ⬜ |  |
| 496 | Pack feature 496 | ⬜ |  |
| 497 | Pack feature 497 | ⬜ |  |
| 498 | Pack feature 498 | ⬜ |  |
| 499 | Pack feature 499 | ⬜ |  |
| 500 | Pack feature 500 | ⬜ |  |
