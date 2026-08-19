/**
 * Ordence — ⭐⭐⭐ A RESERVED NAME MUST MEAN A DIFFERENT ADDRESS,
 *                 NEVER "NO WORKSPACE"
 * Version: v1.64.1-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PRODUCTION DEFECT THIS FILE PINS
 * ══════════════════════════════════════════════════════════════════════
 * `app/api/webhooks/clerk/_webhook.ts` is the ONLY path that creates a
 * `tenants` row for a real signup. It derived one slug from the Clerk
 * organisation and inserted it, handling exactly one conflict — a
 * duplicate `clerk_org_id`. Migration 0091 installs a BEFORE INSERT
 * trigger that refuses reserved names and two unique indexes that refuse
 * exact and confusable collisions. So for any company whose name
 * normalises onto one of ~71 reserved words, or onto a name another
 * tenant already holds, the insert raised, the transaction aborted,
 * `withPlatformScope` threw, the handler returned 500, and the customer
 * looked at "your workspace is not ready yet" forever. Every Svix retry
 * did the same thing, because the input never changed.
 *
 * The founder hit it with a Clerk organisation slugged `ordence`.
 *
 * ⭐ THE HEADLINE TEST is "Support" — reserved, and therefore a company
 *    name that could never sign up. It must come out the other side with
 *    a WORKING WORKSPACE on a different, valid address.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS DRIVES, AND WHAT IT THEREFORE DOES NOT PROVE
 * ══════════════════════════════════════════════════════════════════════
 * It drives the REAL `POST` handler end to end — real dispatch, real
 * `organizationUpsert`, real `claimSlugWithFallback`, real `claimSlug`,
 * real `lib/slug.ts` — against a FAKE transaction handle that answers the
 * way 0091 answers. The `ui` vitest project has no database by design and
 * a skip-capable test is how a test quietly stops running.
 *
 * ⭐ THE FAKE'S BEHAVIOURS ARE NOT INVENTED. They are the ones
 *    `tests/ui/slug-claim-race.test.ts` drilled against a real PostgreSQL
 *    16 with 0091 applied verbatim, plus the one property that matters
 *    most here and is easy to forget:
 *
 *      🔴 A FAILED STATEMENT POISONS THE WHOLE TRANSACTION. Every later
 *         statement raises 25P02 until a ROLLBACK TO SAVEPOINT. The fake
 *         enforces that, which is what makes these tests able to tell a
 *         retry loop that works from one that merely looks like it does.
 *
 * ⚠️ NOT PROVED HERE: that PostgreSQL serialises two concurrent inserts;
 *    that the deployed schema really carries 0091's constraints; the
 *    behaviour of the Svix signature check (mocked away — it has its own
 *    coverage and is not what broke).
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ASSERTIONS ARE ON PROPERTIES, NEVER ON SHAPES
 * ══════════════════════════════════════════════════════════════════════
 * No test below pins a candidate count, a suffix, an id or a total. What
 * is pinned is: a workspace exists, its address is valid, it is not the
 * refused one, it is the same on redelivery, and an unrecognised fault
 * still reaches the caller. Adding a suffix to `SUGGESTION_SUFFIXES` must
 * not fail a single one of these.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/* ------------------------------------------------------------------ */
/* THE SEAMS                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Svix is mocked to a pass-through. The signature check is not what
 *    broke and standing up a real signing secret here would only test
 *    Svix. Everything AFTER "signature verified" is real.
 */
vi.mock("svix", () => ({
  Webhook: class {
    verify(raw: string) {
      return JSON.parse(raw);
    }
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) =>
      ({
        "svix-id": "msg_test",
        "svix-timestamp": "1700000000",
        "svix-signature": "v1,test",
      })[name] ?? null,
  }),
}));

vi.mock("@/db", () => ({
  db: {},
  withPlatformScope: vi.fn(),
  withTenant: vi.fn(),
}));

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ CLERK, MOCKED AS A STORE RATHER THAN AS A NO-OP — v1.65.0-alpha
 * ══════════════════════════════════════════════════════════════════════
 * The webhook now writes the GRANTED address back to the Clerk
 * organisation, and it has to: `middleware.ts:1031` compares the hostname
 * label against the session's CLERK `orgSlug`, not against
 * `tenants.slug`. A workspace whose two values differ is answered
 * `/access-denied` on its own address, by `/api/internal/host-moved`,
 * because a LIVE tenant holds the label and the live check deliberately
 * does not redirect.
 *
 * ⚠️ A `vi.fn()` THAT RETURNS UNDEFINED WOULD NOT HAVE CAUGHT THAT. The
 *    fake keeps the slug it was given, so the tests below can assert what
 *    Clerk ends up holding — which is the value the routing gate reads.
 */
const clerkWorld = vi.hoisted(() => ({
  orgs: new Map<string, { slug: string | null }>(),
  updates: [] as Array<{ organizationId: string; slug: string }>,
  /** Set to make the next update refuse, the way a taken slug would. */
  refuseUpdateWith: null as Error | null,
  /** Set to make Clerk unreachable, the way an outage would. */
  unreachable: false,
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => {
    if (clerkWorld.unreachable) throw new Error("simulated Clerk outage");
    return {
      organizations: {
        async getOrganization({ organizationId }: { organizationId: string }) {
          const org = clerkWorld.orgs.get(organizationId);
          if (!org) throw new Error(`no such organization ${organizationId}`);
          return org;
        },
        async updateOrganization(organizationId: string, params: { slug: string }) {
          if (clerkWorld.refuseUpdateWith) throw clerkWorld.refuseUpdateWith;
          clerkWorld.orgs.set(organizationId, { slug: params.slug });
          clerkWorld.updates.push({ organizationId, slug: params.slug });
          return { id: organizationId, slug: params.slug };
        },
      },
    };
  },
}));

