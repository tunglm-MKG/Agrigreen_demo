/**
 * Module Warehouse & Inventory — BRD AgriGreen v1.1 (kế thừa PRD v2.3).
 *
 * Nhập kho (FN-01→07) · Giám sát điều kiện lưu trữ (FN-08→12)
 * Xuất kho (FN-13→19) · Kiểm kê (FN-20→23) · Báo cáo & MRV (FN-24→29)
 * Tích hợp (FN-30→34) · Quản trị (FN-35→39)
 *
 * Điểm khác biệt cốt lõi so với kho FMCG: rơm chịu ẩm/nhiệt, dễ tự bốc nhiệt →
 * ưu tiên xuất theo RỦI RO XUỐNG CẤP (tuổi lưu trữ + môi trường), không theo FEFO.
 */
import { all, insert, one, run, transaction, update } from '../../platform/db/db.ts';
import { digest, nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { runSync, registerRetryHandler } from '../../platform/sync/sync.ts';
import { postEntry } from '../finance/service.ts';

function nextCode(table: string, prefix: string, width = 6): string {
  const row = one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return sequenceCode(prefix, (row?.n ?? 0) + 1, width);
}

// ---------------------------------------------------------------------------
// FN-35 — Danh mục bãi/kho tập kết và khu vực lưu trữ
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Review kiến trúc 24/09/2026 (A03, R3): LÔ là nguồn sự thật duy nhất của tồn kho.
//  - mọi thay đổi remaining_tons ghi một dòng stock_movements (bất biến);
//  - facilities.current_stock_tons là số chiếu, được dựng lại từ lô sau mỗi giao dịch;
//  - xuất kho phải phân bổ ĐỦ lượng theo lô (issue_allocations), không có lô thì không có hàng;
//  - kiểm kê điều chỉnh ở cấp lô: tăng → lô điều chỉnh có nguồn gốc; giảm → trừ lô theo thứ tự rủi ro;
//  - kho seed có tổng tồn nhưng chưa có lô → một lần tạo LÔ TỒN ĐẦU KỲ đánh dấu rõ nguồn.
// ---------------------------------------------------------------------------
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const strawItem = () => one<{ id: string }>("SELECT id FROM items WHERE category = 'straw' LIMIT 1");

export function recordMovement(m: { facilityId: string; lotId: string; kind: 'nhap' | 'xuat' | 'dieu_chinh' | 'chuyen' | 'dao' | 'ton_dau_ky'; tons: number; refType?: string; refId?: string; note?: string; actor?: AuditActor }): void {
  if (!Number.isFinite(m.tons) || Math.abs(m.tons) < 0.0005) return;
  insert('stock_movements', {
    id: uuid(), facility_id: m.facilityId, lot_id: m.lotId, kind: m.kind, quantity_tons: round3(m.tons),
    ref_type: m.refType ?? null, ref_id: m.refId ?? null, note: m.note ?? null, occurred_at: nowIso(), recorded_by: m.actor?.name ?? null,
  });
}

/** Tổng tồn cơ sở = Σ remaining_tons của lô còn tồn. Trả về giá trị mới. */
export function syncFacilityStock(facilityId: string): number {
  const total = round3(one<{ s: number }>("SELECT COALESCE(SUM(remaining_tons), 0) AS s FROM stock_lots WHERE facility_id = ? AND status = 'ton'", [facilityId])?.s ?? 0);
  run('UPDATE facilities SET current_stock_tons = ?, updated_at = ? WHERE id = ?', [total, nowIso(), facilityId]);
  return total;
}

/**
 * Kho có tổng tồn > tổng lô mà CHƯA có vận động nào (dữ liệu seed/nhập tay trước khi có sổ) → tạo lô tồn đầu kỳ
 * để hàng có nguồn gốc và xuất được. Chỉ chạy một lần cho mỗi kho; sau đó tổng tồn luôn bằng tổng lô.
 */
export function ensureOpeningLot(facilityId: string, actor: AuditActor = { name: 'system' }): Record<string, unknown> | null {
  const facility = one<{ id: string; code: string; name: string; current_stock_tons: number }>('SELECT id, code, name, current_stock_tons FROM facilities WHERE id = ?', [facilityId]);
  if (!facility) return null;
  const hasMovements = one('SELECT 1 FROM stock_movements WHERE facility_id = ? LIMIT 1', [facilityId]);
  if (hasMovements) return null;
  const lotTons = one<{ s: number }>("SELECT COALESCE(SUM(remaining_tons), 0) AS s FROM stock_lots WHERE facility_id = ? AND status = 'ton'", [facilityId])?.s ?? 0;
  const gap = round3((facility.current_stock_tons ?? 0) - lotTons);
  if (gap <= 0.0005) return null;
  const item = strawItem();
  if (!item) return null;
  const lot = {
    id: uuid(), code: nextCode('stock_lots', 'LOT'), facility_id: facilityId, zone_id: null, grn_id: null, htx_id: null, plot_id: null,
    item_id: item.id, quantity_tons: gap, remaining_tons: gap, received_at: nowIso(), moisture_pct: null, risk_score: 0, status: 'ton',
  };
  transaction(() => {
    insert('stock_lots', lot);
    recordMovement({ facilityId, lotId: lot.id, kind: 'ton_dau_ky', tons: gap, refType: 'opening', refId: facilityId, note: `Tồn đầu kỳ ${facility.code} — quy đổi tổng tồn không rõ lô thành lô có nguồn gốc đánh dấu`, actor });
    syncFacilityStock(facilityId);
  });
  logEvent({ module: 'warehouse', entityType: 'stock_lots', entityId: lot.id, action: 'create', after: { ...lot, opening: true }, note: 'opening_lot' }, actor);
  return lot;
}

/** Chạy khi khởi động: quy đổi tồn không rõ lô của MỌI kho thành lô đầu kỳ (idempotent). */
export function ensureOpeningLots(): number {
  let created = 0;
  for (const f of all<{ id: string }>("SELECT id FROM facilities WHERE current_stock_tons > 0 AND kind IN ('hub', 'warehouse', 'yard', 'plant')")) if (ensureOpeningLot(f.id)) created += 1;
  return created;
}

/** Đối soát tổng tồn cơ sở với tổng lô — dùng cho màn Sức khoẻ CSDL và test invariant. */
export function stockConsistency(facilityId?: string): { facilityId: string; code: string; name: string; facilityTons: number; lotTons: number; diffTons: number }[] {
  return all<{ facilityId: string; code: string; name: string; facilityTons: number; lotTons: number }>(
    `SELECT f.id AS facilityId, f.code, f.name, f.current_stock_tons AS facilityTons,
            COALESCE((SELECT SUM(sl.remaining_tons) FROM stock_lots sl WHERE sl.facility_id = f.id AND sl.status = 'ton'), 0) AS lotTons
     FROM facilities f WHERE f.kind IN ('hub', 'warehouse', 'yard', 'plant') ${facilityId ? 'AND f.id = ?' : ''}`,
    facilityId ? [facilityId] : [],
  ).map((r) => ({ ...r, diffTons: round3(Number(r.facilityTons) - Number(r.lotTons)) }));
}

function assertZoneOfFacility(zoneId: string | null | undefined, facilityId: string): void {
  if (!zoneId) return;
  const zone = one<{ facility_id: string; name: string }>('SELECT facility_id, name FROM storage_zones WHERE id = ?', [zoneId]);
  if (!zone) throw new Error('Khu vực kho không tồn tại.');
  if (zone.facility_id !== facilityId) throw new Error(`Khu vực "${zone.name}" không thuộc kho của phiếu — chọn lại khu vực.`);
}

export function addStorageZone(
  input: { facilityId: string; code: string; name: string; zoneType?: string; capacityTons?: number },
  actor: AuditActor = {},
): Record<string, unknown> {
  const record = {
    id: uuid(),
    facility_id: input.facilityId,
    code: input.code,
    name: input.name,
    zone_type: input.zoneType ?? 'covered',
    capacity_tons: input.capacityTons ?? 0,
  };
  insert('storage_zones', record);
  logEvent({ module: 'warehouse', entityType: 'storage_zones', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

// ---------------------------------------------------------------------------
// FN-01 — Tiếp nhận thông báo lô hàng đến (từ TMS)
// ---------------------------------------------------------------------------

export function receiveInboundNotice(
  input: { facilityId: string; poId?: string; tripId?: string; eta?: string; expectedTons: number },
  actor: AuditActor = {},
): Record<string, unknown> {
  const record = {
    id: uuid(),
    code: nextCode('inbound_notices', 'TBD'),
    facility_id: input.facilityId,
    po_id: input.poId ?? null,
    trip_id: input.tripId ?? null,
    eta: input.eta ?? null,
    expected_tons: input.expectedTons,
    status: 'cho_den',
    created_at: nowIso(),
  };
  insert('inbound_notices', record);
  logEvent({ module: 'warehouse', entityType: 'inbound_notices', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

// ---------------------------------------------------------------------------
// FN-02 / FN-14 / FN-30 — Cân điện tử (Weighbridge)
// ---------------------------------------------------------------------------

export function recordWeighing(
  input: { facilityId: string; direction: 'in' | 'out'; grossKg: number; tareKg: number; vehicleCode?: string; deviceId?: string; refId?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  if (input.grossKg <= input.tareKg) {
    throw new Error('Khối lượng tổng phải lớn hơn khối lượng bì (tare).');
  }
  const record = {
    id: uuid(),
    code: nextCode('weighings', input.direction === 'in' ? 'CN' : 'CX'),
    facility_id: input.facilityId,
    direction: input.direction,
    vehicle_code: input.vehicleCode ?? null,
    gross_kg: input.grossKg,
    tare_kg: input.tareKg,
    net_kg: input.grossKg - input.tareKg,
    device_id: input.deviceId ?? 'weighbridge-01',
    weighed_at: nowIso(),
    ref_id: input.refId ?? null,
  };
  insert('weighings', record);
  logEvent({ module: 'warehouse', entityType: 'weighings', entityId: record.id, action: 'create', after: record, source: 'integration' }, actor);
  return record;
}

// ---------------------------------------------------------------------------
// FN-03 → FN-07 — Đối chiếu PO, tạo & phê duyệt GRN, xử lý chênh lệch
// ---------------------------------------------------------------------------

/** Ngưỡng chênh lệch chấp nhận được giữa PO và khối lượng cân thực nhận (%). */
const RECEIPT_VARIANCE_TOLERANCE_PCT = 3;

export function createGoodsReceipt(
  input: {
    facilityId: string; poId?: string; zoneId?: string; htxId?: string; plotId?: string; seasonId?: string;
    weighingId?: string; receivedTons?: number; moisturePct?: number; impurityPct?: number;
    harvestDate?: string; originLat?: number; originLng?: number;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  let receivedTons = input.receivedTons ?? 0;
  if (input.weighingId) {
    const weighing = one<{ net_kg: number }>('SELECT net_kg FROM weighings WHERE id = ?', [input.weighingId]);
    if (weighing) receivedTons = weighing.net_kg / 1000;
  }
  if (receivedTons <= 0) throw new Error('Khối lượng thực nhận phải lớn hơn 0.');

  // FN-03: đối chiếu khối lượng thực nhận với PO.
  let varianceTons = 0;
  let variancePct = 0;
  if (input.poId) {
    const po = one<{ ordered_tons: number }>('SELECT ordered_tons FROM purchase_orders WHERE id = ?', [input.poId]);
    if (po) {
      varianceTons = receivedTons - po.ordered_tons;
      variancePct = po.ordered_tons > 0 ? (varianceTons / po.ordered_tons) * 100 : 0;
    }
  }

  const record = {
    id: uuid(),
    code: nextCode('goods_receipts', 'GRN'),
    po_id: input.poId ?? null,
    facility_id: input.facilityId,
    zone_id: input.zoneId ?? null,
    htx_id: input.htxId ?? null,
    plot_id: input.plotId ?? null,
    season_id: input.seasonId ?? null,
    weighing_id: input.weighingId ?? null,
    received_tons: Math.round(receivedTons * 1000) / 1000,
    variance_tons: Math.round(varianceTons * 1000) / 1000,
    moisture_pct: input.moisturePct ?? null,
    impurity_pct: input.impurityPct ?? null,
    harvest_date: input.harvestDate ?? null,
    origin_lat: input.originLat ?? null,
    origin_lng: input.originLng ?? null,
    status: 'cho_duyet',
    approved_by: null,
    approved_at: null,
    created_at: nowIso(),
  };
  insert('goods_receipts', record);

  logEvent(
    {
      module: 'warehouse',
      entityType: 'goods_receipts',
      entityId: record.id,
      action: 'create',
      after: record,
      // FN-07: chênh lệch vượt ngưỡng phải lập biên bản xử lý.
      note:
        Math.abs(variancePct) > RECEIPT_VARIANCE_TOLERANCE_PCT
          ? `Chênh lệch ${variancePct.toFixed(2)}% so với PO — vượt ngưỡng ${RECEIPT_VARIANCE_TOLERANCE_PCT}%, cần lập biên bản.`
          : undefined,
    },
    actor,
  );
  return {
    ...record,
    variancePct: Math.round(variancePct * 100) / 100,
    requiresVarianceReport: Math.abs(variancePct) > RECEIPT_VARIANCE_TOLERANCE_PCT,
  };
}

/** FN-06 — Phê duyệt phiếu nhập trước khi ghi TĂNG tồn kho chính thức. */
export function approveGoodsReceipt(id: string, actor: AuditActor = {}): Record<string, unknown> {
  const grn = one<{
    id: string; code: string; status: string; facility_id: string; zone_id: string | null;
    htx_id: string | null; plot_id: string | null; received_tons: number; moisture_pct: number | null; po_id: string | null;
  }>('SELECT * FROM goods_receipts WHERE id = ?', [id]);
  if (!grn) throw new Error('Không tìm thấy phiếu nhập');
  if (grn.status === 'da_duyet') throw new Error('Phiếu nhập đã được phê duyệt.');

  const item = one<{ id: string }>("SELECT id FROM items WHERE category = 'straw' LIMIT 1");
  if (!item) throw new Error('Danh mục hàng hoá chưa có mặt hàng rơm (category = straw) — bổ sung trước khi duyệt phiếu nhập.');
  const lot = {
    id: uuid(),
    code: nextCode('stock_lots', 'LOT'),
    facility_id: grn.facility_id,
    zone_id: grn.zone_id,
    grn_id: grn.id,
    htx_id: grn.htx_id,
    plot_id: grn.plot_id,
    item_id: item?.id ?? null,
    quantity_tons: grn.received_tons,
    remaining_tons: grn.received_tons,
    received_at: nowIso(),
    moisture_pct: grn.moisture_pct,
    risk_score: 0,
    status: 'ton',
  };

  transaction(() => {
    assertZoneOfFacility(grn.zone_id, grn.facility_id);
    ensureOpeningLot(grn.facility_id, actor);
    update('goods_receipts', id, { status: 'da_duyet', approved_by: actor.name ?? null, approved_at: nowIso() });
    insert('stock_lots', lot);
    recordMovement({ facilityId: grn.facility_id, lotId: lot.id, kind: 'nhap', tons: grn.received_tons, refType: 'goods_receipt', refId: grn.id, actor });
    syncFacilityStock(grn.facility_id);
    if (grn.po_id) {
      // FN-33: liên thông với phân hệ Mua hàng.
      const po = one<{ unit_price: number; htx_id: string }>('SELECT unit_price, htx_id FROM purchase_orders WHERE id = ?', [grn.po_id]);
      if (po) {
        postEntry({
          account: 'AP',
          amount: po.unit_price * grn.received_tons,
          description: `Công nợ phải trả HTX theo GRN ${grn.code}`,
          htxId: po.htx_id,
          refType: 'grn',
          refId: grn.id,
          facilityId: grn.facility_id,
        });
      }
    }
  });

  // FN-05 / FN-27: ghi nhận nguồn gốc lô hàng theo chuẩn MRV.
  emitMrvRecord('warehouse', 'goods_receipt', grn.id, actor);
  logEvent({ module: 'warehouse', entityType: 'goods_receipts', entityId: id, action: 'approve', after: { lot: lot.code } }, actor);
  return lot;
}

// ---------------------------------------------------------------------------
// FN-08 → FN-11, FN-31, FN-37 — Giám sát môi trường lưu trữ
// ---------------------------------------------------------------------------

export interface Thresholds {
  humidityWarn: number;
  humidityCrit: number;
  tempWarn: number;
  tempCrit: number;
}

export function getThresholds(facilityId?: string): Thresholds {
  const row =
    (facilityId ? one<any>('SELECT * FROM env_thresholds WHERE facility_id = ?', [facilityId]) : null) ??
    one<any>('SELECT * FROM env_thresholds WHERE facility_id IS NULL');
  return {
    humidityWarn: row?.humidity_warn ?? 18,
    humidityCrit: row?.humidity_crit ?? 22,
    tempWarn: row?.temp_warn ?? 40,
    tempCrit: row?.temp_crit ?? 55,
  };
}

export function setThresholds(input: Thresholds & { facilityId?: string }, actor: AuditActor = {}): void {
  const existing = input.facilityId
    ? one<{ id: string }>('SELECT id FROM env_thresholds WHERE facility_id = ?', [input.facilityId])
    : one<{ id: string }>('SELECT id FROM env_thresholds WHERE facility_id IS NULL');
  const record = {
    id: existing?.id ?? uuid(),
    facility_id: input.facilityId ?? null,
    humidity_warn: input.humidityWarn,
    humidity_crit: input.humidityCrit,
    temp_warn: input.tempWarn,
    temp_crit: input.tempCrit,
    updated_at: nowIso(),
  };
  if (existing) update('env_thresholds', existing.id, record);
  else insert('env_thresholds', record);
  logEvent({ module: 'warehouse', entityType: 'env_thresholds', entityId: record.id, action: 'update', after: record }, actor);
}

/** FN-08/FN-31: nhận số đo từ cảm biến; FN-10: tự sinh cảnh báo khi vượt ngưỡng. */
export function ingestSensorReading(
  input: { facilityId: string; zoneId?: string; sensorId: string; humidityPct?: number; tempC?: number; recordedAt?: string },
): { readingId: string; alerts: Record<string, unknown>[] } {
  const readingId = uuid();
  insert('env_readings', {
    id: readingId,
    facility_id: input.facilityId,
    zone_id: input.zoneId ?? null,
    sensor_id: input.sensorId,
    humidity_pct: input.humidityPct ?? null,
    temp_c: input.tempC ?? null,
    recorded_at: input.recordedAt ?? nowIso(),
  });

  const thresholds = getThresholds(input.facilityId);
  const alerts: Record<string, unknown>[] = [];
  const raise = (metric: string, value: number, threshold: number, level: 'canh_bao' | 'nguy_hiem', message: string) => {
    const alert = {
      id: uuid(),
      facility_id: input.facilityId,
      zone_id: input.zoneId ?? null,
      level,
      metric,
      value,
      threshold,
      message,
      raised_at: nowIso(),
      acknowledged_at: null,
    };
    insert('env_alerts', alert);
    alerts.push(alert);
  };

  if (input.humidityPct !== undefined) {
    if (input.humidityPct >= thresholds.humidityCrit) {
      raise('humidity', input.humidityPct, thresholds.humidityCrit, 'nguy_hiem', `Độ ẩm ${input.humidityPct}% vượt ngưỡng nguy hiểm ${thresholds.humidityCrit}% — nguy cơ ẩm mốc/tự bốc nhiệt.`);
    } else if (input.humidityPct >= thresholds.humidityWarn) {
      raise('humidity', input.humidityPct, thresholds.humidityWarn, 'canh_bao', `Độ ẩm ${input.humidityPct}% vượt ngưỡng cảnh báo ${thresholds.humidityWarn}%.`);
    }
  }
  if (input.tempC !== undefined) {
    if (input.tempC >= thresholds.tempCrit) {
      raise('temperature', input.tempC, thresholds.tempCrit, 'nguy_hiem', `Nhiệt độ ${input.tempC}°C vượt ngưỡng nguy hiểm ${thresholds.tempCrit}°C — nguy cơ tự bốc nhiệt.`);
    } else if (input.tempC >= thresholds.tempWarn) {
      raise('temperature', input.tempC, thresholds.tempWarn, 'canh_bao', `Nhiệt độ ${input.tempC}°C vượt ngưỡng cảnh báo ${thresholds.tempWarn}°C.`);
    }
  }

  if (alerts.length) recomputeRiskScores(input.facilityId);
  return { readingId, alerts };
}

/** FN-09 — Dashboard giám sát môi trường theo thời gian thực. */
export function environmentDashboard(facilityId?: string): Record<string, unknown> {
  const scope = facilityId ? 'WHERE r.facility_id = ?' : '';
  const params = facilityId ? [facilityId] : [];
  return {
    thresholds: getThresholds(facilityId),
    latestByZone: all(
      `SELECT z.id AS zone_id, z.code AS zone_code, z.name AS zone_name, f.name AS facility_name,
              r.humidity_pct, r.temp_c, r.recorded_at
       FROM storage_zones z
       JOIN facilities f ON f.id = z.facility_id
       LEFT JOIN env_readings r ON r.id = (
         SELECT id FROM env_readings WHERE zone_id = z.id ORDER BY recorded_at DESC LIMIT 1)
       ${facilityId ? 'WHERE z.facility_id = ?' : ''}
       ORDER BY f.name, z.code`,
      params,
    ),
    activeAlerts: all(
      `SELECT a.*, z.name AS zone_name FROM env_alerts a LEFT JOIN storage_zones z ON z.id = a.zone_id
       WHERE a.acknowledged_at IS NULL ${facilityId ? 'AND a.facility_id = ?' : ''} ORDER BY a.raised_at DESC LIMIT 50`,
      params,
    ),
    trend24h: all(
      `SELECT r.zone_id, AVG(r.humidity_pct) AS avg_humidity, AVG(r.temp_c) AS avg_temp, COUNT(*) AS samples
       FROM env_readings r ${scope} ${scope ? 'AND' : 'WHERE'} r.recorded_at >= ?
       GROUP BY r.zone_id`,
      [...params, new Date(Date.now() - 86_400_000).toISOString()],
    ),
  };
}

export function acknowledgeAlert(id: string, actor: AuditActor = {}): void {
  update('env_alerts', id, { acknowledged_at: nowIso() });
  logEvent({ module: 'warehouse', entityType: 'env_alerts', entityId: id, action: 'update', after: { acknowledged: true } }, actor);
}

/** FN-11 — Lịch sử dữ liệu môi trường theo lô hàng. */
export function lotEnvironmentHistory(lotId: string): Record<string, unknown>[] {
  const lot = one<{ zone_id: string | null; received_at: string }>('SELECT zone_id, received_at FROM stock_lots WHERE id = ?', [lotId]);
  if (!lot?.zone_id) return [];
  return all(
    'SELECT * FROM env_readings WHERE zone_id = ? AND recorded_at >= ? ORDER BY recorded_at',
    [lot.zone_id, lot.received_at],
  );
}

/**
 * FN-12 / FN-19 — Điểm rủi ro xuống cấp và đề xuất ưu tiên xuất kho.
 *
 * Rủi ro = tuổi lưu trữ (chuẩn hoá theo 90 ngày) + độ ẩm vượt ngưỡng
 *        + số lần cảnh báo môi trường của khu vực chứa lô.
 * KHÔNG dùng FEFO vì rơm không có hạn dùng — rủi ro do môi trường quyết định.
 */
export function recomputeRiskScores(facilityId?: string): void {
  const lots = all<{ id: string; zone_id: string | null; received_at: string; moisture_pct: number | null; facility_id: string }>(
    `SELECT id, zone_id, received_at, moisture_pct, facility_id FROM stock_lots
     WHERE status = 'ton' ${facilityId ? 'AND facility_id = ?' : ''}`,
    facilityId ? [facilityId] : [],
  );
  for (const lot of lots) {
    const thresholds = getThresholds(lot.facility_id);
    const ageDays = (Date.now() - new Date(lot.received_at).getTime()) / 86_400_000;
    const ageScore = Math.min(1, ageDays / 90) * 40;
    const moistureScore =
      lot.moisture_pct && lot.moisture_pct > thresholds.humidityWarn
        ? Math.min(1, (lot.moisture_pct - thresholds.humidityWarn) / 10) * 35
        : 0;
    const alertCount = lot.zone_id
      ? one<{ n: number }>(
          'SELECT COUNT(*) AS n FROM env_alerts WHERE zone_id = ? AND raised_at >= ?',
          [lot.zone_id, lot.received_at],
        )?.n ?? 0
      : 0;
    const alertScore = Math.min(1, alertCount / 10) * 25;
    update('stock_lots', lot.id, { risk_score: Math.round((ageScore + moistureScore + alertScore) * 10) / 10 });
  }
}

export function suggestedIssueOrder(facilityId: string): Record<string, unknown>[] {
  recomputeRiskScores(facilityId);
  return all(
    `SELECT sl.*, c.name AS htx_name, z.name AS zone_name,
            CAST((julianday('now') - julianday(sl.received_at)) AS INTEGER) AS age_days
     FROM stock_lots sl
     LEFT JOIN cooperatives c ON c.id = sl.htx_id
     LEFT JOIN storage_zones z ON z.id = sl.zone_id
     WHERE sl.facility_id = ? AND sl.status = 'ton' AND sl.remaining_tons > 0
     ORDER BY sl.risk_score DESC, sl.received_at ASC`,
    [facilityId],
  );
}

// ---------------------------------------------------------------------------
// FN-13 → FN-18 — Xuất kho
// ---------------------------------------------------------------------------

export function createGoodsIssue(
  input: { facilityId: string; soId?: string; issuedTons: number; weighingId?: string; tripId?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const facility = one<{ current_stock_tons: number; name: string }>(
    'SELECT current_stock_tons, name FROM facilities WHERE id = ?',
    [input.facilityId],
  );
  if (!facility) throw new Error('Không tìm thấy kho');
  // Review 24/09/2026 P1 #4: số âm/NaN/∞ từng lọt qua và LÀM TĂNG tồn kho khi duyệt.
  if (!Number.isFinite(input.issuedTons) || input.issuedTons <= 0) {
    throw new Error('Số lượng xuất phải là số lớn hơn 0 (tấn).');
  }
  if (input.issuedTons > facility.current_stock_tons) {
    throw new Error(`Tồn kho ${facility.name} chỉ còn ${facility.current_stock_tons} tấn — không đủ để xuất ${input.issuedTons} tấn.`);
  }
  const record = {
    id: uuid(),
    code: nextCode('goods_issues', 'GIS'),
    so_id: input.soId ?? null,
    facility_id: input.facilityId,
    issued_tons: input.issuedTons,
    weighing_id: input.weighingId ?? null,
    trip_id: input.tripId ?? null,
    status: 'cho_duyet',
    approved_by: null,
    approved_at: null,
    created_at: nowIso(),
  };
  insert('goods_issues', record);
  logEvent({ module: 'warehouse', entityType: 'goods_issues', entityId: record.id, action: 'create', after: record }, actor);
  return { ...record, suggestedLots: suggestedIssueOrder(input.facilityId).slice(0, 10) };
}

/**
 * FN-18 — Phê duyệt phiếu xuất: phân bổ ĐỦ lượng theo lô (rủi ro cao trước), ghi sổ vận động, dựng lại tổng tồn.
 * Không có lô = không có hàng, dù tổng tồn cơ sở nói gì (review 24/09/2026, R3).
 */
export function approveGoodsIssue(id: string, actor: AuditActor = {}): Record<string, unknown> {
  const issue = one<{ id: string; code: string; status: string; facility_id: string; issued_tons: number; so_id: string | null }>(
    'SELECT * FROM goods_issues WHERE id = ?',
    [id],
  );
  if (!issue) throw new Error('Không tìm thấy phiếu xuất');
  if (issue.status === 'da_duyet') throw new Error('Phiếu xuất đã được phê duyệt.');
  if (!Number.isFinite(issue.issued_tons) || issue.issued_tons <= 0) throw new Error('Phiếu xuất có số lượng không hợp lệ — không thể phê duyệt.');

  const consumed: { lot: string; tons: number }[] = [];
  transaction(() => {
    const facility = one<{ name: string }>('SELECT name FROM facilities WHERE id = ?', [issue.facility_id]);
    if (!facility) throw new Error('Không tìm thấy kho của phiếu xuất.');
    ensureOpeningLot(issue.facility_id, actor);
    // Tồn kho được kiểm LẠI tại thời điểm duyệt, trong cùng giao dịch, theo LÔ.
    const lots = suggestedIssueOrder(issue.facility_id);
    const available = round3(lots.reduce((sum, lot) => sum + Number(lot.remaining_tons), 0));
    if (!lots.length || available + 0.0005 < issue.issued_tons) {
      throw new Error(`Không đủ hàng để duyệt phiếu ${issue.code}: kho ${facility.name} còn ${available} tấn theo lô, phiếu cần ${issue.issued_tons} tấn. Phiếu giữ trạng thái chờ duyệt.`);
    }
    let remaining = issue.issued_tons;
    for (const lot of lots) {
      if (remaining <= 0.0005) break;
      const lotRemaining = Number(lot.remaining_tons);
      const take = round3(Math.min(lotRemaining, remaining));
      const left = round3(lotRemaining - take);
      update('stock_lots', String(lot.id), { remaining_tons: left, status: left <= 0.0001 ? 'da_xuat' : 'ton' });
      insert('issue_allocations', { id: uuid(), issue_id: id, lot_id: String(lot.id), tons: take, created_at: nowIso() });
      recordMovement({ facilityId: issue.facility_id, lotId: String(lot.id), kind: 'xuat', tons: -take, refType: 'goods_issue', refId: id, actor });
      consumed.push({ lot: String(lot.code), tons: take });
      remaining = round3(remaining - take);
    }
    const allocated = round3(one<{ s: number }>('SELECT COALESCE(SUM(tons), 0) AS s FROM issue_allocations WHERE issue_id = ?', [id])?.s ?? 0);
    if (Math.abs(allocated - issue.issued_tons) > 0.0005) {
      throw new Error(`Tổng phân bổ theo lô (${allocated} tấn) khác lượng xuất (${issue.issued_tons} tấn) — huỷ duyệt.`);
    }
    update('goods_issues', id, { status: 'da_duyet', approved_by: actor.name ?? null, approved_at: nowIso() });
    syncFacilityStock(issue.facility_id);
    if (issue.so_id) {
      const so = one<{ unit_price: number; partner_id: string }>('SELECT unit_price, partner_id FROM sales_orders WHERE id = ?', [issue.so_id]);
      if (so) {
        postEntry({
          account: 'AR',
          amount: so.unit_price * issue.issued_tons,
          description: `Công nợ phải thu theo phiếu xuất ${issue.code}`,
          partnerId: so.partner_id,
          refType: 'goods_issue',
          refId: issue.id,
          facilityId: issue.facility_id,
        });
      }
    }
  });

  emitMrvRecord('warehouse', 'goods_issue', issue.id, actor);
  logEvent({ module: 'warehouse', entityType: 'goods_issues', entityId: id, action: 'approve', after: { consumed } }, actor);
  const allocatedTons = round3(consumed.reduce((s, c) => s + c.tons, 0));
  // shortfall chỉ = 0 khi đã XÁC MINH tổng phân bổ bằng lượng xuất (kiểm trong giao dịch ở trên).
  return { issue: one('SELECT * FROM goods_issues WHERE id = ?', [id]), consumed, allocatedTons, shortfall: round3(Math.max(0, issue.issued_tons - allocatedTons)) };
}

// ---------------------------------------------------------------------------
// FN-16 / FN-17 — ePOD và e-bill
// ---------------------------------------------------------------------------

export function issueTripDocument(
  input: { tripId: string; kind: 'epod' | 'ebill'; signer?: string; payload?: Record<string, unknown> },
  actor: AuditActor = {},
): Record<string, unknown> {
  const record = {
    id: uuid(),
    trip_id: input.tripId,
    kind: input.kind,
    code: nextCode('trip_documents', input.kind === 'epod' ? 'EPOD' : 'EBILL'),
    signer: input.signer ?? null,
    signed_at: input.signer ? nowIso() : null,
    payload_json: JSON.stringify(input.payload ?? {}),
  };
  insert('trip_documents', record);
  logEvent({ module: 'warehouse', entityType: 'trip_documents', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

// ---------------------------------------------------------------------------
// FN-20 → FN-23 — Kiểm kê
// ---------------------------------------------------------------------------

export function planStocktake(
  input: { facilityId: string; zoneId?: string; plannedFor: string; kind?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  assertZoneOfFacility(input.zoneId, input.facilityId);
  const record = {
    id: uuid(),
    code: nextCode('stocktakes', 'KK'),
    facility_id: input.facilityId,
    zone_id: input.zoneId ?? null,
    planned_for: input.plannedFor,
    kind: input.kind ?? 'dinh_ky',
    status: 'ke_hoach',
    book_tons: null,
    counted_tons: null,
    variance_tons: null,
    reason: null,
    approved_by: null,
    approved_at: null,
    created_at: nowIso(),
  };
  insert('stocktakes', record);
  logEvent({ module: 'warehouse', entityType: 'stocktakes', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

/** FN-21 — Đối chiếu tồn sổ sách với tồn thực tế. */
export function submitCount(id: string, countedTons: number, reason?: string, actor: AuditActor = {}): Record<string, unknown> {
  const stocktake = one<{ id: string; facility_id: string; zone_id: string | null }>('SELECT * FROM stocktakes WHERE id = ?', [id]);
  if (!stocktake) throw new Error('Không tìm thấy phiếu kiểm kê');
  const book = stocktake.zone_id
    ? one<{ s: number }>("SELECT COALESCE(SUM(remaining_tons),0) AS s FROM stock_lots WHERE zone_id = ? AND status = 'ton'", [stocktake.zone_id])
    : one<{ s: number }>("SELECT COALESCE(SUM(remaining_tons),0) AS s FROM stock_lots WHERE facility_id = ? AND status = 'ton'", [stocktake.facility_id]);
  const bookTons = book?.s ?? 0;
  update('stocktakes', id, {
    book_tons: bookTons,
    counted_tons: countedTons,
    variance_tons: Math.round((countedTons - bookTons) * 1000) / 1000,
    reason: reason ?? null,
    status: 'cho_duyet',
  });
  const after = one('SELECT * FROM stocktakes WHERE id = ?', [id])!;
  logEvent({ module: 'warehouse', entityType: 'stocktakes', entityId: id, action: 'update', after }, actor);
  return after;
}

/**
 * FN-22 / FN-23 — Phê duyệt chênh lệch kiểm kê Ở CẤP LÔ (review 24/09/2026, A03):
 * tăng → tạo lô điều chỉnh có nguồn gốc; giảm → trừ lô theo thứ tự rủi ro, không để lô âm;
 * tổng tồn cơ sở dựng lại từ lô nên lần kiểm kê sau đối chiếu đúng.
 */
export function approveStocktake(id: string, actor: AuditActor = {}): Record<string, unknown> {
  const stocktake = one<{ id: string; code: string; facility_id: string; zone_id: string | null; variance_tons: number | null; status: string }>(
    'SELECT * FROM stocktakes WHERE id = ?',
    [id],
  );
  if (!stocktake) throw new Error('Không tìm thấy phiếu kiểm kê');
  if (stocktake.status !== 'cho_duyet') throw new Error('Phiếu kiểm kê chưa ở trạng thái chờ duyệt.');
  const variance = round3(stocktake.variance_tons ?? 0);
  const adjustments: { lot: string; tons: number }[] = [];

  transaction(() => {
    assertZoneOfFacility(stocktake.zone_id, stocktake.facility_id);
    ensureOpeningLot(stocktake.facility_id, actor);
    if (variance > 0.0005) {
      const item = strawItem();
      if (!item) throw new Error('Danh mục hàng hoá chưa có mặt hàng rơm (category = straw) — bổ sung trước khi duyệt kiểm kê.');
      const lot = {
        id: uuid(), code: nextCode('stock_lots', 'LOT'), facility_id: stocktake.facility_id, zone_id: stocktake.zone_id, grn_id: null, htx_id: null, plot_id: null,
        item_id: item.id, quantity_tons: variance, remaining_tons: variance, received_at: nowIso(), moisture_pct: null, risk_score: 0, status: 'ton',
      };
      insert('stock_lots', lot);
      recordMovement({ facilityId: stocktake.facility_id, lotId: lot.id, kind: 'dieu_chinh', tons: variance, refType: 'stocktake', refId: id, note: `Kiểm kê ${stocktake.code}: thừa ${variance} tấn so với sổ`, actor });
      adjustments.push({ lot: lot.code, tons: variance });
    } else if (variance < -0.0005) {
      let remaining = -variance;
      const lots = suggestedIssueOrder(stocktake.facility_id).filter((lot) => !stocktake.zone_id || lot.zone_id === stocktake.zone_id);
      for (const lot of lots) {
        if (remaining <= 0.0005) break;
        const lotRemaining = Number(lot.remaining_tons);
        const take = round3(Math.min(lotRemaining, remaining));
        const left = round3(lotRemaining - take);
        update('stock_lots', String(lot.id), { remaining_tons: left, status: left <= 0.0001 ? 'da_xuat' : 'ton' });
        recordMovement({ facilityId: stocktake.facility_id, lotId: String(lot.id), kind: 'dieu_chinh', tons: -take, refType: 'stocktake', refId: id, note: `Kiểm kê ${stocktake.code}: thiếu so với sổ`, actor });
        adjustments.push({ lot: String(lot.code), tons: -take });
        remaining = round3(remaining - take);
      }
      if (remaining > 0.0005) throw new Error(`Chênh lệch giảm ${-variance} tấn lớn hơn tồn theo lô của ${stocktake.zone_id ? 'khu vực' : 'kho'} (${round3(-variance - remaining)} tấn) — kiểm lại số đếm hoặc phạm vi kiểm kê.`);
    }
    update('stocktakes', id, { status: 'da_duyet', approved_by: actor.name ?? null, approved_at: nowIso() });
    syncFacilityStock(stocktake.facility_id);
  });
  logEvent({ module: 'warehouse', entityType: 'stocktakes', entityId: id, action: 'approve', after: { variance, adjustments } }, actor);
  return { ...one<Record<string, unknown>>('SELECT * FROM stocktakes WHERE id = ?', [id])!, adjustments };
}

// ---------------------------------------------------------------------------
// FN-24 → FN-26 — Báo cáo
// ---------------------------------------------------------------------------

export function inventoryReport(facilityId?: string): Record<string, unknown> {
  const where = facilityId ? 'WHERE sl.facility_id = ?' : '';
  const params = facilityId ? [facilityId] : [];
  return {
    byFacility: all(
      `SELECT f.code, f.name, f.capacity_tons, f.current_stock_tons,
              ROUND(CASE WHEN f.capacity_tons > 0 THEN f.current_stock_tons * 100.0 / f.capacity_tons ELSE 0 END, 1) AS fill_pct
       FROM facilities f WHERE f.kind IN ('hub','warehouse','yard') ORDER BY f.code`,
    ),
    byZone: all(
      `SELECT z.code AS zone_code, z.name AS zone_name, z.capacity_tons,
              COALESCE(SUM(sl.remaining_tons), 0) AS stock_tons
       FROM storage_zones z LEFT JOIN stock_lots sl ON sl.zone_id = z.id AND sl.status = 'ton'
       ${facilityId ? 'WHERE z.facility_id = ?' : ''} GROUP BY z.id ORDER BY z.code`,
      params,
    ),
    byLot: all(
      `SELECT sl.code, sl.remaining_tons, sl.risk_score, sl.received_at, c.name AS htx_name
       FROM stock_lots sl LEFT JOIN cooperatives c ON c.id = sl.htx_id
       ${where} ${where ? 'AND' : 'WHERE'} sl.status = 'ton' ORDER BY sl.risk_score DESC LIMIT 200`,
      params,
    ),
  };
}

/** FN-25 — Báo cáo nhập – xuất – tồn theo kỳ. */
export function movementReport(from: string, to: string, facilityId?: string): Record<string, unknown> {
  const facilityClause = facilityId ? 'AND facility_id = ?' : '';
  const params = facilityId ? [from, to, facilityId] : [from, to];
  const inbound = one<{ tons: number; n: number }>(
    `SELECT COALESCE(SUM(received_tons),0) AS tons, COUNT(*) AS n FROM goods_receipts
     WHERE status = 'da_duyet' AND substr(created_at,1,10) BETWEEN ? AND ? ${facilityClause}`,
    params,
  );
  const outbound = one<{ tons: number; n: number }>(
    `SELECT COALESCE(SUM(issued_tons),0) AS tons, COUNT(*) AS n FROM goods_issues
     WHERE status = 'da_duyet' AND substr(created_at,1,10) BETWEEN ? AND ? ${facilityClause}`,
    params,
  );
  const closing = one<{ tons: number }>(
    `SELECT COALESCE(SUM(current_stock_tons),0) AS tons FROM facilities WHERE kind IN ('hub','warehouse','yard') ${facilityId ? 'AND id = ?' : ''}`,
    facilityId ? [facilityId] : [],
  );
  const movements = all(
    `SELECT kind, COUNT(*) AS n, COALESCE(SUM(quantity_tons), 0) AS tons FROM stock_movements
     WHERE substr(occurred_at,1,10) BETWEEN ? AND ? ${facilityClause} GROUP BY kind ORDER BY kind`,
    params,
  );
  return {
    period: { from, to },
    inbound: inbound ?? { tons: 0, n: 0 },
    outbound: outbound ?? { tons: 0, n: 0 },
    movements,
    consistency: stockConsistency(facilityId),
    closingStockTons: closing?.tons ?? 0,
    openingStockTons: (closing?.tons ?? 0) - (inbound?.tons ?? 0) + (outbound?.tons ?? 0),
  };
}

/** FN-26 — Báo cáo chất lượng lưu trữ. */
export function qualityReport(facilityId?: string): Record<string, unknown> {
  const params = facilityId ? [facilityId] : [];
  return {
    environment: all(
      `SELECT z.code AS zone_code, ROUND(AVG(r.humidity_pct),1) AS avg_humidity, ROUND(AVG(r.temp_c),1) AS avg_temp,
              MAX(r.humidity_pct) AS max_humidity, MAX(r.temp_c) AS max_temp, COUNT(*) AS samples
       FROM env_readings r JOIN storage_zones z ON z.id = r.zone_id
       ${facilityId ? 'WHERE r.facility_id = ?' : ''} GROUP BY z.id ORDER BY z.code`,
      params,
    ),
    alertCounts: all(
      `SELECT level, metric, COUNT(*) AS n FROM env_alerts ${facilityId ? 'WHERE facility_id = ?' : ''} GROUP BY level, metric`,
      params,
    ),
    receiptQuality: all(
      `SELECT ROUND(AVG(moisture_pct),2) AS avg_moisture, ROUND(AVG(impurity_pct),2) AS avg_impurity, COUNT(*) AS receipts
       FROM goods_receipts WHERE status = 'da_duyet' ${facilityId ? 'AND facility_id = ?' : ''}`,
      params,
    ),
    standard: 'Tiêu chuẩn tham chiếu: độ ẩm ≤ 14% để lưu kho dài hạn; tạp chất ≤ 5% cho rơm thương phẩm.',
  };
}

// ---------------------------------------------------------------------------
// FN-27 / FN-28 / FN-34 — Kết xuất chuẩn MRV & đồng bộ Data Lakehouse
// ---------------------------------------------------------------------------

/** Hệ số phát thải khi đốt rơm ngoài đồng (kgCO2e/tấn) — nguồn IPCC EFDB. */
const OPEN_BURNING_EMISSION_FACTOR = 1_460;

export function emitMrvRecord(
  sourceModule: string,
  refType: string,
  refId: string,
  actor: AuditActor = {},
): Record<string, unknown> | null {
  let base: { htxId: string | null; plotId: string | null; lat: number | null; lng: number | null; tons: number; occurredAt: string } | null = null;

  if (refType === 'goods_receipt') {
    const grn = one<any>('SELECT * FROM goods_receipts WHERE id = ?', [refId]);
    if (!grn) return null;
    base = {
      htxId: grn.htx_id, plotId: grn.plot_id, lat: grn.origin_lat, lng: grn.origin_lng,
      tons: grn.received_tons, occurredAt: grn.approved_at ?? grn.created_at,
    };
  } else if (refType === 'goods_issue') {
    const issue = one<any>('SELECT gi.*, f.lat, f.lng FROM goods_issues gi JOIN facilities f ON f.id = gi.facility_id WHERE gi.id = ?', [refId]);
    if (!issue) return null;
    base = { htxId: null, plotId: null, lat: issue.lat, lng: issue.lng, tons: issue.issued_tons, occurredAt: issue.approved_at ?? issue.created_at };
  } else if (refType === 'trip') {
    const trip = one<any>('SELECT * FROM trips WHERE id = ?', [refId]);
    if (!trip) return null;
    base = { htxId: null, plotId: null, lat: trip.from_lat, lng: trip.from_lng, tons: trip.actual_tons || trip.planned_tons, occurredAt: trip.arrived_at ?? trip.created_at };
  }
  if (!base) return null;

  const co2Emitted =
    refType === 'trip' ? Number(one<any>('SELECT co2_kg FROM trips WHERE id = ?', [refId])?.co2_kg ?? 0) : 0;
  // CO2 tránh được = tấn rơm thu gom × hệ số phát thải khi đốt − CO2 vận chuyển.
  const co2Avoided = refType === 'goods_receipt' ? base.tons * OPEN_BURNING_EMISSION_FACTOR : 0;

  const payload = {
    schema: 'mrv.v1',
    sourceModule,
    refType,
    refId,
    quantityTons: base.tons,
    coordinates: { lat: base.lat, lng: base.lng },
    occurredAt: base.occurredAt,
    co2AvoidedKg: Math.round(co2Avoided),
    co2EmittedKg: Math.round(co2Emitted),
    emissionFactorSource: 'IPCC EFDB — đốt rơm ngoài đồng (CH4 + N2O quy đổi CO2e)',
  };

  const record = {
    id: uuid(),
    code: nextCode('mrv_records', 'MRV'),
    source_module: sourceModule,
    ref_type: refType,
    ref_id: refId,
    htx_id: base.htxId,
    plot_id: base.plotId,
    lat: base.lat,
    lng: base.lng,
    occurred_at: base.occurredAt,
    quantity_tons: base.tons,
    co2_avoided_kg: payload.co2AvoidedKg,
    co2_emitted_kg: payload.co2EmittedKg,
    payload_json: JSON.stringify(payload),
    checksum: digest(payload),
    created_at: nowIso(),
  };
  insert('mrv_records', record);
  logEvent({ module: 'mrv', entityType: 'mrv_records', entityId: record.id, action: 'create', after: payload }, actor);
  return record;
}

function lakehousePayload(actor: AuditActor = {}) {
  const records = all('SELECT * FROM mrv_records ORDER BY created_at DESC LIMIT 1000');
  logEvent({ module: 'mrv', entityType: 'lakehouse_sync', action: 'sync', after: { count: records.length } }, actor);
  return { recordCount: records.length, result: { layer: 'raw', records } };
}
export function syncToDataLakehouse(actor: AuditActor = {}) {
  return runSync({ system: 'erp', direction: 'outbound', dataset: 'warehouse_to_lakehouse' }, () => lakehousePayload(actor));
}
registerRetryHandler('warehouse_to_lakehouse', () => lakehousePayload({ name: 'retry' }));

export function mrvSummary(): Record<string, unknown> {
  return {
    totals: one(
      'SELECT COUNT(*) AS records, COALESCE(SUM(quantity_tons),0) AS tons, COALESCE(SUM(co2_avoided_kg),0) AS co2_avoided_kg, COALESCE(SUM(co2_emitted_kg),0) AS co2_emitted_kg FROM mrv_records',
    ),
    byModule: all('SELECT source_module, COUNT(*) AS n, COALESCE(SUM(quantity_tons),0) AS tons FROM mrv_records GROUP BY source_module'),
    recent: all('SELECT code, source_module, ref_type, quantity_tons, co2_avoided_kg, occurred_at FROM mrv_records ORDER BY created_at DESC LIMIT 25'),
  };
}

export function listGoodsReceipts(facilityId?: string): Record<string, unknown>[] {
  return facilityId
    ? all('SELECT * FROM goods_receipts WHERE facility_id = ? ORDER BY created_at DESC LIMIT 200', [facilityId])
    : all('SELECT * FROM goods_receipts ORDER BY created_at DESC LIMIT 200');
}

export function listStockLots(facilityId?: string): Record<string, unknown>[] {
  return facilityId
    ? all("SELECT * FROM stock_lots WHERE facility_id = ? AND status = 'ton' ORDER BY risk_score DESC", [facilityId])
    : all("SELECT * FROM stock_lots WHERE status = 'ton' ORDER BY risk_score DESC LIMIT 200");
}

export function listStocktakes(): Record<string, unknown>[] {
  return all('SELECT * FROM stocktakes ORDER BY planned_for DESC LIMIT 100');
}
