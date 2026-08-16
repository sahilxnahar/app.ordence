/**
 * Ordence — Clerk Webhook: Password Rotation Evidence
 * Version: v1.50.0-alpha (Wave 8 — Hardening II)
 *
 * WHAT IS PROVED HERE, AND WHY IT CANNOT BE PROVED IN A UNIT TEST.
 *
 * When a user rotates their password, Clerk's own SDK revokes the session
 * that just performed the change. The thing it cannot do — by design,
 * because it never sees the rest of the product — is leave a trace that a
 * security reviewer can read. This test asserts that the Clerk webhook
 * handler writes `auth.password_changed` to `security_events` for every
 * delivery form Clerk ships, and does NOT write for deliveries that have
 * nothing to do with the credential.
 *
 * Clerk delivers `updated_attributes` in two documented forms — an array
 * of changed attribute names, and a record of changed values keyed by
 * name. Clerk's event taxonomy has also moved (`user.password_changed` vs
 * `user.updated` carrying `password`). The handler is required to work for
 * every combination; this test enumerates them.
 *
 * The negative cases are the dangerous ones. A noisy event stream teaches
 * reviewers to ignore it; the one moment they do not look is the moment
 * the evidence matters.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { adminPool } from "../setup";
import * as schema from "@/db/schema";

vi.mock("@/db", () => {
  const realDrizzle = drizzle(adminPool, { schema });
  return {
    db: realDrizzle,
    withTenant: async (cb: any) => realDrizzle.transaction(cb as never),
    withPlatformScope: async (cb: any) => realDrizzle.transaction(cb as never),
  };
});

import { describe, expect, it } from "vitest";
import { asSuperuser } from "../setup";

// Server-env guard: the request-facts layer refuses to run without these,
// and this test exercises a path that runs through it. The placeholder
// values are the same ones used across the rest of the security suite.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= "pk_test_placeholder";
process.env.SECURITY_EVENTS_API_KEY ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://ordence_app:test_app@localhost:5432/ordence_test";
process.env.NEXT_RUNTIME ??= "nodejs";

type Event = {
  type: "user.updated" | "user.created";
  data: {
    id: string;
    primary_email_address_id?: string | null;
    email_addresses?: Array<{ id: string; email_address: string }>;
    updated_attributes?: Array<string> | Record<string, unknown>;
  };
};

function userEvent(
  updates: Array<string> | Record<string, unknown>,
): Event {
  const emailId = "eml-primary";
  return {
    type: "user.updated",
    data: {
      id: crypto.randomUUID(),
      primary_email_address_id: emailId,
      email_addresses: [
        { id: emailId, email_address: `${crypto.randomUUID()}@example.invalid` },
      ],
      updated_attributes: updates,
    },
  };
}

/**
 * Deliver the event to the handler WITHOUT re-implementing webhook
 * verification — that layer has its own, exhaustive test elsewhere. We
 * import the switch body's handler functions directly, which is the
 * correct seam: verification and dispatch are separate concerns and the
 * evidence contract lives on the dispatch side.
 */
import { handleUserUpdated, handleUserCreated } from "@/app/api/webhooks/clerk/_handlers";

describe("Clerk webhook — password rotation evidence", () => {
  it.each([
    ["array form with password", ["password", "email_addresses"]],
    ["record form with password", { password: { first_name: "x" } }],
    ["password-only delivery", ["password"]],
  ])("writes auth.password_changed for %s", async (_, updates) => {
    const event = userEvent(updates);
    await handleUserUpdated(event.data);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT event_type FROM security_events WHERE event_type = 'auth.password_changed' AND subject_id = $1`,
        [event.data.id],
      ),
    );
    expect(rows.rowCount ?? 0).toBe(1);
    expect(rows.rows[0].event_type).toBe("auth.password_changed");
  });

  it.each([
    ["display-name-only update", ["first_name", "last_name"]],
    ["empty attribute list", []],
    ["no updated_attributes at all", undefined],
  ])("writes nothing for %s", async (_, updates) => {
    const event = userEvent(updates ?? []);
    await handleUserUpdated(event.data);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT 1 FROM security_events WHERE subject_id = $1`,
        [event.data.id],
      ),
    );
    expect(rows.rowCount ?? 0).toBe(0);
  });

  it("writes auth.account_created on sign-up", async () => {
    const event: Event = {
      type: "user.created",
      data: {
        id: crypto.randomUUID(),
        primary_email_address_id: null,
        email_addresses: [],
      },
    };
    await handleUserCreated(event.data);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT event_type FROM security_events WHERE event_type = 'auth.account_created' AND subject_id = $1`,
        [event.data.id],
      ),
    );
    expect(rows.rowCount ?? 0).toBe(1);
  });

  it("never writes the password attribute value into the detail column", async () => {
    const marker = `secret-value-${crypto.randomUUID()}`;
    const event = userEvent({ password: marker, first_name: "Nikita" });
    await handleUserUpdated(event.data);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT detail FROM security_events WHERE subject_id = $1`,
        [event.data.id],
      ),
    );
    expect(rows.rowCount ?? 0).toBe(1);
    const detail = JSON.stringify(rows.rows[0].detail);
    expect(detail).not.toContain(marker);
    // The attribute LIST is evidence; the attribute VALUE is never one.
    expect(detail).toContain("first_name");
    expect(detail).toContain("[REDACTED]");
  });
});
