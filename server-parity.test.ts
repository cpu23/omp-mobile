import { expect, test } from "bun:test";
import {
  normaliseState,
  validateInteractionAction,
  validatePromptImages,
} from "./server";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZ8AAAAASUVORK5CYII=";

test("state normalisation bounds snapshots and rejects malformed history and notices", () => {
  const messages = Array.from({ length: 90 }, (_, index) => ({
    role: "assistant",
    entryId: `entry-${index}`,
    timestamp: null,
    parts: [
      {
        kind: "image",
        image: {
          type: "image",
          mimeType: "image/png",
          data: "",
          sourceId: `entry-${index}`,
        },
        label: "Load full image",
      },
    ],
  }));
  const state = normaliseState({
    generation: "generation-1",
    messages,
    history: { total: 90, shown: 80, hasMore: true },
    runtime: {
      notices: [
        { id: "notice-1", tone: "warning", title: "Retrying", timestamp: 42 },
        { id: "bad-notice", tone: "unknown", title: "Ignored", timestamp: 42 },
      ],
      status: { kind: "retry", label: "Retrying", active: true },
      goal: { text: "Finish task" },
      queue: [{ text: "Follow-up" }],
    },
  });

  expect(state?.messages).toHaveLength(80);
  expect(state?.messages[0]?.entryId).toBe("entry-10");
  expect(state?.runtime?.notices).toHaveLength(1);

  const malformed = normaliseState({
    generation: "generation-2",
    history: { total: -1, shown: 90, hasMore: "yes" },
    runtime: { notices: "invalid", interaction: [] },
  });
  expect(malformed?.history).toBeUndefined();
  expect(malformed?.runtime).toEqual({ notices: [] });
});

test("native plan actions reject stale ids/generations and accept only exposed choices", () => {
  const state = normaliseState({
    generation: "generation-1",
    messages: [],
    runtime: {
      notices: [],
      interaction: {
        id: "plan-1",
        kind: "plan",
        title: "Review plan",
        options: [{ id: "approve", label: "Approve" }],
        tiers: [{ role: "planner" }],
        transport: "native",
        createdAt: 10,
      },
    },
  });
  expect(state).toBeDefined();
  if (!state) return;

  expect(
    validateInteractionAction(state, {
      generation: "generation-1",
      type: "interaction",
      id: "old-plan",
      choice: "approve",
    }),
  ).toMatchObject({ ok: false, status: 409 });
  expect(
    validateInteractionAction(state, {
      generation: "stale-generation",
      type: "interaction",
      id: "plan-1",
      choice: "approve",
    }),
  ).toMatchObject({ ok: false, status: 409 });
  expect(
    validateInteractionAction(state, {
      generation: "generation-1",
      type: "interaction",
      id: "plan-1",
      choice: "approve",
      role: "planner",
    }),
  ).toEqual({
    ok: true,
    action: {
      generation: "generation-1",
      type: "interaction",
      id: "plan-1",
      choice: "approve",
      role: "planner",
    },
  });
  expect(
    validateInteractionAction(state, {
      generation: "generation-1",
      type: "interaction",
      id: "plan-1",
      choice: "invented",
    }),
  ).toMatchObject({ ok: false, status: 400 });
  expect(
    validateInteractionAction(state, {
      generation: "generation-1",
      type: "interaction",
      id: "plan-1",
      choice: "approve",
      feedback: "x".repeat(8001),
    }),
  ).toMatchObject({ ok: false, status: 400 });
});

test("prompt image attachments validate raster signatures and aggregate base64 size", () => {
  const valid = {
    type: "image",
    mimeType: "image/png",
    data: PNG_BASE64,
  };
  expect(validatePromptImages([valid])).toEqual({ images: [valid] });
  expect(
    validatePromptImages([{ ...valid, mimeType: "image/gif" }]),
  ).toMatchObject({ error: expect.stringContaining("does not match") });
  expect(
    validatePromptImages([
      { type: "image", mimeType: "image/png", data: "", sourceId: "entry-1" },
    ]),
  ).toMatchObject({ error: expect.stringContaining("base64 data") });
  expect(
    validatePromptImages([
      valid,
      { ...valid, data: `${PNG_BASE64.slice(0, 12)}${"A".repeat(3 * 1024 * 1024)}` },
    ]),
  ).toMatchObject({ error: expect.stringContaining("3 MiB") });
  expect(validatePromptImages(Array.from({ length: 9 }, () => valid))).toMatchObject({
    error: expect.stringContaining("1-8"),
  });
});
