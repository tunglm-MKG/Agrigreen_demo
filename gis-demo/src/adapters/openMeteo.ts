/**
 * ADAPTER THỜI TIẾT — Open-Meteo (tier miễn phí, CHỈ hợp lệ ở mức demo).
 *
 * Lớp duy nhất có đường ống sống. Hai chế độ (F-04): giá trị hiện tại và chuỗi
 * lịch sử theo ngày từ 01/01/2015 (kho ERA5 của Open-Meteo bắt đầu từ 1940).
 *
 * Bộ đệm cục bộ (A.1): hiện tại 60 phút theo ô 0,1° (~11 km); lịch sử 24 giờ theo
 * (ô, từ, đến). Một phiên xem 5 phút bấm loanh quanh một vùng tốn vài lời gọi,
 * không phải vài chục — đó là cách thoả tiêu chí 8. Mọi lời gọi đều đi qua
 * `callExternal` để đếm được.
 *
 * Ghi nguồn bắt buộc: "Weather data by Open-Meteo.com" kèm liên kết — adapter trả
 * chuỗi này trong source(); giao diện chỉ hiển thị, không viết cứng.
 * Sản phẩm thật: mua gói thương mại, tự vận hành mã AGPLv3, hoặc đổi sang ERA5 (Copernicus CDS) / NASA POWER — chỉ cần viết adapter mới.
 */
import { cacheGet, cacheSet, recordExternalCall } from '../db.ts';
import type { LayerAdapter, PointValue, Series, SourceInfo } from './types.ts';

const PROVIDER = 'open-meteo';
const CURRENT_TTL_MIN = 60;
const HISTORY_TTL_MIN = 24 * 60;
const GRID = 0.1;

/** Các thành phố làm "trạm ảo" cho lớp điểm — một lời gọi nhiều toạ độ, 1 lần/giờ. */
const STATIONS = [
  { name: 'Cần Thơ', lat: 10.03, lng: 105.78 }, { name: 'Long Xuyên', lat: 10.38, lng: 105.44 },
  { name: 'Cao Lãnh', lat: 10.46, lng: 105.63 }, { name: 'Vĩnh Long', lat: 10.25, lng: 105.97 },
  { name: 'Rạch Giá', lat: 10.01, lng: 105.08 }, { name: 'Bến Tre', lat: 10.24, lng: 106.38 },
  { name: 'Sóc Trăng', lat: 9.60, lng: 105.97 }, { name: 'Cà Mau', lat: 9.18, lng: 105.15 },
  { name: 'Mỹ Tho', lat: 10.36, lng: 106.36 }, { name: 'Trà Vinh', lat: 9.93, lng: 106.34 },
];

const CURRENT_VARS = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'wind_speed_10m', 'weather_code'];
const LABELS: Record<string, string> = {
  temperature_2m: 'Nhiệt độ', relative_humidity_2m: 'Độ ẩm', precipitation: 'Mưa (giờ qua)', wind_speed_10m: 'Gió',
  temperature_2m_max: 'Nhiệt độ cao nhất', temperature_2m_min: 'Nhiệt độ thấp nhất', precipitation_sum: 'Tổng mưa ngày',
};

const cell = (v: number) => (Math.round(v / GRID) * GRID).toFixed(1);

/** Cổng ra duy nhất tới Open-Meteo — đếm mọi lời gọi. */
async function callExternal<T>(url: string, endpoint: string): Promise<T> {
  const t0 = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const payload = await response.json() as T & { error?: boolean; reason?: string };
    if (!response.ok || payload.error) throw new Error(payload.reason ?? `HTTP ${response.status}`);
    recordExternalCall(PROVIDER, endpoint, true, Date.now() - t0);
    return payload;
  } catch (error) {
    recordExternalCall(PROVIDER, endpoint, false, Date.now() - t0);
    throw new Error(`Open-Meteo không phản hồi: ${(error as Error).message}`);
  }
}

interface CurrentPayload { current: Record<string, number | string>; current_units: Record<string, string> }
interface ArchivePayload { daily: Record<string, (number | null)[] | string[]>; daily_units: Record<string, string> }

let lastDataTimestamp: string | null = null;
let lastFetchedAt: string | null = null;

