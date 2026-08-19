/**
 * Ordence — ⭐⭐⭐ FINDING ONE PERSON IN TWO HUNDRED AND NINETY-SIX TABLES
 * Version: v1.68.0-alpha
 *
 * Pure. Builds a PLAN. Executes nothing, opens no connection, and knows
 * no tenant. `server/dpdp/export-service.ts` runs what this produces.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RULE THIS FILE IS BUILT AROUND
 * ══════════════════════════════════════════════════════════════════════
 * An export that quietly misses a table is worse than not having the
 * feature. So every table in the inventory ends up in the plan with a
 * verdict, and there are only three verdicts:
 *
 *   `search`     we can find this person's rows here, and here is how
 *   `no-reach`   this table holds personal data and we cannot search it
 *   `skip`       this table holds no personal data
 *
 * ⭐ THERE IS NO FOURTH VERDICT AND NO TABLE IS ABSENT. A table missing
 * from the plan would be a table missing from the manifest, and a
 * manifest that does not mention a table is a document telling somebody
 * we hold nothing of theirs there. That sentence has to be earned.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE PLAN IS BUILT BEFORE ANYTHING IS EXECUTED
 * ══════════════════════════════════════════════════════════════════════
 * The plan is inspectable, testable and printable without a database.
 * The test suite can assert that every classified table appears in it;
 * an operator can read what WILL be searched before authorising it; and
 * the manifest is generated from the same object that drove the queries,
 * so the two cannot disagree. An export that builds its manifest
 * separately from its queries is an export whose receipt is a second
 * opinion.
 */

import {
  CLASSIFICATION,
  PRINCIPAL_KINDS,
  PRINCIPAL_TABLES,
  type PrincipalKind,
  type Reach,
  type TableClassification,
} from "./classification";

/* ------------------------------------------------------------------ */
/* THE SUBJECT                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A PERSON IS NOT ONE ROW.
 *
 * The same human being is frequently a `contacts` row, a `leads` row
 * that became an allottee, and a `users` row because they were given a
 * portal login. Three ids, three tables, one Data Principal, and a
 * "give me everything about me" that answered from only one of them
 * would be complete against the wrong question.
 *
 * ⚠️ ORDENCE DOES NOT AUTOMATICALLY MERGE THEM, and it must not. A
 * shared email address is not proof that two records are one person —
 * `info@` on a family business is the counter-example, and merging on it
 * would disclose one person's data to another. So the anchors are
 * supplied by the operator who verified the request, and the export
 * records WHICH anchors it was given.
 */
export type SubjectAnchor = {
  kind: PrincipalKind;
  /** The row id in that principal's table. */
  id: string;
  /** How the operator established this is the requester. Printed in the manifest. */
  establishedBy: string;
};

export type SubjectIdentifiers = {
  /** ⚠️ Lower-cased before comparison. Never used to INFER an anchor. */
  emails: readonly string[];
  /** Digits only, no country code, matching the `*_digits` columns. */
  phones: readonly string[];
};

export type Subject = {
  anchors: readonly SubjectAnchor[];
  identifiers: SubjectIdentifiers;
};

/* ------------------------------------------------------------------ */
/* THE PLAN                                                            */
/* ------------------------------------------------------------------ */

/**
 * A predicate against ONE table, expressed structurally rather than as
 * SQL. The executor turns these into parameterised statements; keeping
 * them structural is what lets the tests assert the shape of a search
 * without a database, and what stops a table name reaching a query
 * string from anywhere but the frozen inventory.
 */
export type Predicate =
  /** `id = ANY(:ids)` — the person's own record. */
  | { op: "id-in"; ids: readonly string[]; why: string }
  /** `<column> = ANY(:ids)` */
  | { op: "column-in"; column: string; ids: readonly string[]; why: string }
  /** `lower(<column>) = ANY(:values)` — matched by value, not by key. */
  | { op: "identifier-in"; column: string; values: readonly string[]; why: string }
  /**
   * `<idColumn> = ANY(:ids) AND <kindColumn> = ANY(:kinds)`
   *
   * ⚠️ THE DISCRIMINATOR IS DATA, NOT SCHEMA. Nothing constrains what a
   * writer puts in `subject_type`, so this predicate finds the rows that
   * were labelled the way we expect and silently misses any that were
   * not. The plan records that, and `confidence` below carries it into
   * the manifest.
   */
  | { op: "polymorphic-in"; idColumn: string; kindColumn: string; ids: readonly string[]; kinds: readonly string[]; why: string }
  /** `<column> IN (SELECT id FROM <parent> WHERE ...)` — resolved at execution. */
  | { op: "via-parent"; column: string; parent: string; why: string }
  /** `id IN (SELECT <column> FROM <from> WHERE ...)` */
  | { op: "via-reverse"; column: string; from: string; why: string };

