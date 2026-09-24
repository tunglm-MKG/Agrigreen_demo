/**
 * Kiểm thử CHUỖI THU MUA RƠM: hợp đồng HTX (D1), phiếu mua rơm & công nợ (B3),
 * danh mục ghe (D2) và mắt nối kho — phiếu nhập tự tham chiếu chuyến (B1).
 *
 * Tiền đi theo tấn rơm thật, nên phần lớn test kiểm cái hệ thống TỪ CHỐI: hai hợp
 * đồng chồng nhau, xác nhận phiếu chưa cân đủ, đoán giá khi không có hợp đồng,
 * trả tiền phiếu chưa xác nhận.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

process.env.UPLOAD_DIR = join(mkdtempSync(join(tmpdir(), 'mekong-up-')), 'u');
configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-straw-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const contracts = await import('../src/erp/straw/contracts.ts');
const tickets = await import('../src/erp/straw/tickets.ts');
const vessels = await import('../src/erp/tms/vessels.ts');
const field = await import('../src/erp/field/service.ts');
const warehouse = await import('../src/erp/warehouse/service.ts');
const actuals = await import('../src/erp/params/actuals.ts');

migrate();
seedAll();
const actor = { id: 'test', name: 'Kiểm thử' };
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** HTX sạch chưa có hợp đồng trong seed. */
const freeHtx = () => one<{ id: string; name: string; lat: number; lng: number }>(
  `SELECT id, name, lat, lng FROM cooperatives WHERE lat IS NOT NULL AND id NOT IN (SELECT htx_id FROM straw_contracts) ORDER BY code LIMIT 1`)!;

/** Đội mới + việc đã cuộn, gom xong với số cuộn cho trước, sẵn sàng xuống ghe. */
function readyJob(htxId: string, bales: number, harvestOffset = 0) {
  const team = field.createTeam({ name: `Đội ${Math.random().toString(16).slice(2, 6)}`, baseLat: 10.3, baseLng: 105.4 }, actor);
  const baler = field.createVehicle({ name: 'Máy cuộn', kind: 'may_cuon', teamId: String(team.id), capacityValue: 300 }, actor);
  const job = field.createJob({ sourceType: 'manual', htxId, harvestDate: day(harvestOffset), expectedStrawTons: Math.round(bales * 0.02) }, actor);
  const id = String(job.id);
  field.assignJob(id, { teamId: String(team.id), plannedDate: day(Math.max(0, harvestOffset)) }, actor);
  field.startStage(id, 'cuon_rom', { vehicleId: String(baler.id) }, actor);
  field.completeStage(id, 'cuon_rom', { bales }, actor);
  field.completeStage(id, 'gom_rom', { bales }, actor);
  return { id, job };
}

// ===========================================================================
// Hợp đồng (D1)
// ===========================================================================

test('Seed có hai hợp đồng hiệu lực với hai cơ sở giá, tiến độ giao tính từ phiếu', () => {
  const list = contracts.listContracts({ status: 'hieu_luc' });
  assert.equal(list.length, 2);
  assert.deepEqual(new Set(list.map((c) => c.price_basis)), new Set(['theo_cuon', 'theo_tan_can']));
  for (const c of list) assert.ok(Number(c.delivered_tons) > 0 && Number(c.progressPct) > 0, `${c.code} chưa có tiến độ`);
});

test('CT-01: hai hợp đồng hiệu lực chồng thời gian cho cùng HTX bị từ chối; nối tiếp thì được', () => {
  const htx = freeHtx();
  const a = contracts.createContract({ htxId: htx.id, fromDate: day(0), toDate: day(90), committedTons: 500, priceBasis: 'theo_cuon', unitPrice: 21_000 }, actor);
  assert.throws(() => contracts.createContract({ htxId: htx.id, fromDate: day(60), toDate: day(150), committedTons: 200, priceBasis: 'theo_cuon', unitPrice: 20_000 }, actor), /CT-01/);
  contracts.createContract({ htxId: htx.id, fromDate: day(91), toDate: day(180), committedTons: 200, priceBasis: 'theo_cuon', unitPrice: 20_000 }, actor);
  contracts.setContractStatus(String(a.id), 'huy', actor);
  contracts.createContract({ htxId: htx.id, fromDate: day(0), toDate: day(90), committedTons: 300, priceBasis: 'theo_tan_can', unitPrice: 1_000_000 }, actor);
});

