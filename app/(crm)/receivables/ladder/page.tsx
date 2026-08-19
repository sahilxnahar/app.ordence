/**
 * Ordence — ⭐⭐⭐ THE RERA STATUTORY LADDER
 * Version: v1.67.0-alpha · SQL 0111
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ENGINE HAS BEEN FINISHED SINCE PHASE 38 AND HAD NO FACE
 * ══════════════════════════════════════════════════════════════════════
 * `sendDunningNotice` and `planDunning` are `"use server"` exports with a
 * permission model, an escalation gate, four database constraints and a
 * letter renderer in six languages. Until this page they had NO IMPORTER
 * ANYWHERE in `app/` or `components/`. A legal instrument that decides
 * whether a family keeps its flat was reachable only by somebody willing
 * to hand-craft an RPC call.
 *
 * ⚠️ THAT IS THIS CODEBASE'S OWN RECURRING DEFECT — built, correct, and
 * reached by nothing. `0100` shipped a whole depreciation engine and no
 * navigation touched it for four batches. Built-and-unreachable is the
 * same defect wearing a different hat, and this page is the hat coming
 * off.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND IT IS A SCREEN RATHER THAN A CRON, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * The permission depends on the rung. A cancellation warning needs
 * `receivables:warn_cancellation`, a key the accountant who does every
 * other collections task does not hold, because that letter precedes
 * terminating an allotment and forfeiting what a family has paid towards
 * a home. A CRON HOLDS NO PERMISSION AT ALL. Putting this on a clock
 * would not be running it as somebody with the right; it would be
 * removing the right from the design.
 *
 * ⚠️ THE GUARDS ARE ON THE ACTIONS, NOT ON THIS ROUTE. The board itself
 * needs `receivables:read`, which is wide on purpose — the arrears are
 * read by the site, by sales and by the CFO in the same week. Every ACT
 * is guarded at its own rung's key inside the action that performs it.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  getDunningLadderBoard,
  previewDunningNotice,
  recordNoticeDeemedService,
  recordNoticePostalService,
  sendDunningNotice,
} from "@/server/actions/receivables";
import {
  DunningLadderBoard,
  type LadderRow,
  type LadderRung,
} from "@/components/receivables/dunning-ladder-board";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireTenantContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import type { PermissionKey } from "@/db/schema/auth";

export const dynamic = "force-dynamic";

export const metadata = { title: "Statutory ladder · Ordence" };

async function LadderBody() {
  const result = await getDunningLadderBoard({});

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>The ladder cannot be shown</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{result.error}</CardContent>
      </Card>
    );
  }

  /*
   * ⭐ WHICH RUNGS THIS PERSON MAY CLIMB, RESOLVED ON THE SERVER.
   *
   * 🔴 `can()` AND NOT `checkPermission()`, AND THE DIFFERENCE IS NOT
   * COSMETIC. `checkPermission` writes a row to `permission_denials`
   * every time it says no — which is exactly right at a call site, where
   * a denial is a signal, and exactly wrong here, where it would write
   * two denial rows for every page view by an accountant doing their job
   * and bury the real ones.
   *
   * ⚠️ ONLY THE LADDER'S OWN KEYS CROSS TO THE BROWSER, and only the ones
   * held. The client compares them against `nextPermission`, which the
   * SERVER derived from `permissionForStage` — so the screen never
   * re-decides which key a rung needs, it only decides whether to draw a
   * button. The refusal that matters is in the action.
   */
  const ctx = await requireTenantContext();
  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const ladderKeys = new Set<PermissionKey>(
    result.data.authority.map((rung) => rung.permission),
  );
  // ⭐ Deeming service is not a rung, and it needs the top rung's key.
  ladderKeys.add("receivables:warn_cancellation");
  const heldPermissions = [...ladderKeys].filter((key) => can(subject, key));

  return (
    <DunningLadderBoard
      asOf={result.data.asOf}
      rows={result.data.rows as LadderRow[]}
      truncated={result.data.truncated}
      authority={result.data.authority as LadderRung[]}
      heldPermissions={heldPermissions}
      onPreview={previewDunningNotice}
      onSend={sendDunningNotice}
      onRecordPostalService={recordNoticePostalService}
      onRecordDeemedService={recordNoticeDeemedService}
    />
  );
}

function Skeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-40 animate-pulse rounded-lg border bg-muted/40" />
      ))}
    </div>
  );
}

export default function DunningLadderPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Statutory ladder</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Which allottees have fallen due for the next rung, how long overdue they are,
          what was served before and when. Reminder, first notice, final notice,
          cancellation warning — in that order, one at a time, each one read in full
          before it goes.
        </p>
        <p className="max-w-3xl text-xs text-muted-foreground">
          ⚠️ Nothing here is on a schedule and nothing here sends in bulk. The last rung
          precedes terminating an allotment and forfeiting what a family has paid; it
          needs a right the person who chases the money does not hold, and a scheduled
          job holds no right at all.
        </p>
        <p className="pt-1 text-xs">
          <Link href="/receivables" className="underline">
            Receivables
          </Link>
          {" · "}
          <Link href="/settings/financial" className="underline">
            Dunning settings
          </Link>
        </p>
      </header>

      <Suspense fallback={<Skeleton />}>
        <LadderBody />
      </Suspense>
    </div>
  );
}
