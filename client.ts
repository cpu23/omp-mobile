import {
  isSlotId,
  type ActivityJob,
  type ActivitySubagent,
  type CapabilityMap,
  type CommandResponse,
  type CompletionMarker,
  type CreateSlotRequest,
  type DirectoryEntry,
  type DirectoryListing,
  type MoveResponse,
  type OmpMessage,
  type PinsResponse,
  type SessionActivity,
  type SessionSummary,
  type SessionsResponse,
  type SlotAction,
  type SlotId,
  type SlotResponse,
  type SlotsResponse,
  type SlotState,
  type SlashCommand,
  type SlotSummary,
  type TerminalSnapshot,
} from "./shared";
import {
  buildMoveCompletion,
  moveBasePath,
  moveContextKey,
  resolveMoveCandidate,
  selectedMovePath,
  type MoveCompletion,
  type MoveListing,
} from "./move-completion";

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
type AskOption = { label: string; description?: string };
type AskQuestion = {
  id?: string;
  question: string;
  header?: string;
  options: AskOption[];
  multi: boolean;
  recommended?: number;
};
type AskAnswer = {
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
};
type AskDisplay = {
  status: "pending" | "completed" | "redirected";
  questions: AskQuestion[];
  answers?: Array<AskAnswer | null>;
};
type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      output?: string;
      ask?: AskDisplay;
      isError?: boolean;
      task?: { agents: ActivitySubagent[]; asyncState?: string };
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
type ApiResult = unknown;
type ApiError = Error & { auth?: boolean; status?: number };
type ApiAction =
  | Omit<Extract<SlotAction, { type: "prompt" }>, "generation">
  | Omit<Extract<SlotAction, { type: "abort" }>, "generation">
  | Omit<Extract<SlotAction, { type: "model" }>, "generation">
  | Omit<Extract<SlotAction, { type: "effort" }>, "generation">
  | Omit<Extract<SlotAction, { type: "command" }>, "generation">
  | Omit<Extract<SlotAction, { type: "move" }>, "generation">
  | Omit<Extract<SlotAction, { type: "force" }>, "generation">;
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

const app = requiredElement<HTMLElement>("#app");
const drafts = new Map<SlotId, string>();
const cache = new Map<SlotId, ClientState>();
/**
 * Requested transcript per runtime, held until the daemon reports the file omp
 * sniffed: until then a resumed session's history row must still dedupe against
 * its live card, and a second tap must adopt that runtime instead of spawning a
 * sibling. Entries die as soon as the daemon reports a session file or the
 * runtime itself disappears.
 */
const resumeAdoptedFiles = new Map<SlotId, string>();
let slots: SlotSummary[] = [];
let sessions: SessionSummary[] = [];
let sessionsError: string | null = null;
let sessionsLoading = false;
let sessionsRequest = 0;
let sessionsQuery = "";
let sessionsQueryLoaded = "";
let slotsError: string | null = null;
let stateError: string | null = null;
let slotsRequest = 0;
let stateRequest = 0;
let initialStateRequested = false;
let creatingSession = false;
let activeId: SlotId = "";
let activeState: ClientState | null = null;
type PromptSubmission = {
  generation: string;
  forceable: boolean;
  forceRequested: boolean;
};
const inFlightPromptSubmissions = new Map<string, PromptSubmission>();
const forceRequestsInFlight = new Set<string>();
let recentForceableSubmission:
  | { targetId: SlotId; generation: string; expiresAt: number }
  | null = null;
