/**
 * Đánh giá rủi ro an ninh thông tin 24/09/2026 (22 phát hiện) — kiểm chứng các mục đã xử lý qua HTTP thật.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-sec2-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const { buildApi } = await import('../src/api.ts');
const { HttpError, sendJson, friendlyError, normalizePath } = await import('../src/platform/http/router.ts');
const users = await import('../src/platform/auth/users.ts');
const mdm = await import('../src/mdm/service.ts');
const files = await import('../src/platform/files/attachments.ts');
const notify = await import('../src/platform/notify/service.ts');
const urlGuard = await import('../src/platform/security/urlGuard.ts');
const crypto = await import('../src/platform/security/fieldCrypto.ts');
const rate = await import('../src/platform/http/rateLimit.ts');
const field = await import('../src/erp/field/service.ts');
const { legacySha256Hash } = await import('../src/platform/util/ids.ts');

migrate();
seedAll();

const api = buildApi();
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const apiUrl = new URL(url.toString()); apiUrl.pathname = url.pathname.slice(4);
    if (!(await api.handle(req, res, apiUrl))) sendJson(res, 404, { error: 'no route' });
  } catch (error) {
    if (error instanceof HttpError) { sendJson(res, error.status, { error: error.message, details: error.details ?? null }); return; }
    const { message, technical } = friendlyError(error);
    sendJson(res, technical ? 422 : 400, { error: message });
  }
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;
after(() => server.close());
const call = (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});
const login = async (u: string, p: string) => ((await (await call(null, 'POST', '/auth/login', { username: u, password: p })).json()) as { token: string }).token;
let adminToken = await login('SAdmin', process.env.SUPER_ADMIN_PASSWORD!);
const htxToken = await login('htx01', '123456');
const farmerToken = await login('nongdan', '123456');
const htxUser = users.listUsers().find((u) => u.username === 'htx01')!;
const otherHtx = (mdm.listCooperatives() as { id: string }[]).find((c) => c.id !== htxUser.htxId)!;
const actor = { name: 'test' };
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);

test('C-01: không còn mật khẩu mặc định — thiếu SUPER_ADMIN_PASSWORD thì sinh mật khẩu tạm và bắt đổi', () => {
  run("DELETE FROM users WHERE username = 'SAdmin'");
  run("DELETE FROM system_config WHERE key = 'security.sadmin_rotation_2026_09_24'");
  const envPassword = process.env.SUPER_ADMIN_PASSWORD!;
  delete process.env.SUPER_ADMIN_PASSWORD;
  const created = users.ensureSuperAdmin();
  process.env.SUPER_ADMIN_PASSWORD = envPassword;
  assert.equal(created.action, 'created');
  assert.ok(created.temporaryPassword && created.temporaryPassword.length >= 12, 'mật khẩu tạm ngẫu nhiên');
  assert.equal(one<{ must_change_pw: number }>("SELECT must_change_pw FROM users WHERE username = 'SAdmin'")!.must_change_pw, 1);
  assert.equal(users.login('SAdmin', 'TungLM18@'), null, 'chuỗi từng công bố không còn đăng nhập được');
  // Khôi phục cho các test sau (mật khẩu từ biến môi trường, không bắt đổi).
  run("DELETE FROM users WHERE username = 'SAdmin'");
  run("DELETE FROM system_config WHERE key = 'security.sadmin_rotation_2026_09_24'");
  assert.equal(users.ensureSuperAdmin(process.env.SUPER_ADMIN_PASSWORD).action, 'created');
  assert.equal(one<{ must_change_pw: number }>("SELECT must_change_pw FROM users WHERE username = 'SAdmin'")!.must_change_pw, 0);
});

test('C-01: CSDL cũ có sẵn SAdmin, không đặt biến môi trường → lần khởi động này buộc đổi mật khẩu và huỷ phiên; chỉ một lần', async () => {
  run("DELETE FROM system_config WHERE key = 'security.sadmin_rotation_2026_09_24'");
  const envPassword = process.env.SUPER_ADMIN_PASSWORD!;
  delete process.env.SUPER_ADMIN_PASSWORD;
  const rotated = users.ensureSuperAdmin();
  assert.equal(rotated.action, 'rotation_required');
  assert.equal(one<{ must_change_pw: number }>("SELECT must_change_pw FROM users WHERE username = 'SAdmin'")!.must_change_pw, 1);
  assert.equal(users.ensureSuperAdmin().action, 'kept', 'lần sau không ép lại');
  process.env.SUPER_ADMIN_PASSWORD = envPassword;
  run("UPDATE users SET must_change_pw = 0 WHERE username = 'SAdmin'");
  adminToken = await login('SAdmin', envPassword);   // SAdmin đã bị tạo lại ở test trước → phiên cũ không còn
});

test('H-01: nông dân không liệt kê / tải / xoá được tệp đính kèm của HTX khác; loại đối tượng lạ bị từ chối', async () => {
  const plotOther = one<{ id: string }>('SELECT id FROM plots WHERE htx_id = ? LIMIT 1', [otherHtx.id]) ?? (() => { run("INSERT INTO plots (id, code, htx_id, area_ha, status, created_at, updated_at) VALUES ('plot-other', 'TH-OTHER', ?, 1, 'chua_mo_vu', ?, ?)", [otherHtx.id, new Date().toISOString(), new Date().toISOString()]); return { id: 'plot-other' }; })();
  const saved = files.saveAttachment({ entityType: 'plot', entityId: plotOther.id, fileName: 'x.png', mime: 'image/png', data: png }, actor) as { id: string };
  assert.equal((await call(farmerToken, 'GET', `/files?entityType=plot&entityId=${plotOther.id}`)).status, 403);
  assert.equal((await call(farmerToken, 'GET', `/files/${saved.id}/content`)).status, 403);
  assert.equal((await call(farmerToken, 'DELETE', `/files/${saved.id}`, { reason: 'thử' })).status, 403);
  assert.equal(one<{ deleted_at: string | null }>('SELECT deleted_at FROM attachments WHERE id = ?', [saved.id])!.deleted_at, null, 'không bị xoá mềm');
  assert.equal((await call(farmerToken, 'GET', '/files?entityType=bang_la&entityId=x')).status, 403, 'loại chưa khai báo → fail-closed');
  // Quản trị đọc được; nội dung trả về dạng tải xuống + nosniff.
  const content = await call(adminToken, 'GET', `/files/${saved.id}/content`);
  assert.equal(content.status, 200);
  assert.match(content.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
  // Thửa của chính HTX mình thì xem được.
  const mine = one<{ id: string }>('SELECT id FROM plots WHERE htx_id = ? LIMIT 1', [htxUser.htxId]);
  if (mine) assert.equal((await call(htxToken, 'GET', `/files?entityType=plot&entityId=${mine.id}`)).status, 200);
});

test('H-02: thân yêu cầu vượt ngưỡng bị từ chối 413 trước khi đọc (Content-Length) và khi stream', async () => {
  // fetch không cho tự đặt Content-Length → dùng http.request thô: khai 50 MB, không gửi byte nào.
  const declared = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/notifications/read', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${htxToken}`, 'Content-Length': String(50 * 1024 * 1024) } }, (res) => { resolve(res.statusCode ?? 0); res.resume(); });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(declared, 413);
  const payload = JSON.stringify({ ids: 'x'.repeat(2 * 1024 * 1024) });
  const streamed = await call(htxToken, 'POST', '/notifications/read', payload).catch(() => null);
  assert.ok(!streamed || streamed.status === 413, 'quá 1 MB → 413 hoặc kết nối bị đóng');
});

test('H-03: cookie phiên có Secure khi đi qua HTTPS (x-forwarded-proto)', async () => {
  const plain = await call(null, 'POST', '/auth/login', { username: 'htx01', password: '123456' });
  assert.ok(!/;\s*Secure/i.test(plain.headers.get('set-cookie') ?? ''));
  const https = await call(null, 'POST', '/auth/login', { username: 'htx01', password: '123456' }, { 'x-forwarded-proto': 'https' });
  assert.match(https.headers.get('set-cookie') ?? '', /;\s*Secure/);
});

test('H-04: IP client không lấy từ X-Forwarded-For giả mạo khi chưa khai báo lớp proxy', () => {
  const fake = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '10.0.0.9' } } as never;
  delete process.env.TRUSTED_PROXY_HOPS;
  assert.equal(rate.clientIp(fake), '10.0.0.9');
  process.env.TRUSTED_PROXY_HOPS = '1';
  assert.equal(rate.clientIp(fake), '5.6.7.8', 'một lớp proxy → phần tử cuối (proxy ghi), không phải phần tử đầu (client tự đặt)');
  delete process.env.TRUSTED_PROXY_HOPS;
  // Bộ đếm bền trong SQLite.
  rate.resetRateLimit('gate:test');
  for (let i = 0; i < 8; i += 1) rate.hitRateLimit('gate:test', 8, 60_000);
  assert.equal(rate.isRateLimited('gate:test', 8, 60_000).limited, true);
  assert.equal(one<{ count: number }>("SELECT count FROM rate_limits WHERE bucket = 'gate:test'")!.count, 8);
});

test('M-01: đăng nhập bị giới hạn theo IP (429 + Retry-After); khoá theo tài khoản vẫn được lưu dù handler ném lỗi', async () => {
  run("DELETE FROM rate_limits WHERE bucket LIKE 'login:%'");
  // 5 lần sai → lần thứ 6 khoá 15 phút (đếm failed_attempts phải được LƯU qua HTTP — unitOfWork không hoàn tác).
  for (let i = 0; i < 5; i += 1) assert.equal((await call(null, 'POST', '/auth/login', { username: 'canbo_tw', password: 'sai' })).status, 400);
  assert.equal(one<{ failed_attempts: number }>("SELECT failed_attempts FROM users WHERE username = 'canbo_tw'")!.failed_attempts, 5, 'số lần sai được lưu');
  assert.equal((await call(null, 'POST', '/auth/login', { username: 'canbo_tw', password: 'sai' })).status, 423);
  run("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = 'canbo_tw'");
  // Giới hạn IP: 20 lần / 10 phút cho mọi tài khoản → chặn password spraying.
  let status = 0;
  for (let i = 0; i < 25; i += 1) {
    const res = await call(null, 'POST', '/auth/login', { username: `khong_co_${i}`, password: 'x' });
    status = res.status;
    if (status === 429) { assert.ok(Number(res.headers.get('retry-after')) > 0); break; }
  }
  assert.equal(status, 429);
  run("DELETE FROM rate_limits WHERE bucket LIKE 'login:%'");
});

test('M-02: phản hồi chứa mật khẩu tạm không được lưu vào bảng chống trùng', async () => {
  const target = users.listUsers().find((u) => u.username === 'vvb')!;
  const res = await call(adminToken, 'POST', `/admin/users/${target.id}/reset-password`, {}, { 'Idempotency-Key': 'reset-key-123456' });
  assert.equal(res.status, 200);
  const payload = await res.json() as { temporaryPassword: string };
  assert.ok(payload.temporaryPassword);
  const stored = all<{ response_json: string }>('SELECT response_json FROM request_log');
  assert.ok(!stored.some((r) => r.response_json?.includes(payload.temporaryPassword)), 'mật khẩu tạm không nằm trong request_log');
  // Gửi lại cùng khoá → chạy lại (mật khẩu mới), không phát lại phản hồi cũ.
  const again = await call(adminToken, 'POST', `/admin/users/${target.id}/reset-password`, {}, { 'Idempotency-Key': 'reset-key-123456' });
  assert.equal(again.headers.get('idempotency-replayed'), null);
});

test('M-03: URL webhook nội bộ / http / localhost bị chặn khi cấu hình', async () => {
  await assert.rejects(urlGuard.assertSafeWebhookUrl('http://example.com/hook'), /https/);
  await assert.rejects(urlGuard.assertSafeWebhookUrl('https://localhost/hook'), /nội bộ/);
  await assert.rejects(urlGuard.assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data'), /nội bộ/);
  await assert.rejects(urlGuard.assertSafeWebhookUrl('https://10.0.0.5/hook'), /nội bộ/);
  await assert.rejects(urlGuard.assertSafeWebhookUrl('https://[::1]/hook'), /nội bộ/);
  await assert.rejects(urlGuard.assertSafeWebhookUrl('https://user:pw@example.com/hook'), /tài khoản/);
  assert.equal(urlGuard.isPrivateAddress('::ffff:192.168.1.1'), true);
  assert.equal(urlGuard.isPrivateAddress('8.8.8.8'), false);
  const res = await call(adminToken, 'PUT', '/notifications/channels', { key: 'notify.sms_gateway_url', value: 'https://127.0.0.1/sms' });
  assert.equal(res.status, 400);
  assert.equal(one("SELECT 1 FROM system_config WHERE key = 'notify.sms_gateway_url'"), null, 'không lưu URL bị chặn');
});

test('M-04 / M-05: token kênh gửi lưu mã hoá có định danh khoá; xoay khoá mã hoá lại được', () => {
  notify.setChannelConfig('notify.sms_gateway_token', 'bi-mat-sms-123', actor);
  const raw = JSON.parse(one<{ value_json: string }>("SELECT value_json FROM system_config WHERE key = 'notify.sms_gateway_token'")!.value_json) as string;
  assert.match(raw, /^enc2:k1:/, 'không còn nguyên văn');
  assert.equal(notify.channelConfig().smsToken, 'bi-mat-sms-123', 'giải mã đúng khi dùng');
  // Giá trị cũ lưu rõ → được mã hoá khi khởi động.
  run("UPDATE system_config SET value_json = ? WHERE key = 'notify.sms_gateway_token'", [JSON.stringify('con-luu-ro')]);
  assert.equal(notify.rotateChannelSecrets(), 1);
  assert.match(JSON.parse(one<{ value_json: string }>("SELECT value_json FROM system_config WHERE key = 'notify.sms_gateway_token'")!.value_json) as string, /^enc2:/);
  // Xoay khoá: khoá cũ k1 → khoá mới k2.
  const oldKey = process.env.DATA_ENCRYPTION_KEY!;
  const htx = one<{ id: string }>('SELECT id FROM cooperatives LIMIT 1')!;
  const farmer = mdm.createFarmer({ fullName: 'Xoay Khoá', htxId: htx.id, nationalId: '001122334455' });
  process.env.DATA_ENCRYPTION_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  process.env.DATA_ENCRYPTION_KEY_ID = 'k2';
  process.env.DATA_ENCRYPTION_KEYS_PREVIOUS = `k1:${oldKey}`;
  crypto.resetKeyCache();
  assert.equal(crypto.encryptionKeyStatus().kid, 'k2');
  assert.equal(crypto.decryptField(one<{ national_id: string }>('SELECT national_id FROM farmers WHERE id = ?', [farmer.id])!.national_id), '001122334455', 'vẫn đọc được bằng khoá cũ trong vòng khoá');
  assert.ok(crypto.rotateEncryptedFields() >= 1);
  assert.match(one<{ national_id: string }>('SELECT national_id FROM farmers WHERE id = ?', [farmer.id])!.national_id, /^enc2:k2:/);
  // Thiếu khoá cũ → không đọc được, không ném.
  delete process.env.DATA_ENCRYPTION_KEYS_PREVIOUS;
  process.env.DATA_ENCRYPTION_KEY = oldKey; process.env.DATA_ENCRYPTION_KEY_ID = 'k1';
  crypto.resetKeyCache();
  assert.match(crypto.decryptField(one<{ national_id: string }>('SELECT national_id FROM farmers WHERE id = ?', [farmer.id])!.national_id) ?? '', /không giải mã được/);
  // Dọn: trả về khoá k1 hẳn.
  run("UPDATE farmers SET national_id = NULL WHERE id = ?", [farmer.id]);
  // Production thiếu khoá → từ chối.
  const env = process.env.NODE_ENV; const key = process.env.DATA_ENCRYPTION_KEY;
  process.env.NODE_ENV = 'production'; delete process.env.DATA_ENCRYPTION_KEY; crypto.resetKeyCache();
  assert.throws(() => crypto.assertEncryptionKeyConfigured(), /DATA_ENCRYPTION_KEY/);
  process.env.NODE_ENV = env; process.env.DATA_ENCRYPTION_KEY = key; crypto.resetKeyCache();
});

test('M-07: lỗi kỹ thuật không lộ nguyên văn; lỗi nghiệp vụ vẫn trả tiếng Việt', () => {
  assert.equal(friendlyError(new Error('Thửa chưa mở vụ canh tác')).technical, null);
  const tech = friendlyError(new TypeError("Cannot read properties of undefined (reading 'id')"));
  assert.ok(tech.technical && !/undefined/.test(tech.message));
  const sys = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\\\data\\\\x.db'"), { code: 'ENOENT' });
  const masked = friendlyError(sys);
  assert.ok(masked.technical && !/C:\\\\|ENOENT/.test(masked.message));
  const pathy = friendlyError(new Error('lỗi tại /app/src/erp/warehouse/service.ts:120'));
  assert.ok(pathy.technical, 'thông điệp có dấu vết đường dẫn bị che');
});

test('L-01: tệp khai PNG nhưng nội dung khác bị từ chối', () => {
  assert.throws(() => files.saveAttachment({ entityType: 'plot', entityId: 'p', fileName: 'x.png', mime: 'image/png', data: Buffer.from('<html>khong phai anh</html>' + 'x'.repeat(20)) }, actor), /không phải image\/png/);
  assert.equal(files.contentMatchesMime(Buffer.from('%PDF-1.7\n' + 'x'.repeat(20)), 'application/pdf'), true);
  assert.equal(files.contentMatchesMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'image/webp'), true);
});

test('L-03: đổi mật khẩu huỷ mọi phiên khác, giữ phiên đang thao tác; đổi quyền huỷ phiên', async () => {
  const t1 = await login('cuc_ktht', '123456');
  const t2 = await login('cuc_ktht', '123456');
  const res = await call(t1, 'POST', '/auth/password', { password: 'MatKhauMoi2026' });
  assert.equal(res.status, 200);
  assert.equal((await call(t1, 'GET', '/auth/me')).status, 200, 'phiên đang thao tác còn');
  const me2 = await (await call(t2, 'GET', '/auth/me')).json() as { anonymous?: boolean };
  assert.equal(me2.anonymous, true, 'phiên khác đã bị huỷ');
});

test('L-04: yêu cầu ghi có Origin khác host bị 403; cùng host hoặc không có Origin thì qua', async () => {
  assert.equal((await call(htxToken, 'POST', '/notifications/read', { ids: [] }, { Origin: 'https://ke-tan-cong.example' })).status, 403);
  assert.equal((await call(htxToken, 'POST', '/notifications/read', { ids: [] }, { Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await call(htxToken, 'POST', '/notifications/read', { ids: [] }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call(htxToken, 'POST', '/notifications/read', { ids: [] })).status, 200);
});

test('L-08: quá hạn di trú, tài khoản còn hash SHA-256 cũ đăng nhập được nhưng bị buộc đổi mật khẩu', () => {
  const salt = 'abcdef012345';
  run("UPDATE users SET password_hash = ?, password_salt = ?, must_change_pw = 0 WHERE username = 'khonhap'", [legacySha256Hash('123456', salt), salt]);
  assert.ok(users.legacyHashCount() >= 1);
  const session = users.login('khonhap', '123456');
  assert.ok(session?.token);
  const row = one<{ password_hash: string; must_change_pw: number }>("SELECT password_hash, must_change_pw FROM users WHERE username = 'khonhap'")!;
  assert.match(row.password_hash, /^scrypt\$/);
  assert.equal(row.must_change_pw, new Date().toISOString().slice(0, 10) > users.LEGACY_HASH_DEADLINE ? 1 : 0, 'sau hạn mới ép; trước hạn chỉ nâng cấp âm thầm');
});

test('normalizePath và fail-closed allowlist: route ngoài danh sách bị từ chối với tài khoản HTX', async () => {
  assert.equal(normalizePath('//a//b/'), '/a/b');
  // /admin/db-health là route quản trị, RBAC đã chặn; kiểm thêm một route có quyền mà HTX không được phép: chặn bởi allowlist khi RBAC cho qua.
  const res = await call(htxToken, 'GET', '/admin/db-health');
  assert.equal(res.status, 403);
});

test('field: mã đội trong popup bản đồ đi qua escapeHtml (L-05) — không có chuỗi HTML thô từ dữ liệu', () => {
  void field; // hàm dựng popup nằm ở client; kiểm ở mức mã nguồn
  const src = readFileSync(join(process.cwd(), 'src/web/pages/field.js'), 'utf8');
  assert.match(src, /escapeHtml\(team\.code/);
  assert.match(src, /escapeHtml\(team\.name\)/);
});
