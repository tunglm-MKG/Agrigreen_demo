/**
 * Đọc tệp dữ liệu không gian tải lên (GeoJSON, KML) thành danh sách đối tượng
 * chuẩn hoá — dùng chung cho GIS FN-04/FN-05 (US-BND-07/08, US-PLOT-04), Khuyến
 * nông US-PLOT-02 và App HTX (tải ranh giới có sẵn).
 *
 * Không dùng thư viện ngoài: GeoJSON là JSON thuần; KML là XML rất đều nên đọc
 * bằng biểu thức chính quy là đủ cho Placemark/Polygon/Point/LineString.
 * Shapefile là định dạng nhị phân nhiều tệp — chưa hỗ trợ, báo rõ cho người dùng.
 */
import type { LatLng } from '../platform/geo/geo.ts';

export interface ImportedFeature {
  /** polygon | point | line */
  kind: 'polygon' | 'point' | 'line';
  name: string | null;
  properties: Record<string, unknown>;
  /** Vành ngoài (polygon) hoặc toàn tuyến (line); điểm thì 1 phần tử. */
  points: LatLng[];
}

export interface ImportResult {
  format: 'geojson' | 'kml';
  features: ImportedFeature[];
  skipped: { index: number; reason: string }[];
}

/** Nhận nội dung tệp (chuỗi) và tên tệp; tự đoán định dạng theo phần mở rộng rồi theo nội dung. */
export function parseSpatialFile(content: string, fileName = ''): ImportResult {
  const lower = fileName.toLowerCase();
  const trimmed = content.trim();
  if (lower.endsWith('.shp') || lower.endsWith('.zip') || lower.endsWith('.dbf')) {
    throw new Error('Shapefile là định dạng nhị phân nhiều tệp — hãy chuyển sang GeoJSON hoặc KML (QGIS: Export → Save Features As) rồi tải lại.');
  }
  if (lower.endsWith('.kml') || trimmed.startsWith('<')) return parseKml(trimmed);
  if (lower.endsWith('.geojson') || lower.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) return parseGeoJson(trimmed);
  throw new Error('File không đúng định dạng GeoJSON hoặc KML, vui lòng kiểm tra lại.');
}

export function parseGeoJson(text: string): ImportResult {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error('File ranh giới không đúng định dạng GeoJSON hoặc dữ liệu không hợp lệ, vui lòng kiểm tra lại.'); }
  const features: any[] = data?.type === 'FeatureCollection' ? (data.features ?? [])
    : data?.type === 'Feature' ? [data]
    : data?.type ? [{ type: 'Feature', geometry: data, properties: {} }]
    : Array.isArray(data) ? data : [];
  if (!features.length) throw new Error('GeoJSON không chứa đối tượng (Feature) nào.');
  const out: ImportedFeature[] = [];
  const skipped: ImportResult['skipped'] = [];
  features.forEach((feature, index) => {
    const geometry = feature?.geometry ?? feature;
    const props = (feature?.properties ?? {}) as Record<string, unknown>;
    const converted = geometryToFeature(geometry, props);
    if (!converted) { skipped.push({ index, reason: `Hình học "${geometry?.type ?? 'không rõ'}" không hỗ trợ hoặc thiếu toạ độ` }); return; }
    out.push(converted);
  });
  return { format: 'geojson', features: out, skipped };
}

function geometryToFeature(geometry: any, props: Record<string, unknown>): ImportedFeature | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const name = pickName(props);
  const toLatLng = (c: unknown): LatLng | null => {
    if (!Array.isArray(c) || c.length < 2) return null;
    const lng = Number(c[0]); const lat = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  };
  switch (geometry.type) {
    case 'Polygon': {
      const ring = (geometry.coordinates?.[0] ?? []).map(toLatLng).filter(Boolean) as LatLng[];
      return ring.length >= 3 ? { kind: 'polygon', name, properties: props, points: dropClosing(ring) } : null;
    }
    case 'MultiPolygon': {
      // Lấy vành lớn nhất — đủ cho ranh giới HTX/thửa; các mảnh nhỏ bỏ qua có chủ đích.
      const rings = (geometry.coordinates ?? []).map((poly: any) => (poly?.[0] ?? []).map(toLatLng).filter(Boolean) as LatLng[]);
      const best = rings.sort((a: LatLng[], b: LatLng[]) => b.length - a.length)[0] ?? [];
      return best.length >= 3 ? { kind: 'polygon', name, properties: props, points: dropClosing(best) } : null;
    }
    case 'Point': {
      const p = toLatLng(geometry.coordinates);
      return p ? { kind: 'point', name, properties: props, points: [p] } : null;
    }
    case 'LineString': {
      const line = (geometry.coordinates ?? []).map(toLatLng).filter(Boolean) as LatLng[];
      return line.length >= 2 ? { kind: 'line', name, properties: props, points: line } : null;
    }
    case 'MultiLineString': {
      const line = (geometry.coordinates ?? []).flat().map(toLatLng).filter(Boolean) as LatLng[];
      return line.length >= 2 ? { kind: 'line', name, properties: props, points: line } : null;
    }
    default:
      return null;
  }
}

