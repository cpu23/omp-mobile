import {
  isRoutineNotice,
  type MobileMessage,
  type MobileRuntime,
} from "./parity-types";

function timestampMillis(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isoTimestamp(value: unknown): string | null {
  const timestamp = timestampMillis(value);
  if (timestamp === undefined) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function noticeMessage(notice: MobileRuntime["notices"][number]): MobileMessage {
  return {
    role: "tool",
    entryId: `runtime:notice:${notice.id}`,
    timestamp: isoTimestamp(notice.timestamp),
    parts: [
      {
        kind: "tool",
        id: `runtime-notice:${notice.id}`,
        name:
          notice.tone === "warning" ? `Warning: ${notice.title}` : notice.title,
        summary: "",
        output: notice.body ?? "",
        format: "rich",
        ...(notice.tone === "error" ? { isError: true } : {}),
        details: { ...notice },
      },
    ],
  };
}

function goalMessage(goal: NonNullable<MobileRuntime["goal"]>): MobileMessage {
  return {
    role: "tool",
    entryId: "runtime:goal",
    timestamp: null,
    parts: [
      {
        kind: "tool",
        id: "runtime-goal",
        name: "Goal",
        summary: "",
        output: goal.detail ? `${goal.text}\n${goal.detail}` : goal.text,
        format: "rich",
      },
    ],
  };
}

function statusMessage(
  status: NonNullable<MobileRuntime["status"]>,
): MobileMessage {
  return {
    role: "status",
    entryId: "runtime:status",
    timestamp: null,
    parts: [
      {
        kind: "tool",
        id: "runtime-status",
        name: status.label,
        summary: "",
        output: status.detail ?? "",
        format: "rich",
      },
    ],
  };
}

/** Projects passive runtime events into transcript tool disclosures. */
export function integrateRuntimeEvents<T extends { timestamp?: unknown }>(
  messages: T[],
  runtime: MobileRuntime | undefined,
): Array<T | MobileMessage> {
  const output: Array<T | MobileMessage> = messages.slice();
  if (!runtime) return output;

  const untimedNotices: MobileMessage[] = [];
  for (const notice of runtime.notices ?? []) {
    if (isRoutineNotice(notice.title)) continue;
    const message = noticeMessage(notice);
    const timestamp = timestampMillis(notice.timestamp);
    if (timestamp === undefined) {
      untimedNotices.push(message);
      continue;
    }

    let insertionIndex = output.length;
    for (let index = 0; index < output.length; index += 1) {
      const existingTimestamp = timestampMillis(output[index]?.timestamp);
      if (existingTimestamp !== undefined && existingTimestamp > timestamp) {
        insertionIndex = index;
        break;
      }
    }
    output.splice(insertionIndex, 0, message);
  }
  output.push(...untimedNotices);

  if (runtime.goal) output.push(goalMessage(runtime.goal));
  if (runtime.status?.active) output.push(statusMessage(runtime.status));
  return output;
}
