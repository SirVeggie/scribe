import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pdfFixture } from "./pdfFixture.test.js";
import { readPdfText } from "./pdfText.js";

test("embedded PDF extraction preserves page numbers, bounds output and rereads disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pdf-text-"));
  const file = path.join(root, "test.pdf");
  try {
    fs.writeFileSync(file, pdfFixture(["First page (hello)", "Second needle", ""]));
    const first = await readPdfText(file);
    assert.match(first.text, /\[PDF page 1\]\nFirst page \(hello\)/);
    assert.equal(first.pdf.totalPages, 3);
    assert.equal(first.pdf.nextPage, 2);
    assert.doesNotMatch(first.text, /Second/);
    const rest = await readPdfText(file, 2, 5);
    assert.match(rest.text, /\[PDF page 2\]\nSecond needle/);
    assert.deepEqual(rest.pdf.emptyPages, [3]);
    assert.deepEqual(rest.pdf.pageLines, [{ page: 2, startLine: 1, endLine: 2 }, { page: 3, startLine: 4, endLine: 5 }]);
    assert.match(rest.text, /No embedded text/);
    assert.equal(rest.pdf.nextPage, undefined);
    await assert.rejects(readPdfText(file, 4), /past the end/);
    await assert.rejects(readPdfText(file, 0), /positive integer/);
    await assert.rejects(readPdfText(file, 1, 6), /between 1 and 5/);
    fs.writeFileSync(file, pdfFixture(["x".repeat(30_000)]));
    const dense = await readPdfText(file);
    assert.deepEqual(dense.pdf.truncatedPages, [1]);
    assert.ok(dense.text.length < 20_200);
    fs.writeFileSync(file, "invalid PDF");
    await assert.rejects(readPdfText(file), /Cannot extract embedded PDF text/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
