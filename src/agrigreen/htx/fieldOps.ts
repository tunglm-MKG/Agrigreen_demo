/**
 * App Hợp tác xã — bổ sung theo Backlog User Story v4.0 (09/2026).
 *
 *   US-SEASON-01..04  mở vụ 4 bước: giống từ danh mục → tự gán SOP; ngày sạ trong [-15, +30] ngày;
 *                     mở vụ hàng loạt cho nhiều lô; sao chép cấu hình vụ trước; chặn mở vụ trùng
 *   US-LOG-01..05     nhật ký: GPS + thời gian tự đính & khoá; máy móc đã dùng; ghi hộ; ghi hàng loạt;
 *                     duyệt Chờ duyệt → Đã duyệt / Yêu cầu bổ sung
 *   US-GPS-01/02      nhãn vị trí: Khớp (≤ 50 m) · Vị trí không khớp · Thiếu GPS · Không có GPS thiết bị
 *   US-YIELD-01..03   sản lượng: chặn khai trước giai đoạn thu hoạch; nhập hàng loạt; cảnh báo bất thường
 *                     theo ngưỡng của giống (0, âm, vượt ngưỡng) — cần xác nhận lại, không chặn hẳn
 *   US-NEWS-01..03    tin tức khuyến nông theo chuyên mục; cảnh báo khẩn đẩy tới HTX liên quan
 *   US-DASH-01..03    dashboard dự kiến – thực tế theo vụ/giống; xuất CSV; lịch gửi báo cáo
 */
import { all, insert, one, run, transaction, update, parseJson } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { notify } from '../../platform/notify/service.ts';
import { haversineKm, pointInPolygon, type LatLng } from '../../platform/geo/geo.ts';
import { addFarmLog, declareHarvest, openCropCycle } from './service.ts';
import { generatePlan, planForCycle } from './production.ts';
import { getVariety } from '../../mdm/varieties.ts';

// ---------------------------------------------------------------------------
// US-GPS-01/02 — nhãn vị trí của một bản ghi
// ---------------------------------------------------------------------------

export type GpsStatus = 'khop' | 'khong_khop' | 'thieu_gps' | 'khong_co_gps_thiet_bi' | 'chon_tu_danh_sach' | 'toa_do_anh';
export const GPS_LABELS: Record<GpsStatus, string> = {
  khop: 'Vị trí khớp', khong_khop: 'Vị trí không khớp', thieu_gps: 'Thiếu GPS',
  khong_co_gps_thiet_bi: 'Không có GPS thiết bị', chon_tu_danh_sach: 'Chọn lô từ danh sách', toa_do_anh: 'Toạ độ từ ảnh',
};
const MATCH_TOLERANCE_M = 50;

export function gpsStatusFor(plotId: string, point: LatLng | null, declaredSource?: string): { status: GpsStatus; distanceM: number | null } {
  if (declaredSource === 'khong_co_gps_thiet_bi' || declaredSource === 'chon_tu_danh_sach' || declaredSource === 'toa_do_anh') {
    return { status: declaredSource, distanceM: null };
  }
  if (!point) return { status: 'thieu_gps', distanceM: null };
  const plot = one<{ boundary: string | null; centroid_lat: number | null; centroid_lng: number | null }>(
    'SELECT boundary, centroid_lat, centroid_lng FROM plots WHERE id = ?', [plotId]);
  if (!plot) return { status: 'thieu_gps', distanceM: null };
  const ring: LatLng[] = parseJson<{ coordinates?: [number, number][][] } | null>(plot.boundary, null)?.coordinates?.[0]?.map(([lng, lat]) => ({ lat, lng })) ?? [];
  if (ring.length >= 3 && pointInPolygon(point, ring)) return { status: 'khop', distanceM: 0 };
  // Khoảng cách tới cạnh gần nhất xấp xỉ bằng khoảng cách tới đỉnh gần nhất (đủ cho dung sai 50 m).
  let nearest = Infinity;
  for (const vertex of ring) nearest = Math.min(nearest, haversineKm(point, vertex) * 1000);
  if (!ring.length && plot.centroid_lat !== null && plot.centroid_lng !== null) nearest = haversineKm(point, { lat: plot.centroid_lat, lng: plot.centroid_lng }) * 1000;
  const distanceM = Number.isFinite(nearest) ? Math.round(nearest) : null;
  return { status: distanceM !== null && distanceM <= MATCH_TOLERANCE_M ? 'khop' : 'khong_khop', distanceM };
}

