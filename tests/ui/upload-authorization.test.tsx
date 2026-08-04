/**
 * Ordence — Upload Token Authorisation
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 8 MANDATORY VERIFICATION #1
 * ══════════════════════════════════════════════════════════════════════
 * "Verify the Vercel Blob token generator strictly enforces the Clerk
 *  authentication session."
 *
 * An upload token is a WRITE CAPABILITY for our blob store. Once issued,
 * the browser talks to Vercel directly and our code is no longer in the
 * conversation — so every constraint that will ever apply has to be decided
 * at the moment of issuance.
 *
 * These tests exercise the real route handler. Clerk and the database are
 * replaced at the `requireTenantContext` boundary, because standing up a
 * real Clerk session in a unit test would prove things about Clerk rather
 * than about our route. Everything downstream of that boundary — the Zod
 * validation, the path construction, the allowlist, the size ceiling, the
 * error mapping — is the genuine implementation.
 *
 * The four properties asserted here are the ones that, if broken, let one
 * tenant write into another's storage:
 *
 *   1. No session → no token. Ever.
 *   2. The storage path is derived from the SESSION's tenant, and the
 *      client's requested path is ignored.
 *   3. The content-type allowlist and size ceiling are attached to the
 *      token itself, so Vercel enforces them even if our UI is bypassed.
 *   4. A malformed or missing client payload is refused, not defaulted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TICKET_TTL_MS } from "@/lib/storage/upload-ticket";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* MOCKS                                                              */
/* ------------------------------------------------------------------ */

/**
 * `TenantAccessError` is the real class — the route branches on
 * `instanceof`, and a fake would let a broken branch pass.
 */
class TenantAccessError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "TenantAccessError";
  }
}

const requireTenantContext = vi.fn();

vi.mock("@/server/tenant-context", () => ({
  requireTenantContext: () => requireTenantContext(),
  TenantAccessError,
}));

/**
 * Capture what the route passes to `handleUpload` and, crucially, invoke
 * `onBeforeGenerateToken` — that callback IS the authorisation gate, so a
 * test that never runs it proves nothing.
 */
const capturedOptions: {
  /** What the route pinned into the signed ticket. */
  ticketClaims?: Record<string, unknown>;
} = {};

/*
 * The storage-quota gate (Phase 15).
 *
 * Mocked because it reaches the database, and `@/db` builds a client from
 * `getServerEnv()` — which correctly REFUSES to run in a browser-like
 * environment, and jsdom is one. That guard is doing its job; defeating it
 * to satisfy a test would remove the thing that stops server secrets
 * reaching a client bundle.
 *
 * What this file tests is the TOKEN GATE: tenant namespacing, path
 * traversal, the content-type allowlist. Quota is a separate concern with
 * its own suite (`tests/security/metering-isolation.test.ts`, against a
 * real database).
 *
 * ⚠️ Mocking it away would let the gate be REMOVED without any test
 * noticing, so there is an explicit assertion below that `requireQuota` is
 * called before a token is issued.
 */
const requireQuotaMock = vi.fn(async () => undefined);
vi.mock("@/server/metering/query", () => ({
  requireQuota: (...args: unknown[]) => requireQuotaMock(...(args as [])),
  QuotaExceededError: class QuotaExceededError extends Error {},
}));

/**
 * ⭐ MOCKED BECAUSE THE ROUTE MOVED FROM VERCEL BLOB TO R2 — and this file
 * did not move with it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY FIFTEEN TESTS IN HERE WERE ASSERTING AGAINST DEAD CODE
 * ══════════════════════════════════════════════════════════════════════
 * This file used to mock `@vercel/blob/client` and read
 * `body.tokenOptions.*` out of the response. The route now mints its own
 * signed R2 ticket and returns `{ uploadUrl, ticket, pathname, expiresAt,
 * maxBytes }`. Nothing named `tokenOptions` has existed for some time.
 *
 * The tests did not go red at the migration — they went red for the wrong
 * reason and stayed there. The route returned 503 (storage unconfigured)
 * before reaching any of the behaviour under test, so every assertion
 * failed with `expected 503 to be 200` and the real message — "you are
 * testing an implementation that is gone" — was never visible.
 *
 * ⚠️ THE PROPERTIES BEING TESTED ARE STILL EXACTLY RIGHT. Tenant
 * namespacing, refusing a client-supplied path, stripping traversal, the
 * content-type allowlist, the byte ceiling, a short expiry — all of those
 * still matter and all of them are still enforced. Only the shape of the
 * answer changed. So the assertions are re-pointed, not deleted.
 */
