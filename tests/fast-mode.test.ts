import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mobileFastMode } from "../extension";
import { normaliseState } from "../src/server";

type Model = NonNullable<ExtensionContext["model"]>;
const anthropicModel = {
  provider: "anthropic", id: "claude-sonnet", api: "anthropic-messages",
  identity: { class: "anthropic" },
} as unknown as Model;
const openAIModel = {
  provider: "openai", id: "gpt-5", api: "openai-responses",
  identity: { class: "openai" },
} as unknown as Model;
const fireworksModel = {
  provider: "fireworks", id: "accounts/fireworks/models/qwen3-235b-a22b-instruct-2507",
  api: "openai-completions", identity: { class: "fireworks" },
} as unknown as Model;

test("known fast-mode state follows the active model and public service tier", () => {
  expect(mobileFastMode({ anthropic: "priority" }, openAIModel)).toBe(false);
  expect(mobileFastMode({ openai: "priority" }, openAIModel)).toBe(true);
  expect(mobileFastMode({ openai: "ultrafast" }, openAIModel)).toBe(true);
  expect(mobileFastMode({ openai: "auto" }, openAIModel)).toBe(false);
  expect(mobileFastMode({}, openAIModel)).toBe(false);
  expect(mobileFastMode({ anthropic: "priority" }, undefined)).toBe(false);
});

test("missing host tier capability is unknown, not disabled", () => {
  expect(mobileFastMode(undefined, openAIModel)).toBeNull();
});

test("Fireworks status is unknown without its separate provider setting", () => {
  // M21-1: the same public empty map accompanies both standard and priority
  // provider configuration. Neither idle state may be inferred as disabled.
  for (const model of [fireworksModel, { ...fireworksModel, id: `${fireworksModel.id}-fast` }]) {
    expect(mobileFastMode({}, model)).toBeNull();
    expect(mobileFastMode({ openai: "priority" }, model)).toBeNull();
  }
});

test("Anthropic selected priority does not claim effective fast mode", () => {
  // M21-2: active, fallback-disabled, and same-tier re-armed sessions expose
  // the same map. Repeated snapshots remain unknown; no sticky inference.
  const tiers = { anthropic: "priority" } as const;
  for (let snapshot = 0; snapshot < 3; snapshot++) {
    expect(mobileFastMode(tiers, anthropicModel)).toBeNull();
  }
  expect(mobileFastMode({}, anthropicModel)).toBeNull();
  expect(mobileFastMode(undefined, anthropicModel)).toBeNull();
});

test("model switches preserve unknown status through snapshot serialisation", () => {
  const tiers = { openai: "priority", anthropic: "priority" } as const;
  for (const [model, expected] of [
    [openAIModel, true], [anthropicModel, null], [fireworksModel, null], [openAIModel, true],
  ] as const) {
    const snapshot = JSON.parse(JSON.stringify({
      generation: "fixture", model, fastMode: mobileFastMode(tiers, model),
    }));
    expect(normaliseState(snapshot)?.fastMode).toBe(expected);
  }
});