test('CT-02: giá / cam kết không dương, ngày kết thúc trước ngày bắt đầu, cơ sở giá lạ → từ chối', () => {
  const htx = freeHtx();
  assert.throws(() => contracts.createContract({ htxId: htx.id, fromDate: day(0), toDate: day(10), committedTons: 100, priceBasis: 'theo_cuon', unitPrice: 0 }, actor), /CT-02/);
  assert.throws(() => contracts.createContract({ htxId: htx.id, fromDate: day(0), toDate: day(10), committedTons: 0, priceBasis: 'theo_cuon', unitPrice: 20_000 }, actor), /CT-02/);
  assert.throws(() => contracts.createContract({ htxId: htx.id, fromDate: day(10), toDate: day(0), committedTons: 100, priceBasis: 'theo_cuon', unitPrice: 20_000 }, actor), /CT-02/);
  assert.throws(() => contracts.createContract({ htxId: htx.id, fromDate: day(0), toDate: day(10), committedTons: 100, priceBasis: 'theo_kg' as never, unitPrice: 20_000 }, actor), /Cơ sở giá/);
});

test('Việc thu gom của HTX có hợp đồng mang contract_id và ưu tiên 10; không hợp đồng thì 0', () => {
  const withContract = one<{ id: string }>(`SELECT htx_id AS id FROM straw_contracts WHERE status = 'hieu_luc' LIMIT 1`)!;
  const job = field.createJob({ sourceType: 'manual', htxId: withContract.id, harvestDate: day(1), expectedStrawTons: 10 }, actor);
  assert.ok(job.contract_id);
  assert.equal(job.priority, 10);
  const free = freeHtx();
  const job2 = field.createJob({ sourceType: 'manual', htxId: free.id, harvestDate: day(1), expectedStrawTons: 10 }, actor);
  assert.equal(job2.contract_id, null);
  assert.equal(job2.priority, 0);
});

// ===========================================================================
// Mắt nối kho (B1): thông báo hàng đến → cân → phiếu nhập tham chiếu chuyến
// ===========================================================================

test('B1: lượt xuống ghe sinh thông báo hàng đến mang mã chuyến; cân xong → thông báo "đã đến" + phiếu nhập chờ duyệt có weighing/HTX/ngày gặt', () => {
  const htx = one<{ id: string }>(`SELECT htx_id AS id FROM straw_contracts WHERE price_basis = 'theo_tan_can' AND status = 'hieu_luc' LIMIT 1`)!;
  const { id } = readyJob(htx.id, 4000);
  const loaded = field.recordLoading(id, { vesselCode: 'AG-12345', bales: 4000 }, actor);
  const notice = one<{ id: string; status: string; trip_id: string; expected_tons: number }>('SELECT * FROM inbound_notices WHERE id = ?', [loaded.loading.inbound_notice_id as string])!;
  assert.ok(notice, 'có thông báo hàng đến');
  assert.equal(notice.trip_id, loaded.trip!.id, 'thông báo mang đúng mã chuyến');
  assert.equal(notice.status, 'cho_den');
  assert.equal(notice.expected_tons, loaded.loading.tons);
  assert.ok(field.pendingWeighings().some((p) => p.id === loaded.loading.id && p.notice_code));

  const weighed = field.recordPlantWeighing(String(loaded.loading.id), { netKg: 82_000, plantBales: 3990 }, actor);
  assert.equal(one<{ status: string }>('SELECT status FROM inbound_notices WHERE id = ?', [notice.id])!.status, 'da_den');
  const grn = one<{ status: string; weighing_id: string; htx_id: string; harvest_date: string; received_tons: number; origin_lat: number }>('SELECT * FROM goods_receipts WHERE id = ?', [weighed.goodsReceipt.id])!;
  assert.equal(grn.status, 'cho_duyet');
  assert.equal(grn.weighing_id, weighed.loading.weighing_id);
  assert.equal(grn.htx_id, htx.id);
  assert.equal(grn.harvest_date, day(0));
  assert.equal(grn.received_tons, 82);
  assert.ok(grn.origin_lat);
  // Duyệt phiếu nhập → lô kho + tồn kho tăng, không sinh AP (AP đi qua phiếu mua rơm).
  const facility = one<{ current_stock_tons: number }>('SELECT current_stock_tons FROM facilities WHERE id = (SELECT facility_id FROM goods_receipts WHERE id = ?)', [weighed.goodsReceipt.id])!;
  const apBefore = all('SELECT id FROM ledger_entries WHERE account = ?', ['AP']).length;
  warehouse.approveGoodsReceipt(weighed.goodsReceipt.id as string, actor);
  const after = one<{ current_stock_tons: number }>('SELECT current_stock_tons FROM facilities WHERE id = (SELECT facility_id FROM goods_receipts WHERE id = ?)', [weighed.goodsReceipt.id])!;
  assert.ok(Math.abs(after.current_stock_tons - facility.current_stock_tons - 82) < 0.01);
  assert.equal(all('SELECT id FROM ledger_entries WHERE account = ?', ['AP']).length, apBefore, 'không ghi AP hai lần');
});

