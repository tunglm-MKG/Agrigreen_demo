/**
 * ĐỐI CHIẾU GIẢ ĐỊNH – THỰC TẾ.
 *
 * Mô phỏng đầu tư Hub chạy trên 57 tham số, phần lớn là giả định có quy trình
 * phê duyệt tốt. Nhưng hệ thống nay đã có SỐ THẬT cho một phần trong đó — từ
 * ghe đã cân, chuyến đã chạy, ruộng đã cuộn — mà chưa màn hình nào đặt hai cột
 * cạnh nhau. Không đối chiếu thì mô phỏng không bao giờ tự tốt lên.
 *
 * Nguyên tắc:
 *   - Mỗi tham số có MỘT cách đo thực tế, viết rõ cơ sở tính và cỡ mẫu. Không đủ
 *     mẫu thì nói "chưa đủ dữ liệu", không đưa ra một con số từ hai quan sát.
 *   - Số thực tế chỉ là ĐỀ XUẤT. Bấm "Đề xuất giá trị mới" ghi vào tham số qua
 *     đúng `updateParameter` — phê duyệt cũ mất hiệu lực, Tài chính duyệt lại
 *     theo đúng luồng FN-01 BR-02 đã có. Hệ thống không tự đổi giả định.
 *   - Không dùng số ước làm số thật: ghe chưa cân không tính vào tải trọng ghe;
 *     chuyến lấy chi phí theo đơn giá không tính vào cước thực.
 */
import { all, one } from '../../platform/db/db.ts';
import { today } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { notify } from '../../platform/notify/service.ts';
import { getParameter, listParameters, updateParameter, type ParameterRecord } from './store.ts';

export type Fit = 'khop' | 'lech_nhe' | 'lech_lon' | 'chua_du_du_lieu' | 'chua_co_gia_dinh';

export const FIT_LABEL: Record<Fit, string> = {
  khop: 'Khớp', lech_nhe: 'Lệch nhẹ', lech_lon: 'Lệch lớn',
  chua_du_du_lieu: 'Chưa đủ dữ liệu', chua_co_gia_dinh: 'Chưa có giả định',
};

/** Lệch ≤ 5 % coi là khớp; > 15 % là lệch lớn — cùng ngưỡng với đối soát cân ghe. */
export const FIT_THRESHOLDS = { minor: 5, major: 15 };

export interface Measurement {
  value: number | null;
  samples: number;
  sampleLabel: string;
  basis: string;
  /** Nguồn số liệu để người duyệt biết mình đang tin vào cái gì. */
  source: string;
}

export interface Comparison {
  code: string;
  number: number;
  name: string;
  unit: string | null;
  classification: string;
  assumed: number | null;
  valueMin: number | null;
  valueMax: number | null;
  approvedBy: string | null;
  approvedAt: string | null;
  actual: number | null;
  samples: number;
  minSamples: number;
  sampleLabel: string;
  basis: string;
  source: string;
  deviationPct: number | null;
  withinRange: boolean | null;
  fit: Fit;
  fitLabel: string;
  suggested: number | null;
}

type Measurer = (from: string, to: string) => Measurement;

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const bounds = (from: string, to: string) => [`${from}T00:00:00`, `${to}T23:59:59.999`];

// ---------------------------------------------------------------------------
// Cách đo từng tham số
// ---------------------------------------------------------------------------