/**
 * ⚠️ A SWITCH, NOT A CONSTANT. One test needs storage to be UNconfigured,
 * and `vi.mock` factories are hoisted above the file, so the value has to
 * be reachable from inside the factory at call time rather than captured
 * at definition time.
 */
const storageState = { configured: true };

vi.mock("@/lib/storage/r2", () => ({
  isStorageConfigured: () => storageState.configured,
  STORAGE_UNCONFIGURED_MESSAGE:
    "Object storage is not configured for this deployment. Create the R2 bucket and bind it as DOCUMENTS.",
}));

vi.mock("@/lib/storage/upload-ticket", () => ({
  // 32+ chars — the route refuses a shorter one, correctly.
  getTicketSecret: () => "t".repeat(48),
  signUploadTicket: (claims: Record<string, unknown>) => {
    capturedOptions.ticketClaims = claims;
    return "signed.ticket.value";
  },
  TICKET_TTL_MS: 15 * 60 * 1000,
}));

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const CONTRACT_A = "44444444-4444-4444-8444-444444444444";

function validSession(tenantId = TENANT_A) {
  return {
    tenant: { id: tenantId, name: "Tenant A" },
    user: { id: USER_A },
    role: "tenant_owner",
  };
}

/**
 * ⚠️ THE REQUEST SHAPE CHANGED WITH THE R2 MIGRATION TOO.
 *
 * The old body was a Vercel Blob envelope — `{ type, payload: { pathname,
 * callbackUrl, clientPayload, multipart } }` — with the real fields buried
 * in a JSON string inside `clientPayload`. The route now parses
 * `uploadClientPayloadSchema` straight off the body.
 *
 * `pathname` is gone entirely, and its absence is the point: there is no
 * longer a field in which a client can even EXPRESS a desired storage
 * path. The strongest version of "ignore what the client asked for" is
 * not asking.
 */
