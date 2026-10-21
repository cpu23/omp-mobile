import { expect, test } from "bun:test";
import { transcript } from "./extension";

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
