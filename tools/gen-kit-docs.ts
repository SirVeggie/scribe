import fs from "node:fs";
import path from "node:path";
import { readKitCatalog, updateKitDocs } from "../src/kitCatalog.js";
import { SKILL_DIR } from "../src/skillDocs.js";

const file = path.join(SKILL_DIR, "SKILL.md");
const before = fs.readFileSync(file, "utf8");
const after = updateKitDocs(before, readKitCatalog());
if (process.argv.includes("--check")) {
  if (before.replace(/\r\n/g, "\n") !== after) {
    console.error("Page kit docs are stale. Run npm run gen:kit-docs.");
    process.exitCode = 1;
  }
} else if (before !== after) {
  fs.writeFileSync(file, after);
}
