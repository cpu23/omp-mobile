import {
  askToolRenderer,
  type AgentToolResult,
  type AskToolDetails,
  type ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";
import type { MobileAskAnswer } from "./parity-types";
import type { InteractionBridge } from "./interactions";

type AskQuestionInput = {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi?: boolean;
  recommended?: number;
};
type AskResult = AgentToolResult<AskToolDetails>;
type AskAnswerResult = {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
};
function formatMultiline(label: string, text: string): string {
  return text.includes("\n")
    ? `${label}:\n${text
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`
    : `${label}: ${text}`;
}

function formatAskResult(result: AskAnswerResult): string {
  const custom =
    result.customInput === undefined ? undefined : `"${result.customInput}"`;
  if (result.selectedOptions.length === 0) {
    if (custom !== undefined) return `${result.id}: ${custom}`;
    return result.multi ? `${result.id}: []` : `${result.id}: (cancelled)`;
  }
  const selected = result.multi
    ? `[${result.selectedOptions.join(", ")}]`
    : result.selectedOptions[0];
  return `${result.id}: ${custom === undefined ? selected : `${selected} + ${custom}`}`;
}

function formatSingleAnswer(answer: MobileAskAnswer, multi: boolean): string {
  const responseParts: string[] = [];
  if (answer.selectedOptions.length > 0) {
    const selectedText = multi
      ? `User selected: ${answer.selectedOptions.join(", ")}`
      : `User selected: ${answer.selectedOptions[0]}`;
    responseParts.push(selectedText);
  }
  if (answer.customInput !== undefined)
    responseParts.push(formatMultiline("User provided custom input", answer.customInput));
  if (responseParts.length > 0) return responseParts.join("\n");
  return multi ? "User did not select any options" : "User cancelled the selection";
}

export function mobileAskResult(
  questions: AskQuestionInput[],
  answers: MobileAskAnswer[],
): AskResult {
  const results: AskAnswerResult[] = questions.map((question, index) => {
    const answer = answers[index]!;
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: question.multi === true,
      selectedOptions: answer.selectedOptions,
      customInput: answer.customInput,
      note: undefined,
      timedOut: undefined,
    };
  });
  if (results.length === 1) {
    const result = results[0]!;
    return {
      content: [
        {
          type: "text",
          text: formatSingleAnswer(answers[0]!, result.multi),
        },
      ],
      details: {
        question: result.question,
        options: result.options,
        multi: result.multi,
        selectedOptions: result.selectedOptions,
        customInput: result.customInput,
        note: result.note,
        timedOut: result.timedOut,
      },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `User answers:\n${results.map(formatAskResult).join("\n")}`,
      },
    ],
    details: { results },
  };
}

export function registerMobileAskTool(
  pi: ExtensionAPI,
  interactions: InteractionBridge,
): void {
  const Type = pi.typebox.Type;
  const parameters = Type.Object({
    questions: Type.Array(
      Type.Object({
        id: Type.String(),
        question: Type.String(),
        header: Type.Optional(Type.String()),
        options: Type.Array(
          Type.Object({
            label: Type.String(),
            description: Type.Optional(Type.String()),
            preview: Type.Optional(Type.String()),
          }),
        ),
        multi: Type.Optional(Type.Boolean()),
        recommended: Type.Optional(Type.Number()),
      }),
      { minItems: 1 },
    ),
  });

  let askQueue = Promise.resolve();
  const serializeAsk = async <T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = askQueue;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    askQueue = previous.then(() => turn);
    await previous;
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  };

  pi.registerTool({
    ...askToolRenderer,
    name: "ask",
    label: "Ask",
    description:
      "Ask only for materially different tradeoffs the user must decide. Default: act using code/config/docs/history and conventions. Several viable choices: pick conservative/standard, proceed, state choice.\n\n<instruction>\n- Batch related questions; 2–5 distinct options each; short labels, tradeoffs in `description`.\n- `recommended` auto-adds \" (Recommended)\"; `multi: true` permits multiple selections.\n- NEVER supply \"Other\": UI adds \"Other (type your own)\". Clarifying custom input? Answer first; re-ask unresolved questions.\n</instruction>",
    parameters,
    async execute(toolCallId, params, signal, onUpdate, rawContext) {
      return serializeAsk(signal, async () => {
        const context = rawContext;
        const invokeTool = context.invokeTool;
        if (typeof invokeTool !== "function")
          throw new Error("Native AskTool delegation is unavailable");
        const delegatedAbort = new AbortController();
        const delegatedSignal = signal
          ? AbortSignal.any([signal, delegatedAbort.signal])
          : delegatedAbort.signal;
        const nativeResult = invokeTool<AskToolDetails>(params, {
          signal: delegatedSignal,
          onUpdate,
        }).then(
          (result) => ({ kind: "native" as const, result }),
          (error: unknown) => ({ kind: "native-error" as const, error }),
        );
        const mobileWait = interactions.beginAsk(
          context,
          toolCallId,
          params.questions,
        );
        if (!mobileWait) {
          const result = await nativeResult;
          if (result.kind === "native-error") throw result.error;
          return result.result;
        }

        try {
          const winner = await Promise.race([
            nativeResult,
            mobileWait.promise.then((result) => ({ kind: "mobile" as const, result })),
          ]);
          if (winner.kind === "native") return winner.result;
          if (winner.kind === "native-error") throw winner.error;
          if (winner.result.kind === "answer") {
            delegatedAbort.abort();
            await nativeResult;
            return mobileAskResult(params.questions, winner.result.answers);
          }
          delegatedAbort.abort();
          if (winner.result.kind === "cancel") {
            context.abort();
            const cancelledNative = await nativeResult;
            if (cancelledNative.kind === "native-error") throw cancelledNative.error;
            throw new Error("Ask was cancelled from mobile");
          }
          if (signal?.aborted) {
            const cancelledNative = await nativeResult;
            if (cancelledNative.kind === "native-error") throw cancelledNative.error;
            return cancelledNative.result;
          }
          await nativeResult;
          throw new Error("Ask is no longer available in this session");
        } finally {
          mobileWait.cancel();
        }
      });
    },
  });
}
