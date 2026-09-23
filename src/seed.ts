/**
 * Nạp dữ liệu nền khởi tạo.
 *
 * Dữ liệu địa lý dùng đơn vị hành chính SAU SÁP NHẬP 2025 (6 tỉnh/thành liên
 * quan tới mạng lưới cung ứng rơm về Nhà máy VFT tại KCN Phước Đông – Tân Lân 3,
 * Tây Ninh). Toạ độ HTX và ranh giới tỉnh ở đây là dữ liệu MINH HOẠ dùng để chạy
 * thử hệ thống — theo RS-02/RS-09 phải thay bằng khảo sát GPS thực địa và
 * shapefile/GeoJSON chính thức trước khi dùng cho quyết định đầu tư thật.
 */
import { all, insert, one, run } from './platform/db/db.ts';
import { nowIso, uuid } from './platform/util/ids.ts';
import { seedParameters } from './erp/params/store.ts';
import {
  addProtocolStep, createProtocol, publishProtocol,
} from './agrigreen/htx/production.ts';
import { createItem as createInputItem } from './agrigreen/htx/inputs.ts';
import { PROVINCE_MERGER, listDistricts, normalizeName } from './mdm/gazetteer.ts';
import {
  addStructure as addWaterwayStructure, deriveAllCapacities,
} from './agrigreen/gis/waterwayNetwork.ts';
import {
  addQuestion as addSurveyQuestion,
  createTemplate as createSurveyTemplate,
  publishTemplate as publishSurveyTemplate,
} from './agrigreen/khuyennong/survey.ts';
import { createUser, listUsers } from './platform/auth/users.ts';
import { grantScope, tryAdminContext } from './platform/auth/scopes.ts';
import * as field from './erp/field/service.ts';
import { createContract } from './erp/straw/contracts.ts';
import { createVessel } from './erp/tms/vessels.ts';
import { confirmTicket, listTickets } from './erp/straw/tickets.ts';
import { ROLES } from './platform/auth/rbac.ts';
import { captureSnapshot } from './platform/audit/audit.ts';
import { seedVarietiesIfEmpty } from './mdm/varieties.ts';

interface ProvinceSeed {
  code: string;
  name: string;
  lat: number;
  lng: number;
  /** Bán kính hộp ranh giới minh hoạ (độ). */
  span: number;
}

const PROVINCES: ProvinceSeed[] = [
  { code: 'AG', name: 'An Giang', lat: 10.2100, lng: 105.2600, span: 0.62 },
  { code: 'DT', name: 'Đồng Tháp', lat: 10.4100, lng: 105.9800, span: 0.58 },
  { code: 'VL', name: 'Vĩnh Long', lat: 10.1400, lng: 106.2000, span: 0.52 },
  { code: 'CT', name: 'Cần Thơ', lat: 9.8200, lng: 105.7300, span: 0.60 },
  { code: 'CM', name: 'Cà Mau', lat: 9.2300, lng: 105.3800, span: 0.62 },
  { code: 'TN', name: 'Tây Ninh', lat: 11.1000, lng: 106.2000, span: 0.60 },
];

interface HtxSeed {
  name: string;
  province: string;
  lat: number;
  lng: number;
  members: number;
  areaHa: number;
  /** Sản lượng lúa thống kê (tấn) theo 3 mùa vụ: Đông Xuân, Hè Thu, Thu Đông. */
  paddy: [number, number, number];
}

const COOPERATIVES: HtxSeed[] = [
  // An Giang (gộp Kiên Giang)
  { name: 'HTX Nông nghiệp Vĩnh Bình', province: 'AG', lat: 10.4520, lng: 105.3410, members: 412, areaHa: 1_850, paddy: [12_400, 10_100, 7_600] },
  { name: 'HTX Dịch vụ NN Thoại Sơn', province: 'AG', lat: 10.2670, lng: 105.2620, members: 356, areaHa: 1_620, paddy: [11_200, 9_300, 6_800] },
  { name: 'HTX Tân Hiệp Phát Đạt', province: 'AG', lat: 10.0940, lng: 105.2830, members: 298, areaHa: 1_340, paddy: [9_100, 7_700, 5_400] },
  { name: 'HTX Giồng Riềng An Bình', province: 'AG', lat: 9.9350, lng: 105.3120, members: 264, areaHa: 1_180, paddy: [8_300, 6_900, 4_700] },
  { name: 'HTX Châu Phú Tiến Lên', province: 'AG', lat: 10.5810, lng: 105.2080, members: 331, areaHa: 1_470, paddy: [10_300, 8_600, 6_100] },

  // Đồng Tháp (gộp Tiền Giang)
  { name: 'HTX Tháp Mười Phát Triển', province: 'DT', lat: 10.5470, lng: 105.8320, members: 388, areaHa: 1_760, paddy: [11_900, 9_900, 7_100] },
  { name: 'HTX Tam Nông Đồng Tiến', province: 'DT', lat: 10.7180, lng: 105.5460, members: 274, areaHa: 1_290, paddy: [8_800, 7_200, 5_000] },
  { name: 'HTX Cai Lậy Thịnh Vượng', province: 'DT', lat: 10.4110, lng: 106.1120, members: 342, areaHa: 1_510, paddy: [10_600, 8_800, 6_300] },
  { name: 'HTX Cái Bè Mỹ Lợi', province: 'DT', lat: 10.3450, lng: 105.9310, members: 301, areaHa: 1_380, paddy: [9_500, 8_000, 5_600] },
  { name: 'HTX Gò Công Tây Hưng Thịnh', province: 'DT', lat: 10.3520, lng: 106.5940, members: 233, areaHa: 1_050, paddy: [7_200, 5_900, 3_800] },

  // Vĩnh Long (gộp Bến Tre, Trà Vinh)
  { name: 'HTX Bình Tân Nông Sản', province: 'VL', lat: 10.1780, lng: 105.8430, members: 289, areaHa: 1_240, paddy: [8_600, 7_100, 4_900] },
  { name: 'HTX Tam Bình Tiến Bộ', province: 'VL', lat: 10.0490, lng: 105.9880, members: 251, areaHa: 1_100, paddy: [7_600, 6_300, 4_200] },
  { name: 'HTX Càng Long Hiệp Lực', province: 'VL', lat: 9.9720, lng: 106.2110, members: 217, areaHa: 960, paddy: [6_700, 5_500, 3_600] },
  { name: 'HTX Ba Tri Đồng Khởi', province: 'VL', lat: 10.0410, lng: 106.5980, members: 198, areaHa: 870, paddy: [5_900, 4_800, 3_100] },

  // Cần Thơ (gộp Sóc Trăng, Hậu Giang)
  { name: 'HTX Thới Lai Tiến Nông', province: 'CT', lat: 10.0210, lng: 105.5540, members: 364, areaHa: 1_630, paddy: [11_400, 9_400, 6_700] },
  { name: 'HTX Cờ Đỏ Đại Thành', province: 'CT', lat: 10.1180, lng: 105.4260, members: 402, areaHa: 1_810, paddy: [12_700, 10_500, 7_500] },
  { name: 'HTX Vị Thủy Phú Cường', province: 'CT', lat: 9.7930, lng: 105.5320, members: 276, areaHa: 1_220, paddy: [8_500, 7_000, 4_800] },
  { name: 'HTX Long Phú Hưng Đạo', province: 'CT', lat: 9.6120, lng: 106.0270, members: 245, areaHa: 1_080, paddy: [7_400, 6_100, 4_000] },
  { name: 'HTX Ngã Năm Tân Tiến', province: 'CT', lat: 9.5580, lng: 105.6410, members: 229, areaHa: 1_020, paddy: [7_100, 5_800, 3_900] },

  // Cà Mau (gộp Bạc Liêu)
  { name: 'HTX Trần Văn Thời Lúa Vàng', province: 'CM', lat: 9.1720, lng: 105.0180, members: 208, areaHa: 940, paddy: [6_500, 5_200, 3_300] },
  { name: 'HTX Hồng Dân Thuận Phát', province: 'CM', lat: 9.5710, lng: 105.4630, members: 236, areaHa: 1_060, paddy: [7_400, 6_000, 3_900] },
  { name: 'HTX Phước Long Tiến Đạt', province: 'CM', lat: 9.4310, lng: 105.4890, members: 221, areaHa: 990, paddy: [6_900, 5_600, 3_600] },

  // Tây Ninh (gộp Long An) — gần nhà máy VFT
  { name: 'HTX Đức Huệ Nông Phát', province: 'TN', lat: 10.8930, lng: 106.2410, members: 187, areaHa: 830, paddy: [5_700, 4_600, 2_900] },
  { name: 'HTX Tân Trụ Lúa Thơm', province: 'TN', lat: 10.5480, lng: 106.4870, members: 214, areaHa: 950, paddy: [6_600, 5_300, 3_400] },
  { name: 'HTX Thạnh Hoá Đồng Xanh', province: 'TN', lat: 10.7460, lng: 106.2130, members: 243, areaHa: 1_090, paddy: [7_600, 6_200, 4_100] },
  { name: 'HTX Mộc Hoá Bình Minh', province: 'TN', lat: 10.7810, lng: 105.9380, members: 259, areaHa: 1_150, paddy: [8_000, 6_500, 4_300] },
];

