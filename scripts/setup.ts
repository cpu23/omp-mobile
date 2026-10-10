#!/usr/bin/env bun
/**
 * First-run setup for the mobile gateway.
 *
 * `bun run start` refuses to serve without a shared access token of 16-512
 * characters, and omp-desktop reads the same token for the per-runtime
 * extension sockets. This script creates one at the legacy default path
 * (kept so the gateway, the daemon and every spawned omp process agree
 * without extra environment), with owner-only permissions, and never
 * overwrites an existing value.
 *
 * Usage:
 *   bun run setup            create the token if missing; reuse it if present
 *   bun run setup --show     print the current token (for phone onboarding)
 *   bun run setup --help
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MIN_LENGTH = 16;
const MAX_LENGTH = 512;
const HOME = process.env.HOME?.trim() || homedir();
const DEFAULT_TOKEN_FILE = join(HOME, ".config/zellij/ompbox-mobile.token");
const TOKEN_FILE = process.env.OMP_MOBILE_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
const PORT = process.env.OMP_MOBILE_PORT?.trim() || "4173";
const ONBOARDING_HINT =
  "  Show it for phone onboarding:  bun run setup --show";

const HELP = `omp-mobile token setup

Creates the shared access token required by \`bun run start\`.
The token file is written with mode 0600; an existing file is reused, never
overwritten.

Usage:
  bun run setup            create the token if missing, reuse it if present
  bun run setup --show     print the current token for phone onboarding
  bun run setup --help     this help

Paths (checked in this order):
  OMP_MOBILE_TOKEN         environment value used by the gateway
  OMP_MOBILE_TOKEN_FILE    override for the file below
  ${DEFAULT_TOKEN_FILE}
`;

function fail(message: string): never {
  console.error(`omp-mobile setup: ${message}`);
  process.exit(1);
}

/** Names the configured path; callers always describe the same precedence. */
function describe(): string {
  return TOKEN_FILE === DEFAULT_TOKEN_FILE
    ? TOKEN_FILE
    : `${TOKEN_FILE} (from OMP_MOBILE_TOKEN_FILE)`;
}

/** Owner-only permissions are part of the contract, not an afterthought. */
async function ensureOwnerOnly(path: string): Promise<string | undefined> {
  const stat = await fs.stat(path);
  if ((stat.mode & 0o077) === 0) return undefined;
  await fs.chmod(path, 0o600);
  return `omp-mobile setup: tightened ${path} from ${(stat.mode & 0o777)
    .toString(8)
    .padStart(3, "0")} to 600`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter(
    (arg) => arg !== "--show" && arg !== "--help" && arg !== "-h",
  );
  if (unknown.length > 0)
    fail(`unknown argument ${unknown.join(" ")} (see \`bun run setup --help\`)`);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  const show = args.includes("--show");

  const envToken = process.env.OMP_MOBILE_TOKEN;
  if (envToken !== undefined) {
    const value = envToken.trim();
    if (value.length < MIN_LENGTH || value.length > MAX_LENGTH)
      fail(
        `OMP_MOBILE_TOKEN is set but must be ${MIN_LENGTH}-${MAX_LENGTH} characters (got ${value.length}); fix or unset it, then re-run \`bun run setup\``,
      );
    if (show) console.log(value);
    else
      console.log(
        [
          "Token: OMP_MOBILE_TOKEN (environment; no file written).",
          "The daemon forwards it to spawned sessions, so the gateway and the",
          "extension sockets stay in sync as long as every process inherits it.",
          ONBOARDING_HINT,
        ].join("\n"),
      );
    return;
  }

  const existing = await fs.readFile(TOKEN_FILE, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) {
    const value = existing.trim();
    if (value.length < MIN_LENGTH || value.length > MAX_LENGTH)
      fail(
        `${describe()} exists but is not a usable token (${value.length} characters); refusing to overwrite it. Delete that file (or point OMP_MOBILE_TOKEN_FILE at a new path), then re-run \`bun run setup\``,
      );
    const note = await ensureOwnerOnly(TOKEN_FILE);
    if (note) console.log(note);
    if (show) console.log(value);
    else
      console.log(
        `Token: reused ${describe()} (mode 0600).\n${ONBOARDING_HINT}`,
      );
    return;
  }

  if (show)
    fail(
      `no token configured yet (${describe()} does not exist); run \`bun run setup\` first`,
    );

  const token = randomBytes(32).toString("base64url");
  await fs.mkdir(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${TOKEN_FILE}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    await fs.chmod(temporary, 0o600);
    // Publish without replacement: concurrent setup must never rotate a token.
    await fs.link(temporary, TOKEN_FILE);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  console.log(
    [
      `Token: created ${describe()} (mode 0600).`,
      "It is shared by the gateway, the omp-desktop daemon and the per-runtime",
      "extension sockets; sessions started after this file exists pick it up",
      "automatically, sessions already running keep their state until restarted.",
      ONBOARDING_HINT,
      "",
      "Next:",
      "  Start the gateway:         bun run start",
      "  Start the desktop daemon:  bun run start   (in ../omp-desktop)",
      `  Open locally:              http://127.0.0.1:${PORT}`,
      `  Serve to a phone:          tailscale serve --bg ${PORT}   (HTTPS is required`,
      "                             for PWA install and push notifications)",
    ].join("\n"),
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
