/**
 * What may leave this server in an error report.
 *
 * ⚠️ EVERY TEST HERE IS A LEAK THAT WOULD OTHERWISE BE SILENT. A Sentry
 * event is not a log line — it crosses a border and sits in a third
 * party's database. Nothing in this file fails loudly in production; it
 * fails by a cookie being somewhere it should not be, discovered later
 * by somebody else.
 */
import { describe, expect, it } from "vitest";
import {
  isSensitiveKey,
  scrubEvent,
  scrubHeaders,
  scrubRecord,
  scrubUrl,
} from "@/lib/observability/scrub";

describe("🔴 the query string is removed wholesale", () => {
  it("keeps the path and drops everything after it", () => {
    expect(scrubUrl("https://app.ordence.com/orders?q=Acme+Steel&token=abc")).toBe(
      "https://app.ordence.com/orders",
    );
  });

  it("drops a fragment too", () => {
    expect(scrubUrl("/invoices#secret")).toBe("/invoices");
  });

  it("leaves a clean path alone", () => {
    expect(scrubUrl("/invoices/123")).toBe("/invoices/123");
  });

  /** A search box puts a customer's own words in ?q=. */
  it("does not try to decide which params are safe", () => {
    expect(scrubUrl("/search?safe=1")).toBe("/search");
  });
});

describe("🔴 headers are an allowlist, not a denylist", () => {
  it("keeps only content-type and user-agent", () => {
    const out = scrubHeaders({
      cookie: "__session=live-clerk-session",
      authorization: "Bearer sk_live_xxx",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(out).toEqual({ "content-type": "application/json", "user-agent": "Mozilla/5.0" });
  });

  /** A denylist fails on the first header nobody anticipated. */
  it("drops a header that no denylist would have predicted", () => {
    expect(scrubHeaders({ "x-ordence-internal-key": "abc" })).toEqual({});
  });
});

describe("🔴 sensitive keys are matched by shape, not by spelling", () => {
  it.each([
    "authorization",
    "Cookie",
    "CLERK_SECRET_KEY",
    "db_password",
    "x-api-key",
    "sessionToken",
    "customerEmail",
    "phone_number",
    "gstin",
    "panNumber",
  ])("flags %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["orderId", "status", "lineNo", "quantity"])("allows %s", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("🔴 nested objects are replaced, never walked", () => {
  it("does not recurse into an attacker-shaped payload", () => {
    const out = scrubRecord({ body: { deep: { deeper: { cookie: "leak" } } } });
    expect(out.body).toBe("[object]");
    expect(JSON.stringify(out)).not.toContain("leak");
  });

  it("reports an array's length rather than its contents", () => {
    expect(scrubRecord({ items: [1, 2, 3] }).items).toBe("[array:3]");
  });

  it("keeps useful scalars", () => {
    expect(scrubRecord({ orderId: "SO-1", count: 3 })).toEqual({ orderId: "SO-1", count: 3 });
  });
});

describe("🔴 the whole event", () => {
  /**
   * The request object is REBUILT from nothing, so a field the SDK adds
   * in a future version is excluded by default rather than shipped by
   * accident.
   */
  it("rebuilds request rather than deleting fields from it", () => {
    const event = scrubEvent({
      request: {
        url: "https://app.ordence.com/orders?q=secret",
        query_string: "q=secret",
        data: { password: "hunter2" },
        cookies: { __session: "live" },
        headers: { cookie: "live", "content-type": "application/json" },
      },
    });

    expect(event.request).toEqual({
      url: "https://app.ordence.com/orders",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.stringify(event)).not.toContain("hunter2");
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  /** An email is the most identifying field a support system can hold. */
  it("keeps the user id and drops email, username and ip", () => {
    const event = scrubEvent({
      user: {
        id: "user_123",
        email: "sahil@ordence.com",
        username: "sahil",
        ip_address: "203.0.113.9",
      },
    });
    expect(event.user).toEqual({ id: "user_123" });
    expect(JSON.stringify(event)).not.toContain("ordence.com");
  });

  it("drops the user object entirely when there is no id", () => {
    expect(scrubEvent({ user: { email: "x@y.com" } }).user).toEqual({});
  });

  /**
   * The one people forget: a fetch breadcrumb carries the full URL of
   * every request the page made, including the query strings just
   * removed from the event itself.
   */
  it("scrubs breadcrumb data too", () => {
    const event = scrubEvent({
      breadcrumbs: [{ message: "fetch", data: { authorization: "Bearer live" } }],
    });
    expect(event.breadcrumbs?.[0]?.data?.authorization).toBe("[redacted]");
    expect(JSON.stringify(event)).not.toContain("Bearer live");
  });

  it("leaves an event with nothing sensitive untouched", () => {
    const event = scrubEvent({ message: "TenantAccessError" });
    expect(event.message).toBe("TenantAccessError");
  });
});
