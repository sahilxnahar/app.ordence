/**
 * Ordence — storage backend selection and the S3 path
 * Version: v0.71.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE DEFEND
 * ══════════════════════════════════════════════════════════════════════
 * Moving off Cloudflare Workers meant the file store changed from a
 * runtime BINDING to a signed HTTP protocol. The failure modes of that
 * change are all quiet:
 *
 *   · three of four credentials set → "configured", then a signing error
 *     on the first real upload, in production
 *   · a trailing slash on the endpoint → every signature covers a path
 *     the server does not recognise, and everything 403s
 *   · a key encoded as one blob → `a/b.pdf` becomes `a%2Fb.pdf`, a
 *     different object that will never be found again
 *   · a 404 on delete treated as an error → retries dead-lock on bytes
 *     that are already gone
 *
 * None of those show up in a happy-path test, so each has one here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readS3Config } from "@/lib/storage/s3";

const KEYS = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_BUCKET"] as const;

const FULL: Record<string, string> = {
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  S3_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
  S3_BUCKET: "ordence-documents",
};

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("reading the S3 configuration", () => {
  it("returns null when nothing is set", () => {
    expect(readS3Config()).toBeNull();
  });

  it("⚠️ requires ALL FOUR — three of four is misconfigured, not configured", () => {
    // Treating a partial set as configured moves the failure from a clear
    // refusal at the gate to a signing error on the first upload, in
    // production, with a message about signatures rather than settings.
    for (const missing of KEYS) {
      for (const k of KEYS) process.env[k] = FULL[k]!;
      delete process.env[missing];
      expect(readS3Config(), `missing ${missing}`).toBeNull();
    }
  });

  it("reads all four when they are present", () => {
    for (const k of KEYS) process.env[k] = FULL[k]!;
    const config = readS3Config();
    expect(config).not.toBeNull();
    expect(config!.bucket).toBe("ordence-documents");
  });

  it("⚠️ strips a trailing slash from the endpoint — SigV4 signs the path, so a double slash 403s everything", () => {
    for (const k of KEYS) process.env[k] = FULL[k]!;
    process.env.S3_ENDPOINT = "https://abc123.r2.cloudflarestorage.com///";
    expect(readS3Config()!.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
  });
});

describe("the source itself", () => {
  const ROOT = join(__dirname, "..", "..");
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
  const code = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  const s3 = code(read("lib/storage/s3.ts"));
  const r2 = code(read("lib/storage/r2.ts"));

  it("⚠️ encodes each path segment separately — encoding the whole key turns every / into %2F", () => {
    // `tenants/<uuid>/documents/<uuid>/name.pdf` collapsed into one
    // segment is a different object, and the original becomes unreachable.
    expect(s3).toMatch(/\.split\("\/"\)[\s\S]*?encodeURIComponent[\s\S]*?\.join\("\/"\)/);
  });

  it("⚠️ treats a 404 on delete as success — retries after a partial failure must be able to complete", () => {
    expect(s3).toMatch(/response\.status !== 404/);
  });

  it("uses region 'auto', which is what R2 requires", () => {
    expect(s3).toMatch(/region: "auto"/);
  });

  it("⚠️ builds the signing client per request — a module-level client runs during `next build`, with no secrets", () => {
    expect(s3).not.toMatch(/^const \w+ = new AwsClient/m);
    expect(s3).toMatch(/function clientFor\(/);
  });

  it("⚠️ re-reads the stored size after a PUT rather than trusting the declared length", () => {
    // Quota is billed against what landed. A client's Content-Length is a
    // claim, and an understated one would under-bill every upload.
    const put = s3.slice(s3.indexOf("export async function s3Put"), s3.indexOf("export async function s3Delete"));
    expect(put).toMatch(/s3Head\(config, key\)/);
  });

  it("⚠️ tries the Cloudflare binding FIRST, so an existing Workers deployment is unaffected", () => {
    const resolve = r2.slice(r2.indexOf("function resolveBackend"), r2.indexOf("export function isStorageConfigured"));
    expect(resolve.indexOf("getDocumentBucket")).toBeLessThan(resolve.indexOf("readS3Config"));
  });

  it("keeps both backends — deleting the old path during a migration leaves no way back", () => {
    expect(r2).toMatch(/kind: "binding"/);
    expect(r2).toMatch(/kind: "s3"/);
  });

  it("the upload route passes the content length through, which S3 signing needs", () => {
    expect(code(read("app/api/upload/put/route.ts"))).toMatch(
      /putStoredObject\(ticket\.p, stream, ticket\.ct, declaredLength\)/,
    );
  });

  it("⚠️ the 'not configured' message names the S3 settings, not just Cloudflare", () => {
    // This string is what an operator reads when uploads stop working. On
    // Railway, "create the R2 bucket and redeploy" sends them somewhere
    // that cannot fix it.
    expect(r2).toMatch(/S3_ENDPOINT/);
    expect(r2).toMatch(/S3_SECRET_ACCESS_KEY/);
  });
});
