import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

/** The file page's editor (#658): templates/file-editor.js and CodeMirror, as one script for /vendor/editor.js. */
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "file-editor.js");

const options: esbuild.BuildOptions = {
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  legalComments: "none",
  write: false,
  logLevel: "silent",
};

let built: string | null = null;
let pending: Promise<void> | null = null;

/** Build in the background, so the first file page doesn't wait on it. */
export function prebuildEditorBundle(): Promise<void> {
  pending ??= esbuild.build(options).then(
    (result) => { built ??= result.outputFiles![0].text; },
    (err) => { console.error("[scribe] editor bundle failed:", (err as Error).message); },
  );
  return pending;
}

/** The bundle, built now if the background build hasn't finished. */
export function editorBundle(): string {
  built ??= esbuild.buildSync(options).outputFiles![0].text;
  return built;
}
