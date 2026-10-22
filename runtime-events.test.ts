import { expect, test } from "bun:test";
import type { MobileMessage, MobileRuntime } from "./parity-types";
import { integrateRuntimeEvents } from "./runtime-events";

function toolPart(message: MobileMessage) {
  const part = message.parts[0];
  if (part?.kind !== "tool") throw new Error("expected a tool disclosure");
  return part;
}

test("runtime notices are inserted by timestamp without reordering transcript messages", () => {
  const messages = [
    { entryId: "before", timestamp: "2026-01-01T00:00:01.000Z" },
    { entryId: "middle", timestamp: "2026-01-01T00:00:03.000Z" },
    { entryId: "after", timestamp: "2026-01-01T00:00:05.000Z" },
  ];
  const runtime: MobileRuntime = {
    notices: [
      {
        id: "late",
        tone: "info",
        title: "Later",
        timestamp: Date.parse("2026-01-01T00:00:04.000Z"),
      },
      {
        id: "early",
        tone: "info",
        title: "Earlier",
        timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
      },
    ],
  };

  const result = integrateRuntimeEvents(messages, runtime);
  expect(result.map((message) => message.entryId)).toEqual([
    "before",
    "runtime:notice:early",
    "middle",
    "runtime:notice:late",
    "after",
  ]);
  expect(integrateRuntimeEvents(messages, runtime).map((message) => message.entryId)).toEqual(
    result.map((message) => message.entryId),
  );
  expect(result.filter((message) => !message.entryId.startsWith("runtime:"))).toEqual(messages);
  expect(result[0]).toBe(messages[0]);
  expect(messages.map((message) => message.entryId)).toEqual(["before", "middle", "after"]);
});

test("notice disclosures preserve errors, visible warnings, and unknown metadata", () => {
  const runtime: MobileRuntime = {
    notices: [
      { id: "routine", tone: "info", title: "Context compaction started", timestamp: 1 },
      { id: "warning", tone: "warning", title: "Provider is slow", timestamp: 2, body: "Retrying" },
      { id: "error", tone: "error", title: "Provider failed", timestamp: 3, body: "Unavailable" },
      {
        id: "extension",
        tone: "success",
        title: "Extension event",
        timestamp: 4,
        customMetadata: { source: "extension", sequence: 7 },
      } as MobileRuntime["notices"][number],
    ],
  };

  const result = integrateRuntimeEvents([], runtime) as MobileMessage[];
  expect(result.map((message) => message.entryId)).toEqual([
    "runtime:notice:warning",
    "runtime:notice:error",
    "runtime:notice:extension",
  ]);
  expect(toolPart(result[0]!)).toMatchObject({
    name: "Warning: Provider is slow",
    summary: "",
    output: "Retrying",
    format: "rich",
  });
  expect(toolPart(result[0]!).isError).toBeUndefined();
  expect(result[0]?.timestamp).toBe("1970-01-01T00:00:00.002Z");
  expect(toolPart(result[1]!)).toMatchObject({
    name: "Provider failed",
    summary: "",
    output: "Unavailable",
    format: "rich",
    isError: true,
  });
  expect(toolPart(result[2]!)).toMatchObject({ output: "", format: "rich" });
  expect(toolPart(result[2]!).details).toMatchObject({
    customMetadata: { source: "extension", sequence: 7 },
  });
});

test("equal and missing timestamps are stable and never change original message order", () => {
  const messages = [
    { entryId: "same-a", timestamp: "2026-01-01T00:00:05.000Z" },
    { entryId: "same-b", timestamp: "2026-01-01T00:00:05.000Z" },
    { entryId: "untimed", timestamp: null },
    { entryId: "later", timestamp: "2026-01-01T00:00:10.000Z" },
    { entryId: "invalid", timestamp: "not-a-date" },
  ];
  const runtime = {
    notices: [
      {
        id: "equal-a",
        tone: "info",
        title: "First equal",
        timestamp: Date.parse("2026-01-01T00:00:05.000Z"),
      },
      {
        id: "equal-b",
        tone: "info",
        title: "Second equal",
        timestamp: Date.parse("2026-01-01T00:00:05.000Z"),
      },
      { id: "null-time", tone: "info", title: "No host time", timestamp: null },
      { id: "invalid-time", tone: "info", title: "Invalid host time", timestamp: Number.NaN },
    ],
  } as unknown as MobileRuntime;

  const result = integrateRuntimeEvents(messages, runtime);
  expect(result.map((message) => message.entryId)).toEqual([
    "same-a",
    "same-b",
    "untimed",
    "runtime:notice:equal-a",
    "runtime:notice:equal-b",
    "later",
    "invalid",
    "runtime:notice:null-time",
    "runtime:notice:invalid-time",
  ]);
  expect(
    result.filter((message) => !message.entryId.startsWith("runtime:")),
  ).toEqual(messages);
  expect(result[7]?.timestamp).toBeNull();
  expect(result[8]?.timestamp).toBeNull();
});

test("goal and active status retain detail while interactions and completed statuses stay interactive-only", () => {
  const runtime: MobileRuntime = {
    notices: [],
    goal: { text: "Finish the task", detail: "Run checks and report failures." },
    status: {
      kind: "working",
      label: "Working",
      detail: "Reading the repository",
      active: true,
    },
    interaction: {
      id: "approval-1",
      kind: "approval",
      title: "Approve command",
      transport: "native",
      createdAt: 1,
    },
  };

  const result = integrateRuntimeEvents([], runtime) as MobileMessage[];
  expect(result.map((message) => [message.role, message.entryId])).toEqual([
    ["tool", "runtime:goal"],
    ["status", "runtime:status"],
  ]);
  expect(toolPart(result[0]!)).toMatchObject({
    name: "Goal",
    summary: "",
    output: "Finish the task\nRun checks and report failures.",
    format: "rich",
  });
  expect(toolPart(result[1]!)).toMatchObject({
    name: "Working",
    summary: "",
    output: "Reading the repository",
    format: "rich",
  });
  expect(result.every((message) => message.entryId !== "approval-1")).toBe(true);
  const activeWithoutDetail = integrateRuntimeEvents([], {
    notices: [],
    status: { kind: "fallback", label: "Fallback", active: true },
  }) as MobileMessage[];
  expect(toolPart(activeWithoutDetail[0]!)).toMatchObject({
    name: "Fallback",
    output: "",
  });


  const completed = integrateRuntimeEvents([], {
    notices: [],
    status: { kind: "working", label: "Working", active: false },
  });
  expect(completed).toEqual([]);
});
