# OMP Mobile

**Your desktop sessions. On your phone.**

Send prompts, read replies and switch sessions from your phone. OMP Mobile uses the same live [OMP](https://omp.sh)
sessions as [OMP Desktop](https://github.com/cpu23/omp-desktop); add it to your home screen.

<p>
  <img src="docs/screenshots/chat.png" alt="Mobile session transcript and composer" width="260">
  <img src="docs/screenshots/todos.png" alt="Mobile session with the expanded to-do drawer: active task in the session accent, pending tasks in neutral text" width="260">
  <img src="docs/screenshots/settings.png" alt="Mobile sidebar settings and shared session limit" width="260">
</p>

## Requirements

- Linux or macOS host with Git, [Bun 1.3.14+](https://bun.sh) and [OMP 18.x](https://omp.sh) on `PATH`; run `omp` once
  and complete provider setup. Mobile's structured UI integration is verified against OMP 18.12.1.
- Current phone browser. HTTPS is required for remote access and home-screen installation; [Tailscale](https://tailscale.com/download)
  is the simplest private connection.

## Quick setup

Run on the host in a directory for both sibling checkouts. Skip cloning a repository you already have.

```sh
git clone https://github.com/cpu23/omp-desktop.git && git clone https://github.com/cpu23/omp-mobile.git
```

Start Mobile and save the printed token; setup reuses an existing valid token:

```sh
cd omp-mobile && bun install --frozen-lockfile && bun run setup && bun run setup --show && bun run start
```

In a second terminal, start Desktop from the same parent directory:

```sh
cd omp-desktop && bun install --frozen-lockfile && bun run start
```

Keep both terminals open. Locally, open <http://127.0.0.1:4173> and enter the token. For phone access, join the same
Tailscale network on both devices, then run on the host:

```sh
tailscale serve --bg 4173
```

Open Tailscale's HTTPS URL, enter the token and use **Add to Home Screen** in your browser. Keep Desktop port 4180
local; share only the Mobile gateway over HTTPS.

## Releases

### Unreleased

- Render rule/system-violation notices, provider failures, retry/fallback/compaction state, goals, custom messages,
  execution output, summaries, file mentions and message usage.
- Surface pending `ask`, approvals and terminal-owned dialogs with live phone controls; render native plan reviews
  with refinement feedback and execution-tier choices when supplied by OMP.
- Display images, Mermaid, sanitized SVG, math and table-derived charts; attach images from the composer.
- Load older history and recover full output/images instead of silently truncating; notify when a session needs action.

See [UI coverage and host limits](docs/guide.md#transcript-and-interaction-coverage) before upgrading live sessions.

**v0.1.1 — Source release; no native binaries or app-store packages.** [GitHub release](https://github.com/cpu23/omp-mobile/releases/tag/v0.1.1) · [Release notes](docs/release-v0.1.1.md).

## Upstream & ecosystem

[OMP](https://omp.sh) · [Source](https://github.com/can1357/oh-my-pi) · [Releases](https://github.com/can1357/oh-my-pi/releases) · [Skills](https://omp.sh/docs/skills) · [Plugins](https://omp.sh/docs/plugins) · [Community (Discord)](https://discord.com/invite/4NMW9cdXZa)

[OMP Desktop companion](https://github.com/cpu23/omp-desktop) · [PWA installation](https://web.dev/learn/pwa/installation) · [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) · [Bun](https://bun.sh/docs)

## More

[Settings and help](docs/guide.md) · [Other connection methods](docs/guide.md#remote-access) · [MIT license](LICENSE)
