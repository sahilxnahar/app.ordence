/**
 * Credit notes — the wiring and the legal shape.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDIT_NOTE_REASONS } from "@/lib/validators/sales-invoices";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SQL = read("SQL-FILES/0050_sales_credit_notes.sql");
const SCHEMA = read("db/schema/sales-invoices.ts");
const ACTIONS = read("server/actions/sales-invoices.ts");

describe("🔴 a credit note always names its invoice", () => {
  it("invoice_id is NOT NULL in SQL", () => {
    expect(SQL).toMatch(/invoice_id\s+uuid\s+NOT NULL/);
  });

  it("and RESTRICT, so the invoice cannot vanish beneath it", () => {
    expect(SQL).toContain("REFERENCES sales_invoices(id, tenant_id) ON DELETE RESTRICT");
  });

  it("only an issued invoice can be credited", () => {
    expect(code(ACTIONS)).toMatch(/invoice\.status === "draft" \|\| invoice\.status === "cancelled"/);
  });
});

describe("🔴 over-crediting is refused by the database", () => {
  it("the trigger exists and fires on insert and update", () => {
    expect(SQL).toContain("sales_credit_note_within_invoice");
    expect(SQL).toContain("BEFORE INSERT OR UPDATE ON sales_credit_notes");
  });

  /** A draft must not block a colleague's legitimate credit note. */
  it("drafts do not consume the invoice's headroom", () => {
    const fn = SQL.slice(SQL.indexOf("sales_credit_note_within_invoice"));
    expect(fn).toContain("status NOT IN ('draft', 'cancelled')");
  });

  it("the refusal is a sentence with both figures in rupees", () => {
    expect(SQL).toMatch(/more than the invoice charged/);
    expect(SQL).toMatch(/\/ 100\.0/);
  });
});

describe("🔴 an issued credit note is frozen", () => {
  it("has its own freeze trigger", () => {
    expect(SQL).toContain("sales_credit_note_freeze");
  });

  it("and cannot be issued twice", () => {
    const body = code(ACTIONS).slice(code(ACTIONS).indexOf("issueCreditNote"));
    expect(body).toMatch(/status !== "draft"/);
  });

  it("gets its OWN consecutive series, not the invoice series", () => {
    expect(code(ACTIONS)).toMatch(/`CN\//);
  });
});

describe("🔴 Section 34(1) is a closed list", () => {
  it("the grounds are an enum, not free text", () => {
    expect([...CREDIT_NOTE_REASONS]).toEqual([
      "sales_return",
      "rate_revision",
      "deficiency",
      "post_sale_discount",
      "other",
    ]);
  });
});

describe("🔴 there is no debit note wearing a sign column", () => {
  it("no negative-amount escape hatch in the schema", () => {
    expect(code(SCHEMA)).not.toMatch(/salesDebitNotes/);
    expect(SQL).toContain("THERE IS NO DEBIT NOTE IN THIS FILE");
  });

  it("all amounts are constrained non-negative", () => {
    expect(SQL).toContain("sales_credit_notes_amounts_non_negative");
  });
});

describe("🔴 tenant isolation", () => {
  it("both tables: platform reads, never writes", () => {
    const using = SQL.match(
      /USING\s+\(tenant_id = app_current_tenant_id\(\) OR app_platform_scope\(\)\)/g,
    );
    expect(using?.length).toBe(2);
    for (const c of SQL.match(/WITH CHECK\s+\([^)]*\)/g) ?? []) {
      expect(c).not.toContain("app_platform_scope");
    }
  });

  it("both are granted to ordence_app in the same file", () => {
    expect(SQL).toContain("ON sales_credit_notes      TO ordence_app");
    expect(SQL).toContain("ON sales_credit_note_lines TO ordence_app");
  });
});
