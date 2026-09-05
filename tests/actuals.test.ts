/**
 * Kiểm thử ĐỐI CHIẾU GIẢ ĐỊNH – THỰC TẾ.
 *
 * Điều đáng bảo vệ: không đưa ra con số từ quá ít quan sát, không dùng số ước
 * làm số thật, và đề xuất phải đi qua đúng luồng phê duyệt — không tự đổi giả định.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-act-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const actuals = await import('../src/erp/params/actuals.ts');
const params = await import('../src/erp/params/store.ts');
const tms = await import('../src/erp/tms/service.ts');
const field = await import('../src/erp/field/service.ts');

migrate();
seedAll();
const actor = { id: 'test', name: 'Kiểm thử' };
const item = (code: string, days = 90) => actuals.compareAssumptions(days).items.find((i) => i.code === code)!;

test('Chỉ tham số có cách đo mới xuất hiện; mỗi dòng nói rõ cơ sở, nguồn, cỡ mẫu', () => {
  const result = actuals.compareAssumptions(90);
  assert.equal(result.items.length, actuals.COMPARABLE_CODES.length);
  assert.ok(result.summary.notComparable > 30, 'phần lớn 57 tham số chưa có cách đo — nói rõ, không giả vờ');
  for (const row of result.items) {
    assert.ok(row.basis.length > 20 && row.source.length > 5 && row.sampleLabel.length > 3, row.code);
    assert.ok(row.minSamples >= 3);
  }
});

test('Tải trọng ghe (#51): ba ghe đã cân trong seed → có số thật, khớp giả định 90 t', () => {
  const row = item('boat_straw_payload_tons');
  assert.equal(row.samples, 3, 'ba ghe seed đã cân');
  assert.ok(row.actual! > 85 && row.actual! < 95, `thực tế ${row.actual}`);
  assert.equal(row.fit, 'khop');
  assert.ok(Math.abs(row.deviationPct!) <= 5);
  assert.equal(row.withinRange, true);
});

test('Số ước theo cuộn KHÔNG được tính là số thật: ghe chưa cân không vào mẫu', () => {
  const before = item('boat_straw_payload_tons').samples;
  const pending = field.pendingWeighings();
  assert.ok(pending.length >= 1, 'seed để lại ghe chưa cân');
  assert.equal(item('boat_straw_payload_tons').samples, before, 'ghe chưa cân không làm tăng mẫu');
  // Cân xong thì vào mẫu.
  field.recordPlantWeighing(String(pending[0].id), { netKg: 27_000 }, actor);
  assert.equal(item('boat_straw_payload_tons').samples, before + 1);
});

test('Hao hụt (#19) đo bằng cuộn đếm ở ruộng so với cuộn đếm lại ở nhà máy', () => {
  const row = item('loss_ratio');
  assert.ok(row.samples >= 3);
  assert.ok(row.actual! >= 0 && row.actual! < 5, `hao hụt ${row.actual} %`);
  assert.match(row.basis, /cuộn/);
});

test('Chưa đủ mẫu → "chưa đủ dữ liệu", không có độ lệch, không đề xuất được', () => {
  const row = item('truck_payload_tons');
  assert.equal(row.fit, 'chua_du_du_lieu');
  assert.equal(row.deviationPct, null);
  assert.equal(row.suggested, null);
  assert.throws(() => actuals.proposeFromActual('truck_payload_tons', {}, actor), /Chưa đủ dữ liệu/);
});

test('Cước vận tải chỉ tính chuyến có NHẬP chi phí thực; chuyến lấy chi phí theo đơn giá bị loại', () => {
  const plant = one<{ lat: number; lng: number }>(`SELECT lat, lng FROM facilities WHERE kind = 'plant'`)!;
  const from = { lat: 10.38, lng: 105.43 };
  const make = (cost?: number) => {
    const trip = tms.createTrip({ mode: 'road', from, to: plant, plannedTons: 15 }, actor) as { id: string };
    tms.completeTrip(trip.id, { actualTons: 15, actualCost: cost }, actor);
    return trip.id;
  };
  make(); make(); make(); // theo đơn giá — tự khớp, không được tính
  assert.equal(item('road_freight_rate').samples, 0, 'chuyến theo đơn giá bị loại');
  assert.equal(one<{ s: string }>(`SELECT actual_cost_source AS s FROM trips WHERE mode = 'road' ORDER BY created_at DESC LIMIT 1`)!.s, 'theo_don_gia');

  const distance = one<{ d: number }>(`SELECT distance_km AS d FROM trips WHERE mode = 'road' LIMIT 1`)!.d;
  const perTonKm = 2_600;
  make(15 * distance * perTonKm); make(15 * distance * perTonKm); make(15 * distance * perTonKm);
  const row = item('road_freight_rate');
  assert.equal(row.samples, 3);
  assert.ok(Math.abs(row.actual! - perTonKm) <= 1, `cước thực ${row.actual}`);
  assert.equal(row.fit, 'lech_lon', '2 600 so với giả định 2 200 là +18 %');
  // Đủ chuyến xe hoàn thành → tải trọng xe cũng có số.
  assert.equal(item('truck_payload_tons').actual, 15);
});

test('Đề xuất giá trị mới đi qua luồng phê duyệt: giá trị đổi, phê duyệt cũ mất, phiên bản mới, Tài chính được báo', () => {
  const before = params.getParameter('road_freight_rate')!;
  params.approveParameter('straw_to_paddy_ratio', 'Tài chính', actor); // để có phiên bản đối chiếu
  const versionBefore = params.currentParameterSetVersion();
  run('DELETE FROM notifications');

  const result = actuals.proposeFromActual('road_freight_rate', { days: 90 }, actor);
  assert.equal(result.previous, before.value_base);
  assert.equal(result.parameter.value_base, result.comparison.suggested);
  assert.equal(result.parameter.approved_by, null, 'đổi giá trị làm mất phê duyệt cũ');
  assert.match(String(result.parameter.data_source), /Số liệu vận hành thực tế \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/);
  assert.ok(!String(result.parameter.data_source).includes('undefined'));
  assert.equal(params.currentParameterSetVersion(), versionBefore + 1, 'BR-03: sinh phiên bản bộ tham số mới');

  const notes = all<{ title: string; recipient_user_id: string }>(`SELECT n.title, n.recipient_user_id FROM notifications n
    JOIN user_roles r ON r.user_id = n.recipient_user_id WHERE r.role = 'finance' AND n.channel = 'inapp'`);
  assert.ok(notes.some((n) => /chờ duyệt lại/.test(n.title)), 'Tài chính nhận thông báo');

  // Sau khi đề xuất, thực tế trùng giả định → khớp; đề xuất lần nữa bị từ chối vì không cần.
  assert.equal(item('road_freight_rate').fit, 'khop');
  assert.throws(() => actuals.proposeFromActual('road_freight_rate', {}, actor), /không cần đổi/);
});

test('Tham số không có cách đo hoặc không tồn tại → lỗi rõ ràng', () => {
  assert.throws(() => actuals.proposeFromActual('plant_annual_demand', {}, actor), /chưa có cách đo/);
  assert.throws(() => actuals.proposeFromActual('khong_co', {}, actor), /Không tìm thấy/);
});

test('Kỳ đối chiếu ngắn hơn loại bớt mẫu cũ', () => {
  const long = item('boat_straw_payload_tons', 365).samples;
  const short = item('boat_straw_payload_tons', 3).samples;
  assert.ok(short <= long);
});
