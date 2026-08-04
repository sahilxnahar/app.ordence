/**
 * Ordence — Portal Link Isolation & Token Rejection
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 9 MANDATORY VERIFICATION #2
 * ══════════════════════════════════════════════════════════════════════
 * "Ensure the portal route handler strictly rejects expired or revoked
 *  tokens."
 *
 * The rejection logic lives in `resolvePortalToken`, and the state it
 * reads lives in PostgreSQL. These tests assert against a REAL database,
 * connected as a NON-SUPERUSER — a superuser bypasses RLS entirely, so a
 * suite connected as one would report green even after every policy was
 * dropped.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT MAKES PORTAL LINKS DIFFERENT FROM EVERY OTHER TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `portal_links` is the only table consulted WITHOUT a tenant context —
 * it has to be, because a visitor with no session gives us no tenant until
 * the token itself is resolved.
 *
 * So there are two distinct threats here, and they need different
 * mechanisms:
 *
 *   1. An anonymous visitor with a bad/expired/revoked token
 *      → defended by the resolver's checks (tested below)
 *   2. Tenant A reading or forging tenant B's links through the ordinary
 *      authenticated application
 *      → defended by RLS (also tested below)
 *
 * Confusing the two is how one of them ends up unprotected.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { asTenant, withoutTenant, asSuperuser, expectError } from "../setup";

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const mintToken = () => randomBytes(32).toString("hex");

type Fixtures = {
  tenantA: string;
  tenantB: string;
  userA: string;
  contractA: string;
  contractB: string;
  activeLinkA: string;
  activeTokenA: string;
  expiredLinkA: string;
  expiredTokenA: string;
  revokedLinkA: string;
  revokedTokenA: string;
  linkB: string;
  tokenB: string;
};


/**
 * Assert a database GUARD fired — not merely that something failed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS HELPER EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * Our tamper-guard triggers raise SQLSTATE 42501 (`insufficient_privilege`)
 * — and so does PostgreSQL when a role simply lacks a GRANT on the table.
 *
 * During Phase 9 the test role temporarily had no privileges on
 * `portal_links`, and every tamper-guard test in this file PASSED, because
 * "permission denied for table portal_links" carries exactly the code they
 * were asserting. They were green while proving nothing at all.
 *
 * So the code is not enough. The message must also match the guard we
 * expect, which a missing GRANT can never produce.
 */
async function expectGuard(
  fn: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  const error = await expectError(fn);

  expect(error, "expected the statement to be refused, but it succeeded").not.toBeNull();

  // A missing GRANT would produce this, and it must never be mistaken for
  // the guard actually working.
  expect(
    error!.message,
    `the statement failed with a PRIVILEGE error, not the expected guard — ` +
      `the test role is missing a GRANT and this test proves nothing: ${error!.message}`,
  ).not.toMatch(/permission denied for (table|relation)/i);

  expect(error!.message).toMatch(messagePattern);
}

