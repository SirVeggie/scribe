/**
 * Which of Scribe's MCP tools a chat loads up front, and which on demand (#tool-size). The 65 tool
 * schemas cost ~29k tokens on every model call when all of them ride along; most turns use a
 * handful. The rest are listed by name only and loaded when the agent asks:
 *
 * - Claude: Claude Code's ToolSearch, from `_meta["anthropic/alwaysLoad"]: false` (mcp.ts deferTools).
 * - Pi: Scribe's own tool_search and tool_call (providers/pi.ts), since Pi has no tool search.
 * - Codex: its code mode already keeps MCP tools out of the prompt (ALL_TOOLS), so nothing is deferred here.
 * - Cursor: its reported prompts are smaller than the schemas, so it does not appear to send them all; left alone.
 *
 * Every turn records the scheme it ran with (Turn.toolLoading), so the harness stats can compare
 * prompt size, tool errors and failed turns before and after. Bump TOOL_LOADING when the list or
 * the mechanism changes, so a later change can be told apart from this one.
 */

/** Tools few turns need: a task the user asks for by name, or a narrow follow-up. */
export const DEFERRED_TOOLS: ReadonlySet<string> = new Set([
  "template_list", "template_get", "template_upsert", "template_delete", "template_open",
  "plugin_list", "plugin_guide", "plugin_call", "plugin_state", "plugin_task", "plugin_logs",
  "plugin_create", "plugin_read", "plugin_patch", "plugin_reload", "plugin_install",
  "browser_open", "browser_act", "browser_snapshot", "browser_screenshot", "browser_eval",
  "browser_console", "browser_network", "browser_viewport", "browser_tabs", "browser_control",
  "agent_models", "agent_run",
  "harness_docs", "harness_change",
  "settings_find", "settings_show",
  "thread_list", "thread_read", "thread_access", "thread_worktree",
  "memory_list", "memory_delete",
  "page_screenshot", "page_pin", "page_unpin", "page_access", "page_wait",
  "device_list", "web_request", "widget_show", "scribe_docs",
]);

/** The deferred scheme and its version, as recorded on turns. */
export const TOOL_LOADING = "deferred-1";

/** The scheme a provider's turns run with now; undefined: every tool is sent up front (or the provider decides itself). */
export function toolLoadingFor(provider: string): string | undefined {
  return provider === "claude" || provider === "pi" ? TOOL_LOADING : undefined;
}

/** The names Scribe's own search tools use on providers without one (Pi). */
export const TOOL_SEARCH = "tool_search";
export const TOOL_CALL = "tool_call";
