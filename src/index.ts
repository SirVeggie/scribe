import { startHttp } from "./http.js";
import { startMcp } from "./mcp.js";
import { api, ensureDaemon, health } from "./daemon.js";
import { log } from "./log.js";
import { migrateLegacyData } from "./config.js";
import { watchMemory } from "./memoryWatch.js";
import { hideChildWindows } from "./hideWindows.js";

const argv = process.argv.slice(2);
const args = new Set(argv);

/** `scribe pair <code>` and `scribe devices` (#904): pairing for a device without the board UI. */
async function devicesCommand(): Promise<void> {
  if (process.env.SCRIBE_THREAD) throw new Error("Pairing is the user's: run it in your own terminal, not from an agent's chat.");
  if (!(await health())) throw new Error("Scribe is not running. Start it first (npm start).");
  if (argv[0] === "pair") {
    const code = argv.slice(1).join("");
    if (!code) throw new Error("Usage: scribe pair <code>   (the code Settings → Devices → Add device shows on the other device)");
    const { status, data } = await api("POST", "/api/devices/pair", { code }, { user: true, timeoutMs: 60_000 });
    const result = data as { error?: string; device?: { name: string; id: string }; words?: string[]; others?: unknown[] };
    if (status !== 200 || !result.device) throw new Error(result.error || `Pairing failed (${status})`);
    process.stdout.write(`Paired with ${result.device.name} (${result.device.id}).\nCheck that it shows the same words: ${result.words?.join(" ")}\n`);
    return;
  }
  const { status, data } = await api("GET", "/api/devices", undefined, { user: true });
  const view = data as { error?: string; self: { name: string; id: string; fingerprint: string; hosts: string[]; port: number }; peers: { name: string; id: string; online: boolean; rtt?: number; lastSeen?: number }[] };
  if (status !== 200) throw new Error(view.error || `Could not list devices (${status})`);
  const lines = [`This device: ${view.self.name} (${view.self.id})`, `  Fingerprint ${view.self.fingerprint}`];
  if (view.self.hosts.length) lines.push(`  Listening on ${view.self.hosts.map((h) => `${h.includes(":") ? `[${h}]` : h}:${view.self.port}`).join(", ")}`);
  lines.push(view.peers.length ? "Paired devices:" : "No paired devices.");
  for (const peer of view.peers) lines.push(`  ${peer.name} (${peer.id})  ${peer.online ? `online${peer.rtt !== undefined ? `, ${peer.rtt} ms` : ""}` : peer.lastSeen ? `last seen ${new Date(peer.lastSeen).toLocaleString()}` : "offline"}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  if (argv[0] === "pair" || argv[0] === "devices") {
    try {
      await devicesCommand();
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
