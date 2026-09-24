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
/** Hai đoạn thẳng cắt nhau (kể cả chạm) — kiểm bằng hướng quay, không cần thư viện. */
function orientation(a: LatLng, b: LatLng, c: LatLng): number {
  const v = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  return Math.abs(v) < 1e-14 ? 0 : v > 0 ? 1 : 2;
}
function onSegment(a: LatLng, b: LatLng, p: LatLng): boolean {
  return Math.min(a.lng, b.lng) - 1e-12 <= p.lng && p.lng <= Math.max(a.lng, b.lng) + 1e-12 && Math.min(a.lat, b.lat) - 1e-12 <= p.lat && p.lat <= Math.max(a.lat, b.lat) + 1e-12;
}
export function segmentsIntersect(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const o1 = orientation(a, b, c); const o2 = orientation(a, b, d); const o3 = orientation(c, d, a); const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}
/** Bỏ điểm đóng vòng trùng điểm đầu và điểm lặp liên tiếp. */
export function cleanRing(points: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lng - p.lng) < 1e-9) continue;
    out.push({ lat: Number(p.lat), lng: Number(p.lng) });
  }
  if (out.length > 1 && Math.abs(out[0].lat - out[out.length - 1].lat) < 1e-9 && Math.abs(out[0].lng - out[out.length - 1].lng) < 1e-9) out.pop();
  return out;
}
/** Đa giác tự cắt (hình nơ bướm): hai cạnh KHÔNG kề nhau giao nhau (UAT DEF-KN-PLOT-01). */
export function polygonSelfIntersects(ring: LatLng[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // cạnh kề
      if (segmentsIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}
/** Hai đa giác chồng nhau: đỉnh bên này nằm trong bên kia, tâm nằm trong, hoặc có cạnh giao nhau. */
export function polygonsOverlap(a: LatLng[], b: LatLng[]): { vertices: number; centroidInside: boolean; edgesCross: boolean } {
  const vertices = a.filter((p) => pointInPolygon(p, b)).length + b.filter((p) => pointInPolygon(p, a)).length;
  const centroidInside = pointInPolygon(centroid(a), b) || pointInPolygon(centroid(b), a);
  let edgesCross = false;
  outer: for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) { edgesCross = true; break outer; }
    }
  }
  return { vertices, centroidInside, edgesCross };
}

/**
 * Phát hiện thửa đã có mà ranh giới mới đè lên. Lọc thô bằng khung bao tính trực tiếp từ
 * ranh giới (không dựa vào cột centroid có thể trống), rồi kiểm đỉnh-trong-đa-giác, tâm và
 * GIAO CẠNH — bắt được cả trường hợp hai thửa cắt nhau mà không nuốt đỉnh nào (UAT DEF-KN-PLOT-02).
 */
export function findOverlaps(boundaryInput: LatLng[], excludePlotId?: string): OverlapHit[] {
  const boundary = cleanRing(boundaryInput);
  if (boundary.length < 3) return [];
  const box = { south: Math.min(...boundary.map((p) => p.lat)), north: Math.max(...boundary.map((p) => p.lat)), west: Math.min(...boundary.map((p) => p.lng)), east: Math.max(...boundary.map((p) => p.lng)) };
  const candidates = all<{ id: string; code: string; htx_id: string; farmer_id: string | null; boundary: string | null }>(
    'SELECT id, code, htx_id, farmer_id, boundary FROM plots WHERE deleted_at IS NULL AND boundary IS NOT NULL',
  );
  const hits: OverlapHit[] = [];
  for (const row of candidates) {
    if (row.id === excludePlotId) continue;
    const ring = cleanRing(ringOf(row.boundary));
    if (ring.length < 3) continue;
    const rb = { south: Math.min(...ring.map((p) => p.lat)), north: Math.max(...ring.map((p) => p.lat)), west: Math.min(...ring.map((p) => p.lng)), east: Math.max(...ring.map((p) => p.lng)) };
    if (rb.south > box.north || rb.north < box.south || rb.west > box.east || rb.east < box.west) continue;
    const test = polygonsOverlap(boundary, ring);
    if (test.vertices > 0 || test.centroidInside || test.edgesCross) {
      hits.push({ plotId: row.id, code: row.code, htxId: row.htx_id, farmerId: row.farmer_id, sharedVertices: test.vertices, centroidInside: test.centroidInside || test.edgesCross });
    }
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
  input.boundary = cleanRing(input.boundary);
  if (input.boundary.length < minimum) {
    throw new Error(`Cần tối thiểu ${minimum} điểm ranh giới KHÁC NHAU để khép vùng (điểm trùng/điểm đóng vòng không tính).`);
  }
  // Kiểm tự cắt TRƯỚC diện tích: hình nơ bướm đối xứng có diện tích shoelace = 0 nên sẽ bị báo nhầm là "thẳng hàng".
  if (polygonSelfIntersects(input.boundary)) {
    throw new Error('Ranh giới tự cắt nhau (các cạnh giao nhau như hình nơ bướm) — hãy nhấp các điểm theo đúng thứ tự đi vòng quanh thửa.');
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
  // UAT DEF-KN-HTX-01: còn vụ đang canh tác hoặc nhật ký chờ duyệt thì KHÔNG cho vô hiệu hoá — dữ liệu sản xuất sẽ treo vô chủ.
  if (impact.openCycles > 0 || impact.pendingLogs > 0) {
    throw new Error(`Không thể vô hiệu hoá HTX: còn ${impact.openCycles} vụ đang canh tác và ${impact.pendingLogs} nhật ký chờ duyệt. Hãy khai báo sản lượng để đóng vụ và duyệt hết nhật ký trước.`);
  }
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

export interface FeatureImportOutcome { created: number; updated: number; errors: { index: number; name: string | null; reason: string; needsConfirm?: boolean }[]; ids: string[] }

export function importFeatures(
  target: ImportTarget,
  features: ImportedFeature[],
  options: { htxId?: string; provinceId?: string; kind?: 'hub' | 'warehouse' | 'yard' | 'plant'; source?: string; confirmOverlap?: boolean } = {},
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
        // UAT DEF-HTX-01/02: thửa nạp từ tệp/toạ độ chịu cùng luật với thửa vẽ tay — ≥ 4 điểm và kiểm chồng lấn.
        const created = createPlotChecked({ name: feature.name ?? undefined, htxId, boundary: feature.points, source: options.source ?? 'import', confirmOverlap: options.confirmOverlap === true }, actor);
        outcome.created += 1; outcome.ids.push(created.id);
      }
    } catch (error) {
      outcome.errors.push({ index: index + 1, name: feature.name, reason: (error as Error).message, needsConfirm: (error as Error & { needsConfirm?: boolean }).needsConfirm || undefined });
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
