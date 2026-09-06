/**
 * TẢI DỮ LIỆU TĨNH MỘT LẦN — thổ nhưỡng (SoilGrids) và địa hình (Copernicus DEM).
 *
 * Chạy: npm run gis-demo:fetch
 *
 * Tải → giải mã GeoTIFF → ghép và cắt theo khung bao ĐBSCL → lưu lưới Float32 +
 * ảnh phủ PNG vào gis-demo/data/rasters. Ghi lại URL, ngày tải, phiên bản vào
 * sources.json để bảng nguồn của báo cáo spike có số thật.
 *
 * R-01: đây là adapter-lệnh (chạy một lần) của hai nguồn tĩnh; mã phục vụ chỉ đọc tệp.
 * R-02: không đụng tới OpenStreetMap.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGeoTiff } from '../raster/geotiff.ts';
import { gridToPng, mosaicAndCrop, saveGrid, type GridMeta, type Palette } from '../raster/grid.ts';
import { DELTA_BBOX } from '../adapters/types.ts';
import { DEM_PALETTE, SOIL_PROPERTIES } from '../adapters/palettes.ts';

const DATA_DIR = join(process.cwd(), 'gis-demo', 'data');
const RASTER_DIR = join(DATA_DIR, 'rasters');
const SOURCES_FILE = join(DATA_DIR, 'sources.json');
mkdirSync(RASTER_DIR, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const sources: Record<string, unknown> = existsSync(SOURCES_FILE) ? JSON.parse(readFileSync(SOURCES_FILE, 'utf8')) : {};

async function download(url: string, label: string, retries = 2): Promise<Buffer | null> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      console.log(`  ✓ ${label}: ${(buffer.length / 1_048_576).toFixed(1)} MB`);
      return buffer;
    } catch (error) {
      console.log(`  ✗ ${label} (lần ${attempt + 1}): ${(error as Error).message}`);
      if (attempt === retries) throw error;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SoilGrids — WCS GetCoverage, cắt theo khung bao, 250 m, từng thuộc tính
// ---------------------------------------------------------------------------

async function fetchSoilGrids(): Promise<void> {
  const [w, s, e, n] = DELTA_BBOX;
  for (const prop of SOIL_PROPERTIES) {
    console.log(`SoilGrids ${prop.code} (${prop.label})`);
    const coverage = `${prop.code}_0-5cm_mean`;
    // Chia 2×2 để mỗi yêu cầu nhỏ (máy chủ ISRIC giới hạn kích cỡ trả về).
    const tiles = [];
    const midLng = (w + e) / 2;
    const midLat = (s + n) / 2;
    for (const [x0, x1] of [[w, midLng], [midLng, e]]) {
      for (const [y0, y1] of [[s, midLat], [midLat, n]]) {
        const url = `https://maps.isric.org/mapserv?map=/map/${prop.code}.map&SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage`
          + `&COVERAGEID=${coverage}&FORMAT=image/tiff&SUBSET=long(${x0},${x1})&SUBSET=lat(${y0},${y1})`
          + '&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&OUTPUTCRS=http://www.opengis.net/def/crs/EPSG/0/4326';
        const buffer = await download(url, `${prop.code} [${x0.toFixed(1)}–${x1.toFixed(1)} × ${y0.toFixed(1)}–${y1.toFixed(1)}]`);
        if (buffer) tiles.push({ ...readGeoTiff(buffer), nodata: 0 }); // WCS trả 0 cho mặt nước / ngoài vùng
      }
    }
    const grid = mosaicAndCrop(tiles, DELTA_BBOX, 1);
    const meta: GridMeta = {
      id: prop.id, width: grid.width, height: grid.height, bbox: DELTA_BBOX, nodata: null,
      unit: prop.unit, scale: prop.scale,
      source: 'SoilGrids 2.0 (ISRIC — World Soil Information)', sourceUrl: 'https://soilgrids.org',
      license: 'CC BY 4.0', fetchedAt: today, version: `SoilGrids v2.0, coverage ${coverage}, 250 m, WCS maps.isric.org`,
      note: 'Độ sâu 0–5 cm, giá trị trung bình (mean).',
    };
    // NaN đã là nodata trong lưới ghép.
    saveGrid(join(RASTER_DIR, prop.id), meta, grid.data);
    const { png, width, height } = gridToPng({ meta, data: grid.data }, prop.palette);
    writeFileSync(join(RASTER_DIR, `${prop.id}.png`), png);
    sources[prop.id] = { ...meta, pngSize: png.length, pngDims: [width, height] };
    console.log(`  → lưới ${grid.width}×${grid.height}, ảnh ${width}×${height} (${(png.length / 1024).toFixed(0)} KB)`);
  }
}

// ---------------------------------------------------------------------------
// Copernicus DEM GLO-90 — ô 1°×1° công khai trên AWS Open Data
// ---------------------------------------------------------------------------

async function fetchCopernicusDem(): Promise<void> {
  console.log('Copernicus DEM GLO-90');
  const [w, s, e, n] = DELTA_BBOX;
  const tiles = [];
  const fetchedUrls: string[] = [];
  for (let lat = Math.floor(s); lat < n; lat += 1) {
    for (let lng = Math.floor(w); lng < e; lng += 1) {
      const name = `Copernicus_DSM_COG_30_N${String(lat).padStart(2, '0')}_00_E${String(lng).padStart(3, '0')}_00_DEM`;
      const url = `https://copernicus-dem-90m.s3.amazonaws.com/${name}/${name}.tif`;
      const buffer = await download(url, name);
      if (!buffer) { console.log(`  · ${name}: không có ô (biển)`); continue; }
      tiles.push({ ...readGeoTiff(buffer), nodata: null });
      fetchedUrls.push(url);
    }
  }
  // Giảm mẫu 3× (≈ 270 m) — đủ cho bản đồ vùng, lưới còn ~1 000×1 000.
  const grid = mosaicAndCrop(tiles, DELTA_BBOX, 3);
  const meta: GridMeta = {
    id: 'terrain', width: grid.width, height: grid.height, bbox: DELTA_BBOX, nodata: null,
    unit: 'm', scale: 1,
    source: 'Copernicus DEM GLO-90 (ESA / Airbus), qua AWS Open Data', sourceUrl: 'https://registry.opendata.aws/copernicus-dem/',
    license: 'Giấy phép Copernicus DEM (dùng thương mại được, ghi nguồn bắt buộc)', fetchedAt: today,
    version: `GLO-90 (2022 release), ${tiles.length} ô 1°, giảm mẫu 3× từ 90 m`,
    note: 'Cao độ mặt (DSM) so với EGM2008. Brief ghi GLO-30; demo dùng GLO-90 để tải một lần ~70 MB thay vì ~400 MB — xem báo cáo.',
  };
  saveGrid(join(RASTER_DIR, 'terrain'), meta, grid.data);
  const { png, width, height } = gridToPng({ meta, data: grid.data }, DEM_PALETTE as Palette);
  writeFileSync(join(RASTER_DIR, 'terrain.png'), png);
  sources.terrain = { ...meta, tiles: fetchedUrls, pngSize: png.length, pngDims: [width, height] };
  console.log(`  → lưới ${grid.width}×${grid.height}, ảnh ${width}×${height} (${(png.length / 1024).toFixed(0)} KB)`);
}

const only = process.argv[2];
if (!only || only === 'soil') await fetchSoilGrids();
if (!only || only === 'terrain') await fetchCopernicusDem();
writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2));
console.log(`Đã ghi ${SOURCES_FILE}`);
