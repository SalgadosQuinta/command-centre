/* GTD Command Centre service worker */
const CACHE = 'tasksapp-v18';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network-first for navigations and same-origin assets, falling back to cache when offline.
   This means fixes go live on next load, but the app still opens with no connection. */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const _u=new URL(e.request.url);
  if(_u.origin===location.origin&&(e.request.mode==='navigate'||_u.pathname.endsWith('/index.html')||_u.pathname.endsWith('/'))){
    e.respondWith((function(){
      const netP=fetch(e.request).then(res=>{ if(res&&res.ok){ const c=res.clone(); caches.open(CACHE).then(x=>x.put(e.request,c)); } return res; });
      const timed=new Promise(resolve=>{ setTimeout(()=>{ caches.match(e.request).then(hit=>resolve(hit||caches.match('./index.html'))); },3500); });
      return Promise.race([
        netP.catch(()=>caches.match(e.request).then(hit=>hit||caches.match('./index.html'))),
        timed
      ]).then(res=>res||netP);
    })());
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('./index.html')))
  );
});

self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Tasks', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cs) => { for (const c of cs) { if ('focus' in c) return c.focus(); } return clients.openWindow(e.notification.data?.url || './'); }));
});