let modal: HTMLDivElement | null = null;
let modalDismiss: (() => void) | null = null;
let toastTimer = 0;
let pins: string[] = [];
let transcriptNearBottom = true;
let lastRenderedMessageCount = 0;
let lastTranscriptSnapshot: TranscriptRenderSnapshot | null = null;
let lastEmptyTranscriptContent: string | null = null;
let commandSelection = 0;
let dismissedCommandDraft: string | null = null;
let moveCompletion: MoveCompletion | null = null;
let moveCompletionTimer = 0;
let moveCompletionSerial = 0;
let dismissedMoveDraft: string | null = null;
/** One activity drawer, retained only for the session that opened it. */
let todosExpanded = false;
let activitySlot: SlotId | null = null;
let lastComposerWorkingText = "";
let unreadBySlot = new Map<SlotId, CompletionMarker[]>();
let notificationConfig: NotificationConfig | null = null;
let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
let notificationSubscribed = false;
let notificationBusy = false;
const acknowledging = new Set<SlotId>();
const requestedSlot = new URLSearchParams(window.location.search).get("slot");
if (isSlotId(requestedSlot)) activeId = requestedSlot;
else {
  const storedActive = localStorage.getItem("omp-mobile-active-slot");
  if (isSlotId(storedActive)) activeId = storedActive;
}

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
  plus: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
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
    if (!isSlotId(item.slot)) continue;
    // Only runtimes the sidebar can open are actionable; the gateway keeps
    // unread markers for deleted runtimes until they are acknowledged.
    if (!slots.some((slot) => slot.id === item.slot)) continue;
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
  if (liveState?.title?.trim()) return liveState.title.trim();
  if (slot.title?.trim()) return slot.title.trim();
  return slot.id;
}
function slotById(id: SlotId): SlotSummary {
  const found = slots.find((s) => s.id === id);
  if (found) return found;
  return {
    id,
    title: id,
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
  const topTitle = document.querySelector<HTMLElement>("#top-title");
  if (!topTitle) return;
  if (!activeId) {
    topTitle.textContent = slotsError
      ? "Live sessions unavailable"
      : slots.length
        ? "Select a session"
        : "No live session";
    return;
  }
  topTitle.textContent = slotTitle(slotById(activeId), activeState);
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
    <header class="topbar"><button class="icon-btn menu-btn" id="menu-open" type="button" aria-label="Open sessions" aria-controls="sidebar" aria-expanded="false">${ICONS.menu}</button><div class="top-title-wrap"><span class="top-title" id="top-title">Connecting…</span></div></header>
    <main class="main"><aside class="sidebar" id="sidebar" aria-label="Sessions">
      <div id="sidebar-sessions" class="sidebar-view">
        <button class="sidebar-action" id="new-session" type="button" aria-label="Start a new session">${ICONS.plus}<span>New session</span></button>
        <button class="sidebar-action" id="pin-open">Folders & pins</button>
        <div class="sidebar-search"><input id="session-search" type="search" placeholder="Search sessions…" aria-label="Search sessions" autocomplete="off" spellcheck="false"></div>
        <div class="slot-list" id="slot-list"></div>
        <button class="icon-btn" id="sidebar-settings-open" type="button" aria-label="Settings" title="Settings" aria-controls="sidebar-settings" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9L4.2 6l-2 3.5 1.5 1.7v2L2.2 15l2 3.5 2.2-.4 2 .9L9 21h4l.6-2.4 2-.9 2.2.4 2-3.5-1.5-1.7v-2l1.5-1.7-2-3.5-2.2.4-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></svg></button>
      </div>
      <section id="sidebar-settings" class="sidebar-view" aria-label="Settings" hidden>
        <div class="sidebar-head"><button class="icon-btn" id="sidebar-settings-back" type="button" aria-label="Back to sessions" title="Back to sessions"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14"/></svg></button><span>Settings</span></div>
        <button class="sidebar-action" id="raw-toggle" type="button" aria-label="Show raw terminal" aria-pressed="false">${ICONS.terminal}<span>Terminal view</span></button>
        <button class="sidebar-action" id="reasoning-toggle" type="button" aria-label="Toggle reasoning" aria-pressed="true">${ICONS.sparkles}<span>Reasoning</span><span id="reasoning-state">On</span></button>
        <button class="sidebar-action" id="notifications-enable" type="button" aria-label="Enable notifications" title="Enable notifications">${ICONS.bellDefault}<span>Notifications</span></button>
        <button class="sidebar-action" id="token-open" type="button">${ICONS.key}<span>Access token</span></button>
        <form id="session-limit-form" class="session-limit">
          <label for="session-limit-input">Max sessions</label>
          <input id="session-limit-input" type="number" min="1" step="1" required inputmode="numeric" disabled aria-describedby="session-limit-status">
          <button class="sidebar-action" id="session-limit-save" type="submit" disabled>Save session limit</button>
          <p id="session-limit-status" role="status" aria-live="polite"></p>
          <button class="sidebar-action" id="session-limit-restart" type="button" hidden>Restart daemon to apply</button>
        </form>
      </section>
    </aside><button class="sidebar-backdrop" id="sidebar-close" type="button" aria-label="Close sessions"></button>
    <section class="workspace"><div class="capabilities hidden" id="capabilities"></div><div class="transcript" id="transcript" tabindex="0" aria-label="Session transcript"></div><pre class="raw-view hidden" id="raw-view" tabindex="0" aria-label="Raw terminal output"></pre><button class="scroll-fab hidden" id="scroll-bottom" type="button" aria-label="Scroll to bottom">${ICONS.arrowDown}</button></section></main>
    <div class="composer-dock"><section class="activity-dock hidden" id="activity-dock" aria-label="Session activity"><div id="activity-content" class="activity-content hidden"><div class="activity-todos" id="activity-todos"></div><div class="activity-details hidden" id="activity-details"></div></div></section><form class="composer" id="composer"><div class="command-menu hidden" id="command-menu" role="listbox" aria-label="Slash commands"></div><div class="composer-ctx"></div><div class="composer-working hidden" id="composer-working" role="status" aria-live="polite"><span class="working-spinner" aria-hidden="true">${SPINNER_FRAMES[0]}</span><span class="shimmer shimmer-accent" id="composer-working-text">${shimmerMarkup("Working…")}</span></div><div class="composer-input"><textarea id="prompt" rows="1" placeholder="Message this session…" aria-label="Message this session" aria-autocomplete="list" aria-controls="command-menu" aria-expanded="false"></textarea></div><div class="composer-tools"><div class="composer-meta" id="composer-meta"><button type="button" class="ghost-btn" id="model-open">Model</button><button type="button" class="ghost-btn" id="effort-open">Effort</button><span id="ctx-label"></span><span id="cost-label"></span></div><button type="button" class="abort-btn hidden" id="abort">Stop</button><button type="submit" class="send-btn" id="send">Send</button></div></form>
  </div>`;
  requiredElement<HTMLElement>("#activity-content").insertAdjacentHTML("beforebegin",
    `<button type="button" class="todo-pull-tab" id="todo-toggle" aria-expanded="false" aria-controls="activity-content"><span id="todo-toggle-label">Activity</span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><path d="m3 7 3-3 3 3"/></svg></button>`);
  const todoTab = requiredElement<HTMLButtonElement>("#todo-toggle");
  let todoPullStart: number | null = null;
  let todoPulled = false;
  todoTab.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    todoPullStart = event.clientY;
    todoPulled = false;
    todoTab.setPointerCapture(event.pointerId);
  });
  todoTab.addEventListener("pointerup", (event) => {
    if (todoPullStart === null) return;
    const distance = event.clientY - todoPullStart;
    todoPullStart = null;
    if (Math.abs(distance) < 12) return;
    todoPulled = true;
    todosExpanded = distance < 0;
    activitySlot = activeId;
    renderActivity(activeState);
    syncAnimation();
  });
  todoTab.addEventListener("pointercancel", () => { todoPullStart = null; });
  todoTab.addEventListener("click", () => {
    if (todoPulled) {
      todoPulled = false;
      return;
    }
    todosExpanded = !todosExpanded;
    activitySlot = activeId;
    renderActivity(activeState);
    syncAnimation();
  });
  const sidebar = requiredElement<HTMLElement>("#sidebar");
  const menu = requiredElement<HTMLButtonElement>("#menu-open");
  bindSidebarSettings(sidebar);
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
  bindSidebarSwipe(requiredElement<HTMLElement>("#transcript"), 1, openSidebar);
  bindSidebarSwipe(sidebar, -1, closeSidebar);
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
  requiredElement<HTMLButtonElement>("#new-session").addEventListener(
    "click",
    () => {
      closeSidebarDrawer();
      startNewSession();
    },
  );
  const sessionSearch = requiredElement<HTMLInputElement>("#session-search");
  let searchTimer = 0;
  sessionSearch.addEventListener("input", () => {
    sessionsQuery = sessionSearch.value;
    // Re-render immediately so the rows narrow with the typed text; the
    // debounced request then re-runs the daemon-side search, which is how
    // transcripts beyond the recent window stay reachable.
    updateSlots();
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void loadSessions(), 200);
  });
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
  const effortOpen = requiredElement<HTMLButtonElement>("#effort-open");
  // Tapping the button must not pull focus out of the composer: losing it
  // dismisses the software keyboard before the popover even opens.
  effortOpen.addEventListener("pointerdown", (event) => {
    if (composerFocused()) event.preventDefault();
  });
  effortOpen.addEventListener("click", toggleEffortPopover);
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
    dismissedMoveDraft = null;
    commandSelection = 0;
    resizePrompt();
    renderCommandMenu();
  });
  prompt.addEventListener("keydown", (event: KeyboardEvent) => {
    const menu = requiredElement<HTMLElement>("#command-menu");
    const menuOpen = !menu.classList.contains("hidden");
    const moveValue = moveDraft(prompt.value);
    const isMove = moveValue !== null;
    // Only a completion for the active session/cwd may drive keyboard
    // selection: a stale one would fill a path from another directory.
    const moveSuggestions =
      isMove && moveCompletion?.context === activeMoveContext()
        ? moveCompletion.suggestions
        : [];
    const matches = isMove ? [] : matchingCommands(prompt.value);
    const optionCount = isMove ? moveSuggestions.length : matches.length;
    if (menuOpen && optionCount > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        commandSelection =
          (commandSelection + direction + optionCount) % optionCount;
        renderCommandMenu();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        if (isMove) {
          const suggestion = moveSuggestions[commandSelection];
          if (suggestion) applyMoveSelection(suggestion.path);
        } else {
          selectCommand(matches[commandSelection]);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissedCommandDraft = prompt.value;
        dismissedMoveDraft = prompt.value;
        renderCommandMenu();
        return;
      }
      // Enter for a move confirmation falls through to sendPrompt, which
      // submits the typed directory or the highlighted suggestion.
      if (
        !isMove &&
        event.key === "Enter" &&
        !event.shiftKey &&
        `/${matches[commandSelection]?.name}` !== prompt.value.trim()
      ) {
        event.preventDefault();
        selectCommand(matches[commandSelection]);
        return;
      }
    } else if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      dismissedCommandDraft = prompt.value;
      dismissedMoveDraft = prompt.value;
      renderCommandMenu();
      return;
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

/** Last one or two path segments, so phone-width cards stay readable. */
function compactPath(path: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Runtimes are daemon-owned, so "daemon unavailable" must never read as an
 * empty list: the sidebar says which of the two states it is in, and retry
 * re-runs the same gateway call.
 */
function slotsNoticeMarkup(error: string): string {
  const daemonDown = /daemon unavailable/i.test(error);
  const message = daemonDown
    ? "Desktop daemon unavailable. Start omp-desktop, then retry."
    : `Live sessions unavailable: ${error}`;
  return `<div class="slot-empty error${daemonDown ? " daemon-down" : ""}" role="status" title="${esc(error)}">${esc(message)}<button type="button" class="ghost-btn" id="slots-retry">Retry</button></div>`;
}

/**
 * Session history shares the live list's failure contract: it is daemon-owned,
 * so an outage must read as unavailable rather than as an empty list, and retry
 * re-runs the same gateway call.
 */
function sessionsNoticeMarkup(error: string): string {
  return `<div class="slot-empty error" role="status" title="${esc(error)}">Session history unavailable: ${esc(error)}<button type="button" class="ghost-btn" id="sessions-retry">Retry</button></div>`;
}

/** Live runtime card: the only rows carrying connection state, unread and stop. */
function slotCardMarkup(slot: SlotSummary): string {
  const connected = slot.connected === true;
  const slotState = slot.id === activeId ? activeState : cache.get(slot.id);
  const isBusy =
    connected && isAgentActive(slot.id === activeId ? activeState : null, slot);
  const unread = unreadBySlot.get(slot.id)?.length || 0;
  const title = slotTitle(slot, slotState);
  return `<div class="slot-card${slot.id === activeId ? " active" : ""}${!connected ? " offline" : ""}${isBusy ? " busy" : ""}" data-slot="${esc(slot.id)}" role="button" tabindex="0" aria-label="Open ${esc(title)}${isBusy ? " — Working" : ""}"><div class="slot-title">${isBusy ? `<span class="slot-working"><span class="working-spinner" aria-hidden="true">${SPINNER_FRAMES[0]}</span><span class="slot-title-text shimmer shimmer-accent">${shimmerMarkup(title)}</span></span>` : `<span>${esc(title)}</span>`}<span class="slot-badges">${!connected ? `<span class="slot-offline">offline</span>` : ""}${unread > 0 ? `<span class="slot-unread" aria-label="${unread} unread completion${unread === 1 ? "" : "s"}">${unread > 99 ? "99+" : unread}</span>` : ""}</span></div>${slot.summary && slot.summary.trim() ? `<div class="slot-summary">${esc(slot.summary)}</div>` : ""}<div class="slot-meta"><span class="slot-cwd" title="${esc(slot.cwd)}">${esc(compactPath(slot.cwd) || "Working directory unavailable")}</span><button type="button" class="slot-stop" data-stop="${esc(slot.id)}" aria-label="Stop ${esc(title)}" title="Stop this session">Stop</button></div></div>`;
}

/**
 * The sidebar shows the daemon's sessions exactly once, in the desktop's order:
 * live runtimes first, then transcripts no runtime owns, most recently used
 * first (the daemon sorts them). A running transcript is only ever its live
 * card — its history row is dropped by transcript path.
 */
function updateSlots(): void {
  const list = document.querySelector<HTMLDivElement>("#slot-list");
  if (!list) return;
  const query = sessionsQuery.trim().toLowerCase();
  const matches = (haystack: string): boolean =>
    !query || haystack.toLowerCase().includes(query);
  const liveSlots = query
    ? slots.filter((slot) =>
        matches(
          `${slotTitle(slot, slot.id === activeId ? activeState : cache.get(slot.id))} ${slot.cwd} ${slot.sessionFile ?? ""}`,
        ),
      )
    : slots;
  const liveFiles = new Set<string>();
  for (const slot of slots)
    if (slot.sessionFile) liveFiles.add(slot.sessionFile);
  // The gateway's search also matches a session's first prompt and id, which
  // this summary does not carry; trust its filtering once the response for the
  // current query has landed, and filter locally only while it is in flight so
  // the rows narrow with the typed text.
  const serverFiltered = query === sessionsQueryLoaded;
  const seen = new Set<string>();
  const historyRows: string[] = [];
  for (const session of sessions) {
    if (liveFiles.has(session.path) || seen.has(session.path)) continue;
    seen.add(session.path);
    if (
      query &&
      !serverFiltered &&
      !matches(`${session.title} ${session.cwd} ${session.path} ${session.id}`)
    )
      continue;
    const cost = session.costUsd > 0 ? `$${session.costUsd.toFixed(2)}` : "";
    historyRows.push(
      `<div class="slot-card recent" data-session="${esc(session.path)}" role="button" tabindex="0" aria-label="Resume ${esc(session.title || session.path)}"><div class="slot-title"><span>${esc(session.title || session.path)}</span><span class="slot-badges"><span class="slot-state">${esc(relativeTime(session.updatedAt))}</span>${cost ? `<span class="slot-cost">${cost}</span>` : ""}</span></div><div class="slot-meta"><span class="slot-cwd" title="${esc(session.cwd)}">${esc(compactPath(session.cwd) || "Working directory unavailable")}</span></div></div>`,
    );
  }
  const notices: string[] = [];
  if (slotsError) notices.push(slotsNoticeMarkup(slotsError));
  else if (sessionsError) notices.push(sessionsNoticeMarkup(sessionsError));
  else if (sessionsLoading && !sessions.length)
    notices.push(`<div class="slot-empty" role="status">Loading sessions…</div>`);
  const liveRows = liveSlots.map(slotCardMarkup).join("");
  // Separates the live runtimes from the historical rows below them, so the
  // two row kinds stay distinguishable without a second list.
  const divider =
    liveRows && historyRows.length
      ? `<div class="slot-sep">Recent</div>`
      : "";
  const rows = liveRows + divider + historyRows.join("");
  list.innerHTML =
    notices.join("") +
    (rows ||
      (notices.length
        ? ""
        : `<div class="slot-empty" role="status">${query ? "No sessions match this search." : "No sessions yet. Start a new one."}</div>`));
  list.querySelectorAll<HTMLElement>("[data-slot]").forEach((node) => {
    const id = node.dataset.slot;
    if (!isSlotId(id)) return;
    node.style.setProperty("--slot-accent", sidebarSlotAccent(slotById(id)));
    node.addEventListener("click", () => selectSlot(id));
    node.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectSlot(id);
    });
  });
  list.querySelectorAll<HTMLElement>("[data-session]").forEach((node) => {
    const path = node.dataset.session;
    if (!path) return;
    const open = (): void => void openHistorySession(path);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  });
  list.querySelectorAll<HTMLButtonElement>("[data-stop]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = button.dataset.stop;
      if (isSlotId(id)) void stopSlot(id);
    });
  });
  list
    .querySelectorAll<HTMLButtonElement>("#slots-retry")
    .forEach((button) =>
      button.addEventListener("click", () => void loadSlots()),
    );
  list
    .querySelectorAll<HTMLButtonElement>("#sessions-retry")
    .forEach((button) =>
      button.addEventListener("click", () => void loadSessions()),
    );
  syncTopBar();
  syncAnimation();
}
function bindSidebarSettings(sidebar: HTMLElement): void {
  const sessions = requiredElement<HTMLElement>("#sidebar-sessions", sidebar);
  const settings = requiredElement<HTMLElement>("#sidebar-settings", sidebar);
  const open = requiredElement<HTMLButtonElement>("#sidebar-settings-open", sidebar);
  const back = requiredElement<HTMLButtonElement>("#sidebar-settings-back", sidebar);
  const form = requiredElement<HTMLFormElement>("#session-limit-form", sidebar);
  const input = requiredElement<HTMLInputElement>("#session-limit-input", sidebar);
  const save = requiredElement<HTMLButtonElement>("#session-limit-save", sidebar);
  const restart = requiredElement<HTMLButtonElement>("#session-limit-restart", sidebar);
  const status = requiredElement<HTMLElement>("#session-limit-status", sidebar);
  let busy = false;
  let loaded = false;
  type RuntimeSettings = {
    maxRuntimes: number;
    effectiveMaxRuntimes: number;
    restartRequired: boolean;
  };
  const update = async (method: "GET" | "PUT" | "POST"): Promise<void> => {
    if (busy) return;
    busy = true;
    input.disabled = save.disabled = restart.disabled = true;
    status.textContent = method === "POST"
      ? "Restarting the shared daemon stops running work in desktop and mobile. Sessions reopen from saved transcripts; execution does not continue. Wait until work finishes before restarting."
      : "Loading session limit…";
    try {
      if (method === "POST") await api("/api/restart", { method: "POST" });
      let current: RuntimeSettings | undefined;
      const deadline = Date.now() + 60_000;
      do {
        try {
          current = await api<RuntimeSettings>("/api/settings", {
            method: method === "PUT" ? "PUT" : "GET",
            ...(method === "PUT" ? { body: JSON.stringify({ maxRuntimes: Number(input.value) }) } : {}),
          });
          if (!Number.isSafeInteger(current.maxRuntimes) || current.maxRuntimes < 1 ||
              !Number.isSafeInteger(current.effectiveMaxRuntimes) || current.effectiveMaxRuntimes < 1 ||
              typeof current.restartRequired !== "boolean")
            throw new Error("Invalid daemon settings response");
          if (method !== "POST" || !current.restartRequired) break;
        } catch (error) {
          if (method !== "POST" || hasAuth(error)) throw error;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 1000);
        await promise;
      } while (Date.now() < deadline);
      if (!current || (method === "POST" && current.restartRequired))
        throw new Error("Daemon restart not confirmed. Reopen Settings to check its status.");
      input.value = String(current.maxRuntimes);
      loaded = true;
      restart.hidden = !current.restartRequired;
      status.textContent = `Max sessions ${current.maxRuntimes}; in effect now ${current.effectiveMaxRuntimes}.` +
        (current.restartRequired
          ? " Restart required to apply. Restarting the shared daemon stops running work in desktop and mobile. Sessions reopen from saved transcripts, but their previous execution does not continue. Wait until work finishes before restarting."
          : method === "POST"
            ? " The shared daemon restarted: running work in desktop and mobile stopped. Sessions reopened from saved transcripts; execution did not continue. Wait until work finishes before restarting."
            : "");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      input.disabled = save.disabled = !loaded;
      restart.disabled = false;
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.reportValidity()) void update("PUT");
  });
  restart.addEventListener("click", () => {
    if (confirm("Restart the shared daemon? This stops running work in desktop and mobile. Sessions reopen from their saved transcripts; execution does not continue. Wait until work finishes before restarting."))
      void update("POST");
  });
  const show = (visible: boolean): void => {
    sessions.hidden = visible;
    settings.hidden = !visible;
    open.setAttribute("aria-expanded", String(visible));
    (visible ? back : open).focus();
    syncAnimation();
    if (visible) void update("GET");
  };
  open.addEventListener("click", () => show(true));
  back.addEventListener("click", () => show(false));
  settings.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    show(false);
  });
}

/** Horizontal drawer gestures leave native vertical scrolling alone. */
function bindSidebarSwipe(chat: HTMLElement, direction: 1 | -1, activate: () => void): void {
  let start: { id: number; x: number; y: number } | null = null;
  let suppressClick = false;
  chat.addEventListener("click", (event) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  chat.addEventListener("touchstart", (event) => {
    start = null;
    suppressClick = false;
    if (!window.matchMedia("(max-width: 720px)").matches ||
        event.touches.length !== 1 || modal ||
        document.body.classList.contains("sidebar-open") !== (direction === -1)) return;
    const target = event.target;
    if (target instanceof Element &&
        target.closest(direction === -1
          ? "input, textarea, select, [contenteditable]"
          : "a, button, input, textarea, select, pre, code, [contenteditable]")) return;
    // Reserve the whole gesture for nested horizontal scrollers, even at an edge.
    if (direction === 1 && target instanceof Element) {
      for (let element: Element | null = target; element && element !== chat; element = element.parentElement) {
        if (element.scrollWidth > element.clientWidth &&
            /^(auto|scroll)$/.test(window.getComputedStyle(element).overflowX)) return;
      }
    }
    const touch = event.touches[0];
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  chat.addEventListener("touchmove", (event) => {
    if (!start) return;
    const origin = start;
    const touch = Array.from(event.touches).find((touch) => touch.identifier === origin.id);
    if (event.touches.length !== 1 || !touch) {
      start = null;
      return;
    }
    const dx = touch.clientX - origin.x;
    const dy = Math.abs(touch.clientY - origin.y);
    if (dy > 30 && dy >= Math.abs(dx)) {
      start = null;
      return;
    }
    const distance = dx * direction;
    if (distance > 12 && distance >= dy * 2 &&
        !window.getSelection()?.toString()) {
      if (event.cancelable) event.preventDefault();
      if (Math.abs(dx) >= 60) {
        suppressClick = true;
        start = null;
        activate();
      }
    }
  }, { passive: false });
  chat.addEventListener("touchcancel", () => { start = null; }, { passive: true });
  chat.addEventListener("touchend", (event) => {
    const origin = start;
    start = null;
    if (!origin || window.getSelection()?.toString()) return;
    const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === origin.id);
    if (!touch) return;
    const dx = touch.clientX - origin.x;
    const dy = Math.abs(touch.clientY - origin.y);
    if (dx * direction >= 60 && dy <= 30 && dx * direction >= dy * 2) {
      suppressClick = true;
      activate();
    }
  }, { passive: true });
}

function closeSidebarDrawer(): void {
  document.querySelector<HTMLElement>("#sidebar")?.classList.remove("open");
  document
    .querySelector<HTMLButtonElement>("#menu-open")
    ?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("sidebar-open");
}
const MOVE_PROMPT_RE = /^\/move(?:\s+([^\n]*))?$/;

/** Text typed after `/move`, or null when the prompt is another command. */
function moveDraft(value: string): string | null {
  const match = value.match(MOVE_PROMPT_RE);
  return match ? (match[1] ?? "").trim() : null;
}

/**
 * Identity of the session/cwd the active `/move` completion belongs to.
 * Runtime and cwd both participate: switching slots or changing the session
 * working directory invalidates anything resolved against the old context.
 */
function activeMoveContext(): string {
  return moveContextKey(activeId, activeState?.cwd);
}

async function fetchMoveListing(path?: string): Promise<MoveListing> {
  try {
    return {
      listing: await api<DirectoryResponse>(
        path
          ? `/api/directories?path=${encodeURIComponent(path)}`
          : "/api/directories",
      ),
      error: null,
    };
  } catch (error: unknown) {
    if (hasAuth(error)) openTokenModal();
    return { listing: null, error: errorMessage(error) };
  }
}

/**
 * Drop the cached completion and cancel its pending fetch. Always bumps the
 * serial so a response already in flight can no longer land.
 */
function resetMoveCompletion(): void {
  window.clearTimeout(moveCompletionTimer);
  moveCompletionSerial += 1;
  moveCompletion = null;
}

/**
 * Drop a completion that no longer matches the active session/cwd, keeping a
 * visible move picker live by re-rendering it against the new context.
 */
function invalidateMoveCompletion(): void {
  const hadCompletion = moveCompletion !== null;
  resetMoveCompletion();
  if (hadCompletion) renderCommandMenu();
}

function queueMoveCompletion(draft: string): void {
  window.clearTimeout(moveCompletionTimer);
  const serial = ++moveCompletionSerial;
  const context = activeMoveContext();
  const base = moveBasePath(activeState?.cwd);
  moveCompletionTimer = window.setTimeout(() => {
    void buildMoveCompletion(draft, base, fetchMoveListing).then((result) => {
      if (serial !== moveCompletionSerial) return;
      // The session cwd can change while a listing is in flight (a slot
      // switch, resume, or `cd` reported by the next state refresh). Such a
      // response belongs to another context and must never be shown or sent.
      if (activeMoveContext() !== context) {
        if (moveCompletion?.context === context) invalidateMoveCompletion();
        return;
      }
      if (moveCompletion?.context !== context || moveCompletion.draft !== draft)
        return;
      moveCompletion = { context, draft, ...result, loading: false };
      renderCommandMenu();
    });
  }, 120);
}

function applyMoveSelection(path: string): void {
  const prompt = requiredElement<HTMLTextAreaElement>("#prompt");
  prompt.value = `/move ${path}`;
  drafts.set(activeId, prompt.value);
  dismissedCommandDraft = null;
  dismissedMoveDraft = null;
  commandSelection = 0;
  resizePrompt();
  renderCommandMenu();
  prompt.focus();
}

function hideCommandMenu(
  menu: HTMLElement,
  prompt: HTMLTextAreaElement,
): void {
  menu.replaceChildren();
  menu.classList.add("hidden");
  prompt.setAttribute("aria-expanded", "false");
  prompt.removeAttribute("aria-activedescendant");
}

function renderMoveMenu(
  menu: HTMLElement,
  prompt: HTMLTextAreaElement,
  draft: string,
): void {
  if (dismissedMoveDraft === prompt.value) {
    hideCommandMenu(menu, prompt);
    return;
  }
  const context = activeMoveContext();
  if (
    !moveCompletion ||
    moveCompletion.context !== context ||
    moveCompletion.draft !== draft
  ) {
    moveCompletion = {
      context,
      draft,
      resolvedPath: null,
      suggestions: [],
      loading: true,
      error: null,
    };
    queueMoveCompletion(draft);
  }
  const completion = moveCompletion;
  if (!completion) return;
  const options = completion.suggestions;
  if (options.length === 0) commandSelection = 0;
  else commandSelection = Math.min(commandSelection, options.length - 1);

  menu.setAttribute("aria-label", "Move destination directories");
  const status = completion.loading
    ? "Searching directories…"
    : completion.error
      ? completion.error
      : draft
        ? completion.resolvedPath
          ? "No subdirectories. Send to move here."
          : "No matching directories"
        : "No subdirectories";
  const rows = options
    .map(
      (suggestion, index) =>
        `<button type="button" id="command-option-${index}" class="command-option directory-option${index === commandSelection ? " selected" : ""}" role="option" aria-selected="${index === commandSelection}" data-move-path="${esc(suggestion.path)}" aria-label="Fill ${esc(suggestion.path)}"><strong>${esc(suggestion.name)}/</strong><span>${esc(suggestion.path)}</span></button>`,
    )
    .join("");
  menu.innerHTML =
    (options.length
      ? rows
      : `<div class="command-status${completion.error ? " error" : ""}" role="presentation">${esc(status)}</div>`) +
    `<div class="command-hint" role="presentation">Tap a folder to fill the path · Enter moves</div>`;
  menu.classList.remove("hidden");
  prompt.setAttribute("aria-expanded", "true");
  if (options.length) {
    prompt.setAttribute(
      "aria-activedescendant",
      `command-option-${commandSelection}`,
    );
    menu
      .querySelector<HTMLElement>(`#command-option-${commandSelection}`)
      ?.scrollIntoView({ block: "nearest" });
  } else {
    prompt.removeAttribute("aria-activedescendant");
  }
  menu
    .querySelectorAll<HTMLButtonElement>("[data-move-path]")
    .forEach((button) => {
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const path = button.dataset.movePath;
        if (path) applyMoveSelection(path);
      });
    });
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
  const moveValue = moveDraft(prompt.value);
  if (moveValue !== null) {
    renderMoveMenu(menu, prompt, moveValue);
    return;
  }
  menu.setAttribute("aria-label", "Slash commands");
  const matches = matchingCommands(prompt.value);
  if (matches.length === 0) {
    hideCommandMenu(menu, prompt);
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
  if (transcriptNearBottom) {
    requestAnimationFrame(() => {
      const transcript = document.querySelector<HTMLElement>("#transcript");
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
  }
  if (modal && keyboard > 0) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && modal.contains(focused)) {
      focused.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}
function selectSlot(id: SlotId): void {
  if (!slots.some((slot) => slot.id === id)) {
    showToast("That session is no longer live", true);
    void loadSlots();
    return;
  }
  closeEffortPopover();
  closeSidebarDrawer();
  dismissedCommandDraft = null;
  dismissedMoveDraft = null;
  resetMoveCompletion();
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
  localStorage.setItem("omp-mobile-active-slot", id);
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
type PreparedTranscriptMessage = {
  msgKey: string;
  role: string;
  liveMessage: boolean;
  parts: ChatPart[];
  actions: Array<{ label: string; url: string | undefined }>;
};
type TranscriptRenderSnapshot = {
  slotId: SlotId;
  generation: string | undefined;
  active: boolean;
  messages: PreparedTranscriptMessage[];
};

function sameAskDisplay(
  a: AskDisplay | undefined,
  b: AskDisplay | undefined,
): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    a.status !== b.status ||
    a.questions.length !== b.questions.length ||
    a.answers?.length !== b.answers?.length
  )
    return false;
  for (let i = 0; i < a.questions.length; i += 1) {
    const left = a.questions[i]!;
    const right = b.questions[i]!;
    if (
      left.id !== right.id ||
      left.question !== right.question ||
      left.header !== right.header ||
      left.multi !== right.multi ||
      left.recommended !== right.recommended ||
      left.options.length !== right.options.length
    )
      return false;
    for (let j = 0; j < left.options.length; j += 1) {
      const leftOption = left.options[j]!;
      const rightOption = right.options[j]!;
      if (
        leftOption.label !== rightOption.label ||
        leftOption.description !== rightOption.description
      )
        return false;
    }
  }
  if (a.answers && b.answers) {
    for (let i = 0; i < a.answers.length; i += 1) {
      const left = a.answers[i];
      const right = b.answers[i];
      if (left === null || right === null) {
        if (left !== right) return false;
        continue;
      }
      if (
        !left ||
        !right ||
        left.customInput !== right.customInput ||
        left.note !== right.note ||
        left.timedOut !== right.timedOut ||
        left.selectedOptions.length !== right.selectedOptions.length
      )
        return false;
      for (let j = 0; j < left.selectedOptions.length; j += 1) {
        if (left.selectedOptions[j] !== right.selectedOptions[j]) return false;
      }
    }
  }
  return true;
}

function appendAskCard(
  parent: HTMLElement,
  part: Extract<ChatPart, { kind: "tool" }>,
): void {
  const ask = part.ask;
  if (!ask) return;
  const card = document.createElement("section");
  card.className = `part part-tool part-ask${part.isError ? " part-error" : ""}`;
  const heading = document.createElement("div");
  heading.className = "part-ask-heading";
  heading.textContent = "Ask";
  card.append(heading);

  const status = document.createElement("p");
  status.className = "part-ask-status";
  if (part.isError) {
    status.textContent = "Ask failed in the desktop terminal.";
  } else if (ask.status === "pending") {
    status.textContent =
      "Awaiting an answer in the desktop terminal. Mobile cannot submit ask answers.";
  } else if (ask.status === "redirected") {
    status.textContent = "Conversation continued from the desktop terminal.";
  } else {
    status.textContent = "Answered in the desktop terminal.";
  }
  card.append(status);

  let hasAnswer = false;
  ask.questions.forEach((question, questionIndex) => {
    const block = document.createElement("div");
    block.className = "part-ask-question";
    if (question.header) {
      const header = document.createElement("span");
      header.className = "part-ask-header";
      header.textContent = question.header;
      block.append(header);
    }
    const prompt = document.createElement("div");
    prompt.className = "part-ask-prompt";
    prompt.textContent = question.question;
    block.append(prompt);
    const mode = document.createElement("div");
    mode.className = "part-ask-mode";
    mode.textContent = question.multi
      ? "Select all that apply"
      : "Select one";
    block.append(mode);

    const answer = ask.answers?.[questionIndex] ?? null;
    if (
      answer &&
      (answer.selectedOptions.length > 0 ||
        answer.customInput ||
        answer.note ||
        answer.timedOut)
    ) {
      hasAnswer = true;
    }
    if (question.options.length > 0) {
      const options = document.createElement("ul");
      options.className = "part-ask-options";
      question.options.forEach((option, optionIndex) => {
        const item = document.createElement("li");
        item.className = "part-ask-option";
        const label = document.createElement("span");
        label.className = "part-ask-option-label";
        label.textContent = option.label;
        item.append(label);
        if (answer?.selectedOptions.includes(option.label)) {
          const selected = document.createElement("span");
          selected.className = "part-ask-option-selected";
          selected.textContent = "Selected";
          item.append(selected);
        }
        if (question.recommended === optionIndex) {
          const recommended = document.createElement("span");
          recommended.className = "part-ask-option-recommended";
          recommended.textContent = "Recommended";
          item.append(recommended);
        }
        if (option.description) {
          const description = document.createElement("div");
          description.className = "part-ask-option-description";
          description.textContent = option.description;
          item.append(description);
        }
        options.append(item);
      });
      block.append(options);
    }
    if (answer?.customInput) {
      const custom = document.createElement("p");
      custom.className = "part-ask-answer";
      custom.textContent = `Custom answer: ${answer.customInput}`;
      block.append(custom);
    }
    if (answer?.note) {
      const note = document.createElement("p");
      note.className = "part-ask-answer";
      note.textContent = `Note: ${answer.note}`;
      block.append(note);
    }
    if (answer?.timedOut) {
      const timedOut = document.createElement("p");
      timedOut.className = "part-ask-answer";
      timedOut.textContent = "Answer selected automatically after timeout.";
      block.append(timedOut);
    }
    card.append(block);
  });

  if (part.output && (part.isError || !hasAnswer)) {
    const output = document.createElement("pre");
    output.className = "part-ask-output";
    output.textContent = part.output;
    card.append(output);
  }
  parent.append(card);
}

const AGENT_STATUS_LABEL: Record<string, string> = {
  pending: "queued",
  running: "running",
  completed: "done",
  failed: "failed",
  aborted: "aborted",
};

function formatActivityNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatActivityDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

type TaskRows = Extract<ChatPart, { kind: "tool" }>["task"];

function sameTaskRows(a: TaskRows, b: TaskRows): boolean {
  if (a === b) return true;
  if (!a || !b || a.asyncState !== b.asyncState) return false;
  if (a.agents.length !== b.agents.length) return false;
  return JSON.stringify(a.agents) === JSON.stringify(b.agents);
}

/**
 * Desktop-style agent rows shared by the activity drawer and `task` tool cards:
 * identity + status, the spawn description/task, then live activity and usage.
 */
function appendAgentRows(parent: HTMLElement, agents: ActivitySubagent[]): void {
  if (agents.length === 0) return;
  const list = document.createElement("div");
  list.className = "activity-agents";
  for (const agent of agents) {
    const row = document.createElement("div");
    row.className = `activity-agent is-${agent.status}`;
    const head = document.createElement("div");
    head.className = "activity-agent-head";
    const name = document.createElement("span");
    name.className = "activity-agent-name";
    name.textContent = agent.label || agent.id;
    head.append(name);
    if (agent.agent) {
      const type = document.createElement("span");
      type.className = "activity-agent-type";
      type.textContent = agent.agent;
      head.append(type);
    }
    if (agent.detached) {
      const detached = document.createElement("span");
      detached.className = "activity-agent-type";
      detached.textContent = "background";
      head.append(detached);
    }
    const state = document.createElement("span");
    state.className = "activity-agent-state";
    state.textContent = AGENT_STATUS_LABEL[agent.status] ?? agent.status;
    head.append(state);
    row.append(head);

    const detail = agent.description || agent.task;
    if (detail) {
      const body = document.createElement("div");
      body.className = "activity-agent-task";
      body.textContent = detail;
      row.append(body);
    }

    const meta = document.createElement("div");
    meta.className = "activity-agent-meta";
    const push = (text: string | undefined): void => {
      if (!text) return;
      const part = document.createElement("span");
      part.textContent = text;
      meta.append(part);
    };
    if (agent.currentTool) {
      push(
        agent.activity && agent.activity !== agent.currentTool
          ? `${agent.currentTool}: ${agent.activity}`
          : agent.currentTool,
      );
    } else {
      push(agent.activity);
    }
    if (agent.toolCount) push(`${formatActivityNumber(agent.toolCount)} tools`);
    if (agent.requests && agent.requests !== agent.toolCount)
      push(`${formatActivityNumber(agent.requests)} req`);
    if (agent.tokens) push(`${formatActivityNumber(agent.tokens)} tok`);
    if (agent.contextTokens && agent.contextWindow)
      push(
        `${Math.round((agent.contextTokens / agent.contextWindow) * 100)}% ctx`,
      );
    if (agent.cost && agent.cost > 0) push(`$${agent.cost.toFixed(2)}`);
    if (agent.durationMs !== undefined)
      push(formatActivityDuration(agent.durationMs));
    if (agent.model) push(agent.model);
    if (meta.childElementCount > 0) row.append(meta);

    if (agent.note) {
      const note = document.createElement("div");
      note.className = "activity-agent-note";
      note.textContent = agent.note;
      row.append(note);
    }
    if (agent.error) {
      const error = document.createElement("div");
      error.className = "activity-agent-error";
      error.textContent = agent.error;
      row.append(error);
    }
    list.append(row);
  }
  parent.append(list);
}

function appendJobRows(parent: HTMLElement, jobs: ActivityJob[], now: number): void {
  if (jobs.length === 0) return;
  const list = document.createElement("div");
  list.className = "activity-jobs";
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = `activity-job is-${job.status}`;
    const head = document.createElement("div");
    head.className = "activity-job-head";
    const label = document.createElement("span");
    label.className = "activity-job-name";
    label.textContent = job.label;
    head.append(label);
    const type = document.createElement("span");
    type.className = "activity-agent-type";
    type.textContent = job.type;
    head.append(type);
    const state = document.createElement("span");
    state.className = "activity-agent-state";
    state.textContent = job.status;
    head.append(state);
    row.append(head);
    const durationMs =
      job.durationMs ?? (job.status === "running" ? now - job.startedAt : undefined);
    if (durationMs !== undefined && durationMs >= 0) {
      const meta = document.createElement("div");
      meta.className = "activity-agent-meta";
      meta.textContent = formatActivityDuration(durationMs);
      row.append(meta);
    }
    list.append(row);
  }
  parent.append(list);
}

