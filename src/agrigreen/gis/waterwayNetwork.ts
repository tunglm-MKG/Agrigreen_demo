/**
 * TỰ ĐỘNG NHẬN DIỆN VÀ DỰNG LẠI MẠNG LƯỚI ĐƯỜNG THUỶ
 * ====================================================
 *
 * PHẠM VI — nói rõ để không hiểu nhầm:
 *
 * Hệ thống KHÔNG nhận diện kênh rạch từ ảnh vệ tinh (không có nguồn ảnh raster).
 * Cái được tự động nhận diện là CẤU TRÚC MẠNG LƯỚI từ các tuyến đã số hoá:
 *
 *   - Điểm giao nhau giữa hai tuyến cắt qua nhau ở giữa đoạn (chưa có đỉnh chung).
 *   - Đầu tuyến này nằm sát thân tuyến kia (nối chữ T bị thiếu đỉnh).
 *   - Hai đầu tuyến gần nhau nhưng chưa chạm (khe hở do số hoá).
 *
 * Đây chính là chỗ mạng lưới vẽ tay bị hỏng: hai con kênh nhìn trên bản đồ thì
 * nối nhau, nhưng trong dữ liệu là hai đường rời nên thuật toán tìm đường không
 * đi qua được, và khoảng cách Hub → Nhà máy rơi về Haversine hiệu chỉnh.
 *
 * Công cụ này tách làm hai mức, có chủ đích:
 *
 *   analyzeNetwork()  Chỉ BÁO CÁO: tìm được gì, còn hỏng ở đâu. Không sửa dữ liệu.
 *   rebuildNetwork()  Ghi lại hình học đã tách tại giao điểm và nối khe hở trong
 *                     ngưỡng cho phép — mỗi thay đổi đều ghi nhật ký.
 *
 * Nối khe hở là suy đoán, nên có ngưỡng và có báo cáo. Khe hở 2 km giữa hai
 * tuyến rất có thể là hai con kênh khác nhau, nối bừa sẽ tạo ra một tuyến vận
 * tải không tồn tại ngoài thực địa.
 */
import { all, insert, one, run, transaction, update } from '../../platform/db/db.ts';
import { geodesicMeters, haversineKm, polylineLengthMeters, type LatLng } from '../../platform/geo/geo.ts';
import { maxVessel, VESSEL_CLASSES, type WaterwayConstraints } from '../../platform/geo/vessels.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';

/** Khe hở tối đa được coi là "cùng một điểm" khi dựng lại mạng lưới (mét). */
export const SNAP_TOLERANCE_M = 25;
/** Khe hở tối đa được PHÉP nối tự động (mét). Xa hơn thì chỉ báo cáo. */
export const AUTO_JOIN_MAX_M = 150;
/**
 * Khe hở tối đa còn ĐƯỢC BÁO CÁO (mét).
 *
 * Xa hơn ngưỡng này thì hai đầu tuyến gần như chắc chắn là hai con kênh khác
 * nhau, không phải một chỗ đứt do số hoá. Báo cáo mọi cặp tuyến cách nhau vài km
 * sẽ ngập màn hình bằng nhiễu và che mất những chỗ đứt thật.
 */
export const REPORT_GAP_MAX_M = 1_000;
/** Sai số coi một điểm là "nằm trên" một đoạn (mét). */
const ON_SEGMENT_TOLERANCE_M = 20;

interface RouteRow {
  id: string;
  code: string;
  name: string;
  geometry: string;
  status: string;
  width_m: number | null;
  depth_m: number | null;
  clearance_m: number | null;
  max_load_tons: number | null;
}

function toPoints(geometry: string): LatLng[] {
  const parsed = JSON.parse(geometry) as { coordinates: [number, number][] };
  return parsed.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

function toGeometry(points: LatLng[]): string {
  return JSON.stringify({ type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) });
}