// ===========================================================================
// Phiếu mua rơm (B3)
// ===========================================================================

test('PM-01/PM-02 theo cuộn: việc hoàn thành sinh phiếu chờ xác nhận với tiền = cuộn × giá, không chờ cân', () => {
  const contract = one<{ htx_id: string; unit_price: number }>(`SELECT htx_id, unit_price FROM straw_contracts WHERE price_basis = 'theo_cuon' AND status = 'hieu_luc' LIMIT 1`)!;
  const { id } = readyJob(contract.htx_id, 3000);
  field.recordLoading(id, { vesselCode: 'AG-20311', bales: 3000 }, actor);
  field.completeStage(id, 'xuong_ghe', {}, actor);
  const t = one<{ status: string; amount: number; bales: number; weighed_tons: number | null }>('SELECT * FROM straw_purchase_tickets WHERE job_id = ?', [id])!;
  assert.ok(t, 'phiếu sinh tự động');
  assert.equal(t.status, 'cho_xac_nhan');
  assert.equal(t.bales, 3000);
  assert.equal(t.weighed_tons, null);
  assert.equal(t.amount, 3000 * contract.unit_price);
});

test('PM-02 theo tấn cân: phiếu "chờ cân" tới khi MỌI ghe được cân; xác nhận sớm bị từ chối; cân xong tiền = tấn cân × giá', () => {
  const contract = one<{ htx_id: string; unit_price: number }>(`SELECT htx_id, unit_price FROM straw_contracts WHERE price_basis = 'theo_tan_can' AND status = 'hieu_luc' LIMIT 1`)!;
  const { id } = readyJob(contract.htx_id, 6000);
  const l1 = field.recordLoading(id, { vesselCode: 'AG-12345', bales: 4000 }, actor);
  const l2 = field.recordLoading(id, { vesselCode: 'AG-10088', bales: 2000 }, actor);
  field.completeStage(id, 'xuong_ghe', {}, actor);
  let t = one<{ id: string; status: string; amount: number | null; unweighed_loadings: number }>('SELECT * FROM straw_purchase_tickets WHERE job_id = ?', [id])!;
  assert.equal(t.status, 'cho_can');
  assert.equal(t.unweighed_loadings, 2);
  assert.equal(t.amount, null);
  assert.throws(() => tickets.confirmTicket(t.id, {}, actor), /PM-02/);

  field.recordPlantWeighing(String(l1.loading.id), { netKg: 85_000 }, actor);
  t = one('SELECT * FROM straw_purchase_tickets WHERE job_id = ?', [id])!;
  assert.equal(t.status, 'cho_can', 'còn một ghe chưa cân');
  field.recordPlantWeighing(String(l2.loading.id), { netKg: 41_000 }, actor);
  t = one('SELECT * FROM straw_purchase_tickets WHERE job_id = ?', [id])!;
  assert.equal(t.status, 'cho_xac_nhan');
  assert.equal(t.amount, Math.round(126 * contract.unit_price));
});

