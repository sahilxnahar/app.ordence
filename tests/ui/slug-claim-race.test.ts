/**
 * Ordence — ⭐⭐⭐ TWO PEOPLE CLAIM THE SAME SLUG IN THE SAME SECOND
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PRINCIPLE THIS FILE TESTS
 * ══════════════════════════════════════════════════════════════════════
 *       The availability check is advisory.
 *       The unique index is the truth.
 *       The insert is the claim.
 *
 * Two callers pass every advisory check, both are told "free", and both
 * reach the INSERT. Exactly one may win. The other must receive a
 * `taken` REJECTION — an answer — and not an unhandled 500, because a
 * signup that dies with a stack trace at the last step is the same
 * outcome as a duplicate to the person trying to sign up.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHICH CONCURRENCY APPROACH THIS FILE TAKES, AND WHAT IT DOES NOT
 *    COVER. READ THIS BEFORE TRUSTING IT.
 * ══════════════════════════════════════════════════════════════════════
 * This file drives `claimSlug()` with a FAKE TRANSACTION HANDLE that
 * implements the database's answers, not with a live PostgreSQL. The
 * `ui` vitest project runs in jsdom with no database by design, and the
 * database-backed project (`security`) refuses to start without a
 * `.env.test` pointing at a throwaway cluster — a skip-capable test is
 * how a concurrency test quietly stops running, and a test that does not
 * run is more dangerous than one that fails.
 *
 * ⭐ THE FAKE IS NOT INVENTED. Every behaviour it implements was drilled
 *    against a real PostgreSQL 16.13 — a throwaway cluster created by
 *    initdb in /tmp, never Neon — with 0091 applied verbatim:
 *
 *      • two concurrent transactions inserting the same slug with
 *        ON CONFLICT (slug) DO NOTHING RETURNING id: the first returns
 *        one row, the second BLOCKS, then returns ZERO ROWS AND NO
 *        ERROR once the first commits. One tenant row exists afterwards.
 *      • an exact collision on the UPDATE (rename) path, which has no
 *        ON CONFLICT clause: 23505, constraint `tenants_slug_unique`.
 *      • a confusable collision: 23505, `tenants_slug_fold_unique` —
 *        raised even when the statement carries ON CONFLICT (slug),
 *        because that arbiter covers the exact index only.
 *      • when BOTH collide, ON CONFLICT wins and there is no error.
 *      • reserved: P0091. Retention: P0092 exact, P0093 folded.
 *
 * ⚠️ WHAT THIS THEREFORE DOES NOT COVER, and must not be claimed to:
 *      • that PostgreSQL itself serialises the two inserts. That is the
 *        database's guarantee, drilled by hand, not re-proved here.
 *      • row locking, deadlock, statement timeouts, connection loss
 *        mid-claim, or the aborted-transaction state (`25P02`) the
 *        caller is left in after a refusal.
 *      • that the deployed schema actually has the constraints 0091
 *        declares. `tests/ui/slug-contract.test.ts` asserts the file
 *        says so; only running the migration proves the database does.
 *
 * What IS proved here is everything on OUR side of the boundary: that
 * `claimSlug` maps each of those database answers to the right
 * rejection, that the zero-rows path is treated as a refusal rather than
 * as success, that a refusal never writes a history row, and that an
 * error the mapping does not recognise propagates instead of being
 * silently turned into "someone beat you to it".
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { claimSlug, type NewTenantRow } from "@/server/platform/claim-slug";
import { foldSlug, rejectionFromPgError } from "@/lib/slug";

/* ================================================================== */
/* THE FAKE DATABASE                                                   */
/* ================================================================== */

const dialect = new PgDialect();

/** A `pg` error, as the driver actually shapes one. */
class PgError extends Error {
  code: string;
  constraint?: string;
  constructor(code: string, constraint?: string) {
    super(`simulated ${code}`);
    this.code = code;
    this.constraint = constraint;
  }
}

