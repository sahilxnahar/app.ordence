"use client";

/**
 * Ordence — CRM error boundary
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * Without a boundary, one thrown exception anywhere under `(crm)` replaces
 * the entire application with Next.js's unstyled default:
 *
 *     Application error: a server-side exception has occurred
 *     Digest: 817564861
 *
 * No navigation, no branding, no way forward, and a number that means
 * nothing to the person reading it. Every page in the group is lost
 * because one panel on one of them failed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE DIGEST IS SHOWN RATHER THAN HIDDEN
 * ══════════════════════════════════════════════════════════════════════
 * Next.js deliberately withholds server error messages from the browser —
 * correctly, since they can carry table names, query fragments and
 * occasionally values. What it does send is a digest: a hash that appears
 * in BOTH this page and the server log.
 *
 * So the digest is displayed prominently and labelled as something to
 * quote. It is useless to an attacker and it is the only thing that turns
 * "a customer says it broke" into a specific line in the log — where
 * `instrumentation.ts` has written the real message beside the same digest.
 *
 * ⚠️ `error.message` is NOT rendered. In production Next.js replaces it
 * with a generic string anyway, and rendering it in development trains
 * everyone to expect detail that will not be there when it matters.
 */

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function CrmError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Browser-side console only. The server-side counterpart in
    // `instrumentation.ts` is the one that carries the real message.
    console.error("[ordence] client boundary caught:", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-widest text-primary">
          Ordence
        </p>
        <h1 className="text-2xl font-bold tracking-tight">This screen failed to load</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Your data is safe and nothing was changed. The failure was recorded
          with the reference below.
        </p>
      </div>

      {error.digest ? (
        <div className="rounded-md border border-border bg-muted/40 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Reference
          </p>
          <code className="font-mono text-sm">{error.digest}</code>
          <p className="mt-1 text-xs text-muted-foreground">
            Quote this when reporting the problem.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-center gap-3">
        {/*
          `reset()` re-renders the failed boundary without a full page load.
          Worth offering first: a good share of server errors are transient —
          a cold database, a dropped connection — and clicking this is faster
          and less alarming than being told to try again later.
        */}
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
        <Button asChild variant="ghost">
          {/*
            Deliberately offered here. When a page fails, the first useful
            question is whether the DEPLOYMENT is healthy or just this
            screen — and /api/diag answers exactly that, in one click,
            without anyone needing to open Cloudflare.
          */}
          <Link href="/api/diag">Check system status</Link>
        </Button>
      </div>
    </main>
  );
}
