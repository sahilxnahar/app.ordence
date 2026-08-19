/**
 * Credit control: the wiring, not the arithmetic.
 *
 * These read the source. That is unusual and it is the point — every one
 * of them guards a mistake that compiles, passes every other test, and
 * is wrong in production. The exposure maths is covered in
 * `credit-exposure.test.ts`; this file covers the things TypeScript
 * cannot see.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * ⚠️ COMMENTS ARE STRIPPED BEFORE MATCHING, AND THE FIRST DRAFT OF THIS
 * FILE FAILED BECAUSE THEY WERE NOT.
 *
 * These invariants are about what the code DOES. The comment above the
 * fix quotes the broken line verbatim — `approvedBy: order
 * .requiresApproval ? ...` — because a future reader needs to see what
 * was wrong. A test that greps raw source cannot tell that quotation
 * from a relapse, and the only way to make it pass would be to delete
 * the explanation. A test that pressures you into removing the reason a
 * rule exists is a bad test.
 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ORDERS = read("server/actions/orders.ts");
const CREDIT_SQL = read("SQL-FILES/0048_credit_limits.sql");
const CREDIT_SCHEMA = read("db/schema/credit.ts");
const POSITION = read("server/credit/position.ts");
const CREDIT_ACTIONS = read("server/actions/credit.ts");

describe("🔴 confirmOrder must never approve itself", () => {
  const confirmBody = code(
    ORDERS.slice(
      ORDERS.indexOf("export async function confirmOrder"),
      ORDERS.indexOf("export async function approveOrderCredit"),
    ),
  );

  it("finds the confirmOrder body at all", () => {
    expect(confirmBody.length).toBeGreaterThan(500);
  });

  /**
   * The regression this exists for: `approvedBy: order.requiresApproval
   * ? ctx.user.id : ...`. Every fact in the resulting audit row is true
   * and the sentence they form is false.
   */
  it("does not write approvedBy anywhere in confirmOrder", () => {
    expect(confirmBody).not.toMatch(/approvedBy\s*:/);
  });

  it("does not write approvedAt anywhere in confirmOrder", () => {
    expect(confirmBody).not.toMatch(/approvedAt\s*:/);
  });

  it("routes to pending_approval rather than refusing", () => {
    expect(confirmBody).toContain('"pending_approval"');
  });

  it("runs the credit check inside the transaction, sharing tx", () => {
    expect(confirmBody).toMatch(/assessOrderCredit\(\{\s*\n?\s*tx,/);
  });
});

describe("🔴 approveOrderCredit is the only approver", () => {
  const approveBody = code(ORDERS.slice(ORDERS.indexOf("export async function approveOrderCredit")));

  it("requires its own permission, not sales.orders.confirm", () => {
    expect(approveBody).toContain('"sales.orders.approve_credit"');
    expect(approveBody).not.toContain('permission: "sales.orders.confirm"');
  });

  it("takes the approver from the session and never from input", () => {
    expect(approveBody).toContain("approvedBy: ctx.user.id");
    expect(approveBody).not.toMatch(/approvedBy:\s*(data|input)\./);
  });

  it("refuses self-approval explicitly, not only via permissions", () => {
    expect(approveBody).toContain("order.createdBy === ctx.user.id");
  });

  it("checks the approver's value limit, not just the permission", () => {
    expect(approveBody).toContain("assessApprovalAuthority");
  });
});

describe("🔴 approval_limits is keyed on the role a session actually carries", () => {
  /**
   * The first draft had `role_id uuid REFERENCES roles(id)`. Nothing in
   * this codebase reads the `roles` table — permissions resolve from
   * `users.role`, the system_role enum. A limit keyed on roles.id would
   * grant nobody anything while the settings screen showed a fully
   * configured approval ladder.
   */
  it("the SQL column is text, not a foreign key to roles", () => {
    expect(CREDIT_SQL).toMatch(/role\s+varchar\(60\)\s+NOT NULL/);
    expect(CREDIT_SQL).not.toMatch(/role_id\s+uuid\s+NOT NULL REFERENCES roles/);
  });

  it("the Drizzle table agrees with the SQL", () => {
    expect(CREDIT_SCHEMA).toContain('varchar("role", { length: 60 })');
    expect(CREDIT_SCHEMA).not.toContain('uuid("role_id")');
  });

  it("nothing in the credit module queries the dead roles table", () => {
    expect(POSITION).not.toMatch(/from\(roles\)/);
    expect(CREDIT_ACTIONS).not.toMatch(/from\(roles\)/);
  });
});

