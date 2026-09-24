/**
 * Kiểm thử QUẢN LÝ HIỆN TRƯỜNG — đội thu gom rơm của Mekong Green.
 *
 * Trọng tâm là các chốt chặn FM-01..FM-08 và ba mối nối liên phân hệ: App HTX
 * (khai báo sản lượng → việc thu gom), CGH (máy), TMS (xuống ghe → chuyến).
 * Số liệu hiện trường là đầu vào của báo cáo năng suất và của kho — sai ở đây
 * là sai dây chuyền, nên phần lớn test kiểm tra cái hệ thống TỪ CHỐI.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, insert, one } from '../src/platform/db/db.ts';
import { nowIso, uuid } from '../src/platform/util/ids.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-field-')), 'test.db'));

const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const field = await import('../src/erp/field/service.ts');
const htx = await import('../src/agrigreen/htx/service.ts');
const rbac = await import('../src/platform/auth/rbac.ts');

migrate();
seedAll();

const actor = { id: 'test', name: 'Kiểm thử' };
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset: number, hour: number) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00.000Z`;

const anyHtx = one<{ id: string; lat: number; lng: number }>(
  'SELECT id, lat, lng FROM cooperatives WHERE lat IS NOT NULL ORDER BY code LIMIT 1',
)!;

/** Đội mới, sạch, có máy cuộn năng lực biết trước — không dính dữ liệu seed. */
function freshTeam(name: string, capacity = 40) {
  const team = field.createTeam({ name, baseLat: anyHtx.lat, baseLng: anyHtx.lng }, actor);
  const baler = field.createVehicle({ name: `Máy cuộn ${name}`, kind: 'may_cuon', teamId: String(team.id), capacityValue: capacity }, actor);
  return { teamId: String(team.id), balerId: String(baler.id) };
}

function freshJob(harvestOffset: number, tons: number) {
  return String(field.createJob({
    sourceType: 'manual', htxId: anyHtx.id, harvestDate: day(harvestOffset), expectedStrawTons: tons,
  }, actor).id);
}

// ===========================================================================
// Dữ liệu seed và phân quyền
// ===========================================================================

test('Seed có 4 đội, việc ở đủ trạng thái, và đã sinh chuyến TMS từ lượt xuống ghe', () => {
  const teams = field.listTeams();
  assert.equal(teams.length, 4);
  for (const team of teams) assert.ok(Number(team.capacityTonsPerDay) > 0 && team.capacityDeclared === true);
  const statuses = new Set(all<{ status: string }>('SELECT DISTINCT status FROM field_jobs').map((row) => row.status));
  for (const expected of ['cho_phan_cong', 'da_phan_cong', 'dang_thuc_hien', 'hoan_thanh']) assert.ok(statuses.has(expected), expected);
  const trips = all("SELECT id FROM trips WHERE ref_type = 'field_job'");
  const loadings = all('SELECT id FROM field_loadings');
  assert.equal(trips.length, loadings.length, 'mỗi lượt xuống ghe trong seed → đúng một chuyến TMS');
  assert.ok(trips.length >= 4, 'ba việc hoàn thành trong seed có ít nhất bốn lượt ghe');
});

test('Đội trưởng chỉ ghi nhận; quản lý mới phân công; ban lãnh đạo xem được', () => {
  const crew = rbac.permissionsFor([rbac.ROLES.FIELD_CREW]);
  assert.ok(crew.has('field.write') && !crew.has('field.manage'));
  assert.ok(crew.has('portal.field') && !crew.has('portal.erp'), 'đội trưởng không vào ERP');
  const manager = rbac.permissionsFor([rbac.ROLES.FIELD_MANAGER]);
  assert.ok(manager.has('field.manage') && manager.has('tms.write'), 'điều hành tạo được chuyến TMS');
  assert.ok(rbac.permissionsFor([rbac.ROLES.EXECUTIVE]).has('field.read'));
  assert.ok(!rbac.permissionsFor([rbac.ROLES.FARMER]).has('field.read'), 'nông dân không thấy nội bộ đội thu gom');
});

// ===========================================================================
// Đội và phương tiện
// ===========================================================================

