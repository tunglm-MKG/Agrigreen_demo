/**
 * MÔ PHỎNG LUỒNG RƠM THỰC TẾ THEO NGÀY (bổ sung ngoài BRD v1.4)
 * ==============================================================
 *
 * Yêu cầu nghiệp vụ bổ sung của Mekong Green — hai phương thức vận chuyển:
 *
 *  (1) TRONG MÙA THU HOẠCH
 *      Rơm thu hoạch tại ruộng được ƯU TIÊN chở THẲNG về nhà máy bằng ghe
 *      100 tấn (chở được khoảng 90 tấn rơm rời — giới hạn bởi thể tích).
 *      Phần rơm VƯỢT QUÁ lượng tiêu thụ trong ngày của nhà máy được đưa về
 *      Hub để lưu trữ. Tại Hub, rơm được BĂM và NÉN nên vừa phát sinh chi phí
 *      chế biến vừa có hao hụt riêng, đổi lại vận chuyển về sau thuận tiện hơn.
 *
 *  (2) NGOÀI MÙA THU HOẠCH
 *      Rơm đi từ Hub về nhà máy bằng sà lan 1.000 hoặc 2.000 tấn, CHỞ ĐẦY TẢI.
 *      Sà lan chỉ rời Hub khi gom đủ một chuyến đầy; trường hợp duy nhất chấp
 *      nhận chở non tải là "dọn kho cuối kỳ" khi nhà máy sắp hết nguyên liệu và
 *      toàn mạng lưới không còn đủ hàng cho một chuyến đầy.
 *
 *  (3) CÔNG SUẤT HUB = LƯỢNG TỒN KHO RƠM TỐI ĐA Hub có thể chứa (tấn), KHÔNG
 *      phải sản lượng thông qua hàng năm. Rơm vượt sức chứa là rơm KHÔNG THU
 *      GOM ĐƯỢC — mô hình ghi nhận rõ thay vì âm thầm bỏ qua.
 *
 * Mô hình chạy theo bước thời gian NGÀY trên 2 năm liên tiếp giống nhau và chỉ
 * lấy kết quả NĂM THỨ HAI. Năm thứ nhất đóng vai trò khởi động (warm-up) để tồn
 * kho đầu kỳ phản ánh trạng thái vận hành ổn định, thay vì giả định Hub rỗng
 * vào ngày 01/01 — giả định đó sẽ tạo ra một đợt thiếu hụt giả trong quý I.
 *
 * Kết quả của mô hình thay thế heuristic "Peak Inventory = Sản lượng năm × hệ
 * số tồn kho cao điểm" của FN-09 BR-02 (rủi ro RS-06 trong BRD).
 */
import { all } from '../../platform/db/db.ts';
import type { SimulationParams } from '../params/store.ts';

const DAYS_PER_YEAR = 365;
/** Số ngày dự phòng tồn kho tại nhà máy trước khi phát lệnh một chuyến sà lan. */
const PLANT_REORDER_DAYS = 5;
/** Chặn vòng lặp điều phối sà lan trong ngày (an toàn, không phải giới hạn nghiệp vụ). */
const MAX_DISPATCH_PER_DAY = 12;

// =====================================================================
// Lịch thu hoạch theo ngày
// =====================================================================

export interface DayWeight {
  dayOfYear: number;
  weight: number;
}

export interface SeasonCalendar {
  seasonId: string;
  seasonCode: string;
  seasonName: string;
  /** thuc_te = lấy từ file điều tra vụ mùa; suy_dien = suy từ tháng kết thúc vụ. */
  source: 'thuc_te' | 'suy_dien';
  sourceLabel: string;
  days: DayWeight[];
  firstDayOfYear: number;
  lastDayOfYear: number;
}

interface SeasonRow {
  id: string;
  code: string;
  name: string;
  start_month: number;
  end_month: number;
  sort_order: number;
}

interface ObservedRow {
  season_code: string;
  day: string;
  tons: number;
}

const MONTH_START = [0, 1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const MONTH_LENGTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Chuyển ngày ISO thành thứ tự ngày trong năm 1..365 (gộp 29/02 vào 28/02). */
export function dayOfYear(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > MONTH_LENGTH[month]) {
    if (month === 2 && day === 29) return MONTH_START[2] + 27;
    return null;
  }
  return MONTH_START[month] + day - 1;
}

