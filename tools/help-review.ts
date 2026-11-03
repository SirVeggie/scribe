/**
 * What the Help agent's guide (public/help/guide.md, #962) may be missing: the commits since the guide
 * last changed that touch the app's UI or behaviour, with their subjects and files. An agent reviews
 * them before a release (see the release skill) and updates the guide for anything a user would ask about.
 *
 *   npx tsx tools/help-review.ts            commits since the guide's last change
 *   npx tsx tools/help-review.ts <rev>      commits since <rev> instead
 */
import { execFileSync } from "node:child_process";

const GUIDE = "public/help/guide.md";
/** Where user-facing changes live; tests, docs and tooling are left out. */
const PATHS = ["public", "src", "templates", "desktop/src", "plugins"];

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const since = process.argv[2] || git("log", "-1", "--format=%H", "--", GUIDE);
if (!since) {
  console.error(`${GUIDE} has no commits yet; pass a revision to start from.`);
  process.exit(1);
}
const log = git("log", "--no-merges", "--reverse", "--format=%x1e%h %ad %s", "--date=short", "--name-only", `${since}..HEAD`, "--", ...PATHS);
const commits = log
  .split("\x1e")
  .map((block) => block.trim())
  .filter(Boolean)
  .map((block) => {
    const [head, ...files] = block.split("\n").filter(Boolean);
    return { head, files: files.filter((f) => !/\.test\.ts$|\/test\//.test(f)) };
  })
  .filter((c) => c.files.length);

console.log(`Guide last changed in ${git("log", "-1", "--format=%h %ad", "--date=short", since)}. ${commits.length} commit(s) since then touch the app:\n`);
for (const c of commits) console.log(`${c.head}\n    ${c.files.join(", ")}`);
console.log(`\nFor each change a user could ask Help about (a new or renamed setting, shortcut, menu, feature or behaviour), update ${GUIDE}: keep its structure, state where to find things, and drop what no longer exists.`);
