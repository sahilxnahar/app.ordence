// Run: npx tsx --env-file=.env.test ... or with env vars.
// Import setup.ts (starts shim server), then test undici WS + neon Pool against it.
import "./tests/setup.ts";
import { WebSocket } from "undici";

const URL = "ws://127.0.0.1:54321";

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function wsEchoTest() {
  return new Promise<string>((resolve) => {
    const ws = new WebSocket(URL) as WebSocket & { addEventListener: Function; send: Function; close: Function; readyState: number };
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      console.error("[probe] OPEN");
      ws.send("hello-from-plain-node");
    });
    ws.addEventListener("message", (m: unknown) => {
      const ev = m as { data: unknown };
      console.error("[probe] MSG", typeof ev.data, ev.data instanceof ArrayBuffer ? ev.data.byteLength : String(ev.data));
      resolve("echo-ok");
      (ws as { close: () => void }).close();
    });
    ws.addEventListener("error", (e: unknown) => console.error("[probe] ERR", (e as Error).message));
    ws.addEventListener("close", (e: unknown) => console.error("[probe] CLOSE", (e as { code: number; reason: string }).code));
    setTimeout(() => resolve("timeout"), 5000);
  });
}

async function neonPoolTest() {
  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: "postgresql://ordence_test:test@localhost:5432/ordence_test" });
  const client = await pool.connect();
  console.error("[probe] pool.connect resolved");
  const r = await client.query("SELECT 123 AS n");
  console.error("[probe] query rows:", JSON.stringify(r.rows));
  client.release();
  await pool.end();
  console.error("[probe] pool.end done");
}

async function main() {
  await wait(300);
  console.error("[probe] echo test result:", await wsEchoTest());
  await wait(200);
  await neonPoolTest();
  console.error("[probe] ALL DONE");
  process.exit(0);
}
main().catch((e) => {
  console.error("[probe] FATAL", e);
  process.exit(1);
});
