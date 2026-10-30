import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rememberName } from "./references.js";

/**
 * This device's identity (#904): an id, a name, and an Ed25519 key pair made on first start. The
 * private key stays in the data folder, which agents may not read (#891's deny list). The peer link
 * uses a self-signed certificate for that key; what the other side pins is the key, not the certificate.
 */
export type Identity = {
  id: string;
  name: string;
  /** Names it had before a rename, newest first: links written with them still find it (#908). */
  formerNames?: string[];
  /** SubjectPublicKeyInfo DER of the public key. */
  publicKey: Buffer;
  fingerprint: string;
  keyPem: string;
  certPem: string;
};

type Saved = { id: string; name: string; createdAt: number; formerNames?: string[] };

export function deviceDir(home: string): string {
  return path.join(home, "device");
}

/** Load this device's identity from the data folder, making it on first start. */
export function loadIdentity(home: string): Identity {
  const dir = deviceDir(home);
  const infoFile = path.join(dir, "identity.json");
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  let saved: Saved | undefined;
  let keyPem: string | undefined;
  try {
    saved = JSON.parse(fs.readFileSync(infoFile, "utf8")) as Saved;
    keyPem = fs.readFileSync(keyFile, "utf8");
  } catch {
    /* first start */
  }
  if (!saved?.id || !keyPem) {
    fs.mkdirSync(dir, { recursive: true });
    const { privateKey } = generateKeyPairSync("ed25519");
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    saved = { id: randomBytes(6).toString("hex"), name: defaultName(), createdAt: Date.now() };
    fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
    fs.writeFileSync(infoFile, JSON.stringify(saved, null, 2));
    try {
      fs.rmSync(certFile, { force: true });
    } catch {
      /* made below */
    }
  }
  const publicKey = createPublicKey(keyPem).export({ type: "spki", format: "der" });
  let certPem: string;
  try {
    certPem = fs.readFileSync(certFile, "utf8");
  } catch {
    certPem = selfSignedCert(keyPem, saved.id);
    fs.writeFileSync(certFile, certPem);
  }
  return { id: saved.id, name: saved.name, ...(saved.formerNames?.length ? { formerNames: saved.formerNames } : {}), publicKey, fingerprint: fingerprintOf(publicKey), keyPem, certPem };
}

/** Save a new name; returns the former names, the old one first. */
export function saveName(home: string, name: string): string[] | undefined {
  const file = path.join(deviceDir(home), "identity.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Saved;
  const formerNames = rememberName(saved.formerNames, saved.name, name);
  fs.writeFileSync(file, JSON.stringify({ ...saved, name, ...(formerNames ? { formerNames } : {}) }, null, 2));
  return formerNames;
}

export function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 60);
  return name || undefined;
}

function defaultName(): string {
  return cleanName(os.hostname()) ?? "This device";
}

/** SHA-256 of the public key's SPKI DER, as hex. */
export function fingerprintOf(spki: Buffer): string {
  return createHash("sha256").update(spki).digest("hex");
}

/** The fingerprint people read: the first 16 bytes in groups of four hex digits. */
export function displayFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 32).match(/.{4}/g)!.join(" ");
}

export function publicKeyOf(spki: Buffer): KeyObject {
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

// --- A minimal DER writer for one self-signed Ed25519 certificate ---

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const ED25519 = seq(Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]));

function name(cn: string): Buffer {
  return seq(der(0x31, seq(Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), der(0x0c, Buffer.from(cn, "utf8")))));
}

function selfSignedCert(keyPem: string, id: string): string {
  const spki = createPublicKey(keyPem).export({ type: "spki", format: "der" });
  const serial = Buffer.concat([Buffer.from([0x01]), randomBytes(15)]);
  const subject = name(`scribe-${id}`);
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, serial),
    ED25519,
    subject,
    seq(der(0x17, Buffer.from("200101000000Z")), der(0x17, Buffer.from("491231235959Z"))),
    subject,
    spki,
  );
  const signature = sign(null, tbs, keyPem);
  const cert = seq(tbs, ED25519, der(0x03, Buffer.from([0]), signature));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}
