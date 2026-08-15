/**
 * Ordence — ⭐⭐⭐ THE REPORTING HIERARCHY, AS ARITHMETIC
 * Version: v1.47.0-alpha · Batch 109
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONE THING THIS MODULE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * A REPORTING HIERARCHY WITH A CYCLE IN IT HANGS EVERY RECURSIVE QUERY
 * THAT WALKS IT. A reports to B and B reports to A is two ordinary
 * edits made a month apart, and no foreign key has an opinion about
 * reachability — the database will accept both writes and then spin
 * forever the first time anything asks who reports to whom.
 *
 * ⚠️ WHERE IT IS ACTUALLY ENFORCED IS NOT HERE. The control is the
 * `reporting_lines_no_cycle` trigger in `SQL-FILES/0085_appraisals_and_org.sql`,
 * because a trigger cannot be bypassed by a CSV import, a psql session
 * or a server action somebody writes next year. Every function below is
 * the same rule in TypeScript so the person gets a sentence naming the
 * loop instead of a 500 carrying a Postgres error code.
 *
 * 🔴 IF THE TWO EVER DISAGREE, THE TRIGGER IS RIGHT AND THIS FILE IS THE
 * BUG. Do not "fix" a refusal by loosening the trigger.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ PURE. NO DATABASE, NO CLOCK, NO I/O.
 * ══════════════════════════════════════════════════════════════════════
 * Everything takes an array of edges and returns an answer, so the
 * cycle rule can be tested exhaustively in milliseconds without a
 * Postgres. The caller loads the current lines once and asks as many
 * questions as it likes.
 */

/** One current reporting edge: `employeeId` reports to `managerId`. */
export type ReportingEdge = {
  employeeId: string;
  managerId: string;
};

/**
 * ⚠️ THE DEPTH CEILING, AND IT IS A SAFETY NET RATHER THAN A POLICY.
 *
 * A genuine reporting chain in the kind of business this product is for
 * is under ten deep. Sixty-four is far past anything real, so hitting it
 * means the data is either a cycle the checks below somehow missed or a
 * chain nobody meant to type. Both should refuse loudly rather than walk
 * for another ten thousand hops.
 *
 * 🔴 EVERY LOOP IN THIS FILE IS BOUNDED BY IT. A `while (current)` with
 * no counter is the same hang this module exists to prevent, moved into
 * the code that was supposed to detect it.
 */
export const MAX_REPORTING_DEPTH = 64;

/** `employeeId -> managerId` for the CURRENT lines only. */
export function managerMap(edges: readonly ReportingEdge[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of edges) {
    /**
     * ⚠️ FIRST WINS, AND IT SHOULD NEVER MATTER. The partial unique
     * index `reporting_lines_current_key` makes two open lines for one
     * employee impossible. If one ever appears — a migration run out of
     * order, say — taking the first is a stable answer rather than a
     * chart that differs between two renders of the same data.
     */
    if (!map.has(e.employeeId)) map.set(e.employeeId, e.managerId);
  }
  return map;
}

/**
 * 🔴🔴 THE REFUSAL. Would pointing `employeeId` at `managerId` close a
 * loop, given the lines that exist today?
 *
 * Returns the chain that would close, longest-first, or `null` when the
 * write is safe. The chain is returned rather than a boolean so the
 * error message can name the people — "you would make Priya report to
 * Anil, who reports to Priya" is actionable and "cycle detected" is not.
 *
 * ⚠️ THE WALK STARTS AT THE PROPOSED MANAGER, NOT AT THE EMPLOYEE. We
 * are asking whether the employee is already ABOVE the manager. Walking
 * down from the employee would need the whole subtree; walking up from
 * the manager needs one pointer per hop and terminates at a root.
 */
export function wouldCreateCycle(
  edges: readonly ReportingEdge[],
  employeeId: string,
  managerId: string,
): string[] | null {
  /** ⭐ The one-hop case, which is also refused by a CHECK constraint. */
  if (employeeId === managerId) return [employeeId, managerId];

  const up = managerMap(edges.filter((e) => e.employeeId !== employeeId));
  const chain: string[] = [managerId];
  const seen = new Set<string>([managerId]);

  let current: string | undefined = up.get(managerId);
  let hops = 0;
  while (current && hops < MAX_REPORTING_DEPTH) {
    chain.push(current);
    if (current === employeeId) return [employeeId, ...chain];
    /**
     * ⚠️ A LOOP THAT DOES NOT INCLUDE THE EMPLOYEE IS STILL A LOOP, and
     * it means the data is ALREADY broken. Refusing the write is the
     * right answer: adding an edge to a graph that already hangs makes
     * it no better, and the refusal is how somebody finds out.
     */
    if (seen.has(current)) return [employeeId, ...chain];
    seen.add(current);
    current = up.get(current);
    hops += 1;
  }

  /** ⚠️ Ran past the ceiling. Treat as a cycle — see MAX_REPORTING_DEPTH. */
  if (hops >= MAX_REPORTING_DEPTH) return [employeeId, ...chain];

  return null;
}