test('Máy cuộn phải khai báo năng lực — con số này quyết định kế hoạch', () => {
  assert.throws(() => field.createVehicle({ name: 'Máy cuộn không rõ', kind: 'may_cuon' }, actor), /năng lực/);
  // Máy kéo thì không bắt buộc.
  field.createVehicle({ name: 'Máy kéo phụ', kind: 'may_keo' }, actor);
});

test('Năng lực đội trừ máy hỏng / bảo dưỡng nhưng KHÔNG trừ máy đang chạy ngoài ruộng', () => {
  const { teamId, balerId } = freshTeam('Đội test năng lực', 40);
  const second = field.createVehicle({ name: 'Máy cuộn 2', kind: 'may_cuon', teamId, capacityValue: 30 }, actor);
  assert.equal(field.teamCapacityTonsPerDay(teamId).tons, 70);
  field.updateVehicle(String(second.id), { status: 'hong' }, actor);
  assert.equal(field.teamCapacityTonsPerDay(teamId).tons, 40);
  field.updateVehicle(balerId, { status: 'dang_dung' }, actor);
  assert.equal(field.teamCapacityTonsPerDay(teamId).tons, 40, 'máy đang dùng vẫn là năng lực của đội');
});

test('Đội chưa có máy cuộn dùng năng lực mặc định và bị báo rõ khi phân công', () => {
  const team = field.createTeam({ name: 'Đội chưa có máy' }, actor);
  const capacity = field.teamCapacityTonsPerDay(String(team.id));
  assert.equal(capacity.declared, false);
  const result = field.assignJob(freshJob(1, 20), { teamId: String(team.id) }, actor);
  assert.ok(result.warnings.some((w) => w.includes('chưa khai báo máy cuộn')));
});

// ===========================================================================
// Phân công
// ===========================================================================

test('FM-01: không xếp cuộn rơm trước ngày gặt', () => {
  const { teamId } = freshTeam('Đội FM-01');
  const jobId = freshJob(5, 30);
  assert.throws(() => field.assignJob(jobId, { teamId, plannedDate: day(4) }, actor), /FM-01/);
  const ok = field.assignJob(jobId, { teamId, plannedDate: day(5) }, actor);
  assert.equal(ok.job.status, 'da_phan_cong');
});

test('FM-02: xếp việc quá 3 ngày sau gặt vẫn được nhưng có cảnh báo ẩm mục', () => {
  const { teamId } = freshTeam('Đội FM-02');
  const result = field.assignJob(freshJob(1, 30), { teamId, plannedDate: day(6) }, actor);
  assert.ok(result.warnings.some((w) => w.startsWith('FM-02')));
});

test('FM-06: phân công tay vượt năng lực ngày được phép nhưng phải thấy cảnh báo', () => {
  const { teamId } = freshTeam('Đội FM-06', 40);
  field.assignJob(freshJob(2, 35), { teamId, plannedDate: day(2) }, actor);
  const second = field.assignJob(freshJob(2, 20), { teamId, plannedDate: day(2) }, actor);
  assert.ok(second.warnings.some((w) => w.startsWith('FM-06')), second.warnings.join(' | '));
});

test('FM-07: đội tạm nghỉ không nhận việc', () => {
  const { teamId } = freshTeam('Đội FM-07');
  field.updateTeam(teamId, { status: 'tam_nghi' }, actor);
  assert.throws(() => field.assignJob(freshJob(1, 10), { teamId }, actor), /FM-07/);
});

test('Không đổi đội cho việc đang thực hiện — số liệu năng suất sẽ lệch', () => {
  const { teamId, balerId } = freshTeam('Đội đang làm');
  const other = freshTeam('Đội khác');
  const jobId = freshJob(0, 20);
  field.assignJob(jobId, { teamId }, actor);
  field.startStage(jobId, 'cuon_rom', { vehicleId: balerId }, actor);
  assert.throws(() => field.assignJob(jobId, { teamId: other.teamId }, actor), /đang thực hiện/);
});

