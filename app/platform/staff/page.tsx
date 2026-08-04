/**
 * Ordence — Platform Console · Staff Access
 * Version: v0.14.0-alpha
 *
 * The access review page. It exists so that "who can read every
 * customer's billing record?" is a page somebody can open, rather than a
 * query somebody has to think to run.
 *
 * ⭐ THE COLUMN TO READ IS `On allowlist`. Platform access needs BOTH an
 * entry in `PLATFORM_ADMIN_EMAILS` (a reviewed config deploy) and an
 * active row here. A row whose email is no longer on the allowlist cannot
 * sign in — which is correct — but it is also a stale grant nobody
 * cleaned up, and drift between the two keys is exactly what an access
 * review is for.
 */

import { Suspense } from "react";
import { listPlatformStaff } from "@/server/platform/staff";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default function PlatformStaffPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Platform access</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone who can cross a tenant boundary. Access needs two independent keys:
          the deploy-time <code className="font-mono">PLATFORM_ADMIN_EMAILS</code>{" "}
          allowlist and an active grant below. Revoking either one is enough.
        </p>
      </div>

      <Suspense fallback={<div className="h-40 animate-pulse rounded-md bg-muted" />}>
        <StaffTable />
      </Suspense>
    </div>
  );
}

async function StaffTable() {
  const result = await listPlatformStaff();
  if (!result.ok) return <p className="text-sm text-destructive">{result.error}</p>;

  if (result.data.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No platform grants exist. The console is unreachable until one is created —
        which is the correct state for a fresh deployment.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Person</TableHead>
          <TableHead>Grade</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>On allowlist</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Granted by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.data.map((row) => (
          <TableRow key={row.id} data-testid={`staff-${row.email}`}>
            <TableCell>
              <div className="font-medium">{row.displayName ?? row.email}</div>
              <div className="text-xs text-muted-foreground">{row.email}</div>
            </TableCell>
            <TableCell>{row.gradeLabel}</TableCell>
            <TableCell>
              <Badge variant={row.status === "active" ? "secondary" : "outline"}>
                {row.status}
              </Badge>
            </TableCell>
            <TableCell>
              {row.allowlisted ? (
                <Badge variant="secondary">yes</Badge>
              ) : (
                <Badge variant="destructive">no — stale grant</Badge>
              )}
            </TableCell>
            <TableCell className="text-xs">
              {row.expiresAt ? (
                <span className={row.expired ? "text-destructive" : undefined}>
                  {row.expiresAt.slice(0, 10)}
                  {row.expired ? " (expired)" : ""}
                </span>
              ) : (
                <span className="text-destructive">never — review this</span>
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {row.grantedByEmail ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
