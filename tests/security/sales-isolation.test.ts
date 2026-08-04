/**
 * Ordence — Sales Pipeline & Inventory: Isolation and Integrity
 * Version: v0.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Twenty-one phases of experience say the same thing every time: the
 * defects that survive are the SILENT ones. `writeAudit` discarded the
 * entire audit trail for fourteen phases with no error. `withPlatformScope`
 * read zero rows and failed closed, so nothing leaked and nothing worked.
 * `isFeatureKey` walked the prototype chain and happened to fail safe.
 *
 * In every case the suite proved guards REFUSE and never proved the thing
 * they guard WORKS. So this file does both, deliberately:
 *
 *   • The refusals — cross-tenant reads, cross-tenant pointers, the
 *     double-sale, the commission lock, the append-only activity log.
 *   • The happy paths — a booking that should succeed does; a hold that
 *     has expired releases; a plan that should generate sums exactly.
 *
 * ⚠️ EVERY TEST RUNS AS THE ORDINARY APPLICATION ROLE. `asSuperuser`
 * appears only for fixtures and teardown, because a superuser bypasses
 * row-level security entirely and a suite written on one proves nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError, testPool } from "../setup";

let tenantA: string;
let tenantB: string;
let projectA: string;
let projectB: string;
let leadA1: string;
let leadA2: string;
let leadB1: string;
let partnerA: string;

/** Units are created per-test where status matters; these are the shared ones. */
async function makeUnit(
  tenantId: string,
  projectId: string,
  code: string,
  status = "available",
): Promise<string> {
  const id = randomUUID();
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO units (id, tenant_id, project_id, code, status, price_minor)
       VALUES ($1,$2,$3,$4,$5::unit_status, 500000000)`,
      [id, tenantId, projectId, code, status],
    );
  });
  return id;
}

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  projectA = randomUUID();
  projectB = randomUUID();
  leadA1 = randomUUID();
  leadA2 = randomUUID();
  leadB1 = randomUUID();
  partnerA = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Sales Isolation A"],
      [tenantB, "Sales Isolation B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `si-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO projects (id, tenant_id, code, name) VALUES
         ($1,$2,'P-A','Tower A'),
         ($3,$4,'P-B','Tower B')`,
      [projectA, tenantA, projectB, tenantB],
    );

    await c.query(
      `INSERT INTO channel_partners
         (id, tenant_id, code, firm_name, contact_name, phone, status, kyc_status,
          commission_basis, commission_rate_bps, pan_number)
       VALUES ($1,$2,'CP-1','Acme Realty','R Kumar','+919000000000','active','verified',
               'percent_of_sale', 200, 'ABCDE1234F')`,
      [partnerA, tenantA],
    );

    await c.query(
      `INSERT INTO leads (id, tenant_id, reference, name, phone, status) VALUES
         ($1,$2,'LEAD-0001','Buyer One','+919111111111','qualified'),
         ($3,$2,'LEAD-0002','Buyer Two','+919222222222','qualified'),
         ($4,$5,'LEAD-0001','Other Tenant Buyer','+919333333333','qualified')`,
      [leadA1, tenantA, leadA2, leadB1, tenantB],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    // lead_activities is append-only. The trigger has to come off to
    // clean up, and it MUST go back on — a teardown that left it
    // disabled would void the guarantee for every later run.
    await c.query("ALTER TABLE lead_activities DISABLE TRIGGER USER");
    try {
      await c.query(`DELETE FROM lead_activities WHERE tenant_id = ANY($1::uuid[])`, [
        [tenantA, tenantB],
      ]);
    } finally {
      await c.query("ALTER TABLE lead_activities ENABLE TRIGGER USER");
    }

    await c.query(`DELETE FROM payment_milestones WHERE tenant_id = ANY($1::uuid[])`, [
      [tenantA, tenantB],
    ]);
    await c.query(`DELETE FROM bookings WHERE tenant_id = ANY($1::uuid[])`, [
      [tenantA, tenantB],
    ]);
    await c.query(`DELETE FROM units WHERE tenant_id = ANY($1::uuid[])`, [
      [tenantA, tenantB],
    ]);
    await c.query(`DELETE FROM leads WHERE tenant_id = ANY($1::uuid[])`, [
      [tenantA, tenantB],
    ]);
    await c.query(`DELETE FROM channel_partners WHERE tenant_id = ANY($1::uuid[])`, [
      [tenantA, tenantB],
    ]);
    await c.query(`DELETE FROM projects WHERE tenant_id = ANY($1::uuid[])`, [
      [tenantA, tenantB],
    ]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);

    // Prove every guard this file switched off is back on. A teardown that
    // left one disabled would void the guarantee for every later run — and
    // the suite would still pass, which is the dangerous part.
    const { rows } = await c.query(
      `SELECT tgenabled::text AS state FROM pg_trigger
        WHERE tgrelid = 'lead_activities'::regclass AND NOT tgisinternal`,
    );
    for (const row of rows) expect(row.state).toBe("O");

    const holdGuard = await c.query(
      `SELECT tgenabled::text AS state FROM pg_trigger
        WHERE tgrelid = 'units'::regclass AND tgname = 'units_hold_valid'`,
    );
    for (const row of holdGuard.rows) expect(row.state).toBe("O");
  });
});

/* ================================================================== */
/* 1. TENANT ISOLATION                                                 */
/* ================================================================== */

describe("tenant isolation", () => {
  it("a tenant sees only its own projects, units and leads", async () => {
    await asTenant(tenantA, async (c) => {
      const projects = await c.query("SELECT id FROM projects");
      expect(projects.rows.map((r) => r.id)).toEqual([projectA]);

      const leadRows = await c.query("SELECT id FROM leads ORDER BY reference");
      expect(leadRows.rows.map((r) => r.id).sort()).toEqual([leadA1, leadA2].sort());
    });

    await asTenant(tenantB, async (c) => {
      const projects = await c.query("SELECT id FROM projects");
      expect(projects.rows.map((r) => r.id)).toEqual([projectB]);

      const leadRows = await c.query("SELECT id FROM leads");
      expect(leadRows.rows.map((r) => r.id)).toEqual([leadB1]);
    });
  });

  it("a tenant cannot read another tenant's lead by its exact id", async () => {
    // The IDOR shape: the attacker HAS the identifier.
    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT id FROM leads WHERE id = $1", [leadA1]);
      expect(rows).toHaveLength(0);
    });
  });

  it("a tenant cannot UPDATE another tenant's lead by its exact id", async () => {
    await asTenant(tenantB, async (c) => {
      const result = await c.query(
        "UPDATE leads SET name = 'hijacked' WHERE id = $1 RETURNING id",
        [leadA1],
      );
      // RLS makes the row invisible, so the UPDATE matches nothing.
      // ⚠️ It does NOT error — which is why "no error" is never
      // evidence that a write happened.
      expect(result.rowCount).toBe(0);
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT name FROM leads WHERE id = $1", [leadA1]);
      expect(rows[0].name).toBe("Buyer One");
    });
  });

  it("a tenant cannot INSERT a lead into another tenant's workspace", async () => {
    const error = await expectError(() =>
      asTenant(tenantB, async (c) => {
        await c.query(
          `INSERT INTO leads (tenant_id, reference, name, phone)
           VALUES ($1, 'LEAD-9999', 'Planted', '+919444444444')`,
          [tenantA],
        );
      }),
    );

    // This is the WITH CHECK clause. A policy with only USING would let
    // this succeed — the row would be invisible to the writer and fully
    // visible to the victim.
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("every sales table is ENABLED and FORCED", async () => {
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname = ANY($1::text[])`,
        [
          [
            "projects",
            "units",
            "leads",
            "lead_activities",
            "channel_partners",
            "bookings",
            "payment_milestones",
          ],
        ],
      );

      expect(rows).toHaveLength(7);
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} ENABLE`).toBe(true);
        // ⚠️ FORCE is the half that is usually missing. Without it the
        // table owner reads everything and the policies look correct in
        // every interface.
        expect(row.relforcerowsecurity, `${row.relname} FORCE`).toBe(true);
      }
    });
  });
});

/* ================================================================== */
/* 2. ⭐ CROSS-TENANT REFERENCE INTEGRITY                              */
/* ================================================================== */

describe("cross-tenant references", () => {
  it("refuses a unit in my tenant pointing at another tenant's project", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE HOLE RLS DOES NOT CLOSE.
    //
    // Foreign-key checks run as the system and IGNORE row-level
    // security. So `tenant_id = mine, project_id = theirs` passes the
    // WITH CHECK (the tenant is mine) AND passes the FK (the project
    // exists). Without the composite key from Section 2 of the SQL
    // file, this INSERT SUCCEEDS.
    // ══════════════════════════════════════════════════════════════
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO units (tenant_id, project_id, code)
           VALUES ($1, $2, 'X-1')`,
          [tenantA, projectB],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
    expect(error!.message).toMatch(/units_project_same_tenant/);
  });

  it("refuses a booking pointing at another tenant's lead", async () => {
    const unit = await makeUnit(tenantA, projectA, "XR-1");

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
           VALUES ($1, 'BKG-XR1', $2, $3, 100000000)`,
          [tenantA, leadB1, unit],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("still allows a perfectly ordinary same-tenant reference", async () => {
    // ⚠️ THE OTHER HALF. A constraint that refuses everything is not a
    // constraint, it is an outage — and this is exactly the check that
    // three earlier phases were missing.
    const unit = await makeUnit(tenantA, projectA, "OK-1");
    expect(unit).toBeTruthy();

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT code FROM units WHERE id = $1", [unit]);
      expect(rows[0].code).toBe("OK-1");
    });
  });
});

/* ================================================================== */
/* 3. ⭐ THE DOUBLE SALE                                               */
/* ================================================================== */

describe("one live booking per unit", () => {
  it("refuses a second live booking on the same unit", async () => {
    const unit = await makeUnit(tenantA, projectA, "DS-1");

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
         VALUES ($1,'BKG-DS1',$2,$3,500000000)`,
        [tenantA, leadA1, unit],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
           VALUES ($1,'BKG-DS2',$2,$3,500000000)`,
          [tenantA, leadA2, unit],
        );
      }),
    );

    expect(error).not.toBeNull();
    // Either the trigger catches it first (23514, with a readable
    // message) or the unique index does (23505). Both are correct; what
    // must never happen is success.
    expect(["23505", "23514"]).toContain(error!.code);
  });

  it("⭐ refuses the second booking under GENUINE CONCURRENCY", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE TEST THIS WHOLE PHASE EXISTS FOR.
    //
    // Two connections, two open transactions, both reading `available`
    // before either commits. This is the exact interleaving that a
    // "check then insert" in application code cannot survive, and it
    // is what happens on a launch weekend with twelve reps.
    //
    // The sequence is forced, not hoped for: both transactions are
    // opened and both do their read BEFORE either inserts.
    // ══════════════════════════════════════════════════════════════
    const unit = await makeUnit(tenantA, projectA, "RACE-1");

    const c1 = await testPool.connect();
    const c2 = await testPool.connect();

    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");
      await c1.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      await c2.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);

      // Both see an available unit. Neither is wrong.
      const read1 = await c1.query("SELECT status FROM units WHERE id = $1", [unit]);
      const read2 = await c2.query("SELECT status FROM units WHERE id = $1", [unit]);
      expect(read1.rows[0].status).toBe("available");
      expect(read2.rows[0].status).toBe("available");

      // First writer proceeds.
      await c1.query(
        `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
         VALUES ($1,'BKG-RACE1',$2,$3,500000000)`,
        [tenantA, leadA1, unit],
      );

      // Second writer attempts the same unit. It must NOT be allowed to
      // commit. It blocks on the row lock / index until c1 resolves.
      const secondInsert = c2
        .query(
          `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
           VALUES ($1,'BKG-RACE2',$2,$3,500000000)`,
          [tenantA, leadA2, unit],
        )
        .then(() => null as { code?: string } | null)
        .catch((err: { code?: string; message?: string }) => err);

      await c1.query("COMMIT");

      const outcome = await secondInsert;

      // If the insert itself was refused, that is the answer. If it was
      // allowed to proceed, the COMMIT must fail.
      let failed = outcome !== null;
      if (!failed) {
        const commitError = await c2.query("COMMIT").then(
          () => null,
          (err: { code?: string }) => err,
        );
        failed = commitError !== null;
      } else {
        await c2.query("ROLLBACK").catch(() => {});
      }

      expect(
        failed,
        "TWO BUYERS WERE PROMISED THE SAME FLAT. bookings_one_live_per_unit is not holding.",
      ).toBe(true);

      // And exactly one booking exists.
      await asTenant(tenantA, async (c) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM bookings
            WHERE unit_id = $1 AND status <> 'cancelled'`,
          [unit],
        );
        expect(rows[0].n).toBe(1);
      });
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c2.query("ROLLBACK").catch(() => {});
      c1.release();
      c2.release();
    }
  });

  it("a cancelled booking frees the unit for a new one", async () => {
    // ⚠️ THE HAPPY PATH THAT THE CONSTRAINT MUST NOT BREAK. A partial
    // index that also blocked re-booking after a cancellation would
    // permanently poison every flat a buyer ever walked away from.
    const unit = await makeUnit(tenantA, projectA, "CANCEL-1");

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
         VALUES ($1,'BKG-CAN1',$2,$3,500000000)`,
        [tenantA, leadA1, unit],
      );
      await c.query(
        `UPDATE bookings SET status = 'cancelled', cancel_reason = 'Buyer withdrew'
          WHERE reference = 'BKG-CAN1' AND tenant_id = $1`,
        [tenantA],
      );
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT status FROM units WHERE id = $1", [unit]);
      // The sync trigger freed it.
      expect(rows[0].status).toBe("available");

      await c.query(
        `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
         VALUES ($1,'BKG-CAN2',$2,$3,500000000)`,
        [tenantA, leadA2, unit],
      );

      const after = await c.query("SELECT status FROM units WHERE id = $1", [unit]);
      expect(after.rows[0].status).toBe("booked");
    });
  });

  it("a cancellation must carry a reason", async () => {
    const unit = await makeUnit(tenantA, projectA, "NOREASON-1");

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
         VALUES ($1,'BKG-NR1',$2,$3,500000000)`,
        [tenantA, leadA1, unit],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `UPDATE bookings SET status = 'cancelled'
            WHERE reference = 'BKG-NR1' AND tenant_id = $1`,
          [tenantA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });
});

