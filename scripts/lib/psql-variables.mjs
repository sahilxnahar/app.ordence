/**
 * Ordence — the tiny subset of psql that `scripts/harness/*.sql` uses
 * Version: v1.80.0-alpha · Infra wave 13
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/harness/seed.sql` is written for `psql` and uses two of its
 * meta-features:
 *
 *     \set T '1111...'          declare a variable
 *     (:'T', 'receivable', …)   interpolate it, quoted
 *
 * The `pg` driver knows nothing about either, so a script that applies
 * the file statement-by-statement gets `syntax error at or near "\"`.
 *
 * ⚠️ THIS IS NOT A psql EMULATOR AND MUST NOT BECOME ONE. It supports
 * exactly `\set` and `:NAME` / `:'NAME'`, and it THROWS on any other
 * backslash command rather than skipping it. A silent skip would mean a
 * seed that half-applied and a harness that then reported wrong counts,
 * which is the failure this whole gate exists to catch.
 */

/** Every backslash command this understands. Anything else is an error. */
const SUPPORTED = new Set(["set"]);

/**
 * Expand `\set` declarations and `:NAME` references.
 *
 * @param {string} sql   the file contents
 * @param {string} label the file name, for the error message
 * @returns {string} SQL with no psql meta-commands left in it
 */
export function expandPsqlVariables(sql, label = "input") {
  /** @type {Map<string, string>} */
  const vars = new Map();
  const out = [];

  for (const [index, rawLine] of sql.split("\n").entries()) {
    const line = rawLine;
    const trimmed = line.trimStart();

    if (trimmed.startsWith("\\")) {
      const m = /^\\(\w+)\s+(\w+)\s+(.*)$/.exec(trimmed);
      const command = m?.[1]?.toLowerCase();

      if (!command || !SUPPORTED.has(command)) {
        throw new Error(
          `${label}:${index + 1} uses the psql meta-command "${trimmed.split(/\s/)[0]}", ` +
            `which this expander does not support. Supported: ${[...SUPPORTED]
              .map((c) => "\\" + c)
              .join(", ")}. ` +
            `Rewrite the line as plain SQL, or teach scripts/lib/psql-variables.mjs ` +
            `about it deliberately , do NOT let it be skipped, because a seed that ` +
            `half-applies produces a harness that reports confidently wrong counts.`,
        );
      }

      const name = m[2];
      /*
       * Strip one layer of single quotes, the only form the harness uses,
       * and UN-DOUBLE any escaped quote inside it.
       *
       * ⚠️  \set N 'O''Brien' means the value O'Brien. Taking the
       * inner text verbatim would give it back with the doubled quote still
       * in place, and the re-quoting below would then escape it a SECOND
       * time , producing a different string, silently, in a seed whose whole
       * purpose is exact answers.
       */
      const raw = m[3].trim().replace(/;$/, "");
      const value = /^'.*'$/.test(raw)
        ? raw.slice(1, -1).replace(/''/g, "'")
        : raw;
      vars.set(name, value);
      out.push(""); // keep line numbers aligned for any later error
      continue;
    }

    out.push(line);
  }

  let expanded = out.join("\n");

  for (const [name, value] of vars) {
    // :'NAME' → a quoted literal.  :NAME → bare.
    expanded = expanded
      .split(`:'${name}'`)
      .join(`'${value.replace(/'/g, "''")}'`)
      .split(`:${name}`)
      .join(value);
  }

  const leftover = /(^|[^:]):'?[A-Za-z_]\w*'?/m.exec(
    expanded.replace(/::[A-Za-z_]/g, ""), // ignore the :: cast operator
  );
  if (leftover && /:'[A-Za-z_]/.test(expanded)) {
    throw new Error(
      `${label}: an undeclared psql variable is still present after expansion ` +
        `(${leftover[0].trim()}). It would reach PostgreSQL as a syntax error, ` +
        `or worse, as a valid parameter placeholder.`,
    );
  }

  return expanded;
}
