/**
 * Lưới raster đã cắt theo khung bao ĐBSCL — định dạng phục vụ tĩnh của demo.
 *
 * Một lưới = tệp nhị phân Float32 (theo hàng, từ bắc xuống nam) + tệp .json mô tả
 * (khung bao, kích cỡ, nodata, đơn vị, nguồn, ngày tải). Đọc giá trị tại điểm là
 * một phép chia, không cần thư viện GIS. Ảnh phủ PNG được dựng một lần từ lưới.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodePng } from './png.ts';

export interface GridMeta {
  id: string;
  width: number;
  height: number;
  /** Khung bao theo độ: west, south, east, north. */
  bbox: [number, number, number, number];
  nodata: number | null;
  unit: string;
  /** Hệ số nhân để ra đơn vị hiển thị (SoilGrids lưu pH×10). */
  scale: number;
  source: string;
  sourceUrl: string;
  license: string;
  fetchedAt: string;
  version: string;
  note?: string;
}

export interface Grid { meta: GridMeta; data: Float32Array }

export function saveGrid(basePath: string, meta: GridMeta, data: Float32Array): void {
  mkdirSync(dirname(basePath), { recursive: true });
  writeFileSync(`${basePath}.json`, JSON.stringify(meta, null, 2));
  writeFileSync(`${basePath}.f32`, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

export function loadGrid(basePath: string): Grid | null {
  if (!existsSync(`${basePath}.json`) || !existsSync(`${basePath}.f32`)) return null;
  const meta = JSON.parse(readFileSync(`${basePath}.json`, 'utf8')) as GridMeta;
  const raw = readFileSync(`${basePath}.f32`);
  const data = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  return { meta, data };
}

/** Giá trị đã nhân scale tại toạ độ; null khi ngoài khung hoặc nodata. */
export function sampleGrid(grid: Grid, lat: number, lng: number): number | null {
  return sampleGridNear(grid, lat, lng, 0).value;
}

/**
 * Như sampleGrid nhưng khi pixel đúng chỗ là nodata (mặt nước, kênh) thì tìm pixel
 * hợp lệ gần nhất trong bán kính `radiusPx`. Trả về cả khoảng cách để giao diện
 * nói rõ "giá trị lấy ở cách điểm bấm ~X m" — không giả vờ là đúng chỗ.
 */
export function sampleGridNear(grid: Grid, lat: number, lng: number, radiusPx = 4): { value: number | null; offsetM: number } {
  const [w, s, e, n] = grid.meta.bbox;
  if (lng < w || lng > e || lat < s || lat > n) return { value: null, offsetM: 0 };
  const x0 = Math.min(grid.meta.width - 1, Math.floor(((lng - w) / (e - w)) * grid.meta.width));
  const y0 = Math.min(grid.meta.height - 1, Math.floor(((n - lat) / (n - s)) * grid.meta.height));
  const valid = (v: number) => Number.isFinite(v) && !(grid.meta.nodata !== null && v === grid.meta.nodata);
  const at = (x: number, y: number) => grid.data[y * grid.meta.width + x];
  if (valid(at(x0, y0))) return { value: at(x0, y0) * grid.meta.scale, offsetM: 0 };
  const pxM = ((e - w) / grid.meta.width) * 111_320 * Math.cos((lat * Math.PI) / 180);
  for (let r = 1; r <= radiusPx; r += 1) {
    let best: { v: number; d: number } | null = null;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx; const y = y0 + dy;
        if (x < 0 || y < 0 || x >= grid.meta.width || y >= grid.meta.height) continue;
        const v = at(x, y);
        if (!valid(v)) continue;
        const d = Math.hypot(dx, dy);
        if (!best || d < best.d) best = { v, d };
      }
    }
    if (best) return { value: best.v * grid.meta.scale, offsetM: Math.round(best.d * pxM) };
  }
  return { value: null, offsetM: 0 };
}

