import Link from "next/link";

export default function AccessDeniedPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-3xl font-bold">Access denied</h1>
      <p className="max-w-md text-muted-foreground">
        Your session does not belong to this workspace. If you believe this is an
        error, contact your workspace administrator.
      </p>
      <Link href="/dashboard" className="text-sm font-medium text-primary underline">
        Return to your dashboard
      </Link>
    </main>
  );
}
