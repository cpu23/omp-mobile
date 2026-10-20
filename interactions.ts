import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
  MobileAskAnswer,
  MobileAskQuestion,
  MobileInteraction,
  MobileInteractionAction,
} from "./parity-types";
import { validateAskAnswers } from "./ask-selection";

type PlanChoice = "execute" | "compact" | "keep" | "refine" | "save";
type PlanReview = {
  reviewId: string;
  sessionId: string;
  title: string;
  planContent: string;
  options: Array<{ id: PlanChoice; label: string; disabled: boolean }>;
  tiers?: Array<{ role: string; provider: string; model: string }>;
};
type PlanContext = ExtensionContext & {
  getPendingPlanReview?: () => unknown;
  resolvePlanReview?: (
    reviewId: string,
    choice: PlanChoice,
    input?: { feedback?: string; role?: string },
  ) => boolean;
};
type InteractionEvents = {
  on(
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => void,
  ): void;
};
type PendingEntry = {
  interaction: MobileInteraction;
  sessionId: string;
  sequence: number;
};
export type MobileAskWaitResult =
  | { kind: "answer"; answers: MobileAskAnswer[] }
  | { kind: "cancel" }
  | { kind: "closed" };
type AskWaiter = {
  toolCallId: string;
  interactionId: string;
  sessionId: string;
  questions: MobileAskQuestion[];
  promise: Promise<MobileAskWaitResult>;
  resolve: (result: MobileAskWaitResult) => void;
  settled: boolean;
};
export type MobileAskWait = {
  promise: Promise<MobileAskWaitResult>;
  cancel(): void;
};
export interface InteractionBridge {
  observe(ctx: ExtensionContext): void;
  reset(): void;
  beginAsk(
    ctx: ExtensionContext,
    toolCallId: string,
    questions: unknown,
  ): MobileAskWait | undefined;
  snapshot(ctx: ExtensionContext): MobileInteraction | undefined;
  handleAction(
    ctx: ExtensionContext,
    action: MobileInteractionAction,
  ): Promise<boolean>;
}

const PLAN_CHOICES: Record<PlanChoice, true> = {
  execute: true,
  compact: true,
  keep: true,
  refine: true,
  save: true,
};
const TERMINAL_OWNERSHIP =
  "Use the live terminal controls to answer; no native answer API is available.";

const MAX_PLAN_BODY_BYTES = 1_048_576;
const MAX_INTERACTION_TITLE_CHARS = 256;
const MAX_OPTION_LABEL_CHARS = 512;
const MAX_PLAN_OPTIONS = 16;
const MAX_PLAN_TIERS = 32;
const MAX_TERMINAL_BODY_CHARS = 16_000;
const MAX_TOOL_DETAILS_CHARS = 12_000;
const MAX_ASK_DETAILS_CHARS = 64_000;
const MAX_ASK_FIELD_CHARS = 4_096;
const MAX_ASK_QUESTIONS = 16;
const MAX_ASK_OPTIONS = 32;
const TRUNCATED = "…[truncated]";
const PLAN_TRUNCATION =
  "\n\n[Mobile plan review is truncated; native choices are disabled. Inspect the full plan and options in the live OMP terminal before deciding.]";
const PLAN_INCOMPLETE_NOTICE =
  "The mobile review is incomplete; native choices are disabled. Inspect the full review in the live OMP terminal.";
const DETAILS_TRUNCATION =
  "\n\n[Details truncated for mobile; inspect the full request in the live OMP terminal.]";

function limitText(
  value: string,
  maxChars: number,
  marker = TRUNCATED,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  const suffix = marker.slice(0, maxChars);
  let end = Math.max(0, maxChars - suffix.length);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: value.slice(0, end) + suffix, truncated: true };
}

