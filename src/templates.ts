import { parseSearchDeclaration, type SearchDeclaration } from "./search/chunker.js";
import { AGENT_ACTION_PLACES, isPlainObject, type AgentAction, type AgentActionThread, type BoardState, type Template, type TemplateField, type TemplateFieldType, type TemplateValues } from "./types.js";

export const TEMPLATE_FIELD_TYPES = ["text", "textarea", "number", "select", "checkbox"] as const;

const FIELD_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const MAX_FIELDS = 32;
const MAX_TEXT = 500;
const MAX_TEXTAREA = 4000;
/** Ceiling for a field's own maxLength, so one field can't hold megabytes. */
const MAX_LENGTH_LIMIT = 65_536;

export type TemplateUpsertInput = {
  id?: string;
  key?: string;
  title: string;
  description?: string;
  html: string;
  fields?: unknown;
  titleTemplate?: string;
  initialState?: BoardState;
  stateVersion?: number;
  /** Omit to keep an existing template's guide; an empty string removes it. */
  guide?: string;
  /** Omit to keep an existing template's agent actions; an empty array removes them. */
  agentActions?: unknown;
  search?: unknown;
  /** False for a page-like template: its pages open unpinned. Omit to keep an existing template's setting. */
  pin?: boolean;
  /** On a built-in's local copy: the built-in's latest changes are merged, so clear builtinUpdate. */
  syncedWithBuiltin?: boolean;
};

/** A guide is read by agents, so keep it to a page or two. */
export const MAX_GUIDE_CHARS = 16_000;

export function parseTemplateFields(raw: unknown): TemplateField[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("fields must be an array");
  }
  if (raw.length > MAX_FIELDS) {
    throw new Error(`fields is too long (max ${MAX_FIELDS})`);
  }
  const seen = new Set<string>();
  return raw.map((item, index) => parseField(item, index, seen));
}

export function parseTemplateValues(fields: TemplateField[], raw: unknown): TemplateValues {
  const input = isPlainObject(raw) ? raw : {};
  const values: TemplateValues = {};
  for (const field of fields) {
    if (field.key in input) {
      values[field.key] = coerceFieldValue(field, input[field.key]);
    } else if (field.default !== undefined) {
      values[field.key] = field.default;
    } else if (field.type === "checkbox") {
      values[field.key] = false;
    } else if (field.type === "number") {
      values[field.key] = field.min ?? 0;
    } else {
      values[field.key] = "";
    }
    if (field.required && isEmptyValue(field, values[field.key])) {
      throw new Error(`${field.label} is required`);
    }
  }
  return values;
}

export function substituteTemplate(source: string, values: TemplateValues, escape: boolean): string {
  return source.replace(PLACEHOLDER, (_, key: string) => {
    const raw = values[key];
    const text = raw === undefined || raw === null ? "" : String(raw);
    return escape ? escapeHtml(text) : text;
  });
}

/** False when the title is the page's own (a template with no title field or titleTemplate): a rename then sticks. */
export function templateSetsTitle(template: Pick<Template, "titleTemplate" | "fields">): boolean {
  return Boolean(template.titleTemplate?.trim()) || template.fields.some((field) => field.key === "title");
}

export function renderTemplateTitle(template: Pick<Template, "title" | "titleTemplate" | "fields">, values: TemplateValues): string {
  if (template.titleTemplate?.trim()) {
    const title = substituteTemplate(template.titleTemplate, values, false).trim();
    return title || template.title;
  }
  if (template.fields.some((field) => field.key === "title")) {
    const title = String(values.title ?? "").trim();
    if (title) {
      return title;
    }
  }
  return template.title;
}

