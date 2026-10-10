import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationService } from "./notifications";

test("completion notifications survive transcripts larger than the IPC response cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-notification-test-"));
  const slot = "rt-long-session";
  let completion = { identity: "baseline", completedAt: 1 };
  const messages = [{ role: "assistant", content: "x".repeat(1100000) }];
  const server = createServer((socket) => {
    let request = "";
    socket.on("error", () => {}); // An oversized response may be rejected before it finishes.
    socket.on("data", (chunk) => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      const status = { title: "Long conversation", agentActive: false, completion };
      const body = JSON.stringify(request.startsWith("GET /status ") ? status : { ...status, messages });
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  const service = createNotificationService({
    ipcRoot: root,
    token: "isolated-notification-test-token",
    stateFile: join(root, "notifications.json"),
    listSlots: () => [slot],
    // Keep delivery disabled; this regression exercises local unread completion state.
    vapidPublicKey: "",
    vapidPrivateKey: "",
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(root, `${slot}.sock`), resolve);
    });
    await service.pollOnce();
    completion = { identity: "finished", completedAt: 2 };
    await service.pollOnce();
    await service.pollOnce();
    const status = await service.status();
    expect(status.totalUnread).toBe(1);
    expect(status.slots[0]?.unread).toEqual([
      { identity: "finished", title: "Long conversation", completedAt: 2 },
    ]);
    await service.ack(slot, "finished");
    await service.pollOnce();
    expect((await service.status()).totalUnread).toBe(0);
  } finally {
    service.stop();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
