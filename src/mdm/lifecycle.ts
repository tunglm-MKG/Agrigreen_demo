/**
 * Vòng đời dữ liệu dùng chung: xoá mềm & khôi phục, chồng lấn ranh giới, hồ sơ
 * nông hộ, vô hiệu hoá HTX có lý do, nhập hàng loạt từ tệp không gian.
 *
 *   GIS BR-14 / BR-17 / BR-19   xoá mềm HTX, Hub/kho, thửa — ẩn khỏi bản đồ, giữ lịch sử, khôi phục được
 *   GIS US-BND-07/08, US-PLOT-04 nạp GeoJSON/KML hàng loạt cho HTX, Hub, thửa
 *   KN US-PLOT-03 / HTX US-PLOT-04 cảnh báo & chặn chồng lấn ranh giới thửa
 *   HTX US-HH-01/02             hồ sơ nông hộ: sửa, tìm, nhập hàng loạt, chống trùng SĐT
 *   HTX US-HTXSTATUS-01/02/03   vô hiệu hoá HTX kèm lý do ≥ 20 ký tự, khoá/mở đúng tài khoản
 */
import { all, insert, one, run, transaction, update, parseJson } from '../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../platform/audit/audit.ts';
import { centroid, pointInPolygon, polygonAreaHectares, type LatLng } from '../platform/geo/geo.ts';
import { createCooperative, createFacility, createPlot, getPlot, type Plot } from './service.ts';
import type { ImportedFeature } from './geoImport.ts';

// ---------------------------------------------------------------------------
// Chồng lấn ranh giới thửa (KN US-PLOT-03, HTX US-PLOT-04)
// ---------------------------------------------------------------------------

export interface OverlapHit { plotId: string; code: string; htxId: string; farmerId: string | null; sharedVertices: number; centroidInside: boolean }

function ringOf(boundary: string | null): LatLng[] {
  const geometry = parseJson<{ coordinates?: [number, number][][] } | null>(boundary, null);
  return geometry?.coordinates?.[0]?.map(([lng, lat]) => ({ lat, lng })) ?? [];
}

/**
 * Phát hiện thửa đã có mà ranh giới mới đè lên. Không cần thư viện hình học:
 * hai đa giác chồng nhau khi có đỉnh của bên này nằm trong bên kia, hoặc tâm của
 * bên này nằm trong bên kia. Sai số của cách kiểm này chỉ ở các đa giác cắt nhau
 * mà không nuốt đỉnh nào của nhau — hiếm với ranh thửa thực tế.
 */
export function findOverlaps(boundary: LatLng[], excludePlotId?: string): OverlapHit[] {
  if (boundary.length < 3) return [];
  const bounds = { south: Math.min(...boundary.map((p) => p.lat)), north: Math.max(...boundary.map((p) => p.lat)), west: Math.min(...boundary.map((p) => p.lng)), east: Math.max(...boundary.map((p) => p.lng)) };
  const candidates = all<{ id: string; code: string; htx_id: string; farmer_id: string | null; boundary: string | null }>(
    `SELECT id, code, htx_id, farmer_id, boundary FROM plots
     WHERE deleted_at IS NULL AND boundary IS NOT NULL
       AND centroid_lat BETWEEN ? AND ? AND centroid_lng BETWEEN ? AND ?`,
    [bounds.south - 0.02, bounds.north + 0.02, bounds.west - 0.02, bounds.east + 0.02],
  );
  const mine = centroid(boundary);
  const hits: OverlapHit[] = [];
  for (const row of candidates) {
    if (row.id === excludePlotId) continue;
    const ring = ringOf(row.boundary);
    if (ring.length < 3) continue;
    const inside = boundary.filter((p) => pointInPolygon(p, ring)).length + ring.filter((p) => pointInPolygon(p, boundary)).length;
    const centroidInside = pointInPolygon(mine, ring) || pointInPolygon(centroid(ring), boundary);
    if (inside > 0 || centroidInside) hits.push({ plotId: row.id, code: row.code, htxId: row.htx_id, farmerId: row.farmer_id, sharedVertices: inside, centroidInside });
  }
  return hits;
}