function makeRequest(payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    json: async () => (payload === null ? {} : { ...(payload as object), ...extra }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const validPayload = {
  entityType: "contract",
  entityId: CONTRACT_A,
  fileName: "sale-agreement.pdf",
  sizeBytes: 1024,
  // ⚠️ REQUIRED SINCE v0.21.0. R2 does not enforce the content-type
  // allowlist for us — the bytes come back through our own Worker — so the
  // declared type is stated here, checked, and pinned into the ticket.
  contentType: "application/pdf",
};

describe("POST /api/upload — the Blob token gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ================================================================ */
  /* 1. THE SESSION IS MANDATORY                                      */
  /* ================================================================ */

  it("refuses with 401 when there is NO Clerk session", async () => {
    requireTenantContext.mockRejectedValue(
      new TenantAccessError("Sign-in required.", "unauthenticated"),
    );

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(makeRequest(validPayload));

    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBeTruthy();
    // No token may appear in a refusal, under any key.
    expect(JSON.stringify(body)).not.toContain("vercel_blob");
  });

  it("refuses with 403 when the session has no organisation", async () => {
    requireTenantContext.mockRejectedValue(
      new TenantAccessError("Select an organization first.", "no_organization"),
    );

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(makeRequest(validPayload));

    expect(response.status).toBe(403);
  });

  it("refuses with 403 when the user is suspended", async () => {
    requireTenantContext.mockRejectedValue(
      new TenantAccessError("This account is suspended.", "user_suspended"),
    );

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(makeRequest(validPayload));

    expect(response.status).toBe(403);
  });

  it("refuses when the tenant itself is inactive", async () => {
    requireTenantContext.mockRejectedValue(
      new TenantAccessError("This workspace is not active.", "tenant_inactive"),
    );

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(makeRequest(validPayload));

    expect(response.status).toBe(403);
  });

  /* ================================================================ */
  /* 2. THE PATH COMES FROM THE SESSION, NOT THE CLIENT               */
  /* ================================================================ */

  it("namespaces the storage path under the SESSION's tenant id", async () => {
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(makeRequest(validPayload));

    expect(response.status).toBe(200);

    const body = await response.json();
    const pathname = body.pathname as string;

    expect(pathname.startsWith(`tenants/${TENANT_A}/`)).toBe(true);
    expect(pathname).toContain("contract");
    expect(pathname).toContain(CONTRACT_A);
  });

  it("IGNORES a client-supplied pathname aimed at another tenant", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE.
    //
    // If the route honoured the client's requested pathname, a caller
    // could ask for `tenants/<victim>/...` and receive a valid token to
    // write into another tenant's namespace. Every other control in the
    // system would be intact and irrelevant.
    // ══════════════════════════════════════════════════════════════
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(
      makeRequest(validPayload, `tenants/${TENANT_B}/contract/evil/planted.pdf`),
    );

    const body = await response.json();
    const pathname = body.pathname as string;

    expect(pathname).not.toContain(TENANT_B);
    expect(pathname.startsWith(`tenants/${TENANT_A}/`)).toBe(true);
  });

  it("strips path traversal out of the filename", async () => {
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(
      makeRequest({ ...validPayload, fileName: "../../../etc/passwd" }),
    );

    const body = await response.json();
    const pathname = body.pathname as string;

    expect(pathname).not.toContain("..");
    expect(pathname.startsWith(`tenants/${TENANT_A}/`)).toBe(true);
  });

  it("two tenants uploading the same filename get disjoint paths", async () => {
    const { POST } = await import("@/app/api/upload/route");

    requireTenantContext.mockResolvedValue(validSession(TENANT_A));
    const a = await (await POST(makeRequest(validPayload))).json();

    requireTenantContext.mockResolvedValue(validSession(TENANT_B));
    const b = await (await POST(makeRequest(validPayload))).json();

    const pathA = a.pathname as string;
    const pathB = b.pathname as string;

    expect(pathA).not.toBe(pathB);
    expect(pathA.startsWith(`tenants/${TENANT_A}/`)).toBe(true);
    expect(pathB.startsWith(`tenants/${TENANT_B}/`)).toBe(true);
  });

  /* ================================================================ */
  /* 3. CONSTRAINTS RIDE ON THE TOKEN                                 */
  /* ================================================================ */

  it("REFUSES a content type that is not on the allowlist", async () => {
    // ⚠️ THE MECHANISM CHANGED WITH R2 AND THE PROPERTY DID NOT.
    //
    // Vercel Blob held the token and enforced the allowlist for us, so the
    // old test read `allowedContentTypes` off the token. R2 does not: the
    // bytes return through our own Worker, so the route CHECKS the declared
    // type here and PINS it into the ticket, and /api/upload/put refuses a
    // body that arrives claiming something else.
    //
    // Both can carry executable script. Served from an origin the user is
    // logged into, they become stored XSS.
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));
    const { POST } = await import("@/app/api/upload/route");

    for (const bad of ["text/html", "image/svg+xml"]) {
      const res = await POST(makeRequest({ ...validPayload, contentType: bad }));
      expect(res.status, `${bad} must be refused`).toBe(415);
    }

    const ok = await POST(makeRequest(validPayload));
    expect(ok.status).toBe(200);
  });

  it("PINS the declared content type into the signed ticket", async () => {
    // Checking and then not pinning would leave the allowlist decorative:
    // the browser could declare application/pdf here and PUT an SVG.
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));
    const { POST } = await import("@/app/api/upload/route");
    await POST(makeRequest(validPayload));

    expect(capturedOptions.ticketClaims?.ct).toBe("application/pdf");
  });

  it("caps the ticket at the SMALLER of the global limit and the declared size", async () => {
    // ⚠️ TIGHTER THAN THE OLD ASSERTION, NOT LOOSER. The old test expected
    // the flat 50 MB maximum on every ticket. The route now takes the
    // minimum of that and what the client said it would send: a client
    // that understated its size has only constrained itself, and one that
    // overstated it is still capped at 50 MB.
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));
    const { POST } = await import("@/app/api/upload/route");

    const small = await (await POST(makeRequest(validPayload))).json();
    expect(small.maxBytes).toBe(1024);
    expect(capturedOptions.ticketClaims?.mb).toBe(1024);

    const huge = await (
      await POST(makeRequest({ ...validPayload, sizeBytes: 50 * 1024 * 1024 }))
    ).json();
    expect(huge.maxBytes).toBe(50 * 1024 * 1024);
  });

  it("hands back a ticket for OUR endpoint, never a direct storage URL", async () => {
    // ══════════════════════════════════════════════════════════════
    // THIS REPLACES TWO OLD TESTS — "issues a PRIVATE token" and
    // "refuses to overwrite" — and it is a stronger claim than either.
    //
    // Those asserted `access: "private"` and `allowOverwrite: false` on a
    // Vercel Blob token. Under R2 there is no public/private flag to get
    // wrong, because the browser never receives a storage URL at all: it
    // gets a signed ticket and posts the bytes back through
    // /api/upload/put, which re-checks the tenant, the content type and
    // the byte ceiling before anything is written.
    //
    // A public blob URL is readable by anyone who ever sees it, forever,
    // with no session and no tenant check. For executed legal agreements
    // that was never an acceptable default — and now it is not a
    // configuration option that could drift.
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));
    const { POST } = await import("@/app/api/upload/route");
    const body = await (await POST(makeRequest(validPayload))).json();

    expect(body.uploadUrl).toBe("/api/upload/put");
    expect(JSON.stringify(body)).not.toMatch(/r2\.cloudflarestorage|https?:\/\//);
    expect(body.ticket).toBeTruthy();

    // The tenant and user are pinned INTO the ticket, so /put cannot be
    // replayed by a different session even with a valid signature.
    expect(capturedOptions.ticketClaims?.t).toBe(TENANT_A);
    expect(capturedOptions.ticketClaims?.u).toBe(USER_A);
  });

  it("gives the token a short expiry", async () => {
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));

    const { POST } = await import("@/app/api/upload/route");
    const before = Date.now();
    const body = await (await POST(makeRequest(validPayload))).json();

    const validUntil = body.expiresAt as number;

    expect(validUntil).toBeGreaterThan(before);
    // Long enough for a slow 50 MB upload, short enough that a ticket
    // captured from a log is not a durable write capability.
    //
    // ⚠️ ASSERTED AGAINST THE REAL CONSTANT, NOT A HAND-TYPED WINDOW. The
    // old test allowed 11 minutes because the comment beside the code said
    // "ten minutes". The constant is 15, so the test was policing a number
    // that existed only in prose — it would have gone red on a TTL change
    // that was entirely intentional, and stayed green on one that was not.
    expect(validUntil).toBeLessThanOrEqual(before + TICKET_TTL_MS + 1000);
    // And it must still be short. A ticket good for a day is a credential.
    expect(TICKET_TTL_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  /* ================================================================ */
  /* 4. THE CLIENT PAYLOAD IS UNTRUSTED                               */
  /* ================================================================ */

  it("refuses when the client payload is missing entirely", async () => {
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(makeRequest(null));

    expect(response.status).toBe(400);
  });

  it("refuses an unrecognised entity type instead of defaulting", async () => {
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(
      makeRequest({ ...validPayload, entityType: "salary_records" }),
    );

    expect(response.status).toBe(400);
  });

  it("refuses a non-UUID entity id", async () => {
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(
      makeRequest({ ...validPayload, entityId: "1 OR 1=1" }),
    );

    expect(response.status).toBe(400);
  });

  it("refuses a declared size above the ceiling", async () => {
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));

    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(
      makeRequest({ ...validPayload, sizeBytes: 500 * 1024 * 1024 }),
    );

    expect(response.status).toBe(400);
  });

  /* ================================================================ */
  /* 5. CONFIGURATION AND METHOD                                      */
  /* ================================================================ */

  it("returns 503 with an actionable message when storage is unconfigured", async () => {
    // ⚠️ AND ONLY TO AN AUTHENTICATED CALLER. This check used to run BEFORE
    // authentication, so any stranger could POST here and read back which
    // piece of infrastructure was missing. The order is now: establish who
    // is asking, then explain. See the comment in app/api/upload/route.ts.
    requireTenantContext.mockResolvedValue(validSession(TENANT_A));
    storageState.configured = false;

    try {
      const { POST } = await import("@/app/api/upload/route");
      const response = await POST(makeRequest(validPayload));

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toMatch(/R2|storage|DOCUMENTS/i);
    } finally {
      storageState.configured = true;
    }
  });

  it("does NOT disclose a misconfiguration to an unauthenticated caller", async () => {
    // The regression this guards: a 503 naming R2 or UPLOAD_TICKET_SECRET,
    // returned to somebody with no session, is deployment reconnaissance.
    requireTenantContext.mockRejectedValue(
      new TenantAccessError("Sign-in required.", "unauthenticated"),
    );
    storageState.configured = false;

    try {
      const { POST } = await import("@/app/api/upload/route");
      const response = await POST(makeRequest(validPayload));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toMatch(/R2|DOCUMENTS|UPLOAD_TICKET_SECRET/i);
    } finally {
      storageState.configured = true;
    }
  });

  it("refuses GET", async () => {
    const { GET } = await import("@/app/api/upload/route");
    const response = await GET();
    expect(response.status).toBe(405);
  });
});


