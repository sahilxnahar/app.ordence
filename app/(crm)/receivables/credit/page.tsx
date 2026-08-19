/**
 * Ordence — Credit control
 * Version: v1.46.0-alpha (Batch 40)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE THING THIS PAGE IS FOR IS NOT ON THIS PAGE
 * ══════════════════════════════════════════════════════════════════════
 * A customer's exposure was invisible and nothing stopped an order going
 * out to somebody who had stopped paying. This screen makes the first
 * half visible. THE SECOND HALF IS ENFORCED IN `confirmOrder`, inside
 * its transaction, by a throw — not here.
 *
 * ⚠️ THAT SEPARATION IS THE DESIGN AND NOT AN ACCIDENT OF SEQUENCING. A
 * screen-only check is a mistake guard: it stops the salesperson who did
 * not know, and it is invisible to `curl`. Deleting this file would
 * change nothing about whether a held customer can be shipped to, which
 * is the only test of whether a control is real.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE PAGE CANNOT PRINT A HEADROOM FIGURE IT CANNOT VOUCH FOR
 * ══════════════════════════════════════════════════════════════════════
 * `getCreditControlBoard` reconciles each customer's billed exposure two
 * ways — off `sales_invoices.received_minor` and off
 * `customer_receipt_allocations` — and when the two disagree the row's
 * `figures` object is ABSENT from the payload rather than present behind
 * a boolean. A component that ignored the gate would fail to compile.
 *
 * The committed-but-unbilled half has no second source and never can;
 * it is included in the total, labelled where it is shown, and declared
 * unverified in a note. See `lib/credit/headroom.ts`.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  getCreditControlBoard,
  /**
   * ⭐⭐⭐ WAVE 10 — THE WRITE HALF, WHICH HAD NO CALLER.
   *
   * 🔴 This board showed every customer's exposure, headroom and hold
   * state and could change none of it. Setting a limit, placing a hold,
   * releasing one, overriding one for a single order, capping what each
   * role may approve, and running the sweep were nine guarded, tested
   * server actions reachable from nowhere.
   */
  getCreditPosition,
  placeCreditHold,
  recordCreditHoldOverride,
  releaseCreditHold,
  removeApprovalLimit,
  runDunningSweep,
  setApprovalLimit,
  setCreditHold,
  setCreditTerms,
} from "@/server/actions/credit";
import { CreditControlBoard } from "@/components/credit/credit-control-board";
import { CreditControls } from "./credit-controls";
import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { SYSTEM_ROLE_VALUES } from "@/db/schema/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata = { title: "Credit control · Ordence" };

async function BoardBody() {
  const result = await getCreditControlBoard({});

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Credit control unavailable</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {result.error}
        </CardContent>
      </Card>
    );
  }

  const ctx = await requirePageContext();
  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };

  return (
    <>
      <CreditControlBoard rows={result.data.rows} scopeNote={result.data.scopeNote} />

      {/*
        ⭐ WAVE 10 — the controls sit BELOW the board, because the board
        is what somebody came here to read and the controls are what they
        do about it.
      */}
      <CreditControls
        rows={result.data.rows.map((row) => ({
          companyId: row.companyId,
          companyName: row.companyName,
          onHold: row.onHold,
          holdId: row.holdId,
          holdSource: row.holdSource,
        }))}
        /*
          ⚠️ `platform_super_admin` IS EXCLUDED. It is an Ordence staff
          role, never assignable inside a workspace, and an approval
          ceiling on it would be a control the customer cannot enforce.
        */
        roles={SYSTEM_ROLE_VALUES.filter((role) => role !== "platform_super_admin")}
        canManageCredit={can(subject, "sales.credit.manage")}
        canApproveOrderCredit={can(subject, "sales.orders.approve_credit")}
        canManageRoles={can(subject, "roles:manage")}
        getPosition={getCreditPosition}
        setTerms={setCreditTerms}
        setHold={setCreditHold}
        placeHold={placeCreditHold}
        releaseHold={releaseCreditHold}
        recordOverride={recordCreditHoldOverride}
        setApprovalLimit={setApprovalLimit}
        removeApprovalLimit={removeApprovalLimit}
        runSweep={runDunningSweep}
      />
    </>
  );
}

export default function CreditControlPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Credit control</h1>
        <p className="text-sm text-muted-foreground">
          Who is exposed, who is held, and what the dunning ladder does next.{" "}
          <Link className="underline" href="/receivables">
            Receivables ageing
          </Link>{" "}
          covers the construction side, which is a different counterparty.
        </p>
      </header>

      {/*
        ⚠️ A HOLD IS STATED IN WORDS ON THE PAGE, not only implied by a
        red badge in a table. The person reading this is deciding whether
        to chase a colleague about an order that was refused, and the
        answer — "a hold is refused at the write, an over-limit order is
        routed for approval" — is the whole of what they need.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What a hold does</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            A hold <strong>refuses</strong> the confirmation of an order. It does
            not send it for approval and nothing releases it by waiting — the way
            past it is to lift the hold, or to record an override against one
            specific order, with a reason, by somebody who may approve credit.
          </p>
          <p>
            An order that is merely over the customer&rsquo;s limit is different:
            it is routed to approval, because the business answer to
            &ldquo;₹40,000 over&rdquo; is almost never no.
          </p>
          <p>
            An automatic hold never lifts itself. When the money arrives, the
            release is a decision with a person&rsquo;s name on it.
          </p>
        </CardContent>
      </Card>

      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle>Loading credit positions…</CardTitle>
            </CardHeader>
          </Card>
        }
      >
        <BoardBody />
      </Suspense>
    </div>
  );
}
