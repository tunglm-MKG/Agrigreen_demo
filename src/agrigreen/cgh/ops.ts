/**
 * Bản đồ số Cơ giới hoá — bổ sung theo Backlog User Story v4.0 (09/2026).
 *
 *   US-CFG-01/03/04  danh mục nền (ngừng sử dụng / kích hoạt lại, xoá khi chưa tham chiếu), ngưỡng cảnh báo
 *                    có ngày hiệu lực, lịch sử thay đổi từng giá trị
 *   US-OWN-01        vô hiệu hoá chủ sở hữu còn máy (kèm máy, giữ lịch sử)
 *   US-MAC-01/02/03  vô hiệu hoá / kích hoạt máy có Ngày vô hiệu hoá; nhập Excel/CSV 2 chế độ (Cập nhật /
 *                    Thay thế toàn bộ) đối chiếu theo SN/Số khung; truy vấn số máy tại thời điểm T (BR-09)
 *   US-MAP-02        panel chi tiết HTX + tra cứu nhanh HTX/xã/máy/chủ sở hữu
 *   US-ANL-01        cân đối theo tỉnh × khâu; LƯU kết quả theo vụ
 *   US-RPT-01/02     3 tab báo cáo (tổng hợp khu vực / thiếu hụt HTX / đối chiếu 2 vụ) từ số đã lưu
 *   US-DASH-01       4 thẻ chỉ số + HTX cần ưu tiên + khối vận hành (Admin)
 *   US-LOG-01        nhật ký hoạt động hệ thống (đăng nhập, tài khoản, từ chối truy cập) + lỗi đồng bộ
 */
import { all, insert, one, run, update, upsert, parseJson } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import {
  balanceSupplyDemand, classifyCoverage, coverageBands, coverageThresholds, createMachine, createMachineOwner,
  DEFAULT_COVERAGE_THRESHOLDS, OWNER_TYPES, type BalanceRow, type CoverageThresholds,
} from './service.ts';

// ---------------------------------------------------------------------------
// US-CFG-03 — ngưỡng cảnh báo có ngày hiệu lực (versioned)
// ---------------------------------------------------------------------------

export function listThresholdVersions(): CoverageThresholds[] {
  const row = one<{ value_json: string }>("SELECT value_json FROM system_config WHERE key = 'cgh.coverage_thresholds'");
  const versions = row ? parseJson<CoverageThresholds[]>(row.value_json, []) : [];
  return versions.length ? versions.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)) : [DEFAULT_COVERAGE_THRESHOLDS];
}

export function addThresholdVersion(input: CoverageThresholds, actor: AuditActor = {}): CoverageThresholds[] {
  const { du, canChuY, thua, effectiveFrom } = input;
  for (const [label, v] of [['Đủ', du], ['Cần chú ý', canChuY], ['Thừa', thua]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 300) throw new Error(`Mốc "${label}" phải là số trong khoảng 0–300 %.`);
  }
  if (!(canChuY < du && du < thua)) throw new Error('Các mốc % phải tăng dần: Cần chú ý < Đủ < Thừa (không chồng/hở khoảng phân loại).');
  if (!effectiveFrom) throw new Error('Vui lòng nhập Ngày hiệu lực của bộ ngưỡng.');
  const versions = listThresholdVersions().filter((v) => v.effectiveFrom !== effectiveFrom);
  const next = [...versions, { du, canChuY, thua, effectiveFrom, documentRef: input.documentRef }].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  upsert('system_config', { key: 'cgh.coverage_thresholds', value_json: JSON.stringify(next), updated_at: nowIso(), updated_by: actor.name ?? null });
  logEvent({ module: 'cgh', entityType: 'system_config', entityId: 'cgh.coverage_thresholds', action: 'update', before: versions, after: next }, actor);
  return next;
}

// ---------------------------------------------------------------------------
// US-CFG-01 — danh mục nền: ngừng sử dụng / kích hoạt lại / xoá khi chưa tham chiếu
// ---------------------------------------------------------------------------

export function listMachineTypesAll(): Record<string, unknown>[] {
  return all(`SELECT mt.*, (SELECT COUNT(*) FROM machines m WHERE m.machine_type_id = mt.id) AS machine_count,
                     (SELECT COUNT(*) FROM productivity_norms n WHERE n.machine_type_id = mt.id AND n.active = 1) AS norm_count
              FROM machine_types mt ORDER BY mt.active DESC, mt.stage, mt.name`);
}

