import type {
  CapabilityMap,
  CommandResponse,
  CompletionMarker,
  DirectoryEntry,
  DirectoryListing,
  MoveResponse,
  OmpMessage,
  PinsResponse,
  SlotAction,
  SlotId,
  SlotState,
  SlashCommand,
  SlotSummary,
  TerminalSnapshot,
} from "./shared";

type ClientModel = { provider?: string; id?: string; name?: string };
type ClientContext = {
  tokens?: number;
  contextWindow?: number;
  percent?: number;
};
type ClientTheme = Record<string, unknown> & {
  name?: string | null;
  accent?: string | null;
  isLight?: boolean;
  tokens?: Record<string, string>;
};
type ClientCost = { total: number };
type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      output?: string;
      isError?: boolean;
    };
type ChatMessage = {
  role: string;
  entryId: string;
  timestamp: string | null;
  parts: ChatPart[];
};
type ClientMessage = OmpMessage & {
  name?: string;
  tool?: string;
  text?: unknown;
  output?: unknown;
  input?: unknown;
  expanded?: boolean;
  actions?: ClientActionLink[];
  parts?: ChatPart[];
};
type ClientActionLink = { label?: string; title?: string; url?: string };
type ClientState = Omit<
  SlotState,
  "model" | "models" | "effort" | "efforts" | "context" | "theme" | "messages"
> & {
  model: ClientModel | string | null;
  models: Array<ClientModel | string>;
  effort: string | null;
  efforts: string[];
  context: ClientContext | null;
  theme: ClientTheme | null;
  messages: ClientMessage[];
  accent?: string | null;
  cost?: ClientCost | null;
};
type NotificationItem = { slot: SlotId; unread: CompletionMarker[] };
type NotificationsResponse = { slots: NotificationItem[] };
type NotificationConfig = { enabled: boolean; publicKey?: string };
type DirectoryResponse = DirectoryListing;
type SlotsResponse = { slots: SlotSummary[] };
type ApiResult = unknown;
type ApiError = Error & { auth?: boolean; status?: number };
type ApiAction =
  | Omit<Extract<SlotAction, { type: "prompt" }>, "generation">
  | Omit<Extract<SlotAction, { type: "abort" }>, "generation">
  | Omit<Extract<SlotAction, { type: "model" }>, "generation">
  | Omit<Extract<SlotAction, { type: "effort" }>, "generation">
  | Omit<Extract<SlotAction, { type: "command" }>, "generation">
  | Omit<Extract<SlotAction, { type: "move" }>, "generation">;
type RequestOptions = RequestInit & { headers?: HeadersInit };

/**
 * OMP's working indicators, ported from the host:
 * - spinner: `SPINNER_FRAMES.unicode.status`, phase-locked to the epoch like
 *   `sharedSpinnerFrame` in tool-execution.ts (80 ms per glyph).
 * - shimmer: `modes/theme/shimmer.ts` classic profile — fixed 30 cells/s band
 *   travel, cosine bump of half-width 6 with 10 cells of edge padding, three
 *   intensity tiers at 0.65 / 0.22 (low → high).
 */
const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const SPINNER_ADVANCE_MS = 80;
const SHIMMER_SPEED_CELLS_PER_S = 30;
const SHIMMER_PADDING = 10;
const SHIMMER_BAND_HALF_WIDTH = 6;
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

function reduceMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function shimmerTier(time: number, index: number, length: number): 0 | 1 | 2 {
  const period = length + SHIMMER_PADDING * 2;
  const pos =
    ((((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period) + period) % period;
  const dist = Math.abs(index + SHIMMER_PADDING - pos);
  if (dist >= SHIMMER_BAND_HALF_WIDTH) return 0;
  const intensity =
    0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_BAND_HALF_WIDTH));
  return intensity >= TIER_HIGH ? 2 : intensity >= TIER_MID ? 1 : 0;
}

/**
 * Text that shimmers while the host is working. Characters are wrapped once and
 * only their tier class changes per frame, mirroring OMP's run-coalesced ANSI.
 */
function shimmerMarkup(text: string): string {
  return [...text]
    .map(
      (char) => `<span class="shimmer-char" data-tier="0">${esc(char)}</span>`,
    )
    .join("");
}

/** Freezes every shimmer on one tier (reduced motion) or restores the sweep. */
function setShimmerStatic(tier: string | null): void {
  document.querySelectorAll<HTMLElement>(".shimmer").forEach((node) => {
    if (tier) node.dataset.shimmerStatic = tier;
    else delete node.dataset.shimmerStatic;
  });
}

function updateShimmerNodes(time: number): void {
  document.querySelectorAll<HTMLElement>(".shimmer").forEach((node) => {
    const chars = node.querySelectorAll<HTMLElement>(".shimmer-char");
    if (!chars.length) return;
    const length = chars.length;
    const staticTier = node.dataset.shimmerStatic;
    for (let index = 0; index < length; index += 1) {
      const element = chars[index];
      const tier = staticTier
        ? Number(staticTier)
        : shimmerTier(time, index, length);
      const value = String(tier);
      if (element.dataset.tier !== value) element.dataset.tier = value;
    }
  });
}

function updateSpinners(time: number): void {
  const frame =
    SPINNER_FRAMES[
      Math.floor(time / SPINNER_ADVANCE_MS) % SPINNER_FRAMES.length
    ];
  document.querySelectorAll<HTMLElement>(".working-spinner").forEach((node) => {
    if (node.textContent !== frame) node.textContent = frame;
  });
}

let animationFrame = 0;
let animationActive = false;
function animationWanted(): boolean {
  // Hidden nodes keep the composer's working line in the DOM; only elements
  // that actually paint should keep the loop alive.
  for (const node of document.querySelectorAll<HTMLElement>(
    ".shimmer, .working-spinner",
  )) {
    if (node.getClientRects().length > 0) return true;
  }
  return false;
}
function animationTick(): void {
  animationFrame = 0;
  const time = performance.now();
  updateSpinners(time);
  updateShimmerNodes(time);
  if (animationWanted()) {
    animationFrame = window.requestAnimationFrame(animationTick);
  } else {
    animationActive = false;
  }
}
/** Runs the animation loop only while live indicators are on screen. */
function syncAnimation(): void {
  if (
    document.visibilityState !== "visible" ||
    reduceMotion() ||
    !animationWanted()
  ) {
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    animationActive = false;
    // OMP freezes the sweep in its mid tier instead of leaving the text dim.
    setShimmerStatic(reduceMotion() ? "1" : null);
    updateShimmerNodes(0);
    return;
  }
  setShimmerStatic(null);
  if (animationActive) return;
  animationActive = true;
  animationFrame = window.requestAnimationFrame(animationTick);
}

type PushSubscriptionJson = {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: { p256dh?: string; auth?: string };
};

const SLOT_IDS: readonly SlotId[] = [
  "left",
  "right",
  "w2-left",
  "w2-right",
  "w3-left",
  "w3-right",
];
const app = requiredElement<HTMLElement>("#app");
const drafts = new Map<SlotId, string>();
const cache = new Map<SlotId, ClientState>();
let slots: SlotSummary[] = [];
let activeId: SlotId = "left";
let activeState: ClientState | null = null;
let stateRequest = 0;
let modal: HTMLDivElement | null = null;
let toastTimer = 0;
let pins: string[] = [];
let transcriptNearBottom = true;
let lastRenderedMessageCount = 0;
let commandSelection = 0;
let dismissedCommandDraft: string | null = null;
let unreadBySlot = new Map<SlotId, CompletionMarker[]>();
let notificationConfig: NotificationConfig | null = null;
let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
let notificationSubscribed = false;
let notificationBusy = false;
const acknowledging = new Set<SlotId>();
const requestedSlot = new URLSearchParams(window.location.search).get("slot");
if (requestedSlot && SLOT_IDS.includes(requestedSlot as SlotId))
  activeId = requestedSlot as SlotId;

function requiredElement<T extends Element>(
  selector: string,
  root: ParentNode = document,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Required element not found: ${selector}`);
  return element;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isApiError(error: unknown): error is ApiError {
  return error instanceof Error && ("auth" in error || "status" in error);
}
function hasAuth(error: unknown): error is ApiError & { auth: true } {
  return isApiError(error) && error.auth === true;
}
function errorStatus(error: unknown): number | undefined {
  return isApiError(error) ? error.status : undefined;
}

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}
function authToken(): string {
  const saved = localStorage.getItem("omp-mobile-token");
  if (saved) return saved;
  const temporary = sessionStorage.getItem("omp-mobile-token");
  if (temporary) {
    localStorage.setItem("omp-mobile-token", temporary);
    sessionStorage.removeItem("omp-mobile-token");
  }
  return temporary || "";
}
function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  const token = authToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}
async function api<T extends ApiResult = ApiResult>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) },
    credentials: "same-origin",
  });
  if (response.status === 401) {
    document.querySelector("#token-open")?.classList.remove("hidden");
    throw Object.assign(new Error("Authentication required"), {
      auth: true,
      status: 401,
    }) as ApiError;
  }
  if (!response.ok) {
    let detail =
      response.status === 403 ? "Access forbidden" : "Request failed";
    try {
      const body = (await response.json()) as {
        error?: unknown;
        message?: unknown;
      };
      if (typeof body.error === "string") detail = body.error;
      else if (typeof body.message === "string") detail = body.message;
    } catch {}
    throw Object.assign(new Error(detail), {
      status: response.status,
    }) as ApiError;
  }
  document.querySelector("#token-open")?.classList.add("hidden");
  return (response.status === 204 ? null : await response.json()) as T;
}

const ICONS = {
  menu: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`,
  folder: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  key: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>`,
  arrowDown: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`,
  bellDefault: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`,
  bellEnabled: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><circle cx="18" cy="4" r="3" fill="currentColor" stroke="currentColor" stroke-width="1"></circle></svg>`,
  bellDenied: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path><path d="M18 8a6 6 0 0 0-9.33-5"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`,
  terminal: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
  chat: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"></path></svg>`,
  sparkles: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"></path></svg>`,
};
let showReasoning = localStorage.getItem("omp-mobile-reasoning") !== "0";
function applyReasoningToggle(): void {
  const btn = document.querySelector<HTMLButtonElement>("#reasoning-toggle");
  btn?.setAttribute("aria-pressed", showReasoning ? "true" : "false");
  btn?.classList.toggle("active", showReasoning);
  const state = document.querySelector<HTMLElement>("#reasoning-state");
  if (state) state.textContent = showReasoning ? "On" : "Off";
  document
    .querySelectorAll<HTMLDetailsElement>("details.part-thinking")
    .forEach((d) => {
      d.open = showReasoning;
    });
}
const collapsedThinkingKeys = new Set<string>(
  (() => {
    try {
      const stored = sessionStorage.getItem("omp-collapsed-thinking");
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  })(),
);
const expandedThinkingKeys = new Set<string>(
  (() => {
    try {
      const stored = sessionStorage.getItem("omp-expanded-thinking");
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  })(),
);
const expandedToolKeys = new Set<string>();
function persistThinkingOverrides(): void {
  try {
    sessionStorage.setItem(
      "omp-collapsed-thinking",
      JSON.stringify([...collapsedThinkingKeys]),
    );
    sessionStorage.setItem(
      "omp-expanded-thinking",
      JSON.stringify([...expandedThinkingKeys]),
    );
  } catch {}
}
function showToast(
  message: string,
  error = false,
  action?: { label: string; onClick: () => void },
): void {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.setAttribute("role", error ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  node.append(text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      node.remove();
      action.onClick();
    });
    node.append(btn);
  }
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), action ? 8000 : 4500);
}
type NotificationStatus =
  "unavailable" | "unsupported" | "denied" | "ready" | "available";
let cachedPermissionState: PermissionState | NotificationPermission | null =
  null;
