# Isolated SvelteKit build fixture (#331)

This fixture has its own `node_modules`. It does not use Scribe's root dependency junction.
Run these commands from this directory:

```powershell
npm ci --no-audit --no-fund
npm run build
```

On Windows, Vite may need the shell's normal subprocess permissions. The first
sandboxed run hit `spawn EPERM`; the approved unsandboxed build succeeded.
Do not interpret that permission failure as the cross-drive filename failure.

Observed 10 October 2026 on Windows / Node v25.2.1:

- Vite 8.1.3, SvelteKit 2.55.0, vite-plugin-svelte 7.0.0, Svelte 5.57.2;
  locked Rolldown 1.1.5.
- `npm ci`: 48 packages, exit 0. `node_modules` is a real local directory.
- SvelteKit runtime resolves under this C: fixture's `node_modules`.
- Build: exit 0, 140 SSR modules and 154 client modules.
- Output includes `entries/fallbacks/error.svelte.js` and `layout.svelte.js`.
- No adapter specified: validates SSR/client compilation only, not deployment.
- Lock SHA-256: `c6f33bf4b7b2300ac01e282a95fa602def1a98b1282364c350606ebfafa79732`.

This is a minimal local-dependency control, not LLM Chat's commit or lockfile.
It neither reproduces the cross-drive build end to end nor proves LLM Chat will pass.
The earlier path probe supplies the modeled cross-drive comparison.