function sameTranscriptPart(a: ChatPart, b: ChatPart): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (
    (a.kind === "text" || a.kind === "thinking") &&
    (b.kind === "text" || b.kind === "thinking")
  )
    return a.text === b.text;
  if (a.kind === "tool" && b.kind === "tool")
    return (
      a.id === b.id &&
      a.name === b.name &&
      a.summary === b.summary &&
      a.output === b.output &&
      a.isError === b.isError &&
      sameTaskRows(a.task, b.task) &&
      sameAskDisplay(a.ask, b.ask)
    );
  return false;
}

function sameTranscriptSnapshot(
  a: TranscriptRenderSnapshot,
  b: TranscriptRenderSnapshot,
): boolean {
  if (
    a.slotId !== b.slotId ||
    a.generation !== b.generation ||
    a.active !== b.active ||
    a.messages.length !== b.messages.length
  )
    return false;
  for (let i = 0; i < a.messages.length; i += 1) {
    const left = a.messages[i]!;
    const right = b.messages[i]!;
    if (
      left.msgKey !== right.msgKey ||
      left.role !== right.role ||
      left.liveMessage !== right.liveMessage ||
      left.parts.length !== right.parts.length ||
      left.actions.length !== right.actions.length
    )
      return false;
    for (let partIndex = 0; partIndex < left.parts.length; partIndex += 1)
      if (
        !sameTranscriptPart(
          left.parts[partIndex]!,
          right.parts[partIndex]!,
        )
      )
        return false;
    for (let actionIndex = 0; actionIndex < left.actions.length; actionIndex += 1) {
      const leftAction = left.actions[actionIndex]!;
      const rightAction = right.actions[actionIndex]!;
      if (
        leftAction.label !== rightAction.label ||
        leftAction.url !== rightAction.url
      )
        return false;
    }
  }
  return true;
}

