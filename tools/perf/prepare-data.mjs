// Copies a Scribe data folder into a scratch one for profiling, and makes the copy safe to run a
// second daemon on: no worktrees, no interrupted turns to resume, no page runs to merge, no board
// workers left running. The source is only read (VACUUM INTO works while the live daemon runs).
//
//   node tools/perf/prepare-data.mjs <scratch dir> [source dir]
//
// Start the scratch daemon with SCRIBE_HOME=<scratch dir>, its own SCRIBE_PORT, and
// SCRIBE_FAKE_AGENTS=1 so no chat on it can reach a model, a tool or the live board's MCP.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Off Windows pass the source: the default data folder there depends on the platform (see dataDir in src/config.ts).
const [dest, source = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "scribe") : ""] = process.argv.slice(2);
if (!dest || !source) {
  console.error("usage: node tools/perf/prepare-data.mjs <scratch dir> [source dir]");
  process.exit(1);
}
if (path.resolve(dest) === path.resolve(source)) {
  console.error("The scratch folder must not be the source folder.");
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });

function copyDb(name) {
  const to = path.join(dest, name);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(to + suffix, { force: true });
  const src = new DatabaseSync(path.join(source, name), { readOnly: true });
  src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  src.close();
  return new DatabaseSync(to);
}

const agent = copyDb("agent.sqlite");
let threads = 0;
let worktrees = 0;
const saveThread = agent.prepare("UPDATE threads SET data = ? WHERE id = ?");
for (const row of agent.prepare("SELECT id, data FROM threads").all()) {
  const thread = JSON.parse(row.data);
  threads += 1;
  if (thread.worktree || thread.useWorktree) {
    worktrees += 1;
    delete thread.worktree;
    thread.useWorktree = false;
    saveThread.run(JSON.stringify(thread), row.id);
  }
}
let turns = 0;
const saveTurn = agent.prepare("UPDATE turns SET data = ? WHERE id = ?");
for (const row of agent.prepare("SELECT id, data FROM turns WHERE data LIKE '%\"running\"%' OR data LIKE '%\"interrupted\"%'").all()) {
  const turn = JSON.parse(row.data);
  if (turn.status !== "running" && !turn.interrupted) continue;
  if (turn.status === "running") turn.status = "cancelled";
  delete turn.interrupted;
  turn.endedAt = turn.endedAt ?? Date.now();
  saveTurn.run(JSON.stringify(turn), row.id);
  turns += 1;
}
agent.exec("DELETE FROM settings WHERE k IN ('pageRuns', 'unusedPages')");
const items = agent.prepare("SELECT COUNT(*) AS n FROM items").get().n;
agent.close();

const pages = copyDb("scribe.sqlite");
let workers = 0;
const saveState = pages.prepare("UPDATE tabs SET state = ? WHERE id = ?");
for (const row of pages.prepare("SELECT id, state FROM tabs WHERE state LIKE '%\"workers\"%'").all()) {
  const state = JSON.parse(row.state);
  const set = state?.settings?.workers;
  if (!set || typeof set !== "object") continue;
  for (const worker of Object.values(set)) {
    for (const key of ["run", "step", "stop", "merge", "solo", "threadId"]) {
      if (key in worker) {
        delete worker[key];
        workers += 1;
      }
    }
  }
  for (const card of state.cards ?? []) {
    delete card.claim;
  }
  saveState.run(JSON.stringify(state), row.id);
}
const tabCount = pages.prepare("SELECT COUNT(*) AS n FROM tabs").get().n;
pages.close();

console.log(JSON.stringify({ dest, threads, items, worktreesDropped: worktrees, turnsClosed: turns, workerFieldsCleared: workers, pages: tabCount }));