// ---------------------------------------------------------------------------
// US-LOG-01/02/03/05 — nhật ký có nhãn GPS, máy móc, duyệt
// ---------------------------------------------------------------------------

export interface FarmLogInput {
  cropCycleId: string; activity: string; logDate?: string; detail?: string;
  inputName?: string; inputQty?: number; inputUom?: string; photoUrl?: string;
  lat?: number; lng?: number; gpsSource?: string; machineIds?: string[]; recordedBy?: string; synced?: boolean;
}

export function addFarmLogV2(input: FarmLogInput, actor: AuditActor = {}): Record<string, unknown> {
  const cycle = one<{ plot_id: string }>('SELECT plot_id FROM crop_cycles WHERE id = ?', [input.cropCycleId]);
  if (!cycle) throw new Error('Không tìm thấy vụ canh tác');
  const point = input.lat !== undefined && input.lng !== undefined && input.lat !== null && input.lng !== null ? { lat: Number(input.lat), lng: Number(input.lng) } : null;
  const gps = gpsStatusFor(cycle.plot_id, point, input.gpsSource);
  const record = addFarmLog({ ...input, lat: point?.lat, lng: point?.lng }, actor);
  update('farm_logs', String(record.id), {
    approval_status: 'cho_duyet',
    gps_status: gps.status,
    gps_distance_m: gps.distanceM,
    machines_json: input.machineIds?.length ? JSON.stringify(input.machineIds) : null,
  });
  return { ...record, approval_status: 'cho_duyet', gps_status: gps.status, gps_distance_m: gps.distanceM, machines: input.machineIds ?? [] };
}

/** US-LOG-03: một hoạt động cùng ngày cho nhiều lô — mỗi lô một bản ghi, cùng nhóm để tra cứu. */
export function addFarmLogsBulk(input: Omit<FarmLogInput, 'cropCycleId'> & { cropCycleIds: string[] }, actor: AuditActor = {}): { created: number; skipped: { cropCycleId: string; reason: string }[]; groupId: string } {
  const groupId = uuid();
  let created = 0;
  const skipped: { cropCycleId: string; reason: string }[] = [];
  for (const cropCycleId of input.cropCycleIds) {
    try {
      const record = addFarmLogV2({ ...input, cropCycleId, detail: `${input.detail ?? ''}${input.detail ? ' · ' : ''}[nhóm ${groupId.slice(0, 8)}]` }, actor);
      void record; created += 1;
    } catch (error) {
      skipped.push({ cropCycleId, reason: (error as Error).message });
    }
  }
  return { created, skipped, groupId };
}

export function pendingLogs(htxId: string, status: 'cho_duyet' | 'da_duyet' | 'yeu_cau_bo_sung' | 'all' = 'cho_duyet'): Record<string, unknown>[] {
  const clause = status === 'all' ? '' : 'AND fl.approval_status = ?';
  return all(
    `SELECT fl.*, cc.code AS cycle_code, p.code AS plot_code, p.htx_id, f.full_name AS farmer_name, s.name AS season_name
     FROM farm_logs fl
     JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id
     JOIN plots p ON p.id = cc.plot_id
     LEFT JOIN farmers f ON f.id = p.farmer_id
     JOIN seasons s ON s.id = cc.season_id
     WHERE p.htx_id = ? ${clause}
     ORDER BY fl.created_at DESC LIMIT 300`,
    status === 'all' ? [htxId] : [htxId, status],
  ).map((row) => ({ ...row, gps_label: GPS_LABELS[(row as { gps_status: GpsStatus }).gps_status] ?? 'Chưa xác định', machines: parseJson((row as { machines_json: string }).machines_json, []) }));
}

