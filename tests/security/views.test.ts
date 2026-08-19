/**
 * Ordence — Saved Views: Injection, Sharing and Isolation
 * Version: v0.25.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Twenty-four phases say the same thing: the defects that survive are the
 * SILENT ones. `writeAudit` discarded the audit trail for fourteen phases
 * with no error. `withPlatformScope` read zero rows and failed closed, so
 * nothing leaked and nothing worked.
 *
 * This phase has two new ways to be silent, and they are the two the
 * tests below are built around.
 *
 *   ⭐ 1. AN IDENTIFIER ALLOWLIST THAT IS NOT CONSULTED.
 *
 *      A saved view stores field names and replays them as SQL
 *      identifiers weeks later. `lib/views/registry.ts` is supposed to
 *      resolve every one of them. A version that resolved MOST of them —
 *      the filter but not the sort, say — would pass every functional
 *      test in existence, because a legitimate view names legitimate
 *      fields and works either way.
 *
 *      So the tests do not check that the allowlist exists. They feed it
 *      `tenant_id`, `"; DROP TABLE leads; --`, `constructor`, and a
 *      column that belongs to a different object, through EVERY entry
 *      point: filter field, sort field, group-by, and column list.
 *
 *   ⭐ 2. A SHARED VIEW THAT REPLAYS ITS AUTHOR'S AUTHORITY.
 *
 *      This one is worse, because the working version and the broken
 *      version behave identically for everybody who has permission. The
 *      difference only shows for the one caller who does not — and that
 *      caller is a contractor reading the order book.
 *
 *      So the sharing tests build the escalation: a view authored by an
 *      administrator over every lead in the workspace, opened by somebody
 *      whose access is narrower, and they assert on the ROWS.
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears only for fixtures and teardown, because a
 * superuser bypasses row-level security entirely and a suite written on
 * one proves nothing.
 *
 * The pure half of the file runs the planner with no database at all —
 * which is the entire reason the planner is pure.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

import {
  compileOrderBy,
  compileSelectList,
  compileWhere,
  renderTokens,
  resolveColumns,
  resolveGroupBy,
  ViewPlanError,
  type ViewerScope,
} from "@/lib/views/planner";
import {
  VIEW_OBJECTS,
  resolveField,
  viewObject,
  buildDynamicViewObject,
} from "@/lib/views/registry";
import {
  canManageView,
  canReadObject,
  resolveViewerScope,
  VIEW_PERMISSIONS,
} from "@/lib/views/access";
import { validateDefinition, validateFilter } from "@/lib/views/validation";
import { resolveDateWindow, coerceOperand } from "@/lib/views/operators";
import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_FILTER_BYTES,
} from "@/lib/views/limits";
import { emptyFilter, type FilterGroup } from "@/lib/views/types";
import { filterGroupSchema } from "@/lib/validators/views";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

const lead = VIEW_OBJECTS.lead!;
const booking = VIEW_OBJECTS.booking!;
const unit = VIEW_OBJECTS.unit!;

let tenantA: string;
let tenantB: string;
/** Tenant A's administrator — sees everything. */
let alice: string;
/** Tenant A's sales executive — narrowed to their own records in the tests. */
let bob: string;
let userB: string;

let viewA: string;
let sharedViewA: string;
let viewB: string;

/** Scope objects, built the way the server builds them. */
const scopeFor = (tenantId: string, ownerUserId: string | null): ViewerScope => ({
  tenantId,
  restrictToOwnerUserId: ownerUserId,
});

