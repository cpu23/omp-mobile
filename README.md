# OMP Mobile

**Your desktop sessions. On your phone.**

Send prompts, read replies, and switch sessions from your phone. OMP Mobile uses the same live [OMP](https://omp.sh) sessions as [OMP Desktop](https://github.com/cpu23/omp-desktop). Add it to your home screen.

<p align="center">
  <a href="docs/images/mobile.png"><img src="docs/images/mobile.png" alt="Open session sidebar with working icons and live session status" width="260"></a>
  <a href="docs/images/mobile-chat.png"><img src="docs/images/mobile-chat.png" alt="Live reply with the working indicator and Stop control" width="260"></a>
  <a href="docs/images/mobile-folders.png"><img src="docs/images/mobile-folders.png" alt="Folder tree with a pinned project and session start controls" width="260"></a>
</p>

*Session sidebar · Live replies · Folders and pins. Demo sessions use a local test stream.*

## Requirements

- A **Linux or macOS host** with Git, [Bun 1.3+](https://bun.sh), and [OMP 18.x](https://omp.sh) on its `PATH`.
- Run `omp` on the host once. Complete the provider setup.
- A phone with a current browser. Use HTTPS for remote access and home-screen installation.
- [Tailscale](https://tailscale.com/download) on the host and phone is the simplest private connection.

## Quick setup

Run all commands on the host. Start in the folder where you keep your projects.

**1. Get both apps.** Skip a clone if you already have that repository. Keep them next to each other.

```sh
git clone https://github.com/cpu23/omp-desktop.git && git clone https://github.com/cpu23/omp-mobile.git
```

**2. Start Mobile.** Save the access token printed by this command. Do not share it.

```sh
cd omp-mobile && bun install --frozen-lockfile && bun run setup && bun run setup --show && bun run start
```

**3. Start Desktop in a second terminal.** From the same parent folder:

```sh
cd omp-desktop && bun install --frozen-lockfile && bun run start
```

Keep both terminals open. For a local check, open **<http://127.0.0.1:4173>** and paste the token.

**4. Connect your phone.** Sign in to the same Tailscale network on both devices. In a third terminal:

```sh
tailscale serve --bg 4173
```

Open the HTTPS URL that Tailscale prints. Paste the token. Use **Add to Home Screen** in your browser to install the app.

> Keep desktop port 4180 local. Share only the Mobile gateway through HTTPS. Token setup reuses an existing valid token; it does not replace it.

## More

[Settings and help](docs/guide.md) · [Other connection methods](docs/guide.md#remote-access) · [MIT license](LICENSE)
