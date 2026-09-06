/**
 * ADAPTER MỰC NƯỚC — Ủy hội sông Mê Công quốc tế (MRC).
 *
 * KẾT QUẢ KHẢO SÁT NGUỒN (06/09/2026): MRC Data Portal cho xem và vẽ biểu đồ miễn
 * phí, nhưng tải dữ liệu thô phải qua Thủ tục PDIES (giấy phép + phí). API
 * near-real-time mà trang monitoring.mrcmekong.org dùng
 * (api.mrcmekong.org/api/v1/time-series/telemetry/recent) trả 401 nếu không có
 * khoá. Demo KHÔNG lấy khoá nhúng trong trình duyệt của họ để gọi — đó là vượt
 * kiểm soát truy cập, không phải "nguồn mở".
 *
 * Vì vậy lớp này là DỮ LIỆU TĨNH nạp từ tệp CSV do người có quyền xuất từ portal
 * (A.2): gis-demo/data/import/mrc-water-level.csv với cột
 *   station_code,station_name,river,lat,lng,day,level_m
 * Chưa có tệp thì lớp hiển thị trạm với chuỗi MINH HOẠ được gắn nhãn không thể
 * nhầm — để màn hình vẫn cho thấy lớp trông thế nào, mà không ai tưởng đó là số MRC.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, one, run } from '../db.ts';
import type { LayerAdapter, PointValue, Series, SourceInfo } from './types.ts';

const IMPORT_FILE = process.env.GIS_DEMO_MRC_CSV ?? join(process.cwd(), 'gis-demo', 'data', 'import', 'mrc-water-level.csv');

/** Trạm thủy văn dọc sông Tiền / sông Hậu trong vùng — vị trí công khai, toạ độ xấp xỉ. */
const STATIONS = [
  { code: 'TAN_CHAU', name: 'Tân Châu', river: 'Sông Tiền', lat: 10.80, lng: 105.24 },
  { code: 'CHAU_DOC', name: 'Châu Đốc', river: 'Sông Hậu', lat: 10.71, lng: 105.13 },
  { code: 'VAM_NAO', name: 'Vàm Nao', river: 'Sông Vàm Nao', lat: 10.56, lng: 105.36 },
  { code: 'CAN_THO', name: 'Cần Thơ', river: 'Sông Hậu', lat: 10.05, lng: 105.79 },
  { code: 'MY_THUAN', name: 'Mỹ Thuận', river: 'Sông Tiền', lat: 10.28, lng: 105.93 },
  { code: 'CAO_LANH', name: 'Cao Lãnh', river: 'Sông Tiền', lat: 10.46, lng: 105.64 },
];

function ensureStations(): void {
  for (const s of STATIONS) {
    run(`INSERT OR IGNORE INTO water_level_stations (code, name, river, lat, lng, datum, source_note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [s.code, s.name, s.river, s.lat, s.lng, 'Hòn Dấu (giả định — kiểm lại khi có CSV MRC)', 'Vị trí trạm công khai; toạ độ do đội demo ước theo bản đồ']);
  }
}

/** Nạp CSV MRC nếu có. Trả về số dòng đã nạp; 0 khi chưa có tệp. */
export function importMrcCsv(path = IMPORT_FILE): { rows: number; from: string | null; to: string | null } {
  ensureStations();
  if (!existsSync(path)) return { rows: 0, from: null, to: null };
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const header = lines.shift()!.split(',').map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const required = ['station_code', 'day', 'level_m'];
  for (const r of required) if (idx(r) < 0) throw new Error(`CSV thiếu cột ${r}`);
  let rows = 0;
  let from: string | null = null;
  let to: string | null = null;
  run(`DELETE FROM water_level_series WHERE quality = 'minh_hoa'`);
  for (const line of lines) {
    const cols = line.split(',');
    const code = cols[idx('station_code')].trim();
    const day = cols[idx('day')].trim().slice(0, 10);
    const level = Number(cols[idx('level_m')]);
    if (!code || !day || !Number.isFinite(level)) continue;
    if (idx('station_name') >= 0 && idx('lat') >= 0 && idx('lng') >= 0) {
      run(`INSERT OR IGNORE INTO water_level_stations (code, name, river, lat, lng, datum, source_note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [code, cols[idx('station_name')], idx('river') >= 0 ? cols[idx('river')] : null, Number(cols[idx('lat')]), Number(cols[idx('lng')]), null, 'Từ CSV MRC']);
    }
    run(`INSERT OR REPLACE INTO water_level_series (station_code, day, level_m, quality) VALUES (?, ?, ?, 'mrc')`, [code, day, level]);
    rows += 1;
    if (!from || day < from) from = day;
    if (!to || day > to) to = day;
  }
  run(`INSERT INTO water_level_import (imported_at, file_name, rows, from_day, to_day, source) VALUES (?, ?, ?, ?, ?, ?)`,
    [new Date().toISOString(), path, rows, from, to, 'MRC Data Portal — CSV xuất theo PDIES']);
  return { rows, from, to };
}