test('Kế hoạch công đoạn suy từ khối lượng ÷ năng lực: 90 tấn với 40 tấn/ngày = 3 ngày cuộn', () => {
  const { teamId } = freshTeam('Đội kế hoạch', 40);
  const jobId = freshJob(3, 90);
  const { job } = field.assignJob(jobId, { teamId, plannedDate: day(3) }, actor);
  const baling = (job.stages as Record<string, unknown>[]).find((s) => s.stage === 'cuon_rom')!;
  assert.equal(baling.planned_start, day(3));
  assert.equal(baling.planned_end, day(5));
  const loading = (job.stages as Record<string, unknown>[]).find((s) => s.stage === 'xuong_ghe')!;
  assert.equal(loading.planned_start, day(4), 'xuống ghe bắt đầu từ ngày thứ hai, khi đã có kiện gom ra bờ');
});

test('FM-08: đồng bộ lịch gặt chạy lại không sinh việc trùng', () => {
  const before = all('SELECT id FROM field_jobs').length;
  const first = field.syncHarvestCalendar(day(0), 14, actor);
  const second = field.syncHarvestCalendar(day(0), 14, actor);
  assert.equal(first.created, 0, 'seed đã đồng bộ rồi');
  assert.equal(second.created, 0);
  assert.equal(all('SELECT id FROM field_jobs').length, before);
});

test('Phân công tự động: việc vừa năng lực → đội gần nhất; việc quá lớn → ÉP XẾP có cờ, không để trống', () => {
  // Đội duy nhất còn rảnh gần ruộng test, năng lực nhỏ để một việc lớn không vừa.
  const { teamId } = freshTeam('Đội tự động', 20);
  const small = freshJob(7, 15);
  const huge = freshJob(7, 500);
  const result = field.autoAssign({ fromDate: day(6), days: 3, syncCalendar: false }, actor);
  const smallRow = result.assigned.find((row) => row.jobId === small);
  const hugeRow = result.forced.find((row) => row.jobId === huge);
  assert.ok(smallRow, 'việc nhỏ được xếp bình thường');
  assert.ok(hugeRow, 'việc lớn nằm ở nhóm ép xếp');
  assert.ok(String(hugeRow!.reason).includes('Không đội nào còn năng lực'));
  assert.equal(result.unassigned.length, 0);
  assert.equal(one<{ status: string }>('SELECT status FROM field_jobs WHERE id = ?', [huge])!.status, 'da_phan_cong');
  void teamId;
});

test('Phân công tự động với force=false để việc quá lớn ở danh sách chưa xếp kèm lý do', () => {
  const huge = freshJob(9, 900);
  const result = field.autoAssign({ fromDate: day(9), days: 1, syncCalendar: false, force: false }, actor);
  const row = result.unassigned.find((item) => item.jobId === huge);
  assert.ok(row && String(row.reason).includes('3 ngày sau gặt'));
});

// ===========================================================================
// Ghi nhận hiện trường
// ===========================================================================

test('FM-03: thứ tự công đoạn — gom được bắt đầu khi cuộn đã bắt đầu, nhưng chỉ chốt khi cuộn đã xong', () => {
  const { teamId, balerId } = freshTeam('Đội FM-03');
  const jobId = freshJob(0, 30);
  field.assignJob(jobId, { teamId }, actor);
  assert.throws(() => field.startStage(jobId, 'gom_rom', {}, actor), /FM-03/);
  field.startStage(jobId, 'cuon_rom', { vehicleId: balerId }, actor);
  field.startStage(jobId, 'gom_rom', {}, actor); // song song — hợp lệ
  assert.throws(() => field.completeStage(jobId, 'gom_rom', { quantityTons: 10 }, actor), /FM-03/);
  field.completeStage(jobId, 'cuon_rom', { quantityTons: 28 }, actor);
  const done = field.completeStage(jobId, 'gom_rom', { quantityTons: 27 }, actor);
  assert.equal((done.stages as Record<string, unknown>[])[1].status, 'hoan_thanh');
});

test('FM-01 tại hiện trường: không bắt đầu cuộn trước ngày gặt kể cả khi đã phân công', () => {
  const { teamId } = freshTeam('Đội FM-01b');
  const jobId = freshJob(2, 10);
  field.assignJob(jobId, { teamId, plannedDate: day(2) }, actor);
  assert.throws(() => field.startStage(jobId, 'cuon_rom', { at: at(1, 8) }, actor), /FM-01/);
});

