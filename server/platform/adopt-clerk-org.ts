/**
 * Ordence , ⭐⭐⭐ THE CONSOLE CREATES THE CLERK ORGANISATION ITSELF
 * Version: v1.90.0-alpha · Wave 1 · Option A
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS CLOSES, AND FOLLOWING THE OLD INSTRUCTION CAUSED IT
 * ══════════════════════════════════════════════════════════════════════
 * `provisionTenant()` inserts the tenant with a placeholder,
 * `clerk_org_id = 'pending:<slug>'`, because an external call cannot be
 * rolled back with a transaction. It then returned a PROSE instruction to
 * the operator:
 *
 *     "Create the Clerk organisation and invite {email} as owner, then
 *      replace the placeholder clerk_org_id."
 *
 * ⚠️ NOTHING IN CODE DID THAT STEP, AND DOING IT BY HAND MADE THINGS
 *    WORSE RATHER THAN FINISHING THE JOB:
 *
 *   ① The operator creates the organisation in Clerk's dashboard.
 *   ② `organization.created` fires. `organizationUpsert()` looks the
 *      workspace up by `clerk_org_id = org.id` and finds NOTHING, because
 *      the row still says `pending:acme`.
 *   ③ So the webhook provisions a SECOND workspace , and `acme` is
 *      already held by the pending row, so `claimSlugWithFallback` gives
 *      the customer `acme-2` or worse.
 *
 * Result: one unreachable workspace on the good hostname, and one real
 * workspace on a hostname nobody chose. Verified: nothing anywhere
 * reconciles the `pending:` marker , two comments mention it and no code
 * reads it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ OPTION A: DO THE STEP, DO NOT DOCUMENT IT
 * ══════════════════════════════════════════════════════════════════════
 * `server/actions/claim.ts` already creates organisations this way for
 * self-serve signup and has done since v1.7x. This makes the console the
 * SAME shape rather than a second one.
 *
 * 🔴 WHY NOT THE OTHER OPTION , the webhook adopting a pending row by
 *    matching its slug. It is a smaller change and it opens a hijack:
 *    anyone who can create a Clerk organisation named `acme` would adopt
 *    a workspace provisioned for somebody else. Closing that needs the
 *    intended owner's identity on the row, which the console does not
 *    store. A security surface to save an afternoon is a bad trade.
 *
 * ⚠️ THE ORDER IS TRANSACTION FIRST, CLERK SECOND, AND IT CANNOT BE
 *    REVERSED. The slug claim must be atomic , that is the whole argument
 *    of `claim-slug.ts` , and Clerk cannot join a Postgres transaction.
 *    So the window between them is real, and this file's job is to make
 *    that window RECOVERABLE rather than to pretend it does not exist.
 */

import "server-only";

import { clerkClient } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CLERK CANNOT CREATE AN ORGANISATION WITHOUT AN EXISTING USER
 * ══════════════════════════════════════════════════════════════════════
 * `createOrganization` requires `createdBy`, a Clerk USER ID, and omitting
 * it produces an OWNERLESS organisation , `server/actions/claim.ts` learned
 * that and says so. The console, meanwhile, collects an owner EMAIL,
 * because at provisioning time that is genuinely all anybody has.
 *
 * ⚠️ SO THERE ARE TWO CASES AND THEY ARE NOT THE SAME PROBLEM:
 *
 *   ① The owner already has a Clerk account. Resolve the email to their
 *      id and create the organisation with them as owner. Done.
 *
 *   ② The owner has never signed in. There is NO id to create the
 *      organisation with, and no honest way to invent one.
 *
 * 🔴 THE TEMPTING ANSWER TO ② IS TO CREATE THE ORGANISATION WITH THE
 *    OPERATOR AS `createdBy`, AND IT IS WRONG. That makes an Ordence
 *    employee a member , the OWNER , of a customer's workspace, and
 *    removing them afterwards is a step somebody will forget on the day
 *    they are busy. A support person quietly inside a customer's books is
 *    exactly the thing row-level security exists to prevent, arriving
 *    through the front door instead.
 *
 * ⭐ SO ② IS A DISTINCT, RECOVERABLE OUTCOME, and the workspace waits.
 *    It has its hostname and its chart of accounts; what it does not have
 *    is an owner, and the honest thing is to say so and let the operator
 *    send an invitation. `listPendingProvisions()` is how it is found
 *    again , this state is a row on a screen, never a thing somebody
 *    remembers.
 */
export type AdoptOutcome =
  | { ok: true; clerkOrgId: string }
  /**
   * ⚠️ THE WORKSPACE EXISTS AND IS ON ITS HOSTNAME. Only the organisation
   * is missing, and `resumePendingProvision()` can be run again , which is
   * why this is a distinct outcome rather than an error string.
   */
  | { ok: false; recoverable: true; reason: string }
  /**
   * ⭐ THE OWNER HAS NO CLERK ACCOUNT YET. Distinct from a transient
   * failure, because the remedy is different: nobody should retry this,
   * somebody should invite the customer.
   */
  | { ok: false; recoverable: true; needsOwnerInvite: true; ownerEmail: string; reason: string }
  /** The slug is not usable in Clerk at all. A human has to choose again. */
  | { ok: false; recoverable: false; reason: string };

/**
 * Resolve an owner's email to a Clerk user id.
 *
 * ⚠️ EXACT MATCH ON A VERIFIED ADDRESS ONLY. `getUserList` takes an
 * `emailAddress` filter and Clerk matches it exactly, which is what we
 * want , a fuzzy match here would hand a customer's workspace to whoever
 * happened to hold a similar address.
 */
