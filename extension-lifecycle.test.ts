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
  const ctx = {
    hasUI: true,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "/tmp/lifecycle-session.jsonl",
      getSessionName: () => "Video build",
      getBranch: () => [],
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
      return await response.json() as { agentActive: boolean; completion?: { identity: string } };
    };
    await emit("agent_start");
    expect((await status()).agentActive).toBe(true);
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
