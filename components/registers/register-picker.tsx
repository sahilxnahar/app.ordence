/**
 * Ordence — The picker: which register, which rules, which period
 * Version: v1.48.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A PLAIN `GET` FORM, AND THAT IS A DECISION RATHER THAN LAZINESS
 * ══════════════════════════════════════════════════════════════════════
 * The choices end up in the URL. That means a register is a link — it
 * can be bookmarked, pasted into an email to the consultant who asked
 * for it, and reopened next quarter to the same document. A client
 * component holding the selection in `useState` would make every
 * register a session-local thing that cannot be sent to anybody.
 *
 * ⚠️ AND IT SHIPS NO JAVASCRIPT. Nothing on this screen needs any: no
 * validation the server does not repeat, no optimistic update, no
 * mutation at all. A register is a read.
 *
 * 🔴 THE RULE-SET SELECT DEFAULTS TO "RULES NOT STATED" AND THE ORDER OF
 * THE OPTIONS IS THE ORDER IN `RULE_SETS`, WHERE THAT ENTRY IS FIRST.
 * Whatever sits at the top of this dropdown gets printed on every
 * register in the workspace forever, because it rendered without an
 * error the first time. Making it the entry that prints no form number
 * means the first register anybody generates visibly asks the question.
 */

type RegisterOption = {
  kind: string;
  title: string;
  purpose: string;
  periodic: boolean;
  needsLeave: boolean;
  refusal: string | null;
  sourcedColumns: number;
  unsourcedColumns: number;
};

type RuleSetOption = {
  id: string;
  label: string;
  citation: string;
  confidence: string;
  note: string;
  hasFormNumbers: boolean;
};

export function RegisterPicker(props: {
  registers: readonly RegisterOption[];
  ruleSets: readonly RuleSetOption[];
  states: readonly string[];
  selected: { kind: string; from: string; to: string; ruleSetId: string; stateCode: string };
}) {
  const { registers, ruleSets, states, selected } = props;

  return (
    <form method="get" className="space-y-4 rounded border p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Register</span>
          <select
            name="kind"
            defaultValue={selected.kind}
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          >
            {registers.map((r) => (
              <option key={r.kind} value={r.kind}>
                {r.title}
                {r.refusal !== null ? " — not generated" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Rules the form is under</span>
          <select
            name="ruleSet"
            defaultValue={selected.ruleSetId}
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          >
            {ruleSets.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.hasFormNumbers ? "" : " (no form number)"}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">From</span>
          <input
            type="date"
            name="from"
            defaultValue={selected.from}
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">To</span>
          <input
            type="date"
            name="to"
            defaultValue={selected.to}
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          />
        </label>

        {/*
          🔴 THE STATE FILTER IS NOT A CONVENIENCE. A register belongs to
          an establishment, an establishment is registered in one State,
          and a document stapling three States together is not a register
          under any of them. The generated document warns when more than
          one State is present; this is how somebody acts on the warning.
        */}
        <label className="space-y-1 text-sm">
          <span className="font-medium">State of work</span>
          <select
            name="state"
            defaultValue={selected.stateCode}
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">All States (not a register under any of them)</option>
            {states.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          Generate
        </button>
        <span className="text-xs text-muted-foreground">
          The period defaults to the Indian financial year — 1 April to 31 March — resolved in
          Asia/Kolkata.
        </span>
      </div>

      <ul className="space-y-2 border-t pt-3 text-xs text-muted-foreground">
        {registers.map((r) => (
          <li key={r.kind}>
            <span className="font-medium text-foreground">{r.title}</span> — {r.purpose}{" "}
            {r.refusal !== null ? (
              <span className="text-destructive">Not generated: every column is unsourced.</span>
            ) : (
              <>
                {r.sourcedColumns} column{r.sourcedColumns === 1 ? "" : "s"} sourced,{" "}
                {r.unsourcedColumns} printed blank.
              </>
            )}
            {r.needsLeave ? " Needs leave.read as well as payroll.read." : ""}
          </li>
        ))}
      </ul>
    </form>
  );
}
