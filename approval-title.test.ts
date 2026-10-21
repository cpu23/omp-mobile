import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createInteractionBridge } from "./interactions";
import { normaliseState } from "./server";

test("long tool names keep pending approvals visible through the gateway", () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  const context = { sessionManager: { getSessionId: () => "approval-session" } } as unknown as ExtensionContext;
  const bridge = createInteractionBridge(pi);
  handlers.get("tool_approval_requested")!({ toolCallId: "approval-a", sessionId: "approval-session", toolName: "x".repeat(256) }, context);
  const interaction = bridge.snapshot(context);
  expect(interaction?.kind).toBe("approval");
  const state = normaliseState({ generation: "g", runtime: { notices: [], interaction } });
  expect(state?.runtime?.interaction?.id).toBe(interaction!.id);
  expect(state?.runtime?.interaction?.title.startsWith("Approval required: ")).toBe(true);
});
