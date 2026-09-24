/**
 * Máy chủ HTTP: phục vụ API và giao diện web tĩnh.
 * Chạy:  node --experimental-sqlite src/server.ts   (Node ≥ 22)  hoặc  npm start
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './platform/db/schema.ts';
import { importLegacyDatabase } from './platform/db/legacy.ts';
import { withWriteLock } from './platform/db/db.ts';
import { processRetries } from './platform/sync/sync.ts';
import { captureSnapshot } from './platform/audit/audit.ts';
import { ensureOpeningLots } from './erp/warehouse/service.ts';
import { one } from './platform/db/db.ts';
import { today } from './platform/util/ids.ts';
import { HttpError, sendJson, friendlyError } from './platform/http/router.ts';
import { buildApi } from './api.ts';
import { gateEnabled, handleGate } from './platform/http/accessGate.ts';
import { seedIfEmpty } from './seed.ts';
import { one as dbOne } from './platform/db/db.ts';
import { assertEncryptionKeyConfigured } from './platform/security/fieldCrypto.ts';
import { rotateChannelSecrets } from './platform/notify/service.ts';
import { purgeRateLimits } from './platform/http/rateLimit.ts';
import { isSecureRequest } from './platform/http/router.ts';
import { syncSystemGroups } from './platform/auth/admin.ts';
import { processOutbox, runAlertScan } from './platform/notify/service.ts';
import { purgeExpired } from './platform/http/idempotency.ts';
import { seedVarietiesIfEmpty } from './mdm/varieties.ts';
import { seedHtxFieldDemoIfEmpty, ensureXaScopeAssignments } from './seedDemoHtx.ts';
import { ensureSuperAdmin } from './platform/auth/users.ts';
import { backupAll } from './platform/db/backup.ts';
import { dailyIntegrityScan } from './platform/db/integrity.ts';
import { escalateOverdueTasks, scanWatchlists } from './agrigreen/khuyennong/ops.ts';
import { runDueReportSchedules } from './agrigreen/htx/fieldOps.ts';

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
  // M-05: production phải có DATA_ENCRYPTION_KEY — dừng ngay thay vì tự sinh khoá cạnh dữ liệu.
  assertEncryptionKeyConfigured();
  migrate();
  // Tệp hợp nhất cũ (trước 09/2026) → nhập vào bộ tệp mới TRƯỚC khi xét seed (A06).
  importLegacyDatabase();
  // C-02: dữ liệu và tài khoản trình diễn KHÔNG bao giờ tự nạp ở production, trừ khi bật SEED_DEMO_DATA=1 tường minh.
  const allowDemoSeed = process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO_DATA === '1';
  if (allowDemoSeed) seedIfEmpty();
  else if (!dbOne('SELECT 1 FROM cooperatives LIMIT 1')) console.warn('[seed] CSDL trống nhưng NODE_ENV=production: KHÔNG nạp dữ liệu trình diễn (C-02). Tạo dữ liệu qua giao diện quản trị, hoặc đặt SEED_DEMO_DATA=1 nếu thật sự muốn bản demo.');
  syncSystemGroups();
  // Super Admin toàn hệ thống (SAdmin) — đổi tên tài khoản `admin` cũ nếu còn.
  ensureSuperAdmin();
  // Danh mục giống lúa mặc định cho CSDL đã có từ trước đợt cập nhật 09/2026.
  seedVarietiesIfEmpty();
  // Nông hộ, thửa, mùa vụ, nhật ký mẫu cho App HTX khi CSDL chưa có (chỉ chạy một lần) — cũng theo cờ demo.
  if (allowDemoSeed) seedHtxFieldDemoIfEmpty();
  // M-04: token kênh gửi còn lưu rõ trong system_config → mã hoá.
  const sealed = rotateChannelSecrets();
  if (sealed) console.log(`[notify] đã mã hoá ${sealed} bí mật kênh gửi.`);
  ensureXaScopeAssignments();
  // Kho có tổng tồn nhưng chưa có lô (seed) → lô tồn đầu kỳ có nguồn gốc đánh dấu (A03/R3).
  const openingLots = ensureOpeningLots();
  if (openingLots) console.log(`[warehouse] đã tạo ${openingLots} lô tồn đầu kỳ cho kho chưa có lô.`);
  const api = buildApi();

  // Tiến trình nền: quét cảnh báo mỗi 10 phút, gửi outbox mỗi 30 giây, dọn khoá
  // chống trùng quá hạn; leo thang nhiệm vụ quá SLA (KN US-TASK-02), theo dõi giá theo
  // ngưỡng (US-PRICE-04), chạy lịch gửi báo cáo (US-DASH-03). unref() để chúng không giữ
  // tiến trình sống khi tắt máy chủ.
  const scan = () => {
    try { runAlertScan(); purgeExpired(); purgeRateLimits(); } catch (error) { console.error('[notify] quét lỗi:', (error as Error).message); }
    try { escalateOverdueTasks(); scanWatchlists(); runDueReportSchedules(); } catch (error) { console.error('[brd] quét lỗi:', (error as Error).message); }
    // Retry đồng bộ đến hạn và snapshot mỗi ngày một lần — trước đây chỉ chạy khi gọi API (O02/A05).
    try { const r = processRetries(); if (r.retried || r.deadLettered) console.log(`[sync] retry: ${r.retried} chạy lại, ${r.recovered} hồi phục, ${r.deadLettered} dead-letter`); } catch (error) { console.error('[sync] retry lỗi:', (error as Error).message); }
    try { if (!one('SELECT 1 FROM daily_snapshots WHERE snapshot_date = ? LIMIT 1', [today()])) captureSnapshot(); } catch (error) { console.error('[audit] snapshot lỗi:', (error as Error).message); }
  };
  // Tác vụ nền đi qua khoá ghi để không chen vào giao dịch của một yêu cầu đang dở (A04).
  void withWriteLock(scan);
  setInterval(() => { void withWriteLock(scan); }, 10 * 60_000).unref();
  // Rà toàn vẹn CSDL mỗi ngày (bản ghi mồ côi xuyên miền, quick_check từng tệp) — nguyên tắc 4.
  setInterval(() => { void withWriteLock(() => { try { dailyIntegrityScan(); } catch (error) { console.error('[db] rà toàn vẹn lỗi:', (error as Error).message); } }); }, 60 * 60_000).unref();
  // Sao lưu tự động: BACKUP_INTERVAL_HOURS (mặc định 24, 0 = tắt), BACKUP_DIR, BACKUP_KEEP — nguyên tắc 11.
  const backupHours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
  if (backupHours > 0) {
    const runBackup = () => {
      try {
        const { dir, manifest, pruned } = backupAll({ keep: Number(process.env.BACKUP_KEEP ?? 14) });
        console.log(`[db] ${manifest.ok ? 'đã sao lưu' : 'SAO LƯU LỖI'} → ${dir} (${manifest.durationMs} ms${pruned.length ? `, xoá ${pruned.length} đợt cũ` : ''})`);
      } catch (error) { console.error('[db] sao lưu lỗi:', (error as Error).message); }
    };
    // Trong khoá ghi: 7 lệnh VACUUM INTO chạy liền nhau trên cùng kết nối, không có giao dịch nào chen giữa → điểm sao lưu nhất quán xuyên tệp.
    setTimeout(() => { void withWriteLock(runBackup); }, 5 * 60_000).unref();
    setInterval(() => { void withWriteLock(runBackup); }, backupHours * 3_600_000).unref();
  }
  setInterval(() => { withWriteLock(() => processOutbox()).catch((error) => console.error('[notify] outbox lỗi:', error.message)); }, 30_000).unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    applySecurityHeaders(req, res);
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
      await serveStatic(req, url.pathname, res);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, details: error.details ?? null });
        return;
      }
      // Lỗi nghiệp vụ (throw new Error trong service) trả 400 kèm thông điệp tiếng Việt; lỗi kỹ thuật
      // (ràng buộc CSDL, lỗi kiểu dữ liệu) được dịch sang thông điệp nghiệp vụ và ghi log máy chủ (UAT DEF-SYS-01).
      const { message, technical } = friendlyError(error);
      if (technical) console.error(`[api] ${req.method} ${url.pathname} lỗi kỹ thuật:`, technical);
      sendJson(res, technical ? 422 : 400, { error: message });
    }
  });

  await new Promise<void>((resolveStart) => server.listen(port, resolveStart));
  console.log(`\n  Mekong Green Platform đang chạy: http://localhost:${port}\n`);
  if (gateEnabled()) {
    console.log('  Cong ma truy cap DANG BAT (bien DEMO_ACCESS_CODE) - nguoi xem phai nhap ma truoc.');
  }
  console.log('  Đăng nhập bằng tài khoản Super Admin "SAdmin". Tài khoản trình diễn khác: xem README.md.\n');
}

/**
 * Đánh giá bảo mật 24/09/2026 (H-03): HTTP security header cho MỌI phản hồi (tĩnh lẫn API).
 * CSP: script chỉ từ chính máy chủ (Leaflet đã tự host), style cho phép inline vì giao diện đặt style động,
 * ảnh cho phép các máy chủ bản đồ nền, font từ Google Fonts. HSTS chỉ khi đang phục vụ qua HTTPS.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://*.tile.opentopomap.org https://server.arcgisonline.com",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
function applySecurityHeaders(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

async function serveStatic(req: import('node:http').IncomingMessage, pathname: string, res: import('node:http').ServerResponse): Promise<void> {
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
    // no-cache = trình duyệt phải hỏi lại máy chủ mỗi lần; không có thì JS cũ nằm lại sau khi triển khai bản mới.
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    // SPA fallback CHỈ cho yêu cầu điều hướng của trình duyệt (Accept: text/html, không có phần mở rộng tệp);
    // tài nguyên không tồn tại trả 404 thật để công cụ giám sát/quét không bị nhiễu (L-07).
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
    const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(pathname);
    if (!wantsHtml || looksLikeFile) {
      sendJson(res, 404, { error: 'Không tìm thấy tài nguyên', path: pathname });
      return;
    }
    try {
      const html = await readFile(join(WEB_ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      sendJson(res, 404, { error: 'Không tìm thấy tài nguyên', path: pathname });
    }
  }
}
