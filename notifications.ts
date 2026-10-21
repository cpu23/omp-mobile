import { createConnection, type Socket } from "node:net";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { lookup } from "node:dns/promises";
import { isSlotId } from "./shared";

/**
 * Notifications are keyed by the live runtime identity (see shared.ts
 * `SlotId`), never by a fixed slot table. Identities are discovered on every
 * poll: from `listSlots` when the gateway provides it, otherwise from the
 * `<runtime-id>.sock` extension sockets under `ipcRoot`.
 */
export type NotificationSlot = string;

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};
export type CompletionNotice = {
  identity: string;
  title: string;
  completedAt: number;
};
export type ActionNeededKind = "approval" | "ask" | "plan" | "dialog";
export type ActionNeededNotice = {
  identity: string;
  kind: ActionNeededKind;
  title: string;
  actionTitle: string;
  createdAt: number;
};
export type NotificationSlotStatus = {
  slot: NotificationSlot;
  unread: CompletionNotice[];
  latest?: CompletionNotice;
  actionNeeded?: ActionNeededNotice & { unread: boolean };
};
export type NotificationStatus = {
  enabled: boolean;
  publicKey?: string;
  slots: NotificationSlotStatus[];
  totalUnread: number;
};

type StoredSlot = {
  initialized?: boolean;
  lastObserved?: string;
  seen: string[];
  seenActions: string[];
  acknowledgedActions: string[];
  unread: CompletionNotice[];
  actionNeeded?: ActionNeededNotice;
};
type StoredState = {
  version: 1;
  subscriptions: PushSubscriptionInput[];
  slots: Record<string, StoredSlot>;
};
type WebPush = {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: PushSubscriptionInput,
    payload: string,
    options?: { TTL?: number },
  ): Promise<unknown>;
};
type StoredVapidKeys = { version: 1; publicKey: string; privateKey: string };

export type NotificationServiceOptions = {
  ipcRoot: string;
  token: string;
  stateFile?: string;
  pollIntervalMs?: number;
  vapidSubject?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  /**
   * Active runtime ids. When omitted, `ipcRoot` is scanned for
   * `<runtime-id>.sock` extension sockets instead.
   */
  listSlots?: () => Promise<string[]> | string[];
};
export type NotificationService = {
  start(): void;
  stop(): void;
  pollOnce(): Promise<void>;
  getPublicKey(): string | undefined;
  status(): Promise<NotificationStatus>;
  subscribe(subscription: PushSubscriptionInput): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  ack(slot: NotificationSlot, identity: string): Promise<void>;
};

const MAX_ENDPOINT = 2048;
const MAX_IDENTITY = 512;
const MAX_TITLE = 200;
const MAX_UNREAD = 128;
const MAX_SEEN = 256;
const MAX_TRACKED_SLOTS = 128;
const DEFAULT_STATE_FILE = join(
  process.env.HOME ?? "/tmp",
  ".local/state/omp-mobile/notifications.json",
);
const DEFAULT_INTERVAL = 3000;

function blankSlot(): StoredSlot {
  return {
    initialized: false,
    seen: [],
    seenActions: [],
    acknowledgedActions: [],
    unread: [],
  };
}
function blankState(): StoredState {
  return {
    version: 1,
    subscriptions: [],
    slots: {},
  };
}
function asString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}
function validVapidKeyPair(value: unknown): value is StoredVapidKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredVapidKeys>;
  if (
    candidate.version !== 1 ||
    !validBase64Url(candidate.publicKey) ||
    !validBase64Url(candidate.privateKey)
  )
    return false;
  try {
    return (
      Buffer.from(candidate.publicKey, "base64url").length === 65 &&
      Buffer.from(candidate.privateKey, "base64url").length === 32
    );
  } catch {
    return false;
  }
}

