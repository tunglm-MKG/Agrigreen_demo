/**
 * Máy chủ HTTP: phục vụ API và giao diện web tĩnh.
 * Chạy:  node --experimental-sqlite src/server.ts   (Node ≥ 22)  hoặc  npm start
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './platform/db/schema.ts';
import { HttpError, sendJson } from './platform/http/router.ts';
import { buildApi } from './api.ts';
import { gateEnabled, handleGate } from './platform/http/accessGate.ts';
import { seedIfEmpty } from './seed.ts';
import { syncSystemGroups } from './platform/auth/admin.ts';
import { processOutbox, runAlertScan } from './platform/notify/service.ts';
import { purgeExpired } from './platform/http/idempotency.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(HERE, 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function start(port = Number(process.env.PORT ?? 4173)): Promise<void> {
  migrate();
  seedIfEmpty();
  syncSystemGroups();
  const api = buildApi();

  // Tiến trình nền: quét cảnh báo mỗi 10 phút, gửi outbox mỗi 30 giây, dọn khoá
  // chống trùng quá hạn. unref() để chúng không giữ tiến trình sống khi tắt máy chủ.
  const scan = () => {
    try { runAlertScan(); purgeExpired(); } catch (error) { console.error('[notify] quét lỗi:', (error as Error).message); }
  };
  scan();
  setInterval(scan, 10 * 60_000).unref();
  setInterval(() => { processOutbox().catch((error) => console.error('[notify] outbox lỗi:', error.message)); }, 30_000).unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      // Cổng mã truy cập đứng TRƯỚC mọi thứ khác: chưa nhập đúng mã thì không
      // thấy giao diện lẫn API. Tắt hoàn toàn khi không đặt DEMO_ACCESS_CODE.
      if (handleGate(req, res, url.pathname)) return;

      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'mekong-green', time: new Date().toISOString() });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const apiUrl = new URL(url.toString());
        apiUrl.pathname = url.pathname.slice(4);
        const handled = await api.handle(req, res, apiUrl);
        if (!handled) sendJson(res, 404, { error: 'Endpoint không tồn tại', path: url.pathname });
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, details: error.details ?? null });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      // Lỗi nghiệp vụ (throw new Error trong service) trả 400 kèm thông điệp tiếng Việt.
      sendJson(res, 400, { error: message });
    }
  });

  await new Promise<void>((resolveStart) => server.listen(port, resolveStart));
  console.log(`\n  Mekong Green Platform đang chạy: http://localhost:${port}\n`);
  if (gateEnabled()) {
    console.log('  Cong ma truy cap DANG BAT (bien DEMO_ACCESS_CODE) - nguoi xem phai nhap ma truoc.');
  }
  console.log('  Tài khoản mẫu (mật khẩu: 123456):');
  console.log('    admin      — Quản trị nền tảng (toàn quyền)');
  console.log('    supplychain— Supply Chain / Kế hoạch (mô phỏng Hub)');
  console.log('    taichinh   — Tài chính (phê duyệt tham số giả định)');
  console.log('    khonhap    — Vận hành kho/bãi');
  console.log('    canbo_xa   — Cán bộ Khuyến nông xã');
  console.log('    htx01      — Ban quản lý HTX');
  console.log('    cuc_ktht   — Cục KTHT & PTNT (chỉ xem)\n');
}

async function serveStatic(pathname: string, res: import('node:http').ServerResponse): Promise<void> {
  const requested = pathname === '/' ? '/index.html' : pathname;
  // Chặn path traversal.
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(WEB_ROOT, safe);
  if (!filePath.startsWith(WEB_ROOT)) {
    sendJson(res, 403, { error: 'Truy cập bị từ chối' });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    // SPA fallback.
    try {
      const html = await readFile(join(WEB_ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
    } catch {
      sendJson(res, 404, { error: 'Không tìm thấy tài nguyên', path: pathname });
    }
  }
}
