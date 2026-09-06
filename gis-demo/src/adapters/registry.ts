/**
 * SỔ ĐĂNG KÝ ADAPTER — nơi duy nhất biết lớp nào dùng nguồn nào.
 * Đổi nguồn = đổi một dòng ở đây. Giao diện chỉ thấy danh sách source().
 */
import type { LayerAdapter } from './types.ts';
import { openMeteoAdapter } from './openMeteo.ts';
import { soilAdapter, terrainAdapter } from './staticRaster.ts';
import { mrcWaterLevelAdapter } from './mrcWaterLevel.ts';
import { siwrrSalinityAdapter } from './siwrrSalinity.ts';

/** Thứ tự = thứ tự trong drop-list chọn lớp. */
export const ADAPTERS: LayerAdapter[] = [
  openMeteoAdapter,
  soilAdapter,
  terrainAdapter,
  mrcWaterLevelAdapter,
  siwrrSalinityAdapter,
];

export function adapterById(id: string): LayerAdapter | null {
  return ADAPTERS.find((a) => a.source().id === id) ?? null;
}
