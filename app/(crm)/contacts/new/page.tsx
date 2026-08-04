/**
 * Ordence — New Contact
 * Version: v0.7.0-alpha
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCompanyOptions } from "@/server/actions/companies";
import { ContactForm } from "../contact-form";

export const dynamic = "force-dynamic";

export default async function NewContactPage() {
  const optionsResult = await getCompanyOptions();
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
        <h1 className="mt-2 text-2xl font-bold">New contact</h1>
      </div>

      <ContactForm companyOptions={companyOptions} />
    </main>
  );
}