/** Nhà máy VFT — KCN Phước Đông – Tân Lân 3, Tây Ninh (tham số #11, hằng số cấu hình). */
const VFT_PLANT = { name: 'Nhà máy VFT — KCN Phước Đông, Tây Ninh', lat: 11.1042, lng: 106.2761 };

const SEASONS = [
  { code: 'DX-2024-2025', name: 'Đông Xuân 2024-2025', year: 2025, start: 11, end: 3, order: 1 },
  { code: 'HT-2025', name: 'Hè Thu 2025', year: 2025, start: 4, end: 8, order: 2 },
  { code: 'TD-2025', name: 'Thu Đông 2025', year: 2025, start: 8, end: 12, order: 3 },
];

const MACHINE_TYPES = [
  { code: 'MLD', name: 'Máy làm đất (máy cày/xới)', stage: 'lam_dat' },
  { code: 'MGS', name: 'Máy gieo sạ / cấy', stage: 'gieo_sa' },
  { code: 'MPT', name: 'Máy phun thuốc / drone', stage: 'cham_soc' },
  { code: 'MGD', name: 'Máy gặt đập liên hợp', stage: 'thu_hoach' },
  { code: 'MCR', name: 'Máy cuộn rơm', stage: 'sau_thu_hoach' },
  { code: 'MSL', name: 'Máy sấy lúa', stage: 'sau_thu_hoach' },
];

/** Định mức năng suất (ha/máy/vụ) — mô phỏng văn bản DCRD ban hành. */
const NORMS: Record<string, number> = {
  MLD: 120, MGS: 100, MPT: 260, MGD: 90, MCR: 140, MSL: 400,
};

/** Tuyến đường thủy chính minh hoạ cho mạng lưới định tuyến sà lan (tham số #9). */
const WATERWAYS: { name: string; maxLoad: number; width: number; depth: number; points: [number, number][] }[] = [
  {
    name: 'Sông Hậu (Châu Đốc – Long Xuyên – Cần Thơ – cửa Định An)',
    maxLoad: 1_000, width: 800, depth: 8,
    points: [[10.7000, 105.1180], [10.3800, 105.4350], [10.1900, 105.6100], [10.0330, 105.7830], [9.7400, 106.0700], [9.5200, 106.2300]],
  },
  {
    name: 'Sông Tiền (Hồng Ngự – Cao Lãnh – Mỹ Thuận – Mỹ Tho)',
    maxLoad: 1_000, width: 900, depth: 9,
    points: [[10.8000, 105.3300], [10.4600, 105.6400], [10.2800, 105.9100], [10.3500, 106.3600], [10.2700, 106.7200]],
  },
  {
    name: 'Kênh Chợ Gạo (tuyến huyết mạch ĐBSCL – TP.HCM)',
    maxLoad: 600, width: 80, depth: 4.5,
    points: [[10.3500, 106.3600], [10.4200, 106.4500], [10.5200, 106.5200], [10.5600, 106.5600]],
  },
  {
    name: 'Kênh Xà No (Cần Thơ – Vị Thanh)',
    maxLoad: 300, width: 60, depth: 3.5,
    points: [[10.0330, 105.7830], [9.9400, 105.6800], [9.8600, 105.5800], [9.7840, 105.4700]],
  },
  {
    name: 'Sông Vàm Cỏ Đông (Nhà máy VFT – Bến Lức – hợp lưu Vàm Cỏ)',
    maxLoad: 500, width: 120, depth: 5,
    points: [[11.1042, 106.2761], [10.9800, 106.2500], [10.8600, 106.2900], [10.7200, 106.4000], [10.5600, 106.5600]],
  },
  {
    name: 'Kênh Rạch Sỏi – Long Xuyên',
    maxLoad: 400, width: 70, depth: 4,
    points: [[10.0120, 105.0810], [10.1000, 105.2000], [10.2300, 105.3300], [10.3800, 105.4350]],
  },
  {
    // Tuyến nối sông Hậu ↔ sông Tiền — nếu thiếu tuyến này, mạng lưới bị chia
    // thành hai thành phần rời và mọi chặng sà lan liên vùng sẽ không định
    // tuyến được (FN-20 BR-06: cảnh báo tuyến chưa kết nối vào mạng lưới).
    name: 'Kênh Xáng Lấp Vò – Sa Đéc (nối sông Hậu ↔ sông Tiền)',
    maxLoad: 600, width: 90, depth: 4.5,
    points: [[10.3800, 105.4350], [10.3450, 105.5600], [10.3000, 105.7000], [10.2800, 105.9100]],
  },
];

export function seedIfEmpty(): boolean {
  const existing = one<{ n: number }>('SELECT COUNT(*) AS n FROM cooperatives');
  if ((existing?.n ?? 0) > 0) return false;
  seedAll();
  return true;
}