async function syncPermissionState(): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    "permissions" in navigator &&
    navigator.permissions?.query
  ) {
    try {
      const status = await navigator.permissions.query({
        name: "notifications" as PermissionName,
      });
      cachedPermissionState = status.state;
      status.onchange = () => {
        cachedPermissionState = status.state;
        updateNotificationButton();
      };
    } catch {
      if ("Notification" in window) {
        cachedPermissionState = Notification.permission;
      }
    }
  } else if ("Notification" in window) {
    cachedPermissionState = Notification.permission;
  }
}
function notificationStatus(): NotificationStatus {
  if (notificationConfig?.enabled === false) return "unavailable";
  if (
    !("Notification" in window) ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  )
    return "unsupported";
  const perm =
    cachedPermissionState ??
    (typeof Notification !== "undefined" ? Notification.permission : "default");
  if (perm === "denied") return "denied";
  if (notificationSubscribed) return "ready";
  return "available";
}
function renderNotificationButton(button: HTMLButtonElement): void {
  const status = notificationStatus();
  button.classList.toggle("enabled", status === "ready");
  button.disabled =
    notificationBusy || status === "unsupported" || status === "unavailable";
  button.setAttribute(
    "aria-label",
    status === "ready"
      ? "Notifications enabled"
      : status === "denied"
        ? "Notifications blocked in settings"
        : "Enable completion notifications",
  );
  button.title =
    status === "denied"
      ? "Notifications are blocked in Android/browser settings. Tap to retry or review."
      : status === "unavailable"
        ? "Push notifications are not configured on this gateway"
        : status === "ready"
          ? "Notifications enabled"
          : "Completion notifications";
  const label =
    status === "ready"
      ? "Notifications enabled"
      : status === "denied"
        ? "Notifications blocked"
        : status === "unavailable"
          ? "Notifications unavailable"
          : "Enable notifications";
  const icon =
    status === "ready"
      ? ICONS.bellEnabled
      : status === "denied"
        ? ICONS.bellDenied
        : ICONS.bellDefault;
  button.innerHTML = `${icon}<span>${label}</span>`;
}
function updateNotificationButton(): void {
  const button = document.querySelector<HTMLButtonElement>(
    "#notifications-enable",
  );
  if (!button) return;
  void syncPermissionState().then(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      "#notifications-enable",
    );
    if (!btn) return;
    renderNotificationButton(btn);
  });
  renderNotificationButton(button);
}

function updateAppBadge(): void {
  const count = [...unreadBySlot.values()].reduce(
    (total, unread) => total + unread.length,
    0,
  );
  const badgeNavigator = navigator as Navigator & {
    setAppBadge?: (value?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (count > 0 && typeof badgeNavigator.setAppBadge === "function")
    badgeNavigator.setAppBadge(count).catch(() => {});
  else if (count === 0 && typeof badgeNavigator.clearAppBadge === "function")
    badgeNavigator.clearAppBadge().catch(() => {});
}
function normalizedUnread(
  result: NotificationsResponse | null | undefined,
): Map<SlotId, CompletionMarker[]> {
  const next = new Map<SlotId, CompletionMarker[]>();
  for (const item of result?.slots ?? []) {
    if (!SLOT_IDS.includes(item.slot)) continue;
    const unread = Array.isArray(item.unread)
      ? item.unread.filter((entry) => typeof entry?.identity === "string")
      : [];
    next.set(item.slot, unread);
  }
  return next;
}
async function loadNotifications(): Promise<void> {
  try {
    const result = await api<NotificationsResponse>("/api/notifications");
    unreadBySlot = normalizedUnread(result);
    updateSlots();
    updateAppBadge();
    if (activeState && document.visibilityState === "visible")
      window.setTimeout(() => acknowledgeSlot(activeId), 0);
  } catch (error: unknown) {
    if (hasAuth(error)) updateNotificationButton();
  }
}
async function acknowledgeSlot(slot: SlotId): Promise<void> {
  if (
    document.visibilityState !== "visible" ||
    slot !== activeId ||
    acknowledging.has(slot)
  )
    return;
  const unread = unreadBySlot.get(slot) || [];
  if (!unread.length) return;
  acknowledging.add(slot);
  try {
    for (const entry of unread)
      await api<void>("/api/notifications/ack", {
        method: "POST",
        body: JSON.stringify({ slot, identity: entry.identity }),
      });
    const acknowledgedIds = new Set(unread.map((entry) => entry.identity));
    const remaining = (unreadBySlot.get(slot) || []).filter(
      (entry) => !acknowledgedIds.has(entry.identity),
    );
    if (remaining.length) unreadBySlot.set(slot, remaining);
    else unreadBySlot.delete(slot);
    updateSlots();
    updateAppBadge();
  } catch (error: unknown) {
    if (!hasAuth(error))
      showToast(`Could not mark ${slotTitle(slotById(slot))} as read`, true);
  } finally {
    acknowledging.delete(slot);
  }
}
function base64UrlBytes(value: string): Uint8Array {
  const raw = value;
  const normalized = raw
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(raw.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function registerNotifications(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register(
      "/sw.js",
      { scope: "/" },
    );
    notificationSubscribed = Boolean(
      await serviceWorkerRegistration.pushManager.getSubscription(),
    );
    navigator.serviceWorker.addEventListener(
      "message",
      (event: MessageEvent<{ type?: string; slot?: string }>) => {
        if (event.data?.type === "omp-notification") void loadNotifications();
        if (event.data?.type === "omp-notification-click") {
          void loadNotifications();
          if (isSlotId(event.data.slot)) {
            selectSlot(event.data.slot);
          }
        }
      },
    );
  } catch {
    serviceWorkerRegistration = null;
    notificationSubscribed = false;
  }
  updateNotificationButton();
}
async function loadNotificationConfig(): Promise<void> {
  try {
    notificationConfig = await api<NotificationConfig>(
      "/api/notifications/config",
    );
  } catch {
    notificationConfig = null;
  }
  updateNotificationButton();
}
function notificationBrowserName(): string {
  const nav = navigator as Navigator & { brave?: unknown };
  if (nav.brave) return "Brave";
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return "Chrome";
  return "This browser";
}
function showBlockedNotificationHelp(): void {
  const origin = location.origin;
  const browser = notificationBrowserName();
  const installed =
    typeof matchMedia === "function" &&
    matchMedia("(display-mode: standalone)").matches;
  const brave = browser === "Brave";
  const path = brave
    ? `${browser} auto-blocks notification prompts for sites you have not allowed, and this is the state it lists as "Automatically blocked". Fix it in ${browser}: menu → Settings → Site settings → Notifications → tap ${origin} and set it to Allow (or remove it from the Blocked list), then come back and tap Retry. Installing OMP from Chrome instead avoids this entirely.`
    : `Open Site settings → Notifications, set ${origin} to Allow, then tap Retry.`;
  const entry = installed
    ? `Open ${origin} in a ${browser} tab first — the installed app has no address bar. `
    : "";
  showToast(
    `Notifications are blocked for ${origin} inside ${browser}, so the Android app setting alone cannot enable them. ${entry}${path} Then tap Retry.`,
    true,
    {
      label: "Retry",
      onClick: () => {
        void enableNotifications();
      },
    },
  );
}
async function enableNotifications(): Promise<void> {
  if (notificationBusy) return;
  await syncPermissionState();
  const status = notificationStatus();
  if (status === "unsupported") {
    showToast("This browser does not support Web Push notifications", true);
    return;
  }
  if (status === "unavailable") {
    showToast("Push notifications are not configured on this gateway", true);
    return;
  }
  if (status === "denied") {
    showBlockedNotificationHelp();
    return;
  }
  notificationBusy = true;
  updateNotificationButton();
  try {
    let perm = cachedPermissionState;
    if (perm !== "granted") {
      perm = await Notification.requestPermission();
      cachedPermissionState = perm;
      await syncPermissionState();
    }
    if (cachedPermissionState === "denied") {
      showBlockedNotificationHelp();
      return;
    }
    if (cachedPermissionState !== "granted") {
      showToast("Notification permission was not granted", true);
      return;
    }
    if (!serviceWorkerRegistration) await registerNotifications();
    const config =
      notificationConfig ||
      (await api<NotificationConfig>("/api/notifications/config"));
    notificationConfig = config;
    if (
      config.enabled !== true ||
      typeof config.publicKey !== "string" ||
      !config.publicKey
    ) {
      showToast("Push notifications are not configured on this gateway", true);
      return;
    }
    if (!serviceWorkerRegistration)
      throw new Error("Service Worker could not be started");
    const existing =
      await serviceWorkerRegistration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await serviceWorkerRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array(base64UrlBytes(config.publicKey))
          .buffer,
      }));
    const json = subscription.toJSON() as PushSubscriptionJson;
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth)
      throw new Error("Browser did not return a valid push subscription");
    await api<void>("/api/notifications/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        subscription: {
          endpoint: json.endpoint,
          keys: json.keys,
          ...(json.expirationTime
            ? { expirationTime: json.expirationTime }
            : {}),
        },
      }),
    });
    notificationSubscribed = true;
    showToast("Notifications enabled");
  } catch (error: unknown) {
    notificationSubscribed = false;
    const browser = notificationBrowserName();
    const raw = errorMessage(error);
    const unreachable =
      /AbortError|NotSupportedError|Registration failed|push service|GCM|network/i.test(
        raw,
      );
    showToast(
      hasAuth(error)
        ? "Access token required for notifications"
        : unreachable
          ? `${browser} could not reach the push service (common when ${browser} runs without Google Play services). Unread badges still work while OMP is open.`
          : `Notifications unavailable: ${raw}`,
      true,
    );
    if (hasAuth(error)) openTokenModal();
  } finally {
    notificationBusy = false;
    updateNotificationButton();
  }
}

function slotTitle(slot: SlotSummary, state?: ClientState | null): string {
  const liveState =
    state !== undefined
      ? state
      : slot.id === activeId
        ? activeState
        : cache.get(slot.id);
  if (liveState?.title && !isSlotId(liveState.title)) return liveState.title;
  const index = SLOT_IDS.indexOf(slot.id);
  const fallback = `Session ${index >= 0 ? index + 1 : 1}`;
  if (!slot.title || isSlotId(slot.title)) return fallback;
  return slot.title;
}
function slotById(id: SlotId): SlotSummary {
  const found = slots.find((s) => s.id === id);
  if (found) return found;
  const index = SLOT_IDS.indexOf(id);
  return {
    id,
    title: `Session ${index >= 0 ? index + 1 : 1}`,
    cwd: "",
    status: "disconnected",
    connected: false,
  };
}
function isAgentActive(
  state: ClientState | null = activeState,
  slot: SlotSummary = slotById(activeId),
): boolean {
  if (typeof state?.agentActive === "boolean") {
    return state.agentActive;
  }
  return /(busy|running|streaming|thinking)/i.test(slot.status || "");
}
function syncTopBar(): void {
  const slot = slotById(activeId);
  const topTitle = document.querySelector<HTMLElement>("#top-title");
  if (topTitle) topTitle.textContent = slotTitle(slot, activeState);
}
function capability(name: string): boolean {
  return activeState?.capabilities?.[name] === true;
}
function draftFor(id: SlotId = activeId): string {
  return drafts.get(id) || "";
}
function getThemeToken(
  theme: ClientTheme | null,
  key: string,
  fallback = "",
): string {
  const tokens = (theme?.tokens as Record<string, string> | undefined) || {};
  const val =
    tokens[key] ?? (theme as Record<string, unknown> | undefined)?.[key];
  if (typeof val === "string" && /^#[0-9a-f]{6}$/i.test(val.trim())) {
    return val.trim();
  }
  return fallback;
}

