# Ordence

Enterprise multi-tenant CRM platform. Edge-first, built on Next.js + Vercel.

**Current version:** `v0.10.0-alpha` — Executive Dashboards & Financial Analytics

**[📋 Project Status — what is done and what is pending](docs/PROJECT-STATUS.md)**

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in your keys
npm run db:push              # create tables
npm run dev                  # http://localhost:3000
```

Then run **`SQL-FILES/ALL-IN-ONE-SETUP.sql`** in your Neon SQL Editor.
**This step is required** — it turns on database-level tenant isolation, the
append-only audit trail, and double-entry balance enforcement. One file, all phases.

## Documentation

| Document | Purpose |
|---|---|
| [`docs/DEPLOYMENT-GUIDE.md`](docs/DEPLOYMENT-GUIDE.md) | Step-by-step deploy, written for non-developers |
| [`docs/COST-AND-UPGRADE-PATH.md`](docs/COST-AND-UPGRADE-PATH.md) | What's free, what costs money, when to upgrade |
| [`docs/PROJECT-STATUS.md`](docs/PROJECT-STATUS.md) | **Done vs pending — start here** |
| [`docs/PHASE-6-DEPLOYMENT.md`](docs/PHASE-6-DEPLOYMENT.md) | Phase 6 test setup |
| [`docs/SECURITY-REPORT-v0.6.0.md`](docs/SECURITY-REPORT-v0.6.0.md) | Phase 6 security audit |
| [`docs/SECURITY-REPORT-v0.7.0.md`](docs/SECURITY-REPORT-v0.7.0.md) | Phase 7 security audit |
| [`docs/PHASE-7-DEPLOYMENT.md`](docs/PHASE-7-DEPLOYMENT.md) | Phase 7 step-by-step deployment |
| [`docs/SECURITY-REPORT-v0.8.0.md`](docs/SECURITY-REPORT-v0.8.0.md) | Phase 8 security audit |
| [`docs/PHASE-8-DEPLOYMENT.md`](docs/PHASE-8-DEPLOYMENT.md) | Phase 8 step-by-step deployment |
| [`docs/SECURITY-REPORT-v0.9.0.md`](docs/SECURITY-REPORT-v0.9.0.md) | Phase 9 security audit |
| [`docs/PHASE-9-DEPLOYMENT.md`](docs/PHASE-9-DEPLOYMENT.md) | Phase 9 step-by-step deployment |
| [`docs/SECURITY-REPORT-v0.10.0.md`](docs/SECURITY-REPORT-v0.10.0.md) | Phase 10 security audit |
| [`docs/PHASE-10-DEPLOYMENT.md`](docs/PHASE-10-DEPLOYMENT.md) | Phase 10 step-by-step deployment |
| [`docs/PHASE-5-DEPLOYMENT.md`](docs/PHASE-5-DEPLOYMENT.md) | Phase 5 setup |
| [`docs/SECURITY-REPORT-v0.5.0.md`](docs/SECURITY-REPORT-v0.5.0.md) | Phase 5 security audit |
| [`docs/PHASE-4-DEPLOYMENT.md`](docs/PHASE-4-DEPLOYMENT.md) | Phase 4 setup |
| [`docs/SECURITY-REPORT-v0.4.0.md`](docs/SECURITY-REPORT-v0.4.0.md) | Phase 4 security audit |
| [`docs/PHASE-3-DEPLOYMENT.md`](docs/PHASE-3-DEPLOYMENT.md) | Phase 3 migration + seeding |
| [`docs/SECURITY-REPORT-v0.3.0.md`](docs/SECURITY-REPORT-v0.3.0.md) | Phase 3 security audit |
| [`docs/PHASE-2-DEPLOYMENT.md`](docs/PHASE-2-DEPLOYMENT.md) | Phase 2 migration + webhook setup |
| [`docs/SECURITY-REPORT-v0.2.0.md`](docs/SECURITY-REPORT-v0.2.0.md) | Phase 2 security audit |
| [`docs/SECURITY-REPORT-v0.1.0.md`](docs/SECURITY-REPORT-v0.1.0.md) | Phase 1 security audit |
| [`CHANGELOG.md`](CHANGELOG.md) | Version history |

## Project structure

```
ordence/
├── app/                    # Next.js App Router (pages & API routes)
│   ├── (auth)/             # Sign-in / sign-up  [Clerk]
│   ├── (platform)/         # Authenticated app surface
│   ├── api/health/         # Liveness probe  [Edge]
│   ├── onboarding/         # Create-organization flow
│   └── access-denied/      # Tenant mismatch landing
├── components/ui/          # shadcn/ui primitives
├── db/
│   ├── schema.ts           # Drizzle schema — single source of truth
│   ├── index.ts            # Serverless client + withTenant()
│   └── migrations/         # SQL migrations incl. RLS policies
├── lib/
│   ├── env.ts              # Zod-validated env (blocks browser access)
│   ├── tenant.ts           # Edge-safe host → tenant resolution
│   ├── redis.ts            # Tenant-namespaced cache & rate limiting
│   └── utils.ts            # cn() helper
├── server/
│   └── tenant-context.ts   # Authoritative tenant verification  [server-only]
├── middleware.ts           # Edge multi-tenant auth gate
└── docs/                   # Guides & security reports
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
| `npm run typecheck` | TypeScript check, no emit |
| `npm run db:push` | Sync schema to database |
| `npm run db:studio` | Visual database browser |
| `npm run seed` | Populate the Basaveshwar Nagar demo project |
| `npm run seed:phase5` | Populate ledgers, periods, audit logs & RBAC |
| `npm run test:security` | Run the 69 security tests |
| `npm run security:audit` | Dependency vulnerability scan |

## Stack

Next.js 15 (App Router) · TypeScript strict · Tailwind CSS · shadcn/ui ·
PostgreSQL (Neon) · Drizzle ORM · Clerk Organizations · Upstash Redis · Zod
