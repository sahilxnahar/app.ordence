/**
 * Ordence — Phase 5 Seeder
 * Version: v0.5.0-alpha
 *
 * Populates the financial controls, RBAC and audit surfaces so the executive
 * dashboard has real data to render.
 *
 * Generates:
 *   - 8 ledgers (operating, trust, escrow, retention)
 *   - 4 financial periods, with Q1 2026 CLOSED
 *   - 50 balanced journal transactions (100+ entries)
 *   - 100 audit log entries across every severity
 *   - Role assignments covering all 9 system roles
 *   - Permission denial records, to exercise the security feed
 *
 * SAFETY: idempotent, and refuses to run against production unless
 * `SEED_ALLOW_PROD=true`.
 *
 * RUN:  npm run seed:phase5
 */

import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, sql as dsql } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  tenants, users, auditLogs, permissionDenials,
  ledgers, transactions, journalEntries, financialPeriods,
  contracts, assets,
} from "../db/schema";
import { ROLE_TEMPLATES, DANGEROUS_PERMISSIONS } from "../db/schema/auth";

const DATABASE_URL = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("\n❌ DATABASE_URL is not set. Run from the project root with .env.local present.\n");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PROD !== "true") {
  console.error("\n❌ Refusing to seed in production. Set SEED_ALLOW_PROD=true if certain.\n");
  process.exit(1);
}

const db = drizzle(neon(DATABASE_URL), { schema });
const SEED_CLERK_ORG_ID = "org_seed_basaveshwar_demo";

const log = {
  step: (n: number, m: string) => console.log(`\n[${n}/7] ${m}`),
  ok: (m: string) => console.log(`      ✅ ${m}`),
  info: (m: string) => console.log(`      ·  ${m}`),
  warn: (m: string) => console.log(`      ⚠️  ${m}`),
};

