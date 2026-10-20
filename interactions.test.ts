import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { MobileInteractionAction } from "./parity-types";
import { createInteractionBridge } from "./interactions";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

function fixture() {
  const handlers = new Map<string, Handler>();
  let review: unknown;
  const resolved: Array<{ id: string; choice: string; input?: unknown }> = [];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: { getSessionId: () => "session-a" },
    getPendingPlanReview: () => review,
    resolvePlanReview: (id: string, choice: string, input?: unknown) => {
      resolved.push({ id, choice, input });
      return true;
    },
  } as unknown as ExtensionContext;
  const bridge = createInteractionBridge(pi);
  const request = {
    type: "plan_review_requested",
    reviewId: "review-a",
    sessionId: "session-a",
    title: "Plan",
    planFilePath: "PLAN.md",
    planContent: "Plan contents",
    options: [
      { id: "execute", label: "Execute", disabled: false },
      { id: "refine", label: "Refine", disabled: false },
      { id: "keep", label: "Keep", disabled: true },
    ],
    tiers: [{ role: "fast", provider: "provider", model: "model" }],
  };
  review = request;
  handlers.get("plan_review_requested")?.(request, context);
  return {
    bridge,
    context,
    resolved,
    setReview: (next: unknown) => (review = next),
    emit: (event: string, payload: unknown) =>
      handlers.get(event)?.(payload, context),
  };
}

function action(
  id: string,
  choice: string,
  extra: Partial<MobileInteractionAction> = {},
): MobileInteractionAction {
  return {
    type: "interaction",
    generation: "generation-a",
    id,
    choice,
    ...extra,
  };
}

describe("mobile plan interactions", () => {
  it("rejects stale ids and disabled choices without resolving a review", async () => {
    const { bridge, context, resolved } = fixture();
    expect(await bridge.handleAction(context, action("stale-review", "execute"))).toBe(false);
    expect(await bridge.handleAction(context, action("review-a", "keep"))).toBe(false);
    expect(resolved).toEqual([]);
  });

  it("requires refinement feedback and accepts a valid current choice once", async () => {
    const { bridge, context, resolved } = fixture();
    expect(await bridge.handleAction(context, action("review-a", "refine"))).toBe(false);
    expect(
      await bridge.handleAction(context, action("review-a", "refine", { feedback: "Clarify the migration." })),
    ).toBe(true);
    expect(await bridge.handleAction(context, action("review-a", "execute"))).toBe(false);
    expect(resolved).toEqual([
      {
        id: "review-a",
        choice: "refine",
        input: { feedback: "Clarify the migration." },
      },
    ]);
  });

  it("bounds oversized plan content and disables choices until full inspection", async () => {
    const { bridge, context, resolved, setReview } = fixture();
    setReview({
      reviewId: "review-a",
      sessionId: "session-a",
      title: "Plan",
      planFilePath: "PLAN.md",
      planContent: "🚀".repeat(400_000),
      options: [{ id: "execute", label: "Execute", disabled: false }],
      tiers: [],
    });
    const first = bridge.snapshot(context);
    const second = bridge.snapshot(context);
    expect(new TextEncoder().encode(first?.body ?? "").byteLength).toBeLessThanOrEqual(
      1_048_576,
    );
    expect(first?.body).toContain("native choices are disabled");
    expect(first?.options?.[0]?.disabled).toBe(true);
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(await bridge.handleAction(context, action("review-a", "execute"))).toBe(false);
    expect(resolved).toEqual([]);
  });

  it("captures approval arguments before tool execution starts", () => {
    const { bridge, context, emit, setReview } = fixture();
    setReview(undefined);
    emit("tool_call", {
      toolCallId: "call-a",
      toolName: "bash",
      input: { command: "echo safe" },
    });
    emit("tool_approval_requested", {
      sessionId: "session-a",
      toolCallId: "call-a",
      toolName: "bash",
      reason: "policy",
      approvalMode: "prompt",
    });
    const interaction = bridge.snapshot(context);
    expect(interaction?.kind).toBe("approval");
    expect(interaction?.body).toContain('"command": "echo safe"');
    expect(interaction?.transport).toBe("terminal");
  });

  it("keeps an ask pending after its tool approval resolves", () => {
    const { bridge, context, emit, setReview } = fixture();
    setReview(undefined);
    emit("tool_execution_start", {
      toolCallId: "call-a",
      toolName: "ask",
      args: {
        questions: [
          {
            question: "Continue?",
            options: [{ label: "Yes" }],
          },
        ],
      },
    });
    emit("tool_approval_requested", {
      sessionId: "session-a",
      toolCallId: "call-a",
      toolName: "ask",
      approvalMode: "prompt",
    });
    expect(bridge.snapshot(context)?.kind).toBe("approval");
    emit("tool_approval_resolved", {
      sessionId: "session-a",
      toolCallId: "call-a",
      toolName: "ask",
      approved: true,
    });
    expect(bridge.snapshot(context)?.kind).toBe("ask");
    emit("tool_execution_end", { toolCallId: "call-a", toolName: "ask" });
    expect(bridge.snapshot(context)).toBeUndefined();
  });
  it("rejects unknown tiers and roles for non-approval choices", async () => {
    const { bridge, context, resolved } = fixture();
    expect(
      await bridge.handleAction(context, action("review-a", "execute", { role: "missing" })),
    ).toBe(false);
    expect(
      await bridge.handleAction(context, action("review-a", "refine", { feedback: "More detail", role: "fast" })),
    ).toBe(false);
    expect(resolved).toEqual([]);
  });
});
