import { TOKEN, VaultTokenError, tokenFor, vault } from "../vault.js";

/**
 * Secret references (#1049): an agent uses a protected value without reading it. A ⟦p:…⟧ token in a
 * tool call's input becomes the value only where the call runs, and the call's output comes back with
 * the value as its token again. In a shell command, the value goes into an environment variable that
 * only that command's process gets: the token becomes $SCRIBE_SECRET_<id>, and the agent may also
 * write that variable itself.
 *
 * This keeps values out of the model's context by accident, not against an agent set on getting them:
 * a command can still print a value another way (base64, split up), which the scrub can't recognise.
 */
export const SECRET_ENV_PREFIX = "SCRIBE_SECRET_";
const ENV_REF = /SCRIBE_SECRET_([0-9a-f]{10})(?![0-9A-Za-z_])/g;

export type ShellKind = "posix" | "powershell";

/** The shell a provider's tool runs its command in, or null when it is not a shell tool. */
export function shellOf(tool: string): ShellKind | null {
  if (tool === "Bash" || tool === "bash") return "posix";
  if (tool === "PowerShell" || tool === "powershell") return "powershell";
  return null;
}

/**
 * A command whose tokens read environment variables instead, and those variables' values, for a runner
 * that sets them on the command's process alone (Scribe's own shell). Null when the command names no
 * protected value. Throws VaultTokenError for an unknown or edited reference.
 */
export function secretEnv(command: string, shell: ShellKind): { command: string; env: Record<string, string> } | null {
  if (!command.includes("⟦p:") && !command.includes(SECRET_ENV_PREFIX)) return null;
  const store = vault();
  const ids = new Set<string>();
  const body = command.replace(TOKEN, (token: string, id: string) => {
    const meta = store.meta(id);
    if (!meta) throw new VaultTokenError(`${token} is not a protected value this Scribe knows. Copy tokens exactly as you read them.`);
    if (token !== tokenFor(meta)) throw new VaultTokenError(`${token} was changed: write it as ${tokenFor(meta)}.`);
    ids.add(id);
    return shell === "powershell" ? `$env:${SECRET_ENV_PREFIX}${id}` : `\${${SECRET_ENV_PREFIX}${id}}`;
  });
  if (body.includes("⟦p:")) throw new VaultTokenError("A protected-value token (⟦p:…⟧) is cut short. Copy each token whole, from ⟦ to ⟧.");
  for (const ref of body.matchAll(ENV_REF)) {
    if (!store.meta(ref[1])) throw new VaultTokenError(`${SECRET_ENV_PREFIX}${ref[1]} names no protected value. Use the id from a ⟦p:<id> …⟧ token or vault_list.`);
    ids.add(ref[1]);
  }
  if (!ids.size) return null;
  return { command: body, env: Object.fromEntries([...ids].map((id) => [`${SECRET_ENV_PREFIX}${id}`, store.reveal(id) ?? ""])) };
}

/**
 * The same for a provider's own shell, where Scribe can change only the command line: it starts by
 * setting the variables. That shell runs each command in a process of its own, so they end with it.
 */
export function secretCommand(command: string, shell: ShellKind): string | null {
  const refs = secretEnv(command, shell);
  if (!refs) return null;
  const sets = Object.entries(refs.env).map(([name, value]) =>
    shell === "powershell" ? `$env:${name} = '${value.replace(/'/g, "''")}'` : `export ${name}='${value.replace(/'/g, `'\\''`)}'`
  );
  return `${sets.join("\n")}\n${refs.command}`;
}

/**
 * A tool call's input with its references swapped for what runs: a shell command through
 * secretCommand, any other tool's tokens as their values. Null when nothing changes.
 */
export function secretInput(tool: string, input: Record<string, unknown>): Record<string, unknown> | null {
  if (vault().size === 0 && !JSON.stringify(input).includes("⟦p:")) return null;
  const shell = shellOf(tool);
  if (shell) {
    const command = typeof input.command === "string" ? secretCommand(input.command, shell) : null;
    return command === null ? null : { ...input, command };
  }
  if (!JSON.stringify(input).includes("⟦p:")) return null;
  return vault().restoreDeep(input);
}

/** A tool's output with every protected value as its token, or null when it holds none. */
export function scrubOutput<T>(output: T): T | null {
  if (vault().size === 0 || output === undefined || output === null) return null;
  const before = JSON.stringify(output);
  const after = vault().redactDeep(output);
  return JSON.stringify(after) === before ? null : after;
}
