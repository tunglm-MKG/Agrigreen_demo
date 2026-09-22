/**
 * Dữ liệu trình diễn cho App Hợp tác xã (đợt cập nhật BRD 09/2026).
 *
 * CSDL cũ chỉ có HTX, máy móc và nội dung khuyến nông — chưa có nông hộ, thửa
 * ruộng, mùa vụ, nhật ký. Các màn hình mới (duyệt nhật ký, GPS khớp thửa, sản
 * lượng theo giống, heatmap mùa vụ) vì thế trống. Hàm này chỉ chạy khi bảng
 * `plots` còn rỗng và dùng đúng các dịch vụ nghiệp vụ (không chèn thẳng SQL)
 * để dữ liệu mẫu đi qua cùng luật kiểm tra như dữ liệu thật.
 */
import { all, one, insert } from './platform/db/db.ts';
import { nowIso, uuid } from './platform/util/ids.ts';
import * as mdm from './mdm/service.ts';
import * as lifecycle from './mdm/lifecycle.ts';
import * as htx from './agrigreen/htx/service.ts';
import * as ops from './agrigreen/htx/fieldOps.ts';
import { listVarieties } from './mdm/varieties.ts';

const actor = { name: 'seed-demo' };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** KB-00003/KB-00004 (hướng dẫn địa phương, tin khẩn) cho CSDL tạo trước đợt cập nhật. */
export function ensureBrdArticles(): void {
  if (one('SELECT 1 FROM knowledge_articles WHERE code = ?', ['KB-00003'])) return;
  const awd = one<{ id: string }>("SELECT id FROM knowledge_articles WHERE code = 'KB-00001'");
  const timestamp = nowIso();
  insert('knowledge_articles', {
    id: uuid(), code: 'KB-00003', title: 'Hướng dẫn AWD cho vùng phèn Đồng Tháp Mười',
    kind: 'quy_trinh', category: 'ky_thuat', urgent: 0, summary: 'Bổ sung của TTKN Đồng Tháp: rút nước nông hơn (−10 cm) ở ruộng phèn nặng, kèm bón vôi đầu vụ.',
    body: 'Áp dụng cùng quy trình AWD chuẩn quốc gia. Riêng vùng phèn: ngưỡng rút nước −10 cm thay cho −15 cm; bón 300–500 kg vôi/ha trước sạ.',
    crop: 'lúa', status: 'published', scope_node_id: null, parent_id: awd?.id ?? null, region_label: 'Đồng Tháp', view_count: 21, published_at: timestamp, author_id: null,
    created_at: timestamp, updated_at: timestamp,
  });
  insert('knowledge_articles', {
    id: uuid(), code: 'KB-00004', title: 'Cảnh báo rầy nâu phát sinh diện rộng đầu vụ Thu Đông',
    kind: 'tin_tuc', category: 'canh_bao', urgent: 1, summary: 'Mật độ rầy 1.500–3.000 con/m² tại An Giang, Đồng Tháp. Thăm đồng 3 ngày/lần, không phun ngừa khi chưa tới ngưỡng.',
    body: 'Theo Chi cục Trồng trọt & BVTV: rầy nâu tuổi 2–3 xuất hiện diện rộng. Khuyến cáo: giữ nước ruộng, dùng thuốc trong danh mục khi mật độ > 3 con/tép, tuyệt đối không phun ngừa.',
    crop: 'lúa', status: 'published', scope_node_id: null, parent_id: null, region_label: 'ĐBSCL', view_count: 340, published_at: timestamp, author_id: null,
    created_at: timestamp, updated_at: timestamp,
  });
}

/** Ô vuông ~2,7 ha quanh một tâm; `dx, dy` là số ô dịch để các thửa không chồng nhau. */
function square(lat: number, lng: number, dx: number, dy: number): { lat: number; lng: number }[] {
  const size = 0.0015;
  const gap = 0.0004;
  const cx = lng + dx * (size + gap) * 2;
  const cy = lat + dy * (size + gap) * 2;
  return [
    { lat: cy - size, lng: cx - size }, { lat: cy - size, lng: cx + size },
    { lat: cy + size, lng: cx + size }, { lat: cy + size, lng: cx - size },
  ];
}

