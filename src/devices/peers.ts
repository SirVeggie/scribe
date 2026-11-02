import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { cleanName, deviceDir, displayFingerprint, fingerprintOf, loadIdentity, saveName, type Identity } from "./identity.js";
import { FEATURES, Link, PROTOCOL, peerDeviceOf, type Control } from "./link.js";
import { MAX_ATTEMPTS, decodeCode, makeOffer, pairProof, pairWords, sameProof, type Offer } from "./pairing.js";
import { qrSvg } from "./qr.js";
import { rememberName, type NamedDevice } from "./references.js";
import type { AgentGrant } from "./agentAccess.js";

/**
 * Paired devices and the links to them (#904). Each device listens for peers with TLS on a port of its
 * own (not the loopback API's), bound only to LAN and tailnet addresses, and accepts only keys it has
 * pinned, or one unknown key while a pairing offer is open. One link per pair: both sides dial, and
 * when two links meet, the one dialed by the smaller device id stays. Streams that come in over a link
 * go to the daemon's HTTP server, where callers.ts sees them as { viewer: "user", device }.
 */

export type Peer = {
  id: string;
  name: string;
  /** SPKI DER, base64. */
  publicKey: string;
  fingerprint: string;
  hosts: string[];
  port: number;
  pairedAt: number;
  lastSeen?: number;
  /** Names it had before, newest first, so links written with them still resolve (#908). */
  formerNames?: string[];
  /** What this device lets that device's agents do here (#911). Off when unset; pairing again clears it. */
  agents?: AgentGrant;
};

/** Accept peer connections from the internet (#910): an always-on device that relays and mirrors. */
export type PublicListen = { host: string };

/**
 * `revokedAt`: when each revoked key was revoked (#937). A device paired again after that, by code
 * or by an introduction from one that was, wins over the older revocation, so it can come back.
 */
type Saved = { peers: Peer[]; revoked: string[]; revokedAt?: Record<string, number>; public?: PublicListen };

/** A device whose mirror another device holds, and when that mirror last matched it (#910). */
export type MirrorHeld = { id: string; at: number };

export type PeerView = {
  id: string;
  name: string;
  fingerprint: string;
  online: boolean;
  rtt?: number;
  lastSeen?: number;
  pairedAt: number;
  error?: string;
  agents: AgentGrant;
  /** The device this one is reached through, when there is no direct route (#910). */
  via?: { id: string; name: string };
  /** Offline, with a mirror on an online device (#910): which one, and when it last matched. */
  mirror?: { id: string; name: string; at: number };
};

export type DevicesView = {
  self: { id: string; name: string; fingerprint: string; port: number; hosts: string[]; public: PublicListen | null };
  peers: PeerView[];
  offer: { code: string; qr: string; expiresAt: number } | null;
};

export type PairResult = { device: { id: string; name: string }; words: string[]; others: { id: string; name: string }[] };

export type PeerOptions = {
  home: string;
  port: number;
  /** Fixed addresses to listen on (tests, SCRIBE_PEER_HOSTS); otherwise LAN and tailnet interfaces. */
  hosts?: string[];
  version: string;
  log?: (line: string) => void;
};

const CONNECT_MS = 5000;
const HELLO_MS = 10_000;
const RESCAN_MS = 60_000;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 60_000;
/** How often a relayed link tries for a direct route again. */
const DIRECT_RETRY_MS = 5 * 60_000;

/** LAN (RFC 1918), tailnet (100.64/10 CGNAT) and unique-local IPv6 (fc00::/7, Tailscale's fd7a:…) addresses. */
export function peerHosts(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4" && privateV4(entry.address)) out.push(entry.address);
      else if (entry.family === "IPv6" && /^f[cd]/i.test(entry.address)) out.push(entry.address);
    }
  }
  return [...new Set(out)];
}

/** A LAN, tailnet, unique-local or link-local address, not one on the internet. */
function localAddress(host: string): boolean {
  if (net.isIPv4(host)) return privateV4(host) || host.startsWith("127.") || host.startsWith("169.254.");
  if (net.isIPv6(host)) return /^(f[cd]|fe80|::1$)/i.test(host);
  return false;
}

function privateV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128);
}

export class PeerService extends EventEmitter {
  readonly identity: Identity;
  private saved: Saved;
  private readonly links = new Map<string, Link>();
  private readonly dialing = new Set<string>();
  private readonly retry = new Map<string, { timer?: NodeJS.Timeout; delay: number }>();
  private readonly errors = new Map<string, string>();
  /** Each online device's Scribe VERSION, from its hello: the gateway serves our own UI files when it matches (#905). */
  private readonly versions = new Map<string, string>();
  private readonly servers = new Map<string, tls.Server>();
  private offer: Offer | null = null;
  private server: http.Server | null = null;
  private rescan: NodeJS.Timeout | undefined;
  private stopped = false;
  private binding: Promise<void> = Promise.resolve();
  private directTimer: NodeJS.Timeout | undefined;
  /** The mirrors this device holds, sent to every peer (#910). */
  private heldHere: MirrorHeld[] = [];
  /** The mirrors each online peer says it holds. */
  private readonly heldBy = new Map<string, MirrorHeld[]>();

  constructor(private readonly options: PeerOptions) {
    super();
    this.identity = loadIdentity(options.home);
    this.saved = this.load();
  }

