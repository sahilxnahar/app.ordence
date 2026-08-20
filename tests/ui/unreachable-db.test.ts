import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { unreachableDatabase } from "../helpers/unreachable-db";

/**
 * The harness is tested against a plain TCP echo server rather than
 * PostgreSQL. That is deliberate: what needs proving is the PROXY's
 * behaviour , that `cut` severs, that `refuse` refuses, that `blackhole`
 * is silent rather than erroring, and that `heal` restores. Involving a
 * real database would test the driver instead and make these cases slow
 * and flaky, and a slow test stops being run.
 */
let echo: net.Server;
let echoPort = 0;

const dial = (port: number, timeoutMs = 400) =>
  new Promise<string>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    const t = setTimeout(() => { s.destroy(); reject(new Error("TIMEOUT")); }, timeoutMs);
    s.on("connect", () => s.write("ping"));
    s.on("data", (d) => { clearTimeout(t); s.destroy(); resolve(d.toString()); });
    s.on("error", (e) => { clearTimeout(t); reject(e); });
    s.on("close", () => { clearTimeout(t); reject(new Error("CLOSED")); });
  });

beforeAll(async () => {
  echo = net.createServer((c) => c.on("data", (d) => c.write(d)));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = (echo.address() as net.AddressInfo).port;
});

afterAll(async () => { await new Promise<void>((r) => echo.close(() => r())); });

const target = () => `postgresql://u:p@127.0.0.1:${echoPort}/db`;

describe("unreachableDatabase", () => {
  it("passes traffic through when healthy", async () => {
    const db = await unreachableDatabase(target());
    await expect(dial(db.port)).resolves.toBe("ping");
    expect(db.connections()).toBe(1);
    await db.close();
  });

  it("cut() makes new connections fail", async () => {
    const db = await unreachableDatabase(target());
    await db.cut();
    await expect(dial(db.port)).rejects.toThrow();
    await db.close();
  });

  it("blackhole() is SILENT rather than an error , the realistic outage", async () => {
    const db = await unreachableDatabase(target());
    await db.blackhole();
    /**
     * The distinction that matters. `refuse` gives you an error to catch.
     * `blackhole` gives you nothing, and code that handles the first
     * correctly often hangs on the second. It must time out, not close.
     */
    await expect(dial(db.port, 300)).rejects.toThrow("TIMEOUT");
    await db.close();
  });

  it("heal() restores service, so recovery can be proved too", async () => {
    const db = await unreachableDatabase(target());
    await db.cut();
    await expect(dial(db.port)).rejects.toThrow();
    await db.heal();
    await expect(dial(db.port)).resolves.toBe("ping");
    await db.close();
  });

  it("REFUSES to proxy to a host that is not local", async () => {
    await expect(
      unreachableDatabase("postgresql://u:p@ep-something.neon.tech:5432/db"),
    ).rejects.toThrow(/REFUSING to proxy/);
  });

  it("REFUSES when no target is given rather than guessing one", async () => {
    await expect(unreachableDatabase(undefined)).rejects.toThrow(/TEST_DATABASE_URL/);
  });
});
