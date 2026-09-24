/**
 * CÔNG CỤ MÔ PHỎNG MẠNG LƯỚI & HOẠCH ĐỊNH CHI PHÍ
 * BRD Supply Chain Hub Simulation v1.4 — FN-04 → FN-12, FN-17.
 *
 * Chuỗi tính toán:
 *   FN-04 khoảng cách → FN-05 vùng phục vụ → FN-06 sản lượng theo mùa vụ
 *   → FN-07 Collection Cost → FN-08 Transportation Cost → FN-09 kho & thiết bị
 *   → FN-10 CAPEX/OPEX → FN-11 Total Delivered Logistics Cost & Cost/Ton
 *   → FN-12 TCO, TCO/Ton, ROI, Payback  (đối chứng: FN-17 No-Hub Baseline)
 */
import { all, one } from '../../platform/db/db.ts';
import { haversineKm, type LatLng } from '../../platform/geo/geo.ts';
import {
  DISTANCE_SOURCE_LABEL,
  DistanceService,
  type DistanceResult,
  type TransportMode,
} from '../../platform/geo/distance.ts';
import { digest, nowIso } from '../../platform/util/ids.ts';

/** Phiên bản thuật toán — đổi khi công thức chi phí/dòng chảy thay đổi để kết quả cũ không bị nhầm là tái lập được. */
export const ENGINE_VERSION = '2026.09.24';
import {
  buildHarvestCalendar,
  simulateFlow,
  type FlowHubResult,
  type FlowResult,
  type FlowSupplier,
} from './flow.ts';
import type { SimulationParams } from '../params/store.ts';
import type {
  CapexBreakdown,
  CostChain,
  EquipmentSizing,
  FinancialResult,
  HubResult,
  LegResult,
  NoHubBaseline,
  OpexBreakdown,
  ScenarioResult,
  SeasonSupply,
  ServedCooperative,
} from './types.ts';

/** Số giờ vận hành một phương tiện trong năm — hằng số ước lượng đội xe. */
const VEHICLE_HOURS_PER_YEAR = 3_000; // 300 ngày × 10 giờ
const MONTHS_PER_YEAR = 12;

interface HtxRow {
  id: string;
  code: string;
  name: string;
  lat: number | null;
  lng: number | null;
  member_count: number;
}

interface StatRow {
  htx_id: string;
  season_id: string;
  season_name: string;
  sort_order: number;
  paddy_tons: number;
  planted_area_ha: number;
}

interface ScenarioRow {
  id: string;
  code: string;
  name: string;
  plant_id: string;
  status: string;
  lifecycle_years: number;
  discounted: number;
  baseline_mode: string;
  baseline_manual_cost_per_ton: number | null;
  baseline_scenario_id: string | null;
}

interface ScenarioHubRow {
  id: string;
  hub_id: string;
  service_radius_km: number;
  design_capacity_tons: number;
  barge_payload_tons: number | null;
  mode_field_hub: string;
  mode_hub_plant: string;
  land_mode: string;
  sort_order: number;
  code: string;
  name: string;
  lat: number;
  lng: number;
  province_id: string | null;
}

interface PlantRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  annual_demand_tons: number;
}

export interface SimulateOptions {
  params: SimulationParams;
  /** Bỏ qua cache khoảng cách (Admin yêu cầu làm mới — FN-04 BR-05). */
  refreshDistances?: boolean;
  /** Bỏ qua tính No-Hub Baseline (dùng khi chạy sensitivity để tiết kiệm thời gian). */
  skipBaseline?: boolean;
}