/**
 * ⚠️ DRIZZLE WRAPS DRIVER ERRORS since 0.44: a failing query surfaces as
 * a `DrizzleQueryError` whose `cause` is the real `pg` error. Reading
 * `err.code` off the top-level object finds nothing, and every refusal
 * silently becomes an unexpected 500. The fake throws WRAPPED errors by
 * default for exactly that reason.
 */
class WrappedError extends Error {
  constructor(public cause: unknown) {
    super("Failed query");
  }
}

type Store = {
  /** slug → tenant id. */
  tenants: Map<string, string>;
  /** fold → slug. */
  folds: Map<string, string>;
  /** Reserved names, as `reserved_slugs` would answer. */
  reserved: Set<string>;
  /** Slugs released inside the retention window: slug → fold. */
  released: Map<string, string>;
  history: Array<{ tenantId: string; slug: string; slugFold: string }>;
  /** Every statement the claim actually issued, in order. */
  statements: string[];
  nextId: number;
};

function newStore(overrides: Partial<Store> = {}): Store {
  return {
    tenants: new Map(),
    folds: new Map(),
    reserved: new Set(),
    released: new Map(),
    history: [],
    statements: [],
    nextId: 1,
    ...overrides,
  };
}

/**
 * Map a column name to the parameter it is bound to, by reading the
 * column list and the VALUES list out of the rendered statement.
 *
 * ⚠️ NOT BY PARAMETER POSITION. `$2` is the slug only for as long as
 *    nobody reorders the INSERT, and `'active'` sits in the VALUES list
 *    as a literal with no parameter of its own — so counting either list
 *    alone gets it wrong.
 */
function boundValue(text: string, params: unknown[], column: string): string {
  const lists = /INSERT INTO tenants\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/i.exec(text);
  if (!lists) throw new Error(`cannot read the column list out of: ${text.slice(0, 80)}`);

  const columns = lists[1].split(",").map((c) => c.trim());
  const values = lists[2].split(",").map((v) => v.trim());
  const at = columns.indexOf(column);
  if (at === -1) throw new Error(`no ${column} column in the INSERT`);

  const placeholder = /^\$(\d+)/.exec(values[at]);
  if (!placeholder) throw new Error(`${column} is not bound to a parameter`);
  return String(params[Number(placeholder[1]) - 1]);
}

/**
 * A transaction handle that answers the way 0091 answers.
 *
 * `delayMs` is where the interleave lives: every statement yields before
 * it decides, so two `claimSlug()` calls awaiting concurrently BOTH pass
 * their advisory checks before either mutates anything — which is the
 * race, reproduced rather than described.
 */
function fakeTx(
  store: Store,
  options: { delayMs?: number; failWith?: unknown; wrap?: boolean } = {},
) {
  const wrap = options.wrap ?? true;
  const raise = (error: PgError): never => {
    throw wrap ? new WrappedError(error) : error;
  };

  return {
    async execute(query: SQL) {
      const { sql: text, params } = dialect.sqlToQuery(query);
      store.statements.push(text.replace(/\s+/g, " ").trim());

      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));

      if (options.failWith) throw options.failWith;

      const isInsert = /^\s*INSERT INTO tenants\b/i.test(text);
      const renamed = /UPDATE tenants\s+SET slug = \$(\d+)/i.exec(text);
      if (!isInsert && !renamed) throw new Error(`the fake does not know this statement: ${text}`);

      const slug = isInsert
        ? boundValue(text, params, "slug")
        : String(params[Number(renamed![1]) - 1]);

      const fold = foldSlug(slug);

      /* --- the BEFORE trigger, in its own order ------------------- */
      if (store.reserved.has(slug)) raise(new PgError("P0091"));
      if (store.released.has(slug)) raise(new PgError("P0092"));
      if ([...store.released.values()].includes(fold)) raise(new PgError("P0093"));

      /* --- the indexes -------------------------------------------- */
      if (store.tenants.has(slug)) {
        /**
         * ON CONFLICT (slug) DO NOTHING: no error, no row. Drilled
         * against PostgreSQL 16 — including the case where the fold
         * ALSO collides, where the arbiter still wins and nothing is
         * raised.
         */
        if (/ON CONFLICT \(slug\) DO NOTHING/i.test(text)) return [];
        raise(new PgError("23505", "tenants_slug_unique"));
      }
      if (store.folds.has(fold)) raise(new PgError("23505", "tenants_slug_fold_unique"));

      const id = `00000000-0000-0000-0000-${String(store.nextId).padStart(12, "0")}`;
      store.nextId += 1;
      store.tenants.set(slug, id);
      store.folds.set(fold, slug);
      return [{ id }];
    },

    insert() {
      return {
        async values(row: { tenantId: string; slug: string; slugFold: string }) {
          store.history.push(row);
        },
      };
    },
  };
}

