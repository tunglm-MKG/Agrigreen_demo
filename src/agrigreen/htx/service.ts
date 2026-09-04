/**
 * App Hợp tác xã — BRD v4.0.
 *
 * FN-07 đăng ký lô ruộng & ranh giới (GPS) · FN-08 định vị & xác thực vị trí
 * FN-09 thời tiết & lời khuyên nông vụ · FN-10 khai báo mở vụ mới
 * FN-11 ghi nhật ký canh tác · FN-12 khai báo sản lượng sau thu hoạch
 * FN-13 gửi yêu cầu hỗ trợ kỹ thuật · FN-16 dashboard · SYS-01 GPS log
 *
 * Vòng đời lô ruộng: "Chưa mở vụ" → "Đang canh tác" (FN-10) → "Đã hoàn thành vụ"
 * (FN-12). Trạng thái "Đã hoàn thành vụ" là ĐÓNG — vụ kế tiếp trên cùng thửa
 * đất tạo thành một lô ruộng mới.
 */
import { all, insert, one, transaction, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { checkPreHarvestInterval, planForCycle, planProgress } from './production.ts';
import { haversineKm, pointInPolygon, type LatLng } from '../../platform/geo/geo.ts';
import { parseJson } from '../../platform/db/db.ts';

// ---------------------------------------------------------------------------
// SYS-01 — Ghi nhận lịch sử toạ độ
// ---------------------------------------------------------------------------

export function recordGps(
  input: { userId?: string; context: string; refId?: string; lat: number; lng: number; accuracyM?: number },
): void {
  insert('gps_logs', {
    id: uuid(),
    user_id: input.userId ?? null,
    context: input.context,
    ref_id: input.refId ?? null,
    lat: input.lat,
    lng: input.lng,
    accuracy_m: input.accuracyM ?? null,
    captured_at: nowIso(),
  });
}

export function listGpsLogs(refId?: string): Record<string, unknown>[] {
  return refId
    ? all('SELECT * FROM gps_logs WHERE ref_id = ? ORDER BY captured_at DESC', [refId])
    : all('SELECT * FROM gps_logs ORDER BY captured_at DESC LIMIT 200');
}

/**
 * FN-08 — Xác thực vị trí: kiểm tra người dùng có đang đứng trong/gần thửa ruộng
 * đã khai báo hay không trước khi cho ghi nhật ký tại ruộng.
 */
export function verifyLocation(plotId: string, point: LatLng, toleranceKm = 0.3): {
  valid: boolean;
  insidePolygon: boolean;
  distanceKm: number;
  message: string;
} {
  const plot = one<{ boundary: string | null; centroid_lat: number | null; centroid_lng: number | null; code: string }>(
    'SELECT boundary, centroid_lat, centroid_lng, code FROM plots WHERE id = ?',
    [plotId],
  );
  if (!plot) throw new Error('Không tìm thấy lô ruộng');
  const geometry = parseJson<{ coordinates: [number, number][][] } | null>(plot.boundary, null);
  const ring: LatLng[] = geometry?.coordinates?.[0]?.map(([lng, lat]) => ({ lat, lng })) ?? [];
  const insidePolygon = ring.length >= 3 ? pointInPolygon(point, ring) : false;
  const distanceKm =
    plot.centroid_lat !== null && plot.centroid_lng !== null
      ? haversineKm(point, { lat: plot.centroid_lat, lng: plot.centroid_lng })
      : Infinity;
  const valid = insidePolygon || distanceKm <= toleranceKm;
  return {
    valid,
    insidePolygon,
    distanceKm: Math.round(distanceKm * 1000) / 1000,
    message: valid
      ? `Vị trí hợp lệ với lô ${plot.code}.`
      : `Bạn đang cách lô ${plot.code} khoảng ${distanceKm.toFixed(2)} km — vượt dung sai ${toleranceKm} km.`,
  };
}

// ---------------------------------------------------------------------------
// FN-10 — Khai báo mở vụ mới
// ---------------------------------------------------------------------------

export function openCropCycle(
  input: { plotId: string; seasonId: string; variety?: string; sowingDate?: string; expectedHarvestDate?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const plot = one<{ id: string; status: string; area_ha: number; htx_id: string; code: string }>(
    'SELECT id, status, area_ha, htx_id, code FROM plots WHERE id = ?',
    [input.plotId],
  );
  if (!plot) throw new Error('Không tìm thấy lô ruộng');
  if (plot.status === 'dang_canh_tac') {
    throw new Error(`Lô ${plot.code} đang canh tác — phải khai báo sản lượng để đóng vụ trước khi mở vụ mới.`);
  }
  if (plot.status === 'da_hoan_thanh_vu') {
    throw new Error(
      `Lô ${plot.code} đã ở trạng thái "Đã hoàn thành vụ" (đóng). Vụ kế tiếp trên cùng thửa đất phải được tạo thành một lô ruộng mới.`,
    );
  }

  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM crop_cycles');
  const record = {
    id: uuid(),
    code: sequenceCode('VU', (count?.n ?? 0) + 1, 6),
    plot_id: input.plotId,
    season_id: input.seasonId,
    variety: input.variety ?? null,
    sowing_date: input.sowingDate ?? nowIso().slice(0, 10),
    expected_harvest_date: input.expectedHarvestDate ?? null,
    area_ha: plot.area_ha,
    status: 'dang_canh_tac',
    created_by: actor.name ?? null,
    created_at: nowIso(),
  };

  transaction(() => {
    insert('crop_cycles', record);
    update('plots', input.plotId, { status: 'dang_canh_tac', updated_at: nowIso() });
    // Cập nhật trạng thái mùa vụ cho lớp heatmap GIS (FN-12 của BRD GIS).
    upsertCropStatus(plot.htx_id, input.seasonId, 'gieo_sa', record.expected_harvest_date);
  });

  logEvent({ module: 'htx', entityType: 'crop_cycles', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

function upsertCropStatus(htxId: string, seasonId: string, stage: string, expectedHarvestDate: string | null, strawTons = 0, yieldTons = 0): void {
  const existing = one<{ id: string }>('SELECT id FROM crop_status WHERE htx_id = ? AND season_id = ?', [htxId, seasonId]);
  const values = {
    stage,
    expected_harvest_date: expectedHarvestDate,
    expected_yield_tons: yieldTons,
    straw_tons: strawTons,
    updated_at: nowIso(),
  };
  if (existing) update('crop_status', existing.id, values);
  else insert('crop_status', { id: uuid(), htx_id: htxId, season_id: seasonId, ...values });
}

// ---------------------------------------------------------------------------
// FN-11 — Ghi nhật ký canh tác (hỗ trợ offline-first)
// ---------------------------------------------------------------------------

export const FARM_ACTIVITIES = [
  { code: 'lam_dat', label: 'Làm đất' },
  { code: 'gieo_sa', label: 'Gieo sạ' },
  { code: 'bon_phan', label: 'Bón phân' },
  { code: 'phun_thuoc', label: 'Phun thuốc' },
  { code: 'tuoi', label: 'Tưới nước' },
  { code: 'rut_nuoc_awd', label: 'Rút nước (AWD — dữ liệu MRV)' },
  { code: 'thu_hoach', label: 'Thu hoạch' },
];

export function addFarmLog(
  input: {
    cropCycleId: string; activity: string; logDate?: string; detail?: string;
    inputName?: string; inputQty?: number; inputUom?: string; photoUrl?: string;
    lat?: number; lng?: number; recordedBy?: string; synced?: boolean;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const cycle = one<{ id: string; plot_id: string; status: string }>(
    'SELECT id, plot_id, status FROM crop_cycles WHERE id = ?',
    [input.cropCycleId],
  );
  if (!cycle) throw new Error('Không tìm thấy vụ canh tác');
  if (cycle.status !== 'dang_canh_tac') throw new Error('Vụ đã đóng — không ghi thêm nhật ký.');

  const record = {
    id: uuid(),
    crop_cycle_id: input.cropCycleId,
    log_date: input.logDate ?? nowIso().slice(0, 10),
    activity: input.activity,
    detail: input.detail ?? null,
    input_name: input.inputName ?? null,
    input_qty: input.inputQty ?? null,
    input_uom: input.inputUom ?? null,
    photo_url: input.photoUrl ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    recorded_by: input.recordedBy ?? actor.name ?? null,
    synced: input.synced === false ? 0 : 1,
    created_at: nowIso(),
  };
  insert('farm_logs', record);
  if (input.lat !== undefined && input.lng !== undefined) {
    recordGps({ userId: actor.id ?? undefined, context: 'ghi_nhat_ky', refId: record.id, lat: input.lat, lng: input.lng });
  }
  logEvent({ module: 'htx', entityType: 'farm_logs', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function listFarmLogs(cropCycleId: string): Record<string, unknown>[] {
  return all('SELECT * FROM farm_logs WHERE crop_cycle_id = ? ORDER BY log_date DESC, created_at DESC', [cropCycleId]);
}

/** Đồng bộ hàng loạt bản ghi tạo khi mất mạng (offline-first). */
export function syncOfflineLogs(records: Record<string, unknown>[], actor: AuditActor = {}): { accepted: number; rejected: number } {
  let accepted = 0;
  let rejected = 0;
  for (const record of records) {
    try {
      addFarmLog(record as never, actor);
      accepted += 1;
    } catch {
      rejected += 1;
    }
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// FN-12 — Khai báo sản lượng sau thu hoạch (đóng vụ)
// ---------------------------------------------------------------------------

export function declareHarvest(
  input: {
    cropCycleId: string; harvestDate?: string; paddyTons: number; strawTons?: number;
    strawState?: string; moisturePct?: number;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const cycle = one<{ id: string; plot_id: string; season_id: string; status: string }>(
    'SELECT id, plot_id, season_id, status FROM crop_cycles WHERE id = ?',
    [input.cropCycleId],
  );
  if (!cycle) throw new Error('Không tìm thấy vụ canh tác');
  if (cycle.status !== 'dang_canh_tac') throw new Error('Vụ này đã được khai báo sản lượng.');
  if (input.paddyTons < 0) throw new Error('Sản lượng không được âm.');

  const harvestDate = input.harvestDate ?? nowIso().slice(0, 10);

  // Vụ có kế hoạch sản xuất thì khai báo sản lượng phải qua hai chốt chặn của
  // quy trình. Vụ không có kế hoạch vẫn khai báo được như trước — không bắt
  // buộc mọi HTX phải lập kế hoạch mới được ghi sản lượng.
  const plan = planForCycle(input.cropCycleId);
  if (plan) {
    // BR-06: thời gian cách ly sau phun thuốc (an toàn thực phẩm).
    const violation = checkPreHarvestInterval(String(plan.id), harvestDate);
    if (violation) throw new Error(violation);

    // Bước bắt buộc chưa xác nhận thì hồ sơ truy xuất không đầy đủ.
    const progress = planProgress(String(plan.id));
    const pending = Number(progress.mandatorySteps) - Number(progress.mandatoryDone);
    // Bước thu hoạch của chính kế hoạch thường được xác nhận cùng lúc với khai
    // báo sản lượng, nên cho phép còn đúng bước đó chưa xác nhận.
    if (pending > 1) {
      throw new Error(
        `Kế hoạch sản xuất ${plan.code} còn ${pending} bước bắt buộc chưa xác nhận thực hiện. ` +
        'Khai báo sản lượng khi hồ sơ quy trình còn dở dang sẽ tạo ra một lô hàng ' +
        'không truy xuất được — hãy xác nhận đủ các bước bắt buộc trước.',
      );
    }
  }

  const plot = one<{ htx_id: string }>('SELECT htx_id FROM plots WHERE id = ?', [cycle.plot_id])!;
  const record = {
    id: uuid(),
    crop_cycle_id: input.cropCycleId,
    harvest_date: harvestDate,
    paddy_tons: input.paddyTons,
    straw_tons: input.strawTons ?? 0,
    straw_state: input.strawState ?? 'rai_dong',
    moisture_pct: input.moisturePct ?? null,
    declared_by: actor.name ?? null,
    created_at: nowIso(),
  };

  transaction(() => {
    insert('harvest_declarations', record);
    update('crop_cycles', input.cropCycleId, { status: 'da_hoan_thanh_vu' });
    update('plots', cycle.plot_id, { status: 'da_hoan_thanh_vu', updated_at: nowIso() });
    upsertCropStatus(plot.htx_id, cycle.season_id, 'sau_thu_hoach', record.harvest_date, record.straw_tons, record.paddy_tons);
    // Cộng dồn vào thống kê sản lượng dùng chung — đầu vào của mô phỏng (tham số #5).
    const stat = one<{ id: string; paddy_tons: number }>(
      'SELECT id, paddy_tons FROM harvest_statistics WHERE htx_id = ? AND season_id = ?',
      [plot.htx_id, cycle.season_id],
    );
    if (stat) {
      update('harvest_statistics', stat.id, { paddy_tons: stat.paddy_tons + input.paddyTons, recorded_at: nowIso() });
    } else {
      insert('harvest_statistics', {
        id: uuid(),
        htx_id: plot.htx_id,
        season_id: cycle.season_id,
        planted_area_ha: 0,
        paddy_tons: input.paddyTons,
        source: 'app_htx',
        recorded_at: nowIso(),
      });
    }
  });

  logEvent({ module: 'htx', entityType: 'harvest_declarations', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

// ---------------------------------------------------------------------------
// FN-13 — Gửi yêu cầu hỗ trợ kỹ thuật (tự sinh nhiệm vụ cho App Khuyến nông FN-14)
// ---------------------------------------------------------------------------

export function requestSupport(
  input: { htxId: string; farmerId?: string; plotId?: string; title: string; description?: string; category?: string; priority?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM support_tasks');
  const record = {
    id: uuid(),
    code: sequenceCode('YCHT', (count?.n ?? 0) + 1, 5),
    htx_id: input.htxId,
    farmer_id: input.farmerId ?? null,
    plot_id: input.plotId ?? null,
    title: input.title,
    description: input.description ?? null,
    category: input.category ?? 'ky_thuat',
    priority: input.priority ?? 'binh_thuong',
    status: 'moi',
    assignee_id: null,
    origin: 'app_htx',
    created_at: nowIso(),
    updated_at: nowIso(),
    resolved_at: null,
    resolution: null,
  };
  insert('support_tasks', record);
  logEvent({ module: 'htx', entityType: 'support_tasks', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

// ---------------------------------------------------------------------------
// FN-09 — Thời tiết & lời khuyên nông vụ
// ---------------------------------------------------------------------------

export function farmingAdvice(htxId: string): Record<string, unknown> {
  const htx = one<{ province_id: string | null; name: string }>('SELECT province_id, name FROM cooperatives WHERE id = ?', [htxId]);
  const weather = htx?.province_id
    ? all<{ observed_for: string; rainfall_mm: number | null; humidity_pct: number | null; temp_c: number | null; severity: string | null; headline: string | null }>(
        'SELECT observed_for, rainfall_mm, humidity_pct, temp_c, severity, headline FROM weather_observations WHERE area_id = ? AND observed_for >= ? ORDER BY observed_for LIMIT 7',
        [htx.province_id, nowIso().slice(0, 10)],
      )
    : [];

  const advice: string[] = [];
  const rainyDays = weather.filter((w) => (w.rainfall_mm ?? 0) > 20).length;
  const hotDays = weather.filter((w) => (w.temp_c ?? 0) > 35).length;
  if (rainyDays >= 2) advice.push('Dự báo mưa lớn nhiều ngày — hoãn phun thuốc và chuẩn bị tiêu thoát nước cho ruộng.');
  if (hotDays >= 2) advice.push('Nắng nóng kéo dài — tăng tần suất kiểm tra mực nước, ưu tiên tưới vào sáng sớm/chiều mát.');
  if (weather.some((w) => w.severity)) advice.push('Có cảnh báo thời tiết nguy hiểm trong vùng — theo dõi thông báo từ cán bộ khuyến nông.');
  if (!advice.length) advice.push('Thời tiết thuận lợi — duy trì lịch chăm sóc theo quy trình kỹ thuật đã ban hành.');

  return { htx: htx?.name ?? null, forecast: weather, advice };
}

// ---------------------------------------------------------------------------
// FN-16 — Dashboard tổng quan HTX
// ---------------------------------------------------------------------------

export function dashboard(htxId?: string): Record<string, unknown> {
  const scope = htxId ? 'WHERE p.htx_id = ?' : '';
  const params = htxId ? [htxId] : [];
  const plots = all<{ status: string; n: number; area: number }>(
    `SELECT p.status, COUNT(*) AS n, COALESCE(SUM(p.area_ha), 0) AS area FROM plots p ${scope} GROUP BY p.status`,
    params,
  );
  const cycles = all(
    `SELECT cc.status, COUNT(*) AS n FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id ${scope} GROUP BY cc.status`,
    params,
  );
  const harvest = all(
    `SELECT s.name AS season, COALESCE(SUM(hd.paddy_tons), 0) AS paddy_tons, COALESCE(SUM(hd.straw_tons), 0) AS straw_tons
     FROM harvest_declarations hd
     JOIN crop_cycles cc ON cc.id = hd.crop_cycle_id
     JOIN plots p ON p.id = cc.plot_id
     JOIN seasons s ON s.id = cc.season_id
     ${scope} GROUP BY s.id ORDER BY s.sort_order`,
    params,
  );
  const openTasks = all(
    `SELECT status, COUNT(*) AS n FROM support_tasks ${htxId ? 'WHERE htx_id = ?' : ''} GROUP BY status`,
    htxId ? [htxId] : [],
  );
  const recentLogs = all(
    `SELECT fl.log_date, fl.activity, fl.detail, p.code AS plot_code
     FROM farm_logs fl JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id
     ${scope} ORDER BY fl.created_at DESC LIMIT 15`,
    params,
  );
  return { plots, cycles, harvest, openTasks, recentLogs, activities: FARM_ACTIVITIES };
}

export function listCropCycles(htxId?: string): Record<string, unknown>[] {
  const sql = `SELECT cc.*, p.code AS plot_code, p.htx_id, s.name AS season_name
               FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id JOIN seasons s ON s.id = cc.season_id`;
  return htxId
    ? all(`${sql} WHERE p.htx_id = ? ORDER BY cc.created_at DESC`, [htxId])
    : all(`${sql} ORDER BY cc.created_at DESC LIMIT 200`);
}
