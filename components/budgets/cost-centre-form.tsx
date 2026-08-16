"use client";

/**
 * Ordence — ⭐ THE COST CENTRE LIST AND FORM
 * Version: v1.47.0-alpha · Batch 68
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE CODE IS TYPED ONCE AND NEVER AGAIN
 * ══════════════════════════════════════════════════════════════════════
 * The edit form has no code field, and its absence is the design. A code
 * is what people typed into spreadsheets, quoted in emails and printed
 * on last year's board pack. Renaming "PROD" to "MFG" changes what every
 * historical report says without changing a single figure, and the two
 * versions of the same report then disagree about what the department is
 * called with nothing to tie them together. The NAME is prose and is
 * freely editable; the code is an identifier.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO DELETE BUTTON, AND "ARCHIVE" SAYS WHAT IT DOES
 * ══════════════════════════════════════════════════════════════════════
 * A cost centre that has been used is referenced by journal lines that
 * are append-only and can never be re-coded, so the database refuses the
 * delete outright. Offering a Delete button that fails for every cost
 * centre anybody has actually used would teach people that the product
 * is broken. Archiving removes it from the picker and keeps it on the
 * reports, which is what "we do not use that department any more"
 * actually means.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type CostCentreListRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  displayOrder: number;
};

type Saved = { ok: true } | { ok: false; error: string };

export function CostCentreBoard({
  rows,
  mayCreate,
  mayUpdate,
  onCreate,
  onUpdate,
}: {
  rows: readonly CostCentreListRow[];
  mayCreate: boolean;
  mayUpdate: boolean;
  onCreate: (input: { code: string; name: string; description?: string }) => Promise<Saved>;
  onUpdate: (input: {
    id: string;
    name: string;
    description?: string;
    displayOrder: number;
    isActive: boolean;
  }) => Promise<Saved>;
}) {
  const router = useRouter();
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [isPending, startTransition] = React.useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onCreate({ code, name });
      if (result.ok) {
        toast.success(`Cost centre ${code} created.`);
        setCode("");
        setName("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const toggleArchive = (row: CostCentreListRow) => {
    startTransition(async () => {
      const result = await onUpdate({
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        displayOrder: row.displayOrder,
        isActive: !row.isActive,
      });
      if (result.ok) {
        toast.success(row.isActive ? `${row.code} archived.` : `${row.code} restored.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="space-y-6">
      {mayCreate && (
        <form
          onSubmit={submit}
          className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="cc-code" className="text-xs text-muted-foreground">
              Code
            </Label>
            <Input
              id="cc-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="PROD"
              maxLength={40}
              required
              className="w-40 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cc-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production"
              maxLength={200}
              required
              className="w-72"
            />
          </div>
          <Button type="submit" disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add cost centre
          </Button>
          {/*
            ⚠️ THE CASE RULE IS STATED BEFORE IT IS ENFORCED. Being
            refused for "prod" when "PROD" exists is bewildering unless
            somebody said so first.
          */}
          <p className="w-full text-xs text-muted-foreground">
            Codes are unique per workspace and are compared without regard to case —
            &quot;prod&quot; and &quot;PROD&quot; would be one department reported as two.
            The code cannot be changed afterwards; the name can.
          </p>
        </form>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">Cost centres in this workspace</caption>
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Code</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Name</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No cost centres yet. Until one exists, every journal line sits in the
                  &quot;Not allocated&quot; bucket on the departmental reports.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className={row.isActive ? undefined : "opacity-60"}>
                <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
                <td className="px-3 py-2">{row.name}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {row.isActive ? "Active" : "Archived — hidden from pickers, kept on reports"}
                </td>
                <td className="px-3 py-2 text-right">
                  {mayUpdate && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => toggleArchive(row)}
                    >
                      {row.isActive ? "Archive" : "Restore"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
