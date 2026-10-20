import { createConnection, type Socket } from "node:net";
import { promises as fs, type Stats } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  API_VERSION,
  isSlotId,
  type ActivityAgentStatus,
  type ActivityJob,
  type ActivitySubagent,
  type ActivityTodoPhase,
  type CapabilityMap,
  type DirectoryListing,
  type CommandResponse,
  type MoveResponse,
  type SessionActivity,
  type SessionSummary,
  type SlotAction,
  type SlotState,
  type SlotSummary,
  type TerminalSnapshot,
} from "./shared";
import {
  createNotificationService,
  type NotificationService,
  type PushSubscriptionInput,
} from "./notifications";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME?.trim() || homedir();
const WORKSPACE_ROOT = resolve(process.env.OMP_MOBILE_ROOT ?? HOME);
const IPC_ROOT = resolve(
  process.env.OMP_MOBILE_IPC_DIR ?? join(HOME, ".local/state/omp-mobile"),
);
const PINS_FILE = join(IPC_ROOT, "pins.json");
const TOKEN_FILE =
  process.env.OMP_MOBILE_TOKEN_FILE ??
  join(HOME, ".config/zellij/ompbox-mobile.token");
const PORT = Number.parseInt(process.env.OMP_MOBILE_PORT ?? "4173", 10);
const DESKTOP_URL =
  process.env.OMP_MOBILE_DESKTOP_URL ?? "http://127.0.0.1:4180";
const SESSIONS_ROOT = resolve(
  process.env.OMP_DESKTOP_SESSIONS_DIR ?? join(HOME, ".omp/agent/sessions"),
);
const MAX_BODY = 128 * 1024;
const MAX_IPC = 4 * 1024 * 1024;
const MAX_METADATA = 64 * 1024;
const MAX_ENTRIES = 250;
const MAX_DESKTOP_BODY = 8 * 1024 * 1024;
const STREAM_IDLE_MS = 45_000;
const STREAM_READY_TIMEOUT_MS = 3_500;
const TERMINAL_WRITE_LIMIT = 16 * 1024;
const ALLOWED_ORIGINS = new Set(
  (process.env.OMP_MOBILE_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

/**
 * The desktop daemon owns every omp process; this gateway never spawns omp.
 * Its URL must stay loopback: the daemon has no authentication of its own, and
 * a phone-reachable address would let anyone on the tailnet control PTYs.
 */
function desktopBaseUrl(): URL {
  const url = new URL(DESKTOP_URL);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error(
      "OMP_MOBILE_DESKTOP_URL must be a loopback http URL, e.g. http://127.0.0.1:4180",
    );
  return url;
}

const DESKTOP = desktopBaseUrl();
const DESKTOP_WS = `ws://${DESKTOP.host}/ws/term`;

let mobileToken = "";
let clientBundle: ArrayBuffer | undefined;
let notificationService: NotificationService | undefined;
let knownSlotIds: string[] = [];

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function errorResponse(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: message, ...extra }, status);
}

function tokenMatches(value: string | null): boolean {
  if (!value || !value.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(value.slice(7), "utf8");
  const expected = Buffer.from(mobileToken, "utf8");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

function effectiveOrigin(request: Request): string {
  const host = request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol =
    forwarded === "https"
      ? "https"
      : new URL(request.url).protocol.slice(0, -1);
  return `${protocol}://${host}`;
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (origin === new URL(request.url).origin) return true;
  return origin === effectiveOrigin(request);
}

function isWithinRoot(candidate: string, root = WORKSPACE_ROOT): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !rel.startsWith("/"))
  );
}

