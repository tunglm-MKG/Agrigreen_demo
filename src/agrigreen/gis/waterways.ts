/**
 * FN-20 — Số hóa & đo tuyến đường thủy trên bản đồ nền (và FN-07/FN-08 của BRD GIS).
 *
 * Người dùng vẽ tuyến kênh/rạch/sông trực tiếp trên nền bản đồ; hệ thống tự
 * đo chiều dài geodesic (BR-02) và người dùng KHÔNG được nhập/sửa chiều dài
 * bằng tay (BR-03). Chỉ tuyến "Đã xác nhận" mới tham gia định tuyến (BR-04).
 */
import { all, insert, one, run, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { formatLength, geodesicMeters, polylineLengthMeters, type LatLng } from '../../platform/geo/geo.ts';

export type RouteMode = 'road' | 'waterway';
export type RouteStatus = 'nhap' | 'da_xac_nhan';

export interface RouteRecord {
  id: string;
  code: string;
  name: string;
  mode: RouteMode;
  road_class: string | null;
  max_load_tons: number | null;
  width_m: number | null;
  depth_m: number | null;
  clearance_m: number | null;
  geometry: string;
  length_m: number;
  data_source: string;
  status: RouteStatus;
  province_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RouteInput {
  name: string;
  mode: RouteMode;
  /** Danh sách đỉnh do người dùng nhấp trên bản đồ. */
  points: LatLng[];
  roadClass?: string;
  maxLoadTons?: number;
  widthM?: number;
  depthM?: number;
  clearanceM?: number;
  provinceId?: string;
  note?: string;
  dataSource?: 'so_hoa_noi_bo' | 'chinh_thuc' | 'osm';
  status?: RouteStatus;
}

/** BR-06: cảnh báo (không chặn) khi tuyến có hình học bất thường. */
export interface GeometryWarning {
  code: 'tu_giao' | 'doan_dai_bat_thuong' | 'chua_ket_noi';
  message: string;
}

/** Ngưỡng cấu hình được cho "đoạn thẳng dài bất thường" (m). */
const LONG_SEGMENT_THRESHOLD_M = 20_000;

export function validateGeometry(points: LatLng[], mode: RouteMode): GeometryWarning[] {
  const warnings: GeometryWarning[] = [];
  for (let i = 1; i < points.length; i += 1) {
    if (geodesicMeters(points[i - 1], points[i]) > LONG_SEGMENT_THRESHOLD_M) {
      warnings.push({
        code: 'doan_dai_bat_thuong',
        message: `Đoạn ${i} dài bất thường (> ${LONG_SEGMENT_THRESHOLD_M / 1000} km) — kiểm tra lại các đỉnh đã vẽ.`,
      });
      break;
    }
  }
  if (selfIntersects(points)) {
    warnings.push({ code: 'tu_giao', message: 'Tuyến tự giao nhau — nên chỉnh lại các đỉnh.' });
  }
  if (!touchesNetwork(points, mode)) {
    warnings.push({
      code: 'chua_ket_noi',
      message: 'Tuyến chưa giao với tuyến/Hub nào trong mạng lưới — chưa dùng được cho định tuyến.',
    });
  }
  return warnings;
}

function selfIntersects(points: LatLng[]): boolean {
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = i + 2; j < points.length - 1; j += 1) {
      if (i === 0 && j === points.length - 2) continue; // bỏ qua đoạn đầu–cuối kề nhau
      if (segmentsIntersect(points[i], points[i + 1], points[j], points[j + 1])) return true;
    }
  }
  return false;
}

