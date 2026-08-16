import { neonConfig } from "@neondatabase/serverless";

const port = 54321;
neonConfig.fetchFunction = async (url, init) => {
  return fetch(`http://127.0.0.1:${port}/sql`, {
    ...init,
    headers: init?.headers,
  });
};

const { neon } = await import("@neondatabase/serverless");
const sql = neon("postgresql://ordence_app:test_app@localhost:5432/ordence_test");

async function run(tag, q, params = []) {
  try {
    const r = await sql(q, params);
    console.log(tag, "OK rows:", JSON.stringify(r));
  } catch (e) {
    console.log(tag, "THREW:", JSON.stringify(Object.keys(e)), "| code:", e?.code, "| message:", e?.message);
    console.log(tag, "full:", e);
  }
}

// replicate access.ts query style (joins, aliases, where)
await run(
  "join",
  `SELECT s.id, s.status, s.plan_tier FROM subscriptions s INNER JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1 AND s.deleted_at IS NULL`,
  ["deadbeef-dead-beef-dead-beefdeadbeef"],
);

// transaction usage (set_config + query) — what withTenant does
try {
  const result = await sql.transaction([sql`BEGIN`]);
  console.log("tx OK", JSON.stringify(result));
} catch (e) {
  console.log("tx THREW:", e?.code, e?.message);
}