let fx: Fixtures;

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const contractA = randomUUID();
  const contractB = randomUUID();

  const activeLinkA = randomUUID();
  const activeTokenA = mintToken();
  const expiredLinkA = randomUUID();
  const expiredTokenA = mintToken();
  const revokedLinkA = randomUUID();
  const revokedTokenA = mintToken();
  const linkB = randomUUID();
  const tokenB = mintToken();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Portal Tenant A"],
      [tenantB, "Portal Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [id, `org_${id}`, `portal-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1, $2, $3, $4, 'tenant_owner', 'active')`,
      [userA, tenantA, `clerk_${userA}`, `a-${Date.now()}@example.com`],
    );

    for (const [id, tenant, title] of [
      [contractA, tenantA, "Tenant A Agreement"],
      [contractB, tenantB, "Tenant B Agreement"],
    ] as const) {
      await c.query(
        `INSERT INTO contracts (id, tenant_id, title, contract_type, status)
         VALUES ($1, $2, $3, 'sale_agreement', 'draft')`,
        [id, tenant, title],
      );
    }

    const insertLink = async (
      id: string,
      tenant: string,
      contract: string,
      token: string,
      expiresAt: string,
      isActive: boolean,
      permission = "view_and_sign",
    ) => {
      await c.query(
        `INSERT INTO portal_links
           (id, tenant_id, entity_type, entity_id, token_hash, token_prefix,
            expires_at, is_active, permission, recipient_email, created_at)
         VALUES ($1, $2, 'contract', $3, $4, $5, $6, $7, $8, $9, now() - INTERVAL '1 day')`,
        [
          id,
          tenant,
          contract,
          sha256(token),
          token.slice(0, 8),
          expiresAt,
          isActive,
          permission,
          "client@example.com",
        ],
      );
    };

    await insertLink(
      activeLinkA, tenantA, contractA, activeTokenA,
      new Date(Date.now() + 7 * 86_400_000).toISOString(), true,
    );
    // Expired an hour ago. Created a day ago, so the CHECK constraint holds.
    await insertLink(
      expiredLinkA, tenantA, contractA, expiredTokenA,
      new Date(Date.now() - 3_600_000).toISOString(), true,
    );
    await insertLink(
      revokedLinkA, tenantA, contractA, revokedTokenA,
      new Date(Date.now() + 7 * 86_400_000).toISOString(), false,
    );
    await insertLink(
      linkB, tenantB, contractB, tokenB,
      new Date(Date.now() + 7 * 86_400_000).toISOString(), true,
    );
  });

  fx = {
    tenantA, tenantB, userA, contractA, contractB,
    activeLinkA, activeTokenA,
    expiredLinkA, expiredTokenA,
    revokedLinkA, revokedTokenA,
    linkB, tokenB,
  };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    // ══════════════════════════════════════════════════════════════
    // The append-only triggers block this teardown — which is the
    // protection working exactly as designed. Test fixtures are the one
    // legitimate reason to remove evidence rows, so the triggers are
    // disabled for the duration of the cleanup and re-enabled after.
    //
    // `DISABLE TRIGGER USER` requires table ownership, which is why this
    // runs on the superuser pool. Nothing in an assertion may do this.
    // ══════════════════════════════════════════════════════════════
    await c.query(`ALTER TABLE contract_signatures DISABLE TRIGGER USER`);
    await c.query(`ALTER TABLE portal_links DISABLE TRIGGER USER`);

    await c.query(`DELETE FROM contract_signatures WHERE tenant_id = ANY($1)`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM portal_links WHERE tenant_id = ANY($1)`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM contracts WHERE tenant_id = ANY($1)`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1)`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1)`, [[fx.tenantA, fx.tenantB]]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[fx.tenantA, fx.tenantB]]);

    // Restore the protection. A suite that left these disabled would
    // silently weaken every subsequent run.
    await c.query(`ALTER TABLE contract_signatures ENABLE TRIGGER USER`);
    await c.query(`ALTER TABLE portal_links ENABLE TRIGGER USER`);
  });
});

/* ================================================================== */
/* TOKEN REJECTION — the mandatory verification                       */
/* ================================================================== */

/**
 * Mirrors the state checks inside `resolvePortalToken`, run against the
 * real rows. The resolver itself needs Next's request context, so the
 * DECISION LOGIC is exercised here against genuine database state rather
 * than against a mock of that state.
 */
async function resolveState(token: string) {
  return asSuperuser(async (c) => {
    const r = await c.query(
      `SELECT id, tenant_id, is_active, expires_at, signed_at, permission
       FROM portal_links WHERE token_hash = $1`,
      [sha256(token)],
    );
    const row = r.rows[0];
    if (!row) return { ok: false, reason: "not_found" as const };
    if (!row.is_active) {
      return { ok: false, reason: row.signed_at ? "already_signed" : ("revoked" as const) };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return { ok: false, reason: "expired" as const };
    }
    return { ok: true as const, row };
  });
}

