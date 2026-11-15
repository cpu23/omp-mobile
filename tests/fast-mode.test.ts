import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mobileFastMode } from "../extension";

type Model = NonNullable<ExtensionContext["model"]>;
const anthropicModel = {
  provider: "anthropic",
  id: "claude-sonnet",
  api: "anthropic-messages",
  identity: { class: "anthropic" },
} as unknown as Model;
const openAIModel = {
  provider: "openai",
  id: "gpt-5",
  api: "openai-responses",
  identity: { class: "openai" },
} as unknown as Model;

test("fast-mode state follows the active model and its current service tier", () => {
  expect(mobileFastMode({ anthropic: "priority" }, anthropicModel)).toBe(true);
  expect(mobileFastMode({ anthropic: "priority" }, openAIModel)).toBe(false);
  expect(mobileFastMode({ openai: "ultrafast" }, openAIModel)).toBe(true);
  expect(mobileFastMode({ openai: "auto" }, openAIModel)).toBe(false);
  expect(mobileFastMode(undefined, anthropicModel)).toBe(false);
  expect(mobileFastMode({ anthropic: "priority" }, undefined)).toBe(false);
});