/**
 * Khoảng cách từ một điểm tới đoạn thẳng AB, và điểm chiếu trên đoạn.
 * Dùng xấp xỉ phẳng — ở quy mô vài trăm mét sai số dưới 1%.
 */
function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): { distanceM: number; point: LatLng; t: number } {
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lng * lngScale, ay = a.lat * latScale;
  const bx = b.lng * lngScale, by = b.lat * latScale;
  const px = p.lng * lngScale, py = p.lat * latScale;

  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx, cy = ay + t * dy;
  const point = { lat: cy / latScale, lng: cx / lngScale };
  return { distanceM: geodesicMeters(p, point), point, t };
}

/** Giao điểm của hai đoạn thẳng, nếu có (xấp xỉ phẳng). */
function segmentIntersection(a1: LatLng, a2: LatLng, b1: LatLng, b2: LatLng): LatLng | null {
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((a1.lat * Math.PI) / 180);
  const x = (p: LatLng) => p.lng * lngScale;
  const y = (p: LatLng) => p.lat * latScale;

  const d = (x(a2) - x(a1)) * (y(b2) - y(b1)) - (y(a2) - y(a1)) * (x(b2) - x(b1));
  if (Math.abs(d) < 1e-9) return null; // song song

  const u = ((x(b1) - x(a1)) * (y(b2) - y(b1)) - (y(b1) - y(a1)) * (x(b2) - x(b1))) / d;
  const v = ((x(b1) - x(a1)) * (y(a2) - y(a1)) - (y(b1) - y(a1)) * (x(a2) - x(a1))) / d;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;

  return { lat: a1.lat + u * (a2.lat - a1.lat), lng: a1.lng + u * (a2.lng - a1.lng) };
}

// =====================================================================
// Phân tích mạng lưới
// =====================================================================

export interface NetworkFinding {
  kind: 'giao_cat' | 'noi_chu_t' | 'khe_ho' | 'tuyen_co_lap';
  label: string;
  routeIds: string[];
  routeCodes: string[];
  lat: number;
  lng: number;
  gapM?: number;
  autoFixable: boolean;
}

export interface FacilityAccess {
  kind: 'hub' | 'plant';
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  /** Khoảng cách tới điểm gần nhất trên mạng lưới đường thuỷ (km). */
  nearestKm: number;
  nearestRouteCode: string | null;
  /** Có nằm trong bán kính tiếp cận để định tuyến đường thuỷ không. */
  connected: boolean;
}

export interface NetworkAnalysis {
  routeCount: number;
  confirmedCount: number;
  totalLengthKm: number;
  /** Số cụm liên thông — 1 nghĩa là toàn mạng lưới đi tới nhau được. */
  componentCount: number;
  largestComponentRoutes: number;
  isolatedRoutes: { id: string; code: string; name: string }[];
  findings: NetworkFinding[];
  /** Hub và nhà máy có tiếp cận được mạng lưới hay không. */
  facilityAccess: FacilityAccess[];
  disconnectedFacilities: number;
  notes: string[];
}

/** Bán kính tối đa coi là "tiếp giáp mạng lưới" khi định tuyến (km). */
export const ACCESS_RADIUS_KM = 8;

/**
 * Quét toàn bộ tuyến đường thuỷ đã xác nhận, tìm chỗ mạng lưới bị đứt.
 *
 * KHÔNG sửa dữ liệu — chỉ báo cáo, để người dùng xem trước rồi mới quyết định.
 */
