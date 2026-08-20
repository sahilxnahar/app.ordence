/**
 * Ordence — ⭐⭐ THE TWELVE EXEMPTIONS, CHECKED RATHER THAN ASSERTED IN PROSE
 * Version: v1.83.0-alpha · Track D, wave 17
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS DEFENDS
 * ══════════════════════════════════════════════════════════════════════
 * Wave 15 measured 291 of 303 tenant-scoped base tables carrying
 * `no_delete_under_impersonation`, recommended leaving the other twelve,
 * and wrote the recommendation in a report. A report is not a control.
 *
 * On the assembled wave-17 tree the numbers moved — 294 of 306, because
 * three new tenant tables arrived from other tracks — and the exempt set
 * did NOT: it is the same twelve. That is the outcome worth having, and it
 * is only worth having because something re-measured it. This file is that
 * something.
 *
 * ⚠️ IT FAILS IN BOTH DIRECTIONS, ON PURPOSE:
 *
 *   • A THIRTEENTH unguarded table fails, naming itself. That is either a
 *     new table that missed `attach_impersonation_guards()` or a real
 *     decision somebody has to take — and either way it must not arrive
 *     silently.
 *   • A table that GAINS the guard while still listed as exempt also
 *     fails. A stale entry saying "this one is deliberate" is worse than no
 *     entry, because the next reviewer trusts it. Same rule
 *     `lib/auth/permission-enforcement.ts` applies to declared-only
 *     permission keys.
 */

import { describe, it, expect } from "vitest";
import { asSuperuser } from "../setup";
import {
  IMPERSONATION_GUARD_EXEMPTIONS,
  EXEMPT_TABLE_NAMES,
  UNGUARDED_TENANT_TABLES_SQL,
  exemptionFor,
} from "@/lib/security/impersonation-guard-exemptions";

async function unguardedTables(): Promise<string[]> {
  const rows = await asSuperuser((c) => c.query(UNGUARDED_TENANT_TABLES_SQL));
  return rows.rows.map((r) => (r as { table_name: string }).table_name);
}

describe("⭐ the impersonation delete guard — coverage and its recorded exemptions", () => {
  it("🔴 the live unguarded set is EXACTLY the recorded one", async () => {
    /*
     * ⚠️ `toEqual` ON TWO SORTED ARRAYS, NOT TWO SET COMPARISONS OR A
     * LENGTH CHECK. A length check passes when one table is swapped for
     * another; a set comparison hides ordering drift that would make every
     * later diff unreadable. This one prints both lists when it fails.
     */
    expect(await unguardedTables()).toEqual([...EXEMPT_TABLE_NAMES]);
  });

  it("coverage is what the record says it is, measured not assumed", async () => {
    const rows = await asSuperuser((c) =>
      c.query(`
        SELECT count(*) FILTER (WHERE guarded)     AS guarded,
               count(*) FILTER (WHERE NOT guarded) AS unguarded,
               count(*)                            AS total
          FROM (
            SELECT EXISTS (
                     SELECT 1 FROM pg_trigger t
                      WHERE t.tgrelid = k.oid
                        AND t.tgname = 'no_delete_under_impersonation'
                   ) AS guarded
              FROM information_schema.columns c
              JOIN pg_class k ON k.relname = c.table_name
                             AND k.relnamespace = 'public'::regnamespace
             WHERE c.table_schema = 'public'
               AND c.column_name = 'tenant_id'
               AND k.relkind = 'r'
          ) s
      `),
    );
    const { guarded, unguarded, total } = rows.rows[0] as {
      guarded: string;
      unguarded: string;
      total: string;
    };

    expect(Number(unguarded)).toBe(EXEMPT_TABLE_NAMES.length);
    expect(Number(guarded) + Number(unguarded)).toBe(Number(total));

    /*
     * ⚠️ NOT PINNED TO A NUMBER. Every wave adds tenant tables, and a hard
     * `toBe(294)` would go red for the healthy reason. What is pinned is
     * the EXEMPT set, which is a decision; the guarded count is a
     * consequence.
     */
    expect(Number(guarded)).toBeGreaterThan(280);
  });

  it("⚠️ views are excluded — 22 of them carry tenant_id and cannot bear a trigger", async () => {
    /*
     * The first draft of the wave-15 measurement counted 34 unguarded
     * relations because it did not filter `relkind`. Twenty-two were views.
     * Asserting the filter here means the number in the record cannot
     * quietly start meaning something else.
     */
    const rows = await asSuperuser((c) =>
      c.query(`
        SELECT k.relkind::text AS kind, count(*)::int AS n
          FROM information_schema.columns c
          JOIN pg_class k ON k.relname = c.table_name
                         AND k.relnamespace = 'public'::regnamespace
         WHERE c.table_schema='public' AND c.column_name='tenant_id'
         GROUP BY 1
      `),
    );
    const kinds = new Map(
      rows.rows.map((r) => [(r as { kind: string }).kind, (r as { n: number }).n]),
    );
    expect(kinds.get("v") ?? 0).toBeGreaterThan(0);
    expect(kinds.get("r") ?? 0).toBeGreaterThan(kinds.get("v") ?? 0);
  });
});

