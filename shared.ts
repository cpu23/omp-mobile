export const API_VERSION = 1 as const;

export const SLOT_IDS = [
  "left",
  "right",
  "w2-left",
  "w2-right",
  "w3-left",
  "w3-right",
] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export type SlotSummary = {
  id: SlotId;
  title: string;
  summary?: string;
  accent?: string;
  cwd: string;
  status: string;
  connected: boolean;
};

export type OmpMessage = {
  id?: string;
  role?: string;
  type?: string;
  content?: unknown;
  timestamp?: string;
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
  editor?: { available: boolean; empty: boolean | null };
  completion?: CompletionMarker;
  agentActive?: boolean;
  connected?: boolean;
  error?: string;
};

export type TerminalWriteAction = {
  generation: string;
  type: "write";
  text: string;
  confirmed: true;
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

export type PromptAction = { generation: string; type: "prompt"; text: string };
export type AbortAction = { generation: string; type: "abort" };
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
  | ModelAction
  | EffortAction
  | CommandAction
  | MoveAction;

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
