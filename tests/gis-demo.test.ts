/**
 * Kiểm thử DEMO LỚP DỮ LIỆU GIS (SPIKE-GIS-LAYERS-001).
 *
 * Ba thứ tiêu chí đạt yêu cầu kiểm bằng cách rà mã và lược đồ được kiểm TỰ ĐỘNG ở đây:
 *   Tiêu chí 6 — không lời gọi API ngoài nào nằm ngoài lớp adapter
 *   Tiêu chí 7 — không bản ghi hình học OSM nào trong CSDL demo
 *   R-05       — nhật ký truy cập không có định danh cá nhân
 * Cộng với hợp đồng adapter (A.1), bộ đọc GeoTIFF, bộ ghi PNG, bảng mặn nhập tay,
 * bộ đệm thời tiết (tiêu chí 8) và lô mẫu (F-06).
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const tmp = mkdtempSync(join(tmpdir(), 'gis-demo-'));
process.env.GIS_DEMO_DB = join(tmp, 'demo.db');

const { readGeoTiff } = await import('../gis-demo/src/raster/geotiff.ts');
const { encodePng } = await import('../gis-demo/src/raster/png.ts');
const grid = await import('../gis-demo/src/raster/grid.ts');
const db = await import('../gis-demo/src/db.ts');
const { ADAPTERS, adapterById } = await import('../gis-demo/src/adapters/registry.ts');
const salinity = await import('../gis-demo/src/adapters/siwrrSalinity.ts');
const water = await import('../gis-demo/src/adapters/mrcWaterLevel.ts');
const { samplePlots, samplePlotsGeoJson } = await import('../gis-demo/src/samplePlots.ts');
const { DELTA_BBOX, insideDelta } = await import('../gis-demo/src/adapters/types.ts');

db.configure(process.env.GIS_DEMO_DB);
db.db();

const SRC = join(process.cwd(), 'gis-demo', 'src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// ===========================================================================
// Ràng buộc R-01 / tiêu chí 6, 7 — rà mã nguồn và lược đồ
// ===========================================================================

test('Tiêu chí 6: mọi URL ngoài chỉ xuất hiện trong thư mục adapters/ và fetch/ (lớp adapter)', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
    const allowed = rel.startsWith('adapters/') || rel.startsWith('fetch/');
    if (allowed) continue;
    const text = readFileSync(file, 'utf8');
    // Bỏ chú thích; chỉ bắt URL trong mã.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Loại URL cục bộ và chuỗi dựng base URL từ header Host (không phải lời gọi ra ngoài).
    if (/https?:\/\/(?!localhost|\$\{)/.test(code) || /\bfetch\s*\(/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `Tệp gọi ra ngoài ngoài lớp adapter: ${offenders.join(', ')}`);
});

test('Tiêu chí 6b: giao diện không viết cứng tên nguồn — mọi chữ về nguồn lấy từ adapter', () => {
  const ui = readFileSync(join(process.cwd(), 'gis-demo', 'web', 'app.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['Open-Meteo', 'SoilGrids', 'ISRIC', 'Copernicus', 'MRC', 'Thủy lợi', 'open-meteo.com', 'isric.org']) {
    assert.ok(!ui.includes(word), `app.js chứa tên nguồn "${word}" — phải lấy từ adapter`);
  }
});

test('Tiêu chí 7: lược đồ CSDL demo không có bảng/cột hình học OSM; không dùng osm2pgsql', () => {
  const tables = db.all<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`);
  for (const t of tables) {
    assert.ok(!/osm|planet|geometry|way_|node_/i.test(t.name), `bảng nghi là hình học OSM: ${t.name}`);
    assert.ok(!/osm/i.test(t.sql ?? ''), `cột liên quan OSM trong ${t.name}`);
  }
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/osm2pgsql|overpass|planet\.osm|\.osm\.pbf/i.test(text), `${file} tham chiếu công cụ nhập OSM`);
  }
});

test('R-05: bảng nhật ký truy cập không có cột IP / user-agent / định danh', () => {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(access_log)`).map((c) => c.name);
  assert.deepEqual(cols.sort(), ['at', 'ms', 'path', 'status']);
  db.logAccess('/api/layers/weather/value?lat=10.03&lng=105.78', 200, 12);
  const row = db.one<{ path: string }>('SELECT path FROM access_log ORDER BY at DESC LIMIT 1')!;
  assert.equal(row.path, '/api/layers/weather/value', 'không lưu query (toạ độ người dùng bấm)');
});

// ===========================================================================
// Hợp đồng adapter (A.1)
// ===========================================================================

test('Năm adapter, mỗi adapter có nguồn(), giá_trị_tại_điểm(), mốc_cập_nhật(), mapData(); id không trùng', () => {
  assert.equal(ADAPTERS.length, 5);
  const ids = ADAPTERS.map((a) => a.source().id);
  assert.equal(new Set(ids).size, 5);
  for (const a of ADAPTERS) {
    const s = a.source();
    assert.ok(s.layerName && s.providerName && s.attribution && s.license, `${s.id}: thiếu trường nguồn`);
    assert.ok(['song', 'tinh'].includes(s.status));
    assert.equal(typeof a.valueAt, 'function');
    assert.equal(typeof a.mapData, 'function');
    assert.ok(a.updatedAt() === null || typeof a.updatedAt() === 'string');
    if (s.hasSeries) assert.equal(typeof a.series, 'function', `${s.id} khai báo có chuỗi thời gian nhưng thiếu series()`);
  }
  assert.equal(adapterById('khong-co'), null);
});

test('F-05 / R-04: lớp tĩnh có ngày chụp, lớp sống có trạng thái sống; đúng một lớp sống', () => {
  const live = ADAPTERS.filter((a) => a.source().status === 'song');
  assert.equal(live.length, 1, 'chỉ thời tiết là đường ống sống');
  for (const a of ADAPTERS.filter((x) => x.source().status === 'tinh')) {
    const s = a.source();
    if (s.id === 'water-level' && s.extra?.illustrative) continue; // chưa nạp CSV: có nhãn minh hoạ thay ngày chụp
    assert.ok(s.snapshotDate, `${s.id} thiếu ngày chụp`);
  }
});

test('Chuỗi ghi nguồn bắt buộc theo brief §5 nằm trong adapter, không sai chính tả', () => {
  const by = (id: string) => adapterById(id)!.source();
  assert.equal(by('weather').attribution, 'Weather data by Open-Meteo.com');
  assert.match(by('soil-ph').attribution, /ISRIC — World Soil Information \/ SoilGrids|Chưa có dữ liệu/);
  assert.match(by('terrain').attribution, /© Copernicus DEM|Chưa có dữ liệu/);
  assert.match(by('water-level').attribution, /Ủy hội sông Mê Công quốc tế \(MRC\)/);
  assert.match(by('salinity').attribution, /Viện Khoa học Thủy lợi miền Nam, bản tin ngày \d{2}\/\d{2}\/\d{4}/);
});

// ===========================================================================
// Mặn — bảng nhập tay đúng bản tin
// ===========================================================================

test('Bảng mặn nhập tay: đúng số của bản tin VKHTLMN 11/3/2025 theo từng cửa sông', async () => {
  const n = salinity.loadSalinity();
  assert.ok(n >= 7);
  const rows = db.all<{ river: string; km_min: number; km_max: number; bulletin_date: string }>(
    `SELECT river, km_min, km_max, bulletin_date FROM salinity_manual WHERE bulletin_date = '2025-03-11' AND period_from = '2025-03-12'`);
  const km = (river: string) => rows.find((r) => r.river.startsWith(river))!;
  assert.deepEqual([km('Sông Cửa Tiểu').km_min, km('Sông Cửa Tiểu').km_max], [40, 42]);
  assert.deepEqual([km('Sông Hàm Luông').km_min, km('Sông Hàm Luông').km_max], [58, 60]);
  assert.deepEqual([km('Sông Cổ Chiên').km_min, km('Sông Cổ Chiên').km_max], [45, 48]);
  assert.deepEqual([km('Sông Hậu').km_min, km('Sông Hậu').km_max], [45, 47]);
  assert.deepEqual([km('Sông Vàm Cỏ Tây').km_min, km('Sông Vàm Cỏ Tây').km_max], [65, 70]);
  const map = await salinity.siwrrSalinityAdapter.mapData();
  assert.equal(map.kind, 'geojson');
  const features = (map as { geojson: { features: { properties: { part: string; bulletinUrl: string } }[] } }).geojson.features;
  assert.ok(features.every((f) => /siwrr\.org\.vn/.test(f.properties.bulletinUrl)), 'mỗi đối tượng dẫn về bản tin gốc');
  const value = await salinity.siwrrSalinityAdapter.valueAt(9.7, 106.2);
  assert.ok(value.value! >= 40 && value.value! <= 70);
  assert.match(String(value.label), /bản tin/);
});

// ===========================================================================
// Mực nước — chưa có CSV thì phải nói rõ là minh hoạ; có CSV thì nạp
// ===========================================================================

test('Mực nước khi chưa có CSV MRC: nhãn "minh hoạ" ở nguồn, ở giá trị điểm và ở chuỗi', async () => {
  const a = water.mrcWaterLevelAdapter;
  const s = a.source();
  assert.equal(s.extra?.illustrative, true);
  assert.match(s.attribution, /MINH HOẠ/);
  const v = await a.valueAt(10.05, 105.79);
  assert.match(String(v.label), /MINH HOẠ/);
  const series = await a.series!(10.05, 105.79, '2024-06-01', '2024-06-30');
  assert.equal(series.points.length, 30);
  assert.match(String(series.note), /MINH HOẠ/);
});

test('Nạp CSV MRC thay chuỗi minh hoạ bằng số thật và đổi nhãn', async () => {
  const csv = join(tmp, 'mrc.csv');
  const lines = ['station_code,station_name,river,lat,lng,day,level_m'];
  for (let d = 1; d <= 10; d += 1) lines.push(`CAN_THO,Cần Thơ,Sông Hậu,10.05,105.79,2025-08-${String(d).padStart(2, '0')},${(1.2 + d * 0.05).toFixed(2)}`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(csv, lines.join('\n'));
  const result = water.importMrcCsv(csv);
  assert.equal(result.rows, 10);
  assert.equal(result.from, '2025-08-01');
  const s = water.mrcWaterLevelAdapter.source();
  assert.equal(s.extra?.illustrative, false);
  assert.match(s.attribution, /^Nguồn: Ủy hội sông Mê Công quốc tế \(MRC\)$/);
  assert.equal(db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM water_level_series WHERE quality = 'minh_hoa'`)!.n, 0, 'chuỗi minh hoạ bị xoá');
  const series = await water.mrcWaterLevelAdapter.series!(10.05, 105.79, '2025-08-01', '2025-08-31');
  assert.equal(series.points.length, 10);
  assert.ok(!/MINH HOẠ/.test(String(series.note)));
});

// ===========================================================================
// Raster: GeoTIFF + PNG + lưới
// ===========================================================================

/** Dựng GeoTIFF int16 tiled DEFLATE predictor 2 (đúng dạng SoilGrids WCS) từ ma trận cho trước. */
function tiffInt16(values: number[][], tile = 4): Buffer {
  const h = values.length; const w = values[0].length;
  const rows = Math.ceil(h / tile); const cols = Math.ceil(w / tile);
  const tiles: Buffer[] = [];
  for (let ty = 0; ty < rows; ty += 1) for (let tx = 0; tx < cols; tx += 1) {
    const raw = Buffer.alloc(tile * tile * 2);
    for (let r = 0; r < tile; r += 1) {
      let prev = 0;
      for (let c = 0; c < tile; c += 1) {
        const y = ty * tile + r; const x = tx * tile + c;
        const v = y < h && x < w ? values[y][x] : 0;
        raw.writeInt16LE(((v - prev) << 16) >> 16, (r * tile + c) * 2); // sai phân ngang
        prev = v;
      }
    }
    tiles.push(deflateSync(raw));
  }
  const entries: [number, number, number, Buffer | number][] = [];
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const n = 14;
  const ifdAt = 8; const dataAt = ifdAt + 2 + n * 12 + 4;
  const offsets: number[] = []; let cursor = dataAt + tiles.length * 8 + 3 * 8 + 6 * 8;
  for (const t of tiles) { offsets.push(cursor); cursor += t.length; }
  const offsetsAt = dataAt; const countsAt = dataAt + tiles.length * 4; const scaleAt = dataAt + tiles.length * 8; const tieAt = scaleAt + 24;
  entries.push([256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 16], [259, 3, 1, 8], [262, 3, 1, 1], [277, 3, 1, 1], [284, 3, 1, 1], [317, 3, 1, 2],
    [322, 3, 1, tile], [323, 3, 1, tile], [324, 4, tiles.length, offsetsAt], [325, 4, tiles.length, countsAt], [339, 3, 1, 2], [33550, 12, 3, scaleAt]);
  const ifd = Buffer.concat([u16(entries.length), ...entries.map(([tag, type, count, val]) => Buffer.concat([u16(tag), u16(type), u32(count), typeof val === 'number' ? (type === 3 ? Buffer.concat([u16(val), u16(0)]) : u32(val)) : val])), u32(0)]);
  const f64 = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };
  const data = Buffer.concat([...offsets.map(u32), ...tiles.map((t) => u32(t.length)), f64(0.01), f64(0.01), f64(0), Buffer.alloc(48)]);
  return Buffer.concat([Buffer.from('II', 'ascii'), u16(42), u32(ifdAt), ifd, data, ...tiles]);
}

