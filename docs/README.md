# omp-mobile design notes

Current client behavior, topology, environment and security model are documented in the
[project README](../README.md). This directory no longer keeps its own copies of the architecture/options
documents: they describe the desktop daemon and are canonical in the desktop repository.

- [desktop-architecture.md](../../omp-desktop/docs/desktop-architecture.md) — the architecture that replaced the
  zellij gateway. Read it as a design record: the auth fence sketched in its comparison table ("launch token →
  signed HttpOnly cookie") was **not** implemented as written; the shipped fence is the gateway refusing any
  non-loopback daemon URL plus the shared bearer token described in the README. Later sections record post-P1
  fixes from live use.
- [desktop-app-options.md](../../omp-desktop/docs/desktop-app-options.md) — the 2026-10-02 requirements/options
  analysis behind the "build from scratch" decision. Options A/B were not taken; measurements (process RSS,
  session counts, the zellij layout) are observations from one Linux/Wayland workstation on that date, not current
  behavior.
- [desktop-reqs.txt](../../omp-desktop/docs/desktop-reqs.txt) — the original requirement list.

Mobile-specific rules that are current and load-bearing (runtime ids `rt-…`, per-runtime extension sockets,
owner-only IPC, legacy token path compatibility) are documented in the README and implemented in `server.ts`,
`extension.ts` and `shared.ts`.