async function makeLead(
  tenantId: string,
  reference: string,
  fields: {
    name: string;
    status?: string;
    score?: number;
    ownerId?: string | null;
    followUpAt?: string | null;
    temperature?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO leads
         (id, tenant_id, reference, name, status, score, owner_id, next_follow_up_at,
          temperature)
       VALUES ($1,$2,$3,$4,$5::lead_status,$6,$7,$8,$9::lead_temperature)`,
      [
        id,
        tenantId,
        reference,
        fields.name,
        fields.status ?? "new",
        fields.score ?? 0,
        fields.ownerId ?? null,
        fields.followUpAt ?? null,
        fields.temperature ?? "warm",
      ],
    );
  });
  return id;
}

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  alice = randomUUID();
  bob = randomUUID();
  userB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Views Isolation A"],
      [tenantB, "Views Isolation B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `vw-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status) VALUES
         ($1,$2,$3,'alice@views.test','tenant_admin','active'),
         ($4,$5,$6,'bob@views.test','member','active'),
         ($7,$8,$9,'other@views.test','tenant_admin','active')`,
      [
        alice, tenantA, `usr_${alice}`,
        bob, tenantA, `usr_${bob}`,
        userB, tenantB, `usr_${userB}`,
      ],
    );
  });

  /* --- The data the happy path asserts on ------------------------ */
  //
  // Deliberately mixed: two owners, several statuses, a spread of scores
  // and one lead whose name is an injection attempt.
  await makeLead(tenantA, "LEAD-A1", {
    name: "Anita Rao",
    status: "qualified",
    score: 80,
    ownerId: alice,
  });
  await makeLead(tenantA, "LEAD-A2", {
    name: "Bhaskar Nair",
    status: "qualified",
    score: 55,
    ownerId: bob,
  });
  await makeLead(tenantA, "LEAD-A3", {
    name: "Chandni Shah",
    status: "negotiation",
    score: 91,
    ownerId: bob,
  });
  await makeLead(tenantA, "LEAD-A4", {
    name: "Deepak Menon",
    status: "new",
    score: 20,
    ownerId: alice,
  });
  await makeLead(tenantA, "LEAD-A5", {
    // ⚠️ The VALUE, not the identifier. It must round-trip untouched as a
    // bound parameter and must not affect the statement.
    name: `Robert'); DROP TABLE leads; --`,
    status: "new",
    score: 5,
    ownerId: alice,
  });
  await makeLead(tenantB, "LEAD-B1", {
    name: "Other Tenant Lead",
    status: "qualified",
    score: 99,
    ownerId: userB,
  });

  /* --- Saved views ------------------------------------------------ */
  viewA = randomUUID();
  sharedViewA = randomUUID();
  viewB = randomUUID();

  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO saved_views
         (id, tenant_id, object_key, name, owner_user_id, is_shared, filter, sorts)
       VALUES
         ($1,$2,'lead','Alice private',$3,false,
          '{"type":"group","match":"all","children":[]}'::jsonb,'[]'::jsonb),
         ($4,$2,'lead','Every qualified lead',$3,true,
          '{"type":"group","match":"all","children":[
             {"type":"condition","field":"status","operator":"eq","value":"qualified"}]}'::jsonb,
          '[]'::jsonb)`,
      [viewA, tenantA, alice, sharedViewA],
    );

    await c.query(
      `INSERT INTO saved_views
         (id, tenant_id, object_key, name, owner_user_id, is_shared)
       VALUES ($1,$2,'lead','Tenant B view',$3,true)`,
      [viewB, tenantB, userB],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantA, tenantB];
    await c.query(`DELETE FROM saved_view_defaults WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM saved_views WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM leads WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  });
});

/* ================================================================== */
/* 1. CROSS-TENANT ISOLATION                                           */
/* ================================================================== */

