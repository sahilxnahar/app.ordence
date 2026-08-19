/**
 * Ordence — New Company
 * Version: v0.7.0-alpha
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CompanyForm } from "../company-form";

export const dynamic = "force-dynamic";

export default function NewCompanyPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link
          href="/companies"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to companies
        </Link>
        <h1 className="mt-2 text-2xl font-bold">New company</h1>
      </div>

      <CompanyForm />
    </main>
  );
}
