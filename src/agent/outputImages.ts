import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MAX_FILE_BYTES, threadFilesDir } from "./attachments.js";
import { isPlainRecord, type FileRef } from "./types.js";

/** Provider payload only; never stored in the transcript or sent to the browser. */
export type OutputImage = { data: string; mimeType?: string } | { path: string };

/** MCP/Pi, Anthropic source blocks, Codex dynamic tools and Cursor's wrapped MCP blocks. */
export function outputImages(content: unknown): OutputImage[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isPlainRecord).flatMap((block): OutputImage[] => {
    if (block.type === "inputImage" && typeof block.imageUrl === "string") return [{ data: block.imageUrl }];
    if (isPlainRecord(block.image)) block = { type: "image", ...block.image };
    if (block.type !== "image") return [];
    const source = isPlainRecord(block.source) ? block.source : block;
    return [{ data: typeof source.data === "string" ? source.data : "", mimeType: String(source.mimeType ?? source.media_type ?? "") }];
  });
}

const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Content-addressed per thread: repeated provider completion events reuse the same asset. */
export function saveOutputImage(threadId: string, image: OutputImage): FileRef {
  let bytes: Buffer;
  let mime: string;
  if ("path" in image) {
    const stat = fs.statSync(image.path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Image file is missing or exceeds 20 MB.");
    bytes = fs.readFileSync(image.path);
    mime = "";
  } else {
    let data = image.data;
    mime = image.mimeType ?? "";
    const url = /^data:([^;,]+);base64,([\s\S]*)$/.exec(data);
    if (url) { mime = url[1]; data = url[2]; }
    if (data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error("Image exceeds 20 MB.");
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("Unsupported image payload (expected base64 image data).");
    bytes = Buffer.from(data, "base64");
  }
  // Use the bytes to choose the file extension and serving type, never a provider's filename.
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
    : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP" ? "image/webp" : "";
  if (!detected || (mime && mime !== detected) || !bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("Unsupported or invalid image data.");
  mime = detected;
  const id = `out-${createHash("sha256").update(bytes).digest("hex")}`;
  const name = `image.${extensions[mime]}`;
  const dir = path.join(threadFilesDir(threadId), id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, bytes);
  return { id, name, mimeType: mime, size: bytes.length };
}
