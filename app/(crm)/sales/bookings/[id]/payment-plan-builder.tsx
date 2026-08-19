"use client";

/**
 * Ordence — ⭐⭐ GENERATING THE PAYMENT PLAN
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ REPLACING A PLAN IS THE DANGEROUS OPERATION HERE
 * ══════════════════════════════════════════════════════════════════════
 * Regenerating over a plan that already has payments recorded against it
 * is how collected money stops lining up with anything. The server has
 * the final word; this refuses to offer the button once a plan exists
 * without an explicit confirmation, because the common case is somebody
 * who has just clicked a template out of curiosity.
 *
 * ⚠️ THE SHARES ARE SHOWN AS PERCENTAGES AND STORED AS BASIS POINTS.
 * 1000 bps is 10%. Displaying bps to a sales manager would be precise and
 * unreadable; storing percentages would lose the third decimal that a
 * 33.33% three-way split needs.
 */

import { useState, useTransition } from "react";
import { ListPlus } from "lucide-react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type PlanTemplateView = {
  key: string;
  name: string;
  description: string;
  stages: { label: string; shareBps: number }[];
};

export function PaymentPlanBuilder(props: {
  bookingId: string;
  hasPlan: boolean;
  templates: readonly PlanTemplateView[];
  generate: (input: unknown) => Promise<Result<{ bookingId: string; stages: number }>>;
}) {
  const [templateKey, setTemplateKey] = useState(props.templates[0]?.key ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = props.templates.find((t) => t.key === templateKey);

  function generate() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await props.generate({ bookingId: props.bookingId, templateKey });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Plan created with ${result.data.stages} stages.`);
      setConfirmed(false);
    });
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ListPlus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {props.hasPlan ? "Replace the payment plan" : "Create a payment plan"}
      </h3>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Template</span>
        <select
          value={templateKey}
          onChange={(e) => setTemplateKey(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {props.templates.map((template) => (
            <option key={template.key} value={template.key}>
              {template.name}
            </option>
          ))}
        </select>
      </label>

      {chosen && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{chosen.description}</p>
          <ul className="divide-y rounded-md border text-sm">
            {chosen.stages.map((stage, i) => (
              <li key={`${stage.label}-${i}`} className="flex justify-between px-3 py-1.5">
                <span>{stage.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {(stage.shareBps / 100).toFixed(2)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {props.hasPlan && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            <span className="block font-medium text-destructive">
              This booking already has a plan.
            </span>
            <span className="block text-xs text-muted-foreground">
              Replacing it rewrites the stages and their due dates. Anything already
              collected stays collected, but it will no longer line up with the stage it was
              recorded against.
            </span>
          </span>
        </label>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      <button
        type="button"
        onClick={generate}
        disabled={pending || templateKey === "" || (props.hasPlan && !confirmed)}
        className="rounded-md border border-input px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Working…" : props.hasPlan ? "Replace the plan" : "Create the plan"}
      </button>
    </div>
  );
}
