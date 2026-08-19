"use client";

/**
 * Ordence — Mapping sales roles to the tenant's own ledgers
 * Version: v0.99.0-alpha
 *
 * ⚠️ EACH ROW SAVES ON ITS OWN. A single "Save all" over nine roles means
 * one bad ledger id rejects the other eight, and the person cannot tell
 * which. Nine small writes are also nine audit lines, which is what you
 * want on a screen that decides where a year of turnover lands.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setSalesPostingAccount, postSalesBacklog } from "@/server/actions/sales-posting";
import { POSTING_MODULES, type PostingModuleKey } from "@/lib/accounting/sales-posting";
import { Button } from "@/components/ui/button";

export type RoleRow = {
  role: string;
  /**
   * ⭐ EVERY module that needs this role. Batch 0108.
   *
   * ⚠️ THIS WAS `side`, ONE OF FOUR, PICKED BY A PRECEDENCE CHAIN. It said
   * `bank` was a sales role, when a vendor payment needs it just as much,
   * and it had no value at all for the twenty-seven roles the old screen
   * could not show. A role needed by two modules is now listed under both,
   * because the operator is trying to answer "why will payroll not post",
   * not "how many rows are missing".
   */
  modules: readonly PostingModuleKey[];
  label: string;
  tallyGroup: string;
  accountType: string;
  help: string;
  ledgerId: string | null;
};

export type ModuleStatus = {
  key: PostingModuleKey;
  label: string;
  needs: string;
  total: number;
  unmapped: number;
};

export function PostingSetup({
  roles,
  ledgers,
  moduleStatus,
}: {
  roles: RoleRow[];
  ledgers: { id: string; code: string; name: string; accountType: string }[];
  moduleStatus: ModuleStatus[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedRole, setSavedRole] = useState<string | null>(null);

  function save(role: string, ledgerId: string) {
    if (!ledgerId) return;
    setError(null);
    start(async () => {
      const res = await setSalesPostingAccount({ role, ledgerId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSavedRole(role);
      router.refresh();
    });
  }

  if (ledgers.length === 0) {
    return (
      <p className="text-sm">
        {/* Not an empty dropdown. There is genuinely nothing to choose from. */}
        You have no ledgers yet. Create your chart of accounts under{" "}
        <a href="/accounting" className="underline underline-offset-4">
          Accounting
        </a>{" "}
        first — nothing can post until there is somewhere to post it.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/**
       * ⚠️ ONE SECTION PER MODULE, AND THE SECTION SAYS WHAT BREAKS.
       *
       * 🔴 SIXTY-SIX ROLES IN ONE UNDIFFERENTIATED LIST IS A FORM NOBODY
       * FINISHES, and the part they abandon is whichever is at the bottom
       * — which, before Batch 0108, was every role the screen could not
       * show at all.
       *
       * ⚠️ THE HEADING LEADS WITH THE CONSEQUENCE, not the count.
       * "4 roles unmapped" means nothing to the person who has to act on
       * it. "The depreciation run refuses outright until these are mapped"
       * is the sentence that gets somebody to finish the form.
       */}
      {moduleStatus.map((mod) => {
        const mine = roles.filter((r) => r.modules.includes(mod.key));
        if (mine.length === 0) return null;
        return (
        <div key={mod.key} id={`module-${mod.key}`} className="overflow-x-auto">
          <p className="pb-1 pt-4 text-xs font-semibold uppercase text-muted-foreground">
            {mod.label}
            {mod.unmapped > 0 && (
              <span className="ml-2 font-normal normal-case text-destructive">
                {mod.unmapped} of {mod.total} not mapped
              </span>
            )}
          </p>
          <p className="pb-2 text-xs text-muted-foreground">{mod.needs}</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Role</th>
                <th className="py-2 pr-3 font-medium">Tally group</th>
                <th className="py-2 pr-3 font-medium">Ledger</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((r) => (
                <tr key={r.role} className="border-b align-top last:border-0">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{r.label}</span>
                    {/**
                     * ⚠️ A ROLE SHARED WITH ANOTHER MODULE SAYS SO. Mapping
                     * `bank` under Sales also unblocks vendor payments, and
                     * somebody who does not know that maps it twice looking
                     * for the second one.
                     */}
                    {r.modules.length > 1 && (
                      <span className="block text-xs text-muted-foreground">
                        Also used by:{" "}
                        {r.modules
                          .filter((m) => m !== mod.key)
                          .map((m) => POSTING_MODULES[m].label)
                          .join(", ")}
                      </span>
                    )}
                    <span className="block text-xs text-muted-foreground">{r.help}</span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {/* ⚠️ Shown because the group decides which side of the balance
                        sheet a ledger lands on, and Tally rejects the wrong one. */}
                    {r.tallyGroup}
                    <span className="block">({r.accountType})</span>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      aria-label={`Ledger for ${r.label}`}
                      defaultValue={r.ledgerId ?? ""}
                      disabled={pending}
                      onChange={(e) => save(r.role, e.target.value)}
                      className={`w-72 rounded border p-2 text-sm ${
                        r.ledgerId ? "border-muted" : "border-destructive"
                      }`}
                    >
                      <option value="">— not mapped —</option>
                      {ledgers.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.code} — {l.name}
                        </option>
                      ))}
                    </select>
                    {savedRole === r.role && (
                      <span className="ml-2 text-xs text-muted-foreground">saved</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        );
      })}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function PostBacklogButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  function run() {
    setResult(null);
    start(async () => {
      const res = await postSalesBacklog();
      if (!res.ok) {
        setResult(res.error);
        return;
      }
      const { posted, skipped, missingRoles, blockedModules } = res.data;
      /**
       * ⚠️ A PARTIAL RESULT IS REPORTED AS A PARTIAL RESULT. "Posted 40,
       * skipped 12 because revenue and bank are unmapped" is more useful
       * than either a success message or a refusal — and it names exactly
       * what to fix.
       */
      setResult(
        skipped === 0
          ? `Posted ${posted}. Nothing left in the backlog.`
          : `Posted ${posted}, skipped ${skipped}. Still unmapped: ${missingRoles.join(", ") || "—"}` +
            /**
             * ⭐ AND WHAT THAT COSTS, IN THE OPERATOR'S WORDS. Batch 0108.
             * A list of role keys is a list of database columns; naming
             * the modules that cannot post is the sentence somebody acts
             * on.
             */
            (blockedModules.length > 0 ? ` — blocking: ${blockedModules.join(", ")}.` : "."),
      );
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <Button type="button" onClick={run} disabled={pending || count === 0}>
        {pending ? "Posting…" : `Post ${count} document${count === 1 ? "" : "s"} to the ledger`}
      </Button>
      {result && <p className="text-sm">{result}</p>}
      <p className="text-xs text-muted-foreground">
        {/* Idempotency is what makes this button safe to press twice. */}
        Safe to run more than once — a document already in the books is skipped, not
        posted twice.
      </p>
    </div>
  );
}
