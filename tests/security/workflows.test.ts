/**
 * Ordence — Workflow Engine: Isolation, Loops and the Happy Path
 * Version: v0.23.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Twenty-two phases say the same thing every time: the defects that
 * survive are the SILENT ones. `writeAudit` discarded the audit trail for
 * fourteen phases with no error. `withPlatformScope` read zero rows and
 * failed closed, so nothing leaked and nothing worked.
 *
 * This phase has a new way to be silent, and it is worse than the others:
 * a loop guard that EXISTS, is ENABLED, and does nothing. It passes every
 * "is the trigger installed?" check. The first sign that it was
 * decorative is a customer's automation consuming the instance.
 *
 * So the loop tests below do not inspect the guard. They build a real
 * chain of runs and try to close the circle:
 *
 *   • depth supplied by the caller must be IGNORED and recomputed;
 *   • a version already in the chain must be REFUSED;
 *   • a chain longer than the limit must be REFUSED;
 *   • and an honest two-workflow chain must still WORK, because a guard
 *     that refuses everything is an outage, not a guard.
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears only for fixtures and teardown, because a
 * superuser bypasses row-level security entirely and a suite written on
 * one proves nothing.
 *
 * The second half of the file tests the PURE planner with no database at
 * all — which is the entire reason the planner is pure.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError, testPool } from "../setup";

import { planNext, initialCursor, type PlanState } from "@/lib/workflows/planner";
import { decideTrigger, type TriggerCandidate, type TriggerEvent } from "@/lib/workflows/triggers";
import { validateDefinition } from "@/lib/workflows/validation";
import { checkOutboundUrl, isPrivateAddressLiteral } from "@/lib/workflows/http-policy";
import { nextCronFireAt, parseCron } from "@/lib/workflows/cron";
import { readPath, interpolate, evaluateGroup } from "@/lib/workflows/bindings";
import { partitionWritableColumns, permissionForRecordAction } from "@/lib/workflows/records";
import {
  MAX_ITERATIONS_PER_LOOP,
  MAX_TRIGGER_DEPTH,
} from "@/lib/workflows/limits";
import type { RunContext, WorkflowProgram } from "@/lib/workflows/program";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;
let workflowA: string;
let versionA: string;
let workflowA2: string;
let versionA2: string;
let workflowB: string;
let versionB: string;

async function makeWorkflow(
  tenantId: string,
  userId: string,
  key: string,
  status: "draft" | "active" = "active",
): Promise<{ workflowId: string; versionId: string }> {
  const workflowId = randomUUID();
  const versionId = randomUUID();

  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO workflows (id, tenant_id, key, name, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [workflowId, tenantId, key, `Workflow ${key}`, userId],
    );
    await c.query(
      `INSERT INTO workflow_versions
         (id, tenant_id, workflow_id, version, status, trigger_type, trigger_config,
          steps, published_at, published_by, run_as_user_id)
       VALUES ($1,$2,$3,1,$4::workflow_version_status,'record_updated',
               '{"recordType":"lead","watchFields":["status"]}'::jsonb,
               '[]'::jsonb,
               CASE WHEN $4 = 'active' THEN now() ELSE NULL END,
               CASE WHEN $4 = 'active' THEN $5::uuid ELSE NULL END,
               CASE WHEN $4 = 'active' THEN $5::uuid ELSE NULL END)`,
      [versionId, tenantId, workflowId, status, userId],
    );
  });

  return { workflowId, versionId };
}

/** Insert a run as the ordinary app role. Returns the row the DB produced. */
async function insertRun(
  tenantId: string,
  args: {
    workflowId: string;
    versionId: string;
    actorUserId: string;
    parentRunId?: string | null;
    /** Supplied on purpose in the tests that prove it is ignored. */
    depth?: number;
  },
): Promise<{ id: string; depth: number; origin_chain: string[]; root_run_id: string }> {
  return asTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO workflow_runs
         (tenant_id, workflow_id, version_id, trigger_type, actor_user_id, actor_role,
          parent_run_id, depth)
       VALUES ($1,$2,$3,'record_updated',$4,'tenant_admin',$5,$6)
       RETURNING id, depth, origin_chain, root_run_id`,
      [
        tenantId,
        args.workflowId,
        args.versionId,
        args.actorUserId,
        args.parentRunId ?? null,
        args.depth ?? 0,
      ],
    );
    return rows[0];
  });
}

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA = randomUUID();
  userB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Workflow Isolation A"],
      [tenantB, "Workflow Isolation B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `wf-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status) VALUES
         ($1,$2,$3,'a@example.test','tenant_admin','active'),
         ($4,$5,$6,'b@example.test','tenant_admin','active')`,
      [userA, tenantA, `usr_${userA}`, userB, tenantB, `usr_${userB}`],
    );
  });

  ({ workflowId: workflowA, versionId: versionA } = await makeWorkflow(tenantA, userA, "a1"));
  ({ workflowId: workflowA2, versionId: versionA2 } = await makeWorkflow(tenantA, userA, "a2"));
  ({ workflowId: workflowB, versionId: versionB } = await makeWorkflow(tenantB, userB, "b1"));
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantA, tenantB];

    // ⚠️ Order matters, and it is the schema telling us something. The
    // foreign keys from runs to workflows and to users are RESTRICT — run
    // history outlives what produced it — so a teardown that deleted
    // workflows first would be refused. That refusal is the guarantee.
    await c.query(`DELETE FROM workflow_run_steps WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM workflow_tasks WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM workflow_runs WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM workflow_versions WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM workflows WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM leads WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);

    // Prove every guard is still enabled. A teardown that disabled one
    // would void the guarantee for every later run — and the suite would
    // still pass, which is the dangerous part.
    const { rows } = await c.query(
      `SELECT tgname, tgenabled::text AS state FROM pg_trigger
        WHERE tgrelid = 'workflow_runs'::regclass AND NOT tgisinternal`,
    );
    for (const row of rows) expect(row.state, row.tgname).toBe("O");
  });
});

