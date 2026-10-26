import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const template = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "browser-page.html");
let cache: { mtime: number; html: string } | undefined;
export function browserViewHtml(): string {
  const mtime = fs.statSync(template).mtimeMs;
  if (!cache || cache.mtime !== mtime) cache = { mtime, html: fs.readFileSync(template, "utf8") };
  return cache.html;
}
