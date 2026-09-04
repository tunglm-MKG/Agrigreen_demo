/**
 * Dịch vụ nghiệp vụ cho phân hệ Planning & Network Simulation.
 *
 * FN-02/FN-03 Hub ứng viên · FN-13 Dashboard · FN-14 So sánh kịch bản
 * FN-15 Khuyến nghị · FN-16 Xuất báo cáo · FN-18 Độ nhạy · FN-19 Kết xuất Hub
 */
import { all, insert, one, parseJson, run, transaction, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import {
  currentParameterSetVersion,
  listParameters,
  resolveParams,
  withOverride,
  type SimulationParams,
} from '../params/store.ts';
import { simulateScenario } from './engine.ts';
import type { ScenarioResult } from './types.ts';

// ---------------------------------------------------------------------------
// FN-02 / FN-03 — Hub ứng viên
// ---------------------------------------------------------------------------

export interface CandidateHub {
  id: string;
  code: string;
  name: string;
  description: string | null;
  lat: number;
  lng: number;
  province_id: string | null;
  status: string;
  created_at: string;
}

function nextCode(table: string, prefix: string): string {
  const row = one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return sequenceCode(prefix, (row?.n ?? 0) + 1, 4);
}

/**
 * FN-02 Luồng phụ: từ chối tạo Hub tại vị trí không có dữ liệu vùng nguyên liệu.
 * Ngưỡng: phải có ít nhất một HTX có toạ độ trong bán kính mặc định × 2.
 */
export function hasSupplyDataNear(lat: number, lng: number, radiusKm: number): boolean {
  const rows = all<{ lat: number; lng: number }>(
    'SELECT lat, lng FROM cooperatives WHERE lat IS NOT NULL AND lng IS NOT NULL',
  );
  const degrees = radiusKm / 111;
  return rows.some(
    (row) => Math.abs(row.lat - lat) <= degrees && Math.abs(row.lng - lng) <= degrees / Math.cos((lat * Math.PI) / 180),
  );
}

export function createCandidateHub(
  input: { name: string; description?: string; lat: number; lng: number; provinceId?: string },
  actor: AuditActor = {},
): CandidateHub {
  const params = resolveParams();
  if (!hasSupplyDataNear(input.lat, input.lng, params.defaultServiceRadiusKm * 2)) {
    throw new Error('Không có dữ liệu vùng nguyên liệu tại khu vực này — không thể tiếp tục mô phỏng.');
  }
  const duplicate = one<{ code: string; name: string }>(
    'SELECT code, name FROM candidate_hubs WHERE ABS(lat - ?) < 0.0005 AND ABS(lng - ?) < 0.0005',
    [input.lat, input.lng],
  );

  const hub = {
    id: uuid(),
    code: nextCode('candidate_hubs', 'HUB'),
    name: input.name,
    description: input.description ?? null,
    lat: input.lat,
    lng: input.lng,
    province_id: input.provinceId ?? null,
    status: 'nhap',
    created_by: actor.name ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('candidate_hubs', hub);
  logEvent(
    {
      module: 'simulation',
      entityType: 'candidate_hubs',
      entityId: hub.id,
      action: 'create',
      after: hub,
      note: duplicate ? `Trùng vị trí với Hub ${duplicate.code} — ${duplicate.name}` : undefined,
    },
    actor,
  );
  return getCandidateHub(hub.id)!;
}

export function getCandidateHub(id: string): CandidateHub | null {
  return one<CandidateHub>('SELECT * FROM candidate_hubs WHERE id = ?', [id]);
}

/** FN-03: danh sách Hub ứng viên đã lưu, kèm kịch bản đang thuộc về. */
export function listCandidateHubs(): (CandidateHub & { scenarios: string[] })[] {
  const hubs = all<CandidateHub>('SELECT * FROM candidate_hubs ORDER BY created_at DESC');
  return hubs.map((hub) => ({
    ...hub,
    scenarios: all<{ name: string }>(
      'SELECT s.name FROM scenario_hubs sh JOIN scenarios s ON s.id = sh.scenario_id WHERE sh.hub_id = ?',
      [hub.id],
    ).map((row) => row.name),
  }));
}

/**
 * FN-02 BR-04: chặn xoá Hub đang được dùng trong kịch bản ĐÃ MÔ PHỎNG, và liệt
 * kê các kịch bản đang tham chiếu (giữ toàn vẹn kết quả đã lưu — TECH-05).
 */
export function deleteCandidateHub(id: string, actor: AuditActor = {}): void {
  const referencing = all<{ code: string; name: string; simulated_at: string | null }>(
    `SELECT s.code, s.name, s.simulated_at FROM scenario_hubs sh
     JOIN scenarios s ON s.id = sh.scenario_id WHERE sh.hub_id = ?`,
    [id],
  );
  const simulated = referencing.filter((row) => row.simulated_at !== null);
  if (simulated.length) {
    throw new Error(
      `Không thể xoá: Hub đang được dùng trong ${simulated.length} kịch bản đã mô phỏng — ` +
      simulated.map((row) => `${row.code} (${row.name})`).join(', '),
    );
  }
  const before = getCandidateHub(id);
  transaction(() => {
    run('DELETE FROM scenario_hubs WHERE hub_id = ?', [id]);
    run('DELETE FROM candidate_hubs WHERE id = ?', [id]);
  });
  logEvent({ module: 'simulation', entityType: 'candidate_hubs', entityId: id, action: 'delete', before }, actor);
}

// ---------------------------------------------------------------------------
// Kịch bản đầu tư
// ---------------------------------------------------------------------------

export interface ScenarioRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  plant_id: string;
  parameter_set_version: number | null;
  lifecycle_years: number;
  discounted: number;
  status: string;
  baseline_mode: string;
  baseline_manual_cost_per_ton: number | null;
  baseline_scenario_id: string | null;
  simulated_at: string | null;
  created_at: string;
}

export function createScenario(
  input: { name: string; description?: string; plantId?: string; lifecycleYears?: number; discounted?: boolean },
  actor: AuditActor = {},
): ScenarioRecord {
  const params = resolveParams();
  const plantId =
    input.plantId ??
    one<{ id: string }>("SELECT id FROM facilities WHERE kind = 'plant' ORDER BY created_at LIMIT 1")?.id;
  if (!plantId) throw new Error('Chưa có nhà máy đầu ra trong danh mục.');

  const scenario = {
    id: uuid(),
    code: nextCode('scenarios', 'KB'),
    name: input.name,
    description: input.description ?? null,
    plant_id: plantId,
    parameter_set_version: null,
    lifecycle_years: input.lifecycleYears ?? params.lifecycleYears,
    discounted: input.discounted ? 1 : 0,
    status: 'tham_khao',
    baseline_mode: 'no_hub',
    baseline_manual_cost_per_ton: null,
    baseline_scenario_id: null,
    simulated_at: null,
    created_by: actor.name ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('scenarios', scenario);
  logEvent({ module: 'simulation', entityType: 'scenarios', entityId: scenario.id, action: 'create', after: scenario }, actor);
  return getScenario(scenario.id)!;
}

export function getScenario(id: string): ScenarioRecord | null {
  return one<ScenarioRecord>('SELECT * FROM scenarios WHERE id = ?', [id]);
}

export function listScenarios(): (ScenarioRecord & { hubCount: number })[] {
  return all<ScenarioRecord & { hubCount: number }>(
    `SELECT s.*, (SELECT COUNT(*) FROM scenario_hubs sh WHERE sh.scenario_id = s.id) AS hubCount
     FROM scenarios s ORDER BY s.created_at DESC`,
  );
}

export function updateScenario(id: string, patch: Record<string, unknown>, actor: AuditActor = {}): ScenarioRecord {
  const before = getScenario(id);
  if (!before) throw new Error('Không tìm thấy kịch bản');
  const allowed: Record<string, unknown> = { updated_at: nowIso() };
  for (const key of [
    'name', 'description', 'plant_id', 'lifecycle_years', 'discounted',
    'baseline_mode', 'baseline_manual_cost_per_ton', 'baseline_scenario_id',
  ]) {
    if (patch[key] !== undefined) allowed[key] = patch[key];
  }
  update('scenarios', id, allowed);
  const after = getScenario(id)!;
  logEvent({ module: 'simulation', entityType: 'scenarios', entityId: id, action: 'update', before, after }, actor);
  return after;
}

/** FN-02 BR-03: cấu hình riêng theo cặp Hub–Kịch bản. */
export function attachHub(
  scenarioId: string,
  hubId: string,
  config: {
    serviceRadiusKm?: number;
    /** Công suất Hub = TỒN KHO TỐI ĐA (tấn rơm đã băm/nén). */
    designCapacityTons?: number;
    /** Tải trọng sà lan chặng Hub → Nhà máy ngoài mùa thu hoạch (1.000 / 2.000 tấn). */
    bargePayloadTons?: number;
    modeFieldHub?: string;
    modeHubPlant?: string;
    landMode?: string;
  } = {},
  actor: AuditActor = {},
): void {
  const params = resolveParams();
  const existing = one<{
    id: string;
    service_radius_km: number;
    design_capacity_tons: number;
    barge_payload_tons: number | null;
    mode_field_hub: string;
    mode_hub_plant: string;
    land_mode: string;
  }>(
    `SELECT id, service_radius_km, design_capacity_tons, barge_payload_tons,
            mode_field_hub, mode_hub_plant, land_mode
     FROM scenario_hubs WHERE scenario_id = ? AND hub_id = ?`,
    [scenarioId, hubId],
  );
  // Màn hình cấu hình gửi lên ĐÚNG ô vừa sửa. Nếu thiếu trường nào mà lấy ngay
  // giá trị mặc định thì sửa tải trọng sà lan sẽ vô tình reset bán kính phục vụ
  // và sức chứa về mặc định. Vì vậy: ưu tiên giá trị gửi lên, rồi tới giá trị
  // đang lưu, cuối cùng mới tới mặc định của bộ tham số.
  const values = {
    service_radius_km:
      config.serviceRadiusKm ?? existing?.service_radius_km ?? params.defaultServiceRadiusKm,
    design_capacity_tons:
      config.designCapacityTons ?? existing?.design_capacity_tons ?? params.defaultDesignCapacityTons,
    barge_payload_tons:
      config.bargePayloadTons ?? existing?.barge_payload_tons ?? params.bargeSmallPayloadTons,
    mode_field_hub: config.modeFieldHub ?? existing?.mode_field_hub ?? 'auto',
    mode_hub_plant: config.modeHubPlant ?? existing?.mode_hub_plant ?? 'auto',
    land_mode: config.landMode ?? existing?.land_mode ?? 'mua',
  };
  if (existing) {
    update('scenario_hubs', existing.id, values);
  } else {
    const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM scenario_hubs WHERE scenario_id = ?', [scenarioId]);
    insert('scenario_hubs', {
      id: uuid(),
      scenario_id: scenarioId,
      hub_id: hubId,
      ...values,
      sort_order: (count?.n ?? 0) + 1,
    });
  }
  logEvent(
    { module: 'simulation', entityType: 'scenario_hubs', entityId: `${scenarioId}:${hubId}`, action: existing ? 'update' : 'create', after: values },
    actor,
  );
}

export function detachHub(scenarioId: string, hubId: string, actor: AuditActor = {}): void {
  run('DELETE FROM scenario_hubs WHERE scenario_id = ? AND hub_id = ?', [scenarioId, hubId]);
  logEvent({ module: 'simulation', entityType: 'scenario_hubs', entityId: `${scenarioId}:${hubId}`, action: 'delete' }, actor);
}

export function listScenarioHubs(scenarioId: string): Record<string, unknown>[] {
  return all(
    `SELECT sh.*, h.code, h.name, h.lat, h.lng FROM scenario_hubs sh
     JOIN candidate_hubs h ON h.id = sh.hub_id WHERE sh.scenario_id = ? ORDER BY sh.sort_order`,
    [scenarioId],
  );
}

// ---------------------------------------------------------------------------
// Chạy & lưu mô phỏng
// ---------------------------------------------------------------------------

export function runSimulation(
  scenarioId: string,
  options: { refreshDistances?: boolean } = {},
  actor: AuditActor = {},
): ScenarioResult {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error('Không tìm thấy kịch bản');

  // FN-01 BR-03: kịch bản được gán phiên bản bộ tham số tại thời điểm mô phỏng;
  // kịch bản đã lưu giữ nguyên phiên bản cũ khi tính lại.
  const version = scenario.parameter_set_version ?? currentParameterSetVersion();
  const params = resolveParams(version);

  const result = simulateScenario(scenarioId, { params, refreshDistances: options.refreshDistances });

  transaction(() => {
    insert('simulation_results', {
      id: uuid(),
      scenario_id: scenarioId,
      parameter_set_version: version,
      computed_at: result.computedAt,
      payload_json: JSON.stringify(result),
    });
    update('scenarios', scenarioId, {
      parameter_set_version: version,
      simulated_at: result.computedAt,
      updated_at: nowIso(),
    });
    // Đánh dấu Hub đã mô phỏng (FN-03 trạng thái).
    for (const hub of result.hubs) {
      update('candidate_hubs', hub.hubId, { status: 'da_mo_phong', updated_at: nowIso() });
    }
    // Kết quả sensitivity cũ trở nên lỗi thời (FN-18 BR-03).
    run('UPDATE sensitivity_results SET stale = 1 WHERE scenario_id = ?', [scenarioId]);
  });

  logEvent(
    {
      module: 'simulation',
      entityType: 'scenarios',
      entityId: scenarioId,
      action: 'simulate',
      after: {
        parameterSetVersion: version,
        deliveredTons: result.deliveredTons,
        costPerTon: result.costs.costPerTon,
        tcoPerTon: result.financial.tcoPerTon,
      },
    },
    actor,
  );
  return result;
}

export function latestResult(scenarioId: string): ScenarioResult | null {
  const row = one<{ payload_json: string }>(
    'SELECT payload_json FROM simulation_results WHERE scenario_id = ? ORDER BY computed_at DESC LIMIT 1',
    [scenarioId],
  );
  return row ? (JSON.parse(row.payload_json) as ScenarioResult) : null;
}

/**
 * FN-01 BR-04: chỉ đánh dấu "Chính thức" khi mọi tham số giả định đã được phê duyệt.
 */
export function markOfficial(scenarioId: string, actor: AuditActor = {}): { status: string; missing: unknown[] } {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error('Không tìm thấy kịch bản');
  const params = resolveParams(scenario.parameter_set_version ?? undefined);
  if (params.unapproved.length) {
    throw new Error(
      'Không thể đánh dấu "Chính thức" — còn tham số giả định chưa phê duyệt: ' +
      params.unapproved.map((p) => `#${p.number} ${p.name}`).join('; '),
    );
  }
  update('scenarios', scenarioId, { status: 'chinh_thuc', updated_at: nowIso() });
  logEvent({ module: 'simulation', entityType: 'scenarios', entityId: scenarioId, action: 'approve', after: { status: 'chinh_thuc' } }, actor);
  return { status: 'chinh_thuc', missing: [] };
}

// ---------------------------------------------------------------------------
// FN-14 — So sánh nhiều kịch bản
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  scenarioId: string;
  code: string;
  name: string;
  status: string;
  parameterSetVersion: number;
  lifecycleYears: number;
  discounted: boolean;
  hubCount: number;
  deliveredTons: number;
  capex: number;
  opexYear1: number;
  collectionCost: number;
  transportationCost: number;
  warehouseCost: number;
  handlingCost: number;
  totalDeliveredLogisticsCost: number;
  costPerTon: number | null;
  tco: number;
  tcoPerTon: number | null;
  lifecycleCostPerTon: number | null;
  roiPct: number | null;
  paybackYears: number | null;
  paybackStatus: string;
  plantDemandCoveragePct: number;
  shortfallWarnings: number;
  isBaselineColumn?: boolean;
}

export interface ComparisonReport {
  rows: ComparisonRow[];
  /** BR-03: xếp hạng theo TCO per Ton tăng dần. */
  sortedBy: 'tcoPerTon';
  blocked: string | null;
  warnings: string[];
}

export function compareScenarios(scenarioIds: string[], includeBaseline = true): ComparisonReport {
  const warnings: string[] = [];
  if (scenarioIds.length > 6) {
    warnings.push('Chọn hơn 6 kịch bản làm bảng so sánh khó đọc — gợi ý thu hẹp lựa chọn.');
  }

  const results: ScenarioResult[] = [];
  for (const id of scenarioIds) {
    const result = latestResult(id);
    if (!result) {
      // BR-01: không so sánh kịch bản còn thiếu dữ liệu.
      const scenario = getScenario(id);
      warnings.push(`Kịch bản ${scenario?.code ?? id} chưa có kết quả mô phỏng — đã loại khỏi bảng so sánh.`);
      continue;
    }
    results.push(result);
  }

  // BR-02: chỉ so sánh kịch bản cùng vòng đời và cùng chế độ chiết khấu.
  const lifecycles = new Set(results.map((r) => r.financial.lifecycleYears));
  const discountModes = new Set(results.map((r) => r.financial.discounted));
  if (lifecycles.size > 1 || discountModes.size > 1) {
    return {
      rows: [],
      sortedBy: 'tcoPerTon',
      blocked:
        'Không thể so sánh: các kịch bản khác nhau về ' +
        [
          lifecycles.size > 1 ? `số năm vòng đời (${[...lifecycles].join(', ')})` : null,
          discountModes.size > 1 ? 'chế độ chiết khấu (có/không)' : null,
        ].filter(Boolean).join(' và ') + '.',
      warnings,
    };
  }

  // BR-04: cảnh báo khi các kịch bản dùng khác phiên bản bộ tham số.
  const versions = new Set(results.map((r) => r.parameterSetVersion));
  if (versions.size > 1) {
    warnings.push(
      `So sánh giữa các bộ tham số khác nhau (phiên bản ${[...versions].sort().join(', ')}). ` +
      'Dùng hành động "Tính lại theo bộ tham số hiện tại" cho từng kịch bản để so sánh công bằng.',
    );
  }

  const rows: ComparisonRow[] = results.map((result) => ({
    scenarioId: result.scenarioId,
    code: result.scenarioCode,
    name: result.scenarioName,
    status: result.status,
    parameterSetVersion: result.parameterSetVersion,
    lifecycleYears: result.financial.lifecycleYears,
    discounted: result.financial.discounted,
    hubCount: result.hubCount,
    deliveredTons: result.deliveredTons,
    capex: result.capex.total,
    opexYear1: result.opex.total,
    collectionCost: result.costs.collectionCost,
    transportationCost: result.costs.transportationCost,
    warehouseCost: result.costs.warehouseCost,
    handlingCost: result.costs.handlingCost,
    totalDeliveredLogisticsCost: result.costs.totalDeliveredLogisticsCost,
    costPerTon: result.costs.costPerTon,
    tco: result.financial.tco,
    tcoPerTon: result.financial.tcoPerTon,
    lifecycleCostPerTon: result.financial.lifecycleCostPerTon,
    roiPct: result.financial.roiPct,
    paybackYears: result.financial.paybackYears,
    paybackStatus: result.financial.paybackStatus,
    plantDemandCoveragePct: result.plantDemandCoveragePct,
    shortfallWarnings: result.hubs.filter((h) => h.capacityWarning !== null).length,
  }));

  // AC-04: cột đối chứng No-Hub Baseline có CAPEX = 0.
  if (includeBaseline && results.length) {
    const reference = results[0];
    const baseline = reference.baseline;
    if (baseline.available) {
      const years = reference.financial.lifecycleYears;
      const lifetimeTons = baseline.deliveredTons * years;
      rows.push({
        scenarioId: 'no-hub-baseline',
        code: 'BASELINE',
        name: 'No-Hub Baseline (Ruộng → Nhà máy)',
        status: 'doi_chung',
        parameterSetVersion: reference.parameterSetVersion,
        lifecycleYears: years,
        discounted: reference.financial.discounted,
        hubCount: 0,
        deliveredTons: baseline.deliveredTons,
        capex: 0,
        opexYear1: 0,
        collectionCost: baseline.collectionCost,
        transportationCost: baseline.transportationCost,
        warehouseCost: 0,
        handlingCost: 0,
        totalDeliveredLogisticsCost: baseline.totalDeliveredLogisticsCost,
        costPerTon: baseline.baselineCostPerTon,
        // Theo đúng FN-12 BR-01, No-Hub không có CAPEX và không có OPEX Hub →
        // TCO = 0. Cột so sánh có ý nghĩa là "Chi phí vòng đời đầy đủ chuỗi/tấn".
        tco: 0,
        tcoPerTon: 0,
        lifecycleCostPerTon: baseline.baselineCostPerTon,
        roiPct: null,
        paybackYears: null,
        paybackStatus: 'thieu_baseline',
        plantDemandCoveragePct:
          reference.plant.annualDemandTons > 0
            ? Math.round((baseline.deliveredTons / reference.plant.annualDemandTons) * 10_000) / 100
            : 0,
        shortfallWarnings: 0,
        isBaselineColumn: true,
      });
    }
  }

  // BR-03: xếp hạng theo TCO per Ton tăng dần. Cột đối chứng No-Hub được ghim
  // cuối bảng vì TCO per Ton của nó luôn bằng 0 theo định nghĩa (xem cảnh báo).
  rows.sort((a, b) => {
    if (a.isBaselineColumn) return 1;
    if (b.isBaselineColumn) return -1;
    return (a.tcoPerTon ?? Infinity) - (b.tcoPerTon ?? Infinity);
  });
  if (rows.some((row) => row.isBaselineColumn)) {
    warnings.push(
      'Cột No-Hub Baseline có CAPEX = 0 và OPEX Hub = 0 nên TCO per Ton theo công thức FN-12 BR-01 ' +
      'bằng 0 và không so sánh được. Dùng cột "Chi phí vòng đời đầy đủ chuỗi / tấn" để đối chiếu ' +
      'phương án Hub với phương án không đầu tư Hub.',
    );
  }
  return { rows, sortedBy: 'tcoPerTon', blocked: null, warnings };
}

/**
 * FN-14 BR-04 — hành động "Tính lại theo bộ tham số hiện tại".
 * Gán kịch bản sang phiên bản bộ tham số mới nhất rồi mô phỏng lại, để bảng so
 * sánh giữa các kịch bản trở về cùng một bộ tham số.
 */
export function recalculateWithCurrentParams(scenarioId: string, actor: AuditActor = {}) {
  const version = currentParameterSetVersion();
  update('scenarios', scenarioId, { parameter_set_version: version, updated_at: nowIso() });
  logEvent(
    { module: 'simulation', entityType: 'scenarios', entityId: scenarioId, action: 'update', after: { parameterSetVersion: version }, note: 'recalculate_with_current_params' },
    actor,
  );
  return runSimulation(scenarioId, {}, actor);
}

// ---------------------------------------------------------------------------
// FN-15 — Khuyến nghị đầu tư
// ---------------------------------------------------------------------------

export interface Recommendation {
  available: boolean;
  verdict: 'nen_dau_tu' | 'can_xem_xet_them' | 'khong_nen_dau_tu' | null;
  label: string;
  reasons: string[];
  thresholds: { minRoiPct: number | null; maxPaybackYears: number | null };
  ranking: { code: string; name: string; tcoPerTon: number | null }[];
}

export function recommend(scenarioId: string): Recommendation {
  const result = latestResult(scenarioId);
  if (!result) throw new Error('Kịch bản chưa có kết quả mô phỏng');
  const params = resolveParams(result.parameterSetVersion);
  const thresholds = { minRoiPct: params.minRoiPct, maxPaybackYears: params.maxPaybackYears };
  const ranking = compareScenarios(listScenarios().map((s) => s.id), false).rows.map((row) => ({
    code: row.code,
    name: row.name,
    tcoPerTon: row.tcoPerTon,
  }));

  // BR-03: chưa có ngưỡng → KHÔNG sinh kết luận, chỉ hiển thị thứ hạng theo TCO/Ton.
  if (thresholds.minRoiPct === null || thresholds.maxPaybackYears === null) {
    return {
      available: false,
      verdict: null,
      label: 'Chưa có ngưỡng khuyến nghị',
      reasons: [
        'Ngưỡng ROI tối thiểu (#48) và/hoặc Payback Period tối đa (#49) chưa được Ban lãnh đạo chốt (AS-14, RS-08).',
        'Hệ thống chỉ hiển thị bảng KPI và thứ hạng theo TCO per Ton — không tự suy ra ngưỡng.',
      ],
      thresholds,
      ranking,
    };
  }

  // Luồng phụ: kịch bản ở trạng thái "Tham khảo" thì không sinh khuyến nghị.
  if (result.status !== 'chinh_thuc') {
    return {
      available: false,
      verdict: null,
      label: 'Kịch bản đang ở trạng thái Tham khảo',
      reasons: ['Chỉ kịch bản "Chính thức" (mọi tham số giả định đã phê duyệt) mới sinh khuyến nghị đầu tư.'],
      thresholds,
      ranking,
    };
  }

  const reasons: string[] = [];
  const hasShortfall =
    result.hubs.some((h) => h.capacityWarning !== null) || result.plantDemandWarning !== null;
  const roi = result.financial.roiPct;
  const payback = result.financial.paybackYears;

  let verdict: Recommendation['verdict'];
  if (result.financial.paybackStatus === 'khong_hoan_von' || (roi !== null && roi < 0)) {
    verdict = 'khong_nen_dau_tu';
    reasons.push(
      result.financial.paybackStatus === 'khong_hoan_von'
        ? 'Chi phí/tấn của kịch bản không thấp hơn baseline — không hoàn vốn.'
        : `ROI âm (${roi}%).`,
    );
  } else if (roi !== null && roi >= thresholds.minRoiPct && payback !== null && payback <= thresholds.maxPaybackYears && !hasShortfall) {
    verdict = 'nen_dau_tu';
    reasons.push(
      `ROI ${roi}% ≥ ngưỡng ${thresholds.minRoiPct}%.`,
      `Payback ${payback} năm ≤ ngưỡng ${thresholds.maxPaybackYears} năm.`,
      `TCO per Ton ${result.financial.tcoPerTon?.toLocaleString('vi-VN')} đ/tấn.`,
    );
  } else {
    verdict = 'can_xem_xet_them';
    if (hasShortfall) reasons.push('Có cảnh báo thiếu hụt nguyên liệu ở cấp Hub hoặc cấp nhà máy — khuyến nghị không vượt quá "Cần xem xét thêm".');
    if (roi !== null && roi < thresholds.minRoiPct) reasons.push(`ROI ${roi}% thấp hơn ngưỡng ${thresholds.minRoiPct}%.`);
    if (payback !== null && payback > thresholds.maxPaybackYears) reasons.push(`Payback ${payback} năm vượt ngưỡng ${thresholds.maxPaybackYears} năm.`);
    if (payback === null) reasons.push('Không hoàn vốn trong vòng đời so sánh.');
  }

  reasons.push(`Áp dụng bộ tham số phiên bản ${result.parameterSetVersion}.`);

  return {
    available: true,
    verdict,
    label: VERDICT_LABEL[verdict],
    reasons,
    thresholds,
    ranking,
  };
}

const VERDICT_LABEL: Record<NonNullable<Recommendation['verdict']>, string> = {
  nen_dau_tu: 'Nên đầu tư',
  can_xem_xet_them: 'Cần xem xét thêm',
  khong_nen_dau_tu: 'Không nên đầu tư',
};

// ---------------------------------------------------------------------------
// FN-18 — Phân tích độ nhạy (one-at-a-time)
// ---------------------------------------------------------------------------

/** BR-01: nhóm tham số trọng yếu mặc định. */
export const DEFAULT_SENSITIVITY_CODES = [
  'straw_to_paddy_ratio', 'collectable_ratio', 'loss_ratio',
  'collection_labour_price', 'collection_consumable_price',
  'road_freight_rate', 'waterway_freight_rate', 'distance_correction',
  'peak_inventory_factor', 'capex_other', 'discount_rate_pct',
];

export interface SensitivityRow {
  code: string;
  number: number;
  name: string;
  min: number;
  base: number;
  max: number;
  tcoPerTon: { min: number | null; base: number | null; max: number | null };
  lifecycleCostPerTon: { min: number | null; base: number | null; max: number | null };
  costPerTon: { min: number | null; base: number | null; max: number | null };
  roiPct: { min: number | null; base: number | null; max: number | null };
  paybackYears: { min: number | null; base: number | null; max: number | null };
  /**
   * Biên độ ảnh hưởng tới CHI PHÍ VÒNG ĐỜI ĐẦY ĐỦ CHUỖI trên mỗi tấn.
   *
   * Không dùng TCO per Ton làm thước đo tornado: theo FN-12 BR-01, TCO chỉ gồm
   * CAPEX + OPEX Hub, nên các tham số đơn giá thu gom (#20, #21) và đơn giá vận
   * chuyển (#22, #23) — vốn nằm trong nhóm trọng yếu tại BR-01 — sẽ luôn cho
   * biên độ bằng 0 và biểu đồ tornado mất ý nghĩa.
   */
  swing: number;
}

export interface SensitivityReport {
  scenarioId: string;
  parameterSetVersion: number;
  computedAt: string;
  baseTcoPerTon: number | null;
  baseLifecycleCostPerTon: number | null;
  rows: SensitivityRow[];
  skipped: { code: string; name: string; reason: string }[];
  /** BR-04: cảnh báo khi biên độ vượt ngưỡng. */
  highSensitivity: boolean;
  swingPct: number;
  method: string;
}

const HIGH_SENSITIVITY_THRESHOLD_PCT = 20;

export function runSensitivity(scenarioId: string, codes = DEFAULT_SENSITIVITY_CODES, actor: AuditActor = {}): SensitivityReport {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error('Không tìm thấy kịch bản');
  const base = latestResult(scenarioId);
  if (!base) throw new Error('Kịch bản chưa có kết quả mô phỏng — chạy FN-13 trước.');

  const version = scenario.parameter_set_version ?? currentParameterSetVersion();
  const baseParams = resolveParams(version);
  const catalogue = new Map(listParameters().map((p) => [p.code, p]));

  const rows: SensitivityRow[] = [];
  const skipped: SensitivityReport['skipped'] = [];

  for (const code of codes) {
    const record = catalogue.get(code);
    if (!record) {
      skipped.push({ code, name: code, reason: 'Không có trong danh mục tham số' });
      continue;
    }
    if (record.value_min === null || record.value_max === null || record.value_base === null) {
      // BR: tham số chưa có min/max → loại khỏi phân tích và ghi rõ.
      skipped.push({ code, name: record.name, reason: 'Chưa khai báo giá trị min/max' });
      continue;
    }

    let low: ScenarioResult;
    let high: ScenarioResult;
    try {
      low = simulateScenario(scenarioId, { params: withOverride(baseParams, code, record.value_min) });
      high = simulateScenario(scenarioId, { params: withOverride(baseParams, code, record.value_max) });
    } catch (error) {
      skipped.push({ code, name: record.name, reason: (error as Error).message });
      continue;
    }

    const swing = Math.abs(
      (high.financial.lifecycleCostPerTon ?? 0) - (low.financial.lifecycleCostPerTon ?? 0),
    );
    rows.push({
      code,
      number: record.number,
      name: record.name,
      min: record.value_min,
      base: record.value_base,
      max: record.value_max,
      tcoPerTon: { min: low.financial.tcoPerTon, base: base.financial.tcoPerTon, max: high.financial.tcoPerTon },
      lifecycleCostPerTon: {
        min: low.financial.lifecycleCostPerTon,
        base: base.financial.lifecycleCostPerTon,
        max: high.financial.lifecycleCostPerTon,
      },
      costPerTon: { min: low.costs.costPerTon, base: base.costs.costPerTon, max: high.costs.costPerTon },
      roiPct: { min: low.financial.roiPct, base: base.financial.roiPct, max: high.financial.roiPct },
      paybackYears: { min: low.financial.paybackYears, base: base.financial.paybackYears, max: high.financial.paybackYears },
      swing: Math.round(swing),
    });
  }

  // AC-02: xếp hạng tornado theo biên độ ảnh hưởng giảm dần.
  rows.sort((a, b) => b.swing - a.swing);

  const baseTcoPerTon = base.financial.tcoPerTon;
  const baseLifecycle = base.financial.lifecycleCostPerTon;
  const maxSwing = rows.length ? rows[0].swing : 0;
  const swingPct = baseLifecycle ? (maxSwing / baseLifecycle) * 100 : 0;

  const report: SensitivityReport = {
    scenarioId,
    parameterSetVersion: version,
    computedAt: nowIso(),
    baseTcoPerTon,
    baseLifecycleCostPerTon: baseLifecycle,
    rows,
    skipped,
    highSensitivity: swingPct > HIGH_SENSITIVITY_THRESHOLD_PCT,
    swingPct: Math.round(swingPct * 100) / 100,
    method:
      'One-at-a-time (BR-02) — V1 KHÔNG chạy mô phỏng Monte Carlo. Biên độ xếp hạng tính trên ' +
      'Chi phí vòng đời đầy đủ chuỗi/tấn (CAPEX + Σ Total Delivered Logistics Cost), vì TCO per Ton ' +
      'theo FN-12 BR-01 không chứa Collection/Transportation Cost.',
  };

  insert('sensitivity_results', {
    id: uuid(),
    scenario_id: scenarioId,
    parameter_set_version: version,
    computed_at: report.computedAt,
    payload_json: JSON.stringify(report),
    stale: 0,
  });
  logEvent({ module: 'simulation', entityType: 'sensitivity_results', entityId: scenarioId, action: 'simulate', after: { rows: rows.length, swingPct: report.swingPct } }, actor);
  return report;
}

export function latestSensitivity(scenarioId: string): (SensitivityReport & { stale: boolean }) | null {
  const row = one<{ payload_json: string; stale: number }>(
    'SELECT payload_json, stale FROM sensitivity_results WHERE scenario_id = ? ORDER BY computed_at DESC LIMIT 1',
    [scenarioId],
  );
  if (!row) return null;
  return { ...(parseJson<SensitivityReport>(row.payload_json, {} as SensitivityReport)), stale: row.stale === 1 };
}

// ---------------------------------------------------------------------------
// FN-19 — Kết xuất Hub đã chọn sang Module Warehouse
// ---------------------------------------------------------------------------

export function exportHubToWarehouse(scenarioId: string, hubId: string, actor: AuditActor = {}): Record<string, unknown> {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error('Không tìm thấy kịch bản');
  if (scenario.status !== 'chinh_thuc') {
    throw new Error('Chỉ kết xuất được Hub thuộc kịch bản ở trạng thái "Chính thức".');
  }
  const result = latestResult(scenarioId);
  const hub = result?.hubs.find((h) => h.hubId === hubId);
  if (!hub) throw new Error('Hub không thuộc kết quả mô phỏng của kịch bản này');

  // BR-01: gói dữ liệu kết xuất tối thiểu.
  const payload = {
    hubCode: hub.code,
    hubName: hub.name,
    coordinates: { lat: hub.lat, lng: hub.lng },
    provinceId: hub.provinceName,
    serviceRadiusKm: hub.serviceRadiusKm,
    cooperatives: hub.cooperatives.map((c) => ({ code: c.code, name: c.name, lat: c.lat, lng: c.lng })),
    designSupplyBySeason: hub.seasons.map((s) => ({ season: s.seasonName, deliveredTons: s.deliveredTons })),
    warehouseCapacityTons: hub.sizing.warehouseCapacityTons,
    warehouseAreaM2: hub.sizing.warehouseAreaM2,
    yardAreaM2: hub.sizing.yardAreaM2,
    balePressCount: hub.sizing.balePressCount,
    forkliftCount: hub.sizing.forkliftCount,
    plannedStaffCount: resolveParams(result!.parameterSetVersion).staffCount,
    scenarioCode: scenario.code,
    parameterSetVersion: result!.parameterSetVersion,
  };

  // Tạo cơ sở vận hành trong danh mục multi-site (điểm nối Simulation → Warehouse).
  // Kết xuất lại cùng một Hub KHÔNG tạo cơ sở trùng — chỉ cập nhật thông số quy
  // mô và ghi thêm một bản ghi nhật ký kết xuất (BR-03).
  const facilityCode = `WH-${hub.code}`;
  const existing = one<{ id: string }>('SELECT id FROM facilities WHERE code = ?', [facilityCode]);
  if (existing) {
    transaction(() => {
      update('facilities', existing.id, {
        name: `${hub.name} (Hub vận hành)`,
        capacity_tons: hub.sizing.warehouseCapacityTons,
        origin_scenario_id: scenarioId,
        updated_at: nowIso(),
      });
      insert('hub_handovers', {
        id: uuid(),
        scenario_id: scenarioId,
        hub_id: hubId,
        facility_id: existing.id,
        payload_json: JSON.stringify(payload),
        exported_by: actor.name ?? null,
        exported_at: nowIso(),
      });
    });
    logEvent(
      { module: 'simulation', entityType: 'hub_handovers', entityId: hubId, action: 'export', after: payload, note: 'cap_nhat_co_so_da_co' },
      actor,
    );
    return { facilityId: existing.id, payload, reused: true };
  }

  const facilityId = uuid();
  transaction(() => {
    insert('facilities', {
      id: facilityId,
      code: facilityCode,
      name: `${hub.name} (Hub vận hành)`,
      kind: 'hub',
      lat: hub.lat,
      lng: hub.lng,
      province_id: hub.provinceName,
      capacity_tons: hub.sizing.warehouseCapacityTons,
      current_stock_tons: 0,
      annual_demand_tons: 0,
      status: 'active',
      origin_scenario_id: scenarioId,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    insert('hub_handovers', {
      id: uuid(),
      scenario_id: scenarioId,
      hub_id: hubId,
      facility_id: facilityId,
      payload_json: JSON.stringify(payload),
      exported_by: actor.name ?? null,
      exported_at: nowIso(),
    });
  });

  // BR-03: mọi lần kết xuất được ghi nhật ký.
  logEvent({ module: 'simulation', entityType: 'hub_handovers', entityId: hubId, action: 'export', after: payload }, actor);
  return { facilityId, payload, reused: false };
}

export function listHandovers(): Record<string, unknown>[] {
  return all('SELECT * FROM hub_handovers ORDER BY exported_at DESC');
}

export type { SimulationParams };