async function realPathWithin(
  candidate: string,
  root = WORKSPACE_ROOT,
): Promise<string | undefined> {
  try {
    const [realCandidate, realRoot] = await Promise.all([
      fs.realpath(candidate),
      fs.realpath(root),
    ]);
    return isWithinRoot(realCandidate, realRoot) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dot-entries hold configuration and credentials. They are never browsable,
 * pinnable, valid move destinations, or runtime working directories.
 */
function hiddenPath(candidate: string): boolean {
  return relative(WORKSPACE_ROOT, candidate)
    .split(sep)
    .some(
      (segment) =>
        segment.startsWith(".") && segment !== "." && segment !== "..",
    );
}

function readBody(request: Request): Promise<string> {
  return request.arrayBuffer().then((buffer) => {
    if (buffer.byteLength > MAX_BODY) throw new Error("request body too large");
    return new TextDecoder().decode(buffer);
  });
}

function parseJson(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Desktop daemon client                                                      */
/* -------------------------------------------------------------------------- */

type DesktopRuntimeInfo = {
  id: string;
  alive: boolean;
  pid: number | null;
  cols: number;
  rows: number;
  startedAt: string | null;
  bytesOut: number;
  cwd: string;
  sessionFile: string | null;
  title: string;
  status: string;
  lastActivity: string | null;
};

function isRuntimeInfo(value: unknown): value is DesktopRuntimeInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const runtime = value as Record<string, unknown>;
  return (
    typeof runtime.id === "string" &&
    isSlotId(runtime.id) &&
    typeof runtime.alive === "boolean" &&
    typeof runtime.cols === "number" &&
    typeof runtime.rows === "number" &&
    typeof runtime.cwd === "string" &&
    typeof runtime.title === "string" &&
    typeof runtime.status === "string"
  );
}

async function desktopRequest(
  path: string,
  init: RequestInit = {},
  timeoutMs = 4000,
): Promise<Response | undefined> {
  try {
    return await fetch(new URL(path, DESKTOP), {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return undefined;
  }
}

async function readDesktopJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.length > MAX_DESKTOP_BODY) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function listDesktopRuntimes(): Promise<
  DesktopRuntimeInfo[] | undefined
> {
  const response = await desktopRequest("/api/runtimes");
  if (!response || !response.ok) return undefined;
  const body = await readDesktopJson(response);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const runtimes = (body as Record<string, unknown>).runtimes;
  if (!Array.isArray(runtimes)) return undefined;
  return runtimes.filter(isRuntimeInfo);
}

async function createDesktopRuntime(request: {
  cwd?: string;
  resume?: string;
}): Promise<{ runtime?: DesktopRuntimeInfo; status: number; error?: string }> {
  const response = await desktopRequest("/api/runtimes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response) return { status: 503, error: "desktop daemon unavailable" };
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const message = text.trim().slice(0, 300);
    return {
      status:
        response.status >= 400 && response.status <= 599 ? response.status : 502,
      error: message || "desktop daemon rejected the runtime",
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return { status: 502, error: "desktop daemon returned an invalid runtime" };
  }
  const runtime =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).runtime
      : undefined;
  if (!isRuntimeInfo(runtime))
    return { status: 502, error: "desktop daemon returned an invalid runtime" };
  return { runtime, status: 200 };
}

async function listDesktopSessions(
  limit: number,
  search?: string,
): Promise<SessionSummary[] | undefined> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set("search", search);
  const response = await desktopRequest(`/api/sessions?${params.toString()}`);
  if (!response || !response.ok) return undefined;
  const body = await readDesktopJson(response);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const sessions = (body as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) return undefined;
  const result: SessionSummary[] = [];
  for (const entry of sessions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      typeof value.path !== "string" ||
      typeof value.cwd !== "string" ||
      typeof value.title !== "string" ||
      typeof value.updatedAt !== "string" ||
      typeof value.costUsd !== "number" ||
      !Number.isFinite(value.costUsd)
    )
      continue;
    result.push({
      id: value.id,
      path: value.path,
      cwd: value.cwd,
      title: value.title,
      updatedAt: value.updatedAt,
      costUsd: value.costUsd,
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Extension IPC                                                              */
/* -------------------------------------------------------------------------- */

type IpcResponse = { status: number; body: string };

function ipcRequest(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: string,
  timeoutMs: number = 3000,
): Promise<IpcResponse> {
  const { promise, resolve: resolveRequest, reject: rejectRequest } =
    Promise.withResolvers<IpcResponse>();
  let settled = false;
  const chunks: Buffer[] = [];
  let total = 0;
  const socket: Socket = createConnection({ path: socketPath });
  const finish = (error?: Error, response?: IpcResponse) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    if (error) rejectRequest(error);
    else resolveRequest(response as IpcResponse);
  };
  socket.setTimeout(timeoutMs, () => finish(new Error("extension socket timeout")));
  socket.once("error", (error) => finish(error));
  socket.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > MAX_IPC) return finish(new Error("extension response too large"));
    chunks.push(Buffer.from(chunk));
  });
  socket.once("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) return finish(new Error("malformed extension response"));
    const header = raw.slice(0, split);
    const statusMatch = /^HTTP\/1\.1\s+(\d{3})/m.exec(header);
    if (!statusMatch) return finish(new Error("malformed extension status"));
    const contentLength = /\r\ncontent-length:\s*(\d+)/i.exec(header)?.[1];
    const payload = raw.slice(split + 4);
    if (
      contentLength !== undefined &&
      Buffer.byteLength(payload) < Number(contentLength)
    )
      return finish(new Error("truncated extension response"));
    finish(undefined, {
      status: Number(statusMatch[1]),
      body:
        contentLength === undefined
          ? payload
          : payload.slice(0, Number(contentLength)),
    });
  });
  socket.once("connect", () => {
    const requestBody = body ?? "";
    const headers = [
      `${method} ${path} HTTP/1.1`,
      "Host: omp-mobile",
      "Connection: close",
      `Authorization: Bearer ${mobileToken}`,
      `X-OMP-Mobile-Token: ${mobileToken}`,
      ...(requestBody
        ? [
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(requestBody)}`,
          ]
        : []),
      "",
      requestBody,
    ].join("\r\n");
    socket.write(headers);
  });
  return promise;
}

async function socketAvailable(id: string): Promise<boolean> {
  if (!isSlotId(id)) return false;
  try {
    const stat = await fs.lstat(join(IPC_ROOT, `${id}.sock`));
    const uid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    return (
      stat.isSocket() &&
      (uid === undefined || stat.uid === uid) &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

/**
 * Raw `/state` read for list/status enrichment. Failures never throw: a
 * runtime without a live extension still shows up via the desktop list.
 */
async function readExtensionState(
  id: string,
  timeoutMs = 1200,
): Promise<Record<string, unknown> | undefined> {
  if (!(await socketAvailable(id))) return undefined;
  try {
    const response = await ipcRequest(
      join(IPC_ROOT, `${id}.sock`),
      "GET",
      "/state",
      undefined,
      timeoutMs,
    );
    if (response.status < 200 || response.status >= 300) return undefined;
    const value = JSON.parse(response.body) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Headless terminal mirror                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The phone's terminal view is rendered by the same xterm core as the desktop
 * client (`@xterm/headless`, xterm 6): each attached runtime feeds its PTY
 * bytes into a headless Terminal, and snapshots read the visible viewport of
 * its active buffer. Styling, alt-screen handling, wide chars and scroll
 * regions therefore follow xterm's own parser instead of a private one.
 */


/* -------------------------------------------------------------------------- */
/* Desktop stream attachments                                                 */
/* -------------------------------------------------------------------------- */

type DesktopStream = {
  id: string;
  socket: WebSocket;
  terminal: HeadlessTerminal;
  ready: Promise<boolean>;
  closed: boolean;
  hello: boolean;
  replayBytes: number;
  receivedBytes: number;
  /** Writes handed to the xterm parser that have not finished parsing yet. */
  pendingWrites: number;
  drained: Promise<void> | null;
  resolveDrained: (() => void) | null;
  closeTimer?: Timer;
};

const streams = new Map<string, DesktopStream>();

function closeStream(stream: DesktopStream): void {
  if (stream.closed) return;
  stream.closed = true;
  clearTimeout(stream.closeTimer);
  try {
    stream.socket.close();
  } catch {
    // already closed
  }
  stream.terminal.dispose();
  stream.pendingWrites = 0;
  const resolve = stream.resolveDrained;
  stream.drained = null;
  stream.resolveDrained = null;
  resolve?.();
  if (streams.get(stream.id) === stream) streams.delete(stream.id);
}

function touchStream(stream: DesktopStream): void {
  clearTimeout(stream.closeTimer);
  stream.closeTimer = setTimeout(() => closeStream(stream), STREAM_IDLE_MS);
}

/**
 * Snapshot reads must not race the parser: xterm's `write` callback fires
 * after the chunk has been parsed, so a snapshot waits until every queued
 * write has drained (in order) before reading the buffer.
 */
function drainWrites(stream: DesktopStream): Promise<void> {
  if (stream.closed || stream.pendingWrites === 0) return Promise.resolve();
  if (!stream.drained) {
    const { promise, resolve } = Promise.withResolvers<void>();
    stream.drained = promise;
    stream.resolveDrained = resolve;
  }
  return stream.drained;
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}

/**
 * A read-mostly attachment to the desktop PTY: it keeps the omp process
 * started (a fresh runtime spawns on first attach), mirrors its bytes into a
 * headless xterm terminal, and can send input frames back. Closing the socket
 * only detaches; the runtime keeps running and the next request reattaches.
 */
function attachStream(info: DesktopRuntimeInfo): DesktopStream {
  const existing = streams.get(info.id);
  if (existing && !existing.closed) {
    touchStream(existing);
    return existing;
  }
  const terminal = new HeadlessTerminal({
    cols: info.cols,
    rows: info.rows,
    scrollback: 1000,
    allowProposedApi: true,
  });
  const socket = new WebSocket(
    `${DESKTOP_WS}?runtime=${encodeURIComponent(info.id)}`,
  );
  socket.binaryType = "arraybuffer";
  const { promise: ready, resolve: resolveReady } =
    Promise.withResolvers<boolean>();
  let settled = false;
  const stream: DesktopStream = {
    id: info.id,
    socket,
    terminal,
    ready,
    closed: false,
    hello: false,
    replayBytes: 0,
    receivedBytes: 0,
    pendingWrites: 0,
    drained: null,
    resolveDrained: null,
  };
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolveReady(false);
  }, STREAM_READY_TIMEOUT_MS);
  const finishReady = (value: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolveReady(value);
  };
  socket.addEventListener("message", (event) => {
    touchStream(stream);
    const data = (event as MessageEvent).data;
    if (typeof data === "string") {
      let hello: unknown;
      try {
        hello = JSON.parse(data);
      } catch {
        return;
      }
      if (!hello || typeof hello !== "object") return;
      const message = hello as Record<string, unknown>;
      if (message.type !== "hello") return;
      const runtime =
        message.runtime && typeof message.runtime === "object"
          ? (message.runtime as Record<string, unknown>)
          : undefined;
      const cols = typeof runtime?.cols === "number" ? runtime.cols : info.cols;
      const rows = typeof runtime?.rows === "number" ? runtime.rows : info.rows;
      terminal.resize(cols, rows);
      stream.hello = true;
      stream.replayBytes =
        typeof message.replayBytes === "number" &&
        Number.isFinite(message.replayBytes)
          ? message.replayBytes
          : 0;
      if (stream.receivedBytes >= stream.replayBytes) finishReady(true);
      return;
    }
    const bytes = toBytes(data);
    if (!bytes) return;
    stream.receivedBytes += bytes.byteLength;
    stream.pendingWrites += 1;
    terminal.write(decoder.decode(bytes, { stream: true }), () => {
      if (stream.closed) return;
      stream.pendingWrites -= 1;
      if (stream.pendingWrites > 0) return;
      const resolve = stream.resolveDrained;
      stream.drained = null;
      stream.resolveDrained = null;
      resolve?.();
    });
    if (stream.hello && stream.receivedBytes >= stream.replayBytes)
      finishReady(true);
  });
  socket.addEventListener("close", () => {
    closeStream(stream);
    finishReady(false);
  });
  socket.addEventListener("error", () => finishReady(false));
  streams.set(info.id, stream);
  touchStream(stream);
  return stream;
}

async function ensureStream(
  info: DesktopRuntimeInfo,
): Promise<DesktopStream | undefined> {
  const stream = attachStream(info);
  const ready = await stream.ready;
  if (!ready || stream.closed) {
    closeStream(stream);
    return undefined;
  }
  return stream;
}

async function findDesktopRuntime(
  id: string,
): Promise<DesktopRuntimeInfo | undefined | "unavailable"> {
  const runtimes = await listDesktopRuntimes();
  if (!runtimes) return "unavailable";
  return runtimes.find((runtime) => runtime.id === id);
}

/** Send a raw input frame to the desktop PTY that owns `id`. */
async function sendRuntimeInput(id: string, data: string): Promise<boolean> {
  const info = await findDesktopRuntime(id);
  if (!info || info === "unavailable" || !info.alive) return false;
  const stream = await ensureStream(info);
  if (!stream) return false;
  if (stream.socket.readyState !== WebSocket.OPEN) return false;
  try {
    stream.socket.send(JSON.stringify({ type: "input", data }));
  } catch {
    return false;
  }
  touchStream(stream);
  return true;
}

async function waitForExtension(id: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketAvailable(id)) return;
    await Bun.sleep(100);
  }
}

/* -------------------------------------------------------------------------- */
/* Slot views                                                                 */
/* -------------------------------------------------------------------------- */

async function runtimeSummary(info: DesktopRuntimeInfo): Promise<SlotSummary> {
  const raw = await readExtensionState(info.id);
  const title =
    typeof raw?.title === "string" && raw.title.trim()
      ? raw.title.trim().slice(0, 200)
      : info.title;
  const cwd =
    typeof raw?.cwd === "string" && raw.cwd.trim()
      ? normalize(raw.cwd.trim()).slice(0, 2000)
      : info.cwd;
  const summary =
    typeof raw?.summary === "string" && raw.summary.trim()
      ? raw.summary.trim().slice(0, 500)
      : undefined;
  const accent =
    typeof raw?.accent === "string" && /^#[0-9a-f]{6}$/i.test(raw.accent)
      ? raw.accent
      : undefined;
  const status =
    raw?.agentActive === true
      ? "running"
      : info.alive
        ? "connected"
        : "offline";
  return {
    id: info.id,
    title,
    ...(summary ? { summary } : {}),
    ...(accent ? { accent } : {}),
    cwd,
    status,
    connected: raw !== undefined,
    sessionFile: info.sessionFile,
  };
}

const TERMINAL_UNAVAILABLE = {
  read: false,
  write: false,
  resize: false,
  focus: false,
};

async function slotsResponse(): Promise<Response> {
  const runtimes = await listDesktopRuntimes();
  if (!runtimes)
    return errorResponse(503, "desktop daemon unavailable");
  knownSlotIds = runtimes.map((runtime) => runtime.id);
  const slots = await Promise.all(runtimes.map(runtimeSummary));
  return json({ apiVersion: API_VERSION, slots });
}

async function validCwdPath(value: unknown): Promise<string | undefined> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    return undefined;
  const path = await realPathWithin(resolve(value));
  if (!path || hiddenPath(path)) return undefined;
  try {
    return (await fs.stat(path)).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

async function validResumePath(value: unknown): Promise<string | undefined> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !isAbsolute(value) ||
    !value.endsWith(".jsonl") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    return undefined;
  try {
    const [real, root] = await Promise.all([
      fs.realpath(resolve(value)),
      fs.realpath(SESSIONS_ROOT),
    ]);
    if (real !== root && !real.startsWith(`${root}${sep}`)) return undefined;
    const stat = await fs.stat(real);
    return stat.isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

async function createSlot(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = parseJson(await readBody(request));
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
  let cwd: string | undefined;
  if (body.cwd !== undefined) {
    cwd = await validCwdPath(body.cwd);
    if (!cwd)
      return errorResponse(
        403,
        "cwd must be an existing non-hidden directory inside the workspace",
      );
  }
  let resume: string | undefined;
  if (body.resume !== undefined) {
    resume = await validResumePath(body.resume);
    if (!resume)
      return errorResponse(
        400,
        "resume must be an existing session file under the desktop session store",
      );
  }
  const created = await createDesktopRuntime({ cwd, resume });
  if (!created.runtime)
    return errorResponse(
      created.status,
      created.error ?? "desktop daemon unavailable",
    );
  const info = created.runtime;
  // A fresh runtime spawns on first attach; the desktop UI does the same when
  // a pane binds to it. Waiting for the extension socket makes the returned
  // slot immediately actionable for prompt/model/terminal calls.
  const stream = attachStream(info);
  void stream.ready;
  await waitForExtension(info.id, 2500);
  // Re-read the runtime so the response carries what the daemon learned while
  // the process booted (sniffed session file, title, live status).
  const fresh = (await listDesktopRuntimes())?.find(
    (runtime) => runtime.id === info.id,
  );
  return json({ slot: await runtimeSummary(fresh ?? info) });
}

async function deleteSlot(id: string): Promise<Response> {
  const info = await findDesktopRuntime(id);
  if (info === "unavailable")
    return errorResponse(503, "desktop daemon unavailable");
  if (!info) return errorResponse(404, "unknown runtime");
  const response = await desktopRequest(
    `/api/runtimes/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response)
    return errorResponse(503, "desktop daemon unavailable");
  if (!response.ok) {
    return errorResponse(
      response.status === 404 ? 404 : 502,
      response.status === 404 ? "unknown runtime" : "desktop daemon rejected the stop",
    );
  }
  const stream = streams.get(id);
  if (stream) closeStream(stream);
  return json({ ok: true });
}

async function sessionsResponse(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawLimit = Number.parseInt(params.get("limit") ?? "60", 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(200, Math.floor(rawLimit))
      : 60;
  const search = params.get("search")?.slice(0, 200) || undefined;
  const sessions = await listDesktopSessions(limit, search);
  if (!sessions) return errorResponse(503, "desktop daemon unavailable");
  return json({ sessions });
}

async function terminalSnapshot(id: string): Promise<Response> {
  const info = await findDesktopRuntime(id);
  if (info === "unavailable")
    return errorResponse(503, "desktop daemon unavailable", {
      capabilities: { reconnect: true },
    });
  if (!info)
    return errorResponse(404, "unknown runtime");
  if (!info.alive)
    return errorResponse(503, "runtime is not running", {
      capabilities: TERMINAL_UNAVAILABLE,
    });
  const stream = await ensureStream(info);
  if (!stream)
    return errorResponse(503, "terminal stream unavailable", {
      capabilities: TERMINAL_UNAVAILABLE,
    });
  await drainWrites(stream);
  if (stream.closed)
    return errorResponse(503, "terminal stream unavailable", {
      capabilities: TERMINAL_UNAVAILABLE,
    });
  const raw = await readExtensionState(id);
  // Visible viewport of whichever buffer is active (primary or alternate):
  // the phone mirrors what a pane shows right now.
  const buffer = stream.terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < stream.terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    lines.push(line ? line.translateToString(false) : "");
  }
  const snapshot: TerminalSnapshot = {
    apiVersion: API_VERSION,
    generation:
      typeof raw?.generation === "string" ? raw.generation : `desktop:${id}`,
    paneId: id,
    screen: lines.join("\n"),
    capabilities: { read: true, write: true, resize: false, focus: false },
  };
  return json(snapshot);
}

async function terminalAction(id: string, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = parseJson(await readBody(request));
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
  if (
    typeof body.generation !== "string" ||
    body.generation.length === 0 ||
    body.generation.length > 200 ||
    body.type !== "write" ||
    body.confirmed !== true ||
    typeof body.text !== "string" ||
    body.text.length > TERMINAL_WRITE_LIMIT
  )
    return errorResponse(
      400,
      "terminal write requires generation, confirmed:true, and text",
    );
  const info = await findDesktopRuntime(id);
  if (info === "unavailable")
    return errorResponse(503, "desktop daemon unavailable", {
      capabilities: { reconnect: true },
    });
  if (!info) return errorResponse(404, "unknown runtime");
  const raw = await readExtensionState(id);
  if (!raw)
    return errorResponse(503, "extension unavailable", {
      capabilities: { reconnect: true },
    });
  if (
    raw.generation !== undefined &&
    String(raw.generation) !== body.generation
  )
    return errorResponse(409, "session changed; refresh before writing", {
      generation: raw.generation,
    });
  if (!(await sendRuntimeInput(id, body.text)))
    return errorResponse(503, "terminal write failed");
  return json({ ok: true, generation: body.generation });
}

function activityText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function finiteNumber(
  value: unknown,
  min = 0,
  max = 1e15,
): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined;
}

/**
 * Bound and validate the extension's activity projection before it crosses the
 * gateway. The extension already caps arrays and strings, but the gateway is
 * the trust boundary for anything a browser renders.
 */
function normaliseActivity(value: unknown): SessionActivity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;

  const todos: ActivityTodoPhase[] = [];
  if (Array.isArray(raw.todos)) {
    for (const rawPhase of raw.todos.slice(0, 12)) {
      if (!rawPhase || typeof rawPhase !== "object" || Array.isArray(rawPhase))
        continue;
      const phase = rawPhase as Record<string, unknown>;
      const name = activityText(phase.name, 120);
      if (!name || !Array.isArray(phase.tasks)) continue;
      const tasks = phase.tasks.slice(0, 40).flatMap<ActivityTodoPhase["tasks"][number]>((rawTask) => {
        if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask))
          return [];
        const task = rawTask as Record<string, unknown>;
        const content = activityText(task.content, 400);
        const status = task.status;
        if (
          !content ||
          (status !== "pending" &&
            status !== "in_progress" &&
            status !== "completed" &&
            status !== "abandoned" &&
            status !== "blocked")
        )
          return [];
        const blocker = activityText(task.blocker, 200);
        return [{ content, status, ...(blocker ? { blocker } : {}) }];
      });
      todos.push({ name, tasks });
    }
  }

  const subagents: ActivitySubagent[] = [];
  if (Array.isArray(raw.subagents)) {
    for (const rawAgent of raw.subagents.slice(0, 16)) {
      if (!rawAgent || typeof rawAgent !== "object" || Array.isArray(rawAgent))
        continue;
      const agent = rawAgent as Record<string, unknown>;
      const id = activityText(agent.id, 160);
      const status = agent.status;
      if (
        !id ||
        (status !== "pending" &&
          status !== "running" &&
          status !== "completed" &&
          status !== "failed" &&
          status !== "aborted")
      )
        continue;
      const subagent: ActivitySubagent = {
        id,
        status: status as ActivityAgentStatus,
      };
      const label = activityText(agent.label, 160);
      const type = activityText(agent.agent, 80);
      const description = activityText(agent.description, 200);
      const task = activityText(agent.task, 600);
      const activity = activityText(agent.activity, 300);
      const currentTool = activityText(agent.currentTool, 120);
      const model = activityText(agent.model, 160);
      const error = activityText(agent.error, 400);
      const note = activityText(agent.note, 240);
      if (label) subagent.label = label;
      if (type) subagent.agent = type;
      if (description) subagent.description = description;
      if (task) subagent.task = task;
      if (activity) subagent.activity = activity;
      if (currentTool) subagent.currentTool = currentTool;
      if (model) subagent.model = model;
      if (error) subagent.error = error;
      if (note) subagent.note = note;
      if (agent.detached === true) subagent.detached = true;
      const startedAt = finiteNumber(agent.startedAt);
      const updatedAt = finiteNumber(agent.updatedAt);
      const durationMs = finiteNumber(agent.durationMs);
      const toolCount = finiteNumber(agent.toolCount);
      const requests = finiteNumber(agent.requests);
      const tokens = finiteNumber(agent.tokens);
      const cost = finiteNumber(agent.cost, 0, 1e9);
      const contextTokens = finiteNumber(agent.contextTokens);
      const contextWindow = finiteNumber(agent.contextWindow);
      if (startedAt !== undefined) subagent.startedAt = startedAt;
      if (updatedAt !== undefined) subagent.updatedAt = updatedAt;
      if (durationMs !== undefined) subagent.durationMs = durationMs;
      if (toolCount !== undefined) subagent.toolCount = toolCount;
      if (requests !== undefined) subagent.requests = requests;
      if (tokens !== undefined) subagent.tokens = tokens;
      if (cost !== undefined) subagent.cost = cost;
      if (contextTokens !== undefined) subagent.contextTokens = contextTokens;
      if (contextWindow !== undefined) subagent.contextWindow = contextWindow;
      subagents.push(subagent);
    }
  }

  const jobs: ActivityJob[] = [];
  if (Array.isArray(raw.jobs)) {
    for (const rawJob of raw.jobs.slice(0, 16)) {
      if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob))
        continue;
      const job = rawJob as Record<string, unknown>;
      const id = activityText(job.id, 120);
      const label = activityText(job.label, 200);
      const status = job.status;
      if (
        !id ||
        !label ||
        (status !== "running" &&
          status !== "completed" &&
          status !== "failed" &&
          status !== "cancelled")
      )
        continue;
      const startedAt = finiteNumber(job.startedAt);
      if (startedAt === undefined) continue;
      jobs.push({
        id,
        type: job.type === "bash" ? "bash" : job.type === "task" ? "task" : "other",
        label,
        status,
        startedAt,
        ...(finiteNumber(job.durationMs) !== undefined
          ? { durationMs: finiteNumber(job.durationMs) }
          : {}),
      });
    }
  }

  const working = activityText(raw.working, 300);
  const workingTool = activityText(raw.workingTool, 120);
  const since = finiteNumber(raw.since);
  if (
    !working &&
    !workingTool &&
    todos.length === 0 &&
    subagents.length === 0 &&
    jobs.length === 0
  )
    return undefined;
  return {
    ...(working ? { working } : {}),
    ...(workingTool ? { workingTool } : {}),
    ...(since !== undefined ? { since } : {}),
    todos,
    subagents,
    jobs,
  };
}