/**
 * ⚠️ SPIED, NOT EXERCISED. `createNotification` opens its own tenant
 *    transaction, reads the recipient list and may send email — all of
 *    which have their own coverage. What THIS file is entitled to assert
 *    is that the webhook tells somebody when a live address moves, and
 *    tells nobody when it does not.
 */
const notified = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/notifications/create", () => ({
  createNotification: async (input: Record<string, unknown>) => {
    notified.calls.push(input);
    return { ok: true as const, id: "ntf_test" };
  },
}));

import { withPlatformScope, withTenant } from "@/db";
import { tenants, auditLogs } from "@/db/schema";
import { tenantSlugHistory } from "@/db/schema/slugs";
import { RESERVED_SLUGS, checkSlugShape, foldSlug } from "@/lib/slug";
import { planSlugCandidates } from "@/lib/slug-resolution";
import { POST } from "@/app/api/webhooks/clerk/_webhook";

const dialect = new PgDialect();

/* ================================================================== */
/* A TRANSACTION THAT ANSWERS THE WAY 0091 ANSWERS                     */
/* ================================================================== */

class PgError extends Error {
  code: string;
  constraint?: string;
  constructor(code: string, constraint?: string) {
    super(`simulated ${code}`);
    this.code = code;
    this.constraint = constraint;
  }
}

/** Drizzle wraps driver errors; the real `pg` error is the `cause`. */
class WrappedError extends Error {
  constructor(public cause: unknown) {
    super("Failed query");
  }
}

type TenantRow = {
  id: string;
  clerkOrgId: string;
  slug: string;
  name: string;
  settings: Record<string, unknown>;
  branding: Record<string, unknown>;
  deletedAt: Date | null;
  status: string;
};

type HistoryRow = {
  tenantId: string;
  slug: string;
  slugFold: string;
  releasedAt: string | null;
  releaseReason: string | null;
};

type AuditRow = {
  tenantId: string;
  action: string;
  newValue: Record<string, unknown> | null;
  oldValue: Record<string, unknown> | null;
  reason: string | null;
};

type World = {
  tenants: TenantRow[];
  history: HistoryRow[];
  audits: AuditRow[];
  /** Mirrors the `reserved_slugs` TABLE, which is the real enforcer. */
  reserved: Set<string>;
  /** Released inside the 365-day retention window: slug -> fold. */
  released: Map<string, string>;
  /** Every statement issued, in order. */
  statements: string[];
  /** Raised by the next INSERT INTO tenants, once. */
  failInsertOnce: PgError | null;
  nextId: number;
};

function newWorld(overrides: Partial<World> = {}): World {
  return {
    tenants: [],
    history: [],
    audits: [],
    reserved: new Set(RESERVED_SLUGS),
    released: new Map(),
    statements: [],
    failInsertOnce: null,
    nextId: 1,
    ...overrides,
  };
}

/** Seed a tenant that already holds an address. */
function seedTenant(world: World, slug: string, name = slug): TenantRow {
  const row: TenantRow = {
    id: `00000000-0000-0000-0000-${String(world.nextId).padStart(12, "0")}`,
    clerkOrgId: `org_seed_${world.nextId}`,
    slug,
    name,
    settings: {},
    branding: {},
    deletedAt: null,
    status: "active",
  };
  world.nextId += 1;
  world.tenants.push(row);
  return row;
}

/**
 * Read a column out of a rendered INSERT by NAME, not by parameter
 * position — `'active'` sits in the VALUES list as a literal with no
 * parameter of its own, so counting either list alone gets it wrong.
 */
function boundValue(text: string, params: unknown[], column: string): string {
  const lists =
    /INSERT INTO tenants\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/i.exec(text);
  if (!lists) throw new Error(`cannot read the column list out of: ${text.slice(0, 90)}`);
  const columns = lists[1].split(",").map((c) => c.trim());
  const values = lists[2].split(",").map((v) => v.trim());
  const at = columns.indexOf(column);
  if (at === -1) throw new Error(`no ${column} column in the INSERT`);
  const placeholder = /^\$(\d+)/.exec(values[at]);
  if (!placeholder) throw new Error(`${column} is not bound to a parameter`);
  return String(params[Number(placeholder[1]) - 1]);
}

/** Snapshot enough state that ROLLBACK TO SAVEPOINT can be honest. */
type Snapshot = { tenants: TenantRow[]; history: HistoryRow[] };
const snapshot = (w: World): Snapshot => ({
  tenants: w.tenants.map((t) => ({ ...t, settings: { ...t.settings }, branding: { ...t.branding } })),
  history: w.history.map((h) => ({ ...h })),
});