/**
 * Tạo thửa có kiểm tra: tối thiểu 4 đỉnh không thẳng hàng (US-PLOT-01/02), chặn
 * chồng lấn với thửa của HTX/hộ KHÁC; chồng với thửa cùng HTX thì cảnh báo và chỉ
 * lưu khi `confirmOverlap` (HTX US-PLOT-04 AC-2).
 */
export function createPlotChecked(
  input: { name?: string; htxId: string; farmerId?: string; boundary: LatLng[]; soilType?: string; source?: string; confirmOverlap?: boolean; minPoints?: number },
  actor: AuditActor = {},
): Plot & { areaLabel: string; overlaps: OverlapHit[] } {
  const minimum = input.minPoints ?? 4;
  if (!input.boundary || input.boundary.length < minimum) {
    throw new Error(`Cần tối thiểu ${minimum} điểm ranh giới không thẳng hàng để khép vùng.`);
  }
  if (!(polygonAreaHectares(input.boundary) > 0.0001)) {
    throw new Error('Các điểm ranh giới thẳng hàng hoặc trùng nhau — không khép được vùng. Vẽ lại tối thiểu 4 điểm không thẳng hàng.');
  }
  const overlaps = findOverlaps(input.boundary);
  const foreign = overlaps.filter((o) => o.htxId !== input.htxId || (input.farmerId && o.farmerId && o.farmerId !== input.farmerId));
  if (foreign.length) {
    throw new Error(`Ranh giới bị chồng lấn với lô đã đăng ký (${foreign.map((o) => o.code).join(', ')}) của HTX/nông hộ khác, vui lòng kiểm tra lại.`);
  }
  if (overlaps.length && !input.confirmOverlap) {
    const error = new Error(`Ranh giới bị chồng lấn với lô đã đăng ký (${overlaps.map((o) => o.code).join(', ')}), vui lòng kiểm tra lại hoặc xác nhận giữ nguyên.`);
    (error as Error & { overlaps?: OverlapHit[]; needsConfirm?: boolean }).overlaps = overlaps;
    (error as Error & { needsConfirm?: boolean }).needsConfirm = true;
    throw error;
  }
  const created = createPlot(input, actor);
  return { ...created, overlaps };
}

// ---------------------------------------------------------------------------
// Xoá mềm & khôi phục (GIS BR-14/17/19)
// ---------------------------------------------------------------------------

export type SoftDeletable = 'plots' | 'facilities' | 'cooperatives';

export function softDelete(table: SoftDeletable, id: string, reason: string, actor: AuditActor = {}): void {
  const before = one<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!before) throw new Error('Không tìm thấy bản ghi.');
  if (before.deleted_at) throw new Error('Bản ghi đã bị xoá trước đó.');
  const values: Record<string, unknown> = { deleted_at: nowIso(), updated_at: nowIso() };
  if (table === 'plots') { values.deleted_by = actor.name ?? null; values.deleted_reason = reason || null; }
  if (table === 'facilities') { values.deleted_reason = reason || null; values.status = 'closed'; }
  if (table === 'cooperatives') { values.status = 'inactive'; values.status_reason = reason || null; values.deactivated_at = nowIso(); }
  update(table, id, values);
  logEvent({ module: 'gis', entityType: table, entityId: id, action: 'delete', before, after: values, note: reason || 'soft_delete' }, actor);
}

export function restore(table: SoftDeletable, id: string, actor: AuditActor = {}): void {
  const before = one<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!before) throw new Error('Không tìm thấy bản ghi.');
  const values: Record<string, unknown> = { deleted_at: null, updated_at: nowIso() };
  if (table === 'plots') { values.deleted_by = null; values.deleted_reason = null; }
  if (table === 'facilities') { values.deleted_reason = null; values.status = 'active'; }
  if (table === 'cooperatives') { values.status = 'active'; values.status_reason = null; values.deactivated_at = null; }
  update(table, id, values);
  logEvent({ module: 'gis', entityType: table, entityId: id, action: 'update', before, after: values, note: 'restore' }, actor);
}

