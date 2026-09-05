/**
 * Kiểm thử CHỐNG GHI TRÙNG qua HTTP thật — header Idempotency-Key.
 *
 * Dựng máy chủ trên cổng ngẫu nhiên với chính router API của ứng dụng, đăng nhập
 * thật, rồi gửi cùng một yêu cầu hai lần: nghiệp vụ chỉ được chạy một lần.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-idem-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const { buildApi } = await import('../src/api.ts');
const { HttpError, sendJson } = await import('../src/platform/http/router.ts');
const idem = await import('../src/platform/http/idempotency.ts');

migrate();
seedAll();

const api = buildApi();
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) { sendJson(res, 404, {}); return; }
    const apiUrl = new URL(url.toString()); apiUrl.pathname = url.pathname.slice(4);
    if (!(await api.handle(req, res, apiUrl))) sendJson(res, 404, { error: 'no route' });
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.status : 400, { error: (error as Error).message });
  }
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;
after(() => server.close());

const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'hientruong', password: '123456' }) });
const token = ((await login.json()) as { token: string }).token;
const post = (path: string, body: unknown, key?: string) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
});

test('Cùng khoá, gửi hai lần → một đội, phản hồi thứ hai là bản trả lại', async () => {
  const before = all('SELECT id FROM field_teams').length;
  const key = 'test-key-0001-abcdef';
  const first = await post('/field/teams', { name: 'Đội chống trùng' }, key);
  const second = await post('/field/teams', { name: 'Đội chống trùng' }, key);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('idempotency-replayed'), 'true');
  assert.equal(first.headers.get('idempotency-replayed'), null);
  const a = await first.json() as { id: string };
  const b = await second.json() as { id: string };
  assert.equal(a.id, b.id, 'trả lại đúng kết quả cũ');
  assert.equal(all('SELECT id FROM field_teams').length, before + 1, 'nghiệp vụ chạy đúng một lần');
});

test('Không có khoá → mỗi lần gửi là một bản ghi (hành vi cũ giữ nguyên)', async () => {
  const before = all('SELECT id FROM field_teams').length;
  await post('/field/teams', { name: 'Đội A' });
  await post('/field/teams', { name: 'Đội A' });
  assert.equal(all('SELECT id FROM field_teams').length, before + 2);
});

test('Yêu cầu lỗi không được lưu — sửa dữ liệu rồi gửi lại cùng khoá thì chạy thật', async () => {
  const key = 'test-key-0002-abcdef';
  const bad = await post('/field/teams', { name: '' }, key);
  assert.equal(bad.status, 400);
  const good = await post('/field/teams', { name: 'Đội sửa lại' }, key);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('idempotency-replayed'), null);
});

test('Cùng khoá nhưng đường dẫn khác → từ chối, vì đó là lỗi tái dùng khoá', async () => {
  const key = 'test-key-0003-abcdef';
  await post('/field/teams', { name: 'Đội X' }, key);
  const other = await post('/field/calendar/sync', { fromDate: '2026-09-01', days: 3 }, key);
  assert.equal(other.status, 400);
  const payload = await other.json() as { error: string };
  assert.match(payload.error, /Khoá chống trùng/);
});

test('Khoá thuộc về người dùng: người khác dùng trùng khoá vẫn chạy bình thường', async () => {
  const key = 'test-key-0004-abcdef';
  await post('/field/teams', { name: 'Đội của hientruong' }, key);
  const adminLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) });
  const adminToken = ((await adminLogin.json()) as { token: string }).token;
  const before = all('SELECT id FROM field_teams').length;
  const res = await fetch(`${base}/field/teams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': key },
    body: JSON.stringify({ name: 'Đội của admin' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('idempotency-replayed'), null);
  assert.equal(all('SELECT id FROM field_teams').length, before + 1);
});

test('Khoá quá ngắn bị bỏ qua (không phải khoá), khoá quá hạn bị dọn', async () => {
  const before = all('SELECT id FROM field_teams').length;
  await post('/field/teams', { name: 'Ngắn' }, 'abc');
  await post('/field/teams', { name: 'Ngắn' }, 'abc');
  assert.equal(all('SELECT id FROM field_teams').length, before + 2, 'khoá < 8 ký tự không được coi là khoá');

  idem.storeResponse('old-key-000001', null, 'POST', '/x', 200, { ok: true });
  const { run } = await import('../src/platform/db/db.ts');
  run(`UPDATE request_log SET created_at = datetime('now', '-2 day') WHERE idem_key = 'old-key-000001'`);
  assert.ok(idem.purgeExpired() >= 1);
  assert.equal(idem.findReplay('old-key-000001', null, 'POST', '/x'), null);
});
