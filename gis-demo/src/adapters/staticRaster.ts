/**
 * ADAPTER RASTER TĨNH — thổ nhưỡng (SoilGrids) và địa hình (Copernicus DEM).
 *
 * Dữ liệu đã tải một lần bằng `fetchStatic.ts`, nằm trong gis-demo/data/rasters
 * (lưới Float32 + ảnh phủ PNG). Mã phục vụ này KHÔNG gọi mạng — giá trị tại điểm
 * là một phép chia trên lưới trong bộ nhớ.
 *
 * Nhãn trạng thái: "Dữ liệu tĩnh — chụp ngày <ngày tải>" (F-05, R-04).
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadGrid, sampleGrid, sampleGridNear, type Grid } from '../raster/grid.ts';
import type { LayerAdapter, PointValue, SourceInfo } from './types.ts';
import { DEM_LEGEND, SOIL_PROPERTIES } from './palettes.ts';

const RASTER_DIR = process.env.GIS_DEMO_RASTERS ?? join(process.cwd(), 'gis-demo', 'data', 'rasters');
const grids = new Map<string, Grid | null>();

function grid(id: string): Grid | null {
  if (!grids.has(id)) grids.set(id, loadGrid(join(RASTER_DIR, id)));
  return grids.get(id) ?? null;
}

export function rasterPngPath(id: string): string | null {
  const path = join(RASTER_DIR, `${id}.png`);
  return existsSync(path) ? path : null;
}

function makeAdapter(spec: {
  id: string; layerName: string; unit: string; legend: SourceInfo['legend']; caveat: string;
  /** Các lưới phụ đọc kèm khi bấm điểm (thổ nhưỡng đọc cả pH, sét, carbon). */
  companions?: { id: string; label: string; unit: string }[];
}): LayerAdapter {
  return {
    source(): SourceInfo {
      const g = grid(spec.id);
      const missing = !g;
      return {
        id: spec.id, layerName: spec.layerName,
        providerName: g?.meta.source ?? 'chưa tải dữ liệu',
        attribution: g ? (spec.id === 'terrain' ? '© Copernicus DEM' : '© ISRIC — World Soil Information / SoilGrids') : 'Chưa có dữ liệu — chạy npm run gis-demo:fetch',
        attributionUrl: g?.meta.sourceUrl ?? '', license: g?.meta.license ?? '',
        status: 'tinh', dataTimestamp: g?.meta.version ?? null, snapshotDate: g?.meta.fetchedAt ?? null,
        unit: spec.unit, render: 'raster', legend: spec.legend, hasSeries: false,
        caveat: missing ? 'Raster chưa được tải về máy — lớp này trống cho tới khi chạy lệnh tải.' : `${spec.caveat} ${g!.meta.note ?? ''}`.trim(),
        extra: g ? { gridSize: [g.meta.width, g.meta.height], version: g.meta.version } : undefined,
      };
    },
    updatedAt() { return grid(spec.id)?.meta.fetchedAt ?? null; },
    async valueAt(lat, lng): Promise<PointValue> {
      const g = grid(spec.id);
      if (!g) return { value: null, unit: spec.unit, dataTimestamp: null, label: 'Chưa tải dữ liệu', origin: 'static' };
      const near = sampleGridNear(g, lat, lng, 4);
      const value = near.value;
      const details: PointValue['details'] = {};
      for (const c of spec.companions ?? []) {
        const cg = grid(c.id);
        details[c.id] = { value: cg ? sampleGridNear(cg, lat, lng, 4).value : null, unit: c.unit, label: c.label };
      }
      return {
        value: value === null ? null : Math.round(value * 10) / 10, unit: spec.unit,
        dataTimestamp: g.meta.version,
        label: value === null
          ? `${spec.layerName} — không có dữ liệu trong ~1 km (mặt nước hoặc ngoài vùng phủ)`
          : near.offsetM > 0 ? `${spec.layerName} — pixel đúng chỗ là mặt nước, lấy pixel hợp lệ gần nhất cách ~${near.offsetM} m` : spec.layerName,
        details: Object.keys(details).length ? details : undefined, origin: 'static',
      };
    },
    async mapData() {
      const g = grid(spec.id);
      return { kind: 'raster', imageUrl: `/api/layers/${spec.id}/image`, bbox: g?.meta.bbox ?? [104.4, 8.5, 107.0, 11.1] };
    },
  };
}

const ph = SOIL_PROPERTIES.find((p) => p.id === 'soil-ph')!;
export const soilAdapter = makeAdapter({
  id: 'soil-ph', layerName: 'Thổ nhưỡng — pH tầng mặt', unit: ph.unit, legend: ph.legend,
  caveat: 'Raster tải sẵn một lần, 250 m, phục vụ tĩnh. Ước lượng mô hình toàn cầu — không thay được phân tích mẫu đất tại lô.',
  companions: SOIL_PROPERTIES.filter((p) => p.id !== 'soil-ph').map((p) => ({ id: p.id, label: p.label, unit: p.unit })),
});

export const terrainAdapter = makeAdapter({
  id: 'terrain', layerName: 'Địa hình — cao độ mặt', unit: 'm', legend: DEM_LEGEND,
  caveat: 'Raster tải sẵn một lần, giảm mẫu ~270 m, phục vụ tĩnh. Cao độ MẶT (gồm cây, nhà) so với EGM2008, không phải cao độ nền.',
});

/** Các lưới phụ của thổ nhưỡng cũng có ảnh phủ riêng — cho phép đổi biến trong lớp. */
export const SOIL_VARIANTS = SOIL_PROPERTIES.map((p) => ({ id: p.id, label: p.label, unit: p.unit, legend: p.legend }));