export function reviewFarmLog(id: string, decision: 'da_duyet' | 'yeu_cau_bo_sung', note: string | undefined, actor: AuditActor = {}): Record<string, unknown> {
  const before = one<Record<string, unknown>>('SELECT * FROM farm_logs WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy nhật ký.');
  if (decision === 'yeu_cau_bo_sung' && !note?.trim()) throw new Error('Yêu cầu bổ sung cần ghi rõ cần bổ sung gì.');
  update('farm_logs', id, { approval_status: decision, approved_by: actor.name ?? null, approved_at: nowIso(), review_note: note ?? null });
  logEvent({ module: 'htx', entityType: 'farm_logs', entityId: id, action: 'approve', before, after: { approval_status: decision, note } }, actor);
  // Thông báo cho người ghi (US-LOG-05 AC-3) — theo người ghi nếu đó là tài khoản.
  const recorder = one<{ id: string }>('SELECT id FROM users WHERE full_name = ? OR username = ?', [String(before.recorded_by ?? ''), String(before.recorded_by ?? '')]);
  if (recorder) {
    notify({
      module: 'htx', severity: decision === 'da_duyet' ? 'info' : 'warn',
      title: decision === 'da_duyet' ? 'Nhật ký đã được duyệt' : 'Nhật ký cần bổ sung',
      body: decision === 'da_duyet' ? `Nhật ký ${String(before.activity)} ngày ${String(before.log_date)} đã được Ban quản lý HTX duyệt.` : `Ban quản lý HTX yêu cầu bổ sung: ${note}`,
      link: '/htx/#htx-logs', userIds: [recorder.id], dedupeKey: `htx.log.review.${id}`, entityType: 'farm_logs', entityId: id,
    }, actor);
  }
  return one<Record<string, unknown>>('SELECT * FROM farm_logs WHERE id = ?', [id])!;
}

// ---------------------------------------------------------------------------
// US-SEASON-01..04 — mở vụ
// ---------------------------------------------------------------------------

const SOWING_PAST_DAYS = 15;
const SOWING_FUTURE_DAYS = 30;

export function validateSowingDate(date: string | undefined): string {
  const day = date ?? nowIso().slice(0, 10);
  const today = new Date(nowIso().slice(0, 10)).getTime();
  const value = new Date(day).getTime();
  if (Number.isNaN(value)) throw new Error('Ngày gieo sạ không hợp lệ.');
  const diffDays = Math.round((value - today) / 86_400_000);
  if (diffDays < -SOWING_PAST_DAYS || diffDays > SOWING_FUTURE_DAYS) {
    throw new Error(`Ngày gieo sạ phải trong khoảng ${SOWING_PAST_DAYS} ngày trước đến ${SOWING_FUTURE_DAYS} ngày sau ngày hiện tại.`);
  }
  return day;
}

export interface OpenSeasonInput { plotId: string; seasonId: string; varietyId?: string; variety?: string; sowingDate?: string; protocolId?: string | null; gps?: LatLng | null }

/** Mở vụ theo wizard: giống từ danh mục → tự gán SOP mặc định; ngày sạ hợp lệ; dự kiến thu hoạch = sạ + ngày sinh trưởng. */
export function openSeasonV2(input: OpenSeasonInput, actor: AuditActor = {}): Record<string, unknown> {
  const sowingDate = validateSowingDate(input.sowingDate);
  const variety = input.varietyId ? getVariety(input.varietyId) : null;
  if (input.varietyId && !variety) throw new Error('Giống lúa không có trong danh mục.');
  const expected = variety ? new Date(new Date(sowingDate).getTime() + variety.growth_days * 86_400_000).toISOString().slice(0, 10) : undefined;
  const cycle = openCropCycle({ plotId: input.plotId, seasonId: input.seasonId, variety: variety?.name ?? input.variety, sowingDate, expectedHarvestDate: expected }, actor);
  if (variety) update('crop_cycles', String(cycle.id), { variety_id: variety.id });
  const protocolId = input.protocolId === undefined ? variety?.default_protocol_id ?? null : input.protocolId;
  let plan: Record<string, unknown> | null = null;
  if (protocolId) {
    try { plan = generatePlan({ cropCycleId: String(cycle.id), protocolId, anchorDate: sowingDate }, actor); } catch { plan = null; }
  }
  if (input.gps) {
    const gps = gpsStatusFor(input.plotId, input.gps);
    logEvent({ module: 'htx', entityType: 'crop_cycles', entityId: String(cycle.id), action: 'update', after: { gps_status: gps.status, distanceM: gps.distanceM }, note: 'gps_confirm' }, actor);
  }
  return { ...cycle, variety_id: variety?.id ?? null, expected_harvest_date: expected ?? cycle.expected_harvest_date, plan };
}

