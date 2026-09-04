/**
 * Master Data & Configuration Hub.
 *
 * "Một Master Data, nhiều phân hệ dùng chung" — danh mục HTX, nông hộ, thửa
 * ruộng, Hub/Kho/Nhà máy, thiết bị, đối tác nằm ở đây; mọi phân hệ đọc từ nguồn
 * này, không nhân bản (AgriGreen ERP Product Vision v1.2, nguyên tắc 2).
 */
import { all, insert, one, run, transaction, update, parseJson } from '../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../platform/audit/audit.ts';
import { centroid, haversineKm, polygonAreaHectares, type LatLng } from '../platform/geo/geo.ts';

// ---------------------------------------------------------------------------
// Hợp tác xã
// ---------------------------------------------------------------------------

export interface Cooperative {
  id: string;
  code: string;
  name: string;
  province_id: string | null;
  commune_id: string | null;
  address: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  lat: number | null;
  lng: number | null;
  registered_area_ha: number;
  member_count: number;
  status: string;
}

/** Mã HTX do HỆ THỐNG TỰ SINH, không nhập tay, không sửa được (CGH BR-01). */
function nextSequence(table: string, prefix: string, width = 5): string {
  const row = one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return sequenceCode(prefix, (row?.n ?? 0) + 1, width);
}

