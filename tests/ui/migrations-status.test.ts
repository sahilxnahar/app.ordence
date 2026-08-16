import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMigrationsStatus } from "@/lib/migrations/status";
import * as db from "@/db";
import * as guard from "@/server/platform/guard";

describe("Migrations Status", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return migration status", async () => {
    vi.spyOn(guard, "requirePlatformAdmin").mockResolvedValue({
      clerkUserId: "user_123",
      email: "admin@example.com",
      grade: "admin",
      staff: {
        clerkUserId: "user_123",
        email: "admin@example.com",
        grade: "admin",
        status: "active",
        expiresAt: null,
        allowlisted: true,
        now: new Date(),
      },
      capabilities: [],
      ipAddress: "127.0.0.1",
      userAgent: "test",
      requestId: "req_123",
    });

    vi.spyOn(db, "withPlatformScope").mockResolvedValue({
      rows: [
        { num: "0001", fileName: "0001_rls_and_audit_guard.sql", signature: "policy", present: true },
        { num: "0002", fileName: "0002_phase2_rls.sql", signature: "policy", present: false },
      ],
    });

    const result = await getMigrationsStatus();

    expect(result.summary.total).toBe(2);
    expect(result.summary.applied).toBe(1);
    expect(result.summary.missing).toBe(1);
    expect(result.migrations[0].present).toBe(true);
    expect(result.migrations[1].present).toBe(false);
  });

  it("should throw if not platform admin", async () => {
    vi.spyOn(guard, "requirePlatformAdmin").mockRejectedValue(new Error("not_platform_staff"));

    await expect(getMigrationsStatus()).rejects.toThrow("not_platform_staff");
  });
});
