/**
 * Transportation Management System (TMS).
 *
 * Routing đa tiêu chí đường bộ/thủy trên mạng lưới đã số hoá (dùng chung nền
 * GIS), theo dõi chuyến, chứng từ ePOD/e-bill, và đối chiếu chi phí vận tải
 * thực tế so với kế hoạch (tham chiếu FN-08 của Simulation).
 */
import { all, insert, one, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { DistanceService, type TransportMode } from '../../platform/geo/distance.ts';
import type { LatLng } from '../../platform/geo/geo.ts';
import { resolveParams } from '../params/store.ts';
import { emitMrvRecord } from '../warehouse/service.ts';

/** Hệ số phát thải vận tải (kgCO2e/tấn·km) — nguồn IPCC / Cục Biến đổi khí hậu. */
const EMISSION_FACTOR = { road: 0.062, waterway: 0.021 } as const;

function distanceService() {
  const params = resolveParams();
  return {
    service: new DistanceService({
      correctionFactors: params.correctionFactors,
      waterwayAccessRadiusKm: 8,
      minBargeLoadTons: params.bargePayloadTons,
    }),
    params,
  };
}

/** Routing đa tiêu chí: so sánh chi phí, thời gian và phát thải giữa hai phương thức. */
export function planRoute(input: {
  from: LatLng; to: LatLng; tons: number; criteria?: 'cost' | 'time' | 'emission';
}): Record<string, unknown> {
  const { service, params } = distanceService();
  const options = (['road', 'waterway'] as TransportMode[]).map((mode) => {
    const distance = service.distance(input.from, input.to, mode);
    const rate = mode === 'road' ? params.roadFreightRatePerTonKm : params.waterwayFreightRatePerTonKm;
    const speed = mode === 'road' ? params.roadSpeedKmh : params.waterwaySpeedKmh;
    const payload = mode === 'road' ? params.truckPayloadTons : params.bargePayloadTons;
    const trips = Math.ceil(input.tons / Math.max(payload, 1));
    return {
      mode,
      distanceKm: distance.distanceKm,
      source: distance.source,
      sourceLabel: distance.sourceLabel,
      available: mode === 'road' ? true : !distance.waterwayUnavailable,
      cost: Math.round(input.tons * distance.distanceKm * rate),
      leadTimeHours: Math.round((distance.distanceKm / Math.max(speed, 1) + params.handlingHoursPerTrip) * 100) / 100,
      trips,
      co2Kg: Math.round(input.tons * distance.distanceKm * EMISSION_FACTOR[mode]),
    };
  });

  const feasible = options.filter((option) => option.available);
  const criteria = input.criteria ?? 'cost';
  const key = criteria === 'cost' ? 'cost' : criteria === 'time' ? 'leadTimeHours' : 'co2Kg';
  const recommended = feasible.slice().sort((a, b) => (a as any)[key] - (b as any)[key])[0] ?? null;

  return { options, recommended, criteria, note: 'Khoảng cách kèm nhãn nguồn tính theo FN-04 BR-04.' };
}

export function createTrip(
  input: {
    mode: TransportMode; from: LatLng; to: LatLng; fromLabel?: string; toLabel?: string;
    plannedTons: number; vehicleCode?: string; driverName?: string; refType?: string; refId?: string;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const { service, params } = distanceService();
  const distance = service.distance(input.from, input.to, input.mode);
  const rate = input.mode === 'road' ? params.roadFreightRatePerTonKm : params.waterwayFreightRatePerTonKm;
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM trips');

  const record = {
    id: uuid(),
    code: sequenceCode('CH', (count?.n ?? 0) + 1, 6),
    mode: input.mode,
    vehicle_code: input.vehicleCode ?? null,
    driver_name: input.driverName ?? null,
    from_lat: input.from.lat,
    from_lng: input.from.lng,
    to_lat: input.to.lat,
    to_lng: input.to.lng,
    from_label: input.fromLabel ?? null,
    to_label: input.toLabel ?? null,
    distance_km: distance.distanceKm,
    planned_tons: input.plannedTons,
    actual_tons: 0,
    planned_cost: Math.round(input.plannedTons * distance.distanceKm * rate),
    actual_cost: 0,
    co2_kg: Math.round(input.plannedTons * distance.distanceKm * EMISSION_FACTOR[input.mode]),
    departed_at: null,
    arrived_at: null,
    status: 'ke_hoach',
    ref_type: input.refType ?? null,
    ref_id: input.refId ?? null,
    created_at: nowIso(),
  };
  insert('trips', record);
  logEvent({ module: 'tms', entityType: 'trips', entityId: record.id, action: 'create', after: record }, actor);
  return { ...record, distanceSourceLabel: distance.sourceLabel };
}

export function departTrip(id: string, actor: AuditActor = {}): Record<string, unknown> {
  update('trips', id, { status: 'dang_chay', departed_at: nowIso() });
  logEvent({ module: 'tms', entityType: 'trips', entityId: id, action: 'update', after: { status: 'dang_chay' } }, actor);
  return one('SELECT * FROM trips WHERE id = ?', [id])!;
}

export function completeTrip(
  id: string,
  input: { actualTons: number; actualCost?: number },
  actor: AuditActor = {},
): Record<string, unknown> {
  const trip = one<{ id: string; mode: TransportMode; distance_km: number; planned_cost: number; planned_tons: number }>(
    'SELECT * FROM trips WHERE id = ?',
    [id],
  );
  if (!trip) throw new Error('Không tìm thấy chuyến');
  const { params } = distanceService();
  const rate = trip.mode === 'road' ? params.roadFreightRatePerTonKm : params.waterwayFreightRatePerTonKm;
  const actualCost = input.actualCost ?? Math.round(input.actualTons * trip.distance_km * rate);

  update('trips', id, {
    status: 'hoan_thanh',
    arrived_at: nowIso(),
    actual_tons: input.actualTons,
    actual_cost: actualCost,
    actual_cost_source: input.actualCost === undefined || input.actualCost === null ? 'theo_don_gia' : 'nhap_tay',
    co2_kg: Math.round(input.actualTons * trip.distance_km * EMISSION_FACTOR[trip.mode]),
  });
  emitMrvRecord('tms', 'trip', id, actor);
  logEvent({ module: 'tms', entityType: 'trips', entityId: id, action: 'update', after: { status: 'hoan_thanh', actualCost } }, actor);
  return one('SELECT * FROM trips WHERE id = ?', [id])!;
}

export function listTrips(filter: { status?: string; limit?: number } = {}): Record<string, unknown>[] {
  return filter.status
    ? all('SELECT * FROM trips WHERE status = ? ORDER BY created_at DESC LIMIT ?', [filter.status, filter.limit ?? 100])
    : all('SELECT * FROM trips ORDER BY created_at DESC LIMIT ?', [filter.limit ?? 100]);
}

/** Đối chiếu chi phí vận tải THỰC TẾ so với KẾ HOẠCH (tham chiếu FN-08 Simulation). */
export function costVariance(from?: string, to?: string): Record<string, unknown> {
  const range = from && to ? 'WHERE substr(created_at,1,10) BETWEEN ? AND ?' : '';
  const params = from && to ? [from, to] : [];
  const totals = one<{ planned: number; actual: number; planned_tons: number; actual_tons: number; trips: number; co2: number }>(
    `SELECT COALESCE(SUM(planned_cost),0) AS planned, COALESCE(SUM(actual_cost),0) AS actual,
            COALESCE(SUM(planned_tons),0) AS planned_tons, COALESCE(SUM(actual_tons),0) AS actual_tons,
            COUNT(*) AS trips, COALESCE(SUM(co2_kg),0) AS co2
     FROM trips ${range}`,
    params,
  );
  const planned = totals?.planned ?? 0;
  const actual = totals?.actual ?? 0;
  return {
    totals,
    variance: actual - planned,
    variancePct: planned > 0 ? Math.round(((actual - planned) / planned) * 1000) / 10 : null,
    byMode: all(
      `SELECT mode, COUNT(*) AS trips, COALESCE(SUM(planned_cost),0) AS planned, COALESCE(SUM(actual_cost),0) AS actual,
              COALESCE(SUM(actual_tons),0) AS tons, COALESCE(SUM(co2_kg),0) AS co2_kg
       FROM trips ${range} GROUP BY mode`,
      params,
    ),
    costPerTonKm: all(
      `SELECT mode, ROUND(COALESCE(SUM(actual_cost),0) / NULLIF(SUM(actual_tons * distance_km), 0), 2) AS cost_per_ton_km
       FROM trips ${range} ${range ? 'AND' : 'WHERE'} status = 'hoan_thanh' GROUP BY mode`,
      params,
    ),
  };
}
