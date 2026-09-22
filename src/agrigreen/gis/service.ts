/**
 * Nền tảng bản đồ số GIS dùng chung — BRD Mekong Green GIS v1.2.
 *
 * FN-06 ranh giới đa cấp & polygon lô/thửa · FN-09 điều kiện tự nhiên
 * FN-10/FN-11 thời tiết & cảnh báo · FN-12 heatmap mùa vụ · FN-13 cảnh báo sản lượng
 * FN-14 widget dung lượng Hub · FN-15 tiếp nhận dữ liệu · FN-16 cấp bản đồ chuẩn hoá
 */
import { all, one, parseJson, upsert } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { runSync, type SyncSystem } from '../../platform/sync/sync.ts';
import { boundsOf, type LatLng } from '../../platform/geo/geo.ts';
import { listRoutes } from './waterways.ts';

// ---------------------------------------------------------------------------
// Cấu hình hiển thị dùng chung (FN-02)
// ---------------------------------------------------------------------------

/** FN-12 BR-36: bảng màu heatmap trạng thái mùa vụ (nâu → xanh → vàng → đỏ → xám). */
export const DEFAULT_CROP_PALETTE: Record<string, { color: string; label: string }> = {
  lam_dat: { color: '#8B5E3C', label: 'Làm đất' },
  gieo_sa: { color: '#7AAE68', label: 'Gieo sạ' },
  sinh_truong: { color: '#3E7A3A', label: 'Sinh trưởng' },
  chin: { color: '#D9A441', label: 'Chín' },
  thu_hoach: { color: '#C0392B', label: 'Thu hoạch' },
  sau_thu_hoach: { color: '#9AA5A0', label: 'Sau thu hoạch' },
};

/** FN-14: ngưỡng màu widget dung lượng kho/Hub. */
export const DEFAULT_CAPACITY_THRESHOLDS = [
  { maxPct: 60, color: '#1F7A38', label: 'Còn nhiều chỗ' },
  { maxPct: 85, color: '#9C6414', label: 'Sắp đầy' },
  { maxPct: 101, color: '#A3372A', label: 'Gần đầy / đầy' },
];

/** Dải tỷ lệ zoom theo ràng buộc BRD: 1:1.000.000 → 1:500. */
export const ZOOM_BANDS = [
  { code: 'xa', label: 'Zoom xa (1:1.000.000 → 1:250.000)', minZoom: 5, maxZoom: 8, cluster: 'province' },
  { code: 'trung_binh', label: 'Zoom trung bình (1:100.000 → 1:25.000)', minZoom: 9, maxZoom: 12, cluster: 'commune' },
  { code: 'can_canh', label: 'Zoom cận cảnh (1:10.000 → 1:500)', minZoom: 13, maxZoom: 20, cluster: 'plot' },
];

export function getConfig<T>(key: string, fallback: T): T {
  const row = one<{ value_json: string }>('SELECT value_json FROM system_config WHERE key = ?', [key]);
  return row ? parseJson<T>(row.value_json, fallback) : fallback;
}

export function setConfig(key: string, value: unknown, actor: AuditActor = {}): void {
  const before = getConfig(key, null);
  upsert('system_config', {
    key,
    value_json: JSON.stringify(value),
    updated_at: nowIso(),
    updated_by: actor.name ?? null,
  });
  // FN-02 BR-05: soft delete & versioning — mọi thay đổi cấu hình lưu vết đầy đủ.
  logEvent({ module: 'gis', entityType: 'system_config', entityId: key, action: 'update', before, after: value }, actor);
}

export function cropPalette(): Record<string, { color: string; label: string }> {
  return getConfig('gis.crop_palette', DEFAULT_CROP_PALETTE);
}

export function capacityThresholds(): typeof DEFAULT_CAPACITY_THRESHOLDS {
  return getConfig('gis.capacity_thresholds', DEFAULT_CAPACITY_THRESHOLDS);
}

// ---------------------------------------------------------------------------
// FN-06 / FN-14 — Các lớp dữ liệu bản đồ
// ---------------------------------------------------------------------------