function makeTx(world: World) {
  /**
   * 🔴 THE POISON FLAG IS THE POINT OF THIS FAKE.
   *
   * In PostgreSQL a failed statement puts the transaction into the
   * aborted state and every subsequent statement fails with 25P02 until a
   * rollback. A "retry the next candidate" loop written without a
   * savepoint therefore does not merely retry badly — its second attempt
   * dies with an error that has nothing to do with slugs. Without this
   * flag the fake would happily let such a loop pass.
   */
  let aborted = false;
  const savepoints: Snapshot[] = [];

  const raise = (error: PgError): never => {
    aborted = true;
    throw new WrappedError(error);
  };

  const guardAborted = () => {
    if (aborted) throw new WrappedError(new PgError("25P02"));
  };

  /** The BEFORE INSERT OR UPDATE OF slug trigger, in 0091's order. */
  const runGuard = (slug: string, selfId: string | null) => {
    const fold = foldSlug(slug);
    if (world.reserved.has(slug)) raise(new PgError("P0091"));
    if (world.released.has(slug)) raise(new PgError("P0092"));
    if ([...world.released.values()].includes(fold)) raise(new PgError("P0093"));
    return fold;
  };

  const tx = {
    async execute(query: SQL) {
      const { sql: raw, params } = dialect.sqlToQuery(query);
      const text = raw.replace(/\s+/g, " ").trim();
      world.statements.push(text);

      /* --- transaction control ---------------------------------- */
      if (/^SAVEPOINT /i.test(text)) {
        guardAborted();
        savepoints.push(snapshot(world));
        return [];
      }
      if (/^ROLLBACK TO SAVEPOINT /i.test(text)) {
        const restored = savepoints[savepoints.length - 1];
        if (!restored) throw new Error("ROLLBACK TO a savepoint that was never taken");
        world.tenants = restored.tenants;
        world.history = restored.history;
        aborted = false;
        return [];
      }
      if (/^RELEASE SAVEPOINT /i.test(text)) {
        savepoints.pop();
        return [];
      }

      guardAborted();

      /* --- the two statements the claim issues ------------------- */
      const isInsert = /^INSERT INTO tenants\b/i.test(text);
      const renamed = /^UPDATE tenants SET slug = \$(\d+)/i.exec(text);
      if (!isInsert && !renamed) {
        throw new Error(`the fake does not know this statement: ${text}`);
      }

      if (isInsert && world.failInsertOnce) {
        const err = world.failInsertOnce;
        world.failInsertOnce = null;
        raise(err);
      }

      if (isInsert) {
        const slug = boundValue(text, params, "slug");
        const clerkOrgId = boundValue(text, params, "clerk_org_id");
        const name = boundValue(text, params, "name");
        const fold = runGuard(slug, null);

        /*
         * ON CONFLICT (slug) DO NOTHING: no error, no row. Drilled
         * against PostgreSQL 16 — the arbiter still wins even when the
         * fold ALSO collides.
         */
        if (world.tenants.some((t) => t.slug === slug)) return [];
        if (world.tenants.some((t) => foldSlug(t.slug) === fold)) {
          raise(new PgError("23505", "tenants_slug_fold_unique"));
        }
        if (world.tenants.some((t) => t.clerkOrgId === clerkOrgId)) {
          raise(new PgError("23505", "tenants_clerk_org_unique"));
        }

        const id = `00000000-0000-0000-0000-${String(world.nextId).padStart(12, "0")}`;
        world.nextId += 1;
        world.tenants.push({
          id,
          clerkOrgId,
          slug,
          name,
          settings: {},
          branding: {},
          deletedAt: null,
          status: "active",
        });
        return [{ id }];
      }

      /* --- the rename ------------------------------------------- */
      const slug = String(params[Number(renamed![1]) - 1]);
      const idParam = /WHERE id = \$(\d+)/i.exec(text);
      const tenantId = idParam ? String(params[Number(idParam[1]) - 1]) : "";
      const row = world.tenants.find((t) => t.id === tenantId);
      if (!row) throw new Error(`rename of unknown tenant ${tenantId}`);

      const fold = runGuard(slug, tenantId);
      // No ON CONFLICT on an UPDATE — a collision is a plain 23505.
      if (world.tenants.some((t) => t.id !== tenantId && t.slug === slug)) {
        raise(new PgError("23505", "tenants_slug_unique"));
      }
      if (world.tenants.some((t) => t.id !== tenantId && foldSlug(t.slug) === fold)) {
        raise(new PgError("23505", "tenants_slug_fold_unique"));
      }
      row.slug = slug;
      return [{ id: tenantId }];
    },

    query: {
      tenants: {
        async findFirst(config: { where: SQL }) {
          guardAborted();
          const { params } = dialect.sqlToQuery(config.where);
          const clerkOrgId = String(params[0]);
          return world.tenants.find((t) => t.clerkOrgId === clerkOrgId) ?? null;
        },
      },
    },

    insert(table: unknown) {
      return {
        async values(row: Record<string, unknown>) {
          guardAborted();
          if (table === tenantSlugHistory) {
            world.history.push({
              tenantId: String(row.tenantId),
              slug: String(row.slug),
              slugFold: String(row.slugFold),
              releasedAt: null,
              releaseReason: null,
            });
            return;
          }
          throw new Error("the fake does not know this insert target");
        },
      };
    },

    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where(condition: SQL) {
              guardAborted();
              const { params } = dialect.sqlToQuery(condition);
              const id = String(params[0]);

              if (table === tenants) {
                const row = world.tenants.find((t) => t.id === id);
                if (!row) return;
                if (values.name !== undefined) row.name = String(values.name);
                if (values.settings !== undefined) {
                  row.settings = values.settings as Record<string, unknown>;
                }
                if (values.branding !== undefined) {
                  row.branding = values.branding as Record<string, unknown>;
                }
                if (values.deletedAt === null) row.deletedAt = null;
                if (values.status !== undefined) row.status = String(values.status);
                return;
              }

              if (table === tenantSlugHistory) {
                for (const h of world.history) {
                  if (h.tenantId === id && h.releasedAt === null) {
                    h.releasedAt = new Date().toISOString();
                    h.releaseReason = String(values.releaseReason ?? "");
                  }
                }
                return;
              }

              throw new Error("the fake does not know this update target");
            },
          };
        },
      };
    },
  };

  return tx;
}

/** The audit handle — a SEPARATE transaction, opened after the first commits. */
function makeAuditTx(world: World, tenantId: string) {
  return {
    insert(table: unknown) {
      return {
        async values(row: Record<string, unknown>) {
          if (table !== auditLogs) throw new Error("unexpected audit target");
          world.audits.push({
            tenantId,
            action: String(row.action),
            newValue: (row.newValue ?? null) as Record<string, unknown> | null,
            oldValue: (row.oldValue ?? null) as Record<string, unknown> | null,
            reason: (row.reason ?? null) as string | null,
          });
        },
      };
    },
  };
}

/* ================================================================== */
/* DELIVERING AN EVENT                                                 */
/* ================================================================== */

let world: World;

