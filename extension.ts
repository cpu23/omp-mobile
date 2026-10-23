import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getSessionAccentHex, type SessionAccentInputs } from "./session-accent";
import {
  isRoutineNotice,
  type MobileHistory,
  type MobileImage,
  type MobileInteractionAction,
  type MobileMessage,
  type MobileNotice,
  type MobilePart,
  type MobileRuntime,
  type MobileAskDisplay,
  type MobileAskSubmissionAnswer,
} from "./parity-types";
import { createInteractionBridge } from "./interactions";
import { registerMobileAskTool } from "./ask-tool";

/**
 * In-process OMP mobile bridge.
 *
 * This extension deliberately only uses the public extension surface. It does
 * not construct an AgentSession, read provider credentials, or overwrite an
 * existing editor/dialog. Guarded terminal commands are prepared in an empty
 * editor; the gateway submits them to the owning desktop PTY that runs this
 * process.
 *
 * It must not value-import the host package: the compiled omp binary loads
 * extension files with plain Bun resolution, which fails for host specifiers
 * unless the extension has its own matching node_modules install. Optional
 * host helpers are loaded lazily below and degrade to local fallbacks.
 *
 * The socket is a narrow, owner-only IPC seam; the gateway remains responsible
 * for exposing it over Tailscale.
 */

type Action = {
  generation?: unknown;
  type?: unknown;
  text?: unknown;
  provider?: unknown;
  id?: unknown;
  value?: unknown;
  path?: unknown;
  confirmed?: unknown;
  images?: unknown;
  choice?: unknown;
  feedback?: unknown;
  answers?: unknown;
  role?: unknown;
};
type MobileModel = {
  provider: string;
  id: string;
  name?: string;
};

type MobileSlashCommand = {
  name: string;
  aliases?: string[];
  description?: string;
};

type MobileCapabilities = {
  prompt: boolean;
  abort: boolean;
  model: boolean;
  effort: boolean;
  move: boolean;
  command: boolean;
  theme: boolean;
  approval: boolean;
  terminal: boolean;
  summary: boolean;
  events: boolean;
  moveReason?: string;
  approvalReason?: string;
};

type CompletionMarker = {
  identity: string;
  generation: string;
  turn: number;
  completedAt: number;
};

type PendingMobileMessage = {
  id: string;
  text: string;
  status: "sending" | "queued";
};
type MobileState = {
  apiVersion: 1;
  generation: string;
  accent: string | null;
  model: MobileModel | null;
  models: MobileModel[];
  effort: ThinkingLevel | null;
  efforts: ThinkingLevel[];
  context: { tokens: number; contextWindow: number; percent: number } | null;
  cost: { total: number } | null;
  theme: {
    name: string | null;
    accent: string | null;
    isLight?: boolean;
    tokens: Record<string, string>;
  } | null;
  messages: MobileMessage[];
  commands: MobileSlashCommand[];
  runtime?: MobileRuntime;
  history?: MobileHistory;
  capabilities: MobileCapabilities;
  cwd: string;
  pendingApproval: number;
  editor: { available: boolean; empty: boolean | null; reason?: string };
  completion?: CompletionMarker;
  agentActive: boolean;
  activity: SessionActivity;
  hasPendingMessages: boolean;
  pendingMessages: PendingMobileMessage[];
  title?: string;
  summary?: string;
};
type MovePrepareResponse = {
  ok: true;
  staged: true;
  generation: string;
  path: string;
  command: string;
};
type CommandPrepareResponse = {
  ok: true;
  staged: true;
  generation: string;
  command: string;
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 80;
const MAX_PARTS_PER_MESSAGE = 60;
const MAX_TEXT_CHARS = 8000;
const MAX_THINKING_CHARS = 4000;
const MAX_TOOL_OUTPUT_CHARS = 6000;
const MAX_TRANSCRIPT_CONTENT_CHARS = 600 * 1024;
const MAX_STATE_INLINE_DETAILS_CHARS = 512;
const MAX_STATE_IMAGE_BASE64_CHARS = 48 * 1024;
const MAX_PROMPT_IMAGES = 8;
const MAX_PROMPT_IMAGE_BASE64_CHARS = 3 * 1024 * 1024;
const MAX_MESSAGE_TRANSFER_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGE_TRANSFER_CACHE_ENTRIES = 64;
const MESSAGE_TRANSFER_TTL_MS = 2 * 60 * 1000;
const FULL_MESSAGE_CHUNK_CHARS = 256 * 1024;
const SNAPSHOT_CACHE_WINDOW_MS = 40;

type AskOption = { label: string; description?: string };
type AskQuestion = {
  id?: string;
  question: string;
  header?: string;
  options: AskOption[];
  multi: boolean;
  recommended?: number;
};
type AskAnswer = {
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
};
type AskDisplay = MobileAskDisplay;

type ActivityTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "blocked";
type ActivityTodo = {
  content: string;
  status: ActivityTodoStatus;
  blocker?: string;
};
type ActivityTodoPhase = { name: string; tasks: ActivityTodo[] };
type ActivityAgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted";
type ActivitySubagent = {
  id: string;
  label?: string;
  agent?: string;
  status: ActivityAgentStatus;
  description?: string;
  task?: string;
  activity?: string;
  currentTool?: string;
  model?: string;
  startedAt?: number;
  updatedAt?: number;
  durationMs?: number;
  toolCount?: number;
  requests?: number;
  tokens?: number;
  cost?: number;
  contextTokens?: number;
  contextWindow?: number;
  error?: string;
  note?: string;
  detached?: boolean;
};
type ActivityJob = {
  id: string;
  type: "bash" | "task" | "other";
  label: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  durationMs?: number;
};
type SessionActivity = {
  working?: string;
  workingTool?: string;
  since?: number;
  todos: ActivityTodoPhase[];
  subagents: ActivitySubagent[];
  jobs: ActivityJob[];
};
/** Internal transcript annotation: which task tool call spawned which agents. */
type TaskActivity = {
  agents: ActivitySubagent[];
  asyncState?: "running" | "completed" | "failed";
};
/** Minimal shape of the host's process-global subagent registry. */
type HostAgentRef = {
  id: string;
  displayName: string;
  kind: string;
  parentId?: string;
  status: string;
  activity?: string;
  createdAt: number;
  lastActivity: number;
  sessionFile: string | null;
  session?: { sessionId?: string } | null;
  history?: {
    modelRole?: string;
    resolvedModel?: string;
    metrics?: {
      tokens?: number;
      requests?: number;
      tools?: number;
      cost?: number;
      durationMs?: number;
    };
  };
};
type HostAgentRegistry = { list(): HostAgentRef[] };
type HostJobItem = {
  id: string;
  type: string;
  status: string;
  label: string;
  startTime: number;
};
type HostJobSnapshot = { running: HostJobItem[]; recent: HostJobItem[] };
type MobileServer = { stop(closeActiveConnections?: boolean): void };

/**
 * Desktop runtime ids, minted by omp-desktop's RuntimeManager as `rt-<uuid>`.
 * These are the only accepted IPC identities; the retired fixed Zellij slot
 * names (`left`, `w2-right`, ...) are rejected outright.
 */
const RUNTIME_ID_RE = /^rt-[A-Za-z0-9-]{1,64}$/;
const MAX_STRING_BYTES = 8 * 1024;
const FIXED_EFFORTS = ["inherit", "off"] as const;
type OmpModel = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeString(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > MAX_STRING_BYTES - 32)
    result = result.slice(0, -256);
  return `${result}\n[…truncated]`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelForSnapshot(model: unknown): MobileModel | null {
  if (!model || typeof model !== "object") return null;
  const candidate = model as Record<string, unknown>;
  const provider = asString(candidate.provider);
  const id = asString(candidate.id);
  if (!provider || !id) return null;
  const name = asString(candidate.name);
  return name ? { provider, id, name } : { provider, id };
}

function modelsForSnapshot(models: unknown): MobileModel[] {
  if (!Array.isArray(models)) return [];
  const result: MobileModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const safe = modelForSnapshot(model);
    if (!safe) continue;
    const key = `${safe.provider}/${safe.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(safe);
  }
  return result;
}

function effortsForModel(model: OmpModel | undefined): ThinkingLevel[] {
  const result: ThinkingLevel[] = [...FIXED_EFFORTS];
  for (const effort of model?.thinking?.efforts ?? []) {
    if (!result.includes(effort)) result.push(effort);
  }
  return result;
}

function themeSnapshot(ctx: ExtensionContext): {
  name: string | null;
  accent: string | null;
  isLight?: boolean;
  tokens: Record<string, string>;
} | null {
  const theme = ctx.ui?.theme;
  if (
    !theme ||
    typeof theme !== "object" ||
    typeof theme.getColorHex !== "function"
  )
    return null;
  const tokenNames = [
    "accent",
    "border",
    "success",
    "error",
    "warning",
    "muted",
    "text",
    "userMessageText",
    "toolTitle",
    "toolOutput",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "thinkingMax",
    "statusLineModel",
    "statusLineCost",
    "statusLinePath",
    "statusLineContext",
    "mdHeading",
    "mdListBullet",
    "mdLink",
    "mdCode",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
  ] as const;
  const tokens: Record<string, string> = {};
  for (const token of tokenNames) {
    try {
      const value = theme.getColorHex(token);
      if (typeof value === "string" && value.length > 0) tokens[token] = value;
    } catch {
      // Older runtimes may not expose every token; omit only that token.
    }
  }
  return {
    name: null,
    accent: tokens.accent ?? null,
    isLight: typeof theme.isLight === "boolean" ? theme.isLight : undefined,
    tokens,
  };
}

function normalizeSessionAccentInputs(
  value: unknown,
): SessionAccentInputs | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const accentHex =
    typeof raw.accentHex === "string" && raw.accentHex.length > 0
      ? raw.accentHex
      : undefined;
  const colorHexes = Array.isArray(raw.colorHexes)
    ? raw.colorHexes.filter((hex): hex is string => typeof hex === "string")
    : [];
  const surfaceLuminance =
    typeof raw.surfaceLuminance === "number" &&
    Number.isFinite(raw.surfaceLuminance)
      ? raw.surfaceLuminance
      : undefined;
  if (accentHex === undefined && colorHexes.length === 0) return null;
  return { accentHex, colorHexes, surfaceLuminance };
}

/**
 * Read the frozen `theme.sessionAccentInputs` token the host CLI feeds to its
 * `getSessionAccentHex`. Hosts that expose no token yield null; callers then
 * fall back to the neutral client default instead of a guessed hue.
 */
function readThemeAccentInputs(
  ctx: ExtensionContext,
): SessionAccentInputs | null {
  const theme = ctx.ui?.theme;
  if (!theme || typeof theme !== "object" || !("sessionAccentInputs" in theme))
    return null;
  try {
    return normalizeSessionAccentInputs(
      Reflect.get(theme, "sessionAccentInputs"),
    );
  } catch {
    return null;
  }
}

/**
 * Per-session accent used to tell runtimes apart in the phone list and the
 * desktop sidebar. Mirrors the host CLI exactly, including the host's
 * "unnamed sessions have no accent" rule.
 */
export function sessionAccent(ctx: ExtensionContext): string | null {
  try {
    const sessionName = ctx.sessionManager?.getSessionName?.() ?? "";
    if (!sessionName.trim()) return null;
    const inputs = readThemeAccentInputs(ctx);
    if (!inputs) return null;
    return getSessionAccentHex(sessionName, inputs);
  } catch {
    return null;
  }
}

function branchCost(branch: unknown): { total: number } | null {
  if (!Array.isArray(branch)) return null;
  let totalCost = 0;
  let hasCost = false;

  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (
      item.type !== "message" ||
      !item.message ||
      typeof item.message !== "object"
    )
      continue;
    const raw = item.message as Record<string, unknown>;
    const role = asString(raw.role);

    if (role === "assistant") {
      const usage =
        raw.usage && typeof raw.usage === "object"
          ? (raw.usage as Record<string, unknown>)
          : undefined;
      const cost =
        usage?.cost && typeof usage.cost === "object"
          ? (usage.cost as Record<string, unknown>)
          : undefined;
      if (typeof cost?.total === "number" && Number.isFinite(cost.total)) {
        totalCost += cost.total;
        hasCost = true;
      }
    }
  }

  return hasCost ? { total: totalCost } : null;
}

function latestSummary(branch: unknown): string | undefined {
  if (!Array.isArray(branch)) return undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (item.type !== "compaction" && item.type !== "branch_summary") continue;
    const summary = asString(item.shortSummary) ?? asString(item.summary);
    if (summary) return safeString(summary);
  }
  return undefined;
}

/**
 * Optional host helper: omp's canonical tool-call summary. Loaded lazily and
 * entirely best-effort — the compiled binary cannot resolve host specifiers for
 * `-e` extensions, so the local formatter below is the normal path.
 */
let runtimeFormatToolCallPrimaryArg:
  | ((
      name: string,
      args: Record<string, unknown> | undefined,
    ) => string)
  | undefined;
try {
  void import("@oh-my-pi/pi-coding-agent")
    .then((module) => {
      const candidate = (module as Record<string, unknown>)
        .formatToolCallPrimaryArg;
      if (typeof candidate === "function") {
        runtimeFormatToolCallPrimaryArg = candidate as typeof runtimeFormatToolCallPrimaryArg;
      }
    })
    .catch(() => undefined);
} catch {
  // Static resolution rejected the specifier; local formatting still applies.
}

/**
 * Builtin slash commands (name/aliases/description) for the phone's command
 * palette. The public `pi.getCommands()` surface lists only dynamically
 * registered commands, and the internal registry subpath cannot be value-
 * imported by a `-e` extension under the compiled binary, so this is a lazy
 * best-effort load. `handleAction` accepts plain builtin names even when the
 * list is unavailable, so command execution never depends on this.
 */
let builtinCommands: MobileSlashCommand[] | undefined;
try {
  void import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry")
    .then((module) => {
      const defs = (module as Record<string, unknown>).BUILTIN_SLASH_COMMAND_DEFS;
      if (!Array.isArray(defs)) return;
      builtinCommands = defs.flatMap((def): MobileSlashCommand[] => {
        if (!def || typeof def !== "object") return [];
        const value = def as Record<string, unknown>;
        const name = typeof value.name === "string" ? value.name : "";
        if (!name) return [];
        return [
          {
            name,
            ...(Array.isArray(value.aliases)
              ? {
                  aliases: value.aliases.filter(
                    (alias): alias is string => typeof alias === "string",
                  ),
                }
              : {}),
            ...(typeof value.description === "string"
              ? { description: value.description }
              : {}),
          },
        ];
      });
    })
    .catch(() => undefined);
} catch {
  // Static resolution rejected the specifier; typed commands still work.
}

function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… truncated`;
}

function formatToolCallSummary(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  if (runtimeFormatToolCallPrimaryArg) {
    try {
      const summary = runtimeFormatToolCallPrimaryArg(name, args);
      if (summary) return oneLine(summary, 90);
    } catch {
      // fallback
    }
  }
  if (!args || typeof args !== "object") return "";

  const command = asString(args.command) ?? asString(args.cmd);
  if (command) return oneLine(command, 90);

  const rawPath =
    asString(args.path) ??
    asString(args.file_path) ??
    asString(args.filePath) ??
    asString(args.paths);
  if (rawPath) {
    let pathSummary = rawPath;
    const offset =
      args.offset !== undefined && args.offset !== null
        ? String(args.offset)
        : undefined;
    const limit =
      args.limit !== undefined && args.limit !== null
        ? String(args.limit)
        : undefined;
    if (offset !== undefined && limit !== undefined) {
      pathSummary = `${rawPath}:${offset}+${limit}`;
    } else if (offset !== undefined) {
      pathSummary = `${rawPath}:${offset}`;
    } else if (limit !== undefined) {
      pathSummary = `${rawPath}:limit=${limit}`;
    }
    return oneLine(pathSummary, 90);
  }

  const query =
    asString(args.query) ?? asString(args.pattern) ?? asString(args.pat);
  if (query) return oneLine(query, 90);

  for (const [key, val] of Object.entries(args)) {
    if (
      key === "intent" ||
      key.includes("Signature") ||
      key === "itemId" ||
      key === "thoughtSignature"
    )
      continue;
    const strVal = asString(val);
    if (strVal) return oneLine(strVal, 90);
  }

  try {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (
        k === "intent" ||
        k.includes("Signature") ||
        k === "itemId" ||
        k === "thoughtSignature"
      )
        continue;
      clean[k] = v;
    }
    const jsonStr = JSON.stringify(clean);
    return jsonStr === "{}" ? "" : oneLine(jsonStr, 90);
  } catch {
    return "";
  }
}