function limitUtf8Text(
  value: string,
  maxBytes: number,
  marker: string,
): { text: string; truncated: boolean } {
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  let index = 0;
  let usedBytes = 0;
  let safeEnd = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    const pairedSurrogate =
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff;
    const width = pairedSurrogate ? 2 : 1;
    const bytes = pairedSurrogate
      ? 4
      : code <= 0x7f
        ? 1
        : code <= 0x7ff
          ? 2
          : 3;
    if (usedBytes + bytes > maxBytes) break;
    usedBytes += bytes;
    index += width;
    if (usedBytes + markerBytes <= maxBytes) safeEnd = index;
  }
  if (index === value.length) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, safeEnd)}${marker}`,
    truncated: true,
  };
}

function parseAskQuestions(
  value: unknown,
): { questions: MobileAskQuestion[]; truncated: boolean } | undefined {
  if (!Array.isArray(value)) return undefined;
  let remaining = MAX_ASK_DETAILS_CHARS;
  let truncated = value.length > MAX_ASK_QUESTIONS;
  const takeText = (text: string): string => {
    const result = limitText(
      text,
      Math.min(MAX_ASK_FIELD_CHARS, remaining),
    );
    remaining -= result.text.length;
    truncated ||= result.truncated;
    return result.text;
  };
  const questions = value.slice(0, MAX_ASK_QUESTIONS).flatMap((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      truncated = true;
      return [];
    }
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.question !== "string") {
      truncated = true;
      return [];
    }
    const question = takeText(raw.question);
    if (!question) return [];
    const id = typeof raw.id === "string" ? takeText(raw.id) : undefined;
    const header =
      typeof raw.header === "string" ? takeText(raw.header) : undefined;
    const options = Array.isArray(raw.options) ? raw.options : [];
    if (!Array.isArray(raw.options)) truncated = true;
    if (options.length > MAX_ASK_OPTIONS) truncated = true;
    const safeOptions: MobileAskQuestion["options"] = options
      .slice(0, MAX_ASK_OPTIONS)
      .flatMap((option) => {
        if (
          typeof option !== "object" ||
          option === null ||
          Array.isArray(option)
        ) {
          truncated = true;
          return [];
        }
        const rawOption = option as Record<string, unknown>;
        if (typeof rawOption.label !== "string") {
          truncated = true;
          return [];
        }
        const label = takeText(rawOption.label);
        const description =
          typeof rawOption.description === "string"
            ? takeText(rawOption.description)
            : undefined;
        return [
          {
            label,
            ...(description !== undefined ? { description } : {}),
          },
        ];
      });
    return [
      {
        ...(id ? { id } : {}),
        question,
        ...(header ? { header } : {}),
        options: safeOptions,
        multi: raw.multi === true,
        ...(typeof raw.recommended === "number" &&
        Number.isFinite(raw.recommended)
          ? { recommended: raw.recommended }
          : {}),
      },
    ];
  });
  return { questions, truncated };
}


function formatDetails(value: unknown): string {
  try {
    const formatted =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return limitText(
      formatted ?? String(value),
      MAX_TOOL_DETAILS_CHARS,
      "\n\n[Tool arguments truncated; inspect the full request in the live terminal.]",
    ).text;
  } catch {
    return "Tool arguments could not be serialized; inspect the full request in the live terminal.";
  }
}

function parsePlanReview(value: unknown): PlanReview | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const reviewId = typeof raw.reviewId === "string" ? raw.reviewId : undefined;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
  const title = typeof raw.title === "string" ? raw.title : undefined;
  const planContent =
    typeof raw.planContent === "string" ? raw.planContent : undefined;
  if (!reviewId || !sessionId || title === undefined || planContent === undefined)
    return undefined;
  if (!Array.isArray(raw.options)) return undefined;
  const options = raw.options.flatMap((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    )
      return [];
    const option = candidate as Record<string, unknown>;
    const id = typeof option.id === "string" ? option.id : undefined;
    const label = typeof option.label === "string" ? option.label : undefined;
    if (!id || !PLAN_CHOICES[id as PlanChoice] || label === undefined)
      return [];
    return [{ id: id as PlanChoice, label, disabled: option.disabled === true }];
  });
  if (options.length !== raw.options.length) return undefined;
  const tiers = Array.isArray(raw.tiers)
    ? raw.tiers.flatMap((candidate) => {
        if (
          typeof candidate !== "object" ||
          candidate === null ||
          Array.isArray(candidate)
        )
          return [];
        const tier = candidate as Record<string, unknown>;
        const role = typeof tier.role === "string" ? tier.role : undefined;
        const provider =
          typeof tier.provider === "string" ? tier.provider : undefined;
        const model = typeof tier.model === "string" ? tier.model : undefined;
        return role && provider && model ? [{ role, provider, model }] : [];
      })
    : undefined;
  return {
    reviewId,
    sessionId,
    title,
    planContent,
    options,
    ...(tiers && tiers.length > 0 ? { tiers } : {}),
  };
}

function planInteraction(review: PlanReview): MobileInteraction {
  const warnings: string[] = [];
  let metadataTruncated = false;
  if (review.options.length > MAX_PLAN_OPTIONS) {
    metadataTruncated = true;
    warnings.push("Some plan options are omitted; inspect all options in the live terminal.");
  }
  const displayedOptions = review.options
    .slice(0, MAX_PLAN_OPTIONS)
    .map((option) => {
      const label = limitText(option.label, MAX_OPTION_LABEL_CHARS);
      if (label.truncated) {
        metadataTruncated = true;
        warnings.push("Some option labels are shortened for mobile.");
      }
      return { ...option, label: label.text };
    });
  const tiers = review.tiers?.slice(0, MAX_PLAN_TIERS).flatMap((tier) => {
    if (tier.role.length > MAX_INTERACTION_TITLE_CHARS) {
      metadataTruncated = true;
      warnings.push("A long execution role is omitted; inspect tiers in the live terminal.");
      return [];
    }
    const provider = limitText(tier.provider, MAX_OPTION_LABEL_CHARS);
    const model = limitText(tier.model, MAX_OPTION_LABEL_CHARS);
    if (provider.truncated || model.truncated) {
      metadataTruncated = true;
      warnings.push("Some tier labels are shortened for mobile.");
    }
    return [
      {
        ...tier,
        label: `${provider.text}/${model.text}`,
      },
    ];
  });
  if ((review.tiers?.length ?? 0) > MAX_PLAN_TIERS) {
    metadataTruncated = true;
    warnings.push("Some execution tiers are omitted; inspect all tiers in the live terminal.");
  }
  const plan = limitUtf8Text(
    review.planContent,
    MAX_PLAN_BODY_BYTES,
    PLAN_TRUNCATION,
  );
  const title = limitText(review.title, MAX_INTERACTION_TITLE_CHARS);
  if (title.truncated) {
    metadataTruncated = true;
    warnings.push("The plan title is shortened for mobile.");
  }
  let incomplete = metadataTruncated || plan.truncated;
  const bodyText = [
    plan.text,
    ...new Set(warnings),
    ...(incomplete ? [PLAN_INCOMPLETE_NOTICE] : []),
  ]
    .filter(Boolean)
    .join("\n\n");
  const body = limitUtf8Text(bodyText, MAX_PLAN_BODY_BYTES, PLAN_TRUNCATION);
  incomplete ||= body.truncated;
  return {
    id: review.reviewId,
    kind: "plan",
    title: title.text,
    body: body.text,
    options: displayedOptions.map((option) => ({
      ...option,
      disabled: option.disabled || incomplete,
    })),
    ...(tiers && tiers.length > 0 ? { tiers } : {}),
    transport: "native",
    createdAt: Date.now(),
  };
}

function toolCallId(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event))
    return undefined;
  const id = (event as Record<string, unknown>).toolCallId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Observe public interaction events. Plan reviews use their native resolver;
 * mobile asks race their native AskTool against a bridge-owned answer promise.
 */
export function createInteractionBridge(pi: ExtensionAPI): InteractionBridge {
  const pending = new Map<string, PendingEntry>();
  const callArguments = new Map<string, { name: string; args: unknown }>();
  const resolvedPlanIds = new Set<string>();
  const askWaiters = new Map<string, AskWaiter>();
  const askCallIds = new Set<string>();
  let activeSessionId: string | undefined;
  let sequence = 0;

  const settleAsk = (waiter: AskWaiter, result: MobileAskWaitResult) => {
    if (waiter.settled) return;
    waiter.settled = true;
    if (askWaiters.get(waiter.toolCallId) === waiter)
      askWaiters.delete(waiter.toolCallId);
    waiter.resolve(result);
  };
  const closeAskInteractions = (toolCallId: string) => {
    for (const [key, entry] of pending) {
      if (entry.interaction.toolCallId === toolCallId) pending.delete(key);
    }
  };
  const closeAllAskWaiters = () => {
    for (const waiter of askWaiters.values())
      settleAsk(waiter, { kind: "closed" });
  };

  const clear = () => {
    closeAllAskWaiters();
    pending.clear();
    callArguments.clear();
    askCallIds.clear();
    resolvedPlanIds.clear();
    activeSessionId = undefined;
    sequence = 0;
  };

  const observe = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (activeSessionId !== undefined && sessionId !== activeSessionId) {
      closeAllAskWaiters();
      pending.clear();
      callArguments.clear();
      askCallIds.clear();
      resolvedPlanIds.clear();
      sequence = 0;
    }
    activeSessionId = sessionId;
  };

  const removeByCallId = (id: string) => {
    const waiter = askWaiters.get(id);
    if (waiter) settleAsk(waiter, { kind: "closed" });
    closeAskInteractions(id);
    callArguments.delete(id);
    askCallIds.delete(id);
  };

  const putPending = (
    key: string,
    sessionId: string,
    interaction: MobileInteraction,
  ) => {
    const previous = pending.get(key);
    pending.set(key, {
      interaction: previous
        ? { ...interaction, createdAt: previous.interaction.createdAt }
        : interaction,
      sessionId,
      sequence: previous?.sequence ?? ++sequence,
    });
  };

  const beginAsk = (
    ctx: ExtensionContext,
    toolCallId: string,
    rawQuestions: unknown,
  ): MobileAskWait | undefined => {
    observe(ctx);
    const sessionId = activeSessionId;
    const parsed = parseAskQuestions(rawQuestions);
    if (
      !sessionId ||
      !parsed ||
      parsed.questions.length === 0 ||
      parsed.truncated
    )
      return undefined;
    askCallIds.add(toolCallId);
    const existing = askWaiters.get(toolCallId);
    if (existing && existing.sessionId === sessionId) {
      return {
        promise: existing.promise,
        cancel: () => {
          settleAsk(existing, { kind: "closed" });
          closeAskInteractions(toolCallId);
        },
      };
    }
    const interactionId = `ask:${toolCallId}`;
    putPending(interactionId, sessionId, {
      id: interactionId,
      kind: "ask",
      title: "Input required",
      toolCallId,
      questions: parsed.questions,
      transport: "native",
      createdAt: Date.now(),
    });
    let resolve!: (result: MobileAskWaitResult) => void;
    const promise = new Promise<MobileAskWaitResult>((settle) => {
      resolve = settle;
    });
    const waiter: AskWaiter = {
      toolCallId,
      interactionId,
      sessionId,
      questions: parsed.questions,
      promise,
      resolve,
      settled: false,
    };
    askWaiters.set(toolCallId, waiter);
    return {
      promise,
      cancel: () => {
        settleAsk(waiter, { kind: "closed" });
        closeAskInteractions(toolCallId);
      },
    };
  };

  const putPlan = (ctx: ExtensionContext, value: unknown) => {
    observe(ctx);
    const review = parsePlanReview(value);
    if (!review || review.sessionId !== activeSessionId) return;
    if (resolvedPlanIds.has(review.reviewId)) return;
    for (const [key, entry] of pending) {
      if (entry.interaction.kind === "plan" && key !== `plan:${review.reviewId}`)
        pending.delete(key);
    }
    putPending(`plan:${review.reviewId}`, review.sessionId, planInteraction(review));
  };

  const clearTerminalInteractions = () => {
    for (const [key, entry] of pending) {
      if (entry.interaction.transport === "terminal") pending.delete(key);
    }
    callArguments.clear();
    askCallIds.clear();
  };

  const events = pi as unknown as InteractionEvents;
  events.on("tool_call", (rawEvent, ctx) => {
    observe(ctx);
    if (
      typeof rawEvent !== "object" ||
      rawEvent === null ||
      Array.isArray(rawEvent)
    )
      return;
    const event = rawEvent as Record<string, unknown>;
    const id = toolCallId(event);
    const name = typeof event.toolName === "string" ? event.toolName : undefined;
    if (!id || !name) return;
    callArguments.set(id, { name, args: event.input });
  });

  events.on("tool_execution_start", (rawEvent, ctx) => {
    observe(ctx);
    if (
      typeof rawEvent !== "object" ||
      rawEvent === null ||
      Array.isArray(rawEvent)
    )
      return;
    const event = rawEvent as Record<string, unknown>;
    const id = toolCallId(event);
    const name = typeof event.toolName === "string" ? event.toolName : undefined;
    if (!id || !name) return;
    callArguments.set(id, { name, args: event.args });
    if (name !== "ask") return;
    if (askCallIds.has(id)) return;
    let askInput: unknown;
    if (
      typeof event.args === "object" &&
      event.args !== null &&
      !Array.isArray(event.args)
    )
      askInput = (event.args as Record<string, unknown>).questions;
    const parsedQuestions = parseAskQuestions(askInput);
    const questions = parsedQuestions?.questions;
    putPending(`ask:${id}`, activeSessionId!, {
      id: `ask:${id}`,
      kind: "ask",
      title: "Input required",
      body: [
        ...(!questions || questions.length === 0
          ? ["Question details are unavailable from the tool event."]
          : []),
        ...(parsedQuestions?.truncated
          ? ["Question details exceed mobile limits; answer in the native OMP dialog."]
          : ["Waiting for the native OMP dialog."]),
      ].join("\n\n"),
      toolCallId: id,
      ...(questions && questions.length > 0 ? { questions } : {}),
      transport: "terminal",
      createdAt: Date.now(),
    });
  });

  events.on("tool_approval_requested", (rawEvent, ctx) => {
    observe(ctx);
    if (
      typeof rawEvent !== "object" ||
      rawEvent === null ||
      Array.isArray(rawEvent)
    )
      return;
    const event = rawEvent as Record<string, unknown>;
    const id = toolCallId(event);
    const sessionId =
      typeof event.sessionId === "string" ? event.sessionId : undefined;
    const name =
      typeof event.toolName === "string" ? event.toolName : undefined;
    if (!id || !sessionId || !name || sessionId !== activeSessionId) return;
    const details = callArguments.get(id);
    const mode =
      typeof event.approvalMode === "string" ? event.approvalMode : undefined;
    const reason =
      typeof event.reason === "string" ? event.reason : undefined;
    const safeName = limitText(name, MAX_INTERACTION_TITLE_CHARS).text;
    const safeMode =
      mode === undefined
        ? undefined
        : limitText(mode, MAX_INTERACTION_TITLE_CHARS).text;
    const safeReason =
      reason === undefined
        ? undefined
        : limitText(reason, MAX_INTERACTION_TITLE_CHARS * 4).text;
    const body = limitText(
      [
        TERMINAL_OWNERSHIP,
        ...(safeMode ? [`Approval mode: ${safeMode}`] : []),
        ...(safeReason ? [`Reason: ${safeReason}`] : []),
        `Tool: ${safeName}`,
        ...(details?.name === name
          ? [`Arguments:\n${formatDetails(details.args)}`]
          : ["Tool arguments are unavailable from the execution event."]),
      ].join("\n\n"),
      MAX_TERMINAL_BODY_CHARS,
      DETAILS_TRUNCATION,
    ).text;
    putPending(`approval:${sessionId}:${id}`, sessionId, {
      id: `approval:${id}`,
      kind: "approval",
      title: `Approval required: ${safeName}`,
      body,
      toolCallId: id,
      transport: "terminal",
      createdAt: Date.now(),
    });
  });

  events.on("tool_approval_resolved", (rawEvent, ctx) => {
    observe(ctx);
    if (
      typeof rawEvent !== "object" ||
      rawEvent === null ||
      Array.isArray(rawEvent)
    )
      return;
    const event = rawEvent as Record<string, unknown>;
    const sessionId =
      typeof event.sessionId === "string" ? event.sessionId : undefined;
    if (!sessionId || sessionId !== activeSessionId) return;
    const id = toolCallId(event);
    if (id) pending.delete(`approval:${sessionId}:${id}`);
  });

  events.on("tool_execution_end", (rawEvent, ctx) => {
    observe(ctx);
    const id = toolCallId(rawEvent);
    if (id) removeByCallId(id);
  });

  events.on("tool_result", (rawEvent, ctx) => {
    observe(ctx);
    const id = toolCallId(rawEvent);
    if (id) removeByCallId(id);
  });

  events.on("plan_review_requested", (rawEvent, ctx) => {
    putPlan(ctx, rawEvent);
  });

  events.on("plan_review_resolved", (rawEvent, ctx) => {
    observe(ctx);
    if (
      typeof rawEvent !== "object" ||
      rawEvent === null ||
      Array.isArray(rawEvent) ||
      (rawEvent as Record<string, unknown>).sessionId !== activeSessionId
    )
      return;
    const reviewId = (rawEvent as Record<string, unknown>).reviewId;
    if (typeof reviewId !== "string") return;
    resolvedPlanIds.add(reviewId);
    pending.delete(`plan:${reviewId}`);
  });

  events.on("session_switch", (_rawEvent, ctx) => {
    clear();
    observe(ctx);
  });
  events.on("session_branch", (_rawEvent, ctx) => {
    clear();
    observe(ctx);
  });
  events.on("session_tree", (_rawEvent, ctx) => {
    clear();
    observe(ctx);
  });
  events.on("session_shutdown", () => clear());
  events.on("agent_end", () => clearTerminalInteractions());
  events.on("turn_end", () => clearTerminalInteractions());
  events.on("session_stop", () => clearTerminalInteractions());

  const syncPendingPlan = (ctx: ExtensionContext) => {
    const planContext = ctx as PlanContext;
    if (typeof planContext.getPendingPlanReview !== "function") return;
    let raw: unknown;
    try {
      raw = planContext.getPendingPlanReview();
    } catch {
      return;
    }
    const review = raw === undefined ? undefined : parsePlanReview(raw);
    const currentKey =
      review &&
      review.sessionId === activeSessionId &&
      !resolvedPlanIds.has(review.reviewId)
        ? `plan:${review.reviewId}`
        : undefined;
    for (const [key, entry] of pending) {
      if (entry.interaction.kind === "plan" && key !== currentKey)
        pending.delete(key);
    }
    if (
      !review ||
      review.sessionId !== activeSessionId ||
      resolvedPlanIds.has(review.reviewId)
    )
      return;
    putPlan(ctx, review);
  };

  const snapshot = (ctx: ExtensionContext): MobileInteraction | undefined => {
    observe(ctx);
    syncPendingPlan(ctx);
    const sessionId = activeSessionId;
    if (!sessionId) return undefined;
    const entries = [...pending.values()].filter(
      (entry) => entry.sessionId === sessionId,
    );
    const plan = entries.find((entry) => entry.interaction.kind === "plan");
    if (plan) return plan.interaction;
    const ask = entries
      .filter(
        (entry) =>
          entry.interaction.kind === "ask" &&
          entry.interaction.transport === "native",
      )
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (ask) return ask.interaction;
    return entries
      .filter((entry) => entry.interaction.transport === "terminal")
      .sort((left, right) => right.sequence - left.sequence)[0]?.interaction;
  };

  const handleAction = async (
    ctx: ExtensionContext,
    action: MobileInteractionAction,
  ): Promise<boolean> => {
    observe(ctx);
    if (
      typeof action !== "object" ||
      action === null ||
      action.type !== "interaction" ||
      typeof action.generation !== "string" ||
      action.generation.length === 0 ||
      typeof action.id !== "string" ||
      typeof action.choice !== "string"
    )
      return false;
    const interaction = snapshot(ctx);
    if (
      !interaction ||
      interaction.transport !== "native" ||
      interaction.id !== action.id
    )
      return false;
    if (interaction.kind === "ask") {
      const toolCallId = interaction.toolCallId;
      const waiter = toolCallId ? askWaiters.get(toolCallId) : undefined;
      if (
        !waiter ||
        waiter.sessionId !== activeSessionId ||
        waiter.interactionId !== interaction.id ||
        action.feedback !== undefined ||
        action.role !== undefined
      )
        return false;
      if (action.choice === "cancel" && action.answers === undefined) {
        settleAsk(waiter, { kind: "cancel" });
        pending.delete(waiter.interactionId);
        return true;
      }
      if (action.choice !== "answer") return false;
      const answers = validateAskAnswers(waiter.questions, action.answers);
      if (!answers) return false;
      settleAsk(waiter, { kind: "answer", answers });
      pending.delete(waiter.interactionId);
      return true;
    }
    if (interaction.kind !== "plan") return false;
    const planContext = ctx as PlanContext;
    if (typeof planContext.getPendingPlanReview !== "function" ||
        typeof planContext.resolvePlanReview !== "function")
      return false;
    let liveReview: PlanReview | undefined;
    try {
      liveReview = parsePlanReview(planContext.getPendingPlanReview());
    } catch {
      return false;
    }
    if (!liveReview || liveReview.reviewId !== action.id || liveReview.sessionId !== activeSessionId)
      return false;
    if (resolvedPlanIds.has(liveReview.reviewId)) return false;
    const choice = action.choice as PlanChoice;
    if (!PLAN_CHOICES[choice]) return false;
    const exposedOption = interaction.options?.find(
      (candidate) => candidate.id === choice,
    );
    if (!exposedOption || exposedOption.disabled) return false;
    const option = liveReview.options.find((candidate) => candidate.id === choice);
    if (!option || option.disabled) return false;
    const feedback = action.feedback;
    if (feedback !== undefined && typeof feedback !== "string") return false;
    if (choice === "refine") {
      if (typeof feedback !== "string" || feedback.trim().length === 0) return false;
    } else if (typeof feedback === "string" && feedback.trim().length > 0) {
      return false;
    }
    const role = action.role;
    if (role !== undefined) {
      if (
        typeof role !== "string" ||
        !(choice === "execute" || choice === "compact" || choice === "keep") ||
        !liveReview.tiers?.some((tier) => tier.role === role)
      )
        return false;
    }

    let resolved = false;
    try {
      resolved = planContext.resolvePlanReview(liveReview.reviewId, choice, {
        ...(choice === "refine" ? { feedback } : {}),
        ...(role !== undefined ? { role } : {}),
      });
    } catch {
      return false;
    }
    if (!resolved) return false;
    resolvedPlanIds.add(liveReview.reviewId);
    pending.delete(`plan:${liveReview.reviewId}`);
    return true;
  };

  return { observe, reset: clear, beginAsk, snapshot, handleAction };
}