export function simulateScenario(scenarioId: string, options: SimulateOptions): ScenarioResult {
  const { params } = options;
  const scenario = one<ScenarioRow>('SELECT * FROM scenarios WHERE id = ?', [scenarioId]);
  if (!scenario) throw new Error('Không tìm thấy kịch bản');

  const plant = one<PlantRow>(
    'SELECT id, name, lat, lng, annual_demand_tons FROM facilities WHERE id = ?',
    [scenario.plant_id],
  );
  if (!plant) throw new Error('Kịch bản chưa gán nhà máy đầu ra');

  const plantPoint: LatLng = { lat: plant.lat, lng: plant.lng };
  const annualDemand = plant.annual_demand_tons || params.plantAnnualDemandTons;

  const distances = new DistanceService({
    correctionFactors: params.correctionFactors,
    waterwayAccessRadiusKm: 8,
    minBargeLoadTons: params.bargePayloadTons,
    refresh: options.refreshDistances,
  });

  const scenarioHubs = all<ScenarioHubRow>(
    `SELECT sh.id, sh.hub_id, sh.service_radius_km, sh.design_capacity_tons,
            sh.mode_field_hub, sh.mode_hub_plant, sh.land_mode, sh.sort_order,
            h.code, h.name, h.lat, h.lng, h.province_id
     FROM scenario_hubs sh
     JOIN candidate_hubs h ON h.id = sh.hub_id
     WHERE sh.scenario_id = ?
     ORDER BY sh.sort_order, h.code`,
    [scenarioId],
  );

  const cooperatives = all<HtxRow>(
    "SELECT id, code, name, lat, lng, member_count FROM cooperatives WHERE status = 'active'",
  );
  const stats = all<StatRow>(
    `SELECT hs.htx_id, hs.season_id, s.name AS season_name, s.sort_order,
            hs.paddy_tons, hs.planted_area_ha
     FROM harvest_statistics hs JOIN seasons s ON s.id = hs.season_id`,
  );

  const statsByHtx = new Map<string, StatRow[]>();
  for (const row of stats) {
    const list = statsByHtx.get(row.htx_id);
    if (list) list.push(row);
    else statsByHtx.set(row.htx_id, [row]);
  }

  const warnings: string[] = [];
  const notes: string[] = [];

  // ---------------------------------------------------------------------
  // FN-05 — Xác định vùng nguyên liệu phục vụ, kèm quy tắc chống tính trùng.
  // BR-02: trong MỘT kịch bản, HTX nằm trong bán kính của nhiều Hub chỉ được
  // tính vào Hub GẦN NHẤT (theo khoảng cách FN-04).
  // ---------------------------------------------------------------------
  const assignment = new Map<string, { scenarioHubId: string; distanceKm: number }>();

  for (const hub of scenarioHubs) {
    if (hub.service_radius_km <= 0) {
      warnings.push(`${hub.name}: bán kính phục vụ = 0 — không có vùng nguyên liệu phù hợp.`);
      continue;
    }
    const hubPoint: LatLng = { lat: hub.lat, lng: hub.lng };
    for (const htx of cooperatives) {
      if (htx.lat === null || htx.lng === null) continue;
      const htxPoint: LatLng = { lat: htx.lat, lng: htx.lng };
      const radiusKm = haversineKm(hubPoint, htxPoint);
      if (radiusKm > hub.service_radius_km) continue;
      const routed = distances.distance(htxPoint, hubPoint, 'road').distanceKm;
      const current = assignment.get(htx.id);
      if (!current || routed < current.distanceKm) {
        assignment.set(htx.id, { scenarioHubId: hub.id, distanceKm: routed });
      }
    }
  }

  const hubResults: HubResult[] = [];
  const allServed: ServedCooperative[] = [];
  const servedByHub = new Map<string, ServedCooperative[]>();

  for (const hub of scenarioHubs) {
    const hubPoint: LatLng = { lat: hub.lat, lng: hub.lng };
    const members = cooperatives.filter((htx) => assignment.get(htx.id)?.scenarioHubId === hub.id);

    const served: ServedCooperative[] = members.map((htx) => {
      const htxPoint: LatLng = { lat: htx.lat!, lng: htx.lng! };
      const toHub = distances.distance(htxPoint, hubPoint, 'road');
      const toPlant = distances.distance(htxPoint, plantPoint, 'road');
      const seasons = buildSeasonSupply(statsByHtx.get(htx.id) ?? [], params);
      return {
        htxId: htx.id,
        code: htx.code,
        name: htx.name,
        lat: htx.lat!,
        lng: htx.lng!,
        radiusDistanceKm: round(haversineKm(hubPoint, htxPoint), 3),
        distanceToHubKm: toHub.distanceKm,
        distanceToHubSource: toHub.source,
        distanceToHubSourceLabel: toHub.sourceLabel,
        distanceToPlantKm: toPlant.distanceKm,
        distanceToPlantSource: toPlant.source,
        distanceToPlantSourceLabel: toPlant.sourceLabel,
        memberCount: htx.member_count ?? 0,
        plantedAreaHa: sum(seasons.map((s) => s.plantedAreaHa)),
        seasons,
        totalAvailableTons: sum(seasons.map((s) => s.totalAvailableTons)),
        collectableTons: sum(seasons.map((s) => s.collectableTons)),
        deliveredTons: sum(seasons.map((s) => s.deliveredTons)),
      };
    });
    allServed.push(...served);
    servedByHub.set(hub.id, served);
  }

  // ---------------------------------------------------------------------
  // MÔ PHỎNG LUỒNG RƠM THỰC TẾ THEO NGÀY (yêu cầu bổ sung ngoài BRD v1.4).
  //
  // Chạy TRƯỚC khi dựng kết quả từng Hub vì luồng rơm là bài toán cấp MẠNG
  // LƯỚI: trần "chở thẳng ruộng đến nhà máy" là lượng tiêu thụ trong ngày của
  // nhà máy, dùng chung cho mọi Hub, nên không thể tính độc lập từng Hub.
  // ---------------------------------------------------------------------
  const calendar = buildHarvestCalendar(params);
  const flowSuppliers: FlowSupplier[] = allServed.map((htx) => ({
    htxId: htx.htxId,
    code: htx.code,
    name: htx.name,
    hubKey: assignment.get(htx.htxId)?.scenarioHubId ?? null,
    distanceToHubKm: htx.distanceToHubKm,
    distanceToPlantKm: htx.distanceToPlantKm,
    seasonTons: htx.seasons.map((season) => ({
      seasonId: season.seasonId,
      collectableTons: season.collectableTons,
    })),
  }));
  const flow = simulateFlow({
    suppliers: flowSuppliers,
    hubs: scenarioHubs.map((hub) => ({
      key: hub.id,
      code: hub.code,
      name: hub.name,
      // Công suất Hub = TỒN KHO TỐI ĐA (tấn), theo định nghĩa nghiệp vụ mới.
      maxInventoryTons: hub.design_capacity_tons,
      distanceToPlantKm: distances.distance({ lat: hub.lat, lng: hub.lng }, plantPoint, 'road').distanceKm,
      bargePayloadTons: hub.barge_payload_tons ?? params.bargeSmallPayloadTons,
    })),
    plantAnnualDemandTons: annualDemand,
    params,
    calendar,
  });
  const flowByHub = new Map(flow.hubs.map((hub) => [hub.key, hub]));

  for (const hub of scenarioHubs) {
    const hubResult = buildHubResult(
      hub,
      servedByHub.get(hub.id) ?? [],
      plantPoint,
      distances,
      params,
      flowByHub.get(hub.id) ?? null,
    );
    hubResults.push(hubResult);
    warnings.push(...hubResult.warnings);
  }
  warnings.push(...flow.warnings);

  if (!hubResults.length) {
    warnings.push('Kịch bản chưa có Hub nào — hãy gán ít nhất một Hub ứng viên.');
  }

  // ---------------------------------------------------------------------
  // Tổng hợp cấp kịch bản.
  // FN-11 AC-02: Cost/Ton của kịch bản = tổng chi phí ÷ tổng Delivered Supply,
  // KHÔNG phải bình quân số học Cost/Ton của các Hub.
  // ---------------------------------------------------------------------
  const scenarioSeasons = mergeSeasons(hubResults.flatMap((h) => h.seasons));
  const deliveredTons = sum(hubResults.map((h) => h.deliveredTons));
  const collectableTons = sum(hubResults.map((h) => h.collectableTons));
  const totalAvailableTons = sum(hubResults.map((h) => h.totalAvailableTons));

  const capex = mergeCapex(hubResults.map((h) => h.capex));
  const opex = mergeOpex(hubResults.map((h) => h.opex));
  const costs = mergeCosts(hubResults.map((h) => h.costs), deliveredTons);

  // FN-17 — No-Hub Baseline trên CÙNG tập HTX (BR-03).
  const baseline: NoHubBaseline = options.skipBaseline
    ? emptyBaseline('Bỏ qua theo yêu cầu')
    : computeNoHubBaseline(allServed, plantPoint, distances, params);

  const financial = computeFinancials({
    scenario,
    params,
    capexTotal: capex.total,
    opexTotal: opex.total,
    costPerTon: costs.costPerTon,
    steadyDeliveredTons: deliveredTons,
    baseline,
  });

  const coveragePct = annualDemand > 0 ? (deliveredTons / annualDemand) * 100 : 0;
  let plantDemandWarning: string | null = null;
  if (annualDemand > 0 && deliveredTons < annualDemand) {
    // FN-06 BR-05: cảnh báo cấp nhà máy, độc lập với cảnh báo cấp Hub.
    plantDemandWarning =
      `Kịch bản không đáp ứng nhu cầu nhà máy: thiếu ${fmtPct(100 - coveragePct)} ` +
      `(${fmtTons(annualDemand - deliveredTons)} tấn/năm).`;
    warnings.push(plantDemandWarning);
  }

  if (baseline.advisoryOnly && baseline.available) {
    warnings.push(
      `No-Hub Baseline chỉ mang tính tham khảo: ${baseline.excludedCooperatives.length} HTX bị loại ` +
      `(${fmtPct(baseline.excludedSupplyPct)} sản lượng).`,
    );
  }

  notes.push(
    'Cost per Ton chưa gồm khấu hao đầu tư — không dùng để xếp hạng kịch bản (FN-11 BR-03).',
    'Xếp hạng kịch bản dùng TCO per Ton (quyết định B2, FN-12 BR-04).',
    'Total Delivered Logistics Cost KHÔNG bao gồm giá mua rơm trả cho HTX/nông dân (quyết định B1).',
    'Khối lượng từng chặng KHÔNG còn suy từ hệ số mà lấy từ mô phỏng luồng rơm theo ngày: ' +
      `${fmtTons(flow.directFieldPlantTons)} tấn chở thẳng Ruộng→Nhà máy bằng ghe, ` +
      `${fmtTons(flow.fieldHubTons)} tấn qua Hub, ${fmtTons(flow.hubPlantTons)} tấn xuất kho bằng sà lan.`,
    `Lịch thu hoạch: ${flow.harvestDays} ngày có rơm tại ruộng, ${flow.noHarvestDays} ngày không có — ` +
      'chính khoảng trống này là lý do tồn tại của Hub.',
    'KHOẢNG TRỐNG CÔNG THỨC (cần BA/Tài chính chốt): TCO theo FN-12 BR-01 = CAPEX + Σ OPEX, ' +
      'mà OPEX theo FN-10 BR-03 KHÔNG gồm Collection Cost và Transportation Cost. Vì vậy cột ' +
      'No-Hub Baseline (CAPEX = 0, OPEX = 0) sẽ có TCO per Ton = 0 và luôn đứng đầu bảng xếp hạng. ' +
      'Hệ thống bổ sung chỉ số "Chi phí vòng đời đầy đủ chuỗi / tấn" (CAPEX + Σ Total Delivered ' +
      'Logistics Cost) để so sánh đúng với No-Hub Baseline.',
    'V1 dùng mô hình chi phí tuyến tính theo tấn·km (FN-08 BR-06): không có phí cố định mỗi chuyến, ' +
      'phí tối thiểu hay chi phí chiều rỗng — lợi ích gom hàng của Hub do đó bị ước tính THẤP hơn thực tế.',
    'Công suất Hub được hiểu là TỒN KHO TỐI ĐA (tấn), không phải sản lượng thông qua hàng năm. ' +
      'Tồn kho cao điểm dùng để tính kho bãi và CAPEX nay lấy từ mô phỏng theo ngày, ' +
      'thay cho hệ số tồn kho cao điểm (#35) — đóng rủi ro RS-06 của BRD.',
    ...flow.notes,
  );

  // Review 24/09/2026 (D04): cùng phiên bản tham số chưa đủ để tái lập — lưu kèm phiên bản thuật toán và
  // băm của toàn bộ đầu vào sống (HTX, thống kê sản lượng, Hub ứng viên, nhà máy) tại thời điểm chạy.
  const lineage = {
    engineVersion: ENGINE_VERSION,
    parameterSetVersion: params.version,
    inputChecksum: digest({ cooperatives, stats, scenarioHubs, plant, params }),
    inputCounts: { cooperatives: cooperatives.length, harvestStatistics: stats.length, hubs: scenarioHubs.length },
  };
  return {
    lineage,
    scenarioId: scenario.id,
    scenarioCode: scenario.code,
    scenarioName: scenario.name,
    status: scenario.status as 'tham_khao' | 'chinh_thuc',
    parameterSetVersion: params.version,
    computedAt: nowIso(),
    plant: {
      id: plant.id,
      name: plant.name,
      lat: plant.lat,
      lng: plant.lng,
      annualDemandTons: annualDemand,
    },
    hubs: hubResults,
    hubCount: hubResults.length,
    seasons: scenarioSeasons,
    totalAvailableTons: round(totalAvailableTons),
    collectableTons: round(collectableTons),
    deliveredTons: round(deliveredTons),
    costs,
    capex,
    opex,
    financial,
    baseline,
    flow,
    plantDemandCoveragePct: round(coveragePct, 2),
    plantDemandWarning,
    unapprovedParameters: params.unapproved,
    canBeMarkedOfficial: params.unapproved.length === 0,
    warnings,
    notes,
  };
}

