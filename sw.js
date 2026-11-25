// Service Worker for HouseClean Hub & Web Share Target
const CACHE_NAME = 'houseclean-hub-v1';
const SHARED_CACHE_NAME = 'shared-pdf-cache';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Web Share Target: LINEや他アプリから共有されたPDFを受信
  if (event.request.method === 'POST' && url.searchParams.has('shared')) {
    event.respondWith((async () => {
      try {
        const formData = await event.request.formData();
        const file = formData.get('file');
        if (file) {
          const cache = await caches.open(SHARED_CACHE_NAME);
          await cache.put('incoming-pdf', new Response(file, {
            headers: {
              'Content-Type': file.type || 'application/pdf',
              'X-File-Name': encodeURIComponent(file.name || 'shared_document.pdf')
            }
          }));
        }
      } catch (err) {
        console.error('Error handling shared file in SW:', err);
      }
      // アプリのトップ画面（受け取りパラメータ付き）へリダイレクト
      return Response.redirect('./?received_share=1', 303);
    })());
    return;
  }

  // 通常の静的リクエスト: ネットワーク優先（最新版を取得）
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