/** `claimSlug`'s handle is a Drizzle transaction; the fake is a stand-in. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asTx = (tx: ReturnType<typeof fakeTx>) => tx as any;

const TENANT: NewTenantRow = {
  clerkOrgId: "pending:acme-corp",
  name: "Acme Corp",
  legalName: "Acme Corp Private Limited",
  planTier: "trial",
  seatLimit: 5,
  storageLimitMb: 1024,
  trialEndsAt: null,
  customDomain: null,
  settings: {},
  branding: {},
};

const claim = (store: Store, slug: string, options?: Parameters<typeof fakeTx>[1]) =>
  claimSlug(asTx(fakeTx(store, options)), { slug, tenant: TENANT, actor: "signup:someone@example.com" });

/* ================================================================== */
/* 1. THE RACE                                                         */
/* ================================================================== */

describe("🔴 two concurrent claims of the same slug", () => {
  it("⭐ EXACTLY ONE WINS", async () => {
    const store = newStore();

    const results = await Promise.all([
      claim(store, "acme-corp"),
      claim(store, "acme-corp"),
    ]);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(store.tenants.size).toBe(1);
  });

  it("⭐ the loser gets a `taken` REJECTION, not an unhandled error", async () => {
    const store = newStore();
    const results = await Promise.all([claim(store, "acme-corp"), claim(store, "acme-corp")]);

    const loser = results.find((r) => !r.ok);
    expect(loser).toBeDefined();
    expect(loser!.ok).toBe(false);
    expect(!loser!.ok && loser!.rejection.code).toBe("taken");
  });

  it("⭐ writes exactly one history row — the claim and its record are one transaction", async () => {
    const store = newStore();
    const results = await Promise.all([claim(store, "acme-corp"), claim(store, "acme-corp")]);

    const winner = results.find((r) => r.ok);
    expect(store.history).toHaveLength(1);
    expect(store.history[0].tenantId).toBe(winner!.ok && winner!.tenantId);
    expect(store.history[0].slug).toBe("acme-corp");
    expect(store.history[0].slugFold).toBe(foldSlug("acme-corp"));
  });

  it("⭐ holds across many interleavings, not just the one this machine happened to produce", async () => {
    /**
     * ⚠️ A single run of a concurrency test proves one schedule. Varying
     *    the delay moves which caller resumes first, which is the only
     *    knob that decides the winner here.
     */
    for (let round = 0; round < 40; round += 1) {
      const store = newStore();
      const results = await Promise.all([
        claim(store, "acme-corp", { delayMs: round % 3 }),
        claim(store, "acme-corp", { delayMs: (round + 1) % 3 }),
        claim(store, "acme-corp", { delayMs: (round + 2) % 3 }),
      ]);

      expect(results.filter((r) => r.ok), `round ${round} produced more than one winner`).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.rejection.code === "taken")).toHaveLength(2);
      expect(store.tenants.size).toBe(1);
      expect(store.history).toHaveLength(1);
    }
  });

  it("⚠️ two DIFFERENT slugs racing both win — the refusal is about collision, not concurrency", async () => {
    const store = newStore();
    const results = await Promise.all([claim(store, "acme-corp"), claim(store, "zed-builders")]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(store.tenants.size).toBe(2);
    expect(store.history).toHaveLength(2);
  });

  it("🔴 two CONFUSABLE slugs racing: one wins, the other is `too_similar`", async () => {
    /**
     * `acme-corp` and `acmecorp` fold together, so the second is refused
     * by `tenants_slug_fold_unique` — with a different code from
     * `taken`, because the two mean different things to the reader.
     */
    const store = newStore();
    const results = await Promise.all([claim(store, "acme-corp"), claim(store, "acmecorp")]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(!loser.ok && loser.rejection.code).toBe("too_similar");
    expect(store.tenants.size).toBe(1);
  });
});

