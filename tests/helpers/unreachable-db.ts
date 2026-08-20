/**
 * Ordence , MAKE THE DATABASE GENUINELY UNREACHABLE
 * Version: v1.82.0-alpha - Infra wave H4 (integration, track H)
 *
 * WHY THIS EXISTS
 * ---------------
 * Several controls are supposed to REFUSE when the database cannot be
 * reached, and at least one is supposed to ALLOW. In every case the same
 * question goes unanswered: what does this actually do when the database
 * is gone?
 *
 * It has always been answered by reading the code, and reading the code
 * is how all four known fail-open defects passed review. A `catch` block
 * is the one piece of code whose behaviour you cannot infer by looking at
 * it, because the interesting path never runs in development.
 *
 * MOCKING IS NOT ENOUGH, AND THAT IS THE POINT OF THIS FILE. A stubbed
 * client that throws proves your stub throws. It does not exercise the
 * driver timeout, the pool queue, the retry, or the shape of the real
 * error, and each of those has produced a different code path here. This
 * opens a real socket to a real port and then takes it away.
 *
 * HOW
 * ---
 * A TCP proxy sits between the code under test and PostgreSQL. Point
 * DATABASE_URL at the proxy, then choose a failure:
 *
 *   cut()        live sockets destroyed, new ones refused.
 *                "the database went away mid-request".
 *   refuse()     new connections refused, existing left alone.
 *                "the host is down" or "the pool is exhausted".
 *   blackhole()  connections accepted and then nothing, ever.
 *                THE CRUEL ONE, AND THE REALISTIC ONE. A real outage is
 *                usually silence rather than an error. Code that handles
 *                ECONNREFUSED correctly often hangs here, and a control
 *                that hangs is a control that is not refusing.
 *   heal()       back to normal, so recovery can be proved too.
 *
 * USAGE
 *   const db = await unreachableDatabase();
 *   process.env.DATABASE_URL = db.url;
 *   await db.cut();
 *   await expect(theControl()).rejects.toThrow();
 *   await db.heal();
 *   await db.close();
 *
 * IT NEVER TOUCHES ANYTHING BUT A LOCAL TEST DATABASE. A tool whose whole
 * purpose is to sever database connections must not be pointable at a
 * hosted one, so it refuses any non-local host before opening a socket.
 */
import net from "node:net";

export type UnreachableDatabase = {
  /** Point DATABASE_URL at this. Same credentials, different port. */
  url: string;
  port: number;
  cut(): Promise<void>;
  refuse(): Promise<void>;
  blackhole(): Promise<void>;
  heal(): Promise<void>;
  close(): Promise<void>;
  connections(): number;
};

type Mode = "pass" | "cut" | "refuse" | "blackhole";

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export async function unreachableDatabase(
  targetUrl = process.env.TEST_DATABASE_URL,
): Promise<UnreachableDatabase> {
  if (!targetUrl) {
    throw new Error(
      "unreachableDatabase: no TEST_DATABASE_URL. This harness proxies to the " +
        "test database and never to anything else.",
    );
  }

  const parsed = new URL(targetUrl);
  const host = parsed.hostname;

  /**
   * FIRST, BEFORE A SOCKET IS OPENED. Nobody should be one typo away from
   * pointing a connection-severing tool at a hosted database.
   */
  if (!LOCAL.has(host)) {
    throw new Error(
      `unreachableDatabase: REFUSING to proxy to "${host}". This harness ` +
        "deliberately breaks connections and may only be pointed at a local " +
        "test database.",
    );
  }

  const targetPort = Number(parsed.port || 5432);
  let mode: Mode = "pass";
  let count = 0;
  const live = new Set<net.Socket>();

  const server = net.createServer((client) => {
    count++;
    live.add(client);
    client.on("close", () => live.delete(client));
    client.on("error", () => { /* FAIL OPEN: a severed socket errors by design */ });

    if (mode === "refuse" || mode === "cut") { client.destroy(); return; }

    /**
     * blackhole holds the socket open and answers nothing. Do NOT destroy
     * it: the caller is meant to wait. Closing it would make this
     * indistinguishable from `refuse`, and the difference between an
     * error and silence is exactly what this harness exists to expose.
     */
    if (mode === "blackhole") return;

    const upstream = net.createConnection({ host, port: targetPort });
    upstream.on("error", () => client.destroy());
    live.add(upstream);
    upstream.on("close", () => live.delete(upstream));
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("unreachableDatabase: the proxy did not get a port");
  }
  const port = address.port;

  const proxied = new URL(targetUrl);
  proxied.hostname = "127.0.0.1";
  proxied.port = String(port);

  const severAll = () => {
    for (const s of live) s.destroy();
    live.clear();
  };

  return {
    url: proxied.toString(),
    port,
    connections: () => count,
    async cut() { mode = "cut"; severAll(); },
    async refuse() { mode = "refuse"; },
    async blackhole() { mode = "blackhole"; severAll(); },
    async heal() { mode = "pass"; },
    async close() {
      severAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