function formatNumber(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 10_000) return `${trim1(n / 1_000)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
  return `${Math.round(n / 1_000_000_000)}B`;
}

function trim1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function reachesContextThreshold(
  percent: number,
  contextWindow: number | undefined,
  percentThreshold: number,
  tokenThreshold: number,
): boolean {
  if (!Number.isFinite(percent) || percent <= 0) return false;
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return percent >= percentThreshold;
  }
  const tokenPercentThreshold = (tokenThreshold / contextWindow) * 100;
  return percent >= Math.min(percentThreshold, tokenPercentThreshold);
}

function getContextUsageLevel(
  percent: number,
  contextWindow?: number,
): "normal" | "warning" | "purple" | "error" {
  if (reachesContextThreshold(percent, contextWindow, 90, 500_000))
    return "error";
  if (reachesContextThreshold(percent, contextWindow, 70, 270_000))
    return "purple";
  if (reachesContextThreshold(percent, contextWindow, 50, 150_000))
    return "warning";
  return "normal";
}

function getContextUsageColor(
  theme: ClientTheme | null,
  level: "normal" | "warning" | "purple" | "error",
): string {
  switch (level) {
    case "error":
      return getThemeToken(
        theme,
        "error",
        getThemeToken(theme, "danger", "#ff5555"),
      );
    case "purple":
      return getThemeToken(theme, "thinkingHigh", "#00b4ff");
    case "warning":
      return getThemeToken(
        theme,
        "warning",
        getThemeToken(theme, "warn", "#d4c090"),
      );
    case "normal":
      return getThemeToken(theme, "statusLineContext", "#9ca3b0");
  }
}

function getThinkingTokenKey(effort: string | null | undefined): string {
  const norm = (effort || "").trim().toLowerCase();
  switch (norm) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax";
    default:
      return "thinkingOff";
  }
}

function getThinkingColor(
  theme: ClientTheme | null,
  effort: string | null | undefined,
): string {
  const key = getThinkingTokenKey(effort);
  const defaultMap: Record<string, string> = {
    thinkingOff: "#4a5058",
    thinkingMinimal: "#5a6068",
    thinkingLow: "#6a7078",
    thinkingMedium: "#9ca3b0",
    thinkingHigh: "#00b4ff",
    thinkingXhigh: "#d4c090",
    thinkingMax: "#d4c090",
  };
  const fallback = defaultMap[key] || "#4a5058";
  if (key === "thinkingMax") {
    return getThemeToken(
      theme,
      "thinkingMax",
      getThemeToken(theme, "thinkingXhigh", fallback),
    );
  }
  return getThemeToken(theme, key, fallback);
}
const THEME_TOKENS: Record<string, string> = {
  accent: "--accent",
  accentStrong: "--accent-strong",
  bg: "--bg",
  background: "--bg",
  panel: "--panel",
  panelRaised: "--panel-raised",
  panelSoft: "--panel-soft",
  line: "--line",
  text: "--text",
  muted: "--muted",
  quiet: "--quiet",
  danger: "--danger",
  warn: "--warn",
  success: "--success",
  mdHeading: "--md-heading",
  mdListBullet: "--md-list-bullet",
  mdLink: "--md-link",
  mdCode: "--md-code",
  mdQuote: "--md-quote",
  mdQuoteBorder: "--md-quote-border",
  mdCodeBlock: "--md-code-block",
  mdCodeBlockBorder: "--md-code-block-border",
  mdHr: "--md-hr",
};
function applyTheme(theme: ClientTheme | null): void {
  const root = document.documentElement;
  Object.values(THEME_TOKENS).forEach((token) =>
    root.style.removeProperty(token),
  );
  const source = theme
    ? { ...theme, ...(theme.tokens ? theme.tokens : {}) }
    : {};
  Object.entries(THEME_TOKENS).forEach(([key, token]) => {
    const value = source[key];
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value))
      root.style.setProperty(token, value);
  });
}
function renderShell(): void {
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><button class="icon-btn menu-btn" id="menu-open" type="button" aria-label="Open sessions" aria-controls="sidebar" aria-expanded="false">${ICONS.menu}</button><div class="top-title-wrap"><span class="top-title" id="top-title">Connecting…</span></div><button class="icon-btn hidden" id="token-open" aria-label="Set access token" title="Set access token">${ICONS.key}</button></header>
    <main class="main"><aside class="sidebar" id="sidebar" aria-label="Sessions"><div class="sidebar-head"><span>Sessions</span></div><button class="sidebar-action" id="pin-open">Folders & pins</button><div class="slot-list" id="slot-list"></div><div class="sidebar-foot"><button class="sidebar-action" id="raw-toggle" type="button" aria-label="Show raw terminal" aria-pressed="false">${ICONS.terminal}<span>Terminal view</span></button><button class="sidebar-action" id="reasoning-toggle" type="button" aria-label="Toggle reasoning" aria-pressed="true">${ICONS.sparkles}<span>Reasoning</span><span id="reasoning-state">On</span></button><button class="sidebar-action" id="notifications-enable" type="button" aria-label="Enable notifications" title="Enable notifications">${ICONS.bellDefault}<span>Notifications</span></button></div></aside><button class="sidebar-backdrop" id="sidebar-close" type="button" aria-label="Close sessions"></button>
    <section class="workspace"><div class="capabilities hidden" id="capabilities"></div><div class="transcript" id="transcript" tabindex="0" aria-label="Session transcript"></div><pre class="raw-view hidden" id="raw-view" tabindex="0" aria-label="Raw terminal output"></pre><button class="scroll-fab hidden" id="scroll-bottom" type="button" aria-label="Scroll to bottom">${ICONS.arrowDown}</button></section></main>
    <div class="composer-dock"><form class="composer" id="composer"><div class="command-menu hidden" id="command-menu" role="listbox" aria-label="Slash commands"></div><div class="composer-ctx"></div><div class="composer-working hidden" id="composer-working"><span class="working-spinner">${SPINNER_FRAMES[0]}</span><span class="shimmer shimmer-accent">${shimmerMarkup("Working…")}</span></div><div class="composer-input"><textarea id="prompt" rows="1" placeholder="Message this session…" aria-label="Message this session" aria-autocomplete="list" aria-controls="command-menu" aria-expanded="false"></textarea></div><div class="composer-tools"><div class="composer-meta" id="composer-meta"><button type="button" class="ghost-btn" id="model-open">Model</button><button type="button" class="ghost-btn" id="effort-open">Effort</button><span id="ctx-label"></span><span id="cost-label"></span></div><button type="button" class="abort-btn hidden" id="abort">Stop</button><button type="submit" class="send-btn" id="send">Send</button></div></form>
  </div>`;
  const sidebar = requiredElement<HTMLElement>("#sidebar");
  const menu = requiredElement<HTMLButtonElement>("#menu-open");
  const closeSidebar = (): void => {
    closeSidebarDrawer();
    syncAnimation();
  };
  const openSidebar = (): void => {
    sidebar.classList.add("open");
    menu.setAttribute("aria-expanded", "true");
    document.body.classList.add("sidebar-open");
    syncAnimation();
  };
  menu.addEventListener("click", () =>
    sidebar.classList.contains("open") ? closeSidebar() : openSidebar(),
  );
  requiredElement<HTMLButtonElement>("#sidebar-close").addEventListener(
    "click",
    closeSidebar,
  );
  requiredElement<HTMLButtonElement>("#pin-open").addEventListener(
    "click",
    () => {
      closeSidebarDrawer();
      void openDirectoryModal();
    },
  );
  requiredElement<HTMLButtonElement>("#token-open").addEventListener(
    "click",
    openTokenModal,
  );
  requiredElement<HTMLButtonElement>("#raw-toggle").addEventListener(
    "click",
    () => {
      rawMode = !rawMode;
      localStorage.setItem("omp-mobile-raw", rawMode ? "1" : "0");
      applyRawMode();
      void loadRawTerminal();
    },
  );
  requiredElement<HTMLButtonElement>("#reasoning-toggle").addEventListener(
    "click",
    () => {
      showReasoning = !showReasoning;
      localStorage.setItem("omp-mobile-reasoning", showReasoning ? "1" : "0");
      collapsedThinkingKeys.clear();
      expandedThinkingKeys.clear();
      persistThinkingOverrides();
      applyReasoningToggle();
    },
  );
  requiredElement<HTMLButtonElement>("#model-open").addEventListener(
    "click",
    openModelModal,
  );
  requiredElement<HTMLButtonElement>("#effort-open").addEventListener(
    "click",
    toggleEffortPopover,
  );
  requiredElement<HTMLButtonElement>("#scroll-bottom").addEventListener(
    "click",
    scrollToBottom,
  );
  requiredElement<HTMLButtonElement>("#abort").addEventListener("click", () => {
    void sendAction({ type: "abort" });
  });
  requiredElement<HTMLFormElement>("#composer").addEventListener(
    "submit",
    (event: SubmitEvent) => {
      event.preventDefault();
      sendPrompt();
    },
  );
  requiredElement<HTMLButtonElement>("#notifications-enable").addEventListener(
    "click",
    () => {
      void enableNotifications();
    },
  );
  const prompt = requiredElement<HTMLTextAreaElement>("#prompt");
  prompt.addEventListener("input", () => {
    drafts.set(activeId, prompt.value);
    dismissedCommandDraft = null;
    commandSelection = 0;
    resizePrompt();
    renderCommandMenu();
  });
  prompt.addEventListener("keydown", (event: KeyboardEvent) => {
    const matches = matchingCommands(prompt.value);
    const menuOpen = !requiredElement<HTMLElement>("#command-menu").classList.contains(
      "hidden",
    );
    if (menuOpen && matches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        commandSelection =
          (commandSelection + direction + matches.length) % matches.length;
        renderCommandMenu();
        return;
      }
      if (
        event.key === "Tab" ||
        (event.key === "Enter" &&
          !event.shiftKey &&
          `/${matches[commandSelection]?.name}` !== prompt.value.trim())
      ) {
        event.preventDefault();
        selectCommand(matches[commandSelection]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissedCommandDraft = prompt.value;
        renderCommandMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendPrompt();
    }
  });
  const transcript = requiredElement<HTMLDivElement>("#transcript");
  transcript.addEventListener(
    "scroll",
    () => {
      transcriptNearBottom =
        transcript.scrollHeight -
          transcript.scrollTop -
          transcript.clientHeight <
        90;
      requiredElement<HTMLButtonElement>("#scroll-bottom").classList.toggle(
        "hidden",
        transcriptNearBottom,
      );
    },
    { passive: true },
  );
  window.visualViewport?.addEventListener("resize", handleViewport);
  window.visualViewport?.addEventListener("scroll", handleViewport);
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && modal?.contains(target)) {
      window.setTimeout(() => {
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 50);
    }
  });
  handleViewport();
  new ResizeObserver(([entry]) => {
    if (!entry) return;
    document.documentElement.style.setProperty(
      "--composer-height",
      `${entry.target.getBoundingClientRect().height}px`,
    );
  }).observe(requiredElement<HTMLElement>(".composer-dock"));
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeEffortPopover();
      closeModal();
      closeSidebarDrawer();
    }
  });
}
function scrollToBottom(): void {
  const box = requiredElement<HTMLDivElement>("#transcript");
  box.scrollTop = box.scrollHeight;
  transcriptNearBottom = true;
  document.querySelector("#scroll-bottom")?.classList.add("hidden");
}
function sidebarSlotAccent(slot: SlotSummary): string {
  const cached = cache.get(slot.id);
  const value = slot.accent ?? (!slot.connected ? cached?.accent : undefined);
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : "#808080";
}

function updateSlots(): void {
  const list = document.querySelector<HTMLDivElement>("#slot-list");
  if (!list) return;
  const ordered = SLOT_IDS.map((id) => slotById(id));
  list.innerHTML = ordered
    .map((slot) => {
      const connected = slot.connected === true;
      const slotState = slot.id === activeId ? activeState : cache.get(slot.id);
      const isBusy =
        connected &&
        isAgentActive(slot.id === activeId ? activeState : null, slot);
      const unread = unreadBySlot.get(slot.id)?.length || 0;
      return `<button class="slot-card${slot.id === activeId ? " active" : ""}${!connected ? " offline" : ""}${isBusy ? " busy" : ""}" data-slot="${esc(slot.id)}"><div class="slot-title"><span>${esc(slotTitle(slot, slotState))}</span><span class="slot-badges">${!connected ? `<span class="slot-offline">offline</span>` : ""}${isBusy ? `<span class="slot-working"><span class="working-spinner">${SPINNER_FRAMES[0]}</span><span class="shimmer shimmer-accent">${shimmerMarkup("Working…")}</span></span>` : ""}${unread > 0 ? `<span class="slot-unread" aria-label="${unread} unread completion${unread === 1 ? "" : "s"}">${unread > 99 ? "99+" : unread}</span>` : ""}</span></div>${slot.summary && slot.summary.trim() ? `<div class="slot-summary">${esc(slot.summary)}</div>` : ""}<div class="slot-meta"><span class="slot-cwd">${esc(slot.cwd || "Working directory unavailable")}</span></div></button>`;
    })
    .join("");
  list.querySelectorAll<HTMLButtonElement>("[data-slot]").forEach((node) => {
    const id = node.dataset.slot;
    if (!isSlotId(id)) return;
    node.style.setProperty("--slot-accent", sidebarSlotAccent(slotById(id)));
    node.addEventListener("click", () => selectSlot(id));
  });
  syncTopBar();
  syncAnimation();
}
function closeSidebarDrawer(): void {
  document.querySelector<HTMLElement>("#sidebar")?.classList.remove("open");
  document
    .querySelector<HTMLButtonElement>("#menu-open")
    ?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("sidebar-open");
}
function matchingCommands(value: string): SlashCommand[] {
  const match = value.match(/^\/([^\s/]*)$/);
  if (!match || dismissedCommandDraft === value) return [];
  const query = (match[1] ?? "").toLowerCase();
  const score = (candidate: string): number | null => {
    const normalized = candidate.toLowerCase();
    if (!query) return 0;
    if (normalized.startsWith(query)) return normalized === query ? -3 : -2;
    const substring = normalized.indexOf(query);
    if (substring >= 0) return substring;
    let cursor = 0;
    for (const char of normalized) {
      if (char === query[cursor]) cursor += 1;
      if (cursor === query.length) return normalized.length + 10;
    }
    return null;
  };
  return (activeState?.commands ?? [])
    .map((command, index) => {
      const scores = [command.name, ...(command.aliases ?? [])]
        .map(score)
        .filter((value): value is number => value !== null);
      return {
        command,
        index,
        score: scores.length > 0 ? Math.min(...scores) : null,
      };
    })
    .filter(
      (
        entry,
      ): entry is { command: SlashCommand; index: number; score: number } =>
        entry.score !== null,
    )
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, 12)
    .map((entry) => entry.command);
}