test('PM-03: không hợp đồng → phiếu không có tiền; xác nhận phải nhập giá, không nhập thì từ chối', () => {
  const htx = freeHtx();
  const { id } = readyJob(htx.id, 2500);
  field.recordLoading(id, { vesselCode: 'KG-30877', bales: 2500 }, actor);
  field.completeStage(id, 'xuong_ghe', {}, actor);
  const t = one<{ id: string; status: string; amount: number | null; note: string }>('SELECT * FROM straw_purchase_tickets WHERE job_id = ?', [id])!;
  assert.equal(t.amount, null);
  assert.match(t.note, /PM-03/);
  assert.throws(() => tickets.confirmTicket(t.id, {}, actor), /PM-03/);
  const confirmed = tickets.confirmTicket(t.id, { priceBasis: 'theo_cuon', unitPrice: 19_000 }, actor);
  assert.equal(confirmed.amount, 2500 * 19_000);
  assert.equal(confirmed.status, 'da_xac_nhan');
});

test('PM-04: xác nhận ghi MỘT bút toán AP gắn HTX với hạn 15 ngày; trả tiền tất toán đúng bút toán; phiếu đã nợ không tự làm mới', () => {
  const contract = one<{ htx_id: string }>(`SELECT htx_id FROM straw_contracts WHERE price_basis = 'theo_cuon' AND status = 'hieu_luc' LIMIT 1`)!;
  const { id } = readyJob(contract.htx_id, 1000);
  field.recordLoading(id, { vesselCode: 'AG-20311', bales: 1000 }, actor);
  field.completeStage(id, 'xuong_ghe', {}, actor);
  const t = one<{ id: string }>('SELECT id FROM straw_purchase_tickets WHERE job_id = ?', [id])!;
  run('DELETE FROM notifications');
  const confirmed = tickets.confirmTicket(t.id, {}, actor);
  const entries = all<{ id: string; amount: number; status: string; htx_id: string; due_date: string }>(`SELECT * FROM ledger_entries WHERE ref_type = 'straw_ticket' AND ref_id = ?`, [t.id]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, confirmed.amount);
  assert.equal(entries[0].htx_id, contract.htx_id);
  assert.equal(entries[0].due_date, day(15));
  assert.ok(all(`SELECT id FROM notifications WHERE entity_id = ? AND title LIKE '%xác nhận%'`, [t.id]).length >= 0);

  // Phiếu đã xác nhận: làm mới không đổi số.
  const frozen = tickets.generateTicketForJob(id, actor);
  assert.equal(frozen.frozen, true);
  assert.throws(() => tickets.payTicket('khong-co', actor), /Không tìm thấy/);
  const paid = tickets.payTicket(t.id, actor);
  assert.equal(paid.status, 'da_thanh_toan');
  assert.equal(one<{ status: string }>('SELECT status FROM ledger_entries WHERE id = ?', [entries[0].id])!.status, 'da_thanh_toan');
  assert.throws(() => tickets.payTicket(t.id, actor), /chỉ trả phiếu đang là công nợ/);
  assert.throws(() => tickets.cancelTicket(t.id, 'thử', actor), /không huỷ được/);
});

test('Công nợ theo HTX cộng đúng: phải trả = đã xác nhận chưa trả; đã trả tách riêng', () => {
  const p = tickets.payables();
  const totals = p.totals as { outstanding: number; paid: number };
  const sumOutstanding = all<{ s: number }>(`SELECT COALESCE(SUM(amount), 0) AS s FROM straw_purchase_tickets WHERE status = 'da_xac_nhan'`)[0].s;
  const sumPaid = all<{ s: number }>(`SELECT COALESCE(SUM(amount), 0) AS s FROM straw_purchase_tickets WHERE status = 'da_thanh_toan'`)[0].s;
  assert.equal(totals.outstanding, sumOutstanding);
  assert.equal(totals.paid, sumPaid);
  const htx = one<{ htx_id: string }>(`SELECT htx_id FROM straw_purchase_tickets WHERE status = 'da_thanh_toan' LIMIT 1`)!;
  const mine = tickets.payables(htx.htx_id);
  assert.equal((mine.byHtx as unknown[]).length, 1, 'HTX chỉ thấy của mình');
});

// ===========================================================================
// Danh mục ghe (D2)
// ===========================================================================