export interface MapBundle {
  generatedAt: string;
  zoomBands: typeof ZOOM_BANDS;
  layers: Record<string, unknown>;
  legend: Record<string, unknown>;
  bounds: { south: number; west: number; north: number; east: number } | null;
}

export interface MapQuery {
  /** Bật/tắt độc lập từng lớp (UX-04). */
  layers?: string[];
  /** Tải động theo viewport khi zoom sâu (FN-06). */
  bbox?: { south: number; west: number; north: number; east: number };
  zoom?: number;
  date?: string;
}

const ALL_LAYERS = [
  'admin_boundaries', 'cooperatives', 'plots', 'facilities',
  'roads', 'waterways', 'crop_heatmap', 'weather', 'capacity_widgets',
  'machinery', 'candidate_hubs', 'crop_calendar',
];

export function buildMapBundle(query: MapQuery = {}): MapBundle {
  const wanted = new Set(query.layers?.length ? query.layers : ALL_LAYERS);
  const layers: Record<string, unknown> = {};
  const points: LatLng[] = [];

  if (wanted.has('admin_boundaries')) {
    layers.admin_boundaries = all(
      'SELECT id, code, name, level, parent_id, boundary, centroid_lat, centroid_lng FROM admin_units ORDER BY level, name',
    ).map((row) => ({ ...row, boundary: parseJson((row as any).boundary, null) }));
  }

  if (wanted.has('cooperatives')) {
    const rows = all<{ id: string; code: string; name: string; lat: number; lng: number; member_count: number; boundary: string | null; registered_area_ha: number }>(
      "SELECT id, code, name, lat, lng, member_count, boundary, registered_area_ha FROM cooperatives WHERE status = 'active' AND lat IS NOT NULL",
    );
    layers.cooperatives = rows.map((row) => ({ ...row, boundary: parseJson(row.boundary, null) }));
    points.push(...rows.map((row) => ({ lat: row.lat, lng: row.lng })));
  }

  // FN-06: polygon lô/thửa chỉ tải khi zoom sâu và trong viewport hiện tại.
  if (wanted.has('plots') && (query.zoom ?? 0) >= 13) {
    const rows = plotsInViewport(query.bbox);
    layers.plots = rows;
  } else if (wanted.has('plots')) {
    layers.plots = [];
    layers.plotsNotice = 'Polygon lô/thửa chỉ hiển thị từ mức zoom cận cảnh (≥ 13).';
  }

  if (wanted.has('facilities')) {
    const rows = all<{ id: string; code: string; name: string; kind: string; lat: number; lng: number; capacity_tons: number; current_stock_tons: number }>(
      'SELECT id, code, name, kind, lat, lng, capacity_tons, current_stock_tons FROM facilities WHERE deleted_at IS NULL',
    );
    layers.facilities = rows;
    points.push(...rows.map((row) => ({ lat: row.lat, lng: row.lng })));
  }

  if (wanted.has('candidate_hubs')) {
    layers.candidate_hubs = all('SELECT id, code, name, lat, lng, status FROM candidate_hubs');
  }

  if (wanted.has('roads')) {
    layers.roads = listRoutes({ mode: 'road' }).map(routeFeature);
  }
  if (wanted.has('waterways')) {
    layers.waterways = listRoutes({ mode: 'waterway' }).map(routeFeature);
  }
  if (wanted.has('crop_heatmap')) {
    layers.crop_heatmap = cropHeatmap();
  }
  if (wanted.has('weather')) {
    layers.weather = weatherLayer(query.date);
  }
  if (wanted.has('capacity_widgets')) {
    layers.capacity_widgets = capacityWidgets();
  }
  if (wanted.has('machinery')) {
    layers.machinery = machineryLayer();
  }
  if (wanted.has('crop_calendar')) {
    layers.crop_calendar = cropCalendarLayer();
  }

  return {
    generatedAt: nowIso(),
    zoomBands: ZOOM_BANDS,
    layers,
    legend: {
      cropPalette: cropPalette(),
      capacityThresholds: capacityThresholds(),
    },
    bounds: boundsOf(points),
  };
}