function extractContentText(content: unknown): string | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean")
    return String(content);
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        pieces.push(item);
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (obj.type !== "image") {
          if (typeof obj.text === "string") {
            pieces.push(obj.text);
          } else if (typeof obj.content === "string") {
            pieces.push(obj.content);
          } else if (typeof obj.output === "string") {
            pieces.push(obj.output);
          }
        }
      }
    }
    return pieces.join("\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const ACTIVITY_TEXT_MAX = 600;
const ACTIVITY_TODO_MAX = 40;
const ACTIVITY_PHASES_MAX = 12;
const ACTIVITY_AGENTS_MAX = 12;
const ACTIVITY_JOBS_MAX = 12;

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function activityText(value: unknown, max = ACTIVITY_TEXT_MAX): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const flat = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function todoStatus(value: unknown): ActivityTodoStatus | undefined {
  return value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "abandoned" ||
    value === "blocked"
    ? value
    : undefined;
}

/**
 * Read a persisted todo snapshot from a `todo` tool result. The host stores the
 * full phased list in `details.phases`; an empty array is valid and clears the
 * list, so it must be returned rather than treated as "no snapshot".
 */
function normalizeTodoPhases(value: unknown): ActivityTodoPhase[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases: ActivityTodoPhase[] = [];
  for (const rawPhase of value.slice(0, ACTIVITY_PHASES_MAX)) {
    if (!rawPhase || typeof rawPhase !== "object" || Array.isArray(rawPhase))
      continue;
    const phase = rawPhase as Record<string, unknown>;
    const name = activityText(phase.name, 120);
    if (!name || !Array.isArray(phase.tasks)) continue;
    const tasks: ActivityTodo[] = [];
    for (const rawTask of phase.tasks.slice(0, ACTIVITY_TODO_MAX)) {
      if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask))
        continue;
      const task = rawTask as Record<string, unknown>;
      const content = activityText(task.content, 400);
      const status = todoStatus(task.status);
      if (!content || !status) continue;
      const blocker = activityText(task.blocker, 200);
      tasks.push({
        content,
        status,
        ...(blocker ? { blocker } : {}),
      });
    }
    phases.push({ name, tasks });
  }
  return phases;
}

function agentStatus(value: unknown): ActivityAgentStatus | undefined {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted"
    ? value
    : undefined;
}

function resultOutcome(result: Record<string, unknown>): ActivityAgentStatus {
  if (result.aborted === true) return "aborted";
  if (result.error !== undefined && result.error !== null) return "failed";
  const exitCode = asFiniteNumber(result.exitCode);
  if (exitCode !== undefined && exitCode !== 0) return "failed";
  return "completed";
}

function resultCost(result: Record<string, unknown>): number | undefined {
  const usage = result.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage))
    return undefined;
  const cost = (usage as Record<string, unknown>).cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost))
    return undefined;
  return asFiniteNumber((cost as Record<string, unknown>).total);
}

/**
 * Project a `task` tool result/update into desktop's AgentProgress rows. The
 * host exposes the same `details.progress` snapshot its TUI renders, including
 * per-agent status, assignment, latest intent, current tool, and usage.
 */
function taskActivityFromDetails(
  details: unknown,
  previous?: TaskActivity,
): TaskActivity | undefined {
  const value = parseToolArguments(details);
  if (!value) return previous;
  const rawProgress = Array.isArray(value.progress) ? value.progress : [];
  const rawResults = Array.isArray(value.results) ? value.results : [];
  const asyncState =
    value.async && typeof value.async === "object"
      ? asString((value.async as Record<string, unknown>).state)
      : undefined;
  const resultsById = new Map<string, Record<string, unknown>>();
  const resultsByIndex = new Map<number, Record<string, unknown>>();
  for (const raw of rawResults) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const result = raw as Record<string, unknown>;
    const id = asString(result.id) ?? asString(result.agentId);
    if (id) resultsById.set(id, result);
    const index = asFiniteNumber(result.index);
    if (index !== undefined) resultsByIndex.set(index, result);
  }
  const merged = new Map<string, ActivitySubagent>();
  for (const existing of previous?.agents ?? []) {
    merged.set(existing.id, { ...existing });
  }
  rawProgress.forEach((raw, position) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const progress = raw as Record<string, unknown>;
    const index = asFiniteNumber(progress.index) ?? position;
    const id =
      asString(progress.id) ?? asString(progress.agentId) ?? `task-${index}`;
    const result = resultsById.get(id) ?? resultsByIndex.get(index);
    const status = result
      ? resultOutcome(result)
      : (agentStatus(progress.status) ?? "running");
    const retryState =
      progress.retryState &&
      typeof progress.retryState === "object" &&
      !Array.isArray(progress.retryState)
        ? (progress.retryState as Record<string, unknown>)
        : undefined;
    const retryFailure =
      progress.retryFailure &&
      typeof progress.retryFailure === "object" &&
      !Array.isArray(progress.retryFailure)
        ? (progress.retryFailure as Record<string, unknown>)
        : undefined;
    const attempt = asFiniteNumber(retryState?.attempt);
    const maxAttempts = asFiniteNumber(retryState?.maxAttempts);
    const retryMessage = activityText(
      retryState?.errorMessage ?? retryFailure?.errorMessage,
      240,
    );
    const note =
      status === "running" && retryState && attempt !== undefined
        ? `retrying ${attempt}/${maxAttempts ?? "?"}${retryMessage ? `: ${retryMessage}` : ""}`
        : retryFailure && (status === "failed" || status === "aborted")
          ? `retry gave up${retryMessage ? `: ${retryMessage}` : ""}`
          : undefined;
    const previousAgent = merged.get(id);
    const description = activityText(
      progress.description ?? result?.description,
      200,
    );
    const task = activityText(
      progress.assignment ??
        progress.task ??
        result?.assignment ??
        result?.task,
      ACTIVITY_TEXT_MAX,
    );
    const currentTool = activityText(
      progress.currentTool ?? result?.toolName,
      120,
    );
    const activity = activityText(
      progress.lastIntent ?? progress.currentToolArgs ?? currentTool,
      300,
    );
    const error = activityText(
      result?.error ?? result?.abortReason ?? retryFailure?.errorMessage,
      400,
    );
    const agent: ActivitySubagent = {
      id,
      status,
      ...(previousAgent?.label ? { label: previousAgent.label } : {}),
      ...(asString(progress.agent) ?? asString(result?.agent)
        ? { agent: asString(progress.agent) ?? asString(result?.agent) }
        : {}),
      ...(description ? { description } : {}),
      ...(task ? { task } : previousAgent?.task ? { task: previousAgent.task } : {}),
      ...(activity ? { activity } : previousAgent?.activity ? { activity: previousAgent.activity } : {}),
      ...(currentTool
        ? { currentTool }
        : previousAgent?.currentTool
          ? { currentTool: previousAgent.currentTool }
          : {}),
      ...(asString(result?.resolvedModel) ?? asString(progress.resolvedModel)
        ? {
            model:
              asString(result?.resolvedModel) ??
              asString(progress.resolvedModel),
          }
        : previousAgent?.model
          ? { model: previousAgent.model }
          : {}),
      ...(previousAgent?.startedAt !== undefined
        ? { startedAt: previousAgent.startedAt }
        : {}),
      ...(asFiniteNumber(progress.durationMs) !== undefined
        ? { durationMs: asFiniteNumber(progress.durationMs) }
        : result && asFiniteNumber(result.durationMs) !== undefined
          ? { durationMs: asFiniteNumber(result.durationMs) }
          : previousAgent?.durationMs !== undefined
            ? { durationMs: previousAgent.durationMs }
            : {}),
      ...(asFiniteNumber(progress.toolCount) !== undefined
        ? { toolCount: asFiniteNumber(progress.toolCount) }
        : previousAgent?.toolCount !== undefined
          ? { toolCount: previousAgent.toolCount }
          : {}),
      ...(asFiniteNumber(progress.requests) !== undefined
        ? { requests: asFiniteNumber(progress.requests) }
        : previousAgent?.requests !== undefined
          ? { requests: previousAgent.requests }
          : {}),
      ...(asFiniteNumber(progress.tokens) !== undefined
        ? { tokens: asFiniteNumber(progress.tokens) }
        : asFiniteNumber(result?.tokens) !== undefined
          ? { tokens: asFiniteNumber(result?.tokens) }
          : previousAgent?.tokens !== undefined
            ? { tokens: previousAgent.tokens }
            : {}),
      ...(asFiniteNumber(progress.cost) !== undefined
        ? { cost: asFiniteNumber(progress.cost) }
        : resultCost(result ?? {}) !== undefined
          ? { cost: resultCost(result ?? {}) }
          : previousAgent?.cost !== undefined
            ? { cost: previousAgent.cost }
            : {}),
      ...(asFiniteNumber(progress.contextTokens) !== undefined
        ? { contextTokens: asFiniteNumber(progress.contextTokens) }
        : previousAgent?.contextTokens !== undefined
          ? { contextTokens: previousAgent.contextTokens }
          : {}),
      ...(asFiniteNumber(progress.contextWindow) !== undefined
        ? { contextWindow: asFiniteNumber(progress.contextWindow) }
        : previousAgent?.contextWindow !== undefined
          ? { contextWindow: previousAgent.contextWindow }
          : {}),
      ...(error ? { error } : previousAgent?.error ? { error: previousAgent.error } : {}),
      ...(note ? { note } : previousAgent?.note ? { note: previousAgent.note } : {}),
    };
    if (asyncState === "running" && (status === "running" || status === "pending"))
      agent.detached = true;
    merged.set(id, agent);
  });
  // Completed blocking spawns can appear only in `results` when a mixed call
  // returns before the progress snapshot is refreshed.
  rawResults.forEach((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const result = raw as Record<string, unknown>;
    const id = asString(result.id) ?? asString(result.agentId);
    if (!id || merged.has(id)) return;
    const status = resultOutcome(result);
    merged.set(id, {
      id,
      status,
      ...(asString(result.agent) ? { agent: asString(result.agent) } : {}),
      ...(activityText(result.description, 200)
        ? { description: activityText(result.description, 200) }
        : {}),
      ...(activityText(result.assignment ?? result.task, ACTIVITY_TEXT_MAX)
        ? {
            task: activityText(
              result.assignment ?? result.task,
              ACTIVITY_TEXT_MAX,
            ),
          }
        : {}),
      ...(activityText(result.error ?? result.abortReason, 400)
        ? { error: activityText(result.error ?? result.abortReason, 400) }
        : {}),
      ...(asFiniteNumber(result.durationMs) !== undefined
        ? { durationMs: asFiniteNumber(result.durationMs) }
        : {}),
      ...(asFiniteNumber(result.requests) !== undefined
        ? { requests: asFiniteNumber(result.requests) }
        : {}),
      ...(asFiniteNumber(result.tokens) !== undefined
        ? { tokens: asFiniteNumber(result.tokens) }
        : {}),
      ...(resultCost(result) !== undefined ? { cost: resultCost(result) } : {}),
      ...(asFiniteNumber(result.contextTokens) !== undefined
        ? { contextTokens: asFiniteNumber(result.contextTokens) }
        : {}),
      ...(asFiniteNumber(result.contextWindow) !== undefined
        ? { contextWindow: asFiniteNumber(result.contextWindow) }
        : {}),
      ...(asString(result.resolvedModel) ? { model: asString(result.resolvedModel) } : {}),
    });
  });
  if (merged.size === 0 && !asyncState) return previous;
  return {
    agents: [...merged.values()],
    ...(asyncState === "running" ||
    asyncState === "completed" ||
    asyncState === "failed"
      ? { asyncState }
      : {}),
  };
}

