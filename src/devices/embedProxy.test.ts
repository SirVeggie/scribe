import assert from "node:assert/strict";
import { test } from "node:test";
import { embedLabel, embedTarget, isEmbedLabel, isPrivateHost } from "./embedProxy.js";

test("embed labels name a private target origin and read back (#917)", () => {
  for (const href of ["http://127.0.0.1:8188/x?y", "http://localhost:5173", "https://192.168.1.20/", "http://[::1]:3000/", "http://nas.lan:8080", "http://devbox:80"]) {
    const label = embedLabel(href)!;
    assert.ok(isEmbedLabel(label), href);
    assert.match(label, /^e[hs]-[a-z2-7]+$/);
    assert.ok(label.length <= 63);
    const url = new URL(href);
    assert.equal(embedTarget(label)?.origin, url.origin, href);
  }
  assert.equal(embedLabel("http://127.0.0.1:8188"), embedLabel("http://127.0.0.1:8188/other"));
  assert.notEqual(embedLabel("http://127.0.0.1:8188"), embedLabel("https://127.0.0.1:8188"));
});

test("public and odd targets get no label", () => {
  for (const href of ["https://example.com/", "http://8.8.8.8/", "ftp://127.0.0.1/", "javascript:alert(1)", `http://${"a".repeat(50)}.local/`]) {
    assert.equal(embedLabel(href), undefined, href);
  }
  assert.equal(embedTarget("t-ab12"), undefined);
  assert.equal(embedTarget("eh-"), undefined);
  // A label that decodes to a public host, or a path, is refused.
  const encode = (text: string) => {
    const B32 = "abcdefghijklmnopqrstuvwxyz234567";
    let bits = 0, value = 0, out = "";
    for (const byte of Buffer.from(text)) {
      value = ((value << 8) | byte) & 0xffff;
      bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    return bits ? out + B32[(value << (5 - bits)) & 31] : out;
  };
  assert.equal(embedTarget(`eh-${encode("example.com:80")}`), undefined);
  assert.equal(embedTarget(`eh-${encode("127.0.0.1:80/x")}`), undefined);
  assert.equal(embedTarget(`eh-${encode("u@127.0.0.1:80")}`), undefined);
  assert.equal(embedTarget(`eh-${encode("127.0.0.1:80")}`)?.origin, "http://127.0.0.1");
});

test("private hosts", () => {
  for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.5", "100.64.0.1", "100.127.1.1", "169.254.1.1", "[::1]", "fd12::1", "fe80::1", "localhost", "app.localhost", "nas.local", "x.lan", "box.home.arpa", "svc.internal", "devbox"]) {
    assert.ok(isPrivateHost(host), host);
  }
  for (const host of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1", "example.com", "localhost.example.com", ""]) {
    assert.ok(!isPrivateHost(host), host);
  }
});
