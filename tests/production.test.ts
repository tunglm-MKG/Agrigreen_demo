/**
 * Kiểm thử QUY TRÌNH SẢN XUẤT CHUẨN & KẾ HOẠCH SẢN XUẤT.
 *
 * Giá trị của tính năng này nằm ở các chốt chặn: một kế hoạch mà bước nào cũng
 * xác nhận được vô điều kiện thì chẳng khác gì nhật ký tự do như trước. Các test
 * dưới đây bảo vệ đúng những chốt đó.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDatabase, one, update } from '../src/platform/db/db.ts';

// Mỗi lần chạy test dùng một CSDL tạm riêng biệt.
configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-prod-')), 'test.db'));

const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const production = await import('../src/agrigreen/htx/production.ts');
const htx = await import('../src/agrigreen/htx/service.ts');
const mdm = await import('../src/mdm/service.ts');

migrate();
seedAll();

const actor = { name: 'test' };

// ---------------------------------------------------------------------------
// Dữ liệu nền: dùng luôn HTX và mùa vụ từ bộ seed
// ---------------------------------------------------------------------------

const htxRow = one<{ id: string }>('SELECT id FROM cooperatives WHERE lat IS NOT NULL LIMIT 1')!;
const season = one<{ id: string }>('SELECT id FROM seasons ORDER BY sort_order LIMIT 1')!;
const htxPoint = one<{ lat: number; lng: number }>(
  'SELECT lat, lng FROM cooperatives WHERE id = ?', [htxRow.id],
)!;

function newPlot(): string {
  const plot = mdm.createPlot({
    htxId: htxRow.id,
    boundary: [
      { lat: htxPoint.lat, lng: htxPoint.lng },
      { lat: htxPoint.lat + 0.01, lng: htxPoint.lng },
      { lat: htxPoint.lat + 0.01, lng: htxPoint.lng + 0.01 },
      { lat: htxPoint.lat, lng: htxPoint.lng + 0.01 },
    ],
  }, actor) as { id: string };
  return plot.id;
}

function newCycle(sowingDate: string | null): { id: string; code: string } {
  return htx.openCropCycle(
    { plotId: newPlot(), seasonId: season.id, sowingDate: sowingDate ?? undefined },
    actor,
  ) as { id: string; code: string };
}

/** Quy trình 4 bước đủ để thử mọi chốt chặn. */
function buildProtocol(name = 'Quy trình test'): string {
  const protocol = production.createProtocol(
    { name, standard: 'vietgap', scope: 'he_thong' },
    actor,
  ) as { id: string };
  production.addProtocolStep(protocol.id, {
    name: 'Làm đất', activity: 'lam_dat', offsetDays: -10, windowDays: 3,
  }, actor);
  production.addProtocolStep(protocol.id, {
    name: 'Gieo sạ', activity: 'gieo_sa', offsetDays: 0, windowDays: 2,
    evidenceKinds: ['anh_hien_truong', 'hoa_don_vat_tu'],
  }, actor);
  production.addProtocolStep(protocol.id, {
    name: 'Phun thuốc', activity: 'phun_thuoc', offsetDays: 30, windowDays: 5, phiDays: 21,
  }, actor);
  production.addProtocolStep(protocol.id, {
    name: 'Rút nước tuỳ chọn', activity: 'rut_nuoc_awd', offsetDays: 80, windowDays: 5,
    mandatory: false,
  }, actor);
  production.addProtocolStep(protocol.id, {
    name: 'Thu hoạch', activity: 'thu_hoach', offsetDays: 100, windowDays: 7,
  }, actor);
  return protocol.id;
}

// ---------------------------------------------------------------------------
// Quy trình chuẩn
// ---------------------------------------------------------------------------