function selectCommand(command: SlashCommand | undefined): void {
  if (!command) return;
  const prompt = requiredElement<HTMLTextAreaElement>("#prompt");
  prompt.value = `/${command.name}`;
  drafts.set(activeId, prompt.value);
  dismissedCommandDraft = prompt.value;
  commandSelection = 0;
  resizePrompt();
  renderCommandMenu();
  prompt.focus();
}

function renderCommandMenu(): void {
  const menu = document.querySelector<HTMLElement>("#command-menu");
  const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  if (!menu || !prompt) return;
  const matches = matchingCommands(prompt.value);
  if (matches.length === 0) {
    menu.replaceChildren();
    menu.classList.add("hidden");
    prompt.setAttribute("aria-expanded", "false");
    prompt.removeAttribute("aria-activedescendant");
    return;
  }
  commandSelection = Math.min(commandSelection, matches.length - 1);
  menu.innerHTML = matches
    .map(
      (command, index) =>
        `<button type="button" id="command-option-${index}" class="command-option${index === commandSelection ? " selected" : ""}" role="option" aria-selected="${index === commandSelection}" data-command-index="${index}"><strong>/${esc(command.name)}</strong><span>${esc(command.description || "Slash command")}</span></button>`,
    )
    .join("");
  menu.classList.remove("hidden");
  prompt.setAttribute("aria-expanded", "true");
  prompt.setAttribute(
    "aria-activedescendant",
    `command-option-${commandSelection}`,
  );
  menu
    .querySelector<HTMLElement>(`#command-option-${commandSelection}`)
    ?.scrollIntoView({ block: "nearest" });
  menu
    .querySelectorAll<HTMLButtonElement>("[data-command-index]")
    .forEach((button) => {
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const index = Number(button.dataset.commandIndex);
        selectCommand(matches[index]);
      });
    });
}

function resizePrompt(): void {
  const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  if (!prompt) return;
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
}
function handleViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const keyboard = Math.max(
    0,
    window.innerHeight - viewport.height - viewport.offsetTop,
  );
  document.documentElement.style.setProperty(
    "--keyboard-inset",
    `${keyboard}px`,
  );
  if (modal && keyboard > 0) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && modal.contains(focused)) {
      focused.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}
function isSlotId(value: string | undefined): value is SlotId {
  return value !== undefined && SLOT_IDS.includes(value as SlotId);
}
function selectSlot(id: SlotId): void {
  closeEffortPopover();
  closeSidebarDrawer();
  dismissedCommandDraft = null;
  commandSelection = 0;
  if (id === activeId && activeState) {
    window.setTimeout(() => {
      void acknowledgeSlot(id);
    }, 0);
    return;
  }
  const oldPrompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  if (oldPrompt) drafts.set(activeId, oldPrompt.value);
  activeId = id;
  activeState = cache.get(id) || null;
  if (oldPrompt) {
    oldPrompt.value = draftFor(id);
    resizePrompt();
  }
  transcriptNearBottom = true;
  lastRenderedMessageCount = 0;
  updateSlots();
  renderActive();
  void loadRawTerminal();
  if (activeState)
    window.setTimeout(() => {
      void acknowledgeSlot(id);
    }, 0);
  void loadState();
}
function normalizeModel(model: ClientModel | string | null): string {
  if (!model) return "No model";
  if (typeof model === "string") return model;
  return (
    model.name ||
    [model.provider, model.id].filter(Boolean).join("/") ||
    "Model unavailable"
  );
}
function isSignatureKey(key: string): boolean {
  if (!key) return false;
  const lower = key.toLowerCase();
  return (
    key === "thoughtSignature" ||
    key === "thinkingSignature" ||
    key === "textSignature" ||
    key === "itemId" ||
    key === "signature" ||
    lower.includes("signature") ||
    key === "intent"
  );
}
function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
}
function truncateText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… truncated`;
}
function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\r?\n|\r/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}
function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args) return undefined;
  if (typeof args === "object" && args !== null) {
    return args as Record<string, unknown>;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return undefined;
}
function formatToolSummary(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";

  const command = asString(args.command) ?? asString(args.cmd);
  if (command) return oneLine(command, 90);

  const rawPath =
    asString(args.path) ??
    asString(args.file_path) ??
    asString(args.filePath) ??
    asString(args.paths);
  if (rawPath) {
    let pathSummary = rawPath;
    const offset =
      args.offset !== undefined && args.offset !== null
        ? String(args.offset)
        : undefined;
    const limit =
      args.limit !== undefined && args.limit !== null
        ? String(args.limit)
        : undefined;
    if (offset !== undefined && limit !== undefined) {
      pathSummary = `${rawPath}:${offset}+${limit}`;
    } else if (offset !== undefined) {
      pathSummary = `${rawPath}:${offset}`;
    } else if (limit !== undefined) {
      pathSummary = `${rawPath}:limit=${limit}`;
    }
    return oneLine(pathSummary, 90);
  }

  const query =
    asString(args.query) ?? asString(args.pattern) ?? asString(args.pat);
  if (query) return oneLine(query, 90);

  for (const [key, val] of Object.entries(args)) {
    if (isSignatureKey(key)) continue;
    const strVal = asString(val);
    if (strVal && strVal.trim().length > 0) return oneLine(strVal, 90);
  }

  try {
    const clean: Record<string, unknown> = {};
    let hasKeys = false;
    for (const [k, v] of Object.entries(args)) {
      if (isSignatureKey(k)) continue;
      clean[k] = v;
      hasKeys = true;
    }
    if (!hasKeys) return "";
    const jsonStr = JSON.stringify(clean);
    return jsonStr === "{}" ? "" : oneLine(jsonStr, 90);
  } catch {
    return "";
  }
}
function extractContentText(content: unknown): string | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean")
    return String(content);
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        pieces.push(item);
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (obj.type === "image") {
          pieces.push("[image]");
        } else if (typeof obj.text === "string") {
          pieces.push(obj.text);
        } else if (typeof obj.content === "string") {
          pieces.push(obj.content);
        } else if (typeof obj.output === "string") {
          pieces.push(obj.output);
        } else if (typeof obj.message === "string") {
          pieces.push(obj.message);
        }
      }
    }
    return pieces.join("\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.error === "string") return obj.error;
    try {
      const clean: Record<string, unknown> = {};
      let hasKeys = false;
      for (const [k, v] of Object.entries(obj)) {
        if (isSignatureKey(k)) continue;
        clean[k] = v;
        hasKeys = true;
      }
      return hasKeys ? JSON.stringify(clean, null, 2) : undefined;
    } catch {
      return String(content);
    }
  }
  return String(content);
}
const toolCallCache = new Map<
  string,
  { name: string; arguments?: Record<string, unknown> }
>();
function projectParts(
  message: ClientMessage,
  toolCalls: Map<
    string,
    { name: string; arguments?: Record<string, unknown> }
  > = toolCallCache,
): ChatPart[] {
  const parts: ChatPart[] = [];
  const rawRole = asString(message.role);

  if (
    rawRole === "toolResult" ||
    message.type === "toolResult" ||
    message.toolCallId !== undefined
  ) {
    const toolCallId =
      asString(message.toolCallId) ?? asString(message.id) ?? "";
    const known = toolCallId ? toolCalls.get(toolCallId) : undefined;
    const name =
      asString(message.toolName) ??
      asString(message.name) ??
      asString(message.tool) ??
      known?.name ??
      "tool";
    const args =
      known?.arguments ??
      parseArgs(message.arguments ?? message.args ?? message.input);
    const summary = formatToolSummary(args);

    const rawOutput = extractContentText(
      message.content ??
        message.details ??
        message.output ??
        message.result ??
        message.error,
    );
    const output =
      rawOutput !== undefined ? truncateText(rawOutput, 6000) : undefined;
    const isError =
      message.isError === true ||
      (message.error !== undefined &&
        message.error !== null &&
        message.error !== false) ||
      (typeof message.details === "object" &&
        message.details !== null &&
        (message.details as Record<string, unknown>).error === true);

    const part: ChatPart = {
      kind: "tool",
      id: toolCallId,
      name,
      summary,
      ...(output !== undefined && output !== "" ? { output } : {}),
      ...(isError ? { isError: true } : {}),
    };
    parts.push(part);
    return parts;
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as Record<string, unknown>;
      const id = asString(t.id);
      const fn = t.function as Record<string, unknown> | undefined;
      const name = asString(fn?.name) ?? asString(t.name) ?? "";
      const args = parseArgs(fn?.arguments ?? t.arguments ?? t.args ?? t.input);
      if (id) {
        toolCalls.set(id, { name, arguments: args });
      }
    }
  }

  const content = message.content ?? message.text;

  if (typeof content === "string") {
    if (content.length > 0) {
      parts.push({
        kind: "text",
        text: truncateText(content, 32000),
      });
    }
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") {
        if (block.length > 0) {
          parts.push({
            kind: "text",
            text: truncateText(block, 32000),
          });
        }
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        const type = asString(b.type);
        const thinkingText =
          asString(b.thinking) ??
          asString(b.thought) ??
          asString(b.reasoning) ??
          asString(b.reasoning_content);
        if (
          type === "thinking" ||
          type === "thought" ||
          type === "reasoning" ||
          thinkingText !== undefined
        ) {
          const text = thinkingText ?? asString(b.text) ?? "";
          if (text) {
            parts.push({
              kind: "thinking",
              text: truncateText(text, 32000),
            });
          }
        } else if (
          type === "toolCall" ||
          type === "tool_call" ||
          type === "tool_use"
        ) {
          const id = asString(b.id) ?? asString(b.toolCallId) ?? "";
          const name =
            asString(b.name) ??
            asString(b.toolName) ??
            asString(b.tool) ??
            "tool";
          const args = parseArgs(b.arguments ?? b.args ?? b.input);
          if (id) {
            toolCalls.set(id, { name, arguments: args });
          }
        } else if (type === "image") {
          parts.push({
            kind: "text",
            text: "[image]",
          });
        } else if (type === "text" || b.text !== undefined) {
          const text = asString(b.text) ?? "";
          if (text) {
            parts.push({
              kind: "text",
              text: truncateText(text, 32000),
            });
          }
        } else {
          const text = asString(b.text) ?? asString(b.content);
          if (text) {
            parts.push({
              kind: "text",
              text: truncateText(text, 32000),
            });
          }
        }
      }
    }
  } else if (content && typeof content === "object") {
    const b = content as Record<string, unknown>;
    const type = asString(b.type);
    const thinkingText =
      asString(b.thinking) ??
      asString(b.thought) ??
      asString(b.reasoning) ??
      asString(b.reasoning_content);
    if (
      type === "thinking" ||
      type === "thought" ||
      type === "reasoning" ||
      thinkingText !== undefined
    ) {
      const text = thinkingText ?? asString(b.text) ?? "";
      if (text) {
        parts.push({
          kind: "thinking",
          text: truncateText(text, 32000),
        });
      }
    } else if (type === "image") {
      parts.push({
        kind: "text",
        text: "[image]",
      });
    } else {
      const text = asString(b.text) ?? asString(b.content);
      if (text) {
        parts.push({
          kind: "text",
          text: truncateText(text, 32000),
        });
      }
    }
  }

  return parts;
}
function appendHexColor(parent: HTMLElement, hex: string): void {
  const color = document.createElement("span");
  color.className = "md-hex-color";
  color.style.color = hex;
  const swatch = document.createElement("span");
  swatch.className = "md-color-swatch";
  swatch.style.backgroundColor = hex;
  swatch.setAttribute("aria-hidden", "true");
  color.append(swatch, document.createTextNode(hex));
  parent.append(color);
}

function appendMarkdownText(parent: HTMLElement, text: string): void {
  // Mobile preference: numeric prose uses accent color; code bypasses this path.
  const numbers =
    /(?<![\w#])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w])|(?<![\p{L}\p{N}_.,])[+-]?(?:\d+(?:[.,]\d+)*|[.,]\d+)(?:[eE][+-]?\d+)?%?/giu;
  let offset = 0;
  for (const match of text.matchAll(numbers)) {
    if (match.index > offset)
      parent.append(document.createTextNode(text.slice(offset, match.index)));
    if (match[0].startsWith("#")) {
      appendHexColor(parent, match[0]);
    } else {
      const number = document.createElement("span");
      number.className = "md-number";
      number.textContent = match[0];
      parent.append(number);
    }
    offset = match.index + match[0].length;
  }
  if (offset < text.length)
    parent.append(document.createTextNode(text.slice(offset)));
}
function appendInlineMarkdown(parent: HTMLElement, text: string): void {
  // Matches inline code, bold (**), italic (*), strikethrough (~~), italic (_), and link ([label](url))
  // Note: All user content is inserted via createTextNode/createElement/textContent - no innerHTML injection.
  const inlineRegex =
    /(`([^`\n]+)`)|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(~~([^~\n]+)~~)|((?:^|(?<=\s|[^\w]))_([^_\n]+)_(?=$|\s|[^\w]))|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendMarkdownText(parent, text.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      const code = document.createElement("code");
      code.className = "md-code";
      if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(match[2])) {
        appendHexColor(code, match[2]);
      } else {
        code.textContent = match[2];
      }
      parent.append(code);
    } else if (match[3] !== undefined) {
      const strong = document.createElement("strong");
      appendInlineMarkdown(strong, match[4]);
      parent.append(strong);
    } else if (match[5] !== undefined) {
      const em = document.createElement("em");
      appendInlineMarkdown(em, match[6]);
      parent.append(em);
    } else if (match[7] !== undefined) {
      const del = document.createElement("del");
      appendInlineMarkdown(del, match[8]);
      parent.append(del);
    } else if (match[9] !== undefined) {
      const em = document.createElement("em");
      appendInlineMarkdown(em, match[10]);
      parent.append(em);
    } else if (match[11] !== undefined) {
      const a = document.createElement("a");
      a.className = "md-link";
      a.href = match[13];
      a.target = "_blank";
      a.rel = "noopener";
      appendInlineMarkdown(a, match[12]);
      parent.append(a);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    appendMarkdownText(parent, text.slice(lastIndex));
  }
}
type MarkdownListItem = {
  indent: number;
  isOrdered: boolean;
  start?: number;
  text: string;
};
function renderListItems(parent: HTMLElement, items: MarkdownListItem[]): void {
  if (items.length === 0) return;

  const rootList = document.createElement(items[0].isOrdered ? "ol" : "ul");
  rootList.className = items[0].isOrdered ? "md-ol" : "md-ul";
  if (
    items[0].isOrdered &&
    items[0].start !== undefined &&
    items[0].start !== 1
  ) {
    rootList.setAttribute("start", String(items[0].start));
  }
  parent.append(rootList);

  type StackEntry = {
    list: HTMLElement;
    lastLi: HTMLElement | null;
    indent: number;
    isOrdered: boolean;
  };

  const stack: StackEntry[] = [
    {
      list: rootList,
      lastLi: null,
      indent: items[0].indent,
      isOrdered: items[0].isOrdered,
    },
  ];

  for (const item of items) {
    if (item.indent > stack[stack.length - 1].indent && stack.length < 8) {
      const top = stack[stack.length - 1];
      const subList = document.createElement(item.isOrdered ? "ol" : "ul");
      subList.className = item.isOrdered ? "md-ol" : "md-ul";
      if (item.isOrdered && item.start !== undefined && item.start !== 1) {
        subList.setAttribute("start", String(item.start));
      }
      if (top.lastLi) {
        top.lastLi.append(subList);
      } else {
        top.list.append(subList);
      }
      stack.push({
        list: subList,
        lastLi: null,
        indent: item.indent,
        isOrdered: item.isOrdered,
      });
    } else {
      while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) {
        stack.pop();
      }
    }

    const current = stack[stack.length - 1];
    const li = document.createElement("li");
    li.className = "md-li";
    appendInlineMarkdown(li, item.text);
    current.list.append(li);
    current.lastLi = li;
  }
}
function splitTableRow(row: string): string[] {
  let line = row.trim();
  if (line.startsWith("|")) {
    line = line.slice(1);
  }
  if (line.endsWith("|") && !line.endsWith("\\|")) {
    line = line.slice(0, -1);
  }

  const cells: string[] = [];
  let current = "";
  let inBackticks = false;
  let escape = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\") {
      if (i + 1 < line.length && line[i + 1] === "|") {
        current += "|";
        i++;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "`") {
      inBackticks = !inBackticks;
      current += char;
      continue;
    }
    if (char === "|" && !inBackticks) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}
