import { describe, expect, it } from "bun:test";
import type { MobileAskQuestion } from "./parity-types";
import {
  askAnswerFromDraft,
  canSubmitAskAnswer,
  createAskAnswerDraft,
  selectAskOption,
  selectAskOther,
} from "./ask-selection";

const single: MobileAskQuestion = {
  id: "choice",
  question: "Choose one",
  options: [{ label: "A" }, { label: "B" }],
  multi: false,
};
const multiple: MobileAskQuestion = {
  id: "features",
  question: "Choose any",
  options: [{ label: "A" }, { label: "B" }],
  multi: true,
};

describe("mobile ask answer drafts", () => {
  it("requires one radio option or non-empty Other text", () => {
    const draft = createAskAnswerDraft();
    expect(canSubmitAskAnswer(single, draft)).toBe(false);
    selectAskOther(single, draft, true);
    expect(canSubmitAskAnswer(single, draft)).toBe(false);
    draft.customInput = "  custom answer  ";
    expect(canSubmitAskAnswer(single, draft)).toBe(true);
    expect(askAnswerFromDraft(single, draft)).toEqual({
      selectedOptions: [],
      customInput: "  custom answer  ",
    });
    selectAskOption(single, draft, "B", true);
    expect(askAnswerFromDraft(single, draft)).toEqual({ selectedOptions: ["B"] });
  });

  it("preserves multi-selection order and allows selected options with Other text", () => {
    const draft = createAskAnswerDraft();
    selectAskOption(multiple, draft, "B", true);
    selectAskOption(multiple, draft, "A", true);
    selectAskOther(multiple, draft, true);
    expect(canSubmitAskAnswer(multiple, draft)).toBe(false);
    draft.customInput = "custom";
    expect(askAnswerFromDraft(multiple, draft)).toEqual({
      selectedOptions: ["A", "B"],
      customInput: "custom",
    });
    selectAskOther(multiple, draft, false);
    expect(askAnswerFromDraft(multiple, draft)).toEqual({
      selectedOptions: ["A", "B"],
    });
  });

  it("allows explicitly submitting no multi-select choices", () => {
    const draft = createAskAnswerDraft();
    expect(canSubmitAskAnswer(multiple, draft)).toBe(true);
    expect(askAnswerFromDraft(multiple, draft)).toEqual({ selectedOptions: [] });
  });
});
