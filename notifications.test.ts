import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
    completion = { identity: "finished-1", completedAt: 2 };
    await service.pollOnce();
    completion = { identity: "finished-2", completedAt: 3 };
    await service.pollOnce();
    const status = await service.status(slot);
    expect(status.totalUnread).toBe(2);
    expect(status.slots[0]?.unread).toEqual([
      { identity: "finished-1", title: "Long conversation", completedAt: 2 },
      { identity: "finished-2", title: "Long conversation", completedAt: 3 },
    ]);
    // Keep the old inode allocated across both atomic writes. Otherwise the
    // filesystem can reuse it for the second replacement, even when both rename.
    const beforeAckFile = await open(join(root, "notifications.json"), "r");
    try {
      const beforeAck = await beforeAckFile.stat();
      const beforeAckContent = await readFile(join(root, "notifications.json"), "utf8");
      const ack = service.ack(slot, ["finished-1", "finished-2"]);
      completion = { identity: "finished-3", completedAt: 4 };
      await Promise.all([ack, service.pollOnce()]);
      expect((await service.status(slot)).slots[0]?.unread).toEqual([
        { identity: "finished-3", title: "Long conversation", completedAt: 4 },
      ]);
      expect((await stat(join(root, "notifications.json"))).ino).not.toBe(beforeAck.ino);
      // Atomic replacement must not modify readers of the previous ledger.
      expect(await beforeAckFile.readFile("utf8")).toBe(beforeAckContent);
    } finally {
      await beforeAckFile.close();
    }
    const beforeNoop = await stat(join(root, "notifications.json"));
    await service.ack(slot, []);
    await service.ack(slot, ["not-present"]);
    expect((await stat(join(root, "notifications.json"))).ino).toBe(
      beforeNoop.ino,
    );
    await service.ack(slot, ["finished-3"]);
    expect((await service.status()).totalUnread).toBe(0);
  } finally {
    service.stop();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
test("failed notification writes preserve delivery across ledger and credential cleanup failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-notification-write-retry-test-"));
  const slot = "rt-write-retry";
  const stateFile = join(root, "notifications.json");
  const subscription = {
    endpoint: "https://8.8.8.8/push",
    keys: { p256dh: "BvalidPublicKeyValue", auth: "validAuthKey" },
  };
  await writeFile(
    `${stateFile}.subscriptions`,
    `${JSON.stringify({ version: 1, subscriptions: [subscription] })}\n`,
    { mode: 0o600 },
  );
  const imported = await (
    new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<Record<string, unknown>>
  )("web-push");
  const webPush = (imported.default ?? imported) as {
    generateVAPIDKeys(): { publicKey: string; privateKey: string };
    setVapidDetails(
      subject: string,
      publicKey: string,
      privateKey: string,
    ): void;
    sendNotification(
      target: typeof subscription,
      payload: string,
      options?: { TTL?: number },
    ): Promise<unknown>;
  };
  const originalSend = webPush.sendNotification;
  const deliveries: string[] = [];
  webPush.sendNotification = async (_target, payload) => {
    const decoded: unknown = JSON.parse(payload);
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("identity" in decoded) ||
      typeof decoded.identity !== "string"
    )
      throw new Error("push payload did not contain an identity");
    deliveries.push(decoded.identity);
    return undefined;
  };
  const keys = webPush.generateVAPIDKeys();
  let completion = { identity: "baseline", completedAt: 1 };
  const server = createServer((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      const body = JSON.stringify({
        title: "Retry session",
        completion,
      });
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  const service = createNotificationService({
    ipcRoot: root,
    token: "isolated-notification-write-retry-token",
    stateFile,
    listSlots: () => [slot],
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: keys.privateKey,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(root, `${slot}.sock`), resolve);
    });
    await service.pollOnce();
    const backup = join(root, "notifications.backup.json");
    await rename(stateFile, backup);
    await mkdir(stateFile);
    completion = { identity: "retry-me", completedAt: 2 };
    await expect(service.pollOnce()).rejects.toThrow();
    expect((await service.status(slot)).slots[0]?.unread).toEqual([
      { identity: "retry-me", title: "Retry session", completedAt: 2 },
    ]);

    await rm(stateFile, { recursive: true, force: true });
    await rename(backup, stateFile);
    await service.pollOnce();
    expect(
      JSON.parse(await readFile(stateFile, "utf8")).slots[slot].unread,
    ).toEqual([
      { identity: "retry-me", title: "Retry session", completedAt: 2 },
    ]);
    expect(deliveries).toEqual(["retry-me"]);

    const expired = {
      endpoint: "https://8.8.4.4/expired",
      keys: subscription.keys,
    };
    await service.subscribe(expired);
    const subscriptionsFile = `${stateFile}.subscriptions`;
    const subscriptionsBackup = join(root, "subscriptions.backup.json");
    webPush.sendNotification = async (target, payload) => {
      if (target.endpoint === expired.endpoint) {
        await rename(subscriptionsFile, subscriptionsBackup);
        await mkdir(subscriptionsFile);
        throw Object.assign(new Error("subscription expired"), { statusCode: 410 });
      }
      deliveries.push((JSON.parse(payload) as { identity: string }).identity);
      return undefined;
    };
    completion = { identity: "delivered-before-cleanup", completedAt: 3 };
    await expect(service.pollOnce()).rejects.toThrow();
    expect(deliveries).toEqual(["retry-me", "delivered-before-cleanup"]);
    await rm(subscriptionsFile, { recursive: true, force: true });
    await rename(subscriptionsBackup, subscriptionsFile);
    await service.pollOnce();
    expect(deliveries).toEqual(["retry-me", "delivered-before-cleanup"]);
    expect(
      JSON.parse(await readFile(subscriptionsFile, "utf8")).subscriptions,
    ).toEqual([subscription]);
  } finally {
    webPush.sendNotification = originalSend;
    service.stop();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("action-needed notifications dedupe, acknowledge, and resolve independently of completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-action-notification-test-"));
  const slot = "rt-action-session";
  let completion = { identity: "baseline", completedAt: 1 };
  let pendingAction:
    | { id: string; kind: "ask"; title: string }
    | undefined = { id: "interaction-1", kind: "ask", title: "Answer required" };
  let activeSlots = [slot];
  let discoveryFailed = false;
  const server = createServer((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      const status = {
        title: "Action session",
        completion,
        ...(pendingAction ? { pendingAction } : {}),
      };
      const body = JSON.stringify(status);
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  const stateFile = join(root, "notifications.json");
  const service = createNotificationService({
    ipcRoot: root,
    token: "isolated-action-notification-test-token",
    stateFile,
    listSlots: () => {
      if (discoveryFailed) throw new Error("discovery unavailable");
      return activeSlots;
    },
    vapidPrivateKey: "",
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(root, `${slot}.sock`), resolve);
    });
    await service.pollOnce();
    await service.pollOnce();
    let status = await service.status(slot);
    expect(status.totalUnread).toBe(1);
    expect(status.slots[0]?.unread).toEqual([]);
    expect(status.slots[0]?.actionNeeded).toMatchObject({
      identity: "interaction-1",
      kind: "ask",
      title: "Action session",
      actionTitle: "Answer required",
      unread: true,
    });

    pendingAction = {
      id: "interaction-2",
      kind: "ask",
      title: "Another answer required",
    };
    await service.pollOnce();
    expect((await service.status()).slots[0]?.actionNeeded).toMatchObject({
      identity: "interaction-2",
      unread: true,
    });
    pendingAction = {
      id: "interaction-1",
      kind: "ask",
      title: "Answer required",
    };
    await service.pollOnce();
    status = await service.status(slot);
    expect(status.totalUnread).toBe(1);
    expect(status.slots[0]?.actionNeeded).toMatchObject({
      identity: "interaction-1",
      unread: true,
    });
    const stored = JSON.parse(await readFile(stateFile, "utf8")) as {
      slots: Record<
        string,
        { seenActions: string[]; acknowledgedActions: string[] }
      >;
    };
    expect(stored.slots[slot]?.seenActions).toEqual([
      "interaction-1",
      "interaction-2",
    ]);
    expect(stored.slots[slot]?.acknowledgedActions).toEqual([]);

    await service.ack(slot, ["interaction-1"]);
    await service.pollOnce();
    expect((await service.status()).slots[0]?.actionNeeded).toMatchObject({
      identity: "interaction-1",
      unread: false,
    });
    pendingAction = {
      id: "interaction-2",
      kind: "ask",
      title: "Another answer required",
    };
    await service.pollOnce();
    expect((await service.status()).slots[0]?.actionNeeded).toMatchObject({
      identity: "interaction-2",
      unread: true,
    });
    pendingAction = {
      id: "interaction-1",
      kind: "ask",
      title: "Answer required",
    };
    completion = { identity: "finished", completedAt: 2 };
    await service.pollOnce();
    status = await service.status(slot);
    expect(status.totalUnread).toBe(1);
    expect(status.slots[0]?.unread).toEqual([
      { identity: "finished", title: "Action session", completedAt: 2 },
    ]);
    expect(status.slots[0]?.actionNeeded?.unread).toBe(false);

    discoveryFailed = true;
    await service.pollOnce();
    expect((await service.status()).slots[0]?.actionNeeded).toMatchObject({
      identity: "interaction-1",
      unread: false,
    });
    discoveryFailed = false;
    activeSlots = [];
    await service.pollOnce();
    status = await service.status(slot);
    expect(status.slots[0]?.actionNeeded).toBeUndefined();
    expect(status.slots[0]?.unread).toHaveLength(1);
    expect(status.totalUnread).toBe(1);
    await service.ack(slot, ["finished"]);
    expect((await service.status()).totalUnread).toBe(0);
  } finally {
    service.stop();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
test("compact notification status keeps active identities and subscriptions across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-notification-restart-test-"));
  const stateFile = join(root, "notifications.json");
  const slotA = "rt-history-a";
  const slotB = "rt-history-b";
  const slotC = "rt-history-c";
  const subscription = {
    endpoint: "https://8.8.8.8/push",
    keys: { p256dh: "BvalidPublicKeyValue", auth: "validAuthKey" },
  };
  const notice = (identity: string, completedAt: number) => ({
    identity,
    title: "Saved session",
    completedAt,
  });
  const legacy = {
    version: 1,
    subscriptions: [subscription],
    slots: {
      [slotA]: {
        initialized: true,
        seen: ["a-1", "a-2"],
        seenActions: [],
        acknowledgedActions: [],
        unread: [notice("a-1", 1), notice("a-2", 2)],
      },
      [slotB]: {
        initialized: true,
        seen: Array.from({ length: 100 }, (_, index) => `b-${index}`),
        seenActions: [],
        acknowledgedActions: [],
        unread: Array.from({ length: 100 }, (_, index) =>
          notice(`b-${index}`, index),
        ),
      },
      [slotC]: {
        initialized: true,
        lastObserved: "current",
        seen: ["too-old", "old-unread", "current"],
        seenAt: {
          "too-old": Date.now() - 100 * 24 * 60 * 60 * 1000,
          "old-unread": Date.now() - 100 * 24 * 60 * 60 * 1000,
          current: Date.now(),
        },
        seenActions: [],
        acknowledgedActions: [],
        unread: [notice("old-unread", 1)],
      },
    },
  };
  await writeFile(stateFile, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const options = {
    ipcRoot: root,
    token: "isolated-notification-restart-token",
    stateFile,
    listSlots: () => [],
    vapidPublicKey: "",
    vapidPrivateKey: "",
  };
  const service = createNotificationService(options);
  try {
    let status = await service.status(slotA);
    expect(status.totalUnread).toBe(103);
    expect(status.slots).toHaveLength(3);
    expect(status.slots.find((item) => item.slot === slotA)?.unread).toHaveLength(2);
    expect(status.slots.find((item) => item.slot === slotB)?.unread).toBeUndefined();
    expect(status.slots.find((item) => item.slot === slotB)?.unreadCount).toBe(100);
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(legacy.slots)),
    );
    expect(
      JSON.parse(await readFile(`${stateFile}.subscriptions`, "utf8"))
        .subscriptions,
    ).toEqual([subscription]);
    expect(
      JSON.parse(await readFile(stateFile, "utf8")).subscriptions,
    ).toEqual([]);
    const savedSlots = JSON.parse(await readFile(stateFile, "utf8")).slots;
    expect(savedSlots[slotC].seen).toEqual(["old-unread", "current"]);
    expect(savedSlots[slotC].unread).toEqual([notice("old-unread", 1)]);

    service.stop();
    const restarted = createNotificationService(options);
    try {
      status = await restarted.status(slotB);
      expect(status.totalUnread).toBe(103);
      expect(status.slots.find((item) => item.slot === slotB)?.unread).toHaveLength(
        100,
      );
      expect(
        JSON.parse(await readFile(`${stateFile}.subscriptions`, "utf8"))
          .subscriptions,
      ).toEqual([subscription]);
    } finally {
      restarted.stop();
    }
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized legacy ledger is preserved without overwriting migrated subscriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-notification-oversize-test-"));
  const stateFile = join(root, "notifications.json");
  const subscription = {
    endpoint: "https://8.8.8.8/push",
    keys: { p256dh: "BvalidPublicKeyValue", auth: "validAuthKey" },
  };
  const slots: Record<
    string,
    {
      initialized: boolean;
      seen: string[];
      seenActions: string[];
      acknowledgedActions: string[];
      unread: Array<{ identity: string; title: string; completedAt: number }>;
    }
  > = {};
  for (let slotIndex = 0; slotIndex < 40; slotIndex += 1) {
    const slot = `rt-legacy-${slotIndex}`;
    slots[slot] = {
      initialized: true,
      seen: [],
      seenActions: [],
      acknowledgedActions: [],
      unread: Array.from({ length: 128 }, (_, noticeIndex) => ({
        identity: `notice-${slotIndex}-${noticeIndex}-${"x".repeat(450)}`,
        title: "Older completion",
        completedAt: noticeIndex + 1,
      })),
    };
  }
  const legacyBytes = `${JSON.stringify({
    version: 1,
    subscriptions: [subscription],
    slots,
  })}\n`;
  expect(Buffer.byteLength(legacyBytes)).toBeGreaterThan(2 * 1024 * 1024);
  await writeFile(stateFile, legacyBytes, { mode: 0o600 });
  const options = {
    ipcRoot: root,
    token: "isolated-notification-oversize-token",
    stateFile,
    listSlots: () => [],
    vapidPublicKey: "",
    vapidPrivateKey: "",
  };
  const service = createNotificationService(options);
  try {
    const status = await service.status();
    expect(status.totalUnread).toBe(40 * 128);
    expect(status.slots).toHaveLength(40);
    expect(status.slots[0]?.unread).toBeUndefined();
    expect(await readFile(stateFile, "utf8")).toBe(legacyBytes);
    expect(
      JSON.parse(await readFile(`${stateFile}.subscriptions`, "utf8"))
        .subscriptions,
    ).toEqual([subscription]);

    service.stop();
    const restarted = createNotificationService(options);
    try {
      const restartedStatus = await restarted.status();
      expect(restartedStatus.totalUnread).toBe(40 * 128);
      expect(restartedStatus.slots).toHaveLength(40);
      expect(await readFile(stateFile, "utf8")).toBe(legacyBytes);
      expect(
        JSON.parse(await readFile(`${stateFile}.subscriptions`, "utf8"))
          .subscriptions,
      ).toEqual([subscription]);
    } finally {
      restarted.stop();
    }
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test("corrupt or unreadable ledgers do not overwrite separate subscriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-notification-corrupt-test-"));
  const stateFile = join(root, "notifications.json");
  const ledgerBytes = "{not-json\n";
  const subscriptionBytes = `${JSON.stringify({
    version: 1,
    subscriptions: [
      {
        endpoint: "https://push.example.invalid/endpoint",
        keys: { p256dh: "BvalidPublicKeyValue", auth: "validAuthKey" },
      },
    ],
  })}\n`;
  await writeFile(stateFile, ledgerBytes, { mode: 0o600 });
  await writeFile(`${stateFile}.subscriptions`, subscriptionBytes, {
    mode: 0o600,
  });
  const service = createNotificationService({
    ipcRoot: root,
    token: "isolated-notification-corrupt-token",
    stateFile,
    listSlots: () => [],
    vapidPublicKey: "",
    vapidPrivateKey: "",
  });
  try {
    await expect(service.status()).rejects.toThrow();
    expect(await readFile(stateFile, "utf8")).toBe(ledgerBytes);
    expect(await readFile(`${stateFile}.subscriptions`, "utf8")).toBe(
      subscriptionBytes,
    );

    await writeFile(stateFile, "{}", { mode: 0o600 });
    await chmod(stateFile, 0o000);
    await expect(service.status()).rejects.toThrow("notification ledger is unreadable");
    expect(await readFile(`${stateFile}.subscriptions`, "utf8")).toBe(
      subscriptionBytes,
    );
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }
});