/** US-SEASON-02/04: mở vụ hộ cho nhiều lô trong một lần; lô không hợp lệ bị bỏ qua kèm lý do. */
export function openSeasonBulk(input: Omit<OpenSeasonInput, 'plotId'> & { plotIds: string[]; htxId?: string }, actor: AuditActor = {}): { opened: Record<string, unknown>[]; skipped: { plotId: string; code: string | null; reason: string }[] } {
  const opened: Record<string, unknown>[] = [];
  const skipped: { plotId: string; code: string | null; reason: string }[] = [];
  for (const plotId of input.plotIds) {
    const plot = one<{ code: string; htx_id: string; status: string }>('SELECT code, htx_id, status FROM plots WHERE id = ? AND deleted_at IS NULL', [plotId]);
    if (!plot) { skipped.push({ plotId, code: null, reason: 'Không tìm thấy lô' }); continue; }
    if (input.htxId && plot.htx_id !== input.htxId) { skipped.push({ plotId, code: plot.code, reason: 'Lô không thuộc quyền quản lý' }); continue; }
    if (plot.status === 'dang_canh_tac') { skipped.push({ plotId, code: plot.code, reason: 'Lô đang canh tác vụ khác' }); continue; }
    try { opened.push(openSeasonV2({ ...input, plotId }, actor)); } catch (error) { skipped.push({ plotId, code: plot.code, reason: (error as Error).message }); }
  }
  return { opened, skipped };
}

/** US-SEASON-03: cấu hình vụ vừa kết thúc của lô (giống + SOP) để áp cho vụ mới; chỉ khi lô đã hoàn thành vụ. */
export function previousSeasonConfig(plotId: string): { varietyId: string | null; variety: string | null; protocolId: string | null; seasonId: string | null; cycleCode: string | null } {
  const plot = one<{ status: string; code: string }>('SELECT status, code FROM plots WHERE id = ?', [plotId]);
  if (!plot) throw new Error('Không tìm thấy lô ruộng.');
  if (plot.status === 'dang_canh_tac') throw new Error(`Lô ${plot.code} đang canh tác vụ hiện hành — chỉ sao chép được khi lô đã hoàn thành vụ.`);
  const last = one<{ id: string; code: string; variety: string | null; variety_id: string | null; season_id: string }>(
    "SELECT id, code, variety, variety_id, season_id FROM crop_cycles WHERE plot_id = ? AND status = 'da_hoan_thanh_vu' ORDER BY created_at DESC LIMIT 1", [plotId]);
  if (!last) return { varietyId: null, variety: null, protocolId: null, seasonId: null, cycleCode: null };
  const plan = planForCycle(last.id) as { protocol_id?: string } | null;
  return { varietyId: last.variety_id, variety: last.variety, protocolId: plan?.protocol_id ?? null, seasonId: last.season_id, cycleCode: last.code };
}

// ---------------------------------------------------------------------------
// US-YIELD-01..03 — sản lượng
// ---------------------------------------------------------------------------

export interface HarvestInput { cropCycleId: string; harvestDate?: string; paddyTons: number; strawTons?: number; strawState?: string; moisturePct?: number; confirmAnomaly?: boolean }

export function yieldAnomaly(cropCycleId: string, paddyTons: number): string | null {
  const cycle = one<{ area_ha: number; variety_id: string | null; variety: string | null }>('SELECT area_ha, variety_id, variety FROM crop_cycles WHERE id = ?', [cropCycleId]);
  if (!cycle) return null;
  if (!(paddyTons > 0)) return 'Sản lượng bằng 0 hoặc âm — xác nhận lại trước khi lưu.';
  const perHa = cycle.area_ha > 0 ? paddyTons / cycle.area_ha : null;
  if (perHa === null) return null;
  const variety = cycle.variety_id ? getVariety(cycle.variety_id) : (cycle.variety ? one<{ yield_max_t_ha: number; yield_min_t_ha: number; name: string }>('SELECT * FROM rice_varieties WHERE name = ?', [cycle.variety]) : null);
  const max = variety ? Number((variety as { yield_max_t_ha: number }).yield_max_t_ha) * 1.25 : 12;
  const min = variety ? Number((variety as { yield_min_t_ha: number }).yield_min_t_ha) * 0.4 : 1;
  if (perHa > max) return `Năng suất ${perHa.toFixed(2)} tấn/ha vượt ngưỡng bất thường của giống ${(variety as { name?: string } | null)?.name ?? 'lúa'} (> ${max.toFixed(1)} tấn/ha).`;
  if (perHa < min) return `Năng suất ${perHa.toFixed(2)} tấn/ha thấp bất thường so với diện tích ${cycle.area_ha} ha.`;
  return null;
}