export function analyzeNetwork(): NetworkAnalysis {
  const routes = all<RouteRow>(
    `SELECT id, code, name, geometry, status, width_m, depth_m, clearance_m, max_load_tons
       FROM transport_routes WHERE mode = 'waterway' ORDER BY code`,
  );
  const confirmed = routes.filter((route) => route.status === 'da_xac_nhan');
  const geometries = new Map(confirmed.map((route) => [route.id, toPoints(route.geometry)]));
  const findings: NetworkFinding[] = [];

  // ---- Giao cắt giữa hai tuyến, chưa có đỉnh chung ----
  for (let i = 0; i < confirmed.length; i += 1) {
    for (let j = i + 1; j < confirmed.length; j += 1) {
      const a = confirmed[i], b = confirmed[j];
      const pa = geometries.get(a.id)!, pb = geometries.get(b.id)!;
      const shared = pa.some((p) => pb.some((q) => geodesicMeters(p, q) <= SNAP_TOLERANCE_M));

      let crossing: LatLng | null = null;
      for (let m = 1; m < pa.length && !crossing; m += 1) {
        for (let n = 1; n < pb.length && !crossing; n += 1) {
          crossing = segmentIntersection(pa[m - 1], pa[m], pb[n - 1], pb[n]);
        }
      }
      if (crossing && !shared) {
        findings.push({
          kind: 'giao_cat',
          label: `${a.code} và ${b.code} cắt nhau nhưng không có đỉnh chung — thuật toán tìm đường không rẽ được ở đây.`,
          routeIds: [a.id, b.id], routeCodes: [a.code, b.code],
          lat: crossing.lat, lng: crossing.lng, autoFixable: true,
        });
        continue;
      }
      if (shared) continue;

      // ---- Đầu tuyến này nằm sát thân tuyến kia (nối chữ T) ----
      let tJoin: { point: LatLng; gapM: number } | null = null;
      for (const [ends, target] of [[[pa[0], pa[pa.length - 1]], pb], [[pb[0], pb[pb.length - 1]], pa]] as const) {
        for (const end of ends) {
          for (let k = 1; k < target.length; k += 1) {
            const projection = projectOnSegment(end, target[k - 1], target[k]);
            if (projection.distanceM <= ON_SEGMENT_TOLERANCE_M) {
              if (!tJoin || projection.distanceM < tJoin.gapM) {
                tJoin = { point: projection.point, gapM: projection.distanceM };
              }
            }
          }
        }
      }
      if (tJoin) {
        findings.push({
          kind: 'noi_chu_t',
          label: `Đầu tuyến ${a.code}/${b.code} nằm trên thân tuyến kia (cách ${tJoin.gapM.toFixed(1)} m) nhưng thiếu đỉnh nối.`,
          routeIds: [a.id, b.id], routeCodes: [a.code, b.code],
          lat: tJoin.point.lat, lng: tJoin.point.lng, gapM: tJoin.gapM, autoFixable: true,
        });
        continue;
      }

      // ---- Hai đầu tuyến gần nhau nhưng chưa chạm ----
      let gap: { from: LatLng; to: LatLng; gapM: number } | null = null;
      for (const p of [pa[0], pa[pa.length - 1]]) {
        for (const q of [pb[0], pb[pb.length - 1]]) {
          const d = geodesicMeters(p, q);
          if (d > SNAP_TOLERANCE_M && (!gap || d < gap.gapM)) gap = { from: p, to: q, gapM: d };
        }
      }
      if (gap && gap.gapM <= REPORT_GAP_MAX_M) {
        findings.push({
          kind: 'khe_ho',
          label: `Khe hở ${gap.gapM.toFixed(0)} m giữa đầu tuyến ${a.code} và ${b.code}.`,
          routeIds: [a.id, b.id], routeCodes: [a.code, b.code],
          lat: (gap.from.lat + gap.to.lat) / 2, lng: (gap.from.lng + gap.to.lng) / 2,
          gapM: gap.gapM,
          // Chỉ khe hở nhỏ mới coi là lỗi số hoá; xa hơn rất có thể là hai kênh khác nhau.
          autoFixable: gap.gapM <= AUTO_JOIN_MAX_M,
        });
      }
    }
  }

  // ---- Cụm liên thông ----
  const components = connectedComponents(confirmed, geometries);
  const largest = components.reduce((best, group) => (group.length > best.length ? group : best), [] as string[]);
  const isolated = components
    .filter((group) => group.length === 1)
    .map((group) => confirmed.find((route) => route.id === group[0])!)
    .map((route) => ({ id: route.id, code: route.code, name: route.name }));

  const totalLengthKm = confirmed.reduce(
    (acc, route) => acc + polylineLengthMeters(geometries.get(route.id)!) / 1000, 0,
  );

  // ---- Hub và nhà máy có với tới mạng lưới không ----
  // Đây là câu hỏi quyết định: mạng lưới có đẹp tới đâu mà nhà máy nằm cách bờ
  // kênh 12 km thì mọi chặng Hub → Nhà máy vẫn rơi về Haversine hiệu chỉnh.
  const facilities = [
    ...all<{ id: string; code: string; name: string; lat: number; lng: number }>(
      'SELECT id, code, name, lat, lng FROM candidate_hubs',
    ).map((row) => ({ ...row, kind: 'hub' as const })),
    ...all<{ id: string; code: string; name: string; lat: number; lng: number }>(
      "SELECT id, code, name, lat, lng FROM facilities WHERE kind = 'plant'",
    ).map((row) => ({ ...row, kind: 'plant' as const })),
  ];

  const facilityAccess: FacilityAccess[] = facilities.map((facility) => {
    let nearestKm = Infinity;
    let nearestRouteCode: string | null = null;
    for (const route of confirmed) {
      for (const point of geometries.get(route.id)!) {
        const d = haversineKm(point, facility);
        if (d < nearestKm) { nearestKm = d; nearestRouteCode = route.code; }
      }
    }
    return {
      kind: facility.kind,
      id: facility.id,
      code: facility.code,
      name: facility.name,
      lat: facility.lat,
      lng: facility.lng,
      nearestKm: Number.isFinite(nearestKm) ? Math.round(nearestKm * 100) / 100 : -1,
      nearestRouteCode,
      connected: Number.isFinite(nearestKm) && nearestKm <= ACCESS_RADIUS_KM,
    };
  });

  const disconnected = facilityAccess.filter((row) => !row.connected);

  const notes: string[] = [
    'Hệ thống nhận diện CẤU TRÚC mạng lưới từ các tuyến đã số hoá, không nhận diện kênh rạch từ ảnh vệ tinh.',
    `Hai điểm cách nhau ≤ ${SNAP_TOLERANCE_M} m được coi là cùng một đỉnh.`,
    `Khe hở ≤ ${AUTO_JOIN_MAX_M} m coi là lỗi số hoá và nối được tự động; từ đó tới ${REPORT_GAP_MAX_M} m chỉ báo cáo ` +
      'để người dùng tự quyết; xa hơn nữa coi là hai con kênh khác nhau và không báo.',
  ];
  if (components.length > 1) {
    notes.push(
      `Mạng lưới đang tách thành ${components.length} cụm rời nhau. Hub ở cụm này sẽ KHÔNG tìm được ` +
      'đường thuỷ tới nhà máy ở cụm kia, và khoảng cách sẽ rơi về Haversine hiệu chỉnh.',
    );
  }
  for (const facility of disconnected) {
    notes.push(
      `${facility.kind === 'plant' ? 'Nhà máy' : 'Hub'} ${facility.code} — ${facility.name} cách tuyến ` +
      `${facility.nearestRouteCode ?? 'gần nhất'} tới ${facility.nearestKm} km, vượt bán kính tiếp cận ` +
      `${ACCESS_RADIUS_KM} km. Mọi chặng đường thuỷ liên quan tới cơ sở này sẽ rơi về Haversine hiệu chỉnh ` +
      'cho tới khi số hoá nốt đoạn kênh dẫn vào.',
    );
  }

  return {
    routeCount: routes.length,
    confirmedCount: confirmed.length,
    totalLengthKm: Math.round(totalLengthKm * 100) / 100,
    componentCount: components.length,
    largestComponentRoutes: largest.length,
    isolatedRoutes: isolated,
    findings,
    facilityAccess,
    disconnectedFacilities: disconnected.length,
    notes,
  };
}

