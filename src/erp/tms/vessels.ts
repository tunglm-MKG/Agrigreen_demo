/**
 * DANH MỤC GHE / SÀ LAN và ĐƠN GIÁ THUÊ (D2 trong bản rà soát).
 *
 * TMS nhận số hiệu phương tiện tự do; ghe phần lớn thuê ngoài, không có danh mục
 * chủ ghe, lớp tàu, đơn giá → chi phí vận tải thực không đối chiếu được với hợp
 * đồng thuê. Danh mục này là nơi duy nhất giữ ba thứ đó, nối với lớp tàu của
 * `platform/geo/vessels.ts` để biết ghe nào qua được tuyến nào.
 *
 *   GH-01  Số hiệu là định danh duy nhất (đúng số đăng ký trên thân ghe).
 *   GH-02  Hết hạn đăng kiểm không chặn xuống ghe — cảnh báo rõ; chặn là kẹt rơm
 *          trên bờ, còn ghe hết hạn là việc của chủ ghe và pháp luật, không phải của
 *          đội trưởng lúc 5 giờ sáng.
 *   GH-03  Có đơn giá thì chuyến TMS lấy chi phí thật theo đơn giá đó khi cân ở nhà
 *          máy — số này là chi phí THỰC (theo hợp đồng thuê), khác số ước theo tham
 *          số mô phỏng.
 */
import { all, insert, one, update } from '../../platform/db/db.ts';
import { nowIso, today, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { VESSEL_CLASSES } from '../../platform/geo/vessels.ts';

export const RATE_TYPES: Record<string, string> = { per_ton: 'đ/tấn cân', per_trip: 'đ/chuyến', per_ton_km: 'đ/tấn·km' };
export const EXPIRY_WARNING_DAYS = 30;

type Row = Record<string, unknown>;

export interface VesselInput {
  code: string; name?: string; kind: 'ghe' | 'sa_lan'; vesselClass?: string;
  ownerName?: string; ownerPhone?: string; registeredTons?: number; strawPayloadTons?: number;
  registrationExpiry?: string; rateType?: 'per_ton' | 'per_trip' | 'per_ton_km'; rateVnd?: number; note?: string;
}

const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');

function validate(input: VesselInput, existingId?: string): void {
  if (!input.code?.trim()) throw new Error('GH-01: Phải ghi số hiệu ghe / sà lan.');
  const dup = one<{ id: string }>('SELECT id FROM vessels WHERE code = ?', [normalizeCode(input.code)]);
  if (dup && dup.id !== existingId) throw new Error(`GH-01: Số hiệu ${normalizeCode(input.code)} đã có trong danh mục.`);
  if (!['ghe', 'sa_lan'].includes(input.kind)) throw new Error('Loại phương tiện phải là ghe hoặc sà lan.');
  if (input.vesselClass && !VESSEL_CLASSES.some((c) => c.code === input.vesselClass)) throw new Error('Lớp tàu không có trong bảng lớp tàu.');
  if (input.rateType && !RATE_TYPES[input.rateType]) throw new Error('Loại đơn giá không hợp lệ.');
  if (input.rateType && !(Number(input.rateVnd) > 0)) throw new Error('Có loại đơn giá thì đơn giá phải lớn hơn 0.');
  if (input.registeredTons !== undefined && input.registeredTons !== null && !(input.registeredTons > 0)) throw new Error('Tải trọng đăng ký phải lớn hơn 0.');
}

export function createVessel(input: VesselInput, actor: AuditActor = {}): Row {
  validate(input);
  const timestamp = nowIso();
  const record = {
    id: uuid(), code: normalizeCode(input.code), name: input.name?.trim() || null, kind: input.kind,
    vessel_class: input.vesselClass ?? (input.kind === 'ghe' ? 'ghe_100t' : 'sa_lan_1000t'),
    owner_name: input.ownerName ?? null, owner_phone: input.ownerPhone ?? null,
    registered_tons: input.registeredTons ?? null, straw_payload_tons: input.strawPayloadTons ?? null,
    registration_expiry: input.registrationExpiry ?? null, rate_type: input.rateType ?? null, rate_vnd: input.rateVnd ?? null,
    status: 'hoat_dong', note: input.note ?? null, created_at: timestamp, updated_at: timestamp,
  };
  insert('vessels', record);
  logEvent({ module: 'tms', entityType: 'vessels', entityId: record.id, action: 'create', after: record }, actor);
  return vesselDetail(record.id);
}

export function updateVessel(id: string, patch: Partial<VesselInput> & { status?: 'hoat_dong' | 'ngung' }, actor: AuditActor = {}): Row {
  const before = one<Row & { code: string; kind: 'ghe' | 'sa_lan' }>('SELECT * FROM vessels WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy ghe trong danh mục.');
  validate({ ...(before as unknown as VesselInput), ...patch, code: patch.code ?? before.code, kind: patch.kind ?? before.kind }, id);
  const map: Record<string, string> = {
    code: 'code', name: 'name', kind: 'kind', vesselClass: 'vessel_class', ownerName: 'owner_name', ownerPhone: 'owner_phone',
    registeredTons: 'registered_tons', strawPayloadTons: 'straw_payload_tons', registrationExpiry: 'registration_expiry',
    rateType: 'rate_type', rateVnd: 'rate_vnd', note: 'note', status: 'status',
  };
  const values: Row = { updated_at: nowIso() };
  for (const [key, col] of Object.entries(map)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v !== undefined) values[col] = key === 'code' ? normalizeCode(String(v)) : (v === '' ? null : v);
  }
  if (values.status && !['hoat_dong', 'ngung'].includes(String(values.status))) throw new Error('Trạng thái không hợp lệ.');
  update('vessels', id, values);
  logEvent({ module: 'tms', entityType: 'vessels', entityId: id, action: 'update', before, after: values }, actor);
  return vesselDetail(id);
}

