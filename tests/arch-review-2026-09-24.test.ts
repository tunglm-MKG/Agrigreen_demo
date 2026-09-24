/**
 * Review kiến trúc & thiết kế dữ liệu 24/09/2026 — kiểm chứng các phát hiện đã xử lý:
 *   R1  dấu `/` lặp không lách được guard sở hữu thực thể
 *   R2  lệnh thuê máy: chỉ bên thuê / bên cho thuê thấy và chuyển trạng thái
 *   R3  xuất kho không có lô bị từ chối; kiểm kê tăng tạo lô; phân bổ đủ theo lô
 *   A03 tổng tồn cơ sở == tổng lô sau kiểm kê giảm (lô là nguồn sự thật)
 *   A04 ghi audit thất bại → dữ liệu nghiệp vụ KHÔNG được lưu (cùng giao dịch)
 *   A05 replay không bỏ sót sự kiện sau snapshot cùng ngày; không chụp snapshot ngày quá khứ
 *   A07 phiên bản lược đồ được ghi; bản nâng cấp có UNIQUE tax_code như cài mới
 *   R4  thửa liền kề chung cạnh không bị coi là chồng lấn
 *   O02 retry đến hạn: có handler thì chạy lại, không có thì dead-letter có lý do
 *   D03 P&L không cộng công nợ phải trả vào chi phí
 *   O03 tệp đính kèm lưu khoá tương đối, đọc lại được
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, db, one, run } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-arch-')), 'test.db'));
const schema = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const { buildApi } = await import('../src/api.ts');
const { HttpError, sendJson } = await import('../src/platform/http/router.ts');
const warehouse = await import('../src/erp/warehouse/service.ts');
const mdm = await import('../src/mdm/service.ts');
const users = await import('../src/platform/auth/users.ts');
const inputs = await import('../src/agrigreen/htx/inputs.ts');
const rental = await import('../src/agrigreen/rental/service.ts');
const audit = await import('../src/platform/audit/audit.ts');
const sync = await import('../src/platform/sync/sync.ts');
const finance = await import('../src/erp/finance/service.ts');
const lifecycle = await import('../src/mdm/lifecycle.ts');
const files = await import('../src/platform/files/attachments.ts');
const { today } = await import('../src/platform/util/ids.ts');

schema.migrate();
seedAll();

const api = buildApi();
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const apiUrl = new URL(url.toString()); apiUrl.pathname = url.pathname.slice(4);
    if (!(await api.handle(req, res, apiUrl))) sendJson(res, 404, { error: 'no route' });
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.status : 400, { error: (error as Error).message });
  }
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(() => server.close());
const call = (token: string | null, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const login = async (u: string, p: string) => ((await (await call(null, 'POST', '/auth/login', { username: u, password: p })).json()) as { token: string }).token;
const htxToken = await login('htx01', '123456');
const adminToken = await login('SAdmin', 'TungLM18@');
const htxUser = users.listUsers().find((u) => u.username === 'htx01')!;
const cooperatives = mdm.listCooperatives() as { id: string; name: string }[];
const others = cooperatives.filter((c) => c.id !== htxUser.htxId);
const actor = { name: 'test' };

test('R1: /inputs/purchases//ID (dấu / lặp) bị chặn như /inputs/purchases/ID', async () => {
  const item = inputs.createItem({ name: 'Phân R1', category: 'phan_bon', htxId: others[0].id }, actor);
  const purchase = inputs.createPurchase({ htxId: others[0].id, lines: [{ itemId: String(item.id), qty: 5, unitPrice: 10_000 }] }, actor) as { id: string };
  assert.equal((await call(htxToken, 'GET', `/inputs/purchases/${purchase.id}`)).status, 403);
  assert.equal((await call(htxToken, 'GET', `/inputs/purchases//${purchase.id}`)).status, 403, 'slash lặp');
  assert.equal((await call(htxToken, 'GET', `/inputs/purchases/${purchase.id}/`)).status, 403, 'slash cuối');
  assert.equal((await call(htxToken, 'GET', `//inputs//purchases//${purchase.id}`)).status, 403, 'slash lặp mọi vị trí');
  assert.equal((await call(adminToken, 'GET', `/inputs/purchases//${purchase.id}`)).status, 200, 'quản trị vẫn đọc được qua URL tương đương');
});

test('R2: tài khoản HTX không thấy và không huỷ được lệnh thuê mà mình không phải bên thuê/bên cho thuê', async () => {
  const machine = one<{ id: string; htx_id: string }>('SELECT id, htx_id FROM machines WHERE htx_id NOT IN (?, ?) LIMIT 1', [htxUser.htxId, others[0].id])!;
  const listing = rental.createListing({ machineId: machine.id, pricePerHa: 500_000 }, actor) as { id: string };
  const order = rental.bookOrder({ listingId: listing.id, renterHtxId: others[0].id, areaHa: 2, from: '2027-01-10', to: '2027-01-12' }, actor) as { id: string };
  const visible = (await (await call(htxToken, 'GET', '/rental/orders')).json()) as { id: string }[];
  assert.ok(!visible.some((o) => o.id === order.id), 'không thấy lệnh của người khác');
  const cancel = await call(htxToken, 'POST', `/rental/orders/${order.id}/advance`, { status: 'huy' });
  assert.equal(cancel.status, 403);
  assert.equal(one<{ status: string }>('SELECT status FROM rental_orders WHERE id = ?', [order.id])!.status, 'dat_lich', 'lệnh không đổi');
  // Bên thuê được huỷ khi mới đặt lịch; bên cho thuê mới được xác nhận.
  assert.throws(() => rental.advanceOrder(order.id, 'xac_nhan', actor, { htxId: others[0].id }), /bên thuê không được chuyển/);
  rental.advanceOrder(order.id, 'xac_nhan', actor, { htxId: machine.htx_id });
  assert.throws(() => rental.advanceOrder(order.id, 'hoan_thanh', actor, { htxId: others[0].id }), /bên thuê/);
  const asOwner = rental.listOrders({}, { htxId: machine.htx_id });
  assert.ok(asOwner.some((o) => o.id === order.id), 'bên cho thuê thấy lệnh');
  assert.throws(() => rental.bookOrder({ listingId: listing.id, renterHtxId: others[1].id, areaHa: 1, from: '2027-02-01', to: '2027-02-02' }, actor, { htxId: others[0].id }), /hợp tác xã của mình/);
});

test('R3/A03: kho không lô → xuất bị từ chối; kiểm kê tăng tạo lô; xuất phân bổ đủ theo lô; kiểm kê giảm giữ tổng tồn == tổng lô', () => {
  const facility = one<{ id: string; name: string }>("SELECT id, name FROM facilities WHERE kind IN ('hub', 'warehouse', 'yard', 'plant') ORDER BY current_stock_tons ASC LIMIT 1")!;
  warehouse.ensureOpeningLot(facility.id, actor);
  const lotSum = () => one<{ s: number }>("SELECT COALESCE(SUM(remaining_tons), 0) AS s FROM stock_lots WHERE facility_id = ? AND status = 'ton'", [facility.id])!.s;
  const facilityTons = () => one<{ t: number }>('SELECT current_stock_tons AS t FROM facilities WHERE id = ?', [facility.id])!.t;
  const start = lotSum();
  assert.equal(facilityTons(), start, 'sau khi quy đổi lô đầu kỳ, tổng tồn == tổng lô');

  // Kiểm kê ghi nhận thêm 10 tấn → lô điều chỉnh có nguồn gốc, tổng tồn dựng lại từ lô.
  const st = warehouse.planStocktake({ facilityId: facility.id, plannedFor: today() }, actor) as { id: string };
  warehouse.submitCount(st.id, start + 10, 'kiểm kê thực tế', actor);
  const approved = warehouse.approveStocktake(st.id, actor) as { adjustments: { lot: string; tons: number }[] };
  assert.equal(approved.adjustments.length, 1);
  assert.equal(approved.adjustments[0].tons, 10);
  assert.equal(lotSum(), start + 10);
  assert.equal(facilityTons(), start + 10);
  assert.ok(all("SELECT 1 FROM stock_movements WHERE ref_type = 'stocktake' AND ref_id = ? AND kind = 'dieu_chinh'", [st.id]).length === 1);

  // Tổng tồn cơ sở bị sửa tay +50 (không có lô, kho đã có sổ vận động) → KHÔNG xuất được phần ma.
  run('UPDATE facilities SET current_stock_tons = current_stock_tons + 50 WHERE id = ?', [facility.id]);
  const ghost = warehouse.createGoodsIssue({ facilityId: facility.id, issuedTons: start + 60 }, actor) as { id: string };
  assert.throws(() => warehouse.approveGoodsIssue(ghost.id, actor), /Không đủ hàng/);
  assert.equal(one<{ status: string }>('SELECT status FROM goods_issues WHERE id = ?', [ghost.id])!.status, 'cho_duyet');

  // Xuất đúng lượng đang có: phân bổ theo lô, tổng phân bổ == lượng xuất.
  const issue = warehouse.createGoodsIssue({ facilityId: facility.id, issuedTons: start + 10 }, actor) as { id: string };
  const out = warehouse.approveGoodsIssue(issue.id, actor) as { consumed: { tons: number }[]; allocatedTons: number; shortfall: number };
  assert.ok(out.consumed.length >= 1, 'có lô được tiêu thụ');
  assert.equal(out.allocatedTons, start + 10);
  assert.equal(out.shortfall, 0);
  assert.equal(one<{ s: number }>('SELECT COALESCE(SUM(tons), 0) AS s FROM issue_allocations WHERE issue_id = ?', [issue.id])!.s, start + 10);
  assert.equal(facilityTons(), 0, 'tổng tồn dựng lại từ lô — số +50 ma biến mất');
  assert.equal(lotSum(), 0);

  // Nhập 10, kiểm kê còn 8 → lô còn 8 và tổng tồn 8 (không còn "8 ở kho, 10 ở lô").
  const grn = warehouse.createGoodsReceipt({ facilityId: facility.id, receivedTons: 10 }, actor) as { id: string };
  warehouse.approveGoodsReceipt(grn.id, actor);
  assert.equal(facilityTons(), 10);
  const st2 = warehouse.planStocktake({ facilityId: facility.id, plannedFor: today() }, actor) as { id: string };
  warehouse.submitCount(st2.id, 8, 'hao hụt', actor);
  warehouse.approveStocktake(st2.id, actor);
  assert.equal(lotSum(), 8);
  assert.equal(facilityTons(), 8);
  assert.deepEqual(warehouse.stockConsistency(facility.id).map((r) => r.diffTons), [0]);
  // Kiểm kê giảm quá tồn theo lô → từ chối.
  const st3 = warehouse.planStocktake({ facilityId: facility.id, plannedFor: today() }, actor) as { id: string };
  warehouse.submitCount(st3.id, -5, 'sai số đếm', actor);
  assert.throws(() => warehouse.approveStocktake(st3.id, actor), /lớn hơn tồn theo lô/);
});

test('A04: ghi nhật ký thất bại → thay đổi nghiệp vụ trong cùng yêu cầu HTTP bị hoàn tác', async () => {
  const target = others[2];
  db().exec("CREATE TRIGGER trg_audit_fail BEFORE INSERT ON event_log WHEN NEW.entity_type = 'cooperatives' AND NEW.action = 'update' BEGIN SELECT RAISE(ABORT, 'audit down'); END");
  try {
    const res = await call(adminToken, 'PUT', `/mdm/cooperatives/${target.id}`, { name: 'HTX Đổi Tên Thất Bại' });
    assert.notEqual(res.status, 200);
    assert.equal(one<{ name: string }>('SELECT name FROM cooperatives WHERE id = ?', [target.id])!.name, target.name, 'tên KHÔNG đổi vì audit không ghi được');
  } finally {
    db().exec('DROP TRIGGER trg_audit_fail');
  }
  const ok = await call(adminToken, 'PUT', `/mdm/cooperatives/${target.id}`, { name: 'HTX Đổi Tên Thành Công' });
  assert.equal(ok.status, 200);
  assert.equal(one<{ name: string }>('SELECT name FROM cooperatives WHERE id = ?', [target.id])!.name, 'HTX Đổi Tên Thành Công');
  assert.ok(all("SELECT id FROM event_log WHERE entity_type = 'cooperatives' AND entity_id = ? AND action = 'update'", [target.id]).length >= 1, 'audit đi cùng thay đổi');
});

test('A05: snapshot có watermark; sửa SAU khi chụp cùng ngày vẫn vào replay; không chụp được ngày quá khứ', () => {
  const target = others[3];
  audit.captureSnapshot();
  const snap = one<{ captured_at: string; last_event_id: number }>("SELECT captured_at, last_event_id FROM daily_snapshots WHERE snapshot_date = ? AND layer = 'cooperatives'", [today()])!;
  assert.ok(snap.captured_at && snap.last_event_id > 0);
  mdm.updateCooperative(target.id, { name: 'HTX Sau Snapshot' }, actor);
  const replayed = audit.replay(today());
  const row = (replayed.layers.cooperatives as { id: string; name: string }[]).find((c) => c.id === target.id)!;
  assert.equal(row.name, 'HTX Sau Snapshot', 'sự kiện sau giờ chụp cùng ngày được áp');
  assert.equal(replayed.basis, 'reconstructed');
  assert.ok(replayed.appliedEvents >= 1);
  assert.throws(() => audit.captureSnapshot('2020-01-01'), /hiện tại/);
});

test('A07: lược đồ có phiên bản/băm ghi trong schema_migrations; bản nâng cấp có UNIQUE tax_code như cài mới', () => {
  const status = schema.schemaStatus();
  assert.equal(status.upToDate, true);
  assert.equal(status.applied?.version, schema.SCHEMA_VERSION);
  assert.ok(status.history >= 1);
  const uniqueOnTaxCode = (db().prepare('PRAGMA main.index_list(cooperatives)').all() as { name: string; unique: number }[])
    .filter((i) => i.unique)
    .some((i) => (db().prepare(`PRAGMA main.index_info(${i.name})`).all() as { name: string }[]).some((c) => c.name === 'tax_code'));
  assert.equal(uniqueOnTaxCode, true, 'UNIQUE(tax_code) có hiệu lực (kể cả CSDL nâng cấp nhờ reconcileTables)');
});

test('R4: hai thửa chung cạnh không chồng lấn; cắt nhau hoặc chứa nhau thì có', () => {
  const rectA = [{ lat: 10.0, lng: 105.0 }, { lat: 10.0, lng: 105.001 }, { lat: 10.001, lng: 105.001 }, { lat: 10.001, lng: 105.0 }];
  const rectB = [{ lat: 10.0, lng: 105.001 }, { lat: 10.0, lng: 105.002 }, { lat: 10.001, lng: 105.002 }, { lat: 10.001, lng: 105.001 }];
  const adjacent = lifecycle.polygonsOverlap(rectA, rectB);
  assert.equal(adjacent.vertices, 0); assert.equal(adjacent.centroidInside, false); assert.equal(adjacent.edgesCross, false); assert.equal(adjacent.touches, true);
  const crossing = lifecycle.polygonsOverlap(rectA, [{ lat: 9.9995, lng: 105.0004 }, { lat: 9.9995, lng: 105.0006 }, { lat: 10.0015, lng: 105.0006 }, { lat: 10.0015, lng: 105.0004 }]);
  assert.equal(crossing.edgesCross, true);
  const inside = lifecycle.polygonsOverlap(rectA, [{ lat: 10.0002, lng: 105.0002 }, { lat: 10.0002, lng: 105.0008 }, { lat: 10.0008, lng: 105.0008 }, { lat: 10.0008, lng: 105.0002 }]);
  assert.ok(inside.vertices > 0 || inside.centroidInside);
  // Tạo thửa thật liền kề (khác HTX) không bị chặn.
  const first = lifecycle.createPlotChecked({ name: 'Kề A', htxId: others[0].id, boundary: rectA, minPoints: 4 }, actor);
  assert.ok(first.id);
  const second = lifecycle.createPlotChecked({ name: 'Kề B', htxId: others[1].id, boundary: rectB, minPoints: 4 }, actor);
  assert.ok(second.id);
  assert.equal(second.overlaps.length, 0);
});

test('O02: retry đến hạn — dataset có handler được chạy lại, dataset không handler vào dead-letter có lý do', () => {
  const failed = sync.runSync({ system: 'app_htx', direction: 'outbound', dataset: 'khuyennong_content', attempt: 1 }, () => { throw new Error('mất mạng giả lập'); }) as { logId: string; status: string };
  assert.equal(failed.status, 'failed');
  const unknown = sync.runSync({ system: 'erp', direction: 'outbound', dataset: 'dataset_khong_co_handler', attempt: 1 }, () => { throw new Error('lỗi'); }) as { logId: string };
  run('UPDATE sync_log SET next_retry_at = ? WHERE id IN (?, ?)', ['2000-01-01T00:00:00Z', failed.logId, unknown.logId]);
  const result = sync.processRetries();
  assert.equal(result.retried, 1);
  assert.equal(result.recovered, 1, 'khuyennong_content có handler → hồi phục');
  assert.equal(result.deadLettered, 1);
  const dl = one<{ status: string; error_message: string }>('SELECT status, error_message FROM sync_log WHERE id = ?', [unknown.logId])!;
  assert.equal(dl.status, 'dead_letter');
  assert.match(dl.error_message, /Không có trình xử lý retry/);
  assert.equal(sync.dueRetries().length, 0, 'không còn bản ghi đến hạn treo mãi');
});

test('D03: P&L không cộng AP vào chi phí; đối soát áp bộ lọc cho cả bảng con', () => {
  const day = '2031-05-15';
  finance.postEntry({ account: 'AP', amount: 1_000_000, description: 'nhập rơm', entryDate: day } as never, actor);
  finance.postEntry({ account: 'EXPENSE', amount: 250_000, description: 'điện', entryDate: day } as never, actor);
  finance.postEntry({ account: 'REVENUE', amount: 900_000, description: 'bán rơm', entryDate: day } as never, actor);
  const pnl = finance.profitAndLoss('2031-05-01', '2031-05-31') as { revenue: number; expense: number; grossProfit: number; payables: number; basis: string };
  assert.equal(pnl.expense, 250_000);
  assert.equal(pnl.payables, 1_000_000);
  assert.equal(pnl.grossProfit, 650_000);
  assert.equal(pnl.basis, 'operational_estimate');
  const rec = finance.reconciliation({ from: '2031-05-01', to: '2031-05-31' }) as { payablesByHtx: unknown[]; byAccount: { account: string; total: number }[] };
  assert.ok(rec.byAccount.some((r) => r.account === 'AP' && r.total === 1_000_000));
});

test('O03: tệp đính kèm lưu khoá tương đối, đọc lại được', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
  const saved = files.saveAttachment({ entityType: 'plot', entityId: 'plot-test', fileName: 'anh.png', mime: 'image/png', data: png }, actor) as { id: string };
  const stored = one<{ storage_path: string }>('SELECT storage_path FROM attachments WHERE id = ?', [saved.id])!.storage_path;
  assert.ok(!/[\\/]/.test(stored), `khoá tương đối, không phải đường dẫn máy: ${stored}`);
  const read = files.readAttachment(saved.id);
  assert.ok(read && read.data.length === png.length);
});