/** US-YIELD-01 AC-1: chặn khai báo khi kế hoạch cho thấy lô chưa đến giai đoạn thu hoạch. */
function assertHarvestStage(cropCycleId: string): void {
  const cycle = one<{ sowing_date: string | null; expected_harvest_date: string | null }>('SELECT sowing_date, expected_harvest_date FROM crop_cycles WHERE id = ?', [cropCycleId]);
  if (!cycle?.sowing_date) return;
  const days = Math.round((Date.now() - new Date(cycle.sowing_date).getTime()) / 86_400_000);
  if (days < 60) throw new Error(`Lô ruộng chưa đến giai đoạn thu hoạch (mới ${days} ngày sau sạ), chưa thể khai báo sản lượng.`);
}

export function declareHarvestV2(input: HarvestInput, actor: AuditActor = {}): Record<string, unknown> {
  assertHarvestStage(input.cropCycleId);
  const anomaly = yieldAnomaly(input.cropCycleId, input.paddyTons);
  if (anomaly && !input.confirmAnomaly) {
    const error = new Error(`${anomaly} Bấm "Xác nhận vẫn lưu" nếu số liệu là cố ý.`);
    (error as Error & { needsConfirm?: boolean; anomaly?: string }).needsConfirm = true;
    (error as Error & { anomaly?: string }).anomaly = anomaly;
    throw error;
  }
  if (input.paddyTons < 0) throw new Error('Sản lượng không được âm.');
  const record = declareHarvest(input, actor);
  if (anomaly) logEvent({ module: 'htx', entityType: 'harvest_declarations', entityId: String(record.id), action: 'update', note: `anomaly_confirmed: ${anomaly}` }, actor);
  return { ...record, anomaly };
}

export function declareHarvestBulk(rows: HarvestInput[], actor: AuditActor = {}): { saved: number; errors: { row: number; cropCycleId: string; reason: string; needsConfirm?: boolean }[] } {
  let saved = 0;
  const errors: { row: number; cropCycleId: string; reason: string; needsConfirm?: boolean }[] = [];
  rows.forEach((row, index) => {
    try {
      if (row.paddyTons === undefined || row.paddyTons === null || Number.isNaN(Number(row.paddyTons))) throw new Error('Thiếu sản lượng hoặc sai định dạng số');
      declareHarvestV2({ ...row, paddyTons: Number(row.paddyTons) }, actor); saved += 1;
    } catch (error) {
      errors.push({ row: index + 1, cropCycleId: row.cropCycleId, reason: (error as Error).message, needsConfirm: (error as Error & { needsConfirm?: boolean }).needsConfirm });
    }
  });
  return { saved, errors };
}

// ---------------------------------------------------------------------------
// US-DASH-01/02 — dashboard dự kiến – thực tế
// ---------------------------------------------------------------------------