/** Gom tuyến thành các cụm liên thông theo đỉnh chung (trong ngưỡng snap). */
function connectedComponents(routes: RouteRow[], geometries: Map<string, LatLng[]>): string[][] {
  const parent = new Map(routes.map((route) => [route.id, route.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const pa = geometries.get(routes[i].id)!;
      const pb = geometries.get(routes[j].id)!;
      const touches = pa.some((p) => pb.some((q) => geodesicMeters(p, q) <= SNAP_TOLERANCE_M));
      if (touches) union(routes[i].id, routes[j].id);
    }
  }

  const groups = new Map<string, string[]>();
  for (const route of routes) {
    const root = find(route.id);
    const list = groups.get(root);
    if (list) list.push(route.id);
    else groups.set(root, [route.id]);
  }
  return [...groups.values()];
}

// =====================================================================
// Dựng lại mạng lưới
// =====================================================================

export interface RebuildResult {
  verticesInserted: number;
  routesModified: { id: string; code: string; before: number; after: number }[];
  gapsJoined: { routeCodes: string[]; gapM: number }[];
  skipped: { label: string; reason: string }[];
  analysisAfter: NetworkAnalysis;
}

/**
 * Chèn đỉnh tại các giao điểm và nối các khe hở nhỏ, để mạng lưới đi tới nhau được.
 *
 * Hình học tuyến được ghi lại (chèn thêm đỉnh), KHÔNG tách tuyến thành nhiều bản
 * ghi — giữ nguyên định danh tuyến để mọi tham chiếu và nhật ký cũ còn đúng.
 * Thuật toán định tuyến chỉ cần các tuyến CÓ ĐỈNH CHUNG là đã nối được.
 */
export function rebuildNetwork(
  options: { joinGaps?: boolean; maxGapM?: number } = {},
  actor: AuditActor = {},
): RebuildResult {
  const maxGapM = Math.min(options.maxGapM ?? AUTO_JOIN_MAX_M, AUTO_JOIN_MAX_M);
  const analysis = analyzeNetwork();

  const routes = all<RouteRow>(
    `SELECT id, code, name, geometry, status, width_m, depth_m, clearance_m, max_load_tons
       FROM transport_routes WHERE mode = 'waterway' AND status = 'da_xac_nhan'`,
  );
  const geometries = new Map(routes.map((route) => [route.id, toPoints(route.geometry)]));
  const byId = new Map(routes.map((route) => [route.id, route]));
  const before = new Map([...geometries].map(([id, points]) => [id, points.length]));

  const gapsJoined: { routeCodes: string[]; gapM: number }[] = [];
  const skipped: { label: string; reason: string }[] = [];
  let verticesInserted = 0;

  /** Chèn một đỉnh vào đúng vị trí trên tuyến (nếu chưa có đỉnh nào đủ gần). */
  const insertVertex = (routeId: string, point: LatLng): boolean => {
    const points = geometries.get(routeId);
    if (!points) return false;
    if (points.some((p) => geodesicMeters(p, point) <= SNAP_TOLERANCE_M)) return false;

    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 1; i < points.length; i += 1) {
      const projection = projectOnSegment(point, points[i - 1], points[i]);
      if (projection.distanceM < bestDistance) {
        bestDistance = projection.distanceM;
        bestIndex = i;
      }
    }
    if (bestIndex < 0 || bestDistance > ON_SEGMENT_TOLERANCE_M * 3) return false;
    points.splice(bestIndex, 0, point);
    verticesInserted += 1;
    return true;
  };

  for (const finding of analysis.findings) {
    if (finding.kind === 'tuyen_co_lap') continue;

    if (finding.kind === 'giao_cat' || finding.kind === 'noi_chu_t') {
      // Chèn cùng một điểm vào cả hai tuyến để chúng có đỉnh chung.
      const point = { lat: finding.lat, lng: finding.lng };
      for (const routeId of finding.routeIds) insertVertex(routeId, point);
      continue;
    }

    if (finding.kind === 'khe_ho') {
      if (!options.joinGaps) {
        skipped.push({ label: finding.label, reason: 'Chưa bật tuỳ chọn nối khe hở.' });
        continue;
      }
      if (!finding.autoFixable || (finding.gapM ?? Infinity) > maxGapM) {
        skipped.push({
          label: finding.label,
          reason:
            `Khe hở ${Math.round(finding.gapM ?? 0)} m vượt ngưỡng nối tự động ${maxGapM} m — ` +
            'rất có thể là hai con kênh khác nhau, nối bừa sẽ tạo ra tuyến vận tải không có thật.',
        });
        continue;
      }
      // Kéo đầu tuyến thứ hai về trùng đầu tuyến thứ nhất.
      const [idA, idB] = finding.routeIds;
      const pa = geometries.get(idA)!;
      const pb = geometries.get(idB)!;
      let best: { aIndex: number; bIndex: number; gapM: number } | null = null;
      for (const ai of [0, pa.length - 1]) {
        for (const bi of [0, pb.length - 1]) {
          const d = geodesicMeters(pa[ai], pb[bi]);
          if (!best || d < best.gapM) best = { aIndex: ai, bIndex: bi, gapM: d };
        }
      }
      if (best && best.gapM <= maxGapM) {
        pb[best.bIndex] = { ...pa[best.aIndex] };
        gapsJoined.push({ routeCodes: finding.routeCodes, gapM: Math.round(best.gapM) });
      }
    }
  }

  const routesModified: RebuildResult['routesModified'] = [];
  transaction(() => {
    for (const [id, points] of geometries) {
      const beforeCount = before.get(id) ?? points.length;
      const route = byId.get(id)!;
      const original = toPoints(route.geometry);
      const changed = points.length !== original.length
        || points.some((p, i) => geodesicMeters(p, original[i] ?? p) > 0.5);
      if (!changed) continue;

      update('transport_routes', id, {
        geometry: toGeometry(points),
        length_m: Math.round(polylineLengthMeters(points)),
        updated_at: nowIso(),
      });
      routesModified.push({ id, code: route.code, before: beforeCount, after: points.length });
      logEvent({
        module: 'gis', entityType: 'transport_routes', entityId: id, action: 'update',
        before: { vertices: beforeCount }, after: { vertices: points.length, reason: 'dung_lai_mang_luoi' },
      }, actor);
    }
  });

  return {
    verticesInserted,
    routesModified,
    gapsJoined,
    skipped,
    analysisAfter: analyzeNetwork(),
  };
}

