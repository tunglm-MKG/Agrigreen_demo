/**
 * Bộ đọc GeoTIFF tối giản — đủ cho hai nguồn raster của demo, không thư viện.
 *
 * Hỗ trợ đúng những gì hai nguồn dùng (đã kiểm bằng tag TIFF thật):
 *   SoilGrids WCS   : int16, tiled 256, DEFLATE (8), predictor 2 (sai phân ngang)
 *   Copernicus DEM  : float32, tiled 2048, DEFLATE (8), predictor 3 (sai phân byte số thực)
 * Cùng một băng, một mẫu/pixel, tiled hoặc strip. Gặp thứ khác thì báo lỗi rõ
 * thay vì trả số sai — raster đọc sai không có cách nào phát hiện bằng mắt.
 */
import { inflateSync } from 'node:zlib';

export interface GeoTiff {
  width: number;
  height: number;
  /** Giá trị theo hàng, từ trên xuống, trái sang phải. */
  data: Float64Array;
  nodata: number | null;
  /** Toạ độ góc trên-trái của pixel (0,0) và kích cỡ pixel theo độ. */
  originX: number;
  originY: number;
  pixelW: number;
  pixelH: number;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 11: 4, 12: 8, 16: 8 };

export function readGeoTiff(buffer: Buffer): GeoTiff {
  const le = buffer.toString('ascii', 0, 2) === 'II';
  if (!le && buffer.toString('ascii', 0, 2) !== 'MM') throw new Error('Không phải tệp TIFF');
  const magic = le ? buffer.readUInt16LE(2) : buffer.readUInt16BE(2);
  if (magic !== 42) throw new Error('BigTIFF chưa hỗ trợ');
  const u16 = (at: number) => (le ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
  const u32 = (at: number) => (le ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const f64 = (at: number) => (le ? buffer.readDoubleLE(at) : buffer.readDoubleBE(at));

  const ifd = u32(4);
  const count = u16(ifd);
  const tags = new Map<number, { type: number; count: number; valueAt: number }>();
  for (let i = 0; i < count; i += 1) {
    const e = ifd + 2 + i * 12;
    const type = u16(e + 2);
    const n = u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    tags.set(u16(e), { type, count: n, valueAt: size <= 4 ? e + 8 : u32(e + 8) });
  }
  const num = (tag: number, index = 0): number | null => {
    const t = tags.get(tag);
    if (!t) return null;
    const at = t.valueAt + index * (TYPE_SIZE[t.type] ?? 1);
    if (t.type === 3) return u16(at);
    if (t.type === 4) return u32(at);
    if (t.type === 12) return f64(at);
    if (t.type === 11) return le ? buffer.readFloatLE(at) : buffer.readFloatBE(at);
    return null;
  };
  const list = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) return [];
    return Array.from({ length: t.count }, (_, i) => num(tag, i)!);
  };
  const ascii = (tag: number): string | null => {
    const t = tags.get(tag);
    return t ? buffer.toString('ascii', t.valueAt, t.valueAt + t.count).replace(/\0+$/, '') : null;
  };

  const width = num(256)!;
  const height = num(257)!;
  const bits = num(258) ?? 8;
  const compression = num(259) ?? 1;
  const samples = num(277) ?? 1;
  const predictor = num(317) ?? 1;
  const sampleFormat = num(339) ?? 1; // 1 uint, 2 int, 3 float
  if (samples !== 1) throw new Error(`Chỉ hỗ trợ 1 băng, tệp có ${samples}`);
  if (compression !== 1 && compression !== 8 && compression !== 32946) {
    throw new Error(`Nén ${compression} chưa hỗ trợ (chỉ không nén hoặc DEFLATE)`);
  }
  const bytes = bits / 8;
  if (![1, 2, 4].includes(bytes)) throw new Error(`Độ sâu ${bits} bit chưa hỗ trợ`);

  const tiled = tags.has(322);
  const tileW = tiled ? num(322)! : width;
  const tileH = tiled ? num(323)! : (num(278) ?? height);
  const offsets = list(tiled ? 324 : 273);
  const counts = list(tiled ? 325 : 279);
  const tilesAcross = Math.ceil(width / tileW);

  const data = new Float64Array(width * height);
  const readSample = (buf: Buffer, at: number): number => {
    if (sampleFormat === 3) return bytes === 4 ? (le ? buf.readFloatLE(at) : buf.readFloatBE(at)) : (le ? buf.readDoubleLE(at) : buf.readDoubleBE(at));
    if (sampleFormat === 2) return bytes === 1 ? buf.readInt8(at) : bytes === 2 ? (le ? buf.readInt16LE(at) : buf.readInt16BE(at)) : (le ? buf.readInt32LE(at) : buf.readInt32BE(at));
    return bytes === 1 ? buf.readUInt8(at) : bytes === 2 ? (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at)) : (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  };

  offsets.forEach((offset, index) => {
    let block = buffer.subarray(offset, offset + counts[index]);
    if (compression !== 1) block = inflateSync(block);
    const rowBytes = tileW * bytes;
    const rows = Math.min(tileH, Math.ceil(block.length / rowBytes));
    if (predictor === 2) undoHorizontalDifferencing(block, tileW, rows, bytes, sampleFormat, le);
    if (predictor === 3) undoFloatingPointPredictor(block, tileW, rows, bytes);
    const tileX = tiled ? (index % tilesAcross) * tileW : 0;
    const tileY = tiled ? Math.floor(index / tilesAcross) * tileH : index * tileH;
    for (let r = 0; r < rows; r += 1) {
      const y = tileY + r;
      if (y >= height) break;
      for (let c = 0; c < tileW; c += 1) {
        const x = tileX + c;
        if (x >= width) break;
        data[y * width + x] = readSample(block, (r * tileW + c) * bytes);
      }
    }
  });

  const scale = list(33550);
  const tie = list(33922);
  const nodataText = ascii(42113);
  const nodata = nodataText !== null && nodataText !== '' && Number.isFinite(Number(nodataText)) ? Number(nodataText) : null;
  return {
    width, height, data, nodata,
    originX: tie.length >= 6 ? tie[3] - tie[0] * (scale[0] ?? 0) : 0,
    originY: tie.length >= 6 ? tie[4] + tie[1] * (scale[1] ?? 0) : 0,
    pixelW: scale[0] ?? 1,
    pixelH: scale[1] ?? 1,
  };
}