beforeEach(() => {
  world = newWorld();
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_test";

  clerkWorld.orgs.clear();
  clerkWorld.updates.length = 0;
  clerkWorld.refuseUpdateWith = null;
  clerkWorld.unreachable = false;
  notified.calls.length = 0;

  vi.mocked(withPlatformScope).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (_reason: string, cb: (tx: any) => Promise<unknown>) => cb(makeTx(world))) as any,
  );
  vi.mocked(withTenant).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (tenantId: string, cb: (tx: any) => Promise<unknown>) =>
      cb(makeAuditTx(world, tenantId))) as any,
  );
});

type OrgPayload = { id: string; name: string; slug: string | null; image_url?: string };

function deliver(
  type: "organization.created" | "organization.updated",
  org: OrgPayload,
): Promise<Response> {
  /*
   * ⚠️ THE FAKE CLERK IS SEEDED FROM THE PAYLOAD. A delivery describes an
   *    organisation that exists in Clerk with that slug; without this the
   *    reconciliation would read an organisation that is not there and the
   *    tests would be measuring the mock rather than the code.
   */
  clerkWorld.orgs.set(org.id, { slug: org.slug });
  return POST(
    new Request("https://app.ordence.com/api/webhooks/clerk", {
      method: "POST",
      body: JSON.stringify({ type, data: org }),
    }),
  );
}

const workspaceFor = (orgId: string) => world.tenants.find((t) => t.clerkOrgId === orgId);

/* ================================================================== */
/* 1. ⭐⭐⭐ THE HEADLINE                                              */
/* ================================================================== */

describe("🔴 a company whose name is a reserved word still gets a workspace", () => {
  it('⭐⭐⭐ "Support" — reserved — is provisioned on a DIFFERENT, VALID address', async () => {
    const response = await deliver("organization.created", {
      id: "org_support_1",
      name: "Support",
      slug: "support",
    });

    expect(response.status, "the signup must not fail").toBe(200);

    const workspace = workspaceFor("org_support_1");
    expect(workspace, "a workspace must exist — this is the whole defect").toBeDefined();

    /*
     * ⚠️ THE INVARIANTS, NOT THE STRING. Which suffix it lands on is
     *    `SUGGESTION_SUFFIXES`' business and may change; that it is legal,
     *    unreserved and NOT the refused name is the contract.
     */
    expect(workspace!.slug).not.toBe("support");
    expect(checkSlugShape(workspace!.slug)).toBeNull();
    expect(RESERVED_SLUGS.has(workspace!.slug)).toBe(false);
  });

  it("⭐ the address it was given is the address its history row records", async () => {
    /** A tenant that exists without a history row has an unretainable
     *  hostname the day it is renamed or closed. */
    await deliver("organization.created", { id: "org_support_2", name: "Support", slug: "support" });

    const workspace = workspaceFor("org_support_2")!;
    const open = world.history.filter((h) => h.tenantId === workspace.id && h.releasedAt === null);

    expect(open).toHaveLength(1);
    expect(open[0].slug).toBe(workspace.slug);
    expect(open[0].slugFold).toBe(foldSlug(workspace.slug));
  });

  it("⭐ the refusal is ANSWERABLE — the audit row carries requested AND granted", async () => {
    await deliver("organization.created", { id: "org_support_3", name: "Support", slug: "support" });

    const workspace = workspaceFor("org_support_3")!;
    const created = world.audits.find((a) => a.action === "create");

    expect(created, "creating a workspace must be audited").toBeDefined();
    expect(created!.newValue?.requestedSlug).toBe("support");
    expect(created!.newValue?.slug).toBe(workspace.slug);
    /* The REASON, so support does not have to guess. */
    expect(String(created!.reason)).toContain("support");
    expect(String(created!.reason)).toContain(workspace.slug);
  });

  it("⭐ and the operator console can see it without reading the audit trail", async () => {
    await deliver("organization.created", { id: "org_support_4", name: "Support", slug: "support" });

    const workspace = workspaceFor("org_support_4")!;
    const origin = (workspace.settings as { clerkSlug?: { requested: string; granted: string } })
      .clerkSlug;

    expect(origin).toBeDefined();
    expect(origin!.requested).toBe("support");
    expect(origin!.granted).toBe(workspace.slug);
  });

  it("⚠️ a name nobody reserves is granted UNCHANGED — nothing clever happens", async () => {
    await deliver("organization.created", {
      id: "org_plain",
      name: "Zed Builders",
      slug: "zed-builders",
    });

    expect(workspaceFor("org_plain")!.slug).toBe("zed-builders");
    /* No marker, because there is nothing to explain. */
    expect((workspaceFor("org_plain")!.settings as { clerkSlug?: unknown }).clerkSlug).toBeUndefined();
  });

  it("⭐ a name reserved by the DATABASE but not by lib/slug.ts is also survived", async () => {
    /**
     * 🔴 THIS IS THE ONE THAT PROVES THE RETRY LOOP RATHER THAN THE
     *    ADVISORY SKIP. `reserved_slugs` is the enforcer and it can hold
     *    rows `lib/slug.ts` has not shipped yet — that is exactly how an
     *    emergency reservation is meant to be made. The refusal then
     *    arrives as P0091 from the trigger, aborting the transaction, and
     *    only a savepoint makes the next candidate possible.
     */
    world.reserved.add("northgate");

    const response = await deliver("organization.created", {
      id: "org_northgate",
      name: "Northgate",
      slug: "northgate",
    });

    expect(response.status).toBe(200);
    const workspace = workspaceFor("org_northgate")!;
    expect(workspace.slug).not.toBe("northgate");
    expect(checkSlugShape(workspace.slug)).toBeNull();
    /* It really did ask the database first, and really did recover. */
    expect(world.statements.some((s) => /^ROLLBACK TO SAVEPOINT/i.test(s))).toBe(true);
  });
});

