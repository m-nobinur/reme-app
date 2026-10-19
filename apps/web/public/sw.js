// Reme's service worker: it only shows a push from the owner's assistant and
// opens the conversation on a click. It caches nothing and answers no fetch.
// Registered by the notifications control (src/lib/push-control.tsx), and only
// after the owner turns notifications on.

self.addEventListener("push", (event) => {
  const note = event.data ? event.data.json() : null
  if (!note || typeof note.title !== "string") return
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        // The chat already shows it to someone looking at it.
        if (windows.some((w) => w.visibilityState === "visible" && w.focused)) {
          return
        }
        return self.registration.showNotification(note.title, {
          body: note.body,
          tag: note.tag,
          renotify: true,
          icon: "/icon-192.png",
          data: { url: note.url },
        })
      })
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const path = event.notification.data?.url
  // Only a conversation of ours: the payload is ours, but a click should never leave the app.
  if (typeof path !== "string" || !path.startsWith("/app/")) return
  const target = new URL(path, self.location.origin).href
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        const open = windows.find((w) => w.url.startsWith(self.location.origin))
        return open
          ? open.focus().then((w) => w.navigate(target))
          : self.clients.openWindow(target)
      })
  )
})
