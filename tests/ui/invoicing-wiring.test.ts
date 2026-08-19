/**
 * Sales invoicing: the wiring, and the readiness probe.
 *
 * These read source. Every invariant here compiles fine while being
 * wrong, which is exactly why a type checker cannot cover them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments are stripped: a comment quoting a broken pattern is not a relapse. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ACTIONS = read("server/actions/sales-invoices.ts");
const DOCUMENTS = read("server/invoicing/documents.ts");
const BUILD = read("lib/invoicing/build.ts");
const VALIDATORS = read("lib/validators/sales-invoices.ts");
const SQL = read("SQL-FILES/0049_sales_invoices.sql");
const READY = read("app/api/ready/route.ts");
const MIDDLEWARE = read("middleware.ts");
const RAILWAY = read("railway.json");

describe("🔴 there is exactly one tax engine", () => {
  it("build.ts delegates and never re-derives a tax head", () => {
    expect(BUILD).toContain("computeInvoiceTax");
    const body = code(BUILD);
    // No literal rate arithmetic — the giveaway of a second engine.
    expect(body).not.toMatch(/rateBps\s*\/\s*10000/);
    expect(body).not.toMatch(/\*\s*0\.09|\*\s*0\.18/);
  });

  it("the action delegates to build.ts rather than computing", () => {
    expect(code(ACTIONS)).toContain("buildInvoice(");
    expect(code(ACTIONS)).not.toContain("computeInvoiceTax(");
  });
});

describe("🔴 quantity never becomes a float", () => {
  it("build.ts does not parseFloat or Number() a quantity", () => {
    const body = code(BUILD);
    expect(body).not.toContain("parseFloat");
    expect(body).not.toMatch(/Number\(\s*(value|quantity|raw)/);
  });

  it("the validator keeps quantity as a string", () => {
    expect(code(VALIDATORS)).not.toMatch(/quantitySchema[\s\S]{0,120}\.transform/);
  });
});

describe("🔴 the invoice number is never accepted from the caller", () => {
  it("no schema has an invoiceNumber field", () => {
    expect(code(VALIDATORS)).not.toMatch(/invoiceNumber\s*:/);
  });

  it("it is derived inside the transaction that issues", () => {
    expect(code(ACTIONS)).toContain("nextInvoiceNumber(");
  });

  it("a draft carries a placeholder, so the series has no holes", () => {
    expect(code(ACTIONS)).toMatch(/DRAFT-/);
  });

  it("the unique index is the real guarantee", () => {
    expect(SQL).toContain("sales_invoices_number_tenant_key UNIQUE (tenant_id, invoice_number)");
  });
});

describe("🔴 issuing is separate from raising", () => {
  it("they are two exports with two permissions", () => {
    expect(ACTIONS).toContain("sales.invoices.create");
    expect(ACTIONS).toContain("sales.invoices.issue");
  });

  it("re-issuing is refused, not made idempotent", () => {
    expect(code(ACTIONS)).toMatch(/status !== "draft"/);
  });

  it("an issued invoice is frozen by a trigger, not only by code", () => {
    expect(SQL).toContain("sales_invoice_freeze_after_issue");
    expect(SQL).toContain("sales_invoices_freeze");
  });
});

describe("🔴 money cannot cross customers or settle nothing", () => {
  it("an allocation checks the invoice belongs to the receipt's customer", () => {
    expect(code(ACTIONS)).toContain("invoice.companyId !== receipt.companyId");
  });

  it("a bounced receipt cannot be allocated", () => {
    expect(code(ACTIONS)).toMatch(/receipt\.status !== "cleared"/);
  });

  it("re-allocating replaces rather than adds", () => {
    expect(code(ACTIONS)).toContain("onConflictDoUpdate");
    expect(code(ACTIONS)).not.toMatch(/amountMinor:\s*sql`[^`]*\+/);
  });

  it("the database enforces both over-allocation limits", () => {
    expect(SQL).toContain("customer_receipts_allocated_within_amount");
    expect(SQL).toContain("sales_invoices_received_within_total");
  });
});

describe("⭐ the write-back that revives the 0048 credit limits", () => {
  it("0049 writes received_value_minor on the order", () => {
    expect(SQL).toContain("received_value_minor = COALESCE((");
  });

  it("and qty_invoiced on the order line", () => {
    expect(SQL).toContain("qty_invoiced = COALESCE((");
  });

  it("only issued invoices count — a draft must not consume the order", () => {
    const writeback = SQL.slice(SQL.indexOf("sales_order_recalc_from_invoices"));
    expect(writeback).toContain("i.status IN ('issued', 'part_paid', 'paid')");
  });

  it("a bounced receipt settles nothing", () => {
    expect(SQL).toContain("r.status IN ('pending', 'cleared')");
  });
});

describe("🔴 tenant safety", () => {
  it("the reads that take a tenantId are server-only", () => {
    expect(DOCUMENTS.startsWith('import "server-only";')).toBe(true);
  });

  it("no action export takes a tenantId", () => {
    expect(code(ACTIONS)).not.toMatch(/export async function \w+\([^)]*tenantId/);
  });

  it("every new table is tenant-isolated with platform read but not write", () => {
    const using = SQL.match(
      /USING\s+\(tenant_id = app_current_tenant_id\(\) OR app_platform_scope\(\)\)/g,
    );
    expect(using?.length).toBe(4);
    for (const c of SQL.match(/WITH CHECK\s+\([^)]*\)/g) ?? []) {
      expect(c).not.toContain("app_platform_scope");
    }
  });
});

describe("🔴 the readiness probe actually touches the database", () => {
  it("runs a query rather than returning a literal", () => {
    expect(READY).toContain("select 1");
    expect(code(READY)).toContain("db.execute");
  });

  it("returns 503 when the database is unreachable", () => {
    expect(code(READY)).toContain("status: ok ? 200 : 503");
  });

  it("leaks a SQLSTATE code and never a driver message", () => {
    const body = code(READY);
    expect(body).toContain('"code" in err');
    expect(body).not.toMatch(/err\.message|String\(err\)/);
  });

  it("is public, because an uptime monitor has no session", () => {
    expect(code(MIDDLEWARE)).toContain('"/api/ready"');
  });

  /**
   * Railway restarts a container that fails its healthcheck. Pointing it
   * at a DB-aware probe turns a Neon outage into a restart loop that
   * destroys the logs explaining it.
   */
  it("is NOT wired as the Railway container healthcheck", () => {
    expect(RAILWAY).toContain('"healthcheckPath": "/api/health"');
    expect(RAILWAY).not.toContain("/api/ready");
  });
});