function normaliseState(raw: Record<string, unknown>): SlotState | undefined {
  const generationValue = raw.generation ?? raw.sessionGeneration;
  if (generationValue === undefined || generationValue === null)
    return undefined;
  const messages = Array.isArray(raw.messages)
    ? (raw.messages
        .slice(-500)
        .filter(
          (message) => message && typeof message === "object",
        ) as SlotState["messages"])
    : [];
  const pendingMessages = Array.isArray(raw.pendingMessages)
    ? raw.pendingMessages.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const message = value as Record<string, unknown>;
        if (
          typeof message.id !== "string" ||
          typeof message.text !== "string" ||
          (message.status !== "sending" && message.status !== "queued")
        )
          return [];
        const status: "sending" | "queued" =
          message.status === "queued" ? "queued" : "sending";
        return [
          {
            id: message.id.slice(0, 200),
            text: message.text.slice(0, 8000),
            status,
          },
        ];
      })
    : undefined;
  const commands: SlotState["commands"] = Array.isArray(raw.commands)
    ? raw.commands.slice(0, 500).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const command = value as Record<string, unknown>;
        if (
          typeof command.name !== "string" ||
          command.name.length === 0 ||
          command.name.length > 200 ||
          /[\s/\u0000-\u001f\u007f-\u009f]/.test(command.name)
        )
          return [];
        const aliases = Array.isArray(command.aliases)
          ? command.aliases
              .filter(
                (alias): alias is string =>
                  typeof alias === "string" &&
                  alias.length > 0 &&
                  alias.length <= 200 &&
                  !/[\s/\u0000-\u001f\u007f-\u009f]/.test(alias),
              )
              .slice(0, 20)
          : undefined;
        return [
          {
            name: command.name,
            ...(aliases?.length ? { aliases } : {}),
            ...(typeof command.description === "string"
              ? { description: command.description.slice(0, 1000) }
              : {}),
          },
        ];
      })
    : [];
  const capabilities =
    raw.capabilities && typeof raw.capabilities === "object"
      ? (raw.capabilities as CapabilityMap)
      : {};
  const marker =
    raw.completion && typeof raw.completion === "object"
      ? (raw.completion as Record<string, unknown>)
      : undefined;
  const completion =
    marker &&
    typeof marker.identity === "string" &&
    marker.identity.length <= 512 &&
    typeof marker.completedAt === "number" &&
    Number.isFinite(marker.completedAt)
      ? {
          identity: marker.identity,
          ...(typeof marker.generation === "string"
            ? { generation: marker.generation }
            : {}),
          ...(typeof marker.turn === "number" && Number.isInteger(marker.turn)
            ? { turn: marker.turn }
            : {}),
          completedAt: marker.completedAt,
        }
      : undefined;
  const editor =
    raw.editor && typeof raw.editor === "object"
      ? (raw.editor as Record<string, unknown>)
      : undefined;
  const activity = normaliseActivity(raw.activity);
  return {
    apiVersion: API_VERSION,
    generation: String(generationValue),
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd.slice(0, 2000) } : {}),
    model: raw.model ?? null,
    models: Array.isArray(raw.models) ? raw.models.slice(0, 200) : [],
    effort: raw.effort ?? null,
    efforts: Array.isArray(raw.efforts) ? raw.efforts.slice(0, 100) : [],
    context: raw.context ?? null,
    ...(completion ? { completion } : {}),
    ...(typeof raw.agentActive === "boolean"
      ? { agentActive: raw.agentActive }
      : {}),
    ...(activity ? { activity } : {}),
    theme: raw.theme ?? null,
    commands,
    messages,
    ...(typeof raw.pendingApproval === "number" &&
    Number.isFinite(raw.pendingApproval)
      ? { pendingApproval: Math.max(0, Math.min(100, raw.pendingApproval)) }
      : {}),
    ...(typeof raw.hasPendingMessages === "boolean"
      ? { hasPendingMessages: raw.hasPendingMessages }
      : {}),
    ...(pendingMessages ? { pendingMessages } : {}),
    ...(editor && typeof editor.available === "boolean"
      ? {
          editor: {
            available: editor.available,
            empty: typeof editor.empty === "boolean" ? editor.empty : null,
          },
        }
      : {}),
    capabilities,
    ...(typeof raw.title === "string" && raw.title.trim()
      ? { title: raw.title.trim().slice(0, 200) }
      : {}),
    ...(typeof raw.summary === "string" && raw.summary.trim()
      ? { summary: raw.summary.trim().slice(0, 500) }
      : {}),
    ...(typeof raw.title === "string" &&
    raw.title.trim() &&
    typeof raw.accent === "string" &&
    /^#[0-9a-f]{6}$/i.test(raw.accent)
      ? { accent: raw.accent }
      : {}),
    ...(raw.cost &&
    typeof raw.cost === "object" &&
    !Array.isArray(raw.cost) &&
    "total" in raw.cost &&
    typeof raw.cost.total === "number" &&
    Number.isFinite(raw.cost.total) &&
    raw.cost.total >= 0 &&
    raw.cost.total <= 1e9
      ? { cost: { total: raw.cost.total } }
      : {}),
    connected: true,
  };
}

