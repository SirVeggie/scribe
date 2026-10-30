import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { cleanName, deviceDir, displayFingerprint, fingerprintOf, loadIdentity, saveName, type Identity } from "./identity.js";
import { Link, PROTOCOL, type Control } from "./link.js";
import { MAX_ATTEMPTS, decodeCode, makeOffer, pairProof, pairWords, sameProof, type Offer } from "./pairing.js";
import { qrSvg } from "./qr.js";

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
};

type Saved = { peers: Peer[]; revoked: string[] };

export type PeerView = {
  id: string;
  name: string;
  fingerprint: string;
  online: boolean;
  rtt?: number;
  lastSeen?: number;
  pairedAt: number;
  error?: string;
};

export type DevicesView = {
  self: { id: string; name: string; fingerprint: string; port: number; hosts: string[] };
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
  private readonly servers = new Map<string, tls.Server>();
  private offer: Offer | null = null;
  private server: http.Server | null = null;
  private rescan: NodeJS.Timeout | undefined;
  private stopped = false;
  private binding: Promise<void> = Promise.resolve();

  constructor(private readonly options: PeerOptions) {
    super();
    this.identity = loadIdentity(options.home);
    this.saved = this.load();
  }

  /** Where streams from peers go: the daemon's own HTTP server. */
  attach(server: http.Server): void {
    this.server = server;
  }

  async start(): Promise<void> {
    await this.bind();
    if (!this.options.hosts) {
      this.rescan = setInterval(() => void this.bind(), RESCAN_MS);
      this.rescan.unref();
    }
    for (const peer of this.saved.peers) this.connect(peer.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.rescan);
    for (const entry of this.retry.values()) clearTimeout(entry.timer);
    for (const link of this.links.values()) link.close();
    await Promise.all([...this.servers.values()].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.servers.clear();
  }

  hosts(): string[] {
    return [...this.servers.keys()];
  }

  view(): DevicesView {
    this.expireOffer();
    return {
      self: { id: this.identity.id, name: this.identity.name, fingerprint: displayFingerprint(this.identity.fingerprint), port: this.options.port, hosts: this.hosts() },
      peers: this.saved.peers.map((peer) => {
        const link = this.links.get(peer.id);
        return {
          id: peer.id,
          name: peer.name,
          fingerprint: displayFingerprint(peer.fingerprint),
          online: !!link,
          ...(link?.rtt !== undefined ? { rtt: link.rtt } : {}),
          ...(peer.lastSeen ? { lastSeen: link ? Date.now() : peer.lastSeen } : link ? { lastSeen: Date.now() } : {}),
          pairedAt: peer.pairedAt,
          ...(!link && this.errors.get(peer.id) ? { error: this.errors.get(peer.id) } : {}),
        };
      }),
      offer: this.offer ? { code: this.offer.code, qr: qrSvg(this.offer.code), expiresAt: this.offer.expiresAt } : null,
    };
  }

  rename(value: unknown): void {
    const name = cleanName(value);
    if (!name) throw new Error("Give the device a name.");
    saveName(this.options.home, name);
    this.identity.name = name;
    for (const link of this.links.values()) link.control({ type: "update", name, hosts: this.hosts(), port: this.options.port });
    this.changed();
  }

  /** Add device: a one-time code, open for ten minutes. A new one replaces the last. */
  async createOffer(): Promise<DevicesView["offer"]> {
    this.offer = null;
    await this.bind(true);
    const hosts = this.hosts();
    if (!hosts.length) throw new Error("This device has no LAN or tailnet address to be reached on.");
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
    for (const host of decoded.hosts) {
      let socket: tls.TLSSocket;
      let spki: Buffer;
      try {
        ({ socket, spki } = await this.dial(host, decoded.port, (fp) => fp.startsWith(decoded.fingerprintPrefix)));
      } catch (err) {
        lastError = err as Error;
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
        this.connect(peer.id, true);
        return { device: { id: peer.id, name: peer.name }, words: pairWords(this.identity.fingerprint, peer.fingerprint), others: this.othersThan(peer.id) };
      } finally {
        link.close();
      }
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
    for (const other of this.links.values()) other.control({ type: "revoked", id: peer.id, fingerprint: peer.fingerprint });
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
    const wanted = needed ? (this.options.hosts ?? peerHosts()) : [];
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
      }
    }
    this.changed();
  }

  private accept(socket: tls.TLSSocket): void {
    const spki = peerKey(socket);
    const fp = spki && fingerprintOf(spki);
    if (!fp || fp === this.identity.fingerprint || this.saved.revoked.includes(fp)) {
      socket.destroy();
      return;
    }
    socket.on("error", () => {});
    const peer = this.saved.peers.find((p) => p.fingerprint === fp);
    if (peer) {
      // A paired device says hello, or pairs again with a code (after it lost its copy of this one's key).
      const link = new Link(socket, false, peer.id);
      this.ask(link, null, (m) => m.type === "hello" || (m.type === "pair" && !!this.offer))
        .then((message) => {
          if (message.type === "pair") return this.answerPair(link, spki, message);
          link.control(this.hello());
          this.adopt(peer.id, link, message);
        })
        .catch(() => link.close());
      return;
    }
    this.expireOffer();
    if (!this.offer) {
      socket.destroy();
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

  private async attempt(id: string): Promise<void> {
    const peer = this.peer(id);
    if (!peer || this.stopped || this.links.has(id) || this.dialing.has(id)) return;
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
          const hello = await this.ask(link, this.hello(), (m) => m.type === "hello");
          if (this.adopt(id, link, hello)) return;
        } catch (err) {
          this.errors.set(id, (err as Error).message);
          link.close();
        }
      }
    } finally {
      this.dialing.delete(id);
    }
    const entry = this.retry.get(id);
    if (entry && !this.links.has(id)) {
      // Back off, with jitter, so two devices that both just woke don't dial in lockstep.
      entry.delay = Math.min(BACKOFF_MAX, Math.max(BACKOFF_MIN, entry.delay * 2)) * (0.8 + Math.random() * 0.4);
      this.connect(id);
    }
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
    return { type: "hello", protocol: PROTOCOL, version: this.options.version, id: this.identity.id, name: this.identity.name, hosts: this.hosts(), port: this.options.port, revoked: this.saved.revoked };
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
      const keepNew = link.dialer === (this.identity.id < id);
      if (!keepNew) {
        link.close();
        return true;
      }
      this.links.delete(id);
      existing.close();
    }
    this.learn(peer, hello);
    this.links.set(id, link);
    // Revocations made while this device was away reach it from whichever peer it meets first.
    if (Array.isArray(hello.revoked)) for (const fingerprint of hello.revoked.slice(0, 500)) this.onControl(id, link, { type: "revoked", fingerprint });
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
      const current = this.peer(id);
      if (current) {
        current.lastSeen = Date.now();
        this.persist();
        this.connect(id);
      }
      this.changed();
    });
    link.ping();
    this.changed();
    return true;
  }

  private onControl(id: string, _link: Link, message: Control): void {
    const peer = this.peer(id);
    if (!peer) return;
    if (message.type === "update") {
      this.learn(peer, message);
      this.changed();
    } else if (message.type === "revoke") {
      this.forget(peer);
    } else if (message.type === "revoked") {
      const target = this.saved.peers.find((p) => p.fingerprint === message.fingerprint);
      if (typeof message.fingerprint === "string" && message.fingerprint !== this.identity.fingerprint) {
        if (target) this.forget(target, true);
        else if (!this.saved.revoked.includes(message.fingerprint)) {
          this.saved.revoked.push(message.fingerprint);
          this.persist();
        }
      }
    } else if (message.type === "introduce") {
      const intro = message.peer as Partial<Peer> | undefined;
      if (!intro || typeof intro.publicKey !== "string") return;
      const spki = Buffer.from(intro.publicKey, "base64");
      const fp = fingerprintOf(spki);
      if (fp === this.identity.fingerprint || this.saved.revoked.includes(fp) || this.saved.peers.some((p) => p.fingerprint === fp)) return;
      const added = this.store({ id: intro.id, name: intro.name, hosts: intro.hosts, port: intro.port }, spki);
      if (added) {
        this.options.log?.(`${peer.name} introduced ${added.name}`);
        this.connect(added.id, true);
        this.changed();
      }
    }
  }

  private learn(peer: Peer, message: Control): void {
    const name = cleanName(message.name);
    if (name) peer.name = name;
    const hosts = cleanHosts(message.hosts);
    if (hosts.length) peer.hosts = hosts;
    if (validPort(message.port)) peer.port = message.port;
    peer.lastSeen = Date.now();
    this.persist();
  }

  // --- the paired devices file ---

  /** `seenAt`: the address it was reached on (or came from), tried first; its own hints may include ones we can't route to. */
  private addPeer(message: Control, spki: Buffer, seenAt?: string): Peer | undefined {
    const hosts = cleanHosts(message.hosts);
    if (seenAt) hosts.unshift(seenAt.replace(/^::ffff:/, ""));
    const fp = fingerprintOf(spki);
    this.saved.revoked = this.saved.revoked.filter((r) => r !== fp);
    this.saved.peers = this.saved.peers.filter((p) => p.fingerprint !== fp);
    return this.store({ id: message.id, name: message.name, hosts, port: message.port }, spki);
  }

  private store(info: { id?: unknown; name?: unknown; hosts?: unknown; port?: unknown }, spki: Buffer): Peer | undefined {
    const id = typeof info.id === "string" && /^[0-9a-f]{12}$/.test(info.id) ? info.id : undefined;
    const name = cleanName(info.name);
    if (!id || !name || id === this.identity.id || !validPort(info.port)) return undefined;
    const old = this.links.get(id);
    this.saved.peers = this.saved.peers.filter((p) => p.id !== id);
    old?.close();
    const peer: Peer = { id, name, publicKey: spki.toString("base64"), fingerprint: fingerprintOf(spki), hosts: [...new Set(cleanHosts(info.hosts))], port: info.port, pairedAt: Date.now() };
    this.saved.peers.push(peer);
    this.persist();
    void this.bind();
    return peer;
  }

  /** Drop a device's key. `tell`: ask it to drop this device's key too, if it is online. */
  private forget(peer: Peer, tell = false): void {
    this.saved.peers = this.saved.peers.filter((p) => p.id !== peer.id);
    if (!this.saved.revoked.includes(peer.fingerprint)) this.saved.revoked.push(peer.fingerprint);
    this.persist();
    const entry = this.retry.get(peer.id);
    clearTimeout(entry?.timer);
    this.retry.delete(peer.id);
    this.errors.delete(peer.id);
    const link = this.links.get(peer.id);
    if (tell) link?.control({ type: "revoke" });
    this.links.delete(peer.id);
    if (link) setTimeout(() => link.close(), 100).unref();
    this.options.log?.(`Device ${peer.name} (${peer.id}) revoked`);
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
      return { peers: Array.isArray(saved.peers) ? saved.peers : [], revoked: Array.isArray(saved.revoked) ? saved.revoked : [] };
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
  return { id: peer.id, name: peer.name, publicKey: peer.publicKey, hosts: peer.hosts, port: peer.port };
}

function cleanHosts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((h): h is string => typeof h === "string" && net.isIP(h) !== 0).slice(0, 8) : [];
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}