const MEASURERS: Record<string, { minSamples: number; digits: number; measure: Measurer }> = {
  // #17 Hệ số rơm/lúa — từ khai báo sản lượng của nông dân trên App HTX.
  straw_to_paddy_ratio: {
    minSamples: 3, digits: 2,
    measure: (from, to) => {
      const row = one<{ straw: number | null; paddy: number | null; n: number }>(
        `SELECT SUM(straw_tons) AS straw, SUM(paddy_tons) AS paddy, COUNT(*) AS n FROM harvest_declarations
         WHERE harvest_date BETWEEN ? AND ? AND paddy_tons > 0 AND straw_tons > 0`, [from, to]);
      return {
        value: row?.paddy ? round(row.straw! / row.paddy, 3) : null, samples: row?.n ?? 0,
        sampleLabel: `${row?.n ?? 0} khai báo sản lượng`,
        basis: 'Σ tấn rơm ÷ Σ tấn lúa của các khai báo có cả hai số',
        source: 'App HTX — khai báo sản lượng',
      };
    },
  },
  // #18 Hệ số thu gom khả thi — rơm cuộn được so với rơm HTX báo có.
  collectable_ratio: {
    minSamples: 3, digits: 1,
    measure: (from, to) => {
      const row = one<{ baled: number | null; expected: number | null; n: number }>(
        `SELECT SUM(s.quantity_tons) AS baled, SUM(j.expected_straw_tons) AS expected, COUNT(*) AS n
         FROM field_jobs j JOIN field_job_stages s ON s.job_id = j.id AND s.stage = 'cuon_rom'
         WHERE j.status = 'hoan_thanh' AND j.harvest_confirmed = 1 AND j.expected_straw_tons > 0
           AND s.completed_at BETWEEN ? AND ?`, bounds(from, to));
      return {
        value: row?.expected ? round((row.baled! / row.expected) * 100, 1) : null, samples: row?.n ?? 0,
        sampleLabel: `${row?.n ?? 0} việc thu gom hoàn thành`,
        basis: 'Σ tấn đã cuộn ÷ Σ tấn rơm HTX xác nhận có (việc đã gặt thật) × 100',
        source: 'Hiện trường — công đoạn cuộn rơm',
      };
    },
  },
  // #19 Hao hụt — cuộn đếm ở ruộng so với cuộn đếm lại ở nhà máy.
  loss_ratio: {
    minSamples: 3, digits: 1,
    measure: (from, to) => {
      const row = one<{ field: number | null; plant: number | null; n: number }>(
        `SELECT SUM(bales) AS field, SUM(plant_bales) AS plant, COUNT(*) AS n FROM field_loadings
         WHERE weighed_at IS NOT NULL AND plant_bales IS NOT NULL AND bales > 0 AND loaded_at BETWEEN ? AND ?`, bounds(from, to));
      return {
        value: row?.field ? round(Math.max(0, (1 - row.plant! / row.field) * 100), 1) : null, samples: row?.n ?? 0,
        sampleLabel: `${row?.n ?? 0} lượt ghe có đếm lại cuộn ở nhà máy`,
        basis: '(Σ cuộn xuống ghe − Σ cuộn đếm lại ở nhà máy) ÷ Σ cuộn xuống ghe × 100 — hao hụt vật lý trên đường',
        source: 'Hiện trường — cân & đếm lại ở nhà máy',
      };
    },
  },
  // #22 / #23 Cước vận tải — chỉ chuyến có nhập chi phí thực, không lấy chuyến tính theo đơn giá.
  road_freight_rate: {
    minSamples: 3, digits: 0,
    measure: (from, to) => freightRate('road', from, to),
  },
  waterway_freight_rate: {
    minSamples: 3, digits: 0,
    measure: (from, to) => freightRate('waterway', from, to),
  },
  // #31 Công suất máy ép kiện — tấn cuộn mỗi máy-ngày, quy năm theo số ngày gặt rộ.
  bale_press_capacity: {
    minSamples: 5, digits: 0,
    measure: (from, to) => {
      const row = one<{ tons: number | null; machineDays: number }>(
        `SELECT SUM(quantity_tons) AS tons, COUNT(DISTINCT vehicle_id || substr(completed_at, 1, 10)) AS machineDays
         FROM field_job_stages WHERE stage = 'cuon_rom' AND vehicle_id IS NOT NULL AND quantity_tons > 0
           AND completed_at BETWEEN ? AND ?`, bounds(from, to));
      const window = getParameter('harvest_window_days')?.value_base ?? 45;
      const seasons = 3;
      const perDay = row?.machineDays ? row.tons! / row.machineDays : null;
      return {
        value: perDay === null ? null : round(perDay * window * seasons, 0), samples: row?.machineDays ?? 0,
        sampleLabel: `${row?.machineDays ?? 0} máy-ngày`,
        basis: `Tấn cuộn ÷ số máy-ngày (${perDay === null ? '—' : round(perDay, 1)} t/máy/ngày) × ${window} ngày gặt rộ (#57) × ${seasons} vụ`,
        source: 'Hiện trường — công đoạn cuộn rơm có ghi máy',
      };
    },
  },
  // #33 / #34 / #51 Tải trọng thực — chỉ lượt đã CÂN.
  truck_payload_tons: {
    minSamples: 3, digits: 1,
    measure: (from, to) => {
      const row = one<{ avg: number | null; n: number }>(
        `SELECT AVG(actual_tons) AS avg, COUNT(*) AS n FROM trips
         WHERE mode = 'road' AND status = 'hoan_thanh' AND actual_tons > 0 AND arrived_at BETWEEN ? AND ?`, bounds(from, to));
      return {
        value: row?.avg === null || row?.avg === undefined ? null : round(row.avg, 1), samples: row?.n ?? 0,
        sampleLabel: `${row?.n ?? 0} chuyến xe hoàn thành`, basis: 'Bình quân tấn thực chở của chuyến đường bộ đã hoàn thành',
        source: 'TMS — chuyến đường bộ',
      };
    },
  },
  barge_payload_tons: {
    minSamples: 3, digits: 0,
    measure: (from, to) => vesselPayload('sa_lan', from, to),
  },
  boat_straw_payload_tons: {
    minSamples: 3, digits: 1,
    measure: (from, to) => vesselPayload('ghe', from, to),
  },
  // #36 / #37 Tốc độ — chuyến có cả giờ đi và giờ đến.
  road_speed_kmh: { minSamples: 3, digits: 1, measure: (from, to) => speed('road', from, to) },
  waterway_speed_kmh: { minSamples: 3, digits: 1, measure: (from, to) => speed('waterway', from, to) },
  // #57 Số ngày gặt rộ — độ dài mặt trận gặt thật của từng HTX trong kỳ.
  harvest_window_days: {
    minSamples: 3, digits: 0,
    measure: (from, to) => {
      const rows = all<{ span: number }>(
        `SELECT julianday(MAX(harvest_date)) - julianday(MIN(harvest_date)) + 1 AS span FROM field_jobs
         WHERE harvest_confirmed = 1 AND status <> 'huy' AND harvest_date BETWEEN ? AND ?
         GROUP BY htx_id HAVING COUNT(DISTINCT harvest_date) >= 2`, [from, to]);
      const value = rows.length ? round(rows.reduce((s, r) => s + r.span, 0) / rows.length, 0) : null;
      return {
        value, samples: rows.length, sampleLabel: `${rows.length} HTX có ≥ 2 ngày gặt xác nhận`,
        basis: 'Bình quân (ngày gặt cuối − ngày gặt đầu + 1) của từng HTX, chỉ tính việc đã gặt thật',
        source: 'Hiện trường — ngày gặt xác nhận',
      };
    },
  },
};

