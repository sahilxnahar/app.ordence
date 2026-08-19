"use server";

/**
 * Ordence — ⭐⭐⭐ DATA PRINCIPAL RIGHTS
 * Version: v1.68.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE ARE THE MOST DANGEROUS ACTIONS IN THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * `planDataPrincipalExport` reads everything a workspace holds about one
 * named person and hands it back as a file. `runDataPrincipalErasure`
 * deletes it, permanently, with no recycle bin.
 *
 * ⭐ So both require `workspace:export` — the permission that already
 * guards the whole-workspace export, held only by an owner or an admin —
 * and both refuse an impersonated caller. A customer consented to us
 * diagnosing a bug; they did not consent to a support engineer running a
 * subject-access request on one of their customers, and they certainly
 * did not consent to one running an erasure.
 *
 * 🔴 AND THE ERASURE IS RATE-LIMITED WHILE THE EXPORT IS BUDGETED
 * DIFFERENTLY, because the failure modes are opposite: too many exports
 * is exfiltration, and too many erasures is destruction. A single limit
 * tuned for one is wrong for the other.
 */

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { tenants } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { assertImpersonationAllows } from "@/server/platform/impersonation";
import { PermissionDeniedError } from "@/lib/permissions";
import { checkRateLimit, tenantRateLimitKey } from "@/lib/security/rate-limit";
import { PRINCIPAL_KINDS } from "@/lib/dpdp/classification";
import { buildExportPlan } from "@/lib/dpdp/subject-graph";
import { buildErasurePlan, refusalNotice } from "@/lib/dpdp/erasure";
import {
  exportDataPrincipal,
  principalExportFileName,
  serialisePrincipalExport,
} from "@/server/dpdp/export-service";
import { eraseDataPrincipal } from "@/server/dpdp/erasure-service";
import {
  addAnchor,
  createRequest,
  eventsFromErasure,
  eventsFromExport,
  getRequest,
  listRequests,
  nextReference,
  recordAnswer,
  recordEvents,
  subjectFor,
  type RequestRow,
} from "@/server/dpdp/requests";
import { breachBoard, recordBreach, recordIntimation } from "@/server/dpdp/breaches";
import type { ActionResult } from "@/lib/validators/crm";

const EXPORT = "workspace:export" as const;

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function toError(err: unknown, where: string): ActionResult<never> {
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail(err.issues[0]?.message ?? "That is not a valid request.");
  }
  console.error(`[dpdp] ${where}`, err);
  return fail("Something went wrong. Nothing was changed.");
}

async function workspaceName(tenantId: string): Promise<string> {
  const [t] = await withTenant(tenantId, (tx) =>
    tx
      .select({ name: tenants.name, legalName: tenants.legalName })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId)))
      .limit(1),
  );
  return t?.legalName ?? t?.name ?? "this workspace";
}

/* ------------------------------------------------------------------ */
/* RECORDING A REQUEST                                                 */
/* ------------------------------------------------------------------ */

const principalKinds = PRINCIPAL_KINDS as unknown as [string, ...string[]];

const recordSchema = z.object({
  kind: z.enum(["access", "erasure", "correction", "grievance", "consent_withdrawal"]),
  principalLabel: z.string().trim().min(1).max(300),
  principalEmail: z.string().trim().email().max(320).nullish(),
  principalPhone: z.string().trim().max(40).nullish(),
  /**
   * 🔴 TEN CHARACTERS IS NOT AN ARBITRARY MINIMUM.
   *
   * A boolean "verified" records that somebody clicked. This records
   * what they did, and it is the only defence against the failure mode
   * that matters here — answering an access request for somebody who is
   * not the Data Principal, which is itself a personal data breach and
   * which arrives disguised as good service. 0113 puts the same rule in
   * a CHECK constraint so the screen cannot be the only thing enforcing
   * it.
   */
  verifiedHow: z
    .string()
    .trim()
    .min(10, "Say how you established that this person is who they say they are. A tick is not verification."),
  anchors: z
    .array(
      z.object({
        kind: z.enum(principalKinds),
        id: z.string().uuid(),
        establishedBy: z
          .string()
          .trim()
          .min(10, "Say why this record is this person. A shared email address is not a reason."),
      }),
    )
    .max(50),
});