// =====================================================================
// FN-06 — Ước tính sản lượng thu gom theo mùa vụ
// =====================================================================

function buildSeasonSupply(rows: StatRow[], params: SimulationParams): SeasonSupply[] {
  return rows
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((row) => {
      // BR-01 (quyết định B3): Total Available = Sản lượng lúa thống kê × Hệ số rơm/lúa.
      const totalAvailableTons = row.paddy_tons * params.strawToPaddyRatio;
      // BR-02: Collectable = Total Available × Hệ số thu gom khả thi.
      const collectableTons = totalAvailableTons * params.collectableRatio;
      // BR-04: Delivered = Collectable × (1 − hệ số hao hụt).
      const deliveredTons = collectableTons * (1 - params.lossRatio);
      return {
        seasonId: row.season_id,
        seasonName: row.season_name,
        totalAvailableTons: round(totalAvailableTons),
        collectableTons: round(collectableTons),
        deliveredTons: round(deliveredTons),
        paddyTons: row.paddy_tons,
        plantedAreaHa: row.planted_area_ha,
      };
    });
}

function mergeSeasons(list: SeasonSupply[]): SeasonSupply[] {
  const map = new Map<string, SeasonSupply>();
  for (const season of list) {
    const existing = map.get(season.seasonId);
    if (!existing) {
      map.set(season.seasonId, { ...season });
      continue;
    }
    existing.totalAvailableTons = round(existing.totalAvailableTons + season.totalAvailableTons);
    existing.collectableTons = round(existing.collectableTons + season.collectableTons);
    existing.deliveredTons = round(existing.deliveredTons + season.deliveredTons);
    existing.paddyTons = round(existing.paddyTons + season.paddyTons);
    existing.plantedAreaHa = round(existing.plantedAreaHa + season.plantedAreaHa);
  }
  return [...map.values()];
}

// =====================================================================
// Kết quả cho một Hub: FN-07 → FN-11
// =====================================================================

