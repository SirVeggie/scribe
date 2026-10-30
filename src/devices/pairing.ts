import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";

/**
 * Pairing codes (#904). Add device on device A makes a one-time offer: a code (and the same text as a
 * QR code) carrying A's address hints, its peer port, a secret and the start of A's key fingerprint.
 * Device B dials a hint and checks A's TLS key against that fingerprint before it says anything, so
 * nobody else can answer as A. Over that channel each side proves it knows the secret with an HMAC
 * bound to both keys; A counts wrong guesses and drops the offer after a few. Then they swap names and
 * addresses, and both show the same four words, from a hash of both keys, to compare.
 */

export const CODE_VERSION = 1;
export const OFFER_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
const SECRET_BYTES = 10;
const FINGERPRINT_BYTES = 12;
/** Address hint types: 4 and 6 are IPs; NAME is a host name (a device that accepts connections from the internet). */
const NAME = 100;
const ALPHABET ="0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type Offer = { code: string; secret: Buffer; fingerprint: string; expiresAt: number; attempts: number };
export type DecodedCode = { secret: Buffer; fingerprintPrefix: string; port: number; hosts: string[] };

export function makeOffer(fingerprint: string, port: number, hosts: string[]): Offer {
  const secret = randomBytes(SECRET_BYTES);
  const parts: Buffer[] = [Buffer.from([CODE_VERSION]), secret, Buffer.from(fingerprint.slice(0, FINGERPRINT_BYTES * 2), "hex")];
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  parts.push(portBytes);
  for (const host of hosts.slice(0, 4)) {
    if (net.isIPv4(host)) parts.push(Buffer.from([4, ...host.split(".").map(Number)]));
    else if (net.isIPv6(host)) parts.push(Buffer.from([6]), ipv6Bytes(host));
    else if (host.length < 256) parts.push(Buffer.from([NAME, host.length]), Buffer.from(host, "ascii")); // a public device's name (#910)
  }
  return { code: group(base32(Buffer.concat(parts))), secret, fingerprint, expiresAt: Date.now() + OFFER_MS, attempts: 0 };
}

export function decodeCode(code: string): DecodedCode {
  const bytes = unbase32(code);
  const fixed = 1 + SECRET_BYTES + FINGERPRINT_BYTES + 2;
  if (bytes.length < fixed || bytes[0] !== CODE_VERSION) throw new Error("That is not a Scribe pairing code.");
  const secret = bytes.subarray(1, 1 + SECRET_BYTES);
  const fingerprintPrefix = bytes.subarray(1 + SECRET_BYTES, 1 + SECRET_BYTES + FINGERPRINT_BYTES).toString("hex");
  const port = bytes.readUInt16BE(fixed - 2);
  const hosts: string[] = [];
  for (let i = fixed; i < bytes.length; ) {
    if (bytes[i] === 4 && i + 5 <= bytes.length) {
      hosts.push([...bytes.subarray(i + 1, i + 5)].join("."));
      i += 5;
    } else if (bytes[i] === 6 && i + 17 <= bytes.length) {
      const b = bytes.subarray(i + 1, i + 17);
      hosts.push(Array.from({ length: 8 }, (_, k) => b.readUInt16BE(k * 2).toString(16)).join(":"));
      i += 17;
    } else if (bytes[i] === NAME && i + 2 <= bytes.length && i + 2 + bytes[i + 1] <= bytes.length) {
      const name = bytes.subarray(i + 2, i + 2 + bytes[i + 1]).toString("ascii");
      if (/^[a-z0-9.-]+$/i.test(name)) hosts.push(name);
      i += 2 + bytes[i + 1];
    } else break;
  }
  if (!hosts.length) throw new Error("That pairing code names no address.");
  return { secret: Buffer.from(secret), fingerprintPrefix, port, hosts };
}

/** What each side sends to prove the secret, bound to both keys and to its role. */
export function pairProof(secret: Buffer, role: "dialer" | "listener", listenerFingerprint: string, dialerFingerprint: string): string {
  return createHmac("sha256", secret).update(`scribe-pair-1|${role}|${listenerFingerprint}|${dialerFingerprint}`).digest("hex");
}

export function sameProof(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Four words both devices show after pairing; the same on both sides, since the keys are sorted. */
export function pairWords(a: string, b: string): string[] {
  const [first, second] = [a, b].sort();
  const hash = createHash("sha256").update(`scribe-words|${first}|${second}`).digest();
  return [...hash.subarray(0, 4)].map((byte) => WORDS[byte]);
}

function group(text: string): string {
  return text.match(/.{1,5}/g)!.join("-");
}

function base32(bytes: Buffer): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(code: string): Buffer {
  // Crockford: case and dashes don't matter, and O / I / L read as 0 / 1 / 1.
  const text = code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error("That is not a Scribe pairing code.");
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function ipv6Bytes(host: string): Buffer {
  const [head, tail] = host.split("%")[0].split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const out = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return out;
}

const WORDS = (
  "acorn actor adobe agent alarm album alpine amber angle apple apron arch arrow aspen atlas attic " +
  "badge bagel baker bamboo banjo barn basil beach beacon beard berry bicycle bison blade blanket blossom " +
  "bonfire border bottle bramble bread breeze brick bridge bronze brook bucket buffalo bugle butter cabin cactus " +
  "camel candle canoe canyon carrot castle cedar cello chalk cherry chess chimney cider cinema circus citrus " +
  "clover cobalt cocoa comet copper coral cotton cradle crane crayon cricket crown crystal cypress dahlia daisy " +
  "delta denim desert diamond dolphin donkey dragon drum dune eagle easel echo eclipse elbow ember engine " +
  "falcon feather fern ferry fiddle fig flame flannel flute forest fossil fountain fox galaxy garden garlic " +
  "gecko geyser ginger glacier globe goblet granite grape gravel guitar hammock harbor harp hazel hedge helmet " +
  "heron honey horizon hornet iceberg igloo indigo island ivory jacket jade jaguar jasmine jelly jigsaw juniper " +
  "kayak kernel kettle kiwi koala ladder lagoon lantern laurel lemon lentil lilac lime linen lizard lobster " +
  "locket lotus lumber magnet mango maple marble meadow melon meteor mint mirror mitten mocha monsoon mosaic " +
  "moss muffin nectar needle nickel noodle nutmeg oasis ocean olive onion opal orbit orchid otter owl " +
  "paddle palace panda paper parrot pebble pepper piano pickle pigeon pillow pine planet plum pocket pony " +
  "poppy prairie prism pumpkin puzzle quartz quill rabbit radish raven reef ribbon river robin rocket saddle " +
  "saffron salmon sandal satin scarf shell sierra silver sketch sparrow spider spruce squash star stone summit " +
  "sunset swan tango teapot thistle thunder tiger timber toast tulip tundra turnip velvet violet walnut willow"
).split(" ");

if (WORDS.length !== 256) throw new Error(`pairing words: ${WORDS.length}, not 256`);