async function loadVapidKeys(
  path: string,
): Promise<StoredVapidKeys | undefined> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096)
      return undefined;
    const value = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    return validVapidKeyPair(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function saveVapidKeys(
  path: string,
  keys: StoredVapidKeys,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, path);
}
function validBase64Url(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 512 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
function privateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (
    value === "localhost" ||
    value === "localhost.localdomain" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local")
  )
    return true;
  if (value.includes(":")) {
    const normalized = value.replace(/^\[|\]$/g, "");
    if (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    )
      return true;
    if (normalized.startsWith("::ffff:"))
      return privateAddress(normalized.slice("::ffff:".length));
  }
  const parts = value.split(".").map(Number);
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Reject non-HTTPS, local, link-local, and private push destinations before web-push performs a request. */
export async function validatePushEndpoint(endpoint: string): Promise<string> {
  if (
    typeof endpoint !== "string" ||
    endpoint.length === 0 ||
    endpoint.length > MAX_ENDPOINT
  )
    throw new Error("push endpoint is invalid");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("push endpoint is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port === "80"
  )
    throw new Error("push endpoint must be an HTTPS URL");
  if (url.hostname.length === 0 || privateAddress(url.hostname))
    throw new Error("push endpoint destination is not allowed");
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (
      !addresses.length ||
      addresses.some((item) => privateAddress(item.address))
    )
      throw new Error("push endpoint destination is not allowed");
  } catch (error) {
    if (error instanceof Error && error.message.includes("not allowed"))
      throw error;
    throw new Error("push endpoint host could not be validated");
  }
  return url.toString();
}

function safeSubscription(input: PushSubscriptionInput): PushSubscriptionInput {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.endpoint !== "string" ||
    !input.keys ||
    typeof input.keys !== "object"
  )
    throw new Error("subscription is invalid");
  if (!validBase64Url(input.keys.p256dh) || !validBase64Url(input.keys.auth))
    throw new Error("subscription keys are invalid");
  if (
    input.expirationTime !== undefined &&
    input.expirationTime !== null &&
    (!Number.isFinite(input.expirationTime) || input.expirationTime < 0)
  )
    throw new Error("subscription expiration is invalid");
  return {
    endpoint: input.endpoint,
    keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
    ...(input.expirationTime === undefined
      ? {}
      : { expirationTime: input.expirationTime }),
  };
}