// =====================================================================
// Công trình vượt sông
// =====================================================================

export const STRUCTURE_KINDS = [
  { code: 'cau', label: 'Cầu' },
  { code: 'cong', label: 'Cống' },
  { code: 'au_thuyen', label: 'Âu thuyền' },
  { code: 'duong_day_dien', label: 'Đường dây điện vượt sông' },
];

export function addStructure(
  input: {
    routeId: string; name: string; kind?: string; lat: number; lng: number;
    clearanceHeightM?: number | null; clearanceWidthM?: number | null; depthM?: number | null;
    surveyDate?: string; dataSource?: string; note?: string;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const route = one<{ id: string; code: string; mode: string; geometry: string }>(
    'SELECT id, code, mode, geometry FROM transport_routes WHERE id = ?', [input.routeId],
  );
  if (!route) throw new Error('Không tìm thấy tuyến.');
  if (route.mode !== 'waterway') throw new Error('Chỉ tuyến đường thuỷ mới có công trình vượt sông.');
  if (!input.name?.trim()) throw new Error('Công trình phải có tên.');

  // Công trình phải nằm trên tuyến — điểm cách tuyến hàng km là dữ liệu sai chỗ.
  const points = toPoints(route.geometry);
  let nearest = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    nearest = Math.min(nearest, projectOnSegment({ lat: input.lat, lng: input.lng }, points[i - 1], points[i]).distanceM);
  }
  if (nearest > 500) {
    throw new Error(
      `Vị trí công trình cách tuyến ${route.code} tới ${Math.round(nearest)} m — kiểm tra lại toạ độ. ` +
      'Công trình phải nằm trên tuyến thì mới ràng buộc được tải trọng lưu thông.',
    );
  }

  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM waterway_structures');
  const record = {
    id: uuid(),
    code: `CT-${String((count?.n ?? 0) + 1).padStart(4, '0')}`,
    route_id: input.routeId,
    name: input.name.trim(),
    kind: input.kind ?? 'cau',
    lat: input.lat,
    lng: input.lng,
    clearance_height_m: input.clearanceHeightM ?? null,
    clearance_width_m: input.clearanceWidthM ?? null,
    depth_m: input.depthM ?? null,
    survey_date: input.surveyDate ?? null,
    data_source: input.dataSource ?? 'khao_sat',
    note: input.note ?? null,
    created_by: actor.name ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('waterway_structures', record);
  logEvent({ module: 'gis', entityType: 'waterway_structures', entityId: record.id, action: 'create', after: record }, actor);

  // Thêm cầu là đổi ràng buộc của tuyến — tính lại ngay.
  deriveRouteCapacity(input.routeId, actor);
  return record;
}

export function listStructures(routeId?: string): Record<string, unknown>[] {
  const sql = `SELECT s.*, r.code AS route_code, r.name AS route_name
                 FROM waterway_structures s JOIN transport_routes r ON r.id = s.route_id`;
  return routeId
    ? all(`${sql} WHERE s.route_id = ? ORDER BY s.code`, [routeId])
    : all(`${sql} ORDER BY r.code, s.code`);
}

export function removeStructure(id: string, actor: AuditActor = {}): void {
  const before = one<{ id: string; route_id: string }>('SELECT id, route_id FROM waterway_structures WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy công trình.');
  run('DELETE FROM waterway_structures WHERE id = ?', [id]);
  logEvent({ module: 'gis', entityType: 'waterway_structures', entityId: id, action: 'delete', before }, actor);
  // Bỏ một cây cầu khỏi tuyến là nới ràng buộc — tính lại tải trọng ngay.
  deriveRouteCapacity(before.route_id, actor);
}

// =====================================================================
// Suy ra tải trọng lưu thông của tuyến
// =====================================================================

export interface RouteCapacity {
  routeId: string;
  routeCode: string;
  constraints: WaterwayConstraints & { limitingStructure: string | null };
  maxLoadTons: number;
  vesselCode: string | null;
  vesselLabel: string | null;
  certainty: 'du_lieu_day_du' | 'thieu_du_lieu';
  reasons: string[];
  perVessel: ReturnType<typeof maxVessel>['perVessel'];
  structureCount: number;
}

/**
 * Tính tải trọng lưu thông tối đa của một tuyến từ thông số kỹ thuật.
 *
 * Ràng buộc lấy giá trị BẤT LỢI NHẤT trên toàn tuyến: rộng thì lấy chỗ hẹp nhất,
 * sâu lấy chỗ cạn nhất, tĩnh không lấy cầu thấp nhất. Một tuyến rộng 60 m nhưng
 * có một cây cầu tĩnh không 4 m thì sà lan 2.000 tấn vẫn không qua được.
 */
export function deriveRouteCapacity(routeId: string, actor: AuditActor = {}): RouteCapacity {
  const route = one<RouteRow>(
    `SELECT id, code, name, geometry, status, width_m, depth_m, clearance_m, max_load_tons
       FROM transport_routes WHERE id = ?`, [routeId],
  );
  if (!route) throw new Error('Không tìm thấy tuyến.');

  const structures = all<{
    name: string; kind: string; clearance_height_m: number | null;
    clearance_width_m: number | null; depth_m: number | null;
  }>('SELECT name, kind, clearance_height_m, clearance_width_m, depth_m FROM waterway_structures WHERE route_id = ?',
    [routeId]);

  // Giá trị bất lợi nhất trên toàn tuyến.
  let widthM = route.width_m;
  let depthM = route.depth_m;
  let clearanceM = route.clearance_m;
  let limitingStructure: string | null = null;

  for (const structure of structures) {
    if (structure.clearance_width_m !== null && (widthM === null || structure.clearance_width_m < widthM)) {
      widthM = structure.clearance_width_m;
    }
    if (structure.depth_m !== null && (depthM === null || structure.depth_m < depthM)) {
      depthM = structure.depth_m;
    }
    if (structure.clearance_height_m !== null && (clearanceM === null || structure.clearance_height_m < clearanceM)) {
      clearanceM = structure.clearance_height_m;
      limitingStructure = structure.name;
    }
  }

  const constraints: WaterwayConstraints = { widthM, depthM, clearanceM };
  const verdict = maxVessel(constraints);

  update('transport_routes', routeId, {
    derived_max_load_tons: verdict.maxLoadTons || null,
    derived_vessel_code: verdict.vessel?.code ?? null,
    derived_certainty: verdict.certainty,
    derived_at: nowIso(),
    updated_at: nowIso(),
  });
  logEvent({
    module: 'gis', entityType: 'transport_routes', entityId: routeId, action: 'update',
    after: { derivedMaxLoadTons: verdict.maxLoadTons, certainty: verdict.certainty },
  }, actor);

  return {
    routeId,
    routeCode: route.code,
    constraints: { ...constraints, limitingStructure },
    maxLoadTons: verdict.maxLoadTons,
    vesselCode: verdict.vessel?.code ?? null,
    vesselLabel: verdict.vessel?.label ?? null,
    certainty: verdict.certainty,
    reasons: verdict.reasons,
    perVessel: verdict.perVessel,
    structureCount: structures.length,
  };
}

/** Tính lại tải trọng cho toàn bộ tuyến đường thuỷ. */
export function deriveAllCapacities(actor: AuditActor = {}): RouteCapacity[] {
  const routes = all<{ id: string }>("SELECT id FROM transport_routes WHERE mode = 'waterway'");
  return routes.map((route) => deriveRouteCapacity(route.id, actor));
}

/** Bảng tổng hợp năng lực toàn mạng lưới, theo từng lớp phương tiện. */
export function capacityOverview(): Record<string, unknown> {
  const capacities = all<{
    id: string; code: string; name: string; length_m: number;
    derived_max_load_tons: number | null; derived_vessel_code: string | null;
    derived_certainty: string | null; width_m: number | null; depth_m: number | null; clearance_m: number | null;
  }>(
    `SELECT id, code, name, length_m, derived_max_load_tons, derived_vessel_code,
            derived_certainty, width_m, depth_m, clearance_m
       FROM transport_routes WHERE mode = 'waterway' AND status = 'da_xac_nhan' ORDER BY code`,
  );

  const byVessel = VESSEL_CLASSES.map((vessel) => {
    const routes = capacities.filter((row) => (row.derived_max_load_tons ?? 0) >= vessel.tons);
    return {
      code: vessel.code,
      label: vessel.label,
      tons: vessel.tons,
      routeCount: routes.length,
      lengthKm: Math.round(routes.reduce((acc, row) => acc + row.length_m, 0) / 100) / 10,
    };
  });

  return {
    routes: capacities,
    byVessel,
    incompleteData: capacities.filter((row) => row.derived_certainty === 'thieu_du_lieu').length,
    totalRoutes: capacities.length,
  };
}