function segmentsIntersect(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const cross = (p: LatLng, q: LatLng, r: LatLng) =>
    (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Kiểm tra tuyến có tiếp giáp mạng lưới hoặc một Hub/HTX nào không. */
function touchesNetwork(points: LatLng[], mode: RouteMode): boolean {
  const SNAP_M = 500;
  const others = all<{ geometry: string }>(
    "SELECT geometry FROM transport_routes WHERE mode = ? AND status = 'da_xac_nhan'",
    [mode],
  );
  for (const row of others) {
    const geometry = JSON.parse(row.geometry) as { coordinates: [number, number][] };
    for (const [lng, lat] of geometry.coordinates) {
      for (const point of points) {
        if (geodesicMeters(point, { lat, lng }) < SNAP_M) return true;
      }
    }
  }
  const anchors = all<{ lat: number; lng: number }>(
    "SELECT lat, lng FROM facilities UNION ALL SELECT lat, lng FROM candidate_hubs UNION ALL SELECT lat, lng FROM cooperatives WHERE lat IS NOT NULL",
  );
  for (const anchor of anchors) {
    for (const point of points) {
      if (geodesicMeters(point, { lat: anchor.lat, lng: anchor.lng }) < 3 * SNAP_M) return true;
    }
  }
  return false;
}

export function createRoute(input: RouteInput, actor: AuditActor = {}): {
  route: RouteRecord;
  lengthLabel: string;
  segments: { index: number; meters: number }[];
  warnings: GeometryWarning[];
} {
  // BR-01: tuyến hợp lệ phải có tối thiểu 2 đỉnh; toạ độ WGS84.
  if (!input.points || input.points.length < 2) {
    throw new Error('Tuyến phải có tối thiểu 2 đỉnh.');
  }
  for (const point of input.points) {
    if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
      throw new Error('Toạ độ không hợp lệ (phải theo hệ WGS84 / EPSG:4326).');
    }
  }

  const lengthM = polylineLengthMeters(input.points);
  const prefix = input.mode === 'waterway' ? 'WW' : 'RD';
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM transport_routes WHERE mode = ?', [input.mode]);

  const record: Record<string, unknown> = {
    id: uuid(),
    code: sequenceCode(prefix, (count?.n ?? 0) + 1, 4),
    name: input.name,
    mode: input.mode,
    road_class: input.roadClass ?? null,
    max_load_tons: input.maxLoadTons ?? null,
    width_m: input.widthM ?? null,
    depth_m: input.depthM ?? null,
    clearance_m: input.clearanceM ?? null,
    geometry: JSON.stringify(toLineString(input.points)),
    length_m: Math.round(lengthM * 100) / 100, // BR-03: hệ thống tính, không nhận từ client
    data_source: input.dataSource ?? 'so_hoa_noi_bo',
    status: input.status ?? 'nhap',
    province_id: input.provinceId ?? null,
    note: input.note ?? null,
    created_by: actor.name ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('transport_routes', record);

  // BR-08: mọi thao tác tạo/sửa/xoá tuyến ghi vào nhật ký dữ liệu nền.
  logEvent(
    { module: 'gis', entityType: 'transport_routes', entityId: record.id as string, action: 'create', after: record },
    actor,
  );

  return {
    route: getRoute(record.id as string)!,
    lengthLabel: formatLength(lengthM),
    segments: segmentLengths(input.points),
    warnings: validateGeometry(input.points, input.mode),
  };
}

export function updateRouteGeometry(id: string, points: LatLng[], actor: AuditActor = {}): {
  route: RouteRecord;
  lengthLabel: string;
  warnings: GeometryWarning[];
} {
  const before = getRoute(id);
  if (!before) throw new Error('Không tìm thấy tuyến');
  if (points.length < 2) throw new Error('Tuyến phải có tối thiểu 2 đỉnh.');
  const lengthM = polylineLengthMeters(points);
  update('transport_routes', id, {
    geometry: JSON.stringify(toLineString(points)),
    length_m: Math.round(lengthM * 100) / 100,
    updated_at: nowIso(),
  });
  const after = getRoute(id)!;
  logEvent({ module: 'gis', entityType: 'transport_routes', entityId: id, action: 'update', before, after }, actor);
  return { route: after, lengthLabel: formatLength(lengthM), warnings: validateGeometry(points, before.mode) };
}

export function setRouteStatus(id: string, status: RouteStatus, actor: AuditActor = {}): RouteRecord {
  const before = getRoute(id);
  if (!before) throw new Error('Không tìm thấy tuyến');
  update('transport_routes', id, { status, updated_at: nowIso() });
  const after = getRoute(id)!;
  logEvent({ module: 'gis', entityType: 'transport_routes', entityId: id, action: 'update', before, after, note: `status=${status}` }, actor);
  return after;
}

export function deleteRoute(id: string, actor: AuditActor = {}): void {
  const before = getRoute(id);
  run('DELETE FROM transport_routes WHERE id = ?', [id]);
  logEvent({ module: 'gis', entityType: 'transport_routes', entityId: id, action: 'delete', before }, actor);
}

export function getRoute(id: string): RouteRecord | null {
  return one<RouteRecord>('SELECT * FROM transport_routes WHERE id = ?', [id]);
}

export function listRoutes(filter: { mode?: RouteMode; status?: RouteStatus } = {}): (RouteRecord & { lengthLabel: string })[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.mode) {
    clauses.push('mode = ?');
    params.push(filter.mode);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all<RouteRecord>(`SELECT * FROM transport_routes ${where} ORDER BY mode, code`, params).map((route) => ({
    ...route,
    lengthLabel: formatLength(route.length_m),
  }));
}

/** Đo nhanh (thước đo) — không sinh dữ liệu lưu trữ (FN-20 Luồng phụ). */
export function measure(points: LatLng[]): {
  totalMeters: number;
  label: string;
  segments: { index: number; meters: number }[];
} {
  const totalMeters = polylineLengthMeters(points);
  return { totalMeters: Math.round(totalMeters * 100) / 100, label: formatLength(totalMeters), segments: segmentLengths(points) };
}

function segmentLengths(points: LatLng[]): { index: number; meters: number }[] {
  const segments: { index: number; meters: number }[] = [];
  for (let i = 1; i < points.length; i += 1) {
    segments.push({ index: i, meters: Math.round(geodesicMeters(points[i - 1], points[i]) * 100) / 100 });
  }
  return segments;
}

function toLineString(points: LatLng[]): { type: 'LineString'; coordinates: [number, number][] } {
  return { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) };
}

// ---------------------------------------------------------------------------
// Import / Export chuẩn mở (TECH-06: không phụ thuộc một nhà cung cấp bản đồ)
// ---------------------------------------------------------------------------

export function exportGeoJson(filter: { mode?: RouteMode; status?: RouteStatus } = {}): Record<string, unknown> {
  const routes = listRoutes(filter);
  return {
    type: 'FeatureCollection',
    features: routes.map((route) => ({
      type: 'Feature',
      geometry: JSON.parse(route.geometry),
      properties: {
        code: route.code,
        name: route.name,
        mode: route.mode,
        lengthM: route.length_m,
        lengthLabel: route.lengthLabel,
        maxLoadTons: route.max_load_tons,
        widthM: route.width_m,
        depthM: route.depth_m,
        clearanceM: route.clearance_m,
        dataSource: route.data_source,
        status: route.status,
        // BR-07: chiều dài số hóa là ƯỚC LƯỢNG, không có giá trị pháp lý.
        disclaimer:
          'Chiều dài tuyến số hóa là giá trị ước lượng phục vụ so sánh phương án đầu tư; ' +
          'không có giá trị pháp lý và không thay thế số liệu đo đạc thực địa.',
      },
    })),
  };
}

export function exportKml(filter: { mode?: RouteMode; status?: RouteStatus } = {}): string {
  const routes = listRoutes(filter);
  const placemarks = routes
    .map((route) => {
      const geometry = JSON.parse(route.geometry) as { coordinates: [number, number][] };
      const coords = geometry.coordinates.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
      return `    <Placemark>
      <name>${escapeXml(route.code)} — ${escapeXml(route.name)}</name>
      <description>${escapeXml(`${route.lengthLabel} · ${route.data_source} · ${route.status}`)}</description>
      <LineString><coordinates>${coords}</coordinates></LineString>
    </Placemark>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Mekong Green — Mạng lưới tuyến số hóa</name>
${placemarks}
  </Document>
</kml>`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!,
  );
}

/** Import GeoJSON FeatureCollection (khi xin được dữ liệu chính thức). */
export function importGeoJson(
  featureCollection: { features: { geometry: { type: string; coordinates: [number, number][] }; properties?: Record<string, unknown> }[] },
  options: { mode: RouteMode; dataSource?: 'chinh_thuc' | 'osm'; status?: RouteStatus },
  actor: AuditActor = {},
): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  for (const feature of featureCollection.features ?? []) {
    if (feature.geometry?.type !== 'LineString' || feature.geometry.coordinates.length < 2) {
      skipped += 1;
      continue;
    }
    const points: LatLng[] = feature.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    createRoute(
      {
        name: String(feature.properties?.name ?? feature.properties?.code ?? 'Tuyến import'),
        mode: options.mode,
        points,
        maxLoadTons: numberOrUndefined(feature.properties?.maxLoadTons),
        widthM: numberOrUndefined(feature.properties?.widthM),
        depthM: numberOrUndefined(feature.properties?.depthM),
        dataSource: options.dataSource ?? 'chinh_thuc',
        status: options.status ?? 'da_xac_nhan',
      },
      actor,
    );
    imported += 1;
  }
  return { imported, skipped };
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
