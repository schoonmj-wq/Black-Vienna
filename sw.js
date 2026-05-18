// Black Vienna — Service Worker
// Handles background push notifications

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Handle incoming push messages
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'Black Vienna';
  const options = {
    body: data.body || "It's your turn!",
    icon: data.icon || '/icon.png',
    badge: '/icon.png',
    tag: 'black-vienna-turn',   // replaces any previous notification
    renotify: true,
    data: { url: data.url || '/' },
    actions: [
      { action: 'play', title: 'Play Now' }
    ]
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Tap on notification opens the game
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If game tab already open, focus it
      for (const client of clientList) {
        if (client.url.includes('black-vienna') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
