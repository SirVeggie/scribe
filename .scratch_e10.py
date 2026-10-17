def edit(p, pairs):
    s=open(p,encoding='utf8',newline='').read()
    for a,b in pairs:
        assert a in s, (p,a[:70]); s=s.replace(a,b)
    open(p,'w',encoding='utf8',newline='').write(s)
edit('src/callers.ts',[('''

/** The local token as a tool reads it from the data folder, or undefined before the daemon made it. */
export function readLocalToken(): string | undefined {
  try {
    const text = fs.readFileSync(path.join(dataDir(), "local-token"), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}''','')])
edit('src/daemon.ts',[('''export function setAgentLabel(label: string): void {
  agentLabel = label.replace(/[^\x20-\x7e]/g, "").slice(0, 60);
}''','''export function setAgentLabel(label: string): void {
  agentLabel = label.replace(/[^\x20-\x7e]/g, "").slice(0, 60);
}

/** The data folder's local token (src/callers.ts), read each time: the daemon makes it when it starts. */
function localHeader(): Record<string, string> {
  try {
    const token = fs.readFileSync(path.join(dataDir(), "local-token"), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(token) ? { [LOCAL_TOKEN_HEADER]: token } : {};
  } catch {
    return {};
  }
}'''),
('import { spawn } from "node:child_process";\n','import { spawn } from "node:child_process";\nimport fs from "node:fs";\n'),
('THREAD_TOKEN_HEADER, VERSION, baseUrl } from "./config.js";','THREAD_TOKEN_HEADER, VERSION, baseUrl, dataDir } from "./config.js";')])
