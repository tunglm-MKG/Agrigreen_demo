/**
 * Thư viện tính toán không gian dùng chung (WGS84 / EPSG:4326).
 *
 * Phục vụ:
 *  - BRD Simulation FN-04 (khoảng cách Field→Hub, Hub→Plant, Field→Plant)
 *  - BRD Simulation FN-20 (đo chiều dài tuyến đường thủy số hóa)
 *  - BRD GIS FN-06/FN-07/FN-08 (ranh giới, mạng lưới đường bộ/đường thủy)
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Bán trục lớn của ellipsoid WGS84 (m). */
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Khoảng cách đường chim bay (Haversine), đơn vị km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371.0088;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Khoảng cách geodesic trên ellipsoid WGS84 (Vincenty inverse), đơn vị mét.
 *
 * FN-20 BR-02 yêu cầu chiều dài tuyến số hóa là tổng khoảng cách geodesic giữa
 * các đỉnh liên tiếp trên ellipsoid WGS84, và AC-04 yêu cầu sai số ≤ 1% so với
 * công cụ đo của Google Maps — Haversine trên hình cầu không đủ chặt cho AC này.
 */
export function geodesicMeters(a: LatLng, b: LatLng): number {
  const L = toRad(b.lng - a.lng);
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(toRad(a.lat)));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(toRad(b.lat)));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let iteration = 0;
  let cosSqAlpha = 0;
  let sinSigma = 0;
  let cos2SigmaM = 0;
  let cosSigma = 0;
  let sigma = 0;

  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0; // hai điểm trùng nhau
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma +
          C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - previous) < 1e-12) break;
  } while (++iteration < 200);

  const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  return WGS84_B * A * (sigma - deltaSigma);
}

/** Tổng chiều dài một polyline (mét) — FN-20 BR-02. */
export function polylineLengthMeters(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += geodesicMeters(points[i - 1], points[i]);
  }
  return total;
}

/** Định dạng chiều dài theo FN-20 BR-02: m khi < 1.000 m, km khi ≥ 1.000 m. */
export function formatLength(meters: number): string {
  if (meters < 1000) return `${meters.toFixed(2)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/** Kiểm tra một điểm có nằm trong polygon hay không (ray casting). */
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Diện tích polygon trên mặt cầu, đơn vị hecta.
 * Dùng cho App Khuyến nông FN-05 và App HTX FN-07 (vẽ ranh giới thửa ruộng →
 * hệ thống tự tính diện tích).
 */
export function polygonAreaHectares(polygon: LatLng[]): number {
  if (polygon.length < 3) return 0;
  const R = 6378137;
  let total = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    total += toRad(p2.lng - p1.lng) * (2 + Math.sin(toRad(p1.lat)) + Math.sin(toRad(p2.lat)));
  }
  return Math.abs((total * R * R) / 2) / 10_000;
}

/** Khung bao (bounding box) của một tập điểm — dùng cho zoom-to-fit (GIS UX-06). */
export function boundsOf(points: LatLng[]): { south: number; west: number; north: number; east: number } | null {
  if (!points.length) return null;
  let south = points[0].lat;
  let north = points[0].lat;
  let west = points[0].lng;
  let east = points[0].lng;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }
  return { south, west, north, east };
}

/** Điểm trung tâm (centroid đơn giản) của một polygon. */
export function centroid(polygon: LatLng[]): LatLng {
  const sum = polygon.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 },
  );
  return { lat: sum.lat / polygon.length, lng: sum.lng / polygon.length };
}
