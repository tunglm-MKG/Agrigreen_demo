/**
 * Nền GIS dùng chung — màn Quản trị theo BRD GIS v1.5 & Backlog US v1.1.
 *
 *   FN-03 / US-CFG-01/02   cấu hình bảng màu heatmap (HEX hợp lệ), ngưỡng % tăng dần 0–100, khôi phục mặc định;
 *                          mọi thay đổi vào event log
 *   FN-16 BR-52 / US-INT-01 AC-2  nhập tay tạm khi hệ thống nguồn chưa sẵn sàng; nguồn trở lại phải XÁC NHẬN ghi đè
 *   FN-22/23 / US-SYNC-01/02      giám sát đồng bộ theo nguồn, dead-letter, retry một dòng / tất cả
 *   FN-07 US-BASE-01 AC-3         cập nhật ranh giới hành chính từ GeoJSON (CloudMap) có xác nhận
 */
import { all, one, run, update, parseJson } from '../../platform/db/db.ts';
import { nowIso } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { DEFAULT_CAPACITY_THRESHOLDS, DEFAULT_CROP_PALETTE, ZOOM_BANDS, getConfig, setConfig } from './service.ts';
import { runSync, type SyncSystem } from '../../platform/sync/sync.ts';
import type { ImportedFeature } from '../../mdm/geoImport.ts';

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function configOverview(): Record<string, unknown> {
  return {
    cropPalette: getConfig('gis.crop_palette', DEFAULT_CROP_PALETTE),
    cropPaletteDefault: DEFAULT_CROP_PALETTE,
    capacityThresholds: getConfig('gis.capacity_thresholds', DEFAULT_CAPACITY_THRESHOLDS),
    capacityThresholdsDefault: DEFAULT_CAPACITY_THRESHOLDS,
    zoomBands: ZOOM_BANDS,
    defaultBasemap: getConfig('gis.default_basemap', 'street'),
    weatherRefreshHours: getConfig('gis.weather_refresh_hours', 24),
    layerDefaults: getConfig('gis.layer_defaults', null),
    history: all("SELECT * FROM event_log WHERE entity_type = 'system_config' AND entity_id LIKE 'gis.%' ORDER BY id DESC LIMIT 50"),
  };
}

export function setCropPalette(palette: Record<string, { color: string; label: string }>, actor: AuditActor = {}): void {
  for (const [stage, value] of Object.entries(palette)) {
    if (!HEX.test(value?.color ?? '')) throw new Error(`Mã màu không đúng định dạng HEX (ví dụ: #1E90FF) — giai đoạn "${value?.label ?? stage}".`);
    if (!value.label?.trim()) throw new Error(`Thiếu nhãn cho giai đoạn "${stage}".`);
  }
  setConfig('gis.crop_palette', palette, actor);
}

export function setCapacityThresholds(bands: { maxPct: number; color: string; label: string }[], actor: AuditActor = {}): void {
  if (!bands.length) throw new Error('Cần ít nhất một dải ngưỡng.');
  let previous = -1;
  for (const band of bands) {
    if (!Number.isFinite(band.maxPct) || band.maxPct < 0 || band.maxPct > 101) throw new Error('Ngưỡng % phải tăng dần và nằm trong khoảng 0–100%.');
    if (band.maxPct <= previous) throw new Error('Ngưỡng % phải tăng dần và nằm trong khoảng 0–100%.');
    previous = band.maxPct;
    if (!HEX.test(band.color)) throw new Error('Mã màu không đúng định dạng HEX (ví dụ: #1E90FF).');
  }
  setConfig('gis.capacity_thresholds', bands, actor);
}

export function resetConfig(key: 'gis.crop_palette' | 'gis.capacity_thresholds' | 'gis.default_basemap' | 'gis.weather_refresh_hours', actor: AuditActor = {}): void {
  const before = getConfig(key, null);
  run('DELETE FROM system_config WHERE key = ?', [key]);
  logEvent({ module: 'gis', entityType: 'system_config', entityId: key, action: 'delete', before, after: null, note: 'reset_to_default' }, actor);
}

export function setSimpleConfig(key: 'gis.default_basemap' | 'gis.weather_refresh_hours' | 'gis.layer_defaults', value: unknown, actor: AuditActor = {}): void {
  if (key === 'gis.default_basemap' && !['street', 'satellite', 'terrain'].includes(String(value))) throw new Error('Lớp nền mặc định phải là street / satellite / terrain.');
  if (key === 'gis.weather_refresh_hours' && !(Number(value) >= 1 && Number(value) <= 168)) throw new Error('Chu kỳ làm mới thời tiết phải trong 1–168 giờ.');
  setConfig(key, value, actor);
}

// ---------------------------------------------------------------------------
// Nhập tay tạm & xác nhận ghi đè (FN-16 BR-52)
// ---------------------------------------------------------------------------

interface ManualOverride { table: 'crop_status' | 'facilities'; id: string; fields: Record<string, unknown>; enteredAt: string; enteredBy: string | null }

