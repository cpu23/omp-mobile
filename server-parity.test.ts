import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  normaliseState,
  validateInteractionAction,
  validatePromptImages,
  withCors,
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

test("queue availability does not become a large runtime notice", () => {
  const state = normaliseState({
    generation: "queue-generation",
    messages: [],
    hasPendingMessages: true,
    runtime: {
      queue: [{ text: "Follow-up" }],
      notices: [
        { id: "queue-limit", tone: "info", title: "Queue text unavailable", timestamp: 1 },
        { id: "provider-error", tone: "error", title: "Provider disconnected", timestamp: 2 },
        { id: "queue-warning", tone: "warning", title: "Queue text unavailable", timestamp: 3 },
      ],
    },
  });
  expect(state?.hasPendingMessages).toBe(true);
  expect(state?.runtime?.queue).toEqual([{ text: "Follow-up" }]);
  expect(state?.runtime?.notices.map((notice) => notice.id)).toEqual([
    "provider-error", "queue-warning",
  ]);
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
  expect(validateInteractionAction(state, {
    generation: "generation-1", type: "interaction", id: "plan-1", choice: "approve",
    answers: [{ selectedOptions: ["approve"] }],
  })).toMatchObject({ ok: false, status: 400 });
});

test("native ask gateway validates answers and keeps plan and ask payloads separate", () => {
  const state = normaliseState({
    generation: "generation-ask",
    messages: [],
    runtime: {
      interaction: {
        id: "ask-1", kind: "ask", title: "Choose", transport: "native", createdAt: 1,
        questions: [
          { id: "browser", question: "Browser?", options: [{ label: "Brave" }, { label: "Chrome" }] },
          { id: "features", question: "Features?", multi: true, options: [{ label: "Paste" }] },
        ],
      },
    },
  });
  if (!state) throw new Error("Ask state failed normalization");
  const action = { generation: state.generation, type: "interaction", id: "ask-1", choice: "answer" };
  const answers = [{ selectedOptions: ["Brave"] }, { selectedOptions: ["Paste"], customInput: "Camera" }];
  expect(validateInteractionAction(state, { ...action, answers })).toEqual({
    ok: true, action: { ...action, answers },
  });
  expect(validateInteractionAction(state, { ...action, answers: answers.slice(0, 1) })).toMatchObject({ ok: false, status: 400 });
  expect(validateInteractionAction(state, { ...action, answers: [{ selectedOptions: ["Unknown"] }, answers[1]] })).toMatchObject({ ok: false, status: 400 });
  expect(validateInteractionAction(state, { ...action, answers, role: "planner" })).toMatchObject({ ok: false, status: 400 });
  expect(validateInteractionAction(state, { ...action, answers, generation: "old" })).toMatchObject({ ok: false, status: 409 });
  expect(validateInteractionAction(state, { ...action, choice: "cancel" })).toEqual({
    ok: true, action: { ...action, choice: "cancel" },
  });
  expect(validateInteractionAction(state, { ...action, choice: "cancel", answers })).toMatchObject({ ok: false, status: 400 });
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

test("authenticated JSON validators are semantic, private, and gzip-aware", async () => {
  const body = JSON.stringify({ generation: "g-1", value: "x".repeat(20_000) });
  const headers = {
    authorization: "Bearer test-token-one",
    "accept-encoding": "gzip",
    origin: "https://mobile.example",
  };
  const request = new Request("http://localhost/api/slots/rt-test/state", {
    headers,
  });
  const response = await withCors(
    new Response(body, {
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    request,
  );
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("vary")).toContain("Authorization");
  expect(response.headers.get("vary")).toContain("Accept-Encoding");
  expect(response.headers.get("vary")).toContain("Origin");
  expect(
    gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"),
  ).toBe(body);
  const etag = response.headers.get("etag");
  expect(etag).toBeTruthy();

  const revalidated = await withCors(
    new Response(body, {
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    new Request("http://localhost/api/slots/rt-test/state", {
      headers: { ...headers, "if-none-match": etag! },
    }),
  );
  expect(revalidated.status).toBe(304);

  const changedState = await withCors(
    new Response(JSON.stringify({ generation: "g-1", value: "y".repeat(20_000) }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    request,
  );
  expect(changedState.headers.get("etag")).not.toBe(etag);

  const otherIdentity = await withCors(
    new Response(body, {
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    new Request("http://localhost/api/slots/rt-test/state", {
      headers: { ...headers, authorization: "Bearer test-token-two" },
    }),
  );
  expect(otherIdentity.headers.get("etag")).not.toBe(etag);
});
