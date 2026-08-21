/**
 * Ordence — Settings ▸ Custom domain
 * Version: v1.94.0-alpha (Wave 3B)
 *
 * The screen exists in the SAME commit as the enforcement in
 * `server/tenant-context.ts`, and that is not a preference. Wave 3B made
 * an unverified hostname refuse every sign-in; shipping that refusal
 * without the screen that clears it would have turned a security fix
 * into a lockout with no way out of it.
 */

import { requirePageContext } from "@/server/tenant-context";
import { CustomDomainForm } from "@/components/domain/custom-domain-form";
import {
  domainChallengeRecord,
  DomainVerificationUnavailableError,
} from "@/lib/domains/verification";
import type { CustomDomainState } from "@/server/actions/custom-domain";

export const dynamic = "force-dynamic";

export default async function CustomDomainSettingsPage() {
  const ctx = await requirePageContext();
  const domain = ctx.tenant.customDomain ?? null;

  /*
   * ⚠️ THE MISSING SECRET IS REPORTED, NOT SWALLOWED. Without it no
   * record can be derived, and a screen that simply showed no record
   * would read as "there is nothing to do" on a deployment where
   * verification is impossible.
   */
  let record: CustomDomainState["record"] = null;
  let unavailable = false;
  if (domain) {
    try {
      record = domainChallengeRecord(ctx.tenant.id, domain);
    } catch (err) {
      if (err instanceof DomainVerificationUnavailableError) unavailable = true;
      else throw err;
    }
  }

  const initial: CustomDomainState = {
    domain,
    verifiedAt: ctx.tenant.customDomainVerifiedAt?.toISOString() ?? null,
    record,
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Custom domain</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Use an address you own instead of your Ordence subdomain. Your subdomain keeps working
          either way.
        </p>
      </div>

      {unavailable ? (
        <p role="alert" className="rounded-md border border-border p-4 text-sm text-destructive">
          Domain verification is not configured on this deployment. Custom domains cannot be
          verified until it is.
        </p>
      ) : null}

      <CustomDomainForm initial={initial} />
    </div>
  );
}