function freightRate(mode: 'road' | 'waterway', from: string, to: string): Measurement {
  const row = one<{ cost: number | null; tonkm: number | null; n: number }>(
    `SELECT SUM(actual_cost) AS cost, SUM(actual_tons * distance_km) AS tonkm, COUNT(*) AS n FROM trips
     WHERE mode = ? AND status = 'hoan_thanh' AND actual_cost_source = 'nhap_tay'
       AND actual_tons > 0 AND distance_km > 0 AND arrived_at BETWEEN ? AND ?`, [mode, ...bounds(from, to)]);
  return {
    value: row?.tonkm ? round(row.cost! / row.tonkm, 0) : null, samples: row?.n ?? 0,
    sampleLabel: `${row?.n ?? 0} chuyến có nhập chi phí thực`,
    basis: 'Σ chi phí thực ÷ Σ (tấn × km) — bỏ chuyến lấy chi phí theo đơn giá giả định vì sẽ tự khớp',
    source: `TMS — chuyến ${mode === 'road' ? 'đường bộ' : 'đường thuỷ'} hoàn thành`,
  };
}

function vesselPayload(kind: 'ghe' | 'sa_lan', from: string, to: string): Measurement {
  const row = one<{ avg: number | null; n: number }>(
    `SELECT AVG(weighed_kg) / 1000 AS avg, COUNT(*) AS n FROM field_loadings
     WHERE vessel_kind = ? AND weighed_kg IS NOT NULL AND loaded_at BETWEEN ? AND ?`, [kind, ...bounds(from, to)]);
  return {
    value: row?.avg === null || row?.avg === undefined ? null : round(row.avg, 1), samples: row?.n ?? 0,
    sampleLabel: `${row?.n ?? 0} ${kind === 'ghe' ? 'ghe' : 'sà lan'} đã cân ở nhà máy`,
    basis: 'Bình quân khối lượng CÂN tại nhà máy của các lượt xuống ghe — không dùng số ước theo cuộn',
    source: 'Hiện trường — cân nhà máy',
  };
}