export function seedAll(): void {
  const timestamp = nowIso();

  // ---------- Đơn vị hành chính (sau sáp nhập 2025) ----------
  const provinceIds = new Map<string, string>();
  for (const province of PROVINCES) {
    const id = uuid();
    provinceIds.set(province.code, id);
    const s = province.span;
    insert('admin_units', {
      id,
      code: province.code,
      name: province.name,
      level: 'province',
      parent_id: null,
      boundary: JSON.stringify({
        type: 'Polygon',
        coordinates: [[
          [province.lng - s, province.lat - s],
          [province.lng + s, province.lat - s],
          [province.lng + s, province.lat + s],
          [province.lng - s, province.lat + s],
          [province.lng - s, province.lat - s],
        ]],
      }),
      centroid_lat: province.lat,
      centroid_lng: province.lng,
    });
  }

  // ---------- Mùa vụ ----------
  const seasonIds = new Map<string, string>();
  for (const season of SEASONS) {
    const id = uuid();
    seasonIds.set(season.code, id);
    insert('seasons', {
      id, code: season.code, name: season.name, year: season.year,
      start_month: season.start, end_month: season.end, sort_order: season.order,
    });
  }

  // ---------- Item master, đối tác, revenue rules ----------
  insert('items', { id: uuid(), code: 'ROM-KIEN', name: 'Rơm ép kiện', uom: 'tấn', category: 'straw' });
  insert('items', { id: uuid(), code: 'ROM-XA', name: 'Rơm xá (chưa ép)', uom: 'tấn', category: 'straw' });
  insert('items', { id: uuid(), code: 'LUA', name: 'Lúa', uom: 'tấn', category: 'paddy' });

  const partners = [
    { code: 'VFT', name: 'Công ty VFT (nhà máy Phước Đông)', kind: 'customer' },
    { code: 'EVN', name: 'EVN — nhà máy điện sinh khối', kind: 'customer' },
    { code: 'VVB-SGS', name: 'SGS Việt Nam (tổ chức kiểm định)', kind: 'vvb' },
    { code: 'GBF', name: 'Quỹ đầu tư xanh (buyer tín chỉ)', kind: 'buyer' },
  ];
  const partnerIds = new Map<string, string>();
  for (const partner of partners) {
    const id = uuid();
    partnerIds.set(partner.code, id);
    insert('partners', { id, code: partner.code, name: partner.name, kind: partner.kind, tax_code: null, contact: null, address: null, status: 'active' });
  }

  insert('revenue_rules', { id: uuid(), code: 'FEE-RENTAL', name: 'Phí giao dịch sàn cơ giới hoá', kind: 'transaction_fee', rate_pct: 5, fixed_amount: null, applies_to: 'rental', active: 1 });
  insert('revenue_rules', { id: uuid(), code: 'FEE-STRAW', name: 'Phí giao dịch sàn phụ phẩm rơm', kind: 'transaction_fee', rate_pct: 3, fixed_amount: null, applies_to: 'straw_trade', active: 1 });
  insert('revenue_rules', { id: uuid(), code: 'CARBON-SHARE', name: 'Chia sẻ doanh thu carbon (giữ lại 45%)', kind: 'carbon_share', rate_pct: 45, fixed_amount: null, applies_to: 'carbon', active: 1 });
  insert('revenue_rules', { id: uuid(), code: 'SUB-DATA', name: 'Data Licensing dự báo sản lượng (EVN/VFT)', kind: 'subscription', rate_pct: null, fixed_amount: 450_000_000, applies_to: 'data', active: 1 });

  // ---------- Nhà máy đầu ra (tham số #11, #12) ----------
  const plantId = uuid();
  insert('facilities', {
    id: plantId, code: 'NM-VFT', name: VFT_PLANT.name, kind: 'plant',
    lat: VFT_PLANT.lat, lng: VFT_PLANT.lng, province_id: provinceIds.get('TN') ?? null,
    capacity_tons: 0, current_stock_tons: 0, annual_demand_tons: 240_000,
    status: 'active', origin_scenario_id: null, created_at: timestamp, updated_at: timestamp,
  });

  // ---------- Hợp tác xã + thống kê sản lượng theo mùa vụ ----------
  const htxIds = new Map<string, string>();
  COOPERATIVES.forEach((htx, index) => {
    const id = uuid();
    htxIds.set(htx.name, id);
    const d = 0.045;
    insert('cooperatives', {
      id,
      code: `HTX-${String(index + 1).padStart(5, '0')}`,
      name: htx.name,
      province_id: provinceIds.get(htx.province) ?? null,
      commune_id: null,
      address: `${htx.name}, tỉnh ${PROVINCES.find((p) => p.code === htx.province)?.name}`,
      contact_name: null,
      contact_phone: `09${String(10_000_000 + index * 137).slice(0, 8)}`,
      lat: htx.lat,
      lng: htx.lng,
      boundary: JSON.stringify({
        type: 'Polygon',
        coordinates: [[
          [htx.lng - d, htx.lat - d], [htx.lng + d, htx.lat - d],
          [htx.lng + d, htx.lat + d], [htx.lng - d, htx.lat + d], [htx.lng - d, htx.lat - d],
        ]],
      }),
      registered_area_ha: htx.areaHa,
      member_count: htx.members,
      status: 'active',
      created_at: timestamp,
      updated_at: timestamp,
    });

    SEASONS.forEach((season, seasonIndex) => {
      insert('harvest_statistics', {
        id: uuid(),
        htx_id: id,
        season_id: seasonIds.get(season.code)!,
        planted_area_ha: Math.round(htx.areaHa * [0.95, 0.85, 0.6][seasonIndex]),
        paddy_tons: htx.paddy[seasonIndex],
        source: 'Niên giám thống kê tỉnh (minh hoạ)',
        recorded_at: timestamp,
      });
      insert('cultivation_plans', {
        id: uuid(),
        htx_id: id,
        season_id: seasonIds.get(season.code)!,
        area_ha: Math.round(htx.areaHa * [0.95, 0.85, 0.6][seasonIndex]),
        stage_start: null,
        stage_end: null,
        source: 'nhap_tay',
        locked: 0,
        updated_at: timestamp,
      });
    });

    // Trạng thái mùa vụ cho heatmap GIS (FN-12).
    const stages = ['lam_dat', 'gieo_sa', 'sinh_truong', 'chin', 'thu_hoach', 'sau_thu_hoach'];
    const stage = stages[index % stages.length];
    const daysAhead = (index % 5) + 1;
    insert('crop_status', {
      id: uuid(),
      htx_id: id,
      season_id: seasonIds.get('HT-2025')!,
      stage,
      expected_harvest_date: new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10),
      expected_yield_tons: htx.paddy[1],
      straw_tons: Math.round(htx.paddy[1] * 0.45),
      updated_at: timestamp,
    });
  });

  // ---------- Danh mục & định mức cơ giới hoá ----------
  const machineTypeIds = new Map<string, string>();
  for (const type of MACHINE_TYPES) {
    const id = uuid();
    machineTypeIds.set(type.code, id);
    insert('machine_types', { id, code: type.code, name: type.name, stage: type.stage, active: 1 });
    insert('productivity_norms', {
      id: uuid(),
      machine_type_id: id,
      stage: type.stage,
      ha_per_machine_season: NORMS[type.code],
      effective_from: '2026-01-01',
      effective_to: null,
      document_ref: 'QĐ số 128/QĐ-KTHT ngày 15/01/2026 của Cục KTHT & PTNT (minh hoạ)',
      active: 1,
    });
  }

  // Chủ sở hữu và máy — phân bổ theo HTX để cân đối cung–cầu có ý nghĩa.
  let ownerIndex = 0;
  let machineIndex = 0;
  for (const [name, htxId] of htxIds) {
    const ownerId = uuid();
    ownerIndex += 1;
    const provinceCode = COOPERATIVES.find((c) => c.name === name)?.province ?? 'XX';
    insert('machine_owners', {
      id: ownerId,
      // FN-04 BR-02: CSH + mã tỉnh + số thứ tự trong tỉnh.
      code: `CSH-${provinceCode}-${String(ownerIndex).padStart(5, '0')}`,
      name: `Tổ dịch vụ cơ giới ${name}`,
      owner_type: 'htx',
      htx_id: htxId,
      phone: null,
      status: 'active',
      created_at: timestamp,
    });
    for (const type of MACHINE_TYPES) {
      // Số máy mỗi loại 1–4, tạo ra vùng thiếu/đủ/thừa khác nhau giữa các HTX.
      const count = 1 + ((ownerIndex + type.code.length) % 4);
      for (let i = 0; i < count; i += 1) {
        machineIndex += 1;
        insert('machines', {
          id: uuid(),
          // FN-05 BR-02: MAY + mã tỉnh + số thứ tự (dùng chỉ số toàn cục để mã không trùng trong seed).
          code: `MAY-${provinceCode}-${String(machineIndex).padStart(5, '0')}`,
          machine_type_id: machineTypeIds.get(type.code)!,
          owner_id: ownerId,
          htx_id: htxId,
          brand: ['Kubota', 'Yanmar', 'John Deere', 'Việt Nam'][machineIndex % 4],
          model: `M-${1000 + machineIndex}`,
          serial_number: `SN${String(100_000 + machineIndex)}`,
          chassis_number: null,
          year_made: 2018 + (machineIndex % 7),
          capacity_ha_per_season: NORMS[type.code],
          condition: machineIndex % 11 === 0 ? 'bao_tri' : machineIndex % 17 === 0 ? 'hong' : 'hoat_dong',
          condition_source: 'nhap_tay',
          condition_locked: 0,
          condition_updated_at: timestamp,
          // FN-05 BR-08/09: mốc HTX sở hữu máy để truy vấn số máy theo thời điểm; vài máy mua gần đây.
          owned_since: new Date(Date.now() - (30 + (machineIndex % 9) * 60) * 86_400_000).toISOString().slice(0, 10),
          deactivated_at: null,
          status: 'active',
          fuel: ['Diesel', 'Diesel', 'Xăng', 'Điện'][machineIndex % 4],
          power_hp: 40 + (machineIndex % 6) * 15,
          created_at: timestamp,
        });
      }
    }
  }

  // ---------- Mạng lưới đường thủy (tham số #9) ----------
  WATERWAYS.forEach((route, index) => {
    const points = route.points.map(([lat, lng]) => ({ lat, lng }));
    let lengthM = 0;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const dLat = (b.lat - a.lat) * 110_574;
      const dLng = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
      lengthM += Math.sqrt(dLat * dLat + dLng * dLng);
    }
    insert('transport_routes', {
      id: uuid(),
      code: `WW-${String(index + 1).padStart(4, '0')}`,
      name: route.name,
      mode: 'waterway',
      road_class: null,
      max_load_tons: route.maxLoad,
      width_m: route.width,
      depth_m: route.depth,
      clearance_m: null,
      geometry: JSON.stringify({ type: 'LineString', coordinates: route.points.map(([lat, lng]) => [lng, lat]) }),
      length_m: Math.round(lengthM * 100) / 100,
      data_source: 'so_hoa_noi_bo',
      status: 'da_xac_nhan',
      province_id: null,
      note: 'Tuyến số hoá nội bộ minh hoạ — cần nghiệm thu độ chính xác trước khi dùng cho quyết định (AS-05).',
      created_by: 'seed',
      created_at: timestamp,
      updated_at: timestamp,
    });
  });

  // ---------- Thời tiết (FN-10 / FN-11) ----------
  for (const province of PROVINCES) {
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
      const rainfall = 5 + ((province.code.charCodeAt(0) + day * 7) % 60);
      insert('weather_observations', {
        id: uuid(),
        area_id: provinceIds.get(province.code)!,
        observed_for: date,
        rainfall_mm: rainfall,
        humidity_pct: 70 + (day % 20),
        temp_c: 27 + (day % 8),
        kind: 'forecast',
        severity: rainfall > 55 ? 'canh_bao' : null,
        headline: rainfall > 55 ? `Mưa lớn diện rộng tại ${province.name}` : null,
        received_at: timestamp,
      });
    }
  }

  // ---------- Cây tổ chức khuyến nông 3 cấp ----------
  const centralId = uuid();
  insert('org_nodes', { id: centralId, code: 'TTKNQG', name: 'Trung tâm Khuyến nông Quốc gia', level: 'trung_uong', parent_id: null, admin_unit_id: null, created_at: timestamp });
  const provinceNodeIds = new Map<string, string>();
  for (const province of PROVINCES) {
    const id = uuid();
    provinceNodeIds.set(province.code, id);
    insert('org_nodes', {
      id, code: `TTKN-${province.code}`, name: `Trung tâm Khuyến nông ${province.name}`,
      level: 'tinh', parent_id: centralId, admin_unit_id: provinceIds.get(province.code)!, created_at: timestamp,
    });
    insert('org_nodes', {
      id: uuid(), code: `TKNCD-${province.code}`, name: `Tổ Khuyến nông cộng đồng ${province.name}`,
      level: 'xa', parent_id: id, admin_unit_id: provinceIds.get(province.code)!, created_at: timestamp,
    });
    insert('extension_officers', {
      id: uuid(), user_id: null, full_name: `Cán bộ trực ${province.name}`,
      phone: `0${900_000_000 + province.code.charCodeAt(0) * 1_000}`,
      org_node_id: id, specialty: 'Kỹ thuật canh tác lúa', on_duty: 1,
    });
  }

  // ---------- Nội dung khuyến nông & giá thị trường ----------
  const awdId = uuid();
  insert('knowledge_articles', {
    id: awdId, code: 'KB-00001', title: 'Quy trình canh tác lúa giảm phát thải theo AWD',
    kind: 'quy_trinh', category: 'ky_thuat', urgent: 0, summary: 'Kỹ thuật tưới ngập – khô xen kẽ (AWD) áp dụng cho Đề án 1 triệu ha lúa chất lượng cao.',
    body: 'Nội dung quy trình kỹ thuật: chuẩn bị đất, gieo sạ, quản lý nước theo AWD, bón phân, thu hoạch và xử lý rơm rạ.',
    crop: 'lúa', status: 'published', scope_node_id: null, parent_id: null, region_label: null, view_count: 128, published_at: timestamp, author_id: null,
    created_at: timestamp, updated_at: timestamp,
  });
  insert('knowledge_articles', {
    id: uuid(), code: 'KB-00002', title: 'Thu gom và bảo quản rơm sau thu hoạch',
    kind: 'tai_lieu', category: 'ky_thuat', urgent: 0, summary: 'Hướng dẫn cuộn kiện, kiểm soát độ ẩm ≤ 14% và bảo quản rơm trước khi nhập Hub.',
    body: 'Rơm cần được phơi đạt độ ẩm ≤ 14% trước khi ép kiện; tránh chất đống khi còn ẩm để không tự bốc nhiệt.',
    crop: 'lúa', status: 'published', scope_node_id: null, parent_id: null, region_label: null, view_count: 64, published_at: timestamp, author_id: null,
    created_at: timestamp, updated_at: timestamp,
  });
  // US-LIB-02: hướng dẫn đặc thù địa phương gắn với quy trình gốc, nhãn riêng theo tỉnh.
  insert('knowledge_articles', {
    id: uuid(), code: 'KB-00003', title: 'Hướng dẫn AWD cho vùng phèn Đồng Tháp Mười',
    kind: 'quy_trinh', category: 'ky_thuat', urgent: 0, summary: 'Bổ sung của TTKN Đồng Tháp: rút nước nông hơn (−10 cm) ở ruộng phèn nặng, kèm bón vôi đầu vụ.',
    body: 'Áp dụng cùng quy trình AWD chuẩn quốc gia. Riêng vùng phèn: ngưỡng rút nước −10 cm thay cho −15 cm; bón 300–500 kg vôi/ha trước sạ.',
    crop: 'lúa', status: 'published', scope_node_id: provinceNodeIds.get('DT') ?? null, parent_id: awdId, region_label: 'Đồng Tháp', view_count: 21, published_at: timestamp, author_id: null,
    created_at: timestamp, updated_at: timestamp,
  });
  // US-NEWS-03: tin cảnh báo khẩn (dịch hại) — hiện đầu danh sách tin của nông dân.
  insert('knowledge_articles', {
    id: uuid(), code: 'KB-00004', title: 'Cảnh báo rầy nâu phát sinh diện rộng đầu vụ Thu Đông',
    kind: 'tin_tuc', category: 'canh_bao', urgent: 1, summary: 'Mật độ rầy 1.500–3.000 con/m² tại An Giang, Đồng Tháp. Thăm đồng 3 ngày/lần, không phun ngừa khi chưa tới ngưỡng.',
    body: 'Theo Chi cục Trồng trọt & BVTV: rầy nâu tuổi 2–3 xuất hiện diện rộng. Khuyến cáo: giữ nước ruộng, dùng thuốc trong danh mục khi mật độ > 3 con/tép, tuyệt đối không phun ngừa.',
    crop: 'lúa', status: 'published', scope_node_id: null, parent_id: null, region_label: 'ĐBSCL', view_count: 340, published_at: timestamp, author_id: null,
    created_at: timestamp, updated_at: timestamp,
  });

  const today = nowIso().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  for (const [commodity, price, previous] of [['Lúa OM5451', 7_600, 7_400], ['Lúa Jasmine 85', 8_900, 9_050], ['Rơm khô ép kiện', 1_150, 1_100]] as const) {
    insert('market_prices', { id: uuid(), commodity, unit: 'VNĐ/kg', price: previous, price_date: yesterday, region: 'ĐBSCL', source: 'Khảo sát thương lái' });
    insert('market_prices', { id: uuid(), commodity, unit: 'VNĐ/kg', price, price_date: today, region: 'ĐBSCL', source: 'Khảo sát thương lái' });
  }

  // ---------- Ngưỡng môi trường mặc định (Warehouse FN-37) ----------
  insert('env_thresholds', {
    id: uuid(), facility_id: null,
    humidity_warn: 18, humidity_crit: 22, temp_warn: 40, temp_crit: 55, updated_at: timestamp,
  });
  insert('retention_policy', {
    id: 'default', event_log_days: 730, snapshot_days: 365, compact_after_days: 90, updated_at: timestamp,
  });

  // ---------- 49 tham số mô phỏng + bộ tham số v1 ----------
  seedParameters();

  // ---------- Quy trình sản xuất chuẩn VietGAP ----------
  seedVietGapProtocol();
  // ---------- Danh mục giống lúa (HTX US-CAT-01) — gắn SOP VietGAP làm quy trình mặc định ----------
  seedVarietiesIfEmpty();

  // ---------- Thôn/ấp, danh mục vật tư, mẫu khảo sát ----------
  seedHamlets();
  seedInputCatalogue();
  seedSurveyTemplate();

  // ---------- Công trình vượt sông + suy ra tải trọng lưu thông ----------
  seedWaterwayStructures();

  // ---------- Hợp đồng thu mua rơm + danh mục ghe (trước hiện trường, để việc có ưu tiên và phiếu có giá) ----------
  seedStrawChain(htxIds);

  // ---------- Đội thu gom rơm của Mekong Green ----------
  seedFieldTeams();

  // Phiếu mua rơm đã sinh từ các việc hoàn thành trong seed — xác nhận một phiếu để có công nợ mẫu.
  // Chỉ xác nhận phiếu đã có giá hợp đồng — phiếu không hợp đồng phải có người nhập giá (PM-03).
  const ready = listTickets({ status: 'cho_xac_nhan' }).find((t) => t.unit_price);
  if (ready) confirmTicket(String(ready.id), {}, { name: 'seed' });

  // ---------- Tài khoản mẫu ----------
  const firstHtxId = [...htxIds.values()][0];
  const provinceOf = (code: string) => provinceIds.get(code) ?? undefined;
  const orgNodeByCode = (code: string) => one<{ id: string }>('SELECT id FROM org_nodes WHERE code = ?', [code])?.id;
  const firstHtxOfProvince = (code: string) => one<{ id: string }>('SELECT id FROM cooperatives WHERE province_id = ? ORDER BY code LIMIT 1', [provinceOf(code) ?? ''])?.id;
  const accounts: { username: string; fullName: string; roles: string[]; htxId?: string; provinceId?: string; orgNodeId?: string }[] = [
    { username: 'SAdmin', fullName: 'Quản trị hệ thống (Super Admin)', roles: [ROLES.PLATFORM_ADMIN] },
    { username: 'supplychain', fullName: 'Trưởng bộ phận Supply Chain', roles: [ROLES.SUPPLY_CHAIN] },
    { username: 'taichinh', fullName: 'Trưởng bộ phận Tài chính', roles: [ROLES.FINANCE] },
    { username: 'banlanhdao', fullName: 'Ban lãnh đạo Mekong Green', roles: [ROLES.EXECUTIVE] },
    { username: 'khonhap', fullName: 'Nhân viên vận hành kho', roles: [ROLES.WAREHOUSE_OP] },
    { username: 'dieuphoi', fullName: 'Điều phối vận tải', roles: [ROLES.LOGISTICS] },
    { username: 'hientruong', fullName: 'Điều hành hiện trường', roles: [ROLES.FIELD_MANAGER] },
    { username: 'doitruong', fullName: 'Đội trưởng Đội 1 — Long Xuyên', roles: [ROLES.FIELD_CREW] },
    { username: 'canbo_tw', fullName: 'Cán bộ Khuyến nông Trung ương', roles: [ROLES.KN_TRUNG_UONG] },
    // Cán bộ xã gắn đầu mối Tổ KNCĐ và HTX phụ trách để phạm vi dữ liệu là xã, không phải tỉnh (UAT DEF-KN-02).
    { username: 'canbo_xa', fullName: 'Cán bộ Khuyến nông xã Vĩnh Bình (An Giang)', roles: [ROLES.KN_XA], provinceId: provinceOf('AG'), orgNodeId: orgNodeByCode('TKNCD-AG'), htxId: firstHtxId },
    { username: 'canbo_xa_dt', fullName: 'Cán bộ Khuyến nông xã Tân Hồng (Đồng Tháp)', roles: [ROLES.KN_XA], provinceId: provinceOf('DT'), orgNodeId: orgNodeByCode('TKNCD-DT'), htxId: firstHtxOfProvince('DT') },
    { username: 'htx01', fullName: 'Ban quản lý HTX Vĩnh Bình', roles: [ROLES.HTX_MANAGER], htxId: firstHtxId, provinceId: provinceOf('AG') },
    { username: 'nongdan', fullName: 'Nông dân Nguyễn Văn A', roles: [ROLES.FARMER], htxId: firstHtxId, provinceId: provinceOf('AG') },
    // Admin theo phạm vi (SA-08..12): KN tỉnh An Giang tự quản cán bộ tỉnh mình; ERP có admin toàn hệ thống.
    { username: 'qtri_kn_ag', fullName: 'Quản trị Khuyến nông tỉnh An Giang', roles: [ROLES.KN_TINH], provinceId: provinceOf('AG') },
    { username: 'qtri_erp', fullName: 'Quản trị hệ thống ERP', roles: [ROLES.SUPPLY_CHAIN] },
    { username: 'cuc_ktht', fullName: 'Cục KTHT & PTNT', roles: [ROLES.DCRD_VIEWER] },
    { username: 'vvb', fullName: 'Kiểm định viên SGS', roles: [ROLES.VVB_AUDITOR] },
  ];
  // Tài khoản trình diễn dùng mật khẩu ngắn để thử nhanh (bỏ qua chính sách); Super Admin dùng mật khẩu chuẩn.
  for (const account of accounts) {
    const password = account.username === 'SAdmin' ? (process.env.SUPER_ADMIN_PASSWORD ?? 'TungLM18@') : '123456';
    createUser({ ...account, password }, { name: 'seed' }, { enforcePolicy: false });
  }
  // Uỷ quyền phạm vi: super admin cấp cho hai admin mẫu.
  const superCtx = tryAdminContext(listUsers().find((u) => u.username === 'SAdmin')!)!;
  const byName = (name: string) => listUsers().find((u) => u.username === name)!;
  const ag = provinceOf('AG');
  if (ag) grantScope({ userId: byName('qtri_kn_ag').id, system: 'kn', scopeType: 'province', scopeId: ag, note: 'Trung tâm Khuyến nông tỉnh tự quản cán bộ tỉnh' }, superCtx, { name: 'seed' });
  grantScope({ userId: byName('qtri_erp').id, system: 'erp', scopeType: 'system', note: 'Quản trị toàn ERP nội bộ, được uỷ quyền tiếp cấp dưới' }, superCtx, { name: 'seed' });

  // Hai tài khoản có Zalo id mẫu: khi chưa cấu hình Zalo OA, thông báo của họ nằm ở
  // trạng thái "chờ cấu hình" — để màn hình quản trị chỉ đúng chỗ đang thiếu.
  run(`UPDATE users SET zalo_user_id = '8421390055671234' WHERE username = 'hientruong'`);
  run(`UPDATE users SET zalo_user_id = '8421390055675678' WHERE username = 'dieuphoi'`);

  // Snapshot ngày đầu tiên để chức năng replay (GIS FN-19) có dữ liệu gốc.
  captureSnapshot();
}