function routeFeature(route: Record<string, unknown>) {
  return {
    id: route.id,
    code: route.code,
    name: route.name,
    mode: route.mode,
    status: route.status,
    dataSource: route.data_source,
    lengthM: route.length_m,
    lengthLabel: route.lengthLabel,
    maxLoadTons: route.max_load_tons,
    widthM: route.width_m,
    depthM: route.depth_m,
    clearanceM: route.clearance_m,
    geometry: parseJson(route.geometry, null),
  };
}

function plotsInViewport(bbox?: MapQuery['bbox']) {
  if (!bbox) {
    return all(
      'SELECT id, code, name, htx_id, area_ha, boundary, status FROM plots WHERE deleted_at IS NULL LIMIT 1000',
    ).map((row) => ({ ...row, boundary: parseJson((row as any).boundary, null) }));
  }
  // BR-25: tối đa 1.000 polygon/viewport.
  return all(
    `SELECT id, code, name, htx_id, area_ha, boundary, status FROM plots
     WHERE deleted_at IS NULL AND centroid_lat BETWEEN ? AND ? AND centroid_lng BETWEEN ? AND ? LIMIT 1000`,
    [bbox.south, bbox.north, bbox.west, bbox.east],
  ).map((row) => ({ ...row, boundary: parseJson((row as any).boundary, null) }));
}

/** FN-12 — bản đồ nhiệt trạng thái mùa vụ: đổi màu polygon vùng HTX theo giai đoạn. */
export function cropHeatmap(): Record<string, unknown>[] {
  const palette = cropPalette();
  const rows = all<{
    htx_id: string; code: string; name: string; lat: number; lng: number; boundary: string | null;
    stage: string; expected_harvest_date: string | null; expected_yield_tons: number; straw_tons: number;
    season_name: string;
  }>(
    `SELECT cs.htx_id, c.code, c.name, c.lat, c.lng, c.boundary,
            cs.stage, cs.expected_harvest_date, cs.expected_yield_tons, cs.straw_tons, s.name AS season_name
     FROM crop_status cs
     JOIN cooperatives c ON c.id = cs.htx_id
     JOIN seasons s ON s.id = cs.season_id`,
  );
  return rows.map((row) => ({
    htxId: row.htx_id,
    code: row.code,
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    boundary: parseJson(row.boundary, null),
    stage: row.stage,
    stageLabel: palette[row.stage]?.label ?? row.stage,
    color: palette[row.stage]?.color ?? '#9AA5A0',
    season: row.season_name,
    expectedHarvestDate: row.expected_harvest_date,
    expectedYieldTons: row.expected_yield_tons,
    strawTons: row.straw_tons,
  }));
}

/**
 * FN-13 — Cảnh báo sản lượng dự kiến thu hoạch: làm nổi bật vùng chín rộ trong
 * 1–3 ngày tới để chuẩn bị kho/logistics.
 */
export function harvestAlerts(horizonDays = 3): Record<string, unknown>[] {
  const today = new Date();
  const limit = new Date(today.getTime() + horizonDays * 86_400_000).toISOString().slice(0, 10);
  const rows = all<{
    code: string; name: string; lat: number; lng: number;
    expected_harvest_date: string; expected_yield_tons: number; straw_tons: number; season_name: string;
  }>(
    `SELECT c.code, c.name, c.lat, c.lng, cs.expected_harvest_date, cs.expected_yield_tons, cs.straw_tons, s.name AS season_name
     FROM crop_status cs JOIN cooperatives c ON c.id = cs.htx_id JOIN seasons s ON s.id = cs.season_id
     WHERE cs.expected_harvest_date IS NOT NULL
       AND cs.expected_harvest_date >= ? AND cs.expected_harvest_date <= ?
     ORDER BY cs.expected_harvest_date`,
    [today.toISOString().slice(0, 10), limit],
  );
  return rows.map((row) => ({
    ...row,
    daysUntilHarvest: Math.max(
      0,
      Math.round((new Date(row.expected_harvest_date).getTime() - today.getTime()) / 86_400_000),
    ),
    severity: row.straw_tons > 5_000 ? 'cao' : row.straw_tons > 1_500 ? 'trung_binh' : 'thap',
  }));
}

