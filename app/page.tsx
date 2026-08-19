import Link from "next/link";

import { APP_VERSION_LABEL } from "@/lib/version";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-primary">
          Ordence
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
          Enterprise CRM Platform
        </h1>
        <p className="mt-4 max-w-md text-muted-foreground">
          Multi-tenant. Edge-first. Built for scale.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/sign-in"
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Sign in
        </Link>
        <Link
          href="/sign-up"
          className="rounded-md border border-border px-5 py-2.5 text-sm font-medium transition hover:bg-accent"
        >
          Create workspace
        </Link>
      </div>
      {/*
        Read from package.json via lib/version.ts — never hardcode this again.
        It doubles as the deployment marker: if this string does not match the
        version you released, the domain is not being served by that release.
      */}
      <p className="text-xs text-muted-foreground">{APP_VERSION_LABEL}</p>

      {/*
        ⭐ THE ONLY FOOTER THIS PRODUCT HAS — Batch 134.

        There is no marketing footer component to hang this off; the
        marketing surface is this page. So the trust page is linked here,
        because a trust page nobody can find answers nobody's question. The
        people who look for it — a customer's chartered accountant, their
        banker — arrive on this page first and look at the bottom.

        ⚠️ Both destinations must exist or `scripts/check-links.mjs` fails:
        `app/(marketing)/trust/page.tsx` and `app/security.txt/route.ts`.
      */}
      <footer className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Link href="/trust" className="underline underline-offset-4 hover:text-foreground">
          Trust &amp; security
        </Link>
        <Link href="/security.txt" className="underline underline-offset-4 hover:text-foreground">
          Report a vulnerability
        </Link>
      </footer>
    </main>
  );
}