export function normalizeTemplateInput(input: TemplateUpsertInput): {
  title: string;
  description: string;
  html: string;
  fields: TemplateField[];
  titleTemplate?: string;
  initialState?: BoardState;
  stateVersion?: number;
  guide?: string;
  agentActions?: AgentAction[];
  search?: SearchDeclaration;
  pin?: boolean;
} {
  const title = input.title.trim();
  if (!title) {
    throw new Error("title is required");
  }
  const html = input.html.trim();
  if (!html) {
    throw new Error("html is required");
  }
  const fields = parseTemplateFields(input.fields);
  const titleTemplate = optionalTrimmed(input.titleTemplate);
  if (titleTemplate) {
    assertKnownPlaceholders(titleTemplate, fields, "titleTemplate");
  }
  assertKnownPlaceholders(html, fields, "html");
  let initialState: BoardState | undefined;
  if (input.initialState !== undefined) {
    if (!isPlainObject(input.initialState)) {
      throw new Error("initialState must be a JSON object");
    }
    initialState = { ...input.initialState };
  }
  let guide: string | undefined;
  if (input.guide !== undefined) {
    if (typeof input.guide !== "string") {
      throw new Error("guide must be a string");
    }
    guide = input.guide.trim();
    if (guide.length > MAX_GUIDE_CHARS) {
      throw new Error(`guide is too long (${guide.length} characters, max ${MAX_GUIDE_CHARS})`);
    }
  }
  const agentActions = input.agentActions === undefined ? undefined : parseAgentActions(input.agentActions);
  let stateVersion: number | undefined;
  if (input.stateVersion !== undefined) {
    if (!Number.isInteger(input.stateVersion) || input.stateVersion < 1) {
      throw new Error("stateVersion must be an integer >= 1");
    }
    stateVersion = input.stateVersion;
  }
  return {
    title,
    description: (input.description ?? "").trim(),
    html: input.html,
    fields,
    ...(titleTemplate ? { titleTemplate } : {}),
    ...(initialState ? { initialState } : {}),
    ...(stateVersion !== undefined ? { stateVersion } : {}),
    ...(guide !== undefined ? { guide } : {}),
    ...(agentActions !== undefined ? { agentActions } : {}),
    ...(input.search !== undefined ? { search: parseSearchDeclaration(input.search) } : {}),
    ...(typeof input.pin === "boolean" ? { pin: input.pin } : {}),
  };
}

const MAX_AGENT_ACTIONS = 16;
const MAX_ACTION_PROMPT = 8000;
const ACTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const ACTION_PLACEHOLDERS = new Set(["selection", "input", "page.title", "page.key"]);
const ACTION_CONTEXT_NAME = /^[a-z][a-z_]{0,29}$/;
const MAX_ACTION_CONTEXT = 4;
const ACTION_TAG = /\{\{\s*([#/]?)\s*([a-zA-Z_.]+)\s*\}\}/g;
const ACTION_MODES = ["board", "ask", "readonly"] as const;
const ACTION_WEB = ["on", "limited", "off"] as const;

/** Check a template's agentActions list; null or undefined is an empty list. */
export function parseAgentActions(raw: unknown): AgentAction[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("agentActions must be an array");
  }
  if (raw.length > MAX_AGENT_ACTIONS) {
    throw new Error(`agentActions is too long (max ${MAX_AGENT_ACTIONS})`);
  }
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const at = `agentActions[${index}]`;
    if (!isPlainObject(item)) {
      throw new Error(`${at} must be an object`);
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!ACTION_ID.test(id)) {
      throw new Error(`${at}.id must be lowercase letters, digits and dashes, starting with a letter (it is the slash command)`);
    }
    if (seen.has(id)) {
      throw new Error(`${at}.id "${id}" is used twice`);
    }
    seen.add(id);
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!label || label.length > 60) {
      throw new Error(`${at}.label is required (max 60 characters)`);
    }
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
    if (!prompt || prompt.length > MAX_ACTION_PROMPT) {
      throw new Error(`${at}.prompt is required (max ${MAX_ACTION_PROMPT} characters)`);
    }
    const context = parseActionContext(item.context, `${at}.context`);
    assertActionPlaceholders(prompt, `${at}.prompt`, context);
    const action: AgentAction = { id, label, prompt, where: [...AGENT_ACTION_PLACES] };
    if (context.length) {
      action.context = context;
    }
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (description) {
      action.description = description.slice(0, 200);
    }
    if (item.where !== undefined) {
      const places = Array.isArray(item.where) ? item.where : [item.where];
      if (!places.length || places.some((place) => !(AGENT_ACTION_PLACES as readonly unknown[]).includes(place))) {
        throw new Error(`${at}.where must list some of ${AGENT_ACTION_PLACES.join(", ")}`);
      }
      action.where = AGENT_ACTION_PLACES.filter((place) => places.includes(place));
    }
    if (item.selection !== undefined && item.selection !== "optional") {
      if (item.selection !== "required" && item.selection !== "none") {
        throw new Error(`${at}.selection must be required, optional or none`);
      }
      action.selection = item.selection;
    }
    if (item.run !== undefined && item.run !== "new") {
      if (item.run !== "chat") {
        throw new Error(`${at}.run must be new or chat`);
      }
      action.run = "chat";
    }
    if (item.thread !== undefined) {
      const thread = parseActionThread(item.thread, `${at}.thread`, context);
      if (Object.keys(thread).length) {
        action.thread = thread;
      }
    }
    return action;
  });
}

