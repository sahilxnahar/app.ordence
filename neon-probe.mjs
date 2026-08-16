import { neonConfig } from "@neondatabase/serverless";

const port = 54321;
neonConfig.defaults.fetchFunction = async (url, init) => {
  const res = await fetch(`http://127.0.0.1:${port}/sql`, {
    ...init,
    headers: init?.headers,
  });
  void url;
  return res;
};

const { neon } = await import("@neondatabase/serverless");
const sql = neon("postgresql://ordence_app:test_app@localhost:5432/ordence_test");
try {
  const r = await sql`SELECT status, tier FROM (SELECT 1) t INNER JOIN subscriptions s ON false`;
  console.log("ok", JSON.stringify(r));
} catch (e) {
  console.log("ERR instance:", e instanceof Error, "| msg:", e?.message, "| code:", e?.code);
}