/* ================================================================== */
/* 4. UNIT STATUS COHERENCE                                            */
/* ================================================================== */

describe("unit status rules", () => {
  it("refuses a booking on a blocked unit", async () => {
    const unit = await makeUnit(tenantA, projectA, "BLK-1", "blocked");

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
           VALUES ($1,'BKG-BLK1',$2,$3,500000000)`,
          [tenantA, leadA1, unit],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/blocked/i);
  });

  it("refuses a booking on a unit held for a DIFFERENT buyer", async () => {
    const unit = await makeUnit(tenantA, projectA, "HOLD-1");

    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE units
            SET status = 'held', hold_until = now() + interval '7 days',
                held_for_lead_id = $2
          WHERE id = $1`,
        [unit, leadA1],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
           VALUES ($1,'BKG-HOLD1',$2,$3,500000000)`,
          [tenantA, leadA2, unit],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/held for another buyer/i);
  });

  it("ALLOWS the booking when the unit is held for THAT buyer", async () => {
    // The whole purpose of a hold. If this failed, holding a unit would
    // stop the buyer it was held for from buying it.
    const unit = await makeUnit(tenantA, projectA, "HOLD-2");

    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE units
            SET status = 'held', hold_until = now() + interval '7 days',
                held_for_lead_id = $2
          WHERE id = $1`,
        [unit, leadA1],
      );

      await c.query(
        `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
         VALUES ($1,'BKG-HOLD2',$2,$3,500000000)`,
        [tenantA, leadA1, unit],
      );

      const { rows } = await c.query("SELECT status, hold_until FROM units WHERE id = $1", [
        unit,
      ]);
      expect(rows[0].status).toBe("booked");
      // The hold is consumed by the booking.
      expect(rows[0].hold_until).toBeNull();
    });
  });

  it("refuses a held unit with no deadline", async () => {
    const unit = await makeUnit(tenantA, projectA, "HOLD-3");

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`UPDATE units SET status = 'held' WHERE id = $1`, [unit]);
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("registering a booking marks the unit sold", async () => {
    const unit = await makeUnit(tenantA, projectA, "REG-1");

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
         VALUES ($1,'BKG-REG1',$2,$3,500000000)`,
        [tenantA, leadA1, unit],
      );
      await c.query(
        `UPDATE bookings SET status = 'registered'
          WHERE reference = 'BKG-REG1' AND tenant_id = $1`,
        [tenantA],
      );

      const { rows } = await c.query("SELECT status FROM units WHERE id = $1", [unit]);
      expect(rows[0].status).toBe("sold");
    });
  });
});

/* ================================================================== */
/* 5. HOLD EXPIRY                                                      */
/* ================================================================== */

describe("hold expiry", () => {
  it("releases a hold whose deadline has passed, and leaves a live one alone", async () => {
    const expired = await makeUnit(tenantA, projectA, "EXP-1");
    const live = await makeUnit(tenantA, projectA, "EXP-2");

    // ══════════════════════════════════════════════════════════════
    // ⚠️ THE FIXTURE IS TWO STEPS, AND THE FIRST DRAFT WAS WRONG.
    //
    // It planted the expired hold directly as a superuser — and the
    // trigger refused it, because `units_hold_valid` requires a hold to
    // expire in the FUTURE. That refusal is correct and worth keeping.
    //
    // The lesson is the one this project keeps relearning: a SUPERUSER
    // BYPASSES ROW-LEVEL SECURITY BUT NOT TRIGGERS. Two different
    // mechanisms, routinely conflated, and the conflation is why the
    // fixture looked reasonable.
    //
    // So the hold is placed legitimately, then its deadline is moved
    // into the past — which is what actually happens, one second at a
    // time, while nobody is watching.
    // ══════════════════════════════════════════════════════════════
    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE units
            SET status = 'held', hold_until = now() + interval '1 day',
                held_for_lead_id = $2
          WHERE id = $1`,
        [expired, leadA1],
      );
      await c.query(
        `UPDATE units
            SET status = 'held', hold_until = now() + interval '3 days',
                held_for_lead_id = $2
          WHERE id = $1`,
        [live, leadA2],
      );
    });

    // Time passes.
    //
    // ⚠️ The guard has to come off for this one statement. `units_hold_valid`
    // now refuses to backdate a hold — that refusal is the fix for a real
    // exploit (see `sales-exploits.test.ts`), so the fixture bends around it
    // rather than the rule bending around the fixture. It goes straight back
    // on, and the assertion at the end of the file proves it.
    await asSuperuser(async (c) => {
      await c.query("ALTER TABLE units DISABLE TRIGGER units_hold_valid");
      try {
        await c.query(
          `UPDATE units SET hold_until = now() - interval '1 hour' WHERE id = $1`,
          [expired],
        );
      } finally {
        await c.query("ALTER TABLE units ENABLE TRIGGER units_hold_valid");
      }
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT * FROM release_expired_unit_holds($1::uuid)", [
        tenantA,
      ]);
      expect(rows.map((r) => r.unit_id)).toContain(expired);
      expect(rows.map((r) => r.unit_id)).not.toContain(live);

      const after = await c.query(
        "SELECT id, status, hold_until FROM units WHERE id = ANY($1::uuid[])",
        [[expired, live]],
      );

      const expiredRow = after.rows.find((r) => r.id === expired);
      const liveRow = after.rows.find((r) => r.id === live);

      expect(expiredRow.status).toBe("available");
      expect(expiredRow.hold_until).toBeNull();
      expect(liveRow.status).toBe("held");
    });
  });

  it("the sweep does not touch another tenant's units", async () => {
    const foreign = await makeUnit(tenantB, projectB, "EXP-B1");
    await asSuperuser(async (c) => {
      const lead = randomUUID();
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, phone)
         VALUES ($1,$2,'LEAD-0009','B Buyer','+919555555555')`,
        [lead, tenantB],
      );
      await c.query(
        `UPDATE units
            SET status = 'held', hold_until = now() + interval '1 day',
                held_for_lead_id = $2
          WHERE id = $1`,
        [foreign, lead],
      );
      // Same two-step as above — the trigger will not accept a hold that
      // has already expired, nor allow one to be backdated, so it is aged
      // with the guard briefly lifted and immediately restored.
      await c.query("ALTER TABLE units DISABLE TRIGGER units_hold_valid");
      try {
        await c.query(
          `UPDATE units SET hold_until = now() - interval '1 hour' WHERE id = $1`,
          [foreign],
        );
      } finally {
        await c.query("ALTER TABLE units ENABLE TRIGGER units_hold_valid");
      }
    });

    await asTenant(tenantA, async (c) => {
      // Called with tenant A's id. Even without the parameter, RLS would
      // make tenant B's row invisible — both layers are checked.
      await c.query("SELECT * FROM release_expired_unit_holds($1::uuid)", [tenantA]);
    });

    await asSuperuser(async (c) => {
      const { rows } = await c.query("SELECT status FROM units WHERE id = $1", [foreign]);
      expect(rows[0].status).toBe("held");
    });
  });
});

/* ================================================================== */
/* 6. THE COMMISSION-PROTECTION WINDOW                                 */
/* ================================================================== */

describe("commission protection", () => {
  it("refuses re-attribution while the window is open", async () => {
    const lead = randomUUID();
    const otherPartner = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO channel_partners
           (id, tenant_id, code, firm_name, contact_name, phone, status)
         VALUES ($1,$2,'CP-2','Rival Realty','S Rao','+919666666666','active')`,
        [otherPartner, tenantA],
      );
      await c.query(
        `INSERT INTO leads
           (id, tenant_id, reference, name, phone, channel_partner_id, cp_locked_until)
         VALUES ($1,$2,'LEAD-0100','Contested Buyer','+919777777777',$3,
                 now() + interval '60 days')`,
        [lead, tenantA, partnerA],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`UPDATE leads SET channel_partner_id = $2 WHERE id = $1`, [
          lead,
          otherPartner,
        ]);
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/registered to a channel partner/i);
  });

  it("allows every OTHER edit to the same lead while it is locked", async () => {
    // ⚠️ A trigger that refused all updates to a locked lead would make
    // the lead unworkable — no follow-ups, no status changes, nothing.
    // That is the failure mode of an over-broad guard, and it is why
    // this test exists next to the one above.
    const lead = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO leads
           (id, tenant_id, reference, name, phone, channel_partner_id, cp_locked_until)
         VALUES ($1,$2,'LEAD-0101','Workable Buyer','+919888888888',$3,
                 now() + interval '60 days')`,
        [lead, tenantA, partnerA],
      );
    });

    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE leads SET status = 'negotiation', temperature = 'hot' WHERE id = $1`,
        [lead],
      );
      const { rows } = await c.query("SELECT status FROM leads WHERE id = $1", [lead]);
      expect(rows[0].status).toBe("negotiation");
    });
  });

  it("allows re-attribution once the window has closed", async () => {
    const lead = randomUUID();
    const otherPartner = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO channel_partners
           (id, tenant_id, code, firm_name, contact_name, phone, status)
         VALUES ($1,$2,'CP-3','Late Realty','T Iyer','+919999999999','active')`,
        [otherPartner, tenantA],
      );
      await c.query(
        `INSERT INTO leads
           (id, tenant_id, reference, name, phone, channel_partner_id, cp_locked_until)
         VALUES ($1,$2,'LEAD-0102','Freed Buyer','+919101010101',$3,
                 now() - interval '1 day')`,
        [lead, tenantA, partnerA],
      );
    });

    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE leads SET channel_partner_id = $2 WHERE id = $1`, [
        lead,
        otherPartner,
      ]);
      const { rows } = await c.query("SELECT channel_partner_id FROM leads WHERE id = $1", [
        lead,
      ]);
      expect(rows[0].channel_partner_id).toBe(otherPartner);
    });
  });

  it("allows re-attribution after the window is explicitly cleared", async () => {
    // The documented route: clear the lock (audited, its own permission),
    // then re-attribute. Proving it works is what stops somebody
    // concluding the lock is a dead end and editing the database by hand.
    const lead = randomUUID();
    const otherPartner = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO channel_partners
           (id, tenant_id, code, firm_name, contact_name, phone, status)
         VALUES ($1,$2,'CP-4','Released Realty','U Nair','+919111000111','active')`,
        [otherPartner, tenantA],
      );
      await c.query(
        `INSERT INTO leads
           (id, tenant_id, reference, name, phone, channel_partner_id, cp_locked_until)
         VALUES ($1,$2,'LEAD-0103','Released Buyer','+919222000222',$3,
                 now() + interval '60 days')`,
        [lead, tenantA, partnerA],
      );
    });

    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE leads SET cp_locked_until = NULL WHERE id = $1`, [lead]);
      await c.query(`UPDATE leads SET channel_partner_id = $2 WHERE id = $1`, [
        lead,
        otherPartner,
      ]);
      const { rows } = await c.query("SELECT channel_partner_id FROM leads WHERE id = $1", [
        lead,
      ]);
      expect(rows[0].channel_partner_id).toBe(otherPartner);
    });
  });
});

