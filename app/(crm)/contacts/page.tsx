import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getContacts } from "@/server/actions/contacts";
import { DataGrid } from "@/components/crm/data-grid";
import { SavedViewsShell } from "@/components/views/saved-views-shell";
import { contactColumns } from "./columns";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const result = await getContacts({ pageSize: 100 });

  if (!result.ok) {
    return (
      <main className="p-6">
        <h1 className="text-2xl font-bold">Contacts</h1>
        <p className="mt-2 text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {result.data.total} {result.data.total === 1 ? "contact" : "contacts"} in your workspace
          </p>
        </div>
        <Button asChild>
          <Link href="/contacts/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New contact
          </Link>
        </Button>
      </div>

      {/*
        ⭐ PHASE 28 — saved views over contacts.

        ⚠️ `hrefPattern` ENDS IN `/edit` BECAUSE THAT IS THE ONLY CONTACT
        ROUTE THIS PRODUCT HAS. `/contacts/<id>` is a 404, so a pattern
        that merely appended the id would give every row in every saved
        view a broken link — which is exactly the class of bug a prefix
        prop hides and a pattern prop makes visible at the call site.
      */}
      <SavedViewsShell objectKey="contact" hrefPattern="/contacts/{id}/edit">
        <DataGrid
          columns={contactColumns}
          data={result.data.rows}
          searchPlaceholder="Search contacts…"
          emptyMessage="No contacts yet. Add your first one to get started."
          ariaLabel="Contacts"
        />
      </SavedViewsShell>
    </main>
  );
}
