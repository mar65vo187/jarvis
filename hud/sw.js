// Minimaler Service Worker, damit Jarvis als Desktop-App installierbar ist.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', () => {});
