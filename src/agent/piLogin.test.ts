import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pi-login-"));
process.env.SCRIBE_HOME = home;
const { PI_LOGINS, PiProvider } = await import("./providers/pi.js");

const authFile = path.join(home, "agent", "pi", "agent", "auth.json");
function writeAuth(value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify(value));
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A provider on a fake Pi runtime: login() runs `flow`, which writes the credential like Pi does. */
function provider(runtime: Record<string, unknown>, loggedIn: (id: string) => void = () => undefined) {
  const p = new PiProvider(() => [], loggedIn);
  (p as unknown as { runtime: () => Promise<unknown> }).runtime = async () => runtime;
  return p;
}

test("Native logins leave out Anthropic's subscription", () => {
  assert.deepEqual(PI_LOGINS.map((login) => login.id), ["openai-codex", "github-copilot", "xai", "kimi-coding"]);
});

test("Native logins report stored OAuth logins with their ChatGPT account, and API keys as not logged in", async () => {
  writeAuth({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600_000, accountId: "acct-1" }, xai: { type: "api_key", key: "k" } });
  const p = provider({});
  const views = await p.logins();
  assert.deepEqual(views.find((v) => v.id === "openai-codex"), { id: "openai-codex", label: "ChatGPT (Codex)", state: "in", accountId: "acct-1" });
  assert.equal(views.find((v) => v.id === "xai")?.state, "out");
  assert.equal(p.codexAccountId(), "acct-1");
  await assert.rejects(p.startLogin("anthropic"), /Unknown login/);
});

test("A login whose token no longer refreshes shows as expired, and as logged in once a refresh works", async () => {
  writeAuth({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: Date.now() - 1000, accountId: "acct-1" } });
  let fail = true;
  const p = provider({
    getAuth: async (id: string) => {
      assert.equal(id, "openai-codex");
      if (fail) throw new Error("OAuth refresh failed for openai-codex");
      writeAuth({ "openai-codex": { type: "oauth", access: "b", refresh: "r2", expires: Date.now() + 3600_000, accountId: "acct-1" } });
      return { auth: { apiKey: "b" } };
    },
  });
  assert.equal((await p.logins()).find((v) => v.id === "openai-codex")?.state, "expired");
  fail = false;
  assert.equal((await p.logins()).find((v) => v.id === "openai-codex")?.state, "in");
});

test("A browser login shows its page, takes a pasted redirect URL when the callback port is busy, then saves the login", async () => {
  writeAuth({});
  const done: string[] = [];
  let pasted = "";
  const p = provider({
    login: async (id: string, type: string, interaction: AuthInteraction) => {
      assert.equal(type, "oauth");
      // The default method, as Pi's own picker.
      assert.equal(await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device" }] }), "browser");
      interaction.notify({ type: "auth_url", url: "https://auth.example/authorize" });
      pasted = await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
      writeAuth({ [id]: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600_000, accountId: "acct-2" } });
      return { type: "oauth" };
    },
  }, (id) => done.push(id));
  const started = await p.startLogin("openai-codex");
  assert.equal(started.state, "pending");
  assert.equal(started.url, "https://auth.example/authorize");
  await tick();
  assert.equal((await p.logins()).find((v) => v.id === "openai-codex")?.paste, "Paste the redirect URL");
  p.answerLogin("openai-codex", "http://localhost:1455/auth/callback?code=c&state=s");
  for (let i = 0; i < 5 && !done.length; i += 1) await tick();
  assert.equal(pasted, "http://localhost:1455/auth/callback?code=c&state=s");
  assert.deepEqual(done, ["openai-codex"]);
  assert.deepEqual((await p.logins()).find((v) => v.id === "openai-codex"), { id: "openai-codex", label: "ChatGPT (Codex)", state: "in", accountId: "acct-2" });
});

test("A device-code login shows its code; a cancelled login leaves no error, a failed one shows why", async () => {
  writeAuth({});
  let attempt = 0;
  const p = provider({
    login: async (_id: string, _type: string, interaction: AuthInteraction) => {
      attempt += 1;
      // GitHub Copilot asks for an Enterprise domain: github.com.
      assert.equal(await interaction.prompt({ type: "text", message: "GitHub Enterprise URL/domain" }), "");
      interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
      if (attempt === 2) throw new Error("access_denied");
      await new Promise((_, reject) => interaction.signal?.addEventListener("abort", () => reject(new Error("Login cancelled"))));
    },
  });
  const started = await p.startLogin("github-copilot");
  assert.equal(started.userCode, "ABCD-1234");
  assert.equal(started.url, "https://github.com/login/device");
  p.cancelLogin("github-copilot");
  await tick();
  assert.deepEqual((await p.logins()).find((v) => v.id === "github-copilot"), { id: "github-copilot", label: "GitHub Copilot", state: "out" });
  await p.startLogin("github-copilot");
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal((await p.logins()).find((v) => v.id === "github-copilot")?.error, "access_denied");
});