test('FM-04: khối lượng không tăng qua công đoạn — gom nhiều hơn cuộn bị từ chối', () => {
  const { teamId, balerId } = freshTeam('Đội FM-04');
  const jobId = freshJob(0, 30);
  field.assignJob(jobId, { teamId }, actor);
  field.startStage(jobId, 'cuon_rom', { vehicleId: balerId }, actor);
  field.completeStage(jobId, 'cuon_rom', { quantityTons: 25 }, actor);
  assert.throws(() => field.completeStage(jobId, 'gom_rom', { quantityTons: 26 }, actor), /FM-04/);
  field.completeStage(jobId, 'gom_rom', { quantityTons: 25 }, actor);
  field.recordLoading(jobId, { vesselCode: 'TEST-1', tons: 20 }, actor);
  assert.throws(() => field.recordLoading(jobId, { vesselCode: 'TEST-2', tons: 6 }, actor), /FM-04/);
});

test('Phương tiện hỏng hoặc của đội khác không đưa vào việc', () => {
  const a = freshTeam('Đội A');
  const b = freshTeam('Đội B');
  const jobId = freshJob(0, 10);
  field.assignJob(jobId, { teamId: a.teamId }, actor);
  assert.throws(() => field.startStage(jobId, 'cuon_rom', { vehicleId: b.balerId }, actor), /đội khác/);
  field.updateVehicle(a.balerId, { status: 'hong' }, actor);
  assert.throws(() => field.startStage(jobId, 'cuon_rom', { vehicleId: a.balerId }, actor), /hỏng/);
});

test('Máy đang dùng đổi trạng thái "đang dùng", trả về "sẵn sàng" khi chốt công đoạn', () => {
  const { teamId, balerId } = freshTeam('Đội trạng thái máy');
  const jobId = freshJob(0, 10);
  field.assignJob(jobId, { teamId }, actor);
  field.startStage(jobId, 'cuon_rom', { vehicleId: balerId }, actor);
  assert.equal(one<{ status: string }>('SELECT status FROM field_vehicles WHERE id = ?', [balerId])!.status, 'dang_dung');
  field.completeStage(jobId, 'cuon_rom', { quantityTons: 9 }, actor);
  assert.equal(one<{ status: string }>('SELECT status FROM field_vehicles WHERE id = ?', [balerId])!.status, 'san_sang');
});

// ===========================================================================
// Mối nối TMS
// ===========================================================================

test('FM-05: mỗi lượt xuống ghe sinh một chuyến TMS đường thuỷ tham chiếu đúng việc', () => {
  const { teamId, balerId } = freshTeam('Đội TMS');
  const jobId = freshJob(0, 100);
  field.assignJob(jobId, { teamId }, actor);
  field.startStage(jobId, 'cuon_rom', { vehicleId: balerId }, actor);
  field.completeStage(jobId, 'cuon_rom', { quantityTons: 95 }, actor);
  field.completeStage(jobId, 'gom_rom', { quantityTons: 95 }, actor);

  const first = field.recordLoading(jobId, { vesselCode: 'AG-0001', vesselKind: 'ghe', tons: 88, driverName: 'Tài công A' }, actor);
  assert.ok(first.trip, 'có chuyến');
  assert.equal(first.trip!.mode, 'waterway');
  assert.equal(first.trip!.ref_type, 'field_job');
  assert.equal(first.trip!.ref_id, jobId);
  assert.equal(first.trip!.vehicle_code, 'AG-0001');
  assert.equal(first.trip!.planned_tons, 88);
  assert.equal(first.loading.trip_id, first.trip!.id);

  // Lượt ghe không đóng việc; chốt xuống ghe lấy tổng các lượt, không nhập tay.
  assert.equal(one<{ status: string }>('SELECT status FROM field_jobs WHERE id = ?', [jobId])!.status, 'dang_thuc_hien');
  field.recordLoading(jobId, { vesselCode: 'AG-0002', tons: 7 }, actor);
  const closed = field.completeStage(jobId, 'xuong_ghe', { quantityTons: 999 }, actor);
  assert.equal(closed.status, 'hoan_thanh');
  const loading = (closed.stages as Record<string, unknown>[]).find((s) => s.stage === 'xuong_ghe')!;
  assert.equal(loading.quantity_tons, 95, 'tổng hai lượt, bỏ qua số 999 nhập tay');
});