/** FN-14 — widget dung lượng Hub/kho trên marker (màu + % cụ thể). */
export function capacityWidgets(): Record<string, unknown>[] {
  const thresholds = capacityThresholds();
  return all<{ id: string; code: string; name: string; kind: string; lat: number; lng: number; capacity_tons: number; current_stock_tons: number }>(
    "SELECT id, code, name, kind, lat, lng, capacity_tons, current_stock_tons FROM facilities WHERE kind IN ('hub','warehouse','yard') AND deleted_at IS NULL",
  ).map((row) => {
    const pct = row.capacity_tons > 0 ? (row.current_stock_tons / row.capacity_tons) * 100 : 0;
    const band = thresholds.find((t) => pct < t.maxPct) ?? thresholds[thresholds.length - 1];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      lat: row.lat,
      lng: row.lng,
      capacityTons: row.capacity_tons,
      currentStockTons: row.current_stock_tons,
      freeTons: Math.max(0, row.capacity_tons - row.current_stock_tons),
      fillPct: Math.round(pct * 10) / 10,
      color: band.color,
      label: band.label,
    };
  });
}

/** Lớp cơ giới hoá: số máy theo khâu sản xuất trên từng HTX (nhận từ Bản đồ CGH). */
export function machineryLayer(): Record<string, unknown>[] {
  return all(
    `SELECT c.id AS htx_id, c.code, c.name, c.lat, c.lng, mt.stage,
            COUNT(m.id) AS machine_count,
            SUM(CASE WHEN m.condition = 'hoat_dong' THEN 1 ELSE 0 END) AS operational_count
     FROM machines m
     JOIN machine_types mt ON mt.id = m.machine_type_id
     JOIN cooperatives c ON c.id = m.htx_id
     WHERE c.lat IS NOT NULL
     GROUP BY c.id, mt.stage`,
  );
}

/**
 * Lịch thời vụ theo đơn vị hành chính — dữ liệu nhập từ file điều tra Excel.
 * Cho phép nhìn thấy vùng nào xuống giống/thu hoạch cùng thời điểm để bố trí
 * máy gặt, kho bãi và lịch thu gom rơm.
 */
export function cropCalendarLayer(): Record<string, unknown>[] {
  return all(
    `SELECT ccs.id, ccs.commune, ccs.district, ccs.province_name, ccs.area_ha,
            ccs.sowing_date, ccs.sowing_date_source, ccs.harvest_date,
            ccs.yield_dry_tons_per_ha, ccs.output_tons, ccs.lat, ccs.lng,
            ccs.geocode_precision, s.name AS season_name, s.code AS season_code
     FROM commune_crop_seasons ccs JOIN seasons s ON s.id = ccs.season_id
     WHERE ccs.lat IS NOT NULL
     ORDER BY ccs.harvest_date`,
  );
}

/** FN-10 / FN-11 — lớp thời tiết dự báo và cảnh báo nguy hiểm. */
export function weatherLayer(date?: string): { forecast: unknown[]; alerts: unknown[] } {
  const day = date ?? nowIso().slice(0, 10);
  return {
    forecast: all(
      "SELECT w.*, a.name AS area_name, a.centroid_lat, a.centroid_lng FROM weather_observations w LEFT JOIN admin_units a ON a.id = w.area_id WHERE w.kind = 'forecast' AND w.observed_for >= ? ORDER BY w.observed_for LIMIT 200",
      [day],
    ),
    // FN-11: nguồn tự xác định mức cảnh báo theo chuẩn KTTV, GIS chỉ nhận & hiển thị.
    alerts: all(
      "SELECT w.*, a.name AS area_name, a.centroid_lat, a.centroid_lng FROM weather_observations w LEFT JOIN admin_units a ON a.id = w.area_id WHERE w.severity IS NOT NULL AND w.observed_for >= ? ORDER BY w.observed_for",
      [day],
    ),
  };
}

// ---------------------------------------------------------------------------
// FN-15 — Tiếp nhận dữ liệu từ các hệ thống nghiệp vụ
// ---------------------------------------------------------------------------

