# Page plugins

Use `plugin_list` to discover installed plugins. `plugin_guide(id)` gives a plugin's guide and agent method signatures. `plugin_call({id,method,args})` calls a declared agent method. Calls return `{ok:true,result}` or an error; handle errors without retry loops.

## Using a plugin from a page

Declare dependencies with `page_show({plugins:["git-history"], ...})` or `<meta name="scribe-plugins" content="git-history">`. Declarations do not grant access. Ordinary pages can use plugins just like plugin templates.

```js
const plugin = scribe.plugin("git-history");
const response = await plugin.call("repositories", {});
if (response.ok) renderRepositories(response.result.repositories);
else showError(response.error);
const unsubscribe = plugin.state.on("cache", (value, revision) => render(value));
const snapshot = await plugin.state.get("cache"); // {ok,value,revision}
plugin.on("updated", data => render(data));
```

Pages need `plugin.<id>` permission; Scribe asks on first use. A disabled or missing dependency leaves the page visible with a notice. Templates of a disabled plugin are hidden. A page from its own plugin's template starts allowed. An agent editing a risky plugin's page resets its permission to Ask. Do not grant page permissions from an agent.

Agent methods declare `agent: "read"`, `"board"` or `"ask"`. Read methods work on all rungs; Board methods require Board or higher. Ask methods request Allow / Allow for this thread / Deny unless on Full or inherited from the thread's page. A page's Deny refuses Ask calls; Auto asks. These approvals never change page grants.

## Authoring

Source is kept in Scribe, with Git history. Board agents use `plugin_create`, `plugin_read`, and `plugin_patch`; workspace filesystem access is unnecessary. Edits do not change installed code.

1. Create a manifest with `plugin_create({manifest})`.
2. Write files through `plugin_patch({id,path,content})`.
3. Run `plugin_reload({id})` to validate and bundle an optional source entry. Changed packages receive a patch-version bump.
4. Run `plugin_install({id,replace})`. Every rung below Full asks for activation, including Auto.
5. Check `plugin_logs`, exercise declared methods, and test page behavior.

```json
{
  "id":"example", "name":"Example", "version":"1.0.0",
  "summary":"One short line describing what this plugin does.",
  "backend":"backend.mjs", "guide":"guide.md", "risky":true,
  "access":{"files":[],"network":["api.example.org"],"env":[]},
  "settings":{"token":{"label":"API token","type":"secret"}},
  "methods":{"list":{"description":"List items: {}","agent":"read"}},
  "templates":[]
}
```

Optional `source: "src/backend.ts"` is bundled by esbuild into `backend` during reload. Node built-ins work; bundle other dependencies into the package. Runtime packages never install dependencies or execute install scripts. Paths must remain inside the package; links and reserved directories are refused.

The backend exports an object:

```js
export default {
  methods: {
    list: async (args, ctx) => {
      const token = await ctx.secret("token");
      const cache = await ctx.state.get("cache"); // {value,revision}
      await ctx.state.set("cache", {items: []});
      return cache.value;
    }
  },
  templates: {}
};
```

`ctx` includes public `settings`, `dataDir`, `db()` (a plugin-owned SQLite database), async `secret(name)`, keyed `state.get/set`, `emit(name,data)`, `saveAsset(name,mimeType,bytes)` into the caller's page, and `caller` (`kind`, optional page/thread), `signal` (aborts when the call times out or its caller cancels), `busy(work, label?)` and `task({title})`. Never log or return secrets. Scribe stores them separately using Windows DPAPI and excludes them from settings tools and exports. Installing a plugin runs code as the user; declared access informs consent and is not a sandbox.

## Long-running work

A call times out after 60 s (a method may declare `"timeoutMs"` up to 600000). The timeout rejects only that call and aborts `ctx.signal`; the backend keeps running unless its event loop is blocked. For a build or test run, start the work, wrap it in `ctx.busy(promise, "label")` and return an id at once: the backend then is not stopped for idleness until the work settles, so no detached process is needed while Scribe runs. Work inside the backend still ends when Scribe or the plugin restarts.

For work the user or an agent waits on, use a task instead of your own status method:

```js
run: async (args, ctx) => {
  const t = await ctx.task({ title: `Tests: ${args.name}` });
  (async () => {
    t.signal.addEventListener("abort", () => child.kill());   // the user pressed Stop
    await t.progress({ text: "42/120 tests", pct: 35 });      // also the heartbeat
    await t.log("FooTest#bar passed");                        // last 20 lines are kept
    await t.done({ passed: 120 });                            // or t.fail(error)
  })();
  return { task: t.id };
}
```

A task holds a lease until `done` or `fail`. Scribe records it (status, progress, last lines, result up to 32 KiB, the caller's thread or page): the plugin's Settings list it with Stop, the chat that started it shows a progress row, and agents read or wait on it with `plugin_task {id, task, wait}` (wait up to 600 s). Stop aborts `t.signal`; the task ends when you call `done` or `fail`. A task with no progress for 5 minutes shows as stale; one cut off by a backend stop or a Scribe restart shows as interrupted. Pages and components get a `task` event (`scribe.plugin.on("task", task)`) on each change; a component declares `"task"` in its `events`. `ctx.emit("task")` is reserved. Declare environment variables the backend needs (`"access":{"env":["JAVA_HOME"]}`); the user approves them at install.

## Templates and lifecycle

A template declaration has `key`, `metadata` (a normal template JSON file), `html`, optional `guide`, `actions: {name:{description,args}}`, and `hooks` listing the backend hooks it provides. Guides can contain `{{actions}}`.

Backend sets live at `templates[templateKey]`. `actions[name](state,args,ctx)` returns `{ops,result,events?}`. Hooks are `seed(state,values)`, `reply(state,reply,ctx)`, `replyDelivered(state,delivery,result,ctx)`, `sweep(state,ctx)`, `drive(state,ctx)`, `launched(state,launch,result,now)`, `launchAllowed(state,launch,now)`, `runHold(state,thread)`, and `runEvent(state,event,now)`. Seed returns an initial state object; launchAllowed returns a boolean; runHold returns a reason or null; other hooks return an action outcome or null. Drive may include `launch`; reply may include `deliver`.

The normal action context includes caller, now, values and an async `thread(id)`. Sweep adds async `sessionSeenAt`; drive adds page and async `mayStart(settings)`, `watch(thread,run)`, and `release(thread)`. Await these proxies. Every hook also receives the backend context as one extra final argument: for example `actions[name](state,args,actionCtx,backendCtx)` or `seed(state,values,backendCtx)`. This final argument has settings, secrets, shared state, database and asset APIs.

Plugin hooks compute against a state snapshot. If the page changes while a hook runs, Scribe retries up to three times before failing. Computations must be repeatable: do not perform external writes in speculative actions. Use explicit methods for external side effects.

## Transfer

Settings → Plugins imports and exports `.scribeplugin` ZIPs. Page exports include only used plugins, with a parts picker (Code and Source initially selected; Settings, State and Data optional). Secrets never travel. On update, locally edited source can be kept, replaced, or merged by an agent with incoming and base versions available. Legacy page JSON imports remain supported.
