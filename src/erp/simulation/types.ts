/**
 * Kiểu dữ liệu kết quả mô phỏng — ánh xạ 1-1 với các trường mà FN-13 BR-01
 * yêu cầu hiển thị trên Dashboard (4 nhóm KPI).
 */
import type { DistanceSource, TransportMode } from '../../platform/geo/distance.ts';
import type { FlowHubResult, FlowResult } from './flow.ts';

export interface SeasonSupply {
  seasonId: string;
  seasonName: string;
  /** FN-06 BR-01 */ totalAvailableTons: number;
  /** FN-06 BR-02 */ collectableTons: number;
  /** FN-06 BR-04 */ deliveredTons: number;
  paddyTons: number;
  plantedAreaHa: number;
}

export interface ServedCooperative {
  htxId: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  /** Khoảng cách đường chim bay — dùng để xét thuộc bán kính phục vụ (FN-05). */
  radiusDistanceKm: number;
  /** FN-04: khoảng cách theo từng HTX tới Hub, kèm nhãn nguồn tính (BR-04). */
  distanceToHubKm: number;
  distanceToHubSource: DistanceSource;
  distanceToHubSourceLabel: string;
  /** FN-04 bước 6: đầu vào bắt buộc của No-Hub Baseline (FN-17). */
  distanceToPlantKm: number;
  distanceToPlantSource: DistanceSource;
  distanceToPlantSourceLabel: string;
  memberCount: number;
  plantedAreaHa: number;
  seasons: SeasonSupply[];
  totalAvailableTons: number;
  collectableTons: number;
  deliveredTons: number;
}

export interface LegResult {
  leg: 'field_hub' | 'hub_plant' | 'field_plant';
  label: string;
  mode: TransportMode;
  modeDecidedBy: 'mac_dinh' | 'goi_y_he_thong' | 'nguoi_dung_ghi_de';
  waterwaySuggested: boolean;
  tons: number;
  /** Khoảng cách bình quân gia quyền theo sản lượng — CHỈ để hiển thị (FN-04). */
  weightedAvgDistanceKm: number;
  tonKm: number;
  cost: number;
  trips: number;
  vehiclesRequired: number;
  leadTimeHours: number;
}

export interface EquipmentSizing {
  /** FN-09 BR-02 — nay ưu tiên lấy từ mô phỏng luồng rơm theo ngày. */
  peakInventoryTons: number;
  /** Nguồn của Peak Inventory: mô phỏng theo ngày hay hệ số ước lượng cũ. */
  peakInventorySource: 'mo_phong_theo_ngay' | 'he_so_uoc_luong';
  warehouseCapacityTons: number;
  warehouseAreaM2: number;
  yardAreaM2: number;
  /** FN-09 BR-03 — làm tròn LÊN, tối thiểu 1 nếu sản lượng > 0 */
  balePressCount: number;
  forkliftCount: number;
  /** FN-09 BR-04: mọi giá trị của FN-09 là ƯỚC TÍNH. */
  estimateNotice: string;
}

export interface CapexBreakdown {
  construction: number;
  warehouseConstruction: number;
  yardConstruction: number;
  equipment: number;
  balePress: number;
  forklift: number;
  other: number;
  total: number;
}

export interface OpexBreakdown {
  staff: number;
  utilities: number;
  maintenance: number;
  landLease: number;
  /** Bổ sung: chi phí băm và nén rơm tại Hub (chỉ cho phần rơm đi qua Hub). */
  processing: number;
  otherOpex: number;
  total: number;
  /** FN-10 BR-05 (quyết định B8) */
  handlingCostAnnual: number;
  warehouseCostAnnual: number;
}

export interface CostChain {
  /** FN-07 */ collectionCost: number;
  /** FN-11 BR-02 (từ OPEX) */ warehouseCost: number;
  /** FN-11 BR-02 (từ OPEX) */ handlingCost: number;
  /** FN-08 */ transportationCost: number;
  transportationFieldHub: number;
  transportationHubPlant: number;
  /** FN-11 BR-01 */ totalDeliveredLogisticsCost: number;
  /** FN-11 BR-03 — null nghĩa là "Không xác định" (BR-04) */
  costPerTon: number | null;
  costPerTonNote: string;
}

