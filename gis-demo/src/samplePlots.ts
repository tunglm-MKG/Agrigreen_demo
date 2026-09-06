/**
 * LÔ MẪU TỰ TẠO (F-06, A.4) — hoàn toàn giả định, không lấy từ nguồn thật nào.
 *
 * 24 đa giác rải trên bốn cụm canh tác lúa quen thuộc của ĐBSCL (Long Xuyên –
 * Thoại Sơn, Vị Thanh, Cao Lãnh, Gò Công) để người xem hình dung quan hệ giữa lô
 * và các lớp nền. Sinh bằng hàm giả ngẫu nhiên có hạt cố định nên lần nào chạy
 * cũng ra đúng bộ đó. Mọi thuộc tính (giống, ngày thu hoạch, diện tích) là minh hoạ.
 */

const CLUSTERS = [
  { name: 'Long Xuyên – Thoại Sơn', lat: 10.32, lng: 105.32 },
  { name: 'Vị Thanh', lat: 9.79, lng: 105.47 },
  { name: 'Cao Lãnh', lat: 10.46, lng: 105.60 },
  { name: 'Gò Công', lat: 10.36, lng: 106.62 },
];
const VARIETIES = ['OM5451', 'OM18', 'Đài Thơm 8', 'ST25', 'IR50404', 'Jasmine 85'];

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export interface SamplePlot {
  code: string; cluster: string; areaHa: number; variety: string; expectedHarvest: string;
  ring: [number, number][]; // [lng, lat]
}

export function samplePlots(): SamplePlot[] {
  const rand = seeded(20260906);
  const plots: SamplePlot[] = [];
  let index = 1;
  for (const cluster of CLUSTERS) {
    for (let i = 0; i < 6; i += 1) {
      const cx = cluster.lng + (rand() - 0.5) * 0.09;
      const cy = cluster.lat + (rand() - 0.5) * 0.07;
      // Lô ruộng ĐBSCL là tứ giác dài theo kênh: rộng 130–270 m, dài 330–660 m → 4–18 ha.
      const w = (0.0006 + rand() * 0.0006);
      const h = (0.0015 + rand() * 0.0015);
      const angle = (rand() - 0.5) * 0.6;
      const rot = (x: number, y: number): [number, number] => [
        cx + x * Math.cos(angle) - y * Math.sin(angle),
        cy + (x * Math.sin(angle) + y * Math.cos(angle)) * 0.98,
      ];
      const ring: [number, number][] = [rot(-w, -h), rot(w, -h), rot(w * 1.05, h), rot(-w * 0.95, h), rot(-w, -h)];
      const areaHa = Math.round((2 * w * 111.32 * Math.cos((cy * Math.PI) / 180)) * (2 * h * 110.57) * 100 * 10) / 10;
      const harvest = new Date(Date.UTC(2026, 9 + Math.floor(rand() * 3), 1 + Math.floor(rand() * 28)));
      plots.push({
        code: `LO-MH-${String(index).padStart(2, '0')}`, cluster: cluster.name, areaHa,
        variety: VARIETIES[Math.floor(rand() * VARIETIES.length)], expectedHarvest: harvest.toISOString().slice(0, 10), ring,
      });
      index += 1;
    }
  }
  return plots;
}

export function samplePlotsGeoJson(): Record<string, unknown> {
  return {
    type: 'FeatureCollection',
    properties: { disclaimer: 'DỮ LIỆU MINH HOẠ — lô mẫu tự tạo, không phải thửa ruộng thật, không gắn với hộ hay HTX nào.' },
    features: samplePlots().map((plot) => ({
      type: 'Feature',
      properties: { code: plot.code, cluster: plot.cluster, areaHa: plot.areaHa, variety: plot.variety, expectedHarvest: plot.expectedHarvest, illustrative: true },
      geometry: { type: 'Polygon', coordinates: [plot.ring] },
    })),
  };
}
