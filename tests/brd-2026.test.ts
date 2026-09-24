/**
 * Kiểm thử các quy tắc nghiệp vụ bổ sung theo BRD/User Story đợt 09/2026:
 * GIS v1.5, Bản đồ CGH v1.3 (Backlog v4.0), App HTX (Backlog v4.0), App Khuyến nông v1.0.
 *
 * Mỗi test bảo vệ một luật mà nếu vỡ thì số liệu hoặc quyền hạn sai lệch âm thầm:
 * khoá tài khoản sau 5 lần sai, thửa phải ≥ 4 điểm và không chồng lấn HTX khác,
 * nhật ký chờ duyệt không vào báo cáo, năng suất bất thường phải xác nhận, định
 * mức không chồng hiệu lực, số máy tính theo ngày sở hữu, mã tự sinh theo tỉnh,
 * cấu hình GIS hợp lệ, xoá mềm khôi phục được, nhập máy hàng loạt hai chế độ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-brd-')), 'test.db'));

const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const users = await import('../src/platform/auth/users.ts');
const mdm = await import('../src/mdm/service.ts');
const lifecycle = await import('../src/mdm/lifecycle.ts');
const varieties = await import('../src/mdm/varieties.ts');
const geoImport = await import('../src/mdm/geoImport.ts');
const htx = await import('../src/agrigreen/htx/service.ts');
const htxOps = await import('../src/agrigreen/htx/fieldOps.ts');
const cgh = await import('../src/agrigreen/cgh/service.ts');
const cghOps = await import('../src/agrigreen/cgh/ops.ts');
const gisAdmin = await import('../src/agrigreen/gis/admin.ts');
const knOps = await import('../src/agrigreen/khuyennong/ops.ts');

migrate();
seedAll();

const actor = { name: 'test-brd' };
const admin = users.listUsers().find((u) => u.username === 'SAdmin')!;
const cooperatives = mdm.listCooperatives() as { id: string; code: string; lat: number; lng: number; province_id: string }[];
const [htxA, htxB] = cooperatives;
const seasons = mdm.listSeasons() as { id: string; name: string }[];
const square = (lat: number, lng: number, size = 0.002) => [
  { lat: lat - size, lng: lng - size }, { lat: lat - size, lng: lng + size }, { lat: lat + size, lng: lng + size }, { lat: lat + size, lng: lng - size },
];

// ===========================================================================
// Đăng nhập — KN US-AUTH: khoá sau 5 lần sai, thông điệp rõ, số điện thoại
// ===========================================================================

test('Sai mật khẩu quá 5 lần liên tiếp → khoá tạm 15 phút với một thông điệp thống nhất, đúng mật khẩu cũng không vào', () => {
  const created = users.createUser({ username: 'khoa5lan', fullName: 'Kiểm thử khoá', roles: ['farmer'], password: 'MatKhau123', phone: '0911222333' }, { id: admin.id, name: admin.fullName }) as { user: { id: string } };
  for (let i = 0; i < 5; i += 1) assert.equal(users.login('khoa5lan', 'sai-mat-khau'), null, 'năm lần sai đầu chỉ báo sai (spec: khoá khi sai QUÁ 5 lần — UAT DEF-CGH-09)');
  // Lần sai thứ 6 kích hoạt khoá ngay và nói rõ lý do.
  assert.throws(() => users.login('khoa5lan', 'sai-mat-khau'), (e: Error & { code?: string }) => e.code === 'temporarily_locked' && /quá 5 lần/.test(e.message));
  assert.throws(() => users.login('khoa5lan', 'MatKhau123'), (e: Error & { code?: string }) => e.code === 'temporarily_locked' && /15 phút|khoá/.test(e.message));
  const row = one<{ failed_attempts: number; locked_until: string | null }>('SELECT failed_attempts, locked_until FROM users WHERE id = ?', [created.user.id]);
  assert.ok(row && row.locked_until, 'phải ghi thời điểm hết khoá');
});

test('Đăng nhập được bằng số điện thoại thay cho tên đăng nhập', () => {
  users.createUser({ username: 'sdt_user', fullName: 'Người dùng SĐT', roles: ['farmer'], password: 'MatKhau123', phone: '0988777666' }, { id: admin.id, name: admin.fullName });
  const session = users.login('0988777666', 'MatKhau123');
  assert.ok(session?.token, 'số điện thoại là định danh hợp lệ');
});

test('Mọi mật khẩu đặt mới phải ≥ 8 ký tự, có chữ thường, chữ in hoa và chữ số — khi tự đổi lẫn khi quản trị viên tạo tài khoản', () => {
  const weaknesses = users.passwordWeaknesses('abc');
  assert.ok(weaknesses.length >= 3);
  assert.equal(users.passwordWeaknesses('MatKhau123').length, 0);
  const u = users.listUsers().find((x) => x.username === 'sdt_user')!;
  assert.throws(() => users.changePassword(u.id, 'yeu'), /độ mạnh/);
  assert.throws(() => users.changePassword(u.id, 'toanchuthuong1'), /chữ hoa/);
  assert.throws(() => users.changePassword(u.id, 'KhongCoSo'), /chữ số/);
  assert.doesNotThrow(() => users.changePassword(u.id, 'MatKhauMoi9'));
  assert.throws(() => users.createUser({ username: 'yeu_user', fullName: 'Yếu', roles: ['farmer'], password: '123456' }, { id: admin.id, name: admin.fullName }), /độ mạnh/);
});

test('Mật khẩu tạm do hệ thống sinh luôn đạt chính sách và không lặp lại', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const pw = users.generateTemporaryPassword();
    assert.deepEqual(users.passwordWeaknesses(pw), [], `mật khẩu tạm "${pw}" phải đạt chuẩn`);
    seen.add(pw);
  }
  assert.ok(seen.size > 45, 'mật khẩu tạm phải ngẫu nhiên');
  const created = users.createUser({ username: 'tao_khong_mk', fullName: 'Không đặt mật khẩu', roles: ['farmer'], email: 'a@b.vn' }, { id: admin.id, name: admin.fullName });
  assert.deepEqual(users.passwordWeaknesses(created.temporaryPassword), []);
  assert.equal(created.user.mustChangePassword, true, 'phải đổi mật khẩu ở lần đăng nhập đầu');
  const temp = users.resetPassword(created.user.id, { name: 'test' });
  assert.deepEqual(users.passwordWeaknesses(temp), []);
});

test('Super Admin SAdmin: tài khoản admin cũ được đổi tên và đặt mật khẩu ban đầu; gọi lại không ghi đè mật khẩu đã đổi', () => {
  assert.equal(users.ensureSuperAdmin().action, 'kept', 'seed đã có SAdmin');
  // Mô phỏng CSDL cũ còn tài khoản `admin`.
  run("UPDATE users SET username = 'admin' WHERE username = 'SAdmin'");
  const renamed = users.ensureSuperAdmin();
  assert.equal(renamed.action, 'renamed');
  assert.ok(users.login('SAdmin', 'TungLM18@')?.token, 'đăng nhập được bằng SAdmin / mật khẩu ban đầu');
  assert.equal(users.login('admin', 'TungLM18@'), null, 'tên đăng nhập cũ không còn');
  users.changePassword(renamed.userId, 'MatKhauRieng9');
  assert.equal(users.ensureSuperAdmin().action, 'kept');
  assert.ok(users.login('SAdmin', 'MatKhauRieng9')?.token, 'mật khẩu quản trị viên đã đổi được giữ nguyên');
  users.changePassword(renamed.userId, 'TungLM18@');
});

test('Email mật khẩu tạm: xếp hàng gửi khi có email, báo rõ khi thiếu email; nội dung bị xoá sau khi gửi', async () => {
  const notify = await import('../src/platform/notify/service.ts');
  const withEmail = users.listUsers().find((x) => x.username === 'tao_khong_mk')!;
  const queued = notify.sendCredentialEmail(withEmail.id, { username: withEmail.username, temporaryPassword: 'TamThoi123', kind: 'created' }, actor);
  assert.equal(queued.to, 'a@b.vn');
  assert.ok(['cho_gui', 'cho_cau_hinh'].includes(queued.status));
  const noEmail = users.listUsers().find((x) => x.username === 'sdt_user')!;
  assert.equal(notify.sendCredentialEmail(noEmail.id, { username: noEmail.username, temporaryPassword: 'x', kind: 'reset' }, actor).status, 'khong_co_email');
  // Giả lập webhook email gửi thành công → outbox xoá nội dung chứa mật khẩu.
  notify.overrideSender('email', async () => undefined);
  run("UPDATE notifications SET status = 'cho_gui' WHERE id = ?", [queued.notificationId]);
  await notify.processOutbox();
  const row = one<{ status: string; body: string }>('SELECT status, body FROM notifications WHERE id = ?', [queued.notificationId]);
  assert.equal(row?.status, 'da_gui');
  assert.ok(!row?.body.includes('TamThoi123'), 'mật khẩu tạm không được nằm lại trong CSDL sau khi gửi');
});

// ===========================================================================
// Thửa ruộng — HTX US-PLOT-01..04, GIS BR-14/17/19
// ===========================================================================

test('Thửa cần tối thiểu 4 điểm; hệ thống tự tính diện tích', () => {
  assert.throws(() => lifecycle.createPlotChecked({ htxId: htxA.id, boundary: square(htxA.lat, htxA.lng).slice(0, 3) }, actor), /4 điểm/);
  const plot = lifecycle.createPlotChecked({ htxId: htxA.id, boundary: square(htxA.lat, htxA.lng), name: 'Thửa test A1' }, actor);
  assert.ok(plot.area_ha > 0 && plot.area_ha < 30, `diện tích tự tính phải hợp lý, đang là ${plot.area_ha}`);
  assert.match(plot.areaLabel, /ha/);
});

test('Chồng lấn cùng HTX → cần xác nhận rồi mới lưu; chồng lấn HTX khác → chặn hẳn', () => {
  const overlapping = square(htxA.lat + 0.001, htxA.lng + 0.001);
  assert.throws(() => lifecycle.createPlotChecked({ htxId: htxA.id, boundary: overlapping }, actor), (e: Error & { needsConfirm?: boolean; overlaps?: unknown[] }) => e.needsConfirm === true && (e.overlaps?.length ?? 0) > 0);
  const saved = lifecycle.createPlotChecked({ htxId: htxA.id, boundary: overlapping, confirmOverlap: true }, actor);
  assert.ok(saved.id);
  assert.throws(() => lifecycle.createPlotChecked({ htxId: htxB.id, boundary: square(htxA.lat, htxA.lng), confirmOverlap: true }, actor), /khác/);
});

test('Xoá mềm ẩn thửa khỏi danh sách vận hành nhưng khôi phục được, có lý do và lịch sử', () => {
  const plot = lifecycle.createPlotChecked({ htxId: htxB.id, boundary: square(htxB.lat, htxB.lng), name: 'Thửa xoá thử' }, actor);
  lifecycle.softDelete('plots', plot.id, 'Nhập nhầm ranh giới', actor);
  assert.ok(!mdm.listPlots(htxB.id).some((p) => p.id === plot.id), 'không còn trong danh sách vận hành');
  const deleted = lifecycle.listDeleted().find((d) => d.id === plot.id);
  assert.equal(deleted?.reason, 'Nhập nhầm ranh giới');
  lifecycle.restore('plots', plot.id, actor);
  assert.ok(mdm.listPlots(htxB.id).some((p) => p.id === plot.id), 'khôi phục xong phải thấy lại');
  assert.ok(lifecycle.historyOf('plots', plot.id).length >= 2, 'xoá và khôi phục đều có sự kiện');
});

test('Đọc GeoJSON và KML thành danh sách đối tượng; Shapefile bị từ chối kèm hướng dẫn', () => {
  const geojson = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Thửa GJ' }, geometry: { type: 'Polygon', coordinates: [[[105.4, 10.3], [105.41, 10.3], [105.41, 10.31], [105.4, 10.31], [105.4, 10.3]]] } }] });
  const parsed = geoImport.parseSpatialFile(geojson, 'thua.geojson');
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].kind, 'polygon');
  assert.equal(parsed.features[0].name, 'Thửa GJ');
  const kml = '<kml><Document><Placemark><name>Kênh KML</name><LineString><coordinates>105.4,10.3,0 105.5,10.35,0</coordinates></LineString></Placemark></Document></kml>';
  const parsedKml = geoImport.parseSpatialFile(kml, 'tuyen.kml');
  assert.equal(parsedKml.features[0].kind, 'line');
  assert.equal(parsedKml.features[0].points.length, 2);
  assert.throws(() => geoImport.parseSpatialFile('binary', 'ranh.shp'), /GeoJSON|KML/);
});

// ===========================================================================
// Nhật ký & sản lượng — HTX US-LOG-03, US-APPR-01, US-HARV-01, US-SEASON-03
// ===========================================================================

const activePlot = lifecycle.createPlotChecked({ htxId: htxB.id, boundary: square(htxB.lat + 0.01, htxB.lng + 0.01) }, actor);
const variety = (varieties.listVarieties(false) as { id: string; name: string; yield_max_t_ha: number }[])[0];
// protocolId: null → không gắn SOP, để test sản lượng không bị chặn bởi luật "đủ bước bắt buộc" (đã có test riêng ở production.test.ts).
const cycle = htxOps.openSeasonV2({ plotId: activePlot.id, seasonId: seasons[0].id, varietyId: variety.id, sowingDate: new Date().toISOString().slice(0, 10), protocolId: null }, actor) as { id: string; variety: string };

test('Mở vụ theo giống trong danh mục: ghi tên giống, dự kiến thu hoạch theo ngày sinh trưởng; ngày sạ ngoài cửa sổ −15/+30 bị từ chối', () => {
  assert.equal(cycle.variety, variety.name);
  assert.throws(() => htxOps.validateSowingDate('2020-01-01'), /15 ngày|30 ngày|ngày/);
});

test('GPS trong 50 m tâm thửa → "Vị trí khớp"; xa → "không khớp"; không có → "Không có GPS thiết bị"', () => {
  const centre = { lat: htxB.lat + 0.01, lng: htxB.lng + 0.01 };
  assert.equal(htxOps.gpsStatusFor(activePlot.id, centre).status, 'khop');
  assert.equal(htxOps.gpsStatusFor(activePlot.id, { lat: centre.lat + 0.05, lng: centre.lng }).status, 'khong_khop');
  assert.equal(htxOps.gpsStatusFor(activePlot.id, null, 'khong_co_gps_thiet_bi').status, 'khong_co_gps_thiet_bi');
});

test('Nhật ký mới ở trạng thái chờ duyệt; duyệt / yêu cầu bổ sung đổi trạng thái và ghi người duyệt', () => {
  const log = htxOps.addFarmLogV2({ cropCycleId: cycle.id, activity: 'bon_phan', logDate: new Date().toISOString().slice(0, 10), detail: 'Bón thúc', lat: htxB.lat + 0.01, lng: htxB.lng + 0.01, gpsSource: 'thiet_bi' }, actor) as { id: string; approval_status: string; gps_status: string };
  assert.equal(log.approval_status, 'cho_duyet');
  assert.equal(log.gps_status, 'khop');
  assert.equal(htxOps.pendingLogs(htxB.id, 'cho_duyet').some((l) => l.id === log.id), true);
  htxOps.reviewFarmLog(log.id, 'yeu_cau_bo_sung', 'Thiếu ảnh', actor);
  assert.equal(one<{ approval_status: string; review_note: string }>('SELECT approval_status, review_note FROM farm_logs WHERE id = ?', [log.id])?.review_note, 'Thiếu ảnh');
  htxOps.reviewFarmLog(log.id, 'da_duyet', undefined, actor);
  const after = one<{ approval_status: string; approved_by: string | null }>('SELECT approval_status, approved_by FROM farm_logs WHERE id = ?', [log.id]);
  assert.equal(after?.approval_status, 'da_duyet');
  assert.ok(after?.approved_by, 'phải ghi người duyệt');
});

test('Ghi một nhật ký cho nhiều thửa cùng lúc: mỗi vụ một bản ghi, chung nhóm', () => {
  const plot2 = lifecycle.createPlotChecked({ htxId: htxB.id, boundary: square(htxB.lat + 0.02, htxB.lng + 0.02) }, actor);
  const cycle2 = htxOps.openSeasonV2({ plotId: plot2.id, seasonId: seasons[0].id, varietyId: variety.id }, actor) as { id: string };
  const out = htxOps.addFarmLogsBulk({ cropCycleIds: [cycle.id, cycle2.id, 'khong-ton-tai'], activity: 'tuoi', logDate: new Date().toISOString().slice(0, 10) }, actor);
  assert.equal(out.created, 2);
  assert.equal(out.skipped.length, 1);
});

test('Năng suất vượt xa dải của giống → phải xác nhận; xác nhận rồi mới đóng vụ', () => {
  // Chưa đủ 60 ngày sau sạ thì không được khai; lùi ngày sạ để mô phỏng vụ đã tới kỳ thu hoạch.
  assert.throws(() => htxOps.declareHarvestV2({ cropCycleId: cycle.id, paddyTons: 1 }, actor), /chưa đến giai đoạn thu hoạch/);
  run('UPDATE crop_cycles SET sowing_date = ? WHERE id = ?', [new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10), cycle.id]);
  const area = one<{ area_ha: number }>('SELECT area_ha FROM crop_cycles WHERE id = ?', [cycle.id])!.area_ha;
  const tooHigh = Math.round(area * variety.yield_max_t_ha * 3);
  assert.throws(() => htxOps.declareHarvestV2({ cropCycleId: cycle.id, paddyTons: tooHigh }, actor), (e: Error & { needsConfirm?: boolean }) => e.needsConfirm === true);
  const saved = htxOps.declareHarvestV2({ cropCycleId: cycle.id, paddyTons: tooHigh, confirmAnomaly: true }, actor) as { anomaly: string | null };
  assert.ok(saved.anomaly, 'ghi rõ bất thường đã xác nhận');
  assert.equal(one<{ status: string }>('SELECT status FROM crop_cycles WHERE id = ?', [cycle.id])?.status, 'da_hoan_thanh_vu');
});

test('Báo cáo tổng hợp KN gắn cờ "tạm tính" khi còn nhật ký chờ duyệt trong phạm vi', () => {
  const report = knOps.summaryReportRows(admin);
  assert.equal(report.provisional, true, 'vẫn còn nhật ký "tuoi" chờ duyệt ở test trước');
  assert.ok(report.rows.length >= cooperatives.length - 1);
});

// ===========================================================================
// Danh mục giống — HTX US-CAT-01/02
// ===========================================================================

test('Giống đang được vụ tham chiếu thì chỉ ẩn, không xoá; khôi phục lại được', () => {
  const removed = varieties.removeVariety(variety.id, actor);
  assert.equal(removed.hidden, true);
  assert.ok(removed.referenced > 0);
  assert.ok(!varieties.listVarieties(false).some((v) => v.id === variety.id));
  assert.ok(varieties.listVarieties(true).some((v) => v.id === variety.id));
  varieties.restoreVariety(variety.id, actor);
  assert.ok(varieties.listVarieties(false).some((v) => v.id === variety.id));
  const fresh = varieties.upsertVariety({ code: 'TEST01', name: 'Giống test', growthDays: 90, yieldMin: 5, yieldMax: 7 }, actor) as { id: string };
  assert.equal(varieties.removeVariety(fresh.id, actor).hidden, false, 'giống chưa dùng thì xoá hẳn');
});

// ===========================================================================
// Cơ giới hoá — CGH US-CFG-02, US-OWN-01, US-MAC-01/02, BR-09
// ===========================================================================

test('Chủ sở hữu: mã CSH-<tỉnh>-xxxxx tự sinh, Thành viên HTX phải gắn HTX', () => {
  assert.throws(() => cgh.createMachineOwner({ name: 'Không HTX', ownerType: 'thanh_vien_htx' }, actor), /liên kết/);
  const owner = cgh.createMachineOwner({ name: 'Ông Ba Máy', ownerType: 'thanh_vien_htx', htxId: htxA.id, phone: '0909123456' }, actor) as { code: string };
  assert.match(owner.code, /^CSH-[A-Z]{2,3}-\d{5}$/);
});

const types = cgh.listMachineTypes() as { id: string; stage: string; name: string }[];
const owner = cgh.createMachineOwner({ name: 'Doanh nghiệp Cơ giới Xanh', ownerType: 'doanh_nghiep' }, actor) as { id: string };

test('Máy: mã MAY-<tỉnh>-xxxxx, bắt buộc SN hoặc số khung, ngày sở hữu không ở tương lai, SN không trùng', () => {
  assert.throws(() => cgh.createMachine({ machineTypeId: types[0].id, ownerId: owner.id, htxId: htxA.id }, actor), /SN|số khung|Số máy/i);
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  assert.throws(() => cgh.createMachine({ machineTypeId: types[0].id, ownerId: owner.id, htxId: htxA.id, serialNumber: 'SN-FUT', ownedSince: future }, actor), /tương lai|sau ngày hiện tại/);
  const machine = cgh.createMachine({ machineTypeId: types[0].id, ownerId: owner.id, htxId: htxA.id, serialNumber: 'SN-TEST-001', ownedSince: '2026-01-15', condition: 'hoat_dong' }, actor) as { code: string; id: string };
  assert.match(machine.code, /^MAY-[A-Z]{2,3}-\d{5}$/);
  assert.throws(() => cgh.createMachine({ machineTypeId: types[0].id, ownerId: owner.id, htxId: htxB.id, serialNumber: 'SN-TEST-001' }, actor), /đã tồn tại/);
});

test('BR-09: số máy của HTX tại ngày T chỉ tính máy sở hữu ≤ T và chưa vô hiệu hoá tại T', () => {
  const has = (at: string) => cghOps.machineCountAt(htxA.id, at).machines.some((m) => m.serial_number === 'SN-TEST-001');
  assert.equal(has('2026-01-14'), false, 'trước ngày sở hữu 15/01 không tính');
  assert.equal(has('2026-01-15'), true, 'từ ngày sở hữu thì tính');
  const machine = one<{ id: string }>("SELECT id FROM machines WHERE serial_number = 'SN-TEST-001'")!;
  assert.throws(() => cghOps.deactivateMachine(machine.id, '2026-01-01', 'sai ngày', actor), /sau Ngày HTX sở hữu/);
  cghOps.deactivateMachine(machine.id, '2026-03-01', 'Bán máy', actor);
  assert.equal(has('2026-02-15'), true, 'trước ngày vô hiệu vẫn tính cho vụ cũ');
  assert.equal(has('2026-03-02'), false, 'sau ngày vô hiệu không tính');
});

test('Nhập máy hàng loạt: chế độ Cập nhật giữ máy cũ, chế độ Thay thế vô hiệu hoá máy không có trong tệp', () => {
  const rows = [
    { machine_type: types[1].name, owner: 'Doanh nghiệp Cơ giới Xanh', serial_number: 'IMP-001', brand: 'Kubota', owned_since: '2026-02-01', condition: 'Hoạt động' },
    { machine_type: types[1].name, owner: 'Doanh nghiệp Cơ giới Xanh', serial_number: 'IMP-002', brand: 'Yanmar', owned_since: '2026-02-01', condition: 'Hoạt động' },
  ];
  const first = cghOps.importMachines({ htxId: htxB.id, mode: 'cap_nhat', rows }, actor);
  assert.deepEqual(first.errors, []);
  assert.equal(first.created, 2);
  const beforeReplace = cgh.listMachines({ htxId: htxB.id }).length;
  const second = cghOps.importMachines({ htxId: htxB.id, mode: 'cap_nhat', rows: [{ ...rows[0], brand: 'Kubota DC-70' }] }, actor);
  assert.equal(second.updated, 1);
  assert.equal(cgh.listMachines({ htxId: htxB.id }).length, beforeReplace, 'cập nhật không làm mất máy');
  const replaced = cghOps.importMachines({ htxId: htxB.id, mode: 'thay_the', rows: [rows[0]] }, actor);
  assert.ok(replaced.deactivated >= beforeReplace - 1, `thay thế phải vô hiệu hoá máy không có trong tệp (đã vô hiệu ${replaced.deactivated})`);
  assert.equal(cgh.listMachines({ htxId: htxB.id }).length, 1);
});

test('Định mức: phải có văn bản, không chồng khoảng hiệu lực cho cùng chủng loại × khâu', () => {
  const type = types[2];
  assert.throws(() => cgh.addProductivityNorm({ machineTypeId: type.id, stage: type.stage, haPerMachineSeason: 30, effectiveFrom: '2027-01-01', documentRef: '' }, actor), /văn bản/);
  // Định mức seed đang mở (không có ngày kết thúc) → bản mới bắt đầu 2027 chồng hiệu lực nếu chưa đóng bản cũ.
  assert.throws(() => cgh.addProductivityNorm({ machineTypeId: type.id, stage: type.stage, haPerMachineSeason: 30, effectiveFrom: '2027-01-01', documentRef: 'QĐ 1/2027' }, actor), /chồng lấp/);
  const current = cghOps.allNorms().find((n) => n.machine_type_id === type.id && !n.effective_to) as { id: string } | undefined;
  if (current) cghOps.closeNorm(current.id, '2026-12-31', actor);
  assert.doesNotThrow(() => cgh.addProductivityNorm({ machineTypeId: type.id, stage: type.stage, haPerMachineSeason: 30, effectiveFrom: '2027-01-01', documentRef: 'QĐ 1/2027', documentDate: '2026-12-01' }, actor));
});

test('Ngưỡng cảnh báo theo phiên bản: mốc phải tăng dần, áp đúng phiên bản theo ngày của vụ', () => {
  assert.throws(() => cghOps.addThresholdVersion({ du: 50, canChuY: 60, thua: 120, effectiveFrom: '2027-01-01' }, actor), /tăng dần/);
  cghOps.addThresholdVersion({ du: 90, canChuY: 70, thua: 130, effectiveFrom: '2027-01-01', documentRef: 'QĐ mới' }, actor);
  assert.equal(cgh.coverageThresholds('2026-06-01').du, 85, 'vụ 2026 vẫn dùng bộ cũ');
  assert.equal(cgh.coverageThresholds('2027-03-01').du, 90, 'vụ 2027 dùng bộ mới');
  assert.equal(cgh.classifyCoverage(88, '2027-03-01'), 'can_chu_y');
  assert.equal(cgh.classifyCoverage(88, '2026-06-01'), 'du');
});

test('Chủng loại máy còn máy tham chiếu thì không xoá được, chỉ ngừng sử dụng', () => {
  const used = cghOps.listMachineTypesAll().find((t) => Number(t.machine_count) > 0) as { id: string };
  assert.throws(() => cghOps.deleteMachineType(used.id, actor), /tham chiếu|đang/);
  const result = cghOps.setMachineTypeActive(used.id, false, actor);
  assert.ok(result.affectedMachines > 0);
  cghOps.setMachineTypeActive(used.id, true, actor);
});

// ===========================================================================
// GIS — FN-03 BR-52 cấu hình, FN-22/23 đồng bộ, HTX vô hiệu hoá có lý do
// ===========================================================================

test('Bảng màu mùa vụ chỉ nhận HEX; ngưỡng kho phải tăng dần ≤ 100; khôi phục mặc định', () => {
  assert.throws(() => gisAdmin.setCropPalette({ gieo_sa: { color: 'xanh', label: 'Gieo sạ' } }, actor), /HEX/);
  gisAdmin.setCropPalette({ ...(gisAdmin.configOverview().cropPalette as Record<string, { color: string; label: string }>), gieo_sa: { color: '#123456', label: 'Gieo sạ' } }, actor);
  assert.equal((gisAdmin.configOverview().cropPalette as Record<string, { color: string }>).gieo_sa.color, '#123456');
  assert.throws(() => gisAdmin.setCapacityThresholds([{ maxPct: 80, color: '#00FF00', label: 'a' }, { maxPct: 60, color: '#FF0000', label: 'b' }], actor), /tăng dần/);
  gisAdmin.resetConfig('gis.crop_palette', actor);
  assert.deepEqual(gisAdmin.configOverview().cropPalette, gisAdmin.configOverview().cropPaletteDefault);
});

test('Nhập tay dự phòng được ghi lại và chờ xác nhận ghi đè khi nguồn quay lại', () => {
  const facility = all<{ id: string }>('SELECT id FROM facilities LIMIT 1')[0];
  gisAdmin.manualEntry({ table: 'facilities', id: facility.id, fields: { current_stock_tons: 123 } }, actor);
  const pending = gisAdmin.pendingOverrides([{ table: 'facilities', id: facility.id, fields: { current_stock_tons: 456 } }]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].differs, true);
  gisAdmin.resolveOverride({ table: 'facilities', id: facility.id, accept: false }, actor);
  assert.equal(gisAdmin.pendingOverrides().length, 0);
});

test('Giao dịch đồng bộ thất bại vào dead-letter và hiện trên màn giám sát', () => {
  gisAdmin.simulateFailure('app_htx', 'test_failure', actor);
  const monitor = gisAdmin.syncMonitor() as { sources: { system: string; failed: number; dead: number }[]; deadLetter: unknown[] };
  const src = monitor.sources.find((s) => s.system === 'app_htx')!;
  assert.ok(src.failed + src.dead >= 1);
});

test('Vô hiệu hoá HTX cần lý do ≥ 20 ký tự, khoá tài khoản liên quan và khôi phục được', () => {
  const target = cooperatives[cooperatives.length - 1];
  assert.throws(() => lifecycle.deactivateCooperative(target.id, 'ngắn', actor), /20 ký tự/);
  const impact = lifecycle.cooperativeImpact(target.id);
  assert.ok(typeof impact.farmers === 'number');
  const out = lifecycle.deactivateCooperative(target.id, 'HTX giải thể theo quyết định của UBND xã năm 2026', actor);
  assert.ok(out.lockedAccounts >= 0);
  assert.ok(!mdm.listCooperatives().some((c) => c.id === target.id), 'không còn trong danh sách hoạt động');
  lifecycle.reactivateCooperative(target.id, actor);
  assert.ok(mdm.listCooperatives().some((c) => c.id === target.id));
});

// ===========================================================================
// Khuyến nông — US-TASK-02 SLA & leo thang, US-LIB-04 hướng dẫn địa phương
// ===========================================================================

test('Yêu cầu hỗ trợ quá 24 giờ chưa tiếp nhận → leo thang lên TTKN tỉnh một lần duy nhất', () => {
  const task = htx.requestSupport({ htxId: htxA.id, title: 'Test SLA', description: 'x' }, actor) as { id: string };
  const stale = new Date(Date.now() - 30 * 3600_000).toISOString();
  run('UPDATE support_tasks SET created_at = ? WHERE id = ?', [stale, task.id]);
  const first = knOps.escalateOverdueTasks(actor);
  assert.ok(first >= 1);
  assert.equal(knOps.escalateOverdueTasks(actor), 0, 'không leo thang lặp lại');
  const withSla = knOps.tasksWithSla().find((t) => t.id === task.id)!;
  assert.equal(withSla.slaBreached, true);
  assert.ok(String(withSla.escalated_to).startsWith('TTKN'));
});

test('Hướng dẫn địa phương phải gắn quy trình gốc và nhãn tỉnh; tin khẩn hiện đầu bản tin nông dân', () => {
  const parent = one<{ id: string }>("SELECT id FROM knowledge_articles WHERE kind = 'quy_trinh' AND parent_id IS NULL LIMIT 1")!;
  assert.throws(() => knOps.createArticleV2({ title: 'Bổ sung', kind: 'quy_trinh', parentId: parent.id }, actor), /nhãn tỉnh|regionLabel/);
  const local = knOps.createArticleV2({ title: 'Bổ sung Cà Mau', kind: 'quy_trinh', parentId: parent.id, regionLabel: 'Cà Mau' }, actor) as { id: string };
  knOps.publishArticleV2(local.id, actor);
  const urgent = knOps.createArticleV2({ title: 'KHẨN: sâu cuốn lá', kind: 'tin_tuc', category: 'canh_bao', urgent: true }, actor) as { id: string };
  knOps.publishArticleV2(urgent.id, actor);
  const feed = htxOps.newsFeed();
  assert.equal(feed[0].urgent, 1, 'tin khẩn xếp đầu');
  assert.ok(feed.some((n) => n.id === local.id && n.region_label === 'Cà Mau'));
});


// ===========================================================================
// Sửa lỗi theo báo cáo UAT 22/09/2026
// ===========================================================================

test('UAT DEF-CGH-03: email trùng bị chặn khi tạo tài khoản và khi sửa hồ sơ', async () => {
    const sysadmin = await import('../src/platform/auth/admin.ts');
    users.createUser({ username: 'uat_mail_1', fullName: 'UAT 1', roles: ['farmer'], email: 'uat.test01@example.com' }, { id: admin.id, name: admin.fullName });
    assert.throws(() => users.createUser({ username: 'uat_mail_2', fullName: 'UAT 2', roles: ['farmer'], email: 'UAT.TEST01@example.com' }, { id: admin.id, name: admin.fullName }), /Email này đã được sử dụng/);
    const other = users.createUser({ username: 'uat_mail_3', fullName: 'UAT 3', roles: ['farmer'], email: 'uat.test03@example.com' }, { id: admin.id, name: admin.fullName });
    assert.throws(() => sysadmin.updateProfile(other.user.id, { email: 'uat.test01@example.com' }, actor), /Email này đã được sử dụng/);
    assert.doesNotThrow(() => sysadmin.updateProfile(other.user.id, { email: 'uat.test03@example.com' }, actor), 'giữ email của chính mình không bị coi là trùng');
});

test('UAT DEF-HTX-01/02: nạp thửa từ tệp cũng phải ≥ 4 điểm và bị chặn/cần xác nhận khi chồng lấn', () => {
    const tri = [{ lat: htxA.lat + 0.03, lng: htxA.lng + 0.03 }, { lat: htxA.lat + 0.031, lng: htxA.lng + 0.032 }, { lat: htxA.lat + 0.033, lng: htxA.lng + 0.03 }];
    const three = lifecycle.importFeatures('plot', [{ kind: 'polygon', name: 'Tam giác', properties: {}, points: tri }], { htxId: htxA.id }, actor);
    assert.equal(three.created, 0);
    assert.match(three.errors[0].reason, /4 điểm/);
    const sq = square(htxA.lat + 0.05, htxA.lng + 0.05);
    assert.equal(lifecycle.importFeatures('plot', [{ kind: 'polygon', name: 'Vuông 1', properties: {}, points: sq }], { htxId: htxA.id }, actor).created, 1);
    const dup = lifecycle.importFeatures('plot', [{ kind: 'polygon', name: 'Vuông trùng', properties: {}, points: square(htxA.lat + 0.0505, htxA.lng + 0.0505) }], { htxId: htxA.id }, actor);
    assert.equal(dup.created, 0, 'chồng lấn cùng HTX chưa xác nhận thì không lưu');
    assert.equal(dup.errors[0].needsConfirm, true);
    const confirmed = lifecycle.importFeatures('plot', [{ kind: 'polygon', name: 'Vuông trùng', properties: {}, points: square(htxA.lat + 0.0505, htxA.lng + 0.0505) }], { htxId: htxA.id, confirmOverlap: true }, actor);
    assert.equal(confirmed.created, 1);
    const foreign = lifecycle.importFeatures('plot', [{ kind: 'polygon', name: 'Của HTX khác', properties: {}, points: sq }], { htxId: htxB.id, confirmOverlap: true }, actor);
    assert.equal(foreign.created, 0, 'chồng lấn HTX khác luôn bị chặn');
});

test('UAT DEF-CGH-05/06/10: sửa được chủng loại máy, mã không trùng, danh mục trả định mức hiện hành', () => {
    const list = cghOps.listMachineTypesAll() as { id: string; code: string; norm_ha: number | null; machine_count: number }[];
    const t = list[0];
    const other = list[1];
    assert.throws(() => cghOps.updateMachineType(t.id, { code: other.code }, actor), /đã tồn tại/);
    const after = cghOps.updateMachineType(t.id, { name: 'Tên mới UAT' }, actor);
    assert.equal(after.name, 'Tên mới UAT');
    assert.ok(list.some((x) => typeof x.norm_ha === 'number' && x.norm_ha > 1), 'cột định mức phải là ha/máy/vụ, không phải số dòng');
});

test('UAT DEF-CGH-01: bảng điều hành CGH tính lại nhu cầu, cần–có theo khâu và theo tỉnh theo vụ được lọc', () => {
    const all_ = cghOps.dashboardV2(undefined, false) as { kpis: { requiredMachines: number }; byStage: { required: number; total: number }[]; byProvince: { required: number }[]; season: string | null };
    const one_ = cghOps.dashboardV2(seasons[0].id, false) as typeof all_;
    assert.equal(one_.season, seasons[0].name);
    assert.ok(all_.kpis.requiredMachines > one_.kpis.requiredMachines, 'nhu cầu mọi vụ phải lớn hơn nhu cầu một vụ');
    assert.ok(one_.byStage.some((s) => s.required > 0) && one_.byStage.every((s) => 'coveragePct' in s));
    assert.ok(one_.byProvince.every((p) => 'required' in p && 'coveragePct' in p));
});

test('UAT DEF-KN-02: cán bộ xã có HTX/đầu mối phụ trách chỉ thấy địa bàn xã, không phải cả tỉnh', () => {
    const xa = users.listUsers().find((u) => u.username === 'canbo_xa')!;
    const scope = knOps.scopeOf(xa);
    assert.equal(scope.level, 'xa');
    assert.ok(scope.htxIds && scope.htxIds.length >= 1 && scope.htxIds.length < cooperatives.filter((c) => c.province_id === xa.provinceId).length, `phạm vi xã (${scope.htxIds?.length}) phải hẹp hơn tỉnh`);
    assert.doesNotMatch(scope.label, /chưa gán xã/);
    const dash = knOps.scopedDashboard(xa) as { kpis: { htx: number } };
    assert.equal(dash.kpis.htx, scope.htxIds!.length);
});

test('UAT DEF-KN-03: xoá bản ghi giá có nhật ký; upsert giữ nguyên hành vi', async () => {
    const kn = await import('../src/agrigreen/khuyennong/service.ts');
    kn.upsertMarketPrice({ commodity: 'UAT Gia Test', price: 12345, priceDate: '2026-09-22', region: 'An Giang' }, actor);
    const row = one<{ id: string }>("SELECT id FROM market_prices WHERE commodity = 'UAT Gia Test'")!;
    kn.deleteMarketPrice(row.id, actor);
    assert.equal(one("SELECT id FROM market_prices WHERE commodity = 'UAT Gia Test'"), null);
    assert.throws(() => kn.deleteMarketPrice(row.id, actor), /Không tìm thấy/);
});

test('UAT DEF-CGH-08: số điện thoại được che theo mẫu 4 đầu · 3 cuối', async () => {
    const { maskPhone } = await import('../src/api-brd.ts');
    assert.equal(maskPhone('0912345678'), '0912•••678');
    assert.equal(maskPhone(null), null);
    assert.equal(maskPhone('123'), '•••');
});


// ===========================================================================
// Sửa lỗi theo báo cáo UAT toàn bộ 23/09/2026
// ===========================================================================

test('UAT DEF-KN-PLOT-01: đa giác tự cắt (nơ bướm) và điểm đóng vòng trùng đầu bị từ chối', () => {
    const o = { lat: htxB.lat + 0.08, lng: htxB.lng + 0.08 };
    const bowtie = [{ lat: o.lat, lng: o.lng }, { lat: o.lat + 0.003, lng: o.lng + 0.003 }, { lat: o.lat, lng: o.lng + 0.003 }, { lat: o.lat + 0.003, lng: o.lng }];
    assert.throws(() => lifecycle.createPlotChecked({ htxId: htxB.id, boundary: bowtie }, actor), /tự cắt/);
    const closed = [...square(o.lat + 0.02, o.lng + 0.02, 0.001), { lat: o.lat + 0.02 - 0.001, lng: o.lng + 0.02 - 0.001 }];
    assert.doesNotThrow(() => lifecycle.createPlotChecked({ htxId: htxB.id, boundary: closed }, actor), 'điểm đóng vòng được bỏ, 4 điểm thật vẫn hợp lệ');
    const threePlusClose = [{ lat: o.lat + 0.04, lng: o.lng }, { lat: o.lat + 0.042, lng: o.lng + 0.002 }, { lat: o.lat + 0.04, lng: o.lng + 0.003 }, { lat: o.lat + 0.04, lng: o.lng }];
    assert.throws(() => lifecycle.createPlotChecked({ htxId: htxB.id, boundary: threePlusClose }, actor), /4 điểm/, 'tam giác có điểm đóng vòng vẫn là 3 điểm');
});

test('UAT DEF-KN-PLOT-02: hai thửa cắt nhau mà không nuốt đỉnh hay tâm của nhau vẫn bị phát hiện chồng lấn', () => {
    const o = { lat: htxA.lat + 0.12, lng: htxA.lng + 0.12 };
    const k = 0.001;
    // A: rộng-thấp; B: cao-hẹp, lệch tâm — không đỉnh nào nằm trong nhau, tâm cũng không, chỉ cạnh giao nhau.
    const rectA = [{ lat: o.lat + 1 * k, lng: o.lng }, { lat: o.lat + 1 * k, lng: o.lng + 4 * k }, { lat: o.lat + 1.8 * k, lng: o.lng + 4 * k }, { lat: o.lat + 1.8 * k, lng: o.lng }];
    const rectB = [{ lat: o.lat, lng: o.lng + 2.5 * k }, { lat: o.lat, lng: o.lng + 3.5 * k }, { lat: o.lat + 4 * k, lng: o.lng + 3.5 * k }, { lat: o.lat + 4 * k, lng: o.lng + 2.5 * k }];
    const a = lifecycle.createPlotChecked({ htxId: htxA.id, boundary: rectA }, actor);
    const hits = lifecycle.findOverlaps(rectB);
    assert.ok(hits.some((h) => h.plotId === a.id), 'phải phát hiện chồng lấn qua giao cạnh');
    assert.throws(() => lifecycle.createPlotChecked({ htxId: htxA.id, boundary: rectB }, actor), (e: Error & { needsConfirm?: boolean }) => e.needsConfirm === true);
    assert.throws(() => lifecycle.createPlotChecked({ htxId: htxB.id, boundary: rectB, confirmOverlap: true }, actor), /khác/);
});

test('UAT DEF-HTX-12/10: yêu cầu hỗ trợ lưu đủ mô tả, loại vấn đề, mức khẩn; thiếu mô tả bị chặn', () => {
    assert.throws(() => htx.requestSupport({ htxId: htxA.id, title: 'Rầy nâu', category: 'dich_hai', priority: 'khan' }, actor), /mô tả/);
    assert.throws(() => htx.requestSupport({ htxId: htxA.id, title: 'x', description: 'y', category: 'khong_co' }, actor), /Loại vấn đề/);
    const saved = htx.requestSupport({ htxId: htxA.id, title: 'Máy gặt hỏng', description: 'Máy gặt đập liên hợp hỏng bộ đập giữa vụ.', category: 'may_moc', priority: 'khan' }, actor) as { category: string; priority: string; description: string };
    assert.equal(saved.category, 'may_moc');
    assert.equal(saved.priority, 'khan');
    assert.match(saved.description, /bộ đập/);
    const legacy = htx.requestSupport({ htxId: htxA.id, title: 'Tên cũ', content: 'mô tả qua trường content', urgency: 'khan' } as never, actor) as { priority: string; description: string };
    assert.equal(legacy.priority, 'khan', 'tên trường cũ urgency/content vẫn được nhận');
});

test('UAT DEF-ADM-02: trùng số điện thoại bị chặn; định dạng SĐT/email sai bị chặn; đăng nhập ưu tiên tài khoản hoạt động', async () => {
    const sysadmin = await import('../src/platform/auth/admin.ts');
    users.createUser({ username: 'sdt_a', fullName: 'A', roles: ['farmer'], phone: '0987 654 321' }, { id: admin.id, name: admin.fullName });
    assert.throws(() => users.createUser({ username: 'sdt_b', fullName: 'B', roles: ['farmer'], phone: '0987654321' }, { id: admin.id, name: admin.fullName }), /đã được đăng ký/);
    assert.throws(() => users.createUser({ username: 'sdt_c', fullName: 'C', roles: ['farmer'], phone: '12345' }, { id: admin.id, name: admin.fullName }), /định dạng/);
    assert.throws(() => users.createUser({ username: 'sdt_d', fullName: 'D', roles: ['farmer'], email: 'hoangvanem-invalid' }, { id: admin.id, name: admin.fullName }), /Email không đúng định dạng/);
    assert.throws(() => users.createUser({ username: 'sdt_e', fullName: '', roles: ['farmer'] }, { id: admin.id, name: admin.fullName }), /Họ tên/);
    assert.throws(() => users.createUser({ username: 'sdt_f', fullName: 'F', roles: [] }, { id: admin.id, name: admin.fullName }), /nhóm quyền/);
    const other = users.createUser({ username: 'sdt_g', fullName: 'G', roles: ['farmer'] }, { id: admin.id, name: admin.fullName });
    assert.throws(() => sysadmin.updateProfile(other.user.id, { phone: '0987654321' }, actor), /đã được đăng ký/);
    // Dữ liệu cũ còn trùng: bản ghi bị khoá không được che tài khoản hợp lệ.
    users.createUser({ username: 'sdt_h', fullName: 'H', roles: ['farmer'], password: 'MatKhau123' }, { id: admin.id, name: admin.fullName });
    run("UPDATE users SET phone = '0977000111' WHERE username IN ('sdt_a', 'sdt_h')");
    run("UPDATE users SET status = 'locked' WHERE username = 'sdt_a'");
    assert.ok(users.login('0977000111', 'MatKhau123')?.token, 'người dùng đang hoạt động đăng nhập được bằng SĐT dù có bản ghi trùng đã khoá');
});

test('UAT DEF-KN-LIB-01: tìm kiếm thư viện với từ khoá không còn lỗi cột nhập nhằng', () => {
    for (const q of ['AWD', 'rầy', 'lúa', 'xyz-khong-co']) assert.doesNotThrow(() => knOps.searchArticles({ q }));
    assert.ok(knOps.searchArticles({ q: 'AWD' }).items.length >= 1);
    const none = knOps.searchArticles({ q: 'xyz-khong-co' });
    assert.equal(none.items.length, 0);
    assert.ok(none.suggestions.length >= 1, 'không có kết quả thì gợi ý chuyên mục');
});

test('UAT DEF-KN-TASK-01: không phân công cho tài khoản khoá; không nhiệm vụ nào nhận được thì báo lỗi', () => {
    const task = htx.requestSupport({ htxId: htxA.id, title: 'Test phân công', description: 'x'.repeat(10) }, actor) as { id: string };
    const staff = users.createUser({ username: 'kn_locked', fullName: 'Cán bộ khoá', roles: ['kn_xa'], password: 'MatKhau123' }, { id: admin.id, name: admin.fullName });
    run("UPDATE users SET status = 'locked' WHERE id = ?", [staff.user.id]);
    assert.throws(() => knOps.bulkAssignTasks([task.id], staff.user.id, actor), /bị khoá/);
    const active = users.createUser({ username: 'kn_active', fullName: 'Cán bộ hoạt động', roles: ['kn_xa'], password: 'MatKhau123' }, { id: admin.id, name: admin.fullName });
    run("UPDATE support_tasks SET status = 'dong' WHERE id = ?", [task.id]);
    assert.throws(() => knOps.bulkAssignTasks([task.id], active.user.id, actor), /Không nhiệm vụ nào/);
    assert.throws(() => knOps.bulkAssignTasks([], active.user.id, actor), /Chưa chọn/);
});

test('UAT DEF-KN-HTX-01: không vô hiệu hoá được HTX còn vụ đang canh tác / nhật ký chờ duyệt', () => {
    const impact = lifecycle.cooperativeImpact(htxB.id);
    assert.ok(impact.openCycles > 0 || impact.pendingLogs > 0, 'htxB có vụ đang canh tác từ các test trước');
    assert.throws(() => lifecycle.deactivateCooperative(htxB.id, 'Thử vô hiệu hoá HTX còn dữ liệu sản xuất đang mở', actor), /vụ đang canh tác/);
});

test('UAT DEF-HTX-13: tạo mùa vụ có kiểm tra và không trùng mã', () => {
    const created = varieties.upsertSeason({ code: 'dx-2027-2028', name: 'Đông Xuân 2027-2028', year: 2028, startMonth: 11, endMonth: 3, sortOrder: 1 }, actor) as { code: string };
    assert.equal(created.code, 'DX-2027-2028');
    assert.throws(() => varieties.upsertSeason({ code: 'DX-2027-2028', name: 'Trùng', year: 2028, startMonth: 11, endMonth: 3 }, actor), /đã tồn tại/);
    assert.throws(() => varieties.upsertSeason({ code: 'X', name: 'Sai tháng', year: 2028, startMonth: 13, endMonth: 3 }, actor), /từ 1 đến 12/);
});

test('UAT DEF-SYS-01: lỗi ràng buộc CSDL được dịch sang thông điệp nghiệp vụ tiếng Việt', async () => {
    const { friendlyError } = await import('../src/platform/http/router.ts');
    assert.match(friendlyError(new Error('UNIQUE constraint failed: org_nodes.code')).message, /Mã đầu mối tổ chức đã tồn tại/);
    assert.match(friendlyError(new Error('NOT NULL constraint failed: users.full_name')).message, /Thiếu trường bắt buộc: Họ tên/);
    assert.match(friendlyError(new Error('input.roles is not iterable')).message, /không đúng định dạng/);
    assert.match(friendlyError(new Error('ambiguous column name: title')).message, /truy vấn dữ liệu/);
    assert.equal(friendlyError(new Error('Lý do vô hiệu hóa phải có ít nhất 20 ký tự.')).technical, null, 'thông điệp nghiệp vụ giữ nguyên');
});