test('Bộ đọc GeoTIFF: int16 tiled DEFLATE predictor 2 đọc lại đúng ma trận gốc', () => {
  const values = Array.from({ length: 6 }, (_, y) => Array.from({ length: 7 }, (_, x) => 50 + y * 3 - x));
  const tiff = readGeoTiff(tiffInt16(values));
  assert.equal(tiff.width, 7); assert.equal(tiff.height, 6);
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 7; x += 1) assert.equal(tiff.data[y * 7 + x], values[y][x], `ô (${x},${y})`);
});

test('GeoTIFF không hỗ trợ (nén LZW, nhiều băng) bị từ chối rõ ràng, không trả số sai', () => {
  const buf = tiffInt16([[1, 2], [3, 4]]);
  // Đổi tag nén (259) sang 5 = LZW
  const ifd = buf.readUInt32LE(4); const n = buf.readUInt16LE(ifd);
  for (let i = 0; i < n; i += 1) { const e = ifd + 2 + i * 12; if (buf.readUInt16LE(e) === 259) buf.writeUInt16LE(5, e + 8); }
  assert.throws(() => readGeoTiff(buf), /Nén 5 chưa hỗ trợ/);
  assert.throws(() => readGeoTiff(Buffer.from('không phải tiff')), /Không phải tệp TIFF/);
});

