import { execFile } from "node:child_process";

/** Run a credential command without a shell or exposing its output in an error. */
export function authCommand(file: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, windowsHide: true, timeout: 30_000 }, (error) => {
      if (error) reject(new Error(`${label} failed${error.killed ? " (timed out)" : ""}. Try again or use the provider's CLI.`));
      else resolve();
    });
  });
}
