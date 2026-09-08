/**
 * QUẢN LÝ HIỆN TRƯỜNG (Field Management) — đội thu gom rơm của Mekong Green.
 *
 * Mekong Green không mua rơm đã đóng kiện; công ty tự đưa đội xuống ruộng ngay
 * sau khi máy gặt đi qua: CUỘN rơm thành kiện → GOM kiện ra bờ kênh → ĐƯA kiện
 * xuống ghe / sà lan. Ba công đoạn này quyết định hai thứ mà mọi phân hệ khác
 * chỉ nhận kết quả: rơm có kịp thu trước khi ẩm mục hay không, và ghe có hàng
 * để chạy hay không.
 *
 * Module đứng giữa ba nguồn dữ liệu sẵn có, không nhập tay lại thứ đã có:
 *   App HTX   ngày thu hoạch dự kiến, khai báo sản lượng → rơm ở đâu, bao giờ
 *   CGH       máy móc                                     → phương tiện đội mang theo
 *   TMS       chuyến ghe / sà lan                         → xuống ghe xong là có chuyến
 *
 * CHỐT CHẶN NGHIỆP VỤ
 *   FM-01  Không cuộn rơm trước ngày gặt — rơm chưa có thì không có gì để cuộn.
 *   FM-02  Rơm phải cuộn xong trong MAX_DAYS_AFTER_HARVEST ngày sau gặt; quá hạn
 *          không chặn (rơm vẫn phải thu) nhưng bị gắn cờ rủi ro ẩm mục.
 *   FM-03  Thứ tự công đoạn: chỉ HOÀN THÀNH khi công đoạn trước đã hoàn thành;
 *          được BẮT ĐẦU khi công đoạn trước đã bắt đầu (gom song song với cuộn).
 *   FM-04  Khối lượng không tăng qua công đoạn: gom ≤ cuộn, xuống ghe ≤ gom.
 *   FM-05  Mỗi lượt xuống ghe sinh MỘT chuyến TMS đường thuỷ; TMS lỗi không chặn
 *          ghi nhận hiện trường — chỉ trả cảnh báo.
 *   FM-06  Phân công tự động không xếp quá năng lực cuộn/ngày của đội; phân công
 *          tay được vượt nhưng phải thấy cảnh báo.
 *   FM-07  Chỉ đội đang hoạt động mới nhận việc.
 *   FM-08  Chạy phân công tự động nhiều lần không sinh việc trùng.
 *   FM-09  Ở ruộng ĐẾM CUỌN, không cân. Rơm ĐBSCL bán theo cuộn; cân chỉ có ở nhà
 *          máy. Tấn lúc cuộn / gom / xuống ghe là ƯỚC TÍNH = cuộn × kg/cuộn; số cân
 *          thật ghi khi ghe cập nhà máy và đối chiếu ngược về từng lượt ghe.
 *   FM-10  Cân nhà máy lệch quá 5 % so với ước tính thì gắn cờ và báo điều hành;
 *          kg/cuộn học từ chính các lượt đã cân để lần ước sau đúng hơn.
 */
