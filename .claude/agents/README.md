# Ordence — installed specialist agents

65 agents, chosen from a library of 272. The other 207 are not here on purpose.

## Why a subset

An agent library is not a toolbox where more is better. Every agent in this
folder is a name a future session has to choose between, and a menu of 272 —
half of them for game engines, Chinese social platforms, GIS scene rendering
and Solidity — makes the choice worse, not better. Each one kept below maps to
something in `docs/FEATURE-MAP-500.md` that is either built and needs
maintaining, or is next on the build order.

The excluded ones are excluded for a reason, not by accident: game development
(21), GIS (13), spatial computing (6), most regional marketing (Douyin, Zhihu,
WeChat, Xiaohongshu), Drupal/WordPress, and blockchain. If Ordence ever needs
one, the original archive is the place to get it.

## What was kept, and what it is for

### Engineering — the keystones from the build order

| Agent | Serves |
|---|---|
| `api-platform-engineer` | Features 410–411, the REST + webhook API. The whole integrations wave is blocked behind it. |
| `email-intelligence-engineer` | Feature 56, email sync — 16 features depend on it. |
| `payments-billing-engineer` | 326–340, already partly built. |
| `identity-access-engineer` | 401–410, RBAC and SSO. |
| `privacy-engineer` | 404–409, DPDPA, field-level encryption, DSR tooling. |
| `rag-pipeline-engineer` | Wave 6 — must arrive with 154/155, never after. |
| `i18n-engineer` | Feature 17 and 113. The demand notices already ship in six languages. |
| `database-optimizer`, `database-reliability-engineer` | 97 tables, 90 RLS policies, 270 triggers. |
| `search-relevance-engineer` | Transliteration search — a real requirement for Indian names. |
| `mobile-app-builder` | 241, the offline PWA. The desktop PGlite work transfers. |
| `voice-ai-integration-engineer` | 124, the AI receptionist. |
| `minimal-change-engineer` | For when the right fix is the smallest one. Worth having a voice that argues for it. |

### Security and testing

`appsec-engineer`, `security-architect`, `penetration-tester`,
`threat-detection-engineer`, plus `reality-checker`, `evidence-collector`,
`api-tester`, `performance-benchmarker`, `accessibility-auditor`,
`test-results-analyzer`.

> ⚠️ `reality-checker` and `evidence-collector` earn their place. This
> deployment lost several hours to a build that "passed with zero environment
> variables" because a stray `.env.local` was quietly feeding it values. An
> agent whose entire job is asking *how do you know that* would have caught it.

### Industry packs (421–500)

Each of these is a domain expert for a pack that is currently 0% built:

- `civil-engineer` + `real-estate-buyer-seller` → Real Estate (421–428, the one pack already largely built)
- `legal-client-intake`, `legal-billing-time-tracking`, `legal-document-review` → Legal (477–484)
- `healthcare-customer-service`, `medical-billing-coding-specialist` → Healthcare (429–436)
- `hospitality-guest-services` → Hospitality (469–476)
- `loan-officer-assistant` → Financial Services (445–452)
- `retail-customer-returns`, `supply-chain-strategist` → Retail and Logistics
- `hr-onboarding`, `recruitment-specialist` → HR (341–355)
- `accounts-payable-agent` → Procurement (271–285)

### Finance and product

`chief-financial-officer`, `bookkeeper-controller`, `fpa-analyst`,
`tax-strategist` for the ledger and India tax packs; `product-manager`,
`sprint-prioritizer`, `feedback-synthesizer` for deciding what comes next.

## What this does NOT do

Installing an agent does not build anything. These are perspectives available
to future sessions, not work completed. The build order in
`docs/BUILD-ORDER.md` is unchanged by their presence.