/**
 * Hợp đồng thu mua rơm với hai HTX (một theo tấn cân, một theo cuộn) và danh mục
 * ghe thuê — đúng các số hiệu ghe mà seed hiện trường dùng, để lượt ghe nào cũng
 * tra được đơn giá và đăng kiểm. Giá tham khảo thị trường ĐBSCL 2026: rơm cuộn
 * 20–25 nghìn đ/cuộn, ~1 triệu đ/tấn tại nhà máy; cước ghe 150–200 nghìn đ/tấn.
 */
function seedStrawChain(htxIds: Map<string, string>): void {
  const seedActor = { name: 'seed' };
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const vinhBinh = htxIds.get('HTX Nông nghiệp Vĩnh Bình');
  const tanHiep = htxIds.get('HTX Tân Hiệp Phát Đạt');
  if (vinhBinh) {
    createContract({
      htxId: vinhBinh, fromDate: day(-60), toDate: day(120), committedTons: 1_500, priceBasis: 'theo_tan_can', unitPrice: 1_050_000,
      maxMoisturePct: 18, note: 'Vụ Hè Thu – Thu Đông 2026; trả theo tấn cân tại nhà máy, độ ẩm ≤ 18 %',
    }, seedActor);
  }
  if (tanHiep) {
    createContract({
      htxId: tanHiep, fromDate: day(-30), toDate: day(150), committedTons: 900, priceBasis: 'theo_cuon', unitPrice: 22_000,
      note: 'Trả theo cuộn đếm tại ruộng — HTX bán rơm cuộn, không chờ cân',
    }, seedActor);
  }
  const vessels = [
    { code: 'AG-12345', name: 'Ghe Năm Cường', kind: 'ghe' as const, ownerName: 'Lê Văn Cường', ownerPhone: '0919 331 220', registeredTons: 100, strawPayloadTons: 90, registrationExpiry: day(240), rateType: 'per_ton' as const, rateVnd: 180_000 },
    { code: 'AG-10088', name: 'Ghe Hai Nghĩa', kind: 'ghe' as const, ownerName: 'Trần Hữu Nghĩa', ownerPhone: '0938 774 105', registeredTons: 100, strawPayloadTons: 85, registrationExpiry: day(18), rateType: 'per_ton' as const, rateVnd: 175_000 },
    { code: 'AG-20311', name: 'Ghe Ba Thê', kind: 'ghe' as const, ownerName: 'Nguyễn Văn Bé', ownerPhone: '0907 620 118', registeredTons: 120, strawPayloadTons: 95, registrationExpiry: day(400), rateType: 'per_ton_km' as const, rateVnd: 950 },
    { code: 'KG-30877', name: 'Ghe Út Lợi', kind: 'ghe' as const, ownerName: 'Phạm Văn Lợi', ownerPhone: '0913 501 776', registeredTons: 100, strawPayloadTons: 90, registrationExpiry: day(-12), rateType: 'per_ton' as const, rateVnd: 185_000, note: 'Đăng kiểm hết hạn — chủ ghe nói đang làm lại' },
    { code: 'SL-2001', name: 'Sà lan Sông Hậu 01', kind: 'sa_lan' as const, vesselClass: 'sa_lan_1000t', ownerName: 'Công ty Vận tải Sông Hậu', ownerPhone: '0292 3 880 112', registeredTons: 1_000, strawPayloadTons: 600, registrationExpiry: day(300), rateType: 'per_trip' as const, rateVnd: 38_000_000 },
  ];
  for (const v of vessels) createVessel(v, seedActor);
}

