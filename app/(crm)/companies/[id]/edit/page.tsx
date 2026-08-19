/**
 * Ordence — Edit Company
 * Version: v0.7.0-alpha
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCompanyById } from "@/server/actions/companies";
import { CompanyForm } from "../../company-form";

export const dynamic = "force-dynamic";

export default async function EditCompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getCompanyById(id);

  if (!result.ok) notFound();
  const company = result.data;

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
        <h1 className="mt-2 text-2xl font-bold">{company.name}</h1>
      </div>

      <CompanyForm
        company={{
          id: company.id,
          name: company.name,
          domain: company.domain ?? "",
          industry: company.industry ?? "",
          employeeCount: company.employeeCount != null ? String(company.employeeCount) : "",
          companySize: company.companySize ?? "",
          website: company.website ?? "",
          phone: company.phone ?? "",
          addressLine1: company.addressLine1 ?? "",
          addressLine2: company.addressLine2 ?? "",
          city: company.city ?? "",
          state: company.state ?? "",
          postalCode: company.postalCode ?? "",
          country: company.country ?? "IN",
          notes: company.notes ?? "",
        }}
      />
    </main>
  );
}