describe("saved views — cross-tenant isolation", () => {
  it("one tenant cannot read another tenant's saved views", async () => {
    const mine = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT id, name FROM saved_views`);
      return rows;
    });

    // Alice's two, and nothing from tenant B.
    expect(mine.length).toBe(2);
    expect(mine.map((r) => r.id).sort()).toEqual([viewA, sharedViewA].sort());

    const theirs = await asTenant(tenantB, async (c) => {
      const { rows } = await c.query(`SELECT id FROM saved_views WHERE id = $1`, [viewA]);
      return rows;
    });
    expect(theirs.length).toBe(0);
  });

  it("a tenant cannot plant a saved view in another tenant's workspace", async () => {
    // ⚠️ THE `WITH CHECK` HALF OF THE POLICY. A `USING`-only policy hides
    // other tenants' rows and happily accepts a write into their
    // workspace, which is the half that gets forgotten.
    const error = await expectError(() =>
      asTenant(tenantB, async (c) => {
        await c.query(
          `INSERT INTO saved_views (tenant_id, object_key, name, owner_user_id)
           VALUES ($1,'lead','Planted',$2)`,
          [tenantA, alice],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/row-level security/i);
  });

  it("a saved view cannot point at a user in another tenant", async () => {
    // ⚠️ FK CHECKS IGNORE RLS. Without the composite (owner_user_id,
    // tenant_id) key this insert SUCCEEDS — the user really does exist —
    // and the row becomes an existence oracle across the boundary.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO saved_views (tenant_id, object_key, name, owner_user_id)
           VALUES ($1,'lead','Cross-tenant owner',$2)`,
          [tenantA, userB],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
  });

  it("a default cannot point at another tenant's view", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO saved_view_defaults (tenant_id, user_id, object_key, view_id)
           VALUES ($1,$2,'lead',$3)`,
          [tenantA, alice, viewB],
        );
      }),
    );

    expect(error).not.toBeNull();
  });
});

/* ================================================================== */
/* 2. ⭐ INJECTION THROUGH FIELD NAMES                                  */
/* ================================================================== */

describe("saved views — identifiers are resolved, never interpolated", () => {
  const scope = () => scopeFor("11111111-1111-1111-1111-111111111111", null);

  const HOSTILE_NAMES = [
    `id"; DROP TABLE leads; --`,
    `id) OR 1=1 --`,
    `name, (SELECT password FROM users)`,
    `leads.name`,
    `"name"`,
    `name ASC, tenant_id`,
    // A perfectly valid identifier that is simply not a field of this
    // object. An escape function would have let this through.
    `tenant_id`,
    `deleted_at`,
    // Belongs to a different object.
    `agreement_value_minor`,
    // Prototype pollution: `"constructor" in obj` is true on any object
    // literal, which is why the registry uses `Object.hasOwn`.
    `constructor`,
    `__proto__`,
    `toString`,
  ];

  it("refuses every hostile name as a SORT key", () => {
    for (const name of HOSTILE_NAMES) {
      expect(() =>
        compileOrderBy(lead, [{ field: name, direction: "asc" }]),
      ).toThrow(ViewPlanError);
    }
  });

  it("refuses every hostile name as a FILTER field", () => {
    for (const name of HOSTILE_NAMES) {
      const filter: FilterGroup = {
        type: "group",
        match: "all",
        children: [{ type: "condition", field: name, operator: "eq", value: "x" }],
      };
      expect(() => compileWhere(scope(), lead, filter, { now: new Date() })).toThrow(
        ViewPlanError,
      );
    }
  });

  it("refuses every hostile name as a GROUP BY", () => {
    for (const name of HOSTILE_NAMES) {
      expect(() => resolveGroupBy(lead, name)).toThrow(ViewPlanError);
    }
  });

  it("drops — rather than emits — a hostile name in the COLUMN list", () => {
    // ⚠️ COLUMNS ARE THE ONE PLACE SILENCE IS RIGHT, and the asymmetry is
    // deliberate. A field removed from an object should not make every
    // saved view over it fail to open; the reader loses a column. A
    // FILTER on a missing field still refuses, because dropping it would
    // silently WIDEN what the view returns.
    const fields = resolveColumns(
      lead,
      HOSTILE_NAMES.map((field) => ({ field })).concat([{ field: "name" }]),
    );
    const emitted = compileSelectList(fields);

    expect(emitted).toBe('"id", "name"');
    expect(emitted).not.toMatch(/DROP|SELECT|tenant_id|--/);
  });

  it("resolves nothing for a name that is not an own property", () => {
    expect(resolveField(lead, "constructor")).toBeNull();
    expect(resolveField(lead, "__proto__")).toBeNull();
    expect(resolveField(lead, "tenant_id")).toBeNull();
    expect(viewObject("constructor")).toBeNull();
    expect(viewObject("__proto__")).toBeNull();
    // …and resolves a real one.
    expect(resolveField(lead, "status")?.column).toBe("status");
  });

  it("emits only quoted identifiers and $n placeholders", () => {
    const filter: FilterGroup = {
      type: "group",
      match: "any",
      children: [
        { type: "condition", field: "name", operator: "contains", value: "%_evil" },
        { type: "condition", field: "score", operator: "gte", value: 50 },
      ],
    };

    const compiled = compileWhere(scope(), lead, filter, { now: new Date() });
    const { text, params } = renderTokens(compiled.tokens);

    // Nothing that looks like a literal survives into the text.
    expect(text).not.toContain("evil");
    expect(text).not.toContain("50");
    expect(params).toContain(50);
    // ⚠️ The LIKE metacharacters were escaped. Unescaped, `%` makes the
    // pattern match every row — a filter that appears not to be applied.
    expect(params.some((p) => typeof p === "string" && p.includes("\\%\\_evil"))).toBe(
      true,
    );
  });

  it("a hostile VALUE is bound, not executed", async () => {
    // The lead literally named `Robert'); DROP TABLE leads; --`.
    const filter: FilterGroup = {
      type: "group",
      match: "all",
      children: [
        {
          type: "condition",
          field: "name",
          operator: "eq",
          value: `Robert'); DROP TABLE leads; --`,
        },
      ],
    };

    const compiled = compileWhere(scopeFor(tenantA, null), lead, filter, {
      now: new Date(),
    });
    const { text, params } = renderTokens(compiled.tokens);

    const rows = await asTenant(tenantA, async (c) => {
      const result = await c.query(
        `SELECT reference FROM ${lead.table} WHERE ${text}`,
        params,
      );
      return result.rows;
    });

    expect(rows.map((r) => r.reference)).toEqual(["LEAD-A5"]);

    // And the table is still there, which is the point.
    const survived = await asTenant(tenantA, async (c) => {
      const result = await c.query(`SELECT count(*)::int AS n FROM leads`);
      return result.rows[0].n;
    });
    expect(survived).toBeGreaterThan(0);
  });

  it("a Phase 24 runtime object's column names are re-checked at emit time", () => {
    // ⚠️ For a runtime object the descriptor's `column` came out of a
    // DATABASE ROW rather than the compiled schema. `server/views/objects.ts`
    // re-validates it on every read; `quoteColumn` refuses it again here.
    // This is the belt to that file's braces, and it is the reason the
    // planner has a regex at all.
    const hostile = buildDynamicViewObject({
      apiName: "site_visit",
      label: "Site visit",
      pluralLabel: "Site visits",
      physicalTableName: "cx_site_visit_abcdef01",
      displayFieldApiName: null,
      fields: [
        {
          apiName: "note",
          label: "Note",
          fieldType: "text",
          // A metadata row that a restore or a hand edit corrupted.
          physicalColumnName: `note"; DROP TABLE cx_site_visit_abcdef01; --`,
          options: [],
        },
      ],
    });

    expect(() => compileOrderBy(hostile, [{ field: "note", direction: "asc" }])).toThrow(
      ViewPlanError,
    );
  });
});