function buildHubResult(
  hub: ScenarioHubRow,
  served: ServedCooperative[],
  plantPoint: LatLng,
  distances: DistanceService,
  params: SimulationParams,
  flow: FlowHubResult | null,
): HubResult {
  const warnings: string[] = [];
  const hubPoint: LatLng = { lat: hub.lat, lng: hub.lng };
  const seasons = mergeSeasons(served.flatMap((c) => c.seasons));
  const collectableTons = sum(served.map((c) => c.collectableTons));
  const deliveredTons = sum(served.map((c) => c.deliveredTons));
  const totalAvailableTons = sum(served.map((c) => c.totalAvailableTons));

  if (!served.length) {
    // FN-05 Luồng phụ + AC-04: cảnh báo và KHÔNG trả về 0 một cách im lặng.
    warnings.push(`${hub.name}: không có vùng nguyên liệu phù hợp trong bán kính ${hub.service_radius_km} km.`);
  }

  // ------------------- FN-07 Collection Cost -------------------
  const unitCollection = params.collectionLabourPricePerTon + params.collectionConsumablePricePerTon;
  if (unitCollection <= 0) {
    warnings.push(`${hub.name}: chưa cấu hình đơn giá thu gom — không hiển thị Collection Cost.`);
  }
  const collectionCost = collectableTons * unitCollection;

  // ------------------- FN-08 Transportation Cost -------------------
  // Ba chặng, khối lượng từng chặng lấy từ MÔ PHỎNG LUỒNG RƠM THEO NGÀY:
  //   Ruộng → Nhà máy : ghe, trong mùa thu hoạch, trần bằng tiêu thụ ngày;
  //   Ruộng → Hub     : ghe, phần rơm vượt tiêu thụ ngày;
  //   Hub  → Nhà máy  : sà lan đầy tải, ngoài mùa thu hoạch.
  const hubToPlant = distances.distance(hubPoint, plantPoint, 'road');
  const fieldPlantLeg = buildFieldPlantLeg(served, flow, params);
  const fieldHubLeg = buildFieldHubLeg(hub, served, hubPoint, distances, params, flow);
  const hubPlantLeg = buildHubPlantLeg(hub, hubToPlant, hubPoint, plantPoint, distances, params, flow);

  if (hubPlantLeg.waterwaySuggested && hubPlantLeg.mode === 'road') {
    warnings.push(
      `${hub.name}: chặng Hub→Nhà máy dài ${fmtNum(hubPlantLeg.weightedAvgDistanceKm)} km vượt ngưỡng ` +
      `${params.roadFeasibleDistanceKm} km — nên đánh giá phương án đường thủy, chi phí đường bộ có thể tăng cao.`,
    );
  }

  const transportationCost = fieldPlantLeg.cost + fieldHubLeg.cost + hubPlantLeg.cost;

  // ------------------- FN-09 Kho bãi & thiết bị -------------------
  // Tồn kho cao điểm lấy từ mô phỏng theo ngày thay cho heuristic FN-09 BR-02
  // (đóng rủi ro RS-06). Chỉ quay lại heuristic khi mô phỏng không chạy được.
  const sizing = computeSizing(collectableTons, params, flow?.peakInventoryTons ?? null);

  // Công suất Hub được hiểu là TỒN KHO TỐI ĐA. Cảnh báo dựa trên kết quả mô phỏng.
  let capacityWarning: HubResult['capacityWarning'] = null;
  if (flow && hub.design_capacity_tons > 0) {
    if (flow.daysAtCapacity > 0) {
      const overflowPct = collectableTons > 0 ? (flow.overflowTons / collectableTons) * 100 : 0;
      capacityWarning = {
        shortfallPct: round(-overflowPct, 2),
        message:
          `Kho đầy ${flow.daysAtCapacity} ngày/năm, phải bỏ lại ${fmtTons(flow.overflowTons)} tấn rơm ` +
          `tại ruộng (${fmtPct(overflowPct)} sản lượng thu gom được) — sức chứa ` +
          `${fmtTons(hub.design_capacity_tons)} tấn chưa đủ.`,
      };
      warnings.push(`${hub.name}: ${capacityWarning.message}`);
    } else if (flow.utilizationPct < 60) {
      const idlePct = 100 - flow.utilizationPct;
      capacityWarning = {
        shortfallPct: round(idlePct, 2),
        message:
          `Tồn kho cao điểm chỉ ${fmtTons(flow.peakInventoryTons)} tấn (ngày ${flow.peakInventoryDayLabel}), ` +
          `dùng ${fmtPct(flow.utilizationPct)} sức chứa ${fmtTons(hub.design_capacity_tons)} tấn — ` +
          'sức chứa đang dư so với luồng rơm thực tế.',
      };
      warnings.push(`${hub.name}: ${capacityWarning.message}`);
    }
  }

  // ------------------- FN-10 CAPEX / OPEX -------------------
  const capex = computeCapex(sizing, params);
  const opex = computeOpex(
    sizing,
    capex,
    hub.land_mode as 'mua' | 'thue',
    params,
    flow?.receivedFromFieldTons ?? 0,
  );

  // ------------------- FN-11 Tổng hợp chuỗi chi phí -------------------
  const costs = buildCostChain({
    collectionCost,
    warehouseCost: opex.warehouseCostAnnual,
    handlingCost: opex.handlingCostAnnual,
    transportationFieldHub: fieldPlantLeg.cost + fieldHubLeg.cost,
    transportationHubPlant: hubPlantLeg.cost,
    deliveredTons,
  });

  const leadTimeHours = round(fieldHubLeg.leadTimeHours + hubPlantLeg.leadTimeHours, 2);

  return {
    hubId: hub.hub_id,
    scenarioHubId: hub.id,
    code: hub.code,
    name: hub.name,
    lat: hub.lat,
    lng: hub.lng,
    provinceName: hub.province_id,
    serviceRadiusKm: hub.service_radius_km,
    designCapacityTons: hub.design_capacity_tons,
    landMode: hub.land_mode as 'mua' | 'thue',
    cooperatives: served,
    cooperativeCount: served.length,
    seasons,
    totalAvailableTons: round(totalAvailableTons),
    collectableTons: round(collectableTons),
    deliveredTons: round(deliveredTons),
    capacityWarning,
    distanceToPlantKm: hubToPlant.distanceKm,
    distanceToPlantSourceLabel: hubToPlant.sourceLabel,
    legs: [fieldPlantLeg, fieldHubLeg, hubPlantLeg],
    flow,
    sizing,
    capex,
    opex,
    costs,
    leadTimeHours,
    warnings,
  };
}

/**
 * CHẶNG BỔ SUNG — Ruộng → Nhà máy (chở thẳng bằng ghe trong mùa thu hoạch).
 *
 * BRD v1.4 chỉ mô hình hoá hai chặng Ruộng→Hub và Hub→Nhà máy. Theo phương án
 * vận hành thực tế, rơm thu hoạch được ƯU TIÊN chở thẳng về nhà máy tới hạn mức
 * tiêu thụ trong ngày; chỉ phần vượt mới đi qua Hub. Khối lượng và ton·km của
 * chặng này do mô phỏng luồng rơm theo ngày quyết định.
 *
 * Chi phí vẫn phân bổ theo khoảng cách RIÊNG của từng HTX, giữ nguyên nguyên tắc
 * của FN-08 BR-03 (quyết định B6).
 */
function buildFieldPlantLeg(
  served: ServedCooperative[],
  flow: FlowHubResult | null,
  params: SimulationParams,
): LegResult {
  // flow.receivedFromFieldTons là phần đi qua Hub; phần còn lại đi thẳng.
  const collectableTotal = sum(served.map((c) => c.collectableTons));
  const directRatio =
    flow && collectableTotal > 0
      ? Math.max(0, 1 - Math.min(1, flow.receivedFromFieldTons / collectableTotal))
      : 0;

  let tons = 0;
  let tonKm = 0;
  let leadTimeWeighted = 0;
  for (const htx of served) {
    const legTons = htx.collectableTons * directRatio;
    tons += legTons;
    tonKm += legTons * htx.distanceToPlantKm;
    leadTimeWeighted +=
      legTons *
      (htx.distanceToPlantKm / Math.max(params.waterwaySpeedKmh, 1) + params.handlingHoursPerTrip);
  }

  // Ghe là phương tiện đường thủy nên áp đơn giá và tốc độ đường thủy.
  const cost = tonKm * params.waterwayFreightRatePerTonKm;
  const leadTimeHours = tons > 0 ? leadTimeWeighted / tons : 0;
  const trips = tons > 0 ? Math.ceil(tons / Math.max(params.boatStrawPayloadTons, 1)) : 0;

  return {
    leg: 'field_plant',
    label: `Ruộng → Nhà máy (ghe ${fmtNum(params.boatRegisteredTons)} tấn, chở thẳng)`,
    mode: 'waterway',
    modeDecidedBy: 'mac_dinh',
    waterwaySuggested: false,
    tons: round(tons),
    weightedAvgDistanceKm: tons > 0 ? round(tonKm / tons, 3) : 0,
    tonKm: round(tonKm),
    cost: round(cost),
    trips,
    vehiclesRequired: estimateFleet(trips, leadTimeHours),
    leadTimeHours: round(leadTimeHours, 2),
  };
}

