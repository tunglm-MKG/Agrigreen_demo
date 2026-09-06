/**
 * ADAPTER XÂM NHẬP MẶN — bảng NHẬP TAY từ bản tin đã công bố của Viện Khoa học
 * Thủy lợi miền Nam (VKHTLMN). Ảnh chụp tĩnh của một mùa khô, không phải dữ liệu sống.
 *
 * Nguồn: gis-demo/data/salinity-siwrr.json — mỗi dòng ghi cửa sông, khoảng thời
 * gian, ranh 4 g/l (km, min–max) đúng câu chữ bản tin, mã bản tin và ngày bản tin.
 * Vị trí vẽ trên bản đồ là nội suy theo trục cửa sông → điểm tham chiếu thượng
 * lưu; đó là xấp xỉ của đội demo, KHÔNG phải số đo của Viện — nhãn nói rõ.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, one, run } from '../db.ts';
import type { LayerAdapter, PointValue, SourceInfo } from './types.ts';

const FILE = process.env.GIS_DEMO_SALINITY ?? join(process.cwd(), 'gis-demo', 'data', 'salinity-siwrr.json');

interface Manual {
  bulletins: { id: string; title: string; date: string; url: string; quote: string }[];
  rivers: { river: string; mouth: [number, number]; upstream: [number, number] }[];
  readings: { bulletin: string; river: string; period_from: string; period_to: string; km_min: number; km_max: number; note?: string }[];
}

let loaded: Manual | null = null;
function manual(): Manual {
  if (!loaded) loaded = JSON.parse(readFileSync(FILE, 'utf8')) as Manual;
  return loaded;
}

/** Nạp bảng nhập tay vào CSDL demo (idempotent). */
export function loadSalinity(): number {
  const m = manual();
  run('DELETE FROM salinity_manual');
  let n = 0;
  for (const r of m.readings) {
    const river = m.rivers.find((x) => x.river === r.river);
    const b = m.bulletins.find((x) => x.id === r.bulletin);
    if (!river || !b) continue;
    run(`INSERT INTO salinity_manual (id, river, mouth_lat, mouth_lng, upstream_lat, upstream_lng, period_from, period_to, km_min, km_max, bulletin, bulletin_date, bulletin_url, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${r.bulletin}:${r.river}:${r.period_from}`, r.river, river.mouth[0], river.mouth[1], river.upstream[0], river.upstream[1],
        r.period_from, r.period_to, r.km_min, r.km_max, b.title, b.date, b.url, r.note ?? null]);
    n += 1;
  }
  return n;
}

/** Điểm cách cửa sông `km` dọc trục cửa sông → thượng lưu (xấp xỉ đường thẳng). */
function alongRiver(mouth: [number, number], upstream: [number, number], km: number): [number, number] {
  const dLat = (upstream[0] - mouth[0]) * 110.57;
  const dLng = (upstream[1] - mouth[1]) * 111.32 * Math.cos((mouth[0] * Math.PI) / 180);
  const length = Math.hypot(dLat, dLng) || 1;
  const t = km / length;
  return [mouth[0] + (upstream[0] - mouth[0]) * t, mouth[1] + (upstream[1] - mouth[1]) * t];
}

type Row = { id: string; river: string; mouth_lat: number; mouth_lng: number; upstream_lat: number; upstream_lng: number; period_from: string; period_to: string; km_min: number; km_max: number; bulletin: string; bulletin_date: string; bulletin_url: string; note: string | null };

function rows(): Row[] {
  if (!one('SELECT id FROM salinity_manual LIMIT 1')) loadSalinity();
  return all<Row>('SELECT * FROM salinity_manual ORDER BY bulletin_date DESC, river');
}

function latestBulletin() {
  const b = manual().bulletins.slice().sort((a, c) => (a.date < c.date ? 1 : -1))[0];
  return b;
}

