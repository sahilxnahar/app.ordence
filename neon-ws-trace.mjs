import { neonConfig as nc } from "@neondatabase/serverless";
const Orig = globalThis.WebSocket;
globalThis.WebSocket = class extends Orig {
  constructor(url, proto) {
    console.error("[trace] WebSocket created:", url, proto);
    console.error(new Error().stack.split("\n").slice(1, 8).join(" | "));
    super(url, proto);
  }
};
nc.useSecureWebSocket = false;
nc.wsProxy = () => "127.0.0.1:54322";
const { neon } = await import("@neondatabase/serverless");
const url = "postgresql://ordence_test:test@localhost:5432/ordence_test";
const sql = neon(url);
try {
  const rows = await sql.transaction([sql`SELECT 1 AS n`]);
  console.error("[ok]", JSON.stringify(rows.map(r => r.rows)));
} catch (e) {
  console.error("[fail]", e instanceof Error ? `${e.name}: ${e.message}` : e);
}
process.exit(0);