test('Lượt xuống ghe vượt khối lượng rơm thực chở của ghe (tham số #51) bị cảnh báo', () => {
  const { teamId, balerId } = freshTeam('Đội ghe quá tải');
  const jobId = freshJob(0, 300);
  field.assignJob(jobId, { teamId }, actor);
  field.startStage(jobId, 'cuon_rom', { vehicleId: balerId }, actor);
  field.completeStage(jobId, 'cuon_rom', { quantityTons: 300 }, actor);
  field.completeStage(jobId, 'gom_rom', { quantityTons: 300 }, actor);
  const result = field.recordLoading(jobId, { vesselCode: 'AG-0003', vesselKind: 'ghe', tons: 250 }, actor);
  assert.ok(result.warnings.some((w) => w.includes('vượt khối lượng rơm thực chở')));
});

test('Chưa ghi lượt ghe nào thì không chốt được công đoạn xuống ghe', () => {
  const { teamId, balerId } = freshTeam('Đội chưa xuống ghe');
  const jobId = freshJob(0, 10);
  field.assignJob(jobId, { teamId }, actor);
  field.startStage(jobId, 'cuon_rom', { vehicleId: balerId }, actor);
  field.completeStage(jobId, 'cuon_rom', { quantityTons: 10 }, actor);
  field.completeStage(jobId, 'gom_rom', { quantityTons: 10 }, actor);
  assert.throws(() => field.completeStage(jobId, 'xuong_ghe', { quantityTons: 10 }, actor), /Chưa ghi lượt xuống ghe/);
});

// ===========================================================================
// Mối nối App HTX
// ===========================================================================

test('Khai báo sản lượng trên App HTX tự sinh việc thu gom có cờ "rơm đã có thật"', () => {
  const season = one<{ id: string }>('SELECT id FROM seasons ORDER BY sort_order LIMIT 1')!;
  const plotId = uuid();
  insert('plots', {
    id: plotId, code: 'LO-FIELD-01', name: 'Thửa kiểm thử hiện trường', htx_id: anyHtx.id, farmer_id: null,
    boundary: null, area_ha: 3.2, centroid_lat: anyHtx.lat, centroid_lng: anyHtx.lng, soil_type: null,
    status: 'dang_canh_tac', source: 'test', created_at: nowIso(), updated_at: nowIso(),
  });
  const cycleId = uuid();
  insert('crop_cycles', {
    id: cycleId, code: 'VU-FIELD-01', plot_id: plotId, season_id: season.id, variety: 'OM5451',
    sowing_date: day(-95), expected_harvest_date: day(0), area_ha: 3.2, status: 'dang_canh_tac',
    created_by: 'test', created_at: nowIso(),
  });

  htx.declareHarvest({ cropCycleId: cycleId, paddyTons: 20, strawTons: 9.5 }, actor);

  const job = one<{ status: string; harvest_confirmed: number; expected_straw_tons: number; source_type: string; plot_id: string }>(
    'SELECT * FROM field_jobs WHERE crop_cycle_id = ?', [cycleId]);
  assert.ok(job, 'việc được tạo từ khai báo');
  assert.equal(job!.harvest_confirmed, 1);
  assert.equal(job!.expected_straw_tons, 9.5);
  assert.equal(job!.source_type, 'harvest');
  assert.equal(job!.plot_id, plotId);
});