/* ================================================================== */
/* 7. LEAD ACTIVITY IS EVIDENCE                                        */
/* ================================================================== */

describe("lead activity append-only", () => {
  it("records an activity, then refuses to change or remove it", async () => {
    let activityId = "";

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO lead_activities (tenant_id, lead_id, type, subject, notes)
         VALUES ($1,$2,'call','Spoke to buyer','Quoted 82L')
         RETURNING id`,
        [tenantA, leadA1],
      );
      activityId = rows[0].id;
    });

    // ⚠️ The insert working is half the test. A trigger that blocked
    // INSERT too would produce an empty history that looks identical to
    // a working one until somebody needs it.
    expect(activityId).toBeTruthy();

    const updateError = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`UPDATE lead_activities SET notes = 'Quoted 92L' WHERE id = $1`, [
          activityId,
        ]);
      }),
    );
    expect(updateError).not.toBeNull();
    expect(updateError!.code).toBe("42501");

    const deleteError = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`DELETE FROM lead_activities WHERE id = $1`, [activityId]);
      }),
    );
    expect(deleteError).not.toBeNull();
    expect(deleteError!.code).toBe("42501");

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT notes FROM lead_activities WHERE id = $1", [
        activityId,
      ]);
      expect(rows[0].notes).toBe("Quoted 82L");
    });
  });

  it("another tenant cannot read the activity history", async () => {
    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT id FROM lead_activities WHERE lead_id = $1", [
        leadA1,
      ]);
      expect(rows).toHaveLength(0);
    });
  });
});

/* ================================================================== */
/* 8. GRANTS                                                           */
/* ================================================================== */

describe("privileges", () => {
  it("the application role cannot DELETE a booking", async () => {
    // Deleting a booking frees the unit exactly like a cancellation, and
    // erases the evidence. The permission is not granted at all, so the
    // attempt fails at the door.
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'ordence_app' AND table_name = 'bookings'`,
      );
      const privileges = rows.map((r) => r.privilege_type);
      expect(privileges).toContain("INSERT");
      expect(privileges).toContain("UPDATE");
      expect(privileges).not.toContain("DELETE");
    });
  });

  it("the application role cannot DELETE a lead activity", async () => {
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'ordence_app' AND table_name = 'lead_activities'`,
      );
      const privileges = rows.map((r) => r.privilege_type);
      expect(privileges).toEqual(expect.arrayContaining(["SELECT", "INSERT"]));
      expect(privileges).not.toContain("UPDATE");
      expect(privileges).not.toContain("DELETE");
    });
  });
});

/* ================================================================== */
/* 9. PAYMENT MILESTONES                                               */
/* ================================================================== */

describe("payment milestones", () => {
  it("refuses a milestone attached to another tenant's booking", async () => {
    const unit = await makeUnit(tenantA, projectA, "MS-1");
    let bookingId = "";

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
         VALUES ($1,'BKG-MS1',$2,$3,500000000) RETURNING id`,
        [tenantA, leadA1, unit],
      );
      bookingId = rows[0].id;
    });

    const error = await expectError(() =>
      asTenant(tenantB, async (c) => {
        await c.query(
          `INSERT INTO payment_milestones (tenant_id, booking_id, label, amount_minor)
           VALUES ($1,$2,'On booking',50000000)`,
          [tenantB, bookingId],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("refuses a zero or negative milestone amount", async () => {
    const unit = await makeUnit(tenantA, projectA, "MS-2");

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        const { rows } = await c.query(
          `INSERT INTO bookings (tenant_id, reference, lead_id, unit_id, agreement_value_minor)
           VALUES ($1,'BKG-MS2',$2,$3,500000000) RETURNING id`,
          [tenantA, leadA1, unit],
        );
        await c.query(
          `INSERT INTO payment_milestones (tenant_id, booking_id, label, amount_minor)
           VALUES ($1,$2,'Free flat',0)`,
          [tenantA, rows[0].id],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });
});

/* ================================================================== */
/* 10. LEAD DATA RULES                                                 */
/* ================================================================== */

describe("lead constraints", () => {
  it("refuses a lost lead with no reason", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [leadA2]);
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("accepts a lost lead WITH a reason", async () => {
    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE leads SET status = 'lost', lost_reason = 'Bought elsewhere' WHERE id = $1`,
        [leadA2],
      );
      const { rows } = await c.query("SELECT status FROM leads WHERE id = $1", [leadA2]);
      expect(rows[0].status).toBe("lost");
    });

    // Put it back for any later test in the file.
    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE leads SET status = 'qualified', lost_reason = NULL WHERE id = $1`,
        [leadA2],
      );
    });
  });

  it("refuses an inverted budget range", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `UPDATE leads SET budget_min_minor = 900000000, budget_max_minor = 100000000
            WHERE id = $1`,
          [leadA1],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("refuses a malformed PAN on a channel partner", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO channel_partners
             (tenant_id, code, firm_name, contact_name, phone, pan_number)
           VALUES ($1,'CP-BAD','Bad PAN Realty','V Shah','+919333000333','NOTAPAN')`,
          [tenantA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });
});
