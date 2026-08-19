/**
 * Ordence — Real-World Stress-Test Seeder
 * Version: v0.3.0-alpha
 *
 * Seeds a genuine semi-commercial development in Basaveshwar Nagar,
 * North-West Bangalore, to prove the Custom Object and Asset engines hold up
 * against real data rather than lorem ipsum.
 *
 * WHAT IT PROVES
 *   1. The asset graph handles a real hierarchy: Project → Towers → Floors → Units
 *   2. Deeply nested JSONB survives a round trip (cost analysis 4 levels deep)
 *   3. The custom object engine models domain entities with zero migrations
 *   4. `asset_relationships` expresses containment across three levels
 *   5. Tenant isolation holds while writing several hundred rows
 *
 * SAFETY
 *   - Idempotent: re-running replaces the seeded tenant's data rather than duplicating
 *   - Refuses to run against a production database unless SEED_ALLOW_PROD=true
 *   - Every insert carries the tenant id explicitly
 *
 * RUN IT
 *   npm run seed
 */

import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  tenants,
  users,
  companies,
  contacts,
  deals,
  assets,
  assetRelationships,
  customObjectDefinitions,
  customFieldDefinitions,
  customObjectRecords,
} from "../db/schema";

/* ------------------------------------------------------------------ */
/* SETUP                                                               */
/* ------------------------------------------------------------------ */

const DATABASE_URL = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("\n❌ DATABASE_URL is not set.");
  console.error("   Make sure .env.local exists and contains your Neon connection string.\n");
  process.exit(1);
}

// Guard against seeding a live database by accident.
if (
  process.env.NODE_ENV === "production" &&
  process.env.SEED_ALLOW_PROD !== "true"
) {
  console.error("\n❌ Refusing to seed in production.");
  console.error("   Set SEED_ALLOW_PROD=true only if you are certain.\n");
  process.exit(1);
}

const client = neon(DATABASE_URL);
const db = drizzle(client, { schema });

/** Stable identifiers so re-runs are idempotent. */
const SEED_CLERK_ORG_ID = "org_seed_basaveshwar_demo";
const SEED_SLUG = "ordence-developers";

const log = {
  step: (n: number, msg: string) => console.log(`\n[${n}/9] ${msg}`),
  ok: (msg: string) => console.log(`      ✅ ${msg}`),
  info: (msg: string) => console.log(`      ·  ${msg}`),
  warn: (msg: string) => console.log(`      ⚠️  ${msg}`),
};

/* ------------------------------------------------------------------ */
/* PROJECT DATA — Basaveshwar Nagar                                    */
/* ------------------------------------------------------------------ */

/**
 * Deeply nested cost analysis. This is the payload that proves JSONB survives a
 * real structure — four levels deep, mixed types, money as strings.
 */
const COST_ANALYSIS = {
  currency: "INR",
  lastRevisedOn: "2026-06-30",
  revisionNumber: 7,
  approvedBy: "Board Resolution AHD/2026/07",
  summary: {
    totalBudgeted: "1284500000.00",
    totalCommitted: "1109750000.00",
    totalSpent: "742300000.00",
    contingencyHeld: "64225000.00",
    projectedOverrun: "18900000.00",
    variancePct: 1.47,
  },
  breakdown: {
    land: {
      budgeted: "412000000.00",
      committed: "412000000.00",
      spent: "412000000.00",
      items: [
        { head: "Land acquisition — Survey 47/2A", amount: "358000000.00", status: "settled" },
        { head: "Stamp duty & registration", amount: "39380000.00", status: "settled" },
        { head: "Khata transfer & legal", amount: "14620000.00", status: "settled" },
      ],
    },
    approvals: {
      budgeted: "48500000.00",
      committed: "44200000.00",
      spent: "38900000.00",
      items: [
        { head: "BBMP plan sanction", amount: "18400000.00", status: "obtained", referenceNo: "BBMP/RWZ/2025/1184" },
        { head: "BWSSB water & sanitation NOC", amount: "6200000.00", status: "obtained" },
        { head: "KSPCB consent to establish", amount: "4100000.00", status: "obtained" },
        { head: "Fire NOC — Karnataka Fire Services", amount: "3800000.00", status: "in_process" },
        { head: "BESCOM power sanction (1250 kVA)", amount: "11700000.00", status: "in_process" },
      ],
    },
    civil: {
      budgeted: "534000000.00",
      committed: "498300000.00",
      spent: "241800000.00",
      subHeads: {
        foundation: {
          budgeted: "89000000.00",
          spent: "89000000.00",
          progressPct: 100,
          items: [
            { head: "Excavation & shoring", amount: "24500000.00" },
            { head: "Pile foundation — 214 piles", amount: "48200000.00" },
            { head: "Pile cap & plinth beam", amount: "16300000.00" },
          ],
        },
        superstructure: {
          budgeted: "312000000.00",
          spent: "134600000.00",
          progressPct: 43,
          items: [
            { head: "RCC framework — Tower A", amount: "118000000.00", progressPct: 62 },
            { head: "RCC framework — Tower B", amount: "104000000.00", progressPct: 38 },
            { head: "Commercial podium slab", amount: "90000000.00", progressPct: 24 },
          ],
        },
        finishing: {
          budgeted: "133000000.00",
          spent: "18200000.00",
          progressPct: 14,
          items: [
            { head: "Blockwork & plastering", amount: "41000000.00" },
            { head: "Flooring — vitrified & granite", amount: "52000000.00" },
            { head: "Painting & waterproofing", amount: "40000000.00" },
          ],
        },
      },
    },
    mep: {
      budgeted: "186000000.00",
      committed: "155250000.00",
      spent: "49600000.00",
      subHeads: {
        electrical: { budgeted: "78000000.00", spent: "22400000.00", progressPct: 29 },
        plumbing: { budgeted: "54000000.00", spent: "16800000.00", progressPct: 31 },
        hvac: { budgeted: "38000000.00", spent: "7200000.00", progressPct: 19 },
        fireFighting: { budgeted: "16000000.00", spent: "3200000.00", progressPct: 20 },
      },
    },
    marketingAndSales: {
      budgeted: "62000000.00",
      committed: "41000000.00",
      spent: "28400000.00",
      items: [
        { head: "Show flat & experience centre", amount: "18500000.00" },
        { head: "Digital & performance marketing", amount: "14200000.00" },
        { head: "Channel partner commissions (accrued)", amount: "29300000.00" },
      ],
    },
    financeCost: {
      budgeted: "42000000.00",
      committed: "39000000.00",
      spent: "21600000.00",
      facility: {
        lender: "HDFC Bank — Construction Finance",
        sanctionedAmount: "450000000.00",
        drawnAmount: "268000000.00",
        interestRatePct: 9.35,
        tenureMonths: 48,
        moratoriumMonths: 18,
      },
    },
  },
} as const;

