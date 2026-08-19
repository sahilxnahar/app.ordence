/**
 * Ordence — Setup Wizard Page
 * Version: v0.81.0-alpha
 *
 * Shows the onboarding wizard if the tenant hasn't completed setup.
 * After completion, redirects to the dashboard.
 */

import { redirect } from "next/navigation";
import { getTenantContext } from "@/server/tenant-context";
import { resolveIndustryTemplate } from "@/lib/industry-templates";
import SetupClient from "./setup-client";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const ctx = await getTenantContext();
  if (!ctx) redirect("/sign-in");

  const settings = (ctx.tenant.settings ?? {}) as Record<string, unknown>;

  // If already onboarded, redirect to dashboard.
  if (settings.onboardedAt) {
    redirect("/dashboard");
  }

  const template = resolveIndustryTemplate(settings.industry as string | undefined);

  // Pre-fill from existing tenant data
  const billingProfile = (settings.billingProfile ?? {}) as Record<string, unknown>;

  const initialData = {
    legalName: ctx.tenant.legalName ?? ctx.tenant.name,
    gstin: (billingProfile.gstin as string) ?? "",
    pan: "",
    addressLine1: (billingProfile.addressLine1 as string) ?? "",
    addressLine2: (billingProfile.addressLine2 as string) ?? "",
    city: (billingProfile.city as string) ?? "",
    state: (billingProfile.state as string) ?? "",
    postalCode: (billingProfile.postalCode as string) ?? "",
    country: (billingProfile.country as string) ?? "India",
    billingEmail: (billingProfile.billingEmail as string) ?? "",
    fiscalYearStartMonth: (settings.fiscalYearStartMonth as number) ?? 4,
    currency: (settings.currency as string) ?? "INR",
    timezone: (settings.timezone as string) ?? "Asia/Kolkata",
    dateFormat: (settings.dateFormat as string) ?? "DD-MM-YYYY",
    industry: (settings.industry as string) ?? "generic",
    currentStep: (settings.onboardingStep as number) ?? 1,
  };

  const industryOptions = [
    { value: "generic", label: "General Business" },
    { value: "real_estate_developer", label: "Real Estate / Construction" },
    { value: "hospitality", label: "Hospitality" },
    { value: "healthcare", label: "Healthcare" },
    { value: "logistics", label: "Logistics" },
    { value: "trading", label: "Trading" },
    { value: "electricity", label: "Electricity" },
    { value: "solar", label: "Solar" },
    { value: "software", label: "Software" },
    { value: "financial_services", label: "Financial Services" },
    { value: "professional_services", label: "Professional Services" },
    { value: "small_business", label: "Small Business" },
  ];

  return (
    <SetupClient
      initialData={initialData}
      industryOptions={industryOptions}
      industryLabel={template.label}
    />
  );
}
