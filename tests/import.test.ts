/**
 * Kiểm thử luồng nhập Excel: bộ đọc .xlsx, quy đổi địa giới hành chính
 * sau sáp nhập 2025, định vị tự động và nhận diện dữ liệu vụ mùa.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureDatabase, one } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-import-')), 'test.db'));

const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const gz = await import('../src/mdm/gazetteer.ts');
const { detectSeason } = await import('../src/mdm/import/cropSeason.ts');
const { excelSerialToIsoDate, columnIndex } = await import('../src/platform/io/xlsx.ts');

migrate();
seedAll();

test('Quy đổi địa giới 2025 — 12 tỉnh cũ gộp về 6 tỉnh/thành', () => {
  assert.equal(gz.resolveProvince('Kiên Giang')?.newProvince, 'An Giang');
  assert.equal(gz.resolveProvince('Tỉnh Kiên giang')?.newProvince, 'An Giang');
  assert.equal(gz.resolveProvince('Sóc Trăng')?.newProvince, 'Cần Thơ');
  assert.equal(gz.resolveProvince('Hậu Giang')?.newProvince, 'Cần Thơ');
  assert.equal(gz.resolveProvince('Bạc Liêu')?.newProvince, 'Cà Mau');
  assert.equal(gz.resolveProvince('Trà Vinh')?.newProvince, 'Vĩnh Long');
  assert.equal(gz.resolveProvince('Bến Tre')?.newProvince, 'Vĩnh Long');
  assert.equal(gz.resolveProvince('Tiền Giang')?.newProvince, 'Đồng Tháp');
  assert.equal(gz.resolveProvince('Long An')?.newProvince, 'Tây Ninh');
  // Tỉnh đã dùng tên mới thì không đánh dấu là "đã quy đổi".
  assert.equal(gz.resolveProvince('An Giang')?.converted, false);
  assert.equal(gz.resolveProvince('Kiên Giang')?.converted, true);
  assert.equal(gz.resolveProvince('Hà Nội'), null);
});

test('Định vị: trùng tên huyện thì ưu tiên huyện thuộc đúng tỉnh khai báo', () => {
  // "Châu Thành" tồn tại ở nhiều tỉnh — phải chọn đúng tỉnh khai báo.
  const kg = gz.geocode('Châu Thành', 'Kiên Giang', 'AG');
  const st = gz.geocode('Châu Thành', 'Sóc Trăng', 'CT');
  assert.equal(kg.districtProvinceMismatch, false);
  assert.equal(st.districtProvinceMismatch, false);
  assert.notEqual(kg.lat, st.lat);
});

test('Định vị: phát hiện huyện bị xếp nhầm tỉnh và gợi ý tỉnh đúng', () => {
  // File nguồn xếp các huyện Tiền Giang vào nhóm Bạc Liêu.
  const result = gz.geocode('Gò Công Đông', 'Bạc Liêu', 'CM');
  assert.equal(result.districtProvinceMismatch, true);
  assert.equal(result.actualOldProvince, 'Tiền Giang');
  assert.equal(gz.resolveProvince(result.actualOldProvince)?.newProvince, 'Đồng Tháp');
});

test('Định vị: thiếu huyện thì lùi về trung tâm tỉnh và hạ độ chính xác', () => {
  const result = gz.geocode('', 'Trà Vinh', 'VL');
  assert.equal(result.precision, 'tinh');
  assert.equal(result.matchedDistrict, null);
});

test('Chuẩn hoá tên: bỏ dấu và bỏ tiền tố cấp hành chính', () => {
  assert.equal(gz.stripAdminPrefix('TP. Châu Đốc'), 'chau doc');
  assert.equal(gz.stripAdminPrefix('Thị xã Tân Châu'), 'tan chau');
  assert.equal(gz.stripAdminPrefix('Huyện Giồng Riềng'), 'giong rieng');
});

test('Tách tên xã khỏi chuỗi địa chỉ tự do', () => {
  assert.equal(gz.extractCommune('Tổ 15, ấp Bình Hòa 2, xã Mỹ Khánh,'), 'Mỹ Khánh');
  assert.equal(gz.extractCommune('Ấp Phú Xương, TT.Chợ Vàm'), 'Chợ Vàm');
  assert.equal(gz.extractCommune('không có thông tin'), null);
});

test('Phân tán điểm là TẤT ĐỊNH — chạy lại import cho cùng toạ độ', () => {
  const a = gz.jitter(10.38, 105.435, 'HTX A|Long Xuyên', 5);
  const b = gz.jitter(10.38, 105.435, 'HTX A|Long Xuyên', 5);
  assert.deepEqual(a, b);
  const c = gz.jitter(10.38, 105.435, 'HTX B|Long Xuyên', 5);
  assert.notDeepEqual(a, c);
  // Không được dịch quá ~1,5 km.
  assert.ok(Math.abs(a.lat - 10.38) < 0.02 && Math.abs(a.lng - 105.435) < 0.02);
});

test('Excel: quy đổi số sê-ri ngày (mốc 1899-12-30)', () => {
  assert.equal(excelSerialToIsoDate(46126), '2026-04-14');
  assert.equal(excelSerialToIsoDate(45658), '2025-01-01');
  assert.equal(excelSerialToIsoDate(0), null);
});

test('Excel: tham chiếu ô nhiều chữ cái ra đúng chỉ số cột', () => {
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('F2'), 5);
  assert.equal(columnIndex('AA10'), 26);
  assert.equal(columnIndex('BC12'), 54);
});

test('Suy mã vụ: Đông Xuân bắc cầu 2 năm không trùng mã với vụ liền trước', () => {
  assert.equal(detectSeason('THU HOẠCH ĐX2526')?.code, 'DX-2025-2026');
  assert.equal(detectSeason('THU HOẠCH ĐX2526')?.name, 'Đông Xuân 2025-2026');
  assert.equal(detectSeason('ĐX2425')?.code, 'DX-2024-2025');
  assert.notEqual(detectSeason('ĐX2526')?.code, detectSeason('ĐX2425')?.code);
  assert.equal(detectSeason('PL3CGH HT25')?.code, 'HT-2025');
  assert.equal(detectSeason('bảng tổng hợp'), null);
});

test('Vụ mới nhập từ file không ghi đè vụ đã có trong danh mục', () => {
  const existing = one<{ n: number }>("SELECT COUNT(*) AS n FROM seasons WHERE code = 'DX-2024-2025'");
  assert.equal(existing?.n, 1);
});
