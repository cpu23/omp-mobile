# Mobile guide

For the short setup steps, see the [README](../README.md).

Phone client for [omp](https://omp.sh) coding sessions: an installable PWA served by a small Bun gateway that runs
alongside the [omp-desktop](../../omp-desktop) daemon. The phone drives the **same live `omp` processes** the desktop
app shows — there is no second session pool.

- `server.ts` — gateway: serves the PWA, authenticates the phone, exposes the desktop daemon's live runtimes as
  `/api/slots`, relays prompts/actions and terminal snapshots, and sends Web Push notifications. Binds
  `127.0.0.1` only.
- `scripts/setup.ts` — first-run token creation (`bun run setup`): owner-only, idempotent, never overwrites.
- `extension.ts` — omp extension injected into each daemon runtime: reports session state (working / needs approval
  / done) over a per-runtime, owner-only socket, and serves `GET /status` for the desktop sidebar.
- `client.ts` — the PWA UI: unified session sidebar, new/resume/stop controls, transcript and raw terminal views,
  notifications.
- `notifications.ts` — Web Push (VAPID keys generated once, stored under the gateway state dir; never committed).
- `shared.ts` — wire types shared by server and client. Runtime ids (`rt-…`) are opaque, dynamic and validated
  everywhere they cross a process boundary.

## Requirements

- **Bun ≥ 1.3.0** (`engines` in `package.json`; install from <https://bun.sh>).
- **omp-desktop daemon** ([../omp-desktop](../../omp-desktop)) — it owns the live `omp` processes, the session store
  and the runtime API this gateway relays to. The daemon spawns the `omp` CLI (18.x) itself.
  On a first-time installation, run `omp` in a terminal and finish provider login first. A fresh home opens
  OMP's setup screen; Mobile can display it in raw view but cannot interact with that read-only terminal.
- A Unix host (Linux/macOS): the gateway and extension talk over unix sockets.
- For phone use, a private network path to the gateway with HTTPS (see [Remote access](#remote-access)).

`bun run start` itself needs only Bun and the token. Without the daemon the PWA shell, folder browser and pins
still load; live runtimes and the saved-session list answer `503 desktop daemon unavailable`.

## Quick start (fresh checkout)

```sh
bun install
bun run setup          # create the shared access token: 16-512 chars, mode 0600
bun run start          # gateway on http://127.0.0.1:4173
```

Then start the desktop daemon (in `../omp-desktop`: `bun install && bun run start`, port `4180`). Order does not
matter — the gateway reconnects to the daemon, and the daemon injects the extension into every session it spawns.
Set `OMP_MOBILE_DESKTOP_URL` only when the daemon runs on another loopback port.

Open <http://127.0.0.1:4173>: the **Access token** dialog opens because no token is saved yet — paste the one printed
by `bun run setup --show`. The key icon in the top bar appears whenever an API call answers `401`.

### Options

```sh
bun run check          # typecheck (tsc --noEmit)
bun test               # unit tests
bun run dev            # watch mode
```

With both sibling Git checkouts present, `bun run release:check` in `../omp-desktop` verifies fresh frozen-lockfile
installs of both projects, typechecks/tests, token setup/reuse, and a real shared-runtime start/state/stop.
It uses a disposable HOME, private token/socket paths and unused loopback ports, and never controls existing
OMP services. See [Desktop's release check](../../omp-desktop/docs/guide.md#fresh-install-release-check).

## Token and authentication

The gateway refuses to start without a token of 16-512 characters. Resolution order (extension sockets use the same
sources, plus an `OMP_MOBILE_IPC_TOKEN` forwarded by the daemon):

1. `OMP_MOBILE_TOKEN` environment variable;
2. `OMP_MOBILE_TOKEN_FILE`, default `~/.config/zellij/ompbox-mobile.token` — a historical location kept so existing
   installations and the desktop daemon keep working unchanged;
3. the default file above, when `OMP_MOBILE_TOKEN_FILE` is unset.

`bun run setup` creates a 256-bit random token at that default path with mode `0600`, creating the directory only if
missing. Re-running it reuses the existing value (and re-tightens the mode if it was widened); it never overwrites a
file that already holds a usable token, and exits with an error instead of guessing when the file exists but is too
short or too long. `--show` prints the current token for phone onboarding. Nothing prints the token during normal
operation.

The same token is used for two checks:

- **the phone**: every `/api/*` request must carry `Authorization: Bearer <token>`, compared in constant time;
  static PWA assets are served without auth because they contain no session data;
- **the extension sockets**: the gateway sends the token with every socket request, and each runtime's extension
  requires it when it was configured with one.

Share the token **before sessions start**. The daemon forwards its own token to spawned sessions
(`OMP_MOBILE_IPC_TOKEN`) and each extension also reads the token file directly when it starts, so:

- sessions started after the token file exists authenticate with it;
- a session that started with a **different** token rejects the phone until it is restarted;
- a session that started with **no** token at all still answers calls (its socket enforces owner-only access but no
  token) — restart it after creating the token to get the authenticated path.

To move the token out of the historical path, export the same `OMP_MOBILE_TOKEN_FILE` for **both** the gateway and
the desktop daemon (the daemon passes its environment on to sessions), and start the daemon after exporting it:

```sh
export OMP_MOBILE_TOKEN_FILE="$HOME/.config/omp-mobile/token"
bun run setup          # writes to the exported path
```

Rotating the token therefore means: stop the daemon and gateway, replace the file (delete it and re-run
`bun run setup`, or edit it), then start both again so no live session keeps an old value.

## Remote access

The gateway always binds `127.0.0.1`; it has no TLS and a single shared bearer token, so it must not be exposed
directly to a network. Reach it through something that provides HTTPS:

- **Tailscale**: `tailscale serve --bg 4173` maps the loopback port onto `https://<machine>.<tailnet>.ts.net`.
  Service workers, PWA install and Web Push require a secure context, so HTTPS is required for phone use; plain
  `http://<lan-ip>:4173` can render the UI but cannot install or notify. The gateway logs this exact command on
  startup.
- **SSH tunnel** for a laptop browser: `ssh -L 4173:127.0.0.1:4173 host`, then open `http://127.0.0.1:4173` on the
  machine holding the tunnel. For a USB-connected Android phone, `adb reverse tcp:4173 tcp:4173` maps the gateway
  to `http://localhost:4173` on the device — `localhost` is a secure context, so PWA install and notifications work
  there too.

The origin fence accepts same-origin requests, the browser origin computed from `X-Forwarded-Proto` + `Host`
(what `tailscale serve` and simple reverse proxies preserve), and any origin listed in the comma-separated
`OMP_MOBILE_ORIGINS`. Add your public origin there only if a proxy rewrites the `Host` header. Mutations
(`POST`/`PUT`/`DELETE`) additionally require an `Origin` header, which browsers always send. HTTPS protects the
transport; it does not replace the token — anyone who can reach the URL still has to authenticate.

## Phone onboarding and PWA behavior

1. Open the HTTPS URL. With no token saved the app opens the **Access token** dialog on first load; the sidebar also
   shows `access token required` and a key icon appears in the top bar (any later `401` reveals it again).
2. Paste the token from `bun run setup --show` and save. It is kept in the browser's `localStorage` for that origin
   (a temporary `sessionStorage` copy is migrated on load); it is never put in a URL.
3. Install the PWA when prompted (Android Chrome) or via Share → Add to Home Screen (iOS, 16.4+ for push).
4. Enable notifications with the bell; the gateway exposes its public VAPID key to the page.

Notification constraints come from the platforms, not the app: an HTTPS origin and service-worker support are
required; iOS delivers Web Push only to home-screen PWAs; Brave blocks notification prompts for unvisited sites
until allowed in Site settings; browsers without Google Play services cannot reach the push service (the app says so
and unread badges still work while it is open). Completions are detected per runtime by the gateway polling the
extension socket; the phone acknowledges each one (`POST /api/notifications/ack`), and tapping a notification opens
`?slot=<runtime id>` directly.

## How it fits together

Live sessions in the sidebar are the desktop daemon's runtimes; starting, resuming and stopping map to its runtime
API. Historical sessions come from omp's own session store (`~/.omp/agent/sessions`, listed by the daemon);
completion notifications are polled from each runtime's extension socket. The daemon injects this repo's
`extension.ts` into every session it spawns (unless its own `OMP_DESKTOP_EXTENSION` disables it) together with
`OMP_MOBILE_SLOT=<runtime id>`; without the extension the phone degrades to terminal-only views, and transcript,
model and capability data are reported as `extension unavailable` rather than guessed.

Terminal snapshots replay the desktop PTY stream through xterm's headless buffer; viewing them does not resize the
desktop terminal. The phone mirrors sessions, not the desktop's pane layout.

Session accents match OMP 18's CLI exactly: `session-accent.ts` mirrors the host's OKLCH algorithm using the frozen
`theme.sessionAccentInputs` token. Compiled host internals cannot be imported by extensions, so parity vectors must
be checked when upgrading OMP. Missing tokens or unnamed sessions yield no accent (the UI uses gray), rather than a
guessed hue.

## Session sidebar and composer

The sidebar mirrors desktop discovery: live runtimes appear first, followed by recent transcripts, with running
transcripts shown only once. Selecting a historical row resumes it through the desktop daemon; selecting a live row
opens that same runtime. There is no separate “Saved sessions” browser; stored transcripts are not deleted.

Like desktop, the recent list requests 60 sessions. Sidebar search queries the daemon's session store, so older
sessions remain reachable beyond that recent window. The list scrolls independently of the sidebar actions.

Opening, dragging or closing the reasoning-effort popover while typing preserves composer focus, keeping the
software keyboard open. When the composer is not focused, the slider retains native pointer and keyboard controls.

The extension also exposes owner-only `GET /status` on each runtime socket for Desktop's sidebar:
`{accent, agentActive, completion?}` with the same token/origin checks as `GET /state`. It excludes transcript,
model, and command enumeration, so polling long chats stays small. Desktop uses these authoritative fields
for matching session colors, Working animation, and Done badges without depending on this HTTP gateway.
Update the extension alongside Desktop; existing extension instances load the new endpoint when their
OMP processes next start.

## API used by the PWA

| Route | Purpose |
| --- | --- |
| `GET /api/slots` | Live runtimes (`{slots: [{id, title, cwd, status, connected, sessionFile?}]}`). |
| `POST /api/slots` | Start a runtime (optional `{cwd}` inside `OMP_MOBILE_ROOT`) or resume a saved one (`{resume: <session path>}`). |
| `DELETE /api/slots/:id` | Stop that runtime in the desktop daemon. |
| `GET /api/slots/:id/state` | Structured session state (model, effort, transcript, capabilities). |
| `POST /api/slots/:id/action` | Prompt / abort / model / effort / command / move (generation-guarded). |
| `GET /api/slots/:id/terminal` | Read-only terminal snapshot of the pane. |
| `GET /api/sessions` | Saved sessions from omp's store (id, path, cwd, title, updatedAt, costUsd). |
| `/api/notifications*` | Push config, status, subscriptions and per-runtime acknowledgement. |
| `/api/directories`, `/api/pins` | Folder explorer and pinned working directories. |

All `/api/*` routes require the bearer token; mutations additionally require an `Origin` header.

## Environment variables

Gateway (`server.ts`) and process-shared values:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_MOBILE_TOKEN` | unset | token from the environment; wins over any file (16-512 chars). |
| `OMP_MOBILE_TOKEN_FILE` | `~/.config/zellij/ompbox-mobile.token` | token file (historical default kept for compatibility). |
| `OMP_MOBILE_PORT` | `4173` | gateway port; always bound to `127.0.0.1`. |
| `OMP_MOBILE_DESKTOP_URL` | `http://127.0.0.1:4180` | desktop daemon base URL; must be a loopback `http://` origin without credentials or path. |
| `OMP_MOBILE_IPC_DIR` | `~/.local/state/omp-mobile` | per-runtime extension sockets (`<rt-id>.sock`) and notification state. |
| `OMP_MOBILE_ROOT` | `$HOME` | root for the folder explorer, pins and new-session `cwd`; dot-directories are always excluded. |
| `OMP_DESKTOP_SESSIONS_DIR` | `~/.omp/agent/sessions` | root used to validate resume paths (`{resume}` must resolve inside it); the saved-session list itself comes from the daemon. |
| `OMP_MOBILE_ORIGINS` | unset | comma-separated extra origins allowed by the origin fence. |

Notifications (`notifications.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_MOBILE_VAPID_SUBJECT` | `mailto:omp-mobile@localhost` | VAPID subject sent to push services. |
| `OMP_MOBILE_VAPID_PUBLIC_KEY` / `OMP_MOBILE_VAPID_PRIVATE_KEY` | generated once at `<state dir>/notifications.json.vapid` (mode 0600) | set **both** to use externally managed VAPID keys; setting only one disables push. |

Extension (`extension.ts`; the daemon sets these for each session):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_MOBILE_SLOT` | — | runtime id (`rt-…`) that names the socket; set by the daemon. |
| `OMP_MOBILE_STATE_DIR` | `~/.local/state/omp-mobile` | directory for `<rt-id>.sock`; the daemon sets it to `OMP_MOBILE_IPC_DIR`. |
| `OMP_MOBILE_IPC_TOKEN` | — | token the extension requires on socket calls; the daemon forwards its token. |
| `OMP_MOBILE_TOKEN` / `OMP_MOBILE_TOKEN_FILE` | token file above | used by the extension when no IPC token was forwarded. |
| `OMP_MOBILE_ORIGIN` | unset | optional single `Origin` accepted on socket requests. |

## Security notes

- The gateway binds loopback only, and the daemon URL is forced to loopback because the daemon has no
  authentication of its own — a phone-reachable daemon address would let anyone on the network control PTYs.
- Every API call needs the shared bearer token (constant-time compare); extension sockets are additionally `0600`,
  owner-checked, and token-checked when configured.
- The token lives in the phone's `localStorage` for the HTTPS origin. Anyone with the unlocked phone can drive the
  sessions that origin can reach; rotate by replacing the token and restarting gateway, daemon and sessions.
- The folder browser, pins and new-session `cwd` are confined to `OMP_MOBILE_ROOT`, dot-directories (`.ssh`,
  `.config`, `.omp`) are never listed or usable, and resume paths must resolve inside the session store.
- Terminal access is read-only snapshots; prompts and control actions go through the same runtime API the desktop
  uses, so the daemon stays the source of truth.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `omp-mobile failed to start: missing or invalid mobile token …` | Run `bun run setup` (or export `OMP_MOBILE_TOKEN`/`OMP_MOBILE_TOKEN_FILE`). |
| `OMP_MOBILE_TOKEN must be 16-512 characters` | The environment value was set but is empty/too short; fix or unset it. |
| First load shows `access token required`, key icon, empty sidebar | Paste the token (key icon) — the gateway is reachable but the phone is not authenticated. |
| `access token rejected` after working earlier | Token rotated: restart the gateway **and** the daemon, then restart affected sessions. |
| Sidebar empty, `desktop daemon unavailable` | Start the daemon, or point `OMP_MOBILE_DESKTOP_URL` at its loopback port. |
| `extension unavailable` / no transcript or model for a session | The session started with a different token, or `OMP_MOBILE_IPC_DIR` differs between daemon and gateway; align both and restart the session. |
| `403 origin not allowed` | Access the gateway through the origin you loaded (or list it in `OMP_MOBILE_ORIGINS`); `curl` mutations need `-H 'Origin: …'`. |
| `403 path is outside the workspace` / `hidden directories are not browsable` | Expected: browsing is confined to `OMP_MOBILE_ROOT` and dot-directories. |
| PWA won't install, notifications `unsupported`/blocked | Use HTTPS (e.g. `tailscale serve`), install the PWA, and allow notifications for that origin. |
| Push enabled but never arrives | Push is per runtime completion; ensure sessions are running with the extension, and see the platform constraints above. |

## License

MIT — see [LICENSE](../LICENSE). Third-party assets bundled in `public/`: the DejaVu Sans Mono font
(`public/fonts/DejaVuSansMono.ttf`) ships under the Bitstream Vera / Arev license, reproduced in
[`public/fonts/LICENSE-DejaVu.txt`](../public/fonts/LICENSE-DejaVu.txt); dependencies keep their own licenses.

Historical design records live with the desktop daemon in [../omp-desktop/docs](../../omp-desktop/docs); see
[docs/README.md](README.md).