/**
 * Host custom entry that records a user-authored todo edit. The host persists
 * these in the branch as `{type: "custom", customType, data: {phases}}`
 * instead of `todo` tool results, and its own reader
 * (`getLatestTodoPhasesFromEntries`) treats both kinds as todo snapshots.
 */
const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

/**
 * Read the latest todo snapshot and task results from one branch. Exported for
 * the branch-activity tests; the extension has no other caller.
 */
export function collectBranchActivity(branch: unknown): {
  todos: ActivityTodoPhase[];
  tasks: Map<string, TaskActivity>;
} {
  const tasks = new Map<string, TaskActivity>();
  let todos: ActivityTodoPhase[] = [];
  if (!Array.isArray(branch)) return { todos, tasks };
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    // User todo edits are custom entries, not tool results, but they take part
    // in the same branch-ordered snapshot: an empty `phases` array clears the
    // list just like a `todo` result does.
    if (item.type === "custom") {
      if (item.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
        const data = item.data;
        const phases = normalizeTodoPhases(
          data && typeof data === "object" && !Array.isArray(data)
            ? (data as Record<string, unknown>).phases
            : undefined,
        );
        if (phases) todos = phases;
      }
      continue;
    }
    if (
      item.type !== "message" ||
      !item.message ||
      typeof item.message !== "object"
    )
      continue;
    const raw = item.message as Record<string, unknown>;
    const toolCallId = asString(raw.toolCallId) ?? asString(raw.id);
    const toolName = asString(raw.toolName) ?? asString(raw.name);
    const details = parseToolArguments(raw.details);
    const isError = raw.isError === true;
    if (toolName === "todo" && !isError) {
      const phases = normalizeTodoPhases(details?.phases);
      if (phases) todos = phases;
    }
    if (toolName === "task") {
      const activity = taskActivityFromDetails(details);
      if (activity && toolCallId) tasks.set(toolCallId, activity);
    }
  }
  return { todos, tasks };
}

function normalizeAskQuestion(value: unknown): AskQuestion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const question = asString(raw.question);
  if (!question) return undefined;
  const options: AskOption[] = [];
  if (Array.isArray(raw.options)) {
    for (const option of raw.options) {
      if (typeof option === "string") {
        if (option) options.push({ label: truncateText(option, MAX_TEXT_CHARS) });
        continue;
      }
      if (!option || typeof option !== "object" || Array.isArray(option))
        continue;
      const item = option as Record<string, unknown>;
      const label = asString(item.label);
      if (!label) continue;
      const description = asString(item.description);
      options.push({
        label: truncateText(label, MAX_TEXT_CHARS),
        ...(description
          ? { description: truncateText(description, MAX_TEXT_CHARS) }
          : {}),
      });
    }
  }
  const id = asString(raw.id);
  const header = asString(raw.header);
  const recommended =
    typeof raw.recommended === "number" &&
    Number.isInteger(raw.recommended) &&
    raw.recommended >= 0 &&
    raw.recommended < options.length
      ? raw.recommended
      : undefined;
  return {
    ...(id ? { id: truncateText(id, 256) } : {}),
    question: truncateText(question, MAX_TEXT_CHARS),
    ...(header ? { header: truncateText(header, 256) } : {}),
    options,
    multi: raw.multi === true,
    ...(recommended !== undefined ? { recommended } : {}),
  };
}

function normalizeAskQuestions(value: unknown): AskQuestion[] | undefined {
  const args = parseToolArguments(value);
  if (!args || !Array.isArray(args.questions)) return undefined;
  const questions = args.questions.flatMap((item): AskQuestion[] => {
    const question = normalizeAskQuestion(item);
    return question ? [question] : [];
  });
  return questions.length > 0 ? questions : undefined;
}

function normalizeAskAnswer(value: unknown): AskAnswer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const selectedOptions = Array.isArray(raw.selectedOptions)
    ? raw.selectedOptions
        .filter((item): item is string => typeof item === "string")
        .map((item) => truncateText(item, MAX_TEXT_CHARS))
    : [];
  const customInput = asString(raw.customInput);
  const note = asString(raw.note);
  return {
    selectedOptions,
    ...(customInput
      ? { customInput: truncateText(customInput, MAX_TEXT_CHARS) }
      : {}),
    ...(note ? { note: truncateText(note, MAX_TEXT_CHARS) } : {}),
    ...(typeof raw.timedOut === "boolean" ? { timedOut: raw.timedOut } : {}),
  };
}

function askDisplay(
  name: string,
  args: Record<string, unknown> | undefined,
  rawDetails: unknown,
  completed: boolean,
): AskDisplay | undefined {
  if (name !== "ask") return undefined;
  const details =
    rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : undefined;
  const inputQuestions = normalizeAskQuestions(args);
  const resultRows = Array.isArray(details?.results)
    ? details.results
    : details?.question !== undefined
      ? [details]
      : [];
  const resultQuestions = resultRows.flatMap((item): AskQuestion[] => {
    const question = normalizeAskQuestion(item);
    return question ? [question] : [];
  });
  let questions = inputQuestions ?? resultQuestions;
  if (!questions.length && Array.isArray(details?.questions)) {
    questions = details.questions.flatMap((question): AskQuestion[] =>
      typeof question === "string" && question
        ? [{ question: truncateText(question, MAX_TEXT_CHARS), options: [], multi: false }]
        : [],
    );
  }
  if (!questions.length) return undefined;

  const chatRedirect = details?.chatRedirect === true;
  const answers: Array<AskAnswer | null> = resultRows.length
    ? questions.map((question, index) => {
        const match = question.id
          ? resultRows.find(
              (row) =>
                !!row &&
                typeof row === "object" &&
                (row as Record<string, unknown>).id === question.id,
            )
          : undefined;
        return normalizeAskAnswer(match ?? resultRows[index]) ?? null;
      })
    : details
      ? [normalizeAskAnswer(details) ?? null]
      : [];
  const hasAnswers = answers.some((answer) => answer !== null);
  return {
    status: chatRedirect
      ? "redirected"
      : completed
        ? "completed"
        : "pending",
    questions,
    ...(!chatRedirect && hasAnswers ? { answers } : {}),
  };
}

type TranscriptOptions = {
  beforeId?: string;
  entryId?: string;
  limit?: number;
  entryIds?: readonly string[];
  full?: boolean;
  imageBudget?: number;
};

type TranscriptProjection = {
  messages: MobileMessage[];
  history: MobileHistory;
  found?: boolean;
};

function supportedImageMime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mimeType = value.toLowerCase();
  return mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif"
    ? mimeType
    : undefined;
}

function validRasterData(mimeType: string, data: string): boolean {
  if (
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  )
    return false;
  const encodedHeader = data.slice(0, 24);
  const encodedTail = data.slice(-4);
  if (
    Buffer.from(encodedHeader, "base64").toString("base64") !== encodedHeader ||
    Buffer.from(encodedTail, "base64").toString("base64") !== encodedTail
  )
    return false;
  const bytes = Buffer.from(encodedHeader, "base64");
  if (
    mimeType === "image/png" &&
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return true;
  if (
    mimeType === "image/jpeg" &&
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return true;
  if (
    mimeType === "image/gif" &&
    bytes.length >= 6 &&
    (bytes.toString("ascii", 0, 6) === "GIF87a" ||
      bytes.toString("ascii", 0, 6) === "GIF89a")
  )
    return true;
  return (
    mimeType === "image/webp" &&
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}
function normalizePromptImages(value: unknown): MobileImage[] {
  const invalid = (message: string): never => {
    throw Object.assign(new Error(message), { status: 400 });
  };
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid("prompt images must be an array");
  if (value.length > MAX_PROMPT_IMAGES)
    return invalid(`at most ${MAX_PROMPT_IMAGES} images are allowed`);
  let encodedChars = 0;
  return value.map((item): MobileImage => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return invalid("prompt image must be an object");
    const raw = item as Record<string, unknown>;
    const mimeType = supportedImageMime(raw.mimeType);
    const data = asString(raw.data);
    if (raw.type !== "image" || !mimeType || !data || "sourceId" in raw)
      return invalid("prompt image must contain raster image data");
    encodedChars += data.length;
    if (encodedChars > MAX_PROMPT_IMAGE_BASE64_CHARS)
      return invalid("prompt image data exceeds the 3 MiB encoded-data limit");
    if (!validRasterData(mimeType, data))
      return invalid(`prompt image is not valid ${mimeType} base64 data`);
    return { type: "image", mimeType, data };
  });
}

function safeToolDetails(value: unknown, includeLarge = false): unknown {
  const sanitize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sanitize);
    if (!item || typeof item !== "object") return item;
    const hidden = /(?:signature|providerpayload|providermetadata|credentialid)/i;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(item)) {
      if (!hidden.test(key)) result[key] = sanitize(nested);
    }
    return result;
  };
  const details = sanitize(value);
  if (includeLarge) return details;
  try {
    const encoded = JSON.stringify(details);
    if (encoded && encoded.length > MAX_STATE_INLINE_DETAILS_CHARS)
      return {
        omitted:
          "Large tool details are available by opening this message's full output.",
      };
  } catch {
    return { omitted: "Tool details unavailable in the compact snapshot." };
  }
  return details;
}

