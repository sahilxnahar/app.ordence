/**
 * Ordence — Edit Contact
 * Version: v0.7.0-alpha
 *
 * `getContactById` is tenant-scoped, so a contact id belonging to another
 * tenant returns "not found" rather than a record. The 404 here is the
 * honest response — confirming the id exists elsewhere would leak the fact
 * that it exists at all.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getContactById } from "@/server/actions/contacts";
import { getCompanyOptions } from "@/server/actions/companies";
import { ContactForm } from "../../contact-form";

export const dynamic = "force-dynamic";

export default async function EditContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [contactResult, optionsResult] = await Promise.all([
    getContactById(id),
    getCompanyOptions(),
  ]);

  if (!contactResult.ok) notFound();

  const contact = contactResult.data;
  const companyOptions = optionsResult.ok ? optionsResult.data : [];

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link
          href="/contacts"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to contacts
        </Link>
        <h1 className="mt-2 text-2xl font-bold">
          {contact.firstName} {contact.lastName ?? ""}
        </h1>
      </div>

      <ContactForm
        contact={{
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName ?? "",
          email: contact.email ?? "",
          phone: contact.phone ?? "",
          mobile: contact.mobile ?? "",
          jobTitle: contact.jobTitle ?? "",
          department: contact.department ?? "",
          linkedinUrl: contact.linkedinUrl ?? "",
          companyId: contact.companyId ?? "",
          notes: contact.notes ?? "",
        }}
        companyOptions={companyOptions}
      />
    </main>
  );
}
