/**
 * Ordence — 🔴🔴🔴 THE DRAWING REGISTER IS REACHABLE, AND ITS RULES HOLD
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `tests/ui/cad-engine.test.ts` proves the engine reads and writes a DXF
 * correctly. This proves the engine is CONNECTED TO ANYTHING — the
 * recurring defect in this codebase, measured at 192 exported server
 * actions reached from nowhere.
 *
 * ⭐ AND IT ASSERTS THE THREE PROPERTIES THE SCHEMA IS BUILT AROUND,
 * because each of them is a promise the product makes to somebody who is
 * about to upload their consultant's drawing into it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PERMISSION_CATALOG, permissionsForRole } from "@/db/schema/auth";
import { DRAWING_UNITS, UNITLESS_REFUSAL, toMetres } from "@/lib/cad/units";
import { effectiveUnit, citeMeasurement } from "@/server/cad/measure";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const ACTIONS = read("server/actions/drawings.ts");
const SQL = read("SQL-FILES/0118_drawing_register.sql");
const REGISTER_PAGE = read("app/(crm)/drawings/page.tsx");
const DETAIL_PAGE = read("app/(crm)/drawings/[id]/page.tsx");

describe("⭐ the route reaches every action wave 7 added", () => {
  const callers = codeOnly(
    [
      REGISTER_PAGE,
      DETAIL_PAGE,
      read("app/(crm)/drawings/drawing-intake.tsx"),
      read("app/(crm)/drawings/[id]/unit-panel.tsx"),
      read("app/(crm)/drawings/[id]/markup-list.tsx"),
      read("app/(crm)/drawings/[id]/revision-intake.tsx"),
      read("app/(crm)/drawings/[id]/revision-viewer.tsx"),
      read("components/drawings/drawing-viewer.tsx"),
    ].join("\n"),
  );

  it("every exported action has a caller, by name", () => {
    const actions = [...ACTIONS.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(5);
    for (const action of actions) {
      expect(callers, `${action} is exported and nothing calls it`).toContain(action);
    }
  });

  it("is in the construction navigation, not only at a URL", () => {
    expect(read("lib/industry-templates.ts")).toContain('href: "/drawings"');
  });

  it("sits before the BOQ in that menu, because that is the order the work happens in", () => {
    const nav = read("lib/industry-templates.ts");
    expect(nav.indexOf('href: "/drawings"')).toBeLessThan(nav.indexOf('href: "/boq"'));
  });
});

describe("🔴 four permissions, and the split is the point", () => {
  it("declares all four", () => {
    for (const key of [
      "drawings:read",
      "drawings:manage",
      "drawings:markup",
      "drawings:measure",
    ]) {
      expect(Object.keys(PERMISSION_CATALOG)).toContain(key);
    }
  });

  it("🔴 a team member may look and comment and NOT measure", () => {
    /*
     * A quantity taken off a drawing goes into a BOQ and into a running
     * bill somebody gets paid against. A site engineer who may check a
     * dimension on screen is not automatically a quantity surveyor.
     */
    const member = permissionsForRole("member");
    expect(member).toContain("drawings:read");
    expect(member).toContain("drawings:markup");
    expect(member).not.toContain("drawings:measure");
    expect(member).not.toContain("drawings:manage");
  });

  it("a read-only role reads the sheet and marks up nothing", () => {
    const readOnly = permissionsForRole("read_only");
    expect(readOnly).toContain("drawings:read");
    expect(readOnly).not.toContain("drawings:markup");
  });

  it("each action asks for the narrow key rather than one blanket one", () => {
    /**
     * ⚠️ THROUGH `guardDrawings`, which is the four-gate stack: account
     * standing, then plan, then permission. The narrowness being asserted
     * is in the KEY passed to it, not in which helper is called.
     */
    expect(ACTIONS).toContain('guardDrawings("drawings:measure")');
    expect(ACTIONS).toContain('guardDrawings("drawings:markup")');
    expect(ACTIONS).toContain('guardDrawings("drawings:manage")');
    expect(ACTIONS).toContain('guardDrawings("drawings:read")');
  });

  it("and every one of them passes the plan gate too", () => {
    /**
     * 🔴 `lib/entitlements/enforcement.ts` RECORDS THIS KEY AS `gated`,
     * and a key marked gated with no gate under `server/` fails the
     * build. That ledger exists because a control declared and enforced
     * by nothing has been found in this codebase repeatedly.
     */
    expect(ACTIONS).toContain('requireFeature("construction.drawings"');
    expect(ACTIONS).toContain("requireAccess(permission, ctx)");
  });

  it("🔴 setting the unit is `manage`, not `measure`", () => {
    /*
     * This decision does not produce one quantity, it produces EVERY
     * quantity anybody ever takes off the sheet.
     */
    const at = ACTIONS.indexOf("export async function setDrawingUnit");
    const body = ACTIONS.slice(at, at + 1600);
    expect(body).toContain('guardDrawings("drawings:manage")');
    expect(body).not.toContain('guardDrawings("drawings:measure")');
  });
});

describe("🔴 ① the original file is never modified", () => {
  it("markups are their own table, in drawing coordinates", () => {
    expect(SQL).toContain("CREATE TABLE IF NOT EXISTS public.drawing_markups");
    expect(SQL).toMatch(/POSITIONED IN DRAWING COORDINATES, NOT IN SCREEN PIXELS/);
  });

  it("nothing anywhere writes a DXF back over the stored file", () => {
    const register = codeOnly(read("server/cad/register.ts"));
    expect(register).not.toContain("putStoredObject");
    expect(register).not.toContain("exportDxf");
  });

  it("and the screen says so, where somebody decides whether to upload", () => {
    expect(read("app/(crm)/drawings/[id]/revision-intake.tsx")).toMatch(
      /byte-for-byte the one\s+they sent/,
    );
  });
});