export async function recordDataPrincipalRequest(
  input: unknown,
): Promise<ActionResult<{ id: string; reference: string }>> {
  try {
    const data = recordSchema.parse(input);
    const ctx = await requirePermission(EXPORT);
    await assertImpersonationAllows("export:workspace", ctx);

    const now = new Date();
    const reference = await nextReference(ctx.tenant.id, now.getUTCFullYear());

    const { id } = await createRequest(ctx.tenant.id, {
      reference,
      kind: data.kind,
      principalLabel: data.principalLabel,
      principalEmail: data.principalEmail ?? null,
      principalPhone: data.principalPhone ?? null,
      verifiedHow: data.verifiedHow,
      userId: ctx.user.id,
      now,
    });

    for (const a of data.anchors) {
      await addAnchor(ctx.tenant.id, {
        requestId: id,
        principalKind: a.kind as (typeof PRINCIPAL_KINDS)[number],
        principalId: a.id,
        establishedBy: a.establishedBy,
        userId: ctx.user.id,
      });
    }

    await withTenant(ctx.tenant.id, async () => {
      await writeAudit(ctx, {
        action: "create",
        resourceType: "data_principal_request",
        resourceId: id,
        newValue: { reference, kind: data.kind, anchors: data.anchors.length },
        /** The register a Board would ask to see. */
        severity: "critical",
      });
    });

    revalidatePath("/settings/privacy");
    return { ok: true, data: { id, reference } };
  } catch (err) {
    return toError(err, "recordDataPrincipalRequest");
  }
}

/* ------------------------------------------------------------------ */
/* THE PLAN, BEFORE ANYTHING RUNS                                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT WOULD BE SEARCHED, AND WHAT WOULD BE REFUSED, WITHOUT TOUCHING
 *    A ROW.
 *
 * The plan is pure — `lib/dpdp/subject-graph.ts` opens no connection —
 * so an operator can read the whole shape of the answer before
 * authorising it. That is not a nicety on an operation with no undo.
 */
export async function previewDataPrincipalPlan(
  requestId: unknown,
): Promise<
  ActionResult<{
    searched: number;
    unreachable: number;
    notApplicable: number;
    outOfScope: number;
    refusals: { provision: string; period: string; tables: string[]; needsAHuman: boolean }[];
    blocked: boolean;
    unreachableTables: string[];
  }>
> {
  try {
    const id = z.string().uuid().parse(requestId);
    const ctx = await requirePermission(EXPORT);

    const subject = await subjectFor(ctx.tenant.id, id);
    if (!subject) return fail("That request could not be found.");
    if (subject.anchors.length === 0 && subject.identifiers.emails.length === 0) {
      return fail(
        "This request has no verified records against it and no email address, so there is nothing to search. " +
          "Add at least one record you have established belongs to this person.",
      );
    }

    const exportPlan = buildExportPlan(subject);
    const erasure = buildErasurePlan({ exportPlan });

    return {
      ok: true,
      data: {
        searched: exportPlan.summary.searched,
        unreachable: exportPlan.summary.unreachable,
        notApplicable: exportPlan.summary.notApplicable,
        outOfScope: exportPlan.summary.outOfScope,
        refusals: erasure.refusals.map((r) => ({
          provision: r.rule.provision,
          period: r.rule.period,
          tables: [...r.tables],
          needsAHuman: r.needsAHuman,
        })),
        blocked: erasure.blocked,
        unreachableTables: exportPlan.tables
          .filter((t) => t.verdict === "no-reach")
          .map((t) => t.table),
      },
    };
  } catch (err) {
    return toError(err, "previewDataPrincipalPlan");
  }
}

/* ------------------------------------------------------------------ */
/* THE EXPORT                                                          */
/* ------------------------------------------------------------------ */