/* ================================================================== */
/* 2. THE TWO WAYS A LOSER FINDS OUT                                   */
/* ================================================================== */

describe("both loser paths are handled, and they are different mechanisms", () => {
  it("⭐ ZERO ROWS FROM ON CONFLICT — a refusal that arrives without an error", async () => {
    /**
     * `ON CONFLICT (slug) DO NOTHING` does not raise. It inserts nothing
     * and returns nothing, and the loser lands on a `null` id. Treating
     * that as success is how a claim silently proceeds without a tenant.
     */
    const store = newStore();
    store.tenants.set("acme-corp", "someone-else");
    store.folds.set(foldSlug("acme-corp"), "acme-corp");

    const result = await claim(store, "acme-corp");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.rejection.code).toBe("taken");
    expect(store.history, "a refused claim must not leave a history row").toHaveLength(0);
  });

  it("⭐ 23505 ON `tenants_slug_unique` — the rename path, which has no ON CONFLICT", async () => {
    const store = newStore();
    const tx = asTx(fakeTx(store));
    tx.execute = async () => {
      throw new WrappedError(new PgError("23505", "tenants_slug_unique"));
    };

    const result = await claimSlug(tx, {
      slug: "acme-corp",
      tenantId: "11111111-1111-1111-1111-111111111111",
      actor: "operator@ordence.com",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.rejection.code).toBe("taken");
    expect(store.history).toHaveLength(0);
  });

  it("⚠️ finds the SQLSTATE through the wrapper Drizzle puts around driver errors", async () => {
    /**
     * Since Drizzle 0.44 the real `pg` error is the `cause`. Reading
     * `err.code` off the top-level object finds nothing and every
     * refusal becomes an unexpected 500.
     */
    const store = newStore();
    const tx = asTx(fakeTx(store));
    tx.execute = async () => {
      throw new WrappedError(new WrappedError(new PgError("23505", "tenants_slug_fold_unique")));
    };

    const result = await claimSlug(tx, { slug: "acmecorp", tenant: TENANT, actor: "signup:a@example.com" });
    expect(!result.ok && result.rejection.code).toBe("too_similar");
  });
});

/* ================================================================== */
/* 3. EVERY DATABASE ANSWER MAPS TO THE RIGHT REJECTION                */
/* ================================================================== */