/**
 * FN-08 BR-03 (quyết định B6): Transportation Cost (Field→Hub) tính theo TỪNG HTX
 * với khoảng cách riêng của HTX đó — KHÔNG dùng khoảng cách bình quân.
 */
function buildFieldHubLeg(
  hub: ScenarioHubRow,
  served: ServedCooperative[],
  hubPoint: LatLng,
  distances: DistanceService,
  params: SimulationParams,
  flow: FlowHubResult | null,
): LegResult {
  let cost = 0;
  let tonKm = 0;
  let tons = 0;
  let leadTimeWeighted = 0;
  let anyWaterwaySuggested = false;
  let waterwayLegs = 0;

  const override = hub.mode_field_hub as 'auto' | TransportMode;
  // Chỉ phần rơm THỰC SỰ đi qua Hub mới nằm trên chặng này. Mô phỏng luồng rơm
  // cho biết tỷ lệ đó; phần còn lại đã được chở thẳng từ ruộng về nhà máy.
  const collectableTotal = sum(served.map((c) => c.collectableTons));
  const viaHubRatio =
    flow && collectableTotal > 0 ? Math.min(1, flow.receivedFromFieldTons / collectableTotal) : 1;

  for (const htx of served) {
    const htxPoint: LatLng = { lat: htx.lat, lng: htx.lng };
    const decision = decideMode({
      override,
      distanceKm: htx.distanceToHubKm,
      from: htxPoint,
      to: hubPoint,
      distances,
      params,
    });
    if (decision.suggested) anyWaterwaySuggested = true;
    if (decision.mode === 'waterway') waterwayLegs += 1;

    // Nếu chuyển sang đường thủy, khoảng cách phải đo lại trên mạng lưới thủy.
    const legDistanceKm =
      decision.mode === 'waterway'
        ? distances.distance(htxPoint, hubPoint, 'waterway').distanceKm
        : htx.distanceToHubKm;

    const rate =
      decision.mode === 'waterway' ? params.waterwayFreightRatePerTonKm : params.roadFreightRatePerTonKm;
    const speed = decision.mode === 'waterway' ? params.waterwaySpeedKmh : params.roadSpeedKmh;

    const legTons = htx.collectableTons * viaHubRatio;
    cost += legTons * legDistanceKm * rate;
    tonKm += legTons * legDistanceKm;
    tons += legTons;
    // BR-05: lead time chặng = khoảng cách ÷ tốc độ + thời gian bốc/xếp.
    leadTimeWeighted +=
      legTons * (legDistanceKm / Math.max(speed, 1) + params.handlingHoursPerTrip);
  }

  const dominantMode: TransportMode =
    override === 'road' || override === 'waterway'
      ? override
      : waterwayLegs > served.length / 2
        ? 'waterway'
        : 'road';
  // Trong mùa thu hoạch phương tiện là GHE 100 tấn (chở ~90 tấn rơm rời), không
  // phải sà lan — sà lan chỉ chạy chặng Hub → Nhà máy ngoài vụ.
  const payload =
    dominantMode === 'waterway' ? params.boatStrawPayloadTons : params.truckPayloadTons;
  const trips = flow ? flow.boatTripsToHub : tons > 0 ? Math.ceil(tons / Math.max(payload, 1)) : 0;
  // Lead time của chặng Field→Hub = bình quân GIA QUYỀN theo sản lượng (BR-05).
  const leadTimeHours = tons > 0 ? leadTimeWeighted / tons : 0;

  return {
    leg: 'field_hub',
    label: `Ruộng → Hub (ghe ${fmtNum(params.boatRegisteredTons)} tấn)`,
    mode: dominantMode,
    modeDecidedBy:
      override !== 'auto' ? 'nguoi_dung_ghi_de' : anyWaterwaySuggested ? 'goi_y_he_thong' : 'mac_dinh',
    waterwaySuggested: anyWaterwaySuggested,
    tons: round(tons),
    weightedAvgDistanceKm: tons > 0 ? round(tonKm / tons, 3) : 0,
    tonKm: round(tonKm),
    cost: round(cost),
    trips,
    vehiclesRequired: estimateFleet(trips, leadTimeHours),
    leadTimeHours: round(leadTimeHours, 2),
  };
}

function buildHubPlantLeg(
  hub: ScenarioHubRow,
  roadDistance: DistanceResult,
  hubPoint: LatLng,
  plantPoint: LatLng,
  distances: DistanceService,
  params: SimulationParams,
  flow: FlowHubResult | null,
): LegResult {
  // Khối lượng chặng này = lượng rơm đã băm/nén thực sự xuất kho theo mô phỏng.
  const shippedTons = flow ? flow.shippedToPlantTons : 0;
  const override = hub.mode_hub_plant as 'auto' | TransportMode;
  const decision = decideMode({
    override,
    distanceKm: roadDistance.distanceKm,
    from: hubPoint,
    to: plantPoint,
    distances,
    params,
  });

  const distanceKm =
    decision.mode === 'waterway'
      ? distances.distance(hubPoint, plantPoint, 'waterway').distanceKm
      : roadDistance.distanceKm;
  const rate =
    decision.mode === 'waterway' ? params.waterwayFreightRatePerTonKm : params.roadFreightRatePerTonKm;
  const speed = decision.mode === 'waterway' ? params.waterwaySpeedKmh : params.roadSpeedKmh;
  // Sà lan 1.000 / 2.000 tấn CHỞ ĐẦY TẢI cho chặng ngoài mùa thu hoạch.
  const bargePayload = hub.barge_payload_tons ?? params.bargeSmallPayloadTons;
  const payload = decision.mode === 'waterway' ? bargePayload : params.truckPayloadTons;

  const cost = shippedTons * distanceKm * rate;
  const trips = flow
    ? flow.fullBargeTrips + flow.partialBargeTrips
    : shippedTons > 0 ? Math.ceil(shippedTons / Math.max(payload, 1)) : 0;
  const leadTimeHours = distanceKm / Math.max(speed, 1) + params.handlingHoursPerTrip;

  return {
    leg: 'hub_plant',
    label: `Hub → Nhà máy (sà lan ${fmtNum(bargePayload)} tấn, đầy tải)`,
    mode: decision.mode,
    modeDecidedBy:
      override !== 'auto' ? 'nguoi_dung_ghi_de' : decision.suggested ? 'goi_y_he_thong' : 'mac_dinh',
    waterwaySuggested: decision.suggested,
    tons: round(shippedTons),
    weightedAvgDistanceKm: round(distanceKm, 3),
    tonKm: round(shippedTons * distanceKm),
    cost: round(cost),
    trips,
    vehiclesRequired: estimateFleet(trips, leadTimeHours),
    leadTimeHours: round(leadTimeHours, 2),
  };
}

/**
 * FN-08 BR-04 — xác định phương thức vận chuyển cho một chặng:
 *  (a) mặc định đường bộ;
 *  (b) gợi ý đường thủy khi ĐỒNG THỜI: khoảng cách vượt ngưỡng cự ly khả thi
 *      (#27) VÀ chặng đó tiếp giáp mạng lưới kênh rạch khả dụng (#9);
 *  (c) người dùng có thể ghi đè cho từng chặng/kịch bản.
 */