function dropClosing(ring: LatLng[]): LatLng[] {
  const first = ring[0]; const last = ring[ring.length - 1];
  if (ring.length > 3 && first.lat === last.lat && first.lng === last.lng) return ring.slice(0, -1);
  return ring;
}

function pickName(props: Record<string, unknown>): string | null {
  for (const key of ['name', 'Name', 'NAME', 'ten', 'Ten', 'TEN', 'ten_htx', 'ten_hub', 'title']) {
    const v = props[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function parseKml(text: string): ImportResult {
  if (!/<kml|<Placemark|<Document/i.test(text)) throw new Error('File không đúng định dạng KML (thiếu thẻ <kml>/<Placemark>).');
  const placemarks = [...text.matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi)];
  if (!placemarks.length) throw new Error('KML không chứa Placemark nào.');
  const out: ImportedFeature[] = [];
  const skipped: ImportResult['skipped'] = [];
  placemarks.forEach((match, index) => {
    const block = match[1];
    const name = (block.match(/<name>([\s\S]*?)<\/name>/i)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim() || null;
    const props: Record<string, unknown> = {};
    for (const data of block.matchAll(/<Data\s+name="([^"]+)"[^>]*>[\s\S]*?<value>([\s\S]*?)<\/value>/gi)) props[data[1]] = data[2].trim();
    for (const data of block.matchAll(/<SimpleData\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/SimpleData>/gi)) props[data[1]] = data[2].trim();
    const description = block.match(/<description>([\s\S]*?)<\/description>/i)?.[1];
    if (description) props.description = description.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const kind: ImportedFeature['kind'] | null = /<Polygon/i.test(block) ? 'polygon' : /<LineString/i.test(block) ? 'line' : /<Point/i.test(block) ? 'point' : null;
    if (!kind) { skipped.push({ index, reason: 'Placemark không có Polygon/LineString/Point' }); return; }
    // Với Polygon lấy outerBoundaryIs; các loại khác lấy khối <coordinates> đầu tiên.
    const source = kind === 'polygon' ? (block.match(/<outerBoundaryIs>([\s\S]*?)<\/outerBoundaryIs>/i)?.[1] ?? block) : block;
    const raw = source.match(/<coordinates>([\s\S]*?)<\/coordinates>/i)?.[1] ?? '';
    const points = raw.trim().split(/\s+/).map((tuple) => {
      const [lng, lat] = tuple.split(',').map(Number);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }).filter(Boolean) as LatLng[];
    const minimum = kind === 'polygon' ? 3 : kind === 'line' ? 2 : 1;
    if (points.length < minimum) { skipped.push({ index, reason: `Thiếu toạ độ (${points.length} điểm)` }); return; }
    out.push({ kind, name, properties: props, points: kind === 'polygon' ? dropClosing(points) : points });
  });
  return { format: 'kml', features: out, skipped };
}

/** Nhập tay danh sách cặp toạ độ "lat, lng" mỗi dòng (US-PLOT-04 luồng phụ). */
export function parseCoordinateLines(text: string): LatLng[] {
  const points: LatLng[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith('#')) continue;
    const parts = cleaned.split(/[,\s;]+/).map(Number).filter((n) => Number.isFinite(n));
    if (parts.length < 2) throw new Error(`Dòng "${cleaned}" không phải cặp toạ độ "vĩ độ, kinh độ".`);
    const [a, b] = parts;
    // Chấp nhận cả "lat lng" và "lng lat": ở ĐBSCL vĩ độ luôn < 12, kinh độ luôn > 100.
    const point = a > 90 || (a > 20 && b < 20) ? { lat: b, lng: a } : { lat: a, lng: b };
    if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) throw new Error(`Toạ độ "${cleaned}" nằm ngoài phạm vi hợp lệ.`);
    points.push(point);
  }
  return points;
}