describe("the database's refusals arrive as answers, and an outage does not", () => {
  it("reserved (P0091) → reserved", async () => {
    const store = newStore({ reserved: new Set(["postmaster"]) });
    const result = await claim(store, "postmaster");
    expect(!result.ok && result.rejection.code).toBe("reserved");
  });

  it("released within retention, exact (P0092) → recently_released", async () => {
    const store = newStore();
    store.released.set("gone-away", foldSlug("gone-away"));
    const result = await claim(store, "gone-away");
    expect(!result.ok && result.rejection.code).toBe("recently_released");
  });

  it("released within retention, folded (P0093) → recently_released", async () => {
    const store = newStore();
    store.released.set("gone-away", foldSlug("gone-away"));
    const result = await claim(store, "goneaway");
    expect(!result.ok && result.rejection.code).toBe("recently_released");
  });

  it("🔴 an unrelated SQLSTATE PROPAGATES — an outage must not be reported as `taken`", async () => {
    /**
     * A caller that cannot tell "someone beat you to it" apart from "the
     * database is down" will report the second as the first, and the
     * user will spend the afternoon inventing new names.
     */
    const store = newStore();
    await expect(claim(store, "acme-corp", { failWith: new WrappedError(new PgError("08006")) })).rejects.toThrow();
    expect(store.history).toHaveLength(0);
  });

  it("🔴 an error with no SQLSTATE at all propagates", async () => {
    const store = newStore();
    await expect(claim(store, "acme-corp", { failWith: new Error("socket hang up") })).rejects.toThrow();
  });

  it("⚠️ the mapping used by the claim path is the one in lib/slug.ts, and it is exhaustive there", () => {
    /** Asserted directly as well, because the claim path is only ever as
     *  correct as this table. */
    expect(rejectionFromPgError("P0091", undefined)?.code).toBe("reserved");
    expect(rejectionFromPgError("P0092", undefined)?.code).toBe("recently_released");
    expect(rejectionFromPgError("P0093", undefined)?.code).toBe("recently_released");
    expect(rejectionFromPgError("23505", "tenants_slug_fold_unique")?.code).toBe("too_similar");
    expect(rejectionFromPgError("23505", "tenants_slug_unique")?.code).toBe("taken");
    expect(rejectionFromPgError("42P01", undefined)).toBeNull();
  });
});

/* ================================================================== */
/* 4. THE STATEMENT ITSELF                                             */
/* ================================================================== */

describe("the claim is the insert", () => {
  it("🔴 uses ON CONFLICT DO NOTHING, not a SELECT-then-INSERT", async () => {
    /**
     * `SELECT ... WHERE NOT EXISTS` followed by an INSERT is the race
     * written out longhand: under READ COMMITTED both concurrent
     * transactions see "free".
     */
    const store = newStore();
    await claim(store, "acme-corp");
    expect(store.statements[0]).toMatch(/INSERT INTO tenants/i);
    expect(store.statements[0]).toMatch(/ON CONFLICT \(slug\) DO NOTHING/i);
    expect(store.statements[0]).toMatch(/RETURNING id/i);
  });

  it("🔴 never names slug_fold in the INSERT — it is GENERATED ALWAYS and naming it fails the statement", async () => {
    const store = newStore();
    await claim(store, "acme-corp");
    expect(store.statements[0]).not.toMatch(/slug_fold/i);
  });

  it("takes one statement to claim — the whole row goes in at once", async () => {
    /** Splitting it into "reserve the slug, then fill in the rest" would
     *  leave a window in which a half-built tenant holds a hostname. */
    const store = newStore();
    await claim(store, "acme-corp");
    expect(store.statements).toHaveLength(1);
  });

  it("normalises the slug before it reaches the statement", async () => {
    /** `tenants_slug_lowercase` is a hard CHECK; "the caller definitely
     *  normalised it" is how the second caller differs from the first. */
    const store = newStore();
    const result = await claim(store, "  ACME-CORP  ");
    expect(result.ok).toBe(true);
    expect([...store.tenants.keys()]).toEqual(["acme-corp"]);
    expect(store.history[0].slug).toBe("acme-corp");
  });

  it("⚠️ writes the history fold with foldSlug(), because that column is NOT generated", async () => {
    const store = newStore();
    await claim(store, "zed-builders");
    expect(store.history[0].slugFold).toBe(foldSlug("zed-builders"));
    expect(store.history[0].slugFold).toBe("zedbuiiders");
  });

  it("refuses to run without an actor — every claim is attributable", async () => {
    const store = newStore();
    await expect(
      claimSlug(asTx(fakeTx(store)), { slug: "acme-corp", tenant: TENANT, actor: "" }),
    ).rejects.toThrow();
    expect(store.statements).toHaveLength(0);
  });

  it("refuses a fresh claim with no tenant row to insert", async () => {
    const store = newStore();
    await expect(
      claimSlug(asTx(fakeTx(store)), { slug: "acme-corp", actor: "signup:a@example.com" }),
    ).rejects.toThrow();
    expect(store.statements).toHaveLength(0);
  });
});
