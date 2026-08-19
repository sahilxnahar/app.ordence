/**
 * Ordence — 🔴🔴🔴 THE EXPORT SERVICE IS REACHABLE · WAVE 5
 * Version: v1.73.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * This codebase's recurring defect, measured across wave two, is
 * BUILT-AND-UNREACHABLE: 698 exported server actions, 207 with no caller
 * anywhere under `app/` or `components/`, 109 of them writes, and 57
 * tables whose only writers are all orphaned. A complete depreciation
 * engine sat behind no navigation for four batches. `financial_periods`
 * had exactly one writer with no caller, so the period lock in
 * `writePosting` HAD NEVER ONCE BEEN ABLE TO FIRE in production.
 *
 * ⭐ Wave 5 adds a service, a log, a gate and a route. These assertions
 * are the cheap, source-level proof that the route reaches the service
 * and the tab reaches the route — the two links that were missing every
 * previous time.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXPORT_DATASETS } from "@/server/export/datasets";
import { PERMISSION_CATALOG } from "@/db/schema/auth";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("⭐ the route, the tab and the actions are one change", () => {
  const page = read("app/(crm)/settings/exports/page.tsx");
  const workbench = read("app/(crm)/settings/exports/export-workbench.tsx");
  const tabs = read("app/(crm)/settings/settings-tabs.tsx");

  it("is in the settings tab strip", () => {
    expect(tabs).toContain('href: "/settings/exports"');
  });

  it("the page calls both read actions", () => {
    expect(page).toContain("listExportableDatasets");
    expect(page).toContain("getExportLog");
  });

  it("the picker calls the two actions that do the work", () => {
    expect(workbench).toContain("exportFormatsFor");
    expect(workbench).toContain("runExport");
  });

  it("every exported action in server/actions/export.ts has a caller here", () => {
    /**
     * 🔴 THE ASSERTION `check:action-reach` MAKES GLOBALLY, MADE LOCALLY
     * SO IT FAILS WITH A USEFUL NAME. The global gate reports a count
     * going up; this one reports which function nothing calls.
     *
     * ⚠️ COMMENTS ARE STRIPPED FIRST. The gate itself shipped counting a
     * DOC COMMENT as a caller and under-reported the orphan population by
     * twenty-six.
     */
    const source = read("server/actions/export.ts");
    const callers = [page, workbench]
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

    const actions = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(callers, `${action} is exported and nothing calls it`).toContain(action);
    }
  });
});

describe("⚠️ every dataset declares a permission that exists", () => {
  it("uses real permission keys", () => {
    /**
     * 🔴 WAVE 3 SHIPPED `users:manage`, WHICH IS NOT A PERMISSION. It
     * read plausibly and the correct key is `users:invite`. A permission
     * key that does not exist is a check that can never pass, or — worse,
     * depending on the implementation — one that never runs.
     */
    for (const dataset of EXPORT_DATASETS) {
      expect(
        Object.keys(PERMISSION_CATALOG),
        `dataset "${dataset.key}" requires "${dataset.permission}", which is not a permission`,
      ).toContain(dataset.permission);
    }
  });

  it("does not put everything behind one blanket permission", () => {
    /**
     * ⭐ READING IS NOT EXPORTING, and one "may export" key would
     * collapse a distinction `db/schema/auth.ts` has drawn since Phase 4:
     * `contacts:read` and `contacts:export` are separate because a
     * salesperson who may see a contact may not take the whole list home.
     */
    const permissions = new Set(EXPORT_DATASETS.map((d) => d.permission));
    expect(permissions.size).toBeGreaterThan(1);
  });

  it("declares a currency column for every money column", () => {
    for (const dataset of EXPORT_DATASETS) {
      const keys = new Set(dataset.columns.map((c) => c.key));
      for (const column of dataset.columns) {
        if (column.kind !== "money") continue;
        expect(column.currencyKey, `${dataset.key}.${column.key} has no currencyKey`).toBeTruthy();
        expect(keys).toContain(column.currencyKey!);
      }
    }
  });

  it("marks the personal columns, because the log records them", () => {
    const contacts = EXPORT_DATASETS.find((d) => d.key === "contacts");
    expect(contacts).toBeTruthy();
    const personal = contacts!.columns.filter((c) => c.personal).map((c) => c.label);
    expect(personal).toContain("Email");
    expect(personal).toContain("Mobile");
  });
});

describe("🔴 the log is written before the bytes are released", () => {
  const action = read("server/actions/export.ts");

  it("records the export before it returns the file", () => {
    /**
     * ⚠️ AN ORDER ASSERTION, NOT A PRESENCE ASSERTION. "Both calls are in
     * the function" would pass on the version that returns first and logs
     * afterwards, which is the version where a log failure leaves the
     * customer holding a file nothing recorded.
     */
    /**
     * ⭐ WAVE 9 — the call is now `recordExportAndNotify`, which is
     * `recordExport` plus the `export.bulk` / `export.off_hours` security
     * events. The wrapper exists so the security stream cannot be
     * forgotten by the NEXT export path: `recordExport` was already
     * mandatory (it throws, and the bytes are not released without it),
     * so hanging the events off it makes the two inseparable.
     */
    const recordAt = action.indexOf("await recordExportAndNotify({");
    const returnAt = action.indexOf("base64: Buffer.from(");
    expect(recordAt).toBeGreaterThan(0);
    expect(returnAt).toBeGreaterThan(0);
    expect(recordAt).toBeLessThan(returnAt);
  });

  it("records a refusal too", () => {
    expect(action).toContain('outcome: "refused"');
  });

  it("does not swallow a logging failure the way writeAudit does", () => {
    const log = read("server/export/log.ts");
    expect(log).toContain("ExportNotRecordedError");
    /** 🔴 `recordExport` THROWS. `writeAudit` deliberately never does. */
    expect(log).toMatch(/throw new ExportNotRecordedError/);
  });
});

describe("⚠️ data_exports is classified, so the inventory knows about it", () => {
  it("is in the DPDPA inventory", () => {
    const classification = read("lib/dpdp/classification.ts");
    expect(classification).toContain('table: "data_exports"');
    /**
     * ⭐ AND IT REACHES THE EXPORTER, NOT THE PEOPLE IN THE FILE. The
     * rows name whoever ran the export; `personal_columns` holds column
     * HEADINGS, so a Data Principal export must not return other people's
     * rows out of this table.
     */
    expect(classification).toContain('column: "exported_by", principal: "user"');
  });
});