function overrides(): ManualOverride[] { return getConfig<ManualOverride[]>('gis.manual_overrides', []); }

/** Admin nhập tạm giai đoạn mùa vụ / dung lượng khi nguồn chưa sẵn sàng. */
export function manualEntry(input: { table: 'crop_status' | 'facilities'; id: string; fields: Record<string, unknown> }, actor: AuditActor = {}): void {
  const allowed = input.table === 'crop_status' ? ['stage', 'expected_harvest_date', 'straw_tons', 'expected_yield_tons'] : ['capacity_tons', 'current_stock_tons'];
  const fields = Object.fromEntries(Object.entries(input.fields).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(fields).length) throw new Error(`Không có trường hợp lệ để nhập tay (${allowed.join(', ')}).`);
  if (!one(`SELECT 1 FROM ${input.table} WHERE id = ?`, [input.id])) throw new Error('Không tìm thấy bản ghi.');
  update(input.table, input.id, { ...fields, updated_at: nowIso() });
  const list = overrides().filter((o) => !(o.table === input.table && o.id === input.id));
  list.push({ table: input.table, id: input.id, fields, enteredAt: nowIso(), enteredBy: actor.name ?? null });
  setConfig('gis.manual_overrides', list, actor);
  logEvent({ module: 'gis', entityType: input.table, entityId: input.id, action: 'update', after: fields, note: 'manual_fallback' }, actor);
}

/** Dữ liệu nguồn đã trở lại và KHÁC số nhập tay → liệt kê để Admin xác nhận trước khi ghi đè. */
export function pendingOverrides(incoming: { table: 'crop_status' | 'facilities'; id: string; fields: Record<string, unknown> }[] = []): Record<string, unknown>[] {
  const manual = overrides();
  return manual.map((o) => {
    const inc = incoming.find((i) => i.table === o.table && i.id === o.id);
    const current = one<Record<string, unknown>>(`SELECT * FROM ${o.table} WHERE id = ?`, [o.id]);
    const diffs = inc ? Object.entries(inc.fields).filter(([k, v]) => String(o.fields[k]) !== String(v)) : [];
    return { ...o, current, incoming: inc?.fields ?? null, differs: diffs.length > 0, diffs };
  });
}

export function resolveOverride(input: { table: 'crop_status' | 'facilities'; id: string; accept: boolean; incoming?: Record<string, unknown> }, actor: AuditActor = {}): void {
  const list = overrides();
  const found = list.find((o) => o.table === input.table && o.id === input.id);
  if (!found) throw new Error('Không có bản ghi nhập tay tương ứng.');
  if (input.accept && input.incoming) update(input.table, input.id, { ...input.incoming, updated_at: nowIso() });
  setConfig('gis.manual_overrides', list.filter((o) => o !== found), actor);
  logEvent({ module: 'gis', entityType: input.table, entityId: input.id, action: 'update', before: found.fields, after: input.accept ? input.incoming : found.fields, note: input.accept ? 'override_accepted' : 'manual_kept' }, actor);
}

// ---------------------------------------------------------------------------
// Giám sát đồng bộ & dead-letter (FN-22/23)
// ---------------------------------------------------------------------------

export const SYNC_SOURCE_LABELS: Record<string, string> = {
  app_htx: 'App Hợp tác xã', ban_do_cgh: 'Bản đồ Cơ giới hoá', erp: 'ERP Mekong Green', tms: 'TMS', khuyen_nong: 'App Khuyến nông', simulation: 'Mô phỏng',
};

export function syncMonitor(): Record<string, unknown> {
  const bySystem = all<{ system: string; total: number; success: number; failed: number; dead: number; last: string | null; records: number }>(
    `SELECT system, COUNT(*) AS total,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead,
            MAX(finished_at) AS last, COALESCE(SUM(record_count), 0) AS records
     FROM sync_log GROUP BY system ORDER BY system`);
  return {
    sources: bySystem.map((s) => ({ ...s, label: SYNC_SOURCE_LABELS[s.system] ?? s.system, health: s.dead > 0 ? 'dead_letter' : s.failed > 0 ? 'warn' : 'ok' })),
    deadLetter: all("SELECT * FROM sync_log WHERE status = 'dead_letter' ORDER BY started_at DESC LIMIT 50"),
    recent: all('SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 100'),
  };
}

