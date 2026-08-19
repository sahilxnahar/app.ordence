"use client";

/**
 * Ordence — ⭐⭐ WHAT EACH ROLE ACTUALLY GRANTS
 * Version: v1.77.0-alpha · Wave 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS SCREEN EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * The team screen has always shown a permission COUNT beside each
 * person's role. "45 permissions" tells an administrator choosing
 * between `manager` and `member` for a new hire absolutely nothing about
 * the choice they are making, and it is the only evidence they had.
 *
 * ⚠️ COLLAPSED BY DEFAULT. Nine roles by up to 194 keys is a wall, and a
 * wall is not a control — it is something people scroll past. Each role
 * opens on demand, which is how somebody comparing two of them actually
 * works.
 */

import { useState } from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";

export type RoleMatrixRow = {
  readonly role: string;
  readonly label: string;
  readonly description: string;
  readonly grantsEverything: boolean;
  readonly permissions: readonly { readonly key: string; readonly label: string }[];
};

export function RoleMatrix({ rows }: { rows: readonly RoleMatrixRow[] }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section aria-labelledby="role-matrix-heading" className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 id="role-matrix-heading" className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          What each role can do
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These are the role templates. A person&rsquo;s actual access is their role plus any
          individual overrides recorded against them.
        </p>
      </div>

      <ul className="divide-y rounded-md border">
        {rows.map((row) => {
          const expanded = open === row.role;
          return (
            <li key={row.role}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : row.role)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/50"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{row.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.description}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {row.grantsEverything ? "everything" : `${row.permissions.length} permissions`}
                  <ChevronRight
                    className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
                    aria-hidden="true"
                  />
                </span>
              </button>

              {expanded && (
                <div className="border-t bg-muted/20 px-3 py-3">
                  {row.grantsEverything && (
                    <p className="mb-2 text-xs font-medium">
                      This role holds every permission in the product, including ones added by
                      future releases.
                    </p>
                  )}
                  <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {row.permissions.map((permission) => (
                      <li key={permission.key} className="text-xs">
                        <span>{permission.label}</span>{" "}
                        <code className="text-[10px] text-muted-foreground">{permission.key}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
