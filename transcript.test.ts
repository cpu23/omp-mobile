import { expect, test } from "bun:test";
import { transcript } from "./extension";
import {
  isRoutineNotice,
  normalizeTranscriptParts,
  type MobilePart,
} from "./parity-types";

test("compact text advertises recoverable full content without dropping its tail", () => {
  const text = `Beginning\n${"x".repeat(300_000)}\nFull output sentinel`;
  const branch = [{ type: "message", id: "long", message: { role: "assistant", content: [{ type: "text", text }] } }];
  const compact = transcript(branch).messages[0];
  expect(compact?.full).toBe(false);
  const preview = compact?.parts.find((part) => part.kind === "text");
  expect(preview?.kind === "text" && preview.text.includes("Full output sentinel")).toBe(false);
  const restored = transcript(branch, undefined, { entryId: "long", full: true }).messages[0];
  expect(restored?.full).toBe(true);
  const content = restored?.parts.find((part) => part.kind === "text");
  expect(content?.kind === "text" ? content.text : undefined).toBe(text);
});

test("errors, visible custom notices and executions survive while hidden control input does not", () => {
  const projection = transcript([
    { type: "message", id: "error", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider rejected the request" } },
    { type: "custom_message", id: "visible", customType: "extension-result", content: "Important extension result", display: true },
    { type: "custom_message", id: "hidden", customType: "internal", content: "Hidden control payload", display: false },
    { type: "message", id: "developer", message: { role: "developer", content: "Internal system instructions" } },
    { type: "message", id: "shell", message: { role: "bashExecution", command: "printf hello", output: "hello", exitCode: 0 } },
    { type: "message", id: "tool", message: { role: "toolResult", toolName: "read", toolCallId: "read-1", content: [{ type: "text", text: "File contents" }] } },
  ]);
  expect(projection.messages.map((message) => message.entryId)).toEqual(["error", "visible", "shell", "tool"]);
  const error = projection.messages[0]?.parts.find((part) => part.kind === "notice");
  expect(error?.kind === "notice" ? error.body : undefined).toContain("Provider rejected the request");
  const result = projection.messages[1]?.parts.find((part) => part.kind === "custom");
  expect(result?.kind === "custom" ? result.text : undefined).toBe("Important extension result");
  const shell = projection.messages[2]?.parts.find((part) => part.kind === "execution");
  expect(shell?.kind === "execution" ? [shell.code, shell.output, shell.exitCode] : undefined).toEqual(["printf hello", "hello", 0]);
  const tool = projection.messages[3]?.parts.find((part) => part.kind === "tool");
  expect(tool?.kind === "tool" ? tool.output : undefined).toBe("File contents");
});

test("routine routing and thinking metadata is omitted without matching ordinary prose", () => {
  const messageText =
    "The model was served by a local proxy; thinking level changed earlier.";
  const projection = transcript([
    {
      type: "model_usage",
      id: "routing-only",
      upstreamProvider: "provider",
      upstreamModel: "model",
      serviceTier: "priority",
      role: "default",
      purpose: "background routing",
    },
    {
      type: "model_change",
      id: "model-change",
      model: "next-model",
      role: "default",
      resolvedModelIsFallback: true,
    },
    { type: "service_tier_change", id: "tier-change", serviceTier: "priority" },
    {
      type: "thinking_level_change",
      id: "thinking-change",
      thinkingLevel: "high",
    },
    {
      type: "ttsr_injection",
      id: "rules-injected",
      injectedRules: ["personal-rule"],
    },
    {
      type: "message",
      id: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: messageText }],
        provider: "provider",
        upstreamModel: "model",
        serviceTier: "priority",
        purpose: "background routing",
        usage: {
          input: 12,
          output: 3,
          cacheRead: 4,
          cacheWrite: 5,
          cost: { total: 0.01234 },
        },
      },
    },
    {
      type: "model_usage",
      id: "usage",
      upstreamProvider: "upstream-provider",
      upstreamModel: "upstream-model",
      provider: "provider",
      model: "model",
      serviceTier: "priority",
      role: "default",
      purpose: "background routing",
      usage: { input: 8, output: 2 },
    },
    {
      type: "model_usage",
      id: "failure",
      provider: "provider",
      model: "model",
      stopReason: "error",
      errorMessage: "Provider rejected the request",
    },
  ]);

  expect(projection.messages.map((message) => message.entryId)).toEqual([
    "assistant",
    "failure",
  ]);
  expect(projection.history.total).toBe(2);
  const assistant = projection.messages[0];
  expect(assistant?.parts.find((part) => part.kind === "text")).toMatchObject({
    kind: "text",
    text: messageText,
  });
  expect(assistant?.parts.some((part) => part.kind === "usage")).toBe(false);
  expect(projection.messages[1]?.parts).toContainEqual(
    expect.objectContaining({
      kind: "notice",
      title: "Provider error",
      body: "Provider rejected the request",
    }),
  );
  expect(projection.messages[1]?.parts.some((part) => part.kind === "usage")).toBe(
    false,
  );
});