/** Ngày thứ n trong năm thành nhãn dd/mm. */
export function dayLabel(doy: number): string {
  const month = monthOfDay(doy);
  const day = doy - MONTH_START[month] + 1;
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`;
}

export function monthOfDay(doy: number): number {
  for (let m = 1; m <= 12; m += 1) {
    if (doy < MONTH_START[m] + MONTH_LENGTH[m]) return m;
  }
  return 12;
}

/**
 * Dựng lịch thu hoạch cho từng mùa vụ.
 *
 * Ưu tiên 1 — dữ liệu thực tế: file điều tra vụ mùa (App Khuyến nông) ghi nhận
 * tiến độ thu hoạch theo từng mốc ngày. Khi có, phân bố sản lượng theo đúng
 * đường cong đó.
 * Ưu tiên 2 — suy diễn: thu hoạch rộ trong `harvest_window_days` ngày cuối của
 * tháng kết thúc vụ, phân bố hình thang (vào vụ tăng dần, cuối vụ giảm dần).
 *
 * Lịch thực tế được dùng chung cho các vụ CÙNG LOẠI (cùng tiền tố mã DX/HT/TD),
 * vì file điều tra thường chỉ có một vụ trong khi thống kê sản lượng lại trải
 * trên nhiều vụ.
 */
export function buildHarvestCalendar(params: SimulationParams): Map<string, SeasonCalendar> {
  const seasons = all<SeasonRow>('SELECT id, code, name, start_month, end_month, sort_order FROM seasons');

  // Đường cong thực tế: ưu tiên bảng tiến độ (nhiều mốc ngày trong vụ).
  const progress = all<ObservedRow>(
    `SELECT s.code AS season_code, p.as_of_date AS day, SUM(p.output_tons) AS tons
       FROM commune_harvest_progress p
       JOIN commune_crop_seasons c ON c.id = p.commune_season_id
       JOIN seasons s ON s.id = c.season_id
      WHERE p.output_tons > 0
      GROUP BY s.code, p.as_of_date`,
  );
  const harvestDates = all<ObservedRow>(
    `SELECT s.code AS season_code, c.harvest_date AS day, SUM(c.output_tons) AS tons
       FROM commune_crop_seasons c
       JOIN seasons s ON s.id = c.season_id
      WHERE c.harvest_date IS NOT NULL AND c.output_tons > 0
      GROUP BY s.code, c.harvest_date`,
  );

  const byType = new Map<string, DayWeight[]>();
  const collect = (rows: ObservedRow[]) => {
    for (const row of rows) {
      const doy = dayOfYear(row.day);
      if (doy === null || !(row.tons > 0)) continue;
      const type = seasonType(row.season_code);
      const list = byType.get(type);
      if (list) list.push({ dayOfYear: doy, weight: row.tons });
      else byType.set(type, [{ dayOfYear: doy, weight: row.tons }]);
    }
  };
  collect(progress);
  for (const row of harvestDates) {
    if (byType.has(seasonType(row.season_code))) continue;
    collect([row]);
  }
  // File điều tra ghi nhận theo ĐỢT (thường mỗi tuần một lần): con số của ngày
  // 21/04 là sản lượng thu hoạch của cả kỳ từ sau đợt trước đến 21/04, không
  // phải rơm rơi xuống trong đúng một ngày. Nếu để nguyên, mô hình sẽ thấy một
  // đỉnh 26.000 tấn trong một ngày và kết luận sai rằng hầu như không thể chở
  // thẳng về nhà máy. Vì vậy trải đều mỗi quan sát ra khoảng thời gian nó đại diện.
  for (const [type, points] of byType) {
    byType.set(type, spreadObservations(mergeWeights(points)));
  }

  const calendar = new Map<string, SeasonCalendar>();
  for (const season of seasons) {
    const observed = byType.get(seasonType(season.code));
    const days = observed && observed.length ? mergeWeights(observed) : derivedWindow(season, params);
    const normalized = normalizeWeights(days);
    calendar.set(season.id, {
      seasonId: season.id,
      seasonCode: season.code,
      seasonName: season.name,
      source: observed && observed.length ? 'thuc_te' : 'suy_dien',
      sourceLabel: observed && observed.length
        ? 'Ngày thu hoạch thực tế từ file điều tra vụ mùa'
        : `Suy diễn: ${params.harvestWindowDays} ngày cuối tháng ${season.end_month}`,
      days: normalized,
      firstDayOfYear: normalized[0]?.dayOfYear ?? 1,
      lastDayOfYear: normalized[normalized.length - 1]?.dayOfYear ?? 1,
    });
  }
  return calendar;
}

function seasonType(code: string): string {
  return code.split('-')[0].toUpperCase();
}

/**
 * Trải đều sản lượng của mỗi đợt điều tra ra các ngày kể từ sau đợt liền trước.
 * Đợt đầu tiên dùng khoảng cách trung vị của các đợt sau (mặc định 7 ngày).
 */
function spreadObservations(points: DayWeight[]): DayWeight[] {
  if (points.length <= 1) return points;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i += 1) gaps.push(points[i].dayOfYear - points[i - 1].dayOfYear);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const medianGap = Math.max(1, Math.min(21, sorted[Math.floor(sorted.length / 2)] ?? 7));

  const spread: DayWeight[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = i > 0 ? points[i - 1].dayOfYear : points[i].dayOfYear - medianGap;
    // Khoảng cách bất thường (đứt quãng giữa hai vụ) thì không trải quá rộng.
    const span = Math.max(1, Math.min(21, points[i].dayOfYear - previous));
    const share = points[i].weight / span;
    for (let offset = 0; offset < span; offset += 1) {
      let doy = points[i].dayOfYear - offset;
      while (doy < 1) doy += DAYS_PER_YEAR;
      spread.push({ dayOfYear: doy, weight: share });
    }
  }
  return mergeWeights(spread);
}

function mergeWeights(list: DayWeight[]): DayWeight[] {
  const map = new Map<number, number>();
  for (const item of list) map.set(item.dayOfYear, (map.get(item.dayOfYear) ?? 0) + item.weight);
  return [...map.entries()]
    .map(([doy, weight]) => ({ dayOfYear: doy, weight }))
    .sort((a, b) => a.dayOfYear - b.dayOfYear);
}

/** Cửa sổ thu hoạch suy diễn: hình thang trên N ngày cuối tháng kết thúc vụ. */
function derivedWindow(season: SeasonRow, params: SimulationParams): DayWeight[] {
  const endMonth = Math.min(12, Math.max(1, season.end_month));
  const endDay = MONTH_START[endMonth] + MONTH_LENGTH[endMonth] - 1;
  const width = Math.max(1, params.harvestWindowDays);
  const days: DayWeight[] = [];
  for (let offset = width - 1; offset >= 0; offset -= 1) {
    let doy = endDay - offset;
    while (doy < 1) doy += DAYS_PER_YEAR;
    // Hình thang: 25% đầu tăng dần, 50% giữa cao nhất, 25% cuối giảm dần.
    const position = (width - 1 - offset) / Math.max(width - 1, 1);
    const weight = position < 0.25 ? 0.4 + position * 2.4 : position > 0.75 ? 0.4 + (1 - position) * 2.4 : 1;
    days.push({ dayOfYear: doy, weight });
  }
  return mergeWeights(days);
}

function normalizeWeights(days: DayWeight[]): DayWeight[] {
  const total = days.reduce((acc, item) => acc + item.weight, 0);
  if (total <= 0) return days.map((item) => ({ dayOfYear: item.dayOfYear, weight: 0 }));
  return days.map((item) => ({ dayOfYear: item.dayOfYear, weight: item.weight / total }));
}

// =====================================================================
// Đầu vào / đầu ra của mô hình dòng chảy
// =====================================================================

export interface FlowSupplier {
  htxId: string;
  code: string;
  name: string;
  /** Hub được gán theo FN-05 BR-02; null = nằm ngoài mọi vùng phục vụ. */
  hubKey: string | null;
  distanceToHubKm: number;
  distanceToPlantKm: number;
  /** Sản lượng rơm thu gom được (Collectable) theo từng mùa vụ. */
  seasonTons: { seasonId: string; collectableTons: number }[];
}

export interface FlowHubInput {
  key: string;
  code: string;
  name: string;
  /** Công suất Hub = TỒN KHO TỐI ĐA (tấn rơm đã băm/nén). */
  maxInventoryTons: number;
  distanceToPlantKm: number;
  /** Tải trọng sà lan dùng cho chặng Hub đến Nhà máy (1.000 hoặc 2.000 tấn). */
  bargePayloadTons: number;
}

export interface FlowHubResult {
  key: string;
  code: string;
  name: string;
  maxInventoryTons: number;
  bargePayloadTons: number;
  receivedFromFieldTons: number;
  storedAfterProcessingTons: number;
  processingLossTons: number;
  shippedToPlantTons: number;
  peakInventoryTons: number;
  peakInventoryDayLabel: string;
  averageInventoryTons: number;
  endingInventoryTons: number;
  /** Rơm không vào được Hub vì kho đã đầy. */
  overflowTons: number;
  daysAtCapacity: number;
  utilizationPct: number;
  fullBargeTrips: number;
  partialBargeTrips: number;
  fieldHubTonKm: number;
  hubPlantTonKm: number;
  /** Đường cong tồn kho 365 ngày (tấn) — dùng để vẽ biểu đồ. */
  inventoryCurve: number[];
  warnings: string[];
}

export interface FlowMonthRow {
  month: number;
  label: string;
  harvestTons: number;
  directToPlantTons: number;
  toHubTons: number;
  hubToPlantTons: number;
  plantConsumedTons: number;
  plantUnmetTons: number;
  hubInventoryEndTons: number;
  uncollectedTons: number;
}

export interface FlowResult {
  /** Số ngày trong năm có rơm thu hoạch tại ruộng. */
  harvestDays: number;
  noHarvestDays: number;
  harvestWindows: { fromLabel: string; toLabel: string; days: number; tons: number }[];
  calendarSources: { seasonName: string; source: 'thuc_te' | 'suy_dien'; sourceLabel: string }[];

  plantDailyDemandTons: number;
  plantOperatingDays: number;
  plantReceivedTons: number;
  plantConsumedTons: number;
  plantUnmetTons: number;
  plantUnmetDays: number;
  plantPeakStockTons: number;
  coveragePct: number;

  /** Tấn rơm (cơ sở Collectable) đi thẳng Ruộng đến Nhà máy bằng ghe. */
  directFieldPlantTons: number;
  /** Tấn rơm đi Ruộng đến Hub bằng ghe. */
  fieldHubTons: number;
  /** Tấn rơm đã băm/nén xuất từ Hub về Nhà máy bằng sà lan. */
  hubPlantTons: number;
  /** Rơm bỏ lại tại ruộng vì Hub đầy hoặc không có Hub trong vùng. */
  uncollectedTons: number;
  uncollectedPct: number;

  directFieldPlantTonKm: number;
  fieldHubTonKm: number;
  hubPlantTonKm: number;

  boatTripsDirect: number;
  boatTripsToHub: number;
  bargeTripsFull: number;
  bargeTripsPartial: number;

  /** Tổng tồn kho cao điểm toàn mạng lưới — thay thế heuristic FN-09 BR-02. */
  networkPeakInventoryTons: number;
  hubs: FlowHubResult[];
  months: FlowMonthRow[];
  warnings: string[];
  notes: string[];
}

interface HubState {
  key: string;
  code: string;
  name: string;
  maxInventoryTons: number;
  distanceToPlantKm: number;
  bargePayloadTons: number;
  inventory: number;
  received: number;
  stored: number;
  shipped: number;
  overflow: number;
  peak: number;
  peakDay: number;
  inventorySum: number;
  daysAtCapacity: number;
  fullTrips: number;
  partialTrips: number;
  fieldHubTonKm: number;
  hubPlantTonKm: number;
  curve: number[];
}

// =====================================================================
// Bộ mô phỏng
// =====================================================================

export function simulateFlow(input: {
  suppliers: FlowSupplier[];
  hubs: FlowHubInput[];
  plantAnnualDemandTons: number;
  params: SimulationParams;
  calendar: Map<string, SeasonCalendar>;
}): FlowResult {
  const { params, calendar } = input;
  const lossKeep = 1 - clamp01(params.lossRatio);
  const processKeep = 1 - clamp01(params.hubProcessingLossRatio);

  // ---- Đường cong nguồn cung theo ngày cho từng HTX ----
  const supplyByDay = new Map<string, Float64Array>();
  const networkSupply = new Float64Array(DAYS_PER_YEAR + 1);
  for (const supplier of input.suppliers) {
    const curve = new Float64Array(DAYS_PER_YEAR + 1);
    for (const entry of supplier.seasonTons) {
      const season = calendar.get(entry.seasonId);
      if (!season || entry.collectableTons <= 0) continue;
      for (const day of season.days) {
        curve[day.dayOfYear] += entry.collectableTons * day.weight;
      }
    }
    supplyByDay.set(supplier.htxId, curve);
    for (let d = 1; d <= DAYS_PER_YEAR; d += 1) networkSupply[d] += curve[d];
  }

  // Ưu tiên chở thẳng cho HTX GẦN nhà máy nhất — chuyến ghe rẻ nhất dùng trước.
  const suppliers = input.suppliers.slice().sort((a, b) => a.distanceToPlantKm - b.distanceToPlantKm);

  const hubStates: HubState[] = input.hubs.map((hub) => ({
    key: hub.key,
    code: hub.code,
    name: hub.name,
    maxInventoryTons: hub.maxInventoryTons,
    distanceToPlantKm: hub.distanceToPlantKm,
    bargePayloadTons: hub.bargePayloadTons,
    inventory: 0, received: 0, stored: 0, shipped: 0, overflow: 0,
    peak: 0, peakDay: 1, inventorySum: 0, daysAtCapacity: 0,
    fullTrips: 0, partialTrips: 0, fieldHubTonKm: 0, hubPlantTonKm: 0,
    curve: new Array<number>(DAYS_PER_YEAR + 1).fill(0),
  }));
  const hubByKey = new Map(hubStates.map((hub) => [hub.key, hub]));

  const operatingDays = buildOperatingCalendar(params.plantOperatingDays);
  const dailyDemand = operatingDays.count > 0 ? input.plantAnnualDemandTons / operatingDays.count : 0;
  const reorderPoint = dailyDemand * PLANT_REORDER_DAYS;

  const months: FlowMonthRow[] = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    label: `Tháng ${index + 1}`,
    harvestTons: 0, directToPlantTons: 0, toHubTons: 0, hubToPlantTons: 0,
    plantConsumedTons: 0, plantUnmetTons: 0, hubInventoryEndTons: 0, uncollectedTons: 0,
  }));

  let plantStock = 0;
  let plantPeakStock = 0;
  let directTons = 0;
  let fieldHubTons = 0;
  let hubPlantTons = 0;
  let uncollectedTons = 0;
  let directTonKm = 0;
  let plantReceived = 0;
  let plantConsumed = 0;
  let plantUnmet = 0;
  let plantUnmetDays = 0;
  let harvestDays = 0;

  const totalSteps = DAYS_PER_YEAR * 2;
  for (let step = 1; step <= totalSteps; step += 1) {
    const doy = ((step - 1) % DAYS_PER_YEAR) + 1;
    const record = step > DAYS_PER_YEAR; // chỉ ghi kết quả năm thứ hai
    const row = months[monthOfDay(doy) - 1];
    const operating = operatingDays.flags[doy];
    const demandToday = operating ? dailyDemand : 0;

    if (record && networkSupply[doy] > 1e-9) harvestDays += 1;

    // ---------------- (1) Rơm rời ruộng ----------------
    // Ưu tiên chở thẳng về nhà máy, trần đúng bằng lượng tiêu thụ trong ngày.
    let directBudget = demandToday;
    for (const supplier of suppliers) {
      const available = supplyByDay.get(supplier.htxId)![doy];
      if (available <= 1e-9) continue;
      if (record) row.harvestTons += available;

      let remaining = available;

      if (directBudget > 1e-9 && lossKeep > 0) {
        const arrive = Math.min(remaining * lossKeep, directBudget);
        const shipped = arrive / lossKeep;
        remaining -= shipped;
        directBudget -= arrive;
        plantStock += arrive;
        if (record) {
          directTons += shipped;
          directTonKm += shipped * supplier.distanceToPlantKm;
          plantReceived += arrive;
          row.directToPlantTons += shipped;
        }
      }

      if (remaining <= 1e-9) continue;

      // ---------------- (2) Phần vượt chuyển về Hub ----------------
      const hub = supplier.hubKey ? hubByKey.get(supplier.hubKey) : undefined;
      if (!hub || hub.maxInventoryTons <= 0 || processKeep <= 0) {
        if (record) { uncollectedTons += remaining; row.uncollectedTons += remaining; }
        continue;
      }
      const space = Math.max(0, hub.maxInventoryTons - hub.inventory);
      const stored = Math.min(remaining * processKeep, space);
      const accepted = stored / processKeep;
      const rejected = remaining - accepted;
      hub.inventory += stored;
      if (record) {
        hub.received += accepted;
        hub.stored += stored;
        hub.fieldHubTonKm += accepted * supplier.distanceToHubKm;
        fieldHubTons += accepted;
        row.toHubTons += accepted;
        if (rejected > 1e-9) {
          hub.overflow += rejected;
          uncollectedTons += rejected;
          row.uncollectedTons += rejected;
        }
      }
    }

    // ---------------- (3) Nhà máy tiêu thụ ----------------
    const consumed = Math.min(plantStock, demandToday);
    plantStock -= consumed;
    if (record) {
      plantConsumed += consumed;
      row.plantConsumedTons += consumed;
      const shortfall = demandToday - consumed;
      if (shortfall > 1e-6) {
        plantUnmet += shortfall;
        plantUnmetDays += 1;
        row.plantUnmetTons += shortfall;
      }
    }

    // ---------------- (4) Sà lan Hub đến Nhà máy, CHỞ ĐẦY TẢI ----------------
    // Chỉ phát lệnh khi lượng rơm chở thẳng dự kiến những ngày tới không đủ nuôi
    // nhà máy — nhờ vậy trong mùa thu hoạch rộ sà lan gần như nằm im.
    const expectedDirect = lookaheadDirect(networkSupply, operatingDays.flags, doy, dailyDemand, lossKeep);
    // Mức tồn kho mục tiêu tại nhà máy: bình thường là PLANT_REORDER_DAYS ngày,
    // trừ đi phần rơm chở thẳng dự kiến nhận được. Nhưng dù rơm chở thẳng có dồi
    // dào tới đâu, nhà máy vẫn phải luôn giữ tối thiểu MỘT ngày nguyên liệu —
    // nếu không, một ngày đứt quãng giữa hai đợt gặt là nhà máy dừng máy.
    const targetStock = Math.max(dailyDemand, reorderPoint - expectedDirect);
    let dispatched = 0;
    while (plantStock < targetStock && dispatched < MAX_DISPATCH_PER_DAY) {
      const hub = pickHub(hubStates);
      if (!hub) break;
      const payload = Math.max(1, hub.bargePayloadTons);
      let load: number;
      if (hub.inventory >= payload) {
        load = payload;
        if (record) hub.fullTrips += 1;
      } else {
        // Non tải chỉ chấp nhận khi nhà máy sắp đứt nguyên liệu ("dọn kho cuối
        // kỳ"). Sà lan bốc hàng tại MỘT Hub, mà pickHub đã trả về Hub có tồn kho
        // lớn nhất — nếu Hub đó không đủ một chuyến đầy thì không Hub nào đủ,
        // nên không có lý do chờ thêm.
        const starving = plantStock + expectedDirect < dailyDemand;
        if (!starving) break;
        load = hub.inventory;
        if (record) hub.partialTrips += 1;
      }
      hub.inventory -= load;
      const arrive = load * lossKeep;
      plantStock += arrive;
      dispatched += 1;
      if (record) {
        hub.shipped += load;
        hub.hubPlantTonKm += load * hub.distanceToPlantKm;
        hubPlantTons += load;
        plantReceived += arrive;
        row.hubToPlantTons += load;
      }
    }

    // ---------------- Ghi nhận tồn kho ----------------
    if (record) {
      for (const hub of hubStates) {
        hub.curve[doy] = hub.inventory;
        hub.inventorySum += hub.inventory;
        if (hub.inventory > hub.peak) { hub.peak = hub.inventory; hub.peakDay = doy; }
        if (hub.maxInventoryTons > 0 && hub.inventory >= hub.maxInventoryTons - 1e-6) {
          hub.daysAtCapacity += 1;
        }
      }
      if (plantStock > plantPeakStock) plantPeakStock = plantStock;
      row.hubInventoryEndTons = hubStates.reduce((acc, hub) => acc + hub.inventory, 0);
    }
  }

  // ---- Tổng hợp ----
  const hubResults: FlowHubResult[] = hubStates.map((hub) => {
    const warnings: string[] = [];
    const utilization = hub.maxInventoryTons > 0 ? (hub.peak / hub.maxInventoryTons) * 100 : 0;
    if (hub.daysAtCapacity > 0) {
      warnings.push(
        `${hub.name}: kho đầy ${hub.daysAtCapacity} ngày trong năm, phải bỏ lại ` +
        `${fmt(hub.overflow)} tấn rơm tại ruộng — cần tăng sức chứa hoặc xuất kho sớm hơn.`,
      );
    } else if (hub.maxInventoryTons > 0 && utilization < 45) {
      warnings.push(
        `${hub.name}: tồn kho cao điểm chỉ đạt ${utilization.toFixed(1)}% sức chứa ` +
        `(${fmt(hub.peak)}/${fmt(hub.maxInventoryTons)} tấn) — kho đang được đầu tư dư.`,
      );
    }
    if (hub.partialTrips > 0) {
      warnings.push(
        `${hub.name}: có ${hub.partialTrips} chuyến sà lan non tải (dọn kho cuối kỳ) — ` +
        'chi phí mỗi tấn của các chuyến này cao hơn định mức.',
      );
    }
    return {
      key: hub.key,
      code: hub.code,
      name: hub.name,
      maxInventoryTons: round(hub.maxInventoryTons),
      bargePayloadTons: hub.bargePayloadTons,
      receivedFromFieldTons: round(hub.received),
      storedAfterProcessingTons: round(hub.stored),
      processingLossTons: round(hub.received - hub.stored),
      shippedToPlantTons: round(hub.shipped),
      peakInventoryTons: round(hub.peak),
      peakInventoryDayLabel: dayLabel(hub.peakDay),
      averageInventoryTons: round(hub.inventorySum / DAYS_PER_YEAR),
      endingInventoryTons: round(hub.inventory),
      overflowTons: round(hub.overflow),
      daysAtCapacity: hub.daysAtCapacity,
      utilizationPct: round(utilization, 2),
      fullBargeTrips: hub.fullTrips,
      partialBargeTrips: hub.partialTrips,
      fieldHubTonKm: round(hub.fieldHubTonKm),
      hubPlantTonKm: round(hub.hubPlantTonKm),
      inventoryCurve: hub.curve.slice(1).map((value) => round(value)),
      warnings,
    };
  });

  const harvestWindows = buildWindows(networkSupply);
  const boatPayload = Math.max(1, params.boatStrawPayloadTons);
  const totalCollectable = input.suppliers.reduce(
    (acc, supplier) => acc + supplier.seasonTons.reduce((inner, item) => inner + item.collectableTons, 0),
    0,
  );

  const warnings: string[] = hubResults.flatMap((hub) => hub.warnings);
  if (plantUnmet > 1e-3) {
    warnings.push(
      `Nhà máy thiếu nguyên liệu ${plantUnmetDays} ngày trong năm ` +
      `(${fmt(plantUnmet)} tấn) — mạng lưới chưa đủ nuôi nhà máy liên tục.`,
    );
  }
  if (uncollectedTons > 1e-3) {
    warnings.push(
      `${fmt(uncollectedTons)} tấn rơm phải bỏ lại tại ruộng ` +
      `(${((uncollectedTons / Math.max(totalCollectable, 1)) * 100).toFixed(1)}% sản lượng thu gom được) ` +
      'vì Hub đã đầy hoặc vùng nguyên liệu nằm ngoài mọi bán kính phục vụ.',
    );
  }

  return {
    harvestDays,
    noHarvestDays: DAYS_PER_YEAR - harvestDays,
    harvestWindows,
    calendarSources: [...calendar.values()].map((season) => ({
      seasonName: season.seasonName,
      source: season.source,
      sourceLabel: season.sourceLabel,
    })),

    plantDailyDemandTons: round(dailyDemand, 2),
    plantOperatingDays: operatingDays.count,
    plantReceivedTons: round(plantReceived),
    plantConsumedTons: round(plantConsumed),
    plantUnmetTons: round(plantUnmet),
    plantUnmetDays,
    plantPeakStockTons: round(plantPeakStock),
    coveragePct: input.plantAnnualDemandTons > 0
      ? round((plantConsumed / input.plantAnnualDemandTons) * 100, 2)
      : 0,

    directFieldPlantTons: round(directTons),
    fieldHubTons: round(fieldHubTons),
    hubPlantTons: round(hubPlantTons),
    uncollectedTons: round(uncollectedTons),
    uncollectedPct: totalCollectable > 0 ? round((uncollectedTons / totalCollectable) * 100, 2) : 0,

    directFieldPlantTonKm: round(directTonKm),
    fieldHubTonKm: round(sum(hubResults.map((hub) => hub.fieldHubTonKm))),
    hubPlantTonKm: round(sum(hubResults.map((hub) => hub.hubPlantTonKm))),

    boatTripsDirect: Math.ceil(directTons / boatPayload),
    boatTripsToHub: Math.ceil(fieldHubTons / boatPayload),
    bargeTripsFull: sum(hubResults.map((hub) => hub.fullBargeTrips)),
    bargeTripsPartial: sum(hubResults.map((hub) => hub.partialBargeTrips)),

    networkPeakInventoryTons: round(sum(hubResults.map((hub) => hub.peakInventoryTons))),
    hubs: hubResults,
    months: months.map((row) => ({
      month: row.month,
      label: row.label,
      harvestTons: round(row.harvestTons),
      directToPlantTons: round(row.directToPlantTons),
      toHubTons: round(row.toHubTons),
      hubToPlantTons: round(row.hubToPlantTons),
      plantConsumedTons: round(row.plantConsumedTons),
      plantUnmetTons: round(row.plantUnmetTons),
      hubInventoryEndTons: round(row.hubInventoryEndTons),
      uncollectedTons: round(row.uncollectedTons),
    })),
    warnings,
    notes: [
      `Ghe ${fmt(params.boatRegisteredTons)} tấn chở ${fmt(params.boatStrawPayloadTons)} tấn rơm rời — ` +
        'dùng cho cả chặng Ruộng đến Nhà máy và Ruộng đến Hub trong mùa thu hoạch.',
      'Rơm chở thẳng Ruộng đến Nhà máy bị giới hạn đúng bằng lượng tiêu thụ trong ngày của nhà máy; ' +
        'phần vượt được đưa về Hub để lưu trữ.',
      'Sà lan Hub đến Nhà máy chỉ rời bến khi đủ một chuyến đầy tải; chuyến non tải chỉ xảy ra khi ' +
        'dọn kho cuối kỳ và được đếm riêng.',
      'Số chuyến ghe tính trên tổng sản lượng cả năm (giả định ghe gom nhiều HTX trong một chuyến), ' +
        'không ép tròn theo từng HTX từng ngày.',
      'Mô hình chạy 2 năm liên tiếp và chỉ lấy năm thứ hai để tồn kho đầu kỳ phản ánh vận hành ổn định.',
      `Tồn kho cao điểm tại bãi tập kết của nhà máy trong năm là ${fmt(plantPeakStock)} tấn — ` +
        'dùng để kiểm tra sức chứa đầu nhận của nhà máy.',
    ],
  };
}

// =====================================================================
// Tiện ích
// =====================================================================

function buildOperatingCalendar(operatingDays: number): { flags: boolean[]; count: number } {
  const target = Math.min(DAYS_PER_YEAR, Math.max(1, Math.round(operatingDays)));
  const off = DAYS_PER_YEAR - target;
  const flags = new Array<boolean>(DAYS_PER_YEAR + 1).fill(true);
  let count = DAYS_PER_YEAR;
  if (off > 0) {
    // Rải đều ngày dừng máy trong năm thay vì dồn vào cuối năm.
    for (let d = 1; d <= DAYS_PER_YEAR; d += 1) {
      if (Math.floor(((d - 1) * off) / DAYS_PER_YEAR) !== Math.floor((d * off) / DAYS_PER_YEAR)) {
        flags[d] = false;
        count -= 1;
      }
    }
  }
  return { flags, count };
}

/** Lượng rơm chở thẳng dự kiến nhận được trong PLANT_REORDER_DAYS ngày tới. */
function lookaheadDirect(
  networkSupply: Float64Array,
  flags: boolean[],
  doy: number,
  dailyDemand: number,
  lossKeep: number,
): number {
  let total = 0;
  for (let offset = 1; offset <= PLANT_REORDER_DAYS; offset += 1) {
    const day = ((doy - 1 + offset) % DAYS_PER_YEAR) + 1;
    if (!flags[day]) continue;
    total += Math.min(networkSupply[day] * lossKeep, dailyDemand);
  }
  return total;
}

/** Xuất kho từ Hub có tồn kho lớn nhất — giải phóng sức chứa ở nơi căng nhất trước. */
function pickHub(hubs: HubState[]): HubState | null {
  let best: HubState | null = null;
  for (const hub of hubs) {
    if (hub.inventory <= 1e-6) continue;
    if (!best || hub.inventory > best.inventory) best = hub;
  }
  return best;
}

/** Gom các ngày có thu hoạch thành các đợt liên tục để hiển thị. */
function buildWindows(supply: Float64Array): FlowResult['harvestWindows'] {
  const windows: FlowResult['harvestWindows'] = [];
  let start = 0;
  let tons = 0;
  let days = 0;
  const flush = (end: number) => {
    if (!start) return;
    windows.push({ fromLabel: dayLabel(start), toLabel: dayLabel(end), days, tons: round(tons) });
    start = 0; tons = 0; days = 0;
  };
  for (let d = 1; d <= DAYS_PER_YEAR; d += 1) {
    if (supply[d] > 1e-9) {
      if (!start) start = d;
      tons += supply[d];
      days += 1;
    } else if (start) {
      flush(d - 1);
    }
  }
  flush(DAYS_PER_YEAR);
  return windows;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sum(list: number[]): number {
  return list.reduce((acc, value) => acc + value, 0);
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value: number): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(value);
}