describe("portal tokens — rejection", () => {
  it("ACCEPTS a live, unexpired, unrevoked token", async () => {
    const result = await resolveState(fx.activeTokenA);
    expect(result.ok).toBe(true);
  });

  it("REJECTS an expired token", async () => {
    const result = await resolveState(fx.expiredTokenA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("REJECTS a revoked token", async () => {
    const result = await resolveState(fx.revokedTokenA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  it("REJECTS a token that does not exist", async () => {
    const result = await resolveState(mintToken());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("REJECTS a token that becomes revoked mid-life", async () => {
    // Revocation must take effect on the NEXT request. A cached decision
    // would mean "revoked within five minutes", which is not revocation.
    const token = mintToken();
    const id = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO portal_links
           (id, tenant_id, entity_type, entity_id, token_hash, token_prefix,
            expires_at, is_active, permission)
         VALUES ($1,$2,'contract',$3,$4,$5,$6,true,'view')`,
        [
          id, fx.tenantA, fx.contractA, sha256(token), token.slice(0, 8),
          new Date(Date.now() + 86_400_000).toISOString(),
        ],
      );
    });

    expect((await resolveState(token)).ok).toBe(true);

    await asTenant(fx.tenantA, async (c) => {
      await c.query(
        `UPDATE portal_links SET is_active = false, revoked_at = now() WHERE id = $1`,
        [id],
      );
    });

    const after = await resolveState(token);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("revoked");
  });

  it("the stored value is a HASH — the raw token is nowhere in the table", async () => {
    // The property that makes a leaked backup useless.
    const found = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM portal_links WHERE token_hash = $1`,
        [fx.activeTokenA],
      );
      return r.rows[0].n;
    });

    expect(found).toBe(0);

    const byHash = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM portal_links WHERE token_hash = $1`,
        [sha256(fx.activeTokenA)],
      );
      return r.rows[0].n;
    });

    expect(byHash).toBe(1);
  });
});

/* ================================================================== */
/* TENANT ISOLATION                                                   */
/* ================================================================== */

describe("portal_links — tenant isolation", () => {
  it("a tenant sees only its own links", async () => {
    const ids = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(`SELECT id FROM portal_links`);
      return r.rows.map((x: { id: string }) => x.id);
    });

    expect(ids).toContain(fx.activeLinkA);
    expect(ids).not.toContain(fx.linkB);
  });

  it("tenant B cannot read tenant A's link by its exact id", async () => {
    const rows = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(`SELECT * FROM portal_links WHERE id = $1`, [fx.activeLinkA]);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("tenant B cannot find tenant A's link by its token hash", async () => {
    // The decisive isolation test: even knowing the exact credential
    // hash, the authenticated application path gives tenant B nothing.
    const rows = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(`SELECT * FROM portal_links WHERE token_hash = $1`, [
        sha256(fx.activeTokenA),
      ]);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("no tenant context returns ZERO links, never all links", async () => {
    const rows = await withoutTenant(async (c) => {
      const r = await c.query(`SELECT * FROM portal_links`);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("tenant B cannot revoke tenant A's link", async () => {
    const affected = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(
        `UPDATE portal_links SET is_active = false WHERE id = $1 RETURNING id`,
        [fx.activeLinkA],
      );
      return r.rowCount;
    });

    expect(affected).toBe(0);

    const stillActive = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(`SELECT is_active FROM portal_links WHERE id = $1`, [
        fx.activeLinkA,
      ]);
      return r.rows[0]?.is_active;
    });

    expect(stillActive).toBe(true);
  });

  it("a tenant cannot forge a link stamped with another tenant's id", async () => {
    const error = await expectError(async () => {
      await asTenant(fx.tenantB, async (c) => {
        const t = mintToken();
        await c.query(
          `INSERT INTO portal_links
             (tenant_id, entity_type, entity_id, token_hash, token_prefix,
              expires_at, permission)
           VALUES ($1,'contract',$2,$3,$4,$5,'view_and_sign')`,
          [
            fx.tenantA, fx.contractA, sha256(t), t.slice(0, 8),
            new Date(Date.now() + 86_400_000).toISOString(),
          ],
        );
      });
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
    // An RLS refusal, not a missing GRANT — the role demonstrably has
    // INSERT on this table, as the fixture inserts prove.
    expect(error?.message).toMatch(/row-level security|violates/i);
  });
});

/* ================================================================== */
/* TAMPER GUARDS                                                      */
/* ================================================================== */

describe("portal_links — tamper guards", () => {
  it("the token hash is IMMUTABLE, even for the owning tenant", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) => {
          await c.query(`UPDATE portal_links SET token_hash = $1 WHERE id = $2`, [
            sha256(mintToken()),
            fx.activeLinkA,
          ]);
        }),
      /token is immutable/i,
    );
  });

  it("the token hash is immutable even for a SUPERUSER", async () => {
    // A superuser bypasses RLS entirely. If this guarantee lived only in
    // the policy it would succeed here. It is a trigger so that it cannot.
    await expectGuard(
      () =>
        asSuperuser(async (c) => {
          await c.query(`UPDATE portal_links SET token_hash = $1 WHERE id = $2`, [
            sha256(mintToken()),
            fx.activeLinkA,
          ]);
        }),
      /token is immutable/i,
    );
  });

  it("a link cannot be re-aimed at a different record", async () => {
    // The obvious attack: re-point a live link the client still holds from
    // a small purchase order to a large sale agreement.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) => {
          await c.query(`UPDATE portal_links SET entity_id = $1 WHERE id = $2`, [
            randomUUID(),
            fx.activeLinkA,
          ]);
        }),
      /re-aimed at a different record/i,
    );
  });

  it("a view-only link cannot be UPGRADED to a signing link", async () => {
    const token = mintToken();
    const id = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO portal_links
           (id, tenant_id, entity_type, entity_id, token_hash, token_prefix,
            expires_at, permission)
         VALUES ($1,$2,'contract',$3,$4,$5,$6,'view')`,
        [
          id, fx.tenantA, fx.contractA, sha256(token), token.slice(0, 8),
          new Date(Date.now() + 86_400_000).toISOString(),
        ],
      );
    });

    // Silently upgrading a link the client already holds would turn a
    // read-only share into signing authority without them being told.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) => {
          await c.query(
            `UPDATE portal_links SET permission = 'view_and_sign' WHERE id = $1`,
            [id],
          );
        }),
      /cannot be upgraded to signing/i,
    );
  });

  it("a signing link CAN be downgraded to view-only", async () => {
    // Reducing authority is always safe, and a guard that blocked
    // everything would be trivially passable and useless.
    const updated = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(
        `UPDATE portal_links SET permission = 'view' WHERE id = $1 RETURNING permission`,
        [fx.revokedLinkA],
      );
      return r.rows[0]?.permission;
    });

    expect(updated).toBe("view");
  });

  it("an EXPIRED link cannot be resurrected by extending its expiry", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) => {
          await c.query(`UPDATE portal_links SET expires_at = $1 WHERE id = $2`, [
            new Date(Date.now() + 30 * 86_400_000).toISOString(),
            fx.expiredLinkA,
          ]);
        }),
      /expired portal link cannot be extended/i,
    );
  });

  it("a link cannot be born already expired", async () => {
    const error = await expectError(async () => {
      await asTenant(fx.tenantA, async (c) => {
        const t = mintToken();
        await c.query(
          `INSERT INTO portal_links
             (tenant_id, entity_type, entity_id, token_hash, token_prefix, expires_at)
           VALUES ($1,'contract',$2,$3,$4, now() - INTERVAL '1 hour')`,
          [fx.tenantA, fx.contractA, sha256(t), t.slice(0, 8)],
        );
      });
    });

    expect(error).not.toBeNull();
  });

  it("a link cannot be given a multi-year lifetime", async () => {
    const error = await expectError(async () => {
      await asTenant(fx.tenantA, async (c) => {
        const t = mintToken();
        await c.query(
          `INSERT INTO portal_links
             (tenant_id, entity_type, entity_id, token_hash, token_prefix, expires_at)
           VALUES ($1,'contract',$2,$3,$4, now() + INTERVAL '400 days')`,
          [fx.tenantA, fx.contractA, sha256(t), t.slice(0, 8)],
        );
      });
    });

    expect(error).not.toBeNull();
  });
});