/**
 * Chuỗi MINH HOẠ khi chưa có CSV: một đường mùa (cao mùa lũ tháng 9–10, thấp tháng
 * 4) cộng dao động triều nhỏ. Sinh có hạt cố định. Gắn quality = 'minh_hoa' để
 * mọi nơi hiển thị đều biết đây không phải số đo.
 */
function ensureIllustrative(): void {
  const hasReal = one<{ n: number }>(`SELECT COUNT(*) AS n FROM water_level_series WHERE quality = 'mrc'`)!.n > 0;
  const hasIllu = one<{ n: number }>(`SELECT COUNT(*) AS n FROM water_level_series WHERE quality = 'minh_hoa'`)!.n > 0;
  if (hasReal || hasIllu) return;
  const base: Record<string, { mean: number; amp: number; tide: number }> = {
    TAN_CHAU: { mean: 2.0, amp: 1.6, tide: 0.15 }, CHAU_DOC: { mean: 1.8, amp: 1.5, tide: 0.15 }, VAM_NAO: { mean: 1.5, amp: 1.2, tide: 0.3 },
    CAN_THO: { mean: 1.0, amp: 0.5, tide: 0.7 }, MY_THUAN: { mean: 1.1, amp: 0.6, tide: 0.6 }, CAO_LANH: { mean: 1.4, amp: 1.0, tide: 0.4 },
  };
  const start = Date.UTC(2024, 0, 1);
  const days = 365 * 2;
  for (const s of STATIONS) {
    const p = base[s.code];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start + i * 86_400_000);
      const doy = i % 365;
      const season = Math.sin(((doy - 100) / 365) * 2 * Math.PI); // đỉnh ~ ngày 190+ (tháng 9–10)
      const tide = Math.sin((i / 14.77) * 2 * Math.PI) * p.tide;
      const level = Math.round((p.mean + season * p.amp + tide) * 100) / 100;
      run(`INSERT OR IGNORE INTO water_level_series (station_code, day, level_m, quality) VALUES (?, ?, ?, 'minh_hoa')`, [s.code, d.toISOString().slice(0, 10), level]);
    }
  }
}

function dataState(): { real: boolean; from: string | null; to: string | null; importedAt: string | null } {
  const real = one<{ n: number; f: string | null; t: string | null }>(`SELECT COUNT(*) AS n, MIN(day) AS f, MAX(day) AS t FROM water_level_series WHERE quality = 'mrc'`)!;
  if (real.n > 0) {
    const imp = one<{ imported_at: string }>(`SELECT imported_at FROM water_level_import ORDER BY imported_at DESC LIMIT 1`);
    return { real: true, from: real.f, to: real.t, importedAt: imp?.imported_at ?? null };
  }
  const illu = one<{ f: string | null; t: string | null }>(`SELECT MIN(day) AS f, MAX(day) AS t FROM water_level_series WHERE quality = 'minh_hoa'`)!;
  return { real: false, from: illu.f, to: illu.t, importedAt: null };
}

function nearestStation(lat: number, lng: number) {
  const rows = all<{ code: string; name: string; river: string | null; lat: number; lng: number }>('SELECT code, name, river, lat, lng FROM water_level_stations');
  let best = rows[0];
  let bestKm = Infinity;
  for (const s of rows) {
    const km = Math.hypot((s.lat - lat) * 110.57, (s.lng - lng) * 111.32 * Math.cos((lat * Math.PI) / 180));
    if (km < bestKm) { bestKm = km; best = s; }
  }
  return { station: best, km: Math.round(bestKm * 10) / 10 };
}