/** The page-supplied placeholder names an action declares: lowercase words, not the built-in ones. */
function parseActionContext(raw: unknown, at: string): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const names = Array.isArray(raw) ? raw : [raw];
  if (names.length > MAX_ACTION_CONTEXT) {
    throw new Error(`${at} is too long (max ${MAX_ACTION_CONTEXT} names)`);
  }
  const out: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || !ACTION_CONTEXT_NAME.test(name)) {
      throw new Error(`${at} names must be lowercase letters and underscores, starting with a letter, e.g. card`);
    }
    if (ACTION_PLACEHOLDERS.has(name)) {
      throw new Error(`${at}: "${name}" is a built-in placeholder`);
    }
    if (!out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

function parseActionThread(raw: unknown, at: string, context: string[] = []): AgentActionThread {
  if (!isPlainObject(raw)) {
    throw new Error(`${at} must be an object`);
  }
  const known = new Set(["mode", "provider", "model", "effort", "fast", "web", "title"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new Error(`${at}.${key} is not a thread setting (use ${[...known].join(", ")})`);
    }
  }
  const thread: AgentActionThread = {};
  if (raw.mode !== undefined) {
    if (!(ACTION_MODES as readonly unknown[]).includes(raw.mode)) {
      throw new Error(`${at}.mode must be board, ask or readonly (actions do not edit files or run commands)`);
    }
    thread.mode = raw.mode as AgentActionThread["mode"];
  }
  for (const key of ["provider", "model", "effort"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string" || !raw[key].trim()) {
        throw new Error(`${at}.${key} must be a string`);
      }
      thread[key] = raw[key].trim();
    }
  }
  if (raw.fast !== undefined) {
    if (typeof raw.fast !== "boolean") {
      throw new Error(`${at}.fast must be true or false`);
    }
    thread.fast = raw.fast;
  }
  if (raw.web !== undefined) {
    if (!(ACTION_WEB as readonly unknown[]).includes(raw.web)) {
      throw new Error(`${at}.web must be on, limited or off`);
    }
    thread.web = raw.web as AgentActionThread["web"];
  }
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string") {
      throw new Error(`${at}.title must be a string`);
    }
    const title = raw.title.trim().slice(0, 120);
    if (title) {
      assertActionPlaceholders(title, `${at}.title`, context);
      thread.title = title;
    }
  }
  return thread;
}

function assertActionPlaceholders(source: string, where: string, context: string[] = []): void {
  const open: string[] = [];
  for (const match of source.matchAll(ACTION_TAG)) {
    const [, mark, name] = match;
    if (!ACTION_PLACEHOLDERS.has(name) && !context.includes(name)) {
      throw new Error(
        `${where} uses unknown placeholder "${name}" (use ${[...ACTION_PLACEHOLDERS, ...context].join(", ")}, or declare it in context)`
      );
    }
    if (mark === "#") {
      open.push(name);
    } else if (mark === "/") {
      if (open.pop() !== name) {
        throw new Error(`${where}: {{/${name}}} does not close the section opened before it`);
      }
    }
  }
  if (open.length) {
    throw new Error(`${where}: {{#${open[open.length - 1]}}} is not closed`);
  }
}

/**
 * Fill in an action's prompt or title. {{#name}}…{{/name}} keeps its text only when the value is not
 * empty. public/agent.js does the same when it runs an action; keep the two in step.
 */
export function renderAgentActionText(source: string, values: Record<string, string>): string {
  const sections = /\{\{\s*#\s*([a-zA-Z_.]+)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\1\s*\}\}/g;
  let text = source;
  // Nested sections: the inner ones go on a later pass.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = text.replace(sections, (_, name: string, inner: string) => ((values[name] ?? "").trim() ? inner : ""));
    if (next === text) {
      break;
    }
    text = next;
  }
  return text.replace(ACTION_TAG, (_, mark: string, name: string) => (mark ? "" : (values[name] ?? ""))).trim();
}

/** Same content means the same template, regardless of id, key, or timestamps. */
export function templateFingerprint(
  template: Pick<Template, "title" | "description" | "html" | "fields" | "titleTemplate" | "initialState" | "stateVersion" | "search" | "pin">
): string {
  return stableJson({
    title: template.title,
    description: template.description,
    html: template.html,
    fields: template.fields,
    titleTemplate: template.titleTemplate ?? null,
    initialState: template.initialState ?? null,
    stateVersion: template.stateVersion,
    ...(template.search ? { search: template.search } : {}),
    ...(template.pin === false ? { pin: false } : {}),
  });
}

export function mergeTemplateValues(fields: TemplateField[], current: TemplateValues | undefined): TemplateValues {
  return parseTemplateValues(fields, current ?? {});
}

function parseField(raw: unknown, index: number, seen: Set<string>): TemplateField {
  if (!isPlainObject(raw)) {
    throw new Error(`fields[${index}] must be an object`);
  }
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  if (!FIELD_KEY.test(key)) {
    throw new Error(`fields[${index}].key must be a JS identifier`);
  }
  if (seen.has(key)) {
    throw new Error(`fields[${index}].key is duplicated: ${key}`);
  }
  seen.add(key);
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) {
    throw new Error(`fields[${index}].label is required`);
  }
  const type = parseFieldType(raw.type, index);
  const field: TemplateField = { key, label, type };
  if (raw.required === true) {
    field.required = true;
  }
  if (typeof raw.placeholder === "string" && raw.placeholder.trim()) {
    field.placeholder = raw.placeholder.trim();
  }
  if (typeof raw.help === "string" && raw.help.trim()) {
    field.help = raw.help.trim();
  }
  if (typeof raw.min === "number" && Number.isFinite(raw.min)) {
    field.min = raw.min;
  }
  if (typeof raw.max === "number" && Number.isFinite(raw.max)) {
    field.max = raw.max;
  }
  if (raw.maxLength !== undefined) {
    if (type !== "text" && type !== "textarea") {
      throw new Error(`fields[${index}].maxLength only applies to text and textarea`);
    }
    if (!Number.isInteger(raw.maxLength) || (raw.maxLength as number) < 1 || (raw.maxLength as number) > MAX_LENGTH_LIMIT) {
      throw new Error(`fields[${index}].maxLength must be an integer from 1 to ${MAX_LENGTH_LIMIT}`);
    }
    field.maxLength = raw.maxLength as number;
  }
  if (type === "select") {
    field.options = parseOptions(raw.options, index);
  }
  if (raw.default !== undefined) {
    field.default = coerceFieldValue(field, raw.default);
  }
  return field;
}