function speed(mode: 'road' | 'waterway', from: string, to: string): Measurement {
  const row = one<{ km: number | null; hours: number | null; n: number }>(
    `SELECT SUM(distance_km) AS km, SUM((julianday(arrived_at) - julianday(departed_at)) * 24) AS hours, COUNT(*) AS n FROM trips
     WHERE mode = ? AND status = 'hoan_thanh' AND departed_at IS NOT NULL AND arrived_at IS NOT NULL
       AND julianday(arrived_at) > julianday(departed_at) AND arrived_at BETWEEN ? AND ?`, [mode, ...bounds(from, to)]);
  return {
    value: row?.hours ? round(row.km! / row.hours, 1) : null, samples: row?.n ?? 0,
    sampleLabel: `${row?.n ?? 0} chuyến có giờ đi và giờ đến`,
    basis: 'Σ km ÷ Σ giờ chạy (từ xuất bến đến cập bến, gồm cả chờ)',
    source: `TMS — chuyến ${mode === 'road' ? 'đường bộ' : 'đường thuỷ'}`,
  };
}

// ---------------------------------------------------------------------------
// So sánh
// ---------------------------------------------------------------------------

export const COMPARABLE_CODES = Object.keys(MEASURERS);

function compareOne(parameter: ParameterRecord, from: string, to: string): Comparison {
  const spec = MEASURERS[parameter.code];
  const m = spec.measure(from, to);
  const enough = m.value !== null && m.samples >= spec.minSamples;
  const assumed = parameter.value_base;
  let deviationPct: number | null = null;
  let fit: Fit;
  if (!enough) fit = 'chua_du_du_lieu';
  else if (assumed === null || assumed === 0) fit = 'chua_co_gia_dinh';
  else {
    deviationPct = round(((m.value! - assumed) / Math.abs(assumed)) * 100, 1);
    const abs = Math.abs(deviationPct);
    fit = abs <= FIT_THRESHOLDS.minor ? 'khop' : abs <= FIT_THRESHOLDS.major ? 'lech_nhe' : 'lech_lon';
  }
  const withinRange = enough && parameter.value_min !== null && parameter.value_max !== null
    ? m.value! >= parameter.value_min && m.value! <= parameter.value_max
    : null;
  return {
    code: parameter.code, number: parameter.number, name: parameter.name, unit: parameter.unit,
    classification: parameter.classification, assumed, valueMin: parameter.value_min, valueMax: parameter.value_max,
    approvedBy: parameter.approved_by, approvedAt: parameter.approved_at,
    actual: enough ? round(m.value!, spec.digits) : m.value === null ? null : round(m.value, spec.digits),
    samples: m.samples, minSamples: spec.minSamples, sampleLabel: m.sampleLabel, basis: m.basis, source: m.source,
    deviationPct, withinRange, fit, fitLabel: FIT_LABEL[fit],
    suggested: enough ? round(m.value!, spec.digits) : null,
  };
}