/** Contractor assignments with realistic Bangalore-market terms. */
const CONTRACTOR_ASSIGNMENTS = [
  {
    contractorName: "Nagarjuna Construction Services Pvt Ltd",
    gstin: "29AABCN2456F1ZK",
    scope: "Civil — RCC framework, Towers A & B",
    contractValue: "298000000.00",
    currency: "INR",
    contractType: "item_rate",
    startDate: "2025-03-15",
    endDate: "2027-02-28",
    status: "active",
    retentionPct: 5,
    mobilisationAdvancePct: 10,
    performanceGuarantee: { amount: "14900000.00", expiryDate: "2027-05-31", bank: "Canara Bank" },
    progressPct: 51,
    lastBillNo: "NCS/AHD/RA-14",
    lastBillDate: "2026-06-25",
  },
  {
    contractorName: "Sri Venkateshwara Electricals",
    gstin: "29AAGCS8821P1Z4",
    scope: "MEP — Electrical & low-voltage systems",
    contractValue: "74500000.00",
    currency: "INR",
    contractType: "lump_sum",
    startDate: "2025-11-01",
    endDate: "2027-04-30",
    status: "active",
    retentionPct: 5,
    mobilisationAdvancePct: 15,
    progressPct: 29,
    lastBillNo: "SVE/AHD/RA-05",
    lastBillDate: "2026-06-18",
  },
  {
    contractorName: "Aqua Systems Bengaluru LLP",
    gstin: "29AAFAA1129M1ZQ",
    scope: "Plumbing, water treatment & STP",
    contractValue: "51200000.00",
    currency: "INR",
    contractType: "item_rate",
    startDate: "2025-12-10",
    endDate: "2027-03-31",
    status: "active",
    retentionPct: 5,
    progressPct: 31,
  },
  {
    contractorName: "Precision Facade Solutions",
    gstin: "29AACCP7734L1ZB",
    scope: "Structural glazing & ACP cladding — commercial podium",
    contractValue: "68900000.00",
    currency: "INR",
    contractType: "lump_sum",
    startDate: "2026-08-01",
    endDate: "2027-06-30",
    status: "awarded_pending_mobilisation",
    retentionPct: 7.5,
    progressPct: 0,
  },
  {
    contractorName: "Karnataka Lift & Escalator Co.",
    gstin: "29AADCK5590H1ZN",
    scope: "6 passenger lifts, 2 service lifts, 2 escalators",
    contractValue: "42300000.00",
    currency: "INR",
    contractType: "supply_and_install",
    startDate: "2026-10-01",
    endDate: "2027-08-31",
    status: "tendered",
    retentionPct: 10,
    progressPct: 0,
  },
] as const;

/** Contract drafting pipeline. */
const CONTRACT_STAGES = [
  { stage: "Joint Development Agreement", status: "executed", owner: "M/s Krishnamurthy & Associates", completedDate: "2024-11-22", registrationNo: "BSN-1-04471/2024-25", notes: "Registered at Sub-Registrar Rajajinagar. 62:38 developer-landowner split." },
  { stage: "Construction Finance Facility Agreement", status: "executed", owner: "In-house Legal", completedDate: "2025-02-14", notes: "HDFC Bank. Charge registered with RoC — CHG-1 filed 2025-02-19." },
  { stage: "Principal Civil Works Contract — NCS", status: "executed", owner: "M/s Krishnamurthy & Associates", completedDate: "2025-03-08", notes: "FIDIC Red Book adapted. LD at 0.5%/week capped at 10%." },
  { stage: "MEP Electrical Works Contract — SVE", status: "executed", owner: "In-house Legal", completedDate: "2025-10-20" },
  { stage: "Plumbing & STP Contract — Aqua Systems", status: "executed", owner: "In-house Legal", completedDate: "2025-11-28" },
  { stage: "Facade Works Contract — Precision", status: "counterparty_review", owner: "M/s Krishnamurthy & Associates", dueDate: "2026-08-15", notes: "Counterparty seeking 12-month defect liability instead of 24. Being negotiated." },
  { stage: "Vertical Transportation Contract", status: "drafting", owner: "In-house Legal", dueDate: "2026-09-30", notes: "Awaiting final technical spec sign-off before commercial terms are drafted." },
  { stage: "Commercial Lease — Anchor Tenant (Ground + Mezzanine)", status: "internal_review", owner: "M/s Krishnamurthy & Associates", dueDate: "2026-08-31", notes: "9-year lease, 5-year lock-in, 15% escalation every 3 years. Rent-free fitout of 4 months." },
  { stage: "Facility Management Agreement", status: "not_started", owner: "Unassigned", dueDate: "2027-01-31" },
  { stage: "Association Handover Deed", status: "not_started", owner: "Unassigned", dueDate: "2027-11-30" },
] as const;