export type Confidence =
  /** ⭐ A key join to an id the operator verified. */
  | "keyed"
  /**
   * ⚠️ MATCHED ON A STRING SOMEBODY TYPED. Two people who share a family
   * email address share these rows, and a person who changed their phone
   * number loses the old ones. Reported, not hidden.
   */
  | "by-value"
  /** 🔴 Depends on a discriminator column no constraint enforces. */
  | "by-convention";

/**
 * 🔴 "WE DID NOT SEARCH THIS TABLE" HAS TWO MEANINGS AND COLLAPSING THEM
 *    MISLEADS THE PERSON READING THE MANIFEST.
 *
 *   `no-reach`       nothing in the product can find ANY person's rows
 *                    in this table. A defect in our inventory, and the
 *                    customer needs to know it applies to everybody.
 *
 *   `not-applicable` a reach exists and this person has nothing to match
 *                    on — no employee record, or no phone number on
 *                    file. Not a defect. It usually means the honest
 *                    answer is "you are not an employee of ours".
 *
 * ⚠️ The first version of this file reported both as `no-reach`, which
 * turned "you have no payroll record with us" into "we cannot search our
 * payroll records". Ninety-two tables read as a product-wide failure
 * when ninety-one of them were a person who simply does not work here.
 */
export type TablePlan = {
  table: string;
  verdict: "search" | "no-reach" | "not-applicable" | "skip" | "out-of-scope";
  predicates: readonly Predicate[];
  confidence: Confidence | null;
  /** ⭐ Always populated. For `no-reach` this is the sentence the customer reads. */
  note: string;
  /** Retention rule that will govern an erasure of these rows, if any. */
  retention: TableClassification["retention"];
};

export type ExportPlan = {
  subject: Subject;
  tables: readonly TablePlan[];
  /** 🔴 Counted here so the manifest cannot round it down. */
  summary: {
    total: number;
    searched: number;
    /** 🔴 Tables no reach finds, for anybody. A defect, and it is printed. */
    unreachable: number;
    /** Tables this person has no record in. Not a defect. */
    notApplicable: number;
    /** Tables holding no personal data. */
    skipped: number;
    /** 🔴 Ordence's own Fiduciary records. Never searched from a workspace. */
    outOfScope: number;
  };
};

/* ------------------------------------------------------------------ */
/* BUILDING IT                                                         */
/* ------------------------------------------------------------------ */

function anchorIds(subject: Subject, kind: PrincipalKind): string[] {
  return subject.anchors.filter((a) => a.kind === kind).map((a) => a.id);
}

/**
 * ⚠️ THE VALUES A `subject_type` COLUMN IS EXPECTED TO HOLD.
 *
 * 🔴 THESE ARE GUESSES ABOUT DATA, NOT FACTS ABOUT SCHEMA, and they are
 * written here rather than buried in a query so that being wrong is
 * visible. Both the singular and the plural form are tried because the
 * writers in this repository disagree with each other: `work.ts` writes
 * `subject_type` from a union of singular names, `email.ts` writes it
 * from the entity's table name.
 */
const POLYMORPHIC_KINDS: Record<PrincipalKind, readonly string[]> = {
  contact: ["contact", "contacts"],
  lead: ["lead", "leads"],
  employee: ["employee", "employees"],
  user: ["user", "users"],
  worker: ["worker", "site_worker", "site_workers"],
  deductee: ["deductee", "tds_deductee", "tds_deductees"],
  landowner: ["landowner", "landowners"],
  partner: ["channel_partner", "channel_partners", "partner"],
  vendor: ["vendor", "vendors"],
};

