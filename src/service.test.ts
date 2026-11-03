import { test } from "node:test";
import assert from "node:assert/strict";
import { launchdPlist, servicePlan, underServiceManager, systemdUnit, windowsTaskScript } from "./service.js";

test("servicePlan keeps only Scribe's own settings", () => {
  const plan = servicePlan({ SCRIBE_HOME: "/srv/scribe", SCRIBE_PORT: "4800", SCRIBE_THREAD: "th_1", HOME: "/home/me", SCRIBE_PEER_PORT: "" });
  assert.deepEqual(plan.env, { SCRIBE_HOME: "/srv/scribe", SCRIBE_PORT: "4800" });
  assert.match(plan.entry, /dist[\\/]index\.js$/);
});

test("systemd unit runs the daemon in the foreground and restarts it only on failure", () => {
  const unit = systemdUnit({ node: "/usr/bin/node", entry: "/opt/my scribe/dist/index.js", cwd: "/opt/my scribe", env: { SCRIBE_HOME: "/srv/scribe" } });
  assert.match(unit, /^ExecStart=\/usr\/bin\/node "\/opt\/my scribe\/dist\/index\.js" --daemon$/m);
  assert.match(unit, /^WorkingDirectory="\/opt\/my scribe"$/m);
  assert.match(unit, /^Environment=SCRIBE_HOME=\/srv\/scribe$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("Windows task starts the daemon hidden at the user's logon", () => {
  const plain = windowsTaskScript({ node: "C:\\Program Files\\nodejs\\node.exe", entry: "C:\\scribe\\dist\\index.js", cwd: "C:\\scribe", env: {} }, "PC\\me");
  assert.match(plain, /-Execute 'conhost\.exe' -Argument '--headless "C:\\Program Files\\nodejs\\node\.exe" "C:\\scribe\\dist\\index\.js" --daemon'/);
  assert.match(plain, /-AtLogOn -User 'PC\\me'/);
  assert.match(plain, /-RestartCount 999/);
  const withEnv = windowsTaskScript({ node: "node.exe", entry: "C:\\it's\\dist\\index.js", cwd: "C:\\it's", env: { SCRIBE_PORT: "4800" } }, "me");
  assert.match(withEnv, /-Execute 'conhost\.exe' -Argument '--headless cmd\.exe \/d \/c set "SCRIBE_PORT=4800"&& "node\.exe" "C:\\it''s\\dist\\index\.js" --daemon'/);
});

test("launchd agent runs the daemon at login, restarts it only on failure, and escapes paths", () => {
  const plist = launchdPlist({ node: "/opt/scribe/node/bin/node", entry: "/Users/me/A&B/dist/index.js", cwd: "/Users/me/A&B", env: { SCRIBE_PORT: "4800" } });
  assert.match(plist, /<string>\/opt\/scribe\/node\/bin\/node<\/string>\s*<string>\/Users\/me\/A&amp;B\/dist\/index\.js<\/string>\s*<string>--daemon<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/Users\/me\/A&amp;B<\/string>/);
  assert.match(plist, /<key>SCRIBE_PORT<\/key><string>4800<\/string>/);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
});

test("underServiceManager recognizes systemd and the launchd agent, not a daemon started by hand", () => {
  assert.equal(underServiceManager({ INVOCATION_ID: "abc" }, "linux"), true);
  assert.equal(underServiceManager({ XPC_SERVICE_NAME: "local.scribe.daemon" }, "darwin"), true);
  assert.equal(underServiceManager({ XPC_SERVICE_NAME: "application.com.apple.Terminal.123" }, "darwin"), false);
  assert.equal(underServiceManager({}, "win32"), false);
});
