/**
 * Ordence — Companies
 * Version: v0.7.0-alpha
 */

import Link from "next/link";
import { Plus, Building2, Users } from "lucide-react";
import { getCompanies } from "@/server/actions/companies";
import { Button } from "@/components/ui/button";
import { SavedViewsShell } from "@/components/views/saved-views-shell";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const result = await getCompanies({ pageSize: 100 });

  if (!result.ok) {
    return (
      <main className="p-6">
        <h1 className="text-2xl font-bold">Companies</h1>
        <p className="mt-2 text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { rows, total } = result.data;

  return (
    <main className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Companies</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {total} {total === 1 ? "company" : "companies"} in your workspace
          </p>
        </div>
        <Button asChild>
          <Link href="/companies/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New company
          </Link>
        </Button>
      </div>

      {/*
        ⭐ PHASE 28 — saved views over companies. Additive: the list below
        is what renders until somebody picks a view. `/companies/<id>` is
        a 404 in this product, so the pattern points at the edit route —
        the same link this list already uses.
      */}
      <SavedViewsShell objectKey="company" hrefPattern="/companies/{id}/edit">
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <Building2 className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">
            No companies yet. Add your first one to get started.
          </p>
          <Button asChild className="mt-4">
            <Link href="/companies/new">New company</Link>
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((company) => (
            <li key={company.id}>
              <Link
                href={`/companies/${company.id}/edit`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-accent/50"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{company.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[company.industry, company.city, company.domain]
                      .filter(Boolean)
                      .join(" · ") || "No details yet"}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  {company.contactCount}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      </SavedViewsShell>
    </main>
  );
}
