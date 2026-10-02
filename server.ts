import { createConnection, type Socket } from "node:net";
import { promises as fs, type Stats } from "node:fs";
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  API_VERSION,
  SLOT_IDS,
  type CapabilityMap,
  type DirectoryListing,
  type CommandResponse,
  type MoveResponse,
  type SlotAction,
  type SlotId,
  type SlotState,
  type SlotSummary,
  type TerminalSnapshot,
} from "./shared";
import {
  createNotificationService,
  type NotificationService,
  type NotificationSlot,
  type PushSubscriptionInput,
} from "./notifications";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const WORKSPACE_ROOT = resolve(process.env.OMP_MOBILE_ROOT ?? HOME);
const STATE_ROOT = resolve(
  process.env.OMP_ZELLIJ_STATE_DIR ?? join(HOME, ".local/state/omp-zellij"),
);
const IPC_ROOT = resolve(
  process.env.OMP_MOBILE_IPC_DIR ?? join(HOME, ".local/state/omp-mobile"),
);
const PINS_FILE = join(IPC_ROOT, "pins.json");
const TOKEN_FILE =
  process.env.OMP_MOBILE_TOKEN_FILE ??
  join(HOME, ".config/zellij/ompbox-mobile.token");
const PORT = Number.parseInt(process.env.OMP_MOBILE_PORT ?? "4173", 10);
const ZELLIJ_SESSION = process.env.OMP_MOBILE_ZELLIJ_SESSION ?? "ompbox";
const MAX_BODY = 128 * 1024;
const MAX_IPC = 4 * 1024 * 1024;
const MAX_METADATA = 64 * 1024;
const MAX_ENTRIES = 250;
const ALLOWED_ORIGINS = new Set(
  (process.env.OMP_MOBILE_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

let mobileToken = "";
let clientBundle: ArrayBuffer | undefined;
let notificationService: NotificationService | undefined;

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
 * pinnable, or valid move destinations from the phone.
 */
function hiddenPath(candidate: string): boolean {
  return relative(WORKSPACE_ROOT, candidate)
    .split(sep)
    .some(
      (segment) =>
        segment.startsWith(".") && segment !== "." && segment !== "..",
    );
}

async function readJsonFile(
  path: string,
  limit: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0)
      return undefined;
    const value = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function slotMetadata(slot: SlotId): Promise<SlotSummary> {
  const connected = await socketAvailable(slot);

  let liveTitle: string | undefined;
  let liveSummary: string | undefined;
  let liveCwd: string | undefined;
  let liveActive = false;
  let liveAccent: string | undefined;

  if (connected) {
    try {
      const response = await ipcRequest(
        join(IPC_ROOT, `${slot}.sock`),
        "GET",
        "/state",
        undefined,
        400,
      );
      if (response.status >= 200 && response.status < 300) {
        const value = JSON.parse(response.body) as Record<string, unknown>;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          liveActive = value.agentActive === true;
          if (typeof value.title === "string" && value.title.trim()) {
            liveTitle = value.title.trim();
          }
          if (typeof value.summary === "string" && value.summary.trim()) {
            liveSummary = value.summary.trim();
          }
          if (typeof value.cwd === "string" && value.cwd.trim()) {
            liveCwd = normalize(value.cwd.trim());
          }
          if (
            typeof value.accent === "string" &&
            /^#[0-9a-f]{6}$/i.test(value.accent)
          ) {
            liveAccent = value.accent;
          }
        }
      }
    } catch {
      // Socket read failed or timed out; fall back silently to metadata.
    }
  }

  const activePath = join(STATE_ROOT, slot, "active.json");
  const metadata = await readJsonFile(activePath, MAX_METADATA);

  let metaTitle = "";
  let metaSummary: string | undefined;
  let metaCwd: string | undefined;

  if (metadata) {
    if (typeof metadata.cwd === "string" && metadata.cwd.trim()) {
      metaCwd = normalize(metadata.cwd.trim());
    }
    if (typeof metadata.title === "string" && metadata.title.trim()) {
      metaTitle = metadata.title.trim();
    }
    if (typeof metadata.summary === "string" && metadata.summary.trim()) {
      metaSummary = metadata.summary.trim();
    }
    const sessionFile =
      typeof metadata.sessionFile === "string" ? metadata.sessionFile : "";
    if (!metaTitle && sessionFile) {
      try {
        const stat = await fs.lstat(sessionFile);
        const uid =
          typeof process.getuid === "function" ? process.getuid() : undefined;
        if (
          stat.isFile() &&
          stat.size <= MAX_METADATA &&
          (uid === undefined || stat.uid === uid) &&
          (stat.mode & 0o002) === 0
        ) {
          const firstLine = (await fs.readFile(sessionFile, "utf8")).split(
            "\n",
            1,
          )[0];
          const row = JSON.parse(firstLine) as Record<string, unknown>;
          if (typeof row.title === "string" && row.title.trim()) {
            metaTitle = row.title.trim();
          }
        }
      } catch {
        // Session files may disappear during a switch; active.json remains safe metadata.
      }
    }
  }

  const title = (liveTitle || metaTitle || slot).slice(0, 200) || slot;
  const summary = liveSummary ?? metaSummary;
  const cwd = (liveCwd || metaCwd || WORKSPACE_ROOT).slice(0, 2000);

  return {
    id: slot,
    title,
    ...(summary ? { summary: summary.slice(0, 500) } : {}),
    ...(liveAccent ? { accent: liveAccent } : {}),
    cwd,
    status: connected ? (liveActive ? "running" : "connected") : "offline",
    connected,
  };
}

async function socketAvailable(slot: SlotId): Promise<boolean> {
  try {
    const stat = await fs.lstat(join(IPC_ROOT, `${slot}.sock`));
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

type IpcResponse = { status: number; body: string };

function ipcRequest(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: string,
  timeoutMs: number = 3000,
): Promise<IpcResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
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
    socket.setTimeout(timeoutMs, () =>
      finish(new Error("extension socket timeout")),
    );
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_IPC)
        return finish(new Error("extension response too large"));
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
  });
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
    theme: raw.theme ?? null,
    commands,
    messages,
    ...(typeof raw.pendingApproval === "number" &&
    Number.isFinite(raw.pendingApproval)
      ? { pendingApproval: Math.max(0, Math.min(100, raw.pendingApproval)) }
      : {}),
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
  slot: SlotId,
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