export async function resolveOwnerUserId(email: string): Promise<string | null> {
  const client = await clerkClient();
  const list = await client.users.getUserList({ emailAddress: [email], limit: 2 });
  /*
   * ⚠️ MORE THAN ONE MATCH IS A REFUSAL, NOT A PICK. Clerk should not
   * return two users for one address, and if it ever does, choosing one
   * silently is choosing whose workspace this becomes.
   */
  if (list.totalCount !== 1) return null;
  return list.data[0]?.id ?? null;
}

/**
 * Create the Clerk organisation for a workspace that has already claimed
 * its slug, and replace the `pending:` placeholder with the real id.
 *
 * ⚠️ `createdBy` IS NOT OPTIONAL. Clerk's backend API creates an
 * OWNERLESS organisation when it is omitted, and the customer is then
 * unable to select the workspace that was just made for them.
 * `server/actions/claim.ts` learned this the hard way and says so.
 */
export async function createOrgForProvisionedTenant(args: {
  tenantId: string;
  slug: string;
  name: string;
  /** Clerk user id of the owner. NOT an email , Clerk wants the id. */
  ownerUserId: string;
}): Promise<AdoptOutcome> {
  let organizationId: string;

  try {
    const client = await clerkClient();
    const organization = await client.organizations.createOrganization({
      name: args.name,
      /*
       * 🔴 THE ADDRESS GOES IN AS THE ORGANISATION'S SLUG, and it is the
       *    whole mechanism: `organizationUpsert()` reads `org.slug`, and
       *    `middleware.ts` compares the hostname label against this same
       *    value on every request. An organisation whose slug differs
       *    from the workspace's is a workspace nobody can reach.
       */
      slug: args.slug,
      createdBy: args.ownerUserId,
    });
    organizationId = organization.id;
  } catch (error) {
    /*
     * ⚠️ CLASSIFIED BY WHICH PARAMETER CLERK OBJECTED TO, NOT BY MESSAGE
     *    TEXT. Same discipline as `claim.ts`: if the objection is to
     *    `slug` the address is genuinely unusable and a human must choose
     *    again; anything else , organisations disabled, a limit reached,
     *    Clerk down , is transient, and telling an operator "that address
     *    is taken" would send them to change a thing that was never wrong.
     */
    const text = JSON.stringify(error ?? "");
    const aboutSlug = /"slug"/.test(text) || /slug/i.test(String((error as Error)?.message ?? ""));
    console.error(`[provision] createOrganization failed for ${args.slug}:`, error);
    return aboutSlug
      ? {
          ok: false,
          recoverable: false,
          reason:
            `Clerk refused the address "${args.slug}". The workspace row exists and holds that ` +
            `slug in Ordence, so this has to be resolved by choosing a different address , ` +
            `renaming the workspace , rather than by retrying.`,
        }
      : {
          ok: false,
          recoverable: true,
          reason:
            `The workspace was created and holds "${args.slug}", but Clerk did not create the ` +
            `organisation. Nothing is lost. Run "resume pending provisioning" for this ` +
            `workspace once Clerk is reachable.`,
        };
  }

  /*
   * ⭐ THE UPDATE IS GUARDED ON THE PLACEHOLDER, not on the tenant id
   * alone. If the Clerk webhook has already raced us and filled the
   * column in, `pending:` is gone, this UPDATE matches nothing, and the
   * outcome is still correct , which is what makes calling this twice
   * safe. An unguarded UPDATE would overwrite a real organisation id with
   * a second one and strand the first.
   */
  const updated = await withPlatformScope(
    `Replacing the pending clerk_org_id placeholder for workspace ${args.slug} with the ` +
      `organisation Clerk just created. There is no tenant session at provisioning time.`,
    async (tx) => {
      const result = await tx.execute(sql`
        UPDATE tenants
           SET clerk_org_id = ${organizationId},
               updated_at   = now()
         WHERE id = ${args.tenantId}::uuid
           AND clerk_org_id LIKE 'pending:%'
        RETURNING id
      `);
      const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
      return Array.isArray(rows) ? rows.length : 0;
    },
  );

  if (updated === 0) {
    /*
     * ⚠️ NOT AN ERROR. The webhook got there first, which is the ordinary
     * outcome when Clerk is fast. Saying "failed" here would send an
     * operator to fix a workspace that is already correct.
     */
    console.info(
      `[provision] ${args.slug}: clerk_org_id was already set , the webhook won the race. ` +
        `Nothing to do.`,
    );
  }

  return { ok: true, clerkOrgId: organizationId };
}

/**
 * ⭐ THE LIST THE OLD INSTRUCTION ASKED AN OPERATOR TO KEEP IN THEIR HEAD.
 *
 * A workspace whose organisation was never created is invisible , it has
 * a hostname, a chart of accounts and no way in. This is the query that
 * finds them, and it exists so that an interrupted provision is a row on
 * a screen rather than something discovered when a customer complains.
 */
export async function listPendingProvisions(): Promise<
  readonly { tenantId: string; slug: string; name: string; createdAt: string }[]
> {
  return withPlatformScope(
    "Listing workspaces whose Clerk organisation was never created. Platform-wide by nature.",
    async (tx) => {
      const result = await tx.execute(sql`
        SELECT id::text AS "tenantId", slug, name, created_at::text AS "createdAt"
          FROM tenants
         WHERE clerk_org_id LIKE 'pending:%'
           AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 200
      `);
      const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
      return (Array.isArray(rows) ? rows : []) as readonly {
        tenantId: string;
        slug: string;
        name: string;
        createdAt: string;
      }[];
    },
  );
}