/**
 * ⭐⭐ EVERY EMPLOYEE AT OR BELOW `rootId`, INCLUDING `rootId` ITSELF.
 *
 * 🔴 THIS IS THE SET THAT SCOPES A MANAGER'S READS, AND IT IS THE WHOLE
 * AUTHORISATION FOR THEM. RLS scopes by TENANT: every colleague's
 * appraisal is in the same tenant, so the policy is satisfied by a query
 * that returns the whole company exactly as it is by one that returns a
 * manager's own line. The narrowing has to be in the WHERE clause, and
 * this function is what goes in it. Same lesson as
 * `server/actions/payroll-self.ts#myPayslips`.
 *
 * ⚠️ INCLUDING THE ROOT IS DELIBERATE AND CALLERS MUST KNOW IT. A
 * manager reading "my line" should see their own appraisal in the list;
 * a manager REVIEWING their line must not review themselves, and that is
 * refused separately by `appraisal_subjects_reviewer_not_self`.
 */
export function descendantsOf(edges: readonly ReportingEdge[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const e of edges) {
    const list = children.get(e.managerId);
    if (list) list.push(e.employeeId);
    else children.set(e.managerId, [e.employeeId]);
  }

  const out = new Set<string>([rootId]);
  let frontier = [rootId];
  let depth = 0;

  /**
   * ⚠️ BREADTH-FIRST WITH A VISITED SET AND A DEPTH BOUND. Both are
   * needed. The visited set alone terminates on a cycle; the depth bound
   * catches a graph so wide-and-deep that something else has gone wrong.
   */
  while (frontier.length > 0 && depth < MAX_REPORTING_DEPTH) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        if (out.has(child)) continue;
        out.add(child);
        next.push(child);
      }
    }
    frontier = next;
    depth += 1;
  }
  return out;
}

/** The chain from `employeeId` up to its root, `employeeId` first. */
export function chainUp(edges: readonly ReportingEdge[], employeeId: string): string[] {
  const up = managerMap(edges);
  const chain = [employeeId];
  const seen = new Set([employeeId]);
  let current = up.get(employeeId);
  let hops = 0;
  while (current && !seen.has(current) && hops < MAX_REPORTING_DEPTH) {
    chain.push(current);
    seen.add(current);
    current = up.get(current);
    hops += 1;
  }
  return chain;
}

/**
 * ⭐ THE SKIP-LEVEL: the manager's manager, or null.
 *
 * ⚠️ NULL IS THE COMMON CASE NEAR THE TOP and it is not an error. A
 * company with three layers has no skip-level for the second one, and a
 * screen that renders an empty "skip-level review" box forever teaches
 * people that the product is broken.
 */
export function skipLevelOf(
  edges: readonly ReportingEdge[],
  employeeId: string,
): string | null {
  const chain = chainUp(edges, employeeId);
  return chain[2] ?? null;
}

/* ------------------------------------------------------------------ */
/* THE CHART                                                           */
/* ------------------------------------------------------------------ */

export type OrgNode = {
  employeeId: string;
  fullName: string;
  employeeCode: string;
  designation: string | null;
  department: string | null;
  /** ⭐ Set when the person has left. They stay on the chart — see below. */
  leftOn: string | null;
  managerId: string | null;
  depth: number;
  reports: OrgNode[];
};

export type OrgPerson = {
  employeeId: string;
  fullName: string;
  employeeCode: string;
  designation: string | null;
  department: string | null;
  leftOn: string | null;
};

