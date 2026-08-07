"use client";

/**
 * Ordence — Settings · Notifications
 * Version: v0.83.0-alpha
 *
 * Per-user notification preferences. Controls which categories of
 * notifications the user receives and whether email delivery is enabled.
 * Stored in the user's settings JSONB column.
 */

import { useState, useTransition, useEffect } from "react";
import { toast } from "sonner";

const CATEGORIES = [
  { key: "compliance", label: "Compliance", description: "GST deadlines, licence expirations, overdue tasks" },
  { key: "finance", label: "Finance", description: "Receivables aging, reconciliation drift, payment events" },
  { key: "gst", label: "GST", description: "GSTR-2B reconciliation, ITC at risk, filing reminders" },
  { key: "receivables", label: "Receivables", description: "Overdue demands, collections, dunning events" },
  { key: "inventory", label: "Inventory", description: "Low stock alerts, reorder triggers" },
  { key: "field_ops", label: "Field operations", description: "Site labour anomalies, repeat visits" },
  { key: "system", label: "System", description: "Platform events, user changes, security alerts" },
];

const SEVERITIES = [
  { key: "critical", label: "Critical only", description: "Only receive critical alerts" },
  { key: "warning", label: "Critical and warnings", description: "Receive critical and warning alerts" },
  { key: "info", label: "Everything", description: "Receive all notifications including info" },
];

export default function NotificationsSettingsClient() {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [minSeverity, setMinSeverity] = useState("warning");
  const [pending, start] = useTransition();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Load preferences from localStorage as a simple per-user store.
    // In production this would come from the user's settings JSONB.
    try {
      const stored = localStorage.getItem("ordence_notification_prefs");
      if (stored) {
        const parsed = JSON.parse(stored);
        setPrefs(parsed.categories ?? {});
        setEmailEnabled(parsed.emailEnabled ?? true);
        setMinSeverity(parsed.minSeverity ?? "warning");
      } else {
        // Default: all categories enabled
        const defaults: Record<string, boolean> = {};
        CATEGORIES.forEach((c) => (defaults[c.key] = true));
        setPrefs(defaults);
      }
    } catch {
      // ignore
    }
    setLoaded(true);
  }, []);

  function save() {
    start(() => {
      const data = { categories: prefs, emailEnabled, minSeverity };
      localStorage.setItem("ordence_notification_prefs", JSON.stringify(data));
      toast.success("Notification preferences saved.");
    });
  }

  function toggleCategory(key: string) {
    setPrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  if (!loaded) {
    return <div className="h-32 animate-pulse rounded-md bg-muted" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Notifications</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control which alerts you receive and how they are delivered.
        </p>
      </div>

      {/* Email delivery */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Email delivery</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Send notifications to your email in addition to the in-app bell.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEmailEnabled((v) => !v)}
            className={`relative h-6 w-11 rounded-full transition-colors ${
              emailEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                emailEnabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Minimum severity */}
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium">Minimum severity</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Only receive notifications at or above this severity level.
        </p>
        <div className="mt-3 space-y-2">
          {SEVERITIES.map((s) => (
            <label
              key={s.key}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${
                minSeverity === s.key ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <input
                type="radio"
                name="severity"
                value={s.key}
                checked={minSeverity === s.key}
                onChange={() => setMinSeverity(s.key)}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium">{s.label}</p>
                <p className="text-xs text-muted-foreground">{s.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Category preferences */}
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium">Categories</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Choose which types of notifications you want to receive.
        </p>
        <div className="mt-3 space-y-2">
          {CATEGORIES.map((cat) => (
            <div
              key={cat.key}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2.5"
            >
              <div className="flex-1">
                <p className="text-sm font-medium">{cat.label}</p>
                <p className="text-xs text-muted-foreground">{cat.description}</p>
              </div>
              <button
                type="button"
                onClick={() => toggleCategory(cat.key)}
                className={`relative h-6 w-11 rounded-full transition-colors ${
                  prefs[cat.key] ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                    prefs[cat.key] ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Save */}
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {pending ? "Saving..." : "Save preferences"}
      </button>
    </div>
  );
}