/* ================================================================== */
/* 1. TENANT ISOLATION                                                 */
/* ================================================================== */

describe("tenant isolation", () => {
  it("a tenant sees only its own workflows", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT id FROM workflows ORDER BY key");
      expect(rows.map((r) => r.id).sort()).toEqual([workflowA, workflowA2].sort());
    });

    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT id FROM workflows");
      expect(rows.map((r) => r.id)).toEqual([workflowB]);
    });
  });

  it("a tenant cannot read another tenant's definition by its exact id", async () => {
    // The IDOR shape: the attacker HAS the identifier. A workflow
    // definition is a map of how a company runs.
    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT steps FROM workflow_versions WHERE id = $1", [
        versionA,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it("a tenant cannot plant a workflow in another tenant's workspace", async () => {
    const error = await expectError(() =>
      asTenant(tenantB, async (c) => {
        await c.query(
          `INSERT INTO workflows (tenant_id, key, name) VALUES ($1,'planted','Planted')`,
          [tenantA],
        );
      }),
    );

    // The WITH CHECK clause. With only USING, this would succeed — the row
    // would be invisible to the writer and fully live for the victim,
    // which for a workflow means somebody else's program running in your
    // workspace.
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("a tenant cannot read another tenant's run history", async () => {
    const run = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });

    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT id FROM workflow_runs WHERE id = $1", [run.id]);
      expect(rows).toHaveLength(0);
    });
  });

  it("every workflow table is ENABLED and FORCED", async () => {
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class WHERE relname = ANY($1::text[])`,
        [
          [
            "workflows",
            "workflow_versions",
            "workflow_runs",
            "workflow_run_steps",
            "workflow_tasks",
          ],
        ],
      );

      expect(rows).toHaveLength(5);
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
  it("⭐ refuses a run in my tenant that points at another tenant's PROGRAM", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE WORST VERSION OF THE FK/RLS HOLE ANYWHERE IN THIS CODEBASE.
    //
    // Foreign-key checks run as the system and ignore row-level
    // security. So `tenant_id = mine, version_id = theirs` passes the
    // WITH CHECK (the tenant is mine) AND passes a single-column FK (the
    // version exists). Without the composite key, this run would execute
    // TENANT B'S PROGRAM against tenant A's data, as one of tenant A's
    // users, with every step authorised correctly.
    // ══════════════════════════════════════════════════════════════
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO workflow_runs
             (tenant_id, workflow_id, version_id, trigger_type, actor_user_id, actor_role)
           VALUES ($1,$2,$3,'manual',$4,'tenant_admin')`,
          [tenantA, workflowA, versionB, userA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("refuses a run acting as another tenant's user", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO workflow_runs
             (tenant_id, workflow_id, version_id, trigger_type, actor_user_id, actor_role)
           VALUES ($1,$2,$3,'manual',$4,'tenant_admin')`,
          [tenantA, workflowA, versionA, userB],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("refuses a version attached to another tenant's workflow", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO workflow_versions
             (tenant_id, workflow_id, version, trigger_type)
           VALUES ($1,$2,99,'manual')`,
          [tenantA, workflowB],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("still allows a perfectly ordinary same-tenant run", async () => {
    // ⚠️ THE OTHER HALF. A constraint that refuses everything is not a
    // constraint, it is an outage — and this is exactly the check three
    // earlier phases were missing.
    const run = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });
    expect(run.id).toBeTruthy();
    expect(run.depth).toBe(0);
  });
});

/* ================================================================== */
/* 3. ⭐⭐ THE RUNAWAY-LOOP GUARD                                       */
/* ================================================================== */