export async function runDataPrincipalExport(
  requestId: unknown,
): Promise<ActionResult<{ json: string; fileName: string; rows: number; notSearched: number }>> {
  try {
    const id = z.string().uuid().parse(requestId);
    const ctx = await requirePermission(EXPORT);
    /**
     * 🔴 THE SAME REFUSAL AS THE WORKSPACE EXPORT, FOR A SHARPER REASON.
     * This one returns one named individual's complete record, which is
     * a more useful thing to exfiltrate than a table of stock levels.
     */
    await assertImpersonationAllows("export:workspace", ctx);

    const budget = await checkRateLimit("search", tenantRateLimitKey(ctx.tenant.id, ctx.user.id));
    if (!budget.allowed) {
      return fail(
        "You have run several data-principal exports in a short period. Wait a few minutes and try again.",
      );
    }

    const request = await getRequest(ctx.tenant.id, id);
    if (!request) return fail("That request could not be found.");

    const subject = await subjectFor(ctx.tenant.id, id);
    if (!subject) return fail("That request could not be found.");

    const now = new Date();
    const exported = await exportDataPrincipal({
      tenantId: ctx.tenant.id,
      workspaceName: await workspaceName(ctx.tenant.id),
      subject,
      now,
    });

    /**
     * ⚠️ RECORDED BEFORE THE PAYLOAD LEAVES. If the browser never
     * receives the file the register still shows that a complete copy of
     * one person's data was assembled and left the database.
     */
    await recordEvents(ctx.tenant.id, id, ctx.user.id, eventsFromExport(exported));
    await recordAnswer(ctx.tenant.id, {
      requestId: id,
      manifest: exported.manifest as unknown as Record<string, unknown>,
      refusalNotice: null,
      /** An access request is never blocked; only an erasure is. */
      needsHumanDecision: false,
      now,
    });

    await withTenant(ctx.tenant.id, async () => {
      await writeAudit(ctx, {
        action: "export",
        resourceType: "data_principal_request",
        resourceId: id,
        newValue: {
          reference: request.reference,
          tablesSearched: exported.manifest.summary.searched,
          tablesUnreachable: exported.manifest.summary.unreachable,
        },
        severity: "critical",
      });
    });

    const rows = Object.values(exported.manifest.counts).reduce((a, b) => a + b, 0);

    revalidatePath("/settings/privacy");
    return {
      ok: true,
      data: {
        json: serialisePrincipalExport(exported),
        fileName: principalExportFileName(request.reference, now),
        rows,
        notSearched: exported.manifest.notSearched.filter((n) => n.kind === "no-reach").length,
      },
    };
  } catch (err) {
    return toError(err, "runDataPrincipalExport");
  }
}

/* ------------------------------------------------------------------ */
/* THE ERASURE                                                         */
/* ------------------------------------------------------------------ */

const eraseSchema = z.object({
  requestId: z.string().uuid(),
  /**
   * 🔴 A PER-TABLE DECISION, NOT AN "APPROVE ALL". The engine refers a
   * table when it does not know whether a law holds it back. A single
   * confirm button over that list is a button that gets pressed.
   */
  decisions: z
    .array(z.object({ table: z.string().min(1).max(63), decision: z.enum(["erase", "retain"]) }))
    .max(400)
    .default([]),
  /** The operator types the reference. Slower on purpose. */
  confirmReference: z.string().trim().min(1),
});

export async function runDataPrincipalErasure(
  input: unknown,
): Promise<
  ActionResult<{
    notice: string;
    deleted: Record<string, number>;
    refusedToRun: boolean;
    blockedOn: string[];
    failures: { table: string; reason: string }[];
  }>