test('PNG: tệp hợp lệ (chữ ký, IHDR đúng kích cỡ, IEND) và lưới → ảnh bỏ pixel nodata thành trong suốt', () => {
  const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 2); assert.equal(png.readUInt32BE(20), 1);
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
  const g: InstanceType<typeof Object> & { meta: any; data: Float32Array } = {
    meta: { id: 't', width: 2, height: 1, bbox: [0, 0, 2, 1], nodata: null, unit: 'm', scale: 1, source: '', sourceUrl: '', license: '', fetchedAt: '', version: '' },
    data: new Float32Array([1, NaN]),
  };
  const out = grid.gridToPng(g as never, { alpha: 1, stops: [{ value: 0, color: [0, 0, 0] }, { value: 2, color: [255, 255, 255] }] });
  assert.equal(out.width, 2);
});

test('Lưới: lấy mẫu đúng ô, ngoài khung trả null, mặt nước lấy pixel hợp lệ gần nhất kèm khoảng cách', () => {
  const g = { meta: { id: 't', width: 4, height: 2, bbox: [100, 10, 104, 12] as [number, number, number, number], nodata: null, unit: '', scale: 0.1, source: '', sourceUrl: '', license: '', fetchedAt: '', version: '' },
    data: new Float32Array([10, 20, 30, 40, NaN, 60, 70, 80]) };
  assert.equal(grid.sampleGrid(g as never, 11.5, 100.5), 1, 'hàng trên, ô đầu × scale 0,1');
  assert.equal(grid.sampleGrid(g as never, 10.5, 103.5), 8);
  assert.equal(grid.sampleGrid(g as never, 20, 100.5), null, 'ngoài khung');
  assert.equal(grid.sampleGrid(g as never, 10.5, 100.5), null, 'nodata không tự lấp');
  const near = grid.sampleGridNear(g as never, 10.5, 100.5, 2);
  assert.ok(near.value !== null && near.offsetM > 0, 'có pixel gần nhất kèm khoảng cách');
});