async function getSlotState(
  slot: string,
): Promise<{ state?: SlotState; response?: IpcResponse; error?: string }> {
  if (!(await socketAvailable(slot))) return { error: "extension unavailable" };
  try {
    const response = await ipcRequest(
      join(IPC_ROOT, `${slot}.sock`),
      "GET",
      "/state",
    );
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      return { response, error: "invalid extension JSON" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { response, error: "invalid extension state" };
    const state = normaliseState(value as Record<string, unknown>);
    return state
      ? { state, response }
      : { response, error: "extension returned no generation" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "extension unavailable",
    };
  }
}

async function slotAction(slot: string, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = parseJson(await readBody(request));
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
  const generation =
    typeof body.generation === "string"
      ? body.generation
      : typeof body.generation === "number"
        ? String(body.generation)
        : "";
  if (!generation || generation.length > 200 || typeof body.type !== "string")
    return errorResponse(400, "generation and action type are required");
  body.generation = generation;

  const current = await getSlotState(slot);
  if (!current.state)
    return errorResponse(503, current.error ?? "extension unavailable", {
      capabilities: { reconnect: true },
    });
  if (current.state.generation !== generation) {
    return errorResponse(409, "session changed; refresh before mutating", {
      generation: current.state.generation,
    });
  }

  const type = body.type;
  let stagesInEditor = false;
  if (type === "prompt") {
    if (
      typeof body.text !== "string" ||
      body.text.length === 0 ||
      body.text.length > 100_000
    )
      return errorResponse(400, "prompt text is invalid");
  } else if (type === "abort" || type === "force") {
    // No additional fields.
  } else if (type === "model") {
    if (
      typeof body.provider !== "string" ||
      typeof body.id !== "string" ||
      body.provider.length > 200 ||
      body.id.length > 300
    )
      return errorResponse(400, "model is invalid");
  } else if (type === "effort") {
    if (typeof body.value !== "string" || body.value.length > 100)
      return errorResponse(400, "effort is invalid");
  } else if (type === "command") {
    if (
      body.confirmed !== true ||
      typeof body.text !== "string" ||
      body.text.length === 0 ||
      body.text.length > 10_000 ||
      !body.text.startsWith("/") ||
      /[\u0000-\u001f\u007f-\u009f]/.test(body.text)
    )
      return errorResponse(
        400,
        "command requires explicit confirmation and one line without controls",
      );
    // The owning extension forwards one well-formed token to the omp TUI,
    // which is authoritative about which commands exist; the gateway must not
    // pre-filter, because builtin commands are not enumerable per omp version.
    stagesInEditor = true;
  } else if (type === "move") {
    if (
      body.confirmed !== true ||
      typeof body.path !== "string" ||
      body.path.length === 0 ||
      body.path.length > 4096 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(body.path)
    )
      return errorResponse(
        400,
        "move requires explicit confirmation and a path without controls",
      );
    const requestedPath = expandHomePath(body.path);
    const inputPath = requestedPath.startsWith("/")
      ? requestedPath
      : join(WORKSPACE_ROOT, requestedPath);
    const normalizedPath = await realPathWithin(resolve(inputPath));
    if (!normalizedPath)
      return errorResponse(
        403,
        "move destination is outside the workspace or unavailable",
      );
    if (hiddenPath(normalizedPath))
      return errorResponse(403, "move destination is not browsable");
    try {
      if (!(await fs.stat(normalizedPath)).isDirectory())
        return errorResponse(400, "move destination is not a directory");
    } catch {
      return errorResponse(404, "move destination is unavailable");
    }
    // Forward the normalized absolute path so the extension and the terminal
    // parse the same command, regardless of how the picker addressed it.
    body.path = normalizedPath;
    stagesInEditor = true;
  } else {
    return errorResponse(400, "unsupported action");
  }

  const action: SlotAction = body as unknown as SlotAction;
  try {
    const response = await ipcRequest(
      join(IPC_ROOT, `${slot}.sock`),
      "POST",
      "/action",
      JSON.stringify(action),
    );
    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = { error: "invalid extension response" };
    }
    if (response.status === 409) return json(payload, 409);
    if (response.status < 200 || response.status >= 300)
      return json(payload, response.status >= 400 ? response.status : 502);
    if (stagesInEditor) {
      const prepared = payload as Record<string, unknown> | null;
      const expectedCommand =
        action.type === "move"
          ? `/move ${action.path}`
          : action.type === "command"
            ? action.text
            : "";
      if (
        !prepared ||
        prepared.ok !== true ||
        prepared.staged !== true ||
        prepared.generation !== generation ||
        prepared.command !== expectedCommand ||
        (action.type === "move" && prepared.path !== action.path)
      )
        return errorResponse(502, "Extension did not prepare the command");
      const latest = await getSlotState(slot);
      if (
        latest.state?.generation !== generation ||
        latest.state.agentActive ||
        latest.state.pendingApproval !== 0 ||
        !latest.state.editor?.available ||
        latest.state.editor.empty !== false
      )
        return errorResponse(
          409,
          "Session changed; command was not submitted",
        );
      // The extension staged the command in the editor of the PTY-owned omp
      // process; Enter goes to that same runtime's terminal, exactly like the
      // desktop client pressing it.
      if (!(await sendRuntimeInput(slot, "\r")))
        return errorResponse(
          503,
          "Command prepared but submission failed; inspect the desktop composer before retrying",
        );
      if (action.type === "move") {
        return json({
          ok: true,
          submitted: true,
          generation,
          path: action.path,
          command: expectedCommand,
        } satisfies MoveResponse);
      }
      return json({
        ok: true,
        submitted: true,
        generation,
        command: expectedCommand,
      } satisfies CommandResponse);
    }
    return json(payload, 200);
  } catch (error) {
    return errorResponse(
      503,
      error instanceof Error ? error.message : "extension unavailable",
      { capabilities: { reconnect: true } },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Filesystem, static assets, notifications                                   */
/* -------------------------------------------------------------------------- */

/**
 * Desktop's `/move` accepts `~` and `~/…`. Expand it here, then enforce the
 * same workspace confinement as every other browsable path.
 */
function expandHomePath(input: string): string {
  if (input === "~") return HOME;
  return input.startsWith("~/") ? join(HOME, input.slice(2)) : input;
}

async function directoryListing(request: Request): Promise<Response> {
  const requested = expandHomePath(
    new URL(request.url).searchParams.get("path") ?? WORKSPACE_ROOT,
  );
  const candidate = resolve(
    requested.startsWith("/") ? requested : join(WORKSPACE_ROOT, requested),
  );
  const path = await realPathWithin(candidate);
  if (!path) return errorResponse(403, "path is outside the workspace");
  if (hiddenPath(path))
    return errorResponse(403, "hidden directories are not browsable");
  try {
    const stat = await fs.stat(path);
    if (!stat.isDirectory())
      return errorResponse(400, "path is not a directory");
    const entries = (await fs.readdir(path, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      )
      .slice(0, MAX_ENTRIES);
    const listing: DirectoryListing = {
      path,
      root: WORKSPACE_ROOT,
      parent: path === WORKSPACE_ROOT ? WORKSPACE_ROOT : dirname(path),
      entries: entries.map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
        kind: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
      })),
    };
    return json(listing);
  } catch {
    return errorResponse(404, "directory unavailable");
  }
}

async function defaultPins(): Promise<string[]> {
  for (const candidate of [join(WORKSPACE_ROOT, "dev"), WORKSPACE_ROOT]) {
    const path = await realPathWithin(resolve(candidate));
    if (path) return [path];
  }
  return [];
}

async function readPins(): Promise<string[]> {
  let stat: Stats;
  try {
    stat = await fs.lstat(PINS_FILE);
  } catch {
    // No saved pins yet: start from a useful default rather than an empty list.
    return defaultPins();
  }
  try {
    if (!stat.isFile() || stat.size > MAX_METADATA || (stat.mode & 0o077) !== 0)
      return [];
    const value = JSON.parse(await fs.readFile(PINS_FILE, "utf8")) as unknown;
    if (!Array.isArray(value)) return [];
    const pins: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || pins.length >= 100) continue;
      const path = await realPathWithin(resolve(entry));
      if (path && !hiddenPath(path) && !pins.includes(path)) pins.push(path);
    }
    return pins;
  } catch {
    return [];
  }
}

