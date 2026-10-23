import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export type PageProblem = { code: string; message: string; line?: number };
export const MAX_PAGE_PROBLEMS = 8;
export const PAGE_PROBLEM_JS = readFileSync(new URL("../public/page-problems.js", import.meta.url), "utf8");
export const KIT_TONES: string[] = JSON.parse(readFileSync(new URL("../public/kit.catalog.json", import.meta.url), "utf8"))
  .entries.find((entry: { id: string }) => entry.id === "tones").classes;

type Session = {
  token: string;
  revision: number;
  started: boolean;
  served: boolean;
  exists: (key: string) => boolean | undefined;
  servedNow: () => void;
  finish: (problems: PageProblem[]) => void;
};

/** Ephemeral, revision-scoped first-render reports. Never persisted as page events or state. */
export class PageProblems {
  private sessions = new Map<string, Session>();

  boot(id: string, revision: number): { token: string } | undefined {
    const session = this.sessions.get(id);
    if (session?.revision !== revision) return undefined;
    session.started = true;
    if (!session.served) { session.served = true; session.servedNow(); }
    return { token: session.token };
  }

  report(id: string, input: any): void {
    const session = this.sessions.get(id);
    if (!session || input?.token !== session.token) return;
    session.started = true;
    if (input.phase !== "done") return;
    const problems = cleanProblems(input.problems);
    const links = Array.isArray(input.links) ? input.links.slice(0, 32) : [];
    for (const key of links) {
      if (typeof key === "string" && key.length <= 300 && /^scribe:[^\s]+$/.test(key) && session.exists(key) === false) {
        problems.push({ code: "missing_page", message: `Page link does not exist: ${key}` });
      }
    }
    session.finish(cleanProblems(problems));
  }

  collect(id: string, revision: number, fallback: (signal: AbortSignal) => Promise<void>, options: {
    timeoutMs?: number; exists?: (key: string) => boolean | undefined;
  } = {}): Promise<PageProblem[]> {
    // A newer write supersedes an in-flight report; the old caller gets no stale errors.
    this.sessions.get(id)?.finish([]);
    return new Promise(resolve => {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? 1800;
      const began = Date.now();
      const session: Session = {
        token: randomBytes(16).toString("hex"), revision, started: false, served: false,
        exists: options.exists ?? (() => undefined),
        servedNow: () => {
          clearTimeout(deadline);
          // Allow the first second after a cold launch, with a hard bound even for a hung page.
          deadline = setTimeout(() => session.finish([]), Math.min(3000 - (Date.now() - began), Math.max(timeoutMs - (Date.now() - began), 1500)));
        },
        finish: problems => {
          if (this.sessions.get(id) !== session) return;
          this.sessions.delete(id);
          clearTimeout(deadline);
          clearTimeout(background);
          controller.abort();
          resolve(problems);
        },
      };
      this.sessions.set(id, session);
      let deadline = setTimeout(() => session.finish([]), timeoutMs);
      // Give existing views time to request the new revision before rendering a temporary view.
      const background = setTimeout(() => {
        if (!session.started) void fallback(controller.signal).catch(() => {});
      }, 200);
    });
  }
}

export function cleanProblems(input: unknown): PageProblem[] {
  if (!Array.isArray(input)) return [];
  const result: PageProblem[] = [];
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const priority = ["uncaught_error", "unhandled_rejection", "reply_field_name", "unknown_tone", "missing_page", "bridge_error", "asset_load"];
  const ordered = input.slice(0, 64).sort((a, b) => {
    const rank = (item: any) => { const index = priority.indexOf(item?.code); return index < 0 ? priority.length : index; };
    return rank(a) - rank(b);
  });
  for (const item of ordered) {
    if (!item || typeof item.code !== "string" || typeof item.message !== "string") continue;
    const problem: PageProblem = { code: item.code.slice(0, 50), message: item.message.slice(0, 300) };
    if (Number.isSafeInteger(item.line) && item.line > 0) problem.line = item.line;
    const key = JSON.stringify(problem);
    if (!seen.has(key) && (counts.get(problem.code) ?? 0) < 3) {
      seen.add(key); result.push(problem); counts.set(problem.code, (counts.get(problem.code) ?? 0) + 1);
    }
    if (result.length === MAX_PAGE_PROBLEMS) break;
  }
  return result;
}
