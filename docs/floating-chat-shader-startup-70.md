# Floating chat shader warm-up investigation (#70)

Investigated 2026-10-28 at `5b47919`. Investigation only; no application changes.

## Finding

The strongest source-backed explanation is increased shader compilation/linking work.
The floating chat compiles one large fragment shader containing all shape, provider-symbol,
and chat-surface choices, separately for its orb and surface. Opening appearance settings
creates another pair of contexts/programs. Recent additions enlarged that shader substantially.
Actual cold-start duration and the responsible GPU/compiler stage remain unmeasured.

## Evidence

- `public/orb.js:69-252`: one `FRAG` includes every effect. The style, symbol, surface,
  provider and surface-mode selectors are uniforms, not compile-time constants.
  A compiler must preserve the selectable paths; choosing a simple effect does not
  remove other effects from the submitted shader source.
- Comparing the extracted `FRAG` at `1ef9988` (before the recent effect additions) with
  `5b47919`: 9,134 to 13,708 characters, approximately **50% growth**. This measures source
  length, not compiler complexity or elapsed time; it is not a measured 50% slowdown.
- `public/orb.js:193-220`: surface effects now include a 56-iteration rising-motes loop
  plus 14-iteration drifting-motes and embers loops. Fixed loops and additional branching
  can increase compiler work, especially if a backend unrolls loops. Unrolling was not
  observed directly here.
- Relevant additions: `e334517` (rising motes), `fa4e4b1` (56 rising motes), `0f718f5`
  (embers), `64f885c` (additional symbol displays). These are candidates, not a measured
  regression bisect. Other changes also occurred between the compared revisions.
- `public/orb.js:253-272`: each instance creates two canvases and submits the same `FRAG`
  through `scribeGL.lazy` twice. `u_surface` selects orb versus chat-surface rendering at
  runtime (`:296-299`), so both programs include both paths. Source identity may let the
  browser/driver reuse cached work, but the application provides no program reuse across
  these contexts. WebGL programs themselves cannot be shared between contexts.
- `public/orb.js:523-527`: closing settings destroys the preview; each opening calls
  `create` again. Editing choices in an open dialog uses `setConfig` (`:493-507`) and does
  not itself recreate the programs.
- `public/glfx.js:112-165`: lazy setup waits for a visible canvas, shell restoration, then
  two animation frames before creating a program. `public/app.js:684-691` clears the
  restoration gate after the first snapshot renders. This can add startup latency but
  does not explain a settings preview opened after restoration.
- `public/glfx.js:24-109`: with `KHR_parallel_shader_compile`, readiness is polled every
  16 ms; this avoids a synchronous status wait but does not reduce compiler work. Without
  that extension, compile/link status checks can block. Neither path has an intentional
  multi-second timer. The two-frame deferral is normally tens of milliseconds, although
  busy or throttled frames can take longer.
- `public/orb.js:263-264`: the gradient fallback remains until the orb's readiness callback
  adds `gl`. This makes a longer compile appear as a delayed effect rather than necessarily
  freezing the shell. Animation clocks begin at 12 (`:284`), so the shader does not need
  several seconds of animation to develop its initial appearance.

## Recommended follow-up, if implementation is requested

1. **Measure the actual desktop first:** mark first snapshot/restored, first draw request,
   program creation, compile completion, and first presented shader frame for orb, surface,
   and preview. Record GPU/WebView version and extension support. Compare cold app launch,
   first preview, and preview reopen; compare before/after in fresh processes with equivalent
   cache conditions. Include first-draw cost because some driver work can be deferred.
2. **Split orb and surface shader paths at compile time.** Start with separate entry points
   or a preprocessor define for `u_surface`, so unused code can be eliminated. Then consider
   compiling only the selected shape/symbol/surface modes. Test startup gains before adding
   a large variant cache. Keep colors, size, clocks and working intensity as uniforms.
3. **Skip programs with no visible output:** surface None, or an orb with both shape and
   symbol None. Currently the programs are still requested when their canvases are visible.
4. **If preview reopening is still slow, consider bounded context retention/reuse.** Programs
   cannot move between contexts; a JavaScript map keyed by shader text alone will not solve
   it. Reusing a hidden preview has GPU-memory and lifecycle costs and needs visibility
   controls. A shared-renderer design is a larger alternative, not the first step.

Keep the restoration gate and asynchronous compilation while investigating: removing them
could trade a visible fallback for slower or blocked shell startup. Reducing canvas resolution
helps per-frame rendering cost but does not remove the shader source/compiler cost. Aggressive
prewarming merely moves work earlier and may compete with startup; measure before adopting it.

## Verification and limits

Read the current orb, shared WebGL lifecycle, preview lifecycle, shell-restoration code and
relevant git history. Extracted both shader strings to compare their lengths. A Node-based
browser benchmark could not start its child `git` process in the sandbox (`EPERM`); a separate
Playwright probe waited for tool approval and was stopped without timing results. No desktop
restart, GPU trace, cold shader-cache comparison, visual reproduction, or performance benchmark
completed. Thus compilation is a strong hypothesis, not a confirmed root cause or quantified fix.

The report is also published as a background Scribe page linked from #70. The card returns to
To do per the worker's investigation-only workflow.