export function vesselByCode(code: string): (Row & { id: string; code: string; kind: string; straw_payload_tons: number | null; registration_expiry: string | null; rate_type: string | null; rate_vnd: number | null; status: string }) | null {
  return one('SELECT * FROM vessels WHERE code = ?', [normalizeCode(code)]);
}

/** Trạng thái đăng kiểm — dùng cho cảnh báo GH-02 và quét định kỳ. */
export function expiryStatus(expiry: string | null | undefined): { state: 'het_han' | 'sap_het_han' | 'con_han' | 'khong_ro'; daysLeft: number | null } {
  if (!expiry) return { state: 'khong_ro', daysLeft: null };
  const days = Math.round((Date.parse(expiry) - Date.parse(today())) / 86_400_000);
  if (days < 0) return { state: 'het_han', daysLeft: days };
  if (days <= EXPIRY_WARNING_DAYS) return { state: 'sap_het_han', daysLeft: days };
  return { state: 'con_han', daysLeft: days };
}

/** Chi phí chuyến theo đơn giá thuê của ghe (GH-03); null khi ghe không có đơn giá. */
export function tripCostFor(vessel: { rate_type: string | null; rate_vnd: number | null } | null, tons: number, distanceKm: number): number | null {
  if (!vessel?.rate_type || !vessel.rate_vnd) return null;
  if (vessel.rate_type === 'per_ton') return Math.round(tons * vessel.rate_vnd);
  if (vessel.rate_type === 'per_trip') return Math.round(vessel.rate_vnd);
  return Math.round(tons * distanceKm * vessel.rate_vnd);
}

const SELECT = `
  SELECT v.*,
         (SELECT COUNT(*) FROM trips t WHERE t.vehicle_code = v.code) AS trips,
         (SELECT MAX(t.created_at) FROM trips t WHERE t.vehicle_code = v.code) AS last_trip_at,
         (SELECT COALESCE(SUM(l.tons), 0) FROM field_loadings l WHERE l.vessel_code = v.code) AS loaded_tons,
         (SELECT COALESCE(SUM(l.weighed_kg), 0) / 1000.0 FROM field_loadings l WHERE l.vessel_code = v.code) AS weighed_tons,
         (SELECT COALESCE(SUM(t.actual_cost), 0) FROM trips t WHERE t.vehicle_code = v.code AND t.status = 'hoan_thanh') AS actual_cost
  FROM vessels v`;

function decorate(row: Row): Row {
  const cls = VESSEL_CLASSES.find((c) => c.code === row.vessel_class);
  const exp = expiryStatus(row.registration_expiry as string | null);
  return {
    ...row,
    classLabel: cls?.label ?? row.vessel_class,
    rateLabel: row.rate_type ? `${Number(row.rate_vnd).toLocaleString('vi-VN')} ${RATE_TYPES[String(row.rate_type)]}` : 'Chưa có đơn giá',
    expiry: exp,
    kindLabel: row.kind === 'ghe' ? 'Ghe' : 'Sà lan',
  };
}

export function listVessels(filter: { status?: string } = {}): Row[] {
  const rows = filter.status
    ? all<Row>(`${SELECT} WHERE v.status = ? ORDER BY v.kind, v.code`, [filter.status])
    : all<Row>(`${SELECT} ORDER BY v.status = 'hoat_dong' DESC, v.kind, v.code`);
  return rows.map(decorate);
}

export function vesselDetail(id: string): Row {
  const row = one<Row>(`${SELECT} WHERE v.id = ?`, [id]);
  if (!row) throw new Error('Không tìm thấy ghe trong danh mục.');
  return decorate(row);
}

/** Ghe sắp hết / đã hết hạn đăng kiểm — đầu vào cho quét cảnh báo. */
export function vesselsNeedingAttention(): Row[] {
  return listVessels({ status: 'hoat_dong' }).filter((v) => ['het_han', 'sap_het_han'].includes((v.expiry as { state: string }).state));
}