export function yieldDashboard(htxId: string, filter: { seasonId?: string; variety?: string; farmerId?: string } = {}): Record<string, unknown> {
  const clauses = ['p.htx_id = ?', 'p.deleted_at IS NULL'];
  const params: unknown[] = [htxId];
  if (filter.seasonId) { clauses.push('cc.season_id = ?'); params.push(filter.seasonId); }
  if (filter.variety) { clauses.push('cc.variety = ?'); params.push(filter.variety); }
  if (filter.farmerId) { clauses.push('p.farmer_id = ?'); params.push(filter.farmerId); }
  const where = clauses.join(' AND ');
  const bySeason = all<{ season_id: string; season_name: string; cycles: number; area_ha: number; actual_tons: number; expected_tons: number; harvested: number }>(
    `SELECT cc.season_id, s.name AS season_name, COUNT(*) AS cycles, COALESCE(SUM(cc.area_ha), 0) AS area_ha,
            COALESCE(SUM(hd.paddy_tons), 0) AS actual_tons,
            COALESCE(SUM(cc.area_ha * COALESCE(rv.yield_max_t_ha + rv.yield_min_t_ha, 12) / 2), 0) AS expected_tons,
            SUM(CASE WHEN hd.id IS NOT NULL THEN 1 ELSE 0 END) AS harvested
     FROM crop_cycles cc
     JOIN plots p ON p.id = cc.plot_id
     JOIN seasons s ON s.id = cc.season_id
     LEFT JOIN harvest_declarations hd ON hd.crop_cycle_id = cc.id
     LEFT JOIN rice_varieties rv ON rv.id = cc.variety_id OR rv.name = cc.variety
     WHERE ${where} GROUP BY cc.season_id ORDER BY s.sort_order`, params);
  const byVariety = all(
    `SELECT COALESCE(cc.variety, 'Chưa ghi giống') AS variety, COUNT(*) AS cycles, COALESCE(SUM(cc.area_ha), 0) AS area_ha,
            COALESCE(SUM(hd.paddy_tons), 0) AS actual_tons,
            CASE WHEN SUM(CASE WHEN hd.id IS NOT NULL THEN cc.area_ha ELSE 0 END) > 0
                 THEN SUM(hd.paddy_tons) / SUM(CASE WHEN hd.id IS NOT NULL THEN cc.area_ha ELSE 0 END) ELSE NULL END AS yield_t_ha
     FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id
     LEFT JOIN harvest_declarations hd ON hd.crop_cycle_id = cc.id
     WHERE ${where} GROUP BY cc.variety ORDER BY area_ha DESC`, params);
  const totals = one<{ plots: number; area_ha: number; farmers: number }>(
    `SELECT COUNT(*) AS plots, COALESCE(SUM(area_ha), 0) AS area_ha, COUNT(DISTINCT farmer_id) AS farmers FROM plots WHERE htx_id = ? AND deleted_at IS NULL`, [htxId]);
  const sop = one<{ steps: number; done: number }>(
    `SELECT COUNT(*) AS steps, SUM(CASE WHEN ps.status = 'da_thuc_hien' THEN 1 ELSE 0 END) AS done
     FROM production_plan_steps ps JOIN production_plans pl ON pl.id = ps.plan_id
     JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id
     WHERE p.htx_id = ? AND cc.status = 'dang_canh_tac'`, [htxId]);
  const approvals = one<{ pending: number }>(
    `SELECT COUNT(*) AS pending FROM farm_logs fl JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id
     WHERE p.htx_id = ? AND fl.approval_status = 'cho_duyet'`, [htxId]);
  return {
    totals: { ...totals, sopProgressPct: sop && sop.steps ? Math.round((Number(sop.done) / Number(sop.steps)) * 100) : null, pendingApprovals: approvals?.pending ?? 0 },
    bySeason, byVariety,
    varieties: all("SELECT DISTINCT variety FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id WHERE p.htx_id = ? AND variety IS NOT NULL ORDER BY variety", [htxId]).map((r) => (r as { variety: string }).variety),
  };
}

// ---------------------------------------------------------------------------
// US-NEWS-01..03 — tin tức khuyến nông cho nông dân
// ---------------------------------------------------------------------------

export const NEWS_CATEGORIES: Record<string, string> = {
  ky_thuat: 'Kỹ thuật canh tác', canh_bao: 'Cảnh báo dịch hại / thời tiết', chinh_sach: 'Chính sách', thi_truong: 'Thị trường & giá', su_kien: 'Sự kiện',
};