export function setMachineTypeActive(id: string, active: boolean, actor: AuditActor = {}): { affectedMachines: number } {
  const before = one<Record<string, unknown>>('SELECT * FROM machine_types WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy chủng loại máy.');
  const affected = one<{ n: number }>('SELECT COUNT(*) AS n FROM machines WHERE machine_type_id = ?', [id])?.n ?? 0;
  update('machine_types', id, { active: active ? 1 : 0 });
  logEvent({ module: 'cgh', entityType: 'machine_types', entityId: id, action: 'update', before, after: { active }, note: active ? 'reactivate' : `deactivate — ${affected} máy đang dùng, dữ liệu cũ giữ nguyên` }, actor);
  return { affectedMachines: affected };
}

export function deleteMachineType(id: string, actor: AuditActor = {}): void {
  const referenced = one<{ n: number }>('SELECT (SELECT COUNT(*) FROM machines WHERE machine_type_id = ?) + (SELECT COUNT(*) FROM productivity_norms WHERE machine_type_id = ?) AS n', [id, id])?.n ?? 0;
  if (referenced > 0) throw new Error(`Chủng loại đang được ${referenced} bản ghi tham chiếu — không xoá được, hãy chuyển sang "Ngừng sử dụng".`);
  const before = one<Record<string, unknown>>('SELECT * FROM machine_types WHERE id = ?', [id]);
  run('DELETE FROM machine_types WHERE id = ?', [id]);
  logEvent({ module: 'cgh', entityType: 'machine_types', entityId: id, action: 'delete', before }, actor);
}

export function closeNorm(id: string, effectiveTo: string, actor: AuditActor = {}): void {
  const before = one<{ effective_from: string }>('SELECT * FROM productivity_norms WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy định mức.');
  if (effectiveTo < before.effective_from) throw new Error('Ngày hiệu lực kết thúc phải sau ngày hiệu lực bắt đầu');
  update('productivity_norms', id, { effective_to: effectiveTo });
  logEvent({ module: 'cgh', entityType: 'productivity_norms', entityId: id, action: 'update', before, after: { effective_to: effectiveTo }, note: 'close_effectivity' }, actor);
}

export function allNorms(): Record<string, unknown>[] {
  return all(`SELECT pn.*, mt.code AS machine_code, mt.name AS machine_name,
                     CASE WHEN pn.effective_from <= date('now') AND (pn.effective_to IS NULL OR pn.effective_to >= date('now')) THEN 1 ELSE 0 END AS in_effect
              FROM productivity_norms pn JOIN machine_types mt ON mt.id = pn.machine_type_id WHERE pn.active = 1 ORDER BY mt.stage, mt.name, pn.effective_from DESC`);
}

/** US-CFG-04: lịch sử thay đổi của một nhóm danh mục/cấu hình, không ghi đè. */
export function configHistory(entityType: string, entityId?: string, limit = 200): Record<string, unknown>[] {
  return entityId
    ? all('SELECT * FROM event_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT ?', [entityType, entityId, limit])
    : all('SELECT * FROM event_log WHERE entity_type = ? ORDER BY id DESC LIMIT ?', [entityType, limit]);
}

// ---------------------------------------------------------------------------
// US-OWN-01 — chủ sở hữu
// ---------------------------------------------------------------------------