function renderMessages(messages: ClientMessage[], active = false): void {
  const transcript = document.querySelector<HTMLDivElement>("#transcript");
  if (!transcript) return;
  lastEmptyTranscriptContent = null;
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
  const prepared: PreparedTranscriptMessage[] = [];
  // Compare rendered inputs; renderActive updates theme and status chrome separately.
  messages.forEach((message, messageIndex) => {
    const parts = Array.isArray(message.parts)
      ? message.parts
      : projectParts(message, toolCalls);
    const actions = (message.actions ?? []).map((action) => ({
      label: action.label || action.title || "Open",
      url: typeof action.url === "string" ? action.url : undefined,
    }));
    if (parts.length === 0 && actions.length === 0) return;
    prepared.push({
      msgKey:
        asString(message.entryId) ??
        asString(message.id) ??
        `msg-${messageIndex}`,
      role: message.role || messageKind(message),
      liveMessage: active && messageIndex === messages.length - 1,
      parts,
      actions,
    });
  });
  const snapshot: TranscriptRenderSnapshot = {
    slotId: activeId,
    generation: activeState?.generation,
    active,
    messages: prepared,
  };
  if (
    lastTranscriptSnapshot &&
    sameTranscriptSnapshot(lastTranscriptSnapshot, snapshot)
  ) {
    lastRenderedMessageCount = messages.length;
    return;
  }

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
    lastTranscriptSnapshot = snapshot;
    return;
  }

  prepared.forEach(({ msgKey, role, liveMessage, parts, actions }) => {
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
        if (part.ask) {
          appendAskCard(article, part);
          return;
        }
        const details = document.createElement("details");
        details.className = `part part-tool${part.isError ? " part-error" : ""}`;
        const taskAgents = part.task?.agents ?? [];
        if (taskAgents.length > 0) details.classList.add("part-task");
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
        if (taskAgents.length > 0) {
          const running = taskAgents.filter(
            (agent) => agent.status === "running" || agent.status === "pending",
          ).length;
          line += ` · ${taskAgents.length} subagent${taskAgents.length === 1 ? "" : "s"}`;
          if (running > 0) line += ` (${running} running)`;
        }
        if (line.length > 90) {
          line = line.slice(0, 87) + "…";
        }
        const live =
          (liveMessage && part.output === undefined) ||
          taskAgents.some(
            (agent) => agent.status === "running" || agent.status === "pending",
          );
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

        if (taskAgents.length > 0) {
          const taskBody = document.createElement("div");
          taskBody.className = "part-task-body";
          appendAgentRows(taskBody, taskAgents);
          details.append(taskBody);
        }

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

    if (actions.length > 0) {
      const actionList = document.createElement("div");
      actionList.className = "message-actions";
      actions.forEach((action) => {
        const button = document.createElement("button");
        button.className = "ghost-btn";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          if (
            typeof action.url === "string" &&
            /^https?:\/\//i.test(action.url)
          )
            window.open(action.url, "_blank", "noopener");
          else showToast("This action is not available on mobile", true);
        });
        actionList.append(button);
      });
      article.append(actionList);
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
  lastTranscriptSnapshot = snapshot;
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
  const view = document.querySelector<HTMLElement>("#raw-view");
  if (!view) return;
  if (!activeId) {
    rawRequest += 1;
    view.textContent = slotsError
      ? `Live sessions unavailable: ${slotsError}`
      : "No live session selected.";
    return;
  }
  const targetId = activeId;
  const request = ++rawRequest;
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

const TODO_MARKER: Record<string, string> = {
  pending: "☐",
  in_progress: "☐",
  completed: "☑",
  abandoned: "–",
  blocked: "!",
};
const TODO_STATE_LABEL: Record<string, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "completed",
  abandoned: "abandoned",
  blocked: "blocked",
};

