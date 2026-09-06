/**
 * Thuộc tính thổ nhưỡng lấy về và bảng màu cho hai lớp raster.
 * Bảng màu chọn theo ý nghĩa nông học của ĐBSCL, không theo cầu vồng mặc định.
 */
import type { Palette } from '../raster/grid.ts';

export interface SoilProperty {
  id: string;         // định danh lưới trong demo
  code: string;       // mã SoilGrids
  label: string;
  unit: string;
  scale: number;      // SoilGrids lưu số nguyên nhân 10
  palette: Palette;
  legend: { min: number; max: number; stops: { value: number; color: string; label?: string }[] };
}

const hex = (c: [number, number, number]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const legendOf = (palette: Palette, labels: Record<number, string> = {}) => ({
  min: palette.stops[0].value, max: palette.stops[palette.stops.length - 1].value,
  stops: palette.stops.map((s) => ({ value: s.value, color: hex(s.color), label: labels[s.value] })),
});

// pH: đất phèn ĐBSCL chua (≤ 4,5) → đỏ nâu; trung tính → xanh; kiềm (ven biển, mặn) → tím nhạt.
const PH: Palette = { alpha: 0.75, stops: [
  { value: 3.5, color: [140, 40, 30] }, { value: 4.5, color: [214, 96, 60] }, { value: 5.5, color: [240, 190, 110] },
  { value: 6.5, color: [140, 190, 120] }, { value: 7.5, color: [70, 150, 130] }, { value: 8.5, color: [120, 110, 170] },
] };
// Sét (%): đất phù sa nặng sét giữ nước tốt nhưng lún — thang vàng nhạt → nâu đậm.
const CLAY: Palette = { alpha: 0.75, stops: [
  { value: 10, color: [250, 240, 200] }, { value: 25, color: [220, 190, 130] }, { value: 40, color: [170, 120, 70] }, { value: 60, color: [100, 60, 30] },
] };
// Carbon hữu cơ (g/kg): thang xanh lá.
const SOC: Palette = { alpha: 0.75, stops: [
  { value: 5, color: [245, 245, 220] }, { value: 15, color: [180, 215, 150] }, { value: 30, color: [90, 160, 90] }, { value: 60, color: [20, 90, 50] },
] };

export const SOIL_PROPERTIES: SoilProperty[] = [
  { id: 'soil-ph', code: 'phh2o', label: 'pH (H₂O) tầng 0–5 cm', unit: 'pH', scale: 0.1, palette: PH,
    legend: legendOf(PH, { 3.5: 'rất chua (phèn)', 5.5: 'chua', 6.5: 'trung tính', 8.5: 'kiềm' }) },
  { id: 'soil-clay', code: 'clay', label: 'Hàm lượng sét tầng 0–5 cm', unit: '%', scale: 0.1, palette: CLAY,
    legend: legendOf(CLAY, { 10: 'cát pha', 40: 'sét', 60: 'sét nặng' }) },
  { id: 'soil-soc', code: 'soc', label: 'Carbon hữu cơ tầng 0–5 cm', unit: 'g/kg', scale: 0.1, palette: SOC,
    legend: legendOf(SOC, { 5: 'nghèo', 30: 'giàu', 60: 'rất giàu (đất than bùn)' }) },
];

// Địa hình ĐBSCL rất thấp: phần lớn 0–3 m. Dải xanh đậm cho < 0,5 m (ngập triều),
// vàng-nâu cho 3–20 m, tím cho núi (Thất Sơn, Hà Tiên) — hiếm nhưng có.
export const DEM_PALETTE: Palette = { alpha: 0.7, stops: [
  { value: -1, color: [20, 60, 120] }, { value: 0.5, color: [60, 130, 190] }, { value: 1.5, color: [150, 205, 200] },
  { value: 3, color: [225, 235, 170] }, { value: 8, color: [220, 180, 90] }, { value: 20, color: [170, 110, 60] }, { value: 100, color: [120, 80, 120] },
] };
export const DEM_LEGEND = legendOf(DEM_PALETTE, { '-1': 'dưới mực biển', 0.5: 'ngập triều', 1.5: 'đồng bằng thấp', 3: 'đồng bằng', 8: 'gò cao', 100: 'núi' });
