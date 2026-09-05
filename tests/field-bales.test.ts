/**
 * Kiểm thử ĐẾM CUỘN và CÂN NHÀ MÁY (FM-09, FM-10).
 *
 * Rơm ĐBSCL bán theo cuộn; cân chỉ có ở nhà máy. Ở ruộng hệ thống nhận số cuộn
 * và tự ước tấn; khi ghe cập nhà máy, số cân thật đối chiếu về từng lượt ghe và
 * dạy lại hệ thống kg/cuộn cho lần ước sau.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-bale-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const field = await import('../src/erp/field/service.ts');

migrate();
seedAll();
// Bỏ số cân của seed để các test dưới bắt đầu từ kg/cuộn mặc định.
run('UPDATE field_loadings SET weighed_kg = NULL, weighed_at = NULL, weighing_id = NULL, variance_pct = NULL');
run('DELETE FROM notifications');

const actor = { id: 'test', name: 'Kiểm thử' };
const anyHtx = one<{ id: string; lat: number; lng: number }>('SELECT id, lat, lng FROM cooperatives WHERE lat IS NOT NULL ORDER BY code LIMIT 1')!;

/** Đội mới có máy cuộn, việc mới đã phân công và bắt đầu cuộn. */
function readyJob(tons = 100) {
  const team = field.createTeam({ name: `Đội cuộn ${Math.random().toString(16).slice(2, 6)}`, baseLat: anyHtx.lat, baseLng: anyHtx.lng }, actor);
  const baler = field.createVehicle({ name: 'Máy cuộn', kind: 'may_cuon', teamId: String(team.id), capacityValue: 200 }, actor);
  const job = field.createJob({ sourceType: 'manual', htxId: anyHtx.id, harvestDate: new Date().toISOString().slice(0, 10), expectedStrawTons: tons }, actor);
  field.assignJob(String(job.id), { teamId: String(team.id) }, actor);
  field.startStage(String(job.id), 'cuon_rom', { vehicleId: String(baler.id) }, actor);
  return String(job.id);
}

test('FM-09: chốt công đoạn bằng SỐ CUỘN — tấn tự ước theo kg/cuộn mặc định 20 kg', () => {
  assert.equal(field.baleKg(null).source, 'mac_dinh');
  const jobId = readyJob();
  const done = field.completeStage(jobId, 'cuon_rom', { bales: 4000 }, actor);
  const baling = (done.stages as Record<string, unknown>[]).find((s) => s.stage === 'cuon_rom')!;
  assert.equal(baling.bales, 4000);
  assert.equal(baling.quantity_tons, 80, '4 000 cuộn × 20 kg = 80 t');
  assert.equal(Number(done.expectedBales), 5000, 'việc 100 t ≈ 5 000 cuộn');
});

test('Không ghi cuộn, không ghi tấn → từ chối và nói rõ vì sao đếm cuộn', () => {
  const jobId = readyJob();
  assert.throws(() => field.completeStage(jobId, 'cuon_rom', {}, actor), /SỐ CUỘN/);
  // Dữ liệu cũ chỉ có tấn vẫn được nhận.
  field.completeStage(jobId, 'cuon_rom', { quantityTons: 50 }, actor);
});

test('FM-04 theo cuộn: gom nhiều cuộn hơn cuộn → từ chối; xuống ghe vượt cuộn đã gom → từ chối', () => {
  const jobId = readyJob();
  field.completeStage(jobId, 'cuon_rom', { bales: 3000 }, actor);
  assert.throws(() => field.completeStage(jobId, 'gom_rom', { bales: 3001 }, actor), /FM-04.*cuộn/);
  field.completeStage(jobId, 'gom_rom', { bales: 2950 }, actor);
  field.recordLoading(jobId, { vesselCode: 'BL-1', bales: 2000 }, actor);
  assert.throws(() => field.recordLoading(jobId, { vesselCode: 'BL-2', bales: 951 }, actor), /FM-04.*cuộn/);
  const ok = field.recordLoading(jobId, { vesselCode: 'BL-2', bales: 950 }, actor);
  assert.equal(ok.loading.tons, 19, '950 cuộn × 20 kg ước 19 t');
  assert.equal(ok.loading.tons_source, 'uoc_theo_cuon');
});

test('Lượt xuống ghe phải có số cuộn (hoặc tấn nếu HTX bán rơm rời); chuyến TMS mang tấn ước', () => {
  const jobId = readyJob();
  field.completeStage(jobId, 'cuon_rom', { bales: 4500 }, actor);
  field.completeStage(jobId, 'gom_rom', { bales: 4500 }, actor);
  assert.throws(() => field.recordLoading(jobId, { vesselCode: 'X' } as never, actor), /SỐ CUỘN/);
  const result = field.recordLoading(jobId, { vesselCode: 'AG-7', bales: 4400 }, actor);
  assert.equal(result.loading.tons, 88);
  assert.equal(result.trip!.planned_tons, 88);
  assert.equal(result.baleKg.kg, 20);
  // Điều phối vận tải được báo ngay.
  const note = one<{ title: string }>(`SELECT title FROM notifications WHERE entity_id = ? AND channel = 'inapp'`, [result.loading.id as string]);
  assert.ok(note && /Ghe AG-7/.test(note.title));
});

