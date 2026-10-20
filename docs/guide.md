# Mobile guide

For the short install steps, see the [README](../README.md). This guide covers the gateway, desktop-daemon integration,
security, configuration and operational details.

Screenshots: [session and composer](screenshots/chat.png) · [to-do drawer](screenshots/todos.png) · [sidebar settings](screenshots/settings.png).
Captured from disposable sessions at 1290 × 2796 pixels (430 × 932 CSS pixels, 3× scale). The full-screen to-do capture shows an active task and two pending tasks.

## Requirements and service relationship

- Bun ≥ 1.3.14 and a Unix host (Linux/macOS).
- The [OMP Desktop daemon](https://github.com/cpu23/omp-desktop), which owns live OMP processes and the session store,
  and spawns the OMP 18.x CLI. Structured UI coverage is verified against OMP 18.12.1. On a fresh home, run `omp` once
  and finish provider setup; Mobile also exposes deliberate terminal controls for host-owned setup screens.
- A current phone browser. Use HTTPS for remote access, PWA installation and push notifications.

The gateway serves the PWA on `127.0.0.1:4173` and relays to the daemon at `127.0.0.1:4180` by default. Without the
daemon, the app shell, folder browser and pins work, but live and saved sessions return `503 desktop daemon unavailable`.
Live rows are daemon runtimes; historical rows are OMP transcripts and resume through the daemon. The daemon injects
this project's extension into spawned sessions. Its owner-only `/status` endpoint also feeds Desktop's sidebar;
extension changes reach existing sessions after their OMP process restarts. Without the extension, Mobile has
terminal-only views and reports transcript, model and capability data as unavailable. Viewing the terminal does not
resize the desktop PTY. Its live controls send only the key or text you explicitly choose.

OMP `ask` prompts appear inline with question text, options, descriptions, selection mode and recommended options.
Pending prompts create an **Action needed** session badge and an answer card. Tap a radio option for single-choice
questions or checkboxes for multi-select, then select **Submit answers**. Every question also offers **Other** with
a custom text field; multi-select answers can combine options and custom text. Unsubmitted choices survive state
refreshes, and controls are disabled while submitting. **Cancel** stops the pending ask.
The extension delegates to OMP's native AskTool while also accepting explicit mobile answers: whichever surface
finishes first closes the other, without answering twice. Desktop dialogs, timeouts and desktop image answers retain
their native behavior. Oversized or incomplete question metadata remains terminal-owned rather than permitting
answers to unseen choices; use **Live terminal controls** for those prompts.
After completion, the transcript shows recorded selections, custom answers and notes. Restart affected OMP sessions
after updating the extension so they receive the new answer bridge.

While OMP is busy, Mobile sends ordinary text through the steering path and shows its queued text until OMP starts it.
If the same Send action is tapped again before its first submission resolves, Mobile coalesces the duplicate and, when
the session was busy, forces the queue only after the first submission succeeds. Once OMP reports pending messages and
the session is active, an empty composer changes the circular upward-arrow **Send** button to a lightning-bolt **Force** icon; tapping it (or submitting empty Enter)
interrupts the current run so OMP drains the pending queue, matching desktop's empty-Enter behavior. OMP's public
extension API may expose queue availability without desktop-origin text; those items show only **Queued**. A single queue card prefers host queue text when available, otherwise mobile-submitted text, with **Submitting** before confirmation. It does not repeat help or API-limitation notices.
Restart the affected session for this extension update to take effect.
Pending dialogs keep their instructions in the interaction card rather than repeating them below the composer.
Terminal-owned option cards are read-only, but their **Terminal** action opens deliberate live controls; unavailable
native plan choices use the same action. The ordinary composer is disabled while a dialog is awaiting a response.

Typing `/move` in the composer opens a directory picker instead of sending the command. Choices are listed as you type: absolute paths are used as-is, relative paths resolve from the session's working directory, `~` expands to the gateway user's home (still confined to `OMP_MOBILE_ROOT`), and a trailing slash (or selecting a folder) lists its subdirectories. Tapping a folder fills `/move <path>`; use the send button (or Enter) to move. Up/Down and Tab work with hardware keyboards, and Escape dismisses the list without affecting other slash commands. Every listing is tied to the session and working directory it was resolved against: switching sessions, resuming another transcript, or a session whose cwd changed (`cd` in the desktop terminal, or a completed move) discards the cached picker, and a listing that arrives after such a change is ignored, so a destination from another working directory is never offered or submitted.

While a session works, the composer shows the host's descriptive tool intent (for example “Trading installed graphics configuration”)
with the spinner and shimmer, falling back to “Working…” only when the host exposes no intent for the current turn.
Todos, subagents and background jobs share one compact, closed-by-default drawer attached flush to the composer, with the same surface and no drawer or pull-tab outline. When closed, only a rounded gray-arrow tab, 95% of the composer width and 14px tall, remains behind the composer's top edge: no counts or separate Details control. The entire top strip is tappable in both states, not just the arrow or label. Tap it, pull up to open, or pull down to close. All drawer content shares one capped, scrollable area. Todos keep only the last finished task plus unfinished tasks and use square checkbox markers (accented for the current task). Phase headings retain their Roman numeral positions, including when earlier phases disappear. Unstarted phases are collapsed; tap a phase heading to expand it.
The composer's top corners stay rounded whether the drawer is open or closed, matching the accent/context track. The open drawer surface extends behind those curves so no page-background gaps appear at the junction.
The drawer includes blocked-task notes and follows both todo sources in the branch:
`todo` tool results and the user todo edits the host records as `user_todo_edit` custom entries, so a list changed from
the desktop terminal (or cleared back to empty) shows the same way. Opening the drawer also shows desktop-style
per-agent rows (id, agent type, status, spawn description, current activity, tool/request/token/context/cost/duration/model,
retry notes and terminal errors) and running or recently
finished, failed or cancelled background jobs. `task` tool cards in the transcript carry the same subagent count and rows, so they
are distinct from ordinary wait/tool calls. Activity is rebuilt for the selected runtime and generation on every refresh;
switching sessions drops expanded details and never carries another session's agents, jobs or todos. Todo, subagent and
job rows are display-only. Core approvals can be answered through the live terminal controls; per-agent cancellation
and coordination still use OMP commands or its terminal rather than drawer-row actions.
The Subagents section inside the open drawer is independently collapsible and defaults to collapsed. Its expansion survives activity refreshes; closing the drawer resets it. The heading omits the running label when none are running.
Subagent rows use the host's task results and process-global agent registry; a host build without the registry export
still shows persisted task results, but detached progress may lag until the next refresh.

Working sessions show a spinner beside a shimmering sidebar title, without a separate “Working…” label.
Live tool and Thinking indicators, the composer model label, and the effort slider's value and fill use the active session's accent.
The effort button retains its effort-level color. The slider offers explicit effort levels only, excluding `inherit`.
Use the floating circular gear button at the bottom of the sidebar for terminal view, reasoning visibility, notifications, access-token settings and **Max sessions**.
**Max sessions** edits the desktop daemon's persisted limit, shared by mobile and desktop (default: 16). Enter a positive whole number and select **Save session limit**. The panel shows both the saved and currently enforced limits. When they differ, select **Restart daemon to apply** and confirm. Restarting the shared daemon stops running work in both desktop and mobile; sessions reopen from their saved transcripts, but execution does not continue. Wait until work finishes before restarting. Saving below the number of live sessions is rejected by the daemon; stop sessions first or choose a higher limit. This requires a desktop daemon supporting `/api/settings` and `/api/restart`.
The gear overlays the session list; bottom scroll padding lets the last card move clear of it.
Use the back-arrow icon (or Escape) to return to sessions; these controls no longer occupy the sessions footer or top bar.
Dialogs overlay the sidebar without closing it, so stopping a session or cancelling its confirmation leaves the session list open.
Connected sessions have no status label; offline and unread indicators remain visible.
The chat viewport shrinks above the software keyboard and composer. When already near the bottom,
the latest messages stay in view as the keyboard opens or closes.
On phone-sized screens, swipe right across the chat to open the sidebar, and left across the sidebar to close it.
The drawer responds during the swipe. Closing swipes can start on sidebar buttons without activating them;
ordinary taps still work. Vertical scrolling, selected text and text inputs do not trigger closing.
Opening swipes also leave controls and code blocks alone; the menu button remains available.

## Transcript and interaction coverage

The structured transcript includes rule/system-violation notices, visible custom messages, provider errors and aborted
responses, compaction and branch summaries, shell/Python executions, tool output, file mentions and usage/model
metadata. Hidden custom messages and developer/internal guidance remain hidden. Runtime cards show exposed retry,
model-fallback, compaction, goal and reminder state alongside pending interactions.

Plan review uses OMP's public resolver: read the plan, select an execution tier when offered, then explicitly choose
execute, compact, keep context, refine with feedback, or save and quit. Choices and tiers are validated against the
current review and runtime generation; stale, duplicate or disabled choices are rejected. Reviews exceeding the
1 MiB display budget disable native choices and direct you to terminal inspection instead of approving unseen text.
`ask` answers use the extension's shared native/mobile wait; stale generations, changed interaction IDs and invalid
options are rejected before completion. Core approvals and other terminal-owned selectors still use the live terminal
keypad/text controls. Each known-dialog action is scoped to the current interaction and generation.

Images open for inspection. Mermaid diagrams, sanitized static SVG, KaTeX math and chartable numeric tables render
locally with source/zoom controls. Rendering dependencies and math fonts are served by the gateway, not a CDN.
Unsafe SVG scripts, event handlers, external references, foreign HTML and active CSS are removed. Attach up to eight
PNG/JPEG/WebP/GIF images with the composer's **＋** upload button, or paste copied images directly into the message field.
The editor accepts native image paste rather than requesting separate clipboard-read permission; mobile keyboard/browser support
still determines whether an image is offered. Pasted text stays plain text, and previews can be removed before sending.
The browser resizes images when needed; the API permits at most 3 MiB of combined base64 image data and a 4 MiB action body.
Failed sends retain attachments so they can be retried.

The initial snapshot contains the latest 80 visible entries. **Load older messages** pages back through the branch.
Clipped messages and omitted inline images expose **Load full message and images**. Full messages use immutable,
generation-scoped transfers and have a 32 MiB serialized-message ceiling; oversized or expired transfers report an
error rather than silently returning incomplete content.

Host limits remain explicit: OMP 18.12.1 does not publicly expose every generic UI notice, desktop-origin queue text,
IRC/chat event or private recap reader. Queue availability can therefore appear without its text. These surfaces
remain accessible through the terminal view/controls where OMP renders them; Mobile does not synthesize missing host
state. Session/tree selectors that lack a native bridge likewise open the live terminal controls.

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

The app starts loading live runtimes immediately and requests the selected runtime's state as soon as the validated
runtime list arrives. Saved-session history, pins, and notification setup/status load independently; neither they nor
their first responses gate live-session refresh polling.

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
transcripts. Completion and **Action needed** notifications have separate identities and acknowledgements; pending
questions, approvals and plan reviews do not wait for a completion notification. Tapping a notification opens its
runtime directly. Clearing a pending interaction removes its action-needed state; a transient discovery failure does
not falsely clear it. Browser/platform push delivery still depends on notification permission and push-service access.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/slots` | Live runtimes (`id`, title, cwd, status, `connected` and optional session file). |
| `POST /api/slots` | Start in optional `cwd` under `OMP_MOBILE_ROOT`, or resume a saved session with `{resume: <path>}`. |
| `DELETE /api/slots/:id` | Stop a daemon runtime. |
| `GET /api/slots/:id/state` | Structured state, current-generation runtime notices/interactions, history metadata, model, effort, transcript and activity. |
| `GET /api/slots/:id/history?before=<entryId>&limit=80` | Older visible entries before the cursor. |
| `GET /api/slots/:id/message?id=<entryId>` | Full message; add `offset=0` to begin chunked transfer, then use its `transferId` and `nextOffset`. |
| `POST /api/slots/:id/action` | Prompt/images, abort, model, effort, command, move or native interaction; generation-guarded. |
| `GET /api/slots/:id/terminal` | Terminal snapshot without resizing the PTY. |
| `POST /api/slots/:id/terminal` | Explicitly confirmed key/text input, guarded by generation and current interaction when applicable. |
| `GET /api/sessions` | Saved OMP sessions (id, path, cwd, title, update time and cost). |
| `/api/notifications*` | Push configuration, status, subscriptions and per-runtime acknowledgement. |
| `/api/directories`, `/api/pins` | Folder explorer, `/move` destination completion, and pinned working directories. |

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
| `OMP_MOBILE_ROOT` | `$HOME` | Folder browser, `/move` destinations, pins and new-session working-directory root; dot-directories are excluded. |
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