function decideMode(input: {
  override: 'auto' | TransportMode;
  distanceKm: number;
  from: LatLng;
  to: LatLng;
  distances: DistanceService;
  params: SimulationParams;
}): { mode: TransportMode; suggested: boolean } {
  const exceedsThreshold = input.distanceKm > input.params.roadFeasibleDistanceKm;
  const hasWaterway = exceedsThreshold ? input.distances.hasWaterwayAccess(input.from, input.to) : false;
  const suggested = exceedsThreshold && hasWaterway;

  if (input.override === 'road' || input.override === 'waterway') {
    return { mode: input.override, suggested };
  }
  return { mode: suggested ? 'waterway' : 'road', suggested };
}

/** Ước lượng số phương tiện cần huy động từ số chuyến và thời gian một vòng chạy. */
function estimateFleet(trips: number, leadTimeHours: number): number {
  if (trips <= 0) return 0;
  const cycleHours = Math.max(leadTimeHours * 2, 1); // đi + về
  return Math.max(1, Math.ceil((trips * cycleHours) / VEHICLE_HOURS_PER_YEAR));
}

// =====================================================================
// FN-09 — Ước tính nhu cầu kho bãi & thiết bị
// =====================================================================

export function computeSizing(
  collectableAnnualTons: number,
  params: SimulationParams,
  /**
   * Tồn kho cao điểm lấy từ mô phỏng luồng rơm theo ngày. Khi có giá trị này,
   * nó THAY THẾ heuristic BR-02 — đây chính là hạng mục mà rủi ro RS-06 của BRD
   * yêu cầu chuyển sang mô hình tồn kho thực.
   */
  simulatedPeakInventoryTons: number | null = null,
): EquipmentSizing {
  // BR-02 (dự phòng): Peak Inventory = Collectable Supply cả năm × Hệ số tồn kho cao điểm.
  const heuristicPeak = collectableAnnualTons * params.peakInventoryFactor;
  const fromSimulation = simulatedPeakInventoryTons !== null && simulatedPeakInventoryTons > 0;
  const peakInventoryTons = fromSimulation ? simulatedPeakInventoryTons! : heuristicPeak;
  const warehouseCapacityTons = peakInventoryTons;
  const warehouseAreaM2 = warehouseCapacityTons * params.warehouseAreaNormM2PerTon;
  const yardAreaM2 = warehouseCapacityTons * params.yardAreaNormM2PerTon;

  // BR-03: làm tròn LÊN; tối thiểu 1 máy mỗi loại nếu Hub có sản lượng > 0.
  const balePressCount =
    collectableAnnualTons > 0
      ? Math.max(1, Math.ceil(collectableAnnualTons / Math.max(params.balePressCapacityTonsYear, 1)))
      : 0;
  const forkliftCount =
    collectableAnnualTons > 0
      ? Math.max(1, Math.ceil(collectableAnnualTons / Math.max(params.forkliftCapacityTonsYear, 1)))
      : 0;

  return {
    peakInventoryTons: round(peakInventoryTons),
    warehouseCapacityTons: round(warehouseCapacityTons),
    warehouseAreaM2: round(warehouseAreaM2),
    yardAreaM2: round(yardAreaM2),
    balePressCount,
    forkliftCount,
    peakInventorySource: fromSimulation ? 'mo_phong_theo_ngay' : 'he_so_uoc_luong',
    estimateNotice: fromSimulation
      ? `Ước tính — Peak Inventory ${Math.round(peakInventoryTons).toLocaleString('vi-VN')} tấn lấy từ ` +
        'mô phỏng luồng rơm theo ngày (tồn kho cao nhất trong năm vận hành ổn định), ' +
        'không còn dùng hệ số tồn kho cao điểm — đóng rủi ro RS-06.'
      : `Ước tính — Peak Inventory suy ra từ hệ số tồn kho cao điểm ${params.peakInventoryFactor} ` +
        '(FN-09 BR-04, RS-06), chưa dùng mô hình tồn kho theo ngày.',
  };
}

// =====================================================================
// FN-10 — CAPEX / OPEX
// =====================================================================

export function computeCapex(sizing: EquipmentSizing, params: SimulationParams): CapexBreakdown {
  const warehouseConstruction = sizing.warehouseAreaM2 * params.warehouseBuildPricePerM2;
  const yardConstruction = sizing.yardAreaM2 * params.yardBuildPricePerM2;
  const balePress = sizing.balePressCount * params.balePressUnitPrice;
  const forklift = sizing.forkliftCount * params.forkliftUnitPrice;
  const construction = warehouseConstruction + yardConstruction;
  const equipment = balePress + forklift;
  const other = sizing.warehouseCapacityTons > 0 ? params.capexOther : 0;
  return {
    warehouseConstruction: round(warehouseConstruction),
    yardConstruction: round(yardConstruction),
    construction: round(construction),
    balePress: round(balePress),
    forklift: round(forklift),
    equipment: round(equipment),
    other: round(other),
    total: round(construction + equipment + other),
  };
}

export function computeOpex(
  sizing: EquipmentSizing,
  capex: CapexBreakdown,
  landMode: 'mua' | 'thue',
  params: SimulationParams,
  /** Tấn rơm đi QUA Hub trong năm — cơ sở tính chi phí băm và nén. */
  processedTonsPerYear = 0,
): OpexBreakdown {
  const staff = params.staffCount * params.staffSalaryPerMonth * MONTHS_PER_YEAR;
  const utilities = params.utilityCostPerYear;
  // BR-02: cơ sở tính bảo trì là CAPEX_thiết bị, không gồm xây dựng hay CAPEX khác.
  const maintenance = capex.equipment * params.maintenanceRate;
  const landLease =
    landMode === 'thue'
      ? (sizing.warehouseAreaM2 + sizing.yardAreaM2) * params.landLeasePricePerM2Year
      : 0;
  // Bổ sung ngoài BRD: rơm về Hub được BĂM và NÉN. Chi phí chỉ áp cho phần rơm
  // thực sự đi qua Hub — rơm chở thẳng ruộng đến nhà máy không phát sinh khoản này.
  const processing = processedTonsPerYear * params.hubProcessingCostPerTon;
  const otherOpex = 0;
  const total = staff + utilities + maintenance + landLease + processing + otherOpex;

  return {
    staff: round(staff),
    utilities: round(utilities),
    maintenance: round(maintenance),
    landLease: round(landLease),
    processing: round(processing),
    otherOpex: round(otherOpex),
    total: round(total),
    // BR-05 (quyết định B8):
    //   Handling  = nhân sự vận hành + bảo trì thiết bị
    //   Warehouse = điện/nhiên liệu + thuê mặt bằng + OPEX khác
    handlingCostAnnual: round(staff + maintenance + processing),
    warehouseCostAnnual: round(utilities + landLease + otherOpex),
  };
}

// =====================================================================
// FN-11 — Total Delivered Logistics Cost & Cost per Ton
// =====================================================================