export interface HubResult {
  hubId: string;
  scenarioHubId: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  provinceName: string | null;
  serviceRadiusKm: number;
  designCapacityTons: number;
  landMode: 'mua' | 'thue';
  cooperatives: ServedCooperative[];
  cooperativeCount: number;
  seasons: SeasonSupply[];
  totalAvailableTons: number;
  collectableTons: number;
  deliveredTons: number;
  /** FN-06 BR-03 */
  capacityWarning: { shortfallPct: number; message: string } | null;
  distanceToPlantKm: number;
  distanceToPlantSourceLabel: string;
  legs: LegResult[];
  /** Kết quả mô phỏng luồng rơm theo ngày cho riêng Hub này. */
  flow: FlowHubResult | null;
  sizing: EquipmentSizing;
  capex: CapexBreakdown;
  opex: OpexBreakdown;
  costs: CostChain;
  leadTimeHours: number;
  warnings: string[];
}

export interface FinancialResult {
  lifecycleYears: number;
  discounted: boolean;
  discountRatePct: number;
  opexEscalationPct: number;
  rampUpPct: number;
  capex: number;
  /** FN-12 BR-01: TCO = CAPEX + Σ OPEX(t). Lưu ý OPEX (FN-10 BR-03) chỉ gồm
   *  chi phí vận hành Hub — KHÔNG gồm Collection Cost và Transportation Cost. */
  tco: number;
  lifetimeDeliveredTons: number;
  /** FN-12 BR-04 — chỉ số xếp hạng theo đúng văn bản BRD. */
  tcoPerTon: number | null;
  /**
   * Tổng chi phí vòng đời ĐẦY ĐỦ CHUỖI = CAPEX + Σ Total Delivered Logistics
   * Cost(t). Đây là chỉ số DUY NHẤT so sánh được với cột No-Hub Baseline (nơi
   * CAPEX = 0 và OPEX = 0 nên TCO per Ton theo công thức BRD luôn bằng 0).
   * Xem ghi chú "khoảng trống công thức" trong README.
   */
  lifecycleCost: number;
  lifecycleCostPerTon: number | null;
  /** FN-12 BR-02 — null khi thiếu baseline */ roiPct: number | null;
  /** FN-12 BR-03 — null + trạng thái khi không hoàn vốn */ paybackYears: number | null;
  paybackStatus: 'hoan_von' | 'khong_hoan_von' | 'khong_hoan_von_trong_ky' | 'thieu_baseline';
  baselineCostPerTon: number | null;
  baselineSource: 'no_hub' | 'scenario' | 'manual' | 'thieu_baseline';
  baselineSourceLabel: string;
  yearlyCashflow: {
    year: number;
    deliveredTons: number;
    opex: number;
    savings: number;
    cumulativeSavings: number;
  }[];
}

export interface NoHubBaseline {
  available: boolean;
  reason?: string;
  cooperativeCount: number;
  excludedCooperatives: { code: string; name: string; reason: string }[];
  excludedSupplyPct: number;
  collectionCost: number;
  transportationCost: number;
  /** FN-17 BR-01: No-Hub không có CAPEX / Warehouse Cost / Handling Cost. */
  capex: 0;
  warehouseCost: 0;
  handlingCost: 0;
  totalDeliveredLogisticsCost: number;
  deliveredTons: number;
  baselineCostPerTon: number | null;
  advisoryOnly: boolean;
  legs: LegResult[];
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioCode: string;
  scenarioName: string;
  status: 'tham_khao' | 'chinh_thuc';
  parameterSetVersion: number;
  computedAt: string;
  plant: { id: string; name: string; lat: number; lng: number; annualDemandTons: number };
  hubs: HubResult[];
  hubCount: number;
  seasons: SeasonSupply[];
  totalAvailableTons: number;
  collectableTons: number;
  deliveredTons: number;
  costs: CostChain;
  capex: CapexBreakdown;
  opex: OpexBreakdown;
  financial: FinancialResult;
  baseline: NoHubBaseline;
  /** Mô phỏng luồng rơm thực tế theo ngày (hai phương thức vận chuyển). */
  flow: FlowResult;
  /** FN-06 BR-05: mức đáp ứng nhu cầu Nhà máy VFT. */
  plantDemandCoveragePct: number;
  plantDemandWarning: string | null;
  /** FN-01 BR-04: danh sách tham số giả định còn thiếu phê duyệt. */
  unapprovedParameters: { code: string; number: number; name: string }[];
  canBeMarkedOfficial: boolean;
  warnings: string[];
  notes: string[];
}