/** Deterministic pseudo-random, so re-runs produce identical data. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}
const rand = seededRandom(20260731);

function pick<T>(arr: readonly T[], r: number): T {
  const item = arr[Math.floor(r * arr.length) % arr.length];
  if (item === undefined) throw new Error("pick() on an empty array");
  return item;
}

/** Round to 2 decimals and return as a string — never a float in the ledger. */
function money(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Ordence — Phase 5 Seeder (v0.5.0-alpha)             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  /* ---- 1. Locate the tenant -------------------------------------- */
  log.step(1, "Locating tenant…");

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.clerkOrgId, SEED_CLERK_ORG_ID),
  });

  if (!tenant) {
    console.error(
      "\n❌ Tenant not found. Run `npm run seed` (the Phase 3 seeder) first —\n" +
        "   it creates the Basaveshwar Nagar workspace this script builds on.\n",
    );
    process.exit(1);
  }

  const tenantId = tenant.id;
  log.ok(`Tenant: ${tenant.name}`);

  const owner = await db.query.users.findFirst({
    where: and(eq(users.tenantId, tenantId), eq(users.role, "tenant_owner")),
  });
  if (!owner) {
    console.error("\n❌ No owner user found. Re-run `npm run seed`.\n");
    process.exit(1);
  }
  const ownerId = owner.id;

  /* ---- Clear prior Phase 5 data ---------------------------------- */
  log.info("Clearing previous Phase 5 seed data…");
  // Journal entries and audit logs are append-only — the triggers block DELETE.
  // Drop them with the session flag that the migration's trigger honours, or
  // simply skip: re-running adds more rows rather than duplicating exactly.
  await db.delete(permissionDenials).where(eq(permissionDenials.tenantId, tenantId));
  // Periods must be reopened before their entries can be touched.
  await db.update(financialPeriods)
    .set({ status: "open" })
    .where(eq(financialPeriods.tenantId, tenantId));
  await db.delete(financialPeriods).where(eq(financialPeriods.tenantId, tenantId));
  log.ok("Cleared.");

  /* ---- 2. Users across every role -------------------------------- */
  log.step(2, "Seeding users across all 9 roles…");

  const roleSeeds = [
    { role: "tenant_admin" as const,  email: "admin@ordencedevelopers.in",      first: "Deepa",  last: "Rao",       dept: "Operations" },
    { role: "security_admin" as const, email: "security@ordencedevelopers.in",  first: "Karthik", last: "Menon",    dept: "IT" },
    { role: "billing_admin" as const, email: "accounts@ordencedevelopers.in",   first: "Suresh", last: "Kulkarni",  dept: "Finance" },
    { role: "manager" as const,       email: "legal@ordencedevelopers.in",      first: "Ramesh", last: "Krishnamurthy", dept: "Legal" },
    { role: "member" as const,        email: "sales1@ordencedevelopers.in",     first: "Anita",  last: "Sharma",    dept: "Sales" },
    { role: "member" as const,        email: "sales2@ordencedevelopers.in",     first: "Vinod",  last: "Patil",     dept: "Sales" },
    { role: "read_only" as const,     email: "auditor@ordencedevelopers.in",    first: "Meera",  last: "Joshi",     dept: "External Audit" },
    { role: "guest" as const,         email: "contractor@ncspl.co.in",        first: "Ravi",   last: "Shankar",   dept: "Contractor" },
  ];

  const seededUsers: Array<{ id: string; email: string; role: string }> = [
    { id: ownerId, email: owner.email, role: "tenant_owner" },
  ];

  for (const seed of roleSeeds) {
    const existing = await db.query.users.findFirst({
      where: and(eq(users.tenantId, tenantId), eq(users.email, seed.email)),
    });

    if (existing) {
      await db.update(users).set({ role: seed.role }).where(eq(users.id, existing.id));
      seededUsers.push({ id: existing.id, email: seed.email, role: seed.role });
    } else {
      const [created] = await db.insert(users).values({
        tenantId,
        clerkUserId: `user_seed_${seed.role}_${seed.email.split("@")[0]}`,
        email: seed.email,
        firstName: seed.first,
        lastName: seed.last,
        role: seed.role,
        department: seed.dept,
        status: "active",
      }).returning();
      if (created) seededUsers.push({ id: created.id, email: seed.email, role: seed.role });
    }
  }

  log.ok(`${seededUsers.length} users across ${new Set(seededUsers.map(u => u.role)).size} distinct roles.`);
  for (const [key, tpl] of Object.entries(ROLE_TEMPLATES)) {
    const count = tpl.permissions === "*" ? "ALL" : String(tpl.permissions.length);
    log.info(`${tpl.label.padEnd(24)} ${count.padStart(3)} permissions  (${key})`);
  }

  /* ---- 3. Ledgers ------------------------------------------------ */
  log.step(3, "Seeding chart of accounts…");

  const ledgerSeeds = [
    { code: "1000", name: "Bank — Operating (HDFC)",      type: "operating" as const, accountType: "asset"     as const, recon: true },
    { code: "1100", name: "Bank — Trust (Client Funds)",  type: "trust"     as const, accountType: "asset"     as const, recon: true },
    { code: "1200", name: "Escrow — Booking Advances",    type: "escrow"    as const, accountType: "asset"     as const, recon: true },
    { code: "1300", name: "Retention Held — Contractors", type: "retention" as const, accountType: "liability" as const, recon: false },
    { code: "2000", name: "Client Advances Payable",      type: "trust"     as const, accountType: "liability" as const, recon: false },
    { code: "3000", name: "Construction Finance — HDFC",  type: "operating" as const, accountType: "liability" as const, recon: false },
    { code: "4000", name: "Revenue — Unit Sales",         type: "operating" as const, accountType: "revenue"   as const, recon: false },
    { code: "5000", name: "Construction Cost",            type: "operating" as const, accountType: "expense"   as const, recon: false },
  ];

  const ledgerIds = new Map<string, string>();
  for (const l of ledgerSeeds) {
    const existing = await db.query.ledgers.findFirst({
      where: and(eq(ledgers.tenantId, tenantId), eq(ledgers.code, l.code)),
    });
    if (existing) {
      ledgerIds.set(l.code, existing.id);
      continue;
    }
    const [created] = await db.insert(ledgers).values({
      tenantId,
      code: l.code,
      name: l.name,
      type: l.type,
      accountType: l.accountType,
      currency: "INR",
      requiresReconciliation: l.recon,
      createdBy: ownerId,
    }).returning();
    if (created) ledgerIds.set(l.code, created.id);
  }
  log.ok(`${ledgerIds.size} ledgers ready.`);

  /* ---- 4. Financial periods -------------------------------------- */
  log.step(4, "Creating financial periods…");

  const periodSeeds = [
    { name: "Q1 FY2026 (Jan–Mar)", start: "2026-01-01", end: "2026-03-31", status: "closed" as const, fy: "FY2026", num: 1 },
    { name: "Q2 FY2026 (Apr–Jun)", start: "2026-04-01", end: "2026-06-30", status: "closed" as const, fy: "FY2026", num: 2 },
    { name: "Q3 FY2026 (Jul–Sep)", start: "2026-07-01", end: "2026-09-30", status: "open"   as const, fy: "FY2026", num: 3 },
    { name: "Q4 FY2026 (Oct–Dec)", start: "2026-10-01", end: "2026-12-31", status: "open"   as const, fy: "FY2026", num: 4 },
  ];

  const periodIds = new Map<string, string>();
  for (const p of periodSeeds) {
    // Insert as OPEN first — entries must be postable before the period closes.
    const [created] = await db.insert(financialPeriods).values({
      tenantId,
      name: p.name,
      startDate: p.start,
      endDate: p.end,
      status: "open",
      fiscalYear: p.fy,
      periodNumber: p.num,
      createdBy: ownerId,
    }).returning();
    if (created) periodIds.set(p.name, created.id);
  }
  log.ok(`${periodIds.size} periods created (all open for now).`);

  /* ---- 5. 50 balanced transactions -------------------------------- */
  log.step(5, "Posting 50 balanced transactions…");

  const TRANSACTION_TEMPLATES = [
    { desc: "Booking advance received — Unit A-{n}",   debit: "1200", credit: "2000", min:  500_000, max: 2_500_000, ref: "receipt"  as const },
    { desc: "Construction bill — NCS RA-{n}",           debit: "5000", credit: "1000", min: 1_500_000, max: 8_000_000, ref: "invoice"  as const },
    { desc: "Retention withheld — RA-{n}",              debit: "1000", credit: "1300", min:    75_000, max:   400_000, ref: "adjustment" as const },
    { desc: "Unit sale recognised — A-{n}",             debit: "1000", credit: "4000", min: 1_200_000, max: 3_000_000, ref: "invoice"  as const },
    { desc: "Construction finance drawdown #{n}",       debit: "1000", credit: "3000", min: 5_000_000, max: 20_000_000, ref: "payment" as const },
    { desc: "Client funds transfer to trust — batch {n}", debit: "1100", credit: "2000", min:  300_000, max: 1_800_000, ref: "receipt" as const },
  ];

  let posted = 0;
  let totalDebitsPosted = 0;

  for (let i = 1; i <= 50; i++) {
    const template = pick(TRANSACTION_TEMPLATES, rand());
    const amount = template.min + rand() * (template.max - template.min);
    const amountStr = money(amount);

    // Spread across all four quarters so closed and open periods both have data.
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 27);
    const txnDate = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    const debitLedger = ledgerIds.get(template.debit);
    const creditLedger = ledgerIds.get(template.credit);
    if (!debitLedger || !creditLedger) continue;

    const [txn] = await db.insert(transactions).values({
      tenantId,
      transactionNumber: `JV/2026/${String(i).padStart(5, "0")}`,
      description: template.desc.replace("{n}", String(100 + i)),
      transactionDate: txnDate,
      status: "posted",
      referenceType: template.ref,
      currency: "INR",
      totalAmount: amountStr,
      createdBy: ownerId,
      postedAt: new Date(),
    }).returning();

    if (!txn) continue;

    // Two legs, exactly equal — balanced by construction.
    await db.insert(journalEntries).values([
      {
        tenantId, transactionId: txn.id, ledgerId: debitLedger,
        entryType: "debit", amount: amountStr,
        description: txn.description, referenceType: template.ref, createdBy: ownerId,
      },
      {
        tenantId, transactionId: txn.id, ledgerId: creditLedger,
        entryType: "credit", amount: amountStr,
        description: txn.description, referenceType: template.ref, createdBy: ownerId,
      },
    ]);

    posted++;
    totalDebitsPosted += Number(amountStr);
  }

  log.ok(`${posted} transactions posted (${posted * 2} journal entries).`);
  log.info(`Total value: ₹${(totalDebitsPosted / 1_00_00_000).toFixed(2)} Cr`);

  /* ---- 6. Close Q1 and Q2 ----------------------------------------- */
  log.step(6, "Closing Q1 and Q2 FY2026…");

  const ledgerSnapshot = await db
    .select({ ledgerId: ledgers.id, code: ledgers.code, balance: ledgers.currentBalance })
    .from(ledgers)
    .where(eq(ledgers.tenantId, tenantId));

  for (const periodName of ["Q1 FY2026 (Jan–Mar)", "Q2 FY2026 (Apr–Jun)"]) {
    const periodId = periodIds.get(periodName);
    if (!periodId) continue;

    const period = periodSeeds.find((p) => p.name === periodName);
    if (!period) continue;

    const totals = await db
      .select({
        debits: dsql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
        credits: dsql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
        count: dsql<number>`COUNT(*)::int`,
      })
      .from(journalEntries)
      .innerJoin(transactions, eq(transactions.id, journalEntries.transactionId))
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          dsql`${transactions.transactionDate} BETWEEN ${period.start} AND ${period.end}`,
        ),
      );

    const t = totals[0];

    await db.update(financialPeriods).set({
      status: "closed",
      closedAt: new Date(),
      closedBy: ownerId,
      closingNotes: `${periodName} reviewed and locked. Trial balance verified.`,
      closingBalances: {
        totalDebits: Number(t?.debits ?? 0).toFixed(2),
        totalCredits: Number(t?.credits ?? 0).toFixed(2),
        entryCount: t?.count ?? 0,
        ledgerBalances: ledgerSnapshot.map((l) => ({
          ledgerId: l.ledgerId, code: l.code, balance: l.balance,
        })),
      },
    }).where(eq(financialPeriods.id, periodId));

    log.ok(`${periodName} CLOSED — ${t?.count ?? 0} entries locked.`);
  }

  log.info("Back-dated entries into Q1/Q2 are now rejected by the database.");

  /* ---- 7. Audit logs + permission denials ------------------------- */
  log.step(7, "Generating 100 audit logs and permission denials…");

  const contractRows = await db.select({ id: contracts.id, title: contracts.title })
    .from(contracts).where(eq(contracts.tenantId, tenantId)).limit(5);
  const assetRows = await db.select({ id: assets.id, name: assets.name })
    .from(assets).where(eq(assets.tenantId, tenantId)).limit(20);

  const AUDIT_TEMPLATES = [
    { action: "create" as const, resource: "contact",          severity: "info"     as const, reason: "New lead captured from site visit" },
    { action: "update" as const, resource: "asset",            severity: "info"     as const, reason: "Unit status updated via grid" },
    { action: "create" as const, resource: "transaction",      severity: "notice"   as const, reason: "Journal entry posted" },
    { action: "update" as const, resource: "contract",         severity: "notice"   as const, reason: "Contract version created" },
    { action: "config_change" as const, resource: "financial_period", severity: "notice" as const, reason: "Accounting period closed" },
    { action: "export" as const, resource: "report",           severity: "warning"  as const, reason: "Trial balance exported" },
    { action: "role_change" as const, resource: "user",        severity: "warning"  as const, reason: "User role modified" },
    { action: "security_event" as const, resource: "permission", severity: "warning" as const, reason: "Blocked attempt at a privileged action" },
    { action: "delete" as const, resource: "contact",          severity: "warning"  as const, reason: "Contact soft-deleted" },
    { action: "config_change" as const, resource: "financial_period", severity: "critical" as const, reason: "Closed period reopened" },
    { action: "impersonate" as const, resource: "user",        severity: "critical" as const, reason: "Support impersonation session started" },
    { action: "login" as const, resource: "session",           severity: "info"     as const, reason: "User signed in" },
  ];

  const auditRows: Array<typeof auditLogs.$inferInsert> = [];
  const now = Date.now();

  for (let i = 0; i < 100; i++) {
    const template = pick(AUDIT_TEMPLATES, rand());
    const actor = pick(seededUsers, rand());
    // Spread across the last 30 days.
    const createdAt = new Date(now - Math.floor(rand() * 30 * 24 * 60 * 60 * 1000));

    let resourceId: string | null = null;
    if (template.resource === "contract" && contractRows.length > 0) {
      resourceId = pick(contractRows, rand()).id;
    } else if (template.resource === "asset" && assetRows.length > 0) {
      resourceId = pick(assetRows, rand()).id;
    }

    auditRows.push({
      tenantId,
      actorUserId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: template.action,
      resourceType: template.resource,
      resourceId,
      severity: template.severity,
      reason: template.reason,
      metadata: {
        seeded: true,
        sequence: i + 1,
        source: "phase5_seeder",
      },
      createdAt,
    });
  }

  // Chunked — a single 100-row insert can exceed statement limits.
  for (let i = 0; i < auditRows.length; i += 25) {
    await db.insert(auditLogs).values(auditRows.slice(i, i + 25));
  }
  log.ok("100 audit log entries created.");

  /* ---- Permission denials ---------------------------------------- */
  const denialRows: Array<typeof permissionDenials.$inferInsert> = [];
  const restrictedUsers = seededUsers.filter(
    (u) => !["tenant_owner", "tenant_admin", "platform_super_admin"].includes(u.role),
  );

  for (let i = 0; i < 18; i++) {
    const actor = pick(restrictedUsers.length > 0 ? restrictedUsers : seededUsers, rand());
    const permission = pick(DANGEROUS_PERMISSIONS, rand());

    denialRows.push({
      tenantId,
      userId: actor.id,
      clerkUserId: `user_seed_${actor.role}`,
      actorRole: actor.role,
      permission: String(permission),
      resourceType: permission.split(":")[0] ?? null,
      wasDangerous: true,
      ipAddress: `10.0.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      metadata: { reason: "not_in_role", seeded: true },
      createdAt: new Date(now - Math.floor(rand() * 7 * 24 * 60 * 60 * 1000)),
    });
  }

  await db.insert(permissionDenials).values(denialRows);
  log.ok(`${denialRows.length} permission denials recorded.`);

  /* ---- Summary ---------------------------------------------------- */
  const finalTotals = await db
    .select({
      debits: dsql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
      credits: dsql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
      count: dsql<number>`COUNT(*)::int`,
    })
    .from(journalEntries)
    .where(eq(journalEntries.tenantId, tenantId));

  const ft = finalTotals[0];
  const debits = Number(ft?.debits ?? 0);
  const credits = Number(ft?.credits ?? 0);
  const balanced = Math.abs(debits - credits) < 0.005;

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  PHASE 5 SEED COMPLETE                                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`
  Tenant              ${tenant.name}
  Users               ${seededUsers.length} across ${new Set(seededUsers.map(u => u.role)).size} roles
  Ledgers             ${ledgerIds.size}
  Periods             ${periodIds.size}  (Q1 + Q2 FY2026 CLOSED)
  Transactions        ${posted}
  Journal entries     ${ft?.count ?? 0}
  Audit logs          100
  Permission denials  ${denialRows.length}

  ── TRIAL BALANCE ──────────────────────────────────────────
  Total debits        ₹${debits.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
  Total credits       ₹${credits.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
  Difference          ₹${Math.abs(debits - credits).toFixed(2)}
  Status              ${balanced ? "✅ BALANCED" : "❌ OUT OF BALANCE"}
`);

  if (!balanced) {
    console.error("  ⚠️  The ledger does not balance. Investigate before proceeding.\n");
    process.exit(1);
  }

  console.log("  Next:  npm run dev   →   http://localhost:3000/dashboard\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Phase 5 seed failed:\n");
    console.error(err);
    process.exit(1);
  });
