import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { MobileInteractionAction } from "./parity-types";
import { createInteractionBridge } from "./interactions";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

function fixture() {
  const handlers = new Map<string, Handler>();
  let sessionId = "session-a";
  let review: unknown;
  const resolved: Array<{ id: string; choice: string; input?: unknown }> = [];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: { getSessionId: () => sessionId },
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
    setSession: (next: string) => (sessionId = next),
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
  it("resolves all mobile ask answers, including multi-select and Other", async () => {
    const { bridge, context, setReview } = fixture();
    setReview(undefined);
    const wait = bridge.beginAsk(context, "call-ask", [
      {
        id: "choice",
        question: "Choose one",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      {
        id: "features",
        question: "Choose any",
        options: [{ label: "A" }, { label: "B" }],
        multi: true,
      },
    ]);
    if (!wait) throw new Error("mobile ask wait was not created");
    expect(bridge.snapshot(context)?.transport).toBe("native");
    const answers = [
      { selectedOptions: ["No"] },
      { selectedOptions: ["A"], customInput: "Add another feature" },
    ];
    expect(
      await bridge.handleAction(
        context,
        action("ask:call-ask", "answer", { answers }),
      ),
    ).toBe(true);
    expect(await wait.promise).toEqual({ kind: "answer", answers });
    expect(bridge.snapshot(context)).toBeUndefined();
    expect(
      await bridge.handleAction(
        context,
        action("ask:call-ask", "answer", { answers }),
      ),
    ).toBe(false);
  });

  it("rejects invalid ask choices without consuming the pending answer", async () => {
    const { bridge, context, setReview } = fixture();
    setReview(undefined);
    const wait = bridge.beginAsk(context, "call-single", [
      {
        id: "choice",
        question: "Choose one",
        options: [{ label: "A" }, { label: "B" }],
      },
    ]);
    if (!wait) throw new Error("mobile ask wait was not created");
    for (const answers of [
      [{ selectedOptions: ["missing"] }],
      [{ selectedOptions: ["A", "B"] }],
      [{ selectedOptions: [], customInput: "  " }],
    ]) {
      expect(
        await bridge.handleAction(
          context,
          action("ask:call-single", "answer", {
            answers: answers as MobileInteractionAction["answers"],
          }),
        ),
      ).toBe(false);
    }
    expect(bridge.snapshot(context)?.id).toBe("ask:call-single");
    const answers = [{ selectedOptions: ["A"] }];
    expect(
      await bridge.handleAction(
        context,
        action("ask:call-single", "answer", { answers }),
      ),
    ).toBe(true);
    expect((await wait.promise).kind).toBe("answer");
  });

  it("cancels mobile asks and closes them when the session becomes stale", async () => {
    const { bridge, context, setReview, setSession } = fixture();
    setReview(undefined);
    const questions = [
      {
        id: "choice",
        question: "Choose one",
        options: [{ label: "A" }],
      },
    ];
    const cancelled = bridge.beginAsk(context, "call-cancel", questions);
    if (!cancelled) throw new Error("mobile ask wait was not created");
    expect(
      await bridge.handleAction(
        context,
        action("ask:call-cancel", "cancel"),
      ),
    ).toBe(true);
    expect(await cancelled.promise).toEqual({ kind: "cancel" });

    const stale = bridge.beginAsk(context, "call-stale", questions);
    if (!stale) throw new Error("mobile ask wait was not created");
    setSession("session-b");
    bridge.observe(context);
    expect(await stale.promise).toEqual({ kind: "closed" });
    expect(
      await bridge.handleAction(
        context,
        action("ask:call-stale", "answer", {
          answers: [{ selectedOptions: ["A"] }],
        }),
      ),
    ).toBe(false);
  });

  it("keeps questions read-only until the native ask override starts", () => {
    const { bridge, context, emit, setReview } = fixture();
    setReview(undefined);
    emit("tool_execution_start", {
      toolCallId: "call-live",
      toolName: "ask",
      args: {
        questions: [
          {
            id: "choice",
            question: "Choose one",
            options: [{ label: "A" }],
          },
        ],
      },
    });
    expect(bridge.snapshot(context)?.transport).toBe("terminal");
    const wait = bridge.beginAsk(context, "call-live", [
      {
        id: "choice",
        question: "Choose one",
        options: [{ label: "A" }],
      },
    ]);
    expect(bridge.snapshot(context)?.transport).toBe("native");
    wait?.cancel();
  });
  it("does not downgrade a mobile waiter when execution-start arrives late", async () => {
    const { bridge, context, emit, setReview } = fixture();
    setReview(undefined);
    const questions = [
      {
        id: "choice",
        question: "Choose one",
        options: [{ label: "A" }],
      },
    ];
    const wait = bridge.beginAsk(context, "call-late-start", questions);
    if (!wait) throw new Error("mobile ask wait was not created");
    emit("tool_execution_start", {
      toolCallId: "call-late-start",
      toolName: "ask",
      args: { questions },
    });
    expect(bridge.snapshot(context)?.transport).toBe("native");
    const answers = [{ selectedOptions: ["A"] }];
    expect(
      await bridge.handleAction(
        context,
        action("ask:call-late-start", "answer", { answers }),
      ),
    ).toBe(true);
    expect(await wait.promise).toEqual({ kind: "answer", answers });
    emit("tool_execution_end", {
      toolCallId: "call-late-start",
      toolName: "ask",
    });
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
