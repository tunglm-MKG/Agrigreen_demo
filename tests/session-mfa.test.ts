/**
 * Đánh giá sẵn sàng cấp độ 3 (24/09/2026) — các khoảng trống còn lại sau ba đợt sửa trước:
 *   SEC-06 phiên: logout thu hồi đúng credential đang dùng; token lưu dạng digest; hết hạn rảnh; đổi mật khẩu huỷ phiên khác;
 *   MFA TOTP: đăng ký, xác minh, phiên chờ mã bị chặn, bắt buộc cho quản trị khi MFA_ENFORCE=1, quản trị đặt lại;
 *   xác nhận lại danh tính trước hành động nhạy cảm (reauth_required);
 *   SEC-05 loginAsync; SEC-07 giới hạn giải nén ZIP; SEC-08 nhật ký có request id / IP / tenant; SEC-09 sao lưu kèm tệp;
 *   SEC-04 không tự mở khoá SAdmin khi khởi động.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

const base0 = mkdtempSync(join(tmpdir(), 'mekong-l3-'));
configureDatabase(join(base0, 'test.db'));
process.env.UPLOAD_DIR = join(base0, 'uploads');
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const { buildApi } = await import('../src/api.ts');
const { HttpError, sendJson } = await import('../src/platform/http/router.ts');
const users = await import('../src/platform/auth/users.ts');
const totp = await import('../src/platform/auth/totp.ts');
const zip = await import('../src/platform/io/zip.ts');
const backup = await import('../src/platform/db/backup.ts');

migrate();
seedAll();

const api = buildApi();
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const apiUrl = new URL(url.toString()); apiUrl.pathname = url.pathname.slice(4);
    if (!(await api.handle(req, res, apiUrl))) sendJson(res, 404, { error: 'no route' });
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.status : 400, { error: (error as Error).message, details: error instanceof HttpError ? error.details ?? null : null });
  }
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(() => server.close());
const call = (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const cookieCall = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', Cookie: `mg_session=${cookie}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (res: Response) => res.json() as Promise<Record<string, any>>;
const login = async (u: string, p: string) => (await json(await call(null, 'POST', '/auth/login', { username: u, password: p }))) as { token: string; mfaRequired: boolean };
const byName = (u: string) => users.listUsers().find((x) => x.username === u)!;

test('SEC-06: đăng xuất thu hồi đúng cookie/bearer đang dùng; token trong CSDL là digest, không phải token thô', async () => {
  const { token } = await login('cuc_ktht', '123456');
  assert.equal(one('SELECT 1 FROM sessions WHERE token = ?', [token]), null, 'không lưu token thô');
  assert.ok(one('SELECT 1 FROM sessions WHERE token = ?', [users.tokenDigest(token)]), 'lưu digest');
  assert.equal(((await json(await cookieCall(token, 'GET', '/auth/me'))) as { username?: string }).username, 'cuc_ktht');
  // Đăng xuất bằng cookie với body rỗng (đúng cách frontend gọi) → phiên bị thu hồi ở máy chủ.
  assert.equal((await cookieCall(token, 'POST', '/auth/logout', {})).status, 200);
  assert.equal(((await json(await cookieCall(token, 'GET', '/auth/me'))) as { anonymous?: boolean }).anonymous, true, 'cookie cũ không còn xác thực');
});

test('SEC-06: phiên hết hạn rảnh sau SESSION_IDLE_MINUTES; đổi mật khẩu huỷ mọi phiên khác', async () => {
  const { token } = await login('vvb', '123456');
  run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', [new Date(Date.now() - (users.SESSION_IDLE_MINUTES + 5) * 60_000).toISOString(), users.tokenDigest(token)]);
  assert.equal(((await json(await call(token, 'GET', '/auth/me'))) as { anonymous?: boolean }).anonymous, true, 'phiên rảnh quá lâu bị huỷ');
  const a = await login('vvb', '123456');
  const b = await login('vvb', '123456');
  assert.equal((await call(a.token, 'POST', '/auth/password', { password: 'MatKhauMoi2026' })).status, 200);
  assert.equal(((await json(await call(a.token, 'GET', '/auth/me'))) as { username?: string }).username, 'vvb', 'phiên đang thao tác giữ');
  assert.equal(((await json(await call(b.token, 'GET', '/auth/me'))) as { anonymous?: boolean }).anonymous, true, 'phiên khác bị huỷ');
});

test('MFA: đăng ký TOTP, phiên sau đăng nhập ở trạng thái chờ mã và bị chặn tới khi nhập đúng; chống phát lại mã', async () => {
  const { token } = await login('dieuphoi', '123456');
  const setup = await json(await call(token, 'POST', '/auth/mfa/setup', {}));
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal((await call(token, 'POST', '/auth/mfa/enable', { code: '000000' })).status, 400, 'mã sai không bật được');
  assert.equal((await call(token, 'POST', '/auth/mfa/enable', { code: totp.totp(setup.secret) })).status, 200);
  assert.equal(one<{ mfa_enabled: number; mfa_secret: string }>("SELECT mfa_enabled, mfa_secret FROM users WHERE username = 'dieuphoi'")!.mfa_enabled, 1);
  assert.match(one<{ mfa_secret: string }>("SELECT mfa_secret FROM users WHERE username = 'dieuphoi'")!.mfa_secret, /^enc2:/, 'bí mật lưu mã hoá');
  // Đăng nhập lại: mật khẩu đúng → chờ mã; nghiệp vụ bị chặn.
  const second = await login('dieuphoi', '123456');
  assert.equal(second.mfaRequired, true);
  const blocked = await call(second.token, 'GET', '/tms/trips');
  assert.equal(blocked.status, 403);
  assert.equal((await json(blocked)).details?.code, 'mfa_required');
  assert.equal((await call(second.token, 'POST', '/auth/mfa/verify', { code: '123456' })).status, 400);
  // Mã của bước hiện tại đã dùng lúc đăng ký (chống phát lại) → dùng mã của bước kế tiếp (vẫn trong cửa sổ ±1).
  const code = totp.totp(setup.secret, Date.now() + 30_000);
  assert.equal((await call(second.token, 'POST', '/auth/mfa/verify', { code })).status, 200);
  assert.equal((await call(second.token, 'GET', '/auth/me').then(json)).mfaPending, false);
  // Cùng mã không dùng lại được cho phiên khác (chống phát lại).
  const third = await login('dieuphoi', '123456');
  assert.equal((await call(third.token, 'POST', '/auth/mfa/verify', { code })).status, 400, 'mã đã dùng bị từ chối');
  // Quản trị đặt lại MFA → người dùng đăng nhập không còn chờ mã, phải đăng ký lại nếu bắt buộc.
  const adminToken = (await login('SAdmin', process.env.SUPER_ADMIN_PASSWORD!)).token;
  assert.equal((await call(adminToken, 'POST', `/admin/users/${byName('dieuphoi').id}/mfa-reset`, {})).status, 200);
  assert.equal((await login('dieuphoi', '123456')).mfaRequired, false);
});

test('MFA bắt buộc cho quản trị khi MFA_ENFORCE=1: chưa đăng ký thì chỉ mở đường đăng ký; người dùng thường không bị ép', async () => {
  process.env.MFA_ENFORCE = '1';
  try {
    const admin = await login('qtri_kn', '123456');
    const me = await json(await call(admin.token, 'GET', '/auth/me'));
    assert.equal(me.mfaEnrollmentRequired, true);
    const blocked = await call(admin.token, 'GET', '/admin/users');
    assert.equal(blocked.status, 403);
    assert.equal((await json(blocked)).details?.code, 'mfa_enrollment_required');
    const setup = await json(await call(admin.token, 'POST', '/auth/mfa/setup', {}));
    assert.equal((await call(admin.token, 'POST', '/auth/mfa/enable', { code: totp.totp(setup.secret) })).status, 200);
    assert.equal((await call(admin.token, 'GET', '/admin/users')).status, 200, 'đăng ký xong thì làm việc bình thường');
    assert.equal((await call(admin.token, 'POST', '/auth/mfa/disable', {})).status, 403, 'quản trị không tắt được MFA');
    const farmer = await login('nongdan', '123456');
    assert.equal((await json(await call(farmer.token, 'GET', '/auth/me'))).mfaEnrollmentRequired, false);
  } finally {
    delete process.env.MFA_ENFORCE;
    users.resetMfa(byName('qtri_kn').id, { name: 'test' });
  }
});

test('Xác nhận lại danh tính: hành động nhạy cảm sau REAUTH_MINUTES đòi mật khẩu lại; /auth/reauth làm mới', async () => {
  const admin = await login('SAdmin', process.env.SUPER_ADMIN_PASSWORD!);
  const target = byName('banlanhdao');
  assert.equal((await call(admin.token, 'POST', `/admin/users/${target.id}/revoke-sessions`, {})).status, 200, 'vừa đăng nhập → không hỏi lại');
  run('UPDATE sessions SET auth_at = ? WHERE token = ?', [new Date(Date.now() - 60 * 60_000).toISOString(), users.tokenDigest(admin.token)]);
  const stale = await call(admin.token, 'POST', `/admin/users/${target.id}/revoke-sessions`, {});
  assert.equal(stale.status, 403);
  assert.equal((await json(stale)).details?.code, 'reauth_required');
  assert.equal((await call(admin.token, 'GET', '/admin/users')).status, 200, 'đọc không bị ảnh hưởng');
  assert.equal((await call(admin.token, 'POST', '/auth/reauth', { password: 'sai' })).status, 400);
  assert.equal((await call(admin.token, 'POST', '/auth/reauth', { password: process.env.SUPER_ADMIN_PASSWORD })).status, 200);
  assert.equal((await call(admin.token, 'POST', `/admin/users/${target.id}/revoke-sessions`, {})).status, 200);
});

test('SEC-08: nhật ký ghi trong yêu cầu HTTP mang request id, IP và tenant; phản hồi có X-Request-Id', async () => {
  const htx = await login('htx01', '123456');
  const res = await call(htx.token, 'POST', '/htx/farmers', { fullName: 'Nông hộ truy vết', phone: '0912345678' });
  assert.equal(res.status, 200);
  const requestId = res.headers.get('x-request-id');
  assert.ok(requestId && requestId.length >= 32);
  const row = one<{ actor_ip: string; tenant_id: string }>("SELECT actor_ip, tenant_id FROM event_log WHERE request_id = ? AND entity_type = 'farmers'", [requestId]);
  assert.ok(row, 'sự kiện gắn request id của yêu cầu');
  assert.equal(row!.tenant_id, byName('htx01').htxId);
  assert.ok(row!.actor_ip);
});

test('SEC-07: ZIP có tỷ lệ nén bất thường hoặc kích thước khai báo sai bị từ chối trước khi cạn bộ nhớ', () => {
  const entries = [{ name: 'a.xml', compressionMethod: 8, compressedSize: 1000, uncompressedSize: 1000 * 1000, localHeaderOffset: 0 }];
  assert.throws(() => zip.assertZipSafe(entries as never), /tỷ lệ nén bất thường/);
  assert.throws(() => zip.assertZipSafe([{ ...entries[0], compressedSize: 10 ** 7, uncompressedSize: 10 ** 9 }] as never), /vượt giới hạn/);
  assert.throws(() => zip.assertZipSafe(Array.from({ length: 6000 }, (_, i) => ({ ...entries[0], name: `f${i}`, uncompressedSize: 10 })) as never), /6000 mục/);
  // Mục khai 10 byte nhưng thật ra giải nén 1 MB → bị chặn bởi maxOutputLength / đối chiếu kích thước.
  const payload = Buffer.alloc(1024 * 1024, 65);
  const deflated = deflateRawSync(payload);
  const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(22), Buffer.from([0, 0, 0, 0])]); // local header, name/extra len = 0
  const buffer = Buffer.concat([local, deflated]);
  assert.throws(() => zip.readZipFile(buffer, { name: 'x', compressionMethod: 8, compressedSize: deflated.length, uncompressedSize: 10, localHeaderOffset: 0 }), /khác kích thước|maxOutputLength|Cannot create a Buffer|buffer/i);
});

test('SEC-09: sao lưu kèm tệp đính kèm và định danh khoá mã hoá; khôi phục trả lại tệp', () => {
  const uploadDir = process.env.UPLOAD_DIR!;
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });
  writeFileSync(join(uploadDir, 'anh-test.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const dir = mkdtempSync(join(tmpdir(), 'mekong-l3-bk-'));
  const out = backup.backupAll({ dir, keep: 3 });
  assert.equal(out.manifest.ok, true);
  assert.ok(out.manifest.uploads && out.manifest.uploads.files >= 1, 'manifest ghi tệp đính kèm');
  assert.equal(out.manifest.encryptionKeyId, 'k1');
  assert.ok(existsSync(join(out.dir, 'uploads', 'anh-test.png')));
  const target = mkdtempSync(join(tmpdir(), 'mekong-l3-rs-'));
  const { restored } = backup.restoreBackup(out.dir, join(target, 'mekonggreen.db'));
  assert.ok(restored.some((p) => p.endsWith('uploads')));
  assert.ok(existsSync(join(target, 'uploads', 'anh-test.png')));
});

test('SEC-04: khởi động không tự mở khoá SAdmin đang bị khoá', () => {
  const sadmin = byName('SAdmin');
  run("UPDATE users SET status = 'locked' WHERE id = ?", [sadmin.id]);
  users.ensureSuperAdmin(process.env.SUPER_ADMIN_PASSWORD);
  assert.equal(one<{ status: string }>('SELECT status FROM users WHERE id = ?', [sadmin.id])!.status, 'locked', 'vẫn khoá — người vận hành phải chủ động mở');
  run("UPDATE users SET status = 'active' WHERE id = ?", [sadmin.id]);
});

test('TOTP: mã đúng theo RFC 6238 (vector kiểm thử SHA-1) và cửa sổ ±1 bước', () => {
  // RFC 6238 phụ lục B với bí mật "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ), 8 số → lấy 6 số cuối.
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.hotp(secret, 1, 8), '94287082'.slice(-8));
  assert.equal(totp.hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  const now = Date.now();
  assert.ok(totp.verifyTotp(secret, totp.totp(secret, now - 30_000), { atMs: now }) !== null, 'bước trước vẫn hợp lệ');
  assert.equal(totp.verifyTotp(secret, totp.totp(secret, now - 120_000), { atMs: now }), null, 'quá cửa sổ thì không');
  assert.equal(totp.verifyTotp(secret, 'abcdef'), null);
});