function predicatesFor(entry: TableClassification, subject: Subject): {
  predicates: Predicate[];
  confidence: Confidence | null;
  notes: string[];
  /** ⭐ True where a reach EXISTS, whether or not this subject can use it. */
  reachableInPrinciple: boolean;
} {
  const predicates: Predicate[] = [];
  const notes: string[] = [];
  let reachableInPrinciple = false;
  let confidence: Confidence | null = null;
  const raise = (c: Confidence) => {
    /** Worst confidence wins: an export is only as sound as its weakest join. */
    const order: Confidence[] = ["keyed", "by-value", "by-convention"];
    if (confidence === null || order.indexOf(c) > order.indexOf(confidence)) confidence = c;
  };

  for (const reach of entry.reaches as readonly Reach[]) {
    switch (reach.via) {
      case "self": {
        reachableInPrinciple = true;
        const ids = anchorIds(subject, reach.principal);
        if (ids.length === 0) break;
        predicates.push({
          op: "id-in",
          ids,
          why: `this table is the ${reach.principal}'s own record`,
        });
        raise("keyed");
        break;
      }
      case "column": {
        reachableInPrinciple = true;
        const ids = anchorIds(subject, reach.principal);
        if (ids.length === 0) break;
        predicates.push({
          op: "column-in",
          column: reach.column,
          ids,
          why: `${reach.column} holds the ${reach.principal}'s id`,
        });
        raise("keyed");
        break;
      }
      case "parent": {
        reachableInPrinciple = true;
        predicates.push({
          op: "via-parent",
          column: reach.column,
          parent: reach.table,
          why: `reached through ${reach.table}, which is itself searched for this person`,
        });
        raise("keyed");
        break;
      }
      case "reverse": {
        reachableInPrinciple = true;
        predicates.push({
          op: "via-reverse",
          column: reach.column,
          from: reach.from,
          why: `${reach.from}.${reach.column} points at this table`,
        });
        raise("keyed");
        break;
      }
      case "identifier": {
        reachableInPrinciple = true;
        const values =
          reach.identifier === "email"
            ? subject.identifiers.emails.map((e) => e.trim().toLowerCase())
            : subject.identifiers.phones.map((p) => p.replace(/\D/g, ""));
        if (values.length === 0) {
          notes.push(
            `${entry.table} is matched on ${reach.identifier}, and no ${reach.identifier} was supplied for this person, so it was NOT searched.`,
          );
          break;
        }
        predicates.push({
          op: "identifier-in",
          column: reach.column,
          values,
          why: `${reach.column} is a ${reach.identifier} written as text, with no key to join on`,
        });
        raise("by-value");
        break;
      }
      case "polymorphic": {
        reachableInPrinciple = true;
        const ids = subject.anchors.map((a) => a.id);
        const kinds = [...new Set(subject.anchors.flatMap((a) => POLYMORPHIC_KINDS[a.kind]))];
        if (ids.length === 0) break;
        predicates.push({
          op: "polymorphic-in",
          idColumn: reach.idColumn,
          kindColumn: reach.kindColumn,
          ids,
          kinds,
          why: `${reach.idColumn} points at a subject and ${reach.kindColumn} says which kind — no foreign key enforces either`,
        });
        raise("by-convention");
        break;
      }
      case "none": {
        notes.push(reach.because);
        break;
      }
    }
  }

  return { predicates, confidence, notes, reachableInPrinciple };
}

