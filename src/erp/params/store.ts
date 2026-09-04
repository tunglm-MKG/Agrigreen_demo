/**
 * FN-01 — Quản trị dữ liệu nền: lưu trữ 49 tham số, phê duyệt giả định và
 * quản lý phiên bản bộ tham số (Parameter Set).
 *
 * BR-01: mọi thay đổi ghi nhật ký (ai sửa, khi nào, giá trị cũ/mới).
 * BR-02: tham số nhóm "thị trường" phải có nguồn + ngày cập nhật; nhóm "giả định"
 *        phải có người phê duyệt trước khi dùng cho kịch bản chính thức.
 * BR-03: mỗi lần lưu tạo một phiên bản bộ tham số mới; kịch bản đã lưu giữ
 *        nguyên phiên bản tại thời điểm mô phỏng.
 * BR-04: kịch bản chỉ được đánh dấu "Chính thức" khi mọi tham số giả định mà nó
 *        sử dụng đã có người phê duyệt và ngày phê duyệt.
 */
import { all, insert, one, parseJson, transaction, update, upsert } from '../../platform/db/db.ts';
import { digest, nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { ALL_PARAMETERS, type Classification, type ParameterDefinition } from './catalog.ts';

export interface ParameterRecord {
  id: string;
  number: number;
  code: string;
  name: string;
  unit: string | null;
  group_name: string;
  classification: Classification;
  value_base: number | null;
  value_min: number | null;
  value_max: number | null;
  text_value: string | null;
  data_source: string | null;
  source_date: string | null;
  approved_by: string | null;
  approved_at: string | null;
  note: string | null;
  updated_at: string;
}

/** Nạp danh mục 49 tham số vào CSDL nếu chưa có (idempotent). */
export function seedParameters(): void {
  for (const definition of ALL_PARAMETERS) {
    const existing = one<{ id: string }>('SELECT id FROM parameters WHERE code = ?', [definition.code]);
    if (existing) continue;
    insertDefinition(definition);
  }
  if (!one('SELECT id FROM parameter_sets LIMIT 1')) {
    createParameterSet('Bộ tham số khởi tạo từ danh mục BRD v1.4', { name: 'system' });
  }
}

function insertDefinition(definition: ParameterDefinition): void {
  insert('parameters', {
    id: uuid(),
    number: definition.number,
    code: definition.code,
    name: definition.name,
    unit: definition.unit,
    group_name: definition.group,
    classification: definition.classification,
    value_base: definition.base,
    value_min: definition.min ?? null,
    value_max: definition.max ?? null,
    text_value: definition.textValue ? JSON.stringify(definition.textValue) : null,
    data_source: definition.source ?? definition.managedElsewhere ?? null,
    source_date: definition.source ? nowIso().slice(0, 10) : null,
    approved_by: null,
    approved_at: null,
    note: [definition.note, definition.assumption ? `Assumption: ${definition.assumption}` : null]
      .filter(Boolean)
      .join(' · ') || null,
    updated_at: nowIso(),
  });
}

export function listParameters(): ParameterRecord[] {
  return all<ParameterRecord>('SELECT * FROM parameters ORDER BY number');
}

export function getParameter(code: string): ParameterRecord | null {
  return one<ParameterRecord>('SELECT * FROM parameters WHERE code = ?', [code]);
}

export interface ParameterUpdate {
  valueBase?: number | null;
  valueMin?: number | null;
  valueMax?: number | null;
  textValue?: Record<string, unknown> | null;
  dataSource?: string;
  sourceDate?: string;
  note?: string;
}

/** Các tham số dạng đơn giá / định mức / tải trọng không được nhận giá trị ≤ 0 (AC-06). */
const POSITIVE_ONLY = new Set([
  'road_freight_rate', 'waterway_freight_rate', 'warehouse_build_price', 'yard_build_price',
  'equipment_price', 'warehouse_area_norm', 'yard_area_norm', 'bale_press_capacity',
  'forklift_capacity', 'truck_payload_tons', 'barge_payload_tons', 'road_speed_kmh',
  'waterway_speed_kmh', 'collection_labour_price', 'collection_consumable_price',
  'default_service_radius_km', 'default_design_capacity_tons', 'lifecycle_years',
  'straw_to_paddy_ratio', 'plant_annual_demand',
]);

export function updateParameter(code: string, patch: ParameterUpdate, actor: AuditActor = {}): ParameterRecord {
  const before = getParameter(code);
  if (!before) throw new Error(`Không tìm thấy tham số "${code}"`);

  if (patch.valueBase !== undefined && patch.valueBase !== null && POSITIVE_ONLY.has(code) && patch.valueBase <= 0) {
    // AC-06 (ca lỗi): từ chối lưu, không lưu một phần.
    throw new Error(`Tham số "${before.name}" phải lớn hơn 0 — hệ thống từ chối lưu.`);
  }
  if (
    patch.valueMin !== undefined && patch.valueMax !== undefined &&
    patch.valueMin !== null && patch.valueMax !== null && patch.valueMin > patch.valueMax
  ) {
    throw new Error('Giá trị min không được lớn hơn giá trị max.');
  }

  const values: Record<string, unknown> = { updated_at: nowIso() };
  if (patch.valueBase !== undefined) values.value_base = patch.valueBase;
  if (patch.valueMin !== undefined) values.value_min = patch.valueMin;
  if (patch.valueMax !== undefined) values.value_max = patch.valueMax;
  if (patch.textValue !== undefined) {
    values.text_value = patch.textValue ? JSON.stringify(patch.textValue) : null;
  }
  if (patch.dataSource !== undefined) values.data_source = patch.dataSource;
  if (patch.sourceDate !== undefined) values.source_date = patch.sourceDate;
  if (patch.note !== undefined) values.note = patch.note;

  // Sửa giá trị làm mất hiệu lực phê duyệt cũ — người phê duyệt phải duyệt lại.
  if (patch.valueBase !== undefined && patch.valueBase !== before.value_base) {
    values.approved_by = null;
    values.approved_at = null;
  }

  update('parameters', before.id, values);
  const after = getParameter(code)!;
  logEvent(
    { module: 'simulation', entityType: 'parameters', entityId: before.id, action: 'update', before, after },
    actor,
  );
  // BR-03: mỗi lần lưu thay đổi dữ liệu nền tạo một phiên bản bộ tham số mới.
  createParameterSet(`Cập nhật tham số #${before.number} ${before.name}`, actor);
  return after;
}

/** BR-02: ghi nhận người phê duyệt và ngày phê duyệt cho tham số giả định. */
export function approveParameter(code: string, approver: string, actor: AuditActor = {}): ParameterRecord {
  const before = getParameter(code);
  if (!before) throw new Error(`Không tìm thấy tham số "${code}"`);
  if (before.classification !== 'gia_dinh') {
    throw new Error('Chỉ tham số thuộc nhóm "Cần input giả định" mới cần phê duyệt.');
  }
  if (before.value_base === null) {
    throw new Error(`Tham số "${before.name}" chưa có giá trị — không thể phê duyệt.`);
  }
  // Duyệt lại đúng người đã duyệt trước đó không làm dữ liệu đổi, nên cũng
  // không được sinh phiên bản bộ tham số mới.
  if (before.approved_by === approver) return before;

  update('parameters', before.id, { approved_by: approver, approved_at: nowIso() });
  const after = getParameter(code)!;
  logEvent(
    { module: 'simulation', entityType: 'parameters', entityId: before.id, action: 'approve', before, after },
    actor,
  );
  // BR-03: phê duyệt cũng là một thay đổi dữ liệu nền → sinh phiên bản bộ tham
  // số mới. Nếu không, kịch bản đã gắn phiên bản cũ sẽ mãi đọc trạng thái
  // "chưa phê duyệt" từ snapshot cũ và không bao giờ chuyển sang "Chính thức".
  createParameterSet(`Phê duyệt tham số #${before.number} ${before.name} bởi ${approver}`, actor);
  return after;
}

/** Phê duyệt hàng loạt các tham số giả định — chỉ sinh MỘT phiên bản bộ tham số. */
export function approveAllAssumptions(approver: string, actor: AuditActor = {}): { approved: number; version: number } {
  const pending = unapprovedAssumptions();

  // BR-03 sinh phiên bản mới cho mỗi THAY ĐỔI dữ liệu nền. Khi không còn tham số
  // nào chưa duyệt thì lệnh này không thay đổi gì cả — sinh phiên bản rỗng chỉ
  // làm kịch bản đã lưu lệch phiên bản với bộ tham số hiện hành và kích hoạt
  // cảnh báo "so sánh giữa các bộ tham số khác nhau" của FN-14 BR-04 một cách
  // vô cớ. Gọi lặp lại (ví dụ mỗi lần chạy demo) sẽ đẩy số phiên bản lên mãi.
  if (!pending.length) {
    return { approved: 0, version: currentParameterSetVersion() };
  }

  for (const parameter of pending) {
    update('parameters', parameter.id, { approved_by: approver, approved_at: nowIso() });
    logEvent(
      { module: 'simulation', entityType: 'parameters', entityId: parameter.id, action: 'approve', after: { approver } },
      actor,
    );
  }
  const set = createParameterSet(`Phê duyệt ${pending.length} tham số giả định bởi ${approver}`, actor);
  return { approved: pending.length, version: set.version };
}

export interface ParameterSet {
  id: string;
  version: number;
  created_at: string;
  created_by: string | null;
  note: string | null;
  checksum: string;
}

export function createParameterSet(note: string, actor: AuditActor = {}): ParameterSet {
  return transaction(() => {
    const latest = one<{ version: number }>('SELECT MAX(version) AS version FROM parameter_sets');
    const version = (latest?.version ?? 0) + 1;
    const snapshot = listParameters();
    const record = {
      id: uuid(),
      version,
      created_at: nowIso(),
      created_by: actor.name ?? null,
      note,
      payload_json: JSON.stringify(snapshot),
      checksum: digest(snapshot),
    };
    insert('parameter_sets', record);
    return {
      id: record.id,
      version,
      created_at: record.created_at,
      created_by: record.created_by,
      note,
      checksum: record.checksum,
    };
  });
}

export function currentParameterSetVersion(): number {
  const row = one<{ version: number }>('SELECT MAX(version) AS version FROM parameter_sets');
  return row?.version ?? 0;
}

export function listParameterSets(): ParameterSet[] {
  return all<ParameterSet>(
    'SELECT id, version, created_at, created_by, note, checksum FROM parameter_sets ORDER BY version DESC',
  );
}

export function parameterSetSnapshot(version: number): ParameterRecord[] {
  const row = one<{ payload_json: string }>('SELECT payload_json FROM parameter_sets WHERE version = ?', [version]);
  return row ? parseJson<ParameterRecord[]>(row.payload_json, []) : [];
}

/**
 * BR-04: liệt kê các tham số giả định CÒN THIẾU phê duyệt.
 * Chỉ xét các tham số thực sự có giá trị cấu hình (bỏ qua các tham số trỏ về
 * master data khác như mạng lưới đường thủy).
 */
export function unapprovedAssumptions(records = listParameters()): ParameterRecord[] {
  return records.filter(
    (p) => p.classification === 'gia_dinh' && p.value_base !== null && !p.approved_by,
  );
}

/** Tham số giả định chưa có giá trị (ví dụ #48/#49 chưa được Ban lãnh đạo chốt). */
export function undefinedAssumptions(records = listParameters()): ParameterRecord[] {
  return records.filter((p) => p.classification === 'gia_dinh' && p.value_base === null && !p.data_source);
}

// ---------------------------------------------------------------------------
// Bộ tham số đã chuẩn hoá đơn vị, dùng trực tiếp bởi công cụ mô phỏng.
// Quy ước: tiền = VNĐ, khối lượng = tấn, khoảng cách = km, diện tích = m².
// ---------------------------------------------------------------------------

export interface SimulationParams {
  version: number;
  /** #10 */ correctionFactors: { road: number; waterway: number };
  /** #12 */ plantAnnualDemandTons: number;
  /** #13 */ defaultServiceRadiusKm: number;
  /** #14 */ defaultDesignCapacityTons: number;
  /** #15 */ distanceErrorThresholdPct: number;
  /** #17 */ strawToPaddyRatio: number;
  /** #18 */ collectableRatio: number;      // 0..1
  /** #19 */ lossRatio: number;             // 0..1
  /** #20 */ collectionLabourPricePerTon: number;
  /** #21 */ collectionConsumablePricePerTon: number;
  /** #22 */ roadFreightRatePerTonKm: number;
  /** #23 */ waterwayFreightRatePerTonKm: number;
  /** #24 */ warehouseBuildPricePerM2: number;   // VNĐ/m²
  /** #25 */ yardBuildPricePerM2: number;        // VNĐ/m²
  /** #26 */ balePressUnitPrice: number;         // VNĐ/máy
  /** #26 */ forkliftUnitPrice: number;          // VNĐ/máy
  /** #27 */ roadFeasibleDistanceKm: number;
  /** #28 */ landLeasePricePerM2Year: number;
  /** #29 */ warehouseAreaNormM2PerTon: number;
  /** #30 */ yardAreaNormM2PerTon: number;
  /** #31 */ balePressCapacityTonsYear: number;
  /** #32 */ forkliftCapacityTonsYear: number;
  /** #33 */ truckPayloadTons: number;
  /** #34 */ bargePayloadTons: number;
  /** #35 */ peakInventoryFactor: number;
  /** #36 */ roadSpeedKmh: number;
  /** #37 */ waterwaySpeedKmh: number;
  /** #38 */ handlingHoursPerTrip: number;
  /** #39 */ capexOther: number;                 // VNĐ
  /** #40 */ staffCount: number;
  /** #41 */ staffSalaryPerMonth: number;
  /** #42 */ utilityCostPerYear: number;
  /** #43 */ maintenanceRate: number;            // 0..1
  /** #44 */ discountRate: number;               // 0..1
  /** #45 */ opexEscalation: number;             // 0..1
  /** #46 */ rampUpRatio: number;                // 0..1
  /** #47 */ lifecycleYears: number;
  /** #48 */ minRoiPct: number | null;
  /** #49 */ maxPaybackYears: number | null;

  // ---- Nhóm mở rộng: mô hình dòng chảy rơm theo ngày ----
  /** #50 */ boatRegisteredTons: number;
  /** #51 */ boatStrawPayloadTons: number;
  /** #52 */ bargeSmallPayloadTons: number;
  /** #53 */ bargeLargePayloadTons: number;
  /** #54 */ plantOperatingDays: number;
  /** #55 */ hubProcessingCostPerTon: number;
  /** #56 */ hubProcessingLossRatio: number;
  /** #57 */ harvestWindowDays: number;
  /** Tham số giả định còn thiếu phê duyệt — dùng cho FN-01 BR-04. */
  unapproved: { code: string; number: number; name: string }[];
}

const MILLION = 1_000_000;

/**
 * Dựng bộ tham số đã chuẩn hoá.
 * `version` khác null → đọc từ snapshot của phiên bản đó (bảo đảm kịch bản đã
 * lưu vẫn tính lại được đúng bằng bộ tham số cũ — FN-01 BR-03, FN-14 BR-04).
 */
export function resolveParams(version?: number | null): SimulationParams {
  const records = version ? parameterSetSnapshot(version) : listParameters();
  if (!records.length) throw new Error('Chưa nạp danh mục tham số — hãy chạy seed trước.');
  const map = new Map(records.map((r) => [r.code, r]));

  const num = (code: string, fallback = 0): number => {
    const value = map.get(code)?.value_base;
    return value === null || value === undefined ? fallback : Number(value);
  };
  /**
   * Tham số được bổ sung SAU khi ảnh chụp bộ tham số này được tạo thì không có
   * giá trị trong ảnh chụp để mà giữ nguyên (BR-03 chỉ ràng buộc những tham số
   * đã tồn tại). Trường hợp đó lấy giá trị hiện hành trong danh mục thay vì
   * mặc định 0 — nếu để 0, một khoản chi phí thật sẽ âm thầm biến mất.
   */
  const numOrCatalog = (code: string): number => {
    const value = map.get(code)?.value_base;
    if (value !== null && value !== undefined) return Number(value);
    const current = one<{ value_base: number | null }>(
      'SELECT value_base FROM parameters WHERE code = ?',
      [code],
    );
    if (current?.value_base !== null && current?.value_base !== undefined) return Number(current.value_base);
    return ALL_PARAMETERS.find((definition) => definition.code === code)?.base ?? 0;
  };
  const text = (code: string): Record<string, number> => {
    const raw = map.get(code)?.text_value;
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  };
  const nullable = (code: string): number | null => {
    const value = map.get(code)?.value_base;
    return value === null || value === undefined ? null : Number(value);
  };

  const correction = text('distance_correction');
  const equipment = text('equipment_price');

  return {
    version: version ?? currentParameterSetVersion(),
    correctionFactors: {
      road: correction.road ?? num('distance_correction', 1.3),
      waterway: correction.waterway ?? num('distance_correction', 1.3),
    },
    plantAnnualDemandTons: num('plant_annual_demand'),
    defaultServiceRadiusKm: num('default_service_radius_km', 30),
    defaultDesignCapacityTons: num('default_design_capacity_tons', 60_000),
    distanceErrorThresholdPct: num('distance_error_threshold_pct', 10),
    strawToPaddyRatio: num('straw_to_paddy_ratio', 1),
    collectableRatio: num('collectable_ratio', 45) / 100,
    lossRatio: num('loss_ratio', 5) / 100,
    collectionLabourPricePerTon: num('collection_labour_price'),
    collectionConsumablePricePerTon: num('collection_consumable_price'),
    roadFreightRatePerTonKm: num('road_freight_rate'),
    waterwayFreightRatePerTonKm: num('waterway_freight_rate'),
    warehouseBuildPricePerM2: num('warehouse_build_price') * MILLION,
    yardBuildPricePerM2: num('yard_build_price') * MILLION,
    balePressUnitPrice: (equipment.balePress ?? num('equipment_price')) * MILLION,
    forkliftUnitPrice: (equipment.forklift ?? num('equipment_price')) * MILLION,
    roadFeasibleDistanceKm: num('road_feasible_distance_km', 120),
    landLeasePricePerM2Year: num('land_lease_price'),
    warehouseAreaNormM2PerTon: num('warehouse_area_norm', 0.85),
    yardAreaNormM2PerTon: num('yard_area_norm', 0.6),
    balePressCapacityTonsYear: num('bale_press_capacity', 18_000),
    forkliftCapacityTonsYear: num('forklift_capacity', 25_000),
    truckPayloadTons: num('truck_payload_tons', 15),
    bargePayloadTons: num('barge_payload_tons', 300),
    peakInventoryFactor: num('peak_inventory_factor', 0.3),
    roadSpeedKmh: num('road_speed_kmh', 40),
    waterwaySpeedKmh: num('waterway_speed_kmh', 12),
    handlingHoursPerTrip: num('handling_hours_per_trip', 3.5),
    capexOther: num('capex_other') * MILLION,
    staffCount: num('staff_count'),
    staffSalaryPerMonth: num('staff_salary_month'),
    utilityCostPerYear: num('utility_cost_year'),
    maintenanceRate: num('maintenance_rate_pct') / 100,
    discountRate: num('discount_rate_pct') / 100,
    opexEscalation: num('opex_escalation_pct') / 100,
    rampUpRatio: num('ramp_up_pct', 100) / 100,
    lifecycleYears: Math.max(1, Math.round(num('lifecycle_years', 10))),
    minRoiPct: nullable('min_roi_pct'),
    maxPaybackYears: nullable('max_payback_years'),
    boatRegisteredTons: numOrCatalog('boat_registered_tons'),
    boatStrawPayloadTons: numOrCatalog('boat_straw_payload_tons'),
    bargeSmallPayloadTons: numOrCatalog('barge_small_payload_tons'),
    bargeLargePayloadTons: numOrCatalog('barge_large_payload_tons'),
    plantOperatingDays: Math.max(1, Math.round(numOrCatalog('plant_operating_days'))),
    hubProcessingCostPerTon: numOrCatalog('hub_processing_cost'),
    hubProcessingLossRatio: numOrCatalog('hub_processing_loss_pct') / 100,
    harvestWindowDays: Math.max(1, Math.round(numOrCatalog('harvest_window_days'))),
    unapproved: unapprovedAssumptions(records).map((p) => ({
      code: p.code,
      number: p.number,
      name: p.name,
    })),
  };
}

/** Áp một giá trị ghi đè lên bộ tham số — dùng cho phân tích độ nhạy (FN-18). */
export function withOverride(
  params: SimulationParams,
  code: string,
  value: number,
): SimulationParams {
  const clone: SimulationParams = { ...params, correctionFactors: { ...params.correctionFactors } };
  switch (code) {
    case 'straw_to_paddy_ratio': clone.strawToPaddyRatio = value; break;
    case 'collectable_ratio': clone.collectableRatio = value / 100; break;
    case 'loss_ratio': clone.lossRatio = value / 100; break;
    case 'collection_labour_price': clone.collectionLabourPricePerTon = value; break;
    case 'collection_consumable_price': clone.collectionConsumablePricePerTon = value; break;
    case 'road_freight_rate': clone.roadFreightRatePerTonKm = value; break;
    case 'waterway_freight_rate': clone.waterwayFreightRatePerTonKm = value; break;
    case 'distance_correction':
      clone.correctionFactors = { road: value, waterway: value * 1.1 };
      break;
    case 'peak_inventory_factor': clone.peakInventoryFactor = value; break;
    case 'capex_other': clone.capexOther = value * MILLION; break;
    case 'discount_rate_pct': clone.discountRate = value / 100; break;
    case 'opex_escalation_pct': clone.opexEscalation = value / 100; break;
    case 'ramp_up_pct': clone.rampUpRatio = value / 100; break;
    case 'warehouse_build_price': clone.warehouseBuildPricePerM2 = value * MILLION; break;
    case 'yard_build_price': clone.yardBuildPricePerM2 = value * MILLION; break;
    case 'warehouse_area_norm': clone.warehouseAreaNormM2PerTon = value; break;
    case 'yard_area_norm': clone.yardAreaNormM2PerTon = value; break;
    case 'staff_count': clone.staffCount = value; break;
    case 'staff_salary_month': clone.staffSalaryPerMonth = value; break;
    case 'utility_cost_year': clone.utilityCostPerYear = value; break;
    case 'maintenance_rate_pct': clone.maintenanceRate = value / 100; break;
    case 'boat_straw_payload_tons': clone.boatStrawPayloadTons = value; break;
    case 'barge_small_payload_tons': clone.bargeSmallPayloadTons = value; break;
    case 'hub_processing_cost': clone.hubProcessingCostPerTon = value; break;
    case 'hub_processing_loss_pct': clone.hubProcessingLossRatio = value / 100; break;
    case 'harvest_window_days': clone.harvestWindowDays = Math.round(value); break;
    case 'plant_operating_days': clone.plantOperatingDays = Math.round(value); break;
    default:
      throw new Error(`Tham số "${code}" chưa được hỗ trợ trong phân tích độ nhạy.`);
  }
  return clone;
}
