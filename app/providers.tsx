"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * TanStack Query provider.
 *
 * The client is created inside `useState` so each browser session gets its own
 * instance. A module-level client would be shared across requests during SSR —
 * meaning one tenant's cached data could be served to another. That is a genuine
 * cross-tenant leak, not a theoretical one.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