export function buildExportPlan(subject: Subject): ExportPlan {
  const tables: TablePlan[] = [];

  for (const entry of CLASSIFICATION) {
    /**
     * 🔴 FIRST, BEFORE ANYTHING ELSE. Ordence's own Fiduciary records
     * are not reachable by a workspace's request at any confidence, from
     * any anchor, under any classification. Putting this check after the
     * `operational` branch would have been harmless today and would have
     * become a disclosure the first time somebody reclassified a
     * platform table as personal.
     */
    if (entry.scope === "platform") {
      tables.push({
        table: entry.table,
        verdict: "out-of-scope",
        predicates: [],
        confidence: null,
        note:
          entry.scopeNote ??
          `${entry.table} is Ordence's own record, not this workspace's. Ordence is the Data Fiduciary for it and a request made to this workspace cannot be answered out of it.`,
        retention: entry.retention,
      });
      continue;
    }

    if (entry.holds === "operational") {
      tables.push({
        table: entry.table,
        verdict: "skip",
        predicates: [],
        confidence: null,
        note: entry.because ?? "classified as holding no personal data",
        retention: entry.retention,
      });
      continue;
    }

    const { predicates, confidence, notes, reachableInPrinciple } = predicatesFor(entry, subject);

    if (predicates.length === 0) {
      /**
       * ⚠️ BOTH BRANCHES BELOW MEAN "WE DID NOT LOOK HERE" AND BOTH GO
       * IN THE MANIFEST. What differs is what the person should conclude
       * from it, which is why they are two verdicts and not one.
       *
       * ⭐ The `not-applicable` case depends on the SUBJECT, not on the
       * inventory, so no amount of reading `classification.ts` finds it
       * and no test with a fully-populated fixture would ever exercise
       * it. That is the case a partial export hides best.
       */
      tables.push({
        table: entry.table,
        verdict: reachableInPrinciple ? "not-applicable" : "no-reach",
        predicates: [],
        confidence: null,
        note:
          notes.length > 0
            ? notes.join(" ")
            : reachableInPrinciple
              ? `${entry.table} is searchable, and this person has no identifier or record that reaches it — they are not, on our records, a person this table holds.`
              : `${entry.table} holds personal data and NOTHING in this product can find any person's rows in it.`,
        retention: entry.retention,
      });
      continue;
    }

    tables.push({
      table: entry.table,
      verdict: "search",
      predicates,
      confidence,
      note: notes.length > 0 ? notes.join(" ") : predicates.map((p) => p.why).join("; "),
      retention: entry.retention,
    });
  }

  return {
    subject,
    tables,
    summary: {
      total: tables.length,
      searched: tables.filter((t) => t.verdict === "search").length,
      unreachable: tables.filter((t) => t.verdict === "no-reach").length,
      notApplicable: tables.filter((t) => t.verdict === "not-applicable").length,
      skipped: tables.filter((t) => t.verdict === "skip").length,
      outOfScope: tables.filter((t) => t.verdict === "out-of-scope").length,
    },
  };
}

/**
 * ⭐⭐ HOW MUCH OF THE PRODUCT A SEARCH CAN COVER, AT BEST.
 *
 * A plan built for a fictional person holding EVERY kind of anchor plus
 * an email and a phone number. Nothing real ever looks like this, which
 * is the point: it is the ceiling, and the number a settings screen
 * should show before it offers to answer a Data Principal.
 *
 * 🔴 IT IS COMPUTED, NEVER WRITTEN DOWN. A hard-coded "we search 162
 * tables" is true on the day it is typed and goes on being displayed
 * long after it stops being true — which is the same class of defect as
 * a data inventory nothing re-derives.
 */
export function bestCaseCoverage(): ExportPlan["summary"] {
  return buildExportPlan({
    anchors: PRINCIPAL_KINDS.map((kind) => ({
      kind,
      id: "00000000-0000-0000-0000-000000000000",
      establishedBy: "coverage probe — not a real person",
    })),
    identifiers: { emails: ["probe@example.invalid"], phones: ["0000000000"] },
  }).summary;
}

/**
 * ⭐ THE ORDER THE EXECUTOR MUST RUN IN.
 *
 * A `via-parent` predicate needs the parent's matching ids before it can
 * run, so parents come first. This is a topological sort over the
 * `parent` edges only.
 *
 * ⚠️ IT RETURNS `cycles` RATHER THAN THROWING. The classification gate
 * already refuses a cycle at build time, so one appearing here means the
 * gate was bypassed — and an export that dies is worse for the person
 * waiting for it than an export that completes and names the tables it
 * could not order. The executor treats a cycled table as `no-reach`.
 */
export function executionOrder(plan: ExportPlan): { order: string[]; cycles: string[] } {
  const byTable = new Map(plan.tables.map((t) => [t.table, t]));
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  const cycles: string[] = [];

  const visit = (table: string) => {
    const s = state.get(table);
    if (s === "done") return;
    if (s === "visiting") {
      cycles.push(table);
      return;
    }
    state.set(table, "visiting");
    const t = byTable.get(table);
    if (t) {
      for (const p of t.predicates) {
        if (p.op === "via-parent") visit(p.parent);
        if (p.op === "via-reverse") visit(p.from);
      }
    }
    state.set(table, "done");
    order.push(table);
  };

  for (const t of plan.tables) visit(t.table);
  return { order, cycles: [...new Set(cycles)] };
}