export function newsFeed(filter: { category?: string; q?: string; limit?: number } = {}): Record<string, unknown>[] {
  const clauses = ["status = 'published'"];
  const params: unknown[] = [];
  if (filter.category) { clauses.push('category = ?'); params.push(filter.category); }
  if (filter.q) { clauses.push('(title LIKE ? OR summary LIKE ? OR body LIKE ?)'); params.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`); }
  params.push(filter.limit ?? 100);
  return all(`SELECT id, code, title, kind, category, urgent, summary, body, crop, region_label, parent_id, published_at, view_count
              FROM knowledge_articles WHERE ${clauses.join(' AND ')} ORDER BY urgent DESC, published_at DESC LIMIT ?`, params)
    .map((row) => ({ ...row, categoryLabel: NEWS_CATEGORIES[(row as { category: string }).category] ?? (row as { category: string }).category }));
}

export function markArticleViewed(id: string): void {
  run('UPDATE knowledge_articles SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// US-DASH-03 (HTX) / US-DASH-03 (KN) — lịch gửi báo cáo định kỳ
// ---------------------------------------------------------------------------

const FREQ_DAYS: Record<string, number> = { tuan: 7, thang: 30, quy: 91 };

export function scheduleReport(input: { system: 'kn' | 'htx' | 'cgh'; scopeId?: string | null; report: string; frequency: 'tuan' | 'thang' | 'quy'; emails: string }, actor: AuditActor = {}): Record<string, unknown> {
  const emails = input.emails.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
  if (!emails.length) throw new Error('Email đăng ký nhận báo cáo không hợp lệ hoặc gửi thất bại, vui lòng kiểm tra lại.');
  for (const email of emails) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`Email "${email}" không đúng định dạng.`);
  if (!FREQ_DAYS[input.frequency]) throw new Error('Tần suất phải là tuần / tháng / quý.');
  const record = {
    id: uuid(), system: input.system, scope_id: input.scopeId ?? null, report: input.report, frequency: input.frequency,
    emails: emails.join(','), next_run_at: new Date(Date.now() + FREQ_DAYS[input.frequency] * 86_400_000).toISOString(),
    last_run_at: null, active: 1, created_by: actor.name ?? null, created_at: nowIso(),
  };
  insert('report_schedules', record);
  logEvent({ module: input.system, entityType: 'report_schedules', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function listReportSchedules(system: string, scopeId?: string | null): Record<string, unknown>[] {
  return scopeId
    ? all('SELECT * FROM report_schedules WHERE system = ? AND (scope_id = ? OR scope_id IS NULL) ORDER BY created_at DESC', [system, scopeId])
    : all('SELECT * FROM report_schedules WHERE system = ? ORDER BY created_at DESC', [system]);
}

export function cancelReportSchedule(id: string, actor: AuditActor = {}): void {
  update('report_schedules', id, { active: 0 });
  logEvent({ module: 'platform', entityType: 'report_schedules', entityId: id, action: 'update', after: { active: 0 } }, actor);
}

/** Chạy các lịch đến hạn: tạo thông báo (kênh email chưa nối → ghi outbox/nhật ký) và dời next_run_at. */
export function runDueReportSchedules(actor: AuditActor = { name: 'system' }): { ran: number } {
  const due = all<{ id: string; system: string; report: string; frequency: string; emails: string; created_by: string | null }>(
    'SELECT * FROM report_schedules WHERE active = 1 AND next_run_at <= ?', [nowIso()]);
  for (const row of due) {
    logEvent({ module: row.system, entityType: 'report_schedules', entityId: row.id, action: 'export', after: { report: row.report, emails: row.emails }, note: 'scheduled_report_sent', source: 'system' }, actor);
    update('report_schedules', row.id, { last_run_at: nowIso(), next_run_at: new Date(Date.now() + (FREQ_DAYS[row.frequency] ?? 30) * 86_400_000).toISOString() });
  }
  return { ran: due.length };
}

// ---------------------------------------------------------------------------
// Tiện ích: hồ sơ vụ để in / xuất (US-DASH-02)
// ---------------------------------------------------------------------------

export function harvestReportRows(htxId: string, seasonId?: string): Record<string, unknown>[] {
  const clauses = ['p.htx_id = ?'];
  const params: unknown[] = [htxId];
  if (seasonId) { clauses.push('cc.season_id = ?'); params.push(seasonId); }
  return all(
    `SELECT cc.code AS ma_vu, p.code AS ma_lo, COALESCE(f.full_name, '') AS nong_ho, s.name AS mua_vu, COALESCE(cc.variety, '') AS giong,
            cc.sowing_date AS ngay_sa, cc.area_ha AS dien_tich_ha, hd.harvest_date AS ngay_thu_hoach,
            hd.paddy_tons AS lua_tan, hd.straw_tons AS rom_tan,
            CASE WHEN hd.id IS NULL THEN 'Đang canh tác' ELSE 'Đã hoàn thành vụ' END AS trang_thai
     FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id JOIN seasons s ON s.id = cc.season_id
     LEFT JOIN farmers f ON f.id = p.farmer_id LEFT JOIN harvest_declarations hd ON hd.crop_cycle_id = cc.id
     WHERE ${clauses.join(' AND ')} ORDER BY s.sort_order, p.code`, params);
}

export function withTransaction<T>(fn: () => T): T { return transaction(fn); }