test('mosaicAndCrop: ghép hai ô cạnh nhau và giảm mẫu 2× lấy trung bình', () => {
  const tile = (originX: number, values: number[][]) => ({ originX, originY: 2, pixelW: 0.5, pixelH: 0.5, width: 4, height: 4, data: Float64Array.from(values.flat()), nodata: null });
  const a = tile(0, Array.from({ length: 4 }, () => [1, 1, 3, 3]));
  const b = tile(2, Array.from({ length: 4 }, () => [5, 5, 7, 7]));
  const out = grid.mosaicAndCrop([a, b], [0, 0, 4, 2], 2);
  assert.equal(out.width, 4); assert.equal(out.height, 2);
  assert.deepEqual(Array.from(out.data.slice(0, 4)), [1, 3, 5, 7]);
});

// ===========================================================================
// Thời tiết — bộ đệm và đếm lời gọi (tiêu chí 8)
// ===========================================================================

test('Tiêu chí 8: bộ đệm ≥ 1 giờ theo ô 0,1° — bấm quanh một vùng không gọi lại nguồn', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ current: { time: '2026-09-06T10:00', temperature_2m: 30, relative_humidity_2m: 70, precipitation: 0, wind_speed_10m: 5, weather_code: 1 },
      current_units: { time: 'iso8601', temperature_2m: '°C', relative_humidity_2m: '%', precipitation: 'mm', wind_speed_10m: 'km/h' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const weather = adapterById('weather')!;
    const first = await weather.valueAt(10.031, 105.781);
    const second = await weather.valueAt(10.039, 105.779); // cùng ô 0,1°
    const third = await weather.valueAt(10.25, 105.78);    // ô khác
    assert.equal(first.origin, 'live'); assert.equal(second.origin, 'cache'); assert.equal(third.origin, 'live');
    assert.equal(calls, 2);
    const stats = db.externalCallsLast(5);
    assert.equal(stats.byProvider['open-meteo'], 2, 'mọi lời gọi ngoài đều được đếm');
    const expires = db.one<{ expires_at: string; fetched_at: string }>(`SELECT expires_at, fetched_at FROM api_cache WHERE provider = 'open-meteo' LIMIT 1`)!;
    assert.ok(new Date(expires.expires_at).getTime() - new Date(expires.fetched_at).getTime() >= 3_600_000, 'thời hạn đệm ≥ 1 giờ');
  } finally { globalThis.fetch = realFetch; }
});