function parseFieldType(value: unknown, index: number): TemplateFieldType {
  if (typeof value !== "string") {
    throw new Error(`fields[${index}].type is required`);
  }
  for (const type of TEMPLATE_FIELD_TYPES) {
    if (value === type) {
      return type;
    }
  }
  throw new Error(`fields[${index}].type must be text, textarea, number, select, or checkbox`);
}

function parseOptions(raw: unknown, index: number): { value: string; label: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`fields[${index}].options is required for select`);
  }
  return raw.map((item, optionIndex) => {
    if (typeof item === "string") {
      const value = item.trim();
      if (!value) {
        throw new Error(`fields[${index}].options[${optionIndex}] is empty`);
      }
      return { value, label: value };
    }
    if (!isPlainObject(item)) {
      throw new Error(`fields[${index}].options[${optionIndex}] is invalid`);
    }
    const value = typeof item.value === "string" ? item.value.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : value;
    if (!value) {
      throw new Error(`fields[${index}].options[${optionIndex}].value is required`);
    }
    return { value, label: label || value };
  });
}

function coerceFieldValue(field: TemplateField, raw: unknown): string | number | boolean {
  switch (field.type) {
    case "text":
    case "textarea": {
      const text = raw == null ? "" : String(raw);
      const max = field.maxLength ?? (field.type === "textarea" ? MAX_TEXTAREA : MAX_TEXT);
      if (text.length > max) {
        throw new Error(`${field.label} is too long (max ${max})`);
      }
      return text;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) {
        throw new Error(`${field.label} must be a number`);
      }
      if (field.min !== undefined && n < field.min) {
        throw new Error(`${field.label} must be at least ${field.min}`);
      }
      if (field.max !== undefined && n > field.max) {
        throw new Error(`${field.label} must be at most ${field.max}`);
      }
      return n;
    }
    case "checkbox":
      if (typeof raw === "boolean") {
        return raw;
      }
      if (raw === "true" || raw === 1 || raw === "1") {
        return true;
      }
      if (raw === "false" || raw === 0 || raw === "0" || raw === "") {
        return false;
      }
      throw new Error(`${field.label} must be true or false`);
    case "select": {
      const value = raw == null ? "" : String(raw);
      const options = field.options ?? [];
      if (!options.some((option) => option.value === value)) {
        throw new Error(`${field.label} must be one of the listed options`);
      }
      return value;
    }
    default: {
      const _never: never = field.type;
      return _never;
    }
  }
}

function isEmptyValue(field: TemplateField, value: string | number | boolean): boolean {
  switch (field.type) {
    case "text":
    case "textarea":
    case "select":
      return String(value).trim() === "";
    case "number":
      return typeof value !== "number";
    case "checkbox":
      return false;
    default: {
      const _never: never = field.type;
      return _never;
    }
  }
}

function assertKnownPlaceholders(source: string, fields: TemplateField[], where: string): void {
  const keys = new Set(fields.map((field) => field.key));
  const unknown = new Set<string>();
  source.replace(PLACEHOLDER, (_, key: string) => {
    if (!keys.has(key)) {
      unknown.add(key);
    }
    return "";
  });
  if (unknown.size) {
    throw new Error(`${where} uses unknown field(s): ${[...unknown].join(", ")}`);
  }
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
