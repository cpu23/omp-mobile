import type { ActivitySubagent } from "./shared";

export type MobileImage = { type: "image"; mimeType: string; data: string; sourceId?: string };
export type MobileNotice = {
  id: string;
  tone: "info" | "warning" | "error" | "success";
  title: string;
  body?: string;
  timestamp: number;
};
export type MobileAskQuestion = {
  id?: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multi: boolean;
  recommended?: number;
};
export type MobileAskAnswer = {
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
};
export type MobileAskSubmissionAnswer = Pick<
  MobileAskAnswer,
  "selectedOptions" | "customInput"
>;
export type MobileInteraction = {
  id: string;
  kind: "approval" | "ask" | "plan" | "dialog";
  title: string;
  body?: string;
  toolCallId?: string;
  options?: Array<{ id: string; label: string; disabled?: boolean }>;
  tiers?: Array<{ role: string; provider?: string; model?: string; label?: string }>;
  questions?: MobileAskQuestion[];
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
  answers?: MobileAskSubmissionAnswer[];
  role?: string;
};

const ROUTINE_NOTICE_TITLES: Record<string, true> = {
  "Model changed": true,
  "Fallback model selected": true,
  "Service tier changed": true,
  "Thinking level changed": true,
  "Time-traveling rules injected": true,
  "Time-traveling rules triggered": true,
};

/** Exact structured notice titles that are routine transcript/runtime metadata. */
export function isRoutineNotice(title: string): boolean {
  return ROUTINE_NOTICE_TITLES[title] === true;
}

function usageMetricStart(text: string, start: number, end: number): boolean {
  if (
    (text.startsWith("in ", start) && /\p{N}/u.test(text[start + 3] ?? "")) ||
    (text.startsWith("out ", start) && /\p{N}/u.test(text[start + 4] ?? "")) ||
    (text.startsWith("cache read ", start) &&
      /\p{N}/u.test(text[start + 11] ?? "")) ||
    (text.startsWith("cache write ", start) &&
      /\p{N}/u.test(text[start + 12] ?? ""))
  )
    return true;
  return /^\$-?\d+\.\d{4}$/.test(text.slice(start, end));
}

function visibleUsageText(text: string): string | undefined {
  let start = 0;
  while (start < text.length) {
    const separator = text.indexOf(" · ", start);
    const end = separator < 0 ? text.length : separator;
    if (usageMetricStart(text, start, end))
      return start === 0 ? text : text.slice(start);
    if (separator < 0) break;
    start = separator + 3;
  }
  return undefined;
}

/** Removes old structured routing notices/usage labels without inspecting prose. */
export function normalizeTranscriptParts(parts: MobilePart[]): MobilePart[] {
  let normalized: MobilePart[] | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part.kind === "notice" && isRoutineNotice(part.title)) {
      normalized ??= parts.slice(0, index);
      continue;
    }
    if (part.kind === "usage") {
      const text = visibleUsageText(part.text);
      if (text === undefined) {
        normalized ??= parts.slice(0, index);
        continue;
      }
      if (text !== part.text) {
        normalized ??= parts.slice(0, index);
        normalized.push({ ...part, text });
        continue;
      }
    }
    normalized?.push(part);
  }
  return normalized ?? parts;
}
