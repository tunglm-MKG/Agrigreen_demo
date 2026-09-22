/**
 * Danh mục giống lúa dùng chung — App HTX US-CAT-01 / US-SEASON-01 / US-YIELD-03.
 *
 * Mở vụ chọn giống từ đây → hệ thống tự gán quy trình SOP mặc định của giống;
 * ngưỡng năng suất (tấn/ha) của từng giống dùng để cảnh báo sản lượng bất thường.
 * Giống đang được vụ mùa tham chiếu không xoá cứng — chỉ ẨN (US-CAT-01 AC-2).
 */
import { all, insert, one, run, update } from '../platform/db/db.ts';
import { nowIso, uuid } from '../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../platform/audit/audit.ts';

export interface RiceVariety {
  id: string;
  code: string;
  name: string;
  growth_days: number;
  yield_min_t_ha: number;
  yield_max_t_ha: number;
  default_protocol_id: string | null;
  status: string;
}

export const DEFAULT_VARIETIES: Omit<RiceVariety, 'id' | 'status' | 'default_protocol_id'>[] = [
  { code: 'OM5451', name: 'OM5451', growth_days: 95, yield_min_t_ha: 5, yield_max_t_ha: 8.5 },
  { code: 'OM18', name: 'OM18', growth_days: 97, yield_min_t_ha: 5, yield_max_t_ha: 8.5 },
  { code: 'DT8', name: 'Đài Thơm 8', growth_days: 100, yield_min_t_ha: 5, yield_max_t_ha: 8 },
  { code: 'ST25', name: 'ST25 (lúa đặc sản)', growth_days: 105, yield_min_t_ha: 4, yield_max_t_ha: 7 },
  { code: 'IR50404', name: 'IR50404', growth_days: 90, yield_min_t_ha: 5.5, yield_max_t_ha: 9 },
  { code: 'JASMINE85', name: 'Jasmine 85', growth_days: 100, yield_min_t_ha: 4.5, yield_max_t_ha: 7.5 },
];

export function listVarieties(includeHidden = false): RiceVariety[] {
  return all<RiceVariety>(
    `SELECT * FROM rice_varieties ${includeHidden ? '' : "WHERE status = 'active'"} ORDER BY name`,
  );
}

export function getVariety(id: string): RiceVariety | null {
  return one<RiceVariety>('SELECT * FROM rice_varieties WHERE id = ? OR code = ?', [id, id]);
}

export function upsertVariety(
  input: { id?: string; code: string; name: string; growthDays?: number; yieldMinTHa?: number; yieldMaxTHa?: number; defaultProtocolId?: string | null },
  actor: AuditActor = {},
): RiceVariety {
  if (!input.name?.trim()) throw new Error('Tên giống là trường bắt buộc.');
  if (input.growthDays !== undefined && !(input.growthDays > 0)) throw new Error('Thời gian sinh trưởng phải lớn hơn 0.');
  if (input.yieldMinTHa !== undefined && input.yieldMaxTHa !== undefined && input.yieldMinTHa > input.yieldMaxTHa) {
    throw new Error('Năng suất tối thiểu không được lớn hơn năng suất tối đa.');
  }
  const duplicate = one<{ id: string }>(
    'SELECT id FROM rice_varieties WHERE (name = ? OR code = ?) AND id <> ?', [input.name.trim(), input.code, input.id ?? ''],
  );
  if (duplicate) throw new Error('Tên đã tồn tại, vui lòng chọn tên khác');
  const before = input.id ? getVariety(input.id) : null;
  const record = {
    id: input.id ?? uuid(),
    code: input.code.trim().toUpperCase(),
    name: input.name.trim(),
    growth_days: input.growthDays ?? before?.growth_days ?? 95,
    yield_min_t_ha: input.yieldMinTHa ?? before?.yield_min_t_ha ?? 4,
    yield_max_t_ha: input.yieldMaxTHa ?? before?.yield_max_t_ha ?? 9,
    default_protocol_id: input.defaultProtocolId === undefined ? (before?.default_protocol_id ?? null) : input.defaultProtocolId,
    status: before?.status ?? 'active',
    updated_at: nowIso(),
  };
  if (before) update('rice_varieties', before.id, record);
  else insert('rice_varieties', { ...record, created_at: nowIso() });
  logEvent({ module: 'mdm', entityType: 'rice_varieties', entityId: record.id, action: before ? 'update' : 'create', before, after: record }, actor);
  return getVariety(record.id)!;
}