test('Quy trình phải có bước thu hoạch mới ban hành được', () => {
  const protocol = production.createProtocol({ name: 'Thiếu thu hoạch' }, actor) as { id: string };
  assert.throws(() => production.publishProtocol(protocol.id, actor), /chưa có bước nào/);

  production.addProtocolStep(protocol.id, { name: 'Làm đất', activity: 'lam_dat', offsetDays: -5 }, actor);
  assert.throws(() => production.publishProtocol(protocol.id, actor), /bước thu hoạch/);

  production.addProtocolStep(protocol.id, { name: 'Thu hoạch', activity: 'thu_hoach', offsetDays: 95 }, actor);
  const published = production.publishProtocol(protocol.id, actor);
  assert.equal(published.status, 'ban_hanh');
});

test('BR-07 — quy trình đã ban hành không sửa trực tiếp; phải tạo phiên bản mới', () => {
  const id = buildProtocol('Quy trình khoá');
  production.publishProtocol(id, actor);

  assert.throws(
    () => production.addProtocolStep(id, { name: 'Bước thêm', activity: 'tuoi', offsetDays: 40 }, actor),
    /tạo phiên bản mới/,
  );

  const clone = production.cloneProtocol(id, { name: 'Quy trình khoá — bản 2' }, actor);
  assert.equal(clone.status, 'nhap');
  assert.equal(Number(clone.version), 2, 'phiên bản mới phải tăng lên 2');
  assert.equal(
    production.listProtocolSteps(clone.id as string).length,
    production.listProtocolSteps(id).length,
    'phiên bản mới phải sao chép đủ các bước',
  );
  // Bản nháp thì sửa được.
  production.addProtocolStep(clone.id as string, { name: 'Bước thêm', activity: 'tuoi', offsetDays: 40 }, actor);
});

// ---------------------------------------------------------------------------
// Sinh kế hoạch
// ---------------------------------------------------------------------------

test('BR-01 — vụ chưa có ngày xuống giống thì KHÔNG sinh được kế hoạch', () => {
  const protocolId = buildProtocol('QT cho BR-01');
  production.publishProtocol(protocolId, actor);
  const cycle = newCycle(null);
  // openCropCycle lấy ngày hôm nay làm mặc định, nhưng vụ đến từ nhập Excel hay
  // đồng bộ offline có thể thiếu ngày xuống giống — đó mới là ca cần chặn.
  update('crop_cycles', cycle.id, { sowing_date: null });

  assert.throws(
    () => production.generatePlan({ cropCycleId: cycle.id, protocolId }, actor),
    /chưa có ngày xuống giống/,
  );

  // Chỉ định ngày neo thủ công thì được.
  const plan = production.generatePlan(
    { cropCycleId: cycle.id, protocolId, anchorDate: '2026-01-10' }, actor,
  );
  assert.equal(plan.anchor_date, '2026-01-10');
});

test('BR-02 — chỉ quy trình ĐÃ BAN HÀNH mới áp dụng được vào vụ', () => {
  const protocolId = buildProtocol('QT chưa ban hành');
  const cycle = newCycle('2026-01-10');
  assert.throws(
    () => production.generatePlan({ cropCycleId: cycle.id, protocolId }, actor),
    /chưa được ban hành/,
  );
});

test('Kế hoạch bung đúng lịch theo ngày xuống giống', () => {
  const protocolId = buildProtocol('QT lịch');
  production.publishProtocol(protocolId, actor);
  const cycle = newCycle('2026-01-10');
  const plan = production.generatePlan({ cropCycleId: cycle.id, protocolId }, actor);
  const steps = production.listPlanSteps(plan.id as string);

  assert.equal(steps.length, 5);
  // offset -10 so với 10/01/2026 → 31/12/2025
  assert.equal(steps[0].planned_date, '2025-12-31');
  assert.equal(steps[1].planned_date, '2026-01-10', 'offset 0 = chính ngày xuống giống');
  assert.equal(steps[2].planned_date, '2026-02-09', 'offset +30');
  assert.equal(steps[4].planned_date, '2026-04-20', 'offset +100');
});

