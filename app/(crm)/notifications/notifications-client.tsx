"use client";

/**
 * Ordence — Notification Center
 * Version: v0.81.0-alpha
 *
 * Full-page notification list with filtering by category and read state.
 * Supports mark-as-read, mark-all-read, and dismiss actions.
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  listNotifications,
  markAsRead,
  markAllAsRead,
  dismissNotification,
  type NotificationRow,
  type NotificationFilter,
} from "@/server/actions/notifications";

const SEVERITY_STYLE: Record<string, { dot: string; border: string; badge: string }> = {
  critical: { dot: "bg-red-500", border: "border-l-red-500", badge: "bg-red-100 text-red-700" },
  warning: { dot: "bg-amber-500", border: "border-l-amber-500", badge: "bg-amber-100 text-amber-700" },
  info: { dot: "bg-blue-500", border: "border-l-blue-500", badge: "bg-blue-100 text-blue-700" },
  success: { dot: "bg-green-500", border: "border-l-green-500", badge: "bg-green-100 text-green-700" },
};

const CATEGORIES = [
  { value: "all", label: "All categories" },
  { value: "compliance", label: "Compliance" },
  { value: "finance", label: "Finance" },
  { value: "gst", label: "GST" },
  { value: "receivables", label: "Receivables" },
  { value: "inventory", label: "Inventory" },
  { value: "field_ops", label: "Field operations" },
  { value: "system", label: "System" },
];

export default function NotificationsClient() {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [category, setCategory] = useState("all");
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listNotifications({
      filter,
      category,
      limit: 100,
    });
    if (res.ok) {
      setRows(res.rows);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [filter, category]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  async function handleMarkRead(id: string) {
    setRows((prev) =>
      prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
    );
    await markAsRead(id);
  }

  async function handleMarkAllRead() {
    setRows((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    await markAllAsRead();
  }

  async function handleDismiss(id: string) {
    setRows((prev) => prev.filter((n) => n.id !== id));
    await dismissNotification(id);
  }

  function formatTime(iso: string): string {
    const date = new Date(iso);
    return date.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const unreadCount = rows.filter((r) => !r.readAt && !r.dismissedAt).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {unreadCount > 0
              ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
              : "All caught up"}
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Mark all as read
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-border">
          {(["all", "unread", "read"] as NotificationFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-sm capitalize ${
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="h-32 animate-pulse rounded-md bg-muted" />
      )}

      {/* Empty */}
      {!loading && rows.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
          <span className="mb-2 text-3xl">🔔</span>
          <p className="text-sm text-muted-foreground">
            No notifications{filter !== "all" ? ` (${filter})` : ""} yet.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Alerts from compliance deadlines, receivables, GST, and more will appear here.
          </p>
        </div>
      )}

      {/* List */}
      {!loading && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((n) => {
            const style = SEVERITY_STYLE[n.severity] ?? SEVERITY_STYLE.info;
            const isUnread = !n.readAt && !n.dismissedAt;

            return (
              <div
                key={n.id}
                className={`rounded-lg border border-border border-l-4 ${style!.border} ${isUnread ? "bg-background" : "bg-muted/20"} p-4`}
              >
                <div className="flex items-start gap-3">
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${style!.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className={`text-sm ${isUnread ? "font-semibold" : "font-medium"}`}>
                        {n.title}
                      </p>
                      {isUnread && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${style!.badge}`}>
                          New
                        </span>
                      )}
                    </div>
                    {n.body && (
                      <p className="mt-1 text-sm text-muted-foreground">{n.body}</p>
                    )}
                    {n.actionUrl && (
                      <Link
                        href={n.actionUrl}
                        onClick={() => !n.readAt && handleMarkRead(n.id)}
                        className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                      >
                        View details →
                      </Link>
                    )}
                    <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{formatTime(n.createdAt)}</span>
                      <span>·</span>
                      <span className="capitalize">{n.category}</span>
                      {n.source && (
                        <>
                          <span>·</span>
                          <span>via {n.source}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    {isUnread && (
                      <button
                        type="button"
                        onClick={() => handleMarkRead(n.id)}
                        className="rounded text-xs text-muted-foreground hover:text-foreground"
                        title="Mark as read"
                      >
                        ✓ Read
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDismiss(n.id)}
                      className="rounded text-xs text-muted-foreground hover:text-foreground"
                      title="Dismiss"
                    >
                      ✕ Dismiss
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
