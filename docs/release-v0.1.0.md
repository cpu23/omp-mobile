# OMP Mobile 0.1.0 — Initial source release

OMP Mobile puts existing OMP Desktop sessions in a phone-sized browser client, with a home-screen launch option.

[Launch video (MP4)](https://github.com/cpu23/omp-mobile/releases/download/v0.1.0/launch.mp4) · [Demo GIF](https://github.com/cpu23/omp-mobile/releases/download/v0.1.0/demo.gif) · [Quick setup](https://github.com/cpu23/omp-mobile#quick-setup)

## Highlights

- Send prompts, read provider replies, and switch between live sessions hosted by OMP Desktop.
- Add the browser client to a phone's home screen for app-like access.
- For remote access, serve the Mobile gateway over HTTPS within a private Tailscale network.
- The 17-second launch film uses real 430 × 900 browser footage and genuine `openai-codex/gpt-6-luna` replies. It sends an accessibility-design prompt, shows the actual reply, and switches live sessions. The revised 1080p60 edit keeps the app at native size in a fixed frame, with minimal headings, correctly timed tap feedback, and an original soundtrack. Provider waiting time is edited out. The previous blank reload/header-only sequence is removed; this film makes no mobile reload or reply-history-restoration claim. Demo data is disposable; this is not native-app or physical-phone footage.

## Requirements and setup

Run on a Linux or macOS host with Bun 1.3+, Git, and OMP 18.x on `PATH`; complete OMP provider setup and use OMP Desktop in the same parent folder. A current phone browser is required. Remote access and home-screen installation use HTTPS.

Follow the [Quick setup](https://github.com/cpu23/omp-mobile#quick-setup) and [remote access guide](https://github.com/cpu23/omp-mobile/blob/main/docs/guide.md#remote-access).

## Distribution

This is a source release with demo media; it includes no native mobile binaries or app-store packages. GitHub provides source archives for the release tag. Run the app on the host and connect from a browser.

The launch soundtrack is instrumental music generated locally with [YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B), with vocals removed using Demucs. YuE2's model license is CC BY-NC 4.0; this soundtrack was made for non-commercial use, not commercially cleared. The repository's source-code license does not grant additional rights to the soundtrack.