test('BR-03 — kế hoạch ghim phiên bản quy trình tại thời điểm sinh', () => {
  const protocolId = buildProtocol('QT ghim phiên bản');
  production.publishProtocol(protocolId, actor);
  const cycle = newCycle('2026-01-10');
  const plan = production.generatePlan({ cropCycleId: cycle.id, protocolId }, actor);
  assert.equal(Number(plan.protocol_version), 1);

  // Tạo phiên bản 2 và thêm bước — kế hoạch cũ không được đổi.
  const clone = production.cloneProtocol(protocolId, {}, actor);
  production.addProtocolStep(clone.id as string, { name: 'Bước mới', activity: 'tuoi', offsetDays: 45 }, actor);
  assert.equal(production.listPlanSteps(plan.id as string).length, 5, 'kế hoạch đã phát hành không được thay đổi');
});

test('Mỗi vụ chỉ có một kế hoạch đang hiệu lực', () => {
  const protocolId = buildProtocol('QT trùng');
  production.publishProtocol(protocolId, actor);
  const cycle = newCycle('2026-01-10');
  production.generatePlan({ cropCycleId: cycle.id, protocolId }, actor);
  assert.throws(
    () => production.generatePlan({ cropCycleId: cycle.id, protocolId }, actor),
    /đã có kế hoạch sản xuất/,
  );
});

// ---------------------------------------------------------------------------
// Xác nhận bước
// ---------------------------------------------------------------------------

function planWithSteps(sowing = '2026-01-10') {
  const protocolId = buildProtocol(`QT ${Math.random().toString(36).slice(2, 8)}`);
  production.publishProtocol(protocolId, actor);
  const cycle = newCycle(sowing);
  const plan = production.generatePlan({ cropCycleId: cycle.id, protocolId }, actor);
  return { cycle, plan, steps: production.listPlanSteps(plan.id as string) };
}

test('BR-04 — bước yêu cầu bằng chứng phải có ĐỦ loại bằng chứng mới xác nhận được', () => {
  const { steps } = planWithSteps();
  const sowingStep = steps.find((s) => s.activity === 'gieo_sa')!;

  assert.throws(
    () => production.confirmPlanStep(sowingStep.id as string, { actualDate: '2026-01-10' }, actor),
    /bắt buộc có bằng chứng/,
  );

  // Chỉ một trong hai loại cũng chưa đủ.
  assert.throws(
    () => production.confirmPlanStep(sowingStep.id as string, {
      actualDate: '2026-01-10', evidence: [{ kind: 'anh_hien_truong' }],
    }, actor),
    /Hoá đơn/,
  );

  const confirmed = production.confirmPlanStep(sowingStep.id as string, {
    actualDate: '2026-01-10',
    evidence: [{ kind: 'anh_hien_truong' }, { kind: 'hoa_don_vat_tu' }],
  }, actor);
  assert.equal(confirmed.status, 'da_thuc_hien');
  assert.equal(confirmed.onTime, true);
  assert.equal(production.listEvidence(sowingStep.id as string).length, 2);
});

test('BR-05 — lệch quá cửa sổ cho phép phải ghi lý do điều chỉnh', () => {
  const { steps } = planWithSteps();
  const step = steps.find((s) => s.activity === 'lam_dat')!; // cửa sổ ±3 ngày

  // Lệch 2 ngày — trong cửa sổ, không cần lý do.
  const inWindow = production.confirmPlanStep(step.id as string, { actualDate: '2026-01-02' }, actor);
  assert.equal(inWindow.onTime, true);
  assert.equal(inWindow.deviationDays, 2);

  // Bước khác, lệch 10 ngày — phải có lý do.
  const { steps: steps2 } = planWithSteps();
  const step2 = steps2.find((s) => s.activity === 'lam_dat')!;
  assert.throws(
    () => production.confirmPlanStep(step2.id as string, { actualDate: '2026-01-10' }, actor),
    /phải ghi lý do điều chỉnh/,
  );

  const late = production.confirmPlanStep(step2.id as string, {
    actualDate: '2026-01-10', deviationReason: 'Mưa lớn kéo dài, không vào ruộng được',
  }, actor);
  assert.equal(late.onTime, false, 'lệch quá cửa sổ vẫn ghi nhận là KHÔNG đúng hạn dù đã có lý do');
  assert.equal(late.deviation_reason, 'Mưa lớn kéo dài, không vào ruộng được');
});

