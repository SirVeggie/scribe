import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dataDir } from "./config.js";

/** Runs dataDir() as on another platform, with HOME at a scratch folder and SCRIBE_HOME unset. */
function on(platform: NodeJS.Platform, home: string, xdg?: string): string {
  const saved = { platform: process.platform, scribe: process.env.SCRIBE_HOME, home: process.env.HOME, xdg: process.env.XDG_DATA_HOME };
  Object.defineProperty(process, "platform", { value: platform });
  delete process.env.SCRIBE_HOME;
  process.env.HOME = home;
  if (xdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = xdg;
  try {
    return dataDir();
  } finally {
    Object.defineProperty(process, "platform", { value: saved.platform });
    for (const [key, value] of [["SCRIBE_HOME", saved.scribe], ["HOME", saved.home], ["XDG_DATA_HOME", saved.xdg]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("dataDir off Windows: XDG on Linux, Application Support on macOS, an old ~/scribe data folder kept, a repo clone ignored", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-datadir-"));
  try {
    assert.equal(on("linux", home), path.join(home, ".local", "share", "scribe"));
    assert.equal(on("linux", home, path.join(home, "xdg")), path.join(home, "xdg", "scribe"));
    assert.equal(on("linux", home, "relative"), path.join(home, ".local", "share", "scribe"));
    assert.equal(on("darwin", home), path.join(home, "Library", "Application Support", "Scribe"));

    const old = path.join(home, "scribe");
    fs.mkdirSync(path.join(old, ".git"), { recursive: true });
    fs.writeFileSync(path.join(old, "scribe.sqlite"), "");
    assert.equal(on("linux", home), path.join(home, ".local", "share", "scribe"), "a git checkout is not a data folder");

    fs.rmSync(path.join(old, ".git"), { recursive: true });
    assert.equal(on("linux", home), old);
    assert.equal(on("darwin", home), old);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