export const siwrrSalinityAdapter: LayerAdapter = {
  source(): SourceInfo {
    const b = latestBulletin();
    const first = manual().bulletins.slice().sort((a, c) => (a.date > c.date ? 1 : -1))[0];
    const dates = manual().bulletins.map((x) => x.date.split('-').reverse().join('/')).join(', ');
    return {
      id: 'salinity', layerName: 'Xâm nhập mặn — ranh 4 g/l',
      providerName: 'Viện Khoa học Thủy lợi miền Nam (VKHTLMN)',
      attribution: `Nguồn: Viện Khoa học Thủy lợi miền Nam, bản tin ngày ${dates}`,
      attributionUrl: b.url, license: 'Số liệu đã công bố công khai trên website Viện; trích dẫn, nhập tay',
      status: 'tinh', dataTimestamp: `mùa khô ${first.date.slice(0, 4)} và ${b.date.slice(0, 4)}`, snapshotDate: b.date,
      unit: 'km', render: 'features', hasSeries: false,
      caveat: 'ẢNH CHỤP TĨNH nhập tay từ bản tin, không phải dữ liệu sống và không có nguồn API để làm sống. Vị trí ranh mặn vẽ xấp xỉ theo trục cửa sông; số km là số của Viện, vị trí vẽ là của đội demo.',
      extra: { bulletins: manual().bulletins.map((x) => ({ id: x.id, title: x.title, date: x.date, url: x.url })) },
    };
  },
  updatedAt() { return latestBulletin().date; },
  async valueAt(lat, lng): Promise<PointValue> {
    // Ranh mặn gần điểm bấm nhất (theo khoảng cách tới đoạn cửa sông–thượng lưu).
    let best: { row: Row; km: number } | null = null;
    for (const row of rows()) {
      const p = alongRiver([row.mouth_lat, row.mouth_lng], [row.upstream_lat, row.upstream_lng], row.km_max);
      const km = Math.hypot((p[0] - lat) * 110.57, (p[1] - lng) * 111.32 * Math.cos((lat * Math.PI) / 180));
      if (!best || km < best.km) best = { row, km };
    }
    if (!best) return { value: null, unit: 'km', dataTimestamp: null, label: 'Chưa có bản tin', origin: 'static' };
    const r = best.row;
    return {
      value: r.km_max, unit: 'km', dataTimestamp: `${r.period_from} → ${r.period_to}`,
      label: `${r.river}: ranh 4 g/l ${r.km_min}–${r.km_max} km từ cửa sông (điểm bấm cách ranh ${Math.round(best.km)} km) — bản tin ${r.bulletin_date.split('-').reverse().join('/')}`,
      details: { km_min: { value: r.km_min, unit: 'km', label: 'Ranh 4 g/l — thấp nhất' }, km_max: { value: r.km_max, unit: 'km', label: 'Ranh 4 g/l — cao nhất' } },
      origin: 'static',
    };
  },
  async mapData() {
    const features: Record<string, unknown>[] = [];
    for (const r of rows()) {
      const a = alongRiver([r.mouth_lat, r.mouth_lng], [r.upstream_lat, r.upstream_lng], r.km_min);
      const b = alongRiver([r.mouth_lat, r.mouth_lng], [r.upstream_lat, r.upstream_lng], r.km_max);
      const props = {
        river: r.river, kmMin: r.km_min, kmMax: r.km_max, periodFrom: r.period_from, periodTo: r.period_to,
        bulletin: r.bulletin, bulletinDate: r.bulletin_date, bulletinUrl: r.bulletin_url, note: r.note, season: r.bulletin_date.slice(0, 4),
      };
      // Đoạn sông bị ảnh hưởng (cửa sông → ranh cao nhất) + đoạn dao động min–max.
      features.push({ type: 'Feature', properties: { ...props, part: 'affected' }, geometry: { type: 'LineString', coordinates: [[r.mouth_lng, r.mouth_lat], [b[1], b[0]]] } });
      features.push({ type: 'Feature', properties: { ...props, part: 'range' }, geometry: { type: 'LineString', coordinates: [[a[1], a[0]], [b[1], b[0]]] } });
      features.push({ type: 'Feature', properties: { ...props, part: 'front' }, geometry: { type: 'Point', coordinates: [b[1], b[0]] } });
    }
    return { kind: 'geojson', geojson: { type: 'FeatureCollection', properties: { seasons: [...new Set(rows().map((r) => r.bulletin_date.slice(0, 4)))] }, features } };
  },
};
