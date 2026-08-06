/* ===== Service Worker — کافه متانویا =====
   نسخه را در هر انتشار جدید بالا ببرید تا کش قدیمی پاک شود. */
const VERSION = 'v1.11.6';
const STATIC_CACHE = `metanoia-static-${VERSION}`;
const RUNTIME_CACHE = `metanoia-runtime-${VERSION}`;
const IMAGE_CACHE = `metanoia-images-${VERSION}`;
const IMAGE_LIMIT = 60; // سقف تعداد تصاویر کش‌شده

const PRECACHE = [
    './',
    './index.html',
    './style.css',
    './products.js',
    './manifest.json',
    './icon.svg'
];

/* ---------- نصب: پیش‌کش با تحمل خطا ---------- */
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(STATIC_CACHE);
        // add تک‌تک تا یک ۴۰۴ کل نصب را شکست ندهد
        await Promise.all(PRECACHE.map(url =>
            cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
        ));
        self.skipWaiting();
    })());
});

/* ---------- فعال‌سازی: پاک‌سازی نسخه‌های قدیمی ---------- */
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = [STATIC_CACHE, RUNTIME_CACHE, IMAGE_CACHE];
        const names = await caches.keys();
        await Promise.all(names.map(n => keep.includes(n) ? null : caches.delete(n)));
        if (self.registration.navigationPreload) {
            await self.registration.navigationPreload.disable().catch(() => {});
        }
        await self.clients.claim();
    })());
});

/* ---------- پیام از صفحه (اعمال فوری آپدیت) ---------- */
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/* ---------- ابزارها ---------- */
async function trimCache(name, max) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// شبکه‌اول با تایم‌اوت: برای محتوایی که باید تازه باشد (قیمت‌ها، HTML)
async function networkFirst(request, cacheName, timeoutMs = 4000) {
    const cache = await caches.open(cacheName);
    try {
        const fresh = await Promise.race([
            fetch(request),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
        ]);
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
    } catch (err) {
        const cached = await cache.match(request, { ignoreSearch: false });
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const fallback = await cache.match('./index.html') ||
                             await (await caches.open(STATIC_CACHE)).match('./index.html');
            if (fallback) return fallback;
        }
        throw err;
    }
}

// کش‌اول + به‌روزرسانی پس‌زمینه: برای CSS/فونت/CDN
async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    const network = fetch(request).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
        return res;
    }).catch(() => null);
    return cached || network || Response.error();
}

// کش‌اول خالص: برای تصاویر
async function cacheFirst(request, cacheName, limit) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) {
        await cache.put(request, res.clone());
        if (limit) trimCache(cacheName, limit);
    }
    return res;
}

/* ---------- مسیردهی درخواست‌ها ---------- */
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;

    // ۱) ناوبری و HTML → شبکه‌اول (کاربر همیشه آخرین منو را می‌بیند)
    if (req.mode === 'navigate' || url.pathname.endsWith('.html')) {
        event.respondWith(networkFirst(req, RUNTIME_CACHE));
        return;
    }

    // ۲) داده محصولات → شبکه‌اول (حساس به تغییر قیمت)
    if (sameOrigin && url.pathname.endsWith('products.js')) {
        event.respondWith(networkFirst(req, RUNTIME_CACHE, 3500));
        return;
    }

    // ۳) تصاویر → کش‌اول با سقف
    if (req.destination === 'image') {
        event.respondWith(cacheFirst(req, IMAGE_CACHE, IMAGE_LIMIT));
        return;
    }

    // ۴) CSS/JS/فونت هم‌مبدأ + CDN فونت → کش‌اول با آپدیت پس‌زمینه
    const isAsset = ['style', 'script', 'font'].includes(req.destination);
    const isFontCdn = /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com/.test(url.hostname);
    if ((sameOrigin && isAsset) || isFontCdn) {
        event.respondWith(staleWhileRevalidate(req, sameOrigin ? RUNTIME_CACHE : STATIC_CACHE));
        return;
    }

    // ۵) بقیه: بدون دخالت
});