export function seedHtxFieldDemoIfEmpty(): boolean {
  try { ensureBrdArticles(); } catch (error) { console.error('[seed-demo] bài viết:', (error as Error).message); }
  if ((one<{ n: number }>('SELECT COUNT(*) AS n FROM plots')?.n ?? 0) > 0) return false;

  const seasons = mdm.listSeasons() as { id: string; name: string; year: number; sort_order: number }[];
  if (!seasons.length) return false;
  // Vụ đã kết thúc = vụ cũ nhất; vụ đang canh tác = vụ mới nhất.
  const past = seasons[seasons.length - 1];
  const current = seasons[0];
  const varieties = listVarieties(false) as { id: string; name: string; yield_min_t_ha: number; yield_max_t_ha: number }[];
  const cooperatives = all<{ id: string; code: string; name: string; lat: number; lng: number }>(
    "SELECT id, code, name, lat, lng FROM cooperatives WHERE status = 'active' AND lat IS NOT NULL ORDER BY code LIMIT 3",
  );
  const names = ['Nguyễn Văn Hai', 'Trần Thị Bé', 'Lê Minh Tâm', 'Phạm Văn Út'];
  let created = 0;

  cooperatives.forEach((coop, ci) => {
    try {
      const farmers = names.slice(0, 3).map((name, i) => mdm.createFarmer({
        fullName: name, htxId: coop.id, phone: `09${String(10_000_000 + ci * 1000 + i).padStart(8, '0')}`, address: `Ấp ${i + 1}, ${coop.name}`,
      }, actor) as { id: string });
      const plots = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy], i) => lifecycle.createPlotChecked({
        name: `Thửa ${i + 1} — ${farmers[i % farmers.length] ? names[i % 3] : ''}`.trim(), htxId: coop.id, farmerId: farmers[i % farmers.length].id,
        boundary: square(coop.lat, coop.lng, dx, dy), source: 'seed', confirmOverlap: true,
      }, actor) as unknown as { id: string; area_ha: number });
      created += plots.length;

      // Hai thửa đầu: vụ trước đã thu hoạch (có nhật ký đã duyệt).
      plots.slice(0, 2).forEach((plot, i) => {
        const variety = varieties[i % varieties.length];
        const cycle = htx.openCropCycle({ plotId: plot.id, seasonId: past.id, variety: variety?.name, sowingDate: '2025-05-05', expectedHarvestDate: '2025-08-10' }, actor) as { id: string };
        for (const [activity, date] of [['gieo_sa', '2025-05-05'], ['bon_phan', '2025-05-20'], ['rut_nuoc_awd', '2025-06-10'], ['thu_hoach', '2025-08-12']] as const) {
          const log = ops.addFarmLogV2({ cropCycleId: cycle.id, activity, logDate: date, detail: 'Dữ liệu mẫu', recordedBy: names[i], lat: square(coop.lat, coop.lng, i, 0)[0].lat + 0.0015, lng: square(coop.lat, coop.lng, i, 0)[0].lng + 0.0015, gpsSource: 'thiet_bi' }, actor) as { id: string };
          ops.reviewFarmLog(log.id, 'da_duyet', undefined, actor);
        }
        const yieldTha = variety ? (variety.yield_min_t_ha + variety.yield_max_t_ha) / 2 : 6;
        htx.declareHarvest({ cropCycleId: cycle.id, harvestDate: '2025-08-12', paddyTons: Math.round(plot.area_ha * yieldTha * 100) / 100, strawTons: Math.round(plot.area_ha * 3.2 * 100) / 100, strawState: 'da_cuon', moisturePct: 14 }, actor);
      });

      // Hai thửa sau: vụ hiện tại đang canh tác, có nhật ký chờ duyệt / GPS khớp / không có GPS.
      plots.slice(2).forEach((plot, i) => {
        const variety = varieties[(i + 2) % varieties.length];
        const cycle = ops.openSeasonV2({ plotId: plot.id, seasonId: current.id, varietyId: variety?.id, sowingDate: daysAgo(10 + i * 2) }, actor) as { id: string };
        const centre = square(coop.lat, coop.lng, i, 1)[0];
        ops.addFarmLogV2({ cropCycleId: cycle.id, activity: 'lam_dat', logDate: daysAgo(12 + i * 2), detail: 'Cày trục, trang phẳng mặt ruộng', recordedBy: names[(i + 1) % 3], lat: centre.lat + 0.0015, lng: centre.lng + 0.0015, gpsSource: 'thiet_bi' }, actor);
        ops.addFarmLogV2({ cropCycleId: cycle.id, activity: 'gieo_sa', logDate: daysAgo(10 + i * 2), detail: `Sạ hàng ${variety?.name ?? ''} 80 kg/ha`, inputName: `Giống ${variety?.name ?? 'lúa'}`, inputQty: Math.round(plot.area_ha * 80), inputUom: 'kg', recordedBy: names[(i + 1) % 3], gpsSource: 'khong_co_gps_thiet_bi' }, actor);
        const pending = ops.addFarmLogV2({ cropCycleId: cycle.id, activity: 'bon_phan', logDate: daysAgo(2), detail: 'Bón thúc đợt 1', inputName: 'Urê', inputQty: Math.round(plot.area_ha * 50), inputUom: 'kg', recordedBy: names[(i + 2) % 3], lat: centre.lat + 0.02, lng: centre.lng + 0.02, gpsSource: 'thiet_bi' }, actor) as { id: string };
        if (i === 1) ops.reviewFarmLog(pending.id, 'yeu_cau_bo_sung', 'Vị trí GPS không khớp thửa — bổ sung ảnh chụp tại ruộng.', actor);
      });

      if (ci === 0) {
        htx.requestSupport({ htxId: coop.id, farmerId: farmers[0].id, plotId: plots[2].id, title: '[Dịch hại] Rầy nâu xuất hiện mật độ cao trên thửa mới sạ', description: 'Mật độ ước 2.000 con/m², lúa 12 ngày tuổi. Cần cán bộ xuống thăm đồng.', priority: 'khan' }, actor);
      }
    } catch (error) {
      console.error(`[seed-demo] ${coop.code}:`, (error as Error).message);
    }
  });
  if (created) console.log(`  Dữ liệu trình diễn App HTX: ${created} thửa, mùa vụ và nhật ký cho ${cooperatives.length} HTX.`);
  return created > 0;
}