  /** Where streams from peers go: the daemon's own HTTP server. */
  attach(server: http.Server): void {
    this.server = server;
    // Relays (#910): CONNECT over a link, from one paired device to another.
    server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => this.onRelay(req, socket, head));
  }

  async start(): Promise<void> {
    await this.bind();
    if (!this.options.hosts) {
      this.rescan = setInterval(() => void this.bind(), RESCAN_MS);
      this.rescan.unref();
    }
    for (const peer of this.saved.peers) this.connect(peer.id);
    this.directTimer = setInterval(() => {
      for (const [id, link] of this.links) if (link.via) void this.attempt(id, true);
    }, DIRECT_RETRY_MS);
    this.directTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.rescan);
    clearInterval(this.directTimer);
    for (const entry of this.retry.values()) clearTimeout(entry.timer);
    for (const link of this.links.values()) link.close();
    await Promise.all([...this.servers.values()].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.servers.clear();
  }

  /** The addresses other devices may dial: the public one first, then the LAN and tailnet ones listened on. */
  hosts(): string[] {
    const bound = [...this.servers.keys()].filter((host) => host !== "::" && host !== "0.0.0.0");
    const local = this.wildcard() ? (this.options.hosts ?? peerHosts()) : bound;
    return [...new Set([...(this.saved.public ? [this.saved.public.host] : []), ...local])];
  }

  /** Settings → Devices: accept connections from the internet on this address (a VPS's IP or name), or stop. */
  setPublic(value: unknown): void {
    const host = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (host && !cleanHosts([host]).length) throw new Error("Give an IP address or a host name, like scribe.example.com.");
    if (host) this.saved.public = { host };
    else delete this.saved.public;
    this.persist();
    void this.bind().then(() => {
      for (const link of this.links.values()) link.control({ type: "update", name: this.identity.name, hosts: this.hosts(), port: this.options.port });
    });
    this.changed();
  }

  /** The mirrors this device holds (#910); each peer learns them, so its gateway can fall back to one. */
  setMirrors(list: MirrorHeld[]): void {
    const same = list.length === this.heldHere.length && list.every((m, i) => m.id === this.heldHere[i].id && m.at === this.heldHere[i].at);
    if (same) return;
    this.heldHere = list.map(({ id, at }) => ({ id, at }));
    for (const link of this.links.values()) link.control({ type: "mirrors", list: this.heldHere });
  }

  /** A device that holds a mirror of this (offline) one, the freshest: an online peer, or this device itself. */
  mirrorOf(id: string): { holder: string; at: number } | undefined {
    const own = this.heldHere.find((m) => m.id === id);
    let best: { holder: string; at: number } | undefined = own ? { holder: this.identity.id, at: own.at } : undefined;
    for (const [holder, list] of this.heldBy) {
      if (holder === id || !this.links.get(holder)?.open) continue;
      const entry = list.find((m) => m.id === id);
      if (entry && (!best || entry.at > best.at)) best = { holder, at: entry.at };
    }
    return best;
  }

  /** Whether a linked device said in its hello that it does this. */
  supports(id: string, feature: string): boolean {
    return this.links.get(id)?.features.includes(feature) === true;
  }

  view(): DevicesView {
    this.expireOffer();
    return {
      self: { id: this.identity.id, name: this.identity.name, fingerprint: displayFingerprint(this.identity.fingerprint), port: this.options.port, hosts: this.hosts(), public: this.saved.public ?? null },
      peers: this.saved.peers.map((peer) => {
        const link = this.links.get(peer.id);
        const mirror = link ? undefined : this.mirrorOf(peer.id);
        return {
          id: peer.id,
          name: peer.name,
          fingerprint: displayFingerprint(peer.fingerprint),
          online: !!link,
          ...(link?.rtt !== undefined ? { rtt: link.rtt } : {}),
          ...(peer.lastSeen ? { lastSeen: link ? Date.now() : peer.lastSeen } : link ? { lastSeen: Date.now() } : {}),
          pairedAt: peer.pairedAt,
          agents: this.agentGrant(peer.id),
          ...(link?.via ? { via: { id: link.via, name: this.peer(link.via)?.name ?? link.via } } : {}),
          ...(mirror ? { mirror: { id: mirror.holder, name: mirror.holder === this.identity.id ? this.identity.name : this.peer(mirror.holder)?.name ?? mirror.holder, at: mirror.at } } : {}),
          ...(!link && this.errors.get(peer.id) ? { error: this.errors.get(peer.id) } : {}),
        };
      }),
      offer: this.offer ? { code: this.offer.code, qr: qrSvg(this.offer.code), expiresAt: this.offer.expiresAt } : null,
    };
  }

  rename(value: unknown): void {
    const name = cleanName(value);
    if (!name) throw new Error("Give the device a name.");
    const formerNames = saveName(this.options.home, name);
    this.identity.name = name;
    if (formerNames) this.identity.formerNames = formerNames;
    for (const link of this.links.values()) link.control({ type: "update", name, hosts: this.hosts(), port: this.options.port });
    this.changed();
  }

  /** What a paired device's agents may do on this device (#911); nothing for an unknown one. */
  agentGrant(id: string): AgentGrant {
    const grant = this.peer(id)?.agents;
    return { read: grant?.read === true, write: grant?.write === true, run: grant?.run === true };
  }

  /** Settings → Devices: turn agent access for a paired device on or off, one switch at a time. */
  setAgentGrant(id: string, value: unknown): void {
    const peer = this.peer(id);
    if (!peer) throw new Error("No such device.");
    const next: AgentGrant = { ...this.agentGrant(id) };
    const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    for (const key of ["read", "write", "run"] as const) if (typeof body[key] === "boolean") next[key] = body[key] as boolean;
    peer.agents = Object.fromEntries(Object.entries(next).filter(([, on]) => on)) as AgentGrant;
    if (!Object.keys(peer.agents).length) delete peer.agents;
    this.persist();
    this.changed();
  }

  /** Add device: a one-time code, open for ten minutes. A new one replaces the last. */
  async createOffer(): Promise<DevicesView["offer"]> {
    this.offer = null;
    await this.bind(true);
    const hosts = this.hosts();
    if (!hosts.length) throw new Error("This device has no LAN, tailnet or public address to be reached on.");
    this.offer = makeOffer(this.identity.fingerprint, this.options.port, hosts);
    const offer = this.offer;
    setTimeout(() => {
      if (this.offer === offer) {
        this.offer = null;
        void this.bind();
        this.changed();
      }
    }, offer.expiresAt - Date.now()).unref();
    this.changed();
    return this.view().offer;
  }

  cancelOffer(): void {
    this.offer = null;
    void this.bind();
    this.changed();
  }

  /** Enter code: dial the device that showed it, prove the code and swap keys. */
  async pair(code: string): Promise<PairResult> {
    const decoded = decodeCode(code);
    if (this.identity.fingerprint.startsWith(decoded.fingerprintPrefix)) throw new Error("That code is this device's own.");
    let lastError: Error = new Error("Could not reach the device that showed the code.");
    let unreachable = 0;
    for (const host of decoded.hosts) {
      let socket: tls.TLSSocket;
      let spki: Buffer;
      try {
        ({ socket, spki } = await this.dial(host, decoded.port, (fp) => fp.startsWith(decoded.fingerprintPrefix)));
      } catch (err) {
        lastError = err as Error;
        if (!/another key/.test(lastError.message)) unreachable++;
        continue;
      }
      const theirs = fingerprintOf(spki);
      const link = new Link(socket, true);
      try {
        const reply = await this.ask(link, {
          ...this.hello(),
          type: "pair",
          proof: pairProof(decoded.secret, "dialer", theirs, this.identity.fingerprint),
        }, (m) => m.type === "paired" || m.type === "pair_failed");
        if (reply.type === "pair_failed") throw new Error(typeof reply.error === "string" ? reply.error : "The other device refused the code.");
        if (!sameProof(reply.proof, pairProof(decoded.secret, "listener", theirs, this.identity.fingerprint))) throw new Error("The other device could not prove the code.");
        const peer = this.addPeer(reply, spki, host);
        if (!peer) throw new Error("The other device sent no usable name or id.");
        this.options.log?.(`Paired with ${peer.name} (${peer.id}) by its code`);
        this.connect(peer.id, true);
        return { device: { id: peer.id, name: peer.name }, words: pairWords(this.identity.fingerprint, peer.fingerprint), others: this.othersThan(peer.id) };
      } finally {
        link.close();
      }
    }
    // Only local-network or tailnet addresses, and none answered: this device is likely not on that
    // network (a VPS without Tailscale, #943). The other way round works when this one can be reached.
    if (unreachable === decoded.hosts.length && decoded.hosts.every(localAddress)) {
      throw new Error(`No answer from ${decoded.hosts.join(", ")} (port ${decoded.port}). Those are local-network or tailnet addresses, which this device may not reach. Pair the other way round: Add device here, and enter that code on the other device.`);
    }
    throw lastError;
  }

  /** Connect a newly paired device to the others: each side gets the other's key and addresses. */
  introduce(id: string, to?: string[]): number {
    const peer = this.peer(id);
    const link = this.links.get(id);
    if (!peer || !link) throw new Error("That device is not online.");
    let count = 0;
    for (const other of this.saved.peers) {
      if (other.id === id || (to && !to.includes(other.id))) continue;
      const otherLink = this.links.get(other.id);
      if (!otherLink) continue;
      otherLink.control({ type: "introduce", peer: record(peer) });
      link.control({ type: "introduce", peer: record(other) });
      count++;
    }
    return count;
  }

  /** Drop the device's key here and there, and tell the other paired devices to drop it too. */
  revoke(id: string): void {
    const peer = this.peer(id);
    if (!peer) throw new Error("No paired device with that id.");
    this.forget(peer, true);
    const at = this.saved.revokedAt?.[peer.fingerprint];
    for (const other of this.links.values()) other.control({ type: "revoked", id: peer.id, fingerprint: peer.fingerprint, at });
  }

  /**
   * This device leaves the pairing (#937): it drops every paired key and asks the online devices to
   * drop its key; they pass that on to the offline ones. The others stay paired with each other. Their
   * keys don't go on the revoked list here, and pairing again later with one of them rejoins the rest.
   */
  leave(): void {
    const count = this.saved.peers.length;
    for (const peer of [...this.saved.peers]) {
      this.links.get(peer.id)?.control({ type: "revoke", left: true });
      this.forget(peer, false, false);
    }
    this.options.log?.(`Left the pairing with ${count} device${count === 1 ? "" : "s"}`);
  }

  /** An HTTP request to a paired device's daemon over the link (the gateway builds on this, #905). */
  request(id: string, options: http.RequestOptions & { body?: string | Buffer }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    const link = this.links.get(id);
    if (!link) return Promise.reject(new Error("That device is not online."));
    return new Promise((resolve, reject) => {
      const req = http.request({ ...options, createConnection: () => link.openStream() as unknown as net.Socket }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(options.body);
    });
  }

  /** The link to a paired device, for streams of its own (WebSocket proxying in #905). */
  linkTo(id: string): Link | undefined {
    return this.links.get(id);
  }

  /** The Scribe VERSION a linked device runs, from its hello. */
  versionOf(id: string): string | undefined {
    return this.links.has(id) ? this.versions.get(id) : undefined;
  }

  /** This device and the paired ones, with their former names, for device references (#908). */
  devices(): Array<NamedDevice & { self: boolean; online: boolean }> {
    return [
      { id: this.identity.id, name: this.identity.name, formerNames: this.identity.formerNames, self: true, online: true },
      ...this.saved.peers.map((peer) => ({ id: peer.id, name: peer.name, formerNames: peer.formerNames, self: false, online: this.links.has(peer.id) })),
    ];
  }

  /** A paired device's name, for the gateway's offline page. */
  nameOf(id: string): string | undefined {
    return this.peer(id)?.name;
  }

  // --- listening ---

  /**
   * Listen while there is someone to listen for: a paired device or an open code. A device that never
   * pairs opens no network port (and gets no firewall prompt).
   */
  private bind(opening = false): Promise<void> {
    // One at a time, so two calls don't both open a listener on the same address.
    this.binding = this.binding.then(() => this.bindNow(opening));
    return this.binding;
  }

  private async bindNow(opening: boolean): Promise<void> {
    if (this.stopped) return;
    const needed = opening || !!this.offer || this.saved.peers.length > 0;
    // A public device listens on every interface; the pinned keys, not the address, decide who gets in.
    const wanted = !needed ? [] : this.wildcard() ? ["::"] : (this.options.hosts ?? peerHosts());
    for (const [host, server] of this.servers) {
      if (!wanted.includes(host)) {
        server.close();
        this.servers.delete(host);
      }
    }
    for (const host of wanted) {
      if (this.servers.has(host)) continue;
      const server = tls.createServer({ key: this.identity.keyPem, cert: this.identity.certPem, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" });
      server.on("secureConnection", (socket) => this.accept(socket));
      server.on("tlsClientError", () => {});
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.options.port, host, () => {
            server.off("error", reject);
            resolve();
          });
        });
        server.on("error", (err) => this.options.log?.(`Peer listener ${host}: ${err.message}`));
        this.servers.set(host, server);
      } catch (err) {
        this.options.log?.(`Peer listener ${host}:${this.options.port} failed: ${(err as Error).message}`);
        // No IPv6 here: listen on every IPv4 interface instead.
        if (host === "::" && !this.servers.has("0.0.0.0")) wanted.push("0.0.0.0");
      }
    }
    this.changed();
  }

  /** Listening on every interface: a public device, unless tests or SCRIBE_PEER_HOSTS fix the addresses. */
  private wildcard(): boolean {
    return !!this.saved.public && !this.options.hosts;
  }

  /** `via`: the device that relayed this connection; only paired devices come in that way. */
  private accept(socket: tls.TLSSocket, via?: string): void {
    const spki = peerKey(socket);
    const fp = spki && fingerprintOf(spki);
    if (!fp || fp === this.identity.fingerprint) {
      socket.destroy();
      return;
    }
    socket.on("error", () => {});
    // A revoked key isn't in the list, so like any unknown key it may only pair, with a code.
    const peer = this.saved.peers.find((p) => p.fingerprint === fp);
    if (peer) {
      // A paired device says hello, or pairs again with a code (after it lost its copy of this one's key).
      const link = new Link(socket, false, peer.id);
      if (via) link.via = via;
      this.ask(link, null, (m) => m.type === "hello" || (m.type === "pair" && !!this.offer && !via))
        .then((message) => {
          if (message.type === "pair") return this.answerPair(link, spki, message);
          link.control(this.hello());
          this.adopt(peer.id, link, message);
        })
        .catch(() => link.close());
      return;
    }
    this.expireOffer();
    if (!this.offer || via) {
      // A key revoked here hears so, and its Devices list says why it can't connect (#943).
      if (this.saved.revoked.includes(fp)) {
        const link = new Link(socket, false);
        link.control({ type: "refused", reason: "revoked", name: this.identity.name });
        setTimeout(() => link.close(), 200).unref();
      } else socket.destroy();
      return;
    }
    // An unknown key while an offer is open: it may only pair.
    const link = new Link(socket, false);
    this.ask(link, null, (m) => m.type === "pair")
      .then((message) => this.answerPair(link, spki, message))
      .catch(() => link.close());
  }

  private answerPair(link: Link, spki: Buffer, message: Control): void {
    const fp = fingerprintOf(spki);
    const offer = this.offer;
    const fail = (error: string) => {
      link.control({ type: "pair_failed", error });
      setTimeout(() => link.close(), 200).unref();
    };
    if (!offer || offer.expiresAt < Date.now()) return fail("The code has expired. Make a new one.");
    if (!sameProof(message.proof, pairProof(offer.secret, "dialer", this.identity.fingerprint, fp))) {
      if (++offer.attempts >= MAX_ATTEMPTS) {
        this.offer = null;
        void this.bind();
        this.changed();
      }
      return fail("Wrong code.");
    }
    const peer = this.addPeer(message, spki, link.socket.remoteAddress);
    if (!peer) return fail("Send a device id and name.");
    this.options.log?.(`Paired with ${peer.name} (${peer.id}) by this device's code`);
    this.offer = null;
    link.control({ ...this.hello(), type: "paired", proof: pairProof(offer.secret, "listener", this.identity.fingerprint, fp) });
    setTimeout(() => link.close(), 200).unref();
    const result: PairResult = { device: { id: peer.id, name: peer.name }, words: pairWords(this.identity.fingerprint, fp), others: this.othersThan(peer.id) };
    this.emit("paired", result);
    this.changed();
  }

  // --- dialing ---

  private connect(id: string, now = false): void {
    if (this.stopped || this.links.has(id) || this.dialing.has(id)) return;
    const entry = this.retry.get(id) ?? { delay: 0 };
    this.retry.set(id, entry);
    clearTimeout(entry.timer);
    const delay = now ? 0 : entry.delay;
    entry.timer = setTimeout(() => void this.attempt(id), delay);
    entry.timer.unref();
  }

  /** `direct`: a relayed link looking for a direct route; it stays as it is when there is none. */
  private async attempt(id: string, direct = false): Promise<void> {
    const peer = this.peer(id);
    if (!peer || this.stopped || this.dialing.has(id)) return;
    if (this.links.has(id) && !(direct && this.links.get(id)!.via)) return;
    this.dialing.add(id);
    try {
      for (const host of peer.hosts) {
        let socket: tls.TLSSocket;
        try {
          ({ socket } = await this.dial(host, peer.port, (fp) => fp === peer.fingerprint));
        } catch (err) {
          this.errors.set(id, (err as Error).message);
          continue;
        }
        const link = new Link(socket, true, id);
        try {
          const hello = await this.helloFrom(link);
          if (this.adopt(id, link, hello)) return;
        } catch (err) {
          this.errors.set(id, (err as Error).message);
          link.close();
        }
      }
      if (direct) return;
      // No direct route: through any directly linked device that relays (#910).
      for (const [relay, outer] of this.links) {
        if (relay === id || outer.via || !outer.open || !outer.features.includes("relay")) continue;
        let socket: tls.TLSSocket;
        try {
          socket = await this.dialVia(relay, id, peer.fingerprint);
        } catch (err) {
          this.errors.set(id, (err as Error).message);
          continue;
        }
        const link = new Link(socket, true, id);
        link.via = relay;
        try {
          const hello = await this.helloFrom(link);
          if (this.adopt(id, link, hello)) return;
        } catch (err) {
          this.errors.set(id, (err as Error).message);
          link.close();
        }
      }
    } finally {
      this.dialing.delete(id);
    }
    if (direct) return;
    const entry = this.retry.get(id);
    if (entry && !this.links.has(id)) {
      // Back off, with jitter, so two devices that both just woke don't dial in lockstep.
      entry.delay = Math.min(BACKOFF_MAX, Math.max(BACKOFF_MIN, entry.delay * 2)) * (0.8 + Math.random() * 0.4);
      this.connect(id);
    }
  }

  /**
   * A TLS connection to `target` inside a stream through `relay` (#910): CONNECT /relay/<target> over the
   * link, then the same pinned-key handshake as a direct dial. The relay only ever sees ciphertext.
   */
  private dialVia(relay: string, target: string, fingerprint: string): Promise<tls.TLSSocket> {
    const outer = this.links.get(relay);
    if (!outer) return Promise.reject(new Error("The relay is offline."));
    return new Promise((resolve, reject) => {
      const req = http.request({
        method: "CONNECT",
        path: `/relay/${target}`,
        headers: { host: "relay" },
        createConnection: () => outer.openStream() as unknown as net.Socket,
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`No answer through ${this.peer(relay)?.name ?? relay}`));
      }, CONNECT_MS);
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.on("connect", (res, stream, head) => {
        clearTimeout(timer);
        if (res.statusCode !== 200) {
          stream.destroy();
          reject(new Error(`${this.peer(relay)?.name ?? "The relay"} could not reach it (${res.statusCode}).`));
          return;
        }
        if (head.length) stream.unshift(head);
        const socket = tls.connect({ socket: stream, key: this.identity.keyPem, cert: this.identity.certPem, rejectUnauthorized: false, minVersion: "TLSv1.3" });
        const fail = (error: Error) => {
          socket.destroy();
          reject(error);
        };
        const handshake = setTimeout(() => fail(new Error("The relayed device did not answer.")), CONNECT_MS);
        socket.once("error", (err) => { clearTimeout(handshake); fail(err); });
        socket.once("secureConnect", () => {
          clearTimeout(handshake);
          const spki = peerKey(socket);
          if (!spki || fingerprintOf(spki) !== fingerprint) return fail(new Error("The relayed device answered with another key"));
          socket.removeAllListeners("error");
          socket.on("error", () => {});
          resolve(socket);
        });
      });
      req.end();
    });
  }

  /**
   * CONNECT on the HTTP server, from a link (#910). `/relay/<target>`: a paired device asks this one to
   * pipe a stream to another paired device. `/relay-in/<from>`: a relay hands this device a connection
   * from a device it is paired with, which then shakes hands like any peer.
   */
  private onRelay(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    const caller = peerDeviceOf(socket);
    const match = /^\/(relay|relay-in)\/([0-9a-f]{12})$/.exec(req.url ?? "");
    if (!caller || !match || !this.peer(caller)) return void refuse("403 Forbidden");
    const [, kind, other] = match;
    if (kind === "relay-in") {
      // Only for a device paired here; the handshake checks its key.
      if (!this.peer(other) || other === caller) return void refuse("403 Forbidden");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      const tlsSocket = new tls.TLSSocket(socket, { isServer: true, key: this.identity.keyPem, cert: this.identity.certPem, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" } as tls.TLSSocketOptions);
      const timer = setTimeout(() => tlsSocket.destroy(), CONNECT_MS);
      tlsSocket.on("error", () => tlsSocket.destroy());
      tlsSocket.once("secure", () => {
        clearTimeout(timer);
        this.accept(tlsSocket, caller);
      });
      return;
    }
    // Any two devices paired with this one, over direct links (no relay chains).
    const link = this.links.get(other);
    const from = this.links.get(caller);
    if (other === caller || other === this.identity.id || !link?.open || link.via || from?.via) return void refuse("502 Bad Gateway");
    const inner = http.request({
      method: "CONNECT",
      path: `/relay-in/${caller}`,
      headers: { host: "relay" },
      createConnection: () => link.openStream() as unknown as net.Socket,
    });
    inner.on("error", () => refuse("502 Bad Gateway"));
    inner.on("connect", (res, stream, rest) => {
      if (res.statusCode !== 200) {
        stream.destroy();
        refuse("502 Bad Gateway");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) socket.write(rest);
      if (head.length) stream.write(head);
      socket.pipe(stream).pipe(socket);
      const close = () => { socket.destroy(); stream.destroy(); };
      socket.on("error", close);
      stream.on("error", close);
      socket.on("close", () => stream.destroy());
      stream.on("close", () => socket.destroy());
    });
    inner.end();
  }

  private dial(host: string, port: number, check: (fingerprint: string) => boolean): Promise<{ socket: tls.TLSSocket; spki: Buffer }> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, key: this.identity.keyPem, cert: this.identity.certPem, rejectUnauthorized: false, minVersion: "TLSv1.3", timeout: CONNECT_MS });
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("timeout", () => fail(new Error(`No answer from ${host}:${port}`)));
      socket.once("error", (err) => fail(new Error(`${host}:${port}: ${err.message}`)));
      socket.once("secureConnect", () => {
        socket.setTimeout(0);
        const spki = peerKey(socket);
        if (!spki || !check(fingerprintOf(spki))) return fail(new Error(`${host}:${port} answered with another key`));
        socket.removeAllListeners("error");
        socket.on("error", () => {});
        resolve({ socket, spki });
      });
    });
  }

  // --- links ---

  private hello(): Control {
    return { type: "hello", protocol: PROTOCOL, features: FEATURES, version: this.options.version, id: this.identity.id, name: this.identity.name, hosts: this.hosts(), port: this.options.port, revoked: this.saved.revoked, revokedAt: this.saved.revokedAt, mirrors: this.heldHere };
  }

  /** Our hello, and theirs back; a device that revoked this one's key says so instead (#943). */
  private async helloFrom(link: Link): Promise<Control> {
    const reply = await this.ask(link, this.hello(), (m) => m.type === "hello" || m.type === "refused");
    if (reply.type === "refused") {
      const name = cleanName(reply.name) ?? "The other device";
      throw new Error(`${name} revoked this device's key. Pair the two again with a code.`);
    }
    return reply;
  }

  /** Send first (if given), then wait for a control message that matches. */
  private ask(link: Link, first: Control | null, match: (message: Control) => boolean): Promise<Control> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("The other device did not answer.")), HELLO_MS);
      const onControl = (message: Control) => {
        if (match(message)) done(null, message);
      };
      const onClose = () => done(new Error("The other device closed the connection."));
      const done = (error: Error | null, message?: Control) => {
        clearTimeout(timer);
        link.off("control", onControl);
        link.off("close", onClose);
        if (error) reject(error);
        else resolve(message!);
      };
      link.on("control", onControl);
      link.on("close", onClose);
      if (first) link.control(first);
    });
  }

  /** Take a link that finished its hello. False when it was dropped (another link won, or the versions don't match). */
  private adopt(id: string, link: Link, hello: Control): boolean {
    const peer = this.peer(id);
    if (!peer || hello.id !== id) {
      link.close();
      return false;
    }
    if (hello.protocol !== PROTOCOL) {
      this.errors.set(id, `It speaks link protocol ${String(hello.protocol)}, this device ${PROTOCOL}: update the older one.`);
      const entry = this.retry.get(id);
      if (entry) entry.delay = BACKOFF_MAX;
      link.close();
      this.changed();
      return false;
    }
    const existing = this.links.get(id);
    if (existing?.open) {
      // A direct link beats a relayed one; between two of a kind, the one dialed by the smaller id stays.
      const keepNew = !!existing.via !== !!link.via ? !link.via : link.dialer === (this.identity.id < id);
      if (!keepNew) {
        link.close();
        return true;
      }
      this.links.delete(id);
      existing.close();
    }
    this.learn(peer, hello);
    this.links.set(id, link);
    this.heldBy.set(id, cleanMirrors(hello.mirrors));
    if (typeof hello.version === "string") this.versions.set(id, hello.version.slice(0, 40));
    // Revocations made while this device was away reach it from whichever peer it meets first.
    const revokedAt = hello.revokedAt && typeof hello.revokedAt === "object" ? (hello.revokedAt as Record<string, unknown>) : {};
    // Revocations made before they carried a time (#937) are older than any pairing since.
    if (Array.isArray(hello.revoked)) for (const fingerprint of hello.revoked.slice(0, 500)) this.onControl(id, link, { type: "revoked", fingerprint, at: revokedAt[fingerprint] ?? 0 });
    this.errors.delete(id);
    const entry = this.retry.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.delay = 0;
    }
    link.on("stream", (stream) => {
      if (this.server) this.server.emit("connection", stream);
      else stream.destroy();
    });
    link.on("control", (message: Control) => this.onControl(id, link, message));
    link.on("rtt", () => this.changed());
    link.on("close", () => {
      if (this.links.get(id) !== link) return;
      this.links.delete(id);
      this.heldBy.delete(id);
      const current = this.peer(id);
      if (current) {
        current.lastSeen = Date.now();
        this.persist();
        this.connect(id);
      }
      this.changed();
    });
    link.ping();
    this.spread(peer, link);
    // Devices that relay through this one are worth a fresh try now, instead of at their next backoff.
    if (!link.via && link.features.includes("relay")) {
      for (const other of this.saved.peers) if (!this.links.has(other.id) && other.id !== id) this.connect(other.id, true);
    }
    // The mirrors this device holds changed while the other one was away: hello carried them.
    this.changed();
    return true;
  }

  /**
   * Every paired device reaches every other one (#931): a device that comes online learns about this
   * one's other devices, and the online ones learn about it. Receivers skip keys they already have or
   * revoked, so the devices converge on a full mesh without the user introducing them.
   */
  private spread(peer: Peer, link: Link): void {
    for (const other of this.saved.peers) {
      if (other.id === peer.id) continue;
      link.control({ type: "introduce", peer: record(other) });
      this.links.get(other.id)?.control({ type: "introduce", peer: record(peer) });
    }
  }

  private onControl(id: string, _link: Link, message: Control): void {
    const peer = this.peer(id);
    if (!peer) return;
    if (message.type === "update") {
      this.learn(peer, message);
      this.changed();
    } else if (message.type === "mirrors") {
      this.heldBy.set(id, cleanMirrors(message.list));
      this.changed();
    } else if (message.type === "revoke") {
      // It left (#937): drop it everywhere, as a revocation. Otherwise it dropped this device (it or
      // another device revoked this one): only forget its key. Recording that as a revocation made by
      // this device would travel with it when it pairs again and cut it off from the rest (#943).
      this.forget(peer, false, message.left === true);
    } else if (message.type === "revoked") {
      const fp = message.fingerprint;
      if (typeof fp !== "string" || fp === this.identity.fingerprint) return;
      // A live one from an older device has no time and counts as made now; in a hello, an untimed one is old.
      const at = typeof message.at === "number" && message.at <= Date.now() ? message.at : Date.now();
      const target = this.saved.peers.find((p) => p.fingerprint === fp);
      // Paired again since: the revocation is older news.
      if (target && target.pairedAt > at) return;
      if (target) this.forget(target, true, true, at);
      else if (!this.saved.revoked.includes(fp) || (this.saved.revokedAt?.[fp] ?? 0) < at) {
        if (!this.saved.revoked.includes(fp)) this.saved.revoked.push(fp);
        this.saved.revokedAt = { ...this.saved.revokedAt, [fp]: at };
        this.persist();
      }
    } else if (message.type === "introduce") {
      const intro = message.peer as Partial<Peer> | undefined;
      if (!intro || typeof intro.publicKey !== "string") return;
      const spki = Buffer.from(intro.publicKey, "base64");
      const fp = fingerprintOf(spki);
      const pairedAt = typeof intro.pairedAt === "number" && intro.pairedAt <= Date.now() ? intro.pairedAt : undefined;
      // A key revoked here comes back only when the introducer paired it after that revocation.
      const revoked = this.saved.revoked.includes(fp) && !(pairedAt && pairedAt > (this.saved.revokedAt?.[fp] ?? 0));
      if (fp === this.identity.fingerprint || this.saved.peers.some((p) => p.fingerprint === fp)) return;
      if (revoked) {
        this.options.log?.(`Refused ${peer.name}'s introduction of ${cleanName(intro.name) ?? "a device"}: its key was revoked here, after ${peer.name} paired it`);
        return;
      }
      const added = this.store({ id: intro.id, name: intro.name, hosts: intro.hosts, port: intro.port, pairedAt }, spki);
      if (added) {
        this.options.log?.(`${peer.name} introduced ${added.name}`);
        this.connect(added.id, true);
        this.changed();
      }
    }
  }

  private learn(peer: Peer, message: Control): void {
    const name = cleanName(message.name);
    if (name && name !== peer.name) {
      const formerNames = rememberName(peer.formerNames, peer.name, name);
      if (formerNames) peer.formerNames = formerNames;
      peer.name = name;
    }
    const hosts = cleanHosts(message.hosts);
    if (hosts.length) peer.hosts = hosts;
    if (validPort(message.port)) peer.port = message.port;
    peer.lastSeen = Date.now();
    this.persist();
  }

  // --- the paired devices file ---

  /**
   * Paired by code. `seenAt`: the address it was reached on (or came from), tried first; its own hints
   * may include ones we can't route to.
   */
  private addPeer(message: Control, spki: Buffer, seenAt?: string): Peer | undefined {
    const hosts = cleanHosts(message.hosts);
    if (seenAt) hosts.unshift(seenAt.replace(/^::ffff:/, ""));
    const fp = fingerprintOf(spki);
    // A device with no other paired device joins the other one's devices: revocations it kept from
    // before would only travel with its hellos and cut it, or the others, off from each other (#943).
    if (!this.saved.peers.some((p) => p.fingerprint !== fp) && this.saved.revoked.length) {
      this.options.log?.(`Dropped ${this.saved.revoked.length} old revocation${this.saved.revoked.length === 1 ? "" : "s"} on pairing from no paired devices`);
      this.saved.revoked = [];
      delete this.saved.revokedAt;
    }
    this.saved.peers = this.saved.peers.filter((p) => p.fingerprint !== fp);
    return this.store({ id: message.id, name: message.name, hosts, port: message.port }, spki);
  }

  /** `pairedAt`: when the introducing device paired it, so a later revocation still wins over it. */
  private store(info: { id?: unknown; name?: unknown; hosts?: unknown; port?: unknown; pairedAt?: number }, spki: Buffer): Peer | undefined {
    const id = typeof info.id === "string" && /^[0-9a-f]{12}$/.test(info.id) ? info.id : undefined;
    const name = cleanName(info.name);
    if (!id || !name || id === this.identity.id || !validPort(info.port)) return undefined;
    const old = this.links.get(id);
    const before = this.peer(id);
    this.saved.peers = this.saved.peers.filter((p) => p.id !== id);
    old?.close();
    const fp = fingerprintOf(spki);
    this.saved.revoked = this.saved.revoked.filter((r) => r !== fp);
    if (this.saved.revokedAt?.[fp] !== undefined) delete this.saved.revokedAt[fp];
    const peer: Peer = { id, name, publicKey: spki.toString("base64"), fingerprint: fp, hosts: [...new Set(cleanHosts(info.hosts))], port: info.port, pairedAt: info.pairedAt ?? Date.now() };
    const formerNames = before ? rememberName(before.formerNames, before.name, name) : undefined;
    if (formerNames) peer.formerNames = formerNames;
    this.saved.peers.push(peer);
    this.persist();
    void this.bind();
    return peer;
  }

  /**
   * Drop a device's key. `tell`: ask it to drop this device's key too, if it is online. `revoke`: keep
   * its key on the revoked list, which spreads to the other devices, as revoked `at`.
   */
  private forget(peer: Peer, tell = false, revoke = true, at = Date.now()): void {
    this.saved.peers = this.saved.peers.filter((p) => p.id !== peer.id);
    if (revoke) {
      if (!this.saved.revoked.includes(peer.fingerprint)) this.saved.revoked.push(peer.fingerprint);
      this.saved.revokedAt = { ...this.saved.revokedAt, [peer.fingerprint]: at };
    }
    this.persist();
    const entry = this.retry.get(peer.id);
    clearTimeout(entry?.timer);
    this.retry.delete(peer.id);
    this.errors.delete(peer.id);
    const link = this.links.get(peer.id);
    if (tell) link?.control({ type: "revoke" });
    this.links.delete(peer.id);
    if (link) setTimeout(() => link.close(), 100).unref();
    this.options.log?.(`Device ${peer.name} (${peer.id}) ${revoke ? "revoked" : "dropped"}`);
    void this.bind();
    this.changed();
  }

  private peer(id: string): Peer | undefined {
    return this.saved.peers.find((p) => p.id === id);
  }

  private othersThan(id: string): { id: string; name: string }[] {
    return this.saved.peers.filter((p) => p.id !== id).map((p) => ({ id: p.id, name: p.name }));
  }

  private expireOffer(): void {
    if (this.offer && this.offer.expiresAt < Date.now()) this.offer = null;
  }

  private file(): string {
    return path.join(deviceDir(this.options.home), "peers.json");
  }

  private load(): Saved {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Partial<Saved>;
      const revokedAt = saved.revokedAt && typeof saved.revokedAt === "object" ? saved.revokedAt : undefined;
      const pub = typeof saved.public?.host === "string" ? { host: saved.public.host } : undefined;
      return { peers: Array.isArray(saved.peers) ? saved.peers : [], revoked: Array.isArray(saved.revoked) ? saved.revoked : [], ...(revokedAt && { revokedAt }), ...(pub && { public: pub }) };
    } catch {
      return { peers: [], revoked: [] };
    }
  }

  private persist(): void {
    const file = this.file();
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  private changed(): void {
    this.emit("change");
  }
}

/** The other side's public key (SPKI DER), read once the handshake is done. */
function peerKey(socket: tls.TLSSocket): Buffer | undefined {
  return socket.getPeerX509Certificate()?.publicKey.export({ type: "spki", format: "der" });
}

function record(peer: Peer): Partial<Peer> {
  return { id: peer.id, name: peer.name, publicKey: peer.publicKey, hosts: peer.hosts, port: peer.port, pairedAt: peer.pairedAt };
}

/** IP addresses, and host names for a public device (#910). */
function cleanHosts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((h): h is string => typeof h === "string" && (net.isIP(h) !== 0 || hostName(h))).slice(0, 8) : [];
}

function hostName(value: string): boolean {
  return value.length <= 253 && /^(?=.*[a-z])[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
}

function cleanMirrors(value: unknown): MirrorHeld[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is MirrorHeld => !!m && typeof m.id === "string" && /^[0-9a-f]{12}$/.test(m.id) && typeof m.at === "number")
    .slice(0, 100)
    .map(({ id, at }) => ({ id, at }));
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}
