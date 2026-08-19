# Ordence

Enterprise multi-tenant CRM + ERP for the Indian market. One codebase, one
database, many customer workspaces — isolated by PostgreSQL row-level security.

**Current version:** `v0.83.0-alpha` — Settings hub (integrations, AI, notifications), write-capable AI tools, conversation memory, email delivery, 6 reports, dashboard command center

**[📋 Deploy Guide — start here](DEPLOY.md)**

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in your keys
npm run db:push              # create tables (dev only — never in production)
npm run dev                  # http://localhost:3000
```

Then run **`SQL-FILES/ALL-IN-ONE-SETUP.sql`** in your Neon SQL Editor.
**This step is required** — it turns on database-level tenant isolation, the
append-only audit trail, and double-entry balance enforcement.

For production deployments, see **[DEPLOY.md](DEPLOY.md)**.

## What this version includes

| Feature | Description |
|---|---|
| **Multi-tenancy** | RLS + FORCE on every table, Clerk Organizations, RBAC, audit log |
| **Six engines** | Scheduling, pricing, field ops, compliance calendar, utility metering, sensitive-data vault |
| **India accounting** | GST, GSTR-2B reconciliation, TDS, Tally integration, double-entry ledger, receivables & dunning |
| **Construction** | BOQ, RA bills, variations, site labour, land & title, measurement books |
| **24 MCP tools** | Read tools for every module + write tools for variations and site logs |
| **7 AI agents** | GST assistant, reconciliation, compliance monitor, receivables, BOQ estimator, field dispatcher, Tally export |
| **Assistant chat UI** | In-CRM chat with agent picker, tool call indicators, conversation history |
| **Goal planner** | Natural language to workflow draft — describe a goal, AI generates a validated workflow program |
| **6 background workers** | GST deadlines, receivables aging, reconciliation drift, inventory reorder, compliance gap, site labour anomaly |
| **AI pattern memory** | Per-tenant learned business facts for smarter agent runs |
| **Construction vertical** | Complete end-to-end: BOQ, variations, site labour, RA bills, cost control, land & title, compliance, finance (GST/TDS/accounting/receivables), materials, documents |
| **13 industry templates** | All 13 verticals complete with Finance (GST, GSTR-2B, TDS, Ledger, Tally), Compliance, and Documents sections |

## Project structure

```
ordence/
├── app/                    # Next.js App Router
│   ├── (auth)/             # Sign-in / sign-up [Clerk]
│   ├── (crm)/              # The CRM application (40 routes, incl. /assistant)
│   ├── platform/           # Admin console
│   ├── api/                # API routes (health, diag, mcp, assistant, workers, webhooks)
│   └── portal/             # External client portal
├── components/             # React components
├── db/
│   ├── schema/             # Drizzle schema (41 files, 150+ tables)
│   ├── index.ts            # Serverless client + withTenant() (RLS enforcement)
│   └── migrations/         # SQL migrations
├── lib/
│   ├── ai/                 # AI provider registry, router, client, agents, goal-planner
│   ├── mcp/                # MCP tool registry (24 tools)
│   ├── modules/            # Module registry (59 modules)
│   ├── env.ts              # Zod-validated env
│   ├── workflows/          # Workflow engine (triggers, actions, validation)
│   └── industry-templates.ts  # 13 industry packs
├── server/
│   ├── ai/                 # Agent runner, background workers
│   ├── mcp/                # MCP dispatch (token auth, RLS, audit log)
│   └── actions/            # Server actions (50 files)
├── SQL-FILES/              # Numbered SQL migrations (0001–0044)
├── middleware.ts           # Edge multi-tenant auth gate
├── railway.json            # Railway deployment config
└── DEPLOY.md               # Full deploy guide
```

## The isolation model

Three independent layers must all fail before cross-tenant data can leak:

1. **Edge middleware** strips spoofable headers, verifies host matches session org
2. **`server/tenant-context.ts`** re-resolves the tenant from Clerk's immutable org ID
3. **PostgreSQL RLS** refuses rows outside the pinned tenant, even on a raw query

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start local dev server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript strict check |
| `npm run test` | Run test suite (946 tests) |
| `npm run test:security` | Run security tests (requires live DB) |
| `npm run db:verify` | Verify RLS is enforced on all tables |
| `npm run seed` | Populate demo project |

## Stack

Next.js 15 (App Router) · TypeScript strict · Tailwind CSS · shadcn/ui ·
PostgreSQL (Neon) · Drizzle ORM · Clerk Organizations · Upstash Redis ·
Railway (deploy) · Cloudflare (DNS + R2)

## License

Private. All rights reserved.
