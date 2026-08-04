/**
 * Ordence — Rendering A Refusal
 * Version: v0.24.0-alpha
 *
 * ⚠️ A refusal is RENDERED, not thrown.
 *
 * Every automations read passes through gates that answer to different
 * people: "upgrade your plan", "ask your administrator for
 * `workflows:read`", "your workspace is read-only". Throwing would
 * replace all three with one error page and lose the distinction that
 * makes them useful — the same reasoning as `app/(crm)/sales/leads`.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";

export function Refusal({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/settings/billing">View plan</Link>
      </Button>
    </div>
  );
}
