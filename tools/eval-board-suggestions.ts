/**
 * Replay a board snapshot without changing the board or live classifier usage counters.
 * npx tsx tools/eval-board-suggestions.ts --input snapshot.json --out results.json [--source id] [--data dir] [--dry]
 * Input: { labels: [{id,name,description?,neverSuggest?}], cards: [{num,title,description,labels,priority}] }.
 * Existing labels/priorities are held-out references, not complete ground truth. Bookkeeping
 * labels must be marked neverSuggest or removed before running. Results need human review.
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../src/config.js";
import { MlService } from "../src/ml/service.js";
import { fileStore, type MlStore } from "../src/ml/settings.js";
import type { MlDayUsage, MlQuestions } from "../src/ml/types.js";

type Label = { id: string; name: string; description?: string; neverSuggest?: boolean };
type Card = { num: number; title: string; description?: string; labels: string[]; priority: number };
type Snapshot = { labels: Label[]; cards: Card[] };
const arg = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1]; };

async function main() {
  const input = arg("input"), out = arg("out");
  if (!input || !out) throw new Error("--input and --out are required");
  const snapshot = JSON.parse(fs.readFileSync(input, "utf8")) as Snapshot;
  if (!Array.isArray(snapshot.labels) || !Array.isArray(snapshot.cards)) throw new Error("Expected labels and cards arrays");
  const labels = snapshot.labels.filter(l => !l.neverSuggest && l.name.trim()).slice(0, 30);
  // Same questions and truncation as templates/builtin/kanban.html. Hide existing assignments
  // on the evaluation copy so they can be compared with the returned answers.
  const questions: MlQuestions = Object.fromEntries(labels.map((l, i) => [`label${i}`, {
    type: "yesno", instructions: `Should this card have the label "${l.name.trim().slice(0, 100)}"?` +
      (l.description?.trim() ? ` The label means: ${l.description.trim().slice(0, 500)}` : ""),
  }]));
  questions.priority = { type: "choice", instructions: "How urgent is the work this card describes?", options: {
    unspecified: "The card does not say how urgent or important it is",
    low: "Nice to have; can wait a long time",
    medium: "Ordinary work to do in its turn",
    high: "Important; should be done soon",
    urgent: "Something is broken or blocked and needs attention now",
  } };
  const files = fileStore(() => arg("data") ?? dataDir());
  let usage: MlDayUsage | null = null;
  const store: MlStore = { read: files.read, write: () => {}, readUsage: () => usage, writeUsage: u => { usage = u; } };
  const settings = store.read();
  const source = settings.sources.find(s => s.id === (arg("source") ?? settings.defaultSource));
  if (!source) throw new Error("No configured classifier source");
  // Persist only public source metadata, never its key.
  const report = { at: new Date().toISOString(), input, source: { id: source.id, model: source.model, baseUrl: source.baseUrl },
    labels, thresholds: { label: 0.75, priority: 0.6, maxLabels: 3 }, questions,
    results: [] as Array<{ card: Card; result: Awaited<ReturnType<MlService["decide"]>> }> };
  console.log(`${snapshot.cards.length} cards; ${labels.length} labels; source ${source.id}`);
  if (process.argv.includes("--dry")) return;
  const service = new MlService({ store, log: () => {} });
  for (const card of snapshot.cards) {
    const result = await service.decide({ title: card.title, description: (card.description ?? "").slice(0, 8000) }, questions,
      { source: source.id, sends: ["toolResults"], feature: "pages", cache: false, timeoutMs: 20000 });
    report.results.push({ card, result });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
    console.log(`#${card.num}: ${result.ok ? `${result.model} ${result.ms}ms` : result.error}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "eval-board-suggestions.ts")) await main();