/** Ẩn thay vì xoá khi giống đang được vụ mùa tham chiếu (US-CAT-01 AC-2). */
export function removeVariety(id: string, actor: AuditActor = {}): { hidden: boolean; referenced: number } {
  const variety = getVariety(id);
  if (!variety) throw new Error('Không tìm thấy giống lúa.');
  const referenced = one<{ n: number }>('SELECT COUNT(*) AS n FROM crop_cycles WHERE variety_id = ? OR variety = ?', [variety.id, variety.name])?.n ?? 0;
  if (referenced > 0) {
    update('rice_varieties', variety.id, { status: 'hidden', updated_at: nowIso() });
    logEvent({ module: 'mdm', entityType: 'rice_varieties', entityId: variety.id, action: 'update', before: variety, after: { status: 'hidden' }, note: `${referenced} vụ đang tham chiếu — chỉ ẩn` }, actor);
    return { hidden: true, referenced };
  }
  run('DELETE FROM rice_varieties WHERE id = ?', [variety.id]);
  logEvent({ module: 'mdm', entityType: 'rice_varieties', entityId: variety.id, action: 'delete', before: variety }, actor);
  return { hidden: false, referenced: 0 };
}

export function restoreVariety(id: string, actor: AuditActor = {}): void {
  update('rice_varieties', id, { status: 'active', updated_at: nowIso() });
  logEvent({ module: 'mdm', entityType: 'rice_varieties', entityId: id, action: 'update', after: { status: 'active' } }, actor);
}

/** Nạp danh mục mặc định nếu bảng còn trống — gọi từ seed và lúc khởi động. */
export function seedVarietiesIfEmpty(): number {
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM rice_varieties')?.n ?? 0;
  if (count > 0) return 0;
  const protocol = one<{ id: string }>("SELECT id FROM production_protocols WHERE status = 'ban_hanh' ORDER BY created_at LIMIT 1");
  for (const v of DEFAULT_VARIETIES) {
    insert('rice_varieties', {
      id: uuid(), code: v.code, name: v.name, growth_days: v.growth_days,
      yield_min_t_ha: v.yield_min_t_ha, yield_max_t_ha: v.yield_max_t_ha,
      default_protocol_id: protocol?.id ?? null, status: 'active', created_at: nowIso(), updated_at: nowIso(),
    });
  }
  return DEFAULT_VARIETIES.length;
}

/** Nhập danh mục hàng loạt từ các dòng "code | name | growth_days | min | max" (US-CAT-02). */
export function importVarieties(rows: Record<string, unknown>[], actor: AuditActor = {}): { created: number; updated: number; errors: { row: number; reason: string }[] } {
  let created = 0; let updated = 0;
  const errors: { row: number; reason: string }[] = [];
  rows.forEach((row, index) => {
    try {
      const code = String(row.code ?? row.ma ?? '').trim();
      const name = String(row.name ?? row.ten ?? '').trim();
      if (!code || !name) throw new Error('Thiếu mã hoặc tên giống');
      const existing = one<{ id: string }>('SELECT id FROM rice_varieties WHERE code = ?', [code.toUpperCase()]);
      upsertVariety({
        id: existing?.id, code, name,
        growthDays: row.growth_days !== undefined ? Number(row.growth_days) : undefined,
        yieldMinTHa: row.yield_min !== undefined ? Number(row.yield_min) : undefined,
        yieldMaxTHa: row.yield_max !== undefined ? Number(row.yield_max) : undefined,
      }, actor);
      if (existing) updated += 1; else created += 1;
    } catch (error) {
      errors.push({ row: index + 1, reason: (error as Error).message });
    }
  });
  return { created, updated, errors };
}