export function transcript(
  branch: unknown,
  taskActivity: Map<string, TaskActivity> = new Map(),
  options: TranscriptOptions = {},
): TranscriptProjection {
  const entries = Array.isArray(branch) ? branch : [];
  const toolCalls = new Map<
    string,
    { name: string; arguments?: Record<string, unknown> }
  >();
  const toolResultIds = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (
      item.type !== "message" ||
      !item.message ||
      typeof item.message !== "object"
    )
      continue;
    const raw = item.message as Record<string, unknown>;
    const role = asString(raw.role);
    const toolCallId = asString(raw.toolCallId);
    if ((role === "toolResult" || toolCallId) && toolCallId)
      toolResultIds.add(toolCallId);
    if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (!block || typeof block !== "object") continue;
        const content = block as Record<string, unknown>;
        const type = asString(content.type);
        if (
          type !== "toolCall" &&
          type !== "tool_call" &&
          type !== "tool_use"
        )
          continue;
        const id = asString(content.id) ?? asString(content.toolCallId);
        if (!id) continue;
        toolCalls.set(id, {
          name:
            asString(content.name) ??
            asString(content.toolName) ??
            asString(content.tool) ??
            "tool",
          arguments: parseToolArguments(
            content.arguments ?? content.args ?? content.input,
          ),
        });
      }
    }
    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const value = call as Record<string, unknown>;
        const id = asString(value.id);
        if (!id) continue;
        const fn =
          value.function && typeof value.function === "object"
            ? (value.function as Record<string, unknown>)
            : undefined;
        toolCalls.set(id, {
          name: asString(fn?.name) ?? asString(value.name) ?? "tool",
          arguments: parseToolArguments(
            fn?.arguments ??
              value.arguments ??
              value.args ??
              value.input,
          ),
        });
      }
    }
  }

  const visible: Array<{
    item: Record<string, unknown>;
    index: number;
    entryId: string;
    timestamp: string | null;
  }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const type = asString(item.type);
    if (!type) continue;
    const entryId = asString(item.id) ?? `entry-${index}`;
    const timestamp = asString(item.timestamp) ?? null;
    if (type === "message") {
      if (!item.message || typeof item.message !== "object") continue;
      const message = item.message as Record<string, unknown>;
      const role = asString(message.role);
      if (
        message.synthetic === true ||
        role === "developer" ||
        role === "system"
      )
        continue;
      if (
        (role === "custom" || role === "hookMessage") &&
        message.display !== true
      )
        continue;
      const content = message.content;
      const hasContent =
        typeof content === "string"
          ? content.length > 0
          : Array.isArray(content)
            ? content.length > 0
            : content !== undefined && content !== null;
      const hasToolCalls =
        Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      const hasUsage =
        !!message.usage &&
        typeof message.usage === "object" &&
        !Array.isArray(message.usage);
      if (
        role === "toolResult" ||
        message.toolCallId !== undefined ||
        role === "bashExecution" ||
        role === "pythonExecution" ||
        role === "custom" ||
        role === "hookMessage" ||
        (role === "fileMention" &&
          Array.isArray(message.files) &&
          message.files.length > 0) ||
        (role === "user" && hasContent) ||
        (role === "assistant" &&
          (hasContent ||
            hasToolCalls ||
            hasUsage ||
            (Array.isArray(message.reactions) &&
              message.reactions.length > 0) ||
            typeof message.reaction === "string" ||
            message.stopReason === "error" ||
            message.stopReason === "aborted"))
      )
        visible.push({ item, index, entryId, timestamp });
      continue;
    }
    if (type === "model_usage") {
      const errorMessage = asString(item.errorMessage);
      if (
        item.stopReason === "error" ||
        (item.stopReason === "aborted" &&
          errorMessage !== "Interrupted by user" &&
          errorMessage !== "__omp.silent_abort__")
      )
        visible.push({ item, index, entryId, timestamp });
      continue;
    }
    if (
      type === "compaction" ||
      type === "branch_summary" ||
      type === "reset_boundary"
    )
      visible.push({ item, index, entryId, timestamp });
    if (type === "custom_message" && item.display === true)
      visible.push({ item, index, entryId, timestamp });
  }

  const total = visible.length;
  let end = total;
  let start = 0;
  let found = true;
  let selected: typeof visible = [];
  if (options.entryIds !== undefined) {
    const visibleById = new Map<string, (typeof visible)[number]>();
    for (const entry of visible)
      if (!visibleById.has(entry.entryId))
        visibleById.set(entry.entryId, entry);
    found = options.entryIds.every((entryId) => visibleById.has(entryId));
    if (found)
      selected = options.entryIds.map((entryId) => visibleById.get(entryId)!);
  } else {
    if (options.entryId) {
      const index = visible.findIndex((entry) => entry.entryId === options.entryId);
      if (index < 0) {
        found = false;
        end = 0;
      } else {
        end = index + 1;
      }
    } else if (options.beforeId) {
      const index = visible.findIndex((entry) => entry.entryId === options.beforeId);
      if (index < 0) {
        found = false;
        end = 0;
      } else {
        end = index;
      }
    }
    const limit =
      options.entryId !== undefined
        ? 1
        : Math.max(1, Math.min(80, Math.floor(options.limit ?? MAX_MESSAGES)));
    start = Math.max(0, end - limit);
    selected = found ? visible.slice(start, end) : [];
  }
  const full = options.full === true;
  const imageBudget = { used: 0, max: options.imageBudget ?? 512 * 1024 };
  const contentBudget = { used: 0 };
  const omittedEntries = new Set<string>();

  function projectText(
    text: string,
    maxChars: number,
    entryId: string,
  ): string {
    if (full) return text;
    if (text.length > maxChars) omittedEntries.add(entryId);
    const content = truncateText(text, maxChars);
    const remaining = MAX_TRANSCRIPT_CONTENT_CHARS - contentBudget.used;
    if (remaining <= 0) {
      if (omittedEntries.has(entryId)) return "";
      omittedEntries.add(entryId);
      return "[Additional content omitted from snapshot; open full message]";
    }
    if (content.length <= remaining) {
      contentBudget.used += content.length;
      return content;
    }
    const marker = "\n[…snapshot limit reached; open full message]";
    const prefixLength = Math.max(0, remaining - marker.length);
    const bounded = `${content.slice(0, prefixLength)}${marker}`;
    contentBudget.used += bounded.length;
    omittedEntries.add(entryId);
    return bounded;
  }
  function projectLabel(
    text: string,
    maxChars: number,
    entryId: string,
  ): string {
    if (full) return text;
    if (text.length > maxChars) omittedEntries.add(entryId);
    return truncateText(text, maxChars);
  }
  function projectTask(
    task: TaskActivity | undefined,
    entryId: string,
  ): TaskActivity | undefined {
    if (!task || full || task.agents.length <= 4) return task;
    omittedEntries.add(entryId);
    return { ...task, agents: task.agents.slice(0, 4) };
  }

  function projectDetails(value: unknown, entryId: string): unknown {
    const details = safeToolDetails(value, full);
    if (
      !full &&
      details &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      "omitted" in details
    )
      omittedEntries.add(entryId);
    return details;
  }
  function projectMessage(
    role: string,
    entryId: string,
    timestamp: string | null,
    parts: MobilePart[],
  ): MobileMessage {
    if (!full && parts.length > MAX_PARTS_PER_MESSAGE)
      omittedEntries.add(entryId);
    return {
      role,
      entryId,
      timestamp,
      parts: full ? parts : parts.slice(0, MAX_PARTS_PER_MESSAGE),
      ...(full
        ? { full: true }
        : omittedEntries.has(entryId)
          ? { full: false }
          : {}),
    };
  }

  function imagePart(
    value: unknown,
    sourceId: string,
    label?: string,
  ): MobilePart | undefined {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Record<string, unknown>;
    const mimeType = supportedImageMime(raw.mimeType);
    const data = asString(raw.data);
    if (!mimeType || !data || !validRasterData(mimeType, data))
      return undefined;
    if (
      full ||
      (data.length <= MAX_STATE_IMAGE_BASE64_CHARS &&
        imageBudget.used + data.length <= imageBudget.max)
    ) {
      imageBudget.used += full ? 0 : data.length;
      return {
        kind: "image",
        image: { type: "image", mimeType, data },
        ...(label ? { label } : {}),
      };
    }
    omittedEntries.add(sourceId);
    return {
      kind: "image",
      image: { type: "image", mimeType, data: "", sourceId },
      label: label ?? "Image — load full message",
    };
  }

  function contentParts(
    content: unknown,
    entryId: string,
    isAssistant: boolean,
  ): MobilePart[] {
    const parts: MobilePart[] = [];
    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      if (!full && parts.length >= MAX_PARTS_PER_MESSAGE) {
        omittedEntries.add(entryId);
        break;
      }
      if (typeof block === "string") {
        if (block)
          parts.push({
            kind: "text",
            text: projectText(block, MAX_TEXT_CHARS, entryId),
          });
        continue;
      }
      if (!block || typeof block !== "object") continue;
      const value = block as Record<string, unknown>;
      const type = asString(value.type);
      if (type === "image") {
        const part = imagePart(value, entryId);
        if (part) parts.push(part);
        continue;
      }
      if (type === "redactedThinking") continue;
      const thinking =
        asString(value.thinking) ??
        asString(value.thought) ??
        asString(value.reasoning) ??
        asString(value.reasoning_content);
      if (
        type === "thinking" ||
        type === "thought" ||
        type === "reasoning" ||
        (isAssistant && thinking !== undefined)
      ) {
        const text = thinking ?? asString(value.text) ?? "";
        if (text)
          parts.push({
            kind: "thinking",
            text: projectText(text, MAX_THINKING_CHARS, entryId),
          });
        continue;
      }
      if (
        type === "toolCall" ||
        type === "tool_call" ||
        type === "tool_use"
      ) {
        const id = asString(value.id) ?? asString(value.toolCallId) ?? "";
        if (!id || toolResultIds.has(id)) continue;
        const name =
          asString(value.name) ??
          asString(value.toolName) ??
          asString(value.tool) ??
          "tool";
        const args = parseToolArguments(
          value.arguments ?? value.args ?? value.input,
        );
        const ask = askDisplay(name, args, undefined, false);
        const task = taskActivity.get(id);
        parts.push({
          kind: "tool",
          id,
          name,
          summary: formatToolCallSummary(name, args),
          ...(args ? { details: projectDetails(args, entryId) } : {}),
          ...(ask ? { ask } : {}),
          ...(task && task.agents.length > 0
            ? { task: projectTask(task, entryId) }
            : {}),
          ...(full ? { full: true } : {}),
        });
        continue;
      }
      if (type === "anthropicServerTool") {
        const name = asString(value.name) ?? "provider tool";
        parts.push({
          kind: "custom",
          title: name,
          text: "Provider-executed tool",
        });
        continue;
      }
      const text = asString(value.text) ?? asString(value.content);
      if (text) {
        parts.push({
          kind: "text",
          text: projectText(text, MAX_TEXT_CHARS, entryId),
        });
      }
    }
    return parts;
  }

  function project(entry: (typeof selected)[number]): MobileMessage | undefined {
    const { item, index, entryId, timestamp } = entry;
    const type = asString(item.type);
    const parts: MobilePart[] = [];
    let role = "notice";
    if (type === "message") {
      const raw = item.message as Record<string, unknown>;
      const rawRole = asString(raw.role) ?? "assistant";
      role = rawRole;
      if (
        rawRole === "toolResult" ||
        raw.toolCallId !== undefined
      ) {
        const toolCallId = asString(raw.toolCallId) ?? asString(raw.id) ?? "";
        const known = toolCallId ? toolCalls.get(toolCallId) : undefined;
        const name =
          asString(raw.toolName) ?? asString(raw.name) ?? known?.name ?? "tool";
        const args =
          known?.arguments ??
          parseToolArguments(raw.arguments ?? raw.args ?? raw.input);
        const detail =
          raw.details && typeof raw.details === "object"
            ? (raw.details as Record<string, unknown>)
            : undefined;
        const displayDetails =
          raw.details !== undefined && args !== undefined
            ? { arguments: args, result: raw.details }
            : raw.details ?? args;
        const ask = askDisplay(name, args, raw.details, true);
        const rawOutput = extractContentText(
          raw.content ?? raw.output ?? raw.result ?? raw.error,
        );
        const output =
          rawOutput === undefined
            ? undefined
            : projectText(rawOutput, MAX_TOOL_OUTPUT_CHARS, entryId);
        const task =
          taskActivity.get(toolCallId) ??
          taskActivityFromDetails(raw.details);
        const isError =
          raw.isError === true ||
          (raw.error !== undefined &&
            raw.error !== null &&
            raw.error !== false) ||
          detail?.error === true;
        const images = Array.isArray(raw.content)
          ? raw.content.flatMap((block, blockIndex): MobileImage[] => {
              if (!full && blockIndex >= MAX_PARTS_PER_MESSAGE) {
                omittedEntries.add(entryId);
                return [];
              }
              if (!block || typeof block !== "object") return [];
              const part = imagePart(block, entryId);
              return part?.kind === "image" ? [part.image] : [];
            })
          : [];
        parts.push({
          kind: "tool",
          id: toolCallId,
          name,
          summary: formatToolCallSummary(name, args),
          ...(output !== undefined ? { output } : {}),
          ...(ask ? { ask } : {}),
          ...(isError ? { isError: true } : {}),
          ...(task && task.agents.length > 0
            ? { task: projectTask(task, entryId) }
            : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(displayDetails !== undefined
            ? { details: projectDetails(displayDetails, entryId) }
            : {}),
          ...(full ? { full: true } : {}),
        });
        return projectMessage(role, entryId, timestamp, parts);
      }
      if (rawRole === "bashExecution" || rawRole === "pythonExecution") {
        const language = rawRole === "bashExecution" ? "bash" : "python";
        const images = Array.isArray(raw.images)
          ? raw.images.flatMap((image, imageIndex): MobileImage[] => {
              if (!full && imageIndex >= MAX_PARTS_PER_MESSAGE) {
                omittedEntries.add(entryId);
                return [];
              }
              const part = imagePart(image, entryId);
              return part?.kind === "image" ? [part.image] : [];
            })
          : [];
        parts.push({
          kind: "execution",
          language,
          code: projectText(
            (language === "bash"
              ? asString(raw.command)
              : asString(raw.code)) ?? "",
            MAX_TEXT_CHARS,
            entryId,
          ),
          output: projectText(
            asString(raw.output) ?? "",
            MAX_TOOL_OUTPUT_CHARS,
            entryId,
          ),
          ...(typeof raw.exitCode === "number"
            ? { exitCode: raw.exitCode }
            : {}),
          ...(raw.cancelled === true ? { cancelled: true } : {}),
          ...(raw.truncated === true ? { truncated: true } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(raw.meta !== undefined
            ? { details: projectDetails(raw.meta, entryId) }
            : {}),
        });
        return projectMessage(role, entryId, timestamp, parts);
      }
      if (rawRole === "fileMention") {
        const rawFiles = Array.isArray(raw.files) ? raw.files : [];
        if (!full && rawFiles.length > MAX_PARTS_PER_MESSAGE)
          omittedEntries.add(entryId);
        const files = rawFiles
          .slice(0, full ? rawFiles.length : MAX_PARTS_PER_MESSAGE)
          .flatMap((file): Array<{ path: string; text?: string }> => {
            if (!file || typeof file !== "object") return [];
            const row = file as Record<string, unknown>;
            const path = asString(row.path);
            if (!path) return [];
            const text =
              asString(row.content) ??
              (row.skippedReason === "tooLarge"
                ? "[File content omitted: too large]"
                : row.skippedReason === "binary"
                  ? "[File content omitted: binary]"
                  : undefined);
            return [
              {
                path: projectText(path, 2048, entryId),
                ...(text
                  ? { text: projectText(text, MAX_TOOL_OUTPUT_CHARS, entryId) }
                  : {}),
              },
            ];
          });
        if (files.length > 0) parts.push({ kind: "files", files });
        for (const file of rawFiles.slice(
          0,
          full ? rawFiles.length : MAX_PARTS_PER_MESSAGE,
        )) {
          if (!file || typeof file !== "object") continue;
          const row = file as Record<string, unknown>;
          if (row.image) {
            const part = imagePart(row.image, entryId);
            if (part) parts.push(part);
          }
        }
        return parts.length > 0
          ? projectMessage(role, entryId, timestamp, parts)
          : undefined;
      }
      if (rawRole === "custom" || rawRole === "hookMessage") {
        const content = raw.content;
        const text =
          typeof content === "string"
            ? content
            : extractContentText(content) ?? "";
        const customType = asString(raw.customType) ?? "Custom message";
        parts.push({
          kind: "custom",
          title: projectLabel(customType, 200, entryId),
          text: projectText(text, MAX_TEXT_CHARS, entryId),
          ...(raw.details !== undefined
            ? { details: projectDetails(raw.details, entryId) }
            : {}),
        });
        parts.push(...contentParts(content, entryId, false).filter((part) => part.kind === "image"));
        return projectMessage(role, entryId, timestamp, parts);
      }
      parts.push(...contentParts(raw.content, entryId, rawRole === "assistant"));
      if (Array.isArray(raw.tool_calls)) {
        const knownParts = new Set(
          parts.flatMap((part) => (part.kind === "tool" ? [part.id] : [])),
        );
        for (const call of raw.tool_calls) {
          if (!call || typeof call !== "object") continue;
          const value = call as Record<string, unknown>;
          const id = asString(value.id);
          if (!id || knownParts.has(id) || toolResultIds.has(id)) continue;
          const fn =
            value.function && typeof value.function === "object"
              ? (value.function as Record<string, unknown>)
              : undefined;
          const name = asString(fn?.name) ?? asString(value.name) ?? "tool";
          const args = parseToolArguments(
            fn?.arguments ?? value.arguments ?? value.args ?? value.input,
          );
          const ask = askDisplay(name, args, undefined, false);
          const task = taskActivity.get(id);
          parts.push({
            kind: "tool",
            id,
            name,
            summary: formatToolCallSummary(name, args),
            ...(args ? { details: projectDetails(args, entryId) } : {}),
            ...(ask ? { ask } : {}),
            ...(task && task.agents.length > 0
              ? { task: projectTask(task, entryId) }
              : {}),
            ...(full ? { full: true } : {}),
          });
          knownParts.add(id);
        }
      }
      if (rawRole === "assistant") {
        const stopReason = asString(raw.stopReason);
        const errorMessage = asString(raw.errorMessage);
        const errorId =
          typeof raw.errorId === "number" && Number.isFinite(raw.errorId)
            ? raw.errorId
            : 0;
        const silentAbort =
          (errorId & 0x02000000) !== 0 ||
          errorMessage === "__omp.silent_abort__";
        const userInterrupt =
          (errorId & 0x04000000) !== 0 ||
          errorMessage === "Interrupted by user";
        if (stopReason === "error") {
          const status =
            typeof raw.errorStatus === "number"
              ? ` (HTTP ${raw.errorStatus})`
              : "";
          parts.push({
            kind: "notice",
            tone: "error",
            title: "Provider error",
            body: projectText(
              `${errorMessage ?? "The provider request failed."}${status}`,
              1200,
              entryId,
            ),
          });
        } else if (
          stopReason === "aborted" &&
          !silentAbort &&
          !userInterrupt
        ) {
          parts.push({
            kind: "notice",
            tone: "warning",
            title: "Operation aborted",
            ...(errorMessage && errorMessage !== "Request was aborted"
              ? { body: projectText(errorMessage, 1200, entryId) }
              : {}),
          });
        }
        if (Array.isArray(raw.reactions)) {
          for (const reaction of raw.reactions) {
            if (typeof reaction === "string" && reaction.trim())
              parts.push({
                kind: "notice",
                tone: "info",
                title: "Reaction",
                body: projectText(reaction, 1200, entryId),
              });
          }
        } else if (typeof raw.reaction === "string" && raw.reaction.trim()) {
          parts.push({
            kind: "notice",
            tone: "info",
            title: "Reaction",
            body: projectText(raw.reaction, 1200, entryId),
          });
        }
      }
      if (parts.length === 0) return undefined;
      return projectMessage(role, entryId, timestamp, parts);
    }

    if (type === "custom_message") {
      role = "custom";
      const content = item.content;
      const text =
        typeof content === "string"
          ? content
          : extractContentText(content) ?? "";
      parts.push({
        kind: "custom",
        title: projectLabel(
          asString(item.customType) ?? "Custom message",
          200,
          entryId,
        ),
        text: projectText(text, MAX_TEXT_CHARS, entryId),
        ...(item.details !== undefined
          ? { details: projectDetails(item.details, entryId) }
          : {}),
      });
      parts.push(...contentParts(content, entryId, false).filter((part) => part.kind === "image"));
    } else if (type === "compaction" || type === "branch_summary") {
      role = "summary";
      const title =
        type === "compaction" ? "Context compacted" : "Branch summary";
      const text =
        asString(item.shortSummary) ??
        asString(item.summary) ??
        "Summary unavailable.";
      parts.push({
        kind: "summary",
        title,
        text: projectText(text, MAX_TEXT_CHARS, entryId),
        ...(typeof item.tokensBefore === "number"
          ? { tokensBefore: item.tokensBefore }
          : {}),
      });
    } else if (type === "model_usage") {
      const errorMessage = asString(item.errorMessage);
      if (item.stopReason === "error") {
        parts.push({
          kind: "notice",
          tone: "error",
          title: "Provider error",
          body: projectText(
            errorMessage ?? "The provider request failed.",
            1200,
            entryId,
          ),
        });
      } else if (
        item.stopReason === "aborted" &&
        errorMessage !== "Interrupted by user" &&
        errorMessage !== "__omp.silent_abort__"
      ) {
        parts.push({
          kind: "notice",
          tone: "warning",
          title: "Operation aborted",
          ...(errorMessage && errorMessage !== "Request was aborted"
            ? { body: projectText(errorMessage, 1200, entryId) }
            : {}),
        });
      }
    } else if (type === "reset_boundary") {
      parts.push({ kind: "notice", tone: "info", title: "Conversation reset" });
    }
    if (parts.length === 0) return undefined;
    return projectMessage(role, entryId, timestamp, parts);
  }

  const messages = selected.flatMap((entry): MobileMessage[] => {
    const message = project(entry);
    return message
      ? [{ ...message, ...(full ? { full: true } : {}) }]
      : [];
  });
  return {
    messages,
    history: {
      total,
      shown: messages.length,
      hasMore: start > 0,
    },
    ...(options.entryId !== undefined ||
    options.entryIds !== undefined ||
    options.beforeId !== undefined
      ? { found }
      : {}),
  };
}

async function readBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("request body too large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function tokenFromFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 && value.length <= 512 ? value : undefined;
  } catch {
    return undefined;
  }
}