async function pinsResponse(request: Request): Promise<Response> {
  if (request.method === "GET") return json({ pins: await readPins() });
  let body: Record<string, unknown>;
  try {
    body = parseJson(await readBody(request));
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
  if (!Array.isArray(body.pins) || body.pins.length > 100)
    return errorResponse(400, "pins must be an array of at most 100 paths");
  const pins: string[] = [];
  for (const value of body.pins) {
    if (typeof value !== "string")
      return errorResponse(400, "pins must contain paths");
    const inputPath = value.startsWith("/")
      ? value
      : join(WORKSPACE_ROOT, value);
    const path = await realPathWithin(resolve(inputPath));
    if (!path)
      return errorResponse(403, "pin is outside the workspace or unavailable");
    if (hiddenPath(path))
      return errorResponse(403, "hidden directories cannot be pinned");
    if (!pins.includes(path)) pins.push(path);
  }
  await fs.mkdir(IPC_ROOT, { recursive: true, mode: 0o700 });
  const temporary = `${PINS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(pins)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, PINS_FILE);
  return json({ pins });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
async function staticResponse(pathname: string): Promise<Response> {
  if (pathname === "/client.js" && clientBundle)
    return new Response(clientBundle, {
      headers: { "content-type": MIME[".js"], "cache-control": "no-cache" },
    });
  const relativePath =
    pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const publicRoot = resolve(ROOT, "public");
  const target = resolve(publicRoot, relativePath);
  if (!isWithinRoot(target, publicRoot)) return errorResponse(404, "not found");
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      return errorResponse(404, "not found");
    return new Response(await fs.readFile(target), {
      headers: {
        "content-type": MIME[extname(target)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return errorResponse(404, "not found");
  }
}

async function notificationsApi(request: Request): Promise<Response> {
  const service = notificationService;
  if (!service) return errorResponse(503, "notifications unavailable");
  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && pathname === "/api/notifications/config") {
    const status = await service.status();
    return json({
      enabled: status.enabled,
      ...(status.publicKey ? { publicKey: status.publicKey } : {}),
    });
  }
  if (request.method === "GET" && pathname === "/api/notifications")
    return json(await service.status());
  let body: Record<string, unknown>;
  try {
    body = parseJson(await readBody(request));
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
  if (
    request.method === "POST" &&
    pathname === "/api/notifications/subscriptions"
  ) {
    const value = body.subscription;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return errorResponse(400, "subscription is required");
    try {
      await service.subscribe(value as PushSubscriptionInput);
      return json({ ok: true });
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error ? error.message : "subscription rejected",
      );
    }
  }
  if (
    request.method === "DELETE" &&
    pathname === "/api/notifications/subscriptions"
  ) {
    if (typeof body.endpoint !== "string")
      return errorResponse(400, "endpoint is required");
    try {
      await service.unsubscribe(body.endpoint);
      return json({ ok: true });
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error ? error.message : "subscription rejected",
      );
    }
  }
  if (request.method === "POST" && pathname === "/api/notifications/ack") {
    if (
      typeof body.slot !== "string" ||
      !isSlotId(body.slot) ||
      typeof body.identity !== "string"
    )
      return errorResponse(400, "slot and identity are required");
    try {
      await service.ack(body.slot, body.identity);
      return json({ ok: true });
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error
          ? error.message
          : "notification acknowledgement rejected",
      );
    }
  }
  return errorResponse(404, "not found");
}

function withCors(response: Response, request: Request): Response {
  for (const [key, value] of Object.entries(corsHeaders(request)))
    response.headers.set(key, value);
  return response;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    if (!originAllowed(request))
      return errorResponse(403, "origin not allowed");
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (!url.pathname.startsWith("/api/")) return staticResponse(url.pathname);
  if (!originAllowed(request)) return errorResponse(403, "origin not allowed");
  if (
    (request.method === "POST" ||
      request.method === "PUT" ||
      request.method === "PATCH" ||
      request.method === "DELETE") &&
    !request.headers.get("origin")
  ) {
    return errorResponse(403, "origin required for mutations");
  }
  if (!tokenMatches(request.headers.get("authorization")))
    return errorResponse(401, "authentication required", { auth: "bearer" });
  if (
    url.pathname === "/api/notifications" ||
    url.pathname.startsWith("/api/notifications/")
  ) {
    return withCors(await notificationsApi(request), request);
  }

  if (
    (url.pathname === "/api/settings" &&
      (request.method === "GET" || request.method === "PUT")) ||
    (url.pathname === "/api/restart" && request.method === "POST")
  ) {
    let body: string | undefined;
    if (request.method === "PUT") {
      try {
        body = JSON.stringify(parseJson(await readBody(request)));
      } catch {
        return withCors(errorResponse(400, "invalid settings body"), request);
      }
    }
    const response = await desktopRequest(url.pathname, {
      method: request.method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body,
      }),
    });
    if (!response)
      return withCors(errorResponse(503, "desktop daemon unavailable"), request);
    if (!response.ok)
      return withCors(errorResponse(response.status, await response.text()), request);
    if (url.pathname === "/api/restart")
      return withCors(json({ ok: true }, response.status), request);
    return withCors(new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    }), request);
  }

  if (url.pathname === "/api/slots") {
    if (request.method === "GET") return withCors(await slotsResponse(), request);
    if (request.method === "POST")
      return withCors(await createSlot(request), request);
    return errorResponse(405, "method not allowed");
  }
  if (url.pathname === "/api/sessions" && request.method === "GET")
    return withCors(await sessionsResponse(request), request);
  const deleteMatch = /^\/api\/slots\/([^/]+)$/.exec(url.pathname);
  if (deleteMatch && request.method === "DELETE" && isSlotId(deleteMatch[1]))
    return withCors(await deleteSlot(deleteMatch[1]), request);
  const stateMatch = /^\/api\/slots\/([^/]+)\/state$/.exec(url.pathname);
  if (request.method === "GET" && stateMatch && isSlotId(stateMatch[1])) {
    const result = await getSlotState(stateMatch[1]);
    if (!result.state) {
      return withCors(
        errorResponse(503, result.error ?? "extension unavailable", {
          capabilities: { reconnect: true },
        }),
        request,
      );
    }
    return withCors(json(result.state), request);
  }
  const terminalMatch = /^\/api\/slots\/([^/]+)\/terminal$/.exec(url.pathname);
  if (terminalMatch && isSlotId(terminalMatch[1])) {
    const response =
      request.method === "GET"
        ? await terminalSnapshot(terminalMatch[1])
        : request.method === "POST"
          ? await terminalAction(terminalMatch[1], request)
          : errorResponse(405, "method not allowed");
    return withCors(response, request);
  }
  const actionMatch = /^\/api\/slots\/([^/]+)\/action$/.exec(url.pathname);
  if (request.method === "POST" && actionMatch && isSlotId(actionMatch[1]))
    return withCors(await slotAction(actionMatch[1], request), request);
  if (url.pathname === "/api/directories" && request.method === "GET")
    return withCors(await directoryListing(request), request);
  if (
    url.pathname === "/api/pins" &&
    (request.method === "GET" || request.method === "PUT")
  )
    return withCors(await pinsResponse(request), request);
  return errorResponse(404, "not found");
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-headers":
          "Authorization, Content-Type, X-OMP-Generation",
        "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
        vary: "Origin",
      }
    : {};
}

async function buildClient(): Promise<void> {
  try {
    const result = await Bun.build({
      entrypoints: [join(ROOT, "client.ts")],
      target: "browser",
      format: "esm",
      minify: false,
    });
    if (result.success && result.outputs[0])
      clientBundle = await result.outputs[0].arrayBuffer();
    else console.error("omp-mobile: client bundle unavailable", result.logs);
  } catch (error) {
    console.error("omp-mobile: client bundle unavailable", error);
  }
}

async function loadToken(): Promise<void> {
  const fromEnv = process.env.OMP_MOBILE_TOKEN !== undefined;
  const value = fromEnv
    ? (process.env.OMP_MOBILE_TOKEN as string)
    : await fs.readFile(TOKEN_FILE, "utf8").catch(() => "");
  mobileToken = value.trim();
  if (mobileToken.length < 16 || mobileToken.length > 512)
    throw new Error(
      fromEnv
        ? `OMP_MOBILE_TOKEN must be 16-512 characters (got ${mobileToken.length})`
        : `missing or invalid mobile token at ${TOKEN_FILE} — run \`bun run setup\`, or set OMP_MOBILE_TOKEN / OMP_MOBILE_TOKEN_FILE`,
    );
}

/**
 * Notification polling needs the live runtime ids. On a transient desktop
 * outage the previous list is kept so a daemon restart cannot be mistaken for
 * "every slot disappeared" (which would drop unread completions).
 */
async function notificationSlotIds(): Promise<string[]> {
  const runtimes = await listDesktopRuntimes();
  if (!runtimes) return knownSlotIds;
  knownSlotIds = runtimes.map((runtime) => runtime.id);
  return knownSlotIds;
}

export async function start() {
  await loadToken();
  await fs.mkdir(IPC_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(IPC_ROOT, 0o700).catch(() => undefined);
  await buildClient();
  notificationService?.stop();
  notificationService = createNotificationService({
    ipcRoot: IPC_ROOT,
    token: mobileToken,
    stateFile: join(IPC_ROOT, "notifications.json"),
    listSlots: notificationSlotIds,
  });
  notificationService.start();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    fetch: handle,
  });
  console.log(
    `omp-mobile listening on http://127.0.0.1:${server.port} (desktop daemon: ${DESKTOP.origin}; serve privately with: tailscale serve --bg ${server.port})`,
  );
  return server;
}

if (import.meta.main)
  start().catch((error) => {
    console.error(
      `omp-mobile failed to start: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