function parseTableAlignments(
  delimiterRow: string,
): ("left" | "center" | "right" | null)[] | null {
  if (!delimiterRow.includes("-")) return null;
  const cells = splitTableRow(delimiterRow);
  if (cells.length === 0) return null;
  const alignments: ("left" | "center" | "right" | null)[] = [];
  for (const cell of cells) {
    const trimmed = cell.trim();
    if (!/^:?-+:?$/.test(trimmed)) {
      return null;
    }
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) {
      alignments.push("center");
    } else if (right) {
      alignments.push("right");
    } else if (left) {
      alignments.push("left");
    } else {
      alignments.push(null);
    }
  }
  return alignments;
}
function renderTable(
  parent: HTMLElement,
  headers: string[],
  alignments: ("left" | "center" | "right" | null)[],
  rows: string[][],
): void {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "md-table";

  const thead = document.createElement("thead");
  const headerTr = document.createElement("tr");
  for (let c = 0; c < headers.length; c++) {
    const th = document.createElement("th");
    const align = alignments[c];
    if (align) th.style.textAlign = align;
    appendInlineMarkdown(th, headers[c]);
    headerTr.append(th);
  }
  thead.append(headerTr);
  table.append(thead);

  if (rows.length > 0) {
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (let c = 0; c < headers.length; c++) {
        const td = document.createElement("td");
        const align = alignments[c];
        if (align) td.style.textAlign = align;
        const cellText = row[c] ?? "";
        appendInlineMarkdown(td, cellText);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  }

  wrap.append(table);
  parent.append(wrap);
}
function appendMarkdown(parent: HTMLElement, rawText: string): void {
  if (!rawText) return;

  const text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Fenced code block (```)
    const codeFenceMatch = line.match(/^```([\w+-]*)\s*$/);
    if (codeFenceMatch) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      const wrap = document.createElement("div");
      wrap.className = "code-wrap";
      const pre = document.createElement("pre");
      pre.textContent = codeLines.join("\n");
      wrap.append(pre);
      parent.append(wrap);
      continue;
    }

    // 2. Blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // 3. Horizontal rule: ---, ***, ___ (at least 3 of the same char)
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      const hr = document.createElement("hr");
      hr.className = "md-hr";
      parent.append(hr);
      i++;
      continue;
    }

    // 4. ATX Heading: # .. ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const h = document.createElement("div");
      h.className = "md-h";
      h.setAttribute("data-level", String(level));
      appendInlineMarkdown(h, headingMatch[2].trim());
      parent.append(h);
      i++;
      continue;
    }

    // 5. Blockquote: lines starting with >
    if (/^>\s?(.*)$/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?(.*)$/.test(lines[i])) {
        const m = lines[i].match(/^>\s?(.*)$/);
        quoteLines.push(m ? m[1] : "");
        i++;
      }
      const bq = document.createElement("blockquote");
      bq.className = "md-quote";
      appendMarkdown(bq, quoteLines.join("\n"));
      parent.append(bq);
      continue;
    }

    // 6. Table: line with | followed by delimiter line
    if (line.includes("|") && i + 1 < lines.length) {
      const headerCells = splitTableRow(line);
      const alignments = parseTableAlignments(lines[i + 1]);
      if (
        alignments &&
        headerCells.length > 0 &&
        alignments.length === headerCells.length
      ) {
        i += 2;
        const dataRows: string[][] = [];
        while (i < lines.length) {
          const rowLine = lines[i];
          if (/^\s*$/.test(rowLine)) break;
          if (rowLine.match(/^```/)) break;
          if (rowLine.match(/^#{1,6}\s+/)) break;
          if (rowLine.match(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/)) break;
          if (!rowLine.includes("|")) break;

          const rowCells = splitTableRow(rowLine);
          dataRows.push(rowCells);
          i++;
        }

        renderTable(parent, headerCells, alignments, dataRows);
        continue;
      }
    }

    // 7. Lists: unordered (- * +) and ordered (1. 2.)
    const listMatch = line.match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.+)$/);
    if (listMatch) {
      const listItems: MarkdownListItem[] = [];
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.+)$/);
        if (itemMatch) {
          const indent = itemMatch[1].replace(/\t/g, "  ").length;
          const isOrdered = Boolean(itemMatch[3]);
          const start = itemMatch[3] ? parseInt(itemMatch[3], 10) : undefined;
          listItems.push({
            indent,
            isOrdered,
            start,
            text: itemMatch[4],
          });
          i++;
        } else if (lines[i].match(/^\s*$/)) {
          let nextNonEmpty = i + 1;
          while (
            nextNonEmpty < lines.length &&
            lines[nextNonEmpty].match(/^\s*$/)
          ) {
            nextNonEmpty++;
          }
          if (
            nextNonEmpty < lines.length &&
            lines[nextNonEmpty].match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.+)$/)
          ) {
            i = nextNonEmpty;
          } else {
            break;
          }
        } else {
          if (listItems.length > 0 && /^\s{2,}\S/.test(lines[i])) {
            listItems[listItems.length - 1].text += " " + lines[i].trim();
            i++;
          } else {
            break;
          }
        }
      }

      renderListItems(parent, listItems);
      continue;
    }

    // 8. Regular paragraph
    const pLines: string[] = [];
    while (
      i < lines.length &&
      !lines[i].match(/^\s*$/) &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/) &&
      !lines[i].match(/^#{1,6}\s+/) &&
      !lines[i].match(/^>\s?/) &&
      !lines[i].match(/^(\s*)(?:[-*+]|\d+\.)\s+/) &&
      !(
        lines[i].includes("|") &&
        i + 1 < lines.length &&
        parseTableAlignments(lines[i + 1]) !== null &&
        splitTableRow(lines[i]).length ===
          (parseTableAlignments(lines[i + 1])?.length ?? -1)
      )
    ) {
      pLines.push(lines[i]);
      i++;
    }

    if (pLines.length > 0) {
      const pText = pLines.join("\n");
      if (pText.length > 8000) {
        for (let offset = 0; offset < pText.length; offset += 8000) {
          const chunk = pText.slice(offset, offset + 8000);
          const p = document.createElement("p");
          p.className = "md-p";
          appendInlineMarkdown(p, chunk);
          parent.append(p);
        }
      } else {
        const p = document.createElement("p");
        p.className = "md-p";
        appendInlineMarkdown(p, pText);
        parent.append(p);
      }
    }
  }
}
function appendFormatted(parent: HTMLElement, value: unknown): void {
  const text =
    typeof value === "string" ? value : (extractContentText(value) ?? "");
  appendMarkdown(parent, text);
}
function messageKind(
  message: ClientMessage,
): "tool" | "thinking" | "error" | "user" | "assistant" {
  const value = String(
    message.type || message.role || "assistant",
  ).toLowerCase();
  if (value.includes("tool")) return "tool";
  if (value.includes("think") || value.includes("reason")) return "thinking";
  if (value.includes("error")) return "error";
  if (value.includes("user") || value.includes("prompt")) return "user";
  return "assistant";
}
function renderMessages(messages: ClientMessage[], active = false): void {
  const transcript = document.querySelector<HTMLDivElement>("#transcript");
  if (!transcript) return;
  const wasNear = transcriptNearBottom;
  const oldTop = transcript.scrollTop;

  let anchorKey: string | null = null;
  let anchorOffset = 0;
  if (!wasNear && lastRenderedMessageCount > 0) {
    const articles =
      transcript.querySelectorAll<HTMLElement>("article.message");
    for (const art of articles) {
      if (art.offsetTop + art.offsetHeight > oldTop) {
        anchorKey = art.dataset.msgKey || null;
        anchorOffset = oldTop - art.offsetTop;
        break;
      }
    }
  }

  transcript.innerHTML = "";
  if (messages.length === 0) {
    lastRenderedMessageCount = 0;
    return;
  }

  const toolCalls = new Map<
    string,
    { name: string; arguments?: Record<string, unknown> }
  >();

  for (const message of messages) {
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const t = tc as Record<string, unknown>;
        const id = asString(t.id);
        const fn = t.function as Record<string, unknown> | undefined;
        const name = asString(fn?.name) ?? asString(t.name) ?? "";
        const args = parseArgs(
          fn?.arguments ?? t.arguments ?? t.args ?? t.input,
        );
        if (id) toolCalls.set(id, { name, arguments: args });
      }
    }
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          const type = asString(b.type);
          if (
            type === "toolCall" ||
            type === "tool_call" ||
            type === "tool_use"
          ) {
            const id = asString(b.id) ?? asString(b.toolCallId) ?? "";
            const name =
              asString(b.name) ??
              asString(b.toolName) ??
              asString(b.tool) ??
              "tool";
            const args = parseArgs(b.arguments ?? b.args ?? b.input);
            if (id) toolCalls.set(id, { name, arguments: args });
          }
        }
      }
    }
  }

  messages.forEach((message, messageIndex) => {
    const parts = Array.isArray(message.parts)
      ? message.parts
      : projectParts(message, toolCalls);
    // OMP spins a tool block while its call has no result; only the newest
    // message can hold one, so older abandoned calls never animate.
    const liveMessage = active && messageIndex === messages.length - 1;

    if (parts.length === 0 && !message.actions?.length) return;
    const msgKey =
      asString(message.entryId) ??
      asString(message.id) ??
      `msg-${messageIndex}`;
    const role = message.role || messageKind(message);
    const article = document.createElement("article");
    article.className = `message ${role}`;
    article.dataset.msgKey = msgKey;
    parts.forEach((part, partIndex) => {
      if (!part || typeof part !== "object") return;
      if (part.kind === "text") {
        const partDiv = document.createElement("div");
        partDiv.className = "part part-text";
        appendFormatted(partDiv, part.text ?? "");
        article.append(partDiv);
      } else if (part.kind === "thinking") {
        const details = document.createElement("details");
        details.className = "part part-thinking";
        const key = `${activeId}:${activeState?.generation}:${msgKey}-thinking-${partIndex}`;
        const isLiveThinking = liveMessage;
        if (showReasoning) {
          details.open = !collapsedThinkingKeys.has(key);
        } else {
          details.open = expandedThinkingKeys.has(key);
        }
        details.addEventListener("toggle", () => {
          if (showReasoning) {
            if (details.open) {
              collapsedThinkingKeys.delete(key);
            } else {
              collapsedThinkingKeys.add(key);
            }
          } else {
            if (details.open) {
              expandedThinkingKeys.add(key);
            } else {
              expandedThinkingKeys.delete(key);
            }
          }
          persistThinkingOverrides();
        });
        const summary = document.createElement("summary");
        summary.className = "part-thinking-summary";
        if (isLiveThinking) {
          summary.classList.add("live");
          const glyph = document.createElement("span");
          glyph.className = "working-spinner";
          glyph.textContent = SPINNER_FRAMES[0];
          const sweep = document.createElement("span");
          sweep.className = "shimmer";
          sweep.innerHTML = shimmerMarkup("Thinking…");
          summary.append(glyph, sweep);
        } else {
          summary.textContent = "Thinking";
        }
        details.append(summary);
        const body = document.createElement("div");
        body.className = "part-thinking-body";
        appendFormatted(body, part.text ?? "");
        details.append(body);
        article.append(details);
      } else if (part.kind === "tool") {
        const details = document.createElement("details");
        details.className = `part part-tool${part.isError ? " part-error" : ""}`;
        const toolMsgKey = msgKey;
        const toolId = part.id || `${part.name}-${partIndex}`;
        const toolKey = `${activeId}:${activeState?.generation}:${toolMsgKey}:tool:${toolId}`;
        details.open = expandedToolKeys.has(toolKey);
        details.addEventListener("toggle", () => {
          if (details.open) {
            expandedToolKeys.add(toolKey);
          } else {
            expandedToolKeys.delete(toolKey);
          }
        });
        const summary = document.createElement("summary");
        summary.className = "part-tool-summary";
        let line = part.summary
          ? `→ ${part.name}(${part.summary})`
          : `→ ${part.name}()`;
        if (line.length > 90) {
          line = line.slice(0, 87) + "…";
        }
        const live = liveMessage && part.output === undefined;
        if (live) {
          summary.classList.add("live");
          const glyph = document.createElement("span");
          glyph.className = "working-spinner";
          glyph.textContent = SPINNER_FRAMES[0];
          const sweep = document.createElement("span");
          sweep.className = "shimmer";
          sweep.innerHTML = shimmerMarkup(line);
          summary.append(glyph, sweep);
        } else {
          summary.textContent = line;
        }
        details.append(summary);

        if (part.output != null && part.output !== "") {
          const pre = document.createElement("pre");
          pre.className = "part-output";
          const rawOut =
            typeof part.output === "string"
              ? part.output
              : (extractContentText(part.output) ?? "");
          pre.textContent = truncateText(rawOut, 6000);
          details.append(pre);
        }
        article.append(details);
      }
    });

    if (message.actions?.length) {
      const actions = document.createElement("div");
      actions.className = "message-actions";
      message.actions.forEach((action) => {
        const button = document.createElement("button");
        button.className = "ghost-btn";
        button.textContent = action.label || action.title || "Open";
        button.addEventListener("click", () => {
          if (
            typeof action.url === "string" &&
            /^https?:\/\//i.test(action.url)
          )
            window.open(action.url, "_blank", "noopener");
          else showToast("This action is not available on mobile", true);
        });
        actions.append(button);
      });
      article.append(actions);
    }

    transcript.append(article);
  });
  if (wasNear || lastRenderedMessageCount === 0) {
    transcript.scrollTop = transcript.scrollHeight;
  } else if (anchorKey) {
    const anchorEl = transcript.querySelector<HTMLElement>(
      `article.message[data-msg-key="${CSS.escape(anchorKey)}"]`,
    );
    if (anchorEl) {
      transcript.scrollTop = anchorEl.offsetTop + anchorOffset;
    } else {
      transcript.scrollTop = oldTop;
    }
  } else {
    transcript.scrollTop = oldTop;
  }
  transcriptNearBottom =
    transcript.scrollHeight -
      transcript.scrollTop -
      transcript.clientHeight <
    90;
  document
    .querySelector("#scroll-bottom")
    ?.classList.toggle("hidden", transcriptNearBottom);
  lastRenderedMessageCount = messages.length;
}
let rawMode = localStorage.getItem("omp-mobile-raw") === "1";
let rawRequest = 0;

/** Mirrors the host pane through the gateway's read-only terminal snapshot. */
function applyRawMode(): void {
  const button = document.querySelector<HTMLButtonElement>("#raw-toggle");
  if (button) {
    button.classList.toggle("active", rawMode);
    button.innerHTML = `${rawMode ? ICONS.chat : ICONS.terminal}<span>${rawMode ? "Conversation view" : "Terminal view"}</span>`;
    button.setAttribute("aria-pressed", rawMode ? "true" : "false");
    button.setAttribute(
      "aria-label",
      rawMode ? "Show conversation" : "Show raw terminal",
    );
  }
  document.querySelector("#transcript")?.classList.toggle("hidden", rawMode);
  document.querySelector("#raw-view")?.classList.toggle("hidden", !rawMode);
  document.body.classList.toggle("raw-mode", rawMode);
}

async function loadRawTerminal(): Promise<void> {
  if (!rawMode) return;
  const targetId = activeId;
  const request = ++rawRequest;
  const view = document.querySelector<HTMLElement>("#raw-view");
  if (!view) return;
  const pinned = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  try {
    const snapshot = await api<TerminalSnapshot>(
      `/api/slots/${encodeURIComponent(targetId)}/terminal`,
    );
    if (request !== rawRequest || !rawMode || targetId !== activeId) return;
    view.textContent = snapshot.screen;
    if (pinned) view.scrollTop = view.scrollHeight;
  } catch (error: unknown) {
    if (request !== rawRequest) return;
    view.textContent = hasAuth(error)
      ? "Access token rejected."
      : `Raw terminal unavailable: ${errorMessage(error)}`;
    if (hasAuth(error)) openTokenModal();
  }
}

function renderActive(): void {
  const slot = slotById(activeId);
  const state = activeState;
  const active = isAgentActive(state, slot);
  syncTopBar();
  const prompt = requiredElement<HTMLTextAreaElement>("#prompt");
  if (document.activeElement !== prompt) {
    prompt.value = draftFor();
    resizePrompt();
  }
  renderCommandMenu();
  const transcript = requiredElement<HTMLDivElement>("#transcript");
  if (state) {
    applyTheme(state.theme);
    renderMessages(state.messages, active);
  } else {
    transcript.innerHTML = "";
  }
  requiredElement<HTMLElement>("#composer-working").classList.toggle(
    "hidden",
    !active,
  );
  const caps = requiredElement<HTMLDivElement>("#capabilities");
  let notice = "";
  if ((state?.pendingApproval ?? 0) > 0) {
    notice = "Approvals are handled on the desktop";
  } else if (state?.capabilities.prompt === false) {
    notice = state.capabilities.promptReason
      ? `Prompt disabled: ${state.capabilities.promptReason}`
      : "Prompting is unavailable";
  } else if (state?.capabilities.move === false) {
    notice = state.capabilities.moveReason
      ? `Move disabled: ${state.capabilities.moveReason}`
      : "Move disabled: desktop composer is unavailable";
  } else if (state?.capabilities.model === false) {
    notice = "Model selection is unavailable";
  } else if (state?.capabilities.effort === false) {
    notice = "Effort selection is unavailable";
  }

  if (notice) {
    caps.innerHTML = `<span class="capability off">${esc(notice)}</span>`;
    caps.classList.remove("hidden");
  } else {
    caps.innerHTML = "";
    caps.classList.add("hidden");
  }

  // An unnamed session has no assigned accent, even when its theme has one.
  const sessionAccent =
    state?.title?.trim() && typeof state.accent === "string" && state.accent
      ? state.accent
      : "#808080";

  const modelColor = getThemeToken(
    state?.theme ?? null,
    "statusLineModel",
    sessionAccent,
  );
  const thinkingColor = getThinkingColor(state?.theme ?? null, state?.effort);

  const contextPercent =
    typeof state?.context?.percent === "number" &&
    Number.isFinite(state.context.percent)
      ? state.context.percent
      : undefined;
  const contextWindow =
    typeof state?.context?.contextWindow === "number" &&
    Number.isFinite(state.context.contextWindow) &&
    state.context.contextWindow > 0
      ? state.context.contextWindow
      : undefined;

  const ctxLevel =
    contextPercent !== undefined
      ? getContextUsageLevel(contextPercent, contextWindow)
      : "normal";

  const ctxTextColor = getContextUsageColor(state?.theme ?? null, ctxLevel);
  const costColor = getThemeToken(
    state?.theme ?? null,
    "statusLineCost",
    "#d4c090",
  );

  const composerBorderColor = sessionAccent;

  const root = document.documentElement;
  root.style.setProperty("--session-accent", sessionAccent);
  root.style.setProperty("--model-color", modelColor);
  root.style.setProperty("--thinking-color", thinkingColor);
  root.style.setProperty("--ctx-text-color", ctxTextColor);
  root.style.setProperty("--cost-color", costColor);
  root.style.setProperty(
    "--ctx-fill-width",
    `${
      contextPercent !== undefined
        ? Math.max(0, Math.min(100, contextPercent))
        : 0
    }%`,
  );
  root.style.setProperty("--composer-border", composerBorderColor);

  const modelBtn = requiredElement<HTMLButtonElement>("#model-open");
  modelBtn.textContent = state?.model ? normalizeModel(state.model) : "Model";
  modelBtn.disabled = !capability("model");

  const effortBtn = requiredElement<HTMLButtonElement>("#effort-open");
  effortBtn.textContent =
    state?.effort != null ? String(state.effort) : "Effort";
  effortBtn.disabled = !capability("effort");

  const ctxLabel = document.querySelector<HTMLElement>("#ctx-label");
  if (ctxLabel) {
    if (contextPercent !== undefined) {
      if (contextWindow !== undefined) {
        ctxLabel.textContent = `${contextPercent.toFixed(1)}%/${formatNumber(contextWindow)}`;
      } else {
        ctxLabel.textContent = `${contextPercent.toFixed(1)}%`;
      }
      ctxLabel.style.display = "";
    } else {
      ctxLabel.textContent = "";
      ctxLabel.style.display = "none";
    }
  }

  const costLabel = document.querySelector<HTMLElement>("#cost-label");
  if (costLabel) {
    const total = state?.cost?.total;
    if (typeof total === "number" && Number.isFinite(total) && total > 0) {
      costLabel.textContent = `$${total.toFixed(2)}`;
      costLabel.style.display = "";
    } else {
      costLabel.textContent = "";
      costLabel.style.display = "none";
    }
  }

  const abortBtn = requiredElement<HTMLButtonElement>("#abort");
  abortBtn.classList.toggle("hidden", !active || !capability("abort"));

  const sendBtn = requiredElement<HTMLButtonElement>("#send");
  sendBtn.classList.toggle("hidden", active);
  sendBtn.disabled = !capability("prompt") || !slot.connected;

  const effort =
    typeof state?.effort === "string" ? state.effort.trim().toLowerCase() : "";
  if (effort) {
    document.documentElement.dataset.effort = effort;
  } else {
    delete document.documentElement.dataset.effort;
  }

  const popover = document.querySelector<HTMLElement>("#effort-popover");
  if (popover && state) {
    const values = state.efforts || [];
    const range = popover.querySelector<HTMLInputElement>("#effort-range");
    const currentLabel = popover.querySelector<HTMLElement>("#effort-current");
    if (range && currentLabel && values.length) {
      const currentIdx = state.effort ? values.indexOf(state.effort) : -1;
      const idx = currentIdx >= 0 ? currentIdx : 0;
      const fraction = values.length > 1 ? idx / (values.length - 1) : 0;
      const val = values[idx] ?? "";
      range.max = String(values.length - 1);
      range.value = String(idx);
      popover.style.setProperty(
        "--effort-fill",
        `calc(${fraction * 100}% + ${32 * (1 - fraction)}px)`,
      );
      range.setAttribute("aria-valuetext", val);
      currentLabel.textContent = val;
    }
  }

  syncAnimation();
}

async function loadSlots(): Promise<void> {
  try {
    const result = await api<SlotsResponse>("/api/slots");
    slots = result.slots;
    if (!slots.length)
      slots = SLOT_IDS.map((id, index) => ({
        id,
        title: `Session ${index + 1}`,
        cwd: "",
        status: "disconnected",
        connected: false,
      }));
    updateSlots();
    if (!activeState) void loadState();
  } catch (error: unknown) {
    if (!slots.length)
      slots = SLOT_IDS.map((id, index) => ({
        id,
        title: `Session ${index + 1}`,
        cwd: "",
        status: "disconnected",
        connected: false,
      }));
    updateSlots();
    if (hasAuth(error)) openTokenModal();
  }
}
async function loadState(): Promise<void> {
  const request = ++stateRequest;
  try {
    const result = await api<ClientState>(
      `/api/slots/${encodeURIComponent(activeId)}/state`,
    );
    if (request !== stateRequest) return;
    activeState = result;
    cache.set(activeId, result);
    updateSlots();
    renderActive();
    window.setTimeout(() => {
      void acknowledgeSlot(activeId);
    }, 0);
  } catch (error: unknown) {
    if (request !== stateRequest) return;
    activeState = null;
    renderActive();
    if (hasAuth(error)) openTokenModal();
  }
}
async function sendAction(
  action: ApiAction,
  targetId: SlotId = activeId,
  targetState: ClientState | null = activeState,
): Promise<boolean> {
  const generation = targetState?.generation;
  if (generation == null) {
    showToast("Live state is not ready; action not sent", true);
    return false;
  }
  try {
    const result = await api<ApiResult>(
      `/api/slots/${encodeURIComponent(targetId)}/action`,
      {
        method: "POST",
        headers: { "X-OMP-Generation": String(generation) },
        body: JSON.stringify({ generation, ...action }),
      },
    );
    if (action.type === "move") {
      const res = result as Partial<MoveResponse>;
      if (res.ok !== true || res.submitted !== true)
        throw new Error("Move command was not submitted");
    }
    if (action.type === "command") {
      const res = result as Partial<CommandResponse>;
      if (res.ok !== true || res.submitted !== true)
        throw new Error("Slash command was not submitted");
    }
    window.setTimeout(() => {
      if (activeId === targetId && activeState?.generation === generation)
        void loadState();
    }, 120);
    return true;
  } catch (error: unknown) {
    showToast(
      hasAuth(error) ? "Access token rejected" : errorMessage(error),
      true,
    );
    if (hasAuth(error)) openTokenModal();
    return false;
  }
}
function handleSendSuccess(targetId: SlotId, draftAtSend: string): void {
  if (!drafts.has(targetId) || drafts.get(targetId) === draftAtSend) {
    drafts.set(targetId, "");
  }
  const livePrompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  if (activeId === targetId && livePrompt && livePrompt.value === draftAtSend) {
    livePrompt.value = "";
    drafts.set(targetId, "");
    resizePrompt();
    dismissedCommandDraft = null;
    renderCommandMenu();
  }
}
function sendPrompt(): void {
  const prompt = requiredElement<HTMLTextAreaElement>("#prompt");
  const text = prompt.value.trim();
  const targetId = activeId;
  const targetState = activeState;
  const draftAtSend = prompt.value;
  if (!text) return;

  const moveMatch = text.match(/^\/move(?:\s+(.+))?$/);
  if (moveMatch) {
    const rawPath = (moveMatch[1] || "").trim();
    if (!rawPath) {
      showToast("Specify a directory path for /move", true);
      return;
    }
    if (!capability("move")) {
      const reason = targetState?.capabilities.moveReason;
      showToast(
        reason
          ? `Move disabled: ${reason}`
          : "Move disabled: desktop composer is unavailable",
        true,
      );
      return;
    }
    void sendAction(
      { type: "move", path: rawPath, confirmed: true },
      targetId,
      targetState,
    ).then((sent) => {
      if (!sent) return;
      handleSendSuccess(targetId, draftAtSend);
    });
    return;
  }

  const slashName = text.match(/^\/([^\s/]+)(?:\s|$)/)?.[1];
  const slashCommand = targetState?.commands?.find(
    (command) =>
      command.name === slashName || command.aliases?.includes(slashName ?? ""),
  );
  if (slashCommand) {
    if (!capability("command")) {
      showToast("Commands are unavailable for this session", true);
      return;
    }
    void sendAction(
      { type: "command", text, confirmed: true },
      targetId,
      targetState,
    ).then((sent) => {
      if (!sent) return;
      handleSendSuccess(targetId, draftAtSend);
    });
    return;
  }
  if (!capability("prompt")) {
    showToast("Prompting is unavailable for this session", true);
    return;
  }
  void sendAction({ type: "prompt", text }, targetId, targetState).then(
    (sent) => {
      if (!sent) return;
      handleSendSuccess(targetId, draftAtSend);
    },
  );
}
function closeModal(): void {
  modal?.remove();
  modal = null;
}
function makeModal(title: string, body: HTMLElement): HTMLDivElement {
  closeModal();
  closeSidebarDrawer();
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn modal-close" aria-label="Close">×</button></div><div class="modal-body"></div></section>`;
  requiredElement<HTMLDivElement>(".modal-body", overlay).append(body);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal();
  });
  requiredElement<HTMLButtonElement>(".modal-close", overlay).addEventListener(
    "click",
    closeModal,
  );
  document.body.append(overlay);
  modal = overlay;
  return overlay;
}
function openTokenModal(): void {
  document.querySelector("#token-open")?.classList.remove("hidden");
  if (modal?.querySelector('[aria-label="Access token"]')) return;
  const body = document.createElement("form");
  body.innerHTML = `<p class="notice">Enter the access token configured for this gateway.</p><input type="password" autocomplete="current-password" placeholder="Access token" aria-label="Access token"><div class="modal-actions"><button type="button" class="ghost-btn modal-cancel">Cancel</button><button type="submit" class="send-btn">Save token</button></div>`;
  makeModal("Access token", body);
  const input = requiredElement<HTMLInputElement>("input", body);
  input.value = authToken();
  requiredElement<HTMLButtonElement>(".modal-cancel", body).addEventListener(
    "click",
    closeModal,
  );
  body.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();
    const token = input.value.trim();
    if (!token) {
      showToast("Enter an access token", true);
      return;
    }
    localStorage.setItem("omp-mobile-token", token);
    sessionStorage.removeItem("omp-mobile-token");
    closeModal();
    void loadSlots();
    void loadNotifications();
    void loadState();
  });
  window.setTimeout(() => input.focus(), 20);
}
function actionTargetCurrent(
  targetId: SlotId,
  generation: string | undefined,
): boolean {
  if (activeId === targetId && activeState?.generation === generation)
    return true;
  showToast("Session changed; reopen this control before sending", true);
  return false;
}
function openModelModal(): void {
  if (!capability("model")) {
    showToast("Model switching is unavailable", true);
    return;
  }
  const targetId = activeId;
  const targetState = activeState;
  const targetGeneration = targetState?.generation;
  const body = document.createElement("div");
  body.className = "model-picker";
  body.innerHTML = `<input type="search" placeholder="Search models" aria-label="Search models"><ul class="model-list"></ul>`;
  makeModal("Choose model", body).classList.add("picker-backdrop");
  const input = requiredElement<HTMLInputElement>("input", body);
  const list = requiredElement<HTMLUListElement>(".model-list", body);
  const draw = (): void => {
    const query = input.value.toLowerCase();
    const models = (targetState?.models || [])
      .map((model) =>
        typeof model === "string" ? { id: model, name: model } : model,
      )
      .filter((model) => model.id || model.name);
    const filtered = models.filter((m) =>
      `${m.provider || ""}/${m.id || ""} ${m.name || ""}`
        .toLowerCase()
        .includes(query),
    );
    list.innerHTML = filtered.length
      ? filtered
          .map(
            (m) =>
              `<li><button class="model-option${targetState?.model && typeof targetState.model !== "string" && targetState.model.provider === m.provider && targetState.model.id === m.id ? " selected" : ""}" data-provider="${esc(m.provider || "")}" data-id="${esc(m.id || m.name)}"><strong>${esc(m.name || m.id)}</strong><small>${esc([m.provider, m.id].filter(Boolean).join(" / "))}</small></button></li>`,
          )
          .join("")
      : `<li class="notice">No supported models are available.</li>`;
    list
      .querySelectorAll<HTMLButtonElement>(".model-option")
      .forEach((button) =>
        button.addEventListener("click", () => {
          if (!actionTargetCurrent(targetId, targetGeneration)) return;
          closeModal();
          const provider = button.dataset.provider;
          const id = button.dataset.id;
          if (provider && id)
            void sendAction(
              { type: "model", provider, id },
              targetId,
              targetState,
            );
        }),
      );
  };
  input.addEventListener("input", draw);
  draw();
  window.setTimeout(() => {
    if (window.matchMedia("(pointer: fine)").matches) input.focus();
    const selected = list.querySelector<HTMLElement>(".model-option.selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, 20);
}
let effortPopoverDocClickListener: ((event: MouseEvent) => void) | null = null;
function closeEffortPopover(): void {
  if (effortPopoverDocClickListener) {
    document.removeEventListener("click", effortPopoverDocClickListener);
    effortPopoverDocClickListener = null;
  }
  const popover = document.querySelector("#effort-popover");
  if (popover) popover.remove();
}
function toggleEffortPopover(): void {
  const existing = document.querySelector("#effort-popover");
  if (existing) {
    closeEffortPopover();
    return;
  }
  if (!capability("effort")) {
    showToast("Thinking effort is unavailable", true);
    return;
  }
  const targetId = activeId;
  const targetState = activeState;
  const targetGeneration = targetState?.generation;
  const values = targetState?.efforts || [];
  if (!values.length) {
    showToast("No supported effort levels reported", true);
    return;
  }
  const current = targetState?.effort ? values.indexOf(targetState.effort) : -1;
  const index = current >= 0 ? current : 0;
  const initialValue = values[index] ?? "";

  const popover = document.createElement("div");
  popover.id = "effort-popover";
  popover.className = "effort-popover";
  popover.innerHTML = `<span class="effort-current" id="effort-current">${esc(initialValue)}</span><div class="effort-track"><div class="effort-rail" aria-hidden="true"><div class="effort-stops">${values.map(() => "<span></span>").join("")}</div><div class="effort-fill"></div></div><input id="effort-range" type="range" class="effort-range" min="0" max="${values.length - 1}" step="1" value="${index}" aria-label="Reasoning effort" aria-valuetext="${esc(initialValue)}"></div>`;

  const dock = document.querySelector(".composer-dock");
  if (dock) {
    dock.prepend(popover);
  } else {
    document.body.append(popover);
  }

  const range = requiredElement<HTMLInputElement>("#effort-range", popover);
  const currentLabel = requiredElement<HTMLElement>("#effort-current", popover);
  const updateRange = (): void => {
    const fraction =
      values.length > 1 ? Number(range.value) / (values.length - 1) : 0;
    popover.style.setProperty(
      "--effort-fill",
      `calc(${fraction * 100}% + ${32 * (1 - fraction)}px)`,
    );
    range.setAttribute("aria-valuetext", values[Number(range.value)] ?? "");
  };
  updateRange();

  range.addEventListener("input", () => {
    updateRange();
    const val = values[Number(range.value)];
    if (val !== undefined) {
      currentLabel.textContent = val;
    }
  });

  range.addEventListener("change", () => {
    if (!actionTargetCurrent(targetId, targetGeneration)) return;
    const val = values[Number(range.value)];
    if (val !== undefined) {
      void sendAction({ type: "effort", value: val }, targetId, targetState);
    }
  });

  effortPopoverDocClickListener = (event: MouseEvent) => {
    const target = event.target as Node | null;
    const effortBtn = document.querySelector("#effort-open");
    if (popover && !popover.contains(target) && !effortBtn?.contains(target)) {
      closeEffortPopover();
    }
  };

  window.setTimeout(() => {
    if (effortPopoverDocClickListener) {
      document.addEventListener("click", effortPopoverDocClickListener);
    }
  }, 0);
}
async function loadPins(): Promise<void> {
  try {
    const result = await api<PinsResponse>("/api/pins");
    pins = Array.isArray(result?.pins) ? result.pins : [];
  } catch {
    pins = [];
  }
}
async function savePins(next: string[]): Promise<void> {
  try {
    const result = await api<PinsResponse>("/api/pins", {
      method: "PUT",
      body: JSON.stringify({ pins: next }),
    });
    pins = Array.isArray(result?.pins) ? result.pins : [];
    showToast("Pins updated");
  } catch (error: unknown) {
    showToast(errorMessage(error), true);
  }
}
function selectDirectory(dirPath: string): void {
  const prompt = requiredElement<HTMLTextAreaElement>("#prompt");
  const command = `/move ${dirPath}`;
  prompt.value = command;
  drafts.set(activeId, command);
  resizePrompt();
  closeModal();
  prompt.focus();
}
type DirTreeNode = {
  path: string;
  name: string;
  expanded: boolean;
  loading: boolean;
  entries?: DirectoryEntry[];
  error?: string;
};
async function openDirectoryModal(
  path: string = "/home/mrw/dev",
): Promise<void> {
  const body = document.createElement("div");
  body.className = "directory-modal";
  body.innerHTML = `<div class="directory-toolbar"><button type="button" class="ghost-btn" id="tree-up" title="Go to parent directory">↑ Up</button><input type="text" class="path-input" id="tree-path-input" aria-label="Directory path" placeholder="Directory path"><button type="button" class="ghost-btn" id="tree-go">Go</button><button type="button" class="ghost-btn" id="tree-pin-btn" title="Pin or unpin directory">☆ Pin</button></div><div class="directory-pins" id="tree-pins-bar"></div><div class="directory-tree" id="tree-container"><div class="tree-notice">Loading directories…</div></div>`;

  makeModal("Folder explorer", body).classList.add("picker-backdrop");

  const pathInput = requiredElement<HTMLInputElement>("#tree-path-input", body);
  const upButton = requiredElement<HTMLButtonElement>("#tree-up", body);
  const goButton = requiredElement<HTMLButtonElement>("#tree-go", body);
  const pinCurrentBtn = requiredElement<HTMLButtonElement>(
    "#tree-pin-btn",
    body,
  );
  const pinsBar = requiredElement<HTMLDivElement>("#tree-pins-bar", body);
  const treeContainer = requiredElement<HTMLDivElement>(
    "#tree-container",
    body,
  );

  let currentBrowsingPath = path;
  let currentParent = "";
  let workspaceRoot = "/";
  const nodeCache = new Map<string, DirTreeNode>();

  const updatePinButton = (): void => {
    const isPinned = pins.includes(currentBrowsingPath);
    pinCurrentBtn.textContent = isPinned ? "★ Pinned" : "☆ Pin";
    pinCurrentBtn.classList.toggle("active", isPinned);
  };

  const renderPinsBar = (): void => {
    if (!pins.length) {
      pinsBar.innerHTML = `<span class="directory-pins-label">No pinned folders</span>`;
      return;
    }
    pinsBar.innerHTML =
      `<span class="directory-pins-label">Pinned:</span>` +
      pins
        .map(
          (p) =>
            `<div class="pin-chip"><button type="button" data-pin="${esc(p)}">${ICONS.folder}<span>${esc(p)}</span></button><button type="button" class="pin-remove" data-remove-pin="${esc(p)}" title="Remove pin">×</button></div>`,
        )
        .join("");

    pinsBar
      .querySelectorAll<HTMLButtonElement>("[data-pin]")
      .forEach((chip) => {
        chip.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".pin-remove")) return;
          const p = chip.dataset.pin;
          if (p) void navigateTo(p, true);
        });
      });

    pinsBar
      .querySelectorAll<HTMLButtonElement>("[data-remove-pin]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const remove = btn.dataset.removePin;
          if (remove) {
            void savePins(pins.filter((p) => p !== remove)).then(() => {
              renderPinsBar();
              updatePinButton();
              renderTreeDOM();
            });
          }
        });
      });
  };

  const fetchDirEntries = async (
    targetPath: string,
  ): Promise<DirectoryListing | null> => {
    try {
      return await api<DirectoryResponse>(
        `/api/directories?path=${encodeURIComponent(targetPath)}`,
      );
    } catch (error: unknown) {
      if (hasAuth(error)) {
        openTokenModal();
      }
      return null;
    }
  };

  const renderTreeNode = (node: DirTreeNode, depth: number = 0): string => {
    const isPinned = pins.includes(node.path);
    const isLeaf = node.entries && node.entries.length === 0;

    let toggleHtml = "";
    if (node.loading) {
      toggleHtml = `<span class="tree-toggle">…</span>`;
    } else if (isLeaf) {
      toggleHtml = `<span class="tree-toggle leaf">•</span>`;
    } else {
      toggleHtml = `<button type="button" class="tree-toggle" data-toggle="${esc(node.path)}" aria-expanded="${node.expanded}" aria-label="${node.expanded ? "Collapse" : "Expand"} ${esc(node.name)}">${node.expanded ? "▾" : "▸"}</button>`;
    }

    let childrenHtml = "";
    if (node.expanded) {
      if (node.loading) {
        childrenHtml = `<ul class="tree-children"><li class="tree-notice">Loading…</li></ul>`;
      } else if (node.error) {
        childrenHtml = `<ul class="tree-children"><li class="tree-notice error">${esc(node.error)}</li></ul>`;
      } else if (node.entries && node.entries.length === 0) {
        childrenHtml = `<ul class="tree-children"><li class="tree-notice">No subdirectories</li></ul>`;
      } else if (node.entries) {
        childrenHtml = `<ul class="tree-children">${node.entries
          .filter((entry) => entry.kind === "directory" || !entry.kind)
          .map((entry) => {
            const childNode = nodeCache.get(entry.path) || {
              path: entry.path,
              name: entry.name,
              expanded: false,
              loading: false,
            };
            nodeCache.set(entry.path, childNode);
            return renderTreeNode(childNode, depth + 1);
          })
          .join("")}</ul>`;
      }
    }

    return `<li class="tree-node" data-node-path="${esc(node.path)}"><div class="tree-row">${toggleHtml}<span class="tree-icon">${ICONS.folder}</span><button type="button" class="tree-name" data-toggle="${esc(node.path)}" title="Open ${esc(node.path)}">${esc(node.name)}</button><div class="tree-actions"><button type="button" class="tree-pin-btn${isPinned ? " pinned" : ""}" data-tree-pin="${esc(node.path)}" title="${isPinned ? "Unpin" : "Pin"} folder">${isPinned ? "★" : "☆"}</button><button type="button" class="tree-select-btn" data-select="${esc(node.path)}" aria-label="Select ${esc(node.path)}">Select</button></div></div>${childrenHtml}</li>`;
  };

  const renderTreeDOM = (): void => {
    pathInput.value = currentBrowsingPath;
    upButton.disabled =
      !currentParent ||
      currentParent === currentBrowsingPath ||
      currentBrowsingPath === workspaceRoot;
    updatePinButton();

    const rootNode = nodeCache.get(currentBrowsingPath);
    if (!rootNode) {
      treeContainer.innerHTML = `<div class="tree-notice">Loading directories…</div>`;
      return;
    }

    if (rootNode.loading) {
      treeContainer.innerHTML = `<div class="tree-notice">Loading ${esc(currentBrowsingPath)}…</div>`;
      return;
    }

    if (rootNode.error) {
      treeContainer.innerHTML = `<div class="tree-notice error">${esc(rootNode.error)}</div>`;
      return;
    }

    treeContainer.innerHTML = `<ul class="directory-tree-root">${renderTreeNode(rootNode)}</ul>`;

    attachTreeEvents();
  };

  const attachTreeEvents = (): void => {
    treeContainer
      .querySelectorAll<HTMLButtonElement>("[data-toggle]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const targetPath = btn.dataset.toggle;
          if (!targetPath) return;
          const node = nodeCache.get(targetPath);
          if (!node) return;
          if (node.expanded) {
            node.expanded = false;
            renderTreeDOM();
          } else {
            node.expanded = true;
            if (!node.entries && !node.loading) {
              node.loading = true;
              renderTreeDOM();
              void fetchDirEntries(node.path).then((res) => {
                node.loading = false;
                if (res) {
                  node.entries = res.entries;
                  node.error = undefined;
                } else {
                  node.error = "Unable to read directory";
                }
                renderTreeDOM();
              });
            } else {
              renderTreeDOM();
            }
          }
        });
      });

    treeContainer
      .querySelectorAll<HTMLElement>("[data-select]")
      .forEach((el) => {
        el.addEventListener("click", () => {
          const selectedPath = el.dataset.select;
          if (selectedPath) selectDirectory(selectedPath);
        });
      });

    treeContainer
      .querySelectorAll<HTMLButtonElement>("[data-tree-pin]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const pinPath = btn.dataset.treePin;
          if (!pinPath) return;
          const next = pins.includes(pinPath)
            ? pins.filter((p) => p !== pinPath)
            : [...pins, pinPath];
          void savePins(next).then(() => {
            renderPinsBar();
            updatePinButton();
            renderTreeDOM();
          });
        });
      });
  };

  const navigateTo = async (
    targetPath: string,
    expandIfPinned: boolean = false,
  ): Promise<void> => {
    let listing = await fetchDirEntries(targetPath);
    if (!listing) {
      listing = await api<DirectoryResponse>("/api/directories").catch(
        () => null,
      );
      if (!listing) {
        treeContainer.innerHTML = `<div class="tree-notice error">Directory access is unavailable.</div>`;
        return;
      }
      showToast(`Showing workspace root (${listing.path})`);
    }

    currentBrowsingPath = listing.path;
    currentParent = listing.parent || "";
    workspaceRoot = listing.root || "/";

    const rootNode: DirTreeNode = {
      path: listing.path,
      name: listing.path.split("/").pop() || listing.path,
      expanded: true,
      loading: false,
      entries: listing.entries,
    };
    nodeCache.set(listing.path, rootNode);

    for (const entry of listing.entries) {
      if (entry.kind === "directory" || !entry.kind) {
        const isDevOrPinned =
          entry.path.endsWith("/dev") ||
          pins.includes(entry.path) ||
          (expandIfPinned && pins.some((p) => p.startsWith(entry.path)));
        if (isDevOrPinned) {
          const childNode: DirTreeNode = nodeCache.get(entry.path) || {
            path: entry.path,
            name: entry.name,
            expanded: true,
            loading: true,
          };
          childNode.expanded = true;
          childNode.loading = true;
          nodeCache.set(entry.path, childNode);

          void fetchDirEntries(entry.path).then((subListing) => {
            childNode.loading = false;
            if (subListing) {
              childNode.entries = subListing.entries;
              childNode.error = undefined;
            } else {
              childNode.error = "Unable to read directory";
            }
            renderTreeDOM();
          });
        }
      }
    }

    renderTreeDOM();
  };

  upButton.addEventListener("click", () => {
    if (currentParent && currentParent !== currentBrowsingPath) {
      void navigateTo(currentParent);
    }
  });

  goButton.addEventListener("click", () => {
    const entered = pathInput.value.trim();
    if (entered) void navigateTo(entered);
  });

  pathInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const entered = pathInput.value.trim();
      if (entered) void navigateTo(entered);
    }
  });

  pinCurrentBtn.addEventListener("click", () => {
    const isPinned = pins.includes(currentBrowsingPath);
    const next = isPinned
      ? pins.filter((p) => p !== currentBrowsingPath)
      : [...pins, currentBrowsingPath];
    void savePins(next).then(() => {
      renderPinsBar();
      updatePinButton();
      renderTreeDOM();
    });
  });

  renderPinsBar();
  await navigateTo(path, true);
}
async function start(): Promise<void> {
  renderShell();
  applyRawMode();
  applyReasoningToggle();
  await syncPermissionState();
  updateNotificationButton();
  if (!authToken()) {
    openTokenModal();
  }
  await Promise.all([
    loadPins(),
    registerNotifications(),
    loadNotificationConfig(),
  ]);
  await loadSlots();
  await loadNotifications();
  window.setInterval(() => {
    void loadSlots();
  }, 8000);
  window.setInterval(() => {
    void loadNotifications();
  }, 8000);
  window.setInterval(() => {
    if (document.visibilityState === "visible") void loadState();
  }, 2800);
  window.setInterval(() => {
    if (document.visibilityState === "visible") void loadRawTerminal();
  }, 2000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void syncPermissionState().then(() => updateNotificationButton());
      void loadNotifications();
      void loadState();
      window.setTimeout(() => {
        void acknowledgeSlot(activeId);
      }, 0);
    }
    // Indicators only repaint while the app is on screen.
    syncAnimation();
  });
  window
    .matchMedia?.("(prefers-reduced-motion: reduce)")
    .addEventListener?.("change", () => syncAnimation());
}
void start();
