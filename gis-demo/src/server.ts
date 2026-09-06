/**
 * MÁY CHỦ DEMO LỚP DỮ LIỆU GIS — độc lập với AgriGreen, không đăng nhập (F-07).
 *
 * Chạy: npm run gis-demo   →  http://localhost:4190
 *
 * API chỉ nói chuyện với adapter (R-01). Không route nào ở đây gọi ra ngoài.
 *   GET /api/layers                     danh sách lớp = source() của từng adapter
 *   GET /api/layers/:id/map             dữ liệu vẽ: ảnh phủ (raster) hoặc GeoJSON
 *   GET /api/layers/:id/image           PNG raster tĩnh (kể cả biến phụ: soil-clay, soil-soc)
 *   GET /api/layers/:id/value?lat&lng   giá trị tại điểm (F-03)
 *   GET /api/layers/:id/series?lat&lng&from&to   chuỗi thời gian (F-04)
 *   GET /api/plots                      lô mẫu minh hoạ (F-06)
 *   GET /api/stats                      số lời gọi ngoài 5 phút / 60 phút — tiêu chí 8
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, adapterById } from './adapters/registry.ts';
import { rasterPngPath, SOIL_VARIANTS } from './adapters/staticRaster.ts';
import { importMrcCsv } from './adapters/mrcWaterLevel.ts';
import { loadSalinity } from './adapters/siwrrSalinity.ts';
import { samplePlotsGeoJson } from './samplePlots.ts';
import { DELTA_BBOX } from './adapters/types.ts';
import { BASEMAP } from './adapters/basemap.ts';
import { db, externalCallsLast, logAccess } from './db.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(HERE, '..', 'web');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

function json(res: ServerResponse, status: number, payload: unknown, cacheSeconds = 0): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
  });
  res.end(body);
}

const num = (v: string | null, name: string): number => {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) throw new Error(`Thiếu hoặc sai tham số ${name}`);
  return n;
};

export async function handleApi(url: URL, res: ServerResponse): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[0] !== 'api') return false;

  if (parts.length === 2 && parts[1] === 'health') { json(res, 200, { ok: true, service: 'gis-demo', time: new Date().toISOString() }); return true; }
  if (parts.length === 2 && parts[1] === 'stats') {
    json(res, 200, { externalCalls: { last5min: externalCallsLast(5), last60min: externalCallsLast(60) }, criterion8: { limitPer5min: 50 } });
    return true;
  }
  if (parts.length === 2 && parts[1] === 'plots') { json(res, 200, samplePlotsGeoJson(), 60); return true; }
  if (parts.length === 2 && parts[1] === 'layers') {
    json(res, 200, {
      bbox: DELTA_BBOX,
      layers: ADAPTERS.map((a) => a.source()),
      soilVariants: SOIL_VARIANTS,
      // Nền bản đồ lấy từ adapter (R-01, R-02) — server không biết URL tile nào.
      basemap: { attribution: BASEMAP.attribution, attributionUrl: BASEMAP.attributionUrl, license: BASEMAP.license, note: BASEMAP.note, providers: BASEMAP.providers() },
    });
    return true;
  }

  if (parts[1] === 'layers' && parts.length === 4) {
    const [, , id, action] = parts;
    if (action === 'image') {
      const path = rasterPngPath(id);
      if (!path) { json(res, 404, { error: `Chưa có ảnh raster cho ${id} — chạy npm run gis-demo:fetch` }); return true; }
      const buffer = await readFile(path);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buffer.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(buffer);
      return true;
    }
    const adapter = adapterById(id);
    if (!adapter) { json(res, 404, { error: `Không có lớp ${id}` }); return true; }
    if (action === 'map') { json(res, 200, await adapter.mapData(), 60); return true; }
    if (action === 'value') {
      const lat = num(url.searchParams.get('lat'), 'lat');
      const lng = num(url.searchParams.get('lng'), 'lng');
      json(res, 200, await adapter.valueAt(lat, lng, url.searchParams.get('at') ?? undefined));
      return true;
    }
    if (action === 'series') {
      if (!adapter.series) { json(res, 400, { error: 'Lớp này không có chiều thời gian' }); return true; }
      const lat = num(url.searchParams.get('lat'), 'lat');
      const lng = num(url.searchParams.get('lng'), 'lng');
      const from = url.searchParams.get('from') ?? '2015-01-01';
      const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
      json(res, 200, await adapter.series(lat, lng, from, to));
      return true;
    }
  }
  json(res, 404, { error: 'Endpoint không tồn tại' });
  return true;
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(WEB_ROOT, safe);
  if (!filePath.startsWith(WEB_ROOT)) { json(res, 403, { error: 'Từ chối' }); return; }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    const html = await readFile(join(WEB_ROOT, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
  }
}

export function bootstrapData(): void {
  db();
  loadSalinity();
  const imported = importMrcCsv();
  if (imported.rows) console.log(`  Mực nước: nạp ${imported.rows} dòng MRC (${imported.from} → ${imported.to})`);
  else console.log('  Mực nước: CHƯA có CSV MRC — lớp hiển thị chuỗi minh hoạ có nhãn');
}

export async function start(port = Number(process.env.GIS_DEMO_PORT ?? 4190)): Promise<void> {
  bootstrapData();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const t0 = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (!(await handleApi(url, res))) await serveStatic(url.pathname, res);
    } catch (error) {
      json(res, 400, { error: (error as Error).message });
    } finally {
      // R-05: không IP, không user-agent, không định danh — chỉ đường dẫn và thời gian.
      try { logAccess(url.pathname, res.statusCode, Date.now() - t0); } catch { /* bỏ qua */ }
    }
  });
  await new Promise<void>((done) => server.listen(port, done));
  console.log(`\n  Demo lớp dữ liệu GIS đang chạy: http://localhost:${port}\n  ${ADAPTERS.length} lớp: ${ADAPTERS.map((a) => a.source().layerName).join(' · ')}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  start().catch((error) => { console.error('Không khởi động được:', error); process.exit(1); });
}
