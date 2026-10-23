import fs from "node:fs";

/** The shared markdown renderer's scripts (#770), for tests that serve a page with their own routes. */
const FILES: Record<string, URL> = {
  "/vendor/marked.js": new URL("../node_modules/marked/lib/marked.umd.js", import.meta.url),
  "/vendor/purify.js": new URL("../node_modules/dompurify/dist/purify.min.js", import.meta.url),
  "/vendor/scribe-md.js": new URL("../templates/scribe-md.js", import.meta.url),
};

/** The script a /vendor URL serves, or null for any other URL. */
export function markdownVendor(url: string): string | null {
  const file = FILES[new URL(url).pathname];
  return file ? fs.readFileSync(file, "utf8") : null;
}