function socketStatus(
  socketPath: string,
  token: string,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    let socket: Socket | undefined;
    const finish = (value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(value);
    };
    try {
      socket = createConnection({ path: socketPath });
    } catch {
      resolve(undefined);
      return;
    }
    socket.setTimeout(2500, () => finish());
    socket.once("error", () => finish());
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1024 * 1024) return finish();
      chunks.push(chunk);
    });
    socket.once("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) return finish();
      const status = /^HTTP\/1\.1\s+(\d{3})/m.exec(raw.slice(0, split));
      if (!status || Number(status[1]) < 200 || Number(status[1]) >= 300)
        return finish();
      try {
        const value = JSON.parse(raw.slice(split + 4)) as unknown;
        finish(
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined,
        );
      } catch {
        finish();
      }
    });
    socket.once("connect", () => {
      socket.write(
        [
          "GET /status HTTP/1.1",
          "Host: omp-mobile",
          "Connection: close",
          `Authorization: Bearer ${token}`,
          `X-OMP-Mobile-Token: ${token}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}

async function loadState(path: string): Promise<StoredState> {
  try {
    const stat = await fs.stat(path);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 2 * 1024 * 1024
    )
      return blankState();
    const value = JSON.parse(
      await fs.readFile(path, "utf8"),
    ) as Partial<StoredState>;
    const result = blankState();
    if (value.version !== 1 || !Array.isArray(value.subscriptions))
      return result;
    result.subscriptions = value.subscriptions
      .filter(
        (item) =>
          item &&
          typeof item.endpoint === "string" &&
          item.keys &&
          typeof item.keys === "object",
      )
      .slice(0, 64) as PushSubscriptionInput[];
    for (const slot of Object.keys(value.slots ?? {}).slice(0, MAX_TRACKED_SLOTS)) {
      if (!isSlotId(slot)) continue;
      const stored = value.slots?.[slot] as Partial<StoredSlot> | undefined;
      if (!stored || typeof stored !== "object") continue;
      const pending = stored.actionNeeded;
      let actionNeeded: ActionNeededNotice | undefined;
      if (pending && typeof pending === "object") {
        const candidate = pending as Record<string, unknown>;
        if (
          typeof candidate.identity === "string" &&
          candidate.identity.length > 0 &&
          candidate.identity.length <= MAX_IDENTITY &&
          (candidate.kind === "approval" ||
            candidate.kind === "ask" ||
            candidate.kind === "plan" ||
            candidate.kind === "dialog") &&
          typeof candidate.title === "string" &&
          candidate.title.length > 0 &&
          candidate.title.length <= MAX_TITLE &&
          typeof candidate.actionTitle === "string" &&
          candidate.actionTitle.length > 0 &&
          candidate.actionTitle.length <= MAX_TITLE &&
          typeof candidate.createdAt === "number" &&
          Number.isFinite(candidate.createdAt)
        ) {
          actionNeeded = {
            identity: candidate.identity,
            kind: candidate.kind,
            title: candidate.title,
            actionTitle: candidate.actionTitle,
            createdAt: candidate.createdAt,
          };
        }
      }
      const acknowledgedActions = Array.isArray(stored.acknowledgedActions)
        ? stored.acknowledgedActions
            .filter(
              (item) =>
                typeof item === "string" && item.length <= MAX_IDENTITY,
            )
            .slice(-MAX_SEEN)
        : [];
      result.slots[slot] = {
        initialized:
          typeof stored.initialized === "boolean"
            ? stored.initialized
            : typeof stored.lastObserved === "string",
        lastObserved:
          typeof stored.lastObserved === "string"
            ? stored.lastObserved.slice(0, MAX_IDENTITY)
            : undefined,
        seen: Array.isArray(stored.seen)
          ? stored.seen
              .filter((item) => typeof item === "string")
              .slice(-MAX_SEEN)
          : [],
        seenActions: Array.isArray(stored.seenActions)
          ? stored.seenActions
              .filter(
                (item) =>
                  typeof item === "string" && item.length <= MAX_IDENTITY,
              )
              .slice(-MAX_SEEN)
          : [],
        acknowledgedActions: acknowledgedActions.slice(-MAX_SEEN),
        unread: Array.isArray(stored.unread)
          ? (stored.unread
              .filter(
                (item) =>
                  item &&
                  typeof item.identity === "string" &&
                  typeof item.title === "string" &&
                  Number.isFinite(item.completedAt),
              )
              .slice(-MAX_UNREAD) as CompletionNotice[])
          : [],
        ...(actionNeeded ? { actionNeeded } : {}),
      };
    }
    return result;
  } catch {
    return blankState();
  }
}

export function createNotificationService(
  options: NotificationServiceOptions,
): NotificationService {
  const stateFile = options.stateFile ?? DEFAULT_STATE_FILE;
  const vapidFile = `${stateFile}.vapid`;
  const interval = Math.max(
    1000,
    Math.min(60_000, options.pollIntervalMs ?? DEFAULT_INTERVAL),
  );
  const publicKeyOverride =
    options.vapidPublicKey ?? process.env.OMP_MOBILE_VAPID_PUBLIC_KEY;
  const privateKeyOverride =
    options.vapidPrivateKey ?? process.env.OMP_MOBILE_VAPID_PRIVATE_KEY;
  const hasVapidOverride =
    publicKeyOverride !== undefined || privateKeyOverride !== undefined;
  let publicKey = publicKeyOverride;
  let privateKey = privateKeyOverride;
  const subject =
    options.vapidSubject ??
    process.env.OMP_MOBILE_VAPID_SUBJECT ??
    "mailto:omp-mobile@localhost";
  let state = blankState();
  let loaded = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let push: WebPush | undefined;
  let pushLoad: Promise<void> | undefined;
  let pollTail: Promise<void> = Promise.resolve();
  let polling = false;
  let saveTail: Promise<void> = Promise.resolve();
  /** Ids from the most recent successful discovery; drives status(). */
  const activeSlots = new Set<string>();

  const save = () => {
    const snapshot = JSON.stringify(state);
    saveTail = saveTail
      .then(async () => {
        await fs.mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
        const temporary = `${stateFile}.${process.pid}.tmp`;
        await fs.writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, stateFile);
      })
      .catch(() => undefined);
    return saveTail;
  };
  const ensureLoaded = async () => {
    if (loaded) return;
    state = await loadState(stateFile);
    const subscriptions: PushSubscriptionInput[] = [];
    for (const candidate of state.subscriptions) {
      try {
        const endpoint = await validatePushEndpoint(candidate.endpoint);
        subscriptions.push(safeSubscription({ ...candidate, endpoint }));
      } catch {
        // Drop malformed or newly-private destinations from the owner-only store.
      }
    }
    state.subscriptions = subscriptions;
    loaded = true;
    await save();
  };
  const ensurePush = async () => {
    if (push || pushLoad) return pushLoad;
    pushLoad = (async () => {
      try {
        const imported = await (
          new Function("specifier", "return import(specifier)") as (
            specifier: string,
          ) => Promise<Record<string, unknown>>
        )("web-push");
        const candidate = (imported.default ?? imported) as unknown as WebPush;
        if (!hasVapidOverride) {
          const stored = await loadVapidKeys(vapidFile);
          if (stored) {
            publicKey = stored.publicKey;
            privateKey = stored.privateKey;
          } else {
            const generated = candidate.generateVAPIDKeys();
            const keys: StoredVapidKeys = {
              version: 1,
              publicKey: generated.publicKey,
              privateKey: generated.privateKey,
            };
            if (!validVapidKeyPair(keys))
              throw new Error("web-push generated invalid VAPID keys");
            await saveVapidKeys(vapidFile, keys);
            publicKey = keys.publicKey;
            privateKey = keys.privateKey;
          }
        }
        if (!publicKey || !privateKey) return;
        candidate.setVapidDetails(subject, publicKey, privateKey);
        push = candidate;
      } catch {
        push = undefined;
      }
    })();
    await pushLoad;
    return pushLoad;
  };
  const send = async (
    slot: NotificationSlot,
    notice: CompletionNotice | ActionNeededNotice,
  ) => {
    await ensurePush();
    if (!push || !state.subscriptions.length) return;
    const payload =
      "completedAt" in notice
        ? JSON.stringify({
            type: "completion",
            slot,
            title: notice.title,
            identity: notice.identity,
            completedAt: notice.completedAt,
          })
        : JSON.stringify({
            type: "action-needed",
            slot,
            title: notice.title,
            actionTitle: notice.actionTitle,
            identity: notice.identity,
            kind: notice.kind,
            createdAt: notice.createdAt,
          });
    const expired: string[] = [];
    await Promise.all(
      state.subscriptions.map(async (subscription) => {
        try {
          await push?.sendNotification(subscription, payload, { TTL: 86400 });
        } catch (error) {
          const status =
            typeof error === "object" && error && "statusCode" in error
              ? Number((error as { statusCode?: unknown }).statusCode)
              : 0;
          if (status === 404 || status === 410)
            expired.push(subscription.endpoint);
        }
      }),
    );
    if (expired.length) {
      state.subscriptions = state.subscriptions.filter(
        (item) => !expired.includes(item.endpoint),
      );
      await save();
    }
  };
  /**
   * `undefined` means discovery failed. A successful empty result is
   * authoritative; the gateway keeps its last known ids through daemon outages.
   */
  const discoverSlots = async (): Promise<string[] | undefined> => {
    if (options.listSlots) {
      try {
        const listed = await options.listSlots();
        return [...new Set(listed)].filter(isSlotId).slice(0, MAX_TRACKED_SLOTS);
      } catch {
        return undefined;
      }
    }
    try {
      const entries = await fs.readdir(options.ipcRoot, { withFileTypes: true });
      const ids: string[] = [];
      for (const entry of entries) {
        if (!entry.name.endsWith(".sock")) continue;
        const id = entry.name.slice(0, -".sock".length);
        if (!isSlotId(id)) continue;
        if (!entry.isFile() && !entry.isSocket()) continue;
        ids.push(id);
      }
      return ids.slice(0, MAX_TRACKED_SLOTS);
    } catch {
      return undefined;
    }
  };
  /** Clear inactive action prompts while retaining their independent completion notices. */
  const pruneSlots = (active: readonly string[]): boolean => {
    const live = new Set(active);
    let changed = false;
    for (const slot of Object.keys(state.slots)) {
      const stored = state.slots[slot];
      if (live.has(slot)) continue;
      if (stored.actionNeeded) {
        delete stored.actionNeeded;
        changed = true;
      }
      if (stored.unread.length === 0) {
        delete state.slots[slot];
        changed = true;
      }
    }
    let overflow = Object.keys(state.slots).length - MAX_TRACKED_SLOTS;
    for (const slot of Object.keys(state.slots)) {
      if (overflow <= 0) break;
      if (live.has(slot) || state.slots[slot].unread.length > 0) continue;
      delete state.slots[slot];
      overflow -= 1;
      changed = true;
    }
    return changed;
  };
  const pollOnce = async () => {
    await ensureLoaded();
    if (polling) return pollTail;
    polling = true;
    pollTail = (async () => {
      const active = await discoverSlots();
      if (!active) return;
      activeSlots.clear();
      for (const slot of active) activeSlots.add(slot);
      for (const slot of active) {
        const raw = await socketStatus(
          join(options.ipcRoot, `${slot}.sock`),
          options.token,
        );
        if (!raw) continue;
        const entry = (state.slots[slot] ??= blankSlot());
        const completion =
          raw.completion && typeof raw.completion === "object"
            ? (raw.completion as Record<string, unknown>)
            : undefined;
        const identity = asString(completion?.identity, MAX_IDENTITY);
        const title = asString(raw.title, MAX_TITLE) ?? slot;
        let changed = false;
        let completionNotice: CompletionNotice | undefined;
        if (!entry.initialized) {
          entry.initialized = true;
          changed = true;
          if (identity) {
            entry.lastObserved = identity;
            if (!entry.seen.includes(identity)) entry.seen.push(identity);
          }
        } else if (identity && entry.lastObserved !== identity) {
          entry.lastObserved = identity;
          changed = true;
          if (!entry.seen.includes(identity)) {
            entry.seen.push(identity);
            if (entry.seen.length > MAX_SEEN)
              entry.seen = entry.seen.slice(-MAX_SEEN);
            const completedAt =
              typeof completion?.completedAt === "number" &&
              Number.isFinite(completion.completedAt)
                ? completion.completedAt
                : Date.now();
            completionNotice = { identity, title, completedAt };
            entry.unread.push(completionNotice);
            if (entry.unread.length > MAX_UNREAD)
              entry.unread = entry.unread.slice(-MAX_UNREAD);
          }
        }

        const pending =
          raw.pendingAction &&
          typeof raw.pendingAction === "object" &&
          !Array.isArray(raw.pendingAction)
            ? (raw.pendingAction as Record<string, unknown>)
            : undefined;
        const pendingIdentity = asString(pending?.id, MAX_IDENTITY);
        const pendingKind = pending?.kind;
        const pendingTitle = asString(pending?.title, MAX_TITLE);
        let actionPushNotice: ActionNeededNotice | undefined;
        if (
          pendingIdentity &&
          (pendingKind === "approval" ||
            pendingKind === "ask" ||
            pendingKind === "plan" ||
            pendingKind === "dialog") &&
          pendingTitle
        ) {
          const prior = entry.actionNeeded;
          const actionNotice: ActionNeededNotice = {
            identity: pendingIdentity,
            kind: pendingKind,
            title,
            actionTitle: pendingTitle,
            createdAt:
              prior?.identity === pendingIdentity ? prior.createdAt : Date.now(),
          };
          if (prior?.identity !== pendingIdentity) {
            entry.actionNeeded = actionNotice;
            if (!entry.seenActions.includes(pendingIdentity)) {
              entry.seenActions.push(pendingIdentity);
              if (entry.seenActions.length > MAX_SEEN)
                entry.seenActions = entry.seenActions.slice(-MAX_SEEN);
              actionPushNotice = actionNotice;
            }
            changed = true;
          } else if (
            prior.title !== actionNotice.title ||
            prior.actionTitle !== actionNotice.actionTitle ||
            prior.kind !== actionNotice.kind
          ) {
            entry.actionNeeded = actionNotice;
            changed = true;
          }
        } else if (entry.actionNeeded) {
          delete entry.actionNeeded;
          changed = true;
        }
        if (changed) await save();
        if (completionNotice) await send(slot, completionNotice);
        if (actionPushNotice) await send(slot, actionPushNotice);
      }
      if (pruneSlots(active)) await save();
    })().finally(() => {
      polling = false;
    });
    return pollTail;
  };
  return {
    start() {
      if (running) return;
      running = true;
      void ensurePush();
      void pollOnce();
      timer = setInterval(() => {
        void pollOnce();
      }, interval);
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    pollOnce,
    getPublicKey: () => (publicKey && privateKey ? publicKey : undefined),
    async status() {
      await ensureLoaded();
      await ensurePush();
      const seen = new Set<string>();
      const slots: NotificationSlotStatus[] = [];
      const collect = (slot: string) => {
        const item = state.slots[slot] ?? blankSlot();
        seen.add(slot);
        slots.push({
          slot,
          unread: [...item.unread],
          latest: item.unread[item.unread.length - 1],
          ...(item.actionNeeded
            ? {
                actionNeeded: {
                  ...item.actionNeeded,
                  unread: !item.acknowledgedActions.includes(
                    item.actionNeeded.identity,
                  ),
                },
              }
            : {}),
        });
      };
      for (const slot of activeSlots) collect(slot);
      for (const slot of Object.keys(state.slots)) {
        const item = state.slots[slot];
        if (
          seen.has(slot) ||
          (item.unread.length === 0 && !item.actionNeeded)
        )
          continue;
        collect(slot);
      }
      return {
        enabled: Boolean(push),
        ...(push && publicKey ? { publicKey } : {}),
        slots,
        totalUnread: slots.reduce(
          (total, item) =>
            total +
            item.unread.length +
            (item.actionNeeded?.unread ? 1 : 0),
          0,
        ),
      };
    },
    async subscribe(subscription) {
      await ensureLoaded();
      await ensurePush();
      if (!push || !publicKey || !privateKey)
        throw new Error("web push is not configured");
      const endpoint = await validatePushEndpoint(subscription.endpoint);
      const safe = safeSubscription({ ...subscription, endpoint });
      state.subscriptions = state.subscriptions.filter(
        (item) => item.endpoint !== endpoint,
      );
      state.subscriptions.push(safe);
      if (state.subscriptions.length > 64)
        state.subscriptions = state.subscriptions.slice(-64);
      await save();
    },
    async unsubscribe(endpoint) {
      await ensureLoaded();
      if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT)
        throw new Error("push endpoint is invalid");
      state.subscriptions = state.subscriptions.filter(
        (item) => item.endpoint !== endpoint,
      );
      await save();
    },
    async ack(slot, identity) {
      await ensureLoaded();
      if (!isSlotId(slot) || !asString(identity, MAX_IDENTITY))
        throw new Error("notification identity is invalid");
      const entry = state.slots[slot];
      if (entry) {
        entry.unread = entry.unread.filter(
          (item) => item.identity !== identity,
        );
        if (
          entry.actionNeeded?.identity === identity &&
          !entry.acknowledgedActions.includes(identity)
        ) {
          entry.acknowledgedActions.push(identity);
          if (entry.acknowledgedActions.length > MAX_SEEN)
            entry.acknowledgedActions =
              entry.acknowledgedActions.slice(-MAX_SEEN);
        }
      }
      await save();
    },
  };
}