export type OrgChart = {
  roots: OrgNode[];
  /**
   * 🔴 REPORTS WHOSE MANAGER HAS LEFT. THE ORPHAN LIST, MADE LOUD.
   *
   * ⚠️ THE ALTERNATIVE WAS SILENCE. Nulling a leaver's reports on exit
   * moves four people to the top of the chart with nobody told, and
   * mid-cycle it makes four manager reviews nobody's job. Re-pointing
   * them at the grandparent is worse, because it looks right while
   * changing who signs off an appraisal for a period they did not
   * supervise. So the leaver keeps their node, the lines are untouched,
   * and this list is what HR has to clear by hand.
   */
  staleLines: Array<{ employee: OrgPerson; manager: OrgPerson }>;
  /**
   * ⚠️ PEOPLE WITH NO REPORTING LINE AT ALL. One of these is the
   * managing director. Forty of them means nobody has filled the chart
   * in, and a chart with forty roots is a list.
   */
  unassigned: OrgPerson[];
  /** Deepest chain found, for the "is this plausible" glance. */
  maxDepth: number;
  /**
   * 🔴 CYCLES PRESENT IN THE DATA DESPITE EVERY REFUSAL. Should always be
   * empty; rendered as a red band if it is not, because the alternative
   * to reporting it is a chart that silently omits people.
   */
  cyclic: string[];
};

/**
 * ⭐⭐ BUILD THE TREE, AND NEVER LOSE A PERSON DOING IT.
 *
 * 🔴 THE BUILD IS BOUNDED AND CYCLE-TOLERANT BY CONSTRUCTION. It does
 * not recurse over the edge list; it seeds the roots and expands one
 * level at a time with a visited set, so a cycle that reached the table
 * despite the CHECK, the trigger and `wouldCreateCycle` produces a
 * `cyclic` list on screen rather than a stack overflow in a server
 * component.
 */
export function buildOrgChart(
  people: readonly OrgPerson[],
  edges: readonly ReportingEdge[],
): OrgChart {
  const byId = new Map(people.map((p) => [p.employeeId, p]));
  const up = managerMap(edges);

  /** ⚠️ Edges pointing at somebody who is not in `people` are dropped. */
  const children = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.employeeId) || !byId.has(e.managerId)) continue;
    const list = children.get(e.managerId);
    if (list) list.push(e.employeeId);
    else children.set(e.managerId, [e.employeeId]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (byId.get(a)?.fullName ?? "").localeCompare(byId.get(b)?.fullName ?? ""));
  }

  const node = (id: string, depth: number): OrgNode => {
    const p = byId.get(id)!;
    return {
      employeeId: p.employeeId,
      fullName: p.fullName,
      employeeCode: p.employeeCode,
      designation: p.designation,
      department: p.department,
      leftOn: p.leftOn,
      managerId: up.get(id) ?? null,
      depth,
      reports: [],
    };
  };

  const rootIds = people
    .filter((p) => {
      const managerId = up.get(p.employeeId);
      return !managerId || !byId.has(managerId);
    })
    .map((p) => p.employeeId)
    .sort((a, b) => (byId.get(a)?.fullName ?? "").localeCompare(byId.get(b)?.fullName ?? ""));

  const placed = new Set<string>();
  const roots: OrgNode[] = [];
  let maxDepth = 0;

  let frontier: OrgNode[] = rootIds.map((id) => {
    placed.add(id);
    const n = node(id, 0);
    roots.push(n);
    return n;
  });

  let level = 0;
  while (frontier.length > 0 && level < MAX_REPORTING_DEPTH) {
    const next: OrgNode[] = [];
    for (const parent of frontier) {
      for (const childId of children.get(parent.employeeId) ?? []) {
        if (placed.has(childId)) continue;
        placed.add(childId);
        const child = node(childId, parent.depth + 1);
        parent.reports.push(child);
        next.push(child);
        if (child.depth > maxDepth) maxDepth = child.depth;
      }
    }
    frontier = next;
    level += 1;
  }

  /**
   * 🔴 ANYBODY NOT PLACED IS IN A CYCLE (or past the depth ceiling).
   * They are named, not dropped. A chart that quietly omits three people
   * is worse than one that says three people could not be placed.
   */
  const cyclic = people.map((p) => p.employeeId).filter((id) => !placed.has(id));

  const staleLines: OrgChart["staleLines"] = [];
  for (const e of edges) {
    const manager = byId.get(e.managerId);
    const employee = byId.get(e.employeeId);
    if (!manager || !employee) continue;
    if (manager.leftOn) staleLines.push({ employee, manager });
  }
  staleLines.sort((a, b) => a.employee.fullName.localeCompare(b.employee.fullName));

  const unassigned = people
    .filter((p) => !up.has(p.employeeId))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  return { roots, staleLines, unassigned, maxDepth, cyclic };
}

/** ⭐ Total nodes in a tree, bounded. Used by the screen's summary line. */
export function countNodes(nodes: readonly OrgNode[]): number {
  let total = 0;
  let frontier = [...nodes];
  let level = 0;
  while (frontier.length > 0 && level < MAX_REPORTING_DEPTH) {
    total += frontier.length;
    frontier = frontier.flatMap((n) => n.reports);
    level += 1;
  }
  return total;
}
