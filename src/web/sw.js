/**
 * Service worker — vỏ ứng dụng dùng được khi mất mạng.
 *
 * Ruộng ĐBSCL mất sóng là chuyện thường. Không có worker này, đội trưởng mở lại
 * trang lúc mất mạng chỉ thấy lỗi trình duyệt và mất luôn hàng đợi thao tác đang
 * chờ gửi (hàng đợi nằm trong localStorage của trang, xem app.js).
 *
 * Chiến lược:
 *   - Tệp tĩnh cùng nguồn (HTML, JS, CSS): MẠNG TRƯỚC, lỗi thì lấy bản đã lưu.
 *     Không dùng cache-trước để bản mới triển khai không bị bản cũ che.
 *   - /api/*: không đụng tới. Dữ liệu nghiệp vụ không được lưu trong cache trình
 *     duyệt; hàng đợi offline ở app.js lo phần ghi.
 *   - Điều hướng (mở trang) khi mất mạng: trả index.html đã lưu — SPA tự dựng lại.
 */
const VERSION = 'mg-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/boot.js', '/portals.js', '/styles.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL).catch(() => undefined)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/__access') return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const response = await fetch(request);
      if (response.ok && (request.mode === 'navigate' || /\.(js|css|html)$/.test(url.pathname) || url.pathname === '/')) {
        cache.put(request.mode === 'navigate' ? '/index.html' : request, response.clone()).catch(() => undefined);
      }
      return response;
    } catch {
      const cached = await cache.match(request.mode === 'navigate' ? '/index.html' : request);
      if (cached) return cached;
      return new Response('Mất kết nối và chưa có bản lưu của tài nguyên này.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
