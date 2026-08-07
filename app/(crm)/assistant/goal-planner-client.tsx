"use client";

/**
 * Ordence — Goal Planner Client
 * Version: v0.77.0-alpha
 *
 * The user types a natural-language goal, the AI generates a workflow
 * program, and the user reviews it before it can be saved as a draft.
 *
 * 🔴 THE USER MUST REVIEW BEFORE SAVING. The AI can make mistakes —
 * wrong record types, invalid column references, logic errors. The
 * validation errors are shown inline so the user can fix them or
 * try again.
 */

import { useState, useCallback } from "react";
import { Sparkles, Loader2, CheckCircle2, AlertTriangle, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type PlanResult = {
  ok: boolean;
  program?: { steps: unknown[] };
  triggerType?: string;
  triggerConfig?: Record<string, unknown>;
  name?: string;
  description?: string;
  errors: string[];
  warnings: string[];
  reason?: string;
};

export function GoalPlannerClient() {
  const [goal, setGoal] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);

  const plan = useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setResult(null);
    setSavedId(null);

    try {
      const res = await fetch("/api/assistant/goal-planner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: trimmed }),
      });

      const data = (await res.json()) as PlanResult | { error: string };

      if (!res.ok) {
        setResult({
          ok: false,
          errors: [],
          warnings: [],
          reason: (data as { error: string }).error,
        });
        return;
      }

      setResult(data as PlanResult);
    } catch {
      setResult({
        ok: false,
        errors: [],
        warnings: [],
        reason: "Could not reach the goal planner. Check your connection.",
      });
    } finally {
      setLoading(false);
    }
  }, [goal, loading]);

  const save = useCallback(async () => {
    if (!result?.program || !result.triggerType) return;

    setSaving(true);
    setSavedId(null);

    try {
      const res = await fetch("/api/assistant/goal-planner/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: result.name,
          description: result.description,
          triggerType: result.triggerType,
          triggerConfig: result.triggerConfig,
          program: result.program,
        }),
      });

      const data = (await res.json()) as { id?: string; error?: string };

      if (res.ok && data.id) {
        setSavedId(data.id);
      } else {
        setResult({
          ...result,
          errors: [data.error ?? "Could not save the workflow draft."],
          warnings: [],
        });
      }
    } catch {
      setResult({
        ...result,
        errors: ["Could not reach the server to save."],
        warnings: [],
      });
    } finally {
      setSaving(false);
    }
  }, [result]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      plan();
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
      {/* ---- header ---- */}
      <div className="mb-4 flex items-center gap-3">
        <Sparkles className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold">Goal Planner</h1>
          <p className="text-sm text-muted-foreground">
            Describe a goal in plain English. The AI builds a workflow draft you can review and publish.
          </p>
        </div>
      </div>

      {/* ---- input ---- */}
      <div className="mb-4 flex gap-2">
        <Input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. Send a reminder email to every client with an overdue invoice over ₹50,000"
          disabled={loading}
          maxLength={2000}
        />
        <Button onClick={plan} disabled={loading || !goal.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          <span className="ml-1">Plan</span>
        </Button>
      </div>

      {/* ---- result ---- */}
      {result && (
        <div className="flex-1 overflow-y-auto space-y-4">
          {result.reason && !result.errors.length && (
            <Card className="border-destructive/20">
              <CardContent className="pt-4">
                <p className="text-sm text-destructive">{result.reason}</p>
              </CardContent>
            </Card>
          )}

          {result.program && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  {result.ok ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-amber-500" />
                  )}
                  {result.name ?? "Generated workflow"}
                </CardTitle>
                {result.description && (
                  <p className="text-sm text-muted-foreground">{result.description}</p>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {/* ---- metadata ---- */}
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">Trigger: {result.triggerType}</Badge>
                  <Badge variant="secondary">
                    {result.program.steps.length} step{result.program.steps.length === 1 ? "" : "s"}
                  </Badge>
                  {result.warnings.length > 0 && (
                    <Badge variant="outline" className="text-amber-600">
                      {result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"}
                    </Badge>
                  )}
                </div>

                {/* ---- errors ---- */}
                {result.errors.length > 0 && (
                  <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3">
                    <p className="mb-2 text-sm font-medium text-destructive">Validation errors:</p>
                    <ul className="space-y-1 text-xs text-destructive/80">
                      {result.errors.map((err, i) => (
                        <li key={i}>• {err}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* ---- warnings ---- */}
                {result.warnings.length > 0 && (
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                    <p className="mb-2 text-sm font-medium text-amber-600">Warnings:</p>
                    <ul className="space-y-1 text-xs text-amber-600/80">
                      {result.warnings.map((w, i) => (
                        <li key={i}>• {w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* ---- step preview ---- */}
                <div>
                  <p className="mb-2 text-sm font-medium">Steps:</p>
                  <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/50 p-3 text-xs">
                    {JSON.stringify(result.program.steps, null, 2)}
                  </pre>
                </div>

                {/* ---- save button ---- */}
                {savedId ? (
                  <div className="flex items-center gap-2 text-sm text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Saved as a draft. </span>
                    <a
                      href={`/automations/${savedId}`}
                      className="underline hover:text-green-700"
                    >
                      Open in Automations →
                    </a>
                  </div>
                ) : (
                  <Button
                    onClick={save}
                    disabled={saving || result.errors.length > 0}
                    variant={result.errors.length > 0 ? "secondary" : "default"}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    <span className="ml-1">
                      {result.errors.length > 0
                        ? "Fix errors before saving"
                        : "Save as draft"}
                    </span>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {!result && !loading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="space-y-2 text-center">
            <Sparkles className="mx-auto h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Describe a business goal above and the AI will build a workflow.
            </p>
            <div className="pt-2 text-xs text-muted-foreground/70">
              <p>Try: "Email all leads who haven't been contacted in 30 days"</p>
              <p>or: "Create a follow-up task when a booking is cancelled"</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
