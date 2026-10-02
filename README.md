# omp-mobile

Phone client for [omp](https://omp.sh) coding sessions: a PWA (installable web app) plus an omp extension, served by a
small Bun gateway that runs alongside your terminal setup.

- `server.ts` — gateway: serves the PWA, supervises omp sessions, relays terminal traffic, Web Push notifications.
- `extension.ts` — omp extension: reports session state (working / needs approval / done) and prompts to the gateway.
- `client.ts` — the PWA UI: session list, terminal view, prompt box, notifications; bundled and served at runtime.
- `notifications.ts` — Web Push (VAPID keys generated once, stored under the gateway state dir; never committed).
- `shared.ts` — wire types shared by server and client.

## Run

```sh
bun install
bun run start          # serve the PWA + gateway
bun run check          # typecheck
```

The desktop successor (daemon-owned TUI panes, splits, sidebar, drag-to-pane) lives in
[omp-desktop](https://github.com/cpu23/omp-desktop); `docs/` here holds the design notes it grew out of.