type ZellijPane = { paneId: string; tabId?: number };

async function zellijOutput(args: string[], limit: number): Promise<string> {
  const process = Bun.spawn(["zellij", "-s", ZELLIJ_SESSION, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => process.kill(), 3000);
  const reader = process.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        process.kill();
        throw new Error("zellij output too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
    clearTimeout(timeout);
  }
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`zellij action failed (${exitCode})`);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function paneForSlot(slot: SlotId): Promise<ZellijPane | undefined> {
  try {
    const value = JSON.parse(
      await zellijOutput(
        ["action", "list-panes", "--all", "--json"],
        256 * 1024,
      ),
    ) as unknown;
    if (!Array.isArray(value)) return undefined;
    const matches: ZellijPane[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const pane = item as Record<string, unknown>;
      const command =
        typeof pane.terminal_command === "string"
          ? pane.terminal_command
          : typeof pane.pane_command === "string"
            ? pane.pane_command
            : "";
      const id =
        typeof pane.id === "number" && Number.isInteger(pane.id) && pane.id >= 0
          ? pane.id
          : undefined;
      if (
        pane.is_plugin === true ||
        pane.exited === true ||
        pane.is_held === true ||
        id === undefined ||
        !command.endsWith(`omp-zellij-pane ${slot}`)
      )
        continue;
      matches.push({
        paneId: `terminal_${id}`,
        ...(typeof pane.tab_id === "number" ? { tabId: pane.tab_id } : {}),
      });
    }
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

async function terminalSnapshot(slot: SlotId): Promise<Response> {
  const state = await getSlotState(slot);
  if (!state.state)
    return errorResponse(503, state.error ?? "extension unavailable", {
      capabilities: { reconnect: true },
    });
  const pane = await paneForSlot(slot);
  if (!pane)
    return errorResponse(503, "Zellij pane is unavailable or ambiguous", {
      capabilities: { read: false, write: false, resize: false, focus: false },
    });
  try {
    // Visible viewport only: a full scrollback dump can exceed the cap on a
    // large pane, and the phone mirrors the live screen rather than history.
    const raw = await zellijOutput(
      ["action", "dump-screen", "--pane-id", pane.paneId],
      512 * 1024,
    );
    const screen = raw
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n");
    const snapshot: TerminalSnapshot = {
      apiVersion: API_VERSION,
      generation: state.state.generation,
      paneId: pane.paneId,
      ...(pane.tabId === undefined ? {} : { tabId: pane.tabId }),
      screen,
      capabilities: { read: true, write: false, resize: false, focus: false },
    };
    return json(snapshot);
  } catch (error) {
    return errorResponse(
      503,
      error instanceof Error ? error.message : "terminal unavailable",
      {
        capabilities: {
          read: false,
          write: false,
          resize: false,
          focus: false,
        },
      },
    );
  }
}

async function terminalAction(
  _slot: SlotId,
  _request: Request,
): Promise<Response> {
  return errorResponse(
    501,
    "Raw terminal input is disabled; use the guarded prompt and move actions",
  );
}

async function directoryListing(request: Request): Promise<Response> {
  const requested =
    new URL(request.url).searchParams.get("path") ?? WORKSPACE_ROOT;
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

function validSlot(value: string): value is SlotId {
  return (SLOT_IDS as readonly string[]).includes(value);
}

async function slotAction(slot: SlotId, request: Request): Promise<Response> {
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
  let stagedPane: ZellijPane | undefined;
  if (type === "prompt") {
    if (
      typeof body.text !== "string" ||
      body.text.length === 0 ||
      body.text.length > 100_000
    )
      return errorResponse(400, "prompt text is invalid");
  } else if (type === "abort") {
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
    const commandName = body.text.match(/^\/([^\s/]+)(?:\s|$)/)?.[1];
    const available = current.state.commands.some(
      (command) =>
        command.name === commandName ||
        command.aliases?.includes(commandName ?? ""),
    );
    if (!available) return errorResponse(404, "slash command is not available");
    stagedPane = await paneForSlot(slot);
    if (!stagedPane)
      return errorResponse(
        503,
        "Command requires an unambiguous live Zellij pane",
      );
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
    const inputPath = body.path.startsWith("/")
      ? body.path
      : join(WORKSPACE_ROOT, body.path);
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
    stagedPane = await paneForSlot(slot);
    if (!stagedPane)
      return errorResponse(
        503,
        "Move requires an unambiguous live Zellij pane",
      );
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
    if (
      (action.type === "move" || action.type === "command") &&
      stagedPane
    ) {
      const prepared = payload as Record<string, unknown> | null;
      const expectedCommand =
        action.type === "move" ? `/move ${action.path}` : action.text;
      if (
        !prepared ||
        prepared.ok !== true ||
        prepared.staged !== true ||
        prepared.generation !== generation ||
        prepared.command !== expectedCommand ||
        (action.type === "move" && prepared.path !== action.path)
      )
        return errorResponse(502, "Extension did not prepare the command");
      const [latest, pane] = await Promise.all([
        getSlotState(slot),
        paneForSlot(slot),
      ]);
      if (
        latest.state?.generation !== generation ||
        latest.state.agentActive ||
        latest.state.pendingApproval !== 0 ||
        !latest.state.editor?.available ||
        latest.state.editor.empty !== false ||
        pane?.paneId !== stagedPane.paneId
      )
        return errorResponse(
          409,
          "Session or pane changed; command was not submitted",
        );
      try {
        await zellijOutput(
          ["action", "write", "--pane-id", stagedPane.paneId, "13"],
          4096,
        );
      } catch {
        return errorResponse(
          503,
          "Command prepared but submission failed; inspect the desktop composer before retrying",
        );
      }
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
      !(SLOT_IDS as readonly string[]).includes(body.slot) ||
      typeof body.identity !== "string"
    )
      return errorResponse(400, "slot and identity are required");
    try {
      await service.ack(body.slot as NotificationSlot, body.identity);
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
    const response = await notificationsApi(request);
    for (const [key, value] of Object.entries(corsHeaders(request)))
      response.headers.set(key, value);
    return response;
  }

  if (request.method === "GET" && url.pathname === "/api/slots") {
    const response = json(
      {
        apiVersion: API_VERSION,
        slots: await Promise.all(SLOT_IDS.map(slotMetadata)),
      },
      200,
      corsHeaders(request),
    );
    return response;
  }
  const stateMatch = /^\/api\/slots\/([^/]+)\/state$/.exec(url.pathname);
  if (request.method === "GET" && stateMatch && validSlot(stateMatch[1])) {
    const result = await getSlotState(stateMatch[1]);
    if (!result.state) {
      const response = errorResponse(
        503,
        result.error ?? "extension unavailable",
        { capabilities: { reconnect: true } },
      );
      for (const [key, value] of Object.entries(corsHeaders(request)))
        response.headers.set(key, value);
      return response;
    }
    return json(result.state, 200, corsHeaders(request));
  }
  const terminalMatch = /^\/api\/slots\/([^/]+)\/terminal$/.exec(url.pathname);
  if (terminalMatch && validSlot(terminalMatch[1])) {
    const response =
      request.method === "GET"
        ? await terminalSnapshot(terminalMatch[1])
        : request.method === "POST"
          ? await terminalAction(terminalMatch[1], request)
          : errorResponse(405, "method not allowed");
    for (const [key, value] of Object.entries(corsHeaders(request)))
      response.headers.set(key, value);
    return response;
  }
  const actionMatch = /^\/api\/slots\/([^/]+)\/action$/.exec(url.pathname);
  if (request.method === "POST" && actionMatch && validSlot(actionMatch[1])) {
    const response = await slotAction(actionMatch[1], request);
    for (const [key, value] of Object.entries(corsHeaders(request)))
      response.headers.set(key, value);
    return response;
  }
  if (url.pathname === "/api/directories" && request.method === "GET") {
    const response = await directoryListing(request);
    for (const [key, value] of Object.entries(corsHeaders(request)))
      response.headers.set(key, value);
    return response;
  }
  if (
    url.pathname === "/api/pins" &&
    (request.method === "GET" || request.method === "PUT")
  ) {
    const response = await pinsResponse(request);
    for (const [key, value] of Object.entries(corsHeaders(request)))
      response.headers.set(key, value);
    return response;
  }
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
  const value =
    process.env.OMP_MOBILE_TOKEN ??
    (await fs.readFile(TOKEN_FILE, "utf8").catch(() => ""));
  mobileToken = value.trim();
  if (mobileToken.length < 16 || mobileToken.length > 512)
    throw new Error(`missing or invalid mobile token (${TOKEN_FILE})`);
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
  });
  notificationService.start();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    fetch: handle,
  });
  console.log(
    `omp-mobile listening on http://127.0.0.1:${server.port} (serve privately with: tailscale serve --bg ${server.port})`,
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
