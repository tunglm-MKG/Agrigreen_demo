/**
 * Yêu cầu 24/09/2026: mỗi lần khởi động lại hệ thống và mỗi lần đặt lại mật khẩu SAdmin thì gửi email
 * đặt lại (liên kết một lần, không chứa mật khẩu) tới SADMIN_RESET_EMAIL (mặc định tunglm@mekonggreen.vn).
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

const base0 = mkdtempSync(join(tmpdir(), 'mekong-reset-'));
configureDatabase(join(base0, 'test.db'));
process.env.MAIL_OUTBOX_DIR = join(base0, 'outbox');
process.env.APP_BASE_URL = 'https://agrigreen.example.vn/';
delete process.env.SMTP_HOST;
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const { buildApi } = await import('../src/api.ts');
const { HttpError, sendJson } = await import('../src/platform/http/router.ts');
const users = await import('../src/platform/auth/users.ts');
const reset = await import('../src/platform/auth/passwordReset.ts');
const mailer = await import('../src/platform/notify/mailer.ts');

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
const call = (token: string | null, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (res: Response) => res.json() as Promise<Record<string, any>>;
const login = async (u: string, p: string) => (await json(await call(null, 'POST', '/auth/login', { username: u, password: p }))) as { token?: string; error?: string };
const outboxFiles = () => (existsSync(process.env.MAIL_OUTBOX_DIR!) ? readdirSync(process.env.MAIL_OUTBOX_DIR!).filter((f) => f.endsWith('.eml')).sort() : []);

test('địa chỉ nhận mặc định là tunglm@mekonggreen.vn; SADMIN_RESET_EMAIL ghi đè hoặc tắt', () => {
  assert.equal(reset.superAdminResetEmail({}), 'tunglm@mekonggreen.vn');
  assert.equal(reset.superAdminResetEmail({ SADMIN_RESET_EMAIL: 'ops@mekonggreen.vn' }), 'ops@mekonggreen.vn');
  assert.equal(reset.superAdminResetEmail({ SADMIN_RESET_EMAIL: '' }), null);
  assert.equal(reset.superAdminResetEmail({ SADMIN_RESET_EMAIL: '0' }), null);
});

test('khởi động: gửi email đặt lại SAdmin — không có SMTP thì rơi vào outbox tệp; thư chứa liên kết một lần, KHÔNG chứa mật khẩu', async () => {
  const before = outboxFiles().length;
  const r = await reset.sendSuperAdminResetEmail('startup');
  assert.equal(r.to, 'tunglm@mekonggreen.vn');
  assert.equal(r.transport, 'outbox');
  assert.equal(r.sent, false, 'chưa cấu hình SMTP → báo rõ là chưa gửi được');
  const files = outboxFiles();
  assert.equal(files.length, before + 1);
  const eml = readFileSync(join(process.env.MAIL_OUTBOX_DIR!, files.at(-1)!), 'utf8');
  assert.match(eml, /^To: tunglm@mekonggreen\.vn\r$/m);
  assert.match(eml, /^Subject: =\?UTF-8\?B\?/m, 'tiêu đề có dấu được mã hoá RFC 2047');
  const link = /https:\/\/agrigreen\.example\.vn\/\?reset=([A-Za-z0-9_-]+)/.exec(eml);
  assert.ok(link, 'có liên kết đặt lại theo APP_BASE_URL');
  assert.doesNotMatch(eml, new RegExp(process.env.SUPER_ADMIN_PASSWORD!), 'thư không chứa mật khẩu');
  // CSDL chỉ lưu digest, không lưu token thô.
  assert.equal(one('SELECT 1 FROM password_resets WHERE token_digest = ?', [link![1]]), null);
  const row = one<{ reason: string; used_at: string | null }>("SELECT reason, used_at FROM password_resets WHERE user_id = (SELECT id FROM users WHERE username = 'SAdmin') ORDER BY created_at DESC LIMIT 1");
  assert.equal(row?.reason, 'startup');
  assert.equal(row?.used_at, null);
  // Có nhật ký, không có token trong nhật ký.
  const events = all<{ note: string; after_json: string | null }>("SELECT note, after_json FROM event_log WHERE note LIKE 'sadmin_reset_email:%' OR note LIKE 'password_reset_link_issued:%'");
  assert.ok(events.length >= 2);
  assert.ok(events.every((e) => !(e.after_json ?? '').includes(link![1])));
});

test('liên kết: sai/hết hạn/đã dùng bị từ chối; dùng đúng → mật khẩu mới, mở khoá, huỷ phiên; mật khẩu cũ vẫn dùng được tới khi dùng liên kết', async () => {
  const admin = one<{ id: string }>("SELECT id FROM users WHERE username = 'SAdmin'")!;
  // Khoá tài khoản giả lập + phiên đang mở.
  run("UPDATE users SET status = 'locked', failed_attempts = 5, locked_until = '2099-01-01T00:00:00Z' WHERE id = ?", [admin.id]);
  const { token } = reset.issueResetToken(admin.id, 'operator_reset');
  assert.throws(() => reset.completeReset('khong-hop-le', 'MatKhauMoi2026'), /không hợp lệ/);
  assert.throws(() => reset.completeReset(token, 'yeu'), /mật khẩu/i, 'mật khẩu yếu bị chặn, token chưa bị tiêu');
  const expired = reset.issueResetToken(admin.id, 'operator_reset', -1);
  assert.throws(() => reset.completeReset(expired.token, 'MatKhauMoi2026'), /hết hạn/);
  const done = reset.completeReset(token, 'MatKhauMoi2026', { ip: '10.0.0.9' });
  assert.equal(done.username, 'SAdmin');
  const u = one<{ status: string; failed_attempts: number; locked_until: string | null; must_change_pw: number }>('SELECT status, failed_attempts, locked_until, must_change_pw FROM users WHERE id = ?', [admin.id])!;
  assert.deepEqual({ ...u }, { status: 'active', failed_attempts: 0, locked_until: null, must_change_pw: 0 });
  assert.equal(one('SELECT 1 FROM sessions WHERE user_id = ?', [admin.id]), null, 'mọi phiên bị huỷ');
  assert.throws(() => reset.completeReset(token, 'MatKhauKhac2026'), /đã được dùng/, 'một lần');
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND used_at IS NULL', [admin.id])!.n, 0, 'các liên kết khác cũng mất hiệu lực');
  // Đăng nhập bằng mật khẩu mới.
  const ok = await login('SAdmin', 'MatKhauMoi2026');
  assert.ok(ok.token, 'đăng nhập được bằng mật khẩu mới');
  process.env.SUPER_ADMIN_PASSWORD = 'MatKhauMoi2026';
});

test('HTTP: POST /auth/reset-password/complete công khai, trả mã lỗi rõ, giới hạn theo IP', async () => {
  const admin = one<{ id: string }>("SELECT id FROM users WHERE username = 'SAdmin'")!;
  const bad = await call(null, 'POST', '/auth/reset-password/complete', { token: 'x', password: 'MatKhauMoi2027' });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).details?.code, 'invalid');
  const { token } = reset.issueResetToken(admin.id, 'startup');
  const good = await call(null, 'POST', '/auth/reset-password/complete', { token, password: 'MatKhauMoi2027' });
  const goodBody = await json(good);
  assert.equal(good.status, 200, JSON.stringify(goodBody));
  assert.equal(goodBody.username, 'SAdmin');
  assert.ok((await login('SAdmin', 'MatKhauMoi2027')).token);
  process.env.SUPER_ADMIN_PASSWORD = 'MatKhauMoi2027';
  const again = await call(null, 'POST', '/auth/reset-password/complete', { token, password: 'MatKhauMoi2028' });
  assert.equal((await json(again)).details?.code, 'used');
  // 10 lần / 15 phút theo IP.
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call(null, 'POST', '/auth/reset-password/complete', { token: `sai-${i}`, password: 'MatKhauMoi2029' })).status;
  assert.equal(last, 429);
});

test('SMTP: máy khách gửi đúng EHLO/MAIL/RCPT/DATA tới máy chủ SMTP (giả lập, không TLS), dot-stuffing và UTF-8', async () => {
  const received: string[] = [];
  let data = '';
  const smtp = createTcpServer((socket: Socket) => {
    let inData = false;
    socket.write('220 test.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (inData) {
        data += text;
        if (data.endsWith('\r\n.\r\n')) { inData = false; socket.write('250 2.0.0 OK queued as 42\r\n'); }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        received.push(line);
        if (line.startsWith('EHLO')) socket.write('250-test.local\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
        else if (line.startsWith('RCPT TO')) socket.write('250 OK\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (line === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
        else socket.write('500 ?\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  after(() => smtp.close());
  const port = (smtp.address() as { port: number }).port;
  const config = mailer.smtpConfig({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_STARTTLS: '0', SMTP_FROM: 'no-reply@mekonggreen.vn' })!;
  const detail = await mailer.sendViaSmtp({ to: 'tunglm@mekonggreen.vn', subject: 'Đặt lại mật khẩu', text: 'Dòng 1\n.bắt đầu bằng dấu chấm\nHết' }, config);
  assert.match(detail, /queued as 42/);
  assert.ok(received.some((l) => l.startsWith('EHLO ')));
  assert.ok(received.includes('MAIL FROM:<no-reply@mekonggreen.vn> SMTPUTF8') || received.includes('MAIL FROM:<no-reply@mekonggreen.vn>'));
  assert.ok(received.includes('RCPT TO:<tunglm@mekonggreen.vn>'));
  assert.match(data, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(data, /\r\n\.\.bắt đầu bằng dấu chấm\r\n/, 'dot-stuffing');
  assert.match(data, /Content-Type: text\/plain; charset=UTF-8/);
});

test('SMTP: có SMTP_USER nhưng máy chủ không hỗ trợ STARTTLS → từ chối gửi mật khẩu SMTP trên kênh rõ', async () => {
  const smtp = createTcpServer((socket: Socket) => {
    socket.write('220 plain.local ESMTP\r\n');
    socket.on('data', (chunk) => { if (chunk.toString().startsWith('EHLO')) socket.write('250-plain.local\r\n250 AUTH PLAIN LOGIN\r\n'); else socket.write('250 OK\r\n'); });
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  after(() => smtp.close());
  const port = (smtp.address() as { port: number }).port;
  const config = mailer.smtpConfig({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'bot', SMTP_PASS: 'x' })!;
  await assert.rejects(mailer.sendViaSmtp({ to: 'tunglm@mekonggreen.vn', subject: 't', text: 't' }, config), /STARTTLS/);
});

test('reset-sadmin (operator_reset) cũng phát email; tắt bằng SADMIN_RESET_EMAIL rỗng', async () => {
  const before = outboxFiles().length;
  const r = await reset.sendSuperAdminResetEmail('operator_reset');
  assert.equal(r.transport, 'outbox');
  assert.equal(outboxFiles().length, before + 1);
  assert.equal(one<{ reason: string }>("SELECT reason FROM password_resets WHERE user_id = (SELECT id FROM users WHERE username = 'SAdmin') ORDER BY created_at DESC LIMIT 1")?.reason, 'operator_reset');
  process.env.SADMIN_RESET_EMAIL = '';
  try {
    const off = await reset.sendSuperAdminResetEmail('startup');
    assert.equal(off.to, null);
    assert.equal(outboxFiles().length, before + 1, 'không gửi khi tắt');
  } finally { delete process.env.SADMIN_RESET_EMAIL; }
});

void users;
