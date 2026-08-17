/**
 * Ordence — Platform Console · User Detail
 * Version: v0.80.0-alpha
 *
 * Shows one person across all their workspace memberships. The operator
 * can change their role or status in any workspace they belong to.
 *
 * ⚠️ Every status/role change writes to the CUSTOMER'S audit log.
 */

import { consoleHref, onConsoleHost } from "@/lib/platform/console-href";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlatformUserDetail } from "@/server/platform/users";
import { UserActions } from "@/components/platform/user-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  platform_super_admin: "Super Admin",
  tenant_owner: "Owner",
  tenant_admin: "Admin",
  security_admin: "Security",
  billing_admin: "Billing",
  manager: "Manager",
  member: "Member",
  read_only: "Read Only",
  guest: "Guest",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  invited: "secondary",
  suspended: "destructive",
  offboarded: "outline",
};

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // ⚠️ The console is served at two base paths. See
  // `lib/platform/console-href.ts` , a `/platform/...` link on the
  // console host is not a rewritten path and lands on a 404.
  const isConsole = await onConsoleHost();

  const { id } = await params;
  const decodedId = decodeURIComponent(id);

  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-md bg-muted" />}>
      <UserDetailBody clerkUserId={decodedId} />
    </Suspense>
  );
}

async function UserDetailBody({ clerkUserId }: { clerkUserId: string }) {
  // ⚠️ Two base paths for this console. See `lib/platform/console-href.ts`.
  const isConsole = await onConsoleHost();

  const result = await getPlatformUserDetail(clerkUserId);

  if (!result.ok) {
    notFound();
  }

  const user = result.data;

  return (
    <div className="space-y-6">
      {/* ---- breadcrumb ---- */}
      <nav className="text-sm text-muted-foreground">
        <Link href={consoleHref("/platform", isConsole)} className="hover:underline">Platform</Link>
        <span className="px-2">/</span>
        <Link href={consoleHref("/platform/users", isConsole)} className="hover:underline">Users</Link>
        <span className="px-2">/</span>
        <span>{user.fullName || user.email}</span>
      </nav>

      {/* ---- header ---- */}
      <div className="flex items-start gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted">
          {user.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatarUrl} alt="" className="h-16 w-16 rounded-full" />
          ) : (
            <span className="text-2xl font-semibold text-muted-foreground">
              {(user.fullName || user.email).charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {user.fullName || user.email}
          </h1>
          <p className="text-sm text-muted-foreground">{user.email}</p>
          <div className="flex gap-2 pt-1">
            <Badge variant="secondary">
              {user.totalTenants} workspace{user.totalTenants === 1 ? "" : "s"}
            </Badge>
            <Badge variant="outline">
              {user.activeTenants} active
            </Badge>
          </div>
        </div>
      </div>

      {/* ---- memberships ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace memberships</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4">Workspace</th>
                  <th className="pb-2 pr-4">Role</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Department</th>
                  <th className="pb-2 pr-4">Last seen</th>
                  <th className="pb-2 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {user.memberships.map((m) => (
                  <tr key={m.userId} className="border-b border-border/50">
                    <td className="py-3 pr-4">
                      <Link
                        href={`/platform/tenants/${m.tenantId}`}
                        className="font-medium hover:underline"
                      >
                        {m.tenantName}
                      </Link>
                      <p className="text-xs text-muted-foreground">{m.tenantSlug}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge variant="secondary">{ROLE_LABELS[m.role] ?? m.role}</Badge>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge variant={STATUS_VARIANTS[m.status] ?? "outline"}>{m.status}</Badge>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">{m.department || "—"}</td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {m.lastSeenAt
                        ? new Date(m.lastSeenAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
                        : "Never"}
                    </td>
                    <td className="py-3 pr-4">
                      <UserActions
                        userId={m.userId}
                        tenantId={m.tenantId}
                        currentRole={m.role}
                        currentStatus={m.status}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