/* ================================================================== */
/* 2. SOMEONE ELSE ALREADY HAS THAT ADDRESS                            */
/* ================================================================== */

describe("🔴 a taken address is a different address, not a failed signup", () => {
  it("⭐ an exact collision still produces a working workspace", async () => {
    seedTenant(world, "zed-builders");

    const response = await deliver("organization.created", {
      id: "org_zed_2",
      name: "Zed Builders",
      slug: "zed-builders",
    });

    expect(response.status).toBe(200);
    const workspace = workspaceFor("org_zed_2")!;
    expect(workspace.slug).not.toBe("zed-builders");
    expect(checkSlugShape(workspace.slug)).toBeNull();
    /* And the incumbent is untouched. */
    expect(world.tenants.filter((t) => t.slug === "zed-builders")).toHaveLength(1);
  });

  it("⭐ a CONFUSABLE collision is handled exactly like a taken one", async () => {
    /**
     * `acme-corp` and `acmecorp` fold onto the same string, so the second
     * is refused by `tenants_slug_fold_unique` rather than by the exact
     * index — a different constraint, a different SQLSTATE path, and
     * historically a different bug. The customer must not be able to tell.
     */
    seedTenant(world, "acme-corp");

    const response = await deliver("organization.created", {
      id: "org_acme_2",
      name: "Acmecorp",
      slug: "acmecorp",
    });

    expect(response.status).toBe(200);
    const workspace = workspaceFor("org_acme_2")!;
    expect(workspace.slug).not.toBe("acmecorp");
    /* ⭐ THE REAL INVARIANT: it did not merely get A name, it got one that
     *    does not fold onto anybody else's. */
    const folds = world.tenants.map((t) => foldSlug(t.slug));
    expect(new Set(folds).size).toBe(folds.length);
  });

  it("⭐ a name inside the 365-day retention window is also stepped over", async () => {
    world.released.set("oldname", foldSlug("oldname"));

    const response = await deliver("organization.created", {
      id: "org_old",
      name: "Oldname",
      slug: "oldname",
    });

    expect(response.status).toBe(200);
    expect(workspaceFor("org_old")!.slug).not.toBe("oldname");
  });
});

/* ================================================================== */
/* 3. SVIX DELIVERS AT LEAST ONCE                                      */
/* ================================================================== */

describe("🔴 redelivery converges — it does not mint a second workspace", () => {
  it("⭐⭐ the same event twice: ONE tenant row, and the SAME address", async () => {
    const org: OrgPayload = { id: "org_twice", name: "Support", slug: "support" };

    await deliver("organization.created", org);
    const first = workspaceFor("org_twice")!.slug;

    await deliver("organization.created", org);

    expect(world.tenants.filter((t) => t.clerkOrgId === "org_twice")).toHaveLength(1);
    expect(workspaceFor("org_twice")!.slug).toBe(first);
  });

  it("⭐ and it converges for a name that was TAKEN, not merely reserved", async () => {
    seedTenant(world, "zed-builders");
    const org: OrgPayload = { id: "org_zed_3", name: "Zed Builders", slug: "zed-builders" };

    await deliver("organization.created", org);
    const first = workspaceFor("org_zed_3")!.slug;
    await deliver("organization.created", org);
    await deliver("organization.updated", org);

    expect(world.tenants.filter((t) => t.clerkOrgId === "org_zed_3")).toHaveLength(1);
    expect(workspaceFor("org_zed_3")!.slug).toBe(first);
  });

  it("🔴 the candidate order carries NO CLOCK AND NO RANDOMNESS", async () => {
    /**
     * ⚠️ THE PROPERTY, NOT THE LIST. Two independent worlds handed the
     *    same organisation must land on the same address. A `Date.now()`
     *    or a random suffix anywhere in the chain breaks this and nothing
     *    else in the suite would notice — `normaliseSlug` used to end in
     *    `org-${Date.now().toString(36)}` for exactly this input.
     */
    const org: OrgPayload = { id: "org_determinism", name: "!!!", slug: null };

    await deliver("organization.created", org);
    const a = workspaceFor("org_determinism")!.slug;

    world = newWorld();
    await deliver("organization.created", org);
    const b = workspaceFor("org_determinism")!.slug;

    expect(a).toBe(b);
    expect(checkSlugShape(a)).toBeNull();
  });
});

/* ================================================================== */
/* 4. 🔴 WHAT MUST STILL BREAK                                         */
/* ================================================================== */

describe("🔴 a fault that is not a slug refusal still propagates, and still 500s", () => {
  it("⭐⭐ a NOT NULL violation is NOT swallowed and NOT retried", async () => {
    /**
     * 🔴 THIS IS THE TEST THAT STOPS THE FIX BECOMING A WORSE BUG.
     *
     * Catching everything would turn a real fault into a cheerful 200 and
     * a workspace on a name nobody asked for — silent data loss, which is
     * worse than the 500 this change removes. `rejectionFromPgError()`
     * recognises P0091/P0092/P0093/23505/23514 and returns null for
     * everything else; only the recognised ones may be retried.
     */
    world.failInsertOnce = new PgError("23502", "tenants_name_not_null");

    const response = await deliver("organization.created", {
      id: "org_broken",
      name: "Broken",
      slug: "broken",
    });

    expect(response.status, "Svix must retry a real fault").toBe(500);
    expect(workspaceFor("org_broken")).toBeUndefined();
    expect(world.history).toHaveLength(0);

    /* ⭐ AND IT STOPPED AT THE FIRST ATTEMPT. A loop that pressed on
     *    would have hidden the fault behind a second candidate. */
    expect(world.statements.filter((s) => /^INSERT INTO tenants/i.test(s))).toHaveLength(1);
  });

  it("⭐ a connection failure also 500s rather than inventing an address", async () => {
    world.failInsertOnce = new PgError("08006");

    const response = await deliver("organization.created", {
      id: "org_down",
      name: "Downtime",
      slug: "downtime",
    });

    expect(response.status).toBe(500);
    expect(world.tenants).toHaveLength(0);
  });

  it("⭐ and no audit row is written for a workspace that was never created", async () => {
    world.failInsertOnce = new PgError("23502", "tenants_name_not_null");
    await deliver("organization.created", { id: "org_noaudit", name: "Nope", slug: "nope" });
    expect(world.audits).toHaveLength(0);
  });
});