/**
 * Đội thu gom rơm của Mekong Green — dữ liệu mẫu để Cổng Hiện trường có việc
 * ngay khi mở: bốn đội đóng ở bốn cụm ruộng, máy cuộn khai báo năng lực, việc
 * lập từ lịch gặt sẵn có (crop_status), một việc đã làm xong hôm qua để báo cáo
 * năng suất có số, một việc quá hạn để dashboard hiện cờ rủi ro.
 *
 * Mốc thời gian neo theo NGÀY CHẠY SEED, không hard-code — bản trình diễn mở
 * tháng sau vẫn thấy "hôm nay", "hôm qua" đúng nghĩa.
 */
export function seedFieldTeams(): void {
  const seedActor = { name: 'seed' };
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const at = (offset: number, hour: number) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00.000Z`;

  const TEAMS = [
    { name: 'Đội 1 — Long Xuyên', leader: 'Trần Văn Bảy', phone: '0913 220 118', lat: 10.3860, lng: 105.4350, label: 'Bến Long Xuyên, sông Hậu', balers: [45, 40], extra: ['may_keo', 'may_xuc'] },
    { name: 'Đội 2 — Thoại Sơn', leader: 'Lê Minh Tâm', phone: '0918 445 902', lat: 10.2670, lng: 105.2620, label: 'Thoại Sơn, An Giang', balers: [40, 35], extra: ['may_keo', 'xe_tai'] },
    { name: 'Đội 3 — Vị Thanh', leader: 'Nguyễn Hữu Lộc', phone: '0939 771 265', lat: 9.7840, lng: 105.4700, label: 'Vị Thanh, Hậu Giang (cũ)', balers: [40, 35], extra: ['may_keo', 'may_xuc', 'ghe'] },
    { name: 'Đội 4 — Cao Lãnh', leader: 'Phạm Thị Hồng', phone: '0907 118 334', lat: 10.4600, lng: 105.6330, label: 'Cao Lãnh, Đồng Tháp', balers: [35, 35], extra: ['may_keo'] },
  ];
  const teamIds: string[] = [];
  TEAMS.forEach((spec, teamIndex) => {
    const team = field.createTeam({
      name: spec.name, leaderName: spec.leader, leaderPhone: spec.phone,
      baseLat: spec.lat, baseLng: spec.lng, baseLabel: spec.label,
    }, seedActor);
    const teamId = String(team.id);
    teamIds.push(teamId);
    field.addMember(teamId, { fullName: spec.leader, phone: spec.phone, role: 'doi_truong' }, seedActor);
    ['Lái máy', 'Công nhân', 'Công nhân', 'Công nhân'].forEach((role, index) => {
      field.addMember(teamId, {
        fullName: `${['Võ', 'Huỳnh', 'Đặng', 'Bùi'][index]} Văn ${['Sang', 'Được', 'Lợi', 'Kha'][(index + teamIndex) % 4]}`,
        role: role === 'Lái máy' ? 'lai_may' : 'cong_nhan',
      }, seedActor);
    });
    spec.balers.forEach((capacity, index) => {
      field.createVehicle({
        name: `Máy cuộn rơm ${capacity >= 40 ? 'Kubota' : 'Claas'} #${teamIndex + 1}.${index + 1}`, kind: 'may_cuon',
        teamId, capacityValue: capacity, plateNumber: `MC-${teamIndex + 1}${index + 1}`,
      }, seedActor);
    });
    spec.extra.forEach((kind, index) => {
      const label = { may_keo: 'Máy kéo', xe_tai: 'Xe tải 3.5 tấn', may_xuc: 'Máy xúc lật', ghe: 'Ghe 100 tấn' }[kind] ?? kind;
      field.createVehicle({
        name: `${label} #${teamIndex + 1}.${index + 1}`, kind,
        teamId, capacityValue: kind === 'ghe' ? 90 : kind === 'xe_tai' ? 3.5 : null,
        plateNumber: kind === 'xe_tai' ? `67C-${120 + teamIndex}.${45 + index}` : undefined,
      }, seedActor);
    });
  });
  // Một máy cuộn dự phòng chưa gán đội và một máy đang bảo dưỡng — để màn hình
  // điều phối phương tiện có gì để điều chuyển.
  field.createVehicle({ name: 'Máy cuộn rơm dự phòng', kind: 'may_cuon', capacityValue: 40 }, seedActor);
  const maintenance = field.createVehicle({ name: 'Máy kéo #3.9 (bảo dưỡng)', kind: 'may_keo', teamId: teamIds[2] }, seedActor);
  field.updateVehicle(String(maintenance.id), { status: 'bao_duong', note: 'Thay dây curoa, dự kiến xong tuần sau' }, seedActor);

  // ---- Việc đã hoàn thành hôm qua: HTX Vĩnh Bình, gặt 2 ngày trước ----
  const vinhBinh = one<{ id: string }>(`SELECT id FROM cooperatives WHERE name = 'HTX Nông nghiệp Vĩnh Bình'`);
  if (vinhBinh) {
    const done = field.createJob({
      sourceType: 'manual', htxId: vinhBinh.id, harvestDate: day(-2), expectedStrawTons: 120, areaHa: 42,
      locationLabel: 'HTX Nông nghiệp Vĩnh Bình — cánh đồng số 3', harvestConfirmed: true,
    }, seedActor);
    const doneId = String(done.id);
    field.assignJob(doneId, { teamId: teamIds[0], plannedDate: day(-2), mode: 'manual' }, seedActor);
    const baler = one<{ id: string }>(`SELECT id FROM field_vehicles WHERE team_id = ? AND kind = 'may_cuon' ORDER BY code LIMIT 1`, [teamIds[0]])!;
    field.startStage(doneId, 'cuon_rom', { vehicleId: baler.id, lat: 10.452, lng: 105.341, at: at(-2, 1) }, seedActor);
    // FM-09: đội đếm cuộn, tấn tự ước theo 20 kg/cuộn mặc định (5 800 cuộn ≈ 116 t).
    field.completeStage(doneId, 'cuon_rom', { bales: 5800, at: at(-1, 3), lat: 10.452, lng: 105.341,
      evidence: [{ kind: 'photo', note: 'Ảnh kiện rơm trên ruộng, 16:00' }] }, seedActor);
    field.startStage(doneId, 'gom_rom', { at: at(-2, 6) }, seedActor);
    field.completeStage(doneId, 'gom_rom', { bales: 5700, at: at(-1, 6) }, seedActor);
    // FM-09: ở ruộng đếm cuộn; tấn là ước tính (20 kg/cuộn mặc định).
    const first = field.recordLoading(doneId, { vesselCode: 'AG-12345', vesselKind: 'ghe', bales: 4400, at: at(-1, 8), driverName: 'Lê Văn Cường' }, seedActor);
    field.recordLoading(doneId, { vesselCode: 'AG-10088', vesselKind: 'ghe', bales: 1300, at: at(-1, 10), driverName: 'Trần Hữu Nghĩa' }, seedActor);
    field.completeStage(doneId, 'xuong_ghe', { at: at(-1, 10) }, seedActor);
    // Ghe thứ nhất đã cập nhà máy và cân: 4 400 cuộn → 96 800 kg (22 kg/cuộn, +10 % so với ước 88 t → gắn cờ FM-10).
    field.recordPlantWeighing(String(first.loading.id), { grossKg: 138_400, tareKg: 41_600, plantBales: 4400, at: at(0, 1) }, seedActor);
    // Ghe thứ hai còn đang chạy — nằm ở hàng đợi cân.
  }

  // ---- Hai việc nữa đã hoàn thành trong tuần, ghe đã cân — để đối chiếu giả định –
  // thực tế có đủ mẫu (≥ 3 ghe cân) và đối soát có nhiều hơn một dòng ----
  const moreDone: { htx: string; team: number; daysAgo: number; label: string; bales: number; gathered: number; vessel: string; netKg: number; plantBales: number }[] = [
    { htx: 'HTX Tân Hiệp Phát Đạt', team: 1, daysAgo: 6, label: 'HTX Tân Hiệp Phát Đạt — kênh Ba Thê', bales: 4300, gathered: 4250, vessel: 'AG-20311', netKg: 84_200, plantBales: 4210 },
    { htx: 'HTX Giồng Riềng An Bình', team: 2, daysAgo: 9, label: 'HTX Giồng Riềng An Bình — ấp Hoà Lợi', bales: 4600, gathered: 4580, vessel: 'KG-30877', netKg: 91_500, plantBales: 4550 },
  ];
  for (const spec of moreDone) {
    const htx = one<{ id: string; lat: number; lng: number }>(`SELECT id, lat, lng FROM cooperatives WHERE name = ?`, [spec.htx]);
    if (!htx) continue;
    const job = field.createJob({
      sourceType: 'manual', htxId: htx.id, harvestDate: day(-spec.daysAgo), expectedStrawTons: 100, areaHa: 35,
      locationLabel: spec.label, harvestConfirmed: true,
    }, seedActor);
    const jobId = String(job.id);
    const teamId = teamIds[spec.team];
    field.assignJob(jobId, { teamId, plannedDate: day(-spec.daysAgo), mode: 'auto' }, seedActor);
    const baler = one<{ id: string }>(`SELECT id FROM field_vehicles WHERE team_id = ? AND kind = 'may_cuon' ORDER BY code LIMIT 1`, [teamId])!;
    field.startStage(jobId, 'cuon_rom', { vehicleId: baler.id, lat: htx.lat, lng: htx.lng, at: at(-spec.daysAgo, 1) }, seedActor);
    field.completeStage(jobId, 'cuon_rom', { bales: spec.bales, at: at(-spec.daysAgo + 1, 2), lat: htx.lat, lng: htx.lng }, seedActor);
    field.startStage(jobId, 'gom_rom', { at: at(-spec.daysAgo, 5) }, seedActor);
    field.completeStage(jobId, 'gom_rom', { bales: spec.gathered, at: at(-spec.daysAgo + 1, 6) }, seedActor);
    const load = field.recordLoading(jobId, { vesselCode: spec.vessel, vesselKind: 'ghe', bales: spec.gathered, at: at(-spec.daysAgo + 1, 8) }, seedActor);
    field.completeStage(jobId, 'xuong_ghe', { at: at(-spec.daysAgo + 1, 9) }, seedActor);
    field.recordPlantWeighing(String(load.loading.id), { netKg: spec.netKg, plantBales: spec.plantBales, at: at(-spec.daysAgo + 2, 3) }, seedActor);
  }

  // ---- Việc quá hạn: gặt 5 ngày trước, đã phân công nhưng chưa ai cuộn (FM-02) ----
  const thoaiSon = one<{ id: string }>(`SELECT id FROM cooperatives WHERE name = 'HTX Dịch vụ NN Thoại Sơn'`);
  if (thoaiSon) {
    const overdue = field.createJob({
      sourceType: 'manual', htxId: thoaiSon.id, harvestDate: day(-5), expectedStrawTons: 60, areaHa: 21,
      locationLabel: 'HTX Dịch vụ NN Thoại Sơn — khu B', harvestConfirmed: true,
      note: 'Máy cuộn Đội 2 hỏng 3 ngày, đang chờ điều máy dự phòng',
    }, seedActor);
    field.assignJob(String(overdue.id), { teamId: teamIds[1], plannedDate: day(-4), mode: 'manual' }, seedActor);
  }

  // ---- Việc đang làm hôm nay: gặt hôm qua, đang cuộn ----
  const chauPhu = one<{ id: string }>(`SELECT id FROM cooperatives WHERE name = 'HTX Châu Phú Tiến Lên'`);
  if (chauPhu) {
    const running = field.createJob({
      sourceType: 'manual', htxId: chauPhu.id, harvestDate: day(-1), expectedStrawTons: 95, areaHa: 33,
      locationLabel: 'HTX Châu Phú Tiến Lên — ấp Mỹ Phú', harvestConfirmed: true,
    }, seedActor);
    field.assignJob(String(running.id), { teamId: teamIds[3], plannedDate: day(0), mode: 'manual' }, seedActor);
    const baler = one<{ id: string }>(`SELECT id FROM field_vehicles WHERE team_id = ? AND kind = 'may_cuon' LIMIT 1`, [teamIds[3]])!;
    field.startStage(String(running.id), 'cuon_rom', { vehicleId: baler.id, lat: 10.581, lng: 105.208, at: at(0, 0) }, seedActor);
  }

  // ---- Lịch gặt 14 ngày tới từ crop_status → việc chờ phân công, rồi phân công tự động một nửa ----
  field.syncHarvestCalendar(day(0), 14, seedActor);
  const pending = all<{ id: string }>(`SELECT id FROM field_jobs WHERE status = 'cho_phan_cong' ORDER BY harvest_date`);
  pending.slice(0, Math.ceil(pending.length / 2)).forEach((job, index) => {
    field.assignJob(job.id, { teamId: teamIds[index % teamIds.length], mode: 'auto' }, seedActor);
  });
}

