# Mobile guide

For the short install steps, see the [README](../README.md). This guide covers the gateway, desktop-daemon integration,
security, configuration and operational details.

## Requirements and service relationship

- Bun ≥ 1.3 and a Unix host (Linux/macOS).
- The [OMP Desktop daemon](https://github.com/cpu23/omp-desktop), which owns live OMP processes and the session store,
  and spawns the OMP 18.x CLI. On a fresh home, run `omp` once and finish provider setup; Mobile can display OMP's
  first-run setup screen in raw view but cannot interact with its read-only terminal.
- A current phone browser. Use HTTPS for remote access, PWA installation and push notifications.

The gateway serves the PWA on `127.0.0.1:4173` and relays to the daemon at `127.0.0.1:4180` by default. Without the
daemon, the app shell, folder browser and pins work, but live and saved sessions return `503 desktop daemon unavailable`.
Live rows are daemon runtimes; historical rows are OMP transcripts and resume through the daemon. The daemon injects
this project's extension into spawned sessions. Its owner-only `/status` endpoint also feeds Desktop's sidebar;
extension changes reach existing sessions after their OMP process restarts. Without the extension, Mobile has
terminal-only views and reports transcript, model and capability data as unavailable. Terminal snapshots are
read-only and do not resize the desktop PTY.

OMP `ask` prompts appear inline with their question text, options, descriptions, selection mode and recommended option.
Pending prompts are read-only in Mobile: ask dialogs are owned by the desktop terminal, and Mobile has no remote
answer API. Answer there; after the tool finishes, Mobile shows the terminal's recorded selections and any custom
answers or notes. Restart an affected OMP session for this extension change to take effect.

While OMP is busy, Mobile sends ordinary text through the steering path and shows its queued text until OMP starts it.
If the same Send action is tapped again before its first submission resolves, Mobile coalesces the duplicate and, when
the session was busy, forces the queue only after the first submission succeeds. Once OMP reports pending messages and
the session is active, an empty composer changes **Send** to **Force**; tapping it (or submitting empty Enter)
interrupts the current run so OMP drains the pending queue, matching desktop's empty-Enter behavior. OMP's public
extension API exposes queue availability but not desktop-origin queued text, so those items appear as a generic notice.
Restart the affected session for this extension update to take effect.

Working sessions show a spinner beside a shimmering sidebar title, without a separate “Working…” label.
Live tool and Thinking indicators, the composer model label, and the effort slider's value and fill use the active session's accent.
The effort button retains its effort-level color. The slider offers explicit effort levels only, excluding `inherit`.
Use the floating circular gear button at the bottom of the sidebar for terminal view, reasoning visibility, notifications and access-token settings.
The gear overlays the session list; bottom scroll padding lets the last card move clear of it.
Use the back-arrow icon (or Escape) to return to sessions; these controls no longer occupy the sessions footer or top bar.
Connected sessions have no status label; offline and unread indicators remain visible.
The chat viewport shrinks above the software keyboard and composer. When already near the bottom,
the latest messages stay in view as the keyboard opens or closes.
On phone-sized screens, swipe right across the chat to open the sidebar, and left across the sidebar to close it.
The drawer responds during the swipe. Closing swipes can start on sidebar buttons without activating them;
ordinary taps still work. Vertical scrolling, selected text and text inputs do not trigger closing.
Opening swipes also leave controls and code blocks alone; the menu button remains available.

## Install and start

From this repository:

```sh
bun install
bun run setup          # create the shared access token
bun run start          # http://127.0.0.1:4173
```

Start the daemon in `../omp-desktop` with `bun install && bun run start`. Either service may start first; they reconnect,
and the daemon injects the extension into each session it spawns. Open the gateway URL and enter the token printed by
`bun run setup --show`. **Settings → Access token** reopens token entry at any time.

`bun run dev` runs watch mode; `bun run check` typechecks and `bun test` runs unit tests. With both sibling checkouts
present, `bun run release:check` in `../omp-desktop` tests fresh installs, token setup/reuse and a shared-runtime start,
state and stop using a disposable HOME, private paths and unused loopback ports. It does not control existing OMP
services. See [Desktop's release check](../../omp-desktop/docs/guide.md#checks).

## Token and authentication

The gateway requires a 16–512-character token. It reads `OMP_MOBILE_TOKEN` first, then `OMP_MOBILE_TOKEN_FILE`
(default `~/.config/zellij/ompbox-mobile.token`, a historical path retained for existing installs). `bun run setup`
creates a random 256-bit token there with mode `0600`; it reuses a valid existing token and tightens its permissions,
but errors rather than replacing an invalid file. `bun run setup --show` prints the token; normal operation does not.

Every `/api/*` request requires `Authorization: Bearer <token>` (constant-time comparison); static PWA assets are
public. Extension socket requests use the same token when configured. Share it before starting sessions: the daemon
forwards its token to spawned sessions and the extension also reads the token file at startup. A session started with
a different token rejects requests; one started without a token permits owner-only socket access without token
authentication. Restart affected sessions after setting or changing the token.

To use a different token path, export it for both gateway and daemon before starting them:

```sh
export OMP_MOBILE_TOKEN_FILE="$HOME/.config/omp-mobile/token"
bun run setup
```

To rotate a token, stop gateway and daemon, replace the token (delete the file and rerun setup, or edit it), then restart
both and their sessions so none retain the old value.

## Remote access

The gateway has no TLS and binds only to loopback; do not expose it or the unauthenticated desktop daemon directly to
a network. Use an HTTPS proxy for phone access. For a private Tailscale connection:

```sh
tailscale serve --bg 4173
```

Open the HTTPS URL Tailscale prints. HTTPS is required for service workers, installation and Web Push; plain LAN HTTP
can render the UI only. A laptop can use `ssh -L 4173:127.0.0.1:4173 host` and open `http://127.0.0.1:4173` on the
tunnel endpoint. For a USB-connected Android phone, `adb reverse tcp:4173 tcp:4173` exposes it at
`http://localhost:4173` (localhost is a secure context).

The origin fence allows same-origin requests and the browser origin derived from `X-Forwarded-Proto` plus `Host`
(preserved by Tailscale Serve and simple proxies). If a proxy rewrites `Host`, list its origin in the comma-separated
`OMP_MOBILE_ORIGINS`. Mutating requests also require a browser `Origin` header. HTTPS protects transport; it does not
replace the bearer token.

## Phone setup and notifications

Enter the setup token in the app's access dialog. It is stored in `localStorage` for that origin, never in a URL.
Install through the browser prompt or Share → Add to Home Screen (iOS Web Push requires iOS 16.4+ and a home-screen
PWA). Enable notifications with the bell.

Notifications require HTTPS and service-worker support. Brave may require allowing prompts in Site settings, and
browsers without Google Play services cannot reach the push service; unread badges still update while the app is open.
The gateway checks each runtime's compact extension `/status` endpoint every three seconds, rather than downloading
transcripts. Acknowledging a completion is per runtime; tapping its notification opens that runtime directly.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/slots` | Live runtimes (`id`, title, cwd, status, `connected` and optional session file). |
| `POST /api/slots` | Start in optional `cwd` under `OMP_MOBILE_ROOT`, or resume a saved session with `{resume: <path>}`. |
| `DELETE /api/slots/:id` | Stop a daemon runtime. |
| `GET /api/slots/:id/state` | Structured session state (model, effort, transcript, capabilities). |
| `POST /api/slots/:id/action` | Prompt, abort, model, effort, command or move; generation-guarded. |
| `GET /api/slots/:id/terminal` | Read-only terminal snapshot. |
| `GET /api/sessions` | Saved OMP sessions (id, path, cwd, title, update time and cost). |
| `/api/notifications*` | Push configuration, status, subscriptions and per-runtime acknowledgement. |
| `/api/directories`, `/api/pins` | Folder explorer and pinned working directories. |

All API routes require the bearer token; mutations additionally require `Origin`.

## Environment variables

Gateway (`server.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_MOBILE_TOKEN` | unset | Token value; takes precedence over the token file (16–512 chars). |
| `OMP_MOBILE_TOKEN_FILE` | `~/.config/zellij/ompbox-mobile.token` | Token file; historical default retained for compatibility. |
| `OMP_MOBILE_PORT` | `4173` | Gateway port; always binds to `127.0.0.1`. |
| `OMP_MOBILE_DESKTOP_URL` | `http://127.0.0.1:4180` | Daemon URL; must be a loopback HTTP origin without credentials or path. |
| `OMP_MOBILE_IPC_DIR` | `~/.local/state/omp-mobile` | Per-runtime sockets and notification state. |
| `OMP_MOBILE_ROOT` | `$HOME` | Folder browser, pins and new-session working-directory root; dot-directories are excluded. |
| `OMP_DESKTOP_SESSIONS_DIR` | `~/.omp/agent/sessions` | Allowed resume-path root; saved-session listing comes from the daemon. |
| `OMP_MOBILE_ORIGINS` | unset | Comma-separated additional allowed origins. |

Notifications (`notifications.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_MOBILE_VAPID_SUBJECT` | `mailto:omp-mobile@localhost` | Subject sent to push services. |
| `OMP_MOBILE_VAPID_PUBLIC_KEY`, `OMP_MOBILE_VAPID_PRIVATE_KEY` | Generated at `<state dir>/notifications.json.vapid` (mode `0600`). | Set both to use managed keys; setting only one disables push. |

Extension (`extension.ts`; daemon sets values for each session):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_MOBILE_SLOT` | — | Runtime ID (`rt-…`) used to name the socket. |
| `OMP_MOBILE_STATE_DIR` | `~/.local/state/omp-mobile` | Socket directory; daemon sets it to `OMP_MOBILE_IPC_DIR`. |
| `OMP_MOBILE_IPC_TOKEN` | — | Socket token forwarded by the daemon. |
| `OMP_MOBILE_TOKEN`, `OMP_MOBILE_TOKEN_FILE` | Token file above | Fallback token sources when no IPC token is forwarded. |
| `OMP_MOBILE_ORIGIN` | unset | Optional single origin accepted on socket requests. |

## Security and troubleshooting

- The gateway binds to loopback and accepts only a loopback daemon URL; the daemon itself has no authentication.
- Runtime sockets are owner-only (`0600`) and owner-checked; when configured, socket requests also require the token.
- Anyone with access to the unlocked phone and stored token can control reachable sessions.
- Browsing, pins and new-session working directories are confined to `OMP_MOBILE_ROOT`; dot-directories (including
  `.ssh`, `.config` and `.omp`) are excluded. Resume paths must stay inside the session store.
- The phone receives read-only terminal snapshots; control actions pass through the daemon's runtime API.

| Symptom | Cause / fix |
| --- | --- |
| `omp-mobile failed to start: missing or invalid mobile token …` | Run `bun run setup` or set `OMP_MOBILE_TOKEN` / `OMP_MOBILE_TOKEN_FILE`. |
| `OMP_MOBILE_TOKEN must be 16-512 characters` | Fix or unset the environment value. |
| `access token required`, empty sidebar | Open Settings → Access token; the gateway is reachable but this browser is unauthenticated. |
| `access token rejected` after working earlier | Token changed: restart gateway, daemon and affected sessions. |
| Empty sidebar / `desktop daemon unavailable` | Start daemon or set `OMP_MOBILE_DESKTOP_URL` to its loopback port. |
| `extension unavailable` / no transcript or model | Align token and `OMP_MOBILE_IPC_DIR` between daemon and gateway; restart the session. |
| `403 origin not allowed` | Use the loaded origin or set `OMP_MOBILE_ORIGINS`; `curl` mutations need `-H 'Origin: …'`. |
| Workspace or hidden-directory `403` | Expected confinement to `OMP_MOBILE_ROOT` and exclusion of dot-directories. |
| Install unavailable / notifications blocked | Use HTTPS, install the PWA and allow notifications for that origin. |
| Push never arrives | Ensure the runtime has the extension; see platform limits above. |

## License

MIT — see [LICENSE](../LICENSE). The bundled DejaVu Sans Mono font is under the Bitstream Vera / Arev license
([font license](../public/fonts/LICENSE-DejaVu.txt)); dependencies retain their own licenses.