function buildCostChain(input: {
  collectionCost: number;
  warehouseCost: number;
  handlingCost: number;
  transportationFieldHub: number;
  transportationHubPlant: number;
  deliveredTons: number;
}): CostChain {
  const transportationCost = input.transportationFieldHub + input.transportationHubPlant;
  const total =
    input.collectionCost + input.warehouseCost + input.handlingCost + transportationCost;
  // BR-04 (ca biên): Delivered Supply = 0 → "Không xác định", không chia cho 0.
  const costPerTon = input.deliveredTons > 0 ? total / input.deliveredTons : null;
  return {
    collectionCost: round(input.collectionCost),
    warehouseCost: round(input.warehouseCost),
    handlingCost: round(input.handlingCost),
    transportationCost: round(transportationCost),
    transportationFieldHub: round(input.transportationFieldHub),
    transportationHubPlant: round(input.transportationHubPlant),
    totalDeliveredLogisticsCost: round(total),
    costPerTon: costPerTon === null ? null : round(costPerTon),
    costPerTonNote: 'chưa gồm khấu hao đầu tư',
  };
}

function mergeCosts(list: CostChain[], deliveredTons: number): CostChain {
  const collectionCost = sum(list.map((c) => c.collectionCost));
  const warehouseCost = sum(list.map((c) => c.warehouseCost));
  const handlingCost = sum(list.map((c) => c.handlingCost));
  const fieldHub = sum(list.map((c) => c.transportationFieldHub));
  const hubPlant = sum(list.map((c) => c.transportationHubPlant));
  return buildCostChain({
    collectionCost,
    warehouseCost,
    handlingCost,
    transportationFieldHub: fieldHub,
    transportationHubPlant: hubPlant,
    deliveredTons,
  });
}

function mergeCapex(list: CapexBreakdown[]): CapexBreakdown {
  return {
    warehouseConstruction: round(sum(list.map((c) => c.warehouseConstruction))),
    yardConstruction: round(sum(list.map((c) => c.yardConstruction))),
    construction: round(sum(list.map((c) => c.construction))),
    balePress: round(sum(list.map((c) => c.balePress))),
    forklift: round(sum(list.map((c) => c.forklift))),
    equipment: round(sum(list.map((c) => c.equipment))),
    other: round(sum(list.map((c) => c.other))),
    total: round(sum(list.map((c) => c.total))),
  };
}

function mergeOpex(list: OpexBreakdown[]): OpexBreakdown {
  return {
    staff: round(sum(list.map((o) => o.staff))),
    utilities: round(sum(list.map((o) => o.utilities))),
    maintenance: round(sum(list.map((o) => o.maintenance))),
    landLease: round(sum(list.map((o) => o.landLease))),
    processing: round(sum(list.map((o) => o.processing))),
    otherOpex: round(sum(list.map((o) => o.otherOpex))),
    total: round(sum(list.map((o) => o.total))),
    handlingCostAnnual: round(sum(list.map((o) => o.handlingCostAnnual))),
    warehouseCostAnnual: round(sum(list.map((o) => o.warehouseCostAnnual))),
  };
}

// =====================================================================
// FN-17 — No-Hub Baseline (Ruộng → Nhà máy, không qua Hub)
// =====================================================================

export function computeNoHubBaseline(
  served: ServedCooperative[],
  plantPoint: LatLng,
  distances: DistanceService,
  params: SimulationParams,
): NoHubBaseline {
  const excluded: NoHubBaseline['excludedCooperatives'] = [];
  const usable: ServedCooperative[] = [];
  for (const htx of served) {
    if (!Number.isFinite(htx.lat) || !Number.isFinite(htx.lng)) {
      excluded.push({ code: htx.code, name: htx.name, reason: 'Thiếu toạ độ GPS' });
      continue;
    }
    usable.push(htx);
  }

  const totalSupply = sum(served.map((c) => c.collectableTons));
  const excludedSupply = sum(
    served.filter((c) => excluded.some((e) => e.code === c.code)).map((c) => c.collectableTons),
  );

  if (!usable.length) {
    return {
      ...emptyBaseline('Không có HTX nào đủ dữ liệu để tính No-Hub Baseline'),
      excludedCooperatives: excluded,
      excludedSupplyPct: totalSupply > 0 ? round((excludedSupply / totalSupply) * 100, 2) : 0,
    };
  }

  // BR: Collection Cost vẫn phát sinh ở phương án không có Hub (thu gom tại ruộng).
  const unitCollection = params.collectionLabourPricePerTon + params.collectionConsumablePricePerTon;
  const collectableTons = sum(usable.map((c) => c.collectableTons));
  const collectionCost = collectableTons * unitCollection;

  let transportationCost = 0;
  let tonKm = 0;
  let leadTimeWeighted = 0;
  let waterwayLegs = 0;

  for (const htx of usable) {
    const htxPoint: LatLng = { lat: htx.lat, lng: htx.lng };
    // BR-04: phương thức xác định theo cùng logic FN-08 BR-04.
    const decision = decideMode({
      override: 'auto',
      distanceKm: htx.distanceToPlantKm,
      from: htxPoint,
      to: plantPoint,
      distances,
      params,
    });
    if (decision.mode === 'waterway') waterwayLegs += 1;
    const distanceKm =
      decision.mode === 'waterway'
        ? distances.distance(htxPoint, plantPoint, 'waterway').distanceKm
        : htx.distanceToPlantKm;
    const rate =
      decision.mode === 'waterway' ? params.waterwayFreightRatePerTonKm : params.roadFreightRatePerTonKm;
    const speed = decision.mode === 'waterway' ? params.waterwaySpeedKmh : params.roadSpeedKmh;

    transportationCost += htx.collectableTons * distanceKm * rate;
    tonKm += htx.collectableTons * distanceKm;
    leadTimeWeighted +=
      htx.collectableTons * (distanceKm / Math.max(speed, 1) + params.handlingHoursPerTrip);
  }

  // BR-02: hệ số hao hụt của phương án No-Hub — V1 dùng CÙNG hệ số (#19).
  const deliveredTons = collectableTons * (1 - params.lossRatio);
  const totalCost = collectionCost + transportationCost;
  const baselineCostPerTon = deliveredTons > 0 ? round(totalCost / deliveredTons) : null;

  const dominantMode: TransportMode = waterwayLegs > usable.length / 2 ? 'waterway' : 'road';
  const payload = dominantMode === 'waterway' ? params.bargePayloadTons : params.truckPayloadTons;
  const trips = collectableTons > 0 ? Math.ceil(collectableTons / Math.max(payload, 1)) : 0;
  const leadTimeHours = collectableTons > 0 ? leadTimeWeighted / collectableTons : 0;

  return {
    available: true,
    cooperativeCount: usable.length,
    excludedCooperatives: excluded,
    excludedSupplyPct: totalSupply > 0 ? round((excludedSupply / totalSupply) * 100, 2) : 0,
    collectionCost: round(collectionCost),
    transportationCost: round(transportationCost),
    capex: 0,
    warehouseCost: 0,
    handlingCost: 0,
    totalDeliveredLogisticsCost: round(totalCost),
    deliveredTons: round(deliveredTons),
    baselineCostPerTon,
    advisoryOnly: excluded.length > 0,
    legs: [
      {
        leg: 'field_plant',
        label: 'Ruộng → Nhà máy (không qua Hub)',
        mode: dominantMode,
        modeDecidedBy: 'mac_dinh',
        waterwaySuggested: waterwayLegs > 0,
        tons: round(collectableTons),
        weightedAvgDistanceKm: collectableTons > 0 ? round(tonKm / collectableTons, 3) : 0,
        tonKm: round(tonKm),
        cost: round(transportationCost),
        trips,
        vehiclesRequired: estimateFleet(trips, leadTimeHours),
        leadTimeHours: round(leadTimeHours, 2),
      },
    ],
  };
}