export function listOwners(filter: { htxId?: string; includeInactive?: boolean } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.htxId) { clauses.push('mo.htx_id = ?'); params.push(filter.htxId); }
  if (!filter.includeInactive) clauses.push("COALESCE(mo.status, 'active') = 'active'");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT mo.*, c.code AS htx_code, c.name AS htx_name,
                     (SELECT COUNT(*) FROM machines m WHERE m.owner_id = mo.id AND COALESCE(m.status,'active') = 'active') AS machine_count
              FROM machine_owners mo LEFT JOIN cooperatives c ON c.id = mo.htx_id ${where} ORDER BY mo.code`, params)
    .map((row) => ({ ...row, owner_type_label: OWNER_TYPES[(row as { owner_type: string }).owner_type] ?? (row as { owner_type: string }).owner_type }));
}

export function deactivateOwner(id: string, confirmWithMachines: boolean, actor: AuditActor = {}): { machinesDeactivated: number } {
  const owner = one<Record<string, unknown>>('SELECT * FROM machine_owners WHERE id = ?', [id]);
  if (!owner) throw new Error('Không tìm thấy chủ sở hữu.');
  const active = all<{ id: string }>("SELECT id FROM machines WHERE owner_id = ? AND COALESCE(status,'active') = 'active'", [id]);
  if (active.length && !confirmWithMachines) {
    const error = new Error(`Chủ sở hữu này còn ${active.length} máy đang hoạt động. Vui lòng chuyển chủ hoặc ngừng máy trước, hoặc xác nhận vô hiệu hóa kèm máy.`);
    (error as Error & { needsConfirm?: boolean; machines?: number }).needsConfirm = true;
    (error as Error & { machines?: number }).machines = active.length;
    throw error;
  }
  for (const m of active) deactivateMachine(m.id, nowIso().slice(0, 10), 'Vô hiệu hoá kèm chủ sở hữu', actor);
  update('machine_owners', id, { status: 'inactive', deactivated_at: nowIso() });
  logEvent({ module: 'cgh', entityType: 'machine_owners', entityId: id, action: 'delete', before: owner, after: { status: 'inactive', machines: active.length } }, actor);
  return { machinesDeactivated: active.length };
}

export function reactivateOwner(id: string, actor: AuditActor = {}): void {
  update('machine_owners', id, { status: 'active', deactivated_at: null });
  logEvent({ module: 'cgh', entityType: 'machine_owners', entityId: id, action: 'update', after: { status: 'active' } }, actor);
}

// ---------------------------------------------------------------------------
// US-MAC-01/03 — vòng đời máy & đếm máy theo thời điểm
// ---------------------------------------------------------------------------

export function deactivateMachine(id: string, deactivatedAt: string, reason: string | undefined, actor: AuditActor = {}): void {
  const before = one<{ owned_since: string | null; status: string }>('SELECT * FROM machines WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy máy.');
  if (before.owned_since && deactivatedAt < before.owned_since) throw new Error('Ngày vô hiệu hóa phải sau Ngày HTX sở hữu');
  update('machines', id, { status: 'inactive', deactivated_at: deactivatedAt });
  logEvent({ module: 'cgh', entityType: 'machines', entityId: id, action: 'delete', before, after: { status: 'inactive', deactivated_at: deactivatedAt }, note: reason ?? 'deactivate' }, actor);
}

export function reactivateMachine(id: string, actor: AuditActor = {}): void {
  const before = one<Record<string, unknown>>('SELECT * FROM machines WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy máy.');
  update('machines', id, { status: 'active', deactivated_at: null });
  logEvent({ module: 'cgh', entityType: 'machines', entityId: id, action: 'update', before, after: { status: 'active' }, note: 'reactivate' }, actor);
}

export function updateMachine(id: string, patch: Record<string, unknown>, actor: AuditActor = {}): Record<string, unknown> {
  const before = one<Record<string, unknown>>('SELECT * FROM machines WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy máy.');
  const values: Record<string, unknown> = {};
  for (const key of ['brand', 'model', 'year_made', 'capacity_ha_per_season', 'owner_id', 'htx_id', 'fuel', 'power_hp', 'owned_since', 'chassis_number', 'serial_number']) {
    if (patch[key] !== undefined) values[key] = patch[key];
  }
  if (values.serial_number && one('SELECT id FROM machines WHERE serial_number = ? AND id <> ?', [values.serial_number, id])) throw new Error('Số máy/SN này đã tồn tại trên hệ thống.');
  if (values.owned_since && String(values.owned_since) > nowIso().slice(0, 10)) throw new Error('Ngày HTX sở hữu không được sau ngày hiện tại');
  if (!Object.keys(values).length) return before;
  update('machines', id, values);
  const after = one<Record<string, unknown>>('SELECT * FROM machines WHERE id = ?', [id])!;
  logEvent({ module: 'cgh', entityType: 'machines', entityId: id, action: 'update', before, after }, actor);
  return after;
}

/** BR-09: số máy hoạt động của HTX tại thời điểm T = owned_since ≤ T và (chưa vô hiệu hoá hoặc deactivated_at > T). */
export function machineCountAt(htxId: string, at: string): { at: string; total: number; byStage: { stage: string; total: number; operational: number }[]; machines: Record<string, unknown>[] } {
  const machines = all(
    `SELECT m.id, m.code, m.brand, m.model, m.serial_number, m.condition, m.condition_source, m.owned_since, m.deactivated_at, mt.name AS machine_type_name, mt.stage
     FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id
     WHERE m.htx_id = ? AND COALESCE(m.owned_since, substr(m.created_at, 1, 10)) <= ? AND (m.deactivated_at IS NULL OR m.deactivated_at > ?)
     ORDER BY mt.stage, m.code`, [htxId, at, at]);
  const byStageMap = new Map<string, { stage: string; total: number; operational: number }>();
  for (const m of machines as { stage: string; condition: string }[]) {
    const entry = byStageMap.get(m.stage) ?? { stage: m.stage, total: 0, operational: 0 };
    entry.total += 1; if (m.condition === 'hoat_dong') entry.operational += 1;
    byStageMap.set(m.stage, entry);
  }
  return { at, total: machines.length, byStage: [...byStageMap.values()], machines };
}

export function machineHistory(id: string): Record<string, unknown>[] {
  return all('SELECT * FROM event_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 200', ['machines', id]);
}

// ---------------------------------------------------------------------------
// US-MAC-02 — nhập máy hàng loạt: Cập nhật / Thay thế toàn bộ (upsert theo SN / Số khung — BR-10)
// ---------------------------------------------------------------------------

export interface MachineImportRow {
  htx?: string; machine_type?: string; brand?: string; model?: string; year_made?: number | string; fuel?: string; power_hp?: number | string;
  capacity?: number | string; owner?: string; serial_number?: string; chassis_number?: string; owned_since?: string; condition?: string;
}

const CONDITION_ALIASES: Record<string, string> = {
  'hoạt động': 'hoat_dong', hoat_dong: 'hoat_dong', 'bảo trì': 'bao_tri', bao_tri: 'bao_tri', 'hỏng': 'hong', hong: 'hong', 'ngừng hoạt động': 'ngung_hoat_dong', ngung_hoat_dong: 'ngung_hoat_dong',
};

export function importMachines(input: { htxId: string; mode: 'cap_nhat' | 'thay_the'; rows: MachineImportRow[] }, actor: AuditActor = {}): { created: number; updated: number; deactivated: number; errors: { row: number; reason: string }[] } {
  const result = { created: 0, updated: 0, deactivated: 0, errors: [] as { row: number; reason: string }[] };
  const seenKeys = new Map<string, number>();
  const touched = new Set<string>();
  input.rows.forEach((row, index) => {
    const line = index + 1;
    try {
      const sn = row.serial_number ? String(row.serial_number).trim() : '';
      const chassis = row.chassis_number ? String(row.chassis_number).trim() : '';
      const key = sn || chassis;
      if (!key) throw new Error('Thiếu Số máy/SN và Số khung');
      if (seenKeys.has(key)) throw new Error(`Số máy/SN trùng với dòng ${seenKeys.get(key)} trong cùng file`);
      seenKeys.set(key, line);
      const typeName = String(row.machine_type ?? '').trim();
      const type = one<{ id: string }>('SELECT id FROM machine_types WHERE active = 1 AND (code = ? OR name = ?)', [typeName, typeName]);
      if (!type) throw new Error(`Chủng loại "${typeName}" không khớp danh mục`);
      const ownerName = String(row.owner ?? '').trim();
      const owner = one<{ id: string }>("SELECT id FROM machine_owners WHERE (code = ? OR name = ?) AND COALESCE(status,'active') = 'active'", [ownerName, ownerName]);
      if (!owner) throw new Error(`Chủ sở hữu "${ownerName}" không tồn tại ở Hồ sơ chủ sở hữu`);
      const condition = CONDITION_ALIASES[String(row.condition ?? 'hoat_dong').trim().toLowerCase()];
      if (!condition) throw new Error(`Tình trạng "${row.condition}" không hợp lệ`);
      const existing = one<{ id: string; htx_id: string }>('SELECT id, htx_id FROM machines WHERE (serial_number = ? AND ? <> \'\') OR (chassis_number = ? AND ? <> \'\')', [sn, sn, chassis, chassis]);
      if (existing) {
        updateMachine(existing.id, {
          brand: row.brand ?? undefined, model: row.model ?? undefined, year_made: row.year_made ? Number(row.year_made) : undefined,
          fuel: row.fuel ?? undefined, power_hp: row.power_hp ? Number(row.power_hp) : undefined, owner_id: owner.id, htx_id: input.htxId,
          machine_type_id: undefined, owned_since: row.owned_since ?? undefined,
        }, actor);
        if (existing.htx_id !== input.htxId) update('machines', existing.id, { htx_id: input.htxId });
        run('UPDATE machines SET machine_type_id = ?, condition = ?, condition_updated_at = ?, status = \'active\', deactivated_at = NULL WHERE id = ?', [type.id, condition, nowIso(), existing.id]);
        touched.add(existing.id); result.updated += 1;
      } else {
        const created = createMachine({
          machineTypeId: type.id, ownerId: owner.id, htxId: input.htxId, brand: row.brand, model: row.model,
          serialNumber: sn || undefined, chassisNumber: chassis || undefined, yearMade: row.year_made ? Number(row.year_made) : undefined,
          capacityHaPerSeason: row.capacity ? Number(row.capacity) : undefined, condition, ownedSince: row.owned_since, fuel: row.fuel, powerHp: row.power_hp ? Number(row.power_hp) : undefined,
        }, actor);
        touched.add(String(created.id)); result.created += 1;
      }
    } catch (error) {
      result.errors.push({ row: line, reason: (error as Error).message });
    }
  });
  if (input.mode === 'thay_the') {
    const missing = all<{ id: string }>("SELECT id FROM machines WHERE htx_id = ? AND COALESCE(status,'active') = 'active'", [input.htxId]).filter((m) => !touched.has(m.id));
    for (const m of missing) { deactivateMachine(m.id, nowIso().slice(0, 10), 'Không còn trong file import (chế độ Thay thế toàn bộ)', actor); result.deactivated += 1; }
  }
  logEvent({ module: 'cgh', entityType: 'machines', action: 'create', after: { htxId: input.htxId, mode: input.mode, ...result, errors: result.errors.length }, note: 'bulk_import' }, actor);
  return result;
}

/** Đọc CSV/TSV dán từ Excel thành dòng theo tiêu đề (không phụ thuộc thư viện). */
export function parseDelimited(text: string): Record<string, string>[] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let quoted = false;
    for (const ch of line) {
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === delimiter && !quoted) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((line) => Object.fromEntries(split(line).map((v, i) => [headers[i] ?? `col_${i}`, v])));
}

// ---------------------------------------------------------------------------
// US-MAP-02 — panel HTX & tra cứu nhanh
// ---------------------------------------------------------------------------

export function htxDetail(htxId: string, at?: string): Record<string, unknown> {
  const htx = one<Record<string, unknown>>('SELECT c.*, a.name AS province_name FROM cooperatives c LEFT JOIN admin_units a ON a.id = c.province_id WHERE c.id = ?', [htxId]);
  if (!htx) throw new Error('Không tìm thấy HTX.');
  const snapshot = machineCountAt(htxId, at ?? nowIso().slice(0, 10));
  const balance = balanceSupplyDemand().rows.filter((r) => r.htxId === htxId);
  return { htx, machines: snapshot.machines, byStage: snapshot.byStage, total: snapshot.total, balance, at: snapshot.at };
}

export function quickSearch(q: string): { htx: Record<string, unknown>[]; communes: Record<string, unknown>[]; machines: Record<string, unknown>[]; owners: Record<string, unknown>[] } {
  const like = `%${q}%`;
  return {
    htx: all("SELECT id, code, name, lat, lng FROM cooperatives WHERE status = 'active' AND (name LIKE ? OR code LIKE ?) LIMIT 8", [like, like]),
    communes: all("SELECT id, code, name, centroid_lat AS lat, centroid_lng AS lng FROM admin_units WHERE level = 'commune' AND name LIKE ? LIMIT 8", [like]),
    machines: all(`SELECT m.id, m.code, m.serial_number, m.htx_id, c.name AS htx_name, c.lat, c.lng FROM machines m LEFT JOIN cooperatives c ON c.id = m.htx_id WHERE m.code LIKE ? OR m.serial_number LIKE ? LIMIT 8`, [like, like]),
    owners: all(`SELECT mo.id, mo.code, mo.name, mo.htx_id, c.lat, c.lng FROM machine_owners mo LEFT JOIN cooperatives c ON c.id = mo.htx_id WHERE mo.name LIKE ? OR mo.code LIKE ? LIMIT 8`, [like, like]),
  };
}

// ---------------------------------------------------------------------------
// US-ANL-01 / US-RPT-01/02 — cân đối theo tỉnh, lưu theo vụ, báo cáo từ số đã lưu
// ---------------------------------------------------------------------------

export function balanceByProvince(rows: BalanceRow[]): Record<string, unknown>[] {
  const map = new Map<string, { provinceId: string | null; provinceName: string; stage: string; areaHa: number; required: number; operational: number; htx: Set<string> }>();
  for (const r of rows) {
    const key = `${r.provinceId ?? '—'}|${r.stage}`;
    const entry = map.get(key) ?? { provinceId: r.provinceId, provinceName: r.provinceName ?? 'Chưa gán tỉnh', stage: r.stage, areaHa: 0, required: 0, operational: 0, htx: new Set<string>() };
    entry.areaHa += r.areaHa; entry.required += r.requiredMachines ?? 0; entry.operational += r.operationalMachines; entry.htx.add(r.htxId);
    map.set(key, entry);
  }
  return [...map.values()].map((e) => {
    const pct = e.required > 0 ? Math.round((e.operational / e.required) * 1000) / 10 : null;
    const level = classifyCoverage(pct);
    const band = coverageBands().find((b) => b.level === level)!;
    return { ...e, htxCount: e.htx.size, htx: undefined, coveragePct: pct, gap: e.operational - e.required, level, levelLabel: band.label, color: band.color };
  }).sort((a, b) => String(a.provinceName).localeCompare(String(b.provinceName)) || a.stage.localeCompare(b.stage));
}

export function saveBalanceSnapshot(seasonId: string, actor: AuditActor = {}): Record<string, unknown> {
  const season = one<{ id: string; name: string }>('SELECT id, name FROM seasons WHERE id = ?', [seasonId]);
  if (!season) throw new Error('Không tìm thấy vụ.');
  const balance = balanceSupplyDemand(seasonId);
  if (!balance.rows.length) throw new Error('Chưa đủ dữ liệu để cân đối cho vụ này (thiếu diện tích/lịch mùa vụ hoặc định mức).');
  const record = {
    id: uuid(), season_id: season.id, season_name: season.name, computed_at: nowIso(), computed_by: actor.name ?? null,
    summary_json: JSON.stringify({ ...balance.summary, thresholds: coverageThresholds() }),
    payload_json: JSON.stringify({ rows: balance.rows, byProvince: balanceByProvince(balance.rows) }),
  };
  insert('cgh_balance_snapshots', record);
  logEvent({ module: 'cgh', entityType: 'cgh_balance_snapshots', entityId: record.id, action: 'create', after: { seasonId, rows: balance.rows.length } }, actor);
  return { ...record, summary: JSON.parse(record.summary_json), payload_json: undefined };
}

export function listBalanceSnapshots(): Record<string, unknown>[] {
  return all('SELECT id, season_id, season_name, computed_at, computed_by, summary_json FROM cgh_balance_snapshots ORDER BY computed_at DESC')
    .map((r) => ({ ...r, summary: parseJson((r as { summary_json: string }).summary_json, {}), summary_json: undefined }));
}

function latestSnapshot(seasonId: string): { rows: BalanceRow[]; byProvince: Record<string, unknown>[]; computedAt: string } | null {
  const row = one<{ payload_json: string; computed_at: string }>('SELECT payload_json, computed_at FROM cgh_balance_snapshots WHERE season_id = ? ORDER BY computed_at DESC LIMIT 1', [seasonId]);
  if (!row) return null;
  const payload = parseJson<{ rows: BalanceRow[]; byProvince: Record<string, unknown>[] }>(row.payload_json, { rows: [], byProvince: [] });
  return { ...payload, computedAt: row.computed_at };
}

/** US-RPT-01: 3 tab báo cáo từ kết quả đã lưu; header có Ngày xuất & Vụ (BR-04). */
export function report(filter: { seasonId: string; provinceId?: string; stage?: string; level?: 'tinh' | 'xa' }): Record<string, unknown> {
  const snapshot = latestSnapshot(filter.seasonId);
  const season = one<{ name: string }>('SELECT name FROM seasons WHERE id = ?', [filter.seasonId]);
  if (!snapshot) return { exportedAt: nowIso(), season: season?.name ?? null, saved: false, summaryRows: [], shortageRows: [], notice: 'Vụ chưa có kết quả cân đối đã lưu — bấm "Lưu kết quả cân đối" ở màn Cân đối trước.' };
  let rows = snapshot.rows;
  if (filter.provinceId) rows = rows.filter((r) => r.provinceId === filter.provinceId);
  if (filter.stage) rows = rows.filter((r) => r.stage === filter.stage);
  const summaryRows = balanceByProvince(rows);
  const shortageRows = rows.filter((r) => r.level === 'thieu' || r.level === 'can_chu_y').map((r) => ({
    htxCode: r.htxCode, htxName: r.htxName, provinceName: r.provinceName, stage: r.stage, operational: r.operationalMachines,
    required: r.requiredMachines, shortage: Math.max(0, (r.requiredMachines ?? 0) - r.operationalMachines), coveragePct: r.coveragePct, areaSource: r.areaSource,
  })).sort((a, b) => (a.coveragePct ?? 0) - (b.coveragePct ?? 0));
  return { exportedAt: nowIso(), season: season?.name ?? null, computedAt: snapshot.computedAt, saved: true, filters: filter, summaryRows, shortageRows, thresholds: coverageThresholds() };
}

/** US-RPT-02: đối chiếu hai vụ (B − A) theo tỉnh × khâu; phần chỉ có ở một vụ đánh dấu riêng. */
export function compareSeasons(seasonA: string, seasonB: string): Record<string, unknown> {
  if (seasonA === seasonB) throw new Error('Vui lòng chọn hai vụ khác nhau để đối chiếu');
  const a = latestSnapshot(seasonA); const b = latestSnapshot(seasonB);
  const nameOf = (id: string) => one<{ name: string }>('SELECT name FROM seasons WHERE id = ?', [id])?.name ?? id;
  const key = (r: Record<string, unknown>) => `${r.provinceName}|${r.stage}`;
  const mapA = new Map((a?.byProvince ?? []).map((r) => [key(r), r]));
  const mapB = new Map((b?.byProvince ?? []).map((r) => [key(r), r]));
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows = [...keys].map((k) => {
    const ra = mapA.get(k) as Record<string, number | string> | undefined; const rb = mapB.get(k) as Record<string, number | string> | undefined;
    const [provinceName, stage] = k.split('|');
    const both = ra && rb;
    return {
      provinceName, stage,
      requiredA: ra?.required ?? null, operationalA: ra?.operational ?? null, coverageA: ra?.coveragePct ?? null,
      requiredB: rb?.required ?? null, operationalB: rb?.operational ?? null, coverageB: rb?.coveragePct ?? null,
      deltaOperational: both ? Number(rb!.operational) - Number(ra!.operational) : null,
      deltaCoverage: both && ra!.coveragePct !== null && rb!.coveragePct !== null ? Math.round((Number(rb!.coveragePct) - Number(ra!.coveragePct)) * 10) / 10 : null,
      presence: both ? 'ca_hai' : ra ? 'chi_vu_a' : 'chi_vu_b',
    };
  }).sort((x, y) => x.provinceName.localeCompare(y.provinceName) || x.stage.localeCompare(y.stage));
  return { seasonA: { id: seasonA, name: nameOf(seasonA), saved: Boolean(a), computedAt: a?.computedAt ?? null }, seasonB: { id: seasonB, name: nameOf(seasonB), saved: Boolean(b), computedAt: b?.computedAt ?? null }, rows, exportedAt: nowIso() };
}

// ---------------------------------------------------------------------------
// US-DASH-01 — dashboard: 4 thẻ, HTX cần ưu tiên, khối vận hành
// ---------------------------------------------------------------------------

export function dashboardV2(seasonId: string | undefined, isAdmin: boolean): Record<string, unknown> {
  const balance = balanceSupplyDemand(seasonId);
  const perHtx = new Map<string, { htxId: string; htxCode: string; htxName: string; provinceName: string | null; worst: BalanceRow }>();
  for (const r of balance.rows) {
    const cur = perHtx.get(r.htxId);
    if (!cur || (r.coveragePct ?? 999) < (cur.worst.coveragePct ?? 999)) perHtx.set(r.htxId, { htxId: r.htxId, htxCode: r.htxCode, htxName: r.htxName, provinceName: r.provinceName, worst: r });
  }
  const htxList = [...perHtx.values()];
  const totalMachines = one<{ n: number }>("SELECT COUNT(*) AS n FROM machines WHERE COALESCE(status,'active') = 'active'")?.n ?? 0;
  const totalHtx = one<{ n: number }>("SELECT COUNT(*) AS n FROM cooperatives WHERE status = 'active'")?.n ?? 0;
  const byStage = all(`SELECT mt.stage, COUNT(*) AS total, SUM(CASE WHEN m.condition = 'hoat_dong' THEN 1 ELSE 0 END) AS operational
                       FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id WHERE COALESCE(m.status,'active') = 'active' GROUP BY mt.stage`);
  const byProvince = all(`SELECT a.name AS province, COUNT(m.id) AS machines FROM machines m JOIN cooperatives c ON c.id = m.htx_id LEFT JOIN admin_units a ON a.id = c.province_id
                          WHERE COALESCE(m.status,'active') = 'active' GROUP BY a.id ORDER BY machines DESC`);
  const trend = listBalanceSnapshots().slice(0, 12).reverse().map((s) => ({ season: s.season_name, computedAt: s.computed_at, ...(s.summary as Record<string, unknown>) }));
  const ops = isAdmin ? {
    accounts: one('SELECT COUNT(*) AS total, SUM(CASE WHEN status = \'active\' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = \'locked\' THEN 1 ELSE 0 END) AS locked FROM users'),
    recentLogins: all("SELECT actor_name, occurred_at FROM event_log WHERE entity_type = 'login' ORDER BY id DESC LIMIT 5"),
    syncErrors: all("SELECT * FROM sync_log WHERE system = 'app_htx' AND status IN ('failed','dead_letter') ORDER BY started_at DESC LIMIT 5"),
    lastImport: one("SELECT occurred_at, after_json FROM event_log WHERE module = 'cgh' AND note = 'bulk_import' ORDER BY id DESC LIMIT 1"),
    syncBanner: (() => {
      const failures = all<{ started_at: string }>("SELECT started_at FROM sync_log WHERE system = 'app_htx' AND status IN ('failed','dead_letter') ORDER BY started_at DESC LIMIT 3");
      return failures.length >= 3 ? `Đồng bộ App HTX thất bại ${failures.length} lần liên tiếp lúc ${failures[0].started_at} — đang dùng dữ liệu nhập tay dự phòng` : null;
    })(),
  } : null;
  return {
    kpis: {
      totalMachines, totalHtx,
      htxSufficient: htxList.filter((h) => h.worst.level === 'du' || h.worst.level === 'thua').length,
      htxShort: htxList.filter((h) => h.worst.level === 'thieu' || h.worst.level === 'can_chu_y').length,
      htxNoData: htxList.filter((h) => h.worst.level === 'chua_co_du_lieu').length,
    },
    priority: htxList.filter((h) => h.worst.level === 'thieu' || h.worst.level === 'can_chu_y').sort((a, b) => (a.worst.coveragePct ?? 0) - (b.worst.coveragePct ?? 0)).slice(0, 12)
      .map((h) => ({ htxId: h.htxId, htxCode: h.htxCode, htxName: h.htxName, provinceName: h.provinceName, stage: h.worst.stage, coveragePct: h.worst.coveragePct, gap: h.worst.gap, color: h.worst.color, levelLabel: h.worst.levelLabel })),
    byStage, byProvince, trend, coverageBands: coverageBands(), thresholds: coverageThresholds(), summary: balance.summary, ops,
  };
}

// ---------------------------------------------------------------------------
// US-LOG-01 — nhật ký hoạt động hệ thống
// ---------------------------------------------------------------------------

export function activityLog(filter: { kind?: 'login' | 'account' | 'denied' | 'all'; from?: string; to?: string; limit?: number } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.kind === 'login') clauses.push("entity_type = 'login'");
  else if (filter.kind === 'account') clauses.push("module = 'admin' AND entity_type = 'users'");
  else if (filter.kind === 'denied') clauses.push("entity_type = 'access_denied'");
  else clauses.push("(entity_type IN ('login','access_denied') OR (module = 'admin' AND entity_type = 'users'))");
  if (filter.from) { clauses.push('occurred_at >= ?'); params.push(filter.from); }
  if (filter.to) { clauses.push('occurred_at <= ?'); params.push(`${filter.to}T23:59:59`); }
  if (filter.from && filter.to && (new Date(filter.to).getTime() - new Date(filter.from).getTime()) / 86_400_000 > 90) {
    throw new Error('Vui lòng chọn khoảng thời gian tối đa 90 ngày để đảm bảo hiệu năng tra cứu');
  }
  params.push(filter.limit ?? 200);
  return all(`SELECT * FROM event_log WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`, params);
}

export { createMachineOwner };