/** Bản ghi đã xoá mềm của cả ba lớp — cho tab "Đã xoá" ở màn quản trị GIS. */
export function listDeleted(): { table: SoftDeletable; id: string; code: string; name: string | null; deletedAt: string; reason: string | null; by: string | null }[] {
  const plots = all<{ id: string; code: string; name: string | null; deleted_at: string; deleted_reason: string | null; deleted_by: string | null }>(
    'SELECT id, code, name, deleted_at, deleted_reason, deleted_by FROM plots WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
  const facilities = all<{ id: string; code: string; name: string; deleted_at: string; deleted_reason: string | null }>(
    'SELECT id, code, name, deleted_at, deleted_reason FROM facilities WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
  const htx = all<{ id: string; code: string; name: string; deleted_at: string; status_reason: string | null }>(
    'SELECT id, code, name, deleted_at, status_reason FROM cooperatives WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
  return [
    ...plots.map((r) => ({ table: 'plots' as const, id: r.id, code: r.code, name: r.name, deletedAt: r.deleted_at, reason: r.deleted_reason, by: r.deleted_by })),
    ...facilities.map((r) => ({ table: 'facilities' as const, id: r.id, code: r.code, name: r.name, deletedAt: r.deleted_at, reason: r.deleted_reason, by: null })),
    ...htx.map((r) => ({ table: 'cooperatives' as const, id: r.id, code: r.code, name: r.name, deletedAt: r.deleted_at, reason: r.status_reason, by: null })),
  ];
}

/** Lịch sử biến động của một bản ghi (mọi lớp) — từ event_log, không ghi đè. */
export function historyOf(entityType: string, entityId: string, limit = 100): Record<string, unknown>[] {
  return all('SELECT * FROM event_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT ?', [entityType, entityId, limit]);
}

// ---------------------------------------------------------------------------
// Vô hiệu hoá / kích hoạt lại HTX có lý do (HTX US-HTXSTATUS-01/02/03)
// ---------------------------------------------------------------------------

export function deactivateCooperative(id: string, reason: string, actor: AuditActor = {}): { lockedAccounts: number; farmers: number; openCycles: number; pendingLogs: number } {
  if (!reason || reason.trim().length < 20) throw new Error('Lý do vô hiệu hóa phải có ít nhất 20 ký tự.');
  const impact = cooperativeImpact(id);
  let lockedAccounts = 0;
  transaction(() => {
    update('cooperatives', id, { status: 'inactive', status_reason: reason.trim(), deactivated_at: nowIso(), deleted_at: nowIso(), updated_at: nowIso() });
    const users = all<{ id: string }>("SELECT id FROM users WHERE htx_id = ? AND status = 'active'", [id]);
    for (const u of users) {
      update('users', u.id, { status: 'locked', lock_reason: 'htx_inactive', updated_at: nowIso() });
      run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
      lockedAccounts += 1;
    }
  });
  logEvent({ module: 'mdm', entityType: 'cooperatives', entityId: id, action: 'delete', after: { status: 'inactive', reason: reason.trim(), lockedAccounts, ...impact }, note: 'deactivate_htx' }, actor);
  return { lockedAccounts, ...impact };
}

export function reactivateCooperative(id: string, actor: AuditActor = {}): { unlockedAccounts: number } {
  let unlockedAccounts = 0;
  transaction(() => {
    update('cooperatives', id, { status: 'active', status_reason: null, deactivated_at: null, deleted_at: null, updated_at: nowIso() });
    // Chỉ mở tài khoản bị khoá VÌ HTX — tài khoản khoá thủ công vì lý do khác giữ nguyên (AC-2).
    const users = all<{ id: string }>("SELECT id FROM users WHERE htx_id = ? AND status = 'locked' AND lock_reason = 'htx_inactive'", [id]);
    for (const u of users) { update('users', u.id, { status: 'active', lock_reason: null, updated_at: nowIso() }); unlockedAccounts += 1; }
  });
  logEvent({ module: 'mdm', entityType: 'cooperatives', entityId: id, action: 'update', after: { status: 'active', unlockedAccounts }, note: 'reactivate_htx' }, actor);
  return { unlockedAccounts };
}

/** Phạm vi ảnh hưởng trước khi vô hiệu hoá (AC-1): hộ, vụ chưa xong, nhật ký chờ duyệt. */
export function cooperativeImpact(id: string): { farmers: number; openCycles: number; pendingLogs: number; accounts: number; machines: number } {
  const n = (sql: string, params: unknown[] = [id]) => one<{ n: number }>(sql, params)?.n ?? 0;
  return {
    farmers: n("SELECT COUNT(*) AS n FROM farmers WHERE htx_id = ? AND status = 'active'"),
    openCycles: n("SELECT COUNT(*) AS n FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id WHERE p.htx_id = ? AND cc.status = 'dang_canh_tac'"),
    pendingLogs: n("SELECT COUNT(*) AS n FROM farm_logs fl JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id WHERE p.htx_id = ? AND fl.approval_status = 'cho_duyet'"),
    accounts: n("SELECT COUNT(*) AS n FROM users WHERE htx_id = ? AND status = 'active'"),
    machines: n("SELECT COUNT(*) AS n FROM machines WHERE htx_id = ? AND status = 'active'"),
  };
}

// ---------------------------------------------------------------------------
// Hồ sơ nông hộ (HTX US-HH-01/02)
// ---------------------------------------------------------------------------

const PHONE_RE = /^0\d{9}$/;

export function updateFarmer(id: string, patch: { fullName?: string; phone?: string; nationalId?: string; address?: string; status?: string; areaHa?: number }, actor: AuditActor = {}): Record<string, unknown> {
  const before = one<Record<string, unknown>>('SELECT * FROM farmers WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy nông hộ.');
  const values: Record<string, unknown> = {};
  if (patch.fullName !== undefined) values.full_name = patch.fullName;
  if (patch.phone !== undefined) {
    const phone = patch.phone.replace(/\s+/g, '');
    if (phone && !PHONE_RE.test(phone)) throw new Error('SĐT không đúng định dạng, VD: 09xxxxxxxx');
    const dup = one('SELECT id FROM farmers WHERE phone = ? AND id <> ?', [phone, id]);
    if (dup) throw new Error('SĐT đã được sử dụng bởi nông hộ khác');
    values.phone = phone || null;
  }
  if (patch.nationalId !== undefined) values.national_id = patch.nationalId || null;
  if (patch.address !== undefined) values.address = patch.address || null;
  if (patch.status !== undefined) values.status = patch.status;
  update('farmers', id, values);
  const after = one<Record<string, unknown>>('SELECT * FROM farmers WHERE id = ?', [id])!;
  logEvent({ module: 'mdm', entityType: 'farmers', entityId: id, action: 'update', before, after }, actor);
  return after;
}

/** Danh sách nông hộ kèm số thửa và diện tích thật (tính từ polygon). */
export function farmersWithPlots(htxId: string, search?: string): Record<string, unknown>[] {
  const clauses = ['f.htx_id = ?'];
  const params: unknown[] = [htxId];
  if (search) { clauses.push('(f.full_name LIKE ? OR f.phone LIKE ? OR f.code LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  return all(
    `SELECT f.*, (SELECT COUNT(*) FROM plots p WHERE p.farmer_id = f.id AND p.deleted_at IS NULL) AS plot_count,
            (SELECT COALESCE(SUM(p.area_ha), 0) FROM plots p WHERE p.farmer_id = f.id AND p.deleted_at IS NULL) AS area_ha
     FROM farmers f WHERE ${clauses.join(' AND ')} ORDER BY f.full_name`, params);
}

export function importFarmers(htxId: string, rows: Record<string, unknown>[], actor: AuditActor = {}): { created: number; errors: { row: number; reason: string }[] } {
  let created = 0;
  const errors: { row: number; reason: string }[] = [];
  const seenPhones = new Set<string>();
  rows.forEach((row, index) => {
    try {
      const fullName = String(row.fullName ?? row.ho_ten ?? row.name ?? '').trim();
      const phone = String(row.phone ?? row.sdt ?? '').replace(/\s+/g, '');
      if (!fullName) throw new Error('Thiếu họ tên');
      if (phone && !PHONE_RE.test(phone)) throw new Error('SĐT không đúng định dạng');
      if (phone && seenPhones.has(phone)) throw new Error(`SĐT trùng với dòng khác trong cùng tệp`);
      if (phone && one('SELECT id FROM farmers WHERE phone = ?', [phone])) throw new Error('SĐT đã tồn tại');
      seenPhones.add(phone);
      const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM farmers')?.n ?? 0;
      insert('farmers', {
        id: uuid(), code: sequenceCode('NH', count + 1, 5), full_name: fullName, phone: phone || null,
        national_id: row.nationalId ? String(row.nationalId) : null, htx_id: htxId, address: row.address ? String(row.address) : null,
        reliability_score: 0, status: 'active', created_at: nowIso(),
      });
      created += 1;
    } catch (error) {
      errors.push({ row: index + 1, reason: (error as Error).message });
    }
  });
  run('UPDATE cooperatives SET member_count = (SELECT COUNT(*) FROM farmers WHERE htx_id = ?) WHERE id = ?', [htxId, htxId]);
  logEvent({ module: 'mdm', entityType: 'farmers', action: 'create', after: { htxId, created, errors: errors.length }, note: 'bulk_import' }, actor);
  return { created, errors };
}

// ---------------------------------------------------------------------------
// Nhập hàng loạt từ tệp không gian (GIS US-BND-07/08, US-PLOT-04, KN US-PLOT-02)
// ---------------------------------------------------------------------------

export type ImportTarget = 'htx' | 'hub' | 'plot';

export interface FeatureImportOutcome { created: number; updated: number; errors: { index: number; name: string | null; reason: string }[]; ids: string[] }

export function importFeatures(
  target: ImportTarget,
  features: ImportedFeature[],
  options: { htxId?: string; provinceId?: string; kind?: 'hub' | 'warehouse' | 'yard' | 'plant'; source?: string } = {},
  actor: AuditActor = {},
): FeatureImportOutcome {
  const outcome: FeatureImportOutcome = { created: 0, updated: 0, errors: [], ids: [] };
  features.forEach((feature, index) => {
    try {
      const props = feature.properties;
      const num = (keys: string[]): number | undefined => {
        for (const key of keys) { const v = Number(props[key]); if (props[key] !== undefined && Number.isFinite(v)) return v; }
        return undefined;
      };
      const text = (keys: string[]): string | undefined => {
        for (const key of keys) { const v = props[key]; if (typeof v === 'string' && v.trim()) return v.trim(); }
        return undefined;
      };
      if (target === 'htx') {
        const name = feature.name ?? text(['ten_htx']);
        if (!name) throw new Error('Thiếu tên HTX');
        const address = text(['address', 'dia_chi', 'diachi']);
        if (!address) throw new Error('Vui lòng nhập đầy đủ Tên HTX và Địa chỉ.');
        const existing = one<{ id: string }>('SELECT id FROM cooperatives WHERE name = ?', [name]);
        const point = feature.kind === 'point' ? feature.points[0] : centroid(feature.points);
        if (existing) {
          const values: Record<string, unknown> = { address, lat: point.lat, lng: point.lng, updated_at: nowIso() };
          if (feature.kind === 'polygon') {
            values.boundary = JSON.stringify({ type: 'Polygon', coordinates: [[...feature.points, feature.points[0]].map((p) => [p.lng, p.lat])] });
          }
          const area = num(['area_ha', 'dien_tich']) ?? (feature.kind === 'polygon' ? Math.round(polygonAreaHectares(feature.points) * 100) / 100 : undefined);
          if (area !== undefined) values.registered_area_ha = area;
          update('cooperatives', existing.id, values);
          logEvent({ module: 'gis', entityType: 'cooperatives', entityId: existing.id, action: 'update', after: { name, source: 'import' } }, actor);
          outcome.updated += 1; outcome.ids.push(existing.id);
        } else {
          const created = createCooperative({
            name, address, provinceId: options.provinceId, lat: point.lat, lng: point.lng,
            boundary: feature.kind === 'polygon' ? feature.points : undefined,
            registeredAreaHa: num(['area_ha', 'dien_tich']), contactPhone: text(['phone', 'sdt']),
          }, actor);
          outcome.created += 1; outcome.ids.push(created.id);
        }
      } else if (target === 'hub') {
        const name = feature.name ?? text(['ten_hub']);
        const address = text(['address', 'dia_chi']);
        if (!name || !address) throw new Error('Vui lòng nhập đầy đủ Tên Hub và Địa chỉ.');
        const capacity = num(['capacity_tons', 'suc_chua', 'capacity']);
        if (capacity === undefined || !(capacity > 0)) throw new Error('Sức chứa phải là số lớn hơn 0.');
        const point = feature.kind === 'point' ? feature.points[0] : centroid(feature.points);
        const existing = one<{ id: string }>('SELECT id FROM facilities WHERE name = ?', [name]);
        const unit = text(['unit', 'don_vi']) ?? 'tấn';
        if (existing) {
          update('facilities', existing.id, { lat: point.lat, lng: point.lng, capacity_tons: capacity, capacity_unit: unit, address, updated_at: nowIso() });
          logEvent({ module: 'gis', entityType: 'facilities', entityId: existing.id, action: 'update', after: { name, capacity, source: 'import' } }, actor);
          outcome.updated += 1; outcome.ids.push(existing.id);
        } else {
          const created = createFacility({ name, kind: options.kind ?? 'hub', lat: point.lat, lng: point.lng, capacityTons: capacity, provinceId: options.provinceId }, actor);
          update('facilities', String(created.id), { address, capacity_unit: unit, boundary: feature.kind === 'polygon' ? JSON.stringify({ type: 'Polygon', coordinates: [[...feature.points, feature.points[0]].map((p) => [p.lng, p.lat])] }) : null });
          outcome.created += 1; outcome.ids.push(String(created.id));
        }
      } else {
        if (feature.kind !== 'polygon') throw new Error('Thửa ruộng phải là Polygon');
        const htxId = options.htxId ?? text(['htx_id']) ?? one<{ id: string }>('SELECT id FROM cooperatives WHERE code = ? OR name = ?', [text(['htx_code']) ?? '', text(['htx', 'ten_htx']) ?? ''])?.id;
        if (!htxId) throw new Error('Không xác định được HTX của thửa (thiếu htx_code / chọn HTX trước khi nạp)');
        const created = createPlotChecked({ name: feature.name ?? undefined, htxId, boundary: feature.points, source: options.source ?? 'import', minPoints: 3, confirmOverlap: true }, actor);
        outcome.created += 1; outcome.ids.push(created.id);
      }
    } catch (error) {
      outcome.errors.push({ index: index + 1, name: feature.name, reason: (error as Error).message });
    }
  });
  logEvent({ module: 'gis', entityType: target === 'htx' ? 'cooperatives' : target === 'hub' ? 'facilities' : 'plots', action: 'create', after: { import: target, ...outcome, ids: undefined }, note: 'bulk_geo_import' }, actor);
  return outcome;
}

/** Vẽ lại ranh giới HTX/Hub trực tiếp trên bản đồ (US-BND-02/03/05/06). */
export function setBoundary(table: 'cooperatives' | 'facilities', id: string, points: LatLng[] | null, marker: LatLng | null, actor: AuditActor = {}): void {
  const before = one<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!before) throw new Error('Không tìm thấy bản ghi.');
  const values: Record<string, unknown> = { updated_at: nowIso() };
  if (points && points.length >= 3) {
    values.boundary = JSON.stringify({ type: 'Polygon', coordinates: [[...points, points[0]].map((p) => [p.lng, p.lat])] });
    const c = centroid(points);
    values.lat = marker?.lat ?? c.lat; values.lng = marker?.lng ?? c.lng;
    if (table === 'cooperatives' && !before.registered_area_ha) values.registered_area_ha = Math.round(polygonAreaHectares(points) * 100) / 100;
  } else if (marker) {
    values.lat = marker.lat; values.lng = marker.lng;
  } else {
    throw new Error('Cần vẽ Polygon (≥ 3 điểm) hoặc gắn Marker vị trí.');
  }
  update(table, id, values);
  logEvent({ module: 'gis', entityType: table, entityId: id, action: 'update', before, after: values, note: 'boundary_edit' }, actor);
}

export function plotsDeletedAware(htxId?: string, includeDeleted = false): (Plot & { boundaryGeo: unknown })[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (htxId) { clauses.push('htx_id = ?'); params.push(htxId); }
  if (!includeDeleted) clauses.push('deleted_at IS NULL');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all<Plot>(`SELECT * FROM plots ${where} ORDER BY code LIMIT 2000`, params).map((row) => ({ ...row, boundaryGeo: parseJson(row.boundary, null) }));
}

export { getPlot };