/* ================================================================== */
/* 5. 🔴 THE UPDATE PATH IS DELIBERATELY NOT THE SAME FIX              */
/* ================================================================== */

describe("🔴 a refused RENAME leaves the live address alone", () => {
  it("⭐⭐ the workspace keeps its address and the NAME still updates", async () => {
    /**
     * 🔴 NO FALLBACK HERE, AND THAT IS THE DESIGN. The workspace is live:
     *    its hostname is in bookmarks, in emailed invoice links and in a
     *    certificate published in the CT log. Diverting it to a name
     *    nobody chose — and burning the old one for 365 days under 0091's
     *    retention — is worse than declining the rename.
     */
    await deliver("organization.created", {
      id: "org_rename",
      name: "Northgate Projects",
      slug: "northgate-projects",
    });
    const before = workspaceFor("org_rename")!.slug;

    const response = await deliver("organization.updated", {
      id: "org_rename",
      name: "Northgate Projects Pvt Ltd",
      slug: "billing", // reserved
    });

    expect(response.status).toBe(200);
    const after = workspaceFor("org_rename")!;
    expect(after.slug, "the live hostname must not move").toBe(before);
    expect(after.name, "the name update must still land").toBe("Northgate Projects Pvt Ltd");
  });

  it("⭐ a refused rename does NOT burn the old address's retention", async () => {
    /** Closing the open history row would put the workspace's OWN current
     *  hostname inside the 365-day retention set while it is still on it. */
    await deliver("organization.created", { id: "org_ret", name: "Harbour", slug: "harbour" });
    await deliver("organization.updated", { id: "org_ret", name: "Harbour", slug: "admin" });

    const workspace = workspaceFor("org_ret")!;
    const open = world.history.filter((h) => h.tenantId === workspace.id && h.releasedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].slug).toBe(workspace.slug);
    expect(world.history.filter((h) => h.releasedAt !== null)).toHaveLength(0);
  });

  it("⭐ the refusal is recorded — requested, granted and why", async () => {
    await deliver("organization.created", { id: "org_rec", name: "Harbour", slug: "harbour" });
    world.audits.length = 0;

    await deliver("organization.updated", { id: "org_rec", name: "Harbour", slug: "gst" });

    const entry = world.audits.find((a) => a.action === "update");
    expect(entry).toBeDefined();
    expect(entry!.newValue?.requestedSlug).toBe("gst");
    expect(entry!.newValue?.slug).toBe("harbour");
    expect(String(entry!.reason)).toContain("gst");

    const origin = (workspaceFor("org_rec")!.settings as {
      clerkSlug?: { requested: string; granted: string };
    }).clerkSlug;
    expect(origin!.requested).toBe("gst");
    expect(origin!.granted).toBe("harbour");
  });

  it("⭐ a rename onto a name ANOTHER tenant holds is refused the same way", async () => {
    seedTenant(world, "acme-corp");
    await deliver("organization.created", { id: "org_clash", name: "Harbour", slug: "harbour" });

    const response = await deliver("organization.updated", {
      id: "org_clash",
      name: "Harbour",
      slug: "acme-corp",
    });

    expect(response.status).toBe(200);
    expect(workspaceFor("org_clash")!.slug).toBe("harbour");
    /* ⭐ AND NOT DIVERTED ANYWHERE ELSE EITHER. */
    expect(world.tenants.filter((t) => t.slug === "acme-corp")).toHaveLength(1);
  });

  it("⚠️ a rename that IS available still happens, and retires the old address", async () => {
    /** The fix must not have quietly disabled renaming. */
    await deliver("organization.created", { id: "org_ok", name: "Harbour", slug: "harbour" });
    const response = await deliver("organization.updated", {
      id: "org_ok",
      name: "Harbour Works",
      slug: "harbour-works",
    });

    expect(response.status).toBe(200);
    const workspace = workspaceFor("org_ok")!;
    expect(workspace.slug).toBe("harbour-works");

    /* ⭐ THE OLD ADDRESS ENTERS RETENTION. Without this the previous
     *    hostname is free for another company while it is still live in
     *    somebody's bookmarks and in the CT log. */
    const released = world.history.filter((h) => h.releasedAt !== null);
    expect(released.some((h) => h.slug === "harbour")).toBe(true);
    expect(released.every((h) => (h.releaseReason ?? "").length > 0)).toBe(true);

    const open = world.history.filter((h) => h.tenantId === workspace.id && h.releasedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].slug).toBe("harbour-works");
  });

  it("⚠️ an unchanged slug is not a rename and touches nothing", async () => {
    await deliver("organization.created", { id: "org_noop", name: "Harbour", slug: "harbour" });
    const before = world.statements.length;

    await deliver("organization.updated", { id: "org_noop", name: "Harbour Ltd", slug: "harbour" });

    /* No UPDATE ... SET slug was issued at all. */
    expect(
      world.statements.slice(before).filter((s) => /^UPDATE tenants SET slug/i.test(s)),
    ).toHaveLength(0);
    expect(workspaceFor("org_noop")!.name).toBe("Harbour Ltd");
  });
});

/* ================================================================== */
/* 6. THE CANDIDATE ORDER ITSELF                                       */
/* ================================================================== */