/**
 * Quy trình canh tác lúa theo VietGAP — bản mẫu để HTX áp dụng ngay.
 *
 * Các mốc neo theo NGÀY XUỐNG GIỐNG (offset = 0). Số âm là các việc làm trước
 * khi sạ. Bước phun thuốc mang thời gian cách ly (PHI) để hệ thống chặn thu
 * hoạch sớm — đây là yêu cầu an toàn thực phẩm bắt buộc của VietGAP.
 */
export function seedVietGapProtocol(): void {
  const protocol = createProtocol({
    code: 'VIETGAP-LUA',
    name: 'Quy trình canh tác lúa theo VietGAP',
    standard: 'vietgap',
    crop: 'lua',
    scope: 'he_thong',
    documentRef: 'TCVN 11892-1:2017 — Thực hành nông nghiệp tốt (VietGAP) trồng trọt',
    description:
      'Quy trình 12 bước từ làm đất đến thu hoạch, có điểm kiểm soát và bằng chứng bắt buộc ' +
      'phục vụ truy xuất nguồn gốc và chứng nhận VietGAP.',
  }, { name: 'seed' });

  const steps: Parameters<typeof addProtocolStep>[1][] = [
    {
      name: 'Vệ sinh đồng ruộng, xử lý rơm rạ vụ trước', activity: 'lam_dat',
      stage: 'Chuẩn bị đất', offsetDays: -20, windowDays: 5,
      evidenceKinds: ['anh_hien_truong'],
      controlPoint: 'Không đốt rơm rạ tại ruộng (yêu cầu môi trường + nguồn nguyên liệu Hub)',
      instruction: 'Thu gom rơm rạ hoặc cày vùi; ghi nhận khối lượng rơm nếu bán cho đơn vị thu mua.',
    },
    {
      name: 'Làm đất, san phẳng mặt ruộng', activity: 'lam_dat',
      stage: 'Chuẩn bị đất', offsetDays: -10, windowDays: 4,
      evidenceKinds: ['anh_hien_truong'],
      controlPoint: 'Chênh cao mặt ruộng ≤ 5 cm để tưới tiết kiệm nước',
    },
    {
      name: 'Bón lót', activity: 'bon_phan', stage: 'Chuẩn bị đất',
      offsetDays: -2, windowDays: 2,
      evidenceKinds: ['hoa_don_vat_tu'],
      controlPoint: 'Chỉ dùng phân trong danh mục được phép; lưu hoá đơn và nhãn bao bì',
    },
    {
      name: 'Gieo sạ', activity: 'gieo_sa', stage: 'Gieo sạ',
      offsetDays: 0, windowDays: 2,
      evidenceKinds: ['anh_hien_truong', 'hoa_don_vat_tu'],
      controlPoint: 'Giống xác nhận, có hoá đơn; mật độ sạ ≤ 120 kg/ha',
    },
    {
      name: 'Bón thúc lần 1 (đẻ nhánh)', activity: 'bon_phan', stage: 'Đẻ nhánh',
      offsetDays: 18, windowDays: 3,
      evidenceKinds: ['hoa_don_vat_tu'],
    },
    {
      name: 'Rút nước lần 1 (AWD — ngập khô xen kẽ)', activity: 'rut_nuoc_awd',
      stage: 'Đẻ nhánh', offsetDays: 25, windowDays: 4,
      evidenceKinds: ['anh_hien_truong'],
      controlPoint: 'Mực nước xuống -15 cm so với mặt ruộng trước khi tưới lại',
      instruction: 'Dữ liệu AWD là căn cứ tính giảm phát thải khí mê-tan cho hồ sơ MRV.',
    },
    {
      name: 'Phun thuốc bảo vệ thực vật đợt 1', activity: 'phun_thuoc',
      stage: 'Đẻ nhánh', offsetDays: 30, windowDays: 5,
      evidenceKinds: ['hoa_don_vat_tu', 'anh_hien_truong'],
      phiDays: 14,
      controlPoint: 'Thuốc trong danh mục cho phép; ghi rõ hoạt chất, liều lượng, thời gian cách ly',
    },
    {
      name: 'Bón thúc lần 2 (đón đòng)', activity: 'bon_phan', stage: 'Làm đòng',
      offsetDays: 42, windowDays: 3,
      evidenceKinds: ['hoa_don_vat_tu'],
    },
    {
      name: 'Rút nước lần 2 (AWD)', activity: 'rut_nuoc_awd', stage: 'Làm đòng',
      offsetDays: 50, windowDays: 4,
      evidenceKinds: ['anh_hien_truong'],
    },
    {
      name: 'Phun thuốc bảo vệ thực vật đợt 2', activity: 'phun_thuoc',
      stage: 'Trổ bông', offsetDays: 60, windowDays: 5,
      evidenceKinds: ['hoa_don_vat_tu'],
      phiDays: 21,
      controlPoint: 'Bắt buộc tuân thủ thời gian cách ly 21 ngày trước thu hoạch',
    },
    {
      name: 'Rút nước xiết chuẩn bị thu hoạch', activity: 'rut_nuoc_awd',
      stage: 'Chín', offsetDays: 85, windowDays: 5, mandatory: false,
      instruction: 'Giúp máy gặt vào ruộng thuận lợi và giảm ẩm độ hạt.',
    },
    {
      name: 'Thu hoạch', activity: 'thu_hoach', stage: 'Thu hoạch',
      offsetDays: 100, windowDays: 7,
      evidenceKinds: ['anh_hien_truong'],
      controlPoint: 'Ẩm độ hạt ≤ 22%; ghi nhận trạng thái rơm để đơn vị thu gom lên kế hoạch',
    },
  ];

  for (const step of steps) addProtocolStep(protocol.id as string, step, { name: 'seed' });
  publishProtocol(protocol.id as string, { name: 'seed' });
}

