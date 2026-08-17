/**
 * Ordence — Platform Console · User Directory
 * Version: v0.80.0-alpha
 *
 * The platform-wide user directory. Lists every user across every
 * workspace, grouped by Clerk identity so a person who belongs to three
 * tenants appears once, not three times.
 *
 * ⚠️ This is a READING page. Controls to change a user's status or role
 * are on the detail page (`/platform/users/[clerkUserId]`).
 *
 * ⚠️ Every control is a URL — filters, sorting, paging. No client state.
 * A view can be pasted into a ticket and reproduced exactly.
 */

import { consoleHref, onConsoleHost } from "@/lib/platform/console-href";
import { Suspense } from "react";
import Link from "next/link";
import { listAllUsers, listAllTenantsForFilter, type UserSortKey } from "@/server/platform/users";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PAGE_SIZE = 100;

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

function readParams(params: Record<string, string | string[] | undefined>) {
  const str = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  return {
    query: str("q"),
    status: str("status") ?? "all",
    role: str("role") ?? "all",
    tenantId: str("tenant") ?? "all",
    sort: (str("sort") ?? "email") as UserSortKey,
    direction: (str("dir") === "asc" ? "asc" : "desc") as "asc" | "desc",
    offset: Math.max(0, Number.parseInt(str("offset") ?? "0", 10) || 0),
  };
}

function hrefWith(
  current: ReturnType<typeof readParams>,
  changes: Partial<Record<"q" | "status" | "role" | "tenant" | "sort" | "dir" | "offset", string>>,
): string {
  const search = new URLSearchParams();
  const base: Record<string, string> = {
    q: current.query ?? "",
    status: current.status,
    role: current.role,
    tenant: current.tenantId,
    sort: current.sort,
    dir: current.direction,
    offset: String(current.offset),
  };
  for (const [key, value] of Object.entries({ ...base, ...changes })) {
    if (!value || value === "all" || (key === "offset" && value === "0")) continue;
    search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `/platform/users?${qs}` : "/platform/users";
}

export default async function UsersPage({ searchParams }: { searchParams: SearchParams }) {
  // ⚠️ The console is served at two base paths. See
  // `lib/platform/console-href.ts` , a `/platform/...` link on the
  // console host is not a rewritten path and lands on a 404.
  const isConsole = await onConsoleHost();

  const params = readParams(await searchParams);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <nav className="text-sm text-muted-foreground">
          <Link href={consoleHref("/platform", isConsole)} className="hover:underline">Platform</Link>
          <span className="px-2">/</span>
          <span>Users</span>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          Every person across every workspace. Grouped by identity — a person in three tenants appears once.
        </p>
      </header>

      <Suspense fallback={<div className="h-64 animate-pulse rounded-md bg-muted" />}>
        <UsersTable params={params} />
      </Suspense>
    </div>
  );
}

async function UsersTable({ params }: { params: ReturnType<typeof readParams> }) {
  const [usersResult, tenantsResult] = await Promise.all([
    listAllUsers(params),
    listAllTenantsForFilter(),
  ]);

  if (!usersResult.ok) {
    return (
      <Card>
        <CardContent className="pt-4">
          <p className="text-sm text-destructive">{usersResult.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { rows, total } = usersResult.data;
  const tenantList = tenantsResult.ok ? tenantsResult.data : [];

  return (
    <div className="space-y-4">
      {/* ---- filters ---- */}
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="mb-1 block text-xs text-muted-foreground">Search</label>
          <Input
            name="q"
            defaultValue={params.query ?? ""}
            placeholder="Name or email…"
            className="h-9"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Status</label>
          <select
            name="status"
            defaultValue={params.status}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="suspended">Suspended</option>
            <option value="offboarded">Offboarded</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Role</label>
          <select
            name="role"
            defaultValue={params.role}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="all">All roles</option>
            <option value="tenant_owner">Owner</option>
            <option value="tenant_admin">Admin</option>
            <option value="security_admin">Security</option>
            <option value="billing_admin">Billing</option>
            <option value="manager">Manager</option>
            <option value="member">Member</option>
            <option value="read_only">Read Only</option>
            <option value="guest">Guest</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Workspace</label>
          <select
            name="tenant"
            defaultValue={params.tenantId}
            className="h-9 max-w-[200px] rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="all">All workspaces</option>
            {tenantList.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Filter
        </button>
      </form>

      {/* ---- table ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {rows.length} of {total} users
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No users match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4">
                      <Link href={hrefWith(params, { sort: "email", dir: params.sort === "email" && params.direction === "desc" ? "asc" : "desc" })} className="hover:underline">
                        Name
                      </Link>
                    </th>
                    <th className="pb-2 pr-4">Email</th>
                    <th className="pb-2 pr-4">Role</th>
                    <th className="pb-2 pr-4">Status</th>
                    <th className="pb-2 pr-4 text-center">Workspaces</th>
                    <th className="pb-2 pr-4">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((user) => (
                    <tr key={user.clerkUserId} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="py-3 pr-4">
                        <Link
                          href={`/platform/users/${encodeURIComponent(user.clerkUserId)}`}
                          className="font-medium hover:underline"
                        >
                          {user.fullName || user.email}
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">{user.email}</td>
                      <td className="py-3 pr-4">
                        <Badge variant="secondary">{ROLE_LABELS[user.highestRole] ?? user.highestRole}</Badge>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant={STATUS_VARIANTS[user.status] ?? "outline"}>{user.status}</Badge>
                      </td>
                      <td className="py-3 pr-4 text-center">{user.tenantCount}</td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {user.lastSeenAt
                          ? new Date(user.lastSeenAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
                          : "Never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ---- paging ---- */}
          {total > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Showing {params.offset + 1}–{Math.min(params.offset + PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex gap-2">
                {params.offset > 0 && (
                  <Link
                    href={hrefWith(params, { offset: String(Math.max(0, params.offset - PAGE_SIZE)) })}
                    className="text-sm hover:underline"
                  >
                    ← Previous
                  </Link>
                )}
                {params.offset + PAGE_SIZE < total && (
                  <Link
                    href={hrefWith(params, { offset: String(params.offset + PAGE_SIZE) })}
                    className="text-sm hover:underline"
                  >
                    Next →
                  </Link>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