describe("🔴 ② a superseded revision is frozen", () => {
  it("the database refuses the edit", () => {
    expect(SQL).toContain("ordence_guard_superseded_revision");
    expect(SQL).toMatch(/evidence of what was issued and built to/);
  });

  it("and allows exactly one thing: withdrawing one issued in error", () => {
    expect(SQL).toMatch(/IF NEW\.superseded_at IS NULL/);
  });

  it("issuing a revision and superseding the last happen in one transaction", () => {
    /*
     * 🔴 A revision inserted without its predecessor being superseded
     * leaves TWO sheets that both look current, which is the single
     * failure a drawing register exists to prevent.
     */
    const register = read("server/cad/register.ts");
    const at = register.indexOf("export async function issueRevision");
    const body = register.slice(at);
    expect(body).toMatch(/withTenant\(args\.tenantId, async \(tx\) => \{/);
    expect(body.indexOf("supersededAt: new Date()")).toBeGreaterThan(
      body.indexOf(".insert(drawingRevisions)"),
    );
  });
});

describe("🔴 ③ a measurement cites its source", () => {
  it("the unit decision is attributed, or it is not recorded", () => {
    expect(SQL).toContain("drawing_revisions_assumption_is_attributed");
  });

  it("and cannot be made over a unit the file already declared", () => {
    expect(SQL).toContain("drawing_revisions_no_assumption_over_declaration");
  });

  it("the declared unit wins over an assumption", () => {
    expect(effectiveUnit({ declaredUnit: "metres", assumedUnit: "feet" })).toEqual({
      unit: "metres",
      assumed: false,
    });
    expect(effectiveUnit({ declaredUnit: "unitless", assumedUnit: "feet" })).toEqual({
      unit: "feet",
      assumed: true,
    });
    expect(effectiveUnit({ declaredUnit: null, assumedUnit: null })).toEqual({
      unit: null,
      assumed: false,
    });
  });

  it("🔴 refuses to measure a drawing nobody has given units to", () => {
    expect(() => toMetres(1000, null)).toThrow(UNITLESS_REFUSAL.slice(0, 40));
    /* ⚠️ ONE SENTENCE IN THE PRODUCT FOR THIS, not two that drift apart. */
    expect(read("server/cad/measure.ts")).toContain("UNITLESS_REFUSAL");
    expect(read("app/(crm)/drawings/[id]/unit-panel.tsx")).toMatch(
      /not the same as millimetres/,
    );
  });

  it("exact means exact, in the database as well as in the code", () => {
    expect(SQL).toContain("drawing_measurements_exact_has_no_error");
  });

  it("a measurement cannot be edited, only re-taken", () => {
    expect(SQL).toContain("ordence_guard_drawing_measurements");
    expect(SQL).toMatch(/always the one that changes what was paid/);
  });

  it("the citation names the sheet, the revision and the basis", () => {
    const cited = citeMeasurement(
      {
        kind: "area",
        valueSi: 412.15,
        maxErrorSi: 0.004,
        isExact: false,
        unitBasis: "millimetres",
        unitWasAssumed: true,
        label: "Ground floor slab",
      },
      "DRG-102",
      "C",
    );
    expect(cited).toContain("DRG-102 Rev C");
    expect(cited).toContain("412.150 m²");
    expect(cited).toContain("assumed");
    expect(cited).toContain("±0.0040");
  });
});

describe("⚠️ DWG is refused with something the customer can act on", () => {
  it("names the AutoCAD version and the menu path", () => {
    const lexer = read("lib/cad/dxf/lexer.ts");
    expect(lexer).toContain("AC1032");
    expect(lexer).toMatch(/Files of type/);
  });

  it("is refused in the browser, before a 40MB upload", () => {
    expect(read("app/(crm)/drawings/[id]/revision-intake.tsx")).toContain("identifyCadFile");
    expect(read("app/(crm)/drawings/drawing-intake.tsx")).toContain("dwgRefusal");
  });

  it("and again on the server, from the same pure function", () => {
    expect(read("server/cad/register.ts")).toContain("identifyCadFile");
  });

  it("DWG is not in the upload allowlist, so it cannot be stored either", () => {
    const storage = read("lib/validators/storage.ts");
    expect(storage).toContain('".dxf"');
    expect(storage).not.toContain('".dwg"');
  });
});

describe("⚠️ no CAD dependency was added", () => {
  it("reads and writes DXF with nothing installed", () => {
    const pkg = JSON.parse(read("package.json"));
    const names = Object.keys(pkg.dependencies ?? {}).join(" ");
    for (const forbidden of ["dxf", "three", "opencascade", "makerjs", "svg2pdf"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("the whole engine stays pure, so it runs in the viewer", () => {
    for (const file of [
      "lib/cad/types.ts",
      "lib/cad/units.ts",
      "lib/cad/geometry.ts",
      "lib/cad/dxf/lexer.ts",
      "lib/cad/dxf/parse.ts",
      "lib/cad/render/svg.ts",
      "lib/cad/export/dxf.ts",
      "lib/cad/view-types.ts",
    ]) {
      const code = codeOnly(read(file));
      expect(code, file).not.toContain('"server-only"');
      expect(code, file).not.toContain("node:");
      expect(code, file).not.toContain("@/db");
    }
  });

  it("every unit the picker offers is one the database will accept", () => {
    for (const unit of DRAWING_UNITS) {
      if (unit === "unitless") continue;
      expect(SQL).toContain(`'${unit}'`);
    }
  });
});