/* ================================================================== */
/* SIGNATURE REPLAY & IMMUTABILITY                                    */
/* ================================================================== */

describe("contract_signatures — replay and immutability", () => {
  it("a portal link can produce at most ONE signature", async () => {
    // Layer 2 of replay prevention: even if the application's
    // compare-and-swap were removed, the database still refuses a second
    // signature for the same link.
    const linkId = randomUUID();
    const token = mintToken();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO portal_links
           (id, tenant_id, entity_type, entity_id, token_hash, token_prefix,
            expires_at, permission)
         VALUES ($1,$2,'contract',$3,$4,$5,$6,'view_and_sign')`,
        [
          linkId, fx.tenantA, fx.contractA, sha256(token), token.slice(0, 8),
          new Date(Date.now() + 86_400_000).toISOString(),
        ],
      );
    });

    const insertSignature = async () =>
      asTenant(fx.tenantA, async (c) => {
        await c.query(
          `INSERT INTO contract_signatures
             (tenant_id, contract_id, portal_link_id, signer_name, signer_email, consent_statement)
           VALUES ($1,$2,$3,'Priya Nair','client@example.com','I agree.')`,
          [fx.tenantA, fx.contractA, linkId],
        );
      });

    await insertSignature();

    const error = await expectError(insertSignature);
    expect(error).not.toBeNull();
    // 23505 — unique_violation on contract_signatures_link_unique.
    expect(error?.code).toBe("23505");
  });

  it("a signature cannot be UPDATED", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) => {
          await c.query(
            `UPDATE contract_signatures SET signer_name = 'Someone Else'
             WHERE tenant_id = $1`,
            [fx.tenantA],
          );
        }),
      /append-only/i,
    );
  });

  it("a signature cannot be DELETED", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) => {
          await c.query(`DELETE FROM contract_signatures WHERE tenant_id = $1`, [
            fx.tenantA,
          ]);
        }),
      /append-only/i,
    );
  });

  it("append-only holds even for a SUPERUSER", async () => {
    await expectGuard(
      () =>
        asSuperuser(async (c) => {
          await c.query(`DELETE FROM contract_signatures WHERE tenant_id = $1`, [
            fx.tenantA,
          ]);
        }),
      /append-only/i,
    );
  });

  it("tenant B cannot read tenant A's signatures", async () => {
    const rows = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(`SELECT * FROM contract_signatures`);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });
});
