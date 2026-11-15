import type {
  MobileHistory,
  MobileImage,
  MobileInteractionAction,
  MobileRuntime,
} from "./parity-types";

export const API_VERSION = 1 as const;

/**
 * Live runtime identity minted by the omp-desktop daemon (`rt-<uuid>`).
 *
 * Ids are opaque and dynamic: discovery comes from the daemon's runtime list
 * (or the IPC sockets a runtime's extension owns), never from a fixed table.
 * The shape is validated wherever an id crosses a process boundary (URLs,
 * socket filenames, notification payloads) so a stale or hostile id can never
 * be used to build a path or address another session.
 */
export const RUNTIME_ID_RE = /^rt-[A-Za-z0-9-]{1,64}$/;
export type SlotId = string;

export function isSlotId(value: unknown): value is SlotId {
  return typeof value === "string" && RUNTIME_ID_RE.test(value);
}

export type SlotSummary = {
  /** Desktop runtime id, verbatim. */
  id: SlotId;
  title: string;
  summary?: string;
  accent?: string;
  cwd: string;
  status: string;
  connected: boolean;
  /** Absolute transcript path the runtime is writing, when the daemon knows it. */
  sessionFile?: string | null;
};

/** A transcript in omp's on-disk session store, as listed by the desktop daemon. */
export type SessionSummary = {
  id: string;
  path: string;
  cwd: string;
  title: string;
  updatedAt: string;
  costUsd: number;
};

export type SessionsResponse = { sessions: SessionSummary[] };
export type SlotsResponse = { slots: SlotSummary[] };
export type SlotResponse = { slot: SlotSummary };
export type CreateSlotRequest = { cwd?: string; resume?: string };

export type OmpMessage = {
  id?: string;
  role?: string;
  type?: string;
  content?: unknown;
  timestamp?: string | null;
  [key: string]: unknown;
};
export type SlashCommand = {
  name: string;
  aliases?: string[];
  description?: string;
};


export type CapabilityMap = {
  prompt?: boolean;
  abort?: boolean;
  model?: boolean;
  effort?: boolean;
  move?: boolean;
  command?: boolean;
  terminal?: boolean;
  reconnect?: boolean;
  [key: string]: boolean | string | undefined;
};

export type CompletionMarker = {
  identity: string;
  generation?: string;
  turn?: number;
  completedAt: number;
};

export type ExtensionStatus = {
  generation: string;
  accent: string | null;
  agentActive: boolean;
  cwd: string;
  title?: string;
  summary?: string;
  completion?: CompletionMarker;
  pendingAction?: {
    id: string;
    kind: "approval" | "ask" | "plan" | "dialog";
    title: string;
  };
};

/**
 * Live activity projected from the host's public extension surface: the
 * descriptive tool-call intent that drives OMP's "Working…" loader, the
 * session todo list, detached/blocking subagents, and async background jobs.
 *
 * Everything here is scoped to one runtime and one generation. The extension
 * projects it from the current session branch and agent registry, sharing only
 * a short bounded snapshot window, so switching sessions cannot leak activity.
 */
export type ActivityTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "blocked";

export type ActivityTodo = {
  content: string;
  status: ActivityTodoStatus;
  blocker?: string;
};

export type ActivityTodoPhase = {
  name: string;
  tasks: ActivityTodo[];
};

/** Host task-progress status, including queued (`pending`) spawns. */
export type ActivityAgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type ActivitySubagent = {
  id: string;
  /** Registry display name when known, otherwise the task id. */
  label?: string;
  /** Agent type such as `task` or `scout`. */
  agent?: string;
  status: ActivityAgentStatus;
  /** Explicit spawn description (`name`/description), the desktop row title. */
  description?: string;
  /** The assignment text shown by desktop's task rows. */
  task?: string;
  /** Latest activity gist or tool intent. */
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
  /** Terminal error (failed/aborted rows). */
  error?: string;
  /** Retry or rate-limit note, when the host reports one. */
  note?: string;
  /** True for detached background spawns. */
  detached?: boolean;
};

export type ActivityJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ActivityJob = {
  id: string;
  type: "bash" | "task" | "other";
  label: string;
  status: ActivityJobStatus;
  startedAt: number;
  durationMs?: number;
};

export type SessionActivity = {
  /** Descriptive current intent from the host's tool-call event. */
  working?: string;
  /** Tool currently executing, when the host reported one. */
  workingTool?: string;
  /** When the current working intent started, epoch ms. */
  since?: number;
  todos: ActivityTodoPhase[];
  subagents: ActivitySubagent[];
  jobs: ActivityJob[];
};

export type SlotState = {
  apiVersion: typeof API_VERSION;
  generation: string;
  cwd?: string;
  model: unknown;
  models: unknown[];
  effort: unknown;
  efforts: unknown[];
  context: unknown;
  theme: unknown;
  accent?: string;
  cost?: { total: number };
  commands: SlashCommand[];
  messages: OmpMessage[];
  capabilities: CapabilityMap;
  title?: string;
  summary?: string;
  pendingApproval?: number;
  hasPendingMessages?: boolean;
  pendingMessages?: PendingMessage[];
  editor?: { available: boolean; empty: boolean | null };
  completion?: CompletionMarker;
  agentActive?: boolean;
  activity?: SessionActivity;
  runtime?: MobileRuntime;
  history?: MobileHistory;
  connected?: boolean;
  error?: string;
};

export type TerminalWriteAction = {
  generation: string;
  type: "write";
  text: string;
  confirmed: true;
  interactionId?: string;
};
export type TerminalSnapshot = {
  apiVersion: typeof API_VERSION;
  generation: string;
  paneId: string;
  tabId?: number;
  screen: string;
  capabilities: {
    read: true;
    write: boolean;
    resize: false;
    focus: false;
    [key: string]: boolean;
  };
};

export type PendingMessage = {
  id: string;
  text: string;
  status: "sending" | "queued";
};
export type PromptAction = {
  generation: string;
  type: "prompt";
  text: string;
  images?: MobileImage[];
};
export type AbortAction = { generation: string; type: "abort" };
export type ForceAction = { generation: string; type: "force" };
export type ModelAction = {
  generation: string;
  type: "model";
  provider: string;
  id: string;
};
export type EffortAction = {
  generation: string;
  type: "effort";
  value: string;
};
export type CommandAction = {
  generation: string;
  type: "command";
  text: string;
  confirmed: true;
};
export type MoveAction = {
  generation: string;
  type: "move";
  path: string;
  confirmed: true;
};
export type MoveResponse = {
  ok: true;
  submitted: true;
  generation: string;
  path: string;
  command: string;
};
export type CommandResponse = {
  ok: true;
  submitted: true;
  generation: string;
  command: string;
};
export type SlotAction =
  | PromptAction
  | AbortAction
  | ForceAction
  | ModelAction
  | EffortAction
  | CommandAction
  | MoveAction
  | MobileInteractionAction;


export type DirectoryEntry = {
  name: string;
  path: string;
  kind?: "directory" | "file" | "other";
};
export type DirectoryListing = {
  path: string;
  root: string;
  parent: string;
  entries: DirectoryEntry[];
};
export type PinsResponse = { pins: string[] };