describe("the candidate list is a pure function of the ask and the org id", () => {
  const ORG = "org_2p8QkZ3aBcDeF9gH";

  it("⭐ the requested address comes FIRST when it is plausible", () => {
    /** A customer called Acme gets `acme`. Everything else in this
     *  subsystem only matters on the day that is impossible. */
    expect(planSlugCandidates("acme", ORG).candidates[0]).toBe("acme");
  });

  it("⭐ a name lib/slug.ts already calls reserved is skipped, WITH ITS REASON", () => {
    /** ⚠️ The skip is advisory: it decides what is worth ATTEMPTING, never
     *  what is available. The reason travels so the audit row can say it. */
    const plan = planSlugCandidates("ordence", ORG);
    expect(plan.candidates).not.toContain("ordence");
    expect(plan.skipped.some((s) => s.slug === "ordence" && s.code === "reserved")).toBe(true);
  });

  it("⭐ every candidate is legal and unreserved before anything is attempted", () => {
    for (const name of ["ordence", "support", "acme", "a", ""]) {
      for (const candidate of planSlugCandidates(name, ORG).candidates) {
        expect(checkSlugShape(candidate), `${name} produced ${candidate}`).toBeNull();
      }
    }
  });

  it("🔴 the LAST candidate is derived from the org id and is never crowded out", () => {
    /** It is the only candidate that cannot collide with another tenant by
     *  construction, so the attempt limit is applied to everything before
     *  it rather than to it. */
    const plan = planSlugCandidates("ordence", ORG);
    const last = plan.candidates[plan.candidates.length - 1];
    expect(last).toContain("ordence");
    expect(last.endsWith("bcdef9gh"), `${last} must carry the org id tail`).toBe(true);
  });

  it("🔴 a company name that normalises to NOTHING still gets an address", () => {
    /** An organisation named entirely outside [a-z0-9-]. The old code
     *  answered this with `org-${Date.now()}` — a different slug on every
     *  delivery of the same event. */
    const plan = planSlugCandidates("", ORG);
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(checkSlugShape(plan.candidates[0])).toBeNull();
  });

  it("🔴 identical inputs give identical output, every time", () => {
    const a = planSlugCandidates("ordence", ORG).candidates;
    const b = planSlugCandidates("ordence", ORG).candidates;
    expect(a).toEqual(b);
  });

  it("⭐ a DIFFERENT organisation asking for the same name gets a different last resort", () => {
    /** Two companies both called Support must not converge on one address
     *  of last resort — that is a guaranteed collision, not a fallback. */
    const a = planSlugCandidates("support", "org_aaaaaaaaaaaa").candidates;
    const b = planSlugCandidates("support", "org_bbbbbbbbbbbb").candidates;
    expect(a[a.length - 1]).not.toBe(b[b.length - 1]);
  });

  it("⚠️ the attempt count is BOUNDED — a webhook cannot loop", () => {
    /** Not the exact bound: that it is small and finite. */
    const plan = planSlugCandidates("support", ORG);
    expect(plan.candidates.length).toBeGreaterThan(1);
    expect(plan.candidates.length).toBeLessThanOrEqual(12);
  });

  it("⚠️ no candidate exceeds the 63-character DNS label limit", () => {
    const long = "a".repeat(70);
    for (const candidate of planSlugCandidates(long, ORG).candidates) {
      expect(candidate.length).toBeLessThanOrEqual(63);
    }
  });
});

/* ================================================================== */
/* ⭐⭐⭐ THE MIRROR — CLERK MUST HOLD THE ADDRESS WE GRANTED          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS BLOCK EXISTS FOR — v1.65.0-alpha, Brief A
 * ══════════════════════════════════════════════════════════════════════
 * The fallback ladder above works: a company called Support gets a
 * workspace on `support-india`, and the tests above prove it. What none of
 * them asked is whether anybody can REACH it.
 *
 * `middleware.ts:1031` refuses a request whose hostname label differs from
 * the session's CLERK `orgSlug`. Clerk still held `support`. So every
 * member of that workspace, opening the address the product had just
 * granted them, was rewritten to `/api/internal/host-moved`, which found a
 * LIVE tenant on the label — their own — and therefore did NOT redirect,
 * and answered `/access-denied`.
 *
 * ⚠️ SO THE LADDER PRODUCED A WORKSPACE NOBODY COULD ENTER, and every
 *    assertion in this file passed while it did. `settings.clerkSlug` was
 *    written, was displayed in the console, and was enforced by nothing.
 *
 * ⭐ THE PROPERTY, STATED ONCE: after any delivery, the slug Clerk holds
 *    and `tenants.slug` are the same string. Everything below is that
 *    sentence in different circumstances.
 */