describe("🔴 tenant isolation on the new tables", () => {
  it("both policies carry app_platform_scope() in USING", () => {
    const using = CREDIT_SQL.match(/USING\s+\(tenant_id = app_current_tenant_id\(\) OR app_platform_scope\(\)\)/g);
    expect(using?.length).toBe(2);
  });

  it("neither policy carries app_platform_scope() in WITH CHECK", () => {
    const checks = CREDIT_SQL.match(/WITH CHECK\s+\([^)]*\)/g) ?? [];
    expect(checks.length).toBe(2);
    for (const c of checks) expect(c).not.toContain("app_platform_scope");
  });

  it("both tables are ENABLE and FORCE", () => {
    expect(CREDIT_SQL.match(/ENABLE ROW LEVEL SECURITY/g)?.length).toBe(2);
    expect(CREDIT_SQL.match(/FORCE ROW LEVEL SECURITY/g)?.length).toBe(2);
  });

  it("both tables are granted to ordence_app in the same file", () => {
    expect(CREDIT_SQL).toContain("ON customer_credit_profiles TO ordence_app");
    expect(CREDIT_SQL).toContain("ON approval_limits          TO ordence_app");
  });
});

describe("🔴 the internal read module is server-only", () => {
  it("declares it on the first line", () => {
    expect(POSITION.startsWith('import "server-only";')).toBe(true);
  });

  it("the action module does not re-export the tenant-taking helpers", () => {
    expect(CREDIT_ACTIONS).not.toMatch(/export\s+\{[^}]*assessOrderCredit/);
    expect(CREDIT_ACTIONS).not.toMatch(/export\s+(async\s+)?function\s+\w+\([^)]*tenantId/);
  });
});

describe("🔴 money stays bigint across the driver boundary", () => {
  it("normalises both order money columns before arithmetic", () => {
    expect(POSITION).toContain("toBigIntAmount(r.totalMinor)");
    expect(POSITION).toContain("toBigIntAmount(r.receivedValueMinor)");
  });

  it("every money column in the schema is mode: bigint", () => {
    const schema = code(CREDIT_SCHEMA);
    /**
     * 🔴 THE ASSERTION THAT MATTERS IS THE ABSENCE, NOT THE COUNT.
     *
     * ⚠️ THIS LINE PINNED `.toBe(2)` UNTIL v1.46.0 AND WAS WRONG TO.
     * Batch 40 added five more money columns to this schema — the
     * exposure and limit as they stood on a hold and on an override, and
     * the amount due on a dunning record — every one of them correctly
     * `mode: "bigint"`, and the exact count failed for it. A number that
     * can only go up is a number that fails on good news, and the cheap
     * way to make it pass is to stop adding the columns.
     *
     * A FLOOR is the honest form: at least the two that were here, and
     * no `mode: "number"` anywhere.
     */
    expect(schema).not.toContain('mode: "number"');
    expect(schema.match(/mode: "bigint"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("🔴 there is no deleteCreditProfile", () => {
  it("the action file exports no delete for the profile", () => {
    expect(CREDIT_ACTIONS).not.toMatch(/export async function delete\w*Credit\w*Profile/);
    expect(CREDIT_ACTIONS).not.toMatch(/delete\(customerCreditProfiles\)/);
  });

  it("but the grant still includes DELETE, so the refusal is a sentence", () => {
    expect(CREDIT_SQL).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON customer_credit_profiles TO ordence_app;",
    );
  });
});