/** Thử lại NGAY một giao dịch dead-letter/failed bằng cách chạy lại chính dataset đó qua runSync (retry handler đã đăng ký). */
export function retryOne(logId: string, handler: ((payload: unknown) => { recordCount: number }) | null, actor: AuditActor = {}): Record<string, unknown> {
  const row = one<{ id: string; system: string; direction: string; dataset: string; attempt: number; payload_json: string | null; status: string }>('SELECT * FROM sync_log WHERE id = ?', [logId]);
  if (!row) throw new Error('Không tìm thấy bản ghi đồng bộ.');
  if (!handler) {
    // Không có trình xử lý cho dataset này (dữ liệu mô phỏng) — đánh dấu đã xử lý thủ công, ghi vết.
    update('sync_log', logId, { status: 'success', finished_at: nowIso(), error_message: 'Đã xử lý thủ công bởi Admin (không có handler tự động)' });
    logEvent({ module: 'sync', entityType: 'sync_log', entityId: logId, action: 'update', note: 'manual_resolve' }, actor);
    return { status: 'success', manual: true };
  }
  const payload = row.payload_json ? JSON.parse(row.payload_json) : undefined;
  const outcome = runSync({ system: row.system as SyncSystem, direction: row.direction as never, dataset: row.dataset, attempt: row.attempt + 1, payload }, () => handler(payload));
  update('sync_log', logId, { status: 'retrying', next_retry_at: null });
  return outcome as unknown as Record<string, unknown>;
}

/** Mô phỏng một lần đồng bộ thất bại (để trình diễn chuỗi retry → dead-letter, US-SYNC-02). */
export function simulateFailure(system: SyncSystem, dataset: string, actor: AuditActor = {}): Record<string, unknown> {
  const outcome = runSync({ system, direction: 'inbound', dataset, attempt: 5, payload: { simulated: true } }, () => { throw new Error('Mô phỏng lỗi kết nối tới hệ thống nguồn'); });
  logEvent({ module: 'gis', entityType: 'sync_log', entityId: outcome.logId, action: 'sync', note: 'simulated_failure' }, actor);
  return outcome as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Ranh giới hành chính từ GeoJSON (FN-07 BR-26/27, US-BASE-01 AC-3)
// ---------------------------------------------------------------------------

export function previewAdminBoundaries(features: ImportedFeature[]): { matched: { id: string; name: string; level: string; vertices: number }[]; unmatched: string[] } {
  const matched: { id: string; name: string; level: string; vertices: number }[] = [];
  const unmatched: string[] = [];
  for (const f of features) {
    if (f.kind !== 'polygon' || !f.name) { unmatched.push(f.name ?? '(không tên)'); continue; }
    const unit = one<{ id: string; name: string; level: string }>('SELECT id, name, level FROM admin_units WHERE name = ? OR code = ? ORDER BY level LIMIT 1', [f.name, f.name]);
    if (unit) matched.push({ ...unit, vertices: f.points.length }); else unmatched.push(f.name);
  }
  return { matched, unmatched };
}

export function applyAdminBoundaries(features: ImportedFeature[], actor: AuditActor = {}): { updated: number } {
  let updated = 0;
  for (const f of features) {
    if (f.kind !== 'polygon' || !f.name) continue;
    const unit = one<{ id: string; boundary: string | null }>('SELECT id, boundary FROM admin_units WHERE name = ? OR code = ? ORDER BY level LIMIT 1', [f.name, f.name]);
    if (!unit) continue;
    const boundary = { type: 'Polygon', coordinates: [[...f.points, f.points[0]].map((p) => [p.lng, p.lat])] };
    const c = f.points.reduce((acc, p) => ({ lat: acc.lat + p.lat / f.points.length, lng: acc.lng + p.lng / f.points.length }), { lat: 0, lng: 0 });
    update('admin_units', unit.id, { boundary: JSON.stringify(boundary), centroid_lat: c.lat, centroid_lng: c.lng });
    logEvent({ module: 'gis', entityType: 'admin_units', entityId: unit.id, action: 'update', before: { boundary: parseJson(unit.boundary, null) }, after: { boundary, source: 'CloudMap GeoJSON' } }, actor);
    updated += 1;
  }
  return { updated };
}

/** Tổng quan tích hợp cho tab "Tích hợp hệ thống" (FN-16/17). */
export function integrationOverview(): Record<string, unknown> {
  const last = (system: string) => one("SELECT started_at, status, record_count, dataset FROM sync_log WHERE system = ? ORDER BY started_at DESC LIMIT 1", [system]);
  return {
    inbound: [
      { system: 'app_htx', label: 'App Hợp tác xã', datasets: ['Vị trí HTX / vùng trồng', 'Nhật ký sản xuất', 'Lịch gieo sạ & ngày thu hoạch', 'Tiến độ mùa vụ', 'Sản lượng dự kiến & rơm'], feeds: ['crop_heatmap', 'harvest_alerts'], last: last('app_htx') },
      { system: 'ban_do_cgh', label: 'Bản đồ Cơ giới hoá', datasets: ['Số máy theo khâu', 'Kết quả thiếu/thừa máy (GIS chỉ hiển thị)'], feeds: ['machinery'], last: last('ban_do_cgh') },
      { system: 'erp', label: 'ERP Mekong Green', datasets: ['Sức chứa tổng & dung lượng trống kho/Hub'], feeds: ['capacity_widgets'], last: last('erp') },
    ],
    outbound: [{ system: 'tms', label: 'TMS', datasets: ['Lớp nền + lớp chuẩn hoá (ranh giới, HTX/Hub, dữ liệu động, widget dung lượng)'], last: last('tms') }],
    manualOverrides: overrides().length,
  };
}
