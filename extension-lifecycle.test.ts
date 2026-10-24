import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "./extension";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

test("sidebar status stays working across continuations and background waits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-lifecycle-"));
  const saved = { ...process.env };
  const slot = `rt-${crypto.randomUUID()}`;
  process.env.OMP_MOBILE_SLOT = slot;
  process.env.OMP_MOBILE_STATE_DIR = dir;
  process.env.OMP_MOBILE_IPC_TOKEN = "lifecycle-regression-token";
  type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const branch = [
    { type: "branch_summary", shortSummary: "Compact status summary" },
    {
      type: "message",
      id: "entry-small",
      message: { role: "assistant", content: "Small full response" },
    },
    {
      type: "message",
      id: "entry-large",
      message: {
        role: "assistant",
        content: Array.from({ length: 40 }, () => ({
          type: "text",
          text: "L".repeat(8000),
        })),
      },
    },
    {
      type: "message",
      id: "entry-cache-a",
      message: {
        role: "assistant",
        content: "A".repeat(17 * 1024 * 1024),
      },
    },
    {
      type: "message",
      id: "entry-cache-b",
      message: {
        role: "assistant",
        content: "B".repeat(17 * 1024 * 1024),
      },
    },
  ];
  const ctx = {
    hasUI: true,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "/tmp/lifecycle-session.jsonl",
      getSessionName: () => "Video build",
      getCwd: () => "/tmp",
      getBranch: () => branch,
    },
    setInterval,
    clearTimer: clearInterval,
  };
  // Only lifecycle/status context methods are needed in this fixture.
  const context = ctx as unknown as ExtensionContext;
  const emit = async (name: string, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, context);
  };
  // Tool schema registration is unrelated to the lifecycle under exercise.
  const Type = new Proxy({}, { get: () => () => ({}) });
  try {
    register({
      on(name: string, handler: Handler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      typebox: { Type },
      registerTool() {},
      logger: console,
    } as unknown as ExtensionAPI);
    await emit("session_start");
    const status = async () => {
      const response = await fetch("http://localhost/status", {
        unix: join(dir, `${slot}.sock`),
        headers: { authorization: "Bearer lifecycle-regression-token" },
      });
      expect(response.status).toBe(200);
      return await response.json() as {
        generation: string;
        cwd: string;
        summary?: string;
        agentActive: boolean;
        completion?: { identity: string };
      };
    };
    await emit("agent_start");
    const initialStatus = await status();
    expect(initialStatus.generation).toContain(":session:");
    expect(initialStatus.cwd).toBe("/tmp");
    expect(initialStatus.summary).toBe("Compact status summary");
    expect((await status()).agentActive).toBe(true);
    const ids = ["entry-small", "entry-large"];
    const batchUrl = new URL("http://localhost/messages");
    batchUrl.searchParams.set("ids", JSON.stringify(ids));
    batchUrl.searchParams.set("generation", initialStatus.generation);
    const batchResponse = await fetch(batchUrl, {
      unix: join(dir, `${slot}.sock`),
      headers: { authorization: "Bearer lifecycle-regression-token" },
    });
    expect(batchResponse.status).toBe(200);
    const batch = await batchResponse.json() as {
      generation: string;
      messages: Array<{ entryId: string }>;
      transfers: Array<{
        entryId: string;
        transferId: string;
        chunk: string;
        nextOffset: number;
        total: number;
      }>;
    };
    expect(batch.generation).toBe(initialStatus.generation);
    expect(batch.messages.map((message) => message.entryId)).toEqual([
      "entry-small",
    ]);
    expect(batch.transfers).toHaveLength(1);
    const transfer = batch.transfers[0]!;
    expect(transfer.entryId).toBe("entry-large");
    expect(transfer.chunk.length).toBe(transfer.nextOffset);
    expect(transfer.total).toBeGreaterThan(transfer.nextOffset);
    const continuationUrl = new URL("http://localhost/message");
    continuationUrl.searchParams.set("id", transfer.entryId);
    continuationUrl.searchParams.set("offset", String(transfer.nextOffset));
    continuationUrl.searchParams.set("transferId", transfer.transferId);
    continuationUrl.searchParams.set("generation", initialStatus.generation);
    const continuationResponse = await fetch(continuationUrl, {
      unix: join(dir, `${slot}.sock`),
      headers: { authorization: "Bearer lifecycle-regression-token" },
    });
    expect(continuationResponse.status).toBe(200);
    const continuation = await continuationResponse.json() as {
      generation: string;
      chunk: string;
      nextOffset: number | null;
      total: number;
    };
    expect(continuation.generation).toBe(initialStatus.generation);
    expect(continuation.nextOffset).toBeNull();
    const fullMessage = JSON.parse(
      transfer.chunk + continuation.chunk,
    ) as { entryId: string; full?: boolean; parts: Array<{ text: string }> };
    expect(fullMessage.entryId).toBe("entry-large");
    expect(fullMessage.full).toBe(true);
    const competingBatchUrl = new URL("http://localhost/messages");
    competingBatchUrl.searchParams.set(
      "ids",
      JSON.stringify(["entry-cache-a", "entry-cache-b"]),
    );
    competingBatchUrl.searchParams.set(
      "generation",
      initialStatus.generation,
    );
    const competingBatchResponse = await fetch(competingBatchUrl, {
      unix: join(dir, `${slot}.sock`),
      headers: { authorization: "Bearer lifecycle-regression-token" },
    });
    expect(competingBatchResponse.status).toBe(413);
    expect(await competingBatchResponse.json()).toMatchObject({
      code: "transfer_capacity",
    });
    expect(fullMessage.parts).toHaveLength(40);
    expect(fullMessage.parts[0]?.text).toHaveLength(8000);
    const staleBatch = new URL(batchUrl);
    staleBatch.searchParams.set("generation", "stale-generation");
    const staleResponse = await fetch(staleBatch, {
      unix: join(dir, `${slot}.sock`),
      headers: { authorization: "Bearer lifecycle-regression-token" },
    });
    expect(staleResponse.status).toBe(409);
    const aggregateUrl = new URL("http://localhost/messages");
    aggregateUrl.searchParams.set(
      "ids",
      JSON.stringify(["entry-cache-a", "entry-cache-b"]),
    );
    aggregateUrl.searchParams.set("generation", initialStatus.generation);
    const aggregateResponse = await fetch(aggregateUrl, {
      unix: join(dir, `${slot}.sock`),
      headers: { authorization: "Bearer lifecycle-regression-token" },
    });
    expect(aggregateResponse.status).toBe(413);
    expect(await aggregateResponse.json()).toMatchObject({
      code: "transfer_capacity",
    });
    const singleMessageUrl = new URL("http://localhost/message");
    singleMessageUrl.searchParams.set("id", "entry-cache-a");
    singleMessageUrl.searchParams.set("generation", initialStatus.generation);
    const firstChunkResponse = await fetch(singleMessageUrl, {
      unix: join(dir, `${slot}.sock`),
      headers: { authorization: "Bearer lifecycle-regression-token" },
    });
    expect(firstChunkResponse.status).toBe(200);
    let messageChunk = await firstChunkResponse.json() as {
      generation: string;
      transferId: string;
      chunk: string;
      nextOffset: number | null;
      total: number;
    };
    const chunks = [messageChunk.chunk];
    while (messageChunk.nextOffset !== null) {
      const nextChunkUrl = new URL("http://localhost/message");
      nextChunkUrl.searchParams.set("id", "entry-cache-a");
      nextChunkUrl.searchParams.set("offset", String(messageChunk.nextOffset));
      nextChunkUrl.searchParams.set("transferId", messageChunk.transferId);
      nextChunkUrl.searchParams.set("generation", initialStatus.generation);
      const nextChunkResponse = await fetch(nextChunkUrl, {
        unix: join(dir, `${slot}.sock`),
        headers: { authorization: "Bearer lifecycle-regression-token" },
      });
      expect(nextChunkResponse.status).toBe(200);
      messageChunk = await nextChunkResponse.json() as typeof messageChunk;
      chunks.push(messageChunk.chunk);
    }
    const restoredLargeMessage = JSON.parse(chunks.join("")) as {
      entryId: string;
      parts: Array<{ text: string }>;
    };
    expect(restoredLargeMessage.entryId).toBe("entry-cache-a");
    expect(restoredLargeMessage.parts[0]?.text).toHaveLength(17 * 1024 * 1024);
    const afterReleaseUrl = new URL("http://localhost/message");
    afterReleaseUrl.searchParams.set("id", "entry-cache-b");
    afterReleaseUrl.searchParams.set("generation", initialStatus.generation);
    const afterReleaseResponse = await fetch(afterReleaseUrl, {
      unix: join(dir, `${slot}.sock`),
      headers: { authorization: "Bearer lifecycle-regression-token" },
    });
    expect(afterReleaseResponse.status).toBe(200);
    for (const event of [
      { willContinue: true },
      { willContinue: true, awaitingAsyncWork: true },
      { awaitingAsyncWork: true },
      { isTerminal: false },
    ]) {
      await emit("agent_end", event);
      const state = await status();
      expect(state.agentActive).toBe(true);
      expect(state.completion).toBeUndefined();
    }
    await emit("agent_end", { willContinue: false });
    const completed = await status();
    expect(completed.agentActive).toBe(false);
    expect(completed.completion?.identity).toBeDefined();
    await emit("agent_start");
    await emit("agent_end", { willContinue: true });
    expect((await status()).agentActive).toBe(true);
    await emit("agent_end");
    const next = await status();
    expect(next.agentActive).toBe(false);
    expect(next.completion?.identity).not.toBe(completed.completion?.identity);
  } finally {
    await emit("session_shutdown");
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