test('BR-06 — thời gian cách ly sau phun thuốc CHẶN thu hoạch sớm', () => {
  const { plan, steps } = planWithSteps();
  const spray = steps.find((s) => s.activity === 'phun_thuoc')!; // PHI = 21 ngày
  production.confirmPlanStep(spray.id as string, { actualDate: '2026-02-09' }, actor);

  // Sớm nhất được thu hoạch: 09/02 + 21 = 02/03/2026.
  assert.equal(production.checkPreHarvestInterval(plan.id as string, '2026-03-01') !== null, true);
  assert.equal(production.checkPreHarvestInterval(plan.id as string, '2026-03-02'), null);

  const harvest = steps.find((s) => s.activity === 'thu_hoach')!;
  assert.throws(
    () => production.confirmPlanStep(harvest.id as string, {
      actualDate: '2026-02-25',
      deviationReason: 'Thương lái yêu cầu thu sớm',
      evidence: [{ kind: 'anh_hien_truong' }],
    }, actor),
    /Vi phạm thời gian cách ly/,
  );
});

test('Bước BẮT BUỘC không được bỏ qua; bước tuỳ chọn bỏ được nhưng phải có lý do', () => {
  const { steps } = planWithSteps();
  const mandatory = steps.find((s) => s.activity === 'lam_dat')!;
  const optional = steps.find((s) => s.mandatory === 0 || s.mandatory === false)!;

  assert.throws(() => production.skipPlanStep(mandatory.id as string, 'không làm', actor), /là bắt buộc/);
  assert.throws(() => production.skipPlanStep(optional.id as string, '', actor), /phải có lý do/);

  const skipped = production.skipPlanStep(optional.id as string, 'Ruộng trũng, không rút nước được', actor);
  assert.equal(skipped.status, 'bo_qua');
});

test('Xác nhận bước tạo nhật ký sản xuất gắn với bước kế hoạch', () => {
  const { cycle, steps } = planWithSteps();
  const step = steps.find((s) => s.activity === 'lam_dat')!;
  const confirmed = production.confirmPlanStep(step.id as string, {
    actualDate: '2026-01-01', detail: 'Cày 2 lượt', inputName: 'Dầu DO', inputQty: 30, inputUom: 'lít',
  }, actor);

  const logs = htx.listFarmLogs(cycle.id);
  assert.equal(logs.length, 1, 'phải sinh đúng một bản ghi nhật ký');
  assert.equal(logs[0].plan_step_id, step.id, 'nhật ký phải trỏ về bước kế hoạch');
  assert.equal(logs[0].id, confirmed.farmLogId);
  assert.equal(logs[0].activity, 'lam_dat');
  assert.equal(logs[0].input_name, 'Dầu DO');
});

test('Không xác nhận lại một bước đã thực hiện', () => {
  const { steps } = planWithSteps();
  const step = steps.find((s) => s.activity === 'lam_dat')!;
  production.confirmPlanStep(step.id as string, { actualDate: '2026-01-01' }, actor);
  assert.throws(
    () => production.confirmPlanStep(step.id as string, { actualDate: '2026-01-02' }, actor),
    /đã được xác nhận/,
  );
});

// ---------------------------------------------------------------------------
// Tiến độ, tuân thủ và liên kết với khai báo sản lượng
// ---------------------------------------------------------------------------

