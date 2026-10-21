import { describe, expect, it } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { InteractionBridge, MobileAskWaitResult } from "./interactions";
import type { MobileAskAnswer } from "./parity-types";
import { registerMobileAskTool } from "./ask-tool";

type Question = {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi?: boolean;
};
type AskExecute = (
  toolCallId: string,
  params: { questions: Question[] },
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  context: ExtensionContext,
) => Promise<AgentToolResult<unknown>>;
type RegisteredAskTool = { execute: AskExecute };
type AskWait = {
  promise: Promise<MobileAskWaitResult>;
  cancel(): void;
};

function isRegisteredAskTool(value: unknown): value is RegisteredAskTool {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

const questions: Question[] = [
  {
    id: "style",
    question: "Which style?",
    options: [{ label: "Standard" }, { label: "Compact" }],
  },
];

function makeFixture(
  invokeNative: (
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<AgentToolResult<unknown>>,
  askQuestions: Question[] = questions,
) {
  let resolveWait!: (result: MobileAskWaitResult) => void;
  let cancelCount = 0;
  let abortCount = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const waitPromise = new Promise<MobileAskWaitResult>((resolve) => {
    resolveWait = resolve;
  });
  const wait: AskWait = {
    promise: waitPromise,
    cancel: () => {
      cancelCount++;
      resolveWait({ kind: "closed" });
    },
  };
  const interactions = {
    beginAsk: () => {
      resolveReady();
      return wait;
    },
  } as unknown as InteractionBridge;

  let registered: unknown;
  const Type = {
    Object: () => ({}),
    Array: () => ({}),
    String: () => ({}),
    Optional: (schema: unknown) => schema,
    Boolean: () => ({}),
    Number: () => ({}),
  };
  const pi = {
    typebox: { Type },
    registerTool: (tool: unknown) => {
      registered = tool;
    },
  } as unknown as ExtensionAPI;
  registerMobileAskTool(pi, interactions);
  if (!isRegisteredAskTool(registered))
    throw new Error("ask override was not registered");
  const execute = registered.execute;
  const context = {
    invokeTool: invokeNative,
    abort: () => {
      abortCount++;
    },
  } as unknown as ExtensionContext;
  return {
    execute: () =>
      execute("call-mobile", { questions: askQuestions }, undefined, undefined, context),
    resolveWait,
    get cancelCount() {
      return cancelCount;
    },
    get abortCount() {
      return abortCount;
    },
  };
}

describe("mobile ask tool delegation", () => {
  it("returns the native desktop result unchanged when it wins", async () => {
    let resolveNative!: (result: AgentToolResult<unknown>) => void;
    const nativeResult = {
      content: [{ type: "text" as const, text: "Desktop answer" }],
      details: { native: true },
    };
    const nativePromise = new Promise<AgentToolResult<unknown>>((resolve) => {
      resolveNative = resolve;
    });
    const fixture = makeFixture(() => nativePromise);
    const execution = fixture.execute();
    await fixture.ready;
    resolveNative(nativeResult);
    expect(await execution).toBe(nativeResult);
    expect(fixture.cancelCount).toBe(1);
    expect(fixture.abortCount).toBe(0);
  });

  it("returns Other custom text while aborting the native dialog", async () => {
    let nativeSignal: AbortSignal | undefined;
    const nativeAbortError = new Error("native dialog aborted");
    const fixture = makeFixture((_params, options) => {
      nativeSignal = options?.signal;
      return new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
        nativeSignal?.addEventListener(
          "abort",
          () => reject(nativeAbortError),
          { once: true },
        );
      });
    });
    const execution = fixture.execute();
    await fixture.ready;
    const answers: MobileAskAnswer[] = [
      { selectedOptions: [], customInput: "A custom detail" },
    ];
    fixture.resolveWait({ kind: "answer", answers });
    const result = await execution;
    expect(result.details).toEqual({
      question: "Which style?",
      options: ["Standard", "Compact"],
      multi: false,
      selectedOptions: [],
      customInput: "A custom detail",
      note: undefined,
      timedOut: undefined,
    });
    expect(nativeSignal?.aborted).toBe(true);
    expect(fixture.cancelCount).toBe(1);
  });

  it("returns answers for multiple questions and multi-select Other", async () => {
    let nativeSignal: AbortSignal | undefined;
    const nativeAbortError = new Error("native dialog aborted");
    const multipleQuestions: Question[] = [
      {
        id: "style",
        question: "Which style?",
        options: [{ label: "Standard" }, { label: "Compact" }],
      },
      {
        id: "extras",
        question: "Which extras?",
        options: [{ label: "A" }, { label: "B" }],
        multi: true,
      },
    ];
    const fixture = makeFixture(
      (_params, options) => {
        nativeSignal = options?.signal;
        return new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
          nativeSignal?.addEventListener(
            "abort",
            () => reject(nativeAbortError),
            { once: true },
          );
        });
      },
      multipleQuestions,
    );
    const execution = fixture.execute();
    await fixture.ready;
    const answers: MobileAskAnswer[] = [
      { selectedOptions: ["Compact"] },
      { selectedOptions: ["A"], customInput: "Bespoke" },
    ];
    fixture.resolveWait({ kind: "answer", answers });
    const result = await execution;
    expect(result.details).toEqual({
      results: [
        {
          id: "style",
          question: "Which style?",
          options: ["Standard", "Compact"],
          multi: false,
          selectedOptions: ["Compact"],
          customInput: undefined,
          note: undefined,
          timedOut: undefined,
        },
        {
          id: "extras",
          question: "Which extras?",
          options: ["A", "B"],
          multi: true,
          selectedOptions: ["A"],
          customInput: "Bespoke",
          note: undefined,
          timedOut: undefined,
        },
      ],
    });
    expect(nativeSignal?.aborted).toBe(true);
  });

  it("aborts the native dialog and propagates cancellation", async () => {
    const nativeAbortError = new Error("native ask cancelled");
    let nativeSignal: AbortSignal | undefined;
    const fixture = makeFixture((_params, options) => {
      nativeSignal = options?.signal;
      return new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
        nativeSignal?.addEventListener(
          "abort",
          () => reject(nativeAbortError),
          { once: true },
        );
      });
    });
    const execution = fixture.execute();
    await fixture.ready;
    fixture.resolveWait({ kind: "cancel" });
    let caught: unknown;
    try {
      await execution;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(nativeAbortError);
    expect(nativeSignal?.aborted).toBe(true);
    expect(fixture.abortCount).toBe(1);
  });
});