export function createCooperative(
  input: {
    name: string; provinceId?: string; communeId?: string; address?: string;
    contactName?: string; contactPhone?: string; lat?: number; lng?: number;
    boundary?: LatLng[]; registeredAreaHa?: number; memberCount?: number;
  },
  actor: AuditActor = {},
): Cooperative {
  const record = {
    id: uuid(),
    code: nextSequence('cooperatives', 'HTX'),
    name: input.name,
    province_id: input.provinceId ?? null,
    commune_id: input.communeId ?? null,
    address: input.address ?? null,
    contact_name: input.contactName ?? null,
    contact_phone: input.contactPhone ?? null,
    lat: input.lat ?? (input.boundary ? centroid(input.boundary).lat : null),
    lng: input.lng ?? (input.boundary ? centroid(input.boundary).lng : null),
    boundary: input.boundary ? JSON.stringify(toPolygon(input.boundary)) : null,
    registered_area_ha: input.registeredAreaHa ?? (input.boundary ? polygonAreaHectares(input.boundary) : 0),
    member_count: input.memberCount ?? 0,
    status: 'active',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('cooperatives', record);
  logEvent({ module: 'mdm', entityType: 'cooperatives', entityId: record.id, action: 'create', after: record }, actor);
  return getCooperative(record.id)!;
}

export function getCooperative(id: string): Cooperative | null {
  return one<Cooperative>('SELECT * FROM cooperatives WHERE id = ?', [id]);
}

export function listCooperatives(filter: { provinceId?: string; search?: string } = {}): Cooperative[] {
  const clauses = ["status = 'active'"];
  const params: unknown[] = [];
  if (filter.provinceId) {
    clauses.push('province_id = ?');
    params.push(filter.provinceId);
  }
  if (filter.search) {
    clauses.push('(name LIKE ? OR code LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }
  return all<Cooperative>(`SELECT * FROM cooperatives WHERE ${clauses.join(' AND ')} ORDER BY code`, params);
}

export function updateCooperative(id: string, patch: Record<string, unknown>, actor: AuditActor = {}): Cooperative {
  const before = getCooperative(id);
  if (!before) throw new Error('Không tìm thấy HTX');
  const values: Record<string, unknown> = { updated_at: nowIso() };
  for (const key of ['name', 'province_id', 'commune_id', 'address', 'contact_name', 'contact_phone', 'lat', 'lng', 'registered_area_ha', 'member_count']) {
    if (patch[key] !== undefined) values[key] = patch[key];
  }
  if (patch.boundary) {
    const boundary = patch.boundary as LatLng[];
    values.boundary = JSON.stringify(toPolygon(boundary));
    values.lat = centroid(boundary).lat;
    values.lng = centroid(boundary).lng;
  }
  update('cooperatives', id, values);
  const after = getCooperative(id)!;
  logEvent({ module: 'mdm', entityType: 'cooperatives', entityId: id, action: 'update', before, after }, actor);
  return after;
}

/** App HTX FN-15: vô hiệu hoá / kích hoạt lại HTX (xoá mềm, giữ lịch sử). */
export function setCooperativeStatus(id: string, status: 'active' | 'inactive', actor: AuditActor = {}): void {
  const before = getCooperative(id);
  update('cooperatives', id, { status, updated_at: nowIso() });
  logEvent({ module: 'mdm', entityType: 'cooperatives', entityId: id, action: 'update', before, after: { status } }, actor);
}

// ---------------------------------------------------------------------------
// Nông hộ
// ---------------------------------------------------------------------------

export function createFarmer(
  input: { fullName: string; htxId: string; phone?: string; nationalId?: string; address?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const record = {
    id: uuid(),
    code: nextSequence('farmers', 'NH'),
    full_name: input.fullName,
    phone: input.phone ?? null,
    national_id: input.nationalId ?? null,
    htx_id: input.htxId,
    address: input.address ?? null,
    reliability_score: 0,
    status: 'active',
    created_at: nowIso(),
  };
  insert('farmers', record);
  // Cập nhật số thành viên trên hồ sơ HTX (dữ liệu dùng chung, không nhân bản).
  run('UPDATE cooperatives SET member_count = (SELECT COUNT(*) FROM farmers WHERE htx_id = ?) WHERE id = ?', [input.htxId, input.htxId]);
  logEvent({ module: 'mdm', entityType: 'farmers', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function listFarmers(htxId?: string): Record<string, unknown>[] {
  return htxId
    ? all('SELECT * FROM farmers WHERE htx_id = ? ORDER BY full_name', [htxId])
    : all('SELECT * FROM farmers ORDER BY full_name LIMIT 500');
}

// ---------------------------------------------------------------------------
// Thửa ruộng — vẽ ranh giới, hệ thống TỰ TÍNH diện tích
// (App Khuyến nông FN-05, App HTX FN-07, GIS FN-04)
// ---------------------------------------------------------------------------

export interface Plot {
  id: string;
  code: string;
  name: string | null;
  htx_id: string;
  farmer_id: string | null;
  boundary: string | null;
  area_ha: number;
  centroid_lat: number | null;
  centroid_lng: number | null;
  status: string;
  source: string;
}

export function createPlot(
  input: { name?: string; htxId: string; farmerId?: string; boundary: LatLng[]; soilType?: string; source?: string },
  actor: AuditActor = {},
): Plot & { areaLabel: string } {
  if (!input.boundary || input.boundary.length < 3) {
    throw new Error('Ranh giới thửa ruộng phải có tối thiểu 3 đỉnh.');
  }
  const areaHa = polygonAreaHectares(input.boundary);
  const middle = centroid(input.boundary);
  const record = {
    id: uuid(),
    code: nextSequence('plots', 'LR'),
    name: input.name ?? null,
    htx_id: input.htxId,
    farmer_id: input.farmerId ?? null,
    boundary: JSON.stringify(toPolygon(input.boundary)),
    // Diện tích là trường HỆ THỐNG TÍNH từ polygon, không nhận từ người dùng.
    area_ha: Math.round(areaHa * 10_000) / 10_000,
    centroid_lat: middle.lat,
    centroid_lng: middle.lng,
    soil_type: input.soilType ?? null,
    status: 'chua_mo_vu',
    source: input.source ?? 'app_htx',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('plots', record);
  logEvent({ module: 'mdm', entityType: 'plots', entityId: record.id, action: 'create', after: record }, actor);
  return { ...(getPlot(record.id)!), areaLabel: `${record.area_ha.toFixed(4)} ha` };
}

/**
 * Vẽ lại đường bao của một thửa đã có — diện tích được TÍNH LẠI từ polygon mới.
 *
 * Ranh giới vẽ vội trên điện thoại ngoài đồng thường phải chỉnh lại; nếu chỉ tạo
 * được mà không sửa được, người dùng sẽ tạo thửa trùng lặp. Đổi ranh giới của
 * thửa đang canh tác là thay đổi có hệ quả (diện tích vào thẳng thống kê sản
 * lượng và bài toán cơ giới hoá) nên hàm trả về mức chênh lệch để giao diện nói
 * rõ cho người dùng.
 */
export function updatePlotBoundary(
  plotId: string,
  boundary: LatLng[],
  actor: AuditActor = {},
): Plot & { areaLabel: string; previousAreaHa: number; deltaHa: number; deltaPct: number; warnings: string[] } {
  const before = getPlot(plotId);
  if (!before) throw new Error('Không tìm thấy thửa ruộng.');
  if (!boundary || boundary.length < 3) {
    throw new Error('Ranh giới thửa ruộng phải có tối thiểu 3 đỉnh.');
  }

  const areaHa = Math.round(polygonAreaHectares(boundary) * 10_000) / 10_000;
  if (!(areaHa > 0)) {
    throw new Error('Đường bao không hợp lệ — diện tích tính ra bằng 0. Kiểm tra lại thứ tự các đỉnh.');
  }
  const middle = centroid(boundary);
  const previousAreaHa = Number(before.area_ha ?? 0);
  const deltaHa = Math.round((areaHa - previousAreaHa) * 10_000) / 10_000;
  const deltaPct = previousAreaHa > 0 ? Math.round((deltaHa / previousAreaHa) * 1000) / 10 : 0;

  const warnings: string[] = [];
  if (before.status === 'dang_canh_tac' && Math.abs(deltaPct) >= 5) {
    warnings.push(
      `Thửa đang canh tác và diện tích đổi ${deltaPct > 0 ? 'tăng' : 'giảm'} ${Math.abs(deltaPct)}% ` +
      `(${previousAreaHa} → ${areaHa} ha). Diện tích này đi thẳng vào thống kê sản lượng và bài toán ` +
      'cân đối cơ giới hoá — hãy chắc chắn đây là hiệu chỉnh đúng chứ không phải vẽ nhầm.',
    );
  }

  update('plots', plotId, {
    boundary: JSON.stringify(toPolygon(boundary)),
    area_ha: areaHa,
    centroid_lat: middle.lat,
    centroid_lng: middle.lng,
    updated_at: nowIso(),
  });
  const after = getPlot(plotId)!;
  logEvent({ module: 'mdm', entityType: 'plots', entityId: plotId, action: 'update', before, after }, actor);
  return {
    ...after,
    areaLabel: `${areaHa.toFixed(4)} ha`,
    previousAreaHa,
    deltaHa,
    deltaPct,
    warnings,
  };
}

/** Gán thửa ruộng cho một HTX và/hoặc một thành viên. */
export function assignPlot(
  plotId: string,
  input: { htxId?: string; farmerId?: string | null; name?: string; soilType?: string },
  actor: AuditActor = {},
): Plot {
  const before = getPlot(plotId);
  if (!before) throw new Error('Không tìm thấy thửa ruộng.');

  const values: Record<string, unknown> = { updated_at: nowIso() };
  if (input.htxId) {
    const htx = one<{ id: string }>('SELECT id FROM cooperatives WHERE id = ?', [input.htxId]);
    if (!htx) throw new Error('Không tìm thấy hợp tác xã.');
    values.htx_id = input.htxId;
  }
  if (input.farmerId !== undefined) {
    if (input.farmerId) {
      const farmer = one<{ id: string; htx_id: string; full_name: string }>(
        'SELECT id, htx_id, full_name FROM farmers WHERE id = ?', [input.farmerId],
      );
      if (!farmer) throw new Error('Không tìm thấy thành viên.');
      const targetHtx = (values.htx_id as string) ?? before.htx_id;
      if (farmer.htx_id !== targetHtx) {
        throw new Error(`Thành viên "${farmer.full_name}" không thuộc HTX quản lý thửa ruộng này.`);
      }
    }
    values.farmer_id = input.farmerId;
  }
  if (input.name !== undefined) values.name = input.name;
  if (input.soilType !== undefined) values.soil_type = input.soilType;

  update('plots', plotId, values);
  const after = getPlot(plotId)!;
  logEvent({ module: 'mdm', entityType: 'plots', entityId: plotId, action: 'update', before, after }, actor);
  return after;
}

export function getPlot(id: string): Plot | null {
  return one<Plot>('SELECT * FROM plots WHERE id = ?', [id]);
}

export function listPlots(htxId?: string): (Plot & { boundaryGeo: unknown })[] {
  const rows = htxId
    ? all<Plot>('SELECT * FROM plots WHERE htx_id = ? ORDER BY code', [htxId])
    : all<Plot>('SELECT * FROM plots ORDER BY code LIMIT 1000');
  return rows.map((row) => ({ ...row, boundaryGeo: parseJson(row.boundary, null) }));
}

// ---------------------------------------------------------------------------
// Cơ sở vận hành: Hub / Kho / Bãi / Nhà máy (multi-site)
// ---------------------------------------------------------------------------

export function createFacility(
  input: { name: string; kind: 'hub' | 'warehouse' | 'yard' | 'plant'; lat: number; lng: number; capacityTons?: number; annualDemandTons?: number; provinceId?: string; code?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const record = {
    id: uuid(),
    code: input.code ?? nextSequence('facilities', input.kind === 'plant' ? 'NM' : 'KHO', 4),
    name: input.name,
    kind: input.kind,
    lat: input.lat,
    lng: input.lng,
    province_id: input.provinceId ?? null,
    capacity_tons: input.capacityTons ?? 0,
    current_stock_tons: 0,
    annual_demand_tons: input.annualDemandTons ?? 0,
    status: 'active',
    origin_scenario_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('facilities', record);
  logEvent({ module: 'mdm', entityType: 'facilities', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export interface FacilityPatch {
  name?: string;
  lat?: number;
  lng?: number;
  capacityTons?: number;
  annualDemandTons?: number;
  provinceId?: string | null;
  status?: string;
}

export interface FacilityUpdateResult {
  facility: Record<string, unknown>;
  /** Khoảng cách đã dịch chuyển so với vị trí cũ (km). */
  movedKm: number;
  /**
   * Kịch bản mô phỏng đã dùng cơ sở này và trở nên LỖI THỜI vì khoảng cách
   * Hub→Nhà máy / Ruộng→Nhà máy đã thay đổi — cần chạy lại (FN-04 BR-05).
   */
  staleScenarios: { id: string; code: string; name: string }[];
  clearedDistanceCache: number;
}

/**
 * Cập nhật thông tin cơ sở vận hành, gồm cả TOẠ ĐỘ.
 *
 * Khi toạ độ đổi, mọi khoảng cách đã cache theo cặp toạ độ cũ trở nên vô dụng
 * và mọi kết quả mô phỏng có tham chiếu cơ sở này không còn đúng. Hàm này dọn
 * cache và trả về danh sách kịch bản cần chạy lại thay vì âm thầm để số cũ.
 */
export function updateFacility(
  id: string,
  patch: FacilityPatch,
  actor: AuditActor = {},
): FacilityUpdateResult {
  const before = one<{
    id: string; code: string; name: string; kind: string; lat: number; lng: number;
    capacity_tons: number; annual_demand_tons: number; province_id: string | null; status: string;
  }>('SELECT * FROM facilities WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy cơ sở vận hành');

  if (patch.lat !== undefined && (!Number.isFinite(patch.lat) || Math.abs(patch.lat) > 90)) {
    throw new Error('Vĩ độ không hợp lệ (phải trong khoảng −90…90).');
  }
  if (patch.lng !== undefined && (!Number.isFinite(patch.lng) || Math.abs(patch.lng) > 180)) {
    throw new Error('Kinh độ không hợp lệ (phải trong khoảng −180…180).');
  }
  if (patch.capacityTons !== undefined && patch.capacityTons < 0) {
    throw new Error('Sức chứa không được âm.');
  }
  if (patch.annualDemandTons !== undefined && patch.annualDemandTons < 0) {
    throw new Error('Nhu cầu hàng năm không được âm.');
  }

  const values: Record<string, unknown> = { updated_at: nowIso() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.lat !== undefined) values.lat = patch.lat;
  if (patch.lng !== undefined) values.lng = patch.lng;
  if (patch.capacityTons !== undefined) values.capacity_tons = patch.capacityTons;
  if (patch.annualDemandTons !== undefined) values.annual_demand_tons = patch.annualDemandTons;
  if (patch.provinceId !== undefined) values.province_id = patch.provinceId;
  if (patch.status !== undefined) values.status = patch.status;

  const newLat = patch.lat ?? before.lat;
  const newLng = patch.lng ?? before.lng;
  const movedKm = haversineKm({ lat: before.lat, lng: before.lng }, { lat: newLat, lng: newLng });
  const moved = movedKm > 0.001;

  let clearedDistanceCache = 0;
  transaction(() => {
    update('facilities', id, values);
    if (moved) {
      // Cache khoảng cách khoá theo cặp toạ độ — các bản ghi dùng toạ độ cũ
      // không bao giờ được dùng lại nữa, xoá để không phình dữ liệu.
      const stale = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM distance_cache
         WHERE (ABS(from_lat - ?) < 0.000001 AND ABS(from_lng - ?) < 0.000001)
            OR (ABS(to_lat - ?) < 0.000001 AND ABS(to_lng - ?) < 0.000001)`,
        [before.lat, before.lng, before.lat, before.lng],
      );
      clearedDistanceCache = stale?.n ?? 0;
      run(
        `DELETE FROM distance_cache
         WHERE (ABS(from_lat - ?) < 0.000001 AND ABS(from_lng - ?) < 0.000001)
            OR (ABS(to_lat - ?) < 0.000001 AND ABS(to_lng - ?) < 0.000001)`,
        [before.lat, before.lng, before.lat, before.lng],
      );
    }
  });

  const after = one<Record<string, unknown>>('SELECT * FROM facilities WHERE id = ?', [id])!;
  logEvent(
    {
      module: 'mdm',
      entityType: 'facilities',
      entityId: id,
      action: 'update',
      before,
      after,
      note: moved
        ? `Dịch chuyển vị trí ${movedKm.toFixed(3)} km: (${before.lat}, ${before.lng}) → (${newLat}, ${newLng})`
        : undefined,
    },
    actor,
  );

  // Kịch bản dùng cơ sở này làm nhà máy đầu ra, hoặc Hub sinh ra từ kịch bản.
  const staleScenarios = moved
    ? all<{ id: string; code: string; name: string }>(
        `SELECT DISTINCT s.id, s.code, s.name FROM scenarios s
         WHERE s.simulated_at IS NOT NULL
           AND (s.plant_id = ? OR s.id = (SELECT origin_scenario_id FROM facilities WHERE id = ?))`,
        [id, id],
      )
    : [];

  return {
    facility: after,
    movedKm: Math.round(movedKm * 1000) / 1000,
    staleScenarios,
    clearedDistanceCache,
  };
}

export function listFacilities(kind?: string): Record<string, unknown>[] {
  return kind
    ? all('SELECT * FROM facilities WHERE kind = ? ORDER BY code', [kind])
    : all('SELECT * FROM facilities ORDER BY kind, code');
}

export function listStorageZones(facilityId: string): Record<string, unknown>[] {
  return all('SELECT * FROM storage_zones WHERE facility_id = ? ORDER BY code', [facilityId]);
}

// ---------------------------------------------------------------------------
// Mùa vụ & thống kê sản lượng
// ---------------------------------------------------------------------------

export function listSeasons(): Record<string, unknown>[] {
  return all('SELECT * FROM seasons ORDER BY year DESC, sort_order');
}

export function upsertHarvestStatistic(
  input: { htxId: string; seasonId: string; paddyTons: number; plantedAreaHa?: number; source?: string },
  actor: AuditActor = {},
): void {
  const existing = one<{ id: string }>(
    'SELECT id FROM harvest_statistics WHERE htx_id = ? AND season_id = ?',
    [input.htxId, input.seasonId],
  );
  const record = {
    id: existing?.id ?? uuid(),
    htx_id: input.htxId,
    season_id: input.seasonId,
    planted_area_ha: input.plantedAreaHa ?? 0,
    paddy_tons: input.paddyTons,
    source: input.source ?? 'gso',
    recorded_at: nowIso(),
  };
  transaction(() => {
    if (existing) run('DELETE FROM harvest_statistics WHERE id = ?', [existing.id]);
    insert('harvest_statistics', record);
  });
  logEvent({ module: 'mdm', entityType: 'harvest_statistics', entityId: record.id, action: existing ? 'update' : 'create', after: record }, actor);
}

export function listHarvestStatistics(htxId?: string): Record<string, unknown>[] {
  const sql = `SELECT hs.*, c.code AS htx_code, c.name AS htx_name, s.name AS season_name, s.year
               FROM harvest_statistics hs
               JOIN cooperatives c ON c.id = hs.htx_id
               JOIN seasons s ON s.id = hs.season_id`;
  return htxId
    ? all(`${sql} WHERE hs.htx_id = ? ORDER BY s.sort_order`, [htxId])
    : all(`${sql} ORDER BY c.code, s.sort_order`);
}

// ---------------------------------------------------------------------------
// Danh mục hành chính & đối tác
// ---------------------------------------------------------------------------

export function listAdminUnits(level?: string): Record<string, unknown>[] {
  return level
    ? all('SELECT * FROM admin_units WHERE level = ? ORDER BY name', [level])
    : all('SELECT * FROM admin_units ORDER BY level, name');
}

export function listPartners(kind?: string): Record<string, unknown>[] {
  return kind
    ? all('SELECT * FROM partners WHERE kind = ? ORDER BY name', [kind])
    : all('SELECT * FROM partners ORDER BY kind, name');
}

export function listItems(): Record<string, unknown>[] {
  return all('SELECT * FROM items ORDER BY code');
}

/** Bảng tổng hợp Master Data cho màn hình quản trị dùng chung. */
export function masterDataSummary(): Record<string, unknown> {
  const count = (table: string, where = '') =>
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} ${where}`)?.n ?? 0;
  return {
    cooperatives: count('cooperatives', "WHERE status = 'active'"),
    farmers: count('farmers'),
    plots: count('plots'),
    plotAreaHa: one<{ s: number }>('SELECT COALESCE(SUM(area_ha), 0) AS s FROM plots')?.s ?? 0,
    facilities: {
      hub: count('facilities', "WHERE kind = 'hub'"),
      warehouse: count('facilities', "WHERE kind = 'warehouse'"),
      plant: count('facilities', "WHERE kind = 'plant'"),
    },
    machines: count('machines'),
    machineOwners: count('machine_owners'),
    partners: count('partners'),
    seasons: count('seasons'),
    harvestStatistics: count('harvest_statistics'),
    routes: {
      road: count('transport_routes', "WHERE mode = 'road'"),
      waterway: count('transport_routes', "WHERE mode = 'waterway'"),
      confirmed: count('transport_routes', "WHERE status = 'da_xac_nhan'"),
    },
  };
}

function toPolygon(points: LatLng[]): { type: 'Polygon'; coordinates: [number, number][][] } {
  const ring = points.map((p) => [p.lng, p.lat] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return { type: 'Polygon', coordinates: [ring] };
}