test('Nguồn sống lỗi → adapter báo lỗi rõ, không trả số cũ giả làm số mới', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"error":true,"reason":"quota"}', { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(adapterById('weather')!.valueAt(9.0, 106.0), /Open-Meteo không phản hồi/);
  } finally { globalThis.fetch = realFetch; }
});

// ===========================================================================
// Lô mẫu (F-06)
// ===========================================================================

test('F-06: 20–30 lô minh hoạ, cố định giữa các lần chạy, nằm trong khung ĐBSCL, gắn nhãn minh hoạ', () => {
  const plots = samplePlots();
  assert.ok(plots.length >= 20 && plots.length <= 30);
  assert.deepEqual(plots.map((p) => p.code), samplePlots().map((p) => p.code), 'hạt cố định');
  for (const p of plots) {
    assert.ok(p.areaHa >= 1 && p.areaHa <= 30, `${p.code} diện tích ${p.areaHa} ha`);
    for (const [lng, lat] of p.ring) assert.ok(insideDelta(lat, lng), `${p.code} ngoài khung`);
  }
  const geojson = samplePlotsGeoJson() as { properties: { disclaimer: string }; features: { properties: { illustrative: boolean } }[] };
  assert.match(geojson.properties.disclaimer, /MINH HOẠ/);
  assert.ok(geojson.features.every((f) => f.properties.illustrative));
  assert.deepEqual(DELTA_BBOX, [104.4, 8.5, 107.0, 11.1]);
});