/** One composer-attached drawer owns todos, subagents and background jobs. */
function renderActivity(state: ClientState | null): void {
  const dock = document.querySelector<HTMLElement>("#activity-dock");
  const todosEl = document.querySelector<HTMLElement>("#activity-todos");
  const todoToggle = document.querySelector<HTMLButtonElement>("#todo-toggle");
  const todoLabel = document.querySelector<HTMLElement>("#todo-toggle-label");
  const content = document.querySelector<HTMLElement>("#activity-content");
  const details = document.querySelector<HTMLElement>("#activity-details");
  if (!dock || !todosEl || !todoToggle || !todoLabel || !content || !details) return;

  if (activitySlot !== activeId) {
    activitySlot = activeId;
    todosExpanded = false;
    todosEl.innerHTML = "";
  }
  const activity: SessionActivity | undefined = state?.activity;
  const todoPhases = (activity?.todos ?? []).filter(
    (phase) => phase.tasks.length > 0,
  );
  const agents = activity?.subagents ?? [];
  const jobs = activity?.jobs ?? [];
  const runningAgents = agents.filter(
    (agent) => agent.status === "running",
  ).length;
  const runningJobs = jobs.filter((job) => job.status === "running").length;
  const hasTodos = todoPhases.length > 0;
  const hasDetails = agents.length > 0 || jobs.length > 0;
  const visible = hasTodos || hasDetails;
  dock.classList.toggle("hidden", !visible);
  content.classList.toggle("hidden", !visible || !todosExpanded);
  dock.classList.toggle("todos-closed", !todosExpanded);
  if (!visible) {
    details.classList.add("hidden");
    return;
  }

  todoToggle.hidden = !visible;
  todoToggle.setAttribute("aria-expanded", String(todosExpanded));
  todoToggle.setAttribute("aria-label", todosExpanded ? "Close activity drawer" : "Open activity drawer");
  todoLabel.textContent = "Activity";
  if (hasTodos) {
    const tasks = todoPhases.flatMap((phase) => phase.tasks);
    let lastFinished: (typeof tasks)[number] | undefined;
    for (const todo of tasks) {
      if (todo.status === "completed" || todo.status === "abandoned") lastFinished = todo;
    }
    const finished = tasks.filter(
      (todo) => todo.status === "completed" || todo.status === "abandoned",
    ).length;
    todoLabel.textContent = `Todos · ${finished}/${tasks.length}`;
    const phaseExpansion = new Map(
      Array.from(todosEl.querySelectorAll<HTMLDetailsElement>("details[data-phase]"),
        (element) => [element.dataset.phase, element.open] as const),
    );
    todosEl.innerHTML = todoPhases.map((phase, index) => {
      const visibleTasks = phase.tasks.filter((todo) =>
        todo === lastFinished || (todo.status !== "completed" && todo.status !== "abandoned"));
      if (!visibleTasks.length) return "";
      const started = phase.tasks.some((todo) => todo.status !== "pending");
      const open = phaseExpansion.get(String(index)) ?? started;
      const count = phase.tasks.filter((todo) =>
        todo.status === "completed" || todo.status === "abandoned").length;
      const rows = visibleTasks.map((todo) => {
        const status = TODO_STATE_LABEL[todo.status] ?? todo.status;
        return `<div class="activity-todo is-${esc(todo.status)}" aria-label="${esc(`${status}: ${todo.content}`)}"><span class="activity-todo-marker" aria-hidden="true">${esc(TODO_MARKER[todo.status] ?? "☐")}</span><span class="activity-todo-text">${esc(todo.content)}</span>${todo.blocker ? `<span class="activity-todo-blocker">${esc(todo.blocker)}</span>` : ""}</div>`;
      }).join("");
      const numbered = /^[IVXLCDM]+\.\s/i.test(phase.name);
      return `<details data-phase="${index}"${open ? " open" : ""}><summary class="activity-todo-phase${numbered ? "" : " is-numbered"}" style="counter-set: todo-phase ${index + 1}">${esc(phase.name)} · ${count}/${phase.tasks.length}</summary>${rows}</details>`;
    }).join("");
    todosEl.classList.toggle("hidden", !todosExpanded);
  } else {
    todosEl.innerHTML = "";
    todosEl.classList.add("hidden");
  }

  if (!hasDetails || !todosExpanded) {
    details.classList.add("hidden");
    details.innerHTML = "";
    return;
  }

  const subagentsOpen = details.querySelector<HTMLDetailsElement>("#drawer-subagents")?.open ?? false;
  details.innerHTML = "";
  if (agents.length > 0) {
    const section = document.createElement("details");
    section.id = "drawer-subagents";
    section.open = subagentsOpen;
    section.className = "activity-section";
    const heading = document.createElement("summary");
    heading.className = "activity-section-head";
    heading.innerHTML = `Subagents${runningAgents > 0 ? `<span>${runningAgents} running</span>` : ""}`;
    section.append(heading);
    appendAgentRows(section, agents);
    details.append(section);
  }
  if (jobs.length > 0) {
    const section = document.createElement("div");
    section.className = "activity-section";
    const heading = document.createElement("div");
    heading.className = "activity-section-head";
    heading.innerHTML = `Background jobs<span>${runningJobs} running</span>`;
    section.append(heading);
    appendJobRows(section, jobs, Date.now());
    details.append(section);
  }
  details.classList.remove("hidden");
}

