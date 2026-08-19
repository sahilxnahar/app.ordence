"use client";

import * as React from "react";
import type {
  IndustryKey,
  Terminology,
  DashboardWidget,
} from "@/lib/industry-templates";

/**
 * Publishes the active industry template to client components.
 *
 * The server layout resolves the template once per request; this context makes
 * the vocabulary available to any descendant without prop-drilling or a second
 * database read.
 */

type IndustryContextValue = {
  industryKey: IndustryKey;
  terminology: Terminology;
  dashboard: readonly DashboardWidget[];
  assetTypes: readonly string[];
  /** Look up an industry-specific noun. Returns the key itself if unmapped. */
  t: (key: string, fallback?: string) => string;
};

const IndustryContext = React.createContext<IndustryContextValue | null>(null);

export function IndustryProvider({
  industryKey,
  terminology,
  dashboard,
  assetTypes,
  children,
}: {
  industryKey: IndustryKey;
  terminology: Terminology;
  dashboard: readonly DashboardWidget[];
  assetTypes: readonly string[];
  children: React.ReactNode;
}) {
  const value = React.useMemo<IndustryContextValue>(
    () => ({
      industryKey,
      terminology,
      dashboard,
      assetTypes,
      t: (key, fallback) => terminology[key] ?? fallback ?? key,
    }),
    [industryKey, terminology, dashboard, assetTypes],
  );

  return <IndustryContext.Provider value={value}>{children}</IndustryContext.Provider>;
}

/**
 * Read the active industry template.
 * Throws when used outside the provider — a silent fallback would ship the wrong
 * vocabulary to production without anyone noticing.
 */
export function useIndustry(): IndustryContextValue {
  const ctx = React.useContext(IndustryContext);
  if (!ctx) {
    throw new Error("useIndustry() must be used inside the (crm) layout.");
  }
  return ctx;
}

/** Convenience hook for terminology only. */
export function useTerm(): (key: string, fallback?: string) => string {
  return useIndustry().t;
}