test("legacy transcript normalization hides usage rows and routine notices without touching prose", () => {
  const routineTitles = [
    "Model changed",
    "Fallback model selected",
    "Service tier changed",
    "Thinking level changed",
    "Time-traveling rules injected",
    "Time-traveling rules triggered",
    "Context compaction started",
    "Session title changed",
    "Provider account pinned",
    "Session bookmark",
    "Mode changed",
  ];
  const parts: MobilePart[] = [
    {
      kind: "text",
      text: "Served by is ordinary content; thinking level changed in this sentence.",
    },
    {
      kind: "thinking",
      text: "Reasoning keeps ordinary references to served-by routing and thinking level.",
    },
    ...routineTitles.map(
      (title): MobilePart => ({
        kind: "notice",
        tone: "info",
        title,
        body: "routine metadata",
      }),
    ),
    {
      kind: "usage",
      text: "served by p/m · tier priority · role default · background routing · in 12 · cache read 3 · $0.1000",
    },
    {
      kind: "usage",
      text: "served by p/m · tier priority · role default",
    },
    {
      kind: "notice",
      tone: "error",
      title: "Provider error",
      body: "The provider request failed.",
    },
  ];

  expect(normalizeTranscriptParts(parts)).toEqual([
    parts[0],
    parts[1],
    expect.objectContaining({ kind: "tool", output: "The provider request failed.", isError: true }),
  ]);
  expect(isRoutineNotice("Model changed")).toBe(true);
  expect(isRoutineNotice("Time-traveling rules triggered")).toBe(true);
  expect(isRoutineNotice("The transcript says Model changed")).toBe(false);
});

test("custom completions use tool disclosure without losing output or changing ordinary prose", () => {
  const text = "<system-notice>\nBackground job build completed.\nBuild failed: missing dependency.\n</system-notice>";
  const details = { jobs: [{ jobId: "build-1", type: "bash", label: "bun run build" }] };
  const custom: MobilePart = { kind: "custom", title: "extension-result", text: "Important custom content" };
  const prose: MobilePart = { kind: "text", text: "The async-result message was received." };
  const normalized = normalizeTranscriptParts([
    { kind: "custom", title: "async-result", text, details },
    custom,
    prose,
  ]);
  expect(normalized[0]).toMatchObject({ kind: "tool", output: text, details });
  expect(normalized[1]).toMatchObject({ kind: "tool", output: custom.text });
  expect(normalized[2]).toEqual(prose);
});

test("compaction summaries and warning notices retain details in tool disclosures", () => {
  const normalized = normalizeTranscriptParts([
    { kind: "summary", title: "Context compacted", text: "Full summary", tokensBefore: 100000 },
    { kind: "notice", tone: "warning", title: "Retrying", body: "Provider rate limited" },
  ]);
  expect(normalized[0]).toMatchObject({ kind: "tool", output: "Full summary", details: { tokensBefore: 100000 } });
  expect(normalized[1]).toMatchObject({ kind: "tool", output: "Provider rate limited", isError: false, details: { tone: "warning" } });
});

test("housekeeping entries do not consume visible transcript history", () => {
  const projection = transcript([
    { type: "title_change", id: "title", title: "New title" },
    { type: "credential_pin", id: "pin", provider: "provider" },
    { type: "mode_change", id: "mode", mode: "plan" },
    { type: "label", id: "label", label: "Bookmark" },
    { type: "reset_boundary", id: "reset" },
    { type: "message", id: "user", message: { role: "user", content: "Visible prompt" } },
  ]);
  expect(projection.messages.map((message) => message.entryId)).toEqual(["reset", "user"]);
  expect(projection.history.total).toBe(2);
});

test("history pages recover the oldest visible messages without skipping a boundary", () => {
  const branch = Array.from({ length: 83 }, (_, index) => ({
    type: "message", id: `message-${index}`, message: { role: "user", content: `Prompt ${index}` },
  }));
  const newest = transcript(branch);
  expect(newest.messages[0]?.entryId).toBe("message-3");
  expect(newest.messages.at(-1)?.entryId).toBe("message-82");
  expect(newest.history.hasMore).toBe(true);
  const older = transcript(branch, undefined, { beforeId: "message-3" });
  expect(older.messages.map((message) => message.entryId)).toEqual(["message-0", "message-1", "message-2"]);
  expect(older.history.hasMore).toBe(false);
  const missing = transcript(branch, undefined, { beforeId: "not-in-this-branch" });
  expect(missing.found).toBe(false);
  expect(missing.messages).toEqual([]);
});