export interface IngestPayload {
  system: SyncSystem;
  dataset:
    | 'htx_locations' | 'plot_boundaries' | 'crop_status' | 'harvest_forecast'
    | 'machine_counts' | 'facility_capacity' | 'weather';
  records: Record<string, unknown>[];
}

export function ingest(payload: IngestPayload, actor: AuditActor = {}) {
  return runSync(
    { system: payload.system, direction: 'inbound', dataset: payload.dataset, payload },
    () => {
      let recordCount = 0;
      switch (payload.dataset) {
        case 'crop_status':
          for (const record of payload.records) {
            upsert('crop_status', {
              id: uuid(),
              htx_id: record.htxId,
              season_id: record.seasonId,
              stage: record.stage,
              expected_harvest_date: record.expectedHarvestDate ?? null,
              expected_yield_tons: Number(record.expectedYieldTons ?? 0),
              straw_tons: Number(record.strawTons ?? 0),
              updated_at: nowIso(),
            });
            recordCount += 1;
          }
          break;
        case 'facility_capacity':
          for (const record of payload.records) {
            const facility = one<{ id: string }>('SELECT id FROM facilities WHERE code = ?', [record.code]);
            if (!facility) continue;
            upsertFacilityCapacity(facility.id, Number(record.capacityTons ?? 0), Number(record.currentStockTons ?? 0));
            recordCount += 1;
          }
          break;
        case 'weather':
          for (const record of payload.records) {
            upsert('weather_observations', {
              id: uuid(),
              area_id: record.areaId,
              observed_for: record.observedFor,
              rainfall_mm: record.rainfallMm ?? null,
              humidity_pct: record.humidityPct ?? null,
              temp_c: record.tempC ?? null,
              kind: record.kind ?? 'forecast',
              severity: record.severity ?? null,
              headline: record.headline ?? null,
              received_at: nowIso(),
            });
            recordCount += 1;
          }
          break;
        default:
          throw new Error(`Dataset "${payload.dataset}" chưa được hỗ trợ ở luồng tiếp nhận.`);
      }
      logEvent(
        { module: 'gis', entityType: payload.dataset, action: 'sync', after: { count: recordCount }, source: 'integration' },
        actor,
      );
      return { recordCount };
    },
  );
}

function upsertFacilityCapacity(id: string, capacityTons: number, currentStockTons: number): void {
  const row = one<Record<string, unknown>>('SELECT * FROM facilities WHERE id = ?', [id]);
  if (!row) return;
  upsert('facilities', { ...row, capacity_tons: capacityTons, current_stock_tons: currentStockTons, updated_at: nowIso() });
}

// ---------------------------------------------------------------------------
// FN-16 — Cấp bản đồ và dữ liệu chuẩn hoá cho hệ thống khác (hiện tại: TMS)
// ---------------------------------------------------------------------------

export function publishStandardBundle(consumer: string, actor: AuditActor = {}) {
  return runSync({ system: 'tms', direction: 'outbound', dataset: `standard_bundle:${consumer}` }, () => {
    const bundle = {
      schema: 'mekonggreen.gis.v1',
      generatedAt: nowIso(),
      crs: 'EPSG:4326',
      basemaps: ['street', 'satellite', 'terrain'],
      layers: {
        adminUnits: all('SELECT id, code, name, level, parent_id, centroid_lat, centroid_lng FROM admin_units'),
        cooperatives: all('SELECT id, code, name, lat, lng FROM cooperatives WHERE lat IS NOT NULL'),
        facilities: all('SELECT id, code, name, kind, lat, lng, capacity_tons, current_stock_tons FROM facilities'),
        roads: listRoutes({ mode: 'road', status: 'da_xac_nhan' }).map(routeFeature),
        waterways: listRoutes({ mode: 'waterway', status: 'da_xac_nhan' }).map(routeFeature),
      },
      legend: { cropPalette: cropPalette(), capacityThresholds: capacityThresholds() },
    };
    logEvent({ module: 'gis', entityType: 'standard_bundle', action: 'export', after: { consumer } }, actor);
    return { recordCount: Object.keys(bundle.layers).length, result: bundle };
  });
}