import { all, insert, one, parseJson, transaction, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { haversineKm, type LatLng } from '../../platform/geo/geo.ts';
import { resolveParams } from '../params/store.ts';
import { completeTrip, createTrip } from '../tms/service.ts';
import { createGoodsReceipt, receiveInboundNotice, recordWeighing } from '../warehouse/service.ts';
import { notify } from '../../platform/notify/service.ts';
import { contractFor } from '../straw/contracts.ts';
import { generateTicketForJob, refreshTicketForJob } from '../straw/tickets.ts';
import { expiryStatus, tripCostFor, vesselByCode } from '../tms/vessels.ts';

// ---------------------------------------------------------------------------
// Danh mục
// ---------------------------------------------------------------------------

export const STAGES = [
  { code: 'cuon_rom', label: 'Cuộn rơm', order: 1, hint: 'Máy cuộn chạy trên ruộng, ép rơm thành kiện' },
  { code: 'gom_rom', label: 'Gom rơm', order: 2, hint: 'Gom kiện từ ruộng ra điểm tập kết bờ kênh' },
  { code: 'xuong_ghe', label: 'Đưa xuống ghe / sà lan', order: 3, hint: 'Bốc kiện lên phương tiện thuỷ — mỗi lượt là một chuyến TMS' },
] as const;
export type FieldStage = (typeof STAGES)[number]['code'];

export const VEHICLE_KINDS = [
  { code: 'may_cuon', label: 'Máy cuộn rơm', capacityUnit: 'tấn/ngày', plansCapacity: true },
  { code: 'may_keo', label: 'Máy kéo', capacityUnit: 'kiện/chuyến', plansCapacity: false },
  { code: 'xe_tai', label: 'Xe tải nhỏ', capacityUnit: 'tấn/chuyến', plansCapacity: false },
  { code: 'may_xuc', label: 'Máy xúc / xe nâng', capacityUnit: 'kiện/giờ', plansCapacity: false },
  { code: 'ghe', label: 'Ghe', capacityUnit: 'tấn/chuyến', plansCapacity: false },
  { code: 'sa_lan', label: 'Sà lan', capacityUnit: 'tấn/chuyến', plansCapacity: false },
] as const;

export const JOB_STATUS: Record<string, string> = {
  cho_phan_cong: 'Chờ phân công',
  da_phan_cong: 'Đã phân công',
  dang_thuc_hien: 'Đang thực hiện',
  hoan_thanh: 'Hoàn thành',
  huy: 'Đã huỷ',
};

export const MEMBER_ROLES: Record<string, string> = {
  doi_truong: 'Đội trưởng', lai_may: 'Lái máy', cong_nhan: 'Công nhân', lai_ghe: 'Lái ghe',
};

/** FM-02: rơm để trên ruộng quá số ngày này thì ẩm, mục, giảm giá bán. */
export const MAX_DAYS_AFTER_HARVEST = 3;

/**
 * Năng lực cuộn mặc định khi đội chưa khai báo máy (tấn/ngày). Một máy cuộn
 * tròn phổ biến ở ĐBSCL làm được 35–45 tấn/ngày; dùng mức thấp để không xếp
 * việc quá tay.
 */
const DEFAULT_TEAM_CAPACITY_TONS_PER_DAY = 35;

/** Năng suất lúa dùng để ước rơm khi vụ chưa khai báo sản lượng (tấn/ha). */
const PADDY_YIELD_TONS_PER_HA = 6;

/**
 * Khối lượng một cuộn rơm khi chưa có số cân nào (kg). Cuộn tròn máy Kubota /
 * Claas ở ĐBSCL nặng 18–25 kg tuỳ độ ẩm; đổi được ở system_config `field.bale_kg`.
 */
export const DEFAULT_BALE_KG = 20;

/** Cân nhà máy lệch quá mức này so với ước tính theo cuộn thì gắn cờ (FM-10). */
export const WEIGHING_VARIANCE_PCT = 5;

/**
 * kg/cuộn dùng để ước tấn. Ưu tiên số HỌC từ các lượt đã cân của chính HTX đó
 * (30 lượt gần nhất), rồi toàn hệ thống, rồi cấu hình, rồi mặc định. Số nào dùng
 * cũng nói rõ nguồn — người đọc phải biết 88 tấn kia là ước hay là cân.
 */
export function baleKg(htxId?: string | null): { kg: number; source: 'can_htx' | 'can_he_thong' | 'cau_hinh' | 'mac_dinh'; samples: number } {
  const learned = (where: string, params: unknown[]) => one<{ kg: number | null; bales: number | null; n: number }>(
    `SELECT SUM(l.weighed_kg) AS kg, SUM(l.bales) AS bales, COUNT(*) AS n FROM (
       SELECT l.weighed_kg, l.bales FROM field_loadings l JOIN field_jobs j ON j.id = l.job_id
       WHERE l.weighed_kg IS NOT NULL AND l.bales > 0 ${where} ORDER BY l.weighed_at DESC LIMIT 30) l`,
    params,
  );
  if (htxId) {
    const row = learned('AND j.htx_id = ?', [htxId]);
    if (row?.n && row.bales) return { kg: Math.round((row.kg! / row.bales) * 10) / 10, source: 'can_htx', samples: row.n };
  }
  const global = learned('', []);
  if (global?.n && global.bales) return { kg: Math.round((global.kg! / global.bales) * 10) / 10, source: 'can_he_thong', samples: global.n };
  try {
    const cfg = one<{ value_json: string }>(`SELECT value_json FROM system_config WHERE key = 'field.bale_kg'`);
    const value = cfg ? Number(JSON.parse(cfg.value_json)) : NaN;
    if (Number.isFinite(value) && value > 0) return { kg: value, source: 'cau_hinh', samples: 0 };
  } catch { /* chưa có cấu hình */ }
  return { kg: DEFAULT_BALE_KG, source: 'mac_dinh', samples: 0 };
}

const tonsFromBales = (bales: number, kg: number) => Math.round((bales * kg) / 100) / 10;

/**
 * Một HTX không gặt hết trong một ngày: mặt trận gặt kéo dài chừng ba tuần.
 * Số rơm cả vụ ở bảng trạng thái mùa vụ (cấp HTX) vì thế được chia cho số ngày
 * này để ra khối lượng MỘT NGÀY gặt — đơn vị mà đội thu gom thực sự đối mặt.
 * Lịch cấp thửa (crop_cycles) không cần chia vì đã là từng thửa.
 */
const HARVEST_WINDOW_DAYS = 20;

type Row = Record<string, unknown>;
const today = () => nowIso().slice(0, 10);
const addDays = (date: string, days: number) =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
const nextCode = (prefix: string, table: string) =>
  sequenceCode(prefix, (one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0) + 1, 5);

function stageMeta(stage: string) {
  const found = STAGES.find((item) => item.code === stage);
  if (!found) throw new Error(`Công đoạn không hợp lệ: ${stage}`);
  return found;
}

// ---------------------------------------------------------------------------
// Đội và phương tiện
// ---------------------------------------------------------------------------

export function createTeam(
  input: {
    name: string; leaderName?: string; leaderPhone?: string; leaderUserId?: string;
    baseLat?: number; baseLng?: number; baseLabel?: string; provinceId?: string; note?: string;
  },
  actor: AuditActor = {},
): Row {
  if (!input.name?.trim()) throw new Error('Tên đội không được để trống.');
  const timestamp = nowIso();
  const record = {
    id: uuid(), code: nextCode('DOI', 'field_teams'), name: input.name.trim(),
    leader_name: input.leaderName ?? null, leader_phone: input.leaderPhone ?? null,
    leader_user_id: input.leaderUserId ?? null,
    base_lat: input.baseLat ?? null, base_lng: input.baseLng ?? null, base_label: input.baseLabel ?? null,
    province_id: input.provinceId ?? null, status: 'hoat_dong', note: input.note ?? null,
    created_at: timestamp, updated_at: timestamp,
  };
  insert('field_teams', record);
  logEvent({ module: 'field', entityType: 'field_teams', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function updateTeam(id: string, patch: Record<string, unknown>, actor: AuditActor = {}): Row {
  const before = one('SELECT * FROM field_teams WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy đội.');
  const allowed: Record<string, string> = {
    name: 'name', leaderName: 'leader_name', leaderPhone: 'leader_phone', leaderUserId: 'leader_user_id',
    baseLat: 'base_lat', baseLng: 'base_lng', baseLabel: 'base_label', status: 'status', note: 'note',
  };
  const values: Record<string, unknown> = { updated_at: nowIso() };
  for (const [key, column] of Object.entries(allowed)) {
    if (patch[key] !== undefined) values[column] = patch[key] === '' ? null : patch[key];
  }
  if (values.status && !['hoat_dong', 'tam_nghi', 'giai_the'].includes(String(values.status))) {
    throw new Error('Trạng thái đội không hợp lệ.');
  }
  update('field_teams', id, values);
  const after = one('SELECT * FROM field_teams WHERE id = ?', [id])!;
  logEvent({ module: 'field', entityType: 'field_teams', entityId: id, action: 'update', before, after }, actor);
  return after;
}

export function addMember(
  teamId: string,
  input: { fullName: string; phone?: string; role?: string },
  actor: AuditActor = {},
): Row {
  if (!one('SELECT id FROM field_teams WHERE id = ?', [teamId])) throw new Error('Không tìm thấy đội.');
  if (!input.fullName?.trim()) throw new Error('Họ tên thành viên không được để trống.');
  const role = input.role ?? 'cong_nhan';
  if (!MEMBER_ROLES[role]) throw new Error('Vai trò thành viên không hợp lệ.');
  const record = {
    id: uuid(), team_id: teamId, full_name: input.fullName.trim(), phone: input.phone ?? null,
    role, status: 'hoat_dong', created_at: nowIso(),
  };
  insert('field_team_members', record);
  logEvent({ module: 'field', entityType: 'field_team_members', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function setMemberStatus(memberId: string, status: 'hoat_dong' | 'tam_nghi' | 'nghi_viec', actor: AuditActor = {}): void {
  if (!one('SELECT id FROM field_team_members WHERE id = ?', [memberId])) throw new Error('Không tìm thấy thành viên.');
  update('field_team_members', memberId, { status });
  logEvent({ module: 'field', entityType: 'field_team_members', entityId: memberId, action: 'update', after: { status } }, actor);
}

export function createVehicle(
  input: {
    name: string; kind: string; plateNumber?: string; teamId?: string; machineId?: string;
    capacityValue?: number; note?: string;
  },
  actor: AuditActor = {},
): Row {
  const kind = VEHICLE_KINDS.find((item) => item.code === input.kind);
  if (!kind) throw new Error('Loại phương tiện không hợp lệ.');
  if (!input.name?.trim()) throw new Error('Tên phương tiện không được để trống.');
  if (input.teamId && !one('SELECT id FROM field_teams WHERE id = ?', [input.teamId])) throw new Error('Không tìm thấy đội.');
  if (input.machineId && !one('SELECT id FROM machines WHERE id = ?', [input.machineId])) {
    throw new Error('Máy liên kết không tồn tại trong danh mục cơ giới hoá.');
  }
  if (kind.plansCapacity && !(Number(input.capacityValue) > 0)) {
    throw new Error(`${kind.label} phải khai báo năng lực (${kind.capacityUnit}) — con số này quyết định kế hoạch xếp việc.`);
  }
  const timestamp = nowIso();
  const record = {
    id: uuid(), code: nextCode('PT', 'field_vehicles'), name: input.name.trim(), kind: kind.code,
    plate_number: input.plateNumber ?? null, team_id: input.teamId ?? null, machine_id: input.machineId ?? null,
    capacity_value: input.capacityValue ?? null, capacity_unit: kind.capacityUnit,
    status: 'san_sang', note: input.note ?? null, created_at: timestamp, updated_at: timestamp,
  };
  insert('field_vehicles', record);
  logEvent({ module: 'field', entityType: 'field_vehicles', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function updateVehicle(id: string, patch: Record<string, unknown>, actor: AuditActor = {}): Row {
  const before = one('SELECT * FROM field_vehicles WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy phương tiện.');
  const allowed: Record<string, string> = {
    name: 'name', plateNumber: 'plate_number', teamId: 'team_id', machineId: 'machine_id',
    capacityValue: 'capacity_value', status: 'status', note: 'note',
  };
  const values: Record<string, unknown> = { updated_at: nowIso() };
  for (const [key, column] of Object.entries(allowed)) {
    if (patch[key] !== undefined) values[column] = patch[key] === '' ? null : patch[key];
  }
  if (values.status && !['san_sang', 'dang_dung', 'bao_duong', 'hong'].includes(String(values.status))) {
    throw new Error('Trạng thái phương tiện không hợp lệ.');
  }
  update('field_vehicles', id, values);
  const after = one('SELECT * FROM field_vehicles WHERE id = ?', [id])!;
  logEvent({ module: 'field', entityType: 'field_vehicles', entityId: id, action: 'update', before, after }, actor);
  return after;
}

/**
 * Năng lực cuộn/ngày của đội = tổng năng lực máy cuộn dùng được. Máy đang chạy
 * ngoài ruộng vẫn là năng lực của đội; chỉ máy hỏng / bảo dưỡng mới bị trừ.
 */
export function teamCapacityTonsPerDay(teamId: string): { tons: number; declared: boolean } {
  const row = one<{ tons: number | null; n: number }>(
    `SELECT SUM(capacity_value) AS tons, COUNT(*) AS n FROM field_vehicles
     WHERE team_id = ? AND kind = 'may_cuon' AND status NOT IN ('bao_duong', 'hong')`,
    [teamId],
  );
  if (!row?.n || !row.tons) return { tons: DEFAULT_TEAM_CAPACITY_TONS_PER_DAY, declared: false };
  return { tons: row.tons, declared: true };
}

export function listTeams(): Row[] {
  const teams = all<Row>('SELECT * FROM field_teams ORDER BY status = \'hoat_dong\' DESC, name');
  const members = all<Row & { team_id: string }>('SELECT * FROM field_team_members ORDER BY role, full_name');
  const vehicles = all<Row & { team_id: string | null }>('SELECT * FROM field_vehicles ORDER BY kind, code');
  const active = all<{ team_id: string; n: number; tons: number }>(
    `SELECT team_id, COUNT(*) AS n, SUM(expected_straw_tons) AS tons FROM field_jobs
     WHERE team_id IS NOT NULL AND status IN ('da_phan_cong', 'dang_thuc_hien') GROUP BY team_id`,
  );
  return teams.map((team) => {
    const capacity = teamCapacityTonsPerDay(String(team.id));
    const workload = active.find((item) => item.team_id === team.id);
    return {
      ...team,
      members: members.filter((member) => member.team_id === team.id),
      vehicles: vehicles.filter((vehicle) => vehicle.team_id === team.id),
      capacityTonsPerDay: capacity.tons,
      capacityDeclared: capacity.declared,
      openJobs: workload?.n ?? 0,
      openTons: workload?.tons ?? 0,
    };
  });
}

export function listVehicles(filter: { teamId?: string; kind?: string; unassigned?: boolean } = {}): Row[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.teamId) { where.push('v.team_id = ?'); params.push(filter.teamId); }
  if (filter.kind) { where.push('v.kind = ?'); params.push(filter.kind); }
  if (filter.unassigned) where.push('v.team_id IS NULL');
  return all(
    `SELECT v.*, t.name AS team_name, m.code AS machine_code
     FROM field_vehicles v
     LEFT JOIN field_teams t ON t.id = v.team_id
     LEFT JOIN machines m ON m.id = v.machine_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY v.kind, v.code`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Việc thu gom (job) — một thửa / một HTX, một ngày gặt
// ---------------------------------------------------------------------------

function nearestFacility(point: LatLng): { id: string; name: string } | null {
  const rows = all<{ id: string; name: string; kind: string; lat: number; lng: number }>(
    `SELECT id, name, kind, lat, lng FROM facilities WHERE status = 'active' AND kind IN ('hub', 'plant')`,
  );
  if (!rows.length) return null;
  // Ưu tiên Hub; chỉ về thẳng nhà máy khi chưa có Hub nào.
  const hubs = rows.filter((row) => row.kind === 'hub');
  const pool = hubs.length ? hubs : rows;
  pool.sort((a, b) => haversineKm(point, a) - haversineKm(point, b));
  return { id: pool[0].id, name: pool[0].name };
}

function estimateStrawTons(areaHa: number): number {
  const ratio = resolveParams().strawToPaddyRatio;
  return Math.round(areaHa * PADDY_YIELD_TONS_PER_HA * ratio * 10) / 10;
}

export function createJob(
  input: {
    sourceType: 'crop_cycle' | 'crop_status' | 'harvest' | 'manual'; sourceId?: string;
    cropCycleId?: string; plotId?: string; htxId?: string;
    harvestDate: string; expectedStrawTons?: number; areaHa?: number;
    lat?: number; lng?: number; locationLabel?: string;
    loadingLat?: number; loadingLng?: number; destinationFacilityId?: string;
    harvestConfirmed?: boolean; priority?: number; note?: string;
  },
  actor: AuditActor = {},
): Row {
  if (!input.harvestDate) throw new Error('Thiếu ngày thu hoạch.');

  // Định vị việc: thửa → tâm thửa; HTX → toạ độ HTX; thủ công → nhập tay.
  let lat = input.lat ?? null;
  let lng = input.lng ?? null;
  let label = input.locationLabel ?? null;
  let htxId = input.htxId ?? null;
  let areaHa = input.areaHa ?? null;
  if (input.plotId) {
    const plot = one<{ code: string; name: string | null; htx_id: string; centroid_lat: number; centroid_lng: number; area_ha: number }>(
      'SELECT code, name, htx_id, centroid_lat, centroid_lng, area_ha FROM plots WHERE id = ?', [input.plotId]);
    if (!plot) throw new Error('Không tìm thấy thửa ruộng.');
    lat = lat ?? plot.centroid_lat; lng = lng ?? plot.centroid_lng;
    htxId = htxId ?? plot.htx_id; areaHa = areaHa ?? plot.area_ha;
    label = label ?? `Thửa ${plot.code}${plot.name ? ` — ${plot.name}` : ''}`;
  }
  if (htxId) {
    const htx = one<{ name: string; lat: number; lng: number }>('SELECT name, lat, lng FROM cooperatives WHERE id = ?', [htxId]);
    if (!htx) throw new Error('Không tìm thấy hợp tác xã.');
    lat = lat ?? htx.lat; lng = lng ?? htx.lng;
    label = label ?? htx.name;
  }
  if (lat === null || lng === null) throw new Error('Việc thu gom phải có vị trí (thửa, HTX hoặc toạ độ).');

  const expected = input.expectedStrawTons ?? (areaHa ? estimateStrawTons(areaHa) : 0);
  const destination = input.destinationFacilityId ?? nearestFacility({ lat, lng })?.id ?? null;
  // HTX có hợp đồng thu mua hiệu lực → việc được ưu tiên xếp trước (D1), phiếu mua biết giá.
  const contract = contractFor(htxId, input.harvestDate);
  const timestamp = nowIso();
  const record = {
    id: uuid(), code: nextCode('TG', 'field_jobs'),
    contract_id: contract?.id ?? null,
    source_type: input.sourceType, source_id: input.sourceId ?? null,
    crop_cycle_id: input.cropCycleId ?? null, plot_id: input.plotId ?? null, htx_id: htxId,
    location_label: label, lat, lng,
    loading_lat: input.loadingLat ?? lat, loading_lng: input.loadingLng ?? lng,
    destination_facility_id: destination,
    harvest_date: input.harvestDate, harvest_confirmed: input.harvestConfirmed ? 1 : 0,
    expected_straw_tons: expected, area_ha: areaHa,
    team_id: null, planned_date: null, assignment_mode: null, assigned_by: null, assigned_at: null,
    priority: input.priority ?? (contract ? 10 : 0), status: 'cho_phan_cong', note: input.note ?? null,
    created_at: timestamp, updated_at: timestamp,
  };
  transaction(() => {
    insert('field_jobs', record);
    for (const stage of STAGES) {
      insert('field_job_stages', {
        id: uuid(), job_id: record.id, stage: stage.code, sort_order: stage.order,
        planned_start: null, planned_end: null, started_at: null, completed_at: null,
        quantity_tons: null, bales: null, vehicle_id: null, recorded_by: null,
        lat: null, lng: null, note: null, evidence_json: null, status: 'cho_thuc_hien',
      });
    }
  });
  logEvent({ module: 'field', entityType: 'field_jobs', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

/**
 * Móc nối từ App HTX: khai báo sản lượng xong là rơm đã có thật trên ruộng.
 *
 * Gọi từ `htx.declareHarvest`. Việc đã có (lập từ ngày gặt dự kiến) thì cập
 * nhật số liệu thật và gắn cờ; chưa có thì tạo mới ở trạng thái chờ phân công.
 * Không ném lỗi ra ngoài — khai báo sản lượng của nông dân không được thất bại
 * vì phân hệ hiện trường.
 */
export function syncJobFromHarvest(
  input: { cropCycleId: string; plotId: string; harvestDate: string; strawTons: number },
  actor: AuditActor = {},
): Row | null {
  if (!(input.strawTons > 0)) return null;
  try {
    const existing = one<Row & { id: string; status: string }>(
      'SELECT * FROM field_jobs WHERE crop_cycle_id = ? AND status <> \'huy\'', [input.cropCycleId]);
    if (existing) {
      if (existing.status === 'hoan_thanh') return existing;
      update('field_jobs', existing.id, {
        harvest_date: input.harvestDate, harvest_confirmed: 1,
        expected_straw_tons: input.strawTons, updated_at: nowIso(),
      });
      logEvent({
        module: 'field', entityType: 'field_jobs', entityId: existing.id, action: 'update',
        after: { harvest_confirmed: 1, expected_straw_tons: input.strawTons }, note: 'Đồng bộ từ khai báo sản lượng',
      }, actor);
      return one('SELECT * FROM field_jobs WHERE id = ?', [existing.id]);
    }
    return createJob({
      sourceType: 'harvest', sourceId: input.cropCycleId, cropCycleId: input.cropCycleId, plotId: input.plotId,
      harvestDate: input.harvestDate, expectedStrawTons: input.strawTons, harvestConfirmed: true,
    }, actor);
  } catch {
    return null;
  }
}

/**
 * Lịch gặt → việc thu gom. Quét mọi nguồn có ngày gặt trong cửa sổ và tạo việc
 * cho nguồn chưa có (FM-08: chạy lại không trùng).
 */
export function syncHarvestCalendar(fromDate = today(), days = 14, actor: AuditActor = {}): { created: number; skipped: number } {
  const toDate = addDays(fromDate, days);
  let created = 0;
  let skipped = 0;

  // 1. Vụ canh tác cấp thửa (App HTX) — nguồn chính xác nhất.
  const cycles = all<{ id: string; plot_id: string; expected_harvest_date: string; area_ha: number }>(
    `SELECT c.id, c.plot_id, c.expected_harvest_date, c.area_ha FROM crop_cycles c
     WHERE c.status = 'dang_canh_tac' AND c.expected_harvest_date BETWEEN ? AND ?
       AND NOT EXISTS (SELECT 1 FROM field_jobs j WHERE j.crop_cycle_id = c.id AND j.status <> 'huy')`,
    [fromDate, toDate],
  );
  for (const cycle of cycles) {
    createJob({
      sourceType: 'crop_cycle', sourceId: cycle.id, cropCycleId: cycle.id, plotId: cycle.plot_id,
      harvestDate: cycle.expected_harvest_date, areaHa: cycle.area_ha,
    }, actor);
    created += 1;
  }

  // 2. Trạng thái mùa vụ cấp HTX (heatmap GIS) — thô hơn nhưng phủ toàn vùng.
  const statuses = all<{ id: string; htx_id: string; expected_harvest_date: string; straw_tons: number }>(
    `SELECT s.id, s.htx_id, s.expected_harvest_date, s.straw_tons FROM crop_status s
     WHERE s.stage IN ('chin', 'thu_hoach') AND s.straw_tons > 0
       AND s.expected_harvest_date BETWEEN ? AND ?
       AND NOT EXISTS (SELECT 1 FROM field_jobs j WHERE j.source_type = 'crop_status' AND j.source_id = s.id AND j.status <> 'huy')
       AND NOT EXISTS (SELECT 1 FROM field_jobs j WHERE j.htx_id = s.htx_id AND j.harvest_date = s.expected_harvest_date AND j.status <> 'huy')`,
    [fromDate, toDate],
  );
  for (const status of statuses) {
    createJob({
      sourceType: 'crop_status', sourceId: status.id, htxId: status.htx_id,
      harvestDate: status.expected_harvest_date,
      expectedStrawTons: Math.round(status.straw_tons / HARVEST_WINDOW_DAYS),
      note: `Ước tính rơm MỘT ngày gặt (tổng vụ ${Math.round(status.straw_tons)} tấn ÷ ${HARVEST_WINDOW_DAYS} ngày). Thay bằng lịch cấp thửa khi HTX mở vụ trên App HTX.`,
    }, actor);
    created += 1;
  }
  skipped = all('SELECT id FROM field_jobs WHERE harvest_date BETWEEN ? AND ?', [fromDate, toDate]).length - created;
  return { created, skipped: Math.max(0, skipped) };
}

// ---------------------------------------------------------------------------
// Phân công
// ---------------------------------------------------------------------------

/** Tải đã xếp cho đội trong một ngày (tấn) — chia đều khối lượng việc theo số ngày cuộn. */
function teamLoadOn(teamId: string, date: string): number {
  const rows = all<{ tons: number; planned_start: string; planned_end: string }>(
    `SELECT j.expected_straw_tons AS tons, s.planned_start, s.planned_end
     FROM field_jobs j JOIN field_job_stages s ON s.job_id = j.id AND s.stage = 'cuon_rom'
     WHERE j.team_id = ? AND j.status IN ('da_phan_cong', 'dang_thuc_hien')
       AND s.planned_start <= ? AND s.planned_end >= ?`,
    [teamId, date, date],
  );
  return rows.reduce((sum, row) => sum + row.tons / (daysBetween(row.planned_start, row.planned_end) + 1), 0);
}

function planStages(jobId: string, plannedDate: string, tons: number, capacity: number): void {
  const balingDays = Math.max(1, Math.ceil(tons / Math.max(capacity, 1)));
  const balingEnd = addDays(plannedDate, balingDays - 1);
  const plan: Record<FieldStage, [string, string]> = {
    cuon_rom: [plannedDate, balingEnd],
    gom_rom: [plannedDate, addDays(balingEnd, 1)],
    xuong_ghe: [addDays(plannedDate, 1), addDays(balingEnd, 1)],
  };
  for (const stage of STAGES) {
    const row = one<{ id: string }>('SELECT id FROM field_job_stages WHERE job_id = ? AND stage = ?', [jobId, stage.code])!;
    update('field_job_stages', row.id, { planned_start: plan[stage.code][0], planned_end: plan[stage.code][1] });
  }
}

export function assignJob(
  jobId: string,
  input: { teamId: string; plannedDate?: string; mode?: 'auto' | 'manual'; note?: string },
  actor: AuditActor = {},
): { job: Row; warnings: string[] } {
  const job = one<Row & { id: string; status: string; harvest_date: string; expected_straw_tons: number; code: string }>(
    'SELECT * FROM field_jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  if (['hoan_thanh', 'huy'].includes(job.status)) throw new Error(`Việc ${job.code} đã ${JOB_STATUS[job.status].toLowerCase()}, không phân công lại.`);
  if (job.status === 'dang_thuc_hien') throw new Error(`Việc ${job.code} đang thực hiện — đổi đội giữa chừng sẽ làm lệch số liệu năng suất. Hãy huỷ và tạo việc mới nếu thật sự cần.`);

  const team = one<{ id: string; name: string; status: string }>('SELECT id, name, status FROM field_teams WHERE id = ?', [input.teamId]);
  if (!team) throw new Error('Không tìm thấy đội.');
  if (team.status !== 'hoat_dong') throw new Error(`FM-07: Đội ${team.name} đang ${team.status === 'tam_nghi' ? 'tạm nghỉ' : 'giải thể'}, không nhận việc.`);

  const plannedDate = input.plannedDate ?? (job.harvest_date < today() ? today() : job.harvest_date);
  if (plannedDate < job.harvest_date) {
    throw new Error(`FM-01: Không xếp cuộn rơm ngày ${plannedDate} khi ruộng gặt ngày ${job.harvest_date} — rơm chưa có.`);
  }

  const warnings: string[] = [];
  const lateDays = daysBetween(job.harvest_date, plannedDate);
  if (lateDays > MAX_DAYS_AFTER_HARVEST) {
    warnings.push(`FM-02: Bắt đầu cuộn ${lateDays} ngày sau gặt (ngưỡng ${MAX_DAYS_AFTER_HARVEST}) — rơm có nguy cơ ẩm mục.`);
  }
  const capacity = teamCapacityTonsPerDay(team.id);
  if (!capacity.declared) warnings.push(`Đội ${team.name} chưa khai báo máy cuộn — dùng năng lực mặc định ${capacity.tons} tấn/ngày.`);
  const balingDays = Math.max(1, Math.ceil(job.expected_straw_tons / capacity.tons));
  const finishLate = daysBetween(job.harvest_date, addDays(plannedDate, balingDays - 1));
  if (lateDays <= MAX_DAYS_AFTER_HARVEST && finishLate > MAX_DAYS_AFTER_HARVEST) {
    warnings.push(`FM-02: Với ${capacity.tons} tấn/ngày, đội ${team.name} cần ${balingDays} ngày mới cuộn hết ${job.expected_straw_tons} tấn — kết thúc ${finishLate} ngày sau gặt, quá ngưỡng ${MAX_DAYS_AFTER_HARVEST}. Cần thêm máy hoặc chia việc cho đội khác.`);
  }
  const perDay = job.expected_straw_tons / balingDays;
  for (let offset = 0; offset < balingDays; offset += 1) {
    const day = addDays(plannedDate, offset);
    const load = teamLoadOn(team.id, day);
    if (load + perDay > capacity.tons + 1e-6) {
      warnings.push(`FM-06: Ngày ${day} đội ${team.name} đã xếp ${Math.round(load)} tấn, thêm ${Math.round(perDay)} tấn sẽ vượt năng lực ${capacity.tons} tấn/ngày.`);
      break;
    }
  }

  const timestamp = nowIso();
  transaction(() => {
    update('field_jobs', jobId, {
      team_id: team.id, planned_date: plannedDate, assignment_mode: input.mode ?? 'manual',
      assigned_by: actor.name ?? null, assigned_at: timestamp, status: 'da_phan_cong',
      note: input.note ?? job.note ?? null, updated_at: timestamp,
    });
    planStages(jobId, plannedDate, job.expected_straw_tons, capacity.tons);
  });
  logEvent({
    module: 'field', entityType: 'field_jobs', entityId: jobId, action: 'update',
    before: { team_id: job.team_id, status: job.status },
    after: { team_id: team.id, planned_date: plannedDate, mode: input.mode ?? 'manual', warnings },
  }, actor);
  return { job: jobDetail(jobId), warnings };
}

export function unassignJob(jobId: string, actor: AuditActor = {}): Row {
  const job = one<{ status: string; team_id: string | null }>('SELECT status, team_id FROM field_jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  if (job.status !== 'da_phan_cong') throw new Error('Chỉ rút phân công khi việc chưa bắt đầu.');
  transaction(() => {
    update('field_jobs', jobId, { team_id: null, planned_date: null, assignment_mode: null, status: 'cho_phan_cong', updated_at: nowIso() });
    for (const stage of STAGES) {
      const row = one<{ id: string }>('SELECT id FROM field_job_stages WHERE job_id = ? AND stage = ?', [jobId, stage.code])!;
      update('field_job_stages', row.id, { planned_start: null, planned_end: null });
    }
  });
  logEvent({ module: 'field', entityType: 'field_jobs', entityId: jobId, action: 'update', before: job, after: { status: 'cho_phan_cong' } }, actor);
  return jobDetail(jobId);
}

export function cancelJob(jobId: string, reason: string, actor: AuditActor = {}): Row {
  const job = one<{ status: string }>('SELECT status FROM field_jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  if (job.status === 'hoan_thanh') throw new Error('Việc đã hoàn thành không huỷ được — số liệu đã đi vào TMS và báo cáo.');
  if (!reason?.trim()) throw new Error('Phải ghi lý do huỷ.');
  update('field_jobs', jobId, { status: 'huy', note: reason.trim(), updated_at: nowIso() });
  logEvent({ module: 'field', entityType: 'field_jobs', entityId: jobId, action: 'update', before: job, after: { status: 'huy', reason } }, actor);
  return jobDetail(jobId);
}

/**
 * Phân công tự động, hai lượt:
 *
 *   Lượt 1  đội gần nhất còn năng lực trong MAX_DAYS_AFTER_HARVEST ngày sau gặt.
 *   Lượt 2  việc không vừa đội nào vẫn được xếp cho đội gần nhất ít tải nhất,
 *           nhưng tách riêng thành nhóm ÉP XẾP kèm cảnh báo FM-02/FM-06.
 *
 * Để trống là cách tệ nhất: rơm vẫn nằm ruộng và không ai chịu trách nhiệm.
 * Ép xếp có cờ đỏ cho quản lý thấy đúng chỗ thiếu đội để điều máy dự phòng,
 * thuê thêm hay chấp nhận bỏ rơm — quyết định là của người, nhưng phải có dữ liệu.
 * Chỉ khi không còn đội nào hoạt động thì việc mới nằm ở danh sách chưa xếp.
 */
export function autoAssign(
  options: { fromDate?: string; days?: number; syncCalendar?: boolean; force?: boolean } = {},
  actor: AuditActor = {},
): { created: number; assigned: Row[]; forced: Row[]; unassigned: Row[]; warnings: string[] } {
  const fromDate = options.fromDate ?? today();
  const days = options.days ?? 14;
  const created = options.syncCalendar === false ? 0 : syncHarvestCalendar(fromDate, days, actor).created;

  const teams = all<{ id: string; name: string; base_lat: number | null; base_lng: number | null }>(
    `SELECT id, name, base_lat, base_lng FROM field_teams WHERE status = 'hoat_dong'`);
  const jobs = all<{ id: string; code: string; lat: number; lng: number; harvest_date: string; expected_straw_tons: number; location_label: string }>(
    `SELECT id, code, lat, lng, harvest_date, expected_straw_tons, location_label FROM field_jobs
     WHERE status = 'cho_phan_cong' AND harvest_date <= ?
     ORDER BY priority DESC, harvest_date, expected_straw_tons DESC`,
    [addDays(fromDate, days)],
  );

  const assigned: Row[] = [];
  const forced: Row[] = [];
  const unassigned: Row[] = [];
  const warnings: string[] = [];
  if (!teams.length) {
    return {
      created, assigned, forced,
      unassigned: jobs.map((job) => ({ ...job, reason: 'Chưa có đội nào đang hoạt động.' })),
      warnings: ['Chưa có đội thu gom nào đang hoạt động.'],
    };
  }

  for (const job of jobs) {
    const startDay = job.harvest_date < fromDate ? fromDate : job.harvest_date;
    const ranked = teams
      .map((team) => ({
        team,
        distanceKm: team.base_lat !== null && team.base_lng !== null
          ? haversineKm({ lat: job.lat, lng: job.lng }, { lat: team.base_lat, lng: team.base_lng })
          : Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    let placed = false;
    const deadline = addDays(job.harvest_date, MAX_DAYS_AFTER_HARVEST);
    for (let day = startDay; day <= deadline && !placed; day = addDays(day, 1)) {
      for (const { team } of ranked) {
        const capacity = teamCapacityTonsPerDay(team.id);
        const balingDays = Math.max(1, Math.ceil(job.expected_straw_tons / capacity.tons));
        // Vừa tải từng ngày chưa đủ: phải cuộn XONG trước hạn FM-02. Việc 500 tấn
        // chia đều 6 ngày vẫn "vừa" 85 tấn/ngày nhưng rơm ngày cuối đã mục.
        if (addDays(day, balingDays - 1) > deadline) continue;
        const perDay = job.expected_straw_tons / balingDays;
        let fits = true;
        for (let offset = 0; offset < balingDays; offset += 1) {
          if (teamLoadOn(team.id, addDays(day, offset)) + perDay > capacity.tons + 1e-6) { fits = false; break; }
        }
        if (!fits) continue;
        const result = assignJob(job.id, { teamId: team.id, plannedDate: day, mode: 'auto' }, actor);
        assigned.push({ jobId: job.id, code: job.code, team: team.name, plannedDate: day, tons: job.expected_straw_tons, location: job.location_label });
        warnings.push(...result.warnings.filter((w) => !w.startsWith('Đội')));
        placed = true;
        break;
      }
    }
    if (placed) continue;

    const reason = `Không đội nào còn năng lực trong ${MAX_DAYS_AFTER_HARVEST} ngày sau gặt (${job.harvest_date} → ${deadline}).`;
    if (options.force === false) {
      unassigned.push({ jobId: job.id, code: job.code, tons: job.expected_straw_tons, harvestDate: job.harvest_date, location: job.location_label, reason });
      continue;
    }
    // Lượt 2: trong hai đội gần nhất, chọn đội ít tải hơn vào ngày gặt.
    const candidates = ranked.slice(0, 2).map(({ team, distanceKm }) => ({ team, distanceKm, load: teamLoadOn(team.id, startDay) }))
      .sort((a, b) => a.load - b.load || a.distanceKm - b.distanceKm);
    const pick = candidates[0].team;
    const result = assignJob(job.id, { teamId: pick.id, plannedDate: startDay, mode: 'auto' }, actor);
    forced.push({
      jobId: job.id, code: job.code, team: pick.name, plannedDate: startDay, tons: job.expected_straw_tons, location: job.location_label,
      reason, warnings: result.warnings,
    });
  }
  return { created, assigned, forced, unassigned, warnings };
}

// ---------------------------------------------------------------------------
// Ghi nhận hiện trường
// ---------------------------------------------------------------------------

function loadStage(jobId: string, stage: FieldStage) {
  const row = one<Row & { id: string; status: string; started_at: string | null; completed_at: string | null; quantity_tons: number | null }>(
    'SELECT * FROM field_job_stages WHERE job_id = ? AND stage = ?', [jobId, stage]);
  if (!row) throw new Error('Không tìm thấy công đoạn.');
  return row;
}

function previousStage(stage: FieldStage): FieldStage | null {
  const meta = stageMeta(stage);
  return STAGES.find((item) => item.order === meta.order - 1)?.code ?? null;
}

export function startStage(
  jobId: string,
  stage: FieldStage,
  input: { vehicleId?: string; lat?: number; lng?: number; note?: string; at?: string } = {},
  actor: AuditActor = {},
): Row {
  const job = one<{ id: string; code: string; status: string; harvest_date: string; team_id: string | null }>(
    'SELECT id, code, status, harvest_date, team_id FROM field_jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  if (!job.team_id) throw new Error(`Việc ${job.code} chưa được phân công cho đội nào.`);
  if (['hoan_thanh', 'huy'].includes(job.status)) throw new Error(`Việc ${job.code} đã kết thúc.`);

  const at = input.at ?? nowIso();
  if (stage === 'cuon_rom' && at.slice(0, 10) < job.harvest_date) {
    throw new Error(`FM-01: Ruộng gặt ngày ${job.harvest_date}, không thể bắt đầu cuộn rơm ngày ${at.slice(0, 10)}.`);
  }
  const current = loadStage(jobId, stage);
  if (current.started_at) throw new Error(`Công đoạn "${stageMeta(stage).label}" đã bắt đầu lúc ${current.started_at}.`);
  const prev = previousStage(stage);
  if (prev) {
    const before = loadStage(jobId, prev);
    if (!before.started_at) throw new Error(`FM-03: Chưa bắt đầu "${stageMeta(prev).label}" thì chưa thể "${stageMeta(stage).label}".`);
  }
  if (input.vehicleId) checkVehicleUsable(input.vehicleId, job.team_id);

  transaction(() => {
    update('field_job_stages', current.id, {
      started_at: at, status: 'dang_thuc_hien', vehicle_id: input.vehicleId ?? null,
      recorded_by: actor.name ?? null, lat: input.lat ?? null, lng: input.lng ?? null, note: input.note ?? null,
    });
    if (job.status !== 'dang_thuc_hien') update('field_jobs', jobId, { status: 'dang_thuc_hien', updated_at: nowIso() });
    if (input.vehicleId) update('field_vehicles', input.vehicleId, { status: 'dang_dung', updated_at: nowIso() });
  });
  logEvent({ module: 'field', entityType: 'field_job_stages', entityId: current.id, action: 'update', after: { stage, started_at: at, vehicle_id: input.vehicleId } }, actor);
  return jobDetail(jobId);
}

function checkVehicleUsable(vehicleId: string, teamId: string): void {
  const vehicle = one<{ code: string; status: string; team_id: string | null }>(
    'SELECT code, status, team_id FROM field_vehicles WHERE id = ?', [vehicleId]);
  if (!vehicle) throw new Error('Không tìm thấy phương tiện.');
  if (['bao_duong', 'hong'].includes(vehicle.status)) {
    throw new Error(`Phương tiện ${vehicle.code} đang ${vehicle.status === 'hong' ? 'hỏng' : 'bảo dưỡng'}, không đưa vào việc.`);
  }
  if (vehicle.team_id && vehicle.team_id !== teamId) {
    throw new Error(`Phương tiện ${vehicle.code} thuộc đội khác — điều chuyển phương tiện trước rồi mới ghi nhận.`);
  }
}

export function completeStage(
  jobId: string,
  stage: FieldStage,
  input: {
    quantityTons?: number; bales?: number; vehicleId?: string; lat?: number; lng?: number;
    note?: string; evidence?: { kind: string; url?: string; note?: string }[]; at?: string;
  },
  actor: AuditActor = {},
): Row {
  const job = one<{ code: string; status: string; team_id: string | null; expected_straw_tons: number; htx_id: string | null }>(
    'SELECT code, status, team_id, expected_straw_tons, htx_id FROM field_jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  if (['hoan_thanh', 'huy'].includes(job.status)) throw new Error(`Việc ${job.code} đã kết thúc.`);
  const current = loadStage(jobId, stage);
  if (current.completed_at) throw new Error(`Công đoạn "${stageMeta(stage).label}" đã hoàn thành rồi.`);

  const at = input.at ?? nowIso();
  // Cho phép bắt đầu và hoàn thành trong một lần ghi (đội quên bấm "bắt đầu").
  if (!current.started_at) startStage(jobId, stage, { vehicleId: input.vehicleId, lat: input.lat, lng: input.lng, at }, actor);

  const prev = previousStage(stage);
  if (prev) {
    const before = loadStage(jobId, prev);
    if (!before.completed_at) throw new Error(`FM-03: "${stageMeta(prev).label}" chưa hoàn thành thì chưa chốt "${stageMeta(stage).label}".`);
  }

  // FM-09: ở ruộng ĐẾM CUỘN. Tấn là ước tính từ số cuộn; chỉ khi không có số cuộn
  // (dữ liệu cũ, HTX bán rơm rời) mới nhận tấn nhập tay.
  const kg = baleKg(job.htx_id);
  let bales: number | null = input.bales === undefined || input.bales === null ? null : Math.round(Number(input.bales));
  let quantity: number;
  if (stage === 'xuong_ghe') {
    // Xuống ghe: cộng các lượt đã ghi, không nhập tay lại.
    const loaded = one<{ tons: number | null; bales: number | null; n: number }>(
      'SELECT SUM(tons) AS tons, SUM(bales) AS bales, COUNT(*) AS n FROM field_loadings WHERE job_id = ?', [jobId]);
    if (!loaded?.n) throw new Error('Chưa ghi lượt xuống ghe nào — dùng "Ghi lượt xuống ghe" cho từng ghe / sà lan trước.');
    quantity = loaded.tons ?? 0;
    bales = loaded.bales ?? null;
  } else if (bales !== null) {
    if (!(bales >= 0)) throw new Error('Số cuộn phải là số không âm.');
    quantity = input.quantityTons !== undefined && input.quantityTons !== null ? Number(input.quantityTons) : tonsFromBales(bales, kg.kg);
  } else if (input.quantityTons !== undefined && input.quantityTons !== null) {
    quantity = Number(input.quantityTons);
  } else {
    throw new Error(`Phải ghi SỐ CUỘN đã ${stageMeta(stage).label.toLowerCase()} — rơm ĐBSCL bán theo cuộn, cân chỉ có ở nhà máy.`);
  }
  if (!(quantity >= 0)) throw new Error('Khối lượng phải là số không âm.');

  if (prev) {
    const before = loadStage(jobId, prev) as typeof current & { bales: number | null };
    // So bằng CUỘN khi cả hai bên đều đếm cuộn — đó là số thật; tấn chỉ là ước.
    if (bales !== null && before.bales !== null && bales > before.bales) {
      throw new Error(
        `FM-04: ${stageMeta(stage).label} ${bales} cuộn nhiều hơn ${stageMeta(prev).label.toLowerCase()} ${before.bales} cuộn — rơm không tự sinh ra giữa hai công đoạn. Đếm lại.`,
      );
    }
    if ((bales === null || before.bales === null) && before.quantity_tons !== null && quantity > before.quantity_tons + 1e-6) {
      throw new Error(
        `FM-04: ${stageMeta(stage).label} ${quantity} tấn nhiều hơn ${stageMeta(prev).label.toLowerCase()} ${before.quantity_tons} tấn — rơm không tự sinh ra giữa hai công đoạn. Kiểm tra lại số liệu.`,
      );
    }
  }

  const evidence = (input.evidence ?? []).filter((item) => item && item.kind);
  transaction(() => {
    update('field_job_stages', current.id, {
      completed_at: at, status: 'hoan_thanh', quantity_tons: quantity, bales,
      vehicle_id: input.vehicleId ?? current.vehicle_id ?? null, recorded_by: actor.name ?? null,
      lat: input.lat ?? current.lat ?? null, lng: input.lng ?? current.lng ?? null,
      note: input.note ?? current.note ?? null,
      evidence_json: evidence.length ? JSON.stringify(evidence) : current.evidence_json ?? null,
    });
    const usedVehicle = input.vehicleId ?? (current.vehicle_id as string | null);
    if (usedVehicle) update('field_vehicles', usedVehicle, { status: 'san_sang', updated_at: nowIso() });
    if (stage === 'xuong_ghe') update('field_jobs', jobId, { status: 'hoan_thanh', updated_at: nowIso() });
  });
  logEvent({
    module: 'field', entityType: 'field_job_stages', entityId: current.id, action: 'update',
    after: { stage, completed_at: at, quantity_tons: quantity, bales, baleKg: bales !== null ? kg : undefined, evidence: evidence.length },
  }, actor);
  // Rơm đã xuống ghe hết → phiếu mua rơm cho HTX sinh ngay (PM-01). Lỗi phiếu không
  // được làm hỏng việc chốt công đoạn — ghi nhận hiện trường đi trước, tiền đi sau.
  if (stage === 'xuong_ghe') { try { generateTicketForJob(jobId, actor); } catch { /* không có lượt ghe / không hợp lệ */ } }
  return jobDetail(jobId);
}

/**
 * FM-05: một lượt xuống ghe = một chuyến TMS đường thuỷ từ điểm tập kết về Hub /
 * nhà máy. Phân hệ vận tải nhìn thấy chuyến ngay khi đội trưởng bấm ghi, không
 * chờ cuối ngày tổng hợp.
 */
export function recordLoading(
  jobId: string,
  input: {
    vesselCode: string; vesselKind?: 'ghe' | 'sa_lan'; bales?: number; tons?: number;
    destinationFacilityId?: string; lat?: number; lng?: number; note?: string; at?: string; driverName?: string;
  },
  actor: AuditActor = {},
): { loading: Row; trip: Row | null; warnings: string[]; baleKg: ReturnType<typeof baleKg> } {
  const job = one<{
    code: string; status: string; team_id: string | null; loading_lat: number; loading_lng: number;
    location_label: string; destination_facility_id: string | null; htx_id: string | null;
  }>('SELECT * FROM field_jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  if (['hoan_thanh', 'huy'].includes(job.status)) throw new Error(`Việc ${job.code} đã kết thúc.`);
  if (!input.vesselCode?.trim()) throw new Error('Phải ghi số hiệu ghe / sà lan — đây là mã để TMS và kho đối chiếu.');

  // FM-09: đếm cuộn; tấn là ước tính cho tới khi nhà máy cân.
  const kg = baleKg(job.htx_id);
  const bales = input.bales === undefined || input.bales === null ? null : Math.round(Number(input.bales));
  let tons: number;
  let tonsSource: 'uoc_theo_cuon' | 'nhap_tay';
  if (bales !== null) {
    if (!(bales > 0)) throw new Error('Số cuộn xuống ghe phải lớn hơn 0.');
    tons = input.tons !== undefined && input.tons !== null && Number(input.tons) > 0 ? Number(input.tons) : tonsFromBales(bales, kg.kg);
    tonsSource = 'uoc_theo_cuon';
  } else if (input.tons !== undefined && input.tons !== null && Number(input.tons) > 0) {
    tons = Number(input.tons);
    tonsSource = 'nhap_tay';
  } else {
    throw new Error('Phải ghi SỐ CUỘN đã xuống ghe — cân chỉ có ở nhà máy, ở ruộng ta đếm cuộn.');
  }

  const gathering = loadStage(jobId, 'gom_rom') as ReturnType<typeof loadStage> & { bales: number | null };
  if (!gathering.started_at) throw new Error('FM-03: Chưa gom rơm ra bờ kênh thì chưa có gì để xuống ghe.');
  const already = one<{ tons: number | null; bales: number | null }>('SELECT SUM(tons) AS tons, SUM(bales) AS bales FROM field_loadings WHERE job_id = ?', [jobId]);
  const alreadyLoaded = already?.tons ?? 0;
  const alreadyBales = already?.bales ?? 0;
  if (bales !== null && gathering.bales !== null && alreadyBales + bales > gathering.bales) {
    throw new Error(`FM-04: Đã xuống ghe ${alreadyBales} cuộn, thêm ${bales} cuộn sẽ vượt ${gathering.bales} cuộn đã gom.`);
  }
  if ((bales === null || gathering.bales === null) && gathering.quantity_tons !== null && alreadyLoaded + tons > gathering.quantity_tons + 1e-6) {
    throw new Error(`FM-04: Đã xuống ghe ${alreadyLoaded} tấn, thêm ${tons} tấn sẽ vượt ${gathering.quantity_tons} tấn đã gom.`);
  }

  const warnings: string[] = [];
  const params = resolveParams();
  // Danh mục ghe (D2): biết loại, tải rơm, đăng kiểm, đơn giá. Không có trong danh mục
  // vẫn ghi được — nhưng nói rõ để điều phối bổ sung.
  const vessel = vesselByCode(input.vesselCode);
  const vesselKind = (vessel?.kind as 'ghe' | 'sa_lan' | undefined) ?? input.vesselKind ?? 'ghe';
  if (!vessel) warnings.push(`Ghe ${input.vesselCode.trim().toUpperCase()} chưa có trong danh mục ghe — thêm vào danh mục để có đơn giá thuê và theo dõi đăng kiểm.`);
  else {
    if (vessel.status !== 'hoat_dong') warnings.push(`Ghe ${vessel.code} đang ở trạng thái ngừng hoạt động trong danh mục.`);
    const exp = expiryStatus(vessel.registration_expiry);
    if (exp.state === 'het_han') warnings.push(`GH-02: Ghe ${vessel.code} đã HẾT HẠN đăng kiểm ${Math.abs(exp.daysLeft!)} ngày — vẫn ghi nhận, báo chủ ghe và điều phối.`);
    else if (exp.state === 'sap_het_han') warnings.push(`Ghe ${vessel.code} còn ${exp.daysLeft} ngày đăng kiểm.`);
  }
  const payloadLimit = vessel?.straw_payload_tons ?? (vesselKind === 'ghe' ? params.boatStrawPayloadTons : params.bargeSmallPayloadTons ?? 1000);
  if (tons > payloadLimit * 1.1) {
    warnings.push(`Lượt này ước ${tons} tấn vượt khối lượng rơm thực chở của ${input.vesselKind === 'sa_lan' ? 'sà lan' : 'ghe'} (${payloadLimit} tấn, tham số mô phỏng) — kiểm tra lại số cuộn hoặc số hiệu phương tiện.`);
  }

  const at = input.at ?? nowIso();
  const destinationId = input.destinationFacilityId ?? job.destination_facility_id
    ?? nearestFacility({ lat: job.loading_lat, lng: job.loading_lng })?.id ?? null;
  const destination = destinationId
    ? one<{ id: string; name: string; lat: number; lng: number }>('SELECT id, name, lat, lng FROM facilities WHERE id = ?', [destinationId])
    : null;

  const loading = {
    id: uuid(), job_id: jobId, vessel_code: vessel?.code ?? input.vesselCode.trim().toUpperCase(), vessel_kind: vesselKind,
    tons, bales, tons_source: tonsSource, destination_facility_id: destination?.id ?? null, trip_id: null as string | null,
    inbound_notice_id: null as string | null, grn_id: null as string | null,
    weighed_kg: null, weighed_at: null, weighing_id: null, plant_bales: null, variance_pct: null,
    loaded_at: at, recorded_by: actor.name ?? null, lat: input.lat ?? null, lng: input.lng ?? null, note: input.note ?? null,
  };

  let trip: Row | null = null;
  if (!destination) {
    warnings.push('Chưa xác định Hub / nhà máy nhận hàng — lượt xuống ghe được ghi nhưng KHÔNG tạo chuyến TMS.');
  } else {
    try {
      trip = createTrip({
        mode: 'waterway',
        from: { lat: job.loading_lat, lng: job.loading_lng }, to: { lat: destination.lat, lng: destination.lng },
        fromLabel: `Bến tập kết — ${job.location_label}`, toLabel: destination.name,
        plannedTons: tons, vehicleCode: loading.vessel_code, driverName: input.driverName,
        refType: 'field_job', refId: jobId,
      }, actor);
      loading.trip_id = String(trip.id);
    } catch (error) {
      warnings.push(`Không tạo được chuyến TMS: ${(error as Error).message}. Lượt xuống ghe vẫn được ghi; điều phối vận tải cần tạo chuyến tay.`);
    }
    // Kho biết hàng đang tới: thông báo hàng đến mang mã chuyến — bàn cân chọn đúng
    // chuyến khi ghe cập bến, không phải tự tìm (đóng mắt hở B1).
    try {
      const notice = receiveInboundNotice({ facilityId: destination.id, tripId: loading.trip_id ?? undefined, expectedTons: tons }, actor);
      loading.inbound_notice_id = String(notice.id);
    } catch (error) {
      warnings.push(`Không tạo được thông báo hàng đến cho kho: ${(error as Error).message}.`);
    }
  }

  transaction(() => {
    insert('field_loadings', loading);
    // Tự mở công đoạn xuống ghe ở lượt đầu và cộng dồn khối lượng để dashboard
    // thấy tiến độ ngay, không chờ đội trưởng bấm hoàn thành.
    const stage = loadStage(jobId, 'xuong_ghe');
    update('field_job_stages', stage.id, {
      started_at: stage.started_at ?? at, status: stage.completed_at ? stage.status : 'dang_thuc_hien',
      quantity_tons: alreadyLoaded + tons, bales: bales !== null ? alreadyBales + bales : stage.bales ?? null, recorded_by: actor.name ?? null,
    });
    if (job.status !== 'dang_thuc_hien') update('field_jobs', jobId, { status: 'dang_thuc_hien', updated_at: nowIso() });
  });
  logEvent({ module: 'field', entityType: 'field_loadings', entityId: loading.id, action: 'create', after: { ...loading, warnings } }, actor);

  // Điều phối vận tải và kho biết ngay có ghe đang tới, không chờ cuối ngày.
  notify({
    module: 'field', severity: 'info',
    title: `Ghe ${loading.vessel_code} vừa nhận rơm — ${job.code}`,
    body: `${bales !== null ? `${bales} cuộn (ước ${tons} tấn)` : `${tons} tấn`} từ ${job.location_label}${destination ? ` về ${destination.name}` : ''}${trip ? `, chuyến ${trip.code}` : ' — KHÔNG tạo được chuyến TMS'}. Cân khi cập bến để đối chiếu.`,
    link: '/field/#field-weighing', roles: ['logistics', 'warehouse_op'],
    dedupeKey: `field.loading.${loading.id}`, entityType: 'field_loading', entityId: loading.id,
  }, actor);
  return { loading, trip, warnings, baleKg: kg };
}

// ---------------------------------------------------------------------------
// Cân tại nhà máy — số thật đối chiếu về từng lượt ghe (FM-09, FM-10)
// ---------------------------------------------------------------------------

export function recordPlantWeighing(
  loadingId: string,
  input: { facilityId?: string; grossKg?: number; tareKg?: number; netKg?: number; plantBales?: number; note?: string; at?: string },
  actor: AuditActor = {},
): { loading: Row; netKg: number; variancePct: number | null; flagged: boolean; baleKg: ReturnType<typeof baleKg> } {
  const loading = one<Row & {
    id: string; job_id: string; vessel_code: string; tons: number; bales: number | null; trip_id: string | null;
    destination_facility_id: string | null; weighed_at: string | null;
  }>('SELECT * FROM field_loadings WHERE id = ?', [loadingId]);
  if (!loading) throw new Error('Không tìm thấy lượt xuống ghe.');
  if (loading.weighed_at) throw new Error(`Lượt ghe ${loading.vessel_code} đã cân lúc ${loading.weighed_at}. Cân sai thì ghi chú và cân lại thành lượt điều chỉnh, không sửa số cũ.`);

  const gross = input.grossKg === undefined || input.grossKg === null ? null : Number(input.grossKg);
  const tare = input.tareKg === undefined || input.tareKg === null ? 0 : Number(input.tareKg);
  let net: number;
  if (input.netKg !== undefined && input.netKg !== null) net = Number(input.netKg);
  else if (gross !== null) net = gross - tare;
  else throw new Error('Phải ghi khối lượng tịnh (kg) hoặc tổng và bì.');
  if (!(net > 0)) throw new Error('Khối lượng tịnh phải lớn hơn 0.');

  const job = one<{ code: string; htx_id: string | null; team_id: string | null; location_label: string; lat: number; lng: number }>(
    'SELECT code, htx_id, team_id, location_label, lat, lng FROM field_jobs WHERE id = ?', [loading.job_id])!;
  const facilityId = input.facilityId ?? loading.destination_facility_id
    ?? one<{ id: string }>(`SELECT id FROM facilities WHERE kind = 'plant' AND status = 'active' LIMIT 1`)?.id ?? null;
  if (!facilityId) throw new Error('Không xác định được nhà máy / Hub cân hàng.');

  // Phiếu cân đi vào phân hệ kho như mọi xe khác — cùng một dòng dữ liệu, hai góc nhìn.
  const weighing = recordWeighing({
    facilityId, direction: 'in', grossKg: gross ?? net, tareKg: gross === null ? 0 : tare,
    vehicleCode: loading.vessel_code, refId: loading.trip_id ?? loading.id,
  }, actor);

  const variancePct = loading.tons > 0 ? Math.round(((net / 1000 - loading.tons) / loading.tons) * 1000) / 10 : null;
  const flagged = variancePct !== null && Math.abs(variancePct) > WEIGHING_VARIANCE_PCT;
  const at = input.at ?? nowIso();

  // Phiếu nhập kho tự tham chiếu chuyến và lượt ghe: cân xong là có GRN chờ duyệt mang
  // đúng weighing_id, HTX, thửa, ngày gặt, toạ độ gốc — kho không phải gõ lại.
  const grn = createGoodsReceipt({
    facilityId, weighingId: String(weighing.id), htxId: job.htx_id ?? undefined, plotId: (one<{ plot_id: string | null }>('SELECT plot_id FROM field_jobs WHERE id = ?', [loading.job_id])?.plot_id) ?? undefined,
    harvestDate: one<{ harvest_date: string }>('SELECT harvest_date FROM field_jobs WHERE id = ?', [loading.job_id])?.harvest_date,
    originLat: job.lat, originLng: job.lng,
  }, actor);
  const vessel = vesselByCode(loading.vessel_code);
  const distanceKm = loading.trip_id ? one<{ distance_km: number }>('SELECT distance_km FROM trips WHERE id = ?', [loading.trip_id])?.distance_km ?? 0 : 0;
  const rateCost = tripCostFor(vessel, net / 1000, distanceKm);

  transaction(() => {
    update('field_loadings', loadingId, {
      weighed_kg: net, weighed_at: at, weighing_id: weighing.id, plant_bales: input.plantBales ?? null,
      variance_pct: variancePct, note: input.note ?? loading.note ?? null, grn_id: grn.id,
    });
    if ((loading as Row).inbound_notice_id) update('inbound_notices', String((loading as Row).inbound_notice_id), { status: 'da_den' });
    if (loading.trip_id) {
      const trip = one<{ status: string }>('SELECT status FROM trips WHERE id = ?', [loading.trip_id]);
      if (trip && trip.status !== 'hoan_thanh') {
        // GH-03: có đơn giá thuê ghe thì chi phí chuyến là số thực theo hợp đồng thuê.
        completeTrip(loading.trip_id, rateCost !== null ? { actualTons: net / 1000, actualCost: rateCost, costSource: 'don_gia_ghe' } : { actualTons: net / 1000 }, actor);
      }
    }
  });
  // Việc đã hoàn thành → phiếu mua rơm cập nhật tấn cân (PM-01).
  refreshTicketForJob(loading.job_id, actor);
  logEvent({
    module: 'field', entityType: 'field_loadings', entityId: loadingId, action: 'update',
    after: { weighed_kg: net, variance_pct: variancePct, flagged, plant_bales: input.plantBales ?? null },
  }, actor);

  if (flagged) {
    const direction = variancePct! < 0 ? 'THIẾU' : 'THỪA';
    notify({
      module: 'field', severity: Math.abs(variancePct!) > 15 ? 'critical' : 'warn',
      title: `Cân lệch ${Math.abs(variancePct!)} % — ghe ${loading.vessel_code}`,
      body: `Việc ${job.code} (${job.location_label}): ước ${loading.tons} tấn${loading.bales ? ` từ ${loading.bales} cuộn` : ''}, cân ${net / 1000} tấn — ${direction} ${Math.abs(Math.round(net / 1000 - loading.tons))} tấn. Kiểm số cuộn, độ ẩm, hoặc ghe.`,
      link: '/field/#field-weighing', roles: ['field_manager', 'logistics'],
      dedupeKey: `field.variance.${loadingId}`, entityType: 'field_loading', entityId: loadingId,
    }, actor);
  }

  return {
    loading: one('SELECT * FROM field_loadings WHERE id = ?', [loadingId])!,
    netKg: net, variancePct, flagged, baleKg: baleKg(job.htx_id),
    goodsReceipt: { id: grn.id, code: grn.code, status: grn.status },
    tripCost: rateCost,
  };
}

/** Ghe đã xuống hàng nhưng nhà máy chưa cân — hàng đợi cho bàn cân. */
export function pendingWeighings(): Row[] {
  return all(
    `SELECT l.id, l.vessel_code, l.vessel_kind, l.bales, l.tons, l.tons_source, l.loaded_at, l.recorded_by,
            j.code AS job_code, j.location_label, j.htx_id, t.name AS team_name, h.name AS htx_name,
            f.name AS destination_name, tr.code AS trip_code, tr.status AS trip_status, tr.distance_km,
            n.code AS notice_code, n.status AS notice_status,
            ROUND((julianday('now') - julianday(l.loaded_at)) * 24) AS hours_since_loading
     FROM field_loadings l
     JOIN field_jobs j ON j.id = l.job_id
     LEFT JOIN field_teams t ON t.id = j.team_id
     LEFT JOIN cooperatives h ON h.id = j.htx_id
     LEFT JOIN facilities f ON f.id = l.destination_facility_id
     LEFT JOIN trips tr ON tr.id = l.trip_id
     LEFT JOIN inbound_notices n ON n.id = l.inbound_notice_id
     WHERE l.weighed_at IS NULL ORDER BY l.loaded_at`,
  );
}

/**
 * Đối soát ba chiều hiện trường – ghe – cân theo đội và theo HTX.
 * Trả lời câu hỏi mà trước đây không ai trả lời được: hao hụt nằm ở đâu.
 */
export function weighingReconciliation(fromDate = addDays(today(), -30), toDate = today()): Row {
  const rows = all<{
    team_id: string | null; team_name: string | null; htx_id: string | null; htx_name: string | null;
    loadings: number; weighed: number; bales: number | null; plant_bales: number | null;
    est_tons: number; weighed_kg: number | null; flagged: number;
  }>(
    `SELECT j.team_id, t.name AS team_name, j.htx_id, h.name AS htx_name,
            COUNT(*) AS loadings, COUNT(l.weighed_kg) AS weighed,
            SUM(CASE WHEN l.weighed_kg IS NOT NULL THEN l.bales END) AS bales,
            SUM(l.plant_bales) AS plant_bales,
            SUM(CASE WHEN l.weighed_kg IS NOT NULL THEN l.tons ELSE 0 END) AS est_tons,
            SUM(l.weighed_kg) AS weighed_kg,
            SUM(CASE WHEN ABS(COALESCE(l.variance_pct, 0)) > ? THEN 1 ELSE 0 END) AS flagged
     FROM field_loadings l JOIN field_jobs j ON j.id = l.job_id
     LEFT JOIN field_teams t ON t.id = j.team_id LEFT JOIN cooperatives h ON h.id = j.htx_id
     WHERE l.loaded_at BETWEEN ? AND ?
     GROUP BY j.team_id, j.htx_id ORDER BY t.name, h.name`,
    [WEIGHING_VARIANCE_PCT, `${fromDate}T00:00:00`, `${toDate}T23:59:59.999`],
  );
  const shape = (row: typeof rows[number]) => {
    const weighedTons = (row.weighed_kg ?? 0) / 1000;
    return {
      ...row,
      weighedTons: Math.round(weighedTons * 10) / 10,
      estTons: Math.round(row.est_tons * 10) / 10,
      variancePct: row.est_tons > 0 ? Math.round(((weighedTons - row.est_tons) / row.est_tons) * 1000) / 10 : null,
      avgBaleKg: row.bales ? Math.round(((row.weighed_kg ?? 0) / row.bales) * 10) / 10 : null,
      baleDiff: row.bales !== null && row.plant_bales !== null ? row.plant_bales - row.bales : null,
    };
  };
  const groups = rows.map(shape);
  const aggregate = (key: 'team_id' | 'htx_id', label: 'team_name' | 'htx_name') => {
    const map = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const k = String(row[key] ?? '—');
      const acc = map.get(k) ?? { ...row, loadings: 0, weighed: 0, bales: 0, plant_bales: 0, est_tons: 0, weighed_kg: 0, flagged: 0 };
      acc.loadings += row.loadings; acc.weighed += row.weighed;
      acc.bales = (acc.bales ?? 0) + (row.bales ?? 0); acc.plant_bales = (acc.plant_bales ?? 0) + (row.plant_bales ?? 0);
      acc.est_tons += row.est_tons; acc.weighed_kg = (acc.weighed_kg ?? 0) + (row.weighed_kg ?? 0); acc.flagged += row.flagged;
      (acc as Record<string, unknown>)[label] = row[label];
      map.set(k, acc);
    }
    return [...map.values()].map(shape);
  };
  const recent = all<Row>(
    `SELECT l.id, l.vessel_code, l.bales, l.plant_bales, l.tons, l.weighed_kg, l.variance_pct, l.loaded_at, l.weighed_at,
            j.code AS job_code, j.location_label, t.name AS team_name, g.code AS grn_code, g.status AS grn_status
     FROM field_loadings l JOIN field_jobs j ON j.id = l.job_id LEFT JOIN field_teams t ON t.id = j.team_id
     LEFT JOIN goods_receipts g ON g.id = l.grn_id
     WHERE l.weighed_at IS NOT NULL AND l.loaded_at BETWEEN ? AND ? ORDER BY l.weighed_at DESC LIMIT 50`,
    [`${fromDate}T00:00:00`, `${toDate}T23:59:59.999`],
  );
  return {
    from: fromDate, to: toDate, thresholdPct: WEIGHING_VARIANCE_PCT,
    byTeam: aggregate('team_id', 'team_name'), byHtx: aggregate('htx_id', 'htx_name'), groups, recent,
    baleKg: baleKg(null),
    pending: pendingWeighings().length,
  };
}

// ---------------------------------------------------------------------------
// Truy vấn
// ---------------------------------------------------------------------------

const JOB_SELECT = `
  SELECT j.*, t.name AS team_name, t.code AS team_code, h.name AS htx_name, p.code AS plot_code,
         f.name AS destination_name,
         (SELECT COUNT(*) FROM field_loadings l WHERE l.job_id = j.id) AS loading_count,
         (SELECT SUM(tons) FROM field_loadings l WHERE l.job_id = j.id) AS loaded_tons
  FROM field_jobs j
  LEFT JOIN field_teams t ON t.id = j.team_id
  LEFT JOIN cooperatives h ON h.id = j.htx_id
  LEFT JOIN plots p ON p.id = j.plot_id
  LEFT JOIN facilities f ON f.id = j.destination_facility_id`;

/** FM-02: gắn cờ rủi ro cho việc có rơm nằm ruộng quá hạn mà chưa cuộn xong. */
function decorateJob(job: Row, stages: Row[]): Row {
  const baling = stages.find((stage) => stage.stage === 'cuon_rom');
  const referenceDay = today();
  const harvestDate = String(job.harvest_date);
  const done = Boolean(baling?.completed_at);
  const daysOnField = done
    ? daysBetween(harvestDate, String(baling!.completed_at).slice(0, 10))
    : (harvestDate <= referenceDay ? daysBetween(harvestDate, referenceDay) : null);
  const overdue = !done && job.status !== 'huy' && daysOnField !== null && daysOnField > MAX_DAYS_AFTER_HARVEST;
  const kg = baleKg(job.htx_id as string | null);
  return {
    ...job,
    statusLabel: JOB_STATUS[String(job.status)] ?? job.status,
    stages,
    expectedBales: Math.round((Number(job.expected_straw_tons) * 1000) / kg.kg),
    baleKg: kg,
    daysOnField,
    overdue,
    riskLabel: overdue ? `Rơm nằm ruộng ${daysOnField} ngày — quá ngưỡng ${MAX_DAYS_AFTER_HARVEST}` : null,
  };
}

export function jobDetail(jobId: string): Row {
  const job = one<Row>(`${JOB_SELECT} WHERE j.id = ?`, [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  const stages = all<Row>(
    `SELECT s.*, v.code AS vehicle_code, v.name AS vehicle_name FROM field_job_stages s
     LEFT JOIN field_vehicles v ON v.id = s.vehicle_id WHERE s.job_id = ? ORDER BY s.sort_order`,
    [jobId],
  ).map((stage) => ({ ...stage, label: stageMeta(String(stage.stage)).label, evidence: parseJson(stage.evidence_json, []) }));
  const loadings = all<Row>(
    `SELECT l.*, f.name AS destination_name, tr.code AS trip_code, tr.status AS trip_status, tr.distance_km,
            g.code AS grn_code, g.status AS grn_status, n.code AS notice_code, n.status AS notice_status
     FROM field_loadings l
     LEFT JOIN facilities f ON f.id = l.destination_facility_id
     LEFT JOIN trips tr ON tr.id = l.trip_id
     LEFT JOIN goods_receipts g ON g.id = l.grn_id
     LEFT JOIN inbound_notices n ON n.id = l.inbound_notice_id
     WHERE l.job_id = ? ORDER BY l.loaded_at`,
    [jobId],
  );
  return { ...decorateJob(job, stages), loadings };
}

export function listJobs(filter: {
  status?: string; teamId?: string; from?: string; to?: string; htxId?: string; onlyOverdue?: boolean; limit?: number;
} = {}): Row[] {
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (filter.status) { where.push('j.status = ?'); params.push(filter.status); }
  if (filter.teamId) { where.push('j.team_id = ?'); params.push(filter.teamId); }
  if (filter.htxId) { where.push('j.htx_id = ?'); params.push(filter.htxId); }
  if (filter.from) { where.push('COALESCE(j.planned_date, j.harvest_date) >= ?'); params.push(filter.from); }
  if (filter.to) { where.push('COALESCE(j.planned_date, j.harvest_date) <= ?'); params.push(filter.to); }
  params.push(filter.limit ?? 300);
  const jobs = all<Row & { id: string }>(
    `${JOB_SELECT} WHERE ${where.join(' AND ')} ORDER BY j.status = 'hoan_thanh', COALESCE(j.planned_date, j.harvest_date), j.code LIMIT ?`,
    params,
  );
  if (!jobs.length) return [];
  const stages = all<Row & { job_id: string }>(
    `SELECT job_id, stage, status, planned_start, planned_end, started_at, completed_at, quantity_tons FROM field_job_stages
     WHERE job_id IN (${jobs.map(() => '?').join(',')}) ORDER BY sort_order`,
    jobs.map((job) => job.id),
  );
  const decorated = jobs.map((job) => decorateJob(job, stages.filter((stage) => stage.job_id === job.id)));
  return filter.onlyOverdue ? decorated.filter((job) => job.overdue) : decorated;
}

/** Lịch gặt theo ngày: rơm dự kiến, việc đã/chưa phân công, tải từng đội. */
export function harvestCalendar(fromDate = today(), days = 14): Row {
  const toDate = addDays(fromDate, days - 1);
  const jobs = listJobs({ from: fromDate, to: toDate, limit: 2000 }).filter((job) => job.status !== 'huy');
  const teams = all<{ id: string; name: string }>(`SELECT id, name FROM field_teams WHERE status = 'hoat_dong' ORDER BY name`);
  const rows: Row[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = addDays(fromDate, offset);
    const dayJobs = jobs.filter((job) => String(job.planned_date ?? job.harvest_date) === day);
    rows.push({
      date: day,
      expectedTons: dayJobs.reduce((sum, job) => sum + Number(job.expected_straw_tons), 0),
      jobs: dayJobs.length,
      unassigned: dayJobs.filter((job) => job.status === 'cho_phan_cong').length,
      teams: teams.map((team) => {
        const capacity = teamCapacityTonsPerDay(team.id);
        const load = teamLoadOn(team.id, day);
        return { teamId: team.id, name: team.name, loadTons: Math.round(load), capacityTons: capacity.tons, utilisationPct: Math.round((load / capacity.tons) * 100) };
      }),
    });
  }
  return { from: fromDate, to: toDate, days: rows, jobs };
}

/**
 * Bảng điều hành theo thời gian thực: hôm nay đội nào ở đâu, đã cuộn / gom /
 * xuống ghe bao nhiêu, rơm nào đang nằm ruộng quá hạn, ghe nào đang chạy.
 */
export function fieldDashboard(date = today()): Row {
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59.999`;
  const jobs = listJobs({ limit: 5000 });
  const active = jobs.filter((job) => !['hoan_thanh', 'huy'].includes(String(job.status)));

  const stageTons = (stage: FieldStage) => one<{ tons: number | null; n: number }>(
    'SELECT SUM(quantity_tons) AS tons, COUNT(*) AS n FROM field_job_stages WHERE stage = ? AND completed_at BETWEEN ? AND ?',
    [stage, dayStart, dayEnd],
  ) ?? { tons: 0, n: 0 };
  const loadedToday = one<{ tons: number | null; bales: number | null; n: number; trips: number }>(
    'SELECT SUM(tons) AS tons, SUM(bales) AS bales, COUNT(*) AS n, COUNT(trip_id) AS trips FROM field_loadings WHERE loaded_at BETWEEN ? AND ?',
    [dayStart, dayEnd],
  ) ?? { tons: 0, bales: 0, n: 0, trips: 0 };
  const balesToday = (stage: FieldStage) => one<{ bales: number | null }>(
    'SELECT SUM(bales) AS bales FROM field_job_stages WHERE stage = ? AND completed_at BETWEEN ? AND ?', [stage, dayStart, dayEnd])?.bales ?? 0;
  const unweighed = one<{ n: number; tons: number | null }>('SELECT COUNT(*) AS n, SUM(tons) AS tons FROM field_loadings WHERE weighed_at IS NULL') ?? { n: 0, tons: 0 };
  const weighedToday = one<{ n: number; kg: number | null }>(
    'SELECT COUNT(*) AS n, SUM(weighed_kg) AS kg FROM field_loadings WHERE weighed_at BETWEEN ? AND ?', [dayStart, dayEnd]) ?? { n: 0, kg: 0 };
  const vesselsUnderway = all<Row>(
    `SELECT code, vehicle_code, planned_tons, to_label, status, departed_at FROM trips
     WHERE ref_type = 'field_job' AND status IN ('ke_hoach', 'dang_chay') ORDER BY created_at DESC LIMIT 20`,
  );

  const teams = listTeams().filter((team) => team.status === 'hoat_dong').map((team) => {
    const todays = active.filter((job) => job.team_id === team.id && String(job.planned_date) <= date
      && (job.stages as Row[]).some((stage) => stage.planned_start && String(stage.planned_start) <= date && String(stage.planned_end) >= date));
    const running = todays.filter((job) => job.status === 'dang_thuc_hien');
    const load = teamLoadOn(String(team.id), date);
    return {
      id: team.id, code: team.code, name: team.name, leaderName: team.leader_name, baseLat: team.base_lat, baseLng: team.base_lng,
      jobsToday: todays.length, running: running.length,
      loadTons: Math.round(load), capacityTons: team.capacityTonsPerDay,
      utilisationPct: Math.round((load / Number(team.capacityTonsPerDay)) * 100),
      state: running.length ? 'dang_lam' : (todays.length ? 'cho_bat_dau' : 'ranh'),
      vehiclesReady: (team.vehicles as Row[]).filter((v) => v.status === 'san_sang').length,
      vehiclesDown: (team.vehicles as Row[]).filter((v) => ['bao_duong', 'hong'].includes(String(v.status))).length,
      currentJobs: running.map((job) => ({ id: job.id, code: job.code, location: job.location_label, tons: job.expected_straw_tons })),
    };
  });

  const recent = all<Row>(
    `SELECT s.stage, s.started_at, s.completed_at, s.quantity_tons, s.recorded_by, j.code AS job_code, j.location_label, t.name AS team_name
     FROM field_job_stages s JOIN field_jobs j ON j.id = s.job_id LEFT JOIN field_teams t ON t.id = j.team_id
     WHERE s.started_at IS NOT NULL ORDER BY COALESCE(s.completed_at, s.started_at) DESC LIMIT 12`,
  ).map((row) => ({ ...row, label: stageMeta(String(row.stage)).label }));

  const overdue = active.filter((job) => job.overdue);
  const baled = stageTons('cuon_rom');
  const gathered = stageTons('gom_rom');
  return {
    date,
    kpis: {
      activeJobs: active.length,
      unassigned: active.filter((job) => job.status === 'cho_phan_cong').length,
      running: active.filter((job) => job.status === 'dang_thuc_hien').length,
      completedToday: one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM field_job_stages WHERE stage = 'xuong_ghe' AND completed_at BETWEEN ? AND ?`, [dayStart, dayEnd])?.n ?? 0,
      baledTonsToday: Math.round((baled.tons ?? 0) * 10) / 10,
      baledBalesToday: balesToday('cuon_rom'),
      gatheredTonsToday: Math.round((gathered.tons ?? 0) * 10) / 10,
      gatheredBalesToday: balesToday('gom_rom'),
      loadedTonsToday: Math.round((loadedToday.tons ?? 0) * 10) / 10,
      loadedBalesToday: loadedToday.bales ?? 0,
      loadingsToday: loadedToday.n,
      unweighedLoadings: unweighed.n,
      unweighedTons: Math.round(unweighed.tons ?? 0),
      weighedToday: weighedToday.n,
      weighedTonsToday: Math.round(((weighedToday.kg ?? 0) / 1000) * 10) / 10,
      tripsCreatedToday: loadedToday.trips,
      overdueJobs: overdue.length,
      overdueTons: Math.round(overdue.reduce((sum, job) => sum + Number(job.expected_straw_tons), 0)),
      strawOnField: Math.round(active.filter((job) => String(job.harvest_date) <= date
        && !(job.stages as Row[]).find((stage) => stage.stage === 'cuon_rom')?.completed_at)
        .reduce((sum, job) => sum + Number(job.expected_straw_tons), 0)),
      teamsIdle: teams.filter((team) => team.state === 'ranh').length,
    },
    teams,
    overdue: overdue.slice(0, 20),
    unassigned: active.filter((job) => job.status === 'cho_phan_cong').slice(0, 20),
    vesselsUnderway,
    recent,
    jobsForMap: active.map((job) => ({
      id: job.id, code: job.code, lat: job.lat, lng: job.lng, status: job.status, statusLabel: job.statusLabel,
      tons: job.expected_straw_tons, team: job.team_name, location: job.location_label, overdue: job.overdue,
    })),
  };
}

/** Năng suất đội và thời gian từng công đoạn — cơ sở khoán và cải tiến. */
export function productivityReport(fromDate: string, toDate: string): Row {
  const teams = all<{ id: string; code: string; name: string }>('SELECT id, code, name FROM field_teams ORDER BY name');
  // Việc "thuộc kỳ" khi lượt xuống ghe cuối chốt trong kỳ — không dùng updated_at
  // vì một sửa ghi chú sau đó sẽ kéo việc sang kỳ khác.
  const DONE_IN_PERIOD = `SELECT j.id FROM field_jobs j JOIN field_job_stages s ON s.job_id = j.id AND s.stage = 'xuong_ghe'
    WHERE j.status = 'hoan_thanh' AND j.team_id IS NOT NULL AND s.completed_at BETWEEN ? AND ?`;
  const bounds = [`${fromDate}T00:00:00`, `${toDate}T23:59:59.999`];
  const jobs = all<Row & { id: string; team_id: string; harvest_date: string; expected_straw_tons: number; area_ha: number | null }>(
    `SELECT * FROM field_jobs WHERE id IN (${DONE_IN_PERIOD})`, bounds);
  const stages = all<Row & { job_id: string; stage: string; started_at: string | null; completed_at: string | null; quantity_tons: number | null }>(
    `SELECT * FROM field_job_stages WHERE job_id IN (${DONE_IN_PERIOD})`, bounds);
  const loadings = all<{ job_id: string; tons: number; loaded_at: string; bales: number | null; weighed_kg: number | null }>(
    'SELECT job_id, tons, loaded_at, bales, weighed_kg FROM field_loadings');

  const hours = (from: string | null, to: string | null) =>
    from && to ? (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000 : null;
  const avg = (values: (number | null)[]) => {
    const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
    return valid.length ? Math.round((valid.reduce((sum, value) => sum + value, 0) / valid.length) * 10) / 10 : null;
  };

  const byTeam = teams.map((team) => {
    const teamJobs = jobs.filter((job) => job.team_id === team.id);
    const ids = new Set(teamJobs.map((job) => job.id));
    const teamStages = stages.filter((stage) => ids.has(stage.job_id));
    const stageQty = (code: FieldStage) => teamStages.filter((s) => s.stage === code).reduce((sum, s) => sum + (s.quantity_tons ?? 0), 0);
    const stageHours = (code: FieldStage) => avg(teamStages.filter((s) => s.stage === code).map((s) => hours(s.started_at, s.completed_at)));
    const leadHours = avg(teamJobs.map((job) => {
      const last = loadings.filter((l) => l.job_id === job.id).map((l) => l.loaded_at).sort().at(-1);
      return last ? hours(`${job.harvest_date}T06:00:00`, last) : null;
    }));
    const baled = stageQty('cuon_rom');
    const stageBales = (code: FieldStage) => teamStages.filter((s) => s.stage === code).reduce((sum, s) => sum + (Number((s as Row).bales) || 0), 0);
    const weighed = loadings.filter((l) => ids.has(l.job_id) && (l as Row).weighed_kg !== null && (l as Row).weighed_kg !== undefined);
    const weighedKg = weighed.reduce((sum, l) => sum + Number((l as Row).weighed_kg ?? 0), 0);
    const weighedBales = weighed.reduce((sum, l) => sum + Number((l as Row).bales ?? 0), 0);
    return {
      teamId: team.id, code: team.code, name: team.name,
      jobsCompleted: teamJobs.length,
      baledBales: stageBales('cuon_rom'),
      gatheredBales: stageBales('gom_rom'),
      loadedBales: stageBales('xuong_ghe'),
      weighedTons: Math.round((weighedKg / 1000) * 10) / 10,
      avgBaleKg: weighedBales ? Math.round((weighedKg / weighedBales) * 10) / 10 : null,
      areaHa: Math.round(teamJobs.reduce((sum, job) => sum + (job.area_ha ?? 0), 0) * 10) / 10,
      expectedTons: Math.round(teamJobs.reduce((sum, job) => sum + job.expected_straw_tons, 0)),
      baledTons: Math.round(baled * 10) / 10,
      gatheredTons: Math.round(stageQty('gom_rom') * 10) / 10,
      loadedTons: Math.round(stageQty('xuong_ghe') * 10) / 10,
      recoveryPct: teamJobs.length ? Math.round((baled / Math.max(1, teamJobs.reduce((sum, job) => sum + job.expected_straw_tons, 0))) * 100) : null,
      avgHoursBaling: stageHours('cuon_rom'),
      avgHoursGathering: stageHours('gom_rom'),
      avgHoursLoading: stageHours('xuong_ghe'),
      avgLeadHoursHarvestToVessel: leadHours,
    };
  });

  const vehicles = all<Row>(
    `SELECT v.code, v.name, v.kind, v.status, t.name AS team_name,
            (SELECT COUNT(DISTINCT substr(s.started_at, 1, 10)) FROM field_job_stages s
              WHERE s.vehicle_id = v.id AND s.started_at BETWEEN ? AND ?) AS days_used,
            (SELECT SUM(s.quantity_tons) FROM field_job_stages s
              WHERE s.vehicle_id = v.id AND s.completed_at BETWEEN ? AND ?) AS tons_handled
     FROM field_vehicles v LEFT JOIN field_teams t ON t.id = v.team_id ORDER BY v.kind, v.code`,
    [`${fromDate}T00:00:00`, `${toDate}T23:59:59.999`, `${fromDate}T00:00:00`, `${toDate}T23:59:59.999`],
  );
  const periodDays = daysBetween(fromDate, toDate) + 1;
  return {
    from: fromDate, to: toDate, periodDays,
    teams: byTeam,
    vehicles: vehicles.map((vehicle) => ({ ...vehicle, utilisationPct: Math.round((Number(vehicle.days_used ?? 0) / periodDays) * 100) })),
    totals: {
      jobsCompleted: jobs.length,
      baledTons: Math.round(byTeam.reduce((sum, team) => sum + team.baledTons, 0)),
      loadedTons: Math.round(byTeam.reduce((sum, team) => sum + team.loadedTons, 0)),
    },
  };
}

/** Phương tiện, Hub và đội — dữ liệu chọn cho biểu mẫu hiện trường. */
export function fieldLookups(): Row {
  return {
    stages: STAGES,
    vehicleKinds: VEHICLE_KINDS,
    jobStatus: JOB_STATUS,
    memberRoles: MEMBER_ROLES,
    maxDaysAfterHarvest: MAX_DAYS_AFTER_HARVEST,
    baleKg: baleKg(null),
    weighingVariancePct: WEIGHING_VARIANCE_PCT,
    facilities: all('SELECT id, code, name, kind, lat, lng FROM facilities WHERE status = \'active\' AND kind IN (\'hub\', \'plant\') ORDER BY kind, name'),
    teams: all('SELECT id, code, name, status FROM field_teams ORDER BY name'),
    cooperatives: all('SELECT id, code, name, lat, lng FROM cooperatives WHERE lat IS NOT NULL ORDER BY name LIMIT 400'),
  };
}