export const mrcWaterLevelAdapter: LayerAdapter = {
  source(): SourceInfo {
    ensureStations(); ensureIllustrative();
    const state = dataState();
    return {
      id: 'water-level', layerName: 'Mực nước sông (trạm thủy văn)',
      providerName: state.real ? 'Ủy hội sông Mê Công quốc tế (MRC) — MRC Data Portal' : 'CHƯA NẠP số MRC — chuỗi minh hoạ do đội demo tạo',
      attribution: state.real ? 'Nguồn: Ủy hội sông Mê Công quốc tế (MRC)' : 'DỮ LIỆU MINH HOẠ — không phải số đo MRC. Nguồn dự kiến: Ủy hội sông Mê Công quốc tế (MRC)',
      attributionUrl: 'https://portal.mrcmekong.org/home',
      license: 'Thủ tục PDIES của MRC — tải dữ liệu thô cần giấy phép và phí; xem/vẽ miễn phí. Trước khi vào sản phẩm thật phải đọc kỹ điều kiện tái phân phối.',
      status: 'tinh', dataTimestamp: state.from && state.to ? `${state.from} → ${state.to}` : null,
      snapshotDate: state.importedAt?.slice(0, 10) ?? null,
      unit: 'm', render: 'points', hasSeries: true,
      caveat: state.real
        ? 'Tải sẵn một khoảng thời gian từ CSV xuất ở MRC Data Portal, nạp vào CSDL demo. Không tự động cập nhật.'
        : 'CHƯA có dữ liệu MRC: API near-real-time của MRC yêu cầu khoá; dữ liệu thô cần giấy phép PDIES. Chuỗi hiện thấy là ĐƯỜNG MINH HOẠ để xem hình dạng lớp. Đặt tệp gis-demo/data/import/mrc-water-level.csv rồi khởi động lại để thay bằng số thật.',
      extra: { illustrative: !state.real, stations: STATIONS.length },
    };
  },
  updatedAt() { return dataState().importedAt; },
  async valueAt(lat, lng, at): Promise<PointValue> {
    ensureStations(); ensureIllustrative();
    const { station, km } = nearestStation(lat, lng);
    const day = (at ?? '').slice(0, 10);
    const row = day
      ? one<{ day: string; level_m: number; quality: string }>('SELECT day, level_m, quality FROM water_level_series WHERE station_code = ? AND day <= ? ORDER BY day DESC LIMIT 1', [station.code, day])
      : one<{ day: string; level_m: number; quality: string }>('SELECT day, level_m, quality FROM water_level_series WHERE station_code = ? ORDER BY day DESC LIMIT 1', [station.code]);
    return {
      value: row?.level_m ?? null, unit: 'm', dataTimestamp: row?.day ?? null,
      label: `Trạm ${station.name}${station.river ? ` (${station.river})` : ''}, cách điểm bấm ${km} km${row?.quality === 'minh_hoa' ? ' — SỐ MINH HOẠ' : ''}`,
      origin: 'static',
    };
  },
  async series(lat, lng, from, to): Promise<Series> {
    ensureStations(); ensureIllustrative();
    const { station, km } = nearestStation(lat, lng);
    const rows = all<{ day: string; level_m: number; quality: string }>(
      'SELECT day, level_m, quality FROM water_level_series WHERE station_code = ? AND day BETWEEN ? AND ? ORDER BY day', [station.code, from, to]);
    const illustrative = rows.some((r) => r.quality === 'minh_hoa');
    return {
      label: `Mực nước ngày — trạm ${station.name} (cách ${km} km)${illustrative ? ' — MINH HOẠ' : ''}`, unit: 'm',
      points: rows.map((r) => ({ t: r.day, v: r.level_m })), dataTimestamp: rows.at(-1)?.day ?? null, origin: 'static',
      note: illustrative ? 'ĐƯỜNG MINH HOẠ do đội demo sinh — không phải số đo MRC.' : 'Số đo MRC nạp từ CSV, không tự động cập nhật.',
    };
  },
  async mapData() {
    ensureStations(); ensureIllustrative();
    const state = dataState();
    const rows = all<{ code: string; name: string; river: string | null; lat: number; lng: number }>('SELECT * FROM water_level_stations');
    return {
      kind: 'geojson',
      geojson: {
        type: 'FeatureCollection',
        properties: { illustrative: !state.real },
        features: rows.map((s) => {
          const last = one<{ day: string; level_m: number; quality: string }>('SELECT day, level_m, quality FROM water_level_series WHERE station_code = ? ORDER BY day DESC LIMIT 1', [s.code]);
          return {
            type: 'Feature',
            properties: { code: s.code, name: s.name, river: s.river, lastDay: last?.day ?? null, lastLevel: last?.level_m ?? null, illustrative: last?.quality === 'minh_hoa' },
            geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          };
        }),
      },
    };
  },
};