/** Predictor 2: mỗi mẫu là sai phân so với mẫu bên trái, cộng dồn theo hàng. */
function undoHorizontalDifferencing(block: Buffer, width: number, rows: number, bytes: number, sampleFormat: number, le: boolean): void {
  for (let r = 0; r < rows; r += 1) {
    const base = r * width * bytes;
    for (let c = 1; c < width; c += 1) {
      const at = base + c * bytes;
      const prev = at - bytes;
      if (bytes === 1) block[at] = (block[at] + block[prev]) & 0xff;
      else if (bytes === 2) {
        const v = ((le ? block.readUInt16LE(at) : block.readUInt16BE(at)) + (le ? block.readUInt16LE(prev) : block.readUInt16BE(prev))) & 0xffff;
        if (le) block.writeUInt16LE(v, at); else block.writeUInt16BE(v, at);
      } else {
        const v = ((le ? block.readUInt32LE(at) : block.readUInt32BE(at)) + (le ? block.readUInt32LE(prev) : block.readUInt32BE(prev))) >>> 0;
        if (le) block.writeUInt32LE(v, at); else block.writeUInt32BE(v, at);
      }
    }
  }
  void sampleFormat;
}

/**
 * Predictor 3 (floating point): trong mỗi hàng, các byte được sai phân rồi xếp
 * theo "mặt phẳng byte" (tất cả byte thứ 0 của mọi mẫu, rồi byte thứ 1, ...)
 * theo thứ tự big-endian. Giải: cộng dồn byte theo hàng, rồi xếp lại thành
 * little-endian cho từng mẫu.
 */
function undoFloatingPointPredictor(block: Buffer, width: number, rows: number, bytes: number): void {
  const rowBytes = width * bytes;
  const tmp = Buffer.alloc(rowBytes);
  for (let r = 0; r < rows; r += 1) {
    const base = r * rowBytes;
    for (let i = 1; i < rowBytes; i += 1) block[base + i] = (block[base + i] + block[base + i - 1]) & 0xff;
    for (let c = 0; c < width; c += 1) {
      for (let b = 0; b < bytes; b += 1) {
        // mặt phẳng byte b (big-endian: b = 0 là byte cao) → vị trí little-endian
        tmp[c * bytes + (bytes - 1 - b)] = block[base + b * width + c];
      }
    }
    tmp.copy(block, base, 0, rowBytes);
  }
}
