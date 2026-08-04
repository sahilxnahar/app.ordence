/**
 * Ordence — Rendering A Refusal
 * Version: v0.27.0-alpha
 *
 * ⚠️ A refusal is RENDERED, not thrown.
 *
 * Every read on these screens passes through gates that answer to
 * different people: "your plan does not include custom objects", "ask your
 * administrator for `custom_objects:read`", "this workspace is read-only".
 * Throwing would replace all three with one error page and lose the
 * distinction that makes them useful — the same reasoning as
 * `app/(crm)/automations/refusal.tsx`.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";

export function Refusal({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="mt-4 flex justify-center gap-2">
        <Button asChild variant="outline">
          <Link href="/objects">Record types</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/settings/billing">View plan</Link>
        </Button>
      </div>
    </div>
  );
}
