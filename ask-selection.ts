import type { MobileAskAnswer, MobileAskQuestion } from "./parity-types";
const MAX_ASK_FIELD_CHARS = 4_096;

export type AskAnswerDraft = {
  selectedOptions: string[];
  otherSelected: boolean;
  customInput: string;
};

export function createAskAnswerDraft(): AskAnswerDraft {
  return { selectedOptions: [], otherSelected: false, customInput: "" };
}

export function selectAskOption(
  question: MobileAskQuestion,
  draft: AskAnswerDraft,
  label: string,
  selected: boolean,
): void {
  if (!question.options.some((option) => option.label === label)) return;
  if (!question.multi) {
    draft.selectedOptions = [label];
    draft.otherSelected = false;
    return;
  }
  const selection = new Set(draft.selectedOptions);
  if (selected) selection.add(label);
  else selection.delete(label);
  draft.selectedOptions = question.options
    .filter((option) => selection.has(option.label))
    .map((option) => option.label);
}

export function selectAskOther(
  question: MobileAskQuestion,
  draft: AskAnswerDraft,
  selected: boolean,
): void {
  draft.otherSelected = selected;
  if (!question.multi && selected) draft.selectedOptions = [];
}

export function canSubmitAskAnswer(
  question: MobileAskQuestion,
  draft: AskAnswerDraft,
): boolean {
  if (draft.otherSelected && draft.customInput.trim().length === 0) return false;
  if (question.multi) return true;
  return draft.otherSelected || draft.selectedOptions.length === 1;
}

export function askAnswerFromDraft(
  question: MobileAskQuestion,
  draft: AskAnswerDraft,
): MobileAskAnswer {
  return {
    selectedOptions: question.multi
      ? question.options
          .filter((option) => draft.selectedOptions.includes(option.label))
          .map((option) => option.label)
      : draft.otherSelected
        ? []
        : draft.selectedOptions.slice(0, 1),
    ...(draft.otherSelected ? { customInput: draft.customInput } : {}),
  };
}
export function validateAskAnswers(
  questions: MobileAskQuestion[],
  value: unknown,
): MobileAskAnswer[] | undefined {
  if (!Array.isArray(value) || value.length !== questions.length) return undefined;
  const answers: MobileAskAnswer[] = [];
  for (const [index, candidate] of value.entries()) {
    const question = questions[index];
    if (
      !question ||
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    )
      return undefined;
    const raw = candidate as Record<string, unknown>;
    if (
      Object.keys(raw).some((key) => key !== "selectedOptions" && key !== "customInput") ||
      !Array.isArray(raw.selectedOptions) ||
      raw.selectedOptions.some((option) => typeof option !== "string") ||
      (raw.customInput !== undefined && typeof raw.customInput !== "string")
    )
      return undefined;
    const selectedOptions = raw.selectedOptions as string[];
    if (
      new Set(selectedOptions).size !== selectedOptions.length ||
      selectedOptions.some(
        (selected) => !question.options.some((option) => option.label === selected),
      ) ||
      (!question.multi && selectedOptions.length > 1)
    )
      return undefined;
    const customInput = raw.customInput as string | undefined;
    if (
      customInput !== undefined &&
      (customInput.trim().length === 0 ||
        customInput.length > MAX_ASK_FIELD_CHARS)
    )
      return undefined;
    if (
      !question.multi &&
      ((selectedOptions.length === 0) === (customInput === undefined))
    )
      return undefined;
    answers.push({
      selectedOptions,
      ...(customInput !== undefined ? { customInput } : {}),
    });
  }
  return answers;
}