test('Tỷ lệ tuân thủ tính trên bước BẮT BUỘC làm ĐÚNG HẠN', () => {
  const { plan, steps } = planWithSteps();
  const mandatoryCount = steps.filter((s) => s.mandatory).length;
  assert.equal(mandatoryCount, 4);

  // Bước 1 đúng hạn.
  production.confirmPlanStep(steps[0].id as string, { actualDate: '2025-12-31' }, actor);
  let progress = production.planProgress(plan.id as string);
  assert.equal(progress.compliancePct, 25, '1/4 bước bắt buộc đúng hạn');

  // Bước 2 trễ hạn (có lý do) — làm rồi nhưng không tính là tuân thủ.
  production.confirmPlanStep(steps[1].id as string, {
    actualDate: '2026-02-01', deviationReason: 'Chậm giống',
    evidence: [{ kind: 'anh_hien_truong' }, { kind: 'hoa_don_vat_tu' }],
  }, actor);
  progress = production.planProgress(plan.id as string);
  assert.equal(progress.doneSteps, 2);
  assert.equal(progress.compliancePct, 25, 'làm đúng việc nhưng trễ hạn không được tính là tuân thủ');
});

test('Không khai báo sản lượng khi kế hoạch còn nhiều bước bắt buộc dở dang', () => {
  const { cycle, steps } = planWithSteps();
  production.confirmPlanStep(steps[0].id as string, { actualDate: '2025-12-31' }, actor);

  assert.throws(
    () => htx.declareHarvest({ cropCycleId: cycle.id, paddyTons: 10, harvestDate: '2026-04-20' }, actor),
    /bước bắt buộc chưa xác nhận/,
  );
});

test('Vụ KHÔNG có kế hoạch vẫn khai báo sản lượng được như trước', () => {
  const cycle = newCycle('2026-01-10');
  const declared = htx.declareHarvest(
    { cropCycleId: cycle.id, paddyTons: 12, strawTons: 10, harvestDate: '2026-04-20' }, actor,
  );
  assert.equal(Number(declared.paddy_tons), 12);
});

test('Không huỷ kế hoạch đã có bước được xác nhận kèm bằng chứng', () => {
  const { plan, steps } = planWithSteps();
  // Chưa xác nhận gì thì huỷ được.
  const { plan: plan2 } = planWithSteps();
  production.cancelPlan(plan2.id as string, actor);

  production.confirmPlanStep(steps[0].id as string, { actualDate: '2025-12-31' }, actor);
  assert.throws(() => production.cancelPlan(plan.id as string, actor), /không huỷ được/);
});

test('Hồ sơ truy xuất trả về quy trình áp dụng, từng bước và số bằng chứng', () => {
  const { cycle, steps } = planWithSteps();
  production.confirmPlanStep(steps[1].id as string, {
    actualDate: '2026-01-10',
    evidence: [{ kind: 'anh_hien_truong' }, { kind: 'hoa_don_vat_tu' }],
  }, actor);

  const record = production.traceabilityRecord(cycle.id)!;
  assert.ok(record.plan, 'phải có kế hoạch');
  const traced = (record.steps as Record<string, unknown>[]).find((s) => s.activity === 'gieo_sa')!;
  assert.equal(traced.evidenceCount, 2);
  assert.equal(traced.status, 'da_thuc_hien');

  // Vụ không có kế hoạch thì không có hồ sơ truy xuất — trả null, không dựng số liệu giả.
  const bare = newCycle('2026-01-10');
  assert.equal(production.traceabilityRecord(bare.id), null);
});

test('Bước quá hạn được nhận diện theo ngày dự kiến + cửa sổ', () => {
  // Neo vào quá khứ để mọi bước đều đã qua hạn.
  const protocolId = buildProtocol('QT quá hạn');
  production.publishProtocol(protocolId, actor);
  const cycle = newCycle('2020-01-10');
  const plan = production.generatePlan({ cropCycleId: cycle.id, protocolId }, actor);
  const steps = production.listPlanSteps(plan.id as string);

  assert.ok(steps.every((s) => s.overdue), 'mọi bước của vụ năm 2020 phải là quá hạn');
  assert.equal(production.planProgress(plan.id as string).overdueSteps, steps.length);

});