test('FM-10: cân nhà máy ghi phiếu cân vào kho, đóng chuyến TMS với tấn thật, lệch > 5 % gắn cờ và báo', () => {
  const jobId = readyJob();
  field.completeStage(jobId, 'cuon_rom', { bales: 4000 }, actor);
  field.completeStage(jobId, 'gom_rom', { bales: 4000 }, actor);
  const loaded = field.recordLoading(jobId, { vesselCode: 'CN-1', bales: 4000 }, actor); // ước 80 t
  const loadingId = String(loaded.loading.id);
  assert.equal(field.pendingWeighings().some((p) => p.id === loadingId), true);

  const weighed = field.recordPlantWeighing(loadingId, { grossKg: 130_000, tareKg: 42_000, plantBales: 3980 }, actor); // 88 t
  assert.equal(weighed.netKg, 88_000);
  assert.equal(weighed.variancePct, 10, '(88 − 80) / 80');
  assert.equal(weighed.flagged, true);

  const weighing = one<{ net_kg: number; direction: string; vehicle_code: string }>('SELECT * FROM weighings WHERE id = ?', [weighed.loading.weighing_id as string])!;
  assert.equal(weighing.net_kg, 88_000);
  assert.equal(weighing.direction, 'in');
  assert.equal(weighing.vehicle_code, 'CN-1');

  const trip = one<{ status: string; actual_tons: number }>('SELECT status, actual_tons FROM trips WHERE id = ?', [loaded.trip!.id as string])!;
  assert.equal(trip.status, 'hoan_thanh');
  assert.equal(trip.actual_tons, 88);

  assert.equal(field.pendingWeighings().some((p) => p.id === loadingId), false);
  const alert = one<{ severity: string }>(`SELECT severity FROM notifications WHERE dedupe_key = ?`, [`field.variance.${loadingId}`]);
  assert.ok(alert, 'điều hành được báo cân lệch');
  assert.throws(() => field.recordPlantWeighing(loadingId, { netKg: 1 }, actor), /đã cân/);
});

test('kg/cuộn HỌC từ lượt đã cân: lần ước kế tiếp của cùng HTX dùng 22 kg thay 20 kg', () => {
  const learned = field.baleKg(anyHtx.id);
  assert.equal(learned.source, 'can_htx');
  assert.equal(learned.kg, 22, '88 000 kg / 4 000 cuộn');
  const jobId = readyJob();
  const done = field.completeStage(jobId, 'cuon_rom', { bales: 1000 }, actor);
  assert.equal((done.stages as Record<string, unknown>[])[0].quantity_tons, 22);
});

test('Cân khớp trong ngưỡng 5 % không gắn cờ, không báo', () => {
  run('DELETE FROM notifications');
  const jobId = readyJob();
  field.completeStage(jobId, 'cuon_rom', { bales: 1000 }, actor);
  field.completeStage(jobId, 'gom_rom', { bales: 1000 }, actor);
  const loaded = field.recordLoading(jobId, { vesselCode: 'OK-1', bales: 1000 }, actor); // ước 22 t (đã học)
  const weighed = field.recordPlantWeighing(String(loaded.loading.id), { netKg: 22_500 }, actor);
  assert.equal(weighed.flagged, false);
  assert.ok(Math.abs(weighed.variancePct!) < 5);
  assert.equal(all(`SELECT id FROM notifications WHERE dedupe_key LIKE 'field.variance.%'`).length, 0);
});

test('Đối soát theo đội và HTX: tổng cuộn, tấn ước, tấn cân, kg/cuộn, số lượt lệch', () => {
  const recon = field.weighingReconciliation();
  const teams = recon.byTeam as Record<string, number | string | null>[];
  assert.ok(teams.length >= 1);
  const flagged = teams.find((t) => Number(t.flagged) >= 1);
  assert.ok(flagged, 'có đội bị cờ lệch từ test trên');
  const htx = (recon.byHtx as Record<string, number>[]).find((h) => h.weighed > 0)!;
  assert.ok(htx.avgBaleKg > 0);
  assert.ok(Math.abs(htx.weighedTons - (88 + 22.5)) < 0.2, `cân ${htx.weighedTons}`);
  assert.equal(recon.pending, field.pendingWeighings().length);
});

test('Cân sai đơn vị (tổng ≤ bì, tịnh ≤ 0) bị từ chối', () => {
  const pending = field.pendingWeighings()[0];
  assert.ok(pending, 'seed để lại một ghe chưa cân');
  assert.throws(() => field.recordPlantWeighing(String(pending.id), { grossKg: 40_000, tareKg: 41_000 }, actor), /lớn hơn/);
  assert.throws(() => field.recordPlantWeighing(String(pending.id), { netKg: 0 }, actor), /lớn hơn 0/);
  assert.throws(() => field.recordPlantWeighing(String(pending.id), {}, actor), /tịnh/);
});