/* ================================================================== */
/* 3. ⭐ A SHARED VIEW CANNOT WIDEN ACCESS                              */
/* ================================================================== */

describe("saved views — sharing is not a grant", () => {
  it("object access is decided against the READER, not the author", () => {
    // A contractor: no `leads:read` at all, and no `views:read`.
    expect(canReadObject({ role: "guest" }, lead)).toBe(false);

    // Somebody who has saved views but has had bookings revoked. This is
    // the escalation in its purest form — they can open the picker, they
    // can see the shared view's NAME, and they must not get its rows.
    const narrowed = {
      role: "member" as const,
      overrides: { "bookings:read": false },
    };
    expect(canReadObject(narrowed, lead)).toBe(true);
    expect(canReadObject(narrowed, booking)).toBe(false);

    // The author, by contrast, can.
    expect(canReadObject({ role: "tenant_admin" }, booking)).toBe(true);
  });

  it("the scope comes from the caller and is ANDed outside the view's filter", async () => {
    /* The shared view says "every qualified lead" and says nothing about
       owners. Alice authored it and sees all of them. */
    const sharedFilter: FilterGroup = {
      type: "group",
      match: "all",
      children: [
        { type: "condition", field: "status", operator: "eq", value: "qualified" },
      ],
    };

    const asAlice = compileWhere(scopeFor(tenantA, null), lead, sharedFilter, {
      now: new Date(),
    });
    const asBob = compileWhere(scopeFor(tenantA, bob), lead, sharedFilter, {
      now: new Date(),
    });

    const run = async (compiled: ReturnType<typeof compileWhere>) => {
      const { text, params } = renderTokens(compiled.tokens);
      return asTenant(tenantA, async (c) => {
        const result = await c.query(
          `SELECT reference FROM leads WHERE ${text} ORDER BY reference`,
          params,
        );
        return result.rows.map((r) => r.reference as string);
      });
    };

    expect(await run(asAlice)).toEqual(["LEAD-A1", "LEAD-A2"]);
    // ⭐ THE ASSERTION THE WHOLE PHASE EXISTS FOR. Same view, same filter,
    // narrower caller — fewer rows, and specifically only Bob's.
    expect(await run(asBob)).toEqual(["LEAD-A2"]);
  });

  it("a view's own filter cannot escape the caller's scope", async () => {
    // The nastiest shape: a shared view that explicitly asks for somebody
    // else's records. Intersection has no way to widen, so it returns
    // nothing rather than Alice's leads.
    const hostileFilter: FilterGroup = {
      type: "group",
      match: "any",
      children: [
        { type: "condition", field: "owner_id", operator: "eq", value: alice },
        { type: "condition", field: "owner_id", operator: "is_empty" },
        { type: "condition", field: "score", operator: "gte", value: 0 },
      ],
    };

    const compiled = compileWhere(scopeFor(tenantA, bob), lead, hostileFilter, {
      now: new Date(),
    });
    const { text, params } = renderTokens(compiled.tokens);

    const rows = await asTenant(tenantA, async (c) => {
      const result = await c.query(
        `SELECT reference FROM leads WHERE ${text} ORDER BY reference`,
        params,
      );
      return result.rows.map((r) => r.reference as string);
    });

    expect(rows).toEqual(["LEAD-A2", "LEAD-A3"]);
    expect(rows).not.toContain("LEAD-A1");
  });

  it("the narrowing is derived from permissions, not from the view", () => {
    const seesAll = resolveViewerScope({ role: "member" }, lead, bob, tenantA);
    expect(seesAll.restrictToOwnerUserId).toBeNull();

    const narrowed = resolveViewerScope(
      { role: "member", overrides: { [VIEW_PERMISSIONS.readAllRecords]: false } },
      lead,
      bob,
      tenantA,
    );
    expect(narrowed.restrictToOwnerUserId).toBe(bob);

    // ⚠️ An object with no owner column is NOT narrowed — a unit belongs
    // to a building, not to a rep. Inventing an owner for it would make
    // inventory appear and disappear as unrelated state changed.
    const noOwner = resolveViewerScope(
      { role: "member", overrides: { [VIEW_PERMISSIONS.readAllRecords]: false } },
      unit,
      bob,
      tenantA,
    );
    expect(noOwner.restrictToOwnerUserId).toBeNull();
  });

  it("refuses rather than returns everything when a narrowed caller meets an ownerless object", () => {
    // A scope that should never be constructed for `unit`. If it ever is,
    // returning every row would be the escalation — so the planner throws.
    expect(() =>
      compileWhere(scopeFor(tenantA, bob), unit, emptyFilter(), { now: new Date() }),
    ).toThrow(ViewPlanError);
  });

  it("a shared view cannot be deleted by somebody who cannot manage it", () => {
    const shared = { ownerUserId: alice, isShared: true };

    // The author can.
    expect(canManageView({ role: "member" }, shared, alice).allowed).toBe(true);

    // ⚠️ A colleague holding `views:delete` CANNOT. That permission covers
    // their own views; removing the board the whole floor works from is
    // `views:manage_shared`, which is on the dangerous list.
    const colleague = canManageView({ role: "member" }, shared, bob);
    expect(colleague.allowed).toBe(false);
    expect(colleague.reason).toMatch(/shared with the whole workspace/i);

    // An administrator holding `views:manage_shared` can.
    expect(canManageView({ role: "tenant_admin" }, shared, bob).allowed).toBe(true);

    // And somebody else's PRIVATE view is simply "does not exist".
    const priv = canManageView({ role: "tenant_admin" }, { ownerUserId: alice, isShared: false }, bob);
    expect(priv.allowed).toBe(false);
    expect(priv.reason).toMatch(/does not exist/i);
  });

  it("a private view cannot become somebody else's default", async () => {
    // The database says so too — see SQL-FILES/0020 §5. Enforced there so
    // it holds for an import or a future API route as well as for the
    // server action.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO saved_view_defaults (tenant_id, user_id, object_key, view_id)
           VALUES ($1,$2,'lead',$3)`,
          [tenantA, bob, viewA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/your own or shared/i);
  });

  it("un-sharing clears the defaults it would otherwise strand", async () => {
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO saved_view_defaults (tenant_id, user_id, object_key, view_id)
         VALUES ($1,$2,'lead',$3)`,
        [tenantA, bob, sharedViewA],
      );
    });

    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE saved_views SET is_shared = false WHERE id = $1`, [
        sharedViewA,
      ]);
    });

    const left = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM saved_view_defaults WHERE view_id = $1 AND user_id = $2`,
        [sharedViewA, bob],
      );
      return rows[0].n as number;
    });

    expect(left).toBe(0);

    // Put it back for any later test that assumes the fixture.
    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE saved_views SET is_shared = true WHERE id = $1`, [
        sharedViewA,
      ]);
    });
  });
});

/* ================================================================== */
/* 4. ⭐ FILTER DEPTH AND SIZE LIMITS                                   */
/* ================================================================== */

describe("saved views — a filter tree is a denial-of-service surface", () => {
  const scope = () => scopeFor(tenantA, null);

  /** A group nested `depth` levels deep with one condition at the bottom. */
  function nested(depth: number): FilterGroup {
    let node: FilterGroup = {
      type: "group",
      match: "all",
      children: [{ type: "condition", field: "score", operator: "gte", value: 1 }],
    };
    for (let i = 1; i < depth; i += 1) {
      node = { type: "group", match: "all", children: [node] };
    }
    return node;
  }

  it("compiles a tree at the depth limit and refuses one past it", () => {
    expect(() =>
      compileWhere(scope(), lead, nested(MAX_FILTER_DEPTH), { now: new Date() }),
    ).not.toThrow();

    expect(() =>
      compileWhere(scope(), lead, nested(MAX_FILTER_DEPTH + 1), { now: new Date() }),
    ).toThrow(/nests more than/i);
  });

  it("refuses a tree with more nodes than the budget", () => {
    const wide: FilterGroup = {
      type: "group",
      match: "any",
      children: Array.from({ length: MAX_FILTER_NODES + 5 }, () => ({
        type: "condition" as const,
        field: "score",
        operator: "gte" as const,
        value: 1,
      })),
    };

    expect(() => compileWhere(scope(), lead, wide, { now: new Date() })).toThrow(
      /more than \d+ conditions/i,
    );
  });

  it("survives a pathologically deep payload without blowing the stack", () => {
    // ⚠️ THE TEST THAT JUSTIFIES THE BOUNDED-SCHEMA TRICK IN
    // `lib/validators/views.ts`. A `z.lazy` recursive schema PARSES the
    // whole tree before any refinement can count it — so a payload this
    // deep kills the process inside the validator that was meant to
    // reject it. The bounded chain fails to MATCH at the cap instead.
    let node: unknown = {
      type: "condition",
      field: "score",
      operator: "gte",
      value: 1,
    };
    for (let i = 0; i < 20_000; i += 1) {
      node = { type: "group", match: "all", children: [node] };
    }

    const result = filterGroupSchema.safeParse(node);
    expect(result.success).toBe(false);
  });

  it("the validator reports every problem rather than only the first", () => {
    const messy: FilterGroup = {
      type: "group",
      match: "all",
      children: [
        { type: "condition", field: "nope", operator: "eq", value: "x" },
        { type: "condition", field: "status", operator: "contains", value: "x" },
        { type: "condition", field: "score", operator: "between", values: [90, 10] },
      ],
    };

    const problems = validateFilter(lead, messy);
    expect(problems.length).toBe(3);
    // The inverted range is the silent one — it matches nothing and
    // errors nowhere.
    expect(problems.some((p) => /before the start/i.test(p.message))).toBe(true);
  });

  it("the database refuses an oversized filter even when nothing validated it", async () => {
    // ⚠️ THE ONLY LIMIT THAT SURVIVES A HAND-WRITTEN INSERT. Depth and
    // node count are application rules; psql, a restore and a future API
    // route each walk straight past them.
    const huge = JSON.stringify({
      type: "group",
      match: "all",
      children: Array.from({ length: 4_000 }, (_, i) => ({
        type: "condition",
        field: "score",
        operator: "gte",
        value: i,
      })),
    });
    expect(huge.length).toBeGreaterThan(MAX_FILTER_BYTES);

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO saved_views (tenant_id, object_key, name, owner_user_id, filter)
           VALUES ($1,'lead','Oversized',$2,$3::jsonb)`,
          [tenantA, alice, huge],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
  });

  it("refuses a board with no grouping and a calendar with no date", async () => {
    for (const [type, column] of [
      ["kanban", "group_by"],
      ["calendar", "date_field"],
    ] as const) {
      const error = await expectError(() =>
        asTenant(tenantA, async (c) => {
          await c.query(
            `INSERT INTO saved_views (tenant_id, object_key, name, owner_user_id, view_type)
             VALUES ($1,'lead',$2,$3,$4::view_type)`,
            [tenantA, `Bad ${type}`, alice, type],
          );
        }),
      );
      expect(error, `${type} without ${column} should be refused`).not.toBeNull();
      expect(error?.code).toBe("23514");
    }
  });
});

