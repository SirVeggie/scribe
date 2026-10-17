import { readFileBytes, isPdfFile } from "./filePages.js";
import { fileURLToPath } from "node:url";

export type PdfText = {
  text: string;
  pdf: { totalPages: number; firstPage: number; lastPage: number; nextPage?: number; pageLines: { page: number; startLine: number; endLine: number }[]; emptyPages: number[]; truncatedPages: number[]; note: string };
};

/** Embedded text only. Ranges and per-page caps bound both extraction and tool output. */
export async function readPdfText(file: string, firstPage = 1, pageLimit = 1): Promise<PdfText> {
  if (!isPdfFile(file)) throw new Error("not a PDF file page");
  if (!Number.isInteger(firstPage) || firstPage < 1) throw new Error("pdfPage must be a positive integer");
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 5) throw new Error("pdfLimit must be between 1 and 5");
  const { bytes } = readFileBytes(file);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageUrl = import.meta.resolve("pdfjs-dist/package.json");
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0,
    cMapUrl: fileURLToPath(new URL("./cmaps/", packageUrl)).replaceAll("\\", "/"), cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL("./standard_fonts/", packageUrl)).replaceAll("\\", "/"),
  });
  const timer = setTimeout(() => { void task.destroy().catch(() => {}); }, 15_000);
  try {
    const doc = await task.promise;
    if (firstPage > doc.numPages) throw new Error(`pdfPage ${firstPage} is past the end (${doc.numPages} pages)`);
    const lastPage = Math.min(doc.numPages, firstPage + pageLimit - 1);
    const emptyPages: number[] = [], truncatedPages: number[] = [], sections: string[] = [];
    const pageLines: PdfText["pdf"]["pageLines"] = [];
    let nextLine = 1;
    for (let n = firstPage; n <= lastPage; n++) {
      const page = await doc.getPage(n);
      const reader = page.streamTextContent().getReader();
      let text = "", truncated = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (!("str" in item)) continue;
            const part = item.str.replace(/\r\n?/g, "\n") + (item.hasEOL ? "\n" : " ");
            if (text.length + part.length > 20_000) {
              text += part.slice(0, 20_000 - text.length);
              truncated = true;
              break;
            }
            text += part;
          }
          if (truncated) { await reader.cancel(new Error("PDF text character limit reached")); break; }
        }
      } finally { reader.releaseLock(); page.cleanup(); }
      text = text.trim();
      if (!text) emptyPages.push(n);
      if (truncated) truncatedPages.push(n);
      const section = `[PDF page ${n}]\n${text || "(No embedded text; this page may need OCR.)"}${truncated ? "\n(Text truncated at 20,000 characters; use a screenshot for the remainder.)" : ""}`;
      const endLine = nextLine + section.split("\n").length - 1;
      pageLines.push({ page: n, startLine: nextLine, endLine });
      nextLine = endLine + 2;
      sections.push(section);
    }
    return { text: sections.join("\n\n"), pdf: { totalPages: doc.numPages, firstPage, lastPage,
      ...(lastPage < doc.numPages ? { nextPage: lastPage + 1 } : {}), pageLines, emptyPages, truncatedPages,
      note: "Embedded PDF text only, in document order; no OCR. Line offsets and grep apply to this PDF page range. Use pdfPage/pdfLimit to read or search other pages." } };
  } catch (err) {
    throw new Error(`Cannot extract embedded PDF text: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}