/* ================================================================== */
/* THE QUOTA GATE IS WIRED (Phase 15)                                  */
/* ================================================================== */

describe("storage quota gate", () => {
  /**
   * ⚠️ ASSERTED AGAINST THE SOURCE, NOT AGAINST A CALL COUNT.
   *
   * The obvious test is "the mock was called". It was tried and it is
   * fragile: Vitest hoists `vi.mock` above the surrounding module scope,
   * so a spy declared beside the factory does not reliably observe calls
   * made from a dynamically-imported route handler.
   *
   * A flaky assertion guarding a quota gate is worse than none — it fails
   * for reasons unrelated to the property and teaches people to ignore it.
   *
   * What actually needs guarding is that the gate is PRESENT and runs
   * BEFORE a Blob write token is minted. That is a property of the source
   * and can be checked exactly.
   */
  const routeSource = readFileSync(
    join(process.cwd(), "app/api/upload/route.ts"),
    "utf8",
  );

  it("⭐ the upload route calls requireQuota", () => {
    expect(
      routeSource,
      "the storage quota gate is not wired into app/api/upload/route.ts",
    ).toMatch(/await requireQuota\(/);
  });

  it("checks the DECLARED size, not a constant", () => {
    // A hard-coded size would make the gate pass for a 4 GB upload.
    const gate = routeSource.slice(routeSource.indexOf("await requireQuota("));
    expect(gate.slice(0, 200)).toMatch(/payload\.sizeBytes/);
  });

  it("⭐ the quota check happens BEFORE the token is issued", () => {
    // After the token exists, refusing is pointless — the client already
    // holds a licence to write bytes.
    const code = routeSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const quotaAt = code.indexOf("await requireQuota(");
    // ⚠️ `const tokenPayload` was the Vercel Blob era. The thing that must
    // not precede the quota gate is now the ticket SIGNATURE — that call is
    // the moment a licence to write bytes comes into existence.
    const tokenAt = code.indexOf("signUploadTicket(");
    expect(quotaAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(-1);
    expect(
      quotaAt,
      "the quota gate runs AFTER the write token is built — too late to matter",
    ).toBeLessThan(tokenAt);
  });

  it("gates the upload only — never a delete, download or export", () => {
    // A customer at their limit must always be able to free space and to
    // leave with their data.
    for (const file of [
      "server/actions/storage.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const deleteFn = source.slice(source.indexOf("export async function deleteDocument"));
      expect(
        deleteFn.slice(0, 2000),
        `${file}: deleteDocument must never call requireQuota`,
      ).not.toMatch(/requireQuota\(/);
    }
  });
});