test('Vụ đã có việc từ lịch gặt dự kiến: khai báo sản lượng CẬP NHẬT chứ không tạo việc thứ hai', () => {
  const season = one<{ id: string }>('SELECT id FROM seasons ORDER BY sort_order LIMIT 1')!;
  const plotId = uuid();
  insert('plots', {
    id: plotId, code: 'LO-FIELD-02', name: null, htx_id: anyHtx.id, farmer_id: null, boundary: null, area_ha: 5,
    centroid_lat: anyHtx.lat, centroid_lng: anyHtx.lng, soil_type: null, status: 'dang_canh_tac', source: 'test',
    created_at: nowIso(), updated_at: nowIso(),
  });
  const cycleId = uuid();
  insert('crop_cycles', {
    id: cycleId, code: 'VU-FIELD-02', plot_id: plotId, season_id: season.id, variety: null,
    sowing_date: day(-90), expected_harvest_date: day(2), area_ha: 5, status: 'dang_canh_tac', created_by: 'test', created_at: nowIso(),
  });
  const synced = field.syncHarvestCalendar(day(0), 14, actor);
  assert.ok(synced.created >= 1, 'lịch gặt dự kiến sinh việc trước');
  const planned = one<{ id: string; expected_straw_tons: number; harvest_confirmed: number }>(
    'SELECT * FROM field_jobs WHERE crop_cycle_id = ?', [cycleId])!;
  assert.equal(planned.harvest_confirmed, 0);
  assert.ok(planned.expected_straw_tons > 0, 'ước từ diện tích');

  htx.declareHarvest({ cropCycleId: cycleId, harvestDate: day(0), paddyTons: 30, strawTons: 14 }, actor);
  const rows = all<{ id: string; expected_straw_tons: number; harvest_confirmed: number; harvest_date: string }>(
    'SELECT * FROM field_jobs WHERE crop_cycle_id = ?', [cycleId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].expected_straw_tons, 14, 'số thật thay số ước');
  assert.equal(rows[0].harvest_confirmed, 1);
  assert.equal(rows[0].harvest_date, day(0), 'ngày gặt thật thay ngày dự kiến');
});

// ===========================================================================
// Bảng điều hành và báo cáo
// ===========================================================================

test('FM-02 trên bảng điều hành: việc quá hạn được gắn cờ với số ngày rơm nằm ruộng', () => {
  const dashboard = field.fieldDashboard();
  const kpis = dashboard.kpis as Record<string, number>;
  assert.ok(kpis.overdueJobs >= 1, 'seed có một việc quá hạn');
  const flagged = (dashboard.overdue as Record<string, unknown>[])[0];
  assert.equal(flagged.overdue, true);
  assert.ok(Number(flagged.daysOnField) > field.MAX_DAYS_AFTER_HARVEST);
  assert.match(String(flagged.riskLabel), /quá ngưỡng/);
});

test('Báo cáo năng suất: tỷ lệ thu hồi và thời gian gặt → xuống ghe tính từ số liệu hiện trường', () => {
  const report = field.productivityReport(day(-7), day(0));
  const team = (report.teams as Record<string, unknown>[]).find((row) => Number(row.jobsCompleted) > 0)!;
  assert.ok(team, 'có đội đã hoàn thành việc trong kỳ');
  assert.ok(Number(team.recoveryPct) > 0 && Number(team.recoveryPct) <= 100);
  assert.ok(Number(team.loadedTons) <= Number(team.gatheredTons), 'FM-04 phản ánh trong báo cáo');
  assert.ok(Number(team.avgLeadHoursHarvestToVessel) > 0);
  const vehicles = report.vehicles as Record<string, unknown>[];
  assert.ok(vehicles.some((v) => Number(v.days_used) > 0), 'máy đã dùng có số ngày sử dụng');
});

test('Lịch gặt 14 ngày trả về tải từng đội theo ngày và không vượt quá số ngày yêu cầu', () => {
  const calendar = field.harvestCalendar(day(0), 14);
  const days = calendar.days as Record<string, unknown>[];
  assert.equal(days.length, 14);
  const withTeams = days[0].teams as Record<string, unknown>[];
  assert.ok(withTeams.length >= 4);
  for (const entry of withTeams) assert.ok('utilisationPct' in entry && 'capacityTons' in entry);
});

test('Huỷ việc phải có lý do; việc đã hoàn thành không huỷ được', () => {
  const jobId = freshJob(3, 10);
  assert.throws(() => field.cancelJob(jobId, '', actor), /lý do/);
  field.cancelJob(jobId, 'HTX bán rơm cho bên khác', actor);
  const done = one<{ id: string }>("SELECT id FROM field_jobs WHERE status = 'hoan_thanh' LIMIT 1")!;
  assert.throws(() => field.cancelJob(done.id, 'thử', actor), /không huỷ được/);
});
