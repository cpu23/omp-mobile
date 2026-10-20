import type { ActivitySubagent } from "./shared";

export type MobileImage = { type: "image"; mimeType: string; data: string; sourceId?: string };
export type MobileNotice = {
  id: string;
  tone: "info" | "warning" | "error" | "success";
  title: string;
  body?: string;
  timestamp: number;
};
export type MobileInteraction = {
  id: string;
  kind: "approval" | "ask" | "plan" | "dialog";
  title: string;
  body?: string;
  toolCallId?: string;
  options?: Array<{ id: string; label: string; disabled?: boolean }>;
  tiers?: Array<{ role: string; provider?: string; model?: string; label?: string }>;
  questions?: unknown[];
  transport: "native" | "terminal";
  createdAt: number;
};
export type MobileRuntime = {
  notices: MobileNotice[];
  interaction?: MobileInteraction;
  status?: { kind: "retry" | "compaction" | "fallback" | "working"; label: string; detail?: string; until?: number; active: boolean };
  goal?: { text: string; detail?: string };
  queue?: Array<{ text: string; kind?: string }>;
};
export type MobileHistory = { total: number; shown: number; hasMore: boolean };
export type MobileAskDisplay = {
  status: "pending" | "completed" | "redirected";
  questions: Array<{ id?: string; question: string; header?: string; options: Array<{ label: string; description?: string }>; multi: boolean; recommended?: number }>;
  answers?: Array<{ selectedOptions: string[]; customInput?: string; note?: string; timedOut?: boolean } | null>;
};
export type MobilePart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; output?: string; isError?: boolean; ask?: MobileAskDisplay; task?: { agents: ActivitySubagent[]; asyncState?: string }; images?: MobileImage[]; details?: unknown; full?: boolean }
  | { kind: "image"; image: MobileImage; label?: string }
  | { kind: "notice"; tone: MobileNotice["tone"]; title: string; body?: string }
  | { kind: "summary"; title: string; text: string; tokensBefore?: number }
  | { kind: "custom"; title: string; text: string; details?: unknown }
  | { kind: "execution"; language: "bash" | "python" | "js"; code: string; output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; images?: MobileImage[]; details?: unknown }
  | { kind: "files"; files: Array<{ path: string; text?: string }> }
  | { kind: "usage"; text: string };
export type MobileMessage = { role: string; entryId: string; timestamp: string | null; parts: MobilePart[]; full?: boolean };
export type MobileInteractionAction = {
  generation: string;
  type: "interaction";
  id: string;
  choice: string;
  feedback?: string;
  role?: string;
};