export function compareAssumptions(days = 90, toDate = today()): {
  from: string; to: string; days: number; items: Comparison[];
  summary: { compared: number; withData: number; matching: number; minor: number; major: number; outOfRange: number; notComparable: number };
} {
  const from = new Date(new Date(`${toDate}T00:00:00Z`).getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const parameters = listParameters();
  const items = parameters.filter((p) => MEASURERS[p.code]).map((p) => compareOne(p, from, toDate))
    .sort((a, b) => a.number - b.number);
  const withData = items.filter((i) => i.fit !== 'chua_du_du_lieu' && i.fit !== 'chua_co_gia_dinh');
  return {
    from, to: toDate, days, items,
    summary: {
      compared: items.length, withData: withData.length,
      matching: withData.filter((i) => i.fit === 'khop').length,
      minor: withData.filter((i) => i.fit === 'lech_nhe').length,
      major: withData.filter((i) => i.fit === 'lech_lon').length,
      outOfRange: items.filter((i) => i.withinRange === false).length,
      notComparable: parameters.length - items.length,
    },
  };
}

/**
 * Đưa số thực tế thành giá trị ĐỀ XUẤT của tham số. Đi qua `updateParameter`
 * nên phê duyệt cũ mất hiệu lực và một phiên bản bộ tham số mới được sinh —
 * Tài chính duyệt lại theo luồng sẵn có. Không đủ dữ liệu thì từ chối.
 */
export function proposeFromActual(
  code: string,
  options: { days?: number; note?: string } = {},
  actor: AuditActor = {},
): { parameter: ParameterRecord; comparison: Comparison; previous: number | null } {
  const parameter = getParameter(code);
  if (!parameter) throw new Error(`Không tìm thấy tham số "${code}"`);
  if (!MEASURERS[code]) throw new Error(`Tham số "${parameter.name}" chưa có cách đo thực tế.`);
  const days = options.days ?? 90;
  const range = compareAssumptions(days);
  const comparison = compareOne(parameter, range.from, range.to);
  if (comparison.fit === 'chua_du_du_lieu') {
    throw new Error(
      `Chưa đủ dữ liệu cho "${parameter.name}": có ${comparison.samples}/${comparison.minSamples} mẫu (${comparison.sampleLabel}). Không đề xuất giá trị từ quá ít quan sát.`,
    );
  }
  if (comparison.fit === 'khop' && comparison.deviationPct !== null) {
    throw new Error(`"${parameter.name}" thực tế ${comparison.actual} lệch ${comparison.deviationPct} % so với giả định ${comparison.assumed} — trong ngưỡng khớp, không cần đổi.`);
  }
  const previous = parameter.value_base;
  const updated = updateParameter(code, {
    valueBase: comparison.suggested,
    dataSource: `Số liệu vận hành thực tế ${range.from} → ${range.to}: ${comparison.sampleLabel}. ${comparison.basis}`,
    sourceDate: today(),
    note: options.note ?? `Đề xuất từ đối chiếu giả định – thực tế (trước: ${previous ?? '—'}, thực tế ${comparison.actual}, lệch ${comparison.deviationPct ?? '—'} %)`,
  }, actor);
  logEvent({
    module: 'simulation', entityType: 'parameters', entityId: parameter.id, action: 'propose_from_actual',
    before: { value_base: previous }, after: { value_base: comparison.suggested, samples: comparison.samples, days },
  }, actor);
  notify({
    module: 'simulation', severity: 'warn',
    title: `Tham số #${parameter.number} chờ duyệt lại — đề xuất từ số thật`,
    body: `${parameter.name}: giả định ${previous ?? '—'} → thực tế ${comparison.actual} ${parameter.unit ?? ''} (${comparison.sampleLabel}, lệch ${comparison.deviationPct ?? '—'} %). Kịch bản chỉ còn "Tham khảo" cho tới khi duyệt.`,
    link: '/erp/#parameters', roles: ['finance'],
    dedupeKey: `sim.propose.${code}.${today()}`, entityType: 'parameters', entityId: parameter.id,
  }, actor);
  return { parameter: updated, comparison, previous };
}