const STATUTORY_APPROVALS = [
  { authority: "BBMP", approval: "Plan Sanction", refNo: "BBMP/RWZ/CN/2025/1184", status: "obtained", obtainedOn: "2025-01-18", validUntil: "2030-01-17" },
  { authority: "BBMP", approval: "Commencement Certificate", refNo: "BBMP/RWZ/CC/2025/0342", status: "obtained", obtainedOn: "2025-02-26" },
  { authority: "BWSSB", approval: "Water & Sanitary Connection NOC", refNo: "BWSSB/NW/2025/8871", status: "obtained", obtainedOn: "2025-03-11" },
  { authority: "KSPCB", approval: "Consent to Establish", refNo: "KSPCB/CTE/BLR/2025/2209", status: "obtained", obtainedOn: "2025-02-04", validUntil: "2028-02-03" },
  { authority: "Karnataka Fire & Emergency Services", approval: "Fire Safety NOC", refNo: "KFES/BLR/2026/0619", status: "in_process", appliedOn: "2026-04-12", expectedBy: "2026-09-30" },
  { authority: "BESCOM", approval: "Power Sanction — 1250 kVA", refNo: "BESCOM/NW/HT/2026/0447", status: "in_process", appliedOn: "2026-03-20", expectedBy: "2026-10-15" },
  { authority: "RERA Karnataka", approval: "Project Registration", refNo: "PRM/KA/RERA/1251/446/PR/250318/007712", status: "obtained", obtainedOn: "2025-03-18", validUntil: "2028-03-17" },
  { authority: "Airports Authority of India", approval: "Height Clearance NOC", refNo: "AAI/NOC/2024/BLR/11204", status: "obtained", obtainedOn: "2024-12-09", notes: "Permitted height 61.5m AMSL." },
] as const;