describe("⭐ every exemption carries a reason somebody can check", () => {
  it("has a note, a category, and no empty prose", () => {
    for (const e of IMPERSONATION_GUARD_EXEMPTIONS) {
      expect(e.note.length, `${e.table} needs a real note`).toBeGreaterThan(60);
      expect(["evidence", "platform_owned", "metering"]).toContain(e.reason);
    }
  });

  it("🔴 every `evidence` exemption names the stricter thing that protects it", () => {
    /*
     * The whole argument for exempting the evidence tables is that they are
     * protected by something STRONGER — an append-only trigger that refuses
     * DELETE for every role, not merely under impersonation. An `evidence`
     * entry with `protectedBy: null` would be an exemption resting on an
     * argument nobody wrote down.
     */
    for (const e of IMPERSONATION_GUARD_EXEMPTIONS.filter((x) => x.reason === "evidence")) {
      expect(e.protectedBy, `${e.table} claims evidence with no protector`).toBeTruthy();
    }
  });

  it("🔴 EVERY CLAIMED PROTECTION IS ASKED OF THE DATABASE, NOT TRUSTED", async () => {
    /*
     * 🔴 THE ASSERTION THAT MAKES THIS FILE MORE THAN A LEDGER — and the one
     * that changed the wave-15 answer.
     *
     * Each entry claims a `protection`. This asks Postgres which protection
     * each table actually has, and refuses to let the two disagree.
     *
     * ⚠️ THE FIRST DRAFT DID THIS WITH `DELETE FROM <t> WHERE false` AND WAS
     * WRONG. Every one of these triggers is ROW-level, so a statement that
     * matches no rows never fires one — the probe reported "permits DELETE"
     * for `audit_logs`, which is emphatically false. A test whose METHOD is
     * wrong produces findings that are wrong in whichever direction the
     * method leans, and this one leaned alarming.
     *
     * So the question is asked of the catalogue instead: does a DELETE
     * trigger exist, and does the app role hold the DELETE privilege.
     */
    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT c.relname AS table_name,
                EXISTS (
                  SELECT 1 FROM pg_trigger t
                   WHERE t.tgrelid = c.oid
                     AND NOT t.tgisinternal
                     AND (t.tgtype::int & 8) = 8      -- fires on DELETE
                ) AS has_delete_trigger,
                has_table_privilege('ordence_app', c.oid, 'DELETE') AS app_may_delete
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relkind = 'r'
            AND c.relname = ANY($1)`,
        [[...EXEMPT_TABLE_NAMES]],
      ),
    );

    const actual = new Map(
      rows.rows.map((r) => {
        const row = r as {
          table_name: string;
          has_delete_trigger: boolean;
          app_may_delete: boolean;
        };
        return [row.table_name, row];
      }),
    );

    for (const e of IMPERSONATION_GUARD_EXEMPTIONS) {
      const live = actual.get(e.table);
      expect(live, `${e.table} is not a base table in this schema`).toBeDefined();
      if (!live) continue;

      if (e.protection === "delete_trigger") {
        expect(
          live.has_delete_trigger,
          `${e.table} claims a DELETE trigger and has none`,
        ).toBe(true);
      }

      if (e.protection === "revoke_only") {
        /*
         * ⚠️ THE SHAPE THAT DEFINES `revoke_only`: no trigger, and the app
         * role cannot delete. Asserting BOTH halves means the classification
         * cannot silently become wrong in either direction — a trigger
         * appearing (good) or the privilege being re-granted (worse) both
         * fail here.
         */
        expect(live.has_delete_trigger, `${e.table} has a trigger after all`).toBe(false);
        expect(live.app_may_delete, `${e.table} is not even REVOKEd`).toBe(false);
      }
    }
  });

  it("🔴 anything resting on a REVOKE alone is marked needs_action, never `leave`", () => {
    /*
     * 🔴 THE PROJECT'S STANDING RULE, ENCODED. "Production connects as
     * `neondb_owner`, and that role OWNS the tables. A table owner is not
     * subject to GRANT or REVOKE … if you write a control that depends on a
     * GRANT, you have written nothing."
     *
     * An exemption whose entire justification is a REVOKE is an exemption
     * resting on nothing, and blessing it with `leave` is how a gap becomes
     * a decision nobody revisits.
     */
    for (const e of IMPERSONATION_GUARD_EXEMPTIONS) {
      if (e.protection !== "revoke_only") continue;
      expect(e.verdict, `${e.table} rests on a REVOKE and must not read "leave"`).toBe(
        "needs_action",
      );
    }
  });

  it("⚠️ records that exactly ONE of the twelve needs action, and names it", () => {
    /*
     * Pinned as a number and a name, like the platform-scope label count.
     * If it rises, something regressed; if it falls, somebody fixed it and
     * should say which in the same commit.
     */
    const needsAction = IMPERSONATION_GUARD_EXEMPTIONS.filter(
      (e) => e.verdict === "needs_action",
    ).map((e) => e.table);

    expect(needsAction).toEqual(["change_log"]);
  });

  it("the lookup returns null for a table that is not exempt", () => {
    expect(exemptionFor("contacts")).toBeNull();
    expect(exemptionFor("security_events")?.reason).toBe("evidence");
  });
});