/**
 * Thôn/ấp cho mỗi xã đã seed — cấp thứ ba của cây hành chính.
 *
 * Cần thiết để ô "Thôn/Ấp" của phiếu khảo sát lọc được theo xã đã chọn. Không có
 * cấp này thì cán bộ phải gõ tay và dữ liệu địa bàn sẽ không gộp nhóm được.
 */
export function seedHamlets(): void {
  // ---- Cấp xã ----
  // Bộ seed gốc chỉ có cấp tỉnh. Sau sáp nhập 2025, đơn vị cấp huyện cũ trở
  // thành đơn vị cấp xã của tỉnh mới, nên dùng luôn bảng tra địa danh làm nguồn.
  const provinces = all<{ id: string; code: string; name: string }>(
    "SELECT id, code, name FROM admin_units WHERE level = 'province'",
  );
  const provinceByName = new Map(provinces.map((row) => [row.name, row]));

  for (const district of listDistricts()) {
    // Khoá của bảng sáp nhập ở dạng chuẩn hoá (không dấu, chữ thường), nên phải
    // chuẩn hoá tên tỉnh cũ trước khi tra — nếu không, toàn bộ huyện thuộc các
    // tỉnh đã bị sáp nhập (Kiên Giang, Tiền Giang, Bến Tre...) sẽ bị bỏ sót.
    const merged = PROVINCE_MERGER[normalizeName(district.oldProvince)];
    const province = provinceByName.get(merged?.newProvince ?? district.oldProvince);
    if (!province) continue;

    const code = `${province.code}-${slugCode(district.name)}`;
    if (one('SELECT id FROM admin_units WHERE code = ?', [code])) continue;
    insert('admin_units', {
      id: uuid(),
      code,
      name: district.name,
      level: 'commune',
      parent_id: province.id,
      boundary: null,
      centroid_lat: district.lat,
      centroid_lng: district.lng,
    });
  }

  // ---- Cấp thôn/ấp ----
  // Cần thiết để ô "Thôn/Ấp" của phiếu khảo sát lọc được theo xã đã chọn. Không
  // có cấp này thì cán bộ phải gõ tay và dữ liệu địa bàn không gộp nhóm được.
  const communes = all<{ id: string; code: string; name: string }>(
    "SELECT id, code, name FROM admin_units WHERE level = 'commune'",
  );
  const names = ['Ấp 1', 'Ấp 2', 'Ấp 3', 'Ấp Bình An', 'Ấp Tân Lập'];
  for (const commune of communes) {
    const existing = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM admin_units WHERE parent_id = ? AND level = 'ap'", [commune.id],
    );
    if ((existing?.n ?? 0) > 0) continue;
    names.forEach((name, index) => {
      insert('admin_units', {
        id: uuid(),
        code: `${commune.code}-A${index + 1}`,
        name,
        level: 'ap',
        parent_id: commune.id,
        boundary: null,
        centroid_lat: null,
        centroid_lng: null,
      });
    });
  }
}

/** Mã ngắn không dấu, dùng cho mã đơn vị hành chính sinh tự động. */
function slugCode(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
}