export type Palette = { stops: { value: number; color: [number, number, number] }[]; alpha: number };

function colorAt(palette: Palette, value: number): [number, number, number] {
  const stops = palette.stops;
  if (value <= stops[0].value) return stops[0].color;
  for (let i = 1; i < stops.length; i += 1) {
    if (value <= stops[i].value) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = (value - a.value) / (b.value - a.value || 1);
      return [0, 1, 2].map((k) => Math.round(a.color[k] + (b.color[k] - a.color[k]) * t)) as [number, number, number];
    }
  }
  return stops[stops.length - 1].color;
}

/** Ảnh phủ PNG từ lưới, giảm mẫu để tải nhanh trên điện thoại. */
export function gridToPng(grid: Grid, palette: Palette, maxSize = 700): { png: Buffer; width: number; height: number } {
  const step = Math.max(1, Math.ceil(Math.max(grid.meta.width, grid.meta.height) / maxSize));
  const width = Math.ceil(grid.meta.width / step);
  const height = Math.ceil(grid.meta.height / step);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // lấy trung vị nhanh: điểm giữa của khối
      const sx = Math.min(grid.meta.width - 1, x * step + Math.floor(step / 2));
      const sy = Math.min(grid.meta.height - 1, y * step + Math.floor(step / 2));
      const raw = grid.data[sy * grid.meta.width + sx];
      const at = (y * width + x) * 4;
      if (!Number.isFinite(raw) || (grid.meta.nodata !== null && raw === grid.meta.nodata)) { rgba[at + 3] = 0; continue; }
      const [r, g, b] = colorAt(palette, raw * grid.meta.scale);
      rgba[at] = r; rgba[at + 1] = g; rgba[at + 2] = b; rgba[at + 3] = Math.round(palette.alpha * 255);
    }
  }
  return { png: encodePng(width, height, rgba), width, height };
}

/**
 * Ghép nhiều ô GeoTIFF (đã đọc) thành một lưới và cắt theo khung bao, giảm mẫu
 * theo hệ số `factor` (lấy trung bình các pixel hợp lệ trong khối).
 */
export function mosaicAndCrop(
  tiles: { originX: number; originY: number; pixelW: number; pixelH: number; width: number; height: number; data: Float64Array; nodata: number | null }[],
  bbox: [number, number, number, number],
  factor: number,
): { width: number; height: number; data: Float32Array } {
  if (!tiles.length) throw new Error('Không có ô raster nào để ghép');
  const pw = tiles[0].pixelW * factor;
  const ph = tiles[0].pixelH * factor;
  const [w, s, e, n] = bbox;
  const width = Math.floor((e - w) / pw);
  const height = Math.floor((n - s) / ph);
  const out = new Float32Array(width * height).fill(NaN);
  for (let y = 0; y < height; y += 1) {
    const latTop = n - y * ph;
    for (let x = 0; x < width; x += 1) {
      const lngLeft = w + x * pw;
      let sum = 0;
      let count = 0;
      for (const tile of tiles) {
        // khối factor×factor pixel gốc nằm trong ô này?
        const px0 = Math.floor((lngLeft - tile.originX) / tile.pixelW);
        const py0 = Math.floor((tile.originY - latTop) / tile.pixelH);
        if (px0 + factor <= 0 || py0 + factor <= 0 || px0 >= tile.width || py0 >= tile.height) continue;
        for (let dy = 0; dy < factor; dy += 1) {
          const py = py0 + dy;
          if (py < 0 || py >= tile.height) continue;
          for (let dx = 0; dx < factor; dx += 1) {
            const px = px0 + dx;
            if (px < 0 || px >= tile.width) continue;
            const v = tile.data[py * tile.width + px];
            if (!Number.isFinite(v) || (tile.nodata !== null && v === tile.nodata)) continue;
            sum += v; count += 1;
          }
        }
      }
      if (count) out[y * width + x] = sum / count;
    }
  }
  return { width, height, data: out };
}
