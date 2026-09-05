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
 */
import { all, insert, one, parseJson, transaction, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { haversineKm, type LatLng } from '../../platform/geo/geo.ts';
import { resolveParams } from '../params/store.ts';
import { createTrip } from '../tms/service.ts';

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
  const timestamp = nowIso();
  const record = {
    id: uuid(), code: nextCode('TG', 'field_jobs'),
    source_type: input.sourceType, source_id: input.sourceId ?? null,
    crop_cycle_id: input.cropCycleId ?? null, plot_id: input.plotId ?? null, htx_id: htxId,
    location_label: label, lat, lng,
    loading_lat: input.loadingLat ?? lat, loading_lng: input.loadingLng ?? lng,
    destination_facility_id: destination,
    harvest_date: input.harvestDate, harvest_confirmed: input.harvestConfirmed ? 1 : 0,
    expected_straw_tons: expected, area_ha: areaHa,
    team_id: null, planned_date: null, assignment_mode: null, assigned_by: null, assigned_at: null,
    priority: input.priority ?? 0, status: 'cho_phan_cong', note: input.note ?? null,
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
    quantityTons: number; bales?: number; vehicleId?: string; lat?: number; lng?: number;
    note?: string; evidence?: { kind: string; url?: string; note?: string }[]; at?: string;
  },
  actor: AuditActor = {},
): Row {
  const job = one<{ code: string; status: string; team_id: string | null; expected_straw_tons: number }>(
    'SELECT code, status, team_id, expected_straw_tons FROM field_jobs WHERE id = ?', [jobId]);
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

  // Xuống ghe: khối lượng là tổng các lượt đã ghi, không nhập tay lại.
  let quantity = input.quantityTons;
  if (stage === 'xuong_ghe') {
    const loaded = one<{ tons: number | null; n: number }>('SELECT SUM(tons) AS tons, COUNT(*) AS n FROM field_loadings WHERE job_id = ?', [jobId]);
    if (!loaded?.n) throw new Error('Chưa ghi lượt xuống ghe nào — dùng "Ghi lượt xuống ghe" cho từng ghe / sà lan trước.');
    quantity = loaded.tons ?? 0;
  }
  if (!(quantity >= 0)) throw new Error('Khối lượng phải là số không âm.');
  if (prev) {
    const before = loadStage(jobId, prev);
    if (before.quantity_tons !== null && quantity > before.quantity_tons + 1e-6) {
      throw new Error(
        `FM-04: ${stageMeta(stage).label} ${quantity} tấn nhiều hơn ${stageMeta(prev).label.toLowerCase()} ${before.quantity_tons} tấn — rơm không tự sinh ra giữa hai công đoạn. Kiểm tra lại số liệu.`,
      );
    }
  }

  const evidence = (input.evidence ?? []).filter((item) => item && item.kind);
  transaction(() => {
    update('field_job_stages', current.id, {
      completed_at: at, status: 'hoan_thanh', quantity_tons: quantity, bales: input.bales ?? null,
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
    after: { stage, completed_at: at, quantity_tons: quantity, bales: input.bales, evidence: evidence.length },
  }, actor);
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
    vesselCode: string; vesselKind?: 'ghe' | 'sa_lan'; tons: number; bales?: number;
    destinationFacilityId?: string; lat?: number; lng?: number; note?: string; at?: string; driverName?: string;
  },
  actor: AuditActor = {},
): { loading: Row; trip: Row | null; warnings: string[] } {
  const job = one<{
    code: string; status: string; team_id: string | null; loading_lat: number; loading_lng: number;
    location_label: string; destination_facility_id: string | null;
  }>('SELECT * FROM field_jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  if (['hoan_thanh', 'huy'].includes(job.status)) throw new Error(`Việc ${job.code} đã kết thúc.`);
  if (!input.vesselCode?.trim()) throw new Error('Phải ghi số hiệu ghe / sà lan — đây là mã để TMS và kho đối chiếu.');
  if (!(input.tons > 0)) throw new Error('Khối lượng xuống ghe phải lớn hơn 0.');

  const gathering = loadStage(jobId, 'gom_rom');
  if (!gathering.started_at) throw new Error('FM-03: Chưa gom rơm ra bờ kênh thì chưa có gì để xuống ghe.');
  const alreadyLoaded = one<{ tons: number | null }>('SELECT SUM(tons) AS tons FROM field_loadings WHERE job_id = ?', [jobId])?.tons ?? 0;
  if (gathering.quantity_tons !== null && alreadyLoaded + input.tons > gathering.quantity_tons + 1e-6) {
    throw new Error(
      `FM-04: Đã xuống ghe ${alreadyLoaded} tấn, thêm ${input.tons} tấn sẽ vượt ${gathering.quantity_tons} tấn đã gom.`,
    );
  }

  const warnings: string[] = [];
  const params = resolveParams();
  const payloadLimit = (input.vesselKind ?? 'ghe') === 'ghe' ? params.boatStrawPayloadTons : params.bargeSmallPayloadTons ?? 1000;
  if (input.tons > payloadLimit * 1.1) {
    warnings.push(`Lượt này ${input.tons} tấn vượt khối lượng rơm thực chở của ${input.vesselKind === 'sa_lan' ? 'sà lan' : 'ghe'} (${payloadLimit} tấn, tham số mô phỏng) — kiểm tra lại đơn vị hoặc số hiệu phương tiện.`);
  }

  const at = input.at ?? nowIso();
  const destinationId = input.destinationFacilityId ?? job.destination_facility_id
    ?? nearestFacility({ lat: job.loading_lat, lng: job.loading_lng })?.id ?? null;
  const destination = destinationId
    ? one<{ id: string; name: string; lat: number; lng: number }>('SELECT id, name, lat, lng FROM facilities WHERE id = ?', [destinationId])
    : null;

  const loading = {
    id: uuid(), job_id: jobId, vessel_code: input.vesselCode.trim(), vessel_kind: input.vesselKind ?? 'ghe',
    tons: input.tons, bales: input.bales ?? null, destination_facility_id: destination?.id ?? null, trip_id: null as string | null,
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
        plannedTons: input.tons, vehicleCode: loading.vessel_code, driverName: input.driverName,
        refType: 'field_job', refId: jobId,
      }, actor);
      loading.trip_id = String(trip.id);
    } catch (error) {
      warnings.push(`Không tạo được chuyến TMS: ${(error as Error).message}. Lượt xuống ghe vẫn được ghi; điều phối vận tải cần tạo chuyến tay.`);
    }
  }

  transaction(() => {
    insert('field_loadings', loading);
    // Tự mở công đoạn xuống ghe ở lượt đầu và cộng dồn khối lượng để dashboard
    // thấy tiến độ ngay, không chờ đội trưởng bấm hoàn thành.
    const stage = loadStage(jobId, 'xuong_ghe');
    update('field_job_stages', stage.id, {
      started_at: stage.started_at ?? at, status: stage.completed_at ? stage.status : 'dang_thuc_hien',
      quantity_tons: alreadyLoaded + input.tons, recorded_by: actor.name ?? null,
    });
    if (job.status !== 'dang_thuc_hien') update('field_jobs', jobId, { status: 'dang_thuc_hien', updated_at: nowIso() });
  });
  logEvent({ module: 'field', entityType: 'field_loadings', entityId: loading.id, action: 'create', after: { ...loading, warnings } }, actor);
  return { loading, trip, warnings };
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
  return {
    ...job,
    statusLabel: JOB_STATUS[String(job.status)] ?? job.status,
    stages,
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
    `SELECT l.*, f.name AS destination_name, tr.code AS trip_code, tr.status AS trip_status, tr.distance_km
     FROM field_loadings l
     LEFT JOIN facilities f ON f.id = l.destination_facility_id
     LEFT JOIN trips tr ON tr.id = l.trip_id
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
  const loadedToday = one<{ tons: number | null; n: number; trips: number }>(
    'SELECT SUM(tons) AS tons, COUNT(*) AS n, COUNT(trip_id) AS trips FROM field_loadings WHERE loaded_at BETWEEN ? AND ?',
    [dayStart, dayEnd],
  ) ?? { tons: 0, n: 0, trips: 0 };
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
      gatheredTonsToday: Math.round((gathered.tons ?? 0) * 10) / 10,
      loadedTonsToday: Math.round((loadedToday.tons ?? 0) * 10) / 10,
      loadingsToday: loadedToday.n,
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
  const loadings = all<{ job_id: string; tons: number; loaded_at: string }>('SELECT job_id, tons, loaded_at FROM field_loadings');

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
    return {
      teamId: team.id, code: team.code, name: team.name,
      jobsCompleted: teamJobs.length,
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
    facilities: all('SELECT id, code, name, kind, lat, lng FROM facilities WHERE status = \'active\' AND kind IN (\'hub\', \'plant\') ORDER BY kind, name'),
    teams: all('SELECT id, code, name, status FROM field_teams ORDER BY name'),
    cooperatives: all('SELECT id, code, name, lat, lng FROM cooperatives WHERE lat IS NOT NULL ORDER BY name LIMIT 400'),
  };
}
