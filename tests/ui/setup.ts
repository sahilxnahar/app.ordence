/**
 * Ordence — UI Test Setup
 * Version: v0.7.0-alpha
 *
 * Stubs the few Next.js and third-party modules that a component reaches for
 * but that have no meaning outside a browser running the real app.
 *
 * Everything stubbed here is genuinely inert plumbing — a router push, a
 * toast. Nothing that carries a rule being tested is mocked. In particular
 * the Zod schemas, the balance arithmetic and the dynamic field renderer are
 * all the real implementations; mocking any of those would make these tests
 * assert that the mocks work.
 */

import "@testing-library/jest-dom/vitest";
import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/*
 * PUBLIC ENVIRONMENT VALUES.
 *
 * `lib/env.ts` parses `clientEnv` at MODULE SCOPE and throws if a
 * NEXT_PUBLIC_* value is missing. That is deliberate and correct for the
 * application — a missing publishable key should fail the build loudly
 * rather than produce a half-working sign-in page.
 *
 * It does mean that any module transitively importing `lib/env.ts`
 * explodes under test unless these exist. That surfaced twice: once when
 * the security recorder was added to the upload route, and again when the
 * metering quota gate was. Both times it presented as nineteen unrelated
 * AUTHORISATION tests failing, which points at exactly the wrong place.
 *
 * These are obvious dummies. Nothing under test reads their values — only
 * their presence. Setting them here rather than loosening the schema keeps
 * the production guarantee intact.
 */
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= "pk_test_dummy_for_unit_tests";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_ROOT_DOMAIN ??= "localhost:3000";

/*
 * `server-only` throws unless it is resolved under React's server
 * condition. Modules guarded by it are still SERVER modules — the guard is
 * what proves they cannot reach a client bundle — but a test runner needs
 * to be able to import them to exercise their logic. Stubbing the guard
 * does not weaken it: the real protection is the build-time resolution,
 * which is unaffected by anything here.
 */
vi.mock("server-only", () => ({}));

/* next/navigation — no router exists in jsdom. */
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(),
}));

/* sonner — toasts render into a portal we do not mount. */
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
  Toaster: () => null,
}));

/* jsdom does not implement these; Radix and our own components call them. */
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });

  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  }
}

afterEach(() => {
  cleanup();
});
