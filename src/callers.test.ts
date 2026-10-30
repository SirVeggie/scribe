import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";

process.env.SCRIBE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-callers-"));
const { agentPortGate, identify, markAgentSocket, prepareSecrets, socketAllowed, threadToken } = await import("./callers.js");
prepareSecrets();

/** One app on two listeners, like http.ts: the board port and the agent port (#915). */
async function servers() {
  const app = express();
  app.use(agentPortGate);
  app.use((req, res) => res.json(identify(req)));
  const board = http.createServer(app);
  const agent = http.createServer(app);
  agent.on("connection", markAgentSocket);
  let upgraded: unknown;
  agent.on("upgrade", (req, socket) => {
    upgraded = socketAllowed(req.headers, req.socket);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return { board: await listen(board), agent: await listen(agent), upgraded: () => upgraded, close: () => { board.close(); agent.close(); } };
}

function call(port: number, pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

test("the agent port never takes a caller for the browser or a page, and serves only the API (#915)", async () => {
  const { board, agent, upgraded, close } = await servers();
  try {
    const forged = { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${board}` };
    assert.equal(JSON.parse((await call(board, "/api/who", forged)).body).viewer, "user", "the board port still trusts the browser header");
    assert.deepEqual(JSON.parse((await call(agent, "/api/who", { ...forged, host: `127.0.0.1:${agent}` })).body), { viewer: "agent" });

    const local = fs.readFileSync(path.join(process.env.SCRIBE_HOME!, "local-token"), "utf8").trim();
    assert.deepEqual(JSON.parse((await call(agent, "/api/who", { "x-scribe-local-token": local })).body), { viewer: "agent" }, "no local token there either");

    const chat = { "x-scribe-thread": "th_1", "x-scribe-token": threadToken("th_1") };
    assert.deepEqual(JSON.parse((await call(agent, "/api/who", chat)).body), { viewer: "agent", thread: "th_1" });
    assert.deepEqual(JSON.parse((await call(agent, "/api/who", { ...chat, "x-scribe-token": "0".repeat(64) })).body), { viewer: "agent" });

    // Page origins, gateway hosts and the UI are the board port's.
    for (const host of [`t-ab12cd34.localhost:${agent}`, `d-0123456789ab.localhost:${agent}`]) {
      assert.equal((await call(agent, "/api/who", { host, ...forged })).status, 404, host);
    }
    assert.equal((await call(agent, "/", { "sec-fetch-site": "none" })).status, 404);
    assert.equal((await call(agent, "/api/who", { host: `localhost:${agent}` })).status, 200);

    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: agent, path: "/ws", headers: { connection: "upgrade", upgrade: "websocket", origin: `http://127.0.0.1:${agent}` } });
      req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(); });
      req.on("response", () => resolve());
      req.on("error", () => resolve());
      req.end();
    });
    assert.equal(upgraded(), false, "no board socket on the agent port");
  } finally {
    close();
  }
});
