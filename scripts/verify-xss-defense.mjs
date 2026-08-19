/**
 * XSS defense verification — executes the real safeUrl/safeEmail logic against
 * known bypass payloads. Run with: node scripts/verify-xss-defense.mjs
 */

const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file|blob):/i;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function safeUrl(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, "").trim();
  if (!cleaned) return null;
  if (DANGEROUS_SCHEME.test(cleaned)) return null;
  try {
    const url = new URL(cleaned);
    return url.protocol === "http:" || url.protocol === "https:" ? cleaned : null;
  } catch {
    if (cleaned.startsWith("/") && !cleaned.startsWith("//")) return cleaned;
    return null;
  }
}

const SAFE_EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function safeEmail(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length > 320) return null;
  if (!SAFE_EMAIL.test(cleaned)) return null;
  if (DANGEROUS_SCHEME.test(cleaned)) return null;
  return cleaned;
}

const legitEmails = ["a@b.com", "first.last+tag@sub.domain.co.in", "x_y@example.org"];

const attacks = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "  javascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "javascript:alert(1)",
  "\u0000javascript:alert(1)",
  "java\u000Bscript:alert(1)",
  "java\u007Fscript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "blob:http://evil.com/x",
  "//evil.com/steal-session",
  "\\\\evil.com\\share",
  "",
  "   ",
];

const legitimate = [
  "https://example.com",
  "http://example.com/path?q=1",
  "https://sub.domain.co.in/a/b",
  "/internal/relative/path",
];

const emailAttacks = [
  "javascript:alert(1)@x.com",
  "a@b.com\nBcc:victim@x.com",
  "a@b.com\r\nBcc:victim@x.com",
  "not-an-email",
  "<script>@evil.com",
  "\">&lt;img src=x onerror=1&gt;@evil.com",
  "a b@c.com",
  "data:text/html@x.com",
];

let failures = 0;

console.log("URL attack payloads:");
for (const a of attacks) {
  const result = safeUrl(a);
  const blocked = result === null;
  if (!blocked) failures++;
  console.log(`  ${blocked ? "PASS blocked" : "FAIL ALLOWED"}  ${JSON.stringify(a).slice(0, 50)}`);
}

console.log("\nLegitimate URLs (must survive):");
for (const s of legitimate) {
  const result = safeUrl(s);
  const allowed = result !== null;
  if (!allowed) failures++;
  console.log(`  ${allowed ? "PASS allowed" : "FAIL blocked"}  ${s}`);
}

console.log("\nEmail attack payloads:");
for (const a of emailAttacks) {
  const result = safeEmail(a);
  const blocked = result === null;
  if (!blocked) failures++;
  console.log(`  ${blocked ? "PASS blocked" : "FAIL ALLOWED"}  ${JSON.stringify(a).slice(0, 50)}`);
}

console.log("\nLegitimate emails (must survive):");
for (const e of legitEmails) {
  const r = safeEmail(e);
  const ok = r !== null;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS allowed" : "FAIL blocked"}  ${e}`);
}

const total = attacks.length + legitimate.length + emailAttacks.length + legitEmails.length;
console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
