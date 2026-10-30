#!/usr/bin/env node
import { startHttp } from "./http.js";
import { startMcp } from "./mcp.js";
import { api, ensureDaemon, health } from "./daemon.js";
import { log } from "./log.js";
import { migrateLegacyData } from "./config.js";
import { watchMemory } from "./memoryWatch.js";
import { hideChildWindows } from "./hideWindows.js";

const argv = process.argv.slice(2);
const args = new Set(argv);

const USAGE = `Usage:
  scribe pair <code>          Pair with the device that shows this code (Settings → Devices → Add device)
  scribe add-device           Show a code to enter on another device, and wait for it
  scribe devices              This device and the paired ones
  scribe unpair <name | id>   Revoke a paired device (on both sides)
  scribe rename <name>        Rename this device
  scribe service install | uninstall | status
                              Run the daemon at boot (systemd) or logon (Windows), without the desktop app`;

type DevicesView = {
  error?: string;
  self: { name: string; id: string; fingerprint: string; hosts: string[]; port: number };
  peers: { name: string; id: string; online: boolean; rtt?: number; lastSeen?: number }[];
  offer: { code: string; expiresAt: number } | null;
};

async function devicesView(): Promise<DevicesView> {
  const { status, data } = await api("GET", "/api/devices", undefined, { user: true });
  const view = data as DevicesView;
  if (status !== 200) throw new Error(view.error || `Could not list devices (${status})`);
  return view;
}

async function change(method: string, pathname: string, body: unknown, failed: string): Promise<DevicesView> {
  const { status, data } = await api(method, pathname, body, { user: true, timeoutMs: 60_000 });
  const result = data as DevicesView;
  if (status !== 200) throw new Error(result.error || `${failed} (${status})`);
  return result;
}

/** `scribe pair <code>`, `scribe devices` (#904) and the rest of the headless device's CLI (#909). */
async function devicesCommand(): Promise<void> {
  if (process.env.SCRIBE_THREAD) throw new Error("Pairing is the user's: run it in your own terminal, not from an agent's chat.");
  if (!(await health())) throw new Error("Scribe is not running. Start it first (npm start, or scribe service install).");
  const rest = argv.slice(1).join(" ").trim();
  if (argv[0] === "pair") {
    const code = rest.replace(/\s+/g, "");
    if (!code) throw new Error("Usage: scribe pair <code>   (the code Settings → Devices → Add device shows on the other device)");
    const { status, data } = await api("POST", "/api/devices/pair", { code }, { user: true, timeoutMs: 60_000 });
    const result = data as { error?: string; device?: { name: string; id: string }; words?: string[]; others?: unknown[] };
    if (status !== 200 || !result.device) throw new Error(result.error || `Pairing failed (${status})`);
    process.stdout.write(`Paired with ${result.device.name} (${result.device.id}).\nCheck that it shows the same words: ${result.words?.join(" ")}\n`);
    return;
  }
  if (argv[0] === "add-device") {
    const before = new Set((await devicesView()).peers.map((peer) => peer.id));
    const { status, data } = await api("POST", "/api/devices/offer", {}, { user: true, timeoutMs: 60_000 });
    const offer = (data as { error?: string; offer?: DevicesView["offer"] }).offer;
    if (status !== 200 || !offer) throw new Error((data as { error?: string }).error || `Could not make a code (${status})`);
    process.stdout.write(`On the other device, open Settings → Devices → Add device → Enter code, or run scribe pair, with:\n\n  ${offer.code}\n\nWaiting until ${new Date(offer.expiresAt).toLocaleTimeString()} (Ctrl+C stops waiting; the code stays open)…\n`);
    while (Date.now() < offer.expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const view = await devicesView();
      const added = view.peers.find((peer) => !before.has(peer.id));
      if (added) {
        process.stdout.write(`Paired with ${added.name} (${added.id}).\n`);
        return;
      }
      if (!view.offer) break;
    }
    throw new Error("The code expired before another device used it.");
  }
  if (argv[0] === "unpair") {
    if (!rest) throw new Error("Usage: scribe unpair <name | id>");
    const peers = (await devicesView()).peers;
    const matches = peers.filter((peer) => peer.id === rest || peer.name.toLowerCase() === rest.toLowerCase());
    if (matches.length !== 1) throw new Error(matches.length ? `Several devices are called ${rest}: use the id (scribe devices).` : `No paired device ${rest}.`);
    await change("DELETE", `/api/devices/${encodeURIComponent(matches[0].id)}`, {}, "Could not revoke it");
    process.stdout.write(`Revoked ${matches[0].name}. It can no longer connect, and drops this device too when it is next online.\n`);
    return;
  }
  if (argv[0] === "rename") {
    if (!rest) throw new Error("Usage: scribe rename <name>");
    const view = await change("PUT", "/api/devices/self", { name: rest }, "Could not rename it");
    process.stdout.write(`This device is now ${view.self.name}.\n`);
    return;
  }
  const view = await devicesView();
  const lines = [`This device: ${view.self.name} (${view.self.id})`, `  Fingerprint ${view.self.fingerprint}`];
  if (view.self.hosts.length) lines.push(`  Listening on ${view.self.hosts.map((h) => `${h.includes(":") ? `[${h}]` : h}:${view.self.port}`).join(", ")}`);
  lines.push(view.peers.length ? "Paired devices:" : "No paired devices.");
  for (const peer of view.peers) lines.push(`  ${peer.name} (${peer.id})  ${peer.online ? `online${peer.rtt !== undefined ? `, ${peer.rtt} ms` : ""}` : peer.lastSeen ? `last seen ${new Date(peer.lastSeen).toLocaleString()}` : "offline"}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function serviceCommand(): Promise<void> {
  if (process.env.SCRIBE_THREAD) throw new Error("Installing the service is the user's: run it in your own terminal, not from an agent's chat.");
  const service = await import("./service.js");
  const action = argv[1];
  const out = action === "install" ? service.installService() : action === "uninstall" ? service.uninstallService() : action === "status" ? service.serviceStatus() : null;
  if (out === null) throw new Error("Usage: scribe service install | uninstall | status");
  process.stdout.write(`${out}\n`);
}

const COMMANDS: Record<string, () => Promise<void>> = {
  pair: devicesCommand,
  "add-device": devicesCommand,
  devices: devicesCommand,
  unpair: devicesCommand,
  rename: devicesCommand,
  service: serviceCommand,
  help: async () => void process.stdout.write(`${USAGE}\n`),
};

async function main(): Promise<void> {
  const command = argv[0] ? COMMANDS[argv[0]] : undefined;
  if (command) {
    try {
      await command();
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.has("--stop")) {
    const info = await health();
    if (!info) {
      log("Scribe is not running");
      return;
    }
    await api("POST", "/api/shutdown");
    log("Stop requested");
    return;
  }

  if (args.has("--daemon")) {
    hideChildWindows();
    migrateLegacyData(log);
    watchMemory();
    await startHttp();
    return;
  }

  // The desktop app starts (or replaces) the daemon this way before loading the board.
  if (args.has("--ensure")) {
    await ensureDaemon({ replace: true });
    return;
  }

  await startMcp();
}

main().catch((err) => {
  log(`Fatal: ${(err as Error).stack || err}`);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err.stack || err}`);
});

process.on("unhandledRejection", (err) => {
  log(`unhandledRejection: ${String(err)}`);
});