describe("🔴 Clerk is made to hold the address the database granted", () => {
  const clerkSlugOf = (orgId: string) => clerkWorld.orgs.get(orgId)?.slug ?? null;

  it("⭐⭐⭐ a DIVERTED provision leaves Clerk holding the granted address", async () => {
    const response = await deliver("organization.created", {
      id: "org_mirror_1",
      name: "Support",
      slug: "support",
    });

    expect(response.status).toBe(200);
    const workspace = workspaceFor("org_mirror_1")!;

    /* The ladder walked — this test is meaningless otherwise. */
    expect(workspace.slug).not.toBe("support");

    expect(
      clerkSlugOf("org_mirror_1"),
      "middleware compares the hostname against THIS value; if it is stale the workspace answers access-denied to its own staff",
    ).toBe(workspace.slug);
  });

  it("⭐ a provision that got the address it asked for writes NOTHING to Clerk", async () => {
    /** The common case must cost no round trip and must fire no second
     *  webhook. A Clerk write per delivery is a loop with a network in it. */
    await deliver("organization.created", {
      id: "org_mirror_2",
      name: "Harbour Works",
      slug: "harbour-works",
    });

    expect(workspaceFor("org_mirror_2")!.slug).toBe("harbour-works");
    expect(clerkWorld.updates).toHaveLength(0);
  });

  it("⭐ a REFUSED rename restores Clerk to the address the workspace kept", async () => {
    await deliver("organization.created", { id: "org_mirror_3", name: "Harbour", slug: "harbour" });
    clerkWorld.updates.length = 0;

    /* Somebody edits the slug in Clerk to a reserved word. */
    const response = await deliver("organization.updated", {
      id: "org_mirror_3",
      name: "Harbour",
      slug: "billing",
    });

    expect(response.status).toBe(200);
    expect(workspaceFor("org_mirror_3")!.slug, "the live address must not move").toBe("harbour");
    expect(
      clerkSlugOf("org_mirror_3"),
      "Clerk kept the refused name, so every member of this workspace is locked out",
    ).toBe("harbour");
  });

  it("⭐ an APPLIED rename needs no Clerk write — the two already agree", async () => {
    await deliver("organization.created", { id: "org_mirror_4", name: "Harbour", slug: "harbour" });
    clerkWorld.updates.length = 0;

    await deliver("organization.updated", {
      id: "org_mirror_4",
      name: "Harbour",
      slug: "harbour-projects",
    });

    expect(workspaceFor("org_mirror_4")!.slug).toBe("harbour-projects");
    expect(clerkWorld.updates).toHaveLength(0);
  });

  it("🔴 Clerk being UNREACHABLE fails the delivery, so Svix retries", async () => {
    /** A transient outage must not leave a permanently unreachable
     *  workspace behind a 200 that says everything is fine. */
    clerkWorld.unreachable = true;

    const response = await deliver("organization.created", {
      id: "org_mirror_5",
      name: "Support",
      slug: "support",
    });

    expect(response.status).toBe(500);
    /* ⭐ AND THE WORKSPACE IS STILL THERE. The row committed; only the
     *    reconciliation failed, and the retry re-attempts exactly that. */
    expect(workspaceFor("org_mirror_5")).toBeDefined();
  });

  it("⚠️ Clerk REFUSING the name does not fail the delivery — a retry cannot succeed", async () => {
    /** Replaying the delivery asks Clerk the same question and gets the
     *  same answer, forever, on Svix's retry schedule. The honest outcome
     *  is a loud log and a 200, not an infinite loop. */
    clerkWorld.refuseUpdateWith = Object.assign(new Error("refused"), {
      errors: [{ code: "duplicate_record", meta: { paramName: "slug" } }],
    });

    const response = await deliver("organization.created", {
      id: "org_mirror_6",
      name: "Support",
      slug: "support",
    });

    expect(response.status).toBe(200);
    expect(workspaceFor("org_mirror_6")).toBeDefined();
  });
});

/* ================================================================== */
/* ⭐⭐ A3 — SOMEBODY IS TOLD WHEN A LIVE ADDRESS MOVES                */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DECISION THIS PINS — Brief A, question A3
 * ══════════════════════════════════════════════════════════════════════
 * `server/platform/rename-slug.ts` argues that a rename must stay an
 * operator act until TWO things exist: ① a 301 from the released host, and
 * ② somebody telling the workspace it happened. ① shipped in v1.57.0.
 * ② is asserted here.
 *
 * ⚠️ THE INTERESTING HALF IS THE SILENCE. `organization.updated` fires for
 *    a logo change and a display-name change, which is most of them.
 *    Notifying on "the update succeeded" rather than on "the address
 *    moved" would email every user in every workspace every time somebody
 *    uploaded a logo — and that is the version a reasonable person writes
 *    first, because `rename.ok` is true in both cases.
 */
describe("⭐⭐ a workspace is told when its address moves, and only then", () => {
  it("⭐ an applied rename notifies EVERY user in the workspace", async () => {
    await deliver("organization.created", { id: "org_note_1", name: "Harbour", slug: "harbour" });
    notified.calls.length = 0;

    await deliver("organization.updated", {
      id: "org_note_1",
      name: "Harbour",
      slug: "harbour-projects",
    });

    expect(notified.calls).toHaveLength(1);
    const notice = notified.calls[0];
    expect(notice.tenantId).toBe(workspaceFor("org_note_1")!.id);
    /* ⚠️ BROADCAST. `userId` absent means every member — the thing that
     *    changed is in every colleague's bookmark bar. */
    expect(notice.userId).toBeUndefined();
    /* ⚠️ The severity is the delivery channel: only critical and warning
     *    are emailed, and an in-app bell is no use to somebody whose
     *    problem is that they cannot reach the app. */
    expect(notice.severity).toBe("critical");
    expect(String(notice.body)).toContain("harbour-projects");
    expect(String(notice.body)).toContain("harbour");
  });

  it("🔴 a logo-only update notifies NOBODY", async () => {
    await deliver("organization.created", { id: "org_note_2", name: "Harbour", slug: "harbour" });
    notified.calls.length = 0;

    await deliver("organization.updated", {
      id: "org_note_2",
      name: "Harbour Works",
      slug: "harbour",
      image_url: "https://img.example/new.png",
    });

    expect(notified.calls).toHaveLength(0);
  });

  it("🔴 a REFUSED rename notifies nobody — nothing moved", async () => {
    await deliver("organization.created", { id: "org_note_3", name: "Harbour", slug: "harbour" });
    notified.calls.length = 0;

    await deliver("organization.updated", { id: "org_note_3", name: "Harbour", slug: "admin" });

    expect(workspaceFor("org_note_3")!.slug).toBe("harbour");
    expect(notified.calls).toHaveLength(0);
  });

  it("⚠️ a brand-new workspace notifies nobody — it did not MOVE", async () => {
    /** "Your address changed" on the first screen a customer ever sees is
     *  alarming and untrue. */
    await deliver("organization.created", { id: "org_note_4", name: "Support", slug: "support" });
    expect(notified.calls).toHaveLength(0);
  });
});