> {
  try {
    const data = eraseSchema.parse(input);
    const ctx = await requirePermission(EXPORT);
    await assertImpersonationAllows("export:workspace", ctx);

    const request = await getRequest(ctx.tenant.id, data.requestId);
    if (!request) return fail("That request could not be found.");

    /**
     * ⚠️ TYPING THE REFERENCE IS NOT SECURITY. It is friction on the one
     * operation in this product that cannot be undone, in the same
     * spirit as `platform/control-actions.ts` requiring a justification.
     */
    if (data.confirmReference.trim() !== request.reference) {
      return fail(
        `Type the request reference (${request.reference}) to confirm. This deletes records permanently and there is no recycle bin behind it.`,
      );
    }

    const subject = await subjectFor(ctx.tenant.id, data.requestId);
    if (!subject) return fail("That request could not be found.");
    if (subject.anchors.length === 0) {
      return fail(
        "This request has no verified records against it. Ordence will not erase on the strength of an email address alone: a shared address would erase somebody else.",
      );
    }

    const now = new Date();
    const outcome = await eraseDataPrincipal({
      tenantId: ctx.tenant.id,
      workspaceName: await workspaceName(ctx.tenant.id),
      subject,
      now,
      humanDecisions: new Map(data.decisions.map((d) => [d.table, d.decision])),
    });

    const notice = refusalNotice({
      plan: outcome.plan,
      workspaceName: await workspaceName(ctx.tenant.id),
      principalLabel: request.principalLabel,
      requestReference: request.reference,
      onDate: now.toISOString().slice(0, 10),
    });

    await recordEvents(ctx.tenant.id, data.requestId, ctx.user.id, eventsFromErasure(outcome.plan));
    await recordAnswer(ctx.tenant.id, {
      requestId: data.requestId,
      manifest: {
        deleted: outcome.deleted,
        failures: outcome.failures,
        notes: outcome.notes,
        summary: outcome.plan.summary,
        refusedToRun: outcome.refusedToRun,
      },
      refusalNotice: notice,
      needsHumanDecision: outcome.plan.blocked,
      now,
    });

    await withTenant(ctx.tenant.id, async () => {
      await writeAudit(ctx, {
        action: "delete",
        resourceType: "data_principal_request",
        resourceId: data.requestId,
        newValue: {
          reference: request.reference,
          deleted: outcome.deleted,
          refusedToRun: outcome.refusedToRun,
        },
        /** Irreversible, and about a named individual. */
        severity: "critical",
      });
    });

    revalidatePath("/settings/privacy");
    return {
      ok: true,
      data: {
        notice,
        deleted: outcome.deleted,
        refusedToRun: outcome.refusedToRun,
        blockedOn: outcome.plan.tables.filter((t) => t.action === "refer").map((t) => t.table),
        failures: outcome.failures,
      },
    };
  } catch (err) {
    return toError(err, "runDataPrincipalErasure");
  }
}

/* ------------------------------------------------------------------ */
/* BREACHES                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ARTEFACT s.8(6) REQUIRES, WHICH `security_events` IS NOT.
 *
 * 🔴 EVERY RULE 7 FIELD IS REQUIRED AT INSERT, AND THAT IS DELIBERATELY
 * INCONVENIENT. Rule 7 lists five things an intimation to a Data
 * Principal must contain and there is no materiality threshold to fall
 * back on. A form that accepted a blank "likely consequences" would
 * produce a document that looks like an intimation, goes out, and
 * discharges nothing — the failure that reads as compliance.
 */
const breachSchema = z.object({
  /** 🔴 When it was NOTICED. Both clocks run from here, not from occurrence. */
  noticedAt: z.coerce.date(),
  occurredAt: z.coerce.date().nullish(),
  nature: z.string().trim().min(10, "Say what happened."),
  extent: z.string().trim().min(5, "Say how much was affected."),
  timingAndLocation: z.string().trim().min(5, "Rule 7 asks for the timing and location."),
  likelyConsequences: z.string().trim().min(10, "Say what it may mean for the people affected."),
  mitigationImplemented: z.string().trim().min(5, "Say what has been done about it."),
  safeguardsForPrincipals: z
    .string()
    .trim()
    .min(5, "Say what the affected people can do to protect themselves. Rule 7 requires it."),
  contactPerson: z
    .string()
    .trim()
    .min(5, "Name somebody who can answer questions about this on the workspace's behalf."),
  affectedPrincipalCount: z.coerce.number().int().min(0).nullish(),
});