/* ================================================================== */
/* 5. THE HAPPY PATH                                                   */
/* ================================================================== */

describe("saved views — a real filter and sort return the right rows", () => {
  it("compiles a nested filter with a multi-key sort and returns exactly the matching rows", async () => {
    // "Qualified or in negotiation, AND scoring 50 or more."
    const filter: FilterGroup = {
      type: "group",
      match: "all",
      children: [
        {
          type: "group",
          match: "any",
          children: [
            { type: "condition", field: "status", operator: "eq", value: "qualified" },
            { type: "condition", field: "status", operator: "eq", value: "negotiation" },
          ],
        },
        { type: "condition", field: "score", operator: "gte", value: 50 },
      ],
    };

    const object = lead;
    const fields = resolveColumns(object, [
      { field: "reference" },
      { field: "name" },
      { field: "score" },
    ]);
    const selectList = compileSelectList(fields);
    const order = compileOrderBy(object, [
      { field: "score", direction: "desc" },
      { field: "name", direction: "asc" },
    ]);
    const where = compileWhere(scopeFor(tenantA, null), object, filter, {
      now: new Date(),
    });
    const { text, params } = renderTokens(where.tokens);

    const rows = await asTenant(tenantA, async (c) => {
      const result = await c.query(
        `SELECT ${selectList} FROM ${object.table} WHERE ${text} ORDER BY ${order.text}`,
        params,
      );
      return result.rows;
    });

    // A3 (91), A1 (80), A2 (55). A4 (20) and A5 (5) fail the score test;
    // the tenant B lead fails the tenant clause AND row-level security.
    expect(rows.map((r) => r.reference)).toEqual(["LEAD-A3", "LEAD-A1", "LEAD-A2"]);
    expect(rows[0].score).toBe(91);

    // ⚠️ The tiebreaker is always appended, so the order is stable across
    // pages. Without it a paginated list silently loses rows.
    expect(order.text.endsWith('"id" DESC')).toBe(true);
  });

  it("`in`, `contains` and `is_empty` behave as a person expects", async () => {
    const run = async (filter: FilterGroup) => {
      const where = compileWhere(scopeFor(tenantA, null), lead, filter, {
        now: new Date(),
      });
      const { text, params } = renderTokens(where.tokens);
      return asTenant(tenantA, async (c) => {
        const result = await c.query(
          `SELECT reference FROM leads WHERE ${text} ORDER BY reference`,
          params,
        );
        return result.rows.map((r) => r.reference as string);
      });
    };

    expect(
      await run({
        type: "group",
        match: "all",
        children: [
          {
            type: "condition",
            field: "status",
            operator: "in",
            values: ["qualified", "negotiation"],
          },
        ],
      }),
    ).toEqual(["LEAD-A1", "LEAD-A2", "LEAD-A3"]);

    expect(
      await run({
        type: "group",
        match: "all",
        children: [
          { type: "condition", field: "name", operator: "contains", value: "shah" },
        ],
      }),
    ).toEqual(["LEAD-A3"]);

    expect(
      await run({
        type: "group",
        match: "all",
        children: [
          { type: "condition", field: "next_follow_up_at", operator: "is_empty" },
        ],
      }),
    ).toHaveLength(5);

    // An empty filter is no filter — every row the scope allows.
    expect(await run(emptyFilter())).toHaveLength(5);
  });

  it("relative dates resolve against the injected clock, not the wall clock", async () => {
    const now = new Date("2026-03-18T11:30:00.000Z"); // A Wednesday.

    const week = resolveDateWindow("this_week", now)!;
    expect(week.from?.toISOString()).toBe("2026-03-16T00:00:00.000Z"); // Monday.
    expect(week.until?.toISOString()).toBe("2026-03-23T00:00:00.000Z");

    const today = resolveDateWindow("today", now)!;
    expect(today.from?.toISOString()).toBe("2026-03-18T00:00:00.000Z");
    expect(today.until?.toISOString()).toBe("2026-03-19T00:00:00.000Z");

    // ⚠️ Overdue is strictly before NOW, not before midnight. A follow-up
    // due at 10am is overdue at 11am, not tomorrow.
    const overdue = resolveDateWindow("overdue", now)!;
    expect(overdue.from).toBeNull();
    expect(overdue.until?.toISOString()).toBe(now.toISOString());

    const last30 = resolveDateWindow("last_30_days", now)!;
    expect(last30.from?.toISOString()).toBe("2026-02-17T00:00:00.000Z");

    /* And the whole thing runs. Two leads get a follow-up date: one in
       the past, one in the future. */
    const overdueLead = await makeLead(tenantA, "LEAD-A6", {
      name: "Overdue Follow-up",
      followUpAt: "2026-03-10T09:00:00.000Z",
      ownerId: alice,
    });
    const futureLead = await makeLead(tenantA, "LEAD-A7", {
      name: "Future Follow-up",
      followUpAt: "2026-04-10T09:00:00.000Z",
      ownerId: alice,
    });

    const filter: FilterGroup = {
      type: "group",
      match: "all",
      children: [
        { type: "condition", field: "next_follow_up_at", operator: "overdue" },
      ],
    };

    const where = compileWhere(scopeFor(tenantA, null), lead, filter, { now });
    const { text, params } = renderTokens(where.tokens);

    const rows = await asTenant(tenantA, async (c) => {
      const result = await c.query(`SELECT reference FROM leads WHERE ${text}`, params);
      return result.rows.map((r) => r.reference as string);
    });

    expect(rows).toEqual(["LEAD-A6"]);

    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [
        [overdueLead, futureLead],
      ]);
    });
  });

  it("soft-deleted rows never appear, and the scope clause says so", async () => {
    const compiled = compileWhere(scopeFor(tenantA, null), lead, emptyFilter(), {
      now: new Date(),
    });
    const { text } = renderTokens(compiled.tokens);
    expect(text).toContain('"deleted_at" IS NULL');

    // Bookings have no `deleted_at` — Phase 22 cancels a booking rather
    // than deleting it — so claiming soft-delete there would make every
    // query fail.
    const bookingWhere = compileWhere(scopeFor(tenantA, null), booking, emptyFilter(), {
      now: new Date(),
    });
    expect(renderTokens(bookingWhere.tokens).text).not.toContain("deleted_at");
  });
});

