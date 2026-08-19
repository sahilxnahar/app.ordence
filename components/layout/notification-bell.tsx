"use client";

/**
 * Ordence — Notification Bell
 * Version: v0.81.0-alpha
 *
 * Bell icon in the CRM header showing unread count. Clicking opens a
 * dropdown with the latest unread notifications and a link to the full
 * notification center.
 */

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  listNotifications,
  markAsRead,
  markAllAsRead,
  type NotificationRow,
} from "@/server/actions/notifications";

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-blue-500",
  success: "bg-green-500",
};

const CATEGORY_ICON: Record<string, string> = {
  compliance: "📋",
  finance: "💰",
  gst: "🧾",
  inventory: "📦",
  receivables: "📞",
  field_ops: "🔧",
  system: "⚙️",
};

export function NotificationBell() {
  const router = useRouter();
  const [unread, setUnread] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch unread notifications on mount and on route change.
  useEffect(() => {
    let cancelled = false;

    async function fetchUnread() {
      const res = await listNotifications({ filter: "unread", limit: 8 });
      if (cancelled) return;
      if (res.ok) {
        setUnread(res.rows);
        setUnreadCount(res.rows.length);
      }
    }

    fetchUnread();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close dropdown when clicking outside.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleMarkRead(id: string) {
    setUnread((prev) => prev.filter((n) => n.id !== id));
    setUnreadCount((c) => Math.max(0, c - 1));
    await markAsRead(id);
  }

  async function handleMarkAllRead() {
    setUnread([]);
    setUnreadCount(0);
    setOpen(false);
    await markAllAsRead();
    router.refresh();
  }

  function formatTime(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 hover:bg-muted"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        {/* Bell SVG */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-background shadow-lg">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {unread.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <span className="mb-1 text-2xl">✓</span>
                <p className="text-sm text-muted-foreground">All caught up</p>
              </div>
            ) : (
              unread.map((n) => (
                <div
                  key={n.id}
                  className="flex gap-3 border-b border-border/50 px-4 py-3 hover:bg-muted/30"
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[n.severity] ?? SEVERITY_DOT.info}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{n.title}</p>
                    {n.body && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
                    )}
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">{formatTime(n.createdAt)}</span>
                      <span className="text-[10px] text-muted-foreground">·</span>
                      <span className="text-[10px] text-muted-foreground">
                        {CATEGORY_ICON[n.category] ?? "•"} {n.category}
                      </span>
                    </div>
                    <div className="mt-1.5 flex gap-2">
                      {n.actionUrl && (
                        <Link
                          href={n.actionUrl}
                          onClick={() => {
                            handleMarkRead(n.id);
                            setOpen(false);
                          }}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          View
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={() => handleMarkRead(n.id)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        Mark read
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-border px-4 py-2.5 text-center text-sm font-medium text-primary hover:bg-muted/30"
          >
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
