import { describe, it, expect, vi } from "vitest";
import { recordPlatformAudit } from "@/server/platform/guard";
import { hashAuditContent, chainScopeFor, nextChainLink, verifyAuditChain, PLATFORM_CHAIN_SCOPE } from "@/lib/audit/chain";
import { db } from "@/db";
import { auditLogs, platformActionLog } from "@/db/schema";
import { eq, desc, isNotNull, and } from "drizzle-orm";

// Mock withTenant and withPlatformScope to capture the inserts
// This is a bit tricky because they are dynamic imports in guard.ts
// Let's just mock the whole drizzle-orm and db

// Actually, it's easier to mock the db module.

// Let's create a mock db that records the inserts

type InsertPayload = {
  table: typeof auditLogs | typeof platformActionLog;
  values: Record<string, unknown>;
};

const inserts: InsertPayload[] = [];

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return {
    ...actual,
    withTenant: vi.fn(async (_tenantId: string, cb: (tx: any) => Promise<void>) => {
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => []),
              })),
            })),
          })),
        })),
        insert: vi.fn((table: any) => ({
          values: vi.fn(async (val: any) => {
            inserts.push({ table, values: val });
          }),
        })),
      };
      await cb(tx);
    }),
    withPlatformScope: vi.fn(async (_reason: string, cb: (tx: any) => Promise<void>) => {
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => []),
              })),
            })),
          })),
        })),
        insert: vi.fn((table: any) => ({
          values: vi.fn(async (val: any) => {
            inserts.push({ table, values: val });
          }),
        })),
      };
      await cb(tx);
    }),
  };
});

describe("recordPlatformAudit", () => {
  beforeEach(() => {
    inserts.length = 0;
  });

  it("writes tenant-attributed rows with chain columns", async () => {
    const tenantId = "tenant-1";
    const entry = {
      operator: {
        clerkUserId: "clerk-1",
        email: "op@example.com",
        grade: "admin",
        ipAddress: "127.0.0.1",
        userAgent: "node-test",
        requestId: "req-1",
      },
      tenantId: tenantId,
      action: "read" as const,
      resourceType: "user",
      resourceId: "user-1",
      reason: "test",
    };

    await recordPlatformAudit(entry);

    expect(inserts.length).toBe(1);
    expect(inserts[0].table).toBe(auditLogs);
    const vals = inserts[0].values as any;
    console.log("VALS:", JSON.stringify(vals, null, 2));
    expect(vals.tenantId).toBe(tenantId);
    expect(vals.chainSeq).toBeDefined();
    expect(vals.prevHash).toBeDefined();
    expect(vals.contentHash).toBeDefined();
    expect(vals.rowHash).toBeDefined();

    // Verify the hash
    const scope = chainScopeFor(tenantId);
    const { chainSeq, prevHash, contentHash, rowHash, ...nonHashVals } = vals;
    const expectedLink = nextChainLink({ scope, head: null, content: nonHashVals });
    expect(vals.chainSeq).toBe(expectedLink.chainSeq);
    expect(vals.prevHash).toBe(expectedLink.prevHash);
    expect(vals.contentHash).toBe(expectedLink.contentHash);
    expect(vals.rowHash).toBe(expectedLink.rowHash);
  });


  it("writes platform-only rows with chain columns", async () => {
    const entry = {
      operator: {
        clerkUserId: "clerk-1",
        email: "op@example.com",
        grade: "admin",
        ipAddress: "127.0.0.1",
        userAgent: "node-test",
        requestId: "req-1",
      },
      tenantId: null,
      action: "read" as const,
      resourceType: "tenant",
      resourceId: null,
      reason: "test",
    };

    await recordPlatformAudit(entry);

    expect(inserts.length).toBe(1);
    expect(inserts[0].table).toBe(platformActionLog);
    const vals = inserts[0].values as any;
    const { chainSeq: phChainSeq, prevHash: phPrevHash, contentHash: phContentHash, rowHash: phRowHash, ...phNonHashVals } = vals;
    const phScope = chainScopeFor(null);
    expect(phScope).toBe(PLATFORM_CHAIN_SCOPE);
    console.log("phNonHashVals:", JSON.stringify(phNonHashVals, null, 2));
    const phExpectedLink = nextChainLink({ scope: phScope, head: null, content: phNonHashVals });
    console.log("phExpectedLink:", JSON.stringify(phExpectedLink, null, 2));
    expect(vals.chainSeq).toBe(phExpectedLink.chainSeq);
    expect(vals.prevHash).toBeDefined();
    expect(vals.contentHash).toBeDefined();
    expect(vals.rowHash).toBeDefined();

    // Verify the hash
    const scope = chainScopeFor(null);
    expect(scope).toBe(PLATFORM_CHAIN_SCOPE);
    const expectedLink = nextChainLink({ scope, head: null, content: phNonHashVals });
    expect(vals.chainSeq).toBe(expectedLink.chainSeq);
    expect(vals.prevHash).toBe(expectedLink.prevHash);
    expect(vals.contentHash).toBe(expectedLink.contentHash);
    expect(vals.rowHash).toBe(expectedLink.rowHash);
  });

});