/* ================================================================== */
/* 6. THE REGISTRY IS DERIVED, NOT TYPED OUT                           */
/* ================================================================== */

describe("saved views — the registry tracks the real schema", () => {
  it("picks up every column of the real table except the hidden ones", () => {
    // A column added to `leads` is filterable the day it exists. The
    // check that matters is the negative one: the isolation boundary is
    // never a field.
    expect(resolveField(lead, "locality")).not.toBeNull();
    expect(resolveField(lead, "cp_locked_until")).not.toBeNull();
    expect(resolveField(lead, "tenant_id")).toBeNull();
    expect(resolveField(lead, "deleted_by")).toBeNull();
  });

  it("infers money, enum and date kinds from the schema rather than a list", () => {
    expect(resolveField(lead, "budget_min_minor")?.kind).toBe("money");
    expect(resolveField(lead, "status")?.kind).toBe("enum");
    expect(resolveField(lead, "status")?.enumValues).toContain("negotiation");
    expect(resolveField(lead, "next_follow_up_at")?.kind).toBe("date");
    expect(resolveField(lead, "is_nri")?.kind).toBe("boolean");
    expect(resolveField(lead, "custom_fields")?.kind).toBe("json");
    // A jsonb column is describable and filterable by nothing.
    expect(resolveField(lead, "custom_fields")?.filterable).toBe(false);
  });

  it("refuses to group by anything that would produce thousands of columns", () => {
    expect(() => resolveGroupBy(lead, "name")).toThrow(/cannot be used as board columns/i);
    expect(resolveGroupBy(lead, "status").name).toBe("status");
    expect(resolveGroupBy(lead, "is_nri").name).toBe("is_nri");
    expect(resolveGroupBy(lead, "owner_id").name).toBe("owner_id");
  });

  it("refuses an operator that does not fit the field", () => {
    const verdict = validateDefinition(lead, {
      name: "Bad",
      viewType: "table",
      filter: {
        type: "group",
        match: "all",
        children: [
          // `contains` on a uuid is a full scan AND an existence oracle.
          { type: "condition", field: "owner_id", operator: "contains", value: "a" },
        ],
      },
      sorts: [],
      columns: [],
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problems[0]!.message).toMatch(/cannot be used on/i);
    }
  });

  it("refuses an enum value the column has never heard of", () => {
    // ⚠️ Not an injection defence — the operand is bound whatever it says.
    // A correctness one: `status = 'Qualified'` matches nothing, errors
    // nowhere, and the author concludes they have no qualified leads.
    const problems = validateFilter(lead, {
      type: "group",
      match: "all",
      children: [
        { type: "condition", field: "status", operator: "eq", value: "Qualified" },
      ],
    });
    expect(problems.length).toBe(1);
    expect(problems[0]!.message).toMatch(/Choose one of/);
  });

  it("refuses an operand that would coerce to the wrong thing", () => {
    // `Number("")` is 0 and `new Date("")` is Invalid Date. Both would
    // otherwise reach a bound parameter and silently match wrong rows.
    expect(coerceOperand("number", "").ok).toBe(false);
    expect(coerceOperand("number", null).ok).toBe(false);
    expect(coerceOperand("date", "not a date").ok).toBe(false);
    expect(coerceOperand("uuid", "abc").ok).toBe(false);
    // ⚠️ Money stays a STRING. Past 2^53 a JavaScript number has already
    // lost its last digits before anything can bind it.
    const money = coerceOperand("money", "87456330000000000");
    expect(money.ok && money.value).toBe("87456330000000000");
  });
});