describe("⭐ runaway execution", () => {
  it("IGNORES a caller-supplied depth and recomputes it from the parent", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE TEST THIS WHOLE PHASE EXISTS FOR.
    //
    // An engine that accepted `depth` from its caller has a loop guard
    // that any caller can switch off — and the caller that switches it
    // off is far more likely to be a well-meaning import script or a bug
    // in the planner than an attacker.
    //
    // Here the caller lies twice: it claims depth 4 on a root run, and
    // then claims depth 0 on its child. Both are ignored.
    // ══════════════════════════════════════════════════════════════
    const root = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
      depth: 4,
    });

    expect(root.depth, "the caller's depth was TRUSTED").toBe(0);
    expect(root.root_run_id).toBe(root.id);
    expect(root.origin_chain).toEqual([versionA]);

    const child = await insertRun(tenantA, {
      workflowId: workflowA2,
      versionId: versionA2,
      actorUserId: userA,
      parentRunId: root.id,
      depth: 0,
    });

    expect(child.depth).toBe(1);
    expect(child.root_run_id).toBe(root.id);
    expect(child.origin_chain).toEqual([versionA, versionA2]);
  });

  it("⭐ refuses a workflow that appears twice in one causal chain", async () => {
    // A updates a lead → B fires and updates the lead → A fires again.
    // Neither workflow triggers itself; the pair never stops.
    const root = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });

    const child = await insertRun(tenantA, {
      workflowId: workflowA2,
      versionId: versionA2,
      actorUserId: userA,
      parentRunId: root.id,
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO workflow_runs
             (tenant_id, workflow_id, version_id, trigger_type, actor_user_id, actor_role,
              parent_run_id)
           VALUES ($1,$2,$3,'record_updated',$4,'tenant_admin',$5)`,
          // versionA again — closing the circle.
          [tenantA, workflowA, versionA, userA, child.id],
        );
      }),
    );

    expect(
      error,
      "A WORKFLOW WAS ALLOWED TO RE-ENTER ITS OWN CHAIN. One customer's " +
        "automation can now consume the whole instance.",
    ).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/already ran earlier in the chain/i);
  });

  it("⭐ refuses a chain longer than the depth limit", async () => {
    // Distinct workflows all the way down, so cycle detection never
    // fires. Only the depth counter can stop this one.
    const made: { workflowId: string; versionId: string }[] = [];
    for (let i = 0; i <= MAX_TRIGGER_DEPTH + 1; i += 1) {
      made.push(await makeWorkflow(tenantA, userA, `chain${i}`));
    }

    let parent: string | null = null;
    let depth = -1;

    for (let i = 0; i <= MAX_TRIGGER_DEPTH; i += 1) {
      const run: { id: string; depth: number } = await insertRun(tenantA, {
        workflowId: made[i]!.workflowId,
        versionId: made[i]!.versionId,
        actorUserId: userA,
        parentRunId: parent,
      });
      parent = run.id;
      depth = run.depth;
    }

    expect(depth).toBe(MAX_TRIGGER_DEPTH);

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO workflow_runs
             (tenant_id, workflow_id, version_id, trigger_type, actor_user_id, actor_role,
              parent_run_id)
           VALUES ($1,$2,$3,'record_updated',$4,'tenant_admin',$5)`,
          [
            tenantA,
            made[MAX_TRIGGER_DEPTH + 1]!.workflowId,
            made[MAX_TRIGGER_DEPTH + 1]!.versionId,
            userA,
            parent,
          ],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/chained 5 deep/i);
  });

  it("⭐ STILL ALLOWS an honest two-workflow chain", async () => {
    // ⚠️ The half that stops the guard being an outage. "When a booking
    // is registered, mark the lead won" then "when a lead is won, notify
    // the manager" is two levels deep and is exactly what people buy this
    // feature for.
    const first = await makeWorkflow(tenantA, userA, "honest1");
    const second = await makeWorkflow(tenantA, userA, "honest2");

    const root = await insertRun(tenantA, {
      workflowId: first.workflowId,
      versionId: first.versionId,
      actorUserId: userA,
    });
    const child = await insertRun(tenantA, {
      workflowId: second.workflowId,
      versionId: second.versionId,
      actorUserId: userA,
      parentRunId: root.id,
    });

    expect(child.depth).toBe(1);
    expect(child.origin_chain).toEqual([first.versionId, second.versionId]);
  });

  it("⭐ refuses to rewrite a run's chain position or actor after the fact", async () => {
    // ══════════════════════════════════════════════════════════════
    // Without this the INSERT guard is a formality: create a run at
    // depth 5, UPDATE it back to depth 0, and use it as the parent of
    // the next one. The chain restarts and the loop never ends.
    //
    // The actor is in the same block for a different reason: a run that
    // could change who it is acting as, mid-flight, is a
    // privilege-escalation primitive with a queue in front of it.
    // ══════════════════════════════════════════════════════════════
    const root = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });
    const child = await insertRun(tenantA, {
      workflowId: workflowA2,
      versionId: versionA2,
      actorUserId: userA,
      parentRunId: root.id,
    });
    expect(child.depth).toBe(1);

    for (const [what, statement] of [
      ["depth", `UPDATE workflow_runs SET depth = 0 WHERE id = $1`],
      ["chain", `UPDATE workflow_runs SET origin_chain = ARRAY[]::uuid[] WHERE id = $1`],
      ["parent", `UPDATE workflow_runs SET parent_run_id = NULL WHERE id = $1`],
      ["version", `UPDATE workflow_runs SET version_id = '${versionA}' WHERE id = $1`],
    ] as const) {
      const error = await expectError(() =>
        asTenant(tenantA, async (c) => {
          await c.query(statement, [child.id]);
        }),
      );
      expect(error, `${what} was rewritable — the loop guard can be reset`).not.toBeNull();
      expect(error!.code).toBe("42501");
    }

    const actorError = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`UPDATE workflow_runs SET actor_user_id = $2 WHERE id = $1`, [
          child.id,
          userB,
        ]);
      }),
    );
    expect(actorError).not.toBeNull();

    // ⚠️ THE OTHER HALF. The guard compares VALUES rather than refusing
    // every UPDATE — a run that could not be advanced at all would be a
    // guard that stops the engine working.
    const ordinary = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `UPDATE workflow_runs SET status = 'running', steps_executed = 3 WHERE id = $1`,
          [child.id],
        );
      }),
    );
    expect(ordinary).toBeNull();
  });

  it("a finished run cannot be reopened or rewritten", async () => {
    const run = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });

    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE workflow_runs SET status = 'succeeded', finished_at = now() WHERE id = $1`,
        [run.id],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`UPDATE workflow_runs SET status = 'queued' WHERE id = $1`, [run.id]);
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toMatch(/cannot be changed/i);
  });
});

/* ================================================================== */
/* 4. VERSIONS                                                         */
/* ================================================================== */

describe("versioning", () => {
  it("⭐ an active version cannot be edited", async () => {
    // A run may be suspended part-way through it right now, holding a
    // POSITION in this step list. Change the steps underneath and that
    // position means something else.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `UPDATE workflow_versions SET steps = '[{"key":"x","action":"filter"}]'::jsonb
            WHERE id = $1`,
          [versionA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toMatch(/cannot be edited/i);
  });

  it("a draft CAN be edited", async () => {
    const draft = await makeWorkflow(tenantA, userA, "draftable", "draft");

    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE workflow_versions SET steps = '[{"key":"a","action":"filter"}]'::jsonb
          WHERE id = $1`,
        [draft.versionId],
      );
      const { rows } = await c.query("SELECT steps FROM workflow_versions WHERE id = $1", [
        draft.versionId,
      ]);
      expect(rows[0].steps).toHaveLength(1);
    });
  });

  it("an active version can only move to archived, never back to draft", async () => {
    const target = await makeWorkflow(tenantA, userA, "lifecycle");

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `UPDATE workflow_versions SET status = 'draft' WHERE id = $1`,
          [target.versionId],
        );
      }),
    );
    expect(error).not.toBeNull();

    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE workflow_versions SET status = 'archived' WHERE id = $1`, [
        target.versionId,
      ]);
      const { rows } = await c.query("SELECT status FROM workflow_versions WHERE id = $1", [
        target.versionId,
      ]);
      expect(rows[0].status).toBe("archived");
    });
  });

  it("⭐ a workflow cannot have two active versions", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO workflow_versions
             (tenant_id, workflow_id, version, status, trigger_type, published_at,
              run_as_user_id)
           VALUES ($1,$2,2,'active','manual',now(),$3)`,
          [tenantA, workflowA, userA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });

  it("an active version must name the identity it runs as", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO workflow_versions
             (tenant_id, workflow_id, version, status, trigger_type, published_at)
           VALUES ($1,$2,7,'active','scheduled',now())`,
          [tenantA, workflowA2],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/active_is_published/);
  });
});

/* ================================================================== */
/* 5. ARCHIVING WITH RUNS IN FLIGHT                                    */
/* ================================================================== */

describe("archiving", () => {
  it("archiving switches the workflow off and clears its schedule", async () => {
    const target = await makeWorkflow(tenantA, userA, "archivable");

    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE workflows SET next_run_at = now() + interval '1 day' WHERE id = $1`,
        [target.workflowId],
      );
      await c.query(`UPDATE workflows SET archived_at = now() WHERE id = $1`, [
        target.workflowId,
      ]);

      const { rows } = await c.query(
        "SELECT is_enabled, next_run_at FROM workflows WHERE id = $1",
        [target.workflowId],
      );
      // ⚠️ An archived workflow whose `is_enabled` stayed true is one bug
      // in a dispatcher query away from running again.
      expect(rows[0].is_enabled).toBe(false);
      expect(rows[0].next_run_at).toBeNull();
    });
  });

  it("⭐ a workflow with run history cannot be deleted, only archived", async () => {
    const target = await makeWorkflow(tenantA, userA, "hasruns");
    await insertRun(tenantA, {
      workflowId: target.workflowId,
      versionId: target.versionId,
      actorUserId: userA,
    });

    // Even as a SUPERUSER — which bypasses RLS and the missing grant —
    // the trigger refuses. That is the point: the history of what an
    // automation did to customer data outlives the automation.
    const error = await expectError(() =>
      asSuperuser(async (c) => {
        await c.query(`DELETE FROM workflows WHERE id = $1`, [target.workflowId]);
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/Archive it instead/i);
  });

  it("the application role has no DELETE on any workflow table", async () => {
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'ordence_app'
            AND table_name IN ('workflows','workflow_versions','workflow_runs',
                               'workflow_run_steps','workflow_tasks')`,
      );
      const deletes = rows.filter((r) => r.privilege_type === "DELETE");
      expect(
        deletes,
        "an automation's history can be erased — including by an automation",
      ).toHaveLength(0);

      const selects = rows.filter((r) => r.privilege_type === "SELECT");
      // The inverse check: the app must actually be able to work.
      expect(selects.length).toBe(5);
    });
  });
});

/* ================================================================== */
/* 6. APPROVAL TASKS                                                   */
/* ================================================================== */

describe("approval tasks", () => {
  it("⭐ a request cannot be answered twice", async () => {
    // Two clicks on "Approve" — a double-tap, a retried request — would
    // otherwise resume the run twice from the same cursor, and everything
    // after the approval happens twice. What follows an approval is
    // usually the irreversible part.
    const run = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });

    let taskId = "";
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO workflow_tasks (tenant_id, run_id, step_key, title, expires_at)
         VALUES ($1,$2,'approve_it','Approve the discount', now() + interval '2 days')
         RETURNING id`,
        [tenantA, run.id],
      );
      taskId = rows[0].id;

      await c.query(
        `UPDATE workflow_tasks SET status = 'approved', responded_by = $2 WHERE id = $1`,
        [taskId, userA],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `UPDATE workflow_tasks SET status = 'rejected', responded_by = $2 WHERE id = $1`,
          [taskId, userA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/already approved/i);
  });

  it("an answered task records who answered and when", async () => {
    const run = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO workflow_tasks
             (tenant_id, run_id, step_key, title, status, expires_at)
           VALUES ($1,$2,'x','Unattributed','approved', now() + interval '1 day')`,
          [tenantA, run.id],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("only one pending request per step of a run", async () => {
    const run = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        for (let i = 0; i < 2; i += 1) {
          await c.query(
            `INSERT INTO workflow_tasks (tenant_id, run_id, step_key, title, expires_at)
             VALUES ($1,$2,'dup','Approve', now() + interval '1 day')`,
            [tenantA, run.id],
          );
        }
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });
});

/* ================================================================== */
/* 7. THE SWEEPERS                                                     */
/* ================================================================== */

describe("sweepers", () => {
  it("resumes a run whose delay has elapsed, and leaves a live one alone", async () => {
    const due = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });
    const notDue = await insertRun(tenantA, {
      workflowId: workflowA2,
      versionId: versionA2,
      actorUserId: userA,
    });

    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE workflow_runs SET status = 'waiting_delay', resume_at = now() - interval '1 minute'
          WHERE id = $1`,
        [due.id],
      );
      await c.query(
        `UPDATE workflow_runs SET status = 'waiting_delay', resume_at = now() + interval '1 hour'
          WHERE id = $1`,
        [notDue.id],
      );

      const { rows } = await c.query(
        "SELECT * FROM claim_due_workflow_runs($1::uuid, 10)",
        [tenantA],
      );
      const claimed = rows.map((r) => r.run_id);
      expect(claimed).toContain(due.id);
      expect(claimed).not.toContain(notDue.id);

      const after = await c.query(
        "SELECT id, status, resume_at FROM workflow_runs WHERE id = ANY($1::uuid[])",
        [[due.id, notDue.id]],
      );
      const dueRow = after.rows.find((r) => r.id === due.id);
      const liveRow = after.rows.find((r) => r.id === notDue.id);
      expect(dueRow.status).toBe("queued");
      expect(dueRow.resume_at).toBeNull();
      expect(liveRow.status).toBe("waiting_delay");
    });
  });

  it("the sweep does not touch another tenant's runs", async () => {
    const foreign = await insertRun(tenantB, {
      workflowId: workflowB,
      versionId: versionB,
      actorUserId: userB,
    });

    await asTenant(tenantB, async (c) => {
      await c.query(
        `UPDATE workflow_runs SET status = 'waiting_delay', resume_at = now() - interval '1 hour'
          WHERE id = $1`,
        [foreign.id],
      );
    });

    await asTenant(tenantA, async (c) => {
      await c.query("SELECT * FROM claim_due_workflow_runs($1::uuid, 10)", [tenantA]);
    });

    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT status FROM workflow_runs WHERE id = $1", [
        foreign.id,
      ]);
      // Even without the parameter, RLS would hide tenant B's row — both
      // layers are checked.
      expect(rows[0].status).toBe("waiting_delay");
    });
  });

  it("an unanswered approval expires AND fails its run", async () => {
    // An expired task that left its run waiting would be the worst of
    // both: the request is gone from everybody's list and the run still
    // holds a cursor, waiting for a reply that can no longer be given.
    const run = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO workflow_tasks (tenant_id, run_id, step_key, title, expires_at)
         VALUES ($1,$2,'ask','Approve the refund', now() - interval '1 hour')`,
        [tenantA, run.id],
      );
      await c.query(`UPDATE workflow_runs SET status = 'waiting_form' WHERE id = $1`, [
        run.id,
      ]);

      const { rows } = await c.query("SELECT * FROM expire_workflow_tasks($1::uuid)", [
        tenantA,
      ]);
      expect(rows.map((r) => r.run_id)).toContain(run.id);

      const after = await c.query(
        "SELECT status, error FROM workflow_runs WHERE id = $1",
        [run.id],
      );
      expect(after.rows[0].status).toBe("failed");
      expect(after.rows[0].error).toMatch(/Nobody responded/i);
    });
  });
});

/* ================================================================== */
/* 8. CONCURRENCY — CLAIMING A RUN                                     */
/* ================================================================== */

describe("claiming a run", () => {
  it("⭐ two workers cannot both claim the same queued run", async () => {
    // ══════════════════════════════════════════════════════════════
    // The same interleaving as the double-sale in Phase 22, one table
    // across: both workers read `queued`, both proceed, and every
    // effect in the run happens twice — two emails to one buyer.
    //
    // The claim is a CONDITIONAL UPDATE, so exactly one of them changes
    // a row. The sequence below is forced rather than hoped for.
    // ══════════════════════════════════════════════════════════════
    const run = await insertRun(tenantA, {
      workflowId: workflowA,
      versionId: versionA,
      actorUserId: userA,
    });

    const c1 = await testPool.connect();
    const c2 = await testPool.connect();

    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");
      await c1.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      await c2.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);

      const read1 = await c1.query("SELECT status FROM workflow_runs WHERE id = $1", [run.id]);
      const read2 = await c2.query("SELECT status FROM workflow_runs WHERE id = $1", [run.id]);
      expect(read1.rows[0].status).toBe("queued");
      expect(read2.rows[0].status).toBe("queued");

      const claim1 = await c1.query(
        `UPDATE workflow_runs SET status = 'running' WHERE id = $1 AND status = 'queued'
         RETURNING id`,
        [run.id],
      );

      const claim2Promise = c2
        .query(
          `UPDATE workflow_runs SET status = 'running' WHERE id = $1 AND status = 'queued'
           RETURNING id`,
          [run.id],
        )
        .then((r) => r.rowCount)
        .catch(() => -1);

      await c1.query("COMMIT");
      const claim2 = await claim2Promise;
      await c2.query("COMMIT").catch(() => {});

      expect(claim1.rowCount).toBe(1);
      expect(
        claim2,
        "TWO WORKERS CLAIMED ONE RUN. Every effect in it will happen twice.",
      ).toBe(0);
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c2.query("ROLLBACK").catch(() => {});
      c1.release();
      c2.release();
    }
  });
});

/* ================================================================== */
/* 9. ⭐ THE PURE PLANNER — NO DATABASE AT ALL                          */
/* ================================================================== */

function contextFor(record: Record<string, unknown> = {}): RunContext {
  return {
    trigger: {
      type: "record_updated",
      recordType: "lead",
      record,
      changedFields: Object.keys(record),
      firedAt: new Date("2026-08-01T09:00:00Z").toISOString(),
    },
    steps: {},
    actor: { userId: "u", role: "member" },
  };
}

function stateFor(
  program: WorkflowProgram,
  overrides: Partial<PlanState> = {},
): PlanState {
  return {
    program,
    cursor: initialCursor(),
    context: contextFor({ status: "qualified", score: 80 }),
    counters: { stepsExecuted: 0, iterationsUsed: 0, stepBudget: 100 },
    depth: 0,
    now: new Date("2026-08-01T09:00:00Z"),
    ...overrides,
  };
}

describe("the planner (pure)", () => {
  it("runs a simple program to completion", async () => {
    const program: WorkflowProgram = {
      steps: [
        {
          key: "note_it",
          action: "update_record",
          recordType: "lead",
          recordId: "{{ trigger.record.id }}",
          values: { temperature: "hot" },
        },
      ],
    };

    const first = planNext(stateFor(program));
    expect(first.kind).toBe("run_step");
    if (first.kind !== "run_step") throw new Error("unreachable");
    expect(first.step.key).toBe("note_it");
    expect(first.path).toBe("0");

    // The cursor comes back ADVANCED — see the header of planner.ts.
    const second = planNext(
      stateFor(program, { cursor: first.cursor, counters: { stepsExecuted: 1, iterationsUsed: 0, stepBudget: 100 } }),
    );
    expect(second.kind).toBe("finish");
    if (second.kind === "finish") expect(second.status).toBe("succeeded");
  });

  it("⭐ a filter that does not match STOPS the run — not succeeds, not fails", async () => {
    const program: WorkflowProgram = {
      steps: [
        {
          key: "only_hot",
          action: "filter",
          conditions: { match: "all", conditions: [{ path: "trigger.record.score", operator: "gte", value: 90 }] },
        },
        { key: "never", action: "send_email", to: "x@example.com", subject: "s", body: "b" },
      ],
    };

    const result = planNext(stateFor(program));
    expect(result.kind).toBe("finish");
    if (result.kind !== "finish") throw new Error("unreachable");
    // ⚠️ `stopped`, so "the run did nothing and that was correct" is
    // distinguishable from "the run did everything".
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.stepKey).toBe("only_hot");
  });

  it("takes the branch the conditions choose", async () => {
    const program: WorkflowProgram = {
      steps: [
        {
          key: "hot_or_not",
          action: "if_else",
          conditions: {
            match: "all",
            conditions: [{ path: "trigger.record.status", operator: "eq", value: "qualified" }],
          },
          then: [{ key: "yes", action: "send_email", to: "a@b.com", subject: "s", body: "" }],
          otherwise: [{ key: "no", action: "send_email", to: "c@d.com", subject: "s", body: "" }],
        },
      ],
    };

    const result = planNext(stateFor(program));
    expect(result.kind).toBe("run_step");
    if (result.kind !== "run_step") throw new Error("unreachable");
    expect(result.step.key).toBe("yes");
    expect(result.path).toBe("0.then.0");
  });

  it("⭐ caps an iterator at the per-loop limit", async () => {
    // A "for each" over every record in the workspace is not a workflow,
    // it is a migration — and one workflow must not be able to consume
    // the whole system.
    const items = Array.from({ length: MAX_ITERATIONS_PER_LOOP + 50 }, (_, i) => ({ id: i }));
    const context = contextFor({});
    context.steps = { find_them: { records: items } };

    const program: WorkflowProgram = {
      steps: [
        {
          key: "each",
          action: "iterator",
          source: "steps.find_them.records",
          body: [{ key: "ping", action: "send_email", to: "a@b.com", subject: "s", body: "" }],
        },
      ],
    };

    let state = stateFor(program, { context });
    let executed = 0;

    for (let i = 0; i < MAX_ITERATIONS_PER_LOOP + 100; i += 1) {
      const result = planNext(state);
      if (result.kind === "finish") break;
      if (result.kind !== "run_step") throw new Error(`unexpected ${result.kind}`);
      executed += 1;
      state = {
        ...state,
        cursor: result.cursor,
        counters: { ...state.counters, stepsExecuted: executed, stepBudget: 10_000 },
      };
    }

    expect(executed).toBe(MAX_ITERATIONS_PER_LOOP);
  });

  it("⭐ aborts when the step budget is exhausted", async () => {
    const program: WorkflowProgram = {
      steps: [{ key: "a", action: "send_email", to: "a@b.com", subject: "s", body: "" }],
    };

    const result = planNext(
      stateFor(program, {
        counters: { stepsExecuted: 100, iterationsUsed: 0, stepBudget: 100 },
      }),
    );

    expect(result.kind).toBe("abort");
    if (result.kind === "abort") expect(result.reason).toBe("step_budget_exhausted");
  });

  it("⭐ aborts a run that is too deep in a chain of automations", async () => {
    const program: WorkflowProgram = {
      steps: [{ key: "a", action: "send_email", to: "a@b.com", subject: "s", body: "" }],
    };

    const result = planNext(stateFor(program, { depth: MAX_TRIGGER_DEPTH + 1 }));
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") expect(result.reason).toBe("depth_exceeded");
  });

  it("suspends on a delay and resumes after it, not before it", async () => {
    const program: WorkflowProgram = {
      steps: [
        { key: "wait", action: "delay", seconds: 3600 },
        { key: "then", action: "send_email", to: "a@b.com", subject: "s", body: "" },
      ],
    };

    const first = planNext(stateFor(program));
    expect(first.kind).toBe("sleep");
    if (first.kind !== "sleep") throw new Error("unreachable");
    expect(first.resumeAt.toISOString()).toBe("2026-08-01T10:00:00.000Z");

    const second = planNext(stateFor(program, { cursor: first.cursor }));
    expect(second.kind).toBe("run_step");
    if (second.kind === "run_step") expect(second.step.key).toBe("then");
  });

  it("a cursor that no longer fits its program aborts instead of crashing", async () => {
    const program: WorkflowProgram = { steps: [] };
    const result = planNext(
      stateFor(program, { cursor: { frames: [{ list: ["4", "then"], index: 0 }] } }),
    );
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") expect(result.reason).toBe("invalid_program");
  });
});

/* ================================================================== */
/* 10. ⭐ TRIGGER DECISIONS (PURE)                                     */
/* ================================================================== */

const candidate: TriggerCandidate = {
  workflowId: "wf-1",
  versionId: "v-1",
  triggerType: "record_updated",
  triggerConfig: { recordType: "lead", watchFields: ["status"] },
  isEnabled: true,
};

function eventFor(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    type: "record_updated",
    recordType: "lead",
    recordId: "rec-1",
    record: { id: "rec-1", status: "qualified" },
    changedFields: ["status"],
    firedAt: new Date(),
    ...overrides,
  };
}

describe("trigger decisions (pure)", () => {
  it("fires on a watched field", async () => {
    expect(decideTrigger(candidate, eventFor()).fires).toBe(true);
  });

  it("⭐ does NOT fire when the workflow caused the event itself", async () => {
    // "When a lead is updated, update the lead" is the first workflow
    // every administrator writes. Without this it is an infinite loop
    // that begins the moment they save it.
    const decision = decideTrigger(
      candidate,
      eventFor({ causedByVersionId: "v-1", causedByDepth: 0 }),
    );
    expect(decision.fires).toBe(false);
    if (!decision.fires) expect(decision.reason).toBe("self_trigger");
  });

  it("⭐ does NOT fire when it already ran earlier in the chain", async () => {
    const decision = decideTrigger(
      candidate,
      eventFor({ causedByVersionId: "v-2", causedByDepth: 1, originChain: ["v-1", "v-2"] }),
    );
    expect(decision.fires).toBe(false);
    if (!decision.fires) expect(decision.reason).toBe("cycle_detected");
  });

  it("⭐ does NOT fire past the depth limit", async () => {
    const decision = decideTrigger(
      candidate,
      eventFor({ causedByVersionId: "v-9", causedByDepth: MAX_TRIGGER_DEPTH }),
    );
    expect(decision.fires).toBe(false);
    if (!decision.fires) expect(decision.reason).toBe("depth_exceeded");
  });

  it("⭐ does NOT fire when the update did not touch a watched field", async () => {
    // The most effective loop prevention available, and the one the
    // author actually understands.
    const decision = decideTrigger(candidate, eventFor({ changedFields: ["owner_id"] }));
    expect(decision.fires).toBe(false);
    if (!decision.fires) expect(decision.reason).toBe("no_watched_field_changed");
  });

  it("does not fire for a different record type, or when switched off", async () => {
    expect(decideTrigger(candidate, eventFor({ recordType: "contact" })).fires).toBe(false);
    expect(decideTrigger({ ...candidate, isEnabled: false }, eventFor()).fires).toBe(false);
  });
});

/* ================================================================== */
/* 11. VALIDATION, BINDINGS, POLICY, CRON (PURE)                       */
/* ================================================================== */

describe("validation (pure)", () => {
  it("refuses a workflow that writes a column automations may not set", async () => {
    const result = validateDefinition({
      triggerType: "record_created",
      triggerConfig: { recordType: "lead" },
      program: {
        steps: [
          {
            key: "escalate",
            action: "update_record",
            recordType: "lead",
            recordId: "{{ trigger.record.id }}",
            // The whole point of the allow-list.
            values: { tenant_id: "someone-elses-tenant" },
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("record_column_refused");
  });

  it("refuses a record type outside the catalogue", async () => {
    const result = validateDefinition({
      triggerType: "manual",
      triggerConfig: {},
      program: {
        steps: [
          { key: "grab", action: "find_records", recordType: "users" },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("record_type_unknown");
  });

  it("refuses creating a booking from a workflow", async () => {
    // Three layers of double-sale protection live in `createBooking`. An
    // INSERT that skipped them is exactly the "one flat, two buyers"
    // outcome Phase 22 exists to prevent.
    const result = validateDefinition({
      triggerType: "manual",
      triggerConfig: {},
      program: {
        steps: [
          { key: "book", action: "create_record", recordType: "booking", values: { payment_status: "pending" } },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("record_operation_unsupported");
  });

  it("⭐ WARNS about an unscoped update trigger without blocking it", async () => {
    const result = validateDefinition({
      triggerType: "record_updated",
      triggerConfig: { recordType: "lead" },
      program: {
        steps: [
          {
            key: "touch",
            action: "update_record",
            recordType: "lead",
            recordId: "{{ trigger.record.id }}",
            values: { score: 50 },
          },
        ],
      },
    });

    // Valid — it can run, and sometimes it is exactly right.
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("trigger_unscoped_update");
    expect(result.warnings.map((w) => w.code)).toContain("self_trigger_unscoped");
  });

  it("refuses a filter with no conditions", async () => {
    const result = validateDefinition({
      triggerType: "manual",
      triggerConfig: {},
      program: {
        steps: [{ key: "guard", action: "filter", conditions: { match: "all", conditions: [] } }],
      },
    });
    expect(result.errors.map((e) => e.code)).toContain("filter_empty");
  });

  it("accepts a sound definition", async () => {
    const result = validateDefinition({
      triggerType: "record_updated",
      triggerConfig: { recordType: "lead", watchFields: ["status"] },
      program: {
        steps: [
          {
            key: "only_won",
            action: "filter",
            conditions: {
              match: "all",
              conditions: [{ path: "trigger.record.status", operator: "eq", value: "won" }],
            },
          },
          { key: "tell_them", action: "send_email", to: "{{ trigger.record.email }}", subject: "Welcome", body: "Hello" },
        ],
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("bindings (pure)", () => {
  it("reads a path and refuses to walk the prototype chain", async () => {
    const context = contextFor({ name: "Buyer One" });
    expect(readPath(context, "trigger.record.name")).toBe("Buyer One");
    // `__proto__`, `constructor` and `toString` must all resolve to
    // nothing — an expression language that hands back a function is one
    // step from being callable.
    expect(readPath(context, "trigger.record.__proto__")).toBeUndefined();
    expect(readPath(context, "trigger.record.constructor")).toBeUndefined();
    expect(readPath(context, "trigger.toString")).toBeUndefined();
  });

  it("an unresolved binding becomes empty, never the literal template", async () => {
    const context = contextFor({});
    expect(interpolate("Hi {{ trigger.record.nmae }}!", context)).toBe("Hi !");
  });

  it("compares numbers loosely and refuses incomparable values", async () => {
    const context = contextFor({ score: 80 });
    expect(
      evaluateGroup(
        { match: "all", conditions: [{ path: "trigger.record.score", operator: "gte", value: "80" }] },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateGroup(
        { match: "all", conditions: [{ path: "trigger.record.score", operator: "gte", value: "abc" }] },
        context,
      ),
    ).toBe(false);
  });

  it("treats 0 and false as values, not as empty", async () => {
    // A lead score of 0 is a real score. Treating it as empty is how a
    // scoring workflow skips exactly the leads it exists to catch.
    const context = contextFor({ score: 0 });
    expect(
      evaluateGroup(
        { match: "all", conditions: [{ path: "trigger.record.score", operator: "is_empty" }] },
        context,
      ),
    ).toBe(false);
  });
});

describe("outbound request policy (pure)", () => {
  it("⭐ refuses the cloud metadata service in every disguise", async () => {
    for (const host of [
      "https://169.254.169.254/latest/meta-data/",
      "https://metadata.google.internal/",
      "https://2852039166/",
      "https://[::ffff:169.254.169.254]/",
    ]) {
      const verdict = checkOutboundUrl(host);
      expect(verdict.allowed, host).toBe(false);
    }
  });

  it("refuses loopback, private ranges and their numeric forms", async () => {
    expect(isPrivateAddressLiteral("127.0.0.1")).toBe(true);
    expect(isPrivateAddressLiteral("2130706433")).toBe(true);
    expect(isPrivateAddressLiteral("0177.0.0.1")).toBe(true);
    expect(isPrivateAddressLiteral("10.1.2.3")).toBe(true);
    expect(isPrivateAddressLiteral("172.16.0.1")).toBe(true);
    expect(isPrivateAddressLiteral("192.168.1.1")).toBe(true);
    expect(isPrivateAddressLiteral("::1")).toBe(true);
    expect(isPrivateAddressLiteral("8.8.8.8")).toBe(false);
  });

  it("refuses plain http and credentials in the URL", async () => {
    expect(checkOutboundUrl("http://example.com/hook").allowed).toBe(false);
    expect(checkOutboundUrl("https://user:pass@example.com/hook").allowed).toBe(false);
  });

  it("allows an ordinary public endpoint", async () => {
    // The other half. A policy that refuses everything is an outage.
    const verdict = checkOutboundUrl("https://hooks.example.com/inbound?x=1");
    expect(verdict.allowed).toBe(true);
  });
});

describe("cron (pure)", () => {
  it("parses five fields and refuses anything else", async () => {
    expect(parseCron("0 9 * * 1-5").ok).toBe(true);
    expect(parseCron("0 9 * *").ok).toBe(false);
    expect(parseCron("99 9 * * *").ok).toBe(false);
  });

  it("⭐ never returns the current minute — a job that fires twice is a defect", async () => {
    const at = new Date("2026-08-03T09:00:00Z");
    const next = nextCronFireAt("0 9 * * 1-5", at, "UTC");
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-08-04T09:00:00.000Z");
  });

  it("evaluates the schedule in the tenant's timezone", async () => {
    // 09:00 in Kolkata is 03:30 UTC. An implementation using a stored
    // offset — or UTC — sends the demand notice at the wrong time of day.
    const next = nextCronFireAt("0 9 * * *", new Date("2026-08-01T00:00:00Z"), "Asia/Kolkata");
    expect(next!.toISOString()).toBe("2026-08-01T03:30:00.000Z");
  });

  it("returns null for a schedule that can never occur", async () => {
    expect(nextCronFireAt("0 0 30 2 *", new Date(), "UTC")).toBeNull();
  });
});

describe("the record catalogue (pure)", () => {
  it("names the permission each operation needs", async () => {
    expect(permissionForRecordAction("lead", "delete")).toBe("leads:delete");
    expect(permissionForRecordAction("lead", "update")).toBe("leads:update");
    // Not offered at all — and the caller must treat null as a refusal.
    expect(permissionForRecordAction("booking", "create")).toBeNull();
    expect(permissionForRecordAction("unit", "delete")).toBeNull();
    expect(permissionForRecordAction("audit_logs", "read")).toBeNull();
  });

  it("⭐ refuses the columns that would bypass another phase's guarantees", async () => {
    const { allowed, refused } = partitionWritableColumns("unit", [
      "price_minor",
      // Phase 22 spent a whole file making unit status coherent.
      "status",
      "hold_until",
      "tenant_id",
    ]);
    expect(allowed).toEqual(["price_minor"]);
    expect(refused).toEqual(["status", "hold_until", "tenant_id"]);
  });
});