// ---------------------------------------------------------------------------
// BR-08 — Rút quy trình mới từ một vụ đã hoàn thành
// ---------------------------------------------------------------------------

/** Chạy trọn một vụ có kế hoạch: xác nhận đủ bước bắt buộc rồi khai báo sản lượng. */
function shiftDate(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function completedCycleWithPlan(sowing = '2026-01-10') {
  const { cycle, plan, steps } = planWithSteps(sowing);
  const evidence = [{ kind: 'anh_hien_truong' }, { kind: 'hoa_don_vat_tu' }];
  // Mốc thực tế tính từ chính ngày dự kiến của kế hoạch, nên helper dùng được
  // với bất kỳ ngày xuống giống nào.
  const at = (step: Record<string, unknown>, shift: number) => shiftDate(String(step.planned_date), shift);

  production.confirmPlanStep(steps[0].id as string, { actualDate: at(steps[0], -2) }, actor);  // làm đất sớm 2 ngày
  production.confirmPlanStep(steps[1].id as string, { actualDate: at(steps[1], 0), evidence }, actor); // gieo sạ đúng lịch
  production.confirmPlanStep(steps[2].id as string, { actualDate: at(steps[2], 4) }, actor);  // phun thuốc muộn 4 ngày
  production.skipPlanStep(steps[3].id as string, 'Ruộng trũng', actor);                        // bỏ qua bước tuỳ chọn

  // Thu hoạch muộn 5 ngày — vẫn cách lần phun thuốc hơn 21 ngày cách ly.
  const harvestDate = at(steps[4], 5);
  production.confirmPlanStep(steps[4].id as string, {
    actualDate: harvestDate, deviationReason: 'Chờ thương lái',
    evidence: [{ kind: 'anh_hien_truong' }],
  }, actor);

  htx.declareHarvest({ cropCycleId: cycle.id, paddyTons: 11, strawTons: 9, harvestDate }, actor);
  return { cycle, plan, steps };
}

/** Vụ chỉ có nhật ký ghi rời, không lập kế hoạch. */
function completedCycleWithLogsOnly(sowing = '2026-01-10') {
  const cycle = newCycle(sowing);
  htx.addFarmLog({ cropCycleId: cycle.id, activity: 'lam_dat', logDate: '2025-12-28', detail: 'Cày ải 2 lượt' }, actor);
  htx.addFarmLog({ cropCycleId: cycle.id, activity: 'gieo_sa', logDate: '2026-01-10' }, actor);
  // Hai bản ghi trùng ngày + trùng hoạt động — phải bị gộp thành một bước.
  htx.addFarmLog({ cropCycleId: cycle.id, activity: 'bon_phan', logDate: '2026-01-28', detail: 'Bón thúc đợt 1' }, actor);
  htx.addFarmLog({ cropCycleId: cycle.id, activity: 'bon_phan', logDate: '2026-01-28', detail: 'Bón bổ sung' }, actor);
  htx.addFarmLog({ cropCycleId: cycle.id, activity: 'phun_thuoc', logDate: '2026-02-15' }, actor);
  htx.addFarmLog({ cropCycleId: cycle.id, activity: 'thu_hoach', logDate: '2026-04-22' }, actor);
  htx.declareHarvest({ cropCycleId: cycle.id, paddyTons: 10, harvestDate: '2026-04-22' }, actor);
  return cycle;
}

test('BR-08 — chỉ rút quy trình từ vụ ĐÃ HOÀN THÀNH', () => {
  const { cycle } = planWithSteps();
  assert.throws(() => production.previewProtocolFromCycle(cycle.id), /chưa hoàn thành/);
});

test('BR-08 — vụ không có nhật ký lẫn kế hoạch thì không rút được', () => {
  const cycle = newCycle('2026-01-10');
  htx.declareHarvest({ cropCycleId: cycle.id, paddyTons: 8, harvestDate: '2026-04-20' }, actor);
  assert.throws(() => production.previewProtocolFromCycle(cycle.id), /không có nhật ký/);
});

test('Rút từ vụ CÓ kế hoạch — mốc thời gian tính lại theo thực tế, thuộc tính khác kế thừa', () => {
  const { cycle } = completedCycleWithPlan();
  const preview = production.previewProtocolFromCycle(cycle.id);

  assert.equal(preview.source, 'ke_hoach');
  // Bước bị bỏ qua KHÔNG vào quy trình mới → 5 bước gốc còn 4.
  assert.equal(preview.steps.length, 4);
  assert.ok(preview.warnings.some((w) => w.includes('bỏ qua')), 'phải cảnh báo bước bị bỏ qua');
  // Nguồn là kế hoạch nên mọi thuộc tính đều kế thừa được — không có gì phải đoán.
  assert.equal(preview.notDerived.length, 0);

  const sowingStep = preview.steps.find((s) => s.activity === 'gieo_sa')!;
  assert.equal(sowingStep.offsetDays, 0, 'gieo sạ đúng ngày neo');
  assert.equal(sowingStep.shiftDays, 0, 'làm đúng lịch thì không dịch');
  assert.deepEqual(sowingStep.evidenceKinds, ['anh_hien_truong', 'hoa_don_vat_tu'], 'kế thừa bằng chứng');

  const landStep = preview.steps.find((s) => s.activity === 'lam_dat')!;
  assert.equal(landStep.originalOffsetDays, -10, 'kế hoạch gốc là -10 ngày');
  assert.equal(landStep.offsetDays, -12, 'thực tế làm sớm hơn 2 ngày');
  assert.equal(landStep.shiftDays, -2);
  assert.equal(landStep.windowDays, 3, 'kế thừa cửa sổ của quy trình gốc');

  const sprayStep = preview.steps.find((s) => s.activity === 'phun_thuoc')!;
  assert.equal(sprayStep.phiDays, 21, 'kế thừa thời gian cách ly');
  assert.equal(sprayStep.shiftDays, 4, 'phun muộn 4 ngày so với kế hoạch');
});

test('Rút từ vụ CHỈ có nhật ký — nói rõ thuộc tính nào không suy ra được', () => {
  const cycle = completedCycleWithLogsOnly();
  const preview = production.previewProtocolFromCycle(cycle.id);

  assert.equal(preview.source, 'nhat_ky');
  // 6 bản ghi, hai bản trùng ngày + trùng hoạt động → gộp còn 5 bước.
  assert.equal(preview.steps.length, 5);
  assert.ok(preview.warnings.some((w) => w.includes('gộp')), 'phải báo đã gộp bản ghi trùng');

  // Đây là điểm cốt lõi: hệ thống KHÔNG bịa ra các thuộc tính không quan sát được.
  assert.ok(preview.notDerived.length >= 4);
  assert.ok(preview.notDerived.some((n) => n.includes('Cửa sổ')));
  assert.ok(preview.notDerived.some((n) => n.includes('bắt buộc')));
  assert.ok(preview.notDerived.some((n) => n.includes('bằng chứng')));
  assert.ok(preview.notDerived.some((n) => n.includes('cách ly')));

  // Có phun thuốc mà không biết thời gian cách ly là rủi ro thật — phải cảnh báo.
  assert.ok(preview.warnings.some((w) => w.includes('cách ly')));

  const spray = preview.steps.find((s) => s.activity === 'phun_thuoc')!;
  assert.equal(spray.phiDays, null, 'không bịa ra thời gian cách ly');
  assert.deepEqual(spray.evidenceKinds, []);

  // Tên bước lấy từ nội dung nhật ký, thiếu thì dùng nhãn hoạt động.
  assert.equal(preview.steps[0].name, 'Cày ải 2 lượt');
  assert.equal(preview.steps.find((s) => s.activity === 'gieo_sa')!.name, 'Gieo sạ');

  // Mốc thời gian đúng theo ngày ghi nhật ký.
  assert.equal(preview.steps[0].offsetDays, -13, '28/12/2025 so với 10/01/2026');
  assert.equal(preview.steps.find((s) => s.activity === 'thu_hoach')!.offsetDays, 102);
});

test('BR-08 — quy trình rút ra luôn ở trạng thái NHÁP và ghi rõ nguồn gốc', () => {
  const { cycle } = completedCycleWithPlan();
  const created = production.createProtocolFromCycle(
    { cropCycleId: cycle.id, name: 'Quy trình vụ mẫu 2026', scope: 'htx', htxId: htxRow.id },
    actor,
  );

  assert.equal(created.status, 'nhap', 'không được tự ban hành');
  assert.equal(created.source_crop_cycle_id, cycle.id, 'phải truy vết được vụ nguồn');
  assert.ok(String(created.description).includes(cycle.code), 'mô tả phải nêu vụ nguồn');
  assert.equal(created.scope, 'htx');

  const steps = production.listProtocolSteps(created.id as string);
  assert.equal(steps.length, 4);
  assert.equal(steps[0].sort_order, 1);
  // Thứ tự theo ngày thực tế, không theo thứ tự bước gốc.
  assert.equal(steps[0].activity, 'lam_dat');
  assert.equal(steps[steps.length - 1].activity, 'thu_hoach');
});

test('Quy trình rút ra dùng được ngay cho vụ sau sau khi ban hành', () => {
  const { cycle } = completedCycleWithPlan('2026-01-20');
  const created = production.createProtocolFromCycle({ cropCycleId: cycle.id, htxId: htxRow.id }, actor);

  // Chưa ban hành thì chưa áp dụng được (BR-02 vẫn có hiệu lực).
  const nextCycle = newCycle('2026-07-01');
  assert.throws(
    () => production.generatePlan({ cropCycleId: nextCycle.id, protocolId: created.id as string }, actor),
    /chưa được ban hành/,
  );

  production.publishProtocol(created.id as string, actor);
  const plan = production.generatePlan(
    { cropCycleId: nextCycle.id, protocolId: created.id as string }, actor,
  );
  const steps = production.listPlanSteps(plan.id as string);
  assert.equal(steps.length, 4);
  // Bước làm đất của vụ nguồn lệch -12 ngày → vụ mới sạ 01/07 thì làm đất 19/06.
  assert.equal(steps[0].planned_date, '2026-06-19');
});

test('Danh sách vụ đủ điều kiện rút quy trình chỉ gồm vụ đã hoàn thành và có dữ liệu', () => {
  const { cycle: doneWithPlan } = completedCycleWithPlan('2026-02-01');
  const doneWithLogs = completedCycleWithLogsOnly('2026-02-05');
  const { cycle: stillRunning } = planWithSteps('2026-03-01');

  const eligible = production.cyclesEligibleForDerivation(htxRow.id);
  const ids = eligible.map((row) => row.id);

  assert.ok(ids.includes(doneWithPlan.id), 'vụ hoàn thành có kế hoạch phải có trong danh sách');
  assert.ok(ids.includes(doneWithLogs.id), 'vụ hoàn thành có nhật ký phải có trong danh sách');
  assert.ok(!ids.includes(stillRunning.id), 'vụ đang canh tác không được đưa vào');

  assert.equal(eligible.find((row) => row.id === doneWithPlan.id)!.source, 'ke_hoach');
  assert.equal(eligible.find((row) => row.id === doneWithLogs.id)!.source, 'nhat_ky');
});
