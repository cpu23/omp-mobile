# omp-mobile

Phone client for [omp](https://omp.sh) coding sessions: a PWA (installable web app) served by a small Bun gateway that
runs alongside the [omp-desktop](../omp-desktop) daemon. The phone drives the **same live `omp` processes** the desktop
app shows — there is no second session pool, and zellij is no longer involved.

- `server.ts` — gateway: serves the PWA, authenticates the phone, exposes the desktop daemon's live runtimes as
  `/api/slots`, relays prompts/actions and terminal snapshots, and sends Web Push notifications.
- `extension.ts` — omp extension: reports session state (working / needs approval / done) to the gateway over a
  per-runtime, owner-only socket.
- `client.ts` — the PWA UI: unified session sidebar, new/resume/stop controls, transcript and raw terminal views, notifications.
- `notifications.ts` — Web Push (VAPID keys generated once, stored under the gateway state dir; never committed).
  Live runtime identities are discovered from the gateway/desktop daemon on every poll — never from a fixed slot table.
- `shared.ts` — wire types shared by server and client. Runtime ids (`rt-…`) are opaque, dynamic and validated
  everywhere they cross a process boundary.

## Run

```sh
bun install
bun run start          # serve the PWA + gateway
bun run check          # typecheck
```

### Dependencies

The gateway is a client of the `omp-desktop` daemon (default `http://127.0.0.1:4180`):

- live sessions in the sidebar are that daemon's runtimes; starting, resuming and stopping map to its runtime API;
- historical sessions come from omp's own session store (`~/.omp/agent/sessions`, listed by the daemon);
- completion notifications are polled from each runtime's extension socket.

Start the desktop daemon (or its user service) before the gateway. The deployed gateway systemd unit expects the
desktop unit to be wanted/started first; the existing gateway token file is reused, so moving the unit does not
rotate secrets.

Set `OMP_MOBILE_DESKTOP_URL` if the daemon is not at `http://127.0.0.1:4180`.
Terminal snapshots replay the desktop PTY stream through xterm's headless buffer;
viewing them does not resize the desktop terminal. The phone mirrors sessions,
not the desktop's pane layout.

## Session sidebar and composer

The sidebar mirrors desktop discovery: live runtimes appear first, followed by recent transcripts, with running
transcripts shown only once. Selecting a historical row resumes it through the desktop daemon; selecting a live
row opens that same runtime. There is no separate “Saved sessions” browser; stored transcripts are not deleted.

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

Session accents match OMP 18's CLI exactly: `session-accent.ts` mirrors the host's OKLCH algorithm using
the frozen `theme.sessionAccentInputs` token. Compiled host internals cannot be imported by extensions,
so parity vectors must be checked when upgrading OMP. Missing tokens or unnamed sessions yield no accent
(the UI uses gray), rather than a guessed hue. Both `/state` and `/status` share this computation.

## API used by the PWA

| Route | Purpose |
| --- | --- |
| `GET /api/slots` | Live runtimes (`{slots: [{id, title, cwd, status, connected, sessionFile?}]}`). |
| `POST /api/slots` | Start a runtime (optional `{cwd}`) or resume a saved one (`{resume: <session path>}`). |
| `DELETE /api/slots/:id` | Stop that runtime in the desktop daemon. |
| `GET /api/slots/:id/state` | Structured session state (model, effort, transcript, capabilities). |
| `POST /api/slots/:id/action` | Prompt / abort / model / effort / command / move (generation-guarded). |
| `GET /api/slots/:id/terminal` | Read-only terminal snapshot of the pane. |
| `GET /api/sessions` | Saved sessions from omp's store (id, path, cwd, title, updatedAt, costUsd). |
| `/api/notifications*` | Push config, status and per-runtime acknowledgement. |
| `/api/directories`, `/api/pins` | Folder explorer and pinned working directories. |

The desktop app itself lives in [omp-desktop](../omp-desktop); `docs/` here holds the design notes this client grew
out of and the architecture that replaced the zellij gateway.
