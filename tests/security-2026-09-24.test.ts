/**
 * Kiểm thử 5 lỗi P1 từ review bảo mật 24/09/2026 (nhánh main, commit 12a3ee8):
 *   1. Tài khoản HTX không được đọc/ghi dữ liệu HTX khác — chốt ở tầng API cho mọi route.
 *   2. Nhận HTX theo mã số thuế chỉ gắn cho chính người đăng nhập, trừ quản trị tài khoản.
 *   3. Duyệt phiếu xuất phải kiểm tồn lại trong giao dịch; thiếu hàng → từ chối, không ghi công nợ.
 *   4. Số lượng xuất phải hữu hạn và > 0.
 *   5. Route xác thực không tham gia lưu/phát lại phản hồi theo Idempotency-Key.
 *
 * Chạy qua HTTP thật để kiểm đúng lớp router/guard, không chỉ tầng service.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-sec-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const { buildApi } = await import('../src/api.ts');
const { HttpError, sendJson } = await import('../src/platform/http/router.ts');
const warehouse = await import('../src/erp/warehouse/service.ts');
const mdm = await import('../src/mdm/service.ts');
const users = await import('../src/platform/auth/users.ts');

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
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(() => server.close());

const call = (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const loginToken = async (username: string, password: string) => ((await (await call(null, 'POST', '/auth/login', { username, password })).json()) as { token: string }).token;

const htxToken = await loginToken('htx01', '123456');
const farmerToken = await loginToken('nongdan', '123456');
const htxUser = users.listUsers().find((u) => u.username === 'htx01')!;
const cooperatives = mdm.listCooperatives() as { id: string }[];
const otherHtx = cooperatives.find((c) => c.id !== htxUser.htxId)!;

// ===========================================================================
// P1 #1 — phạm vi HTX ở tầng API
// ===========================================================================

test('P1#1 Tài khoản HTX không tạo được phiếu mua vật tư cho HTX khác (403), tạo cho HTX mình vẫn được', async () => {
  const item = one<{ id: string }>('SELECT id FROM input_items LIMIT 1')!;
  const foreign = await call(htxToken, 'POST', '/inputs/purchases', { htxId: otherHtx.id, supplier: 'X', lines: [{ itemId: item.id, qty: 10, unitPrice: 1000 }] });
  assert.equal(foreign.status, 403);
  assert.match(((await foreign.json()) as { error: string }).error, /hợp tác xã khác/);
  assert.equal(all('SELECT id FROM input_purchases WHERE htx_id = ?', [otherHtx.id]).length, 0, 'không có gì được ghi cho HTX khác');
  const mine = await call(htxToken, 'POST', '/inputs/purchases', { supplier: 'Đại lý A', lines: [{ itemId: item.id, qty: 10, unitPrice: 1000 }] });
  assert.equal(mine.status, 200, 'thiếu htxId → dùng HTX của tài khoản');
  assert.equal(one<{ htx_id: string }>('SELECT htx_id FROM input_purchases ORDER BY created_at DESC LIMIT 1')?.htx_id, htxUser.htxId);
});

test('P1#1 Đọc dữ liệu HTX khác bị chặn; đọc "tất cả" tự thu về HTX mình', async () => {
  assert.equal((await call(htxToken, 'GET', `/inputs/stock?htxId=${otherHtx.id}`)).status, 403);
  assert.equal((await call(htxToken, 'GET', `/htx/crop-cycles?htxId=${otherHtx.id}`)).status, 403);
  assert.equal((await call(farmerToken, 'GET', `/mdm/plots?htxId=${otherHtx.id}`)).status, 403);
  const plots = await call(htxToken, 'GET', '/mdm/plots');
  assert.equal(plots.status, 200);
  const rows = (await plots.json()) as { htx_id: string }[];
  assert.ok(rows.every((p) => p.htx_id === htxUser.htxId), 'danh sách không lọc phải tự giới hạn về HTX của tài khoản');
});

test('P1#1 Tham chiếu thực thể của HTX khác (thửa, vụ) trong body / đường dẫn → 403; cán bộ khuyến nông không bị ràng buộc', async () => {
  const lifecycle = await import('../src/mdm/lifecycle.ts');
  const other = cooperatives.find((c) => c.id === otherHtx.id) as { id: string; lat?: number; lng?: number };
  const coop = one<{ lat: number; lng: number }>('SELECT lat, lng FROM cooperatives WHERE id = ?', [other.id])!;
  const plot = lifecycle.createPlotChecked({ htxId: other.id, boundary: [{ lat: coop.lat, lng: coop.lng }, { lat: coop.lat, lng: coop.lng + 0.002 }, { lat: coop.lat + 0.002, lng: coop.lng + 0.002 }, { lat: coop.lat + 0.002, lng: coop.lng }] }, { name: 'test' });
  assert.equal((await call(htxToken, 'POST', '/htx/verify-location', { plotId: plot.id, lat: coop.lat, lng: coop.lng })).status, 403);
  assert.equal((await call(htxToken, 'GET', `/assign/plots/${plot.id}/work-plan`)).status, 403);
  assert.equal((await call(htxToken, 'DELETE', `/mdm/plots/${plot.id}`, { reason: 'x' })).status, 403);
  const knToken = await loginToken('canbo_tw', '123456');
  assert.equal((await call(knToken, 'GET', `/mdm/plots?htxId=${other.id}`)).status, 200, 'khuyến nông TW làm việc trên nhiều HTX');
});

// ===========================================================================
// P1 #2 — nhận HTX theo MST
// ===========================================================================

test('P1#2 Nhận HTX theo MST không gắn được cho người dùng khác nếu không phải quản trị tài khoản', async () => {
  const target = users.listUsers().find((u) => u.username === 'nongdan')!;
  const before = users.getUser(target.id)!.htxId;
  const res = await call(htxToken, 'POST', '/htx-registry/claim', { taxCode: '0000000000', userId: target.id });
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /quản trị tài khoản/);
  assert.equal(users.getUser(target.id)!.htxId, before, 'HTX của nông dân không đổi');
});

// ===========================================================================
// P1 #3 / #4 — xuất kho
// ===========================================================================

function facilityWithStock(tons: number): string {
  const facility = one<{ id: string }>("SELECT id FROM facilities WHERE kind IN ('hub','warehouse','yard') LIMIT 1") ?? one<{ id: string }>('SELECT id FROM facilities LIMIT 1')!;
  run('DELETE FROM stock_lots WHERE facility_id = ?', [facility.id]);
  run('UPDATE facilities SET current_stock_tons = ? WHERE id = ?', [tons, facility.id]);
  return facility.id;
}

test('P1#4 Số lượng xuất âm, 0, NaN đều bị từ chối khi tạo phiếu và khi duyệt', () => {
  const facilityId = facilityWithStock(10);
  for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => warehouse.createGoodsIssue({ facilityId, issuedTons: bad }, { name: 'test' }), /lớn hơn 0/);
  }
  // Phiếu âm lọt vào CSDL bằng đường khác cũng không duyệt được.
  const legacy = warehouse.createGoodsIssue({ facilityId, issuedTons: 1 }, { name: 'test' }) as { id: string };
  run('UPDATE goods_issues SET issued_tons = -5 WHERE id = ?', [legacy.id]);
  assert.throws(() => warehouse.approveGoodsIssue(legacy.id, { name: 'test' }), /không hợp lệ/);
  assert.equal(one<{ current_stock_tons: number }>('SELECT current_stock_tons FROM facilities WHERE id = ?', [facilityId])?.current_stock_tons, 10, 'tồn kho không đổi');
});

test('P1#3 Hai phiếu cùng 10 tấn trên kho 10 tấn: phiếu thứ hai bị từ chối, không trừ tồn, không ghi công nợ', () => {
  const facilityId = facilityWithStock(10);
  const first = warehouse.createGoodsIssue({ facilityId, issuedTons: 10 }, { name: 'test' }) as { id: string };
  const second = warehouse.createGoodsIssue({ facilityId, issuedTons: 10 }, { name: 'test' }) as { id: string };
  const ok = warehouse.approveGoodsIssue(first.id, { name: 'test' }) as { shortfall: number };
  assert.equal(ok.shortfall, 0);
  assert.equal(one<{ current_stock_tons: number }>('SELECT current_stock_tons FROM facilities WHERE id = ?', [facilityId])?.current_stock_tons, 0);
  const ledgerBefore = all('SELECT id FROM ledger_entries').length;
  assert.throws(() => warehouse.approveGoodsIssue(second.id, { name: 'test' }), /Không đủ hàng/);
  assert.equal(one<{ status: string }>('SELECT status FROM goods_issues WHERE id = ?', [second.id])?.status, 'cho_duyet', 'phiếu giữ trạng thái chờ duyệt');
  assert.equal(one<{ current_stock_tons: number }>('SELECT current_stock_tons FROM facilities WHERE id = ?', [facilityId])?.current_stock_tons, 0, 'tồn không âm, không đổi');
  assert.equal(all('SELECT id FROM ledger_entries').length, ledgerBefore, 'không có bút toán công nợ cho hàng thiếu');
});

// ===========================================================================
// P1 #5 — Idempotency-Key với route xác thực
// ===========================================================================

test('P1#5 Đăng nhập sai mật khẩu với cùng Idempotency-Key của lần đúng trước đó KHÔNG nhận lại token', async () => {
  const key = 'login-replay-key-0001';
  const good = await call(null, 'POST', '/auth/login', { username: 'htx01', password: '123456' }, { 'Idempotency-Key': key });
  assert.equal(good.status, 200);
  const bad = await call(null, 'POST', '/auth/login', { username: 'htx01', password: 'sai-mat-khau' }, { 'Idempotency-Key': key });
  assert.equal(bad.status, 400, 'không được phát lại phản hồi đăng nhập cũ');
  assert.equal(bad.headers.get('idempotency-replayed'), null);
  const payload = (await bad.json()) as { token?: string };
  assert.equal(payload.token, undefined);
});
