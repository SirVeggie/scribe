import http from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

/**
 * Real HTTP for browser tests that load workers/worklets: AudioWorklet.addModule
 * requests can bypass Playwright page.route. Serve those modules here with a JS
 * Content-Type, and use page.route only for requests that support interception.
 * The test owns cleanup even if later setup or assertions fail.
 */
export async function httpFixture(
  t: Pick<TestContext, "after">,
  handler: http.RequestListener,
  { host = "127.0.0.1", port = 0 }: { host?: "127.0.0.1" | "127.0.0.2"; port?: number } = {},
) {
  const server = http.createServer(handler);
  t.after(() => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;
  return { origin: `http://${host}:${boundPort}`, port: boundPort };
}