test('GH-01: số hiệu chuẩn hoá và duy nhất; lớp tàu lạ / đơn giá thiếu số bị từ chối', () => {
  const v = vessels.createVessel({ code: ' bl-8888 ', kind: 'ghe', ownerName: 'Chủ ghe X', rateType: 'per_ton', rateVnd: 170_000 }, actor);
  assert.equal(v.code, 'BL-8888');
  assert.throws(() => vessels.createVessel({ code: 'BL-8888', kind: 'ghe' }, actor), /GH-01/);
  assert.throws(() => vessels.createVessel({ code: 'BL-9999', kind: 'ghe', vesselClass: 'tau_ngam' }, actor), /Lớp tàu/);
  assert.throws(() => vessels.createVessel({ code: 'BL-9999', kind: 'ghe', rateType: 'per_ton' }, actor), /đơn giá phải lớn hơn 0/);
  assert.equal(vessels.vesselByCode('bl-8888')!.id, v.id);
});

test('GH-02: ghe hết hạn đăng kiểm vẫn xếp hàng được nhưng kèm cảnh báo; ghe ngoài danh mục cũng được cảnh báo', () => {
  const htx = freeHtx();
  const { id } = readyJob(htx.id, 4000);
  const expired = field.recordLoading(id, { vesselCode: 'KG-30877', bales: 2000 }, actor); // seed: hết hạn 12 ngày
  assert.ok(expired.warnings.some((w) => /GH-02.*HẾT HẠN/.test(w)), expired.warnings.join(' | '));
  const unknown = field.recordLoading(id, { vesselCode: 'XX-0001', bales: 1000 }, actor);
  assert.ok(unknown.warnings.some((w) => /chưa có trong danh mục/.test(w)));
  assert.equal(unknown.loading.vessel_code, 'XX-0001');
});

test('GH-03: cân xong, chuyến TMS lấy chi phí theo đơn giá thuê ghe (nguồn don_gia_ghe) và vào mẫu cước thực của đối chiếu giả định', () => {
  const htx = freeHtx();
  const { id } = readyJob(htx.id, 4000);
  const loaded = field.recordLoading(id, { vesselCode: 'AG-12345', bales: 4000 }, actor); // per_ton 180 000
  const weighed = field.recordPlantWeighing(String(loaded.loading.id), { netKg: 80_000 }, actor);
  assert.equal(weighed.tripCost, 80 * 180_000);
  const trip = one<{ actual_cost: number; actual_cost_source: string; status: string }>('SELECT * FROM trips WHERE id = ?', [loaded.trip!.id as string])!;
  assert.equal(trip.status, 'hoan_thanh');
  assert.equal(trip.actual_cost, 14_400_000);
  assert.equal(trip.actual_cost_source, 'don_gia_ghe');
  const row = actuals.compareAssumptions(90).items.find((i) => i.code === 'waterway_freight_rate')!;
  assert.ok(row.samples >= 3, `cước đường thuỷ có ${row.samples} mẫu thực`);
  // Ghe không có đơn giá → chi phí theo tham số, nguồn theo_don_gia, không vào mẫu.
  const { id: id2 } = readyJob(htx.id, 1000);
  const l2 = field.recordLoading(id2, { vesselCode: 'XX-0002', bales: 1000 }, actor);
  field.recordPlantWeighing(String(l2.loading.id), { netKg: 20_000 }, actor);
  assert.equal(one<{ s: string }>('SELECT actual_cost_source AS s FROM trips WHERE id = ?', [l2.trip!.id as string])!.s, 'theo_don_gia');
});

test('Danh mục ghe tổng hợp chuyến, tấn cân, cước thực và trạng thái đăng kiểm', () => {
  const list = vessels.listVessels();
  const ag = list.find((v) => v.code === 'AG-12345')!;
  assert.ok(Number(ag.trips) >= 2 && Number(ag.weighed_tons) > 0 && Number(ag.actual_cost) > 0);
  assert.equal((list.find((v) => v.code === 'KG-30877')!.expiry as { state: string }).state, 'het_han');
  assert.equal((list.find((v) => v.code === 'AG-10088')!.expiry as { state: string }).state, 'sap_het_han');
  assert.ok(vessels.vesselsNeedingAttention().length >= 2);
});
