import Link from "next/link";

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
      <p className="text-xs text-muted-foreground">v0.1.0-alpha</p>
    </main>
  );
}