function requestToken(request: Request): string | undefined {
  const explicit = request.headers.get("x-omp-mobile-token");
  if (explicit) return explicit;
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer "))
    return authorization.slice("Bearer ".length);
  return undefined;
}

export default function registerMobileRemote(pi: ExtensionAPI): void {
  const slot = process.env.OMP_MOBILE_SLOT;
  if (!slot || !RUNTIME_ID_RE.test(slot)) {
    pi.logger.warn(
      "OMP mobile extension disabled: OMP_MOBILE_SLOT must be a desktop runtime id (rt-…)",
    );
    return;
  }
  const interactionBridge = createInteractionBridge(pi);
  registerMobileAskTool(pi, interactionBridge);

  const stateDir =
    process.env.OMP_MOBILE_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".local/state/omp-mobile");
  const socketPath = join(stateDir, `${slot}.sock`);
  const ownerPath = `${socketPath}.owner`;
  const tokenPath =
    process.env.OMP_MOBILE_TOKEN_FILE ??
    join(process.env.HOME ?? "/tmp", ".config/zellij/ompbox-mobile.token");
  const expectedToken =
    process.env.OMP_MOBILE_IPC_TOKEN ??
    process.env.OMP_MOBILE_TOKEN ??
    tokenFromFile(tokenPath);
  const allowedOrigin = process.env.OMP_MOBILE_ORIGIN;
  let server: MobileServer | undefined;
  let pollTimer: Timer | undefined;
  const instanceId = crypto.randomUUID();
  let generationSequence = 0;
  let generation = `${instanceId}:uninitialized`;
  let sessionSignature: string | undefined;
  let snapshotRevision = 0;
  let snapshotCache:
    | { revision: number; expiresAt: number; state: MobileState }
    | undefined;
  function invalidateSnapshot(): void {
    snapshotRevision += 1;
    snapshotCache = undefined;
  }
  let pendingApprovals = new Set<string>();
  let actionTail: Promise<unknown> = Promise.resolve();
  let agentActive = false;
  let turnNumber = 0;
  let streamingMessage: unknown;
  let streamingSequence = 0;
  let completion: CompletionMarker | undefined;
  let pendingMessageSequence = 0;
  let pendingMobileMessages: Array<{
    id: string;
    text: string;
    submittedAt: number;
  }> = [];
  let ownsSocket = false;
  let stopped = false;
  /** Last model-authored tool intent, the text OMP's own loader shows. */
  let workingIntent: string | undefined;
  let workingSince: number | undefined;
  const runningTools = new Map<string, string>();
  const liveTaskDetails = new Map<string, unknown>();
  type MessageTransfer = {
    generation: string;
    entryId: string;
    encoded: string;
    byteLength: number;
    expiresAt: number;
  };
  const messageTransfers = new Map<string, MessageTransfer>();
  let messageTransferCacheBytes = 0;

  function clearMessageTransfers(): void {
    messageTransfers.clear();
    messageTransferCacheBytes = 0;
  }

  function pruneMessageTransfers(now: number): void {
    for (const [id, transfer] of messageTransfers) {
      if (transfer.expiresAt > now) continue;
      messageTransfers.delete(id);
      messageTransferCacheBytes -= transfer.byteLength;
    }
  }

  function storeMessageTransfers(
    entries: readonly {
      entryId: string;
      encoded: string;
      byteLength: number;
    }[],
  ): string[] | undefined {
    if (entries.length === 0) return [];
    if (
      entries.length > MAX_MESSAGE_TRANSFER_CACHE_ENTRIES ||
      entries.some((entry) =>
        entry.byteLength > MAX_MESSAGE_TRANSFER_CACHE_BYTES
      )
    )
      return undefined;
    const now = Date.now();
    pruneMessageTransfers(now);
    const requestedBytes = entries.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    if (
      messageTransfers.size + entries.length >
        MAX_MESSAGE_TRANSFER_CACHE_ENTRIES ||
      messageTransferCacheBytes + requestedBytes >
        MAX_MESSAGE_TRANSFER_CACHE_BYTES
    )
      return undefined;
    const transfers = entries.map((entry) => ({
      id: crypto.randomUUID(),
      ...entry,
    }));
    for (const transfer of transfers) {
      messageTransfers.set(transfer.id, {
        generation,
        entryId: transfer.entryId,
        encoded: transfer.encoded,
        byteLength: transfer.byteLength,
        expiresAt: now + MESSAGE_TRANSFER_TTL_MS,
      });
    }
    messageTransferCacheBytes += requestedBytes;
    return transfers.map((transfer) => transfer.id);
  }

  function storeMessageTransfer(
    entryId: string,
    encoded: string,
    byteLength: number,
  ): string | undefined {
    return storeMessageTransfers([{ entryId, encoded, byteLength }])?.[0];
  }
  function deleteMessageTransfer(transferId: string): void {
    const transfer = messageTransfers.get(transferId);
    if (!transfer) return;
    messageTransfers.delete(transferId);
    messageTransferCacheBytes -= transfer.byteLength;
  }

  function getMessageTransfer(
    transferId: string,
    entryId: string,
  ): MessageTransfer | undefined {
    const now = Date.now();
    pruneMessageTransfers(now);
    const transfer = messageTransfers.get(transferId);
    if (
      !transfer ||
      transfer.generation !== generation ||
      transfer.entryId !== entryId
    )
      return undefined;
    transfer.expiresAt = now + MESSAGE_TRANSFER_TTL_MS;
    return transfer;
  }
  let runtimeNoticeSequence = 0;
  let runtimeNotices: MobileNotice[] = [];
  let runtimeStatus: MobileRuntime["status"];
  let runtimeGoal: MobileRuntime["goal"];

  function addRuntimeNotice(
    tone: MobileNotice["tone"],
    title: string,
    body?: string,
  ): void {
    if (isRoutineNotice(title)) return;
    runtimeNotices.push({
      id: `${generation}:notice:${++runtimeNoticeSequence}`,
      tone,
      title: truncateText(title, 200),
      ...(body ? { body: truncateText(body, 1200) } : {}),
      timestamp: Date.now(),
    });
    if (runtimeNotices.length > 24) runtimeNotices = runtimeNotices.slice(-24);
  }

  function resetRuntimeState(): void {
    runtimeNoticeSequence = 0;
    runtimeNotices = [];
    runtimeStatus = undefined;
    runtimeGoal = undefined;
  }

  function runtimeSnapshot(now = Date.now()): MobileRuntime {
    if (
      runtimeStatus &&
      !runtimeStatus.active &&
      runtimeStatus.until !== undefined &&
      runtimeStatus.until <= now
    )
      runtimeStatus = undefined;
    return {
      notices: runtimeNotices,
      ...(runtimeStatus ? { status: runtimeStatus } : {}),
      ...(runtimeGoal ? { goal: runtimeGoal } : {}),
    };
  }

  function resetWorkingState(): void {
    workingIntent = undefined;
    workingSince = undefined;
    runningTools.clear();
    liveTaskDetails.clear();
  }

  function resetCompletion(): void {
    agentActive = false;
    turnNumber = 0;
    completion = undefined;
    streamingMessage = undefined;
    resetWorkingState();
  }

  function loggerError(message: string, error?: unknown): void {
    pi.logger.error(
      message,
      error ? { error: errorMessage(error) } : undefined,
    );
  }

  function acquireSocketOwnership(): boolean {
    const record = JSON.stringify({ pid: process.pid, instanceId });
    try {
      writeFileSync(ownerPath, `${record}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      ownsSocket = true;
      return true;
    } catch {
      let current: { pid?: unknown; instanceId?: unknown } | undefined;
      try {
        const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
        if (parsed && typeof parsed === "object")
          current = parsed as { pid?: unknown; instanceId?: unknown };
      } catch {
        // Missing or unreadable owner record: treated as a crash leftover.
      }
      if (current) {
        if (current.instanceId === instanceId || typeof current.pid !== "number")
          return false;
        try {
          process.kill(current.pid, 0);
          return false;
        } catch {
          // Owner pid is gone; the record is stale.
        }
      }
      // Claim the path. The stale unix socket inode must go first, otherwise
      // Bun.serve fails with "address in use" after a hard-killed runtime.
      for (const path of [ownerPath, socketPath]) {
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      }
      try {
        writeFileSync(ownerPath, `${record}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        ownsSocket = true;
        return true;
      } catch {
        return false;
      }
    }
  }

  function releaseSocketOwnership(): void {
    if (!ownsSocket) return;
    try {
      const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "instanceId" in parsed &&
        parsed.instanceId === instanceId
      ) {
        try {
          unlinkSync(socketPath);
        } catch {
          /* already gone */
        }
        try {
          unlinkSync(ownerPath);
        } catch {
          /* already gone */
        }
      }
    } catch {
      // Never unlink a socket whose ownership record cannot be proven.
    }
    ownsSocket = false;
  }

  function observeSession(ctx: ExtensionContext): void {
    const signature = `${ctx.sessionManager.getSessionId()}\n${ctx.sessionManager.getSessionFile() ?? ""}`;
    if (sessionSignature === signature) return;
    invalidateSnapshot();
    sessionSignature = signature;
    generationSequence += 1;
    generation = `${instanceId}:${ctx.sessionManager.getSessionId()}:${generationSequence}`;
    pendingApprovals = new Set();
    resetCompletion();
    pendingMobileMessages = [];
    resetRuntimeState();
    interactionBridge.reset();
    clearMessageTransfers();
    interactionBridge.observe(ctx);
  }

  function observeAgentStart(ctx: ExtensionContext): void {
    observeSession(ctx);
    if (agentActive) return;
    agentActive = true;
    turnNumber += 1;
    resetWorkingState();
  }

  function observeAgentEnd(ctx: ExtensionContext): void {
    observeSession(ctx);
    if (!agentActive) return;
    agentActive = false;
    streamingMessage = undefined;
    resetWorkingState();
    const completedAt = Date.now();
    completion = {
      identity: `${generation}:${turnNumber}`,
      generation,
      turn: turnNumber,
      completedAt,
    };
  }
  function editorGuard(ctx: ExtensionContext): {
    available: boolean;
    empty: boolean | null;
    reason?: string;
  } {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      return {
        available: false,
        empty: null,
        reason: "interactive terminal unavailable",
      };
    }
    try {
      const draft = ctx.ui.getEditorText();
      return { available: true, empty: draft.length === 0 };
    } catch {
      return { available: false, empty: null, reason: "dialog_busy" };
    }
  }
  function commandsForSnapshot(): MobileSlashCommand[] {
    const commands: MobileSlashCommand[] = [];
    const seen = new Set<string>();
    const append = (command: MobileSlashCommand): void => {
      if (!command.name || seen.has(command.name)) return;
      seen.add(command.name);
      commands.push(command);
    };
    for (const command of builtinCommands ?? []) append(command);
    for (const command of pi.getCommands()) {
      append({
        name: command.name,
        description: command.description,
      });
    }
    return commands;
  }


  function capabilities(
    ctx: ExtensionContext,
    editor: { available: boolean; empty: boolean | null; reason?: string },
    hasTheme: boolean,
    hasSummary: boolean,
  ): MobileCapabilities {
    const canStageCommand =
      editor.available && typeof ctx.ui.setEditorText === "function";
    return {
      prompt: true,
      abort: true,
      model: true,
      effort: true,
      move: canStageCommand,
      command: canStageCommand,
      theme: hasTheme,
      terminal: true,
      approval: false,
      summary: hasSummary,
      events: true,
      moveReason: canStageCommand ? undefined : editor.reason,
      approvalReason:
        "Approval dialogs remain owned by the terminal session; no remote approval action is exposed.",
    };
  }

  /**
   * The host exposes `AgentRegistry` from its SDK module (`pi.pi`). Access it
   * reflectively: older hosts without the export still get transcript-derived
   * subagent rows, and a missing registry can never break state.
   */
  function hostAgentRegistry(): HostAgentRegistry | undefined {
    try {
      const module = pi.pi as unknown as {
        AgentRegistry?: { global?: () => unknown };
      };
      const global = module.AgentRegistry?.global;
      if (typeof global !== "function") return undefined;
      const registry = global.call(module.AgentRegistry);
      return registry &&
        typeof (registry as HostAgentRegistry).list === "function"
        ? (registry as HostAgentRegistry)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Merge persisted task results, live tool updates, the agent registry, and
   * async jobs into one generation-scoped activity snapshot. The registry is
   * filtered through this session's main agent id so another runtime in the
   * same process can never leak subagents onto this phone.
   */
  function buildActivity(
    ctx: ExtensionContext,
    branch: unknown,
    now: number,
  ): { activity: SessionActivity; tasks: Map<string, TaskActivity> } {
    const collected = collectBranchActivity(branch);
    for (const [toolCallId, details] of liveTaskDetails) {
      const live = taskActivityFromDetails(details, collected.tasks.get(toolCallId));
      if (live) collected.tasks.set(toolCallId, live);
    }
    const agentsById = new Map<string, ActivitySubagent>();
    for (const task of collected.tasks.values()) {
      for (const agent of task.agents) {
        const previous = agentsById.get(agent.id);
        agentsById.set(
          agent.id,
          previous ? { ...previous, ...agent } : { ...agent },
        );
      }
    }

    const registry = hostAgentRegistry();
    if (registry) {
      let refs: HostAgentRef[] = [];
      try {
        refs = registry.list();
      } catch {
        refs = [];
      }
      const refsById = new Map(refs.map((ref) => [ref.id, ref]));
      const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
      const sessionId = ctx.sessionManager.getSessionId();
      const mains = refs.filter((ref) => ref.kind === "main");
      const ownMain =
        mains.find(
          (ref) =>
            (sessionFile !== null && ref.sessionFile === sessionFile) ||
            ref.session?.sessionId === sessionId,
        ) ?? (mains.length === 1 ? mains[0] : undefined);
      const allowed = new Set(agentsById.keys());
      const belongsToSession = (ref: HostAgentRef): boolean => {
        if (allowed.has(ref.id)) return true;
        const seen = new Set<string>();
        let current: HostAgentRef | undefined = ref;
        while (current?.parentId && !seen.has(current.parentId)) {
          seen.add(current.parentId);
          if (current.parentId === ownMain?.id) return true;
          if (allowed.has(current.parentId)) return true;
          current = refsById.get(current.parentId);
        }
        return false;
      };
      for (const ref of refs) {
        if (ref.kind !== "sub" || !belongsToSession(ref)) continue;
        allowed.add(ref.id);
        const base = agentsById.get(ref.id);
        const metrics = ref.history?.metrics;
        const status: ActivityAgentStatus =
          ref.status === "running"
            ? "running"
            : ref.status === "aborted"
              ? "aborted"
              : (base?.status === "failed" || base?.status === "aborted") &&
                  base
                ? base.status
                : "completed";
        const durationMs =
          status === "running"
            ? Math.max(0, now - ref.createdAt)
            : base?.durationMs ??
              metrics?.durationMs ??
              Math.max(0, ref.lastActivity - ref.createdAt);
        agentsById.set(ref.id, {
          ...(base ?? {}),
          id: ref.id,
          label: activityText(ref.displayName, 160) ?? base?.label ?? ref.id,
          status,
          activity: ref.activity ?? base?.activity,
          startedAt: base?.startedAt ?? ref.createdAt,
          updatedAt: ref.lastActivity,
          durationMs,
          ...(metrics?.tools !== undefined && base?.toolCount === undefined
            ? { toolCount: metrics.tools }
            : {}),
          ...(metrics?.requests !== undefined && base?.requests === undefined
            ? { requests: metrics.requests }
            : {}),
          ...(metrics?.tokens !== undefined && base?.tokens === undefined
            ? { tokens: metrics.tokens }
            : {}),
          ...(metrics?.cost !== undefined && base?.cost === undefined
            ? { cost: metrics.cost }
            : {}),
          ...(ref.history?.resolvedModel && !base?.model
            ? { model: ref.history.resolvedModel }
            : ref.history?.modelRole && !base?.model
              ? { model: ref.history.modelRole }
              : {}),
        });
      }
    }

    const jobs: ActivityJob[] = [];
    let snapshot: HostJobSnapshot | null | undefined;
    try {
      snapshot = ctx.getAsyncJobSnapshot() as
        | HostJobSnapshot
        | null;
    } catch {
      snapshot = undefined;
    }
    if (snapshot) {
      const seen = new Set<string>();
      for (const item of [...snapshot.running, ...snapshot.recent]) {
        if (!item || typeof item.id !== "string" || !item.id) continue;
        if (item.type === "task") {
          const agent = agentsById.get(item.id);
          if (agent) {
            if (item.status === "failed") agent.status = "failed";
            else if (item.status === "cancelled") agent.status = "aborted";
            else if (item.status === "completed" && agent.status !== "failed" && agent.status !== "aborted")
              agent.status = "completed";
            else if (item.status === "running" && agent.status === "pending")
              agent.status = "running";
            continue;
          }
        }
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const status =
          item.status === "running" ||
          item.status === "completed" ||
          item.status === "failed" ||
          item.status === "cancelled"
            ? item.status
            : undefined;
        if (!status) continue;
        jobs.push({
          id: item.id,
          type: item.type === "bash" ? "bash" : item.type === "task" ? "task" : "other",
          label: activityText(item.label, 200) ?? item.id,
          status,
          startedAt:
            typeof item.startTime === "number" && Number.isFinite(item.startTime)
              ? item.startTime
              : now,
          ...(status === "running" && Number.isFinite(item.startTime)
            ? { durationMs: Math.max(0, now - item.startTime) }
            : {}),
        });
      }
    }

    const rank: Record<ActivityAgentStatus, number> = {
      running: 0,
      pending: 1,
      failed: 2,
      aborted: 2,
      completed: 3,
    };
    // Project the merged registry/job state back onto transcript task cards so a
    // `task` row and the drawer always agree on running/completed/error.
    for (const task of collected.tasks.values()) {
      task.agents = task.agents.map(
        (agent) => agentsById.get(agent.id) ?? agent,
      );
    }
    const subagents = [...agentsById.values()]
      .sort(
        (a, b) =>
          rank[a.status] - rank[b.status] ||
          (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0),
      )
      .slice(0, ACTIVITY_AGENTS_MAX);
    jobs.sort(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        b.startedAt - a.startedAt,
    );
    const activity: SessionActivity = {
      todos: collected.todos,
      subagents,
      jobs: jobs.slice(0, ACTIVITY_JOBS_MAX),
    };
    if (agentActive) {
      if (workingIntent) activity.working = workingIntent;
      if (workingSince !== undefined) activity.since = workingSince;
      const tool = [...runningTools.values()].at(-1);
      if (tool) activity.workingTool = tool;
    }
    return { activity, tasks: collected.tasks };
  }

  function snapshot(ctx: ExtensionContext): MobileState {
    observeSession(ctx);
    const now = Date.now();
    const cached = snapshotCache;
    if (
      cached &&
      cached.revision === snapshotRevision &&
      cached.expiresAt > now
    )
      return cached.state;
    const model = ctx.models.current?.() ?? ctx.model;
    const currentModel = modelForSnapshot(model);
    const branch = ctx.sessionManager.getBranch();
    const summary = latestSummary(branch);
    const hasPendingMessages = ctx.hasPendingMessages();
    const activitySnapshot = buildActivity(ctx, branch, now);
    interactionBridge.observe(ctx);
    const interaction = interactionBridge.snapshot(ctx);
    const transcriptSnapshot = transcript(
      streamingMessage
        ? [
            ...branch,
            {
              type: "message",
              id: `stream-${generation}-${streamingSequence}`,
              message: streamingMessage,
            },
          ]
        : branch,
      activitySnapshot.tasks,
      { limit: MAX_MESSAGES },
    );
    pendingMobileMessages = pendingMobileMessages.filter(
      (message) => hasPendingMessages || now - message.submittedAt < 5000,
    );
    const pendingMessages: PendingMobileMessage[] =
      pendingMobileMessages.map((message) => ({
        id: message.id,
        text: truncateText(message.text, MAX_TEXT_CHARS),
        status: hasPendingMessages ? "queued" : "sending",
      }));
    const runtime = runtimeSnapshot(now);
    if (interaction) runtime.interaction = interaction;
    const theme = themeSnapshot(ctx);
    const editor = editorGuard(ctx);
    const state: MobileState = {
      apiVersion: 1,
      generation,
      accent: sessionAccent(ctx),
      model: currentModel,
      models: modelsForSnapshot(ctx.models.list()),
      effort: pi.getThinkingLevel?.() ?? null,
      efforts: effortsForModel(model),
      context: (() => {
        const usage = ctx.getContextUsage();
        return usage
          ? {
              tokens: usage.tokens,
              contextWindow: usage.contextWindow,
              percent: usage.percent,
            }
          : null;
      })(),
      cost: branchCost(branch),
      theme,
      commands: commandsForSnapshot(),
      messages: transcriptSnapshot.messages,
      history: transcriptSnapshot.history,
      runtime,
      capabilities: capabilities(
        ctx,
        editor,
        theme !== null,
        summary !== undefined,
      ),
      cwd: ctx.sessionManager.getCwd(),
      pendingApproval: pendingApprovals.size,
      hasPendingMessages,
      pendingMessages,
      editor,
      ...(completion ? { completion } : {}),
      agentActive,
      activity: activitySnapshot.activity,
    };
    const title = ctx.sessionManager.getSessionName();
    if (title) state.title = safeString(title);
    if (summary) state.summary = summary;
    snapshotCache = {
      revision: snapshotRevision,
      expiresAt: now + SNAPSHOT_CACHE_WINDOW_MS,
      state,
    };
    return state;
  }

  /**
   * Compact projection for sidebar presentation and completion notifications.
   * Neither caller needs the full transcript, which can exceed their response
   * byte caps on long sessions.
   */
  function statusSnapshot(ctx: ExtensionContext): {
    generation: string;
    accent: string | null;
    agentActive: boolean;
    cwd: string;
    summary?: string;
    title?: string;
    completion?: CompletionMarker;
    pendingAction?: {
      id: string;
      kind: "approval" | "ask" | "plan" | "dialog";
      title: string;
    };
  } {
    observeSession(ctx);
    interactionBridge.observe(ctx);
    const interaction = interactionBridge.snapshot(ctx);
    const title = ctx.sessionManager.getSessionName();
    const summary = latestSummary(ctx.sessionManager.getBranch());
    return {
      generation,
      accent: sessionAccent(ctx),
      agentActive,
      cwd: ctx.sessionManager.getCwd(),
      ...(summary ? { summary } : {}),
      ...(title ? { title: title.slice(0, 200) } : {}),
      ...(completion ? { completion } : {}),
      ...(interaction
        ? {
            pendingAction: {
              id: interaction.id,
              kind: interaction.kind,
              title: interaction.title,
            },
          }
        : {}),
    };
  }

  function checkGeneration(ctx: ExtensionContext, action: Action): void {
    observeSession(ctx);
    if (
      typeof action.generation !== "string" ||
      action.generation !== generation
    ) {
      throw Object.assign(new Error("session generation is stale"), {
        status: 409,
      });
    }
  }

  async function handleAction(
    ctx: ExtensionContext,
    action: Action,
  ): Promise<MobileState | MovePrepareResponse | CommandPrepareResponse> {
    checkGeneration(ctx, action);
    const type = asString(action.type);
    if (!type)
      throw Object.assign(new Error("action type is required"), {
        status: 400,
      });
    interactionBridge.observe(ctx);
    if (type === "interaction") {
      const id = asString(action.id);
      const choice = asString(action.choice);
      const feedback =
        action.feedback === undefined ? undefined : asString(action.feedback);
      const role = action.role === undefined ? undefined : asString(action.role);
      const answers =
        action.answers === undefined
          ? undefined
          : Array.isArray(action.answers)
            ? (action.answers as MobileAskSubmissionAnswer[])
            : undefined;
      if (
        !id ||
        !choice ||
        (action.feedback !== undefined && feedback === undefined) ||
        (action.answers !== undefined && answers === undefined) ||
        (action.role !== undefined && role === undefined)
      )
        throw Object.assign(new Error("interaction id and choice are required"), {
          status: 400,
        });
      const interactionAction: MobileInteractionAction = {
        type: "interaction",
        generation,
        id,
        choice,
        ...(feedback !== undefined ? { feedback } : {}),
        ...(answers !== undefined ? { answers } : {}),
        ...(role !== undefined ? { role } : {}),
      };
      if (await interactionBridge.handleAction(ctx, interactionAction))
        return snapshot(ctx);
      throw Object.assign(
        new Error("interaction is no longer available or cannot be resolved remotely"),
        { status: 409, code: "interaction_unavailable" },
      );
    }
    const pendingInteraction = interactionBridge.snapshot(ctx);
    if (
      type !== "abort" &&
      type !== "force" &&
      pendingInteraction
    ) {
      const owner =
        pendingInteraction.transport === "terminal"
          ? "the desktop terminal"
          : "the OMP dialog";
      throw Object.assign(
        new Error(
          `A ${pendingInteraction.kind} interaction is pending in ${owner}.`,
        ),
        { status: 409, code: "pending_dialog" },
      );
    }
    if (
      type !== "abort" &&
      type !== "force" &&
      pendingApprovals.size > 0
    ) {
      throw Object.assign(new Error("terminal approval dialog is pending"), {
        status: 409,
        code: "pending_dialog",
      });
    }
    switch (type) {
      case "prompt": {
        const text = asString(action.text);
        const images = normalizePromptImages(action.images);
        if (!text && images.length === 0)
          throw Object.assign(new Error("prompt text or image is required"), {
            status: 400,
          });
        pendingMobileMessages.push({
          id: `${generation}:${++pendingMessageSequence}`,
          text: text ?? "[image attachment]",
          submittedAt: Date.now(),
        });
        if (pendingMobileMessages.length > MAX_MESSAGES)
          pendingMobileMessages = pendingMobileMessages.slice(-MAX_MESSAGES);
        const content =
          images.length > 0
            ? [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...images,
              ]
            : text!;
        pi.sendUserMessage(content);
        break;
      }
      case "force": {
        const deadline = Date.now() + 1500;
        while (!ctx.hasPendingMessages() && Date.now() < deadline) {
          checkGeneration(ctx, action);
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        checkGeneration(ctx, action);
        if (!ctx.hasPendingMessages())
          throw Object.assign(new Error("no pending messages to force"), {
            status: 409,
            code: "pending_messages",
          });
        if (ctx.isIdle())
          throw Object.assign(
            new Error("session is idle; queued messages are already draining"),
            { status: 409, code: "session_idle" },
          );
        ctx.abort();
        break;
      }
      case "abort":
        ctx.abort();
        break;
      case "model": {
        const provider = asString(action.provider);
        const id = asString(action.id);
        if (!provider || !id)
          throw Object.assign(new Error("model provider and id are required"), {
            status: 400,
          });
        const model = ctx.models.resolve(`${provider}/${id}`);
        if (!model)
          throw Object.assign(
            new Error("model is not available to this session"),
            { status: 404 },
          );
        const beforeSession = ctx.sessionManager.getSessionId();
        const selected = await pi.setModel(model);
        if (beforeSession !== ctx.sessionManager.getSessionId()) {
          throw Object.assign(
            new Error("session changed while selecting model"),
            { status: 409 },
          );
        }
        if (!selected)
          throw Object.assign(new Error("model has no usable credentials"), {
            status: 409,
          });
        break;
      }
      case "effort": {
        const value = asString(action.value);
        const effort = value
          ? effortsForModel(ctx.models.current?.() ?? ctx.model).find(
              (candidate) => candidate === value,
            )
          : undefined;
        if (!effort) {
          throw Object.assign(
            new Error("effort is not supported by the active model"),
            { status: 400 },
          );
        }
        pi.setThinkingLevel(effort);
        break;
      }
      case "command": {
        const command = action.text;
        if (
          action.confirmed !== true ||
          typeof command !== "string" ||
          command.length === 0 ||
          command.length > 10_000 ||
          !command.startsWith("/") ||
          /[\u0000-\u001f\u007f-\u009f]/.test(command)
        )
          throw Object.assign(
            new Error(
              "command requires explicit confirmation and one line without controls",
            ),
            { status: 400 },
          );
        const commandName = command.match(/^\/([^\s/]+)(?:\s|$)/)?.[1];
        // The host TUI is authoritative: a `-e` extension cannot enumerate
        // every builtin of the running omp version (the local registry copy is
        // version-stale and misses newer commands), so one well-formed token is
        // always forwarded and omp itself rejects names it does not know. The
        // phone palette still lists commandsForSnapshot() as a hint only.
        if (!commandName || !/^[a-z0-9][a-z0-9_-]*$/i.test(commandName))
          throw Object.assign(new Error("slash command is not available"), {
            status: 404,
          });
        if (!ctx.isIdle())
          throw Object.assign(new Error("command requires an idle session"), {
            status: 409,
            code: "session_busy",
          });
        if (ctx.hasPendingMessages())
          throw Object.assign(
            new Error("pending messages must be resolved before running a command"),
            { status: 409, code: "pending_messages" },
          );
        const editor = editorGuard(ctx);
        if (!editor.available || typeof ctx.ui.setEditorText !== "function")
          throw Object.assign(
            new Error(editor.reason ?? "desktop composer is unavailable"),
            { status: 409, code: "composer_unavailable" },
          );
        if (!editor.empty)
          throw Object.assign(
            new Error("desktop composer has an existing draft"),
            { status: 409, code: "editor_dirty" },
          );
        checkGeneration(ctx, action);
        if (
          !ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          pendingApprovals.size > 0
        )
          throw Object.assign(
            new Error("session is no longer ready to run the command"),
            { status: 409, code: "session_changed" },
          );
        ctx.ui.setEditorText(command);
        return {
          ok: true,
          staged: true,
          generation,
          command,
        };
      }
      case "move": {
        if (action.confirmed !== true)
          throw Object.assign(
            new Error("move requires explicit confirmation"),
            { status: 400 },
          );
        const path = action.path;
        if (
          typeof path !== "string" ||
          path.length === 0 ||
          path.length > 4096 ||
          !path.startsWith("/") ||
          /[\u0000-\u001f\u007f-\u009f]/.test(path)
        )
          throw Object.assign(
            new Error(
              "move path must be an absolute directory without controls",
            ),
            { status: 400 },
          );
        if (!ctx.isIdle())
          throw Object.assign(new Error("move requires an idle session"), {
            status: 409,
            code: "session_busy",
          });
        if (ctx.hasPendingMessages())
          throw Object.assign(
            new Error("pending messages must be resolved before moving"),
            { status: 409, code: "pending_messages" },
          );
        const editor = editorGuard(ctx);
        if (!editor.available || typeof ctx.ui.setEditorText !== "function")
          throw Object.assign(
            new Error(editor.reason ?? "desktop composer is unavailable"),
            { status: 409, code: "composer_unavailable" },
          );
        if (!editor.empty)
          throw Object.assign(
            new Error("desktop composer has an existing draft"),
            { status: 409, code: "editor_dirty" },
          );
        // Re-observe immediately before the synchronous public UI mutation so a
        // session switch cannot apply a command to a stale generation.
        checkGeneration(ctx, action);
        if (
          !ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          pendingApprovals.size > 0
        )
          throw Object.assign(new Error("session is no longer ready to move"), {
            status: 409,
            code: "session_changed",
          });
        const command = `/move ${path}`;
        ctx.ui.setEditorText(command);
        return {
          ok: true,
          staged: true,
          generation,
          path,
          command,
        };
      }
      default:
        throw Object.assign(new Error(`unsupported action: ${type}`), {
          status: 400,
        });
    }
    return snapshot(ctx);
  }

  async function startServer(ctx: ExtensionContext): Promise<void> {
    if (server || stopped || !ctx.hasUI || ctx.mode !== "tui") return;
    observeSession(ctx);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    if (!acquireSocketOwnership()) {
      pi.logger.warn(
        `OMP mobile socket already owned for ${slot}; extension instance will stay private`,
      );
      return;
    }
    try {
      server = Bun.serve({
        unix: socketPath,
        fetch: async (request) => {
          try {
            const origin = request.headers.get("origin");
            if (origin && origin !== allowedOrigin)
              return json({ error: "origin rejected" }, 403);
            if (expectedToken && requestToken(request) !== expectedToken)
              return json({ error: "unauthorized" }, 401);
            observeSession(ctx);
            const url = new URL(request.url);
            if (request.method === "GET" && url.pathname === "/history") {
              const params = url.searchParams;
              const rawLimit = params.get("limit");
              const beforeId = params.get("before") ?? undefined;
              const requestedGeneration = params.get("generation");
              if (
                [...params.keys()].some(
                  (key) => !["generation", "limit", "before"].includes(key),
                ) ||
                params.getAll("generation").length !== 1 ||
                params.getAll("limit").length > 1 ||
                params.getAll("before").length > 1 ||
                typeof requestedGeneration !== "string" ||
                requestedGeneration.length === 0 ||
                requestedGeneration.length > 200 ||
                (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) ||
                (beforeId !== undefined &&
                  (beforeId.length === 0 ||
                    Buffer.byteLength(beforeId, "utf8") > MAX_STRING_BYTES))
              )
                return json({ error: "invalid history query" }, 400);
              if (requestedGeneration !== generation)
                return json(
                  { error: "session changed; refresh history", generation },
                  409,
                );
              const limit =
                rawLimit === null ? MAX_MESSAGES : Number(rawLimit);
              if (!Number.isSafeInteger(limit) || limit > MAX_MESSAGES)
                return json(
                  { error: `history limit must be between 1 and ${MAX_MESSAGES}` },
                  400,
                );
              const branch = ctx.sessionManager.getBranch();
              const tasks = buildActivity(ctx, branch, Date.now()).tasks;
              const page = transcript(branch, tasks, {
                ...(beforeId ? { beforeId } : {}),
                limit,
              });
              if (beforeId && page.found === false)
                return json({ error: "history cursor was not found" }, 404);
              return json({
                generation,
                messages: page.messages,
                history: page.history,
              });
            }
            if (request.method === "GET" && url.pathname === "/messages") {
              const params = url.searchParams;
              const rawIds = params.get("ids");
              const requestedGeneration = params.get("generation");
              if (
                [...params.keys()].some((key) => key !== "ids" && key !== "generation") ||
                params.getAll("ids").length !== 1 ||
                params.getAll("generation").length !== 1 ||
                typeof rawIds !== "string" ||
                typeof requestedGeneration !== "string" ||
                requestedGeneration.length === 0 ||
                requestedGeneration.length > 200
              )
                return json({ error: "batch message query is invalid" }, 400);
              let requestedIds: unknown;
              try {
                requestedIds = JSON.parse(rawIds);
              } catch {
                return json({ error: "batch message ids must be JSON" }, 400);
              }
              if (
                !Array.isArray(requestedIds) ||
                requestedIds.length < 1 ||
                requestedIds.length > 8
              )
                return json({ error: "batch message ids must contain 1 to 8 entries" }, 400);
              const entryIds: string[] = [];
              const seenIds = new Set<string>();
              for (const value of requestedIds) {
                if (
                  typeof value !== "string" ||
                  value.length === 0 ||
                  Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES ||
                  seenIds.has(value)
                )
                  return json({ error: "batch message ids must be unique nonempty entry ids" }, 400);
                seenIds.add(value);
                entryIds.push(value);
              }
              if (requestedGeneration !== generation)
                return json(
                  { error: "session changed; refresh messages", generation },
                  409,
                );

              const branch = ctx.sessionManager.getBranch();
              const messageEntries =
                streamingMessage === undefined
                  ? branch
                  : [
                      ...branch,
                      {
                        type: "message",
                        id: `stream-${generation}-${streamingSequence}`,
                        message: streamingMessage,
                      },
                    ];
              const tasks = buildActivity(ctx, branch, Date.now()).tasks;
              const messages: MobileMessage[] = [];
              const transferCandidates: Array<{
                entryId: string;
                encoded: string;
                byteLength: number;
                chunk: string;
                nextOffset: number;
                total: number;
              }> = [];
              const batch = transcript(messageEntries, tasks, {
                entryIds,
                full: true,
                imageBudget: 0,
              });
              if (!batch.found || batch.messages.length !== entryIds.length)
                return json({ error: "one or more messages were not found" }, 404);
              for (const message of batch.messages) {
                const entryId = message.entryId;
                const encoded = JSON.stringify(message);
                const byteLength = Buffer.byteLength(encoded, "utf8");
                if (byteLength > MAX_MESSAGE_TRANSFER_CACHE_BYTES)
                  return json(
                    {
                      error:
                        `full message ${entryId} exceeds the 32 MiB transfer limit`,
                      code: "message_too_large",
                    },
                    413,
                  );
                if (encoded.length <= FULL_MESSAGE_CHUNK_CHARS) {
                  messages.push(message);
                  continue;
                }
                let end = Math.min(encoded.length, FULL_MESSAGE_CHUNK_CHARS);
                if (
                  end < encoded.length &&
                  encoded.charCodeAt(end - 1) >= 0xd800 &&
                  encoded.charCodeAt(end - 1) <= 0xdbff
                )
                  end -= 1;
                transferCandidates.push({
                  entryId,
                  encoded,
                  byteLength,
                  chunk: encoded.slice(0, end),
                  nextOffset: end,
                  total: encoded.length,
                });
              }
              const transferIds = storeMessageTransfers(transferCandidates);
              if (!transferIds)
                return json(
                  {
                    error:
                      "batch full-message transfers exceed available cache capacity; split the batch or finish existing transfers",
                    code: "transfer_capacity",
                  },
                  413,
                );
              const transfers = transferCandidates.map((transfer, index) => ({
                entryId: transfer.entryId,
                transferId: transferIds[index]!,
                chunk: transfer.chunk,
                nextOffset: transfer.nextOffset,
                total: transfer.total,
              }));
              return json({ generation, messages, transfers });
            }
            if (request.method === "GET" && url.pathname === "/message") {
              const params = url.searchParams;
              const entryId = params.get("id");
              const rawOffset = params.get("offset");
              const transferId = params.get("transferId");
              const requestedGeneration = params.get("generation");
              const offset = rawOffset === null ? undefined : Number(rawOffset);
              if (
                [...params.keys()].some(
                  (key) =>
                    key !== "id" &&
                    key !== "offset" &&
                    key !== "transferId" &&
                    key !== "generation",
                ) ||
                params.getAll("id").length !== 1 ||
                params.getAll("generation").length !== 1 ||
                params.getAll("offset").length > 1 ||
                params.getAll("transferId").length > 1 ||
                !entryId ||
                Buffer.byteLength(entryId, "utf8") > MAX_STRING_BYTES ||
                typeof requestedGeneration !== "string" ||
                requestedGeneration.length === 0 ||
                requestedGeneration.length > 200 ||
                (rawOffset !== null && !/^(0|[1-9]\d*)$/.test(rawOffset)) ||
                (offset !== undefined && !Number.isSafeInteger(offset)) ||
                (transferId !== null &&
                  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                    transferId,
                  )) ||
                (transferId !== null && (offset === undefined || offset === 0)) ||
                (offset !== undefined && offset > 0 && transferId === null)
              )
                return json(
                  { error: "message id, offset, transfer id, or generation is invalid" },
                  400,
                );
              if (requestedGeneration !== generation)
                return json(
                  { error: "session changed; refresh message", generation },
                  409,
                );

              const chunkResponse = (
                id: string,
                encoded: string,
                chunkOffset: number,
              ): Response => {
                if (chunkOffset > encoded.length)
                  return json({ error: "message chunk offset is out of range" }, 416);
                if (
                  chunkOffset > 0 &&
                  chunkOffset < encoded.length &&
                  encoded.charCodeAt(chunkOffset - 1) >= 0xd800 &&
                  encoded.charCodeAt(chunkOffset - 1) <= 0xdbff &&
                  encoded.charCodeAt(chunkOffset) >= 0xdc00 &&
                  encoded.charCodeAt(chunkOffset) <= 0xdfff
                )
                  return json({ error: "message chunk offset splits a character" }, 400);
                let end = Math.min(encoded.length, chunkOffset + FULL_MESSAGE_CHUNK_CHARS);
                if (
                  end < encoded.length &&
                  encoded.charCodeAt(end - 1) >= 0xd800 &&
                  encoded.charCodeAt(end - 1) <= 0xdbff
                )
                  end -= 1;
                return json({
                  generation,
                  transferId: id,
                  chunk: encoded.slice(chunkOffset, end),
                  nextOffset: end < encoded.length ? end : null,
                  total: encoded.length,
                });
              };

              if (offset !== undefined && offset > 0) {
                if (transferId === null)
                  return json({ error: "transfer id is required for this offset" }, 400);
                const transfer = getMessageTransfer(transferId, entryId);
                if (!transfer)
                  return json(
                    {
                      error:
                        "full message transfer expired or does not match this session entry; restart from offset 0",
                    },
                    409,
                  );
                const response = chunkResponse(
                  transferId,
                  transfer.encoded,
                  offset,
                );
                if (
                  offset <= transfer.encoded.length &&
                  offset + FULL_MESSAGE_CHUNK_CHARS >= transfer.encoded.length
                )
                  deleteMessageTransfer(transferId);
                return response;
              }

              const branch = ctx.sessionManager.getBranch();
              const messageEntries =
                streamingMessage === undefined
                  ? branch
                  : [
                      ...branch,
                      {
                        type: "message",
                        id: `stream-${generation}-${streamingSequence}`,
                        message: streamingMessage,
                      },
                    ];
              const tasks = buildActivity(ctx, branch, Date.now()).tasks;
              const result = transcript(messageEntries, tasks, {
                entryId,
                full: true,
                imageBudget: 0,
              });
              const message = result.messages[0];
              if (!result.found || !message || message.entryId !== entryId)
                return json({ error: "message not found" }, 404);
              const encoded = JSON.stringify(message);
              const byteLength = Buffer.byteLength(encoded, "utf8");
              if (byteLength > MAX_MESSAGE_TRANSFER_CACHE_BYTES)
                return json(
                  {
                    error:
                      "full message exceeds the 32 MiB transfer limit; retrieve a smaller session entry",
                    code: "message_too_large",
                  },
                  413,
                );
              if (
                offset === undefined &&
                encoded.length <= FULL_MESSAGE_CHUNK_CHARS
              )
                return json({ generation, message });
              const newTransferId = storeMessageTransfer(
                entryId,
                encoded,
                byteLength,
              );
              if (!newTransferId)
                return json(
                  {
                    error:
                      "full-message transfer cache is occupied; finish or wait for existing transfers",
                    code: "transfer_capacity",
                  },
                  503,
                );
              const response = chunkResponse(newTransferId, encoded, 0);
              if (encoded.length <= FULL_MESSAGE_CHUNK_CHARS)
                deleteMessageTransfer(newTransferId);
              return response;
            }
            if (request.method === "GET" && url.pathname === "/state")
              return json(snapshot(ctx));
            if (request.method === "GET" && url.pathname === "/status")
              return json(statusSnapshot(ctx));
            if (request.method === "POST" && url.pathname === "/action") {
              let action: Action;
              try {
                const raw = await readBody(request);
                const parsed: unknown = JSON.parse(raw);
                if (
                  !parsed ||
                  typeof parsed !== "object" ||
                  Array.isArray(parsed)
                )
                  throw new Error("JSON object required");
                action = parsed as Action;
              } catch (error) {
                return json(
                  { error: `invalid request: ${errorMessage(error)}` },
                  400,
                );
              }
              const run = actionTail
                .catch(() => undefined)
                .then(async () => {
                  invalidateSnapshot();
                  try {
                    return await handleAction(ctx, action);
                  } finally {
                    invalidateSnapshot();
                  }
                });
              actionTail = run.catch(() => undefined);
              try {
                return json(await run);
              } catch (error) {
                const status =
                  typeof error === "object" && error && "status" in error
                    ? Number((error as { status: unknown }).status)
                    : 500;
                return json(
                  {
                    error: errorMessage(error),
                    code:
                      typeof error === "object" && error && "code" in error
                        ? (error as { code?: unknown }).code
                        : undefined,
                  },
                  status >= 400 && status <= 599 ? status : 500,
                );
              }
            }
            return json({ error: "not found" }, 404);
          } catch (error) {
            loggerError("OMP mobile socket request failed", error);
            return json({ error: "internal error" }, 500);
          }
        },
      });
      chmodSync(socketPath, 0o600);
      pollTimer = ctx.setInterval(() => observeSession(ctx), 1000);
      pi.logger.info(`OMP mobile IPC listening on ${socketPath}`);
    } catch (error) {
      server = undefined;
      releaseSocketOwnership();
      loggerError("OMP mobile socket failed to start", error);
    }
  }

  function stopServer(ctx?: ExtensionContext): void {
    stopped = true;
    if (pollTimer && ctx) ctx.clearTimer(pollTimer);
    pollTimer = undefined;
    server?.stop(true);
    server = undefined;
    releaseSocketOwnership();
  }

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    stopped = false;
    void startServer(ctx);
  });
  pi.on("session_switch", (_event, ctx) => {
    observeSession(ctx);
    pendingApprovals = new Set();
    resetCompletion();
  });
  pi.on("tool_approval_requested", (event) => {
    pendingApprovals.add(event.toolCallId);
  });
  pi.on("tool_approval_resolved", (event) => {
    pendingApprovals.delete(event.toolCallId);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    observeSession(ctx);
    runningTools.set(event.toolCallId, event.toolName);
    const intent = asString(event.intent)?.trim();
    if (intent && intent !== workingIntent) {
      workingIntent = truncateText(intent, 300);
      workingSince = Date.now();
    }
  });
  pi.on("tool_execution_update", (event, ctx) => {
    observeSession(ctx);
    if (event.toolName !== "task") return;
    const partial = parseToolArguments(event.partialResult);
    const details =
      parseToolArguments(partial?.details) ??
      (Array.isArray(partial?.progress) ? partial : undefined);
    if (details) liveTaskDetails.set(event.toolCallId, details);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    observeSession(ctx);
    runningTools.delete(event.toolCallId);
    if (event.toolName !== "task") return;
    const result = parseToolArguments(event.result);
    const details = parseToolArguments(result?.details);
    if (details) liveTaskDetails.set(event.toolCallId, details);
    else liveTaskDetails.delete(event.toolCallId);
  });
  pi.on("message_start", (event, ctx) => {
    observeSession(ctx);
    if (event.message.role === "user" && "content" in event.message) {
      const text = extractContentText(event.message.content);
      if (text !== undefined) {
        const pendingIndex = pendingMobileMessages.findIndex(
          (message) => message.text === text,
        );
        if (pendingIndex >= 0) pendingMobileMessages.splice(pendingIndex, 1);
      }
    }
    if (event.message.role === "assistant") {
      streamingSequence += 1;
      streamingMessage = event.message;
    }
  });
  pi.on("message_update", (event, ctx) => {
    observeSession(ctx);
    if (event.message.role === "assistant") streamingMessage = event.message;
  });
  pi.on("message_end", (event, ctx) => {
    observeSession(ctx);
    if (event.message.role === "assistant") streamingMessage = undefined;
  });
  pi.on("agent_start", (_event, ctx) => observeAgentStart(ctx));
  pi.on("agent_end", (event, ctx) => {
    if ("isTerminal" in event && event.isTerminal === false) return;
    if (event.willContinue || event.awaitingAsyncWork) return;
    observeAgentEnd(ctx);
  });
  pi.on("auto_retry_start", (event, ctx) => {
    observeSession(ctx);
    const detail = `Attempt ${event.attempt} of ${event.maxAttempts}: ${event.errorMessage}`;
    runtimeStatus = {
      kind: "retry",
      label: "Retrying request",
      detail: truncateText(detail, 800),
      active: true,
    };
    addRuntimeNotice("warning", "Provider request retrying", detail);
  });
  pi.on("auto_retry_end", (event, ctx) => {
    observeSession(ctx);
    const detail =
      event.finalError ??
      (event.success ? "A later attempt succeeded." : "Retry attempts ended.");
    runtimeStatus = {
      kind: "retry",
      label: event.success ? "Retry succeeded" : "Retry failed",
      detail: truncateText(detail, 800),
      until: Date.now() + 20_000,
      active: false,
    };
    if (!event.success)
      addRuntimeNotice("error", "Provider retry failed", detail);
  });
  pi.on("retry_fallback_applied", (event, ctx) => {
    observeSession(ctx);
    const detail = `${event.from} → ${event.to} (${event.role})`;
    runtimeStatus = {
      kind: "fallback",
      label: "Using fallback model",
      detail: truncateText(detail, 800),
      until: Date.now() + 30_000,
      active: false,
    };
    addRuntimeNotice("warning", "Fallback model selected", detail);
  });
  pi.on("retry_fallback_succeeded", (event, ctx) => {
    observeSession(ctx);
    const detail = `${event.model} (${event.role})`;
    runtimeStatus = {
      kind: "fallback",
      label: "Fallback request succeeded",
      detail: truncateText(detail, 800),
      until: Date.now() + 20_000,
      active: false,
    };
    addRuntimeNotice("success", "Fallback request succeeded", detail);
  });
  pi.on("auto_compaction_start", (event, ctx) => {
    observeSession(ctx);
    const detail = `${event.reason} · ${event.action}`;
    runtimeStatus = {
      kind: "compaction",
      label: "Compacting context",
      detail,
      active: true,
    };
    addRuntimeNotice("info", "Context compaction started", detail);
  });
  pi.on("auto_compaction_end", (event, ctx) => {
    observeSession(ctx);
    const detail =
      event.errorMessage ??
      (event.aborted
        ? "Compaction was aborted."
        : event.skipped
          ? "Compaction was not needed."
          : event.result
            ? "Context compaction completed."
            : "Context compaction ended.");
    runtimeStatus = {
      kind: "compaction",
      label: event.errorMessage
        ? "Compaction failed"
        : event.aborted
          ? "Compaction aborted"
          : "Context compacted",
      detail: truncateText(detail, 800),
      until: Date.now() + 20_000,
      active: false,
    };
    if (event.errorMessage)
      addRuntimeNotice("error", "Context compaction failed", detail);
  });
  pi.on("ttsr_triggered", (event, ctx) => {
    observeSession(ctx);
    addRuntimeNotice(
      "info",
      "Time-traveling rules triggered",
      `${event.rules.length} rule${event.rules.length === 1 ? "" : "s"} matched.`,
    );
  });
  pi.on("todo_reminder", (event, ctx) => {
    observeSession(ctx);
    const todos = event.todos
      .map((todo) => todo.content)
      .filter((content) => content.trim().length > 0);
    addRuntimeNotice(
      "warning",
      `Unfinished todo reminder (${event.attempt}/${event.maxAttempts})`,
      todos.join("\n"),
    );
  });
  pi.on("goal_updated", (event, ctx) => {
    observeSession(ctx);
    if (!event.goal) {
      runtimeGoal = undefined;
      addRuntimeNotice("info", "Goal cleared");
      return;
    }
    const goal = event.goal;
    const details = [
      goal.status,
      `${goal.tokensUsed.toLocaleString()} tokens used`,
      goal.tokenBudget !== undefined
        ? `${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} remaining`
        : "",
    ].filter(Boolean);
    runtimeGoal = {
      text: truncateText(goal.objective, 800),
      detail: details.join(" · "),
    };
    addRuntimeNotice("info", "Goal updated", goal.objective);
  });
  pi.on("turn_start", (_event, ctx) => observeSession(ctx));
  pi.on("turn_end", (_event, ctx) => observeSession(ctx));
  pi.on("context", (_event, ctx) => observeSession(ctx));
  pi.on("session_shutdown", (_event, ctx) => stopServer(ctx));
}
