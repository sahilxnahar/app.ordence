/**
 * Ordence — Provider Registry
 * Version: v0.11.0-alpha
 */

import "server-only";

import type { PaymentProvider } from "@/db/schema/billing";
import type { PaymentProviderAdapter } from "./types";
import { razorpayAdapter } from "./razorpay";
import { stripeAdapter } from "./stripe";
import { manualAdapter } from "./manual";

const ADAPTERS: Readonly<Record<PaymentProvider, PaymentProviderAdapter>> = Object.freeze({
  razorpay: razorpayAdapter,
  stripe: stripeAdapter,
  manual: manualAdapter,
});

export function getAdapter(provider: PaymentProvider): PaymentProviderAdapter {
  return ADAPTERS[provider];
}

/** Providers whose keys are actually present in this environment. */
export function configuredProviders(): PaymentProvider[] {
  return (Object.keys(ADAPTERS) as PaymentProvider[]).filter((key) =>
    ADAPTERS[key].isConfigured(),
  );
}

/**
 * Pick a provider for a currency.
 *
 * INR goes to Razorpay when available: it settles domestically, supports
 * UPI and NetBanking, and avoids the cross-border fee Stripe applies to
 * an Indian card. Everything else prefers Stripe. If the preferred one is
 * not configured the other is used rather than failing — a customer
 * unable to pay at all is worse than a customer paying on the second-best
 * rail.
 */
export function selectProviderForCurrency(currency: string): PaymentProvider | null {
  const available = new Set(configuredProviders());
  const preference: PaymentProvider[] =
    currency.toUpperCase() === "INR"
      ? ["razorpay", "stripe"]
      : ["stripe", "razorpay"];

  for (const candidate of preference) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}

export { razorpayAdapter, stripeAdapter, manualAdapter };
export * from "./types";