function emptyBaseline(reason: string): NoHubBaseline {
  return {
    available: false,
    reason,
    cooperativeCount: 0,
    excludedCooperatives: [],
    excludedSupplyPct: 0,
    collectionCost: 0,
    transportationCost: 0,
    capex: 0,
    warehouseCost: 0,
    handlingCost: 0,
    totalDeliveredLogisticsCost: 0,
    deliveredTons: 0,
    baselineCostPerTon: null,
    advisoryOnly: false,
    legs: [],
  };
}

// =====================================================================
// FN-12 — TCO, TCO per Ton, ROI, Payback Period
// =====================================================================

function computeFinancials(input: {
  scenario: ScenarioRow;
  params: SimulationParams;
  capexTotal: number;
  opexTotal: number;
  costPerTon: number | null;
  steadyDeliveredTons: number;
  baseline: NoHubBaseline;
}): FinancialResult {
  const { params, scenario } = input;
  const years = scenario.lifecycle_years || params.lifecycleYears;
  const discounted = scenario.discounted === 1;
  const rate = params.discountRate;

  // Nguồn baseline: mặc định No-Hub Baseline (FN-17); có thể ghi đè.
  let baselineCostPerTon: number | null = null;
  let baselineSource: FinancialResult['baselineSource'] = 'thieu_baseline';
  if (scenario.baseline_mode === 'manual' && scenario.baseline_manual_cost_per_ton !== null) {
    baselineCostPerTon = scenario.baseline_manual_cost_per_ton;
    baselineSource = 'manual';
  } else if (scenario.baseline_mode === 'scenario' && scenario.baseline_scenario_id) {
    const other = one<{ payload_json: string }>(
      'SELECT payload_json FROM simulation_results WHERE scenario_id = ? ORDER BY computed_at DESC LIMIT 1',
      [scenario.baseline_scenario_id],
    );
    if (other) {
      const parsed = JSON.parse(other.payload_json) as ScenarioResult;
      baselineCostPerTon = parsed.costs.costPerTon;
      baselineSource = 'scenario';
    }
  } else if (input.baseline.available && input.baseline.baselineCostPerTon !== null) {
    baselineCostPerTon = input.baseline.baselineCostPerTon;
    baselineSource = 'no_hub';
  }

  // Dòng sản lượng và OPEX theo năm.
  // Năm 1 áp tỷ lệ ramp-up (#46); OPEX năm t theo escalation (FN-10 BR-06).
  const yearly: FinancialResult['yearlyCashflow'] = [];
  let tcoOpex = 0;
  let lifecycleLogistics = 0;
  let lifetimeTons = 0;
  let cumulativeSavings = 0;
  let paybackYears: number | null = null;

  // Chi phí logistics của một năm ở mức sản lượng ổn định (dùng để chiếu ra
  // tổng chi phí vòng đời đầy đủ chuỗi).
  const steadyLogisticsPerTon = input.costPerTon ?? 0;

  for (let t = 1; t <= years; t += 1) {
    const deliveredTons = t === 1 ? input.steadyDeliveredTons * params.rampUpRatio : input.steadyDeliveredTons;
    const opexNominal = input.opexTotal * (1 + params.opexEscalation) ** (t - 1);
    const discountFactor = discounted ? 1 / (1 + rate) ** t : 1;
    const opexPresent = opexNominal * discountFactor;

    tcoOpex += opexPresent;
    lifecycleLogistics +=
      steadyLogisticsPerTon * deliveredTons * (1 + params.opexEscalation) ** (t - 1) * discountFactor;
    // BR-05: chế độ chiết khấu áp dụng nhất quán — mẫu số sản lượng cũng chiết khấu.
    lifetimeTons += deliveredTons * discountFactor;

    const savingsPerTon =
      baselineCostPerTon !== null && input.costPerTon !== null
        ? baselineCostPerTon - input.costPerTon
        : 0;
    const savings = savingsPerTon * deliveredTons * discountFactor;
    cumulativeSavings += savings;

    yearly.push({
      year: t,
      deliveredTons: round(deliveredTons),
      opex: round(opexPresent),
      savings: round(savings),
      cumulativeSavings: round(cumulativeSavings),
    });

    if (paybackYears === null && savingsPerTon > 0 && cumulativeSavings >= input.capexTotal) {
      paybackYears = t;
    }
  }

  const tco = input.capexTotal + tcoOpex;
  const tcoPerTon = lifetimeTons > 0 ? round(tco / lifetimeTons) : null;
  const lifecycleCost = input.capexTotal + lifecycleLogistics;
  const lifecycleCostPerTon = lifetimeTons > 0 ? round(lifecycleCost / lifetimeTons) : null;

  let roiPct: number | null = null;
  let paybackStatus: FinancialResult['paybackStatus'] = 'thieu_baseline';

  if (baselineCostPerTon !== null && input.costPerTon !== null) {
    const savingsPerTon = baselineCostPerTon - input.costPerTon;
    // BR-02: ROI = [(Baseline Cost/Ton − Cost/Ton) × Σ Delivered − CAPEX] ÷ CAPEX × 100
    roiPct =
      input.capexTotal > 0
        ? round(((savingsPerTon * lifetimeTons - input.capexTotal) / input.capexTotal) * 100, 2)
        : null;
    if (savingsPerTon <= 0) {
      // BR-03: hiển thị "Không hoàn vốn" thay vì một số âm.
      paybackStatus = 'khong_hoan_von';
      paybackYears = null;
    } else if (paybackYears === null) {
      paybackStatus = 'khong_hoan_von_trong_ky';
    } else {
      paybackStatus = 'hoan_von';
    }
  }

  return {
    lifecycleYears: years,
    discounted,
    discountRatePct: round(rate * 100, 2),
    opexEscalationPct: round(params.opexEscalation * 100, 2),
    rampUpPct: round(params.rampUpRatio * 100, 2),
    capex: round(input.capexTotal),
    tco: round(tco),
    lifetimeDeliveredTons: round(lifetimeTons),
    tcoPerTon,
    lifecycleCost: round(lifecycleCost),
    lifecycleCostPerTon,
    roiPct,
    paybackYears,
    paybackStatus,
    baselineCostPerTon,
    baselineSource,
    baselineSourceLabel: BASELINE_LABEL[baselineSource],
    yearlyCashflow: yearly,
  };
}

const BASELINE_LABEL: Record<FinancialResult['baselineSource'], string> = {
  no_hub: 'No-Hub Baseline (tự tính, FN-17)',
  scenario: 'Kịch bản Hub khác',
  manual: 'Người dùng nhập tay',
  thieu_baseline: 'Thiếu baseline — chỉ có TCO',
};

// =====================================================================
// Tiện ích
// =====================================================================

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmtNum(value: number): string {
  return value.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
}

function fmtTons(value: number): string {
  return Math.round(value).toLocaleString('vi-VN');
}

function fmtPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

export { DISTANCE_SOURCE_LABEL };