export const openMeteoAdapter: LayerAdapter = {
  source(): SourceInfo {
    if (!lastDataTimestamp) {
      const cached = cacheGet<{ items: { current: Record<string, number | string> }[] }>('om:stations');
      if (cached) { lastDataTimestamp = String(cached.value.items[0]?.current.time ?? ''); lastFetchedAt = cached.fetchedAt; }
    }
    return {
      id: 'weather', layerName: 'Thời tiết (hiện tại + lịch sử)',
      providerName: 'Open-Meteo', attribution: 'Weather data by Open-Meteo.com', attributionUrl: 'https://open-meteo.com/',
      license: 'CC BY 4.0 — tier miễn phí chỉ dành cho đánh giá / làm mẫu thử; sản phẩm thật phải mua gói thương mại hoặc đổi nguồn',
      status: 'song', dataTimestamp: lastDataTimestamp, snapshotDate: null, unit: '°C', render: 'points', hasSeries: true,
      caveat: 'Dữ liệu sống qua API, bộ đệm 60 phút. Lịch sử là tái phân tích ERA5 (ô ~9–11 km), không phải trạm đo mặt đất.',
      extra: { stations: STATIONS.map((s) => s.name), historyFrom: '2015-01-01', cacheMinutes: CURRENT_TTL_MIN },
    };
  },

  updatedAt() { return lastFetchedAt; },

  async valueAt(lat, lng): Promise<PointValue> {
    const key = `om:current:${cell(lat)},${cell(lng)}`;
    let origin: PointValue['origin'] = 'cache';
    let cached = cacheGet<CurrentPayload>(key);
    if (!cached) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&current=${CURRENT_VARS.join(',')}&timezone=Asia%2FBangkok`;
      const payload = await callExternal<CurrentPayload>(url, 'forecast/current');
      cacheSet(key, PROVIDER, payload, CURRENT_TTL_MIN);
      cached = { value: payload, fetchedAt: new Date().toISOString() };
      origin = 'live';
    }
    const c = cached.value.current;
    const u = cached.value.current_units;
    lastDataTimestamp = String(c.time);
    lastFetchedAt = cached.fetchedAt;
    const details: PointValue['details'] = {};
    for (const v of CURRENT_VARS) if (v !== 'weather_code') details[v] = { value: Number(c[v]), unit: u[v], label: LABELS[v] ?? v };
    return { value: Number(c.temperature_2m), unit: u.temperature_2m, dataTimestamp: String(c.time), label: 'Nhiệt độ hiện tại', details, origin };
  },

  async series(lat, lng, from, to): Promise<Series> {
    if (from < '2015-01-01') from = '2015-01-01';
    const maxTo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10); // kho ERA5 trễ ~2 ngày
    if (to > maxTo) to = maxTo;
    if (from > to) throw new Error('Khoảng ngày không hợp lệ.');
    const key = `om:archive:${cell(lat)},${cell(lng)}:${from}:${to}`;
    let origin: Series['origin'] = 'cache';
    let cached = cacheGet<ArchivePayload>(key);
    if (!cached) {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&start_date=${from}&end_date=${to}`
        + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia%2FBangkok';
      const payload = await callExternal<ArchivePayload>(url, 'archive/daily');
      cacheSet(key, PROVIDER, payload, HISTORY_TTL_MIN);
      cached = { value: payload, fetchedAt: new Date().toISOString() };
      origin = 'live';
    }
    const d = cached.value.daily;
    const time = d.time as string[];
    const rain = d.precipitation_sum as (number | null)[];
    const tmax = d.temperature_2m_max as (number | null)[];
    const tmin = d.temperature_2m_min as (number | null)[];
    return {
      label: 'Mưa ngày (mm) · nhiệt độ cao nhất / thấp nhất (°C)', unit: 'mm | °C',
      points: time.map((t, i) => ({ t, v: rain[i], tmax: tmax[i], tmin: tmin[i] })) as Series['points'],
      dataTimestamp: time[time.length - 1] ?? null, origin,
      note: `Tái phân tích ERA5 qua Open-Meteo, ${time.length} ngày, ${from} → ${to}. Kho dữ liệu trễ khoảng 2 ngày so với hiện tại.`,
    };
  },

  /** Lớp điểm: điều kiện hiện tại tại 10 thành phố — MỘT lời gọi nhiều toạ độ, đệm 60 phút. */
  async mapData() {
    const key = 'om:stations';
    let cached = cacheGet<{ items: { name: string; lat: number; lng: number; current: Record<string, number | string>; units: Record<string, string> }[] }>(key);
    if (!cached) {
      const lats = STATIONS.map((s) => s.lat.toFixed(2)).join(',');
      const lngs = STATIONS.map((s) => s.lng.toFixed(2)).join(',');
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&current=${CURRENT_VARS.join(',')}&timezone=Asia%2FBangkok`;
      const payload = await callExternal<CurrentPayload[]>(url, 'forecast/current×10');
      const items = STATIONS.map((s, i) => ({ ...s, current: payload[i].current, units: payload[i].current_units }));
      cacheSet(key, PROVIDER, { items }, CURRENT_TTL_MIN);
      cached = { value: { items }, fetchedAt: new Date().toISOString() };
    }
    lastFetchedAt = cached.fetchedAt;
    lastDataTimestamp = String(cached.value.items[0]?.current.time ?? null);
    return {
      kind: 'geojson',
      dataTimestamp: lastDataTimestamp,
      geojson: {
        type: 'FeatureCollection',
        features: cached.value.items.map((s) => ({
          type: 'Feature',
          properties: {
            name: s.name, time: s.current.time,
            temperature: s.current.temperature_2m, humidity: s.current.relative_humidity_2m,
            precipitation: s.current.precipitation, wind: s.current.wind_speed_10m,
            units: s.units, fetchedAt: cached!.fetchedAt,
          },
          geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        })),
      },
    };
  },
};
