"use client";

/**
 * Ordence — Setup Wizard Client
 * Version: v0.81.0-alpha
 *
 * Multi-step onboarding wizard:
 *   Step 1: Organization details (legal name, GSTIN, address)
 *   Step 2: Fiscal preferences (year start, currency, timezone)
 *   Step 3: Industry selection
 *   Step 4: Review and complete
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveOrganizationDetails,
  saveFiscalPreferences,
  saveIndustrySelection,
  completeOnboarding,
} from "@/server/actions/onboarding";

const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand",
  "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
  "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab",
  "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal",
  "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
  "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
];

const MONTHS = [
  { value: 1, label: "January" }, { value: 2, label: "February" },
  { value: 3, label: "March" }, { value: 4, label: "April" },
  { value: 5, label: "May" }, { value: 6, label: "June" },
  { value: 7, label: "July" }, { value: 8, label: "August" },
  { value: 9, label: "September" }, { value: 10, label: "October" },
  { value: 11, label: "November" }, { value: 12, label: "December" },
];

const STEPS = ["Organization", "Fiscal Year", "Industry", "Review"];

type InitialData = {
  legalName: string;
  gstin: string;
  pan: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  billingEmail: string;
  fiscalYearStartMonth: number;
  currency: string;
  timezone: string;
  dateFormat: string;
  industry: string;
  currentStep: number;
};

export default function SetupClient({
  initialData,
  industryOptions,
  industryLabel,
}: {
  initialData: InitialData;
  industryOptions: Array<{ value: string; label: string }>;
  industryLabel: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(initialData.currentStep ?? 1);

  const [org, setOrg] = useState({
    legalName: initialData.legalName,
    gstin: initialData.gstin,
    pan: initialData.pan,
    addressLine1: initialData.addressLine1,
    addressLine2: initialData.addressLine2,
    city: initialData.city,
    state: initialData.state,
    postalCode: initialData.postalCode,
    country: initialData.country,
    billingEmail: initialData.billingEmail,
  });

  const [fiscal, setFiscal] = useState({
    fiscalYearStartMonth: initialData.fiscalYearStartMonth,
    currency: initialData.currency,
    timezone: initialData.timezone,
    dateFormat: initialData.dateFormat,
  });

  const [industry, setIndustry] = useState(initialData.industry);

  /* ---- Step handlers ---- */

  function handleStep1Next() {
    setError(null);
    if (!org.legalName.trim()) {
      setError("Legal name is required.");
      return;
    }
    if (!org.addressLine1.trim() || !org.city.trim() || !org.state.trim() || !org.postalCode.trim()) {
      setError("Address fields are required.");
      return;
    }
    start(async () => {
      const res = await saveOrganizationDetails(org);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStep(2);
    });
  }

  function handleStep2Next() {
    setError(null);
    start(async () => {
      const res = await saveFiscalPreferences(fiscal);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStep(3);
    });
  }

  function handleStep3Next() {
    setError(null);
    start(async () => {
      const res = await saveIndustrySelection({ industry });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStep(4);
    });
  }

  function handleComplete() {
    setError(null);
    start(async () => {
      const res = await completeOnboarding();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });
  }

  function handleSkip() {
    setError(null);
    start(async () => {
      const res = await completeOnboarding();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });
  }

  /* ---- Render ---- */

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Ordence</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Let's set up your workspace. This takes about 2 minutes.
        </p>
      </div>

      {/* Progress */}
      <div className="mb-8 flex items-center gap-2">
        {STEPS.map((label, i) => {
          const stepNum = i + 1;
          const isDone = stepNum < step;
          const isActive = stepNum === step;
          return (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${
                  isDone
                    ? "bg-green-500 text-white"
                    : isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {isDone ? "✓" : stepNum}
              </div>
              <span className={`text-sm ${isActive ? "font-medium" : "text-muted-foreground"}`}>
                {label}
              </span>
              {stepNum < STEPS.length && (
                <div className={`h-px w-8 ${isDone ? "bg-green-500" : "bg-border"}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Step 1: Organization */}
      {step === 1 && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Organization details</h2>
          <p className="text-sm text-muted-foreground">
            This information appears on your invoices and tax filings.
          </p>

          <div>
            <label className="mb-1 block text-sm font-medium">Legal name *</label>
            <input
              type="text"
              value={org.legalName}
              onChange={(e) => setOrg({ ...org, legalName: e.target.value })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Acme Industries Pvt Ltd"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">GSTIN</label>
              <input
                type="text"
                value={org.gstin}
                onChange={(e) => setOrg({ ...org, gstin: e.target.value.toUpperCase() })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
                placeholder="27ABCDE1234F1Z5"
                maxLength={15}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">PAN</label>
              <input
                type="text"
                value={org.pan}
                onChange={(e) => setOrg({ ...org, pan: e.target.value.toUpperCase() })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
                placeholder="ABCDE1234F"
                maxLength={10}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Address line 1 *</label>
            <input
              type="text"
              value={org.addressLine1}
              onChange={(e) => setOrg({ ...org, addressLine1: e.target.value })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="123 Industrial Estate"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Address line 2</label>
            <input
              type="text"
              value={org.addressLine2}
              onChange={(e) => setOrg({ ...org, addressLine2: e.target.value })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Plot B, Wing 2"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">City *</label>
              <input
                type="text"
                value={org.city}
                onChange={(e) => setOrg({ ...org, city: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="Mumbai"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">State *</label>
              <select
                value={org.state}
                onChange={(e) => setOrg({ ...org, state: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">Select state</option>
                {INDIAN_STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Postal code *</label>
              <input
                type="text"
                value={org.postalCode}
                onChange={(e) => setOrg({ ...org, postalCode: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="400001"
                maxLength={6}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Billing email</label>
              <input
                type="email"
                value={org.billingEmail}
                onChange={(e) => setOrg({ ...org, billingEmail: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="accounts@acme.com"
              />
            </div>
          </div>

          <div className="flex justify-between pt-4">
            <button
              type="button"
              onClick={handleSkip}
              disabled={pending}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={handleStep1Next}
              disabled={pending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? "Saving..." : "Next →"}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Fiscal */}
      {step === 2 && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Fiscal preferences</h2>
          <p className="text-sm text-muted-foreground">
            These determine your financial year boundaries and display formats.
          </p>

          <div>
            <label className="mb-1 block text-sm font-medium">Financial year starts in</label>
            <select
              value={fiscal.fiscalYearStartMonth}
              onChange={(e) => setFiscal({ ...fiscal, fiscalYearStartMonth: Number(e.target.value) })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {MONTHS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Indian businesses typically use April (FY April–March).
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Currency</label>
            <select
              value={fiscal.currency}
              onChange={(e) => setFiscal({ ...fiscal, currency: e.target.value })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="INR">₹ Indian Rupee (INR)</option>
              <option value="USD">$ US Dollar (USD)</option>
              <option value="EUR">€ Euro (EUR)</option>
              <option value="GBP">£ British Pound (GBP)</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Timezone</label>
            <select
              value={fiscal.timezone}
              onChange={(e) => setFiscal({ ...fiscal, timezone: e.target.value })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="Asia/Kolkata">India (IST, UTC+5:30)</option>
              <option value="Asia/Dubai">Dubai (GST, UTC+4)</option>
              <option value="Asia/Singapore">Singapore (SGT, UTC+8)</option>
              <option value="America/New_York">US Eastern (EST/EDT)</option>
              <option value="Europe/London">UK (GMT/BST)</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Date format</label>
            <select
              value={fiscal.dateFormat}
              onChange={(e) => setFiscal({ ...fiscal, dateFormat: e.target.value })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="DD-MM-YYYY">DD-MM-YYYY (31-12-2026)</option>
              <option value="MM-DD-YYYY">MM-DD-YYYY (12-31-2026)</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD (2026-12-31)</option>
            </select>
          </div>

          <div className="flex justify-between pt-4">
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={pending}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={handleStep2Next}
              disabled={pending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? "Saving..." : "Next →"}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Industry */}
      {step === 3 && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Choose your industry</h2>
          <p className="text-sm text-muted-foreground">
            This configures your navigation, terminology, and available modules.
            You can change it later in settings.
          </p>

          <div className="grid grid-cols-2 gap-3">
            {industryOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setIndustry(opt.value)}
                className={`rounded-lg border p-4 text-left transition-colors ${
                  industry === opt.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/30"
                }`}
              >
                <p className="text-sm font-medium">{opt.label}</p>
              </button>
            ))}
          </div>

          <div className="flex justify-between pt-4">
            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={pending}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={handleStep3Next}
              disabled={pending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? "Saving..." : "Next →"}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Review */}
      {step === 4 && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Review and finish</h2>
          <p className="text-sm text-muted-foreground">
            Confirm your settings. You can change everything later in Settings.
          </p>

          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <p className="text-muted-foreground">Legal name</p>
                <p className="font-medium">{org.legalName || "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">GSTIN</p>
                <p className="font-mono text-sm">{org.gstin || "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">City</p>
                <p className="font-medium">{org.city || "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">State</p>
                <p className="font-medium">{org.state || "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Fiscal year start</p>
                <p className="font-medium">
                  {MONTHS.find((m) => m.value === fiscal.fiscalYearStartMonth)?.label}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Currency</p>
                <p className="font-medium">{fiscal.currency}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Timezone</p>
                <p className="font-medium">{fiscal.timezone}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Industry</p>
                <p className="font-medium">
                  {industryOptions.find((o) => o.value === industry)?.label ?? industry}
                </p>
              </div>
            </div>
          </div>

          <div className="flex justify-between pt-4">
            <button
              type="button"
              onClick={() => setStep(3)}
              disabled={pending}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={handleComplete}
              disabled={pending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? "Completing..." : "✓ Finish setup"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
