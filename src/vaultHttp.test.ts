import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AGENT_CLIENT, CLIENT_HEADER, LOCAL_TOKEN_HEADER } from "./config.js";

// Protected data (#1045): the daemon redacts what agents read and restores what they write.
test("agents read protected values as tokens, write them back intact, and can't save unknown tokens or search for values", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-vault-http-"));
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url)), "--daemon"], {
    env: { ...process.env, SCRIBE_HOME: root, SCRIBE_PORT: String(port), SCRIBE_AGENT_PORT: "0", SCRIBE_FAKE_AGENTS: "1" },
    windowsHide: true,
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const url = `http://127.0.0.1:${port}`;
  /** agent: an external MCP client (the local token); else the board UI. */
  const call = async (method: string, route: string, body?: unknown, agent = false) => {
    const headers: Record<string, string> = body ? { "Content-Type": "application/json" } : {};
    if (agent) {
      headers[CLIENT_HEADER] = AGENT_CLIENT;
      headers[LOCAL_TOKEN_HEADER] = fs.readFileSync(path.join(root, "local-token"), "utf8").trim();
    } else Object.assign(headers, { "sec-fetch-site": "same-origin", origin: url });
    const res = await fetch(url + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, data: JSON.parse(text || "{}") as Record<string, any> };
  };
  try {
    let ready = false;
    for (const until = Date.now() + 90_000; !ready && Date.now() < until;) {
      try {
        ready = fs.existsSync(path.join(root, "local-token")) && (await fetch(url + "/api/health", { signal: AbortSignal.timeout(300) })).ok;
      } catch {
        /* starting */
      }
      if (!ready) await delay(100);
    }
    assert.equal(ready, true, "daemon became ready");

    const secret = "hunter2-staging-pw";
    const made = await call("POST", "/api/tabs", { key: "creds", title: "Creds", activate: false, html: `<p>Staging login: ${secret} (rotate monthly)</p>`, state: { note: `pw ${secret}` } });
    assert.ok(made.status < 300, made.text);
    const id = made.data.tab.id as string;
    assert.ok((await call("PUT", `/api/tabs/${id}/access`, { level: "open" })).status < 300);

    // The user adds the value; agents only ever see metadata.
    const added = await call("POST", "/api/vault/protect", { value: secret, hint: "staging password", kind: "password" });
    assert.equal(added.status, 200, added.text);
    const token = added.data.token as string;
    assert.match(token, /^⟦p:[0-9a-f]+ staging password⟧$/);
    const listed = await call("GET", "/api/vault", undefined, true);
    assert.equal(listed.data.fragments.length, 1);
    assert.equal(listed.data.fragments[0].pages, 1);
    assert.doesNotMatch(listed.text, /hunter2/);

    // Read: the token, never the value, in HTML and state alike.
    const read = await call("GET", `/api/tabs/${id}`, undefined, true);
    assert.equal(read.status, 200, read.text);
    assert.doesNotMatch(read.text, /hunter2/);
    assert.ok((read.data.html as string).includes(`Staging login: ${token} (rotate monthly)`));
    const state = await call("GET", `/api/tabs/${id}/state`, undefined, true);
    assert.doesNotMatch(state.text, /hunter2/);

    // Patch around the token, against the redacted view: the value comes through intact.
    const patched = await call("POST", `/api/tabs/${id}/patch`, { edits: [{ oldString: `Staging login: ${token}`, newString: `Staging password: ${token}` }] }, true);
    assert.ok(patched.status < 300, patched.text);
    assert.doesNotMatch(patched.text, /hunter2/);
    const after = await call("GET", `/api/tabs/${id}`);
    assert.ok((after.data.html as string).includes(`Staging password: ${secret} (rotate monthly)`), after.data.html);
    const stateWrite = await call("PUT", `/api/tabs/${id}/state`, { ops: [{ op: "set", path: "copy", value: `again ${token}` }] }, true);
    assert.ok(stateWrite.status < 300, stateWrite.text);
    assert.equal((await call("GET", `/api/tabs/${id}/state`)).data.state.copy, `again ${secret}`);

    // Unknown or edited tokens are refused, not saved.
    const unknown = await call("POST", `/api/tabs/${id}/patch`, { edits: [{ oldString: "rotate monthly", newString: "⟦p:0000000000 guess⟧" }] }, true);
    assert.equal(unknown.status, 400, unknown.text);
    const edited = await call("POST", `/api/tabs/${id}/patch`, { edits: [{ oldString: "rotate monthly", newString: token.replace("staging", "prod") }] }, true);
    assert.equal(edited.status, 400, edited.text);
    assert.ok(((await call("GET", `/api/tabs/${id}`)).data.html as string).includes("rotate monthly"));

    // Search is no oracle: the value finds nothing, other words still find the page.
    const byValue = await call("GET", `/api/library?query=${encodeURIComponent("hunter2")}`, undefined, true);
    assert.equal(byValue.data.matchCount, 0, byValue.text);
    const byWord = await call("GET", `/api/library?query=rotate`, undefined, true);
    assert.equal(byWord.data.matchCount, 1, byWord.text);
    assert.doesNotMatch(byWord.text, /hunter2/);

    // Agents may protect what they find, within limits; removing is the user's.
    assert.equal((await call("POST", "/api/vault/protect", { value: "the" }, true)).status, 400);
    const agentAdd = await call("POST", "/api/vault/protect", { value: "rotate monthly", hint: "schedule" }, true);
    assert.equal(agentAdd.status, 200, agentAdd.text);
    assert.doesNotMatch((await call("GET", `/api/tabs/${id}`, undefined, true)).text, /rotate monthly/);
    const fragmentId = agentAdd.data.fragment.id as string;
    assert.equal((await call("DELETE", `/api/vault/${fragmentId}`, undefined, true)).status, 403);
    assert.equal((await call("DELETE", `/api/vault/${fragmentId}`)).status, 200);
    assert.match((await call("GET", `/api/tabs/${id}`, undefined, true)).text, /rotate monthly/);
  } finally {
    await fetch(url + "/api/shutdown", { method: "POST" }).catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