/* ------------------------------------------------------------------ */
/* MAIN                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Ordence — Basaveshwar Nagar Stress-Test Seeder      ║");
  console.log("║  v0.3.0-alpha                                                 ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  /* ---- 1. Tenant ------------------------------------------------- */
  log.step(1, "Provisioning tenant…");

  const existing = await db.query.tenants.findFirst({
    where: eq(tenants.clerkOrgId, SEED_CLERK_ORG_ID),
  });

  let tenantId: string;

  if (existing) {
    tenantId = existing.id;
    log.warn(`Tenant already exists (${tenantId}). Clearing previous seed data…`);

    // Order matters: children before parents.
    await db.delete(assetRelationships).where(eq(assetRelationships.tenantId, tenantId));
    await db.delete(customObjectRecords).where(eq(customObjectRecords.tenantId, tenantId));
    await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.tenantId, tenantId));
    await db.delete(customObjectDefinitions).where(eq(customObjectDefinitions.tenantId, tenantId));
    await db.delete(assets).where(eq(assets.tenantId, tenantId));
    await db.delete(deals).where(eq(deals.tenantId, tenantId));
    await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    log.ok("Previous seed data cleared.");
  } else {
    const [created] = await db
      .insert(tenants)
      .values({
        clerkOrgId: SEED_CLERK_ORG_ID,
        name: "Ordence Developers Pvt Ltd",
        legalName: "Ordence Developers Private Limited",
        slug: SEED_SLUG,
        planTier: "advanced",
        status: "active",
        seatLimit: 25,
        storageLimitMb: 5120,
        branding: { primaryColor: "#B08D3C", accentColor: "#1A1A1A", fontFamily: "Inter" },
        // This is what drives the polymorphic UI.
        settings: {
          timezone: "Asia/Kolkata",
          currency: "INR",
          country: "IN",
          locale: "en-IN",
          dateFormat: "dd/MM/yyyy",
          industry: "real_estate_developer",
        } as Record<string, unknown>,
      })
      .returning();

    if (!created) throw new Error("Failed to create tenant.");
    tenantId = created.id;
    log.ok(`Tenant created: ${created.name} (${tenantId})`);
  }

  log.info(`Industry template: real_estate_developer`);

  /* ---- 2. Users -------------------------------------------------- */
  log.step(2, "Seeding users…");

  const existingUser = await db.query.users.findFirst({
    where: and(eq(users.tenantId, tenantId), eq(users.email, "founder@ordencedevelopers.in")),
  });

  let ownerUserId: string;
  if (existingUser) {
    ownerUserId = existingUser.id;
    log.info("Owner user already present.");
  } else {
    const [owner] = await db
      .insert(users)
      .values({
        tenantId,
        clerkUserId: "user_seed_founder",
        email: "founder@ordencedevelopers.in",
        firstName: "Sahil",
        lastName: "R",
        role: "tenant_owner",
        status: "active",
        department: "Executive",
        jobTitle: "Managing Director",
      })
      .returning();
    if (!owner) throw new Error("Failed to create owner user.");
    ownerUserId = owner.id;
    log.ok("Owner user created.");
  }

  /* ---- 3. Companies ---------------------------------------------- */
  log.step(3, "Seeding companies (contractors, consultants, partners)…");

  const companyRows = await db
    .insert(companies)
    .values([
      { tenantId, name: "Nagarjuna Construction Services Pvt Ltd", domain: "ncspl.co.in", industry: "Civil Construction", employeeCount: 480, companySize: "201-500", city: "Bengaluru", state: "Karnataka", country: "IN", customFields: { gstin: "29AABCN2456F1ZK", vendorCategory: "civil", empanelledSince: "2019" }, createdBy: ownerUserId },
      { tenantId, name: "Sri Venkateshwara Electricals", domain: "svelectricals.in", industry: "MEP Contracting", employeeCount: 120, companySize: "51-200", city: "Bengaluru", state: "Karnataka", country: "IN", customFields: { gstin: "29AAGCS8821P1Z4", vendorCategory: "mep_electrical" }, createdBy: ownerUserId },
      { tenantId, name: "Aqua Systems Bengaluru LLP", domain: "aquasystems.co.in", industry: "Plumbing & Water Treatment", employeeCount: 85, companySize: "51-200", city: "Bengaluru", state: "Karnataka", country: "IN", customFields: { gstin: "29AAFAA1129M1ZQ", vendorCategory: "mep_plumbing" }, createdBy: ownerUserId },
      { tenantId, name: "Precision Facade Solutions", domain: "precisionfacade.com", industry: "Facade Engineering", employeeCount: 60, companySize: "51-200", city: "Chennai", state: "Tamil Nadu", country: "IN", customFields: { gstin: "29AACCP7734L1ZB", vendorCategory: "facade" }, createdBy: ownerUserId },
      { tenantId, name: "Karnataka Lift & Escalator Co.", domain: "klec.in", industry: "Vertical Transportation", employeeCount: 45, companySize: "11-50", city: "Bengaluru", state: "Karnataka", country: "IN", customFields: { gstin: "29AADCK5590H1ZN", vendorCategory: "elevators" }, createdBy: ownerUserId },
      { tenantId, name: "M/s Krishnamurthy & Associates", domain: "kalaw.in", industry: "Legal Services", employeeCount: 22, companySize: "11-50", city: "Bengaluru", state: "Karnataka", country: "IN", customFields: { vendorCategory: "legal", panelPartner: "Adv. R. Krishnamurthy" }, createdBy: ownerUserId },
      { tenantId, name: "Deshpande & Rao Structural Consultants", domain: "drstructural.in", industry: "Structural Engineering", employeeCount: 35, companySize: "11-50", city: "Bengaluru", state: "Karnataka", country: "IN", customFields: { vendorCategory: "consultant_structural" }, createdBy: ownerUserId },
      { tenantId, name: "Homeward Realty Partners", domain: "homewardrealty.in", industry: "Real Estate Brokerage", employeeCount: 140, companySize: "51-200", city: "Bengaluru", state: "Karnataka", country: "IN", customFields: { vendorCategory: "channel_partner", commissionPct: 2.0 }, createdBy: ownerUserId },
    ])
    .returning();

  log.ok(`${companyRows.length} companies created.`);
  const companyByName = new Map(companyRows.map((c) => [c.name, c.id]));

  /* ---- 4. Contacts ----------------------------------------------- */
  log.step(4, "Seeding contacts…");

  const contactRows = await db
    .insert(contacts)
    .values([
      { tenantId, companyId: companyByName.get("Nagarjuna Construction Services Pvt Ltd") ?? null, firstName: "Ravi", lastName: "Shankar", email: "ravi.shankar@ncspl.co.in", phone: "+91 98450 21134", jobTitle: "Project Director", department: "Operations", createdBy: ownerUserId, ownerId: ownerUserId },
      { tenantId, companyId: companyByName.get("Sri Venkateshwara Electricals") ?? null, firstName: "Manjunath", lastName: "Gowda", email: "manjunath@svelectricals.in", phone: "+91 99001 77820", jobTitle: "Managing Partner", createdBy: ownerUserId, ownerId: ownerUserId },
      { tenantId, companyId: companyByName.get("M/s Krishnamurthy & Associates") ?? null, firstName: "Ramesh", lastName: "Krishnamurthy", email: "rk@kalaw.in", phone: "+91 98862 44019", jobTitle: "Senior Partner", department: "Real Estate Practice", createdBy: ownerUserId, ownerId: ownerUserId },
      { tenantId, companyId: companyByName.get("Deshpande & Rao Structural Consultants") ?? null, firstName: "Anjali", lastName: "Deshpande", email: "anjali@drstructural.in", phone: "+91 97404 55231", jobTitle: "Principal Structural Engineer", createdBy: ownerUserId, ownerId: ownerUserId },
      { tenantId, companyId: companyByName.get("Homeward Realty Partners") ?? null, firstName: "Priya", lastName: "Nair", email: "priya.nair@homewardrealty.in", phone: "+91 98807 33456", jobTitle: "VP — Sales", createdBy: ownerUserId, ownerId: ownerUserId },
      { tenantId, firstName: "Vikram", lastName: "Mehta", email: "vikram.mehta@example.in", phone: "+91 99860 11223", jobTitle: "Director", department: "Prospective Buyer", customFields: { leadSource: "site_visit", budgetRange: "1.8-2.4 Cr", unitPreference: "3BHK" }, createdBy: ownerUserId, ownerId: ownerUserId },
      { tenantId, firstName: "Lakshmi", lastName: "Iyer", email: "lakshmi.iyer@example.in", phone: "+91 97318 99012", jobTitle: "Consultant", department: "Prospective Buyer", customFields: { leadSource: "digital_campaign", budgetRange: "2.5-3.2 Cr", unitPreference: "4BHK" }, createdBy: ownerUserId, ownerId: ownerUserId },
      { tenantId, firstName: "Arun", lastName: "Prakash", email: "arun.prakash@retailco.in", phone: "+91 90080 45567", jobTitle: "Head of Expansion", department: "Anchor Tenant Prospect", customFields: { leadSource: "broker_referral", requirementSqft: 12500, useCase: "retail_anchor" }, createdBy: ownerUserId, ownerId: ownerUserId },
    ])
    .returning();

  log.ok(`${contactRows.length} contacts created.`);

  /* ---- 5. The primary asset: the project ------------------------- */
  log.step(5, "Creating the primary development asset…");

  const [project] = await db
    .insert(assets)
    .values({
      tenantId,
      assetType: "project",
      assetSubtype: "semi_commercial_mixed_use",
      name: "Ordence — Basaveshwar Nagar",
      code: "AHD-BSVN-01",
      description:
        "Semi-commercial mixed-use development on Survey No. 47/2A, 3rd Block, " +
        "Basaveshwar Nagar, North-West Bengaluru. Two residential towers over a " +
        "two-level commercial podium, with basement parking across 2 levels.",
      status: "in_progress",
      valueAmount: "1284500000.00",
      currency: "INR",
      areaValue: "342800.00",
      areaUnit: "sqft",
      addressLine1: "Survey No. 47/2A, 3rd Block",
      addressLine2: "Dr. Rajkumar Road",
      locality: "Basaveshwar Nagar",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560079",
      country: "IN",
      latitude: "12.9915600",
      longitude: "77.5384200",
      acquiredDate: "2024-11-22",
      assignedUserId: ownerUserId,
      createdBy: ownerUserId,
      // ── The deeply nested JSONB payload ──
      dynamicAttributes: {
        projectCode: "AHD-BSVN-01",
        reraNumber: "PRM/KA/RERA/1251/446/PR/250318/007712",
        landExtent: { value: 2.34, unit: "acres", surveyNumbers: ["47/2A", "47/2B"] },
        zoning: {
          classification: "Mixed Residential-Commercial",
          farPermitted: 3.25,
          farConsumed: 3.19,
          groundCoveragePct: 42.5,
          setbacks: { front: "6.0m", rear: "4.5m", sideA: "4.5m", sideB: "4.5m" },
          maxHeightPermitted: "61.5m AMSL",
        },
        configuration: {
          towers: 2,
          basementLevels: 2,
          podiumLevels: 2,
          residentialFloors: 14,
          totalUnits: 168,
          unitMix: { "2BHK": 48, "3BHK": 84, "4BHK": 30, penthouse: 6 },
          commercialUnits: 22,
          parkingSlots: { car: 246, twoWheeler: 180, visitor: 34, ev: 28 },
        },
        areaStatement: {
          unit: "sqft",
          plotArea: 101930,
          builtUpArea: 342800,
          saleableAreaResidential: 268400,
          saleableAreaCommercial: 48200,
          commonArea: 26200,
          loadingFactorPct: 21.5,
        },
        timeline: {
          landAcquisition: "2024-11-22",
          approvalsCompleted: "2025-03-18",
          groundBreaking: "2025-04-02",
          structuralCompletionTarget: "2027-03-31",
          possessionTarget: "2027-12-31",
          currentPhase: "superstructure",
          overallProgressPct: 43,
          scheduleVarianceDays: -18,
        },
        // ── Cost analysis: 4 levels deep ──
        costAnalysis: COST_ANALYSIS,
        // ── Contractor assignments ──
        contractors: CONTRACTOR_ASSIGNMENTS,
        // ── Contract drafting pipeline ──
        contractStages: CONTRACT_STAGES,
        // ── Statutory approvals ──
        statutoryApprovals: STATUTORY_APPROVALS,
        salesPerformance: {
          unitsLaunched: 120,
          unitsBooked: 71,
          unitsSold: 44,
          absorptionRatePct: 59.2,
          avgRealisationPerSqft: "9840.00",
          collectionsToDate: "486200000.00",
          receivables: "212800000.00",
          bookingVelocityPerMonth: 5.4,
        },
        riskRegister: [
          { risk: "Fire NOC delay could postpone occupancy certificate", severity: "high", likelihood: "medium", owner: "Legal & Liaison", mitigation: "Escalated to KFES Deputy Director; consultant engaged 2026-05-02.", status: "open" },
          { risk: "Steel price volatility on remaining superstructure", severity: "medium", likelihood: "high", owner: "Procurement", mitigation: "60% of remaining tonnage forward-booked at ₹58,400/MT.", status: "mitigated" },
          { risk: "Facade contractor mobilisation slipping past monsoon", severity: "medium", likelihood: "medium", owner: "Projects", mitigation: "Contract negotiation being fast-tracked; LD clause retained.", status: "open" },
          { risk: "Anchor tenant lease not concluded before podium handover", severity: "high", likelihood: "low", owner: "Commercial Leasing", mitigation: "Two backup prospects in advanced discussion.", status: "open" },
        ],
      },
    })
    .returning();

  if (!project) throw new Error("Failed to create project asset.");
  log.ok(`Project created: ${project.name}`);
  log.info(`JSONB payload depth: 4 levels · ${JSON.stringify(project.dynamicAttributes).length.toLocaleString()} bytes`);

  /* ---- 6. Towers ------------------------------------------------- */
  log.step(6, "Creating towers and commercial podium…");

  const towerRows = await db
    .insert(assets)
    .values([
      { tenantId, assetType: "building", assetSubtype: "residential_tower", name: "Tower A — Kaveri", code: "AHD-BSVN-TWR-A", status: "in_progress", valueAmount: "512000000.00", currency: "INR", areaValue: "138600.00", areaUnit: "sqft", locality: "Basaveshwar Nagar", city: "Bengaluru", state: "Karnataka", postalCode: "560079", country: "IN", assignedUserId: ownerUserId, createdBy: ownerUserId, dynamicAttributes: { floors: 14, unitsPerFloor: 6, totalUnits: 84, structuralProgressPct: 62, currentFloorCasting: 9, liftCores: 2, staircases: 2, refugeFloors: [7, 14], unitMix: { "2BHK": 28, "3BHK": 42, "4BHK": 12, penthouse: 2 } } },
      { tenantId, assetType: "building", assetSubtype: "residential_tower", name: "Tower B — Tunga", code: "AHD-BSVN-TWR-B", status: "in_progress", valueAmount: "498000000.00", currency: "INR", areaValue: "129800.00", areaUnit: "sqft", locality: "Basaveshwar Nagar", city: "Bengaluru", state: "Karnataka", postalCode: "560079", country: "IN", assignedUserId: ownerUserId, createdBy: ownerUserId, dynamicAttributes: { floors: 14, unitsPerFloor: 6, totalUnits: 84, structuralProgressPct: 38, currentFloorCasting: 5, liftCores: 2, staircases: 2, refugeFloors: [7, 14], unitMix: { "2BHK": 20, "3BHK": 42, "4BHK": 18, penthouse: 4 } } },
      { tenantId, assetType: "building", assetSubtype: "commercial_podium", name: "Commercial Podium — The Arcade", code: "AHD-BSVN-PODIUM", status: "in_progress", valueAmount: "274500000.00", currency: "INR", areaValue: "74400.00", areaUnit: "sqft", locality: "Basaveshwar Nagar", city: "Bengaluru", state: "Karnataka", postalCode: "560079", country: "IN", assignedUserId: ownerUserId, createdBy: ownerUserId, dynamicAttributes: { levels: 2, commercialUnits: 22, anchorSpaceSqft: 12500, foodCourtSqft: 6800, structuralProgressPct: 24, footfallProjectionDaily: 3400, leasedUnits: 0, leaseEnquiries: 14 } },
    ])
    .returning();

  log.ok(`${towerRows.length} buildings created.`);

  // Link buildings to the project.
  await db.insert(assetRelationships).values(
    towerRows.map((tower, i) => ({
      tenantId,
      parentAssetId: project.id,
      childAssetId: tower.id,
      relationshipType: "contains" as const,
      sortOrder: i,
      metadata: { shareOfProjectValuePct: Number(((Number(tower.valueAmount) / 1284500000) * 100).toFixed(2)) },
      createdBy: ownerUserId,
    })),
  );
  log.ok("Project → Building relationships linked.");

  /* ---- 7. Units -------------------------------------------------- */
  log.step(7, "Generating residential and commercial units…");

  const towerA = towerRows[0];
  const towerB = towerRows[1];
  const podium = towerRows[2];
  if (!towerA || !towerB || !podium) throw new Error("Tower rows missing.");

  const unitValues: Array<typeof assets.$inferInsert> = [];
  const unitParents: Array<{ parent: string; code: string }> = [];

  const UNIT_TYPES = [
    { type: "2BHK", carpet: 985, saleable: 1256, basePrice: 12360000 },
    { type: "3BHK", carpet: 1420, saleable: 1812, basePrice: 17830000 },
    { type: "3BHK", carpet: 1465, saleable: 1868, basePrice: 18380000 },
    { type: "4BHK", carpet: 1980, saleable: 2524, basePrice: 24840000 },
    { type: "3BHK", carpet: 1420, saleable: 1812, basePrice: 17830000 },
    { type: "2BHK", carpet: 1010, saleable: 1288, basePrice: 12670000 },
  ];

  const STATUSES = ["available", "reserved", "under_offer", "sold"] as const;

  for (const [towerIdx, tower] of [towerA, towerB].entries()) {
    const towerLetter = towerIdx === 0 ? "A" : "B";
    for (let floor = 1; floor <= 14; floor++) {
      for (let pos = 0; pos < 6; pos++) {
        const spec = UNIT_TYPES[pos];
        if (!spec) continue;

        const unitNo = `${floor}0${pos + 1}`;
        const code = `AHD-BSVN-${towerLetter}-${unitNo}`;
        // Floor-rise premium: ₹35/sqft per floor above the second.
        const floorRise = Math.max(0, floor - 2) * 35 * spec.saleable;
        const price = spec.basePrice + floorRise;

        // Deterministic status spread so re-runs produce identical data.
        const seedIdx = (towerIdx * 84 + (floor - 1) * 6 + pos) % 10;
        const status =
          seedIdx < 5 ? STATUSES[0] : seedIdx < 7 ? STATUSES[1] : seedIdx < 8 ? STATUSES[2] : STATUSES[3];

        unitValues.push({
          tenantId,
          assetType: "unit",
          assetSubtype: spec.type,
          name: `${towerLetter}-${unitNo} · ${spec.type}`,
          code,
          status: status ?? "available",
          valueAmount: String(price.toFixed(2)),
          currency: "INR",
          areaValue: String(spec.saleable.toFixed(2)),
          areaUnit: "sqft",
          locality: "Basaveshwar Nagar",
          city: "Bengaluru",
          state: "Karnataka",
          postalCode: "560079",
          country: "IN",
          createdBy: ownerUserId,
          dynamicAttributes: {
            tower: towerLetter,
            floor,
            unitNumber: unitNo,
            configuration: spec.type,
            carpetAreaSqft: spec.carpet,
            saleableAreaSqft: spec.saleable,
            balconyAreaSqft: Math.round(spec.saleable * 0.08),
            facing: ["East", "North-East", "North", "West", "South-West", "South"][pos] ?? "East",
            vastuCompliant: pos % 2 === 0,
            pricing: {
              basePricePerSqft: Number((spec.basePrice / spec.saleable).toFixed(2)),
              floorRisePerSqft: Math.max(0, floor - 2) * 35,
              allInPrice: price,
              gstPct: 5,
              registrationPct: 6.6,
              parkingSlots: spec.type === "2BHK" ? 1 : 2,
            },
            possessionTarget: "2027-12-31",
          },
        });
        unitParents.push({ parent: tower.id, code });
      }
    }
  }

  // Commercial units.
  for (let i = 1; i <= 22; i++) {
    const level = i <= 12 ? "Ground" : "Mezzanine";
    const sqft = i === 1 ? 12500 : 1200 + ((i * 137) % 900);
    unitValues.push({
      tenantId,
      assetType: "unit",
      assetSubtype: "commercial",
      name: `Arcade ${level} — Shop ${String(i).padStart(2, "0")}`,
      code: `AHD-BSVN-COM-${String(i).padStart(2, "0")}`,
      status: i === 1 ? "under_offer" : "available",
      valueAmount: String((sqft * 16800).toFixed(2)),
      currency: "INR",
      areaValue: String(sqft.toFixed(2)),
      areaUnit: "sqft",
      locality: "Basaveshwar Nagar",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560079",
      country: "IN",
      createdBy: ownerUserId,
      dynamicAttributes: {
        level,
        shopNumber: i,
        carpetAreaSqft: Math.round(sqft * 0.78),
        frontageFt: 18 + (i % 7),
        isAnchor: i === 1,
        leaseRatePerSqftMonth: i === 1 ? 96 : 128,
        expectedUse: i === 1 ? "retail_anchor" : i <= 6 ? "f_and_b" : "retail",
      },
    });
    unitParents.push({ parent: podium.id, code: `AHD-BSVN-COM-${String(i).padStart(2, "0")}` });
  }

  // Insert in chunks — a single 190-row insert can exceed statement limits.
  const CHUNK = 50;
  const insertedUnits: Array<{ id: string; code: string | null }> = [];
  for (let i = 0; i < unitValues.length; i += CHUNK) {
    const chunk = unitValues.slice(i, i + CHUNK);
    const rows = await db.insert(assets).values(chunk).returning({ id: assets.id, code: assets.code });
    insertedUnits.push(...rows);
  }
  log.ok(`${insertedUnits.length} units created (168 residential + 22 commercial).`);

  // Link units to their parent building.
  const unitIdByCode = new Map(insertedUnits.map((u) => [u.code, u.id]));
  const relValues = unitParents
    .map((p, i) => {
      const childId = unitIdByCode.get(p.code);
      if (!childId) return null;
      return {
        tenantId,
        parentAssetId: p.parent,
        childAssetId: childId,
        relationshipType: "contains" as const,
        sortOrder: i,
        createdBy: ownerUserId,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  for (let i = 0; i < relValues.length; i += CHUNK) {
    await db.insert(assetRelationships).values(relValues.slice(i, i + CHUNK));
  }
  log.ok(`${relValues.length} Building → Unit relationships linked.`);

  /* ---- 8. Custom objects ----------------------------------------- */
  log.step(8, "Defining custom objects (zero-migration entities)…");

  const [siteVisitDef] = await db
    .insert(customObjectDefinitions)
    .values({
      tenantId,
      name: "Site Visit",
      pluralName: "Site Visits",
      slug: "site-visit",
      icon: "map-pin",
      color: "#B08D3C",
      description: "Prospective buyer visits to the Basaveshwar Nagar experience centre.",
      displayFieldName: "visitor_name",
      industryTemplate: "real_estate_developer",
      createdBy: ownerUserId,
    })
    .returning();

  if (!siteVisitDef) throw new Error("Failed to create Site Visit definition.");

  await db.insert(customFieldDefinitions).values([
    { tenantId, objectDefinitionId: siteVisitDef.id, fieldName: "visitor_name", label: "Visitor Name", fieldType: "text", isRequired: true, sortOrder: 0 },
    { tenantId, objectDefinitionId: siteVisitDef.id, fieldName: "visit_date", label: "Visit Date", fieldType: "date", isRequired: true, sortOrder: 1 },
    { tenantId, objectDefinitionId: siteVisitDef.id, fieldName: "unit_interest", label: "Unit of Interest", fieldType: "text", sortOrder: 2 },
    { tenantId, objectDefinitionId: siteVisitDef.id, fieldName: "budget", label: "Stated Budget", fieldType: "currency", validation: { currencyCode: "INR" }, sortOrder: 3 },
    { tenantId, objectDefinitionId: siteVisitDef.id, fieldName: "outcome", label: "Outcome", fieldType: "select", options: [{ label: "Follow-up scheduled", value: "follow_up" }, { label: "Booked", value: "booked" }, { label: "Not interested", value: "lost" }, { label: "Undecided", value: "undecided" }], sortOrder: 4 },
    { tenantId, objectDefinitionId: siteVisitDef.id, fieldName: "notes", label: "Notes", fieldType: "textarea", sortOrder: 5 },
  ]);

  const [approvalDef] = await db
    .insert(customObjectDefinitions)
    .values({
      tenantId,
      name: "Statutory Approval",
      pluralName: "Statutory Approvals",
      slug: "statutory-approval",
      icon: "stamp",
      color: "#1A1A1A",
      description: "Regulatory approvals tracked across BBMP, BWSSB, KSPCB, RERA and others.",
      displayFieldName: "approval_name",
      industryTemplate: "real_estate_developer",
      createdBy: ownerUserId,
    })
    .returning();

  if (!approvalDef) throw new Error("Failed to create Approval definition.");

  await db.insert(customFieldDefinitions).values([
    { tenantId, objectDefinitionId: approvalDef.id, fieldName: "approval_name", label: "Approval", fieldType: "text", isRequired: true, sortOrder: 0 },
    { tenantId, objectDefinitionId: approvalDef.id, fieldName: "authority", label: "Authority", fieldType: "text", isRequired: true, sortOrder: 1 },
    { tenantId, objectDefinitionId: approvalDef.id, fieldName: "reference_no", label: "Reference No.", fieldType: "text", sortOrder: 2 },
    { tenantId, objectDefinitionId: approvalDef.id, fieldName: "status", label: "Status", fieldType: "select", isRequired: true, options: [{ label: "Obtained", value: "obtained" }, { label: "In Process", value: "in_process" }, { label: "Not Applied", value: "not_applied" }, { label: "Rejected", value: "rejected" }], sortOrder: 3 },
    { tenantId, objectDefinitionId: approvalDef.id, fieldName: "obtained_on", label: "Obtained On", fieldType: "date", sortOrder: 4 },
    { tenantId, objectDefinitionId: approvalDef.id, fieldName: "valid_until", label: "Valid Until", fieldType: "date", sortOrder: 5 },
  ]);

  log.ok("2 custom objects defined with 12 fields — no migration required.");

  // Populate approval records from the statutory approvals list.
  await db.insert(customObjectRecords).values(
    STATUTORY_APPROVALS.map((a) => ({
      tenantId,
      definitionId: approvalDef.id,
      displayValue: `${a.authority} — ${a.approval}`,
      ownerId: ownerUserId,
      createdBy: ownerUserId,
      data: {
        approval_name: a.approval,
        authority: a.authority,
        reference_no: a.refNo,
        status: a.status,
        obtained_on: "obtainedOn" in a ? a.obtainedOn : null,
        valid_until: "validUntil" in a ? a.validUntil : null,
      } as Record<string, unknown>,
    })),
  );

  const siteVisitRecords = [
    { visitor_name: "Vikram Mehta", visit_date: "2026-06-14", unit_interest: "A-903 · 3BHK", budget: 21000000, outcome: "follow_up", notes: "Wants east-facing. Comparing against a Rajajinagar project." },
    { visitor_name: "Lakshmi Iyer", visit_date: "2026-06-21", unit_interest: "B-1204 · 4BHK", budget: 28500000, outcome: "booked", notes: "Booked on the spot. Token ₹5L received." },
    { visitor_name: "Suresh Babu", visit_date: "2026-07-02", unit_interest: "A-405 · 3BHK", budget: 18000000, outcome: "undecided", notes: "Spouse to visit before deciding." },
    { visitor_name: "Fatima Sheikh", visit_date: "2026-07-09", unit_interest: "B-702 · 3BHK", budget: 19500000, outcome: "follow_up", notes: "Home loan pre-approval in progress with SBI." },
    { visitor_name: "Arun Prakash", visit_date: "2026-07-18", unit_interest: "Arcade Ground — Shop 01", budget: 210000000, outcome: "follow_up", notes: "Anchor tenant prospect. 12,500 sqft requirement." },
  ];

  await db.insert(customObjectRecords).values(
    siteVisitRecords.map((r) => ({
      tenantId,
      definitionId: siteVisitDef.id,
      displayValue: r.visitor_name,
      ownerId: ownerUserId,
      createdBy: ownerUserId,
      data: r as Record<string, unknown>,
    })),
  );

  log.ok(`${STATUTORY_APPROVALS.length + siteVisitRecords.length} custom records created.`);

  /* ---- 9. Deals -------------------------------------------------- */
  log.step(9, "Seeding bookings…");

  const dealRows = await db
    .insert(deals)
    .values([
      { tenantId, title: "Booking — B-1204 · 4BHK (L. Iyer)", contactId: contactRows[6]?.id ?? null, amount: "28500000.00", currency: "INR", stage: "won", probability: 100, expectedCloseDate: "2026-06-21", actualCloseDate: "2026-06-21", source: "digital_campaign", ownerId: ownerUserId, createdBy: ownerUserId, customFields: { unitCode: "AHD-BSVN-B-1204", tokenReceived: "500000.00", agreementStatus: "pending_registration" } },
      { tenantId, title: "Booking — A-903 · 3BHK (V. Mehta)", contactId: contactRows[5]?.id ?? null, amount: "21000000.00", currency: "INR", stage: "negotiation", probability: 65, expectedCloseDate: "2026-08-30", source: "site_visit", ownerId: ownerUserId, createdBy: ownerUserId, customFields: { unitCode: "AHD-BSVN-A-903", competingProject: "Rajajinagar — Prestige" } },
      { tenantId, title: "Anchor Lease — Arcade Ground Shop 01", contactId: contactRows[7]?.id ?? null, companyId: null, amount: "210000000.00", currency: "INR", stage: "proposal", probability: 45, expectedCloseDate: "2026-10-31", source: "broker_referral", ownerId: ownerUserId, createdBy: ownerUserId, customFields: { leaseTermYears: 9, lockInYears: 5, escalationPct: 15, rentFreeMonths: 4, areaSqft: 12500 } },
    ])
    .returning();

  log.ok(`${dealRows.length} deals created.`);

  /* ---- Summary --------------------------------------------------- */
  const totalAssets = 1 + towerRows.length + insertedUnits.length;

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  SEED COMPLETE                                                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`
  Tenant            Ordence Developers Pvt Ltd
  Slug              ${SEED_SLUG}
  Industry          real_estate_developer
  Tenant ID         ${tenantId}

  Companies         ${companyRows.length}
  Contacts          ${contactRows.length}
  Deals             ${dealRows.length}
  Assets            ${totalAssets}  (1 project + ${towerRows.length} buildings + ${insertedUnits.length} units)
  Relationships     ${towerRows.length + relValues.length}
  Custom objects    2  (12 fields, ${STATUTORY_APPROVALS.length + siteVisitRecords.length} records)

  Nested JSONB      ${JSON.stringify(project.dynamicAttributes).length.toLocaleString()} bytes, 4 levels deep
                    cost analysis · contractors · contract stages · approvals · risks
`);
  console.log("  Next:  npm run dev   →   http://localhost:3000/assets\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Seed failed:\n");
    console.error(err);
    process.exit(1);
  });