/** Use the host's descriptive tool intent; the generic label is a fallback. */
function renderComposerWorking(active: boolean, state: ClientState | null): void {
  const box = document.querySelector<HTMLElement>("#composer-working");
  const holder = document.querySelector<HTMLElement>("#composer-working-text");
  if (!box || !holder) return;
  box.classList.toggle("hidden", !active);
  if (!active) return;
  const text = state?.activity?.working?.trim() || "Working…";
  box.title = text;
  if (text !== lastComposerWorkingText) {
    holder.innerHTML = shimmerMarkup(text);
    lastComposerWorkingText = text;
    syncAnimation();
  }
}

function renderActive(): void {
  const slot = slotById(activeId);
  const state = activeState;
  const active = isAgentActive(state, slot);
  syncTopBar();
  const prompt = requiredElement<HTMLTextAreaElement>("#prompt");
  prompt.placeholder = activeId
    ? "Message this session…"
    : "Start or select a session…";
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
    applyTheme(null);
    const emptyText = activeId
      ? stateError
        ? `Live state unavailable: ${stateError}`
        : "Waiting for live state…"
      : slotsError
        ? `Live sessions unavailable: ${slotsError}`
        : slots.length
          ? "Select a session from the sidebar."
          : "No live session. Start a new one or resume a saved session.";
    lastTranscriptSnapshot = null;
    lastRenderedMessageCount = 0;
    if (lastEmptyTranscriptContent !== emptyText) {
      transcript.innerHTML = `<div class="transcript-empty">${esc(emptyText)}</div>`;
      lastEmptyTranscriptContent = emptyText;
    }
  }
  if (!document.querySelector("#pending-messages")) {
    const container = document.createElement("div");
    container.id = "pending-messages";
    container.className = "pending-messages hidden";
    container.setAttribute("aria-live", "polite");
    document.querySelector(".app-shell")?.append(container);
  }
  const pendingContainer =
    requiredElement<HTMLDivElement>("#pending-messages");
  const pendingMessages = state?.pendingMessages ?? [];
  const hasPendingMessages = state?.hasPendingMessages === true;
  if (hasPendingMessages || pendingMessages.length > 0) {
    const queueState = hasPendingMessages ? "Pending messages" : "Submitting";
    const messageItems = pendingMessages.length
      ? `<ol>${pendingMessages
          .map(
            (message) =>
              `<li>${esc(message.text.replace(/\r?\n/g, " ↵ "))}</li>`,
          )
          .join("")}</ol>`
      : "";
    pendingContainer.innerHTML = `<div class="pending-card"><div class="pending-heading">${queueState}</div>${messageItems}</div>`;
    pendingContainer.classList.remove("hidden");
  } else {
    pendingContainer.innerHTML = "";
    pendingContainer.classList.add("hidden");
  }
  const sendButton = requiredElement<HTMLButtonElement>("#send");
  const forceReady =
    hasPendingMessages && active && !prompt.value.trim();
  sendButton.textContent = forceReady ? "Force" : "Send";
  sendButton.setAttribute(
    "aria-label",
    forceReady ? "Force queued messages now" : "Send message",
  );
  renderComposerWorking(active, state);
  renderActivity(state);
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

  const modelColor = sessionAccent;
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
    const values = (state.efforts || []).filter((value) => value !== "inherit");
    const range = popover.querySelector<HTMLInputElement>("#effort-range");
    const currentLabel = popover.querySelector<HTMLElement>("#effort-current");
    if (range && currentLabel && values.length && !effortSliderDragging) {
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

/**
 * Keep the selected runtime honest: drop cached state for runtimes that no
 * longer exist, and fall back to the first live one (or the empty state) when
 * the selection disappears. Never leave a stale id driving actions.
 */
function reconcileActiveSlot(): void {
  for (const id of [...cache.keys()]) {
    if (id !== activeId && !slots.some((slot) => slot.id === id))
      cache.delete(id);
  }
  for (const id of [...drafts.keys()]) {
    if (id !== activeId && !slots.some((slot) => slot.id === id))
      drafts.delete(id);
  }
  for (const id of [...unreadBySlot.keys()]) {
    if (!slots.some((slot) => slot.id === id)) unreadBySlot.delete(id);
  }
  if (activeId && slots.some((slot) => slot.id === activeId)) {
    if (!initialStateRequested) {
      initialStateRequested = true;
      void loadState();
    }
    return;
  }
  const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  if (prompt && activeId) drafts.set(activeId, prompt.value);
  // Falling back to another runtime (or none) changes the session identity:
  // any `/move` listing belongs to the runtime that just disappeared.
  dismissedMoveDraft = null;
  resetMoveCompletion();
  activeId = slots[0]?.id ?? "";
  activeState = activeId ? cache.get(activeId) ?? null : null;
  stateError = null;
  if (prompt) {
    prompt.value = activeId ? draftFor(activeId) : "";
    resizePrompt();
  }
  transcriptNearBottom = true;
  lastRenderedMessageCount = 0;
  if (activeId) localStorage.setItem("omp-mobile-active-slot", activeId);
  else localStorage.removeItem("omp-mobile-active-slot");
  updateSlots();
  renderActive();
  if (activeId) {
    initialStateRequested = true;
    void loadState();
  }
  void loadRawTerminal();
}

async function loadSlots(): Promise<void> {
  const request = ++slotsRequest;
  try {
    const result = await api<SlotsResponse>("/api/slots");
    if (request !== slotsRequest) return;
    slotsError = null;
    slots = (Array.isArray(result?.slots) ? result.slots : [])
      .filter((slot) => slot && isSlotId(slot.id))
      .map((slot) => {
        const adopted = resumeAdoptedFiles.get(slot.id);
        if (!adopted) return slot;
        if (slot.sessionFile) {
          resumeAdoptedFiles.delete(slot.id);
          return slot;
        }
        return { ...slot, sessionFile: adopted };
      });
    for (const id of [...resumeAdoptedFiles.keys()])
      if (!slots.some((slot) => slot.id === id)) resumeAdoptedFiles.delete(id);
    reconcileActiveSlot();
    updateSlots();
  } catch (error: unknown) {
    if (request !== slotsRequest) return;
    slotsError = hasAuth(error)
      ? "access token required"
      : errorMessage(error);
    // A cold load with no cached runtimes must not keep driving a stale id:
    // with nothing on screen the composer goes inert and the top bar says why.
    if (!slots.length) reconcileActiveSlot();
    updateSlots();
    if (hasAuth(error)) openTokenModal();
  }
}
async function loadState(): Promise<void> {
  if (!activeId) {
    activeState = null;
    stateError = null;
    renderActive();
    return;
  }
  const targetId = activeId;
  const request = ++stateRequest;
  try {
    const result = await api<ClientState>(
      `/api/slots/${encodeURIComponent(targetId)}/state`,
    );
    if (request !== stateRequest || targetId !== activeId) return;
    const previousContext = activeMoveContext();
    activeState = result;
    stateError = null;
    cache.set(targetId, result);
    // A session can change working directory (resume, `/move`, or a `cd` in
    // the desktop terminal); completions resolved against the old cwd must
    // not survive into the new one.
    if (activeMoveContext() !== previousContext) invalidateMoveCompletion();
    updateSlots();
    renderActive();
    window.setTimeout(() => {
      if (targetId === activeId) void acknowledgeSlot(targetId);
    }, 0);
  } catch (error: unknown) {
    if (request !== stateRequest || targetId !== activeId) return;
    const previousContext = activeMoveContext();
    activeState = null;
    stateError = hasAuth(error) ? "access token rejected" : errorMessage(error);
    if (activeMoveContext() !== previousContext) invalidateMoveCompletion();
    updateSlots();
    renderActive();
    if (hasAuth(error)) openTokenModal();
    else if (errorStatus(error) === 404) void loadSlots();
  }
}

/**
 * Lists the daemon's transcripts under the same contract as the desktop
 * sidebar: the 60 most recent by activity, and a daemon-side search so older
 * transcripts stay reachable beyond that window. The query is whatever the
 * sidebar search box currently holds, so the periodic refresh and a keystroke
 * never fight over the list.
 */
async function loadSessions(): Promise<void> {
  const request = ++sessionsRequest;
  const query = sessionsQuery.trim();
  sessionsLoading = true;
  updateSlots();
  try {
    const params = new URLSearchParams({ limit: "60" });
    if (query) params.set("search", query);
    const result = await api<SessionsResponse>(
      `/api/sessions?${params.toString()}`,
    );
    if (request !== sessionsRequest) return;
    sessions = (Array.isArray(result?.sessions) ? result.sessions : []).filter(
      (session) =>
        session &&
        typeof session.id === "string" &&
        typeof session.path === "string" &&
        typeof session.cwd === "string" &&
        typeof session.title === "string" &&
        typeof session.updatedAt === "string" &&
        typeof session.costUsd === "number",
    );
    sessionsError = null;
    sessionsQueryLoaded = query.toLowerCase();
  } catch (error: unknown) {
    if (request !== sessionsRequest) return;
    sessions = [];
    sessionsError = hasAuth(error)
      ? "access token rejected"
      : errorMessage(error);
    if (hasAuth(error)) openTokenModal();
  } finally {
    if (request === sessionsRequest) {
      sessionsLoading = false;
      updateSlots();
    }
  }
}

/**
 * Opens a transcript from the history list. A runtime may already own it — the
 * desktop started one, or the last slots poll has not caught up yet — so the
 * transcript is matched against live runtimes first and only resumed through a
 * new runtime when none does, the desktop sidebar's reuse-then-resume contract.
 */
async function openHistorySession(path: string): Promise<void> {
  const live = slots.find((slot) => slot.sessionFile === path);
  if (live) {
    selectSlot(live.id);
    return;
  }
  await loadSlots();
  const fresh = slots.find((slot) => slot.sessionFile === path);
  if (fresh) {
    selectSlot(fresh.id);
    return;
  }
  await createSlot({ resume: path }, "Session resumed");
}
function updateSessionActions(): void {
  const button = document.querySelector<HTMLButtonElement>("#new-session");
  if (!button) return;
  button.disabled = creatingSession;
  button.setAttribute("aria-busy", creatingSession ? "true" : "false");
}
async function createSlot(
  request: CreateSlotRequest,
  successMessage: string,
): Promise<void> {
  if (creatingSession) return;
  creatingSession = true;
  updateSessionActions();
  try {
    const result = await api<SlotResponse>("/api/slots", {
      method: "POST",
      body: JSON.stringify(request),
    });
    const slot = result?.slot;
    if (!slot || !isSlotId(slot.id))
      throw new Error("Desktop did not return a runtime id");
    if (request.resume && !slot.sessionFile) {
      // The daemon may not have sniffed the resumed transcript yet; keep the
      // requested file as the runtime's identity so its history row dedupes and
      // a second tap adopts this runtime instead of spawning a sibling.
      slot.sessionFile = request.resume;
      resumeAdoptedFiles.set(slot.id, request.resume);
    }
    slots = slots.some((existing) => existing.id === slot.id)
      ? slots.map((existing) => (existing.id === slot.id ? slot : existing))
      : [...slots, slot];
    selectSlot(slot.id);
    showToast(successMessage);
    void loadSlots();
    void loadSessions();
  } catch (error: unknown) {
    showToast(
      hasAuth(error) ? "Access token rejected" : errorMessage(error),
      true,
    );
    if (hasAuth(error)) openTokenModal();
  } finally {
    creatingSession = false;
    updateSessionActions();
  }
}
function startNewSession(): void {
  void createSlot({}, "Session started");
}
/**
 * Remove a stopped runtime locally and immediately, so no stale id can drive
 * another action while the next /api/slots poll catches up.
 */
function forgetSlot(id: SlotId): void {
  slots = slots.filter((slot) => slot.id !== id);
  cache.delete(id);
  drafts.delete(id);
  unreadBySlot.delete(id);
  resumeAdoptedFiles.delete(id);
  if (activeId === id) {
    activeId = "";
    activeState = null;
    stateError = null;
  }
}
async function stopSlot(id: SlotId): Promise<void> {
  const slot = slotById(id);
  confirmModal(
    "Stop session",
    `Kill the live runtime “${slotTitle(slot)}”? The transcript stays on disk and can be resumed later.`,
    "Stop session",
    () => {
      void api<{ ok: boolean }>(`/api/slots/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
        .then(() => {
          showToast(`Stopped ${slotTitle(slot)}`);
          forgetSlot(id);
          reconcileActiveSlot();
          updateSlots();
          void loadSessions();
        })
        .catch((error: unknown) => {
          showToast(
            hasAuth(error) ? "Access token rejected" : errorMessage(error),
            true,
          );
          if (hasAuth(error)) openTokenModal();
          void loadSlots();
        });
    },
  );
}
function relativeTime(value: string): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
async function sendAction(
  action: ApiAction,
  targetId: SlotId = activeId,
  targetState: ClientState | null = activeState,
): Promise<boolean> {
  if (!slots.some((slot) => slot.id === targetId)) {
    showToast("That session is no longer live; action not sent", true);
    void loadSlots();
    return false;
  }
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
    dismissedMoveDraft = null;
    renderCommandMenu();
  }
}
async function forcePendingMessages(
  targetId: SlotId,
  targetState: ClientState | null,
): Promise<void> {
  const generation = targetState?.generation;
  if (!generation) return;
  const key = JSON.stringify([targetId, generation]);
  if (forceRequestsInFlight.has(key)) return;
  forceRequestsInFlight.add(key);
  try {
    const forced = await sendAction({ type: "force" }, targetId, targetState);
    if (
      forced &&
      recentForceableSubmission?.targetId === targetId &&
      recentForceableSubmission.generation === generation
    )
      recentForceableSubmission = null;
  } finally {
    forceRequestsInFlight.delete(key);
  }
}
function sendPrompt(): void {
  const prompt = requiredElement<HTMLTextAreaElement>("#prompt");
  const text = prompt.value.trim();
  const targetId = activeId;
  const targetState = activeState;
  const draftAtSend = prompt.value;
  if (!text) {
    const recent = recentForceableSubmission;
    const pendingIsBusy =
      targetState?.hasPendingMessages === true &&
      isAgentActive(targetState, slotById(targetId));
    const recentMatches =
      recent !== null &&
      recent.targetId === targetId &&
      recent.generation === targetState?.generation &&
      recent.expiresAt > Date.now();
    if (pendingIsBusy || recentMatches)
      void forcePendingMessages(targetId, targetState);
    return;
  }

  const moveMatch = text.match(/^\/move(?:\s+(.*))?$/);
  if (moveMatch) {
    const rawPath = (moveMatch[1] || "").trim();
    // `selectedMovePath` only trusts a completion from the current
    // session/cwd; a stale one leaves the typed text, which then resolves
    // against the live cwd rather than another directory.
    const chosenPath = resolveMoveCandidate(
      selectedMovePath(
        moveCompletion,
        activeMoveContext(),
        rawPath,
        commandSelection,
      ),
      moveBasePath(activeState?.cwd),
    );
    if (!chosenPath) {
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
      { type: "move", path: chosenPath, confirmed: true },
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
  const generation = targetState?.generation ?? "";
  const submissionKey = JSON.stringify([targetId, generation, text]);
  const inFlight = inFlightPromptSubmissions.get(submissionKey);
  if (inFlight) {
    if (inFlight.forceable) inFlight.forceRequested = true;
    return;
  }
  const submission: PromptSubmission = {
    generation,
    forceable:
      isAgentActive(targetState, slotById(targetId)) ||
      targetState?.hasPendingMessages === true,
    forceRequested: false,
  };
  inFlightPromptSubmissions.set(submissionKey, submission);
  void sendAction({ type: "prompt", text }, targetId, targetState)
    .then(async (sent) => {
      if (!sent) return;
      handleSendSuccess(targetId, draftAtSend);
      if (submission.forceable) {
        recentForceableSubmission = {
          targetId,
          generation,
          expiresAt: Date.now() + 3000,
        };
      }
      if (submission.forceRequested)
        await forcePendingMessages(targetId, targetState);
    })
    .finally(() => inFlightPromptSubmissions.delete(submissionKey));
}
function closeModal(): void {
  const dismiss = modalDismiss;
  modalDismiss = null;
  modal?.remove();
  modal = null;
  dismiss?.();
}
function confirmModal(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void,
): void {
  const body = document.createElement("div");
  body.innerHTML = `<p class="notice">${esc(message)}</p><div class="modal-actions"><button type="button" class="ghost-btn modal-cancel">Cancel</button><button type="button" class="danger-btn modal-confirm">${esc(confirmLabel)}</button></div>`;
  makeModal(title, body);
  let settled = false;
  modalDismiss = () => {
    settled = true;
  };
  requiredElement<HTMLButtonElement>(".modal-cancel", body).addEventListener(
    "click",
    closeModal,
  );
  requiredElement<HTMLButtonElement>(".modal-confirm", body).addEventListener(
    "click",
    () => {
      if (settled) return;
      settled = true;
      closeModal();
      onConfirm();
    },
  );
}
function makeModal(title: string, body: HTMLElement): HTMLDivElement {
  closeModal();
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
// Set while the popover slider is under an active pointer; the state re-sync
// in renderActive must not clobber the value the finger is picking.
let effortSliderDragging = false;

/** True while the composer owns focus; effort controls must not steal it. */
function composerFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement && active.id === "prompt";
}

function closeEffortPopover(): void {
  effortSliderDragging = false;
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
  const values = (targetState?.efforts || []).filter((value) => value !== "inherit");
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

  const applyRange = (): void => {
    updateRange();
    const val = values[Number(range.value)];
    if (val !== undefined) {
      currentLabel.textContent = val;
    }
  };

  const commitRange = (): void => {
    if (!actionTargetCurrent(targetId, targetGeneration)) return;
    const val = values[Number(range.value)];
    if (val !== undefined) {
      void sendAction({ type: "effort", value: val }, targetId, targetState);
    }
  };

  range.addEventListener("input", applyRange);
  range.addEventListener("change", commitRange);

  /**
   * Point → value mapping that mirrors the native thumb inset, so a driven
   * slider lands on the same stop a native drag would have reached.
   */
  const sliderIndexFor = (clientX: number): number => {
    const rect = range.getBoundingClientRect();
    const thumb = 24; // .effort-range thumb width; half is the inset per side
    const usable = Math.max(1, rect.width - thumb);
    const fraction = Math.min(
      1,
      Math.max(0, (clientX - rect.left - thumb / 2) / usable),
    );
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 0;
    return Math.round(min + fraction * (max - min));
  };

  let activePointer: number | null = null;
  let dragIndex = Number(range.value) || 0;
  const endSliderDrag = (event: PointerEvent): void => {
    if (activePointer !== event.pointerId) return;
    activePointer = null;
    effortSliderDragging = false;
    if (range.hasPointerCapture(event.pointerId)) {
      range.releasePointerCapture(event.pointerId);
    }
    // Commit the stop the pointer picked, not a poll's re-synced value.
    range.value = String(dragIndex);
    commitRange();
  };

  /**
   * Canceled native slider drags also cancel the focus transfer, so while the
   * composer is focused the slider is driven from pointer events instead: the
   * textarea (and the software keyboard) never blurs.
   */
  range.addEventListener("pointerdown", (event) => {
    if (!composerFocused()) return;
    event.preventDefault();
    activePointer = event.pointerId;
    effortSliderDragging = true;
    try {
      range.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; moves still arrive while over the input.
    }
    dragIndex = sliderIndexFor(event.clientX);
    range.value = String(dragIndex);
    applyRange();
  });

  range.addEventListener("pointermove", (event) => {
    if (activePointer !== event.pointerId) return;
    dragIndex = sliderIndexFor(event.clientX);
    range.value = String(dragIndex);
    applyRange();
  });

  range.addEventListener("pointerup", endSliderDrag);
  range.addEventListener("pointercancel", endSliderDrag);

  // Taps on the popover chrome (label, padding) must keep composer focus too.
  popover.addEventListener("pointerdown", (event) => {
    if (composerFocused()) event.preventDefault();
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
  dismissedCommandDraft = null;
  dismissedMoveDraft = null;
  commandSelection = 0;
  resizePrompt();
  renderCommandMenu();
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
async function openDirectoryModal(): Promise<void> {
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

  let currentBrowsingPath = "";
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

    return `<li class="tree-node" data-node-path="${esc(node.path)}"><div class="tree-row">${toggleHtml}<span class="tree-icon">${ICONS.folder}</span><button type="button" class="tree-name" data-toggle="${esc(node.path)}" title="Open ${esc(node.path)}">${esc(node.name)}</button><div class="tree-actions"><button type="button" class="tree-pin-btn${isPinned ? " pinned" : ""}" data-tree-pin="${esc(node.path)}" title="${isPinned ? "Unpin" : "Pin"} folder">${isPinned ? "★" : "☆"}</button><button type="button" class="tree-start-btn" data-start="${esc(node.path)}" title="Start a session in ${esc(node.path)}">Start</button><button type="button" class="tree-select-btn" data-select="${esc(node.path)}" aria-label="Select ${esc(node.path)}">Select</button></div></div>${childrenHtml}</li>`;
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
      .querySelectorAll<HTMLButtonElement>("[data-start]")
      .forEach((btn) => {
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          const startPath = btn.dataset.start;
          if (!startPath) return;
          closeModal();
          void createSlot(
            { cwd: startPath },
            `Session started in ${compactPath(startPath)}`,
          );
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
    targetPath: string | undefined,
    expandIfPinned: boolean = false,
  ): Promise<void> => {
    let listing = targetPath ? await fetchDirEntries(targetPath) : null;
    if (!listing) {
      listing = await api<DirectoryResponse>("/api/directories").catch(
        () => null,
      );
      if (!listing) {
        treeContainer.innerHTML = `<div class="tree-notice error">Directory access is unavailable.</div>`;
        return;
      }
      if (targetPath) showToast(`Showing workspace root (${listing.path})`);
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
  await navigateTo(undefined, true);
}
async function start(): Promise<void> {
  renderShell();
  applyRawMode();
  applyReasoningToggle();
  updateNotificationButton();
  if (!authToken()) {
    openTokenModal();
  }
  void loadSlots();
  void loadSessions();
  void loadPins();
  void registerNotifications();
  void loadNotificationConfig();
  void loadNotifications();
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
  window.setInterval(() => {
    if (document.visibilityState === "visible") void loadSessions();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void syncPermissionState().then(() => updateNotificationButton());
      void loadNotifications();
      void loadSessions();
      if (activeId) void loadState();
      window.setTimeout(() => {
        if (activeId) void acknowledgeSlot(activeId);
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