export async function recordPersonalDataBreach(
  input: unknown,
): Promise<ActionResult<{ id: string; reference: string; breachClass: string; overdue: number }>> {
  try {
    const data = breachSchema.parse(input);
    const ctx = await requirePermission(EXPORT);

    const now = new Date();
    const reference = `PDB-${now.getUTCFullYear()}-${now.getTime().toString(36).toUpperCase().slice(-6)}`;

    const created = await recordBreach(ctx.tenant.id, {
      reference,
      noticedAt: data.noticedAt,
      occurredAt: data.occurredAt ?? null,
      nature: data.nature,
      extent: data.extent,
      timingAndLocation: data.timingAndLocation,
      likelyConsequences: data.likelyConsequences,
      mitigationImplemented: data.mitigationImplemented,
      safeguardsForPrincipals: data.safeguardsForPrincipals,
      contactPerson: data.contactPerson,
      affectedPrincipalCount: data.affectedPrincipalCount ?? null,
      userId: ctx.user.id,
      now,
    });

    /**
     * ⚠️ THE CERT-IN CLOCK MAY ALREADY BE OVERDUE AT THE MOMENT OF
     * RECORDING, and the caller is told immediately rather than
     * discovering it on a dashboard later. Six hours from NOTICING is
     * short enough that a breach entered the next morning is already
     * late, and the honest thing is to say so at once.
     */
    const board = await breachBoard(ctx.tenant.id, now);
    const mine = board.find((b) => b.row.id === created.id);

    await withTenant(ctx.tenant.id, async () => {
      await writeAudit(ctx, {
        action: "create",
        resourceType: "personal_data_breach",
        resourceId: created.id,
        newValue: { reference, breachClass: created.breachClass },
        severity: "critical",
      });
    });

    revalidatePath("/settings/privacy");
    return {
      ok: true,
      data: {
        id: created.id,
        reference,
        breachClass: created.breachClass,
        overdue: mine?.overdue ?? 0,
      },
    };
  } catch (err) {
    return toError(err, "recordPersonalDataBreach");
  }
}

const intimationSchema = z.object({
  id: z.string().uuid(),
  audience: z.enum(["certin", "board", "board_detailed", "principals"]),
  text: z.string().trim().min(1).nullish(),
});

export async function recordBreachIntimation(
  input: unknown,
): Promise<ActionResult<{ blockers: string[] }>> {
  try {
    const data = intimationSchema.parse(input);
    const ctx = await requirePermission(EXPORT);
    const now = new Date();

    /**
     * 🔴 REFUSED BEFORE IT IS WRITTEN, NOT AFTER.
     *
     * Recording that the affected people were told, without keeping what
     * they were told, leaves the workspace unable to show what it said
     * and the person unable to show what they were promised. 0113 has a
     * CHECK for it too; this is the message rather than the 500.
     */
    if (data.audience === "principals" && !data.text) {
      return fail(
        "Paste the intimation exactly as it was sent. What a person was told has to be kept as sent: a template edited later would silently rewrite it.",
      );
    }

    await recordIntimation(ctx.tenant.id, {
      id: data.id,
      audience: data.audience,
      text: data.text ?? null,
      at: now,
    });

    const board = await breachBoard(ctx.tenant.id, now);
    const mine = board.find((b) => b.row.id === data.id);

    await withTenant(ctx.tenant.id, async () => {
      await writeAudit(ctx, {
        action: "update",
        resourceType: "personal_data_breach",
        resourceId: data.id,
        newValue: { audience: data.audience },
        severity: "critical",
      });
    });

    revalidatePath("/settings/privacy");
    return { ok: true, data: { blockers: mine?.blockers ?? [] } };
  } catch (err) {
    return toError(err, "recordBreachIntimation");
  }
}

export async function listPersonalDataBreaches(): Promise<
  ActionResult<
    {
      id: string;
      reference: string;
      breachClass: string;
      status: string;
      noticedAt: Date;
      overdue: number;
      deadlines: { duty: string; provision: string; dueBy: Date; state: string }[];
      blockers: string[];
      missing: string[];
    }[]
  >
> {
  try {
    const ctx = await requirePermission(EXPORT);
    const board = await breachBoard(ctx.tenant.id, new Date());
    return {
      ok: true,
      data: board.map((b) => ({
        id: b.row.id,
        reference: b.row.reference,
        breachClass: b.row.breachClass,
        status: b.row.status,
        noticedAt: b.row.noticedAt,
        overdue: b.overdue,
        deadlines: b.deadlines.map((d) => ({
          duty: d.duty,
          provision: d.provision,
          dueBy: d.dueBy,
          state: d.state,
        })),
        blockers: b.blockers,
        missing: b.missing,
      })),
    };
  } catch (err) {
    return toError(err, "listPersonalDataBreaches");
  }
}

/* ------------------------------------------------------------------ */

export async function listDataPrincipalRequests(): Promise<ActionResult<RequestRow[]>> {
  try {
    const ctx = await requirePermission(EXPORT);
    return { ok: true, data: await listRequests(ctx.tenant.id) };
  } catch (err) {
    return toError(err, "listDataPrincipalRequests");
  }
}
