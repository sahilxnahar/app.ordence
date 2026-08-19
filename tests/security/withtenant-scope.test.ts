import { describe, it, expect } from "vitest";
import { asSuperuser, testPool } from "../setup";
import { randomUUID } from "node:crypto";

describe("withTenant pattern — the Phase 9 regression check", () => {
  it("set_config(is_local=true) INSIDE a transaction survives later queries", async () => {
    const t = randomUUID();
    const c = await testPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [t]);
      const r = await c.query("SELECT current_setting('app.current_tenant_id', true) AS v");
      expect(r.rows[0].v).toBe(t);
      await c.query("COMMIT");
      // And is gone afterwards, so a recycled connection carries nothing.
      const after = await c.query("SELECT current_setting('app.current_tenant_id', true) AS v");
      expect(after.rows[0].v).toBe("");
    } finally { c.release(); }
  });

  it("WITHOUT a transaction the setting is discarded — the original bug", async () => {
    const t = randomUUID();
    const c = await testPool.connect();
    try {
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [t]);
      const r = await c.query("SELECT current_setting('app.current_tenant_id', true) AS v");
      // This is what made every withTenant() read return zero rows.
      expect(r.rows[0].v).toBe("");
    } finally { c.release(); }
  });
});
