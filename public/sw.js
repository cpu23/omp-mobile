// Live runtime ids are minted by the desktop daemon (rt-<uuid>) and change as
// runtimes appear and disappear. Mirrors RUNTIME_ID_RE in shared.ts; a malformed
// or stale id must never be navigated to.
const RUNTIME_ID_RE = /^rt-[A-Za-z0-9-]{1,64}$/;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {}
  const slot =
    typeof data.slot === "string" && RUNTIME_ID_RE.test(data.slot)
      ? data.slot
      : "";
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim().slice(0, 120)
      : slot || "OMP Mobile";
  const identity =
    typeof data.identity === "string" ? data.identity.slice(0, 180) : "";
  const type = data.type === "action-needed" ? "action-needed" : "completion";
  const actionLabel =
    data.kind === "approval"
      ? "Approval needed"
      : data.kind === "ask"
        ? "Question waiting"
        : data.kind === "plan"
          ? "Plan review needed"
          : "Input needed";
  const actionTitle =
    typeof data.actionTitle === "string" ? data.actionTitle.trim().slice(0, 160) : "";
  const body =
    type === "completion"
      ? "Session finished"
      : actionTitle
        ? `${actionLabel}: ${actionTitle}`
        : actionLabel;
  const notificationData = { type, slot, identity };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body,
        icon: "/icon-192.svg",
        badge: "/icon-192.svg",
        tag: identity
          ? `omp-${type}-${identity}`
          : `omp-${type}-${slot || "session"}`,
        renotify: true,
        requireInteraction: type === "action-needed",
        data: notificationData,
      }),
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          for (const client of clients)
            client.postMessage({
              type: "omp-notification",
              notificationType: type,
              slot,
              identity,
            });
        }),
    ]),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawSlot = event.notification.data?.slot;
  const slot =
    typeof rawSlot === "string" && RUNTIME_ID_RE.test(rawSlot)
      ? rawSlot
      : undefined;
  const target = new URL("/", self.location.origin);
  if (slot) target.searchParams.set("slot", slot);
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) => {
          try {
            return new URL(client.url).origin === self.location.origin;
          } catch {
            return false;
          }
        });
        if (existing) {
          existing.postMessage({
            type: "omp-notification-click",
            slot,
          });
          return existing.focus();
        }
        return self.clients.openWindow(target.href);
      }),
  );
});
