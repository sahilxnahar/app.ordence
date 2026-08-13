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
import { Button } from "@/components/ui/button";

export type RoleRow = {
  role: string;
  side: "sales" | "purchase" | "construction" | "property";
  label: string;
  tallyGroup: string;
  accountType: string;
  help: string;
  ledgerId: string | null;
};

export function PostingSetup({
  roles,
  ledgers,
}: {
  roles: RoleRow[];
  ledgers: { id: string; code: string; name: string; accountType: string }[];
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
       * ⚠️ SPLIT INTO SALES AND PURCHASE. Eighteen roles in one
       * undifferentiated list is a form people abandon halfway, and the
       * half they abandon is whichever one is at the bottom.
       */}
      {(["sales", "purchase", "construction", "property"] as const).map((side) => (
      <div key={side} className="overflow-x-auto">
        <p className="pb-1 pt-3 text-xs font-semibold uppercase text-muted-foreground">
          {side === "sales"
            ? "Sales — invoices, credit notes, receipts"
            : side === "purchase"
              ? "Purchases — vendor bills and reverse charge"
              : side === "construction"
                ? "Construction — RA bills, retention and statutory deductions"
                : "Property — demands, buyer advances and possession"}
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Role</th>
              <th className="py-2 pr-3 font-medium">Tally group</th>
              <th className="py-2 pr-3 font-medium">Ledger</th>
            </tr>
          </thead>
          <tbody>
            {roles.filter((r) => r.side === side).map((r) => (
              <tr key={r.role} className="border-b align-top last:border-0">
                <td className="py-2 pr-3">
                  <span className="font-medium">{r.label}</span>
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
      ))}
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
      const { posted, skipped, missingRoles } = res.data;
      /**
       * ⚠️ A PARTIAL RESULT IS REPORTED AS A PARTIAL RESULT. "Posted 40,
       * skipped 12 because revenue and bank are unmapped" is more useful
       * than either a success message or a refusal — and it names exactly
       * what to fix.
       */
      setResult(
        skipped === 0
          ? `Posted ${posted}. Nothing left in the backlog.`
          : `Posted ${posted}, skipped ${skipped}. Still unmapped: ${missingRoles.join(", ") || "—"}.`,
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
