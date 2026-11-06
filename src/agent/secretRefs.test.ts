import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Vault, VaultTokenError, setVault, tokenFor } from "../vault.js";
import { scrubOutput, secretCommand, secretEnv, secretInput } from "./secretRefs.js";

// Secret references (#1049): tokens become values where a call runs, and come back as tokens.
test("commands take values through per-command variables; other tools get values; output is scrubbed", async () => {
  const vault = new Vault();
  setVault(vault);
  try {
    assert.equal(secretInput("Bash", { command: "echo hi" }), null, "an empty vault changes nothing");
    const { fragment } = await vault.add({ value: "s3cr'et-$value", hint: "api key", source: "user", createdBy: "user" });
    const token = tokenFor(fragment);
    const name = `SCRIBE_SECRET_${fragment.id}`;
    // vault_show finds by hint or id, never by the value.
    assert.deepEqual(vault.find("API").map((f) => f.id), [fragment.id]);
    assert.deepEqual(vault.find(token).map((f) => f.id), [fragment.id]);
    assert.deepEqual(vault.find("s3cr"), []);

    assert.equal(secretCommand("echo hi", "posix"), null);
    const posix = secretCommand(`curl -H "Authorization: Bearer ${token}" x`, "posix")!;
    assert.equal(posix, `export ${name}='s3cr'\\''et-$value'\ncurl -H "Authorization: Bearer \${${name}}" x`);
    const ps = secretCommand(`Write-Output $env:${name}`, "powershell")!;
    assert.equal(ps, `$env:${name} = 's3cr''et-$value'\nWrite-Output $env:${name}`);
    assert.deepEqual(secretEnv(`echo ${token}`, "posix"), { command: `echo \${${name}}`, env: { [name]: "s3cr'et-$value" } });

    // Refused rather than run with a literal token.
    assert.throws(() => secretCommand("echo ⟦p:0000000000 guess⟧", "posix"), VaultTokenError);
    assert.throws(() => secretCommand(`echo ${token.replace("api", "app")}`, "posix"), VaultTokenError);
    assert.throws(() => secretCommand("echo $SCRIBE_SECRET_0123456789", "posix"), VaultTokenError);
    assert.throws(() => secretCommand(`echo ${token.slice(0, -1)}`, "posix"), VaultTokenError);

    assert.deepEqual(secretInput("Write", { file_path: ".env", content: `KEY=${token}\n` }), { file_path: ".env", content: "KEY=s3cr'et-$value\n" });
    assert.deepEqual(secretInput("Bash", { command: `echo ${token}`, description: "d" }), { command: `export ${name}='s3cr'\\''et-$value'\necho \${${name}}`, description: "d" });
    assert.equal(secretInput("Read", { file_path: "a.txt" }), null);

    assert.deepEqual(scrubOutput({ stdout: "got s3cr'et-$value!", stderr: "" }), { stdout: `got ${token}!`, stderr: "" });
    assert.equal(scrubOutput({ stdout: "nothing" }), null);

    // The command really runs with the value, in a shell of its own.
    const sh = spawnSync("sh", ["-c", posix.replace(/^curl.*$/m, `printf %s "\${${name}}"`)], { encoding: "utf8" });
    if (!sh.error) assert.equal(sh.stdout, "s3cr'et-$value");
  } finally {
    setVault(new Vault());
  }
});
