// 每日绘 Craft · Service Worker v2.0
// 缓存策略：
//   - App Shell（HTML/CSS/JS）: Network First, fallback Cache
//   - 画作图片 /data/: Network First, fallback Cache
//   - AI 接口 /api/: Network Only（不缓存）

const CACHE_NAME = 'meirihui-v39';
const APP_SHELL = [
  '/',
  '/static/css/style.css?v=20260731v38',
  '/static/js/state.js?v=20260731v39',
  '/static/js/onboarding.js?v=20260731v39',
  '/static/js/themes.js?v=20260731v39',
  '/static/js/camera.js?v=20260731v39',
  '/static/js/feedback.js?v=20260731v39',
  '/static/js/timeline.js?v=20260731v39',
  '/static/js/community.js?v=20260731v39',
  '/static/js/share.js?v=20260731v39',
  '/manifest.json',
];

// ── Install：预缓存 App Shell ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {});
    })
  );
  // 立即接管，不等旧 SW 释放
  self.skipWaiting();
});

// ── Activate：清理所有旧缓存 + 通知客户端刷新 ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      // 删除所有非当前版本的缓存
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] 删除旧缓存:', k);
          return caches.delete(k);
        })
      );
    }).then(() => {
      // 通知所有客户端新版本已激活
      return self.clients.matchAll({ type: 'window' });
    }).then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME });
      });
    })
  );
  self.clients.claim();
});

// ── Fetch：按资源类型分流 ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // AI 接口：不缓存（总是网络请求）
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // SSE 流式接口：不拦截
  if (url.pathname === '/api/analyze/stream') {
    return;
  }

  // 画作图片：Network First, fallback Cache
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App Shell（HTML/CSS/JS）：Network First, fallback Cache
  event.respondWith(
    fetch(event.request).then((resp) => {
      // 只缓存成功的基础资源
      if (resp.ok && (url.pathname.startsWith('/static/') || url.pathname === '/')) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
      }
      return resp;
    }).catch(() => {
      // 离线时返回缓存
      return caches.match(event.request).then((cached) => {
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});