/** Danh mục vật tư dùng chung: phân bón phổ biến và thuốc BVTV có cách ly. */
export function seedInputCatalogue(): void {
  if (one('SELECT id FROM input_items LIMIT 1')) return;
  const items: Parameters<typeof createInputItem>[0][] = [
    { code: 'VT-URE', name: 'Đạm Urê 46%', category: 'phan_bon', uom: 'kg' },
    { code: 'VT-DAP', name: 'Phân DAP 18-46-0', category: 'phan_bon', uom: 'kg' },
    { code: 'VT-KALI', name: 'Kali Clorua 60%', category: 'phan_bon', uom: 'kg' },
    { code: 'VT-NPK', name: 'NPK 20-20-15', category: 'phan_bon', uom: 'kg' },
    {
      code: 'VT-BVTV-01', name: 'Thuốc trừ rầy Chess 50WG', category: 'thuoc_bvtv', uom: 'gói',
      activeIngredient: 'Pymetrozine', phiDays: 14, permitted: true,
      permitRef: 'Danh mục thuốc BVTV được phép sử dụng tại Việt Nam',
    },
    {
      code: 'VT-BVTV-02', name: 'Thuốc trừ bệnh đạo ôn Filia 525SE', category: 'thuoc_bvtv', uom: 'chai',
      activeIngredient: 'Tricyclazole + Propiconazole', phiDays: 21, permitted: true,
      permitRef: 'Danh mục thuốc BVTV được phép sử dụng tại Việt Nam',
    },
    {
      // Ví dụ hoạt chất ĐÃ BỊ CẤM — có trong danh mục để hệ thống chặn được khi
      // ai đó vô tình chọn, thay vì im lặng cho qua.
      code: 'VT-BVTV-CAM', name: 'Thuốc chứa hoạt chất Paraquat', category: 'thuoc_bvtv', uom: 'chai',
      activeIngredient: 'Paraquat', phiDays: 30, permitted: false,
      permitRef: 'Đã loại khỏi danh mục được phép sử dụng tại Việt Nam',
    },
    { code: 'VT-GIONG-OM', name: 'Lúa giống OM5451 (cấp xác nhận)', category: 'giong', uom: 'kg' },
  ];
  for (const item of items) createInputItem(item, { name: 'seed' });
}

/** Mẫu khảo sát hiện trạng sản xuất định kỳ hàng tháng. */
export function seedSurveyTemplate(): void {
  if (one('SELECT id FROM survey_templates LIMIT 1')) return;
  const template = createSurveyTemplate({
    code: 'KS-HTSX',
    name: 'Khảo sát hiện trạng sản xuất lúa',
    purpose: 'Nắm tiến độ xuống giống, hiện trạng sinh trưởng và khó khăn của hộ dân/HTX theo tháng.',
    frequency: 'thang',
    subjectScope: 'ca_hai',
  }, { name: 'seed' }) as { id: string };

  const questions: Parameters<typeof addSurveyQuestion>[1][] = [
    { code: 'Q01', label: 'Diện tích đang canh tác', kind: 'number', uom: 'ha', required: true },
    { code: 'Q02', label: 'Giống lúa đang sử dụng', kind: 'text' },
    {
      code: 'Q03', label: 'Nguồn nước tưới', kind: 'select', required: true,
      options: ['Kênh nội đồng', 'Trạm bơm', 'Nước trời', 'Giếng khoan'],
    },
    {
      code: 'Q04', label: 'Khó khăn đang gặp', kind: 'multiselect',
      options: ['Hạn mặn', 'Sâu bệnh', 'Giá vật tư cao', 'Thiếu máy móc', 'Khó tiêu thụ'],
    },
    { code: 'Q05', label: 'Đã áp dụng quy trình VietGAP chưa', kind: 'boolean' },
    { code: 'Q06', label: 'Sản lượng vụ trước', kind: 'number', uom: 'tấn' },
    { code: 'Q07', label: 'Ghi chú của cán bộ khảo sát', kind: 'text' },
  ];
  for (const question of questions) addSurveyQuestion(template.id, question, { name: 'seed' });
  publishSurveyTemplate(template.id, { name: 'seed' });
}

/**
 * Cầu và công trình vượt sông trên các tuyến đường thuỷ mẫu.
 *
 * Đây là dữ liệu làm cho bài toán tải trọng có ý nghĩa: một tuyến rộng 80 m sâu
 * 4,5 m nhìn thì sà lan 2.000 tấn qua được, nhưng cây cầu tĩnh không 6 m trên đó
 * mới là thứ quyết định. Bộ seed cố ý đặt vài cầu thấp để chốt chặn có việc làm.
 */
export function seedWaterwayStructures(): void {
  if (one('SELECT id FROM waterway_structures LIMIT 1')) {
    deriveAllCapacities({ name: 'seed' });
    return;
  }

  const byName = (fragment: string) => one<{ id: string }>(
    "SELECT id FROM transport_routes WHERE mode = 'waterway' AND name LIKE ?", [`%${fragment}%`],
  );

  const bridges: {
    routeFragment: string; name: string; kind: string; lat: number; lng: number;
    clearanceHeightM?: number; clearanceWidthM?: number; depthM?: number; source: string;
  }[] = [
    // Sông Hậu — sông lớn, cầu tĩnh không cao, sà lan 2.000 tấn qua được.
    {
      routeFragment: 'Sông Hậu', name: 'Cầu Vàm Cống', kind: 'cau',
      lat: 10.3080, lng: 105.5390, clearanceHeightM: 37.5, clearanceWidthM: 300, depthM: 8,
      source: 'ho_so_thiet_ke',
    },
    {
      routeFragment: 'Sông Hậu', name: 'Cầu Cần Thơ', kind: 'cau',
      lat: 10.0110, lng: 105.8180, clearanceHeightM: 39, clearanceWidthM: 550, depthM: 9,
      source: 'ho_so_thiet_ke',
    },
    // Sông Tiền — tương tự.
    {
      routeFragment: 'Sông Tiền', name: 'Cầu Mỹ Thuận', kind: 'cau',
      lat: 10.2740, lng: 105.9100, clearanceHeightM: 37.5, clearanceWidthM: 350, depthM: 8,
      source: 'ho_so_thiet_ke',
    },
    {
      routeFragment: 'Sông Tiền', name: 'Cầu Rạch Miễu', kind: 'cau',
      lat: 10.3020, lng: 106.3500, clearanceHeightM: 37.5, clearanceWidthM: 270, depthM: 7,
      source: 'ho_so_thiet_ke',
    },
    // Kênh Chợ Gạo — tuyến huyết mạch nhưng có cầu thấp và luồng hẹp.
    {
      routeFragment: 'Chợ Gạo', name: 'Cầu Chợ Gạo', kind: 'cau',
      lat: 10.4200, lng: 106.4500, clearanceHeightM: 9, clearanceWidthM: 60, depthM: 4,
      source: 'khao_sat',
    },
    // Kênh Xà No — kênh nội đồng, cầu thấp, chỉ ghe qua được.
    {
      routeFragment: 'Xà No', name: 'Cầu Cái Tắc', kind: 'cau',
      lat: 9.9400, lng: 105.6800, clearanceHeightM: 5.5, clearanceWidthM: 25, depthM: 3,
      source: 'khao_sat',
    },
    {
      routeFragment: 'Xà No', name: 'Cống Vị Thanh', kind: 'cong',
      lat: 9.8600, lng: 105.5800, clearanceHeightM: 4.2, clearanceWidthM: 18, depthM: 2.8,
      source: 'khao_sat',
    },
    // Kênh Xáng Lấp Vò — tuyến nối hai sông lớn, quyết định tính liên thông.
    {
      routeFragment: 'Lấp Vò', name: 'Cầu Lấp Vò', kind: 'cau',
      lat: 10.3450, lng: 105.5600, clearanceHeightM: 7.5, clearanceWidthM: 50, depthM: 4.2,
      source: 'khao_sat',
    },
  ];

  for (const bridge of bridges) {
    const route = byName(bridge.routeFragment);
    if (!route) continue;
    try {
      addWaterwayStructure({
        routeId: route.id,
        name: bridge.name,
        kind: bridge.kind,
        lat: bridge.lat,
        lng: bridge.lng,
        clearanceHeightM: bridge.clearanceHeightM ?? null,
        clearanceWidthM: bridge.clearanceWidthM ?? null,
        depthM: bridge.depthM ?? null,
        dataSource: bridge.source,
      }, { name: 'seed' });
    } catch {
      // Cầu nằm quá xa tuyến trong dữ liệu minh hoạ thì bỏ qua, không chặn seed.
    }
  }

  deriveAllCapacities({ name: 'seed' });
}

/** Xoá toàn bộ dữ liệu nghiệp vụ (dùng cho `npm run seed -- --reset`). */
export function resetAll(): void {
  // Mỗi miền một tệp — duyệt sqlite_master của từng schema đã gắn.
  const schemas = all<{ name: string }>('PRAGMA database_list').map((r) => r.name);
  run('PRAGMA foreign_keys = OFF');
  for (const schema of schemas) {
    const tables = all<{ name: string }>(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    for (const table of tables) run(`DELETE FROM ${schema}.${table.name}`);
  }
  run('PRAGMA foreign_keys = ON');
}
