/**
 * Hệ thống Bản đồ số Cơ giới hóa Nông nghiệp — BRD v1.3 (khách hàng: Cục KTHT & PTNT).
 *
 * FN-02 danh mục & định mức · FN-03/04/05 hồ sơ HTX/chủ sở hữu/máy
 * FN-06 lịch mùa vụ & diện tích · FN-07 tích hợp App HTX (QT-03)
 * FN-08 bản đồ & trực quan hoá · FN-09 cân đối & dự báo nhu cầu
 * FN-10 báo cáo · FN-11 dashboard
 *
 * QT-01: Số máy cần = Diện tích canh tác ÷ Định mức năng suất (ha/máy/vụ).
 * QT-02: Ngưỡng mức đáp ứng — Đủ ≥85% · Cần chú ý 60–<85% · Thiếu <60% · Thừa ≥120%.
 * QT-03: Ưu tiên nguồn App HTX; fallback nhập tay; bản ghi đã "khoá" giữ nguyên.
 */
import { all, insert, one, run, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { runSync } from '../../platform/sync/sync.ts';

// ---------------------------------------------------------------------------
// QT-02 — Ngưỡng cảnh báo cung–cầu
// ---------------------------------------------------------------------------

export type CoverageLevel = 'du' | 'can_chu_y' | 'thieu' | 'thua' | 'chua_co_du_lieu';

export const COVERAGE_BANDS: { level: CoverageLevel; label: string; color: string }[] = [
  { level: 'thieu', label: 'Thiếu (<60%)', color: '#A3372A' },
  { level: 'can_chu_y', label: 'Cần chú ý (60–<85%)', color: '#9C6414' },
  { level: 'du', label: 'Đủ (≥85%)', color: '#1F7A38' },
  { level: 'thua', label: 'Thừa (≥120%)', color: '#2A78D6' },
  { level: 'chua_co_du_lieu', label: 'Chưa có dữ liệu', color: '#9AA5A0' },
];

export function classifyCoverage(pct: number | null): CoverageLevel {
  if (pct === null || !Number.isFinite(pct)) return 'chua_co_du_lieu';
  if (pct >= 120) return 'thua';
  if (pct >= 85) return 'du';
  if (pct >= 60) return 'can_chu_y';
  return 'thieu';
}

// ---------------------------------------------------------------------------
// FN-02 — Danh mục chủng loại máy & định mức năng suất (có ngày hiệu lực)
// ---------------------------------------------------------------------------

export function listMachineTypes(): Record<string, unknown>[] {
  return all('SELECT * FROM machine_types WHERE active = 1 ORDER BY stage, name');
}

export function upsertMachineType(
  input: { code: string; name: string; stage: string },
  actor: AuditActor = {},
): void {
  const existing = one<{ id: string }>('SELECT id FROM machine_types WHERE code = ?', [input.code]);
  if (existing) {
    update('machine_types', existing.id, { name: input.name, stage: input.stage });
  } else {
    insert('machine_types', { id: uuid(), code: input.code, name: input.name, stage: input.stage, active: 1 });
  }
  logEvent({ module: 'cgh', entityType: 'machine_types', entityId: input.code, action: existing ? 'update' : 'create', after: input }, actor);
}

/**
 * Định mức năng suất do DCRD ban hành bằng văn bản; hệ thống KHÔNG tự sinh.
 * Khoá: Chủng loại × Khâu × Ngày hiệu lực.
 */
export function addProductivityNorm(
  input: { machineTypeId: string; stage: string; haPerMachineSeason: number; effectiveFrom: string; effectiveTo?: string; documentRef: string },
  actor: AuditActor = {},
): void {
  if (input.haPerMachineSeason <= 0) throw new Error('Định mức năng suất phải lớn hơn 0.');
  const record = {
    id: uuid(),
    machine_type_id: input.machineTypeId,
    stage: input.stage,
    ha_per_machine_season: input.haPerMachineSeason,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo ?? null,
    document_ref: input.documentRef,
    active: 1,
  };
  insert('productivity_norms', record);
  logEvent({ module: 'cgh', entityType: 'productivity_norms', entityId: record.id, action: 'create', after: record }, actor);
}

export function effectiveNorms(onDate = nowIso().slice(0, 10)): Record<string, unknown>[] {
  return all(
    `SELECT pn.*, mt.code AS machine_code, mt.name AS machine_name
     FROM productivity_norms pn JOIN machine_types mt ON mt.id = pn.machine_type_id
     WHERE pn.active = 1 AND pn.effective_from <= ?
       AND (pn.effective_to IS NULL OR pn.effective_to >= ?)
     ORDER BY mt.stage, mt.name`,
    [onDate, onDate],
  );
}

// ---------------------------------------------------------------------------
// FN-04 / FN-05 — Chủ sở hữu và hồ sơ máy (mã tự sinh)
// ---------------------------------------------------------------------------

export function createMachineOwner(
  input: { name: string; ownerType: string; htxId?: string; phone?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM machine_owners');
  const record = {
    id: uuid(),
    code: sequenceCode('CSH', (count?.n ?? 0) + 1, 5),
    name: input.name,
    owner_type: input.ownerType,
    htx_id: input.htxId ?? null,
    phone: input.phone ?? null,
    created_at: nowIso(),
  };
  insert('machine_owners', record);
  logEvent({ module: 'cgh', entityType: 'machine_owners', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function createMachine(
  input: {
    machineTypeId: string; ownerId: string; htxId?: string; brand?: string; model?: string;
    serialNumber?: string; chassisNumber?: string; yearMade?: number; capacityHaPerSeason?: number; condition?: string;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const type = one<{ id: string; stage: string }>('SELECT id, stage FROM machine_types WHERE id = ?', [input.machineTypeId]);
  if (!type) throw new Error('Chủng loại máy không có trong danh mục chuẩn.');
  if (input.serialNumber) {
    const duplicate = one('SELECT id FROM machines WHERE serial_number = ?', [input.serialNumber]);
    if (duplicate) throw new Error(`Số máy (SN) "${input.serialNumber}" đã tồn tại.`);
  }
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM machines');
  const record = {
    id: uuid(),
    code: sequenceCode('MAY', (count?.n ?? 0) + 1, 6),
    machine_type_id: input.machineTypeId,
    owner_id: input.ownerId,
    htx_id: input.htxId ?? one<{ htx_id: string }>('SELECT htx_id FROM machine_owners WHERE id = ?', [input.ownerId])?.htx_id ?? null,
    brand: input.brand ?? null,
    model: input.model ?? null,
    serial_number: input.serialNumber ?? null,
    chassis_number: input.chassisNumber ?? null,
    year_made: input.yearMade ?? null,
    capacity_ha_per_season: input.capacityHaPerSeason ?? 0,
    // Khâu sản xuất luôn SUY RA từ chủng loại, không nhập độc lập.
    condition: input.condition ?? 'hoat_dong',
    condition_source: 'nhap_tay',
    condition_locked: 0,
    condition_updated_at: nowIso(),
    created_at: nowIso(),
  };
  insert('machines', record);
  logEvent({ module: 'cgh', entityType: 'machines', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function listMachines(filter: { htxId?: string; stage?: string; condition?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.htxId) {
    clauses.push('m.htx_id = ?');
    params.push(filter.htxId);
  }
  if (filter.stage) {
    clauses.push('mt.stage = ?');
    params.push(filter.stage);
  }
  if (filter.condition) {
    clauses.push('m.condition = ?');
    params.push(filter.condition);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT m.*, mt.name AS machine_type_name, mt.stage, mo.name AS owner_name, mo.code AS owner_code,
            c.code AS htx_code, c.name AS htx_name
     FROM machines m
     JOIN machine_types mt ON mt.id = m.machine_type_id
     JOIN machine_owners mo ON mo.id = m.owner_id
     LEFT JOIN cooperatives c ON c.id = m.htx_id
     ${where} ORDER BY m.code`,
    params,
  );
}

/**
 * QT-03 — Cập nhật tình trạng máy theo quy tắc ưu tiên nguồn:
 *  (1) ưu tiên App HTX khi đồng bộ thành công;
 *  (2) fallback dữ liệu Admin nhập tay;
 *  (3) khi App HTX có lại dữ liệu hợp lệ → ưu tiên App HTX trở lại, TRỪ bản ghi đã "khoá";
 *  (4) cả hai nguồn đều không có → "Chưa có dữ liệu".
 */
export function applyConditionUpdate(
  machineId: string,
  condition: string,
  source: 'app_htx' | 'nhap_tay',
  actor: AuditActor = {},
): { applied: boolean; reason: string } {
  const machine = one<{ id: string; condition: string; condition_source: string; condition_locked: number }>(
    'SELECT id, condition, condition_source, condition_locked FROM machines WHERE id = ?',
    [machineId],
  );
  if (!machine) throw new Error('Không tìm thấy máy');
  if (source === 'app_htx' && machine.condition_locked === 1) {
    return { applied: false, reason: 'Bản ghi đã được Admin khoá — giữ nguyên giá trị nhập tay (QT-03 mục 3).' };
  }
  update('machines', machineId, {
    condition,
    condition_source: source,
    condition_updated_at: nowIso(),
  });
  logEvent({ module: 'cgh', entityType: 'machines', entityId: machineId, action: 'update', before: machine, after: { condition, source } }, actor);
  return { applied: true, reason: source === 'app_htx' ? 'Ưu tiên nguồn App HTX' : 'Admin nhập tay' };
}

export function lockMachineCondition(machineId: string, locked: boolean, actor: AuditActor = {}): void {
  update('machines', machineId, { condition_locked: locked ? 1 : 0 });
  logEvent({ module: 'cgh', entityType: 'machines', entityId: machineId, action: 'update', after: { locked } }, actor);
}

// ---------------------------------------------------------------------------
// FN-06 — Lịch mùa vụ & diện tích canh tác theo vụ
// ---------------------------------------------------------------------------

export function upsertCultivationPlan(
  input: { htxId: string; seasonId: string; areaHa: number; stageStart?: string; stageEnd?: string; source?: 'app_htx' | 'nhap_tay'; locked?: boolean },
  actor: AuditActor = {},
): { applied: boolean; reason: string } {
  const existing = one<{ id: string; source: string; locked: number }>(
    'SELECT id, source, locked FROM cultivation_plans WHERE htx_id = ? AND season_id = ?',
    [input.htxId, input.seasonId],
  );
  const source = input.source ?? 'nhap_tay';
  if (existing && existing.locked === 1 && source === 'app_htx') {
    return { applied: false, reason: 'Bản ghi đã khoá — không nhận đồng bộ từ App HTX (QT-03).' };
  }
  const record = {
    id: existing?.id ?? uuid(),
    htx_id: input.htxId,
    season_id: input.seasonId,
    area_ha: input.areaHa,
    stage_start: input.stageStart ?? null,
    stage_end: input.stageEnd ?? null,
    source,
    locked: input.locked ? 1 : (existing?.locked ?? 0),
    updated_at: nowIso(),
  };
  if (existing) run('DELETE FROM cultivation_plans WHERE id = ?', [existing.id]);
  insert('cultivation_plans', record);
  logEvent({ module: 'cgh', entityType: 'cultivation_plans', entityId: record.id, action: existing ? 'update' : 'create', after: record }, actor);
  return { applied: true, reason: `Nguồn ${source}` };
}

// ---------------------------------------------------------------------------
// FN-09 — Cân đối cung–cầu máy & dự báo
// ---------------------------------------------------------------------------

export interface BalanceRow {
  htxId: string;
  htxCode: string;
  htxName: string;
  lat: number | null;
  lng: number | null;
  seasonId: string;
  seasonName: string;
  stage: string;
  areaHa: number;
  areaSource: string;
  normHaPerMachine: number | null;
  normDocument: string | null;
  requiredMachines: number | null;
  availableMachines: number;
  operationalMachines: number;
  coveragePct: number | null;
  level: CoverageLevel;
  levelLabel: string;
  color: string;
  gap: number | null;
}

export function balanceSupplyDemand(seasonId?: string): { rows: BalanceRow[]; summary: Record<string, number> } {
  const norms = effectiveNorms();
  const normByStage = new Map<string, { value: number; document: string }>();
  for (const norm of norms) {
    const stage = String(norm.stage);
    const value = Number(norm.ha_per_machine_season);
    const current = normByStage.get(stage);
    // Nhiều chủng loại cùng khâu → dùng định mức bình quân của khâu.
    normByStage.set(stage, {
      value: current ? (current.value + value) / 2 : value,
      document: String(norm.document_ref ?? ''),
    });
  }

  const plans = all<{ htx_id: string; season_id: string; area_ha: number; source: string; code: string; name: string; lat: number | null; lng: number | null; season_name: string }>(
    `SELECT cp.htx_id, cp.season_id, cp.area_ha, cp.source, c.code, c.name, c.lat, c.lng, s.name AS season_name
     FROM cultivation_plans cp
     JOIN cooperatives c ON c.id = cp.htx_id
     JOIN seasons s ON s.id = cp.season_id
     ${seasonId ? 'WHERE cp.season_id = ?' : ''}
     ORDER BY c.code`,
    seasonId ? [seasonId] : [],
  );

  const machineCounts = all<{ htx_id: string; stage: string; total: number; operational: number }>(
    `SELECT m.htx_id, mt.stage, COUNT(*) AS total,
            SUM(CASE WHEN m.condition = 'hoat_dong' THEN 1 ELSE 0 END) AS operational
     FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id
     GROUP BY m.htx_id, mt.stage`,
  );
  const machineIndex = new Map<string, { total: number; operational: number }>();
  for (const row of machineCounts) {
    machineIndex.set(`${row.htx_id}|${row.stage}`, { total: row.total, operational: row.operational });
  }

  const stages = [...normByStage.keys()];
  const rows: BalanceRow[] = [];

  for (const plan of plans) {
    for (const stage of stages) {
      const norm = normByStage.get(stage)!;
      // QT-01: Số máy cần = Diện tích canh tác ÷ Định mức năng suất.
      const requiredMachines = norm.value > 0 ? Math.ceil(plan.area_ha / norm.value) : null;
      const counts = machineIndex.get(`${plan.htx_id}|${stage}`) ?? { total: 0, operational: 0 };
      // Chỉ máy "Hoạt động" tính vào năng lực đáp ứng.
      const coveragePct =
        requiredMachines && requiredMachines > 0 ? (counts.operational / requiredMachines) * 100 : null;
      const level = counts.total === 0 && plan.area_ha === 0 ? 'chua_co_du_lieu' : classifyCoverage(coveragePct);
      const band = COVERAGE_BANDS.find((b) => b.level === level)!;
      rows.push({
        htxId: plan.htx_id,
        htxCode: plan.code,
        htxName: plan.name,
        lat: plan.lat,
        lng: plan.lng,
        seasonId: plan.season_id,
        seasonName: plan.season_name,
        stage,
        areaHa: plan.area_ha,
        areaSource: plan.source,
        normHaPerMachine: norm.value,
        normDocument: norm.document,
        requiredMachines,
        availableMachines: counts.total,
        operationalMachines: counts.operational,
        coveragePct: coveragePct === null ? null : Math.round(coveragePct * 10) / 10,
        level,
        levelLabel: band.label,
        color: band.color,
        gap: requiredMachines === null ? null : counts.operational - requiredMachines,
      });
    }
  }

  const summary = {
    total: rows.length,
    thieu: rows.filter((r) => r.level === 'thieu').length,
    can_chu_y: rows.filter((r) => r.level === 'can_chu_y').length,
    du: rows.filter((r) => r.level === 'du').length,
    thua: rows.filter((r) => r.level === 'thua').length,
    chua_co_du_lieu: rows.filter((r) => r.level === 'chua_co_du_lieu').length,
    totalRequired: rows.reduce((acc, r) => acc + (r.requiredMachines ?? 0), 0),
    totalOperational: rows.reduce((acc, r) => acc + r.operationalMachines, 0),
  };
  return { rows, summary };
}

/** Dự báo nhu cầu vụ tiếp theo từ xu hướng diện tích các vụ đã lưu. */
export function forecastDemand(): Record<string, unknown>[] {
  const history = all<{ stage: string; season_name: string; sort_order: number; area_ha: number }>(
    `SELECT mt.stage, s.name AS season_name, s.sort_order, SUM(cp.area_ha) AS area_ha
     FROM cultivation_plans cp JOIN seasons s ON s.id = cp.season_id
     CROSS JOIN (SELECT DISTINCT stage FROM machine_types) mt
     GROUP BY mt.stage, s.id ORDER BY s.sort_order`,
  );
  const byStage = new Map<string, number[]>();
  for (const row of history) {
    const list = byStage.get(row.stage) ?? [];
    list.push(row.area_ha);
    byStage.set(row.stage, list);
  }
  const norms = effectiveNorms();
  return [...byStage.entries()].map(([stage, areas]) => {
    const avg = areas.reduce((a, b) => a + b, 0) / Math.max(areas.length, 1);
    // Xu hướng tuyến tính đơn giản từ chênh lệch vụ đầu–vụ cuối.
    const trend = areas.length > 1 ? (areas[areas.length - 1] - areas[0]) / (areas.length - 1) : 0;
    const projectedArea = Math.max(0, avg + trend);
    const norm = norms.find((n) => n.stage === stage);
    const normValue = norm ? Number(norm.ha_per_machine_season) : 0;
    return {
      stage,
      seasonsObserved: areas.length,
      avgAreaHa: Math.round(avg * 10) / 10,
      trendHaPerSeason: Math.round(trend * 10) / 10,
      projectedAreaHa: Math.round(projectedArea * 10) / 10,
      projectedMachines: normValue > 0 ? Math.ceil(projectedArea / normValue) : null,
      method: 'Xu hướng tuyến tính trên dữ liệu các vụ đã lưu (FN-09).',
    };
  });
}

/** FN-11 — Dashboard tổng quan cho Cục (/portal) và Admin (/admin). */
export function dashboard(seasonId?: string): Record<string, unknown> {
  const balance = balanceSupplyDemand(seasonId);
  const byCondition = all(
    `SELECT condition, COUNT(*) AS n FROM machines GROUP BY condition`,
  );
  const byStage = all(
    `SELECT mt.stage, COUNT(*) AS total,
            SUM(CASE WHEN m.condition = 'hoat_dong' THEN 1 ELSE 0 END) AS operational
     FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id GROUP BY mt.stage`,
  );
  const dataFreshness = all(
    `SELECT source, COUNT(*) AS n, MAX(updated_at) AS latest FROM cultivation_plans GROUP BY source`,
  );
  return {
    summary: balance.summary,
    byCondition,
    byStage,
    dataFreshness,
    coverageBands: COVERAGE_BANDS,
    criticalHtx: balance.rows.filter((r) => r.level === 'thieu').slice(0, 20),
    forecast: forecastDemand(),
  };
}

// ---------------------------------------------------------------------------
// FN-07 — Tích hợp App HTX (đồng bộ tình trạng máy, diện tích, lịch mùa vụ)
// ---------------------------------------------------------------------------

export function syncFromAppHtx(
  payload: {
    machineConditions?: { machineCode: string; condition: string }[];
    cultivation?: { htxCode: string; seasonCode: string; areaHa: number; stageStart?: string; stageEnd?: string }[];
  },
  actor: AuditActor = {},
) {
  return runSync({ system: 'app_htx', direction: 'inbound', dataset: 'cgh_operational', payload }, () => {
    let recordCount = 0;
    for (const item of payload.machineConditions ?? []) {
      const machine = one<{ id: string }>('SELECT id FROM machines WHERE code = ?', [item.machineCode]);
      if (!machine) continue;
      applyConditionUpdate(machine.id, item.condition, 'app_htx', actor);
      recordCount += 1;
    }
    for (const item of payload.cultivation ?? []) {
      const htx = one<{ id: string }>('SELECT id FROM cooperatives WHERE code = ?', [item.htxCode]);
      const season = one<{ id: string }>('SELECT id FROM seasons WHERE code = ?', [item.seasonCode]);
      if (!htx || !season) continue;
      upsertCultivationPlan(
        { htxId: htx.id, seasonId: season.id, areaHa: item.areaHa, stageStart: item.stageStart, stageEnd: item.stageEnd, source: 'app_htx' },
        actor,
      );
      recordCount += 1;
    }
    return { recordCount };
  });
}

/** FN-10 — Báo cáo tổng hợp / thiếu hụt, có nhãn nguồn dữ liệu. */
export function shortageReport(seasonId?: string): Record<string, unknown> {
  const { rows, summary } = balanceSupplyDemand(seasonId);
  const shortages = rows
    .filter((row) => row.level === 'thieu' || row.level === 'can_chu_y')
    .sort((a, b) => (a.coveragePct ?? 0) - (b.coveragePct ?? 0));
  return {
    generatedAt: nowIso(),
    summary,
    shortages,
    totalGap: shortages.reduce((acc, row) => acc + Math.min(0, row.gap ?? 0), 0),
    sourceLabels: {
      area: 'Nhãn nguồn diện tích: [App HTX] hoặc [Nhập tay] kèm thời điểm cập nhật (QT-03).',
      norm: 'Định mức năng suất do DCRD ban hành bằng văn bản (FN-02c).',
    },
  };
}
