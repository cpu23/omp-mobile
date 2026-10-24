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
  unreadCount: number;
  unread?: CompletionNotice[];
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
  seenAt?: Record<string, number>;
  seenActionsAt?: Record<string, number>;
  unread: CompletionNotice[];
  actionNeeded?: ActionNeededNotice;
};
type StoredState = {
  version: 1 | 2;
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
  status(activeSlot?: NotificationSlot): Promise<NotificationStatus>;
  subscribe(subscription: PushSubscriptionInput): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  ack(slot: NotificationSlot, identities: readonly string[]): Promise<void>;
};

const MAX_ENDPOINT = 2048;
const MAX_IDENTITY = 512;
const MAX_TITLE = 200;
const MAX_UNREAD = 128;
const MAX_ACK_IDENTITIES = 256;
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_LEGACY_STATE_BYTES = 32 * 1024 * 1024;
const MAX_SUBSCRIPTION_BYTES = 1024 * 1024;
const MAX_HISTORY_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_SLOT_POLLS = 8;
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
    version: 2,
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
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (stat.mode & 0o400) === 0 ||
    stat.size > 4096
  )
    throw new Error("stored VAPID keys are unreadable or oversized");
  const value = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  if (!validVapidKeyPair(value))
    throw new Error("stored VAPID keys are corrupt");
  return value;
}
async function atomicWrite(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, path);
}
async function saveVapidKeys(
  path: string,
  keys: StoredVapidKeys,
): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(keys)}\n`);
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

type LoadedState = {
  state: StoredState;
  legacy: boolean;
  oversized: boolean;
};

async function loadState(path: string): Promise<LoadedState> {
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        state: blankState(),
        legacy: false,
        oversized: false,
      };
    throw error;
  }
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (stat.mode & 0o400) === 0
  )
    throw new Error("notification ledger is unreadable");
  if (stat.size > MAX_LEGACY_STATE_BYTES)
    throw new Error("notification ledger exceeds the legacy read limit");
  const value = JSON.parse(await fs.readFile(path, "utf8")) as Partial<StoredState>;
  if (
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.subscriptions) ||
    !value.slots ||
    typeof value.slots !== "object" ||
    Array.isArray(value.slots)
  )
    throw new Error("notification ledger is corrupt");
  const result = blankState();
  result.subscriptions = value.subscriptions
    .filter(
      (item) =>
        item &&
        typeof item.endpoint === "string" &&
        item.keys &&
        typeof item.keys === "object",
    )
    .slice(0, 64) as PushSubscriptionInput[];
  const now = Date.now();
  const loadIdentities = (items: unknown): string[] =>
    Array.isArray(items)
      ? items
          .filter(
            (item) => typeof item === "string" && item.length > 0 && item.length <= MAX_IDENTITY,
          )
          .slice(-MAX_SEEN)
      : [];
  const loadTimes = (
    value: unknown,
    identities: string[],
  ): Record<string, number> => {
    const source =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return Object.fromEntries(
      identities.map((identity) => [
        identity,
        typeof source[identity] === "number" && Number.isFinite(source[identity])
          ? source[identity]
          : now,
      ]),
    );
  };
  for (const slot of Object.keys(value.slots)) {
    if (!isSlotId(slot)) continue;
    const stored = value.slots[slot] as Partial<StoredSlot> | undefined;
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
    const seen = loadIdentities(stored.seen);
    const seenActions = loadIdentities(stored.seenActions);
    const acknowledgedActions = loadIdentities(stored.acknowledgedActions);
    const unread = Array.isArray(stored.unread)
      ? stored.unread
          .filter(
            (item) =>
              item &&
              typeof item.identity === "string" &&
              item.identity.length > 0 &&
              item.identity.length <= MAX_IDENTITY &&
              typeof item.title === "string" &&
              item.title.length > 0 &&
              item.title.length <= MAX_TITLE &&
              Number.isFinite(item.completedAt),
          )
          .slice(-MAX_UNREAD) as CompletionNotice[]
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
      seen,
      seenActions,
      acknowledgedActions,
      seenAt: loadTimes(stored.seenAt, seen),
      seenActionsAt: loadTimes(stored.seenActionsAt, seenActions),
      unread,
      ...(actionNeeded ? { actionNeeded } : {}),
    };
  }
  return {
    state: result,
    legacy: value.version === 1,
    oversized: stat.size > MAX_LEDGER_BYTES,
  };
}

async function loadSubscriptions(
  path: string,
): Promise<PushSubscriptionInput[] | undefined> {
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (stat.mode & 0o400) === 0 ||
    stat.size > MAX_SUBSCRIPTION_BYTES
  )
    throw new Error("push subscription store is unreadable or oversized");
  const value = JSON.parse(await fs.readFile(path, "utf8")) as {
    version?: unknown;
    subscriptions?: unknown;
  };
  if (value.version !== 1 || !Array.isArray(value.subscriptions))
    throw new Error("push subscription store is corrupt");
  return value.subscriptions
    .filter(
      (item) =>
        item &&
        typeof item.endpoint === "string" &&
        item.keys &&
        typeof item.keys === "object",
    )
    .slice(0, 64) as PushSubscriptionInput[];
}

function pruneHistory(state: StoredState, now: number): boolean {
  const cutoff = now - MAX_HISTORY_AGE_MS;
  let changed = false;
  for (const entry of Object.values(state.slots)) {
    const unreadIds = new Set(entry.unread.map((item) => item.identity));
    const keepSeen = new Set([
      ...unreadIds,
      ...(entry.lastObserved ? [entry.lastObserved] : []),
    ]);
    const seen = entry.seen.filter(
      (identity) =>
        keepSeen.has(identity) ||
        (entry.seenAt?.[identity] ?? now) >= cutoff,
    );
    const seenActions = entry.seenActions.filter(
      (identity) =>
        identity === entry.actionNeeded?.identity ||
        (entry.seenActionsAt?.[identity] ?? now) >= cutoff,
    );
    const actionSet = new Set(seenActions);
    const acknowledgedActions = entry.acknowledgedActions.filter((identity) =>
      identity === entry.actionNeeded?.identity
        ? actionSet.has(identity)
        : (entry.seenActionsAt?.[identity] ?? now) >= cutoff,
    );
    const seenChanged = seen.length !== entry.seen.length;
    const seenActionsChanged = seenActions.length !== entry.seenActions.length;
    const acknowledgedActionsChanged =
      acknowledgedActions.length !== entry.acknowledgedActions.length;
    if (seenChanged) {
      entry.seen = seen;
      entry.seenAt = Object.fromEntries(
        seen.map((identity) => [identity, entry.seenAt?.[identity] ?? now]),
      );
    }
    if (seenActionsChanged) {
      entry.seenActions = seenActions;
      entry.seenActionsAt = Object.fromEntries(
        seenActions.map((identity) => [
          identity,
          entry.seenActionsAt?.[identity] ?? now,
        ]),
      );
    }
    if (acknowledgedActionsChanged)
      entry.acknowledgedActions = acknowledgedActions;
    if (seenChanged || seenActionsChanged || acknowledgedActionsChanged)
      changed = true;
  }
  return changed;
}

class NotificationLedgerCapacityError extends Error {
  constructor() {
    super(
      `notification ledger exceeds ${MAX_LEDGER_BYTES} bytes with unacknowledged notices retained`,
    );
    this.name = "NotificationLedgerCapacityError";
  }
}

function serializeBoundedLedger(state: StoredState): string {
  pruneHistory(state, Date.now());
  const ledger = () =>
    JSON.stringify({ version: 2, subscriptions: [], slots: state.slots });
  let snapshot = ledger();
  if (Buffer.byteLength(snapshot) + 1 <= MAX_LEDGER_BYTES) return snapshot;

  // Drop old duplicate-suppression identities first; unread notices and the
  // currently pending action are never candidates for pruning.
  const candidates: Array<{
    entry: StoredSlot;
    field: "seen" | "seenActions";
    identity: string;
    at: number;
  }> = [];
  for (const entry of Object.values(state.slots)) {
    const unreadIds = new Set(entry.unread.map((item) => item.identity));
    for (const identity of entry.seen) {
      if (unreadIds.has(identity) || identity === entry.lastObserved) continue;
      candidates.push({
        entry,
        field: "seen",
        identity,
        at: entry.seenAt?.[identity] ?? 0,
      });
    }
    for (const identity of entry.seenActions) {
      if (identity === entry.actionNeeded?.identity) continue;
      candidates.push({
        entry,
        field: "seenActions",
        identity,
        at: entry.seenActionsAt?.[identity] ?? 0,
      });
    }
  }
  candidates.sort((left, right) => left.at - right.at);
  let removedSinceCheck = 0;
  for (const candidate of candidates) {
    const list = candidate.entry[candidate.field];
    const index = list.indexOf(candidate.identity);
    if (index < 0) continue;
    list.splice(index, 1);
    if (candidate.field === "seen") {
      if (candidate.entry.seenAt)
        delete candidate.entry.seenAt[candidate.identity];
    } else {
      if (candidate.entry.seenActionsAt)
        delete candidate.entry.seenActionsAt[candidate.identity];
      candidate.entry.acknowledgedActions =
        candidate.entry.acknowledgedActions.filter(
          (identity) => identity !== candidate.identity,
        );
    }
    removedSinceCheck += 1;
    if (removedSinceCheck >= 1024) {
      snapshot = ledger();
      if (Buffer.byteLength(snapshot) + 1 <= MAX_LEDGER_BYTES) return snapshot;
      removedSinceCheck = 0;
    }
  }
  snapshot = ledger();
  if (Buffer.byteLength(snapshot) + 1 <= MAX_LEDGER_BYTES) return snapshot;
  throw new NotificationLedgerCapacityError();
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
  const subscriptionsFile = `${stateFile}.subscriptions`;
  let state = blankState();
  let loaded = false;
  let subscriptions: PushSubscriptionInput[] = [];
  let deliverySubscriptions: PushSubscriptionInput[] = [];
  let loading: Promise<void> | undefined;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let push: WebPush | undefined;
  let pushLoad: Promise<void> | undefined;
  let pollTail: Promise<void> = Promise.resolve();
  let polling = false;
  let saveTail: Promise<void> = Promise.resolve();
  let subscriptionSaveTail: Promise<void> = Promise.resolve();
  /** Ids from the most recent successful discovery; drives status(). */
  const activeSlots = new Set<string>();
  let ledgerDirty = false;
  let ledgerWriteRevision = 0;
  let subscriptionsDirty = false;
  let subscriptionWriteRevision = 0;
  const pendingDeliveries: Array<{
    slot: string;
    notice: CompletionNotice | ActionNeededNotice;
  }> = [];

  const queueWrite = (
    path: string,
    content: string,
    tail: Promise<void>,
  ): Promise<void> => {
    const write = tail.catch(() => undefined).then(() =>
      atomicWrite(path, content),
    );
    if (path === stateFile) saveTail = write;
    else subscriptionSaveTail = write;
    return write;
  };
  const save = () => {
    ledgerDirty = true;
    const revision = ++ledgerWriteRevision;
    const snapshot = `${serializeBoundedLedger(state)}\n`;
    return queueWrite(stateFile, snapshot, saveTail).then(() => {
      if (ledgerWriteRevision === revision) ledgerDirty = false;
    });
  };
  const saveSubscriptions = () => {
    subscriptionsDirty = true;
    const revision = ++subscriptionWriteRevision;
    const snapshot = `${JSON.stringify({ version: 1, subscriptions })}\n`;
    if (Buffer.byteLength(snapshot) > MAX_SUBSCRIPTION_BYTES)
      throw new Error("push subscription store exceeds its byte limit");
    return queueWrite(subscriptionsFile, snapshot, subscriptionSaveTail).then(() => {
      if (subscriptionWriteRevision === revision) subscriptionsDirty = false;
    });
  };
  const ensureLoaded = () => {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      const stored = await loadState(stateFile);
      const separateSubscriptions = await loadSubscriptions(subscriptionsFile);
      state = stored.state;
      const sourceSubscriptions =
        separateSubscriptions ?? stored.state.subscriptions;
      const durableSubscriptions: PushSubscriptionInput[] = [];
      for (const candidate of sourceSubscriptions) {
        try {
          durableSubscriptions.push(safeSubscription(candidate));
        } catch {
          // Malformed credentials are not safe to retain or deliver.
        }
      }
      subscriptions = durableSubscriptions;

      // Persist credentials before cutting over the legacy combined file. If this
      // write fails, the original store remains byte-for-byte available for retry.
      if (
        !separateSubscriptions &&
        (stored.legacy || stored.state.subscriptions.length > 0)
      )
        await saveSubscriptions();
      const validSubscriptions: PushSubscriptionInput[] = [];
      for (const candidate of durableSubscriptions) {
        try {
          const endpoint = await validatePushEndpoint(candidate.endpoint);
          validSubscriptions.push(safeSubscription({ ...candidate, endpoint }));
        } catch {
          // Delivery uses only destinations that still pass the network policy.
        }
      }
      deliverySubscriptions = validSubscriptions;
      if (
        stored.legacy ||
        stored.oversized ||
        stored.state.subscriptions.length > 0
      ) {
        try {
          await save();
        } catch (error) {
          console.error(
            "Notification ledger migration could not be persisted; preserving loaded state",
            error,
          );
        }
      }
      loaded = true;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  };
  const ensurePush = async () => {
    if (push || pushLoad) return pushLoad;
    pushLoad = (async () => {
      let imported: Record<string, unknown>;
      try {
        imported = await (
          new Function("specifier", "return import(specifier)") as (
            specifier: string,
          ) => Promise<Record<string, unknown>>
        )("web-push");
      } catch {
        push = undefined;
        return;
      }
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
    })();
    await pushLoad;
    return pushLoad;
  };
  const send = async (
    slot: NotificationSlot,
    notice: CompletionNotice | ActionNeededNotice,
  ) => {
    await ensurePush();
    if (!push || !deliverySubscriptions.length) return;
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
      deliverySubscriptions.map(async (subscription) => {
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
      subscriptions = subscriptions.filter(
        (item) => !expired.includes(item.endpoint),
      );
      deliverySubscriptions = deliverySubscriptions.filter(
        (item) => !expired.includes(item.endpoint),
      );
      subscriptionsDirty = true;
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
  const pollSlot = async (
    slot: string,
    pendingPushes: Array<{
      slot: string;
      notice: CompletionNotice | ActionNeededNotice;
    }>,
    recordChanged: () => void,
  ) => {
    const raw = await socketStatus(
      join(options.ipcRoot, `${slot}.sock`),
      options.token,
    );
    if (!raw) return;
    const entry = (state.slots[slot] ??= blankSlot());
    const completion =
      raw.completion && typeof raw.completion === "object"
        ? (raw.completion as Record<string, unknown>)
        : undefined;
    const identity = asString(completion?.identity, MAX_IDENTITY);
    const title = asString(raw.title, MAX_TITLE) ?? slot;
    const now = Date.now();
    let changed = false;
    let completionNotice: CompletionNotice | undefined;
    if (!entry.initialized) {
      entry.initialized = true;
      changed = true;
      if (identity) {
        entry.lastObserved = identity;
        if (!entry.seen.includes(identity)) {
          entry.seen.push(identity);
          (entry.seenAt ??= {})[identity] = now;
        }
      }
    } else if (identity && entry.lastObserved !== identity) {
      entry.lastObserved = identity;
      changed = true;
      if (!entry.seen.includes(identity)) {
        entry.seen.push(identity);
        (entry.seenAt ??= {})[identity] = now;
        if (entry.seen.length > MAX_SEEN) {
          const removed = entry.seen.splice(0, entry.seen.length - MAX_SEEN);
          for (const item of removed) delete entry.seenAt[item];
        }
        const completedAt =
          typeof completion?.completedAt === "number" &&
          Number.isFinite(completion.completedAt)
            ? completion.completedAt
            : now;
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
          prior?.identity === pendingIdentity ? prior.createdAt : now,
      };
      if (prior?.identity !== pendingIdentity) {
        entry.actionNeeded = actionNotice;
        if (!entry.seenActions.includes(pendingIdentity)) {
          entry.seenActions.push(pendingIdentity);
          (entry.seenActionsAt ??= {})[pendingIdentity] = now;
          if (entry.seenActions.length > MAX_SEEN) {
            const removed = entry.seenActions.splice(
              0,
              entry.seenActions.length - MAX_SEEN,
            );
            for (const item of removed) {
              delete entry.seenActionsAt[item];
              entry.acknowledgedActions =
                entry.acknowledgedActions.filter((identity) => identity !== item);
            }
          }
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
    if (changed) recordChanged();
    if (completionNotice)
      pendingPushes.push({ slot, notice: completionNotice });
    if (actionPushNotice)
      pendingPushes.push({ slot, notice: actionPushNotice });
  };
  const pollOnce = async () => {
    await ensureLoaded();
    if (polling) return pollTail;
    polling = true;
    pollTail = (async () => {
      const active = await discoverSlots();
      let stateChanged = false;
      const pendingPushes = pendingDeliveries;
      if (active) {
        activeSlots.clear();
        for (const slot of active) activeSlots.add(slot);
        let nextSlot = 0;
        const workers = Array.from(
          { length: Math.min(MAX_CONCURRENT_SLOT_POLLS, active.length) },
          async () => {
            while (nextSlot < active.length) {
              const index = nextSlot++;
              await pollSlot(active[index], pendingPushes, () => {
                stateChanged = true;
              });
            }
          },
        );
        await Promise.all(workers);
        if (pruneSlots(active)) stateChanged = true;
        if (pruneHistory(state, Date.now())) stateChanged = true;
      }
      if (stateChanged) ledgerDirty = true;
      while (ledgerDirty) await save();
      while (pendingDeliveries.length) {
        const pending = pendingDeliveries[0];
        await send(pending.slot, pending.notice);
        pendingDeliveries.shift();
      }
      while (subscriptionsDirty) await saveSubscriptions();
    })().finally(() => {
      polling = false;
    });
    return pollTail;
  };
  return {
    start() {
      if (running) return;
      running = true;
      void ensurePush().catch((error) =>
        console.error("Mobile notification initialization failed", error),
      );
      void pollOnce().catch((error) =>
        console.error("Mobile notification background poll failed", error),
      );
      timer = setInterval(() => {
        void pollOnce().catch((error) =>
          console.error("Mobile notification background poll failed", error),
        );
      }, interval);
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    pollOnce,
    getPublicKey: () => (publicKey && privateKey ? publicKey : undefined),
    async status(activeSlot) {
      await ensureLoaded();
      await ensurePush();
      if (activeSlot !== undefined && !isSlotId(activeSlot))
        throw new Error("notification slot is invalid");
      const seen = new Set<string>();
      const slots: NotificationSlotStatus[] = [];
      const collect = (slot: string) => {
        const item = state.slots[slot] ?? blankSlot();
        seen.add(slot);
        const actionUnread =
          item.actionNeeded !== undefined &&
          !item.acknowledgedActions.includes(item.actionNeeded.identity);
        slots.push({
          slot,
          unreadCount: item.unread.length + Number(actionUnread),
          ...(slot === activeSlot ? { unread: [...item.unread] } : {}),
          ...(item.unread.length
            ? { latest: { ...item.unread[item.unread.length - 1] } }
            : {}),
          ...(item.actionNeeded
            ? {
                actionNeeded: {
                  ...item.actionNeeded,
                  unread: actionUnread,
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
        totalUnread: slots.reduce((total, item) => total + item.unreadCount, 0),
      };
    },
    async subscribe(subscription) {
      await ensureLoaded();
      await ensurePush();
      if (!push || !publicKey || !privateKey)
        throw new Error("web push is not configured");
      const endpoint = await validatePushEndpoint(subscription.endpoint);
      const safe = safeSubscription({ ...subscription, endpoint });
      subscriptions = subscriptions.filter(
        (item) => item.endpoint !== endpoint,
      );
      subscriptions.push(safe);
      deliverySubscriptions = deliverySubscriptions.filter(
        (item) => item.endpoint !== endpoint,
      );
      deliverySubscriptions.push(safe);
      if (subscriptions.length > 64)
        subscriptions = subscriptions.slice(-64);
      if (deliverySubscriptions.length > 64)
        deliverySubscriptions = deliverySubscriptions.slice(-64);
      await saveSubscriptions();
    },
    async unsubscribe(endpoint) {
      await ensureLoaded();
      if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT)
        throw new Error("push endpoint is invalid");
      subscriptions = subscriptions.filter(
        (item) => item.endpoint !== endpoint,
      );
      deliverySubscriptions = deliverySubscriptions.filter(
        (item) => item.endpoint !== endpoint,
      );
      await saveSubscriptions();
    },
    async ack(slot, identities) {
      await ensureLoaded();
      if (
        !isSlotId(slot) ||
        !Array.isArray(identities) ||
        identities.length > MAX_ACK_IDENTITIES ||
        identities.some((identity) => !asString(identity, MAX_IDENTITY)) ||
        new Set(identities).size !== identities.length
      )
        throw new Error("notification acknowledgement is invalid");
      const entry = state.slots[slot];
      if (!entry) return;
      const identitySet = new Set(identities);
      const unread = entry.unread.filter(
        (item) => !identitySet.has(item.identity),
      );
      let changed = unread.length !== entry.unread.length;
      if (changed) entry.unread = unread;
      for (const identity of identities) {
        if (
          entry.actionNeeded?.identity === identity &&
          !entry.acknowledgedActions.includes(identity)
        ) {
          entry.acknowledgedActions.push(identity);
          if (entry.acknowledgedActions.length > MAX_SEEN)
            entry.acknowledgedActions =
              entry.acknowledgedActions.slice(-MAX_SEEN);
          changed = true;
        }
      }
      if (changed) await save();
    },
  };
}
